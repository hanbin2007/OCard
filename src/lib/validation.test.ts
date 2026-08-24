import { describe, expect, it } from "vitest";
import type { NewProjectInput } from "../api/types";
import {
  validateNewCamera,
  validateNewProject,
  validateStartCopy,
} from "./validation";

function project(overrides: Partial<NewProjectInput> = {}): NewProjectInput {
  return {
    name: "校运会",
    date: "20260824",
    scenario: "B",
    categories: ["开幕式", "颁奖"],
    ...overrides,
  };
}

describe("validateNewProject", () => {
  it("合法输入通过", () => {
    const result = validateNewProject(project());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual({});
  });

  it("缺日期与缺项目名分别报错", () => {
    const result = validateNewProject(project({ date: "", name: "  " }));
    expect(result.valid).toBe(false);
    expect(result.errors.date).toBe("请选择拍摄日期");
    expect(result.errors.name).toBe("请填写项目名");
  });

  it("不存在的日期被拦下", () => {
    const result = validateNewProject(project({ date: "20260230" }));
    expect(result.valid).toBe(false);
    expect(result.errors.date).toContain("YYYYMMDD");
  });

  it("项目名含非法字符被拦下", () => {
    const result = validateNewProject(project({ name: "校运会/决赛" }));
    expect(result.valid).toBe(false);
    expect(result.errors.name).toBeTruthy();
  });

  it("项目名超长被拦下", () => {
    const result = validateNewProject(project({ name: "运".repeat(41) }));
    expect(result.errors.name).toContain("40");
  });

  it("工况 B 至少要有一个分类", () => {
    const result = validateNewProject(project({ categories: [] }));
    expect(result.valid).toBe(false);
    expect(result.errors.categories).toBe("工况 B 至少需要一个分类");
  });

  it("工况 A 不校验分类", () => {
    const result = validateNewProject(project({ scenario: "A", categories: [] }));
    expect(result.valid).toBe(true);
  });

  it("分类重名定位到后一项", () => {
    const result = validateNewProject(project({ categories: ["领导", "领导"] }));
    expect(result.valid).toBe(false);
    expect(result.errors.categoryAt?.[1]).toBe("分类名重复");
    expect(result.errors.categoryAt?.[0]).toBeUndefined();
  });

  it("空分类名逐项报错", () => {
    const result = validateNewProject(project({ categories: ["领导", ""] }));
    expect(result.errors.categoryAt?.[1]).toBe("分类名不能为空");
  });

  it("大小写/空格不同但实为同一个夹的分类算重复", () => {
    const result = validateNewProject(project({ categories: ["Leader", "leader"] }));
    expect(result.valid).toBe(false);
    expect(result.errors.categoryAt?.[1]).toBe("分类名重复");
  });

  it("Windows 保留设备名做项目名或分类名被拦下", () => {
    expect(validateNewProject(project({ name: "CON" })).errors.name).toContain("保留");
    const cats = validateNewProject(project({ categories: ["NUL"] }));
    expect(cats.errors.categoryAt?.[0]).toContain("保留");
  });

  it("分类数量超上限被拦下", () => {
    const many = Array.from({ length: 21 }, (_, i) => `分类${i}`);
    const result = validateNewProject(project({ categories: many }));
    expect(result.errors.categories).toContain("20");
  });
});

describe("validateNewCamera", () => {
  it("合法登记通过", () => {
    const result = validateNewCamera({
      model: "DJI Ronin 4D",
      position: "B",
      operatorAlias: "ZS",
    });
    expect(result.valid).toBe(true);
  });

  it("机位非单字母被拦下", () => {
    const result = validateNewCamera({
      model: "Z9",
      position: "12",
      operatorAlias: "CQ",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.position).toContain("A–Z");
  });

  it("代称非 1–4 位字母被拦下", () => {
    const result = validateNewCamera({
      model: "Z9",
      position: "E",
      operatorAlias: "CQ2026",
    });
    expect(result.errors.operatorAlias).toBeTruthy();
  });

  it("编码撞车时拦下", () => {
    const result = validateNewCamera(
      { model: "Nikon Z9", position: "E", operatorAlias: "CQ" },
      ["NikonZ9_E_CQ"],
      "NikonZ9_E_CQ",
    );
    expect(result.valid).toBe(false);
    expect(result.errors.position).toContain("已登记");
  });
});

describe("validateStartCopy", () => {
  const base = {
    volumeId: "vol-1",
    cameraId: "cam-1",
    note: "上午田赛",
    targetPrefix: "0824上午",
    destinations: ["/Volumes/NAS", "/Volumes/T7"],
  };

  it("双确认信息齐全时通过", () => {
    expect(validateStartCopy(base).valid).toBe(true);
  });

  it("备注为空被拦下（规范要求适当记录）", () => {
    const result = validateStartCopy({ ...base, note: "   " });
    expect(result.valid).toBe(false);
    expect(result.errors.note).toContain("必填");
  });

  it("没有目的地被拦下", () => {
    const result = validateStartCopy({ ...base, destinations: ["", "  "] });
    expect(result.errors.destinations).toBe("至少需要一个目的地");
  });

  it("目的地重复被拦下", () => {
    const result = validateStartCopy({
      ...base,
      destinations: ["/Volumes/NAS", "/Volumes/NAS"],
    });
    expect(result.errors.destinations).toBe("目的地路径重复");
  });

  it("只有大小写/结尾斜杠差异的目的地也算重复（否则等于只备份了一份）", () => {
    const result = validateStartCopy({
      ...base,
      destinations: ["/Volumes/NAS/", "/volumes/nas"],
    });
    expect(result.errors.destinations).toBe("目的地路径重复");
  });

  it("缺目标夹前缀被拦下", () => {
    const result = validateStartCopy({ ...base, targetPrefix: "  " });
    expect(result.valid).toBe(false);
    expect(result.errors.targetPrefix).toBeTruthy();
  });

  it("未选源卷与相机分别报错", () => {
    const result = validateStartCopy({ ...base, volumeId: "", cameraId: "" });
    expect(result.errors.volumeId).toBeTruthy();
    expect(result.errors.cameraId).toBeTruthy();
  });
});
