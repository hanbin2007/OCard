/** 左侧窄边栏：导航 + 最近项目 + 操作人/主题；可收成一条图标轨。 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ROUTE_ORDER, useStore } from "../state/store";
import type { RouteName } from "../state/store";
import { useWindowBridge } from "../state/windowBridge";
import { THEME_LABELS, useTheme } from "../state/theme";
import { formatCompactDate } from "../lib/format";
import { withViewTransition } from "../lib/motion";
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
  IconSidebar,
  IconSun,
} from "./Icon";

/** 只描述"长什么样"；顺序由 ROUTE_ORDER 单点决定，与屏间过渡方向永远一致 */
const NAV_ITEMS: Record<RouteName, { label: string; icon: typeof IconProjects }> = {
  copy: { label: "拷卡任务", icon: IconCard },
  devices: { label: "设备登记", icon: IconCamera },
  // 交付打包住在这一屏里,名字必须盖得住它(评审 5.1):
  // 核心流程「…→选片→交付」的最后一环不能在导航上失踪
  sorting: { label: "选片与交付", icon: IconGrid },
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

/**
 * 折叠开关的快捷键:⌘\ / Ctrl+\。
 *
 * 为什么是它,而不是别的:
 * - 选片屏的键位表(lib/sorting.ts 的 resolveShortcut)对**一切**带 ⌘/Ctrl 的
 *   组合直接放行(只截 ⌘A),所以任何带修饰键的组合天然不与选片流冲突;
 * - 全应用的裸键位(空格/X/P/O/D/U/1-9/? …)一个都没占用 `\`;
 * - macOS 与 Chrome/WebView 都没有把 ⌘\ 绑给系统或浏览器动作
 *   (⌘B 会在富文本里被当成「加粗」,不如 `\` 干净);
 * - 与 VS Code/Xcode 一类的「开合侧栏」肌肉记忆在同一个手位。
 *
 * 键名判定同时看 `key` 与 `code`:非 US 布局下 `\` 键产出的字符会变,
 * `code === "Backslash"` 认的是物理键位。
 */
const TOGGLE_HINT = "⌘\\ / Ctrl+\\";

function isToggleChord(e: KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false;
  // 只认干净的 ⌘\ / Ctrl+\:带 Shift/Alt 的是别人的组合，不抢
  if (e.altKey || e.shiftKey) return false;
  return e.key === "\\" || e.code === "Backslash";
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

/**
 * 折叠/展开开关。
 *
 * 位置定在**侧栏底部**而不是品牌区右侧,理由是 macOS:无边框窗口下红绿灯
 * 悬浮在窗口左上角、不随布局走(`.shell[data-platform="mac"] .sidebar__brand`
 * 的 76px 让位就是为它留的)。折叠后整条轨也就 78px 宽,品牌区被红绿灯占满,
 * 再塞一个按钮进去必然打架。底部两态同位置,连按两下不用重新找。
 */
function CollapseToggle({
  collapsed,
  onToggle,
  buttonRef,
}: {
  collapsed: boolean;
  onToggle: () => void;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const label = collapsed ? "展开侧栏" : "收起侧栏";
  return (
    <button
      type="button"
      ref={buttonRef}
      className="sidebar__toggle"
      data-testid="sidebar-toggle"
      aria-expanded={!collapsed}
      aria-controls="app-sidebar"
      // 折叠态下按钮只剩一个图标,名字全靠这两条:读屏与 tooltip 都得说得出
      aria-label={`${label}（${TOGGLE_HINT}）`}
      title={`${label}（${TOGGLE_HINT}）`}
      onClick={onToggle}
    >
      <IconSidebar />
    </button>
  );
}

export function Sidebar() {
  const { state, dispatch } = useStore();
  const bridge = useWindowBridge();
  const collapsed = state.sidebarCollapsed;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const selectedProject = state.projects.find(
    (p) => p.id === state.selectedProjectId,
  );
  // 代理转码是工况 A 概念，工况 B 项目下不给入口
  const transcodeAvailable = selectedProject?.scenario === "A";
  // 角标只保留有行动意义的量(评审 5.6):「拷卡 2」=有 2 个在跑,
  // 值得一瞥;「项目 12」只是总数,徒增噪音
  const counts: Partial<Record<RouteName, number>> = {
    copy: state.tasks.filter((t) => t.state === "running").length,
  };
  const { listRef, rail, ready } = useNavRail(state.route, NAV.length);

  /*
   * 宽度变化本身不做过渡:tokens.test 的动效守卫明令禁止过渡 width 这类
   * 会引发重排的属性(选片屏的网格能有上千张缩略图)。用项目既有的视图过渡
   * 封装把这一帧接上——它内部已经处理了「内核不支持」与
   * 「用户要求减少动效」两种情况,两种情况下都是直接落地,行为一模一样。
   */
  const toggle = useCallback(() => {
    withViewTransition(() => dispatch({ type: "sidebarToggled" }));
  }, [dispatch]);

  /*
   * 全局快捷键。挂在 window 的**冒泡**阶段,这一点是刻意的:
   * - 速查表(KeyboardHelp)在 window 捕获阶段接管全部按键,它开着时本键
   *   到不了这里 —— 与「最上面那一层吃掉所有键」的既有口径一致;
   * - 大图(AssetLightbox)在 document 捕获阶段拦键,但 resolveShortcut 对带
   *   ⌘/Ctrl 的组合返回 null 后**直接 return、不 stopPropagation**,所以
   *   ⌘\ 能穿过去 —— 在大图里也能收侧栏。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isToggleChord(e)) return;
      // 会话门落下时侧栏整棵被设成 inert(SessionGuard):按钮此刻点不了,
      // 快捷键也不该成为绕过它的旁路
      if (toggleRef.current?.closest("[inert]")) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return (
    <aside
      id="app-sidebar"
      className={`sidebar${collapsed ? " sidebar--collapsed" : ""}`}
    >
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
        {/* 项目管理/新建项目整体搬进了独立窗口:这里保留原「新建项目」的
            位置作为它的入口(启动重构) */}
        <div className="sidebar__section">
          <button
            type="button"
            data-testid="nav-manager"
            className="nav-item"
            title="打开项目管理窗口(新建/切换项目)"
            /* 折叠态下标签被 CSS 收起(display:none 会连同可访问名一起没掉),
               名字必须由 aria-label 顶上,否则读屏只念得出「按钮」 */
            aria-label={collapsed ? "项目管理" : undefined}
            onClick={() => void bridge.openManager()}
          >
            <IconProjects className="nav-item__icon" />
            <span className="nav-item__label">项目管理</span>
            <IconPlus className="nav-item__add" size={13} />
          </button>
        </div>

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
            {NAV.map(({ route, label, icon: Icon }) => {
              /* 打包期间不再锁死导航(评审 4.3):进度/结果由 store 里的
                 job 状态承载,离屏回来面板自动恢复,不存在「静默蒸发」。
                 「代理转码」不禁用(macOS 禁用按钮连 tooltip 都不出,
                 等于无提示的死门)：不适用时进屏由屏内空态解释并给出去路 */
              const inapplicable = route === "transcode" && !transcodeAvailable;
              const hint = inapplicable
                ? "代理转码只适用于工况 A 项目，点击查看说明"
                : null;
              return (
                <li key={route}>
                  <button
                    type="button"
                    data-testid={`nav-${route}`}
                    className="nav-item"
                    aria-current={state.route === route ? "page" : undefined}
                    data-inapplicable={inapplicable ? true : undefined}
                    /* 折叠态只剩图标:屏名必须进 title(悬停认得出)与
                       aria-label(读屏念得出)。「当前不适用」的说明不能
                       因为折叠就丢掉,拼在同一句里 */
                    title={
                      collapsed
                        ? hint
                          ? `${label} — ${hint}`
                          : label
                        : (hint ?? undefined)
                    }
                    aria-label={
                      collapsed
                        ? hint
                          ? `${label}（${hint}）`
                          : label
                        : undefined
                    }
                    onClick={() => dispatch({ type: "navigate", route })}
                  >
                    <Icon className="nav-item__icon" />
                    <span className="nav-item__label">{label}</span>
                    {counts[route] ? (
                      <PulseValue
                        className="nav-item__count"
                        value={counts[route] as number}
                      />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* 折叠态整段收起(CSS):项目名是一串文字,压不进一条 78px 的图标轨。
            这不是「静默丢功能」——顶栏正中的「当前项目」胶囊就是同一件事的
            另一个入口(原地切项目下拉,评审 5.2),折叠期间它一直在。 */}
        <div className="sidebar__section sidebar__section--projects">
          {/* 「最近项目」语义已归欢迎窗口(本机最近打开);这里是当前 NAS
              项目间的快速切换,不换窗口不换页面 */}
          <div className="sidebar__label">快速切换</div>
          <div className="sidebar__projects">
            {state.projects.slice(0, 5).map((project) => (
              <button
                key={project.id}
                type="button"
                className="sidebar__project"
                aria-current={project.id === state.selectedProjectId}
                /* 只换当前项目,不换页面:在拷卡/分类屏切项目就是想
                   在当前屏操作另一个项目,跳回项目列表是打断(用户反馈)。
                   打包期间也放行(评审 4.3):作业挂在项目上,切走不打断 */
                onClick={() =>
                  dispatch({ type: "selectProject", projectId: project.id })
                }
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
        {/* 换班是每日事件(评审 6.4):操作人可点,直达设置(操作人字段自动聚焦)。
            折叠态收起:这一行是「张三 · MBP-01」这样的长文本,轨里放不下;
            设置本身在顶栏另有常驻入口(settings-open),不会因此够不着 */}
        <button
          type="button"
          className="sidebar__operator sidebar__operator--btn"
          data-testid="sidebar-operator"
          title={
            state.workstation
              ? `点击换操作人(当前:${state.workstation.operator})`
              : undefined
          }
          onClick={() => dispatch({ type: "settingsOpened" })}
        >
          {state.workstation
            ? `${state.workstation.operator} · ${state.workstation.machineId}`
            : "未连接工作站"}
        </button>
        <div className="sidebar__foot-actions">
          <ThemeSwitch />
          <CollapseToggle
            collapsed={collapsed}
            onToggle={toggle}
            buttonRef={toggleRef}
          />
        </div>
      </div>
    </aside>
  );
}
