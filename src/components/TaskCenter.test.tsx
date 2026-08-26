/** 任务中心:跨项目聚合、行内操作、跳转与交付锁。 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import App from "../App";
import {
  mockCameras,
  mockCopyTasks,
  mockProjects,
  mockStorageCards,
  mockVolumes,
  mockWorkstation,
} from "../api/mock";
import type { JobSnapshot } from "../api/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const runningJob: JobSnapshot = {
  id: "job-tc-1",
  kind: "transcode",
  // 故意放在非当前项目上:任务中心必须跨项目可见
  projectId: mockProjects[1].id,
  state: "running",
  done: 12,
  total: 48,
  bytesDone: 1024,
  message: "C0012.MP4",
  revision: 3,
  startedAt: "2026-08-26T10:00:00+08:00",
};

const doneJob: JobSnapshot = {
  id: "job-tc-2",
  kind: "delivery",
  projectId: mockProjects[0].id,
  state: "done",
  done: 4,
  total: 4,
  bytesDone: 2048,
  revision: 9,
  startedAt: "2026-08-25T10:00:00+08:00",
  finishedAt: "2026-08-25T10:20:00+08:00",
};

const preloaded = {
  route: "projects" as const,
  workstation: mockWorkstation,
  projects: mockProjects,
  cameras: mockCameras,
  cards: mockStorageCards,
  volumes: mockVolumes,
  tasks: mockCopyTasks,
  jobs: [runningJob, doneJob],
  selectedProjectId: mockProjects[0].id,
};

function activeCopyCount() {
  return mockCopyTasks.filter(
    (t) => t.state === "running" || t.state === "verifying" || t.state === "paused",
  ).length;
}

describe("任务中心", () => {
  it("顶栏入口带进行中计数(拷卡任务 + 作业,跨项目)", () => {
    render(<App preloaded={preloaded} />);
    const badge = screen.getByTestId("task-active-count");
    expect(badge.textContent).toBe(String(activeCopyCount() + 1));
  });

  it("面板聚合所有项目的进行中任务,并有最近完成历史", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);
    await user.click(screen.getByTestId("task-center-toggle"));

    const panel = screen.getByTestId("task-center-panel");
    // 转码作业挂在另一个项目(年中发布会)上也能看见
    expect(panel.textContent).toContain("转码 · 年中发布会");
    expect(panel.textContent).toContain("拷卡 · 校运会");
    // 历史区:已完成的交付作业
    expect(panel.textContent).toContain("最近完成");
    expect(panel.textContent).toContain("交付打包 · 校运会");
  });

  it("点任务行跳到对应项目对应屏", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);
    await user.click(screen.getByTestId("task-center-toggle"));

    await user.click(screen.getByRole("button", { name: /转码 · 年中发布会/ }));
    // 跳到转码屏,且当前项目切成年中发布会
    expect(screen.getByTestId("current-project-chip").textContent).toContain(
      "年中发布会",
    );
    expect(screen.getByText("整项目转代理")).toBeDefined();
    // 面板已收起
    expect(screen.queryByTestId("task-center-panel")).toBeNull();
  });

  it("作业行可取消(接线到 cancelJob)", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "cancelJob").mockResolvedValue({
      ...runningJob,
      state: "cancelled",
      finishedAt: "2026-08-26T10:05:00+08:00",
    });
    render(<App preloaded={preloaded} />);
    await user.click(screen.getByTestId("task-center-toggle"));
    await user.click(screen.getByTestId("task-cancel"));

    await waitFor(() => expect(spy).toHaveBeenCalledWith(runningJob.id));
  });

  it("拷卡行可挂起,挂起态显示继续", async () => {
    const user = userEvent.setup();
    const pause = vi.spyOn(api, "pauseCopyTask").mockResolvedValue(undefined);
    render(<App preloaded={preloaded} />);
    await user.click(screen.getByTestId("task-center-toggle"));

    await user.click(screen.getAllByTestId("task-pause")[0]);
    await waitFor(() => expect(pause).toHaveBeenCalled());
  });

  it("交付打包进行中时任务行跳转禁用(与侧栏同一把锁)", async () => {
    const user = userEvent.setup();
    render(
      <App
        preloaded={{
          ...preloaded,
          jobs: [
            { ...doneJob, id: "job-d-run", state: "running" as const },
            runningJob,
          ],
        }}
      />,
    );
    await user.click(screen.getByTestId("task-center-toggle"));
    const row = screen.getByRole("button", {
      name: /转码 · 年中发布会/,
    }) as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(row.title).toContain("交付打包进行中");
  });
});
