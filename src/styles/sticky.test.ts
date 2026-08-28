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
 * 本文件的默认方向是 **fail-closed**:不认识的写法一律判红。
 *
 * 上一版被两路评审用真实变异打出六类假绿 + 一类误红,全部来自「判据认得太少」:
 *
 *   变异                                            旧版   现在
 *   .aside{position:sticky}                         RED    RED
 *   .aside{position:-webkit-sticky}                 ★GREEN RED   前缀写法
 *   #root .copy__form{position:sticky}              ★GREEN RED   首字符不是 .
 *   main .aside{position:sticky}                    ★GREEN RED   后代选择器
 *   div.aside{position:sticky}                      ★GREEN RED   元素限定
 *   @media (min-width: 1px){ .aside{sticky} }       ★GREEN RED   恒真查询
 *   .copy__form 的 sticky 挪进 max-width 查询          RED    RED
 *   @media (width >= 1313px)(现代范围语法)            ✗RED   GREEN 合法写法不许误红
 *
 * 其中最要命的是旧版第 82 行那句 `if (!sel.startsWith(".")) continue;`:
 * 它让**任何首字符不是 `.` 的选择器**整条被跳过——那不是白名单收窄,是解析器
 * 直接失明;而自检只要求「找到 ≥ 4 条」,现有 5 条稳稳撑住,退化根本察觉不到。
 *
 * 三处对应的修法:
 *  ① 选择器一律纳入(纯元素选择器也算),豁免只走显式 EXEMPT 名单;
 *  ② `position` 匹配放宽到 `position\s*:\s*(-webkit-)?sticky`;
 *  ③ 断点不再按字符串匹配,而是**求值**:把媒体查询条件在一串窄宽度上算一遍,
 *     只要它在窄屏可能为真就判红。恒真的 `(min-width: 1px)` 因此被抓住,
 *     而 `(width >= 1313px)` 这类合法的现代语法也不再误红。
 *     「窄」的界线取 tauri.conf.json 里最小的窗口 minWidth ——
 *     断点若不高于最小窗宽,这条查询在本应用里就是恒真的,等于裸露在基础层。
 *  ④ 自检从「≥ 4 条」升级成**与原文交叉核对**:原文里有几条 sticky 声明,
 *     解析器就必须解析到几条,少一条即判红。
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const DIR = resolve(process.cwd(), "src/styles");

/**
 * 剥注释,但用等量空白填回去——源序/位置断言依赖下标不变。
 * (上一版直接在原文上跑正则:把真规则整段换成同内容的注释,测试照样绿。)
 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** 全量扫描 src/styles 下每一张表,不维护手抄清单(漏表 = 漏防线) */
const SHEETS = readdirSync(DIR)
  .filter((f) => f.endsWith(".css"))
  .map((f) => ({ name: f, css: stripComments(readFileSync(resolve(DIR, f), "utf8")) }));

const CONF = JSON.parse(
  readFileSync(resolve(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"),
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

/* ------------------------------------------------------------------ *
 * 媒体查询求值(不按字符串匹配,按语义)
 * ------------------------------------------------------------------ */

/** 长度求值:px 直接用,rem/em 按根字号 16 折算;认不出返回 null */
function px(token: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(px|rem|em)$/.exec(token.trim());
  if (!m) return null;
  return Number(m[1]) * (m[2] === "px" ? 1 : 16);
}

/**
 * 这条媒体查询在宽度 w 下**有没有可能为真**。
 *
 * 「有没有可能」是刻意的 fail-closed:与宽度无关的特性(min-height、
 * prefers-* 等)一律按「可能为真」算,认不出来的写法也按「可能为真」算——
 * 于是「窄屏必假」这个判据只会更严,不会漏。
 */
function couldMatch(cond: string, w: number): boolean {
  const text = cond.trim().toLowerCase();
  // or / not / 逗号列表的语义超出本求值器,一律按「可能为真」处理(判红)
  if (/[,]|(^|\s)(not|or)(\s|$)/.test(text)) return true;
  for (const rawPart of text.split(/\s+and\s+/)) {
    const part = rawPart.trim().replace(/^\((.*)\)$/s, "$1").trim();
    if (!part || part === "screen" || part === "all" || part === "only screen") continue;
    if (!featureCouldMatch(part, w)) return false;
  }
  return true;
}

function featureCouldMatch(feature: string, w: number): boolean {
  // 老式写法:min-width / max-width / width: <len>
  const legacy = /^(min-|max-)?width\s*:\s*(.+)$/.exec(feature);
  if (legacy) {
    const v = px(legacy[2]);
    if (v === null) return true; // 认不出的取值 → 可能为真
    if (legacy[1] === "min-") return w >= v;
    if (legacy[1] === "max-") return w <= v;
    return w === v;
  }
  // 现代范围语法:width >= 1313px / 1313px <= width / 900px <= width <= 1200px
  if (/(^|[^-\w])width([^-\w]|$)/.test(feature) && /[<>]/.test(feature)) {
    const parts = feature.split(/(<=|>=|<|>)/).map((s) => s.trim());
    // [左, 运算符, 中, 运算符, 右] 这样的奇数长度序列
    for (let i = 1; i < parts.length; i += 2) {
      const op = parts[i];
      const left = parts[i - 1];
      const right = parts[i + 1];
      const leftV = left === "width" ? w : px(left);
      const rightV = right === "width" ? w : px(right);
      if (leftV === null || rightV === null) return true; // 认不出 → 可能为真
      const ok =
        op === "<" ? leftV < rightV
          : op === "<=" ? leftV <= rightV
            : op === ">" ? leftV > rightV
              : leftV >= rightV;
      if (!ok) return false;
    }
    return true;
  }
  // 与宽度无关的特性(min-height、prefers-reduced-motion…)不构成窄屏保护
  return true;
}

/** 采样宽度:从 1px 一路到「最小窗宽」,查询在这段区间里必须始终为假 */
const NARROW_SAMPLES = [1, 100, 320, 480, 640, 720, 800, NARROW];

/** 这条查询是否「窄屏必假」*/
function gatedToWide(cond: string | null): boolean {
  if (cond === null) return false; // 基础层裸露
  return NARROW_SAMPLES.every((w) => !couldMatch(cond, w));
}

/** 查询开始为真的最小宽度(断点值);永远不真则为 null */
function lowerBound(cond: string): number | null {
  for (let w = 1; w <= 5000; w++) if (couldMatch(cond, w)) return w;
  return null;
}

/* ------------------------------------------------------------------ *
 * CSS 解析
 * ------------------------------------------------------------------ */

interface Rule {
  sheet: string;
  /** 逗号拆开后的每一个选择器(原样,不做任何过滤) */
  selectors: string[];
  body: string;
  /** 包裹它的媒体查询条件(没有则为 null = 裸露在基础层) */
  media: string | null;
  at: number;
  /** 所在媒体块的区间(用来判断「两条规则是不是在同一个块里」) */
  mediaSpan: string | null;
}

function parse(): Rule[] {
  const out: Rule[] = [];
  for (const { name, css } of SHEETS) {
    // 记录每个 @media 块的字符区间与条件
    const medias: Array<{ start: number; end: number; cond: string }> = [];
    const mediaRe = /@media([^{]+)\{/g;
    let mm: RegExpExecArray | null;
    while ((mm = mediaRe.exec(css))) {
      // 花括号配对找块尾
      let depth = 1;
      let i = mediaRe.lastIndex;
      while (i < css.length && depth > 0) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}") depth--;
        i++;
      }
      medias.push({ start: mm.index, end: i, cond: mm[1].trim() });
    }

    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let rm: RegExpExecArray | null;
    while ((rm = ruleRe.exec(css))) {
      const selectors = rm[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (selectors.some((s) => s.startsWith("@"))) continue;
      const at = rm.index;
      // 嵌套时取**最内层**的那个块
      const wrapped = medias.filter((x) => at > x.start && at < x.end);
      const wrap = wrapped.length ? wrapped[wrapped.length - 1] : null;
      out.push({
        sheet: name,
        selectors,
        body: rm[2],
        media: wrap ? wrap.cond : null,
        at,
        mediaSpan: wrap ? `${name}:${wrap.start}-${wrap.end}` : null,
      });
    }
  }
  return out;
}

const RULES = parse();

/** `position: sticky` / `position:-webkit-sticky` / `position : sticky` 都算 */
const STICKY_RE = /position\s*:\s*(-webkit-)?sticky/;

interface StickyDecl {
  sheet: string;
  selector: string;
  media: string | null;
}

const STICKY: StickyDecl[] = RULES.filter((r) => STICKY_RE.test(r.body)).flatMap((r) =>
  // 选择器一律纳入:后代、id 前缀、元素限定、属性选择器、纯元素——一个都不跳过。
  // 想放行请写进 EXEMPT(要有理由),而不是让解析器装作没看见。
  r.selectors.map((selector) => ({ sheet: r.sheet, selector, media: r.media })),
);

/**
 * 与内容同处一个滚动容器内的表头吸顶,不受本规则约束:
 * 它粘的是自己所在列表的表头,没有「把后续内容从身下放过」的语义。
 */
const EXEMPT = [".files__scroll .list__head"];

/** 一条声明值:块内取最后一条(同块后写的赢) */
function decl(body: string, prop: string): string | null {
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "g");
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) last = m[1].replace(/!\s*important\s*$/i, "").trim();
  return last;
}

/** 把 grid-template-columns 拆成一条条轨道(括号里的空格不算分隔) */
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
  return out.filter((t) => !t.startsWith("["));
}

/** 选择器主语(最后一个复合选择器)里的类名 */
function subjectClasses(selector: string): string[] {
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
  return [...(cur || last).matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
}

const targets = (r: Rule, cls: string) =>
  r.selectors.some((s) => subjectClasses(s).includes(cls));

describe("侧栏 sticky 契约", () => {
  it("解析器与原文交叉核对:原文有几条 sticky,就必须解析到几条", () => {
    // 上一版的自检是「找到 ≥ 4 条」,而现有 5 条稳稳撑住——解析器瞎了一半也察觉不到。
    // 这里改成硬核对:少一条就说明有写法被解析器漏掉了。
    const raw = SHEETS.reduce(
      (n, s) => n + (s.css.match(/position\s*:\s*(-webkit-)?sticky/g) ?? []).length,
      0,
    );
    const parsed = RULES.filter((r) => STICKY_RE.test(r.body)).length;
    expect(parsed, `原文 ${raw} 条 sticky 声明,解析器只认出 ${parsed} 条`).toBe(raw);
    expect(raw, "一条 sticky 都没扫到 = 判据失效 = 全绿假象").toBeGreaterThanOrEqual(4);
    expect(RULES.length, "规则块解析结果").toBeGreaterThanOrEqual(200);
  });

  it("每一处 sticky 要么在「窄屏必假」的查询内,要么是豁免的表头吸顶", () => {
    const bad = STICKY.filter((d) => !EXEMPT.includes(d.selector) && !gatedToWide(d.media));
    expect(
      bad.map((d) => `${d.sheet} ${d.selector} @${d.media ?? "基础层(裸露)"}`),
      "侧栏 sticky 必须只在双列(窄屏必假的查询)时开启:单列下它会粘住不动、" +
        "让后面的内容从身下滚过,读作「滚动条与内容不同步」(865efe0)。\n" +
        `判据:查询在 1px…${NARROW}px(= tauri.conf.json 里最小的窗口 minWidth)` +
        "这段区间必须恒假——断点不高于最小窗宽的查询在本应用里永远为真,等于没写。\n" +
        "若确为「同一滚动容器内的表头吸顶」,请加入 EXEMPT 并写明理由",
    ).toEqual([]);

    // 过期的豁免要判红:名单里的选择器必须还真的存在、还真的在吸顶
    for (const sel of EXEMPT) {
      expect(
        STICKY.some((d) => d.selector === sel),
        `EXEMPT 里的 ${sel} 已经不再吸顶(或被改名了),请删掉这条豁免`,
      ).toBe(true);
    }
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
      // 承载该侧栏吸顶的媒体块
      const stickyRules = RULES.filter((r) => targets(r, side) && STICKY_RE.test(r.body));
      expect(
        stickyRules.map((r) => r.selectors.join(",")),
        `.${side} 应当在某条媒体查询里开启 sticky`,
      ).not.toEqual([]);

      for (const r of stickyRules) {
        expect(r.mediaSpan, `.${side} 的 sticky 不许写在基础层`).not.toBeNull();
        expect(
          gatedToWide(r.media),
          `.${side} 的吸顶查询 "${r.media}" 必须窄屏必假(> ${NARROW}px 才生效)`,
        ).toBe(true);
        // 同一个媒体块里必须**同时**有容器的双列
        const twoCol = RULES.some((c) => {
          if (c.mediaSpan !== r.mediaSpan || !targets(c, container)) return false;
          const cols = decl(c.body, "grid-template-columns");
          return cols !== null && tracks(cols).length >= 2;
        });
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
    /** 承载某个侧栏吸顶的断点值(按语义求,不认死 `min-width: Npx` 这一种写法) */
    const bp = (cls: string) => {
      const r = RULES.find((x) => targets(x, cls) && STICKY_RE.test(x.body) && x.media);
      expect(r, `.${cls} 应当在某条媒体查询里开启 sticky`).toBeDefined();
      const v = lowerBound(r!.media!);
      expect(v, `.${cls} 的查询 "${r!.media}" 解析不出断点值`).not.toBeNull();
      return v!;
    };

    expect(
      win("main").width,
      `主窗口默认宽度必须 ≥ 拷卡/设备屏的双栏断点(${bp("copy__form")}px)`,
    ).toBeGreaterThanOrEqual(bp("copy__form"));

    // 项目管理页的双栏在 shell.css 的 .split 上
    const splitRule = RULES.find(
      (r) =>
        r.sheet === "shell.css" &&
        targets(r, "split") &&
        r.media !== null &&
        (decl(r.body, "grid-template-columns")
          ? tracks(decl(r.body, "grid-template-columns")!).length >= 2
          : false),
    );
    expect(splitRule, ".split 应当在某条媒体查询里变成双列").toBeDefined();
    const splitBp = lowerBound(splitRule!.media!);
    expect(splitBp, `.split 的查询 "${splitRule!.media}" 解析不出断点值`).not.toBeNull();
    expect(
      win("welcome").width,
      `欢迎窗口默认宽度必须 ≥ 项目管理页的双栏断点(${splitBp}px)`,
    ).toBeGreaterThanOrEqual(splitBp!);
  });

  it("基础形态是单列(降级方向安全)", () => {
    for (const c of ["wizard", "devices", "copy"]) {
      const base = RULES.filter(
        (r) => r.media === null && targets(r, c) && decl(r.body, "grid-template-columns"),
      );
      expect(base.map((r) => r.selectors.join(",")), `.${c} 应当存在基础规则`).not.toEqual([]);
      for (const r of base) {
        const cols = decl(r.body, "grid-template-columns")!;
        expect(
          tracks(cols).length,
          `.${c} 的基础形态必须是单列(现在是 "${cols}")——查询失效时要退回安全态,而不是病态`,
        ).toBe(1);
      }
    }
  });
});
