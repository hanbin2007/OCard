/** 屏 5：分类工作台（工况 B 核心，PRD §5.4 键盘驱动分类）。 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import * as api from "../api";
import type { BulkResult, SortingAsset, SortingCategory } from "../api/types";
import { AssetLightbox } from "../components/AssetLightbox";
import { ConfirmDialog, type ConfirmRequest } from "../components/ConfirmDialog";
import { DeliveryButton } from "../components/DeliveryPanel";
import { TopBar } from "../components/TopBar";
import { Badge, EmptyState, Kbd, ProgressBar } from "../components/ui";
import { VirtualGrid } from "../components/VirtualGrid";
import { formatBytes, formatTimestamp } from "../lib/format";
import {
  actionTargets,
  clickSelection,
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
import { useStore } from "../state/store";

const PAGE_SIZE = 200;
/** 索引事件驱动的重拉节流：索引中事件很密，不能每条都打一次 IPC */
const INDEX_REFRESH_MIN_MS = 2000;

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

  const [assets, setAssets] = useState<SortingAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  /** 初始加载失败：绝不能渲染成「没有素材」——那是把故障说成空目录 */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [categories, setCategories] = useState<SortingCategory[]>([]);
  const [indexing, setIndexing] = useState<{
    indexed: number;
    total: number;
    running: boolean;
    failed: number;
    missing: number;
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
  const lastIndexedRef = useRef(0);

  useEffect(() => {
    loadedCountRef.current = assets.length;
  }, [assets.length]);

  const assetIds = useMemo(() => assets.map((a) => a.id), [assets]);
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
   * 按 PAGE_SIZE 分块取：一次要 600 会被后端 500 的上限截断，
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
    } catch {
      // 刷新失败不打断分类：保留当前列表，下一次索引事件会再试
    }
  }, [projectId]);

  const loadMore = useCallback(async () => {
    if (!projectId || loading || assets.length >= total) return;
    setLoading(true);
    try {
      const page = await api.listPendingAssets(projectId, assets.length, PAGE_SIZE);
      setAssets((prev) => [...prev, ...page.items]);
      setTotal(page.total);
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

  // 索引进度：索引中也能操作已索引部分，所以只更新进度条，不锁界面。
  // indexed 增长时按 2s 节流重拉当前页——否则刚索引好的格子会一直停在「索引中」。
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const sub = api.subscribeIndexProgress(
      (event) => {
        if (cancelled || event.projectId !== projectId) return;
        setIndexing({
          indexed: event.indexed,
          total: event.total,
          running: event.running,
          failed: event.failed,
          missing: event.missing,
        });

        if (event.indexed <= lastIndexedRef.current) return;
        lastIndexedRef.current = event.indexed;
        if (timer) clearTimeout(timer);
        const elapsed = Date.now() - lastRefreshRef.current;
        timer = setTimeout(
          () => void refreshLoadedAssets(),
          Math.max(0, INDEX_REFRESH_MIN_MS - elapsed),
        );
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

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      sub.dispose();
    };
  }, [projectId, refreshLoadedAssets, notify]);

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
    setCategories(await api.listCategories(projectId));
  }, [projectId]);

  /* ---------------- 动作 ---------------- */

  // runCurate 定义在下面，用 ref 打通引用（两者都是稳定回调）
  const runCurateRef = useRef<() => Promise<void>>(async () => {});

  const runAssign = useCallback(
    async (categoryId: string) => {
      const targets = actionTargets(selection);
      if (!projectId || targets.length === 0 || busy) return;
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
    [projectId, selection, busy, categories, applyBulk, refreshCategories, notify],
  );

  const runCurate = useCallback(async () => {
    const targets = actionTargets(selection);
    if (!projectId || targets.length === 0 || busy) return;
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
  }, [projectId, selection, busy, refreshCategories, notify]);

  runCurateRef.current = runCurate;

  const commitDelete = useCallback(async () => {
    if (!projectId) return;
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

  function requestDeleteConfirm() {
    if (pendingDelete.marked.length === 0) return;
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
          dispatchDelete({ type: "mark", assetIds: actionTargets(selection) });
          return;
        case "unmarkDelete":
          dispatchDelete({ type: "unmark", assetIds: actionTargets(selection) });
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
            <DeliveryButton projectId={project.id} />
            <button
              type="button"
              className="btn btn--sm"
              data-testid="sorting-open-trash"
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
                disabled={category.kind === "inbox" || busy}
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
          </div>

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
                items={assets}
                minCellWidth={CELL_MIN_WIDTH}
                rowHeight={ROW_HEIGHT}
                gap={GRID_GAP}
                className="sorting__grid"
                ariaLabel="待分类素材网格"
                scrollToIndex={cursorIndex}
                onColumnsChange={setColumns}
                keyOf={(asset) => asset.id}
                renderItem={(asset, index) => (
                  <AssetCell
                    key={asset.id}
                    asset={asset}
                    index={index}
                    selected={selectedSet.has(asset.id)}
                    focused={selection.cursor === asset.id}
                    marked={markedSet.has(asset.id)}
                    onSelect={(modifiers) =>
                      setSelection((prev) =>
                        clickSelection(assetIds, prev, asset.id, modifiers),
                      )
                    }
                    onOpen={() => setPreviewIndex(index)}
                  />
                )}
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
                onClick={requestDeleteConfirm}
              >
                确认移入回收站
              </button>
            </div>
          ) : null}
        </div>
      </div>

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
}: {
  asset: SortingAsset;
  index: number;
  selected: boolean;
  focused: boolean;
  marked: boolean;
  onSelect: (modifiers: { shift?: boolean; meta?: boolean }) => void;
  onOpen: () => void;
}) {
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
      {asset.thumbnail ? (
        <img className="asset__thumb" src={asset.thumbnail} alt="" loading="lazy" />
      ) : (
        <div className="asset__thumb asset__thumb--empty" data-testid="asset-no-thumb">
          <span className="text-2xs dim">索引中</span>
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
