/**
 * 插画素材的守卫测试：不评价"像不像"，只锁三件会真出事的事——
 * ① 渐变 id 每个实例唯一（同屏两张卡片插画共用 id 会互相串色）；
 * ② 空态插画是装饰，必须 aria-hidden，语义由文字承担；
 * ③ 流向图是信息图，必须带可读的 aria-label 而不是藏起来。
 */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  IllCameraEmpty,
  IllCardsEmpty,
  IllCopyEmpty,
  IllCopyFlow,
  IllProjectsEmpty,
  IllSortingEmpty,
  IllTranscodeEmpty,
  IllTrashEmpty,
} from "./illustrations";
import { EmptyState } from "./ui";

const EMPTY_STATES = [
  ["拷卡任务", IllCopyEmpty],
  ["设备登记·相机", IllCameraEmpty],
  ["设备登记·存储卡", IllCardsEmpty],
  ["分类工作台", IllSortingEmpty],
  ["项目", IllProjectsEmpty],
  ["代理转码", IllTranscodeEmpty],
  ["回收站", IllTrashEmpty],
] as const;

describe("空态插画", () => {
  for (const [name, Ill] of EMPTY_STATES) {
    it(`${name}：渲染为 aria-hidden 的 SVG`, () => {
      const { container } = render(<Ill />);
      const svg = container.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
    });
  }

  it("同屏渲染两个实例时渐变 id 不冲突", () => {
    const { container } = render(
      <>
        <IllCopyEmpty />
        <IllCopyEmpty />
      </>,
    );
    const ids = [...container.querySelectorAll("linearGradient, radialGradient, filter")].map(
      (el) => el.id,
    );
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("EmptyState 传入插画时替换 box-drawing 树杈，不传时保持原样", () => {
    const withArt = render(<EmptyState art={<IllTrashEmpty />}>回收站是空的。</EmptyState>);
    expect(withArt.container.querySelector(".list__empty-art svg")).not.toBeNull();
    expect(withArt.container.textContent).not.toContain("∅");

    const plain = render(<EmptyState>暂无文件明细。</EmptyState>);
    expect(plain.container.textContent).toContain("∅");
  });
});

describe("拷贝流向图", () => {
  it("是信息图：带描述性 aria-label，目的地名称进入标签", () => {
    const { container } = render(<IllCopyFlow destinations={["NAS 主", "移动盘"]} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toContain("NAS 主");
    expect(svg?.getAttribute("aria-label")).toContain("移动盘");
    expect(svg?.getAttribute("aria-label")).toContain("双端校验");
  });

  it("目的地缺省时用通用文案补位", () => {
    const { container } = render(<IllCopyFlow />);
    expect(container.querySelector("svg")?.getAttribute("aria-label")).toContain("目的地 A");
  });
});
