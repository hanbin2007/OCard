/**
 * mock 作业引擎：模拟「排队 → 运行（若干次进度）→ 完成」的时间线，支持取消。
 * 仅用于非 Tauri 环境（浏览器预览 / 测试），真实实现全在 Rust 侧。
 */

import type { JobSnapshot } from "./types";
import { mockDelivery } from "./mock";

const TICK_MS = 120;
const TOTAL_FILES = 769;
const STEPS = 4;

const jobs = new Map<string, JobSnapshot>();
const listeners = new Set<(job: JobSnapshot) => void>();
const timers = new Map<string, ReturnType<typeof setInterval>>();
let seq = 0;

function emit(job: JobSnapshot) {
  jobs.set(job.id, job);
  for (const listener of [...listeners]) listener(job);
}

function bump(job: JobSnapshot, patch: Partial<JobSnapshot>): JobSnapshot {
  return { ...job, ...patch, revision: job.revision + 1 };
}

export function mockSubscribeJobs(onEvent: (job: JobSnapshot) => void): () => void {
  listeners.add(onEvent);
  return () => listeners.delete(onEvent);
}

export function mockListJobs(): JobSnapshot[] {
  return [...jobs.values()];
}

export function mockGetJob(jobId: string): JobSnapshot | null {
  return jobs.get(jobId) ?? null;
}

export function mockStartDelivery(projectId: string): JobSnapshot {
  seq += 1;
  const id = `job-${seq}`;
  const job: JobSnapshot = {
    id,
    kind: "delivery",
    projectId,
    state: "queued",
    done: 0,
    total: TOTAL_FILES,
    bytesDone: 0,
    revision: 1,
    startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);

  let step = 0;
  const timer = setInterval(() => {
    const current = jobs.get(id);
    if (!current || current.state === "cancelled") {
      clearInterval(timer);
      timers.delete(id);
      return;
    }
    step += 1;
    if (step >= STEPS) {
      clearInterval(timer);
      timers.delete(id);
      emit(
        bump(current, {
          state: "done",
          done: TOTAL_FILES,
          bytesDone: mockDelivery.totalBytes,
          message: undefined,
          finishedAt: new Date().toISOString(),
          result: mockDelivery,
        }),
      );
      return;
    }
    const done = Math.floor((TOTAL_FILES * step) / STEPS);
    emit(
      bump(current, {
        state: "running",
        done,
        bytesDone: Math.floor((mockDelivery.totalBytes * step) / STEPS),
        message: `DSC_${String(done).padStart(5, "0")}.JPG`,
      }),
    );
  }, TICK_MS);
  timers.set(id, timer);

  return job;
}

export function mockCancelJob(jobId: string): JobSnapshot {
  const current = jobs.get(jobId);
  if (!current) throw new Error(`作业不存在：${jobId}`);
  const timer = timers.get(jobId);
  if (timer) {
    clearInterval(timer);
    timers.delete(jobId);
  }
  // 取消是终态且 result 为空：已完成量看 done/total
  const cancelled = bump(current, {
    state: "cancelled",
    finishedAt: new Date().toISOString(),
    message: undefined,
  });
  emit(cancelled);
  return cancelled;
}

/** 测试用：清空作业时间线 */
export function resetMockJobs() {
  for (const timer of timers.values()) clearInterval(timer);
  timers.clear();
  jobs.clear();
  seq = 0;
}
