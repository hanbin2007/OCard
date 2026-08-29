/**
 * 轻量本地偏好(评审:配置记忆一组)。
 *
 * DIT 的备份盘、归档目录、备注措辞、当前项目在一整个项目周期里基本不变,
 * 每次从零填起是纯重复劳动。这里统一走 localStorage:
 * - 只存**便利性**记忆(预填、上次选择),权威事实永远在 NAS 项目夹里;
 * - 读写全部 try/catch:私隐模式/清站点数据时丢记忆不丢功能;
 * - key 统一 `ocard:v1:` 前缀,便于将来迁移或清理。
 *
 * ------------------------------------------------------------------
 * 失败口径(零静默铁律)
 *
 * 本文件从前对读写失败一律「静默回落」——注释原话是「存不进去只丢便利,
 * 不报错打扰」。这句话在**只有预填**的年代成立,但记忆一旦承载「上次的
 * 界面形态」(路由、当前项目、侧栏折叠),静默失败就变成了用户看得见、
 * 却完全解释不了的怪事:每次开机都要重折一次侧栏,而软件一声不吭。
 *
 * 所以这里加了一条**可选的**失败回执 `onIssue`:
 * - 调用方传了它,失败就必须被说出去(通知中心 / toast),这是零静默要求的;
 * - 不传仍然静默,是为了不在这次改动里连坐改写全部老调用点(它们各自的
 *   降级口径要单独过一遍评审)。**新代码一律传**。
 *
 * 「没存过」不是失败:首跑取默认值是正常路径,不报。
 */

const PREFIX = "ocard:v1:";

/** 一次偏好读写的失败。拿到它的调用方有义务让用户看见 */
export interface PrefIssue {
  /** 出问题的偏好键(不含 `ocard:v1:` 前缀) */
  key: string;
  op: "read" | "write" | "remove";
  /** 原始原因,原样带给用户——「存不进去」而不说为什么等于没说 */
  reason: string;
}

function reasonOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return err === undefined || err === null ? "未知原因(无错误对象)" : String(err);
}

export function loadPref<T>(
  key: string,
  fallback: T,
  onIssue?: (issue: PrefIssue) => void,
): T {
  try {
    const raw = window.localStorage?.getItem(PREFIX + key);
    // 没存过 ≠ 读失败:首跑本来就该拿默认值
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch (err) {
    // 存储不可用,或者存进去的内容坏了(JSON 解析不动)——两种都是「记忆丢了」
    onIssue?.({ key, op: "read", reason: reasonOf(err) });
    return fallback;
  }
}

export function savePref(
  key: string,
  value: unknown,
  onIssue?: (issue: PrefIssue) => void,
): void {
  try {
    window.localStorage?.setItem(PREFIX + key, JSON.stringify(value));
  } catch (err) {
    onIssue?.({ key, op: "write", reason: reasonOf(err) });
  }
}

export function removePref(key: string, onIssue?: (issue: PrefIssue) => void): void {
  try {
    window.localStorage?.removeItem(PREFIX + key);
  } catch (err) {
    onIssue?.({ key, op: "remove", reason: reasonOf(err) });
  }
}
