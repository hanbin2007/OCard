/** 路径输入组:原生浏览按钮的可见性、写回与失败提示。 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { NoticeToasts } from "./NotificationCenter";
import { StoreProvider } from "../state/store";
import { PathField } from "./PathField";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(over: Partial<Parameters<typeof PathField>[0]> = {}) {
  const onChange = vi.fn();
  render(
    // PathField 的失败提醒走统一通知通道,需要 Store + toast 渲染面
    <StoreProvider preloaded={{}}>
      <NoticeToasts />
      <PathField
        testId="pf"
        value=""
        onChange={onChange}
        pickerTitle="选择目录"
        {...over}
      />
    </StoreProvider>,
  );
  return { onChange };
}

describe("浏览按钮可见性", () => {
  it("原生对话框不可用(浏览器/测试环境)时不渲染死按钮", () => {
    setup();
    expect(screen.queryByTestId("pf-browse")).toBeNull();
  });

  it("可用时渲染;readOnly(NAS 自动推导行)不渲染", () => {
    vi.spyOn(api, "canPickFolder").mockReturnValue(true);
    setup();
    expect(screen.getByTestId("pf-browse")).toBeDefined();
    cleanup();
    setup({ readOnly: true });
    expect(screen.queryByTestId("pf-browse")).toBeNull();
  });
});

describe("选择与失败", () => {
  it("选到目录后写回 onChange;取消(null)不写", async () => {
    vi.spyOn(api, "canPickFolder").mockReturnValue(true);
    const pick = vi.spyOn(api, "pickFolder").mockResolvedValue("/Volumes/CARD");
    const { onChange } = setup();

    fireEvent.click(screen.getByTestId("pf-browse"));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("/Volumes/CARD"));

    pick.mockResolvedValue(null);
    fireEvent.click(screen.getByTestId("pf-browse"));
    await waitFor(() => expect(pick).toHaveBeenCalledTimes(2));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("对话框打开失败必须可见(统一走 toast),并提示可手填兜底", async () => {
    vi.spyOn(api, "canPickFolder").mockReturnValue(true);
    vi.spyOn(api, "pickFolder").mockRejectedValue(new Error("no display"));
    setup();

    fireEvent.click(screen.getByTestId("pf-browse"));
    const toast = await screen.findByTestId("notice-toasts");
    expect(toast.textContent).toContain("文件夹选择器打开失败");
    expect(toast.textContent).toContain("请直接粘贴路径");
  });

  it("已填合法绝对路径时作为 defaultPath 传给对话框;半截串不传", async () => {
    vi.spyOn(api, "canPickFolder").mockReturnValue(true);
    const pick = vi.spyOn(api, "pickFolder").mockResolvedValue(null);

    setup({ value: "/Volumes/ARCHIVE" });
    fireEvent.click(screen.getByTestId("pf-browse"));
    await waitFor(() =>
      expect(pick).toHaveBeenCalledWith({
        title: "选择目录",
        defaultPath: "/Volumes/ARCHIVE",
      }),
    );

    cleanup();
    setup({ value: "还没打完的相对串" });
    fireEvent.click(screen.getByTestId("pf-browse"));
    await waitFor(() =>
      expect(pick).toHaveBeenLastCalledWith({ title: "选择目录" }),
    );
  });
});
