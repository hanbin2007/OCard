/**
 * 「侧栏 sticky 必须在单列断点下取消」的静态契约。
 *
 * 这条规则用了三轮误诊才找到:双列布局里侧栏 `position: sticky` 是对的,
 * 但窗口变窄、布局塌成**单列**之后,sticky 会把上半部分粘在视口顶端不动,
 * 下半部分从它身下滚过去——用户看到的就是「内容不动、滚动条照走,
 * 停下来也对不上、拖条也对不上」。用户 1280 宽的窗口正好落在断点内侧,
 * 而项目屏的断点更低(1080)所以唯独它正常,更把人往错误方向带。
 *
 * 第一版修复还栽了第二跤:覆盖规则写在了基础规则**前面**,同特指度下
 * 媒体查询不加权,被后面的 sticky 覆盖,等于没写。所以这里连**源序**
 * 一起钉死。
 *
 * jsdom 没有布局也不解析媒体查询,这类问题只能按 CSS 文本钉。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const SHEETS = ["screens", "shell", "components", "welcome"] as const;
const css = Object.fromEntries(
  SHEETS.map((n) => [
    n,
    readFileSync(resolve(process.cwd(), `src/styles/${n}.css`), "utf8"),
  ]),
) as Record<(typeof SHEETS)[number], string>;
const all = Object.values(css).join("\n");

/**
 * 受本规则约束的「双列布局 + sticky 侧栏」清单。
 * 新增同型布局时把它加进来——漏加不会被自动发现,这是本表存在的理由。
 */
const STICKY_SIDEBARS = [
  { selector: ".copy__form", collapseAt: 1312 },
  { selector: ".devices__form", collapseAt: 1312 },
  { selector: ".wizard__preview", collapseAt: 1312 },
  { selector: ".detail", collapseAt: 1080 },
];

/** 某选择器声明 position 的位置(返回全部出现处的下标与值) */
function positionDecls(sheet: string, selector: string) {
  const out: Array<{ index: number; value: string }> = [];
  const re = new RegExp(
    `(^|[\\s,}])${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(sheet))) {
    const pos = /position:\s*([a-z-]+)/.exec(m[2]);
    if (pos) out.push({ index: m.index, value: pos[1] });
  }
  return out;
}

describe("侧栏 sticky 与单列断点", () => {
  for (const { selector, collapseAt } of STICKY_SIDEBARS) {
    it(`${selector}: 单列(≤${collapseAt}px)下必须取消 sticky`, () => {
      const sheet = Object.values(css).find((s) =>
        positionDecls(s, selector).some((d) => d.value === "sticky"),
      );
      expect(sheet, `${selector} 应当在某张样式表里声明 position:sticky`).toBeDefined();

      const decls = positionDecls(sheet!, selector);
      const sticky = decls.find((d) => d.value === "sticky");
      const staticDecl = decls.find((d) => d.value === "static");

      expect(
        staticDecl,
        `${selector} 在单列布局下必须还原为 position:static,` +
          `否则堆叠布局里它会粘住不动、下半部分从身下滚过(读作「滚动条与内容不同步」)`,
      ).toBeDefined();

      // 源序:覆盖必须在基础规则之后,否则同特指度下被覆盖回去(等于没写)
      expect(
        staticDecl!.index,
        `${selector} 的 position:static 必须写在 position:sticky **之后**——` +
          `媒体查询不提升特指度,写在前面会被后面的 sticky 盖掉`,
      ).toBeGreaterThan(sticky!.index);

      // 覆盖必须包在对应断点的媒体查询里
      const around = sheet!.slice(Math.max(0, staticDecl!.index - 400), staticDecl!.index);
      expect(
        around,
        `${selector} 的 static 覆盖应当位于 @media (max-width: ${collapseAt}px) 内`,
      ).toContain(`max-width: ${collapseAt}px`);
    });
  }

  it("没有遗漏:每个 position:sticky 的侧栏都在清单里(表头等吸顶元素除外)", () => {
    const stickySelectors = [...all.matchAll(/(^|\n)(\.[a-z0-9_-]+)\s*\{[^}]*position:\s*sticky/gi)]
      .map((m) => m[2])
      .filter((s, i, arr) => arr.indexOf(s) === i);
    // 表头吸顶是「同一个滚动容器内」的合法用法,不受本规则约束
    const exempt = [".list__head", ".files__head", ".topbar"];
    const unlisted = stickySelectors.filter(
      (s) => !STICKY_SIDEBARS.some((x) => x.selector === s) && !exempt.includes(s),
    );
    expect(
      unlisted,
      `这些 sticky 元素既不在受管清单里也不在豁免名单里,` +
        `请确认它们所在布局塌单列时不会粘住:${unlisted.join(", ")}`,
    ).toEqual([]);
  });
});
