/**
 * 破坏性操作的二次确认（PRD §6.4：一切破坏性动作人工二次确认）。
 * 用 alertdialog 语义，Esc 取消，打开时焦点落在「取消」上——
 * 默认动作永远是不删。
 */

import { useCallback, useRef, type ReactNode } from "react";
import { useModalFocus } from "../lib/focusTrap";
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
  const dialogRef = useRef<HTMLDivElement>(null);

  /**
   * 关闭走视图过渡：进场由 CSS 关键帧（缩放 + 淡入）负责，退场由这里淡出。
   * 浮层没有独立的过渡名，因此背景像素在新旧快照里完全一致——
   * 交叉淡入淡出的结果就是"只有对话框在消失"，其余部分肉眼无差别。
   * 内核不支持或用户要求减少动效时，这就是一次普通的同步调用。
   */
  const close = useCallback(() => withViewTransition(onCancel), [onCancel]);

  /**
   * 真模态：Esc 取消、Tab 圈在框内、开屏焦点落「取消」、关闭还原到触发者。
   *
   * 少了圈定的实测后果：确认框开着时 Tab 会走到遮罩背后的控件上——被聚焦
   * 却看不见的按钮按回车照样执行，而 `aria-modal="true"` 一直在**说**这里
   * 是模态。破坏性动作的二次确认尤其不能有这种旁路。
   *
   * 取焦显式指向「取消」（而不是层内第一个可聚焦元素）：message 是 ReactNode，
   * 调用方塞进清单式内容时里面可能出现链接/按钮，默认动作永远得是不删。
   *
   * 嵌套：本框常常开在别的浮层之上（会话门 z=80 → `--elevated` z=90）。
   * 栈顶判定保证此刻只有本框收键，下面那层不会来抢焦点。
   */
  useModalFocus({
    ref: dialogRef,
    active: request !== null,
    onEscape: close,
    initialFocus: cancelRef,
  });

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
        ref={dialogRef}
        tabIndex={-1}
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
