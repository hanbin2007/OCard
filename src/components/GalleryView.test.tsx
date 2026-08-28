/**
 * 画廊模式（Loupe 视图）的行为闸门。
 *
 * 重点不是"渲染出来了没有"，而是两条会真出事的口径：
 * ① 打标键作用的必须是**你看见的那张**（与 Lightbox 同一判例，评审 3.2）；
 * ② 任何缺图、失败、回退都必须在界面上说出来，不许静默留白。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SortingAsset, SortingCategory } from "../api/types";
import { GalleryView, type GalleryViewProps } from "./GalleryView";

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
