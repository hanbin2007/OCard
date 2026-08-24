/** 交付打包的展示逻辑（PRD §5.7）。纯函数，便于单测。 */

import type { DeliveryFailure, DeliverySummary } from "../api/types";

export interface ClassifiedFailures {
  /** 同名但内容不同 → **未交付**，必须人工核对（红） */
  nameCollisions: DeliveryFailure[];
  /** 文件已交付成功，只是清单没写上 → 重跑可补齐（黄） */
  manifestErrors: DeliveryFailure[];
  /** 其他真失败（红） */
  errors: DeliveryFailure[];
}

/**
 * 按后端给的 `kind` 分类。
 *
 * 「此前已交付且 hash 一致」不再走 failures，而是 `summary.alreadyDelivered` 计数，
 * 所以这里不再有任何「已存在」的字符串猜测——语义完全由后端机器码决定。
 * 缺省 kind 一律按真失败处理：宁可多报，不可把未交付说成没事。
 */
export function classifyFailures(failures: DeliveryFailure[]): ClassifiedFailures {
  const nameCollisions: DeliveryFailure[] = [];
  const manifestErrors: DeliveryFailure[] = [];
  const errors: DeliveryFailure[] = [];
  for (const failure of failures) {
    if (failure.kind === "name-collision") nameCollisions.push(failure);
    else if (failure.kind === "manifest-error") manifestErrors.push(failure);
    else errors.push(failure);
  }
  return { nameCollisions, manifestErrors, errors };
}

/** 是否没有「未交付」的硬失败（清单缺失不算——文件确实交付了） */
export function isCleanDelivery(summary: DeliverySummary): boolean {
  const { nameCollisions, errors } = classifyFailures(summary.failures);
  return nameCollisions.length === 0 && errors.length === 0;
}

/** 结果面板的一句话摘要 */
export function deliveryHeadline(summary: DeliverySummary): string {
  const { nameCollisions, manifestErrors, errors } = classifyFailures(
    summary.failures,
  );
  const parts = [
    `已生成 ${summary.packages.length} 个交付包，新交付 ${summary.totalFiles} 个文件`,
  ];
  if (summary.alreadyDelivered > 0) {
    parts.push(`已交付跳过 ${summary.alreadyDelivered} 个`);
  }
  const undelivered = nameCollisions.length + errors.length;
  if (undelivered > 0) parts.push(`${undelivered} 个未交付`);
  if (manifestErrors.length > 0) {
    parts.push(`${manifestErrors.length} 个清单缺失`);
  }
  return parts.join("；");
}
