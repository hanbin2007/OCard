/**
 * 全屏预览的「看到的到底是不是原图」契约。
 *
 * 被修的 bug：全屏里显示的是放大的 320px 缩略图，而选片时在全屏里判的
 * 就是虚实与对焦——放大的缩略图判不了，用户却以为自己在看原图。
 *
 * 这一套用例钉三件事：
 *  ① 打开先有缩略图顶着（不白屏），全尺寸解好再换上；
 *  ② **换上之前提示必须一直在，换上之后才消失**。提示要是提前消失，
 *     这个 bug 等于没修——所以它单独占一条用例，并且是变异验证的靶子；
 *  ③ 解不出来的三类(格式不支持 / 超尺寸上限 / 解码失败)各说各的，
 *     绝不静默停在缩略图上装作没事。
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { mockProjects } from "../api/mock";
import type { FullPreview, SortingAsset } from "../api/types";
import { StoreProvider } from "../state/store";
import { AssetLightbox, previewNotice } from "./AssetLightbox";

// vitest 配置里 globals 为 false,RTL 的自动 cleanup 不会注册——
// 不手动清,上一条用例的 DOM 会留在文档里,查询立刻变成「找到多个」
afterEach(cleanup);

const project = mockProjects[0];

const photo: SortingAsset = {
  id: "1. 待分类/DSC_00001.JPG",
  fileName: "DSC_00001.JPG",
  sizeBytes: 9 * 1024 * 1024,
  thumbnail: "thumb://localhost/p/0123456789abcdef.jpg",
  thumbReady: true,
  kind: "photo",
};

const nextPhoto: SortingAsset = {
  ...photo,
  id: "1. 待分类/DSC_00002.JPG",
  fileName: "DSC_00002.JPG",
  thumbnail: "thumb://localhost/p/fedcba9876543210.jpg",
};

/** 没有缩略图的那一类（视频/未索引）：全屏里连顶着的东西都没有 */
const clip: SortingAsset = {
  id: "1. 待分类/CLIP0001.MP4",
  fileName: "CLIP0001.MP4",
  sizeBytes: 240 * 1024 * 1024,
  thumbReady: false,
  kind: "video",
};

function fullOf(url: string, over = false): FullPreview {
  return {
    url,
    width: over ? 8192 : 6000,
    height: over ? 5464 : 4000,
    sourceWidth: over ? 11648 : 6000,
    sourceHeight: over ? 7768 : 4000,
    downscaled: over,
    fromCache: false,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // 未处理的 rejection 会污染整跑；这里挂一个空 catch 只为静音，
  // 真正的断言仍然看界面上说了什么
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function renderLightbox(asset: SortingAsset) {
  return render(
    <StoreProvider
      preloaded={{ projects: [project], selectedProjectId: project.id }}
    >
      <AssetLightbox
        asset={asset}
        index={0}
        total={3}
        onClose={() => {}}
        onPrev={() => {}}
        onNext={() => {}}
      />
    </StoreProvider>,
  );
}

const img = () => screen.getByTestId("lightbox-image") as HTMLImageElement;
const notice = () => screen.queryByTestId("lightbox-preview-notice");

describe("全屏预览必须给到全分辨率图", () => {
  it("先显示缩略图并说破，全尺寸到位后换上、提示消失", async () => {
    const d = deferred<FullPreview>();
    const spy = vi.spyOn(api, "loadFullPreview").mockReturnValue(d.promise);
    renderLightbox(photo);

    // ① 立刻有东西看,而且明确标着这是缩略图这一路
    expect(img().getAttribute("data-source")).toBe("thumb");
    expect(img().getAttribute("src")).toBe(photo.thumbnail);
    expect(notice()?.textContent).toContain("缩略图");
    expect(notice()?.textContent).toContain("判断虚实");
    expect(notice()?.getAttribute("data-tone")).toBe("warn");

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith(project.id, photo.id);

    // ② 全尺寸到位:换上原图,提示消失
    d.resolve(fullOf("preview://localhost/aaaaaaaaaaaaaaaa.jpg"));
    await waitFor(() => expect(img().getAttribute("data-source")).toBe("full"));
    expect(img().getAttribute("src")).toBe(
      "preview://localhost/aaaaaaaaaaaaaaaa.jpg",
    );
    expect(
      notice(),
      "全尺寸原图已到位且是原始像素,这是唯一该闭嘴的情形",
    ).toBeNull();
  });

  it("全尺寸没到位期间，提示一直在——提前消失等于这个 bug 没修", async () => {
    const d = deferred<FullPreview>();
    const spy = vi.spyOn(api, "loadFullPreview").mockReturnValue(d.promise);
    renderLightbox(photo);

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    // 后端迟迟不回:界面必须一直挂着「你看的是缩略图」
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 40));
      expect(
        notice()?.textContent,
        "全尺寸还没换上,提示不许消失",
      ).toContain("缩略图");
      expect(img().getAttribute("data-source")).toBe("thumb");
    }
  });

  it("超过长边上限时换上的是缩放图，而且当面说清不是原始像素", async () => {
    vi.spyOn(api, "loadFullPreview").mockResolvedValue(
      fullOf("preview://localhost/bbbbbbbbbbbbbbbb.jpg", true),
    );
    renderLightbox(photo);

    await waitFor(() => expect(img().getAttribute("data-source")).toBe("full"));
    const text = notice()?.textContent ?? "";
    expect(text, "超限降级必须可见").toContain("不是原始像素");
    expect(text).toContain("11648×7768");
    expect(text).toContain("8192×5464");
    expect(notice()?.getAttribute("data-tone")).toBe("warn");
  });

  it("三类失败各说各的话，并且明说「你现在看的还是缩略图」", async () => {
    const cases = [
      {
        name: "格式不支持(RAW)",
        message:
          "RAW（.NEF）尚未接入全尺寸解码（本机构建不含 libraw）。你看到的是相机内嵌的小预览",
        expect: "libraw",
      },
      {
        name: "超出尺寸上限",
        message:
          "原图 14000×10000（约 1.4 亿像素）超过全尺寸解码上限 1.2 亿像素——再解会把内存吃爆，已停在缩略图",
        expect: "1.2 亿像素",
      },
      {
        name: "解码失败",
        message: "全尺寸解码失败（文件可能损坏或被截断）: unexpected end of file",
        expect: "损坏",
      },
    ];
    const seen = new Set<string>();
    for (const c of cases) {
      vi.spyOn(api, "loadFullPreview").mockRejectedValue(new Error(c.message));
      const view = renderLightbox(photo);
      await waitFor(() =>
        expect(notice()?.getAttribute("data-tone")).toBe("danger"),
      );
      const text = notice()?.textContent ?? "";
      expect(text, `${c.name} 要点名具体原因,不能笼统一句「加载失败」`).toContain(
        c.expect,
      );
      expect(
        text,
        `${c.name}:失败后停在缩略图这件事本身也必须说破`,
      ).toContain("仍是 320px 缩略图");
      expect(
        img().getAttribute("data-source"),
        "解不出来就退回缩略图,但不许装作没事",
      ).toBe("thumb");
      seen.add(text);
      view.unmount();
      vi.restoreAllMocks();
    }
    expect(seen.size, "三类失败说了同一句话,等于没分类").toBe(3);
  });

  it("连缩略图都没有时，占位说的是「正在解码」而不是笼统的没预览", async () => {
    const d = deferred<FullPreview>();
    vi.spyOn(api, "loadFullPreview").mockReturnValue(d.promise);
    renderLightbox(clip);

    expect(screen.getByTestId("lightbox-no-image")).toBeTruthy();
    expect(notice()?.textContent).toContain("正在解码全尺寸原图");

    d.reject(new Error("视频（.MP4）的全屏预览尚未接入抽帧，暂时看不到画面"));
    await waitFor(() =>
      expect(notice()?.getAttribute("data-tone")).toBe("danger"),
    );
    const text = notice()?.textContent ?? "";
    expect(text).toContain("抽帧");
    // 没有缩略图可退,就不该硬安一句「你看到的是缩略图」
    expect(text).not.toContain("仍是 320px 缩略图");
  });

  it("切走再回来时，上一张慢半拍的结果被丢弃，不会盖住眼前这张", async () => {
    const first = deferred<FullPreview>();
    const second = deferred<FullPreview>();
    const spy = vi
      .spyOn(api, "loadFullPreview")
      .mockImplementation((_p: string, assetId: string) =>
        assetId === photo.id ? first.promise : second.promise,
      );
    const view = renderLightbox(photo);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(project.id, photo.id));

    // 还没回来就切到下一张
    view.rerender(
      <StoreProvider
        preloaded={{ projects: [project], selectedProjectId: project.id }}
      >
        <AssetLightbox
          asset={nextPhoto}
          index={1}
          total={3}
          onClose={() => {}}
          onPrev={() => {}}
          onNext={() => {}}
        />
      </StoreProvider>,
    );
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(project.id, nextPhoto.id),
    );

    // 上一张这时才回来:必须被丢弃
    first.resolve(fullOf("preview://localhost/1111111111111111.jpg"));
    await new Promise((r) => setTimeout(r, 60));
    expect(
      img().getAttribute("src"),
      "上一张的慢响应绝不许盖住眼前这张",
    ).toBe(nextPhoto.thumbnail);
    expect(img().getAttribute("data-source")).toBe("thumb");
    expect(notice()?.textContent).toContain("缩略图");

    // 眼前这张回来了才换上
    second.resolve(fullOf("preview://localhost/2222222222222222.jpg"));
    await waitFor(() =>
      expect(img().getAttribute("src")).toBe(
        "preview://localhost/2222222222222222.jpg",
      ),
    );
    expect(notice()).toBeNull();
  });

  it("点击放大只在全尺寸到位后才生效", async () => {
    const d = deferred<FullPreview>();
    vi.spyOn(api, "loadFullPreview").mockReturnValue(d.promise);
    const user = userEvent.setup();
    renderLightbox(photo);

    // 还挂着缩略图:点了也不许放大(放大一团糊会被读成「这张拍虚了」)
    await user.click(img());
    expect(img().className).not.toContain("lightbox__image--zoomed");
    expect(img().getAttribute("title")).toContain("放大只会放大缩略图");

    d.resolve(fullOf("preview://localhost/3333333333333333.jpg"));
    await waitFor(() => expect(img().getAttribute("data-source")).toBe("full"));
    await user.click(img());
    expect(img().className).toContain("lightbox__image--zoomed");
    expect(img().getAttribute("title")).toBe("点击还原");
  });

  it("全尺寸文件读不出来时退回缩略图，并把话说破", async () => {
    vi.spyOn(api, "loadFullPreview").mockResolvedValue(
      fullOf("preview://localhost/4444444444444444.jpg"),
    );
    renderLightbox(photo);
    await waitFor(() => expect(img().getAttribute("data-source")).toBe("full"));

    // preview:// 404(本机缓存被清 / 协议闸拒绝)
    img().dispatchEvent(new Event("error"));
    await waitFor(() => expect(img().getAttribute("data-source")).toBe("thumb"));
    expect(notice()?.getAttribute("data-tone")).toBe("danger");
    expect(notice()?.textContent).toContain("全尺寸原图读取失败");
  });
});

describe("提示条的取舍(纯函数)", () => {
  it("只有「全尺寸到位且是原始像素」这一种情形才没话说", () => {
    expect(previewNotice({ phase: "loading" }, true)?.tone).toBe("warn");
    expect(previewNotice({ phase: "loading" }, false)?.tone).toBe("info");
    expect(previewNotice({ phase: "failed", message: "坏了" }, true)?.tone).toBe(
      "danger",
    );
    expect(
      previewNotice({ phase: "ready", preview: fullOf("u", true) }, true)?.tone,
      "缩放呈现也是降级,必须可见",
    ).toBe("warn");
    expect(
      previewNotice({ phase: "ready", preview: fullOf("u", false) }, true),
    ).toBeNull();
  });
});
