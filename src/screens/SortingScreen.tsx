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
  resolveEntryIds,
  emptySelection,
  initialPendingDelete,
  JUDGEMENT_FILTER_LABEL,
  moveCursor,
  nextCursorAfterRemoval,
  pendingDeleteReducer,
  pruneSelection,
  removedEntryIds,
  resolveShortcut,
  selectAll,
  toggleSelection,
  type JudgementFilter,
  type Selection,
} from "../lib/sorting";
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
  const loadedCountRef = useRef(0);
  const lastRefreshRef = useRef(0);
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

  const previewIndex = previewId
    ? previewAssets.findIndex((a) => a.id === previewId)
    : -1;
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
  const openPreview = useCallback((assetId: string) => {
    withViewTransition(() => setPreviewId(assetId));
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
      if (previewId && assetIds.includes(previewId)) {
        setSelection((prev) => ({ ...prev, cursor: previewId, anchor: previewId }));
      }
      setPreviewId(null);
    });
  }, [previewId, assetIds]);

  /* 展开层没有共用实体，进场交给 CSS 关键帧（缩放 + 淡入）更好看；
     退场没有挂载动画可用，才需要视图过渡兜住。 */
  const openGroupOverlay = useCallback((groupId: string) => {
    setOpenGroup(groupId);
  }, []);

  const closeGroupOverlay = useCallback(() => {
    withViewTransition(() => setOpenGroup(null));
  }, []);

  /* ---------------- 数据加载 ---------------- */

  // 切项目把旧项目的资产/选择/预览/待删标记全部清零(codex 评审 P1):
  // 侧栏切项目页面不再卸载,旧相对路径 + 新 projectId 组合起来
  // 可能移动/删除新项目里的同名文件
  useEffect(() => {
    setAssets([]);
    setTotal(0);
    setSelection(emptySelection);
    setPreviewId(null);
    setOpenGroup(null);
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
    try {
      const collected: SortingAsset[] = [];
      let latestTotal = 0;
      while (collected.length < want) {
        const page = await api.listPendingAssets(
          projectId,
          collected.length,
          PAGE_SIZE,
        );
        latestTotal = page.total;
        collected.push(...page.items);
        if (page.items.length < PAGE_SIZE) break;
      }
      setAssets(collected);
      setTotal(latestTotal);
    } catch (err) {
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
    try {
      const page = await api.listPendingAssets(projectId, assets.length, PAGE_SIZE);
      setAssets((prev) => [...prev, ...page.items]);
      setTotal(page.total);
    } catch (err) {
      // 翻页失败不能吞：已加载的保留，错误显式可见并可重试
      setPageError(err instanceof Error ? err.message : String(err));
    } finally {
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

  // runCurate 定义在下面，用 ref 打通引用（两者都是稳定回调）
  const runCurateRef = useRef<(targetsOverride?: string[]) => Promise<void>>(
    async () => {},
  );

  const runAssign = useCallback(
    async (categoryId: string, targetsOverride?: string[]) => {
      // override 是预览/组浮层传来的**已解析** assetId(评审 3.2)
      const targets =
        targetsOverride ?? resolveEntryIds(entries, actionTargets(selection));
      if (!projectId || targets.length === 0 || busy || deliveryWorking) return;
      // 精选永远是复制语义，move 到 curated 会让素材卡在没有流程的位置
      if (categories.find((c) => c.id === categoryId)?.kind === "curated") {
        await runCurateRef.current(targetsOverride);
        return;
      }
      setBusy(true);
      try {
        const result = await api.moveAssets(projectId, targets, categoryId);
        applyBulk(result, "移动");
        // 撤销窗口(评审 3.5):只对真正移走的部分开;移入待分类的撤销没有意义
        const cat = categories.find((c) => c.id === categoryId);
        if (result.succeeded.length > 0 && cat && cat.kind !== "inbox") {
          setLastMove({ assetIds: result.succeeded, categoryName: cat.name });
        }
        void refreshCategories();
      } catch (err) {
        notify(
          "error",
          "sorting-move-failed",
          `移动失败：${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setBusy(false);
      }
    },
    [
      projectId,
      selection,
      busy,
      deliveryWorking,
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
    setUndoing(true);
    try {
      const result = await api.moveAssets(projectId, lastMove.assetIds, inbox.id);
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
    categories,
    refreshLoadedAssets,
    refreshCategories,
    notify,
  ]);

  const runCurate = useCallback(
    async (targetsOverride?: string[]) => {
      const actedEntries = targetsOverride ?? actionTargets(selection);
      const targets = targetsOverride ?? resolveEntryIds(entries, actedEntries);
      if (!projectId || targets.length === 0 || busy || deliveryWorking) return;
      setBusy(true);
      try {
        const result = await api.curateAssets(projectId, targets);
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
        notify(
          "error",
          "sorting-curate-failed",
          `加入精选失败：${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setBusy(false);
      }
    },
    [
      projectId,
      selection,
      busy,
      deliveryWorking,
      entries,
      refreshCategories,
      notify,
      pulseCommit,
      rememberCurated,
    ],
  );

  runCurateRef.current = runCurate;

  /** D 是开关(评审 3.8):目标全部已标记 → 取消,否则标记 */
  const toggleMark = useCallback(
    (ids: string[]) => {
      if (deliveryWorking || ids.length === 0) return;
      const allMarked = ids.every((id) => markedSet.has(id));
      dispatchDelete({ type: allMarked ? "unmark" : "mark", assetIds: ids });
    },
    [deliveryWorking, markedSet],
  );

  /* ---------------- 预览内打标(评审 3.2):作用于眼前这张,操作后自动前进 ---------------- */

  const previewAsset = previewIndex >= 0 ? (previewAssets[previewIndex] ?? null) : null;

  const previewAssign = useCallback(
    (categoryId: string) => {
      if (!previewAsset) return;
      // 先站到下一张再移走当前张:大图不闪断,失败时素材还在、toast 会说话
      const nextId =
        previewAssets[previewIndex + 1]?.id ??
        previewAssets[previewIndex - 1]?.id ??
        null;
      setPreviewId(nextId);
      void runAssign(categoryId, [previewAsset.id]);
    },
    [previewAsset, previewAssets, previewIndex, runAssign],
  );

  const previewCurate = useCallback(() => {
    if (!previewAsset) return;
    void runCurate([previewAsset.id]);
    const nextId = previewAssets[previewIndex + 1]?.id ?? null;
    if (nextId) setPreviewId(nextId);
  }, [previewAsset, previewAssets, previewIndex, runCurate]);

  const previewToggleDelete = useCallback(() => {
    if (!previewAsset) return;
    toggleMark([previewAsset.id]);
    const nextId = previewAssets[previewIndex + 1]?.id ?? null;
    if (nextId) setPreviewId(nextId);
  }, [previewAsset, previewAssets, previewIndex, toggleMark]);

  const commitDelete = useCallback(async () => {
    // 双保险：即使对话框以某种方式被触发，打包期间也绝不下发删除
    if (!projectId || deliveryWorkingRef.current) return;
    dispatchDelete({ type: "commitStarted" });
    try {
      const result = await api.trashAssets(projectId, pendingDelete.marked);
      dispatchDelete({
        type: "commitFinished",
        succeeded: result.succeeded,
        failed: result.failed,
      });
      applyBulk(result, "移入回收站");
    } catch (err) {
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
    if (pendingDelete.marked.length === 0 || deliveryWorking) return;
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
      onConfirm: () => void commitDelete(),
    });
  }

  /* ---------------- 键盘流 ---------------- */

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // 预览打开时键盘由 Lightbox 全权接管(评审 3.2):这里不再处理,
      // 否则同一击键会两处生效——网格里作用的还是进预览前的旧选中
      if (previewId !== null) return;
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
          // 光标停在折叠组上:Enter 展开组(评审 3.4),不再直接跳进第一张
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
          dispatchDelete({
            type: "unmark",
            assetIds: resolveEntryIds(entries, actionTargets(selection)),
          });
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
      openPreview,
      closePreview,
      openGroupOverlay,
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
                  onClick={() =>
                    category.kind === "curated"
                      ? void runCurate()
                      : void runAssign(category.id)
                  }
                  title={
                    category.kind === "inbox"
                      ? category.name
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

            <span className="push-right row-inline text-xs">
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
                还没有 AI 判定结果——先点右上角「AI 选片分析」，跑完才有「建议保留/放弃」可筛。
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

          {/* 网格 */}
          <div
            className="sorting__grid-wrap"
            ref={gridWrapRef}
            tabIndex={0}
            onKeyDown={handleKeyDown}
            data-testid="sorting-grid-wrap"
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
            <div className="hint-bar">
              <span>
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
                <Kbd>←</Kbd>
                <Kbd>→</Kbd> 移动
              </span>
              <span>
                <Kbd>空格</Kbd> 选中 · <Kbd>Shift</Kbd>+方向 连选 · <Kbd>⌘A</Kbd> 全选 ·{" "}
                <Kbd>Esc</Kbd> 清选
              </span>
              <span>
                <Kbd>1</Kbd>–<Kbd>9</Kbd> 分类 · <Kbd>P</Kbd> 精选 · <Kbd>O</Kbd> 其他 ·{" "}
                <Kbd>D</Kbd> 标删/取消 · <Kbd>Shift+D</Kbd> 提交
              </span>
              <span>
                <Kbd>Enter</Kbd> 全屏/展开组
              </span>
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
                  disabled={undoing || busy}
                  onClick={() => void undoLastMove()}
                >
                  {undoing ? "撤销中…" : "撤销"}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-label="收起撤销提示"
                  onClick={() => setLastMove(null)}
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
              <button
                type="button"
                className="btn btn--sm"
                data-testid="sorting-unmark-all"
                onClick={() => dispatchDelete({ type: "clear" })}
              >
                取消标记
              </button>
              <button
                type="button"
                className="btn btn--sm btn--danger-solid"
                data-testid="sorting-confirm-delete"
                disabled={deliveryWorking}
                title={
                  deliveryWorking
                    ? "交付打包进行中，暂不能移入回收站"
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
        <GroupOverlay
          items={openGroupItems}
          selectedSet={selectedSet}
          markedSet={markedSet}
          curatedIds={curatedIds}
          categories={categories}
          /* 关键：连选也在**组成员 id 空间**里做，
             展开层选中的裸素材 id 由 resolveEntryIds 兜住，不再被静默丢弃 */
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
          onThumbError={onThumbError}
          onThumbLoad={onThumbLoad}
          onClose={closeGroupOverlay}
        />
      ) : null}

      {previewIndex >= 0 && previewAssets[previewIndex] ? (
        <AssetLightbox
          asset={previewAssets[previewIndex]}
          index={previewIndex}
          total={previewAssets.length}
          categories={categories}
          marked={markedSet.has(previewAssets[previewIndex].id)}
          curated={curatedIds.has(previewAssets[previewIndex].id)}
          onClose={closePreview}
          onPrev={() =>
            setPreviewId(previewAssets[Math.max(0, previewIndex - 1)].id)
          }
          onNext={() =>
            setPreviewId(
              previewAssets[
                Math.min(previewAssets.length - 1, previewIndex + 1)
              ].id,
            )
          }
          onAssign={previewAssign}
          onCurate={previewCurate}
          onToggleDelete={previewToggleDelete}
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

/** 展开层键盘上下移动一次跨几张(网格为 auto-fill,取常见列数的近似) */
const GROUP_OVERLAY_ROW_STEP = 4;

/**
 * 组内网格：选中语义与主网格一致（写的是同一个选区）。
 *
 * 键盘流自洽(评审 3.4):浮层自己有光标,方向键在**组成员**里移动、
 * Esc 关层、空格选中、打标键作用于组内选中(或光标项)——
 * 不再把按键交给背后的主网格,那会让方向键动的是看不见的东西。
 */
function GroupOverlay({
  items,
  selectedSet,
  markedSet,
  curatedIds,
  categories,
  onSelect,
  onAssign,
  onCurate,
  onToggleDelete,
  onThumbError,
  onThumbLoad,
  onClose,
}: {
  items: SortingAsset[];
  selectedSet: Set<string>;
  markedSet: Set<string>;
  curatedIds: Set<string>;
  categories: SortingCategory[];
  onSelect: (id: string, modifiers: { shift?: boolean; meta?: boolean }) => void;
  onAssign: (assetIds: string[], categoryId: string) => void;
  onCurate: (assetIds: string[]) => void;
  onToggleDelete: (assetIds: string[]) => void;
  onThumbError: () => void;
  onThumbLoad: () => void;
  onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [cursorIdx, setCursorIdx] = useState(0);
  // 展开层是 overlay，按键不会冒泡回网格——这里自己接，并把焦点拿过来
  useEffect(() => {
    boxRef.current?.focus();
  }, []);

  /** 打标目标:组内已选中的成员;都没选就用光标那张 */
  const overlayTargets = useCallback(() => {
    const selected = items.filter((i) => selectedSet.has(i.id)).map((i) => i.id);
    if (selected.length > 0) return selected;
    const at = items[cursorIdx];
    return at ? [at.id] : [];
  }, [items, selectedSet, cursorIdx]);

  const handleOverlayKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const { key } = event;
    const step =
      key === "ArrowRight"
        ? 1
        : key === "ArrowLeft"
          ? -1
          : key === "ArrowDown"
            ? GROUP_OVERLAY_ROW_STEP
            : key === "ArrowUp"
              ? -GROUP_OVERLAY_ROW_STEP
              : null;
    if (step !== null) {
      event.preventDefault();
      event.stopPropagation();
      setCursorIdx((prev) => Math.min(items.length - 1, Math.max(0, prev + step)));
      return;
    }
    if (key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (key === " ") {
      event.preventDefault();
      event.stopPropagation();
      const at = items[cursorIdx];
      if (at) onSelect(at.id, { meta: true });
      return;
    }
    const action = resolveShortcut(
      {
        key,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
      },
      categories,
    );
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    const targets = overlayTargets();
    if (targets.length === 0) return;
    if (action.type === "assign") onAssign(targets, action.categoryId);
    else if (action.type === "other") {
      const other = categories.find((c) => c.kind === "other");
      if (other) onAssign(targets, other.id);
    } else if (action.type === "curate") onCurate(targets);
    else if (action.type === "markDelete" || action.type === "unmarkDelete") {
      onToggleDelete(targets);
    }
  };

  // 「一组保留 1-2 张、其余批量处理」(PRD §5.4)的一键版
  const suggested = items.filter((i) => i.judgement?.suggestedKeep);
  const keepRecommended = () => {
    const keep = new Set(suggested.map((i) => i.id));
    const rest = items.filter((i) => !keep.has(i.id)).map((i) => i.id);
    if (rest.length > 0) onToggleDelete(rest);
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="dialog dialog--wide"
        role="dialog"
        aria-modal="true"
        aria-label="连拍组"
        data-testid="group-overlay"
        ref={boxRef}
        tabIndex={0}
        onKeyDown={handleOverlayKey}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="dialog__title">连拍组（{items.length} 张）</h2>
        <p className="dialog__message">
          方向键移动、空格选中、P/数字键/D 直接打标；AI 只给建议，不会替你动文件。
        </p>
        <div className="row-inline">
          <button
            type="button"
            className="btn btn--sm"
            data-testid="group-keep-recommended"
            disabled={suggested.length === 0 || suggested.length === items.length}
            title={
              suggested.length === 0
                ? "先运行 AI 选片分析,组内才有「建议保留」"
                : `保留 ${suggested.length} 张建议项,其余 ${items.length - suggested.length} 张标删(仍需底部确认才移入回收站)`
            }
            onClick={keepRecommended}
          >
            保留推荐，其余标删
          </button>
          <button
            type="button"
            className="btn btn--sm"
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
        <div className="group-overlay__grid dialog__form">
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
                setCursorIdx(i);
                onSelect(asset.id, {
                  shift: e.shiftKey,
                  meta: e.metaKey || e.ctrlKey,
                });
              }}
            >
              <GroupThumb
                asset={asset}
                onThumbError={onThumbError}
                onThumbLoad={onThumbLoad}
              />
              <span className="asset__name truncate">{asset.fileName}</span>
              <JudgementBadges judgement={asset.judgement} />
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
        <div className="dialog__actions">
          <button type="button" className="btn" data-testid="group-close" onClick={onClose}>
            关闭
          </button>
        </div>
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
