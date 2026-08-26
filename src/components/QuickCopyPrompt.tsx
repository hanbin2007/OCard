/**
 * 快捷拷卡(插卡引导):检测到插入新卡时的引导浮层。
 * - 未登记卡 → 引导去设备屏登记(预填绑定卷),登记成功后续接本引导;
 * - 已登记卡 → 询问是否加入当前项目的用卡清单,并引导创建拷卡任务
 *   (拷卡屏预选该卷与匹配卡的相机)。
 *
 * 挂在 Shell 层(.main 之外)、z-index 低于会话门:门开时被压住,
 * 不成为绕过会话门的旁路;交付打包期间导航按钮与侧栏同一把锁。
 * 一次只提示队首一张卡;卷被拔走时提示随 volumesUpdated 自动消失。
 */

import { useEffect, useState } from "react";
import * as api from "../api";
import { formatBytes } from "../lib/format";
import { selectDeliveryWorking, useNotify, useStore } from "../state/store";
import { IconCard, IconClose } from "./Icon";

type RosterState =
  | { phase: "loading" }
  | { phase: "ready"; inRoster: boolean }
  | { phase: "error"; message: string };

export function QuickCopyPrompt() {
  const { state, dispatch } = useStore();
  const notify = useNotify();
  const deliveryWorking = selectDeliveryWorking(state);

  const volumeId = state.quickCopyQueue[0] ?? null;
  const volume = state.volumes.find((v) => v.id === volumeId) ?? null;
  const card = volume?.matchedCardId
    ? (state.cards.find((c) => c.id === volume.matchedCardId) ?? null)
    : null;
  const project =
    state.projects.find((p) => p.id === state.selectedProjectId) ?? null;

  const [roster, setRoster] = useState<RosterState>({ phase: "loading" });
  const [joinBusy, setJoinBusy] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  // 已登记卡 + 有当前项目:查它是否已在用卡清单里(决定要不要问「加入」)
  useEffect(() => {
    if (!volume || !card || !project) return;
    let cancelled = false;
    setRoster({ phase: "loading" });
    api
      .listProjectCards(project.id)
      .then((pc) => {
        if (cancelled) return;
        setRoster({ phase: "ready", inRoster: pc.cardIds.includes(card.id) });
      })
      .catch((err) => {
        if (cancelled) return;
        // 读取失败必须可见:降级为「不知道在不在清单里」,仍可直接去拷卡
        setRoster({
          phase: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [volume?.id, card?.id, project?.id, retryToken]);

  if (!volume) return null;

  const resolve = () =>
    dispatch({ type: "quickCopyResolved", volumeId: volume.id });

  const goCopy = () => {
    dispatch({
      type: "copyDraftSet",
      volumeId: volume.id,
      cameraId: card?.cameraId,
    });
    resolve();
    dispatch({ type: "navigate", route: "copy" });
  };

  const goRegister = () => {
    dispatch({ type: "cardDraftSet", volumeId: volume.id });
    resolve();
    dispatch({ type: "navigate", route: "devices" });
  };

  const joinAndCopy = async () => {
    if (!project || !card) return;
    setJoinBusy(true);
    try {
      // 拿最新清单再追加,不用本地缓存——多机同时编辑时少踩一次覆盖
      const current = await api.listProjectCards(project.id);
      if (!current.cardIds.includes(card.id)) {
        await api.setProjectCards(project.id, [...current.cardIds, card.id]);
        notify(
          "info",
          "project-cards-updated",
          `「${card.label}」已加入项目「${project.name}」的用卡清单。`,
        );
      }
      goCopy();
    } catch (err) {
      // 加入失败不拦拷卡本身:提示可见,浮层留在原地供重试/直接去拷卡
      notify(
        "warning",
        "project-cards-save-failed",
        `加入用卡清单失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setJoinBusy(false);
    }
  };

  const lockTitle = deliveryWorking
    ? "交付打包进行中，完成后才能切换页面"
    : undefined;

  return (
    <div
      className="quick-copy"
      role="dialog"
      aria-label="检测到存储卡插入"
      data-testid="quick-copy-prompt"
    >
      <div className="quick-copy__head">
        <IconCard />
        <span className="quick-copy__title">
          {card ? `检测到已登记卡「${card.label}」` : "检测到未登记的卡"}
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--icon quick-copy__close"
          aria-label="忽略本次插卡"
          data-testid="qc-ignore"
          onClick={resolve}
        >
          <IconClose />
        </button>
      </div>
      <p className="quick-copy__meta mono">
        卷「{volume.name}」 · {formatBytes(volume.capacityBytes)}
      </p>

      {!card ? (
        <>
          <p className="quick-copy__hint">
            这张卡还没有登记。登记并插卡绑定后,以后插入就能自动认出它。
          </p>
          <div className="quick-copy__actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              data-testid="qc-register"
              disabled={deliveryWorking}
              title={lockTitle}
              onClick={goRegister}
            >
              去登记
            </button>
          </div>
        </>
      ) : !project ? (
        <>
          <p className="quick-copy__hint">
            需要先选择当前操作项目,才能加入用卡清单并创建拷卡任务。
          </p>
          <div className="quick-copy__actions">
            <button
              type="button"
              className="btn btn--sm"
              data-testid="qc-goto-projects"
              disabled={deliveryWorking}
              title={lockTitle}
              onClick={() => dispatch({ type: "navigate", route: "projects" })}
            >
              去选择项目
            </button>
          </div>
        </>
      ) : (
        <>
          {roster.phase === "error" ? (
            <p className="quick-copy__hint quick-copy__hint--warn">
              用卡清单读取失败：{roster.message}
            </p>
          ) : roster.phase === "ready" && roster.inRoster ? (
            <p className="quick-copy__hint">
              已在项目「{project.name}」的用卡清单中。
            </p>
          ) : (
            <p className="quick-copy__hint">
              是否加入项目「{project.name}」的用卡清单?
            </p>
          )}
          <div className="quick-copy__actions">
            {roster.phase === "error" ? (
              <button
                type="button"
                className="btn btn--sm"
                data-testid="qc-retry"
                onClick={() => setRetryToken((n) => n + 1)}
              >
                重试
              </button>
            ) : null}
            {roster.phase !== "ready" || !roster.inRoster ? (
              <button
                type="button"
                className="btn btn--primary btn--sm"
                data-testid="qc-add-and-copy"
                disabled={deliveryWorking || roster.phase !== "ready" || joinBusy}
                title={
                  lockTitle ??
                  (roster.phase === "loading"
                    ? "正在读取用卡清单…"
                    : roster.phase === "error"
                      ? "清单读取失败,重试成功后才能加入"
                      : undefined)
                }
                onClick={() => void joinAndCopy()}
              >
                {joinBusy ? "加入中…" : "加入清单并拷卡"}
              </button>
            ) : null}
            <button
              type="button"
              className={`btn btn--sm${roster.phase === "ready" && roster.inRoster ? " btn--primary" : ""}`}
              data-testid="qc-copy"
              disabled={deliveryWorking}
              title={lockTitle}
              onClick={goCopy}
            >
              去拷卡
            </button>
          </div>
        </>
      )}
    </div>
  );
}
