/**
 * AI 判定角标:网格格子与全屏预览共用同一套呈现(评审 3.2/D1——
 * 大图本是做最终取舍的地方,不能比网格信息还少)。
 * AI 只标注,不触发任何文件操作。
 */

import type { SortingAsset } from "../api/types";
import { Badge } from "./ui";

/** 后端 score 量纲是 0–100，低分阈值按百分制取 25 */
export const LOW_SCORE_AT = 25;

export function JudgementBadges({
  judgement,
  showSuggestedKeep = false,
}: {
  judgement?: SortingAsset["judgement"];
  /**
   * 是否呈现「建议保留」。**默认不呈现**,只有能同时看见同组其他张的地方
   * 才该传 true(即连拍组的全屏铺开层)。
   *
   * 后端的 `suggested_keep` 语义是「**组内**首选」——无组的单张一律为 false
   * (analysis.rs 明写「无组时高分单张也不标,避免噪声」)。所以把它挂在网格的
   * 折叠组格子上,读者看到的是一个没有比较对象的「建议保留」:既不知道它在跟谁比,
   * 也会误以为其余没这个角标的照片是「不建议保留」。默认关掉是 fail-closed:
   * 新加的调用点不会又把它漏到组外面去。
   */
  showSuggestedKeep?: boolean;
}) {
  if (!judgement) return null;
  const faces = judgement.faces;
  return (
    <span className="asset__judge" data-testid="asset-judgement">
      {showSuggestedKeep && judgement.suggestedKeep ? (
        <Badge tone="ok">建议保留</Badge>
      ) : null}
      {/*
        只有"确实检出了脸"才出角标。
        faces == null 是**检测不可用**、0 是**确实没有脸**，两者都不出角标：
        网格里一个中性角标承载不了这个区别，硬塞会把"不知道"说成"没有"。
        需要区分时去全屏预览看逐项说明。
      */}
      {typeof faces === "number" && faces > 0 ? (
        <Badge tone="neutral">
          <span data-testid="judge-faces">{faces} 人</span>
        </Badge>
      ) : null}
      {judgement.blurry ? <Badge tone="warn">糊</Badge> : null}
      {judgement.overExposed ? <Badge tone="warn">过曝</Badge> : null}
      {judgement.underExposed ? <Badge tone="warn">欠曝</Badge> : null}
      {/* 分数只用区间表达，不显示数值 */}
      {judgement.score < LOW_SCORE_AT ? (
        <span className="dot judge-dot--low" title="低分" data-testid="judge-low" />
      ) : null}
    </span>
  );
}
