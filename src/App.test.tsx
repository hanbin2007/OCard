/** 外壳：加载态、NAS 断连的错误态与重试、地标结构。 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as api from "./api";
import { mockProjects, mockWorkstation } from "./api/mock";

afterEach(cleanup);

describe("应用外壳", () => {
  it("有唯一的 main 地标与侧栏导航", () => {
    render(<App preloaded={{ route: "projects", projects: mockProjects }} />);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeDefined();
  });

  it("首屏先显示加载态，再进入项目列表", async () => {
    render(<App />);
    expect(screen.getByRole("status").textContent).toContain("正在读取");
    expect((await screen.findAllByText("20260824_校运会")).length).toBeGreaterThan(0);
  });

  it("NAS 读取失败时给出错误与重试，而不是永久卡在加载态", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, "listProjects")
      .mockRejectedValueOnce(new Error("NAS 未挂载：/Volumes/DIT-NAS 不可达"));

    render(<App />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("NAS 未挂载");
    expect(screen.getByRole("button", { name: "重试" })).toBeDefined();

    // 重试走通后回到正常界面
    spy.mockRestore();
    await user.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "重试" })).toBeNull(),
    );
    expect((await screen.findAllByText("20260824_校运会")).length).toBeGreaterThan(0);
  });

  it("侧栏可在四屏之间切换", async () => {
    const user = userEvent.setup();
    render(
      <App
        preloaded={{
          route: "projects",
          workstation: mockWorkstation,
          projects: mockProjects,
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: /设备登记/ }));
    expect(screen.getByRole("button", { name: "登记相机" })).toBeDefined();

    await user.click(screen.getByRole("button", { name: /新建项目/ }));
    expect(screen.getByText("将创建")).toBeDefined();
  });
});
