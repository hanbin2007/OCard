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
 * 对一个 selector 反复「重新查询 → 动作」,直到成功。
 *
 * 三种失败在带进场动画的界面上都是**时序**而非真错:
 *   - stale element reference —— 句柄跨了 await,元素在这期间被重挂;
 *   - element click intercepted —— 动画中的层暂时压在上面;
 *   - element not interactable —— 元素还在从 opacity/transform 里进场。
 * 所以每一轮都**重新查询**、绝不跨 await 缓存句柄,失败就等下一拍。
 * 超时仍失败才是真失败,那时把最后一次的原话带出来,别吞成「超时」。
 */
async function retryOn(selector, action, timeout = 20000) {
  let last = null;
  await browser.waitUntil(
    async () => {
      try {
        const el = await $(selector);
        if (!(await el.isExisting())) return false;
        await action(el);
        return true;
      } catch (err) {
        last = err;
        return false;
      }
    },
    {
      timeout,
      interval: 250,
      timeoutMsg: `对 ${selector} 的操作始终没成功:${last?.message ?? "元素一直没出现"}`,
    },
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
  await retryOn('[data-testid="welcome-new-project"]', (el) => el.click());
  await $('[data-testid="np-name"]').waitForExist({ timeout: 15000 });
  // 填值同样要容错:面板有进场动画,动画期间输入框可能刚被重挂,
  // 而 setValue 拿到的是上一拍的句柄 → stale element reference(CI 实测)
  await retryOn('[data-testid="np-name"]', (el) => el.setValue(name));
  await retryOn(`[data-testid="np-scenario-${scenario}"]`, (el) => el.click());
  // 逐步点「下一步」直到出现「创建项目」(对步骤数量不敏感)。
  // 每轮都**重新查询**元素,绝不跨 await 缓存句柄:换步会重挂面板,
  // 缓存下来的句柄下一拍就 stale(CI 实测 stale element reference)。
  // 点击也要容错:步骤面板有进场动画,动画期间点击可能被判为
  // intercepted/not interactable——失败就等下一轮重试,而不是炸掉。
  await browser.waitUntil(
    async () => {
      if (await $('[data-testid="np-submit"]').isExisting()) return true;
      if (await $('[data-testid="npw-next"]').isExisting()) {
        try {
          await $('[data-testid="npw-next"]').click();
        } catch {
          return false; // 动画/重挂撞上了,下一轮再来
        }
      }
      return false;
    },
    { timeout: 30000, interval: 300, timeoutMsg: "引导没有走到「确认创建」步" },
  );
  await retryOn('[data-testid="np-submit"]', (el) => el.click());
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
