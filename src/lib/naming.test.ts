import { describe, expect, it } from "vitest";
import {
  buildCameraCode,
  buildCopyTargetFolder,
  buildCopyTargetPath,
  buildProjectFolderName,
  copyTargetParent,
  hasIllegalChars,
  inferTimeSlot,
  isValidAlias,
  isValidCompactDate,
  isValidPosition,
  sanitizeSegment,
} from "./naming";

describe("sanitizeSegment", () => {
  it("剔除 Windows 非法字符", () => {
    expect(sanitizeSegment('校运/会:决*赛?"<>|')).toBe("校运会决赛");
  });

  it("折叠空白并去掉首尾空格", () => {
    expect(sanitizeSegment("  年中   发布会  ")).toBe("年中 发布会");
  });

  it("去掉结尾句点（Windows 不允许）", () => {
    expect(sanitizeSegment("宣传片...")).toBe("宣传片");
  });

  it("全是非法字符时返回空串", () => {
    expect(sanitizeSegment("///:::")).toBe("");
  });
});

describe("hasIllegalChars", () => {
  it("识别非法字符", () => {
    expect(hasIllegalChars("a/b")).toBe(true);
    expect(hasIllegalChars("C:")).toBe(true);
  });

  it("正常中英文不报错", () => {
    expect(hasIllegalChars("校运会 2026")).toBe(false);
  });
});

describe("buildCameraCode", () => {
  it("按规范生成 型号_机位_代称", () => {
    expect(buildCameraCode("DJI Ronin 4D", "B", "ZS")).toBe("DJIRonin4D_B_ZS");
  });

  it("机位与代称统一大写，型号去掉空格与连字符", () => {
    expect(buildCameraCode("Sony A7M4", "a", "lm")).toBe("SonyA7M4_A_LM");
    expect(buildCameraCode("Canon R5-C", "c", "wh")).toBe("CanonR5C_C_WH");
  });

  it("任一段缺失返回空串（预览显示占位）", () => {
    expect(buildCameraCode("", "B", "ZS")).toBe("");
    expect(buildCameraCode("Z9", "", "CQ")).toBe("");
    expect(buildCameraCode("Z9", "E", "")).toBe("");
  });
});

describe("机位与代称校验", () => {
  it("机位只接受单个字母", () => {
    expect(isValidPosition("A")).toBe(true);
    expect(isValidPosition("b")).toBe(true);
    expect(isValidPosition("AB")).toBe(false);
    expect(isValidPosition("1")).toBe(false);
  });

  it("代称为 1–4 位字母", () => {
    expect(isValidAlias("ZS")).toBe(true);
    expect(isValidAlias("ABCD")).toBe(true);
    expect(isValidAlias("ABCDE")).toBe(false);
    expect(isValidAlias("Z9")).toBe(false);
  });
});

describe("isValidCompactDate", () => {
  it("接受真实存在的日期", () => {
    expect(isValidCompactDate("20260824")).toBe(true);
    expect(isValidCompactDate("20240229")).toBe(true);
  });

  it("拒绝不存在的日期与错误格式", () => {
    expect(isValidCompactDate("20260231")).toBe(false);
    expect(isValidCompactDate("20261301")).toBe(false);
    expect(isValidCompactDate("2026-08-24")).toBe(false);
    expect(isValidCompactDate("202608")).toBe(false);
  });
});

describe("buildProjectFolderName", () => {
  it("生成 YYYYMMDD_项目名", () => {
    expect(buildProjectFolderName("20260824", "校运会")).toBe("20260824_校运会");
  });

  it("项目名内部空格被去掉", () => {
    expect(buildProjectFolderName("20260822", "年中 发布会")).toBe(
      "20260822_年中发布会",
    );
  });

  it("日期非法或名字为空时返回空串", () => {
    expect(buildProjectFolderName("20261340", "校运会")).toBe("");
    expect(buildProjectFolderName("20260824", "   ")).toBe("");
  });
});

describe("拷卡目标路径", () => {
  it("工况 A 落在「2. 原始素材」，前缀为日期", () => {
    expect(copyTargetParent("A")).toBe("2. 原始素材");
    expect(buildCopyTargetPath("A", "20260824", "DJIRonin4D_B_ZS")).toBe(
      "2. 原始素材/20260824_DJIRonin4D_B_ZS",
    );
  });

  it("工况 B 落在「1. 待分类」，前缀为时段", () => {
    expect(copyTargetParent("B")).toBe("1. 待分类");
    expect(buildCopyTargetPath("B", "0824上午", "Z9_E_CQ")).toBe(
      "1. 待分类/0824上午_Z9_E_CQ",
    );
  });

  it("缺相机编码时不产出路径", () => {
    expect(buildCopyTargetFolder("20260824", "")).toBe("");
    expect(buildCopyTargetPath("A", "20260824", "")).toBe("");
  });
});

describe("inferTimeSlot", () => {
  it("按小时判定上午/下午/晚上", () => {
    expect(inferTimeSlot("2026-08-24T09:12:00")).toBe("0824上午");
    expect(inferTimeSlot("2026-08-24T14:12:00")).toBe("0824下午");
    expect(inferTimeSlot("2026-08-24T20:12:00")).toBe("0824晚上");
  });

  it("非法时间戳返回空串", () => {
    expect(inferTimeSlot("not-a-date")).toBe("");
  });
});
