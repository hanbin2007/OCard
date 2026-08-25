/**
 * 动效基础设施（Apple《Designing Fluid Interfaces》口径）。
 *
 * 三条硬规矩，本文件负责守住：
 * ① 连续变化一律交给 CSS transition —— 它天生从"当前呈现值"继续，
 *    因此中途改目标不会跳帧，等价于可中断动画。不写定时脚本动画。
 * ② 只动 transform / opacity。千张缩略图的网格里，任何会引发重排的
 *    动画属性都会掉帧。
 * ③ prefers-reduced-motion 时降为瞬时切换：功能一个不少，位移全部去掉。
 */

import { flushSync } from "react-dom";

interface ViewTransition {
  finished: Promise<void>;
  /** 过渡被后一次过渡顶掉时会 reject；没人接就是一条噪音日志 */
  ready?: Promise<void>;
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void | Promise<void>) => ViewTransition;
};

/** 用户是否要求减少动效。拿不到 matchMedia（老内核 / 测试环境）时按"不减少"处理。 */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    // 某些内核在 iframe / 隐私模式下会抛，动效不是关键路径，静默回落
    return false;
  }
}

/** 当前内核是否支持视图过渡。 */
export function supportsViewTransition(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof (document as ViewTransitionDocument).startViewTransition === "function"
  );
}

/** 同时进行的过渡计数：嵌套触发时不能让先结束的那次提前摘掉标记 */
let activeTransitions = 0;

function markStart(): void {
  activeTransitions += 1;
  document.documentElement.setAttribute("data-vt", "");
}

function markEnd(): void {
  activeTransitions = Math.max(0, activeTransitions - 1);
  if (activeTransitions === 0) document.documentElement.removeAttribute("data-vt");
}

/**
 * 在一次「视图过渡」里提交 DOM 变更。
 *
 * 支持时：浏览器先给旧状态拍快照，回调里同步落地新状态，然后按 base.css 里
 * 的 `::view-transition-*` 规则做形变（网格缩略图 ⇄ 全屏预览就是靠这个连起来的）。
 * 不支持、或用户要求减少动效时：**直接同步执行**，业务行为一模一样。
 *
 * 回调必须同步改完 DOM，所以这里用 flushSync 强制 React 立即提交。
 */
export function withViewTransition(update: () => void): void {
  const doc = document as ViewTransitionDocument;
  if (prefersReducedMotion() || typeof doc.startViewTransition !== "function") {
    update();
    return;
  }

  markStart();
  let transition: ViewTransition;
  try {
    transition = doc.startViewTransition(() => {
      flushSync(update);
    });
  } catch {
    // 过渡起不来绝不能把这次操作一起吞掉：回落成直接提交
    markEnd();
    update();
    return;
  }

  // 连续两次过渡时前一次会被顶掉（这是正常的、也是"可中断"的体现），
  // 但它的 promise 得有人接，否则控制台会刷未处理拒绝
  transition.ready?.catch(() => undefined);
  void transition.finished.then(markEnd, markEnd);
}

/**
 * 与 CSS 里 `--spring` 完全同一条曲线（ζ=1 临界阻尼弹簧的位移采样）。
 * 老内核不认 linear() 时回落到形似的 cubic-bezier。
 */
const SPRING_LINEAR =
  "linear(0, 0.0458, 0.1477, 0.2698, 0.3919, 0.5041, 0.602, 0.6846, 0.7525, " +
  "0.8075, 0.8512, 0.8858, 0.9127, 0.9336, 0.9497, 0.962, 0.9714, 0.9785, " +
  "0.9839, 0.988, 0.9911, 0.9933, 0.9951, 0.9963, 0.9973, 0.998, 1)";
const SPRING_FALLBACK = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * 放一次性的进场动画。
 *
 * 用原生 Web Animations 而不是 CSS 类，是因为这里要的是"同一个节点、
 * 同一个动画、要能连着重放"（左右翻图连按时）；CSS 动画在这种场景下
 * 需要靠交替 animation-name 才能重新起播，得不偿失。
 * 不改变任何布局属性，只有 transform / opacity。
 */
export function animateOnce(
  el: Element,
  keyframes: Keyframe[],
  durationMs: number,
): void {
  if (prefersReducedMotion()) return;
  // jsdom / 老 WebView 没有 Web Animations，直接不动
  if (typeof el.animate !== "function") return;
  for (const easing of [SPRING_LINEAR, SPRING_FALLBACK]) {
    try {
      el.animate(keyframes, { duration: durationMs, easing, fill: "none" });
      return;
    } catch {
      // 内核不认这条曲线，换下一条；两条都不行就放弃——动效不是关键路径
    }
  }
}

/**
 * 把元素滚进可视区。
 *
 * 平滑滚动本身就是"焦点去哪了"的可见性提示（键盘导航尤其需要），
 * 但减少动效时必须退回瞬时定位；老内核没有 Element.scrollTo 时也一样。
 */
export function scrollElementTo(el: Element, top: number): void {
  if (!prefersReducedMotion() && typeof el.scrollTo === "function") {
    try {
      el.scrollTo({ top, behavior: "smooth" });
      return;
    } catch {
      // 落到下面的瞬时定位
    }
  }
  el.scrollTop = top;
}
