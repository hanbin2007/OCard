import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NOTICE_TITLES } from "./NotificationCenter";

/**
 * 后端每一个会发出的通知 code 都必须在 NOTICE_TITLES 里有抬头。
 * 忘了配的话用户看到的抬头是「降级提示」这种通用回落——CI 照样全绿,直到现场有人问
 * 「这是什么」。这里直接扫 Rust 源码里 notify::warn / error / info(_for_task) 调用
 * 里的 code 字面量。
 */
function rustFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...rustFiles(p));
    else if (p.endsWith(".rs")) out.push(p);
  }
  return out;
}

describe("通知 code 与抬头的契约", () => {
  it("后端发出的每个 code 都配了抬头", () => {
    // 整棵 src-tauri/src:lib.rs 里也有 8 处 notify 调用(协议 / 关窗)
    const root = join(__dirname, "..", "..", "src-tauri", "src");
    const codes = new Set<string>();
    for (const file of rustFiles(root)) {
      const src = readFileSync(file, "utf8");
      // 终止符认 `);` 也认 `),`(match 分支表达式位置的调用以逗号收尾,只认分号会漏掉
      // copy-resume-rescan-failed 那种);截断到内层的 `),` 也无妨:code 总在报文正文
      // 之前。不用「调用点后 N 字符」的宽口径——那会把线程名、审计 kind 这类 kebab
      // 字面量也收进来。`warn_scoped` 是带 Option 任务身份的间接层,也要认,否则
      // report_lease_release 里的 lease code 对门禁不可见
      const re = /notify::(?:warn|error|info)(?:_for_task|_scoped)?\s*\(([\s\S]{0,700}?)\)\s*[;,]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        for (const lit of m[1].matchAll(/"([a-z][a-z0-9]*(?:-[a-z0-9]+)+)"/g)) codes.add(lit[1]);
      }
    }
    expect(codes.size, "扫描应至少找到几十个 code").toBeGreaterThan(60);
    // 门禁自身的守卫:这几个此前被漏掉的 code 必须被扫到(扫描根 / 终止符 / 间接层三个洞)
    for (const must of [
      "close-blocked-active-jobs",
      "copy-resume-rescan-failed",
      "task-lease-left-behind",
      "task-lease-lost-outside-run",
    ]) {
      expect(codes.has(must), `扫描器漏掉了 ${must}`).toBe(true);
    }
    const missing = [...codes].filter((c) => !(c in NOTICE_TITLES) && !LEGACY_FALLBACK.has(c)).sort();
    expect(missing, `这些 code 没有抬头(新 code 必须配;别往下面的旧名单里加): ${missing.join(", ")}`).toEqual(
      [],
    );
    // 棘轮的另一头:名单里的 code 一旦配了抬头就从名单里删,名单只减不增
    const graduated = [...LEGACY_FALLBACK].filter((c) => c in NOTICE_TITLES);
    expect(graduated, "已配抬头的 code 要从旧名单里删掉").toEqual([]);
  });
});

/**
 * 棘轮:0.4.4 之前就存在、至今沿用「按等级回落」抬头(降级提示 / 出错 / 提示)的 code。
 * 它们的正文都自带主语,回落抬头可读;但**新** code 不许再进这个名单——必须配抬头。
 * 逐个补抬头时从这里删。
 */
const LEGACY_FALLBACK = new Set([
  "ai-models-corrupt",
  "analysis-cache-degraded",
  "analysis-partial",
  "auto-proxy-abandoned",
  "auto-proxy-state-unsaved",
  "copy-flatten-renamed",
  "copy-hidden-skipped",
  "copy-resume-content-replaced",
  "copy-resume-manifest-not-persisted",
  "copy-resume-new-files",
  "copy-resume-scope-widened",
  "copy-resume-size-changed",
  "copy-symlinks-skipped",
  "copy-target-name-clash",
  "copy-worker-spawn-failed",
  "curated-hints-degraded",
  "delivery-partial",
  "delivery-scan-degraded",
  "disk-space-insufficient",
  "face-detect-degraded",
  "ffmpeg-missing",
  "fsx-fallback-window",
  "hwenc-fallback",
  "hwenc-probe-failed",
  "hwenc-runtime-fallback",
  "index-failures",
  "index-files-moved",
  "index-thread-panicked",
  "job-cancelled",
  "project-journal-degraded",
  "rebuild-legacy-manifest",
  "rebuild-manifest-corrupt",
  "rebuild-selection-manifest-incomplete",
  "recent-projects-save-failed",
  "source-folders-case-alias",
  "source-folders-unreadable",
  "timestamps-not-preserved",
  "transcode-partial",
  "transcode-skipped",
  "transcode-staging-cleaned",
  "trash-file-stranded",
  "trash-index-degraded",
  "trash-index-rewrite-failed",
  "trash-orphan-files",
  "trash-tombstone-failed",
  "update-check-failed",
  "update-download-failed",
  "update-install-failed",
  "update-installed",
  "verify-cache-fallback",
  "volume-uid-skipped",
  "volume-uid-unwritable",
  "volumes-registry-unavailable",
  "workstation-config-degraded",
]);
