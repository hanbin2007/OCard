/**
 * 破坏性操作的二次确认（PRD §6.4：一切破坏性动作人工二次确认）。
 * 用 alertdialog 语义，Esc 取消，打开时焦点落在「取消」上——
 * 默认动作永远是不删。
 */

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { withViewTransition } from "../lib/motion";

export interface ConfirmRequest {
  title: string;
  /** 说清影响范围，例如级联删除多少张卡;可传节点做清单式确认(评审 4.1) */
  message: ReactNode;
  confirmLabel: string;
  /** 可返回 Promise：调用方需要等后端结果再更新本地状态 */
  onConfirm: () => void | Promise<void>;
  /**
   * 确认按钮的语气。默认 "danger"（红色,破坏性动作）；
   * 非破坏性的二次确认（如换人确认）用 "primary"，别拿红色吓唬人。
   */
  tone?: "danger" | "primary";
  /**
   * 需要压过会话门(z-index 80)等高层浮层时置 true——否则确认框会被
   * 盖在门后面点不到(opus 评审 P0)。普通调用不用传。
   */
  elevated?: boolean;
}

export function ConfirmDialog({
  request,
  onCancel,
}: {
  request: ConfirmRequest | null;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  /**
   * 关闭走视图过渡：进场由 CSS 关键帧（缩放 + 淡入）负责，退场由这里淡出。
   * 浮层没有独立的过渡名，因此背景像素在新旧快照里完全一致——
   * 交叉淡入淡出的结果就是"只有对话框在消失"，其余部分肉眼无差别。
   * 内核不支持或用户要求减少动效时，这就是一次普通的同步调用。
   */
  const close = useCallback(() => withViewTransition(onCancel), [onCancel]);

  useEffect(() => {
    if (!request) return;
    cancelRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [request, close]);

  if (!request) return null;

  return (
    <div
      className={`overlay${request.elevated ? " overlay--elevated" : ""}`}
      onClick={close}
    >
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
        <div className="dialog__message" id="confirm-message">
          {request.message}
        </div>
        <div className="dialog__actions">
          <button type="button" className="btn" ref={cancelRef} onClick={close}>
            取消
          </button>
          <button
            type="button"
            className={
              request.tone === "primary" ? "btn btn--primary" : "btn btn--danger-solid"
            }
            onClick={() => {
              void request.onConfirm();
              close();
            }}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
