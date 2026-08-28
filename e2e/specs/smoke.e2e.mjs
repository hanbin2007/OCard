// M1 冒烟:启动 → 新建项目(真实建夹落盘)→ 设备登记(规范编码)。
// 拷卡全链路由 Rust 集成测试覆盖(模拟卡目录);此处验证 UI↔IPC↔磁盘贯通。
import { $, expect } from "@wdio/globals";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { createProjectViaWizard, switchToWindowWith } from "../lib/windows.mjs";

const nasRoot = process.env.OCARD_E2E_NAS_ROOT;

/**
 * 浮层几何探针(在页面上下文里跑)。
 *
 * 定义在模块顶层而不是内联在用例里,是为了能被离线复核脚本原样抽出来:
 * 打包好的 Tauri 应用本机跑不动时,可以用 headless Chrome + 真实样式表 +
 * 同一份合成 DOM 跑同一个函数,验证「这条不变式真的抓得住它宣称的病灶」。
 * 断言写在探针内部、以 `fails` 数组返回,离线复核与真机跑的是**同一套判据**,
 * 不会各写一份而悄悄漂移。
 */
const LAYER_PROBE = (spec) => {
  const style = document.createElement("style");
  style.id = "e2e-unmask";
  style.textContent = spec.unmask || "";
  document.head.appendChild(style);

  const host = document.createElement("div");
  host.className = spec.layer;
  host.dataset.e2eProbe = "1";
  host.innerHTML = spec.html.replace("__TALL__", '<div style="height:4000px">超高探针</div>');
  document.body.appendChild(host);
  // 强制一次布局,避免读到挂载前的旧值
  void host.offsetHeight;

  const nameOf = (el) => (el.className || "").toString().trim().split(/\s+/)[0] || el.tagName;
  const scroller = spec.scroller ? host.querySelector(spec.scroller) : null;
  const pinned = spec.pinned ? host.querySelector(spec.pinned) : null;
  const cs = getComputedStyle(host);
  const viewport = window.innerHeight;
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const contentH = host.clientHeight - padY;

  // 真的能滚 = 有可滚量 + 高度不为 0 + scrollTop 设得进去(零高度的 auto 容器
  // 也有 scrollHeight-clientHeight>0,却对用户完全不存在)
  const liveScroll = (el) => {
    if (el.scrollHeight - el.clientHeight <= 1) return false;
    if (el.clientHeight <= 0) return false;
    if (!/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) return false;
    const before = el.scrollTop;
    el.style.scrollBehavior = "auto";
    el.scrollTop = 120;
    const moved = el.scrollTop > 0;
    el.scrollTop = before;
    return moved;
  };

  const live = [];
  const trapped = [];
  for (const el of [host, ...host.querySelectorAll("*")]) {
    if (el.scrollHeight - el.clientHeight <= 1) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy === "hidden" || oy === "clip") trapped.push(nameOf(el));
    else if (liveScroll(el)) live.push(nameOf(el));
  }

  const rows = cs.gridTemplateRows;
  const rowPx = rows.split(/\s+/).map(parseFloat).filter((n) => !Number.isNaN(n));
  const out = {
    viewport,
    layerClientH: host.clientHeight,
    layerOverflow: host.scrollHeight - host.clientHeight,
    display: cs.display,
    gridTemplateRows: rows,
    rowSum: rowPx.length ? Math.round(rowPx.reduce((a, b) => a + b, 0)) : null,
    contentH: Math.round(contentH),
    scrollerClientH: scroller ? scroller.clientHeight : null,
    scrollerOverflow: scroller ? scroller.scrollHeight - scroller.clientHeight : null,
    scrollerLive: scroller ? liveScroll(scroller) : null,
    pinnedTop: pinned ? Math.round(pinned.getBoundingClientRect().top) : null,
    pinnedBottom: pinned ? Math.round(pinned.getBoundingClientRect().bottom) : null,
    live,
    trapped,
    fails: [],
  };

  const at = `${spec.name}/${spec.pass}`;
  const fail = (msg) => out.fails.push(`${at}: ${msg}`);

  // 1) 浮层自己铺满一屏,且不被内容撑出视口 —— 撑出去就意味着
  //    子元素的 height/max-height:100% 全部失去参照
  if (Math.abs(out.layerClientH - viewport) >= 4) {
    fail(`浮层没有铺满一屏(clientHeight ${out.layerClientH} vs 视口 ${viewport})`);
  }
  if (out.layerOverflow > 1) fail(`浮层被内容撑出视口(溢出 ${out.layerOverflow}px)`);

  // 2) 【jsdom 做不到、E2E 独有】直接读轨道解析结果:
  //    grid 浮层的行必须**恰好**是它自己的内容盒高。原病灶就是这一行被内容
  //    撑到 1507px(视口 927),而删掉 grid-template-rows 后这里会读到 "none"。
  if (out.display === "grid") {
    if (!rowPx.length) {
      fail(`grid-template-rows 解析不出轨道("${rows}")——没有显式行 = 只剩一条隐式 auto 行`);
    } else if (Math.abs(out.rowSum - out.contentH) > 2) {
      fail(`行总高 ${out.rowSum}px ≠ 内容盒 ${out.contentH}px(行被内容撑大,子层的 height:100% 随之失去参照)`);
    }
  }

  // 3) 溢出必须真的落在指定的内部滚动容器上,而且那个容器**真的滚得动**
  if (scroller) {
    if (out.scrollerClientH <= 0) fail(`滚动容器 ${spec.scroller} 高度为 0`);
    if (out.scrollerOverflow <= 0) fail(`滚动容器 ${spec.scroller} 没有可滚量`);
    if (!out.scrollerLive) fail(`滚动容器 ${spec.scroller} 设了 scrollTop 却没动(不是真能滚)`);
    if (out.live.length !== 1 || out.live[0] !== spec.scroller.replace(".", "")) {
      fail(`真能滚的容器应当有且只有 ${spec.scroller},实际是 [${out.live.join(",")}]`);
    }
  }

  // 4) 定高骨架(底栏)必须整条在视口内 —— 报障截图里它整条在视口之外
  if (pinned) {
    if (out.pinnedBottom > viewport + 1) fail(`底栏跑出视口下沿(bottom ${out.pinnedBottom} > ${viewport})`);
    if (out.pinnedTop < -1) fail(`底栏跑出视口上沿(top ${out.pinnedTop})`);
  }

  // 5) 不许有「能滚却被裁掉」的容器(零静默)
  if (trapped.length) fail(`有可滚内容被 hidden/clip 裁掉:[${trapped.join(",")}]`);

  host.remove();
  style.remove();
  return out;
};

/**
 * 全屏层的**扫描面自检**(在页面上下文里跑)。
 *
 * 下面那份 LAYER_RECIPES 是手抄清单——手抄清单会落后于 CSS,这正是同一轮
 * 在单测里刚修掉的毛病(stacking.test 曾经只手抄扫两张样式表,于是
 * shell.css 的 `.topbar__project-menu` 整整漏了一轮)。这里反过来钉:
 * **CSS 里有几族全屏层,recipe 就必须覆盖几族**,缺一个就点名判红。
 *
 * 做法上刻意**不在页面里重写一遍选择器解析器**:从活的样式表里把出现过的
 * 类名捞成候选(多捞无害,少捞才致命,所以 `.x` 与 `[class~="x"]` 两种形态
 * 都捞),然后逐个挂一个空 div,让浏览器**自己**算级联,读计算值判定
 * 「fixed + 竖直方向铺满 + grid/flex」。这比任何静态解析都准。
 */
const LAYER_SCAN = () => {
  const names = new Set();
  const blocked = [];
  let ruleCount = 0;

  // 注意:CSSRuleList / StyleSheetList 按 CSSOM 规范**不是 iterable**
  // (只有 length + item()),`for...of` 会直接抛 TypeError。
  // 第一版就是这么写的,再被一个空 catch 吞掉 → 扫到 0 族 → 「全绿」。
  // 这正是本文件通篇在防的静默 fail-open,所以:按下标遍历,并且把读不到的
  // 样式表如实报上去,由用例判红。
  const harvest = (rules) => {
    for (let i = 0; i < rules.length; i++) {
      const r = rules.item(i);
      // 先收自己的选择器,**再**往下递归。
      // 顺序不能反:支持 CSS 嵌套之后,`CSSStyleRule` 也带一个(空的)
      // `cssRules`,先判 `if (r.cssRules) { recurse; continue; }` 会把每一条
      // 普通规则都当成分组规则跳过 —— 第一版就是这么写的,扫到 0 条。
      const sel = r.selectorText;
      if (sel) {
        ruleCount++;
        for (const m of sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) names.add(m[1]);
        for (const m of sel.matchAll(/\[class[~*^$|]?=\s*["']([^"']+)["']/g)) {
          for (const t of m[1].split(/\s+/)) if (t) names.add(t);
        }
      }
      // @media / @supports / @layer / 嵌套规则;@keyframes 的关键帧没有
      // selectorText,递归进去也只是空转
      if (r.cssRules && r.cssRules.length) harvest(r.cssRules);
    }
  };
  const sheets = document.styleSheets;
  for (let i = 0; i < sheets.length; i++) {
    try {
      harvest(sheets[i].cssRules);
    } catch (e) {
      blocked.push(`${sheets[i].href || "(inline)"}: ${e.message}`);
    }
  }

  const probe = document.createElement("div");
  probe.dataset.e2eScan = "1";
  document.body.appendChild(probe);
  const vh = window.innerHeight;
  const layers = [];
  for (const n of [...names].sort()) {
    // 修饰类单独挂不成层(`.overlay--drawer` 身上没有 position:fixed),
    // 族名一律取基类
    if (n.includes("--")) continue;
    probe.className = n;
    const cs = getComputedStyle(probe);
    if (cs.position !== "fixed") continue;
    const disp = cs.display.replace(/^inline-/, "");
    if (disp !== "grid" && disp !== "flex") continue;
    const pinnedBothEnds = parseFloat(cs.top) === 0 && parseFloat(cs.bottom) === 0;
    const viewportTall = Math.abs(probe.getBoundingClientRect().height - vh) < 2;
    if (!pinnedBothEnds && !viewportTall) continue;
    layers.push(n);
  }
  probe.remove();
  return { layers, blocked, ruleCount, classCount: names.size };
};

/**
 * 全屏层的合成配方。
 *
 * 不去点开真实浮层(依赖素材与项目状态,会脆),而是用真类名挂一份合成内容:
 * 要钉的本来就是**样式层的定律**,不是某一次的接线。
 *
 * `covers` 是这份配方覆盖的层族(基类名),由上面 LAYER_SCAN 交叉核对——
 * 新增一族全屏层而没写配方,那条用例会点名判红。
 *
 * `unmask` 是「拆掉兄弟兜底」那一趟要注入的 CSS。缘由见用例注释:同一提交里
 * 加的 `.drawer{overflow-y:auto}` 会把 `.overlay` 少写 grid-template-rows 的
 * 症状整个盖住,只跑原样那一趟等于只守住「两个修复同时被撤销」。
 *
 * **注意配方形状不是一个模子**:`.lightbox` 的舞台是刻意裁剪的(见它自己的
 * 注释),塞 4000px 探针会误红。别为了让数字对上而硬塞一个会误红的配方——
 * 那是把防线换成一条永远绿或永远红的噪声。
 */
const LAYER_RECIPES = [
  {
    name: "抽屉(审计日志)",
    layer: "overlay overlay--drawer",
    covers: "overlay",
    html:
      '<div class="drawer"><div class="drawer__head">头</div>' +
      '<div class="drawer__filters">筛选</div>' +
      '<div class="drawer__body">__TALL__</div>' +
      '<div class="drawer__foot">脚</div></div>',
    // 溢出必须落在正文里,头/筛选/脚三条定高骨架要始终可见
    scroller: ".drawer__body",
    pinned: ".drawer__foot",
    unmask: ".drawer { overflow-y: visible; }",
  },
  {
    name: "对话框",
    layer: "overlay",
    covers: "overlay",
    html: '<div class="dialog">__TALL__</div>',
    // 对话框自封闭:max-height + 自身滚动成对出现;它自己就是滚动容器,没有可拆的兄弟兜底
    scroller: ".dialog",
    pinned: null,
    unmask: "",
  },
  {
    name: "连拍组全屏层",
    layer: "group-layer",
    covers: "group-layer",
    html:
      '<div class="group-layer__bar">头</div>' +
      '<div class="group-layer__tools">工具</div>' +
      '<div class="group-layer__grid">__TALL__</div>' +
      '<div class="group-layer__foot">脚</div>',
    scroller: ".group-layer__grid",
    pinned: ".group-layer__foot",
    unmask: "",
  },
  /*
   * 大图全屏预览。**形状和上面三个不一样,这是刻意的。**
   *
   * `.lightbox__stage` 的 `overflow: hidden` 是设计,不是遗漏(overflow.test.ts
   * 的 CLIP_EXEMPT 里写了理由):舞台里只有一张 `object-fit: contain` +
   * `max-height: 100%` 的媒体,结构上不产生溢出。往里塞 4000px 的通用探针会
   * 立刻踩中探针第 5 条「有可滚内容被 hidden/clip 裁掉」→ 误红。
   *
   * 所以这里换一个**同样致命、但形状对得上**的探针:放一张 4000×4000 的
   * 假媒体(真 <img> 在无网的 headless 里不会加载,用带 lightbox__image 类的
   * 空 div 代替,`max-width/max-height: 100%` 对它一样生效)。这一族真正要守的
   * 不变式是:
   *
   *   ① 层自己恰好一屏、不被内容撑大(探针第 1 条);
   *   ② 媒体被舞台**界住**——`max-height: 100%` 要解析得出定值,前提是舞台
   *      有确定高度(`flex: 1 1 auto` + `min-height: 0` + 层本身定高)。
   *      舞台的高度一旦失去参照,这张 4000px 的媒体就会顶穿视口下沿,
   *      pinned 那条断言直接抓住(探针第 4 条);
   *   ③ 舞台仍然不产生可滚溢出(探针第 5 条)——它是刻意裁剪的,
   *      一旦真的裁掉了内容,说明 ② 已经先破了。
   *
   * 没有 scroller 是对的:这一族**结构上就不该有内部滚动容器**。
   * 别为了跟别的配方长得一样而给它塞一个。
   */
  {
    name: "大图全屏预览",
    layer: "lightbox",
    covers: "lightbox",
    html:
      '<div class="lightbox__bar"><span class="lightbox__badges">徽标</span></div>' +
      '<div class="lightbox__stage">' +
      '<div class="lightbox__image" style="width:4000px;height:4000px"></div>' +
      "</div>" +
      '<div class="lightbox__actions">动作条</div>',
    scroller: null,
    pinned: ".lightbox__image",
    unmask: "",
  },
];

/**
 * 扫描面豁免:某一族全屏层确实不该有 recipe 时,写在这里并说明理由。
 * 空着是好事——空着意味着每一族都真的被探针跑过。
 */
const LAYER_SCAN_EXEMPT = {};

describe("OCard M1 冒烟", () => {
  it("启动进入欢迎窗口,预置配置已生效(无首跑引导)", async () => {
    await switchToWindowWith('[data-testid="welcome-home"]', 30000);
    expect(await $('[data-testid="first-run-guide"]').isExisting()).toBe(false);
    // Xcode 式欢迎页:新建项目入口 + 最近项目区
    expect(await $('[data-testid="welcome-new-project"]').isExisting()).toBe(true);
    expect(await $('[data-testid="welcome-recents"]').isExisting()).toBe(true);
  });

  it("引导新建工况A项目,NAS 上按规范建夹,主窗口默认落在拷卡屏", async () => {
    await createProjectViaWizard("E2E冒烟", "a");
    // 主窗口默认显示拷卡界面
    await $('[data-testid="copy-start"]').waitForExist({ timeout: 20000 });

    const dirs = readdirSync(nasRoot).filter((d) => d.includes("E2E冒烟"));
    expect(dirs.length).toBe(1);
    for (const sub of [
      "1. 工程文件",
      "2. 原始素材",
      "3. 特别素材",
      "4. 转码素材",
      "5. 文字素材",
      "6. 成片",
    ]) {
      expect(existsSync(path.join(nasRoot, dirs[0], sub))).toBe(true);
    }
    expect(existsSync(path.join(nasRoot, dirs[0], ".ocard"))).toBe(true);
  });

  it("登记相机,编码实时生成并入登记表", async () => {
    await $('[data-testid="nav-devices"]').click();
    await $('[data-testid="dev-model"]').waitForExist();
    await $('[data-testid="dev-model"]').setValue("A7M4");
    await $('[data-testid="dev-position"]').setValue("A");
    await $('[data-testid="dev-alias"]').setValue("ZS");
    await expect($('[data-testid="dev-code-preview"]')).toHaveText(
      expect.stringContaining("A7M4_A_ZS"),
    );
    await $('[data-testid="dev-submit"]').click();
    await $('[data-testid="camera-row"]').waitForExist({ timeout: 15000 });

    // 登记表落在 NAS 共享目录
    expect(existsSync(path.join(nasRoot, ".ocard-registry"))).toBe(true);
  });

  /**
   * 滚动不变式(布局回归防线)。
   *
   * 「滚动条与内容不同步」被误诊两轮(先怪 ::-webkit-scrollbar,再怪滚动
   * 容器上的过渡动画),真因是嵌套滚动容器:鼠标在内层上滚,内层吃掉滚动,
   * 而用户盯着外层的条——它纹丝不动。这类问题 jsdom 一律测不出(无布局),
   * 只能在真实内核里按几何断言,所以钉在 E2E。
   *
   * 两条不变式:
   *  1) 同一屏、同一时刻,正文区最多只有一个**真的能滚**的容器;
   *  2) 不许存在「能滚却不给滚」的裁剪容器(overflow:hidden 且有溢出)
   *     —— 那等于内容被静默吞掉,违反零静默铁律。
   */
  it("每屏滚动不变式:正文区至多一个活跃滚动容器,且没有被裁掉的可滚内容", async () => {
    const screens = [
      ["nav-copy", "copy-start"],
      ["nav-devices", "dev-model"],
      ["nav-sorting", "sorting-categories"],
      ["nav-transcode", null],
      ["nav-trash", null],
    ];
    for (const [nav, anchor] of screens) {
      await $(`[data-testid="${nav}"]`).click();
      if (anchor) await $(`[data-testid="${anchor}"]`).waitForExist({ timeout: 15000 });
      await browser.pause(400);

      const probe = await browser.execute(() => {
        const roots = [...document.querySelectorAll(".main, .welcome-sub")];
        const all = roots.flatMap((r) => [r, ...r.querySelectorAll("*")]);
        const name = (el) =>
          (el.className || "").toString().trim().split(/\s+/)[0] || el.tagName;
        const live = [];
        const trapped = [];
        for (const el of all) {
          const cs = getComputedStyle(el);
          const over = el.scrollHeight - el.clientHeight;
          if (over <= 1) continue;
          if (/(auto|scroll|overlay)/.test(cs.overflowY)) live.push(name(el));
          else if (cs.overflowY === "hidden" || cs.overflowY === "clip")
            trapped.push(name(el));
        }
        return { live, trapped };
      });

      // 至多一个活跃滚动容器:两个就意味着滚轮落点决定滚谁,用户看到的条对不上
      expect(probe.live.length).toBeLessThanOrEqual(1);
      // 有溢出却被 hidden/clip 裁掉 = 内容够不着且无提示
      expect(probe.trapped).toEqual([]);
    }
  });

  /**
   * 侧栏必须跟着内容滚(布局回归防线之二)。
   *
   * 上一条不变式盯的是「有几个容器在滚」,而 865efe0 那个病灶——单列下
   * 侧栏 sticky 粘住不动——**不改变任何容器的 scrollHeight/overflow**,
   * 整个在上一条的盲区里。这里直接量几何:滚 N 像素,侧栏就得位移 N。
   * 窗口先压到单列断点内侧(1200),那正是用户报障时的宽度。
   */
  it("单列宽度下侧栏跟随内容滚动(不粘住)", async () => {
    await browser.setWindowRect(null, null, 1200, 800);
    await browser.pause(600);

    // 跳过必须留下可见记录:上一版在「内容不够长」时直接 continue,
    // 一条从不执行的用例长期显示为绿,和没有这条用例没有区别。
    // 现在分两步兜:内容不够长就**自己塞一段占位撑出行程**(要钉的是样式层的
    // 定律,不是某一屏恰好有多少内容);真的量不成才记一笔,并在最后要求
    // 至少有一屏被真正量过——两屏全都量不成 = 判红。
    const skipped = [];
    let measured = 0;

    for (const [nav, side] of [
      ["nav-copy", ".copy__form"],
      ["nav-devices", ".devices__form"],
    ]) {
      await $(`[data-testid="${nav}"]`).click();
      await browser.pause(500);

      const r = await browser.execute((sel) => {
        const sc = document.querySelector(".content");
        const el = document.querySelector(sel);
        if (!sc) return { skip: `找不到滚动容器 .content` };
        if (!el) return { skip: `找不到侧栏 ${sel}` };

        // 行程不够就临时塞一段占位,量完立刻移除
        let spacer = null;
        if (sc.scrollHeight - sc.clientHeight < 200) {
          spacer = document.createElement("div");
          spacer.style.height = "1200px";
          spacer.dataset.e2eSpacer = "1";
          sc.appendChild(spacer);
          void sc.offsetHeight;
        }
        const room = sc.scrollHeight - sc.clientHeight;
        if (room < 200) {
          if (spacer) spacer.remove();
          return { skip: `塞了占位仍然滚不动(可滚量 ${room})` };
        }

        sc.style.scrollBehavior = "auto";
        sc.scrollTop = 0;
        const a = el.getBoundingClientRect().top;
        sc.scrollTop = 148;
        const scrolled = Math.round(sc.scrollTop);
        const b = el.getBoundingClientRect().top;
        sc.scrollTop = 0;
        if (spacer) spacer.remove();
        return { moved: Math.round(a - b), scrolled, padded: Boolean(spacer) };
      }, side);

      if (r.skip) {
        // 留痕:控制台一定看得见,汇总断言也会带上
        console.warn(`[sticky 不变式] ${nav} / ${side} 未能测量:${r.skip}`);
        skipped.push(`${side}: ${r.skip}`);
        continue;
      }
      measured++;
      if (r.padded) console.log(`[sticky 不变式] ${side}: 内容不够长,已临时塞占位撑出行程`);
      // 位移必须 1:1 跟随;粘住时 moved≈0,正是报障时的形态
      expect(Math.abs(r.moved - r.scrolled)).toBeLessThan(4);
    }

    // 同上:wdio 的 expect 只收一个参数,说明只能走 throw
    if (measured < 1) {
      throw new Error(
        "两屏都没能真正测量到侧栏位移——这条不变式等于没执行。skip 原因:" +
          skipped.join(" / "),
      );
    }
  });

  /**
   * 浮层也要守同一条不变式(布局回归防线之三)。
   *
   * 前两条的扫描根是 `.main` / `.welcome-sub`,浮层整个在盲区里 ——
   * 审计日志抽屉就是这么漏出去的:`.overlay` 是 fixed inset:0 的 grid 却
   * 没写 `grid-template-rows`,只剩一条隐式 `auto` 行。内容超过视口时那行
   * 被撑到内容高度(实测 1507 vs 视口 927),于是 `.drawer{height:100%}`
   * 解析成「内容高度」而不是「一屏」,`.drawer__body` 的可滚量恰好为 0,
   * 列表跑出窗口下沿、底栏整条在视口之外 —— 用户报的「有半边没法滚动」。
   *
   * 上一版这条用例**抓不到它自己宣称的那件事**。真实 CSS + 逐字复刻的合成 DOM
   * 在 headless Chrome 里实测(1280×860):
   *
   *   场景(以抽屉为例)                                    旧版    现在
   *   A 现状                                               绿      绿
   *   B 只删 .overlay 的 grid-template-rows  ← 它宣称要抓的  ★绿(漏) 红
   *   C 删 rows + 删 .drawer/.dialog 的 overflow-y 兜底      红      红
   *   D 只删 .drawer/.dialog 的兜底                          绿      绿
   *   E .overlay 的行改成 auto                              —      红
   *   I .dialog 的 max-height 放开                          —      红
   *   J .group-layer__grid 去掉 min-height:0 且溢出改 visible —      红
   *
   * 也就是说它守住的只是「两个修复同时被撤销」:同一提交里加的
   * `.drawer{overflow-y:auto}` 把 .overlay 的病灶整个盖住了。三处修法:
   *
   *  ① 多跑一趟「拆掉兄弟兜底」:注入 `.drawer{overflow-y:visible}` 后
   *     同一组断言必须照样成立,兜底不再能替 .overlay 遮丑;
   *  ② 直接读 `getComputedStyle(host).gridTemplateRows` 并断言解析出的
   *     轨道总高 ≈ 浮层自己的内容盒高 —— 计算值给的是**用后的轨道尺寸**,
   *     行被内容撑大时这里直接读到 4167px 而内容盒只有 773px。这是 jsdom
   *     拿不到的量(无布局引擎),也是这条用例真正该守的东西;
   *  ③ 断言滚动容器**真的能滚**:clientHeight > 0、设 scrollTop 后位移真的发生,
   *     并且同一时刻真能滚的容器有且只有它一个(零高度的 overflow:auto 容器
   *     也有可滚量,却对用户完全不存在)。
   */
  /**
   * 扫描面自检:手抄的 recipe 清单不许落后于 CSS。
   *
   * 上一版这份清单只有抽屉/对话框/连拍组三条,`.lightbox` 不在里面,
   * 将来新增的全屏层也不会自动进——和 stacking.test 当年只手抄扫两张样式表
   * 是同一个毛病:**防线看不见新东西**。这条用例让 CSS 自己报数。
   */
  it("浮层扫描面自检:CSS 里的每一族全屏层都必须有配方(手抄清单不许落后)", async () => {
    await browser.setWindowRect(null, null, 1280, 860);
    await browser.pause(400);

    const scan = await browser.execute(LAYER_SCAN);

    /* 说明为什么这里用 `throw` 而不是 `expect(值, 说明)`:
       wdio 的 expect 是 expect-webdriverio(jest 系),**只收一个参数**,
       多传一个会当场抛 `Expect takes at most one argument` ——
       断言还没跑,用例就先炸了,报错还与真正的病灶毫无关系。
       vitest 支持两参,所以这个写法在单测里是对的、搬到 E2E 就错。
       CI 实测踩过一次(33183973260)。 */
    const fail = (msg) => {
      throw new Error(msg);
    };

    // 先钉住扫描器自己没瞎:读不到的样式表、扫到 0 条规则、扫到 0 族,
    // 这三种情况都会让下面的比对「恰好全绿」。
    if (scan.blocked.length) {
      fail(`有样式表读不到 cssRules,扫描面不完整:[${scan.blocked.join(",")}]`);
    }
    if (scan.ruleCount <= 300) {
      fail(
        `只扫到 ${scan.ruleCount} 条样式规则 / ${scan.classCount} 个类名 —— 扫描器本身失效了`,
      );
    }
    const found = scan.layers;
    if (found.length < 1) fail("一族全屏层都没扫到 = 扫描判据本身失效");

    const covered = new Set(LAYER_RECIPES.map((r) => r.covers));
    const missing = found.filter((n) => !covered.has(n) && !(n in LAYER_SCAN_EXEMPT));
    if (missing.length) {
      fail(
        `这几族全屏层在 CSS 里存在,却没有任何 recipe 跑过它们:[${missing.join(",")}]。\n` +
          "请给它写一份配方(注意形状要贴合它自己的结构,别照抄一个会误红的)," +
          "或者加进 LAYER_SCAN_EXEMPT 并写明为什么它不需要探针。\n" +
          `当前扫到:[${found.join(",")}];当前覆盖:[${[...covered].join(",")}]`,
      );
    }

    const stale = [...covered].filter((n) => !found.includes(n));
    if (stale.length) {
      fail(
        `这几份 recipe 的 covers 在 CSS 里已经不是全屏层了:[${stale.join(",")}]。\n` +
          "要么是类名改了、要么是这一族不再 fixed 铺满——配方已经在空跑,请更新。",
      );
    }
  });

  it("浮层不变式:铺满视口、行不被撑大、溢出由内部滚动容器真正承担", async () => {
    await browser.setWindowRect(null, null, 1280, 860);
    await browser.pause(400);

    for (const recipe of LAYER_RECIPES) {
      // 第二趟拆掉兄弟兜底:没有 unmask 的配方(自己就是滚动容器)只跑一趟
      const passes = recipe.unmask ? ["原样", "拆掉兄弟兜底"] : ["原样"];
      for (const pass of passes) {
        const r = await browser.execute(LAYER_PROBE, {
          ...recipe,
          pass,
          unmask: pass === "原样" ? "" : recipe.unmask,
        });
        expect(r.fails).toEqual([]);
      }
    }
  });
});
