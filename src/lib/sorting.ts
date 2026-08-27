/**
 * 分类工作台的纯逻辑（PRD §5.4 键盘驱动分类）。
 *
 * 这里只有纯函数：选区模型、快捷键映射、待删清单状态机。
 * 组件负责渲染与 IPC，判断逻辑全部在这里，便于单测锁死行为。
 */

import type { SortingCategory } from "../api/types";

/* ------------------------------------------------------------------ *
 * 选区模型
 * ------------------------------------------------------------------ */

export interface Selection {
  /** 焦点所在项（方向键移动的就是它） */
  cursor: string | null;
  /** 连选的锚点 */
  anchor: string | null;
  /** 已选中的 id（无序） */
  selected: string[];
}

export const emptySelection: Selection = { cursor: null, anchor: null, selected: [] };

/** 网格里按方向键后的目标下标；-1 表示不处理 */
export function nextIndexInGrid(
  key: string,
  current: number,
  length: number,
  columns: number,
): number {
  if (length === 0) return -1;
  const at = current < 0 ? 0 : current;
  switch (key) {
    case "ArrowRight":
      return current < 0 ? 0 : Math.min(length - 1, at + 1);
    case "ArrowLeft":
      return current < 0 ? 0 : Math.max(0, at - 1);
    case "ArrowDown":
      return current < 0 ? 0 : Math.min(length - 1, at + columns);
    case "ArrowUp":
      return current < 0 ? 0 : Math.max(0, at - columns);
    case "Home":
      return 0;
    case "End":
      return length - 1;
    case "PageDown":
      return Math.min(length - 1, at + columns * 4);
    case "PageUp":
      return Math.max(0, at - columns * 4);
    default:
      return -1;
  }
}

/** 取 ids 中 [a, b] 闭区间（顺序无关） */
export function rangeBetween(ids: string[], a: string, b: string): string[] {
  const ia = ids.indexOf(a);
  const ib = ids.indexOf(b);
  if (ia < 0 || ib < 0) return [];
  const [from, to] = ia <= ib ? [ia, ib] : [ib, ia];
  return ids.slice(from, to + 1);
}

/** 移动焦点。extend=true 时以 anchor 为基准连选。 */
export function moveCursor(
  ids: string[],
  selection: Selection,
  key: string,
  columns: number,
  extend = false,
): Selection {
  const current = selection.cursor ? ids.indexOf(selection.cursor) : -1;
  const target = nextIndexInGrid(key, current, ids.length, columns);
  if (target < 0) return selection;

  const cursor = ids[target];
  if (!extend) {
    // 普通移动：单选跟随焦点，锚点重置
    return { cursor, anchor: cursor, selected: [cursor] };
  }
  const anchor = selection.anchor ?? selection.cursor ?? cursor;
  return { cursor, anchor, selected: rangeBetween(ids, anchor, cursor) };
}

/** 空格：切换单项选中，并把焦点与锚点落到它 */
export function toggleSelection(selection: Selection, id: string): Selection {
  const has = selection.selected.includes(id);
  return {
    cursor: id,
    anchor: id,
    selected: has
      ? selection.selected.filter((x) => x !== id)
      : [...selection.selected, id],
  };
}

/** 点击选择：普通点击单选，shift 连选，ctrl/cmd 加选 */
export function clickSelection(
  ids: string[],
  selection: Selection,
  id: string,
  modifiers: { shift?: boolean; meta?: boolean } = {},
): Selection {
  if (modifiers.shift && selection.anchor) {
    return {
      cursor: id,
      anchor: selection.anchor,
      selected: rangeBetween(ids, selection.anchor, id),
    };
  }
  if (modifiers.meta) return toggleSelection(selection, id);
  return { cursor: id, anchor: id, selected: [id] };
}

export function selectAll(ids: string[], selection: Selection): Selection {
  return {
    cursor: selection.cursor ?? ids[0] ?? null,
    anchor: ids[0] ?? null,
    selected: [...ids],
  };
}

/** 把已消失的 id 从选区里剔除（移动/删除之后调用） */
export function pruneSelection(selection: Selection, removed: string[]): Selection {
  const gone = new Set(removed);
  const selected = selection.selected.filter((id) => !gone.has(id));
  return {
    cursor: selection.cursor && gone.has(selection.cursor) ? null : selection.cursor,
    anchor: selection.anchor && gone.has(selection.anchor) ? null : selection.anchor,
    selected,
  };
}

/** 操作实际作用的目标：有选区就用选区，否则用光标所在项 */
export function actionTargets(selection: Selection): string[] {
  if (selection.selected.length > 0) return selection.selected;
  return selection.cursor ? [selection.cursor] : [];
}

/**
 * 分类/删除把条目移出网格后,光标应落在被移除块的**下一个**条目上
 * (评审 3.1):「看一张→按一键→看下一张」的循环不能每次都断在
 * 「光标归零、方向键从头找位置」上——这是 Photo Mechanic/Lightroom
 * 选片流的标准模型。块尾没有下一个时退而落在前一个;全移光了返回 null。
 */
export function nextCursorAfterRemoval(
  ids: string[],
  removedIds: string[],
): string | null {
  const removed = new Set(removedIds);
  let lastRemovedAt = -1;
  for (let i = 0; i < ids.length; i += 1) {
    if (removed.has(ids[i])) lastRemovedAt = i;
  }
  if (lastRemovedAt < 0) return null;
  for (let i = lastRemovedAt + 1; i < ids.length; i += 1) {
    if (!removed.has(ids[i])) return ids[i];
  }
  for (let i = lastRemovedAt - 1; i >= 0; i -= 1) {
    if (!removed.has(ids[i])) return ids[i];
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 快捷键映射
 * ------------------------------------------------------------------ */

export type SortingAction =
  | { type: "assign"; categoryId: string }
  | { type: "curate" }
  | { type: "other" }
  | { type: "markDelete" }
  | { type: "unmarkDelete" }
  | { type: "preview" }
  | { type: "toggle" }
  | { type: "selectAll" }
  | { type: "move"; key: string; extend: boolean }
  | { type: "closePreview" }
  /** 网格态 Esc:清空选区(评审 3.8;预览打开时 Esc 仍是关预览) */
  | { type: "clearSelection" }
  /** Shift+D:待删清单直接进入确认(评审 3.9,标完不必再摸鼠标) */
  | { type: "confirmDelete" };

export interface KeyEventLike {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

const MOVE_KEYS = [
  "ArrowRight",
  "ArrowLeft",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
];

/**
 * 把按键解析成动作。返回 null 表示不拦截（交给浏览器/输入框）。
 * 数字键 1–9 绑定到 hotkey 相同的自定义分类；没有对应分类时不响应。
 */
export function resolveShortcut(
  event: KeyEventLike,
  categories: SortingCategory[],
  context: { previewOpen?: boolean } = {},
): SortingAction | null {
  const { key } = event;

  if (context.previewOpen) {
    if (key === "Escape") return { type: "closePreview" };
    if (key === "ArrowRight" || key === "ArrowLeft") {
      return { type: "move", key, extend: false };
    }
  }

  if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === "a") {
    return { type: "selectAll" };
  }
  // 其余带修饰键的组合一律放行，别抢系统快捷键
  if (event.metaKey || event.ctrlKey) return null;

  if (MOVE_KEYS.includes(key)) {
    return { type: "move", key, extend: Boolean(event.shiftKey) };
  }
  if (key === " ") return { type: "toggle" };
  if (key === "Enter") return { type: "preview" };
  // 网格态 Esc = 清空选区;预览态在上面已拦下作关预览
  if (key === "Escape") return { type: "clearSelection" };

  if (/^[1-9]$/.test(key)) {
    const hotkey = Number(key);
    const category = categories.find(
      (c) => c.kind === "custom" && c.hotkey === hotkey,
    );
    return category ? { type: "assign", categoryId: category.id } : null;
  }

  switch (key.toLowerCase()) {
    case "p":
      return { type: "curate" };
    case "o":
      return { type: "other" };
    case "d":
      // Shift+D 提交待删清单;裸 D 由调用方做 toggle(全部已标→取消,否则标记)
      return event.shiftKey ? { type: "confirmDelete" } : { type: "markDelete" };
    case "u":
      return { type: "unmarkDelete" };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * 待删清单状态机（两段式删除，PRD §5.4 / §6.4）
 * ------------------------------------------------------------------ */

export type PendingDeletePhase = "idle" | "marked" | "confirming" | "working";

export interface PendingDeleteState {
  phase: PendingDeletePhase;
  /** 已标记待删的 assetId，顺序即标记顺序 */
  marked: string[];
  /** 上一次提交里失败的条目，必须留在清单里 */
  failed: Array<{ assetId: string; message: string }>;
}

export const initialPendingDelete: PendingDeleteState = {
  phase: "idle",
  marked: [],
  failed: [],
};

export type PendingDeleteAction =
  | { type: "mark"; assetIds: string[] }
  | { type: "unmark"; assetIds: string[] }
  | { type: "clear" }
  | { type: "requestConfirm" }
  | { type: "cancelConfirm" }
  | { type: "commitStarted" }
  | { type: "commitFinished"; succeeded: string[]; failed: PendingDeleteState["failed"] };

/**
 * 两段式删除的状态机。
 *
 * 不变量：
 * - 只有经过 `requestConfirm` → `commitStarted` 才可能真正下发删除；
 * - 标记为空时不进入确认态（不给「确认删除 0 项」这种荒唐入口）；
 * - 提交后失败的条目**留在清单里**，绝不假装删掉了。
 */
export function pendingDeleteReducer(
  state: PendingDeleteState,
  action: PendingDeleteAction,
): PendingDeleteState {
  switch (action.type) {
    case "mark": {
      if (state.phase === "working") return state;
      const merged = [...state.marked];
      for (const id of action.assetIds) {
        if (!merged.includes(id)) merged.push(id);
      }
      return {
        ...state,
        marked: merged,
        phase: merged.length > 0 ? "marked" : "idle",
      };
    }

    case "unmark": {
      if (state.phase === "working") return state;
      const gone = new Set(action.assetIds);
      const marked = state.marked.filter((id) => !gone.has(id));
      return {
        phase: marked.length > 0 ? "marked" : "idle",
        marked,
        failed: state.failed.filter((f) => !gone.has(f.assetId)),
      };
    }

    case "clear":
      return state.phase === "working" ? state : initialPendingDelete;

    case "requestConfirm":
      // 空清单不给确认入口
      if (state.marked.length === 0) return state;
      return { ...state, phase: "confirming" };

    case "cancelConfirm":
      return state.phase === "confirming"
        ? { ...state, phase: "marked" }
        : state;

    case "commitStarted":
      // 只能从确认态进入执行态：绕过确认的调用一律无效
      return state.phase === "confirming" ? { ...state, phase: "working" } : state;

    case "commitFinished": {
      const done = new Set(action.succeeded);
      const marked = state.marked.filter((id) => !done.has(id));
      return {
        phase: marked.length > 0 ? "marked" : "idle",
        marked,
        failed: action.failed,
      };
    }

    default:
      return state;
  }
}

/** 连拍组折叠：同 groupId 的相邻项归为一组 */
export function groupBurst<T extends { id: string; groupId?: string }>(
  assets: T[],
): Array<{ groupId: string | null; items: T[] }> {
  const out: Array<{ groupId: string | null; items: T[] }> = [];
  for (const asset of assets) {
    const key = asset.groupId ?? null;
    const tail = out[out.length - 1];
    if (tail && key !== null && tail.groupId === key) tail.items.push(asset);
    else out.push({ groupId: key, items: [asset] });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 连拍折叠（M3 W7a）
 * ------------------------------------------------------------------ */

/**
 * 组条目 id 前缀。用 NUL 开头：素材 id 是项目内相对路径，
 * 路径里可以出现冒号（macOS 允许），但**不可能**出现 NUL，
 * 所以这个前缀与真实素材 id 不会碰撞。
 */
export const GROUP_ID_PREFIX = "\u0000group:";

export interface AssetEntry<T> {
  kind: "asset";
  id: string;
  asset: T;
}

export interface GroupEntry<T> {
  kind: "group";
  id: string;
  groupId: string;
  items: T[];
}

export type GridEntry<T> = AssetEntry<T> | GroupEntry<T>;

/**
 * 把素材列表折成网格条目：相邻同 groupId 且 ≥2 件的折成**一格**。
 *
 * 折叠后选区仍然只认「条目 id」——组条目用 `group:<groupId>` 这个合成 id，
 * 因此 VirtualGrid 的等高行不被破坏，选择模型也完全不用改。
 * 真正下发操作前用 `resolveEntryIds` 把组 id 展开成成员 assetId。
 */
export function buildGridEntries<T extends { id: string; groupId?: string }>(
  assets: T[],
  onDegrade?: (reason: string) => void,
): Array<GridEntry<T>> {
  // 前缀碰撞防御：真实 id 若撞上前缀，宁可不折叠也不能张冠李戴
  if (assets.some((a) => a.id.startsWith(GROUP_ID_PREFIX))) {
    onDegrade?.("素材 id 与组前缀冲突，已停用连拍折叠");
    return assets.map((asset) => ({ kind: "asset", id: asset.id, asset }));
  }

  // 重复 id 防御：Map 覆盖会让一格永远选不中，降级为不折叠并告警
  const seen = new Set<string>();
  for (const asset of assets) {
    if (seen.has(asset.id)) {
      onDegrade?.(`素材 id 重复（${asset.id}），已停用连拍折叠`);
      return assets.map((a) => ({ kind: "asset", id: a.id, asset: a }));
    }
    seen.add(asset.id);
  }

  const out: Array<GridEntry<T>> = [];
  for (const group of groupBurst(assets)) {
    if (group.groupId !== null && group.items.length > 1) {
      out.push({
        kind: "group",
        id: `${GROUP_ID_PREFIX}${group.groupId}`,
        groupId: group.groupId,
        items: group.items,
      });
    } else {
      for (const asset of group.items) {
        out.push({ kind: "asset", id: asset.id, asset });
      }
    }
  }
  return out;
}

/**
 * 把条目 id 展开成真实的 assetId 列表。
 *
 * 同时接受**裸素材 id**——组展开层里选中的是组内单件，它没有自己的条目 id。
 * 早先只认条目 id，导致展开层的选中被静默丢弃、分类/精选/标删拿到空集直接返回，
 * 与展开层「组内可单独选中并执行」的文案自相矛盾。
 */
export function resolveEntryIds<T extends { id: string }>(
  entries: Array<GridEntry<T>>,
  entryIds: string[],
): string[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const memberIds = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "group") {
      for (const item of entry.items) memberIds.add(item.id);
    } else {
      memberIds.add(entry.asset.id);
    }
  }

  const out: string[] = [];
  for (const id of entryIds) {
    const entry = byId.get(id);
    if (entry) {
      if (entry.kind === "group") out.push(...entry.items.map((item) => item.id));
      else out.push(entry.asset.id);
      continue;
    }
    // 裸素材 id（组展开层的选中）
    if (memberIds.has(id)) out.push(id);
  }
  // 组与成员同时被选中时去重
  return [...new Set(out)];
}

/**
 * 按「这些素材被移走后」计算将随之消失的条目 id:
 * 单件条目 = 素材本身被移走;组条目 = 组内全部成员被移走(部分移走的组留在原地)。
 * 与 nextCursorAfterRemoval 配对使用——光标前进要在条目 id 空间里算。
 */
export function removedEntryIds<T extends { id: string }>(
  entries: Array<GridEntry<T>>,
  removedAssetIds: string[],
): string[] {
  const removed = new Set(removedAssetIds);
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "group") {
      if (entry.items.every((item) => removed.has(item.id))) out.push(entry.id);
    } else if (removed.has(entry.asset.id)) {
      out.push(entry.id);
    }
  }
  return out;
}

/** 把网格条目摊平成显示顺序的素材列表——预览用的**唯一**下标空间 */
export function flattenEntries<T extends { id: string }>(
  entries: Array<GridEntry<T>>,
): T[] {
  const out: T[] = [];
  for (const entry of entries) {
    if (entry.kind === "group") out.push(...entry.items);
    else out.push(entry.asset);
  }
  return out;
}

/** 「按建议筛选」：只保留 AI 建议保留的、以及没有判定结果的 */
export function filterBySuggestion<
  T extends { judgement?: { suggestedKeep: boolean } },
>(assets: T[], enabled: boolean): T[] {
  if (!enabled) return assets;
  return assets.filter((a) => !a.judgement || a.judgement.suggestedKeep);
}

/**
 * 判定筛选组(评审 3.6):选片的两个批量动作是「这批全要」和「这批全不要」。
 * 旧的单勾选只支持前一半——「AI 建议放弃的全标删」没有任何路径。
 * keep 沿用旧口径(建议保留 + 未判定,漏判不该被藏起来);
 * drop 是它的严格反集(有判定且不建议保留),两边拼起来恰好覆盖全量。
 */
export type JudgementFilter =
  | "all"
  | "keep"
  | "drop"
  | "blurry"
  | "lowScore"
  | "unjudged";

export const JUDGEMENT_FILTER_LABEL: Record<JudgementFilter, string> = {
  all: "全部",
  keep: "建议保留（含未判定）",
  drop: "建议放弃",
  blurry: "糊片",
  lowScore: "低分",
  unjudged: "未判定",
};

export function filterByJudgement<
  T extends {
    judgement?: { suggestedKeep: boolean; blurry: boolean; score: number };
  },
>(assets: T[], filter: JudgementFilter, lowScoreAt: number): T[] {
  switch (filter) {
    case "keep":
      return assets.filter((a) => !a.judgement || a.judgement.suggestedKeep);
    case "drop":
      return assets.filter((a) => a.judgement && !a.judgement.suggestedKeep);
    case "blurry":
      return assets.filter((a) => a.judgement?.blurry);
    case "lowScore":
      return assets.filter(
        (a) => a.judgement !== undefined && a.judgement.score < lowScoreAt,
      );
    case "unjudged":
      return assets.filter((a) => !a.judgement);
    default:
      return assets;
  }
}
