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
 * 一律要求 sticky 只出现在 `min-width` 查询里。
 *
 * 采用 mobile-first 之后,基础形态(窄屏)天然是单列 + 静态定位,
 * 「双列」与「吸顶」焊在同一条 `@media (min-width: …)` 里 ——
 * 任何一条查询失效都只会退回单列,不会退回病态。本测试因此只需守一件事:
 * **没有裸露在基础层的 sticky**。
 *
 * jsdom 无布局、不解析媒体查询,这类问题只能按 CSS 文本钉。
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

/**
 * 与内容同处一个滚动容器内的表头吸顶,不受本规则约束:
 * 它粘的是自己所在列表的表头,没有「把后续内容从身下放过」的语义。
 */
const EXEMPT = [".files__scroll .list__head"];

interface StickyDecl {
  sheet: string;
  selector: string;
  /** 包裹它的媒体查询条件(没有则为 null = 裸露在基础层) */
  media: string | null;
}

/** 逐规则块解析:能看见缩进的、后代的、逗号列表里的每一个选择器 */
function findSticky(): StickyDecl[] {
  const out: StickyDecl[] = [];
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
      if (!/position:\s*sticky/.test(rm[2])) continue;
      const at = rm.index;
      const wrap = medias.find((x) => at > x.start && at < x.end);
      for (const sel of rm[1].split(",").map((x) => x.trim()).filter(Boolean)) {
        if (!sel.startsWith(".")) continue;
        out.push({ sheet: name, selector: sel, media: wrap ? wrap.cond : null });
      }
    }
  }
  return out;
}

describe("侧栏 sticky 契约", () => {
  const decls = findSticky();

  it("扫描确实抓到了 sticky 声明(解析器自身不许静默失效)", () => {
    // 解析器一旦被 CSS 写法绕过就会退化成「零发现 → 全绿」,先钉住它有产出
    expect(decls.length).toBeGreaterThanOrEqual(4);
  });

  it("每一处 sticky 要么在 min-width 查询内,要么是豁免的表头吸顶", () => {
    const bad = decls.filter(
      (d) => !EXEMPT.includes(d.selector) && !/min-width/.test(d.media ?? ""),
    );
    expect(
      bad.map((d) => `${d.sheet} ${d.selector} @${d.media ?? "基础层(裸露)"}`),
      "侧栏 sticky 必须只在双列(min-width)时开启:单列下它会粘住不动、" +
        "让后面的内容从身下滚过,读作「滚动条与内容不同步」(865efe0)。" +
        "若确为「同一滚动容器内的表头吸顶」,请加入 EXEMPT 并写明理由",
    ).toEqual([]);
  });

  it("双列与吸顶必须写在同一条查询里(不靠手抄的断点数字同步)", () => {
    // 断点漂移是上一版测试的假绿来源:容器的双列断点改了、侧栏的覆盖没跟着改,
    // 中间那段区间就是病灶原样复活。焊在同一个块里,结构上无从漂移。
    const PAIRS = [
      { side: ".wizard__preview", container: ".wizard" },
      { side: ".devices__form", container: ".devices" },
      { side: ".copy__form", container: ".copy" },
    ];
    for (const { side, container } of PAIRS) {
      const sheet = SHEETS.find((s) => s.css.includes(`${side} {`));
      expect(sheet, `${side} 应当存在`).toBeDefined();
      const css = sheet!.css;
      const mq = new RegExp(
        `@media \\(min-width: \\d+px\\) \\{[^@]*?${container.replace(".", "\\.")} \\{[^}]*grid-template-columns[^}]*\\}[^@]*?${side.replace(".", "\\.")} \\{[^}]*position:\\s*sticky[^}]*\\}`,
        "s",
      );
      expect(
        mq.test(css),
        `${container} 的双列与 ${side} 的吸顶必须在同一条 @media (min-width) 块里`,
      ).toBe(true);
    }
  });

  it("基础形态是单列(降级方向安全)", () => {
    const sheet = SHEETS.find((s) => s.name === "screens.css")!.css;
    for (const c of [".wizard", ".devices", ".copy"]) {
      const m = new RegExp(`\\n${c.replace(".", "\\.")} \\{([^}]*)\\}`).exec(sheet);
      expect(m, `${c} 应当存在基础规则`).not.toBeNull();
      expect(
        /grid-template-columns:\s*minmax\(0,\s*1fr\);/.test(m![1]),
        `${c} 的基础形态必须是单列——查询失效时要退回安全态,而不是病态`,
      ).toBe(true);
    }
  });
});
