/**
 * 自绘表单控件(UX 波二):勾选框与下拉选择。
 * 原生控件的浮层/勾选样式跟不上应用的灰阶设计语言(用户反馈),
 * 这里统一补齐。语义保持:Checkbox 内部仍是真 input(role/checked/键盘
 * 原生成立),Select 走 combobox+listbox ARIA 模式。
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/* ------------------------------------------------------------------ *
 * Checkbox
 * ------------------------------------------------------------------ */

export function Checkbox({
  checked,
  onChange,
  disabled = false,
  testId,
  className,
  ariaLabel,
  children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  testId?: string;
  className?: string;
  /** 无可见文字标签(如表格行首勾选框)时的读屏名 */
  ariaLabel?: string;
  children?: ReactNode;
}) {
  return (
    <label
      className={`checkbox${disabled ? " checkbox--disabled" : ""}${
        className ? ` ${className}` : ""
      }`}
    >
      <span className="checkbox__control">
        {/* 真 input 覆盖整个方块:点击/键盘/读屏全走原生语义 */}
        <input
          type="checkbox"
          data-testid={testId}
          checked={checked}
          disabled={disabled}
          aria-label={ariaLabel}
          onChange={(e) => onChange(e.currentTarget.checked)}
        />
        <span className="checkbox__box" aria-hidden="true">
          <svg viewBox="0 0 10 8" className="checkbox__mark">
            <path
              d="M1 4.2 L3.8 7 L9 1"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </span>
      {children != null ? <span className="checkbox__label">{children}</span> : null}
    </label>
  );
}

/* ------------------------------------------------------------------ *
 * Select
 * ------------------------------------------------------------------ */

export interface SelectOption {
  value: string;
  label: ReactNode;
}

/** 浮层几何:紧贴触发器下方;下方放不下就翻到上方 */
interface PopRect {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

export function Select({
  id,
  value,
  onChange,
  options,
  placeholder = "请选择…",
  disabled = false,
  invalid = false,
  testId,
  ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  testId?: string;
  ariaLabel?: string;
  /** Field 会通过 cloneElement 注入,透传到触发器 */
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<PopRect | null>(null);
  const selectedIndex = options.findIndex((o) => o.value === value);
  const [activeIndex, setActiveIndex] = useState(0);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setRect(null);
    // preventScroll:回焦不许把视口拽回触发器——那正是本波要根治的"滚动跳变"
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const openList = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const below = viewportH - r.bottom - 12;
    const above = r.top - 12;
    // 下方优先;放不下 160px 且上方更宽裕时翻上去
    const flip = below < 160 && above > below;
    // 横向也夹在视口内:触发器贴右缘时浮层不许溢出
    const left = Math.max(
      8,
      Math.min(r.left, window.innerWidth - r.width - 8),
    );
    setRect({
      left,
      width: r.width,
      ...(flip
        ? { bottom: viewportH - r.top + 4, maxHeight: Math.min(280, Math.max(120, above)) }
        : { top: r.bottom + 4, maxHeight: Math.min(280, Math.max(120, below)) }),
    });
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }, [selectedIndex]);

  // 打开后焦点交给 listbox;滚动/缩放会让定位失真,直接收起(与原生行为一致)
  useEffect(() => {
    if (!open) return;
    listRef.current?.focus();
    const onScroll = (e: Event) => {
      // listbox 自身滚动不算
      if (listRef.current && e.target instanceof Node && listRef.current.contains(e.target)) {
        return;
      }
      close(false);
    };
    const onResize = () => close(false);
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || listRef.current?.contains(t)) return;
      close(false);
    };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onResize);
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onResize);
      document.removeEventListener("pointerdown", onPointerDown, {
        capture: true,
      });
    };
  }, [open, close]);

  // options 在开着时缩短(如卷刷新):活动项收敛回界内;清空直接收起,
  // 否则 Enter 落在不存在的项上,列表看着像卡死
  useEffect(() => {
    if (!open) return;
    if (options.length === 0) {
      close(false);
      return;
    }
    setActiveIndex((i) => Math.min(i, options.length - 1));
  }, [open, options.length, close]);

  // 活动项跟随键盘时滚进可视区
  useLayoutEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex]);

  function commit(index: number) {
    const opt = options[index];
    if (!opt) return;
    onChange(opt.value);
    close();
  }

  function onListKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => Math.min(options.length - 1, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        commit(activeIndex);
        break;
      case "Escape":
        e.preventDefault();
        // 不许冒泡:portal 在 body 下,ConfirmDialog/SettingsDialog 的 Escape
        // 监听挂在 document——一次按键不能同时关掉下拉和外层对话框
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
        close();
        break;
      case "Tab":
        close();
        break;
    }
  }

  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        id={id}
        data-testid={testId}
        className={`select select--trigger${invalid || ariaInvalid ? " select--invalid" : ""}`}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        disabled={disabled}
        onClick={() => (open ? close() : openList())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            openList();
          }
        }}
      >
        <span className={`select__value truncate${selected ? "" : " select__value--empty"}`}>
          {selected ? selected.label : placeholder}
        </span>
      </button>
      {open && rect
        ? createPortal(
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              tabIndex={-1}
              aria-label={ariaLabel}
              aria-activedescendant={`${listId}-opt-${activeIndex}`}
              data-testid={testId ? `${testId}-list` : undefined}
              className="select-pop"
              style={{
                left: rect.left,
                width: rect.width,
                top: rect.top,
                bottom: rect.bottom,
                maxHeight: rect.maxHeight,
              }}
              onKeyDown={onListKeyDown}
            >
              {options.map((opt, i) => (
                <li
                  key={opt.value}
                  id={`${listId}-opt-${i}`}
                  role="option"
                  aria-selected={i === selectedIndex}
                  data-active={i === activeIndex ? "true" : undefined}
                  className="select-pop__option"
                  onPointerEnter={() => setActiveIndex(i)}
                  onClick={() => commit(i)}
                >
                  <span className="truncate">{opt.label}</span>
                  {i === selectedIndex ? (
                    <svg viewBox="0 0 10 8" className="select-pop__check" aria-hidden="true">
                      <path
                        d="M1 4.2 L3.8 7 L9 1"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : null}
                </li>
              ))}
            </ul>,
            document.body,
          )
        : null}
    </>
  );
}
