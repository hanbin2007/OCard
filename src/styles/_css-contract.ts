/**
 * 三条 CSS 静态契约(overflow / sticky / stacking)共用的解析层。
 *
 * 为什么是一个模块而不是三份拷贝:这三个文件恰恰是**防线本身**,
 * 而它们从前是同一段解析器的三个副本——手改任何一份都会漂移,
 * 三个副本各自漂移是最坏的一种技术债(2026-08-28 第三轮评审)。
 *
 * 文件名的下划线前缀不是装饰:vitest 的 include 是 `src/**\/*.test.{ts,tsx}`,
 * 本文件不匹配,不会被当成测试文件收走(它没有 describe/it,收走就报空套件)。
 *
 * ------------------------------------------------------------------
 * 这套解析层守的口径,一句话:**判据的主语是「元素」,不是「规则块」**。
 *
 * 契约先从所有选择器主语里枚举出「可能存在的元素」(一组类名,BEM 修饰类
 * 自动补基类),再站在每个元素身上把命中的规则按
 * `(!important, specificity, 源序)` 算级联最终值。于是这几类等价改写
 * ——拆块、追加重复块、属性选择器、元素限定、更高 specificity 的覆盖、
 * !important——一次性全都覆盖,而不是逐个打补丁。
 *
 * 另一条口径:**不认识 = 判红**。选择器解析不了、at-rule 不认识、
 * var() 展不开,一律进 `UNPARSED`,由各契约的自检用例判红并点名
 * 「契约看不懂,请改写或扩展解析器」。看不懂却放行 = 它对所有断言隐形 = 假绿。
 *
 * 已知边界(写明比假装覆盖强):本模块的「元素」只由类名描述,
 * 因此**不带类名判据的选择器**(`html`、`body`、`.x > :last-child` …)
 * 不参与级联。各契约用「关键属性不许写在这类选择器上」的自检补住这个口。
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import postcss from "postcss";
import type { AtRule, ChildNode, Declaration, Rule as PcRule } from "postcss";

/* ================================================================== *
 * 一、样式表清单与层叠顺序
 * ================================================================== */

export const ROOT = process.cwd();
const DIR = resolve(ROOT, "src/styles");

/** 磁盘上的全部样式表(全量扫描:漏一张表 = 漏一段防线) */
export const ON_DISK = readdirSync(DIR)
  .filter((f) => f.endsWith(".css"))
  .sort();

/**
 * 层叠顺序 = main.tsx 里的 `import` 次序,**不是字母序**。
 * 真实顺序是 tokens → base → shell → components → screens → gallery → welcome,
 * 按字母序算会把 shell 排到 screens 后面,级联结论跟着错。
 */
export const IMPORTED = [
  ...readFileSync(resolve(ROOT, "src/main.tsx"), "utf8").matchAll(
    /import\s+["']\.\/styles\/([\w.@-]+\.css)["']/g,
  ),
].map((m) => m[1]);

/** 没被 import 的表照样扫(排在最后),同时由自检用例把这个不一致judge成红 */
export const SHEET_ORDER = [
  ...IMPORTED.filter((f) => ON_DISK.includes(f)),
  ...ON_DISK.filter((f) => !IMPORTED.includes(f)),
];

export const SHEETS = SHEET_ORDER.map((name) => ({
  name,
  css: readFileSync(resolve(DIR, name), "utf8"),
}));

/* ================================================================== *
 * 二、选择器解析(手写,但按结构走:字符串/括号/方括号/函数式伪类都认)
 * ================================================================== */

export type Pred = (el: ReadonlySet<string>) => boolean;
export type Spec = [number, number, number];

interface CompoundInfo {
  spec: Spec;
  preds: Pred[];
  /** 主语是否至少要求一个类名(用于「这条规则能归属到谁」) */
  requiresClass: boolean;
  /** 满足本复合选择器的最小类集合;`:is(.a, .b)` 会产生多组 */
  candidates: string[][];
}

export interface SelInfo {
  spec: Spec;
  match: Pred;
  requiresClass: boolean;
  /** 主语里是否**有任何**基于类名的判据(没有 = 这条规则不是冲着某个类去的) */
  constrains: boolean;
  candidates: string[][];
  subjectClasses: Set<string>;
}

/** CSS 标识符(含反斜杠转义) */
const IDENT = /^-?(?:[_a-zA-Z\u00a0-\uffff]|\\[\s\S])(?:[-\w\u00a0-\uffff]|\\[\s\S])*/;

const unescapeIdent = (s: string) => s.replace(/\\([\s\S])/g, "$1");

/** 从 open 处(`(` 或 `[`)找到配对的收尾,返回收尾字符的**下一个**下标 */
export function matchGroup(src: string, open: number): number {
  const openCh = src[open];
  const closeCh = openCh === "(" ? ")" : "]";
  let depth = 0;
  let quote = "";
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\\") { i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error(`括号不配平:${src.slice(open)}`);
}

/** 顶层切分:把选择器切成一串复合选择器(组合符与括号/引号内的字符都不误切) */
function splitCompounds(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (quote) {
      cur += ch;
      if (ch === "\\") cur += sel[++i] ?? "";
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\\") { cur += ch + (sel[i + 1] ?? ""); i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") { depth++; cur += ch; continue; }
    if (ch === ")" || ch === "]") { depth--; cur += ch; continue; }
    if (depth === 0 && (/\s/.test(ch) || ch === ">" || ch === "+" || ch === "~")) {
      if (cur) { out.push(cur); cur = ""; }
      continue;
    }
    // 命名空间 / 列组合符:本项目不用,遇到宁可判红也不猜
    if (depth === 0 && ch === "|") throw new Error("命名空间或列组合符 `|` 契约看不懂");
    cur += ch;
  }
  if (depth !== 0 || quote) throw new Error("选择器的括号或引号不配平");
  if (cur) out.push(cur);
  return out;
}

/** 逗号切分(顶层),给 `:is(a, b)` 这类选择器列表用 */
function splitList(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      cur += ch;
      if (ch === "\\") cur += src[++i] ?? "";
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\\") { cur += ch + (src[i + 1] ?? ""); i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (depth === 0 && ch === ",") { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const maxSpec = (list: Spec[]): Spec =>
  list.reduce<Spec>((a, b) => (cmpSpec(b, a) > 0 ? b : a), [0, 0, 0]);

export const cmpSpec = (a: Spec, b: Spec) =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** 接受选择器列表的伪类:里面的类名是**可选分支**,不是必须项 */
const LIST_PSEUDOS = new Set(["is", "matches", "-webkit-any", "-moz-any", "any", "where"]);
/** 伪元素(单冒号的四个历史写法也算) */
const LEGACY_PSEUDO_ELEMENTS = new Set(["before", "after", "first-line", "first-letter"]);

function parseCompound(src: string): CompoundInfo {
  const spec: Spec = [0, 0, 0];
  const preds: Pred[] = [];
  let requiresClass = false;
  let candidates: string[][] = [[]];

  const requireClass = (name: string) => {
    requiresClass = true;
    preds.push((el) => el.has(name));
    candidates = candidates.map((s) => [...s, name]);
  };

  let i = 0;
  let atStart = true;
  while (i < src.length) {
    const rest = src.slice(i);

    if (rest.startsWith("*")) { i += 1; atStart = false; continue; }

    // 伪元素
    if (rest.startsWith("::") || /^:(?:before|after|first-line|first-letter)\b/i.test(rest)) {
      const doubled = rest.startsWith("::");
      const m = IDENT.exec(rest.slice(doubled ? 2 : 1));
      if (!m) throw new Error(`伪元素写法契约看不懂:${rest}`);
      if (!doubled && !LEGACY_PSEUDO_ELEMENTS.has(m[0].toLowerCase())) {
        throw new Error(`伪元素写法契约看不懂:${rest}`);
      }
      i += (doubled ? 2 : 1) + m[0].length;
      if (src[i] === "(") i = matchGroup(src, i);
      spec[2] += 1;
      atStart = false;
      continue;
    }

    // 伪类
    if (rest.startsWith(":")) {
      const m = IDENT.exec(rest.slice(1));
      if (!m) throw new Error(`伪类写法契约看不懂:${rest}`);
      const name = m[0].toLowerCase();
      let j = i + 1 + m[0].length;
      let arg: string | null = null;
      if (src[j] === "(") {
        const end = matchGroup(src, j);
        arg = src.slice(j + 1, end - 1);
        j = end;
      }
      i = j;
      atStart = false;

      if (LIST_PSEUDOS.has(name) && arg !== null) {
        const branches = splitList(arg).map(analyzeSelector);
        // `:where()` 的 specificity 恒为 0;`:is()`/`:matches()` 取分支最大值
        if (name !== "where") {
          const mx = maxSpec(branches.map((b) => b.spec));
          spec[0] += mx[0]; spec[1] += mx[1]; spec[2] += mx[2];
        }
        preds.push((el) => branches.some((b) => b.match(el)));
        // 只有**每个**分支都要求类名,整条才算「要求类名」
        if (branches.length > 0 && branches.every((b) => b.requiresClass)) requiresClass = true;
        const alt = branches.flatMap((b) => b.candidates);
        if (alt.length) {
          const next: string[][] = [];
          for (const base of candidates) for (const a of alt) next.push([...base, ...a]);
          candidates = dedupeSets(next).slice(0, 16);
        }
        continue;
      }
      if (name === "not" && arg !== null) {
        const branches = splitList(arg).map(analyzeSelector);
        const mx = maxSpec(branches.map((b) => b.spec));
        spec[0] += mx[0]; spec[1] += mx[1]; spec[2] += mx[2];
        // 只对「真的约束了类名」的分支取反。`:not(:disabled)` /
        // `:not([data-theme="light"])` 说的是状态/属性,本模型的元素只由类名描述,
        // 拿它取反会把整条规则算成「永远不命中」——那才是真正的隐形。
        const real = branches.filter((b) => b.constrains);
        if (real.length) preds.push((el) => !real.some((b) => b.match(el)));
        continue;
      }
      if (name === "has" && arg !== null) {
        // `:has()` 说的是后代,对「这个元素自己有哪些类」不构成约束
        const branches = splitList(arg).map((s) => analyzeSelector(s.replace(/^[>+~]\s*/, "")));
        const mx = maxSpec(branches.map((b) => b.spec));
        spec[0] += mx[0]; spec[1] += mx[1]; spec[2] += mx[2];
        continue;
      }
      if ((name === "nth-child" || name === "nth-last-child") && arg !== null && /\bof\b/i.test(arg)) {
        const of = arg.slice(arg.toLowerCase().indexOf(" of ") + 4);
        const branches = splitList(of).map(analyzeSelector);
        preds.push((el) => branches.some((b) => b.match(el)));
        spec[1] += 1;
        continue;
      }
      // 其余伪类(:hover / :focus-visible / :nth-child(2n) / :lang(zh) …):
      // 对类名集合不构成约束,按「可能命中」算(宽进 = 更容易被断言扫到 = fail-closed)
      spec[1] += 1;
      continue;
    }

    if (rest.startsWith(".")) {
      const m = IDENT.exec(rest.slice(1));
      if (!m) throw new Error(`类选择器写法契约看不懂:${rest}`);
      spec[1] += 1;
      requireClass(unescapeIdent(m[0]));
      i += 1 + m[0].length;
      atStart = false;
      continue;
    }

    if (rest.startsWith("#")) {
      const m = IDENT.exec(rest.slice(1));
      if (!m) throw new Error(`ID 选择器写法契约看不懂:${rest}`);
      spec[0] += 1;
      i += 1 + m[0].length;
      atStart = false;
      continue;
    }

    if (rest.startsWith("[")) {
      const end = matchGroup(src, i);
      const inner = src.slice(i + 1, end - 1);
      spec[1] += 1;
      applyAttr(inner);
      i = end;
      atStart = false;
      continue;
    }

    if (atStart) {
      const m = IDENT.exec(rest);
      if (m) { spec[2] += 1; i += m[0].length; atStart = false; continue; }
    }

    throw new Error(`看不懂的选择器片段 "${rest}"(请改写,或扩展本文件的选择器解析器)`);
  }

  function applyAttr(inner: string) {
    const m =
      /^\s*([-\w\\]+)\s*(?:([~^|$*]?=)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s\]]+)\s*[iIsS]?\s*)?$/.exec(
        inner,
      );
    if (!m) throw new Error(`属性选择器 [${inner}] 契约看不懂`);
    const attr = unescapeIdent(m[1]).toLowerCase();
    if (attr !== "class") return; // 非 class 属性:对类名集合无约束
    if (!m[2]) {
      // `[class]`:有类就行,归不到具体的类
      preds.push((el) => el.size > 0);
      return;
    }
    const raw = m[3];
    const value = /^["']/.test(raw) ? raw.slice(1, -1) : raw;
    const op = m[2];
    if (op === "~=") { requireClass(value); return; }
    if (op === "=") {
      // `[class="a b"]`:class 属性整体相等 ⇒ 每个词都在
      for (const tok of value.split(/\s+/).filter(Boolean)) requireClass(tok);
      return;
    }
    // 子串型:按「含有这个片段的类」算,候选元素取它本身(最朴素的代表)
    requiresClass = true;
    candidates = candidates.map((s) => [...s, value]);
    if (op === "*=") preds.push((el) => [...el].some((c) => c.includes(value)));
    else if (op === "^=") preds.push((el) => [...el].some((c) => c.startsWith(value)));
    else if (op === "$=") preds.push((el) => [...el].some((c) => c.endsWith(value)));
    else if (op === "|=") preds.push((el) => [...el].some((c) => c === value || c.startsWith(`${value}-`)));
    else throw new Error(`属性选择器运算符 ${op} 契约看不懂`);
  }

  return { spec, preds, requiresClass, candidates: dedupeSets(candidates) };
}

function dedupeSets(list: string[][]): string[][] {
  const seen = new Map<string, string[]>();
  for (const s of list) {
    const norm = [...new Set(s)].sort();
    seen.set(norm.join(" "), norm);
  }
  return [...seen.values()];
}

function analyzeSelector(selector: string): SelInfo {
  const clean = selector.replace(/\/\*[\s\S]*?\*\//g, " ").trim();
  if (!clean) throw new Error("空选择器");
  const comps = splitCompounds(clean);
  if (!comps.length) throw new Error("空选择器");
  const spec: Spec = [0, 0, 0];
  let subject: CompoundInfo | null = null;
  for (let k = 0; k < comps.length; k++) {
    const c = parseCompound(comps[k]);
    spec[0] += c.spec[0]; spec[1] += c.spec[1]; spec[2] += c.spec[2];
    if (k === comps.length - 1) subject = c;
  }
  const s = subject!;
  return {
    spec,
    match: (el) => s.preds.every((p) => p(el)),
    requiresClass: s.requiresClass,
    constrains: s.preds.length > 0,
    candidates: s.candidates,
    subjectClasses: new Set(s.candidates.flat()),
  };
}

/* ================================================================== *
 * 三、规则表(postcss AST)
 * ================================================================== */

export interface Decl {
  prop: string;
  value: string;
  important: boolean;
}

export interface Rule extends SelInfo {
  sheet: string;
  line: number;
  order: number;
  selector: string;
  /** 包裹它的媒体查询条件(嵌套时按 and 串起来);null = 裸露在基础层 */
  media: string | null;
  /** 最内层 @media 块的身份:用来判断「两条规则是不是焊在同一个块里」 */
  mediaKey: string | null;
  decls: Decl[];
}

/** 解析层看不懂的写法:非空即判红 */
export const UNPARSED: string[] = [];

/** @media 块的身份表(同一个 AtRule 节点 → 同一个 key) */
const MEDIA_KEYS = new Map<AtRule, string>();

const PARSED = (() => {
  const out: Rule[] = [];
  let selectorCount = 0;
  let order = 0;
  for (const { name, css } of SHEETS) {
    const root = postcss.parse(css, { from: name });
    root.walkRules((rule: PcRule) => {
      const conds: string[] = [];
      let inKeyframes = false;
      let unsupportedAt: string | null = null;
      let mediaKey: string | null = null;
      for (let p = rule.parent; p && p.type === "atrule"; p = (p as AtRule).parent) {
        const at = p as AtRule;
        const n = at.name.toLowerCase().replace(/^-\w+-/, "");
        if (n.endsWith("keyframes")) { inKeyframes = true; break; }
        if (n === "media") {
          conds.unshift(at.params.trim());
          if (mediaKey === null) {
            if (!MEDIA_KEYS.has(at)) MEDIA_KEYS.set(at, `${name}#${MEDIA_KEYS.size}`);
            mediaKey = MEDIA_KEYS.get(at)!;
          }
        } else if (n !== "supports" && n !== "layer" && n !== "scope") unsupportedAt = `@${at.name}`;
      }
      if (inKeyframes) return;

      const decls: Decl[] = [];
      rule.each((n: ChildNode) => {
        if (n.type !== "decl") return;
        const d = n as Declaration;
        decls.push({
          prop: d.prop.trim().toLowerCase(),
          value: d.value.trim(),
          important: Boolean(d.important),
        });
      });

      const line = rule.source?.start?.line ?? 0;
      for (const sel of rule.selectors) {
        selectorCount++;
        if (unsupportedAt) {
          UNPARSED.push(`${name}:${line} "${sel}" 被 ${unsupportedAt} 包着,契约看不懂这层 at-rule`);
          continue;
        }
        let info: SelInfo;
        try {
          info = analyzeSelector(sel);
        } catch (e) {
          UNPARSED.push(`${name}:${line} 选择器 "${sel.trim()}" —— ${(e as Error).message}`);
          continue;
        }
        out.push({
          ...info,
          sheet: name,
          line,
          order: order++,
          selector: sel.trim(),
          media: conds.length ? conds.join(" and ") : null,
          mediaKey,
          decls,
        });
      }
    });
  }
  return { rules: out, selectorCount };
})();

/** 契约登记到的规则(逗号拆开后一条选择器一条) */
export const RULES: Rule[] = PARSED.rules;

/**
 * AST 里的规则条数(逗号拆开后)。
 * 交叉核对用:`RULES.length` 必须等于它,少一条就说明有写法被解析器吞了。
 */
export const AST_SELECTOR_COUNT = PARSED.selectorCount;

export const where = (r: Rule) => `${r.sheet}:${r.line} ${r.selector}${r.media ? ` @media ${r.media}` : ""}`;

/* ================================================================== *
 * 四、候选元素 + 级联
 * ================================================================== */

/**
 * BEM 修饰类隐含基类:一个带 `.overlay--drawer` 的元素身上一定也有 `.overlay`。
 * 不补基类的话 `.overlay--drawer{grid-template-rows:auto}` 会被算成一个
 * 「只有修饰类、没有 position:fixed」的元素,整条覆盖对契约隐形。
 */
export function expandBem(classes: string[]): Set<string> {
  const out = new Set(classes);
  for (const c of classes) {
    const at = c.indexOf("--");
    if (at > 0) out.add(c.slice(0, at));
  }
  return out;
}

/** 契约实际去「站在它身上算级联」的那批元素:每条规则主语要求的类集合 */
export const CANDIDATES: Set<string>[] = (() => {
  const seen = new Map<string, Set<string>>();
  for (const r of RULES) {
    for (const set of r.candidates) {
      if (!set.length) continue;
      const el = expandBem(set);
      seen.set([...el].sort().join(" "), el);
    }
  }
  return [...seen.values()];
})();

export const elName = (el: ReadonlySet<string>) => [...el].map((c) => `.${c}`).join("");

export interface Hit {
  rule: Rule;
  decl: Decl;
}

/** 元素 el 身上命中的、属性满足 pred 的全部声明,按源序 */
export function hits(el: ReadonlySet<string>, pred: (d: Decl) => boolean): Hit[] {
  const out: Hit[] = [];
  for (const r of RULES) {
    // 本模型的「元素」只由类名描述,所以只有按类名定位的规则参与级联。
    // `html, body { overflow: hidden }` 这种纯元素规则不针对任何类,
    // 让它参战会把它的值算到每一个元素头上(实测:.drawer 的 overflow 会被算成 hidden)。
    // 这是本契约明确写下的边界:纯元素/伪类选择器不在类名模型内。
    if (!r.constrains) continue;
    if (!r.match(el)) continue;
    for (const d of r.decls) if (pred(d)) out.push({ rule: r, decl: d });
  }
  return out;
}

/**
 * 级联:!important 优先 → specificity 高者优先 → 同权时源序靠后者优先。
 *
 * 媒体查询里的覆盖也一并参战(它在某些窗口宽度下就是最终值),
 * 这是刻意的 fail-closed:窄窗里把行改成 auto 一样是病灶。
 */
export function cascade(list: Hit[]): Hit | null {
  let best: Hit | null = null;
  for (const h of list) {
    if (!best) { best = h; continue; }
    if (h.decl.important !== best.decl.important) {
      if (h.decl.important) best = h;
      continue;
    }
    if (cmpSpec(h.rule.spec, best.rule.spec) >= 0) best = h; // >= ⇒ 后写的赢
  }
  return best;
}

/** 元素身上某属性的最终值 */
export function finalOf(el: ReadonlySet<string>, prop: string): string | null {
  const h = cascade(hits(el, (d) => d.prop === prop));
  return h ? h.decl.value : null;
}

/* ================================================================== *
 * 五、值解析:var() / calc() / 轨道白名单
 * ================================================================== */

/** 全表的自定义属性;同名多值(明暗主题各一份)一律按「展不开」处理 */
const VARS = (() => {
  const out = new Map<string, Set<string>>();
  for (const r of RULES) {
    for (const d of r.decls) {
      if (!d.prop.startsWith("--")) continue;
      if (!out.has(d.prop)) out.set(d.prop, new Set());
      out.get(d.prop)!.add(d.value.trim());
    }
  }
  return out;
})();

/** 按顶层分隔符切(括号里的不算) */
export function topLevelSplit(value: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0 && ch === sep) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * 展开 `var(--x)` / `var(--x, 回退值)`;展不开返回 null。
 * 变量名打错时浏览器**整条丢弃声明**并退回隐式 auto 行(实测复现原病灶),
 * 所以「展不开」必须等于判红。
 */
export function expandVars(value: string, depth = 0): string | null {
  if (!value.includes("var(")) return value;
  if (depth > 4) return null;
  const at = value.indexOf("var(");
  let end: number;
  try { end = matchGroup(value, at + 3); } catch { return null; }
  const inner = value.slice(at + 4, end - 1);
  const parts = topLevelSplit(inner, ",");
  const name = parts[0].trim();
  const fallback = parts.length > 1 ? parts.slice(1).join(",").trim() : null;
  const defs = VARS.get(name);
  let sub: string | null = null;
  if (defs && defs.size === 1) sub = [...defs][0];
  else if (fallback !== null) sub = fallback;
  if (sub === null) return null;
  return expandVars(value.slice(0, at) + sub + value.slice(end), depth + 1);
}


