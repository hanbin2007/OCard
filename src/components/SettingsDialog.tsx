/**
 * 工作站设置：操作人（DIT 名）+ 本机 NAS 根路径（PRD §6.3 / §5.10）。
 *
 * 这两项是本机私有配置：项目状态里只存相对路径，各工作站路径形式不同不影响互通；
 * 操作人则随每条审计事件落盘，支撑「双岗互相监督」。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FfmpegStatus,
  TranscodeCapabilities,
  UpdateCheckResult,
} from "../api/types";
import * as api from "../api";
import { useModalFocus } from "../lib/focusTrap";
import { withViewTransition } from "../lib/motion";
import { validateWorkstation } from "../lib/validation";
import { useNotify, useStore } from "../state/store";
import { PathField } from "./PathField";
import { Badge, Field } from "./ui";

/** 检查更新的结果文案；失败一律引导去通知中心看详情，不静默 */
const UPDATE_RESULT_TEXT: Record<UpdateCheckResult, string> = {
  uptodate: "已是最新",
  busy: "后台正在检查或下载，请稍候再试",
  // "ready" 现在的含义是「已下载待安装」，不是「重启就会自动装上」
  ready: "已下载，点击安装更新完成安装",
  failed: "更新失败，详见通知",
  "check-failed": "检查失败，详见通知",
  unsupported: "当前安装方式不支持自动更新",
};

export function SettingsDialog() {
  const { state, dispatch, reload } = useStore();
  const notify = useNotify();
  const { settingsOpen, workstation } = state;

  const [operator, setOperator] = useState("");
  const [nasRoot, setNasRoot] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const operatorRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const [version, setVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installed, setInstalled] = useState(false);
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null);
  const [caps, setCaps] = useState<TranscodeCapabilities | null>(null);
  const [probing, setProbing] = useState(false);
  const [diagnostics, setDiagnostics] = useState<string | null>(null);
  /** 「复制诊断信息」的回执:按过要看得出已进剪贴板(评审 #10) */
  const [diagCopied, setDiagCopied] = useState(false);
  /** 误点遮罩不丢输入(评审 #12):有未保存修改时给提示而不是直接关 */
  const [dirtyHint, setDirtyHint] = useState(false);

  /**
   * 关闭走视图过渡：进场由 CSS 关键帧负责（缩放 + 淡入），退场在这里淡出，
   * 两头是同一条路径的正反两向。不支持视图过渡、或用户要求减少动效时，
   * 这就是一次普通的同步 dispatch，行为分毫不差。
   */
  const close = useCallback(
    () => withViewTransition(() => dispatch({ type: "settingsClosed" })),
    [dispatch],
  );

  /**
   * 真模态：Esc 关闭、Tab 圈在框内、开屏焦点落「操作人」、关闭还原到齿轮按钮。
   *
   * 圈定这一步此前是缺的：设置框开着时 Tab 会一路走到底下的侧栏与主区，
   * 焦点停在被遮罩盖住、看不见的按钮上，回车照样把它执行掉。
   * 本框还挂在 `.shell` 下、不在会话门 inert 的范围里，没有圈定时它就是
   * 一条绕过会话门的键盘旁路。
   *
   * Esc 与遮罩点击在这里**故意不同**：遮罩点击有 dirty 拦截（NAS 路径手输
   * 很长，误点一下丢掉很疼），Esc 是明确的「我要关」，照旧直接关。
   *
   * 必须声明在下面那条"重置表单"之前：effect 按声明序跑，本 hook 要在任何
   * 别的 effect 把焦点搬走**之前**把触发者（顶栏齿轮）记下来，否则关闭时
   * 还原的目标会是本框里那个正在被卸载的输入框，焦点照样掉进 body。
   */
  useModalFocus({
    ref: dialogRef,
    active: settingsOpen,
    onEscape: close,
    initialFocus: operatorRef,
  });

  // 每次打开都以当前配置为准重置表单
  useEffect(() => {
    if (!settingsOpen) return;
    setOperator(workstation?.operator ?? "");
    setNasRoot(workstation?.nasRoot ?? "");
    setSubmitted(false);
    operatorRef.current?.focus();
  }, [settingsOpen, workstation]);

  /** 轮询直到 ready / failed——只有这两个是终态，idle 不是 */
  const pollCapabilities = useCallback(async (refresh: boolean) => {
    setProbing(true);
    try {
      let result = await api.transcodeCapabilities(refresh);
      setCaps(result);
      let guard = 0;
      while (result.status === "probing" && guard < 30) {
        guard += 1;
        await new Promise((r) => setTimeout(r, 200));
        result = await api.transcodeCapabilities(false);
        setCaps(result);
      }
    } catch (err) {
      setCaps({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setProbing(false);
    }
  }, []);

  // 打开时取一次 ffmpeg 状态与能力矩阵
  useEffect(() => {
    if (!settingsOpen) return;
    let cancelled = false;
    void (async () => {
      try {
        const status = await api.ffmpegStatus();
        if (!cancelled) setFfmpeg(status);
      } catch (err) {
        if (!cancelled) {
          setFfmpeg({
            status: "missing",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (!cancelled) await pollCapabilities(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [settingsOpen, pollCapabilities]);

  // 打开时取一次版本号
  useEffect(() => {
    if (!settingsOpen) return;
    let cancelled = false;
    setUpdateResult(null);
    void (async () => {
      try {
        const v = await api.getAppVersion();
        if (!cancelled) setVersion(v);
      } catch {
        if (!cancelled) setVersion(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settingsOpen]);

  async function installReadyUpdate() {
    if (installing) return;
    setInstalling(true);
    setInstallError(null);
    try {
      await api.installUpdate();
      // macOS/Linux 不会自动重启（后端另发 update-installed 通知）；
      // Windows 上进程会被安装器结束，看不到这行也无妨
      setInstalled(true);
    } catch (err) {
      // 后端会给中文原因（如「有拷卡任务正在进行」），原样展示
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  }

  /** 「导出」得真的导出(评审 #10):一键进剪贴板;剪贴板不可用退回文本框 */
  async function copyDiagnostics() {
    setDiagCopied(false);
    try {
      const data = await api.transcodeDiagnostics();
      const text = JSON.stringify(data, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        setDiagnostics(null);
        setDiagCopied(true);
        setTimeout(() => setDiagCopied(false), 3000);
      } catch {
        // 剪贴板被策略挡住:退回可全选复制的文本框
        setDiagnostics(text);
      }
    } catch (err) {
      setDiagnostics(
        `读取诊断信息失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function checkUpdate() {
    if (checking) return;
    setChecking(true);
    setUpdateResult(null);
    setInstalled(false);
    setInstallError(null);
    try {
      setUpdateResult(await api.checkForUpdate());
    } catch {
      // 具体原因由后端经 app://notice 推送到通知中心
      setUpdateResult("check-failed");
    } finally {
      setChecking(false);
    }
  }

  if (!settingsOpen) return null;

  // 已下载待安装：本次检查返回 ready，或后端此前推过 update-ready 通知
  const updateReady =
    updateResult === "ready" || state.notices.some((n) => n.code === "update-ready");

  const { valid, errors } = validateWorkstation({ operator, nasRoot });

  async function save() {
    setSubmitted(true);
    if (!valid || busy) return;
    setBusy(true);
    try {
      const previousRoot = state.workstation?.nasRoot?.trim() ?? "";
      const next = await api.setWorkstationInfo(operator.trim(), nasRoot.trim());
      dispatch({ type: "workstationUpdated", workstation: next });
      // 换了 NAS 根(含首次配置):项目/设备/任务列表还指着旧根/为空,
      // 必须整体重拉,否则界面显示旧数据却往新根建夹(静默错位,opus P1)
      if (next.nasRoot.trim() !== previousRoot) {
        reload();
      }
    } catch (err) {
      notify(
        "error",
        "settings-save-failed",
        `保存工作站设置失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  /** 未保存的修改:NAS 路径手输很长,误点遮罩丢一次很疼(评审 #12) */
  const dirty =
    operator !== (workstation?.operator ?? "") ||
    nasRoot !== (workstation?.nasRoot ?? "");

  return (
    <div
      className="overlay"
      onClick={() => {
        if (dirty) {
          setDirtyHint(true);
          return;
        }
        close();
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="dialog__title" id="settings-title">
          工作站设置
        </h2>
        <p className="dialog__message">
          仅影响本机。操作人随审计日志留痕，NAS 根路径决定项目落在哪里。
        </p>
        {dirtyHint && dirty ? (
          <p className="text-xs text-warn" role="alert" data-testid="settings-dirty-hint">
            有未保存的修改——先「保存」，或点「取消」放弃修改。
          </p>
        ) : null}

        <form
          className="stack stack--lg dialog__form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field
            label="操作人（DIT）"
            htmlFor="settings-operator"
            hint="拷卡、校验、删除确认都会记到这个名字下"
            error={submitted ? errors.operator : undefined}
          >
            <input
              id="settings-operator"
              data-testid="settings-operator"
              ref={operatorRef}
              className={`input${submitted && errors.operator ? " input--invalid" : ""}`}
              type="text"
              value={operator}
              placeholder="如：张三"
              onChange={(e) => setOperator(e.currentTarget.value)}
            />
          </Field>

          <Field
            label="NAS 根路径"
            htmlFor="settings-nas-root"
            hint="项目文件夹的父目录，点「浏览」直接选，或粘贴绝对路径"
            error={submitted ? errors.nasRoot : undefined}
          >
            <PathField
              id="settings-nas-root"
              testId="settings-nas-root"
              value={nasRoot}
              onChange={setNasRoot}
              placeholder="/Volumes/DIT-NAS/Projects"
              pickerTitle="选择 NAS 根目录"
              invalid={Boolean(submitted && errors.nasRoot)}
            />
          </Field>

          {/* 高频(换人)与一次性/排障配置分区(评审 6.5):
              转码能力诊断默认收起,换个操作人不必滚过一整屏技术信息。
              更新**不在**折叠里:装没装新版是用户主动来设置里找的事,
              藏进「高级」等于让人猜它在哪(用户点名拿出来)。 */}
          <details className="settings-advanced" data-testid="settings-advanced">
            <summary className="text-sm">高级 · 转码能力诊断</summary>

          <div className="settings-about" data-testid="settings-transcode">
            <div className="settings-about__head">
              <span className="field__label">转码能力</span>
              {ffmpeg?.status === "ready" ? (
                <span className="settings-about__version" data-testid="settings-ffmpeg-ok">
                  ffmpeg {ffmpeg.info.version}
                </span>
              ) : null}
            </div>

            {ffmpeg?.status === "missing" ? (
              <div
                className="notice notice--danger"
                role="alert"
                data-testid="settings-ffmpeg-missing"
              >
                <strong>ffmpeg 组件缺失，转码功能不可用</strong>
                <span>{ffmpeg.error}</span>
              </div>
            ) : null}

            {caps?.status === "ready" && caps.report ? (
              <div className="stack stack--sm" data-testid="settings-caps">
                {/* 一句人话结论(评审 #11):用户关心的是快不快,不是编码器 ID */}
                <p className="text-sm" data-testid="settings-caps-summary">
                  {Object.values(caps.report.winners).some(
                    (enc) => !/^(libx26[45]|x26[45])/.test(enc),
                  )
                    ? "✓ 转码将使用硬件加速，速度较快。"
                    : "仅软件编码可用，转码速度较慢。"}
                </p>
                <div className="list">
                  <div className="list__head caps__head">
                    <span>能力</span>
                    <span>选中编码器</span>
                  </div>
                  {Object.entries(caps.report.winners).map(([cap, encoder]) => (
                    <div className="list__row caps__row" key={cap} data-testid="caps-winner">
                      <span className="mono text-xs">{cap}</span>
                      <span className="mono text-xs">{encoder}</span>
                    </div>
                  ))}
                </div>
                <details>
                  <summary className="text-xs dim">
                    探测明细（{caps.report.probes.length} 项）
                  </summary>
                  <div className="stack stack--sm">
                    {caps.report.probes.map(([cap, encoder, ok]) => (
                      <div className="row-inline text-2xs" key={`${cap}-${encoder}`} data-testid="caps-probe">
                        <span className="mono">{cap}</span>
                        <span className="mono dim">{encoder}</span>
                        <Badge tone={ok ? "ok" : "neutral"}>{ok ? "可用" : "不可用"}</Badge>
                      </div>
                    ))}
                  </div>
                </details>
              </div>
            ) : null}

            {caps?.status === "failed" ? (
              <span className="field__error" role="alert" data-testid="settings-caps-failed">
                能力探测失败：{caps.error}
              </span>
            ) : null}

            <div className="row-inline">
              <button
                type="button"
                className="btn btn--sm"
                data-testid="settings-reprobe"
                disabled={probing || ffmpeg?.status === "missing"}
                onClick={() => void pollCapabilities(true)}
              >
                {probing ? "探测中…" : "重新探测"}
              </button>
              <button
                type="button"
                className="btn btn--sm"
                data-testid="settings-diagnostics"
                onClick={() => void copyDiagnostics()}
              >
                {diagCopied ? "已复制 ✓" : "复制诊断信息"}
              </button>
            </div>

            {diagnostics ? (
              <textarea
                className="textarea mono"
                data-testid="settings-diagnostics-output"
                readOnly
                rows={6}
                value={diagnostics}
              />
            ) : null}
          </div>

          </details>

          <div className="settings-about">
            <div className="settings-about__head">
              <span className="field__label">关于与更新</span>
              <span className="settings-about__version" data-testid="settings-version">
                {version ? `v${version}` : "版本获取中…"}
              </span>
            </div>
            <div className="row-inline">
              <button
                type="button"
                className="btn btn--sm"
                data-testid="settings-check-update"
                disabled={checking}
                onClick={checkUpdate}
              >
                {checking ? "检查中…" : "检查更新"}
              </button>
              {updateReady && !installed ? (
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  data-testid="settings-install-update"
                  disabled={installing}
                  onClick={installReadyUpdate}
                >
                  {installing ? "正在安装…" : "安装更新"}
                </button>
              ) : null}
              {updateResult ? (
                <span
                  className="text-xs muted"
                  data-testid="settings-update-result"
                  role="status"
                >
                  {UPDATE_RESULT_TEXT[updateResult]}
                </span>
              ) : null}
            </div>
            {installed && !installError ? (
              <span
                className="text-xs muted"
                data-testid="settings-install-done"
                role="status"
              >
                已安装，重启应用后生效
              </span>
            ) : null}
            {installError ? (
              <span
                className="field__error"
                data-testid="settings-install-error"
                role="alert"
              >
                {installError}
              </span>
            ) : null}
          </div>

          <div className="dialog__actions">
            <button
              type="button"
              className="btn"
              onClick={close}
            >
              取消
            </button>
            <button
              type="submit"
              data-testid="settings-save"
              className="btn btn--primary"
              disabled={busy}
            >
              {busy ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
