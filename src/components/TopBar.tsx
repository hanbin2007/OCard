/** 主区顶部极简标题栏：标题 + 次要信息 + 右侧动作。 */

import type { ReactNode } from "react";

export function TopBar({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="topbar">
      <h1 className="topbar__title">{title}</h1>
      {subtitle ? <span className="topbar__sub mono">{subtitle}</span> : null}
      {actions ? <div className="topbar__actions">{actions}</div> : null}
    </header>
  );
}
