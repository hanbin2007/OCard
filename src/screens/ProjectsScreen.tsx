/** 屏 1：项目列表（列表 + 详情，↑/↓ 键盘导航）。 */

import { FolderTreeView } from "../components/FolderTreeView";
import { TopBar } from "../components/TopBar";
import { Badge, EmptyState, Kbd, ProgressBar } from "../components/ui";
import { useListNavigation } from "../hooks/useListNavigation";
import { formatBytes, formatCompactDate, formatTimestamp, ratio } from "../lib/format";
import { buildFolderTree, countFolders } from "../lib/folderTree";
import {
  PROJECT_STATUS_LABEL,
  PROJECT_STATUS_TONE,
  SCENARIO_LABEL,
  SCENARIO_SHORT,
  progressLabel,
} from "../lib/labels";
import { useStore } from "../state/store";

export function ProjectsScreen() {
  const { state, dispatch } = useStore();
  const { projects, selectedProjectId } = state;
  const selected = projects.find((p) => p.id === selectedProjectId) ?? null;

  const nav = useListNavigation({
    ids: projects.map((p) => p.id),
    selectedId: selectedProjectId,
    onSelect: (projectId) => dispatch({ type: "selectProject", projectId }),
    idPrefix: "project",
  });

  return (
    <>
      <TopBar
        title="项目"
        subtitle={state.workstation?.nasRoot}
        actions={
          <button
            type="button"
            className="btn btn--primary btn--pill"
            onClick={() => dispatch({ type: "navigate", route: "new-project" })}
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
                  <span>状态</span>
                </div>

                <div {...nav.containerProps} aria-label="项目列表">
                  {projects.map((project) => (
                    <div
                      key={project.id}
                      className="list__row projects__row"
                      {...nav.getItemProps(project.id)}
                    >
                      <span className="projects__name truncate">
                        {project.name}
                        <span className="projects__folder">{project.folderName}</span>
                      </span>

                      <span className="projects__cell">
                        {SCENARIO_SHORT[project.scenario]}
                      </span>

                      <span className="projects__cell projects__cell--mono">
                        {project.cardsCopied}/{project.cardsTotal} 张
                        <span className="projects__folder">
                          {formatBytes(project.bytesCopied)}
                        </span>
                      </span>

                      <span className="projects__meter">
                        <ProgressBar
                          value={
                            project.scenario === "B"
                              ? project.sortedCount
                              : project.cardsCopied
                          }
                          total={
                            project.scenario === "B"
                              ? project.assetCount
                              : project.cardsTotal
                          }
                          tone={project.status === "done" ? "ok" : "accent"}
                          thin
                          label={`${project.name} 进度`}
                        />
                        <span className="projects__cell text-xs">
                          {progressLabel(
                            project.scenario,
                            project.sortedCount,
                            project.assetCount,
                          )}
                        </span>
                      </span>

                      <span>
                        <Badge tone={PROJECT_STATUS_TONE[project.status]} dot>
                          {PROJECT_STATUS_LABEL[project.status]}
                        </Badge>
                      </span>
                    </div>
                  ))}

                  {projects.length === 0 ? (
                    <EmptyState>还没有项目，先新建一个。</EmptyState>
                  ) : null}
                </div>
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
                          <span className="dl__val mono">{selected.folderName}</span>
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
                          <span className="text-xs dim">拷卡进度</span>
                          <span className="text-xs mono muted push-right">
                            {selected.cardsCopied}/{selected.cardsTotal} 张 ·{" "}
                            {Math.round(ratio(selected.cardsCopied, selected.cardsTotal) * 100)}%
                          </span>
                        </div>
                        <ProgressBar
                          value={selected.cardsCopied}
                          total={selected.cardsTotal}
                          tone={
                            selected.cardsCopied === selected.cardsTotal ? "ok" : "accent"
                          }
                          label="拷卡进度"
                        />
                      </div>
                    </div>
                  </div>

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

                  <button
                    type="button"
                    className="btn"
                    onClick={() => dispatch({ type: "navigate", route: "copy" })}
                  >
                    进入拷卡任务
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
    </>
  );
}
