/**
 * 路径输入组：文本框 + 原生「浏览…」按钮（UX 波）。
 * 全 App 所有要填文件系统路径的地方都用它——手打绝对路径只是兜底，
 * 正道是点浏览弹系统对话框选目录。浏览器/测试环境没有原生对话框时
 * 按钮自动隐藏，输入框行为不变。
 */

import { useState } from "react";
import * as api from "../api";
import { useNotify } from "../state/store";
import { isAbsoluteNasRoot } from "../lib/validation";

export function PathField({
  id,
  formId,
  value,
  onChange,
  placeholder,
  pickerTitle,
  disabled = false,
  readOnly = false,
  invalid = false,
  testId,
  ariaLabel,
}: {
  id?: string;
  /**
   * 归属表单的 id。给**渲染在 <form> 之外**却仍属于那张表单的路径框用：
   * 隐式提交（在文本框里按回车 = 点提交按钮）只认表单归属，不认 DOM 嵌套，
   * 所以把框搬出 form 之后必须显式认领，否则回车会静悄悄地什么都不做。
   */
  formId?: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** 原生对话框标题，说清在选什么，如「选择 NAS 根目录」 */
  pickerTitle: string;
  disabled?: boolean;
  readOnly?: boolean;
  invalid?: boolean;
  testId?: string;
  ariaLabel?: string;
}) {
  const [picking, setPicking] = useState(false);
  const notify = useNotify();

  async function browse() {
    if (picking) return;
    setPicking(true);
    try {
      const picked = await api.pickFolder({
        title: pickerTitle,
        // 已填了合法绝对路径时从那里开:改路径通常是挪到隔壁,不是从头翻。
        // 半截手打的相对串不传——部分平台会让对话框整个起不来
        ...(isAbsoluteNasRoot(value) ? { defaultPath: value.trim() } : {}),
      });
      if (picked !== null) onChange(picked);
    } catch (err) {
      // 对话框弹不出来也不能无声——降级提示统一走 toast,改用手填
      notify(
        "warning",
        "folder-picker-failed",
        `「${pickerTitle}」的文件夹选择器打开失败：${err instanceof Error ? err.message : String(err)}。请直接粘贴路径。`,
      );
    } finally {
      setPicking(false);
    }
  }

  return (
    <div className="path-field">
      <div className="path-field__row">
        <input
          id={id}
          {...(formId ? { form: formId } : {})}
          data-testid={testId}
          className={`input input--mono${invalid ? " input--invalid" : ""}`}
          type="text"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={readOnly}
          aria-label={ariaLabel}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
        {api.canPickFolder() && !readOnly ? (
          <button
            type="button"
            className="btn"
            data-testid={testId ? `${testId}-browse` : undefined}
            disabled={disabled || picking}
            onClick={() => void browse()}
          >
            {picking ? "选择中…" : "浏览…"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
