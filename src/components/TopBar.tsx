/** 主区顶部极简标题栏：标题 + 次要信息 + 右侧动作 + 设置入口。 */

import type { ReactNode } from "react";
import { IconSettings } from "./Icon";
import { NoticeBell } from "./NotificationCenter";
import { useStore } from "../state/store";

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
  const { dispatch } = useStore();

  return (
    <div className="topbar">
      <h1 className="topbar__title">{title}</h1>
      {subtitle ? (
        <span className={`topbar__sub${subtitleMono ? " mono" : ""}`}>{subtitle}</span>
      ) : null}
      <div className="topbar__actions">
        {actions}
        {/* 通知铃铛常驻所有屏幕：降级/失败必须随时看得见 */}
        <NoticeBell />
        {/* 设置入口常驻：首跑没配 NAS 时也要够得着 */}
        <button
          type="button"
          data-testid="settings-open"
          className="btn btn--ghost btn--icon"
          aria-label="工作站设置"
          title="工作站设置"
          onClick={() => dispatch({ type: "settingsOpened" })}
        >
          <IconSettings />
        </button>
      </div>
    </div>
  );
}
