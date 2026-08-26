/**
 * 新人引导（UX 波）：首跑把「操作人 + NAS 根目录」两件事一步步领着配完，
 * 不再把新用户扔进设置对话框自己找。任何一项缺失都会进入引导
 * （旧版只查 NAS 根,操作人漏配会静默记成「未登记DIT」——那是审计污点）。
 */

import { useState } from "react";
import * as api from "../api";
import { validateWorkstation } from "../lib/validation";
import { useNotify, useStore } from "../state/store";
import { Field } from "./ui";
import { PathField } from "./PathField";

type Step = "operator" | "nasRoot";

export function OnboardingWizard() {
  const { state, dispatch, reload } = useStore();
  const [step, setStep] = useState<Step>(
    state.workstation?.operator?.trim() ? "nasRoot" : "operator",
  );
  const [operator, setOperator] = useState(state.workstation?.operator ?? "");
  const [nasRoot, setNasRoot] = useState(state.workstation?.nasRoot ?? "");
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const notify = useNotify();

  const { errors } = validateWorkstation({ operator, nasRoot });
  const operatorError = touched && step === "operator" ? errors.operator : undefined;
  const nasRootError = touched && step === "nasRoot" ? errors.nasRoot : undefined;

  function next() {
    setTouched(true);
    if (errors.operator) return;
    setTouched(false);
    setStep("nasRoot");
  }

  async function finish() {
    setTouched(true);
    if (errors.operator) {
      // NAS 步骤里发现操作人也没填好（理论上到不了,兜底别静默卡死）
      setStep("operator");
      return;
    }
    if (errors.nasRoot) return;
    if (saving) return;
    setSaving(true);
    try {
      const workstation = await api.setWorkstationInfo(
        operator.trim(),
        nasRoot.trim(),
      );
      dispatch({ type: "workstationUpdated", workstation });
      // bootstrap 是在「没配 NAS」时跑的,列表全是空——配完必须整体重拉,
      // 否则第二台工作站指向已有 NAS 时会看到假的「还没有项目」(opus P1)
      reload();
    } catch (err) {
      notify(
        "error",
        "settings-save-failed",
        `保存初始设置失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="onboarding" data-testid="first-run-guide">
      <div className="card onboarding__card">
        <div className="card__body">
          <div className="stack">
            <div className="onboarding__intro">
              <span className="onboarding__badge">首次设置</span>
              <h2 className="onboarding__title">欢迎使用 OCard</h2>
              <p className="text-sm muted">
                开工前只需要配两件事，都只影响本机，之后随时可以在「设置」里改。
              </p>
            </div>

            <ol className="onboarding__steps" aria-label="设置步骤">
              <li
                className="onboarding__step"
                aria-current={step === "operator" ? "step" : undefined}
                data-done={step !== "operator" || undefined}
              >
                <span className="onboarding__step-index">1</span>
                操作人
              </li>
              <li
                className="onboarding__step"
                aria-current={step === "nasRoot" ? "step" : undefined}
              >
                <span className="onboarding__step-index">2</span>
                NAS 根目录
              </li>
            </ol>

            {step === "operator" ? (
              <form
                className="stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  next();
                }}
              >
                <Field
                  label="谁在操作这台工作站？"
                  htmlFor="onboarding-operator"
                  hint="拷卡、校验、删除等每一步都会以这个名字记入审计日志"
                  error={operatorError}
                >
                  <input
                    id="onboarding-operator"
                    data-testid="onboarding-operator"
                    className={`input${operatorError ? " input--invalid" : ""}`}
                    type="text"
                    autoFocus
                    value={operator}
                    placeholder="如：张三"
                    onChange={(e) => setOperator(e.currentTarget.value)}
                  />
                </Field>
                <div className="onboarding__actions">
                  <button
                    type="submit"
                    data-testid="onboarding-next"
                    className="btn btn--primary"
                  >
                    下一步
                  </button>
                </div>
              </form>
            ) : (
              <form
                className="stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  void finish();
                }}
              >
                <Field
                  label="项目文件夹建在哪里？"
                  htmlFor="onboarding-nas-root"
                  hint="选择 NAS 上存放项目的父目录。项目内部只记相对路径，各工作站挂载形式不同也能打开同一个项目"
                  error={nasRootError}
                >
                  <PathField
                    id="onboarding-nas-root"
                    testId="onboarding-nas-root"
                    value={nasRoot}
                    onChange={setNasRoot}
                    placeholder="/Volumes/DIT-NAS/Projects 或 Z:\Projects"
                    pickerTitle="选择 NAS 根目录"
                    invalid={Boolean(nasRootError)}
                  />
                </Field>
                <div className="onboarding__actions">
                  <button
                    type="button"
                    data-testid="onboarding-back"
                    className="btn"
                    onClick={() => {
                      setTouched(false);
                      setStep("operator");
                    }}
                  >
                    上一步
                  </button>
                  <button
                    type="submit"
                    data-testid="onboarding-finish"
                    className="btn btn--primary"
                    /* 不做「校验不过就禁用」:禁用按钮 = 无提示的死门,
                       点了由 finish() 里的错误文案说清哪里不对 */
                    disabled={saving}
                  >
                    {saving ? "保存中…" : "完成设置"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
