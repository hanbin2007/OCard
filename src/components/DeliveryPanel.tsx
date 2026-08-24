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

export function DeliveryButton({ projectId }: { projectId: string }) {
  const { dispatch } = useStore();
  const [phase, setPhase] = useState<Phase>("idle");
  const [summary, setSummary] = useState<DeliverySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  async function run() {
    setPhase("working");
    setError(null);
    try {
      const result = await api.buildDelivery(projectId);
      setSummary(result);
      setPhase("done");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setPhase("done");
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
        "已打包过的文件会跳过而不是覆盖。打包完成后，上传网盘与发送链接仍需人工完成。",
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

  const { existing, errors } = classifyFailures(summary.failures);

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
          <div className="list">
            <div className="list__head delivery__head">
              <span>包</span>
              <span>文件数</span>
              <span>容量</span>
            </div>
            {summary.packages.map((pkg) => (
              <div className="list__row delivery__row" key={pkg.name} data-testid="delivery-package">
                <span className="mono text-sm">{pkg.name}</span>
                <span className="mono text-xs dim">{pkg.fileCount}</span>
                <span className="mono text-xs dim">{formatBytes(pkg.bytes)}</span>
              </div>
            ))}
            <div className="list__row delivery__row" data-testid="delivery-total">
              <span className="text-sm">合计</span>
              <span className="mono text-xs">{summary.totalFiles}</span>
              <span className="mono text-xs">{formatBytes(summary.totalBytes)}</span>
            </div>
          </div>

          {/* 重跑跳过：明确说明这是安全策略，不是出错 */}
          {existing.length > 0 ? (
            <div className="notice" data-testid="delivery-existing">
              <strong>{existing.length} 个文件此前已打包，本次跳过</strong>
              <span>
                OCard 绝不覆盖已有交付文件，所以重复打包是安全的。
                若需要重新生成，请先手动移走或改名旧的交付包。
              </span>
            </div>
          ) : null}

          {/* 真失败：界面内直接列出，不只藏在铃铛里 */}
          {errors.length > 0 ? (
            <div className="notice notice--warn" role="alert" data-testid="delivery-errors">
              <strong>{errors.length} 个文件打包失败</strong>
              <div className="delivery__failures">
                {errors.slice(0, 8).map((failure) => (
                  <div className="delivery__failure" key={failure.assetId}>
                    <span className="mono text-2xs truncate" title={failure.assetId}>
                      {failure.assetId}
                    </span>
                    <span className="text-2xs">{failure.message}</span>
                  </div>
                ))}
                {errors.length > 8 ? (
                  <span className="text-2xs dim">其余 {errors.length - 8} 条见通知中心</span>
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
