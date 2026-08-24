/**
 * E2E 锚点契约：wdio 用例按 data-testid 选元素，这里逐个断言它们真的渲染得出来。
 * 谁改名字，这个测试先红——不用等 E2E 套件挂掉才发现。
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";
import {
  mockCameras,
  mockCopyTasks,
  mockProjects,
  mockStorageCards,
  mockVolumes,
  mockWorkstation,
} from "./api/mock";

afterEach(cleanup);

const base = {
  workstation: mockWorkstation,
  projects: mockProjects,
  cameras: mockCameras,
  cards: mockStorageCards,
  volumes: mockVolumes,
  tasks: mockCopyTasks,
  selectedProjectId: mockProjects[0].id,
  selectedTaskId: mockCopyTasks[0].id,
};

function expectAnchors(ids: string[]) {
  for (const id of ids) {
    expect(screen.getAllByTestId(id).length, `缺少 data-testid="${id}"`).toBeGreaterThan(
      0,
    );
  }
}

describe("E2E 锚点", () => {
  it("侧栏导航项 + 设置入口 + 通知铃铛", () => {
    render(<App preloaded={{ ...base, route: "projects" }} />);
    expectAnchors([
      "nav-projects",
      "nav-new-project",
      "nav-devices",
      "nav-copy",
      "nav-sorting",
      "nav-trash",
      "nav-transcode",
      "settings-open",
      "notice-bell",
    ]);
  });

  it("分类工作台锚点", async () => {
    render(<App preloaded={{ ...base, route: "sorting" }} />);
    await screen.findAllByTestId("asset-cell");
    expectAnchors([
      "sorting-categories",
      "sorting-category",
      "sorting-grid-wrap",
      "sorting-remaining",
      "sorting-open-trash",
      "delivery-open",
      "sorting-analyze",
      "sorting-suggestion-filter",
      "virtual-grid",
      "asset-cell",
    ]);
  });

  it("回收站锚点", async () => {
    render(<App preloaded={{ ...base, route: "trash" }} />);
    await screen.findAllByTestId("trash-row");
    expectAnchors(["trash-row", "trash-restore", "trash-empty", "trash-back"]);
  });

  it("项目列表行", () => {
    render(<App preloaded={{ ...base, route: "projects" }} />);
    expectAnchors(["project-row"]);
    expect(screen.getAllByTestId("project-row")).toHaveLength(mockProjects.length);
  });

  it("设置对话框字段", async () => {
    const user = userEvent.setup();
    render(<App preloaded={{ ...base, route: "projects" }} />);
    await user.click(screen.getByTestId("settings-open"));
    expectAnchors(["settings-operator", "settings-nas-root", "settings-save"]);
  });

  it("新建项目向导", () => {
    render(<App preloaded={{ ...base, route: "new-project" }} />);
    expectAnchors([
      "np-date",
      "np-name",
      "np-scenario-a",
      "np-scenario-b",
      "np-category-input",
      "np-submit",
    ]);
  });

  it("设备登记", () => {
    render(<App preloaded={{ ...base, route: "devices" }} />);
    expectAnchors([
      "dev-model",
      "dev-position",
      "dev-alias",
      "dev-code-preview",
      "dev-submit",
      "camera-row",
    ]);
    expect(screen.getAllByTestId("camera-row")).toHaveLength(mockCameras.length);
  });

  it("拷卡面板", () => {
    render(<App preloaded={{ ...base, route: "copy" }} />);
    expectAnchors([
      "copy-volume-select",
      "copy-volume-option",
      "copy-camera-select",
      "copy-note",
      "copy-start",
      "copy-target-preview",
    ]);
    expect(screen.getAllByTestId("copy-volume-option")).toHaveLength(
      mockVolumes.length,
    );
  });

  it("首跑引导锚点（未配置 NAS 根路径时）", () => {
    render(
      <App
        preloaded={{
          ...base,
          route: "projects",
          workstation: { machineId: "WS-NEW", operator: "", nasRoot: "" },
        }}
      />,
    );
    expectAnchors(["first-run-guide", "first-run-open-settings", "settings-open"]);
  });
});
