import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VirtualGrid, visibleRange } from "./VirtualGrid";

afterEach(cleanup);

describe("visibleRange", () => {
  it("只覆盖可视行 + 上下各 2 行预渲染", () => {
    // 每行 6 个、行距 100、视口 600 → 6 行可见，加 4 行 overscan
    const { startIndex, endIndex } = visibleRange(1000, 6, 100, 0, 600);
    expect(startIndex).toBe(0);
    expect(endIndex).toBe(10 * 6);
  });

  it("滚动后窗口跟着走，不是从头渲染", () => {
    const { startIndex, endIndex } = visibleRange(1000, 6, 100, 2000, 600);
    // 第 20 行 - 2 行 overscan = 第 18 行起
    expect(startIndex).toBe(18 * 6);
    expect(endIndex).toBeLessThan(1000);
    expect(endIndex - startIndex).toBeLessThanOrEqual(10 * 6);
  });

  it("末尾不越界", () => {
    const { endIndex } = visibleRange(1000, 6, 100, 100000, 600);
    expect(endIndex).toBe(1000);
  });

  it("视口高度未知时给一个可用的估计值，不至于什么都不渲染", () => {
    const { startIndex, endIndex } = visibleRange(1000, 6, 100, 0, 0);
    expect(startIndex).toBe(0);
    expect(endIndex).toBeGreaterThan(0);
  });
});

describe("VirtualGrid 渲染", () => {
  const items = Array.from({ length: 1240 }, (_, i) => ({ id: `a-${i}` }));

  it("千张素材只渲染窗口内的少量节点", () => {
    render(
      <VirtualGrid
        items={items}
        minCellWidth={148}
        rowHeight={140}
        gap={8}
        keyOf={(item) => item.id}
        renderItem={(item) => <div data-testid="cell">{item.id}</div>}
      />,
    );

    const rendered = screen.getAllByTestId("cell");
    expect(rendered.length).toBeGreaterThan(0);
    // 关键：绝不是 1240 个
    expect(rendered.length).toBeLessThan(100);
    expect(screen.getByTestId("virtual-grid").getAttribute("aria-rowcount")).toBe(
      String(Math.ceil(1240 / 6)),
    );
  });

  it("首屏渲染的是开头那批", () => {
    render(
      <VirtualGrid
        items={items}
        minCellWidth={148}
        rowHeight={140}
        gap={8}
        keyOf={(item) => item.id}
        renderItem={(item) => <div data-testid="cell">{item.id}</div>}
      />,
    );
    expect(screen.getByText("a-0")).toBeDefined();
    expect(screen.queryByText("a-1000")).toBeNull();
  });
});
