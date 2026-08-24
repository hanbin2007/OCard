/** 分类命令的接线约定（mock 回退路径下可验证的部分）。 */

import { describe, expect, it } from "vitest";
import { listPendingAssets, MAX_ASSET_PAGE_LIMIT } from "./index";
import { mockPendingAssets } from "./mock";

describe("listPendingAssets 分页", () => {
  it("limit 超过后端上限 200 时被夹住，不会误以为拿到了更多", async () => {
    const page = await listPendingAssets("p-1", 0, 600);
    expect(MAX_ASSET_PAGE_LIMIT).toBe(200);
    expect(page.items).toHaveLength(200);
    expect(page.total).toBe(mockPendingAssets.length);
  });

  it("正常 limit 原样生效，offset 按已加载条数推进不跳号", async () => {
    const first = await listPendingAssets("p-1", 0, 200);
    const second = await listPendingAssets("p-1", first.items.length, 200);
    expect(first.items).toHaveLength(200);
    expect(second.items[0].id).toBe(mockPendingAssets[200].id);
  });

  it("groupId 现阶段为空（连拍分组归 M3），UI 折叠逻辑保持兼容", async () => {
    const page = await listPendingAssets("p-1", 0, 10);
    expect(page.items.every((a) => a.groupId === undefined)).toBe(true);
  });
});
