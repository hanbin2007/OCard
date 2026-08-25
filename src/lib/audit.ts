/**
 * 审计事件的展示口径（PRD §5.10）。
 *
 * 这个文件只干一件事：把后端下发的一条审计记录，翻成界面能安全渲染的一行。
 * "安全"是硬要求——`AuditEventDto.data` 的类型是 `unknown`，结构随 kind 而异、
 * 由 Rust 侧决定、并且会随版本演进。因此这里的每一次取值都必须先做运行时探测：
 *
 *   ① 不认识的 kind 照样渲染（回落成原始字符串 + 保守语气色），绝不丢记录；
 *   ② data 是 null / 数组 / 字符串 / 深层对象 / 缺字段，都只是"少显示一点"，
 *      不允许抛异常把整个抽屉炸掉；
 *   ③ 一条记录看不懂时宁可露出生键值，也不留空白——空白会让人以为"没发生什么"。
 */

import type { AuditEventDto, KnownAuditKind } from "../api/types";
import type { BadgeTone } from "../components/ui";
import { formatBytes, formatDuration, formatTimestamp } from "./format";

/** 事件所属的业务环节，对应顶部过滤 chips */
export type AuditGroup = "copy" | "sorting" | "delivery" | "transcode" | "other";

/** 过滤 chip 的取值：分组 +「全部」 */
export type AuditGroupFilter = AuditGroup | "all";

export const AUDIT_GROUP_FILTERS: ReadonlyArray<{
  id: AuditGroupFilter;
  label: string;
}> = [
  { id: "all", label: "全部" },
  { id: "copy", label: "拷卡" },
  { id: "sorting", label: "分类" },
  { id: "delivery", label: "交付" },
  { id: "transcode", label: "转码" },
];

export interface AuditKindMeta {
  /** 中文人话标签；未收录的 kind 回落成原始 kind 字符串 */
  label: string;
  /** 语气色：完成=绿，失败=红，取消/破坏性=琥珀，进行中与常规动作=中性 */
  tone: BadgeTone;
  group: AuditGroup;
  /** 失败或取消——「只看失败与取消」快捷过滤就是按这一位筛的 */
  abnormal: boolean;
  /** 前端是否收录了这个 kind。false 时 label 是原始字符串 */
  known: boolean;
}

/**
 * 已知 kind 的呈现表。**这不是白名单**：查不到的 kind 走下面的启发式回落，
 * 依然会显示出来。登记类事件属于全局 registry 日志，不出现在项目级。
 *
 * 关于 `trash_emptied` 取 danger 而不是 ok：它是全应用**唯一**真正物理删除的
 * 动作，在一份用于事后追责的日志里，它比"绿色的完成"更该被一眼看见。
 * 它不是失败，所以 abnormal 仍为 false，不会混进失败过滤。
 */
const KIND_META: Record<KnownAuditKind, Omit<AuditKindMeta, "known">> = {
  copy_started: { label: "开始拷卡", tone: "neutral", group: "copy", abnormal: false },
  copy_completed: { label: "拷卡完成", tone: "ok", group: "copy", abnormal: false },
  copy_file_failed: {
    label: "单文件拷贝失败",
    tone: "danger",
    group: "copy",
    abnormal: true,
  },

  assets_moved: { label: "素材归类", tone: "neutral", group: "sorting", abnormal: false },
  assets_curated: { label: "标记精选", tone: "neutral", group: "sorting", abnormal: false },
  assets_trashed: { label: "移入回收站", tone: "warn", group: "sorting", abnormal: false },
  assets_restored: {
    label: "从回收站恢复",
    tone: "neutral",
    group: "sorting",
    abnormal: false,
  },
  trash_emptied: { label: "清空回收站", tone: "danger", group: "sorting", abnormal: false },

  delivery_built: { label: "交付包已生成", tone: "ok", group: "delivery", abnormal: false },
  delivery_cancelled: {
    label: "交付已取消",
    tone: "warn",
    group: "delivery",
    abnormal: true,
  },

  transcode_started: {
    label: "开始转码",
    tone: "neutral",
    group: "transcode",
    abnormal: false,
  },
  transcode_completed: {
    label: "转码完成",
    tone: "ok",
    group: "transcode",
    abnormal: false,
  },
  transcode_cancelled: {
    label: "转码已取消",
    tone: "warn",
    group: "transcode",
    abnormal: true,
  },
  transcode_failed: {
    label: "转码失败",
    tone: "danger",
    group: "transcode",
    abnormal: true,
  },
};

/**
 * 前端已收录的 kind 清单。
 * 类型是 `Record<KnownAuditKind, …>`，所以 types.ts 里加了新 kind 却忘了在这里
 * 补呈现口径，编译期就红——不会等到界面上冒出一串 snake_case 才发现。
 */
export const KNOWN_AUDIT_KINDS = Object.keys(KIND_META) as KnownAuditKind[];

/** 按 kind 前缀猜分组：后端加的新 kind 多半仍属于这四个环节之一 */
function inferGroup(kind: string): AuditGroup {
  if (kind.startsWith("copy_")) return "copy";
  if (kind.startsWith("assets_") || kind.startsWith("trash_")) return "sorting";
  if (kind.startsWith("delivery_")) return "delivery";
  if (kind.startsWith("transcode_")) return "transcode";
  return "other";
}

/**
 * 取某个 kind 的呈现口径。未收录时的猜测**只朝"可能有问题"的方向**：
 * 名字里带 failed/cancel 的按异常呈现，其余一律中性。
 * 反过来猜"这大概是成功"是危险的——把没看懂的事情涂成绿色等于替后端背书。
 */
export function auditKindMeta(kind: unknown): AuditKindMeta {
  const raw = typeof kind === "string" ? kind.trim() : "";
  if (Object.prototype.hasOwnProperty.call(KIND_META, raw)) {
    return { ...KIND_META[raw as KnownAuditKind], known: true };
  }

  const lower = raw.toLowerCase();
  const failed = lower.includes("fail") || lower.includes("error");
  const cancelled = lower.includes("cancel") || lower.includes("abort");
  return {
    label: raw || "未知事件",
    tone: failed ? "danger" : cancelled ? "warn" : "neutral",
    group: inferGroup(raw),
    abnormal: failed || cancelled,
    known: false,
  };
}

/* ------------------------------------------------------------------ *
 * 关键明细：从 unknown data 里挑一行人能读的东西
 * ------------------------------------------------------------------ */

export interface AuditDetail {
  /** 中文字段名；回落到生键值时是原始 key */
  label?: string;
  value: string;
}

/** 一行最多摆几项——再多就读不动了，完整内容挂在 title 上 */
export const MAX_AUDIT_DETAILS = 4;

/** 单个文本值的最大长度：路径与错误原文都可能很长，截断但保留头部信息 */
const MAX_TEXT_LEN = 72;

type ValueKind = "count" | "bytes" | "seconds" | "text" | "mode" | "tier" | "bool";

/**
 * 已知字段的取用顺序 = 重要性顺序。排在前面的先占掉那 4 个位置。
 * 失败原因排第一：一条失败记录里，"为什么"永远比"多少个"重要。
 * 同一组里的多个 key 是后端不同版本/不同 DTO 的同义写法，命中一个就够。
 */
const KNOWN_FIELDS: ReadonlyArray<{
  keys: readonly string[];
  label: string;
  kind: ValueKind;
}> = [
  { keys: ["message", "error", "reason"], label: "原因", kind: "text" },
  { keys: ["rel", "fileName", "file", "path"], label: "文件", kind: "text" },
  { keys: ["succeeded"], label: "成功", kind: "count" },
  { keys: ["failed", "failures"], label: "失败", kind: "count" },
  { keys: ["converted"], label: "已转码", kind: "count" },
  { keys: ["removed"], label: "已删除", kind: "count" },
  { keys: ["restored"], label: "已恢复", kind: "count" },
  { keys: ["count"], label: "条目", kind: "count" },
  { keys: ["packages"], label: "包数", kind: "count" },
  { keys: ["files", "fileCount"], label: "文件数", kind: "count" },
  { keys: ["total"], label: "总数", kind: "count" },
  { keys: ["mode"], label: "模式", kind: "mode" },
  { keys: ["tier"], label: "档位", kind: "tier" },
  // 编码器排在「跳过 / 已有」这类次要计数之前：事后追责问的是"这批文件是谁转的"，
  // 而不是"顺带跳过了几个"
  { keys: ["encoder", "usedEncoder"], label: "编码器", kind: "text" },
  { keys: ["categoryName", "category"], label: "分类", kind: "text" },
  { keys: ["volumeName", "volume"], label: "源卷", kind: "text" },
  { keys: ["targetFolder"], label: "目标夹", kind: "text" },
  { keys: ["skipped"], label: "跳过", kind: "count" },
  { keys: ["alreadyTranscoded", "alreadyArchived"], label: "已有", kind: "count" },
  {
    keys: ["totalBytes", "bytes", "bytesCopied", "freedBytes"],
    label: "容量",
    kind: "bytes",
  },
  { keys: ["durationSec", "durationSeconds"], label: "用时", kind: "seconds" },
  { keys: ["destinations"], label: "目的地", kind: "count" },
  { keys: ["attempt"], label: "尝试", kind: "count" },
  { keys: ["verified"], label: "已校验", kind: "bool" },
  { keys: ["outputDir"], label: "输出", kind: "text" },
];

const MODE_LABEL: Record<string, string> = { proxy: "代理", archive: "归档" };
const TIER_LABEL: Record<string, string> = {
  quality: "高质量",
  balanced: "均衡",
  compact: "小体积",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function collapse(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_TEXT_LEN) return flat;
  return `${flat.slice(0, MAX_TEXT_LEN - 1)}…`;
}

/**
 * 通用兜底格式化：只处理基本类型与数组长度。
 * 嵌套对象一律返回 null（跳过）——`[object Object]` 不是信息，是噪音。
 */
function formatLoose(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return collapse(value) || null;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return `${value.length} 项`;
  return null;
}

/** 按字段语义格式化；类型对不上就退回通用兜底，绝不抛 */
function formatField(value: unknown, kind: ValueKind): string | null {
  switch (kind) {
    case "count":
      if (Array.isArray(value)) return String(value.length);
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
      return formatLoose(value);
    case "bytes":
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return formatBytes(value);
      }
      return formatLoose(value);
    case "seconds":
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return formatDuration(value);
      }
      return formatLoose(value);
    case "mode":
      if (typeof value === "string" && MODE_LABEL[value]) return MODE_LABEL[value];
      return formatLoose(value);
    case "tier":
      if (typeof value === "string" && TIER_LABEL[value]) return TIER_LABEL[value];
      return formatLoose(value);
    case "bool":
      if (typeof value === "boolean") return value ? "是" : "否";
      return formatLoose(value);
    case "text":
    default:
      return formatLoose(value);
  }
}

/**
 * 从 data 里挑出最多 `limit` 项关键明细。
 * 任何形状的输入都只会得到"少一点"的结果，不会得到异常。
 */
export function auditDetails(data: unknown, limit = MAX_AUDIT_DETAILS): AuditDetail[] {
  const record = asRecord(data);
  if (!record) {
    // data 本身就是标量或数组：能读就直接读，读不出就是空
    const loose = formatLoose(data);
    return loose ? [{ value: loose }] : [];
  }

  const picked: AuditDetail[] = [];
  for (const field of KNOWN_FIELDS) {
    if (picked.length >= limit) break;
    for (const key of field.keys) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      const value = formatField(record[key], field.kind);
      if (value === null) continue;
      picked.push({ label: field.label, value });
      break; // 同义 key 只取第一个命中的
    }
  }
  if (picked.length > 0) return picked;

  // 一个已知字段都没命中（新 kind 带了全新的结构）：露出生键值。
  // 显示不出中文标签总好过显示一片空白——空白会被读成"什么都没发生"。
  for (const [key, value] of Object.entries(record)) {
    if (picked.length >= limit) break;
    const loose = formatLoose(value);
    if (loose === null) continue;
    picked.push({ label: key, value: loose });
  }
  return picked;
}

/** 明细拼成单行文本，用于 title 与读屏播报 */
export function auditDetailText(details: readonly AuditDetail[]): string {
  return details
    .map((d) => (d.label ? `${d.label} ${d.value}` : d.value))
    .join(" · ");
}

/* ------------------------------------------------------------------ *
 * 一行记录
 * ------------------------------------------------------------------ */

export interface AuditRow {
  /** React key：ts + kind 可能重复，带上下标才稳定唯一 */
  key: string;
  /** 原始 RFC3339 时间戳，作为 <time datetime> 与 title 的真值 */
  ts: string;
  /** `MM-DD HH:mm`；时间戳非法时是 `—` */
  time: string;
  machine: string;
  operator: string;
  kind: string;
  meta: AuditKindMeta;
  details: AuditDetail[];
  detailText: string;
}

const UNKNOWN_MACHINE = "未知机器";
const UNKNOWN_OPERATOR = "未署名";

function asText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * 把一条原始记录归一成可渲染的行。
 *
 * 入参故意收成 `unknown` 而不是 `AuditEventDto`：类型声明只是与后端的约定，
 * 真到了损坏的 journal 行或版本错位时，运行时拿到什么谁也保证不了。
 * 这里的每一步都能吃下"根本不是对象"的输入。
 */
export function toAuditRow(raw: unknown, index: number): AuditRow {
  const record = asRecord(raw) ?? {};
  const kind = asText(record.kind, "");
  const ts = asText(record.ts, "");
  const details = auditDetails(record.data);
  return {
    key: `${ts || "?"}-${kind || "?"}-${index}`,
    ts,
    time: ts ? formatTimestamp(ts) : "—",
    machine: asText(record.machine, UNKNOWN_MACHINE),
    operator: asText(record.operator, UNKNOWN_OPERATOR),
    kind,
    meta: auditKindMeta(kind),
    details,
    detailText: auditDetailText(details),
  };
}

/** 整批归一。入参不是数组时按空处理——上层据此走空态而不是崩溃 */
export function toAuditRows(raw: AuditEventDto[] | unknown): AuditRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => toAuditRow(item, index));
}

/** 过滤判定：分组 chip 与「只看失败与取消」是与的关系 */
export function matchesAuditFilter(
  row: AuditRow,
  group: AuditGroupFilter,
  abnormalOnly: boolean,
): boolean {
  if (abnormalOnly && !row.meta.abnormal) return false;
  if (group !== "all" && row.meta.group !== group) return false;
  return true;
}

/** 每个分组 chip 上的计数（受「只看失败与取消」影响，所见即所得） */
export function auditGroupCounts(
  rows: readonly AuditRow[],
  abnormalOnly: boolean,
): Record<AuditGroupFilter, number> {
  const counts: Record<AuditGroupFilter, number> = {
    all: 0,
    copy: 0,
    sorting: 0,
    delivery: 0,
    transcode: 0,
    other: 0,
  };
  for (const row of rows) {
    if (abnormalOnly && !row.meta.abnormal) continue;
    counts.all += 1;
    counts[row.meta.group] += 1;
  }
  return counts;
}
