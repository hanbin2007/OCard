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
  route: "copy" as const,
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
  workstation: { machineId: "WS-NEW", operator: "", nasRoot: "", recentProjects: [] },
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
        "已下载，点击安装更新完成安装",
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
    // 安装成功后按钮收起：后端 pending 已清空，再点只会得到「没有已下载的更新」
    await waitFor(() =>
      expect(screen.queryByTestId("settings-install-update")).toBeNull(),
    );
    expect(screen.getByTestId("settings-install-done")).toBeDefined();

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
    // 安装成功后不该还留着可再点的按钮
    expect(screen.queryByTestId("settings-install-update")).toBeNull();

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

describe("转码能力", () => {
  async function openSettings2() {
    const user = userEvent.setup();
    render(<App preloaded={configured} />);
    await user.click(screen.getByTestId("settings-open"));
    return user;
  }

  it("ready 时显示 ffmpeg 版本与能力矩阵", async () => {
    await openSettings2();
    await waitFor(() => expect(screen.getByTestId("settings-ffmpeg-ok")).toBeDefined());
    expect(screen.getByTestId("settings-ffmpeg-ok").textContent).toContain("7.1");

    const winners = await screen.findAllByTestId("caps-winner");
    expect(winners.length).toBeGreaterThan(0);
    expect(winners[0].textContent).toContain("h264_videotoolbox");
    expect(screen.getAllByTestId("caps-probe").length).toBeGreaterThan(0);
  });

  it("missing 时红色禁用态：重新探测按钮不可点", async () => {
    const spy = vi
      .spyOn(api, "ffmpegStatus")
      .mockResolvedValue({ status: "missing", error: "sidecar 未随包分发" });

    await openSettings2();
    const banner = await screen.findByTestId("settings-ffmpeg-missing");
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain("sidecar 未随包分发");
    await waitFor(() =>
      expect(
        (screen.getByTestId("settings-reprobe") as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    spy.mockRestore();
  });

  it("重新探测：probing 期间轮询，直到 ready 才停", async () => {
    const spy = vi
      .spyOn(api, "transcodeCapabilities")
      .mockResolvedValueOnce({ status: "ready", report: undefined })
      .mockResolvedValueOnce({ status: "probing" })
      .mockResolvedValueOnce({ status: "probing" })
      .mockResolvedValue({
        status: "ready",
        report: {
          ffmpeg: { version: "7.1", ffmpegPath: "/a", ffprobePath: "/b" },
          winners: { "h264-encode": "libx264" },
          probes: [["h264-encode", "libx264", true]],
          probedAt: "2026-08-24T09:00:00+08:00",
        },
      });

    const user = await openSettings2();
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await user.click(screen.getByTestId("settings-reprobe"));

    // 轮询到 ready 才停：最终显示矩阵且按钮恢复
    await waitFor(() =>
      expect(screen.getAllByTestId("caps-winner")[0].textContent).toContain("libx264"),
    );
    await waitFor(() =>
      expect(
        (screen.getByTestId("settings-reprobe") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    // 第一次是 refresh=true，之后是轮询 refresh=false
    expect(spy.mock.calls.some((c) => c[0] === true)).toBe(true);
    spy.mockRestore();
  }, 15000);

  it("探测失败显示原因", async () => {
    const spy = vi
      .spyOn(api, "transcodeCapabilities")
      .mockResolvedValue({ status: "failed", error: "探测超时" });

    await openSettings2();
    const err = await screen.findByTestId("settings-caps-failed");
    expect(err.textContent).toContain("探测超时");
    spy.mockRestore();
  });

  it("「复制诊断信息」一键进剪贴板并给出回执(评审 #10)", async () => {
    const user = await openSettings2();
    await user.click(screen.getByTestId("settings-diagnostics"));

    // user-event 提供可读写的剪贴板 stub:验证真的复制进去了
    await waitFor(async () => {
      const text = await window.navigator.clipboard.readText();
      expect(text).toContain("ffmpeg");
      expect(text).toContain("probes");
    });
    expect(screen.getByTestId("settings-diagnostics").textContent).toContain(
      "已复制",
    );
  });

  /* 0.4.3 现场:Windows 上拷卡中断,用户手上只有一句报错,运行日志躺在系统
     日志目录里、界面上一个入口都没有——看得见但取不走。这两条锁住那个入口。 */
  it("「导出诊断报告」给出报告落在哪里", async () => {
    const spy = vi.spyOn(api, "exportDiagnostics").mockResolvedValue({
      path: "C:/Users/dit/Downloads/OCard-诊断报告-20260831-010203.txt",
      revealed: true,
    });

    const user = await openSettings2();
    await user.click(screen.getByTestId("settings-export-report"));

    const done = await screen.findByTestId("settings-export-report-done");
    // 只说「已导出」等于没说:用户得知道去哪儿找这个文件才发得出来
    expect(done.textContent).toContain("OCard-诊断报告-20260831-010203.txt");
    spy.mockRestore();
  });

  /* 后端在 reveal 失败时仍返回 Ok(文件确实生成了),只多发一条 warning。
     界面若无条件写「文件管理器已打开」,就和通知中心那句「没能打开」当面打架,
     用户会盯着屏幕等一个不会来的窗口。 */
  it("文件管理器没弹出来时，不许谎称已打开", async () => {
    const spy = vi
      .spyOn(api, "exportDiagnostics")
      .mockResolvedValue({ path: "D:/Downloads/report.txt", revealed: false });

    const user = await openSettings2();
    await user.click(screen.getByTestId("settings-export-report"));

    const done = await screen.findByTestId("settings-export-report-done");
    expect(done.textContent).toContain("D:/Downloads/report.txt");
    expect(done.textContent).toContain("没能自动打开");
    expect(done.textContent).not.toContain("文件管理器已打开");
    spy.mockRestore();
  });

  it("导出失败给出原因,不静默无事发生", async () => {
    const spy = vi
      .spyOn(api, "exportDiagnostics")
      .mockRejectedValue(new Error("写入诊断报告失败: D:/Downloads —— 拒绝访问"));

    const user = await openSettings2();
    await user.click(screen.getByTestId("settings-export-report"));

    const err = await screen.findByTestId("settings-export-report-error");
    expect(err.textContent).toContain("拒绝访问");
    expect(err.getAttribute("role")).toBe("alert");
    expect(screen.queryByTestId("settings-export-report-done")).toBeNull();
    spy.mockRestore();
  });
});

describe("首跑引导", () => {
  it("NAS 根路径为空时显示引导，而不是直接进项目列表", () => {
    render(<App preloaded={firstRun} />);

    expect(screen.getByTestId("first-run-guide")).toBeDefined();
    expect(screen.queryAllByTestId("project-row")).toHaveLength(0);
  });

  it("引导单屏配完操作人与 NAS 根(评审 6.3)，完成后进入拷卡界面", async () => {
    const user = userEvent.setup();
    render(
      <App
        preloaded={{ ...firstRun, selectedProjectId: mockProjects[0].id }}
      />,
    );

    // 单屏两个字段:全貌一眼可见,不再拆两步(手填路径,浏览按钮在测试环境隐藏)
    await user.type(screen.getByTestId("onboarding-operator"), "张三");
    await user.type(
      screen.getByTestId("onboarding-nas-root"),
      "/Volumes/DIT-NAS/Projects",
    );
    await user.click(screen.getByTestId("onboarding-finish"));

    await waitFor(() => expect(screen.queryByTestId("first-run-guide")).toBeNull());
    // 主窗口默认落在拷卡界面(启动重构):重拉后第一个项目被选中,表单可用
    expect(await screen.findByTestId("copy-start")).toBeDefined();
  });

  it("真实首跑:引导可达(不撞错误页),完成后进入欢迎页", async () => {
    // NAS 未配置时后端会拒绝 list_projects:bootstrap 必须先看工作站配置、
    // 跳过 NAS 依赖的拉取,否则新用户直接进错误页,向导根本到不了(codex P1)
    const ws = vi
      .spyOn(api, "getWorkstationInfo")
      .mockResolvedValueOnce({ machineId: "WS-NEW", operator: "", nasRoot: "", recentProjects: [] })
      .mockResolvedValue({
        machineId: "WS-NEW",
        operator: "张三",
        nasRoot: "/Volumes/DIT-NAS/Projects",
        recentProjects: [],
      });
    vi.spyOn(api, "setWorkstationInfo").mockResolvedValue({
      machineId: "WS-NEW",
      operator: "张三",
      nasRoot: "/Volumes/DIT-NAS/Projects",
      recentProjects: [],
    });
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByTestId("first-run-guide")).toBeDefined();
    await user.type(screen.getByTestId("onboarding-operator"), "张三");
    await user.type(
      screen.getByTestId("onboarding-nas-root"),
      "/Volumes/DIT-NAS/Projects",
    );
    await user.click(screen.getByTestId("onboarding-finish"));

    // 完成设置触发整体重拉:重拉期间欢迎页会短暂让位给加载态。
    // 稳定判据 = 第二次读工作站配置已发生 **且** 欢迎页可见——
    // 只等其一会撞进「重拉尚未开始的过渡帧」(时序取样竞态)
    await waitFor(
      () => {
        expect(ws).toHaveBeenCalledTimes(2);
        expect(screen.getByTestId("welcome-home")).toBeDefined();
        expect(screen.getByTestId("welcome-new-project")).toBeDefined();
      },
      { timeout: 3000 },
    );
  });

  it("操作人为空时提交报错,引导留在原地", async () => {
    const user = userEvent.setup();
    render(<App preloaded={firstRun} />);

    await user.click(screen.getByTestId("onboarding-finish"));
    expect(screen.getByText(/请填写操作人/)).toBeDefined();
    expect(screen.getByTestId("onboarding-operator")).toBeDefined();
  });

  it("首跑状态下齿轮入口依然可用（顶栏常驻）", () => {
    render(<App preloaded={firstRun} />);
    expect(screen.getByTestId("settings-open")).toBeDefined();
  });
});

/**
 * 设置对话框是**真**模态：`aria-modal="true"` 写在那儿，Tab 就必须圈在里面。
 *
 * 一律走 `user.keyboard("{Tab}")`（派发到 `document.activeElement`；没被
 * `preventDefault` 时 user-event 会真的把焦点移到下一个可聚焦元素）并直接断言
 * `document.activeElement`——`fireEvent.keyDown(某元素, …)` 会绕过整条焦点链，
 * 本项目的焦点 bug 当初就是这么逃过测试的。
 */
describe("工作站设置：焦点圈定", () => {
  /** 打开设置框并等异步探测落定（ffmpeg / 能力矩阵 / 版本号会改动可聚焦集合） */
  async function openSettings() {
    const user = userEvent.setup();
    render(<App preloaded={configured} />);
    await user.click(screen.getByTestId("settings-open"));
    const dialog = screen.getByRole("dialog", { name: "工作站设置" });
    await screen.findByTestId("settings-save");
    return { user, dialog };
  }

  function focusables(dialog: HTMLElement): HTMLElement[] {
    return Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
  }

  it("开屏焦点落在「操作人」输入框上", async () => {
    await openSettings();
    expect(document.activeElement).toBe(screen.getByTestId("settings-operator"));
  });

  it("末项按 Tab 回到首项：焦点跑不到遮罩背后的侧栏与主区", async () => {
    const { user, dialog } = await openSettings();
    const items = focusables(dialog);
    expect(items.length).toBeGreaterThan(1);

    items[items.length - 1].focus();
    await user.keyboard("{Tab}");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(items[0]);
  });

  it("首项按 Shift+Tab 回到末项", async () => {
    const { user, dialog } = await openSettings();
    const items = focusables(dialog);

    items[0].focus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it("焦点被挪到层外（顶栏齿轮）时，下一次 Tab 把它拽回框内", async () => {
    const { user, dialog } = await openSettings();
    const gear = screen.getByTestId("settings-open");
    gear.focus();
    expect(document.activeElement).toBe(gear);

    await user.keyboard("{Tab}");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(focusables(dialog)[0]);
  });

  it("Esc 关闭后焦点还给齿轮按钮，不掉进 body", async () => {
    const { user } = await openSettings();
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "工作站设置" })).toBeNull(),
    );
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(screen.getByTestId("settings-open"));
  });
});
