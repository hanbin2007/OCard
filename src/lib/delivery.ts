/** 交付打包的展示逻辑（PRD §5.7）。纯函数，便于单测。 */

import type { DeliveryFailure, DeliverySummary } from "../api/types";

export interface ClassifiedFailures {
  /** 重跑时目标已存在——零覆盖策略的正常结果，不是事故 */
  existing: DeliveryFailure[];
  /** 真正的错误 */
  errors: DeliveryFailure[];
}

/**
 * 把失败项分成「重跑已存在」与「真失败」。
 *
 * 优先用后端给的 `kind`；后端没给时按 message 兜底判定——
 * 字符串匹配是权宜之计，长期应由后端给稳定机器码。
 */
export function classifyFailures(failures: DeliveryFailure[]): ClassifiedFailures {
  const existing: DeliveryFailure[] = [];
  const errors: DeliveryFailure[] = [];
  for (const failure of failures) {
    const isExisting =
      failure.kind === "already-exists" ||
      (failure.kind === undefined && /已存在|already exists/i.test(failure.message));
    if (isExisting) existing.push(failure);
    else errors.push(failure);
  }
  return { existing, errors };
}

/** 结果整体是否算「干净成功」（没有真失败） */
export function isCleanDelivery(summary: DeliverySummary): boolean {
  return classifyFailures(summary.failures).errors.length === 0;
}

/** 结果面板的一句话摘要 */
export function deliveryHeadline(summary: DeliverySummary): string {
  const { existing, errors } = classifyFailures(summary.failures);
  const base = `已生成 ${summary.packages.length} 个交付包，共 ${summary.totalFiles} 个文件`;
  if (errors.length > 0) return `${base}；${errors.length} 个文件打包失败`;
  if (existing.length > 0) {
    return `${base}；${existing.length} 个此前已打包，本次跳过`;
  }
  return base;
}
