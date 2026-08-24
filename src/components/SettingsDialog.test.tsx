/** 工作站设置对话框：首跑引导、校验、保存回写。 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../App";
import { mockProjects, mockWorkstation } from "../api/mock";

// mock 回退会就地改写 mockWorkstation，测完还原，避免同文件内互相污染
const original = { ...mockWorkstation };
beforeEach(() => Object.assign(mockWorkstation, original));
afterEach(() => {
  cleanup();
  Object.assign(mockWorkstation, original);
});

const configured = {
  route: "projects" as const,
  workstation: original,
  projects: mockProjects,
  cameras: [],
  cards: [],
  volumes: [],
  tasks: [],
};

/** 首跑状态：Rust 侧尚未配置，nasRoot 为空 */
const firstRun = {
  ...configured,
  workstation: { machineId: "WS-NEW", operator: "", nasRoot: "" },
};

describe("工作站设置", () => {
  it("齿轮入口在顶栏，点开出现设置对话框", async () => {
    const user = userEvent.setup();
    render(<App preloaded={configured} />);

    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByTestId("settings-open"));

    expect(screen.getByRole("dialog", { name: "工作站设置" })).toBeDefined();
  });

  it("打开时预填当前配置", async () => {
    const user = userEvent.setup();
    render(<App preloaded={configured} />);
    await user.click(screen.getByTestId("settings-open"));

    expect((screen.getByTestId("settings-operator") as HTMLInputElement).value).toBe(
      original.operator,
    );
    expect((screen.getByTestId("settings-nas-root") as HTMLInputElement).value).toBe(
      original.nasRoot,
    );
  });

  it("保存后写回工作站信息并关闭对话框", async () => {
    const user = userEvent.setup();
    render(<App preloaded={configured} />);
    await user.click(screen.getByTestId("settings-open"));

    const operator = screen.getByTestId("settings-operator");
    const nasRoot = screen.getByTestId("settings-nas-root");
    await user.clear(operator);
    await user.type(operator, "李默");
    await user.clear(nasRoot);
    await user.type(nasRoot, "/Volumes/NAS2/Projects");
    await user.click(screen.getByTestId("settings-save"));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // 侧栏立刻反映新的操作人
    expect(screen.getByText(/李默/)).toBeDefined();
    // mock 层也被更新，下次 getWorkstationInfo 读得到
    expect(mockWorkstation.operator).toBe("李默");
    expect(mockWorkstation.nasRoot).toBe("/Volumes/NAS2/Projects");
  });

  it("操作人为空时拦下，不保存", async () => {
    const user = userEvent.setup();
    render(<App preloaded={configured} />);
    await user.click(screen.getByTestId("settings-open"));

    await user.clear(screen.getByTestId("settings-operator"));
    await user.click(screen.getByTestId("settings-save"));

    const alerts = screen.getAllByRole("alert").map((el) => el.textContent);
    expect(alerts.some((t) => t?.includes("操作人"))).toBe(true);
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(mockWorkstation.operator).toBe(original.operator);
  });

  it("NAS 根路径必须是绝对路径", async () => {
    const user = userEvent.setup();
    render(<App preloaded={configured} />);
    await user.click(screen.getByTestId("settings-open"));

    const nasRoot = screen.getByTestId("settings-nas-root");
    await user.clear(nasRoot);
    await user.type(nasRoot, "Projects/校运会");
    await user.click(screen.getByTestId("settings-save"));

    const alerts = screen.getAllByRole("alert").map((el) => el.textContent);
    expect(alerts.some((t) => t?.includes("绝对路径"))).toBe(true);
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("取消不写入任何改动", async () => {
    const user = userEvent.setup();
    render(<App preloaded={configured} />);
    await user.click(screen.getByTestId("settings-open"));

    await user.clear(screen.getByTestId("settings-operator"));
    await user.type(screen.getByTestId("settings-operator"), "不该被保存");
    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockWorkstation.operator).toBe(original.operator);
  });

  it("Esc 关闭对话框", async () => {
    const user = userEvent.setup();
    render(<App preloaded={configured} />);
    await user.click(screen.getByTestId("settings-open"));

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("首跑引导", () => {
  it("NAS 根路径为空时显示引导，而不是直接进项目列表", () => {
    render(<App preloaded={firstRun} />);

    expect(screen.getByTestId("first-run-guide")).toBeDefined();
    expect(screen.queryAllByTestId("project-row")).toHaveLength(0);
  });

  it("引导里的按钮直接打开设置，配置完成后进入项目列表", async () => {
    const user = userEvent.setup();
    render(<App preloaded={firstRun} />);

    await user.click(screen.getByTestId("first-run-open-settings"));
    expect(screen.getByRole("dialog", { name: "工作站设置" })).toBeDefined();

    await user.type(screen.getByTestId("settings-operator"), "张三");
    await user.type(screen.getByTestId("settings-nas-root"), "/Volumes/DIT-NAS/Projects");
    await user.click(screen.getByTestId("settings-save"));

    await waitFor(() => expect(screen.queryByTestId("first-run-guide")).toBeNull());
    expect(screen.getAllByTestId("project-row").length).toBeGreaterThan(0);
  });

  it("首跑状态下齿轮入口依然可用（顶栏常驻）", () => {
    render(<App preloaded={firstRun} />);
    expect(screen.getByTestId("settings-open")).toBeDefined();
  });
});
