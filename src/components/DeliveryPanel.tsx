/**
 * 交付打包入口与结果面板（PRD §5.7）。
 *
 * 三段式：确认(说清纳入范围/复制语义/上传仍需人工) → 执行中 → 结果面板。
 * 失败清单在界面内直接可见——不能只丢进铃铛让人自己去翻。
 */

import { useEffect, useState } from "react";
import * as api from "../api";
import type { DeliveryJob, DeliverySummary } from "../api/types";
import { formatBytes } from "../lib/format";
import { classifyFailures, deliveryHeadline } from "../lib/delivery";
import { selectLatestDeliveryJob, useStore } from "../state/store";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";
import { DeliveryStatusToggle } from "./FinalCutPanel";
import { Badge, ProgressBar } from "./ui";

export function DeliveryButton({
  projectId,
  onWorkingChange,
}: {
  projectId: string;
  /** 兼容旧调用点；互斥真相来源已是 store 里的 job 状态 */
  onWorkingChange?: (working: boolean) => void;
}) {
  const { state, dispatch } = useStore();
  const job = selectLatestDeliveryJob(state, projectId);
  const working =
    job !== null && (job.state === "queued" || job.state === "running");

  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  /** 已被用户关掉的终态作业 id：关掉后不再自动弹回来 */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    onWorkingChange?.(working);
  }, [working, onWorkingChange]);

  async function start() {
    setStartError(null);
    setDismissed(null);
    try {
      const snapshot = await api.startDelivery(projectId);
      // 立刻把快照并入，别等第一条事件——否则互斥会有一小段空窗
      dispatch({ type: "jobProgress", job: snapshot });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStartError(message);
      dispatch({
        type: "noticeReceived",
        notice: {
          level: "error",
          code: "delivery-failed",
          message: `交付打包未能启动：${message}`,
          occurredAt: new Date().toISOString(),
        },
      });
    }
  }

  async function cancel() {
    if (!job || cancelling) return;
    setCancelling(true);
    try {
      const snapshot = await api.cancelJob(job.id);
      dispatch({ type: "jobProgress", job: snapshot });
    } catch (err) {
      dispatch({
        type: "noticeReceived",
        notice: {
          level: "warning",
          code: "job-cancel-failed",
          message: `取消交付作业失败：${
            err instanceof Error ? err.message : String(err)
          }`,
          occurredAt: new Date().toISOString(),
        },
      });
    } finally {
      setCancelling(false);
    }
  }

  function requestConfirm() {
    setConfirm({
      title: "开始交付打包？",
      message:
        "将按拍摄时间把「各分类 + 精选/已修 + 其他」复制成半天一个包（待分类与待修不交付），" +
        "不压缩、不改动分类夹里的原件，同时生成交付清单。" +
        "已打包过的文件会跳过而不是覆盖。" +
        "打包期间请勿在任何工作站进行分类操作。" +
        "打包完成后，上传网盘与发送链接仍需人工完成。",
      confirmLabel: "开始打包",
      onConfirm: () => void start(),
    });
  }

  const terminal =
    job !== null &&
    (job.state === "done" || job.state === "failed" || job.state === "cancelled");
  const showResult = terminal && dismissed !== job.id;

  return (
    <>
      <button
        type="button"
        className="btn btn--sm"
        data-testid="delivery-open"
        disabled={working}
        onClick={requestConfirm}
      >
        {working ? "打包中…" : "交付打包"}
      </button>

      <ConfirmDialog request={confirm} onCancel={() => setConfirm(null)} />

      {working && job ? (
        <DeliveryProgress job={job} cancelling={cancelling} onCancel={cancel} />
      ) : null}

      {showResult && job ? (
        <DeliveryResult
          job={job}
          error={startError ?? job.error ?? null}
          onClose={() => setDismissed(job.id)}
        />
      ) : null}

      {startError && !job ? (
        <DeliveryResult
          job={null}
          error={startError}
          onClose={() => setStartError(null)}
        />
      ) : null}
    </>
  );
}

/** 进度视图：当前文件 + done/total + 进度条 + 取消 */
function DeliveryProgress({
  job,
  cancelling,
  onCancel,
}: {
  job: DeliveryJob;
  cancelling: boolean;
  onCancel: () => void;
}) {
  return (
    <div className="overlay">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="交付打包进行中"
        data-testid="delivery-progress"
      >
        <h2 className="dialog__title">正在交付打包</h2>
        <p className="dialog__message">
          {job.state === "queued"
            ? "作业已排队，等待开始…"
            : "正在复制文件，可随时取消；已完成的部分会保留，重跑安全续打。"}
        </p>

        <div className="stack stack--lg dialog__form">
          <div className="stack stack--sm">
            <ProgressBar
              value={job.done}
              total={job.total}
              label="交付打包进度"
              valueText={`${job.done}/${job.total}`}
            />
            <div className="row-inline text-xs dim">
              <span className="mono" data-testid="delivery-progress-count">
                {job.done}/{job.total}
              </span>
              <span className="mono">{formatBytes(job.bytesDone)}</span>
              {job.message ? (
                <span className="mono truncate" data-testid="delivery-progress-file">
                  {job.message}
                </span>
              ) : null}
            </div>
          </div>

          <div className="dialog__actions">
            <button
              type="button"
              className="btn"
              data-testid="delivery-cancel"
              disabled={cancelling}
              onClick={onCancel}
            >
              {cancelling ? "正在取消…" : "取消打包"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DeliveryResult({
  job,
  error,
  onClose,
}: {
  job: DeliveryJob | null;
  error: string | null;
  onClose: () => void;
}) {
  const [revealError, setRevealError] = useState<string | null>(null);
  const summary: DeliverySummary | null = job?.result ?? null;
  const cancelled = job?.state === "cancelled";

  // 取消是终态且 result 为空：按快照计数如实说明已完成量
  if (cancelled) {
    return (
      <div className="overlay" onClick={onClose}>
        <div
          className="dialog dialog--wide"
          role="dialog"
          aria-modal="true"
          aria-label="交付打包已取消"
          data-testid="delivery-result"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 className="dialog__title">交付打包已取消</h2>
          <p className="dialog__message" data-testid="delivery-cancelled">
            已取消，清单按实况已更新，重跑安全续打。
          </p>
          <div className="stack stack--lg dialog__form">
            <div className="notice" data-testid="delivery-cancelled-count">
              <strong>
                已完成 {job.done}/{job.total} 个文件（{formatBytes(job.bytesDone)}）
              </strong>
              <span>
                已复制的部分保留在交付目录里，清单已按实况写入；
                再次打包会跳过这些文件、只补剩下的。
              </span>
            </div>
          </div>
          <div className="dialog__actions">
            <button
              type="button"
              className="btn btn--primary"
              data-testid="delivery-close"
              onClick={onClose}
            >
              完成
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (error || !summary) {
    return (
      <div className="overlay" onClick={onClose}>
        <div
          className="dialog"
          role="alertdialog"
          aria-modal="true"
          aria-label="交付打包失败"
          data-testid="delivery-result"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 className="dialog__title">交付打包失败</h2>
          <p className="dialog__message" role="alert" data-testid="delivery-error">
            {error ?? "未知错误"}
          </p>
          <div className="dialog__actions">
            <button
              type="button"
              className="btn"
              data-testid="delivery-close"
              onClick={onClose}
            >
              关闭
            </button>
            <button
              type="button"
              className="btn btn--primary"
              data-testid="delivery-retry"
              onClick={onClose}
            >
              重试
            </button>
          </div>
        </div>
      </div>
    );
  }

  const { nameCollisions, manifestErrors, errors } = classifyFailures(
    summary.failures,
  );
  const undelivered = [...nameCollisions, ...errors];

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="dialog dialog--wide"
        role="dialog"
        aria-modal="true"
        aria-label="交付打包结果"
        data-testid="delivery-result"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="dialog__title">交付打包完成</h2>
        <p className="dialog__message" data-testid="delivery-headline">
          {deliveryHeadline(summary)}
        </p>

        <div className="stack stack--lg dialog__form">
          <p className="text-2xs dim" data-testid="delivery-package-note">
            包内文件数/容量为该包**当前实况**总量，重跑时包含此前已交付的部分。
          </p>
          <div className="list">
            <div className="list__head delivery__head">
              <span>包</span>
              <span>包内文件数</span>
              <span>包内容量</span>
            </div>
            {summary.packages.map((pkg) => (
              <div className="list__row delivery__row" key={pkg.name} data-testid="delivery-package">
                <span className="mono text-sm">{pkg.name}</span>
                <span className="mono text-xs dim">{pkg.fileCount}</span>
                <span className="mono text-xs dim">{formatBytes(pkg.bytes)}</span>
              </div>
            ))}
            <div className="list__row delivery__row" data-testid="delivery-total">
              <span className="text-sm">本次新交付</span>
              <span className="mono text-xs">{summary.totalFiles}</span>
              <span className="mono text-xs">{formatBytes(summary.totalBytes)}</span>
            </div>
          </div>

          {/* 已交付跳过：hash 校验一致，属于正常结果 */}
          {summary.alreadyDelivered > 0 ? (
            <div className="notice" data-testid="delivery-already">
              <strong>
                {summary.alreadyDelivered} 个文件此前已交付，内容一致，本次跳过
              </strong>
              <span>
                OCard 绝不覆盖已有交付文件，所以重复打包是安全的。
              </span>
            </div>
          ) : null}

          {/* 清单缺失：文件确实交付了，重跑即可补齐 */}
          {manifestErrors.length > 0 ? (
            <div className="notice notice--warn" data-testid="delivery-manifest-errors">
              <strong>{manifestErrors.length} 个文件的清单条目缺失</strong>
              <span>
                文件本身已交付成功，只是没写进清单。重新执行一次打包即可补齐清单，
                不会重复复制文件。
              </span>
            </div>
          ) : null}

          {/* 未交付：界面内直接列出，不只藏在铃铛里 */}
          {undelivered.length > 0 ? (
            <div className="notice notice--danger" role="alert" data-testid="delivery-errors">
              <strong>{undelivered.length} 个文件未交付</strong>
              {nameCollisions.length > 0 ? (
                <span data-testid="delivery-collision-note">
                  其中 {nameCollisions.length} 个是同名但内容不同——
                  包内已有同名文件，OCard 不覆盖，请人工核对后再决定保留哪一份。
                </span>
              ) : null}
              <div className="delivery__failures">
                {undelivered.slice(0, 8).map((failure) => (
                  <div className="delivery__failure" key={failure.assetId}>
                    <span className="mono text-2xs truncate" title={failure.assetId}>
                      {failure.assetId}
                    </span>
                    <span className="text-2xs">
                      {failure.kind === "name-collision" ? "同名不同内容 · " : ""}
                      {failure.message}
                    </span>
                  </div>
                ))}
                {undelivered.length > 8 ? (
                  <span className="text-2xs dim" data-testid="delivery-more-hint">
                    其余 {undelivered.length - 8} 条见交付目录下的「交付总清单.txt」
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="stack stack--sm">
            <span className="field__label">交付目录（含清单）</span>
            <div className="preview__path" data-testid="delivery-path">
              {summary.deliveryPath}
            </div>
            <div className="row-inline">
              <button
                type="button"
                className="btn btn--sm"
                data-testid="delivery-reveal"
                onClick={() => {
                  void api.revealPath(summary.deliveryPath).catch((err) => {
                    setRevealError(
                      err instanceof Error ? err.message : String(err),
                    );
                  });
                }}
              >
                在文件管理器中显示
              </button>
              <Badge tone="warn">上传网盘与发送链接需人工完成</Badge>
            </div>
            {job ? <DeliveryStatusToggle projectId={job.projectId} /> : null}
            {revealError ? (
              <span className="field__error" role="alert" data-testid="delivery-reveal-error">
                无法打开文件管理器：{revealError}
              </span>
            ) : null}
          </div>
        </div>

        <div className="dialog__actions">
          <button
            type="button"
            className="btn btn--primary"
            data-testid="delivery-close"
            onClick={onClose}
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
