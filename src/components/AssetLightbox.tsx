/** 全屏预览：左右切换、Esc 关闭（PRD §5.4 全屏对比）。 */

import { useEffect, useState } from "react";
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
  // thumb:// 取图可能 404：转占位而不是留一个碎图
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [asset.id]);

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

        {asset.thumbReady && asset.thumbnail && !failed ? (
          // v1 放大缩略图；像素级查看等 media_indexer 的全尺寸解码接上再换
          <img
            className="lightbox__image"
            src={asset.thumbnail}
            alt={asset.fileName}
            data-testid="lightbox-image"
            onError={() => setFailed(true)}
          />
        ) : (
          <div
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
          onClick={onNext}
        >
          <IconChevronRight />
        </button>
      </div>
    </div>
  );
}
