/** 屏 5：分类工作台（工况 B 核心，PRD §5.4 键盘驱动分类）。 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import * as api from "../api";
import type {
  AnalysisResult,
  BulkResult,
  CuratedFlowHint,
  SortingAsset,
  SortingCategory,
} from "../api/types";
import { AssetLightbox } from "../components/AssetLightbox";
import { ConfirmDialog, type ConfirmRequest } from "../components/ConfirmDialog";
import { DeliveryButton } from "../components/DeliveryPanel";
import { GalleryView } from "../components/GalleryView";
import { IconClose } from "../components/Icon";
import { JudgementBadges, LOW_SCORE_AT } from "../components/JudgementBadges";
import { TopBar } from "../components/TopBar";
import { IllSortingEmpty } from "../components/illustrations";
import {
  Badge,
  EmptyState,
  Kbd,
  ProgressBar,
  PulseValue,
} from "../components/ui";
import { VirtualGrid } from "../components/VirtualGrid";
import { Select } from "../components/controls";
import { formatBytes, formatTimestamp } from "../lib/format";
import { withViewTransition } from "../lib/motion";
import {
  actionTargets,
  buildGridEntries,
  clickSelection,
  filterByJudgement,
  flattenEntries,
  gateAction,
  resolveEntryIds,
  emptySelection,
  GROUP_ID_PREFIX,
  initialPendingDelete,
  JUDGEMENT_FILTER_LABEL,
  moveCursor,
  nextCursorAfterRemoval,
  nextIndexInGrid,
  pendingDeleteReducer,
  pruneSelection,
  removedEntryIds,
  resolveShortcut,
  selectAll,
  shouldYieldShortcut,
  toggleSelection,
  type ActionOutcome,
  type JudgementFilter,
  type Selection,
  type SortingActionKind,
} from "../lib/sorting";
import { trapTabFocus } from "../lib/focusTrap";
import {
  selectDeliveryWorking,
  selectLatestAnalyzeJob,
  useStore,
} from "../state/store";

const PAGE_SIZE = 200;
/** 索引事件驱动的重拉节流：索引中事件很密，不能每条都打一次 IPC */
const INDEX_REFRESH_MIN_MS = 2000;
/** 连续多少张缩略图加载失败就在屏内亮出横幅（后端另发 thumb-protocol-degraded 通知） */
const THUMB_FAIL_BANNER_AT = 20;
export { LOW_SCORE_AT };
/** 批量移动的「撤销」窗口:超时自动收起(文件已在分类夹里,仍可手动找回) */
const UNDO_WINDOW_MS = 10_000;

/** 非照片类型的中性徽章文案；other = 后端明确的「其他类型」，不再伪装成视频 */
const KIND_LABEL: Record<SortingAsset["kind"], string> = {
  photo: "照片",
  raw: "RAW",
  video: "视频",
  other: "其他类型",
};
const CELL_MIN_WIDTH = 148;
const ROW_HEIGHT = 148;
const GRID_GAP = 8;
/** 「操作已提交」的格子回弹提示挂多久（略长于 --dur-spring-pop，让动画放完） */
const COMMIT_PULSE_MS = 420;

export function SortingScreen() {
  const { state, dispatch } = useStore();
  const project = state.projects.find((p) => p.id === state.selectedProjectId) ?? null;
  const projectId = project?.id ?? null;
  /** 交付作业进行中（由 job 状态派生）：分类、删除链路、导航都要据此禁用 */
  const deliveryWorking = selectDeliveryWorking(state);
  const analyzeJob = project ? selectLatestAnalyzeJob(state, project.id) : null;
  const analyzing =
    analyzeJob !== null &&
    (analyzeJob.state === "queued" || analyzeJob.state === "running");

  const [assets, setAssets] = useState<SortingAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  /** 初始加载失败：绝不能渲染成「没有素材」——那是把故障说成空目录 */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  /** 翻页失败：保留已加载内容，单独显示错误 */
  const [pageError, setPageError] = useState<string | null>(null);
  /** 连续加载失败的缩略图数：任一成功即归零 */
  const [thumbFailStreak, setThumbFailStreak] = useState(0);
  /** 判定筛选组(评审 3.6):「这批全要/全不要」都要有路径 */
  const [judgeFilter, setJudgeFilter] = useState<JudgementFilter>("all");
  /** 只看已标删(评审 3.9):删前复核不必满网格找红角标 */
  const [markedOnly, setMarkedOnly] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  /** 组全屏层自己的光标（组成员 assetId）：方向键在组内走的就是它 */
  const [groupCursorId, setGroupCursorId] = useState<string | null>(null);
  /**
   * 这次大图是**从组层**打开的吗。
   * Esc 只退一层（大图 → 组层 → 网格），全靠它记住来路；
   * 少了这一位，从组里点开一张再按 Esc 就会被一脚踢回网格。
   */
  const [previewFromGroup, setPreviewFromGroup] = useState(false);
  /** 网格 / 画廊视图切换（本屏 state，不持久化） */
  const [viewMode, setViewMode] = useState<"grid" | "gallery">("grid");
  /** 画廊模式的聚焦项（assetId 空间；网格的 selection.cursor 走的是条目 id 空间） */
  const [galleryCursorId, setGalleryCursorId] = useState<string | null>(null);
  const [flowHints, setFlowHints] = useState<CuratedFlowHint[]>([]);
  const [flowHintsOpen, setFlowHintsOpen] = useState(false);
  const [categories, setCategories] = useState<SortingCategory[]>([]);
  const [indexing, setIndexing] = useState<{
    indexed: number;
    total: number;
    running: boolean;
    failed: number;
    missing: number;
    round: number;
  } | null>(null);

  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [pendingDelete, dispatchDelete] = useReducer(
    pendingDeleteReducer,
    initialPendingDelete,
  );
  const markedSet = useMemo(
    () => new Set(pendingDelete.marked),
    [pendingDelete.marked],
  );
  /**
   * 本次会话精选过的素材(评审 3.3):精选是复制语义,格子留在网格里,
   * 没有常驻标识就记不住哪些按过 P。按项目存 localStorage,重启不丢;
   * 这是视图层记忆,权威事实仍是「精选/待修」夹里的文件。
   */
  const [curatedIds, setCuratedIds] = useState<Set<string>>(new Set());
  /** 批量移动的撤销窗口(评审 3.5):高速打标必然误击,分错类要有退路 */
  const [lastMove, setLastMove] = useState<{
    assetIds: string[];
    categoryName: string;
  } | null>(null);
  const [undoing, setUndoing] = useState(false);
  /** 预览锚在 assetId 上，避免折叠/筛选后下标错位 */
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [columns, setColumns] = useState(6);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * 「这一下确实生效了」的格子级回弹。
   *
   * 精选是复制语义，素材不离开网格——不给反馈的话，用户按完 P 只能靠顶部
   * 计数去猜。phase 在 a / b 之间来回切，是为了让连续两次操作都能重新起播
   * （同名 CSS 动画在同一个节点上不会自动重放）。
   */
  const [commit, setCommit] = useState<{ ids: Set<string>; phase: "a" | "b" } | null>(
    null,
  );
  const commitPhaseRef = useRef<"a" | "b">("b");

  const gridWrapRef = useRef<HTMLDivElement>(null);
  /** 画廊根节点：画廊模式下真正的键盘宿主（评审 B2） */
  const galleryRootRef = useRef<HTMLDivElement | null>(null);
  const loadedCountRef = useRef(0);
  const lastRefreshRef = useRef(0);
  /**
   * 项目 epoch。切项目就 ++，所有 `await` 回来之后都要拿它对一次账。
   *
   * 侧栏切项目不会卸载本屏，于是「旧项目的响应」会落进「新项目的界面」：
   * 旧素材灌进新网格，接着按数字键——移动的是**另一个项目里的同名文件**。
   * `cancelled` 只挡得住 effect 那一路，回调里的 await 一路必须靠这个令牌。
   */
  const epochRef = useRef(0);
  /** refreshLoadedAssets 的请求序号：两次重拉并发时，晚发的赢，早发的整批丢弃 */
  const refreshSeqRef = useRef(0);
  /**
   * busy 的**同步**镜像。state 要等下一次渲染才更新，连打数字键时
   * 第二下拿到的还是 busy=false 的旧闭包——闸门会放它过去，然后被
   * 后端串行拒掉，用户只看到「按了没反应」。
   */
  const busyRef = useRef(false);
  /** 上一条索引事件的快照，用于判定「增长 / 重启 / 完成」；随 projectId 重置 */
  const lastEventRef = useRef<{
    indexed: number;
    running: boolean;
    round: number;
  } | null>(null);
  /** 收尾对账只做一次，避免自我循环 */
  const reconciledRef = useRef(false);
  const assetsRef = useRef<SortingAsset[]>([]);
  const deliveryWorkingRef = useRef(false);
  const notifyRef = useRef<
    (level: "warning" | "error", code: string, message: string) => void
  >(() => {});

  useEffect(() => {
    loadedCountRef.current = assets.length;
    assetsRef.current = assets;
  }, [assets]);

  /** 光标前进要在「当前网格条目」空间里算,applyBulk 是稳定回调,经 ref 取最新 */
  const entriesRef = useRef<typeof entries>([]);

  // 精选标识按项目载入/落盘(评审 3.3)
  useEffect(() => {
    if (!projectId) {
      setCuratedIds(new Set());
      return;
    }
    try {
      const raw = window.localStorage?.getItem(`ocard:curated:${projectId}`);
      setCuratedIds(new Set(raw ? (JSON.parse(raw) as string[]) : []));
    } catch {
      // 私隐模式/清站点数据:没有记忆就从空开始,不影响分类本身
      setCuratedIds(new Set());
    }
  }, [projectId]);

  const rememberCurated = useCallback(
    (ids: string[]) => {
      setCuratedIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.add(id);
        if (projectId) {
          try {
            window.localStorage?.setItem(
              `ocard:curated:${projectId}`,
              JSON.stringify([...next].slice(-5000)),
            );
          } catch {
            // 存不进去只丢记忆,不丢功能
          }
        }
        return next;
      });
    },
    [projectId],
  );

  // 撤销窗口超时自动收起
  useEffect(() => {
    if (!lastMove) return;
    const timer = setTimeout(() => setLastMove(null), UNDO_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [lastMove]);

  const onThumbError = useCallback(() => setThumbFailStreak((n) => n + 1), []);
  const onThumbLoad = useCallback(() => setThumbFailStreak(0), []);

  /**
   * 把键盘焦点交回「当前视图的键盘宿主」。
   *
   * 网格模式是 `.sorting__grid-wrap`；**画廊模式是 GalleryView 的根节点**。
   * 交错地方的实测后果（评审 B2）：画廊里 Enter 开全屏、Esc 关掉之后，
   * 焦点被无条件还给外层 wrap，而画廊的键盘流挂在它自己的根节点上收不到
   * 父节点的事件；wrap 的兜底处理器又把 move / selectAll / Esc 原样放掉——
   * 方向键和 Esc 全部无反应且零提示，打标键却还能用，
   * 于是这一屏看起来像"坏了一半"。这正是选片主循环里最高频的那条路径。
   *
   * 第二个用途是「控件把自己卸载/禁用掉」之后的接盘（评审 C1）：
   * 分类 chip 一按就 disabled、待删条一清空就整条卸载、撤销条一成功就消失——
   * 被禁用/被移除的元素会把焦点丢给 body，键盘流就此断掉，屏上没有任何迹象。
   * 这三条路径与已修的「组层关闭焦点落 body」是同一类事故。
   */
  const focusKeyboardHost = useCallback(() => {
    const host =
      viewMode === "gallery" && galleryRootRef.current
        ? galleryRootRef.current
        : gridWrapRef.current;
    // preventScroll：收焦点不该顺手把网格滚到别处去
    host?.focus({ preventScroll: true });
  }, [viewMode]);

  const visibleAssets = useMemo(() => {
    const byJudge = filterByJudgement(assets, judgeFilter, LOW_SCORE_AT);
    return markedOnly ? byJudge.filter((a) => markedSet.has(a.id)) : byJudge;
  }, [assets, judgeFilter, markedOnly, markedSet]);
  const entries = useMemo(
    () =>
      buildGridEntries(visibleAssets, (reason) =>
        notifyRef.current("warning", "sorting-grouping-degraded", reason),
      ),
    [visibleAssets],
  );
  entriesRef.current = entries;
  /** 预览的唯一下标空间：网格显示顺序摊平后的素材列表 */
  const previewAssets = useMemo(() => flattenEntries(entries), [entries]);
  const openGroupItems = useMemo(() => {
    if (!openGroup) return [] as SortingAsset[];
    const entry = entries.find(
      (e) => e.kind === "group" && e.groupId === openGroup,
    );
    return entry && entry.kind === "group" ? entry.items : [];
  }, [entries, openGroup]);

  /**
   * 大图的**翻页范围**：来路决定边界。
   *
   * 从组层进来的大图锁在组成员内——层级语义必须自洽：Esc 退回的是这个组，
   * 那大图就不该能翻出组外，否则翻到第三张组外的图、再 Esc 却回到一个
   * 不含它的组。从网格直接进来的维持全局摊平列表不变。
   * `index / total` 也随之显示组内序号（lightbox 那边另有 scopeLabel 说明范围）。
   */
  const previewScope =
    previewFromGroup && openGroupItems.length > 0 ? openGroupItems : previewAssets;
  const previewIndex = previewId
    ? previewScope.findIndex((a) => a.id === previewId)
    : -1;

  /*
   * 预览目标已经不在翻页范围里（被移走 / 被筛掉 / 整组清空）：大图会自动消失，
   * 但 previewId 若留着非空，网格键盘流会一直被「预览中」挡在门外——
   * 按什么键都毫无反应，还看不出为什么。必须归零。
   */
  useEffect(() => {
    if (previewId !== null && previewIndex < 0) {
      setPreviewId(null);
      setPreviewFromGroup(false);
    }
  }, [previewId, previewIndex]);
  /** 选区认的是「条目 id」——组条目用合成 id，等高行与选择模型都不受影响 */
  const assetIds = useMemo(() => entries.map((e) => e.id), [entries]);
  const selectedSet = useMemo(() => new Set(selection.selected), [selection.selected]);
  const cursorIndex = selection.cursor ? assetIds.indexOf(selection.cursor) : -1;

  /* ---------------- 动效与导航连续性 ---------------- */

  const pulseCommit = useCallback((entryIds: string[]) => {
    if (entryIds.length === 0) return;
    commitPhaseRef.current = commitPhaseRef.current === "a" ? "b" : "a";
    setCommit({ ids: new Set(entryIds), phase: commitPhaseRef.current });
  }, []);

  // 播完就摘掉标记：否则格子滚出窗口再滚回来会莫名其妙再弹一次
  useEffect(() => {
    if (!commit) return;
    const timer = setTimeout(() => setCommit(null), COMMIT_PULSE_MS);
    return () => clearTimeout(timer);
  }, [commit]);

  /**
   * 打开全屏预览。
   *
   * 支持视图过渡的内核上，网格里那一格的缩略图与全屏大图共用过渡名
   * `ocard-preview`，于是"打开"读起来是**同一张图长大了**，
   * 而不是网格消失、另一个界面出现（§7 空间一致性）。
   */
  const openPreview = useCallback((assetId: string, fromGroup = false) => {
    withViewTransition(() => {
      setPreviewId(assetId);
      setPreviewFromGroup(fromGroup);
    });
  }, []);

  /**
   * 关闭全屏预览：大图缩回它所在的那一格，并把键盘光标**留在你最后看的那张**上。
   *
   * 后半句才是导航上的正事：翻了十几张再退出来，光标还停在进去之前那一格
   * 等于把人扔回原点。光标跟过来之后 VirtualGrid 会把它滚进可视区，
   * 缩回去的目标格也因此一定在视野里。
   */
  const closePreview = useCallback(() => {
    withViewTransition(() => {
      /*
       * Esc 只退一层。大图从组层进来的就退回组层（层级：网格 → 组层 → 大图），
       * 并把组层光标挪到你最后看的那张——退回去以后接着从这里挑，
       * 而不是回到进大图之前的那一格。
       * 组在预览期间被清空（整组分类/删除走光了）时没有可退的层，
       * 只能连组层一起收起，退回网格。
       */
      const backToGroup = previewFromGroup && openGroupItems.length > 0;
      if (backToGroup) {
        if (previewId && openGroupItems.some((i) => i.id === previewId)) {
          setGroupCursorId(previewId);
        }
      } else {
        if (previewFromGroup) setOpenGroup(null);
        if (previewId && assetIds.includes(previewId)) {
          setSelection((prev) => ({ ...prev, cursor: previewId, anchor: previewId }));
        }
      }
      setPreviewId(null);
      setPreviewFromGroup(false);
    });
  }, [previewId, assetIds, previewFromGroup, openGroupItems]);

  /* 组全屏层没有共用实体，进场交给 CSS 关键帧（缩放 + 淡入）更好看；
     退场没有挂载动画可用，才需要视图过渡兜住。 */
  const openGroupOverlay = useCallback((groupId: string) => {
    const entry = entriesRef.current.find(
      (e) => e.kind === "group" && e.groupId === groupId,
    );
    setOpenGroup(groupId);
    // 组层光标默认落在组内首张，方向键从这里开始走
    setGroupCursorId(
      entry && entry.kind === "group" ? (entry.items[0]?.id ?? null) : null,
    );
  }, []);

  const closeGroupOverlay = useCallback(() => {
    withViewTransition(() => setOpenGroup(null));
  }, []);

  /**
   * 盖在选片区上方的浮层：全屏大图与二次确认框。
   *
   * 它们收起时，下面那一层必须把键盘拿回来。用户若是点关闭/取消按钮退出来的，
   * 焦点会随那个按钮一起消失（落到 body），键盘流就此断掉——按 Esc / 方向键
   * 全无反应，还看不出为什么。组层自己按 coveredAbove 收焦点，这里只管主视图那一路。
   *
   * 交回**哪个节点**按视图分叉，见 focusKeyboardHost：从前这里无条件还给 wrap，
   * 于是画廊模式下关掉大图之后方向键与 Esc 全部静默失效（评审 B2）。
   */
  const modalAbove = previewId !== null || confirm !== null;
  const hadModalRef = useRef(false);
  useEffect(() => {
    const had = hadModalRef.current;
    hadModalRef.current = modalAbove;
    if (!had || modalAbove) return;
    if (openGroup === null) focusKeyboardHost();
  }, [modalAbove, openGroup, focusKeyboardHost]);

  /**
   * 组全屏层收起时的焦点还原——与上面那条**对称**的另一半。
   *
   * 少了这一半的实测后果：组层无论按 Esc 还是点关闭按钮退出，
   * `document.activeElement` 都落到 `body`（层节点连同焦点一起卸载了），
   * 回到网格后方向键 / 1–9 / D / Shift+D 全部无响应，必须先用鼠标点一下
   * 网格才能继续——键盘流整条断掉，而且屏上没有任何迹象说明为什么。
   * 关组层不改变 `modalAbove`，所以上面那条 effect 一次都不会触发。
   */
  const hadGroupRef = useRef(false);
  useEffect(() => {
    const had = hadGroupRef.current;
    hadGroupRef.current = openGroup !== null;
    if (!had || openGroup !== null) return;
    // 组层之上还压着大图/确认框时先不抢：等它们收起时由上面那条负责
    if (!modalAbove) focusKeyboardHost();
  }, [openGroup, modalAbove, focusKeyboardHost]);

  /**
   * 组失效兜底：浮层没了，`openGroup` 却还锁着主网格。
   *
   * 组只剩 1 张（`buildGridEntries` 不再把它折成组）、成员被移走、
   * 或筛选把整组排除掉时，`openGroupItems` 变空 → 浮层卸载，
   * 但 `openGroup` 仍非空 → 网格的键盘处理器在第一行就 `return`，
   * **键盘彻底失效且屏上没有任何迹象**。必须原子地退回网格并说明原因。
   */
  /**
   * 组条目在网格里的下标。组整体消失（被筛掉）时用它把光标落回原来的位置附近。
   * 只在「还量得到」时更新：组一旦不见了，保住的就是最后一次有效的位置。
   */
  const openGroupEntryIndexRef = useRef(-1);
  useEffect(() => {
    if (openGroup === null) return;
    const at = entries.findIndex(
      (e) => e.kind === "group" && e.groupId === openGroup,
    );
    if (at >= 0) openGroupEntryIndexRef.current = at;
  }, [entries, openGroup]);

  useEffect(() => {
    if (openGroup === null || openGroupItems.length > 0) return;
    setOpenGroup(null);
    setGroupCursorId(null);
    /*
     * C2：组条目没了，`selection` 里那个合成组 id 却还留着。
     *
     * 实测路径：两张的连拍组打开后，直接用快捷键移走一张。`removedEntryIds`
     * 判定「组没有整体消失」（当时另一张还在组里），applyBulk 于是不推光标；
     * 下一帧组缩成单件、合成条目蒸发，选区里就剩一个指向虚无的 id。
     * 再打一次标，`resolveEntryIds` 解出空集，被闸门以「没有选中任何素材」
     * 拒掉——用户刚从组里退出来，只会觉得键盘忽然失灵。
     * 落点优先取「组缩成的那张幸存单件」（它就顶在组原来的位置上），
     * 整组被筛掉时退而落到组原来的下标附近。
     */
    const ents = entriesRef.current;
    const ghostId = `${GROUP_ID_PREFIX}${openGroup}`;
    setSelection((prev) => {
      if (prev.cursor !== ghostId && !prev.selected.includes(ghostId)) return prev;
      const survivor = ents.find(
        (e) => e.kind === "asset" && e.asset.groupId === openGroup,
      );
      const nearby =
        ents[
          Math.min(Math.max(openGroupEntryIndexRef.current, 0), ents.length - 1)
        ];
      const landing = survivor?.id ?? nearby?.id ?? null;
      const swap = (id: string | null) => (id === ghostId ? landing : id);
      return {
        cursor: swap(prev.cursor),
        anchor: swap(prev.anchor),
        // 选区里的幽灵 id 换成幸存单件；连它都没有就直接摘掉
        selected: prev.selected.flatMap((id) =>
          id === ghostId ? (survivor ? [survivor.id] : []) : [id],
        ),
      };
    });
    notifyRef.current(
      "warning",
      "sorting-group-gone",
      "刚才展开的连拍组已不存在（成员被移走、只剩一张，或被当前筛选排除），已退回网格。" +
        "键盘光标仍在网格里，可以继续。",
    );
  }, [openGroup, openGroupItems.length]);

  /**
   * 首批素材到位时把光标落在第一项。
   *
   * 键盘优先是本屏的默认路径，可此前刚进屏（还没点过任何格子）时
   * `selection.cursor` 是 null，`actionTargets` 返回空数组——空格 / 1–9 /
   * P / D 四类键**全部静默无反应**，用户分不清是没聚焦、没选中还是坏了。
   * 选片工具（Photo Mechanic / Lightroom / Finder）一律在列表载入后就把
   * 焦点放在首项，这里照做。只落 cursor 不落 selected：下一次打标默认
   * 只作用于光标格，与既有的「无选区时按光标办事」口径一致。
   */
  useEffect(() => {
    const first = entries[0];
    if (!first) return;
    setSelection((prev) =>
      prev.cursor === null ? { ...prev, cursor: first.id, anchor: first.id } : prev,
    );
  }, [entries]);

  /* ---------------- 数据加载 ---------------- */

  // 切项目把旧项目的资产/选择/预览/待删标记全部清零(codex 评审 P1):
  // 侧栏切项目页面不再卸载,旧相对路径 + 新 projectId 组合起来
  // 可能移动/删除新项目里的同名文件。
  //
  // 注意:清零只挡得住**同步**那一路。上一轮把这条注释写成「已修」,
  // 实际 refreshLoadedAssets / loadMore / moveAssets 里 await 之后的 setState
  // 全都没有守卫,旧项目的响应照样会落进新项目的网格——所以这里同时把
  // epoch 推进一格,那些异步路径回来后都要对账(见 epochRef 的说明)。
  useEffect(() => {
    epochRef.current += 1;
    setAssets([]);
    setTotal(0);
    setSelection(emptySelection);
    setPreviewId(null);
    setPreviewFromGroup(false);
    setOpenGroup(null);
    setGroupCursorId(null);
    setGalleryCursorId(null);
    setCommit(null);
    setJudgeFilter("all");
    setMarkedOnly(false);
    setLastMove(null);
    dispatchDelete({ type: "clear" });
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const [page, cats, status] = await Promise.all([
          api.listPendingAssets(projectId, 0, PAGE_SIZE),
          api.listCategories(projectId),
          api.indexingStatus(projectId),
        ]);
        if (cancelled) return;
        setAssets(page.items);
        setTotal(page.total);
        setCategories(cats);
        setIndexing(status);
      } catch (err) {
        if (cancelled) return;
        // 读不到就说读不到：把失败渲染成空目录会让人以为素材没了
        setLoadError(err instanceof Error ? err.message : String(err));
        setAssets([]);
        setTotal(0);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadToken]);


  /**
   * 重拉已经加载出来的那些素材（索引完成后让缩略图出图）。
   * 按 PAGE_SIZE 分块取：一次要更多会被后端 200 的页上限截断，
   * 那样反而会把用户已加载的素材悄悄弄丢。
   */
  const refreshLoadedAssets = useCallback(async () => {
    if (!projectId) return;
    const want = Math.max(loadedCountRef.current, PAGE_SIZE);
    lastRefreshRef.current = Date.now();
    /*
     * 两道守卫，缺一不可：
     * epoch —— 切项目后旧项目的分页结果一律作废（否则旧素材灌进新网格，
     *          接着按数字键移动的就是另一个项目里的同名文件）；
     * seq   —— 同一项目内两次重拉并发时只认最后发出的那次，
     *          否则先发的慢响应会把新的整批覆盖回旧状态。
     */
    const epoch = epochRef.current;
    const seq = (refreshSeqRef.current += 1);
    const stale = () => epochRef.current !== epoch || refreshSeqRef.current !== seq;
    try {
      const collected: SortingAsset[] = [];
      let latestTotal = 0;
      while (collected.length < want) {
        const page = await api.listPendingAssets(
          projectId,
          collected.length,
          PAGE_SIZE,
        );
        if (stale()) return;
        latestTotal = page.total;
        collected.push(...page.items);
        if (page.items.length < PAGE_SIZE) break;
      }
      if (stale()) return;
      setAssets(collected);
      setTotal(latestTotal);
    } catch (err) {
      // 过期请求的失败不该打扰用户：那批数据本来就已经作废了
      if (stale()) return;
      // 保留当前列表，但绝不静默：用户得知道看到的可能是旧状态
      notifyRef.current(
        "warning",
        "sorting-refresh-failed",
        `刷新素材列表失败：${
          err instanceof Error ? err.message : String(err)
        }。当前显示的可能不是最新状态，可稍后重试或重新进入本屏。`,
      );
    }
  }, [projectId]);

  // 分析作业转 done 后重拉当前页，让 judgement 角标出来
  // 按 jobId 判定「这一轮分析刚结束」——revision 是 per-job 的，
  // 两轮事件数相同时用它当全局令牌会让第二轮永不刷新
  const analyzeDoneId = analyzeJob?.state === "done" ? analyzeJob.id : null;
  const refreshedAnalyzeIdRef = useRef<string | null>(null);
  /** 结果与 analyzeDoneId 同批到达；走 ref 传进 effect，免得把整个 job 塞进依赖 */
  const analyzeResultRef = useRef<AnalysisResult | undefined>(undefined);
  analyzeResultRef.current =
    analyzeJob?.state === "done" ? analyzeJob.result : undefined;

  useEffect(() => {
    if (!analyzeDoneId) return;
    if (refreshedAnalyzeIdRef.current === analyzeDoneId) return;
    refreshedAnalyzeIdRef.current = analyzeDoneId;

    /*
     * 视频首帧图被跳过 = 转码引擎不可用的降级，格子会一直停在「索引中」占位。
     * 不说的话，用户只会以为分析没跑完或者软件坏了。跳过必须可见。
     */
    const skipped = analyzeResultRef.current?.videoThumbsSkipped ?? 0;
    if (skipped > 0) {
      notifyRef.current(
        "warning",
        "analysis-video-thumbs-skipped",
        `${skipped} 个视频没能抽出首帧图（转码引擎不可用），这些格子会继续显示占位。` +
          `分析结论本身不受影响；装好转码引擎后重跑分析即可补上。`,
      );
    }

    void refreshLoadedAssets();
  }, [analyzeDoneId, refreshLoadedAssets]);

  // 「待修 → 已修」流转提示（PRD §5.4）：只提示，删除仍走既有回收站流程
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void (async () => {
      try {
        const hints = await api.curatedFlowHints(projectId);
        if (!cancelled) setFlowHints(hints);
      } catch {
        // 提示类信息拿不到不阻断分类；下次进屏会再试
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const loadMore = useCallback(async () => {
    if (!projectId || loading || assets.length >= total) return;
    setLoading(true);
    setPageError(null);
    // 与 refreshLoadedAssets 同一条理由：翻页响应回来时项目可能已经换了，
    // 直接 append 会把旧项目的素材接到新项目的列表尾巴上
    const epoch = epochRef.current;
    try {
      const page = await api.listPendingAssets(projectId, assets.length, PAGE_SIZE);
      if (epochRef.current !== epoch) return;
      setAssets((prev) => [...prev, ...page.items]);
      setTotal(page.total);
    } catch (err) {
      if (epochRef.current !== epoch) return;
      // 翻页失败不能吞：已加载的保留，错误显式可见并可重试
      setPageError(err instanceof Error ? err.message : String(err));
    } finally {
      // loading 一定要放掉：卡在 true 会让「加载更多」永久禁用
      setLoading(false);
    }
  }, [projectId, loading, assets.length, total]);

  /* ---------------- 通知 ---------------- */

  const notify = useCallback(
    (level: "warning" | "error", code: string, message: string) => {
      dispatch({
        type: "noticeReceived",
        notice: { level, code, message, occurredAt: new Date().toISOString() },
      });
    },
    [dispatch],
  );

  notifyRef.current = notify;
  deliveryWorkingRef.current = deliveryWorking;

  /**
   * 索引进度订阅。
   *
   * 两个此前踩过的坑，这里都必须守住：
   * ① 判定不能跨轮单调过滤。后端每轮重启索引都会把 indexed 归 0，
   *    用「组件级 lastIndexed 永不重置 + indexed <= last 就丢弃」会导致
   *    第一轮之后的所有事件被全部挡掉，缩略图永不出图。改为与**上一条事件**
   *    比较：增长 / 归零重启 / running 由 true→false，任一即触发刷新。
   * ② 必须等 sub.ready。list_pending_assets 会同步 spawn 索引线程，
   *    小库存可能在 listen 注册完成前就索引完，唯一的收尾事件就此丢失。
   *    所以 ready 之后再拉一次 indexingStatus 兜底对账。
   */
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    lastEventRef.current = null;
    reconciledRef.current = false;

    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      const elapsed = Date.now() - lastRefreshRef.current;
      timer = setTimeout(
        () => void refreshLoadedAssets(),
        Math.max(0, INDEX_REFRESH_MIN_MS - elapsed),
      );
    };

    const sub = api.subscribeIndexProgress(
      (event) => {
        if (cancelled || event.projectId !== projectId) return;
        setIndexing({
          indexed: event.indexed,
          total: event.total,
          running: event.running,
          failed: event.failed,
          missing: event.missing,
          round: event.round,
        });

        const prev = lastEventRef.current;
        const roundChanged = prev !== null && event.round !== prev.round;
        lastEventRef.current = {
          indexed: event.indexed,
          running: event.running,
          round: event.round,
        };
        // 新一轮开始：收尾对账重新武装，否则上一轮烧掉的 ref 会让这一轮永不补刷
        if (roundChanged) reconciledRef.current = false;
        if (!prev) {
          scheduleRefresh();
          return;
        }
        const grew = event.indexed > prev.indexed;
        const finished = prev.running && !event.running;
        if (grew || roundChanged || finished) scheduleRefresh();
      },
      (err) => {
        if (cancelled) return;
        notify(
          "warning",
          "index-listen-failed",
          `索引进度监听未能建立：${
            err instanceof Error ? err.message : String(err)
          }。缩略图仍在后台生成，但界面不会自动刷新。`,
        );
      },
    );

    // 监听注册完成后兜底对账：注册期间可能已经把索引跑完了
    void sub.ready
      .catch(() => undefined)
      .then(async () => {
        if (cancelled) return;
        try {
          const status = await api.indexingStatus(projectId);
          if (cancelled) return;
          setIndexing(status);
          const prev = lastEventRef.current;
          if (prev && prev.round !== status.round) reconciledRef.current = false;
          lastEventRef.current = {
            indexed: status.indexed,
            running: status.running,
            round: status.round,
          };
          // 注册期间索引可能已经整轮跑完、收尾事件就此丢失，
          // 所以这里不能只更新进度条，必须主动补一次页刷新
          if (!status.running) scheduleRefresh();
        } catch (err) {
          if (cancelled) return;
          notify(
            "warning",
            "index-status-failed",
            `读取索引状态失败：${
              err instanceof Error ? err.message : String(err)
            }。缩略图可能已生成但界面未刷新，可重新进入本屏。`,
          );
        }
      });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      sub.dispose();
    };
  }, [projectId, refreshLoadedAssets, notify]);

  /**
   * 收尾对账：索引已停、但当前页仍有格子没有缩略图 → 补拉一次。
   * 单次触发（reconciledRef），既救回「收尾事件丢失」的场景，又不会自我循环。
   */
  useEffect(() => {
    if (!projectId || loading || reconciledRef.current) return;
    if (!indexing || indexing.running) return;
    // total === 0 表示索引 map 里还没有这个项目的条目——索引根本没开始。
    // 此时若烧掉 reconciledRef，真正跑完那一轮就再也补不回来了。
    if (indexing.total <= 0) return;
    // 判据必须是 thumbReady：thumbnail 现在是 URL，用存在性判断会让本对账静默失效
    if (!assetsRef.current.some((a) => !a.thumbReady)) return;
    reconciledRef.current = true;
    void refreshLoadedAssets();
  }, [projectId, loading, indexing, refreshLoadedAssets]);

  /**
   * 批量操作的统一收尾：成功的移出列表，失败的**如实留下并恢复选中态**，
   * 失败原因经通知中心呈现——绝不静默。
   */
  const applyBulk = useCallback(
    (result: BulkResult, verb: string) => {
      /*
       * 整批移出走视图过渡：被移走的格子溶出、剩下的格子补位，
       * 而不是"啪"地换一批。网格本身没有过渡名，因此走的是根快照的
       * 交叉淡入淡出——背景像素完全一致，看到的只有变动的那部分。
       * 不支持视图过渡时，这就是原来的同步更新，一步不差。
       */
      withViewTransition(() => {
        if (result.succeeded.length > 0) {
          const done = new Set(result.succeeded);
          setAssets((prev) => prev.filter((a) => !done.has(a.id)));
          setTotal((t) => Math.max(0, t - result.succeeded.length));
          /*
           * 评审 E2：移走的素材必须**同时离开待删清单**。
           *
           * 漏掉这一步的实测后果：按 D 标删 A、再按 1 把 A 分类走。A 已经不在
           * 待分类夹里，却仍算在屏底「已标记 N 个待删除」里——「只看已标删」
           * 筛出来是空的（A 已不在网格），Shift+D 提交时 trashAssets 对 A
           * 必然失败，而失败项按设计**永久留在清单里**，用户除了「取消标记」
           * 清空全部之外无法单独摘掉它。`pruneSelection` 早就替选区做了这件事，
           * 待删清单这条状态机一直被漏着。
           * 用 prune 而不是 unmark：提交在飞时 unmark 会被 working 态挡掉，
           * 而「文件已经不在那儿了」不是用户改主意，不该被挡。
           */
          dispatchDelete({ type: "prune", assetIds: result.succeeded });
        }
        if (result.failed.length > 0) {
          // 失败项重新选中，方便直接重试
          setSelection({
            cursor: result.failed[0].assetId,
            anchor: result.failed[0].assetId,
            selected: result.failed.map((f) => f.assetId),
          });
          notify(
            "error",
            "sorting-bulk-failed",
            `${result.failed.length} 个文件${verb}失败：${result.failed
              .slice(0, 3)
              .map((f) => f.message)
              .join("；")}${result.failed.length > 3 ? " 等" : ""}`,
          );
        } else {
          /*
           * 光标自动前进(评审 3.1):被移走的块的下一个条目接住焦点,
           * 「按 1 → 自动站到下一张」的循环不再断在「光标归零」上。
           * 选区清空:下一次打标默认只作用于光标格,与 PM/LR 的心智一致。
           */
          const ents = entriesRef.current;
          const goneEntries = removedEntryIds(ents, result.succeeded);
          const next = nextCursorAfterRemoval(
            ents.map((e) => e.id),
            goneEntries,
          );
          setSelection((prev) =>
            next
              ? { cursor: next, anchor: next, selected: [] }
              : pruneSelection(prev, result.succeeded),
          );
        }
      });
    },
    [notify],
  );

  const refreshCategories = useCallback(async () => {
    if (!projectId) return;
    try {
      setCategories(await api.listCategories(projectId));
    } catch (err) {
      // 计数静默陈旧会让人以为分类没生效，必须说出来
      notifyRef.current(
        "warning",
        "categories-refresh-failed",
        `刷新分类计数失败：${
          err instanceof Error ? err.message : String(err)
        }。分类操作本身已完成，但顶部计数可能不是最新的。`,
      );
    }
  }, [projectId]);

  /* ---------------- 动作 ---------------- */

  /**
   * 「这一下能不能被接受」——**纯查询，不产生副作用**。
   *
   * 大图/画廊的打标是「先把光标推到下一张，再把当前张发出去」，所以它们
   * 必须能在推光标**之前**问一句「这一下会被接受吗」。答案为否时既不推光标
   * 也不发请求，改为亮出原因。这就是 B1 那类「界面伪装成操作成功」的根治点。
   */
  /** 待删清单正在提交进回收站（trashAssets 在飞）：期间不许改标记 */
  const committing = pendingDelete.phase === "working";

  const canAct = useCallback(
    (kind: SortingActionKind, targets: string[], markedCount?: number) =>
      gateAction(kind, {
        hasProject: projectId !== null,
        busy: busyRef.current,
        deliveryWorking,
        committing,
        targetCount: targets.length,
        markedCount,
      }),
    [projectId, deliveryWorking, committing],
  );

  /** 被拒必须看得见：进通知中心 + 弹 toast（同 code 会自动折叠，连打不会刷屏） */
  const announceRejected = useCallback(
    (outcome: ActionOutcome) => {
      if (outcome.accepted) return;
      notifyRef.current("warning", outcome.code, outcome.reason);
    },
    [],
  );

  // runCurate 定义在下面，用 ref 打通引用（两者都是稳定回调）
  const runCurateRef = useRef<
    (targetsOverride?: string[]) => Promise<ActionOutcome>
  >(async () => ({ accepted: true }));

  const runAssign = useCallback(
    async (
      categoryId: string,
      targetsOverride?: string[],
    ): Promise<ActionOutcome> => {
      // override 是预览/组浮层传来的**已解析** assetId(评审 3.2)
      const targets =
        targetsOverride ?? resolveEntryIds(entries, actionTargets(selection));
      // 精选永远是复制语义，move 到 curated 会让素材卡在没有流程的位置
      const isCurated =
        categories.find((c) => c.id === categoryId)?.kind === "curated";
      const gate = canAct(isCurated ? "curate" : "assign", targets);
      if (!gate.accepted) {
        // 曾经这里是一句光秃秃的 return：调用方已经把光标推走了,
        // 用户于是相信刚才那张分好了类——被拒必须说出来(零静默)
        announceRejected(gate);
        return gate;
      }
      if (isCurated) return runCurateRef.current(targetsOverride);
      if (!projectId) return gate;
      busyRef.current = true;
      setBusy(true);
      const epoch = epochRef.current;
      try {
        const result = await api.moveAssets(projectId, targets, categoryId);
        // 切项目后回来的结果一律作废：否则旧项目的成功列表会去裁剪新项目的网格
        if (epochRef.current !== epoch) return gate;
        applyBulk(result, "移动");
        // 撤销窗口(评审 3.5):只对真正移走的部分开;移入待分类的撤销没有意义
        const cat = categories.find((c) => c.id === categoryId);
        if (result.succeeded.length > 0 && cat && cat.kind !== "inbox") {
          setLastMove({ assetIds: result.succeeded, categoryName: cat.name });
        }
        void refreshCategories();
      } catch (err) {
        if (epochRef.current !== epoch) return gate;
        notify(
          "error",
          "sorting-move-failed",
          `移动失败：${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
      return gate;
    },
    [
      projectId,
      selection,
      canAct,
      announceRejected,
      entries,
      categories,
      applyBulk,
      refreshCategories,
      notify,
    ],
  );

  /** 撤销上一次批量移动:反向 move 回「待分类」 */
  const undoLastMove = useCallback(async () => {
    const inbox = categories.find((c) => c.kind === "inbox");
    if (!projectId || !lastMove || undoing || !inbox) return;
    /*
     * 撤销同样是在动文件，打包期间一律不许下发（此前这条路是敞开的：
     * 分类被锁着，撤销却能把同一批文件挪回去，正好绕过互斥）。
     * 按钮已经禁用，这里是第二道且必须**说出来**。
     */
    if (deliveryWorking) {
      notifyRef.current(
        "warning",
        "sorting-undo-blocked",
        "交付打包进行中，暂不能撤销移动（撤销也是在动同一批文件）。撤销入口会保留到打包结束。",
      );
      return;
    }
    setUndoing(true);
    const epoch = epochRef.current;
    try {
      const result = await api.moveAssets(projectId, lastMove.assetIds, inbox.id);
      // 切项目后回来的撤销结果不能拿去动新项目的界面
      if (epochRef.current !== epoch) return;
      if (result.failed.length > 0) {
        notify(
          "error",
          "sorting-undo-failed",
          `${result.failed.length} 个文件撤销失败：${result.failed[0].message}`,
        );
      }
      setLastMove(null);
      await refreshLoadedAssets();
      void refreshCategories();
    } catch (err) {
      if (epochRef.current !== epoch) return;
      notify(
        "error",
        "sorting-undo-failed",
        `撤销失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setUndoing(false);
    }
  }, [
    projectId,
    lastMove,
    undoing,
    deliveryWorking,
    categories,
    refreshLoadedAssets,
    refreshCategories,
    notify,
  ]);

  const runCurate = useCallback(
    async (targetsOverride?: string[]): Promise<ActionOutcome> => {
      const actedEntries = targetsOverride ?? actionTargets(selection);
      const targets = targetsOverride ?? resolveEntryIds(entries, actedEntries);
      const gate = canAct("curate", targets);
      if (!gate.accepted) {
        announceRejected(gate);
        return gate;
      }
      if (!projectId) return gate;
      busyRef.current = true;
      setBusy(true);
      const epoch = epochRef.current;
      try {
        const result = await api.curateAssets(projectId, targets);
        if (epochRef.current !== epoch) return gate;
        // 精选是「复制一份进待修」，原件留在待分类，所以格子不会离开网格；
        // 正因为不会离开，才必须在格子上给一次"收到了"的回弹（§13 causality）
        if (result.succeeded.length > 0) {
          pulseCommit(actedEntries);
          // 常驻 ✓精选 角标(评审 3.3):动画播完之后仍然认得出哪些精选过
          rememberCurated(result.succeeded);
        }
        if (result.failed.length > 0) {
          notify(
            "error",
            "sorting-curate-failed",
            `${result.failed.length} 个文件加入精选失败：${result.failed[0].message}`,
          );
        }
        void refreshCategories();
      } catch (err) {
        if (epochRef.current !== epoch) return gate;
        notify(
          "error",
          "sorting-curate-failed",
          `加入精选失败：${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
      return gate;
    },
    [
      projectId,
      selection,
      canAct,
      announceRejected,
      entries,
      refreshCategories,
      notify,
      pulseCommit,
      rememberCurated,
    ],
  );

  runCurateRef.current = runCurate;

  /**
   * 待删标记的**唯一**入口，三种语义显式分开。
   *
   * 分开的理由是一次实测事故：`U` 走的是 toggle，于是在组层 / 画廊 / 大图里
   * 对一张**未标记**的素材按 U，待删条从「无」变成「已标记 1 个待删除」，
   * 而且无声。用户按 U 的动机恰恰是「我按错了，撤回」，结果反而把它标进了
   * 待删清单，画廊/大图还自动前进，他根本看不到刚才那张被标了。
   *
   * - `toggle`：D 键。目标全已标记 → 取消，否则标记。
   * - `unmark`：U 键。**只取消**，永不新增标记；目标里一张都没标记过时，
   *   不是默默什么都不做，而是明说「本来就没标删」。
   * - `mark`  ：批量工具（如「保留推荐，其余标删」）。只标记，不反悔。
   */
  const changeMark = useCallback(
    (ids: string[], mode: "toggle" | "unmark" | "mark"): ActionOutcome => {
      const markedCount = ids.filter((id) => markedSet.has(id)).length;
      // 先算出这一下**实际**是标还是取消，再据此过闸门：
      // 否则「全已标记时按 D」（其实是取消）会被当成新增标记而在打包期被拒
      const effective =
        mode === "toggle"
          ? ids.length > 0 && markedCount === ids.length
            ? "unmark"
            : "mark"
          : mode;
      const gate = canAct(effective, ids, markedCount);
      if (!gate.accepted) {
        announceRejected(gate);
        return gate;
      }
      dispatchDelete({
        type: effective,
        // 取消时只下发真正标记过的那些，清单语义更干净
        assetIds: effective === "unmark" ? ids.filter((id) => markedSet.has(id)) : ids,
      });
      return gate;
    },
    [markedSet, canAct, announceRejected],
  );

  const toggleMark = useCallback(
    (ids: string[]) => changeMark(ids, "toggle"),
    [changeMark],
  );
  const unmarkOnly = useCallback(
    (ids: string[]) => changeMark(ids, "unmark"),
    [changeMark],
  );
  const markOnly = useCallback(
    (ids: string[]) => changeMark(ids, "mark"),
    [changeMark],
  );

  /* ---------------- 预览内打标(评审 3.2):作用于眼前这张,操作后自动前进 ---------------- */

  /* 自动前进也走 previewScope:从组层进来的大图,「下一张」是组内的下一张 */
  const previewAsset = previewIndex >= 0 ? (previewScope[previewIndex] ?? null) : null;

  /*
   * 前进的**唯一**前提：这一下真的被受理了。
   *
   * 从前是无条件前进：打包锁住 / 上一批还没落定时底层直接 return，
   * 大图却已经翻到下一张——用户看见的是一次成功的分类，实际什么都没发生。
   * 现在一律先问 canAct，被拒就原地不动并亮出原因。
   */
  const previewAssign = useCallback(
    (categoryId: string) => {
      if (!previewAsset) return;
      const gate = canAct("assign", [previewAsset.id]);
      if (!gate.accepted) {
        announceRejected(gate);
        return;
      }
      // 先站到下一张再移走当前张:大图不闪断,失败时素材还在、toast 会说话
      const nextId =
        previewScope[previewIndex + 1]?.id ??
        previewScope[previewIndex - 1]?.id ??
        null;
      setPreviewId(nextId);
      void runAssign(categoryId, [previewAsset.id]);
    },
    [
      previewAsset,
      previewScope,
      previewIndex,
      runAssign,
      canAct,
      announceRejected,
    ],
  );

  const previewCurate = useCallback(() => {
    if (!previewAsset) return;
    const gate = canAct("curate", [previewAsset.id]);
    if (!gate.accepted) {
      announceRejected(gate);
      return;
    }
    void runCurate([previewAsset.id]);
    const nextId = previewScope[previewIndex + 1]?.id ?? null;
    if (nextId) setPreviewId(nextId);
  }, [
    previewAsset,
    previewScope,
    previewIndex,
    runCurate,
    canAct,
    announceRejected,
  ]);

  const previewToggleDelete = useCallback(() => {
    if (!previewAsset) return;
    // changeMark 被拒时自己已经发过通知，这里只负责「不前进」
    if (!toggleMark([previewAsset.id]).accepted) return;
    const nextId = previewScope[previewIndex + 1]?.id ?? null;
    if (nextId) setPreviewId(nextId);
  }, [previewAsset, previewScope, previewIndex, toggleMark]);

  /** U：只撤回标删。未标记时不静默、也不前进——用户按 U 是想撤回，不是想标 */
  const previewUnmarkDelete = useCallback(() => {
    if (!previewAsset) return;
    if (!unmarkOnly([previewAsset.id]).accepted) return;
    const nextId = previewScope[previewIndex + 1]?.id ?? null;
    if (nextId) setPreviewId(nextId);
  }, [previewAsset, previewScope, previewIndex, unmarkOnly]);

  /* ---------------- 画廊模式(接线):聚焦项在 assetId 空间里走 ---------------- */

  /**
   * 画廊的聚焦项。
   *
   * 网格的 `selection.cursor` 是**条目 id**（组条目是合成 id），画廊里
   * 连拍组逐张平铺、没有组条目，所以这里单独持一个 assetId 光标。
   * 素材被移走后旧 id 会失效，故每次渲染都按当前列表校验一次，
   * 失效即退回首项——绝不让打标动作落到一个已经不在列表里的 id 上。
   */
  const galleryCursor =
    galleryCursorId && previewAssets.some((a) => a.id === galleryCursorId)
      ? galleryCursorId
      : (previewAssets[0]?.id ?? null);
  const galleryIndex = galleryCursor
    ? previewAssets.findIndex((a) => a.id === galleryCursor)
    : -1;

  /**
   * 画廊的分页口径（评审 D1）。
   *
   * `previewAssets` 是**筛选之后**的摊平列表，而 `total` 数的是全库待分类。
   * 没开筛选时两者同口径，total 就是诚实的总数；一开筛选，库里还没加载的
   * 那 1040 张能命中多少完全未知——此时把 total 传下去，位置栏就会写出
   * 「已加载 37 张（共 1240 张）」这种把「库存」说成「筛选结果总数」的谎话。
   * 所以筛选态改传「还有多少张原始素材没加载」，让画廊按未知总量措辞。
   */
  const galleryFiltered = judgeFilter !== "all" || markedOnly;
  const galleryUnloaded = Math.max(0, total - assets.length);

  /**
   * 打标后自动前进到下一张（与全屏预览同一套「看一张→按一键→看下一张」）。
   *
   * `leavesList` 分叉是评审 E1 点名的口径不一致：
   * - 分类 / 其他 会把当前这张**移出列表**，末尾时它马上就要消失，
   *   退回上一张是唯一可站的位置；
   * - 精选 / 标删 / 取消标删**都不移出列表**。末尾时退回上一张的实测后果是：
   *   在最后一张按 D 标删，光标静默退到上一张（刚处理过的那张），再按一次 D
   *   标的就是那一张——快速收尾时会在最后两张之间来回反转标记，全程没有提示。
   *   大图那边（previewToggleDelete / previewCurate）用的是「没有下一张就
   *   原地不动」，两条路径必须同一口径，而不一致的那条恰好会误伤。
   */
  const advanceGalleryCursor = useCallback(
    (leavesList = false) => {
      if (galleryIndex < 0) return;
      const next = previewAssets[galleryIndex + 1]?.id ?? null;
      if (next) {
        setGalleryCursorId(next);
        return;
      }
      // 末尾：只有"当前这张要消失"时才退一张，否则原地不动
      if (leavesList) setGalleryCursorId(previewAssets[galleryIndex - 1]?.id ?? null);
    },
    [galleryIndex, previewAssets],
  );

  /**
   * 画廊里「一个可作用的素材都没有」（筛到空集）时的统一回执。
   *
   * 四个 gallery* 回调从前一律是 `if (!galleryCursor) return;`——又一处
   * 按了没反应，而网格里同一情形会明确说「没有选中任何素材，落空了」。
   * 走同一个闸门拿同一套措辞，两条路径口径一致。
   */
  const announceNoGalleryTarget = useCallback(
    (kind: SortingActionKind) => announceRejected(canAct(kind, [])),
    [canAct, announceRejected],
  );

  const galleryAssign = useCallback(
    (categoryId: string) => {
      if (!galleryCursor) {
        announceNoGalleryTarget("assign");
        return;
      }
      const gate = canAct("assign", [galleryCursor]);
      if (!gate.accepted) {
        announceRejected(gate);
        return;
      }
      // 分类会把这张移出列表 → 末尾时允许退一张
      advanceGalleryCursor(true);
      void runAssign(categoryId, [galleryCursor]);
    },
    [
      galleryCursor,
      advanceGalleryCursor,
      runAssign,
      canAct,
      announceRejected,
      announceNoGalleryTarget,
    ],
  );

  const galleryCurate = useCallback(() => {
    if (!galleryCursor) {
      announceNoGalleryTarget("curate");
      return;
    }
    const gate = canAct("curate", [galleryCursor]);
    if (!gate.accepted) {
      announceRejected(gate);
      return;
    }
    void runCurate([galleryCursor]);
    advanceGalleryCursor();
  }, [
    galleryCursor,
    advanceGalleryCursor,
    runCurate,
    canAct,
    announceRejected,
    announceNoGalleryTarget,
  ]);

  const galleryToggleDelete = useCallback(() => {
    if (!galleryCursor) {
      announceNoGalleryTarget("mark");
      return;
    }
    if (!toggleMark([galleryCursor]).accepted) return;
    advanceGalleryCursor();
  }, [galleryCursor, advanceGalleryCursor, toggleMark, announceNoGalleryTarget]);

  /** U：画廊里也必须只撤回标删（此前这里与 D 共用 toggle，等于把 U 变成了标删） */
  const galleryUnmarkDelete = useCallback(() => {
    if (!galleryCursor) {
      announceNoGalleryTarget("unmark");
      return;
    }
    if (!unmarkOnly([galleryCursor]).accepted) return;
    advanceGalleryCursor();
  }, [galleryCursor, advanceGalleryCursor, unmarkOnly, announceNoGalleryTarget]);

  const galleryOpenFullscreen = useCallback(() => {
    if (galleryCursor) openPreview(galleryCursor);
    // 空列表里按 Enter 也不许一动不动：说清没有可看的那一张
    else announceNoGalleryTarget("assign");
  }, [galleryCursor, openPreview, announceNoGalleryTarget]);

  const commitDelete = useCallback(async () => {
    /*
     * 评审 A2：第二道防线不许是静默 return。
     *
     * 触发窗口窄但真实：确认框已经打开、用户正要按下红色「移入回收站」的
     * 那一瞬间，交付作业转 running。从前这里只有一句 `return`，而 ConfirmDialog
     * 无条件 `close()`——对话框正常消失，一个**已经二次确认过的破坏性动作
     * 凭空蒸发**：没有 toast、没有通知、没有内联提示。这与同文件
     * `requestDeleteConfirm` 自己立下的标准（前置条件不满足要当面说清）直接矛盾。
     */
    if (!projectId) {
      notifyRef.current(
        "warning",
        "sorting-delete-no-project",
        "还没有选中项目，这次「移入回收站」没有下发。待删标记一个没少。",
      );
      return;
    }
    if (deliveryWorkingRef.current) {
      notifyRef.current(
        "warning",
        "sorting-delete-blocked",
        "刚才那一下没有生效：确认之后、下发之前交付打包开始了，" +
          "为避免同一批文件边打包边被挪走，这次「移入回收站」已被拦下。" +
          "待删标记一个没少，等打包结束再按一次 Shift+D。",
      );
      // 清单还停在 confirming：退回 marked，确认入口才不至于卡住
      dispatchDelete({ type: "cancelConfirm" });
      return;
    }
    dispatchDelete({ type: "commitStarted" });
    const epoch = epochRef.current;
    const marked = pendingDelete.marked;
    /*
     * 切项目后回来的删除结果不能拿去裁剪新项目的网格。
     * 但也不能一走了之：清单此刻停在 "working"，而 `clear` 在 working 态
     * 是空操作——不收尾的话新项目会顶着一份旧项目的待删清单且再也改不动。
     * 所以照样收尾（旧项目的标记随之清空），只是不去动新项目的列表。
     */
    const abandon = () => {
      dispatchDelete({ type: "commitFinished", succeeded: marked, failed: [] });
    };
    try {
      const result = await api.trashAssets(projectId, marked);
      if (epochRef.current !== epoch) return abandon();
      dispatchDelete({
        type: "commitFinished",
        succeeded: result.succeeded,
        failed: result.failed,
      });
      applyBulk(result, "移入回收站");
    } catch (err) {
      if (epochRef.current !== epoch) return abandon();
      dispatchDelete({
        type: "commitFinished",
        succeeded: [],
        failed: pendingDelete.marked.map((assetId) => ({
          assetId,
          message: err instanceof Error ? err.message : String(err),
        })),
      });
      notify(
        "error",
        "sorting-trash-failed",
        `移入回收站失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [projectId, pendingDelete.marked, applyBulk, notify]);

  async function startAnalysis() {
    if (!projectId || analyzing) return;
    try {
      const job = await api.startAnalysis(projectId);
      dispatch({ type: "jobProgress", job });
    } catch (err) {
      // 提交后失败只走 toast,不再内联双报(评审 P2)
      const message = err instanceof Error ? err.message : String(err);
      notify("error", "analysis-start-failed", `分析作业未能启动：${message}`);
    }
  }

  function requestDeleteConfirm() {
    /*
     * 前置条件不满足时**说出来**,而不是默默 return。
     * 走键盘的人（尤其组全屏层里,底部待删清单条被整层盖住）按下 Shift+D
     * 却什么都不发生,分不清是"键没绑上"还是"清单是空的"——
     * 按了没反应在本项目里就是零静默违规。
     */
    if (deliveryWorking) {
      notify(
        "warning",
        "sorting-delete-blocked",
        "交付打包进行中，暂不能移入回收站。待删标记都还在，等打包结束再按 Shift+D 提交。",
      );
      return;
    }
    if (committing) {
      /*
       * 上一批还在飞时再进一次确认流，会把状态机从 working 拽回 confirming，
       * 于是同一批文件被 trashAssets 下发两次（第二次必然整批失败，而失败项
       * 按设计永久留在清单里）。拦下来，并且说清为什么。
       */
      notify(
        "warning",
        "sorting-delete-committing",
        "上一批正在提交进回收站，等它结束再按。这一下没有重复下发（重复提交会让同一批文件整批报失败）。",
      );
      return;
    }
    if (pendingDelete.marked.length === 0) {
      notify(
        "warning",
        "sorting-delete-empty",
        "待删清单是空的，没有可提交的内容。先按 D 标记要删的素材，再按 Shift+D 提交确认。",
      );
      return;
    }
    dispatchDelete({ type: "requestConfirm" });
    // 确认前要能看见删的是**哪些**(评审 3.9),不是只有一个数字
    const byId = new Map(assetsRef.current.map((a) => [a.id, a.fileName]));
    const names = pendingDelete.marked
      .slice(0, 8)
      .map((id) => byId.get(id) ?? id.split("/").pop() ?? id);
    const listing =
      names.join("、") +
      (pendingDelete.marked.length > 8
        ? ` 等 ${pendingDelete.marked.length} 个`
        : "");
    setConfirm({
      title: `把 ${pendingDelete.marked.length} 个文件移入回收站？`,
      message: `${listing}。文件会移入项目内 .ocard/trash，可以随时恢复；此操作不会物理删除任何文件。`,
      confirmLabel: "移入回收站",
      /* 组全屏层 z-index 55 压过普通 .overlay(50):从组层里按 Shift+D 时,
         确认框必须抬到 --elevated(90),否则它会被组层盖住、点不到也看不见 */
      elevated: openGroup !== null,
      onConfirm: () => void commitDelete(),
    });
  }

  /* ---------------- 键盘流 ---------------- */

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // 预览打开时键盘由 Lightbox 全权接管(评审 3.2):这里不再处理,
      // 否则同一击键会两处生效——网格里作用的还是进预览前的旧选中。
      // 组全屏层同理:它有自己的光标与自己的键盘流,不能让同一击键
      // 在背后的网格里也作用一遍(网格光标停在组格上,展开成整组)
      if (previewId !== null || openGroup !== null) return;
      /*
       * 焦点落在网格里的按钮（如组格上的「展开」）或任何输入控件上时，
       * 那一击键属于它自己。抢过来的实测后果：Tab 到按钮上按回车，
       * 我们把它解释成「预览」并 preventDefault，按钮根本不执行。
       */
      if (shouldYieldShortcut(event.target, event.key)) return;
      const action = resolveShortcut(
        {
          key: event.key,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
        },
        categories,
      );
      if (!action) return;
      event.preventDefault();

      switch (action.type) {
        case "move": {
          setSelection((prev) =>
            moveCursor(assetIds, prev, action.key, columns, action.extend),
          );
          // 光标逼近已加载的尾部就续拉(评审 3.7):键盘流不必停下来点按钮
          if (
            cursorIndex >= assetIds.length - columns * 2 &&
            assets.length < total &&
            !loading
          ) {
            void loadMore();
          }
          return;
        }
        case "toggle": {
          if (selection.cursor) {
            setSelection((prev) => toggleSelection(prev, prev.cursor as string));
          }
          return;
        }
        case "selectAll":
          setSelection((prev) => selectAll(assetIds, prev));
          return;
        case "clearSelection":
          // Esc 清空选区(评审 3.8),光标留在原地
          setSelection((prev) => ({ ...prev, anchor: prev.cursor, selected: [] }));
          return;
        case "preview": {
          // 空格/Enter = 预览。光标停在折叠组上时先铺开整组(评审 3.4),
          // 不直接跳进第一张——连拍组要先看全,才谈得上挑
          const entry = entries.find((e) => e.id === selection.cursor);
          if (entry?.kind === "group") {
            openGroupOverlay(entry.groupId);
            return;
          }
          const targets = resolveEntryIds(entries, actionTargets(selection));
          if (targets.length > 0) openPreview(targets[0]);
          return;
        }
        case "closePreview":
          closePreview();
          return;
        case "assign":
          void runAssign(action.categoryId);
          return;
        case "other": {
          const other = categories.find((c) => c.kind === "other");
          if (other) void runAssign(other.id);
          return;
        }
        case "curate":
          void runCurate();
          return;
        case "markDelete":
          // 打包期间不许新增待删标记：后端 OpsMutex 也会拒，但 UI 要先行拦下并说明
          toggleMark(resolveEntryIds(entries, actionTargets(selection)));
          return;
        case "unmarkDelete":
          // U 只撤回；一张都没标过时由 changeMark 明说，不再默默无事发生
          unmarkOnly(resolveEntryIds(entries, actionTargets(selection)));
          return;
        case "confirmDelete":
          // Shift+D:标完直接进入确认,不必伸手摸鼠标(评审 3.9)
          requestDeleteConfirm();
          return;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      categories,
      previewId,
      openGroup,
      assets.length,
      total,
      loading,
      loadMore,
      assetIds,
      selection,
      columns,
      cursorIndex,
      deliveryWorking,
      entries,
      runAssign,
      runCurate,
      toggleMark,
      unmarkOnly,
      openPreview,
      closePreview,
      openGroupOverlay,
    ],
  );

  /**
   * 画廊模式的键盘兜底。
   *
   * 移动/选区类按键归 GalleryView 自己（它持有 cursorId 与列数），这里只接
   * 「作用于当前聚焦项」的打标动作——两处各动一套光标必然打架。
   * GalleryView 若自行处理并 stopPropagation，这个处理器根本不会被叫到。
   */
  const handleGalleryKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (previewId !== null) return;
      if (shouldYieldShortcut(event.target, event.key)) return;
      const action = resolveShortcut(
        {
          key: event.key,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
        },
        categories,
      );
      if (!action) return;

      switch (action.type) {
        case "assign":
          galleryAssign(action.categoryId);
          break;
        case "other": {
          const other = categories.find((c) => c.kind === "other");
          if (!other) return;
          galleryAssign(other.id);
          break;
        }
        case "curate":
          galleryCurate();
          break;
        case "markDelete":
          galleryToggleDelete();
          break;
        case "unmarkDelete":
          // 正常路径是 GalleryView 自己接（`onUnmarkDelete` prop）并吞掉。
          // 这里是焦点停在 wrap 本身（还没进到画廊里）时的兜底，
          // 两条路走的是同一个「只撤回」实现，不会打架。
          galleryUnmarkDelete();
          break;
        case "preview":
          galleryOpenFullscreen();
          break;
        case "confirmDelete":
          requestDeleteConfirm();
          break;
        default:
          // 方向键/全选/Esc 等交给 GalleryView 与浏览器，不在这里抢
          return;
      }
      event.preventDefault();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      previewId,
      categories,
      galleryAssign,
      galleryCurate,
      galleryToggleDelete,
      galleryUnmarkDelete,
      galleryOpenFullscreen,
    ],
  );

  /* ---------------- 渲染 ---------------- */

  if (!project) {
    return (
      <>
        <TopBar title="选片与交付" />
        <div className="content">
          <div className="content__inner">
            <p className="text-sm" role="alert">
              尚未选择项目。
            </p>
          </div>
        </div>
      </>
    );
  }

  const indexProgress = indexing
    ? `${indexing.indexed}/${indexing.total}`
    : "读取中…";

  return (
    <>
      <TopBar
        title="选片与交付"
        subtitle={project.folderName}
        subtitleMono
        actions={
          <>
            <span className="text-xs dim" data-testid="sorting-remaining">
              待分类 <PulseValue value={total} />
            </span>
            <button
              type="button"
              className="btn btn--sm"
              data-testid="sorting-analyze"
              disabled={analyzing}
              title="本地分析:连拍聚类、质量评分、人脸检测。只给建议角标,不会移动或删除任何文件"
              onClick={() => void startAnalysis()}
            >
              {analyzing
                ? `分析中 ${analyzeJob?.done ?? 0}/${analyzeJob?.total ?? 0}`
                : "AI 选片分析"}
            </button>
            <DeliveryButton projectId={project.id} />
            <button
              type="button"
              className="btn btn--sm"
              data-testid="sorting-open-trash"
              /* 打包期间导航已放行(评审 4.3):进度/结果由 store 承载,回屏自动恢复 */
              onClick={() => dispatch({ type: "navigate", route: "trash" })}
            >
              回收站
            </button>
          </>
        }
      />

      <div className="content content--flush">
        {/* flush 屏同样要有 .content__inner:屏间进场动画挂在它身上
            (挂滚动容器会掉出合成器异步滚动);缺了这层,本屏从 af39168
            起就没有进场动画,--flush 的样式也成了死规则(评审 P1) */}
        <div className="content__inner">
        <div className="sorting">
          {/* 分类条：计数 + 数字键提示。chip 是「把选中素材移入」的动作,
              不是筛选器(评审 3.10)——无选中目标时禁用并说明,而不是静默无事发生 */}
          <div className="sorting__bar" data-testid="sorting-categories">
            {(() => {
              const hasTargets = actionTargets(selection).length > 0;
              return categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className="chip"
                  data-testid="sorting-category"
                  data-category={category.id}
                  disabled={
                    category.kind === "inbox" ||
                    busy ||
                    deliveryWorking ||
                    !hasTargets
                  }
                  /* 精选是「复制进精选/待修」，不是移动——点击路径必须与 P 键一致 */
                  onClick={() => {
                    if (category.kind === "curated") void runCurate();
                    else void runAssign(category.id);
                    /*
                     * 评审 C1：这一按 `busy` 立刻转 true，chip 随之 disabled，
                     * 而**被禁用的元素会丢掉焦点**，activeElement 落到 body——
                     * 键盘流就此断掉，用户得先用鼠标点一下网格才能继续，
                     * 屏上没有任何迹象说明为什么。点完就把键盘还给网格/画廊。
                     */
                    focusKeyboardHost();
                  }}
                  title={
                    category.kind === "inbox"
                      ? category.name
                      : /* 按钮为什么按不动,一律写在它自己身上——
                           只留一个灰按钮等于让人猜(零静默) */
                        deliveryWorking
                        ? "交付打包进行中，已暂停分类操作，避免同一批文件边打包边被挪走"
                        : busy
                          ? "上一批分类还没落定，等格子刷新后再按"
                          : !hasTargets
                            ? "先在网格里选中素材，再点击移入该分类"
                            : category.kind === "curated"
                              ? "把选中素材复制一份进「精选/待修」，原件留在待分类（快捷键 P）"
                              : category.kind === "other"
                                ? `把选中素材移入「${category.name}」（快捷键 O）`
                                : `把选中素材移入「${category.name}」（快捷键 ${category.hotkey}）`
                  }
                >
                  {category.hotkey ? <Kbd>{category.hotkey}</Kbd> : null}
                  {category.kind === "curated" ? <Kbd>P</Kbd> : null}
                  {category.kind === "other" ? <Kbd>O</Kbd> : null}
                  <span>{category.name}</span>
                  {/* 计数变化就是"这一下生效了"的因果反馈：分类完不用满屏找差别 */}
                  <PulseValue className="chip__count" value={category.count} />
                </button>
              ));
            })()}

            {/* 视图切换:网格(连拍折成一格)/ 画廊(逐张平铺)。
                只是同一批素材的两种看法,不改任何筛选口径 */}
            <span className="push-right row-inline text-xs">
              <span className="dim">视图</span>
              <button
                type="button"
                className="chip"
                data-testid="sorting-view-grid"
                aria-pressed={viewMode === "grid"}
                title="网格:连拍组折叠成一格,空格铺开整组"
                onClick={() => setViewMode("grid")}
              >
                网格
              </button>
              <button
                type="button"
                className="chip"
                data-testid="sorting-view-gallery"
                aria-pressed={viewMode === "gallery"}
                title="画廊:连拍组也逐张平铺,适合通读"
                onClick={() => setViewMode("gallery")}
              >
                画廊
              </button>
            </span>

            <span className="row-inline text-xs">
              <span className="dim">筛选</span>
              <Select
                ariaLabel="按 AI 判定筛选"
                testId="sorting-judge-filter"
                value={judgeFilter}
                onChange={(next) => setJudgeFilter(next as JudgementFilter)}
                options={(
                  Object.keys(JUDGEMENT_FILTER_LABEL) as JudgementFilter[]
                ).map((key) => ({
                  value: key,
                  label: JUDGEMENT_FILTER_LABEL[key],
                }))}
              />
              {/* 「建议保留」不再是全局筛选项——它从来只在连拍组内成立(后端
                  analysis.rs:318:无组时高分单张也不标)。概念搬了家必须当面说一声,
                  否则用户只会以为这个功能凭空没了(零静默) */}
              <span
                className="text-2xs dim"
                data-testid="sorting-suggest-moved"
                title="后端口径:suggested_keep 是「组内首选(荐优)」,不成组的单张再高分也不标。把它做成全局筛选会把所有非连拍的已判定单张一并藏起来或全列为「建议放弃」,所以它归回连拍组内部。"
              >
                「建议保留」已归入连拍组（展开组即可用）
              </span>
            </span>
          </div>

          {/* 没跑过分析时,判定筛选形同虚设——把因果说破,别让人对着全量列表纳闷 */}
          {judgeFilter !== "all" && !assets.some((a) => a.judgement) ? (
            <div
              className="sorting__indexing"
              role="status"
              data-testid="sorting-filter-hint"
            >
              <span className="text-xs">
                还没有 AI 判定结果——先点右上角「AI 选片分析」，跑完才有糊片 / 低分可筛。
              </span>
            </div>
          ) : null}

          {flowHints.length > 0 ? (
            <div className="sorting__indexing" data-testid="sorting-flow-hints">
              <div className="row-inline">
                <span className="text-xs">
                  {flowHints.length} 个待修原稿已有成品，建议清理
                </span>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm push-right"
                  data-testid="sorting-flow-hints-toggle"
                  aria-expanded={flowHintsOpen}
                  onClick={() => setFlowHintsOpen((v) => !v)}
                >
                  {flowHintsOpen ? "收起" : "查看"}
                </button>
              </div>
              {flowHintsOpen ? (
                <div className="stack stack--sm">
                  {flowHints.map((hint) => (
                    <div
                      className="delivery__failure"
                      key={hint.todoAssetId}
                      data-testid="flow-hint-item"
                    >
                      <span className="mono text-2xs truncate" title={hint.todoAssetId}>
                        {hint.todoAssetId}
                      </span>
                      <span className="text-2xs dim">已修：{hint.doneFileName}</span>
                    </div>
                  ))}
                  <span className="text-2xs dim">
                    删除仍走「标记 → 确认 → 回收站」流程，OCard 不会替你删任何文件。
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}

          {thumbFailStreak >= THUMB_FAIL_BANNER_AT ? (
            <div
              className="notice notice--warn"
              role="alert"
              data-testid="sorting-thumb-degraded"
            >
              <strong>缩略图服务异常，详见通知</strong>
              <span>
                连续 {thumbFailStreak} 张缩略图加载失败，已改为显示占位。
                分类操作不受影响，但看不到预览；可稍后重新进入本屏重试。
              </span>
            </div>
          ) : null}

          {deliveryWorking ? (
            <div className="sorting__indexing" role="status" data-testid="sorting-delivery-lock">
              <span className="text-xs">
                交付打包进行中，已暂时禁用分类操作，避免同一批文件边打包边被挪走。
              </span>
            </div>
          ) : null}

          {/* 索引进度：索引中也能操作已索引部分 */}
          {indexing &&
          (indexing.running || indexing.failed > 0 || indexing.missing > 0) ? (
            <div className="sorting__indexing" data-testid="sorting-indexing">
              <ProgressBar
                value={indexing.indexed}
                total={indexing.total}
                thin
                label="缩略图索引进度"
                valueText={indexProgress}
              />
              <span className="text-xs dim">
                {indexing.running
                  ? `正在生成缩略图 ${indexProgress}，可以先分类已索引的部分`
                  : `缩略图索引完成 ${indexProgress}`}
                {indexing.failed > 0 ? ` · ${indexing.failed} 个失败` : ""}
                {indexing.missing > 0
                  ? ` · 已跳过 ${indexing.missing} 个已移走的文件`
                  : ""}
              </span>
            </div>
          ) : null}

          {/* 网格 / 画廊 */}
          <div
            className="sorting__grid-wrap"
            ref={gridWrapRef}
            /*
             * 画廊模式下 wrap 自己退出 Tab 序（评审 B2）：真正的键盘宿主是
             * GalleryView 根节点，焦点若停在 wrap 上，方向键 / Esc 会落进
             * handleGalleryKeyDown 的 default 分支被原样放掉——按了没反应。
             * 保留 tabIndex=-1 是为了程序化收焦点仍然可用。
             */
            tabIndex={viewMode === "gallery" ? -1 : 0}
            onFocus={(e) => {
              // 兜底：点到 wrap 边缘留白也会让它拿到焦点，立刻转交给画廊根节点
              if (viewMode !== "gallery" || e.target !== e.currentTarget) return;
              galleryRootRef.current?.focus({ preventScroll: true });
            }}
            onKeyDown={viewMode === "gallery" ? handleGalleryKeyDown : handleKeyDown}
            data-testid="sorting-grid-wrap"
            data-view={viewMode}
            aria-label="待分类素材"
          >
            {loadError ? (
              <div className="sorting__error" data-testid="sorting-load-error">
                <p className="text-sm" role="alert">
                  无法读取待分类素材：{loadError}
                </p>
                <p className="text-xs dim">
                  这不代表素材不存在——请检查 NAS 是否可达后重试。
                </p>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  data-testid="sorting-retry"
                  onClick={() => setReloadToken((n) => n + 1)}
                >
                  重试
                </button>
              </div>
            ) : assets.length === 0 && !loading ? (
              /* 清空不是死胡同(评审 3.12):此刻的下一步几乎必然是交付打包;
                 空态插画(PR16)与行动出口(PR18)合流 */
              <EmptyState art={<IllSortingEmpty />}>
                <div className="stack" data-testid="sorting-empty-cta">
                  <p className="text-sm">待分类已清空——都分完了。</p>
                  <p className="text-xs dim">
                    下一步通常是交付打包;若有误删的,先去回收站找回。
                  </p>
                  <div className="row-inline">
                    <DeliveryButton projectId={project.id} />
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => dispatch({ type: "navigate", route: "trash" })}
                    >
                      查看回收站
                    </button>
                  </div>
                </div>
              </EmptyState>
            ) : visibleAssets.length === 0 && !loading ? (
              /* 筛选下为空 ≠ 没素材:给一键回到全部,别让人以为素材丢了 */
              <div className="sorting__error" data-testid="sorting-filter-empty">
                <p className="text-sm">当前筛选条件下没有素材。</p>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => {
                    setJudgeFilter("all");
                    setMarkedOnly(false);
                  }}
                >
                  清除筛选
                </button>
              </div>
            ) : viewMode === "gallery" ? (
              /* 画廊模式:组件由另一路并行开发,这里只负责接线。
                 assets 用 previewAssets——连拍组在画廊里逐张平铺,
                 与全屏预览共用同一个下标空间,翻页不会错位 */
              <GalleryView
                assets={previewAssets}
                /*
                 * 传**原始**光标 id，哪怕它已经失效。
                 *
                 * 从前这里传的是父层 sanitize 过的 galleryCursor（失效即静默
                 * 回退成第一项），于是 GalleryView 里那条「原先聚焦的 XX 已不在
                 * 列表里」的告警在真实接线下**永远不触发**——只在它自己的单测里
                 * 活着。检测/告警/回退的责任整个归组件，父层不再抢先抹平。
                 */
                cursorId={galleryCursorId}
                onCursorChange={(id) => setGalleryCursorId(id)}
                categories={categories}
                markedSet={markedSet}
                curatedIds={curatedIds}
                onAssign={(categoryId) => galleryAssign(categoryId)}
                onCurate={galleryCurate}
                onToggleDelete={galleryToggleDelete}
                /* D 与 U 分两个回调下去：共用一个的话 U 会退化成开关，
                   对未标记项按 U 反而把它标进待删清单（组层/大图同一条口径） */
                onUnmarkDelete={galleryUnmarkDelete}
                onOpenFullscreen={galleryOpenFullscreen}
                onThumbError={onThumbError}
                onThumbLoad={onThumbLoad}
                /*
                 * 分页边界（评审 D1）。上一轮给 GalleryView 加了 total /
                 * loading / onEndReached 用来如实说明「已加载 ≠ 全部」，
                 * 却**一个都没接到这里**：组件于是走「已加载即全部」的降级分支，
                 * 第 200 张写着「共 200 张」「已经是最后一张」，也不会续拉——
                 * 用户据此认为选片做完了，剩下 1040 张完全没检查过。
                 * 组件测试全绿、产品路径上是死的，与「光标丢失告警成死代码」同族。
                 *
                 * total 与 unloadedCount 二选一，取决于当前是不是筛选态：
                 * 无筛选时 previewAssets 与 assets 同口径，total 就是诚实的总数；
                 * 一旦开了筛选，库里没加载的那部分能命中多少张无从得知，
                 * 拿全库 total 冒充筛选结果的总数就是说谎（见 galleryScopeTotal）。
                 */
                total={galleryFiltered ? undefined : total}
                unloadedCount={galleryFiltered ? galleryUnloaded : undefined}
                loading={loading}
                onEndReached={
                  galleryUnloaded > 0 ? () => void loadMore() : undefined
                }
                /* 浮层收起后把键盘焦点交回**画廊根节点**，不是外层 wrap（B2） */
                rootNodeRef={galleryRootRef}
              />
            ) : (
              <VirtualGrid
                items={entries}
                minCellWidth={CELL_MIN_WIDTH}
                rowHeight={ROW_HEIGHT}
                gap={GRID_GAP}
                className="sorting__grid"
                ariaLabel="待分类素材网格"
                scrollToIndex={cursorIndex}
                onColumnsChange={setColumns}
                /* 滚动触底自动续拉(评审 3.7):滚动流不必停下来点按钮;
                   失败重试仍走底部显式按钮 */
                onEndReached={
                  assets.length < total && !pageError
                    ? () => void loadMore()
                    : undefined
                }
                keyOf={(entry) => entry.id}
                renderItem={(entry, index) =>
                  entry.kind === "group" ? (
                    <GroupCell
                      key={entry.id}
                      entry={entry}
                      selected={selectedSet.has(entry.id)}
                      focused={selection.cursor === entry.id}
                      /* 预览中就锚在被预览那张所在的格上，否则锚在光标格：
                         打开/关闭时大图与它之间才有"同一个实体"的连续关系 */
                      previewAnchor={
                        previewId
                          ? entry.items.some((i) => i.id === previewId)
                          : selection.cursor === entry.id
                      }
                      committed={commit?.ids.has(entry.id) ? commit.phase : undefined}
                      markedCount={
                        entry.items.filter((i) => markedSet.has(i.id)).length
                      }
                      selectedCount={
                        entry.items.filter((i) => selectedSet.has(i.id)).length
                      }
                      onSelect={(modifiers) =>
                        setSelection((prev) =>
                          clickSelection(assetIds, prev, entry.id, modifiers),
                        )
                      }
                      onExpand={() => openGroupOverlay(entry.groupId)}
                      onThumbError={onThumbError}
                      onThumbLoad={onThumbLoad}
                    />
                  ) : (
                    <AssetCell
                      key={entry.id}
                      asset={entry.asset}
                      index={index}
                      selected={selectedSet.has(entry.id)}
                      focused={selection.cursor === entry.id}
                      previewAnchor={
                        previewId
                          ? entry.asset.id === previewId
                          : selection.cursor === entry.id
                      }
                      committed={commit?.ids.has(entry.id) ? commit.phase : undefined}
                      marked={markedSet.has(entry.id)}
                      curated={curatedIds.has(entry.id)}
                      onSelect={(modifiers) =>
                        setSelection((prev) =>
                          clickSelection(assetIds, prev, entry.id, modifiers),
                        )
                      }
                      onOpen={() => openPreview(entry.asset.id)}
                      onThumbError={onThumbError}
                      onThumbLoad={onThumbLoad}
                    />
                  )
                }
              />
            )}
          </div>

          <div className="sorting__foot">
            {/*
              画廊模式下这条只留**屏级**的东西。逐张操作的键位由 GalleryView
              自己那条提示条负责——两条都列会同时显示、而且互相矛盾:
              这条写着「X 选中 · Shift+方向 连选 · ⌘A 全选」,画廊那条写着
              「X 选中 / ⌘A 全选不适用」。用户实际看到的就是两排打架的提示。
              `Shift+D` 留在这里是因为它作用于**整屏的待删清单**,不是某一张,
              而画廊那条不写它 —— 不留的话它就成了一个谁都没告诉你的隐藏键。
            */}
            <div className="hint-bar">
              {viewMode === "grid" ? (
                <>
                  <span>
                    <Kbd>↑</Kbd>
                    <Kbd>↓</Kbd>
                    <Kbd>←</Kbd>
                    <Kbd>→</Kbd> 移动
                  </span>
                  <span>
                    <Kbd>X</Kbd> 选中 · <Kbd>Shift</Kbd>+方向 连选 ·{" "}
                    <Kbd>⌘A</Kbd> 全选 · <Kbd>Esc</Kbd> 清选
                  </span>
                  <span>
                    <Kbd>1</Kbd>–<Kbd>9</Kbd> 分类 · <Kbd>P</Kbd> 精选 ·{" "}
                    <Kbd>O</Kbd> 其他 · <Kbd>D</Kbd> 标删/取消 ·{" "}
                    <Kbd>Shift+D</Kbd> 提交
                  </span>
                  <span data-testid="sorting-hint-preview">
                    <Kbd>空格</Kbd>/<Kbd>Enter</Kbd> 预览（连拍组先铺开整组）
                  </span>
                </>
              ) : (
                <>
                  <span data-testid="sorting-hint-submit">
                    <Kbd>Shift+D</Kbd> 提交待删清单
                  </span>
                  {/* 画廊把连拍组拆开逐张列出——这与网格里「一组一格」的计数口径
                      不同,不说破的话用户会以为素材数量变了(零静默) */}
                  <span className="dim" data-testid="sorting-gallery-note">
                    画廊模式：连拍组逐张平铺，不再折叠成一格；逐张操作的键位见下方
                  </span>
                </>
              )}
              {selection.selected.length > 0 ? (
                <span className="push-right" data-testid="sorting-selected-count">
                  已选 {resolveEntryIds(entries, selection.selected).length}
                  {/* 隐形边界必须说破(评审 3.7):全选只覆盖已加载部分 */}
                  {assets.length < total &&
                  selection.selected.length >= entries.length
                    ? `（尚有 ${total - assets.length} 张未加载）`
                    : ""}
                </span>
              ) : null}
            </div>

            {/* 批量移动撤销窗口(评审 3.5):误击一个数字键,200 张也追得回来 */}
            {lastMove ? (
              <div
                className="sorting__pending"
                role="status"
                data-testid="sorting-undo-bar"
              >
                <span className="text-sm">
                  已把 {lastMove.assetIds.length} 张移入「{lastMove.categoryName}」
                </span>
                <button
                  type="button"
                  className="btn btn--sm push-right"
                  data-testid="sorting-undo"
                  disabled={undoing || busy || deliveryWorking}
                  title={
                    deliveryWorking
                      ? "交付打包进行中，暂不能撤销移动（撤销也是在动同一批文件）"
                      : "把刚才那批文件移回「待分类」"
                  }
                  onClick={() => {
                    void undoLastMove();
                    /* 按下去 `undoing` 立刻 true → 本按钮 disabled；成功后
                       `setLastMove(null)` 又把整条撤销条卸载。两步都会把焦点
                       丢给 body（评审 C1），所以点完就先把键盘还回去。 */
                    focusKeyboardHost();
                  }}
                >
                  {undoing ? "撤销中…" : "撤销"}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-label="收起撤销提示"
                  onClick={() => {
                    setLastMove(null);
                    // 收起 = 本按钮连同整条一起卸载，焦点必须有去处（C1）
                    focusKeyboardHost();
                  }}
                >
                  收起
                </button>
              </div>
            ) : null}

            {pageError ? (
              <span className="field__error" role="alert" data-testid="sorting-page-error">
                加载更多失败：{pageError}
              </span>
            ) : null}

            {assets.length < total ? (
              <button
                type="button"
                className="btn btn--sm"
                data-testid="sorting-load-more"
                disabled={loading}
                onClick={() => void loadMore()}
              >
                {loading ? "加载中…" : `加载更多（还有 ${total - assets.length} 个）`}
              </button>
            ) : null}
          </div>

          {/* 待删清单：两段式删除的第一段，必须显式确认才真的动文件 */}
          {pendingDelete.marked.length > 0 ? (
            <div className="sorting__pending" role="status" data-testid="sorting-pending-delete">
              <span className="dot" />
              <span className="text-sm">
                已标记 {pendingDelete.marked.length} 个待删除
                {pendingDelete.failed.length > 0
                  ? `（上次有 ${pendingDelete.failed.length} 个失败，仍在清单里）`
                  : ""}
              </span>
              {/* 两个按钮为什么同时变灰，写在脸上而不是只藏进 title（零静默） */}
              {committing ? (
                <span className="text-2xs dim" data-testid="sorting-commit-busy">
                  正在提交进回收站，标记暂时不能改动…
                </span>
              ) : null}
              <button
                type="button"
                className="btn btn--sm push-right"
                data-testid="sorting-marked-only"
                aria-pressed={markedOnly}
                title="只显示已标删的素材,提交前逐张复核"
                onClick={() => setMarkedOnly((v) => !v)}
              >
                {markedOnly ? "显示全部" : "只看已标删"}
              </button>
              {/*
                评审 A1：这个按钮曾经是**唯一**一个直接对状态机下发、
                既不过 `changeMark` 也不过 `gateAction` 的标记变更入口。
                reducer 在 `phase === "working"` 时一句 `return state`，
                于是 trashAssets 在飞时点它：什么都不发生、零反馈；
                而同一刻按 D / U 会得到 `sorting-action-commit-busy` 的明确说明。
                同一件事，鼠标路径静默、键盘路径有话说，静默的还是更常用的那条。
                现在两条路走同一个闸门，并且按钮自己写明为什么按不动。
              */}
              <button
                type="button"
                className="btn btn--sm"
                data-testid="sorting-unmark-all"
                disabled={committing}
                title={
                  committing
                    ? "待删清单正在提交进回收站，此刻不能改标记；等提交结束再取消"
                    : "把待删清单整个清空（只是撤回标记，不会动任何文件）"
                }
                onClick={() => {
                  // 走闸门：将来若出现别的拒收理由，这条路同样会当面说清
                  unmarkOnly(pendingDelete.marked);
                  /* 清单归零会把整条待删条卸载，焦点随按钮一起落到 body，
                     键盘流就此断掉且屏上没有任何迹象（评审 C1） */
                  focusKeyboardHost();
                }}
              >
                取消标记
              </button>
              <button
                type="button"
                className="btn btn--sm btn--danger-solid"
                data-testid="sorting-confirm-delete"
                disabled={deliveryWorking || committing}
                title={
                  deliveryWorking
                    ? "交付打包进行中，暂不能移入回收站"
                    : committing
                      ? "上一批正在提交进回收站，等它结束再按"
                      : "快捷键 Shift+D"
                }
                onClick={requestDeleteConfirm}
              >
                确认移入回收站
              </button>
            </div>
          ) : null}
        </div>
        </div>
      </div>

      {openGroupItems.length > 0 ? (
        <GroupLayer
          items={openGroupItems}
          cursorId={groupCursorId}
          onCursorChange={setGroupCursorId}
          selectedSet={selectedSet}
          markedSet={markedSet}
          curatedIds={curatedIds}
          categories={categories}
          /* 关键：连选也在**组成员 id 空间**里做，
             组层选中的裸素材 id 由 resolveEntryIds 兜住，不再被静默丢弃 */
          onSelect={(id, modifiers) =>
            setSelection((prev) =>
              clickSelection(
                openGroupItems.map((i) => i.id),
                prev,
                id,
                modifiers,
              ),
            )
          }
          onAssign={(ids, categoryId) => void runAssign(categoryId, ids)}
          onCurate={(ids) => void runCurate(ids)}
          onToggleDelete={toggleMark}
          /* U 与 D 必须分开：共用 toggle 会让 U 把未标记项标进待删清单 */
          onUnmarkDelete={unmarkOnly}
          /* 「保留推荐，其余标删」是只标记，不是开关——余量已全标时再按不该反转 */
          onMarkDelete={markOnly}
          onConfirmDelete={requestDeleteConfirm}
          pendingCount={pendingDelete.marked.length}
          deliveryWorking={deliveryWorking}
          /* fromGroup=true:大图记住自己是从组层来的,Esc 才知道退回哪一层 */
          onOpenPreview={(assetId) => openPreview(assetId, true)}
          coveredAbove={modalAbove}
          onThumbError={onThumbError}
          onThumbLoad={onThumbLoad}
          onClose={closeGroupOverlay}
        />
      ) : null}

      {previewIndex >= 0 && previewScope[previewIndex] ? (
        <AssetLightbox
          asset={previewScope[previewIndex]}
          index={previewIndex}
          total={previewScope.length}
          /* 序号是**范围内**的序号:从组层进来时它数的是组内几张,
             跟全库 1240 对不上——不说破就成了一个看不懂的数字 */
          scopeLabel={
            previewScope === openGroupItems ? "连拍组内" : undefined
          }
          categories={categories}
          marked={markedSet.has(previewScope[previewIndex].id)}
          curated={curatedIds.has(previewScope[previewIndex].id)}
          onClose={closePreview}
          onPrev={() =>
            setPreviewId(previewScope[Math.max(0, previewIndex - 1)].id)
          }
          onNext={() =>
            setPreviewId(
              previewScope[
                Math.min(previewScope.length - 1, previewIndex + 1)
              ].id,
            )
          }
          onAssign={previewAssign}
          onCurate={previewCurate}
          onToggleDelete={previewToggleDelete}
          onUnmarkDelete={previewUnmarkDelete}
          /* 打包期间分类/精选一律不生效——按钮就该是灰的,并写明为什么 */
          actionsBlockedReason={
            deliveryWorking
              ? "交付打包进行中，已暂停分类与精选（标删标记仍可撤回）"
              : undefined
          }
        />
      ) : null}

      <ConfirmDialog
        request={confirm}
        onCancel={() => {
          setConfirm(null);
          dispatchDelete({ type: "cancelConfirm" });
        }}
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 单元格
 * ------------------------------------------------------------------ */

function AssetCell({
  asset,
  index,
  selected,
  focused,
  marked,
  curated,
  previewAnchor,
  committed,
  onSelect,
  onOpen,
  onThumbError,
  onThumbLoad,
}: {
  asset: SortingAsset;
  index: number;
  selected: boolean;
  focused: boolean;
  marked: boolean;
  /** 本次会话精选过:常驻角标,动画播完仍认得出(评审 3.3) */
  curated?: boolean;
  /** 该格是不是全屏预览的来源/去向：是就把过渡名挂上，做同一实体的形变 */
  previewAnchor: boolean;
  /** 刚被"精选"命中过：a / b 交替以便连续两次都能重新起播 */
  committed?: "a" | "b";
  onSelect: (modifiers: { shift?: boolean; meta?: boolean }) => void;
  onOpen: () => void;
  onThumbError: () => void;
  onThumbLoad: () => void;
}) {
  // thumb:// 取图可能 404（缓存被清/尚未索引）：该格转占位，并计入连续失败
  const [thumbFailed, setThumbFailed] = useState(false);
  useEffect(() => {
    setThumbFailed(false);
  }, [asset.thumbnail]);

  /* 过渡名全局唯一：只有锚点格挂，其余格一律 undefined —— 挂重了整次过渡会被放弃 */
  const anchorStyle = previewAnchor
    ? { viewTransitionName: "ocard-preview" }
    : undefined;

  return (
    <div
      role="gridcell"
      aria-selected={selected}
      data-testid="asset-cell"
      data-asset={asset.id}
      data-marked={marked || undefined}
      data-commit={committed}
      className={`asset${selected ? " asset--selected" : ""}${
        focused ? " asset--focused" : ""
      }${marked ? " asset--marked" : ""}`}
      onClick={(e) => onSelect({ shift: e.shiftKey, meta: e.metaKey || e.ctrlKey })}
      onDoubleClick={onOpen}
    >
      {asset.thumbReady && asset.thumbnail && !thumbFailed ? (
        <img
          className="asset__thumb"
          style={anchorStyle}
          src={asset.thumbnail}
          alt=""
          loading="lazy"
          data-testid="asset-thumb"
          onError={() => {
            setThumbFailed(true);
            onThumbError();
          }}
          onLoad={onThumbLoad}
        />
      ) : (
        <div
          className="asset__thumb asset__thumb--empty"
          style={anchorStyle}
          data-testid="asset-no-thumb"
        >
          <span className="text-2xs dim">{thumbFailed ? "预览不可用" : "索引中"}</span>
        </div>
      )}

      <div className="asset__meta">
        <span className="asset__name truncate" title={asset.fileName}>
          {asset.fileName}
        </span>
        <span className="asset__sub">
          {asset.kind !== "photo" ? (
            <Badge tone="neutral">{KIND_LABEL[asset.kind]}</Badge>
          ) : null}
          <span className="mono text-2xs dim">{formatBytes(asset.sizeBytes, 0)}</span>
        </span>
      </div>

      <JudgementBadges judgement={asset.judgement} />

      {curated ? (
        <span
          className="asset__flag asset__flag--curated"
          title="已精选(复制进精选/待修)"
          data-testid="asset-curated-flag"
        >
          ✓
        </span>
      ) : null}
      {marked ? (
        <span className="asset__flag asset__flag--delete" title="已标记待删除">
          D
        </span>
      ) : null}
      <span className="sr-only">
        第 {index + 1} 项
        {asset.shotAt
          ? `，拍摄于 ${formatTimestamp(asset.shotAt)}${
              asset.shotAtFallback ? "（时间为推断值）" : ""
            }`
          : ""}
      </span>
    </div>
  );
}


/* 判定角标已抽到 components/JudgementBadges.tsx:网格与全屏预览共用同一套呈现 */

/** 连拍组：恰占一格，角标 ×N；展开走 overlay */
function GroupCell({
  entry,
  selected,
  focused,
  markedCount,
  selectedCount = 0,
  previewAnchor,
  committed,
  onSelect,
  onExpand,
  onThumbError,
  onThumbLoad,
}: {
  entry: { id: string; groupId: string; items: SortingAsset[] };
  selected: boolean;
  focused: boolean;
  markedCount: number;
  /** 组内已被单独选中的张数:展开层选完关掉后,格面也要看得出(评审 G1) */
  selectedCount?: number;
  previewAnchor: boolean;
  committed?: "a" | "b";
  onSelect: (modifiers: { shift?: boolean; meta?: boolean }) => void;
  onExpand: () => void;
  onThumbError: () => void;
  onThumbLoad: () => void;
}) {
  // 封面优先用组内「建议保留」的那张
  const cover =
    entry.items.find((i) => i.judgement?.suggestedKeep) ?? entry.items[0];
  const [failed, setFailed] = useState(false);
  const anchorStyle = previewAnchor
    ? { viewTransitionName: "ocard-preview" }
    : undefined;

  return (
    <div
      role="gridcell"
      aria-selected={selected}
      data-testid="asset-group"
      data-group={entry.groupId}
      data-commit={committed}
      className={`asset asset--group${selected ? " asset--selected" : ""}${
        focused ? " asset--focused" : ""
      }`}
      onClick={(e) => onSelect({ shift: e.shiftKey, meta: e.metaKey || e.ctrlKey })}
      onDoubleClick={onExpand}
    >
      {cover.thumbReady && cover.thumbnail && !failed ? (
        <img
          className="asset__thumb"
          style={anchorStyle}
          src={cover.thumbnail}
          alt=""
          loading="lazy"
          onError={() => {
            setFailed(true);
            onThumbError();
          }}
          onLoad={onThumbLoad}
        />
      ) : (
        <div className="asset__thumb asset__thumb--empty" style={anchorStyle}>
          <span className="text-2xs dim">索引中</span>
        </div>
      )}

      <div className="asset__meta">
        <span className="asset__name truncate">连拍组</span>
        <span className="asset__sub">
          <Badge tone="neutral">×{entry.items.length}</Badge>
          {selectedCount > 0 ? <Badge tone="ok">已选 {selectedCount}</Badge> : null}
          {markedCount > 0 ? <Badge tone="danger">待删 {markedCount}</Badge> : null}
        </span>
      </div>

      <JudgementBadges judgement={cover.judgement} />

      <button
        type="button"
        className="asset__expand"
        data-testid="group-expand"
        aria-label={`展开连拍组 ${entry.groupId}`}
        onClick={(e) => {
          e.stopPropagation();
          onExpand();
        }}
      >
        展开
      </button>
    </div>
  );
}

/** 组层格子的最小宽与间距——键盘上下移动要按**真实列数**跨行，就得知道这两个数 */
const GROUP_TILE_MIN_WIDTH = 168;
const GROUP_TILE_GAP = 10;
/** 量不到宽度时（jsdom / 首帧）的保守列数：宁可跨得少，也别跳过一整屏 */
const GROUP_FALLBACK_COLUMNS = 4;

/**
 * 连拍组全屏层：把整组**铺开**，一屏之内挑片。
 *
 * 层级关系是三层：网格 → 组全屏层 → 大图 Lightbox。
 * `Esc` 每次只退一层，`Enter` / 空格逐层深入——这是 Quick Look 的模型，
 * 也是「先看全一组、再挑出那一张」的实际工作顺序。
 *
 * 有界与滚动：本层自己 `position: fixed; inset: 0`，内部是
 * flex 列 + `min-height: 0` 的滚动区（见 screens.css 的 `.group-layer`）。
 * 注意一条**靠外部条件兜着**的前提：本层打开期间，背后的 `.sorting__grid`
 * 仍然是活跃滚动容器（滚动位置也还停在原处），只是因为本层是不透明全屏、
 * 滚轮落不到它身上才无症状。本层若将来改成非全屏或可穿透，就必须同时
 * 冻结背后那个容器——否则会违反「同一片区域同一时刻只有一个容器响应滚轮」。
 * `.group-layer__grid` 的 `overscroll-behavior: contain` 只挡住滚动链，
 * 挡不住直接落在下层上的滚轮。
 * **不复用 `.overlay`**：那是 `display: grid` 且没写 `grid-template-rows`，
 * 隐式行为 `auto`，内容一超视口行就被撑大、子元素的 `height/max-height: 100%`
 * 随之失去约束，内部滚动条永不出现、内容跑出窗口下沿。组内可能有几十张，
 * 这条坑必须绕开。
 *
 * 选中语义与主网格一致（写的是同一个选区），打标目标 = 组内已选中的成员，
 * 都没选就用光标那张。
 */
function GroupLayer({
  items,
  cursorId,
  onCursorChange,
  selectedSet,
  markedSet,
  curatedIds,
  categories,
  onSelect,
  onAssign,
  onCurate,
  onToggleDelete,
  onUnmarkDelete,
  onMarkDelete,
  onConfirmDelete,
  pendingCount,
  deliveryWorking,
  onOpenPreview,
  coveredAbove,
  onThumbError,
  onThumbLoad,
  onClose,
}: {
  items: SortingAsset[];
  /** 组层光标（组成员 assetId）；由父级持有，好让大图退回来时接着站在这张上 */
  cursorId: string | null;
  onCursorChange: (id: string) => void;
  selectedSet: Set<string>;
  markedSet: Set<string>;
  curatedIds: Set<string>;
  categories: SortingCategory[];
  onSelect: (id: string, modifiers: { shift?: boolean; meta?: boolean }) => void;
  onAssign: (assetIds: string[], categoryId: string) => void;
  onCurate: (assetIds: string[]) => void;
  /** D：开关（全已标记→取消，否则标记） */
  onToggleDelete: (assetIds: string[]) => void;
  /** U：只撤回标删，永不新增——与 D 共用一个回调会让 U 变成「标删」 */
  onUnmarkDelete: (assetIds: string[]) => void;
  /** 只标记（批量工具用），不做开关反转 */
  onMarkDelete: (assetIds: string[]) => void;
  /** Shift+D：提交待删清单（与主屏同一条确认流） */
  onConfirmDelete: () => void;
  /** 全局待删清单条数——底部那条状态栏被本层整个盖住，所以要在这里复述 */
  pendingCount: number;
  deliveryWorking: boolean;
  /** 打开光标那张的大图（父级会记住"这是从组层来的"） */
  onOpenPreview: (assetId: string) => void;
  /** 是否有浮层（大图 / 二次确认）盖在本层之上：它们收起时本层要把键盘焦点收回来 */
  coveredAbove: boolean;
  onThumbError: () => void;
  onThumbLoad: () => void;
  onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(GROUP_FALLBACK_COLUMNS);

  /*
   * 组层是独立浮层，按键不会冒泡回网格——这里自己接，并把焦点拿过来。
   * 上方浮层（大图 / Shift+D 的二次确认）收起时同样要收回焦点：
   * 用户若是点它们的关闭/取消按钮出来的，焦点已经随那个按钮消失，
   * 不收回来的话 Esc 退层、方向键、打标键就此全部失灵。
   */
  useEffect(() => {
    if (!coveredAbove) boxRef.current?.focus();
  }, [coveredAbove]);

  /* 上下移动要跨"一行"，行有几张取决于当前窗口宽度。量出来而不是写死：
     写死的近似值在宽屏上会让 ↓ 只挪半行，读起来像光标乱跳。 */
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
      const width = el.clientWidth;
      if (width <= 0) return; // 量不到就保留上一次/兜底值，别把列数算成 0
      setColumns(
        Math.max(
          1,
          Math.floor(
            (width + GROUP_TILE_GAP) / (GROUP_TILE_MIN_WIDTH + GROUP_TILE_GAP),
          ),
        ),
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  /*
   * 光标那张被移走（分类/精选/整组标删）之后，接住它**原来的位置**——
   * 后一张补位过来，「按一键→看下一张」的循环不会断在「光标归零」上。
   * 归零是此前展开层的老毛病：打完一张标，光标默默跳回组内第一张，
   * 下一次按键就打在了另一张上。
   */
  const ids = items.map((i) => i.id);
  const lastIdxRef = useRef(0);
  const rawIdx = cursorId ? ids.indexOf(cursorId) : -1;
  const cursorIdx =
    rawIdx >= 0
      ? rawIdx
      : Math.min(lastIdxRef.current, Math.max(0, items.length - 1));
  lastIdxRef.current = cursorIdx;
  const cursorAsset = items[cursorIdx] ?? null;

  /* 补位结果要同步回上层：上层还持着一个已经不存在的 id 的话，
     「界面高亮的是 A、打标打在 B 上」这种静默错位就会发生 */
  useEffect(() => {
    if (rawIdx < 0 && cursorAsset && cursorAsset.id !== cursorId) {
      onCursorChange(cursorAsset.id);
    }
  }, [rawIdx, cursorAsset, cursorId, onCursorChange]);

  /** 打标目标:组内已选中的成员;都没选就用光标那张 */
  const layerTargets = useCallback(() => {
    const selected = items.filter((i) => selectedSet.has(i.id)).map((i) => i.id);
    if (selected.length > 0) return selected;
    const at = items[cursorIdx];
    return at ? [at.id] : [];
  }, [items, selectedSet, cursorIdx]);

  const handleLayerKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    /*
     * 焦点圈定。本层声明了 aria-modal="true"，但那只是**说**自己是模态——
     * 浏览器不会因此拦住 Tab。不圈定的实测后果：Tab 几下焦点就落到层背后的
     * 网格与按钮上，而此时 Esc 又被本层的键盘流吃掉，用户被困在一个
     * 看得见却操作不了的界面里。
     */
    if (trapTabFocus(boxRef.current, event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // 焦点在本层的按钮（关闭 / 全选 / 反选 / 保留推荐…）上时，Enter/空格归它自己
    if (shouldYieldShortcut(event.target, event.key)) return;
    const action = resolveShortcut(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
      },
      categories,
    );
    if (!action) return;

    switch (action.type) {
      case "move": {
        const next = nextIndexInGrid(action.key, cursorIdx, items.length, columns);
        if (next >= 0 && items[next]) onCursorChange(items[next].id);
        break;
      }
      case "clearSelection":
        // 组层里的 Esc = 退一层回网格（不是"清空选区"）：
        // 层级导航优先于选区管理，否则用户要按两次 Esc 才出得去
        onClose();
        break;
      case "preview":
        // 空格 / Enter：再深一层，看这一张的大图
        if (cursorAsset) onOpenPreview(cursorAsset.id);
        break;
      case "toggle":
        if (cursorAsset) onSelect(cursorAsset.id, { meta: true });
        break;
      case "selectAll":
        for (const item of items) {
          if (!selectedSet.has(item.id)) onSelect(item.id, { meta: true });
        }
        break;
      case "assign":
        onAssign(layerTargets(), action.categoryId);
        break;
      case "other": {
        const other = categories.find((c) => c.kind === "other");
        if (other) onAssign(layerTargets(), other.id);
        break;
      }
      case "curate":
        onCurate(layerTargets());
        break;
      case "markDelete":
        onToggleDelete(layerTargets());
        break;
      case "unmarkDelete":
        // 组层里按 U 曾经走 toggle：对未标记项按 U 反而把它标进待删清单，
        // 而且无声（底部待删条被本层整个盖住，用户根本看不到多了一条）
        onUnmarkDelete(layerTargets());
        break;
      case "confirmDelete":
        // Shift+D 与主屏同一语义:标完直接进确认流,不必先退出组层。
        // 清单为空 / 打包锁住时由 requestDeleteConfirm 发通知说明,不会静默落空
        onConfirmDelete();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  // 「一组保留 1-2 张、其余批量处理」(PRD §5.4)的一键版
  const suggested = items.filter((i) => i.judgement?.suggestedKeep);
  const keepRecommended = () => {
    const keep = new Set(suggested.map((i) => i.id));
    const rest = items.filter((i) => !keep.has(i.id)).map((i) => i.id);
    // 语义是「其余标删」，不是开关：余量恰好已全标时再按一次不该把它们全撤回
    if (rest.length > 0) onMarkDelete(rest);
  };
  const selectedCount = items.filter((i) => selectedSet.has(i.id)).length;

  return (
    <div
      className="group-layer"
      role="dialog"
      aria-modal="true"
      aria-label={`连拍组，共 ${items.length} 张`}
      data-testid="group-overlay"
      ref={boxRef}
      tabIndex={-1}
      onKeyDown={handleLayerKey}
    >
      <div className="group-layer__bar">
        <span className="text-sm">连拍组（{items.length} 张）</span>
        {selectedCount > 0 ? (
          <Badge tone="ok">已选 {selectedCount}</Badge>
        ) : null}
        {/*
          「建议保留」的家就在这里(后端 analysis.rs:318 的口径是「组内首选」)。
          它刚从全局筛选里被拿掉,所以必须在这一层把话说全:
          既说清它只在组内成立,也说清 AI 不会替你动文件。
        */}
        <span
          className="text-2xs dim"
          data-testid="group-suggest-scope"
          title="后端只在连拍组内部评选「建议保留」；不成组的单张再高分也不标，所以这个概念不做全局筛选。"
        >
          「建议保留」只在连拍组内成立：AI 从同一串连拍里荐优，仅给建议，绝不替你动文件
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--icon push-right"
          data-testid="group-close"
          aria-label="退出连拍组，回到网格"
          title="Esc 退回网格"
          onClick={onClose}
        >
          <IconClose />
        </button>
      </div>

      <div className="group-layer__tools">
        <button
          type="button"
          className="btn btn--sm"
          data-testid="group-keep-recommended"
          disabled={
            deliveryWorking ||
            suggested.length === 0 ||
            suggested.length === items.length
          }
          title={
            deliveryWorking
              ? "交付打包进行中，暂不能新增待删标记"
              : suggested.length === 0
                ? "本组还没有「建议保留」——先跑一次 AI 选片分析"
                : `保留 ${suggested.length} 张建议项,其余 ${items.length - suggested.length} 张标删(仍需底部确认才移入回收站)`
          }
          onClick={keepRecommended}
        >
          保留推荐，其余标删
        </button>
        {/* 按钮为什么能按/不能按,写在脸上而不是只藏在 title 里 */}
        {suggested.length === 0 ? (
          <span className="text-2xs dim" data-testid="group-suggest-none">
            本组暂无「建议保留」——先跑「AI 选片分析」，或直接手动挑
          </span>
        ) : suggested.length === items.length ? (
          <span className="text-2xs dim" data-testid="group-suggest-all">
            本组每张都被推荐保留，没有可标删的余量
          </span>
        ) : (
          <span className="text-2xs dim" data-testid="group-suggest-count">
            AI 在本组推荐保留 {suggested.length} 张，其余 {items.length - suggested.length} 张会进待删清单
          </span>
        )}
        <button
          type="button"
          className="btn btn--sm push-right"
          data-testid="group-select-all"
          onClick={() => {
            for (const item of items) {
              if (!selectedSet.has(item.id)) onSelect(item.id, { meta: true });
            }
          }}
        >
          全选
        </button>
        <button
          type="button"
          className="btn btn--sm"
          data-testid="group-invert"
          onClick={() => {
            for (const item of items) onSelect(item.id, { meta: true });
          }}
        >
          反选
        </button>
      </div>

      <div className="group-layer__grid" ref={gridRef} role="grid" aria-label="连拍组内素材">
        {items.map((asset, i) => (
          <div
            key={asset.id}
            role="gridcell"
            aria-selected={selectedSet.has(asset.id)}
            data-testid="group-item"
            data-asset={asset.id}
            className={`asset${selectedSet.has(asset.id) ? " asset--selected" : ""}${
              i === cursorIdx ? " asset--focused" : ""
            }${markedSet.has(asset.id) ? " asset--marked" : ""}`}
            onClick={(e) => {
              onCursorChange(asset.id);
              onSelect(asset.id, {
                shift: e.shiftKey,
                meta: e.metaKey || e.ctrlKey,
              });
            }}
            onDoubleClick={() => onOpenPreview(asset.id)}
          >
            <GroupThumb
              asset={asset}
              onThumbError={onThumbError}
              onThumbLoad={onThumbLoad}
            />
            <span className="asset__name truncate">{asset.fileName}</span>
            {/* 只有这一层能同时看见同组其他张,「建议保留」才有比较对象 */}
            <JudgementBadges judgement={asset.judgement} showSuggestedKeep />
            {curatedIds.has(asset.id) ? (
              <span
                className="asset__flag asset__flag--curated"
                title="已精选(复制进精选/待修)"
              >
                ✓
              </span>
            ) : null}
            {markedSet.has(asset.id) ? (
              <span className="asset__flag asset__flag--delete" title="已标记待删除">
                D
              </span>
            ) : null}
          </div>
        ))}
      </div>

      <div className="group-layer__foot">
        <div className="hint-bar">
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            <Kbd>←</Kbd>
            <Kbd>→</Kbd> 组内移动
          </span>
          <span>
            <Kbd>空格</Kbd>/<Kbd>Enter</Kbd> 看大图 · <Kbd>X</Kbd> 选中 ·{" "}
            <Kbd>⌘A</Kbd> 全选
          </span>
          <span data-testid="group-hint-mark">
            <Kbd>1</Kbd>–<Kbd>9</Kbd> 分类 · <Kbd>P</Kbd> 精选 · <Kbd>O</Kbd> 其他 ·{" "}
            <Kbd>D</Kbd> 标删/取消 · <Kbd>U</Kbd> 只取消标删 ·{" "}
            <Kbd>Shift+D</Kbd> 提交
          </span>
          <span data-testid="group-esc-hint">
            <Kbd>Esc</Kbd> 退一层（大图 → 组 → 网格）
          </span>
        </div>

        {/*
          屏底那条待删清单被本层整个盖住，所以在这里复述一遍：
          组里按 D 标了几张、Shift+D 现在能不能按，都得看得见。
          鼠标路径也给上——只留快捷键等于把这条路藏起来。
        */}
        {pendingCount > 0 ? (
          <button
            type="button"
            className="btn btn--sm btn--danger-solid"
            data-testid="group-confirm-delete"
            disabled={deliveryWorking}
            title={
              deliveryWorking
                ? "交付打包进行中，暂不能移入回收站"
                : "快捷键 Shift+D"
            }
            onClick={onConfirmDelete}
          >
            确认移入回收站（{pendingCount}）
          </button>
        ) : (
          <span className="text-2xs dim" data-testid="group-pending-empty">
            待删清单为空 —— 按 <Kbd>D</Kbd> 标删后可用 <Kbd>Shift+D</Kbd> 提交
          </span>
        )}
      </div>
    </div>
  );
}


/** 展开层缩略图：404 转占位，并计入连续失败统计（与主网格同一口径） */
function GroupThumb({
  asset,
  onThumbError,
  onThumbLoad,
}: {
  asset: SortingAsset;
  onThumbError: () => void;
  onThumbLoad: () => void;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [asset.thumbnail]);

  if (asset.thumbReady && asset.thumbnail && !failed) {
    return (
      <img
        className="asset__thumb"
        src={asset.thumbnail}
        alt=""
        data-testid="group-item-thumb"
        onError={() => {
          setFailed(true);
          onThumbError();
        }}
        onLoad={onThumbLoad}
      />
    );
  }
  return (
    <div className="asset__thumb asset__thumb--empty" data-testid="group-item-no-thumb">
      <span className="text-2xs dim">{failed ? "预览不可用" : "索引中"}</span>
    </div>
  );
}
