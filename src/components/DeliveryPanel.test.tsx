/**
 * 交付打包（M3 作业化）：确认 → 进度 → 终态。
 * 终态 done 必须渲染与作业化之前**完全相同**的结果块（delivery-result 语义，E2E 依赖）。
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import * as api from "../api";
import { mockDelivery, mockProjects, mockWorkstation } from "../api/mock";
import { resetMockJobs } from "../api/mockJobs";
import type { DeliveryJob, DeliverySummary, JobSnapshot } from "../api/types";

/** 收集 store 建立的作业订阅回调，供测试手工投递事件 */
let jobEmitters: Array<(job: JobSnapshot) => void> = [];

beforeEach(() => {
  jobEmitters = [];
  // 装在 beforeEach 里：模块级 spy 会被 restoreAllMocks 清掉
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

const preloaded = {
  route: "sorting" as const,
  workstation: mockWorkstation,
  projects: mockProjects,
  selectedProjectId: mockProjects[0].id,
};

function deliveryJob(over: Partial<DeliveryJob> = {}): DeliveryJob {
  return {
    id: "job-test",
    kind: "delivery",
    projectId: mockProjects[0].id,
    state: "done",
    done: 769,
    total: 769,
    bytesDone: mockDelivery.totalBytes,
    revision: 9,
    startedAt: "2026-08-24T10:00:00+08:00",
    finishedAt: "2026-08-24T10:05:00+08:00",
    result: mockDelivery,
    ...over,
  };
}

async function openWorkbench() {
  const user = userEvent.setup();
  render(<App preloaded={preloaded} />);
  await screen.findAllByTestId("asset-cell");
  return user;
}

/** 走完「确认 → 开始」，startDelivery 直接返回给定终态/进行态快照 */
async function startWith(job: JobSnapshot) {
  const spy = vi.spyOn(api, "startDelivery").mockResolvedValue(job);
  const user = await openWorkbench();
  await user.click(screen.getByTestId("delivery-open"));
  await screen.findByRole("alertdialog");
  await user.click(screen.getByRole("button", { name: "开始打包" }));
  return { user, spy };
}

describe("确认与启动", () => {
  it("点开先出确认对话框，确认前不启动作业", async () => {
    const spy = vi.spyOn(api, "startDelivery");
    const user = await openWorkbench();
    await user.click(screen.getByTestId("delivery-open"));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("精选/已修");
    expect(dialog.textContent).toContain("待分类与待修不交付");
    expect(dialog.textContent).toContain("不改动分类夹里的原件");
    expect(dialog.textContent).toContain("打包期间请勿在任何工作站进行分类操作");
    expect(dialog.textContent).toContain("上传网盘与发送链接仍需人工完成");
    expect(spy).not.toHaveBeenCalled();
  });

  it("取消则不启动作业", async () => {
    const spy = vi.spyOn(api, "startDelivery");
    const user = await openWorkbench();
    await user.click(screen.getByTestId("delivery-open"));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("delivery-result")).toBeNull();
  });

  it("启动失败当普通错误展示并进通知中心", async () => {
    const spy = vi
      .spyOn(api, "startDelivery")
      .mockRejectedValue(new Error("交付打包进行中，请稍候"));
    const user = await openWorkbench();
    await user.click(screen.getByTestId("delivery-open"));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "开始打包" }));

    const err = await screen.findByTestId("delivery-error");
    expect(err.textContent).toContain("交付打包进行中");

    await user.click(screen.getByTestId("delivery-close"));
    await user.click(screen.getByTestId("notice-bell"));
    expect(screen.getByTestId("notice-item").getAttribute("data-code")).toBe(
      "delivery-failed",
    );
    spy.mockRestore();
  });
});

describe("进度视图", () => {
  it("排队/运行中显示文件名、done/total、进度条与取消按钮", async () => {
    await startWith(
      deliveryJob({
        state: "running",
        done: 300,
        total: 769,
        message: "DSC_00300.JPG",
        result: undefined,
        finishedAt: undefined,
      }),
    );

    const panel = await screen.findByTestId("delivery-progress");
    expect(within(panel).getByTestId("delivery-progress-count").textContent).toBe(
      "300/769",
    );
    expect(within(panel).getByTestId("delivery-progress-file").textContent).toBe(
      "DSC_00300.JPG",
    );
    expect(within(panel).getByTestId("delivery-cancel")).toBeDefined();
    // 进行中不该出现结果块
    expect(screen.queryByTestId("delivery-result")).toBeNull();
  });

  it("取消后显示「已取消，重跑安全续打」并按快照给出已完成量", async () => {
    const { user } = await startWith(
      deliveryJob({
        state: "running",
        done: 300,
        result: undefined,
        finishedAt: undefined,
      }),
    );
    await screen.findByTestId("delivery-progress");

    const cancelSpy = vi.spyOn(api, "cancelJob").mockResolvedValue(
      deliveryJob({
        state: "cancelled",
        done: 312,
        total: 769,
        revision: 12,
        result: undefined,
      }),
    );
    await user.click(screen.getByTestId("delivery-cancel"));

    const result = await screen.findByTestId("delivery-result");
    expect(within(result).getByTestId("delivery-cancelled").textContent).toContain(
      "已取消，清单按实况已更新，重跑安全续打",
    );
    // result 为空，已完成量来自快照计数
    expect(
      within(result).getByTestId("delivery-cancelled-count").textContent,
    ).toContain("312/769");
    cancelSpy.mockRestore();
  });

  /**
   * 取消请求在路上时作业自己跑完了。
   * 后端此时会回一句「已请求取消，作业将在当前文件完成后停止」——
   * 对一个已经结束的作业，这是假话。前端必须把真相补上，
   * 否则用户会以为是自己取消掉的，回头找不到打包结果。
   */
  it("取消晚了一步（作业已跑完）时如实说没生效，不假装取消成功", async () => {
    const { user } = await startWith(
      deliveryJob({
        state: "running",
        done: 760,
        result: undefined,
        finishedAt: undefined,
      }),
    );
    await screen.findByTestId("delivery-progress");

    // 取消打到后端时作业已经 done：返回的是完成快照，不是 cancelled
    const cancelSpy = vi
      .spyOn(api, "cancelJob")
      .mockResolvedValue(deliveryJob({ state: "done", revision: 12 }));

    await user.click(screen.getByTestId("delivery-cancel"));

    await waitFor(() => expect(cancelSpy).toHaveBeenCalledTimes(1));
    const toast = await screen.findByTestId("notice-toast-info");
    expect(toast.getAttribute("data-code")).toBe("job-cancel-too-late");
    expect(toast.textContent).toContain("本次取消未生效");

    // 结果块给的是「完成」，不是「已取消」——不能把完成说成取消
    const result = await screen.findByTestId("delivery-result");
    expect(within(result).queryByTestId("delivery-cancelled")).toBeNull();
    cancelSpy.mockRestore();
  });

  it("作业已经是终态时根本不发取消请求", async () => {
    await startWith(
      deliveryJob({
        state: "running",
        done: 760,
        result: undefined,
        finishedAt: undefined,
      }),
    );
    await screen.findByTestId("delivery-progress");

    const cancelSpy = vi.spyOn(api, "cancelJob");
    // 按钮还在屏幕上的那一帧，作业已经在后台跑完了
    await act(async () => {
      jobEmitters.forEach((emit) =>
        emit(deliveryJob({ state: "done", revision: 20 })),
      );
    });
    // 进度视图已经让位给结果块，取消按钮随之消失——这本身就是第一道防线
    expect(screen.queryByTestId("delivery-cancel")).toBeNull();
    expect(cancelSpy).not.toHaveBeenCalled();
    cancelSpy.mockRestore();
  });
});

describe("终态 done 的结果块（E2E 依赖，语义保持不变）", () => {
  it("逐包列出并给出合计", async () => {
    await startWith(deliveryJob());
    await screen.findByTestId("delivery-result");

    const packages = screen.getAllByTestId("delivery-package");
    expect(packages).toHaveLength(mockDelivery.packages.length);
    expect(packages[0].textContent).toContain("0824上午");
    expect(screen.getByTestId("delivery-total").textContent).toContain("本次新交付");
    expect(screen.getByTestId("delivery-package-note").textContent).toContain(
      "当前实况",
    );
  });

  it("alreadyDelivered 作为正常结果展示", async () => {
    await startWith(
      deliveryJob({
        result: { ...mockDelivery, alreadyDelivered: 24, failures: [] },
      }),
    );
    await screen.findByTestId("delivery-result");

    expect(screen.getByTestId("delivery-headline").textContent).toContain(
      "已交付跳过 24 个",
    );
    expect(screen.getByTestId("delivery-already").textContent).toContain(
      "绝不覆盖已有交付文件",
    );
    expect(screen.queryByTestId("delivery-errors")).toBeNull();
  });

  it("name-collision 标为未交付并提示人工核对", async () => {
    await startWith(
      deliveryJob({
        result: {
          ...mockDelivery,
          alreadyDelivered: 0,
          failures: [
            {
              assetId: "5. 其他/DSC_9.JPG",
              message: "包内同名文件内容不同",
              kind: "name-collision",
            },
          ],
        },
      }),
    );
    await screen.findByTestId("delivery-result");

    const box = screen.getByTestId("delivery-errors");
    expect(box.getAttribute("role")).toBe("alert");
    expect(box.textContent).toContain("1 个文件未交付");
    expect(screen.getByTestId("delivery-collision-note").textContent).toContain(
      "请人工核对",
    );
  });

  it("manifest-error 单列为可重跑补齐", async () => {
    await startWith(
      deliveryJob({
        result: {
          ...mockDelivery,
          alreadyDelivered: 0,
          failures: [
            { assetId: "a.JPG", message: "清单条目未写入", kind: "manifest-error" },
          ],
        },
      }),
    );
    await screen.findByTestId("delivery-result");

    expect(screen.getByTestId("delivery-manifest-errors").textContent).toContain(
      "重新执行一次打包即可补齐",
    );
    expect(screen.queryByTestId("delivery-errors")).toBeNull();
  });

  it("失败超过 8 条指向交付总清单", async () => {
    await startWith(
      deliveryJob({
        result: {
          ...mockDelivery,
          alreadyDelivered: 0,
          failures: Array.from({ length: 12 }, (_, i) => ({
            assetId: `x/DSC_${i}.JPG`,
            message: "磁盘写满",
            kind: "error" as const,
          })),
        },
      }),
    );
    await screen.findByTestId("delivery-result");

    const hint = screen.getByTestId("delivery-more-hint");
    expect(hint.textContent).toContain("交付总清单.txt");
    expect(hint.textContent).not.toContain("通知中心");
  });

  it("交付目录可定位，并提醒上传仍需人工", async () => {
    const reveal = vi.spyOn(api, "revealPath").mockResolvedValue(undefined);
    const { user } = await startWith(deliveryJob());
    const result = await screen.findByTestId("delivery-result");

    expect(screen.getByTestId("delivery-path").textContent).toBe(
      mockDelivery.deliveryPath,
    );
    await user.click(screen.getByTestId("delivery-reveal"));
    expect(reveal).toHaveBeenCalledWith(mockDelivery.deliveryPath);
    expect(within(result).getByText(/上传网盘与发送链接需人工完成/)).toBeDefined();
  });

  it("作业 failed 显示错误与重试入口", async () => {
    await startWith(
      deliveryJob({ state: "failed", error: "NAS 只读", result: undefined }),
    );
    const err = await screen.findByTestId("delivery-error");
    expect(err.textContent).toContain("NAS 只读");
    expect(screen.getByTestId("delivery-retry")).toBeDefined();
  });
});

describe("作业进行中的互斥（M2 收口行为必须保持）", () => {
  const runningJob = deliveryJob({
    state: "running",
    done: 5,
    result: undefined,
    finishedAt: undefined,
  });

  async function enterWorking() {
    const { user } = await startWith(runningJob);
    await screen.findByTestId("sorting-delivery-lock");
    return user;
  }

  it("分类条禁用并给出锁定提示", async () => {
    await enterWorking();
    const chip = screen
      .getAllByTestId("sorting-category")
      .find((c) => c.getAttribute("data-category") === "cat-1") as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
  });

  it("D 键标删无效", async () => {
    await enterWorking();
    const gridWrap = screen.getByTestId("sorting-grid-wrap");
    fireEvent.keyDown(gridWrap, { key: "ArrowRight" });
    fireEvent.keyDown(gridWrap, { key: "d" });
    expect(screen.queryByTestId("sorting-pending-delete")).toBeNull();
  });

  it("打包期间导航放行(评审 4.3):进度/结果由 store 承载,不再锁死全站", async () => {
    await enterWorking();
    // 分类操作仍锁(同一批文件不能边打包边挪),但导航自由(评审 4.3)
    expect(screen.getByTestId("sorting-delivery-lock")).toBeDefined();
    expect(
      (screen.getByTestId("nav-manager") as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByTestId("sorting-open-trash") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("进度对话框可转入后台,任务中心接管;完成时结果自动弹回", async () => {
    const user = await enterWorking();
    await user.click(screen.getByTestId("delivery-background"));
    expect(screen.queryByTestId("delivery-progress")).toBeNull();

    const done = deliveryJob({ state: "done", revision: 99 });
    await act(async () => {
      jobEmitters.forEach((emit) => emit(done));
    });
    await screen.findByTestId("delivery-result");
  });

  it("作业转终态后互斥解除", async () => {
    await enterWorking();

    const done = deliveryJob({ state: "done", revision: 99 });
    // 直接走订阅回调：与真实事件同路径
    await act(async () => {
      jobEmitters.forEach((emit) => emit(done));
    });

    await waitFor(() =>
      expect(screen.queryByTestId("sorting-delivery-lock")).toBeNull(),
    );
    expect(
      (screen.getByTestId("nav-manager") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("乱序与对账", () => {
  it("revision 倒退的事件不会把进度拉回去", async () => {
    await startWith(
      deliveryJob({
        state: "running",
        done: 300,
        revision: 10,
        result: undefined,
        finishedAt: undefined,
      }),
    );
    await screen.findByTestId("delivery-progress");

    await act(async () => {
      jobEmitters.forEach((emit) =>
        emit(
          deliveryJob({
            state: "running",
            done: 5,
            revision: 4,
            result: undefined,
            finishedAt: undefined,
          }),
        ),
      );
    });

    expect(screen.getByTestId("delivery-progress-count").textContent).toBe(
      "300/769",
    );
  });

  it("ready 之后用 listJobs 对账，补回订阅前就结束的作业", async () => {
    const finished = deliveryJob({ id: "job-early", state: "done", revision: 20 });
    const listSpy = vi.spyOn(api, "listJobs").mockResolvedValue([finished]);

    render(<App preloaded={preloaded} />);
    await screen.findAllByTestId("asset-cell");

    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    // 对账后终态结果块可见——订阅前结束的作业没有被丢掉
    expect(await screen.findByTestId("delivery-result")).toBeDefined();
    listSpy.mockRestore();
  });
});

describe("DeliverySummary 类型未变（E2E 结果块语义）", () => {
  it("done 作业的 result 就是 DeliverySummary", async () => {
    const summary: DeliverySummary = mockDelivery;
    await startWith(deliveryJob({ result: summary }));
    await screen.findByTestId("delivery-result");
    expect(screen.getByTestId("delivery-headline")).toBeDefined();
  });
});
