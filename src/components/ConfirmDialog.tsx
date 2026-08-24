/**
 * 破坏性操作的二次确认（PRD §6.4：一切破坏性动作人工二次确认）。
 * 用 alertdialog 语义，Esc 取消，打开时焦点落在「取消」上——
 * 默认动作永远是不删。
 */

import { useEffect, useRef } from "react";

export interface ConfirmRequest {
  title: string;
  /** 说清影响范围，例如级联删除多少张卡 */
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
}

export function ConfirmDialog({
  request,
  onCancel,
}: {
  request: ConfirmRequest | null;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;
    cancelRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [request, onCancel]);

  if (!request) return null;

  return (
    <div className="overlay" onClick={onCancel}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="dialog__title" id="confirm-title">
          {request.title}
        </h2>
        <p className="dialog__message" id="confirm-message">
          {request.message}
        </p>
        <div className="dialog__actions">
          <button type="button" className="btn" ref={cancelRef} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn btn--danger-solid"
            onClick={() => {
              request.onConfirm();
              onCancel();
            }}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
