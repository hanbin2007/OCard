import { describe, expect, it } from "vitest";
import type { SortingCategory } from "../api/types";
import {
  actionTargets,
  buildGridEntries,
  filterBySuggestion,
  resolveEntryIds,
  clickSelection,
  emptySelection,
  groupBurst,
  initialPendingDelete,
  moveCursor,
  nextIndexInGrid,
  pendingDeleteReducer,
  pruneSelection,
  rangeBetween,
  resolveShortcut,
  selectAll,
  toggleSelection,
  type PendingDeleteState,
} from "./sorting";

const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
const COLUMNS = 3;

const categories: SortingCategory[] = [
  { id: "inbox", name: "待分类", folderName: "1. 待分类", kind: "inbox", count: 10 },
  { id: "cat-1", name: "开幕式", folderName: "2. 开幕式", kind: "custom", count: 3, hotkey: 1 },
  { id: "cat-2", name: "田赛", folderName: "3. 田赛", kind: "custom", count: 2, hotkey: 2 },
  { id: "curated", name: "精选", folderName: "4. 精选", kind: "curated", count: 1 },
  { id: "other", name: "其他", folderName: "5. 其他", kind: "other", count: 0 },
];

describe("nextIndexInGrid", () => {
  it("左右移动一格，两端夹住", () => {
    expect(nextIndexInGrid("ArrowRight", 0, 9, COLUMNS)).toBe(1);
    expect(nextIndexInGrid("ArrowRight", 8, 9, COLUMNS)).toBe(8);
    expect(nextIndexInGrid("ArrowLeft", 4, 9, COLUMNS)).toBe(3);
    expect(nextIndexInGrid("ArrowLeft", 0, 9, COLUMNS)).toBe(0);
  });

  it("上下移动一整行", () => {
    expect(nextIndexInGrid("ArrowDown", 1, 9, COLUMNS)).toBe(4);
    expect(nextIndexInGrid("ArrowUp", 7, 9, COLUMNS)).toBe(4);
  });

  it("末行下移不越界，首行上移不越界", () => {
    expect(nextIndexInGrid("ArrowDown", 7, 9, COLUMNS)).toBe(8);
    expect(nextIndexInGrid("ArrowUp", 1, 9, COLUMNS)).toBe(0);
  });

  it("未选中时任意方向键都落到首项", () => {
    expect(nextIndexInGrid("ArrowDown", -1, 9, COLUMNS)).toBe(0);
    expect(nextIndexInGrid("ArrowUp", -1, 9, COLUMNS)).toBe(0);
  });

  it("Home/End 跳首尾，PageUp/PageDown 跨四行", () => {
    expect(nextIndexInGrid("Home", 5, 9, COLUMNS)).toBe(0);
    expect(nextIndexInGrid("End", 0, 9, COLUMNS)).toBe(8);
    expect(nextIndexInGrid("PageDown", 0, 100, COLUMNS)).toBe(12);
    expect(nextIndexInGrid("PageUp", 50, 100, COLUMNS)).toBe(38);
  });

  it("空列表与无关按键不处理", () => {
    expect(nextIndexInGrid("ArrowDown", 0, 0, COLUMNS)).toBe(-1);
    expect(nextIndexInGrid("KeyZ", 0, 9, COLUMNS)).toBe(-1);
  });
});

describe("选区模型", () => {
  it("普通移动 = 单选跟随焦点", () => {
    const s = moveCursor(ids, emptySelection, "ArrowRight", COLUMNS);
    expect(s.cursor).toBe("a");
    expect(s.selected).toEqual(["a"]);

    const s2 = moveCursor(ids, s, "ArrowRight", COLUMNS);
    expect(s2.cursor).toBe("b");
    expect(s2.selected).toEqual(["b"]);
  });

  it("Shift + 方向键以锚点连选，且随方向回缩", () => {
    const start = clickSelection(ids, emptySelection, "b");
    const ext = moveCursor(ids, start, "ArrowRight", COLUMNS, true);
    expect(ext.selected).toEqual(["b", "c"]);

    const more = moveCursor(ids, ext, "ArrowDown", COLUMNS, true);
    expect(more.selected).toEqual(["b", "c", "d", "e", "f"]);

    // 往回收，选区跟着缩小，锚点不动
    const back = moveCursor(ids, more, "ArrowUp", COLUMNS, true);
    expect(back.anchor).toBe("b");
    expect(back.selected).toEqual(["b", "c"]);
  });

  it("连选跨越锚点两侧都成立", () => {
    expect(rangeBetween(ids, "e", "b")).toEqual(["b", "c", "d", "e"]);
    expect(rangeBetween(ids, "b", "e")).toEqual(["b", "c", "d", "e"]);
    expect(rangeBetween(ids, "b", "zz")).toEqual([]);
  });

  it("空格切换单项选中", () => {
    const on = toggleSelection(emptySelection, "c");
    expect(on.selected).toEqual(["c"]);
    const off = toggleSelection(on, "c");
    expect(off.selected).toEqual([]);
    expect(off.cursor).toBe("c");
  });

  it("点击：普通单选 / shift 连选 / meta 加选", () => {
    const one = clickSelection(ids, emptySelection, "b");
    expect(one.selected).toEqual(["b"]);

    const ranged = clickSelection(ids, one, "d", { shift: true });
    expect(ranged.selected).toEqual(["b", "c", "d"]);

    const added = clickSelection(ids, one, "f", { meta: true });
    expect(added.selected).toEqual(["b", "f"]);
  });

  it("全选与剪除已消失项", () => {
    const all = selectAll(ids, emptySelection);
    expect(all.selected).toHaveLength(9);

    const pruned = pruneSelection(all, ["a", "b"]);
    expect(pruned.selected).toHaveLength(7);
    expect(pruned.selected).not.toContain("a");
  });

  it("剪除时若焦点/锚点已消失则置空，不留悬空引用", () => {
    const s = clickSelection(ids, emptySelection, "c");
    const pruned = pruneSelection(s, ["c"]);
    expect(pruned.cursor).toBeNull();
    expect(pruned.anchor).toBeNull();
    expect(pruned.selected).toEqual([]);
  });

  it("动作目标：有选区用选区，否则退回光标项", () => {
    expect(actionTargets({ cursor: "c", anchor: "c", selected: ["a", "b"] })).toEqual([
      "a",
      "b",
    ]);
    expect(actionTargets({ cursor: "c", anchor: null, selected: [] })).toEqual(["c"]);
    expect(actionTargets(emptySelection)).toEqual([]);
  });
});

describe("快捷键映射", () => {
  it("数字键分到 hotkey 对应的分类", () => {
    expect(resolveShortcut({ key: "1" }, categories)).toEqual({
      type: "assign",
      categoryId: "cat-1",
    });
    expect(resolveShortcut({ key: "2" }, categories)).toEqual({
      type: "assign",
      categoryId: "cat-2",
    });
  });

  it("没有对应分类的数字键不响应（不误伤）", () => {
    expect(resolveShortcut({ key: "7" }, categories)).toBeNull();
  });

  it("P 精选 / O 其他 / D 标删，大小写都认", () => {
    expect(resolveShortcut({ key: "p" }, categories)).toEqual({ type: "curate" });
    expect(resolveShortcut({ key: "P" }, categories)).toEqual({ type: "curate" });
    expect(resolveShortcut({ key: "o" }, categories)).toEqual({ type: "other" });
    expect(resolveShortcut({ key: "D" }, categories)).toEqual({ type: "markDelete" });
    expect(resolveShortcut({ key: "u" }, categories)).toEqual({ type: "unmarkDelete" });
  });

  it("空格切换、Enter 预览", () => {
    expect(resolveShortcut({ key: " " }, categories)).toEqual({ type: "toggle" });
    expect(resolveShortcut({ key: "Enter" }, categories)).toEqual({ type: "preview" });
  });

  it("方向键带 Shift 即连选", () => {
    expect(resolveShortcut({ key: "ArrowRight", shiftKey: true }, categories)).toEqual({
      type: "move",
      key: "ArrowRight",
      extend: true,
    });
    expect(resolveShortcut({ key: "ArrowRight" }, categories)).toEqual({
      type: "move",
      key: "ArrowRight",
      extend: false,
    });
  });

  it("Cmd/Ctrl+A 全选，其余修饰键组合放行给系统", () => {
    expect(resolveShortcut({ key: "a", metaKey: true }, categories)).toEqual({
      type: "selectAll",
    });
    expect(resolveShortcut({ key: "1", metaKey: true }, categories)).toBeNull();
    expect(resolveShortcut({ key: "p", ctrlKey: true }, categories)).toBeNull();
  });

  it("预览态下左右切换、Esc 关闭", () => {
    expect(
      resolveShortcut({ key: "ArrowLeft" }, categories, { previewOpen: true }),
    ).toEqual({ type: "move", key: "ArrowLeft", extend: false });
    expect(
      resolveShortcut({ key: "Escape" }, categories, { previewOpen: true }),
    ).toEqual({ type: "closePreview" });
  });

  it("无关按键不拦截", () => {
    expect(resolveShortcut({ key: "z" }, categories)).toBeNull();
    expect(resolveShortcut({ key: "F5" }, categories)).toBeNull();
  });
});

describe("待删清单状态机（两段式删除）", () => {
  it("标记进入 marked 态，重复标记不产生重复项", () => {
    const s1 = pendingDeleteReducer(initialPendingDelete, {
      type: "mark",
      assetIds: ["a", "b"],
    });
    expect(s1.phase).toBe("marked");
    expect(s1.marked).toEqual(["a", "b"]);

    const s2 = pendingDeleteReducer(s1, { type: "mark", assetIds: ["b", "c"] });
    expect(s2.marked).toEqual(["a", "b", "c"]);
  });

  it("取消标记，清空后回到 idle", () => {
    const marked = pendingDeleteReducer(initialPendingDelete, {
      type: "mark",
      assetIds: ["a", "b"],
    });
    const s = pendingDeleteReducer(marked, { type: "unmark", assetIds: ["a"] });
    expect(s.marked).toEqual(["b"]);
    expect(s.phase).toBe("marked");

    const empty = pendingDeleteReducer(s, { type: "unmark", assetIds: ["b"] });
    expect(empty.phase).toBe("idle");
    expect(empty.marked).toEqual([]);
  });

  it("空清单不给确认入口", () => {
    const s = pendingDeleteReducer(initialPendingDelete, { type: "requestConfirm" });
    expect(s.phase).toBe("idle");
  });

  it("必须经确认才能进入执行态：绕过确认无效", () => {
    const marked = pendingDeleteReducer(initialPendingDelete, {
      type: "mark",
      assetIds: ["a"],
    });
    // 直接 commitStarted（未确认）应当被拒绝
    const bypass = pendingDeleteReducer(marked, { type: "commitStarted" });
    expect(bypass.phase).toBe("marked");

    const confirming = pendingDeleteReducer(marked, { type: "requestConfirm" });
    expect(confirming.phase).toBe("confirming");
    const working = pendingDeleteReducer(confirming, { type: "commitStarted" });
    expect(working.phase).toBe("working");
  });

  it("确认可以取消，退回 marked 而不是丢掉清单", () => {
    const confirming = pendingDeleteReducer(
      pendingDeleteReducer(initialPendingDelete, { type: "mark", assetIds: ["a", "b"] }),
      { type: "requestConfirm" },
    );
    const back = pendingDeleteReducer(confirming, { type: "cancelConfirm" });
    expect(back.phase).toBe("marked");
    expect(back.marked).toEqual(["a", "b"]);
  });

  it("执行中不接受新的标记/清空，避免删到没确认过的东西", () => {
    const working: PendingDeleteState = {
      phase: "working",
      marked: ["a"],
      failed: [],
    };
    expect(pendingDeleteReducer(working, { type: "mark", assetIds: ["b"] })).toBe(
      working,
    );
    expect(pendingDeleteReducer(working, { type: "clear" })).toBe(working);
  });

  it("提交后成功的移出清单，失败的留下且带原因", () => {
    const working: PendingDeleteState = {
      phase: "working",
      marked: ["a", "b", "c"],
      failed: [],
    };
    const done = pendingDeleteReducer(working, {
      type: "commitFinished",
      succeeded: ["a", "c"],
      failed: [{ assetId: "b", message: "文件被占用" }],
    });
    expect(done.marked).toEqual(["b"]);
    expect(done.phase).toBe("marked");
    expect(done.failed).toEqual([{ assetId: "b", message: "文件被占用" }]);
  });

  it("全部成功则回到 idle", () => {
    const working: PendingDeleteState = { phase: "working", marked: ["a"], failed: [] };
    const done = pendingDeleteReducer(working, {
      type: "commitFinished",
      succeeded: ["a"],
      failed: [],
    });
    expect(done.phase).toBe("idle");
    expect(done.marked).toEqual([]);
  });
});

describe("连拍分组", () => {
  it("相邻同 groupId 归为一组", () => {
    const groups = groupBurst([
      { id: "1", groupId: "g1" },
      { id: "2", groupId: "g1" },
      { id: "3", groupId: "g2" },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].items.map((i) => i.id)).toEqual(["1", "2"]);
  });

  it("无 groupId 的各自独立，不会被并到一起", () => {
    const groups = groupBurst([{ id: "1" }, { id: "2" }]);
    expect(groups).toHaveLength(2);
  });
});

describe("连拍折叠（网格条目）", () => {
  const assets = [
    { id: "a" },
    { id: "b", groupId: "g1" },
    { id: "c", groupId: "g1" },
    { id: "d", groupId: "g1" },
    { id: "e" },
    { id: "f", groupId: "g2" },
  ];

  it("≥2 件的同组折成恰好一格", () => {
    const entries = buildGridEntries(assets);
    // a / [b,c,d] / e / f → 4 格
    expect(entries).toHaveLength(4);
    expect(entries[1].kind).toBe("group");
    expect(entries[1].id).toBe("group:g1");
  });

  it("单件组不折叠，仍是普通格", () => {
    const entries = buildGridEntries(assets);
    const last = entries[3];
    expect(last.kind).toBe("asset");
    expect(last.id).toBe("f");
  });

  it("组 id 展开成全部成员 assetId", () => {
    const entries = buildGridEntries(assets);
    expect(resolveEntryIds(entries, ["group:g1"])).toEqual(["b", "c", "d"]);
  });

  it("普通条目原样返回，未知 id 被忽略", () => {
    const entries = buildGridEntries(assets);
    expect(resolveEntryIds(entries, ["a", "e", "zz"])).toEqual(["a", "e"]);
  });

  it("选区模型完全不用改：组 id 就是普通字符串 id", () => {
    const entries = buildGridEntries(assets);
    const ids = entries.map((e) => e.id);
    const sel = moveCursor(ids, emptySelection, "ArrowRight", 4);
    expect(sel.cursor).toBe("a");
    const next = moveCursor(ids, sel, "ArrowRight", 4);
    expect(next.cursor).toBe("group:g1");
    // 对组条目的操作会展开成 3 个真实素材
    expect(resolveEntryIds(entries, actionTargets(next))).toEqual(["b", "c", "d"]);
  });
});

describe("filterBySuggestion", () => {
  const list = [
    { id: "1", judgement: { suggestedKeep: true } },
    { id: "2", judgement: { suggestedKeep: false } },
    { id: "3" },
  ];

  it("关闭时原样返回", () => {
    expect(filterBySuggestion(list, false)).toHaveLength(3);
  });

  it("开启时保留「建议保留」与尚无判定的", () => {
    const out = filterBySuggestion(list, true);
    expect(out.map((a) => a.id)).toEqual(["1", "3"]);
  });
});
