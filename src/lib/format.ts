/** 展示层格式化。容量一律 1024 进制（对齐读卡器/资源管理器的直觉）。 */

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** 字节数 → 人类可读，如 `1.5 GB`；小于 1KB 不带小数 */
export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(fractionDigits)} ${UNITS[unit]}`;
}

/** 速度：`280 MB/s` */
export function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "—";
  return `${formatBytes(bytesPerSec, 0)}/s`;
}

/** 0–1 的比值 → 整数百分比字符串 */
export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return "0%";
  const clamped = Math.min(1, Math.max(0, ratio));
  return `${Math.round(clamped * 100)}%`;
}

/** 安全比值：分母为 0 时返回 0，且结果夹在 0–1 */
export function ratio(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, part / total));
}

/** `YYYYMMDD` → `2026-08-24`；非法输入原样返回 */
export function formatCompactDate(date: string): string {
  if (!/^\d{8}$/.test(date)) return date;
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

/** ISO 时间戳 → `08-24 14:32`；非法输入返回 `—` */
/**
 * 当前时刻的本地时区 ISO 串(如 2026-08-26T10:00:00+08:00)。
 * mock 数据与审计日志统一用带偏移的格式;裸 Z 串混进来虽然排序已按
 * Date.parse 兜底,但展示/日志里两种格式并存仍然碍眼。
 */
export function nowLocalIso(now = new Date()): string {
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");
  const off = -now.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${pad(Math.floor(off / 60))}:${pad(off % 60)}`
  );
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

/**
 * 已发生的时长 → `46 分 44 秒`；非法值返回 `—`。
 *
 * 与 `formatEta` 的区别不只是入参：那个是**估算**，所以带「约」；
 * 这个是审计日志里已经量出来的事实，带「约」会把确定的事说成不确定。
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const restSeconds = total % 60;
  if (minutes < 60) {
    return restSeconds ? `${minutes} 分 ${restSeconds} 秒` : `${minutes} 分`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
}

/** 剩余时间估算 → `约 3 分 20 秒`；无法估算返回 `—` */
export function formatEta(remainingBytes: number, bytesPerSec: number): string {
  if (
    !Number.isFinite(remainingBytes) ||
    !Number.isFinite(bytesPerSec) ||
    bytesPerSec <= 0 ||
    remainingBytes <= 0
  ) {
    return "—";
  }
  const seconds = Math.round(remainingBytes / bytesPerSec);
  if (seconds < 60) return `约 ${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `约 ${minutes} 分 ${rest} 秒` : `约 ${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  return `约 ${hours} 小时 ${minutes % 60} 分`;
}
