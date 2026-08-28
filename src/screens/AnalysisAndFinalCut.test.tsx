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
  // 光标自动落位在 effect 里做:不等它落定,用例的第一下方向键会少走一格
  await waitFor(() =>
    expect(document.querySelector(".asset--focused")).not.toBeNull(),
  );
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

describe("按判定筛选(只留逐张成立的客观指标)", () => {
  /**
   * 口径钉子(屏级):后端 analysis.rs:318 只在连拍组内评「建议保留」,
   * 不成组的单张恒为 false。做成全局筛选就会把非连拍的已判定单张
   * 整批藏起来 / 整批列成「建议放弃」——这两个选项必须不存在。
   */
  it("★ 筛选下拉里没有「建议保留 / 建议放弃」", async () => {
    const user = userEvent.setup();
    await renderSorting();

    await user.click(screen.getByTestId("sorting-judge-filter"));
    const options = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(options).toEqual(["全部", "糊片", "低分", "未判定"]);
    expect(options.join(" ")).not.toContain("建议");
  });

  it("「建议保留」搬去哪了要说清楚,不能凭空消失(零静默)", async () => {
    await renderSorting();
    const note = screen.getByTestId("sorting-suggest-moved");
    expect(note.textContent).toContain("连拍组");
  });

  it("「糊片」只留 blurry 的那些", async () => {
    const user = userEvent.setup();
    await renderSorting();
    const before = screen.getAllByTestId("asset-cell").length;

    await user.click(screen.getByTestId("sorting-judge-filter"));
    await user.click(screen.getByRole("option", { name: "糊片" }));
    await waitFor(() =>
      expect(screen.getAllByTestId("asset-cell").length).not.toBe(before),
    );
    // mock 里 blurry 的只有 i=5 与连拍组里的 i=41,单件格数一定很少
    expect(screen.getAllByTestId("asset-cell").length).toBeLessThan(10);
  });
});

/**
 * 连拍组全屏层:网格 → 组层 → 大图 三层,Esc 每次只退一层。
 * 「建议保留」这个概念的家从全局筛选搬到了这里,所以组层必须把它说全。
 */
describe("连拍组全屏层", () => {
  async function openGroupLayer(user: ReturnType<typeof userEvent.setup>) {
    await renderSorting();
    const group = (await screen.findAllByTestId("asset-group"))[0];
    await user.click(within(group).getByTestId("group-expand"));
    return screen.findByTestId("group-overlay");
  }

  it("是全屏层而不是居中对话框,且组内可滚", async () => {
    const user = userEvent.setup();
    const layer = await openGroupLayer(user);
    expect(layer.className).toContain("group-layer");
    expect(layer.className).not.toContain("dialog");
    // 滚动交给内部的格子区,层本身不背这个责任
    const grid = layer.querySelector(".group-layer__grid");
    expect(grid).not.toBeNull();
  });

  it("组内空格 = 看大图;大图里再按 Esc 退回**组层**,不是一脚踢回网格", async () => {
    const user = userEvent.setup();
    const layer = await openGroupLayer(user);

    fireEvent.keyDown(layer, { key: " " });
    await screen.findByTestId("asset-lightbox");
    // 组层还在底下待着
    expect(screen.queryByTestId("group-overlay")).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("asset-lightbox")).toBeNull());
    // 退了一层:组层仍在
    expect(screen.queryByTestId("group-overlay")).not.toBeNull();

    // 再按一次才回到网格
    fireEvent.keyDown(screen.getByTestId("group-overlay"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("group-overlay")).toBeNull());
  });

  it("方向键在组内移动光标", async () => {
    const user = userEvent.setup();
    const layer = await openGroupLayer(user);
    const items = within(layer).getAllByTestId("group-item");
    expect(items[0].className).toContain("asset--focused");

    fireEvent.keyDown(layer, { key: "ArrowRight" });
    await waitFor(() => {
      const after = within(screen.getByTestId("group-overlay")).getAllByTestId(
        "group-item",
      );
      expect(after[1].className).toContain("asset--focused");
    });
  });

  /**
   * 层级语义要自洽:Esc 退回的是这个组,那大图就不该翻得出组外——
   * 否则翻到第三张组外的图、再 Esc 却回到一个不含它的组。
   */
  it("从组层打开的大图,翻页边界是组成员,序号也是组内序号", async () => {
    const user = userEvent.setup();
    const layer = await openGroupLayer(user);

    fireEvent.keyDown(layer, { key: " " });
    await screen.findByTestId("asset-lightbox");
    // mock 里这一组是 5 张
    expect(screen.getByTestId("lightbox-position").textContent).toBe("1 / 5");
    // 范围与全库对不上,必须当面说清是在哪个范围里数的
    expect(screen.getByTestId("lightbox-scope").textContent).toContain("连拍组内");

    // 往右猛翻,封顶在组内最后一张,绝不越到组外
    for (let i = 0; i < 12; i += 1) {
      fireEvent.keyDown(document, { key: "ArrowRight" });
    }
    await waitFor(() =>
      expect(screen.getByTestId("lightbox-position").textContent).toBe("5 / 5"),
    );

    // 往左猛翻同理,封底在第一张
    for (let i = 0; i < 12; i += 1) {
      fireEvent.keyDown(document, { key: "ArrowLeft" });
    }
    await waitFor(() =>
      expect(screen.getByTestId("lightbox-position").textContent).toBe("1 / 5"),
    );
  });

  it("从网格直接打开的大图仍走全局摊平列表(两个入口的差别)", async () => {
    const user = userEvent.setup();
    await renderSorting();

    await user.dblClick(screen.getAllByTestId("asset-cell")[0]);
    await screen.findByTestId("asset-lightbox");
    // 全局入口:总数是已加载的整页,不是 5
    expect(screen.getByTestId("lightbox-position").textContent).not.toContain("/ 5");
    // 范围就是默认的「全部待分类」,不需要额外说明
    expect(screen.queryByTestId("lightbox-scope")).toBeNull();
  });

  it("组层里 Shift+D 直接进确认流,不必先退出组层", async () => {
    const user = userEvent.setup();
    const layer = await openGroupLayer(user);

    // 先标一张
    fireEvent.keyDown(layer, { key: "d" });
    await waitFor(() =>
      expect(
        within(screen.getByTestId("group-overlay")).getByTestId(
          "group-confirm-delete",
        ).textContent,
      ).toContain("1"),
    );

    fireEvent.keyDown(screen.getByTestId("group-overlay"), {
      key: "D",
      shiftKey: true,
    });
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("移入回收站");
    // 组层 z-index 55 压过普通 .overlay(50):确认框必须抬到 --elevated 才点得到
    expect(dialog.parentElement?.className).toContain("overlay--elevated");
  });

  it("待删清单为空时 Shift+D 不静默落空,而是说明为什么", async () => {
    const user = userEvent.setup();
    const layer = await openGroupLayer(user);

    // 组层里也看得见「清单为空」这件事(屏底那条被本层盖住了)
    expect(within(layer).getByTestId("group-pending-empty").textContent).toContain(
      "待删清单为空",
    );

    fireEvent.keyDown(layer, { key: "D", shiftKey: true });
    const toast = await screen.findByTestId("notice-toast-warning");
    expect(toast.getAttribute("data-code")).toBe("sorting-delete-empty");
    expect(toast.textContent).toContain("先按 D 标记");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("保留全选 / 反选 / 「保留推荐，其余标删」,并讲清「建议保留」只在组内成立", async () => {
    const user = userEvent.setup();
    const layer = await openGroupLayer(user);

    expect(within(layer).getByTestId("group-select-all")).toBeTruthy();
    expect(within(layer).getByTestId("group-invert")).toBeTruthy();
    expect(within(layer).getByTestId("group-suggest-scope").textContent).toContain(
      "只在连拍组内成立",
    );
    // mock 组里恰好 1 张 suggestedKeep,按钮可用且说明写在脸上
    expect(within(layer).getByTestId("group-suggest-count").textContent).toContain(
      "推荐保留 1 张",
    );

    await user.click(within(layer).getByTestId("group-keep-recommended"));
    const bar = await screen.findByTestId("sorting-pending-delete");
    expect(bar.textContent).toContain("已标记 4 个待删除");
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

/* ================================================================== *
 * 组全屏层：焦点管理与键盘契约（两路评审交叉收敛的必修项）
 * ================================================================== */

async function openLayer(user: ReturnType<typeof userEvent.setup>) {
  await renderSorting();
  const group = (await screen.findAllByTestId("asset-group"))[0];
  await user.click(within(group).getByTestId("group-expand"));
  return screen.findByTestId("group-overlay");
}

function gridWrap() {
  return screen.getByTestId("sorting-grid-wrap");
}

function cursorAsset(): string | null {
  return (
    document.querySelector(".sorting__grid .asset--focused")?.getAttribute(
      "data-asset",
    ) ?? null
  );
}

/**
 * 这一组用例**刻意不用** `fireEvent.keyDown(具体元素, …)`。
 * 那种写法把事件直接打在元素上，绕过了真实的焦点链——组层关闭后焦点掉到
 * body、键盘流整条断掉这个 bug，正是因此逃过了此前所有测试。
 * 这里一律走 `user.keyboard(...)`（派发到 `document.activeElement`）
 * 并直接断言 `document.activeElement`。
 */
describe("B3 组层收起后焦点必须回到网格", () => {
  it("★ Esc 退出：焦点回网格（不是 body），方向键立刻还能用", async () => {
    const user = userEvent.setup();
    const layer = await openLayer(user);
    expect(document.activeElement).toBe(layer);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("group-overlay")).toBeNull());

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(gridWrap());

    // 焦点不只是"在那儿"，键盘流得真的活着
    const before = cursorAsset();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => {
      const after = cursorAsset();
      expect(after).toBeTruthy();
      expect(after).not.toBe(before);
    });
  });

  it("★ 点「关闭」按钮退出：焦点同样回网格，而不是随按钮一起消失", async () => {
    const user = userEvent.setup();
    const layer = await openLayer(user);

    await user.click(within(layer).getByTestId("group-close"));
    await waitFor(() => expect(screen.queryByTestId("group-overlay")).toBeNull());

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(gridWrap());

    const before = cursorAsset();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(cursorAsset()).not.toBe(before));
  });

  it("大图从组层里退回来时，焦点归组层（层级还在，不该越级还给网格）", async () => {
    const user = userEvent.setup();
    const layer = await openLayer(user);

    await user.keyboard(" ");
    await screen.findByTestId("asset-lightbox");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("asset-lightbox")).toBeNull());

    expect(screen.queryByTestId("group-overlay")).not.toBeNull();
    expect(document.activeElement).toBe(layer);
  });
});

describe("B2 组层里的 U 只撤回标删", () => {
  it("★ 对未标记项按 U：待删清单不许凭空多出一条，并且要说明为什么没反应", async () => {
    const user = userEvent.setup();
    const layer = await openLayer(user);
    expect(within(layer).getByTestId("group-pending-empty")).toBeTruthy();

    fireEvent.keyDown(layer, { key: "u" });

    const toast = await screen.findByTestId("notice-toast-warning");
    expect(toast.getAttribute("data-code")).toBe("sorting-action-not-marked");
    expect(toast.textContent).toContain("要标删请按 D");
    // 旧行为：这里会变成「已标记 1 个待删除」，而且组层把屏底那条整个盖住，
    // 用户完全看不到自己刚把要保留的那张标成了待删
    expect(screen.queryByTestId("sorting-pending-delete")).toBeNull();
    expect(
      within(screen.getByTestId("group-overlay")).getByTestId("group-pending-empty"),
    ).toBeTruthy();
  });

  it("D 标了之后 U 照常撤回（撤回本职不能被上面那道防线误伤）", async () => {
    const user = userEvent.setup();
    const layer = await openLayer(user);

    fireEvent.keyDown(layer, { key: "d" });
    await screen.findByTestId("sorting-pending-delete");

    fireEvent.keyDown(screen.getByTestId("group-overlay"), { key: "u" });
    await waitFor(() =>
      expect(screen.queryByTestId("sorting-pending-delete")).toBeNull(),
    );
  });

  it("组层底部速查条把 U 写出来了（键位存在却学不到 = 没有）", async () => {
    const user = userEvent.setup();
    const layer = await openLayer(user);
    expect(within(layer).getByTestId("group-hint-mark").textContent).toContain(
      "只取消标删",
    );
  });
});

describe("B6 组失效后自动退回网格，不留锁死键盘的空壳", () => {
  it("★ 两张的组移走一张后不再成组：退回网格 + 明确告知 + 键盘继续可用", async () => {
    const user = userEvent.setup();
    // 3 张单件 + 2 张同组：移走一张，这一组就不再构成连拍组
    const items = mockPendingAssets.slice(0, 5).map((a, i) => ({
      ...a,
      id: `B6/${i}.JPG`,
      fileName: `B6-${i}.JPG`,
      groupId: i >= 3 ? "burst-b6" : undefined,
      judgement: undefined,
    }));
    vi.spyOn(api, "listPendingAssets").mockResolvedValue({
      items,
      total: items.length,
    });

    render(<App preloaded={sorting} />);
    await screen.findAllByTestId("asset-cell");
    const group = (await screen.findAllByTestId("asset-group"))[0];
    await user.click(within(group).getByTestId("group-expand"));
    const layer = await screen.findByTestId("group-overlay");
    expect(within(layer).getAllByTestId("group-item")).toHaveLength(2);

    // 把光标那张分类走 → 组只剩一张 → 浮层卸载
    fireEvent.keyDown(layer, { key: "1" });
    await waitFor(() => expect(screen.queryByTestId("group-overlay")).toBeNull());

    // 旧行为：openGroup 仍非空，网格 handler 永久提前 return，键盘彻底失效且无提示
    const toast = await screen.findByTestId("notice-toast-warning");
    expect(toast.getAttribute("data-code")).toBe("sorting-group-gone");
    expect(toast.textContent).toContain("已退回网格");

    expect(document.activeElement).toBe(gridWrap());
    const before = cursorAsset();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => {
      const after = cursorAsset();
      expect(after).toBeTruthy();
      expect(after).not.toBe(before);
    });
  }, 15000);
});

describe("B7 / B9 组层的按钮与焦点圈定", () => {
  it("★ Tab 到「全选」按回车：执行的是按钮，不会被解释成「看大图」", async () => {
    const user = userEvent.setup();
    const layer = await openLayer(user);

    const selectAll = within(layer).getByTestId("group-select-all");
    selectAll.focus();
    expect(document.activeElement).toBe(selectAll);

    await user.keyboard("{Enter}");

    // 旧行为：空格/Enter 被当成 preview，大图弹出来、按钮根本没执行
    expect(screen.queryByTestId("asset-lightbox")).toBeNull();
    await waitFor(() => {
      const items = within(screen.getByTestId("group-overlay")).getAllByTestId(
        "group-item",
      );
      expect(items.every((i) => i.getAttribute("aria-selected") === "true")).toBe(
        true,
      );
    });
  });

  it("★ Tab 圈在层内：最后一个可聚焦元素再按 Tab 回到第一个，焦点跑不到层背后", async () => {
    const user = userEvent.setup();
    const layer = await openLayer(user);

    const focusables = Array.from(
      layer.querySelectorAll<HTMLElement>("button:not([disabled])"),
    );
    expect(focusables.length).toBeGreaterThan(1);

    focusables[focusables.length - 1].focus();
    await user.keyboard("{Tab}");
    expect(layer.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(focusables[0]);

    // 反向同理
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(focusables[focusables.length - 1]);
  });
});
