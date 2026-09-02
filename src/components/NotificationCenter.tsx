/**
 * 通知中心。
 *
 * 硬性原则：任何 fail-open（降级、跳过、兜底）都必须让用户看见。
 * - error：立刻以非侵入横幅呈现，**不自动消失**，必须逐条手动确认；role="alert"
 * - warning / info：同样即时可见，数秒后自动收进铃铛；aria-live="polite"
 * - 同 code 连续重复折叠成一条并计数（×N），不刷屏
 * - 对**未知 code 通用呈现**：后端随时会加新 code，前端不做白名单
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import { IconBell, IconClose } from "./Icon";
import { formatTimestamp } from "../lib/format";
import { withViewTransition } from "../lib/motion";
import type { NoticeLevel } from "../api/types";
import { useStore, type NoticeEntry } from "../state/store";
import { useWindowRole } from "../state/windowBridge";

/** warning / info 在即时呈现区停留多久后自动收进铃铛（error 永不自动收起） */
const AUTO_HIDE_MS = 6000;

/** 已知 code 的中文抬头；未知 code 一律回落到通用抬头 */
export const NOTICE_TITLES: Record<string, string> = {
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
  /* 抬头不许替正文表态:「可格式化」只在整卷时成立,部分拷贝时是反的。
     抬头写死一句会和正文互相打架,让人按抬头行事——所以抬头只说事件,
     能不能格式化交给正文按 sourceFolders 分情况说。 */
  "copy-task-done": "拷卡完成",
  "copy-task-failed": "拷卡失败",
  /* 后端在部分拷贝完成时另发的告警:卡上还有没拷的内容 */
  "copy-partial-scope-done": "部分拷贝完成，请勿格式化",
  /* 「暂停」和「失败」是两件事:前者已拷部分完好、点继续就接着走,后者要人介入。
     0.4.3 现场这条落在通用回落上，用户看到的抬头就是干巴巴一句「发生错误」。 */
  "copy-task-paused": "拷卡已中断，可从断点续传",
  "copy-task-aborted": "拷卡中断",
  /* 写状态文件被别的程序占住(杀毒/索引):这次重试成功了，但它预告下一次可能真断 */
  "fs-write-contention": "写状态文件被占用",
  "fs-write-contention-total": "本次拷卡多次被占用拖慢",
  "material-rename-contention": "素材落位被占用拖慢",
  "auto-proxy-deferred": "自动转代理未派发",
  "stale-temp-swept": "已清理上次的残留临时文件",
  "stale-temp-stuck": "残留临时文件删不掉",
  "diagnostics-dir-fallback": "诊断报告换了存放位置",
  /* 抬头必须自己表态:这是一条 warning,写成「诊断报告已生成」会被一扫而过,
     而它真正要说的是「文件夹没弹出来,得你自己去找」 */
  "diagnostics-reveal-failed": "诊断报告已生成，但没能打开文件夹",
  /* 任务租约:这几条说的都是「别的进程可能/正在写你的清单」,顶着通用的
     「降级提示」会被一扫而过 */
  "task-lease-taken-over": "接管了上次留下的任务租约",
  "task-lease-at-risk": "任务租约心跳异常，已暂停",
  "task-lease-lost": "任务已被别的进程接管，已暂停",
  "task-lease-left-behind": "任务租约没能清掉",
  "task-lease-heartbeat-stuck": "租约心跳线程收尾迟到",
  "task-lease-lost-outside-run": "租约在收尾时被别的进程接管",
  "copy-resume-lease-lock-broken": "租约锁目录异常，需人工清理",
  "copy-resume-lease-held": "任务正被别的进程执行，拒绝续传",
  "copy-resume-already-running": "上一次运行还没退出，本次「继续」未生效",
  "single-instance-refused": "OCard 已在运行",
};

/**
 * 出这些错时，用户第一件该做的事就是把现场发出来。
 * 与其在报文里用文字把人支到「设置 → 关于与更新 → 导出诊断报告」三级菜单，
 * 不如就在出事的这张卡片上放一个按钮——0.4.3 现场那位并不是不知道路，
 * 是当时手忙脚乱。
 */
const DIAGNOSTIC_CODES = new Set([
  "copy-task-paused",
  "copy-task-aborted",
  "copy-task-failed",
  "fs-write-contention",
  "material-rename-contention",
  "auto-proxy-deferred",
  "task-lease-lost",
  "task-lease-at-risk",
  "task-lease-heartbeat-stuck",
  "task-lease-lost-outside-run",
  "task-lease-left-behind",
  "copy-resume-lease-held",
  "copy-resume-lease-lock-broken",
]);

/**
 * 就地导出诊断报告。放在出事的那张卡片上，而不是让用户去翻三级菜单。
 *
 * 三种结果各有各的呈现:成功给路径(得知道去哪儿找才发得出来)、
 * 生成了但文件夹没弹出来、彻底失败给原因。没有一种是「点了没反应」。
 */
function ExportReportButton() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<
    { ok: true; path: string; revealed: boolean } | { ok: false; reason: string } | null
  >(null);

  if (done?.ok) {
    return (
      <p className="toast__message" data-testid="notice-export-done">
        诊断报告已导出：{done.path}
        {done.revealed ? "（文件夹已打开）" : "（文件夹没能自动打开，请按上面的路径找）"}
      </p>
    );
  }
  return (
    <>
      <button
        type="button"
        className="btn btn--sm"
        data-testid="notice-export-report"
        disabled={busy}
        onClick={() => {
          if (busy) return;
          setBusy(true);
          void api
            .exportDiagnostics()
            .then((r) => setDone({ ok: true, ...r }))
            .catch((err: unknown) =>
              setDone({
                ok: false,
                reason: err instanceof Error ? err.message : String(err),
              }),
            )
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "正在导出…" : "导出诊断报告"}
      </button>
      {done && !done.ok ? (
        <p className="toast__message" data-testid="notice-export-error" role="alert">
          导出诊断报告失败：{done.reason}
        </p>
      ) : null}
    </>
  );
}

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
/**
 * 这个窗口里点「查看任务」到底有没有用。
 *
 * 后端的通知广播到**所有** webview，欢迎/项目管理窗口也渲染 toast。而
 * `useGoToTask` 靠 dispatch `navigate: "copy"` 生效——`WelcomeRoot` 按本地
 * `view` 分支渲染、根本不消费 route，按钮点下去什么都不会发生。
 *
 * 判据用窗口角色而不是「store 里有没有这个任务」：两个窗口共用同一个 store，
 * 任务列表在哪边都可能是满的，按任务判会在欢迎窗口里照样渲染出死按钮。
 */
function useCanGoToTask() {
  // 不抛的版本：通知中心是零静默的最后一道出口，不能因为某处渲染它时
  // 没包 Provider 就整个炸掉。拿不到角色 → 不渲染按钮（fail-closed）。
  const role = useWindowRole();
  return useCallback(
    (entry: NoticeEntry) => role === "main" && Boolean(entry.taskId),
    [role],
  );
}

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

function NoticeBanner({
  entry,
  recoverable,
}: {
  entry: NoticeEntry;
  /** 本窗口有没有铃铛可以把它收进去(见 NoticeToasts 的说明) */
  recoverable: boolean;
}) {
  const { dispatch } = useStore();
  const goToTask = useGoToTask();
  const canGoToTask = useCanGoToTask();
  const isError = entry.level === "error";

  useEffect(() => {
    // error 不自动消失：必须由用户逐条确认，避免降级被一晃而过地忽略。
    // 折叠计数增长**不再**重置隐藏计时(评审 6.8):持续故障期间
    // 同一条 warning 会 ×N 不断累积,跟着续命就成了赖着不走的 toast。
    if (isError) return;
    // 「自动收进铃铛」的前提是**这个窗口有铃铛**。欢迎/项目管理窗口没有,
    // 于是 warning 六秒后不是被收纳而是彻底消失、再也找不回来——
    // 那正好是零静默铁律要防的事(消息只存在六秒等于没说)。
    if (!recoverable) return;
    const timer = setTimeout(
      () => dispatch({ type: "noticeToastDismissed", id: entry.id }),
      AUTO_HIDE_MS,
    );
    return () => clearTimeout(timer);
  }, [isError, recoverable, entry.id, dispatch]);

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
          {/* 原始 code 移出最醒目的标题行(评审 E3):对现场 DIT 是纯噪音,
              报障时在铃铛面板里仍能查到 */}
          {entry.count > 1 ? (
            <span className="toast__count">×{entry.count}</span>
          ) : null}
        </div>
        <p className="toast__message">{entry.message}</p>
        {DIAGNOSTIC_CODES.has(entry.code) ? <ExportReportButton /> : null}
        {canGoToTask(entry) ? (
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

/**
 * 即时呈现层：只显示还 live 的通知，最多 3 条，其余进铃铛。
 *
 * `hasBell` 说的是**这个窗口里有没有铃铛**。主窗口的 TopBar 有，所以
 * warning 自动收起后还能翻回来；欢迎/项目管理窗口没有，自动收起等于
 * 消息只存在六秒然后彻底消失——那是静默，不是收纳。没有铃铛时
 * warning 与 error 一样留到用户自己关掉。
 *
 * 默认 `true` 是为了不动主窗口既有行为；缺铃铛的那一侧必须显式传 false。
 */
export function NoticeToasts({ hasBell = true }: { hasBell?: boolean } = {}) {
  const { state } = useStore();
  const live = state.notices.filter((n) => n.live).slice(0, 3);
  if (live.length === 0) return null;
  return (
    <div className="toasts" data-testid="notice-toasts">
      {live.map((entry) => (
        <NoticeBanner key={entry.id} entry={entry} recoverable={hasBell} />
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
  const canGoToTask = useCanGoToTask();
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
            {notices.some((n) => n.level === "error" && !n.read) ? (
              /* 一场故障多条 error 不必逐条点(评审 6.8) */
              <button
                type="button"
                className="btn btn--sm push-right"
                data-testid="notice-ack-all"
                onClick={() => dispatch({ type: "noticesAllAcknowledged" })}
              >
                全部确认
              </button>
            ) : null}
            {notices.length > 0 ? (
              <button
                type="button"
                className={`btn btn--ghost btn--sm${
                  notices.some((n) => n.level === "error" && !n.read)
                    ? ""
                    : " push-right"
                }`}
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
                    {/* toast 只显示最新 3 条 live,error 被「全部确认」一键清掉之后
                        人又得回三级菜单——面板项上也得有这个按钮 */}
                    {DIAGNOSTIC_CODES.has(entry.code) ? <ExportReportButton /> : null}
                    {canGoToTask(entry) ? (
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
