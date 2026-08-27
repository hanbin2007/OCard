/**
 * 会话守卫:15 分钟闲置询问 → 5 分钟无应答终止 → 重新确认操作员
 * (沿用上一人需二次确认;换人写回工作站配置)。
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import App from "../App";
import {
  IDLE_PROMPT_MS,
  IDLE_TICK_MS,
  PROMPT_GRACE_MS,
} from "./SessionGuard";

const preloaded = {
  route: "copy" as const,
  workstation: {
    machineId: "WS-TEST",
    operator: "张三",
    nasRoot: "/Volumes/DIT-NAS/Projects",
    recentProjects: [],
  },
  projects: [],
  cameras: [],
  cards: [],
  volumes: [],
  tasks: [],
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 推进假时钟并让 interval 回调在 act 里落地 */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("闲置询问", () => {
  it("15 分钟无操作弹出「是否继续会话」", () => {
    render(<App preloaded={preloaded} />);
    expect(screen.queryByTestId("session-idle-dialog")).toBeNull();

    advance(IDLE_PROMPT_MS + IDLE_TICK_MS);
    expect(screen.getByTestId("session-idle-dialog")).toBeDefined();
  });

  it("拷卡/校验进行中不算闲置:盯进度不该被门挡住(评审 2.4)", async () => {
    const { mockCopyTasks } = await import("../api/mock");
    render(
      <App
        preloaded={{
          ...preloaded,
          tasks: [{ ...mockCopyTasks[0], state: "running" as const }],
        }}
      />,
    );

    // 远超闲置阈值也不弹:数据在动就是有人在干活
    advance(IDLE_PROMPT_MS * 2 + IDLE_TICK_MS);
    expect(screen.queryByTestId("session-idle-dialog")).toBeNull();
  });

  it("询问弹窗带实时倒计时", () => {
    render(<App preloaded={preloaded} />);
    advance(IDLE_PROMPT_MS + IDLE_TICK_MS);

    const countdown = screen.getByTestId("session-idle-countdown");
    expect(countdown.textContent).toBe("5:00");
    advance(61_000);
    expect(
      screen.getByTestId("session-idle-countdown").textContent?.startsWith("3:"),
    ).toBe(true);
  });

  it("有操作就不会弹:活动把闲置计时推回去", () => {
    render(<App preloaded={preloaded} />);

    advance(IDLE_PROMPT_MS / 2);
    // 模拟用户活动(捕获阶段监听 keydown)
    act(() => {
      fireEvent.keyDown(window, { key: "a" });
    });
    advance(IDLE_PROMPT_MS / 2 + IDLE_TICK_MS);
    expect(screen.queryByTestId("session-idle-dialog")).toBeNull();

    advance(IDLE_PROMPT_MS / 2 + IDLE_TICK_MS);
    expect(screen.getByTestId("session-idle-dialog")).toBeDefined();
  });

  it("点「继续会话」回到工作状态,计时重新起算", () => {
    render(<App preloaded={preloaded} />);
    advance(IDLE_PROMPT_MS + IDLE_TICK_MS);

    fireEvent.click(screen.getByTestId("session-continue"));
    expect(screen.queryByTestId("session-idle-dialog")).toBeNull();

    advance(IDLE_PROMPT_MS - IDLE_TICK_MS);
    expect(screen.queryByTestId("session-idle-dialog")).toBeNull();
    advance(IDLE_TICK_MS * 2);
    expect(screen.getByTestId("session-idle-dialog")).toBeDefined();
  });

  it("询问后再等 5 分钟无应答,会话终止进操作员确认门", () => {
    render(<App preloaded={preloaded} />);
    advance(IDLE_PROMPT_MS + IDLE_TICK_MS);
    expect(screen.getByTestId("session-idle-dialog")).toBeDefined();

    advance(PROMPT_GRACE_MS + IDLE_TICK_MS);
    expect(screen.queryByTestId("session-idle-dialog")).toBeNull();
    expect(screen.getByTestId("session-gate")).toBeDefined();
  });

  it("点「结束会话」立即进操作员确认门", () => {
    render(<App preloaded={preloaded} />);
    advance(IDLE_PROMPT_MS + IDLE_TICK_MS);

    fireEvent.click(screen.getByTestId("session-end"));
    expect(screen.getByTestId("session-gate")).toBeDefined();
  });
});

describe("操作员确认门", () => {
  function endSession() {
    render(<App preloaded={preloaded} />);
    advance(IDLE_PROMPT_MS + IDLE_TICK_MS);
    fireEvent.click(screen.getByTestId("session-end"));
  }

  it("沿用上一位要二次确认,确认后恢复会话", () => {
    endSession();

    fireEvent.click(screen.getByTestId("session-gate-last"));
    // 二次确认对话框:不是点一下就过
    expect(screen.getByText("仍由「张三」操作？")).toBeDefined();
    expect(screen.getByTestId("session-gate")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "确认是 张三" }));
    expect(screen.queryByTestId("session-gate")).toBeNull();
  });

  it("二次确认里点取消仍留在门内", () => {
    endSession();

    fireEvent.click(screen.getByTestId("session-gate-last"));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByTestId("session-gate")).toBeDefined();
  });

  it("换新操作人:写回工作站配置后恢复,侧栏显示新名字", async () => {
    const spy = vi.spyOn(api, "setWorkstationInfo").mockResolvedValueOnce({
      machineId: "WS-TEST",
      operator: "李四",
      nasRoot: "/Volumes/DIT-NAS/Projects",
      recentProjects: [],
    });
    endSession();

    fireEvent.change(screen.getByTestId("session-gate-operator"), {
      target: { value: "李四" },
    });
    fireEvent.click(screen.getByTestId("session-gate-start"));

    // mockResolvedValue 的微任务在假时钟下也要 flush
    await act(async () => {
      await Promise.resolve();
    });
    expect(spy).toHaveBeenCalledWith("李四", "/Volumes/DIT-NAS/Projects");
    expect(screen.queryByTestId("session-gate")).toBeNull();
    expect(screen.getByText(/李四/)).toBeDefined();
  });

  it("空操作人被拦下并报错,门不放行", () => {
    endSession();

    fireEvent.click(screen.getByTestId("session-gate-start"));
    expect(screen.getByText("请填写操作人")).toBeDefined();
    expect(screen.getByTestId("session-gate")).toBeDefined();
  });

  it("手打同名不能绕过二次确认:仍弹确认框,确认后恢复且不写配置", async () => {
    const spy = vi.spyOn(api, "setWorkstationInfo");
    endSession();

    fireEvent.change(screen.getByTestId("session-gate-operator"), {
      target: { value: "张三" },
    });
    fireEvent.click(screen.getByTestId("session-gate-start"));
    // 不直接放行:同名也要过同一道确认
    expect(screen.getByText("仍由「张三」操作？")).toBeDefined();
    expect(screen.getByTestId("session-gate")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "确认是 张三" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("session-gate")).toBeNull();
  });

  it("toast 层不在 .main 里:门 inert 主区时 error toast 仍可确认(结构钉死)", () => {
    render(<App preloaded={preloaded} />);
    // jsdom 测不了命中,但结构能钉:toasts 一旦回到 .main 下,这条立刻红
    expect(document.querySelector(".shell > .main .toasts")).toBeNull();
  });

  it("门弹出时背后的侧栏与主区被 inert 屏蔽,恢复后解除", () => {
    endSession();
    const sidebar = document.querySelector(".shell > .sidebar");
    const main = document.querySelector(".shell > .main");
    expect(sidebar?.hasAttribute("inert")).toBe(true);
    expect(main?.hasAttribute("inert")).toBe(true);

    fireEvent.click(screen.getByTestId("session-gate-last"));
    fireEvent.click(screen.getByRole("button", { name: "确认是 张三" }));
    expect(sidebar?.hasAttribute("inert")).toBe(false);
    expect(main?.hasAttribute("inert")).toBe(false);
  });
});

describe("计时边界", () => {
  it("询问期间的鼠标活动不能续命:5 分钟无应答照样终止", () => {
    render(<App preloaded={preloaded} />);
    advance(IDLE_PROMPT_MS + IDLE_TICK_MS);
    expect(screen.getByTestId("session-idle-dialog")).toBeDefined();

    // 疯狂动鼠标但不点按钮——只有显式点「继续会话」才算应答
    for (let i = 0; i < 10; i++) {
      act(() => {
        fireEvent.pointerMove(window);
      });
      advance((PROMPT_GRACE_MS / 10) | 0);
    }
    advance(IDLE_TICK_MS * 2);
    expect(screen.getByTestId("session-gate")).toBeDefined();
  });

  it("询问弹出 4 分钟时还没终止", () => {
    render(<App preloaded={preloaded} />);
    advance(IDLE_PROMPT_MS + IDLE_TICK_MS);

    advance(PROMPT_GRACE_MS - 60_000);
    expect(screen.getByTestId("session-idle-dialog")).toBeDefined();
    expect(screen.queryByTestId("session-gate")).toBeNull();
  });
});

describe("未配置时不设防", () => {
  it("引导阶段(无操作人)不会弹闲置询问", () => {
    render(
      <App
        preloaded={{
          ...preloaded,
          workstation: { machineId: "WS-NEW", operator: "", nasRoot: "", recentProjects: [] },
        }}
      />,
    );
    advance(IDLE_PROMPT_MS * 2);
    expect(screen.queryByTestId("session-idle-dialog")).toBeNull();
  });
});
