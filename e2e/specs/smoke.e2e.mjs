// M1 冒烟:启动 → 新建项目(真实建夹落盘)→ 设备登记(规范编码)。
// 拷卡全链路由 Rust 集成测试覆盖(模拟卡目录);此处验证 UI↔IPC↔磁盘贯通。
import { $, expect } from "@wdio/globals";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { createProjectViaWizard, switchToWindowWith } from "../lib/windows.mjs";

const nasRoot = process.env.OCARD_E2E_NAS_ROOT;

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

    for (const [nav, side] of [
      ["nav-copy", ".copy__form"],
      ["nav-devices", ".devices__form"],
    ]) {
      await $(`[data-testid="${nav}"]`).click();
      await browser.pause(500);

      const r = await browser.execute((sel) => {
        const sc = document.querySelector(".content");
        const el = document.querySelector(sel);
        if (!sc || !el) return null;
        if (sc.scrollHeight - sc.clientHeight < 200) return { skip: true };
        sc.scrollTop = 0;
        const a = el.getBoundingClientRect().top;
        sc.scrollTop = 148;
        const b = el.getBoundingClientRect().top;
        const moved = a - b;
        sc.scrollTop = 0;
        return { moved: Math.round(moved), scrolled: Math.round(sc.scrollTop) || 148 };
      }, side);

      if (!r || r.skip) continue;
      // 位移必须 1:1 跟随;粘住时 moved≈0,正是报障时的形态
      expect(Math.abs(r.moved - 148)).toBeLessThan(4);
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
   * 这里不去点开真实浮层(依赖素材与项目状态,会脆),而是用真类名挂一份
   * 超高的合成内容:要钉的本来就是**样式层的定律**,不是某一次的接线。
   */
  it("浮层不变式:铺满视口、不外溢,且溢出由内部滚动容器承担", async () => {
    await browser.setWindowRect(null, null, 1280, 860);
    await browser.pause(400);

    const recipes = [
      {
        name: "抽屉(审计日志)",
        layer: "overlay overlay--drawer",
        html: (tall) =>
          `<div class="drawer"><div class="drawer__head">头</div>` +
          `<div class="drawer__filters">筛选</div>` +
          `<div class="drawer__body">${tall}</div>` +
          `<div class="drawer__foot">脚</div></div>`,
        // 溢出必须落在正文里,头/筛选/脚三条定高骨架要始终可见
        scroller: ".drawer__body",
        pinned: ".drawer__foot",
      },
      {
        name: "对话框",
        layer: "overlay",
        html: (tall) => `<div class="dialog">${tall}</div>`,
        // 对话框自封闭:max-height + 自身滚动成对出现
        scroller: ".dialog",
        pinned: null,
      },
      {
        name: "连拍组全屏层",
        layer: "group-layer",
        html: (tall) =>
          `<div class="group-layer__bar">头</div>` +
          `<div class="group-layer__tools">工具</div>` +
          `<div class="group-layer__grid">${tall}</div>` +
          `<div class="group-layer__foot">脚</div>`,
        scroller: ".group-layer__grid",
        pinned: ".group-layer__foot",
      },
    ];

    for (const recipe of recipes) {
      const r = await browser.execute((spec) => {
        const tall = '<div style="height:4000px">超高探针</div>';
        const host = document.createElement("div");
        host.className = spec.layer;
        host.dataset.e2eProbe = "1";
        host.innerHTML = spec.html.replace("__TALL__", tall);
        document.body.appendChild(host);
        // 强制一次布局,避免读到挂载前的旧值
        void host.offsetHeight;

        const nameOf = (el) =>
          (el.className || "").toString().trim().split(/\s+/)[0] || el.tagName;
        const scroller = spec.scroller ? host.querySelector(spec.scroller) : null;
        const pinned = spec.pinned ? host.querySelector(spec.pinned) : null;

        const trapped = [];
        for (const el of [host, ...host.querySelectorAll("*")]) {
          const cs = getComputedStyle(el);
          if (el.scrollHeight - el.clientHeight <= 1) continue;
          if (cs.overflowY === "hidden" || cs.overflowY === "clip")
            trapped.push(nameOf(el));
        }

        const out = {
          viewport: window.innerHeight,
          layerClientH: host.clientHeight,
          layerOverflow: host.scrollHeight - host.clientHeight,
          scrollerOverflow: scroller
            ? scroller.scrollHeight - scroller.clientHeight
            : null,
          pinnedBottom: pinned
            ? Math.round(pinned.getBoundingClientRect().bottom)
            : null,
          trapped,
        };
        host.remove();
        return out;
      }, { ...recipe, html: recipe.html("__TALL__") });

      // 1) 浮层自己铺满一屏,且不被内容撑出视口 —— 撑出去就意味着
      //    子元素的 height/max-height:100% 全部失去参照
      expect(Math.abs(r.layerClientH - r.viewport)).toBeLessThan(4);
      expect(r.layerOverflow).toBeLessThanOrEqual(1);
      // 2) 4000px 探针的溢出必须真的落在指定的内部滚动容器上
      expect(r.scrollerOverflow).toBeGreaterThan(0);
      // 3) 定高骨架(底栏)必须仍在视口内 —— 报障截图里它整条在视口之外
      if (r.pinnedBottom !== null) {
        expect(r.pinnedBottom).toBeLessThanOrEqual(r.viewport + 1);
      }
      // 4) 不许有「能滚却被裁掉」的容器(零静默)
      expect(r.trapped).toEqual([]);
    }
  });
});
