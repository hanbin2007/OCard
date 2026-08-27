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
  route: "copy" as const,
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

    await user.click(screen.getByRole("button", { name: /打开转码：年中发布会/ }));
    // 跳到转码屏,且当前项目切成年中发布会
    expect(screen.getByTestId("current-project-chip").textContent).toContain(
      "年中发布会",
    );
    expect(screen.getByText("整项目转代理")).toBeDefined();
    // 面板已收起
    expect(screen.queryByTestId("task-center-panel")).toBeNull();
  });

  it("作业行可取消:快照落地(revision 前进),行迁移到历史「已取消」", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "cancelJob").mockResolvedValue({
      ...runningJob,
      state: "cancelled",
      // revision 必须前进:相同序号会被 reducer 乱序闸丢弃——
      // 之前这里用旧序号,把 dispatch 删掉测试都还绿(评审点名的假绿)
      revision: runningJob.revision + 1,
      finishedAt: "2026-08-26T10:05:00+08:00",
    });
    render(<App preloaded={preloaded} />);
    await user.click(screen.getByTestId("task-center-toggle"));
    await user.click(screen.getByTestId("task-cancel"));

    await waitFor(() => expect(spy).toHaveBeenCalledWith(runningJob.id));
    // 行从进行中消失,出现在历史区并标「已取消」
    await waitFor(() => {
      const panel = screen.getByTestId("task-center-panel");
      expect(panel.querySelectorAll('[data-testid="task-cancel"]')).toHaveLength(0);
      expect(panel.textContent).toContain("已取消");
    });
  });

  it("拷卡行可挂起,刷新快照后挂起态显示「继续」", async () => {
    const user = userEvent.setup();
    const running = mockCopyTasks.find((t) => t.state === "running")!;
    const pause = vi.spyOn(api, "pauseCopyTask").mockResolvedValue(undefined);
    const refetch = vi
      .spyOn(api, "getCopyTask")
      .mockResolvedValue({ ...running, state: "paused" });
    render(<App preloaded={preloaded} />);
    await user.click(screen.getByTestId("task-center-toggle"));

    await user.click(screen.getAllByTestId("task-pause")[0]);
    await waitFor(() => expect(pause).toHaveBeenCalledWith(running.id));
    // refreshTask 读回 paused 快照 → 行内按钮变「继续」
    await waitFor(() =>
      expect(screen.getAllByTestId("task-resume").length).toBeGreaterThan(0),
    );
    refetch.mockRestore();
  });

  it("交付打包进行中任务行跳转不再禁用(评审 4.3):导航放行", async () => {
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
      name: /打开转码：年中发布会/,
    }) as HTMLButtonElement;
    expect(row.disabled).toBe(false);
    // 取消打包仍然可用
    const cancels = screen.getAllByTestId("task-cancel") as HTMLButtonElement[];
    expect(cancels.some((b) => !b.disabled)).toBe(true);
  });


  it("历史按真实时刻排序:+08:00 与 Z 混排不乱序", async () => {
    const user = userEvent.setup();
    // doneJob 是 delivery 判别分支,直接展开会把 result 类型一起带过来
    const { result: _r, ...doneBase } = doneJob;
    const older: JobSnapshot = {
      ...doneBase,
      id: "job-older",
      kind: "analyze",
      // 字符串序比 Z 格式大、真实时刻却更早(03:00Z)
      finishedAt: "2026-08-25T11:00:00+08:00",
    };
    const newer: JobSnapshot = {
      ...doneBase,
      id: "job-newer",
      kind: "transcode",
      finishedAt: "2026-08-25T09:30:00.000Z",
    };
    render(<App preloaded={{ ...preloaded, jobs: [older, newer], tasks: [] }} />);
    await user.click(screen.getByTestId("task-center-toggle"));

    const items = screen.getAllByTestId("task-history-item");
    // 09:30Z(17:30+08:00)比 11:00+08:00(03:00Z)晚,应排最前
    expect(items[0].textContent).toContain("转码");
    expect(items[1].textContent).toContain("AI 分析");
  });

  it("目标项目正在交付时,跳转改道去分类屏(不落进被锁的错误页面)", async () => {
    const user = userEvent.setup();
    // 当前项目是校运会,年中发布会同时有交付 + 转码在跑
    const deliveringElsewhere: JobSnapshot = {
      ...doneJob,
      id: "job-d-other",
      projectId: mockProjects[1].id,
      state: "running",
      finishedAt: undefined,
    };
    render(
      <App
        preloaded={{ ...preloaded, jobs: [deliveringElsewhere, runningJob] }}
      />,
    );
    await user.click(screen.getByTestId("task-center-toggle"));
    // 点的是转码行,但目标项目在交付:直接进转码屏会被侧栏锁困住,
    // 必须改道到交付面板所在的分类屏
    await user.click(screen.getByRole("button", { name: /打开转码：年中发布会/ }));
    expect(screen.getByTestId("current-project-chip").textContent).toContain(
      "年中发布会",
    );
    expect(screen.getByTestId("sorting-categories")).toBeDefined();
  });

  it("历史行可点击,跳到对应项目对应屏", async () => {
    const user = userEvent.setup();
    render(<App preloaded={{ ...preloaded, jobs: [doneJob], tasks: [] }} />);
    await user.click(screen.getByTestId("task-center-toggle"));

    await user.click(
      screen.getByRole("button", { name: /打开历史记录：交付打包 · 校运会/ }),
    );
    // 交付历史 → 分类屏(交付入口所在地),面板收起
    expect(screen.getByTestId("sorting-categories")).toBeDefined();
    expect(screen.queryByTestId("task-center-panel")).toBeNull();
  });

  it("历史区最多 8 条", async () => {
    const user = userEvent.setup();
    const many: JobSnapshot[] = Array.from({ length: 10 }, (_, i) => ({
      ...doneJob,
      id: `job-hist-${i}`,
      finishedAt: `2026-08-25T1${i % 10}:00:00+08:00`,
    }));
    render(<App preloaded={{ ...preloaded, jobs: many, tasks: [] }} />);
    await user.click(screen.getByTestId("task-center-toggle"));
    expect(screen.getAllByTestId("task-history-item")).toHaveLength(8);
  });
});
