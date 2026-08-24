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
import { mockCategories, mockProjects, mockWorkstation } from "../api/mock";
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
