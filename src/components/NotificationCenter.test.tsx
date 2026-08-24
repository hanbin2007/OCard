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
    return () => {};
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

  it("铃铛在其他屏幕同样可达", async () => {
    const user = userEvent.setup();
    render(<App preloaded={{ ...preloaded, route: "devices" }} />);
    expect(screen.getByTestId("notice-bell")).toBeDefined();

    send(notice());
    await user.click(screen.getByTestId("notice-bell"));
    expect(screen.getByTestId("notice-item")).toBeDefined();
  });

  it("通知通道本身建不起来也要说出来", async () => {
    subSpy.mockImplementation(
      (_onNotice: (n: NoticeDto) => void, onError?: (e: unknown) => void) => {
        onError?.(new Error("channel refused"));
        return () => {};
      },
    );

    render(<App preloaded={preloaded} />);

    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-code")).toBe("notice-listen-failed");
    expect(alert.textContent).toContain("channel refused");
  });
});
