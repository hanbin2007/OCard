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
import { NewProjectScreen } from "./screens/NewProjectScreen";
import { ProjectsScreen } from "./screens/ProjectsScreen";
import { SortingScreen } from "./screens/SortingScreen";
import { TranscodeScreen } from "./screens/TranscodeScreen";
import { TrashScreen } from "./screens/TrashScreen";
import { useRef } from "react";
import { ROUTE_ORDER, StoreProvider, useStore, type AppState } from "./state/store";
import type { RouteName } from "./state/store";
import { ThemeProvider } from "./state/theme";

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
            <p className="text-sm dim" role="status">
              正在读取 NAS 项目状态…
            </p>
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
    case "new-project":
      return <NewProjectScreen />;
    case "devices":
      return <DevicesScreen />;
    case "copy":
      return <CopyTaskScreen />;
    case "sorting":
      return <SortingScreen />;
    case "trash":
      return <TrashScreen />;
    case "transcode":
      return <TranscodeScreen />;
    case "projects":
    default:
      return <ProjectsScreen />;
  }
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

export default function App({ preloaded }: { preloaded?: Partial<AppState> }) {
  return (
    <ThemeProvider>
      <StoreProvider preloaded={preloaded}>
        <Shell />
      </StoreProvider>
    </ThemeProvider>
  );
}
