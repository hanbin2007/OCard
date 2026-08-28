/**
 * 「侧栏 sticky 只许在双列断点内开启」的静态契约。
 *
 * 病灶(865efe0):双列布局的侧栏 `position: sticky` 在窗口变窄、布局塌成
 * 单列后没有取消。堆叠布局里 sticky 的约束矩形是 grid **容器**而不是它自己
 * 那一格,于是它能在整屏行程里粘住不动、让后面的内容从身下滚过 ——
 * 用户看到的就是「内容不动、滚动条照走,停下来也对不上、拖条也对不上」。
 * (WKWebView 与 Chrome 实测行为一致,不是 WebKit 独有。)
 *
 * 致病与否取决于**它是不是堆叠后的首个子元素**,不是断点值:排在最后的
 * 侧栏 sticky 没有行程、看着正常。所以这里不按「谁看起来正常」放行,
 * 一律要求 sticky 只出现在「窄屏必假」的查询里。
 *
 * 采用 mobile-first 之后,基础形态(窄屏)天然是单列 + 静态定位,
 * 「双列」与「吸顶」焊在同一条查询里 —— 任何一条查询失效都只会退回单列,
 * 不会退回病态。
 *
 * jsdom 无布局、不解析媒体查询,这类问题只能按 CSS 文本钉。
 *
 * ------------------------------------------------------------------
 * 第三轮重写(2026-08-28):解析层从正则换成 **postcss AST**,断点从
 * **离散采样**换成 **区间求解**。
 *
 * 第二轮评审用等价改写实测出的漏网(全部已复现):
 *
 *   逃逸(该红没红)                                          旧版  现在
 *   @media (500px <= width <= 550px){ .aside{sticky} }        GREEN RED
 *       —— 旧版在 [1,100,320,480,640,720,800,820] 这几个采样点上
 *          全都算出「假」,于是被判成「窄屏必假」。区间求解不会漏:
 *          [500,550] 与窄区间 [1,820] 相交,一眼就是窄屏可达。
 *   .aside { position: var(--pos-pinned) }                    GREEN RED
 *       —— 同一提交里 overflow.test 专门写了 expandVars,sticky 没有。
 *
 *   误红(不该红却红了)                                      旧版  现在
 *   @media (min-width: calc(82em + 1px))                      RED   GREEN
 *       —— 旧版的 px() 只认 `<数字><px|rem|em>`,calc 一律返回 null,
 *          再按「认不出 = 可能为真」处理,合法断点被判成窄屏可达。
 *
 * 现在的口径:
 *  ① 媒体查询编译成**宽度区间的并集**(支持 min-/max-width、现代范围语法
 *     `width >= X` / `X <= width <= Y`、逗号并集、媒体类型、calc/em/rem/pt…);
 *  ② 「窄屏必假」= 这个区间集与 [1px, 最小窗宽] **不相交**;
 *  ③ 断点值 = 区间集的下确界(不再一格一格试);
 *  ④ **解析不出来的写法一律判红**,并在失败信息里点名「契约看不懂」——
 *     这条覆盖 src/styles 下的**每一条** @media,不只是 sticky 所在的那几条,
 *     免得新写法先在别处落地、再悄悄搬到 sticky 头上。
 *  ⑤ `position` 的取值走级联 + var() 展开,前缀写法 `-webkit-sticky` 也算。
 *
 * 自检的方向是「新东西不会隐形」:AST 里有几条规则,契约就必须登记几条;
 * 每一条按类名定位的规则都必须被某个候选元素命中;每一条 @media 都必须解析得动。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AST_SELECTOR_COUNT,
  CANDIDATES,
  elName,
  expandBem,
  expandVars,
  finalOf,
  IMPORTED,
  matchGroup,
  ON_DISK,
  ROOT,
  RULES,
  SHEETS,
  UNPARSED,
  where,
} from "./_css-contract";
import type { Rule } from "./_css-contract";

/* ================================================================== *
 * 五、媒体查询 → 宽度区间求解
 * ================================================================== */

const CONF = JSON.parse(
  readFileSync(resolve(ROOT, "src-tauri/tauri.conf.json"), "utf8"),
) as { app: { windows: Array<{ label: string; width: number; minWidth?: number }> } };

/**
 * 「窄」的界线:所有窗口里最小的 minWidth。
 *
 * 断点若不高于它,那条媒体查询在本应用里**永远为真**——写不写查询没区别,
 * 等于把 sticky 裸露在基础层。恒真的 `(min-width: 1px)` 就是这么逃掉的。
 */
const NARROW = Math.min(
  ...CONF.app.windows.map((w) => w.minWidth ?? w.width).filter((n) => Number.isFinite(n)),
);

/** 一段宽度区间(px);hi 可以是 Infinity */
interface Interval {
  lo: number;
  loOpen: boolean;
  hi: number;
  hiOpen: boolean;
}

const ALL: Interval = { lo: 0, loOpen: false, hi: Infinity, hiOpen: false };

type Widths =
  | { ok: true; set: Interval[] }
  | { ok: false; why: string };

function intersect(a: Interval, b: Interval): Interval | null {
  let lo = a.lo, loOpen = a.loOpen;
  if (b.lo > lo || (b.lo === lo && b.loOpen)) { lo = b.lo; loOpen = b.loOpen; }
  let hi = a.hi, hiOpen = a.hiOpen;
  if (b.hi < hi || (b.hi === hi && b.hiOpen)) { hi = b.hi; hiOpen = b.hiOpen; }
  if (lo > hi) return null;
  if (lo === hi && (loOpen || hiOpen)) return null;
  return { lo, loOpen, hi, hiOpen };
}

function intersectSets(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of a) for (const y of b) {
    const r = intersect(x, y);
    if (r) out.push(r);
  }
  return out;
}

/* ---------------- 长度求值 ---------------- */

/** 各单位到 px 的换算(媒体查询里 em/rem 都按初始字号 16px 算,与元素字号无关) */
const TO_PX: Record<string, number> = {
  px: 1, rem: 16, em: 16, pt: 96 / 72, pc: 16, in: 96,
  cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 2.54 / 40,
};

/** calc() 表达式的数值求值;算不出返回 null(→ 判红,不猜) */
function evalCalcPx(expr: string): number | null {
  const tokens = expr.match(/[()+\-*/]|[\d.]+[a-z]*/gi);
  if (!tokens) return null;
  // 与 CSS 一致:二元 +/- 两侧必须有空白。先按空白重新扫一遍确认。
  if (/[^\s(]\s*[+-]\s*[^\s)]/.test(expr) && !/\s[+-]\s/.test(expr)) return null;
  let i = 0;
  const peek = () => tokens[i];
  const value = (): number | null => {
    const t = tokens[i];
    if (t === undefined) return null;
    if (t === "(") {
      i++;
      const v = sum();
      if (v === null || tokens[i] !== ")") return null;
      i++;
      return v;
    }
    const m = /^([\d.]+)([a-z]*)$/i.exec(t);
    if (!m) return null;
    i++;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    if (!m[2]) return n;
    const f = TO_PX[m[2].toLowerCase()];
    return f === undefined ? null : n * f;
  };
  const prod = (): number | null => {
    let v = value();
    if (v === null) return null;
    while (peek() === "*" || peek() === "/") {
      const op = tokens[i++];
      const r = value();
      if (r === null) return null;
      if (op === "/" && r === 0) return null;
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const sum = (): number | null => {
    let v = prod();
    if (v === null) return null;
    while (peek() === "+" || peek() === "-") {
      const op = tokens[i++];
      const r = prod();
      if (r === null) return null;
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const out = sum();
  return out !== null && i === tokens.length ? out : null;
}

/** `<length>` → px;认不出返回 null */
function lenPx(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  if (/^0(\.0+)?$/.test(t)) return 0;
  const m = /^([\d.]+)([a-z]+)$/.exec(t);
  if (m) {
    const f = TO_PX[m[2]];
    return f === undefined ? null : Number(m[1]) * f;
  }
  const c = /^calc\(([\s\S]*)\)$/.exec(t);
  if (c) return evalCalcPx(c[1]);
  return null;
}

/* ---------------- 查询求解 ---------------- */

/** 顶层按某个字符切(括号里的不算) */
function splitTop(src: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of src) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0 && ch === sep) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** 顶层按 `and` 切 */
function splitAnd(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0 && /^\s+and\s+/i.test(src.slice(i))) {
      out.push(cur);
      cur = "";
      i += /^\s+and\s+/i.exec(src.slice(i))![0].length - 1;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** `width <op> V` → 区间 */
function fromCompare(op: string, v: number, widthOnLeft: boolean): Interval {
  const o = widthOnLeft ? op : { "<": ">", "<=": ">=", ">": "<", ">=": "<=" }[op]!;
  if (o === "<") return { lo: 0, loOpen: false, hi: v, hiOpen: true };
  if (o === "<=") return { lo: 0, loOpen: false, hi: v, hiOpen: false };
  if (o === ">") return { lo: v, loOpen: true, hi: Infinity, hiOpen: false };
  return { lo: v, loOpen: false, hi: Infinity, hiOpen: false };
}

const NOT_UNDERSTOOD = (raw: string, extra = "") =>
  ({
    ok: false as const,
    why: `媒体条件 "${raw.trim()}" 契约看不懂${extra ? `(${extra})` : ""}——` +
      "请改写成契约认得的形式(min-width / max-width / width 范围语法)," +
      "或者扩展本文件的媒体查询求解器。看不懂一律判红:猜错的代价是病灶原样复活。",
  });

/** 单条媒体特性 → 宽度区间集 */
function analyzeFeature(raw: string): Widths {
  const t = raw.trim();
  if (!t.startsWith("(") || !t.endsWith(")")) return NOT_UNDERSTOOD(raw, "不是括号包起来的媒体特性");
  const f = t.slice(1, -1).trim();
  if (!f) return NOT_UNDERSTOOD(raw);
  // 通用条件语法里的嵌套括号 / or / not:超出本求解器
  if (/\bor\b|\bnot\b/i.test(f)) return NOT_UNDERSTOOD(raw, "含 or/not");

  // 区间语法 `A <op> width <op> B`
  let m = /^(.+?)\s*(<=|<|>=|>)\s*width\s*(<=|<|>=|>)\s*(.+)$/i.exec(f);
  if (m) {
    const a = lenPx(m[1]);
    const b = lenPx(m[4]);
    if (a === null || b === null) return NOT_UNDERSTOOD(raw, "端点不是能求值的 <length>");
    const left = fromCompare(m[2], a, false);
    const right = fromCompare(m[3], b, true);
    const iv = intersect(left, right);
    return { ok: true, set: iv ? [iv] : [] };
  }
  // `width <op> V`
  m = /^width\s*(<=|<|>=|>|=)\s*(.+)$/i.exec(f);
  if (m) {
    const v = lenPx(m[2]);
    if (v === null) return NOT_UNDERSTOOD(raw, "取值不是能求值的 <length>");
    if (m[1] === "=") return { ok: true, set: [{ lo: v, loOpen: false, hi: v, hiOpen: false }] };
    return { ok: true, set: [fromCompare(m[1], v, true)] };
  }
  // `V <op> width`
  m = /^(.+?)\s*(<=|<|>=|>|=)\s*width$/i.exec(f);
  if (m) {
    const v = lenPx(m[1]);
    if (v === null) return NOT_UNDERSTOOD(raw, "取值不是能求值的 <length>");
    if (m[2] === "=") return { ok: true, set: [{ lo: v, loOpen: false, hi: v, hiOpen: false }] };
    return { ok: true, set: [fromCompare(m[2], v, false)] };
  }
  // 老式写法 `min-width: V` / `max-width: V` / `width: V`
  m = /^(min-|max-)?width\s*:\s*(.+)$/i.exec(f);
  if (m) {
    const v = lenPx(m[2]);
    if (v === null) return NOT_UNDERSTOOD(raw, "取值不是能求值的 <length>");
    if (m[1]?.toLowerCase() === "min-") return { ok: true, set: [fromCompare(">=", v, true)] };
    if (m[1]?.toLowerCase() === "max-") return { ok: true, set: [fromCompare("<=", v, true)] };
    return { ok: true, set: [{ lo: v, loOpen: false, hi: v, hiOpen: false }] };
  }
  // 其它含 width 的特性(device-width、aspect-ratio 里的 width…)一律判红,
  // 免得把「其实约束了宽度」的条件当成「与宽度无关」放行
  if (/width/i.test(f)) return NOT_UNDERSTOOD(raw, "含 width 但不是本求解器认得的宽度条件");
  // 与宽度无关的特性(min-height / prefers-* / orientation …):不构成宽度约束。
  // 注意这**不是**放行:不约束宽度 = 窄屏照样可能命中 = 对 sticky 来说就是裸露。
  return { ok: true, set: [ALL] };
}

/** 单条查询(媒体类型 + and 串起来的特性) */
function analyzeQuery(q: string): Widths {
  const text = q.trim();
  if (/^not\b/i.test(text)) return NOT_UNDERSTOOD(q, "以 not 开头");
  let rest = text;
  const m = /^(?:only\s+)?([a-z]+)\b\s*(?:and\s+([\s\S]*))?$/i.exec(text);
  if (m && !text.startsWith("(")) {
    const type = m[1].toLowerCase();
    if (type === "and" || type === "or" || type === "not") return NOT_UNDERSTOOD(q);
    // 屏幕上永不生效的媒体类型 = 空集(它无法在任何窗口宽度下命中)
    if (type !== "all" && type !== "screen") return { ok: true, set: [] };
    rest = (m[2] ?? "").trim();
    if (!rest) return { ok: true, set: [ALL] };
  }
  let set: Interval[] = [ALL];
  for (const part of splitAnd(rest)) {
    const r = analyzeFeature(part);
    if (!r.ok) return r;
    set = intersectSets(set, r.set);
  }
  return { ok: true, set };
}

/** 整条 @media 的 params(逗号 = 并集) */
function analyzeMedia(params: string): Widths {
  const out: Interval[] = [];
  for (const q of splitTop(params, ",")) {
    const r = analyzeQuery(q);
    if (!r.ok) return r;
    out.push(...r.set);
  }
  return { ok: true, set: out };
}

/** 与窄区间 [1, NARROW] 相交吗 */
function reachesNarrow(set: Interval[]): boolean {
  const narrow: Interval = { lo: 1, loOpen: false, hi: NARROW, hiOpen: false };
  return set.some((iv) => intersect(iv, narrow) !== null);
}

/** 区间集的下确界(断点值);空集返回 null */
function infimum(set: Interval[]): { value: number; open: boolean } | null {
  let best: { value: number; open: boolean } | null = null;
  for (const iv of set) {
    if (best === null || iv.lo < best.value || (iv.lo === best.value && !iv.loOpen && best.open)) {
      best = { value: iv.lo, open: iv.loOpen };
    }
  }
  return best;
}

type Gate =
  | { kind: "exposed" }
  | { kind: "unparsed"; why: string }
  | { kind: "narrow" }
  | { kind: "wide" };

/** 这条查询把规则关在「窄屏必假」的区间里了吗 */
function gateOf(media: string | null): Gate {
  if (media === null) return { kind: "exposed" };
  const r = analyzeMedia(media);
  if (!r.ok) return { kind: "unparsed", why: r.why };
  return reachesNarrow(r.set) ? { kind: "narrow" } : { kind: "wide" };
}

const gateText = (g: Gate, media: string | null) =>
  g.kind === "exposed" ? "基础层(裸露)"
    : g.kind === "unparsed" ? `@media ${media} —— ${g.why}`
      : `@media ${media}`;

/* ================================================================== *
 * 六、sticky 与轨道
 * ================================================================== */

/** `position: sticky` / `-webkit-sticky` / `var(--x)` 展开后是 sticky —— 都算 */
const STICKY_VALUE = /^(-webkit-)?sticky$/i;

interface StickyDecl {
  rule: Rule;
  media: string | null;
  gate: Gate;
}

/** position 的取值展不开(var 不存在或同名多值)时的记录:一律判红 */
const OPAQUE_POSITION: string[] = [];

const STICKY: StickyDecl[] = (() => {
  const out: StickyDecl[] = [];
  for (const r of RULES) {
    for (const d of r.decls) {
      if (d.prop !== "position") continue;
      const expanded = expandVars(d.value.trim());
      if (expanded === null) {
        OPAQUE_POSITION.push(`${where(r)} → position: ${d.value}`);
        // 展不开 = 有可能就是 sticky,按 sticky 处理(fail-closed)
        out.push({ rule: r, media: r.media, gate: gateOf(r.media) });
        continue;
      }
      if (STICKY_VALUE.test(expanded.trim())) {
        out.push({ rule: r, media: r.media, gate: gateOf(r.media) });
      }
    }
  }
  return out;
})();

/**
 * 与内容同处一个滚动容器内的表头吸顶,不受本规则约束:
 * 它粘的是自己所在列表的表头,没有「把后续内容从身下放过」的语义。
 */
const EXEMPT = [".files__scroll .list__head"];

/** 把 grid-template-columns 拆成一条条轨道(方括号里的命名线整组跳过) */
function tracks(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch === "[") { if (cur) { out.push(cur); cur = ""; } i = matchGroup(value, i); continue; }
    if (ch === "(") { const e = matchGroup(value, i); cur += value.slice(i, e); i = e; continue; }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ""; } i++; continue; }
    cur += ch;
    i++;
  }
  if (cur) out.push(cur);
  return out;
}

/** 一条规则块里某属性的最后一条声明(同块内后写的赢) */
function ruleValue(r: Rule, prop: string): string | null {
  let last: string | null = null;
  for (const d of r.decls) if (d.prop === prop) last = d.value;
  return last;
}

const targets = (r: Rule, cls: string) => r.subjectClasses.has(cls);

/** 这条规则是不是把某个容器变成了 ≥2 列 */
function isTwoCol(r: Rule): boolean {
  const cols = ruleValue(r, "grid-template-columns");
  return cols !== null && tracks(cols).length >= 2;
}

describe("侧栏 sticky 契约", () => {
  it("解析层自检:AST 里的每一条规则都必须被契约登记,一条都不许吞", () => {
    expect(
      UNPARSED,
      "下面这些写法契约看不懂。看不懂 = 它对所有断言隐形 = 假绿,所以一律判红。",
    ).toEqual([]);
    expect(
      RULES.length,
      `AST 有 ${AST_SELECTOR_COUNT} 条(选择器已按逗号拆开),契约只登记了 ${RULES.length} 条`,
    ).toBe(AST_SELECTOR_COUNT);
    const classScoped = RULES.filter((r) => r.constrains);
    expect(
      classScoped.filter((r) => !CANDIDATES.some((el) => r.match(el))).map(where),
      "这些按类名定位的规则不被任何候选元素命中,等于它们对本契约完全不可见",
    ).toEqual([]);
    // 「不带类名判据」的规则不在类名模型里,但 position 照样能致病:
    // `main > div { position: sticky }` 这种写法必须现在就红,而不是等到有人踩坑。
    expect(
      RULES.filter((r) => !r.constrains)
        .flatMap((r) => r.decls.filter((d) => d.prop === "position").map((d) => `${where(r)} → position: ${d.value}`))
        .filter((s) => /sticky/i.test(s)),
      "position:sticky 不许写在不带类名判据的选择器上——那类规则不在本契约的元素模型里",
    ).toEqual([]);
    expect(
      OPAQUE_POSITION,
      "这些 position 的取值展不开(变量不存在,或同名多值),契约无法判断它是不是 sticky。" +
        "请写死取值,或者把变量收敛成唯一定义。",
    ).toEqual([]);
  });

  it("扫描面自检:磁盘上的表与 main.tsx 的 import 必须一一对应", () => {
    expect(ON_DISK.length, "src/styles 下的样式表").toBeGreaterThanOrEqual(5);
    expect(
      [...IMPORTED].sort(),
      "main.tsx 的 import 清单与磁盘上的 *.css 必须完全一致:" +
        "多出来的是死表,少掉的那张既没被应用加载、又会让契约的层叠顺序算错",
    ).toEqual(ON_DISK);
  });

  it("每一条 @media 都必须解析得动(断点求解器不许对新写法装看不见)", () => {
    // 这条钉的是「新东西不会隐形」:只要 src/styles 里出现一种求解器不认识的
    // 媒体查询写法,现在就红——而不是等它某天搬到 sticky 头上才发作。
    const bad: string[] = [];
    const seen = new Set<string>();
    for (const r of RULES) {
      if (r.media === null || seen.has(r.media)) continue;
      seen.add(r.media);
      const v = analyzeMedia(r.media);
      if (!v.ok) bad.push(`${r.sheet}: ${v.why}`);
    }
    expect(bad, "媒体查询求解器不认识的写法").toEqual([]);
    expect(seen.size, "一条媒体查询都没扫到 = 解析器失效").toBeGreaterThanOrEqual(5);
  });

  it("解析器与原文交叉核对:原文有几条 sticky,就必须解析到几条", () => {
    // 数原文(剥掉注释)里的 sticky 字面量,与 AST 解析出来的条数硬核对。
    // 少一条就说明有写法被解析器漏掉了。
    const raw = SHEETS.reduce(
      (n, s) =>
        n +
        (s.css.replace(/\/\*[\s\S]*?\*\//g, "").match(/position\s*:\s*(-webkit-)?sticky/g) ?? []).length,
      0,
    );
    const parsed = RULES.reduce(
      (n, r) => n + r.decls.filter((d) => d.prop === "position" && STICKY_VALUE.test(d.value.trim())).length,
      0,
    );
    expect(parsed, `原文 ${raw} 条 sticky 声明,解析器只认出 ${parsed} 条`).toBe(raw);
    expect(raw, "一条 sticky 都没扫到 = 判据失效 = 全绿假象").toBeGreaterThanOrEqual(4);
  });

  it("每一处 sticky 要么在「窄屏必假」的查询内,要么是豁免的表头吸顶", () => {
    const bad = STICKY.filter(
      (d) => !EXEMPT.includes(d.rule.selector) && d.gate.kind !== "wide",
    );
    expect(
      bad.map((d) => `${d.rule.sheet}:${d.rule.line} ${d.rule.selector} — ${gateText(d.gate, d.media)}`),
      "侧栏 sticky 必须只在双列(窄屏必假的查询)时开启:单列下它会粘住不动、" +
        "让后面的内容从身下滚过,读作「滚动条与内容不同步」(865efe0)。\n" +
        `判据:查询的宽度区间必须与 [1px, ${NARROW}px] 完全不相交` +
        `(${NARROW} = tauri.conf.json 里最小的窗口 minWidth)——` +
        "断点不高于最小窗宽的查询在本应用里永远为真,等于没写。\n" +
        "若确为「同一滚动容器内的表头吸顶」,请加入 EXEMPT 并写明理由",
    ).toEqual([]);

    // 过期的豁免要判红:名单里的选择器必须还真的存在、还真的在吸顶
    for (const sel of EXEMPT) {
      expect(
        STICKY.some((d) => d.rule.selector === sel),
        `EXEMPT 里的 ${sel} 已经不再吸顶(或被改名了),请删掉这条豁免`,
      ).toBe(true);
    }
  });

  it("每一处 sticky 都必须真的有偏移量(没有偏移的 sticky 是死代码)", () => {
    // 反向的静默失效:`position: sticky` 不写 top/bottom 时它永远不粘。
    // 于是「把 top 删掉」就成了一种看起来在修 bug、实际只是让契约瞎掉的改法——
    // 布局照样是双列 sticky,只是这一处刚好不生效了。这里按级联查偏移量,
    // 一处都不许空着。
    const INSETS = ["top", "bottom", "left", "right", "inset", "inset-block", "inset-inline",
      "inset-block-start", "inset-block-end", "inset-inline-start", "inset-inline-end"];
    const bad: string[] = [];
    for (const d of STICKY) {
      for (const set of d.rule.candidates) {
        if (!set.length) continue;
        const el = expandBem(set);
        const has = INSETS.some((p) => {
          const v = finalOf(el, p);
          return v !== null && v.trim().toLowerCase() !== "auto";
        });
        if (!has) bad.push(`${elName(el)} @ ${where(d.rule)} 声明了 sticky 却没有任何偏移量`);
      }
    }
    expect(
      bad,
      "sticky 不写 top/bottom 就永远不会粘住:这条规则要么是死代码,要么是有人" +
        "用「删掉 top」的方式绕过了本契约。请补上偏移量,或者干脆把 sticky 删掉。",
    ).toEqual([]);
  });

  it("双列与吸顶必须写在同一条查询里(不靠手抄的断点数字同步)", () => {
    // 断点漂移是上一版测试的假绿来源:容器的双列断点改了、侧栏的覆盖没跟着改,
    // 中间那段区间就是病灶原样复活。焊在同一个块里,结构上无从漂移。
    const PAIRS = [
      { side: "wizard__preview", container: "wizard" },
      { side: "devices__form", container: "devices" },
      { side: "copy__form", container: "copy" },
    ];
    for (const { side, container } of PAIRS) {
      const stickyRules = STICKY.filter((d) => targets(d.rule, side)).map((d) => d.rule);
      expect(
        stickyRules.map((r) => r.selector),
        `.${side} 应当在某条媒体查询里开启 sticky`,
      ).not.toEqual([]);

      for (const r of stickyRules) {
        expect(r.mediaKey, `.${side} 的 sticky 不许写在基础层`).not.toBeNull();
        expect(
          gateOf(r.media).kind,
          `.${side} 的吸顶查询 "${r.media}" 必须窄屏必假(> ${NARROW}px 才生效)`,
        ).toBe("wide");
        // 同一个媒体块里必须**同时**有容器的双列
        const twoCol = RULES.some(
          (c) => c.mediaKey === r.mediaKey && targets(c, container) && isTwoCol(c),
        );
        expect(
          twoCol,
          `.${container} 的双列与 .${side} 的吸顶必须在同一条查询块里,` +
            "且那条 grid-template-columns 必须真的是两列以上——" +
            "只写查询不改列(或改成单列)时,吸顶就在单列布局里生效了,正是 865efe0 的病灶",
        ).toBe(true);
      }
    }
  });

  it("默认窗口宽度足以容纳双栏(否则一打开就是单列)", () => {
    // 主窗口默认 1280 而双栏断点 1313 —— 一打开就落在单列区间,
    // 正是这次报障的现场。默认尺寸与断点必须一起看,单独调任何一边都会
    // 让「默认双栏」这个产品意图悄悄失效。
    const win = (label: string) => {
      const w = CONF.app.windows.find((x) => x.label === label);
      expect(w, `tauri.conf.json 里应当有 ${label} 窗口`).toBeDefined();
      return w!;
    };
    /** 断点值 = 查询宽度区间的下确界(按语义求,不认死 `min-width: Npx` 这一种写法) */
    const bpOf = (media: string | null, what: string) => {
      expect(media, `${what} 应当写在某条媒体查询里`).not.toBeNull();
      const v = analyzeMedia(media!);
      expect(v.ok, `${what} 的查询 "${media}" 契约看不懂`).toBe(true);
      const inf = infimum((v as { ok: true; set: Interval[] }).set);
      expect(inf, `${what} 的查询 "${media}" 解析不出断点值`).not.toBeNull();
      return inf!;
    };
    /** 默认窗宽 w 是否真的落在查询生效的一侧 */
    const covers = (w: number, inf: { value: number; open: boolean }) =>
      inf.open ? w > inf.value : w >= inf.value;

    const copyRule = STICKY.find((d) => targets(d.rule, "copy__form"))?.rule;
    expect(copyRule, ".copy__form 应当在某条媒体查询里开启 sticky").toBeDefined();
    const copyBp = bpOf(copyRule!.media, ".copy__form 的吸顶");
    expect(
      covers(win("main").width, copyBp),
      `主窗口默认宽度 ${win("main").width} 必须 ≥ 拷卡/设备屏的双栏断点(${copyBp.value}px)`,
    ).toBe(true);

    // 项目管理页的双栏在 shell.css 的 .split 上
    const splitRule = RULES.find(
      (r) => r.sheet === "shell.css" && targets(r, "split") && r.media !== null && isTwoCol(r),
    );
    expect(splitRule, ".split 应当在某条媒体查询里变成双列").toBeDefined();
    const splitBp = bpOf(splitRule!.media, ".split 的双列");
    expect(
      covers(win("welcome").width, splitBp),
      `欢迎窗口默认宽度 ${win("welcome").width} 必须 ≥ 项目管理页的双栏断点(${splitBp.value}px)`,
    ).toBe(true);
  });

  it("基础形态是单列(降级方向安全)", () => {
    for (const c of ["wizard", "devices", "copy"]) {
      const base = RULES.filter(
        (r) => r.media === null && targets(r, c) && ruleValue(r, "grid-template-columns") !== null,
      );
      expect(base.map((r) => r.selector), `.${c} 应当存在基础规则`).not.toEqual([]);
      for (const r of base) {
        const cols = ruleValue(r, "grid-template-columns")!;
        expect(
          tracks(cols).length,
          `.${c} 的基础形态必须是单列(现在是 "${cols}")——查询失效时要退回安全态,而不是病态`,
        ).toBe(1);
      }
    }
  });
});
