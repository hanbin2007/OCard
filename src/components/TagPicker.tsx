/**
 * Notion 式标签选择器（拷卡「内容备注」的替代形态）：
 * 已选标签以彩色 chip 呈现；输入框过滤项目标签库，可即时创建新标签。
 * 标签库的持久化由调用方负责（onCreateTag 里写回项目 settings）。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectTag } from "../api/types";
import {
  colorOfTag,
  findTag,
  normalizeTagName,
  tagKey,
  tagNameError,
} from "../lib/tags";

export function TagChip({
  name,
  color,
  onRemove,
}: {
  name: string;
  color: string;
  onRemove?: () => void;
}) {
  return (
    <span className={`tag tag--${color}`} data-testid="tag-chip">
      <span className="tag__name">{name}</span>
      {onRemove ? (
        <button
          type="button"
          className="tag__remove"
          aria-label={`移除标签 ${name}`}
          onClick={onRemove}
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

export function TagPicker({
  id,
  testId,
  value,
  onChange,
  library,
  onCreateTag,
  invalid,
  disabled,
}: {
  id?: string;
  testId?: string;
  /** 已选标签名（顺序即呈现顺序） */
  value: string[];
  onChange: (next: string[]) => void;
  /** 项目标签库（配色来源与候选列表） */
  library: ProjectTag[];
  /** 创建新标签进库（调用方负责持久化与配色分配） */
  onCreateTag: (name: string) => void;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const selectedKeys = useMemo(() => new Set(value.map(tagKey)), [value]);
  const trimmed = normalizeTagName(query);

  /** 候选：库中未选的、匹配输入的标签 */
  const candidates = useMemo(() => {
    const q = tagKey(query);
    return library.filter(
      (t) => !selectedKeys.has(tagKey(t.name)) && (!q || tagKey(t.name).includes(q)),
    );
  }, [library, selectedKeys, query]);

  /** 输入了新名字（库里没有同名且未选中）时给「创建」项 */
  const createError = trimmed ? tagNameError(trimmed) : "空";
  const canCreate =
    trimmed.length > 0 &&
    createError === null &&
    !findTag(library, trimmed) &&
    !selectedKeys.has(tagKey(trimmed));

  const optionCount = candidates.length + (canCreate ? 1 : 0);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, optionCount]);

  // 点击组件外部收起下拉
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function addTag(name: string) {
    const clean = normalizeTagName(name);
    if (!clean || selectedKeys.has(tagKey(clean))) return;
    onChange([...value, clean]);
    setQuery("");
  }

  function createAndAdd() {
    if (!canCreate) return;
    onCreateTag(trimmed);
    addTag(trimmed);
  }

  function pick(index: number) {
    if (index < candidates.length) {
      addTag(candidates[index].name);
    } else if (canCreate) {
      createAndAdd();
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && query === "" && value.length > 0) {
      onChange(value.slice(0, -1));
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, Math.max(0, optionCount - 1)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      // 表单里回车不提交:先消费为「选中/创建标签」
      e.preventDefault();
      if (optionCount > 0) pick(activeIndex);
      return;
    }
    if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div
      ref={rootRef}
      className={`tag-picker${invalid ? " tag-picker--invalid" : ""}${
        disabled ? " tag-picker--disabled" : ""
      }`}
      data-testid={testId}
    >
      <div className="tag-picker__box">
        {value.map((name) => (
          <TagChip
            key={tagKey(name)}
            name={name}
            color={colorOfTag(library, name)}
            onRemove={disabled ? undefined : () => onChange(value.filter((n) => n !== name))}
          />
        ))}
        <input
          id={id}
          className="tag-picker__input"
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={id ? `${id}-listbox` : undefined}
          placeholder={value.length === 0 ? "选择或创建标签…" : ""}
          value={query}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
      </div>

      {open && optionCount > 0 ? (
        <div
          className="tag-picker__menu"
          role="listbox"
          id={id ? `${id}-listbox` : undefined}
          aria-label="标签候选"
        >
          {candidates.map((tag, index) => (
            <button
              key={tagKey(tag.name)}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              data-testid="tag-option"
              className={`tag-picker__option${
                index === activeIndex ? " tag-picker__option--active" : ""
              }`}
              /* 用 pointerdown 抢在 blur 之前完成选择 */
              onPointerDown={(e) => {
                e.preventDefault();
                pick(index);
              }}
            >
              <TagChip name={tag.name} color={colorOfTag(library, tag.name)} />
            </button>
          ))}
          {canCreate ? (
            <button
              type="button"
              role="option"
              aria-selected={activeIndex === candidates.length}
              data-testid="tag-create"
              className={`tag-picker__option${
                activeIndex === candidates.length ? " tag-picker__option--active" : ""
              }`}
              onPointerDown={(e) => {
                e.preventDefault();
                createAndAdd();
              }}
            >
              <span className="tag-picker__create-label">创建</span>
              <TagChip name={trimmed} color="gray" />
            </button>
          ) : null}
        </div>
      ) : null}
      {trimmed && createError && createError !== "空" && !findTag(library, trimmed) ? (
        <span className="field__error" role="alert">
          {createError}
        </span>
      ) : null}
    </div>
  );
}
