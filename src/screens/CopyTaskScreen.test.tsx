import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import App from "../App";
import {
  mockCameras,
  mockCopyTasks,
  mockProjects,
  mockStorageCards,
  mockVolumes,
  mockWorkstation,
} from "../api/mock";
import { currentTimeSlot, todayCompactDate } from "../lib/naming";
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

/** 工况 B 的默认前缀:本机今天 + 当前时段(不再探查卡内素材) */
function expectedSlotPrefix() {
  return `${todayCompactDate().slice(4)}${currentTimeSlot()}`;
}

/** 在标签选择器里创建并选中一个标签(替代旧的备注文本框) */
async function addTag(user: ReturnType<typeof userEvent.setup>, name: string) {
  const input = screen.getByLabelText("内容标签");
  await user.type(input, name);
  await user.keyboard("{Enter}");
}

async function fillDestinations(_user: ReturnType<typeof userEvent.setup>) {
  // 默认只有 NAS 行(评审 1.1);该项目设置里有备份盘预设——预设是异步落地的,
  // 手动再点「添加目的地」会与之竞态(先到则多出一行空行),这里等预设行即可
  await waitFor(() =>
    expect(
      (screen.getByLabelText("第 2 个目的地路径") as HTMLInputElement).value,
    ).not.toBe(""),
  );
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
    expect(screen.getAllByText("已拷·待校验").length).toBeGreaterThan(0);
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

    // 卡 SD-03 关联 Sony A7M4，编码随之带出
    await waitFor(() => expect(targetPreview()).toContain("SonyA7M4_A_LM"));
    // 工况 B 落到「1. 待分类」，前缀按本机今天 + 当前时段自动填(不探查卡内素材)
    expect(targetPreview()).toBe(`1. 待分类/${expectedSlotPrefix()}_SonyA7M4_A_LM`);
  });

  it("默认只有 NAS 一行:不再预置会拦提交的空移动盘行(评审 1.1)", () => {
    render(<App preloaded={preloaded} />);

    const nasRow = screen.getByLabelText("第 1 个目的地路径") as HTMLInputElement;
    expect(nasRow.value).toBe("");
    expect(nasRow.readOnly).toBe(true);
    expect(nasRow.placeholder).toContain("自动推导");

    expect(screen.queryByLabelText("第 2 个目的地路径")).toBeNull();
    // 双备份用灰字引导,不用空行逼人处理
    expect(screen.getByText(/建议再加一块本地\/移动盘/)).toBeDefined();
  });

  it("手动加的目的地行留空时逐行标红，不进确认步骤", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    await user.click(screen.getByRole("radio", { name: "选择源卷 SONY_A7M4" }));
    await addTag(user, "上午田赛");
    // 项目设置里预设的备份盘会预填进第 2 行:先等它落地再清空,
    // 复现「行存在但没填路径」的场景
    await waitFor(() =>
      expect(
        (screen.getByLabelText("第 2 个目的地路径") as HTMLInputElement).value,
      ).not.toBe(""),
    );
    await user.clear(screen.getByLabelText("第 2 个目的地路径"));
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));

    const alerts = screen.getAllByRole("alert").map((el) => el.textContent);
    expect(alerts.some((t) => t?.includes("请填写目的地路径"))).toBe(true);
    expect(screen.queryByText("确认拷卡信息")).toBeNull();
  });

  it("缺内容标签时拦下，不新建任务", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    await user.click(screen.getByRole("radio", { name: "选择源卷 SONY_A7M4" }));
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));

    const alerts = screen.getAllByRole("alert").map((el) => el.textContent);
    expect(alerts.some((t) => t?.includes("标签"))).toBe(true);

    const tabs = within(screen.getByRole("group", { name: "任务切换" })).getAllByRole(
      "button",
    );
    expect(tabs).toHaveLength(mockCopyTasks.length);
  });

  it("确认页可以返回修改，不建立任务", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    await user.click(screen.getByRole("radio", { name: "选择源卷 NIKON_Z9" }));
    await addTag(user, "下午径赛");
    await fillDestinations(user);
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));
    expect(screen.getByText("确认拷卡信息")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "返回修改" }));
    expect(screen.getByLabelText("内容标签")).toBeDefined();
    const group = screen.getByRole("group", { name: "任务切换" });
    expect(within(group).getAllByRole("button")).toHaveLength(mockCopyTasks.length);
  });

  it("双确认填齐后建立任务并置顶选中", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    await user.click(screen.getByRole("radio", { name: "选择源卷 NIKON_Z9" }));
    await addTag(user, "下午径赛");
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

describe("autoProxy（工况 A）", () => {
  const projectA = mockProjects.find((p) => p.scenario === "A")!;
  const preloadedA = {
    ...preloaded,
    selectedProjectId: projectA.id,
    tasks: [],
  };

  it("工况 B 项目不显示「拷完自动转代理」", async () => {
    render(<App preloaded={preloaded} />);
    await screen.findByText("C0001.MP4");
    expect(screen.queryByTestId("copy-auto-proxy")).toBeNull();
  });

  it("工况 A 项目显示勾选项，勾上后随 StartCopyInput 传给后端", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "startCopyTask");

    render(<App preloaded={preloadedA} />);
    const checkbox = (await screen.findByTestId(
      "copy-auto-proxy",
    )) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    await user.click(checkbox);

    await user.click(screen.getByRole("radio", { name: "选择源卷 SONY_A7M4" }));
    await addTag(user, "发布会主机位");
    // 该项目无预设备份盘:默认只有 NAS 行(评审 1.1),第二块盘显式添加
    await user.click(screen.getByRole("button", { name: "添加目的地" }));
    await user.type(screen.getByLabelText("第 2 个目的地路径"), "/backup/ocard");
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));

    // 双确认屏要如实显示这项
    await waitFor(() =>
      expect(screen.getByTestId("confirm-auto-proxy").textContent).toContain(
        "是，拷完自动派发转码作业",
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("confirm-target-folder").textContent).not.toBe(
        "解析中…",
      ),
    );
    await user.click(screen.getByTestId("copy-confirm-start"));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0].autoProxy).toBe(true);
    spy.mockRestore();
  }, 15000);
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
    await user.click(screen.getByRole("button", { name: "暂停" }));

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
    await addTag(user, "下午径赛");
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

  /**
   * ★ 部分拷贝完成时**绝不许**出现「本卡可格式化」。
   *
   * 这是全应用后果最重的一句文案：按文件夹拷时卡上还留着没拷的内容，
   * 照说那句话会引导用户在相机里格式化掉未备份素材，且不可逆。
   * 范围口径只认后端回填的 `task.sourceFolders`，不看屏内表单状态
   * （表单在拷贝期间可能已被改动）。
   */
  it("★ 部分拷贝完成不许说「可格式化」，且要点名拷了哪些文件夹", async () => {
    const partial = {
      ...mockCopyTasks[1],
      files: [],
      sourceFolders: ["DCIM/100MSDCF", "PRIVATE/M4ROOT/CLIP"],
    };
    render(
      <App
        preloaded={{
          ...preloaded,
          tasks: [partial],
          selectedTaskId: partial.id,
        }}
      />,
    );

    const notice = await screen.findByTestId("copy-partial-done");
    expect(notice.textContent).toMatch(/请勿格式化/);
    // 拷了哪些必须写出来:只说「部分」而不说「哪部分」等于让人自己猜
    expect(notice.textContent).toMatch(/DCIM\/100MSDCF/);
    expect(notice.textContent).toMatch(/PRIVATE\/M4ROOT\/CLIP/);
    expect(screen.queryByText(/本卡可格式化/)).toBeNull();
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

    // statusCounts 置空:这组测试盯的是「旧后端没有全量计数」的回退口径
    const runningTask = {
      ...mockCopyTasks[0],
      fileCount: TOTAL,
      files: [],
      statusCounts: undefined,
    };
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

    const task = {
      ...mockCopyTasks[0],
      fileCount: 3,
      files: [],
      statusCounts: undefined,
    };
    render(
      <App preloaded={{ ...preloaded, tasks: [task], selectedTaskId: task.id }} />,
    );

    await screen.findByText("IMG_0.NEF");
    expect(screen.getByTestId("copy-verified-stat").textContent).toBe("3/3");
    expect(screen.queryByTestId("copy-load-more-files")).toBeNull();

    listSpy.mockRestore();
  });

  it("后端带全量计数时,未全载也显示真值总账(评审 2.5)", async () => {
    const TOTAL = 500;
    const listSpy = vi
      .spyOn(api, "listCopyFiles")
      .mockImplementation((_taskId, offset = 0, limit = 200) =>
        Promise.resolve(page(offset, limit)),
      );

    const task = {
      ...mockCopyTasks[0],
      fileCount: TOTAL,
      files: [],
      statusCounts: { pending: 120, copied: 40, verified: 337, failed: 3 },
    };
    render(
      <App preloaded={{ ...preloaded, tasks: [task], selectedTaskId: task.id }} />,
    );

    await screen.findByText("IMG_0.NEF");
    // 只加载了第一页(200/500),总账仍然是全量真值,不再被分页挟持
    expect(screen.getByTestId("copy-verified-stat").textContent).toBe("337/500");
    expect(screen.getByText(/待拷 120 · 已拷 40 · 已校验 337 · 失败 3/)).toBeDefined();

    listSpy.mockRestore();
  });
});

describe("源卷过滤与刷新(UX 波)", () => {
  it("系统内置盘默认被隐藏,并显示忽略开关", async () => {
    render(<App preloaded={preloaded} />);

    const options = screen.getAllByTestId("copy-volume-option");
    expect(options).toHaveLength(mockVolumes.filter((v) => !v.isSystem).length);
    expect(screen.queryByText("Macintosh HD")).toBeNull();

    const toggle = screen.getByTestId("volumes-hide-system") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it("关掉忽略开关后系统盘出现并带「系统盘」标注", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    await user.click(screen.getByTestId("volumes-hide-system"));
    expect(screen.getAllByTestId("copy-volume-option")).toHaveLength(
      mockVolumes.length,
    );
    expect(screen.getByText("Macintosh HD")).toBeDefined();
    expect(screen.getByText("系统盘")).toBeDefined();
  });

  it("「刷新」重拉卷列表,开机后插的卡能出现", async () => {
    const newCard = {
      id: "vol-new",
      name: "FX3_CARD",
      mountPath: "/Volumes/FX3_CARD",
      capacityBytes: 512 * 2 ** 30,
      usedBytes: 100 * 2 ** 30,
      removable: true,
      isSystem: false,
    };
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);
    // 先等进屏自动刷新落定,再装「插了新卡」的桩——
    // 否则自动刷新就能把断言喂饱,点按钮那条路径根本没被测到
    await screen.findAllByText("SONY_A7M4");
    await waitFor(() =>
      expect(
        (screen.getByTestId("volumes-refresh") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.queryByText("FX3_CARD")).toBeNull();
    const spy = vi
      .spyOn(api, "listVolumes")
      .mockResolvedValue([...mockVolumes, newCard]);

    await user.click(screen.getByTestId("volumes-refresh"));
    expect(await screen.findByText("FX3_CARD")).toBeDefined();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("刷新失败会有可见报错,不静默", async () => {
    const spy = vi
      .spyOn(api, "listVolumes")
      .mockRejectedValue(new Error("volume backend down"));

    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    await user.click(screen.getByTestId("volumes-refresh"));
    await waitFor(() =>
      expect(
        screen.getAllByText(/刷新卡列表失败/).length,
      ).toBeGreaterThan(0),
    );
    spy.mockRestore();
  });
});

describe("侧栏切项目不换页(UX 波二)", () => {
  it("在拷卡屏点侧栏最近项目:项目切换,页面留在拷卡", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);
    await screen.findAllByText("SONY_A7M4");

    // 侧栏最近项目里点第二个项目
    const sideButtons = screen.getAllByText(mockProjects[1].name);
    await user.click(sideButtons[0]);

    // 仍在拷卡任务屏(源卷区还在),但当前项目已变
    expect(screen.getByTestId("copy-volume-select")).toBeDefined();
    expect(screen.getByTestId("current-project-chip").textContent).toContain(
      mockProjects[1].name,
    );
  });
});

describe("切项目的状态隔离(codex 评审 P1)", () => {
  it("确认屏在切项目时立刻失效:不许对着 A 的预览把任务落进 B", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    await user.click(screen.getByRole("radio", { name: "选择源卷 NIKON_Z9" }));
    await addTag(user, "下午径赛");
    await fillDestinations(user);
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));
    expect(screen.getByText("确认拷卡信息")).toBeDefined();

    // 侧栏切到另一个项目:确认屏必须整体退回表单
    await user.click(screen.getByText(mockProjects[1].name));
    expect(screen.queryByText("确认拷卡信息")).toBeNull();
    expect(screen.getByLabelText("内容标签")).toBeDefined();
  });
});

/* ------------------------------------------------------------------ *
 * hero：同一条管道，静止示意 → 运行真值
 * ------------------------------------------------------------------ */

describe("拷卡 hero 的流向管道", () => {
  it("没有任务时管道是静止示意：不报 progressbar，只留 data-state=idle", async () => {
    render(<App preloaded={{ ...preloaded, tasks: [], selectedTaskId: null }} />);

    const bar = await screen.findByTestId("copy-flowbar");
    expect(bar.getAttribute("data-state")).toBe("idle");
    // 静止态没有进度可言,报成 progressbar 只会让读屏器念一个假的 0%
    expect(bar.getAttribute("role")).toBeNull();
    expect(bar.getAttribute("aria-hidden")).toBe("true");
    // 动效被关掉也读得出状态:文字状态任何时候都在
    expect(screen.getByTestId("copy-flow-caption").textContent).toContain("源读一次");
  });

  it("任务在跑时同一个元素直接承载真实进度（不是换成另一块 UI）", async () => {
    render(<App preloaded={preloaded} />);

    const bar = await screen.findByTestId("copy-flowbar");
    expect(bar.getAttribute("data-state")).toBe("running");
    expect(bar.getAttribute("role")).toBe("progressbar");
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
    // 百分比与速度也跟着上到管道旁边
    expect(screen.getByTestId("copy-flow-percent")).toBeDefined();
    expect(screen.getByTestId("copy-flow-caption").textContent).toContain(
      mockCopyTasks[0].volumeName,
    );
  });
});

/* ------------------------------------------------------------------ *
 * 源「按文件夹多选」
 * ------------------------------------------------------------------ */

describe("按文件夹多选", () => {
  /** 选卷 → 展开文件夹面板 → 等清单出来 */
  async function openPicker(
    user: ReturnType<typeof userEvent.setup>,
    volumeName = "NIKON_Z9",
  ) {
    await user.click(screen.getByRole("radio", { name: `选择源卷 ${volumeName}` }));
    await user.click(screen.getByTestId("copy-folder-toggle"));
    await screen.findByTestId("copy-folder-list");
  }

  /** 填齐其余必填项并进入双确认屏 */
  async function reachConfirm(user: ReturnType<typeof userEvent.setup>) {
    await addTag(user, "下午径赛");
    await fillDestinations(user);
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));
    await waitFor(() =>
      expect(screen.getByTestId("confirm-target-folder").textContent).not.toBe("解析中…"),
    );
  }

  it("默认整卷：不展开面板，提交也不带 sourceFolders", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "startCopyTask");
    render(<App preloaded={preloaded} />);

    expect(screen.getByTestId("copy-source-scope").textContent).toBe("整卷（卡内全部）");
    expect(screen.queryByTestId("copy-folder-picker")).toBeNull();

    await user.click(screen.getByRole("radio", { name: "选择源卷 NIKON_Z9" }));
    await reachConfirm(user);
    // 整卷也照样核算规模,双确认屏永远有「N 个文件」这条真值
    await waitFor(() =>
      expect(screen.getByTestId("confirm-plan-scale").textContent).toContain("个文件"),
    );
    expect(screen.getByTestId("confirm-source-scope").textContent).toContain("整卷");
    await user.click(screen.getByTestId("copy-confirm-start"));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    // 空 = 整卷,但干脆不带这个字段:与老客户端请求体逐字节一致
    expect(spy.mock.calls[0][0].sourceFolders).toBeUndefined();
    spy.mockRestore();
  }, 15000);

  it("列表逐条给出相对路径、直接子文件数、大小与有无子目录", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);
    await openPicker(user);

    const list = screen.getByTestId("copy-folder-list");
    // 卷根恒排第一
    expect(list.textContent).toContain("（卷根）");
    // 子目录不递归,自己是独立一条
    expect(screen.getByLabelText("选择文件夹 DCIM")).toBeDefined();
    expect(screen.getByLabelText("选择文件夹 DCIM/100MSDCF")).toBeDefined();
    expect(screen.getByLabelText("选择文件夹 PRIVATE/M4ROOT/CLIP")).toBeDefined();
    // 只有直接子文件数,不含子目录里的
    expect(list.textContent).toContain("3 个文件");
    expect(list.textContent).toContain("含子目录（另有条目）");
  });

  it("勾选多个文件夹后，双确认屏给出文件数与改名清单", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "startCopyTask");
    render(<App preloaded={preloaded} />);
    await openPicker(user);

    await user.click(screen.getByLabelText("选择文件夹 DCIM/100MSDCF"));
    await user.click(screen.getByLabelText("选择文件夹 DCIM/101MSDCF"));
    expect(screen.getByTestId("copy-source-scope").textContent).toBe("已选 2 个文件夹");

    await reachConfirm(user);

    await waitFor(() =>
      expect(screen.getByTestId("confirm-plan-scale").textContent).toContain("6 个文件"),
    );
    // 改名 = 系统替用户改了文件名,必须逐条明示
    const renames = screen.getByTestId("confirm-renames");
    expect(renames.textContent).toContain("4 个文件将被系统自动改名");
    expect(renames.textContent).toContain("DCIM/100MSDCF/C0001.MP4");
    expect(renames.textContent).toContain("100MSDCF_C0001.MP4");
    expect(renames.textContent).toContain("101MSDCF_C0001.MP4");

    await user.click(screen.getByTestId("copy-confirm-start"));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0].sourceFolders).toEqual([
      "DCIM/100MSDCF",
      "DCIM/101MSDCF",
    ]);
    spy.mockRestore();
  }, 20000);

  it("改名条数多时折叠，但「共几条」始终可见", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);
    await openPicker(user);

    await user.click(screen.getByLabelText("选择文件夹 DCIM/100MSDCF"));
    await user.click(screen.getByLabelText("选择文件夹 DCIM/101MSDCF"));
    await user.click(screen.getByLabelText("选择文件夹 PRIVATE/M4ROOT/CLIP"));
    await reachConfirm(user);

    await waitFor(() =>
      expect(screen.getByTestId("confirm-renames").textContent).toContain(
        "7 个文件将被系统自动改名",
      ),
    );
    // 折的只是明细,数量任何时候都在
    expect(screen.getAllByTestId("confirm-rename-item")).toHaveLength(5);
    await user.click(screen.getByTestId("confirm-renames-expand"));
    expect(screen.getAllByTestId("confirm-rename-item")).toHaveLength(7);
  }, 20000);

  it("planSourceSelection 失败：报错 + 重试，绝不静默退回整卷继续", async () => {
    const user = userEvent.setup();
    const startSpy = vi.spyOn(api, "startCopyTask");
    const planSpy = vi
      .spyOn(api, "planSourceSelection")
      .mockRejectedValue(new Error("卡上目录读不动"));

    render(<App preloaded={preloaded} />);
    await openPicker(user);
    await user.click(screen.getByLabelText("选择文件夹 DCIM/100MSDCF"));
    await reachConfirm(user);

    const banner = await screen.findByTestId("copy-plan-error");
    expect(banner.textContent).toContain("无法核算本次拷贝范围");
    // 没有改名清单就开跑 = 静默改名:确认按钮必须是死的
    expect(
      (screen.getByTestId("copy-confirm-start") as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(screen.getByTestId("copy-confirm-start"));
    expect(startSpy).not.toHaveBeenCalled();

    planSpy.mockResolvedValueOnce({
      fileCount: 3,
      totalBytes: 1024,
      renamedFiles: [],
    });
    await user.click(screen.getByTestId("copy-plan-retry"));
    await waitFor(() =>
      expect(screen.getByTestId("confirm-plan-scale").textContent).toContain("3 个文件"),
    );
    expect(
      (screen.getByTestId("copy-confirm-start") as HTMLButtonElement).disabled,
    ).toBe(false);

    planSpy.mockRestore();
    startSpy.mockRestore();
  }, 20000);

  it("listSourceFolders 失败：就地报错 + 重试，范围仍停在整卷", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, "listSourceFolders")
      .mockRejectedValue(new Error("卡被拔了"));

    render(<App preloaded={preloaded} />);
    await user.click(screen.getByRole("radio", { name: "选择源卷 NIKON_Z9" }));
    await user.click(screen.getByTestId("copy-folder-toggle"));

    const banner = await screen.findByTestId("copy-folder-error");
    expect(banner.textContent).toContain("卡被拔了");
    expect(screen.getByTestId("copy-source-scope").textContent).toBe("整卷（卡内全部）");

    spy.mockRestore();
    await user.click(screen.getByTestId("copy-folder-retry"));
    expect(await screen.findByTestId("copy-folder-list")).toBeDefined();
  }, 15000);

  it("切到「按文件夹」却一个没勾：拦下提交，不静默按整卷跑", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "startCopyTask");
    render(<App preloaded={preloaded} />);
    await openPicker(user);

    await user.click(screen.getByTestId("copy-scope-folders"));
    await addTag(user, "下午径赛");
    await fillDestinations(user);
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));

    expect(screen.getByTestId("copy-folder-error-empty").textContent).toContain(
      "至少勾一个",
    );
    expect(screen.queryByText("确认拷卡信息")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  }, 15000);

  it("换源卷会清掉文件夹选择，并且出声（路径属于上一张卡）", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);
    await openPicker(user);
    await user.click(screen.getByLabelText("选择文件夹 DCIM/100MSDCF"));
    expect(screen.getByTestId("copy-source-scope").textContent).toBe("已选 1 个文件夹");

    await user.click(screen.getByRole("radio", { name: "选择源卷 SONY_A7M4" }));
    await waitFor(() =>
      expect(screen.getByTestId("copy-source-scope").textContent).toBe(
        "整卷（卡内全部）",
      ),
    );

    await user.click(screen.getByTestId("notice-bell"));
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("notice-item")
          .some((n) => n.getAttribute("data-code") === "source-folders-reset"),
      ).toBe(true),
    );
  }, 15000);
});

describe("按文件夹多选的空选择", () => {
  it("只勾了「只有子目录」的父目录：明说一个文件都不会拷，并拦住开始", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "startCopyTask");
    render(<App preloaded={preloaded} />);

    await user.click(screen.getByRole("radio", { name: "选择源卷 NIKON_Z9" }));
    await user.click(screen.getByTestId("copy-folder-toggle"));
    await screen.findByTestId("copy-folder-list");
    // DCIM 自身没有直接子文件,素材都在它的两个子目录里
    await user.click(screen.getByLabelText("选择文件夹 DCIM"));

    await addTag(user, "下午径赛");
    await fillDestinations(user);
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));

    const warn = await screen.findByTestId("confirm-plan-empty");
    expect(warn.textContent).toContain("一个文件都不会拷");
    expect(screen.getByTestId("confirm-plan-scale").textContent).toContain("0 个文件");
    expect(
      (screen.getByTestId("copy-confirm-start") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  }, 20000);
});
