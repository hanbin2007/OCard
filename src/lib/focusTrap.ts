/**
 * 模态浮层的焦点管理：焦点圈定 + 开屏取焦 + 关闭还原 + 嵌套只认最上层。
 *
 * 为什么单独成模块：`trapTabFocus` 原本住在 `lib/sorting.ts` 里——那是选片屏的
 * 领域模块（光标移动、选区、快捷键解析），焦点管理放进去纯属错位，于是
 * 走 `.overlay` 的那批对话框谁也没想到去那里 import，全都漏了圈定。
 *
 * 本模块只依赖 DOM 与 React，任何浮层都可以直接用。
 */

import { useEffect, useRef, type RefObject } from "react";

/** 焦点圈定用的可聚焦元素选择器（顺序即 Tab 顺序：querySelectorAll 按文档序返回） */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function focusablesIn(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => el.getAttribute("aria-hidden") !== "true");
}

/**
 * 全屏浮层的焦点圈定（focus trap）。
 *
 * `aria-modal="true"` 只是**说**自己是模态，浏览器不会因此拦住 Tab。
 * 不圈定的实际后果：Tab 几下焦点就跑到层背后的网格/按钮上，而此时 Esc
 * 又被浮层的键盘流吃掉——用户被困在一个看得见却操作不了的界面里。
 *
 * 只接管**边界**上的那一下（首项 Shift+Tab、末项 Tab、焦点不在层内），
 * 中间位置原样交给浏览器原生 Tab 顺序，避免自己实现一套有出入的顺序。
 * 返回 true 表示已接管，调用方应 `preventDefault()`。
 */
export function trapTabFocus(
  container: HTMLElement | null,
  event: { key: string; shiftKey?: boolean },
): boolean {
  if (event.key !== "Tab" || !container) return false;
  const items = focusablesIn(container);
  if (items.length === 0) {
    // 层里没有可聚焦子元素：焦点留在层本身，别让它溜到背后
    container.focus();
    return true;
  }
  const active =
    typeof document !== "undefined"
      ? (document.activeElement as HTMLElement | null)
      : null;
  const index = active ? items.indexOf(active) : -1;
  if (index < 0) {
    (event.shiftKey ? items[items.length - 1] : items[0]).focus();
    return true;
  }
  if (event.shiftKey && index === 0) {
    items[items.length - 1].focus();
    return true;
  }
  if (!event.shiftKey && index === items.length - 1) {
    items[0].focus();
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 模态层栈：嵌套时只有最上层持有键盘
 * ------------------------------------------------------------------ */

/**
 * 当前打开着的模态层，后进的在栈顶。
 *
 * 为什么需要它：对话框上面还能再开确认框（`.overlay--elevated` z=90 压在
 * 会话门 z=80 之上就是为这个场景造的）。两层都各自监听 document 的话，
 * 一次 Tab 会被**两个**圈定处理器接住——下层把焦点扯回它自己的首项，
 * 用户眼前的确认框反而按不动。栈顶判定让下层在盖住期间彻底闭嘴。
 */
const modalLayers: HTMLElement[] = [];

/**
 * 取栈顶前先把**已经离开文档**的层清掉(自愈)。
 *
 * 栈原本完全依赖「卸载时 cleanup 一定跑、且顺序如预期」。这个假设一旦破了
 * ——节点先被父层从 DOM 上摘走、cleanup 还没轮到——栈顶就是一个死节点,
 * 于是 `isTopModalLayer` 对**活着的那层**返回 false,那层的键盘处理器整个
 * 闭嘴:弹窗开着、Tab 和 Esc 全没反应,而且屏上没有任何迹象。
 * 这正是本项目历史事故清单上的「按键按了没反应」。
 *
 * 症状是全量测试里约五分之一概率红一条焦点用例(单跑那个文件 12 轮全绿),
 * 也就是说它在真实使用中同样会偶发,只是没人能稳定复现、更没人能归因。
 * 与其去猜哪条卸载路径漏了,不如让栈本身不可能被死节点堵住。
 */
function pruneDetached(): void {
  for (let i = modalLayers.length - 1; i >= 0; i--) {
    if (!modalLayers[i].isConnected) modalLayers.splice(i, 1);
  }
}

export function topModalLayer(): HTMLElement | null {
  pruneDetached();
  return modalLayers.length > 0 ? modalLayers[modalLayers.length - 1] : null;
}

export function isTopModalLayer(node: HTMLElement | null): boolean {
  return node !== null && topModalLayer() === node;
}

/** 仅供测试与断言使用：当前叠了几层模态（不含已离开文档的死层） */
export function modalLayerCount(): number {
  pruneDetached();
  return modalLayers.length;
}

export interface ModalFocusOptions {
  /** 层的根节点：焦点圈定的范围，也是取焦兜底目标（需要 tabIndex={-1}） */
  ref: RefObject<HTMLElement | null>;
  /** 浮层是否开着。false 时整套不生效，也不占模态层栈 */
  active: boolean;
  /**
   * Esc 的处理。不传表示本层**故意**不能用 Esc 关（例如会话门、
   * 交付打包进行中）——此时 Esc 原样放行，不假装接管。
   */
  onEscape?: () => void;
  /**
   * 开屏取焦目标。不传则取层内第一个可聚焦元素，再退到层本身。
   * 破坏性确认框要显式指向「取消」——默认动作永远是不删。
   */
  initialFocus?: RefObject<HTMLElement | null>;
}

/**
 * 把一个浮层接成**真**模态：开屏取焦、Tab 圈在层内、关闭还原焦点到触发者、
 * 嵌套时只有最上层收键。
 *
 * 三条实测教训写在这里，免得下次又被绕过去：
 *
 * ① **关闭必须还原焦点**。焦点跟着被卸载的按钮一起消失后落到 `body`，
 *    键盘流整条断掉：方向键、Esc、快捷键全部没反应，而屏上没有任何迹象
 *    说明为什么。用户只会说「按键按了没反应」。
 * ② **只在 Tab 上把焦点拉回层内**，不挂 `focusin` 看门狗。`controls.tsx`
 *    的 Select 把 listbox `createPortal` 到 body 下——那是层外的 DOM，
 *    看门狗会在它打开的瞬间把焦点抢回对话框，下拉当场废掉。
 * ③ **监听挂在 document 冒泡阶段**，与各浮层原有的 Esc 监听同相位。
 *    捕获阶段会抢在层内控件之前拿到 Esc，于是「关下拉」变成「关对话框」。
 */
export function useModalFocus({
  ref,
  active,
  onEscape,
  initialFocus,
}: ModalFocusOptions): void {
  /*
   * 回调与取焦目标走 ref 转交：直接进 effect 依赖的话，父组件每渲染一次
   * 就重跑一遍「出栈 → 还原焦点 → 入栈 → 取焦」，用户刚 Tab 到第三个按钮
   * 就被扯回第一个，且完全看不出为什么。
   */
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  const initialRef = useRef(initialFocus);
  initialRef.current = initialFocus;

  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;

    // 触发者：关闭后焦点要还回去。此刻取，因为下一步就要把焦点搬进层里
    const trigger = document.activeElement;

    modalLayers.push(node);

    const target = initialRef.current?.current ?? focusablesIn(node)[0] ?? node;
    target.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      // 被别的模态盖住时闭嘴：键盘归最上层那一个
      if (!isTopModalLayer(node)) return;
      if (event.key === "Escape") {
        const handler = escapeRef.current;
        if (!handler) return;
        event.preventDefault();
        handler();
        return;
      }
      if (trapTabFocus(node, event)) event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const at = modalLayers.lastIndexOf(node);
      if (at >= 0) modalLayers.splice(at, 1);

      /*
       * `body` 不算触发者。层弹出前焦点就已经在 body 上（例如会话门先把
       * 半个应用设成 inert，浏览器顺手把焦点踢到了 body），此时"还原"回
       * body 等于什么都没做，还会把别人刚摆好的焦点覆盖掉——SessionGuard
       * 的 inert effect 就是在它自己的 cleanup 里把焦点放回去的。
       */
      if (
        trigger instanceof HTMLElement &&
        trigger !== document.body &&
        document.contains(trigger)
      ) {
        trigger.focus();
        return;
      }
      /*
       * 触发者已经随着这次关闭一起消失了（例如确认框是从一个"点完就没了"的
       * 按钮上开出来的）。此时下面还压着别的模态就把焦点交给它——不这么做
       * 焦点会掉到 body，外层对话框看着还在，键盘却已经不认它了。
       */
      const below = topModalLayer();
      if (below && document.contains(below)) {
        (focusablesIn(below)[0] ?? below).focus();
      }
    };
  }, [active, ref]);
}
