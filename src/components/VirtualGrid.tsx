/**
 * 窗口化网格：千张级素材只渲染可视区那几十个节点。
 * 不引第三方虚拟列表库——规则简单（等高行 + 等宽列），自己算更可控。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { scrollElementTo } from "../lib/motion";

/** 视口外多渲染几行，滚动时不至于露白 */
const OVERSCAN_ROWS = 2;
/** 拿不到宽度时（jsdom / 首帧）的列数兜底 */
const FALLBACK_COLUMNS = 6;

export interface VirtualGridProps<T> {
  items: T[];
  /** 单元最小宽度，用来按容器宽度算列数 */
  minCellWidth: number;
  rowHeight: number;
  gap: number;
  renderItem: (item: T, index: number) => ReactNode;
  keyOf: (item: T, index: number) => string;
  /** 需要滚动到可视区的下标（键盘导航用） */
  scrollToIndex?: number | null;
  className?: string;
  ariaLabel?: string;
  onColumnsChange?: (columns: number) => void;
  /**
   * 渲染窗口触到列表尾部时回调(评审 3.7 自动加载):
   * 调用方据此续拉下一页,把「滚到底还要伸手点按钮」的断点抹掉。
   * 同一批 items 只会触发一次;items 变化(加载进来了)后重新武装。
   */
  onEndReached?: () => void;
}

export function VirtualGrid<T>({
  items,
  minCellWidth,
  rowHeight,
  gap,
  renderItem,
  keyOf,
  scrollToIndex,
  className,
  ariaLabel,
  onColumnsChange,
  onEndReached,
}: VirtualGridProps<T>) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });

  const measure = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    setViewport({ width: el.clientWidth, height: el.clientHeight });
  }, []);

  useLayoutEffect(() => {
    measure();
    // jsdom / 老 WebView 没有 ResizeObserver，退回 window resize
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    if (viewportRef.current) observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, [measure]);

  const columns =
    viewport.width > 0
      ? Math.max(1, Math.floor((viewport.width + gap) / (minCellWidth + gap)))
      : FALLBACK_COLUMNS;

  useEffect(() => {
    onColumnsChange?.(columns);
  }, [columns, onColumnsChange]);

  const rowCount = Math.ceil(items.length / columns);
  const rowStride = rowHeight + gap;
  // 视口高度拿不到时（jsdom）按一屏 6 行估，保证测试里也有内容渲染
  const visibleRows =
    viewport.height > 0 ? Math.ceil(viewport.height / rowStride) : 6;

  const firstRow = Math.max(0, Math.floor(scrollTop / rowStride) - OVERSCAN_ROWS);
  const lastRow = Math.min(rowCount, firstRow + visibleRows + OVERSCAN_ROWS * 2);

  const startIndex = firstRow * columns;
  const endIndex = Math.min(items.length, lastRow * columns);
  const visible = items.slice(startIndex, endIndex);

  // 渲染窗口触底 → 通知调用方续拉。按 items 引用武装一次,避免连环触发
  const endNotifiedRef = useRef<T[] | null>(null);
  useEffect(() => {
    if (!onEndReached || items.length === 0) return;
    if (endIndex < items.length) return;
    if (endNotifiedRef.current === items) return;
    endNotifiedRef.current = items;
    onEndReached();
  }, [endIndex, items, onEndReached]);

  /*
   * 键盘移动焦点后把它滚进可视区。
   *
   * 用平滑滚动而不是瞬移：滚动这个动作本身就在回答"我刚从哪儿挪到哪儿"，
   * 一格一格跳着走的时候尤其重要。连按方向键时后一次会接管前一次，
   * 不会排队——滚动天然是可中断的。
   * 减少动效时退回瞬时定位（见 scrollElementTo）。
   */
  // 只在焦点下标变化时滚动定位。此前把 viewport.height/columns 也当触发条件:
  // 工具条换行、滚动条出没等布局抖动都会把用户手上的滚动位置拽回焦点格——
  // 触控板滚动中途"跳变"的来源之一(UX 波二)。几何参数经 ref 取最新值。
  // 已声明的语义边界:同一下标的重复定位请求(值没变)不会再次滚动,
  // 例如连续两次落在同一失败项;要强制回滚需调用方换成 {index, seq} 语义。
  const geoRef = useRef({ columns, rowStride, rowHeight, viewportH: viewport.height });
  geoRef.current = { columns, rowStride, rowHeight, viewportH: viewport.height };
  useEffect(() => {
    if (scrollToIndex == null || scrollToIndex < 0) return;
    const el = viewportRef.current;
    if (!el) return;
    const g = geoRef.current;
    const row = Math.floor(scrollToIndex / g.columns);
    const top = row * g.rowStride;
    const bottom = top + g.rowHeight;
    const height = el.clientHeight || g.viewportH;
    if (top < el.scrollTop) scrollElementTo(el, top);
    else if (height > 0 && bottom > el.scrollTop + height) {
      scrollElementTo(el, bottom - height);
    }
  }, [scrollToIndex]);

  return (
    <div
      className={className}
      ref={viewportRef}
      role="grid"
      aria-label={ariaLabel}
      aria-rowcount={rowCount}
      data-testid="virtual-grid"
      data-columns={columns}
      data-rendered={visible.length}
      /*
       * 只有**跨行**才更新状态。
       *
       * 窗口只取决于 floor(scrollTop / rowStride)，同一行内的像素级滚动
       * 不会改变要渲染的那批节点，却会每帧触发一次几十个格子的重新协调。
       * 千张级素材下这就是掉帧的来源；量化到行之后，滚一屏只重渲染几次。
       */
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop;
        setScrollTop((prev) =>
          Math.floor(prev / rowStride) === Math.floor(top / rowStride) ? prev : top,
        );
      }}
    >
      {/* 用上下占位撑出总高度，滚动条长度才是真的 */}
      <div style={{ height: firstRow * rowStride }} />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gap: `${gap}px`,
        }}
      >
        {visible.map((item, i) => (
          <GridItem key={keyOf(item, startIndex + i)}>
            {renderItem(item, startIndex + i)}
          </GridItem>
        ))}
      </div>
      <div style={{ height: Math.max(0, (rowCount - lastRow) * rowStride) }} />
    </div>
  );
}

/** 只为稳定 key 存在的透明包装 */
function GridItem({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** 导出给测试：窗口计算是纯函数，单独锁死 */
export function visibleRange(
  itemCount: number,
  columns: number,
  rowStride: number,
  scrollTop: number,
  viewportHeight: number,
): { startIndex: number; endIndex: number } {
  const rowCount = Math.ceil(itemCount / columns);
  const visibleRows = viewportHeight > 0 ? Math.ceil(viewportHeight / rowStride) : 6;
  const firstRow = Math.max(0, Math.floor(scrollTop / rowStride) - OVERSCAN_ROWS);
  const lastRow = Math.min(rowCount, firstRow + visibleRows + OVERSCAN_ROWS * 2);
  return {
    startIndex: firstRow * columns,
    endIndex: Math.min(itemCount, lastRow * columns),
  };
}
