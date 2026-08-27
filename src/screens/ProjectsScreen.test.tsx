import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import App from "../App";
import { mockProjects, mockStorageCards, mockWorkstation } from "../api/mock";

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

  it("顶栏正中常驻当前项目名,点击弹出原地切换下拉(评审 5.2)", () => {
    render(<App preloaded={{ ...preloaded, route: "devices" as const }} />);
    const chip = screen.getByTestId("current-project-chip");
    expect(chip.textContent).toContain(mockProjects[0].name);

    fireEvent.click(chip);
    // 原地切项目:不跳回列表,直接在下拉里选
    expect(screen.getByTestId("project-switch-menu")).toBeDefined();
    const items = screen.getAllByTestId("project-switch-item");
    expect(items.length).toBe(mockProjects.length);

    fireEvent.click(items[1]);
    // 下拉收起,当前项目切换,人还留在设备屏
    expect(screen.queryByTestId("project-switch-menu")).toBeNull();
    expect(screen.getByTestId("current-project-chip").textContent).toContain(
      mockProjects[1].name,
    );
    expect(screen.getByRole("button", { name: "登记相机" })).toBeDefined();
  });

  it("没有选中项目时顶栏指示为「未选择项目」", () => {
    render(<App preloaded={{ ...preloaded, selectedProjectId: null }} />);
    expect(screen.getByTestId("current-project-chip").textContent).toContain(
      "未选择项目",
    );
  });

  it("交付打包进行中黄标不再禁用(评审 4.3):导航放行,进度由 store 承载", () => {
    render(
      <App
        preloaded={{
          ...preloaded,
          route: "devices" as const,
          jobs: [
            {
              id: "job-d1",
              kind: "delivery" as const,
              projectId: mockProjects[0].id,
              state: "running" as const,
              done: 1,
              total: 4,
              bytesDone: 1024,
              revision: 1,
              startedAt: "2026-08-25T10:00:00+08:00",
            },
          ],
        }}
      />,
    );
    const chip = screen.getByTestId("current-project-chip") as HTMLButtonElement;
    expect(chip.disabled).toBe(false);
  });
});

describe("已拷卡语义(UX 波三:分母=项目用卡清单)", () => {
  it("配了用卡清单的项目显示 x/y 张;未配置的回退按次数并明说", () => {
    render(<App preloaded={preloaded} />);
    // 校运会:清单 6 张、已拷 5 → 5/6 张(分母是真实清单,不是任务数)
    expect(screen.getAllByText(/5\/6 张/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/有未完成任务/).length).toBeGreaterThan(0);
    expect(screen.getByTestId("project-copy-incomplete")).toBeDefined();
    // 未配置清单的项目(年中发布会):N 次 + 未配置用卡
    expect(screen.getAllByText(/^6 次$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/未配置用卡/).length).toBeGreaterThan(0);
  });

  it("详情面板的用卡清单可增删、可套用登记表模板", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, "setProjectCards")
      .mockImplementation((_, ids) =>
        Promise.resolve({ cardIds: ids, copiedCardIds: [] }),
      );
    render(
      <App
        preloaded={{ ...preloaded, cards: mockStorageCards }}
      />,
    );

    // 校运会清单 6 张,全部显示
    const rows = await screen.findAllByTestId("project-card-row");
    expect(rows).toHaveLength(6);
    expect(screen.getAllByText("已拷")).toHaveLength(5);

    // 移除一张
    await user.click(
      screen.getByRole("button", { name: "移出用卡清单 CFE-01" }),
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][1]).not.toContain("card-cfe-01");
    // 等保存落定(busy 复位、清单变 5 张)再做下一步
    await waitFor(() =>
      expect(screen.getAllByTestId("project-card-row")).toHaveLength(5),
    );

    // 套用模板 = 登记表全部卡
    await user.click(screen.getByTestId("cards-apply-template"));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1][1]).toHaveLength(mockStorageCards.length);
    spy.mockRestore();
  });
});
