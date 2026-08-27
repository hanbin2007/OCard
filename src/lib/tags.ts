/**
 * 项目内容标签（Notion 式）的纯逻辑：调色板、命名规整、配色分配。
 * 标签库随项目存 `.ocard/settings.json`（见 api.getProjectSettings）。
 */

import type { ProjectTag } from "../api/types";
import { hasIllegalChars } from "./naming";

/**
 * 固定调色板（色名 → CSS 由 `styles/components.css` 的 `.tag--<name>` 承接）。
 * 存色名而不是色值：亮/暗主题各有一套渲染，项目数据不锁死具体颜色。
 */
export const TAG_COLORS = [
  "gray",
  "blue",
  "green",
  "yellow",
  "orange",
  "red",
  "purple",
  "pink",
  "teal",
  "brown",
] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export const TAG_NAME_MAX = 20;

/** 未知/损坏的色名统一回退（settings.json 是共享文件，可能被旧版或人工改坏） */
export function normalizeTagColor(color: string): TagColor {
  return (TAG_COLORS as readonly string[]).includes(color)
    ? (color as TagColor)
    : "gray";
}

/** 标签名规整：去首尾空白、连续空白折一格 */
export function normalizeTagName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** 标签名校验；返回 null 表示可用，否则为错误文案 */
export function tagNameError(raw: string): string | null {
  const name = normalizeTagName(raw);
  if (!name) return "标签名不能为空";
  if (hasIllegalChars(name)) return '标签名不能包含 \\ / : * ? " < > | 等字符';
  if (name.length > TAG_NAME_MAX) return `标签名不超过 ${TAG_NAME_MAX} 个字符`;
  return null;
}

/** 名字比对键：大小写不敏感，避免「花絮」「花絮 」这类重复 */
export function tagKey(name: string): string {
  return normalizeTagName(name).toLowerCase();
}

/**
 * 给新标签挑颜色：取当前使用最少的色，平局按调色板顺序。
 * 这样连续新建的标签颜色自然错开，同 Notion 的观感。
 */
export function nextTagColor(existing: ProjectTag[]): TagColor {
  const counts = new Map<TagColor, number>(TAG_COLORS.map((c) => [c, 0]));
  for (const tag of existing) {
    const color = normalizeTagColor(tag.color);
    counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  let best: TagColor = TAG_COLORS[0];
  let bestCount = Number.POSITIVE_INFINITY;
  for (const color of TAG_COLORS) {
    const n = counts.get(color) ?? 0;
    if (n < bestCount) {
      best = color;
      bestCount = n;
    }
  }
  return best;
}

/** 在标签库里找同名标签（比对键规则同 tagKey） */
export function findTag(tags: ProjectTag[], name: string): ProjectTag | undefined {
  const key = tagKey(name);
  return tags.find((t) => tagKey(t.name) === key);
}

/** 任务上的标签名 → 呈现色（库里没有的旧标签给灰色兜底） */
export function colorOfTag(tags: ProjectTag[], name: string): TagColor {
  const found = findTag(tags, name);
  return found ? normalizeTagColor(found.color) : "gray";
}

/** 兼容字段 note 的拼串规则（写入 manifest / 审计日志的可读形态） */
export function joinTagsAsNote(tags: string[]): string {
  return tags.join("、");
}
