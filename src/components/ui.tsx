/** 通用小组件：表单字段、进度条、徽标、空态。样式全部走 components.css。 */

import type { ReactNode } from "react";
import { ratio as safeRatio } from "../lib/format";

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
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <span className="field__error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="field__hint">{hint}</span>
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
}: {
  value: number;
  total: number;
  tone?: "accent" | "ok" | "muted";
  thin?: boolean;
  label?: string;
}) {
  const r = safeRatio(value, total);
  const toneClass =
    tone === "ok" ? " progress--ok" : tone === "muted" ? " progress--muted" : "";
  return (
    <div
      className={`progress${thin ? " progress--thin" : ""}${toneClass}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(r * 100)}
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
