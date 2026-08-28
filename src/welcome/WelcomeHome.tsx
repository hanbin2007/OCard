/**
 * 欢迎页(仿 Xcode Welcome):左侧品牌区 + 主操作,右侧本机最近打开的项目。
 * 「打开项目」走窗口桥接:Tauri 下切到主窗口,浏览器预览在同窗切视图。
 */

import { useEffect, useState } from "react";
import * as api from "../api";
import { IconChevronRight, IconPlus, IconProjects } from "../components/Icon";
import { formatTimestamp } from "../lib/format";
import { SCENARIO_SHORT } from "../lib/labels";
import { useNotify, useStore } from "../state/store";
import { useWindowBridge } from "../state/windowBridge";

/** 品牌字标(与侧栏/应用图标同几何) */
export function BrandMark({ size = 44 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} role="img" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M7.8 3h5.9l4.6 4.6v11.3a2.1 2.1 0 0 1-2.1 2.1H7.8a2.1 2.1 0 0 1-2.1-2.1V5.1A2.1 2.1 0 0 1 7.8 3Zm4.2 5.8a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z"
      />
      <circle cx="12" cy="12.4" r="1.55" fill="var(--accent)" />
    </svg>
  );
}

export function WelcomeHome({
  onNewProject,
  onBrowseAll,
}: {
  onNewProject: () => void;
  onBrowseAll: () => void;
}) {
  const { state } = useStore();
  const bridge = useWindowBridge();
  const notify = useNotify();
  const [version, setVersion] = useState("");
  const [openingId, setOpeningId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .getAppVersion()
      .then((v) => {
        if (!cancelled) setVersion(v);
      })
      .catch(() => {
        /* 版本号纯装饰,拿不到就不显示 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const recents = state.workstation?.recentProjects ?? [];

  async function openProject(projectId: string, name: string) {
    if (openingId) return;
    setOpeningId(projectId);
    try {
      await bridge.openProject(projectId);
    } catch (err) {
      // 最近列表可能指向已被删除/改名的项目:失败必须出声,别静默不动
      notify(
        "error",
        "open-project-failed",
        `打开「${name}」失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setOpeningId(null);
    }
  }

  return (
    <div className="welcome-shell__body" data-testid="welcome-home">
      <section className="welcome-hero" aria-label="欢迎">
        <span className="welcome-hero__mark">
          <BrandMark />
        </span>
        <div>
          <h1 className="welcome-hero__title">欢迎使用 OCard</h1>
          <p className="welcome-hero__subtitle">
            {version ? `版本 ${version} · ` : ""}
            DIT 素材备份管理
          </p>
        </div>

        <div className="welcome-hero__actions">
          <button
            type="button"
            className="welcome-action"
            data-testid="welcome-new-project"
            onClick={onNewProject}
          >
            <IconPlus size={22} className="welcome-action__icon" />
            <span>
              <span className="welcome-action__title">新建项目…</span>
              <span className="welcome-action__desc">
                按规范建夹,并配好设备、用卡、备份与标签
              </span>
            </span>
          </button>
          <button
            type="button"
            className="welcome-action"
            data-testid="welcome-browse-all"
            onClick={onBrowseAll}
          >
            <IconProjects size={22} className="welcome-action__icon" />
            <span>
              <span className="welcome-action__title">所有项目</span>
              <span className="welcome-action__desc">
                浏览 NAS 上的全部项目、进度与审计日志
              </span>
            </span>
          </button>
        </div>

        <span className="welcome-hero__foot" title={state.workstation?.nasRoot}>
          {state.workstation
            ? `${state.workstation.operator} · ${state.workstation.nasRoot}`
            : ""}
        </span>
      </section>

      <aside className="welcome-recents" aria-label="最近项目">
        <div className="welcome-recents__head">
          <span>最近项目</span>
        </div>
        <div className="welcome-recents__list" data-testid="welcome-recents">
          {recents.map((recent) => (
            <button
              key={recent.id}
              type="button"
              className="welcome-recent"
              data-testid="welcome-recent"
              disabled={openingId !== null}
              onClick={() => void openProject(recent.id, recent.name)}
            >
              {/* 徽标只放工况字母:36px 方块塞不下「B 拍照」,必然折行成
                  「B 拍 / 照」(用户点名)。全称降到副行,信息一个字不少。 */}
              <span className="welcome-recent__badge" aria-hidden="true">
                {recent.scenario}
              </span>
              <span className="welcome-recent__meta">
                <span className="welcome-recent__name">{recent.name}</span>
                <span className="welcome-recent__folder">
                  <span>{SCENARIO_SHORT[recent.scenario]}</span>
                  <span aria-hidden="true"> · </span>
                  <span className="truncate">{recent.folderName}</span>
                </span>
              </span>
              <span className="welcome-recent__time">
                {openingId === recent.id
                  ? "打开中…"
                  : formatTimestamp(recent.lastOpenedAt)}
              </span>
              <IconChevronRight size={14} aria-hidden="true" />
            </button>
          ))}
          {recents.length === 0 ? (
            <p className="welcome-recents__empty">
              还没有最近打开的项目。新建一个,或从「所有项目」里打开。
            </p>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
