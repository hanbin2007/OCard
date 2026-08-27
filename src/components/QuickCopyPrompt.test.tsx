/** 快捷拷卡(插卡引导):未登记引导登记、已登记问加入清单、引导创建拷卡任务。 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import App from "../App";
import {
  IDLE_PROMPT_MS,
  IDLE_TICK_MS,
  PROMPT_GRACE_MS,
} from "./SessionGuard";
import {
  mockCameras,
  mockCopyTasks,
  mockProjects,
  mockStorageCards,
  mockVolumes,
  mockWorkstation,
} from "../api/mock";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const base = {
  route: "projects" as const,
  workstation: mockWorkstation,
  projects: mockProjects,
  cameras: mockCameras,
  cards: mockStorageCards,
  volumes: mockVolumes,
  tasks: mockCopyTasks,
  jobs: [],
  selectedProjectId: mockProjects[0].id,
};

describe("快捷拷卡引导", () => {
  it("未登记卡:提示登记,「去登记」跳设备屏并预填绑定卷与卡标签", async () => {
    const user = userEvent.setup();
    // vol-untitled-3(NO NAME)没有 matchedCardId = 未登记
    render(<App preloaded={{ ...base, quickCopyQueue: ["vol-untitled-3"] }} />);

    const prompt = screen.getByTestId("quick-copy-prompt");
    expect(prompt.textContent).toContain("检测到未登记的卡");
    expect(prompt.textContent).toContain("NO NAME");

    await user.click(screen.getByTestId("qc-register"));
    // 到设备屏,浮层收起,卡面标签预填为卷名
    await waitFor(() =>
      expect(
        (screen.getByLabelText("卡面标签") as HTMLInputElement).value,
      ).toBe("NO NAME"),
    );
    expect(screen.queryByTestId("quick-copy-prompt")).toBeNull();
  });

  it("已登记卡不在当前项目清单:「去拷卡」立即导航,清单后台自动并入(评审 1.4)", async () => {
    const user = userEvent.setup();
    // mockResolvedValue 而非 call-through:真实 mock 实现会持久污染
    // 模块级 mockProjectCards,用例顺序一换就翻(评审 P2)
    const addSpy = vi.spyOn(api, "addProjectCard").mockResolvedValue({
      cardIds: ["card-sd-03"],
      copiedCardIds: [],
    });
    // mockProjects[1] 没有配置用卡清单 → card-sd-03 不在清单里
    render(
      <App
        preloaded={{
          ...base,
          selectedProjectId: mockProjects[1].id,
          quickCopyQueue: ["vol-untitled-1"],
        }}
      />,
    );

    const prompt = screen.getByTestId("quick-copy-prompt");
    expect(prompt.textContent).toContain("检测到已登记卡「SD-03」");

    // 只有一个主按钮,不再有「加入清单并拷卡/不加入」二选一
    expect(screen.queryByTestId("qc-add-and-copy")).toBeNull();
    await user.click(screen.getByTestId("qc-copy"));

    // 落在拷卡屏:卷已预选,相机按匹配卡带出;清单在后台补记
    await waitFor(() => {
      const selected = screen
        .getAllByTestId("copy-volume-option")
        .find((el) => el.getAttribute("aria-checked") === "true");
      expect(selected?.textContent).toContain("SONY_A7M4");
    });
    expect(screen.getByTestId("copy-camera-select").textContent).toContain(
      "A7M4",
    );
    expect(screen.queryByTestId("quick-copy-prompt")).toBeNull();
    await waitFor(() =>
      expect(addSpy).toHaveBeenCalledWith(mockProjects[1].id, "card-sd-03"),
    );
  });

  it("已登记卡已在清单:不再问加入,「去拷卡」为主操作", async () => {
    const user = userEvent.setup();
    // mockProjects[0] 的清单含 card-sd-03
    render(<App preloaded={{ ...base, quickCopyQueue: ["vol-untitled-1"] }} />);

    await waitFor(() =>
      expect(screen.getByTestId("quick-copy-prompt").textContent).toContain(
        "已在项目",
      ),
    );
    expect(screen.queryByTestId("qc-add-and-copy")).toBeNull();

    await user.click(screen.getByTestId("qc-copy"));
    await waitFor(() => {
      const selected = screen
        .getAllByTestId("copy-volume-option")
        .find((el) => el.getAttribute("aria-checked") === "true");
      expect(selected?.textContent).toContain("SONY_A7M4");
    });
  });

  it("清单读取失败:警告可见但「去拷卡」不被阻塞,可重试(评审 1.4/A2)", async () => {
    const user = userEvent.setup();
    // 持续失败(项目屏的用卡面板也会调它,Once 会被先消费掉)
    const listSpy = vi
      .spyOn(api, "listProjectCards")
      .mockRejectedValue(new Error("NAS 不可达"));
    render(<App preloaded={{ ...base, quickCopyQueue: ["vol-untitled-1"] }} />);

    await waitFor(() =>
      expect(screen.getByTestId("quick-copy-prompt").textContent).toContain(
        "用卡清单暂时读取不到",
      ),
    );
    // 主按钮永远是「去拷卡」且可点:重试的是清单读取,不是拷卡
    expect((screen.getByTestId("qc-copy") as HTMLButtonElement).disabled).toBe(
      false,
    );

    // 故障恢复后重试 → 进入正常口径
    listSpy.mockRestore();
    await user.click(screen.getByTestId("qc-retry"));
    await waitFor(() =>
      expect(screen.getByTestId("quick-copy-prompt").textContent).toContain(
        "已在项目",
      ),
    );
  });

  it("没有当前项目:引导先去选择项目,浮层保留", async () => {
    const user = userEvent.setup();
    render(
      <App
        preloaded={{
          ...base,
          selectedProjectId: null,
          quickCopyQueue: ["vol-untitled-1"],
        }}
      />,
    );

    expect(screen.getByTestId("quick-copy-prompt").textContent).toContain(
      "需要先选择当前操作项目",
    );
    await user.click(screen.getByTestId("qc-goto-projects"));
    // 浮层不消失:选完项目后同一张卡继续引导
    expect(screen.getByTestId("quick-copy-prompt")).toBeDefined();
  });

  it("「忽略」关闭本次提示", async () => {
    const user = userEvent.setup();
    render(<App preloaded={{ ...base, quickCopyQueue: ["vol-untitled-3"] }} />);
    await user.click(screen.getByTestId("qc-ignore"));
    expect(screen.queryByTestId("quick-copy-prompt")).toBeNull();
  });

  it("一次只提示队首一张;处理完自动轮到下一张", async () => {
    const user = userEvent.setup();
    render(
      <App
        preloaded={{
          ...base,
          quickCopyQueue: ["vol-untitled-3", "vol-untitled-2"],
        }}
      />,
    );
    expect(screen.getByTestId("quick-copy-prompt").textContent).toContain(
      "NO NAME",
    );
    await user.click(screen.getByTestId("qc-ignore"));
    // 队列轮转到已登记的 NIKON_Z9(card-sd-06)
    await waitFor(() =>
      expect(screen.getByTestId("quick-copy-prompt").textContent).toContain(
        "SD-06",
      ),
    );
  });

  it("交付打包进行中:引导按钮与侧栏同一把锁", async () => {
    render(
      <App
        preloaded={{
          ...base,
          quickCopyQueue: ["vol-untitled-1"],
          jobs: [
            {
              id: "job-d1",
              kind: "delivery" as const,
              projectId: mockProjects[0].id,
              state: "running" as const,
              done: 1,
              total: 4,
              bytesDone: 0,
              revision: 1,
              startedAt: "2026-08-26T10:00:00+08:00",
            },
          ],
        }}
      />,
    );
    const copyBtn = screen.getByTestId("qc-copy") as HTMLButtonElement;
    expect(copyBtn.disabled).toBe(true);
    expect(copyBtn.title).toContain("交付打包进行中");
  });

  it("登记成功后续接引导:同一张卷以已登记身份重新入队", async () => {
    const user = userEvent.setup();
    const created = {
      ...mockStorageCards[0],
      id: "card-new-1",
      label: "NO NAME",
      cameraId: mockCameras[0].id,
    };
    vi.spyOn(api, "createStorageCard").mockResolvedValue(created);
    vi.spyOn(api, "listVolumes").mockResolvedValue(
      mockVolumes.map((v) =>
        v.id === "vol-untitled-3"
          ? { ...v, matchedCardId: "card-new-1", matchStatus: "matched" as const }
          : v,
      ),
    );
    render(
      <App
        preloaded={{
          ...base,
          selectedProjectId: mockProjects[1].id,
          quickCopyQueue: ["vol-untitled-3"],
        }}
      />,
    );

    await user.click(screen.getByTestId("qc-register"));
    // 设备屏:标签已预填,选相机后提交
    await waitFor(() =>
      expect(
        (screen.getByLabelText("卡面标签") as HTMLInputElement).value,
      ).toBe("NO NAME"),
    );
    await user.click(document.getElementById("card-camera") as HTMLElement);
    await user.click(screen.getAllByRole("option")[0]);
    await user.click(screen.getByRole("button", { name: "登记存储卡" }));

    // 引导续接:浮层以已登记身份回来,主按钮是唯一的「去拷卡」
    await waitFor(() =>
      expect(screen.getByTestId("quick-copy-prompt").textContent).toContain(
        "检测到已登记卡「NO NAME」",
      ),
    );
    expect(screen.getByTestId("qc-copy")).toBeDefined();
  });

  it("会话门开启时浮层整体 inert:键盘也进不去(双路评审 P0)", async () => {
    vi.useFakeTimers();
    try {
      // 拷卡进行中会抑制闲置判定(评审 2.4),这里专门测门,任务清空
      render(
        <App
          preloaded={{ ...base, tasks: [], quickCopyQueue: ["vol-untitled-1"] }}
        />,
      );
      // 15 分钟无操作 → 询问 → 再 5 分钟 → 会话结束,门弹出
      act(() => {
        vi.advanceTimersByTime(IDLE_PROMPT_MS + IDLE_TICK_MS);
      });
      act(() => {
        vi.advanceTimersByTime(PROMPT_GRACE_MS + IDLE_TICK_MS);
      });
      const prompt = screen.getByTestId("quick-copy-prompt");
      expect(prompt.closest("[inert]")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Esc 等同「忽略」", async () => {
    const user = userEvent.setup();
    render(<App preloaded={{ ...base, quickCopyQueue: ["vol-untitled-3"] }} />);
    expect(screen.getByTestId("quick-copy-prompt")).toBeDefined();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("quick-copy-prompt")).toBeNull();
  });

  it("登记表读不到(unavailable):不引导登记,只给重试与忽略", async () => {
    render(
      <App
        preloaded={{
          ...base,
          volumes: mockVolumes.map((v) =>
            v.id === "vol-untitled-3"
              ? { ...v, matchStatus: "unavailable" as const }
              : v,
          ),
          quickCopyQueue: ["vol-untitled-3"],
        }}
      />,
    );
    const prompt = screen.getByTestId("quick-copy-prompt");
    expect(prompt.textContent).toContain("暂时无法核对登记");
    expect(screen.queryByTestId("qc-register")).toBeNull();
    expect(screen.getByTestId("qc-rematch")).toBeDefined();
  });

  it("清单加入失败只出 warning,不拦已经发生的导航(评审 1.4)", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "addProjectCard").mockRejectedValue(new Error("NAS 抖动"));
    render(
      <App
        preloaded={{
          ...base,
          selectedProjectId: mockProjects[1].id,
          quickCopyQueue: ["vol-untitled-1"],
        }}
      />,
    );
    await user.click(screen.getByTestId("qc-copy"));
    // 人已经在拷卡屏
    await waitFor(() =>
      expect(screen.getAllByTestId("copy-volume-option").length).toBeGreaterThan(0),
    );
    // 失败以 warning 出声:不影响拷卡,拷完还有自动并入兜底
    await waitFor(() => {
      const toast = screen.queryByTestId("notice-toast-warning");
      expect(toast?.getAttribute("data-code")).toBe("project-cards-save-failed");
    });
  });
});
