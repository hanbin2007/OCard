/**
 * 新项目引导(欢迎窗口内的完整多步向导,取代旧的「新建项目」单屏):
 *
 *   1. 项目信息  —— 名称/日期/工况/分类(沿用旧向导的表单与建夹预览)
 *   2. 设备登记  —— 相机与存储卡登记(全局登记表,现场缺哪补哪)
 *   3. 用卡清单  —— 本项目计划用卡(x/y 进度的真分母)
 *   4. 备份目的地 —— 预设备份盘路径,拷卡表单据此预填
 *   5. 内容标签  —— 预建标签库(拷卡备注的 Notion 式标签)
 *   6. 确认创建  —— 汇总复核,建夹 + 写清单 + 写项目设置,然后进入主窗口
 *
 * 2–5 步都可跳过:除项目信息外没有必填项,以后都能在对应界面补。
 */

import { useMemo, useRef, useState } from "react";
import * as api from "../api";
import type { ProjectTag, Scenario } from "../api/types";
import { FolderTreeView } from "../components/FolderTreeView";
import { IconPlus, IconTrash } from "../components/Icon";
import { Checkbox, Select } from "../components/controls";
import { PathField } from "../components/PathField";
import { TagChip } from "../components/TagPicker";
import { Field } from "../components/ui";
import { formatBytes } from "../lib/format";
import { buildFolderTree, countFolders, DEFAULT_B_CATEGORIES } from "../lib/folderTree";
import { SCENARIO_DESC, SCENARIO_LABEL } from "../lib/labels";
import { buildCameraCode, buildProjectFolderName } from "../lib/naming";
import {
  findTag,
  nextTagColor,
  normalizeTagName,
  tagNameError,
} from "../lib/tags";
import { validateNewCamera, validateNewProject } from "../lib/validation";
import { useNotify, useStore } from "../state/store";
import { useWindowBridge } from "../state/windowBridge";

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

const GB = 1024 ** 3;
const CAPACITY_OPTIONS = [128, 256, 512, 1024];

const STEPS = [
  { key: "info", label: "项目信息" },
  { key: "devices", label: "设备登记" },
  { key: "cards", label: "用卡清单" },
  { key: "backup", label: "备份目的地" },
  { key: "tags", label: "内容标签" },
  { key: "confirm", label: "确认创建" },
] as const;
type StepKey = (typeof STEPS)[number]["key"];

interface CategoryDraft {
  id: string;
  value: string;
}
let seq = 0;
function newCategory(value = ""): CategoryDraft {
  seq += 1;
  return { id: `npw-category-${seq}`, value };
}
function newBackup(path = ""): { id: string; path: string } {
  seq += 1;
  return { id: `npw-backup-${seq}`, path };
}

export function NewProjectWizard({ onExit }: { onExit: () => void }) {
  const { state, dispatch } = useStore();
  const bridge = useWindowBridge();
  const notify = useNotify();

  const [step, setStep] = useState<StepKey>("info");

  // ---- 第 1 步:项目信息 ----
  const [isoDate, setIsoDate] = useState(todayIso);
  const [name, setName] = useState("");
  const [scenario, setScenario] = useState<Scenario>("B");
  const [categories, setCategories] = useState<CategoryDraft[]>(() =>
    DEFAULT_B_CATEGORIES.map((c) => newCategory(c)),
  );
  const [infoSubmitted, setInfoSubmitted] = useState(false);

  const date = toCompactDate(isoDate);
  const categoryValues = useMemo(() => categories.map((c) => c.value), [categories]);
  const info = useMemo(
    () => validateNewProject({ name, date, scenario, categories: categoryValues }),
    [name, date, scenario, categoryValues],
  );
  const tree = useMemo(
    () => buildFolderTree(scenario, categoryValues),
    [scenario, categoryValues],
  );
  const folderName = buildProjectFolderName(date, name);
  const nasRoot = state.workstation?.nasRoot ?? "<NAS 根路径>";

  // ---- 第 2 步:设备登记(全局登记表,即建即入) ----
  const [camModel, setCamModel] = useState("");
  const [camPosition, setCamPosition] = useState("");
  const [camAlias, setCamAlias] = useState("");
  const [camSubmitted, setCamSubmitted] = useState(false);
  const [camBusy, setCamBusy] = useState(false);
  const camCode = useMemo(
    () => buildCameraCode(camModel, camPosition, camAlias),
    [camModel, camPosition, camAlias],
  );
  const camValidation = useMemo(
    () =>
      validateNewCamera(
        { model: camModel, position: camPosition, operatorAlias: camAlias },
        state.cameras.map((c) => c.code),
        camCode,
      ),
    [camModel, camPosition, camAlias, state.cameras, camCode],
  );

  const [cardLabel, setCardLabel] = useState("");
  const [cardCameraId, setCardCameraId] = useState("");
  const [cardCapacity, setCardCapacity] = useState(512);
  const [cardBusy, setCardBusy] = useState(false);

  // ---- 第 3 步:用卡清单 ----
  const [rosterIds, setRosterIds] = useState<string[]>([]);

  // ---- 第 4 步:备份目的地 ----
  const [backups, setBackups] = useState(() => [newBackup()]);

  // ---- 第 5 步:内容标签 ----
  const [tags, setTags] = useState<ProjectTag[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [tagError, setTagError] = useState<string | null>(null);
  // 进入标签步时把工况 B 的分类预填成标签(只做一次,可随手删)
  const tagsSeededRef = useRef(false);

  // ---- 第 6 步:创建 ----
  const [creating, setCreating] = useState(false);

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  function goTo(next: StepKey) {
    if (next === "tags" && !tagsSeededRef.current) {
      tagsSeededRef.current = true;
      if (scenario === "B") {
        setTags((prev) => {
          let acc = prev;
          for (const raw of categoryValues) {
            const clean = normalizeTagName(raw);
            if (!clean || tagNameError(clean) || findTag(acc, clean)) continue;
            acc = [...acc, { name: clean, color: nextTagColor(acc) }];
          }
          return acc;
        });
      }
    }
    setStep(next);
  }

  function nextStep() {
    if (step === "info") {
      setInfoSubmitted(true);
      if (!info.valid) return;
    }
    const next = STEPS[stepIndex + 1];
    if (next) goTo(next.key);
  }

  function prevStep() {
    const prev = STEPS[stepIndex - 1];
    if (prev) goTo(prev.key);
    else onExit();
  }

  async function addCamera() {
    setCamSubmitted(true);
    if (!camValidation.valid || camBusy) return;
    setCamBusy(true);
    try {
      const camera = await api.createCamera({
        model: camModel.trim(),
        position: camPosition.trim(),
        operatorAlias: camAlias.trim(),
      });
      dispatch({ type: "cameraCreated", camera });
      setCamModel("");
      setCamPosition("");
      setCamAlias("");
      setCamSubmitted(false);
      if (!cardCameraId) setCardCameraId(camera.id);
    } catch (err) {
      notify(
        "error",
        "camera-create-failed",
        `登记相机失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setCamBusy(false);
    }
  }

  async function addCard() {
    if (!cardLabel.trim() || !cardCameraId || cardBusy) return;
    setCardBusy(true);
    try {
      const card = await api.createStorageCard({
        label: cardLabel.trim(),
        cameraId: cardCameraId,
        capacityBytes: cardCapacity * GB,
      });
      dispatch({ type: "cardCreated", card });
      // 引导里登记的卡显然是给本项目用的:直接并入用卡清单
      setRosterIds((prev) => (prev.includes(card.id) ? prev : [...prev, card.id]));
      setCardLabel("");
    } catch (err) {
      notify(
        "error",
        "card-create-failed",
        `登记存储卡失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setCardBusy(false);
    }
  }

  function addTagFromInput() {
    const clean = normalizeTagName(tagInput);
    const problem = tagNameError(clean);
    if (problem) {
      setTagError(problem);
      return;
    }
    if (findTag(tags, clean)) {
      setTagError("已有同名标签");
      return;
    }
    setTags((prev) => [...prev, { name: clean, color: nextTagColor(prev) }]);
    setTagInput("");
    setTagError(null);
  }

  const backupPaths = useMemo(
    () =>
      [
        ...new Set(
          backups.map((b) => b.path.trim()).filter((p) => p.length > 0),
        ),
      ],
    [backups],
  );

  async function create() {
    if (creating) return;
    setInfoSubmitted(true);
    if (!info.valid) {
      goTo("info");
      return;
    }
    setCreating(true);
    try {
      const project = await api.createProject({
        name: name.trim(),
        date,
        scenario,
        categories: scenario === "B" ? categoryValues.map((c) => c.trim()) : [],
      });
      dispatch({ type: "projectCreated", project });

      // 清单/设置写失败不弃项目:项目已真实建夹,补救在对应界面都能做,
      // 但失败必须出声(零静默)
      if (rosterIds.length > 0) {
        try {
          await api.setProjectCards(project.id, rosterIds);
        } catch (err) {
          notify(
            "warning",
            "project-cards-save-failed",
            `用卡清单保存失败(可稍后在项目详情里配置)：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (tags.length > 0 || backupPaths.length > 0) {
        try {
          await api.saveProjectSettings(project.id, {
            tags,
            backupPaths,
          });
        } catch (err) {
          notify(
            "warning",
            "project-settings-save-failed",
            `标签/备份预设保存失败(可稍后在拷卡界面补建标签)：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      await bridge.openProject(project.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify(
        "error",
        "project-create-failed",
        message.includes("目标已存在")
          ? `已有同名项目夹（${folderName}）。换个项目名，或直接打开已有项目。`
          : `创建项目失败：${message}`,
      );
    } finally {
      setCreating(false);
    }
  }

  const rosterCards = state.cards;

  return (
    <div className="npw" data-testid="new-project-wizard">
      <ol className="npw__steps" aria-label="引导步骤">
        {STEPS.map((s, i) => (
          <li
            key={s.key}
            className="npw__step"
            aria-current={s.key === step ? "step" : undefined}
            data-done={i < stepIndex || undefined}
          >
            <span className="npw__step-index">{i + 1}</span>
            {s.label}
          </li>
        ))}
      </ol>

      {step === "info" ? (
        <div className="wizard">
          <form
            className="stack stack--lg"
            onSubmit={(e) => {
              e.preventDefault();
              nextStep();
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
                    error={infoSubmitted ? info.errors.date : undefined}
                  >
                    <input
                      id="project-date"
                      data-testid="np-date"
                      className={`input input--mono${infoSubmitted && info.errors.date ? " input--invalid" : ""}`}
                      type="date"
                      value={isoDate}
                      onChange={(e) => setIsoDate(e.currentTarget.value)}
                    />
                  </Field>
                  <Field
                    label="项目名"
                    htmlFor="project-name"
                    hint="不要带日期前缀，OCard 会自动加"
                    error={infoSubmitted ? info.errors.name : undefined}
                  >
                    <input
                      id="project-name"
                      data-testid="np-name"
                      className={`input${infoSubmitted && info.errors.name ? " input--invalid" : ""}`}
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
                <span className="card__title" id="npw-scenario-label">
                  工况
                </span>
                <span className="card__hint">决定建夹模板与后续流程</span>
              </div>
              <div className="card__body">
                <div
                  className="wizard__choices"
                  role="radiogroup"
                  aria-labelledby="npw-scenario-label"
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
                      const displayIndex = index + 2;
                      const itemError = infoSubmitted
                        ? info.errors.categoryAt?.[index]
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
                              <span className="field__error" role="alert">
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
                    {infoSubmitted && info.errors.categories ? (
                      <span className="field__error" role="alert">
                        {info.errors.categories}
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
      ) : null}

      {step === "devices" ? (
        <div className="stack stack--lg">
          <div className="card">
            <div className="card__head">
              <span className="card__title">登记相机</span>
              <span className="card__hint">
                编码 = 型号_机位_使用者，用于拷卡目标夹命名
              </span>
            </div>
            <div className="card__body">
              <div className="form-grid form-grid--3">
                <Field
                  label="型号"
                  htmlFor="npw-dev-model"
                  error={camSubmitted ? camValidation.errors.model : undefined}
                >
                  <input
                    id="npw-dev-model"
                    data-testid="npw-dev-model"
                    className="input"
                    type="text"
                    value={camModel}
                    placeholder="如：A7M4"
                    onChange={(e) => setCamModel(e.currentTarget.value)}
                  />
                </Field>
                <Field
                  label="机位（A–Z）"
                  htmlFor="npw-dev-position"
                  error={camSubmitted ? camValidation.errors.position : undefined}
                >
                  <input
                    id="npw-dev-position"
                    data-testid="npw-dev-position"
                    className="input input--mono"
                    type="text"
                    maxLength={1}
                    value={camPosition}
                    placeholder="A"
                    onChange={(e) => setCamPosition(e.currentTarget.value)}
                  />
                </Field>
                <Field
                  label="使用者代称"
                  htmlFor="npw-dev-alias"
                  error={camSubmitted ? camValidation.errors.operatorAlias : undefined}
                >
                  <input
                    id="npw-dev-alias"
                    data-testid="npw-dev-alias"
                    className="input input--mono"
                    type="text"
                    maxLength={4}
                    value={camAlias}
                    placeholder="ZS"
                    onChange={(e) => setCamAlias(e.currentTarget.value)}
                  />
                </Field>
              </div>
              <div className="row-inline" style={{ marginTop: "var(--space-3)" }}>
                <span className="text-xs dim">
                  编码预览：
                  <span className="mono">{camCode || "—"}</span>
                </span>
                <button
                  type="button"
                  data-testid="npw-dev-submit"
                  className="btn btn--sm push-right"
                  disabled={camBusy}
                  onClick={() => void addCamera()}
                >
                  {camBusy ? "登记中…" : "登记相机"}
                </button>
              </div>
              {state.cameras.length > 0 ? (
                <div className="tag-row" style={{ marginTop: "var(--space-3)" }}>
                  {state.cameras.map((c) => (
                    <span key={c.id} className="tag tag--gray mono">
                      {c.code}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-sm dim" style={{ marginTop: "var(--space-3)" }}>
                  还没有登记过相机。
                </p>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card__head">
              <span className="card__title">登记存储卡</span>
              <span className="card__hint">一卡一机；引导里登记的卡自动进用卡清单</span>
            </div>
            <div className="card__body">
              <div className="form-grid form-grid--3">
                <Field label="卡面标签" htmlFor="npw-card-label">
                  <input
                    id="npw-card-label"
                    data-testid="npw-card-label"
                    className="input"
                    type="text"
                    value={cardLabel}
                    placeholder="如：CFE-01"
                    onChange={(e) => setCardLabel(e.currentTarget.value)}
                  />
                </Field>
                <Field label="关联相机" htmlFor="npw-card-camera">
                  <Select
                    id="npw-card-camera"
                    testId="npw-card-camera"
                    value={cardCameraId}
                    onChange={setCardCameraId}
                    options={state.cameras.map((c) => ({
                      value: c.id,
                      label: `${c.model} · ${c.code}`,
                    }))}
                  />
                </Field>
                <Field label="容量" htmlFor="npw-card-capacity">
                  <Select
                    id="npw-card-capacity"
                    value={String(cardCapacity)}
                    onChange={(v) => setCardCapacity(Number(v))}
                    options={CAPACITY_OPTIONS.map((gb) => ({
                      value: String(gb),
                      label: gb >= 1024 ? `${gb / 1024} TB` : `${gb} GB`,
                    }))}
                  />
                </Field>
              </div>
              <div className="row-inline" style={{ marginTop: "var(--space-3)" }}>
                <button
                  type="button"
                  data-testid="npw-card-submit"
                  className="btn btn--sm push-right"
                  disabled={cardBusy || !cardLabel.trim() || !cardCameraId}
                  onClick={() => void addCard()}
                >
                  {cardBusy ? "登记中…" : "登记存储卡"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {step === "cards" ? (
        <div className="card">
          <div className="card__head">
            <span className="card__title">本项目计划用卡</span>
            <span className="card__hint">
              勾选后项目进度以「已拷 x/y 张」计；拷了清单外的卡会自动并入
            </span>
          </div>
          <div className="card__body">
            {rosterCards.length === 0 ? (
              <p className="text-sm dim">
                还没有登记存储卡。回上一步登记，或跳过——以后在项目详情里也能配。
              </p>
            ) : (
              <div className="stack stack--sm">
                {rosterCards.map((card) => {
                  const camera = state.cameras.find((c) => c.id === card.cameraId);
                  return (
                    <Checkbox
                      key={card.id}
                      testId="npw-roster-card"
                      checked={rosterIds.includes(card.id)}
                      onChange={(next) =>
                        setRosterIds((prev) =>
                          next
                            ? [...prev, card.id]
                            : prev.filter((id) => id !== card.id),
                        )
                      }
                    >
                      <span className="mono">{card.label}</span>
                      <span className="dim">
                        {" "}
                        · {camera?.code ?? "未知相机"} ·{" "}
                        {formatBytes(card.capacityBytes, 0)}
                      </span>
                    </Checkbox>
                  );
                })}
                <span className="text-xs dim">已选 {rosterIds.length} 张</span>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {step === "backup" ? (
        <div className="card">
          <div className="card__head">
            <span className="card__title">备份目的地预设</span>
            <span className="card__hint">
              NAS 主备份始终包含；这里预设的备份盘会预填进拷卡表单
            </span>
          </div>
          <div className="card__body">
            <div className="stack stack--sm">
              {backups.map((backup, index) => (
                <div className="dest-row" key={backup.id}>
                  <PathField
                    value={backup.path}
                    ariaLabel={`第 ${index + 1} 个备份盘路径`}
                    placeholder="选择备份盘文件夹路径"
                    pickerTitle={`选择第 ${index + 1} 个备份盘`}
                    onChange={(path) =>
                      setBackups((prev) =>
                        prev.map((b) => (b.id === backup.id ? { ...b, path } : b)),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon"
                    aria-label={`删除第 ${index + 1} 个备份盘`}
                    onClick={() =>
                      setBackups((prev) => prev.filter((b) => b.id !== backup.id))
                    }
                  >
                    <IconTrash />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setBackups((prev) => [...prev, newBackup()])}
              >
                <IconPlus />
                添加备份盘
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {step === "tags" ? (
        <div className="card">
          <div className="card__head">
            <span className="card__title">内容标签库</span>
            <span className="card__hint">
              拷卡时从这些标签里选(也可现场新建)；标签随项目走,各工作站共用
            </span>
          </div>
          <div className="card__body">
            <div className="stack">
              <div className="row-inline">
                <input
                  data-testid="npw-tag-input"
                  className="input"
                  type="text"
                  value={tagInput}
                  placeholder="标签名，如：颁奖"
                  onChange={(e) => {
                    setTagInput(e.currentTarget.value);
                    setTagError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTagFromInput();
                    }
                  }}
                />
                <button
                  type="button"
                  data-testid="npw-tag-add"
                  className="btn btn--sm"
                  onClick={addTagFromInput}
                >
                  <IconPlus />
                  添加
                </button>
              </div>
              {tagError ? (
                <span className="field__error" role="alert">
                  {tagError}
                </span>
              ) : null}
              {tags.length > 0 ? (
                <div className="tag-row" data-testid="npw-tag-list">
                  {tags.map((tag) => (
                    <TagChip
                      key={tag.name}
                      name={tag.name}
                      color={tag.color}
                      onRemove={() =>
                        setTags((prev) => prev.filter((t) => t.name !== tag.name))
                      }
                    />
                  ))}
                </div>
              ) : (
                <p className="text-sm dim">
                  还没有标签。可以跳过——拷卡时也能现场创建。
                </p>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {step === "confirm" ? (
        <div className="stack stack--lg">
          <div className="card">
            <div className="card__head">
              <span className="card__title">确认创建</span>
              <span className="card__hint">建夹后项目名与工况不可改，请核对</span>
            </div>
            <div className="card__body">
              <div className="dl">
                <div className="dl__row">
                  <span className="dl__key">项目夹</span>
                  <span className="dl__val mono">
                    {nasRoot}/{folderName || "—"}
                  </span>
                </div>
                <div className="dl__row">
                  <span className="dl__key">工况</span>
                  <span className="dl__val">{SCENARIO_LABEL[scenario]}</span>
                </div>
                {scenario === "B" ? (
                  <div className="dl__row">
                    <span className="dl__key">分类</span>
                    <span className="dl__val">
                      {categoryValues.filter((c) => c.trim()).join("、") || "—"}
                    </span>
                  </div>
                ) : null}
                <div className="dl__row">
                  <span className="dl__key">用卡清单</span>
                  <span className="dl__val">
                    {rosterIds.length > 0 ? `${rosterIds.length} 张` : "未配置"}
                  </span>
                </div>
                <div className="dl__row">
                  <span className="dl__key">备份盘预设</span>
                  <span className="dl__val">
                    {backupPaths.length > 0 ? backupPaths.join("；") : "未配置"}
                  </span>
                </div>
                <div className="dl__row">
                  <span className="dl__key">内容标签</span>
                  <span className="dl__val">
                    {tags.length > 0 ? (
                      <span className="npw__summary-tags">
                        {tags.map((tag) => (
                          <TagChip key={tag.name} name={tag.name} color={tag.color} />
                        ))}
                      </span>
                    ) : (
                      "未配置"
                    )}
                  </span>
                </div>
              </div>
              <p className="text-xs dim" style={{ marginTop: "var(--space-3)" }}>
                创建后将直接进入主窗口的拷卡界面。
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <div className="npw__actions">
        <button type="button" className="btn btn--ghost" onClick={onExit}>
          取消
        </button>
        <div className="npw__actions-right">
          <button
            type="button"
            data-testid="npw-back"
            className="btn"
            onClick={prevStep}
            disabled={creating}
          >
            上一步
          </button>
          {step === "confirm" ? (
            <button
              type="button"
              data-testid="np-submit"
              className="btn btn--primary"
              disabled={creating}
              onClick={() => void create()}
            >
              {creating ? "创建中…" : "创建项目"}
            </button>
          ) : (
            <button
              type="button"
              data-testid="npw-next"
              className="btn btn--primary"
              onClick={nextStep}
            >
              下一步
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
