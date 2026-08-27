/**
 * 新人引导（UX 波）：首跑把「操作人 + NAS 根目录」配完，
 * 不再把新用户扔进设置对话框自己找。任何一项缺失都会进入引导
 * （旧版只查 NAS 根,操作人漏配会静默记成「未登记DIT」——那是审计污点）。
 *
 * 单屏两个字段(评审 6.3):总共就两件事,拆成两步向导只是把全貌藏起来、
 * 多出一次点击。配完给出显式去路:首日流程的下一步是登记设备。
 */

import { useState } from "react";
import * as api from "../api";
import { validateWorkstation } from "../lib/validation";
import { useNotify, useStore } from "../state/store";
import { Field } from "./ui";
import { PathField } from "./PathField";

export function OnboardingWizard() {
  const { state, dispatch, reload } = useStore();
  const [operator, setOperator] = useState(state.workstation?.operator ?? "");
  const [nasRoot, setNasRoot] = useState(state.workstation?.nasRoot ?? "");
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const notify = useNotify();

  const { errors } = validateWorkstation({ operator, nasRoot });
  const operatorError = touched ? errors.operator : undefined;
  const nasRootError = touched ? errors.nasRoot : undefined;

  async function finish() {
    setTouched(true);
    if (errors.operator || errors.nasRoot) return;
    if (saving) return;
    setSaving(true);
    try {
      const workstation = await api.setWorkstationInfo(
        operator.trim(),
        nasRoot.trim(),
      );
      dispatch({ type: "workstationUpdated", workstation });
      // 引导链别在这里断掉(评审 B4):告诉新人下一步去哪
      notify(
        "info",
        "onboarding-done",
        "配置完成。首日流程:先到「设备登记」登记相机与存储卡,再「新建项目」;之后插卡即可拷卡。",
      );
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

            <form
              className="stack stack--lg"
              onSubmit={(e) => {
                e.preventDefault();
                void finish();
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

              <Field
                label="项目文件夹建在哪里？"
                htmlFor="onboarding-nas-root"
                /* 说人话(评审 B3):新人要知道的是「选哪个文件夹」,
                   不是「相对路径/挂载形式」这类架构细节 */
                hint="选择团队 NAS 上存放所有项目的文件夹。多台工作站选同一个文件夹，就能看到同样的项目"
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
                  type="submit"
                  data-testid="onboarding-finish"
                  className="btn btn--primary"
                  /* 不做「校验不过就禁用」:禁用按钮 = 无提示的死门,
                     点了由错误文案说清哪里不对 */
                  disabled={saving}
                >
                  {saving ? "保存中…" : "开始使用"}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
