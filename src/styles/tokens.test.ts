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

const STYLESHEETS = [
  "base",
  "shell",
  "components",
  "screens",
  "tokens",
  // 欢迎/向导窗口的样式此前不在守卫扫描内,违规能静悄悄过 CI(评审 P1)
  "welcome",
] as const;
const sheets = Object.fromEntries(
  STYLESHEETS.map((name) => [
    name,
    readFileSync(resolve(process.cwd(), `src/styles/${name}.css`), "utf8"),
  ]),
) as Record<(typeof STYLESHEETS)[number], string>;

/** 抠出所有 @keyframes 块（花括号配对，不怕嵌套的百分比段） */
function keyframeBlocks(source: string): Array<{ name: string; body: string }> {
  const blocks: Array<{ name: string; body: string }> = [];
  const head = /@keyframes\s+([A-Za-z0-9_-]+)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = head.exec(source))) {
    const open = head.lastIndex - 1;
    let depth = 0;
    let i = open;
    for (; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push({ name: match[1], body: source.slice(open + 1, i) });
    head.lastIndex = i;
  }
  return blocks;
}

/** 块里声明了哪些属性（`from {` / `38% {` 这类段选择器没有冒号，不会被误收） */
function declaredProperties(body: string): string[] {
  return [...body.matchAll(/^\s*([a-z-]+)\s*:/gm)].map((m) => m[1]);
}

/** 所有 transition / transition-property 里点名的属性 */
function transitionedProperties(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/^\s*transition(?:-property)?\s*:\s*([^;]+);/gm)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+/)[0];
      if (name) out.push(name);
    }
  }
  return out;
}

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

/**
 * 动效守卫。
 *
 * 这一组不评价"好不好看"，只锁住三条会真出事的约束：
 * ① 一切动画/过渡只碰合成属性——分类工作台的网格可达上千张缩略图，
 *    动一次 width/height/top 就是一次整网格重排；
 * ② 弹簧参数是解出来的常量，不是随手改的魔数；
 * ③ prefers-reduced-motion 必须把时长、延迟、滚动行为一并按下去。
 */
describe("动效令牌与合成安全", () => {
  it("时长与曲线都在令牌里，组件不许写死魔数", () => {
    for (const token of [
      "--dur-instant",
      "--dur-micro",
      "--dur-quick",
      "--dur-spring-fast",
      "--dur-spring",
      "--dur-spring-pop",
      "--ease-out",
      "--spring",
      "--spring-pop",
    ]) {
      expect(light, `缺少动效令牌 ${token}`).toHaveProperty(token);
    }
    // 按压反馈必须"快到读作即时"：超过 120ms 就不再是 pointer-down 的直接感
    expect(Number.parseInt(light["--dur-instant"], 10)).toBeLessThanOrEqual(120);
  });

  it("弹簧曲线：基础层是 cubic-bezier 兜底，支持 linear() 的内核换成真实弹簧采样", () => {
    expect(light["--spring"]).toContain("cubic-bezier");
    expect(light["--spring-pop"]).toContain("cubic-bezier");

    // 注释里写着峰值数字，先剥掉，否则会被当成曲线采样点
    const upgrade = css
      .slice(css.indexOf("@supports (transition-timing-function"))
      .replace(/\/\*[\s\S]*?\*\//g, "");
    /** 取出 linear() 括号里的采样点 */
    const samples = (token: string): number[] => {
      const found = new RegExp(`${token}:\\s*linear\\(([^)]*)\\)`).exec(upgrade);
      expect(found, `${token} 没有升级成 linear() 弹簧`).not.toBeNull();
      return (found as RegExpExecArray)[1]
        .split(",")
        .map((v) => Number(v.trim()))
        .filter((v) => Number.isFinite(v));
    };

    // 临界阻尼那条不许有过冲；带过冲的只有 --spring-pop 一条，且过冲很小
    const critical = samples("--spring");
    expect(critical.length).toBeGreaterThan(15);
    expect(critical[0]).toBe(0);
    expect(critical[critical.length - 1]).toBe(1);
    expect(Math.max(...critical)).toBeLessThanOrEqual(1);

    const pop = samples("--spring-pop");
    const popPeak = Math.max(...pop);
    expect(popPeak).toBeGreaterThan(1);
    // 是"分量"不是"弹跳"：过冲控制在 5% 以内
    expect(popPeak).toBeLessThan(1.05);
  });

  it("所有关键帧只动合成属性——网格再大也不会因为动画重排", () => {
    // outline 的两项不进合成层，但只作用在"当前那一个"焦点元素上，代价可忽略
    const allowed = new Set(["transform", "opacity", "outline-offset", "outline-color"]);
    for (const [sheet, source] of Object.entries(sheets)) {
      for (const { name, body } of keyframeBlocks(source)) {
        for (const property of declaredProperties(body)) {
          expect(
            allowed.has(property),
            `${sheet}.css @keyframes ${name} 动了 ${property}——会引发重排/重绘`,
          ).toBe(true);
        }
      }
    }
  });

  it("所有过渡只挂在合成或纯上色属性上，尤其不许再出现 width", () => {
    const allowed = new Set([
      "transform",
      "opacity",
      "background",
      "border-color",
      "color",
      "outline-offset",
      // 进度环的弧长动画：SVG 描边属于纯绘制，不进布局；
      // 且只作用在一个 56px 的小图形上，重绘代价与 background 同量级
      "stroke-dashoffset",
    ]);
    for (const [sheet, source] of Object.entries(sheets)) {
      for (const property of transitionedProperties(source)) {
        expect(
          allowed.has(property),
          `${sheet}.css 过渡了 ${property}——只允许合成/上色属性`,
        ).toBe(true);
      }
    }
    // 进度条改走 scaleX：过渡 width 会让拷卡屏每帧重排
    expect(sheets.components).toContain("transform-origin: left center");
  });

  it("prefers-reduced-motion 把时长、延迟与滚动行为一并按下去", () => {
    const start = sheets.base.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(start).toBeGreaterThan(-1);
    const block = sheets.base.slice(start);
    expect(block).toContain("transition-duration: 0.01ms !important");
    expect(block).toContain("transition-delay: 0ms !important");
    expect(block).toContain("animation-duration: 0.01ms !important");
    expect(block).toContain("animation-delay: 0ms !important");
    expect(block).toContain("scroll-behavior: auto !important");
    // 视图过渡也要一并停掉（JS 侧已绕过，这里是第二道保险）
    expect(block).toContain("::view-transition-group(*)");
  });

  it("每个关键帧的终态就是静态样式：减少动效时直接静止在最终样子，不缺功能", () => {
    for (const [sheet, source] of Object.entries(sheets)) {
      for (const { name, body } of keyframeBlocks(source)) {
        // 只写 from（或起始段）而不写 to，终态自然回落到元素本身的静态值
        const hasExplicitTo = /(^|\s)(to|100%)\s*\{/.test(body);
        expect(
          hasExplicitTo,
          `${sheet}.css @keyframes ${name} 写了 to/100%——终态应交回静态样式，` +
            `否则减少动效时会停在动画自己的终点上`,
        ).toBe(false);
      }
    }
  });
});
