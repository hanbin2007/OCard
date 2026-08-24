/** 交付打包：确认流程、结果面板、重跑文案、部分失败的界面内可见性。 */

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import * as api from "../api";
import { mockDelivery, mockProjects, mockWorkstation } from "../api/mock";
import type { DeliverySummary } from "../api/types";

afterEach(cleanup);

const preloaded = {
  route: "sorting" as const,
  workstation: mockWorkstation,
  projects: mockProjects,
  selectedProjectId: mockProjects[0].id,
};

async function openWorkbench() {
  const user = userEvent.setup();
  render(<App preloaded={preloaded} />);
  await screen.findAllByTestId("asset-cell");
  return user;
}

describe("交付打包", () => {
  it("入口在工作台顶栏，点开先出确认对话框", async () => {
    const user = await openWorkbench();
    const spy = vi.spyOn(api, "buildDelivery");

    await user.click(screen.getByTestId("delivery-open"));

    const dialog = screen.getByRole("alertdialog");
    // 确认文案要讲清纳入范围、复制语义、上传仍需人工
    expect(dialog.textContent).toContain("精选/已修");
    expect(dialog.textContent).toContain("待分类与待修不交付");
    expect(dialog.textContent).toContain("不改动分类夹里的原件");
    expect(dialog.textContent).toContain("上传网盘与发送链接仍需人工完成");
    // 确认前绝不动手
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("取消则不打包", async () => {
    const user = await openWorkbench();
    const spy = vi.spyOn(api, "buildDelivery");

    await user.click(screen.getByTestId("delivery-open"));
    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("delivery-result")).toBeNull();
    spy.mockRestore();
  });

  it("执行中按钮禁用并显示进行中", async () => {
    const user = await openWorkbench();
    // 不写 `= null` 初值：否则 TS 会把它窄化成 null，闭包里的赋值追踪不到
    let finish: ((s: DeliverySummary) => void) | undefined;
    const spy = vi
      .spyOn(api, "buildDelivery")
      .mockImplementation(
        () =>
          new Promise<DeliverySummary>((resolve) => {
            finish = resolve;
          }),
      );

    await user.click(screen.getByTestId("delivery-open"));
    await user.click(screen.getByRole("button", { name: "开始打包" }));

    const button = screen.getByTestId("delivery-open") as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(button.textContent).toContain("打包中");

    finish?.(mockDelivery);
    await screen.findByTestId("delivery-result");
    spy.mockRestore();
  });

  it("结果面板逐包列出名称/文件数/容量与合计", async () => {
    const user = await openWorkbench();
    await user.click(screen.getByTestId("delivery-open"));
    await user.click(screen.getByRole("button", { name: "开始打包" }));

    await screen.findByTestId("delivery-result");
    const packages = screen.getAllByTestId("delivery-package");
    expect(packages).toHaveLength(mockDelivery.packages.length);
    expect(packages[0].textContent).toContain("0824上午");
    expect(packages[0].textContent).toContain("412");

    const total = screen.getByTestId("delivery-total");
    expect(total.textContent).toContain(String(mockDelivery.totalFiles));
  });

  it("重跑跳过说成「此前已打包」并解释零覆盖，不当成事故", async () => {
    const user = await openWorkbench();
    await user.click(screen.getByTestId("delivery-open"));
    await user.click(screen.getByRole("button", { name: "开始打包" }));

    await screen.findByTestId("delivery-result");
    const headline = screen.getByTestId("delivery-headline");
    expect(headline.textContent).toContain("此前已打包，本次跳过");
    expect(headline.textContent).not.toContain("失败");

    const existing = screen.getByTestId("delivery-existing");
    expect(existing.textContent).toContain("绝不覆盖已有交付文件");
    expect(existing.textContent).toContain("重复打包是安全的");
    // 只有「已存在」时不该出现真失败区块
    expect(screen.queryByTestId("delivery-errors")).toBeNull();
  });

  it("真失败在界面内直接列出，不只藏在铃铛里", async () => {
    const user = await openWorkbench();
    const spy = vi.spyOn(api, "buildDelivery").mockResolvedValue({
      ...mockDelivery,
      failures: [
        { assetId: "5. 其他/DSC_1.JPG", message: "磁盘空间不足", kind: "error" },
        { assetId: "5. 其他/DSC_2.JPG", message: "目标已存在", kind: "already-exists" },
      ],
    });

    await user.click(screen.getByTestId("delivery-open"));
    await user.click(screen.getByRole("button", { name: "开始打包" }));

    await screen.findByTestId("delivery-result");
    const errors = screen.getByTestId("delivery-errors");
    expect(errors.getAttribute("role")).toBe("alert");
    expect(errors.textContent).toContain("磁盘空间不足");
    expect(errors.textContent).toContain("DSC_1.JPG");
    // 两类分开统计，不混为一谈
    expect(errors.textContent).toContain("1 个文件打包失败");
    expect(screen.getByTestId("delivery-existing").textContent).toContain("1 个文件");
    spy.mockRestore();
  });

  it("交付目录等宽显示，可在文件管理器中定位", async () => {
    const user = await openWorkbench();
    const revealSpy = vi.spyOn(api, "revealPath").mockResolvedValue(undefined);

    await user.click(screen.getByTestId("delivery-open"));
    await user.click(screen.getByRole("button", { name: "开始打包" }));
    await screen.findByTestId("delivery-result");

    expect(screen.getByTestId("delivery-path").textContent).toBe(
      mockDelivery.deliveryPath,
    );
    await user.click(screen.getByTestId("delivery-reveal"));
    expect(revealSpy).toHaveBeenCalledWith(mockDelivery.deliveryPath);
    revealSpy.mockRestore();
  });

  it("结果面板提醒上传仍需人工", async () => {
    const user = await openWorkbench();
    await user.click(screen.getByTestId("delivery-open"));
    await user.click(screen.getByRole("button", { name: "开始打包" }));

    const result = await screen.findByTestId("delivery-result");
    expect(within(result).getByText(/上传网盘与发送链接需人工完成/)).toBeDefined();
  });

  it("打包整体失败时给出错误面板并送进通知中心", async () => {
    const user = await openWorkbench();
    const spy = vi
      .spyOn(api, "buildDelivery")
      .mockRejectedValue(new Error("NAS 只读，无法写入交付目录"));

    await user.click(screen.getByTestId("delivery-open"));
    await user.click(screen.getByRole("button", { name: "开始打包" }));

    const err = await screen.findByTestId("delivery-error");
    expect(err.textContent).toContain("NAS 只读");

    await user.click(screen.getByTestId("delivery-close"));
    await user.click(screen.getByTestId("notice-bell"));
    expect(screen.getByTestId("notice-item").getAttribute("data-code")).toBe(
      "delivery-failed",
    );
    spy.mockRestore();
  });
});
