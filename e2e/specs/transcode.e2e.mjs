// M3 转码流冒烟:工况A建项目 → 用捆绑 ffmpeg 生成合成素材(ProRes,命中高负载判定)
// → UI 发起代理转码 → 磁盘断言代理落入「4. 转码素材」。
// 用的是**将被打包的那个 sidecar**(计划纪律:系统 ffmpeg 不算数)。
import { $, browser, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const nasRoot = process.env.OCARD_E2E_NAS_ROOT;
// CI 为 linux x86_64;沿 fetch-ffmpeg.sh 的落位
const ffmpegBin = path.resolve("../src-tauri/binaries/ffmpeg-x86_64-unknown-linux-gnu");

function projectRoot() {
  const dirs = readdirSync(nasRoot).filter((d) => d.includes("E2E转码"));
  expect(dirs.length).toBe(1);
  return path.join(nasRoot, dirs[0]);
}

async function confirmDangerDialogIfAny() {
  const btn = $(".dialog__actions .btn--danger-solid");
  if (await btn.isExisting()) {
    await btn.click();
  }
}

describe("OCard M3 转码冒烟", () => {
  it("新建工况A项目并注入 ProRes 合成素材", async () => {
    await $('[data-testid="nav-new-project"]').click();
    await $('[data-testid="np-name"]').waitForExist();
    await $('[data-testid="np-name"]').setValue("E2E转码");
    await $('[data-testid="np-scenario-a"]').click();
    await $('[data-testid="np-submit"]').click();
    await $('[data-testid="project-row"] span[title="E2E转码"]').waitForExist({
      timeout: 20000,
    });

    const camDir = path.join(projectRoot(), "2. 原始素材", "0824_A7M4_A_ZS");
    mkdirSync(camDir, { recursive: true });
    // ProRes 1080p 2s:命中「中间编码格式」高负载理由
    execFileSync(ffmpegBin, [
      "-nostdin", "-hide_banner", "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=duration=2:size=1920x1080:rate=30",
      "-c:v", "prores", "-n",
      path.join(camDir, "clip1.mov"),
    ]);
    expect(existsSync(path.join(camDir, "clip1.mov"))).toBe(true);
  });

  it("代理转码作业:UI 发起,代理真实落盘", async () => {
    const row = $('[data-testid="project-row"] span[title="E2E转码"]');
    await row.waitForClickable({ timeout: 15000 });
    await row.click();
    await $('[data-testid="nav-transcode"]').click();
    await $('[data-testid="transcode-start"]').waitForClickable({ timeout: 30000 });
    await $('[data-testid="transcode-start"]').click();
    await confirmDangerDialogIfAny();

    // 首次要跑编码能力真探针,放宽等待
    await $('[data-testid="transcode-result"]').waitForExist({ timeout: 120000 });

    const out = path.join(projectRoot(), "4. 转码素材", "0824_A7M4_A_ZS");
    await browser.waitUntil(() => existsSync(path.join(out, "clip1_proxy.mp4")), {
      timeout: 15000,
      timeoutMsg: "代理未落盘",
    });
    // 不残留 staging
    expect(
      readdirSync(out).some((f) => f.includes("transpart")),
    ).toBe(false);
    // 幂等重跑:already-transcoded,不产生第二份
    await $('[data-testid="transcode-start"]').click();
    await confirmDangerDialogIfAny();
    await browser.waitUntil(
      async () => {
        const t = await $('[data-testid="transcode-already"]').isExisting();
        return t;
      },
      { timeout: 60000, timeoutMsg: "重跑未显示已转码跳过" },
    );
    const files = readdirSync(out).filter((f) => !f.startsWith("."));
    expect(files).toEqual(["clip1_proxy.mp4"]);
  });
});
