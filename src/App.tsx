import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { CopyTaskScreen } from "./screens/CopyTaskScreen";
import { DevicesScreen } from "./screens/DevicesScreen";
import { NewProjectScreen } from "./screens/NewProjectScreen";
import { ProjectsScreen } from "./screens/ProjectsScreen";
import { StoreProvider, useStore, type AppState } from "./state/store";
import { ThemeProvider } from "./state/theme";

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
        <Routes />
      </main>
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
