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
import { NoticeToasts } from "../components/NotificationCenter";
import { SortingScreen } from "./SortingScreen";
import { StoreProvider, useStore } from "../state/store";
import { ThemeProvider } from "../state/theme";
import { WindowBridgeProvider } from "../state/windowBridge";
import type {
  AssetPage,
  BulkResult,
  IndexProgressEvent,
  SortingAsset,
} from "../api/types";

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
  /*
   * 等光标自动落位（B4）落定再返回。
   * 它是在 effect 里做的，而 findAllByTestId 可能在「格子已挂载、effect 还没跑」
   * 的一瞬间就返回——那时第一下方向键会被当成「从无光标开始」而少走一格，
   * 用例随机少一位（实测偶发过一次）。
   */
  await waitFor(() =>
    expect(document.querySelector(".asset--focused")).not.toBeNull(),
  );
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

  /**
   * 空格 = 预览（Quick Look 语义）。这是 macOS 上「看一眼这是什么」的通用
   * 肌肉记忆，选片时「看清楚」的频次也远高于「加选」。切换选中让给 X。
   */
  it("空格打开全屏预览（Enter 保持同义）", async () => {
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    fireEvent.keyDown(grid(), { key: " " });
    expect(screen.getByTestId("asset-lightbox")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("asset-lightbox")).toBeNull());

    fireEvent.keyDown(grid(), { key: "Enter" });
    expect(screen.getByTestId("asset-lightbox")).toBeTruthy();
  });

  it("X 切换选中；空格不再是选中", async () => {
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    expect(screen.getByTestId("sorting-selected-count").textContent).toContain("已选 1");

    // X 取消当前光标项的选中
    fireEvent.keyDown(grid(), { key: "x" });
    expect(screen.queryByTestId("sorting-selected-count")).toBeNull();

    // 再按一次加回来
    fireEvent.keyDown(grid(), { key: "X" });
    expect(screen.getByTestId("sorting-selected-count").textContent).toContain("已选 1");

    // 空格走的是预览，不动选区
    fireEvent.keyDown(grid(), { key: " " });
    expect(screen.getByTestId("asset-lightbox")).toBeTruthy();
  });

  it("底部提示条不说谎：空格写成预览、选中写成 X", async () => {
    await renderSorting();
    const hint = screen.getByTestId("sorting-hint-preview");
    expect(hint.textContent).toContain("空格");
    expect(hint.textContent).toContain("预览");
    const foot = hint.parentElement!;
    expect(foot.textContent).toContain("X 选中");
    // 旧文案「空格 选中」必须已经消失
    expect(foot.textContent).not.toContain("空格 选中");
  });

  /**
   * 画廊模式只做接线：组件本体由 components/GalleryView.tsx 负责。
   * 这里只钉住「切换真的换了视图，且换视图这件事说清楚了」，
   * 不去断言画廊内部结构——那是它自己的用例的事。
   */
  it("工具条能在网格 / 画廊之间切视图，并说明画廊会拆开连拍组", async () => {
    const user = userEvent.setup();
    await renderSorting();

    const wrap = grid();
    expect(wrap.getAttribute("data-view")).toBe("grid");
    expect(screen.queryByTestId("sorting-gallery-note")).toBeNull();

    await user.click(screen.getByTestId("sorting-view-gallery"));
    await waitFor(() => expect(grid().getAttribute("data-view")).toBe("gallery"));
    expect(
      screen.getByTestId("sorting-view-gallery").getAttribute("aria-pressed"),
    ).toBe("true");
    // 画廊把连拍组拆成逐张——计数口径变了就得说破
    expect(screen.getByTestId("sorting-gallery-note").textContent).toContain(
      "逐张平铺",
    );

    await user.click(screen.getByTestId("sorting-view-grid"));
    await waitFor(() => expect(grid().getAttribute("data-view")).toBe("grid"));
  });

  it("网格里 Shift+D 遇上空清单也会说明原因，不是按了没反应", async () => {
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "D", shiftKey: true });

    const toast = await screen.findByTestId("notice-toast-warning");
    expect(toast.getAttribute("data-code")).toBe("sorting-delete-empty");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Enter 打开全屏预览，左右切换、Esc 关闭", async () => {
    await renderSorting();

    // 素材载入后光标已经落在首项(见「刚进网格就能用键盘」那条),
    // 所以这里不必先按方向键——直接 Enter 开的就是第 1 张
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

    // 往后翻两张再退出。起点是第 2 张(光标默认落在首项,上面又按了一次 →)
    fireEvent.keyDown(document, { key: "ArrowRight" });
    fireEvent.keyDown(document, { key: "ArrowRight" });
    await waitFor(() =>
      expect(screen.getByTestId("lightbox-position").textContent).toBe("4 / 200"),
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

/* ================================================================== *
 * 键盘契约 / 焦点管理 / 静默落空（两路评审交叉收敛的必修项）
 * ================================================================== */

describe("B4 刚进网格（还没点过任何格子）键盘就能用", () => {
  it("★ 素材载入后光标自动落在首项，不必先用鼠标点一下", async () => {
    await renderSorting();
    expect(focusedAsset()).toBe(cells()[0].getAttribute("data-asset"));
  });

  it("★ 一次鼠标都不碰：直接按 D 就能标删，不再是按了没反应", async () => {
    await renderSorting();
    fireEvent.keyDown(grid(), { key: "d" });
    expect(screen.getByTestId("sorting-pending-delete").textContent).toContain(
      "已标记 1 个待删除",
    );
  });

  it("★ 一次鼠标都不碰：直接按数字键就能分类首项", async () => {
    const move = vi.spyOn(api, "moveAssets");
    await renderSorting();
    const first = cells()[0].getAttribute("data-asset");

    fireEvent.keyDown(grid(), { key: "1" });
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    expect(move.mock.calls[0][1]).toEqual([first]);
  });

  it("光标自动落位只落 cursor，不预先选中——下一次打标仍只作用于光标格", async () => {
    await renderSorting();
    expect(screen.queryByTestId("sorting-selected-count")).toBeNull();
  });
});

describe("B1 被锁 / 被拒时不许伪装成功", () => {
  it("★ 上一批还在飞时，大图里再按数字键：不前进、不下发，并说明原因", async () => {
    const move = vi
      .spyOn(api, "moveAssets")
      .mockImplementation(() => new Promise(() => {}));
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "Enter" });
    await screen.findByTestId("asset-lightbox");
    expect(screen.getByTestId("lightbox-position").textContent).toBe("1 / 200");

    // 第一下受理：正常前进到第 2 张
    fireEvent.keyDown(document, { key: "1" });
    await waitFor(() =>
      expect(screen.getByTestId("lightbox-position").textContent).toBe("2 / 200"),
    );
    expect(move).toHaveBeenCalledTimes(1);

    // 第二下被拒：**必须原地不动**，否则用户会以为第 2 张也分好了类
    fireEvent.keyDown(document, { key: "1" });
    const toast = await screen.findByTestId("notice-toast-warning");
    expect(toast.getAttribute("data-code")).toBe("sorting-action-busy");
    expect(toast.textContent).toContain("没有被接受");
    expect(screen.getByTestId("lightbox-position").textContent).toBe("2 / 200");
    expect(move).toHaveBeenCalledTimes(1);

    move.mockRestore();
  });

  it("★ 筛到空集后按 P：没有作用对象要当面说清，而不是按了没反应", async () => {
    const curate = vi.spyOn(api, "curateAssets");
    const user = userEvent.setup();
    // 全部已判定且都不糊：切到「糊片」后命中 0 条，网格里连光标都没有
    const judged = ["J/a.JPG", "J/b.JPG"].map((id) => ({
      ...mockPendingAssets[0],
      id,
      fileName: id,
      groupId: undefined,
      judgement: {
        score: 90,
        faces: 1,
        blurry: false,
        overExposed: false,
        underExposed: false,
        suggestedKeep: false,
      },
    }));
    const listSpy = vi
      .spyOn(api, "listPendingAssets")
      .mockResolvedValue({ items: judged, total: judged.length });

    render(<App preloaded={preloaded} />);
    await screen.findAllByTestId("asset-cell");

    await user.click(screen.getByTestId("sorting-judge-filter"));
    await user.click(screen.getByRole("option", { name: "糊片" }));
    await screen.findByTestId("sorting-filter-empty");

    fireEvent.keyDown(grid(), { key: "p" });

    const toast = await screen.findByTestId("notice-toast-warning");
    expect(toast.getAttribute("data-code")).toBe("sorting-action-no-target");
    expect(toast.textContent).toContain("先用方向键");
    expect(curate).not.toHaveBeenCalled();

    listSpy.mockRestore();
    curate.mockRestore();
  });
});

describe("B2 U 只撤回标删，绝不反手把素材标进待删清单", () => {
  it("★ 网格：对未标记项按 U，待删清单不许凭空出现，并且说明为什么没反应", async () => {
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "u" });

    const toast = await screen.findByTestId("notice-toast-warning");
    expect(toast.getAttribute("data-code")).toBe("sorting-action-not-marked");
    expect(toast.textContent).toContain("要标删请按 D");
    // 关键：U 之后绝不能出现待删条
    expect(screen.queryByTestId("sorting-pending-delete")).toBeNull();
  });

  it("★ 大图：对未标记那张按 U，不标删也不前进（前进等于把这件事藏起来）", async () => {
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "Enter" });
    await screen.findByTestId("asset-lightbox");
    expect(screen.getByTestId("lightbox-position").textContent).toBe("1 / 200");

    fireEvent.keyDown(document, { key: "u" });

    const toast = await screen.findByTestId("notice-toast-warning");
    expect(toast.getAttribute("data-code")).toBe("sorting-action-not-marked");
    expect(screen.queryByTestId("sorting-pending-delete")).toBeNull();
    expect(screen.getByTestId("lightbox-position").textContent).toBe("1 / 200");
  });

  it("★ 画廊：对未标记项按 U 同样不许标删（组件内部把 U 并进了 toggle，本屏必须拦下）", async () => {
    const user = userEvent.setup();
    await renderSorting();

    await user.click(screen.getByTestId("sorting-view-gallery"));
    const gallery = await screen.findByTestId("gallery-view");

    fireEvent.keyDown(gallery, { key: "u" });

    const toast = await screen.findByTestId("notice-toast-warning");
    expect(toast.getAttribute("data-code")).toBe("sorting-action-not-marked");
    expect(screen.queryByTestId("sorting-pending-delete")).toBeNull();
  });

  it("U 对**已标记**项照常撤回（撤回本职不能被上面那些防线误伤）", async () => {
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "d" });
    expect(screen.getByTestId("sorting-pending-delete")).toBeTruthy();

    fireEvent.keyDown(grid(), { key: "u" });
    expect(screen.queryByTestId("sorting-pending-delete")).toBeNull();
  });
});

describe("B7 快捷键不劫持已聚焦按钮的 Enter / 空格", () => {
  it("★ Tab 到大图的「上一张」按回车：执行的是按钮，大图不会被收起", async () => {
    const user = userEvent.setup();
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    fireEvent.keyDown(grid(), { key: "Enter" });
    await screen.findByTestId("asset-lightbox");
    expect(screen.getByTestId("lightbox-position").textContent).toBe("2 / 200");

    const prev = screen.getByTestId("lightbox-prev") as HTMLButtonElement;
    prev.focus();
    expect(document.activeElement).toBe(prev);

    await user.keyboard("{Enter}");

    // 旧行为：Enter 被解释成「退一层」并 preventDefault，大图直接关掉、按钮不执行
    expect(screen.queryByTestId("asset-lightbox")).not.toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("lightbox-position").textContent).toBe("1 / 200"),
    );
  });
});

describe("B8 画廊「光标已丢失」的告警必须在真实接线下触发", () => {
  it("★ 聚焦项被筛选排除后，屏上真的出现告警（此前父层抢先抹平，这段是死代码）", async () => {
    const user = userEvent.setup();
    await renderSorting();

    await user.click(screen.getByTestId("sorting-view-gallery"));
    const gallery = await screen.findByTestId("gallery-view");
    // 把聚焦项挪到第 2 张（mock 里它不是糊片）
    fireEvent.keyDown(gallery, { key: "ArrowRight" });
    await waitFor(() =>
      expect(screen.getByTestId("gallery-position").textContent).toContain("第 2 张"),
    );

    // 「糊片」把它筛出列表 —— 聚焦项就此失效
    await user.click(screen.getByTestId("sorting-judge-filter"));
    await user.click(screen.getByRole("option", { name: "糊片" }));

    const alert = await screen.findByTestId("gallery-cursor-lost");
    expect(alert.textContent).toContain("已不在当前列表里");
  });
});

describe("B9 帮助层压在最上层，并且真的拿得到按键", () => {
  it("★ 大图开着时按 ?：速查表在大图之上，Esc 关的是速查表而不是背后的大图", async () => {
    const user = userEvent.setup();
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "Enter" });
    await screen.findByTestId("asset-lightbox");

    fireEvent.keyDown(document, { key: "?" });
    const help = await screen.findByTestId("keyboard-help");
    // 普通 .overlay 是 z=50，会被组层(55)/大图(60)盖住
    expect(help.parentElement?.className).toContain("overlay--keyhelp");
    // 焦点收进速查表，Tab 才有可圈定的起点
    expect(help.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("keyboard-help")).toBeNull());
    // 背后那张大图必须还在：Esc 属于最上面那一层
    expect(screen.queryByTestId("asset-lightbox")).not.toBeNull();
  });

  it("★ 大图开屏就把焦点收进来，Tab 圈在层内，跑不到背后的网格上", async () => {
    const user = userEvent.setup();
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "Enter" });
    const box = await screen.findByTestId("asset-lightbox");
    expect(box.contains(document.activeElement)).toBe(true);

    const focusables = Array.from(
      box.querySelectorAll<HTMLElement>("button:not([disabled])"),
    );
    expect(focusables.length).toBeGreaterThan(1);

    focusables[focusables.length - 1].focus();
    await user.keyboard("{Tab}");
    expect(box.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(focusables[0]);
  });

  it("速查表把连拍组里的 U 与 Shift+D 也写进去了（键位存在却学不到 = 没有）", async () => {
    await renderSorting();
    fireEvent.keyDown(document, { key: "?" });
    const help = await screen.findByTestId("keyboard-help");

    const groupSection = within(help)
      .getByText("连拍组全屏")
      .closest(".keyhelp__section") as HTMLElement;
    expect(groupSection.textContent).toContain("U");
    expect(groupSection.textContent).toContain("Shift + D");
  });
});

/* ------------------------------------------------------------------ *
 * B5 切项目：旧项目的异步响应一律作废
 * ------------------------------------------------------------------ */

/** 只挂 SortingScreen + 一个切项目按钮：App 自建 Provider，外面够不着 store */
function SwitchProjectButton({ to }: { to: string }) {
  const { dispatch } = useStore();
  return (
    <button
      type="button"
      data-testid="test-switch-project"
      onClick={() => dispatch({ type: "selectProject", projectId: to })}
    >
      切项目
    </button>
  );
}

function renderSortingWithSwitch(to: string) {
  return render(
    <ThemeProvider>
      <StoreProvider preloaded={preloaded}>
        <WindowBridgeProvider role="main">
          <SortingScreen />
          <SwitchProjectButton to={to} />
          <NoticeToasts />
        </WindowBridgeProvider>
      </StoreProvider>
    </ThemeProvider>,
  );
}

function fakeAsset(id: string): SortingAsset {
  return { ...mockPendingAssets[0], id, fileName: id, judgement: undefined };
}

/** 把交付打包推成 running：分类 / 删除链路的互斥全靠它 */
function StartDeliveryButton() {
  const { dispatch } = useStore();
  return (
    <button
      type="button"
      data-testid="test-start-delivery"
      onClick={() =>
        dispatch({
          type: "jobProgress",
          job: {
            id: "job-delivery",
            kind: "delivery",
            projectId: project.id,
            state: "running",
            done: 1,
            total: 10,
            bytesDone: 0,
            revision: 1,
            startedAt: new Date().toISOString(),
          },
        })
      }
    >
      开始打包
    </button>
  );
}

describe("A2 确认之后、下发之前被拦下，也必须说出来", () => {
  it("★ 破坏性动作凭空蒸发是最坏的一种静默：对话框照常消失，但要有可见交代", async () => {
    const user = userEvent.setup();
    const trash = vi.spyOn(api, "trashAssets");

    render(
      <ThemeProvider>
        <StoreProvider preloaded={preloaded}>
          <WindowBridgeProvider role="main">
            <SortingScreen />
            <StartDeliveryButton />
            <NoticeToasts />
          </WindowBridgeProvider>
        </StoreProvider>
      </ThemeProvider>,
    );
    await screen.findAllByTestId("asset-cell");
    await waitFor(() =>
      expect(document.querySelector(".asset--focused")).not.toBeNull(),
    );

    fireEvent.keyDown(screen.getByTestId("sorting-grid-wrap"), { key: "d" });
    await user.click(screen.getByTestId("sorting-confirm-delete"));
    await screen.findByRole("alertdialog");

    // 确认框已经开着、用户正要按下红色按钮的那一瞬间，交付作业转 running
    await user.click(screen.getByTestId("test-start-delivery"));
    await user.click(screen.getByRole("button", { name: "移入回收站" }));

    /*
     * 旧行为：`commitDelete` 一句静默 `return`，而 ConfirmDialog 无条件
     * `close()`——对话框正常消失，一个**已经二次确认过的破坏性动作凭空蒸发**：
     * 没有 toast、没有通知、没有内联提示。
     */
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(trash).not.toHaveBeenCalled();

    const toast = await screen.findByTestId("notice-toast-warning");
    expect(toast.getAttribute("data-code")).toBe("sorting-delete-blocked");
    expect(toast.textContent).toContain("待删标记一个没少");

    // 标记必须原样留着，而且清单还能再提交（状态机没有卡在 confirming）
    expect(screen.getByTestId("sorting-pending-delete").textContent).toContain(
      "已标记 1 个待删除",
    );
    trash.mockRestore();
  }, 15000);
});

describe("B5 切项目后旧项目的响应不许灌进新项目的网格", () => {
  it("★ 索引驱动的重拉在切项目后返回：整批丢弃，计数与格子都不受污染", async () => {
    const other = mockProjects.find((p) => p.id !== project.id)!;
    const oldItems = ["OLD/a.JPG", "OLD/b.JPG"].map(fakeAsset);
    const newItems = ["NEW/a.JPG", "NEW/b.JPG", "NEW/c.JPG"].map(fakeAsset);
    const poison = ["OLD/x.JPG", "OLD/y.JPG"].map(fakeAsset);

    let releaseStale: ((page: AssetPage) => void) | null = null;
    let oldCalls = 0;
    const listSpy = vi
      .spyOn(api, "listPendingAssets")
      .mockImplementation((projectId: string) => {
        if (projectId !== project.id) {
          return Promise.resolve({ items: newItems, total: newItems.length });
        }
        oldCalls += 1;
        // 首屏正常返回；之后那次（索引驱动的重拉）挂住，等切完项目再放
        if (oldCalls === 1) {
          return Promise.resolve({ items: oldItems, total: oldItems.length });
        }
        return new Promise<AssetPage>((resolve) => {
          releaseStale = resolve;
        });
      });

    let emit: ((e: IndexProgressEvent) => void) | null = null;
    const subSpy = vi
      .spyOn(api, "subscribeIndexProgress")
      .mockImplementation((onEvent: (e: IndexProgressEvent) => void) => {
        emit = onEvent;
        return { dispose: () => {}, ready: Promise.resolve() };
      });

    const user = userEvent.setup();
    renderSortingWithSwitch(other.id);
    await screen.findAllByTestId("asset-cell");
    expect(document.querySelector('[data-asset^="OLD/"]')).not.toBeNull();

    // 旧项目的索引推进 → 触发重拉（被挂住）
    act(() =>
      emit?.({
        projectId: project.id,
        indexed: 2,
        total: 2,
        running: false,
        failed: 0,
        missing: 0,
        round: 1,
        occurredAt: new Date().toISOString(),
      }),
    );
    await waitFor(() => expect(oldCalls).toBeGreaterThan(1), { timeout: 4000 });

    // 切到另一个项目
    await user.click(screen.getByTestId("test-switch-project"));
    await waitFor(() =>
      expect(document.querySelector('[data-asset^="NEW/"]')).not.toBeNull(),
    );

    // 旧项目的响应现在才回来，且带着一个显眼的总数
    await act(async () => {
      releaseStale?.({ items: poison, total: 999 });
    });

    // 一格都不许进来，计数也不许被改写
    expect(document.querySelector('[data-asset^="OLD/"]')).toBeNull();
    expect(screen.getByTestId("sorting-remaining").textContent).not.toContain("999");
    expect(screen.getByTestId("sorting-remaining").textContent).toContain("3");

    listSpy.mockRestore();
    subSpy.mockRestore();
  }, 15000);
});

/* ================================================================== *
 * 第二轮评审：零静默 / 焦点交接 / 分页接线
 *
 * 焦点相关的用例一律 `.focus()` + `user.keyboard(...)`（派发到
 * `document.activeElement`）并直接断言 `document.activeElement`——
 * `fireEvent.keyDown(具体元素, …)` 绕过真实焦点链，正是这些 bug
 * 逃过上一轮所有用例的原因。
 * ================================================================== */

/** 让「待删清单提交」停在飞行中：返回 resolve 句柄，用完必须放掉 */
function hangTrash() {
  let release: ((result: BulkResult) => void) | null = null;
  const spy = vi
    .spyOn(api, "trashAssets")
    .mockImplementation(
      () =>
        new Promise<BulkResult>((resolve) => {
          release = resolve;
        }),
    );
  return {
    spy,
    finish: (result: BulkResult = { succeeded: [], failed: [] }) =>
      release?.(result),
  };
}

describe("A1 「取消标记」不许绕过受理闸门", () => {
  it("★ 提交在飞时按钮变灰并当面写明原因，而不是按下去毫无反应", async () => {
    const user = userEvent.setup();
    const trash = hangTrash();
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "d" });
    await user.click(screen.getByTestId("sorting-confirm-delete"));
    await user.click(screen.getByRole("button", { name: "移入回收站" }));
    await waitFor(() => expect(trash.spy).toHaveBeenCalledTimes(1));

    /*
     * 旧行为：这个按钮直接对状态机下发 `clear`，而 reducer 在 working 态
     * 一句 `return state`——按钮可点、点了什么都不发生、零反馈；
     * 同一刻按 D/U 却有明确说明。静默的偏偏是更常用的鼠标那条路。
     */
    const unmarkAll = screen.getByTestId("sorting-unmark-all") as HTMLButtonElement;
    await waitFor(() => expect(unmarkAll.disabled).toBe(true));
    expect(unmarkAll.title).toContain("正在提交进回收站");
    // 只藏在 title 里不算说清楚：屏上要有一行看得见的字
    expect(screen.getByTestId("sorting-commit-busy").textContent).toContain(
      "标记暂时不能改动",
    );
    expect(screen.getByTestId("sorting-pending-delete").textContent).toContain(
      "已标记 1 个待删除",
    );

    trash.finish();
  });

  it("★ 键盘路径给的是同一个答案（口径必须一致）", async () => {
    const user = userEvent.setup();
    const trash = hangTrash();
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "d" });
    await user.click(screen.getByTestId("sorting-confirm-delete"));
    await user.click(screen.getByRole("button", { name: "移入回收站" }));
    await waitFor(() => expect(trash.spy).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(grid(), { key: "u" });
    const toast = await screen.findByTestId("notice-toast-warning");
    expect(toast.getAttribute("data-code")).toBe("sorting-action-commit-busy");

    trash.finish();
  });

  it("提交结束后「取消标记」照常可用，并且真的清空清单", async () => {
    const user = userEvent.setup();
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "d" });
    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    fireEvent.keyDown(grid(), { key: "d" });
    expect(screen.getByTestId("sorting-pending-delete").textContent).toContain(
      "已标记 2 个待删除",
    );

    await user.click(screen.getByTestId("sorting-unmark-all"));
    expect(screen.queryByTestId("sorting-pending-delete")).toBeNull();
  });

  it("提交在飞时再按 Shift+D 不重复下发，并说明为什么", async () => {
    const user = userEvent.setup();
    const trash = hangTrash();
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "d" });
    await user.click(screen.getByTestId("sorting-confirm-delete"));
    await user.click(screen.getByRole("button", { name: "移入回收站" }));
    await waitFor(() => expect(trash.spy).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(grid(), { key: "D", shiftKey: true });
    const toast = await screen.findByTestId("notice-toast-warning");
    expect(toast.getAttribute("data-code")).toBe("sorting-delete-committing");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(trash.spy).toHaveBeenCalledTimes(1);

    trash.finish();
  });
});

describe("C1 控件把自己禁用 / 卸载掉时，焦点不许掉到 body", () => {
  it("★ 点分类 chip：chip 随即 disabled，键盘要有接盘（旧行为焦点落 body）", async () => {
    const user = userEvent.setup();
    // 挂住 moveAssets，让 busy 一直为 true，chip 停在禁用态
    const move = vi
      .spyOn(api, "moveAssets")
      .mockImplementation(() => new Promise(() => {}));
    await renderSorting();

    const chip = screen
      .getAllByTestId("sorting-category")
      .find((c) => c.getAttribute("data-category") === "cat-1") as HTMLButtonElement;
    await user.click(chip);

    await waitFor(() => expect(chip.disabled).toBe(true));
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(grid());

    move.mockRestore();
  });

  it("★ 点「取消标记」：整条待删条随之卸载，焦点回网格且方向键立刻可用", async () => {
    const user = userEvent.setup();
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "d" });
    await user.click(screen.getByTestId("sorting-unmark-all"));

    expect(screen.queryByTestId("sorting-pending-delete")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(grid());

    const before = focusedAsset();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(focusedAsset()).not.toBe(before));
  });

  it("★ 点「撤销」：按钮先禁用、成功后整条卸载，焦点同样要回网格", async () => {
    const user = userEvent.setup();
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "1" });
    await screen.findByTestId("sorting-undo-bar");

    await user.click(screen.getByTestId("sorting-undo"));
    await waitFor(() => expect(screen.queryByTestId("sorting-undo-bar")).toBeNull());

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(grid());

    const before = focusedAsset();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(focusedAsset()).not.toBe(before));
  }, 15000);
});

describe("E2 被分类移走的素材必须离开待删清单", () => {
  it("★ 先按 D 标删、再按 1 分类走：清单要跟着剪掉，不留看不见的条目", async () => {
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "d" });
    expect(screen.getByTestId("sorting-pending-delete").textContent).toContain(
      "已标记 1 个待删除",
    );

    fireEvent.keyDown(grid(), { key: "1" });
    await waitFor(() =>
      expect(screen.getByTestId("sorting-remaining").textContent).toContain("1239"),
    );

    /*
     * 旧行为：素材已经离开待分类夹，却仍算在「已标记 1 个待删除」里——
     * 「只看已标删」筛出来是空的，Shift+D 提交时 trashAssets 对它必然失败，
     * 而失败项按设计**永久留在清单里**，用户除了清空全部之外摘不掉它。
     */
    await waitFor(() =>
      expect(screen.queryByTestId("sorting-pending-delete")).toBeNull(),
    );
  });

  it("★ 状态机真的回到空：此后 Shift+D 说的是「清单是空的」", async () => {
    await renderSorting();

    fireEvent.keyDown(grid(), { key: "d" });
    fireEvent.keyDown(grid(), { key: "1" });
    await waitFor(() =>
      expect(screen.queryByTestId("sorting-pending-delete")).toBeNull(),
    );

    fireEvent.keyDown(grid(), { key: "D", shiftKey: true });
    const toast = await screen.findByTestId("notice-toast-warning");
    expect(toast.getAttribute("data-code")).toBe("sorting-delete-empty");
  });

  it("没被标删的素材被移走时，别人的标记不受影响", async () => {
    await renderSorting();

    // 标第 1 张，然后把第 2 张分类走
    fireEvent.keyDown(grid(), { key: "d" });
    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    fireEvent.keyDown(grid(), { key: "1" });

    await waitFor(() =>
      expect(screen.getByTestId("sorting-remaining").textContent).toContain("1239"),
    );
    expect(screen.getByTestId("sorting-pending-delete").textContent).toContain(
      "已标记 1 个待删除",
    );
  });
});

/* ------------------------------------------------------------------ *
 * 画廊模式：焦点交接 / 分页接线 / 光标口径
 * ------------------------------------------------------------------ */

async function enterGallery(user: ReturnType<typeof userEvent.setup>) {
  await renderSorting();
  await user.click(screen.getByTestId("sorting-view-gallery"));
  const gallery = await screen.findByTestId("gallery-view");
  await waitFor(() =>
    expect(screen.getByTestId("gallery-position").textContent).toContain("第 1 张"),
  );
  return gallery;
}

function galleryPosition() {
  return screen.getByTestId("gallery-position").textContent ?? "";
}

describe("B2 画廊里关掉大图之后，键盘焦点要回到画廊本身", () => {
  it("★ Esc 关掉全屏：activeElement 是画廊根节点，方向键与 Esc 立刻还能用", async () => {
    const user = userEvent.setup();
    const gallery = await enterGallery(user);

    gallery.focus();
    await user.keyboard("{Enter}");
    await screen.findByTestId("asset-lightbox");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("asset-lightbox")).toBeNull());

    /*
     * 旧行为：还原 effect 无条件 `gridWrapRef.current?.focus()`，焦点给了
     * **外层 wrap**；画廊的键盘流挂在它自己的根节点上收不到父节点事件，
     * 而 wrap 的兜底处理器把 move / selectAll / Esc 原样放掉——
     * 方向键与 Esc 全部无反应且零提示，打标键却还能用。
     */
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(screen.getByTestId("gallery-view"));

    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(galleryPosition()).toContain("第 2 张"));

    // Esc 也得有回音（本屏没接「返回网格」，那就当面说清楚）
    await user.keyboard("{Escape}");
    const notice = await screen.findByTestId("gallery-notice");
    expect(notice.textContent).toContain("没有选区可清");
  }, 15000);

  it("★ 画廊模式下外层 wrap 退出 Tab 序，焦点不会停在一个收不到键的容器上", async () => {
    const user = userEvent.setup();
    await enterGallery(user);

    expect(grid().getAttribute("tabindex")).toBe("-1");
    // 兜底：真被点到边缘留白拿了焦点，也要立刻转交给画廊根节点
    grid().focus();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("gallery-view")),
    );
  });
});

describe("D1 画廊的分页边界必须接到真实调用方上（集成，不是孤立组件用例）", () => {
  it("★ 位置栏如实写「已加载 200 张（共 1240 张）」，不再谎报「共 200 张」", async () => {
    const user = userEvent.setup();
    await enterGallery(user);

    /*
     * 旧行为：SortingScreen 一个分页 prop 都没传，组件于是走「已加载即全部」
     * 的降级分支——第 200 张写着「共 200 张」「已经是最后一张」。
     * 用户据此认为选片做完了，剩下 1040 张完全没检查过。
     */
    expect(galleryPosition()).toContain("已加载 200 张");
    expect(galleryPosition()).toContain("共 1240 张");
    expect(galleryPosition()).not.toMatch(/\/\s*共 200 张/);
    expect(screen.getByTestId("gallery-strip-more").textContent).toBe(
      "还有 1040 张未加载",
    );
  });

  it("★ 翻到已加载的第 200 张再往后：真的续拉下一页，不是「已经是最后一张」", async () => {
    const user = userEvent.setup();
    const gallery = await enterGallery(user);

    fireEvent.keyDown(gallery, { key: "End" });
    await waitFor(() => expect(galleryPosition()).toContain("第 200 张"));

    const listSpy = vi.spyOn(api, "listPendingAssets");
    fireEvent.keyDown(gallery, { key: "ArrowRight" });

    const notice = await screen.findByTestId("gallery-notice");
    expect(notice.textContent).not.toContain("已经是最后一张");
    expect(notice.textContent).toContain("已请求继续加载");

    // 现成的 loadMore 必须真的被调到（旧行为：onEndReached 没接，永不续拉）
    await waitFor(() =>
      expect(listSpy.mock.calls.some((c) => c[1] === 200)).toBe(true),
    );
    await waitFor(() => expect(galleryPosition()).toContain("已加载 400 张"));

    listSpy.mockRestore();
  }, 15000);

  it("★ 筛选态不许拿全库 total 冒充筛选结果总数", async () => {
    const user = userEvent.setup();
    await enterGallery(user);

    await user.click(screen.getByTestId("sorting-judge-filter"));
    await user.click(screen.getByRole("option", { name: "糊片" }));

    await waitFor(() => expect(galleryPosition()).toContain("当前筛选已命中"));
    // 库里还没加载的那 1040 张能命中多少，谁也不知道——不许把 1240 说成命中总数
    expect(galleryPosition()).toContain("1040 张未加载");
    expect(galleryPosition()).toContain("能命中多少未知");
    expect(galleryPosition()).not.toContain("1240");
  }, 15000);
});

describe("E1 画廊里不移出列表的动作，在最后一张不许把光标往回跳", () => {
  it("★ 最后一张按 D：光标原地不动，连按两次动的是同一张", async () => {
    const user = userEvent.setup();
    const gallery = await enterGallery(user);

    fireEvent.keyDown(gallery, { key: "End" });
    await waitFor(() => expect(galleryPosition()).toContain("第 200 张"));
    const shown = screen.getByTestId("gallery-path").textContent;

    fireEvent.keyDown(gallery, { key: "d" });
    await screen.findByTestId("sorting-pending-delete");
    expect(screen.getByTestId("sorting-pending-delete").textContent).toContain(
      "已标记 1 个待删除",
    );

    /*
     * 旧行为：D / P / U 与「分类」共用「往前不行就退一张」，而这三种动作
     * **都不把素材移出列表**。于是在最后一张按 D，光标静默退回上一张
     * （刚处理过的那张）；再按一次 D，标的就是那一张——快速收尾时会在
     * 最后两张之间来回反转标记，全程没有提示。大图那边一直是「原地不动」。
     */
    expect(galleryPosition()).toContain("第 200 张");
    expect(screen.getByTestId("gallery-path").textContent).toBe(shown);

    // 再按一次撤回的必须是同一张
    fireEvent.keyDown(gallery, { key: "d" });
    await waitFor(() =>
      expect(screen.queryByTestId("sorting-pending-delete")).toBeNull(),
    );
    expect(galleryPosition()).toContain("第 200 张");
  }, 15000);

  it("★ 最后一张按 P（精选，同样不移出列表）也原地不动", async () => {
    const user = userEvent.setup();
    const curate = vi.spyOn(api, "curateAssets");
    const gallery = await enterGallery(user);

    fireEvent.keyDown(gallery, { key: "End" });
    await waitFor(() => expect(galleryPosition()).toContain("第 200 张"));
    const shown = screen.getByTestId("gallery-path").textContent;

    fireEvent.keyDown(gallery, { key: "p" });
    await waitFor(() => expect(curate).toHaveBeenCalledTimes(1));

    expect(galleryPosition()).toContain("第 200 张");
    expect(screen.getByTestId("gallery-path").textContent).toBe(shown);
    curate.mockRestore();
  }, 15000);

  it("分类会把这张移出列表，末尾时仍然退回上一张（这条分叉是刻意的）", async () => {
    const user = userEvent.setup();
    const gallery = await enterGallery(user);

    fireEvent.keyDown(gallery, { key: "End" });
    await waitFor(() => expect(galleryPosition()).toContain("第 200 张"));

    fireEvent.keyDown(gallery, { key: "1" });
    // 当前这张马上就要消失，末尾时退回上一张是唯一可站的位置
    await waitFor(() => expect(galleryPosition()).toContain("第 199 张"));
    expect(screen.queryByTestId("gallery-cursor-lost")).toBeNull();
  }, 15000);
});

describe("画廊筛到空集时，打标键也不许静默落空", () => {
  it("★ 画廊筛到空集后按数字键：与网格同一句「落空了」，不是按了没反应", async () => {
    const user = userEvent.setup();
    const move = vi.spyOn(api, "moveAssets");
    // 全部已判定且都不糊：切到「糊片」后命中 0 条，画廊里连一张可作用的都没有
    const judged = ["J/a.JPG", "J/b.JPG"].map((id) => ({
      ...mockPendingAssets[0],
      id,
      fileName: id,
      groupId: undefined,
      judgement: {
        score: 90,
        faces: 1,
        blurry: false,
        overExposed: false,
        underExposed: false,
        suggestedKeep: false,
      },
    }));
    const listSpy = vi
      .spyOn(api, "listPendingAssets")
      .mockResolvedValue({ items: judged, total: judged.length });

    await enterGallery(user);
    await user.click(screen.getByTestId("sorting-judge-filter"));
    await user.click(screen.getByRole("option", { name: "糊片" }));
    await screen.findByTestId("sorting-filter-empty");

    fireEvent.keyDown(grid(), { key: "1" });

    // 旧行为：galleryAssign 一句 `if (!galleryCursor) return;`——静默落空
    const toast = await screen.findByTestId("notice-toast-warning");
    expect(toast.getAttribute("data-code")).toBe("sorting-action-no-target");
    expect(move).not.toHaveBeenCalled();

    listSpy.mockRestore();
    move.mockRestore();
  }, 15000);
});
