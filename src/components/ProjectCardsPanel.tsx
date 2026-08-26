/**
 * 项目用卡管理(UX 波三):「已拷 x/y」的分母来自这里。
 * 每个项目维护自己的用卡清单——可从设备登记表一键套用为模板、随时增删;
 * 拷卡时实际用到的登记卡会自动并入清单(现场临时加卡不用回头手改)。
 */

import { useEffect, useState } from "react";
import * as api from "../api";
import type { ProjectCards, StorageCard } from "../api/types";
import { useNotify, useStore } from "../state/store";
import { Select } from "./controls";
import { Badge } from "./ui";
import { IconTrash } from "./Icon";

export function ProjectCardsPanel({
  projectId,
  cards,
}: {
  projectId: string;
  cards: StorageCard[];
}) {
  const notify = useNotify();
  const { reload } = useStore();
  const [roster, setRoster] = useState<ProjectCards | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addId, setAddId] = useState("");

  const [reloadToken, setReloadToken] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    void (async () => {
      try {
        const data = await api.listProjectCards(projectId);
        if (!cancelled) setRoster(data);
      } catch (err) {
        if (cancelled) return;
        setLoadFailed(true);
        notify(
          "error",
          "project-cards-load-failed",
          `读取项目用卡清单失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadToken, notify]);

  async function save(nextIds: string[]) {
    // 清单还没读回来就写 = 拿空快照整单覆盖未知内容(评审 P1),一律拒绝
    if (busy || roster === null) return;
    setBusy(true);
    try {
      setRoster(await api.setProjectCards(projectId, nextIds));
      setAddId("");
      // 上方 x/y 与列表行的数字来自 store.projects,不整体重拉就会和
      // 面板打架——同屏两个数字必须同源(评审 P1)
      reload();
    } catch (err) {
      notify(
        "error",
        "project-cards-save-failed",
        `保存项目用卡清单失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  const copied = new Set(roster?.copiedCardIds ?? []);
  const rosterIds = roster?.cardIds ?? [];
  const addable = cards.filter((c) => !rosterIds.includes(c.id));

  return (
    <div className="card" data-testid="project-cards-panel">
      <div className="card__head">
        <span className="card__title">用卡</span>
        <span className="card__hint">
          {rosterIds.length > 0
            ? `${copied.size}/${rosterIds.length} 张已拷`
            : "「已拷 x/y」的分母来自这份清单"}
        </span>
        <div className="card__actions">
          <button
            type="button"
            className="btn btn--sm"
            data-testid="cards-apply-template"
            disabled={busy || cards.length === 0 || roster === null}
            title={
              cards.length === 0
                ? "设备登记表里还没有卡,先去「设备登记」登记"
                : "以设备登记表的全部卡为模板(替换当前清单)"
            }
            onClick={() => void save(cards.map((c) => c.id))}
          >
            套用登记表模板
          </button>
        </div>
      </div>
      <div className="card__body">
        <div className="stack stack--sm">
          {loadFailed ? (
            <div className="row-inline">
              <p className="text-sm dim" role="status">
                清单读取失败(详见右下角提示)。
              </p>
              <button
                type="button"
                className="btn btn--sm"
                data-testid="cards-retry"
                onClick={() => setReloadToken((n) => n + 1)}
              >
                重试
              </button>
            </div>
          ) : roster === null ? (
            <p className="text-sm dim" role="status">
              读取中…
            </p>
          ) : rosterIds.length === 0 ? (
            <p className="text-sm dim">
              {cards.length === 0
                ? "设备登记表里还没有卡——先去「设备登记」把卡登记上,再回来配置本项目用卡。"
                : "还没有配置本项目要用的卡。套用登记表模板一键填入,或在下方逐张添加;拷卡时实际用到的登记卡也会自动加进来。"}
            </p>
          ) : (
            rosterIds.map((id) => {
              const card = cards.find((c) => c.id === id);
              return (
                <div className="row-inline" key={id} data-testid="project-card-row">
                  <Badge mono>{card?.label ?? id}</Badge>
                  {copied.has(id) ? (
                    <Badge tone="ok">已拷</Badge>
                  ) : (
                    <span className="text-2xs dim">待拷</span>
                  )}
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon btn--sm push-right"
                    aria-label={`移出用卡清单 ${card?.label ?? id}`}
                    disabled={busy}
                    onClick={() => void save(rosterIds.filter((x) => x !== id))}
                  >
                    <IconTrash />
                  </button>
                </div>
              );
            })
          )}

          {roster !== null && addable.length > 0 ? (
            <div className="row-inline">
              <Select
                ariaLabel="添加用卡"
                testId="cards-add-select"
                value={addId}
                onChange={setAddId}
                placeholder="添加一张登记卡…"
                options={addable.map((c) => ({
                  value: c.id,
                  label: c.label,
                }))}
              />
              <button
                type="button"
                className="btn btn--sm"
                data-testid="cards-add"
                disabled={busy || !addId}
                onClick={() => void save([...rosterIds, addId])}
              >
                添加
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
