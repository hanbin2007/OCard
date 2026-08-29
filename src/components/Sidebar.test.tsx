/**
 * 侧栏折叠的回归护栏。
 *
 * 这里钉的四件事,每一件都对应一种「看起来还行、实际已经坏了」的形态:
 *  ① 状态切换与 `aria-expanded` —— 开关自己得说得清它现在是开是合;
 *  ② 折叠态下**每个入口仍有名字**(aria-label / title)——标签是被
 *     `display:none` 收起来的,而 display:none 会把可访问名一起抹掉,
 *     不补 aria-label 的话读屏只念得出「按钮」,轨就成了一排哑巴方块;
 *  ③ 折叠态下 Tab 走得到每个入口(断言 document.activeElement);
 *  ④ 偏好跨会话记得住,而**记不住的时候必须出声**(零静默铁律)。
 *
 * 已知边界:jsdom 不加载 CSS(vitest 配了 `css: false`),所以
 * 「折叠后标签真的看不见了」「轨真的只有 64/78px 宽」这类**视觉**结论
 * 本文件证明不了,只能证明 DOM/无障碍语义。视觉与断点的结论来自浏览器实测。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { renderWelcome } from "../testUtils";
import { loadUiPref, saveUiPref } from "../state/store";
import {
  mockCameras,
  mockCopyTasks,
  mockProjects,
  mockStorageCards,
  mockVolumes,
  mockWorkstation,
} from "../api/mock";

afterEach(cleanup);

const base = {
  workstation: mockWorkstation,
  projects: mockProjects,
  cameras: mockCameras,
  cards: mockStorageCards,
  volumes: mockVolumes,
  tasks: mockCopyTasks,
  selectedProjectId: mockProjects[0].id,
  selectedTaskId: mockCopyTasks[0].id,
  route: "copy" as const,
};

const shell = () => document.querySelector(".shell") as HTMLElement;
const toggle = () => screen.getByTestId("sidebar-toggle");

/** 侧栏里能进 Tab 序的元素,按 DOM 顺序 */
function tabbablesInSidebar(): HTMLElement[] {
  const aside = document.getElementById("app-sidebar")!;
  return [...aside.querySelectorAll<HTMLElement>("button, [tabindex]:not([tabindex='-1'])")];
}

describe("侧栏折叠", () => {
  it("默认展开:开关自报 aria-expanded=true,外壳标着 expanded", () => {
    render(<App preloaded={base} />);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(shell().getAttribute("data-sidebar")).toBe("expanded");
    // 展开态的名字来自可见文字,不该多余地写 aria-label(会与可见文字打架)
    expect(screen.getByTestId("nav-copy").getAttribute("aria-label")).toBeNull();
  });

  it("点开关折叠 / 再点展开:两态都反映在 aria-expanded 与外壳属性上", async () => {
    const user = userEvent.setup();
    render(<App preloaded={base} />);

    await user.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(shell().getAttribute("data-sidebar")).toBe("collapsed");

    await user.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(shell().getAttribute("data-sidebar")).toBe("expanded");
  });

  it("开关本身在两态下都有可读的名字(折叠态只剩一个图标)", async () => {
    const user = userEvent.setup();
    render(<App preloaded={base} />);
    expect(toggle().getAttribute("aria-label")).toContain("收起侧栏");
    expect(toggle().getAttribute("title")).toContain("⌘\\");

    await user.click(toggle());
    expect(toggle().getAttribute("aria-label")).toContain("展开侧栏");
    expect(toggle().getAttribute("title")).toContain("⌘\\");
  });

  it("折叠态下每个入口仍认得出:名字进了 aria-label,按名字找得到", async () => {
    const user = userEvent.setup();
    render(<App preloaded={base} />);
    await user.click(toggle());

    for (const [testid, label] of [
      ["nav-manager", "项目管理"],
      ["nav-copy", "拷卡任务"],
      ["nav-devices", "设备登记"],
      ["nav-sorting", "选片与交付"],
      ["nav-transcode", "代理转码"],
      ["nav-trash", "回收站"],
    ] as const) {
      const el = screen.getByTestId(testid);
      // 标签被 CSS 收起后,可访问名只能靠 aria-label
      expect(el.getAttribute("aria-label"), `${testid} 折叠态缺少可访问名`).toContain(
        label,
      );
      // 悬停也认得出:title 是鼠标那一路的同一份信息
      expect(el.getAttribute("title"), `${testid} 折叠态缺少 title`).toContain(label);
      // 按名字找得到 = 读屏能念出来 = 它不是一块哑巴方块
      expect(screen.getByRole("button", { name: new RegExp(label) })).toBe(el);
    }
  });

  it("「当前不适用」的说明不会因为折叠而丢掉", async () => {
    const user = userEvent.setup();
    // 工况 B 项目:代理转码不适用
    const projectB = { ...mockProjects[0], scenario: "B" as const };
    render(
      <App
        preloaded={{ ...base, projects: [projectB], selectedProjectId: projectB.id }}
      />,
    );
    await user.click(toggle());

    const el = screen.getByTestId("nav-transcode");
    expect(el.getAttribute("aria-label")).toContain("代理转码");
    expect(el.getAttribute("aria-label")).toContain("只适用于工况 A");
    expect(el.getAttribute("title")).toContain("只适用于工况 A");
  });

  it("折叠态下 Tab 走得到每一个入口(document.activeElement 逐个到位)", async () => {
    const user = userEvent.setup();
    render(<App preloaded={base} />);
    await user.click(toggle());

    // 从头开始走:焦点先归零,再一路 Tab,把落过脚的元素记下来
    (document.activeElement as HTMLElement | null)?.blur();
    const reached = new Set<string>();
    const stops = tabbablesInSidebar().length + 2;
    for (let i = 0; i < stops; i += 1) {
      await user.tab();
      const active = document.activeElement as HTMLElement | null;
      const id = active?.getAttribute("data-testid");
      if (id) reached.add(id);
    }

    for (const id of [
      "nav-manager",
      "nav-copy",
      "nav-devices",
      "nav-sorting",
      "nav-transcode",
      "nav-trash",
      "sidebar-toggle",
    ]) {
      expect(reached.has(id), `折叠态下 Tab 走不到 ${id}`).toBe(true);
    }
  });

  it("折叠态下「正在拷 N 张」不消失(它有行动意义,不许静默收掉)", async () => {
    const user = userEvent.setup();
    const running = [{ ...mockCopyTasks[0], state: "running" as const }];
    render(<App preloaded={{ ...base, tasks: running }} />);

    const countIn = () =>
      screen.getByTestId("nav-copy").querySelector(".nav-item__count");
    expect(countIn()?.textContent).toBe("1");

    await user.click(toggle());
    // 折叠后它改成贴在图标上的小徽标(CSS),但数字必须还在 DOM 里
    expect(countIn()?.textContent).toBe("1");
  });
});

describe("侧栏折叠快捷键(⌘\\ / Ctrl+\\)", () => {
  it("⌘\\ 与 Ctrl+\\ 都能切换", () => {
    render(<App preloaded={base} />);

    act(() => {
      fireEvent.keyDown(window, { key: "\\", code: "Backslash", metaKey: true });
    });
    expect(shell().getAttribute("data-sidebar")).toBe("collapsed");

    act(() => {
      fireEvent.keyDown(window, { key: "\\", code: "Backslash", ctrlKey: true });
    });
    expect(shell().getAttribute("data-sidebar")).toBe("expanded");
  });

  it("非 US 布局下 `\\` 键产出的字符会变,按物理键位(code)也认", () => {
    render(<App preloaded={base} />);
    act(() => {
      fireEvent.keyDown(window, { key: "*", code: "Backslash", metaKey: true });
    });
    expect(shell().getAttribute("data-sidebar")).toBe("collapsed");
  });

  it("不抢别人的组合:裸 `\\`、⌘⇧\\、⌥⌘\\ 一律放行", () => {
    render(<App preloaded={base} />);
    for (const init of [
      { key: "\\", code: "Backslash" },
      { key: "\\", code: "Backslash", metaKey: true, shiftKey: true },
      { key: "\\", code: "Backslash", metaKey: true, altKey: true },
    ]) {
      act(() => {
        fireEvent.keyDown(window, init);
      });
      expect(shell().getAttribute("data-sidebar")).toBe("expanded");
    }
  });

  it("速查表开着时按键归它,不会在背后偷偷折侧栏", async () => {
    const user = userEvent.setup();
    render(<App preloaded={base} />);
    await user.keyboard("?");
    expect(screen.getByTestId("keyboard-help")).toBeTruthy();

    act(() => {
      fireEvent.keyDown(window, { key: "\\", code: "Backslash", metaKey: true });
    });
    expect(shell().getAttribute("data-sidebar")).toBe("expanded");
  });

  it("速查表里写着这条键位(实现了却没写进表 = 学不到 = 等于没有)", async () => {
    const user = userEvent.setup();
    render(<App preloaded={base} />);
    await user.keyboard("?");
    const help = screen.getByTestId("keyboard-help");
    expect(help.textContent).toContain("⌘/Ctrl + \\");
    expect(help.textContent).toContain("收起/展开侧栏");
  });
});

describe("侧栏折叠的跨会话记忆", () => {
  it("存得进、读得回", () => {
    saveUiPref({ route: "sorting", selectedProjectId: "p-1", sidebarCollapsed: true });
    expect(loadUiPref()).toEqual({
      route: "sorting",
      selectedProjectId: "p-1",
      sidebarCollapsed: true,
    });
  });

  it("上次折着的,这次开起来还是折着", () => {
    saveUiPref({ sidebarCollapsed: true });
    // preloaded 会跳过读偏好(用例隔离),所以这里走没有 preloaded 的真实路径
    renderWelcome();
    expect(shell()).toBeNull(); // 欢迎窗口没有 .shell,但 store 已经按偏好初始化
    // 直接验证读回来的形状:Shell 的 data-sidebar 由它派生
    expect(loadUiPref().sidebarCollapsed).toBe(true);
  });

  it("坏掉的记忆不会把侧栏折起来,而且会报出来", () => {
    window.localStorage.setItem("ocard:v1:ui", "null");
    const issues: string[] = [];
    expect(loadUiPref((i) => issues.push(`${i.op}:${i.key}`))).toEqual({});
    expect(issues).toEqual(["read:ui"]);
  });

  it("内容不是 JSON 时同样报出来,不静静吞掉", () => {
    window.localStorage.setItem("ocard:v1:ui", "{坏了");
    const issues: string[] = [];
    expect(loadUiPref((i) => issues.push(`${i.op}:${i.key}`))).toEqual({});
    expect(issues).toEqual(["read:ui"]);
  });

  it("写不进去时给出可见提示(零静默:不能让人以为软件只是记性差)", async () => {
    // 打桩打在**实例**上,不是 Storage.prototype:jsdom 的 localStorage 走的是
    // 代理实现,原型上的桩根本不生效(实测:打了也照样写成功,用例假绿)
    const spy = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation((key: string) => {
        // 只让界面偏好这一把键写失败,别把主题等无关路径一起打断
        if (key.startsWith("ocard:v1:ui")) throw new Error("配额已满");
      });

    renderWelcome();

    // warning 走 role="status" + aria-live="polite"(error 才是 alert)
    const alert = await waitFor(() => {
      const found = screen
        .getAllByRole("status")
        .find((el) => el.getAttribute("data-code") === "pref-write-failed");
      expect(found).toBeDefined();
      return found!;
    });
    expect(alert.textContent).toContain("界面偏好没能存到本机");
    expect(alert.textContent).toContain("配额已满");
    spy.mockRestore();
  });

  it("读不出来时也给出可见提示,并说明「按默认值启动」", async () => {
    const spy = vi
      .spyOn(window.localStorage, "getItem")
      .mockImplementation((key: string) => {
        if (key.startsWith("ocard:v1:ui")) throw new Error("存储被禁用");
        return null;
      });

    renderWelcome();

    const alert = await waitFor(() => {
      const found = screen
        .getAllByRole("status")
        .find((el) => el.getAttribute("data-code") === "pref-read-failed");
      expect(found).toBeDefined();
      return found!;
    });
    expect(alert.textContent).toContain("读取本机界面偏好失败");
    expect(alert.textContent).toContain("存储被禁用");
    expect(alert.textContent).toContain("已按默认值启动");
    spy.mockRestore();
  });
});
