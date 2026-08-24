/** 屏 3：设备登记（相机 → 实时编码预览；存储卡与相机关联）。 */

import { useMemo, useState } from "react";
import * as api from "../api";
import { IconTrash } from "../components/Icon";
import { TopBar } from "../components/TopBar";
import { Badge, EmptyState, Field } from "../components/ui";
import { formatBytes } from "../lib/format";
import { buildCameraCode } from "../lib/naming";
import { validateNewCamera } from "../lib/validation";
import { useStore } from "../state/store";

const GB = 1024 ** 3;
const CAPACITY_OPTIONS = [128, 256, 512, 1024];

export function DevicesScreen() {
  const { state, dispatch } = useStore();
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
    const camera = await api.createCamera({
      model,
      position,
      operatorAlias: alias,
      note,
    });
    dispatch({ type: "cameraCreated", camera });
    setModel("");
    setPosition("");
    setAlias("");
    setNote("");
    setCameraSubmitted(false);
  }

  async function addCard() {
    setCardSubmitted(true);
    if (!cardLabel.trim() || !cardCameraId) return;
    const card = await api.createStorageCard({
      label: cardLabel,
      cameraId: cardCameraId,
      capacityBytes: cardCapacity * GB,
      serial: cardSerial,
    });
    dispatch({ type: "cardCreated", card });
    setCardLabel("");
    setCardSerial("");
    setCardSubmitted(false);
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
                  <div className="stack stack--lg">
                    <Field
                      label="型号"
                      htmlFor="cam-model"
                      hint="编码时自动去空格，如 DJI Ronin 4D → DJIRonin4D"
                      error={cameraSubmitted ? cameraValidation.errors.model : undefined}
                    >
                      <input
                        id="cam-model"
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
                        data-testid="camera-code-preview"
                      >
                        {code || "型号_机位_代称"}
                      </span>
                    </div>

                    <button type="button" className="btn btn--primary" onClick={addCamera}>
                      登记相机
                    </button>
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card__head">
                  <span className="card__title">登记存储卡</span>
                  <span className="card__hint">一卡一机</span>
                </div>
                <div className="card__body">
                  <div className="stack stack--lg">
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
                      <select
                        id="card-camera"
                        className="select"
                        value={cardCameraId}
                        onChange={(e) => setCardCameraId(e.currentTarget.value)}
                      >
                        <option value="">请选择…</option>
                        {cameras.map((camera) => (
                          <option key={camera.id} value={camera.id}>
                            {camera.model} · {camera.code}
                          </option>
                        ))}
                      </select>
                    </Field>

                    <div className="form-grid form-grid--2">
                      <Field label="容量" htmlFor="card-capacity">
                        <select
                          id="card-capacity"
                          className="select"
                          value={cardCapacity}
                          onChange={(e) => setCardCapacity(Number(e.currentTarget.value))}
                        >
                          {CAPACITY_OPTIONS.map((size) => (
                            <option key={size} value={size}>
                              {size} GB
                            </option>
                          ))}
                        </select>
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

                    <button type="button" className="btn" onClick={addCard}>
                      登记存储卡
                    </button>
                  </div>
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
                    <div className="list__row cameras__row" key={camera.id}>
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
                          void api.deleteCamera(camera.id);
                          dispatch({ type: "cameraRemoved", cameraId: camera.id });
                        }}
                      >
                        <IconTrash />
                      </button>
                    </div>
                  ))}
                  {cameras.length === 0 ? (
                    <EmptyState>还没有登记相机。</EmptyState>
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
                        <span>
                          <Badge mono>{card.label}</Badge>
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
                          onClick={() => {
                            void api.deleteStorageCard(card.id);
                            dispatch({ type: "cardRemoved", cardId: card.id });
                          }}
                        >
                          <IconTrash />
                        </button>
                      </div>
                    );
                  })}
                  {cards.length === 0 ? (
                    <EmptyState>还没有登记存储卡。</EmptyState>
                  ) : null}
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
