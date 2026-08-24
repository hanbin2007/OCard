/** 通用小组件：表单字段、进度条、徽标、空态。样式全部走 components.css。 */

import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { ratio as safeRatio } from "../lib/format";

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

  if (decorative) {
    return (
      <div className={className} aria-hidden="true">
        <div className="progress__bar" style={{ width: `${r * 100}%` }} />
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
      <div className="progress__bar" style={{ width: `${r * 100}%` }} />
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
  return (
    <span className={`badge${toneClass}${mono ? " badge--mono" : ""}`}>
      {dot ? <span className="dot" /> : null}
      {children}
    </span>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="list__empty">{children}</div>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
