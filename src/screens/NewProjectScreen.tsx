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

export function NewProjectScreen() {
  const { state, dispatch } = useStore();
  const [isoDate, setIsoDate] = useState(todayIso);
  const [name, setName] = useState("");
  const [scenario, setScenario] = useState<Scenario>("B");
  const [categories, setCategories] = useState<string[]>(DEFAULT_B_CATEGORIES);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);

  const date = toCompactDate(isoDate);
  const input = { name, date, scenario, categories };
  const { valid, errors } = useMemo(
    () => validateNewProject(input),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [name, date, scenario, categories],
  );
  const showErrors = submitted;

  const tree = useMemo(
    () => buildFolderTree(scenario, categories),
    [scenario, categories],
  );
  const folderName = buildProjectFolderName(date, name);
  const nasRoot = state.workstation?.nasRoot ?? "<NAS 根路径>";

  function updateCategory(index: number, value: string) {
    setCategories((prev) => prev.map((c, i) => (i === index ? value : c)));
  }

  function removeCategory(index: number) {
    setCategories((prev) => prev.filter((_, i) => i !== index));
  }

  async function submit() {
    setSubmitted(true);
    if (!valid || busy) return;
    setBusy(true);
    try {
      const project = await api.createProject({
        name: name.trim(),
        date,
        scenario,
        categories: scenario === "B" ? categories.map((c) => c.trim()) : [],
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
        actions={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => dispatch({ type: "navigate", route: "projects" })}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btn--primary btn--pill"
              onClick={submit}
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
                  <span className="card__title">工况</span>
                  <span className="card__hint">决定建夹模板与后续流程</span>
                </div>
                <div className="card__body">
                  <div className="wizard__choices">
                    {(["A", "B"] as Scenario[]).map((value) => (
                      <button
                        key={value}
                        type="button"
                        className="choice"
                        aria-pressed={scenario === value}
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
                        onClick={() => setCategories((prev) => [...prev, ""])}
                      >
                        <IconPlus />
                        添加分类
                      </button>
                    </div>
                  </div>
                  <div className="card__body">
                    <div className="stack stack--sm">
                      {categories.map((category, index) => (
                        <div className="category-row" key={index}>
                          <span className="category-row__index">{index + 2}.</span>
                          <input
                            className={`input${
                              showErrors && errors.categoryAt?.[index]
                                ? " input--invalid"
                                : ""
                            }`}
                            type="text"
                            value={category}
                            placeholder="分类名，如：颁奖"
                            aria-label={`第 ${index + 1} 个分类名`}
                            onChange={(e) => updateCategory(index, e.currentTarget.value)}
                          />
                          <button
                            type="button"
                            className="btn btn--ghost btn--icon"
                            aria-label={`删除第 ${index + 1} 个分类`}
                            onClick={() => removeCategory(index)}
                          >
                            <IconTrash />
                          </button>
                        </div>
                      ))}

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
                    <div className="preview__path">
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
