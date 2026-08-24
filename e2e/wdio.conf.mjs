// OCard E2E:tauri-driver(WebDriver)驱动 Linux 调试构建。
// 仅在 CI(ubuntu + xvfb)运行;macOS 无 tauri-driver 支持。
//
// 注意:本文件会被 wdio 的 launcher 与每个 worker 各加载一遍,
// 顶层只允许「确定性」计算(路径拼接);目录创建/清理只在 onPrepare(仅 launcher 执行)。
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let tauriDriver;

const application = path.resolve("../src-tauri/target/debug/ocard");

// 固定路径:launcher 与 worker 算出同一个值
const tmpRoot = path.join(os.tmpdir(), "ocard-e2e");
const configHome = path.join(tmpRoot, "config");
const nasRoot = path.join(tmpRoot, "nas");
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

  onPrepare: () => {
    // 预置工作站配置:XDG_CONFIG_HOME 指向临时目录,应用启动即「已配置」,
    // spec 直接对 nasRoot 磁盘断言。
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(path.join(configHome, "cn.origenclub.ocard"), { recursive: true });
    mkdirSync(nasRoot, { recursive: true });
    writeFileSync(
      path.join(configHome, "cn.origenclub.ocard", "workstation.json"),
      JSON.stringify({ operator: "E2E机器人", nasRoot }),
    );
    tauriDriver = spawn("tauri-driver", [], {
      stdio: [null, process.stdout, process.stderr],
      env: { ...process.env, XDG_CONFIG_HOME: configHome },
    });
  },
  onComplete: () => {
    tauriDriver?.kill();
  },
};
