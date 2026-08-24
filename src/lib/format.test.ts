import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatCompactDate,
  formatEta,
  formatPercent,
  formatSpeed,
  ratio,
} from "./format";

const GB = 1024 ** 3;

describe("formatBytes", () => {
  it("小于 1KB 时按整数字节显示", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("按 1024 进制逐级换算", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1.5 * GB)).toBe("1.5 GB");
    expect(formatBytes(1024 * GB, 0)).toBe("1 TB");
  });

  it("非法值返回破折号", () => {
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });
});

describe("formatSpeed", () => {
  it("带 /s 后缀", () => {
    expect(formatSpeed(280 * 1024 * 1024)).toBe("280 MB/s");
  });

  it("零速度返回破折号", () => {
    expect(formatSpeed(0)).toBe("—");
  });
});

describe("ratio / formatPercent", () => {
  it("正常比值", () => {
    expect(ratio(1, 4)).toBe(0.25);
    expect(formatPercent(0.25)).toBe("25%");
  });

  it("分母为 0 时归零，不产生 NaN", () => {
    expect(ratio(3, 0)).toBe(0);
    expect(formatPercent(ratio(3, 0))).toBe("0%");
  });

  it("比值被夹在 0–1", () => {
    expect(ratio(9, 3)).toBe(1);
    expect(formatPercent(-2)).toBe("0%");
  });
});

describe("formatCompactDate", () => {
  it("YYYYMMDD 转带连字符日期", () => {
    expect(formatCompactDate("20260824")).toBe("2026-08-24");
  });

  it("非法输入原样返回", () => {
    expect(formatCompactDate("2026-08")).toBe("2026-08");
  });
});

describe("formatEta", () => {
  it("不足一分钟按秒", () => {
    expect(formatEta(100, 10)).toBe("约 10 秒");
  });

  it("超过一分钟带分秒", () => {
    expect(formatEta(200, 1)).toBe("约 3 分 20 秒");
  });

  it("整分钟不带秒", () => {
    expect(formatEta(120, 1)).toBe("约 2 分");
  });

  it("速度为 0 或已完成时返回破折号", () => {
    expect(formatEta(100, 0)).toBe("—");
    expect(formatEta(0, 100)).toBe("—");
  });
});
