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
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
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
