import * as api from "./api";
import { KeyboardHelp } from "./components/KeyboardHelp";
import { NoticeToasts } from "./components/NotificationCenter";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { QuickCopyPrompt } from "./components/QuickCopyPrompt";
import { SessionGuard } from "./components/SessionGuard";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { CopyTaskScreen } from "./screens/CopyTaskScreen";
import { DevicesScreen } from "./screens/DevicesScreen";
import { SortingScreen } from "./screens/SortingScreen";
import { TranscodeScreen } from "./screens/TranscodeScreen";
import { TrashScreen } from "./screens/TrashScreen";
import { useEffect, useRef, useState } from "react";
import { ROUTE_ORDER, StoreProvider, useStore, type AppState } from "./state/store";
import type { RouteName } from "./state/store";
import { ThemeProvider } from "./state/theme";
import { WindowBridgeProvider } from "./state/windowBridge";
import { WelcomeRoot } from "./welcome/WelcomeRoot";

/**
 * 屏间过渡的方向。
 *
 * 侧栏是一列纵向导航，所以"往下走"就该看见新屏从下方进来、"往回走"从上方进来
 * ——中间帧要指向结果，而不是每次都用同一个方向糊弄过去。
 * 顺序取自 ROUTE_ORDER，与侧栏排布同源，不会出现"侧栏在下、动画说在上"。
 *
 * 用 ref 在渲染期比对上一条路由，是因为 `.content` 与路由是**同一次提交**里
 * 挂载的：放到 effect 里算方向，属性会晚一帧，动画就用不上了。
 * 判据是幂等的（相等即不动），StrictMode 双渲染下结果一致。
 */
function useNavDirection(route: RouteName): "forward" | "back" | "none" {
  const previous = useRef(route);
  const direction = useRef<"forward" | "back" | "none">("none");
  if (previous.current !== route) {
    const from = ROUTE_ORDER.indexOf(previous.current);
    const to = ROUTE_ORDER.indexOf(route);
    direction.current = to > from ? "forward" : "back";
    previous.current = route;
  }
  return direction.current;
}

/**
 * macOS 桌面端（Tauri）标题栏走 Overlay：红绿灯悬浮在侧栏品牌区上，
 * 窗口 chrome 与应用 chrome 融为一体，而不是"网页装在系统窗框里"。
 * 仅在 macOS + Tauri 下打标记；浏览器/其他平台不受影响。
 */
const IS_MAC_DESKTOP =
  typeof navigator !== "undefined" &&
  navigator.userAgent.includes("Mac") &&
  typeof window !== "undefined" &&
  "__TAURI_INTERNALS__" in window;

function Routes() {
  const { state, reload } = useStore();

  if (state.error) {
    return (
      <>
        <TopBar title="无法读取项目" />
        <div className="content">
          <div className="content__inner">
            <div className="card">
              <div className="card__body">
                <div className="stack">
                  <p className="text-sm" role="alert">
                    {state.error}
                  </p>
                  <p className="text-sm muted">
                    检查 NAS 是否已挂载、路径是否可达，然后重试。已开始的拷卡任务会挂起，
                    恢复后可按 manifest 续传。
                  </p>
                  <div>
                    <button type="button" className="btn btn--primary" onClick={reload}>
                      重试
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }

  if (state.loading) {
    return (
      <>
        <TopBar title="OCard" />
        <div className="content">
          <div className="content__inner">
            <LoadingWithWatchdog />
          </div>
        </div>
      </>
    );
  }

  // 首跑：操作人或 NAS 根任一没配就先走引导——操作人漏配不能静默记成
  // 「未登记DIT」，那是审计污点，不是可跳过的小事
  if (!state.workstation?.nasRoot?.trim() || !state.workstation?.operator?.trim()) {
    return (
      <>
        <TopBar title="欢迎使用 OCard" />
        <div className="content">
          <div className="content__inner">
            <OnboardingWizard />
          </div>
        </div>
      </>
    );
  }

  switch (state.route) {
    case "devices":
      return <DevicesScreen />;
    case "sorting":
      return <SortingScreen />;
    case "trash":
      return <TrashScreen />;
    case "transcode":
      return <TranscodeScreen />;
    case "copy":
    default:
      // 主窗口默认落在拷卡界面(启动重构):项目已在欢迎窗口选定
      return <CopyTaskScreen />;
  }
}

/**
 * 主窗口的「打开项目」接收端(仅 Tauri):
 * 欢迎窗口经 Rust 投递 projectId——事件通道接「已在跑」的主窗口,
 * 暂存通道接「被现场重建、事件早于监听注册」的主窗口(启动先消费一次)。
 * 收到后选中项目、切到拷卡屏,并整站 reload:项目/相机/卡可能刚在
 * 欢迎窗口里创建,本窗口的快照还不知道它们。
 */
function OpenProjectListener() {
  const { dispatch, reload } = useStore();
  useEffect(() => {
    let disposed = false;
    const handle = (projectId: string) => {
      if (disposed) return;
      dispatch({ type: "selectProject", projectId });
      dispatch({ type: "navigate", route: "copy" });
      reload();
    };
    void api
      .takePendingOpenProject()
      .then((projectId) => {
        if (projectId) handle(projectId);
      })
      .catch(() => {
        // 暂存拿不到还有事件通道;事件也丢时用户会再点一次,不弹错
      });
    const unsubscribe = api.subscribeOpenProject(handle);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [dispatch, reload]);
  return null;
}

/**
 * 启动加载态 + 看门狗:NAS 半死(挂载点在、IO 挂起)时 statfs 可以卡上
 * 几分钟,不能让人对着一行灰字干等(Arch 实机:同事以为软件死了)。
 * 超过 10s 就把可能的原因和自救路径说出来。命令已全部移出主线程执行,
 * UI 本身保持响应。
 */
function LoadingWithWatchdog() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), 10_000);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div className="stack" role="status">
      <p className="text-sm dim">正在读取 NAS 项目状态…</p>
      {slow ? (
        <p className="text-xs text-warn" data-testid="loading-slow-hint">
          NAS 响应很慢或没有响应。常见原因:网络断开但挂载点还在
          (系统级 IO 挂起,可能要等数分钟才超时)。可检查 NAS
          连接与挂载状态;恢复后本页会自动继续。
        </p>
      ) : null}
    </div>
  );
}

export function Shell() {
  const { state } = useStore();
  const navDirection = useNavDirection(state.route);

  return (
    <div
      className="shell"
      data-nav={navDirection}
      data-platform={IS_MAC_DESKTOP ? "mac" : undefined}
    >
      <Sidebar />
      <main className="main">
        <Routes />
      </main>
      <SettingsDialog />
      <SessionGuard />
      {/* toast 必须在 .main 之外:会话门会把 .main 整体 inert,
          挂在里面的 error toast 视觉在最上层却点不了、读屏也不播报(评审 P1) */}
      <NoticeToasts />
      {/* 快捷拷卡引导:同在 .main 之外(路由切换不打断引导);
          z-index 低于会话门,门开时被压住,不构成绕门旁路 */}
      <QuickCopyPrompt />
      {/* 任意屏按 ? 呼出快捷键速查(评审 #26):键盘流的可发现性 */}
      <KeyboardHelp />
    </div>
  );
}

/**
 * 浏览器/测试环境的单窗口形态:没有 Tauri 多窗口,欢迎页与主界面
 * 在同一窗口内切换。传了 preloaded(测试注入)直接进主界面。
 */
function BrowserApp({ preloaded }: { preloaded?: Partial<AppState> }) {
  const { dispatch } = useStore();
  const [view, setView] = useState<"welcome" | "shell">(
    preloaded ? "shell" : "welcome",
  );
  return (
    <WindowBridgeProvider
      role={view === "welcome" ? "welcome" : "main"}
      onBrowserOpenProject={(projectId) => {
        dispatch({ type: "selectProject", projectId });
        dispatch({ type: "navigate", route: "copy" });
        setView("shell");
      }}
      onBrowserOpenManager={() => setView("welcome")}
    >
      {view === "welcome" ? <WelcomeRoot /> : <Shell />}
    </WindowBridgeProvider>
  );
}

export default function App({ preloaded }: { preloaded?: Partial<AppState> }) {
  // 每个窗口一个 React 实例,角色终生不变:按角色分叉不违反 hooks 规则
  if (api.isTauri()) {
    const role = api.windowRole();
    return (
      <ThemeProvider>
        <StoreProvider preloaded={preloaded}>
          <WindowBridgeProvider role={role}>
            {role === "welcome" ? (
              <WelcomeRoot />
            ) : (
              <>
                <OpenProjectListener />
                <Shell />
              </>
            )}
          </WindowBridgeProvider>
        </StoreProvider>
      </ThemeProvider>
    );
  }
  return (
    <ThemeProvider>
      <StoreProvider preloaded={preloaded}>
        <BrowserApp preloaded={preloaded} />
      </StoreProvider>
    </ThemeProvider>
  );
}
