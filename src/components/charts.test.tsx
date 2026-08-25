/**
 * 渐变图表的行为契约。
 *
 * 重点不在画得像不像，而在三件会真出事的事：
 * ① 采样只认 revision 推进 + 抽稀间隔——否则挂起时一串 0 把曲线拖没；
 * ② 换任务必须立刻清空，不能把上一张卡的曲线接到新卡头上；
 * ③ 图形对读屏器要有等价语义（当前/峰值、百分比），不能是哑巴图片。
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProgressRing,
  SPEED_SAMPLE_MIN_MS,
  SpeedSparkline,
  useSpeedSamples,
} from "./charts";

afterEach(cleanup);

function SamplesHarness({
  taskId,
  revision,
  speed,
  active,
}: {
  taskId: string | null;
  revision: number;
  speed: number;
  active: boolean;
}) {
  const samples = useSpeedSamples(taskId, revision, speed, active);
  return <output data-testid="samples">{samples.join(",")}</output>;
}

describe("useSpeedSamples", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T09:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function advance(ms: number) {
    vi.setSystemTime(Date.now() + ms);
  }

  it("revision 推进且间隔够了才采样；同 revision 重渲染不重复采", async () => {
    const view = render(
      <SamplesHarness taskId="t1" revision={1} speed={100} active />,
    );
    expect(screen.getByTestId("samples").textContent).toBe("100");

    // 同 revision，速度字段抖动也不该多出样本
    await act(async () => {
      view.rerender(<SamplesHarness taskId="t1" revision={1} speed={150} active />);
    });
    expect(screen.getByTestId("samples").textContent).toBe("100");

    await act(async () => {
      advance(SPEED_SAMPLE_MIN_MS + 10);
      view.rerender(<SamplesHarness taskId="t1" revision={2} speed={200} active />);
    });
    expect(screen.getByTestId("samples").textContent).toBe("100,200");
  });

  it("间隔不足时抽稀掉，避免 200ms 一条把窗口挤成二十秒", async () => {
    const view = render(
      <SamplesHarness taskId="t1" revision={1} speed={100} active />,
    );
    await act(async () => {
      advance(SPEED_SAMPLE_MIN_MS - 100);
      view.rerender(<SamplesHarness taskId="t1" revision={2} speed={200} active />);
    });
    expect(screen.getByTestId("samples").textContent).toBe("100");
  });

  it("不在拷贝态就不采样：挂起后曲线冻结，不被 0 拖没", async () => {
    const view = render(
      <SamplesHarness taskId="t1" revision={1} speed={100} active />,
    );
    await act(async () => {
      advance(SPEED_SAMPLE_MIN_MS + 10);
      view.rerender(
        <SamplesHarness taskId="t1" revision={2} speed={0} active={false} />,
      );
    });
    expect(screen.getByTestId("samples").textContent).toBe("100");
  });

  it("换任务立刻清空，旧曲线一帧都不许接到新任务头上", async () => {
    const view = render(
      <SamplesHarness taskId="t1" revision={1} speed={100} active />,
    );
    await act(async () => {
      advance(SPEED_SAMPLE_MIN_MS + 10);
      view.rerender(<SamplesHarness taskId="t2" revision={1} speed={300} active />);
    });
    expect(screen.getByTestId("samples").textContent).toBe("300");
  });
});

describe("SpeedSparkline", () => {
  it("不足两点不渲染：连不成线的空图是噪音", () => {
    render(<SpeedSparkline samples={[100]} />);
    expect(screen.queryByTestId("speed-sparkline")).toBeNull();
  });

  it("对读屏器给出当前与峰值的等价语义", () => {
    render(
      <SpeedSparkline
        samples={[100 * 1024 * 1024, 300 * 1024 * 1024, 200 * 1024 * 1024]}
        label="拷贝速度曲线"
      />,
    );
    const chart = screen.getByRole("img");
    expect(chart.getAttribute("aria-label")).toContain("当前 200 MB/s");
    expect(chart.getAttribute("aria-label")).toContain("峰值 300 MB/s");
  });

  it("面积填充引用本实例的渐变，多个曲线同屏也不串 id", () => {
    render(<SpeedSparkline samples={[1, 2, 3]} />);
    const chart = screen.getByTestId("speed-sparkline");
    const gradient = chart.querySelector("linearGradient") as SVGElement;
    const area = chart.querySelector("path") as SVGElement;
    expect(gradient.id).not.toBe("");
    expect(area.getAttribute("fill")).toBe(`url(#${gradient.id})`);
  });

  it("悬停显示该点速度，移出即撤", () => {
    render(<SpeedSparkline samples={[100 * 1024 * 1024, 200 * 1024 * 1024]} />);
    const chart = screen.getByTestId("speed-sparkline");
    vi.spyOn(chart, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 100,
      bottom: 84,
      width: 100,
      height: 84,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerMove(chart, { clientX: 100 });
    expect(chart.querySelector(".sparkline__tip")?.textContent).toBe("200 MB/s");

    fireEvent.pointerLeave(chart);
    expect(chart.querySelector(".sparkline__tip")).toBeNull();
  });
});

describe("ProgressRing", () => {
  it("语义与几何一致：50% 时 dashoffset 是周长的一半", () => {
    render(<ProgressRing value={50} total={100} label="分类进度" />);
    const ring = screen.getByRole("img");
    expect(ring.getAttribute("aria-label")).toBe("分类进度：50%");

    const fill = ring.querySelector(".ring__fill") as SVGCircleElement;
    const circumference = Number(fill.getAttribute("stroke-dasharray"));
    const offset = Number(fill.getAttribute("stroke-dashoffset"));
    expect(offset).toBeCloseTo(circumference / 2, 5);
  });

  it("总量为 0 收敛到 0%，不产生 NaN 几何", () => {
    render(<ProgressRing value={5} total={0} label="分类进度" />);
    const ring = screen.getByRole("img");
    expect(ring.getAttribute("aria-label")).toBe("分类进度：0%");
    const fill = ring.querySelector(".ring__fill") as SVGCircleElement;
    expect(fill.getAttribute("stroke-dashoffset")).not.toContain("NaN");
  });
});
