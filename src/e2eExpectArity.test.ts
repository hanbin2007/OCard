/**
 * E2E 里的 `expect()` 只许收一个参数。
 *
 * 病历(CI run 33183973260):`expect(值, "说明")` 在 vitest 里是合法的、
 * 很自然就会写出来,但 E2E 用的是 wdio 的 expect(expect-webdriverio,jest 系),
 * 它**只收一个参数**,多传一个会当场抛
 * `Error: Expect takes at most one argument.` ——
 * 断言根本没跑,用例就先炸了,而且报错与真正要守的东西毫无关系。
 *
 * 更糟的是这个错误只有**真跑 E2E**(打包好的 Tauri 应用 + tauri-driver)才暴露,
 * 本机和单测一路绿。所以在这里用静态扫描把它挡在提交之前。
 *
 * 想带上失败说明时,改用 `if (!ok) throw new Error("…")`。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const E2E_DIR = resolve(process.cwd(), "e2e");

function mjsFilesIn(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) out.push(...mjsFilesIn(full));
    else if (name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

/**
 * 剥注释与字符串字面量,填等量空白——下标与行号都不变。
 *
 * 字符串**不能整个抹成空白**:那样 `expect(值, "说明")` 的第二个实参会变成
 * 全空白,被「非空实参」判据当成不存在,整条防线假绿。所以字符串留一个
 * `0` 占位(其余填空白),长度与下标照旧。写这条测试时的变异验证抓到了这个
 * bug——防线自己也要被变异验证过一遍才算数。
 */
function blankOutNoise(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      while (i < src.length && src[i] !== "\n") out += " ", i++;
      continue;
    }
    if (two === "/*") {
      out += "  ";
      i += 2;
      while (i < src.length && src.slice(i, i + 2) !== "*/") {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      out += "0"; // 占位:字符串是一个**实参**,不能被抹成「空」
      i++;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += " ";
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * 找出实参多于一个的 `expect(` 调用,返回行号。
 *
 * 数的是**非空实参段**,不是顶层逗号——多行写法的尾逗号
 * （`expect(\n  foo(),\n)`）是一个实参加一个悬垂逗号,数逗号会把它误报。
 * 这个 bug 我第一版真写了,7 条命中里 6 条是它造成的假阳性。
 */
function expectCallsWithMultipleArgs(src: string): number[] {
  const clean = blankOutNoise(src);
  const lines: number[] = [];
  const re = /\bexpect\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    const cuts: number[] = [];
    for (; i < clean.length && depth > 0; i++) {
      const c = clean[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (c === "," && depth === 1) cuts.push(i);
    }
    const end = i - 1; // 与开括号配对的那个 ')'
    const bounds = [start - 1, ...cuts, end];
    let args = 0;
    for (let k = 0; k < bounds.length - 1; k++) {
      if (clean.slice(bounds[k] + 1, bounds[k + 1]).trim() !== "") args++;
    }
    if (args > 1) lines.push(clean.slice(0, m.index).split("\n").length);
  }
  return lines;
}

describe("E2E 的 expect 只收一个参数", () => {
  const files = mjsFilesIn(E2E_DIR);

  it("扫描确实覆盖到了 E2E 文件(扫不到就等于这条防线不存在)", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    const total = files.reduce(
      (n, f) => n + (readFileSync(f, "utf8").match(/\bexpect\s*\(/g)?.length ?? 0),
      0,
    );
    // 一条 expect 都没扫到 = 解析器瞎了,下面的断言会「恰好全绿」
    expect(total).toBeGreaterThan(10);
  });

  it("没有任何 `expect(值, 说明)` 的两参写法", () => {
    const bad: string[] = [];
    for (const file of files) {
      const rel = file.slice(file.indexOf("/e2e/") + 1);
      for (const line of expectCallsWithMultipleArgs(readFileSync(file, "utf8"))) {
        bad.push(`${rel}:${line}`);
      }
    }
    expect(
      bad,
      // 这条说明写在断言里是安全的——本文件跑在 vitest 下
    ).toEqual([]);
  });
});
