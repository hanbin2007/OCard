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
import { mockArchiveResult, mockProjects, mockWorkstation } from "../api/mock";
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

function preloaded(projectId: string | null) {
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
  it("工况 B 项目下侧栏项仍可点(禁用会变成无提示的死门),标注不适用", async () => {
    render(<App preloaded={preloaded(projectB.id)} />);
    const nav = (await screen.findByTestId("nav-transcode")) as HTMLButtonElement;
    expect(nav.disabled).toBe(false);
    expect(nav.dataset.inapplicable).toBe("true");
    expect(nav.title).toContain("工况 A");
  });

  it("工况 A 项目下入口可用且无不适用标注", async () => {
    render(<App preloaded={preloaded(projectA.id)} />);
    const nav = (await screen.findByTestId("nav-transcode")) as HTMLButtonElement;
    expect(nav.disabled).toBe(false);
    expect(nav.dataset.inapplicable).toBeUndefined();
  });

  it("进到工况 B 的转码屏会说清不适用,并给出回项目列表的动作", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded(projectB.id)} />);
    expect(await screen.findByTestId("transcode-scenario-b")).toBeDefined();
    expect(screen.queryByTestId("transcode-start")).toBeNull();
    await user.click(screen.getByTestId("transcode-goto-projects"));
    // 浏览器单窗口形态:打开项目管理 = 切到欢迎视图(Tauri 下为独立窗口)
    expect(await screen.findByTestId("welcome-root")).toBeDefined();
  });

  it("未选项目时进转码屏给出空态与去路,而不是一句死话", async () => {
    render(<App preloaded={preloaded(null)} />);
    expect(await screen.findByTestId("transcode-no-project")).toBeDefined();
    expect(screen.getByTestId("transcode-goto-projects")).toBeDefined();
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

  it("#5 强制全转文案说真话：不承诺重转已有输出", async () => {
    render(<App preloaded={preloaded(projectA.id)} />);
    const label = (await screen.findByTestId("transcode-force-all")).closest(
      "label",
    ) as HTMLElement;
    expect(label.textContent).toContain("忽略「高负载」判定");
    expect(label.textContent).toContain("不会");
    // 旧文案承诺「重转所有素材」，与后端行为不符
    expect(label.textContent).not.toContain("重转所有素材");
  });

  it("#5 强制重转必须经二次确认，取消则不下发", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "startProxyTranscode");

    render(<App preloaded={preloaded(projectA.id)} />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("transcode-retranscode") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByTestId("transcode-retranscode"));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("先删除");
    expect(dialog.textContent).toContain("无法恢复");
    expect(dialog.textContent).toContain("原始素材不受影响");
    expect(spy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("#5 确认后带 retranscode 参数下发", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, "startProxyTranscode")
      .mockResolvedValue(transcodeJob({ state: "running", result: undefined }));

    render(<App preloaded={preloaded(projectA.id)} />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("transcode-retranscode") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByTestId("transcode-retranscode"));
    await user.click(screen.getByRole("button", { name: "删除并重转" }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0].retranscode).toBe(true);
    spy.mockRestore();
  });

  it("#P2 结果计数 testid 内含数值，E2E 可直接断言", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, "startProxyTranscode")
      .mockResolvedValue(transcodeJob());
    render(<App preloaded={preloaded(projectA.id)} />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("transcode-start") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByTestId("transcode-start"));

    const result = await screen.findByTestId("transcode-result");
    expect(within(result).getByTestId("transcode-converted").textContent).toMatch(
      /^\d+$/,
    );
    expect(within(result).getByTestId("transcode-already").textContent).toMatch(
      /^\d+$/,
    );
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

    // 提交后失败统一走 toast(UX 波三):屏内不再有内联横幅
    const toast = await screen.findByTestId("notice-toasts");
    expect(toast.textContent).toContain("已有转码作业在运行");

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

describe("归档转码", () => {
  async function ready() {
    const user = userEvent.setup();
    render(<App preloaded={preloaded(projectA.id)} />);
    await waitFor(() =>
      expect((screen.getByTestId("archive-start") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    return user;
  }

  it("三档可选，档位说明随之变化", async () => {
    const user = await ready();
    expect(screen.getByTestId("archive-tier-balanced").getAttribute("aria-checked")).toBe(
      "true",
    );

    await user.click(screen.getByTestId("archive-tier-quality"));
    expect(screen.getByTestId("archive-tier-quality").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByTestId("archive-section").textContent).toContain(
      "输出体积可能接近源文件",
    );
  });

  it("输出目录必须是绝对路径，相对路径被拦下且不下发", async () => {
    const user = await ready();
    const spy = vi.spyOn(api, "startArchiveTranscode");

    await user.type(screen.getByTestId("archive-dir"), "归档/2026");
    await user.click(screen.getByTestId("archive-start"));

    expect(screen.getByTestId("archive-error").textContent).toContain("绝对路径");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("二次确认说明体积与不改动原始素材，取消则不下发", async () => {
    const user = await ready();
    const spy = vi.spyOn(api, "startArchiveTranscode");

    await user.type(screen.getByTestId("archive-dir"), "/Volumes/ARCHIVE-2026");
    await user.click(screen.getByTestId("archive-start"));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("接近源文件体积");
    expect(dialog.textContent).toContain("原始素材不受影响");
    expect(spy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("确认后按所选档位与目录下发", async () => {
    const user = await ready();
    const spy = vi
      .spyOn(api, "startArchiveTranscode")
      .mockResolvedValue(transcodeJob({ state: "running", result: undefined }));

    await user.click(screen.getByTestId("archive-tier-compact"));
    await user.type(screen.getByTestId("archive-dir"), "/Volumes/ARCHIVE-2026");
    await user.click(screen.getByTestId("archive-start"));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "开始归档",
      }),
    );

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0]).toMatchObject({
      projectId: projectA.id,
      tier: "compact",
      outputDir: "/Volumes/ARCHIVE-2026",
    });
    spy.mockRestore();
  });

  it("归档结果按 ArchiveResult 渲染，不会错当代理结果", async () => {
    const user = await ready();
    const spy = vi
      .spyOn(api, "startArchiveTranscode")
      .mockResolvedValue(
        transcodeJob({ state: "done", result: mockArchiveResult, revision: 30 }),
      );

    await user.type(screen.getByTestId("archive-dir"), "/Volumes/ARCHIVE-2026");
    await user.click(screen.getByTestId("archive-start"));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "开始归档",
      }),
    );

    const box = await screen.findByTestId("archive-result");
    expect(within(box).getByTestId("archive-converted").textContent).toBe(
      String(mockArchiveResult.converted),
    );
    expect(within(box).getByTestId("archive-already").textContent).toBe(
      String(mockArchiveResult.alreadyArchived),
    );
    expect(within(box).getByTestId("archive-output").textContent).toBe(
      mockArchiveResult.outputDir,
    );
    // 归档结果不该走代理结果那套字段
    expect(screen.queryByTestId("transcode-result")).toBeNull();
    spy.mockRestore();
  });
});

describe("作业对账", () => {
  it("丢了终态事件时，窗口 focus 会对账补回来", async () => {
    const running = transcodeJob({ state: "running", revision: 2, result: undefined });
    const finished = transcodeJob({ state: "done", revision: 9 });

    const startSpy = vi
      .spyOn(api, "startProxyTranscode")
      .mockResolvedValue(running);
    // 订阅期间终态事件丢失，listJobs 才拿得到真状态
    const listSpy = vi
      .spyOn(api, "listJobs")
      .mockResolvedValueOnce([]) // 挂载时的对账：还没有作业
      .mockResolvedValue([finished]);

    const user = userEvent.setup();
    render(<App preloaded={preloaded(projectA.id)} />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("transcode-start") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByTestId("transcode-start"));
    await screen.findByTestId("transcode-progress");

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() =>
      expect(screen.queryByTestId("transcode-progress")).toBeNull(),
    );
    expect(await screen.findByTestId("transcode-result")).toBeDefined();
    startSpy.mockRestore();
    listSpy.mockRestore();
  }, 15000);

  it("手动「刷新作业状态」也能对账", async () => {
    const user = userEvent.setup();
    const listSpy = vi.spyOn(api, "listJobs").mockResolvedValue([]);
    render(<App preloaded={preloaded(projectA.id)} />);
    await screen.findByTestId("jobs-refresh");

    const before = listSpy.mock.calls.length;
    await user.click(screen.getByTestId("jobs-refresh"));
    await waitFor(() =>
      expect(listSpy.mock.calls.length).toBeGreaterThan(before),
    );
    listSpy.mockRestore();
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
    expect((screen.getByTestId("nav-manager") as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((screen.getByTestId("nav-sorting") as HTMLButtonElement).disabled).toBe(
      false,
    );
    spy.mockRestore();
  });
});
