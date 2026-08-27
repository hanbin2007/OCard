/**
 * 测试工具:启动重构后「项目管理」不再是主窗口路由,而是欢迎/项目管理
 * 窗口里的视图——测它得单独把 ProjectsScreen 包上全套 Provider 渲染,
 * 不能再借道 <App preloaded>。
 */

import { render } from "@testing-library/react";
import { NoticeToasts } from "./components/NotificationCenter";
import { ProjectsScreen } from "./screens/ProjectsScreen";
import { StoreProvider, type AppState } from "./state/store";
import { ThemeProvider } from "./state/theme";
import { WindowBridgeProvider } from "./state/windowBridge";

import { WelcomeRoot } from "./welcome/WelcomeRoot";

/** 渲染欢迎/项目管理窗口根视图(含首跑/欢迎页/向导/所有项目) */
export function renderWelcome(preloaded?: Partial<AppState>) {
  return render(
    <ThemeProvider>
      <StoreProvider preloaded={preloaded}>
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
