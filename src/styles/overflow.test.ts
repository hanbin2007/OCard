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
 * 第三轮重写(2026-08-28):解析层整体从正则换成 **postcss AST**。
 *
 * 前两轮的所有漏网之鱼根因只有一条:**用正则模拟选择器解析和 CSS 级联,做不对**。
 * 第二轮评审用等价改写实测出的逃逸/误判(全部已复现):
 *
 *   逃逸(该红没红)                                              现在
 *   minmax(0, calc(100vh - )) 语法非法的 calc                    RED  calc 表达式真解析
 *   grid-template-rows: auto !important; 后跟一条安全值           RED  !important 参与级联
 *   把 position/inset/display 拆成两个规则块                      RED  按「元素」而不是「块」判层
 *   [class~="overlay"] { overflow-y: hidden }                    RED  属性选择器进类名集合
 *   position:fixed; top/left:0; width:100vw; height:100vh        RED  竖直方向铺满即入扫描面
 *
 *   误红(不该红却红了)                                          现在
 *   [row-start header] 一个方括号里多个命名线                     GREEN 方括号成对跳过
 *   :is(.a, .b) .child { … } 后代规则                            GREEN 逗号拆分由 AST 做
 *   .chip[data-kind=".overlay"] 属性值里含 ".overlay" 字符串       GREEN 类名只从真类名位置取
 *
 * 三条设计原则:
 *  ① **判据的主语是「元素」,不是「规则块」**。契约先从所有选择器主语里枚举出
 *     「可能存在的元素」(类名集合,BEM 修饰类自动补上基类),再把每个元素身上
 *     所有命中的规则按 (!important, specificity, 源序) 算级联最终值。
 *     于是「拆块」「加重复块」「更高 specificity 的覆盖」「!important」全都算得对。
 *  ② **不认识 = 判红**。选择器解析不了、轨道写法不在白名单、calc 表达式不合法、
 *     var() 展不开——一律进 UNPARSED 判红,并在失败信息里说清「契约看不懂」。
 *  ③ **自检钉的是「新东西不会隐形」**,而不是「旧东西还在」:
 *     - AST 里的规则总数必须等于契约登记到的规则数(少一条 = 有写法被吞了);
 *     - 每一条规则都必须至少被一个候选元素命中(否则它对所有断言不可见);
 *     - main.tsx 的 import 清单必须与磁盘上的 *.css 完全一致(新表不会漏扫)。
 *
 * 已知边界(写明比假装覆盖强):本契约只认识 grid / flex 两种全屏层。
 * `position:fixed; inset:0; display:block` 的纯遮罩不在扫描范围内——
 * 它的高度不受内容影响,不会复现本病灶。
 */

import { describe, expect, it } from "vitest";
import {
  AST_SELECTOR_COUNT,
  CANDIDATES,
  cascade,
  cmpSpec,
  elName,
  expandVars,
  finalOf,
  hits,
  IMPORTED,
  matchGroup,
  ON_DISK,
  RULES,
  SHEETS,
  SHEET_ORDER,
  topLevelSplit,
  UNPARSED,
  where,
} from "./_css-contract";
import type { Decl } from "./_css-contract";

const UNITS = [
  "px", "rem", "em", "ch", "ex", "cap", "ic", "lh", "rlh",
  "vh", "vw", "vmin", "vmax", "vi", "vb",
  "svh", "svw", "svmin", "svmax", "lvh", "lvw", "lvmin", "lvmax",
  "dvh", "dvw", "dvmin", "dvmax",
  "cm", "mm", "q", "in", "pt", "pc",
];
const NUM = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?`;
const LENGTH = new RegExp(`^(?:${NUM})(?:${UNITS.join("|")})$|^[+-]?0(?:\\.0+)?$`, "i");
const PERCENT = new RegExp(`^(?:${NUM})%$`, "i");
const FLEX = new RegExp(`^(?:${NUM})fr$`, "i");
const INTRINSIC = /^(auto|min-content|max-content)$/;

/* ---------------- calc() 表达式的真解析 ---------------- *
 * 旧版只查「字符集 + 括号配平」,`calc(100vh - )` / `calc(100% * 2px)`
 * 这种浏览器会整条丢弃的写法照样放行,退回隐式 auto 行 = 原病灶。
 */

type CalcKind = "number" | "length" | "percent" | "length-percent";

interface CalcToken { t: "num" | "op" | "lp" | "rp"; v: string; ws: boolean }

function calcTokens(src: string): CalcToken[] | null {
  const out: CalcToken[] = [];
  let i = 0;
  let ws = false;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { ws = true; i++; continue; }
    if (ch === "(") { out.push({ t: "lp", v: ch, ws }); ws = false; i++; continue; }
    if (ch === ")") { out.push({ t: "rp", v: ch, ws }); ws = false; i++; continue; }
    if (ch === "*" || ch === "/") { out.push({ t: "op", v: ch, ws }); ws = false; i++; continue; }
    if (ch === "+" || ch === "-") {
      // 数字的正负号 vs 二元运算符:CSS 要求二元 +/- 两侧都有空白
      const nextIsNum = /^[+-][\d.]/.test(src.slice(i));
      if (nextIsNum && !ws) { /* 落到数字分支 */ }
      else { out.push({ t: "op", v: ch, ws }); ws = false; i++; continue; }
    }
    const m = new RegExp(`^(?:${NUM})(?:%|[a-z]+)?`, "i").exec(src.slice(i));
    if (!m) return null;
    out.push({ t: "num", v: m[0].toLowerCase(), ws });
    ws = false;
    i += m[0].length;
  }
  return out;
}

function calcKindOf(token: string): CalcKind | null {
  if (PERCENT.test(token)) return "percent";
  if (LENGTH.test(token)) return "length";
  if (new RegExp(`^(?:${NUM})$`, "i").test(token)) return "number";
  return null; // fr / 未知单位 → calc 里非法
}

/** 返回表达式的量纲;不合法返回 null */
function parseCalcExpr(tk: CalcToken[], pos: { i: number }): CalcKind | null {
  let left = parseCalcTerm(tk, pos);
  if (left === null) return null;
  while (pos.i < tk.length && tk[pos.i].t === "op" && (tk[pos.i].v === "+" || tk[pos.i].v === "-")) {
    const op = tk[pos.i];
    // CSS 规范:二元 +/- 前后必须有空白
    if (!op.ws) return null;
    pos.i++;
    if (pos.i >= tk.length || !tk[pos.i].ws) return null;
    const right = parseCalcTerm(tk, pos);
    if (right === null) return null;
    if (left === right) continue;
    const set = new Set([left, right]);
    if (set.has("number")) return null; // 长度 + 纯数 → 非法
    left = "length-percent";
  }
  return left;
}

function parseCalcTerm(tk: CalcToken[], pos: { i: number }): CalcKind | null {
  let left = parseCalcFactor(tk, pos);
  if (left === null) return null;
  while (pos.i < tk.length && tk[pos.i].t === "op" && (tk[pos.i].v === "*" || tk[pos.i].v === "/")) {
    const op = tk[pos.i].v;
    pos.i++;
    const right = parseCalcFactor(tk, pos);
    if (right === null) return null;
    if (op === "/") {
      if (right !== "number") return null; // 只能除以纯数
      continue;
    }
    if (left === "number") { left = right; continue; }
    if (right === "number") continue;
    return null; // 长度 × 长度 → 非法
  }
  return left;
}

function parseCalcFactor(tk: CalcToken[], pos: { i: number }): CalcKind | null {
  if (pos.i >= tk.length) return null;
  const t = tk[pos.i];
  if (t.t === "lp") {
    pos.i++;
    const inner = parseCalcExpr(tk, pos);
    if (inner === null) return null;
    if (pos.i >= tk.length || tk[pos.i].t !== "rp") return null;
    pos.i++;
    return inner;
  }
  if (t.t === "num") { pos.i++; return calcKindOf(t.v); }
  return null;
}

/** `calc(...)` 是否是浏览器认得的 <length-percentage> */
function isCalc(v: string): boolean {
  const m = /^calc\(([\s\S]*)\)$/i.exec(v.trim());
  if (!m) return false;
  const tk = calcTokens(m[1]);
  if (!tk || !tk.length) return false;
  const pos = { i: 0 };
  const kind = parseCalcExpr(tk, pos);
  if (kind === null || pos.i !== tk.length) return false;
  return kind !== "number";
}

/** 定值:与内容无关(长度 / 百分比 / 合法 calc) */
const isFixed = (v: string) => LENGTH.test(v) || PERCENT.test(v) || isCalc(v);

interface TrackVerdict {
  valid: boolean;
  safe: boolean;
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
  const expanded = expandVars(raw.trim());
  if (expanded === null) {
    return { valid: false, safe: false, flexible: false, why: "var() 展不开(变量不存在或同名多值)" };
  }
  const t = expanded.trim().toLowerCase();

  const mm = /^minmax\(([\s\S]*)\)$/.exec(t);
  if (mm) {
    const args = topLevelSplit(mm[1], ",").map((s) => s.trim());
    if (args.length !== 2) return { valid: false, safe: false, flexible: false, why: "minmax() 参数不是两个" };
    const [min, max] = args;
    if (!(isFixed(min) || INTRINSIC.test(min))) {
      return { valid: false, safe: false, flexible: false, why: `minmax() 的 min "${min}" 不是合法的 <inflexible-breadth>` };
    }
    if (!(isFixed(max) || INTRINSIC.test(max) || FLEX.test(max))) {
      return { valid: false, safe: false, flexible: false, why: `minmax() 的 max "${max}" 不是合法的 <track-breadth>` };
    }
    return {
      valid: true,
      safe: isFixed(min),
      flexible: FLEX.test(max),
      why: isFixed(min) ? "" : `minmax() 的 min "${min}" 是内容尺寸`,
    };
  }

  if (FLEX.test(t)) {
    return { valid: true, safe: false, flexible: true, why: "裸 <flex> ≡ minmax(auto, …),最小值是内容尺寸" };
  }
  if (INTRINSIC.test(t)) {
    return { valid: true, safe: false, flexible: false, why: `"${t}" 的最小值是内容尺寸` };
  }
  if (isFixed(t)) return { valid: true, safe: true, flexible: false, why: "" };

  const fc = /^fit-content\(([\s\S]*)\)$/.exec(t);
  if (fc) {
    const arg = fc[1].trim();
    return isFixed(arg)
      ? { valid: true, safe: false, flexible: false, why: "fit-content() 的最小值是 auto(内容尺寸)" }
      : { valid: false, safe: false, flexible: false, why: `fit-content(${arg}) 的参数不是 <length-percentage>` };
  }
  return { valid: false, safe: false, flexible: false, why: "不认识的轨道写法(白名单之外一律判红,请改写或扩展解析器)" };
}

/**
 * 把 `grid-template-rows` 的值拆成一条条轨道。
 *
 * `[a b]` 是**一组**命名线(CSS Grid 允许一个方括号里写多个名字),
 * 整个方括号跳过——旧版按空格拆会把它切成 `[a` 与 `b]` 两半,后者被当成
 * 一条不认识的轨道判红(实测误红)。
 */
function tracks(value: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch === "[") {
      if (cur) { out.push(cur); cur = ""; }
      let end: number;
      try { end = matchGroup(value, i); } catch { return null; }
      i = end;
      continue;
    }
    if (ch === "(") {
      let end: number;
      try { end = matchGroup(value, i); } catch { return null; }
      cur += value.slice(i, end);
      i = end;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ""; }
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur) out.push(cur);
  return out;
}

/* ================================================================== *
 * 六、overflow
 * ================================================================== */

const CLIPPING = /^(hidden|clip)$/;
const SCROLLABLE = /^(auto|scroll|overlay)$/;

/** 一条 overflow / overflow-y 声明解析出来的 y 轴取值 */
function yOf(prop: string, value: string): string {
  const parts = value.trim().split(/\s+/);
  return (prop === "overflow" ? (parts[1] ?? parts[0]) : parts[0]).toLowerCase();
}

const isOverflowY = (d: Decl) => d.prop === "overflow" || d.prop === "overflow-y";

/** 元素身上 y 轴溢出的级联最终值(overflow 简写与 overflow-y 长写一起参战) */
function finalOverflowY(el: ReadonlySet<string>): string | null {
  const h = cascade(hits(el, isOverflowY));
  return h ? yOf(h.decl.prop, h.decl.value) : null;
}

/* ================================================================== *
 * 七、全屏层扫描(判据的主语是元素,不是规则块)
 * ================================================================== */

const isZero = (v: string | null) => v !== null && /^[+-]?0(px|%|em|rem)?$/i.test(v.trim());
const VIEWPORT_TALL = /^100(vh|dvh|svh|lvh|%)$/i;

/** 元素身上解析出来的四边定位(inset 简写与四条长写按级联合并) */
function insetsOf(el: ReadonlySet<string>): Record<"top" | "right" | "bottom" | "left", string | null> {
  const sides: Record<"top" | "right" | "bottom" | "left", string | null> = {
    top: null, right: null, bottom: null, left: null,
  };
  const list = hits(el, (d) =>
    ["inset", "inset-block", "inset-inline", "top", "right", "bottom", "left"].includes(d.prop),
  );
  // 按级联权重排序后依次施加(后生效的覆盖先生效的)
  const sorted = [...list].sort((a, b) => {
    if (a.decl.important !== b.decl.important) return a.decl.important ? 1 : -1;
    const s = cmpSpec(a.rule.spec, b.rule.spec);
    return s !== 0 ? s : a.rule.order - b.rule.order;
  });
  for (const { decl } of sorted) {
    const parts = decl.value.trim().split(/\s+/);
    const pick = (n: number) => parts[n] ?? parts[n - 2] ?? parts[0];
    if (decl.prop === "inset") {
      sides.top = parts[0];
      sides.right = parts[1] ?? parts[0];
      sides.bottom = pick(2);
      sides.left = parts[3] ?? parts[1] ?? parts[0];
    } else if (decl.prop === "inset-block") {
      sides.top = parts[0];
      sides.bottom = parts[1] ?? parts[0];
    } else if (decl.prop === "inset-inline") {
      sides.left = parts[0];
      sides.right = parts[1] ?? parts[0];
    } else {
      sides[decl.prop as "top"] = decl.value.trim();
    }
  }
  return sides;
}

interface Layer {
  el: Set<string>;
  name: string;
  display: "grid" | "flex";
  /** 基础类名(去掉 BEM 修饰形态) */
  base: string[];
}

/**
 * 铺满视口的 grid / flex 层。
 *
 * 「铺满」按**竖直方向**判:top/bottom 都钉死,或者 height 直接吃满视口。
 * 旧版只认 `inset:0` 和四边各写,于是
 * `position:fixed; top:0; left:0; width:100vw; height:100vh`
 * 这种等价写法整层连同它的 overflow 一起从扫描面消失(实测假绿)。
 */
const LAYERS: Layer[] = (() => {
  const out: Layer[] = [];
  for (const el of CANDIDATES) {
    if ((finalOf(el, "position") ?? "").trim().toLowerCase() !== "fixed") continue;
    const sides = insetsOf(el);
    const height = (expandVars(finalOf(el, "height") ?? "") ?? "").trim();
    const pinned = (isZero(sides.top) && isZero(sides.bottom)) || VIEWPORT_TALL.test(height);
    if (!pinned) continue;
    const display = (finalOf(el, "display") ?? "").trim().toLowerCase().replace(/^inline-/, "");
    if (display !== "grid" && display !== "flex") continue;
    out.push({
      el,
      name: elName(el),
      display: display as "grid" | "flex",
      base: [...el].filter((c) => !c.includes("--")),
    });
  }
  return out;
})();

/* ================================================================== *
 * 八、族与豁免
 * ================================================================== */

/** 基础类名 + 它的修饰类:`overlay` / `overlay--drawer` / `overlay--gate` */
const family = (base: string) => (cls: string) => cls === base || cls.startsWith(`${base}--`);
/** BEM 子元素:`group-layer__grid` / `group-layer__grid--x` */
const element = (base: string) => (cls: string) => cls.startsWith(`${base}__`);

/** 类名满足 pred 的候选元素 */
const elementsWith = (pred: (cls: string) => boolean) =>
  CANDIDATES.filter((el) => [...el].some(pred));

/**
 * `.lightbox__stage` 的 `overflow: hidden` 是刻意的:
 * 舞台里只有一张 `object-fit: contain` + `max-height: 100%` 的媒体,
 * 结构上不产生溢出;`--zoomed` 靠 transform 放大(transform 不产生可滚溢出),
 * 裁剪在这里是视觉边界而不是「把够不着的内容锁死」。
 */
const CLIP_EXEMPT = ["lightbox__stage"];

/* ================================================================== *
 * 用例
 * ================================================================== */

describe("全屏浮层的溢出契约", () => {
  it("解析层自检:AST 里的每一条规则都必须被契约登记,一条都不许吞", () => {
    // 这条自检钉的是「新东西不会对防线隐形」,不是「旧东西还在」。
    // 旧版钉的是 `BLOCKS.length >= 200` —— 解析器漏掉一整类写法它也毫无察觉。
    expect(
      UNPARSED,
      "下面这些写法契约看不懂。看不懂 = 它对所有断言隐形 = 假绿,所以一律判红。\n" +
        "请改写成契约认得的形式,或扩展本文件的选择器/at-rule 解析器。",
    ).toEqual([]);
    expect(
      RULES.length,
      `AST 有 ${AST_SELECTOR_COUNT} 条(选择器已按逗号拆开),契约只登记了 ${RULES.length} 条`,
    ).toBe(AST_SELECTOR_COUNT);

    // 每条**按类名定位**的规则都必须至少被一个候选元素命中,
    // 否则它身上的声明永远不参与任何级联 = 对所有断言隐形。
    const classScoped = RULES.filter((r) => r.constrains);
    const invisible = classScoped.filter((r) => !CANDIDATES.some((el) => r.match(el))).map(where);
    expect(
      invisible,
      "这些按类名定位的规则不被任何候选元素命中,等于它们的声明对本契约完全不可见。" +
        "多半是候选元素的构造(BEM 基类补全)没跟上某种新写法。",
    ).toEqual([]);
    // 明确写下边界:纯元素/伪类选择器(`html`、`body`、`.x > :last-child` …)不在
    // 「元素 = 一组类名」这个模型里,不参与级联。
    // 于是「把关键声明藏进一条不带类名的选择器」就成了新的逃逸口:
    //     `html, body { overflow: hidden }` 这类规则会作用到浮层链上,却对模型隐形。
    // 所以反过来钉死:**关键属性不许出现在不带类名判据的规则里**,
    // 已知的全局重置写进 GLOBAL_RESET 白名单(它正是本契约「body 已禁滚」的前提)。
    const CRITICAL = ["grid-template-rows", "grid-auto-rows", "grid", "grid-template", "overflow", "overflow-y"];
    // `position` 只有 fixed 与本契约有关(它是全屏层扫描的第一道判据);
    // absolute/relative 是屏内定位,不参与浮层链。
    const critical = (d: Decl) =>
      CRITICAL.includes(d.prop) ||
      (d.prop === "position" && /fixed/i.test(d.value));
    const GLOBAL_RESET = ["html", "body", "#root", "*", "*::before", "*::after", ":root"];
    const hidden = RULES.filter((r) => !r.constrains)
      .filter((r) => !GLOBAL_RESET.includes(r.selector))
      .flatMap((r) => r.decls.filter(critical).map((d) => `${where(r)} → ${d.prop}: ${d.value}`));
    expect(
      hidden,
      "关键属性被写进了「不带类名判据」的选择器里。本契约的元素模型只由类名描述," +
        "这类规则不参与级联 = 它对所有断言隐形。请改写成带类名的选择器," +
        "或者(确属全局重置时)加进 GLOBAL_RESET 并写明理由。",
    ).toEqual([]);
  });

  it("扫描面自检:magic 清单不许存在,磁盘上的表与 main.tsx 的 import 必须一一对应", () => {
    expect(ON_DISK.length, "src/styles 下的样式表").toBeGreaterThanOrEqual(5);
    expect(
      [...IMPORTED].sort(),
      "main.tsx 的 import 清单与磁盘上的 *.css 必须完全一致:" +
        "多出来的是死表,少掉的那张既没被应用加载、又会让契约的层叠顺序算错",
    ).toEqual(ON_DISK);
    expect(SHEETS.map((s) => s.name), "扫描面").toEqual(SHEET_ORDER);
  });

  it("铺满视口的浮层(grid 与 flex 都算)必须被扫到", () => {
    expect(LAYERS.map((l) => l.name), "扫描判据失效:一个铺满视口的浮层都没找到").not.toEqual([]);
    expect(
      LAYERS.some((l) => l.el.has("overlay")),
      ".overlay 必须落在扫描范围内",
    ).toBe(true);
    // 全屏层名册。少一族 = 判据被某种写法绕过了;多一族 = 有人新加了一个
    // 铺满视口的浮层却没人过一遍这套行/溢出的口径——两个方向都必须有人看一眼,
    // 所以这里用相等而不是「≥ 3」。
    const bases = new Set(LAYERS.flatMap((l) => l.base));
    expect(
      [...bases].sort(),
      `扫到的全屏层:${LAYERS.map((l) => l.name).join(" / ")}\n` +
        "少一族 = 扫描判据又被某种等价写法绕过(position/inset/display 拆块、" +
        "100vw+100vh 代替 inset:0 …),请修解析器而不是改这条名册;\n" +
        "多一族 = 新增了铺满视口的浮层:请确认它的行(grid)或弹性子轨(flex)" +
        "已经过了下面那几条用例,然后把它加进这个名册。",
    ).toEqual(["group-layer", "lightbox", "overlay"]);
  });

  it("grid 全屏层必须显式声明 grid-template-rows,且不许用 grid/grid-template 简写绕过", () => {
    const grids = LAYERS.filter((l) => l.display === "grid");
    expect(grids.length, "一个 grid 全屏层都没扫到").toBeGreaterThanOrEqual(1);

    const bad = grids.filter((l) => finalOf(l.el, "grid-template-rows") === null).map((l) => l.name);
    expect(
      bad,
      "铺满视口的 grid 浮层不写 grid-template-rows,就只有一条隐式 auto 行:" +
        "内容一超过视口,行被内容撑到内容高度,子浮层的 height/max-height:100% " +
        "解析出来的是「内容高度」而不是「一屏」,内部 overflow-y:auto 永远没有可滚量。" +
        "实测:927px 视口下审计日志抽屉的行长成 1507px,列表滚不动、脚跑到视口外。",
    ).toEqual([]);

    // 简写会覆盖 grid-template-rows 却绕开上面的判据,契约只认长写法
    const shorthand: string[] = [];
    for (const l of grids) {
      for (const h of hits(l.el, (d) => d.prop === "grid" || d.prop === "grid-template")) {
        shorthand.push(`${where(h.rule)} → ${h.decl.prop}: ${h.decl.value}`);
      }
    }
    expect(
      shorthand,
      "全屏层不许用 `grid` / `grid-template` 简写设置行:简写能覆盖 grid-template-rows " +
        "却绕开本契约的判据。请改写成 grid-template-rows。",
    ).toEqual([]);
  });

  it("grid 全屏层的每一条轨道:浏览器认得 + 最小值与内容无关", () => {
    // 覆盖浮层元素身上的**每一条**行声明:基础规则、修饰类、元素限定(div.overlay)、
    // 属性选择器([class~="overlay"])、追加的重复块、媒体查询里的覆盖、!important——
    // 任何一处写成 auto 都能把病灶原样放回来,所以一条都不能漏。
    const grids = LAYERS.filter((l) => l.display === "grid");
    expect(grids.map((l) => l.name), "grid 全屏层").not.toEqual([]);

    const bad: string[] = [];
    let seen = 0;
    for (const l of grids) {
      const list = hits(l.el, (d) => d.prop === "grid-template-rows" || d.prop === "grid-auto-rows");
      if (!list.length) continue;
      for (const { rule, decl } of list) {
        seen++;
        const parsed = tracks(decl.value);
        if (!parsed || !parsed.length) {
          bad.push(`${l.name} @ ${where(rule)} → ${decl.prop}: ${decl.value}(解析不出任何轨道)`);
          continue;
        }
        for (const t of parsed) {
          const v = judgeTrack(t);
          if (!v.valid) bad.push(`${l.name} @ ${where(rule)} → ${decl.prop}: ${decl.value}(轨道 "${t}" 非法:${v.why})`);
          else if (!v.safe) bad.push(`${l.name} @ ${where(rule)} → ${decl.prop}: ${decl.value}(轨道 "${t}" 不安全:${v.why})`);
        }
      }
    }
    expect(seen, "grid 全屏层应当至少有一处行声明(找不到说明基础规则被删了)").toBeGreaterThanOrEqual(1);
    expect(
      bad,
      "全屏层的行必须两关都过:\n" +
        "① 合法——浏览器不认的写法(minmax 里塞 fit-content()、单位打错、calc 表达式不合法、" +
        "var 不存在)会让整条声明被丢弃,退回隐式 auto 行,100% 复现原病灶,实测三种写法都是 1507px;\n" +
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
    expect(flexes.map((l) => l.name), "一个 flex 全屏层都没扫到——.group-layer / .lightbox 应当在内").not.toEqual([]);

    const bad: string[] = [];
    for (const layer of flexes) {
      const dir = finalOf(layer.el, "flex-direction");
      if (dir !== "column") {
        bad.push(`${layer.name} → flex-direction: ${dir ?? "(未写,默认 row)"};本契约只认识列方向的全屏层`);
        continue;
      }
      for (const base of layer.base) {
        const kids = elementsWith(element(base));
        if (!kids.length) {
          bad.push(`${layer.name} → 扫不到任何 .${base}__* 子元素(判据失效)`);
          continue;
        }
        // 子轨按「主体类名」归组:`.lightbox__image--empty` 与 `.lightbox__image`
        // 是同一个 DOM 节点的两种形态,不能算成两条子轨。
        const grow = new Map<string, number>();
        for (const el of kids) {
          const primary = [...el].filter((c) => element(base)(c) && !c.includes("--")).sort()[0];
          if (!primary) continue;
          const g = growOf(el);
          if (g === null) continue;
          grow.set(primary, Math.max(grow.get(primary) ?? 0, g)); // 任一形态会瓜分 = 判它瓜分
        }
        const flexible = [...grow].filter(([, g]) => g > 0).map(([c]) => c);
        if (flexible.length !== 1) {
          bad.push(
            `${layer.name} → 弹性子轨有 ${flexible.length} 条(${flexible.join(",") || "无"});` +
              "必须有且只有一条瓜分剩余高度,其余一律 flex:0 0 auto",
          );
          continue;
        }
        const name = flexible[0];
        const own = new Set([name]);
        const minH = finalOf(own, "min-height");
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
        const y = finalOverflowY(own);
        if (CLIP_EXEMPT.includes(name)) {
          // 豁免也要留痕:它必须仍然写着裁剪值,否则这条豁免已经过期,该删
          if (!y || !CLIPPING.test(y)) {
            bad.push(`.${name} 在 CLIP_EXEMPT 名单里却不再裁剪(级联最终值 ${y ?? "未写"})——过期的豁免请删掉`);
          }
          continue;
        }
        if (!y || !SCROLLABLE.test(y)) {
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
    // 按元素而不是按块:追加一个重复的 `.drawer{grid-template-rows: auto …}`、
    // 或者 `body .drawer{…}` 这种更高 specificity 的覆盖,都会被扫到。
    const drawers = elementsWith((c) => c === "drawer" || c.startsWith("drawer--"));
    expect(drawers.map(elName), ".drawer 元素应当存在").not.toEqual([]);

    const bad: string[] = [];
    let rowDecls = 0;
    for (const el of drawers) {
      const list = hits(el, (d) => d.prop === "grid-template-rows");
      for (const { rule, decl } of list) {
        rowDecls++;
        const parsed = tracks(decl.value);
        if (!parsed || !parsed.length) {
          bad.push(`${elName(el)} @ ${where(rule)} → ${decl.value}(解析不出任何轨道)`);
          continue;
        }
        const judged = parsed.map((t) => ({ raw: t, v: judgeTrack(t) }));
        // 骨架行(头/过滤/脚)写 auto 是对的——抽屉自己已经被 height:100% 定高了;
        // 但只要有一条非法,整条声明会被浏览器丢弃 → 退回隐式 auto 行 → 原病灶。
        for (const { raw, v } of judged) {
          if (!v.valid) bad.push(`${elName(el)} @ ${where(rule)} → ${decl.value}(轨道 "${raw}" 非法:${v.why})`);
        }
        const flexible = judged.filter(({ v }) => v.flexible);
        if (flexible.length !== 1) {
          bad.push(`${elName(el)} @ ${where(rule)} → ${decl.value}(弹性行 ${flexible.length} 条,必须恰好 1 条正文行)`);
          continue;
        }
        if (!flexible[0].v.safe) {
          bad.push(
            `${elName(el)} @ ${where(rule)} → ${decl.value}(正文行 "${flexible[0].raw}" 的最小值必须是 0:` +
              "min 若是内容尺寸,19 条日志会把这行撑成 1313px,把脚顶到视口外)",
          );
        }
      }
    }
    expect(rowDecls, ".drawer 必须显式声明 grid-template-rows").toBeGreaterThanOrEqual(1);
    expect(bad, ".drawer 的行契约").toEqual([]);

    expect(
      finalOf(new Set(["drawer"]), "height"),
      ".drawer 靠 height:100% 吃满 overlay 的那一行——这也是上面那条轨道契约的意义所在",
    ).toBe("100%");
  });

  it("抽屉留有非裁剪的溢出兜底(退化态也不许静默丢内容)", () => {
    // 头 74 + 过滤 85 + 脚 35 = 194px 是抽屉的最小骨架。视口比它还矮时骨架会
    // 溢出抽屉自己的盒子,脚被推到视口外。挂一条 auto 让抽屉自身能滚,那点行程就够得着。
    // 实测日常态(933px 视口)scrollHeight === clientHeight === 933、
    // scrollWidth === clientWidth === 559 → 不出条、不吃滚轮,同一时刻只有 .drawer__body 在滚。
    for (const el of elementsWith((c) => c === "drawer" || c.startsWith("drawer--"))) {
      const y = finalOverflowY(el);
      expect(
        y,
        `${elName(el)} 必须声明溢出兜底:退化态下脚会被挤出自己的盒子,没有兜底就够不着`,
      ).not.toBeNull();
      expect(
        SCROLLABLE.test(y!),
        `${elName(el)} 的溢出兜底(级联最终值)是 "${y}"——必须是 auto/scroll。` +
          "hidden/clip 会把够不着的内容直接锁死,是评审判过 P0 的静默 fail-open;" +
          "visible/未写则等于没有兜底。",
      ).toBe(true);
    }
  });

  it("浮层链上不许出现裁剪型 overflow(零静默)", () => {
    // 判例:`.content--flush{overflow:hidden}` 曾把内容裁成彻底不可达(评审 P0)。
    // 守的不变式是「同一片区域同一时刻只有一个容器响应滚轮/出条」,
    // 不是「结构上只许有一个 overflow:auto」——一个 scrollHeight === clientHeight
    // 的兜底 auto 对用户不存在,却能在退化态兜住可达性。
    const BASES = ["overlay", "drawer", "dialog", "group-layer", "lightbox"];
    const inFamily = (c: string) => BASES.some((b) => family(b)(c) || element(b)(c));

    // 扫的是「主语属于浮层族」的规则(后代规则如 `.overlay .badge` 主语是 .badge,不算)
    const scanned = RULES.filter((r) => [...r.subjectClasses].some(inFamily));
    expect(scanned.length, "浮层族的规则应当被扫到(扫不到 = 判据失效 = 假绿)").toBeGreaterThanOrEqual(6);

    const bad: string[] = [];
    for (const r of scanned) {
      if ([...r.subjectClasses].some((c) => CLIP_EXEMPT.includes(c))) continue;
      for (const d of r.decls) {
        if (!isOverflowY(d)) continue;
        if (CLIPPING.test(yOf(d.prop, d.value))) {
          bad.push(`${where(r)} → ${d.prop}: ${d.value}${d.important ? " !important" : ""}`);
        }
      }
    }
    expect(
      bad,
      "浮层链上用 hidden/clip 兜滚动问题,等于把够不着的内容彻底锁死;" +
        "该用 auto 兜底,让退化态仍然可达。确属刻意裁剪的,请加进 CLIP_EXEMPT 并写明理由。",
    ).toEqual([]);

    // 过期的豁免要判红:名单里的类名必须还真的存在、还真的在裁剪(按级联最终值)
    for (const name of CLIP_EXEMPT) {
      const own = elementsWith((c) => c === name);
      expect(own.length, `CLIP_EXEMPT 里的 .${name} 已经不存在了,请删掉这条豁免`).toBeGreaterThanOrEqual(1);
      const y = finalOverflowY(new Set([name]));
      expect(
        y !== null && CLIPPING.test(y),
        `CLIP_EXEMPT 里的 .${name} 的级联最终值是 "${y ?? "未写"}",已经不裁剪了,请删掉这条豁免`,
      ).toBe(true);
    }
  });

  it("对话框自封闭:max-height 与自身滚动必须成对出现", () => {
    // body 已全局禁滚。dialog 只有「收缩到一屏 + 自己滚」同时成立才是自封闭的;
    // 少任何一半,超窗内容都会溢出到视口外而不可达。
    // 按族扫:`.dialog--wide{max-height:none}` 这种修饰类覆盖同样是把自封闭解开
    const dialogs = elementsWith(family("dialog"));
    expect(dialogs.map(elName), ".dialog 元素应当存在").not.toEqual([]);

    const heights: string[] = [];
    for (const el of dialogs) {
      for (const { rule, decl } of hits(el, (d) => d.prop === "max-height")) {
        heights.push(`${where(rule)} → ${decl.value}`);
      }
    }
    expect(heights.length, ".dialog 必须收缩到一屏(没有任何一处 max-height)").toBeGreaterThanOrEqual(1);
    expect(
      heights.filter((h) => !h.endsWith("→ 100%")),
      ".dialog 族的 max-height 只许是 100%——任何一处放开都会让超窗内容溢出到视口外",
    ).toEqual([]);

    for (const el of dialogs) {
      const y = finalOverflowY(el);
      expect(
        y !== null && SCROLLABLE.test(y),
        `${elName(el)} 的溢出(级联最终值)是 "${y ?? "未写"}"——必须能自己滚,否则超窗内容溢出到视口外够不着`,
      ).toBe(true);
    }
  });
});

/**
 * 元素身上的 flex-grow(简写 / 长写 / 关键字都认),按级联取最终值;没声明返回 null。
 */
function growOf(el: ReadonlySet<string>): number | null {
  const h = cascade(hits(el, (d) => d.prop === "flex" || d.prop === "flex-grow"));
  if (!h) return null;
  const raw = h.decl.value.trim().toLowerCase();
  let value: string;
  if (h.decl.prop === "flex-grow") value = raw;
  else if (raw === "none" || raw === "initial") value = "0";
  else {
    const first = raw.split(/\s+/)[0];
    // `flex: 1 1 auto` → 1;`flex: auto` / `flex: 30%`(= 1 1 <basis>)→ 1
    value = /^\d/.test(first) && !/[a-z%]/.test(first) ? first : "1";
  }
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 1; // 认不出的写法按「会瓜分高度」算(fail-closed)
}
