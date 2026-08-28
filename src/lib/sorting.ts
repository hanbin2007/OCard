/**
 * 分类工作台的逻辑层（PRD §5.4 键盘驱动分类）。
 *
 * 主体是纯函数：选区模型、快捷键映射、待删清单状态机、动作受理闸门。
 * 组件负责渲染与 IPC，判断逻辑全部在这里，便于单测锁死行为。
 *
 * 末尾一节「键盘可达性」是**唯一**碰 DOM 的部分（焦点圈定 / 事件目标判定）。
 * 它放这里而不是各组件里各写一份，是因为网格、连拍组全屏层、大图、速查表
 * 四处必须遵守**同一套**规则——分散实现过一次，结果是四处规则各不相同，
 * Tab 从大图跑到背后的网格、Enter 在按钮上被快捷键劫持这类问题就是这么来的。
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

/** X 键：切换单项选中，并把焦点与锚点落到它（空格已改判给预览，见 resolveShortcut） */
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
  /*
   * 空格 = 预览(Quick Look 语义)。
   *
   * 这是 macOS 上「看一眼这是什么」的通用肌肉记忆(Finder / 照片 / 邮件附件都是它),
   * 而选片这件事里「看清楚」的频次远高于「加选」——把最顺手的键给了低频动作,
   * 等于逼着用户每张都先按 Enter。Enter 保留同义,老肌肉记忆不作废。
   * 让出来的「切换选中」改绑 X:Gmail 系列的 x 就是「勾选这一条」,
   * 且它离方向键那只手很近,与既有的 P/O/D/U/1–9 全不冲突,
   * 也不碰 ⌘空格(Spotlight)/Ctrl+空格(输入法)这两个系统键位。
   */
  if (key === " " || key === "Enter") return { type: "preview" };
  if (key === "x" || key === "X") return { type: "toggle" };
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
  /**
   * 这些素材**已经离开待分类夹**（被分类移走 / 已进回收站）。
   *
   * 与 `unmark` 的差别不是语义修饰，而是两件不同的事：`unmark` 是「用户改主意」，
   * 提交进行中理应挡下；`prune` 是「文件已经不在那儿了」，任何时候都必须生效。
   * 漏掉它的后果是实测过的：按 D 标删 A、再按 1 把 A 分类走，A 仍挂在
   * 「已标记 N 个待删除」上——「只看已标删」筛出来是空的，Shift+D 提交时
   * `trashAssets` 对 A 必然失败，而失败项按设计**永久留在清单里**，
   * 用户除了「取消标记」清空全部之外无法单独摘掉它。
   */
  | { type: "prune"; assetIds: string[] }
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

    case "prune": {
      /*
       * 不受 working 态阻挡（这是它与 unmark 的**唯一**理由）。
       * phase 也不在这里从 working / confirming 掉下来：提交还在飞、
       * 或确认框还开着，收尾归 commitFinished / cancelConfirm 管，
       * 半路改 phase 会让「只有确认过才能下发」这条不变量出现缺口。
       */
      const gone = new Set(action.assetIds);
      const hit =
        state.marked.some((id) => gone.has(id)) ||
        state.failed.some((f) => gone.has(f.assetId));
      // 没命中就返回原对象：绝大多数批量操作与待删清单无关，别白白推一次渲染
      if (!hit) return state;
      const marked = state.marked.filter((id) => !gone.has(id));
      const settled = state.phase === "working" || state.phase === "confirming";
      return {
        phase: settled ? state.phase : marked.length > 0 ? "marked" : "idle",
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

/**
 * 判定筛选组。
 *
 * **这里绝不能再出现 keep / drop。** 后端 `core/analysis.rs:318` 写死了
 * `suggested_keep` 的口径:「组内首选(荐优);无组时高分单张也不标(避免噪声)」——
 * 也就是说,**任何不在连拍组里的单张,哪怕 95 分,suggestedKeep 也恒为 false**。
 * 于是曾经的两个全局筛选都在说谎:
 *   keep = `!judgement || suggestedKeep` → 跑完分析后把**所有非连拍的已判定单张**藏光;
 *   drop = `judgement && !suggestedKeep` → 把那些单张全列成「建议放弃」。
 * 「建议保留」这个概念只在**连拍组内部**成立,因此它归回组全屏层
 * (组内「保留推荐,其余标删」+ 封面角标),不做全局筛选项。
 * 剩下的 blurry / lowScore / unjudged 都是逐张成立的客观指标,可以全局筛。
 */
export type JudgementFilter = "all" | "blurry" | "lowScore" | "unjudged";

export const JUDGEMENT_FILTER_LABEL: Record<JudgementFilter, string> = {
  all: "全部",
  blurry: "糊片",
  lowScore: "低分",
  unjudged: "未判定",
};

export function filterByJudgement<
  T extends {
    judgement?: { blurry: boolean; score: number };
  },
>(assets: T[], filter: JudgementFilter, lowScoreAt: number): T[] {
  switch (filter) {
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

/* ------------------------------------------------------------------ *
 * 动作受理闸门（零静默的落点）
 * ------------------------------------------------------------------ */

/**
 * 打标类动作的「受理结果」。
 *
 * 存在的理由是一次真实事故：`busy` / `deliveryWorking` 时底层函数直接
 * `return`，调用方却已经把大图/画廊的光标推到了下一张——界面表现得
 * 一模一样，用户于是相信刚才那张已经分好类/精选/标删了，实际什么都没发生。
 * 从此打标动作一律返回本类型：**被拒必须带 code + 原因**，调用方据此
 * ① 发一条用户看得见的通知，② 绝不前进光标。
 */
export type ActionOutcome =
  | { accepted: true }
  | { accepted: false; code: string; reason: string };

export type SortingActionKind = "assign" | "curate" | "mark" | "unmark";

const ACTION_VERB: Record<SortingActionKind, string> = {
  assign: "分类",
  curate: "精选",
  mark: "标删",
  unmark: "取消标删",
};

export interface ActionGate {
  /** 已选定项目（没有项目就没有作用对象） */
  hasProject: boolean;
  /** 上一批分类/精选的 IPC 还在飞 */
  busy: boolean;
  /** 交付打包进行中：同一批文件不能边打包边被挪走 */
  deliveryWorking: boolean;
  /** 待删清单正在提交进回收站（trashAssets 在飞） */
  committing: boolean;
  /** 本次动作解析出的目标数 */
  targetCount: number;
  /** 目标里已经在待删清单上的张数（只有 mark / unmark 用得上） */
  markedCount?: number;
}

/**
 * 这一下能不能被接受。
 *
 * 口径上刻意不对称的一条：**取消标删（U）在交付打包期间照样放行**。
 * 打包期禁的是「把文件挪走 / 新增删除意图」，而 U 只会让待删清单变短，
 * 不碰任何文件；把它一并锁住只会制造一个「误标了却撤不掉」的死角。
 */
export function gateAction(
  kind: SortingActionKind,
  gate: ActionGate,
): ActionOutcome {
  const verb = ACTION_VERB[kind];
  if (!gate.hasProject) {
    return {
      accepted: false,
      code: "sorting-action-no-project",
      reason: `还没有选中项目，${verb}没有作用对象。`,
    };
  }
  if (gate.targetCount === 0) {
    return {
      accepted: false,
      code: "sorting-action-no-target",
      reason:
        `没有选中任何素材，${verb}落空了。` +
        `先用方向键移动光标或点一格选中，再按这个键。`,
    };
  }
  if (gate.deliveryWorking && kind !== "unmark") {
    return {
      accepted: false,
      code: "sorting-action-delivery-locked",
      reason:
        `交付打包进行中，${verb}已暂时禁用（避免同一批文件边打包边被挪走）。` +
        `这一下没有生效，等打包结束再按一次。`,
    };
  }
  if (gate.committing && (kind === "mark" || kind === "unmark")) {
    return {
      accepted: false,
      code: "sorting-action-commit-busy",
      reason: `待删清单正在提交进回收站，此刻不能改标记。这一下没有生效，稍候再按。`,
    };
  }
  if (gate.busy && (kind === "assign" || kind === "curate")) {
    return {
      accepted: false,
      code: "sorting-action-busy",
      reason:
        `上一批${verb}还没落定，这一下没有被接受（不是已经做完了）。` +
        `等格子刷新后再按——连按会丢操作。`,
    };
  }
  if (kind === "unmark" && gate.markedCount === 0) {
    return {
      accepted: false,
      code: "sorting-action-not-marked",
      reason:
        "这些素材本来就没有标删，U 不会改变任何东西。" +
        "（U 只负责撤回标删；要标删请按 D。）",
    };
  }
  if (
    kind === "mark" &&
    gate.markedCount !== undefined &&
    gate.markedCount === gate.targetCount
  ) {
    return {
      accepted: false,
      code: "sorting-action-already-marked",
      reason: "这些素材已经全部在待删清单里了，这一下没有新增任何标记。",
    };
  }
  return { accepted: true };
}

/* ------------------------------------------------------------------ *
 * 键盘可达性（本文件唯一碰 DOM 的一节）
 * ------------------------------------------------------------------ */

/** 事件目标像不像「正在输入文字」的地方。用 duck typing，不依赖 DOM 全局。 */
export function isTextEntryTarget(target: unknown): boolean {
  const el = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable === true;
}

/**
 * 焦点落在原生可交互元素上时，Enter / 空格是**它自己的**语义。
 *
 * 少了这一条的后果是实测过的：Tab 到「重试」「全选」「上一张」按钮上按回车，
 * 父容器（或大图的 document capture 监听）把它解释成「预览 / 收起大图」并
 * `preventDefault`，按钮**完全不执行**——键盘用户被挡在按钮外面。
 */
export function isNativeActivationTarget(target: unknown, key: string): boolean {
  // "Spacebar" 是老 Edge/IE 的 key 值，一并认下不吃亏
  if (key !== "Enter" && key !== " " && key !== "Spacebar") return false;
  const el = target as {
    tagName?: unknown;
    getAttribute?: (name: string) => string | null;
  } | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toUpperCase();
  if (tag === "BUTTON" || tag === "SUMMARY" || tag === "OPTION") return true;
  const attr =
    typeof el.getAttribute === "function" ? el.getAttribute.bind(el) : null;
  if (tag === "A" && attr && attr("href") !== null) return true;
  const role = attr ? attr("role") : null;
  return (
    role === "button" ||
    role === "link" ||
    role === "menuitem" ||
    role === "menuitemcheckbox" ||
    role === "checkbox" ||
    role === "switch" ||
    role === "tab" ||
    role === "option"
  );
}

/**
 * 这一击键要不要让给事件目标自己处理。
 * 输入类目标一律全让（所有键）；可交互元素只让 Enter / 空格。
 */
export function shouldYieldShortcut(target: unknown, key: string): boolean {
  return isTextEntryTarget(target) || isNativeActivationTarget(target, key);
}

/** 焦点圈定用的可聚焦元素选择器（顺序即 Tab 顺序：querySelectorAll 按文档序返回） */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function focusablesIn(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => el.getAttribute("aria-hidden") !== "true");
}

/**
 * 全屏浮层的焦点圈定（focus trap）。
 *
 * `aria-modal="true"` 只是**说**自己是模态，浏览器不会因此拦住 Tab。
 * 不圈定的实际后果：Tab 几下焦点就跑到层背后的网格/按钮上，而此时 Esc
 * 又被浮层的键盘流吃掉——用户被困在一个看得见却操作不了的界面里。
 *
 * 只接管**边界**上的那一下（首项 Shift+Tab、末项 Tab、焦点不在层内），
 * 中间位置原样交给浏览器原生 Tab 顺序，避免自己实现一套有出入的顺序。
 * 返回 true 表示已接管，调用方应 `preventDefault()`。
 */
export function trapTabFocus(
  container: HTMLElement | null,
  event: { key: string; shiftKey?: boolean },
): boolean {
  if (event.key !== "Tab" || !container) return false;
  const items = focusablesIn(container);
  if (items.length === 0) {
    // 层里没有可聚焦子元素：焦点留在层本身，别让它溜到背后
    container.focus();
    return true;
  }
  const active =
    typeof document !== "undefined"
      ? (document.activeElement as HTMLElement | null)
      : null;
  const index = active ? items.indexOf(active) : -1;
  if (index < 0) {
    (event.shiftKey ? items[items.length - 1] : items[0]).focus();
    return true;
  }
  if (event.shiftKey && index === 0) {
    items[items.length - 1].focus();
    return true;
  }
  if (!event.shiftKey && index === items.length - 1) {
    items[0].focus();
    return true;
  }
  return false;
}
