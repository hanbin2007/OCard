/**
 * 画廊模式（Loupe 视图）的行为闸门。
 *
 * 重点不是"渲染出来了没有"，而是两条会真出事的口径：
 * ① 打标键作用的必须是**你看见的那张**（与 Lightbox 同一判例，评审 3.2）；
 * ② 任何缺图、失败、回退都必须在界面上说出来，不许静默留白。
 */

import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SortingAsset, SortingCategory } from "../api/types";
import {
  GalleryView,
  StripShot,
  stripSegments,
  type GalleryViewProps,
} from "./GalleryView";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeAsset(id: string, over: Partial<SortingAsset> = {}): SortingAsset {
  return {
    id,
    fileName: id.split("/").pop() as string,
    sizeBytes: 12 * 1024 * 1024,
    thumbReady: true,
    thumbnail: `thumb://localhost/proj/${id}`,
    kind: "photo",
    ...over,
  };
}

const ASSETS: SortingAsset[] = [
  makeAsset("待分类/A0001.CR3", {
    shotAt: "2026-08-24T10:15:00+08:00",
    judgement: {
      score: 82,
      suggestedKeep: true,
      blurry: false,
      overExposed: false,
      underExposed: false,
      faces: 2,
    },
  }),
  makeAsset("待分类/A0002.CR3"),
  makeAsset("待分类/A0003.CR3"),
];

const CATEGORIES: SortingCategory[] = [
  { id: "cat-inbox", name: "待分类", folderName: "1. 待分类", kind: "inbox", count: 3 },
  {
    id: "cat-boss",
    name: "领导",
    folderName: "2. 领导",
    kind: "custom",
    count: 0,
    hotkey: 1,
  },
  { id: "cat-curated", name: "精选", folderName: "精选", kind: "curated", count: 0 },
  { id: "cat-other", name: "其他", folderName: "其他", kind: "other", count: 0 },
];

function renderGallery(over: Partial<GalleryViewProps> = {}) {
  // 显式给出签名：不带类型参数的 vi.fn() 推不出调用签名，装不进 GalleryViewProps
  const handlers = {
    onCursorChange: vi.fn<(id: string) => void>(),
    onAssign: vi.fn<(categoryId: string) => void>(),
    onCurate: vi.fn<() => void>(),
    onToggleDelete: vi.fn<() => void>(),
    onOpenFullscreen: vi.fn<() => void>(),
    onThumbError: vi.fn<() => void>(),
    onThumbLoad: vi.fn<() => void>(),
  };
  const props: GalleryViewProps = {
    assets: ASSETS,
    cursorId: ASSETS[0].id,
    categories: CATEGORIES,
    markedSet: new Set<string>(),
    curatedIds: new Set<string>(),
    ...handlers,
    ...over,
  };
  const view = render(<GalleryView {...props} />);
  return { ...view, handlers, props };
}

/** 往画廊根节点上发一次按键（根节点就是快捷键的挂载点） */
function press(key: string, init: Partial<KeyboardEventInit> = {}) {
  fireEvent.keyDown(screen.getByTestId("gallery-view"), { key, ...init });
}

describe("画廊模式：聚焦项", () => {
  it("大图、位置、详情面板都指向当前聚焦项", () => {
    renderGallery({ cursorId: ASSETS[1].id });

    expect(screen.getByTestId("gallery-position").textContent).toContain("第 2 张");
    expect(screen.getByTestId("gallery-position").textContent).toContain("共 3 张");
    expect(screen.getByTestId("gallery-image")).toHaveProperty(
      "alt",
      "A0002.CR3",
    );
    expect(screen.getByTestId("gallery-path").textContent).toBe(ASSETS[1].id);
    expect(screen.getByTestId("gallery-size").textContent).toBe("12.0 MB");
  });

  it("挂载后焦点落在画廊上——不必先点一下才知道方向键管用", () => {
    renderGallery();
    expect(document.activeElement).toBe(screen.getByTestId("gallery-view"));
  });

  it("胶片条用 listbox/option 标注，当前项 aria-selected=true", () => {
    renderGallery({ cursorId: ASSETS[2].id });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual([
      "false",
      "false",
      "true",
    ]);
    expect(screen.getByTestId("gallery-strip").getAttribute("aria-activedescendant"))
      .toBe(options[2].id);
  });
});

describe("画廊模式：键盘", () => {
  it("← → 在胶片条上前后换图", () => {
    const { handlers } = renderGallery({ cursorId: ASSETS[1].id });

    press("ArrowRight");
    expect(handlers.onCursorChange).toHaveBeenCalledWith(ASSETS[2].id);

    handlers.onCursorChange.mockClear();
    press("ArrowLeft");
    expect(handlers.onCursorChange).toHaveBeenCalledWith(ASSETS[0].id);
  });

  it("首尾不越界（也不会误报一次换图）", () => {
    const { handlers } = renderGallery({ cursorId: ASSETS[0].id });
    press("ArrowLeft");
    expect(handlers.onCursorChange).not.toHaveBeenCalled();
  });

  it("Enter 打开全屏大图", () => {
    const { handlers } = renderGallery();
    press("Enter");
    expect(handlers.onOpenFullscreen).toHaveBeenCalledTimes(1);
  });

  it("数字键 / P / O / D 作用于**当前聚焦项**，不落到别处", () => {
    const { handlers } = renderGallery({ cursorId: ASSETS[2].id });

    press("1");
    expect(handlers.onAssign).toHaveBeenCalledWith("cat-boss");

    press("p");
    expect(handlers.onCurate).toHaveBeenCalledTimes(1);

    press("o");
    expect(handlers.onAssign).toHaveBeenLastCalledWith("cat-other");

    press("d");
    expect(handlers.onToggleDelete).toHaveBeenCalledTimes(1);

    // 打标全程没有动过聚焦项：操作的就是你看见的那张
    expect(handlers.onCursorChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("gallery-position").textContent).toContain("第 3 张");
  });

  it("U 只撤回标删，绝不落到 toggle 上（对未标记项按 U 不许反而标删）", () => {
    const onUnmarkDelete = vi.fn<() => void>();
    // markedSet 为空 = 当前这张**没有**被标删，正是出事的那个前提
    const { handlers } = renderGallery({ cursorId: ASSETS[1].id, onUnmarkDelete });

    press("u");

    expect(onUnmarkDelete).toHaveBeenCalledTimes(1);
    expect(
      handlers.onToggleDelete,
      "U 走 toggle = 未标记的项被 U 标进待删清单，与「U 取消标删」正好相反",
    ).not.toHaveBeenCalled();
    // 撤回不该顺手换图：用户要看的就是刚撤回的这一张
    expect(handlers.onCursorChange).not.toHaveBeenCalled();
  });

  it("U：没传 onUnmarkDelete 就不吞键，原样冒泡给上层", () => {
    const { handlers } = renderGallery({ onUnmarkDelete: undefined });

    const view = screen.getByTestId("gallery-view");
    const event = createEvent.keyDown(view, { key: "u" });
    fireEvent(view, event);

    // 吞掉就等于把上层的兜底也一并掐死，「按了没反应」原样复活
    expect(event.defaultPrevented).toBe(false);
    expect(handlers.onToggleDelete).not.toHaveBeenCalled();
  });

  it("D 仍然是来回切，不受 U 拆分影响", () => {
    const onUnmarkDelete = vi.fn<() => void>();
    const { handlers } = renderGallery({ onUnmarkDelete });

    press("d");

    expect(handlers.onToggleDelete).toHaveBeenCalledTimes(1);
    expect(onUnmarkDelete).not.toHaveBeenCalled();
  });

  it("Shift+D（提交待删清单）不归画廊管，原样交还给上层", () => {
    const { handlers } = renderGallery();
    const event = new KeyboardEvent("keydown", {
      key: "D",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    screen.getByTestId("gallery-view").dispatchEvent(event);
    expect(handlers.onToggleDelete).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("画廊模式：胶片条", () => {
  it("点击缩略图切换聚焦项", () => {
    const { handlers } = renderGallery({ cursorId: ASSETS[0].id });
    fireEvent.click(screen.getAllByTestId("gallery-shot")[2]);
    expect(handlers.onCursorChange).toHaveBeenCalledWith(ASSETS[2].id);
  });
});

describe("画廊模式：零静默", () => {
  it("大图取图失败 → 转占位并说明原因，同时回调 onThumbError", () => {
    const { handlers } = renderGallery();

    fireEvent.error(screen.getByTestId("gallery-image"));

    expect(handlers.onThumbError).toHaveBeenCalledTimes(1);
    const failed = screen.getByTestId("gallery-image-failed");
    expect(failed.textContent).toContain("预览不可用");
    expect(failed.textContent).toContain("缓存已失效或被清理");
    expect(screen.queryByTestId("gallery-image")).toBeNull();
  });

  it("胶片条缩略图失败 → 该格转「预览不可用」并回调；载入成功回调 onThumbLoad", () => {
    const { handlers } = renderGallery();
    const thumbs = screen.getAllByTestId("gallery-shot-thumb");

    fireEvent.load(thumbs[0]);
    expect(handlers.onThumbLoad).toHaveBeenCalled();

    fireEvent.error(thumbs[1]);
    expect(handlers.onThumbError).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId("gallery-shot")[1].textContent).toContain(
      "预览不可用",
    );
  });

  it("缩略图未就绪 → 「索引中」，与「预览不可用」分开说", () => {
    const assets = [makeAsset("待分类/B0001.CR3", { thumbReady: false })];
    renderGallery({ assets, cursorId: assets[0].id });

    expect(screen.getByTestId("gallery-no-image").textContent).toContain("索引中");
    expect(screen.getByTestId("gallery-shot-no-thumb").textContent).toBe("索引中");
  });

  it("人脸：「检测不可用」与「检出 0」是两句话，不合并", () => {
    const unavailable = makeAsset("待分类/C1.CR3", {
      judgement: {
        score: 60,
        suggestedKeep: true,
        blurry: false,
        overExposed: false,
        underExposed: false,
      },
    });
    const zero = makeAsset("待分类/C2.CR3", {
      judgement: {
        score: 60,
        suggestedKeep: true,
        blurry: false,
        overExposed: false,
        underExposed: false,
        faces: 0,
      },
    });

    const { rerender, props } = renderGallery({
      assets: [unavailable, zero],
      cursorId: unavailable.id,
    });
    expect(screen.getByTestId("gallery-faces").textContent).toContain(
      "人脸检测不可用",
    );

    rerender(
      <GalleryView {...props} assets={[unavailable, zero]} cursorId={zero.id} />,
    );
    expect(screen.getByTestId("gallery-faces").textContent).toBe("检出人脸 0");
  });

  it("没有拍摄时间 / 没有判定都写明原因，不留白", () => {
    renderGallery({ cursorId: ASSETS[1].id });
    expect(screen.getByTestId("gallery-shot-at").textContent).toContain("EXIF");
    expect(screen.getByTestId("gallery-judgement").textContent).toContain("尚未分析");
  });

  it("素材为空 → 明确空态，不是一片空白", () => {
    renderGallery({ assets: [], cursorId: null });
    const view = screen.getByTestId("gallery-view");
    expect(view.textContent).toContain("没有可浏览的素材");
    expect(screen.queryByTestId("gallery-strip")).toBeNull();
  });
});

describe("画廊模式：cursorId 落空", () => {
  it("回退到第一项，同时把回退这件事说出来并同步给上层", () => {
    const { handlers } = renderGallery({ cursorId: "待分类/已经被移走了.CR3" });

    expect(screen.getByTestId("gallery-position").textContent).toContain("第 1 张");
    const alert = screen.getByTestId("gallery-cursor-lost");
    expect(alert.textContent).toContain("已经被移走了.CR3");
    expect(alert.textContent).toContain("已改为显示第 1 张");
    // 不同步的话上层还握着旧 id，打标会打到另一张上
    expect(handlers.onCursorChange).toHaveBeenCalledWith(ASSETS[0].id);
  });

  it("上层同步完光标后提示仍在——否则等于没提示过", () => {
    const { rerender, props } = renderGallery({ cursorId: "待分类/没了.CR3" });
    expect(screen.getByTestId("gallery-cursor-lost")).toBeTruthy();

    rerender(<GalleryView {...props} cursorId={ASSETS[0].id} />);
    expect(screen.getByTestId("gallery-cursor-lost")).toBeTruthy();

    // 用户自己往前走了，才算这条提示读过了
    press("ArrowRight");
    rerender(<GalleryView {...props} cursorId={ASSETS[1].id} />);
    expect(screen.queryByTestId("gallery-cursor-lost")).toBeNull();
  });

  it("cursorId 为 null 是正常初始态，不报警，只静静回退到第一项", () => {
    const { handlers } = renderGallery({ cursorId: null });
    expect(screen.queryByTestId("gallery-cursor-lost")).toBeNull();
    expect(screen.getByTestId("gallery-position").textContent).toContain("第 1 张");
    expect(handlers.onCursorChange).toHaveBeenCalledWith(ASSETS[0].id);
  });
});

/* ------------------------------------------------------------------ *
 * D1：网格上写着、画廊里没有语义的键，不许按下去毫无动静
 * ------------------------------------------------------------------ */

describe("画廊模式：死键（评审 D1）", () => {
  it("Esc：上层接了 onExitToGrid 就回网格，并吃掉按键", () => {
    const onExitToGrid = vi.fn<() => void>();
    renderGallery({ onExitToGrid });

    const view = screen.getByTestId("gallery-view");
    const event = createEvent.keyDown(view, { key: "Escape" });
    fireEvent(view, event);

    expect(onExitToGrid).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    // 接线了就该写进提示条
    expect(screen.getByTestId("gallery-hint-exit").textContent).toContain("回网格");
  });

  it("Esc：上层没接线也不许静默——给可见回执，并把键原样交还上层", () => {
    renderGallery({ onExitToGrid: undefined });

    const view = screen.getByTestId("gallery-view");
    const event = createEvent.keyDown(view, { key: "Escape" });
    fireEvent(view, event);

    const notice = screen.getByTestId("gallery-notice");
    expect(notice.textContent).toContain("没有选区可清");
    expect(notice.getAttribute("role")).toBe("status");
    // 没处理就不吞：上层将来接了 Esc 仍收得到
    expect(event.defaultPrevented).toBe(false);
    // 没接线就不能在提示条里写「Esc 回网格」，否则又是一次空承诺
    expect(screen.queryByTestId("gallery-hint-exit")).toBeNull();
  });

  it("X：画廊没有多选语义，按下去要说清楚该去哪儿用", () => {
    renderGallery();
    press("x");
    const notice = screen.getByTestId("gallery-notice");
    expect(notice.textContent).toContain("X");
    expect(notice.textContent).toContain("回网格视图使用");
  });

  it("⌘A：同样给回执，并挡掉浏览器的「全选页面文字」", () => {
    renderGallery();
    const view = screen.getByTestId("gallery-view");
    const event = createEvent.keyDown(view, { key: "a", metaKey: true });
    fireEvent(view, event);

    expect(screen.getByTestId("gallery-notice").textContent).toContain("不适用");
    expect(event.defaultPrevented).toBe(true);
  });

  it("回执读过就消失：用户往前走一张就撤掉", () => {
    const { rerender, props } = renderGallery({ cursorId: ASSETS[0].id });
    press("x");
    expect(screen.getByTestId("gallery-notice")).toBeTruthy();

    press("ArrowRight");
    rerender(<GalleryView {...props} cursorId={ASSETS[1].id} />);
    expect(screen.queryByTestId("gallery-notice")).toBeNull();
  });

  it("底部提示条写画廊自己的键位，不照抄网格那套", () => {
    renderGallery();
    const hints = screen.getByTestId("gallery-hints").textContent ?? "";

    expect(hints).toContain("上一张/下一张");
    expect(hints).toContain("Home");
    expect(hints).toContain("End");
    expect(hints).toContain("全屏");
    expect(hints).toContain("分类");
    expect(hints).toContain("精选");
    expect(hints).toContain("标删");
    // 没接 onUnmarkDelete 就不许写 U——写了就是又一次空承诺
    expect(hints).not.toContain("U");
    // 网格独有、画廊里不存在的语义，一个字都不许出现在这条提示里
    expect(hints).not.toContain("连选");
    expect(hints).not.toContain("清选");
    // X / ⌘A 只以「不适用」的形式出现
    expect(screen.getByTestId("gallery-hint-multi").textContent).toContain(
      "多选请回网格",
    );
  });

  it("接了 onUnmarkDelete 才在提示条里写 U，且与 D 分开写", () => {
    renderGallery({ onUnmarkDelete: vi.fn<() => void>() });
    const marks = screen.getByTestId("gallery-hint-marks").textContent ?? "";
    expect(marks).toContain("D");
    expect(marks).toContain("标删/取消");
    expect(marks).toContain("U");
    expect(marks).toContain("取消标删");
  });

  it("提示条只写真接了线的动作：没有 onCurate/onToggleDelete 就不写 P/D", () => {
    renderGallery({
      onCurate: undefined,
      onToggleDelete: undefined,
      onOpenFullscreen: undefined,
    });
    const hints = screen.getByTestId("gallery-hints").textContent ?? "";
    expect(hints).not.toContain("精选");
    expect(hints).not.toContain("标删");
    expect(hints).not.toContain("全屏");
    expect(hints).toContain("分类");
  });
});

/* ------------------------------------------------------------------ *
 * B1：Enter / 空格落在本组件自己的按钮上时，归按钮
 *
 * 上一轮把 `shouldYieldShortcut` 铺到了网格 / 画廊 wrap / 组层 / 大图四处，
 * **唯独漏了 GalleryView 自己这一份**。父层的让路挡不住本组件挂在子树上的
 * bubble 处理器，于是四层里修了三层等于没修。
 * 这一组用例刻意 `.focus()` + `user.keyboard(...)`（派发到 activeElement），
 * 不用 `fireEvent.keyDown(根节点, …)` —— 后者绕过焦点链，正是这个 bug
 * 逃过上一轮所有用例的原因。
 * ------------------------------------------------------------------ */

describe("画廊模式：不劫持已聚焦按钮的 Enter / 空格（评审 B1）", () => {
  it("★ Tab 到分类按钮按回车：执行的是分类，不是弹出全屏大图", async () => {
    const user = userEvent.setup();
    const { handlers } = renderGallery();

    const assign = screen.getByTestId("gallery-assign") as HTMLButtonElement;
    assign.focus();
    expect(document.activeElement).toBe(assign);

    await user.keyboard("{Enter}");

    // 旧行为：Enter 被判成 preview → onOpenFullscreen + preventDefault +
    // stopPropagation，按钮**完全不执行**，反而弹出一张全屏大图
    expect(handlers.onAssign).toHaveBeenCalledWith("cat-boss");
    expect(handlers.onOpenFullscreen).not.toHaveBeenCalled();
  });

  it("★ 空格落在「标删」按钮上同样归按钮", async () => {
    const user = userEvent.setup();
    const { handlers } = renderGallery();

    const del = screen.getByTestId("gallery-toggle-delete") as HTMLButtonElement;
    del.focus();
    await user.keyboard(" ");

    expect(handlers.onToggleDelete).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenFullscreen).not.toHaveBeenCalled();
  });

  it("★ 回执上的「知道了」按回车真的关掉它，而不是开全屏", async () => {
    const user = userEvent.setup();
    const { handlers } = renderGallery();

    press("x"); // 先造一条回执出来
    const dismiss = screen.getByTestId("gallery-notice-dismiss") as HTMLButtonElement;
    dismiss.focus();
    await user.keyboard("{Enter}");

    expect(screen.queryByTestId("gallery-notice")).toBeNull();
    expect(handlers.onOpenFullscreen).not.toHaveBeenCalled();
  });

  it("只让 Enter / 空格：焦点在按钮上按 D 仍然是打标键，键盘流不整条停摆", async () => {
    const user = userEvent.setup();
    const { handlers } = renderGallery();

    (screen.getByTestId("gallery-assign") as HTMLButtonElement).focus();
    await user.keyboard("d");

    expect(handlers.onToggleDelete).toHaveBeenCalledTimes(1);
  });

  // 输入类目标（INPUT / TEXTAREA / **SELECT** / contentEditable）让路的是所有键，
  // 这条口径由 lib/sorting.test.ts 的 shouldYieldShortcut 用例锁死；
  // 本组件只需保证走的是同一个函数，不再自带一份漏了 SELECT 的判定。
});

/* ------------------------------------------------------------------ *
 * B2：把根节点交出去，上层才交接得了键盘焦点
 * ------------------------------------------------------------------ */

describe("画廊模式：根节点交给上层（评审 B2）", () => {
  it("★ rootNodeRef 拿到的就是能收键盘的那个节点，focus 之后方向键立刻可用", () => {
    const rootNodeRef: { current: HTMLDivElement | null } = { current: null };
    const { handlers } = renderGallery({ cursorId: ASSETS[0].id, rootNodeRef });

    expect(rootNodeRef.current).toBe(screen.getByTestId("gallery-view"));

    // 模拟上层在浮层收起后把焦点交回来
    (document.activeElement as HTMLElement | null)?.blur();
    rootNodeRef.current?.focus();
    expect(document.activeElement).toBe(screen.getByTestId("gallery-view"));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    expect(handlers.onCursorChange).toHaveBeenCalledWith(ASSETS[1].id);
  });

  it("卸载时把 ref 置空，不给上层留野指针", () => {
    const rootNodeRef: { current: HTMLDivElement | null } = { current: null };
    const { unmount } = renderGallery({ rootNodeRef });
    expect(rootNodeRef.current).not.toBeNull();
    unmount();
    expect(rootNodeRef.current).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * D2：分页边界不许说谎，也不许静默停住
 * ------------------------------------------------------------------ */

describe("画廊模式：分页边界（评审 D2）", () => {
  it("位置栏在 total 大于已加载时如实写「已加载 N（共 M）」", () => {
    renderGallery({ total: 1240 });
    const text = screen.getByTestId("gallery-position").textContent ?? "";
    expect(text).toContain("已加载 3 张");
    expect(text).toContain("共 1240 张");
    // 决不能再把已加载数说成总数
    expect(text).not.toMatch(/\/\s*共 3 张/);
  });

  it("不传 total 时照旧写「共 N 张」（上层没有分页概念时的合理降级）", () => {
    renderGallery();
    expect(screen.getByTestId("gallery-position").textContent).toContain("共 3 张");
    expect(screen.queryByTestId("gallery-strip-more")).toBeNull();
  });

  it("翻到已加载末尾：接了 onEndReached 就续拉，并说清还差多少张", () => {
    const onEndReached = vi.fn<() => void>();
    const { handlers } = renderGallery({
      cursorId: ASSETS[2].id,
      total: 1240,
      onEndReached,
    });

    press("ArrowRight");

    expect(onEndReached).toHaveBeenCalledTimes(1);
    const notice = screen.getByTestId("gallery-notice").textContent ?? "";
    expect(notice).toContain("1237 张未加载");
    expect(notice).toContain("已请求继续加载");
    // 到边不算换图
    expect(handlers.onCursorChange).not.toHaveBeenCalled();
  });

  it("翻到已加载末尾：没接 onEndReached 也不许静默停住", () => {
    renderGallery({ cursorId: ASSETS[2].id, total: 1240 });

    press("ArrowRight");

    const notice = screen.getByTestId("gallery-notice").textContent ?? "";
    expect(notice).toContain("已到已加载素材的末尾");
    expect(notice).toContain("1237 张未加载");
    expect(notice).toContain("回网格视图加载更多");
  });

  it("真到全库末尾也给回执，而不是一动不动", () => {
    renderGallery({ cursorId: ASSETS[2].id });
    press("ArrowRight");
    expect(screen.getByTestId("gallery-notice").textContent).toContain(
      "已经是最后一张",
    );
  });

  it("已经在第一张时按左键同样给回执", () => {
    renderGallery({ cursorId: ASSETS[0].id });
    press("ArrowLeft");
    expect(screen.getByTestId("gallery-notice").textContent).toContain("已经是第一张");
  });

  it("End 键落在已加载末尾时同样触发续拉，不是哑的", () => {
    const onEndReached = vi.fn<() => void>();
    renderGallery({ cursorId: ASSETS[2].id, total: 1240, onEndReached });
    press("End");
    expect(onEndReached).toHaveBeenCalledTimes(1);
  });

  it("加载中要看得见：位置栏与胶片条尾部都给加载态", () => {
    renderGallery({ total: 1240, loading: true });
    expect(screen.getByTestId("gallery-position").textContent).toContain(
      "正在加载后续素材",
    );
    expect(screen.getByTestId("gallery-strip-more").textContent).toBe("加载中…");
  });

  it("胶片条尾部常驻「还有 N 张未加载」，胶片条的 aria-label 也如实说", () => {
    renderGallery({ total: 1240 });
    expect(screen.getByTestId("gallery-strip-more").textContent).toBe(
      "还有 1237 张未加载",
    );
    expect(screen.getByTestId("gallery-strip").getAttribute("aria-label")).toBe(
      "胶片条，已加载 3 张，共 1240 张",
    );
  });

  it("total 小于已加载数（上层算错）时按已加载数兜底，不编一个更小的谎", () => {
    renderGallery({ total: 1 });
    expect(screen.getByTestId("gallery-position").textContent).toContain("共 3 张");
    expect(screen.queryByTestId("gallery-strip-more")).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * D1：筛选态下总数是**不可知**的，不许拿全库 total 冒充
 * ------------------------------------------------------------------ */

describe("画廊模式：筛选态的总数口径（评审 D1）", () => {
  it("★ 位置栏只说命中数与未加载数，绝不写「共 M 张」", () => {
    renderGallery({ unloadedCount: 1040 });
    const text = screen.getByTestId("gallery-position").textContent ?? "";

    expect(text).toContain("第 1 张");
    expect(text).toContain("当前筛选已命中 3 张");
    expect(text).toContain("1040 张未加载");
    expect(text).toContain("能命中多少未知");
    // 「共 N 张」在筛选态下一律是谎话：命中总数根本没人知道
    expect(text).not.toContain("共 ");
  });

  it("★ 翻到末尾不许说「已经是最后一张」——后面还有没检查过的素材", () => {
    const onEndReached = vi.fn<() => void>();
    renderGallery({ cursorId: ASSETS[2].id, unloadedCount: 1040, onEndReached });

    press("ArrowRight");

    expect(onEndReached).toHaveBeenCalledTimes(1);
    const notice = screen.getByTestId("gallery-notice").textContent ?? "";
    expect(notice).not.toContain("已经是最后一张");
    expect(notice).toContain("库里还有 1040 张未加载");
    expect(notice).toContain("能命中多少未知");
    expect(notice).toContain("已请求继续加载");
  });

  it("筛选态但已经全部加载完（unloadedCount=0）：命中数就是准数，照常说「共 N 张」", () => {
    renderGallery({ unloadedCount: 0 });
    expect(screen.getByTestId("gallery-position").textContent).toContain("共 3 张");
    expect(screen.queryByTestId("gallery-strip-more")).toBeNull();
  });

  it("胶片条的 aria-label 也改口，不把库存说成筛选结果", () => {
    renderGallery({ unloadedCount: 1040 });
    expect(screen.getByTestId("gallery-strip").getAttribute("aria-label")).toBe(
      "胶片条，当前筛选已命中 3 张，库里还有 1040 张未加载",
    );
  });
});

/* ------------------------------------------------------------------ *
 * D2：虚拟化 listbox 的集合位置语义
 * ------------------------------------------------------------------ */

describe("画廊模式：虚拟化 option 的集合位置（评审 D2）", () => {
  const MANY_D2 = Array.from({ length: 1000 }, (_, i) =>
    makeAsset(`待分类/N${String(i).padStart(4, "0")}.CR3`),
  );

  it("★ 每一格自报 aria-posinset：读屏不许按当前挂载的二十几个节点数序号", () => {
    renderGallery({ assets: MANY_D2, cursorId: MANY_D2[900].id });

    const options = screen.getAllByRole("option");
    // 窗口化之后 DOM 里只有二十几格,序号却必须是它在**整个集合**里的位置
    expect(options.length).toBeLessThanOrEqual(40);
    for (const option of options) {
      const at = Number(option.getAttribute("data-index"));
      expect(option.getAttribute("aria-posinset")).toBe(String(at + 1));
    }
    const active = document.getElementById(
      screen.getByTestId("gallery-strip").getAttribute("aria-activedescendant") as string,
    );
    expect(active?.getAttribute("aria-posinset")).toBe("901");
  });

  it("★ aria-setsize 报的是集合总数，而不是当前挂载的格数", () => {
    renderGallery({ assets: MANY_D2, cursorId: MANY_D2[0].id });
    for (const option of screen.getAllByRole("option")) {
      expect(option.getAttribute("aria-setsize")).toBe("1000");
    }
  });

  it("分页未拉完时 setsize 用**同口径的库存总数**，不是已加载数", () => {
    renderGallery({ total: 1240 });
    for (const option of screen.getAllByRole("option")) {
      expect(option.getAttribute("aria-setsize")).toBe("1240");
    }
  });

  it("★ 总数不可知（筛选 + 还有未加载）时报 -1，这是 WAI-ARIA 的未知总量口径", () => {
    renderGallery({ unloadedCount: 1040 });
    for (const option of screen.getAllByRole("option")) {
      expect(option.getAttribute("aria-setsize")).toBe("-1");
    }
  });
});

/* ------------------------------------------------------------------ *
 * D3：胶片条窗口化与 memo
 * ------------------------------------------------------------------ */

describe("画廊模式：胶片条窗口化（评审 D3）", () => {
  const MANY = Array.from({ length: 1000 }, (_, i) =>
    makeAsset(`待分类/M${String(i).padStart(4, "0")}.CR3`),
  );

  it("上千张时 DOM 节点数被限制住，不是全量挂载", () => {
    renderGallery({ assets: MANY, cursorId: MANY[0].id });

    const shots = screen.getAllByTestId("gallery-shot");
    expect(shots.length).toBeLessThanOrEqual(40);
    expect(screen.getByTestId("gallery-strip").getAttribute("data-rendered")).toBe(
      String(shots.length),
    );
  });

  it("aria-activedescendant 指向的那一项**始终**在 DOM 里（哪怕它离滚动位置很远）", () => {
    renderGallery({ assets: MANY, cursorId: MANY[900].id });

    const strip = screen.getByTestId("gallery-strip");
    const activeId = strip.getAttribute("aria-activedescendant") as string;
    const activeNode = document.getElementById(activeId);
    expect(activeNode, "读屏指向的节点不存在 = 无声的可达性事故").not.toBeNull();
    expect(activeNode?.getAttribute("aria-selected")).toBe("true");
    expect(activeNode?.getAttribute("data-index")).toBe("900");

    // 远离滚动位置时窗口分成两段，中间的几百格不许被顺手渲染出来
    expect(screen.getAllByTestId("gallery-shot").length).toBeLessThanOrEqual(40);
  });

  it("占位块替没渲染的每一格占住位置：一格不多、一格不少", () => {
    renderGallery({ assets: MANY, cursorId: MANY[900].id });

    const rendered = screen.getAllByTestId("gallery-shot").length;
    const spacers = screen.getAllByTestId("gallery-strip-spacer");
    const placeheld = spacers.reduce(
      (sum, el) => sum + Number(el.getAttribute("data-count")),
      0,
    );
    expect(rendered + placeheld).toBe(MANY.length);

    // 宽度公式：k 格 = k × (104 + 8) − 8（占位块自己也吃掉一个 gap），
    // 这样滚动条长度与全量渲染严格一致
    for (const el of spacers) {
      const count = Number(el.getAttribute("data-count"));
      expect((el as HTMLElement).style.flex).toBe(`0 0 ${count * 112 - 8}px`);
    }
  });

  it("窗口计算是纯函数，两段互不相交且按序（合并规则单独锁死）", () => {
    // 聚焦项就在滚动窗口里 → 一段
    expect(stripSegments(1000, 3, 0, 0)).toEqual([{ start: 0, end: 20 }]);
    // 聚焦项远在天边 → 两段，中间那几百格不渲染
    expect(stripSegments(1000, 900, 0, 0)).toEqual([
      { start: 0, end: 20 },
      { start: 897, end: 904 },
    ]);
    // 两段挨上了就并成一段，不留缝
    expect(stripSegments(1000, 22, 0, 0)).toEqual([{ start: 0, end: 26 }]);
    // 空列表不产生任何段
    expect(stripSegments(0, -1, 0, 0)).toEqual([]);
    // 有视口宽度时按视口算，不再用兜底格数
    const [seg] = stripSegments(1000, 0, 0, 1120);
    expect(seg.end).toBe(18);
  });

  it("素材少于一屏时不产生占位块，行为与从前一致", () => {
    renderGallery();
    expect(screen.getAllByTestId("gallery-shot")).toHaveLength(3);
    expect(screen.queryAllByTestId("gallery-strip-spacer")).toHaveLength(0);
  });

  it("胶片条一格套了 memo：props 不变就不重渲染（重渲染会重挂 ref）", () => {
    const registerShot = vi.fn<(id: string, node: HTMLElement | null) => void>();
    const props = {
      asset: ASSETS[0],
      index: 0,
      selected: false,
      marked: false,
      curated: false,
      setSize: 3,
      registerShot,
      onPick: vi.fn<(id: string, index: number) => void>(),
      onThumbError: vi.fn<() => void>(),
      onThumbLoad: vi.fn<() => void>(),
    };

    const { rerender } = render(<StripShot {...props} />);
    expect(registerShot).toHaveBeenCalledTimes(1);

    rerender(<StripShot {...props} />);
    // 没套 memo 的话：子组件重渲染 → 行内 ref 换新 → 先 null 再挂 → 共 3 次
    expect(registerShot).toHaveBeenCalledTimes(1);

    rerender(<StripShot {...props} selected />);
    expect(registerShot.mock.calls.length).toBeGreaterThan(1);
  });

  it("回调引用稳定，但打到的永远是上层**最新**那份实现（不许拿旧闭包）", () => {
    const { rerender, props } = renderGallery({ cursorId: ASSETS[0].id });
    const fresh = vi.fn<(id: string) => void>();
    // 模拟上层带着全新的行内回调重渲染（索引进度事件每秒约 5 次就是这样）
    rerender(<GalleryView {...props} onCursorChange={fresh} />);

    fireEvent.click(screen.getAllByTestId("gallery-shot")[2]);
    expect(fresh).toHaveBeenCalledWith(ASSETS[2].id);
    expect(props.onCursorChange).not.toHaveBeenCalled();
  });
});
