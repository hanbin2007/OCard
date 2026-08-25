/**
 * mock 作业引擎：模拟「排队 → 运行（若干次进度）→ 完成」的时间线，支持取消。
 * 仅用于非 Tauri 环境（浏览器预览 / 测试），真实实现全在 Rust 侧。
 */

import type {
  AnalysisResult,
  AnalyzeJob,
  DeliveryJob,
  JobSnapshot,
  ProxyResult,
  TranscodeJob,
} from "./types";
import { isJobTerminal } from "./types";
import { mockArchiveResult, mockDelivery } from "./mock";

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

/** 泛型保 kind：联合类型下不能用宽 Partial<JobSnapshot>，否则判别信息会被抹掉 */
function bump<T extends JobSnapshot>(job: T, patch: Partial<T>): T {
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

export function mockStartDelivery(projectId: string): DeliveryJob {
  seq += 1;
  const id = `job-${seq}`;
  const job: DeliveryJob = {
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
  // 与后端 request_cancel 对齐：已经是终态的作业原样返回，
  // 绝不把一个已完成的作业改写成「已取消」——那是对历史的篡改
  if (isJobTerminal(current.state)) return current;
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

/* ------------------------------------------------------------------ *
 * 转码作业时间线
 * ------------------------------------------------------------------ */

const TRANSCODE_TOTAL = 48;

export const mockProxyResult: ProxyResult = {
  mode: "proxy",
  converted: 44,
  alreadyTranscoded: 2,
  skipped: [
    { rel: "2. 原始素材/20260822_A7M4_A_LM/C0007.MP4", reason: "码率低于代理阈值，无需转码" },
    { rel: "2. 原始素材/20260822_A7M4_A_LM/C0012.MP4", reason: "已是 H.264 代理规格" },
  ],
  failures: [
    { rel: "2. 原始素材/20260822_A7M4_A_LM/C0031.MP4", message: "解码失败：moov atom 缺失" },
  ],
  usedEncoder: "h264_videotoolbox",
  outputDir: "/Volumes/DIT-NAS/Projects/20260822_年中发布会/4. 转码素材",
};

export function mockStartProxyTranscode(projectId: string): TranscodeJob {
  seq += 1;
  const id = `job-${seq}`;
  const job: TranscodeJob = {
    id,
    kind: "transcode",
    projectId,
    state: "queued",
    done: 0,
    total: TRANSCODE_TOTAL,
    bytesDone: 0,
    revision: 1,
    startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);

  let step = 0;
  const timer = setInterval(() => {
    const current = jobs.get(id);
    if (!current || current.kind !== "transcode" || current.state === "cancelled") {
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
          done: TRANSCODE_TOTAL,
          message: undefined,
          finishedAt: new Date().toISOString(),
          result: mockProxyResult,
        }),
      );
      return;
    }
    const done = Math.floor((TRANSCODE_TOTAL * step) / STEPS);
    emit(
      bump(current, {
        state: "running",
        done,
        bytesDone: done * 512 * 1024 * 1024,
        message: `C${String(done).padStart(4, "0")}.MP4`,
      }),
    );
  }, TICK_MS);
  timers.set(id, timer);

  return job;
}

/* ------------------------------------------------------------------ *
 * 分析作业时间线
 * ------------------------------------------------------------------ */

const ANALYZE_TOTAL = 1240;

export const mockAnalysisResult: AnalysisResult = {
  analyzed: 1180,
  cached: 57,
  missing: 2,
  failed: [
    { rel: "1. 待分类/0824上午_NikonZ9_E_CQ/DSC_00099.NEF", message: "RAW 解码失败" },
  ],
  videoThumbs: 26,
  // 演示「转码引擎缺失导致视频抽帧被跳过」：这类降级必须在完成时说出来
  videoThumbsSkipped: 4,
  cacheSkippedLines: 3,
};

export function mockStartAnalysis(projectId: string): AnalyzeJob {
  seq += 1;
  const id = `job-${seq}`;
  const job: AnalyzeJob = {
    id,
    kind: "analyze",
    projectId,
    state: "queued",
    done: 0,
    total: ANALYZE_TOTAL,
    bytesDone: 0,
    revision: 1,
    startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);

  let step = 0;
  const timer = setInterval(() => {
    const current = jobs.get(id);
    if (!current || current.kind !== "analyze" || current.state === "cancelled") {
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
          done: ANALYZE_TOTAL,
          message: undefined,
          finishedAt: new Date().toISOString(),
          result: mockAnalysisResult,
        }),
      );
      return;
    }
    const done = Math.floor((ANALYZE_TOTAL * step) / STEPS);
    emit(bump(current, { state: "running", done, message: `分析中 ${done}` }));
  }, TICK_MS);
  timers.set(id, timer);

  return job;
}


/** 归档作业时间线（kind 仍是 transcode，result 是 ArchiveResult） */
export function mockStartArchive(projectId: string): TranscodeJob {
  seq += 1;
  const id = `job-${seq}`;
  const job: TranscodeJob = {
    id,
    kind: "transcode",
    projectId,
    state: "queued",
    done: 0,
    total: 44,
    bytesDone: 0,
    revision: 1,
    startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);

  let step = 0;
  const timer = setInterval(() => {
    const current = jobs.get(id);
    if (!current || current.kind !== "transcode" || current.state === "cancelled") {
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
          done: 44,
          message: undefined,
          finishedAt: new Date().toISOString(),
          result: mockArchiveResult,
        }),
      );
      return;
    }
    const done = Math.floor((44 * step) / STEPS);
    emit(bump(current, { state: "running", done, message: `归档中 ${done}` }));
  }, TICK_MS);
  timers.set(id, timer);

  return job;
}
