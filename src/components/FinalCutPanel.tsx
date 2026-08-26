/** 成片命名校验（工况 A，PRD §5.8）+ 交付状态勾选（PRD §5.7）。 */

import { Checkbox } from "./controls";
import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { useNotify } from "../state/store";
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

  /*
   * 轮询 7s，但后端要对「6. 成片」下每个文件逐个 ffprobe，最长可到 30s。
   * 原来的实现无守卫地按点发车，于是会出现两件事：
   *   ① 请求叠加——一个慢项目能同时压着四五个全量扫描在 NAS 上跑；
   *   ② 后发先至——早发出的旧响应后回来，把新结果覆盖掉，界面显示过期数据。
   * 三道闸门：
   *   in-flight 守卫：上一轮没回来就不发新的（治叠加）；
   *   pending 合并：被挡下的那一拍不丢，等当前这次回来立刻补跑一次
   *                （治「扫描比轮询间隔还慢时白等一整个周期」）；
   *   响应序号：只采纳序号等于「最新一次发车」的返回（治覆盖）。
   * 都放在 effect 内部，projectId 一变自然全部归零，
   * 不会出现「切了项目却被上一个项目的在途请求卡住」。
   */
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let pending = false;
    let issued = 0;

    const load = async () => {
      // 只在可见期轮询：后台标签页不打扰 NAS
      if (cancelled || (typeof document !== "undefined" && document.hidden)) return;
      if (inFlight) {
        // 这一拍不丢，也不叠加：记下来，等当前这次回来立刻补跑一次
        pending = true;
        return;
      }
      inFlight = true;
      const mine = ++issued;
      try {
        const next = await api.checkFinalCuts(projectId);
        if (cancelled || mine !== issued) return;
        setReport(next);
        setError(null);
      } catch (err) {
        if (cancelled || mine !== issued) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlight = false;
        if (pending && !cancelled) {
          pending = false;
          void load();
        }
      }
    };

    void load();
    const timer = setInterval(() => void load(), POLL_MS);
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
                {/* 后端给的是「哪儿不符」的原文，只标个红角标等于把它扔了 */}
                {item.resolutionMismatch ? (
                  <span className="text-2xs dim" data-testid="final-cut-mismatch">
                    {item.resolutionMismatch}
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
  const notify = useNotify();
  const [status, setStatus] = useState<DeliveryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  /** 轮询读取失败:留在字段旁(解释勾选为何不可用);写失败走 toast */
  const [error, setError] = useState<string | null>(null);

  /*
   * 轮询与勾选写的是同一个 status，竞态是真会咬人的：
   * 轮询在 T0 发出 get，用户在 T1 勾了 set，set 先回来把界面点亮，
   * 随后 T0 那个「还是未勾选」的旧响应回来，勾又自己跳回去了。
   *
   * 所以序号必须由**轮询和勾选共用**：谁后发车谁号大，只有号最大的
   * 那次返回能写 status。projectId 变化时号自增一次，把在途的全部作废。
   * pollInFlight 只管轮询自己不叠加；勾选另有 busy 守着。
   */
  const issuedRef = useRef(0);
  const pollInFlightRef = useRef(false);
  const pollPendingRef = useRef(false);

  useEffect(() => {
    // 切项目：在途响应一律作废，并放开轮询闸门（否则新项目会被旧请求卡住）
    issuedRef.current += 1;
    pollInFlightRef.current = false;
    pollPendingRef.current = false;
    setStatus(null);
    setError(null);
  }, [projectId]);

  // 可见期轮询：别台工作站可能也在勾这个状态，页面不可见时不打 NAS
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) return;
      if (pollInFlightRef.current) {
        // 这一拍不丢也不叠加：当前这次回来后立刻补跑
        pollPendingRef.current = true;
        return;
      }
      pollInFlightRef.current = true;
      const mine = ++issuedRef.current;
      try {
        const value = await api.getDeliveryStatus(projectId);
        if (cancelled || mine !== issuedRef.current) return;
        setStatus(value);
        setError(null);
      } catch (err) {
        if (cancelled || mine !== issuedRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        pollInFlightRef.current = false;
        if (pollPendingRef.current && !cancelled) {
          pollPendingRef.current = false;
          void load();
        }
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
    // 与轮询共用同一个号：勾选晚于在途的 get，那个 get 的返回就不该再落地
    const mine = ++issuedRef.current;
    try {
      const value = await api.setDeliveryStatus(projectId, next);
      if (mine !== issuedRef.current) return;
      setStatus(value);
    } catch (err) {
      if (mine !== issuedRef.current) return;
      // 提交后失败统一走 toast(UX 波三)
      notify(
        "error",
        "delivery-status-save-failed",
        `交付状态没有保存成功：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack stack--sm" data-testid="delivery-status">
      <Checkbox
        testId="delivery-uploaded"
        checked={status?.uploaded ?? false}
        disabled={busy || status === null}
        onChange={(next) => void toggle(next)}
      >
        已上传网盘（人工完成，OCard 只记录状态）
      </Checkbox>
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
