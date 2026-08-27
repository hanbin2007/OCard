/** 屏 3：设备登记（相机 → 实时编码预览；存储卡与相机关联）。 */

import { Select } from "../components/controls";
import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import { ConfirmDialog, type ConfirmRequest } from "../components/ConfirmDialog";
import { IconTrash } from "../components/Icon";
import { TopBar } from "../components/TopBar";
import { IllCameraEmpty, IllCardsEmpty } from "../components/illustrations";
import { Badge, EmptyState, Field } from "../components/ui";
import { formatBytes } from "../lib/format";
import { buildCameraCode } from "../lib/naming";
import { validateNewCamera } from "../lib/validation";
import { useNotify, useStore } from "../state/store";

const GB = 1024 ** 3;
const CAPACITY_OPTIONS = [128, 256, 512, 1024];

export function DevicesScreen() {
  const { state, dispatch } = useStore();
  const notify = useNotify();
  const { cameras, cards } = state;

  const [model, setModel] = useState("");
  const [position, setPosition] = useState("");
  const [alias, setAlias] = useState("");
  const [note, setNote] = useState("");
  const [cameraSubmitted, setCameraSubmitted] = useState(false);

  const [cardLabel, setCardLabel] = useState("");
  const [cardCameraId, setCardCameraId] = useState("");
  const [cardCapacity, setCardCapacity] = useState(512);
  const [cardSerial, setCardSerial] = useState("");
  const [cardSubmitted, setCardSubmitted] = useState(false);
  /** 插卡绑定:选中的挂载路径("" = 不绑定) */
  const [bindMount, setBindMount] = useState("");
  const [bindRefreshing, setBindRefreshing] = useState(false);
  /** 刷新后发现所选卷已拔出:系统改写了表单状态,必须贴着控件说(评审 P1) */
  const [bindStale, setBindStale] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  /** 登记成功后的回执，避免「表单清空」被读成「没提交上」 */
  const [lastCamera, setLastCamera] = useState<string | null>(null);
  const [lastCard, setLastCard] = useState<string | null>(null);

  const code = useMemo(
    () => buildCameraCode(model, position, alias),
    [model, position, alias],
  );

  const cameraValidation = useMemo(
    () =>
      validateNewCamera(
        { model, position, operatorAlias: alias, note },
        cameras.map((c) => c.code),
        code,
      ),
    [model, position, alias, note, cameras, code],
  );

  const { volumes } = state;
  const boundVolume = volumes.find((v) => v.mountPath === bindMount) ?? null;

  /**
   * 快捷拷卡引导「去登记」预填:绑定卷、卡标签(以卷标起步,可改)。
   * 草稿**只消费一次**——预填后立即 consumed,续接判定走本地 ref。
   * 之前草稿常驻 + effect 依赖卷对象引用,任意一次卷列表刷新都会把
   * 用户手改的绑定卷改回草稿卷,甚至在登记完下一张卡时复活旧卷,
   * 把指纹写错物理卡(双路评审 P0)。
   */
  const quickDraftRef = useRef<{ volumeId: string; mountPath: string } | null>(
    null,
  );
  useEffect(() => {
    const draft = state.cardDraft;
    if (!draft) return;
    dispatch({ type: "cardDraftConsumed" });
    const vol = volumes.find((v) => v.id === draft.volumeId);
    if (!vol) {
      // 卷已被拔走:草稿作废必须出声,不能让「去登记」落地后毫无动静
      notify(
        "info",
        "quick-copy-draft-dropped",
        "刚插入的卡已被拔出,登记表单未预填,请重新插卡或手动选择绑定卷。",
      );
      return;
    }
    quickDraftRef.current = { volumeId: vol.id, mountPath: vol.mountPath };
    setBindMount(vol.mountPath);
    setCardLabel((prev) => (prev.trim() ? prev : vol.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.cardDraft]);

  /** 卷列表可能是启动时拉的旧账:绑定前给个手动刷新 */
  async function refreshBindVolumes() {
    setBindRefreshing(true);
    try {
      const next = await api.listVolumes();
      dispatch({ type: "volumesUpdated", volumes: next });
      // 之前选的卷不在新列表里(卡被拔了):立刻清掉并可见提示,
      // 不许把过期路径提交给后端再靠"未挂载"报错兜底
      setBindMount((prev) => {
        if (prev && !next.some((v) => v.mountPath === prev)) {
          setBindStale(true);
          return "";
        }
        return prev;
      });
    } catch (err) {
      notify(
        "error",
        "volumes-refresh-failed",
        `刷新卷列表失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBindRefreshing(false);
    }
  }

  const cardCountByCamera = useMemo(() => {
    const map = new Map<string, number>();
    for (const card of cards) {
      map.set(card.cameraId, (map.get(card.cameraId) ?? 0) + 1);
    }
    return map;
  }, [cards]);

  async function addCamera() {
    setCameraSubmitted(true);
    if (!cameraValidation.valid) return;
    try {
      const camera = await api.createCamera({
        model,
        position,
        operatorAlias: alias,
        note,
      });
      dispatch({ type: "cameraCreated", camera });
      setLastCamera(camera.code);
      setModel("");
      setPosition("");
      setAlias("");
      setNote("");
      setCameraSubmitted(false);
    } catch (err) {
      // 提交后失败统一走 toast(UX 波三)
      notify(
        "error",
        "device-register-failed",
        `登记相机失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function addCard() {
    setCardSubmitted(true);
    if (!cardLabel.trim() || !cardCameraId) return;
    try {
      const card = await api.createStorageCard({
        label: cardLabel,
        cameraId: cardCameraId,
        // 绑定时容量取真实卷容量,不用档位近似值
        capacityBytes: boundVolume ? boundVolume.capacityBytes : cardCapacity * GB,
        serial: cardSerial,
        ...(bindMount
          ? { bindMountPath: bindMount, bindVolumeName: boundVolume?.name }
          : {}),
      });
      dispatch({ type: "cardCreated", card });
      setLastCard(card.label);
      // 续接判定与草稿清理解耦:登记一旦成功,草稿 ref 一律作废——
      // 否则改过绑定的提交会让旧草稿存活,下一张卡静默绑回旧卷(评审 P0)
      const draft = quickDraftRef.current;
      quickDraftRef.current = null;
      const fromDraft = draft !== null && bindMount === draft.mountPath;
      setCardLabel("");
      setCardSerial("");
      setBindMount("");
      setCardSubmitted(false);
      if (fromDraft) {
        // 快捷拷卡引导的登记环节完成:刷新卷列表拿到新的卡匹配,
        // 再把这张卷重新入队——引导自动进入「加入清单/去拷卡」阶段
        try {
          const next = await api.listVolumes();
          dispatch({ type: "volumesUpdated", volumes: next });
        } catch (err) {
          // 刷新失败是降级,必须可见;补匹配走定点 patch,
          // 不拿闭包旧表整体覆盖(会复活已拔的卷)(评审 P1)
          notify(
            "warning",
            "volumes-refresh-failed",
            `登记已完成,但卷列表刷新失败：${
              err instanceof Error ? err.message : String(err)
            }。卡匹配按本地结果显示,可能不准确。`,
          );
          dispatch({
            type: "volumeMatchPatched",
            volumeId: draft.volumeId,
            cardId: card.id,
          });
        }
        dispatch({ type: "volumesInserted", volumeIds: [draft.volumeId] });
      }
    } catch (err) {
      notify(
        "error",
        "device-register-failed",
        `登记存储卡失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return (
    <>
      <TopBar
        title="设备登记"
        subtitle="登记表全项目共享，存于 NAS"
        actions={
          <span className="text-xs dim">
            {cameras.length} 台相机 · {cards.length} 张卡
          </span>
        }
      />

      <div className="content">
        <div className="content__inner">
          <div className="devices">
            <div className="devices__form">
              <div className="card">
                <div className="card__head">
                  <span className="card__title">登记相机</span>
                </div>
                <div className="card__body">
                  <form
                    className="stack stack--lg"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void addCamera();
                    }}
                  >
                    <Field
                      label="型号"
                      htmlFor="cam-model"
                      hint="编码时自动去空格，如 DJI Ronin 4D → DJIRonin4D"
                      error={cameraSubmitted ? cameraValidation.errors.model : undefined}
                    >
                      <input
                        id="cam-model"
                        data-testid="dev-model"
                        className="input"
                        type="text"
                        value={model}
                        placeholder="DJI Ronin 4D"
                        onChange={(e) => setModel(e.currentTarget.value)}
                      />
                    </Field>

                    <div className="form-grid form-grid--2">
                      <Field
                        label="机位"
                        htmlFor="cam-position"
                        error={
                          cameraSubmitted ? cameraValidation.errors.position : undefined
                        }
                      >
                        <input
                          id="cam-position"
                          data-testid="dev-position"
                          className="input input--mono"
                          type="text"
                          maxLength={1}
                          value={position}
                          placeholder="B"
                          onChange={(e) =>
                            setPosition(e.currentTarget.value.toUpperCase())
                          }
                        />
                      </Field>

                      <Field
                        label="使用者代称"
                        htmlFor="cam-alias"
                        error={
                          cameraSubmitted
                            ? cameraValidation.errors.operatorAlias
                            : undefined
                        }
                      >
                        <input
                          id="cam-alias"
                          data-testid="dev-alias"
                          className="input input--mono"
                          type="text"
                          maxLength={4}
                          value={alias}
                          placeholder="ZS"
                          onChange={(e) => setAlias(e.currentTarget.value.toUpperCase())}
                        />
                      </Field>
                    </div>

                    <Field label="备注" htmlFor="cam-note">
                      <input
                        id="cam-note"
                        className="input"
                        type="text"
                        value={note}
                        placeholder="选填，如：主机位 8K"
                        onChange={(e) => setNote(e.currentTarget.value)}
                      />
                    </Field>

                    <div className="code-preview">
                      <span className="code-preview__label">规范编码预览</span>
                      <span
                        className={`code-preview__value${code ? "" : " code-preview__value--empty"}`}
                        data-testid="dev-code-preview"
                      >
                        {code || "型号_机位_代称"}
                      </span>
                    </div>

                    {lastCamera ? (
                      <p className="text-xs" role="status">
                        已登记 <span className="mono">{lastCamera}</span>
                      </p>
                    ) : null}

                    <button
                      type="submit"
                      data-testid="dev-submit"
                      className="btn btn--primary"
                    >
                      登记相机
                    </button>
                  </form>
                </div>
              </div>

              <div className="card">
                <div className="card__head">
                  <span className="card__title">登记存储卡</span>
                  <span className="card__hint">一卡一机</span>
                </div>
                <div className="card__body">
                  <form
                    className="stack stack--lg"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void addCard();
                    }}
                  >
                    {/* 插卡绑定(推荐):不绑物理卡,之后只能靠「卷标==标签」认卡,
                        改卷标/同名卡都会认错(用户指正的登记盲区)。绑定 =
                        当场在卡根写身份指纹,今后凭指纹强匹配 */}
                    {/* Select 是 Field 的直接子级:cloneElement 注入的
                        aria-describedby 才能真落到触发器上(opus 评审 P2) */}
                    <Field
                      label="绑定已插入的卡(推荐)"
                      htmlFor="card-bind"
                      hint={
                        bindMount
                          ? "登记时会在这张卡上写入身份指纹,今后凭指纹认卡"
                          : "插入卡并选择后,凭指纹强匹配;不绑定则只按卷标弱匹配"
                      }
                    >
                      <Select
                        id="card-bind"
                        testId="card-bind"
                        value={bindMount}
                        onChange={(next) => {
                          setBindMount(next);
                          setBindStale(false);
                          const vol = volumes.find((v) => v.mountPath === next);
                          if (vol) setCardLabel(vol.name);
                        }}
                        options={[
                          { value: "", label: "不绑定(手工登记)" },
                          ...volumes
                            .filter((v) => !v.isSystem)
                            .map((v) => ({
                              value: v.mountPath,
                              label: `${v.name}（${v.mountPath} · ${formatBytes(v.capacityBytes, 0)}）`,
                            })),
                        ]}
                      />
                    </Field>
                    <div className="row-inline">
                      <button
                        type="button"
                        className="btn btn--sm"
                        data-testid="card-bind-refresh"
                        disabled={bindRefreshing}
                        onClick={() => void refreshBindVolumes()}
                      >
                        {bindRefreshing ? "刷新中…" : "刷新卷列表"}
                      </button>
                      {bindStale ? (
                        <span className="text-xs text-warn" role="alert">
                          之前选的卡已拔出,请重新选择
                        </span>
                      ) : null}
                    </div>

                    <Field
                      label="卡面标签"
                      htmlFor="card-label"
                      error={
                        cardSubmitted && !cardLabel.trim() ? "请填写卡面标签" : undefined
                      }
                    >
                      <input
                        id="card-label"
                        className="input input--mono"
                        type="text"
                        value={cardLabel}
                        placeholder="CFE-01"
                        onChange={(e) => setCardLabel(e.currentTarget.value)}
                      />
                    </Field>

                    <Field
                      label="所属相机"
                      htmlFor="card-camera"
                      error={
                        cardSubmitted && !cardCameraId ? "请选择所属相机" : undefined
                      }
                    >
                      <Select
                        id="card-camera"
                        value={cardCameraId}
                        onChange={setCardCameraId}
                        options={cameras.map((camera) => ({
                          value: camera.id,
                          label: `${camera.model} · ${camera.code}`,
                        }))}
                      />
                    </Field>

                    <div className="form-grid form-grid--2">
                      <Field
                        label="容量"
                        htmlFor="card-capacity"
                        hint={boundVolume ? "由所绑卡自动带出" : undefined}
                      >
                        {boundVolume ? (
                          <input
                            id="card-capacity"
                            className="input input--mono"
                            type="text"
                            readOnly
                            disabled
                            value={formatBytes(boundVolume.capacityBytes, 0)}
                          />
                        ) : (
                          <Select
                            id="card-capacity"
                            value={String(cardCapacity)}
                            onChange={(next) => setCardCapacity(Number(next))}
                            options={CAPACITY_OPTIONS.map((size) => ({
                              value: String(size),
                              label: `${size} GB`,
                            }))}
                          />
                        )}
                      </Field>

                      <Field label="序列号" htmlFor="card-serial">
                        <input
                          id="card-serial"
                          className="input input--mono"
                          type="text"
                          value={cardSerial}
                          placeholder="选填"
                          onChange={(e) => setCardSerial(e.currentTarget.value)}
                        />
                      </Field>
                    </div>

                    {lastCard ? (
                      <p className="text-xs" role="status">
                        已登记 <span className="mono">{lastCard}</span>
                      </p>
                    ) : null}

                    <button type="submit" className="btn">
                      登记存储卡
                    </button>
                  </form>
                </div>
              </div>
            </div>

            <div className="stack stack--lg">

              <section>
                <div className="section__head">
                  <h2 className="section__title">相机</h2>
                  <span className="card__hint">{cameras.length} 台</span>
                </div>
                <div className="list">
                  <div className="list__head cameras__head">
                    <span>型号 / 编码</span>
                    <span>机位</span>
                    <span>卡</span>
                    <span />
                  </div>
                  {cameras.map((camera) => (
                    <div
                      className="list__row cameras__row"
                      data-testid="camera-row"
                      key={camera.id}
                    >
                      <span className="projects__name truncate">
                        {camera.model}
                        <span className="projects__folder">{camera.code}</span>
                      </span>
                      <span className="projects__cell projects__cell--mono">
                        {camera.position}
                      </span>
                      <span className="projects__cell projects__cell--mono">
                        {cardCountByCamera.get(camera.id) ?? 0}
                      </span>
                      <button
                        type="button"
                        className="btn btn--ghost btn--icon btn--sm"
                        aria-label={`删除相机 ${camera.model}`}
                        onClick={() => {
                          const owned = cardCountByCamera.get(camera.id) ?? 0;
                          setConfirm({
                            title: `删除相机 ${camera.model}（${camera.code}）？`,
                            message:
                              owned > 0
                                ? `其名下 ${owned} 张卡的登记会一并移除。登记表全项目共享，删除后无法撤销。`
                                : "登记表全项目共享，删除后无法撤销。",
                            confirmLabel: "删除相机",
                            onConfirm: async () => {
                              // 等后端确实删掉了再动本地列表;失败走 toast(级联
                              // 删除中断时后端消息才知道真实状态)
                              try {
                                await api.deleteCamera(camera.id);
                                dispatch({
                                  type: "cameraRemoved",
                                  cameraId: camera.id,
                                });
                              } catch (err) {
                                notify(
                                  "error",
                                  "device-delete-failed",
                                  `删除相机 ${camera.model} 失败：${
                                    err instanceof Error ? err.message : String(err)
                                  }`,
                                );
                              }
                            },
                          });
                        }}
                      >
                        <IconTrash />
                      </button>
                    </div>
                  ))}
                  {cameras.length === 0 ? (
                    <EmptyState art={<IllCameraEmpty />}>还没有登记相机。</EmptyState>
                  ) : null}
                </div>
              </section>

              <section>
                <div className="section__head">
                  <h2 className="section__title">存储卡</h2>
                  <span className="card__hint">{cards.length} 张</span>
                </div>
                <div className="list">
                  <div className="list__head cards__head">
                    <span>标签</span>
                    <span>所属相机</span>
                    <span>容量</span>
                    <span />
                  </div>
                  {cards.map((card) => {
                    const camera = cameras.find((c) => c.id === card.cameraId);
                    return (
                      <div className="list__row cards__row" key={card.id}>
                        <span className="row-inline">
                          <Badge mono>{card.label}</Badge>
                          {card.volumeUid ? (
                            <span title="登记时已绑定物理卡,凭指纹强匹配">
                              <Badge tone="ok">指纹</Badge>
                            </span>
                          ) : (
                            <span title="未绑定物理卡,只能按卷标弱匹配">
                              <Badge tone="warn">卷标</Badge>
                            </span>
                          )}
                        </span>
                        <span className="projects__name truncate">
                          {camera?.model ?? "未关联"}
                          <span className="projects__folder">
                            {camera?.code ?? card.serial ?? "—"}
                          </span>
                        </span>
                        <span className="projects__cell projects__cell--mono">
                          {formatBytes(card.capacityBytes, 0)}
                        </span>
                        <button
                          type="button"
                          className="btn btn--ghost btn--icon btn--sm"
                          aria-label={`删除存储卡 ${card.label}`}
                          onClick={() =>
                            setConfirm({
                              title: `删除存储卡 ${card.label}？`,
                              message: "登记表全项目共享，删除后无法撤销。",
                              confirmLabel: "删除存储卡",
                              onConfirm: async () => {
                                try {
                                  await api.deleteStorageCard(card.id);
                                  dispatch({ type: "cardRemoved", cardId: card.id });
                                } catch (err) {
                                  notify(
                                    "error",
                                    "device-delete-failed",
                                    `删除存储卡 ${card.label} 失败：${
                                      err instanceof Error ? err.message : String(err)
                                    }`,
                                  );
                                }
                              },
                            })
                          }
                        >
                          <IconTrash />
                        </button>
                      </div>
                    );
                  })}
                  {cards.length === 0 ? (
                    <EmptyState art={<IllCardsEmpty />}>还没有登记存储卡。</EmptyState>
                  ) : null}
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog request={confirm} onCancel={() => setConfirm(null)} />
    </>
  );
}
