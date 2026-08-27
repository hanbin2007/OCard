// M3 转码流冒烟:工况A建项目 → 用捆绑 ffmpeg 生成合成素材(ProRes,命中高负载判定)
// → UI 发起代理转码 → 磁盘断言代理落入「4. 转码素材」。
// 用的是**将被打包的那个 sidecar**(计划纪律:系统 ffmpeg 不算数)。
import { $, browser, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createProjectViaWizard } from "../lib/windows.mjs";

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
  it("引导新建工况A项目并注入 ProRes 合成素材", async () => {
    await createProjectViaWizard("E2E转码", "a");

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
    // 项目已在向导完成时选中,直接进转码屏
    await $('[data-testid="nav-transcode"]').click();
    await $('[data-testid="transcode-start"]').waitForClickable({ timeout: 30000 });
    await $('[data-testid="transcode-start"]').click();
    await confirmDangerDialogIfAny();

    // 首次要跑编码能力真探针,放宽等待
    await $('[data-testid="transcode-result"]').waitForExist({ timeout: 120000 });

    const out = path.join(projectRoot(), "4. 转码素材", "0824_A7M4_A_ZS");
    await browser.waitUntil(() => existsSync(path.join(out, "clip1_MOV_proxy.mp4")), {
      timeout: 15000,
      timeoutMsg: "代理未落盘",
    });
    // 不残留 staging
    expect(
      readdirSync(out).some((f) => f.includes("transpart")),
    ).toBe(false);
    // 幂等重跑真断言(评审 P1-8:元素存在是空断言——按 mtime 不变 + 计数文本验证)
    const proxyPath = path.join(out, "clip1_MOV_proxy.mp4");
    const mtimeBefore = statSync(proxyPath).mtimeMs;
    await $('[data-testid="transcode-start"]').click();
    await confirmDangerDialogIfAny();
    await browser.waitUntil(
      async () => {
        const t = await $('[data-testid="transcode-already"]').getText().catch(() => "");
        return /^[1-9]\d*$/.test(t.trim());
      },
      { timeout: 60000, timeoutMsg: "重跑未报告非零的已转码跳过数" },
    );
    expect(statSync(proxyPath).mtimeMs).toBe(mtimeBefore);
    const files = readdirSync(out).filter((f) => !f.startsWith(".")).sort();
    // R5:产物旁多一份来源指纹 sidecar(existence≠success 的身份绑定)
    expect(files).toEqual(["clip1_MOV_proxy.mp4", "clip1_MOV_proxy.mp4.src.json"]);
  });
});
