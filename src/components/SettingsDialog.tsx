/**
 * 工作站设置：操作人（DIT 名）+ 本机 NAS 根路径（PRD §6.3 / §5.10）。
 *
 * 这两项是本机私有配置：项目状态里只存相对路径，各工作站路径形式不同不影响互通；
 * 操作人则随每条审计事件落盘，支撑「双岗互相监督」。
 */

import { useEffect, useRef, useState } from "react";
import type { UpdateCheckResult } from "../api/types";
import * as api from "../api";
import { validateWorkstation } from "../lib/validation";
import { useStore } from "../state/store";
import { Field } from "./ui";

/** 检查更新的结果文案；失败一律引导去通知中心看详情，不静默 */
const UPDATE_RESULT_TEXT: Record<UpdateCheckResult, string> = {
  uptodate: "已是最新",
  ready: "更新已就绪，重启生效",
  failed: "更新失败，详见通知",
  "check-failed": "检查失败，详见通知",
  unsupported: "当前安装方式不支持自动更新",
};

export function SettingsDialog() {
  const { state, dispatch } = useStore();
  const { settingsOpen, workstation } = state;

  const [operator, setOperator] = useState("");
  const [nasRoot, setNasRoot] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const operatorRef = useRef<HTMLInputElement>(null);

  const [version, setVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);

  // 每次打开都以当前配置为准重置表单
  useEffect(() => {
    if (!settingsOpen) return;
    setOperator(workstation?.operator ?? "");
    setNasRoot(workstation?.nasRoot ?? "");
    setSubmitted(false);
    setSaveError(null);
    operatorRef.current?.focus();
  }, [settingsOpen, workstation]);

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

  async function checkUpdate() {
    if (checking) return;
    setChecking(true);
    setUpdateResult(null);
    try {
      setUpdateResult(await api.checkForUpdate());
    } catch {
      // 具体原因由后端经 app://notice 推送到通知中心
      setUpdateResult("check-failed");
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    if (!settingsOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") dispatch({ type: "settingsClosed" });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen, dispatch]);

  if (!settingsOpen) return null;

  const { valid, errors } = validateWorkstation({ operator, nasRoot });

  async function save() {
    setSubmitted(true);
    if (!valid || busy) return;
    setBusy(true);
    setSaveError(null);
    try {
      const next = await api.setWorkstationInfo(operator.trim(), nasRoot.trim());
      dispatch({ type: "workstationUpdated", workstation: next });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "保存失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onClick={() => dispatch({ type: "settingsClosed" })}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="dialog__title" id="settings-title">
          工作站设置
        </h2>
        <p className="dialog__message">
          仅影响本机。操作人随审计日志留痕，NAS 根路径决定项目落在哪里。
        </p>

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
            hint="项目文件夹的父目录，如 /Volumes/DIT-NAS/Projects 或 Z:\\Projects"
            error={submitted ? errors.nasRoot : undefined}
          >
            <input
              id="settings-nas-root"
              data-testid="settings-nas-root"
              className={`input input--mono${submitted && errors.nasRoot ? " input--invalid" : ""}`}
              type="text"
              value={nasRoot}
              placeholder="/Volumes/DIT-NAS/Projects"
              onChange={(e) => setNasRoot(e.currentTarget.value)}
            />
          </Field>

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
          </div>

          {saveError ? (
            <span className="field__error" role="alert">
              {saveError}
            </span>
          ) : null}

          <div className="dialog__actions">
            <button
              type="button"
              className="btn"
              onClick={() => dispatch({ type: "settingsClosed" })}
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
