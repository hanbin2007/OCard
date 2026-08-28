/**
 * 全局快捷键速查(评审 3.8/#26):键盘流是本应用的核心卖点,
 * 可发现性不能全靠碰运气看到屏内小 kbd 标记。任意屏按 `?` 呼出。
 * 输入框里打 "?" 不触发;Esc 或点背板关闭。
 *
 * 两条来自实测的硬要求:
 * ① **层级**:本层用 `.overlay--keyhelp`(z=65)而不是普通 `.overlay`(50)。
 *    普通层会被连拍组全屏层(55)和大图(60)盖住——用户在那两层里按 `?`
 *    看似毫无反应,退出去之后它才突然冒出来。
 * ② **接键优先级**:监听挂在 `window` 的**捕获**阶段。大图在 `document`
 *    捕获阶段接管了几乎所有按键并 stopPropagation;window 捕获比 document
 *    捕获更早,本层因此能在打开期间真正拿到 Esc(否则 Esc 会被底下的大图
 *    吃掉——用户看着速查表按 Esc,关掉的却是它背后那张大图)。
 */

import { useEffect, useRef, useState } from "react";
import { trapTabFocus, useModalFocus } from "../lib/focusTrap";
import { Kbd } from "./ui";

const SECTIONS: Array<{ title: string; rows: Array<[string, string]> }> = [
  {
    title: "选片与交付",
    rows: [
      ["↑ ↓ ← →", "移动光标(触底自动加载更多)"],
      ["空格 / Enter", "预览:普通图直接看大图,连拍组先铺开整组"],
      ["X", "选中/取消选中"],
      ["Shift + 方向", "连选"],
      ["⌘/Ctrl + A", "全选已加载"],
      ["Esc", "清空选区(浮层打开时为退回上一层)"],
      ["1–9", "移入对应分类(预览中作用于当前张)"],
      ["P", "精选(复制进精选/待修)"],
      ["O", "移入「其他」"],
      ["D", "标删/取消标删(开关)"],
      ["U", "只取消标删(没标过就明说,绝不会反手标上)"],
      ["Shift + D", "提交待删清单(进确认)"],
    ],
  },
  {
    // 层级:网格 → 连拍组全屏层 → 大图。Esc 每次只退一层
    title: "连拍组全屏",
    rows: [
      ["↑ ↓ ← →", "在组内移动"],
      ["空格 / Enter", "看光标那张的大图"],
      ["X", "选中/取消选中(⌘A 全组)"],
      ["1–9 · P · O · D", "对组内选中项(或光标项)打标"],
      // 这两条上一轮就已实现,却一直没写进速查表——键位存在但学不到,
      // 等于没有(可发现性也是零静默的一部分)
      ["U", "只取消标删(与 D 分工:D 是开关,U 只撤回)"],
      ["Shift + D", "提交待删清单(不必先退出组层)"],
      ["Esc", "退回网格"],
    ],
  },
  {
    title: "全屏预览",
    rows: [
      ["← →", "上一张 / 下一张"],
      ["1–9 · P · O · D", "直接打标当前张,操作后自动看下一张"],
      ["U", "只取消标删"],
      ["点击大图", "放大 / 还原"],
      ["空格 / Esc", "退一层:从连拍组进来的退回组,否则回网格"],
    ],
  },
  {
    title: "列表(项目 / 回收站)",
    rows: [
      ["↑ ↓", "移动"],
      ["Home / End", "跳到首尾"],
      ["Enter / 空格", "确认(回收站为勾选)"],
    ],
  },
  {
    title: "通用",
    rows: [
      ["?", "打开/关闭本速查"],
      ["Esc", "关闭浮层"],
    ],
  },
];

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}

export function KeyboardHelp() {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "?" && !isEditable(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        setOpen((v) => !v);
        return;
      }
      if (!open) return;
      /*
       * 打开期间本层就是最上面那一层,按键**全部**归它。
       * 不拦的话:Esc 会被底下大图的 document 捕获监听吃掉;
       * 数字键 / P / D 会继续落到背后的网格上——用户对着速查表读文档,
       * 素材却在背后被分类、被标删,而且完全看不见。
       */
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      } else if (trapTabFocus(dialogRef.current, e)) {
        e.preventDefault();
      }
      e.stopPropagation();
    };
    // window 捕获早于 document 捕获:本层因此稳居按键接管链的最前
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [open]);

  /*
   * 开屏取焦 + 关闭还原。
   *
   * 取焦：不收进来的话第一下 Tab 就跑到层背后（本层是 `?` 从任意屏呼出的,
   * 背后随便是什么）。取焦目标显式指向层本身而不是「关闭」按钮——本层是
   * 只读文档,一进来就把焦点押在唯一那个按钮上会误导人以为要按它。
   *
   * 还原：从前关掉速查表后焦点跟着卸载的层一起没了、落到 body,回到网格
   * 方向键与 Esc 全部没反应——「按了没反应」的老账。触发者是按 `?` 那一刻
   * 持有焦点的元素（网格 / 大图 / 组层）,还回去即可。
   *
   * Esc 与 Tab 仍由上面那条 window 捕获监听负责(本层要抢在大图的 document
   * 捕获之前),所以这里不传 onEscape。
   */
  useModalFocus({ ref: dialogRef, active: open, initialFocus: dialogRef });

  if (!open) return null;

  return (
    <div className="overlay overlay--keyhelp" onClick={() => setOpen(false)}>
      <div
        className="dialog dialog--wide"
        role="dialog"
        aria-modal="true"
        aria-label="快捷键速查"
        data-testid="keyboard-help"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="dialog__title">快捷键速查</h2>
        <div className="keyhelp dialog__form">
          {SECTIONS.map((section) => (
            <div className="keyhelp__section" key={section.title}>
              <h3 className="keyhelp__heading">{section.title}</h3>
              {section.rows.map(([keys, desc]) => (
                <div className="keyhelp__row" key={keys}>
                  <span className="keyhelp__keys">
                    <Kbd>{keys}</Kbd>
                  </span>
                  <span className="text-xs">{desc}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="dialog__actions">
          <button
            type="button"
            className="btn"
            data-testid="keyboard-help-close"
            onClick={() => setOpen(false)}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
