/**
 * 建夹模板（PRD §5.2）。纯函数：给定工况与分类名，产出将要创建的文件夹树。
 * 向导右侧预览与 Rust 侧 `project_store` 实际建夹必须用同一套规则。
 */

import type { FolderNode, Scenario } from "../api/types";
import { sanitizeSegment } from "./naming";

/** 工况 A 固定六个一级夹，序号已按 PRD §5.2 取齐 */
export const SCENARIO_A_FOLDERS = [
  "1. 工程文件",
  "2. 原始素材",
  "3. 特别素材",
  "4. 转码素材",
  "5. 文字素材",
  "6. 成片",
] as const;

/** 工况 B 新建项目时的默认分类建议 */
export const DEFAULT_B_CATEGORIES = ["领导", "会场", "花絮"];

/** 工况 B 固定夹名 */
export const B_INBOX = "待分类";
export const B_SELECTED = "精选";
export const B_SELECTED_CHILDREN = ["待修", "已修"];
export const B_OTHER = "其他";

/**
 * 生成一级文件夹树。
 * - 工况 A：六个固定夹，无子级。
 * - 工况 B：`1. 待分类` → `2..n 各分类` → `n+1. 精选（待修/已修）` → `n+2. 其他`。
 *   分类名会经 sanitizeSegment 清洗，空名被丢弃。
 */
export function buildFolderTree(
  scenario: Scenario,
  categories: string[] = [],
): FolderNode[] {
  if (scenario === "A") {
    return SCENARIO_A_FOLDERS.map((name) => ({ name }));
  }

  const cleanCategories = categories
    .map((c) => sanitizeSegment(c))
    .filter((c) => c.length > 0);

  const nodes: FolderNode[] = [{ name: `1. ${B_INBOX}` }];

  cleanCategories.forEach((category, index) => {
    nodes.push({ name: `${index + 2}. ${category}` });
  });

  const selectedIndex = cleanCategories.length + 2;
  nodes.push({
    name: `${selectedIndex}. ${B_SELECTED}`,
    children: B_SELECTED_CHILDREN.map((name) => ({ name })),
  });
  nodes.push({ name: `${selectedIndex + 1}. ${B_OTHER}` });

  return nodes;
}

/** 把树拍平成相对路径列表，便于比对与测试（如 `3. 精选/待修`） */
export function flattenTree(nodes: FolderNode[], prefix = ""): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    out.push(path);
    if (node.children?.length) {
      out.push(...flattenTree(node.children, path));
    }
  }
  return out;
}

/** 将创建的文件夹总数（含子级），向导预览用 */
export function countFolders(nodes: FolderNode[]): number {
  return flattenTree(nodes).length;
}
