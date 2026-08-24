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
  | { type: "closePreview" };

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
  if (key === "Escape") return { type: "closePreview" };

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
      return { type: "markDelete" };
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

export const GROUP_ID_PREFIX = "group:";

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
): Array<GridEntry<T>> {
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

/** 把条目 id（可能含组 id）展开成真实的 assetId 列表 */
export function resolveEntryIds<T extends { id: string }>(
  entries: Array<GridEntry<T>>,
  entryIds: string[],
): string[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const out: string[] = [];
  for (const id of entryIds) {
    const entry = byId.get(id);
    if (!entry) continue;
    if (entry.kind === "group") out.push(...entry.items.map((item) => item.id));
    else out.push(entry.asset.id);
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
