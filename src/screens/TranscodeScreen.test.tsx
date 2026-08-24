/** 代理转码屏（M3 W5/W6）：ffmpeg 缺失禁用、作业进度/取消、结果分区。 */

import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import * as api from "../api";
import { mockProjects, mockWorkstation } from "../api/mock";
import { mockProxyResult, resetMockJobs } from "../api/mockJobs";
import type { JobSnapshot, TranscodeJob } from "../api/types";

/** 工况 A 项目 */
const projectA = mockProjects.find((p) => p.scenario === "A")!;
const projectB = mockProjects.find((p) => p.scenario === "B")!;

let jobEmitters: Array<(job: JobSnapshot) => void> = [];

beforeEach(() => {
  jobEmitters = [];
  vi.spyOn(api, "subscribeJobProgress").mockImplementation((onEvent) => {
    jobEmitters.push(onEvent);
    return {
      dispose: () => {
        const i = jobEmitters.indexOf(onEvent);
        if (i >= 0) jobEmitters.splice(i, 1);
      },
      ready: Promise.resolve(),
    };
  });
});

afterEach(() => {
  cleanup();
  resetMockJobs();
  vi.restoreAllMocks();
});

function preloaded(projectId: string) {
  return {
    route: "transcode" as const,
    workstation: mockWorkstation,
    projects: mockProjects,
    selectedProjectId: projectId,
  };
}

function transcodeJob(over: Partial<TranscodeJob> = {}): TranscodeJob {
  return {
    id: "job-tc",
    kind: "transcode",
    projectId: projectA.id,
    state: "done",
    done: 48,
    total: 48,
    bytesDone: 1024,
    revision: 5,
    startedAt: "2026-08-24T10:00:00+08:00",
    finishedAt: "2026-08-24T10:20:00+08:00",
    result: mockProxyResult,
    ...over,
  };
}

describe("入口约束", () => {
  it("工况 B 项目不给转码入口，侧栏项禁用并说明原因", async () => {
    render(<App preloaded={preloaded(projectB.id)} />);
    const nav = (await screen.findByTestId("nav-transcode")) as HTMLButtonElement;
    expect(nav.disabled).toBe(true);
    expect(nav.title).toContain("工况 A");
  });

  it("工况 A 项目下入口可用", async () => {
    render(<App preloaded={preloaded(projectA.id)} />);
    const nav = (await screen.findByTestId("nav-transcode")) as HTMLButtonElement;
    expect(nav.disabled).toBe(false);
  });

  it("直接进到工况 B 的转码屏会说清不适用", async () => {
    render(<App preloaded={preloaded(projectB.id)} />);
    expect(await screen.findByTestId("transcode-scenario-b")).toBeDefined();
    expect(screen.queryByTestId("transcode-start")).toBeNull();
  });
});

describe("ffmpeg 缺失", () => {
  it("missing 时禁用开始按钮并给出原因", async () => {
    const spy = vi.spyOn(api, "ffmpegStatus").mockResolvedValue({
      status: "missing",
      error: "未找到 ffmpeg sidecar",
    });

    render(<App preloaded={preloaded(projectA.id)} />);

    const banner = await screen.findByTestId("transcode-ffmpeg-missing");
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain("未找到 ffmpeg sidecar");
    expect(banner.textContent).toContain("请重新安装");

    await waitFor(() =>
      expect(
        (screen.getByTestId("transcode-start") as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    // 强制全转开关也一并禁用
    expect(
      (screen.getByTestId("transcode-force-all") as HTMLInputElement).disabled,
    ).toBe(true);
    spy.mockRestore();
  });

  it("ready 时可以开始", async () => {
    render(<App preloaded={preloaded(projectA.id)} />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("transcode-start") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.queryByTestId("transcode-ffmpeg-missing")).toBeNull();
  });
});

describe("作业生命周期", () => {
  it("启动后显示进度、当前文件与取消按钮", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "startProxyTranscode").mockResolvedValue(
      transcodeJob({
        state: "running",
        done: 12,
        message: "C0012.MP4",
        result: undefined,
        finishedAt: undefined,
      }),
    );

    render(<App preloaded={preloaded(projectA.id)} />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("transcode-start") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByTestId("transcode-start"));

    const panel = await screen.findByTestId("transcode-progress");
    expect(within(panel).getByTestId("transcode-progress-count").textContent).toBe(
      "12/48",
    );
    expect(within(panel).getByTestId("transcode-progress-file").textContent).toBe(
      "C0012.MP4",
    );
    expect(within(panel).getByTestId("transcode-cancel")).toBeDefined();
    spy.mockRestore();
  });

  it("forceAll 开关会传给后端", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, "startProxyTranscode")
      .mockResolvedValue(transcodeJob({ state: "running", result: undefined }));

    render(<App preloaded={preloaded(projectA.id)} />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("transcode-start") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByTestId("transcode-force-all"));
    await user.click(screen.getByTestId("transcode-start"));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0]).toMatchObject({
      projectId: projectA.id,
      forceAll: true,
    });
    spy.mockRestore();
  });

  it("取消走既有 cancelJob，并显示已完成量与安全说明", async () => {
    const user = userEvent.setup();
    const startSpy = vi.spyOn(api, "startProxyTranscode").mockResolvedValue(
      transcodeJob({ state: "running", done: 12, result: undefined }),
    );
    const cancelSpy = vi.spyOn(api, "cancelJob").mockResolvedValue(
      transcodeJob({
        state: "cancelled",
        done: 15,
        revision: 9,
        result: undefined,
      }),
    );

    render(<App preloaded={preloaded(projectA.id)} />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("transcode-start") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByTestId("transcode-start"));
    await screen.findByTestId("transcode-progress");

    await user.click(screen.getByTestId("transcode-cancel"));

    const box = await screen.findByTestId("transcode-cancelled");
    expect(cancelSpy).toHaveBeenCalledWith("job-tc");
    expect(box.textContent).toContain("已完成 15/48");
    expect(box.textContent).toContain("重跑会跳过它们");
    startSpy.mockRestore();
    cancelSpy.mockRestore();
  });

  it("启动失败当普通错误展示并进通知中心", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, "startProxyTranscode")
      .mockRejectedValue(new Error("已有转码作业在运行"));

    render(<App preloaded={preloaded(projectA.id)} />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("transcode-start") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByTestId("transcode-start"));

    const err = await screen.findByTestId("transcode-start-error");
    expect(err.textContent).toContain("已有转码作业在运行");

    await user.click(screen.getByTestId("notice-bell"));
    expect(
      screen
        .getAllByTestId("notice-item")
        .some((n) => n.getAttribute("data-code") === "transcode-start-failed"),
    ).toBe(true);
    spy.mockRestore();
  });
});

describe("结果呈现（result 联合类型判别）", () => {
  async function renderDone(over: Partial<TranscodeJob> = {}) {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, "startProxyTranscode")
      .mockResolvedValue(transcodeJob({ state: "running", result: undefined }));
    render(<App preloaded={preloaded(projectA.id)} />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("transcode-start") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByTestId("transcode-start"));
    await screen.findByTestId("transcode-progress");

    await act(async () => {
      jobEmitters.forEach((emit) => emit(transcodeJob({ revision: 20, ...over })));
    });
    spy.mockRestore();
  }

  it("done 展示转码数/已转码/编码器/输出目录", async () => {
    await renderDone();
    const result = await screen.findByTestId("transcode-result");
    expect(within(result).getByTestId("transcode-converted").textContent).toBe(
      String(mockProxyResult.converted),
    );
    expect(within(result).getByTestId("transcode-already").textContent).toBe(
      String(mockProxyResult.alreadyTranscoded),
    );
    expect(within(result).getByTestId("transcode-encoder").textContent).toContain(
      mockProxyResult.usedEncoder,
    );
    expect(within(result).getByTestId("transcode-output").textContent).toBe(
      mockProxyResult.outputDir,
    );
  });

  it("跳过件逐条给出理由", async () => {
    await renderDone();
    const box = await screen.findByTestId("transcode-skipped");
    expect(box.textContent).toContain("码率低于代理阈值");
    expect(box.textContent).toContain("C0007.MP4");
  });

  it("失败件逐条列出且是 alert", async () => {
    await renderDone();
    const box = await screen.findByTestId("transcode-failures");
    expect(box.getAttribute("role")).toBe("alert");
    expect(box.textContent).toContain("moov atom 缺失");
  });

  it("failed 终态显示错误", async () => {
    await renderDone({ state: "failed", error: "ffmpeg 退出码 1", result: undefined });
    const box = await screen.findByTestId("transcode-failed");
    expect(box.textContent).toContain("ffmpeg 退出码 1");
  });
});

describe("转码不锁其他屏（与交付不同）", () => {
  it("转码进行中侧栏与分类入口都不禁用", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, "startProxyTranscode")
      .mockResolvedValue(transcodeJob({ state: "running", result: undefined }));

    render(<App preloaded={preloaded(projectA.id)} />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("transcode-start") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByTestId("transcode-start"));
    await screen.findByTestId("transcode-progress");

    // 转码只动「4. 转码素材」，不影响其他屏的数据安全
    expect((screen.getByTestId("nav-projects") as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((screen.getByTestId("nav-sorting") as HTMLButtonElement).disabled).toBe(
      false,
    );
    spy.mockRestore();
  });
});
