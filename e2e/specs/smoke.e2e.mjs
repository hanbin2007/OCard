// M1 冒烟:启动 → 新建项目(真实建夹落盘)→ 设备登记(规范编码)。
// 拷卡全链路由 Rust 集成测试覆盖(模拟卡目录);此处验证 UI↔IPC↔磁盘贯通。
import { $, expect } from "@wdio/globals";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const nasRoot = process.env.OCARD_E2E_NAS_ROOT;

describe("OCard M1 冒烟", () => {
  it("应用启动并渲染导航", async () => {
    await $('[data-testid="nav-projects"]').waitForExist({ timeout: 30000 });
  });

  it("新建工况A项目,NAS 上按规范建夹", async () => {
    await $('[data-testid="nav-new-project"]').click();
    await $('[data-testid="np-name"]').waitForExist();
    await $('[data-testid="np-name"]').setValue("E2E冒烟");
    await $('[data-testid="np-scenario-a"]').click();
    await $('[data-testid="np-submit"]').click();

    await $('[data-testid="project-row"]').waitForExist({ timeout: 20000 });

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
