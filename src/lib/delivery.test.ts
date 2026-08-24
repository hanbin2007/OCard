import { describe, expect, it } from "vitest";
import type { DeliverySummary } from "../api/types";
import { classifyFailures, deliveryHeadline, isCleanDelivery } from "./delivery";

const base: DeliverySummary = {
  packages: [{ name: "0824上午", fileCount: 10, bytes: 1024 }],
  totalFiles: 10,
  totalBytes: 1024,
  failures: [],
  deliveryPath: "/nas/交付/20260824",
};

describe("classifyFailures", () => {
  it("按后端给的 kind 区分重跑已存在与真失败", () => {
    const { existing, errors } = classifyFailures([
      { assetId: "a", message: "目标已存在，已跳过", kind: "already-exists" },
      { assetId: "b", message: "磁盘写满", kind: "error" },
    ]);
    expect(existing.map((f) => f.assetId)).toEqual(["a"]);
    expect(errors.map((f) => f.assetId)).toEqual(["b"]);
  });

  it("后端没给 kind 时按文案兜底判定", () => {
    const { existing, errors } = classifyFailures([
      { assetId: "a", message: "目标已存在，已跳过（零覆盖）" },
      { assetId: "b", message: "already exists in package" },
      { assetId: "c", message: "权限不足" },
    ]);
    expect(existing).toHaveLength(2);
    expect(errors.map((f) => f.assetId)).toEqual(["c"]);
  });

  it("kind=error 优先于文案，不会被「已存在」字样误判", () => {
    const { errors } = classifyFailures([
      { assetId: "a", message: "校验和已存在但不匹配", kind: "error" },
    ]);
    expect(errors).toHaveLength(1);
  });
});

describe("isCleanDelivery", () => {
  it("只有重跑跳过仍算干净", () => {
    expect(
      isCleanDelivery({
        ...base,
        failures: [{ assetId: "a", message: "目标已存在", kind: "already-exists" }],
      }),
    ).toBe(true);
  });

  it("存在真失败则不干净", () => {
    expect(
      isCleanDelivery({
        ...base,
        failures: [{ assetId: "a", message: "磁盘写满", kind: "error" }],
      }),
    ).toBe(false);
  });
});

describe("deliveryHeadline", () => {
  it("全成功只报包数与文件数", () => {
    expect(deliveryHeadline(base)).toBe("已生成 1 个交付包，共 10 个文件");
  });

  it("重跑跳过的说成「此前已打包」，不说成失败", () => {
    const text = deliveryHeadline({
      ...base,
      failures: [{ assetId: "a", message: "已存在", kind: "already-exists" }],
    });
    expect(text).toContain("此前已打包，本次跳过");
    expect(text).not.toContain("失败");
  });

  it("真失败明确报失败数", () => {
    const text = deliveryHeadline({
      ...base,
      failures: [{ assetId: "a", message: "磁盘写满", kind: "error" }],
    });
    expect(text).toContain("1 个文件打包失败");
  });
});
