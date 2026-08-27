/**
 * 欢迎/项目管理窗口的根视图(启动重构):
 *
 * - 首跑(操作人 / NAS 根任一未配)→ 首次设置向导占满窗口;
 * - 配置完成 → 欢迎页(仿 Xcode:新建项目 + 最近项目);
 * - 「所有项目」与「新项目引导」是同窗口内的全屏子视图。
 *
 * Tauri 下运行在独立的 `welcome` 窗口里;浏览器/测试环境由 App 根
 * 在同一窗口内挂载本组件(见 windowBridge)。
 */

import { useState } from "react";
import { NoticeToasts } from "../components/NotificationCenter";
import { OnboardingWizard } from "../components/OnboardingWizard";
import { SettingsDialog } from "../components/SettingsDialog";
import { IconArrowLeft } from "../components/Icon";
import { ProjectsScreen } from "../screens/ProjectsScreen";
import { useStore } from "../state/store";
import { NewProjectWizard } from "./NewProjectWizard";
import { WelcomeHome } from "./WelcomeHome";

type WelcomeView = "home" | "wizard" | "manager";

export function WelcomeRoot() {
  const { state, reload } = useStore();
  const [view, setView] = useState<WelcomeView>("home");

  const configured = Boolean(
    state.workstation?.nasRoot?.trim() && state.workstation?.operator?.trim(),
  );

  let body: React.ReactNode;
  if (state.error) {
    body = (
      <div className="welcome-onboarding">
        <div className="card">
          <div className="card__body">
            <div className="stack">
              <p className="text-sm" role="alert">
                {state.error}
              </p>
              <p className="text-sm muted">
                检查 NAS 是否已挂载、路径是否可达，然后重试。
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
    );
  } else if (state.loading) {
    body = (
      <div className="welcome-onboarding">
        <p className="text-sm dim" role="status">
          正在读取 NAS 项目状态…
        </p>
      </div>
    );
  } else if (!configured) {
    // 首跑:操作人或 NAS 根没配就先走首次设置(与旧流程同一套向导组件)
    body = (
      <div className="welcome-onboarding">
        <OnboardingWizard />
      </div>
    );
  } else if (view === "wizard") {
    body = (
      <div className="welcome-sub">
        <div className="welcome-sub__bar">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            data-testid="welcome-back"
            onClick={() => setView("home")}
          >
            <IconArrowLeft size={14} />
            返回
          </button>
          <span className="welcome-sub__title">新建项目</span>
        </div>
        <div className="welcome-sub__body">
          <NewProjectWizard onExit={() => setView("home")} />
        </div>
      </div>
    );
  } else if (view === "manager") {
    body = (
      <div className="welcome-sub">
        <div className="welcome-sub__bar">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            data-testid="welcome-back"
            onClick={() => setView("home")}
          >
            <IconArrowLeft size={14} />
            返回
          </button>
        </div>
        {/* 项目管理(原主窗口「项目」屏)整体搬进本窗口 */}
        <div className="welcome-sub__body" style={{ padding: 0 }}>
          <ProjectsScreen onNewProject={() => setView("wizard")} />
        </div>
      </div>
    );
  } else {
    body = (
      <WelcomeHome
        onNewProject={() => setView("wizard")}
        onBrowseAll={() => setView("manager")}
      />
    );
  }

  return (
    <div className="welcome-shell" data-testid="welcome-root">
      {/* 无边框窗口的拖动条;macOS 红绿灯悬浮其上 */}
      <div className="welcome-shell__drag" data-tauri-drag-region />
      {body}
      {/* 本窗口也要能看到失败提示与打开设置(项目管理视图的顶栏有设置入口) */}
      <SettingsDialog />
      <NoticeToasts />
    </div>
  );
}
