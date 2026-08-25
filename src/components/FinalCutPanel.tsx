/** 成片命名校验（工况 A，PRD §5.8）+ 交付状态勾选（PRD §5.7）。 */

import { useCallback, useEffect, useState } from "react";
import * as api from "../api";
import type { DeliveryStatus, FinalCutReport } from "../api/types";
import { formatTimestamp } from "../lib/format";
import { Badge } from "./ui";

/** 可见期轮询间隔；页面不可见时停 */
const POLL_MS = 7000;
/** 交付状态可见期轮询间隔 */
const STATUS_POLL_MS = 10000;

export function FinalCutPanel({ projectId }: { projectId: string }) {
  const [report, setReport] = useState<FinalCutReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReport(await api.checkFinalCuts(projectId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      // 只在可见期轮询：后台标签页不打扰 NAS
      if (typeof document !== "undefined" && document.hidden) return;
      if (!cancelled) void load();
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    const onVisibility = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  return (
    <div className="card" data-testid="final-cut-panel">
      <div className="card__head">
        <span className="card__title">成片校验</span>
        <span className="card__hint">
          命名规则：时间日期_片名_分辨率_用途_版本
        </span>
      </div>
      <div className="card__body">
        {error ? (
          <span className="field__error" role="alert" data-testid="final-cut-error">
            读取「6. 成片」失败：{error}
          </span>
        ) : null}

        {report ? (
          <div className="stack stack--sm">
            {report.items.map((item) => (
              <div
                className="final-cut__row"
                key={item.fileName}
                data-testid="final-cut-item"
                data-valid={item.valid}
              >
                <span className="mono text-xs truncate" title={item.fileName}>
                  {item.fileName}
                </span>
                <span className="row-inline">
                  {item.resolutionMismatch ? (
                    <Badge tone="danger">分辨率不符</Badge>
                  ) : null}
                  {item.uncheckable ? <Badge tone="neutral">无法校验</Badge> : null}
                  {!item.valid ? <Badge tone="warn">命名不合规</Badge> : null}
                  {item.valid && !item.resolutionMismatch && !item.uncheckable ? (
                    <Badge tone="ok">{item.class ?? "合规"}</Badge>
                  ) : null}
                </span>
                {item.issues.length > 0 ? (
                  <span className="text-2xs dim" data-testid="final-cut-issues">
                    {item.issues.join("；")}
                  </span>
                ) : null}
                {item.uncheckable ? (
                  <span className="text-2xs dim" data-testid="final-cut-uncheckable">
                    {item.uncheckable}
                  </span>
                ) : null}
              </div>
            ))}

            {report.items.length === 0 ? (
              <span className="text-xs dim">「6. 成片」下还没有文件。</span>
            ) : null}

            {report.warnings.length > 0 ? (
              <div className="notice" data-testid="final-cut-warnings">
                {report.warnings.map((w) => (
                  <span key={w} className="text-2xs">
                    {w}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 「已上传网盘」——OCard 不代传，只如实记录人工勾选 */
export function DeliveryStatusToggle({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<DeliveryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 可见期轮询：别台工作站可能也在勾这个状态，页面不可见时不打 NAS
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const value = await api.getDeliveryStatus(projectId);
        if (!cancelled) setStatus(value);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };

    void load();
    const timer = setInterval(() => void load(), STATUS_POLL_MS);
    const onVisibility = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [projectId]);

  async function toggle(next: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.setDeliveryStatus(projectId, next));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack stack--sm" data-testid="delivery-status">
      <label className="row-inline text-sm">
        <input
          type="checkbox"
          data-testid="delivery-uploaded"
          checked={status?.uploaded ?? false}
          disabled={busy || status === null}
          onChange={(e) => void toggle(e.currentTarget.checked)}
        />
        已上传网盘（人工完成，OCard 只记录状态）
      </label>
      {status?.updatedAt ? (
        <span className="text-2xs dim" data-testid="delivery-status-meta">
          {status.updatedBy ?? "未知"} · {formatTimestamp(status.updatedAt)}
        </span>
      ) : null}
      {error ? (
        <span className="field__error" role="alert" data-testid="delivery-status-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
