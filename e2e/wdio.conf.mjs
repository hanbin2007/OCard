// OCard E2E:tauri-driver(WebDriver)驱动 Linux 调试构建。
// 仅在 CI(ubuntu + xvfb)运行;macOS 无 tauri-driver 支持。
//
// 注意:本文件会被 wdio 的 launcher 与每个 worker 各加载一遍,
// 顶层只允许「确定性」计算(路径拼接);目录创建/清理只在 onPrepare(仅 launcher 执行)。
import { spawn } from "node:child_process";
import { copyFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let tauriDriver;

const application = path.resolve("../src-tauri/target/debug/ocard");

// 固定路径:launcher 与 worker 算出同一个值
const tmpRoot = path.join(os.tmpdir(), "ocard-e2e");
const configHome = path.join(tmpRoot, "config");
const nasRoot = path.join(tmpRoot, "nas");
// sidecar 注入:把拉取的 target-triple 命名二进制以裸名放进独立目录,
// 应用经 OCARD_FFMPEG_DIR 定位(不依赖 tauri CLI 的 debug 拷贝行为)
const ffmpegDir = path.join(tmpRoot, "ffmpeg");
// 截图目录:每条用例结束截一张巡览图,失败另存 FAIL 图;CI 打包成 artifact
const shotsDir = path.resolve("./screenshots");
process.env.OCARD_E2E_NAS_ROOT = nasRoot;

export const config = {
  hostname: "127.0.0.1",
  port: 4444,
  specs: ["./specs/**/*.mjs"],
  maxInstances: 1,
  capabilities: [
    {
      // 不设 browserName:WebKitWebDriver 只认 tauri-driver 注入的能力集
      maxInstances: 1,
      "tauri:options": { application },
    },
  ],
  waitforTimeout: 15000,
  connectionRetryTimeout: 120000,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 180000 },

  // 每条用例后截屏(通过=巡览图,失败=FAIL 图),供 CI artifact 回看真实界面
  afterTest: async function (test, _context, { passed }) {
    try {
      const safe = `${test.parent}-${test.title}`
        .replace(/[^\w\u4e00-\u9fff-]+/g, "_")
        .slice(0, 80);
      const name = `${passed ? "ok" : "FAIL"}-${safe}.png`;
      mkdirSync(shotsDir, { recursive: true });
      await browser.saveScreenshot(path.join(shotsDir, name));
    } catch (e) {
      console.warn("截图失败(不影响测试结果):", e?.message);
    }
  },

  onPrepare: () => {
    rmSync(shotsDir, { recursive: true, force: true });
    // 预置工作站配置:XDG_CONFIG_HOME 指向临时目录,应用启动即「已配置」,
    // spec 直接对 nasRoot 磁盘断言。
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(path.join(configHome, "cn.origenclub.ocard"), { recursive: true });
    mkdirSync(nasRoot, { recursive: true });
    writeFileSync(
      path.join(configHome, "cn.origenclub.ocard", "workstation.json"),
      JSON.stringify({ operator: "E2E机器人", nasRoot }),
    );
    mkdirSync(ffmpegDir, { recursive: true });
    for (const tool of ["ffmpeg", "ffprobe"]) {
      const src = path.resolve(
        `../src-tauri/binaries/${tool}-x86_64-unknown-linux-gnu`,
      );
      const dst = path.join(ffmpegDir, tool);
      copyFileSync(src, dst);
      chmodSync(dst, 0o755);
    }
    tauriDriver = spawn("tauri-driver", [], {
      stdio: [null, process.stdout, process.stderr],
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configHome,
        OCARD_FFMPEG_DIR: ffmpegDir,
      },
    });
  },
  onComplete: () => {
    tauriDriver?.kill();
  },
};
