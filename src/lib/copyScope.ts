/**
 * 拷贝范围（`sourceFolders`）的唯一判据与文案口径。
 *
 * 这个文件存在的理由只有一条：**「这张卡能不能格式化」是一句不可逆的话。**
 *
 * 判据此前散在三处（`store.tsx` 的终态通知、`audit.ts` 的审计行、
 * `CopyTaskScreen.tsx` 的完成提示与 hero 大字），后端 `tasks.rs` 里还有第四处。
 * 同一条安全规则写四遍，就有四次走样的机会——而走样的表现恰恰是最危险的那种：
 * 通知里说「请勿格式化」、审计里却是一条绿色的整卷完成。尤其是这两个边界：
 *
 *   - `undefined` / 省略：契约里的「整卷」（老客户端与老记录都是这个形状）；
 *   - `[""]`（用户勾了卷根）：**非空即部分**，卷根也不例外。它长得像「整卷」，
 *     但它只拷卷根的直接子文件，`DCIM/` 里的素材一个都不会被拷走。
 *
 * 所以这里把判据收成一个函数，四种输入（`undefined` / `[]` / `[""]` / 多项）
 * 的口径由 `copyScope.test.ts` 钉死，三处前端调用方一律改用它。
 */

/** 卷根在 `sourceFolders` 里是空串；直接 join 会渲染成一对空括号，必须给它名字 */
export const VOLUME_ROOT_LABEL = "卷根";

/** 与真实路径混排时带上括号，一眼能看出这不是一个叫「卷根」的文件夹 */
export const VOLUME_ROOT_DISPLAY = `（${VOLUME_ROOT_LABEL}）`;

export type CopyScope =
  /** 整卷：`undefined`（省略）或空数组。卡上没有落下的东西 */
  | "whole"
  /** 部分：非空数组（含 `[""]`）。卡上还有未备份的素材 */
  | "partial"
  /** 读不懂：有值但不是数组。**不许**替它担保「整卷」 */
  | "malformed";

/**
 * 判定拷贝范围。
 *
 * 读不懂时一律**不**判成整卷：整卷等于一句「这张卡可以格式化」的担保，
 * 拿一个解析失败的值去做这个担保，正是本模块从头到尾在防的事。
 * 只有 `undefined`（字段省略，契约上的向后兼容口径）才与空数组同义。
 */
export function classifyCopyScope(value: unknown): CopyScope {
  if (value === undefined) return "whole";
  if (!Array.isArray(value)) return "malformed";
  return value.length === 0 ? "whole" : "partial";
}

/**
 * 「这次不是整卷」——所有「能不能说本卡可格式化」的分叉都问这一个问题。
 *
 * 注意它把 `malformed` 也算进来：读不懂时按「不能担保」处理，
 * 宁可多说一句「请勿格式化」，也不能少说。
 */
export function isPartialCopy(value: unknown): boolean {
  return classifyCopyScope(value) !== "whole";
}

/** 文件夹条数；不是数组（含 `undefined`）时是 0，供文案里的「N 个文件夹」用 */
export function copyScopeFolderCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * 兜底格式化：数组里混进非字符串时也要出一行，而不是抛。
 * 调用方可以传自己的 `fallback` 覆盖（`audit.ts` 有一套更全的通用兜底）。
 */
function looseName(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  return null;
}

export interface FolderNameOptions {
  /** true 时卷根写成「卷根」（外面已有括号），默认写成「（卷根）」 */
  bare?: boolean;
  /** 非字符串值的兜底格式化；返回 null 表示读不出 */
  fallback?: (value: unknown) => string | null;
}

/** 单个文件夹名的呈现：空串是卷根，非字符串走兜底，都读不出就给问号 */
export function folderDisplayName(
  value: unknown,
  { bare = false, fallback = looseName }: FolderNameOptions = {},
): string {
  const root = bare ? VOLUME_ROOT_LABEL : VOLUME_ROOT_DISPLAY;
  if (typeof value === "string") return value.trim() || root;
  return fallback(value) ?? "?";
}

export interface ScopeFoldersOptions extends FolderNameOptions {
  /** 只列前几个，其余交给调用方拼省略号；不传则全列 */
  limit?: number;
}

export interface ScopeFoldersText {
  /** 已格式化的文件夹名，用「、」连接 */
  text: string;
  /** 是否因 `limit` 被截断（调用方据此补省略号） */
  truncated: boolean;
  /** 总条数（截断前） */
  count: number;
}

/**
 * 范围文案的格式化：`["", "DCIM/100MSDCF"]` → 「（卷根）、DCIM/100MSDCF」。
 *
 * 完成屏此前直接 `join("、")`，于是选了卷根时那行字变成「本次只拷了：。」——
 * 安全结论（请勿格式化）还在，备份范围却没说清。范围没说清等于让用户自己猜，
 * 而这正是他第二天决定要不要格式化时唯一能对账的东西。
 */
export function formatScopeFolders(
  value: unknown,
  { limit, ...nameOptions }: ScopeFoldersOptions = {},
): ScopeFoldersText {
  const folders = Array.isArray(value) ? value : [];
  const shown = limit === undefined ? folders : folders.slice(0, limit);
  return {
    text: shown.map((f) => folderDisplayName(f, nameOptions)).join("、"),
    truncated: shown.length < folders.length,
    count: folders.length,
  };
}
