/**
 * 动效基础设施的行为闸门。
 *
 * 这里守的不是"动画好不好看"，而是三条不能破的底线：
 * ① 不支持视图过渡的内核上，DOM 变更必须照样同步落地——动效降级绝不能吞掉业务动作；
 * ② prefers-reduced-motion 时一律走瞬时路径，一个功能都不能少；
 * ③ 过渡失败（内核抛错）时同样要把变更提交掉，不能卡在半路。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  animateOnce,
  prefersReducedMotion,
  scrollElementTo,
  supportsViewTransition,
  withViewTransition,
} from "./motion";

type StartViewTransition = (callback: () => void | Promise<void>) => {
  finished: Promise<void>;
};

/**
 * 装一个假的 startViewTransition；返回卸载函数。
 * jsdom 运行时没有这个方法（TS 的 DOM 类型里却有），所以要绕开静态类型直接挂。
 */
function installViewTransition(impl: StartViewTransition): () => void {
  const target = document as unknown as Record<string, unknown>;
  target.startViewTransition = impl;
  return () => {
    delete target.startViewTransition;
  };
}

/** 让 matchMedia 对 reduce 查询返回指定值；返回卸载函数 */
function installReducedMotion(reduce: boolean): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) =>
    ({
      matches: reduce && query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.documentElement.removeAttribute("data-vt");
});

describe("prefersReducedMotion", () => {
  it("系统要求减少动效时为真", () => {
    cleanups.push(installReducedMotion(true));
    expect(prefersReducedMotion()).toBe(true);
  });

  it("matchMedia 抛异常时按「不减少」处理，不能让动效判定把界面整个拖崩", () => {
    const original = window.matchMedia;
    window.matchMedia = (() => {
      throw new Error("blocked");
    }) as typeof window.matchMedia;
    cleanups.push(() => {
      window.matchMedia = original;
    });
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("withViewTransition", () => {
  it("内核不支持时同步执行变更——动效可以没有，动作不能没有", () => {
    expect(supportsViewTransition()).toBe(false);
    const update = vi.fn();
    withViewTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
    expect(document.documentElement.hasAttribute("data-vt")).toBe(false);
  });

  it("支持时经由 startViewTransition 提交，并在期间打上 data-vt 抑制重复的挂载动画", async () => {
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    const start = vi.fn((callback: () => void | Promise<void>) => {
      expect(document.documentElement.hasAttribute("data-vt")).toBe(true);
      void callback();
      return { finished };
    });
    cleanups.push(installViewTransition(start));

    const update = vi.fn();
    withViewTransition(update);

    expect(start).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);

    resolveFinished();
    await finished;
    await Promise.resolve();
    expect(document.documentElement.hasAttribute("data-vt")).toBe(false);
  });

  it("要求减少动效时绕开视图过渡，直接同步提交", () => {
    cleanups.push(installReducedMotion(true));
    const start = vi.fn(() => ({ finished: Promise.resolve() }));
    cleanups.push(installViewTransition(start));

    const update = vi.fn();
    withViewTransition(update);

    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("过渡本身抛错时仍然把变更提交掉，并清掉 data-vt", () => {
    cleanups.push(
      installViewTransition(() => {
        throw new Error("transition unavailable");
      }),
    );

    const update = vi.fn();
    withViewTransition(update);

    expect(update).toHaveBeenCalledTimes(1);
    expect(document.documentElement.hasAttribute("data-vt")).toBe(false);
  });
});

describe("scrollElementTo", () => {
  it("有 scrollTo 时用平滑滚动——滚动本身就是「焦点挪到哪了」的提示", () => {
    const el = document.createElement("div");
    const scrollTo = vi.fn();
    Object.assign(el, { scrollTo });

    scrollElementTo(el, 240);

    expect(scrollTo).toHaveBeenCalledWith({ top: 240, behavior: "smooth" });
  });

  it("要求减少动效时退回瞬时定位，位置一样到位", () => {
    cleanups.push(installReducedMotion(true));
    const el = document.createElement("div");
    const scrollTo = vi.fn();
    Object.assign(el, { scrollTo });

    scrollElementTo(el, 240);

    expect(scrollTo).not.toHaveBeenCalled();
    expect(el.scrollTop).toBe(240);
  });

  it("老内核没有 Element.scrollTo 时照样滚到位", () => {
    const el = document.createElement("div");
    scrollElementTo(el, 120);
    expect(el.scrollTop).toBe(120);
  });
});

describe("animateOnce", () => {
  it("要求减少动效时一帧都不放", () => {
    cleanups.push(installReducedMotion(true));
    const el = document.createElement("div");
    const animate = vi.fn();
    Object.assign(el, { animate });

    animateOnce(el, [{ opacity: 0 }, { opacity: 1 }], 350);

    expect(animate).not.toHaveBeenCalled();
  });

  it("内核不认 linear() 弹簧曲线时回落到 cubic-bezier，而不是彻底不动", () => {
    const el = document.createElement("div");
    const animate = vi.fn((_frames: Keyframe[], options: KeyframeAnimationOptions) => {
      if (String(options.easing).startsWith("linear(")) throw new TypeError("bad easing");
      return {} as Animation;
    });
    Object.assign(el, { animate });

    animateOnce(el, [{ opacity: 0 }, { opacity: 1 }], 350);

    expect(animate).toHaveBeenCalledTimes(2);
    expect(String(animate.mock.calls[1][1].easing)).toContain("cubic-bezier");
  });

  it("没有 Web Animations 的环境（jsdom / 老 WebView）静默跳过，不抛错", () => {
    const el = document.createElement("div");
    expect(() => animateOnce(el, [{ opacity: 0 }], 350)).not.toThrow();
  });
});
