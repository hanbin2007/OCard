/** 屏 4：拷卡任务面板（源卷双确认 + 多目的地 + 逐文件哈希状态）。 */

import { useEffect, useMemo, useState } from "react";
import * as api from "../api";
import type { DestinationKind } from "../api/types";
import { IconPlus, IconRetry, IconTrash } from "../components/Icon";
import { TopBar } from "../components/TopBar";
import { Badge, EmptyState, Field, ProgressBar } from "../components/ui";
import { formatBytes, formatEta, formatSpeed, formatTimestamp, ratio } from "../lib/format";
import {
  COPY_FILE_STATUS_LABEL,
  COPY_FILE_STATUS_TONE,
  DESTINATION_KIND_LABEL,
  DESTINATION_STATE_LABEL,
  TASK_STATE_LABEL,
  TASK_STATE_TONE,
} from "../lib/labels";
import { buildCopyTargetPath, inferTimeSlot } from "../lib/naming";
import { validateStartCopy } from "../lib/validation";
import { useStore } from "../state/store";

interface DestDraft {
  kind: DestinationKind;
  path: string;
}

export function CopyTaskScreen() {
  const { state, dispatch } = useStore();
  const { volumes, cameras, tasks, projects, selectedProjectId, selectedTaskId } = state;

  const project = projects.find((p) => p.id === selectedProjectId) ?? projects[0] ?? null;
  const task = tasks.find((t) => t.id === selectedTaskId) ?? tasks[0] ?? null;

  const [volumeId, setVolumeId] = useState("");
  const [cameraId, setCameraId] = useState("");
  const [note, setNote] = useState("");
  const [dests, setDests] = useState<DestDraft[]>([
    { kind: "nas", path: state.workstation?.nasRoot ?? "" },
    { kind: "external", path: "/Volumes/BACKUP-T7" },
  ]);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);

  const camera = cameras.find((c) => c.id === cameraId) ?? null;
  const validation = useMemo(
    () =>
      validateStartCopy({
        volumeId,
        cameraId,
        note,
        destinations: dests.map((d) => d.path),
      }),
    [volumeId, cameraId, note, dests],
  );

  const targetPath = useMemo(() => {
    if (!project || !camera) return "";
    const prefix =
      project.scenario === "A" ? project.date : inferTimeSlot(new Date().toISOString());
    return buildCopyTargetPath(project.scenario, prefix, camera.code);
  }, [project, camera]);

  // 订阅进行中任务的进度事件（真实实现为 tauri event）
  useEffect(() => {
    if (!task || task.state !== "running") return;
    return api.subscribeCopyProgress(task.id, (event) => {
      dispatch({
        type: "taskProgress",
        taskId: event.taskId,
        copiedBytes: event.copiedBytes,
        speedBytesPerSec: event.speedBytesPerSec,
      });
    });
  }, [task, dispatch]);

  async function start() {
    setSubmitted(true);
    if (!validation.valid || !project || busy) return;
    setBusy(true);
    try {
      const started = await api.startCopyTask({
        projectId: project.id,
        volumeId,
        cameraId,
        note,
        destinations: dests,
      });
      dispatch({ type: "taskStarted", task: started });
      setNote("");
      setSubmitted(false);
    } finally {
      setBusy(false);
    }
  }

  const fileSummary = useMemo(() => {
    const counts = { pending: 0, copied: 0, verified: 0, failed: 0 };
    for (const f of task?.files ?? []) counts[f.status] += 1;
    return counts;
  }, [task]);

  return (
    <>
      <TopBar
        title="拷卡任务"
        subtitle={project ? project.folderName : undefined}
        actions={
          <span className="text-xs dim">
            源读一次，并行写 {dests.length} 个目的地
          </span>
        }
      />

      <div className="content">
        <div className="content__inner">
          <div className="copy">
            <div className="copy__form">
              <div className="card">
                <div className="card__head">
                  <span className="card__title">发起拷卡</span>
                  <span className="card__hint">摄影师与 DIT 双确认</span>
                </div>
                <div className="card__body">
                  <div className="stack stack--lg">
                    <div className="field">
                      <span className="field__label">源卷</span>
                      <div>
                        {volumes.map((volume) => {
                          const matched = state.cards.find(
                            (c) => c.id === volume.matchedCardId,
                          );
                          return (
                            <button
                              key={volume.id}
                              type="button"
                              className="volume-row"
                              aria-label={`选择源卷 ${volume.name}`}
                              aria-pressed={volumeId === volume.id}
                              onClick={() => {
                                setVolumeId(volume.id);
                                if (matched) setCameraId(matched.cameraId);
                              }}
                            >
                              <span className="truncate">
                                <span className="volume-row__name">{volume.name}</span>
                                <span className="volume-row__meta">
                                  {volume.mountPath} · 已用{" "}
                                  {formatBytes(volume.usedBytes, 0)} /{" "}
                                  {formatBytes(volume.capacityBytes, 0)}
                                </span>
                              </span>
                              {matched ? (
                                <Badge mono>{matched.label}</Badge>
                              ) : (
                                <Badge tone="warn">未登记</Badge>
                              )}
                            </button>
                          );
                        })}
                        {volumes.length === 0 ? (
                          <p className="text-sm dim">未检测到可移动卷。</p>
                        ) : null}
                      </div>
                      {submitted && validation.errors.volumeId ? (
                        <span className="field__error" role="alert">
                          {validation.errors.volumeId}
                        </span>
                      ) : null}
                    </div>

                    <Field
                      label="对应相机"
                      htmlFor="copy-camera"
                      error={submitted ? validation.errors.cameraId : undefined}
                    >
                      <select
                        id="copy-camera"
                        className="select"
                        value={cameraId}
                        onChange={(e) => setCameraId(e.currentTarget.value)}
                      >
                        <option value="">请选择…</option>
                        {cameras.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.model} · {c.code}
                          </option>
                        ))}
                      </select>
                    </Field>

                    <div className="code-preview">
                      <span className="code-preview__label">目标路径预览</span>
                      <span
                        className={`code-preview__value${targetPath ? "" : " code-preview__value--empty"}`}
                        data-testid="copy-target-preview"
                      >
                        {targetPath || "选择相机后生成"}
                      </span>
                    </div>

                    <Field
                      label="内容备注"
                      htmlFor="copy-note"
                      hint="规范要求「适当记录」，将写入 manifest 与审计日志"
                      error={submitted ? validation.errors.note : undefined}
                    >
                      <textarea
                        id="copy-note"
                        className="textarea"
                        value={note}
                        placeholder="如：上午田赛，含 4×100 决赛全程"
                        onChange={(e) => setNote(e.currentTarget.value)}
                      />
                    </Field>

                    <div className="field">
                      <span className="field__label">目的地</span>
                      <div className="stack stack--sm">
                        {dests.map((dest, index) => (
                          <div className="dest-row" key={index}>
                            <select
                              className="select"
                              value={dest.kind}
                              aria-label={`第 ${index + 1} 个目的地类型`}
                              onChange={(e) =>
                                setDests((prev) =>
                                  prev.map((d, i) =>
                                    i === index
                                      ? { ...d, kind: e.currentTarget.value as DestinationKind }
                                      : d,
                                  ),
                                )
                              }
                            >
                              {(
                                Object.keys(DESTINATION_KIND_LABEL) as DestinationKind[]
                              ).map((kind) => (
                                <option key={kind} value={kind}>
                                  {DESTINATION_KIND_LABEL[kind]}
                                </option>
                              ))}
                            </select>
                            <input
                              className="input input--mono"
                              type="text"
                              value={dest.path}
                              aria-label={`第 ${index + 1} 个目的地路径`}
                              placeholder="/Volumes/…"
                              onChange={(e) =>
                                setDests((prev) =>
                                  prev.map((d, i) =>
                                    i === index ? { ...d, path: e.currentTarget.value } : d,
                                  ),
                                )
                              }
                            />
                            <button
                              type="button"
                              className="btn btn--ghost btn--icon"
                              aria-label={`删除第 ${index + 1} 个目的地`}
                              onClick={() =>
                                setDests((prev) => prev.filter((_, i) => i !== index))
                              }
                            >
                              <IconTrash />
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          className="btn btn--sm"
                          onClick={() =>
                            setDests((prev) => [...prev, { kind: "local", path: "" }])
                          }
                        >
                          <IconPlus />
                          添加目的地
                        </button>
                        {submitted && validation.errors.destinations ? (
                          <span className="field__error" role="alert">
                            {validation.errors.destinations}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={start}
                      disabled={busy}
                    >
                      {busy ? "正在建立任务…" : "开始拷卡"}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="stack stack--lg">
              <div className="tasks__tabs" role="group" aria-label="任务切换">
                {tasks.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="btn btn--sm"
                    aria-pressed={t.id === task?.id}
                    onClick={() => dispatch({ type: "selectTask", taskId: t.id })}
                  >
                    <span className="mono">{t.volumeName}</span>
                    <Badge tone={TASK_STATE_TONE[t.state]}>
                      {TASK_STATE_LABEL[t.state]}
                    </Badge>
                  </button>
                ))}
              </div>

              {task ? (
                <>
                  <div className="card">
                    <div className="card__head">
                      <span className="card__title mono">{task.targetFolder}</span>
                      <div className="card__actions">
                        <Badge tone={TASK_STATE_TONE[task.state]} dot>
                          {TASK_STATE_LABEL[task.state]}
                        </Badge>
                      </div>
                    </div>
                    <div className="card__body">
                      <div className="stack stack--lg">
                        <div className="stack stack--sm">
                          <ProgressBar
                            value={task.copiedBytes}
                            total={task.totalBytes}
                            tone={task.state === "done" ? "ok" : "accent"}
                            label="总进度"
                          />
                          <div className="row-inline text-xs dim">
                            <span className="mono">
                              {formatBytes(task.copiedBytes)} /{" "}
                              {formatBytes(task.totalBytes)}
                            </span>
                            <span className="mono push-right">
                              {Math.round(ratio(task.copiedBytes, task.totalBytes) * 100)}%
                            </span>
                          </div>
                        </div>

                        <div className="task-stats">
                          <div>
                            <div className="stat__label">速度</div>
                            <div className="stat__value">
                              {formatSpeed(task.speedBytesPerSec)}
                            </div>
                          </div>
                          <div>
                            <div className="stat__label">预计剩余</div>
                            <div className="stat__value">
                              {formatEta(
                                task.totalBytes - task.copiedBytes,
                                task.speedBytesPerSec,
                              )}
                            </div>
                          </div>
                          <div>
                            <div className="stat__label">已校验</div>
                            <div className="stat__value">
                              {fileSummary.verified}/{task.files.length}
                            </div>
                          </div>
                          <div>
                            <div className="stat__label">开始于</div>
                            <div className="stat__value">
                              {formatTimestamp(task.startedAt)}
                            </div>
                          </div>
                        </div>

                        <div className="dl">
                          <div className="dl__row">
                            <span className="dl__key">相机</span>
                            <span className="dl__val mono">{task.cameraCode}</span>
                          </div>
                          <div className="dl__row">
                            <span className="dl__key">内容备注</span>
                            <span className="dl__val">{task.note}</span>
                          </div>
                          <div className="dl__row">
                            <span className="dl__key">操作人</span>
                            <span className="dl__val">{task.operator}</span>
                          </div>
                        </div>

                        <div>
                          <div className="section__head">
                            <h2 className="section__title">目的地</h2>
                            <span className="card__hint">
                              {task.destinations.length} 个 · 单读多写
                            </span>
                          </div>
                          {task.destinations.map((dest) => (
                            <div className="dest-line" key={dest.id}>
                              <span className="truncate">
                                <Badge>{DESTINATION_KIND_LABEL[dest.kind]}</Badge>{" "}
                                <span className="dest-line__path">{dest.path}</span>
                              </span>
                              <span className="stack stack--sm">
                                <ProgressBar
                                  value={dest.writtenBytes}
                                  total={task.totalBytes}
                                  tone={dest.state === "done" ? "ok" : "accent"}
                                  thin
                                  label={`${dest.path} 写入进度`}
                                />
                                <span className="text-xs dim">
                                  {DESTINATION_STATE_LABEL[dest.state]}
                                </span>
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="section__head">
                      <h2 className="section__title">文件</h2>
                      <span className="card__hint">
                        待拷 {fileSummary.pending} · 已拷 {fileSummary.copied} · 已校验{" "}
                        {fileSummary.verified} · 失败 {fileSummary.failed}
                      </span>
                    </div>
                    <div className="list">
                      <div className="list__head files__head">
                        <span>文件名</span>
                        <span>大小</span>
                        <span>xxHash3-64</span>
                        <span>状态</span>
                        <span />
                      </div>
                      <div className="files__scroll">
                        {task.files.map((f) => (
                          <div className="list__row files__row" key={f.id}>
                            <span className="files__name truncate">
                              {f.name}
                              {f.error ? (
                                <span className="files__error">{f.error}</span>
                              ) : null}
                            </span>
                            <span className="files__cell">{formatBytes(f.sizeBytes)}</span>
                            <span className="files__cell truncate">{f.hash ?? "—"}</span>
                            <span>
                              <Badge tone={COPY_FILE_STATUS_TONE[f.status]}>
                                {COPY_FILE_STATUS_LABEL[f.status]}
                              </Badge>
                            </span>
                            <span>
                              {f.status === "failed" ? (
                                <button
                                  type="button"
                                  className="btn btn--ghost btn--icon btn--sm"
                                  aria-label={`重试 ${f.name}`}
                                  onClick={() => void api.retryCopyFile(task.id, f.id)}
                                >
                                  <IconRetry />
                                </button>
                              ) : null}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="list">
                  <EmptyState>还没有拷卡任务，从左侧发起一个。</EmptyState>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
