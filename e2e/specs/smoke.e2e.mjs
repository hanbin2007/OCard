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
});
