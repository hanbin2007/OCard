/** 屏 6：回收站（两段式删除的可恢复落点，PRD §5.4）。 */

import { useCallback, useEffect, useState } from "react";
import * as api from "../api";
import type { TrashEntry } from "../api/types";
import { ConfirmDialog, type ConfirmRequest } from "../components/ConfirmDialog";
import { TopBar } from "../components/TopBar";
import { EmptyState } from "../components/ui";
import { formatBytes, formatTimestamp } from "../lib/format";
import { useStore } from "../state/store";

export function TrashScreen() {
  const { state, dispatch } = useStore();
  const project = state.projects.find((p) => p.id === state.selectedProjectId) ?? null;
  const projectId = project?.id ?? null;

  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const reload = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      setEntries(await api.listTrash(projectId));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const notify = useCallback(
    (message: string, code: string) =>
      dispatch({
        type: "noticeReceived",
        notice: {
          level: "error",
          code,
          message,
          occurredAt: new Date().toISOString(),
        },
      }),
    [dispatch],
  );

  async function restore(entry: TrashEntry) {
    if (!projectId || busy) return;
    setBusy(true);
    try {
      const result = await api.restoreFromTrash(projectId, [entry.id]);
      if (result.failed.length > 0) {
        notify(`恢复 ${entry.fileName} 失败：${result.failed[0].message}`, "trash-restore-failed");
      }
      await reload();
    } catch (err) {
      notify(
        `恢复 ${entry.fileName} 失败：${err instanceof Error ? err.message : String(err)}`,
        "trash-restore-failed",
      );
    } finally {
      setBusy(false);
    }
  }

  function requestEmpty() {
    if (entries.length === 0) return;
    setConfirm({
      title: `永久删除回收站里的 ${entries.length} 个文件？`,
      message:
        "这是 OCard 里唯一会真正物理删除文件的操作，删除后无法恢复，也不会进入系统废纸篓。请确认这些素材确实不再需要。",
      confirmLabel: "永久删除",
      onConfirm: async () => {
        if (!projectId) return;
        setBusy(true);
        try {
          await api.emptyTrash(projectId);
          await reload();
        } catch (err) {
          notify(
            `清空回收站失败：${err instanceof Error ? err.message : String(err)}`,
            "trash-empty-failed",
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
              disabled={entries.length === 0 || busy}
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

          <div className="list">
            <div className="list__head trash__head">
              <span>文件</span>
              <span>原位置</span>
              <span>删除时间</span>
              <span>大小</span>
              <span />
            </div>
            {entries.map((entry) => (
              <div className="list__row trash__row" key={entry.id} data-testid="trash-row">
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
                  disabled={busy}
                  onClick={() => void restore(entry)}
                >
                  恢复
                </button>
              </div>
            ))}
            {entries.length === 0 && !loading ? (
              <EmptyState>回收站是空的。</EmptyState>
            ) : null}
          </div>
        </div>
      </div>

      <ConfirmDialog request={confirm} onCancel={() => setConfirm(null)} />
    </>
  );
}
