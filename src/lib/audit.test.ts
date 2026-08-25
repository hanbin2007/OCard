/**
 * 审计事件展示口径的单测。
 *
 * 重点不在"漂亮"，在**打不死**：`AuditEventDto.data` 是 unknown，
 * 结构由后端决定、随版本演进，前端拿到 null / 数组 / 字符串 / 深层对象 /
 * 根本不是对象的东西都必须照常出结果。任何一条能让它抛异常的输入，
 * 在真实场景里就意味着整个抽屉白屏——而白屏等于把这条记录静默吞掉了。
 */

import { describe, expect, it } from "vitest";
import { mockAuditLog } from "../api/mock";
import {
  AUDIT_GROUP_FILTERS,
  KNOWN_AUDIT_KINDS,
  MAX_AUDIT_DETAILS,
  auditDetailText,
  auditDetails,
  auditGroupCounts,
  auditKindMeta,
  matchesAuditFilter,
  toAuditRow,
  toAuditRows,
} from "./audit";
import { formatTimestamp } from "./format";

const GB = 1024 ** 3;

describe("auditKindMeta", () => {
  it("已知 kind 翻成中文标签，带分组与语气色", () => {
    expect(auditKindMeta("copy_completed")).toEqual({
      label: "拷卡完成",
      tone: "ok",
      group: "copy",
      abnormal: false,
      known: true,
    });
    expect(auditKindMeta("transcode_failed")).toMatchObject({
      tone: "danger",
      group: "transcode",
      abnormal: true,
    });
    expect(auditKindMeta("delivery_cancelled")).toMatchObject({
      tone: "warn",
      group: "delivery",
      abnormal: true,
    });
  });

  it("语气色分档符合约定：完成绿、失败红、取消琥珀、进行中中性", () => {
    expect(auditKindMeta("copy_started").tone).toBe("neutral");
    expect(auditKindMeta("transcode_started").tone).toBe("neutral");
    expect(auditKindMeta("delivery_built").tone).toBe("ok");
    expect(auditKindMeta("copy_file_failed").tone).toBe("danger");
    expect(auditKindMeta("transcode_cancelled").tone).toBe("warn");
  });

  it("清空回收站用 danger（唯一物理删除），但不算失败", () => {
    const meta = auditKindMeta("trash_emptied");
    expect(meta.tone).toBe("danger");
    expect(meta.abnormal).toBe(false);
  });

  it("未收录的 kind 照常呈现：原样显示，不丢记录", () => {
    const meta = auditKindMeta("project_note_added");
    expect(meta.known).toBe(false);
    expect(meta.label).toBe("project_note_added");
    expect(meta.tone).toBe("neutral");
  });

  it("未收录 kind 只朝「可能有问题」的方向猜，不猜成功", () => {
    expect(auditKindMeta("nas_probe_failed")).toMatchObject({
      tone: "danger",
      abnormal: true,
    });
    expect(auditKindMeta("upload_cancelled")).toMatchObject({
      tone: "warn",
      abnormal: true,
    });
    // 名字里有 completed 也不猜绿：没看懂的事不替后端背书
    expect(auditKindMeta("weird_completed").tone).toBe("neutral");
  });

  it("未收录 kind 按前缀归组，仍能被分组过滤命中", () => {
    expect(auditKindMeta("copy_paused").group).toBe("copy");
    expect(auditKindMeta("assets_tagged").group).toBe("sorting");
    expect(auditKindMeta("trash_pruned").group).toBe("sorting");
    expect(auditKindMeta("delivery_signed").group).toBe("delivery");
    expect(auditKindMeta("transcode_queued").group).toBe("transcode");
    expect(auditKindMeta("something_else").group).toBe("other");
  });

  it("kind 根本不是字符串时也有体面回落", () => {
    for (const bad of [null, undefined, 42, {}, [], true]) {
      const meta = auditKindMeta(bad);
      expect(meta.label).toBe("未知事件");
      expect(meta.known).toBe(false);
    }
  });
});

describe("auditDetails：从 unknown 里挑关键明细", () => {
  it("拷卡完成挑出成功/失败数、容量与用时", () => {
    const details = auditDetails({
      succeeded: 1283,
      failed: 1,
      totalBytes: 4 * GB,
      durationSec: 2804,
      verified: true,
    });
    expect(auditDetailText(details)).toBe(
      "成功 1283 · 失败 1 · 容量 4.0 GB · 用时 46 分 44 秒",
    );
  });

  it("交付包挑出包数与文件数", () => {
    const text = auditDetailText(
      auditDetails({ packages: 6, files: 769, totalBytes: 2 * GB, outputDir: "5. 交付" }),
    );
    expect(text).toContain("包数 6");
    expect(text).toContain("文件数 769");
  });

  it("转码挑出编码器与模式档位，并译成人话", () => {
    const text = auditDetailText(
      auditDetails({ mode: "archive", tier: "balanced", encoder: "hevc_videotoolbox" }),
    );
    expect(text).toBe("模式 归档 · 档位 均衡 · 编码器 hevc_videotoolbox");
  });

  it("失败原因排在最前——一条失败记录里「为什么」比「多少个」重要", () => {
    const details = auditDetails({
      succeeded: 3,
      failed: 1,
      message: "读取超时：源卡 I/O 错误",
      rel: "DCIM/100MEDIA/DJI_0421.MOV",
    });
    expect(details[0]).toEqual({ label: "原因", value: "读取超时：源卡 I/O 错误" });
    expect(details[1].label).toBe("文件");
  });

  it("最多只摆 4 项，多的交给 title", () => {
    const details = auditDetails({
      message: "a",
      rel: "b",
      succeeded: 1,
      failed: 2,
      converted: 3,
      packages: 4,
      total: 5,
    });
    expect(details).toHaveLength(MAX_AUDIT_DETAILS);
  });

  it("同义 key 只取一个，不会出现两个「失败」", () => {
    const details = auditDetails({ failed: 2, failures: [{ rel: "x" }, { rel: "y" }] });
    expect(details.filter((d) => d.label === "失败")).toHaveLength(1);
    expect(details[0].value).toBe("2");
  });

  it("数组值的计数字段按长度算", () => {
    expect(auditDetailText(auditDetails({ failures: [1, 2, 3] }))).toBe("失败 3");
  });

  it("data 缺失/为空时返回空数组，而不是抛错", () => {
    expect(auditDetails(null)).toEqual([]);
    expect(auditDetails(undefined)).toEqual([]);
    expect(auditDetails({})).toEqual([]);
    expect(auditDetails("")).toEqual([]);
  });

  it("data 是标量或数组时照样能读出点东西", () => {
    expect(auditDetails("手工补录")).toEqual([{ value: "手工补录" }]);
    expect(auditDetails(7)).toEqual([{ value: "7" }]);
    expect(auditDetails(true)).toEqual([{ value: "是" }]);
    expect(auditDetails([1, 2])).toEqual([{ value: "2 项" }]);
  });

  it("全是陌生字段时露出生键值，绝不留空白", () => {
    const details = auditDetails({ note: "补拍明天上午入库", scope: "project" });
    expect(details).toEqual([
      { label: "note", value: "补拍明天上午入库" },
      { label: "scope", value: "project" },
    ]);
  });

  it("嵌套对象被跳过，不会渲染出 [object Object]", () => {
    const details = auditDetails({ nested: { deep: { deeper: 1 } }, count: 5 });
    expect(auditDetailText(details)).toBe("条目 5");

    // 只有嵌套对象时也不至于炸，只是没得显示
    expect(auditDetails({ nested: { a: 1 } })).toEqual([]);
  });

  it("类型对不上的已知字段退回通用格式化，不静默丢字段", () => {
    // 后端把数字发成了字符串：仍要显示出来
    expect(auditDetailText(auditDetails({ succeeded: "1283" }))).toBe("成功 1283");
    // 容量发成了非数字：不再走 formatBytes，但值还在
    expect(auditDetailText(auditDetails({ totalBytes: "未知" }))).toBe("容量 未知");
    // 未收录的 mode 值原样显示，不吞
    expect(auditDetailText(auditDetails({ mode: "thumbnail" }))).toBe("模式 thumbnail");
  });

  it("非有限数字与负容量不会渲染成 NaN / Infinity", () => {
    expect(auditDetails({ succeeded: Number.NaN })).toEqual([]);
    expect(auditDetails({ total: Number.POSITIVE_INFINITY })).toEqual([]);
    expect(auditDetailText(auditDetails({ totalBytes: -1 }))).toBe("容量 -1");
  });

  it("超长文本被截断并压平换行，一行放得下", () => {
    const long = `第一行\n${"很长的路径".repeat(40)}`;
    const [detail] = auditDetails({ message: long });
    expect(detail.value.length).toBeLessThanOrEqual(72);
    expect(detail.value.endsWith("…")).toBe(true);
    expect(detail.value).not.toContain("\n");
  });

  it("原型链上的同名属性不会被当成自有字段读出来", () => {
    const data = Object.create({ succeeded: 999 }) as Record<string, unknown>;
    data.count = 3;
    expect(auditDetailText(auditDetails(data))).toBe("条目 3");
  });
});

describe("toAuditRow：整行归一", () => {
  it("正常记录逐项落位", () => {
    const row = toAuditRow(
      {
        ts: "2026-08-24T09:58:47+08:00",
        machine: "WS-7C4A21",
        operator: "张涵斌",
        kind: "copy_completed",
        data: { succeeded: 12, failed: 0 },
      },
      0,
    );
    // 与 CI 时区无关：只断言口径是 MM-DD HH:mm，且与统一格式化函数一致
    expect(row.time).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(row.time).toBe(formatTimestamp("2026-08-24T09:58:47+08:00"));
    expect(row.machine).toBe("WS-7C4A21");
    expect(row.operator).toBe("张涵斌");
    expect(row.meta.label).toBe("拷卡完成");
    expect(row.detailText).toBe("成功 12 · 失败 0");
  });

  it("缺字段/空字段回落成可读占位，不渲染 undefined", () => {
    const row = toAuditRow({ kind: "copy_started" }, 3);
    expect(row.machine).toBe("未知机器");
    expect(row.operator).toBe("未署名");
    expect(row.time).toBe("—");
    expect(row.details).toEqual([]);
  });

  it("时间戳非法时显示破折号，但原始值仍保留给 title", () => {
    const row = toAuditRow({ ts: "not-a-date", kind: "copy_started" }, 0);
    expect(row.time).toBe("—");
    expect(row.ts).toBe("not-a-date");
  });

  it("整条记录根本不是对象时也能出一行", () => {
    for (const bad of [null, undefined, 42, "boom", []]) {
      const row = toAuditRow(bad, 1);
      expect(row.meta.label).toBe("未知事件");
      expect(row.time).toBe("—");
    }
  });

  it("key 带下标，时间与 kind 完全相同的两条也不会撞 key", () => {
    const raw = { ts: "2026-08-24T09:00:00+08:00", kind: "assets_moved", data: null };
    expect(toAuditRow(raw, 0).key).not.toBe(toAuditRow(raw, 1).key);
  });

  it("toAuditRows 对非数组输入返回空，交由上层走空态", () => {
    expect(toAuditRows(null)).toEqual([]);
    expect(toAuditRows({ items: [] })).toEqual([]);
    expect(toAuditRows("nope")).toEqual([]);
  });
});

describe("过滤与计数", () => {
  const rows = toAuditRows(mockAuditLog);

  it("分组过滤只留该环节的事件", () => {
    const transcode = rows.filter((r) => matchesAuditFilter(r, "transcode", false));
    expect(transcode.length).toBeGreaterThan(0);
    expect(transcode.every((r) => r.kind.startsWith("transcode_"))).toBe(true);
  });

  it("「只看失败与取消」只留 abnormal，且与分组是与的关系", () => {
    const abnormal = rows.filter((r) => matchesAuditFilter(r, "all", true));
    expect(abnormal.length).toBeGreaterThan(0);
    expect(abnormal.every((r) => r.meta.abnormal)).toBe(true);

    const both = rows.filter((r) => matchesAuditFilter(r, "copy", true));
    expect(both.every((r) => r.meta.abnormal && r.meta.group === "copy")).toBe(true);
  });

  it("chip 计数与实际筛出的条数一致（所见即所得）", () => {
    for (const abnormalOnly of [false, true]) {
      const counts = auditGroupCounts(rows, abnormalOnly);
      for (const filter of AUDIT_GROUP_FILTERS) {
        const actual = rows.filter((r) =>
          matchesAuditFilter(r, filter.id, abnormalOnly),
        ).length;
        expect(counts[filter.id], `${filter.label} 计数对不上`).toBe(actual);
      }
    }
  });

  it("各分组计数之和等于「全部」，一条都没漏也没重复", () => {
    const counts = auditGroupCounts(rows, false);
    const sum =
      counts.copy + counts.sorting + counts.delivery + counts.transcode + counts.other;
    expect(sum).toBe(counts.all);
    expect(counts.all).toBe(rows.length);
  });
});

describe("mock 时间线", () => {
  const rows = toAuditRows(mockAuditLog);

  it("条数落在 15–20 之间", () => {
    expect(mockAuditLog.length).toBeGreaterThanOrEqual(15);
    expect(mockAuditLog.length).toBeLessThanOrEqual(20);
  });

  it("覆盖全部已收录的 kind", () => {
    const covered = new Set(mockAuditLog.map((e) => e.kind));
    for (const kind of KNOWN_AUDIT_KINDS) {
      expect(covered.has(kind), `mock 缺少 ${kind}`).toBe(true);
    }
  });

  it("按时间倒序（最新在前），与后端约定一致", () => {
    const times = mockAuditLog.map((e) => new Date(e.ts).getTime());
    expect(times.every(Number.isFinite)).toBe(true);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
    }
  });

  it("含他机产生的事件——审计日志的用处一半在这儿", () => {
    expect(new Set(mockAuditLog.map((e) => e.machine)).size).toBeGreaterThan(1);
  });

  it("刻意留了未收录 kind 与空 data，开发期就能看见防御性渲染的样子", () => {
    expect(rows.some((r) => !r.meta.known)).toBe(true);
    expect(rows.some((r) => r.details.length === 0)).toBe(true);
  });

  it("整批归一不抛异常，每行都有可渲染的时间与标签", () => {
    expect(() => toAuditRows(mockAuditLog)).not.toThrow();
    for (const row of rows) {
      expect(row.time).not.toBe("");
      expect(row.meta.label).not.toBe("");
    }
  });
});
