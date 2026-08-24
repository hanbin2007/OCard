/** 主区顶部极简标题栏：标题 + 次要信息 + 右侧动作。 */

import type { ReactNode } from "react";

export function TopBar({
  title,
  subtitle,
  subtitleMono = false,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  /** 仅路径/编码等技术信息用等宽字体，普通说明文案不要 mono */
  subtitleMono?: boolean;
  actions?: ReactNode;
}) {
  return (
    <div className="topbar">
      <h1 className="topbar__title">{title}</h1>
      {subtitle ? (
        <span className={`topbar__sub${subtitleMono ? " mono" : ""}`}>{subtitle}</span>
      ) : null}
      {actions ? <div className="topbar__actions">{actions}</div> : null}
    </div>
  );
}
