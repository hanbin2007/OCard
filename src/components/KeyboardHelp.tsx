/**
 * 全局快捷键速查(评审 3.8/#26):键盘流是本应用的核心卖点,
 * 可发现性不能全靠碰运气看到屏内小 kbd 标记。任意屏按 `?` 呼出。
 * 输入框里打 "?" 不触发;Esc 或点背板关闭。
 */

import { useEffect, useState } from "react";
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
      ["U", "取消标删"],
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
      ["Esc", "退回网格"],
    ],
  },
  {
    title: "全屏预览",
    rows: [
      ["← →", "上一张 / 下一张"],
      ["1–9 · P · O · D", "直接打标当前张,操作后自动看下一张"],
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "?" && !isEditable(e.target)) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div className="overlay" onClick={() => setOpen(false)}>
      <div
        className="dialog dialog--wide"
        role="dialog"
        aria-modal="true"
        aria-label="快捷键速查"
        data-testid="keyboard-help"
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
