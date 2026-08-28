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
// 拷贝范围的判据与文案只有一份：见 copyScope.ts 顶部那段「为什么」
import { classifyCopyScope, formatScopeFolders } from "./copyScope";
import { formatBytes, formatDuration, formatTimestamp } from "./format";

/**
 * 当前的**扫描策略版本**，必须与 Rust 的 `core::manifest::SCAN_POLICY_VERSION`
 * 是同一个数。
 *
 * | 值 | 含义 |
 * |---|---|
 * | `0`（记录里缺这个字段）| **旧口径**：以「.」开头的条目一律跳过 |
 * | `1` | 当前口径：只排除明确列举的系统项（废纸篓、索引、`.DS_Store` …） |
 *
 * 为什么前端要硬编码一份：这个数字要判的是**审计日志里的历史行**，判据是
 * 「这条记录里的版本 < 我这一版」，而历史行里没有「当时的当前版本」可读。
 * 后端也没有把它作为独立命令暴露——`CopyTaskDto.scanPolicyVersion` 只覆盖
 * **未完成**的任务（`rebuild_tasks` 只重建未完成清单），够不到升级前就已经
 * `completed` 的那批，而那批正是本标注唯一要救的对象。
 *
 * **防漂移**：`audit.test.ts` 里有一条测试直接读
 * `src-tauri/src/core/manifest.rs`，把这两个数字钉在一起。Rust 侧递增而这里
 * 忘了跟，那条测试当场变红——不会等到界面上把新口径的记录标成旧口径才发现。
 */
export const SCAN_POLICY_VERSION = 1;

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
 *
 * 这张表只按 kind 取色。有些事件光看 kind 定不了性（`copy_completed` 的整卷
 * 与部分拷贝是两件事），那部分由 `auditEventMeta` 结合 data 再压一道。
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
 * 扫描策略版本：认出「旧口径下跑出来的那条绿色的完成」
 * ------------------------------------------------------------------ */

/**
 * 会带 `scanPolicyVersion` 的两个事件（后端 `commands::mod` / `commands::tasks`）。
 * 只有这两个 kind 缺字段才说明问题；别的事件本来就没有这个字段。
 */
const SCAN_POLICY_KINDS: ReadonlySet<string> = new Set([
  "copy_started",
  "copy_completed",
]);

/** 明细里这条标注的字段名 */
const SCAN_POLICY_LABEL = "扫描口径";

export type ScanPolicyState =
  /** 记录自证跑在当前口径上：无需标注 */
  | { state: "current" }
  /** 旧口径（字段缺失按 0 记）：当时以「.」开头的条目一律跳过 */
  | { state: "legacy"; version: number }
  /** 有值但读不出：**不许**当成当前口径放绿灯 */
  | { state: "unreadable"; raw: string | null };

/**
 * 判定一条审计记录出自哪一版扫描口径。非 copy_started/copy_completed 返回 null。
 *
 * **缺字段 = 旧口径**，这是后端定的判据（`manifest::SCAN_POLICY_VERSION` 的注释）。
 * 也因此，`data` 根本不是对象（损坏行、老版本补录）同样算旧口径——它一样
 * 证明不了自己跑在新口径上，而这里唯一不能犯的错是**把没看懂的记录涂成绿色**。
 */
export function classifyScanPolicy(
  kind: unknown,
  data: unknown,
): ScanPolicyState | null {
  const raw = typeof kind === "string" ? kind.trim() : "";
  if (!SCAN_POLICY_KINDS.has(raw)) return null;

  const record = asRecord(data);
  if (!record || !Object.prototype.hasOwnProperty.call(record, "scanPolicyVersion")) {
    return { state: "legacy", version: 0 };
  }
  const value = record.scanPolicyVersion;
  // 版本号是 u32：非整数 / 负数一律算读不出，宁可标一句「不明」也不印出「v-1」
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value >= SCAN_POLICY_VERSION
      ? { state: "current" }
      : { state: "legacy", version: value };
  }
  return { state: "unreadable", raw: formatLoose(value) };
}

/**
 * 「这条记录出自旧的扫描口径」的可见标注。
 *
 * **为什么非标不可**：升级**前**跑完的整卷任务，当时按旧口径（点开头一律跳过）
 * 漏掉了卡上合法的点开头素材，却报了 100% 完成 +「本卡可格式化」。
 * `rebuild_tasks` 只重建未完成的清单，那批任务根本不进 `list_copy_tasks`，
 * 两条续传告警也够不到它们——审计日志是它们**唯一**留下痕迹的地方。
 * 不标，升级后那一行就还是一条无标注的绿色完成，没有任何机制说明它出自旧口径。
 *
 * **措辞必须诚实**：不断言「这张卡一定漏了东西」（卡上可能压根没有点开头的
 * 素材），也不能让人觉得无所谓。口径与 Rust 的 `policy_upgrade_caveat()` 一致——
 * 说清「无法区分 / 判断不了」，把结论留给去核对的人，而不是替他下。
 */
function scanPolicyCaveat(kind: unknown, data: unknown): AuditDetail | null {
  const policy = classifyScanPolicy(kind, data);
  if (!policy || policy.state === "current") return null;

  if (policy.state === "unreadable") {
    const shown = policy.raw ? `（${policy.raw}）` : "";
    return {
      label: SCAN_POLICY_LABEL,
      value: `版本读不出${shown}：这条记录证明不了它跑在当前口径 v${SCAN_POLICY_VERSION} 上，「.」开头的素材有没有被拷到，判断不了`,
    };
  }

  const base = `旧口径 v${policy.version}（当前 v${SCAN_POLICY_VERSION}）：当时以「.」开头的条目一律跳过，卡上若有这类素材就没进本次范围`;
  // 「完成」那一条还额外背着两句结论,必须点名说它们不覆盖被跳过的条目
  const verdict =
    typeof kind === "string" && kind.trim() === "copy_completed"
      ? "，「校验通过」与「本卡可格式化」都不覆盖它们"
      : "";
  return {
    label: SCAN_POLICY_LABEL,
    value: `${base}${verdict}；卡上当时到底有没有，这条记录判断不了`,
  };
}

/**
 * 取一条记录的呈现口径——**连 data 一起看**。
 *
 * `auditKindMeta` 只认 kind，够用了很久：一个 kind 对应一种语气色。
 * 但"拷卡完成"不是这样的事件——同一个 kind 下,整卷意味着"这张卡可以格式化",
 * 部分拷贝意味着"卡上还有没备份的素材"。只按 kind 取色,两者在日志里
 * 逐字相同、同为绿色,而这条日志正是事后判断能否格式化的唯一权威记录。
 *
 * `trash_emptied` 取 danger 已经立下了原则:**语气色服务于"这件事有多需要
 * 被看见"**,不是机械地按成功/失败上色。这里把它从 kind 推广到 data。
 *
 * 降级只朝一个方向:绿/中性 → 琥珀;已经是 danger 的不会被调轻。
 *
 * 现在压两道:**范围**（这次到底拷了多少）与**扫描口径**（那份结论可不可信）。
 * 两道各自独立,同时命中就并列写进抬头——「拷卡完成（部分 · 旧扫描口径）」。
 */
export function auditEventMeta(kind: unknown, data: unknown): AuditKindMeta {
  const meta = auditKindMeta(kind);
  /* 抬头后缀的顺序 = 阅读顺序:先说这次拷了多少,再说那个数字出自哪一版口径 */
  const tags: string[] = [];
  let degraded = false;

  const record = asRecord(data);
  if (record && Object.prototype.hasOwnProperty.call(record, "sourceFolders")) {
    const scope = classifyCopyScope(record.sourceFolders);
    if (scope !== "whole") {
      degraded = true;
      // 范围读不懂时只降色、不拼字:替它编一个「部分」同样是替后端背书
      if (scope === "partial") tags.push("部分");
    }
  }
  /* 没有 sourceFolders 字段 = 按文件夹多选上线之前的旧记录,当时只可能是整卷。
     不额外标注范围,也不因此改色——但下面那道口径检查照旧要走。 */

  const policy = classifyScanPolicy(kind, data);
  if (policy && policy.state !== "current") {
    degraded = true;
    tags.push(policy.state === "legacy" ? "旧扫描口径" : "扫描口径不明");
  }

  if (!degraded) return meta;
  return {
    ...meta,
    /* 颜色不是信息:灰度、色觉障碍、截图转发之后都只剩文字。
       抬头本身要说清这一行哪里不能照单全收,不能只靠把绿改成琥珀。
       未收录的 kind 抬头是等宽原始值,不给它拼中文后缀。 */
    label:
      meta.known && tags.length > 0 ? `${meta.label}（${tags.join(" · ")}）` : meta.label,
    tone: meta.tone === "danger" ? "danger" : "warn",
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

type ValueKind =
  | "count"
  | "bytes"
  | "seconds"
  | "text"
  | "mode"
  | "tier"
  | "bool"
  /** `sourceFolders`：整卷 / 部分拷贝 / 读不懂——决定这张卡能不能格式化 */
  | "scope"
  /** `allVerified`：值本身要带上范围口径，避免被读成"整卡都校验过了" */
  | "verifyScope";

/** 拷贝范围那一项的字段名——「扫描口径」标注要插在它后面，故收成常量 */
const SCOPE_LABEL = "范围";

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
  /*
   * 范围紧跟在"原因"之后,排在一切计数之前。
   *
   * 它是事后判断"这张卡能不能格式化"的**唯一**权威线索:屏内提示会被下一张卡
   * 冲掉、toast 会消失、铃铛会被确认清掉,第二天回来对账的人只剩这一行。
   * 排后面会被 `bytesCopied` 之类的计数挤出那 4 个位置,于是部分拷贝在界面上
   * 与整卷**逐字相同**——一条绿色的"拷卡完成 · 容量 39.1 GB",足以让人去
   * 相机里格式化掉没备份的素材。
   */
  { keys: ["sourceFolders"], label: SCOPE_LABEL, kind: "scope" },
  { keys: ["allVerified"], label: "校验", kind: "verifyScope" },
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

/* ------------------------------------------------------------------ *
 * 拷贝范围（sourceFolders）：本文件里唯一一个"读错了会毁素材"的字段
 * ------------------------------------------------------------------ */

/**
 * 预览里最多列几个文件夹名，其余用省略号带过（完整内容仍在 title 里）。
 * 判据（`classifyCopyScope`）与卷根文案都在 `copyScope.ts`——这里只管排版。
 */
const SCOPE_PREVIEW_LIMIT = 2;

function formatScope(value: unknown): string | null {
  switch (classifyCopyScope(value)) {
    case "whole":
      return "整卷";
    case "partial": {
      const { text, truncated, count } = formatScopeFolders(value, {
        limit: SCOPE_PREVIEW_LIMIT,
        // 外层已经有一对括号了，卷根在这里写成光秃秃的「卷根」
        bare: true,
        // 数组里混进非字符串时沿用本文件那套通用兜底（数组→「N 项」等）
        fallback: formatLoose,
      });
      return `部分拷贝：${count} 个文件夹（${collapse(text)}${truncated ? "…" : ""}）`;
    }
    default: {
      // 有字段却读不懂:如实说"读不出来"并把原值摆上,别假装这次是整卷
      const loose = formatLoose(value);
      return loose ? `范围读不出（${loose}）` : "范围读不出";
    }
  }
}

/**
 * `allVerified` 的呈现要带上范围口径。
 * 部分拷贝下它**只覆盖所选的那几个文件夹**，写成光秃秃的"校验 是"，
 * 会被读成"整卡都校验过了"——那是这条记录里第二危险的误读。
 */
function formatVerifyScope(
  value: unknown,
  record: Record<string, unknown>,
): string | null {
  if (typeof value !== "boolean") return formatLoose(value);
  const partial =
    Object.prototype.hasOwnProperty.call(record, "sourceFolders") &&
    classifyCopyScope(record.sourceFolders) !== "whole";
  const subject = partial ? "所选范围" : "全部";
  return value ? `${subject}通过` : `${subject}存在未通过`;
}

/** 按字段语义格式化；类型对不上就退回通用兜底，绝不抛 */
function formatField(
  value: unknown,
  kind: ValueKind,
  record: Record<string, unknown>,
): string | null {
  switch (kind) {
    case "scope":
      return formatScope(value);
    case "verifyScope":
      return formatVerifyScope(value, record);
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
 *
 * `kind` 可选，但**只有带上它**才能给出与 kind 绑定的标注（目前是「扫描口径」：
 * 判据是「`copy_started` / `copy_completed` 缺 `scanPolicyVersion` 字段」，
 * 光看 data 分不出「这条记录出自旧口径」和「这个 kind 本来就没这个字段」）。
 * `toAuditRow` 一律传；只想看 data 挑字段的调用方可以不传。
 *
 * 任何形状的输入都只会得到"少一点"的结果，不会得到异常。
 */
export function auditDetails(
  data: unknown,
  limit = MAX_AUDIT_DETAILS,
  kind?: unknown,
): AuditDetail[] {
  if (limit <= 0) return [];
  const caveat = scanPolicyCaveat(kind, data);
  // 标注自己也占一格,总数仍守住 limit:挤掉一项排最后的次要计数,
  // 好过让这一行长到读不动
  const picked = pickDataDetails(data, caveat ? limit - 1 : limit);
  if (!caveat) return picked;
  /*
   * 插在「范围」之后、其余一切之前。
   * 之后：范围那一位是拿命换来的（见 KNOWN_FIELDS 里那段注释），不许被挤走；
   * 之前：这条标注直接推翻「校验」的适用范围，读到「校验 全部通过」之前
   *       必须先读到它，否则顺序本身就在误导人。
   */
  const at = picked.findIndex((d) => d.label === SCOPE_LABEL);
  const index = at >= 0 ? at + 1 : 0;
  return [...picked.slice(0, index), caveat, ...picked.slice(index)];
}

/** `auditDetails` 里纯看 data 的那一半：按 KNOWN_FIELDS 挑，挑不到就露生键值 */
function pickDataDetails(data: unknown, limit: number): AuditDetail[] {
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
      const value = formatField(record[key], field.kind, record);
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
  // 连 kind 一起传:「缺 scanPolicyVersion = 旧口径」这条判据离了 kind 不成立
  const details = auditDetails(record.data, MAX_AUDIT_DETAILS, kind);
  return {
    key: `${ts || "?"}-${kind || "?"}-${index}`,
    ts,
    time: ts ? formatTimestamp(ts) : "—",
    machine: asText(record.machine, UNKNOWN_MACHINE),
    operator: asText(record.operator, UNKNOWN_OPERATOR),
    kind,
    // 连 data 一起看:同一个 copy_completed,整卷与部分拷贝不是同一件事
    meta: auditEventMeta(kind, record.data),
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
