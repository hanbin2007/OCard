/**
 * 会话守卫:15 分钟闲置询问 → 5 分钟无应答终止 → 重新确认操作员
 * (沿用上一人需二次确认;换人写回工作站配置)。
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

/**
 * 会话门与闲置询问都写着 `aria-modal="true"`，所以 Tab 必须真的圈在里面。
 *
 * inert 只挡住了侧栏 / 主区 / 快捷拷卡；`.shell` 下的设置对话框、toast 不在
 * 名单里，光靠 inert 挡不住键盘。而且门上还能再开一层确认框（`--elevated`
 * z=90 压在门 z=80 之上），此时**只有最上面那一层**该收键。
 *
 * 一律走 `user.keyboard(...)`（派发到 `document.activeElement`）并直接断言
 * `document.activeElement`：用 `fireEvent.keyDown(某元素, …)` 会绕过焦点链。
 */
describe("会话门：焦点圈定与嵌套", () => {
  /**
   * 到门前用假时钟（闲置阈值是 15 分钟，等不起），到门后立刻换回真时钟：
   * user-event 内部有自己的等待，跟假时钟凑在一起会互相卡死。门已经立起来了，
   * 后面的判定不再依赖时钟。
   */
  function toGate() {
    render(<App preloaded={preloaded} />);
    advance(IDLE_PROMPT_MS + IDLE_TICK_MS);
    advance(PROMPT_GRACE_MS + IDLE_TICK_MS);
    const gate = screen.getByTestId("session-gate");
    vi.useRealTimers();
    return { gate, user: userEvent.setup() };
  }

  it("闲置询问开屏把焦点收进「继续会话」", () => {
    render(<App preloaded={preloaded} />);
    advance(IDLE_PROMPT_MS + IDLE_TICK_MS);
    expect(document.activeElement).toBe(screen.getByTestId("session-continue"));
  });

  it("门开屏把焦点收进「继续上一位」", () => {
    render(<App preloaded={preloaded} />);
    advance(IDLE_PROMPT_MS + IDLE_TICK_MS);
    advance(PROMPT_GRACE_MS + IDLE_TICK_MS);
    expect(document.activeElement).toBe(screen.getByTestId("session-gate-last"));
  });

  it("末项 Tab 回到首项、首项 Shift+Tab 回到末项：焦点出不去这道门", async () => {
    const { user } = toGate();
    const first = screen.getByTestId("session-gate-last");
    const last = screen.getByTestId("session-gate-start");

    last.focus();
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(first);

    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(last);
  });

  it("焦点被挪到门外时，下一次 Tab 把它拽回门里", async () => {
    const { gate, user } = toGate();
    // 顶栏齿轮在 .main 里（已被 inert），但 jsdom 不模拟 inert 的失焦语义，
    // 恰好可以用它扮演「焦点跑到层外」这一幕
    const outside = screen.getByTestId("settings-open");
    outside.focus();
    expect(document.activeElement).toBe(outside);

    await user.keyboard("{Tab}");
    expect(gate.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId("session-gate-last"));
  });

  it("嵌套：门上开确认框后只有确认框收键，Tab 不会被门扯回去", async () => {
    const { user } = toGate();
    await user.click(screen.getByTestId("session-gate-last"));

    const confirm = await screen.findByRole("alertdialog");
    const cancel = screen.getByRole("button", { name: "取消" });
    const ok = screen.getByRole("button", { name: /确认是/ });
    // 归属性确认一律以「取消」为默认动作
    expect(document.activeElement).toBe(cancel);

    /*
     * 判别点：从确认框首项按 Tab，正确结果是走到确认框末项。
     * 门要是也在收键（少了栈顶判定），它会先把焦点扯回 session-gate-last，
     * 确认框再把它捞回首项——结果停在「取消」上，永远走不到「确认」。
     */
    await user.keyboard("{Tab}");
    expect(confirm.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(ok);

    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(cancel);
  });

  it("嵌套：Esc 只关最上面的确认框，门原地不动，焦点还给开框的那个按钮", async () => {
    const { user } = toGate();
    await user.click(screen.getByTestId("session-gate-last"));
    await screen.findByRole("alertdialog");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByTestId("session-gate")).toBeDefined();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(screen.getByTestId("session-gate-last"));
  });

  it("确认沿用上一位后会话恢复，焦点回到进门前那个控件而不是 body", async () => {
    render(<App preloaded={preloaded} />);
    // 进门前先把焦点放在一个门外、门收起后仍然存在的控件上
    const gear = screen.getByTestId("settings-open");
    gear.focus();

    advance(IDLE_PROMPT_MS + IDLE_TICK_MS);
    advance(PROMPT_GRACE_MS + IDLE_TICK_MS);
    screen.getByTestId("session-gate");
    vi.useRealTimers();
    const user = userEvent.setup();

    await user.click(screen.getByTestId("session-gate-last"));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: /确认是/ }));

    expect(screen.queryByTestId("session-gate")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(gear);
  });
});
