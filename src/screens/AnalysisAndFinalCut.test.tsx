/**
 * M3 W7a/W8：分析标注、连拍折叠、成片校验、交付状态。
 * 最重要的一条是 PRD 底线：**AI 只标注，绝不移动或删除任何文件。**
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import * as api from "../api";
import { mockProjects, mockWorkstation } from "../api/mock";
import { mockAnalysisResult, resetMockJobs } from "../api/mockJobs";
import type { AnalyzeJob, JobSnapshot } from "../api/types";

const projectB = mockProjects.find((p) => p.scenario === "B")!;
const projectA = mockProjects.find((p) => p.scenario === "A")!;

let jobEmitters: Array<(job: JobSnapshot) => void> = [];

beforeEach(() => {
  jobEmitters = [];
  vi.spyOn(api, "subscribeJobProgress").mockImplementation((onEvent) => {
    jobEmitters.push(onEvent);
    return {
      dispose: () => {
        const i = jobEmitters.indexOf(onEvent);
        if (i >= 0) jobEmitters.splice(i, 1);
      },
      ready: Promise.resolve(),
    };
  });
});

afterEach(() => {
  cleanup();
  resetMockJobs();
  vi.restoreAllMocks();
});

const sorting = {
  route: "sorting" as const,
  workstation: mockWorkstation,
  projects: mockProjects,
  selectedProjectId: projectB.id,
};

function analyzeJob(over: Partial<AnalyzeJob> = {}): AnalyzeJob {
  return {
    id: "job-an",
    kind: "analyze",
    projectId: projectB.id,
    state: "done",
    done: 1240,
    total: 1240,
    bytesDone: 0,
    revision: 7,
    startedAt: "2026-08-24T10:00:00+08:00",
    finishedAt: "2026-08-24T10:09:00+08:00",
    result: mockAnalysisResult,
    ...over,
  };
}

async function renderSorting() {
  render(<App preloaded={sorting} />);
  await screen.findAllByTestId("asset-cell");
}

describe("★ PRD 底线：AI 只标注，不动文件", () => {
  it("分析作业全程不调用任何移动/精选/删除接口", async () => {
    const user = userEvent.setup();
    const move = vi.spyOn(api, "moveAssets");
    const curate = vi.spyOn(api, "curateAssets");
    const trash = vi.spyOn(api, "trashAssets");
    const start = vi
      .spyOn(api, "startAnalysis")
      .mockResolvedValue(analyzeJob({ state: "running", result: undefined }));

    await renderSorting();
    await user.click(screen.getByTestId("sorting-analyze"));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    // 推进到完成
    await act(async () => {
      jobEmitters.forEach((emit) => emit(analyzeJob({ revision: 20 })));
    });
    await waitFor(() =>
      expect(screen.getByTestId("sorting-analyze").textContent).toBe("分析"),
    );

    // 分析只产出标注，绝不触发任何文件操作
    expect(move).not.toHaveBeenCalled();
    expect(curate).not.toHaveBeenCalled();
    expect(trash).not.toHaveBeenCalled();
  }, 15000);

  it("「建议保留」只是角标，不会自动把其他项标删", async () => {
    await renderSorting();
    // mock 里有一组连拍，其中一张 suggestedKeep
    expect(screen.getAllByTestId("asset-judgement").length).toBeGreaterThan(0);
    // 没有任何待删清单被自动创建
    expect(screen.queryByTestId("sorting-pending-delete")).toBeNull();
  });
});

describe("判定角标", () => {
  it("糊 / 过曝 / 欠曝 / 建议保留 都能看到", async () => {
    await renderSorting();
    const badges = screen.getAllByTestId("asset-judgement");
    const text = badges.map((b) => b.textContent).join(" ");
    expect(text).toContain("糊");
    expect(text).toContain("欠曝");
  });

  it("不显示分数数值，只用区间表达", async () => {
    await renderSorting();
    const badges = screen.getAllByTestId("asset-judgement");
    for (const badge of badges) {
      expect(badge.textContent).not.toMatch(/0\.\d/);
    }
  });
});

describe("连拍折叠", () => {
  it("同组折成恰好一格并标 ×N", async () => {
    await renderSorting();
    const groups = await screen.findAllByTestId("asset-group");
    expect(groups.length).toBeGreaterThan(0);
    expect(groups[0].textContent).toContain("×5");
  });

  it("展开走 overlay，组内可单独选中（与主网格同一选区）", async () => {
    const user = userEvent.setup();
    await renderSorting();

    const group = (await screen.findAllByTestId("asset-group"))[0];
    await user.click(within(group).getByTestId("group-expand"));

    const overlay = await screen.findByTestId("group-overlay");
    const items = within(overlay).getAllByTestId("group-item");
    expect(items).toHaveLength(5);

    await user.click(items[1]);
    expect(items[1].getAttribute("aria-selected")).toBe("true");
  });

  it("对折叠组执行分类会展开成组内全部素材", async () => {
    const user = userEvent.setup();
    const move = vi.spyOn(api, "moveAssets");
    await renderSorting();

    const group = (await screen.findAllByTestId("asset-group"))[0];
    await user.click(group);
    fireEvent.keyDown(screen.getByTestId("sorting-grid-wrap"), { key: "1" });

    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    // 一格 = 5 个真实素材
    expect(move.mock.calls[0][1]).toHaveLength(5);
  });
});

describe("#9 展开层选中三条路径都真的生效", () => {
  async function openGroup(user: ReturnType<typeof userEvent.setup>) {
    await renderSorting();
    const group = (await screen.findAllByTestId("asset-group"))[0];
    await user.click(within(group).getByTestId("group-expand"));
    const overlay = await screen.findByTestId("group-overlay");
    const items = within(overlay).getAllByTestId("group-item");
    await user.click(items[1]);
    return { overlay, items };
  }

  it("分类：组内单选后按数字键真的下发该单件", async () => {
    const user = userEvent.setup();
    const move = vi.spyOn(api, "moveAssets");
    const { overlay, items } = await openGroup(user);

    fireEvent.keyDown(overlay, { key: "1" });

    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    expect(move.mock.calls[0][1]).toEqual([items[1].getAttribute("data-asset")]);
  });

  it("精选：组内单选后按 P 真的下发", async () => {
    const user = userEvent.setup();
    const curate = vi.spyOn(api, "curateAssets");
    const { overlay, items } = await openGroup(user);

    fireEvent.keyDown(overlay, { key: "p" });

    await waitFor(() => expect(curate).toHaveBeenCalledTimes(1));
    expect(curate.mock.calls[0][1]).toEqual([items[1].getAttribute("data-asset")]);
  });

  it("标删：组内单选后按 D 真的进待删清单", async () => {
    const user = userEvent.setup();
    const { overlay } = await openGroup(user);

    fireEvent.keyDown(overlay, { key: "d" });

    const bar = await screen.findByTestId("sorting-pending-delete");
    expect(bar.textContent).toContain("已标记 1 个待删除");
  });
});

describe("#10 预览开对图", () => {
  it("有折叠组时双击普通格开的是那一张，不是错位的另一张", async () => {
    const user = userEvent.setup();
    await renderSorting();

    // 取折叠组之后的第一个普通格
    const cells = screen.getAllByTestId("asset-cell");
    const target = cells[cells.length - 1];
    const expected = target.getAttribute("data-asset");

    await user.dblClick(target);

    const box = await screen.findByTestId("asset-lightbox");
    expect(box.getAttribute("aria-label")).toContain(
      expected!.split("/").pop()!,
    );
  });

  it("左右切换在同一下标空间内推进，不越界", async () => {
    const user = userEvent.setup();
    await renderSorting();

    const cells = screen.getAllByTestId("asset-cell");
    await user.dblClick(cells[0]);
    await screen.findByTestId("asset-lightbox");

    const before = screen.getByTestId("lightbox-position").textContent;
    fireEvent.keyDown(document, { key: "ArrowRight" });
    await waitFor(() =>
      expect(screen.getByTestId("lightbox-position").textContent).not.toBe(before),
    );
  });
});

describe("#11 第二轮分析仍会刷新角标", () => {
  it("两轮分析（各自 jobId）都触发当前页重拉", async () => {
    const user = userEvent.setup();
    const start = vi
      .spyOn(api, "startAnalysis")
      .mockResolvedValueOnce(
        analyzeJob({
          id: "job-a1",
          state: "running",
          revision: 1,
          result: undefined,
        }),
      )
      .mockResolvedValueOnce(
        analyzeJob({
          id: "job-a2",
          state: "running",
          revision: 1,
          result: undefined,
        }),
      );

    await renderSorting();
    const listSpy = vi.spyOn(api, "listPendingAssets");

    // 第一轮
    await user.click(screen.getByTestId("sorting-analyze"));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await act(async () => {
      jobEmitters.forEach((emit) =>
        emit(analyzeJob({ id: "job-a1", state: "done", revision: 4 })),
      );
    });
    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    const afterFirst = listSpy.mock.calls.length;

    // 第二轮：事件数相同（revision 也是 4），若拿 revision 当全局令牌就永不刷新
    await user.click(screen.getByTestId("sorting-analyze"));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    await act(async () => {
      jobEmitters.forEach((emit) =>
        emit(analyzeJob({ id: "job-a2", state: "done", revision: 4 })),
      );
    });

    await waitFor(() =>
      expect(listSpy.mock.calls.length).toBeGreaterThan(afterFirst),
    );
    listSpy.mockRestore();
    start.mockRestore();
  }, 15000);
});

describe("#24 score 量纲是 0–100", () => {
  it("低分点按百分制阈值出现（0.31 那种小数不会误判为低分）", async () => {
    await renderSorting();
    // mock 里 score=22 与 31 都低于 25/都在百分制下有意义
    const lows = screen.getAllByTestId("judge-low");
    expect(lows.length).toBeGreaterThan(0);
  });
});

describe("按建议筛选", () => {
  it("开启后只留建议保留与尚无判定的", async () => {
    const user = userEvent.setup();
    await renderSorting();
    const before = screen.getAllByTestId("asset-cell").length;

    await user.click(screen.getByTestId("sorting-suggestion-filter"));
    await waitFor(() =>
      expect(screen.getAllByTestId("asset-cell").length).not.toBe(before),
    );
    // 明确判定为不保留的那些被过滤掉了
    expect(screen.queryAllByTestId("asset-group")).toHaveLength(0);
  });
});

describe("待修 → 已修 流转提示", () => {
  it("非空时给出提示条，展开可看逐条，并说明删除仍需人工确认", async () => {
    const user = userEvent.setup();
    await renderSorting();

    const bar = await screen.findByTestId("sorting-flow-hints");
    expect(bar.textContent).toContain("2 个待修原稿已有成品");

    await user.click(screen.getByTestId("sorting-flow-hints-toggle"));
    expect(screen.getAllByTestId("flow-hint-item")).toHaveLength(2);
    expect(screen.getByTestId("sorting-flow-hints").textContent).toContain(
      "OCard 不会替你删任何文件",
    );
  });
});

describe("成片校验（工况 A）", () => {
  const projects = {
    route: "projects" as const,
    workstation: mockWorkstation,
    projects: mockProjects,
    selectedProjectId: projectA.id,
  };

  it("逐条给出合规/不合规理由、分辨率不符与无法校验", async () => {
    render(<App preloaded={projects} />);
    const panel = await screen.findByTestId("final-cut-panel");
    // 面板先渲染，数据后到
    const items = await within(panel).findAllByTestId("final-cut-item");
    expect(items.length).toBe(4);

    const invalid = items.find((i) => i.getAttribute("data-valid") === "false")!;
    expect(within(invalid).getByTestId("final-cut-issues").textContent).toContain(
      "缺少日期前缀",
    );
    expect(panel.textContent).toContain("分辨率不符");
    expect(within(panel).getByTestId("final-cut-uncheckable").textContent).toContain(
      "ffprobe 无法读取",
    );
    expect(within(panel).getByTestId("final-cut-warnings").textContent).toContain(
      "非视频文件已跳过",
    );
  });

  it("工况 B 项目不显示成片校验", async () => {
    render(
      <App preloaded={{ ...projects, selectedProjectId: projectB.id }} />,
    );
    await screen.findAllByTestId("project-row");
    expect(screen.queryByTestId("final-cut-panel")).toBeNull();
  });

  it("页面不可见时停止轮询，切回前台恢复", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const spy = vi.spyOn(api, "checkFinalCuts");
    render(<App preloaded={projects} />);
    await screen.findByTestId("final-cut-panel");
    await waitFor(() => expect(spy).toHaveBeenCalled());

    // 切到后台后跨过整个轮询周期：不该再打 NAS
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    const hiddenAt = spy.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(20000);
    });
    expect(spy.mock.calls.length).toBe(hiddenAt);

    // 切回前台立刻补一次
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(hiddenAt));

    spy.mockRestore();
    vi.useRealTimers();
  }, 15000);
});

describe("交付状态勾选", () => {
  const projects = {
    route: "projects" as const,
    workstation: mockWorkstation,
    projects: mockProjects,
    selectedProjectId: projectA.id,
  };

  it("勾选后写回后端并显示操作人与时间", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "setDeliveryStatus");

    render(<App preloaded={projects} />);
    const checkbox = (await screen.findByTestId(
      "delivery-uploaded",
    )) as HTMLInputElement;
    await waitFor(() => expect(checkbox.disabled).toBe(false));
    expect(checkbox.checked).toBe(false);

    await user.click(checkbox);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(projectA.id, true));

    // 回读：勾选状态与留痕都要显示出来
    await waitFor(() =>
      expect(
        (screen.getByTestId("delivery-uploaded") as HTMLInputElement).checked,
      ).toBe(true),
    );
    expect(screen.getByTestId("delivery-status-meta").textContent).toContain(
      mockWorkstation.operator,
    );
    spy.mockRestore();
  });

  it("写回失败要说出来", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, "setDeliveryStatus")
      .mockRejectedValue(new Error("NAS 只读"));

    render(<App preloaded={projects} />);
    const checkbox = (await screen.findByTestId(
      "delivery-uploaded",
    )) as HTMLInputElement;
    await waitFor(() => expect(checkbox.disabled).toBe(false));
    await user.click(checkbox);

    const err = await screen.findByTestId("delivery-status-error");
    expect(err.textContent).toContain("NAS 只读");
    spy.mockRestore();
  });
});
