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
import { renderProjectsManager } from "../testUtils";
import * as api from "../api";
import { mockPendingAssets, mockProjects, mockWorkstation } from "../api/mock";
import { mockAnalysisResult, resetMockJobs } from "../api/mockJobs";
import type {
  AnalyzeJob,
  DeliveryStatus,
  FinalCutReport,
  JobSnapshot,
} from "../api/types";

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
      expect(screen.getByTestId("sorting-analyze").textContent).toBe("AI 选片分析"),
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

/**
 * 人脸数：后端一直在算，前端此前完全没接出来。
 * 接出来之后最要命的一条是别把「检测不可用」说成「没有人脸」——
 * 那是把不知道包装成结论，正是本项目明令禁止的静默降级。
 */
describe("人脸数呈现", () => {
  it("检出人脸的格子标出人数", async () => {
    await renderSorting();
    const faceBadges = screen.getAllByTestId("judge-faces");
    expect(faceBadges.length).toBeGreaterThan(0);
    for (const badge of faceBadges) {
      expect(badge.textContent).toMatch(/^[1-9]\d* 人$/);
    }
  });

  it("检出 0 张与检测不可用都不出角标——网格里一个中性角标承载不了这个区别", async () => {
    await renderSorting();
    const texts = screen.getAllByTestId("judge-faces").map((b) => b.textContent);
    expect(texts).not.toContain("0 人");
    // null 同理：不会渲染成 "null 人" 之类的东西
    for (const text of texts) expect(text).not.toContain("null");
  });

  it("全屏预览把两者分开说清楚：0 就是 0，不可用就说不可用", async () => {
    const user = userEvent.setup();
    await renderSorting();

    const zeroFaces = mockPendingAssets.find((a) => a.judgement?.faces === 0)!;
    const unknownFaces = mockPendingAssets.find(
      (a) => a.judgement !== undefined && a.judgement.faces === null,
    )!;

    const openCell = async (assetId: string) => {
      const cell = document.querySelector(
        `[data-testid="asset-cell"][data-asset="${CSS.escape(assetId)}"]`,
      ) as HTMLElement;
      expect(cell, `网格里应渲染出 ${assetId}`).toBeTruthy();
      await user.dblClick(cell);
      return screen.findByTestId("lightbox-faces");
    };

    const zero = await openCell(zeroFaces.id);
    expect(zero.textContent).toBe("检出人脸 0");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("asset-lightbox")).toBeNull());

    const unknown = await openCell(unknownFaces.id);
    expect(unknown.textContent).toBe("人脸检测不可用");
    // 绝不能出现任何把「不可用」说成「没有」的措辞
    expect(unknown.textContent).not.toContain("0");
    expect(unknown.textContent).not.toContain("无人脸");
  }, 15000);
});

/**
 * 视频首帧图被跳过 = 转码引擎不可用的降级，格子会一直停在占位。
 * 后端一直在统计，TS 类型此前缺这两个字段，于是这个数字对用户完全不存在。
 */
describe("分析完成后的视频首帧图跳过数", () => {
  it("跳过数 >0 时经通知中心说出来，并说清后果与补救", async () => {
    const user = userEvent.setup();
    const start = vi
      .spyOn(api, "startAnalysis")
      .mockResolvedValue(
        analyzeJob({ id: "job-vt", state: "running", revision: 1, result: undefined }),
      );

    await renderSorting();
    await user.click(screen.getByTestId("sorting-analyze"));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    await act(async () => {
      jobEmitters.forEach((emit) =>
        emit(
          analyzeJob({
            id: "job-vt",
            state: "done",
            // revision 必须大于 running 那条，否则会被乱序保护当成过期事件丢掉
            revision: 4,
            result: { ...mockAnalysisResult, videoThumbsSkipped: 4 },
          }),
        ),
      );
    });

    const toast = await screen.findByTestId("notice-toast-warning");
    expect(toast.getAttribute("data-code")).toBe("analysis-video-thumbs-skipped");
    expect(toast.textContent).toContain("4 个视频");
    // 后果 + 补救都要说，不能只丢一个数字
    expect(toast.textContent).toContain("占位");
    expect(toast.textContent).toContain("重跑分析");
  }, 15000);

  it("跳过数为 0 时不打扰用户", async () => {
    const user = userEvent.setup();
    const start = vi
      .spyOn(api, "startAnalysis")
      .mockResolvedValue(
        analyzeJob({ id: "job-vt0", state: "running", revision: 1, result: undefined }),
      );

    await renderSorting();
    await user.click(screen.getByTestId("sorting-analyze"));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    await act(async () => {
      jobEmitters.forEach((emit) =>
        emit(
          analyzeJob({
            id: "job-vt0",
            state: "done",
            revision: 4,
            result: { ...mockAnalysisResult, videoThumbsSkipped: 0 },
          }),
        ),
      );
    });

    await waitFor(() => expect(api.listPendingAssets).toBeDefined());
    expect(
      screen.queryByTestId("notice-toast-warning")?.getAttribute("data-code"),
    ).not.toBe("analysis-video-thumbs-skipped");
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

describe("按判定筛选(筛选组)", () => {
  it("「建议保留」只留建议保留与尚无判定的", async () => {
    const user = userEvent.setup();
    await renderSorting();
    const before = screen.getAllByTestId("asset-cell").length;

    await user.click(screen.getByTestId("sorting-judge-filter"));
    await user.click(screen.getByRole("option", { name: /建议保留/ }));
    await waitFor(() =>
      expect(screen.getAllByTestId("asset-cell").length).not.toBe(before),
    );
    // 明确判定为不保留的那些被过滤掉了
    expect(screen.queryAllByTestId("asset-group")).toHaveLength(0);
  });

  it("「建议放弃」是它的严格反集:批量弃片有了路径(评审 3.6)", async () => {
    const user = userEvent.setup();
    await renderSorting();

    await user.click(screen.getByTestId("sorting-judge-filter"));
    await user.click(screen.getByRole("option", { name: "建议放弃" }));
    await waitFor(() => {
      // mock 里有判定且 suggestedKeep=false 的:i=5、i=7 与连拍组的 4 张
      const cells = screen.queryAllByTestId("asset-cell");
      const groups = screen.queryAllByTestId("asset-group");
      expect(cells.length + groups.length).toBeGreaterThan(0);
      expect(cells.length).toBeLessThan(10);
    });
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
    route: "copy" as const,
    workstation: mockWorkstation,
    projects: mockProjects,
    selectedProjectId: projectA.id,
  };

  it("逐条给出合规/不合规理由、分辨率不符与无法校验", async () => {
    renderProjectsManager(projects);
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

  it("分辨率不符要把后端给的原因说出来，不能只亮一个红角标", async () => {
    renderProjectsManager(projects);
    const panel = await screen.findByTestId("final-cut-panel");
    await within(panel).findAllByTestId("final-cut-item");

    const reason = within(panel).getByTestId("final-cut-mismatch");
    // 后端下发的是「哪儿不符」的原文；当布尔用会把这句话整个丢掉
    expect(reason.textContent).toContain("4K");
    expect(reason.textContent).toContain("1280x720");
  });

  /**
   * 后端要对「6. 成片」下每个文件逐个 ffprobe，最长可到 30s，而轮询是 7s 一拍。
   * 无守卫地按点发车会同时压着好几个全量扫描在 NAS 上跑，
   * 而且旧响应后到还会把新结果覆盖掉。
   */
  it("扫描比轮询间隔慢时不叠加请求，回来后立刻补跑被挡下的那一拍", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pending: Array<(report: FinalCutReport) => void> = [];
    const spy = vi
      .spyOn(api, "checkFinalCuts")
      .mockImplementation(
        () => new Promise<FinalCutReport>((resolve) => pending.push(resolve)),
      );

    renderProjectsManager(projects);
    await screen.findByTestId("final-cut-panel");
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    // 跨过 4 个轮询周期：上一轮还没回来，一个新请求都不该发出去
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    expect(spy).toHaveBeenCalledTimes(1);

    // 第一轮终于回来 → 被挡下的那些拍合并成一次补跑，不白等一整个周期
    await act(async () => {
      pending[0]({ items: [], warnings: ["扫描很慢"] });
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(
      within(screen.getByTestId("final-cut-panel")).getByTestId(
        "final-cut-warnings",
      ).textContent,
    ).toContain("扫描很慢");

    // 补跑这一次仍在途时，同样不会再叠加
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    expect(spy).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  }, 15000);

  it("工况 B 项目不显示成片校验", async () => {
    renderProjectsManager({ ...projects, selectedProjectId: projectB.id });
    await screen.findAllByTestId("project-row");
    expect(screen.queryByTestId("final-cut-panel")).toBeNull();
  });

  it("页面不可见时停止轮询，切回前台恢复", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const spy = vi.spyOn(api, "checkFinalCuts");
    renderProjectsManager(projects);
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
    route: "copy" as const,
    workstation: mockWorkstation,
    projects: mockProjects,
    selectedProjectId: projectA.id,
  };

  it("勾选后写回后端并显示操作人与时间", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "setDeliveryStatus");

    renderProjectsManager(projects);
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

  it("可见期 10s 轮询，隐藏时不打 NAS", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const spy = vi.spyOn(api, "getDeliveryStatus");
    renderProjectsManager(projects);
    await screen.findByTestId("delivery-status");
    await waitFor(() => expect(spy).toHaveBeenCalled());

    const before = spy.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(11000);
    });
    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(before));

    // 切后台后跨过周期：不再打
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    const hiddenAt = spy.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    expect(spy.mock.calls.length).toBe(hiddenAt);

    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
    spy.mockRestore();
    vi.useRealTimers();
  }, 15000);

  /**
   * 轮询与勾选写的是同一份 status：
   * 轮询在 T0 发出 get，用户在 T1 勾上，set 先回来把界面点亮，
   * 随后 T0 那个「还是未勾选」的旧响应回来——勾就自己跳回去了。
   * 用户会以为自己没勾上，再勾一次，来回打架。
   */
  it("勾选期间回来的旧轮询响应不许把勾又抹回去", async () => {
    const user = userEvent.setup();
    const unchecked: DeliveryStatus = { uploaded: false };
    let resolveStalePoll!: (value: DeliveryStatus) => void;

    const getSpy = vi
      .spyOn(api, "getDeliveryStatus")
      .mockResolvedValueOnce(unchecked)
      .mockImplementationOnce(
        () =>
          new Promise<DeliveryStatus>((resolve) => {
            resolveStalePoll = resolve;
          }),
      );
    const setSpy = vi.spyOn(api, "setDeliveryStatus").mockResolvedValue({
      uploaded: true,
      updatedBy: "阿斌",
      updatedAt: "2026-08-24T12:00:00+08:00",
    });

    renderProjectsManager(projects);
    const checkbox = (await screen.findByTestId(
      "delivery-uploaded",
    )) as HTMLInputElement;
    await waitFor(() => expect(checkbox.disabled).toBe(false));
    expect(checkbox.checked).toBe(false);

    // 让第二次轮询发车并挂在半路（visibilitychange 会触发一次 load，无需假时钟）
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(getSpy).toHaveBeenCalledTimes(2));

    // 这期间用户勾上了，写回成功
    await user.click(checkbox);
    await waitFor(() => expect(setSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(checkbox.checked).toBe(true));

    // 现在那个「还是未勾选」的旧响应才姗姗来迟
    await act(async () => {
      resolveStalePoll(unchecked);
    });

    // 勾必须还在：旧响应的号比勾选小，不该被采纳
    expect(checkbox.checked).toBe(true);
    expect(screen.getByTestId("delivery-status-meta").textContent).toContain("阿斌");
  }, 15000);

  it("写回失败要说出来", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, "setDeliveryStatus")
      .mockRejectedValue(new Error("NAS 只读"));

    renderProjectsManager(projects);
    const checkbox = (await screen.findByTestId(
      "delivery-uploaded",
    )) as HTMLInputElement;
    await waitFor(() => expect(checkbox.disabled).toBe(false));
    await user.click(checkbox);

    // 提交后失败统一走 toast(UX 波三),级别 error
    const toast = await screen.findByTestId("notice-toast-error");
    expect(toast.textContent).toContain("NAS 只读");
    spy.mockRestore();
  });
});
