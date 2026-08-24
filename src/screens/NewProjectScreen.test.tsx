import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import App from "../App";
import { toCompactDate } from "./NewProjectScreen";

afterEach(cleanup);

const preloaded = {
  route: "new-project" as const,
  workstation: {
    machineId: "WS-TEST",
    operator: "测试员",
    nasRoot: "/Volumes/DIT-NAS/Projects",
  },
  projects: [],
  cameras: [],
  cards: [],
  volumes: [],
  tasks: [],
};

function setup() {
  render(<App preloaded={preloaded} />);
  const dateInput = screen.getByLabelText("拍摄日期");
  fireEvent.change(dateInput, { target: { value: "2026-08-24" } });
  return { dateInput };
}

describe("toCompactDate", () => {
  it("date input 的 YYYY-MM-DD 转成 YYYYMMDD", () => {
    expect(toCompactDate("2026-08-24")).toBe("20260824");
  });
});

describe("新建项目向导", () => {
  it("默认工况 B，预览出待分类/精选/其他", () => {
    setup();
    expect(screen.getByText("1. 待分类")).toBeDefined();
    expect(screen.getByText("待修")).toBeDefined();
    expect(screen.getByText("已修")).toBeDefined();
  });

  it("填项目名后预览路径实时更新为 日期_项目名", async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText("项目名"), "校运会");
    expect(
      screen.getByText("/Volumes/DIT-NAS/Projects/20260824_校运会"),
    ).toBeDefined();
  });

  it("切到工况 A 预览换成六个固定夹", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /工况 A/ }));
    expect(screen.getByText("6. 成片")).toBeDefined();
    expect(screen.queryByText("1. 待分类")).toBeNull();
  });

  it("工况 A 不显示分类编辑区", async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.getByRole("button", { name: "添加分类" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: /工况 A/ }));
    expect(screen.queryByRole("button", { name: "添加分类" })).toBeNull();
  });

  it("新增分类后预览多一层并重排编号", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "添加分类" }));
    await user.type(screen.getByLabelText("第 4 个分类名"), "颁奖");
    expect(screen.getByText("5. 颁奖")).toBeDefined();
    expect(screen.getByText("6. 精选")).toBeDefined();
    expect(screen.getByText("7. 其他")).toBeDefined();
  });

  it("删除分类后编号收拢", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "删除第 1 个分类" }));
    expect(screen.getByText("2. 会场")).toBeDefined();
    expect(screen.queryByText("2. 领导")).toBeNull();
  });

  it("项目名为空时提交被拦下并报错", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "创建项目" }));
    expect(screen.getByRole("alert").textContent).toContain("请填写项目名");
    // 仍停留在向导页
    expect(screen.getByText("将创建")).toBeDefined();
  });

  it("填齐后创建项目并回到项目列表", async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText("项目名"), "校运会");
    await user.click(screen.getByRole("button", { name: "创建项目" }));
    const row = await screen.findByRole("option", {}, { timeout: 3000 });
    expect(row.textContent).toContain("20260824_校运会");
  });
});
