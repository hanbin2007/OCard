/**
 * 欢迎/项目管理窗口(启动重构):
 *   ① 首跑先见首次设置向导,配完进欢迎页;
 *   ② 欢迎页 = 新建项目 + 最近项目 + 所有项目;
 *   ③ 点最近项目走「打开项目」通道并记最近;
 *   ④ 新项目引导:六步走完,建项目 + 写用卡清单 + 写标签/备份预设,
 *      然后经窗口桥接打开主窗口。
 */

import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import {
  mockCameras,
  mockProjects,
  mockStorageCards,
  mockWorkstation,
} from "../api/mock";
import type { Project } from "../api/types";
import type { useStore } from "../state/store";
import { renderWelcome } from "../testUtils";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const base = {
  route: "copy" as const,
  workstation: mockWorkstation,
  projects: mockProjects,
  cameras: mockCameras,
  cards: mockStorageCards,
  volumes: [],
  tasks: [],
  selectedProjectId: mockProjects[0].id,
};

describe("首跑设置并入欢迎窗口", () => {
  it("操作人/NAS 根任一未配时整窗显示首次设置向导", () => {
    renderWelcome({
      ...base,
      workstation: {
        machineId: "WS-NEW",
        operator: "",
        nasRoot: "",
        recentProjects: [],
      },
    });
    expect(screen.getByTestId("first-run-guide")).toBeDefined();
    expect(screen.queryByTestId("welcome-home")).toBeNull();
  });
});

describe("欢迎页(仿 Xcode)", () => {
  it("左侧主操作 + 右侧最近项目列表", () => {
    renderWelcome(base);
    expect(screen.getByTestId("welcome-new-project")).toBeDefined();
    expect(screen.getByTestId("welcome-browse-all")).toBeDefined();
    // mock 工作站带两条最近打开
    expect(screen.getAllByTestId("welcome-recent")).toHaveLength(
      mockWorkstation.recentProjects.length,
    );
  });

  it("没有最近项目时给空态文案", () => {
    renderWelcome({
      ...base,
      workstation: { ...mockWorkstation, recentProjects: [] },
    });
    expect(screen.getByTestId("welcome-recents").textContent).toContain(
      "还没有最近打开的项目",
    );
  });

  it("点最近项目走「打开项目」通道", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "openProjectInMain").mockResolvedValue(undefined);
    renderWelcome(base);

    await user.click(screen.getAllByTestId("welcome-recent")[0]);
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(mockWorkstation.recentProjects[0].id),
    );
  });

  it("打开失败必须出声(最近列表可能指向已删除的项目)", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "openProjectInMain").mockRejectedValue(
      new Error("项目不存在: p-gone"),
    );
    renderWelcome(base);

    await user.click(screen.getAllByTestId("welcome-recent")[0]);
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some((el) => el.textContent?.includes("项目不存在")),
      ).toBe(true),
    );
  });

  it("「所有项目」切到项目管理视图,可返回欢迎页", async () => {
    const user = userEvent.setup();
    renderWelcome(base);

    await user.click(screen.getByTestId("welcome-browse-all"));
    expect(screen.getAllByTestId("project-row").length).toBeGreaterThan(0);

    await user.click(screen.getByTestId("welcome-back"));
    expect(screen.getByTestId("welcome-home")).toBeDefined();
  });

  /** CSS 那一半由 tokens 契约测试锁住;这里锁属性那一半——删掉 data-topbar,
   *  toast 就永久压回铃铛上,而 CSS 测试照样绿。 */
  it("只有真的渲染了顶栏的项目管理视图才打 data-topbar", async () => {
    const user = userEvent.setup();
    renderWelcome(base);
    const shell = () => screen.getByTestId("welcome-root");
    expect(shell().hasAttribute("data-topbar"), "首页没有顶栏").toBe(false);

    await user.click(screen.getByTestId("welcome-browse-all"));
    expect(shell().getAttribute("data-view")).toBe("manager");
    expect(shell().hasAttribute("data-topbar"), "项目管理视图有顶栏").toBe(true);

    await user.click(screen.getByTestId("welcome-back"));
    expect(shell().hasAttribute("data-topbar")).toBe(false);
  });

  /** 真正被修的判据:view 是 manager 但正在加载 / 出错时渲染的是卡片,没有顶栏。
   *  只走「首页 → manager → 返回」的用例里 hasTopBar 恒等于 view === "manager",
   *  把判据改回去照样绿。 */
  it("manager 视图里加载中 / 出错时没有顶栏,也就不打 data-topbar", async () => {
    const user = userEvent.setup();
    let dispatch: ReturnType<typeof useStore>["dispatch"] | null = null;
    renderWelcome(base, (s) => {
      dispatch = s.dispatch;
    });
    const shell = () => screen.getByTestId("welcome-root");
    await user.click(screen.getByTestId("welcome-browse-all"));
    expect(shell().hasAttribute("data-topbar"), "前置:manager 视图有顶栏").toBe(true);

    // 管理视图里改 NAS 根 / 点刷新会触发 reload → loadStarted:渲染的是加载卡片,没有顶栏
    act(() => dispatch!({ type: "loadStarted" }));
    expect(screen.getByRole("status")).toBeDefined();
    expect(shell().getAttribute("data-view"), "view 仍是 manager").toBe("manager");
    expect(shell().hasAttribute("data-topbar"), "加载中没有顶栏").toBe(false);

    act(() => dispatch!({ type: "loadFailed", error: "NAS 不可达" }));
    expect(screen.getByRole("alert")).toBeDefined();
    expect(shell().hasAttribute("data-topbar"), "出错时没有顶栏").toBe(false);
  });
});

describe("新项目引导(六步)", () => {
  async function toWizard(user: ReturnType<typeof userEvent.setup>) {
    renderWelcome(base);
    await user.click(screen.getByTestId("welcome-new-project"));
    await screen.findByTestId("new-project-wizard");
  }

  it("第一步校验不过不放行:项目名为空停在原步", async () => {
    const user = userEvent.setup();
    await toWizard(user);

    await user.click(screen.getByTestId("npw-next"));
    expect(
      screen.getAllByRole("alert").some((el) => el.textContent?.includes("项目名")),
    ).toBe(true);
    expect(screen.getByTestId("np-name")).toBeDefined();
  });

  it("走完六步:建项目 + 用卡清单 + 标签/备份预设 + 打开主窗口", async () => {
    const user = userEvent.setup();
    const created: Project = {
      ...mockProjects[0],
      id: "p-e2e-new",
      name: "引导项目",
      folderName: "20260827_引导项目",
    };
    const createSpy = vi.spyOn(api, "createProject").mockResolvedValue(created);
    const cardsSpy = vi
      .spyOn(api, "setProjectCards")
      .mockResolvedValue({ cardIds: [], copiedCardIds: [] });
    const settingsSpy = vi
      .spyOn(api, "saveProjectSettings")
      .mockImplementation((_id, s) => Promise.resolve(s));
    const openSpy = vi.spyOn(api, "openProjectInMain").mockResolvedValue(undefined);

    await toWizard(user);

    // 1. 项目信息(工况 B 默认分类保留)
    await user.type(screen.getByTestId("np-name"), "引导项目");
    await user.click(screen.getByTestId("npw-next"));

    // 2. 设备登记(已有登记,跳过)
    await screen.findByTestId("npw-dev-model");
    await user.click(screen.getByTestId("npw-next"));

    // 3. 用卡清单:勾第一张卡
    const roster = await screen.findAllByTestId("npw-roster-card");
    await user.click(roster[0]);
    await user.click(screen.getByTestId("npw-next"));

    // 4. 备份目的地(留空跳过)
    await user.click(screen.getByTestId("npw-next"));

    // 5. 内容标签:工况 B 的分类被预填成标签,再手加一个
    expect(screen.getAllByTestId("tag-chip").length).toBeGreaterThan(0);
    await user.type(screen.getByTestId("npw-tag-input"), "花絮");
    await user.click(screen.getByTestId("npw-tag-add"));
    await user.click(screen.getByTestId("npw-next"));

    // 6. 确认创建
    await user.click(screen.getByTestId("np-submit"));

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(createSpy.mock.calls[0][0].name).toBe("引导项目");
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith("p-e2e-new"));
    // 用卡清单与项目设置都随建项目落盘
    expect(cardsSpy).toHaveBeenCalledWith("p-e2e-new", [mockStorageCards[0].id]);
    expect(settingsSpy).toHaveBeenCalledTimes(1);
    const savedSettings = settingsSpy.mock.calls[0][1];
    expect(savedSettings.tags.some((t) => t.name === "花絮")).toBe(true);
  }, 15000);

  it("清单/设置写失败不弃项目:出声提示并仍然打开主窗口", async () => {
    const user = userEvent.setup();
    const created: Project = { ...mockProjects[0], id: "p-e2e-warn", name: "波折" };
    vi.spyOn(api, "createProject").mockResolvedValue(created);
    vi.spyOn(api, "saveProjectSettings").mockRejectedValue(new Error("NAS 抖动"));
    const openSpy = vi.spyOn(api, "openProjectInMain").mockResolvedValue(undefined);

    await toWizard(user);
    await user.type(screen.getByTestId("np-name"), "波折");
    // 快进到确认步(2-5 步全跳过)
    for (let i = 0; i < 5; i += 1) {
      await user.click(screen.getByTestId("npw-next"));
    }
    // 工况 B 分类会被预填成标签 → 设置保存会被触发并失败
    await user.click(screen.getByTestId("np-submit"));

    // warning 级 toast 不走 role=alert:按文案找
    expect(
      await screen.findByText(/标签\/备份预设保存失败/, {}, { timeout: 3000 }),
    ).toBeDefined();
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith("p-e2e-warn"));
  }, 15000);
});
