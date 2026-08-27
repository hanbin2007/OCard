/**
 * 审计日志抽屉。
 *
 * 断言分三类：
 *   ① 渲染与过滤——列表按 mock 时间线出来，chips 与快捷过滤所见即所得；
 *   ② 防御性——未收录的 kind、空 data、损坏行都要显示出来而不是把界面炸掉；
 *   ③ 零静默 + 键盘可达——读取失败如实展示后端原文并可重试，
 *      Esc 能关、焦点圈不外泄、关闭后焦点还给入口按钮。
 */

import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderProjectsManager } from "../testUtils";
import * as api from "../api";
import { mockAuditLog, mockProjects, mockWorkstation } from "../api/mock";
import { toAuditRows } from "../lib/audit";
import { formatTimestamp } from "../lib/format";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const preloaded = {
  route: "copy" as const,
  workstation: mockWorkstation,
  projects: mockProjects,
  cameras: [],
  cards: [],
  volumes: [],
  tasks: [],
  selectedProjectId: mockProjects[0].id,
};

/** 后端返回值的类型出口，供注入畸形数据时借道 */
type AuditReply = Awaited<ReturnType<typeof api.listAuditLog>>;

/** 打开抽屉并等首屏落地（列表 / 空态 / 错误任一） */
async function openDrawer() {
  const user = userEvent.setup();
  renderProjectsManager(preloaded);
  await user.click(screen.getByTestId("audit-open"));
  await screen.findByTestId("audit-log-drawer");
  await waitFor(() => expect(screen.queryByTestId("audit-loading")).toBeNull());
  return user;
}

function items() {
  return screen.queryAllByTestId("audit-item");
}

function bodyText() {
  return screen.getByTestId("audit-log-body").textContent ?? "";
}

function itemByKind(kind: string): HTMLElement {
  const found = items().find((el) => el.getAttribute("data-kind") === kind);
  if (!found) throw new Error(`列表里没有 kind=${kind} 的事件`);
  return found;
}

function groupChip(group: string): HTMLElement {
  const found = screen
    .getAllByTestId("audit-filter")
    .find((el) => el.getAttribute("data-group") === group);
  if (!found) throw new Error(`没有 ${group} 这个过滤 chip`);
  return found;
}

describe("审计日志入口", () => {
  it("项目详情面板有入口，未打开时抽屉不存在", () => {
    renderProjectsManager(preloaded);
    const entry = screen.getByTestId("audit-open");
    expect(entry.textContent).toBe("审计日志");
    expect(entry.getAttribute("aria-haspopup")).toBe("dialog");
    expect(entry.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("audit-log-drawer")).toBeNull();
  });

  it("点击后弹出模态抽屉，抬头带项目夹名", async () => {
    await openDrawer();
    const drawer = screen.getByTestId("audit-log-drawer");
    expect(drawer.getAttribute("role")).toBe("dialog");
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    expect(
      document.getElementById(drawer.getAttribute("aria-labelledby") ?? "")?.textContent,
    ).toBe("审计日志");
    expect(drawer.textContent).toContain(mockProjects[0].folderName);
    expect(screen.getByTestId("audit-open").getAttribute("aria-expanded")).toBe("true");
  });

  it("切换项目时抽屉自动收起，不会拿着上一个项目的时间线不放", async () => {
    await openDrawer();
    fireEvent.keyDown(screen.getByRole("listbox", { name: "项目列表" }), {
      key: "ArrowDown",
    });
    expect(screen.queryByTestId("audit-log-drawer")).toBeNull();
  });
});

describe("事件列表", () => {
  it("mock 时间线逐条渲染，最新在前", async () => {
    await openDrawer();
    const rows = items();
    expect(rows).toHaveLength(mockAuditLog.length);
    expect(rows[0].getAttribute("data-kind")).toBe(mockAuditLog[0].kind);
    expect(rows[rows.length - 1].getAttribute("data-kind")).toBe(
      mockAuditLog[mockAuditLog.length - 1].kind,
    );
  });

  it("时间是 MM-DD HH:mm，datetime 留原始时间戳", async () => {
    await openDrawer();
    const time = within(items()[0]).getByTestId("audit-time");
    expect(time.textContent).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(time.textContent).toBe(formatTimestamp(mockAuditLog[0].ts));
    expect(time.getAttribute("datetime")).toBe(mockAuditLog[0].ts);
  });

  it("kind 显示中文标签，并带对应语气色", async () => {
    await openDrawer();
    const done = itemByKind("copy_completed");
    expect(done.textContent).toContain("拷卡完成");
    expect(done.getAttribute("data-tone")).toBe("ok");
    expect(done.querySelector(".badge--ok")).not.toBeNull();

    const failed = itemByKind("copy_file_failed");
    expect(failed.textContent).toContain("单文件拷贝失败");
    expect(failed.querySelector(".badge--danger")).not.toBeNull();

    const cancelled = itemByKind("transcode_cancelled");
    expect(cancelled.textContent).toContain("转码已取消");
    expect(cancelled.querySelector(".badge--warn")).not.toBeNull();

    // 进行中是中性：不占用绿/红/琥珀这三档语气
    const started = itemByKind("copy_started");
    expect(started.getAttribute("data-tone")).toBe("neutral");
    expect(started.querySelector(".badge--ok")).toBeNull();
  });

  it("操作人@机器成对显示，他机事件另有标记", async () => {
    await openDrawer();
    const marked = items().filter(
      (el) => within(el).queryByTestId("audit-remote") !== null,
    );
    expect(marked.length).toBeGreaterThan(0);
    expect(marked[0].textContent).toContain("他机");

    // 本机事件不该被误标
    const local = itemByKind("copy_file_failed");
    expect(within(local).queryByTestId("audit-remote")).toBeNull();
    expect(within(local).getByTestId("audit-who").textContent).toContain(
      mockWorkstation.machineId,
    );
    expect(within(local).getByTestId("audit-who").textContent).toContain(
      mockWorkstation.operator,
    );
  });

  it("关键明细挑得出成功/失败数、包数与编码器", async () => {
    await openDrawer();
    const copy = within(itemByKind("copy_completed")).getByTestId("audit-detail");
    expect(copy.textContent).toContain("成功");
    expect(copy.textContent).toContain("失败");
    // 一行放不下的部分挂在 title 上，不算丢
    expect(copy.getAttribute("title")).toContain("成功");

    expect(
      within(itemByKind("delivery_built")).getByTestId("audit-detail").textContent,
    ).toContain("包数");
    const transcode = within(itemByKind("transcode_completed")).getByTestId(
      "audit-detail",
    ).textContent;
    expect(transcode).toContain("编码器");
    expect(transcode).toContain("h264_videotoolbox");

    // 模式/档位这类枚举值译成人话，不把 archive / balanced 甩给用户
    const archive = within(itemByKind("transcode_started")).getByTestId("audit-detail")
      .textContent;
    expect(archive).toContain("归档");
    expect(archive).toContain("均衡");
  });

  it("失败事件把后端原文摆出来，不只给一个红角标", async () => {
    await openDrawer();
    expect(
      within(itemByKind("transcode_failed")).getByTestId("audit-detail").textContent,
    ).toContain("unsupported pixel format");
    expect(
      within(itemByKind("copy_file_failed")).getByTestId("audit-detail").textContent,
    ).toContain("读取超时");
  });
});

describe("防御性渲染", () => {
  it("未收录的 kind 照常显示原始值，不消失也不炸", async () => {
    await openDrawer();
    const unknown = itemByKind("project_note_added");
    expect(unknown.textContent).toContain("project_note_added");
    // 等宽呈现，一眼看出这是机器名不是人话
    expect(unknown.querySelector(".badge--mono")).not.toBeNull();
    // 陌生结构也要露出生键值，不留空白
    expect(within(unknown).getByTestId("audit-detail").textContent).toContain("note");
  });

  it("data 为 null 的记录显示「无附加明细」，行本身不缺", async () => {
    await openDrawer();
    expect(screen.getAllByTestId("audit-detail-none").length).toBeGreaterThan(0);
  });

  it("后端返回一批畸形记录时整个抽屉照常可用", async () => {
    const garbage = [
      null,
      42,
      "boom",
      [],
      {},
      { ts: "not-a-date", kind: "copy_started", data: { nested: { deep: {} } } },
      { kind: 7, machine: null, operator: undefined, data: [1, 2, 3] },
    ];
    vi.spyOn(api, "listAuditLog").mockResolvedValue(garbage as unknown as AuditReply);

    await openDrawer();
    expect(items()).toHaveLength(garbage.length);
    const text = screen.getByTestId("audit-list").textContent ?? "";
    expect(text).not.toContain("[object Object]");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("NaN");
    expect(text).toContain("未知事件");
    expect(text).toContain("未署名");
    expect(text).toContain("未知机器");
  });

  it("返回值根本不是数组时走空态，而不是白屏", async () => {
    vi.spyOn(api, "listAuditLog").mockResolvedValue({ items: [] } as unknown as AuditReply);
    await openDrawer();
    expect(items()).toHaveLength(0);
    expect(bodyText()).toContain("还没有任何业务事件");
  });
});

describe("过滤", () => {
  it("分组 chip 只留该环节的事件，chip 上的计数就是筛出的条数", async () => {
    const user = await openDrawer();
    const chip = groupChip("transcode");
    const expected = Number(chip.querySelector(".chip__count")?.textContent);

    await user.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("true");

    const rows = items();
    expect(rows).toHaveLength(expected);
    expect(rows.every((el) => el.getAttribute("data-group") === "transcode")).toBe(true);
  });

  it("「全部」是默认档，切回去能拿回所有事件", async () => {
    const user = await openDrawer();
    expect(groupChip("all").getAttribute("aria-pressed")).toBe("true");

    await user.click(groupChip("copy"));
    expect(items().length).toBeLessThan(mockAuditLog.length);
    expect(groupChip("all").getAttribute("aria-pressed")).toBe("false");

    await user.click(groupChip("all"));
    expect(items()).toHaveLength(mockAuditLog.length);
  });

  it("失败快捷过滤只留失败与取消，且可逆", async () => {
    const user = await openDrawer();
    const toggle = screen.getByTestId("audit-filter-abnormal");
    const expected = toAuditRows(mockAuditLog).filter((r) => r.meta.abnormal).length;
    expect(expected).toBeGreaterThan(0);

    await user.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    const rows = items();
    expect(rows).toHaveLength(expected);
    expect(rows.every((el) => el.getAttribute("data-abnormal") === "true")).toBe(true);

    await user.click(toggle);
    expect(items()).toHaveLength(mockAuditLog.length);
  });

  it("失败 chip 上的计数按当前分组算——点下去就是这么多条", async () => {
    const user = await openDrawer();
    const toggle = screen.getByTestId("audit-filter-abnormal");
    const total = Number(toggle.querySelector(".chip__count")?.textContent);

    await user.click(groupChip("copy"));
    const scoped = Number(toggle.querySelector(".chip__count")?.textContent);
    expect(scoped).toBeGreaterThan(0);
    expect(scoped).toBeLessThan(total);

    await user.click(toggle);
    expect(items()).toHaveLength(scoped);
  });

  it("分组与失败过滤是与的关系", async () => {
    const user = await openDrawer();
    await user.click(screen.getByTestId("audit-filter-abnormal"));
    await user.click(groupChip("copy"));

    const rows = items();
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every(
        (el) =>
          el.getAttribute("data-group") === "copy" &&
          el.getAttribute("data-abnormal") === "true",
      ),
    ).toBe(true);
  });

  it("筛空时给空态，并指出怎么退出去", async () => {
    const user = await openDrawer();
    await user.click(screen.getByTestId("audit-filter-abnormal"));
    await user.click(groupChip("sorting"));

    expect(items()).toHaveLength(0);
    expect(bodyText()).toContain("当前过滤条件下没有事件");
  });

  it("页脚如实写明被筛掉多少条——过滤所见即所得", async () => {
    const user = await openDrawer();
    const count = screen.getByTestId("audit-count");
    expect(count.textContent).toBe(`共 ${mockAuditLog.length} 条`);

    await user.click(groupChip("delivery"));
    expect(count.textContent).toBe(
      `显示 ${items().length} / 共 ${mockAuditLog.length} 条`,
    );
  });
});

describe("加载与失败", () => {
  it("取数期间给出加载态", async () => {
    const user = userEvent.setup();
    renderProjectsManager(preloaded);
    await user.click(screen.getByTestId("audit-open"));
    expect(screen.getByTestId("audit-loading").getAttribute("role")).toBe("status");
    await waitFor(() => expect(screen.queryByTestId("audit-loading")).toBeNull());
  });

  it("读取失败如实显示后端原文，不静默变成空态", async () => {
    vi.spyOn(api, "listAuditLog").mockRejectedValue(
      new Error("NAS 未挂载：/Volumes/DIT-NAS/Projects 不可达"),
    );
    await openDrawer();

    const error = screen.getByTestId("audit-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toContain("NAS 未挂载");
    // 失败时不许同时冒出「还没有任何业务事件」这种把事故说成常态的空态
    expect(bodyText()).not.toContain("还没有任何业务事件");
  });

  it("非 Error 的抛出物也照样显示，不吞成 undefined", async () => {
    vi.spyOn(api, "listAuditLog").mockRejectedValue("audit journal 校验和不匹配");
    await openDrawer();
    expect(screen.getByTestId("audit-error").textContent).toContain(
      "audit journal 校验和不匹配",
    );
  });

  it("重试按钮能重新取数并恢复列表", async () => {
    const spy = vi
      .spyOn(api, "listAuditLog")
      .mockRejectedValueOnce(new Error("暂时读不到"))
      .mockResolvedValueOnce(mockAuditLog);

    const user = await openDrawer();
    expect(screen.getByTestId("audit-error")).not.toBeNull();

    await user.click(screen.getByTestId("audit-retry"));
    await screen.findByTestId("audit-list");
    expect(screen.queryByTestId("audit-error")).toBeNull();
    expect(items()).toHaveLength(mockAuditLog.length);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("日志为空时用统一空态组件", async () => {
    vi.spyOn(api, "listAuditLog").mockResolvedValue([]);
    await openDrawer();
    expect(screen.getByTestId("audit-log-body").querySelector(".list__empty")).not.toBeNull();
    expect(bodyText()).toContain("还没有任何业务事件");
  });
});

describe("键盘可达", () => {
  it("打开时焦点落进抽屉", async () => {
    await openDrawer();
    expect(document.activeElement).toBe(screen.getByTestId("audit-close"));
  });

  it("Esc 关闭，并把焦点还给入口按钮", async () => {
    await openDrawer();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("audit-log-drawer")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("audit-open"));
  });

  it("关闭按钮同样能关，焦点同样归位", async () => {
    const user = await openDrawer();
    await user.click(screen.getByTestId("audit-close"));
    expect(screen.queryByTestId("audit-log-drawer")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("audit-open"));
  });

  it("点遮罩关闭，点面板内部不关闭", async () => {
    const user = await openDrawer();
    await user.click(screen.getByTestId("audit-log-body"));
    expect(screen.getByTestId("audit-log-drawer")).not.toBeNull();

    await user.click(screen.getByTestId("audit-overlay"));
    expect(screen.queryByTestId("audit-log-drawer")).toBeNull();
  });

  it("Tab 焦点圈首尾相接，不会跑回身后被遮住的表", async () => {
    await openDrawer();
    const close = screen.getByTestId("audit-close");
    const abnormal = screen.getByTestId("audit-filter-abnormal");

    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(abnormal);

    fireEvent.keyDown(abnormal, { key: "Tab" });
    expect(document.activeElement).toBe(close);
  });

  it("焦点在抽屉外时按 Tab 会被拽回抽屉里", async () => {
    await openDrawer();
    const outside = screen.getByTestId("audit-open");
    outside.focus();
    fireEvent.keyDown(outside, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByTestId("audit-close"));
  });
});
