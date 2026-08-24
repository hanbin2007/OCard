/** 外壳：加载态、NAS 断连的错误态与重试、地标结构。 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as api from "./api";
import { mockCopyTasks, mockProjects, mockWorkstation } from "./api/mock";
import type { CopyProgressEvent, CopyTask } from "./api/types";

afterEach(cleanup);

describe("进度监听（常驻单一 listener）", () => {
  it("没有进行中任务时也建立监听——否则 resume/retry 后界面死寂", () => {
    const spy = vi.spyOn(api, "subscribeCopyProgress");
    const idle = mockCopyTasks.map((t) => ({ ...t, state: "paused" as const }));

    render(<App preloaded={{ route: "copy", tasks: idle, workstation: mockWorkstation }} />);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(typeof spy.mock.calls[0][0]).toBe("function");
    spy.mockRestore();
  });

  it("任务全部处于终态时同样保持监听", () => {
    const spy = vi.spyOn(api, "subscribeCopyProgress");
    const done = mockCopyTasks.map((t) => ({ ...t, state: "done" as const }));

    render(<App preloaded={{ route: "copy", tasks: done, workstation: mockWorkstation }} />);

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("监听建立失败时给出可见提示，而不是静静地不动", async () => {
    const spy = vi
      .spyOn(api, "subscribeCopyProgress")
      .mockImplementation((_onEvent, onError) => {
        onError?.(new Error("event channel closed"));
        return () => {};
      });

    render(<App preloaded={{ route: "projects", workstation: mockWorkstation }} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("进度监听未能建立");
    expect(alert.textContent).toContain("event channel closed");
    spy.mockRestore();
  });

  it("同一孤儿的新事件不会叠加重叠请求，失败后仍由退避链补上", async () => {
    let emit: ((event: CopyProgressEvent) => void) | null = null;
    const subSpy = vi
      .spyOn(api, "subscribeCopyProgress")
      .mockImplementation((onEvent) => {
        emit = onEvent;
        return () => {};
      });

    const orphan: CopyTask = {
      ...mockCopyTasks[0],
      id: "t-orphan",
      projectId: mockProjects[0].id,
      volumeName: "RETRY_CARD",
    };
    const getSpy = vi
      .spyOn(api, "getCopyTask")
      .mockRejectedValueOnce(new Error("NAS 抖动"))
      .mockResolvedValue(orphan);

    render(
      <App
        preloaded={{
          route: "copy",
          workstation: mockWorkstation,
          projects: mockProjects,
          selectedProjectId: mockProjects[0].id,
          tasks: [],
        }}
      />,
    );

    const event = (revision: number): CopyProgressEvent => ({
      taskId: "t-orphan",
      revision,
      occurredAt: new Date().toISOString(),
      copiedBytes: revision * 10,
      speedBytesPerSec: 10,
      state: "running",
      changedFiles: [],
      changedDestinations: [],
    });

    act(() => emit?.(event(1)));
    await waitFor(() => expect(getSpy).toHaveBeenCalledTimes(1));

    // 同一孤儿的后续事件不得再开一个并发请求（已排了退避重试）
    act(() => emit?.(event(2)));
    act(() => emit?.(event(3)));
    expect(getSpy).toHaveBeenCalledTimes(1);

    // 退避链自己把它补上
    await waitFor(() => expect(screen.getByText("RETRY_CARD")).toBeDefined(), {
      timeout: 6000,
    });
    expect(getSpy).toHaveBeenCalledTimes(2);

    getSpy.mockRestore();
    subSpy.mockRestore();
  }, 10000);

  it("终态孤儿：唯一一条事件 + 首次拉取失败，退避后自动重试入列（不投第二条事件）", async () => {
    let emit: ((event: CopyProgressEvent) => void) | null = null;
    const subSpy = vi
      .spyOn(api, "subscribeCopyProgress")
      .mockImplementation((onEvent) => {
        emit = onEvent;
        return () => {};
      });

    const terminal: CopyTask = {
      ...mockCopyTasks[0],
      id: "t-terminal",
      projectId: mockProjects[0].id,
      volumeName: "ORPHAN_CARD",
      state: "done",
    };
    const getSpy = vi
      .spyOn(api, "getCopyTask")
      .mockRejectedValueOnce(new Error("NAS 抖动"))
      .mockResolvedValue(terminal);

    render(
      <App
        preloaded={{
          route: "copy",
          workstation: mockWorkstation,
          projects: mockProjects,
          selectedProjectId: mockProjects[0].id,
          tasks: [],
        }}
      />,
    );

    // 只投一条终态事件：之后不会再有任何事件来驱动重试
    act(() =>
      emit?.({
        taskId: "t-terminal",
        revision: 1,
        occurredAt: new Date().toISOString(),
        copiedBytes: 100,
        speedBytesPerSec: 0,
        state: "done",
        changedFiles: [],
        changedDestinations: [],
      }),
    );

    await waitFor(() => expect(getSpy).toHaveBeenCalledTimes(1));

    // 退避定时器（2s）自行重试，任务最终进入列表
    await waitFor(() => expect(screen.getByText("ORPHAN_CARD")).toBeDefined(), {
      timeout: 6000,
    });
    expect(getSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    getSpy.mockRestore();
    subSpy.mockRestore();
  }, 10000);

  it("慢响应（超过首个退避窗口）不被自己的重试机制丢弃，也不叠加请求", async () => {
    let emit: ((event: CopyProgressEvent) => void) | null = null;
    const subSpy = vi
      .spyOn(api, "subscribeCopyProgress")
      .mockImplementation((onEvent) => {
        emit = onEvent;
        return () => {};
      });

    const slow: CopyTask = {
      ...mockCopyTasks[0],
      id: "t-slow",
      projectId: mockProjects[0].id,
      volumeName: "SLOW_CARD",
      state: "done",
    };
    // 响应耗时 3s > 首个退避窗口 2s：旧的固定节拍实现会把它当过期丢掉
    const getSpy = vi
      .spyOn(api, "getCopyTask")
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(slow), 3000)),
      );

    render(
      <App
        preloaded={{
          route: "copy",
          workstation: mockWorkstation,
          projects: mockProjects,
          selectedProjectId: mockProjects[0].id,
          tasks: [],
        }}
      />,
    );

    act(() =>
      emit?.({
        taskId: "t-slow",
        revision: 1,
        occurredAt: new Date().toISOString(),
        copiedBytes: 100,
        speedBytesPerSec: 0,
        state: "done",
        changedFiles: [],
        changedDestinations: [],
      }),
    );

    // 慢响应最终仍被消费，任务入列
    await waitFor(() => expect(screen.getByText("SLOW_CARD")).toBeDefined(), {
      timeout: 9000,
    });
    // 全程只有 1 次请求：绝不因为退避窗口到点就再打一发
    expect(getSpy).toHaveBeenCalledTimes(1);

    getSpy.mockRestore();
    subSpy.mockRestore();
  }, 15000);

  it("卸载时退订，不留悬空监听", () => {
    const dispose = vi.fn();
    const spy = vi.spyOn(api, "subscribeCopyProgress").mockReturnValue(dispose);

    const view = render(
      <App preloaded={{ route: "projects", workstation: mockWorkstation }} />,
    );
    view.unmount();

    expect(dispose).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("应用外壳", () => {
  it("有唯一的 main 地标与侧栏导航", () => {
    render(<App preloaded={{ route: "projects", projects: mockProjects }} />);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeDefined();
  });

  it("首屏先显示加载态，再进入项目列表", async () => {
    render(<App />);
    expect(screen.getByRole("status").textContent).toContain("正在读取");
    expect((await screen.findAllByText("20260824_校运会")).length).toBeGreaterThan(0);
  });

  it("NAS 读取失败时给出错误与重试，而不是永久卡在加载态", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, "listProjects")
      .mockRejectedValueOnce(new Error("NAS 未挂载：/Volumes/DIT-NAS 不可达"));

    render(<App />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("NAS 未挂载");
    expect(screen.getByRole("button", { name: "重试" })).toBeDefined();

    // 重试走通后回到正常界面
    spy.mockRestore();
    await user.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "重试" })).toBeNull(),
    );
    expect((await screen.findAllByText("20260824_校运会")).length).toBeGreaterThan(0);
  });

  it("侧栏可在四屏之间切换", async () => {
    const user = userEvent.setup();
    render(
      <App
        preloaded={{
          route: "projects",
          workstation: mockWorkstation,
          projects: mockProjects,
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: /设备登记/ }));
    expect(screen.getByRole("button", { name: "登记相机" })).toBeDefined();

    await user.click(screen.getByRole("button", { name: /新建项目/ }));
    expect(screen.getByText("将创建")).toBeDefined();
  });
});
