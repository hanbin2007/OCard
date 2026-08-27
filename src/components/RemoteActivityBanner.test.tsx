/**
 * 跨机拷卡活动可见性（规范 §6.3）：
 * 看见对方在拷哪张卡、同卷名警告但不阻断、连续失败才说「暂不可用」。
 */

import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import * as api from "../api";
import { mockCameras, mockProjects, mockStorageCards, mockVolumes, mockWorkstation } from "../api/mock";
import type { RemoteActivity } from "../api/types";
import {
  REMOTE_FAILURE_THRESHOLD,
  REMOTE_POLL_MS,
  useRemoteActivity,
} from "../hooks/useRemoteActivity";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const preloaded = {
  route: "copy" as const,
  workstation: mockWorkstation,
  projects: mockProjects,
  cameras: mockCameras,
  cards: mockStorageCards,
  volumes: mockVolumes,
  tasks: [],
  selectedProjectId: mockProjects[0].id,
};

function activity(over: Partial<RemoteActivity> = {}): RemoteActivity {
  return {
    machine: "WS-9A21",
    operator: "李默",
    activity: "copy",
    volume: "SONY_A7M4",
    camera: "SonyA7M4_A_LM",
    targetFolder: "0824上午_SonyA7M4_A_LM",
    startedAt: "2026-08-24T10:12:00+08:00",
    ...over,
  };
}

describe("跨机活动横幅", () => {
  it("有远端活动时显示「谁在拷哪张卡 → 目标夹」", async () => {
    const spy = vi.spyOn(api, "listRemoteActivity").mockResolvedValue([activity()]);
    render(<App preloaded={preloaded} />);

    const banner = await screen.findByTestId("remote-activity-banner");
    expect(banner.textContent).toContain("另有 1 台工作站");

    const item = screen.getByTestId("remote-activity-item");
    expect(item.textContent).toContain("操作人 李默");
    expect(item.textContent).toContain("SONY_A7M4");
    expect(item.textContent).toContain("0824上午_SonyA7M4_A_LM");
    spy.mockRestore();
  });

  it("转码活动用「转码中」措辞并显示相机夹名", async () => {
    const spy = vi.spyOn(api, "listRemoteActivity").mockResolvedValue([
      activity({
        activity: "transcode",
        camera: "20260822_A7M4_A_LM",
        targetFolder: "4. 转码素材/20260822_A7M4_A_LM",
      }),
    ]);
    render(<App preloaded={preloaded} />);

    const item = await screen.findByTestId("remote-activity-item");
    expect(item.textContent).toContain("⟳");
    expect(item.textContent).toContain("正在转码");
    expect(item.textContent).toContain("20260822_A7M4_A_LM");
    // 转码条目不该说成「正在拷」
    expect(item.textContent).not.toContain("正在拷");
    spy.mockRestore();
  });

  it("拷卡活动仍用「正在拷」措辞", async () => {
    const spy = vi
      .spyOn(api, "listRemoteActivity")
      .mockResolvedValue([activity({ activity: "copy" })]);
    render(<App preloaded={preloaded} />);

    const item = await screen.findByTestId("remote-activity-item");
    expect(item.textContent).toContain("正在拷");
    expect(item.textContent).not.toContain("正在转码");
    spy.mockRestore();
  });

  it("多条堆叠显示", async () => {
    const spy = vi
      .spyOn(api, "listRemoteActivity")
      .mockResolvedValue([
        activity(),
        activity({ machine: "WS-33C7", operator: "王皓", volume: "NIKON_Z9" }),
      ]);
    render(<App preloaded={preloaded} />);

    await screen.findByTestId("remote-activity-banner");
    expect(screen.getAllByTestId("remote-activity-item")).toHaveLength(2);
    spy.mockRestore();
  });

  it("可以收起与展开", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "listRemoteActivity").mockResolvedValue([activity()]);
    render(<App preloaded={preloaded} />);

    await screen.findByTestId("remote-activity-banner");
    expect(screen.getByTestId("remote-activity-item")).toBeDefined();

    await user.click(screen.getByTestId("remote-activity-toggle"));
    expect(screen.queryByTestId("remote-activity-item")).toBeNull();
    // 收起后总览行仍在，不至于完全看不见
    expect(screen.getByTestId("remote-activity-banner").textContent).toContain(
      "另有 1 台工作站",
    );

    await user.click(screen.getByTestId("remote-activity-toggle"));
    expect(screen.getByTestId("remote-activity-item")).toBeDefined();
    spy.mockRestore();
  });

  it("没有远端活动时不显示任何横幅", async () => {
    const spy = vi.spyOn(api, "listRemoteActivity").mockResolvedValue([]);
    render(<App preloaded={preloaded} />);

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.queryByTestId("remote-activity-banner")).toBeNull();
    expect(screen.queryByTestId("remote-activity-unavailable")).toBeNull();
    spy.mockRestore();
  });
});

describe("轮询与失败降级", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));

  it("每 10 秒轮询一次", async () => {
    const spy = vi.spyOn(api, "listRemoteActivity").mockResolvedValue([]);
    render(<App preloaded={preloaded} />);

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await act(async () => {
      vi.advanceTimersByTime(REMOTE_POLL_MS);
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    spy.mockRestore();
  });

  it("单次/两次失败静默重试，不打扰用户", async () => {
    const spy = vi
      .spyOn(api, "listRemoteActivity")
      .mockRejectedValue(new Error("NAS 抖动"));
    render(<App preloaded={preloaded} />);

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("remote-activity-unavailable")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(REMOTE_POLL_MS);
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("remote-activity-unavailable")).toBeNull();

    spy.mockRestore();
  });

  it(`连续失败 ${REMOTE_FAILURE_THRESHOLD} 次才提示「跨机状态暂不可用」`, async () => {
    const spy = vi
      .spyOn(api, "listRemoteActivity")
      .mockRejectedValue(new Error("NAS 不可达"));
    render(<App preloaded={preloaded} />);

    for (let i = 1; i < REMOTE_FAILURE_THRESHOLD; i += 1) {
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(i));
      await act(async () => {
        vi.advanceTimersByTime(REMOTE_POLL_MS);
      });
    }

    const banner = await screen.findByTestId("remote-activity-unavailable");
    expect(banner.textContent).toContain("跨机状态暂不可用");
    // 说清不影响本机拷卡
    expect(banner.textContent).toContain("不影响本机拷卡");
    spy.mockRestore();
  });

  it("恢复成功后「暂不可用」自动消失", async () => {
    const spy = vi
      .spyOn(api, "listRemoteActivity")
      .mockRejectedValue(new Error("NAS 不可达"));
    render(<App preloaded={preloaded} />);

    for (let i = 1; i < REMOTE_FAILURE_THRESHOLD; i += 1) {
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(i));
      await act(async () => {
        vi.advanceTimersByTime(REMOTE_POLL_MS);
      });
    }
    await screen.findByTestId("remote-activity-unavailable");

    spy.mockResolvedValue([activity()]);
    await act(async () => {
      vi.advanceTimersByTime(REMOTE_POLL_MS);
    });

    await waitFor(() =>
      expect(screen.queryByTestId("remote-activity-unavailable")).toBeNull(),
    );
    expect(screen.getByTestId("remote-activity-banner")).toBeDefined();
    spy.mockRestore();
  });
});

describe("同卷名警告", () => {
  async function reachConfirm(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("radio", { name: "选择源卷 SONY_A7M4" }));
    // 标签系统(启动重构)取代自由备注
    await user.type(screen.getByLabelText("内容标签"), "上午田赛");
    await user.keyboard("{Enter}");
    // 该项目设置里有备份盘预设,异步落进第 2 行;手动添加会与之竞态,等预设即可
    await waitFor(() =>
      expect(
        (screen.getByLabelText("第 2 个目的地路径") as HTMLInputElement).value,
      ).not.toBe(""),
    );
    await user.click(screen.getByRole("button", { name: "开始拷卡" }));
    await waitFor(() =>
      expect(screen.getByTestId("confirm-target-folder").textContent).not.toBe("解析中…"),
    );
  }

  it("确认屏对同名卷显式警告，但不阻断（按钮仍可点）", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, "listRemoteActivity")
      .mockResolvedValue([activity({ volume: "SONY_A7M4" })]);

    render(<App preloaded={preloaded} />);
    await screen.findByTestId("remote-activity-banner");
    await reachConfirm(user);

    const warning = screen.getByTestId("copy-same-volume-warning");
    expect(warning.getAttribute("role")).toBe("alert");
    expect(warning.textContent).toContain("该卡可能正被他机拷贝");
    expect(warning.textContent).toContain("李默");
    // 只警告不拦路
    expect(
      (screen.getByTestId("copy-confirm-start") as HTMLButtonElement).disabled,
    ).toBe(false);
    spy.mockRestore();
  });

  it("远端拷的是别的卷时不误报", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, "listRemoteActivity")
      .mockResolvedValue([activity({ volume: "NIKON_Z9" })]);

    render(<App preloaded={preloaded} />);
    await screen.findByTestId("remote-activity-banner");
    await reachConfirm(user);

    expect(screen.queryByTestId("copy-same-volume-warning")).toBeNull();
    spy.mockRestore();
  });
});

describe("#20 切换项目重置状态", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));

  it("上个项目的「暂不可用」不会带到新项目头上", async () => {
    const spy = vi
      .spyOn(api, "listRemoteActivity")
      .mockRejectedValue(new Error("NAS 不可达"));

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useRemoteActivity(id),
      { initialProps: { id: "p-a" } },
    );

    for (let i = 1; i < REMOTE_FAILURE_THRESHOLD; i += 1) {
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(i));
      await act(async () => {
        vi.advanceTimersByTime(REMOTE_POLL_MS);
      });
    }
    await waitFor(() => expect(result.current.unavailable).toBe(true));

    // 换项目：让新项目的轮询悬着不返回，考察「首次成功之前」这段窗口——
    // 若不显式重置，旧项目的「暂不可用」会一直挂在新项目头上
    spy.mockImplementation(() => new Promise(() => {}));
    rerender({ id: "p-b" });
    expect(result.current.unavailable).toBe(false);

    spy.mockRestore();
  });

  it("切到新项目后旧项目的活动列表不残留", async () => {
    const spy = vi
      .spyOn(api, "listRemoteActivity")
      .mockResolvedValue([activity({ volume: "OLD_CARD" })]);

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useRemoteActivity(id),
      { initialProps: { id: "p-a" } },
    );
    await waitFor(() => expect(result.current.activities).toHaveLength(1));

    // 同样考察新项目首次返回之前：旧项目的活动不能残留在界面上
    spy.mockImplementation(() => new Promise(() => {}));
    rerender({ id: "p-b" });
    expect(result.current.activities).toHaveLength(0);
    spy.mockRestore();
  });
});
