/**
 * 轻量本地偏好(评审:配置记忆一组)。
 *
 * DIT 的备份盘、归档目录、备注措辞、当前项目在一整个项目周期里基本不变,
 * 每次从零填起是纯重复劳动。这里统一走 localStorage:
 * - 只存**便利性**记忆(预填、上次选择),权威事实永远在 NAS 项目夹里;
 * - 读写全部 try/catch:私隐模式/清站点数据时丢记忆不丢功能;
 * - key 统一 `ocard:v1:` 前缀,便于将来迁移或清理。
 */

const PREFIX = "ocard:v1:";

export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage?.getItem(PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown): void {
  try {
    window.localStorage?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // 存不进去只丢便利,不报错打扰
  }
}

export function removePref(key: string): void {
  try {
    window.localStorage?.removeItem(PREFIX + key);
  } catch {
    // 同上
  }
}
