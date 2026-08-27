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

export const SCENARIO_LABEL: Record<Scenario, string> = {
  A: "工况 A · 视频剪辑",
  B: "工况 B · 纯拍照",
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
  copied: "已拷",
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
  paused: "已挂起",
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
  nas: "NAS 主",
  local: "本机",
  external: "移动盘",
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
