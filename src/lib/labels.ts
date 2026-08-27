/** 中文文案与状态色映射（界面文案一律中文）。 */

import type {
  CopyFileStatus,
  CopyTaskState,
  DestinationKind,
  DestinationState,
  ProjectStatus,
  Scenario,
} from "../api/types";
import type { BadgeTone } from "../components/ui";

/**
 * 术语原则(评审 7.x):主文案说人话,规范编号做附注——
 * 「视频项目/拍照项目」才是有区分度的信息,「工况 A/B」只为对照纸面规范保留。
 */
export const SCENARIO_LABEL: Record<Scenario, string> = {
  A: "视频项目（工况 A）",
  B: "拍照项目（工况 B）",
};

export const SCENARIO_SHORT: Record<Scenario, string> = {
  A: "A 视频",
  B: "B 拍照",
};

export const SCENARIO_DESC: Record<Scenario, string> = {
  A: "按 1–6 号固定夹建目录，原始素材按「日期_相机编码」入夹，可拷完自动转代理。",
  B: "建待分类/自定义分类/精选/其他，素材按「时段_相机编码」入待分类，走键盘分类流。",
};

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  draft: "待拷卡",
  copying: "拷卡中",
  sorting: "分类中",
  delivering: "交付中",
  done: "已完成",
};

export const PROJECT_STATUS_TONE: Record<ProjectStatus, BadgeTone> = {
  draft: "neutral",
  copying: "accent",
  sorting: "warn",
  delivering: "warn",
  done: "ok",
};

export const COPY_FILE_STATUS_LABEL: Record<CopyFileStatus, string> = {
  pending: "待拷",
  // 中间态自解释(评审 #25):「已拷」看起来像完事了,其实还差校验
  copied: "已拷·待校验",
  verified: "已校验",
  failed: "失败",
};

export const COPY_FILE_STATUS_TONE: Record<CopyFileStatus, BadgeTone> = {
  pending: "neutral",
  copied: "neutral",
  verified: "ok",
  failed: "danger",
};

export const TASK_STATE_LABEL: Record<CopyTaskState, string> = {
  confirming: "待确认",
  running: "拷贝中",
  verifying: "校验中",
  // 「挂起」是操作系统术语,现场语言是「暂停」(评审 H1)
  paused: "已暂停",
  done: "已完成",
  failed: "失败",
};

export const TASK_STATE_TONE: Record<CopyTaskState, BadgeTone> = {
  confirming: "neutral",
  running: "accent",
  verifying: "accent",
  paused: "warn",
  done: "ok",
  failed: "danger",
};

export const DESTINATION_KIND_LABEL: Record<DestinationKind, string> = {
  // 「NAS 主」语序生硬(评审 #24):对齐 PRD「NAS 主 + 本地/移动硬盘备」的语义
  nas: "NAS 主备份",
  local: "本机",
  external: "移动硬盘",
};

export const DESTINATION_STATE_LABEL: Record<DestinationState, string> = {
  idle: "待写入",
  writing: "写入中",
  verifying: "校验中",
  done: "已完成",
  error: "出错",
};

/**
 * 进度列文字。工况 B 有真实分母(已分类/总数);工况 A 未配用卡清单时
 * 只有素材量可说——如实说「已入库」,阶段状态由同行的状态徽标承载
 * (评审 5.8:注释不许承诺实现没有的「转码/交付」口径)。
 */
export function progressLabel(
  scenario: Scenario,
  sorted: number,
  total: number,
): string {
  if (total === 0) return "尚无素材";
  if (scenario === "A") return `${total} 个素材已入库`;
  return `${sorted} / ${total} 已分类`;
}
