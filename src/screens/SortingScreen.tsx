/** 屏 5：分类工作台（工况 B 核心，PRD §5.4 键盘驱动分类）。 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import * as api from "../api";
import type {
  BulkResult,
  CuratedFlowHint,
  SortingAsset,
  SortingCategory,
} from "../api/types";
import { AssetLightbox } from "../components/AssetLightbox";
import { ConfirmDialog, type ConfirmRequest } from "../components/ConfirmDialog";
import { DeliveryButton } from "../components/DeliveryPanel";
import { TopBar } from "../components/TopBar";
import { Badge, EmptyState, Kbd, ProgressBar } from "../components/ui";
import { VirtualGrid } from "../components/VirtualGrid";
import { formatBytes, formatTimestamp } from "../lib/format";
import {
  actionTargets,
  buildGridEntries,
  clickSelection,
  filterBySuggestion,
  resolveEntryIds,
  emptySelection,
  initialPendingDelete,
  moveCursor,
  pendingDeleteReducer,
  pruneSelection,
  resolveShortcut,
  selectAll,
  toggleSelection,
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

export function SortingScreen() {
  const { state, dispatch } = useStore();
  const project = state.projects.find((p) => p.id === state.selectedProjectId) ?? null;
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
  const [suggestionOnly, setSuggestionOnly] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
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
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [columns, setColumns] = useState(6);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [busy, setBusy] = useState(false);

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

  const onThumbError = useCallback(() => setThumbFailStreak((n) => n + 1), []);
  const onThumbLoad = useCallback(() => setThumbFailStreak(0), []);

  const visibleAssets = useMemo(
    () => filterBySuggestion(assets, suggestionOnly),
    [assets, suggestionOnly],
  );
  const entries = useMemo(() => buildGridEntries(visibleAssets), [visibleAssets]);
  /** 选区认的是「条目 id」——组条目用合成 id，等高行与选择模型都不受影响 */
  const assetIds = useMemo(() => entries.map((e) => e.id), [entries]);
  const markedSet = useMemo(() => new Set(pendingDelete.marked), [pendingDelete.marked]);
  const selectedSet = useMemo(() => new Set(selection.selected), [selection.selected]);
  const cursorIndex = selection.cursor ? assetIds.indexOf(selection.cursor) : -1;

  const projectId = project?.id ?? null;

  /* ---------------- 数据加载 ---------------- */

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
  const analyzeDoneRev = analyzeJob?.state === "done" ? analyzeJob.revision : 0;
  useEffect(() => {
    if (!analyzeDoneRev) return;
    void refreshLoadedAssets();
  }, [analyzeDoneRev, refreshLoadedAssets]);

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
        setSelection((prev) => pruneSelection(prev, result.succeeded));
      }
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
  const runCurateRef = useRef<() => Promise<void>>(async () => {});

  const runAssign = useCallback(
    async (categoryId: string) => {
      const targets = resolveEntryIds(entries, actionTargets(selection));
      if (!projectId || targets.length === 0 || busy || deliveryWorking) return;
      // 精选永远是复制语义，move 到 curated 会让素材卡在没有流程的位置
      if (categories.find((c) => c.id === categoryId)?.kind === "curated") {
        await runCurateRef.current();
        return;
      }
      setBusy(true);
      try {
        const result = await api.moveAssets(projectId, targets, categoryId);
        applyBulk(result, "移动");
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

  const runCurate = useCallback(async () => {
    const targets = resolveEntryIds(entries, actionTargets(selection));
    if (!projectId || targets.length === 0 || busy || deliveryWorking) return;
    setBusy(true);
    try {
      const result = await api.curateAssets(projectId, targets);
      // 精选是「复制一份进待修」，原件留在待分类，所以不从列表移除
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
  }, [projectId, selection, busy, deliveryWorking, entries, refreshCategories, notify]);

  runCurateRef.current = runCurate;

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
    setAnalysisError(null);
    try {
      const job = await api.startAnalysis(projectId);
      dispatch({ type: "jobProgress", job });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setAnalysisError(message);
      notify("error", "analysis-start-failed", `分析作业未能启动：${message}`);
    }
  }

  function requestDeleteConfirm() {
    if (pendingDelete.marked.length === 0 || deliveryWorking) return;
    dispatchDelete({ type: "requestConfirm" });
    setConfirm({
      title: `把 ${pendingDelete.marked.length} 个文件移入回收站？`,
      message:
        "文件会移入项目内 .ocard/trash，可以随时恢复；此操作不会物理删除任何文件。",
      confirmLabel: "移入回收站",
      onConfirm: () => void commitDelete(),
    });
  }

  /* ---------------- 键盘流 ---------------- */

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const action = resolveShortcut(
        {
          key: event.key,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
        },
        categories,
        { previewOpen: previewIndex !== null },
      );
      if (!action) return;
      event.preventDefault();

      switch (action.type) {
        case "move": {
          if (previewIndex !== null) {
            const delta = action.key === "ArrowRight" ? 1 : -1;
            const next = Math.min(
              assets.length - 1,
              Math.max(0, previewIndex + delta),
            );
            setPreviewIndex(next);
            setSelection(clickSelection(assetIds, selection, assetIds[next]));
            return;
          }
          setSelection((prev) =>
            moveCursor(assetIds, prev, action.key, columns, action.extend),
          );
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
        case "preview": {
          if (cursorIndex >= 0) setPreviewIndex(cursorIndex);
          return;
        }
        case "closePreview":
          setPreviewIndex(null);
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
          if (deliveryWorking) return;
          dispatchDelete({
            type: "mark",
            assetIds: resolveEntryIds(entries, actionTargets(selection)),
          });
          return;
        case "unmarkDelete":
          dispatchDelete({
            type: "unmark",
            assetIds: resolveEntryIds(entries, actionTargets(selection)),
          });
          return;
      }
    },
    [
      categories,
      previewIndex,
      assets.length,
      assetIds,
      selection,
      columns,
      cursorIndex,
      deliveryWorking,
      entries,
      runAssign,
      runCurate,
    ],
  );

  /* ---------------- 渲染 ---------------- */

  if (!project) {
    return (
      <>
        <TopBar title="分类工作台" />
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
        title="分类工作台"
        subtitle={project.folderName}
        subtitleMono
        actions={
          <>
            <span className="text-xs dim" data-testid="sorting-remaining">
              待分类 {total}
            </span>
            <button
              type="button"
              className="btn btn--sm"
              data-testid="sorting-analyze"
              disabled={analyzing}
              onClick={() => void startAnalysis()}
            >
              {analyzing
                ? `分析中 ${analyzeJob?.done ?? 0}/${analyzeJob?.total ?? 0}`
                : "分析"}
            </button>
            <DeliveryButton projectId={project.id} />
            <button
              type="button"
              className="btn btn--sm"
              data-testid="sorting-open-trash"
              /* 打包期间不许离开本屏：结果面板不能静默蒸发 */
              disabled={deliveryWorking}
              title={deliveryWorking ? "打包进行中，请稍候" : "回收站"}
              onClick={() => dispatch({ type: "navigate", route: "trash" })}
            >
              回收站
            </button>
          </>
        }
      />

      <div className="content content--flush">
        <div className="sorting">
          {/* 分类条：计数 + 数字键提示 */}
          <div className="sorting__bar" data-testid="sorting-categories">
            {categories.map((category) => (
              <button
                key={category.id}
                type="button"
                className="chip"
                data-testid="sorting-category"
                data-category={category.id}
                disabled={category.kind === "inbox" || busy || deliveryWorking}
                /* 精选是「复制进精选/待修」，不是移动——点击路径必须与 P 键一致 */
                onClick={() =>
                  category.kind === "curated"
                    ? void runCurate()
                    : void runAssign(category.id)
                }
                title={
                  category.kind === "custom"
                    ? `按 ${category.hotkey} 分到「${category.name}」`
                    : category.name
                }
              >
                {category.hotkey ? <Kbd>{category.hotkey}</Kbd> : null}
                {category.kind === "curated" ? <Kbd>P</Kbd> : null}
                {category.kind === "other" ? <Kbd>O</Kbd> : null}
                <span>{category.name}</span>
                <span className="chip__count">{category.count}</span>
              </button>
            ))}

            <label className="row-inline text-xs push-right">
              <input
                type="checkbox"
                data-testid="sorting-suggestion-filter"
                checked={suggestionOnly}
                onChange={(e) => setSuggestionOnly(e.currentTarget.checked)}
              />
              只看建议保留
            </label>
          </div>

          {analysisError ? (
            <div className="sorting__indexing">
              <span className="field__error" role="alert" data-testid="sorting-analysis-error">
                分析未能启动：{analysisError}
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
              <EmptyState>待分类里没有素材了。</EmptyState>
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
                keyOf={(entry) => entry.id}
                renderItem={(entry, index) =>
                  entry.kind === "group" ? (
                    <GroupCell
                      key={entry.id}
                      entry={entry}
                      selected={selectedSet.has(entry.id)}
                      focused={selection.cursor === entry.id}
                      markedCount={
                        entry.items.filter((i) => markedSet.has(i.id)).length
                      }
                      onSelect={(modifiers) =>
                        setSelection((prev) =>
                          clickSelection(assetIds, prev, entry.id, modifiers),
                        )
                      }
                      onExpand={() => setOpenGroup(entry.groupId)}
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
                      marked={markedSet.has(entry.id)}
                      onSelect={(modifiers) =>
                        setSelection((prev) =>
                          clickSelection(assetIds, prev, entry.id, modifiers),
                        )
                      }
                      onOpen={() => setPreviewIndex(index)}
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
                <Kbd>空格</Kbd> 选中 · <Kbd>Shift</Kbd>+方向 连选
              </span>
              <span>
                <Kbd>1</Kbd>–<Kbd>9</Kbd> 分类 · <Kbd>P</Kbd> 精选 · <Kbd>O</Kbd> 其他 ·{" "}
                <Kbd>D</Kbd> 标删
              </span>
              <span>
                <Kbd>Enter</Kbd> 全屏
              </span>
              {selection.selected.length > 0 ? (
                <span className="push-right" data-testid="sorting-selected-count">
                  已选 {selection.selected.length}
                </span>
              ) : null}
            </div>

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
                  deliveryWorking ? "交付打包进行中，暂不能移入回收站" : undefined
                }
                onClick={requestDeleteConfirm}
              >
                确认移入回收站
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {openGroup ? (
        <GroupOverlay
          items={
            entries.find((e) => e.kind === "group" && e.groupId === openGroup)
              ?.kind === "group"
              ? (entries.find(
                  (e) => e.kind === "group" && e.groupId === openGroup,
                ) as { items: SortingAsset[] }).items
              : []
          }
          selectedSet={selectedSet}
          markedSet={markedSet}
          onSelect={(id, modifiers) =>
            setSelection((prev) => clickSelection(assetIds, prev, id, modifiers))
          }
          onClose={() => setOpenGroup(null)}
        />
      ) : null}

      {previewIndex !== null && assets[previewIndex] ? (
        <AssetLightbox
          asset={assets[previewIndex]}
          index={previewIndex}
          total={assets.length}
          onClose={() => setPreviewIndex(null)}
          onPrev={() => setPreviewIndex(Math.max(0, previewIndex - 1))}
          onNext={() =>
            setPreviewIndex(Math.min(assets.length - 1, previewIndex + 1))
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

  return (
    <div
      role="gridcell"
      aria-selected={selected}
      data-testid="asset-cell"
      data-asset={asset.id}
      data-marked={marked || undefined}
      className={`asset${selected ? " asset--selected" : ""}${
        focused ? " asset--focused" : ""
      }${marked ? " asset--marked" : ""}`}
      onClick={(e) => onSelect({ shift: e.shiftKey, meta: e.metaKey || e.ctrlKey })}
      onDoubleClick={onOpen}
    >
      {asset.thumbReady && asset.thumbnail && !thumbFailed ? (
        <img
          className="asset__thumb"
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
        <div className="asset__thumb asset__thumb--empty" data-testid="asset-no-thumb">
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


/** 判定角标：AI 只标注，不触发任何文件操作 */
function JudgementBadges({ judgement }: { judgement?: SortingAsset["judgement"] }) {
  if (!judgement) return null;
  return (
    <span className="asset__judge" data-testid="asset-judgement">
      {judgement.suggestedKeep ? (
        <Badge tone="ok">建议保留</Badge>
      ) : null}
      {judgement.blurry ? <Badge tone="warn">糊</Badge> : null}
      {judgement.overExposed ? <Badge tone="warn">过曝</Badge> : null}
      {judgement.underExposed ? <Badge tone="warn">欠曝</Badge> : null}
      {/* 分数只用区间表达，不显示数值 */}
      {judgement.score < 0.4 ? <span className="dot judge-dot--low" title="低分" /> : null}
    </span>
  );
}

/** 连拍组：恰占一格，角标 ×N；展开走 overlay */
function GroupCell({
  entry,
  selected,
  focused,
  markedCount,
  onSelect,
  onExpand,
  onThumbError,
  onThumbLoad,
}: {
  entry: { id: string; groupId: string; items: SortingAsset[] };
  selected: boolean;
  focused: boolean;
  markedCount: number;
  onSelect: (modifiers: { shift?: boolean; meta?: boolean }) => void;
  onExpand: () => void;
  onThumbError: () => void;
  onThumbLoad: () => void;
}) {
  // 封面优先用组内「建议保留」的那张
  const cover =
    entry.items.find((i) => i.judgement?.suggestedKeep) ?? entry.items[0];
  const [failed, setFailed] = useState(false);

  return (
    <div
      role="gridcell"
      aria-selected={selected}
      data-testid="asset-group"
      data-group={entry.groupId}
      className={`asset asset--group${selected ? " asset--selected" : ""}${
        focused ? " asset--focused" : ""
      }`}
      onClick={(e) => onSelect({ shift: e.shiftKey, meta: e.metaKey || e.ctrlKey })}
      onDoubleClick={onExpand}
    >
      {cover.thumbReady && cover.thumbnail && !failed ? (
        <img
          className="asset__thumb"
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
        <div className="asset__thumb asset__thumb--empty">
          <span className="text-2xs dim">索引中</span>
        </div>
      )}

      <div className="asset__meta">
        <span className="asset__name truncate">连拍组</span>
        <span className="asset__sub">
          <Badge tone="neutral">×{entry.items.length}</Badge>
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

/** 组内网格：选中语义与主网格一致（写的是同一个选区） */
function GroupOverlay({
  items,
  selectedSet,
  markedSet,
  onSelect,
  onClose,
}: {
  items: SortingAsset[];
  selectedSet: Set<string>;
  markedSet: Set<string>;
  onSelect: (id: string, modifiers: { shift?: boolean; meta?: boolean }) => void;
  onClose: () => void;
}) {
  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="dialog dialog--wide"
        role="dialog"
        aria-modal="true"
        aria-label="连拍组"
        data-testid="group-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="dialog__title">连拍组（{items.length} 张）</h2>
        <p className="dialog__message">
          组内可以单独选中并执行分类/精选/标删；AI 只给建议，不会替你动文件。
        </p>
        <div className="group-overlay__grid dialog__form">
          {items.map((asset) => (
            <div
              key={asset.id}
              role="gridcell"
              aria-selected={selectedSet.has(asset.id)}
              data-testid="group-item"
              data-asset={asset.id}
              className={`asset${selectedSet.has(asset.id) ? " asset--selected" : ""}${
                markedSet.has(asset.id) ? " asset--marked" : ""
              }`}
              onClick={(e) =>
                onSelect(asset.id, {
                  shift: e.shiftKey,
                  meta: e.metaKey || e.ctrlKey,
                })
              }
            >
              {asset.thumbReady && asset.thumbnail ? (
                <img className="asset__thumb" src={asset.thumbnail} alt="" />
              ) : (
                <div className="asset__thumb asset__thumb--empty" />
              )}
              <span className="asset__name truncate">{asset.fileName}</span>
              <JudgementBadges judgement={asset.judgement} />
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
