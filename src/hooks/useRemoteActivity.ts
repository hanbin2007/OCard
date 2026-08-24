/**
 * 跨机拷卡活动轮询（规范 §6.3）。
 *
 * SMB 上没有可靠的变更通知，所以只能轮询各机 journal 的合并结果。
 * 这是**提示**不是锁：拿不到数据时不阻断任何操作，只把状态如实说出来。
 */

import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { RemoteActivity } from "../api/types";

export const REMOTE_POLL_MS = 10000;
/** 连续失败到这个次数才提示「暂不可用」——偶发抖动不打扰用户 */
export const REMOTE_FAILURE_THRESHOLD = 3;

export function useRemoteActivity(projectId: string | null) {
  const [activities, setActivities] = useState<RemoteActivity[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const failuresRef = useRef(0);

  useEffect(() => {
    if (!projectId) {
      setActivities([]);
      setUnavailable(false);
      return;
    }

    let cancelled = false;
    failuresRef.current = 0;

    const poll = async () => {
      // 屏幕不活跃时不打扰 NAS
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const list = await api.listRemoteActivity(projectId);
        if (cancelled) return;
        failuresRef.current = 0;
        setUnavailable(false);
        setActivities(list);
      } catch {
        if (cancelled) return;
        // 单次失败静默重试：journal 降级后端已经发过通知了，这里不重复打扰
        failuresRef.current += 1;
        if (failuresRef.current >= REMOTE_FAILURE_THRESHOLD) setUnavailable(true);
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), REMOTE_POLL_MS);

    // 切回前台立刻补一次，别让用户盯着过期数据
    const onVisibility = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [projectId]);

  return { activities, unavailable };
}

/** 远端是否正在拷这张卷（按卷名比对，卷名是 DIT 眼里的「那张卡」） */
export function remoteActivityForVolume(
  activities: RemoteActivity[],
  volumeName: string | undefined,
): RemoteActivity | null {
  if (!volumeName) return null;
  return activities.find((a) => a.volume === volumeName) ?? null;
}
