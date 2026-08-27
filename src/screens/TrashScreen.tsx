/** 屏 6：回收站（两段式删除的可恢复落点，PRD §5.4）。 */

import { useCallback, useEffect, useState } from "react";
import * as api from "../api";
import type { TrashEntry } from "../api/types";
import { ConfirmDialog, type ConfirmRequest } from "../components/ConfirmDialog";
import { Checkbox } from "../components/controls";
import { TopBar } from "../components/TopBar";
import { IllTrashEmpty } from "../components/illustrations";
import { EmptyState } from "../components/ui";
import { useListNavigation } from "../hooks/useListNavigation";
import { formatBytes, formatTimestamp } from "../lib/format";
import { useNotify, useStore } from "../state/store";

export function TrashScreen() {
  const { state, dispatch } = useStore();
  const project = state.projects.find((p) => p.id === state.selectedProjectId) ?? null;
  const projectId = project?.id ?? null;

  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 读取失败绝不能渲染成「回收站是空的」——那会让人以为文件已经没了 */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 勾选恢复(评审 4.2):误标 50 张想找回,不该点 50 次等 50 次刷新 */
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const reload = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setLoadError(null);
    try {
      setEntries(await api.listTrash(projectId));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // 切项目立刻清旧账并收起确认框(codex 评审 P0):侧栏切项目页面不再卸载,
  // 若留着 A 项目的条目,确认框会显示 A 的数量却对 B 执行清空——不可逆误删
  useEffect(() => {
    setEntries([]);
    setChecked(new Set());
    setConfirm(null);
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const pushNotice = useNotify();

  /** 批量恢复(评审 4.2):API 本就收数组,一次调用、一次刷新 */
  const restoreMany = useCallback(
    async (ids: string[]) => {
      if (!projectId || busy || ids.length === 0) return;
      setBusy(true);
      try {
        const result = await api.restoreFromTrash(projectId, ids);
        if (result.failed.length > 0) {
          pushNotice(
            "error",
            "trash-restore-failed",
            `${result.failed.length} 个文件恢复失败：${result.failed[0].message}${
              result.failed.length > 1 ? " 等" : ""
            }`,
          );
        }
        setChecked((prev) => {
          const done = new Set(result.succeeded);
          return new Set([...prev].filter((id) => !done.has(id)));
        });
        await reload();
      } catch (err) {
        pushNotice(
          "error",
          "trash-restore-failed",
          `恢复失败：${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setBusy(false);
      }
    },
    [projectId, busy, pushNotice, reload],
  );

  const toggleChecked = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** 键盘导航(评审 4.5):方向键移光标,Enter/空格勾选;点行同样勾选 */
  const [cursorId, setCursorId] = useState<string | null>(null);
  const nav = useListNavigation({
    ids: entries.map((e) => e.id),
    selectedId: cursorId,
    onSelect: setCursorId,
    onActivate: toggleChecked,
    idPrefix: "trash",
  });

  function requestEmpty() {
    // 加载中的清单不可作为删除依据(数量可能属于上一个项目)
    if (entries.length === 0 || loading || busy) return;
    const bytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
    const latest = entries.reduce(
      (max, e) => (e.trashedAt > max ? e.trashedAt : max),
      entries[0].trashedAt,
    );
    setConfirm({
      title: `永久删除回收站里的 ${entries.length} 个文件（${formatBytes(bytes)}）？`,
      message:
        `共 ${formatBytes(bytes)},最近一次删除于 ${formatTimestamp(latest)}。` +
        "这是 OCard 里唯一会真正物理删除文件的操作，删除后无法恢复，也不会进入系统废纸篓。请确认这些素材确实不再需要。",
      confirmLabel: "永久删除",
      onConfirm: async () => {
        if (!projectId) return;
        setBusy(true);
        try {
          const result = await api.emptyTrash(projectId);
          if (result.failed > 0) {
            // 部分失败统一走 toast(UX 波三);失败条目仍留在下方列表里
            // 文件还在、可重试 = warning,不是 error(评审 P2:级别别拉爆)
            pushNotice(
              "warning",
              "trash-empty-partial",
              `${result.failed} 个文件删除失败,已保留在回收站,可重试清空;常见原因是文件被占用或权限不足`,
            );
          }
          await reload();
        } catch (err) {
          pushNotice(
            "error",
            "trash-empty-failed",
            `清空回收站失败：${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          setBusy(false);
        }
      },
    });
  }

  const totalBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);

  return (
    <>
      <TopBar
        title="回收站"
        subtitle={project ? project.folderName : undefined}
        subtitleMono={project !== null}
        actions={
          <>
            <button
              type="button"
              className="btn btn--sm"
              data-testid="trash-back"
              onClick={() => dispatch({ type: "navigate", route: "sorting" })}
            >
              返回分类
            </button>
            <button
              type="button"
              className="btn btn--sm btn--danger-solid"
              data-testid="trash-empty"
              disabled={entries.length === 0 || busy || loading}
              onClick={requestEmpty}
            >
              清空回收站
            </button>
          </>
        }
      />

      <div className="content">
        <div className="content__inner">
          <div className="page-head">
            <div>
              <h2 className="section__title">已删除的素材</h2>
              <p className="page-head__desc">
                这些文件存放在项目内 <span className="mono">.ocard/trash</span>，
                随时可以恢复到原位置。只有「清空回收站」才会真正物理删除。
              </p>
            </div>
            <span className="page-head__actions text-xs dim mono">
              {entries.length} 个 · {formatBytes(totalBytes)}
            </span>
          </div>

          {loadError ? (
            <div className="sorting__error" data-testid="trash-load-error">
              <p className="text-sm" role="alert">
                无法读取回收站：{loadError}
              </p>
              <p className="text-xs dim">
                这不代表回收站是空的——请检查 NAS 是否可达后重试。
              </p>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                data-testid="trash-retry"
                onClick={() => void reload()}
              >
                重试
              </button>
            </div>
          ) : (
          <>
          {entries.length > 0 ? (
            <div className="row-inline" data-testid="trash-toolbar">
              <Checkbox
                testId="trash-check-all"
                checked={checked.size === entries.length && entries.length > 0}
                onChange={(next) =>
                  setChecked(next ? new Set(entries.map((e) => e.id)) : new Set())
                }
              >
                全选
              </Checkbox>
              <button
                type="button"
                className="btn btn--sm"
                data-testid="trash-restore-selected"
                disabled={busy || checked.size === 0}
                onClick={() => void restoreMany([...checked])}
              >
                恢复选中（{checked.size}）
              </button>
              <button
                type="button"
                className="btn btn--sm"
                data-testid="trash-restore-all"
                disabled={busy || entries.length === 0}
                onClick={() => void restoreMany(entries.map((e) => e.id))}
              >
                全部恢复
              </button>
            </div>
          ) : null}
          <div className="list">
            <div className="list__head trash__head">
              <span />
              <span>文件</span>
              <span>原位置</span>
              <span>删除时间</span>
              <span>大小</span>
              <span />
            </div>
            <div {...nav.containerProps} aria-label="回收站文件列表">
            {entries.map((entry) => (
              <div
                className="list__row trash__row"
                key={entry.id}
                data-testid="trash-row"
                {...nav.getItemProps(entry.id)}
                aria-selected={checked.has(entry.id)}
              >
                {/* 阻止冒泡:行点击本身就切换勾选,别让勾选框被抵消成无操作 */}
                <span
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <Checkbox
                    testId="trash-check"
                    ariaLabel={`勾选 ${entry.fileName}`}
                    checked={checked.has(entry.id)}
                    onChange={() => toggleChecked(entry.id)}
                  />
                </span>
                <span className="mono text-xs truncate" title={entry.fileName}>
                  {entry.fileName}
                </span>
                <span className="text-xs dim truncate mono" title={entry.originalPath}>
                  {entry.originalPath}
                </span>
                <span className="text-xs dim mono">{formatTimestamp(entry.trashedAt)}</span>
                <span className="text-xs dim mono">{formatBytes(entry.sizeBytes, 0)}</span>
                <button
                  type="button"
                  className="btn btn--sm"
                  data-testid="trash-restore"
                  aria-label={`恢复 ${entry.fileName}`}
                  tabIndex={-1}
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    void restoreMany([entry.id]);
                  }}
                >
                  恢复
                </button>
              </div>
            ))}
            </div>
            {entries.length === 0 && !loading ? (
              <EmptyState art={<IllTrashEmpty />}>回收站是空的。</EmptyState>
            ) : null}
          </div>
          </>
          )}
        </div>
      </div>

      <ConfirmDialog request={confirm} onCancel={() => setConfirm(null)} />
    </>
  );
}
