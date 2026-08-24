import { describe, expect, it } from "vitest";
import {
  buildFolderTree,
  countFolders,
  flattenTree,
  SCENARIO_A_FOLDERS,
} from "./folderTree";

describe("buildFolderTree - 工况 A", () => {
  const tree = buildFolderTree("A");

  it("生成规范取齐后的六个固定夹", () => {
    expect(tree.map((n) => n.name)).toEqual([
      "1. 工程文件",
      "2. 原始素材",
      "3. 特别素材",
      "4. 转码素材",
      "5. 文字素材",
      "6. 成片",
    ]);
  });

  it("固定夹没有子级，总数为 6", () => {
    expect(tree.every((n) => n.children === undefined)).toBe(true);
    expect(countFolders(tree)).toBe(SCENARIO_A_FOLDERS.length);
  });

  it("忽略传入的分类名（工况 A 不吃分类）", () => {
    expect(buildFolderTree("A", ["领导", "会场"])).toEqual(tree);
  });
});

describe("buildFolderTree - 工况 B", () => {
  it("按 待分类 → 分类 → 精选 → 其他 依次编号", () => {
    const tree = buildFolderTree("B", ["开幕式", "田赛", "颁奖"]);
    expect(tree.map((n) => n.name)).toEqual([
      "1. 待分类",
      "2. 开幕式",
      "3. 田赛",
      "4. 颁奖",
      "5. 精选",
      "6. 其他",
    ]);
  });

  it("精选内含 待修 / 已修 两个子夹", () => {
    const tree = buildFolderTree("B", ["会场"]);
    const selected = tree.find((n) => n.name === "3. 精选");
    expect(selected?.children?.map((c) => c.name)).toEqual(["待修", "已修"]);
    expect(flattenTree(tree)).toContain("3. 精选/待修");
    expect(flattenTree(tree)).toContain("3. 精选/已修");
  });

  it("没有自定义分类时仍生成 待分类/精选/其他", () => {
    const tree = buildFolderTree("B", []);
    expect(tree.map((n) => n.name)).toEqual(["1. 待分类", "2. 精选", "3. 其他"]);
  });

  it("空白分类名被丢弃，不占编号", () => {
    const tree = buildFolderTree("B", ["领导", "   ", "花絮"]);
    expect(tree.map((n) => n.name)).toEqual([
      "1. 待分类",
      "2. 领导",
      "3. 花絮",
      "4. 精选",
      "5. 其他",
    ]);
  });

  it("分类名中的非法字符被清洗", () => {
    const tree = buildFolderTree("B", ["领导/合影"]);
    expect(tree[1].name).toBe("2. 领导合影");
  });

  it("文件夹总数 = 3 固定 + 分类数 + 2 精选子夹", () => {
    expect(countFolders(buildFolderTree("B", ["a", "b", "c"]))).toBe(3 + 3 + 2);
  });
});

describe("flattenTree", () => {
  it("按深度优先展开成相对路径", () => {
    expect(flattenTree([{ name: "父", children: [{ name: "子" }] }])).toEqual([
      "父",
      "父/子",
    ]);
  });
});
