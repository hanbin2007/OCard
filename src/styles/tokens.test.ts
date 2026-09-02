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
  // 画廊模式同理:漏一张表 = 那张表可以随便过渡 width、随便写 to{}
  "gallery",
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
  });

  /**
   * `backdrop-filter` 只许出现在**铺满视口的浮层**上。
   *
   * 原来这条写成「screens.css 里一个都不许有」。那是把「普通屏内容不许磨砂玻璃」
   * 这个意图,用「哪个文件」来近似——而 `.lightbox` / `.group-layer` 这两个
   * 全屏浮层恰恰就住在 screens.css 里,于是正当用法被一并禁掉了。
   * 改成按**选择器主语**判:意图不变,近似换成判据本身。
   *
   * 为什么普通内容不许:它对每一帧都要重新采样身后的像素,是实打实的性能负担;
   * 而且会把本该实心的面做成半透,四级灰阶台阶(shell → sidebar → content →
   * panel)当场糊成一片,层次全乱。
   */
  it("backdrop-filter 只许用在铺满视口的浮层上", async () => {
    const { RULES, where } = await import("./_css-contract");
    // 允许名单 = 铺满视口、且已在 stacking 名册里登记的那几层
    const FULLSCREEN_LAYERS = new Set(["lightbox", "group-layer", "overlay"]);
    const strays = RULES.filter((r) =>
      r.decls.some((d) => d.prop === "backdrop-filter"),
    )
      .filter((r) => ![...r.subjectClasses].some((c) => FULLSCREEN_LAYERS.has(c)))
      .map(where);
    expect(
      strays,
      "backdrop-filter 只许用在铺满视口的浮层上(见本用例的注释)。" +
        "若确实新增了一层全屏浮层,把它的类名加进 FULLSCREEN_LAYERS," +
        "并确认它也登记进了 stacking.test 的 LAYERS 名册",
    ).toEqual([]);
  });

  /**
   * 通知/toast 的正文必须能换行、能断长路径。
   *
   * 0.4.3 现场事故的收尾:后端把报错报文分成三行写(发生了什么 / 原因 /
   * 下一步),但 `.toast__message` 没有 `white-space: pre-wrap`,HTML 把 \n 折成
   * 空格,三行挤成一坨三百字的长句;而 `.toast` 是 `overflow: hidden`,报文里
   * 那句 `\\NAS01\\Projects\\...\\abc.json` 没有天然断词点,直接被横向裁掉——
   * 「到底是哪个文件」这条最要紧的信息,恰好在最该被看见的地方看不见。
   */
  it("通知正文保留换行、长路径能断行", async () => {
    const { RULES, where } = await import("./_css-contract");
    for (const cls of ["toast__message", "notice-item__message"]) {
      const own = RULES.filter((r) => r.subjectClasses.has(cls));
      expect(own.length, `.${cls} 没有任何规则?`).toBeGreaterThan(0);
      for (const prop of ["white-space", "overflow-wrap"]) {
        const hit = own.find((r) => r.decls.some((d) => d.prop === prop));
        expect(
          hit ? where(hit) : null,
          `.${cls} 缺 ${prop}:报错报文会被折成一坨/长路径会被裁掉`,
        ).not.toBeNull();
      }
      const ws = own
        .flatMap((r) => r.decls)
        .filter((d) => d.prop === "white-space")
        .map((d) => d.value.trim());
      expect(ws, `.${cls} 的 white-space 必须保留换行`).toContain("pre-wrap");
    }
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

/* ------------------------------------------------------------------ *
 * 对比度契约（评审 D4）
 *
 * 病历：`--text-tertiary` 在最沉的面 `--bg-sunken` 上只有 4.12:1，而它承载的
 * 恰恰是"索引中 / 预览不可用 / 还有 N 张未加载"这类**零静默文案**——看不清
 * 等于没写；`--border-strong` 是未勾选复选框的边框，浅色 1.56:1 / 深色 1.48:1，
 * 而拷卡屏的文件夹多选面板是个高密度决策列表，"勾没勾中"直接决定拷什么。
 *
 * 这条闸门的意义在于：tokens.css 是全局文件，任何人调一次灰阶都可能把某个
 * 前景/背景组合推到线下，而这种退化在界面上"看着还行"，只有算一遍才知道。
 * ------------------------------------------------------------------ */

/** WCAG 相对亮度 */
function relLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function parseHex(value: string): [number, number, number] {
  const v = value.replace("#", "").trim();
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function parseRgba(value: string): [number, number, number, number] {
  const m = /rgba?\(([^)]+)\)/.exec(value);
  if (!m) throw new Error(`不是 rgba() 值：${value}`);
  const parts = m[1].split(",").map((x) => Number(x.trim()));
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}

function contrast(fg: [number, number, number], bg: [number, number, number]): number {
  const [hi, lo] = [relLuminance(fg), relLuminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** 半透明叠加层压在容器面上之后的**实际**底色 */
function composite(
  overlay: [number, number, number, number],
  base: [number, number, number],
): [number, number, number] {
  return [0, 1, 2].map((i) =>
    Math.round(overlay[i] * overlay[3] + base[i] * (1 - overlay[3])),
  ) as [number, number, number];
}

/** 所有会当"底"用的面 */
const SURFACE_TOKENS = [
  "--surface-shell",
  "--bg-subtle",
  "--bg",
  "--bg-sunken",
  "--panel",
  "--panel-raised",
  "--field",
];

/**
 * 只有**容器面**需要合成叠加层。
 * `.btn:hover` 不是「panel-raised + hover」——它把自己的底色换成了半透明的
 * --hover，压在按钮所在的容器（panel / 画布 / 侧栏）上。
 */
const CONTAINER_TOKENS = ["--panel", "--bg", "--bg-subtle"];
/** :active 是"按住那一瞬"的态，只做参考不做闸门；hover / selected 是能停住的态 */
const PERSISTENT_OVERLAYS = ["--hover", "--selected"];

function backgroundsOf(theme: Record<string, string>) {
  const out: Array<{ name: string; rgb: [number, number, number] }> = [];
  for (const token of SURFACE_TOKENS) {
    out.push({ name: token, rgb: parseHex(theme[token]) });
  }
  for (const token of CONTAINER_TOKENS) {
    for (const overlay of PERSISTENT_OVERLAYS) {
      out.push({
        name: `${token} + ${overlay}`,
        rgb: composite(parseRgba(theme[overlay]), parseHex(theme[token])),
      });
    }
  }
  return out;
}

describe("对比度契约", () => {
  const THEMES = [
    ["浅色", light],
    ["深色", systemDark],
  ] as const;

  it("解析器自身有产出（扫不到面 = 这一组断言全部落空）", () => {
    for (const [name, theme] of THEMES) {
      const bgs = backgroundsOf(theme);
      expect(bgs.length, `${name}: 背景组合一个都没算出来`).toBe(
        SURFACE_TOKENS.length + CONTAINER_TOKENS.length * PERSISTENT_OVERLAYS.length,
      );
      // 白底黑字必须算出 21:1，算错了下面的数就全是假的
      expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 1);
    }
  });

  it("正文文字对所有面 ≥ 4.5:1（AA）", () => {
    for (const [name, theme] of THEMES) {
      for (const token of ["--text-primary", "--text-secondary", "--text-tertiary"]) {
        const fg = parseHex(theme[token]);
        for (const bg of backgroundsOf(theme)) {
          expect(
            contrast(fg, bg.rgb),
            `${name} ${token} 压在 ${bg.name} 上只有 ` +
              `${contrast(fg, bg.rgb).toFixed(2)}:1——"索引中/预览不可用"这类` +
              `零静默文案看不清，等于没写`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("控件边界对所有面 ≥ 3:1（非文本对比，WCAG 1.4.11）", () => {
    for (const [name, theme] of THEMES) {
      for (const token of ["--border-strong", "--border-focus"]) {
        const fg = parseHex(theme[token]);
        for (const bg of backgroundsOf(theme)) {
          expect(
            contrast(fg, bg.rgb),
            `${name} ${token} 压在 ${bg.name} 上只有 ` +
              `${contrast(fg, bg.rgb).toFixed(2)}:1——未勾选的复选框就是靠这圈边框` +
              `告诉人"这条没选中"，看不清就只能靠猜`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it("边框三档必须一档比一档重，不许倒挂", () => {
    // hover 用 strong、选中/焦点用 focus：strong 一旦超过 focus，
    // 就会出现"悬停比选中还显眼"，复选框 hover 反而更看不清
    for (const [name, theme] of THEMES) {
      const on = parseHex(theme["--panel"]);
      const weak = contrast(parseHex(theme["--border"]), on);
      const strong = contrast(parseHex(theme["--border-strong"]), on);
      const focus = contrast(parseHex(theme["--border-focus"]), on);
      expect(strong, `${name}: --border-strong 应比 --border 重`).toBeGreaterThan(weak);
      expect(focus, `${name}: --border-focus 应比 --border-strong 重`).toBeGreaterThan(
        strong,
      );
    }
  });

  it("强调色/状态色上的文字也过 AA（这些按钮点下去就动真格）", () => {
    for (const [name, theme] of THEMES) {
      for (const [fgToken, bgToken] of [
        ["--on-accent", "--accent"],
        ["--on-ok", "--ok"],
        ["--on-danger", "--danger"],
      ] as const) {
        const r = contrast(parseHex(theme[fgToken]), parseHex(theme[bgToken]));
        expect(r, `${name} ${fgToken} on ${bgToken} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
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
