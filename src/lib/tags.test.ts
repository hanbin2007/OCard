/** 内容标签纯逻辑:调色板分配、命名规整、查找与兼容拼串。 */

import { describe, expect, it } from "vitest";
import type { ProjectTag } from "../api/types";
import {
  colorOfTag,
  findTag,
  joinTagsAsNote,
  nextTagColor,
  normalizeTagColor,
  normalizeTagName,
  TAG_COLORS,
  TAG_NAME_MAX,
  tagKey,
  tagNameError,
} from "./tags";

describe("normalizeTagName / tagKey", () => {
  it("去首尾空白并折叠连续空白", () => {
    expect(normalizeTagName("  上午  田赛 ")).toBe("上午 田赛");
  });

  it("比对键大小写不敏感", () => {
    expect(tagKey("Ceremony")).toBe(tagKey("ceremony"));
  });
});

describe("tagNameError", () => {
  it("空名与非法字符被拦下", () => {
    expect(tagNameError("   ")).toContain("不能为空");
    expect(tagNameError("a/b")).toContain("不能包含");
  });

  it("超长被拦下,合法名放行", () => {
    expect(tagNameError("字".repeat(TAG_NAME_MAX + 1))).toContain("不超过");
    expect(tagNameError("颁奖")).toBeNull();
  });
});

describe("nextTagColor", () => {
  it("空库从调色板第一色开始", () => {
    expect(nextTagColor([])).toBe(TAG_COLORS[0]);
  });

  it("取当前使用最少的色:连续新建颜色自然错开", () => {
    const tags: ProjectTag[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < TAG_COLORS.length; i += 1) {
      const color = nextTagColor(tags);
      expect(seen.has(color)).toBe(false);
      seen.add(color);
      tags.push({ name: `t${i}`, color });
    }
  });

  it("库里混入未知色名不会崩,按灰色计数", () => {
    expect(() =>
      nextTagColor([{ name: "坏", color: "hotpink" }]),
    ).not.toThrow();
  });
});

describe("findTag / colorOfTag", () => {
  const lib: ProjectTag[] = [
    { name: "颁奖", color: "purple" },
    { name: "花絮", color: "pink" },
  ];

  it("按规整后的键找同名标签", () => {
    expect(findTag(lib, " 颁奖 ")?.color).toBe("purple");
    expect(findTag(lib, "不存在")).toBeUndefined();
  });

  it("库里没有的旧标签给灰色兜底;坏色名同样回退灰色", () => {
    expect(colorOfTag(lib, "旧备注标签")).toBe("gray");
    expect(colorOfTag([{ name: "坏", color: "??" }], "坏")).toBe("gray");
    expect(normalizeTagColor("blue")).toBe("blue");
  });
});

describe("joinTagsAsNote", () => {
  it("用顿号拼出人类可读的兼容备注", () => {
    expect(joinTagsAsNote(["田赛", "4×100决赛"])).toBe("田赛、4×100决赛");
  });
});
