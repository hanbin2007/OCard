/**
 * 命名规则（规范 OB/GF 001—2026 的代码化，PRD §5.1 / §5.2 / §5.3）。
 * 纯函数，无副作用；Rust 侧需实现同样规则，并以本文件的单测为对齐基准。
 */

/** Windows 非法文件名字符，三平台互通时统一过滤（PRD §6.5） */
const ILLEGAL_CHARS = /[\\/:*?"<>|]/g;
/** ASCII 控制字符（Unicode 类别 Cc） */
const CONTROL_CHARS = /\p{Cc}/gu;

/**
 * 清洗单个路径片段：去掉非法字符与控制字符，折叠空白，
 * 并去掉 Windows 不允许的首尾空格与结尾句点。
 */
export function sanitizeSegment(raw: string): string {
  return raw
    .replace(ILLEGAL_CHARS, "")
    .replace(CONTROL_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
}

/** 片段是否含有非法字符（用于表单实时校验，不做清洗） */
export function hasIllegalChars(raw: string): boolean {
  return /[\\/:*?"<>|]/.test(raw) || /\p{Cc}/u.test(raw);
}

/** Windows 保留设备名，做文件夹名会直接创建失败（不分大小写，带扩展名也算） */
const RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

export function isReservedName(raw: string): boolean {
  const base = sanitizeSegment(raw).split(".")[0]?.toUpperCase() ?? "";
  return RESERVED_NAMES.has(base);
}

/**
 * 比较用的规范化键：Unicode NFC + 清洗 + 去空格 + 大小写折叠。
 * 分类重名、相机编码撞车、目的地去重都必须用同一把尺子——
 * macOS/Windows 文件系统默认大小写不敏感，`领导` 和 `领导 `、`A7M4` 和 `a7m4` 会撞车。
 */
export function normalizeKey(raw: string): string {
  return sanitizeSegment(raw.normalize("NFC")).replace(/\s+/g, "").toLowerCase();
}

/**
 * 路径比较键：不能套用 normalizeKey（它会把分隔符也删掉，`/a/b` 与 `/ab` 会撞车）。
 * 这里只统一分隔符、去掉结尾分隔符、NFC 并折叠大小写。
 */
export function normalizePathKey(raw: string): string {
  return raw
    .normalize("NFC")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * 相机编码：型号去空格 + 机位 + 使用者代称，下划线分隔。
 * 例：`DJI Ronin 4D` / `b` / `zs` → `DJIRonin4D_B_ZS`
 * 任一段为空则返回空串（预览区据此显示占位）。
 */
export function buildCameraCode(
  model: string,
  position: string,
  operatorAlias: string,
): string {
  const modelPart = sanitizeSegment(model).replace(/[\s_-]+/g, "");
  const positionPart = sanitizeSegment(position).toUpperCase();
  const aliasPart = sanitizeSegment(operatorAlias)
    .replace(/[\s_-]+/g, "")
    .toUpperCase();
  if (!modelPart || !positionPart || !aliasPart) return "";
  return `${modelPart}_${positionPart}_${aliasPart}`;
}

/** 机位必须是单个 A–Z 字母 */
export function isValidPosition(position: string): boolean {
  return /^[A-Za-z]$/.test(position.trim());
}

/** 使用者代称：1–4 位字母（代称取姓名首字母缩写） */
export function isValidAlias(alias: string): boolean {
  return /^[A-Za-z]{1,4}$/.test(alias.trim());
}

/** `YYYYMMDD` 是否为存在的日历日期 */
export function isValidCompactDate(date: string): boolean {
  if (!/^\d{8}$/.test(date)) return false;
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  if (year < 1970 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  const daysInMonth = new Date(year, month, 0).getDate();
  return day >= 1 && day <= daysInMonth;
}

/** 项目文件夹名：`YYYYMMDD_项目名`（项目名去空格，非法日期或空名返回空串） */
export function buildProjectFolderName(date: string, name: string): string {
  const cleanName = sanitizeSegment(name).replace(/\s+/g, "");
  if (!isValidCompactDate(date) || !cleanName) return "";
  return `${date}_${cleanName}`;
}

/**
 * 拷卡目标子文件夹名（PRD §5.3）：
 * - 工况 A：前缀为 `YYYYMMDD` → `20260824_DJIRonin4D_B_ZS`
 * - 工况 B：前缀为时段标签 → `0824上午_A7M4_A_LM`
 */
export function buildCopyTargetFolder(prefix: string, cameraCode: string): string {
  const cleanPrefix = sanitizeSegment(prefix).replace(/\s+/g, "");
  const cleanCode = sanitizeSegment(cameraCode).replace(/\s+/g, "");
  if (!cleanPrefix || !cleanCode) return "";
  return `${cleanPrefix}_${cleanCode}`;
}

/** 工况对应的拷卡落点一级夹 */
export function copyTargetParent(scenario: "A" | "B"): string {
  return scenario === "A" ? "2. 原始素材" : "1. 待分类";
}

/** 拷卡目标完整相对路径（含工况对应的一级夹） */
export function buildCopyTargetPath(
  scenario: "A" | "B",
  prefix: string,
  cameraCode: string,
): string {
  const folder = buildCopyTargetFolder(prefix, cameraCode);
  if (!folder) return "";
  return `${copyTargetParent(scenario)}/${folder}`;
}

/** 从 ISO 时间戳推断工况 B 的时段标签，如 `0824上午` */
export function inferTimeSlot(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hour = d.getHours();
  let slot = "上午";
  if (hour >= 18) slot = "晚上";
  else if (hour >= 12) slot = "下午";
  return `${mm}${dd}${slot}`;
}
