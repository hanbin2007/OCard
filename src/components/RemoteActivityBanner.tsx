/** 跨机拷卡活动横幅：看见对方正在拷哪张卡，避免重复拷（规范 §6.3）。 */

import { useState } from "react";
import type { RemoteActivity } from "../api/types";
import { formatTimestamp } from "../lib/format";

export function RemoteActivityBanner({
  activities,
  unavailable,
}: {
  activities: RemoteActivity[];
  unavailable: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);

  if (unavailable) {
    return (
      <div className="remote-banner remote-banner--muted" data-testid="remote-activity-unavailable">
        <span className="text-xs">
          跨机状态暂不可用——读取其他工作站的记录连续失败，可能是 NAS 不可达。
          这不影响本机拷卡，但暂时看不到对方在拷哪张卡。
        </span>
      </div>
    );
  }

  if (activities.length === 0) return null;

  return (
    <div className="remote-banner" data-testid="remote-activity-banner" role="status">
      <div className="remote-banner__head">
        <span className="dot" />
        <span className="text-xs">
          另有 {activities.length} 台工作站正在本项目作业
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--sm push-right"
          data-testid="remote-activity-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? "展开" : "收起"}
        </button>
      </div>

      {!collapsed ? (
        <div className="remote-banner__list">
          {activities.map((activity) => (
            <div
              className="remote-banner__item"
              key={`${activity.machine}-${activity.targetFolder}`}
              data-testid="remote-activity-item"
              data-volume={activity.volume}
            >
              <span className="text-xs">
                {activity.activity === "transcode" ? (
                  <>
                    ⟳ 另一台工作站（操作人 {activity.operator}）正在转码
                    <span className="mono">「{activity.camera}」</span>
                    {" → 输出 "}
                    <span className="mono">{activity.targetFolder}</span>
                  </>
                ) : (
                  <>
                    另一台工作站（操作人 {activity.operator}）正在拷
                    <span className="mono">「{activity.volume}」</span>
                    {" → 目标夹 "}
                    <span className="mono">{activity.targetFolder}</span>
                  </>
                )}
              </span>
              <span className="text-2xs dim mono">
                {activity.machine} · {formatTimestamp(activity.startedAt)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
