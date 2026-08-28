/**
 * 画廊模式（Loupe 视图）：左大图 + 右详情 + 底部胶片条。
 *
 * 为什么单独做一个视图而不是把网格放大：选片到收尾阶段，判断依据不再是
 * 「这一屏里哪几张好」，而是「这一张的细节撑不撑得住」——需要的是一张够大的图
 * 加上一份完整元信息，同时还要保留上下文（前后各是什么）。三块因此缺一不可。
 *
 * 键盘口径与 AssetLightbox 完全一致（评审 3.2）：**你操作的就是你看见的那张**。
 * 打标键作用于当前聚焦项，绝不落到别处。
 *
 * 与 Lightbox 的区别是这里**不是模态**：键盘监听挂在组件根节点上（与
 * SortingScreen 的 `.sorting__grid-wrap` 同一手法），只在焦点位于画廊内时生效，
 * 不去 document 上抢键；处理掉的按键才 stopPropagation，没处理的（如 Shift+D
 * 提交待删清单）原样交还给上层。
 *
 * 零静默在这个组件里有三条具体落点（评审 D1/D2）：
 * ① 网格提示条上写着的键（X / Esc）在画廊里没有语义 —— 那也要**说出来**，
 *    不能按下去 DOM 一动不动；
 * ② 素材是分页加载的，位置栏只敢说「已加载多少」，不许把它说成「共多少」；
 * ③ 翻到已加载的尾部不许静默停住，要么续拉、要么说清还差多少张。
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { SortingAsset, SortingCategory } from "../api/types";
import { formatBytes, formatTimestamp } from "../lib/format";
import { animateOnce } from "../lib/motion";
import { resolveShortcut } from "../lib/sorting";
import { JudgementBadges } from "./JudgementBadges";
import { Badge, EmptyState, Kbd } from "./ui";

/**
 * 与 SortingScreen 里的同名映射同文案。没有共享是因为那份没有导出，
 * 而本任务不允许改动 SortingScreen；四条中文常量的重复优于跨文件强耦合。
 */
const KIND_LABEL: Record<SortingAsset["kind"], string> = {
  photo: "照片",
  raw: "RAW",
  video: "视频",
  other: "其他类型",
};

/** 胶片条选项的 DOM id。素材 id 是相对路径（可能含空格），不能直接当 id 用 */
const shotDomId = (index: number) => `gallery-shot-${index}`;

/** 换图时的横向位移量：与 Lightbox 同一档，够读出方向又不甩出视野 */
const SWAP_SHIFT_PX = 18;
/** 与 CSS --dur-spring-fast 同一档（ζ=1，response 0.25s） */
const SWAP_DURATION_MS = 350;

/* ------------------------------------------------------------------ *
 * 胶片条窗口化（评审 D3）
 *
 * 上千格全量挂载时，`loading="lazy"` 只省下图片请求，DOM 节点、布局与
 * React 协调一样也没省；叠加索引进度约 5Hz 的重渲染就是肉眼可见的卡。
 *
 * 这里按「滚动位置 + 当前聚焦项」两段窗口取交集渲染，两端用占位块撑出
 * 与全量渲染**严格一致**的总宽度，滚动条长度因此不会跳。
 *
 * 为什么不用 `content-visibility: auto`（上一版评估过并放弃，结论仍然成立）：
 * 它会把跳过的子树从无障碍树里摘掉，`role="option"` 跟着一起消失，
 * 读屏用户的「共 N 项」当场变成谎话。
 * ------------------------------------------------------------------ */

/** 一格的宽度，必须与 gallery.css `.gallery__shot` 的 width 一致 */
const SHOT_WIDTH = 104;
/** 格与格的间距，= gallery.css `.gallery__strip` 的 gap（var(--space-2)） */
const SHOT_GAP = 8;
const SHOT_STRIDE = SHOT_WIDTH + SHOT_GAP;
/** 视口外多渲染几格，横向滚动时不至于露白 */
const STRIP_OVERSCAN = 4;
/** 量不到视口宽度时（jsdom / 首帧）按多少格估 */
const STRIP_FALLBACK_VISIBLE = 12;
/**
 * 无论滚到哪儿，聚焦项前后这些格必须留在 DOM 里。
 * `aria-activedescendant` 指向的元素一旦不存在，读屏读到的就是「空」——
 * 这正是窗口化最容易踩、又最难被肉眼发现的坑。
 */
const STRIP_ACTIVE_KEEP = 3;

export interface StripSegment {
  /** 含 */
  start: number;
  /** 不含 */
  end: number;
}

/**
 * 算出胶片条要渲染哪几段。纯函数，单独锁死（窗口算错 = 读屏指空 / 滚动条乱跳）。
 *
 * 返回 1 段或 2 段（互不相交、按起点升序）：滚动窗口与聚焦窗口离得远时
 * **不合并**，否则中间上千格会被一起渲染出来，窗口化就白做了。
 */
export function stripSegments(
  count: number,
  activeIndex: number,
  scrollLeft: number,
  viewportWidth: number,
): StripSegment[] {
  if (count <= 0) return [];

  const visible =
    viewportWidth > 0
      ? Math.ceil(viewportWidth / SHOT_STRIDE)
      : STRIP_FALLBACK_VISIBLE;
  const first = Math.max(
    0,
    Math.floor(Math.max(0, scrollLeft) / SHOT_STRIDE) - STRIP_OVERSCAN,
  );
  const scroll: StripSegment = {
    start: Math.min(first, Math.max(0, count - 1)),
    end: Math.min(count, first + visible + STRIP_OVERSCAN * 2),
  };
  if (activeIndex < 0 || activeIndex >= count) return [scroll];

  const active: StripSegment = {
    start: Math.max(0, activeIndex - STRIP_ACTIVE_KEEP),
    end: Math.min(count, activeIndex + STRIP_ACTIVE_KEEP + 1),
  };

  const [a, b] = scroll.start <= active.start ? [scroll, active] : [active, scroll];
  // 相接或相交 → 并成一段；否则两段各自渲染，中间交给占位块
  if (b.start <= a.end) return [{ start: a.start, end: Math.max(a.end, b.end) }];
  return [a, b];
}

/**
 * 占位块的宽度：替 k 个没渲染的格子占位。
 *
 * flex 的 gap 会在占位块两侧各补一次间距，所以要减去一个 gap，
 * 这样「占位块 + 已渲染格」的总宽与全量渲染严格相等，滚动条长度才是真的。
 */
const spacerWidth = (count: number) => count * SHOT_STRIDE - SHOT_GAP;

export interface GalleryViewProps {
  /** 显示顺序的素材（已摊平，连拍组也逐张列出） */
  assets: SortingAsset[];
  /** 当前聚焦项 id；为 null 或不在 assets 里时回退到第一项 */
  cursorId: string | null;
  onCursorChange: (id: string) => void;
  categories: SortingCategory[];
  markedSet: Set<string>;
  curatedIds: Set<string>;
  /** 把**当前聚焦项**移入分类 */
  onAssign?: (categoryId: string) => void;
  onCurate?: () => void;
  /** `D`：在「标删 / 取消标删」之间来回切 */
  onToggleDelete?: () => void;
  /**
   * `U`：**只撤回**，绝不反向标删。
   *
   * 病历：`U` 曾经和 `D` 一起映射到 onToggleDelete，于是对**未标记**的项按 `U`
   * 反而把它标进了待删清单——而速查表写的是「U 取消标删」，用户按它的动机
   * 恰恰是「我按错了，撤回」。画廊还会顺势前进到下一张，他连标错了都看不见。
   *
   * 不传时**不吞键**：事件原样冒泡给上层，让上层的处理器还有机会接（父层目前
   * 用 `.sorting__grid-wrap` 上的捕获阶段拦截兜着）。既不静默落空，也不会
   * 在两套接法并存期间打架。
   */
  onUnmarkDelete?: () => void;
  /** 打开全屏大图 */
  onOpenFullscreen?: () => void;
  onThumbError: () => void;
  onThumbLoad: () => void;
  /**
   * Esc 退回网格视图。
   *
   * 画廊没有「选区」也没有「上一层」，网格那套「Esc 清选」在这里无处落脚。
   * 上层接了它，Esc 就是「回网格」；**不传时不会静默吞键**：底部提示条不写
   * 这一条，真按下去也会给一次可见提示，说明它在画廊里不适用。
   */
  onExitToGrid?: () => void;
  /**
   * 库里的**总**素材数。分页加载时它大于 `assets.length`。
   *
   * 不传 = 调用方没有分页概念，已加载即全部，位置栏照旧写「共 N 张」。
   */
  total?: number;
  /** 上层正在续拉下一页。不传 = 当作没有加载中的请求，只是不显示加载态 */
  loading?: boolean;
  /**
   * 翻到已加载素材的末尾。上层据此续拉下一页。
   *
   * 不传时**不会静默停住**：会明确提示「已到已加载的末尾，还有 M 张未加载」。
   */
  onEndReached?: () => void;
}

export function GalleryView({
  assets,
  cursorId,
  onCursorChange,
  categories,
  markedSet,
  curatedIds,
  onAssign,
  onCurate,
  onToggleDelete,
  onUnmarkDelete,
  onOpenFullscreen,
  onThumbError,
  onThumbLoad,
  onExitToGrid,
  total,
  loading = false,
  onEndReached,
}: GalleryViewProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  /** 胶片条里每一格的节点，供「切换时滚入视野」用 */
  const shotRefs = useRef(new Map<string, HTMLElement>());

  /**
   * 聚焦项解析。cursorId 落空时回退到第一项——但**回退这件事本身不能是静默的**，
   * 下面 lostId 会把它说出来。
   */
  const rawIndex = useMemo(
    () => (cursorId === null ? -1 : assets.findIndex((a) => a.id === cursorId)),
    [assets, cursorId],
  );
  const index = assets.length === 0 ? -1 : rawIndex >= 0 ? rawIndex : 0;
  const active = index >= 0 ? assets[index] : null;

  /* ---------------- 分页边界的真话（评审 D2） ---------------- */

  const loadedCount = assets.length;
  /** total 比已加载还小只可能是上层算错；宁可少说，也不编一个更小的数 */
  const totalCount = Math.max(total ?? loadedCount, loadedCount);
  const pendingCount = totalCount - loadedCount;
  const hasMore = pendingCount > 0;

  /**
   * 「你刚按的这个键为什么没动静」。
   *
   * 到边、无多选语义、已加载到尽头——这些都是**说得通**但看不见的结果，
   * 历史事故清单里「按键按了没反应」就是从这里长出来的。
   */
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * 「你要看的那张已经不在列表里了」。
   *
   * 典型成因：刚把它分类/标删移走，或筛选条件变了。这时静默把画面换成第一张
   * 是最危险的——用户以为还在操作原来那张，实际打标会落到另一张上。
   * 用 state 记住（而不是直接由 props 推导），是因为下面会立刻把光标同步给上层，
   * 同步完 cursorId 就合法了，纯推导的提示会一闪而过等于没提示。
   */
  const [lostId, setLostId] = useState<string | null>(null);
  useEffect(() => {
    if (assets.length === 0) return;
    if (cursorId !== null && rawIndex < 0) setLostId(cursorId);
  }, [assets.length, cursorId, rawIndex]);

  /**
   * 把回退后的光标同步回上层。
   *
   * 不同步的话，上层仍持有旧的 cursorId，而 onAssign/onCurate/onToggleDelete
   * 都是「作用于当前聚焦项」由上层自己解析目标——两边不一致就会出现
   * 「界面显示 A、操作打在 B 上」的静默错位。
   * 上层若不理会本次调用，deps 不变，不会形成循环。
   */
  useEffect(() => {
    if (!active) return;
    if (cursorId === active.id) return;
    onCursorChange(active.id);
  }, [active, cursorId, onCursorChange]);

  /** 用户主动切换：顺带把「原先那张已消失」「刚到边」这类提示消掉（他已经往前走了） */
  const selectAsset = useCallback(
    (id: string) => {
      setLostId(null);
      setNotice(null);
      onCursorChange(id);
    },
    [onCursorChange],
  );

  /**
   * 走到已加载素材的尾巴上。
   *
   * 分三种口径，一种都不许含糊：还有没加载的且上层能续拉 → 请求并说明；
   * 还有没加载但上层没接线 → 说清差多少张、去哪儿加载；真到全库末尾 → 说到底了。
   */
  const reachTail = useCallback(() => {
    if (!hasMore) {
      setNotice(`已经是最后一张（共 ${loadedCount} 张）。`);
      return;
    }
    if (onEndReached) {
      setNotice(
        `已到已加载的第 ${loadedCount} 张，另有 ${pendingCount} 张未加载，已请求继续加载。`,
      );
      onEndReached();
      return;
    }
    setNotice(
      `已到已加载素材的末尾（已加载 ${loadedCount} 张，共 ${totalCount} 张），` +
        `还有 ${pendingCount} 张未加载。当前视图无法继续加载，回网格视图加载更多后再回来。`,
    );
  }, [hasMore, loadedCount, onEndReached, pendingCount, totalCount]);

  const step = useCallback(
    (delta: number) => {
      if (assets.length === 0 || index < 0) return;
      const target = Math.min(assets.length - 1, Math.max(0, index + delta));
      if (target === index) {
        // 到边不许静默：这正是评审实测「按右键什么也不发生」的那一下
        if (delta > 0) reachTail();
        else setNotice("已经是第一张。");
        return;
      }
      selectAsset(assets[target].id);
    },
    [assets, index, reachTail, selectAsset],
  );

  const jumpTo = useCallback(
    (target: number) => {
      if (assets.length === 0) return;
      const clamped = Math.min(assets.length - 1, Math.max(0, target));
      if (clamped === index) {
        if (target >= index) reachTail();
        else setNotice("已经是第一张。");
        return;
      }
      selectAsset(assets[clamped].id);
    },
    [assets, index, reachTail, selectAsset],
  );

  /* ---------------- 大图换图的方向动画 ---------------- */

  const directionRef = useRef(1);
  const lastAnimatedRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = lastAnimatedRef.current;
    lastAnimatedRef.current = active?.id ?? null;
    if (!active || previous === null || previous === active.id) return;
    const el = stageRef.current;
    if (!el) return;
    // 新图从「你要去的方向」进来；起始不透明度取 0.35 而不是 0，
    // 避免新图尚未解码完时先闪一下底色。animateOnce 内部已按
    // prefers-reduced-motion 直接返回。
    animateOnce(
      el,
      [
        {
          transform: `translate3d(${directionRef.current * SWAP_SHIFT_PX}px, 0, 0)`,
          opacity: 0.35,
        },
        { transform: "translate3d(0, 0, 0)", opacity: 1 },
      ],
      SWAP_DURATION_MS,
    );
  }, [active]);

  /* ---------------- 胶片条：窗口化与滚动 ---------------- */

  const [scrollLeft, setScrollLeft] = useState(0);
  const [stripWidth, setStripWidth] = useState(0);

  const measureStrip = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    setStripWidth(el.clientWidth);
  }, []);

  useLayoutEffect(() => {
    measureStrip();
    // jsdom / 老 WebView 没有 ResizeObserver，退回 window resize
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measureStrip);
      return () => window.removeEventListener("resize", measureStrip);
    }
    const observer = new ResizeObserver(measureStrip);
    if (stripRef.current) observer.observe(stripRef.current);
    return () => observer.disconnect();
  }, [measureStrip]);

  const segments = useMemo(
    () => stripSegments(assets.length, index, scrollLeft, stripWidth),
    [assets.length, index, scrollLeft, stripWidth],
  );

  /* ---------------- 胶片条自动滚入视野 ---------------- */

  useEffect(() => {
    if (!active) return;
    const el = shotRefs.current.get(active.id);
    // jsdom / 老内核没有 scrollIntoView：滚动不是关键路径，缺了也不该抛
    if (!el || typeof el.scrollIntoView !== "function") return;
    // 不传 behavior：平滑与否交给 CSS 的 scroll-behavior，
    // 于是 base.css 里 prefers-reduced-motion 的全局覆盖自动生效
    el.scrollIntoView({ block: "nearest", inline: "center" });
    // deps 只认 active：把 segments 也算进来的话，用户手动横滚触发的窗口变化
    // 会立刻把视野拽回聚焦项——滚都滚不动
  }, [active]);

  /** 进入画廊后键盘立刻可用——否则用户得先点一下才知道方向键管用 */
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  /* ---------------- 给胶片条的稳定回调 ----------------
   *
   * 单格套了 memo，可传进去的回调必须**跨渲染同一个引用**，否则 memo 形同虚设
   * （上层的 onCursorChange 常是行内箭头函数，每次渲染都换新的）。
   * 一律走 ref 转发：身份恒定，读到的又永远是最新那份实现。
   */

  const latest = useRef({ selectAsset, onThumbError, onThumbLoad, index });
  useEffect(() => {
    latest.current = { selectAsset, onThumbError, onThumbLoad, index };
  }, [selectAsset, onThumbError, onThumbLoad, index]);
  // 首帧到首个 effect 之间也可能被点到，同步补一次（值与本次渲染一致）
  latest.current.index = index;

  const registerShot = useCallback((id: string, node: HTMLElement | null) => {
    if (node) shotRefs.current.set(id, node);
    else shotRefs.current.delete(id);
  }, []);

  const pickShot = useCallback((id: string, at: number) => {
    directionRef.current = at >= latest.current.index ? 1 : -1;
    latest.current.selectAsset(id);
    /* 点完要保证键盘还能接着用：部分内核（macOS 的 WebKit/Firefox）
       点按钮并不移动焦点，activeElement 会停在 body 上 */
    if (!rootRef.current?.contains(document.activeElement)) {
      rootRef.current?.focus({ preventScroll: true });
    }
  }, []);

  const handleShotError = useCallback(() => latest.current.onThumbError(), []);
  const handleShotLoad = useCallback(() => latest.current.onThumbLoad(), []);

  /* ---------------- 键盘 ---------------- */

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      // 输入框里打字不该被当成打标键
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;

      const action = resolveShortcut(
        {
          key: e.key,
          shiftKey: e.shiftKey,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
        },
        categories,
      );
      if (!action) return;

      let handled = true;
      if (action.type === "move") {
        // 胶片条是一维的：上下键在这里没有确定语义，原样放行给滚动
        if (action.key === "ArrowRight") {
          directionRef.current = 1;
          step(1);
        } else if (action.key === "ArrowLeft") {
          directionRef.current = -1;
          step(-1);
        } else if (action.key === "Home") {
          directionRef.current = -1;
          jumpTo(0);
        } else if (action.key === "End") {
          directionRef.current = 1;
          jumpTo(assets.length - 1);
        } else {
          handled = false;
        }
      } else if (action.type === "preview") {
        if (onOpenFullscreen) onOpenFullscreen();
        else handled = false;
      } else if (action.type === "assign") {
        if (onAssign) onAssign(action.categoryId);
        else handled = false;
      } else if (action.type === "other") {
        const other = categories.find((c) => c.kind === "other");
        if (onAssign && other) onAssign(other.id);
        else handled = false;
      } else if (action.type === "curate") {
        if (onCurate) onCurate();
        else handled = false;
      } else if (action.type === "markDelete") {
        // 裸 D：标删 / 取消标删来回切
        if (onToggleDelete) onToggleDelete();
        else handled = false;
      } else if (action.type === "unmarkDelete") {
        /*
         * U 是**单向撤回**，不能落到 onToggleDelete 上（评审：对未标记项按 U
         * 反而会把它标进待删清单，与速查表写的「U 取消标删」正好相反）。
         * 上层没接这个 prop 就**不吞键**：让它照常冒泡，上层还有机会接住；
         * 吞掉才是把「按了没反应」重新做回来。
         */
        if (onUnmarkDelete) onUnmarkDelete();
        else handled = false;
      } else if (action.type === "toggle" || action.type === "selectAll") {
        /*
         * X / ⌘A 在画廊里没有落脚点（这里一次只处理一张），但它们**印在网格的
         * 提示条上**，刚从网格切过来的人一定会按。评审实测的结果是 DOM 无变化、
         * 无通知——正是「按了没反应」。这里给一次可见回执，并吃掉按键，
         * 免得 ⌘A 退化成浏览器的「全选页面文字」。
         */
        setNotice(
          "画廊模式一次只处理当前这一张：X（选中）与 ⌘A（全选）在这里不适用，回网格视图使用。",
        );
      } else if (action.type === "clearSelection") {
        // 网格里 Esc = 清选；画廊没有选区，改判「回网格」，上层没接就说明白
        if (onExitToGrid) {
          onExitToGrid();
        } else {
          setNotice(
            "画廊模式没有选区可清，Esc 在这里不清选；本屏也未接「返回网格」。回网格后 Esc 才是清空选区。",
          );
          // 不吞键：上层将来若接了 Esc，仍然收得到
          handled = false;
        }
      } else {
        // confirmDelete 等不属于画廊：一律不拦，交还给上层
        // （Shift+D 提交待删清单就走这条路）
        handled = false;
      }

      if (!handled) return;
      e.preventDefault();
      e.stopPropagation();
    },
    [
      assets.length,
      categories,
      jumpTo,
      onAssign,
      onCurate,
      onExitToGrid,
      onOpenFullscreen,
      onToggleDelete,
      onUnmarkDelete,
      step,
    ],
  );

  /* ---------------- 空态 ---------------- */

  if (!active) {
    return (
      <div className="gallery gallery--empty" data-testid="gallery-view">
        <EmptyState>
          <p className="text-sm">画廊里没有可浏览的素材。</p>
          <p className="text-xs dim">
            当前筛选条件下没有命中任何素材，或待分类夹已经清空。
            换个筛选条件，或回到网格视图确认素材是否已被移走。
          </p>
        </EmptyState>
      </div>
    );
  }

  const customCategories = categories.filter((c) => c.kind === "custom");
  const otherCategory = categories.find((c) => c.kind === "other");
  const marked = markedSet.has(active.id);
  const curated = curatedIds.has(active.id);
  const hasActions = Boolean(onAssign || onCurate || onToggleDelete);

  /**
   * 提示条只写**真接了线**的键。
   *
   * 上层没给 onCurate 却在提示条里写着「P 精选」，就是又一处「按了没反应」——
   * 这条提示表要跟着实际能力走，不许照抄一份静态文案。
   */
  const markHints: Array<{ key: string; label: string }> = [];
  if (onAssign && customCategories.some((c) => c.hotkey)) {
    markHints.push({ key: "1–9", label: "分类" });
  }
  if (onCurate) markHints.push({ key: "P", label: "精选" });
  if (onAssign && otherCategory) markHints.push({ key: "O", label: "其他" });
  if (onToggleDelete) markHints.push({ key: "D", label: "标删/取消" });
  // U 与 D 分开写：D 是来回切，U 只撤回。两者含糊在一起正是那次「按 U 反被标删」
  if (onUnmarkDelete) markHints.push({ key: "U", label: "取消标删" });

  /*
   * 位置栏只敢说自己知道的事：画廊拿到的永远只是**已加载**那一批，
   * 把它写成「共 200 张」而库里其实有 1240 张，就是在对用户说谎（评审 D2）。
   */
  const positionText = hasMore
    ? `第 ${index + 1} 张 / 已加载 ${loadedCount} 张（共 ${totalCount} 张）`
    : `第 ${index + 1} 张 / 共 ${loadedCount} 张`;

  /** 胶片条要渲染的下标（含占位块的分段结构） */
  const renderedCount = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  const stripChildren: JSX.Element[] = [];
  let cursor = 0;
  for (let si = 0; si < segments.length; si += 1) {
    const segment = segments[si];
    if (segment.start > cursor) {
      stripChildren.push(
        <StripSpacer key={`spacer-${si}`} count={segment.start - cursor} />,
      );
    }
    for (let i = segment.start; i < segment.end; i += 1) {
      const asset = assets[i];
      stripChildren.push(
        <StripShot
          key={asset.id}
          asset={asset}
          index={i}
          selected={i === index}
          marked={markedSet.has(asset.id)}
          curated={curatedIds.has(asset.id)}
          registerShot={registerShot}
          onPick={pickShot}
          onThumbError={handleShotError}
          onThumbLoad={handleShotLoad}
        />,
      );
    }
    cursor = segment.end;
  }
  if (cursor < assets.length) {
    stripChildren.push(<StripSpacer key="spacer-tail" count={assets.length - cursor} />);
  }

  return (
    <div
      className="gallery"
      data-testid="gallery-view"
      ref={rootRef}
      /* 与 SortingScreen 的 .sorting__grid-wrap 同一手法：容器自己可聚焦，
         快捷键只在焦点位于画廊内时生效，不去 document 上抢键 */
      tabIndex={0}
      aria-label="画廊模式：左右方向键换图，回车看全屏"
      onKeyDown={handleKeyDown}
    >
      {/* 聚焦项被移走后的回退，必须说清楚为什么画面换了人（零静默） */}
      {lostId !== null ? (
        <div className="gallery__alert" role="status" data-testid="gallery-cursor-lost">
          <span>
            原先聚焦的
            <span className="mono"> {lostId} </span>
            已不在当前列表里（可能刚被分类、标删，或被筛选条件排除），已改为显示第 1 张。
            请确认后再继续打标。
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm push-right"
            data-testid="gallery-cursor-lost-dismiss"
            onClick={() => setLostId(null)}
          >
            知道了
          </button>
        </div>
      ) : null}

      <div className="gallery__main">
        <section className="gallery__stage" aria-label="大图">
          <div className="gallery__stage-head">
            <span
              className="text-xs dim"
              aria-live="polite"
              data-testid="gallery-position"
            >
              {positionText}
              {loading ? "，正在加载后续素材…" : ""}
            </span>
            <span className="gallery__badges" data-testid="gallery-badges">
              <JudgementBadges judgement={active.judgement} />
              {curated ? <Badge tone="ok">已精选</Badge> : null}
              {marked ? <Badge tone="danger">已标删</Badge> : null}
            </span>
            {onOpenFullscreen ? (
              <button
                type="button"
                className="btn btn--sm push-right"
                data-testid="gallery-fullscreen"
                onClick={onOpenFullscreen}
              >
                <Kbd>Enter</Kbd>全屏
              </button>
            ) : null}
          </div>

          <div className="gallery__frame">
            {active.thumbReady && active.thumbnail ? (
              <StageImage
                key={active.id}
                asset={active}
                mediaRef={stageRef}
                onOpenFullscreen={onOpenFullscreen}
                onThumbError={onThumbError}
                onThumbLoad={onThumbLoad}
              />
            ) : (
              /* 缩略图还没出来：说清是「还没做」而不是「没有图」 */
              <div
                ref={(node) => {
                  stageRef.current = node;
                }}
                className="gallery__image gallery__image--empty"
                data-testid="gallery-no-image"
              >
                <span className="text-sm dim">该文件尚未生成预览（索引中）</span>
              </div>
            )}
          </div>
        </section>

        <aside className="gallery__detail" aria-label="素材详情">
          <h3 className="gallery__filename mono" title={active.fileName}>
            {active.fileName}
          </h3>

          <dl className="dl">
            <div className="dl__row">
              <dt className="dl__key">类型</dt>
              <dd className="dl__val">{KIND_LABEL[active.kind]}</dd>
            </div>
            <div className="dl__row">
              <dt className="dl__key">大小</dt>
              <dd className="dl__val mono" data-testid="gallery-size">
                {formatBytes(active.sizeBytes)}
              </dd>
            </div>
            <div className="dl__row">
              <dt className="dl__key">拍摄时间</dt>
              <dd className="dl__val mono" data-testid="gallery-shot-at">
                {/* 没有时间不能留空:留空读作「这张没时间」,其实是 EXIF 没读到 */}
                {active.shotAt ? (
                  <>
                    {formatTimestamp(active.shotAt)}
                    {active.shotAtFallback ? "（推断自文件修改时间）" : ""}
                  </>
                ) : (
                  <span className="dim">未知（EXIF 无拍摄时间，也未回退文件时间）</span>
                )}
              </dd>
            </div>
            <div className="dl__row">
              <dt className="dl__key">判定</dt>
              <dd className="dl__val" data-testid="gallery-judgement">
                {/* 没有 judgement = 本机 AI 还没分析过,不是「分析过且一切正常」 */}
                {active.judgement ? (
                  <JudgementBadges judgement={active.judgement} />
                ) : (
                  <span className="dim">尚未分析（本机 AI 判定未跑到这张）</span>
                )}
              </dd>
            </div>
            <div className="dl__row">
              <dt className="dl__key">人脸</dt>
              <dd className="dl__val" data-testid="gallery-faces">
                {/*
                  与 Lightbox 同一判例：「检出 0 张脸」和「这次分析根本没做人脸检测」
                  是两件事，合并成一句会把「不知道」说成「没有」。
                */}
                {!active.judgement ? (
                  <span className="dim">尚未分析</span>
                ) : active.judgement.faces == null ? (
                  <span className="dim">人脸检测不可用（本次分析未做人脸检测）</span>
                ) : (
                  `检出人脸 ${active.judgement.faces}`
                )}
              </dd>
            </div>
            <div className="dl__row">
              <dt className="dl__key">状态</dt>
              <dd className="dl__val" data-testid="gallery-flags">
                {curated || marked ? (
                  <span className="gallery__badges">
                    {curated ? <Badge tone="ok">已精选</Badge> : null}
                    {marked ? <Badge tone="danger">已标删</Badge> : null}
                  </span>
                ) : (
                  <span className="dim">未标记</span>
                )}
              </dd>
            </div>
            <div className="dl__row">
              <dt className="dl__key">路径</dt>
              <dd className="dl__val mono text-xs" data-testid="gallery-path">
                {/* id 就是项目内相对路径,长路径整条给出,不截断成谜语 */}
                {active.id}
              </dd>
            </div>
          </dl>

          {hasActions ? (
            /* 动作条兼快捷键提示（与 Lightbox 同一口径 D2）：
               在看大图的地方就能把这张的去向定下来，不必退回网格找格子 */
            <div className="gallery__actions" data-testid="gallery-actions">
              {onAssign
                ? customCategories.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="btn btn--sm"
                      data-testid="gallery-assign"
                      data-category={c.id}
                      onClick={() => onAssign(c.id)}
                    >
                      {c.hotkey ? <Kbd>{c.hotkey}</Kbd> : null}
                      {c.name}
                    </button>
                  ))
                : null}
              {onCurate ? (
                <button
                  type="button"
                  className="btn btn--sm"
                  data-testid="gallery-curate"
                  title="复制一份进「精选/待修」，原件留在待分类"
                  onClick={onCurate}
                >
                  <Kbd>P</Kbd>精选
                </button>
              ) : null}
              {onAssign && otherCategory ? (
                <button
                  type="button"
                  className="btn btn--sm"
                  data-testid="gallery-other"
                  onClick={() => onAssign(otherCategory.id)}
                >
                  <Kbd>O</Kbd>其他
                </button>
              ) : null}
              {onToggleDelete ? (
                <button
                  type="button"
                  className={`btn btn--sm${marked ? "" : " btn--danger"}`}
                  data-testid="gallery-toggle-delete"
                  onClick={onToggleDelete}
                >
                  <Kbd>D</Kbd>
                  {marked ? "取消标删" : "标删"}
                </button>
              ) : null}
            </div>
          ) : null}
        </aside>
      </div>

      {/* 「刚才那一下为什么没动静」——按键落空、到边、加载边界都在这里说 */}
      {notice !== null ? (
        <div
          className="gallery__alert gallery__alert--info"
          role="status"
          data-testid="gallery-notice"
        >
          <span>{notice}</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm push-right"
            data-testid="gallery-notice-dismiss"
            onClick={() => setNotice(null)}
          >
            知道了
          </button>
        </div>
      ) : null}

      <div
        className="gallery__strip"
        role="listbox"
        ref={stripRef}
        /* 选项都是 tabIndex=-1，活动项靠 aria-activedescendant 指出来：
           上千格逐个 Tab 会让键盘用户走不出胶片条。
           窗口化之后这个 id 必须始终有对应节点，见 stripSegments 的聚焦窗口。 */
        tabIndex={0}
        aria-activedescendant={shotDomId(index)}
        aria-label={
          hasMore
            ? `胶片条，已加载 ${loadedCount} 张，共 ${totalCount} 张`
            : `胶片条，共 ${loadedCount} 张`
        }
        data-testid="gallery-strip"
        /* 当前真正挂在 DOM 里的格数（窗口化的可观测出口，也给测试当闸门） */
        data-rendered={renderedCount}
        /* 只在跨格时更新状态：同一格内的像素级滚动不改变窗口，
           却会每帧触发一次几十个节点的重新协调 */
        onScroll={(e) => {
          const left = e.currentTarget.scrollLeft;
          setScrollLeft((prev) =>
            Math.floor(prev / SHOT_STRIDE) === Math.floor(left / SHOT_STRIDE)
              ? prev
              : left,
          );
        }}
      >
        {stripChildren}
        {hasMore ? (
          /* 胶片条的尽头是「已加载到这里」，不是「库里就这些」。
             aria-hidden：listbox 里不塞非 option 节点，这句话由位置栏的
             aria-live 负责念给读屏 */
          <span
            className="gallery__strip-more"
            aria-hidden="true"
            data-testid="gallery-strip-more"
          >
            {loading ? "加载中…" : `还有 ${pendingCount} 张未加载`}
          </span>
        ) : null}
      </div>

      {/*
        画廊自己的键位表。不照抄网格那套——网格提示条写着的 X / Shift+方向 /
        ⌘A 在这里都没有落脚点，照抄就是把用户往空处引（评审 D1）。
      */}
      <div className="gallery__hints hint-bar" data-testid="gallery-hints">
        <span>
          <Kbd>←</Kbd>
          <Kbd>→</Kbd> 上一张/下一张 · <Kbd>Home</Kbd>
          <Kbd>End</Kbd> 首/末张
        </span>
        {onOpenFullscreen ? (
          <span>
            <Kbd>Enter</Kbd>/<Kbd>空格</Kbd> 全屏
          </span>
        ) : null}
        {markHints.length > 0 ? (
          <span data-testid="gallery-hint-marks">
            {/* 分隔符由 join 补，避免某一项没接线时留下一个孤零零的「·」 */}
            {markHints.map((hint, i) => (
              <span key={hint.key}>
                {i > 0 ? " · " : null}
                <Kbd>{hint.key}</Kbd> {hint.label}
              </span>
            ))}
          </span>
        ) : null}
        {onExitToGrid ? (
          <span data-testid="gallery-hint-exit">
            <Kbd>Esc</Kbd> 回网格
          </span>
        ) : null}
        <span data-testid="gallery-hint-multi">
          画廊一次只处理当前这一张：<Kbd>X</Kbd> 选中 / <Kbd>⌘A</Kbd>{" "}
          全选不适用，多选请回网格
        </span>
      </div>
    </div>
  );
}

/**
 * 大图。取图失败要与「还没生成」分开说：前者是缓存失效/被清，
 * 后者是索引还没跑到——用户的下一步动作完全不同。
 */
function StageImage({
  asset,
  mediaRef,
  onOpenFullscreen,
  onThumbError,
  onThumbLoad,
}: {
  asset: SortingAsset;
  mediaRef: { current: HTMLElement | null };
  onOpenFullscreen?: () => void;
  onThumbError: () => void;
  onThumbLoad: () => void;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        ref={(node) => {
          mediaRef.current = node;
        }}
        className="gallery__image gallery__image--empty"
        data-testid="gallery-image-failed"
        role="status"
      >
        <span className="text-sm">预览不可用</span>
        <span className="text-xs dim">
          缩略图取不到（缓存已失效或被清理）。原始文件不受影响，重新索引后可恢复。
        </span>
      </div>
    );
  }

  return (
    <img
      ref={(node) => {
        mediaRef.current = node;
      }}
      className="gallery__image"
      src={asset.thumbnail}
      alt={asset.fileName}
      data-testid="gallery-image"
      title={onOpenFullscreen ? "点击看全屏（缩略图预览，清晰度有限）" : undefined}
      onClick={onOpenFullscreen}
      onError={() => {
        setFailed(true);
        onThumbError();
      }}
      onLoad={onThumbLoad}
    />
  );
}

/** 没渲染的那一段用它占位：只出宽度，不进无障碍树 */
function StripSpacer({ count }: { count: number }) {
  return (
    <div
      className="gallery__strip-spacer"
      aria-hidden="true"
      data-testid="gallery-strip-spacer"
      data-count={count}
      style={{ flex: `0 0 ${spacerWidth(count)}px` }}
    />
  );
}

/**
 * 胶片条里的一格。
 *
 * memo 不是锦上添花：索引进行中，上层每秒约 5 次进度更新会把整棵树推一遍，
 * 而这一格的观感只由 asset/选中/标记决定。换图时真正需要重画的只有两格。
 * 前提是回调引用稳定（见上面的 latest ref），否则 memo 每次都判定"变了"。
 *
 * 导出只为测试：memo 一旦被后人顺手摘掉，界面看不出任何变化，
 * 只有上千张时"变卡"——这种退化必须由用例守住，不能靠肉眼。
 */
export const StripShot = memo(function StripShot({
  asset,
  index,
  selected,
  marked,
  curated,
  registerShot,
  onPick,
  onThumbError,
  onThumbLoad,
}: {
  asset: SortingAsset;
  index: number;
  selected: boolean;
  marked: boolean;
  curated: boolean;
  registerShot: (id: string, node: HTMLElement | null) => void;
  onPick: (id: string, index: number) => void;
  onThumbError: () => void;
  onThumbLoad: () => void;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [asset.thumbnail]);

  return (
    <button
      type="button"
      id={shotDomId(index)}
      ref={(node) => registerShot(asset.id, node)}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      className={`gallery__shot${selected ? " gallery__shot--active" : ""}`}
      data-testid="gallery-shot"
      data-asset={asset.id}
      data-index={index}
      title={asset.fileName}
      onClick={() => onPick(asset.id, index)}
    >
      {asset.thumbReady && asset.thumbnail && !failed ? (
        <img
          className="gallery__shot-thumb"
          src={asset.thumbnail}
          alt=""
          loading="lazy"
          data-testid="gallery-shot-thumb"
          onError={() => {
            setFailed(true);
            onThumbError();
          }}
          onLoad={onThumbLoad}
        />
      ) : (
        /* 与主网格同一口径：没图不许留白，「索引中」和「预览不可用」分开说 */
        <span
          className="gallery__shot-thumb gallery__shot-thumb--empty"
          data-testid="gallery-shot-no-thumb"
        >
          <span className="text-2xs dim">{failed ? "预览不可用" : "索引中"}</span>
        </span>
      )}
      <span className="gallery__shot-name mono text-2xs truncate">{asset.fileName}</span>
      {curated ? (
        <span className="gallery__shot-flag gallery__shot-flag--curated" aria-hidden="true">
          ✓
        </span>
      ) : null}
      {marked ? (
        <span className="gallery__shot-flag gallery__shot-flag--delete" aria-hidden="true">
          D
        </span>
      ) : null}
      <span className="sr-only">
        第 {index + 1} 项
        {curated ? "，已精选" : ""}
        {marked ? "，已标记待删除" : ""}
      </span>
    </button>
  );
});
