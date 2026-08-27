/**
 * 通知中心。
 *
 * 硬性原则：任何 fail-open（降级、跳过、兜底）都必须让用户看见。
 * - error：立刻以非侵入横幅呈现，**不自动消失**，必须逐条手动确认；role="alert"
 * - warning / info：同样即时可见，数秒后自动收进铃铛；aria-live="polite"
 * - 同 code 连续重复折叠成一条并计数（×N），不刷屏
 * - 对**未知 code 通用呈现**：后端随时会加新 code，前端不做白名单
 */

import { useCallback, useEffect, useRef } from "react";
import { IconBell, IconClose } from "./Icon";
import { formatTimestamp } from "../lib/format";
import { withViewTransition } from "../lib/motion";
import type { NoticeLevel } from "../api/types";
import { useStore, type NoticeEntry } from "../state/store";

/** warning / info 在即时呈现区停留多久后自动收进铃铛（error 永不自动收起） */
const AUTO_HIDE_MS = 6000;

/** 已知 code 的中文抬头；未知 code 一律回落到通用抬头 */
const NOTICE_TITLES: Record<string, string> = {
  "audit-outbox": "审计日志暂存本机",
  "audit-lost": "审计链存在缺口",
  // 后端读审计 journal 时跳过了坏行/坏文件：抽屉里的列表可能不完整，必须说出来
  "audit-log-degraded": "审计日志有损坏行被跳过",
  "registry-journal-degraded": "登记表日志有损坏行被跳过",
  "project-meta-corrupt": "项目元数据损坏被跳过",
  "rebuild-scan-failed": "启动重建扫描降级",
  "rebuild-manifest-unreadable": "部分任务清单不可读",
  "progress-listen-failed": "进度监听未能建立",
  "notice-listen-failed": "通知通道未能建立",
  "notice-replay-failed": "启动通知回放失败",
  "update-ready": "更新已就绪",
  // 前端自造的兜底网 code,语义固定,给个准确抬头
  "unhandled-error": "界面未接住的错误",
  "volumes-refresh-failed": "卷列表刷新失败",
  "volume-inspect-failed": "卡内素材探查失败",
  "copy-files-load-failed": "文件明细加载失败",
  "copy-files-refresh-failed": "文件状态刷新失败",
  // toast 统一波(UX 波三)迁入的提交后失败 code:抬头是 toast 最显眼的一行
  "project-create-failed": "项目没有创建成功",
  "settings-save-failed": "设置没有保存成功",
  "device-register-failed": "登记没有成功",
  "device-delete-failed": "删除登记失败",
  "copy-start-failed": "拷卡没有发起成功",
  "copy-preview-failed": "落盘路径解析失败",
  "transcode-start-failed": "转码没有启动成功",
  "archive-start-failed": "归档转码没有启动成功",
  "trash-empty-partial": "部分文件未能删除",
  "trash-empty-failed": "清空回收站失败",
  "trash-restore-failed": "恢复文件失败",
  "folder-picker-failed": "文件夹选择器不可用",
  "project-cards-load-failed": "用卡清单读取失败",
  "project-cards-save-failed": "用卡清单保存失败",
  "project-cards-pruned": "用卡清单已自动清理",
  "project-cards-updated": "用卡清单已更新",
  "volumes-listen-failed": "插卡检测未能建立",
  "volumes-watch-degraded": "插卡检测降级",
  "quick-copy-draft-dropped": "快捷拷卡预填未完成",
  "analysis-start-failed": "分析没有启动成功",
  "delivery-status-save-failed": "交付状态没有保存成功",
  "reveal-failed": "无法打开文件管理器",
  "card-match-conflict": "卡片匹配存在冲突",
  "job-cancel-too-late": "取消未生效",
  "job-cancel-failed": "取消作业失败",
  "copy-pause-failed": "拷卡暂停/继续失败",
  "delivery-cancelled": "交付打包已取消",
  // 拷卡终态(评审 2.1):全应用最重要的两个事件,必须在任何屏都能听见
  "copy-task-done": "拷卡完成，本卡可格式化",
  "copy-task-failed": "拷卡失败",
};

/** 未知 code 也要有体面的抬头，不能露出空白 */
const FALLBACK_TITLES: Record<NoticeLevel, string> = {
  error: "发生错误",
  warning: "降级提示",
  info: "提示",
};

function noticeTitle(entry: NoticeEntry): string {
  return NOTICE_TITLES[entry.code] ?? FALLBACK_TITLES[entry.level];
}

/** 通知带任务引用时的「查看任务」跳转:切项目→选任务→进拷卡屏 */
function useGoToTask() {
  const { state, dispatch } = useStore();
  return useCallback(
    (entry: NoticeEntry) => {
      if (!entry.taskId) return;
      if (entry.projectId && state.projects.some((p) => p.id === entry.projectId)) {
        dispatch({ type: "selectProject", projectId: entry.projectId });
      }
      dispatch({ type: "selectTask", taskId: entry.taskId });
      dispatch({ type: "navigate", route: "copy" });
      dispatch({ type: "noticesPanelClosed" });
    },
    [state.projects, dispatch],
  );
}

/* ------------------------------------------------------------------ *
 * 即时呈现区（Shell 级，一份）
 * ------------------------------------------------------------------ */

function NoticeBanner({ entry }: { entry: NoticeEntry }) {
  const { dispatch } = useStore();
  const goToTask = useGoToTask();
  const isError = entry.level === "error";

  useEffect(() => {
    // error 不自动消失：必须由用户逐条确认，避免降级被一晃而过地忽略
    if (isError) return;
    const timer = setTimeout(
      () => dispatch({ type: "noticeToastDismissed", id: entry.id }),
      AUTO_HIDE_MS,
    );
    return () => clearTimeout(timer);
  }, [isError, entry.id, entry.count, dispatch]);

  return (
    <div
      className={`toast toast--${entry.level}`}
      data-testid={`notice-toast-${entry.level}`}
      data-code={entry.code}
      {...(isError
        ? { role: "alert" as const }
        : { role: "status" as const, "aria-live": "polite" as const })}
    >
      <span className={`dot toast__dot toast__dot--${entry.level}`} />
      <div className="toast__body">
        <div className="toast__head">
          <strong className="toast__title">{noticeTitle(entry)}</strong>
          <code className="toast__code">{entry.code}</code>
          {entry.count > 1 ? (
            <span className="toast__count">×{entry.count}</span>
          ) : null}
        </div>
        <p className="toast__message">{entry.message}</p>
        {entry.taskId ? (
          <button
            type="button"
            className="btn btn--sm"
            data-testid="notice-toast-goto-task"
            onClick={() => {
              goToTask(entry);
              // 跳过去之后 toast 使命完成:info 收起;error 保留待确认
              if (!isError) dispatch({ type: "noticeToastDismissed", id: entry.id });
            }}
          >
            查看任务
          </button>
        ) : null}
      </div>
      <button
        type="button"
        className="btn btn--ghost btn--icon btn--sm"
        data-testid="notice-toast-ack"
        aria-label={isError ? `确认 ${entry.code}` : "收起提示"}
        onClick={() =>
          dispatch(
            isError
              ? { type: "noticeAcknowledged", id: entry.id }
              : { type: "noticeToastDismissed", id: entry.id },
          )
        }
      >
        <IconClose />
      </button>
    </div>
  );
}

/** 即时呈现层：只显示还 live 的通知，最多 3 条，其余进铃铛 */
export function NoticeToasts() {
  const { state } = useStore();
  const live = state.notices.filter((n) => n.live).slice(0, 3);
  if (live.length === 0) return null;
  return (
    <div className="toasts" data-testid="notice-toasts">
      {live.map((entry) => (
        <NoticeBanner key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 铃铛 + 面板（TopBar 内，常驻所有屏幕）
 * ------------------------------------------------------------------ */

export function NoticeBell() {
  const { state, dispatch } = useStore();
  const goToTask = useGoToTask();
  const { notices, noticesOpen } = state;
  const unread = notices.filter((n) => !n.read).length;
  // 只有尚未确认的 error 才让徽标转红
  const hasError = notices.some((n) => n.level === "error" && !n.read);
  const wrapRef = useRef<HTMLDivElement>(null);

  /* 收起走视图过渡（退场淡出），弹出由 CSS 关键帧从铃铛一侧长出来。
     不支持视图过渡时就是一次普通 dispatch，行为一致。 */
  const closePanel = useCallback(
    () => withViewTransition(() => dispatch({ type: "noticesPanelClosed" })),
    [dispatch],
  );

  // 点外部/Esc 关闭
  useEffect(() => {
    if (!noticesOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) closePanel();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [noticesOpen, closePanel]);

  return (
    <div className="notice-bell" ref={wrapRef}>
      <button
        type="button"
        data-testid="notice-bell"
        className="btn btn--ghost btn--icon"
        aria-label={unread > 0 ? `通知，${unread} 条未读` : "通知"}
        aria-expanded={noticesOpen}
        title="通知"
        onClick={() =>
          noticesOpen ? closePanel() : dispatch({ type: "noticesPanelToggled" })
        }
      >
        <IconBell />
        {unread > 0 ? (
          /* key 让计数变化时角标重新落位一次：降级/失败不允许悄无声息地累积 */
          <span
            key={unread}
            className={`notice-bell__badge${hasError ? " notice-bell__badge--error" : ""}`}
            data-testid="notice-unread"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {noticesOpen ? (
        <div className="notice-panel" data-testid="notice-panel">
          <div className="notice-panel__head">
            <span className="card__title">通知</span>
            {notices.length > 0 ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm push-right"
                data-testid="notice-clear-all"
                onClick={() => dispatch({ type: "noticesCleared" })}
              >
                清除已读
              </button>
            ) : null}
          </div>

          <div className="notice-panel__list">
            {notices.length === 0 ? (
              <p className="list__empty">暂无通知。</p>
            ) : (
              notices.map((entry) => (
                <div
                  className="notice-item"
                  key={entry.id}
                  data-testid="notice-item"
                  data-code={entry.code}
                  data-level={entry.level}
                >
                  <span className={`dot notice-item__dot notice-item__dot--${entry.level}`} />
                  <div className="notice-item__body">
                    <div className="notice-item__head">
                      <strong className="notice-item__title">{noticeTitle(entry)}</strong>
                      {entry.count > 1 ? (
                        <span className="notice-item__count" data-testid="notice-count">
                          ×{entry.count}
                        </span>
                      ) : null}
                      <span className="notice-item__time">
                        {formatTimestamp(entry.lastAt)}
                      </span>
                    </div>
                    <p className="notice-item__message">{entry.message}</p>
                    {entry.taskId ? (
                      <button
                        type="button"
                        className="btn btn--sm"
                        data-testid="notice-goto-task"
                        onClick={() => goToTask(entry)}
                      >
                        查看任务
                      </button>
                    ) : null}
                    <code className="notice-item__code">{entry.code}</code>
                  </div>
                  <div className="notice-item__actions">
                  {entry.level === "error" && !entry.read ? (
                    <button
                      type="button"
                      className="btn btn--sm"
                      data-testid="notice-ack"
                      onClick={() =>
                        dispatch({ type: "noticeAcknowledged", id: entry.id })
                      }
                    >
                      确认
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon btn--sm"
                    data-testid="notice-dismiss"
                    aria-label={`清除通知 ${entry.code}`}
                    /* 未确认的 error 不许直接清掉：必须先确认 */
                    disabled={entry.level === "error" && !entry.read}
                    title={
                      entry.level === "error" && !entry.read ? "先确认" : "清除"
                    }
                    onClick={() => dispatch({ type: "noticeDismissed", id: entry.id })}
                  >
                    <IconClose />
                  </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
