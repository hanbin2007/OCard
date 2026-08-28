/**
 * 浮层层叠关系的静态闸门(opus 评审 P0 的教训):
 * jsdom 不做布局与命中测试,「确认框被会话门盖住点不到」这类 bug
 * 在组件测试里必然假绿——层级关系只能按 CSS 文本钉死。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

/*
 * 扫描面必须覆盖**所有**声明浮层的表:层叠是全局的,而
 * `.group-layer` / `.lightbox` / `.overlay--keyhelp` 三层住在 screens.css。
 * 上一版只读 components.css,于是这三层整个在契约之外——正是「防线看不见
 * 新东西」这一类假绿(2026-08-28 评审)。
 */
/**
 * 剥注释,用等量空白填回去(下标不变)。
 *
 * 不剥会踩到一个很隐蔽的坑:screens.css 里有一行注释画着层级图
 * `.overlay(50) < .group-layer(55) < .lightbox(60)`,朴素的
 * `indexOf(".group-layer")` 会命中这行注释,再往后找到的 `{...}` 却是
 * **别的规则块**,于是读出一个张冠李戴的 z-index。写这条测试时真的踩了。
 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

const SHEETS = ["components.css", "screens.css"].map((name) => ({
  name,
  css: stripComments(readFileSync(resolve(process.cwd(), "src/styles", name), "utf8")),
}));

/** 逐规则块解析出的 (选择器 → z-index);同一选择器多次声明时取最后一次(级联) */
const Z_BY_SELECTOR: Map<string, number> = (() => {
  const out = new Map<string, number>();
  for (const { css } of SHEETS) {
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = rule.exec(css))) {
      const z = m[2].match(/z-index\s*:\s*(\d+)/);
      if (!z) continue;
      for (const sel of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
        out.set(sel, Number(z[1]));
      }
    }
  }
  return out;
})();

/** 抠出选择器块里的 z-index 数值 */
function zIndexOf(selector: string): number {
  const key = selector.replace(/\s*\{$/, "").trim();
  const z = Z_BY_SELECTOR.get(key);
  if (z === undefined) throw new Error(`样式表里没有带 z-index 的规则块:${key}`);
  return z;
}

/** 供只做文本包含判断的用例使用(已剥注释) */
const css = SHEETS.map((s) => s.css).join("\n");

/**
 * 浮层层级的**完整**名册,按从下到上排。新增一层就必须在这里报到——
 * 下面那条「没有编外浮层」的断言会把漏登记的挡住。
 *
 * 这是 fail-closed 的方向:漏登记判红,而不是默默放行。上一版的做法是
 * 只挑几对来比,新加的层既不在比较里、也没人发现它不在。
 */
const LAYERS: Array<{ selector: string; note: string }> = [
  { selector: ".tag-picker__menu", note: "标签选择器菜单" },
  { selector: ".notice-panel", note: "通知中心面板" },
  { selector: ".quick-copy", note: "快捷拷卡提示(非模态)" },
  { selector: ".overlay {", note: "普通模态浮层(对话框/抽屉)" },
  { selector: ".group-layer", note: "连拍组全屏层" },
  { selector: ".lightbox", note: "大图全屏预览" },
  { selector: ".overlay--keyhelp", note: "快捷键速查表(要压过大图才看得见)" },
  { selector: ".select-pop", note: "下拉浮层" },
  { selector: ".overlay--gate", note: "会话门" },
  { selector: ".overlay--elevated", note: "门上的二次确认" },
  { selector: ".toasts", note: "toast(高于一切:提交失败必须永远可见)" },
];

describe("浮层层叠", () => {
  it("名册里的层级严格递增(相邻两层不许并列,并列即命中顺序看书写次序)", () => {
    const seen = LAYERS.map((l) => ({ ...l, z: zIndexOf(l.selector) }));
    const broken = seen
      .slice(1)
      .filter((cur, i) => cur.z <= seen[i].z)
      .map((cur, i) => `${seen[i].selector}(${seen[i].z}) → ${cur.selector}(${cur.z})`);
    expect(broken, "层级必须严格递增").toEqual([]);
  });

  it("没有编外浮层:每个 z-index ≥ 30 的规则都得在名册里报到", () => {
    // 漏登记的新层 = 谁压谁全凭巧合。30 以下是屏内局部层叠(表头吸顶之类),
    // 不参与浮层排序,所以设了这条门槛。
    const known = new Set(LAYERS.map((l) => l.selector.replace(/\s*\{$/, "").trim()));
    const strays = [...Z_BY_SELECTOR.entries()]
      .filter(([sel, z]) => z >= 30 && !known.has(sel))
      .map(([sel, z]) => `${sel} → z-index: ${z}`);
    expect(
      strays,
      "新增浮层必须登记进 LAYERS 名册并想清楚它压谁、被谁压;" +
        "不登记就等于把层叠交给巧合(2026-08-28 评审:screens.css 里的三层" +
        "整个漏在契约之外)",
    ).toEqual([]);
  });

  it("速查表压过大图与连拍组全屏层(否则按 ? 看着像没反应)", () => {
    // 实测过的失效形态:速查表 z=50 时打开会藏在组层 55 / 大图 60 背后,
    // 用户以为 ? 键坏了,退出全屏后它才突然冒出来。
    expect(zIndexOf(".overlay--keyhelp")).toBeGreaterThan(zIndexOf(".lightbox"));
    expect(zIndexOf(".overlay--keyhelp")).toBeGreaterThan(zIndexOf(".group-layer"));
    // 但不许压过会话门:门是安全边界,任何浮层都不能成为绕门的旁路
    expect(zIndexOf(".overlay--keyhelp")).toBeLessThan(zIndexOf(".overlay--gate"));
  });

  it("会话门(--gate)必须压过普通浮层", () => {
    expect(zIndexOf(".overlay--gate")).toBeGreaterThan(zIndexOf(".overlay {"));
  });

  it("门上的二次确认(--elevated)必须压过门,否则确认框点不到", () => {
    expect(zIndexOf(".overlay--elevated")).toBeGreaterThan(
      zIndexOf(".overlay--gate"),
    );
  });

  it("toast 容器不拦点击,只有卡片本身可交互", () => {
    const start = css.indexOf(".toasts {");
    const body = css.slice(start, css.indexOf("}", start));
    expect(body).toContain("pointer-events: none");

    const toastStart = css.indexOf("\n.toast {");
    const toastBody = css.slice(toastStart, css.indexOf("}", toastStart));
    expect(toastBody).toContain("pointer-events: auto");
  });

  it("下拉浮层压过普通浮层、低于会话门(门内禁放 Select 的口径要成立)", () => {
    expect(zIndexOf(".select-pop")).toBeGreaterThan(zIndexOf(".overlay {"));
    expect(zIndexOf(".select-pop")).toBeLessThan(zIndexOf(".overlay--gate"));
  });

  it("快捷拷卡浮层 z 层低于模态浮层与会话门(可达性另由行为用例钉:门开时浮层 inert)", () => {
    expect(zIndexOf(".quick-copy")).toBeLessThan(zIndexOf(".overlay {"));
    expect(zIndexOf(".quick-copy")).toBeLessThan(zIndexOf(".overlay--gate"));
  });

  it("对话框在锁死页面滚动的前提下自己能滚(矮窗口不可达回归)", () => {
    const start = css.indexOf(".dialog {");
    const body = css.slice(start, css.indexOf("}", start));
    expect(body).toContain("max-height");
    expect(body).toContain("overflow-y: auto");
  });
});
