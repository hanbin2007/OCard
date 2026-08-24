/** 全屏预览：左右切换、Esc 关闭（PRD §5.4 全屏对比）。 */

import { useEffect } from "react";
import type { SortingAsset } from "../api/types";
import { formatBytes, formatTimestamp } from "../lib/format";
import { IconArrowLeft, IconChevronRight, IconClose } from "./Icon";

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
  // 预览态的键盘处理独立于网格：这里是模态，别让按键穿透回去
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") onNext();
      else if (e.key === "ArrowLeft") onPrev();
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext]);

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
          onClick={onPrev}
        >
          <IconArrowLeft />
        </button>

        {asset.thumbnail ? (
          // v1 用缩略图放大；像素级查看等 media_indexer 的全尺寸解码接上再换
          <img className="lightbox__image" src={asset.thumbnail} alt={asset.fileName} />
        ) : (
          <div className="lightbox__image lightbox__image--empty">
            <span className="text-sm dim">该文件尚未生成预览</span>
          </div>
        )}

        <button
          type="button"
          className="btn btn--ghost btn--icon"
          data-testid="lightbox-next"
          aria-label="下一张"
          disabled={index >= total - 1}
          onClick={onNext}
        >
          <IconChevronRight />
        </button>
      </div>
    </div>
  );
}
