/**
 * 焦点圈定与模态层栈。
 *
 * `trapTabFocus` 那几条是从 `sorting.test.ts` 原样搬过来的回归线——函数换了
 * 门牌号，行为一个字不能变。后面几条测的是 `useModalFocus`：开屏取焦、
 * Tab 圈定、焦点被挪到层外时被拉回、关闭还原、嵌套只认最上层。
 *
 * 一律走 `user.keyboard("{Tab}")`（派发到 `document.activeElement`；没有被
 * `preventDefault` 时 user-event 会真的把焦点移到下一个可聚焦元素）并直接
 * 断言 `document.activeElement`。用 `fireEvent.keyDown(某个元素, …)` 会绕过
 * 整条焦点链——本项目的焦点 bug 当初就是这么逃过测试的。
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { modalLayerCount, trapTabFocus, useModalFocus } from "./focusTrap";

afterEach(cleanup);

describe("焦点圈定 trapTabFocus", () => {
  function layer(): { box: HTMLElement; buttons: HTMLButtonElement[] } {
    const box = document.createElement("div");
    box.tabIndex = -1;
    box.innerHTML = "<button>a</button><button>b</button><button>c</button>";
    document.body.appendChild(box);
    return {
      box,
      buttons: Array.from(box.querySelectorAll("button")),
    };
  }

  it("末项按 Tab 回到首项,首项 Shift+Tab 回到末项——焦点出不去这一层", () => {
    const { box, buttons } = layer();
    buttons[2].focus();
    expect(trapTabFocus(box, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(buttons[0]);

    buttons[0].focus();
    expect(trapTabFocus(box, { key: "Tab", shiftKey: true })).toBe(true);
    expect(document.activeElement).toBe(buttons[2]);
    box.remove();
  });

  it("中间位置原样交给浏览器原生 Tab 顺序", () => {
    const { box, buttons } = layer();
    buttons[1].focus();
    expect(trapTabFocus(box, { key: "Tab" })).toBe(false);
    box.remove();
  });

  it("焦点在层外(例如刚从背后那层跑过来)时收回层内首项", () => {
    const { box, buttons } = layer();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    expect(trapTabFocus(box, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(buttons[0]);
    outside.remove();
    box.remove();
  });

  it("非 Tab 键一律不接管", () => {
    const { box } = layer();
    expect(trapTabFocus(box, { key: "Escape" })).toBe(false);
    expect(trapTabFocus(null, { key: "Tab" })).toBe(false);
    box.remove();
  });
});

/* ------------------------------------------------------------------ *
 * useModalFocus
 * ------------------------------------------------------------------ */

/**
 * 两层模态 + 一个层外背景按钮。
 *
 * 内层是外层的**兄弟节点**而不是子节点——这正是仓库里真实的形状
 * （会话门 `.overlay--gate` 与它上面的确认框 `.overlay--elevated`）。
 */
function Harness() {
  const [outerOpen, setOuterOpen] = useState(false);
  const [innerOpen, setInnerOpen] = useState(false);
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  useModalFocus({
    ref: outerRef,
    active: outerOpen,
    onEscape: () => setOuterOpen(false),
  });
  useModalFocus({
    ref: innerRef,
    active: innerOpen,
    onEscape: () => setInnerOpen(false),
  });

  return (
    <div>
      <button type="button" data-testid="trigger" onClick={() => setOuterOpen(true)}>
        打开外层
      </button>
      <button type="button" data-testid="background">
        背景按钮
      </button>

      {outerOpen ? (
        <div className="overlay">
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label="外层"
            data-testid="layer-outer"
            ref={outerRef}
            tabIndex={-1}
          >
            <button type="button" data-testid="outer-first">
              外层首项
            </button>
            <button
              type="button"
              data-testid="open-inner"
              onClick={() => setInnerOpen(true)}
            >
              打开内层
            </button>
            <button type="button" data-testid="outer-last">
              外层末项
            </button>
          </div>
        </div>
      ) : null}

      {innerOpen ? (
        <div className="overlay overlay--elevated">
          <div
            className="dialog"
            role="alertdialog"
            aria-modal="true"
            aria-label="内层"
            data-testid="layer-inner"
            ref={innerRef}
            tabIndex={-1}
          >
            <button type="button" data-testid="inner-first">
              内层首项
            </button>
            <button type="button" data-testid="inner-last">
              内层末项
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

describe("useModalFocus", () => {
  it("开屏把焦点收进层内首项", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId("trigger"));
    expect(document.activeElement).toBe(screen.getByTestId("outer-first"));
  });

  it("Tab 到末项回到首项,Shift+Tab 到首项回到末项——焦点出不去这一层", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId("trigger"));

    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(screen.getByTestId("open-inner"));
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(screen.getByTestId("outer-last"));
    // 末项再按 Tab：圈回首项，而不是跑到背景按钮上
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(screen.getByTestId("outer-first"));

    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(screen.getByTestId("outer-last"));
  });

  it("焦点被挪到层外时,下一次 Tab 把它拽回层内", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId("trigger"));

    (screen.getByTestId("background") as HTMLButtonElement).focus();
    expect(document.activeElement).toBe(screen.getByTestId("background"));

    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(screen.getByTestId("outer-first"));
  });

  it("关闭后焦点回到触发它的那个按钮,而不是掉进 body", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByTestId("trigger");
    await user.click(trigger);

    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("layer-outer")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(trigger);
  });

  it("嵌套：只有最上层收键，Tab 圈在内层，Esc 只关内层并把焦点还给它的触发者", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId("trigger"));
    const openInner = screen.getByTestId("open-inner");
    await user.click(openInner);
    expect(modalLayerCount()).toBe(2);
    expect(document.activeElement).toBe(screen.getByTestId("inner-first"));

    // 外层的圈定处理器此刻必须闭嘴，否则这一下 Tab 会被它扯回 outer-first
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(screen.getByTestId("inner-last"));
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(screen.getByTestId("inner-first"));

    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("layer-inner")).toBeNull();
    expect(screen.queryByTestId("layer-outer")).not.toBeNull();
    expect(document.activeElement).toBe(openInner);
    expect(modalLayerCount()).toBe(1);

    // 内层收起后外层重新拿回键盘：Tab 与 Esc 都回到外层
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(screen.getByTestId("outer-last"));
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("layer-outer")).toBeNull();
    expect(modalLayerCount()).toBe(0);
  });

  it("层卸载后不留监听：两层都关掉后模态层栈必须清空", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId("trigger"));
    await user.click(screen.getByTestId("open-inner"));
    cleanup();
    expect(modalLayerCount()).toBe(0);
  });

  /**
   * ★ 死层不许堵住活层。
   *
   * 栈原本完全依赖「卸载时 cleanup 一定跑、且顺序如预期」。这个假设破了之后
   * 栈顶会是一个已经离开文档的节点，`isTopModalLayer` 于是对**活着的那层**
   * 返回 false，那层的键盘处理器整个闭嘴——弹窗开着、Tab 和 Esc 全没反应，
   * 屏上却没有任何迹象。这正是历史事故清单上的「按键按了没反应」。
   *
   * 现实里的症状是全量测试约五分之一概率红一条焦点用例（单跑那个文件 12 轮
   * 全绿），也就是说真实使用中同样会偶发，只是没人能稳定复现、更没人能归因。
   * 这里直接把「节点被摘走但没出栈」这个状态造出来，钉住栈必须自愈。
   */
  it("★ 已离开文档的层不许堵住活着的那层（栈自愈）", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId("trigger"));
    expect(modalLayerCount()).toBe(1);

    // 绕过 React 卸载，直接把层从文档上摘掉：模拟「cleanup 还没轮到」
    const layer = screen.getByTestId("layer-outer");
    const parent = layer.parentElement!;
    parent.removeChild(layer);

    // 死层必须当场从栈里消失，而不是继续占着栈顶
    expect(modalLayerCount()).toBe(0);
    parent.appendChild(layer); // 放回去，免得影响后面的清理

    // 关键：栈没有被永久毒化——重新挂一层，它必须照常拿到键盘
    cleanup();
    render(<Harness />);
    await user.click(screen.getByTestId("trigger"));
    expect(modalLayerCount()).toBe(1);
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("layer-outer")).toBeNull();
  });
});
