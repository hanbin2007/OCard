import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import App from "../App";
import { mockCameras, mockStorageCards } from "../api/mock";

afterEach(cleanup);

const preloaded = {
  route: "devices" as const,
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

function codePreview() {
  return screen.getByTestId("camera-code-preview").textContent;
}

describe("设备登记", () => {
  it("未填写时编码预览显示占位", () => {
    render(<App preloaded={preloaded} />);
    expect(codePreview()).toBe("型号_机位_代称");
  });

  it("边填边生成规范编码，机位与代称自动大写", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    await user.type(screen.getByLabelText("型号"), "DJI Ronin 4D");
    expect(codePreview()).toBe("型号_机位_代称");

    await user.type(screen.getByLabelText("机位"), "b");
    await user.type(screen.getByLabelText("使用者代称"), "zs");
    expect(codePreview()).toBe("DJIRonin4D_B_ZS");
  });

  it("登记后相机进入列表且编码可见", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    await user.type(screen.getByLabelText("型号"), "Nikon Z9");
    await user.type(screen.getByLabelText("机位"), "e");
    await user.type(screen.getByLabelText("使用者代称"), "cq");
    await user.click(screen.getByRole("button", { name: "登记相机" }));

    // 等相机行出现（行内带删除按钮）
    expect(
      await screen.findByRole("button", { name: "删除相机 Nikon Z9" }),
    ).toBeDefined();
    // 列表行 + 登记回执各出现一次
    expect(screen.getAllByText("NikonZ9_E_CQ").length).toBeGreaterThan(0);
    // 提交后表单清空，预览回到占位
    expect(codePreview()).toBe("型号_机位_代称");
  });

  it("缺机位时拦下并报错，不写入列表", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    await user.type(screen.getByLabelText("型号"), "Sony A7M4");
    await user.type(screen.getByLabelText("使用者代称"), "lm");
    await user.click(screen.getByRole("button", { name: "登记相机" }));

    const alerts = screen.getAllByRole("alert").map((el) => el.textContent);
    expect(alerts.some((t) => t?.includes("机位"))).toBe(true);
    expect(screen.queryByText("SonyA7M4_A_LM")).toBeNull();
  });

  it("删除相机要二次确认，并说明级联影响", async () => {
    const user = userEvent.setup();
    render(
      <App
        preloaded={{
          ...preloaded,
          cameras: mockCameras,
          cards: mockStorageCards,
        }}
      />,
    );

    const target = mockCameras[0];
    const ownedCards = mockStorageCards.filter((c) => c.cameraId === target.id).length;

    await user.click(
      screen.getByRole("button", { name: `删除相机 ${target.model}` }),
    );

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain(target.code);
    expect(dialog.textContent).toContain(`${ownedCards} 张卡`);

    // 取消后相机还在
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getAllByText(target.code).length).toBeGreaterThan(0);
  });

  it("确认后相机与其名下的卡一并移除", async () => {
    const user = userEvent.setup();
    render(
      <App
        preloaded={{
          ...preloaded,
          cameras: mockCameras,
          cards: mockStorageCards,
        }}
      />,
    );

    const target = mockCameras[0];
    await user.click(
      screen.getByRole("button", { name: `删除相机 ${target.model}` }),
    );
    await user.click(screen.getByRole("button", { name: "删除相机" }));

    expect(screen.queryAllByText(target.code)).toHaveLength(0);
    // 名下的卡也一并消失
    expect(screen.queryByText("CFE-01")).toBeNull();
  });

  it("存储卡未选相机时拦下", async () => {
    const user = userEvent.setup();
    render(<App preloaded={preloaded} />);

    await user.type(screen.getByLabelText("卡面标签"), "CFE-01");
    await user.click(screen.getByRole("button", { name: "登记存储卡" }));

    const alerts = screen.getAllByRole("alert").map((el) => el.textContent);
    expect(alerts).toContain("请选择所属相机");
  });
});
