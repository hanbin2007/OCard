/** 自绘表单控件:勾选框语义与下拉的开合/选择/键盘/外点关闭。 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Checkbox, Select } from "./controls";

afterEach(cleanup);

describe("Checkbox", () => {
  it("内部是真 checkbox:checked/点击/禁用语义原生成立", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Checkbox testId="cb" checked={false} onChange={onChange}>
        选项文案
      </Checkbox>,
    );
    const input = screen.getByTestId("cb") as HTMLInputElement;
    expect(input.type).toBe("checkbox");
    expect(input.checked).toBe(false);

    await user.click(screen.getByText("选项文案"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("禁用时不可切换", async () => {
    const onChange = vi.fn();
    render(
      <Checkbox testId="cb" checked disabled onChange={onChange}>
        锁定
      </Checkbox>,
    );
    fireEvent.click(screen.getByText("锁定"));
    expect(onChange).not.toHaveBeenCalled();
  });
});

const OPTIONS = [
  { value: "a", label: "甲" },
  { value: "b", label: "乙" },
  { value: "c", label: "丙" },
];

function setupSelect(value = "") {
  const onChange = vi.fn();
  render(
    <Select testId="sel" value={value} onChange={onChange} options={OPTIONS} />,
  );
  return { onChange };
}

describe("Select", () => {
  it("触发器显示占位/选中项,点击展开 listbox(portal 到 body)", async () => {
    const user = userEvent.setup();
    setupSelect("b");
    const trigger = screen.getByTestId("sel");
    expect(trigger.textContent).toContain("乙");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await user.click(trigger);
    const list = screen.getByRole("listbox");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(list.parentElement).toBe(document.body);
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(
      screen.getByRole("option", { name: "乙" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("点选项提交值并收起,焦点回触发器", async () => {
    const user = userEvent.setup();
    const { onChange } = setupSelect();
    await user.click(screen.getByTestId("sel"));
    await user.click(screen.getByRole("option", { name: "丙" }));

    expect(onChange).toHaveBeenCalledWith("c");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("sel"));
  });

  it("键盘:↓ 移动活动项,Enter 提交,Esc 关闭(走真实焦点路径)", async () => {
    const user = userEvent.setup();
    const { onChange } = setupSelect("a");
    await user.click(screen.getByTestId("sel"));
    // 打开后焦点应真的落在 listbox 上——user.keyboard 打到 activeElement,
    // 若 focus() 断了这里立刻红(评审:fireEvent 直打 ul 会绕开焦点时序)
    expect(document.activeElement).toBe(screen.getByRole("listbox"));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("b");
    expect(screen.queryByRole("listbox")).toBeNull();

    await user.click(screen.getByTestId("sel"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("键盘活动项由 aria-activedescendant 指名(读屏可宣布)", async () => {
    const user = userEvent.setup();
    setupSelect("a");
    await user.click(screen.getByTestId("sel"));
    const list = screen.getByRole("listbox");
    await user.keyboard("{ArrowDown}");
    const activeId = list.getAttribute("aria-activedescendant");
    expect(activeId).toBeTruthy();
    const active = document.getElementById(activeId as string);
    expect(active?.textContent).toContain("乙");
  });

  it("点外面收起且不提交", async () => {
    const user = userEvent.setup();
    const { onChange } = setupSelect();
    await user.click(screen.getByTestId("sel"));
    expect(screen.getByRole("listbox")).toBeDefined();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("禁用时点击不展开", async () => {
    const onChange = vi.fn();
    render(
      <Select testId="sel" value="" onChange={onChange} options={OPTIONS} disabled />,
    );
    fireEvent.click(screen.getByTestId("sel"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
