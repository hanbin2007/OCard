import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { CopyTaskScreen } from "./screens/CopyTaskScreen";
import { DevicesScreen } from "./screens/DevicesScreen";
import { NewProjectScreen } from "./screens/NewProjectScreen";
import { ProjectsScreen } from "./screens/ProjectsScreen";
import { StoreProvider, useStore, type AppState } from "./state/store";
import { ThemeProvider } from "./state/theme";

/** 进度监听没建立起来时必须说出来：否则界面看起来只是「没动静」 */
function ProgressListenBanner() {
  const { state } = useStore();
  if (!state.progressError) return null;
  return (
    <div className="notice notice--warn notice--banner" role="alert">
      <strong>{state.progressError}</strong>
      <span>拷卡任务的进度可能不会自动刷新，请重启应用；已在进行的拷贝不受影响。</span>
    </div>
  );
}

function Routes() {
  const { state, reload, dispatch } = useStore();

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

  // 首跑没配 NAS 根路径时，先温和引导，别让用户撞上「路径为空」的死胡同
  if (!state.workstation?.nasRoot?.trim()) {
    return (
      <>
        <TopBar title="欢迎使用 OCard" />
        <div className="content">
          <div className="content__inner">
            <div className="card" data-testid="first-run-guide">
              <div className="card__head">
                <span className="card__title">先完成本机设置</span>
              </div>
              <div className="card__body">
                <div className="stack">
                  <p className="text-sm muted">
                    OCard 需要知道两件事才能开工：谁在操作（审计日志按操作人留痕），
                    以及本机的 NAS 根路径（项目文件夹建在哪里）。
                  </p>
                  <p className="text-sm muted">
                    这两项只影响本机。项目状态内只存相对路径，因此各工作站的路径形式
                    不同也能打开同一个项目。
                  </p>
                  <div>
                    <button
                      type="button"
                      data-testid="first-run-open-settings"
                      className="btn btn--primary"
                      onClick={() => dispatch({ type: "settingsOpened" })}
                    >
                      打开设置
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

  switch (state.route) {
    case "new-project":
      return <NewProjectScreen />;
    case "devices":
      return <DevicesScreen />;
    case "copy":
      return <CopyTaskScreen />;
    case "projects":
    default:
      return <ProjectsScreen />;
  }
}

export function Shell() {
  return (
    <div className="shell">
      <Sidebar />
      <main className="main">
        <ProgressListenBanner />
        <Routes />
      </main>
      <SettingsDialog />
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
