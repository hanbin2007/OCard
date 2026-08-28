/**
 * 「铺满视口的浮层不许被内容撑大」的静态契约。
 *
 * 病灶:`.overlay` 是 `position: fixed; inset: 0; display: grid`,却没写
 * `grid-template-rows` —— 只剩一条**隐式 auto 行**。内容比视口矮时
 * `align-content: normal`(stretch)把它拉满、一切正常;内容一旦超过视口,
 * 这条 auto 行就被内容撑到内容高度,于是子浮层身上的 `height: 100%` /
 * `max-height: 100%` 解析出来的是「内容高度」而不是「一屏」,整套
 * 自封闭滚动结构失效。
 *
 * Chrome 实测(927px 视口 / 19 条审计事件,审计日志抽屉):
 *
 *   改前:.overlay 行 = 1507px(视口 927)
 *         .drawer  height 100% → 1507px,rows = 74 / 85 / 1313 / 35
 *         .drawer__body scrollHeight === clientHeight === 1313 → **一格都滚不动**
 *         .drawer__foot top=1472 bottom=1507 → 整条脚在视口外,看不见也够不着
 *
 *   改后:.overlay 行 = 933px(= 视口)
 *         .drawer 933px,rows = 74 / 85 / 739 / 35
 *         .drawer__body clientHeight 739 / scrollHeight 1313 / maxScrollTop 574 → 能滚
 *         .drawer__foot top=898 bottom=933 → 完整可见
 *         区域内「真的能滚」的容器有且只有一个:.drawer__body
 *
 * 为什么按 CSS 文本钉:jsdom 没有布局引擎,`getComputedStyle` 拿不到轨道解析结果,
 * 这类问题在单测里只能钉文本。
 *
 * ------------------------------------------------------------------
 * 本文件的默认方向是 **fail-closed**:不认识的写法一律判红。
 *
 * 上一版被两路评审实测出五类假绿,全部来自「判据认得太少」:
 *
 *  ① 只看 `minmax(...)` 逗号前那一段,不管整条声明浏览器认不认。
 *     headless Chrome 实测(1280×860 视口 / 1313px 内容):
 *
 *       grid-template-rows              .overlay scrollH  body 可滚量  判定
 *       (不写)                           1507             0           病灶
 *       auto / 1fr / minmax(auto, 1fr)   1507             0           病灶
 *       minmax(0, 1fr)                   840              667         安全
 *       minmax(0, auto)                  840              667         安全
 *       minmax(0, max-content)           840              667         安全
 *       100%                             840              667         安全
 *       minmax(0, fit-content(100vh))    1507             0           ★ 非法值
 *       minmax(0, 1rf)                   1257             0           ★ 单位打错
 *       minmax(0, var(--nope))           1507             0           ★ 变量不存在
 *
 *     后三条都是「浏览器整条丢弃该声明 → 退回隐式 auto 行 → 原样复现病灶」,
 *     而只看 min 的旧判据全部放行。所以现在每条轨道**整体过白名单**:
 *     合法性(浏览器认不认)与安全性(最小值是否与内容无关)分开判,
 *     两关都过才算绿。注意 `minmax(0, auto)` / `minmax(0, max-content)`
 *     经实测是**安全**的(容器高度确定时轨道被 maximize 到容器高度),
 *     「只看 min 的语义」本身没错,错的是没做合法性校验。
 *
 *  ② 选择器族按「字符串结尾匹配」判,`div.overlay{auto}` 与
 *     `.overlay.overlay--drawer{auto}` 这两种**更高优先级**的合法覆盖直接漏检。
 *     现在改成解析选择器的**主语**(最后一个复合选择器)里的类名集合。
 *
 *  ③ `BLOCKS.find` 只看第一个同选择器块,追加一个重复块就能把病灶放回来。
 *     现在一律 `filter`,对每一个块都断言;块内也取**最后一条**声明(级联最终值)。
 *
 *  ④ 扫描判据写死 `display: grid`,看不见新增的 flex 全屏层(`.group-layer` /
 *     `.lightbox`)。现在 grid / flex 两支都扫,flex 支按「恰好一条弹性子轨 +
 *     它必须非裁剪地滚 + 它必须 min-height:0(保险丝,见用例内实测口径)」判。
 *
 *  ⑤ 解析器本身退化(扫不到 = 零发现 = 全绿)只靠「块数 ≥ 200」这种弱自检。
 *     现在增加**交叉核对**:关键属性在原文里出现几次,解析器就必须解析到几次。
 *
 * 已知边界(写明比假装覆盖强):本契约只认识 grid / flex 两种全屏层。
 * `position:fixed; inset:0; display:block` 的纯遮罩不在扫描范围内——
 * 它的高度不受内容影响,不会复现本病灶。
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const DIR = resolve(process.cwd(), "src/styles");

/**
 * 剥注释,但用等量空白填回去——位置/下标断言依赖偏移不变。
 * (直接在原文上跑正则的话,「把真规则整段换成同内容的注释」测试照样绿。)
 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** 全量扫 src/styles 下每一张表,不维护手抄清单(漏表 = 漏防线) */
const SHEETS = readdirSync(DIR)
  .filter((f) => f.endsWith(".css"))
  .map((f) => ({ name: f, css: stripComments(readFileSync(resolve(DIR, f), "utf8")) }));

/* ------------------------------------------------------------------ *
 * 选择器解析
 * ------------------------------------------------------------------ */

/**
 * 取选择器的**主语**:最后一个复合选择器(depth 0 的组合符切开后的最后一段)。
 *
 * 为什么是主语而不是「整条里出现过」:`.overlay .child { … }` 作用在后代身上,
 * 拿它去判「浮层自己的行」会误红;而 `div.overlay` / `#root .overlay` /
 * `.overlay.overlay--drawer` 的主语都含 `.overlay`,一个都跑不掉。
 */
function subjectOf(selector: string): string {
  let depth = 0;
  let cur = "";
  let last = "";
  for (const ch of selector) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (depth === 0 && /[\s>+~]/.test(ch)) {
      if (cur) last = cur;
      cur = "";
    } else {
      cur += ch;
    }
  }
  return cur || last;
}

/** 主语里出现的所有类名(`:not(.x)` 之类伪类里的也算——多算只会更严) */
function subjectClasses(selector: string): string[] {
  return [...subjectOf(selector).matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
}

interface Block {
  sheet: string;
  /** 逗号拆开后的每一个选择器 */
  selectors: string[];
  /** 所有选择器主语里的类名并集 */
  classes: Set<string>;
  body: string;
}

/** 逐规则块解析:看得见缩进的、后代的、逗号列表里的每一个选择器 */
function blocks(): Block[] {
  const out: Block[] = [];
  for (const { name, css } of SHEETS) {
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = ruleRe.exec(css))) {
      const selectors = m[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      // @media / @supports 这类外层块本身没有声明体,拆出来的"选择器"以 @ 开头
      if (selectors.some((s) => s.startsWith("@"))) continue;
      const classes = new Set<string>();
      for (const s of selectors) for (const c of subjectClasses(s)) classes.add(c);
      out.push({ sheet: name, selectors, classes, body: m[2] });
    }
  }
  return out;
}

const BLOCKS = blocks();

const where = (b: Block) => `${b.sheet} ${b.selectors.join(",")}`;

/* ------------------------------------------------------------------ *
 * 声明解析(块内取**最后一条** = 级联最终值)
 * ------------------------------------------------------------------ */

/** 一个块里某属性的全部声明(按源序);`!important` 只影响优先级,不影响取值合法性 */
function decls(body: string, prop: string): string[] {
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.push(m[1].replace(/!\s*important\s*$/i, "").trim());
  return out;
}

/** 块内该属性的最终值:同块里后写的赢(旧版只取第一条,「先安全后 auto」能骗过它) */
function decl(body: string, prop: string): string | null {
  const all = decls(body, prop);
  return all.length ? all[all.length - 1] : null;
}

/** 某个选择器族(主语含这些类名之一)的所有块,按源序 */
function blocksFor(match: (cls: string) => boolean): Block[] {
  return BLOCKS.filter((b) => [...b.classes].some(match));
}

/** 基础类名 + 它的修饰类:`overlay` / `overlay--drawer` / `overlay--gate` */
const family = (base: string) => (cls: string) =>
  cls === base || cls.startsWith(`${base}--`);
/** BEM 子元素:`group-layer__grid` / `group-layer__grid--x` */
const element = (base: string) => (cls: string) => cls.startsWith(`${base}__`);

/* ------------------------------------------------------------------ *
 * 自定义属性(var 解析)
 * ------------------------------------------------------------------ */

/**
 * 收集全表的自定义属性。同名多值(明暗主题各写一份)时不做猜测——
 * 直接判成「解析不了」,让轨道值写死。
 */
const VARS = (() => {
  const out = new Map<string, Set<string>>();
  for (const { css } of SHEETS) {
    for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)[;}]/g)) {
      const name = m[1];
      const value = m[2].trim();
      if (!out.has(name)) out.set(name, new Set());
      out.get(name)!.add(value);
    }
  }
  return out;
})();

/**
 * 展开 `var(--x)` / `var(--x, 回退值)`。展不开返回 null——
 * 变量名打错时浏览器会**整条丢弃声明**并退回隐式 auto 行(实测复现原病灶),
 * 所以「展不开」必须等于判红,而不是放行。
 */
function expandVars(value: string, depth = 0): string | null {
  if (!value.includes("var(")) return value;
  if (depth > 4) return null;
  const at = value.indexOf("var(");
  let i = at + 4;
  let level = 1;
  while (i < value.length && level > 0) {
    if (value[i] === "(") level++;
    else if (value[i] === ")") level--;
    i++;
  }
  if (level !== 0) return null;
  const inner = value.slice(at + 4, i - 1);
  const comma = topLevelSplit(inner, ",");
  const name = comma[0].trim();
  const fallback = comma.length > 1 ? comma.slice(1).join(",").trim() : null;
  const defs = VARS.get(name);
  let sub: string | null = null;
  if (defs && defs.size === 1) sub = [...defs][0];
  else if (fallback !== null) sub = fallback;
  if (sub === null) return null;
  return expandVars(value.slice(0, at) + sub + value.slice(i), depth + 1);
}

/** 按 depth 0 的分隔符切(括号内的分隔符不算) */
function topLevelSplit(value: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0 && ch === sep) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/* ------------------------------------------------------------------ *
 * 轨道白名单:合法性 + 「最小值与内容无关」
 * ------------------------------------------------------------------ */

const UNITS = [
  "px", "rem", "em", "ch", "ex", "cap", "ic", "lh", "rlh",
  "vh", "vw", "vmin", "vmax", "vi", "vb",
  "svh", "svw", "lvh", "lvw", "dvh", "dvw",
  "cm", "mm", "q", "in", "pt", "pc",
];
const NUM = String.raw`\d+(?:\.\d+)?`;
const LENGTH = new RegExp(`^(?:0|${NUM}(?:${UNITS.join("|")}))$`);
const PERCENT = new RegExp(`^${NUM}%$`);
const FLEX = new RegExp(`^${NUM}fr$`);
const INTRINSIC = /^(auto|min-content|max-content)$/;

/** calc():只允许数字/已知单位/百分号/四则运算,括号必须配平 */
function isCalc(v: string): boolean {
  if (!/^calc\(.*\)$/.test(v)) return false;
  const inner = v.slice(5, -1);
  if (/[^0-9.+\-*/()%\s a-z]/.test(inner)) return false;
  for (const word of inner.match(/[a-z]+/g) ?? []) {
    if (!UNITS.includes(word)) return false;
  }
  let depth = 0;
  for (const ch of inner) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** 定值:与内容无关(长度 / 百分比 / calc) */
const isFixed = (v: string) => LENGTH.test(v) || PERCENT.test(v) || isCalc(v);

interface TrackVerdict {
  /** 浏览器认不认这条轨道(不认 → 整条声明被丢弃 → 退回隐式 auto 行 = 原病灶) */
  valid: boolean;
  /** 最小值是否与内容无关 */
  safe: boolean;
  /** 最大值是不是 <flex>(1fr 这种弹性轨) */
  flexible: boolean;
  why: string;
}

/**
 * 一条轨道整体过白名单。
 *
 * 合法性按 CSS 规范收:`minmax()` 的 min 位只接受 <inflexible-breadth>
 * (长度/百分比/auto/min-content/max-content),max 位接受 <track-breadth>
 * (再加 <flex>)。`fit-content()` **不是** <track-breadth>,写进 minmax()
 * 浏览器会整条丢弃——实测 `minmax(0, fit-content(100vh))` 100% 复现原病灶。
 */
function judgeTrack(raw: string): TrackVerdict {
  const expanded = expandVars(raw.toLowerCase().trim());
  if (expanded === null) {
    return { valid: false, safe: false, flexible: false, why: "var() 展不开(变量不存在或同名多值)" };
  }
  const t = expanded.trim();

  const mm = /^minmax\((.*)\)$/.exec(t);
  if (mm) {
    const args = topLevelSplit(mm[1], ",").map((s) => s.trim());
    if (args.length !== 2) {
      return { valid: false, safe: false, flexible: false, why: "minmax() 参数不是两个" };
    }
    const [min, max] = args;
    const minOk = isFixed(min) || INTRINSIC.test(min);
    const maxOk = isFixed(max) || INTRINSIC.test(max) || FLEX.test(max);
    if (!minOk) return { valid: false, safe: false, flexible: false, why: `minmax() 的 min "${min}" 不是合法的 <inflexible-breadth>` };
    if (!maxOk) return { valid: false, safe: false, flexible: false, why: `minmax() 的 max "${max}" 不是合法的 <track-breadth>` };
    return {
      valid: true,
      safe: isFixed(min),
      flexible: FLEX.test(max),
      why: isFixed(min) ? "" : `minmax() 的 min "${min}" 是内容尺寸`,
    };
  }

  if (FLEX.test(t)) {
    // 裸 <flex> ≡ minmax(auto, <flex>):min 是 auto,内容一超就被撑大
    return { valid: true, safe: false, flexible: true, why: "裸 <flex> ≡ minmax(auto, …),最小值是内容尺寸" };
  }
  if (INTRINSIC.test(t)) {
    return { valid: true, safe: false, flexible: false, why: `"${t}" 的最小值是内容尺寸` };
  }
  if (isFixed(t)) {
    return { valid: true, safe: true, flexible: false, why: "" };
  }
  const fc = /^fit-content\((.*)\)$/.exec(t);
  if (fc) {
    const arg = fc[1].trim();
    return isFixed(arg)
      ? { valid: true, safe: false, flexible: false, why: "fit-content() 的最小值是 auto(内容尺寸)" }
      : { valid: false, safe: false, flexible: false, why: `fit-content(${arg}) 的参数不是 <length-percentage>` };
  }
  return { valid: false, safe: false, flexible: false, why: `不认识的轨道写法(白名单之外一律判红)` };
}

/** 把 grid-template-rows 的值拆成一条条轨道(括号里的空格不算分隔) */
function tracks(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && /\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  // 命名线 [foo] 不是轨道
  return out.filter((t) => !t.startsWith("["));
}

/* ------------------------------------------------------------------ *
 * overflow
 * ------------------------------------------------------------------ */

const CLIPPING = /^(hidden|clip)$/;

/** 一条 overflow / overflow-y 声明解析出来的 y 轴取值 */
function yOf(prop: string, value: string): string {
  const parts = value.split(/\s+/);
  // `overflow: hidden auto` 这类两值写法:第一个是 x,第二个是 y
  return (prop === "overflow" ? (parts[1] ?? parts[0]) : parts[0]).toLowerCase();
}

/** 块内 y 轴溢出的**最终值**(overflow 与 overflow-y 按源序谁后写谁赢) */
function effectiveOverflowY(body: string): string | null {
  const re = /(?:^|;)\s*(overflow|overflow-y)\s*:\s*([^;]+)/g;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) last = yOf(m[1], m[2].replace(/!\s*important\s*$/i, "").trim());
  return last;
}

/** 一族块里 y 轴溢出的级联最终值 */
function lastOverflowY(list: Block[]): string | null {
  let last: string | null = null;
  for (const b of list) {
    const v = effectiveOverflowY(b.body);
    if (v !== null) last = v;
  }
  return last;
}

/** 块里出现过的任何一条裁剪型 y 溢出(哪怕后面又被覆盖——零静默,不许写) */
function anyClippingOverflow(body: string): string | null {
  const re = /(?:^|;)\s*(overflow|overflow-y)\s*:\s*([^;]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const v = m[2].replace(/!\s*important\s*$/i, "").trim();
    if (CLIPPING.test(yOf(m[1], v))) return `${m[1]}: ${v}`;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 全屏层扫描
 * ------------------------------------------------------------------ */

const isZero = (v: string | null) => v !== null && /^0(px|%)?$/.test(v.trim());

/** inset:0 或拆成四边写的 top/right/bottom/left:0(拆开写也必须扫得到) */
function coversViewport(body: string): boolean {
  const inset = decl(body, "inset");
  if (inset && inset.split(/\s+/).every((v) => /^0(px|%)?$/.test(v))) return true;
  return ["top", "right", "bottom", "left"].every((p) => isZero(decl(body, p)));
}

interface Layer extends Block {
  base: string[];
  display: "grid" | "flex";
}

/** 铺满视口的 grid / flex 层:这正是「一条隐式 auto 行被内容撑大」能发生的全部条件 */
const LAYERS: Layer[] = BLOCKS.flatMap((b) => {
  if (!/(?:^|;)\s*position\s*:\s*fixed/.test(b.body)) return [];
  if (!coversViewport(b.body)) return [];
  const display = (decl(b.body, "display") ?? "").trim();
  if (display !== "grid" && display !== "flex") return [];
  // 基础类名:主语类名里去掉修饰形态(`.overlay--drawer` 的基是 `overlay`)
  const base = [...b.classes].filter((c) => !c.includes("--"));
  return [{ ...b, base, display: display as "grid" | "flex" }];
});

/* ------------------------------------------------------------------ *
 * 豁免(必须写明理由,且必须真的命中——过期的豁免要判红)
 * ------------------------------------------------------------------ */

/**
 * `.lightbox__stage` 的 `overflow: hidden` 是刻意的:
 * 舞台里只有一张 `object-fit: contain` + `max-height: 100%` 的媒体,
 * 结构上不产生溢出;`--zoomed` 靠 transform 放大(transform 不产生可滚溢出),
 * 裁剪在这里是视觉边界而不是「把够不着的内容锁死」。
 */
const CLIP_EXEMPT = ["lightbox__stage"];

describe("全屏浮层的溢出契约", () => {
  it("解析器确实抓到了样式表和规则块(自身不许静默失效)", () => {
    // 解析器一旦被写法绕过就会退化成「零发现 → 全绿」,先钉住它有产出
    expect(SHEETS.length).toBeGreaterThanOrEqual(5);
    expect(BLOCKS.length).toBeGreaterThanOrEqual(200);
    for (const sel of ["overlay", "drawer", "dialog", "drawer__body"]) {
      expect(
        BLOCKS.some((b) => b.classes.has(sel)),
        `.${sel} 的规则块应当被解析到——扫不到就等于这套断言全部落空`,
      ).toBe(true);
    }
  });

  it("解析器与原文交叉核对:属性在原文出现几次就必须解析到几次", () => {
    // 「块数 ≥ 200」这种弱自检挡不住「解析器漏掉某一类规则」——
    // 上一版 sticky.test 就是被一条 `sel.startsWith(".")` 弄成半瞎却毫无察觉。
    // 这里直接数:原文里的声明数必须等于解析出来的声明数,少一条就是有块没扫到。
    for (const prop of ["grid-template-rows", "overflow-y", "position", "flex"]) {
      const raw = SHEETS.reduce(
        (n, s) =>
          n +
          // @media / @supports 的条件里也会出现 `属性: 值`,那不是声明,先抹掉
          (s.css.replace(/@[^{;]*[{;]/g, "").match(new RegExp(`(?:^|[;{]|\\n)\\s*${prop}\\s*:`, "g")) ?? [])
            .length,
        0,
      );
      const parsed = BLOCKS.reduce((n, b) => n + decls(b.body, prop).length, 0);
      expect(parsed, `${prop}: 原文 ${raw} 条,解析到 ${parsed} 条——对不上说明有规则块没被解析`).toBe(raw);
    }
  });

  it("铺满视口的浮层(grid 与 flex 都算)必须被扫到", () => {
    // 扫不到任何块 = 判据被改写绕过(比如 inset 拆成 top/right/bottom/left),
    // 那就是假绿,先钉住它非空且包含已知的 .overlay
    expect(
      LAYERS.map(where),
      "扫描判据失效:一个铺满视口的浮层都没找到",
    ).not.toEqual([]);
    expect(
      LAYERS.some((l) => l.classes.has("overlay")),
      ".overlay 必须落在扫描范围内",
    ).toBe(true);
    // 已知三层:.overlay(grid)、.group-layer(flex)、.lightbox(flex)。
    // 数量掉下来 = 判据又被某种写法绕过了。
    expect(LAYERS.length, `扫到的全屏层:${LAYERS.map(where).join(" / ")}`).toBeGreaterThanOrEqual(3);
  });

  it("grid 全屏层必须显式声明 grid-template-rows,且不许用 grid/grid-template 简写绕过", () => {
    const grids = LAYERS.filter((l) => l.display === "grid");
    expect(grids.length, "一个 grid 全屏层都没扫到").toBeGreaterThanOrEqual(1);

    const bad = grids.filter((l) => !decl(l.body, "grid-template-rows")).map(where);
    expect(
      bad,
      "铺满视口的 grid 浮层不写 grid-template-rows,就只有一条隐式 auto 行:" +
        "内容一超过视口,行被内容撑到内容高度,子浮层的 height/max-height:100% " +
        "解析出来的是「内容高度」而不是「一屏」,内部 overflow-y:auto 永远没有可滚量。" +
        "实测:927px 视口下审计日志抽屉的行长成 1507px,列表滚不动、脚跑到视口外。",
    ).toEqual([]);

    // 简写会覆盖 grid-template-rows 却绕开上面的判据,契约只认长写法
    const shorthand = BLOCKS.filter(
      (b) =>
        [...b.classes].some((c) => grids.some((g) => g.base.some((base) => family(base)(c)))) &&
        (decl(b.body, "grid-template") || decl(b.body, "grid")),
    ).map(where);
    expect(
      shorthand,
      "全屏层不许用 `grid` / `grid-template` 简写设置行:简写能覆盖 grid-template-rows " +
        "却绕开本契约的判据。请改写成 grid-template-rows。",
    ).toEqual([]);
  });

  it("grid 全屏层的每一条轨道:浏览器认得 + 最小值与内容无关", () => {
    // 覆盖浮层自己的**每一个**规则块:基础规则、修饰类、元素限定(div.overlay)、
    // 复合类(.overlay.overlay--drawer)、追加的重复块、媒体查询里的覆盖——
    // 任何一处写成 auto 都能把病灶原样放回来,所以一条都不能漏。
    const grids = LAYERS.filter((l) => l.display === "grid");
    const bases = [...new Set(grids.flatMap((l) => l.base))];
    expect(bases, "grid 全屏层的基础类名").not.toEqual([]);

    const rowBlocks = BLOCKS.filter(
      (b) =>
        [...b.classes].some((c) => bases.some((base) => family(base)(c))) &&
        (decl(b.body, "grid-template-rows") || decl(b.body, "grid-auto-rows")),
    );
    expect(
      rowBlocks.length,
      `${bases.map((b) => `.${b}`).join(" / ")} 族应当至少有一处 grid-template-rows(找不到说明基础规则被删了)`,
    ).toBeGreaterThanOrEqual(1);

    const bad: string[] = [];
    for (const b of rowBlocks) {
      for (const prop of ["grid-template-rows", "grid-auto-rows"]) {
        const value = decl(b.body, prop);
        if (!value) continue;
        const list = tracks(value);
        if (!list.length) {
          bad.push(`${where(b)} → ${prop}: ${value}(解析不出任何轨道)`);
          continue;
        }
        for (const t of list) {
          const v = judgeTrack(t);
          if (!v.valid) bad.push(`${where(b)} → ${prop}: ${value}(轨道 "${t}" 非法:${v.why})`);
          else if (!v.safe) bad.push(`${where(b)} → ${prop}: ${value}(轨道 "${t}" 不安全:${v.why})`);
        }
      }
    }
    expect(
      bad,
      "全屏层的行必须两关都过:\n" +
        "① 合法——浏览器不认的写法(minmax 里塞 fit-content()、单位打错、var 不存在)" +
        "会让整条声明被丢弃,退回隐式 auto 行,100% 复现原病灶,实测三种写法都是 1507px;\n" +
        "② 与内容无关——`auto`/`min-content`/`max-content`/裸 `1fr`(≡ minmax(auto,1fr))" +
        "的最小值都是内容尺寸,内容一超视口轨道就跟着长。\n" +
        "请写 `minmax(0, 1fr)` 或定长/百分比。",
    ).toEqual([]);
  });

  it("flex 全屏层:列方向 + 恰好一条弹性子轨 + 它必须能压缩且能滚", () => {
    // 同一个病灶的 flex 形态:弹性子轨压不下去时,内容一多就把轨撑破、
    // 底栏被推出视口。headless Chrome 实测(1280×860 视口 / 4000px 内容):
    //   .group-layer__grid{min-height:auto; overflow-y:visible}
    //     → 层溢出 3381px、底栏 bottom=4154(视口 773)—— 与 grid 版一模一样;
    //   只删 min-height:0(overflow-y 仍是 auto)→ 无变化,因为滚动容器的
    //     自动最小尺寸本来就是 0。所以**承重的是 overflow-y**,min-height:0
    //     是保险丝。两条都钉,理由见下面的失败信息。
    const flexes = LAYERS.filter((l) => l.display === "flex");
    expect(
      flexes.map(where),
      "一个 flex 全屏层都没扫到——.group-layer / .lightbox 应当在内",
    ).not.toEqual([]);

    const bad: string[] = [];
    for (const layer of flexes) {
      const dir = decl(layer.body, "flex-direction");
      if (dir !== "column") {
        bad.push(`${where(layer)} → flex-direction: ${dir ?? "(未写,默认 row)"};本契约只认识列方向的全屏层`);
        continue;
      }
      for (const base of layer.base) {
        const kids = blocksFor(element(base));
        if (!kids.length) {
          bad.push(`${where(layer)} → 扫不到任何 .${base}__* 子块(判据失效)`);
          continue;
        }
        // 子轨的 flex-grow 取级联最终值:按子类名归组,后写的赢
        const grow = new Map<string, number>();
        for (const b of kids) {
          const g = growOf(b.body);
          if (g === null) continue;
          for (const c of b.classes) if (element(base)(c)) grow.set(c, g);
        }
        const flexible = [...grow].filter(([, g]) => g > 0).map(([c]) => c);
        if (flexible.length !== 1) {
          bad.push(
            `${where(layer)} → 弹性子轨有 ${flexible.length} 条(${flexible.join(",") || "无"});` +
              "必须有且只有一条瓜分剩余高度,其余一律 flex:0 0 auto",
          );
          continue;
        }
        const name = flexible[0];
        const own = blocksFor((c) => c === name);
        const minH = lastOf(own, "min-height");
        if (!isZero(minH)) {
          bad.push(
            `.${name} 的 min-height 是 ${minH ?? "(未写)"},必须是 0。\n` +
              "实测口径(别照抄旧注释里那句「min-height:0 是能滚的前提」——那句不成立):" +
              "flex 子项的 `min-height: auto` 只在 `overflow` 为 `visible` 时才解析成" +
              "「自动最小尺寸」;这条轨既然已经有非裁剪的 overflow-y,它本来就解析成 0。" +
              "契约仍然要求写死 0,是因为它是「哪天有人把 overflow 改回 visible」时" +
              "唯一的护栏——零成本的保险,不是当前能滚的原因。",
          );
        }
        const y = lastOverflowY(own);
        if (CLIP_EXEMPT.includes(name)) {
          // 豁免也要留痕:它必须仍然写着裁剪值,否则这条豁免已经过期,该删
          if (!y || !CLIPPING.test(yOf("overflow-y", y))) {
            bad.push(`.${name} 在 CLIP_EXEMPT 名单里却不再裁剪(${y ?? "未写"})——过期的豁免请删掉`);
          }
          continue;
        }
        if (!y || !/^(auto|scroll|overlay)$/.test(yOf("overflow-y", y))) {
          bad.push(
            `.${name} 是唯一的弹性子轨,溢出必须由它自己承担,现在是 "${y ?? "未写"}"。` +
              "写 auto/scroll;hidden/clip 会把够不着的内容锁死(评审判过 P0 的静默 fail-open)",
          );
        }
      }
    }
    expect(bad, "flex 全屏层的高度必须由「一条可压缩、能滚的弹性子轨」吸收").toEqual([]);
  });

  it("抽屉正文行必须可压缩(minmax(0, 1fr)),否则内容会顶开整个抽屉", () => {
    // 用 filter 而不是 find:追加一个重复的 `.drawer{grid-template-rows: auto …}`
    // 就能把病灶放回来,只看第一个块等于放行(实测假绿)。
    const drawers = blocksFor((c) => c === "drawer");
    expect(drawers.map(where), ".drawer 规则块应当存在").not.toEqual([]);

    const rowBlocks = drawers.filter((b) => decl(b.body, "grid-template-rows"));
    expect(
      rowBlocks.map(where),
      ".drawer 必须显式声明 grid-template-rows",
    ).not.toEqual([]);

    const bad: string[] = [];
    for (const b of rowBlocks) {
      const value = decl(b.body, "grid-template-rows")!;
      const list = tracks(value).map((t) => ({ raw: t, v: judgeTrack(t) }));
      // 骨架行(头/过滤/脚)写 auto 是对的——抽屉自己已经被 height:100% 定高了;
      // 但只要有一条非法,整条声明会被浏览器丢弃 → 退回隐式 auto 行 → 原病灶。
      for (const { raw, v } of list) {
        if (!v.valid) bad.push(`${where(b)} → ${value}(轨道 "${raw}" 非法:${v.why})`);
      }
      const flexible = list.filter(({ v }) => v.flexible);
      if (flexible.length !== 1) {
        bad.push(`${where(b)} → ${value}(弹性行 ${flexible.length} 条,必须恰好 1 条正文行)`);
        continue;
      }
      if (!flexible[0].v.safe) {
        bad.push(
          `${where(b)} → ${value}(正文行 "${flexible[0].raw}" 的最小值必须是 0:` +
            "min 若是内容尺寸,19 条日志会把这行撑成 1313px,把脚顶到视口外)",
        );
      }
    }
    expect(bad, ".drawer 的行契约").toEqual([]);

    expect(
      lastOf(drawers, "height"),
      ".drawer 靠 height:100% 吃满 overlay 的那一行——这也是上面那条轨道契约的意义所在",
    ).toBe("100%");
  });

  it("抽屉留有非裁剪的溢出兜底(退化态也不许静默丢内容)", () => {
    // 头 74 + 过滤 85 + 脚 35 = 194px 是抽屉的最小骨架。视口比它还矮时骨架会
    // 溢出抽屉自己的盒子,脚被推到视口外。挂一条 auto 让抽屉自身能滚,那点行程就够得着。
    // 实测日常态(933px 视口)scrollHeight === clientHeight === 933、
    // scrollWidth === clientWidth === 559 → 不出条、不吃滚轮,同一时刻只有 .drawer__body 在滚。
    const drawers = blocksFor((c) => c === "drawer");
    const y = lastOf(drawers, "overflow-y") ?? lastOf(drawers, "overflow");
    expect(
      y,
      ".drawer 必须声明溢出兜底:退化态下脚会被挤出自己的盒子,没有兜底就够不着",
    ).not.toBeNull();
    expect(
      /^(auto|scroll)/.test(y!),
      `.drawer 的溢出兜底是 "${y}"——必须是 auto/scroll。` +
        "hidden/clip 会把够不着的内容直接锁死,是评审判过 P0 的静默 fail-open。",
    ).toBe(true);
  });

  it("浮层链上不许出现裁剪型 overflow(零静默)", () => {
    // 判例:`.content--flush{overflow:hidden}` 曾把内容裁成彻底不可达(评审 P0)。
    // 守的不变式是「同一片区域同一时刻只有一个容器响应滚轮/出条」,
    // 不是「结构上只许有一个 overflow:auto」——一个 scrollHeight === clientHeight
    // 的兜底 auto 对用户不存在,却能在退化态兜住可达性。
    // 浮层族 = 三层浮层 + 两层全屏层,连同它们的修饰类与 BEM 子元素
    const inFamily = (c: string) =>
      ["overlay", "drawer", "dialog", "group-layer", "lightbox"].some(
        (base) => family(base)(c) || element(base)(c),
      );
    const scanned = BLOCKS.filter((b) => [...b.classes].some(inFamily));
    expect(
      scanned.length,
      "浮层族的规则块应当被扫到(扫不到 = 判据失效 = 假绿)",
    ).toBeGreaterThanOrEqual(6);

    const bad: string[] = [];
    for (const b of scanned) {
      const hit = anyClippingOverflow(b.body);
      if (!hit) continue;
      if ([...b.classes].some((c) => CLIP_EXEMPT.includes(c))) continue;
      bad.push(`${where(b)} → ${hit}`);
    }
    expect(
      bad,
      "浮层链上用 hidden/clip 兜滚动问题,等于把够不着的内容彻底锁死;" +
        "该用 auto 兜底,让退化态仍然可达。确属刻意裁剪的,请加进 CLIP_EXEMPT 并写明理由。",
    ).toEqual([]);

    // 过期的豁免要判红:名单里的类名必须还真的存在、还真的在裁剪
    for (const name of CLIP_EXEMPT) {
      const own = blocksFor((c) => c === name);
      expect(own.length, `CLIP_EXEMPT 里的 .${name} 已经不存在了,请删掉这条豁免`).toBeGreaterThanOrEqual(1);
      expect(
        own.some((b) => anyClippingOverflow(b.body)),
        `CLIP_EXEMPT 里的 .${name} 已经不裁剪了,请删掉这条豁免`,
      ).toBe(true);
    }
  });

  it("对话框自封闭:max-height 与自身滚动必须成对出现", () => {
    // body 已全局禁滚。dialog 只有「收缩到一屏 + 自己滚」同时成立才是自封闭的;
    // 少任何一半,超窗内容都会溢出到视口外而不可达。
    // 另:overflow-y:auto 让它的最小内容高度为 0,max-height:100% 才真正约束得住——
    // 这也是修复前 .dialog 在 Chrome 里侥幸没出事的原因,但那依赖的是
    // 「循环百分比」这种引擎自定行为;行显式定高之后,100% 是有定值可依的。
    // 按族扫:`.dialog--wide{max-height:none}` 这种修饰类覆盖同样是把自封闭解开
    const dialogs = blocksFor(family("dialog"));
    expect(dialogs.map(where), ".dialog 规则块应当存在").not.toEqual([]);
    const heights = dialogs.flatMap((b) => decls(b.body, "max-height").map((v) => `${where(b)} → ${v}`));
    expect(heights.length, ".dialog 必须收缩到一屏(没有任何一处 max-height)").toBeGreaterThanOrEqual(1);
    expect(
      heights.filter((h) => !h.endsWith("→ 100%")),
      ".dialog 族的 max-height 只许是 100%——任何一处放开都会让超窗内容溢出到视口外",
    ).toEqual([]);
    const y = lastOverflowY(dialogs);
    expect(
      y !== null && /^(auto|scroll)/.test(y),
      `.dialog 的溢出是 "${y}"——必须能自己滚,否则超窗内容溢出到视口外够不着`,
    ).toBe(true);
  });
});

/** 一族块里某属性的级联最终值(源序最后一条) */
function lastOf(list: Block[], prop: string): string | null {
  let last: string | null = null;
  for (const b of list) {
    const v = decl(b.body, prop);
    if (v !== null) last = v;
  }
  return last;
}

/**
 * 块里声明的 flex-grow(简写 / 长写 / 关键字都认);没声明返回 null。
 * 简写与长写同块共存时按源序取后写的那条。
 */
function growOf(body: string): number | null {
  const re = /(?:^|;)\s*(flex|flex-grow)\s*:\s*([^;]+)/g;
  let value: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const raw = m[2].replace(/!\s*important\s*$/i, "").trim().toLowerCase();
    if (m[1] === "flex-grow") value = raw;
    else if (raw === "none" || raw === "initial") value = "0";
    else {
      const first = raw.split(/\s+/)[0];
      // `flex: 1 1 auto` → 1;`flex: auto` / `flex: 30%`(= 1 1 <basis>)→ 1
      value = /^\d/.test(first) && !/[a-z%]/.test(first) ? first : "1";
    }
  }
  if (value === null) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 1; // 认不出的写法按「会瓜分高度」算(fail-closed)
}
