import { describe, expect, it } from "vitest";
import { nextIndexForKey } from "./useListNavigation";

describe("nextIndexForKey", () => {
  it("↓ 向后移动，到底停住", () => {
    expect(nextIndexForKey("ArrowDown", 0, 3)).toBe(1);
    expect(nextIndexForKey("ArrowDown", 2, 3)).toBe(2);
  });

  it("↑ 向前移动，到顶停住", () => {
    expect(nextIndexForKey("ArrowUp", 2, 3)).toBe(1);
    expect(nextIndexForKey("ArrowUp", 0, 3)).toBe(0);
  });

  it("未选中时 ↓ 落到首项、↑ 落到末项", () => {
    expect(nextIndexForKey("ArrowDown", -1, 3)).toBe(0);
    expect(nextIndexForKey("ArrowUp", -1, 3)).toBe(2);
  });

  it("Home / End 跳首尾", () => {
    expect(nextIndexForKey("Home", 2, 3)).toBe(0);
    expect(nextIndexForKey("End", 0, 3)).toBe(2);
  });

  it("其他按键与空列表不处理", () => {
    expect(nextIndexForKey("KeyA", 1, 3)).toBe(-1);
    expect(nextIndexForKey("ArrowDown", -1, 0)).toBe(-1);
  });
});
