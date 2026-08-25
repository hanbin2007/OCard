import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "../App";
import { mockProjects, mockWorkstation } from "../api/mock";

afterEach(cleanup);

const preloaded = {
  route: "projects" as const,
  workstation: mockWorkstation,
  projects: mockProjects,
  cameras: [],
  cards: [],
  volumes: [],
  tasks: [],
  selectedProjectId: mockProjects[0].id,
};

function selectedRow() {
  return screen.getAllByRole("option").find((el) => el.getAttribute("aria-selected") === "true");
}

describe("项目列表", () => {
  it("每个项目一行，显示项目夹名与工况", () => {
    render(<App preloaded={preloaded} />);
    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(mockProjects.length);
    expect(rows[0].textContent).toContain("20260824_校运会");
    expect(rows[0].textContent).toContain("B 拍照");
  });

  it("↓ 键把选中项移到下一行，↑ 键移回", () => {
    render(<App preloaded={preloaded} />);
    const list = screen.getByRole("listbox", { name: "项目列表" });

    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(selectedRow()?.textContent).toContain(mockProjects[1].folderName);

    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(selectedRow()?.textContent).toContain(mockProjects[0].folderName);
  });

  it("End 跳到最后一行，Home 跳回第一行", () => {
    render(<App preloaded={preloaded} />);
    const list = screen.getByRole("listbox", { name: "项目列表" });

    fireEvent.keyDown(list, { key: "End" });
    const last = mockProjects[mockProjects.length - 1];
    expect(selectedRow()?.textContent).toContain(last.folderName);

    fireEvent.keyDown(list, { key: "Home" });
    expect(selectedRow()?.textContent).toContain(mockProjects[0].folderName);
  });

  it("详情区跟随选中项，展示该工况的目录结构", () => {
    render(<App preloaded={preloaded} />);
    const detail = screen.getByLabelText("项目详情");

    // 工况 B 项目：显示待分类
    expect(detail.textContent).toContain("1. 待分类");
    expect(detail.textContent).toContain("2026-08-24");

    const list = screen.getByRole("listbox", { name: "项目列表" });
    fireEvent.keyDown(list, { key: "ArrowDown" });

    // 工况 A 项目：显示六个固定夹
    expect(detail.textContent).toContain("6. 成片");
    expect(detail.textContent).not.toContain("1. 待分类");
  });

  it("点击一行即选中它", () => {
    render(<App preloaded={preloaded} />);
    const rows = screen.getAllByRole("option");
    fireEvent.click(rows[2]);
    expect(rows[2].getAttribute("aria-selected")).toBe("true");
    expect(rows[0].getAttribute("aria-selected")).toBe("false");
  });
});

describe("当前项目的显性指示(UX 波)", () => {
  it("当前行显示「当前项目」黄标,其余行显示「切换到此项目」按钮", () => {
    render(<App preloaded={preloaded} />);
    expect(screen.getByTestId("project-current-flag")).toBeDefined();
    expect(screen.getAllByTestId("project-switch")).toHaveLength(
      mockProjects.length - 1,
    );
  });

  it("点「切换到此项目」把该行设为当前,黄标随之移动", () => {
    render(<App preloaded={preloaded} />);
    const buttons = screen.getAllByTestId("project-switch");
    fireEvent.click(buttons[0]);

    const rows = screen.getAllByRole("option");
    const flaggedRow = rows.find((r) =>
      r.querySelector('[data-testid="project-current-flag"]'),
    );
    expect(flaggedRow?.textContent).toContain(mockProjects[1].folderName);
  });

  it("顶栏正中常驻当前项目名,点击回项目列表", () => {
    render(<App preloaded={{ ...preloaded, route: "devices" as const }} />);
    const chip = screen.getByTestId("current-project-chip");
    expect(chip.textContent).toContain(mockProjects[0].name);

    fireEvent.click(chip);
    expect(screen.getByRole("listbox", { name: "项目列表" })).toBeDefined();
  });

  it("没有选中项目时顶栏指示为「未选择项目」", () => {
    render(<App preloaded={{ ...preloaded, selectedProjectId: null }} />);
    expect(screen.getByTestId("current-project-chip").textContent).toContain(
      "未选择项目",
    );
  });
});
