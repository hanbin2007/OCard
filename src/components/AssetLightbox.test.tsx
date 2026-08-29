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
    kind: "original",
    frameAtSec: null,
    durationSec: null,
    rawAdequacy: null,
    rawWarning: null,
  };
}

/**
 * RAW 里相机自己渲染进去的那张 JPEG。
 *
 * `adequacy` 是这条路上唯一要紧的旋钮：内嵌预览取到了 ≠ 够判虚实。
 * 后端的 `warning` 原话在这里照抄一份（真实形状），因为界面必须原样展示它。
 */
function rawOf(
  adequacy: NonNullable<FullPreview["rawAdequacy"]>,
  patch: Partial<FullPreview> = {},
): FullPreview {
  const warning: Record<string, string | null> = {
    fullSize: null,
    reduced:
      "这是相机内嵌的「半幅」预览（4128×2752，原始尺寸 8256×5504），不是全分辨率原图：" +
      "构图和明显跑焦看得出，细微的虚实判不准——要抠对焦请用 RAW 处理软件",
    thumbnailOnly:
      "这只是相机内嵌的「缩略级」预览（640×480，原始尺寸 8256×5504），" +
      "放大后是插值糊块，判不了虚实和对焦——请打开配套 JPEG 或用 RAW 处理软件看原片",
    unknown:
      "这是相机内嵌的预览（3840×2560），读不到 RAW 的原始感光尺寸，" +
      "无法确认它是不是全分辨率——判虚实前请留意这一点",
  };
  return {
    ...fullOf("preview://localhost/raaaaaaaaaaaaaaa.jpg"),
    kind: "rawEmbedded",
    rawAdequacy: adequacy,
    rawWarning: warning[adequacy],
    ...patch,
  };
}

/** 视频抽出来的一帧（可选:同时被缩放呈现） */
function frameOf(url: string, patch: Partial<FullPreview> = {}): FullPreview {
  return {
    ...fullOf(url),
    kind: "videoFrame",
    frameAtSec: 1,
    durationSec: 12,
    ...patch,
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
        // RAW 现在接了内嵌预览提取,所以它的失败不再是「功能没做」,
        // 而是「这个文件里就是没有预览」——后端那五类原样透传到这里
        name: "RAW 里没有内嵌预览",
        message:
          "这个 .nef 文件里没有可用的内嵌预览（已按格式规范检查过 3 处标签位置）。相机可能没写全尺寸预览，或把它放在了本模块不解析的 MakerNote 里",
        expect: "MakerNote",
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

  /*
   * 端到端：半幅内嵌预览换上来之后，**警示不许跟着消失**。
   *
   * 别的支路上「换上了 → 闭嘴」是对的；RAW 这一支不是。半幅预览换上来
   * 恰恰是最危险的时刻——图变清楚了，用户以为可以抠对焦了。
   */
  it("RAW 半幅预览换上来之后警示仍在,而且放大提示不把它说成原图", async () => {
    vi.spyOn(api, "loadFullPreview").mockResolvedValue(rawOf("reduced"));
    renderLightbox({ ...photo, id: "1. 待分类/DSC_00001.NEF", kind: "raw" });

    await waitFor(() => expect(img().getAttribute("data-source")).toBe("full"));
    const text = notice()?.textContent ?? "";
    expect(text, "换上之后警示消失,等于换个方式继续骗用户").toContain(
      "4128×2752",
    );
    expect(text).toContain("机内渲染");
    expect(notice()?.getAttribute("data-tone")).toBe("warn");
    expect(
      img().getAttribute("title"),
      "放大提示不许把内嵌预览说成「全尺寸原图」",
    ).toContain("相机内嵌预览");
  });

  it("连缩略图都没有时，占位说的是「正在解码」而不是笼统的没预览", async () => {
    const d = deferred<FullPreview>();
    vi.spyOn(api, "loadFullPreview").mockReturnValue(d.promise);
    renderLightbox(clip);

    expect(screen.getByTestId("lightbox-no-image")).toBeTruthy();
    expect(notice()?.textContent).toContain("正在解码全尺寸原图");

    // 视频现在走 sidecar 抽帧,失败是「这个文件打不开」这一类,
    // 不再是「功能没做」——用后端真会给出的那句话
    d.reject(
      new Error("这个视频打不开——文件已损坏或被截断（ffmpeg: moov atom not found）"),
    );
    await waitFor(() =>
      expect(notice()?.getAttribute("data-tone")).toBe("danger"),
    );
    const text = notice()?.textContent ?? "";
    expect(text).toContain("损坏");
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

  it("视频帧永远有话说——一帧静止画面代表不了一整条素材", () => {
    const notice = previewNotice(
      { phase: "ready", preview: frameOf("u") },
      false,
    );
    expect(notice?.tone).toBe("warn");
    // 第几秒、整段多长、以及「这不是整段影像」都要说出来
    expect(notice?.text).toContain("第 1 秒的一帧");
    expect(notice?.text).toContain("12 秒");
    expect(notice?.text).toContain("不是整段影像");
  });

  it("秒数说不准时就不编数字", () => {
    const notice = previewNotice(
      { phase: "ready", preview: frameOf("u", { frameAtSec: null, durationSec: null }) },
      false,
    );
    expect(notice?.text).toContain("开头的一帧");
    expect(notice?.text).toContain("说不准是第几秒");
    // 没有时长就别提整段多长,更不能显示 null
    expect(notice?.text).not.toContain("null");
    expect(notice?.text).not.toContain("整段共");
  });

  it("视频帧同时被缩放:两个降级都要说,漏一个就是静默", () => {
    const notice = previewNotice(
      {
        phase: "ready",
        preview: frameOf("u", {
          downscaled: true,
          width: 8192,
          height: 4608,
          sourceWidth: 11648,
          sourceHeight: 6552,
        }),
      },
      false,
    );
    expect(notice?.text).toContain("一帧");
    expect(notice?.text).toContain("不是原始像素");
  });

  /*
   * RAW 内嵌预览：**四档 adequacy 一档都不许闭嘴**。
   *
   * 这是本轮接线最容易复发的地方。RAW 在全屏里显示的是相机自己渲染进去的
   * 那张 JPEG——它可能全尺寸、可能半幅、可能只有缩略级、也可能连原图多大都
   * 读不到。四档里任何一档少说一句，用户就会拿一张不够用的图去判虚实，
   * 而他以为自己在看原图。
   */
  it("RAW 四档 adequacy 各有各的话,一档都不许闭嘴", () => {
    const tiers = ["fullSize", "reduced", "thumbnailOnly", "unknown"] as const;
    const said = new Set<string>();
    for (const tier of tiers) {
      const n = previewNotice(
        { phase: "ready", preview: rawOf(tier) },
        false,
      );
      expect(n, `${tier}: RAW 永远有话说——内嵌预览不是解出来的 RAW`).not.toBeNull();
      // 「这是机内渲染的 JPEG」四档都要说：白平衡/风格是机身烤死的
      expect(n?.text, `${tier}: 要说清这是机内渲染,不是解出来的 RAW`).toContain(
        "机内渲染",
      );
      said.add(n!.text);
    }
    expect(said.size, "四档说了同一句话,等于没分档").toBe(4);
  });

  it("半幅级必须常驻警示,并写清内嵌预览多大、原图多大", () => {
    const n = previewNotice({ phase: "ready", preview: rawOf("reduced") }, false);
    expect(n?.tone, "半幅是货真价实的降级").toBe("warn");
    expect(n?.text).toContain("4128×2752");
    expect(n?.text).toContain("8256×5504");
    // 「这个尺寸判不了 1:1 的虚实」这层意思必须说破
    expect(n?.text).toContain("判不准");
  });

  it("缩略级等同于「判不了」,给和失败一样的红", () => {
    const n = previewNotice(
      { phase: "ready", preview: rawOf("thumbnailOnly") },
      false,
    );
    expect(n?.tone).toBe("danger");
    expect(n?.text).toContain("判不了虚实");
  });

  it("读不到原图尺寸时不许假装是全尺寸", () => {
    const n = previewNotice({ phase: "ready", preview: rawOf("unknown") }, false);
    expect(
      n?.tone,
      "「不知道够不够」绝不能给 info——那就是把不知道偷偷当成够用",
    ).toBe("warn");
    expect(n?.text).toContain("无法确认");
  });

  it("全尺寸内嵌预览可以正常呈现,但仍要交代来路", () => {
    const n = previewNotice({ phase: "ready", preview: rawOf("fullSize") }, false);
    expect(n?.tone, "尺寸这一维没降级,不该用告警色吓人").toBe("info");
    expect(n?.text).toContain("判虚实与对焦够用");
    expect(n?.text).toContain("机内渲染");
  });

  it("档位读不出来时按 warn 兜底,绝不 fail-open 成 info", () => {
    const n = previewNotice(
      {
        phase: "ready",
        preview: { ...rawOf("fullSize"), rawAdequacy: null, rawWarning: null },
      },
      false,
    );
    expect(n?.tone).toBe("warn");
  });

  it("RAW 内嵌预览同时被缩放:两个降级都要说,而且缩的是内嵌预览不是原图", () => {
    const n = previewNotice(
      {
        phase: "ready",
        preview: rawOf("fullSize", {
          downscaled: true,
          width: 8192,
          height: 5461,
          sourceWidth: 8256,
          sourceHeight: 5504,
        }),
      },
      false,
    );
    expect(n?.text).toContain("机内渲染");
    expect(n?.text).toContain("不是原始像素");
    expect(
      n?.text,
      "缩的是内嵌预览:说成「原图」会让人以为看到的是原始感光尺寸缩下来的",
    ).toContain("内嵌预览 8256×5504");
    // 报「内嵌预览有多大」时不许拿缩放后的数字充数
    expect(
      n?.text,
      "内嵌预览的尺寸要报真实的 8256×5504,不是缩放后的 8192×5461",
    ).toContain("全尺寸 JPEG 预览（8256×5504）");
    expect(
      n?.tone,
      "缩放是货真价实的降级,不能因为「尺寸档够」就留在 info",
    ).toBe("warn");
  });

  it("HEIC 解出来的是照片本身,和 JPEG 同级,没有额外的话", () => {
    // kind=original 且未缩放 —— 唯一该闭嘴的情形
    expect(
      previewNotice(
        { phase: "ready", preview: { ...fullOf("u"), kind: "original" } },
        true,
      ),
    ).toBeNull();
  });

  it("小数秒不写成一长串", () => {
    const notice = previewNotice(
      { phase: "ready", preview: frameOf("u", { frameAtSec: 0, durationSec: 0.4 }) },
      false,
    );
    expect(notice?.text).toContain("第 0 秒的一帧");
    expect(notice?.text).toContain("0.4 秒");
  });
});
