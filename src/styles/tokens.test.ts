/**
 * 深色主题写了两份（跟随系统的 media query 一份、手动切换的 [data-theme] 一份）。
 * 两份必须始终一致，否则会出现「跟随系统是深色 A、手动切深色是深色 B」这种极难发现的 bug。
 * 这个测试就是那道闸门：改了一处没改另一处，CI 直接红。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    expect(light["--bg"]).toBe("#ffffff");
    expect(light["--text-primary"]).toBe("#0d0d0d");
    expect(light["--border"]).toBe("#e5e5e5");
    expect(systemDark["--bg"]).toBe("#0d0d0d");
    expect(systemDark["--panel"]).toBe("#171717");
    expect(systemDark["--panel-raised"]).toBe("#212121");
    expect(systemDark["--border"]).toBe("#2f2f2f");
    expect(light["--radius-lg"]).toBe("12px");
    expect(light["--radius-md"]).toBe("8px");
    expect(light["--transition"]).toBe("150ms ease");
  });
});
