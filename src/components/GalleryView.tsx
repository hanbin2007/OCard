/**
 * 画廊模式（Loupe 视图）：左大图 + 右详情 + 底部胶片条。
 *
 * 为什么单独做一个视图而不是把网格放大：选片到收尾阶段，判断依据不再是
 * 「这一屏里哪几张好」，而是「这一张的细节撑不撑得住」——需要的是一张够大的图
 * 加上一份完整元信息，同时还要保留上下文（前后各是什么）。三块因此缺一不可。
 *
 * 键盘口径与 AssetLightbox 完全一致（评审 3.2）：**你操作的就是你看见的那张**。
 * 打标键作用于当前聚焦项，绝不落到别处。
 *
 * 与 Lightbox 的区别是这里**不是模态**：键盘监听挂在组件根节点上（与
 * SortingScreen 的 `.sorting__grid-wrap` 同一手法），只在焦点位于画廊内时生效，
 * 不去 document 上抢键；处理掉的按键才 stopPropagation，没处理的（如 Shift+D
 * 提交待删清单）原样交还给上层。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { SortingAsset, SortingCategory } from "../api/types";
import { formatBytes, formatTimestamp } from "../lib/format";
import { animateOnce } from "../lib/motion";
import { resolveShortcut } from "../lib/sorting";
import { JudgementBadges } from "./JudgementBadges";
import { Badge, EmptyState, Kbd } from "./ui";

/**
 * 与 SortingScreen 里的同名映射同文案。没有共享是因为那份没有导出，
 * 而本任务不允许改动 SortingScreen；四条中文常量的重复优于跨文件强耦合。
 */
const KIND_LABEL: Record<SortingAsset["kind"], string> = {
  photo: "照片",
  raw: "RAW",
  video: "视频",
  other: "其他类型",
};

/** 胶片条选项的 DOM id。素材 id 是相对路径（可能含空格），不能直接当 id 用 */
const shotDomId = (index: number) => `gallery-shot-${index}`;

/** 换图时的横向位移量：与 Lightbox 同一档，够读出方向又不甩出视野 */
const SWAP_SHIFT_PX = 18;
/** 与 CSS --dur-spring-fast 同一档（ζ=1，response 0.25s） */
const SWAP_DURATION_MS = 350;

export interface GalleryViewProps {
  /** 显示顺序的素材（已摊平，连拍组也逐张列出） */
  assets: SortingAsset[];
  /** 当前聚焦项 id；为 null 或不在 assets 里时回退到第一项 */
  cursorId: string | null;
  onCursorChange: (id: string) => void;
  categories: SortingCategory[];
  markedSet: Set<string>;
  curatedIds: Set<string>;
  /** 把**当前聚焦项**移入分类 */
  onAssign?: (categoryId: string) => void;
  onCurate?: () => void;
  onToggleDelete?: () => void;
  /** 打开全屏大图 */
  onOpenFullscreen?: () => void;
  onThumbError: () => void;
  onThumbLoad: () => void;
}

export function GalleryView({
  assets,
  cursorId,
  onCursorChange,
  categories,
  markedSet,
  curatedIds,
  onAssign,
  onCurate,
  onToggleDelete,
  onOpenFullscreen,
  onThumbError,
  onThumbLoad,
}: GalleryViewProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);
  /** 胶片条里每一格的节点，供「切换时滚入视野」用 */
  const shotRefs = useRef(new Map<string, HTMLElement>());

  /**
   * 聚焦项解析。cursorId 落空时回退到第一项——但**回退这件事本身不能是静默的**，
   * 下面 lostId 会把它说出来。
   */
  const rawIndex = useMemo(
    () => (cursorId === null ? -1 : assets.findIndex((a) => a.id === cursorId)),
    [assets, cursorId],
  );
  const index = assets.length === 0 ? -1 : rawIndex >= 0 ? rawIndex : 0;
  const active = index >= 0 ? assets[index] : null;

  /**
   * 「你要看的那张已经不在列表里了」。
   *
   * 典型成因：刚把它分类/标删移走，或筛选条件变了。这时静默把画面换成第一张
   * 是最危险的——用户以为还在操作原来那张，实际打标会落到另一张上。
   * 用 state 记住（而不是直接由 props 推导），是因为下面会立刻把光标同步给上层，
   * 同步完 cursorId 就合法了，纯推导的提示会一闪而过等于没提示。
   */
  const [lostId, setLostId] = useState<string | null>(null);
  useEffect(() => {
    if (assets.length === 0) return;
    if (cursorId !== null && rawIndex < 0) setLostId(cursorId);
  }, [assets.length, cursorId, rawIndex]);

  /**
   * 把回退后的光标同步回上层。
   *
   * 不同步的话，上层仍持有旧的 cursorId，而 onAssign/onCurate/onToggleDelete
   * 都是「作用于当前聚焦项」由上层自己解析目标——两边不一致就会出现
   * 「界面显示 A、操作打在 B 上」的静默错位。
   * 上层若不理会本次调用，deps 不变，不会形成循环。
   */
  useEffect(() => {
    if (!active) return;
    if (cursorId === active.id) return;
    onCursorChange(active.id);
  }, [active, cursorId, onCursorChange]);

  /** 用户主动切换：顺带把「原先那张已消失」的提示消掉（他已经看到并往前走了） */
  const selectAsset = useCallback(
    (id: string) => {
      setLostId(null);
      onCursorChange(id);
    },
    [onCursorChange],
  );

  const step = useCallback(
    (delta: number) => {
      if (assets.length === 0 || index < 0) return;
      const target = Math.min(assets.length - 1, Math.max(0, index + delta));
      if (target === index) return;
      selectAsset(assets[target].id);
    },
    [assets, index, selectAsset],
  );

  const jumpTo = useCallback(
    (target: number) => {
      if (assets.length === 0) return;
      const clamped = Math.min(assets.length - 1, Math.max(0, target));
      if (clamped === index) return;
      selectAsset(assets[clamped].id);
    },
    [assets, index, selectAsset],
  );

  /* ---------------- 大图换图的方向动画 ---------------- */

  const directionRef = useRef(1);
  const lastAnimatedRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = lastAnimatedRef.current;
    lastAnimatedRef.current = active?.id ?? null;
    if (!active || previous === null || previous === active.id) return;
    const el = stageRef.current;
    if (!el) return;
    // 新图从「你要去的方向」进来；起始不透明度取 0.35 而不是 0，
    // 避免新图尚未解码完时先闪一下底色。animateOnce 内部已按
    // prefers-reduced-motion 直接返回。
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
  }, [active]);

  /* ---------------- 胶片条自动滚入视野 ---------------- */

  useEffect(() => {
    if (!active) return;
    const el = shotRefs.current.get(active.id);
    // jsdom / 老内核没有 scrollIntoView：滚动不是关键路径，缺了也不该抛
    if (!el || typeof el.scrollIntoView !== "function") return;
    // 不传 behavior：平滑与否交给 CSS 的 scroll-behavior，
    // 于是 base.css 里 prefers-reduced-motion 的全局覆盖自动生效
    el.scrollIntoView({ block: "nearest", inline: "center" });
  }, [active]);

  /** 进入画廊后键盘立刻可用——否则用户得先点一下才知道方向键管用 */
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  /* ---------------- 键盘 ---------------- */

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      // 输入框里打字不该被当成打标键
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;

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

      let handled = true;
      if (action.type === "move") {
        // 胶片条是一维的：上下键在这里没有确定语义，原样放行给滚动
        if (action.key === "ArrowRight") {
          directionRef.current = 1;
          step(1);
        } else if (action.key === "ArrowLeft") {
          directionRef.current = -1;
          step(-1);
        } else if (action.key === "Home") {
          directionRef.current = -1;
          jumpTo(0);
        } else if (action.key === "End") {
          directionRef.current = 1;
          jumpTo(assets.length - 1);
        } else {
          handled = false;
        }
      } else if (action.type === "preview") {
        if (onOpenFullscreen) onOpenFullscreen();
        else handled = false;
      } else if (action.type === "assign") {
        if (onAssign) onAssign(action.categoryId);
        else handled = false;
      } else if (action.type === "other") {
        const other = categories.find((c) => c.kind === "other");
        if (onAssign && other) onAssign(other.id);
        else handled = false;
      } else if (action.type === "curate") {
        if (onCurate) onCurate();
        else handled = false;
      } else if (action.type === "markDelete" || action.type === "unmarkDelete") {
        if (onToggleDelete) onToggleDelete();
        else handled = false;
      } else {
        // selectAll / toggle / clearSelection / confirmDelete 等不属于画廊：
        // 一律不拦，交还给上层（Shift+D 提交待删清单就走这条路）
        handled = false;
      }

      if (!handled) return;
      e.preventDefault();
      e.stopPropagation();
    },
    [
      assets.length,
      categories,
      jumpTo,
      onAssign,
      onCurate,
      onOpenFullscreen,
      onToggleDelete,
      step,
    ],
  );

  /* ---------------- 空态 ---------------- */

  if (!active) {
    return (
      <div className="gallery gallery--empty" data-testid="gallery-view">
        <EmptyState>
          <p className="text-sm">画廊里没有可浏览的素材。</p>
          <p className="text-xs dim">
            当前筛选条件下没有命中任何素材，或待分类夹已经清空。
            换个筛选条件，或回到网格视图确认素材是否已被移走。
          </p>
        </EmptyState>
      </div>
    );
  }

  const customCategories = categories.filter((c) => c.kind === "custom");
  const otherCategory = categories.find((c) => c.kind === "other");
  const marked = markedSet.has(active.id);
  const curated = curatedIds.has(active.id);
  const hasActions = Boolean(onAssign || onCurate || onToggleDelete);

  return (
    <div
      className="gallery"
      data-testid="gallery-view"
      ref={rootRef}
      /* 与 SortingScreen 的 .sorting__grid-wrap 同一手法：容器自己可聚焦，
         快捷键只在焦点位于画廊内时生效，不去 document 上抢键 */
      tabIndex={0}
      aria-label="画廊模式：左右方向键换图，回车看全屏"
      onKeyDown={handleKeyDown}
    >
      {/* 聚焦项被移走后的回退，必须说清楚为什么画面换了人（零静默） */}
      {lostId !== null ? (
        <div className="gallery__alert" role="status" data-testid="gallery-cursor-lost">
          <span>
            原先聚焦的
            <span className="mono"> {lostId} </span>
            已不在当前列表里（可能刚被分类、标删，或被筛选条件排除），已改为显示第 1 张。
            请确认后再继续打标。
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm push-right"
            data-testid="gallery-cursor-lost-dismiss"
            onClick={() => setLostId(null)}
          >
            知道了
          </button>
        </div>
      ) : null}

      <div className="gallery__main">
        <section className="gallery__stage" aria-label="大图">
          <div className="gallery__stage-head">
            <span
              className="text-xs dim"
              aria-live="polite"
              data-testid="gallery-position"
            >
              第 {index + 1} 张 / 共 {assets.length} 张
            </span>
            <span className="gallery__badges" data-testid="gallery-badges">
              <JudgementBadges judgement={active.judgement} />
              {curated ? <Badge tone="ok">已精选</Badge> : null}
              {marked ? <Badge tone="danger">已标删</Badge> : null}
            </span>
            {onOpenFullscreen ? (
              <button
                type="button"
                className="btn btn--sm push-right"
                data-testid="gallery-fullscreen"
                onClick={onOpenFullscreen}
              >
                <Kbd>Enter</Kbd>全屏
              </button>
            ) : null}
          </div>

          <div className="gallery__frame">
            {active.thumbReady && active.thumbnail ? (
              <StageImage
                key={active.id}
                asset={active}
                mediaRef={stageRef}
                onOpenFullscreen={onOpenFullscreen}
                onThumbError={onThumbError}
                onThumbLoad={onThumbLoad}
              />
            ) : (
              /* 缩略图还没出来：说清是「还没做」而不是「没有图」 */
              <div
                ref={(node) => {
                  stageRef.current = node;
                }}
                className="gallery__image gallery__image--empty"
                data-testid="gallery-no-image"
              >
                <span className="text-sm dim">该文件尚未生成预览（索引中）</span>
              </div>
            )}
          </div>
        </section>

        <aside className="gallery__detail" aria-label="素材详情">
          <h3 className="gallery__filename mono" title={active.fileName}>
            {active.fileName}
          </h3>

          <dl className="dl">
            <div className="dl__row">
              <dt className="dl__key">类型</dt>
              <dd className="dl__val">{KIND_LABEL[active.kind]}</dd>
            </div>
            <div className="dl__row">
              <dt className="dl__key">大小</dt>
              <dd className="dl__val mono" data-testid="gallery-size">
                {formatBytes(active.sizeBytes)}
              </dd>
            </div>
            <div className="dl__row">
              <dt className="dl__key">拍摄时间</dt>
              <dd className="dl__val mono" data-testid="gallery-shot-at">
                {/* 没有时间不能留空:留空读作「这张没时间」,其实是 EXIF 没读到 */}
                {active.shotAt ? (
                  <>
                    {formatTimestamp(active.shotAt)}
                    {active.shotAtFallback ? "（推断自文件修改时间）" : ""}
                  </>
                ) : (
                  <span className="dim">未知（EXIF 无拍摄时间，也未回退文件时间）</span>
                )}
              </dd>
            </div>
            <div className="dl__row">
              <dt className="dl__key">判定</dt>
              <dd className="dl__val" data-testid="gallery-judgement">
                {/* 没有 judgement = 本机 AI 还没分析过,不是「分析过且一切正常」 */}
                {active.judgement ? (
                  <JudgementBadges judgement={active.judgement} />
                ) : (
                  <span className="dim">尚未分析（本机 AI 判定未跑到这张）</span>
                )}
              </dd>
            </div>
            <div className="dl__row">
              <dt className="dl__key">人脸</dt>
              <dd className="dl__val" data-testid="gallery-faces">
                {/*
                  与 Lightbox 同一判例：「检出 0 张脸」和「这次分析根本没做人脸检测」
                  是两件事，合并成一句会把「不知道」说成「没有」。
                */}
                {!active.judgement ? (
                  <span className="dim">尚未分析</span>
                ) : active.judgement.faces == null ? (
                  <span className="dim">人脸检测不可用（本次分析未做人脸检测）</span>
                ) : (
                  `检出人脸 ${active.judgement.faces}`
                )}
              </dd>
            </div>
            <div className="dl__row">
              <dt className="dl__key">状态</dt>
              <dd className="dl__val" data-testid="gallery-flags">
                {curated || marked ? (
                  <span className="gallery__badges">
                    {curated ? <Badge tone="ok">已精选</Badge> : null}
                    {marked ? <Badge tone="danger">已标删</Badge> : null}
                  </span>
                ) : (
                  <span className="dim">未标记</span>
                )}
              </dd>
            </div>
            <div className="dl__row">
              <dt className="dl__key">路径</dt>
              <dd className="dl__val mono text-xs" data-testid="gallery-path">
                {/* id 就是项目内相对路径,长路径整条给出,不截断成谜语 */}
                {active.id}
              </dd>
            </div>
          </dl>

          {hasActions ? (
            /* 动作条兼快捷键提示（与 Lightbox 同一口径 D2）：
               在看大图的地方就能把这张的去向定下来，不必退回网格找格子 */
            <div className="gallery__actions" data-testid="gallery-actions">
              {onAssign
                ? customCategories.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="btn btn--sm"
                      data-testid="gallery-assign"
                      data-category={c.id}
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
                  data-testid="gallery-curate"
                  title="复制一份进「精选/待修」，原件留在待分类"
                  onClick={onCurate}
                >
                  <Kbd>P</Kbd>精选
                </button>
              ) : null}
              {onAssign && otherCategory ? (
                <button
                  type="button"
                  className="btn btn--sm"
                  data-testid="gallery-other"
                  onClick={() => onAssign(otherCategory.id)}
                >
                  <Kbd>O</Kbd>其他
                </button>
              ) : null}
              {onToggleDelete ? (
                <button
                  type="button"
                  className={`btn btn--sm${marked ? "" : " btn--danger"}`}
                  data-testid="gallery-toggle-delete"
                  onClick={onToggleDelete}
                >
                  <Kbd>D</Kbd>
                  {marked ? "取消标删" : "标删"}
                </button>
              ) : null}
            </div>
          ) : null}
        </aside>
      </div>

      <div
        className="gallery__strip"
        role="listbox"
        /* 选项都是 tabIndex=-1，活动项靠 aria-activedescendant 指出来：
           上千格逐个 Tab 会让键盘用户走不出胶片条 */
        tabIndex={0}
        aria-activedescendant={shotDomId(index)}
        aria-label={`胶片条，共 ${assets.length} 张`}
        data-testid="gallery-strip"
      >
        {assets.map((asset, i) => (
          <StripShot
            key={asset.id}
            asset={asset}
            index={i}
            selected={i === index}
            marked={markedSet.has(asset.id)}
            curated={curatedIds.has(asset.id)}
            registerRef={(node) => {
              if (node) shotRefs.current.set(asset.id, node);
              else shotRefs.current.delete(asset.id);
            }}
            onPick={() => {
              directionRef.current = i >= index ? 1 : -1;
              selectAsset(asset.id);
              /* 点完要保证键盘还能接着用：部分内核（macOS 的 WebKit/Firefox）
                 点按钮并不移动焦点，activeElement 会停在 body 上 */
              if (!rootRef.current?.contains(document.activeElement)) {
                rootRef.current?.focus({ preventScroll: true });
              }
            }}
            onThumbError={onThumbError}
            onThumbLoad={onThumbLoad}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 大图。取图失败要与「还没生成」分开说：前者是缓存失效/被清，
 * 后者是索引还没跑到——用户的下一步动作完全不同。
 */
function StageImage({
  asset,
  mediaRef,
  onOpenFullscreen,
  onThumbError,
  onThumbLoad,
}: {
  asset: SortingAsset;
  mediaRef: { current: HTMLElement | null };
  onOpenFullscreen?: () => void;
  onThumbError: () => void;
  onThumbLoad: () => void;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        ref={(node) => {
          mediaRef.current = node;
        }}
        className="gallery__image gallery__image--empty"
        data-testid="gallery-image-failed"
        role="status"
      >
        <span className="text-sm">预览不可用</span>
        <span className="text-xs dim">
          缩略图取不到（缓存已失效或被清理）。原始文件不受影响，重新索引后可恢复。
        </span>
      </div>
    );
  }

  return (
    <img
      ref={(node) => {
        mediaRef.current = node;
      }}
      className="gallery__image"
      src={asset.thumbnail}
      alt={asset.fileName}
      data-testid="gallery-image"
      title={onOpenFullscreen ? "点击看全屏（缩略图预览，清晰度有限）" : undefined}
      onClick={onOpenFullscreen}
      onError={() => {
        setFailed(true);
        onThumbError();
      }}
      onLoad={onThumbLoad}
    />
  );
}

/** 胶片条里的一格 */
function StripShot({
  asset,
  index,
  selected,
  marked,
  curated,
  registerRef,
  onPick,
  onThumbError,
  onThumbLoad,
}: {
  asset: SortingAsset;
  index: number;
  selected: boolean;
  marked: boolean;
  curated: boolean;
  registerRef: (node: HTMLElement | null) => void;
  onPick: () => void;
  onThumbError: () => void;
  onThumbLoad: () => void;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [asset.thumbnail]);

  return (
    <button
      type="button"
      id={shotDomId(index)}
      ref={registerRef}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      className={`gallery__shot${selected ? " gallery__shot--active" : ""}`}
      data-testid="gallery-shot"
      data-asset={asset.id}
      title={asset.fileName}
      onClick={onPick}
    >
      {asset.thumbReady && asset.thumbnail && !failed ? (
        <img
          className="gallery__shot-thumb"
          src={asset.thumbnail}
          alt=""
          loading="lazy"
          data-testid="gallery-shot-thumb"
          onError={() => {
            setFailed(true);
            onThumbError();
          }}
          onLoad={onThumbLoad}
        />
      ) : (
        /* 与主网格同一口径：没图不许留白，「索引中」和「预览不可用」分开说 */
        <span
          className="gallery__shot-thumb gallery__shot-thumb--empty"
          data-testid="gallery-shot-no-thumb"
        >
          <span className="text-2xs dim">{failed ? "预览不可用" : "索引中"}</span>
        </span>
      )}
      <span className="gallery__shot-name mono text-2xs truncate">{asset.fileName}</span>
      {curated ? (
        <span className="gallery__shot-flag gallery__shot-flag--curated" aria-hidden="true">
          ✓
        </span>
      ) : null}
      {marked ? (
        <span className="gallery__shot-flag gallery__shot-flag--delete" aria-hidden="true">
          D
        </span>
      ) : null}
      <span className="sr-only">
        第 {index + 1} 项
        {curated ? "，已精选" : ""}
        {marked ? "，已标记待删除" : ""}
      </span>
    </button>
  );
}
