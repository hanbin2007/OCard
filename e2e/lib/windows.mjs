// 多窗口 E2E 工具:启动重构后应用有两个窗口(welcome 欢迎/项目管理 + main 主窗口),
// WebDriver 需要按「窗口里有什么」来切换句柄——句柄顺序与创建顺序无关,
// 且欢迎窗口在打开项目后会被销毁,当前句柄可能随时失效。
import { $, browser } from "@wdio/globals";

/** 轮询全部窗口句柄,切到包含指定锚点元素的窗口 */
export async function switchToWindowWith(selector, timeout = 30000) {
  await browser.waitUntil(
    async () => {
      let handles;
      try {
        handles = await browser.getWindowHandles();
      } catch {
        return false;
      }
      for (const handle of handles) {
        try {
          await browser.switchToWindow(handle);
        } catch {
          continue; // 句柄刚被销毁(欢迎窗口关闭),跳过
        }
        try {
          if (await $(selector).isExisting()) return true;
        } catch {
          continue;
        }
      }
      return false;
    },
    { timeout, timeoutMsg: `找不到包含 ${selector} 的窗口` },
  );
}

/**
 * 在欢迎窗口走完新项目引导并进入主窗口。
 * 只填名称与工况,其余步骤(设备/用卡/备份/标签)全部默认跳过;
 * 完成后欢迎窗口销毁、主窗口显示,当前上下文已切到主窗口。
 * @param {string} name 项目名
 * @param {"a"|"b"} scenario 工况(小写,对应 data-testid)
 */
export async function createProjectViaWizard(name, scenario) {
  await switchToWindowWith('[data-testid="welcome-home"]');
  await $('[data-testid="welcome-new-project"]').click();
  await $('[data-testid="np-name"]').waitForExist({ timeout: 15000 });
  await $('[data-testid="np-name"]').setValue(name);
  await $(`[data-testid="np-scenario-${scenario}"]`).click();
  // 逐步点「下一步」直到出现「创建项目」(对步骤数量不敏感)
  await browser.waitUntil(
    async () => {
      if (await $('[data-testid="np-submit"]').isExisting()) return true;
      const next = $('[data-testid="npw-next"]');
      if (await next.isExisting()) await next.click();
      return false;
    },
    { timeout: 30000, timeoutMsg: "引导没有走到「确认创建」步" },
  );
  await $('[data-testid="np-submit"]').click();
  // 创建成功 → 主窗口显示并选中新项目;主窗口侧栏有「项目管理」入口
  await switchToWindowWith('[data-testid="nav-manager"]', 30000);
  await $('[data-testid="current-project-chip"]').waitForExist({ timeout: 20000 });
}

/** 从主窗口侧栏打开欢迎/项目管理窗口,并切到「所有项目」列表 */
export async function openAllProjects() {
  await $('[data-testid="nav-manager"]').click();
  await switchToWindowWith('[data-testid="welcome-home"]');
  await $('[data-testid="welcome-browse-all"]').click();
  await $('[data-testid="project-row"]').waitForExist({ timeout: 20000 });
}
