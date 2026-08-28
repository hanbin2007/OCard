/**
 * 会话守卫（UX 波）：DIT 工作站是多人共用的，审计留痕必须跟得上换人。
 *
 * 规则：
 * - 15 分钟无操作 → 弹「是否继续会话」。点继续就接着干；
 * - 再等 5 分钟没人应答（或点了结束）→ 会话终止；
 * - 会话终止后必须重新确认操作员才能继续用：可以一键沿用上一个人，
 *   但要二次确认——「顺手点掉」的默认路径不能把 A 的操作记到 B 头上。
 *
 * 后台作业（拷卡/转码）不受会话终止影响：数据安全操作不能因为没人看着就中断，
 * 其审计归属在发起时已经落盘。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import { useModalFocus } from "../lib/focusTrap";
import { OPERATOR_NAME_MAX } from "../lib/validation";
import { useNotify, useStore } from "../state/store";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";
import { Field } from "./ui";

/** 闲置多久后询问是否继续会话 */
export const IDLE_PROMPT_MS = 15 * 60_000;
/** 询问弹出后再等多久无应答就终止会话 */
export const PROMPT_GRACE_MS = 5 * 60_000;
/** 闲置检查的步进（活动记录本身是即时的，只有判定是按拍走的） */
export const IDLE_TICK_MS = 10_000;

type Phase = "active" | "prompt" | "ended";

export function SessionGuard() {
  const { state, dispatch } = useStore();
  const notify = useNotify();
  const [phase, setPhase] = useState<Phase>("active");
  const lastActivityRef = useRef(Date.now());
  const promptAtRef = useRef(0);

  const [newOperator, setNewOperator] = useState("");
  const [gateError, setGateError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const workstation = state.workstation;
  // 引导/加载阶段没有会话可言；操作人都没配时轮不到会话守卫出场
  const armed = Boolean(workstation?.operator?.trim() && workstation?.nasRoot?.trim());

  /**
   * 拷卡进行中不算闲置(评审 2.4):拷一张 512G 卡轻松超过 15 分钟,
   * 「守在旁边盯进度」是最正当的使用姿势。数据在动就是有人在干活——
   * 落门只会把最关键的进度挡在 inert 后面。校验阶段同理。
   * 用 ref 供判定定时器读取,避免任务状态变化反复重建定时器。
   */
  const copyActiveRef = useRef(false);
  copyActiveRef.current = state.tasks.some(
    (t) => t.state === "running" || t.state === "verifying",
  );

  // 活动采集：捕获阶段挂在 window 上,任何交互都算“人还在”
  useEffect(() => {
    if (!armed) return;
    const mark = () => {
      lastActivityRef.current = Date.now();
    };
    const events: Array<keyof WindowEventMap> = [
      "pointerdown",
      "pointermove",
      "keydown",
      "wheel",
    ];
    for (const ev of events) window.addEventListener(ev, mark, { capture: true, passive: true });
    return () => {
      for (const ev of events) window.removeEventListener(ev, mark, { capture: true });
    };
  }, [armed]);

  // 守卫上膛的那一刻重置计时:在引导页耗掉的时间不算闲置,
  // 否则配完设置十秒后就弹「还在吗」(codex 评审 P2)
  useEffect(() => {
    if (!armed) return;
    lastActivityRef.current = Date.now();
    setPhase("active");
  }, [armed]);

  // 闲置判定
  useEffect(() => {
    if (!armed || phase === "ended") return;
    const timer = setInterval(() => {
      const now = Date.now();
      // 拷卡/校验进行中:持续视为有人在场,闲置计时不断向前推
      if (copyActiveRef.current) {
        lastActivityRef.current = now;
        return;
      }
      if (phase === "active" && now - lastActivityRef.current >= IDLE_PROMPT_MS) {
        promptAtRef.current = now;
        setPhase("prompt");
      } else if (phase === "prompt" && now - promptAtRef.current >= PROMPT_GRACE_MS) {
        setPhase("ended");
      }
    }, IDLE_TICK_MS);
    return () => clearInterval(timer);
  }, [armed, phase]);

  // 询问弹窗里的实时倒计时:从远处一瞥就知道还剩多久(评审 2.4 附带)
  const [countdownMs, setCountdownMs] = useState(PROMPT_GRACE_MS);
  useEffect(() => {
    if (phase !== "prompt") return;
    setCountdownMs(PROMPT_GRACE_MS);
    const timer = setInterval(() => {
      setCountdownMs(Math.max(0, PROMPT_GRACE_MS - (Date.now() - promptAtRef.current)));
    }, 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const resume = useCallback(() => {
    lastActivityRef.current = Date.now();
    setPhase("active");
    setNewOperator("");
    setGateError(null);
  }, []);

  /**
   * 焦点陷阱:询问/门弹出期间把侧栏、主区与门外浮层设为 inert——否则
   * Tab 一下就能绕过门去操作背后的应用,会话终止后的动作仍会记到上一位
   * 操作人头上(opus 评审 P1)。快捷拷卡浮层挂在 .main 之外,z-index 只
   * 挡鼠标挡不住键盘,必须一并 inert(双路评审 P0:门开着 Tab+Enter
   * 就能以上一位操作人身份写 NAS)。
   */
  const gateUp = phase !== "active";
  useEffect(() => {
    if (!gateUp) return;
    /*
     * 焦点还原为什么写在这里、而不是交给浮层的 useModalFocus：
     * 置 inert 的那一刻浏览器会把 inert 子树里的焦点**踢掉**（落到 body），
     * 而 inert 还在期间任何 focus() 都是空操作。所以"记住是谁"必须在置 inert
     * 之前、"还回去"必须在撤 inert 之后，两头都得由这个 effect 自己夹住。
     * 少了这一步：会话恢复后焦点停在 body，方向键 / Esc / 快捷键全部没反应，
     * 而屏上没有任何迹象说明为什么（本项目的老账：「按键按了没反应」）。
     */
    const before = document.activeElement;
    const blocked = document.querySelectorAll<HTMLElement>(
      ".shell > .sidebar, .shell > .main, .shell > .quick-copy",
    );
    for (const el of blocked) el.setAttribute("inert", "");
    return () => {
      for (const el of blocked) el.removeAttribute("inert");
      if (
        before instanceof HTMLElement &&
        before !== document.body &&
        document.contains(before)
      ) {
        before.focus();
      }
    };
  }, [gateUp]);

  /*
   * 闲置询问与会话门都是**真**模态：Tab 必须圈在里面。
   *
   * inert 挡住了侧栏 / 主区 / 快捷拷卡，但 `.shell` 下还挂着设置对话框与
   * toast——它们不在 inert 名单里，没有圈定时 Tab 照样能走过去。而且
   * `aria-modal="true"` 已经写在这两层上了，不圈定就是在说谎。
   *
   * **故意不接 Esc**：这两层没有"取消"这条出路。闲置询问要么继续要么结束，
   * 会话门必须确认操作人才能过——审计归属不允许被一下 Esc 绕过去。
   *
   * 声明在上面那条 inert effect **之后**：effect 按声明序跑，撤 inert 与
   * 焦点还原必须先于本 hook 的 cleanup 发生。
   */
  const promptRef = useRef<HTMLDivElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  const gateRef = useRef<HTMLDivElement>(null);
  const gateLastRef = useRef<HTMLButtonElement>(null);
  const gateOperatorRef = useRef<HTMLInputElement>(null);
  const lastOperator = workstation?.operator?.trim() ?? "";

  useModalFocus({
    ref: promptRef,
    active: armed && phase === "prompt",
    initialFocus: continueRef,
  });
  useModalFocus({
    ref: gateRef,
    active: armed && phase === "ended",
    // 有上一位操作人就把焦点押在「继续上一位」上，否则押在换人输入框上
    initialFocus: lastOperator ? gateLastRef : gateOperatorRef,
  });

  async function startAs(operator: string) {
    const name = operator.trim();
    if (!name) {
      setGateError("请填写操作人");
      return;
    }
    if (name.length > OPERATOR_NAME_MAX) {
      setGateError(`操作人不超过 ${OPERATOR_NAME_MAX} 个字符`);
      return;
    }
    if (!workstation) {
      // armed 保证到不了这里;真到了也不许无声吞掉(零静默铁律)
      setGateError("工作站配置丢失,请重启应用");
      return;
    }
    if (name === workstation.operator.trim()) {
      // 同一个人:不必写配置,但沿用上一人一律要二次确认——
      // 手打同名不能成为绕过确认的后门(codex 评审 P1)
      setConfirm({
        title: `仍由「${name}」操作？`,
        message: "如果换人了请选「取消」并填写新的操作人——审计日志不能记错人。",
        confirmLabel: `确认是 ${name}`,
        tone: "primary",
        elevated: true,
        onConfirm: resume,
      });
      return;
    }
    if (starting) return;
    setStarting(true);
    setGateError(null);
    try {
      const next = await api.setWorkstationInfo(name, workstation.nasRoot ?? "");
      dispatch({ type: "workstationUpdated", workstation: next });
      resume();
    } catch (err) {
      // 提交后失败走 toast(z=100,压过会话门也看得见);gateError 只留输入校验
      notify(
        "error",
        "settings-save-failed",
        `切换操作人失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setStarting(false);
    }
  }

  if (!armed) return null;

  if (phase === "prompt") {
    return (
      // 与门同层(z=80):闲置询问不能被全屏预览等 z=60 浮层盖住(codex P1)
      <div className="overlay overlay--gate" data-testid="session-idle-dialog">
        <div
          className="dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="session-idle-title"
          aria-describedby="session-idle-message"
          ref={promptRef}
          tabIndex={-1}
        >
          <h2 className="dialog__title" id="session-idle-title">
            还在吗？
          </h2>
          <p className="dialog__message" id="session-idle-message">
            已经 15 分钟没有操作了。继续会话请确认；
            <strong data-testid="session-idle-countdown">
              {Math.floor(countdownMs / 60000)}:
              {String(Math.floor((countdownMs % 60000) / 1000)).padStart(2, "0")}
            </strong>{" "}
            后将自动结束当前会话，之后需要重新确认操作员（后台的拷卡/转码作业不会中断）。
          </p>
          <div className="dialog__actions">
            <button
              type="button"
              data-testid="session-end"
              className="btn"
              onClick={() => setPhase("ended")}
            >
              结束会话
            </button>
            <button
              type="button"
              data-testid="session-continue"
              className="btn btn--primary"
              /* 取焦统一交给 useModalFocus：原生 autoFocus 在提交阶段就把焦点
                 搬走了，会赶在 hook 记住「触发者是谁」之前 */
              ref={continueRef}
              onClick={resume}
            >
              继续会话
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "ended") {
    const last = workstation?.operator?.trim() ?? "";
    return (
      <>
        <div className="overlay overlay--gate" data-testid="session-gate">
          <div
            className="dialog dialog--gate"
            role="dialog"
            aria-modal="true"
            aria-labelledby="session-gate-title"
            ref={gateRef}
            tabIndex={-1}
          >
            <h2 className="dialog__title" id="session-gate-title">
              会话已结束，谁在操作？
            </h2>
            <p className="dialog__message">
              接下来的每一步都会以确认的操作人记入审计日志。
            </p>
            {last ? (
              <button
                type="button"
                data-testid="session-gate-last"
                className="btn session-gate__last"
                ref={gateLastRef}
                onClick={() =>
                  setConfirm({
                    title: `仍由「${last}」操作？`,
                    message:
                      "如果换人了请选「取消」并填写新的操作人——审计日志不能记错人。",
                    confirmLabel: `确认是 ${last}`,
                    tone: "primary",
                    // 门是 z-80,确认框必须抬到门之上,否则根本点不到(opus P0)
                    elevated: true,
                    onConfirm: resume,
                  })
                }
              >
                继续上一位：<strong>{last}</strong>
              </button>
            ) : null}
            <form
              className="dialog__form"
              onSubmit={(e) => {
                e.preventDefault();
                void startAs(newOperator);
              }}
            >
              <Field
                label="换一位操作人"
                htmlFor="session-gate-operator"
                error={gateError ?? undefined}
              >
                <input
                  id="session-gate-operator"
                  data-testid="session-gate-operator"
                  className={`input${gateError ? " input--invalid" : ""}`}
                  type="text"
                  ref={gateOperatorRef}
                  value={newOperator}
                  placeholder="如：李四"
                  onChange={(e) => {
                    setNewOperator(e.currentTarget.value);
                    setGateError(null);
                  }}
                />
              </Field>
              <div className="dialog__actions">
                <button
                  type="submit"
                  data-testid="session-gate-start"
                  className="btn btn--primary"
                  disabled={starting}
                >
                  {starting ? "切换中…" : "以此身份开始"}
                </button>
              </div>
            </form>
          </div>
        </div>
        <ConfirmDialog request={confirm} onCancel={() => setConfirm(null)} />
      </>
    );
  }

  return null;
}
