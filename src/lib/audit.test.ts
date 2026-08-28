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
import { isPartialCopy } from "./copyScope";
import {
  AUDIT_GROUP_FILTERS,
  KNOWN_AUDIT_KINDS,
  MAX_AUDIT_DETAILS,
  auditDetailText,
  auditDetails,
  auditEventMeta,
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

/**
 * ★ 部分拷贝的范围。
 *
 * 拷卡新增了"按文件夹多选",于是出现了部分拷贝:只拷了卡上的几个文件夹。
 * 审计日志是事后判断"这张卡能不能格式化"的**唯一**权威记录——屏内提示会被
 * 下一张卡冲掉、toast 会消失、铃铛会被确认清掉。这里显示成一条与整卷逐字
 * 相同的绿色"拷卡完成",第二天回来对账的 DIT 就会去相机里格式化掉没备份的
 * 素材,不可逆。
 *
 * 后端已经把范围写进了 `sourceFolders`,这一组测试盯的是前端别再把它丢掉。
 */
describe("★ 拷贝范围（sourceFolders）", () => {
  /** 后端 `COPY_COMPLETED` 的真实载荷形状（src-tauri/src/commands/tasks.rs） */
  function completed(sourceFolders: unknown, over: Record<string, unknown> = {}) {
    return {
      ts: "2026-08-24T09:58:47+08:00",
      machine: "WS-7C4A21",
      operator: "张涵斌",
      kind: "copy_completed",
      data: {
        taskId: "t-1",
        manifestId: "m-1",
        allVerified: true,
        bytesCopied: 42 * GB,
        sourceFolders,
        ...over,
      },
    };
  }

  it("★ 部分拷贝与整卷在界面上必须能区分开——这是本条的判据", () => {
    const partial = toAuditRow(completed(["DCIM/100MSDCF", "PRIVATE/M4ROOT/CLIP"]), 0);
    const whole = toAuditRow(completed([]), 1);

    // 评审实测的症状:两行逐字相同、同为绿色
    expect(partial.detailText).not.toBe(whole.detailText);
    expect(partial.meta.tone).not.toBe(whole.meta.tone);
    expect(partial.meta.label).not.toBe(whole.meta.label);
  });

  it("部分拷贝写明范围与文件夹名，语气色从绿降为琥珀", () => {
    const row = toAuditRow(completed(["DCIM/100MSDCF", "PRIVATE/M4ROOT/CLIP"]), 0);
    expect(row.details[0]).toEqual({
      label: "范围",
      value: "部分拷贝：2 个文件夹（DCIM/100MSDCF、PRIVATE/M4ROOT/CLIP）",
    });
    expect(row.meta.tone).toBe("warn");
    // 颜色不是信息:灰度/色觉障碍下只剩文字,抬头本身要说清
    expect(row.meta.label).toBe("拷卡完成（部分）");
    // 但它不是失败,不该混进「只看失败与取消」
    expect(row.meta.abnormal).toBe(false);
  });

  it("整卷明说「整卷」，语气色仍是绿", () => {
    const row = toAuditRow(completed([]), 0);
    expect(row.details[0]).toEqual({ label: "范围", value: "整卷" });
    expect(row.meta.tone).toBe("ok");
    expect(row.meta.label).toBe("拷卡完成");
  });

  it("★ 范围排在容量之前，不会被 4 项上限挤掉", () => {
    // 症状根因:载荷里 bytesCopied 命中「容量」,picked 非空就直接返回,
    // 露出生键值的兜底永远走不到,界面上再没有第二处能看见 sourceFolders
    const details = auditDetails(completed(["DCIM/100MSDCF"]).data);
    expect(details.length).toBeLessThanOrEqual(MAX_AUDIT_DETAILS);
    expect(details.map((d) => d.label)).toEqual(["范围", "校验", "容量"]);
  });

  it("★ 选了卷根（空串）显示成「卷根」，不是一对空括号", () => {
    const row = toAuditRow(completed([""]), 0);
    expect(row.details[0].value).toBe("部分拷贝：1 个文件夹（卷根）");
    expect(row.details[0].value).not.toContain("（）");
    // 判据与 store / 后端一致:非空即部分,卷根也不例外
    expect(row.meta.tone).toBe("warn");
  });

  it("文件夹多于两个时只列前两个并省略，总数仍如实写明", () => {
    const [detail] = auditDetails(
      completed(["A", "B", "C", "D"]).data,
    );
    expect(detail.value).toBe("部分拷贝：4 个文件夹（A、B…）");
  });

  it("超长文件夹名被截断，不会把一行撑爆", () => {
    const [detail] = auditDetails(completed([`${"很长的路径".repeat(40)}`]).data);
    expect(detail.value).toContain("部分拷贝：1 个文件夹");
    expect(detail.value.length).toBeLessThan(120);
  });

  it("★ allVerified 在部分拷贝下带上范围口径，不会被读成整卡都校验过了", () => {
    const partial = auditDetails(completed(["DCIM/100MSDCF"]).data);
    expect(partial[1]).toEqual({ label: "校验", value: "所选范围通过" });

    const whole = auditDetails(completed([]).data);
    expect(whole[1]).toEqual({ label: "校验", value: "全部通过" });

    const bad = auditDetails(completed([], { allVerified: false }).data);
    expect(bad[1].value).toBe("全部存在未通过");
  });

  it("sourceFolders 不是数组时如实说读不出，绝不当成整卷放绿灯", () => {
    for (const bad of [null, "DCIM", 3, { a: 1 }]) {
      const row = toAuditRow(completed(bad), 0);
      expect(row.details[0].label).toBe("范围");
      expect(row.details[0].value).toContain("范围读不出");
      expect(row.meta.tone, `${JSON.stringify(bad)} 不该是绿的`).not.toBe("ok");
    }
  });

  it("数组里混进非字符串也不炸，照样能出一行", () => {
    const [detail] = auditDetails(completed([null, 42]).data);
    expect(detail.value).toBe("部分拷贝：2 个文件夹（?、42）");
  });

  it("「开始拷卡」也带 sourceFolders，同样要标出范围", () => {
    // 后端在 copy_started 里也写了 source_selection(commands/mod.rs)：
    // 一次部分拷贝的两条记录口径要一致,不能开始时看着像整卷、完成时才变脸
    const row = toAuditRow(
      {
        ts: "2026-08-24T09:12:03+08:00",
        kind: "copy_started",
        data: {
          taskId: "t-1",
          volume: "CFE-01",
          targetFolder: "上午_DJIRonin4D_B_ZS",
          sourceFolders: ["DCIM/100MSDCF"],
          renamedCount: 0,
        },
      },
      0,
    );
    expect(row.details[0].label).toBe("范围");
    expect(row.meta.label).toBe("开始拷卡（部分）");
    expect(row.meta.tone).toBe("warn");
  });

  it("★ 判据与 store / 拷卡屏同源（E7）：四种输入的分叉逐条对齐", () => {
    /*
     * 这条盯的不是文案，而是**判据只有一份**。此前 audit 自己写了一遍
     * `Array.isArray(v) && v.length > 0`，store 写了一遍 `?.length > 0`，
     * 拷卡屏又写了一遍——同一次拷贝因此可能在通知里说「请勿格式化」、
     * 在审计里显示成一条绿色的整卷完成。这里把两边钉在同一个函数上。
     */
    const cases: Array<[unknown, boolean]> = [
      [[], false],
      [[""], true],
      [["DCIM/100MSDCF"], true],
      [null, true],
      ["DCIM", true],
    ];
    for (const [value, partial] of cases) {
      const meta = auditEventMeta("copy_completed", { sourceFolders: value });
      // 审计的语气色分叉必须与共享判据同步：非整卷一律降级成琥珀
      expect(meta.tone === "warn", JSON.stringify(value)).toBe(partial);
      expect(isPartialCopy(value), JSON.stringify(value)).toBe(partial);
    }
  });

  it("旧记录（没有 sourceFolders 这个字段）保持原样，不擅自编一个范围", () => {
    // 按文件夹多选是新特性,此前的记录只可能是整卷;替它编一行同样是替后端背书
    const row = toAuditRow(
      { ts: "2026-08-24T09:58:47+08:00", kind: "copy_completed", data: { bytesCopied: GB } },
      0,
    );
    expect(row.meta.tone).toBe("ok");
    expect(row.details.some((d) => d.label === "范围")).toBe(false);
  });

  it("语气色只朝更该被看见的方向压，不会把 danger 调轻", () => {
    expect(
      auditEventMeta("copy_file_failed", { sourceFolders: ["DCIM"] }).tone,
    ).toBe("danger");
    // 未收录的 kind 不给它拼中文后缀（抬头是等宽原始值），但仍要变色
    const unknown = auditEventMeta("copy_slice_done", { sourceFolders: ["DCIM"] });
    expect(unknown.label).toBe("copy_slice_done");
    expect(unknown.tone).toBe("warn");
  });

  it("data 不是对象时 auditEventMeta 退回纯 kind 口径，不抛", () => {
    for (const bad of [null, undefined, 42, "x", ["DCIM"]]) {
      expect(auditEventMeta("copy_completed", bad).tone).toBe("ok");
    }
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
