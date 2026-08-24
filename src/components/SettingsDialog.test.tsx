/** 工作站设置对话框：首跑引导、校验、保存回写。 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import * as api from "../api";
import { mockProjects, mockWorkstation } from "../api/mock";
import type { NoticeDto } from "../api/types";

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

describe("关于与更新", () => {
  async function openSettings() {
    const user = userEvent.setup();
    render(<App preloaded={configured} />);
    await user.click(screen.getByTestId("settings-open"));
    return user;
  }

  it("显示当前版本号", async () => {
    await openSettings();
    await waitFor(() =>
      expect(screen.getByTestId("settings-version").textContent).toBe("v0.1.0"),
    );
  });

  it("检查更新期间按钮禁用并显示 loading", async () => {
    let resolveCheck: ((r: "uptodate") => void) | null = null;
    const spy = vi
      .spyOn(api, "checkForUpdate")
      .mockImplementation(() => new Promise((r) => (resolveCheck = r)));

    const user = await openSettings();
    const button = screen.getByTestId("settings-check-update");
    await user.click(button);

    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toContain("检查中");

    await act(async () => {
      resolveCheck?.("uptodate");
    });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));

    spy.mockRestore();
  });

  it("「已是最新」内联反馈", async () => {
    const spy = vi.spyOn(api, "checkForUpdate").mockResolvedValue("uptodate");
    const user = await openSettings();

    await user.click(screen.getByTestId("settings-check-update"));
    await waitFor(() =>
      expect(screen.getByTestId("settings-update-result").textContent).toBe("已是最新"),
    );
    spy.mockRestore();
  });

  it("「更新已就绪」与「不支持自动更新」各自的文案", async () => {
    const spy = vi.spyOn(api, "checkForUpdate").mockResolvedValue("ready");
    const user = await openSettings();

    await user.click(screen.getByTestId("settings-check-update"));
    await waitFor(() =>
      expect(screen.getByTestId("settings-update-result").textContent).toBe(
        "已下载，点击重启并更新安装",
      ),
    );

    spy.mockResolvedValue("unsupported");
    await user.click(screen.getByTestId("settings-check-update"));
    await waitFor(() =>
      expect(screen.getByTestId("settings-update-result").textContent).toBe(
        "当前安装方式不支持自动更新",
      ),
    );
    spy.mockRestore();
  });

  it("ready 时出现「安装更新」主按钮", async () => {
    const spy = vi.spyOn(api, "checkForUpdate").mockResolvedValue("ready");
    const user = await openSettings();

    expect(screen.queryByTestId("settings-install-update")).toBeNull();
    await user.click(screen.getByTestId("settings-check-update"));

    await waitFor(() =>
      expect(screen.getByTestId("settings-install-update")).toBeDefined(),
    );
    expect(screen.getByTestId("settings-install-update").textContent).toContain(
      "安装更新",
    );
    spy.mockRestore();
  });

  it("收到 update-ready 通知时也出现「安装更新」（无需先手动检查）", async () => {
    let emit: ((n: NoticeDto) => void) | null = null;
    const subSpy = vi
      .spyOn(api, "subscribeNotices")
      .mockImplementation((onNotice: (n: NoticeDto) => void) => {
        emit = onNotice;
        return { dispose: () => {}, ready: Promise.resolve() };
      });

    const user = userEvent.setup();
    render(<App preloaded={configured} />);

    act(() =>
      emit?.({
        level: "info",
        code: "update-ready",
        message: "已在后台更新到 v0.2.0",
        occurredAt: "2026-08-24T10:00:00+08:00",
      }),
    );

    await user.click(screen.getByTestId("settings-open"));
    expect(screen.getByTestId("settings-install-update")).toBeDefined();

    subSpy.mockRestore();
  });

  it("安装被后端拒绝时原样显示中文原因", async () => {
    const checkSpy = vi.spyOn(api, "checkForUpdate").mockResolvedValue("ready");
    const installSpy = vi
      .spyOn(api, "installUpdate")
      .mockRejectedValue(new Error("有拷卡任务正在进行，请等待完成后再更新"));

    const user = await openSettings();
    await user.click(screen.getByTestId("settings-check-update"));
    await waitFor(() =>
      expect(screen.getByTestId("settings-install-update")).toBeDefined(),
    );

    await user.click(screen.getByTestId("settings-install-update"));

    const alert = await screen.findByTestId("settings-install-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("有拷卡任务正在进行");

    checkSpy.mockRestore();
    installSpy.mockRestore();
  });

  it("安装期间按钮禁用并显示进行中", async () => {
    const checkSpy = vi.spyOn(api, "checkForUpdate").mockResolvedValue("ready");
    let finish: (() => void) | null = null;
    const installSpy = vi
      .spyOn(api, "installUpdate")
      .mockImplementation(() => new Promise<void>((r) => (finish = r)));

    const user = await openSettings();
    await user.click(screen.getByTestId("settings-check-update"));
    await waitFor(() =>
      expect(screen.getByTestId("settings-install-update")).toBeDefined(),
    );

    const button = screen.getByTestId("settings-install-update");
    await user.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toContain("正在安装");

    await act(async () => {
      finish?.();
    });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));

    checkSpy.mockRestore();
    installSpy.mockRestore();
  });

  it("busy：后台已在检查/下载时给出稍候提示", async () => {
    const spy = vi.spyOn(api, "checkForUpdate").mockResolvedValue("busy");
    const user = await openSettings();

    await user.click(screen.getByTestId("settings-check-update"));
    await waitFor(() =>
      expect(screen.getByTestId("settings-update-result").textContent).toBe(
        "后台正在检查或下载，请稍候再试",
      ),
    );
    // busy 不等于就绪，不该出现安装按钮
    expect(screen.queryByTestId("settings-install-update")).toBeNull();
    spy.mockRestore();
  });

  it("安装成功后提示「已安装，重启应用后生效」", async () => {
    const checkSpy = vi.spyOn(api, "checkForUpdate").mockResolvedValue("ready");
    const installSpy = vi.spyOn(api, "installUpdate").mockResolvedValue(undefined);

    const user = await openSettings();
    await user.click(screen.getByTestId("settings-check-update"));
    await waitFor(() =>
      expect(screen.getByTestId("settings-install-update")).toBeDefined(),
    );

    await user.click(screen.getByTestId("settings-install-update"));

    // macOS/Linux 不会自动重启，必须说清楚还要手动重启
    await waitFor(() =>
      expect(screen.getByTestId("settings-install-done").textContent).toBe(
        "已安装，重启应用后生效",
      ),
    );
    expect(screen.queryByTestId("settings-install-error")).toBeNull();

    checkSpy.mockRestore();
    installSpy.mockRestore();
  });

  it("检查失败时引导去通知中心，不静默", async () => {
    const spy = vi
      .spyOn(api, "checkForUpdate")
      .mockRejectedValue(new Error("network down"));
    const user = await openSettings();

    await user.click(screen.getByTestId("settings-check-update"));
    await waitFor(() =>
      expect(screen.getByTestId("settings-update-result").textContent).toBe(
        "检查失败，详见通知",
      ),
    );
    spy.mockRestore();
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
