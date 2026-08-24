/** 分类工作台：键盘流、两段式删除、部分失败的诚实处理。 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import * as api from "../api";
import { mockCategories, mockProjects, mockWorkstation } from "../api/mock";

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
