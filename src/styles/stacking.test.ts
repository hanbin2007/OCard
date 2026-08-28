/**
 * 浮层层叠关系的静态闸门(opus 评审 P0 的教训):
 * jsdom 不做布局与命中测试,「确认框被会话门盖住点不到」这类 bug
 * 在组件测试里必然假绿——层级关系只能按 CSS 文本钉死。
 *
 * ------------------------------------------------------------------
 * 第三轮重写(2026-08-28):解析层从正则换成 **postcss AST**,层级取值从
 * 「按选择器字符串查表 + 取第一条」换成 **按元素算级联**。
 *
 * 第二轮评审用等价改写实测出的漏网(全部已复现):
 *
 *   逃逸(该红没红)                                          旧版  现在
 *   在 gallery.css 里新增 z-index: 999 的浮层                  GREEN RED
 *       —— 旧版的 SHEETS 只手抄了 components.css / screens.css 两张表,
 *          shell.css / gallery.css / welcome.css 整个在契约之外。
 *          现在 readdirSync 全量扫,并与 main.tsx 的 import 清单交叉核对。
 *   同一块里先写 z-index:100 再写 z-index:1                    GREEN RED
 *       —— 旧版 `.match()` 取第一条,不是级联最终值。
 *   body .toasts { z-index: 1 }                              GREEN RED
 *       —— 旧版把「更高 specificity 的覆盖」当成另一个 selector 存进 Map,
 *          不影响已登记项。现在按元素算级联:!important > specificity > 源序。
 *
 * 还有一条断言在旧版里根本就是假的:
 *   「没有编外浮层:每个 z-index ≥ 30 的规则都得在名册里报到」——
 *   而 shell.css 的 `.topbar__project-menu` 写着 z-index: 70,既不在名册里、
 *   也不在扫描面里。`.topbar` 与 `.topbar__project-wrap` 都不创建层叠上下文
 *   (relative 但没有 z-index),所以它是根层叠上下文里实打实的 z=70,
 *   与 `.select-pop` **并列**,并且压过了 .overlay(50)/.group-layer(55)/
 *   .lightbox(60)/.overlay--keyhelp(65)。
 *   本轮的处置:它是外壳级非模态浮层(和 .notice-panel/.quick-copy 同类),
 *   CSS 已改成 z-index: 35,名册里单独排一层。`.select-pop` 需要 70 的理由
 *   ——Select 会长在 dialog 里面——只对 .select-pop 成立,不可照抄。
 *
 * 名册的形状也跟着变了:一层 = 一个 **tier**,tier 之间必须严格递增,
 * tier 内部允许并列**但必须写明理由**(whyTie)。这样「意外并列」照样判红,
 * 而「刻意并列」是一条要有人签字的、看得见的决定。
 *
 * 本文件的自检钉的是「新东西不会隐形」:AST 里有几条规则契约就必须登记几条;
 * 每条按类名定位的规则都必须被某个候选元素命中;磁盘上的表必须与 import 清单一致。
 */

import { describe, expect, it } from "vitest";
import {
  AST_SELECTOR_COUNT,
  CANDIDATES,
  cascade,
  elName,
  expandBem,
  expandVars,
  finalOf,
  hits,
  IMPORTED,
  ON_DISK,
  RULES,
  UNPARSED,
  where,
} from "./_css-contract";
import type { Rule } from "./_css-contract";

/* ================================================================== *
 * 五、层级名册
 * ================================================================== */

interface Member {
  /** 这一层对应的元素:写修饰类即可,基类由 expandBem 自动补上 */
  classes: string[];
  note: string;
}

interface Tier {
  members: Member[];
  /** tier 内允许并列,但必须写明理由——「意外并列」和「刻意并列」得分得开 */
  whyTie?: string;
}

/**
 * 浮层层级的**完整**名册,按从下到上排。新增一层就必须在这里报到——
 * 下面那条「没有编外浮层」的断言会把漏登记的挡住。
 *
 * 这是 fail-closed 的方向:漏登记判红,而不是默默放行。
 */
const LAYERS: Tier[] = [
  { members: [{ classes: ["tag-picker__menu"], note: "标签选择器菜单" }] },
  {
    members: [
      {
        classes: ["topbar__project-menu"],
        note:
          "顶栏「当前项目」原地切换下拉。外壳级非模态浮层,与 .notice-panel/.quick-copy 同类," +
          "必须排在模态浮层 .overlay(50)之下:它一压过去,Tab 到被遮罩盖住的顶栏 chip " +
          "再回车,下拉就画在模态之上(普通模态没有 focus trap,全仓只有 SessionGuard 用 inert)。",
      },
    ],
  },
  { members: [{ classes: ["notice-panel"], note: "通知中心面板(顶栏铃铛)" }] },
  { members: [{ classes: ["quick-copy"], note: "快捷拷卡提示(非模态)" }] },
  { members: [{ classes: ["overlay"], note: "普通模态浮层(对话框/抽屉)" }] },
  { members: [{ classes: ["group-layer"], note: "连拍组全屏层" }] },
  { members: [{ classes: ["lightbox"], note: "大图全屏预览" }] },
  { members: [{ classes: ["overlay--keyhelp"], note: "快捷键速查表(要压过大图才看得见)" }] },
  {
    members: [
      {
        classes: ["select-pop"],
        note:
          "下拉浮层(portal 到 body)。它需要压过 .overlay(50)是因为 Select 会长在 dialog 里面——" +
          "这条理由**只对它成立**,别照抄给别的下拉(2026-08-28:.topbar__project-menu 就是照抄了 70," +
          "结果压过了所有模态与全屏层)。",
      },
    ],
  },
  { members: [{ classes: ["overlay--gate"], note: "会话门" }] },
  { members: [{ classes: ["overlay--elevated"], note: "门上的二次确认" }] },
  { members: [{ classes: ["toasts"], note: "toast(高于一切:提交失败必须永远可见)" }] },
];

/** 名册里每个成员对应的元素(BEM 修饰类自动补基类) */
const memberEl = (m: Member) => expandBem(m.classes);

/** 参与浮层排序的门槛:30 以下是屏内局部层叠(表头吸顶之类) */
const FLOAT_Z = 30;

/** z-index 取值解析:只认整数;auto/其它写法一律判红(不猜) */
const BAD_Z: string[] = [];

function zNumber(raw: string, at: string): number | null {
  const t = expandVars(raw.trim());
  if (t === null) {
    BAD_Z.push(`${at} → z-index: ${raw}(var() 展不开)`);
    return null;
  }
  const m = /^[+-]?\d+$/.exec(t.trim());
  if (!m) {
    BAD_Z.push(`${at} → z-index: ${raw}(契约只认整数,请写死)`);
    return null;
  }
  return Number(m[0]);
}

/** 元素身上 z-index 的级联最终值 */
function zIndexOf(m: Member): number {
  const el = memberEl(m);
  const h = cascade(hits(el, (d) => d.prop === "z-index"));
  if (!h) throw new Error(`名册里的 ${elName(el)} 在样式表里没有任何 z-index 规则`);
  const n = zNumber(h.decl.value, `${elName(el)} @ ${where(h.rule)}`);
  if (n === null) throw new Error(`名册里的 ${elName(el)} 的 z-index 解析不出整数:${h.decl.value}`);
  return n;
}

/** 名册里全部成员的元素集合(给「编外浮层」判据用) */
const ROSTER_ELS = LAYERS.flatMap((t) => t.members.map(memberEl));

/** 一条规则里 z-index 的最终声明(同块后写的赢) */
function ruleZ(r: Rule): { value: string; important: boolean } | null {
  let last: { value: string; important: boolean } | null = null;
  for (const d of r.decls) if (d.prop === "z-index") last = { value: d.value, important: d.important };
  return last;
}

describe("浮层层叠", () => {
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
    // 扫描面:全量扫 src/styles/*.css,并与 main.tsx 的 import 清单交叉核对。
    // 旧版手抄了两张表,于是 shell.css 的 .topbar__project-menu(z=70)
    // 与 gallery.css 里的任何新浮层都整个在契约之外。
    expect(ON_DISK.length, "src/styles 下的样式表").toBeGreaterThanOrEqual(5);
    expect(
      [...IMPORTED].sort(),
      "main.tsx 的 import 清单与磁盘上的 *.css 必须完全一致:" +
        "多出来的是死表,少掉的那张既没被应用加载、又会让契约的层叠顺序算错",
    ).toEqual(ON_DISK);
  });

  it("z-index 的取值必须是能判定的整数(auto / var 展不开一律判红)", () => {
    for (const r of RULES) {
      const z = ruleZ(r);
      if (z) zNumber(z.value, where(r));
    }
    for (const t of LAYERS) for (const m of t.members) zIndexOf(m);
    expect(BAD_Z, "这些 z-index 契约判定不了大小关系,请写死成整数").toEqual([]);
  });

  it("名册里的层级严格递增;并列必须写明理由(并列即命中顺序看书写次序)", () => {
    const tiers = LAYERS.map((t) => ({
      ...t,
      zs: t.members.map((m) => ({ m, z: zIndexOf(m) })),
    }));

    // ① tier 内部必须真的并列,而且必须有 whyTie
    const inconsistent: string[] = [];
    for (const t of tiers) {
      const values = [...new Set(t.zs.map((x) => x.z))];
      if (values.length > 1) {
        inconsistent.push(
          `同一 tier 里的 ${t.zs.map((x) => `.${x.m.classes.join(".")}(${x.z})`).join(" / ")} 取值不一致`,
        );
      } else if (t.members.length > 1 && !t.whyTie) {
        inconsistent.push(`${t.zs.map((x) => `.${x.m.classes.join(".")}`).join(" / ")} 并列却没写 whyTie`);
      }
    }
    expect(
      inconsistent,
      "同一 tier 的成员必须取值相同;并列必须在 whyTie 里写清「为什么允许并列、什么条件下它不致病」",
    ).toEqual([]);

    // ② tier 之间必须严格递增
    const z = tiers.map((t) => t.zs[0].z);
    const broken = z
      .slice(1)
      .map((cur, i) => ({ cur, prev: z[i], i }))
      .filter((x) => x.cur <= x.prev)
      .map(
        (x) =>
          `${tiers[x.i].zs.map((y) => `.${y.m.classes.join(".")}`).join("/")}(${x.prev}) → ` +
          `${tiers[x.i + 1].zs.map((y) => `.${y.m.classes.join(".")}`).join("/")}(${x.cur})`,
      );
    expect(broken, "相邻层级必须严格递增").toEqual([]);
  });

  it("没有编外浮层:每条 z-index ≥ 30 的规则都得能归属到名册里的某一层", () => {
    // 漏登记的新层 = 谁压谁全凭巧合。30 以下是屏内局部层叠(表头吸顶之类),
    // 不参与浮层排序,所以设了这条门槛。
    const strays: string[] = [];
    for (const r of RULES) {
      const z = ruleZ(r);
      if (!z) continue;
      const n = zNumber(z.value, where(r));
      if (n === null || n < FLOAT_Z) continue;
      if (!r.constrains) {
        strays.push(`${where(r)} → z-index: ${z.value}(选择器不带类名判据,无法归属到任何一层)`);
        continue;
      }
      if (!ROSTER_ELS.some((el) => r.match(el))) {
        strays.push(`${where(r)} → z-index: ${z.value}`);
      }
    }
    expect(
      strays,
      "新增浮层必须登记进 LAYERS 名册并想清楚它压谁、被谁压;" +
        "不登记就等于把层叠交给巧合。\n" +
        "(2026-08-28 第三轮:shell.css 的 .topbar__project-menu z=70 就是这样漏了一整轮——" +
        "旧版只手抄扫描 components.css / screens.css 两张表。)\n" +
        "若这条 z-index 其实作用在某个**已经创建了层叠上下文**的祖先内部(局部层叠)," +
        "请把它降到 30 以下,或者把它的宿主登记成一层。",
    ).toEqual([]);
  });

  it("速查表压过大图与连拍组全屏层(否则按 ? 看着像没反应)", () => {
    // 实测过的失效形态:速查表 z=50 时打开会藏在组层 55 / 大图 60 背后,
    // 用户以为 ? 键坏了,退出全屏后它才突然冒出来。
    const z = (c: string[]) => zIndexOf({ classes: c, note: "" });
    expect(z(["overlay--keyhelp"])).toBeGreaterThan(z(["lightbox"]));
    expect(z(["overlay--keyhelp"])).toBeGreaterThan(z(["group-layer"]));
    // 但不许压过会话门:门是安全边界,任何浮层都不能成为绕门的旁路
    expect(z(["overlay--keyhelp"])).toBeLessThan(z(["overlay--gate"]));
  });

  it("会话门(--gate)必须压过普通浮层,门上的二次确认必须压过门", () => {
    const z = (c: string[]) => zIndexOf({ classes: c, note: "" });
    expect(z(["overlay--gate"])).toBeGreaterThan(z(["overlay"]));
    // --elevated 不压过门的话,确认框被门盖住点不到(评审 P0)
    expect(z(["overlay--elevated"])).toBeGreaterThan(z(["overlay--gate"]));
    // 门是安全边界:名册里除了 --elevated 和 toast,谁都不许压过它
    const above = LAYERS.flatMap((t) => t.members)
      .map((m) => ({ m, z: zIndexOf(m) }))
      .filter((x) => x.z > z(["overlay--gate"]))
      .map((x) => x.m.classes.join("."));
    expect(
      above.sort(),
      "会话门之上只许站着「门上的二次确认」与 toast(提交失败必须永远可见);" +
        "任何别的浮层压过门,都是绕门的旁路",
    ).toEqual(["overlay--elevated", "toasts"]);
  });

  it("toast 容器不拦点击,只有卡片本身可交互", () => {
    expect(finalOf(new Set(["toasts"]), "pointer-events")).toBe("none");
    expect(finalOf(new Set(["toast"]), "pointer-events")).toBe("auto");
  });

  it("下拉浮层压过普通浮层、低于会话门(门内禁放 Select 的口径要成立)", () => {
    const z = (c: string[]) => zIndexOf({ classes: c, note: "" });
    expect(z(["select-pop"])).toBeGreaterThan(z(["overlay"]));
    expect(z(["select-pop"])).toBeLessThan(z(["overlay--gate"]));
  });

  it("快捷拷卡浮层 z 层低于模态浮层与会话门(可达性另由行为用例钉:门开时浮层 inert)", () => {
    const z = (c: string[]) => zIndexOf({ classes: c, note: "" });
    expect(z(["quick-copy"])).toBeLessThan(z(["overlay"]));
    expect(z(["quick-copy"])).toBeLessThan(z(["overlay--gate"]));
  });

  it("对话框在锁死页面滚动的前提下自己能滚(矮窗口不可达回归)", () => {
    const el = new Set(["dialog"]);
    expect(finalOf(el, "max-height"), ".dialog 必须收缩到一屏").not.toBeNull();
    const y = finalOf(el, "overflow-y") ?? finalOf(el, "overflow");
    expect(
      y !== null && /^(auto|scroll)/.test(y),
      `.dialog 的溢出是 "${y ?? "未写"}"——必须能自己滚`,
    ).toBe(true);
  });
});
