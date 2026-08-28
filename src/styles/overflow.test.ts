/**
 * 「全屏 grid 浮层不许把行交给内容定高」的静态契约。
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
 * 这类问题在单测里只能钉文本。骨架照抄同目录 `sticky.test.ts`
 * (剥注释填等量空白、逐规则块解析、解析器自身有产出的自检)。
 *
 * 变异验证(每一条都实测能红,详见改动说明):
 *   ① 删掉 `.overlay` 的 grid-template-rows
 *   ② 改成 `auto` / 裸 `1fr` / `minmax(auto, 1fr)`(三者的最小值都是内容尺寸)
 *   ③ 把整条规则换成同内容的注释伪代码(剥注释若失效则此项假绿)
 *   ④ 给 `.overlay` / `.drawer` 加 `overflow: hidden`(评审判过 P0 的静默 fail-open)
 *   ⑤ 删掉 `.drawer` 的 overflow-y 兜底,或删掉 `.dialog` 的 max-height/overflow 配对
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

interface Block {
  sheet: string;
  /** 逗号拆开后的每一个选择器 */
  selectors: string[];
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
      out.push({ sheet: name, selectors, body: m[2] });
    }
  }
  return out;
}

const BLOCKS = blocks();

function decl(body: string, prop: string): string | null {
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`).exec(body);
  return m ? m[1].trim() : null;
}

/** 把 grid-template-rows 的值拆成一条条轨道(minmax(...) 里的逗号不算分隔) */
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

/**
 * 这条轨道的**最小值**是否与内容无关。
 *
 * `auto` / `min-content` / `max-content` / `fit-content()` / 裸 `<flex>`
 * (`1fr` ≡ `minmax(auto, 1fr)`)的最小值都是内容尺寸——内容一超,轨道就跟着长,
 * 正是本病灶。只有显式 `minmax(0, …)` 或定长/百分比才与内容无关。
 */
function minIsContentIndependent(track: string): boolean {
  const t = track.toLowerCase();
  const mm = /^minmax\(([^,]+),/.exec(t);
  if (mm) {
    const min = mm[1].trim();
    return /^0(px|%|em|rem)?$/.test(min) || /^\d+(\.\d+)?(px|%|em|rem|vh|dvh)$/.test(min);
  }
  if (/^\d+(\.\d+)?fr$/.test(t)) return false; // 裸 1fr = minmax(auto, 1fr)
  if (/^(auto|min-content|max-content)$/.test(t)) return false;
  if (t.startsWith("fit-content")) return false;
  return /^\d+(\.\d+)?(px|%|em|rem|vh|dvh)$/.test(t);
}

const CLIPPING = /^(hidden|clip)$/;

/** 一个块是否把某个 overflow 属性设成了裁剪值 */
function clippingOverflow(body: string): string | null {
  for (const prop of ["overflow", "overflow-y"]) {
    const v = decl(body, prop);
    if (!v) continue;
    // `overflow: hidden auto` 这类两值写法:第一个是 x,第二个是 y
    const parts = v.split(/\s+/);
    const y = prop === "overflow" ? (parts[1] ?? parts[0]) : parts[0];
    if (CLIPPING.test(y)) return `${prop}: ${v}`;
  }
  return null;
}

describe("全屏 grid 浮层的溢出契约", () => {
  it("解析器确实抓到了样式表和规则块(自身不许静默失效)", () => {
    // 解析器一旦被写法绕过就会退化成「零发现 → 全绿」,先钉住它有产出
    expect(SHEETS.length).toBeGreaterThanOrEqual(5);
    expect(BLOCKS.length).toBeGreaterThanOrEqual(200);
    for (const sel of [".overlay", ".drawer", ".dialog", ".drawer__body"]) {
      expect(
        BLOCKS.some((b) => b.selectors.includes(sel)),
        `${sel} 的规则块应当被解析到——扫不到就等于这套断言全部落空`,
      ).toBe(true);
    }
  });

  it("铺满视口的 grid 浮层必须显式声明 grid-template-rows", () => {
    // 判据取「position: fixed + display: grid + inset: 0」:
    // 这正是"一条隐式 auto 行被内容撑大"能发生的全部条件。
    const fullscreenGrids = BLOCKS.filter(
      (b) =>
        /position:\s*fixed/.test(b.body) &&
        /display:\s*grid/.test(b.body) &&
        /(?:^|[;{\s])inset\s*:\s*0(?:px)?\s*(?:;|$)/.test(b.body),
    );

    // 扫不到任何块 = 判据被改写绕过(比如 inset 拆成 top/right/bottom/left),
    // 那就是假绿,先钉住它非空且包含已知的 .overlay
    expect(
      fullscreenGrids.map((b) => b.selectors.join(",")),
      "扫描判据失效:一个铺满视口的 grid 浮层都没找到",
    ).not.toEqual([]);
    expect(
      fullscreenGrids.some((b) => b.selectors.includes(".overlay")),
      ".overlay 必须落在扫描范围内",
    ).toBe(true);

    const bad = fullscreenGrids
      .filter((b) => !decl(b.body, "grid-template-rows"))
      .map((b) => `${b.sheet} ${b.selectors.join(",")}`);
    expect(
      bad,
      "铺满视口的 grid 浮层不写 grid-template-rows,就只有一条隐式 auto 行:" +
        "内容一超过视口,行被内容撑到内容高度,子浮层的 height/max-height:100% " +
        "解析出来的是「内容高度」而不是「一屏」,内部 overflow-y:auto 永远没有可滚量。" +
        "实测:927px 视口下审计日志抽屉的行长成 1507px,列表滚不动、脚跑到视口外。",
    ).toEqual([]);
  });

  it("浮层的行不许被内容撑大(每条轨道的最小值都要与内容无关)", () => {
    // 覆盖 .overlay 及其所有修饰类:改一条 `.overlay--x { grid-template-rows: auto }`
    // 就能把病灶原样放回来,所以按选择器族扫,而不是只看基础规则。
    const overlayRows = BLOCKS.filter(
      (b) =>
        b.selectors.some((s) => /(^|\s)\.overlay(--[\w-]+)?$/.test(s)) &&
        decl(b.body, "grid-template-rows"),
    );
    expect(
      overlayRows.length,
      ".overlay 族应当至少有一处 grid-template-rows(找不到说明基础规则被删了)",
    ).toBeGreaterThanOrEqual(1);

    const bad: string[] = [];
    for (const b of overlayRows) {
      const value = decl(b.body, "grid-template-rows")!;
      for (const t of tracks(value)) {
        if (!minIsContentIndependent(t)) {
          bad.push(`${b.sheet} ${b.selectors.join(",")} → ${value}(轨道 "${t}")`);
        }
      }
    }
    expect(
      bad,
      "`auto` / `min-content` / `max-content` / 裸 `1fr`(≡ minmax(auto,1fr))的最小值" +
        "都是内容尺寸,内容一超视口轨道就跟着长——正是本病灶。" +
        "要与内容无关,请写 `minmax(0, 1fr)` 或定长/百分比。",
    ).toEqual([]);
  });

  it("抽屉正文行必须可压缩(minmax(0, 1fr)),否则内容会顶开整个抽屉", () => {
    const drawer = BLOCKS.find((b) => b.selectors.includes(".drawer"));
    expect(drawer, ".drawer 规则块应当存在").toBeDefined();
    const value = decl(drawer!.body, "grid-template-rows");
    expect(value, ".drawer 必须显式声明 grid-template-rows").not.toBeNull();

    const list = tracks(value!);
    const flexible = list.filter((t) => /fr\)?$/.test(t));
    expect(
      flexible.length,
      ".drawer 必须有且只有一条弹性行(正文),其余是头/过滤/脚",
    ).toBe(1);
    expect(
      minIsContentIndependent(flexible[0]),
      `正文行 "${flexible[0]}" 的最小值必须是 0:` +
        "min 若是内容尺寸,19 条日志会把这行撑成 1313px,把脚顶到视口外。",
    ).toBe(true);

    expect(
      decl(drawer!.body, "height"),
      ".drawer 靠 height:100% 吃满 overlay 的那一行——这也是上面那条轨道契约的意义所在",
    ).toBe("100%");
  });

  it("抽屉留有非裁剪的溢出兜底(退化态也不许静默丢内容)", () => {
    // 头 74 + 过滤 85 + 脚 35 = 194px 是抽屉的最小骨架。视口比它还矮时骨架会
    // 溢出抽屉自己的盒子,脚被推到视口外。挂一条 auto 让抽屉自身能滚,那点行程就够得着。
    // 实测日常态(933px 视口)scrollHeight === clientHeight === 933、
    // scrollWidth === clientWidth === 559 → 不出条、不吃滚轮,同一时刻只有 .drawer__body 在滚。
    const drawer = BLOCKS.find((b) => b.selectors.includes(".drawer"))!;
    const y = decl(drawer.body, "overflow-y") ?? decl(drawer.body, "overflow");
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
    const FAMILY = /(^|\s)\.(overlay|drawer|dialog)(--[\w-]+|__[\w-]+)?$/;
    const scanned = BLOCKS.filter((b) => b.selectors.some((s) => FAMILY.test(s)));
    expect(
      scanned.length,
      "浮层族的规则块应当被扫到(扫不到 = 判据失效 = 假绿)",
    ).toBeGreaterThanOrEqual(6);

    const bad = scanned
      .map((b) => {
        const hit = clippingOverflow(b.body);
        return hit ? `${b.sheet} ${b.selectors.join(",")} → ${hit}` : null;
      })
      .filter(Boolean);
    expect(
      bad,
      "浮层链上用 hidden/clip 兜滚动问题,等于把够不着的内容彻底锁死;" +
        "该用 auto 兜底,让退化态仍然可达。",
    ).toEqual([]);
  });

  it("对话框自封闭:max-height 与自身滚动必须成对出现", () => {
    // body 已全局禁滚。dialog 只有「收缩到一屏 + 自己滚」同时成立才是自封闭的;
    // 少任何一半,超窗内容都会溢出到视口外而不可达。
    // 另:overflow-y:auto 让它的最小内容高度为 0,max-height:100% 才真正约束得住——
    // 这也是修复前 .dialog 在 Chrome 里侥幸没出事的原因,但那依赖的是
    // 「循环百分比」这种引擎自定行为;行显式定高之后,100% 是有定值可依的。
    const dialog = BLOCKS.find((b) => b.selectors.includes(".dialog"));
    expect(dialog, ".dialog 规则块应当存在").toBeDefined();
    expect(decl(dialog!.body, "max-height"), ".dialog 必须收缩到一屏").toBe("100%");
    const y = decl(dialog!.body, "overflow-y") ?? decl(dialog!.body, "overflow");
    expect(
      y && /^(auto|scroll)/.test(y),
      `.dialog 的溢出是 "${y}"——必须能自己滚,否则超窗内容溢出到视口外够不着`,
    ).toBe(true);
  });
});
