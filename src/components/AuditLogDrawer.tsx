/**
 * 审计日志抽屉（PRD §5.10）。
 *
 * 从项目详情右侧滑出，只读地呈现该项目的全量业务事件（拷卡/分类/交付/转码）。
 * 它的用途是事后对账与双岗互相监督，因此有三条不可让步的规矩：
 *
 *   ① **不许丢记录**。不认识的 kind、缺明细的 data、损坏的行，一律照常显示，
 *      只是显示得少一点；渲染逻辑全部走 `lib/audit.ts` 的防御性归一。
 *   ② **不许静默失败**。读取失败就把后端原文摆出来并给重试，不做空态假装无事。
 *   ③ **过滤要所见即所得**。每个 chip 带计数，抬头写清"显示 M / 共 N 条"，
 *      不会出现"筛掉了却看不出被筛掉"的情况。
 *
 * 动效与浮层规矩沿用既有体系：进场 CSS 关键帧（右侧滑入），退场走视图过渡，
 * 减少动效时两头都自动降为瞬时。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import {
  AUDIT_GROUP_FILTERS,
  auditGroupCounts,
  matchesAuditFilter,
  toAuditRows,
  type AuditGroupFilter,
  type AuditRow,
} from "../lib/audit";
import { withViewTransition } from "../lib/motion";
import { useStore } from "../state/store";
import { IconClose } from "./Icon";
import { Badge, EmptyState } from "./ui";

/** 抽屉里可获得焦点的元素——焦点圈按这个集合首尾相接 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function AuditItem({ row, remote }: { row: AuditRow; remote: boolean }) {
  return (
    <li
      className="audit-item"
      data-testid="audit-item"
      data-kind={row.kind || undefined}
      data-tone={row.meta.tone}
      data-group={row.meta.group}
      data-abnormal={row.meta.abnormal || undefined}
    >
      {/* 时间等宽：一列时间上下对齐才扫得动，datetime 留原始时间戳的真值 */}
      <time
        className="audit-item__time"
        dateTime={row.ts || undefined}
        title={row.ts || undefined}
        data-testid="audit-time"
      >
        {row.time}
      </time>

      <div className="audit-item__body">
        <div className="audit-item__head">
          {/* 未收录的 kind 用等宽显示原始值——一眼能看出"这是机器名不是人话" */}
          <Badge tone={row.meta.tone} mono={!row.meta.known}>
            {row.meta.label}
          </Badge>
          <span
            className="audit-item__who truncate"
            title={`${row.operator}@${row.machine}`}
            data-testid="audit-who"
          >
            {row.operator}
            <span className="audit-item__at">@</span>
            {row.machine}
          </span>
          {remote ? (
            <span
              className="audit-item__remote"
              title="这条事件由其他工作站产生"
              data-testid="audit-remote"
            >
              他机
            </span>
          ) : null}
        </div>

        {row.details.length > 0 ? (
          <p
            className="audit-item__detail truncate"
            title={row.detailText}
            data-testid="audit-detail"
          >
            {row.details.map((detail, index) => (
              <span className="audit-item__part" key={`${detail.label ?? ""}-${index}`}>
                {detail.label ? (
                  <span className="audit-item__part-key">{detail.label}</span>
                ) : null}
                <span className="audit-item__part-val">{detail.value}</span>
              </span>
            ))}
          </p>
        ) : (
          /* data 为空或全是读不出的结构：明说没有明细，不留一片空白让人猜 */
          <p className="audit-item__detail audit-item__detail--none" data-testid="audit-detail-none">
            无附加明细
          </p>
        )}
      </div>
    </li>
  );
}

export function AuditLogDrawer({
  projectId,
  projectName,
  onClose,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
}) {
  const { state } = useStore();
  const localMachine = state.workstation?.machineId ?? null;

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState<AuditGroupFilter>("all");
  const [abnormalOnly, setAbnormalOnly] = useState(false);
  /** 自增即重取：重试按钮不需要另写一套取数逻辑 */
  const [reloadToken, setReloadToken] = useState(0);

  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  /**
   * 关闭走视图过渡：进场由 CSS 关键帧（右侧滑入）负责，退场在这里淡出，
   * 与 dialog 是同一条路径的正反两向。内核不支持或用户要求减少动效时，
   * 这就是一次普通的同步回调，行为分毫不差。
   */
  const close = useCallback(() => withViewTransition(onClose), [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const events = await api.listAuditLog(projectId);
        if (cancelled) return;
        setRows(toAuditRows(events));
        setError(null);
      } catch (err) {
        if (cancelled) return;
        // 如实展示后端原文：审计日志读不出来本身就是要被看见的事故
        setRows([]);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadToken]);

  /** 打开时焦点进抽屉，关闭时还给触发它的按钮——键盘用户不会掉回页首 */
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && document.contains(previous)) {
        previous.focus();
      }
    };
  }, []);

  /**
   * Esc 关闭 + Tab 焦点圈。
   *
   * 焦点圈是模态的题中之义：抽屉打开时 Tab 不该跑回身后那张已经被遮住的表——
   * 用户会以为焦点丢了。这里按首尾相接处理，Shift+Tab 反向同理。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;

      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);

      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close]);

  const counts = useMemo(() => auditGroupCounts(rows, abnormalOnly), [rows, abnormalOnly]);
  /* 快捷过滤的计数按**当前分组**算：chip 上的数字就是点下去会剩几条，
     不是"全库有几条异常"——后者对着一个已选分组会自相矛盾 */
  const abnormalCount = useMemo(
    () => rows.filter((row) => matchesAuditFilter(row, group, true)).length,
    [rows, group],
  );
  const visible = useMemo(
    () => rows.filter((row) => matchesAuditFilter(row, group, abnormalOnly)),
    [rows, group, abnormalOnly],
  );

  const filtered = visible.length !== rows.length;

  return (
    <div className="overlay overlay--drawer" onClick={close} data-testid="audit-overlay">
      <aside
        className="drawer"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="audit-log-title"
        data-testid="audit-log-drawer"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="drawer__head">
          <div className="drawer__titles">
            <h2 className="dialog__title" id="audit-log-title">
              审计日志
            </h2>
            <span className="card__hint truncate" title={projectName}>
              {projectName}
            </span>
          </div>
          <button
            type="button"
            ref={closeRef}
            className="btn btn--ghost btn--icon btn--sm"
            aria-label="关闭审计日志"
            data-testid="audit-close"
            onClick={close}
          >
            <IconClose />
          </button>
        </header>

        <div className="drawer__filters" role="group" aria-label="审计日志过滤">
          {/* 「其他」组有货才显示 chip(评审 G1):落进 other 的事件不该只能在「全部」里翻 */}
          {[
            ...AUDIT_GROUP_FILTERS,
            ...(counts.other > 0
              ? [{ id: "other" as const, label: "其他" }]
              : []),
          ].map((filter) => (
            <button
              key={filter.id}
              type="button"
              className="chip"
              aria-pressed={group === filter.id}
              data-testid="audit-filter"
              data-group={filter.id}
              onClick={() => setGroup(filter.id)}
            >
              <span>{filter.label}</span>
              <span className="chip__count">{counts[filter.id]}</span>
            </button>
          ))}

          {/* 失败与取消是查日志时最常找的东西，单独给一个开关，与分组是与的关系 */}
          <button
            type="button"
            className="chip chip--abnormal"
            aria-pressed={abnormalOnly}
            data-testid="audit-filter-abnormal"
            onClick={() => setAbnormalOnly((on) => !on)}
          >
            <span>只看失败与取消</span>
            <span className="chip__count">{abnormalCount}</span>
          </button>
        </div>

        <div className="drawer__body" data-testid="audit-log-body">
          {loading ? (
            <p className="text-sm dim" role="status" data-testid="audit-loading">
              正在读取审计日志…
            </p>
          ) : null}

          {error ? (
            <div className="notice notice--danger" role="alert" data-testid="audit-error">
              <strong>读取审计日志失败</strong>
              <span>{error}</span>
              <span>
                <button
                  type="button"
                  className="btn btn--sm"
                  data-testid="audit-retry"
                  onClick={() => setReloadToken((n) => n + 1)}
                >
                  重试
                </button>
              </span>
            </div>
          ) : null}

          {!loading && !error && rows.length === 0 ? (
            <EmptyState>这个项目还没有任何业务事件。</EmptyState>
          ) : null}

          {!loading && !error && rows.length > 0 && visible.length === 0 ? (
            <EmptyState>当前过滤条件下没有事件，换个筛选或选「全部」。</EmptyState>
          ) : null}

          {visible.length > 0 ? (
            <ul className="audit-list" data-testid="audit-list">
              {visible.map((row) => (
                <AuditItem
                  key={row.key}
                  row={row}
                  /* 不知道本机是谁时一律不标他机——宁可不标，也不能标错 */
                  remote={localMachine !== null && row.machine !== localMachine}
                />
              ))}
            </ul>
          ) : null}
        </div>

        <footer className="drawer__foot">
          {/* 过滤永远是所见即所得：被筛掉多少条写在明面上。
              aria-live 让读屏用户按下 chip 后也听得到结果条数，而不是只能自己数 */}
          <span data-testid="audit-count" aria-live="polite">
            {filtered ? `显示 ${visible.length} / 共 ${rows.length} 条` : `共 ${rows.length} 条`}
          </span>
          <span className="dim">最新在前 · 含其他工作站产生的事件</span>
        </footer>
      </aside>
    </div>
  );
}
