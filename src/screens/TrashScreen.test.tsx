/** 回收站：恢复、清空（唯一真正物理删除的入口，必须不可逆确认）。 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import * as api from "../api";
import { mockProjects, mockTrash, mockWorkstation } from "../api/mock";

afterEach(cleanup);

const preloaded = {
  route: "trash" as const,
  workstation: mockWorkstation,
  projects: mockProjects,
  selectedProjectId: mockProjects[0].id,
};

describe("回收站", () => {
  it("列出已删除素材及其原位置", async () => {
    render(<App preloaded={preloaded} />);

    const rows = await screen.findAllByTestId("trash-row");
    expect(rows).toHaveLength(mockTrash.length);
    expect(rows[0].textContent).toContain(mockTrash[0].fileName);
    expect(rows[0].textContent).toContain("1. 待分类/");
  });

  it("说明文案讲清只有清空才会物理删除", async () => {
    render(<App preloaded={preloaded} />);
    await screen.findAllByTestId("trash-row");
    expect(screen.getByText(/只有「清空回收站」才会真正物理删除/)).toBeDefined();
  });

  it("恢复调用后端并刷新列表", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "restoreFromTrash");
    render(<App preloaded={preloaded} />);
    await screen.findAllByTestId("trash-row");

    await user.click(screen.getAllByTestId("trash-restore")[0]);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][1]).toEqual([mockTrash[0].id]);
    spy.mockRestore();
  });

  it("恢复失败经通知中心报出来，不静默", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, "restoreFromTrash")
      .mockResolvedValue({
        succeeded: [],
        failed: [{ assetId: mockTrash[0].id, message: "原位置已存在同名文件" }],
      });

    render(<App preloaded={preloaded} />);
    await screen.findAllByTestId("trash-row");
    await user.click(screen.getAllByTestId("trash-restore")[0]);

    await waitFor(() => expect(screen.getByTestId("notice-bell")).toBeDefined());
    await user.click(screen.getByTestId("notice-bell"));
    const item = screen.getByTestId("notice-item");
    expect(item.getAttribute("data-code")).toBe("trash-restore-failed");
    expect(item.textContent).toContain("原位置已存在同名文件");
    spy.mockRestore();
  });

  it("清空必须走不可逆确认，取消则不删", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "emptyTrash");
    render(<App preloaded={preloaded} />);
    await screen.findAllByTestId("trash-row");

    await user.click(screen.getByTestId("trash-empty"));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("无法恢复");
    expect(dialog.textContent).toContain("唯一会真正物理删除");

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("trash-row")).toHaveLength(mockTrash.length);
    spy.mockRestore();
  });

  it("确认后才清空", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "emptyTrash");
    render(<App preloaded={preloaded} />);
    await screen.findAllByTestId("trash-row");

    await user.click(screen.getByTestId("trash-empty"));
    await user.click(screen.getByRole("button", { name: "永久删除" }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    spy.mockRestore();
  });

  it("#16 读取失败显示错误与重试，绝不渲染成「回收站是空的」", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, "listTrash")
      .mockRejectedValueOnce(new Error("NAS 不可达"));

    render(<App preloaded={preloaded} />);

    const err = await screen.findByTestId("trash-load-error");
    expect(err.textContent).toContain("NAS 不可达");
    expect(err.textContent).toContain("这不代表回收站是空的");
    expect(screen.queryByText("回收站是空的。")).toBeNull();
    // 读不到时也不该让人去点「清空」
    expect(screen.queryAllByTestId("trash-row")).toHaveLength(0);

    spy.mockRestore();
    await user.click(screen.getByTestId("trash-retry"));
    await screen.findAllByTestId("trash-row");
    expect(screen.queryByTestId("trash-load-error")).toBeNull();
  });

  it("#1 清空后重新拉取列表：失败项会保留在回收站里", async () => {
    const user = userEvent.setup();
    const empty = vi
      .spyOn(api, "emptyTrash")
      .mockResolvedValue({ removed: 1, failed: 1 });
    // 清空后后端仍留着删不掉的那条
    const list = vi
      .spyOn(api, "listTrash")
      .mockResolvedValueOnce(mockTrash)
      .mockResolvedValue([mockTrash[1]]);

    render(<App preloaded={preloaded} />);
    await screen.findAllByTestId("trash-row");

    await user.click(screen.getByTestId("trash-empty"));
    await user.click(screen.getByRole("button", { name: "永久删除" }));

    await waitFor(() => expect(empty).toHaveBeenCalledTimes(1));
    // 关键：清空之后要重新拉，失败项如实留在列表里
    await waitFor(() => expect(screen.getAllByTestId("trash-row")).toHaveLength(1));
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);

    empty.mockRestore();
    list.mockRestore();
  });

  it("回收站为空时禁用清空按钮", async () => {
    const spy = vi.spyOn(api, "listTrash").mockResolvedValue([]);
    render(<App preloaded={preloaded} />);

    await screen.findByText("回收站是空的。");
    expect((screen.getByTestId("trash-empty") as HTMLButtonElement).disabled).toBe(true);
    spy.mockRestore();
  });
});
