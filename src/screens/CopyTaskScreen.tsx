/** 屏 4：拷卡任务面板（源卷双确认 + 多目的地 + 逐文件哈希状态）。 */

import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import type { DestinationKind } from "../api/types";
import { IconPlus, IconRetry, IconTrash } from "../components/Icon";
import { TopBar } from "../components/TopBar";
import { Badge, EmptyState, Field, ProgressBar } from "../components/ui";
import {
  formatBytes,
  formatEta,
  formatSpeed,
  formatTimestamp,
  ratio,
} from "../lib/format";
import {
  COPY_FILE_STATUS_LABEL,
  COPY_FILE_STATUS_TONE,
  DESTINATION_KIND_LABEL,
  DESTINATION_STATE_LABEL,
  TASK_STATE_LABEL,
  TASK_STATE_TONE,
} from "../lib/labels";
import { buildCopyTargetPath, copyTargetParent } from "../lib/naming";
import { validateStartCopy } from "../lib/validation";
import { useStore } from "../state/store";

interface DestDraft {
  id: string;
  kind: DestinationKind;
  path: string;
}

let destSeq = 0;
function newDest(kind: DestinationKind, path = ""): DestDraft {
  destSeq += 1;
  return { id: `dest-${destSeq}`, kind, path };
}

export function CopyTaskScreen() {
  const { state, dispatch } = useStore();
  const { volumes, cameras, tasks, projects, selectedProjectId, selectedTaskId } = state;

  // 不做 `?? projects[0]` 兜底：没选项目就不该猜一个往里拷
  const project = projects.find((p) => p.id === selectedProjectId) ?? null;
  // 任务按项目过滤，避免 A 项目标题配 B 项目文件
  const projectTasks = useMemo(
    () => (project ? tasks.filter((t) => t.projectId === project.id) : []),
    [tasks, project],
  );
  const task =
    projectTasks.find((t) => t.id === selectedTaskId) ?? projectTasks[0] ?? null;

  const [volumeId, setVolumeId] = useState("");
  const [cameraId, setCameraId] = useState("");
  const [note, setNote] = useState("");
  const [targetPrefix, setTargetPrefix] = useState("");
  const [prefixInferred, setPrefixInferred] = useState(false);
  // 人工改过前缀后就不再被探查结果覆盖
  const prefixEditedRef = useRef(false);
  // 不预填任何平台特有路径：/Volumes/… 在 Windows/Linux 上首屏即是错的
  const [dests, setDests] = useState<DestDraft[]>(() => [
    newDest("nas"),
    newDest("external"),
  ]);
  const [submitted, setSubmitted] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const camera = cameras.find((c) => c.id === cameraId) ?? null;
  const validation = useMemo(
    () =>
      validateStartCopy({
        volumeId,
        cameraId,
        note,
        targetPrefix,
        destinations: dests.map((d) => d.path),
      }),
    [volumeId, cameraId, note, targetPrefix, dests],
  );

  const targetPath =
    project && camera
      ? buildCopyTargetPath(project.scenario, targetPrefix, camera.code)
      : "";

  // 选中源卷后探查素材时间戳，据此推断时段前缀（PRD §5.3：从素材时间戳推断，可改）
  useEffect(() => {
    if (!volumeId || !project || prefixEditedRef.current) return;
    let cancelled = false;
    void (async () => {
      const inspection = await api.inspectVolume(volumeId);
      if (cancelled || prefixEditedRef.current) return;
      // 工况 A 用项目拍摄日期，工况 B 用卡内素材推断出的时段
      setTargetPrefix(
        project.scenario === "A" ? project.date : inspection.suggestedPrefix,
      );
      setPrefixInferred(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [volumeId, project]);

  async function confirmAndStart() {
    if (!validation.valid || !project || busy) return;
    setBusy(true);
    try {
      const started = await api.startCopyTask({
        projectId: project.id,
        volumeId,
        cameraId,
        note,
        targetPrefix,
        destinations: dests.map(({ kind, path }) => ({ kind, path })),
      });
      dispatch({ type: "taskStarted", task: started });
      setNote("");
      setSubmitted(false);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  function requestConfirm() {
    setSubmitted(true);
    if (!validation.valid || !project) return;
    setConfirming(true);
  }

  const fileSummary = useMemo(() => {
    const counts = { pending: 0, copied: 0, verified: 0, failed: 0 };
    for (const f of task?.files ?? []) counts[f.status] += 1;
    return counts;
  }, [task]);

  const allVerified =
    task !== null &&
    task.files.length > 0 &&
    fileSummary.verified === task.files.length;

  const volume = volumes.find((v) => v.id === volumeId) ?? null;

  return (
    <>
      <TopBar
        title="拷卡任务"
        subtitle={project ? project.folderName : "未选择项目"}
        subtitleMono={project !== null}
        actions={
          <span className="text-xs dim">源读一次，并行写 {dests.length} 个目的地</span>
        }
      />

      <div className="content">
        <div className="content__inner">
          <div className="copy">
            <div className="copy__form">
              <div className="card">
                <div className="card__head">
                  <span className="card__title">
                    {confirming ? "确认拷卡信息" : "发起拷卡"}
                  </span>
                  <span className="card__hint">
                    {confirming ? "摄影师与 DIT 共同核对" : "填写后进入双确认"}
                  </span>
                </div>
                <div className="card__body">
                  {!project ? (
                    <div className="stack">
                      <p className="text-sm" role="alert">
                        尚未选择项目，无法发起拷卡。
                      </p>
                      <div>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => dispatch({ type: "navigate", route: "projects" })}
                        >
                          去选择项目
                        </button>
                      </div>
                    </div>
                  ) : confirming ? (
                    /* 第二步：汇总复核，对应规范「摄影师和 DIT 两方确认」 */
                    <div className="stack stack--lg">
                      <div className="dl">
                        <div className="dl__row">
                          <span className="dl__key">项目</span>
                          <span className="dl__val mono">{project.folderName}</span>
                        </div>
                        <div className="dl__row">
                          <span className="dl__key">源卷</span>
                          <span className="dl__val mono">
                            {volume?.name}（{volume?.mountPath}）
                          </span>
                        </div>
                        <div className="dl__row">
                          <span className="dl__key">相机</span>
                          <span className="dl__val mono">{camera?.code}</span>
                        </div>
                        <div className="dl__row">
                          <span className="dl__key">目标</span>
                          <span className="dl__val mono">{targetPath}</span>
                        </div>
                        <div className="dl__row">
                          <span className="dl__key">备注</span>
                          <span className="dl__val">{note}</span>
                        </div>
                        <div className="dl__row">
                          <span className="dl__key">目的地</span>
                          <span className="dl__val">
                            {dests.map((d) => (
                              <span key={d.id} className="dest-line__path truncate">
                                {DESTINATION_KIND_LABEL[d.kind]} · {d.path}
                                <br />
                              </span>
                            ))}
                          </span>
                        </div>
                      </div>

                      <p className="text-xs dim">
                        确认后开始读卡。校验全部通过前请勿拔卡，OCard 不会代为格式化。
                      </p>

                      <div className="row-inline">
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setConfirming(false)}
                        >
                          返回修改
                        </button>
                        <button
                          type="button"
                          className="btn btn--primary"
                          onClick={confirmAndStart}
                          disabled={busy}
                        >
                          {busy ? "正在建立任务…" : "确认开始"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <form
                      className="stack stack--lg"
                      onSubmit={(e) => {
                        e.preventDefault();
                        requestConfirm();
                      }}
                    >
                      <div className="field">
                        <span className="field__label" id="volume-group-label">
                          源卷
                        </span>
                        <div role="radiogroup" aria-labelledby="volume-group-label">
                          {volumes.map((v) => {
                            const matched = state.cards.find(
                              (c) => c.id === v.matchedCardId,
                            );
                            return (
                              <button
                                key={v.id}
                                type="button"
                                className="volume-row"
                                role="radio"
                                aria-label={`选择源卷 ${v.name}`}
                                aria-checked={volumeId === v.id}
                                onClick={() => {
                                  setVolumeId(v.id);
                                  if (matched) setCameraId(matched.cameraId);
                                }}
                              >
                                <span className="truncate">
                                  <span className="volume-row__name">{v.name}</span>
                                  <span className="volume-row__meta" title={v.mountPath}>
                                    {v.mountPath} · 已用 {formatBytes(v.usedBytes, 0)} /{" "}
                                    {formatBytes(v.capacityBytes, 0)}
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

                      <Field
                        label={
                          project.scenario === "A" ? "目标夹日期" : "目标夹时段"
                        }
                        htmlFor="copy-prefix"
                        hint={
                          prefixInferred
                            ? "由卡内素材时间戳推断得出，可改"
                            : `落在「${copyTargetParent(project.scenario)}」下`
                        }
                        error={submitted ? validation.errors.targetPrefix : undefined}
                      >
                        <input
                          id="copy-prefix"
                          className="input input--mono"
                          type="text"
                          value={targetPrefix}
                          placeholder={
                            project.scenario === "A" ? "20260824" : "0824上午"
                          }
                          onChange={(e) => {
                            prefixEditedRef.current = true;
                            setPrefixInferred(false);
                            setTargetPrefix(e.currentTarget.value);
                          }}
                        />
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
                            <div className="dest-row" key={dest.id}>
                              <select
                                className="select"
                                value={dest.kind}
                                aria-label={`第 ${index + 1} 个目的地类型`}
                                onChange={(e) => {
                                  // 先取值再进 updater：updater 延后执行时 currentTarget 已为 null
                                  const kind = e.currentTarget.value as DestinationKind;
                                  setDests((prev) =>
                                    prev.map((d) =>
                                      d.id === dest.id ? { ...d, kind } : d,
                                    ),
                                  );
                                }}
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
                                placeholder="选择或粘贴目标文件夹路径"
                                onChange={(e) => {
                                  const path = e.currentTarget.value;
                                  setDests((prev) =>
                                    prev.map((d) =>
                                      d.id === dest.id ? { ...d, path } : d,
                                    ),
                                  );
                                }}
                              />
                              <button
                                type="button"
                                className="btn btn--ghost btn--icon"
                                aria-label={`删除第 ${index + 1} 个目的地`}
                                onClick={() =>
                                  setDests((prev) => prev.filter((d) => d.id !== dest.id))
                                }
                              >
                                <IconTrash />
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            className="btn btn--sm"
                            onClick={() => setDests((prev) => [...prev, newDest("local")])}
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

                      <button type="submit" className="btn btn--primary">
                        开始拷卡
                      </button>
                    </form>
                  )}
                </div>
              </div>
            </div>

            <div className="stack stack--lg">
              <div className="tasks__tabs" role="group" aria-label="任务切换">
                {projectTasks.map((t) => (
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
                  {task.state === "done" && allVerified ? (
                    <div className="notice notice--ok" role="status">
                      <strong>校验 100% 通过，本卡可格式化。</strong>
                      <span>
                        请在相机内格式化——OCard 不代为格式化，以防误操作。
                      </span>
                    </div>
                  ) : null}

                  <div className="card">
                    <div className="card__head">
                      <span className="card__title mono truncate" title={task.targetFolder}>
                        {task.targetFolder}
                      </span>
                      <div className="card__actions">
                        <Badge tone={TASK_STATE_TONE[task.state]} dot>
                          {TASK_STATE_LABEL[task.state]}
                        </Badge>
                        {task.state === "running" || task.state === "verifying" ? (
                          <button
                            type="button"
                            className="btn btn--sm"
                            onClick={() => void api.pauseCopyTask(task.id)}
                          >
                            挂起
                          </button>
                        ) : null}
                        {task.state === "paused" ? (
                          <button
                            type="button"
                            className="btn btn--sm"
                            onClick={() => void api.resumeCopyTask(task.id)}
                          >
                            继续
                          </button>
                        ) : null}
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
                            valueText={`${formatBytes(task.copiedBytes)} / ${formatBytes(task.totalBytes)}`}
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
                                <span className="dest-line__path" title={dest.path}>
                                  {dest.path}
                                </span>
                              </span>
                              <span className="stack stack--sm">
                                <ProgressBar
                                  value={dest.writtenBytes}
                                  total={task.totalBytes}
                                  tone={dest.state === "done" ? "ok" : "accent"}
                                  thin
                                  decorative
                                />
                                <span className="text-xs dim">
                                  {DESTINATION_STATE_LABEL[dest.state]} ·{" "}
                                  {formatBytes(dest.writtenBytes, 0)}
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
                      <div className="files__scroll">
                        <div className="list__head files__head">
                          <span>文件名</span>
                          <span>大小</span>
                          <span>xxHash3-64</span>
                          <span>状态</span>
                          <span />
                        </div>
                        {task.files.map((f) => (
                          <div className="list__row files__row" key={f.id}>
                            <span className="files__name truncate" title={f.path}>
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
                  <EmptyState>
                    {project ? "本项目还没有拷卡任务，从左侧发起一个。" : "先选择项目。"}
                  </EmptyState>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
