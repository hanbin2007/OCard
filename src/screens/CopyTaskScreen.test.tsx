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
import { focusablesIn } from "../lib/focusTrap";
import { currentTimeSlot, todayCompactDate } from "../lib/naming";
import type { CopyProgressEvent, CopyTaskPreview, SourcePlan } from "../api/types";

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

/**
 * 文件夹行的读屏名 = 「选择文件夹 <相对路径>，<可见 meta>」。
 * meta 也在名字里(E10:`aria-label` 会覆盖可见文字,漏掉它等于读屏用户
 * 听不到「含子目录（另有条目）」这条最容易误解的规则),所以这里按前缀匹配。
 */
function folderCheckbox(relPath: string): HTMLElement {
  const escaped = relPath.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return screen.getByLabelText(new RegExp(`^选择文件夹 ${escaped}，`));
}

/** 等「确认开始」真的可点：preview 与 plan 都落地之前它是灰的 */
async function confirmReady() {
  await waitFor(() =>
    expect(
      (screen.getByTestId("copy-confirm-start") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
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
    // 双备份用灰字引导,不用空行逼人处理。这句引导全屏只此一份:
    // 以前 hero 摘要里还有一句意思相同、措辞不同的孪生句
    expect(screen.getAllByText(/建议再加一块本地\/移动盘/)).toHaveLength(1);
  });

  it("目的地就在 hero 那张卡里当场改，不是只读摘要 + 跳转", async () => {
    // 钉住这次搬家:hero 右侧曾经只是只读摘要 + 一个「设置」按钮,按下去把
    // 焦点甩到下半区老远的编辑处。谁再把编辑本体搬回 <form> 里,这条先红。
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    const dests = screen.getByTestId("copy-dests");
    expect(dests.closest(".copy-stage"), "目的地编辑应当在 hero 里").not.toBeNull();
    expect(dests.closest("#copy-form"), "不该退回下半区的拷卡设置表单").toBeNull();
    // 「开始拷卡」与它同处一张卡:改完就在原地开跑,中间没有一跳
    expect(screen.getByTestId("copy-start").closest(".copy-stage__node--dest")).toBe(
      dests.closest(".copy-stage__node--dest"),
    );

    // 就地可改:不必先去点任何「设置」把自己送到别处
    await fillDestinations(user);
    await user.click(within(dests).getByRole("button", { name: "添加目的地" }));
    const added = screen.getByLabelText("第 3 个目的地路径") as HTMLInputElement;
    expect(added.closest(".copy-stage")).not.toBeNull();
    await user.type(added, "/Volumes/BK-3");
    expect(added.value).toBe("/Volumes/BK-3");
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

  it("确认屏开着时目的地整组锁死（hero 一直在，改得动就等于清单和确认屏不一致）", async () => {
    // 源卷早就 disabled={confirming} 了。目的地搬进 hero 之后同样会在确认期间
    // 继续显示,不锁就能一边看着「将要执行的清单」一边把它改掉。
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    const dests = screen.getByTestId("copy-dests") as HTMLFieldSetElement;
    expect(dests.disabled).toBe(false);
    expect(screen.queryByTestId("copy-dests-locked")).toBeNull();

    await user.click(screen.getByRole("radio", { name: "选择源卷 NIKON_Z9" }));
    await addTag(user, "下午径赛");
    await fillDestinations(user);
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));
    expect(screen.getByText("确认拷卡信息")).toBeDefined();

    // fieldset 一次锁住整组:类型下拉、路径框、选盘、删除、添加目的地
    expect(dests.disabled).toBe(true);
    for (const el of within(dests).getAllByRole("button")) {
      expect((el as HTMLButtonElement).matches(":disabled"), el.textContent ?? "").toBe(
        true,
      );
    }
    expect(
      (screen.getByLabelText("第 2 个目的地路径") as HTMLInputElement).matches(
        ":disabled",
      ),
    ).toBe(true);

    // 锁了必须说得出「谁锁的、怎么解」:控件的 disabled 态在输入框上几乎
    // 看不出来,不写这一行就是静默降级
    expect(screen.getByTestId("copy-dests-locked").textContent).toContain("返回修改");

    // 返回修改后必须重新解锁,否则就成了单向的死锁
    await user.click(screen.getByRole("button", { name: "返回修改" }));
    expect(dests.disabled).toBe(false);
    expect(screen.queryByTestId("copy-dests-locked")).toBeNull();
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
    expect(folderCheckbox("DCIM")).toBeDefined();
    expect(folderCheckbox("DCIM/100MSDCF")).toBeDefined();
    expect(folderCheckbox("PRIVATE/M4ROOT/CLIP")).toBeDefined();
    // 只有直接子文件数,不含子目录里的
    expect(list.textContent).toContain("3 个文件");
    expect(list.textContent).toContain("含子目录（另有条目）");
  });

  it("勾选多个文件夹后，双确认屏给出文件数与改名清单", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "startCopyTask");
    render(<App preloaded={preloaded} />);
    await openPicker(user);

    await user.click(folderCheckbox("DCIM/100MSDCF"));
    await user.click(folderCheckbox("DCIM/101MSDCF"));
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
    // 用户批准的是**这一份**计划:令牌必须原样回传,否则后端无从判断
    // 「他确认过的那份清单是否还成立」
    expect(spy.mock.calls[0][0].planDigest).toBeTruthy();
    spy.mockRestore();
  }, 20000);

  it("PLAN_CHANGED：退回双确认屏重新核对，绝不自动重试", async () => {
    const user = userEvent.setup();
    const planSpy = vi.spyOn(api, "planSourceSelection");
    const startSpy = vi
      .spyOn(api, "startCopyTask")
      .mockRejectedValue(
        new Error("PLAN_CHANGED: 卡上的内容在你确认之后发生了变化,请重新核对"),
      );

    render(<App preloaded={preloaded} />);
    await openPicker(user);
    await user.click(folderCheckbox("DCIM/100MSDCF"));
    await reachConfirm(user);
    await waitFor(() =>
      expect(screen.getByTestId("confirm-plan-scale").textContent).toContain("个文件"),
    );
    const plansBefore = planSpy.mock.calls.length;

    await user.click(screen.getByTestId("copy-confirm-start"));

    // 必须留在确认屏并显式说明原因
    const banner = await screen.findByTestId("copy-plan-changed");
    expect(banner.textContent).toContain("请重新核对");
    // 自动重试 = 替用户批准一份他没看过的清单,绝对不许
    expect(startSpy).toHaveBeenCalledTimes(1);
    // 但要重新核算一次,让他看到的是新真值
    await waitFor(() =>
      expect(planSpy.mock.calls.length).toBeGreaterThan(plansBefore),
    );

    planSpy.mockRestore();
    startSpy.mockRestore();
  }, 20000);

  /**
   * ★ 后端 `PLAN_CHANGED:` 冒号后那句话必须原样透传。
   *
   * 后端为此专门做了定性:换卡了 / 多了文件 / 少了文件 / 只有 mtime 变了 /
   * 令牌认不出,各有措辞、有的点名到文件。前端若套一句笼统的「计划变了」,
   * 这一轮的价值就全抹掉了,还会把人引向错误的排查方向——实际是「文件被
   * 改过」却让人去翻读卡器。
   */
  it("★ PLAN_CHANGED 的具体原因原样展示，不许被笼统文案盖掉", async () => {
    const user = userEvent.setup();
    const cause =
      "有 2 个文件在你确认之后被改动过（大小没变，但内容可能不同）：A001.MP4、A002.MP4。";
    const startSpy = vi
      .spyOn(api, "startCopyTask")
      .mockRejectedValue(new Error(`PLAN_CHANGED: ${cause}`));

    render(<App preloaded={preloaded} />);
    await openPicker(user);
    await user.click(folderCheckbox("DCIM/100MSDCF"));
    await reachConfirm(user);
    await waitFor(() =>
      expect(screen.getByTestId("confirm-plan-scale").textContent).toContain("个文件"),
    );
    await user.click(screen.getByTestId("copy-confirm-start"));

    const banner = await screen.findByTestId("copy-plan-changed");
    expect(banner.textContent).toContain("被改动过");
    expect(banner.textContent).toContain("A001.MP4");
    // 笼统兜底只该在后端没给原因时出现
    expect(banner.textContent).not.toContain("可能是换了卡");
    startSpy.mockRestore();
  }, 20000);

  /**
   * 口径已变(2026-08-28):曾经是「以点开头一律跳过」,那会把 `.clip.mov`
   * 这类合法素材静默漏掉而任务照样报 100%。现在只排除明确列举的系统项,
   * 文案必须跟着改准——说成「点开头的都不拷」会让人白白去给素材改名。
   */
  it("被排除的系统项：确认屏必须说出来，且不许再说成「点开头的都不拷」", async () => {
    const user = userEvent.setup();
    const planSpy = vi.spyOn(api, "planSourceSelection").mockResolvedValue({
      fileCount: 2,
      totalBytes: 2048,
      renamedFiles: [],
      hiddenSkipped: 3,
      hiddenSamples: [".Trashes", ".Spotlight-V100", "DCIM/.DS_Store"],
      planDigest: "d1",
    });

    render(<App preloaded={preloaded} />);
    await openPicker(user);
    await user.click(folderCheckbox("DCIM/100MSDCF"));
    await reachConfirm(user);

    const notice = await screen.findByTestId("confirm-hidden-skipped");
    expect(notice.textContent).toContain("3 个系统项");
    expect(notice.textContent).toContain(".Trashes");
    // ★ 判据:不许把「以点开头」说成排除条件,也不许再叫人给素材改名
    expect(notice.textContent).not.toMatch(/「\.」开头的条目不在/);
    expect(notice.textContent).not.toContain("改名后另行拷贝");
    // 且要正面告诉用户点开头的素材现在会照拷,免得他白忙
    expect(notice.textContent).toContain("照常拷贝");
    planSpy.mockRestore();
  }, 20000);

  it("改名条数多时折叠，但「共几条」始终可见", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);
    await openPicker(user);

    await user.click(folderCheckbox("DCIM/100MSDCF"));
    await user.click(folderCheckbox("DCIM/101MSDCF"));
    await user.click(folderCheckbox("PRIVATE/M4ROOT/CLIP"));
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
    await user.click(folderCheckbox("DCIM/100MSDCF"));
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
      hiddenSkipped: 0,
      hiddenSamples: [],
      planDigest: "digest-retry",
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
    await user.click(folderCheckbox("DCIM/100MSDCF"));
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
    await user.click(folderCheckbox("DCIM"));

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

/* ------------------------------------------------------------------ *
 * ★ 竞态：后发先至的响应绝不许污染当前状态
 *
 * 这一组全部用**手动 resolve 的 promise** 造时序，不用 setTimeout 碰运气：
 * 竞态测试如果靠时间赌，改天在别的机器上就变成一条随机绿灯。
 * ------------------------------------------------------------------ */

/** 手动控制 resolve/reject 的 promise */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function plan(over: Partial<SourcePlan> = {}): SourcePlan {
  return {
    fileCount: 3,
    totalBytes: 3072,
    renamedFiles: [],
    hiddenSkipped: 0,
    hiddenSamples: [],
    planDigest: "digest-default",
    ...over,
  };
}

describe("★ E1 双确认屏绑定不可变草稿", () => {
  /**
   * 症状（评审实测）：确认方案 A → 核算期间「返回修改」→ 改成方案 B → 再进确认，
   * A 那两个还在飞的 preview/plan 后落地并**覆盖** B 的。屏上是 A 的目标夹、
   * A 的规模、A 的改名清单，而「确认开始」提交的是当前表单——实际跑的是 B。
   *
   * 这直接推翻本次改动自己的承诺：「加前缀 = 系统替用户改了文件名，必须在双确认屏
   * 明示」。展示的清单不是将要执行的清单，明示就是假的。
   */
  it("★ 旧草稿的 preview/plan 后落地也污染不了新草稿，提交的就是屏上那一份", async () => {
    const user = userEvent.setup();
    const heldPlan = deferred<SourcePlan>();
    const heldPreview = deferred<CopyTaskPreview>();

    const planSpy = vi
      .spyOn(api, "planSourceSelection")
      .mockImplementation((_volumeId, folders) =>
        folders.includes("DCIM/100MSDCF")
          ? heldPlan.promise
          : Promise.resolve(
              plan({
                fileCount: 3,
                totalBytes: 3072,
                planDigest: "digest-B",
                renamedFiles: [
                  { sourceRel: "DCIM/101MSDCF/C0001.MP4", targetRel: "B-ONLY.MP4" },
                ],
              }),
            ),
      );
    const previewSpy = vi
      .spyOn(api, "previewCopyTask")
      .mockImplementationOnce(() => heldPreview.promise)
      .mockImplementation(async () => ({
        targetFolder: "B-TARGET",
        destinations: [
          { id: "d1", kind: "nas", path: "/nas/B", state: "idle", writtenBytes: 0 },
        ],
      }));
    const startSpy = vi.spyOn(api, "startCopyTask");

    render(<App preloaded={preloaded} />);
    await user.click(screen.getByRole("radio", { name: "选择源卷 NIKON_Z9" }));
    await user.click(screen.getByTestId("copy-folder-toggle"));
    await screen.findByTestId("copy-folder-list");

    // ---- 方案 A：勾 100MSDCF，进确认屏（preview/plan 都卡住不返回）----
    await user.click(folderCheckbox("DCIM/100MSDCF"));
    await addTag(user, "下午径赛");
    await fillDestinations(user);
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));
    expect(screen.getByTestId("confirm-plan-loading")).toBeDefined();

    // ---- 返回修改，改成方案 B：换成 101MSDCF ----
    await user.click(screen.getByRole("button", { name: "返回修改" }));
    await user.click(folderCheckbox("DCIM/100MSDCF"));
    await user.click(folderCheckbox("DCIM/101MSDCF"));
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));
    await waitFor(() =>
      expect(screen.getByTestId("confirm-plan-scale").textContent).toContain(
        "3 个文件",
      ),
    );
    expect(screen.getByTestId("confirm-target-folder").textContent).toBe("B-TARGET");

    // ---- 现在才让方案 A 的两个响应落地（后发先至）----
    await act(async () => {
      heldPlan.resolve(
        plan({
          fileCount: 999,
          totalBytes: 999_999,
          planDigest: "digest-A",
          renamedFiles: [
            { sourceRel: "DCIM/100MSDCF/C0001.MP4", targetRel: "A-ONLY.MP4" },
          ],
        }),
      );
      heldPreview.resolve({
        targetFolder: "A-TARGET",
        destinations: [
          { id: "dA", kind: "nas", path: "/nas/A", state: "idle", writtenBytes: 0 },
        ],
      });
      await Promise.resolve();
    });

    // 屏上必须仍然是 B 的规模、B 的目标夹、B 的改名清单
    expect(screen.getByTestId("confirm-plan-scale").textContent).toContain("3 个文件");
    expect(screen.getByTestId("confirm-plan-scale").textContent).not.toContain("999");
    expect(screen.getByTestId("confirm-target-folder").textContent).toBe("B-TARGET");
    expect(screen.getByTestId("confirm-renames").textContent).toContain("B-ONLY.MP4");
    expect(screen.getByTestId("confirm-renames").textContent).not.toContain("A-ONLY");
    expect(screen.getByTestId("confirm-source-scope").textContent).toContain(
      "DCIM/101MSDCF",
    );
    expect(screen.getByTestId("confirm-source-scope").textContent).not.toContain(
      "100MSDCF",
    );

    // 提交的必须与屏上那一份逐字对应：范围是 B、令牌是 B 的
    await user.click(screen.getByTestId("copy-confirm-start"));
    await waitFor(() => expect(startSpy).toHaveBeenCalled());
    expect(startSpy.mock.calls[0][0].sourceFolders).toEqual(["DCIM/101MSDCF"]);
    expect(startSpy.mock.calls[0][0].planDigest).toBe("digest-B");

    planSpy.mockRestore();
    previewSpy.mockRestore();
    startSpy.mockRestore();
  }, 25000);

  it("「返回修改」把旧草稿作废：旧 plan 落地后不会让确认屏自己冒出来", async () => {
    const user = userEvent.setup();
    const held = deferred<SourcePlan>();
    const planSpy = vi
      .spyOn(api, "planSourceSelection")
      .mockImplementation(() => held.promise);

    render(<App preloaded={preloaded} />);
    await user.click(screen.getByRole("radio", { name: "选择源卷 NIKON_Z9" }));
    await addTag(user, "下午径赛");
    await fillDestinations(user);
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));
    await user.click(screen.getByRole("button", { name: "返回修改" }));

    await act(async () => {
      held.resolve(plan({ fileCount: 42 }));
      await Promise.resolve();
    });

    expect(screen.queryByText("确认拷卡信息")).toBeNull();
    expect(screen.queryByTestId("confirm-plan-scale")).toBeNull();
    planSpy.mockRestore();
  }, 20000);
});

/**
 * ★ 确认页实例 id（`confirmInstanceId`，契约 2026-08-28）。
 *
 * 后端只留最近 16 份计划快照，按这个 id **替换**同一屏确认页的旧计划。
 * 快照是 `PLAN_CHANGED` 报文说得出「多了哪几个文件」「勾选差在哪」的唯一来源，
 * 被挤掉就只剩泛化原因——而「说错原因比不说更糟」这条是后端整轮工作的前提。
 *
 * 所以这一组盯两件事：**每次核算都带上它**，且它的生命周期跟着「用户还站不站
 * 在同一屏确认页上」走，而不是跟着核算次数走。
 */
describe("★ 确认页实例 id（confirmInstanceId）", () => {
  async function enterConfirm(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("radio", { name: "选择源卷 NIKON_Z9" }));
    await addTag(user, "下午径赛");
    await fillDestinations(user);
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));
    await waitFor(() =>
      expect(screen.getByTestId("confirm-target-folder").textContent).not.toBe(
        "解析中…",
      ),
    );
  }

  /** 每次 planSourceSelection 调用报上去的那个 id（第三个实参） */
  function reportedIds(spy: { mock: { calls: readonly unknown[][] } }) {
    return spy.mock.calls.map((call) => call[2] as string | undefined);
  }

  it("★ 每次核算都带上一个非空 id，且它不混进 startCopyTask 的提交体", async () => {
    const user = userEvent.setup();
    const planSpy = vi.spyOn(api, "planSourceSelection");
    const startSpy = vi.spyOn(api, "startCopyTask");

    render(<App preloaded={preloaded} />);
    await enterConfirm(user);
    await confirmReady();

    expect(planSpy).toHaveBeenCalled();
    for (const id of reportedIds(planSpy)) {
      // 不传也能用,但后端会退化成「按时间淘汰」,PLAN_CHANGED 只剩泛化原因
      expect(typeof id).toBe("string");
      expect(id).toBeTruthy();
    }

    await user.click(screen.getByTestId("copy-confirm-start"));
    await waitFor(() => expect(startSpy).toHaveBeenCalled());
    // 它只是后端计划快照的一把钥匙:不参与令牌、不进 manifest、不进提交体
    expect(startSpy.mock.calls[0][0]).not.toHaveProperty("confirmInstanceId");
  }, 20000);

  it("★ 屏内「重试核算」复用同一个 id：同一屏确认页不该占掉第二个快照槽", async () => {
    const user = userEvent.setup();
    const planSpy = vi
      .spyOn(api, "planSourceSelection")
      .mockRejectedValueOnce(new Error("卡上目录读不动"));

    render(<App preloaded={preloaded} />);
    await enterConfirm(user);
    await screen.findByTestId("copy-plan-error");

    await user.click(screen.getByTestId("copy-plan-retry"));
    await waitFor(() => expect(planSpy.mock.calls.length).toBeGreaterThanOrEqual(2));

    const ids = reportedIds(planSpy);
    expect(ids[0]).toBeTruthy();
    expect(new Set(ids).size, `多占了槽：${JSON.stringify(ids)}`).toBe(1);
  }, 20000);

  /**
   * ★ 生命周期判据：`PLAN_CHANGED` 之后 requestId 会换发（作废在飞的旧响应），
   * 但用户**根本没离开这一屏确认页**，instance id 必须原样保留。
   *
   * 换新 id 的后果是把一份刚被判定不成立、已经死掉的快照留在 16 格缓存里等 TTL，
   * 还可能顺手挤掉别的确认屏正在用的活快照——让**那一屏**将来的 PLAN_CHANGED
   * 只说得出泛化原因。这正是这个参数存在的理由。
   */
  it("★ PLAN_CHANGED 重新核算时 id 不变：用户还站在同一屏确认页上", async () => {
    const user = userEvent.setup();
    const planSpy = vi.spyOn(api, "planSourceSelection");
    const startSpy = vi
      .spyOn(api, "startCopyTask")
      .mockRejectedValue(
        new Error("PLAN_CHANGED: 卡上的内容在你确认之后发生了变化,请重新核对"),
      );

    render(<App preloaded={preloaded} />);
    await enterConfirm(user);
    await confirmReady();
    const before = planSpy.mock.calls.length;

    await user.click(screen.getByTestId("copy-confirm-start"));
    await screen.findByTestId("copy-plan-changed");
    // 退回确认屏必然要重新核算一次,让用户看到的是新真值
    await waitFor(() => expect(planSpy.mock.calls.length).toBeGreaterThan(before));

    const ids = reportedIds(planSpy);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    // 「都没传」也会让下面那条 Set 断言过关,所以先钉死「确实报了 id」
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size, `换了 id：${JSON.stringify(ids)}`).toBe(1);
    expect(startSpy).toHaveBeenCalledTimes(1);
  }, 20000);

  it("★ 「返回修改」再进来是另一屏确认页：必须换一个 id", async () => {
    const user = userEvent.setup();
    const planSpy = vi.spyOn(api, "planSourceSelection");

    render(<App preloaded={preloaded} />);
    await enterConfirm(user);
    await confirmReady();

    await user.click(screen.getByRole("button", { name: "返回修改" }));
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));
    await waitFor(() => expect(planSpy.mock.calls.length).toBeGreaterThanOrEqual(2));

    const ids = reportedIds(planSpy);
    expect(ids[0]).toBeTruthy();
    expect(ids[ids.length - 1]).toBeTruthy();
    expect(ids[ids.length - 1]).not.toBe(ids[0]);
  }, 20000);

  it("mock 守同一条契约：id 不参与 planDigest，换一屏不会凭空造出 PLAN_CHANGED", async () => {
    // 一旦让 id 参与令牌,同一张卡、同一份勾选就会因为换了个确认屏而算出不同的
    // 令牌,开拷时被判成「计划变了」——那是无中生有的 PLAN_CHANGED
    const folders = ["DCIM/100MSDCF"];
    const a = await api.planSourceSelection("vol-untitled-2", folders, "confirm-A");
    const b = await api.planSourceSelection("vol-untitled-2", folders, "confirm-B");
    const none = await api.planSourceSelection("vol-untitled-2", folders);

    expect(a.planDigest).toBeTruthy();
    expect(b.planDigest).toBe(a.planDigest);
    expect(none.planDigest).toBe(a.planDigest);
    expect(b.fileCount).toBe(a.fileCount);
  });
});

describe("★ E2 文件夹扫描结果按卷归属", () => {
  /** 两张卡给两份完全不同的目录清单，谁的结果串台一眼可辨 */
  const Z9_FOLDERS = [
    { relPath: "Z9-ONLY", fileCount: 2, totalBytes: 2048, hasSubfolders: false },
  ];
  const A7_FOLDERS = [
    { relPath: "A7-ONLY", fileCount: 5, totalBytes: 5120, hasSubfolders: false },
  ];

  it("★ 扫 A 的过程中切到 B：A 的结果落地也不会显示在 B 底下，且要出声", async () => {
    const user = userEvent.setup();
    const heldZ9 = deferred<typeof Z9_FOLDERS>();
    const listSpy = vi
      .spyOn(api, "listSourceFolders")
      .mockImplementation((volumeId) =>
        volumeId === "vol-untitled-2"
          ? heldZ9.promise
          : Promise.resolve(A7_FOLDERS),
      );

    render(<App preloaded={preloaded} />);
    await user.click(screen.getByRole("radio", { name: "选择源卷 NIKON_Z9" }));
    await user.click(screen.getByTestId("copy-folder-toggle"));
    expect(screen.getByText("正在读取卡内文件夹…")).toBeDefined();

    // 扫描还在飞就换了卡
    await user.click(screen.getByRole("radio", { name: "选择源卷 SONY_A7M4" }));
    await act(async () => {
      heldZ9.resolve(Z9_FOLDERS);
      await Promise.resolve();
    });

    // Z9 的目录绝不许出现在 A7M4 底下
    expect(screen.queryByText("Z9-ONLY")).toBeNull();
    // 而且不许静默：用户当时正等着这份清单
    await user.click(screen.getByTestId("notice-bell"));
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("notice-item")
          .some((n) => n.getAttribute("data-code") === "source-folders-stale"),
      ).toBe(true),
    );

    listSpy.mockRestore();
  }, 20000);

  it("★ 旧卷的结果不许冒充「已经扫过了」——重开选择器必须重新扫", async () => {
    const user = userEvent.setup();
    const heldZ9 = deferred<typeof Z9_FOLDERS>();
    const listSpy = vi
      .spyOn(api, "listSourceFolders")
      .mockImplementation((volumeId) =>
        volumeId === "vol-untitled-2"
          ? heldZ9.promise
          : Promise.resolve(A7_FOLDERS),
      );

    render(<App preloaded={preloaded} />);
    await user.click(screen.getByRole("radio", { name: "选择源卷 NIKON_Z9" }));
    await user.click(screen.getByTestId("copy-folder-toggle"));
    await user.click(screen.getByRole("radio", { name: "选择源卷 SONY_A7M4" }));
    await act(async () => {
      heldZ9.resolve(Z9_FOLDERS);
      await Promise.resolve();
    });

    // 换卷会把选择器收起来；重新展开时必须重新扫描——
    // 此前会因为 folders !== null（那是 Z9 的结果）而跳过扫描，
    // 于是用户在 A7M4 底下看到并勾选的是上一张卡的目录
    const callsBefore = listSpy.mock.calls.length;
    await user.click(screen.getByTestId("copy-folder-toggle"));
    await screen.findByText("A7-ONLY");
    expect(listSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(listSpy.mock.calls[listSpy.mock.calls.length - 1][0]).toBe("vol-untitled-1");
    expect(screen.queryByText("Z9-ONLY")).toBeNull();

    listSpy.mockRestore();
  }, 20000);

  it("旧卷的扫描失败不冒充当前卡的失败，但仍然出声", async () => {
    const user = userEvent.setup();
    const heldZ9 = deferred<typeof Z9_FOLDERS>();
    const listSpy = vi
      .spyOn(api, "listSourceFolders")
      .mockImplementation((volumeId) =>
        volumeId === "vol-untitled-2"
          ? heldZ9.promise
          : Promise.resolve(A7_FOLDERS),
      );

    render(<App preloaded={preloaded} />);
    await user.click(screen.getByRole("radio", { name: "选择源卷 NIKON_Z9" }));
    await user.click(screen.getByTestId("copy-folder-toggle"));
    await user.click(screen.getByRole("radio", { name: "选择源卷 SONY_A7M4" }));
    await act(async () => {
      heldZ9.reject(new Error("卡被拔了"));
      await Promise.resolve();
    });

    // 当前卡没有就地报错（那句话说的是「这张卡」，而失败的是上一张）
    expect(screen.queryByTestId("copy-folder-error")).toBeNull();
    await user.click(screen.getByTestId("notice-bell"));
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("notice-item")
          .some((n) => n.textContent?.includes("卡被拔了")),
      ).toBe(true),
    );

    listSpy.mockRestore();
  }, 20000);
});

describe("★ E3 文件明细的请求版本号", () => {
  /** 两个任务，各自一套明细，串台一眼可辨 */
  function twoTasks() {
    const a = { ...mockCopyTasks[0], id: "task-A", volumeName: "CARD-A", files: [] };
    const b = { ...mockCopyTasks[0], id: "task-B", volumeName: "CARD-B", files: [] };
    return { a, b };
  }
  function fileOf(taskId: string) {
    return {
      items: [
        {
          id: `${taskId}-f1`,
          path: `DCIM/${taskId}.MP4`,
          name: `${taskId}.MP4`,
          sizeBytes: 1024,
          status: "verified" as const,
          hash: `hash-${taskId}`,
        },
      ],
      total: 1,
    };
  }

  it("★ 切任务后，上一张卡的节流刷新落地也不会把它的文件与哈希填进这张卡", async () => {
    const user = userEvent.setup();
    const { a, b } = twoTasks();
    const heldRefresh = deferred<ReturnType<typeof fileOf>>();
    let aCalls = 0;

    const listSpy = vi
      .spyOn(api, "listCopyFiles")
      .mockImplementation(async (taskId) => {
        if (taskId !== "task-A") return fileOf("task-B");
        aCalls += 1;
        // 第一次是切进来时的首屏加载，第二次起才是进度事件驱动的节流刷新
        return aCalls === 1 ? fileOf("task-A") : heldRefresh.promise;
      });

    let emit: ((event: CopyProgressEvent) => void) | null = null;
    const subSpy = vi
      .spyOn(api, "subscribeCopyProgress")
      .mockImplementation((onEvent) => {
        emit = onEvent;
        return () => {};
      });

    render(
      <App preloaded={{ ...preloaded, tasks: [a, b], selectedTaskId: a.id }} />,
    );
    await screen.findByText("task-A.MP4");

    // 一条进度事件 → 节流窗口过后触发 refreshLoadedFiles（这次被我们卡住）
    act(() => {
      emit?.({
        taskId: "task-A",
        revision: 1,
        occurredAt: new Date().toISOString(),
        copiedBytes: 1000,
        speedBytesPerSec: 1000,
        state: "running",
        changedFiles: [],
        changedDestinations: [],
      });
    });
    await waitFor(() => expect(aCalls).toBeGreaterThan(1), { timeout: 5000 });

    // 刷新还在飞就切到另一个任务
    await user.click(screen.getByRole("button", { name: /CARD-B/ }));
    await screen.findByText("task-B.MP4");

    await act(async () => {
      heldRefresh.resolve(fileOf("task-A"));
      await Promise.resolve();
    });

    // B 的明细必须原封不动，A 的文件与哈希一个都不许出现
    expect(screen.getByText("task-B.MP4")).toBeDefined();
    expect(screen.queryByText("task-A.MP4")).toBeNull();
    expect(screen.queryByText("hash-task-A")).toBeNull();

    listSpy.mockRestore();
    subSpy.mockRestore();
  }, 25000);

  it("★「加载更多」的响应也认版本号：切任务后不会把上一张卡的文件追加进来", async () => {
    const user = userEvent.setup();
    const { a, b } = twoTasks();
    const heldMore = deferred<{ items: never[]; total: number }>();

    const listSpy = vi
      .spyOn(api, "listCopyFiles")
      .mockImplementation(async (taskId, offset = 0) => {
        if (taskId !== "task-A") return { ...fileOf("task-B"), total: 1 };
        if (offset === 0) return { ...fileOf("task-A"), total: 2 };
        return heldMore.promise as never;
      });

    render(
      <App
        preloaded={{
          ...preloaded,
          tasks: [{ ...a, fileCount: 2 }, b],
          selectedTaskId: a.id,
        }}
      />,
    );
    await screen.findByText("task-A.MP4");

    await user.click(screen.getByTestId("copy-load-more-files"));
    await user.click(screen.getByRole("button", { name: /CARD-B/ }));
    await screen.findByText("task-B.MP4");

    await act(async () => {
      heldMore.resolve({
        items: [
          {
            id: "task-A-f2",
            path: "DCIM/A-LATE.MP4",
            name: "A-LATE.MP4",
            sizeBytes: 1,
            status: "verified",
            hash: "h",
          },
        ] as never,
        total: 2,
      });
      await Promise.resolve();
    });

    expect(screen.queryByText("A-LATE.MP4")).toBeNull();
    listSpy.mockRestore();
  }, 25000);
});

/* ------------------------------------------------------------------ *
 * ★ 部分拷贝的文案口径（hero 大字 / 完成屏 / 全链路）
 * ------------------------------------------------------------------ */

describe("★ E4 hero 大字不许替部分拷贝说「本卡校验 100% 通过」", () => {
  function doneTask(sourceFolders?: string[]) {
    return {
      ...mockCopyTasks[1],
      files: [],
      ...(sourceFolders ? { sourceFolders } : {}),
    };
  }

  it("★ 部分拷贝时那行字要写明范围并点出「请勿格式化」", async () => {
    const t = doneTask(["DCIM/100MSDCF", "PRIVATE/M4ROOT/CLIP"]);
    render(<App preloaded={{ ...preloaded, tasks: [t], selectedTaskId: t.id }} />);

    const caption = await screen.findByTestId("copy-flow-caption");
    // 症状：这行字主语是整张卡，写「{卷名} 校验 100% 通过。」等于替一张
    // 还留着未备份素材的卡背书；prefers-reduced-motion 下它还是唯一的状态来源
    expect(caption.textContent).toContain("2 个文件夹");
    expect(caption.textContent).toContain("DCIM/100MSDCF");
    expect(caption.textContent).toContain("请勿格式化");
    expect(caption.textContent).not.toBe(`${t.volumeName} 校验 100% 通过。`);
  });

  it("整卷完成仍是原来那句话，不被误伤", async () => {
    const t = doneTask();
    render(<App preloaded={{ ...preloaded, tasks: [t], selectedTaskId: t.id }} />);

    const caption = await screen.findByTestId("copy-flow-caption");
    expect(caption.textContent).toBe(`${t.volumeName} 校验 100% 通过。`);
  });
});

describe("★ E6 完成屏的范围文案：卷根不许渲染成空白", () => {
  it("★ 只勾了卷根时写成「（卷根）」，不是「本次只拷了：。」", async () => {
    const t = { ...mockCopyTasks[1], files: [], sourceFolders: [""] };
    render(<App preloaded={{ ...preloaded, tasks: [t], selectedTaskId: t.id }} />);

    const notice = await screen.findByTestId("copy-partial-done");
    expect(notice.textContent).toContain("（卷根）");
    expect(notice.textContent).not.toContain("本次只拷了：。");
    expect(notice.textContent).toContain("请勿格式化");
    // hero 大字同一口径
    expect(screen.getByTestId("copy-flow-caption").textContent).toContain("（卷根）");
  });

  it("卷根与真实路径混排时两者都看得见", async () => {
    const t = {
      ...mockCopyTasks[1],
      files: [],
      sourceFolders: ["", "DCIM/100MSDCF"],
    };
    render(<App preloaded={{ ...preloaded, tasks: [t], selectedTaskId: t.id }} />);

    const notice = await screen.findByTestId("copy-partial-done");
    expect(notice.textContent).toContain("（卷根）、DCIM/100MSDCF");
    expect(notice.textContent).toContain("所选 2 个文件夹");
  });
});

describe("★ E5 走 mock 的完整链路：勾文件夹 → startCopy → done → 看提示", () => {
  /**
   * 此前所有「部分拷贝不许说可格式化」的用例都是**手工构造 task 对象**塞进
   * preloaded 的，绕过了 mock 的 startCopyTask，只测了后半段。于是 mock 把
   * `sourceFolders` 丢掉这件事没有任何测试能发现——而浏览器预览、截图脚本、
   * 走 mock 的端到端测试全都因此走整卷分支、说「本卡可格式化」。
   */
  it("★ 勾了文件夹发起的任务跑完后，说的是「请勿格式化」", async () => {
    const user = userEvent.setup();
    let emit: ((event: CopyProgressEvent) => void) | null = null;
    const subSpy = vi
      .spyOn(api, "subscribeCopyProgress")
      .mockImplementation((onEvent) => {
        emit = onEvent;
        return () => {};
      });
    // 明细接口对新任务返回空表即可：这条用例盯的是范围口径，不是文件列表
    const listSpy = vi
      .spyOn(api, "listCopyFiles")
      .mockResolvedValue({ items: [], total: 0 });
    // 透传的 spy：**真的**走 mock 的 startCopyTask，只是顺手记下任务 id
    const realStart = api.startCopyTask;
    let startedId = "";
    const startSpy = vi
      .spyOn(api, "startCopyTask")
      .mockImplementation(async (input) => {
        const started = await realStart(input);
        startedId = started.id;
        return started;
      });

    render(<App preloaded={{ ...preloaded, tasks: [], selectedTaskId: null }} />);
    await user.click(screen.getByRole("radio", { name: "选择源卷 NIKON_Z9" }));
    await user.click(screen.getByTestId("copy-folder-toggle"));
    await screen.findByTestId("copy-folder-list");
    await user.click(folderCheckbox("DCIM/100MSDCF"));
    await addTag(user, "下午径赛");
    await fillDestinations(user);
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));
    await waitFor(() =>
      expect(screen.getByTestId("confirm-target-folder").textContent).not.toBe(
        "解析中…",
      ),
    );
    await user.click(screen.getByTestId("copy-confirm-start"));

    // 任务由 mock 的 startCopyTask 真造出来：它必须把 sourceFolders 带上，
    // 否则下面这条终态提示会变成绿色的「本卡可格式化」
    await waitFor(() => expect(startedId).not.toBe(""));

    act(() => {
      emit?.({
        taskId: startedId,
        revision: 1,
        occurredAt: new Date().toISOString(),
        copiedBytes: 100,
        speedBytesPerSec: 0,
        state: "done",
        changedFiles: [],
        changedDestinations: [],
      });
    });

    const notice = await screen.findByTestId("copy-partial-done");
    expect(notice.textContent).toContain("DCIM/100MSDCF");
    expect(notice.textContent).toContain("请勿格式化");
    expect(screen.queryByText(/本卡可格式化/)).toBeNull();

    // 全局广播（用户多半不在这一屏）同一口径
    await user.click(screen.getByTestId("notice-bell"));
    await waitFor(() => {
      const done = screen
        .getAllByTestId("notice-item")
        .find((n) => n.getAttribute("data-code") === "copy-task-done");
      expect(done?.textContent).toContain("请勿格式化");
    });

    subSpy.mockRestore();
    listSpy.mockRestore();
    startSpy.mockRestore();
  }, 25000);
});

describe("★ E8 拷卡控制不许「按了没反应」", () => {
  it("暂停被 IPC 拒时要出声，不静默", async () => {
    const user = userEvent.setup();
    const pauseSpy = vi
      .spyOn(api, "pauseCopyTask")
      .mockRejectedValue(new Error("引擎没响应"));

    render(<App preloaded={preloaded} />);
    await screen.findByText("C0001.MP4");
    await user.click(screen.getByTestId("copy-pause"));

    await user.click(screen.getByTestId("notice-bell"));
    await waitFor(() => {
      const item = screen
        .getAllByTestId("notice-item")
        .find((n) => n.getAttribute("data-code") === "copy-pause-failed");
      expect(item?.textContent).toContain("引擎没响应");
    });
    pauseSpy.mockRestore();
  }, 20000);

  it("继续被拒同样出声", async () => {
    const user = userEvent.setup();
    const paused = { ...mockCopyTasks[0], state: "paused" as const, files: [] };
    const resumeSpy = vi
      .spyOn(api, "resumeCopyTask")
      .mockRejectedValue(new Error("NAS 还没回来"));

    render(
      <App preloaded={{ ...preloaded, tasks: [paused], selectedTaskId: paused.id }} />,
    );
    await user.click(await screen.findByTestId("copy-resume"));

    await user.click(screen.getByTestId("notice-bell"));
    await waitFor(() => {
      const item = screen
        .getAllByTestId("notice-item")
        .find((n) => n.getAttribute("data-code") === "copy-pause-failed");
      expect(item?.textContent).toContain("NAS 还没回来");
    });
    resumeSpy.mockRestore();
  }, 20000);

  it("单文件重试被拒要点名是哪个文件，并说明它仍是失败状态", async () => {
    const user = userEvent.setup();
    const retrySpy = vi
      .spyOn(api, "retryCopyFile")
      .mockRejectedValue(new Error("目标盘只读"));

    render(<App preloaded={preloaded} />);
    await screen.findByText("C0007.MP4");
    await user.click(screen.getByRole("button", { name: "重试 C0007.MP4" }));

    await user.click(screen.getByTestId("notice-bell"));
    await waitFor(() => {
      const item = screen
        .getAllByTestId("notice-item")
        .find((n) => n.getAttribute("data-code") === "copy-file-retry-failed");
      expect(item?.textContent).toContain("C0007.MP4");
      expect(item?.textContent).toContain("目标盘只读");
    });
    retrySpy.mockRestore();
  }, 20000);
});

describe("★ E9 PLAN_CHANGED 与 confirmDraft 自洽", () => {
  /**
   * 后端拒了这次提交（卡上内容在确认之后变了）。前端重新核算之后，
   * **展示的清单必须与新的 planDigest 属于同一份**，而且必须让用户重新确认。
   * 悄悄把新清单塞进旧的确认状态里，等于替他批准了一份他没看过的清单。
   */
  it("★ 重新核算后展示的是新清单，再次确认提交的是新 digest（不是旧的）", async () => {
    const user = userEvent.setup();
    const planSpy = vi
      .spyOn(api, "planSourceSelection")
      .mockResolvedValueOnce(plan({ fileCount: 5, planDigest: "digest-1" }))
      .mockResolvedValue(plan({ fileCount: 7, planDigest: "digest-2" }));
    const startSpy = vi
      .spyOn(api, "startCopyTask")
      .mockRejectedValueOnce(new Error("PLAN_CHANGED: 卡上的内容变了"))
      .mockImplementation(async () => ({ ...mockCopyTasks[0], id: "task-new" }));

    render(<App preloaded={preloaded} />);
    await user.click(screen.getByRole("radio", { name: "选择源卷 NIKON_Z9" }));
    await user.click(screen.getByTestId("copy-folder-toggle"));
    await screen.findByTestId("copy-folder-list");
    await user.click(folderCheckbox("DCIM/100MSDCF"));
    await addTag(user, "下午径赛");
    await fillDestinations(user);
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));
    await waitFor(() =>
      expect(screen.getByTestId("confirm-plan-scale").textContent).toContain(
        "5 个文件",
      ),
    );
    await confirmReady();

    await user.click(screen.getByTestId("copy-confirm-start"));

    // 留在确认屏、显式说明、重新核算；绝不自动重试
    expect(await screen.findByTestId("copy-plan-changed")).toBeDefined();
    expect(startSpy).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId("confirm-plan-scale").textContent).toContain(
        "7 个文件",
      ),
    );
    // 落盘预览也必须跟着这份新草稿重新解析，否则「确认开始」永远是灰的
    await waitFor(() =>
      expect(
        (screen.getByTestId("copy-confirm-start") as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    // 用户重新过目后再确认：提交的令牌必须是**屏上这份**清单的
    await user.click(screen.getByTestId("copy-confirm-start"));
    await waitFor(() => expect(startSpy).toHaveBeenCalledTimes(2));
    expect(startSpy.mock.calls[1][0].planDigest).toBe("digest-2");
    expect(startSpy.mock.calls[0][0].planDigest).toBe("digest-1");
    // 范围本身没变（变的是卡上的内容），仍然是用户当初勾的那一个
    expect(startSpy.mock.calls[1][0].sourceFolders).toEqual(["DCIM/100MSDCF"]);

    planSpy.mockRestore();
    startSpy.mockRestore();
  }, 25000);

  it("★ PLAN_CHANGED 之后旧那次的 plan 再落地也污染不了新清单", async () => {
    const user = userEvent.setup();
    const held = deferred<SourcePlan>();
    let planCalls = 0;
    const planSpy = vi.spyOn(api, "planSourceSelection").mockImplementation(() => {
      planCalls += 1;
      if (planCalls === 1) return Promise.resolve(plan({ fileCount: 5, planDigest: "d1" }));
      if (planCalls === 2) return held.promise; // 重算这次卡住
      return Promise.resolve(plan({ fileCount: 9, planDigest: "d3" }));
    });
    const startSpy = vi
      .spyOn(api, "startCopyTask")
      .mockRejectedValue(new Error("PLAN_CHANGED: 卡上的内容变了"));

    render(<App preloaded={preloaded} />);
    await user.click(screen.getByRole("radio", { name: "选择源卷 NIKON_Z9" }));
    await user.click(screen.getByTestId("copy-folder-toggle"));
    await screen.findByTestId("copy-folder-list");
    await user.click(folderCheckbox("DCIM/100MSDCF"));
    await addTag(user, "下午径赛");
    await fillDestinations(user);
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));
    await waitFor(() =>
      expect(screen.getByTestId("confirm-plan-scale").textContent).toContain(
        "5 个文件",
      ),
    );
    await confirmReady();
    await user.click(screen.getByTestId("copy-confirm-start"));
    await screen.findByTestId("copy-plan-changed");

    // 重算还在飞，用户就退回去了：这份草稿作废
    await user.click(screen.getByRole("button", { name: "返回修改" }));
    await act(async () => {
      held.resolve(plan({ fileCount: 77, planDigest: "d2" }));
      await Promise.resolve();
    });
    expect(screen.queryByText("确认拷卡信息")).toBeNull();

    planSpy.mockRestore();
    startSpy.mockRestore();
  }, 25000);
});

describe("★ E10 文件夹行的读屏名不许吞掉可见 meta", () => {
  it("★ 「含子目录（另有条目）」必须进读屏名——它是本功能最容易误解的一句", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);
    await user.click(screen.getByRole("radio", { name: "选择源卷 NIKON_Z9" }));
    await user.click(screen.getByTestId("copy-folder-toggle"));
    await screen.findByTestId("copy-folder-list");

    // DCIM 自身没有直接子文件，素材都在它的两个子目录里
    const dcim = folderCheckbox("DCIM");
    const label = dcim.getAttribute("aria-label") ?? "";
    expect(label).toContain("0 个文件");
    expect(label).toContain("含子目录");
    // 「子目录不递归」这条规则必须听得到，不能只有看得见的人才知道
    expect(label).toContain("另一条独立条目");

    // 没有子目录的行不许凭空多出这句话
    const clip = folderCheckbox("DCIM/100MSDCF").getAttribute("aria-label") ?? "";
    expect(clip).toContain("3 个文件");
    expect(clip).not.toContain("含子目录");
  }, 20000);
});

/* ------------------------------------------------------------------ *
 * ★ 双确认：整屏替换 → 弹窗
 *
 * 改成弹窗之后新出现的两类风险，各由下面一个 describe 钉住：
 *   ① 它必须是**真模态**——遮罩只是"看着挡住了"，键盘照样能走到背后去；
 *   ② 弹窗更窄，「没滚到改名清单那一段就按了确认」变成默认路径。
 * ------------------------------------------------------------------ */

/** 选卷 → 填齐必填 → 开始拷卡 → 拿到弹窗节点 */
async function openConfirmDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("radio", { name: "选择源卷 NIKON_Z9" }));
  await addTag(user, "下午径赛");
  await fillDestinations(user);
  await user.click(screen.getByTestId("copy-start"));
  return await screen.findByTestId("copy-confirm-dialog");
}

describe("★ 双确认弹窗是真模态（焦点圈定 / Esc / 背景锁定）", () => {
  it("开屏焦点进弹窗本体，Tab 圈在里面出不去", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);
    const dialog = await openConfirmDialog(user);
    await confirmReady();

    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // 读屏开屏第一句就是这个标题，指到不存在的 id 等于没标
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)?.textContent).toBe("确认拷卡信息");

    // 取焦落在弹窗**本体**：开屏就把焦点摆在「确认开始」上等于给回车留口子
    expect(document.activeElement).toBe(dialog);

    const items = focusablesIn(dialog);
    expect(items.length, "弹窗里至少有「返回修改」「确认开始」两个").toBeGreaterThanOrEqual(2);

    // 从容器往里走
    await user.tab();
    expect(document.activeElement).toBe(items[0]);

    // 末项再 Tab 必须绕回首项，而不是溜到遮罩背后的表单/侧栏上
    items[items.length - 1].focus();
    await user.tab();
    expect(document.activeElement).toBe(items[0]);

    // 反向同理
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(items[items.length - 1]);

    // 连按也出不去：被聚焦却看不见的按钮按回车照样执行
    for (let i = 0; i < items.length + 3; i += 1) {
      await user.tab();
      expect(
        dialog.contains(document.activeElement),
        `第 ${i + 1} 次 Tab 之后焦点跑到了弹窗外：${
          (document.activeElement as HTMLElement | null)?.textContent ?? "(null)"
        }`,
      ).toBe(true);
    }
  }, 20000);

  it("Esc = 返回修改：退回表单、解锁、绝不开跑，焦点还给「开始拷卡」", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "startCopyTask");
    render(<App preloaded={preloaded} />);
    await openConfirmDialog(user);
    await confirmReady();

    await user.keyboard("{Escape}");

    // ★ 先钉最要命的那条：Esc 绝不能变成「开始」。
    //   放在最前面，是为了让它失败时的报错直接点名这件事，而不是先被
    //   「弹窗还在」这种更表层的差异盖过去。
    expect(spy, "Esc 触发了拷贝任务——误触一次就是几百 GB").not.toHaveBeenCalled();
    // 「返回修改」那条路的其余后果也都要成立，Esc 不是另一种半吊子的关闭
    expect(screen.queryByTestId("copy-confirm-dialog")).toBeNull();
    expect(screen.getByLabelText("内容标签")).toBeDefined();
    expect((screen.getByTestId("copy-dests") as HTMLFieldSetElement).disabled).toBe(
      false,
    );
    expect(screen.queryByTestId("copy-dests-locked")).toBeNull();
    // 焦点还回触发者：掉到 body 上的话键盘流整条断掉，而屏上没有任何迹象
    expect(document.activeElement).toBe(screen.getByTestId("copy-start"));
    spy.mockRestore();
  }, 20000);

  it("PLAN_CHANGED 之后弹窗还开着，此时 Esc 仍是「返回修改」，不是「重试开始」", async () => {
    const user = userEvent.setup();
    const planSpy = vi
      .spyOn(api, "planSourceSelection")
      .mockResolvedValueOnce(plan({ fileCount: 5, planDigest: "digest-1" }))
      .mockResolvedValue(plan({ fileCount: 7, planDigest: "digest-2" }));
    const startSpy = vi
      .spyOn(api, "startCopyTask")
      .mockRejectedValue(new Error("PLAN_CHANGED: 卡上的内容变了"));

    render(<App preloaded={preloaded} />);
    await openConfirmDialog(user);
    await confirmReady();
    await user.click(screen.getByTestId("copy-confirm-start"));
    await screen.findByTestId("copy-plan-changed");
    // 换发新 requestId 之后弹窗仍开着，等人重新过目
    expect(screen.getByTestId("copy-confirm-dialog")).toBeDefined();
    expect(startSpy).toHaveBeenCalledTimes(1);

    await user.keyboard("{Escape}");

    expect(screen.queryByTestId("copy-confirm-dialog")).toBeNull();
    // 这一刻更不许有第二种含义：Esc 不会替用户"再试一次"
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("内容标签")).toBeDefined();

    planSpy.mockRestore();
    startSpy.mockRestore();
  }, 25000);

  it("弹窗开着时背后的目的地仍然锁死，锁定说明在弹窗之外看得见（遮罩不是锁）", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);
    const dialog = await openConfirmDialog(user);

    const dests = screen.getByTestId("copy-dests") as HTMLFieldSetElement;
    expect(dests.disabled).toBe(true);
    // 它是**背景**里的东西，不是弹窗内容：遮罩挡得住鼠标，挡不住"这是干嘛的"
    expect(dialog.contains(dests)).toBe(false);

    const note = screen.getByTestId("copy-dests-locked");
    expect(dialog.contains(note), "锁定说明必须留在被锁的那组旁边").toBe(false);
    expect(note.textContent).toContain("返回修改");

    // 触发者同样锁着：确认期间不许从背后再发起一次
    expect((screen.getByTestId("copy-start") as HTMLButtonElement).disabled).toBe(true);
  }, 20000);
});

describe("★ 弹窗里的关键数字必须不用滚就看得见", () => {
  /**
   * 判据是**结构近似**，不是几何：jsdom 没有布局引擎，量不出「在不在可视区」。
   *
   * 这里钉的是「三个数字落在那条固定底栏里、且**不在**唯一会滚的容器里」。
   * 它与 CSS 契约里 `.copy-confirm` 的三段行（auto / minmax(0,1fr) / auto）
   * 合起来才等价于几何结论：底栏是 auto 行、正文是可压缩的 1fr 行，
   * 于是无论正文多长，底栏都贴着弹窗下沿、始终在一屏之内。
   * 真几何（底栏 bottom ≤ 视口、只有正文那一个容器真能滚）由 e2e 的
   * 浮层探针在 Chrome 里量，见 e2e/specs/smoke.e2e.mjs 的「双确认弹窗」配方。
   */
  const bigPlan = (over: Partial<SourcePlan> = {}) =>
    plan({
      fileCount: 620,
      totalBytes: 1234567890,
      renamedFiles: Array.from({ length: 300 }, (_, i) => ({
        sourceRel: `DCIM/10${i % 2}MSDCF/C${String(i).padStart(4, "0")}.MP4`,
        targetRel: `10${i % 2}MSDCF_C${String(i).padStart(4, "0")}.MP4`,
      })),
      hiddenSkipped: 4,
      hiddenSamples: [".DS_Store", ".Trashes"],
      ...over,
    });

  it("300 条改名也一样：规模 / 改名条数 / 被排除条数都在固定底栏，不在滚动区里", async () => {
    const user = userEvent.setup();
    const planSpy = vi
      .spyOn(api, "planSourceSelection")
      .mockResolvedValue(bigPlan());
    render(<App preloaded={preloaded} />);
    const dialog = await openConfirmDialog(user);
    await confirmReady();

    const foot = screen.getByTestId("copy-confirm-foot");
    const scroll = screen.getByTestId("copy-confirm-scroll");

    // 底栏与滚动区是弹窗下面两个互不包含的兄弟——这是「不用滚」的结构前提
    expect(dialog.contains(foot)).toBe(true);
    expect(dialog.contains(scroll)).toBe(true);
    expect(scroll.contains(foot)).toBe(false);
    expect(foot.contains(scroll)).toBe(false);

    for (const id of [
      "confirm-plan-scale",
      "confirm-renames-figure",
      "confirm-hidden-figure",
    ]) {
      const el = screen.getByTestId(id);
      expect(foot.contains(el), `${id} 必须钉在固定底栏里`).toBe(true);
      expect(
        scroll.contains(el),
        `${id} 落进了会滚的容器：内容一长就可能没滚到就按了确认`,
      ).toBe(false);
    }

    // 数字本身要对得上，不能是三句永远为真的空话
    expect(screen.getByTestId("confirm-plan-scale").textContent).toContain("620 个文件");
    expect(screen.getByTestId("confirm-renames-figure").textContent).toContain(
      "300 个文件将被系统自动改名",
    );
    expect(screen.getByTestId("confirm-hidden-figure").textContent).toContain(
      "4 个系统项被排除",
    );

    // 「确认开始」与这三个数字同框：想按到它就必然看见它们
    expect(foot.contains(screen.getByTestId("copy-confirm-start"))).toBe(true);

    // 明细则允许藏：默认只列 5 条，其余靠展开；而且它确实待在会滚的那一边
    expect(screen.getAllByTestId("confirm-rename-item")).toHaveLength(5);
    expect(scroll.contains(screen.getByTestId("confirm-renames"))).toBe(true);
    expect(scroll.contains(screen.getByTestId("confirm-hidden-skipped"))).toBe(true);

    // 展开到全部 300 条之后，底栏那三个数字**一个都不许**掉进滚动区
    await user.click(screen.getByTestId("confirm-renames-expand"));
    expect(screen.getAllByTestId("confirm-rename-item")).toHaveLength(300);
    for (const id of [
      "confirm-plan-scale",
      "confirm-renames-figure",
      "confirm-hidden-figure",
    ]) {
      expect(foot.contains(screen.getByTestId(id)), `展开后 ${id} 掉出了底栏`).toBe(true);
    }

    planSpy.mockRestore();
  }, 30000);

  it("0 条也照样出数：数字缺席比数字为 0 更容易被读成「这项不用管」", async () => {
    const user = userEvent.setup();
    const planSpy = vi
      .spyOn(api, "planSourceSelection")
      .mockResolvedValue(plan({ fileCount: 12, renamedFiles: [], hiddenSkipped: 0 }));
    render(<App preloaded={preloaded} />);
    await openConfirmDialog(user);
    await confirmReady();

    const foot = screen.getByTestId("copy-confirm-foot");
    expect(screen.getByTestId("confirm-renames-figure").textContent).toContain(
      "没有文件被改名",
    );
    expect(screen.getByTestId("confirm-hidden-figure").textContent).toContain(
      "没有系统项被排除",
    );
    expect(foot.contains(screen.getByTestId("confirm-renames-figure"))).toBe(true);
    expect(foot.contains(screen.getByTestId("confirm-hidden-figure"))).toBe(true);

    planSpy.mockRestore();
  }, 20000);

  it("核算失败时底栏说出「算不出来」，不留一片空白冒充「没有改名」", async () => {
    const user = userEvent.setup();
    const planSpy = vi
      .spyOn(api, "planSourceSelection")
      .mockRejectedValue(new Error("卡掉线了"));
    render(<App preloaded={preloaded} />);
    await openConfirmDialog(user);

    const failed = await screen.findByTestId("confirm-figures-failed");
    expect(screen.getByTestId("copy-confirm-foot").contains(failed)).toBe(true);
    expect(screen.queryByTestId("confirm-renames-figure")).toBeNull();
    expect(
      (screen.getByTestId("copy-confirm-start") as HTMLButtonElement).disabled,
    ).toBe(true);

    planSpy.mockRestore();
  }, 20000);
});
