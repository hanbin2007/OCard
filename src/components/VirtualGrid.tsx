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

  // 键盘移动焦点后把它滚进可视区
  useEffect(() => {
    if (scrollToIndex == null || scrollToIndex < 0) return;
    const el = viewportRef.current;
    if (!el) return;
    const row = Math.floor(scrollToIndex / columns);
    const top = row * rowStride;
    const bottom = top + rowHeight;
    const height = el.clientHeight || viewport.height;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (height > 0 && bottom > el.scrollTop + height) {
      el.scrollTop = bottom - height;
    }
  }, [scrollToIndex, columns, rowStride, rowHeight, viewport.height]);

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
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
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
