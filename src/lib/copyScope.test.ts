/**
 * 拷贝范围判据的口径测试。
 *
 * 这个模块只有几十行，却是全应用唯一一处「这张卡能不能格式化」的判据。
 * 它此前散在四个地方（后端 tasks.rs、store 的终态通知、audit 的审计行、
 * 拷卡屏的完成提示），每处各写一遍 `?.length > 0` —— 四份实现就是四次走样的
 * 机会，而走样的表现是：同一次拷贝，通知里说「请勿格式化」、审计里是一条绿色的
 * 整卷完成。所以这里把四种输入的口径逐条钉死，谁改坏了都会在这里红。
 */

import { describe, expect, it } from "vitest";
import {
  classifyCopyScope,
  copyScopeFolderCount,
  folderDisplayName,
  formatScopeFolders,
  isPartialCopy,
  VOLUME_ROOT_DISPLAY,
  VOLUME_ROOT_LABEL,
} from "./copyScope";

describe("classifyCopyScope：四种输入的口径", () => {
  it("undefined（字段省略）= 整卷", () => {
    // 老客户端与「按文件夹多选」上线之前的记录都是这个形状
    expect(classifyCopyScope(undefined)).toBe("whole");
    expect(isPartialCopy(undefined)).toBe(false);
  });

  it("[] = 整卷", () => {
    expect(classifyCopyScope([])).toBe("whole");
    expect(isPartialCopy([])).toBe(false);
  });

  it("★ [\"\"]（只勾了卷根）= 部分拷贝，不是整卷", () => {
    /*
     * 这条是本文件存在的头号理由。`[""]` 长得像空、像「什么都没选」，
     * 但它的语义是「只拷卷根的直接子文件」——`DCIM/` 底下的素材一个都不会被拷。
     * 任何一处把它判成整卷，那张卡就会被告知「可格式化」。
     */
    expect(classifyCopyScope([""])).toBe("partial");
    expect(isPartialCopy([""])).toBe(true);
  });

  it("多项 = 部分拷贝", () => {
    expect(classifyCopyScope(["DCIM/100MSDCF", "PRIVATE/M4ROOT/CLIP"])).toBe(
      "partial",
    );
    expect(isPartialCopy(["DCIM/100MSDCF"])).toBe(true);
  });

  it("不是数组 = 读不懂，且**不许**当成整卷放行", () => {
    for (const bad of [null, "DCIM", 3, { a: 1 }, true]) {
      expect(classifyCopyScope(bad), `${JSON.stringify(bad)}`).toBe("malformed");
      // 读不懂时按「不能担保」处理：宁可多说一句「请勿格式化」
      expect(isPartialCopy(bad), `${JSON.stringify(bad)}`).toBe(true);
    }
  });
});

describe("copyScopeFolderCount", () => {
  it("按数组长度数，非数组一律 0（文案据此避开「所选 0 个文件夹」这种鬼话）", () => {
    expect(copyScopeFolderCount(undefined)).toBe(0);
    expect(copyScopeFolderCount([])).toBe(0);
    expect(copyScopeFolderCount([""])).toBe(1);
    expect(copyScopeFolderCount(["a", "b"])).toBe(2);
    expect(copyScopeFolderCount("DCIM")).toBe(0);
  });
});

describe("folderDisplayName：卷根必须有名字", () => {
  it("空串与纯空白都是卷根", () => {
    expect(folderDisplayName("")).toBe(VOLUME_ROOT_DISPLAY);
    expect(folderDisplayName("   ")).toBe(VOLUME_ROOT_DISPLAY);
    expect(VOLUME_ROOT_DISPLAY).toBe(`（${VOLUME_ROOT_LABEL}）`);
  });

  it("bare 模式给不带括号的名字（外层已经有一对括号了）", () => {
    expect(folderDisplayName("", { bare: true })).toBe(VOLUME_ROOT_LABEL);
  });

  it("普通路径原样保留", () => {
    expect(folderDisplayName("DCIM/100MSDCF")).toBe("DCIM/100MSDCF");
  });

  it("非字符串走兜底，读不出就是问号——不抛", () => {
    expect(folderDisplayName(42)).toBe("42");
    expect(folderDisplayName(null)).toBe("?");
    expect(folderDisplayName({})).toBe("?");
    // 调用方可以带自己的兜底（audit 有一套更全的）
    expect(folderDisplayName(["x"], { fallback: () => "1 项" })).toBe("1 项");
  });
});

describe("formatScopeFolders：范围文案", () => {
  it("★ 只勾卷根时不能渲染成空白", () => {
    // 症状:完成屏直接 join,写出来是「本次只拷了：。」——安全结论还在,
    // 备份范围却没说清,而这正是第二天决定要不要格式化时唯一能对账的东西
    const { text, count } = formatScopeFolders([""]);
    expect(text).toBe(VOLUME_ROOT_DISPLAY);
    expect(text.trim()).not.toBe("");
    expect(count).toBe(1);
  });

  it("卷根与真实路径混排时两者都看得见", () => {
    expect(formatScopeFolders(["", "DCIM/100MSDCF"]).text).toBe(
      "（卷根）、DCIM/100MSDCF",
    );
  });

  it("limit 截断时给出 truncated，总数仍是截断前的", () => {
    const r = formatScopeFolders(["a", "b", "c"], { limit: 2 });
    expect(r.text).toBe("a、b");
    expect(r.truncated).toBe(true);
    expect(r.count).toBe(3);
  });

  it("不截断时 truncated 为假", () => {
    const r = formatScopeFolders(["a", "b"], { limit: 2 });
    expect(r.truncated).toBe(false);
  });

  it("非数组（含 undefined）给空文案与 0 条，交给调用方分叉，不抛", () => {
    for (const bad of [undefined, null, "DCIM", 7]) {
      const r = formatScopeFolders(bad);
      expect(r.text).toBe("");
      expect(r.count).toBe(0);
      expect(r.truncated).toBe(false);
    }
  });
});
