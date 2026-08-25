/** 左侧窄边栏：导航 + 最近项目 + 操作人/主题。 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ROUTE_ORDER, selectDeliveryWorking, useStore } from "../state/store";
import type { RouteName } from "../state/store";
import { THEME_LABELS, useTheme } from "../state/theme";
import { formatCompactDate } from "../lib/format";
import { PulseValue } from "./ui";
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

/** 只描述"长什么样"；顺序由 ROUTE_ORDER 单点决定，与屏间过渡方向永远一致 */
const NAV_ITEMS: Record<RouteName, { label: string; icon: typeof IconProjects }> = {
  projects: { label: "项目", icon: IconProjects },
  "new-project": { label: "新建项目", icon: IconPlus },
  devices: { label: "设备登记", icon: IconCamera },
  copy: { label: "拷卡任务", icon: IconCard },
  sorting: { label: "分类工作台", icon: IconGrid },
  transcode: { label: "代理转码", icon: IconFilm },
  trash: { label: "回收站", icon: IconTrash },
};

const NAV = ROUTE_ORDER.map((route) => ({ route, ...NAV_ITEMS[route] }));

/**
 * 量出当前项在列表里的位置，交给一块**会移动的**选中底。
 *
 * 切屏时它从上一项滑到下一项，导航的空间关系因此是连续可读的：
 * 你看得见"从哪来、到哪去"，而不是两次互不相干的闪烁。
 * 量不到布局信息（无 JS 布局的环境）时返回 null，CSS 会退回原来的逐项底色。
 */
function useNavRail(route: RouteName, itemCount: number) {
  const listRef = useRef<HTMLUListElement>(null);
  const [rail, setRail] = useState<{ top: number; height: number } | null>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const list = listRef.current;
    const measure = () => {
      const current = list?.querySelector<HTMLElement>('[aria-current="page"]');
      const row = current?.parentElement;
      // offsetHeight 为 0 说明拿不到真实布局，此时底块会变成一条看不见的线
      if (!row || row.offsetHeight <= 0) {
        setRail(null);
        return;
      }
      const next = { top: row.offsetTop, height: row.offsetHeight };
      setRail((prev) =>
        prev && prev.top === next.top && prev.height === next.height ? prev : next,
      );
    };

    measure();
    // 系统字号调大导致标签折行时，行高会变——不重新量，底块就会对不齐
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [route, itemCount]);

  // 首次落位必须无过渡，否则底块会从列表顶端"飞"到当前项：
  // 等第一帧画完（useEffect）再挂上过渡
  useEffect(() => {
    if (rail && !ready) setReady(true);
  }, [rail, ready]);

  return { listRef, rail, ready };
}

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
  const { listRef, rail, ready } = useNavRail(state.route, NAV.length);

  return (
    <aside className="sidebar">
      {/* data-tauri-drag-region：无边框窗口下品牌区空白处可拖动窗口（仅命中元素本身，不影响子元素点击） */}
      <div className="sidebar__brand" data-tauri-drag-region>
        <span className="sidebar__mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" role="img">
            {/* 品牌字标:存储卡剪影(右上斜切)+ O 环 + 强调蓝点,与应用图标同几何 */}
            <path
              fill="currentColor"
              fillRule="evenodd"
              d="M7.8 3h5.9l4.6 4.6v11.3a2.1 2.1 0 0 1-2.1 2.1H7.8a2.1 2.1 0 0 1-2.1-2.1V5.1A2.1 2.1 0 0 1 7.8 3Zm4.2 5.8a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z"
            />
            <circle cx="12" cy="12.4" r="1.55" fill="var(--accent)" />
          </svg>
        </span>
        <span className="sidebar__name">OCard</span>
      </div>

      <div className="sidebar__scroll">
        <nav className="sidebar__section sidebar__nav" aria-label="主导航">
          {rail ? (
            <span
              aria-hidden="true"
              data-testid="nav-rail"
              className={`nav-rail${ready ? " nav-rail--ready" : ""}`}
              style={{
                height: rail.height,
                transform: `translate3d(0, ${rail.top}px, 0)`,
              }}
            />
          ) : null}
          <ul
            className="sidebar__nav-list"
            ref={listRef}
            data-rail={rail ? "on" : undefined}
          >
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
                    <PulseValue
                      className="nav-item__count"
                      value={counts[route] as number}
                    />
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
