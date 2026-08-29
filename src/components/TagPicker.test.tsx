/** Notion 式标签选择器:选库内标签、即建新标签、去重与移除。 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { ProjectTag } from "../api/types";
import { TagPicker } from "./TagPicker";

afterEach(cleanup);

const library: ProjectTag[] = [
  { name: "开幕式", color: "blue" },
  { name: "田赛", color: "green" },
  { name: "颁奖", color: "purple" },
];

/** 只数输入框里的已选 chip(下拉候选里也渲染 TagChip,不能混着数) */
function boxChips() {
  const box = screen
    .getByTestId("picker")
    .querySelector(".tag-picker__box") as HTMLElement;
  return Array.from(box.querySelectorAll('[data-testid="tag-chip"]'));
}

function chipNames() {
  return boxChips().map((c) => c.querySelector(".tag__name")?.textContent);
}

function Harness({
  onCreateTag = () => {},
  initial = [] as string[],
}: {
  onCreateTag?: (name: string) => void;
  initial?: string[];
}) {
  const [value, setValue] = useState<string[]>(initial);
  return (
    <TagPicker
      id="t"
      testId="picker"
      value={value}
      onChange={setValue}
      library={library}
      onCreateTag={onCreateTag}
    />
  );
}

describe("TagPicker", () => {
  it("聚焦展开库内候选,点选后变成 chip", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("combobox"));
    const options = screen.getAllByTestId("tag-option");
    expect(options).toHaveLength(library.length);

    await user.click(options[1]);
    expect(chipNames()).toContain("田赛");
    // 已选中的不再出现在候选里
    expect(
      screen.queryAllByTestId("tag-option").map((o) => o.textContent),
    ).not.toContain("田赛");
  });

  it("输入过滤候选;库里没有时给「创建」项并回调建库", async () => {
    const user = userEvent.setup();
    const created: string[] = [];
    render(<Harness onCreateTag={(n) => created.push(n)} />);

    const input = screen.getByRole("combobox");
    await user.type(input, "颁");
    expect(screen.getAllByTestId("tag-option")).toHaveLength(1);

    await user.clear(input);
    await user.type(input, "花絮");
    expect(screen.queryAllByTestId("tag-option")).toHaveLength(0);
    await user.click(screen.getByTestId("tag-create"));

    expect(created).toEqual(["花絮"]);
    expect(chipNames()).toContain("花絮");
  });

  it("回车选中第一个候选;空输入退格删掉最后一个 chip", async () => {
    const user = userEvent.setup();
    render(<Harness initial={["开幕式"]} />);

    const input = screen.getByRole("combobox");
    await user.type(input, "田");
    await user.keyboard("{Enter}");
    expect(boxChips()).toHaveLength(2);

    await user.keyboard("{Backspace}");
    expect(chipNames()).toEqual(["开幕式"]);
  });

  it("同名(含大小写/空白差异)不会重复创建", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness initial={["花絮"]} onCreateTag={spy} />);

    await user.type(screen.getByRole("combobox"), " 花絮 ");
    // 已选中同名:既无候选也无创建项
    expect(screen.queryByTestId("tag-create")).toBeNull();
    await user.keyboard("{Enter}");
    expect(spy).not.toHaveBeenCalled();
    expect(boxChips()).toHaveLength(1);
  });

  it("非法标签名显示错误而不是静默不响应", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByRole("combobox"), "a/b");
    expect(screen.getByRole("alert").textContent).toContain("不能包含");
    expect(screen.queryByTestId("tag-create")).toBeNull();
  });

  it("点 chip 上的 × 移除标签", async () => {
    const user = userEvent.setup();
    render(<Harness initial={["开幕式", "田赛"]} />);
    await user.click(screen.getByRole("button", { name: "移除标签 开幕式" }));
    expect(chipNames()).toEqual(["田赛"]);
  });
});

/* ================================================================== *
 * bug ①:下拉被祖先的 overflow 裁掉
 *
 * 病灶:`.tag-picker__menu` 原本是普通绝对定位,而它的宿主 `.card` 是
 * `overflow: hidden`——菜单被卡片下沿切掉,用户只看得见半行候选。
 * z-index 逃不出 overflow 裁剪,唯一的出路是脱离那棵子树。
 *
 * jsdom 量不了裁剪,所以这里钉的是**结构**(菜单不在 .tag-picker 子树里)
 * 与**几何算法**(翻面/夹边由 JS 算,可以在 jsdom 里喂假 rect 验证)。
 * 真正的"看着没被切"由浏览器实测补。
 * ================================================================== */

/** 拿到定位锚点(菜单的位置按它算) */
function pickerBox() {
  return screen
    .getByTestId("picker")
    .querySelector(".tag-picker__box") as HTMLElement;
}

/** 给锚点喂一个假的视口坐标,好在 jsdom 里验证定位算法 */
function fakeAnchor(el: HTMLElement, r: { top: number; height: number; left?: number; width?: number }) {
  const left = r.left ?? 100;
  const width = r.width ?? 300;
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    top: r.top,
    bottom: r.top + r.height,
    left,
    right: left + width,
    width,
    height: r.height,
    x: left,
    y: r.top,
    toJSON: () => ({}),
  } as DOMRect);
}

describe("TagPicker 候选浮层 portal(bug ①:被祖先 overflow 裁掉)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("菜单挂在 body 下,不在 .tag-picker 子树里", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("combobox"));

    const menu = screen.getByRole("listbox", { name: "标签候选" });
    expect(menu.parentElement).toBe(document.body);
    // 关键断言:留在子树里就会被 .card 的 overflow: hidden 裁掉
    expect(menu.closest(".tag-picker")).toBeNull();
    expect(
      screen.getByTestId("picker").querySelector(".tag-picker__menu"),
    ).toBeNull();
  });

  it("portal 之后点候选仍然算「点在组件内」,不会被外部点击逻辑当场关掉", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("combobox"));
    // 菜单已不在 rootRef 子树里:收起逻辑若只认 rootRef,这一点就会先关菜单再落空
    await user.click(screen.getAllByTestId("tag-option")[0]);
    expect(chipNames()).toEqual(["开幕式"]);
  });

  it("下方空间不够时翻到输入框上方(而不是被视口下沿切掉)", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    // jsdom 视口高 768:锚点底边压到 730,下方只剩 26px
    fakeAnchor(pickerBox(), { top: 700, height: 30 });
    await user.click(screen.getByRole("combobox"));

    const menu = screen.getByRole("listbox", { name: "标签候选" });
    expect(menu.style.bottom).toBe(`${768 - 700 + 4}px`);
    expect(menu.style.top).toBe("");
  });

  it("下方够用时贴在输入框下方,并按可用空间限高", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    fakeAnchor(pickerBox(), { top: 100, height: 30 });
    await user.click(screen.getByRole("combobox"));

    const menu = screen.getByRole("listbox", { name: "标签候选" });
    expect(menu.style.top).toBe(`${130 + 4}px`);
    expect(menu.style.bottom).toBe("");
    expect(menu.style.maxHeight).toBe("220px");
    expect(menu.style.width).toBe("300px");
  });

  it("锚点贴右缘时菜单被夹回视口内", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    // jsdom 视口宽 1024:左 900 + 宽 300 会溢出 176px
    fakeAnchor(pickerBox(), { top: 100, height: 30, left: 900, width: 300 });
    await user.click(screen.getByRole("combobox"));

    expect(screen.getByRole("listbox", { name: "标签候选" }).style.left).toBe(
      `${1024 - 300 - 8}px`,
    );
  });
});

/* ================================================================== *
 * bug ②:加完一个标签后不自动弹出剩余可选项
 *
 * 用户原话「加完一个后不会自动弹出可选的标签」。连续打标签是这个界面的
 * 主要用法(一次拷卡常打三四个),每加一个都要重新点一次输入框很别扭。
 * ================================================================== */

describe("TagPicker 连续打标签(bug ②)", () => {
  it("加完一个之后菜单继续开着,焦点留在输入框,且不含已选项", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getAllByTestId("tag-option")[1]); // 田赛

    // 菜单没关
    const menu = screen.getByRole("listbox", { name: "标签候选" });
    const names = screen.getAllByTestId("tag-option").map((o) => o.textContent);
    expect(names).toEqual(["开幕式", "颁奖"]);
    expect(names).not.toContain("田赛");
    expect(menu.style.top).not.toBe("");
    // 焦点还在输入框:下一个标签直接接着打
    expect(document.activeElement).toBe(screen.getByRole("combobox"));
    expect(screen.getByRole("combobox")).toHaveProperty("value", "");
  });

  it("浏览器把焦点搬到候选按钮上时,加完标签也要把焦点抢回输入框", async () => {
    // 选中走的是 pointerdown + preventDefault(抢在 blur 之前)。
    // 但「preventDefault 会不会连带拦住取焦」各引擎口径不一致,而 OCard 的
    // 运行时是 Tauri 的 WKWebView——不能指望它一定拦住。这里直接模拟
    // 「拦不住」的那一档:焦点已经落在候选按钮上,加完之后必须回到输入框,
    // 否则用户接着打下一个标签时字全打飞了。
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole("combobox");
    await user.click(input);

    const option = screen.getAllByTestId("tag-option")[1];
    option.focus();
    expect(document.activeElement).toBe(option);

    fireEvent.pointerDown(option);
    expect(chipNames()).toEqual(["田赛"]);
    expect(document.activeElement).toBe(input);
  });

  it("键盘连打:每次回车之后列表都还在,候选逐个减少", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("combobox"));

    for (const [name, left] of [
      ["开幕式", 2],
      ["田赛", 1],
    ] as const) {
      await user.keyboard("{Enter}");
      expect(chipNames()).toContain(name);
      expect(screen.getAllByTestId("tag-option")).toHaveLength(left);
    }
  });

  it("剩余可选项为空时不弹空框,而是给一句话", async () => {
    const user = userEvent.setup();
    render(<Harness initial={["开幕式", "田赛"]} />);

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByTestId("tag-option")); // 最后一个:颁奖

    expect(screen.queryAllByTestId("tag-option")).toHaveLength(0);
    expect(screen.queryByTestId("tag-create")).toBeNull();
    // 空白下拉是典型的静默:必须说清楚为什么没得选
    const hint = screen.getByTestId("tag-empty");
    expect(hint.textContent).toContain("标签都用上了");
    expect(hint.closest(".tag-picker__menu")).not.toBeNull();
  });

  it("标签库本身是空的时候也说话,不弹空框", async () => {
    const user = userEvent.setup();
    render(
      <TagPicker
        id="t"
        testId="picker"
        value={[]}
        onChange={() => {}}
        library={[]}
        onCreateTag={() => {}}
      />,
    );
    await user.click(screen.getByRole("combobox"));
    expect(screen.getByTestId("tag-empty").textContent).toContain("标签库还是空的");
  });

  it("输入了一个已经加过的名字时说明原因,而不是静默没反应", async () => {
    const user = userEvent.setup();
    render(<Harness initial={["田赛"]} />);
    await user.type(screen.getByRole("combobox"), "田赛");

    expect(screen.queryByTestId("tag-create")).toBeNull();
    expect(screen.getByTestId("tag-empty").textContent).toContain("已经加上了");
  });

  it("非法名字不弹提示框(下方的 field__error 已经在说话,别叠两层)", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByRole("combobox"), "a/b");

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("不能包含");
  });

  it("按 Esc 主动关掉之后,再用键盘补一个标签不会把列表弹回来", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("combobox"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();

    // 关着也仍然能靠回车补标签(原有行为),但列表不该自己弹回来
    await user.keyboard("{Enter}");
    expect(chipNames()).toEqual(["开幕式"]);
    expect(screen.queryByRole("listbox")).toBeNull();

    // 用户重新打字才算新的意图:这时候要弹
    await user.keyboard("田");
    expect(screen.getByRole("listbox", { name: "标签候选" })).toBeDefined();
  });

  it("菜单开着时的 Esc 不冒到 document(否则外层对话框会跟着一起关)", async () => {
    const user = userEvent.setup();
    const onDocEscape = vi.fn();
    document.addEventListener("keydown", onDocEscape);
    try {
      render(<Harness />);
      await user.click(screen.getByRole("combobox"));
      onDocEscape.mockClear();

      await user.keyboard("{Escape}"); // 菜单开着:这一下归菜单
      expect(onDocEscape).not.toHaveBeenCalled();

      await user.keyboard("{Escape}"); // 菜单已关:放行给外层
      expect(onDocEscape).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", onDocEscape);
    }
  });
});
