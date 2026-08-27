// W9 收口:成片命名校验 E2E 冒烟(R1 P2 账面项「成片校验 E2E spec」兑现)。
// 工况A建项目 → 磁盘注入三个成片(合规 / 名实不符 / 命名不合规)
// → 选中项目行 → 成片校验面板逐项断言;分辨率交叉核对走真实 ffprobe(捆绑 sidecar)。
import { $, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { createProjectViaWizard, openAllProjects } from "../lib/windows.mjs";

const nasRoot = process.env.OCARD_E2E_NAS_ROOT;
// 与 transcode spec 同源:用将被打包的那个 sidecar 生成素材(系统 ffmpeg 不算数)
const ffmpegBin = path.resolve("../src-tauri/binaries/ffmpeg-x86_64-unknown-linux-gnu");

function projectRoot() {
  const dirs = readdirSync(nasRoot).filter((d) => d.includes("E2E成片"));
  expect(dirs.length).toBe(1);
  return path.join(nasRoot, dirs[0]);
}

// 面板按 fileName 渲染条目;行内 span 的 title 属性是稳定锚点
const itemFor = (fileName) =>
  $(`//div[@data-testid="final-cut-item"][.//span[@title="${fileName}"]]`);

describe("OCard M3 成片命名校验冒烟", () => {
  it("引导新建工况A项目并注入成片(合规/名实不符/命名不合规)", async () => {
    await createProjectViaWizard("E2E成片", "a");

    const dir = path.join(projectRoot(), "6. 成片");
    const good = path.join(dir, "20260825_晚会_1080P_预览_V1.mp4");
    // 1080p 真实视频:命名 1080P,名实相符
    execFileSync(ffmpegBin, [
      "-nostdin", "-hide_banner", "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=duration=1:size=1920x1080:rate=30",
      "-c:v", "libx264", "-n", good,
    ]);
    // 同一素材(实际 1080)命名 4K:应被 ffprobe 交叉核对抓出
    copyFileSync(good, path.join(dir, "20260825_晚会_4K_终版_V2.mp4"));
    // 命名不合规(段数不足)
    copyFileSync(good, path.join(dir, "badname.mp4"));
    expect(existsSync(good)).toBe(true);
  });

  it("成片校验面板:合规放行、假4K标红、坏名给人话理由", async () => {
    // 成片校验面板在项目管理窗口的详情区:从主窗口侧栏打开「所有项目」
    await openAllProjects();
    const row = $('[data-testid="project-row"] span[title="E2E成片"]');
    await row.waitForClickable({ timeout: 15000 });
    await row.click();
    await $('[data-testid="final-cut-panel"]').waitForExist({ timeout: 15000 });
    // 首轮加载即全量扫描;三个小文件逐个 ffprobe,放宽等待
    await itemFor("badname.mp4").waitForExist({ timeout: 60000 });

    const good = itemFor("20260825_晚会_1080P_预览_V1.mp4");
    await good.waitForExist({ timeout: 15000 });
    expect(await good.getAttribute("data-valid")).toBe("true");
    // 名实相符:不得出现分辨率不符文案(空断言反例:mismatch 元素必须真的不在)
    expect(
      await good.$('[data-testid="final-cut-mismatch"]').isExisting(),
    ).toBe(false);

    const fake4k = itemFor("20260825_晚会_4K_终版_V2.mp4");
    await fake4k.waitForExist({ timeout: 15000 });
    expect(await fake4k.getAttribute("data-valid")).toBe("true");
    const mismatch = fake4k.$('[data-testid="final-cut-mismatch"]');
    await mismatch.waitForExist({ timeout: 15000 });
    // 后端原文:「命名为 4K(期望约 2160 像素高),实际 1080 像素」
    expect(await mismatch.getText()).toContain("4K");
    expect(await mismatch.getText()).toContain("1080");

    const bad = itemFor("badname.mp4");
    expect(await bad.getAttribute("data-valid")).toBe("false");
    const issues = bad.$('[data-testid="final-cut-issues"]');
    await issues.waitForExist({ timeout: 15000 });
    expect(await issues.getText()).toContain("段数不足");
  });
});
