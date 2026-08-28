/**
 * 全屏预览：左右切换、Esc 关闭（PRD §5.4 全屏对比）。
 *
 * 预览打开期间键盘由这里**全权接管**(评审 3.2):你操作的就是你看见的
 * 这张——P/数字键/D 作用于当前预览项,绝不落到网格里进预览前的旧选中。
 * 底部动作条同时是快捷键提示:预览此前是唯一没有 hint 的操作场所。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SortingAsset, SortingCategory } from "../api/types";
import { formatBytes, formatTimestamp } from "../lib/format";
import { animateOnce } from "../lib/motion";
import { trapTabFocus } from "../lib/focusTrap";
import { resolveShortcut, shouldYieldShortcut } from "../lib/sorting";
import { IconArrowLeft, IconChevronRight, IconClose } from "./Icon";
import { JudgementBadges } from "./JudgementBadges";
import { Badge, Kbd } from "./ui";

/** 换图时的横向位移量：够读出方向，又不至于把整张图甩出视野 */
const SWAP_SHIFT_PX = 18;
/** 与 CSS --dur-spring-fast 同一档（ζ=1，response 0.25s） */
const SWAP_DURATION_MS = 350;

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
  /** 点击放大(评审 3.11 v1):在全尺寸解码接上之前,先给一个粗判焦的放大 */
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    setFailed(false);
    setZoomed(false);
  }, [asset.id]);

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
          <JudgementBadges judgement={asset.judgement} />
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

        {asset.thumbReady && asset.thumbnail && !failed ? (
          // v1 放大缩略图；像素级查看等 media_indexer 的全尺寸解码接上再换
          <img
            ref={(node) => {
              mediaRef.current = node;
            }}
            /* 与网格里那一格共用过渡名：支持的内核上，两者是同一个实体在形变 */
            style={{ viewTransitionName: "ocard-preview" }}
            className={`lightbox__image${zoomed ? " lightbox__image--zoomed" : ""}`}
            src={asset.thumbnail}
            alt={asset.fileName}
            data-testid="lightbox-image"
            title={zoomed ? "点击还原" : "点击放大(缩略图预览,清晰度有限)"}
            onClick={() => setZoomed((z) => !z)}
            onError={() => setFailed(true)}
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
