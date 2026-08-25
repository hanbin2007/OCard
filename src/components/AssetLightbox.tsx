/** 全屏预览：左右切换、Esc 关闭（PRD §5.4 全屏对比）。 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SortingAsset } from "../api/types";
import { formatBytes, formatTimestamp } from "../lib/format";
import { animateOnce } from "../lib/motion";
import { IconArrowLeft, IconChevronRight, IconClose } from "./Icon";

/** 换图时的横向位移量：够读出方向，又不至于把整张图甩出视野 */
const SWAP_SHIFT_PX = 18;
/** 与 CSS --dur-spring-fast 同一档（ζ=1，response 0.25s） */
const SWAP_DURATION_MS = 350;

export function AssetLightbox({
  asset,
  index,
  total,
  onClose,
  onPrev,
  onNext,
}: {
  asset: SortingAsset;
  index: number;
  total: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  // thumb:// 取图可能 404：转占位而不是留一个碎图
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [asset.id]);

  const mediaRef = useRef<HTMLElement | null>(null);
  /** 上一次换图的方向：+1 下一张、−1 上一张 */
  const directionRef = useRef(1);
  /** 上一次真正播过动画的素材，用来区分"首次挂载"与"换了一张" */
  const lastAnimatedRef = useRef<string | null>(null);

  /*
   * 关闭不在这里包视图过渡：Esc 有可能先被网格的键盘流接走，
   * 两处各包一层会变成"过渡里再起过渡"（前一次被直接跳过）。
   * 统一由分类工作台那一侧负责，见 SortingScreen 的 closePreview。
   */
  const goPrev = useCallback(() => {
    directionRef.current = -1;
    onPrev();
  }, [onPrev]);
  const goNext = useCallback(() => {
    directionRef.current = 1;
    onNext();
  }, [onNext]);

  /**
   * 换图时让新图**从你要去的方向进来**（§8：中间帧要指向结果）。
   * 起始不透明度取 0.35 而不是 0：新图往往还没解码完，从全透明起会先闪一下白。
   * 只动 transform / opacity，图多大都不会引发重排。
   */
  useEffect(() => {
    const previous = lastAnimatedRef.current;
    lastAnimatedRef.current = asset.id;
    // 首次挂载由 CSS 关键帧 / 视图过渡负责；同一张重复触发也不重播
    if (previous === null || previous === asset.id) return;
    const el = mediaRef.current;
    if (!el) return;
    animateOnce(
      el,
      [
        {
          transform: `translate3d(${directionRef.current * SWAP_SHIFT_PX}px, 0, 0)`,
          opacity: 0.35,
        },
        { transform: "translate3d(0, 0, 0)", opacity: 1 },
      ],
      SWAP_DURATION_MS,
    );
  }, [asset.id]);

  // 预览态的键盘处理独立于网格：这里是模态，别让按键穿透回去
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") goNext();
      else if (e.key === "ArrowLeft") goPrev();
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, goPrev, goNext]);

  return (
    <div className="lightbox" data-testid="asset-lightbox" role="dialog" aria-modal="true"
      aria-label={`预览 ${asset.fileName}`}>
      <div className="lightbox__bar">
        <span className="mono text-sm truncate" title={asset.id}>
          {asset.fileName}
        </span>
        <span className="text-xs dim" data-testid="lightbox-position">
          {index + 1} / {total}
        </span>
        <span className="text-xs dim mono">{formatBytes(asset.sizeBytes)}</span>
        {asset.shotAt ? (
          <span className="text-xs dim mono">
            {formatTimestamp(asset.shotAt)}
            {asset.shotAtFallback ? "（推断）" : ""}
          </span>
        ) : null}
        {/*
          全屏预览是有地方把话说全的地方：这里必须把「检出 0 张脸」和
          「这次分析根本没做人脸检测」分开说，不能都留白让人自己脑补。
        */}
        {asset.judgement ? (
          <span className="text-xs dim" data-testid="lightbox-faces">
            {asset.judgement.faces == null
              ? "人脸检测不可用"
              : `检出人脸 ${asset.judgement.faces}`}
          </span>
        ) : null}
        <button
          type="button"
          className="btn btn--ghost btn--icon push-right"
          data-testid="lightbox-close"
          aria-label="关闭预览"
          onClick={onClose}
        >
          <IconClose />
        </button>
      </div>

      <div className="lightbox__stage">
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          data-testid="lightbox-prev"
          aria-label="上一张"
          disabled={index === 0}
          onClick={goPrev}
        >
          <IconArrowLeft />
        </button>

        {asset.thumbReady && asset.thumbnail && !failed ? (
          // v1 放大缩略图；像素级查看等 media_indexer 的全尺寸解码接上再换
          <img
            ref={(node) => {
              mediaRef.current = node;
            }}
            /* 与网格里那一格共用过渡名：支持的内核上，两者是同一个实体在形变 */
            style={{ viewTransitionName: "ocard-preview" }}
            className="lightbox__image"
            src={asset.thumbnail}
            alt={asset.fileName}
            data-testid="lightbox-image"
            onError={() => setFailed(true)}
          />
        ) : (
          <div
            ref={(node) => {
              mediaRef.current = node;
            }}
            style={{ viewTransitionName: "ocard-preview" }}
            className="lightbox__image lightbox__image--empty"
            data-testid="lightbox-no-image"
          >
            <span className="text-sm dim">
              {failed ? "预览暂不可用（缩略图未就绪或已失效）" : "该文件尚未生成预览"}
            </span>
          </div>
        )}

        <button
          type="button"
          className="btn btn--ghost btn--icon"
          data-testid="lightbox-next"
          aria-label="下一张"
          disabled={index >= total - 1}
          onClick={goNext}
        >
          <IconChevronRight />
        </button>
      </div>
    </div>
  );
}
