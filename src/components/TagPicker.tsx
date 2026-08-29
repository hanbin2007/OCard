/**
 * Notion 式标签选择器（拷卡「内容备注」的替代形态）：
 * 已选标签以彩色 chip 呈现；输入框过滤项目标签库，可即时创建新标签。
 * 标签库的持久化由调用方负责（onCreateTag 里写回项目 settings）。
 *
 * 候选浮层为什么要 `createPortal` 到 body（做法照搬 controls.tsx 的 Select）：
 * 标签字段坐在拷卡屏的 `.card` 里，而 `.card` 是 `overflow: hidden`——
 * 普通绝对定位的菜单会被卡片下沿**裁掉**（用户只看得见半行候选），
 * 而 overflow 裁剪是 z-index 逃不掉的，只能让菜单整个脱离那棵子树。
 * 代价是定位得自己算（见 measure），并且「点外面收起」要额外放行菜单本身。
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
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

/** 浮层几何：紧贴输入框下方；下方放不下就翻到上方（口径与 .select-pop 一致） */
interface PopRect {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/* 几何常量与 Select 对齐，改一处就得两处一起改的东西不再各写各的字面量 */
const MENU_MAX_H = 220;
const MENU_MIN_H = 120;
/** 下方可用高度低于它就考虑翻面 */
const FLIP_THRESHOLD = 160;
/** 菜单与输入框之间的缝 */
const GAP = 4;
/** 贴视口边缘时留出的安全距离 */
const EDGE = 8;

const clampH = (space: number) =>
  Math.min(MENU_MAX_H, Math.max(MENU_MIN_H, space));

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
  const [rect, setRect] = useState<PopRect | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** 定位锚点：跟着 chip 换行一起长高的那个框，不是整个组件 */
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 没传 id 时也得有个稳定的 listbox id，否则 aria-controls 只能整个省掉
  const autoId = useId();
  const listboxId = id ? `${id}-listbox` : `${autoId}-listbox`;
  const optionId = (index: number) => `${listboxId}-opt-${index}`;

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

  /**
   * 一个候选都没有时说一句话，而不是弹一个空框——空白下拉是典型的静默：
   * 用户看不出是「没得选了」还是「组件坏了」。
   * 返回 null 表示这一档不该弹任何东西（此时下方 field__error 已经在说话，
   * 再顶一层提示只是噪音）。
   */
  const emptyHint = useMemo(() => {
    if (optionCount > 0) return null;
    if (trimmed && selectedKeys.has(tagKey(trimmed))) {
      return `「${trimmed}」已经加上了`;
    }
    // 名字非法或超长：错误文案归 field__error 管
    if (trimmed) return null;
    if (library.length === 0) return "标签库还是空的，直接输入即可新建";
    return "标签都用上了，直接输入可新建";
  }, [optionCount, trimmed, selectedKeys, library.length]);

  /** 菜单是否真的显示出来了（aria-expanded / Esc 是否吞掉都以它为准） */
  const menuOpen = open && (optionCount > 0 || emptyHint !== null);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, optionCount]);

  /** 按锚点当前位置算浮层几何 */
  const measure = useCallback((): PopRect | null => {
    const el = boxRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const below = viewportH - r.bottom - 12;
    const above = r.top - 12;
    // 下方优先；放不下 160px 且上方更宽裕时翻上去
    const flip = below < FLIP_THRESHOLD && above > below;
    // 横向也夹在视口内：输入框贴右缘时菜单不许溢出
    const left = Math.max(
      EDGE,
      Math.min(r.left, window.innerWidth - r.width - EDGE),
    );
    return {
      left,
      width: r.width,
      ...(flip
        ? { bottom: viewportH - r.top + GAP, maxHeight: clampH(above) }
        : { top: r.bottom + GAP, maxHeight: clampH(below) }),
    };
  }, []);

  /*
   * 重算时机：开合、加/减 chip（box 会换行长高）、候选增减、输入换行。
   * 用 layout effect 是为了在同一帧里改完位置——先画在 (0,0) 再挪过去会闪。
   */
  useLayoutEffect(() => {
    if (!menuOpen) {
      setRect(null);
      return;
    }
    setRect(measure());
  }, [menuOpen, measure, value.length, optionCount, emptyHint, query]);

  /*
   * 跟随滚动与窗口尺寸变化。
   *
   * 这里**没有**照搬 Select 的「一滚就收起」：Select 打开后焦点在 listbox 上、
   * 用户不在打字，收起代价很小；标签选择器的焦点始终在输入框里，滚一下就把
   * 候选列表从手底下抽走，正是本次要修的那种别扭。所以改成重新定位，
   * 只有锚点整个滚出视口时才收起——那时菜单再跟就成了浮在无关内容上的孤儿。
   */
  useEffect(() => {
    if (!menuOpen) return;
    const reposition = (e?: Event) => {
      // 菜单自身滚动不算
      if (
        e &&
        menuRef.current &&
        e.target instanceof Node &&
        menuRef.current.contains(e.target)
      ) {
        return;
      }
      const box = boxRef.current;
      if (!box) return;
      const r = box.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) {
        setOpen(false);
        return;
      }
      setRect(measure());
    };
    window.addEventListener("scroll", reposition, { capture: true, passive: true });
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, { capture: true });
      window.removeEventListener("resize", reposition);
    };
  }, [menuOpen, measure]);

  // 点击组件外部收起下拉
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      // 菜单已经 portal 到 body，不再是 rootRef 的后代——不单独放行的话
      // 「点候选」会被当成「点外面」，一点就关，候选永远选不中
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
  }, [open]);

  function addTag(name: string) {
    const clean = normalizeTagName(name);
    if (!clean || selectedKeys.has(tagKey(clean))) return;
    onChange([...value, clean]);
    setQuery("");
    /*
     * 连续打标签是这个界面的主要用法（一次拷卡常打三四个）。加完一个之后
     * 焦点留在输入框、候选列表继续开着，免得每加一个都要重新点一次输入框。
     * 只在「本来就开着」时续开：用户按 Esc 主动收起之后再用键盘补一个标签，
     * 列表不该自己弹回来——那是跟用户的明确意图打架。
     */
    if (open) {
      setOpen(true);
      inputRef.current?.focus({ preventScroll: true });
    }
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
      /*
       * 菜单开着时这一下 Esc 归菜单，不许再冒到 document——
       * 外层对话框（.overlay > .dialog）的 Esc 监听挂在 document 上，
       * 一次按键同时关掉下拉和对话框，用户会以为自己误触了取消。
       */
      if (menuOpen) {
        e.preventDefault();
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
      }
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
      <div className="tag-picker__box" ref={boxRef}>
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
          ref={inputRef}
          className="tag-picker__input"
          type="text"
          role="combobox"
          aria-expanded={menuOpen}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-controls={menuOpen ? listboxId : undefined}
          aria-activedescendant={
            menuOpen && optionCount > 0 ? optionId(activeIndex) : undefined
          }
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

      {menuOpen && rect
        ? createPortal(
            <div
              ref={menuRef}
              className="tag-picker__menu"
              role="listbox"
              id={listboxId}
              aria-label="标签候选"
              style={{
                left: rect.left,
                width: rect.width,
                top: rect.top,
                bottom: rect.bottom,
                maxHeight: rect.maxHeight,
              }}
            >
              {candidates.map((tag, index) => (
                <button
                  key={tagKey(tag.name)}
                  type="button"
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === activeIndex}
                  data-testid="tag-option"
                  /* 候选不进 Tab 序：菜单已经 portal 到 body 末尾，
                     可 Tab 会把焦点甩到整份文档的最后面（组合框本来就该走方向键） */
                  tabIndex={-1}
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
                  id={optionId(candidates.length)}
                  role="option"
                  aria-selected={activeIndex === candidates.length}
                  data-testid="tag-create"
                  tabIndex={-1}
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
              {optionCount === 0 && emptyHint ? (
                <div
                  className="tag-picker__empty"
                  data-testid="tag-empty"
                  role="option"
                  aria-disabled="true"
                  aria-selected="false"
                >
                  {emptyHint}
                </div>
              ) : null}
            </div>,
            document.body,
          )
        : null}
      {trimmed && createError && createError !== "空" && !findTag(library, trimmed) ? (
        <span className="field__error" role="alert">
          {createError}
        </span>
      ) : null}
    </div>
  );
}
