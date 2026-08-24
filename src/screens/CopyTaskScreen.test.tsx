import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
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
  await user.type(screen.getByLabelText("第 1 个目的地路径"), "/nas/ocard");
  await user.type(screen.getByLabelText("第 2 个目的地路径"), "/backup/ocard");
}

function targetPreview() {
  return screen.getByTestId("copy-target-preview").textContent;
}

describe("拷卡任务面板", () => {
  it("逐文件展示大小、哈希与四种状态", () => {
    render(<App preloaded={preloaded} />);

    expect(screen.getByText("C0001.MP4")).toBeDefined();
    expect(screen.getByText("8f2a1c04b7d9e355")).toBeDefined();
    expect(screen.getAllByText("已校验").length).toBeGreaterThan(0);
    expect(screen.getAllByText("已拷").length).toBeGreaterThan(0);
    expect(screen.getAllByText("待拷").length).toBeGreaterThan(0);
    expect(screen.getAllByText("失败").length).toBeGreaterThan(0);
  });

  it("失败文件带原因与重试按钮，其他文件没有", () => {
    render(<App preloaded={preloaded} />);
    expect(screen.getByText(/回读校验不一致/)).toBeDefined();
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

  it("默认不预填任何平台特有路径，缺目的地时拦下", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    expect((screen.getByLabelText("第 1 个目的地路径") as HTMLInputElement).value).toBe("");

    await user.click(screen.getByRole("radio", { name: "选择源卷 SONY_A7M4" }));
    await user.type(screen.getByLabelText("内容备注"), "上午田赛");
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));

    const alerts = screen.getAllByRole("alert").map((el) => el.textContent);
    expect(alerts).toContain("至少需要一个目的地");
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

    await user.click(screen.getByRole("button", { name: "确认开始" }));
    await waitFor(() =>
      expect(within(group).getAllByRole("button")).toHaveLength(
        mockCopyTasks.length + 1,
      ),
    );
    // 新任务置顶且带出相机编码构成的目标夹
    expect(screen.getAllByText(/NikonZ9_E_CQ/).length).toBeGreaterThan(0);
  });
});
