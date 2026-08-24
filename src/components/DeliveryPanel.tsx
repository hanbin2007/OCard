/**
 * 交付打包入口与结果面板（PRD §5.7）。
 *
 * 三段式：确认(说清纳入范围/复制语义/上传仍需人工) → 执行中 → 结果面板。
 * 失败清单在界面内直接可见——不能只丢进铃铛让人自己去翻。
 */

import { useState } from "react";
import * as api from "../api";
import type { DeliverySummary } from "../api/types";
import { formatBytes } from "../lib/format";
import { classifyFailures, deliveryHeadline } from "../lib/delivery";
import { useStore } from "../state/store";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";
import { Badge } from "./ui";

type Phase = "idle" | "working" | "done";

export function DeliveryButton({
  projectId,
  onWorkingChange,
}: {
  projectId: string;
  /** 打包期间通知上层禁用分类操作——同一批文件不能一边打包一边被挪走 */
  onWorkingChange?: (working: boolean) => void;
}) {
  const { dispatch } = useStore();
  const [phase, setPhase] = useState<Phase>("idle");
  const [summary, setSummary] = useState<DeliverySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  async function run() {
    setPhase("working");
    onWorkingChange?.(true);
    setError(null);
    try {
      const result = await api.buildDelivery(projectId);
      setSummary(result);
      setPhase("done");
      onWorkingChange?.(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setPhase("done");
      onWorkingChange?.(false);
      dispatch({
        type: "noticeReceived",
        notice: {
          level: "error",
          code: "delivery-failed",
          message: `交付打包失败：${message}`,
          occurredAt: new Date().toISOString(),
        },
      });
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
      onConfirm: () => void run(),
    });
  }

  return (
    <>
      <button
        type="button"
        className="btn btn--sm"
        data-testid="delivery-open"
        disabled={phase === "working"}
        onClick={requestConfirm}
      >
        {phase === "working" ? "打包中…" : "交付打包"}
      </button>

      <ConfirmDialog request={confirm} onCancel={() => setConfirm(null)} />

      {phase === "done" ? (
        <DeliveryResult
          summary={summary}
          error={error}
          onClose={() => {
            setPhase("idle");
            setSummary(null);
            setError(null);
          }}
        />
      ) : null}
    </>
  );
}

function DeliveryResult({
  summary,
  error,
  onClose,
}: {
  summary: DeliverySummary | null;
  error: string | null;
  onClose: () => void;
}) {
  const [revealError, setRevealError] = useState<string | null>(null);

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
