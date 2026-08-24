/** 屏 2：新建项目向导（日期 + 项目名 + 工况；右侧实时预览建夹结果）。 */

import { useMemo, useState } from "react";
import * as api from "../api";
import type { Scenario } from "../api/types";
import { FolderTreeView } from "../components/FolderTreeView";
import { IconPlus, IconTrash } from "../components/Icon";
import { TopBar } from "../components/TopBar";
import { Field } from "../components/ui";
import { buildFolderTree, countFolders, DEFAULT_B_CATEGORIES } from "../lib/folderTree";
import { SCENARIO_DESC, SCENARIO_LABEL } from "../lib/labels";
import { buildProjectFolderName } from "../lib/naming";
import { validateNewProject } from "../lib/validation";
import { useStore } from "../state/store";

const FORM_ID = "new-project-form";

/** `YYYY-MM-DD`（date input）→ `YYYYMMDD` */
export function toCompactDate(isoDate: string): string {
  return isoDate.replace(/-/g, "");
}

function todayIso(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${mm}-${dd}`;
}

interface CategoryDraft {
  id: string;
  value: string;
}

let categorySeq = 0;
function newCategory(value = ""): CategoryDraft {
  categorySeq += 1;
  return { id: `category-${categorySeq}`, value };
}

export function NewProjectScreen() {
  const { state, dispatch } = useStore();
  const [isoDate, setIsoDate] = useState(todayIso);
  const [name, setName] = useState("");
  const [scenario, setScenario] = useState<Scenario>("B");
  // 用稳定 id 作 key：删中间行时按下标复用 DOM 会串焦点、串输入法组字
  const [categories, setCategories] = useState<CategoryDraft[]>(() =>
    DEFAULT_B_CATEGORIES.map((c) => newCategory(c)),
  );
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);

  const date = toCompactDate(isoDate);
  const categoryValues = useMemo(() => categories.map((c) => c.value), [categories]);

  const { valid, errors } = useMemo(
    () => validateNewProject({ name, date, scenario, categories: categoryValues }),
    [name, date, scenario, categoryValues],
  );
  const showErrors = submitted;

  const tree = useMemo(
    () => buildFolderTree(scenario, categoryValues),
    [scenario, categoryValues],
  );
  const folderName = buildProjectFolderName(date, name);
  const nasRoot = state.workstation?.nasRoot ?? "<NAS 根路径>";

  function focusFirstError() {
    // 提交按钮在右上角、错误在左侧表单里，不移动焦点很容易被当成卡死
    const target = errors.date
      ? "project-date"
      : errors.name
        ? "project-name"
        : errors.categoryAt
          ? categories[Number(Object.keys(errors.categoryAt)[0])]?.id
          : undefined;
    if (target) document.getElementById(target)?.focus();
  }

  async function submit() {
    setSubmitted(true);
    if (!valid) {
      focusFirstError();
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const project = await api.createProject({
        name: name.trim(),
        date,
        scenario,
        categories: scenario === "B" ? categoryValues.map((c) => c.trim()) : [],
      });
      dispatch({ type: "projectCreated", project });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar
        title="新建项目"
        subtitle={nasRoot}
        subtitleMono
        actions={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => dispatch({ type: "navigate", route: "projects" })}
            >
              取消
            </button>
            {/* form 属性让顶栏按钮真正提交左侧表单 */}
            <button
              type="submit"
              form={FORM_ID}
              data-testid="np-submit"
              className="btn btn--primary btn--pill"
              disabled={busy}
            >
              {busy ? "创建中…" : "创建项目"}
            </button>
          </>
        }
      />

      <div className="content">
        <div className="content__inner">
          <div className="wizard">
            <form
              id={FORM_ID}
              className="stack stack--lg"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <div className="card">
                <div className="card__head">
                  <span className="card__title">基本信息</span>
                  <span className="card__hint">项目夹按「日期_项目名」落到 NAS</span>
                </div>
                <div className="card__body">
                  <div className="form-grid form-grid--2">
                    <Field
                      label="拍摄日期"
                      htmlFor="project-date"
                      error={showErrors ? errors.date : undefined}
                    >
                      <input
                        id="project-date"
                        data-testid="np-date"
                        className={`input input--mono${showErrors && errors.date ? " input--invalid" : ""}`}
                        type="date"
                        value={isoDate}
                        onChange={(e) => setIsoDate(e.currentTarget.value)}
                      />
                    </Field>

                    <Field
                      label="项目名"
                      htmlFor="project-name"
                      hint="不要带日期前缀，OCard 会自动加"
                      error={showErrors ? errors.name : undefined}
                    >
                      <input
                        id="project-name"
                        data-testid="np-name"
                        className={`input${showErrors && errors.name ? " input--invalid" : ""}`}
                        type="text"
                        value={name}
                        placeholder="如：校运会"
                        onChange={(e) => setName(e.currentTarget.value)}
                      />
                    </Field>
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card__head">
                  <span className="card__title" id="scenario-label">
                    工况
                  </span>
                  <span className="card__hint">决定建夹模板与后续流程</span>
                </div>
                <div className="card__body">
                  {/* 二选一是 radio 语义，不是两个互不相干的开关 */}
                  <div
                    className="wizard__choices"
                    role="radiogroup"
                    aria-labelledby="scenario-label"
                  >
                    {(["A", "B"] as Scenario[]).map((value) => (
                      <button
                        key={value}
                        type="button"
                        data-testid={`np-scenario-${value.toLowerCase()}`}
                        className="choice"
                        role="radio"
                        aria-checked={scenario === value}
                        onClick={() => setScenario(value)}
                      >
                        <span className="choice__title">{SCENARIO_LABEL[value]}</span>
                        <span className="choice__desc">{SCENARIO_DESC[value]}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {scenario === "B" ? (
                <div className="card">
                  <div className="card__head">
                    <span className="card__title">分类</span>
                    <span className="card__hint">
                      待分类 / 精选 / 其他 为固定夹，无需填写
                    </span>
                    <div className="card__actions">
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => setCategories((prev) => [...prev, newCategory()])}
                      >
                        <IconPlus />
                        添加分类
                      </button>
                    </div>
                  </div>
                  <div className="card__body">
                    <div className="stack stack--sm">
                      {categories.map((category, index) => {
                        // 屏幕上的编号 = 建夹后的编号（待分类占 1），读屏器用同一个数字
                        const displayIndex = index + 2;
                        const itemError = showErrors
                          ? errors.categoryAt?.[index]
                          : undefined;
                        return (
                          <div key={category.id}>
                            <div className="category-row">
                              <span className="category-row__index">{displayIndex}.</span>
                              <input
                                id={category.id}
                                data-testid="np-category-input"
                                className={`input${itemError ? " input--invalid" : ""}`}
                                type="text"
                                value={category.value}
                                placeholder="分类名，如：颁奖"
                                aria-label={`第 ${displayIndex} 号分类名`}
                                aria-invalid={itemError ? true : undefined}
                                aria-describedby={
                                  itemError ? `${category.id}-error` : undefined
                                }
                                onChange={(e) => {
                                  const value = e.currentTarget.value;
                                  setCategories((prev) =>
                                    prev.map((c) =>
                                      c.id === category.id ? { ...c, value } : c,
                                    ),
                                  );
                                }}
                              />
                              <button
                                type="button"
                                className="btn btn--ghost btn--icon"
                                aria-label={`删除第 ${displayIndex} 号分类`}
                                onClick={() =>
                                  setCategories((prev) =>
                                    prev.filter((c) => c.id !== category.id),
                                  )
                                }
                              >
                                <IconTrash />
                              </button>
                            </div>
                            {itemError ? (
                              <div className="category-row__error">
                                <span
                                  className="field__error"
                                  id={`${category.id}-error`}
                                  role="alert"
                                >
                                  {itemError}
                                </span>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}

                      {categories.length === 0 ? (
                        <p className="text-sm dim">还没有分类，至少添加一个。</p>
                      ) : null}

                      {showErrors && errors.categories ? (
                        <span className="field__error" role="alert">
                          {errors.categories}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}
            </form>

            <aside className="wizard__preview" aria-label="建夹预览">
              <div className="card">
                <div className="card__head">
                  <span className="card__title">将创建</span>
                  <span className="card__hint">{countFolders(tree)} 个文件夹</span>
                </div>
                <div className="card__body">
                  <div className="stack">
                    <div className="preview__path" title={`${nasRoot}/${folderName}`}>
                      {nasRoot}/{folderName || "YYYYMMDD_项目名"}
                    </div>
                    <FolderTreeView
                      root={folderName || "YYYYMMDD_项目名"}
                      nodes={tree}
                    />
                  </div>
                </div>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </>
  );
}
