/**
 * 任务中心(用户点单):跨项目、跨类型的后台任务统一入口。
 * 此前拷卡/转码/分析/交付的进度分散在各屏——A 项目在转码、B 项目在拷卡时
 * 必须来回切屏才能各看各的。这里聚合 store 里已有的全量快照
 * (state.tasks + state.jobs),给进行中任务列表 + 最近完成历史,
 * 行内可挂起/继续(拷卡)、取消(作业),点行跳到对应项目对应屏。
 */

import { useCallback, useEffect, useRef } from "react";
import * as api from "../api";
import type { CopyTask, JobSnapshot } from "../api/types";
import { isJobTerminal } from "../api/types";
import { formatBytes, formatSpeed, formatTimestamp, ratio } from "../lib/format";
import { TASK_STATE_LABEL, TASK_STATE_TONE } from "../lib/labels";
import { withViewTransition } from "../lib/motion";
import {
  selectDeliveryWorking,
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

const JOB_STATE_LABEL: Record<string, string> = {
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

function isCopyActive(t: CopyTask): boolean {
  return t.state === "running" || t.state === "verifying" || t.state === "paused";
}

export function TaskCenter() {
  const { state, dispatch, refreshTask, reconcileJobs } = useStore();
  const notify = useNotify();
  const open = state.taskCenterOpen;
  const wrapRef = useRef<HTMLDivElement>(null);
  const deliveryWorking = selectDeliveryWorking(state);

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
  const activeJobs = state.jobs.filter(
    (j) => j.state === "queued" || j.state === "running",
  );
  const activeCount = activeCopies.length + activeJobs.length;

  const historyCopies = state.tasks.filter(
    (t) => t.state === "done" || t.state === "failed",
  );
  const historyJobs = state.jobs.filter((j) => isJobTerminal(j.state));
  const history = [
    ...historyCopies.map((t) => ({
      key: `copy-${t.id}`,
      label: `拷卡 · ${projectName(t.projectId)}`,
      detail: t.targetFolder,
      state: t.state as string,
      at: t.finishedAt ?? t.startedAt,
    })),
    ...historyJobs.map((j) => ({
      key: `job-${j.id}`,
      label: `${JOB_KIND_LABEL[j.kind]} · ${projectName(j.projectId)}`,
      detail: j.error ?? "",
      state: j.state as string,
      at: j.finishedAt ?? j.startedAt,
    })),
  ]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, HISTORY_CAP);

  /** 跳到任务所在的项目与屏。交付打包期间与侧栏同一把锁,不开旁门。 */
  function jumpTo(projectId: string, route: RouteName, taskId?: string) {
    if (deliveryWorking) return;
    dispatch({ type: "selectProject", projectId });
    if (taskId) dispatch({ type: "selectTask", taskId });
    dispatch({ type: "navigate", route });
    closePanel();
  }

  async function cancelJob(jobId: string) {
    try {
      const snapshot = await api.cancelJob(jobId);
      dispatch({ type: "jobProgress", job: snapshot });
      if (isJobTerminal(snapshot.state) && snapshot.state !== "cancelled") {
        notify(
          "warning",
          "job-cancel-too-late",
          "作业在取消生效前已经结束,本次取消未生效。",
        );
      }
    } catch (err) {
      notify(
        "error",
        "job-cancel-failed",
        `取消作业失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function pauseOrResume(task: CopyTask) {
    try {
      if (task.state === "paused") {
        await api.resumeCopyTask(task.id);
      } else {
        await api.pauseCopyTask(task.id);
      }
      await refreshTask(task.id);
    } catch (err) {
      notify(
        "error",
        "copy-pause-failed",
        `${task.state === "paused" ? "继续" : "挂起"}拷卡失败：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
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
            <span className="card__hint push-right">
              {activeCount > 0 ? `${activeCount} 个进行中` : "当前没有进行中的任务"}
            </span>
          </div>

          <div className="notice-panel__list">
            {activeCopies.map((task) => (
              <div className="task-item" key={task.id} data-testid="task-item">
                <button
                  type="button"
                  className="task-item__main"
                  disabled={deliveryWorking}
                  title={
                    deliveryWorking
                      ? "交付打包进行中，完成后才能切换页面"
                      : "打开拷卡任务"
                  }
                  onClick={() => jumpTo(task.projectId, "copy", task.id)}
                >
                  <span className="task-item__title">
                    拷卡 · {projectName(task.projectId)}
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
                    {` · ${Math.round(ratio(task.copiedBytes, task.totalBytes) * 100)}%`}
                  </span>
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  data-testid={
                    task.state === "paused" ? "task-resume" : "task-pause"
                  }
                  onClick={() => void pauseOrResume(task)}
                >
                  {task.state === "paused" ? "继续" : "挂起"}
                </button>
              </div>
            ))}

            {activeJobs.map((job) => (
              <div className="task-item" key={job.id} data-testid="task-item">
                <button
                  type="button"
                  className="task-item__main"
                  disabled={deliveryWorking}
                  title={
                    deliveryWorking
                      ? "交付打包进行中，完成后才能切换页面"
                      : "打开对应页面"
                  }
                  onClick={() => jumpTo(job.projectId, JOB_ROUTE[job.kind])}
                >
                  <span className="task-item__title">
                    {JOB_KIND_LABEL[job.kind]} · {projectName(job.projectId)}
                    <Badge tone={job.state === "running" ? "accent" : "neutral"} dot>
                      {JOB_STATE_LABEL[job.state] ?? job.state}
                    </Badge>
                  </span>
                  <ProgressBar value={job.done} total={job.total} thin decorative />
                  <span className="task-item__meta mono">
                    {job.done}/{job.total}
                    {job.message ? ` · ${job.message}` : ""}
                  </span>
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  data-testid="task-cancel"
                  onClick={() => void cancelJob(job.id)}
                >
                  取消
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
                    <span className="task-item__title">
                      {h.label}
                      <Badge
                        tone={
                          h.state === "done"
                            ? "ok"
                            : h.state === "failed"
                              ? "danger"
                              : "neutral"
                        }
                      >
                        {TASK_STATE_LABEL[h.state as CopyTask["state"]] ??
                          JOB_STATE_LABEL[h.state] ??
                          h.state}
                      </Badge>
                    </span>
                    <span className="task-item__meta mono">
                      {formatTimestamp(h.at)}
                      {h.detail ? ` · ${h.detail}` : ""}
                    </span>
                  </div>
                ))}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
