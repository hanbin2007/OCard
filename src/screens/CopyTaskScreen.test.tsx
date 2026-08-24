import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import App from "../App";
import {
  mockCameras,
  mockCopyTasks,
  mockInspection,
  mockProjects,
  mockStorageCards,
  mockVolumes,
  mockWorkstation,
} from "../api/mock";
import { inferTimeSlot } from "../lib/naming";
import type { CopyProgressEvent } from "../api/types";

afterEach(cleanup);

const preloaded = {
  route: "copy" as const,
  workstation: mockWorkstation,
  projects: mockProjects,
  cameras: mockCameras,
  cards: mockStorageCards,
  volumes: mockVolumes,
  tasks: mockCopyTasks,
  selectedProjectId: mockProjects[0].id,
  selectedTaskId: mockCopyTasks[0].id,
};


/** 等探查回来的时段前缀落到输入框，再继续操作 */
async function waitForInferredPrefix() {
  await waitFor(() =>
    expect((screen.getByLabelText(/目标夹/) as HTMLInputElement).value).not.toBe(""),
  );
}

async function fillDestinations(user: ReturnType<typeof userEvent.setup>) {
  // 第 1 行是 NAS,路径由项目结构自动推导,不可填
  await user.type(screen.getByLabelText("第 2 个目的地路径"), "/backup/ocard");
}

function targetPreview() {
  return screen.getByTestId("copy-target-preview").textContent;
}

describe("拷卡任务面板", () => {
  it("逐文件展示大小、哈希与四种状态", async () => {
    render(<App preloaded={preloaded} />);

    // 明细由 listCopyFiles 分页拉取,不再来自 task.files
    expect(await screen.findByText("C0001.MP4")).toBeDefined();
    expect(screen.getByText("8f2a1c04b7d9e355")).toBeDefined();
    expect(screen.getAllByText("已校验").length).toBeGreaterThan(0);
    expect(screen.getAllByText("已拷").length).toBeGreaterThan(0);
    expect(screen.getAllByText("待拷").length).toBeGreaterThan(0);
    expect(screen.getAllByText("失败").length).toBeGreaterThan(0);
  });

  it("失败文件带原因与重试按钮，其他文件没有", async () => {
    render(<App preloaded={preloaded} />);
    expect(await screen.findByText(/回读校验不一致/)).toBeDefined();
    expect(screen.getByRole("button", { name: "重试 C0007.MP4" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "重试 C0001.MP4" })).toBeNull();
  });

  it("多目的地各自展示写入进度", () => {
    render(<App preloaded={preloaded} />);
    expect(screen.getByText("/Volumes/DIT-NAS/Projects/20260824_校运会/1. 待分类")).toBeDefined();
    expect(screen.getByText("/Volumes/BACKUP-T7/20260824_校运会/1. 待分类")).toBeDefined();
    expect(screen.getAllByText(/写入中/).length).toBeGreaterThanOrEqual(2);
  });

  it("选中源卷自动带出已登记相机与目标路径", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    expect(targetPreview()).toBe("选择相机后生成");
    await user.click(screen.getByRole("radio", { name: "选择源卷 SONY_A7M4" }));

    // 卡 SD-03 关联 Sony A7M4，编码随之带出；时段前缀由卡内素材时间戳推断
    await waitFor(() => expect(targetPreview()).toContain("SonyA7M4_A_LM"));
    // 工况 B 落到「1. 待分类」，前缀由素材最早拍摄时间推断，而不是当前时钟
    const expectedSlot = inferTimeSlot(mockInspection.earliestShotAt);
    expect(targetPreview()).toBe(`1. 待分类/${expectedSlot}_SonyA7M4_A_LM`);
  });

  it("NAS 行只读且不预填平台特有路径", () => {
    render(<App preloaded={preloaded} />);

    const nasRow = screen.getByLabelText("第 1 个目的地路径") as HTMLInputElement;
    expect(nasRow.value).toBe("");
    expect(nasRow.readOnly).toBe(true);
    expect(nasRow.placeholder).toContain("自动推导");

    const localRow = screen.getByLabelText("第 2 个目的地路径") as HTMLInputElement;
    expect(localRow.value).toBe("");
    expect(localRow.readOnly).toBe(false);
  });

  it("自填目的地行留空时逐行标红，不进确认步骤", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    await user.click(screen.getByRole("radio", { name: "选择源卷 SONY_A7M4" }));
    await waitForInferredPrefix();
    await user.type(screen.getByLabelText("内容备注"), "上午田赛");
    // 第 2 行(移动盘)留空就提交
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));

    const alerts = screen.getAllByRole("alert").map((el) => el.textContent);
    expect(alerts.some((t) => t?.includes("请填写目的地路径"))).toBe(true);
    expect(screen.queryByText("确认拷卡信息")).toBeNull();
  });

  it("缺备注时拦下，不新建任务", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    await user.click(screen.getByRole("radio", { name: "选择源卷 SONY_A7M4" }));
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));

    const alerts = screen.getAllByRole("alert").map((el) => el.textContent);
    expect(alerts.some((t) => t?.includes("必填"))).toBe(true);

    const tabs = within(screen.getByRole("group", { name: "任务切换" })).getAllByRole(
      "button",
    );
    expect(tabs).toHaveLength(mockCopyTasks.length);
  });

  it("确认页可以返回修改，不建立任务", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    await user.click(screen.getByRole("radio", { name: "选择源卷 NIKON_Z9" }));
    await waitForInferredPrefix();
    await user.type(screen.getByLabelText("内容备注"), "下午径赛");
    await fillDestinations(user);
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));
    expect(screen.getByText("确认拷卡信息")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "返回修改" }));
    expect(screen.getByLabelText("内容备注")).toBeDefined();
    const group = screen.getByRole("group", { name: "任务切换" });
    expect(within(group).getAllByRole("button")).toHaveLength(mockCopyTasks.length);
  });

  it("双确认填齐后建立任务并置顶选中", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    await user.click(screen.getByRole("radio", { name: "选择源卷 NIKON_Z9" }));
    await waitForInferredPrefix();
    await user.type(screen.getByLabelText("内容备注"), "下午径赛");
    await fillDestinations(user);
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));

    // 第一步只进入汇总复核，不立刻开跑
    expect(screen.getByText("确认拷卡信息")).toBeDefined();
    const group = screen.getByRole("group", { name: "任务切换" });
    expect(within(group).getAllByRole("button")).toHaveLength(mockCopyTasks.length);

    // 确认屏要等后端解析出真实落盘路径后才可开跑
    await waitFor(() =>
      expect(screen.getByTestId("confirm-target-folder").textContent).not.toBe("解析中…"),
    );
    await user.click(screen.getByTestId("copy-confirm-start"));
    await waitFor(() =>
      expect(within(group).getAllByRole("button")).toHaveLength(
        mockCopyTasks.length + 1,
      ),
    );
    // 新任务置顶且带出相机编码构成的目标夹
    expect(screen.getAllByText(/NikonZ9_E_CQ/).length).toBeGreaterThan(0);
  });
});

describe("#4 任务快照刷新失败", () => {
  it("拉不回快照要发通知，不让界面静默显示过期进度", async () => {
    const user = userEvent.setup();
    const pauseSpy = vi.spyOn(api, "pauseCopyTask").mockResolvedValue(undefined);
    const getSpy = vi
      .spyOn(api, "getCopyTask")
      .mockRejectedValue(new Error("NAS 断连"));

    render(<App preloaded={preloaded} />);
    await screen.findByText("C0001.MP4");

    // 挂起后会 refreshTask 对账，此处让它失败
    await user.click(screen.getByRole("button", { name: "挂起" }));

    await user.click(screen.getByTestId("notice-bell"));
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("notice-item")
          .some((n) => n.getAttribute("data-code") === "task-refresh-failed"),
      ).toBe(true),
    );

    pauseSpy.mockRestore();
    getSpy.mockRestore();
  }, 10000);
});

describe("目标夹已存在（TARGET_EXISTS）", () => {
  /** 走到确认屏并等后端解析完成 */
  async function reachConfirm(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("radio", { name: "选择源卷 NIKON_Z9" }));
    await waitForInferredPrefix();
    await user.type(screen.getByLabelText("内容备注"), "下午径赛");
    await fillDestinations(user);
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));
    await waitFor(() =>
      expect(screen.getByTestId("confirm-target-folder").textContent).not.toBe("解析中…"),
    );
  }

  it("后端报 TARGET_EXISTS 时弹确认框，说明只补缺失、绝不覆盖", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, "startCopyTask")
      .mockRejectedValueOnce(new Error("TARGET_EXISTS: 0824下午_NikonZ9_E_CQ 已存在且非空"));

    render(<App preloaded={preloaded} />);
    await reachConfirm(user);
    await user.click(screen.getByTestId("copy-confirm-start"));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("目标夹已存在");
    expect(dialog.textContent).toContain("绝不覆盖");
    expect(spy).toHaveBeenCalledTimes(1);
    // 尚未确认，任务不应被创建
    expect(spy.mock.calls[0][0].confirmExistingTarget).toBeUndefined();
    spy.mockRestore();
  });

  it("用户确认后带 confirmExistingTarget 重发", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, "startCopyTask")
      .mockRejectedValueOnce(new Error("TARGET_EXISTS: 已存在"));

    render(<App preloaded={preloaded} />);
    await reachConfirm(user);
    await user.click(screen.getByTestId("copy-confirm-start"));
    await screen.findByRole("alertdialog");

    await user.click(screen.getByRole("button", { name: "继续拷卡" }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1][0].confirmExistingTarget).toBe(true);
    spy.mockRestore();
  });

  it("取消则不重发，也不创建任务", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, "startCopyTask")
      .mockRejectedValueOnce(new Error("TARGET_EXISTS: 已存在"));

    render(<App preloaded={preloaded} />);
    await reachConfirm(user);
    await user.click(screen.getByTestId("copy-confirm-start"));
    await screen.findByRole("alertdialog");

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);

    const group = screen.getByRole("group", { name: "任务切换" });
    expect(within(group).getAllByRole("button")).toHaveLength(mockCopyTasks.length);
    spy.mockRestore();
  });

  it("非 TARGET_EXISTS 的错误直接显示，不弹确认框", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, "startCopyTask")
      .mockRejectedValueOnce(new Error("NAS 不可达"));

    render(<App preloaded={preloaded} />);
    await reachConfirm(user);
    await user.click(screen.getByTestId("copy-confirm-start"));

    await waitFor(() =>
      expect(
        screen.getAllByRole("alert").some((el) => el.textContent?.includes("NAS 不可达")),
      ).toBe(true),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    spy.mockRestore();
  });
});

describe("文件明细分页", () => {
  it("明细来自 listCopyFiles 而不是 task.files", async () => {
    const spy = vi.spyOn(api, "listCopyFiles");
    render(<App preloaded={preloaded} />);

    await screen.findByText("C0001.MP4");
    expect(spy).toHaveBeenCalledWith(mockCopyTasks[0].id, 0, 200);
    spy.mockRestore();
  });

  it("即便任务对象的 files 为空（契约如此），文件表照样有内容", async () => {
    const stripped = mockCopyTasks.map((t) => ({ ...t, files: [] }));
    render(<App preloaded={{ ...preloaded, tasks: stripped }} />);

    expect(await screen.findByText("C0001.MP4")).toBeDefined();
    expect(screen.getAllByText(/已校验/).length).toBeGreaterThan(0);
  });

  it("「可格式化」提示只认 task.state === done，不依赖前端 files 归约", async () => {
    const doneTask = { ...mockCopyTasks[1], files: [] };
    render(
      <App
        preloaded={{
          ...preloaded,
          tasks: [doneTask],
          selectedTaskId: doneTask.id,
        }}
      />,
    );

    expect(await screen.findByText(/本卡可格式化/)).toBeDefined();
  });
});

describe("分页与进度事件互不打架", () => {
  const TOTAL = 500;

  /** 生成第 offset..offset+limit 条合成文件 */
  function page(offset: number, limit: number) {
    const items = Array.from({ length: Math.min(limit, TOTAL - offset) }, (_, i) => ({
      id: `f-${offset + i}`,
      path: `DCIM/100/IMG_${offset + i}.NEF`,
      name: `IMG_${offset + i}.NEF`,
      sizeBytes: 1024,
      status: "verified" as const,
      hash: "aaaaaaaaaaaaaaaa",
    }));
    return { items, total: TOTAL };
  }

  function setupPagedTask() {
    const listSpy = vi
      .spyOn(api, "listCopyFiles")
      .mockImplementation(async (_taskId, offset = 0, limit = 200) =>
        page(offset, limit),
      );

    // 抓住 store 建立的常驻监听回调，用它手工投递进度事件
    let emit: ((event: CopyProgressEvent) => void) | null = null;
    const subSpy = vi
      .spyOn(api, "subscribeCopyProgress")
      .mockImplementation((onEvent) => {
        emit = onEvent;
        return () => {};
      });

    const runningTask = { ...mockCopyTasks[0], fileCount: TOTAL, files: [] };
    render(
      <App
        preloaded={{
          ...preloaded,
          tasks: [runningTask],
          selectedTaskId: runningTask.id,
        }}
      />,
    );

    return {
      listSpy,
      subSpy,
      taskId: runningTask.id,
      fire: (revision: number) =>
        act(() => {
          emit?.({
            taskId: runningTask.id,
            revision,
            occurredAt: new Date().toISOString(),
            copiedBytes: revision * 1000,
            speedBytesPerSec: 1000,
            state: "running",
            changedFiles: [],
            changedDestinations: [],
          });
        }),
    };
  }

  it("进度事件不会把「加载更多」拿到的页丢掉", async () => {
    const { listSpy, subSpy, fire } = setupPagedTask();

    await screen.findByText("IMG_0.NEF");
    expect(screen.getByTestId("copy-verified-stat").textContent).toBe("已加载 200/500");

    await userEvent.setup().click(screen.getByTestId("copy-load-more-files"));
    await waitFor(() =>
      expect(screen.getByTestId("copy-verified-stat").textContent).toBe("已加载 400/500"),
    );

    // 连发多条进度事件：既不能立刻重拉，更不能把已加载的 400 条打回 200
    fire(1);
    fire(2);
    fire(3);
    expect(screen.getByTestId("copy-verified-stat").textContent).toBe("已加载 400/500");

    // 节流窗口过后只重拉一次，且拉的是 0..已加载条数（而不是固定第一页）
    await waitFor(
      () => {
        const refetch = listSpy.mock.calls.find(
          (c) => c[1] === 0 && (c[2] ?? 0) >= 400,
        );
        expect(refetch).toBeDefined();
      },
      { timeout: 4000 },
    );
    expect(screen.getByTestId("copy-verified-stat").textContent).toBe("已加载 400/500");

    listSpy.mockRestore();
    subSpy.mockRestore();
  });

  it("密集事件被节流，不是一条事件一次 IPC", async () => {
    const { listSpy, subSpy, fire } = setupPagedTask();
    await screen.findByText("IMG_0.NEF");

    const before = listSpy.mock.calls.length;
    for (let i = 1; i <= 10; i += 1) fire(i);

    // 10 条事件在节流窗口内不产生任何新的 IPC
    expect(listSpy.mock.calls.length).toBe(before);

    listSpy.mockRestore();
    subSpy.mockRestore();
  });

  it("未全载时只说「已加载 M/共 N」，不给出全量已校验断言", async () => {
    const { listSpy, subSpy } = setupPagedTask();
    await screen.findByText("IMG_0.NEF");

    const stat = screen.getByTestId("copy-verified-stat");
    // 200 条全是 verified，但绝不能显示成「200/200 已校验」
    expect(stat.textContent).toBe("已加载 200/500");
    expect(stat.textContent).not.toContain("200/200");

    listSpy.mockRestore();
    subSpy.mockRestore();
  });

  it("全部载完后才给出「已校验 x/总数」", async () => {
    const listSpy = vi
      .spyOn(api, "listCopyFiles")
      .mockResolvedValue({ items: page(0, 3).items.slice(0, 3), total: 3 });

    const task = { ...mockCopyTasks[0], fileCount: 3, files: [] };
    render(
      <App preloaded={{ ...preloaded, tasks: [task], selectedTaskId: task.id }} />,
    );

    await screen.findByText("IMG_0.NEF");
    expect(screen.getByTestId("copy-verified-stat").textContent).toBe("3/3");
    expect(screen.queryByTestId("copy-load-more-files")).toBeNull();

    listSpy.mockRestore();
  });
});
