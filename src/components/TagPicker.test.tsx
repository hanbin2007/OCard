/** Notion 式标签选择器:选库内标签、即建新标签、去重与移除。 */

import { cleanup, render, screen } from "@testing-library/react";
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
