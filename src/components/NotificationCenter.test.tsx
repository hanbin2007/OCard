/**
 * 通知中心：不允许静默 fail-open。
 * 覆盖去重折叠、error 不自动消失、未知 code 通用呈现、a11y 角色、铃铛常驻。
 */

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import * as api from "../api";
import { mockProjects, mockWorkstation } from "../api/mock";
import type { NoticeDto } from "../api/types";

let emit: ((notice: NoticeDto) => void) | null = null;
let subSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  emit = null;
  subSpy = vi.spyOn(api, "subscribeNotices").mockImplementation((onNotice) => {
    emit = onNotice;
    // ready 走微任务异步 resolve，贴近 listen() 的真实握手
    return { dispose: () => {}, ready: Promise.resolve() };
  });
});

afterEach(() => {
  cleanup();
  subSpy.mockRestore();
  vi.useRealTimers();
});

const preloaded = {
  route: "projects" as const,
  workstation: mockWorkstation,
  projects: mockProjects,
};

function notice(over: Partial<NoticeDto> = {}): NoticeDto {
  return {
    level: "warning",
    code: "audit-outbox",
    message: "审计日志暂存本机，NAS 恢复后会自动补写。",
    occurredAt: "2026-08-24T10:00:00+08:00",
    ...over,
  };
}

function send(dto: NoticeDto) {
  act(() => emit?.(dto));
}

describe("通知中心", () => {
  it("铃铛常驻，收到通知后亮未读计数", async () => {
    render(<App preloaded={preloaded} />);
    expect(screen.getByTestId("notice-bell")).toBeDefined();
    expect(screen.queryByTestId("notice-unread")).toBeNull();

    send(notice());
    await waitFor(() =>
      expect(screen.getByTestId("notice-unread").textContent).toBe("1"),
    );
  });

  it("同 code 连续重复折叠为一条并计数 ×N，不刷屏", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    send(notice());
    send(notice());
    send(notice());

    // 即时呈现区只有一条
    await waitFor(() =>
      expect(screen.getAllByTestId(/^notice-toast-(warning|error)$/)).toHaveLength(1),
    );
    expect(screen.getByText("×3")).toBeDefined();

    await user.click(screen.getByTestId("notice-bell"));
    const items = screen.getAllByTestId("notice-item");
    expect(items).toHaveLength(1);
    expect(within(items[0]).getByTestId("notice-count").textContent).toBe("×3");
  });

  it("不同 code 各自成条，不会被折叠到一起", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    send(notice({ code: "audit-outbox" }));
    send(notice({ code: "project-meta-corrupt", message: "项目元数据损坏被跳过" }));

    await user.click(screen.getByTestId("notice-bell"));
    const items = screen.getAllByTestId("notice-item");
    expect(items).toHaveLength(2);
    expect(items.map((el) => el.getAttribute("data-code"))).toEqual([
      "project-meta-corrupt",
      "audit-outbox",
    ]);
  });

  it("error 用 role=alert，warning 用 aria-live=polite", async () => {
    render(<App preloaded={preloaded} />);

    send(notice({ level: "warning" }));
    const warn = await screen.findByTestId("notice-toast-warning");
    expect(warn.getAttribute("aria-live")).toBe("polite");
    expect(warn.getAttribute("role")).toBe("status");

    send(notice({ level: "error", code: "audit-lost", message: "审计链存在缺口" }));
    const err = await screen.findByTestId("notice-toast-error");
    expect(err.getAttribute("role")).toBe("alert");
  });

  it("error 不自动消失，warning 数秒后自动收进铃铛", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App preloaded={preloaded} />);

    send(notice({ level: "error", code: "audit-lost", message: "审计链存在缺口" }));
    expect(screen.getByTestId("notice-toast-error")).toBeDefined();

    // 远超 warning 的自动收起窗口，error 仍在
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    expect(screen.getByTestId("notice-toast-error")).toBeDefined();

    // warning 则会自己收起来（仍留在铃铛里）
    send(notice({ level: "warning", code: "audit-outbox" }));
    expect(screen.getByTestId("notice-toast-warning")).toBeDefined();
    await act(async () => {
      vi.advanceTimersByTime(7000);
    });
    expect(screen.queryByTestId("notice-toast-warning")).toBeNull();
    expect(screen.getByTestId("notice-toast-error")).toBeDefined();
  });

  it("error 手动确认后从即时区收起，但历史仍可在铃铛里查到", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    send(notice({ level: "error", code: "audit-lost", message: "审计链存在缺口" }));
    await screen.findByTestId("notice-toast-error");

    await user.click(screen.getByTestId("notice-toast-ack"));
    expect(screen.queryByTestId("notice-toast-error")).toBeNull();

    await user.click(screen.getByTestId("notice-bell"));
    expect(screen.getByTestId("notice-item").getAttribute("data-code")).toBe(
      "audit-lost",
    );
  });

  it("未知 code 也能通用呈现（不做白名单）", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    send(
      notice({
        level: "error",
        code: "some-future-code-2027",
        message: "未来才会出现的降级",
      }),
    );

    const toast = await screen.findByTestId("notice-toast-error");
    expect(toast.textContent).toContain("未来才会出现的降级");
    // 抬头有通用回落，机器码原样以等宽字体展示
    expect(toast.textContent).toContain("发生错误");
    expect(toast.textContent).toContain("some-future-code-2027");

    await user.click(screen.getByTestId("notice-bell"));
    expect(screen.getByTestId("notice-item").getAttribute("data-code")).toBe(
      "some-future-code-2027",
    );
  });

  it("打开面板即视为已读，未读计数清零", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    send(notice());
    await waitFor(() => expect(screen.getByTestId("notice-unread")).toBeDefined());

    await user.click(screen.getByTestId("notice-bell"));
    expect(screen.queryByTestId("notice-unread")).toBeNull();
  });

  it("可逐条清除与全部清除", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    send(notice({ code: "audit-outbox" }));
    send(notice({ code: "rebuild-scan-failed", message: "启动重建扫描降级" }));
    await user.click(screen.getByTestId("notice-bell"));
    expect(screen.getAllByTestId("notice-item")).toHaveLength(2);

    await user.click(screen.getAllByTestId("notice-dismiss")[0]);
    expect(screen.getAllByTestId("notice-item")).toHaveLength(1);

    await user.click(screen.getByTestId("notice-clear-all"));
    expect(screen.queryAllByTestId("notice-item")).toHaveLength(0);
    expect(screen.getByText("暂无通知。")).toBeDefined();
  });

  it("未确认 error 的逐条清除按钮禁用（提示先确认）", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    send(notice({ level: "error", code: "audit-lost", message: "审计链缺口" }));
    await user.click(screen.getByTestId("notice-bell"));

    const dismiss = screen.getByTestId("notice-dismiss") as HTMLButtonElement;
    expect(dismiss.disabled).toBe(true);
    expect(dismiss.title).toBe("先确认");

    // 确认之后才允许清除
    await user.click(screen.getByTestId("notice-ack"));
    expect((screen.getByTestId("notice-dismiss") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("「清除已读」不会抹掉未确认的 error", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    send(notice({ level: "warning", code: "audit-outbox" }));
    send(notice({ level: "error", code: "audit-lost", message: "审计链缺口" }));
    send(notice({ level: "info", code: "update-ready", message: "更新就绪" }));

    await user.click(screen.getByTestId("notice-bell"));
    expect(screen.getAllByTestId("notice-item")).toHaveLength(3);
    expect(screen.getByTestId("notice-clear-all").textContent).toBe("清除已读");

    await user.click(screen.getByTestId("notice-clear-all"));

    // warning / info 被清掉，未确认的 error 留下且徽标仍红
    const items = screen.getAllByTestId("notice-item");
    expect(items).toHaveLength(1);
    expect(items[0].getAttribute("data-code")).toBe("audit-lost");
    expect(screen.getByTestId("notice-unread").textContent).toBe("1");

    // 确认后再清就清得掉了
    await user.click(screen.getByTestId("notice-ack"));
    await user.click(screen.getByTestId("notice-clear-all"));
    expect(screen.queryAllByTestId("notice-item")).toHaveLength(0);
  });

  it("铃铛在其他屏幕同样可达", async () => {
    const user = userEvent.setup();
    render(<App preloaded={{ ...preloaded, route: "devices" }} />);
    expect(screen.getByTestId("notice-bell")).toBeDefined();

    send(notice());
    await user.click(screen.getByTestId("notice-bell"));
    expect(screen.getByTestId("notice-item")).toBeDefined();
  });

  it("info 级别：蓝点、行为同 warning（自动收起、aria-live polite）", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App preloaded={preloaded} />);

    send(
      notice({
        level: "info",
        code: "update-ready",
        message: "已在后台更新到 v0.2.0，重启生效",
      }),
    );

    const toast = await screen.findByTestId("notice-toast-info");
    expect(toast.getAttribute("aria-live")).toBe("polite");
    expect(toast.getAttribute("role")).toBe("status");
    expect(toast.textContent).toContain("更新已就绪");

    // 与 warning 一致：数秒后自动收起，历史仍在铃铛
    await act(async () => {
      vi.advanceTimersByTime(7000);
    });
    expect(screen.queryByTestId("notice-toast-info")).toBeNull();
  });

  it("打开面板不会替 error 代为确认，徽标继续红", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    send(notice({ level: "warning", code: "audit-outbox" }));
    send(notice({ level: "error", code: "audit-lost", message: "审计链存在缺口" }));
    await waitFor(() => expect(screen.getByTestId("notice-unread")).toBeDefined());

    await user.click(screen.getByTestId("notice-bell"));

    // warning 被置已读，error 仍未确认 → 徽标还在，且是红的
    const badge = screen.getByTestId("notice-unread");
    expect(badge.textContent).toBe("1");
    expect(badge.className).toContain("notice-bell__badge--error");
    // error 条目上有独立的「确认」按钮
    expect(screen.getByTestId("notice-ack")).toBeDefined();
  });

  it("逐条确认 error 后徽标恢复", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    send(notice({ level: "error", code: "audit-lost", message: "审计链存在缺口" }));
    await waitFor(() => expect(screen.getByTestId("notice-unread")).toBeDefined());

    await user.click(screen.getByTestId("notice-bell"));
    await user.click(screen.getByTestId("notice-ack"));

    expect(screen.queryByTestId("notice-unread")).toBeNull();
    // 确认后按钮消失，历史条目仍在
    expect(screen.queryByTestId("notice-ack")).toBeNull();
    expect(screen.getByTestId("notice-item")).toBeDefined();
  });

  it("多条 error 必须各自确认，确认一条不影响另一条", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    send(notice({ level: "error", code: "audit-lost", message: "审计链缺口" }));
    send(notice({ level: "error", code: "project-meta-corrupt", message: "元数据损坏" }));

    await user.click(screen.getByTestId("notice-bell"));
    expect(screen.getAllByTestId("notice-ack")).toHaveLength(2);

    await user.click(screen.getAllByTestId("notice-ack")[0]);
    expect(screen.getAllByTestId("notice-ack")).toHaveLength(1);
    expect(screen.getByTestId("notice-unread").textContent).toBe("1");
  });

  it("启动回放：订阅前积压的通知补进铃铛，不弹 toast，error 仍需确认", async () => {
    const listSpy = vi.spyOn(api, "listNotices").mockResolvedValue([
      notice({
        level: "warning",
        code: "rebuild-scan-failed",
        message: "启动重建扫描降级",
        occurredAt: "2026-08-24T09:00:00+08:00",
      }),
      notice({
        level: "error",
        code: "audit-lost",
        message: "审计链存在缺口",
        occurredAt: "2026-08-24T09:00:01+08:00",
      }),
    ]);

    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    await waitFor(() => expect(screen.getByTestId("notice-unread")).toBeDefined());
    // 回放不弹即时横幅
    expect(screen.queryByTestId("notice-toasts")).toBeNull();

    await user.click(screen.getByTestId("notice-bell"));
    const items = screen.getAllByTestId("notice-item");
    expect(items).toHaveLength(2);
    // 时间倒序
    expect(items[0].getAttribute("data-code")).toBe("audit-lost");
    // 回放来的 error 同样要逐条确认
    expect(screen.getByTestId("notice-ack")).toBeDefined();

    listSpy.mockRestore();
  });

  it("回放与实时重复的同一条（code + occurredAt 相同）只保留一条", async () => {
    const dup = notice({
      code: "audit-outbox",
      occurredAt: "2026-08-24T09:30:00+08:00",
    });
    const listSpy = vi.spyOn(api, "listNotices").mockResolvedValue([dup]);

    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    // 实时先收到同一条
    send(dup);
    await waitFor(() => expect(screen.getByTestId("notice-unread")).toBeDefined());

    await user.click(screen.getByTestId("notice-bell"));
    const items = screen.getAllByTestId("notice-item");
    expect(items).toHaveLength(1);
    expect(within(items[0]).queryByTestId("notice-count")).toBeNull();

    listSpy.mockRestore();
  });

  it("回放本身失败也要说出来", async () => {
    const listSpy = vi
      .spyOn(api, "listNotices")
      .mockRejectedValue(new Error("backlog unavailable"));

    render(<App preloaded={preloaded} />);

    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-code")).toBe("notice-replay-failed");
    expect(alert.textContent).toContain("backlog unavailable");

    listSpy.mockRestore();
  });

  it("回放严格等到监听注册完成之后才发起", async () => {
    // 用一个手动控制的 ready，模拟 listen() 尚未 resolve 的窗口
    let markReady: (() => void) | null = null;
    subSpy.mockImplementation((onNotice: (n: NoticeDto) => void) => {
      emit = onNotice;
      return {
        dispose: () => {},
        ready: new Promise<void>((resolve) => {
          markReady = resolve;
        }),
      };
    });

    const listSpy = vi
      .spyOn(api, "listNotices")
      .mockResolvedValue([
        notice({ code: "audit-outbox", occurredAt: "2026-08-24T09:00:00+08:00" }),
      ]);

    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    // 监听还没注册完，绝不能提前取积压——否则中间窗口的通知两头都收不到
    await act(async () => {
      await Promise.resolve();
    });
    expect(listSpy).not.toHaveBeenCalled();

    // 注册完成后才发起回放
    await act(async () => {
      markReady?.();
    });
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(1));

    await user.click(screen.getByTestId("notice-bell"));
    expect(screen.getByTestId("notice-item").getAttribute("data-code")).toBe(
      "audit-outbox",
    );

    listSpy.mockRestore();
  });

  it("监听注册失败时仍会补取积压（失败本身另行报错）", async () => {
    subSpy.mockImplementation(
      (onNotice: (n: NoticeDto) => void, onError?: (e: unknown) => void) => {
        emit = onNotice;
        const err = new Error("listen refused");
        onError?.(err);
        return { dispose: () => {}, ready: Promise.reject(err) };
      },
    );
    const listSpy = vi
      .spyOn(api, "listNotices")
      .mockResolvedValue([notice({ code: "audit-outbox" })]);

    render(<App preloaded={preloaded} />);

    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(1));
    listSpy.mockRestore();
  });

  it("通知通道本身建不起来也要说出来", async () => {
    subSpy.mockImplementation(
      (_onNotice: (n: NoticeDto) => void, onError?: (e: unknown) => void) => {
        const err = new Error("channel refused");
        onError?.(err);
        return { dispose: () => {}, ready: Promise.reject(err) };
      },
    );

    render(<App preloaded={preloaded} />);

    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-code")).toBe("notice-listen-failed");
    expect(alert.textContent).toContain("channel refused");
  });
});
