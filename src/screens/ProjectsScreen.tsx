/**
 * 项目管理（列表 + 详情，↑/↓ 键盘导航）。
 * 启动重构后不再是主窗口路由：整体运行在欢迎/项目管理窗口里,
 * 「打开项目」经窗口桥接切到主窗口。
 */

import { useEffect, useState } from "react";
import { AuditLogDrawer } from "../components/AuditLogDrawer";
import { ProjectCardsPanel } from "../components/ProjectCardsPanel";
import {
  DeliveryStatusToggle,
  FinalCutPanel,
} from "../components/FinalCutPanel";
import { FolderTreeView } from "../components/FolderTreeView";
import { TopBar } from "../components/TopBar";
import { ProgressRing } from "../components/charts";
import { IllProjectsEmpty } from "../components/illustrations";
import { Badge, EmptyState, Kbd, ProgressBar } from "../components/ui";
import { useListNavigation } from "../hooks/useListNavigation";
import { formatBytes, formatCompactDate, formatTimestamp } from "../lib/format";
import { buildFolderTree, countFolders } from "../lib/folderTree";
import {
  PROJECT_STATUS_LABEL,
  PROJECT_STATUS_TONE,
  SCENARIO_LABEL,
  SCENARIO_SHORT,
  progressLabel,
} from "../lib/labels";
import { useNotify, useStore } from "../state/store";
import { useWindowBridge } from "../state/windowBridge";

export function ProjectsScreen({ onNewProject }: { onNewProject: () => void }) {
  const { state, dispatch } = useStore();
  const bridge = useWindowBridge();
  const notify = useNotify();
  const { projects, selectedProjectId } = state;
  const selected = projects.find((p) => p.id === selectedProjectId) ?? null;
  const [opening, setOpening] = useState(false);

  async function openInMain(projectId: string, name: string) {
    if (opening) return;
    setOpening(true);
    try {
      await bridge.openProject(projectId);
    } catch (err) {
      notify(
        "error",
        "open-project-failed",
        `打开「${name}」失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setOpening(false);
    }
  }

  /* 审计日志抽屉的开合是这一屏的局部视图状态，不进全局 store：
     换项目时必须自动收起——否则抽屉里显示的还是上一个项目的时间线。 */
  const [auditOpen, setAuditOpen] = useState(false);
  useEffect(() => {
    setAuditOpen(false);
  }, [selectedProjectId]);

  const nav = useListNavigation({
    ids: projects.map((p) => p.id),
    selectedId: selectedProjectId,
    onSelect: (projectId) => dispatch({ type: "selectProject", projectId }),
    idPrefix: "project",
  });

  useEffect(() => {
    if (!selectedProjectId) return;
    const row = document.getElementById(`project-${selectedProjectId}`);
    // 老 WebView / jsdom 里可能没有这个方法，不能让它把渲染打断
    row?.scrollIntoView?.({ block: "nearest" });
  }, [selectedProjectId]);

  return (
    <>
      <TopBar
        title="项目"
        subtitle={state.workstation?.nasRoot}
        actions={
          <button
            type="button"
            className="btn btn--primary btn--pill"
            data-testid="projects-new"
            onClick={onNewProject}
          >
            新建项目
          </button>
        }
      />

      <div className="content">
        <div className="content__inner">
          <div className="split">
            <div>
              <div className="list">
                <div className="list__head projects__head">
                  <span>项目</span>
                  <span>工况</span>
                  <span>已拷卡</span>
                  <span>分类进度</span>
                  <span>备份</span>
                  <span>最近事件</span>
                  <span>状态</span>
                  <span aria-hidden="true" />
                </div>

                {projects.length === 0 ? (
                  <EmptyState art={<IllProjectsEmpty />}>还没有项目，先新建一个。</EmptyState>
                ) : (
                <div {...nav.containerProps} aria-label="项目列表">
                  {projects.map((project) => (
                    <div
                      key={project.id}
                      className="list__row projects__row"
                      data-testid="project-row"
                      {...nav.getItemProps(project.id)}
                    >
                      <span className="projects__name truncate" title={project.name}>
                        {project.name}
                        <span className="projects__folder" title={project.folderName}>
                          {project.folderName}
                        </span>
                      </span>

                      <span className="projects__cell">
                        {SCENARIO_SHORT[project.scenario]}
                      </span>

                      <span className="projects__cell projects__cell--mono">
                        {/* x/y 的分母是项目用卡清单(可编辑,详见详情面板)。
                            未配置清单时回退按完成次数——分母必须真实,不许任务数冒充 */}
                        {project.cardRosterTotal != null
                          ? `${project.cardRosterDone ?? 0}/${project.cardRosterTotal} 张`
                          : `${project.cardsCopied} 次`}
                        <span className="projects__folder">
                          {formatBytes(project.bytesCopied)}
                          {project.copyIncomplete ? (
                            <span className="text-warn"> · 有未完成任务</span>
                          ) : null}
                          {project.cardRosterTotal == null ? (
                            <span className="dim"> · 未配置用卡</span>
                          ) : null}
                        </span>
                      </span>

                      <span className="projects__meter">
                        {/* 进度条只画有真实分母的量:B 的分类进度 / 配了清单的拷卡进度 */}
                        {project.scenario === "B" ? (
                          <ProgressBar
                            value={project.sortedCount}
                            total={project.assetCount}
                            tone={project.status === "done" ? "ok" : "accent"}
                            thin
                            decorative
                          />
                        ) : project.cardRosterTotal != null ? (
                          <ProgressBar
                            value={project.cardRosterDone ?? 0}
                            total={project.cardRosterTotal}
                            tone={
                              (project.cardRosterDone ?? 0) >= project.cardRosterTotal
                                ? "ok"
                                : "accent"
                            }
                            thin
                            decorative
                          />
                        ) : null}
                        <span className="projects__cell text-xs">
                          {/* 条与文字必须同一个分母:A 配了用卡清单时条画的是
                              用卡进度,文字不能再说素材数(评审 P2) */}
                          {project.scenario === "A" &&
                          project.cardRosterTotal != null
                            ? `${project.cardRosterDone ?? 0}/${project.cardRosterTotal} 张已拷`
                            : progressLabel(
                                project.scenario,
                                project.sortedCount,
                                project.assetCount,
                              )}
                        </span>
                      </span>

                      <span className="projects__cell projects__cell--mono">
                        {project.destinationCount} 处
                      </span>

                      <span className="projects__cell projects__cell--mono">
                        {formatTimestamp(project.updatedAt)}
                      </span>

                      <span>
                        <Badge tone={PROJECT_STATUS_TONE[project.status]} dot>
                          {PROJECT_STATUS_LABEL[project.status]}
                        </Badge>
                      </span>

                      {/* 「当前操作项目」是全局状态,选中行的高亮太隐晦——
                          每行给出显式动作,当前行给出显式黄标(UX 波) */}
                      <span className="projects__switch">
                        {project.id === selectedProjectId ? (
                          <span className="current-flag" data-testid="project-current-flag">
                            当前项目
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn--sm projects__switch-btn"
                            data-testid="project-switch"
                            /* listbox 走 roving tabindex,option 内不能再冒出
                               tab 停靠点;鼠标可点,键盘用行选中(等价操作) */
                            tabIndex={-1}
                            onClick={(e) => {
                              e.stopPropagation();
                              dispatch({ type: "selectProject", projectId: project.id });
                            }}
                          >
                            切换到此项目
                          </button>
                        )}
                      </span>
                    </div>
                  ))}

                </div>
                )}
              </div>

              <div className="hint-bar">
                <span>
                  <Kbd>↑</Kbd> <Kbd>↓</Kbd> 切换项目
                </span>
                <span>
                  <Kbd>Home</Kbd> / <Kbd>End</Kbd> 跳到首尾
                </span>
              </div>
            </div>

            <aside className="detail" aria-label="项目详情">
              {selected ? (
                <>
                  <div className="card">
                    <div className="card__head">
                      <span className="card__title">{selected.name}</span>
                      <div className="card__actions">
                        {/* 全量业务事件（含他机）的入口，紧挨着「最近事件」那一行 */}
                        <button
                          type="button"
                          className="btn btn--sm"
                          data-testid="audit-open"
                          aria-haspopup="dialog"
                          aria-expanded={auditOpen}
                          onClick={() => setAuditOpen(true)}
                        >
                          审计日志
                        </button>
                        <Badge tone={PROJECT_STATUS_TONE[selected.status]}>
                          {PROJECT_STATUS_LABEL[selected.status]}
                        </Badge>
                      </div>
                    </div>
                    <div className="card__body">
                      <div className="dl">
                        <div className="dl__row">
                          <span className="dl__key">日期</span>
                          <span className="dl__val mono">
                            {formatCompactDate(selected.date)}
                          </span>
                        </div>
                        <div className="dl__row">
                          <span className="dl__key">工况</span>
                          <span className="dl__val">
                            {SCENARIO_LABEL[selected.scenario]}
                          </span>
                        </div>
                        <div className="dl__row">
                          <span className="dl__key">项目夹</span>
                          <span className="dl__val mono" title={selected.folderName}>
                            {selected.folderName}
                          </span>
                        </div>
                        <div className="dl__row">
                          <span className="dl__key">备份</span>
                          <span className="dl__val">
                            {selected.destinationCount} 个目的地 ·{" "}
                            {formatBytes(selected.bytesCopied)}
                          </span>
                        </div>
                        <div className="dl__row">
                          <span className="dl__key">最近事件</span>
                          <span className="dl__val mono">
                            {formatTimestamp(selected.updatedAt)}
                          </span>
                        </div>
                      </div>

                      <hr className="divider" />

                      <div className="stack stack--sm">
                        <div className="row-inline">
                          <span className="text-xs dim">拷卡</span>
                          <span className="text-xs mono muted push-right">
                            {selected.cardRosterTotal != null
                              ? `已拷 ${selected.cardRosterDone ?? 0}/${selected.cardRosterTotal} 张`
                              : `完成 ${selected.cardsCopied} 次拷卡`}{" "}
                            · {formatBytes(selected.bytesCopied)}
                          </span>
                        </div>
                        {selected.cardRosterTotal != null ? (
                          <ProgressBar
                            value={selected.cardRosterDone ?? 0}
                            total={selected.cardRosterTotal}
                            tone={
                              (selected.cardRosterDone ?? 0) >=
                              selected.cardRosterTotal
                                ? "ok"
                                : "accent"
                            }
                            label="拷卡进度"
                          />
                        ) : null}
                        {selected.cardRosterTotal != null ? (
                          /* 次数与 x/y 并列:清单外/未登记卡的拷卡不进 x,
                             但不许在 UI 里消失(评审 P1) */
                          <span className="text-2xs dim">
                            共完成 {selected.cardsCopied} 次拷卡任务
                            {selected.cardsCopied >
                            (selected.cardRosterDone ?? 0)
                              ? ",部分来自清单外或未登记的卡"
                              : ""}
                          </span>
                        ) : null}
                        {selected.copyIncomplete ? (
                          <span
                            className="text-xs text-warn"
                            data-testid="project-copy-incomplete"
                          >
                            有已发起但未完成的拷卡任务,可在「拷卡任务」里续传
                          </span>
                        ) : null}
                      </div>

                      {/* 分类进度只在工况 B 有意义，且拷入素材前的 0% 是噪音不是信息 */}
                      {selected.scenario === "B" && selected.assetCount > 0 ? (
                        <>
                          <hr className="divider" />
                          <div className="ring-stat" data-testid="project-sorting-ring">
                            <ProgressRing
                              value={selected.sortedCount}
                              total={selected.assetCount}
                              label="分类进度"
                            />
                            <div className="ring-stat__meta">
                              <span className="stat__label">分类进度</span>
                              <span className="stat__value mono">
                                {selected.sortedCount}/{selected.assetCount} 张
                              </span>
                            </div>
                          </div>
                        </>
                      ) : null}
                    </div>
                  </div>

                  <ProjectCardsPanel
                    key={selected.id}
                    projectId={selected.id}
                    cards={state.cards}
                  />

                  <div className="card">
                    <div className="card__head">
                      <span className="card__title">目录结构</span>
                      <span className="card__hint">
                        {countFolders(
                          buildFolderTree(selected.scenario, selected.categories),
                        )}{" "}
                        个文件夹
                      </span>
                    </div>
                    <div className="card__body">
                      <FolderTreeView
                        root={selected.folderName}
                        nodes={buildFolderTree(selected.scenario, selected.categories)}
                      />
                    </div>
                  </div>

                  {/* 交付状态：人工勾选，OCard 不代传 */}
                  <div className="card">
                    <div className="card__head">
                      <span className="card__title">交付状态</span>
                    </div>
                    <div className="card__body">
                      <DeliveryStatusToggle projectId={selected.id} />
                    </div>
                  </div>

                  {/* 成片校验只对工况 A 有意义 */}
                  {selected.scenario === "A" ? (
                    <FinalCutPanel projectId={selected.id} />
                  ) : null}

                  <button
                    type="button"
                    className="btn btn--primary"
                    data-testid="project-open"
                    disabled={opening}
                    onClick={() => void openInMain(selected.id, selected.name)}
                  >
                    {opening ? "打开中…" : "打开此项目"}
                  </button>
                </>
              ) : (
                <div className="card">
                  <div className="card__body">
                    <p className="text-sm dim">选中一个项目查看详情。</p>
                  </div>
                </div>
              )}
            </aside>
          </div>
        </div>
      </div>

      {auditOpen && selected ? (
        <AuditLogDrawer
          projectId={selected.id}
          projectName={selected.folderName}
          onClose={() => setAuditOpen(false)}
        />
      ) : null}
    </>
  );
}
