/**
 * 通用小组件的动效相关行为。
 *
 * 重点不在"动得好不好看"，而在两件会真出事的事：
 * ① 进度条必须走 transform，不能回到 width——拷卡屏一屏几十条进度同时在动，
 *    width 每帧都要重排；
 * ② 变化提示只在**真的变了**时出现，首次挂载不出现——否则一进屏几十个徽标
 *    一起弹，是噪音不是反馈。
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Badge, ProgressBar, PulseValue } from "./ui";

afterEach(cleanup);

describe("ProgressBar", () => {
  it("填充走 scaleX，不再用 width（width 会每帧重排）", () => {
    render(<ProgressBar value={30} total={120} label="拷贝进度" />);
    const bar = screen.getByRole("progressbar").firstElementChild as HTMLElement;

    expect(bar.style.transform).toBe("scaleX(0.25)");
    expect(bar.style.width).toBe("");
  });

  it("语义值照旧对外可见：动效换了实现，读屏器读到的东西一个字没变", () => {
    render(
      <ProgressBar value={30} total={120} label="拷贝进度" valueText="30 / 120" />,
    );
    const meter = screen.getByRole("progressbar");

    expect(meter.getAttribute("aria-valuenow")).toBe("25");
    expect(meter.getAttribute("aria-valuetext")).toBe("30 / 120");
    expect(meter.getAttribute("aria-label")).toBe("拷贝进度");
  });

  it("总量为 0 时收敛到 0，不产生 NaN 变换", () => {
    render(<ProgressBar value={5} total={0} decorative />);
    const bar = document.querySelector(".progress__bar") as HTMLElement;
    expect(bar.style.transform).toBe("scaleX(0)");
  });
});

describe("Badge 换档提示", () => {
  it("首次挂载不打提示标记", () => {
    render(<Badge tone="warn">运行中</Badge>);
    expect(screen.getByText("运行中").getAttribute("data-pulse")).toBeNull();
  });

  it("tone 变了才打标记；文案变化不算换档", async () => {
    const view = render(<Badge tone="warn">运行中</Badge>);

    await act(async () => {
      view.rerender(<Badge tone="warn">仍在运行</Badge>);
    });
    expect(screen.getByText("仍在运行").getAttribute("data-pulse")).toBeNull();

    await act(async () => {
      view.rerender(<Badge tone="ok">已完成</Badge>);
    });
    expect(screen.getByText("已完成").getAttribute("data-pulse")).toBe("1");
  });
});

describe("PulseValue", () => {
  it("首次渲染不带动画类，值变了才带", async () => {
    const view = render(<PulseValue className="chip__count" value={3} />);
    expect(screen.getByText("3").className).toBe("chip__count");

    await act(async () => {
      view.rerender(<PulseValue className="chip__count" value={4} />);
    });
    expect(screen.getByText("4").className).toContain("pulse-value");
    expect(screen.getByText("4").className).toContain("chip__count");
  });

  it("值没变就不重复提示", async () => {
    const view = render(<PulseValue value={7} />);
    await act(async () => {
      view.rerender(<PulseValue value={7} />);
    });
    expect(screen.getByText("7").className).toBe("");
  });
});
