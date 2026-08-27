/**
 * 快捷拷卡(插卡引导):检测到插入新卡时的引导浮层。
 * - 未登记卡 → 引导去设备屏登记(预填绑定卷),登记成功后续接本引导;
 * - 已登记卡 → 询问是否加入当前项目的用卡清单,并引导创建拷卡任务
 *   (拷卡屏预选该卷与匹配卡的相机);
 * - 登记表读不到/匹配冲突 → 如实说「无法核对」,不引导重复登记(评审 P0)。
 *
 * 挂在 Shell 层(.main 之外):路由切换不打断引导。会话门开启时由
 * SessionGuard 把 .shell > .quick-copy 一并设为 inert(z-index 只挡鼠标,
 * 挡不住键盘——双路评审 P0);交付打包期间导航按钮与侧栏同一把锁。
 * 一次只提示队首一张卡;卷被拔走时提示随 volumesUpdated 自动消失。
 */

import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { Project, StorageCard, Volume } from "../api/types";
import { formatBytes } from "../lib/format";
import { selectDeliveryWorking, useNotify, useStore } from "../state/store";
import { useWindowBridge } from "../state/windowBridge";
import { IconCard, IconClose } from "./Icon";

type RosterState =
  | { phase: "loading" }
  | { phase: "ready"; inRoster: boolean }
  | { phase: "error"; message: string };

export function QuickCopyPrompt() {
  const { state, dispatch } = useStore();
  const volumeId = state.quickCopyQueue[0] ?? null;
  const volume = state.volumes.find((v) => v.id === volumeId) ?? null;

  // 队首 id 悬空(卷快照替换后没剪干净的兜底)自愈出队,不渲染死浮层
  useEffect(() => {
    if (volumeId && !volume) {
      dispatch({ type: "quickCopyResolved", volumeId });
    }
  }, [volumeId, volume, dispatch]);

  if (!volume) return null;
  // key 隔离:同一张卷「忽略→拔→再插」或轮到下一张时,roster 等内部
  // 状态必须重置,不能沿用上一次的失败/成员资格结论(评审 P2)
  return <PromptBody key={volume.id} volume={volume} />;
}

function PromptBody({ volume }: { volume: Volume }) {
  const { state, dispatch } = useStore();
  const bridge = useWindowBridge();
  const notify = useNotify();
  const deliveryWorking = selectDeliveryWorking(state);

  // 缺省(旧快照/mock 未填)按 matchedCardId 推断,不武断当未登记
  const matchStatus =
    volume.matchStatus ?? (volume.matchedCardId ? "matched" : "unregistered");
  const card =
    matchStatus === "matched" && volume.matchedCardId
      ? (state.cards.find((c) => c.id === volume.matchedCardId) ?? null)
      : null;
  const project =
    state.projects.find((p) => p.id === state.selectedProjectId) ?? null;

  const [roster, setRoster] = useState<RosterState>({ phase: "loading" });
  const [joinBusy, setJoinBusy] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  // await 之后的上下文复核用:渲染期同步最新队首与项目
  const liveRef = useRef({ headId: null as string | null, projectId: null as string | null });
  liveRef.current = {
    headId: state.quickCopyQueue[0] ?? null,
    projectId: state.selectedProjectId,
  };

  // 已登记卡 + 有当前项目:查它是否已在用卡清单里(决定要不要问「加入」)
  useEffect(() => {
    if (!card || !project) return;
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
  }, [card?.id, project?.id, retryToken]);

  const resolve = () =>
    dispatch({ type: "quickCopyResolved", volumeId: volume.id });

  // Esc = 忽略(读屏/键盘用户也要有关闭途径)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") resolve();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume.id]);

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

  const joinAndCopy = async (proj: Project, c: StorageCard) => {
    setJoinBusy(true);
    try {
      // 原子增量追加(后端写可交换事件),不再读-改-写整表(评审 P0)
      await api.addProjectCard(proj.id, c.id);
      // await 期间世界可能变了:卡被拔/被忽略/项目被切——旧闭包不许
      // 替新上下文做导航决定(评审 P0)
      if (
        liveRef.current.headId !== volume.id ||
        liveRef.current.projectId !== proj.id
      ) {
        notify(
          "info",
          "project-cards-updated",
          `「${c.label}」已加入项目「${proj.name}」的用卡清单。`,
        );
        return;
      }
      notify(
        "info",
        "project-cards-updated",
        `「${c.label}」已加入项目「${proj.name}」的用卡清单。`,
      );
      // 轻量项目对账:x/y 分母与清单必须同源(评审 P1)
      try {
        const projects = await api.listProjects();
        dispatch({ type: "projectsLoaded", projects });
      } catch {
        // 对账失败不拦引导:项目屏有自己的读取失败路径
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
      role="region"
      aria-live="polite"
      aria-label="检测到存储卡插入"
      data-testid="quick-copy-prompt"
    >
      <div className="quick-copy__head">
        <IconCard />
        <span className="quick-copy__title">
          {matchStatus === "matched" && card
            ? `检测到已登记卡「${card.label}」`
            : matchStatus === "unavailable"
              ? "检测到卡,但暂时无法核对登记"
              : matchStatus === "conflict"
                ? "检测到卡,但登记匹配存在冲突"
                : "检测到未登记的卡"}
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

      {matchStatus === "unavailable" || matchStatus === "conflict" ? (
        <>
          {/* 「读不到登记表」「匹配冲突」都不是「未登记」:此时引导登记会
              造出重复登记/克隆指纹(评审 P0)。只给重试与忽略。 */}
          <p className="quick-copy__hint quick-copy__hint--warn">
            {matchStatus === "unavailable"
              ? "登记表暂时读取不到(NAS 可能未连接),无法确认这张卡是否已登记。恢复后重试,或先忽略。"
              : "这张卡与登记表的匹配存在冲突(详见通知中心),请先按提示清理登记,再重试。"}
          </p>
          <div className="quick-copy__actions">
            <button
              type="button"
              className="btn btn--sm"
              data-testid="qc-rematch"
              onClick={() => {
                void (async () => {
                  try {
                    const volumes = await api.listVolumes();
                    dispatch({ type: "volumesUpdated", volumes });
                  } catch (err) {
                    notify(
                      "warning",
                      "volumes-refresh-failed",
                      `卷列表刷新失败：${
                        err instanceof Error ? err.message : String(err)
                      }`,
                    );
                  }
                })();
              }}
            >
              重试核对
            </button>
          </div>
        </>
      ) : matchStatus === "unregistered" ? (
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
      ) : !card ? (
        <>
          {/* matched 但本地 cards 还没同步到这张卡:等 bootstrap/刷新 */}
          <p className="quick-copy__hint">正在同步登记表信息…</p>
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
              onClick={() => void bridge.openManager()}
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
                onClick={() => void joinAndCopy(project, card)}
              >
                {joinBusy ? "加入中…" : "加入清单并拷卡"}
              </button>
            ) : null}
            <button
              type="button"
              className={`btn btn--sm${roster.phase === "ready" && roster.inRoster ? " btn--primary" : ""}`}
              data-testid="qc-copy"
              disabled={deliveryWorking || joinBusy}
              title={lockTitle}
              onClick={goCopy}
            >
              {roster.phase === "ready" && !roster.inRoster
                ? "不加入,直接拷卡"
                : "去拷卡"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
