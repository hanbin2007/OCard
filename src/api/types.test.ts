/**
 * 契约判别函数。
 *
 * 这两个函数是「前端怎么理解后端」的落点，判错了不会抛异常，
 * 只会安安静静把归档结果渲染成代理结果、把已完成的作业说成"将停止"。
 * 所以必须钉死。
 */

import { afterEach, describe, expect, it } from "vitest";
import { isArchiveResult, isJobTerminal, type JobState } from "./types";
import { mockArchiveResult } from "./mock";
import {
  mockCancelJob,
  mockProxyResult,
  mockStartDelivery,
  resetMockJobs,
} from "./mockJobs";

afterEach(() => resetMockJobs());

describe("isArchiveResult", () => {
  it("认后端下发的 mode 判别字段，不认字段结构", () => {
    expect(isArchiveResult(mockArchiveResult)).toBe(true);
    expect(isArchiveResult(mockProxyResult)).toBe(false);
    expect(isArchiveResult(undefined)).toBe(false);
  });

  it("mode 是唯一判据：即使代理结果里恰好也带了 alreadyArchived，也不会被误判成归档", () => {
    // 结构嗅探在这种情况下会翻车——这正是换成判别字段的原因
    const proxyWithExtraField = {
      ...mockProxyResult,
      alreadyArchived: 3,
    } as unknown as typeof mockProxyResult;
    expect(isArchiveResult(proxyWithExtraField)).toBe(false);
  });

  it("两个 mock 各自带对了 mode——mock 与真实契约不一致等于测试在自欺", () => {
    expect(mockProxyResult.mode).toBe("proxy");
    expect(mockArchiveResult.mode).toBe("archive");
  });
});

describe("isJobTerminal", () => {
  it("done / failed / cancelled 是终态，queued / running 不是", () => {
    const terminal: JobState[] = ["done", "failed", "cancelled"];
    const live: JobState[] = ["queued", "running"];
    for (const state of terminal) expect(isJobTerminal(state)).toBe(true);
    for (const state of live) expect(isJobTerminal(state)).toBe(false);
  });
});

describe("mockCancelJob 与后端 request_cancel 对齐", () => {
  it("取消运行中的作业 → 转为 cancelled", () => {
    const job = mockStartDelivery("p-1");
    const cancelled = mockCancelJob(job.id);
    expect(cancelled.state).toBe("cancelled");
  });

  it("对已经是终态的作业发取消 → 原样返回，绝不把已完成改写成已取消", () => {
    const job = mockStartDelivery("p-1");
    const cancelled = mockCancelJob(job.id);
    expect(cancelled.state).toBe("cancelled");

    // 再取消一次：终态不该被二次改写（finishedAt 等字段也必须原样）
    const again = mockCancelJob(job.id);
    expect(again).toEqual(cancelled);
  });

  it("作业不存在时如实报错，不返回一个凭空捏造的快照", () => {
    expect(() => mockCancelJob("job-nope")).toThrow(/不存在/);
  });
});
