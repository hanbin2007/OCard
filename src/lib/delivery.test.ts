import { describe, expect, it } from "vitest";
import type { DeliverySummary } from "../api/types";
import { classifyFailures, deliveryHeadline, isCleanDelivery } from "./delivery";

const base: DeliverySummary = {
  packages: [{ name: "0824上午", fileCount: 10, bytes: 1024 }],
  totalFiles: 10,
  totalBytes: 1024,
  alreadyDelivered: 0,
  failures: [],
  deliveryPath: "/nas/交付/20260824",
};

describe("classifyFailures", () => {
  it("三种 kind 各归各位", () => {
    const { nameCollisions, manifestErrors, errors } = classifyFailures([
      { assetId: "a", message: "同名不同内容", kind: "name-collision" },
      { assetId: "b", message: "清单未写入", kind: "manifest-error" },
      { assetId: "c", message: "磁盘写满", kind: "error" },
    ]);
    expect(nameCollisions.map((f) => f.assetId)).toEqual(["a"]);
    expect(manifestErrors.map((f) => f.assetId)).toEqual(["b"]);
    expect(errors.map((f) => f.assetId)).toEqual(["c"]);
  });

  it("缺省 kind 按真失败处理——宁可多报，不把未交付说成没事", () => {
    const { errors, nameCollisions, manifestErrors } = classifyFailures([
      { assetId: "a", message: "未知原因" },
    ]);
    expect(errors).toHaveLength(1);
    expect(nameCollisions).toHaveLength(0);
    expect(manifestErrors).toHaveLength(0);
  });

  it("不再靠文案猜语义：含「已存在」字样也不会被当成正常跳过", () => {
    const { errors } = classifyFailures([
      { assetId: "a", message: "目标已存在但校验不一致" },
    ]);
    expect(errors).toHaveLength(1);
  });
});

describe("isCleanDelivery", () => {
  it("只有清单缺失仍算「没有未交付」——文件确实交付了", () => {
    expect(
      isCleanDelivery({
        ...base,
        failures: [{ assetId: "a", message: "清单未写入", kind: "manifest-error" }],
      }),
    ).toBe(true);
  });

  it("同名冲突算未交付，不干净", () => {
    expect(
      isCleanDelivery({
        ...base,
        failures: [{ assetId: "a", message: "同名不同内容", kind: "name-collision" }],
      }),
    ).toBe(false);
  });

  it("真失败不干净", () => {
    expect(
      isCleanDelivery({
        ...base,
        failures: [{ assetId: "a", message: "磁盘写满", kind: "error" }],
      }),
    ).toBe(false);
  });

  it("alreadyDelivered 不影响干净判定", () => {
    expect(isCleanDelivery({ ...base, alreadyDelivered: 42 })).toBe(true);
  });
});

describe("deliveryHeadline", () => {
  it("全新交付只报包数与新交付数", () => {
    expect(deliveryHeadline(base)).toBe("已生成 1 个交付包，新交付 10 个文件");
  });

  it("重跑把已交付说成「已交付跳过」，不是失败", () => {
    const text = deliveryHeadline({ ...base, alreadyDelivered: 24 });
    expect(text).toContain("已交付跳过 24 个");
    expect(text).not.toContain("未交付");
    expect(text).not.toContain("失败");
  });

  it("同名冲突与真失败合并计入「未交付」", () => {
    const text = deliveryHeadline({
      ...base,
      failures: [
        { assetId: "a", message: "同名不同内容", kind: "name-collision" },
        { assetId: "b", message: "磁盘写满", kind: "error" },
      ],
    });
    expect(text).toContain("2 个未交付");
  });

  it("清单缺失单列，不混进未交付", () => {
    const text = deliveryHeadline({
      ...base,
      failures: [{ assetId: "a", message: "清单未写入", kind: "manifest-error" }],
    });
    expect(text).toContain("1 个清单缺失");
    expect(text).not.toContain("未交付");
  });
});
