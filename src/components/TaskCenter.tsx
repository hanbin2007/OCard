/**
 * 任务中心(用户点单):跨项目、跨类型的后台任务统一入口。
 * 此前拷卡/转码/分析/交付的进度分散在各屏——A 项目在转码、B 项目在拷卡时
 * 必须来回切屏才能各看各的。这里聚合 store 里已有的全量快照
 * (state.tasks + state.jobs),给进行中任务列表 + 最近完成历史,
 * 行内可挂起/继续(拷卡)、取消(作业),点行跳到对应项目对应屏。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { CopyTask, JobSnapshot, JobState } from "../api/types";
import { isArchiveResult, isJobTerminal, isTranscodeJob } from "../api/types";
import {
  formatBytes,
  formatEta,
  formatPercent,
  formatSpeed,
  formatTimestamp,
  ratio,
} from "../lib/format";
import { TASK_STATE_LABEL, TASK_STATE_TONE } from "../lib/labels";
import { withViewTransition } from "../lib/motion";
import {
  useNotify,
  useStore,
  type RouteName,
} from "../state/store";
import { IconTasks } from "./Icon";
import { Badge, ProgressBar } from "./ui";

const JOB_KIND_LABEL: Record<JobSnapshot["kind"], string> = {
  delivery: "交付打包",
  transcode: "转码",
  analyze: "AI 分析",
};

const JOB_STATE_LABEL: Record<JobState, string> = {
  queued: "排队中",
  running: "进行中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const JOB_ROUTE: Record<JobSnapshot["kind"], RouteName> = {
  delivery: "sorting",
  transcode: "transcode",
  analyze: "sorting",
};

/** 历史区最多几条:再多进不了决策,翻旧账走审计日志 */
const HISTORY_CAP = 8;

/** 作业显示名:代理/归档共用 transcode kind,进行中认 operation,终态优先 result.mode */
function jobLabel(j: JobSnapshot): string {
  if (isTranscodeJob(j) && (isArchiveResult(j.result) || j.operation === "archive")) {
    return "归档转码";
  }
  return JOB_KIND_LABEL[j.kind];
}

function isCopyActive(t: CopyTask): boolean {
  return t.state === "running" || t.state === "verifying" || t.state === "paused";
}

export function TaskCenter() {
  const { state, dispatch, refreshTask, reconcileJobs } = useStore();
  const notify = useNotify();
  const open = state.taskCenterOpen;
  /** 在途操作的行 id:按下即禁用并显示进行中回执(评审 P2) */
  const [busyId, setBusyId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const projectName = useCallback(
    (projectId: string) =>
      state.projects.find((p) => p.id === projectId)?.name ?? projectId,
    [state.projects],
  );

  const closePanel = useCallback(
    () => withViewTransition(() => dispatch({ type: "taskCenterClosed" })),
    [dispatch],
  );

  // 打开面板顺手对账一次作业快照:别让面板显示的还是旧账
  useEffect(() => {
    if (!open) return;
    void reconcileJobs();
  }, [open, reconcileJobs]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) closePanel();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, closePanel]);

  const activeCopies = state.tasks.filter(isCopyActive);
  // 已有进度事件、快照还在对账路上的拷卡任务:计数与占位都要给,
  // 否则对账期间(乃至重试失败时)面板谎称「没有进行中的任务」(codex P2)
  const orphanActives = Object.values(state.orphanProgress).filter(
    (e) =>
      (e.state === "running" || e.state === "verifying" || e.state === "paused") &&
      !state.tasks.some((t) => t.id === e.taskId),
  );
  const activeJobs = state.jobs.filter(
    (j) => j.state === "queued" || j.state === "running",
  );
  const activeCount =
    activeCopies.length + orphanActives.length + activeJobs.length;

  const historyCopies = state.tasks.filter(
    (t) => t.state === "done" || t.state === "failed",
  );
  const historyJobs = state.jobs.filter((j) => isJobTerminal(j.state));
  const history = [
    ...historyCopies.map((t) => ({
      key: `copy-${t.id}`,
      label: `拷卡 · ${projectName(t.projectId)}`,
      detail: t.targetFolder,
      stateLabel: TASK_STATE_LABEL[t.state],
      state: t.state as string,
      at: t.finishedAt ?? t.startedAt,
      projectId: t.projectId,
      route: "copy" as RouteName,
      taskId: t.id,
    })),
    ...historyJobs.map((j) => ({
      key: `job-${j.id}`,
      label: `${jobLabel(j)} · ${projectName(j.projectId)}`,
      detail: j.error ?? "",
      stateLabel: JOB_STATE_LABEL[j.state],
      state: j.state as string,
      at: j.finishedAt ?? j.startedAt,
      projectId: j.projectId,
      route: JOB_ROUTE[j.kind],
      taskId: undefined as string | undefined,
    })),
  ]
    // 按时刻比较,不按 ISO 字符串序:+08:00 与 Z 混在一个数组里时
    // 字符串序是乱的(评审 P1);解析不了才退回字符串序,且保持反对称
    .sort((a, b) => {
      const ta = Date.parse(a.at);
      const tb = Date.parse(b.at);
      if (Number.isNaN(ta) || Number.isNaN(tb)) {
        return a.at < b.at ? 1 : a.at > b.at ? -1 : 0;
      }
      return tb - ta;
    })
    .slice(0, HISTORY_CAP);

  /**
   * 跳到任务所在的项目与屏。打包期间导航已放行(评审 4.3);
   * 目标项目在交付时仍改道去「选片与交付」屏——交付面板在那里。
   */
  function jumpTo(projectId: string, route: RouteName, taskId?: string) {
    const targetDelivering = state.jobs.some(
      (j) =>
        j.kind === "delivery" &&
        j.projectId === projectId &&
        (j.state === "queued" || j.state === "running"),
    );
    dispatch({ type: "selectProject", projectId });
    if (taskId) dispatch({ type: "selectTask", taskId });
    dispatch({ type: "navigate", route: targetDelivering ? "sorting" : route });
    closePanel();
  }

  async function cancelJob(jobId: string) {
    // 终态预检:与 DeliveryPanel/TranscodeScreen 同一口径,不给已结束的
    // 作业发取消(存在一帧窗口时行还没消失)
    const current = state.jobs.find((j) => j.id === jobId);
    if (current && isJobTerminal(current.state)) return;
    setBusyId(jobId);
    try {
      const snapshot = await api.cancelJob(jobId);
      dispatch({ type: "jobProgress", job: snapshot });
      if (isJobTerminal(snapshot.state) && snapshot.state !== "cancelled") {
        notify(
          "info",
          "job-cancel-too-late",
          "作业在取消生效前已经结束,本次取消未生效。",
        );
      } else if (snapshot.kind === "delivery") {
        // 交付取消的结果面板只在分类屏挂载;从任务中心取消时必须把
        // 「部分产物保留、重跑安全续打」这句话补上(评审 P1)
        notify(
          "info",
          "delivery-cancelled",
          `交付打包已取消,已完成 ${snapshot.done}/${snapshot.total};已复制的部分保留在交付目录里,清单按实况写入,再次打包会跳过这些文件。`,
        );
      }
    } catch (err) {
      notify(
        "warning",
        "job-cancel-failed",
        `取消作业失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusyId(null);
    }
  }

  async function pauseOrResume(task: CopyTask) {
    setBusyId(task.id);
    try {
      if (task.state === "paused") {
        await api.resumeCopyTask(task.id);
      } else {
        await api.pauseCopyTask(task.id);
      }
      await refreshTask(task.id);
    } catch (err) {
      notify(
        "warning",
        "copy-pause-failed",
        `${task.state === "paused" ? "继续" : "挂起"}拷卡失败：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="notice-bell" ref={wrapRef}>
      <button
        type="button"
        data-testid="task-center-toggle"
        className="btn btn--ghost btn--icon"
        aria-label={activeCount > 0 ? `任务中心,${activeCount} 个进行中` : "任务中心"}
        aria-expanded={open}
        title="任务中心"
        onClick={() =>
          open ? closePanel() : dispatch({ type: "taskCenterOpened" })
        }
      >
        <IconTasks />
        {activeCount > 0 ? (
          <span
            key={activeCount}
            className="notice-bell__badge task-badge"
            data-testid="task-active-count"
          >
            {activeCount > 9 ? "9+" : activeCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="notice-panel" data-testid="task-center-panel">
          <div className="notice-panel__head">
            <span className="card__title">任务中心</span>
            {activeCount > 0 ? (
              <span className="card__hint push-right">{activeCount} 个进行中</span>
            ) : null}
          </div>

          <div className="notice-panel__list">
            {activeCopies.map((task) => (
              <div className="task-item" key={task.id} data-testid="task-item">
                <button
                  type="button"
                  className="task-item__main"
                  aria-label={`打开拷卡任务：${projectName(task.projectId)}`}
                  title="打开拷卡任务"
                  onClick={() => jumpTo(task.projectId, "copy", task.id)}
                >
                  <span className="task-item__title">
                    <span className="truncate">
                      拷卡 · {projectName(task.projectId)}
                    </span>
                    <Badge tone={TASK_STATE_TONE[task.state]} dot>
                      {TASK_STATE_LABEL[task.state]}
                    </Badge>
                  </span>
                  <ProgressBar
                    value={task.copiedBytes}
                    total={task.totalBytes}
                    thin
                    decorative
                  />
                  <span className="task-item__meta mono">
                    {formatBytes(task.copiedBytes)} /{" "}
                    {formatBytes(task.totalBytes)}
                    {task.state === "running"
                      ? ` · ${formatSpeed(task.speedBytesPerSec)}`
                      : ""}
                    {` · ${formatPercent(ratio(task.copiedBytes, task.totalBytes))}`}
                    {/* 任务中心里最想知道的就是「还要多久」(评审 C3) */}
                    {task.state === "running"
                      ? ` · 剩 ${formatEta(
                          task.totalBytes - task.copiedBytes,
                          task.speedBytesPerSec,
                        )}`
                      : ""}
                  </span>
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  data-testid={
                    task.state === "paused" ? "task-resume" : "task-pause"
                  }
                  aria-label={`${task.state === "paused" ? "继续" : "挂起"}拷卡：${projectName(task.projectId)}`}
                  disabled={busyId === task.id}
                  onClick={() => void pauseOrResume(task)}
                >
                  {busyId === task.id
                    ? "处理中…"
                    : task.state === "paused"
                      ? "继续"
                      : "挂起"}
                </button>
              </div>
            ))}

            {orphanActives.map((e) => (
              <div
                className="task-item task-item--history"
                key={`orphan-${e.taskId}`}
                data-testid="task-item"
              >
                <span className="task-item__title">
                  <span className="truncate">拷卡 · 正在读取任务详情…</span>
                  <Badge tone={TASK_STATE_TONE[e.state]} dot>
                    {TASK_STATE_LABEL[e.state]}
                  </Badge>
                </span>
                <span className="task-item__meta mono">
                  {formatBytes(e.copiedBytes)}
                  {e.state === "running"
                    ? ` · ${formatSpeed(e.speedBytesPerSec)}`
                    : ""}
                </span>
              </div>
            ))}

            {activeJobs.map((job) => (
              <div className="task-item" key={job.id} data-testid="task-item">
                <button
                  type="button"
                  className="task-item__main"
                  aria-label={`打开${jobLabel(job)}：${projectName(job.projectId)}`}
                  title="打开对应页面"
                  onClick={() => jumpTo(job.projectId, JOB_ROUTE[job.kind])}
                >
                  <span className="task-item__title">
                    <span className="truncate">
                      {jobLabel(job)} · {projectName(job.projectId)}
                    </span>
                    <Badge tone={job.state === "running" ? "accent" : "neutral"} dot>
                      {JOB_STATE_LABEL[job.state] ?? job.state}
                    </Badge>
                  </span>
                  <ProgressBar value={job.done} total={job.total} thin decorative />
                  <span className="task-item__meta mono">
                    {job.total > 0 ? `${job.done}/${job.total}` : "等待开始"}
                    {job.message ? ` · ${job.message}` : ""}
                  </span>
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  data-testid="task-cancel"
                  aria-label={`取消${jobLabel(job)}：${projectName(job.projectId)}`}
                  disabled={busyId === job.id}
                  onClick={() => void cancelJob(job.id)}
                >
                  {busyId === job.id ? "取消中…" : "取消"}
                </button>
              </div>
            ))}

            {activeCount === 0 ? (
              <p className="list__empty">没有进行中的任务。</p>
            ) : null}

            {history.length > 0 ? (
              <>
                <div className="task-panel__divider">最近完成</div>
                {history.map((h) => (
                  <div
                    className="task-item task-item--history"
                    key={h.key}
                    data-testid="task-history-item"
                  >
                    <button
                      type="button"
                      className="task-item__main"
                      aria-label={`打开历史记录：${h.label}`}
                      title="打开对应页面"
                      onClick={() => jumpTo(h.projectId, h.route, h.taskId)}
                    >
                      <span className="task-item__title">
                        <span className="truncate">{h.label}</span>
                        <Badge
                          tone={
                            h.state === "done"
                              ? "ok"
                              : h.state === "failed"
                                ? "danger"
                                : "neutral"
                          }
                        >
                          {h.stateLabel}
                        </Badge>
                      </span>
                      <span
                        className="task-item__meta mono"
                        title={h.detail || undefined}
                      >
                        {formatTimestamp(h.at)}
                        {h.detail ? ` · ${h.detail}` : ""}
                      </span>
                    </button>
                  </div>
                ))}
                {/* 「翻旧账走审计日志」不能只是一句注释(评审 C2):给条路 */}
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  data-testid="task-history-audit"
                  onClick={() => {
                    closePanel();
                    dispatch({ type: "navigate", route: "projects" });
                  }}
                >
                  查看完整记录（项目详情 → 审计日志）
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
