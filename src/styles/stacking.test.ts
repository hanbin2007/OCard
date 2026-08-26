/**
 * 浮层层叠关系的静态闸门(opus 评审 P0 的教训):
 * jsdom 不做布局与命中测试,「确认框被会话门盖住点不到」这类 bug
 * 在组件测试里必然假绿——层级关系只能按 CSS 文本钉死。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  resolve(process.cwd(), "src/styles/components.css"),
  "utf8",
);

/** 抠出选择器块里的 z-index 数值 */
function zIndexOf(selector: string): number {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`components.css 里找不到选择器:${selector}`);
  const open = css.indexOf("{", start);
  const end = css.indexOf("}", open);
  const body = css.slice(open + 1, end);
  const match = body.match(/z-index\s*:\s*(\d+)/);
  if (!match) throw new Error(`${selector} 块里没有 z-index`);
  return Number(match[1]);
}

describe("浮层层叠", () => {
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

  it("对话框在锁死页面滚动的前提下自己能滚(矮窗口不可达回归)", () => {
    const start = css.indexOf(".dialog {");
    const body = css.slice(start, css.indexOf("}", start));
    expect(body).toContain("max-height");
    expect(body).toContain("overflow-y: auto");
  });
});
