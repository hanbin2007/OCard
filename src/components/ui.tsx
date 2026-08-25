/** 通用小组件：表单字段、进度条、徽标、空态。样式全部走 components.css。 */

import {
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { ratio as safeRatio } from "../lib/format";

/**
 * 「值变了」的一次性提示。
 *
 * 返回一个自增计数：首次挂载是 0（不播动画——一进屏几十个徽标一起弹是噪音），
 * 之后每次入参变化 +1。调用方拿它当 key 强制重挂载，CSS 动画因此能重新起播。
 */
function useChangeCount(value: unknown): number {
  const previous = useRef(value);
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    setCount((n) => n + 1);
  }, [value]);
  return count;
}

/**
 * 表单字段：把 hint/error 通过 aria-describedby 挂到控件上，
 * 出错时同时打 aria-invalid —— 否则读屏用户 Tab 回来只听得到 label，
 * 既不知道有错，也听不到业务提示。
 */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  const hintId = htmlFor && hint && !error ? `${htmlFor}-hint` : undefined;
  const errorId = htmlFor && error ? `${htmlFor}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  const control =
    isValidElement(children) && describedBy !== undefined
      ? cloneElement(children as ReactElement<Record<string, unknown>>, {
          "aria-describedby": describedBy,
          "aria-invalid": error ? true : undefined,
        })
      : children;

  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {control}
      {error ? (
        <span className="field__error" id={errorId} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function ProgressBar({
  value,
  total,
  tone = "accent",
  thin,
  label,
  valueText,
  decorative,
}: {
  value: number;
  total: number;
  tone?: "accent" | "ok" | "muted";
  thin?: boolean;
  label?: string;
  /** 读屏器播报的人话，如「3.2 GB / 7.1 GB，约 2 分」 */
  valueText?: string;
  /** 旁边已有等价文字时设 true，避免读屏器重复播报 */
  decorative?: boolean;
}) {
  const r = safeRatio(value, total);
  const toneClass =
    tone === "ok" ? " progress--ok" : tone === "muted" ? " progress--muted" : "";
  const className = `progress${thin ? " progress--thin" : ""}${toneClass}`;
  /* 走 scaleX 而不是 width：width 每帧重排，拷卡屏几十条进度同时在动时是掉帧来源。
     CSS transition 天生从当前呈现值继续，进度事件密集改目标也不会跳帧。 */
  const fill = { transform: `scaleX(${r})` };

  if (decorative) {
    return (
      <div className={className} aria-hidden="true">
        <div className="progress__bar" style={fill} />
      </div>
    );
  }

  return (
    <div
      className={className}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(r * 100)}
      aria-valuetext={valueText}
      aria-label={label}
    >
      <div className="progress__bar" style={fill} />
    </div>
  );
}

export type BadgeTone = "neutral" | "ok" | "warn" | "danger" | "accent";

export function Badge({
  tone = "neutral",
  mono,
  dot,
  children,
}: {
  tone?: BadgeTone;
  mono?: boolean;
  dot?: boolean;
  children: ReactNode;
}) {
  const toneClass = tone === "neutral" ? "" : ` badge--${tone}`;
  /* 换档（如 运行中 → 已完成）时轻轻落位一次；首次挂载不播。
     key 变化强制重挂载，同一个徽标连续换档也能每次都起播。 */
  const changed = useChangeCount(tone);
  return (
    <span
      key={changed}
      data-pulse={changed || undefined}
      className={`badge${toneClass}${mono ? " badge--mono" : ""}`}
    >
      {dot ? <span className="dot" /> : null}
      {children}
    </span>
  );
}

/**
 * 会变的数字（分类计数、导航计数、待分类余量）。
 *
 * 变化本身就是"你刚那一下生效了"的因果反馈：不给提示的话，用户按完分类键
 * 只能靠肉眼比对全屏找差别。首次挂载不播，只有真的变了才动。
 */
export function PulseValue({
  value,
  className,
}: {
  value: number | string;
  className?: string;
}) {
  const changed = useChangeCount(value);
  const classes = [className, changed ? "pulse-value" : null].filter(Boolean).join(" ");
  return (
    <span key={changed} className={classes || undefined}>
      {value}
    </span>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="list__empty">{children}</div>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
