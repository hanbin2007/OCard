// OCard E2E:tauri-driver(WebDriver)驱动 Linux 调试构建。
// 仅在 CI(ubuntu + xvfb)运行;macOS 无 tauri-driver 支持。
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let tauriDriver;

const application = path.resolve("../src-tauri/target/debug/ocard");

// 预置工作站配置:XDG_CONFIG_HOME 指向临时目录,NAS 根同为临时目录,
// 应用启动即处于「已配置」状态,spec 直接对磁盘断言。
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "ocard-e2e-"));
const configHome = path.join(tmpRoot, "config");
const nasRoot = path.join(tmpRoot, "nas");
mkdirSync(path.join(configHome, "cn.origenclub.ocard"), { recursive: true });
mkdirSync(nasRoot, { recursive: true });
writeFileSync(
  path.join(configHome, "cn.origenclub.ocard", "workstation.json"),
  JSON.stringify({ operator: "E2E机器人", nasRoot }),
);
process.env.OCARD_E2E_NAS_ROOT = nasRoot;

export const config = {
  hostname: "127.0.0.1",
  port: 4444,
  specs: ["./specs/**/*.mjs"],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "wry",
      "tauri:options": { application },
    },
  ],
  waitforTimeout: 15000,
  connectionRetryTimeout: 120000,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 180000 },

  onPrepare: () => {
    tauriDriver = spawn("tauri-driver", [], {
      stdio: [null, process.stdout, process.stderr],
      env: { ...process.env, XDG_CONFIG_HOME: configHome },
    });
  },
  onComplete: () => {
    tauriDriver?.kill();
  },
};
