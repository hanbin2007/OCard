/**
 * 测试工具:启动重构后「项目管理」不再是主窗口路由,而是欢迎/项目管理
 * 窗口里的视图——测它得单独把 ProjectsScreen 包上全套 Provider 渲染,
 * 不能再借道 <App preloaded>。
 */

import { render } from "@testing-library/react";
import { useEffect } from "react";
import { NoticeToasts } from "./components/NotificationCenter";
import { ProjectsScreen } from "./screens/ProjectsScreen";
import { StoreProvider, useStore, type AppState } from "./state/store";
import { ThemeProvider } from "./state/theme";
import { WindowBridgeProvider } from "./state/windowBridge";

import { WelcomeRoot } from "./welcome/WelcomeRoot";

type StoreHandle = ReturnType<typeof useStore>;

/** 把 store 句柄交给测试:preloaded 会把 loading 钉成 false,要考「加载中 / 出错」
 *  这类状态只能在挂载后 dispatch。 */
function StoreProbe({ onStore }: { onStore: (s: StoreHandle) => void }) {
  const store = useStore();
  useEffect(() => {
    onStore(store);
  }, [store, onStore]);
  return null;
}

/** 渲染欢迎/项目管理窗口根视图(含首跑/欢迎页/向导/所有项目) */
export function renderWelcome(
  preloaded?: Partial<AppState>,
  onStore?: (s: StoreHandle) => void,
) {
  return render(
    <ThemeProvider>
      <StoreProvider preloaded={preloaded}>
        {onStore ? <StoreProbe onStore={onStore} /> : null}
        <WindowBridgeProvider role="welcome">
          <WelcomeRoot />
        </WindowBridgeProvider>
      </StoreProvider>
    </ThemeProvider>,
  );
}

export function renderProjectsManager(
  preloaded?: Partial<AppState>,
  options?: { onNewProject?: () => void },
) {
  return render(
    <ThemeProvider>
      <StoreProvider preloaded={preloaded}>
        <WindowBridgeProvider role="welcome">
          <ProjectsScreen onNewProject={options?.onNewProject ?? (() => {})} />
          {/* 欢迎窗口(WelcomeRoot)同样挂着 toast:失败提示在管理窗口可见 */}
          <NoticeToasts />
        </WindowBridgeProvider>
      </StoreProvider>
    </ThemeProvider>,
  );
}
