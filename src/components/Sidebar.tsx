/** 左侧窄边栏：导航 + 最近项目 + 操作人/主题。 */

import { useStore } from "../state/store";
import type { RouteName } from "../state/store";
import { THEME_LABELS, useTheme } from "../state/theme";
import { formatCompactDate } from "../lib/format";
import {
  IconCamera,
  IconCard,
  IconMonitor,
  IconMoon,
  IconPlus,
  IconProjects,
  IconSun,
} from "./Icon";

const NAV: Array<{
  route: RouteName;
  label: string;
  icon: typeof IconProjects;
}> = [
  { route: "projects", label: "项目", icon: IconProjects },
  { route: "new-project", label: "新建项目", icon: IconPlus },
  { route: "devices", label: "设备登记", icon: IconCamera },
  { route: "copy", label: "拷卡任务", icon: IconCard },
];

function ThemeButton() {
  const { mode, cycleMode } = useTheme();
  const Icon = mode === "light" ? IconSun : mode === "dark" ? IconMoon : IconMonitor;
  return (
    <button
      type="button"
      className="btn btn--ghost btn--icon btn--sm"
      onClick={cycleMode}
      title={`主题：${THEME_LABELS[mode]}（点击切换）`}
      aria-label={`主题：${THEME_LABELS[mode]}，点击切换`}
    >
      <Icon />
    </button>
  );
}

export function Sidebar() {
  const { state, dispatch } = useStore();
  const counts: Partial<Record<RouteName, number>> = {
    projects: state.projects.length,
    devices: state.cameras.length,
    copy: state.tasks.filter((t) => t.state === "running").length,
  };

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__mark">OC</span>
        <span className="sidebar__name">OCard</span>
      </div>

      <div className="sidebar__scroll">
        <nav className="sidebar__section" aria-label="主导航">
          <ul>
            {NAV.map(({ route, label, icon: Icon }) => (
              <li key={route}>
                <button
                  type="button"
                  className="nav-item"
                  aria-current={state.route === route ? "page" : undefined}
                  onClick={() => dispatch({ type: "navigate", route })}
                >
                  <Icon className="nav-item__icon" />
                  <span>{label}</span>
                  {counts[route] ? (
                    <span className="nav-item__count">{counts[route]}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="sidebar__section">
          <div className="sidebar__label">最近项目</div>
          <div className="sidebar__projects">
            {state.projects.slice(0, 5).map((project) => (
              <button
                key={project.id}
                type="button"
                className="sidebar__project"
                aria-current={project.id === state.selectedProjectId}
                onClick={() => {
                  dispatch({ type: "selectProject", projectId: project.id });
                  dispatch({ type: "navigate", route: "projects" });
                }}
              >
                <span className="sidebar__project-name">{project.name}</span>
                <span className="sidebar__project-meta">
                  {formatCompactDate(project.date)} · 工况 {project.scenario}
                </span>
              </button>
            ))}
            {state.projects.length === 0 ? (
              <span className="sidebar__project-meta sidebar__empty">暂无项目</span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="sidebar__foot">
        <span className="sidebar__operator" title={state.workstation?.nasRoot}>
          {state.workstation
            ? `${state.workstation.operator} · ${state.workstation.machineId}`
            : "未连接工作站"}
        </span>
        <ThemeButton />
      </div>
    </aside>
  );
}
