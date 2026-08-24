/** 左侧窄边栏：导航 + 最近项目 + 操作人/主题。 */

import { selectDeliveryWorking, useStore } from "../state/store";
import type { RouteName } from "../state/store";
import { THEME_LABELS, useTheme } from "../state/theme";
import { formatCompactDate } from "../lib/format";
import {
  IconCamera,
  IconCard,
  IconFilm,
  IconGrid,
  IconTrash,
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
  { route: "sorting", label: "分类工作台", icon: IconGrid },
  { route: "transcode", label: "代理转码", icon: IconFilm },
  { route: "trash", label: "回收站", icon: IconTrash },
];

const THEME_ICONS = {
  system: IconMonitor,
  light: IconSun,
  dark: IconMoon,
} as const;

/** 三态一眼可见，不用点一下才知道会变成什么 */
function ThemeSwitch() {
  const { mode, setMode } = useTheme();
  return (
    <div className="segmented" role="radiogroup" aria-label="主题">
      {(Object.keys(THEME_ICONS) as Array<keyof typeof THEME_ICONS>).map((value) => {
        const Icon = THEME_ICONS[value];
        return (
          <button
            key={value}
            type="button"
            className="segmented__item"
            role="radio"
            aria-checked={mode === value}
            title={THEME_LABELS[value]}
            aria-label={THEME_LABELS[value]}
            onClick={() => setMode(value)}
          >
            <Icon size={14} />
          </button>
        );
      })}
    </div>
  );
}

export function Sidebar() {
  const { state, dispatch } = useStore();
  const deliveryWorking = selectDeliveryWorking(state);
  const selectedProject = state.projects.find(
    (p) => p.id === state.selectedProjectId,
  );
  // 代理转码是工况 A 概念，工况 B 项目下不给入口
  const transcodeAvailable = selectedProject?.scenario === "A";
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
                  data-testid={`nav-${route}`}
                  className="nav-item"
                  aria-current={state.route === route ? "page" : undefined}
                  /* 打包期间锁住导航：离开会让结果面板（含未交付明细）静默蒸发 */
                  disabled={
                    deliveryWorking ||
                    (route === "transcode" && !transcodeAvailable)
                  }
                  title={
                    deliveryWorking
                      ? "交付打包进行中，完成后才能切换页面"
                      : route === "transcode" && !transcodeAvailable
                        ? "代理转码只适用于工况 A 项目"
                        : undefined
                  }
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
                disabled={deliveryWorking}
                title={
                  deliveryWorking
                    ? "交付打包进行中，完成后才能切换项目"
                    : undefined
                }
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
        <ThemeSwitch />
      </div>
    </aside>
  );
}
