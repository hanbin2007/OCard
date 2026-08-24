import { Sidebar } from "./components/Sidebar";
import { CopyTaskScreen } from "./screens/CopyTaskScreen";
import { DevicesScreen } from "./screens/DevicesScreen";
import { NewProjectScreen } from "./screens/NewProjectScreen";
import { ProjectsScreen } from "./screens/ProjectsScreen";
import { StoreProvider, useAppState, type AppState } from "./state/store";
import { ThemeProvider } from "./state/theme";

function Routes() {
  const { route, loading } = useAppState();

  if (loading) {
    return (
      <div className="content">
        <div className="content__inner">
          <p className="text-sm dim">正在读取 NAS 项目状态…</p>
        </div>
      </div>
    );
  }

  switch (route) {
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
      <div className="main">
        <Routes />
      </div>
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
