/**
 * 全屏预览：左右切换、Esc 关闭（PRD §5.4 全屏对比）。
 *
 * 预览打开期间键盘由这里**全权接管**(评审 3.2):你操作的就是你看见的
 * 这张——P/数字键/D 作用于当前预览项,绝不落到网格里进预览前的旧选中。
 * 底部动作条同时是快捷键提示:预览此前是唯一没有 hint 的操作场所。
 *
 * ## 全尺寸原图（修 v1「全屏预览不是全分辨率」）
 *
 * v1 在全屏里放大的是 320px 缩略图。选片时在全屏里判的恰恰是虚实与对焦，
 * 而放大的缩略图**根本判不了**——用户却以为自己在看原图下判断。
 *
 * 现在的口径：
 * 1. 打开即先显示已有缩略图（立刻有东西看，不白屏），同时按需请求全尺寸；
 * 2. 换上之前**必须当面说清「你现在看的是缩略图」**，换上之后提示消失。
 *    这一条是本 bug 的核心：提示要是提前消失，等于这个 bug 没修；
 * 3. 解不出来（格式不支持 / 超尺寸上限 / 解码失败）各给各的具体说明，
 *    绝不静默停在缩略图上装作没事；
 * 4. 点击放大只在全尺寸到位后才有意义——没到位就不许放大，
 *    否则又回到「放大一团糊还以为是原图」。
 *
 * ## RAW：换上来了 ≠ 够用
 *
 * RAW 走的是**相机内嵌的那张 JPEG**。它可能是全尺寸，也可能只有半幅、
 * 甚至只有缩略级——由机身决定。所以这条路上「成功」有四档：
 * `fullSize / reduced / thumbnailOnly / unknown`，四档各有各的话
 * （见 `previewNotice`）。把半幅或「不知道多大」当成全尺寸端上去，
 * 只是把上面那个 bug 换了个方式继续犯。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { loadFullPreview } from "../api";
import type { FullPreview, SortingAsset, SortingCategory } from "../api/types";
import { formatBytes, formatTimestamp } from "../lib/format";
import { animateOnce } from "../lib/motion";
import { trapTabFocus } from "../lib/focusTrap";
import { resolveShortcut, shouldYieldShortcut } from "../lib/sorting";
import { useSelectedProject } from "../state/store";
import { IconArrowLeft, IconChevronRight, IconClose } from "./Icon";
import { JudgementBadges } from "./JudgementBadges";
import { Badge, Kbd } from "./ui";

/** 换图时的横向位移量：够读出方向，又不至于把整张图甩出视野 */
const SWAP_SHIFT_PX = 18;
/** 与 CSS --dur-spring-fast 同一档（ζ=1，response 0.25s） */
const SWAP_DURATION_MS = 350;

/**
 * 发起全尺寸解码前的等待。
 *
 * 一直按着方向键扫图时，中间掠过的每一张都发一次整幅解码，会把 CPU 和内存
 * 都吃光；停下来看的那张才值得解。停留不足这个时长的直接不发请求——
 * 这既是省算力，也是「慢响应盖住新的那张」这类竞态的第一道闸。
 */
export const FULL_PREVIEW_DELAY_MS = 150;

/**
 * 缩略图最长边（与 Rust 侧 `media::THUMB_MAX_EDGE` 同一个数，改一处要改两处）。
 *
 * 导出给画廊模式的大图区复用：那边也要在标题里说清「你现在看的是 320px 缩略图」。
 * 各写一份数字 = 后端改了 THUMB_MAX_EDGE 之后有一处会继续报旧数。
 */
export const THUMB_MAX_EDGE = 320;

/**
 * 全尺寸取图的状态机。三种终态各自对应界面上一句不同的话。
 *
 * 导出只为让画廊模式复用同一套 `previewNotice`：类型不共享的话，
 * 那边要么自造一份结构相同的（改一处漏一处），要么把 notice 也抄一份。
 */
export type FullState =
  | { phase: "loading" }
  | { phase: "ready"; preview: FullPreview }
  | { phase: "failed"; message: string };

/** 顶部提示条要说的话；null = 无话可说（全尺寸已到位且是原始像素）。 */
type Notice = { tone: "warn" | "info" | "danger"; text: string } | null;

/** 秒数写成人话：整数不带小数点，小数留一位 */
function formatSeconds(sec: number): string {
  return Number.isInteger(sec) ? String(sec) : sec.toFixed(1);
}

/**
 * 视频帧要说的那句话。
 *
 * 视频在全屏里给的是**一帧静止画面**，而不是整段素材。不说清这一点，
 * 用户会拿一个瞬间去替一整条镜头下判断——「这条抖不抖、有没有穿帮」
 * 在一张静图上根本判不了。所以视频帧**永远**有话说，
 * 这也是它与 HEIC 的分野：HEIC 解出来的就是照片本身，没有额外的话。
 */
function videoFrameText(preview: FullPreview): string {
  const at =
    preview.frameAtSec == null
      ? "开头的一帧（时长读不出，说不准是第几秒）"
      : `第 ${formatSeconds(preview.frameAtSec)} 秒的一帧`;
  const total =
    preview.durationSec == null
      ? ""
      : `，整段共 ${formatSeconds(preview.durationSec)} 秒`;
  return `这是视频${at}${total}——不是整段影像，动态与音画都判不了`;
}

/**
 * RAW 内嵌预览**永远**要说的那半句。
 *
 * 即便内嵌预览是全尺寸的，它也是**相机机内渲染的 JPEG**：白平衡、风格、
 * 降噪都按机身设置烤死了，宽容度也不是 RAW 的宽容度。判虚实/对焦够用，
 * 但「这张欠曝能不能拉回来」这类判断不能拿它当准。不说这一句，
 * 用户会以为自己在看解出来的 RAW。
 */
const RAW_RENDER_CLAUSE =
  "画面是相机机内渲染的 JPEG（白平衡与风格按机身设置烤死），不是解出来的 RAW";

/**
 * 四档 adequacy 各自的语气。
 *
 * - `fullSize` → info：尺寸这一维**没有**降级，只是要交代来路，
 *   用告警色会让人以为这张不能用；
 * - `reduced` → warn：能看构图、看不了细节，是货真价实的降级；
 * - `thumbnailOnly` → danger：等同于「判不了」，与解码失败同一处境，
 *   所以给和失败一样的红；
 * - `unknown` → warn：**不知道**够不够。绝不能因为「说不定是全尺寸」就给 info——
 *   那就是把「不知道」偷偷当成「够用」，正是这一路要修的那个 bug。
 */
const RAW_TONE = {
  fullSize: "info",
  reduced: "warn",
  thumbnailOnly: "danger",
  unknown: "warn",
} as const;

/** RAW 内嵌预览要说的那句话（后端原话 + 永远要补的来路交代）。 */
function rawEmbeddedText(preview: FullPreview): string {
  // 后端 warning() 只有 fullSize 一档是 null——那一档没有尺寸方面的警示，
  // 但**仍然**要说清这是内嵌预览，所以这里补一句而不是闭嘴。
  //
  // 尺寸取 sourceWidth/Height 而不是 width/height：后者是**呈现**尺寸，
  // 内嵌预览超过 8192 长边时它已经被缩过了。拿缩放后的数字去说
  // 「内嵌预览有这么大」，等于在一句用来交代实情的话里报了个假数
  const head =
    preview.rawWarning ??
    `这是相机内嵌的全尺寸 JPEG 预览（${preview.sourceWidth}×${preview.sourceHeight}），判虚实与对焦够用`;
  return `${head}；${RAW_RENDER_CLAUSE}`;
}

/**
 * 「现在该跟用户说什么」的唯一真相来源。
 * 抽成纯函数是为了让「提示什么时候出现、什么时候消失」能被单测直接钉住。
 */
export function previewNotice(full: FullState, hasThumb: boolean): Notice {
  if (full.phase === "failed") {
    return {
      tone: "danger",
      text: hasThumb
        ? `${full.message}；你现在看到的仍是 ${THUMB_MAX_EDGE}px 缩略图，不能据此判断虚实`
        : full.message,
    };
  }
  if (full.phase === "loading") {
    return hasThumb
      ? {
          tone: "warn",
          text: `当前显示的是 ${THUMB_MAX_EDGE}px 缩略图，清晰度不足以判断虚实与对焦——全尺寸原图解码中…`,
        }
      : { tone: "info", text: "正在解码全尺寸原图…" };
  }
  const { preview } = full;
  // 超限降级也要看得见:不说，用户就会拿一张缩放图去数睫毛。
  // 视频帧/内嵌预览同时被缩放时两句都得说——两个降级各自独立，
  // 漏掉哪个都是静默
  const scaled = preview.downscaled
    ? // RAW 那一支缩的是**内嵌预览**而不是原图，说成「原图」会让用户
      // 以为看到的是原始感光尺寸缩下来的。两条支路各叫各的名字
      `${preview.kind === "rawEmbedded" ? "内嵌预览" : "原图"} ` +
      `${preview.sourceWidth}×${preview.sourceHeight} 超过显示上限，` +
      `这里是缩放后的 ${preview.width}×${preview.height}——不是原始像素，细节以原片为准`
    : null;
  if (preview.kind === "videoFrame") {
    const frame = videoFrameText(preview);
    return { tone: "warn", text: scaled ? `${frame}；${scaled}` : frame };
  }
  if (preview.kind === "rawEmbedded") {
    const raw = rawEmbeddedText(preview);
    // 档位读不出来时按 warn 兜底：绝不 fail-open 成 info。
    // 「拿不准就当没事」是这条 bug 的另一种写法
    const base = RAW_TONE[preview.rawAdequacy ?? "unknown"] ?? "warn";
    // 缩放本身就是一条降级。全尺寸档遇上缩放要跟着升到 warn——
    // 「内嵌预览够大」不能替「你看到的不是原始像素」消音，
    // 其它支路的缩放也一律是 warn，这里没有理由更宽松
    const tone = scaled && base === "info" ? "warn" : base;
    return { tone, text: scaled ? `${raw}；${scaled}` : raw };
  }
  if (scaled) return { tone: "warn", text: scaled };
  // 全尺寸原图已到位且是原始像素:这是**唯一**该闭嘴的情形
  return null;
}

export function AssetLightbox({
  asset,
  index,
  total,
  scopeLabel,
  categories = [],
  marked = false,
  curated = false,
  onClose,
  onPrev,
  onNext,
  onAssign,
  onCurate,
  onToggleDelete,
  onUnmarkDelete,
  actionsBlockedReason,
}: {
  asset: SortingAsset;
  index: number;
  total: number;
  /**
   * 「index / total 是在什么范围里数的」。
   *
   * 从连拍组进来的大图只在组成员内翻页（Esc 也退回那个组），于是 2/5 这种
   * 数字与全库总数对不上。范围一旦不是「全部待分类」，就必须当面说清楚，
   * 否则用户只会以为素材少了。缺省不传 = 全局摊平列表，无需额外说明。
   */
  scopeLabel?: string;
  /** 分类清单:动作条按钮与数字键映射都从这来;缺省不渲染动作条 */
  categories?: SortingCategory[];
  /** 当前项已标记待删 */
  marked?: boolean;
  /** 当前项本次会话里精选过 */
  curated?: boolean;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  /** 把**当前预览项**移入分类(调用方负责自动前进) */
  onAssign?: (categoryId: string) => void;
  /** 把当前预览项复制进精选 */
  onCurate?: () => void;
  /** D：切换当前预览项的待删标记（开关） */
  onToggleDelete?: () => void;
  /**
   * U：**只取消**当前预览项的待删标记。
   * 与 D 共用一个回调曾经导致：对未标记的那张按 U，它反而被标进待删清单，
   * 大图还自动翻到下一张——用户看不到自己刚刚把要保留的那张标成了待删。
   */
  onUnmarkDelete?: () => void;
  /**
   * 非空 = 分类/精选这类动作**当前被锁住**的原因（例如交付打包进行中）。
   * 按钮据此禁用并把原因写在脸上：一排看起来能按、按下去却什么都不发生的
   * 按钮，就是「界面伪装成操作成功」的另一种形态。
   * 标删按钮不在此列——打包期间「撤回标删」仍然放行，方向由闸门自己判。
   */
  actionsBlockedReason?: string;
}) {
  // thumb:// 取图可能 404：转占位而不是留一个碎图
  const [failed, setFailed] = useState(false);
  /** 点击放大：**只在全尺寸到位后**才允许（放大一张缩略图正是本 bug 本身） */
  const [zoomed, setZoomed] = useState(false);
  const [full, setFull] = useState<FullState>({ phase: "loading" });
  useEffect(() => {
    setFailed(false);
    setZoomed(false);
  }, [asset.id]);

  /*
   * 全尺寸取图。projectId 从 store 取:调用方(SortingScreen)只传素材,
   * 而后端要按项目定位文件。
   */
  const projectId = useSelectedProject()?.id ?? null;
  useEffect(() => {
    // live 是这条竞态的全部答案:换到下一张时上一次 effect 先 cleanup,
    // 它那份 live 变 false,于是**慢半拍才回来的上一张结果被丢弃**,
    // 不会盖住眼前这张。刚修过一批同类竞态,别再造一个。
    let live = true;
    setFull({ phase: "loading" });
    if (!projectId) {
      // 没有当前项目 = 取不到原图。这也要说出来,不能停在缩略图装作没事
      setFull({
        phase: "failed",
        message: "当前没有选定项目，取不到全尺寸原图",
      });
      return;
    }
    const timer = setTimeout(() => {
      loadFullPreview(projectId, asset.id).then(
        (preview) => {
          if (live) setFull({ phase: "ready", preview });
        },
        (e: unknown) => {
          if (!live) return;
          const message =
            e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
          setFull({
            phase: "failed",
            message: message || "全尺寸原图加载失败（后端没有给出原因）",
          });
        },
      );
    }, FULL_PREVIEW_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [asset.id, projectId]);

  const hasThumb = Boolean(asset.thumbReady && asset.thumbnail && !failed);
  const showFull = full.phase === "ready";
  const notice = previewNotice(full, hasThumb);
  /** 有东西可看 = 全尺寸到位，或者还有缩略图顶着 */
  const hasImage = showFull || hasThumb;
  const imageSrc = showFull ? full.preview.url : asset.thumbnail;

  const rootRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLElement | null>(null);
  /** 上一次换图的方向：+1 下一张、−1 上一张 */
  const directionRef = useRef(1);
  /** 上一次真正播过动画的素材，用来区分"首次挂载"与"换了一张" */
  const lastAnimatedRef = useRef<string | null>(null);

  /*
   * 关闭不在这里包视图过渡：Esc 有可能先被网格的键盘流接走，
   * 两处各包一层会变成"过渡里再起过渡"（前一次被直接跳过）。
   * 统一由分类工作台那一侧负责，见 SortingScreen 的 closePreview。
   */
  const goPrev = useCallback(() => {
    directionRef.current = -1;
    onPrev();
  }, [onPrev]);
  const goNext = useCallback(() => {
    directionRef.current = 1;
    onNext();
  }, [onNext]);

  /**
   * 换图时让新图**从你要去的方向进来**（§8：中间帧要指向结果）。
   * 起始不透明度取 0.35 而不是 0：新图往往还没解码完，从全透明起会先闪一下白。
   * 只动 transform / opacity，图多大都不会引发重排。
   */
  useEffect(() => {
    const previous = lastAnimatedRef.current;
    lastAnimatedRef.current = asset.id;
    // 首次挂载由 CSS 关键帧 / 视图过渡负责；同一张重复触发也不重播
    if (previous === null || previous === asset.id) return;
    const el = mediaRef.current;
    if (!el) return;
    animateOnce(
      el,
      [
        {
          transform: `translate3d(${directionRef.current * SWAP_SHIFT_PX}px, 0, 0)`,
          opacity: 0.35,
        },
        { transform: "translate3d(0, 0, 0)", opacity: 1 },
      ],
      SWAP_DURATION_MS,
    );
  }, [asset.id]);

  /*
   * 开屏就把焦点收进来。
   *
   * 少了这一步，焦点还留在背后的网格（或组层）上：Tab 一按就在**看不见的
   * 那一层**里游走，读屏也仍然在念背景内容——`aria-modal` 只是声明，
   * 不会替我们做圈定。收进来之后 Tab 才有可圈定的起点；关闭时的焦点还原
   * 由 SortingScreen 那一侧负责（modalAbove 的还原 effect）。
   */
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  // 预览态的键盘处理独立于网格：这里是模态，别让按键穿透回去
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /*
       * Tab 圈在本层内。层里有「上一张 / 下一张 / 关闭 / 分类 / 精选 / 标删」
       * 一整排按钮，不圈定的话 Tab 会一路走到背后的网格里去，
       * 而此时 Esc 又被本层吃掉——用户被困住。
       */
      if (e.key === "Tab") {
        if (trapTabFocus(rootRef.current, e)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      /*
       * 焦点在本层某个按钮上时，Enter / 空格是**激活那个按钮**。
       * 抢过来的实测后果：Tab 到「上一张」按回车，我们把它当成「收起大图」
       * 并 preventDefault，按钮完全不执行。
       */
      if (shouldYieldShortcut(e.target, e.key)) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") goNext();
      else if (e.key === "ArrowLeft") goPrev();
      else {
        // 打标键(P/O/D/数字)作用于**眼前这张**(评审 3.2)
        const action = resolveShortcut(
          {
            key: e.key,
            shiftKey: e.shiftKey,
            metaKey: e.metaKey,
            ctrlKey: e.ctrlKey,
          },
          categories,
        );
        if (!action) return;
        if (action.type === "assign" && onAssign) onAssign(action.categoryId);
        else if (action.type === "other" && onAssign) {
          const other = categories.find((c) => c.kind === "other");
          if (other) onAssign(other.id);
        } else if (action.type === "curate" && onCurate) onCurate();
        else if (action.type === "markDelete" && onToggleDelete) {
          onToggleDelete();
        } else if (action.type === "unmarkDelete" && onUnmarkDelete) {
          // U 只撤回标删。此前它与 D 共用 onToggleDelete，于是对一张
          // 未标记的素材按 U 反而把它标进了待删清单，大图还自动前进
          onUnmarkDelete();
        } else if (action.type === "preview") {
          // 空格再按一次 = 收起大图(Quick Look 语义:同一个键开、同一个键关)。
          // onClose 由调用方决定退回哪一层——从连拍组进来的退回组层
          onClose();
        }
        /*
         * 落到这里的还有 move / toggle / selectAll 之类:本层不支持,
         * 但**照样吞掉**。不吞的话按键会继续冒泡到底下那层(组全屏层/网格),
         * 于是「你看着这张大图按了 X」,动的却是背后看不见的另一个光标。
         */
      }
      e.preventDefault();
      e.stopPropagation();
    };
    // capture 阶段接管:网格 wrap 可能仍持有焦点,不能让同一击键双处生效
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, [
    onClose,
    goPrev,
    goNext,
    categories,
    onAssign,
    onCurate,
    onToggleDelete,
    onUnmarkDelete,
  ]);

  const customCategories = categories.filter((c) => c.kind === "custom");
  const hasActions = Boolean(onAssign || onCurate || onToggleDelete);

  return (
    <div className="lightbox" data-testid="asset-lightbox" role="dialog" aria-modal="true"
      ref={rootRef}
      tabIndex={-1}
      aria-label={`预览 ${asset.fileName}`}>
      <div className="lightbox__bar">
        <span className="mono text-sm truncate" title={asset.id}>
          {asset.fileName}
        </span>
        <span className="text-xs dim" data-testid="lightbox-position">
          {index + 1} / {total}
        </span>
        {scopeLabel ? (
          <span
            className="text-2xs dim"
            data-testid="lightbox-scope"
            title="左右键只在这个范围内翻页；Esc 退回该范围所在的那一层"
          >
            （{scopeLabel}）
          </span>
        ) : null}
        <span className="text-xs dim mono">{formatBytes(asset.sizeBytes)}</span>
        {asset.shotAt ? (
          <span className="text-xs dim mono">
            {formatTimestamp(asset.shotAt)}
            {asset.shotAtFallback ? "（推断）" : ""}
          </span>
        ) : null}
        {/*
          全屏预览是有地方把话说全的地方：这里必须把「检出 0 张脸」和
          「这次分析根本没做人脸检测」分开说，不能都留白让人自己脑补。
        */}
        {asset.judgement ? (
          <span className="text-xs dim" data-testid="lightbox-faces">
            {asset.judgement.faces == null
              ? "人脸检测不可用"
              : `检出人脸 ${asset.judgement.faces}`}
          </span>
        ) : null}
        {/* 网格里有的状态,大图里必须也有(评审 D1) */}
        <span className="lightbox__badges" data-testid="lightbox-badges">
          {/* 「建议保留」是**组内**首选,只有翻页范围就是那一组时才有比较对象;
              从网格直接进来的大图翻的是全库,挂上去就成了没有参照的角标 */}
          <JudgementBadges
            judgement={asset.judgement}
            showSuggestedKeep={Boolean(scopeLabel)}
          />
          {curated ? <Badge tone="ok">已精选</Badge> : null}
          {marked ? <Badge tone="danger">已标删</Badge> : null}
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--icon push-right"
          data-testid="lightbox-close"
          aria-label="关闭预览"
          onClick={onClose}
        >
          <IconClose />
        </button>
      </div>

      {/*
        「你现在看的到底是什么」必须写在脸上。
        用户拿放大的缩略图当原图下判断,正是这条 bug 的成因;
        全尺寸到位且是原始像素时(且仅在那时)这条提示消失。
      */}
      {notice ? (
        <div
          className={`lightbox__notice lightbox__notice--${notice.tone}`}
          data-testid="lightbox-preview-notice"
          data-tone={notice.tone}
          role="status"
          aria-live="polite"
        >
          {notice.text}
        </div>
      ) : null}

      <div className="lightbox__stage">
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          data-testid="lightbox-prev"
          aria-label="上一张"
          disabled={index === 0}
          onClick={goPrev}
        >
          <IconArrowLeft />
        </button>

        {hasImage ? (
          <img
            ref={(node) => {
              mediaRef.current = node;
            }}
            /* 与网格里那一格共用过渡名：支持的内核上，两者是同一个实体在形变 */
            style={{ viewTransitionName: "ocard-preview" }}
            className={`lightbox__image${zoomed ? " lightbox__image--zoomed" : ""}`}
            src={imageSrc}
            alt={asset.fileName}
            data-testid="lightbox-image"
            /* 测试与实测都要能一眼分辨「现在挂的是哪一路图」 */
            data-source={showFull ? "full" : "thumb"}
            title={
              showFull
                ? zoomed
                  ? "点击还原"
                  : /* 别把 2.4 倍说成「1:1 原始像素」——那是同一类谎话的另一种
                       说法。说清放大倍数和原图尺寸,用户自己判断够不够看。
                       视频帧与 RAW 内嵌预览同理:它们都不是「原图」,
                       在这里也不许把它们说成原图 */
                    `点击放大 2.4 倍看细节（${
                      full.preview.kind === "videoFrame"
                        ? "这一帧"
                        : full.preview.kind === "rawEmbedded"
                          ? "相机内嵌预览"
                          : "全尺寸原图"
                    } ${full.preview.width}×${full.preview.height}）`
                : "全尺寸原图还没到位，放大只会放大缩略图——先等它换上"
            }
            onClick={() => {
              // 全尺寸没到位就不许放大:放大一团糊会被读成「这张拍虚了」
              if (showFull) setZoomed((z) => !z);
            }}
            onError={() => {
              if (showFull) {
                // preview:// 读不出来(本机缓存被清、协议闸拒绝):退回缩略图,
                // 并把话说破——不能让人对着一张缩略图以为是原图
                setZoomed(false);
                setFull({
                  phase: "failed",
                  message:
                    "全尺寸原图读取失败（本机预览缓存可能已被清理）；切走再切回来可重试",
                });
              } else {
                setFailed(true);
              }
            }}
          />
        ) : (
          <div
            ref={(node) => {
              mediaRef.current = node;
            }}
            style={{ viewTransitionName: "ocard-preview" }}
            className="lightbox__image lightbox__image--empty"
            data-testid="lightbox-no-image"
          >
            <span className="text-sm dim">
              {failed ? "预览暂不可用（缩略图未就绪或已失效）" : "该文件尚未生成预览"}
            </span>
          </div>
        )}

        <button
          type="button"
          className="btn btn--ghost btn--icon"
          data-testid="lightbox-next"
          aria-label="下一张"
          disabled={index >= total - 1}
          onClick={goNext}
        >
          <IconChevronRight />
        </button>
      </div>

      {hasActions ? (
        /* 动作条兼快捷键提示(评审 D2):大图下即可完成全部选片决策,
           不必退回网格找格子 */
        <div className="lightbox__actions" data-testid="lightbox-actions">
          {onAssign
            ? customCategories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="btn btn--sm"
                  data-testid="lightbox-assign"
                  data-category={c.id}
                  disabled={Boolean(actionsBlockedReason)}
                  title={actionsBlockedReason ?? `移入「${c.name}」（快捷键 ${c.hotkey}）`}
                  onClick={() => onAssign(c.id)}
                >
                  {c.hotkey ? <Kbd>{c.hotkey}</Kbd> : null}
                  {c.name}
                </button>
              ))
            : null}
          {onCurate ? (
            <button
              type="button"
              className="btn btn--sm"
              data-testid="lightbox-curate"
              disabled={Boolean(actionsBlockedReason)}
              title={
                actionsBlockedReason ?? "复制一份进「精选/待修」,原件留在待分类"
              }
              onClick={onCurate}
            >
              <Kbd>P</Kbd>精选
            </button>
          ) : null}
          {onAssign && categories.some((c) => c.kind === "other") ? (
            <button
              type="button"
              className="btn btn--sm"
              data-testid="lightbox-other"
              disabled={Boolean(actionsBlockedReason)}
              title={actionsBlockedReason ?? "移入「其他」（快捷键 O）"}
              onClick={() => {
                const other = categories.find((c) => c.kind === "other");
                if (other) onAssign(other.id);
              }}
            >
              <Kbd>O</Kbd>其他
            </button>
          ) : null}
          {onToggleDelete ? (
            <button
              type="button"
              className={`btn btn--sm${marked ? "" : " btn--danger"}`}
              data-testid="lightbox-toggle-delete"
              title={
                marked
                  ? "取消这张的待删标记（快捷键 D 或 U）"
                  : "把这张标进待删清单（快捷键 D；按错了用 U 撤回，U 永远只撤回）"
              }
              onClick={onToggleDelete}
            >
              <Kbd>D</Kbd>
              {marked ? "取消标删" : "标删"}
            </button>
          ) : null}
          {/* 按钮为什么是灰的,当面说清——只留一排点不动的按钮等于让人猜 */}
          {actionsBlockedReason ? (
            <span className="text-2xs" data-testid="lightbox-actions-blocked">
              {actionsBlockedReason}
            </span>
          ) : null}
          <span className="text-2xs dim push-right">
            操作后自动看下一张 · <Kbd>空格</Kbd>/<Kbd>Esc</Kbd> 退一层
          </span>
        </div>
      ) : null}
    </div>
  );
}
