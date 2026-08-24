import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import App from "../App";
import {
  mockCameras,
  mockCopyTasks,
  mockProjects,
  mockStorageCards,
  mockVolumes,
  mockWorkstation,
} from "../api/mock";

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
    expect(screen.getAllByText("写入中")).toHaveLength(2);
  });

  it("选中源卷自动带出已登记相机与目标路径", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    expect(targetPreview()).toBe("选择相机后生成");
    await user.click(screen.getByRole("button", { name: "选择源卷 SONY_A7M4" }));

    // 卡 SD-03 关联 Sony A7M4，编码随之带出；工况 B 落到「1. 待分类」
    expect(targetPreview()).toContain("SonyA7M4_A_LM");
    expect(targetPreview()?.startsWith("1. 待分类/")).toBe(true);
  });

  it("缺备注时拦下，不新建任务", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    await user.click(screen.getByRole("button", { name: "选择源卷 SONY_A7M4" }));
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));

    const alerts = screen.getAllByRole("alert").map((el) => el.textContent);
    expect(alerts.some((t) => t?.includes("必填"))).toBe(true);

    const tabs = within(screen.getByRole("group", { name: "任务切换" })).getAllByRole(
      "button",
    );
    expect(tabs).toHaveLength(mockCopyTasks.length);
  });

  it("双确认填齐后建立任务并置顶选中", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    await user.click(screen.getByRole("button", { name: "选择源卷 NIKON_Z9" }));
    await user.type(screen.getByLabelText("内容备注"), "下午径赛");
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));

    const group = screen.getByRole("group", { name: "任务切换" });
    await waitFor(() =>
      expect(within(group).getAllByRole("button")).toHaveLength(
        mockCopyTasks.length + 1,
      ),
    );
    // 新任务置顶且带出相机编码构成的目标夹
    expect(screen.getAllByText(/NikonZ9_E_CQ/).length).toBeGreaterThan(0);
  });
});
