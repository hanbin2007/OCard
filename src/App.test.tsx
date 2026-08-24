/** 外壳：加载态、NAS 断连的错误态与重试、地标结构。 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as api from "./api";
import { mockCopyTasks } from "./api/mock";
import type { CopyProgressEvent, CopyTask } from "./api/types";
import { mockProjects, mockWorkstation } from "./api/mock";

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

  it("孤儿任务拉取失败后，新事件到来会再次重试", async () => {
    let emit: ((event: CopyProgressEvent) => void) | null = null;
    const subSpy = vi
      .spyOn(api, "subscribeCopyProgress")
      .mockImplementation((onEvent) => {
        emit = onEvent;
        return () => {};
      });

    const orphan: CopyTask = { ...mockCopyTasks[0], id: "t-orphan" };
    const getSpy = vi
      .spyOn(api, "getCopyTask")
      .mockRejectedValueOnce(new Error("NAS 抖动"))
      .mockResolvedValue(orphan);

    render(<App preloaded={{ route: "copy", workstation: mockWorkstation }} />);

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

    // 第一条事件触发拉取，但后端失败
    act(() => emit?.(event(1)));
    await waitFor(() => expect(getSpy).toHaveBeenCalledTimes(1));

    // 第二条事件（新 revision）必须再次触发拉取，而不是永远卡住
    act(() => emit?.(event(2)));
    await waitFor(() => expect(getSpy).toHaveBeenCalledTimes(2));

    getSpy.mockRestore();
    subSpy.mockRestore();
  });

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
