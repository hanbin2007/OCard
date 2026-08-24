/**
 * 列表键盘导航（键盘优先）：↑/↓ 移动，Home/End 跳首尾，Enter/空格 确认。
 * 容器用 role="listbox"，行用 role="option"，选中项 tabIndex=0（roving tabindex）。
 */

import { useCallback, type KeyboardEvent } from "react";

export interface ListNavigationOptions<T extends string> {
  ids: readonly T[];
  selectedId: T | null;
  onSelect: (id: T) => void;
  onActivate?: (id: T) => void;
  /** 行 DOM id 前缀，用于 aria-activedescendant */
  idPrefix?: string;
}

/** 计算按键后的目标下标；返回 -1 表示不处理该按键 */
export function nextIndexForKey(
  key: string,
  currentIndex: number,
  length: number,
): number {
  if (length === 0) return -1;
  switch (key) {
    case "ArrowDown":
      return currentIndex < 0 ? 0 : Math.min(length - 1, currentIndex + 1);
    case "ArrowUp":
      return currentIndex < 0 ? length - 1 : Math.max(0, currentIndex - 1);
    case "Home":
      return 0;
    case "End":
      return length - 1;
    default:
      return -1;
  }
}

export function useListNavigation<T extends string>({
  ids,
  selectedId,
  onSelect,
  onActivate,
  idPrefix = "row",
}: ListNavigationOptions<T>) {
  const currentIndex = selectedId ? ids.indexOf(selectedId) : -1;

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if ((event.key === "Enter" || event.key === " ") && selectedId) {
        event.preventDefault();
        onActivate?.(selectedId);
        return;
      }
      const target = nextIndexForKey(event.key, currentIndex, ids.length);
      if (target < 0) return;
      event.preventDefault();
      const nextId = ids[target];
      if (nextId && nextId !== selectedId) onSelect(nextId);
    },
    [currentIndex, ids, onActivate, onSelect, selectedId],
  );

  const getItemProps = useCallback(
    (id: T) => ({
      id: `${idPrefix}-${id}`,
      role: "option" as const,
      "aria-selected": id === selectedId,
      tabIndex: -1,
      onClick: () => {
        onSelect(id);
        onActivate?.(id);
      },
    }),
    [idPrefix, onActivate, onSelect, selectedId],
  );

  return {
    containerProps: {
      role: "listbox" as const,
      tabIndex: 0,
      // 焦点留在容器上，用 activedescendant 告诉读屏器当前是哪一行
      "aria-activedescendant": selectedId ? `${idPrefix}-${selectedId}` : undefined,
      onKeyDown,
    },
    getItemProps,
  };
}
