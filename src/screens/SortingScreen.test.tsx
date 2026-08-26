/** 分类工作台：键盘流、两段式删除、部分失败的诚实处理。 */

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
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import * as api from "../api";
import {
  mockCategories,
  mockPendingAssets,
  mockProjects,
  mockWorkstation,
} from "../api/mock";
import type { IndexProgressEvent } from "../api/types";

afterEach(cleanup);

const project = mockProjects[0];

const preloaded = {
  route: "sorting" as const,
  workstation: mockWorkstation,
  projects: mockProjects,
  selectedProjectId: project.id,
};

function grid() {
  return screen.getByTestId("sorting-grid-wrap");
}

function cells() {
  return screen.getAllByTestId("asset-cell");
}

function focusedAsset(): string | null {
  return (
    document.querySelector(".asset--focused")?.getAttribute("data-asset") ?? null
  );
}

async function renderSorting() {
  render(<App preloaded={preloaded} />);
  await screen.findAllByTestId("asset-cell");
}

describe("分类工作台", () => {
  it("加载分类条与待分类计数，网格只渲染窗口内节点", async () => {
    await renderSorting();

    expect(screen.getByTestId("sorting-remaining").textContent).toContain("1240");
    expect(screen.getAllByTestId("sorting-category")).toHaveLength(
      mockCategories.length,
    );
    // 千张素材，DOM 里绝不是一千个格子
    expect(cells().length).toBeLessThan(100);
  });

  it("索引进行中仍可操作，进度条与失败数可见", async () => {
    await renderSorting();
    const banner = screen.getByTestId("sorting-indexing");
    expect(banner.textContent).toContain("1144/1240");
    expect(banner.textContent).toContain("3 个失败");
    expect(banner.textContent).toContain("可以先分类已索引的部分");
  });

  it("#4 已移走的文件计入 missing 且不算失败", async () => {
    await renderSorting();
    const banner = screen.getByTestId("sorting-indexing");
    expect(banner.textContent).toContain("已跳过 2 个已移走的文件");
    // missing 不能混进失败数
    expect(banner.textContent).toContain("3 个失败");
  });

  it("#6 O 键与数字键都不会把 curated 传给 moveAssets", async () => {
    const move = vi.spyOn(api, "moveAssets");
    const curate = vi.spyOn(api, "curateAssets");
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    fireEvent.keyDown(grid(), { key: "o" });
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    expect(move.mock.calls[0][2]).toBe("other");

    // 等这批操作真正落定（busy 复位）后再按下一个键，否则会被忽略
    await waitFor(() =>
      expect(screen.getByTestId("sorting-remaining").textContent).toContain("1239"),
    );

    // 数字键只绑定 custom 分类，永远拿不到 curated
    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    fireEvent.keyDown(grid(), { key: "1" });
    await waitFor(() => expect(move).toHaveBeenCalledTimes(2));
    expect(move.mock.calls.every((c) => c[2] !== "curated")).toBe(true);
    expect(curate).not.toHaveBeenCalled();

    move.mockRestore();
    curate.mockRestore();
  });

  it("未索引出缩略图的格子显示占位而不是空白", async () => {
    await renderSorting();
    expect(screen.getAllByTestId("asset-no-thumb").length).toBeGreaterThan(0);
  });

  it("方向键移动焦点，Shift+方向连选", async () => {
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    const first = focusedAsset();
    expect(first).toBeTruthy();

    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    const second = focusedAsset();
    expect(second).not.toBe(first);
    expect(screen.getByTestId("sorting-selected-count").textContent).toContain("已选 1");

    fireEvent.keyDown(grid(), { key: "ArrowRight", shiftKey: true });
    expect(screen.getByTestId("sorting-selected-count").textContent).toContain("已选 2");

    // 下移一整行（jsdom 下列数回退为 6）
    fireEvent.keyDown(grid(), { key: "ArrowDown", shiftKey: true });
    expect(screen.getByTestId("sorting-selected-count").textContent).toContain("已选 8");
  });

  it("数字键把选中项分到对应分类，并从待分类移除", async () => {
    const spy = vi.spyOn(api, "moveAssets");
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    const target = focusedAsset();
    fireEvent.keyDown(grid(), { key: "1" });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][1]).toEqual([target]);
    expect(spy.mock.calls[0][2]).toBe("cat-1");

    // 移动成功后该项离开待分类
    await waitFor(() =>
      expect(screen.getByTestId("sorting-remaining").textContent).toContain("1239"),
    );
    spy.mockRestore();
  });

  it("没有绑定的数字键不触发任何移动", async () => {
    const spy = vi.spyOn(api, "moveAssets");
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    fireEvent.keyDown(grid(), { key: "8" });

    await new Promise((r) => setTimeout(r, 50));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("P 加入精选：复制一份，原件仍留在待分类", async () => {
    const spy = vi.spyOn(api, "curateAssets");
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    const before = screen.getByTestId("sorting-remaining").textContent;
    fireEvent.keyDown(grid(), { key: "p" });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    // 精选是复制，不该把素材从待分类拿走
    expect(screen.getByTestId("sorting-remaining").textContent).toBe(before);
    spy.mockRestore();
  });

  it("O 分到「其他」", async () => {
    const spy = vi.spyOn(api, "moveAssets");
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    fireEvent.keyDown(grid(), { key: "o" });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][2]).toBe("other");
    spy.mockRestore();
  });

  it("D 只标记不删除：出现待删条，且未调用后端", async () => {
    const spy = vi.spyOn(api, "trashAssets");
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    fireEvent.keyDown(grid(), { key: "d" });

    const bar = screen.getByTestId("sorting-pending-delete");
    expect(bar.textContent).toContain("已标记 1 个待删除");
    expect(document.querySelector('[data-marked="true"]')).toBeTruthy();
    // 第一段绝不碰文件
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("待删清单可整体取消标记", async () => {
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    fireEvent.keyDown(grid(), { key: "d" });
    expect(screen.getByTestId("sorting-pending-delete")).toBeDefined();

    await userEvent.setup().click(screen.getByTestId("sorting-unmark-all"));
    expect(screen.queryByTestId("sorting-pending-delete")).toBeNull();
  });

  it("确认后才移入回收站，且对话框写明不物理删除", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "trashAssets");
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    fireEvent.keyDown(grid(), { key: "d" });
    await user.click(screen.getByTestId("sorting-confirm-delete"));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("不会物理删除");
    expect(spy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "移入回收站" }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    spy.mockRestore();
  });

  it("确认对话框取消则不删除，清单仍在", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "trashAssets");
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    fireEvent.keyDown(grid(), { key: "d" });
    await user.click(screen.getByTestId("sorting-confirm-delete"));
    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByTestId("sorting-pending-delete")).toBeDefined();
    spy.mockRestore();
  });

  it("部分失败时如实保留失败项、恢复选中态并经通知中心报错", async () => {
    const user = userEvent.setup();
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    const firstId = focusedAsset() as string;
    fireEvent.keyDown(grid(), { key: "ArrowRight", shiftKey: true });

    const selected = cells()
      .filter((c) => c.getAttribute("aria-selected") === "true")
      .map((c) => c.getAttribute("data-asset") as string);
    expect(selected).toHaveLength(2);

    const spy = vi.spyOn(api, "moveAssets").mockResolvedValue({
      succeeded: [selected[1]],
      failed: [{ assetId: firstId, message: "目标文件已存在" }],
    });

    fireEvent.keyDown(grid(), { key: "1" });

    // 失败项重新选中，供直接重试
    await waitFor(() =>
      expect(screen.getByTestId("sorting-selected-count").textContent).toContain(
        "已选 1",
      ),
    );
    const stillSelected = cells().find(
      (c) => c.getAttribute("aria-selected") === "true",
    );
    expect(stillSelected?.getAttribute("data-asset")).toBe(firstId);

    // 失败原因经通知中心可见
    await user.click(screen.getByTestId("notice-bell"));
    const item = screen.getByTestId("notice-item");
    expect(item.getAttribute("data-code")).toBe("sorting-bulk-failed");
    expect(item.textContent).toContain("目标文件已存在");

    spy.mockRestore();
  });

  it("Enter 打开全屏预览，左右切换、Esc 关闭", async () => {
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    fireEvent.keyDown(grid(), { key: "Enter" });

    const box = screen.getByTestId("asset-lightbox");
    expect(within(box).getByTestId("lightbox-position").textContent).toBe("1 / 200");

    fireEvent.keyDown(document, { key: "ArrowRight" });
    await waitFor(() =>
      expect(screen.getByTestId("lightbox-position").textContent).toBe("2 / 200"),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("asset-lightbox")).toBeNull());
  });

  it("退出全屏后光标停在最后看的那一张，而不是把人扔回进去之前的位置", async () => {
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    const enteredFrom = focusedAsset();
    expect(enteredFrom).not.toBeNull();

    fireEvent.keyDown(grid(), { key: "Enter" });
    await screen.findByTestId("asset-lightbox");

    // 往后翻两张再退出
    fireEvent.keyDown(document, { key: "ArrowRight" });
    fireEvent.keyDown(document, { key: "ArrowRight" });
    await waitFor(() =>
      expect(screen.getByTestId("lightbox-position").textContent).toBe("3 / 200"),
    );
    const viewed = screen
      .getByTestId("asset-lightbox")
      .getAttribute("aria-label");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("asset-lightbox")).toBeNull());

    const landed = focusedAsset();
    expect(landed).not.toBe(enteredFrom);
    expect(viewed).toContain(landed!.split("/").pop()!);
  });

  it("光标格挂着全屏预览的过渡名，其余格一个都不挂——挂重了整次过渡会被放弃", async () => {
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "ArrowRight" });

    const named = cells().filter(
      (cell) =>
        cell.querySelector('[style*="view-transition-name"]') !== null,
    );
    expect(named).toHaveLength(1);
    expect(named[0].getAttribute("data-asset")).toBe(focusedAsset());
  });

  it("索引事件到达时进度条实时更新（index://progress 接线）", async () => {
    let emit: ((e: IndexProgressEvent) => void) | null = null;
    const spy = vi
      .spyOn(api, "subscribeIndexProgress")
      .mockImplementation((onEvent: (e: IndexProgressEvent) => void) => {
        emit = onEvent;
        return { dispose: () => {}, ready: Promise.resolve() };
      });

    await renderSorting();
    expect(screen.getByTestId("sorting-indexing").textContent).toContain("1144/1240");

    act(() =>
      emit?.({
        projectId: project.id,
        indexed: 1240,
        total: 1240,
        running: false,
        failed: 3,
        missing: 0,
        round: 1,
        occurredAt: new Date().toISOString(),
      }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("sorting-indexing").textContent).toContain(
        "缩略图索引完成 1240/1240",
      ),
    );
    spy.mockRestore();
  });

  it("别的项目的索引事件不会串台", async () => {
    let emit: ((e: IndexProgressEvent) => void) | null = null;
    const spy = vi
      .spyOn(api, "subscribeIndexProgress")
      .mockImplementation((onEvent: (e: IndexProgressEvent) => void) => {
        emit = onEvent;
        return { dispose: () => {}, ready: Promise.resolve() };
      });

    await renderSorting();
    act(() =>
      emit?.({
        projectId: "p-other",
        indexed: 5,
        total: 5,
        running: false,
        failed: 0,
        missing: 0,
        round: 1,
        occurredAt: new Date().toISOString(),
      }),
    );

    expect(screen.getByTestId("sorting-indexing").textContent).toContain("1144/1240");
    spy.mockRestore();
  });

  it("#8 点击「精选」走复制语义（curateAssets），不是移动", async () => {
    const user = userEvent.setup();
    const curate = vi.spyOn(api, "curateAssets");
    const move = vi.spyOn(api, "moveAssets");
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    const before = screen.getByTestId("sorting-remaining").textContent;

    const chip = screen
      .getAllByTestId("sorting-category")
      .find((c) => c.getAttribute("data-category") === "curated") as HTMLElement;
    await user.click(chip);

    await waitFor(() => expect(curate).toHaveBeenCalledTimes(1));
    // 关键：绝不能调 moveAssets，否则素材被挪进精选、脱离分类流程
    expect(move).not.toHaveBeenCalled();
    // 复制语义：原件仍留在待分类
    expect(screen.getByTestId("sorting-remaining").textContent).toBe(before);

    curate.mockRestore();
    move.mockRestore();
  });

  it("#8 点击普通分类仍走移动", async () => {
    const user = userEvent.setup();
    const move = vi.spyOn(api, "moveAssets");
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    const chip = screen
      .getAllByTestId("sorting-category")
      .find((c) => c.getAttribute("data-category") === "cat-1") as HTMLElement;
    await user.click(chip);

    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    expect(move.mock.calls[0][2]).toBe("cat-1");
    move.mockRestore();
  });

  it("#16 初始加载失败显示错误与重试，绝不渲染成「没有素材」", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, "listPendingAssets")
      .mockRejectedValueOnce(new Error("NAS 不可达"));

    render(<App preloaded={preloaded} />);

    const err = await screen.findByTestId("sorting-load-error");
    expect(err.textContent).toContain("NAS 不可达");
    expect(err.textContent).toContain("这不代表素材不存在");
    // 决不能出现空态文案
    expect(screen.queryByText("待分类里没有素材了。")).toBeNull();

    // 重试成功后正常渲染
    spy.mockRestore();
    await user.click(screen.getByTestId("sorting-retry"));
    await screen.findAllByTestId("asset-cell");
    expect(screen.queryByTestId("sorting-load-error")).toBeNull();
  });

  it("#13 索引推进后重拉当前页，让「索引中」的格子出图", async () => {
    let emit: ((e: IndexProgressEvent) => void) | null = null;
    const subSpy = vi
      .spyOn(api, "subscribeIndexProgress")
      .mockImplementation((onEvent: (e: IndexProgressEvent) => void) => {
        emit = onEvent;
        return { dispose: () => {}, ready: Promise.resolve() };
      });

    await renderSorting();
    const listSpy = vi.spyOn(api, "listPendingAssets");

    act(() =>
      emit?.({
        projectId: project.id,
        indexed: 1240,
        total: 1240,
        running: false,
        failed: 0,
        missing: 0,
        round: 1,
        occurredAt: new Date().toISOString(),
      }),
    );

    // 节流窗口过后重拉当前页
    await waitFor(() => expect(listSpy).toHaveBeenCalled(), { timeout: 4000 });
    expect(listSpy.mock.calls[0][1]).toBe(0);

    listSpy.mockRestore();
    subSpy.mockRestore();
  }, 10000);

  it("#13 索引监听建立失败要说出来", async () => {
    const user = userEvent.setup();
    const subSpy = vi
      .spyOn(api, "subscribeIndexProgress")
      .mockImplementation(
        (
          _onEvent: (e: IndexProgressEvent) => void,
          onError?: (e: unknown) => void,
        ) => {
          onError?.(new Error("channel closed"));
          return { dispose: () => {}, ready: Promise.resolve() };
        },
      );

    await renderSorting();
    await user.click(screen.getByTestId("notice-bell"));
    expect(screen.getByTestId("notice-item").getAttribute("data-code")).toBe(
      "index-listen-failed",
    );
    subSpy.mockRestore();
  });

  it("#13a 新一轮索引按 round 判定：数值归零也照样触发刷新", async () => {
    let emit: ((e: IndexProgressEvent) => void) | null = null;
    const subSpy = vi
      .spyOn(api, "subscribeIndexProgress")
      .mockImplementation((onEvent: (e: IndexProgressEvent) => void) => {
        emit = onEvent;
        return { dispose: () => {}, ready: Promise.resolve() };
      });

    await renderSorting();
    const listSpy = vi.spyOn(api, "listPendingAssets");

    const ev = (
      indexed: number,
      running: boolean,
      round: number,
    ): IndexProgressEvent => ({
      projectId: project.id,
      indexed,
      total: 1240,
      running,
      failed: 0,
      missing: 0,
      round,
      occurredAt: new Date().toISOString(),
    });

    // 第一轮跑完，水位到 1240
    act(() => emit?.(ev(1240, false, 1)));
    await waitFor(() => expect(listSpy).toHaveBeenCalled(), { timeout: 4000 });
    const afterFirstRound = listSpy.mock.calls.length;

    // 第二轮开始：indexed 归 0 且 round+1。**只发这一条**——
    // 若还按「indexed 必须大于历史水位」过滤，这条会被吞掉，缩略图永不出图
    act(() => emit?.(ev(0, true, 2)));

    await waitFor(
      () => expect(listSpy.mock.calls.length).toBeGreaterThan(afterFirstRound),
      { timeout: 4000 },
    );

    listSpy.mockRestore();
    subSpy.mockRestore();
  }, 15000);

  it("#13a 同一轮内数值恰好相同不误判为新一轮", async () => {
    let emit: ((e: IndexProgressEvent) => void) | null = null;
    const subSpy = vi
      .spyOn(api, "subscribeIndexProgress")
      .mockImplementation((onEvent: (e: IndexProgressEvent) => void) => {
        emit = onEvent;
        return { dispose: () => {}, ready: Promise.resolve() };
      });

    await renderSorting();

    const ev = (indexed: number, round: number): IndexProgressEvent => ({
      projectId: project.id,
      indexed,
      total: 1240,
      running: true,
      failed: 0,
      missing: 0,
      round,
      occurredAt: new Date().toISOString(),
    });

    act(() => emit?.(ev(600, 1)));
    await waitFor(() => expect(screen.getByTestId("sorting-indexing")).toBeDefined());

    const listSpy = vi.spyOn(api, "listPendingAssets");
    // 同轮、同数值的重复事件（心跳）不该触发刷新
    act(() => emit?.(ev(600, 1)));
    await new Promise((r) => setTimeout(r, 2500));
    expect(listSpy).not.toHaveBeenCalled();

    listSpy.mockRestore();
    subSpy.mockRestore();
  }, 15000);

  it("#13b 订阅就绪前索引已跑完：ready 后兜底对账，不留永久「索引中」", async () => {
    // ready 手动控制，模拟 listen 注册尚未完成
    let markReady: (() => void) | undefined;
    const subSpy = vi
      .spyOn(api, "subscribeIndexProgress")
      .mockImplementation(() => ({
        dispose: () => {},
        ready: new Promise<void>((resolve) => {
          markReady = resolve;
        }),
      }));

    // 打开页面时索引还在跑；等 listen 注册完成时它已经跑完，
    // 收尾事件因此丢失——只能靠 ready 之后的兜底对账救回来
    const statusSpy = vi
      .spyOn(api, "indexingStatus")
      .mockResolvedValueOnce({
        projectId: project.id,
        indexed: 900,
        total: 1240,
        running: true,
        failed: 0,
        missing: 0,
        round: 1,
      })
      .mockResolvedValue({
        projectId: project.id,
        indexed: 1240,
        total: 1240,
        running: false,
        failed: 0,
        missing: 0,
        round: 1,
      });

    await renderSorting();
    const listSpy = vi.spyOn(api, "listPendingAssets");

    await act(async () => {
      markReady?.();
    });

    // ready 之后必须补拉状态并刷新当前页
    await waitFor(() => expect(statusSpy.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() => expect(listSpy).toHaveBeenCalled(), { timeout: 4000 });

    listSpy.mockRestore();
    statusSpy.mockRestore();
    subSpy.mockRestore();
  }, 15000);

  it("#13 竞态：首个 indexingStatus 返回 running:false/total:0（索引尚未开始）不烧掉收尾对账", async () => {
    // 剧本：初始 Promise.all 里 indexingStatus 抢先返回「map 无条目」的空状态，
    // 随后索引才真正开始并在 sub.ready 前跑完 —— 收尾事件丢失。
    let markReady: (() => void) | undefined;
    const subSpy = vi
      .spyOn(api, "subscribeIndexProgress")
      .mockImplementation(() => ({
        dispose: () => {},
        ready: new Promise<void>((resolve) => {
          markReady = resolve;
        }),
      }));

    const statusSpy = vi
      .spyOn(api, "indexingStatus")
      // ① 项目首次打开：索引 map 里还没有条目
      .mockResolvedValueOnce({
        projectId: project.id,
        indexed: 0,
        total: 0,
        running: false,
        failed: 0,
        missing: 0,
        round: 0,
      })
      // ② ready 时索引已经整轮跑完
      .mockResolvedValue({
        projectId: project.id,
        indexed: 1240,
        total: 1240,
        running: false,
        failed: 0,
        missing: 0,
        round: 1,
      });

    await renderSorting();
    // total=0 时不该显示进度条，也不该把 reconciledRef 提前烧掉
    expect(screen.queryByTestId("sorting-indexing")).toBeNull();

    const listSpy = vi.spyOn(api, "listPendingAssets");
    await act(async () => {
      markReady?.();
    });

    // ready 兜底必须补一次页刷新——否则格子永久停在「索引中」，
    // 而且既没有进度条也没有任何提示（就是复验点名的那个静默失效）
    await waitFor(() => expect(listSpy).toHaveBeenCalled(), { timeout: 4000 });
    expect(listSpy.mock.calls[0][1]).toBe(0);

    listSpy.mockRestore();
    statusSpy.mockRestore();
    subSpy.mockRestore();
  }, 15000);

  it("#13 ready 兜底必须自己补刷：当前页都有缩略图时收尾对账不会代劳", async () => {
    // 隔离 ready 那条补刷路径——让当前页所有格子都已有缩略图，
    // 收尾对账因此不满足条件，能否刷新完全取决于 ready 兜底自己 scheduleRefresh
    const allThumbs = mockPendingAssets.slice(0, 200).map((a) => ({
      ...a,
      thumbnail: a.thumbnail ?? "data:image/svg+xml;base64,AAAA",
      thumbReady: true,
    }));
    const listSpy = vi
      .spyOn(api, "listPendingAssets")
      .mockResolvedValue({ items: allThumbs, total: 1240 });

    let markReady: (() => void) | undefined;
    const subSpy = vi
      .spyOn(api, "subscribeIndexProgress")
      .mockImplementation(() => ({
        dispose: () => {},
        ready: new Promise<void>((resolve) => {
          markReady = resolve;
        }),
      }));

    const statusSpy = vi
      .spyOn(api, "indexingStatus")
      .mockResolvedValueOnce({
        projectId: project.id,
        indexed: 900,
        total: 1240,
        running: true,
        failed: 0,
        missing: 0,
        round: 1,
      })
      .mockResolvedValue({
        projectId: project.id,
        indexed: 1240,
        total: 1240,
        running: false,
        failed: 0,
        missing: 0,
        round: 1,
      });

    await renderSorting();
    const callsBefore = listSpy.mock.calls.length;

    await act(async () => {
      markReady?.();
    });

    await waitFor(
      () => expect(listSpy.mock.calls.length).toBeGreaterThan(callsBefore),
      { timeout: 4000 },
    );

    listSpy.mockRestore();
    statusSpy.mockRestore();
    subSpy.mockRestore();
  }, 15000);

  it("#W4 thumbReady=false 的格子显示占位（thumbnail 是 URL，不看它是否存在）", async () => {
    await renderSorting();
    // mock 每 13 张一个未就绪
    expect(screen.getAllByTestId("asset-no-thumb").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("asset-thumb").length).toBeGreaterThan(0);
  });

  it("#W4 收尾对账判据用 thumbReady：URL 都在但缓存未就绪时仍要补刷", async () => {
    // 关键场景：每个 asset 都有 thumbnail URL，但 thumbReady=false。
    // 若判据错用 thumbnail 存在性，这里会认为「都出图了」而不补刷。
    const notReady = mockPendingAssets.slice(0, 200).map((a) => ({
      ...a,
      thumbnail: "thumb://localhost/p/abcdef0123456789.jpg",
      thumbReady: false,
    }));
    const listSpy = vi
      .spyOn(api, "listPendingAssets")
      .mockResolvedValue({ items: notReady, total: 1240 });

    const statusSpy = vi.spyOn(api, "indexingStatus").mockResolvedValue({
      projectId: project.id,
      indexed: 1240,
      total: 1240,
      running: false,
      failed: 0,
      missing: 0,
      round: 1,
    });

    render(<App preloaded={preloaded} />);
    await screen.findAllByTestId("asset-cell");
    const before = listSpy.mock.calls.length;

    await waitFor(
      () => expect(listSpy.mock.calls.length).toBeGreaterThan(before),
      { timeout: 4000 },
    );

    listSpy.mockRestore();
    statusSpy.mockRestore();
  }, 15000);

  it("#W4 有 URL 但 thumbReady=false 时不去取图，直接占位", async () => {
    // 契约上 thumbnail 只在就绪时才有值；万一后端给了 URL 却未就绪，
    // 前端也不能去发请求——渲染条件必须看 thumbReady
    const notReady = mockPendingAssets.slice(0, 200).map((a) => ({
      ...a,
      thumbnail: "thumb://localhost/p/abcdef0123456789.jpg",
      thumbReady: false,
    }));
    const listSpy = vi
      .spyOn(api, "listPendingAssets")
      .mockResolvedValue({ items: notReady, total: 1240 });

    render(<App preloaded={preloaded} />);
    await screen.findAllByTestId("asset-cell");

    expect(screen.queryAllByTestId("asset-thumb")).toHaveLength(0);
    expect(screen.getAllByTestId("asset-no-thumb").length).toBeGreaterThan(0);
    listSpy.mockRestore();
  });

  it("#W4 取图 404 时该格转占位", async () => {
    await renderSorting();
    const img = screen.getAllByTestId("asset-thumb")[0];
    const cell = img.closest("[data-testid='asset-cell']") as HTMLElement;
    // 慢机器(CI 高负载)上后台刷新可能落进等待窗,把持有的旧 cell 节点
    // 变成 detached——按 data-asset 每轮重查;重挂载让缩略图重新出现时
    // 再触发一次 error,收敛后必然出占位(deflake:run 32876* 首次抖动)
    const assetId = cell.getAttribute("data-asset");
    expect(assetId).toBeTruthy();

    fireEvent.error(img);

    await waitFor(
      () => {
        const current = document.querySelector<HTMLElement>(
          `[data-testid='asset-cell'][data-asset='${assetId}']`,
        );
        expect(current).not.toBeNull();
        const freshImg = within(current as HTMLElement).queryByTestId("asset-thumb");
        if (freshImg) fireEvent.error(freshImg);
        expect(
          within(current as HTMLElement).getByTestId("asset-no-thumb").textContent,
        ).toContain("预览不可用");
      },
      { timeout: 4000 },
    );
  });

  it("#W4 连续 20 张失败亮出屏内横幅，任一成功即归零", async () => {
    await renderSorting();
    expect(screen.queryByTestId("sorting-thumb-degraded")).toBeNull();

    const imgs = screen.getAllByTestId("asset-thumb");
    expect(imgs.length).toBeGreaterThanOrEqual(20);
    for (let i = 0; i < 19; i += 1) fireEvent.error(imgs[i]);
    // 19 次还不到阈值
    expect(screen.queryByTestId("sorting-thumb-degraded")).toBeNull();

    fireEvent.error(imgs[19]);
    const banner = await screen.findByTestId("sorting-thumb-degraded");
    expect(banner.textContent).toContain("缩略图服务异常，详见通知");

    // 任一成功加载即归零
    const survivor = screen.getAllByTestId("asset-thumb")[0];
    fireEvent.load(survivor);
    await waitFor(() =>
      expect(screen.queryByTestId("sorting-thumb-degraded")).toBeNull(),
    );
  });

  it("#3 翻页失败给可见错误并保留已加载内容", async () => {
    const user = userEvent.setup();
    await renderSorting();
    const before = cells().length;

    const spy = vi
      .spyOn(api, "listPendingAssets")
      .mockRejectedValueOnce(new Error("NAS 超时"));
    await user.click(screen.getByTestId("sorting-load-more"));

    const err = await screen.findByTestId("sorting-page-error");
    expect(err.textContent).toContain("NAS 超时");
    // 已加载的内容不能被清掉
    expect(cells().length).toBe(before);
    expect(screen.queryByTestId("sorting-load-error")).toBeNull();

    // 重试可继续
    spy.mockRestore();
    await user.click(screen.getByTestId("sorting-load-more"));
    await waitFor(() =>
      expect(screen.getByTestId("sorting-remaining").textContent).toContain("1240"),
    );
  });

  it("#3 索引驱动的刷新失败要发通知，不静默", async () => {
    const user = userEvent.setup();
    let emit: ((e: IndexProgressEvent) => void) | null = null;
    const subSpy = vi
      .spyOn(api, "subscribeIndexProgress")
      .mockImplementation((onEvent: (e: IndexProgressEvent) => void) => {
        emit = onEvent;
        return { dispose: () => {}, ready: Promise.resolve() };
      });

    await renderSorting();
    const listSpy = vi
      .spyOn(api, "listPendingAssets")
      .mockRejectedValue(new Error("NAS 断连"));

    act(() =>
      emit?.({
        projectId: project.id,
        indexed: 1240,
        total: 1240,
        running: false,
        failed: 0,
        missing: 0,
        round: 1,
        occurredAt: new Date().toISOString(),
      }),
    );

    await waitFor(() => expect(listSpy).toHaveBeenCalled(), { timeout: 4000 });
    await user.click(screen.getByTestId("notice-bell"));
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("notice-item")
          .some((n) => n.getAttribute("data-code") === "sorting-refresh-failed"),
      ).toBe(true),
    );

    listSpy.mockRestore();
    subSpy.mockRestore();
  }, 15000);

  it("#4 分类计数刷新失败要发通知，不静默陈旧", async () => {
    const user = userEvent.setup();
    await renderSorting();

    const spy = vi
      .spyOn(api, "listCategories")
      .mockRejectedValue(new Error("NAS 断连"));

    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    fireEvent.keyDown(grid(), { key: "1" });

    await user.click(screen.getByTestId("notice-bell"));
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("notice-item")
          .some((n) => n.getAttribute("data-code") === "categories-refresh-failed"),
      ).toBe(true),
    );
    spy.mockRestore();
  }, 10000);

  it("可以继续加载下一页", async () => {
    const user = userEvent.setup();
    await renderSorting();

    expect(screen.getByTestId("sorting-load-more").textContent).toContain("还有 1040");
    await user.click(screen.getByTestId("sorting-load-more"));

    await waitFor(() =>
      expect(screen.getByTestId("sorting-load-more").textContent).toContain("还有 840"),
    );
  });
});
