/**
 * 深色主题写了两份（跟随系统的 media query 一份、手动切换的 [data-theme] 一份）。
 * 两份必须始终一致，否则会出现「跟随系统是深色 A、手动切深色是深色 B」这种极难发现的 bug。
 * 这个测试就是那道闸门：改了一处没改另一处，CI 直接红。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

// jsdom 环境下 import.meta.url 不是 file: URL，按项目根解析
const css = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");

/** 抠出某个选择器块里的 `--x: y;` 声明 */
function declarationsOf(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`tokens.css 里找不到选择器：${selector}`);
  const open = css.indexOf("{", start);
  const end = css.indexOf("}", open);
  const body = css.slice(open + 1, end);

  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const match = line.match(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

const light = declarationsOf(":root {");
const systemDark = declarationsOf(':root:not([data-theme="light"])');
const manualDark = declarationsOf(':root[data-theme="dark"]');

describe("主题令牌", () => {
  it("两份深色定义的变量名集合完全一致", () => {
    expect(Object.keys(systemDark).sort()).toEqual(Object.keys(manualDark).sort());
  });

  it("两份深色定义的取值逐项一致", () => {
    expect(systemDark).toEqual(manualDark);
  });

  it("深色覆盖的每个变量在浅色基础层都有定义（不会漏项）", () => {
    for (const name of Object.keys(systemDark)) {
      expect(light, `浅色缺少 ${name}`).toHaveProperty(name);
    }
  });

  it("深色两份都声明了 color-scheme", () => {
    expect(css).toContain("color-scheme: dark;");
    expect(css.match(/color-scheme: dark;/g)).toHaveLength(2);
  });

  it("关键色值符合 PRD §5.9 基线", () => {
    // 纯白现在落在 panel（卡片面）上，内容区是浅灰——层次靠台阶而不是边框
    expect(light["--panel"]).toBe("#ffffff");
    expect(light["--text-primary"]).toBe("#0d0d0d");
    // 深色三个锚点保持不变
    // PRD §5.9 的三个深色锚点全部用上（画布 / chrome / 卡片）
    expect(systemDark["--bg"]).toBe("#0d0d0d");
    expect(systemDark["--bg-subtle"]).toBe("#171717");
    expect(systemDark["--panel"]).toBe("#212121");
    expect(systemDark["--border"]).toBe("#2f2f2f");
    expect(light["--radius-lg"]).toBe("12px");
    expect(light["--radius-md"]).toBe("8px");
    expect(light["--transition"]).toBe("150ms ease");
  });

  it("层次由灰阶承担：四个面互不相同，卡片最突出，chrome 与画布可区分", () => {
    const lum = (hex: string) => {
      const v = hex.replace("#", "");
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };

    for (const [name, theme] of [
      ["light", light],
      ["dark", systemDark],
    ] as const) {
      const shell = lum(theme["--surface-shell"]);
      const sidebar = lum(theme["--bg-subtle"]);
      const content = lum(theme["--bg"]);
      const panel = lum(theme["--panel"]);

      // 四个面必须彼此不同——否则层次只能靠边框，就是改版前的问题
      const values = [shell, sidebar, content, panel];
      expect(new Set(values).size, `${name}: 四个面应互不相同`).toBe(4);

      // 卡片是最突出的一层：与画布的差值足够肉眼可辨
      expect(
        Math.abs(panel - content),
        `${name}: 卡片与内容区要拉开`,
      ).toBeGreaterThanOrEqual(6);

      // chrome（侧栏）与画布可区分
      expect(
        Math.abs(sidebar - content),
        `${name}: 侧栏与内容区要拉开`,
      ).toBeGreaterThanOrEqual(5);
    }

    // 浅色是自后向前递亮的线性台阶
    expect(lum(light["--surface-shell"])).toBeLessThan(lum(light["--bg-subtle"]));
    expect(lum(light["--bg-subtle"])).toBeLessThan(lum(light["--bg"]));
    expect(lum(light["--bg"])).toBeLessThan(lum(light["--panel"]));

    // 深色：画布最暗，chrome 与卡片依次抬升（与 Codex 深色一致）
    expect(lum(systemDark["--bg"])).toBeLessThan(lum(systemDark["--bg-subtle"]));
    expect(lum(systemDark["--bg-subtle"])).toBeLessThan(lum(systemDark["--panel"]));
  });

  it("除浮层外不使用阴影", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles/components.css"), "utf8");
    const screens = readFileSync(resolve(process.cwd(), "src/styles/screens.css"), "utf8");
    const shells = readFileSync(resolve(process.cwd(), "src/styles/shell.css"), "utf8");
    const shadows = [...css.matchAll(/box-shadow:\s*([^;]+);/g)].map((m) => m[1].trim());
    // 只允许浮层那一个 token，且只出现在 dialog / notice-panel 上
    expect(shadows.every((v) => v === "var(--shadow-overlay)")).toBe(true);
    expect(screens).not.toContain("box-shadow");
    expect(shells).not.toContain("box-shadow");
    expect(screens).not.toContain("backdrop-filter");
  });

  it("字体栈全部是系统字体，不引 webfont", () => {
    expect(css).not.toContain("@font-face");
    expect(css).not.toContain("fonts.googleapis");
    // 字体栈跨多行，直接对原文断言
    const sans = css.slice(css.indexOf("--font-sans"), css.indexOf("--font-mono"));
    expect(sans).toContain("-apple-system"); // macOS → SF
    expect(sans).toContain("PingFang SC"); // macOS 中文
    expect(sans).toContain("Microsoft YaHei"); // Windows 微软雅黑
    expect(sans).toContain("system-ui"); // Linux 系统字体优先
    expect(sans).toContain("Noto Sans CJK SC"); // Linux 中文回退

    const mono = css.slice(css.indexOf("--font-mono"), css.indexOf("--text-2xs"));
    expect(mono).toContain("ui-monospace");
    expect(mono).toContain("SF Mono");
    expect(mono).toContain("Consolas");
  });
});
