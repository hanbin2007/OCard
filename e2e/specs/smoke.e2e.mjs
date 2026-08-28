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
          else if (cs.overflowY === "hidden") trapped.push(name(el));
        }
        return { live, trapped };
      });

      // 至多一个活跃滚动容器:两个就意味着滚轮落点决定滚谁,用户看到的条对不上
      expect(probe.live.length).toBeLessThanOrEqual(1);
      // 有溢出却被 hidden 裁掉 = 内容够不着且无提示
      expect(probe.trapped).toEqual([]);
    }
  });
});
