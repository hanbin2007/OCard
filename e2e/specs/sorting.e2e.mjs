// M2 冒烟:工况B建项目 → 注入素材 → 分类移动 → 回收站两段删除 → 交付打包,
// 全程对 NAS 目录做磁盘断言(真实 Tauri→IPC→磁盘链路,评审收口要求)。
import { $, $$, browser, expect } from "@wdio/globals";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const nasRoot = process.env.OCARD_E2E_NAS_ROOT;

// 1×1 有效 JPEG:索引器可正常解码,不触发损坏告警
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==",
  "base64",
);

function projectRoot() {
  const dirs = readdirSync(nasRoot).filter((d) => d.includes("E2E分类"));
  expect(dirs.length).toBe(1);
  return path.join(nasRoot, dirs[0]);
}

async function confirmDangerDialog() {
  const btn = $(".dialog__actions .btn--danger-solid");
  await btn.waitForClickable({ timeout: 10000 });
  await btn.click();
}

async function clickProjectRow(name) {
  // 名字列有 truncate 样式,WebDriver getText 可能取不到;title 属性是稳定锚点
  const el = $(`[data-testid="project-row"] span[title="${name}"]`);
  await el.waitForClickable({ timeout: 15000 });
  await el.click();
}

describe("OCard M2 分类工作台冒烟", () => {
  it("新建工况B项目并注入待分类素材", async () => {
    // 「新建项目」已移出侧栏(UX 波四),入口在项目页头部
    await $('[data-testid="nav-projects"]').click();
    await $('[data-testid="projects-new"]').waitForClickable({ timeout: 15000 });
    await $('[data-testid="projects-new"]').click();
    await $('[data-testid="np-name"]').waitForExist();
    await $('[data-testid="np-name"]').setValue("E2E分类");
    await $('[data-testid="np-scenario-b"]').click();
    // 采用向导预填的默认分类(领导/会场/花絮):
    // 布局 = 1.待分类 / 2.领导 / 3.会场 / 4.花絮 / 5.精选 / 6.其他
    await $('[data-testid="np-submit"]').click();
    await $('[data-testid="project-row"]').waitForExist({ timeout: 20000 });

    const root = projectRoot();
    expect(existsSync(path.join(root, "2. 领导"))).toBe(true);
    expect(existsSync(path.join(root, "5. 精选/待修"))).toBe(true);

    // 磁盘注入两张素材(模拟已拷卡)
    const inbox = path.join(root, "1. 待分类", "0824上午_A7M4_A_ZS");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(path.join(inbox, "e2e_a.jpg"), TINY_JPEG);
    writeFileSync(path.join(inbox, "e2e_b.jpg"), TINY_JPEG);
    writeFileSync(path.join(inbox, "e2e_c.jpg"), TINY_JPEG);
  });

  it("分类移动:点分类条,文件真实落到分类夹", async () => {
    await clickProjectRow("E2E分类");
    await $('[data-testid="nav-sorting"]').click();
    await $('[data-testid="asset-cell"]').waitForExist({ timeout: 30000 });

    await $('[data-asset$="e2e_a.jpg"]').click();
    await $('[data-testid="sorting-category"][data-category="2. 领导"]').click();

    const root = projectRoot();
    await browser.waitUntil(
      () => existsSync(path.join(root, "2. 领导", "e2e_a.jpg")),
      { timeout: 15000, timeoutMsg: "分类移动未落盘" },
    );
    expect(
      existsSync(path.join(root, "1. 待分类/0824上午_A7M4_A_ZS/e2e_a.jpg")),
    ).toBe(false);
  });

  it("精选是复制:原件留在待分类,副本进精选/待修", async () => {
    await $('[data-asset$="e2e_c.jpg"]').waitForExist({ timeout: 15000 });
    await $('[data-asset$="e2e_c.jpg"]').click();
    await $('[data-testid="sorting-category"][data-category="5. 精选"]').click();

    const root = projectRoot();
    await browser.waitUntil(
      () => existsSync(path.join(root, "5. 精选/待修/e2e_c.jpg")),
      { timeout: 15000, timeoutMsg: "精选复制未落盘" },
    );
    expect(
      existsSync(path.join(root, "1. 待分类/0824上午_A7M4_A_ZS/e2e_c.jpg")),
    ).toBe(true);
  });

  it("两段式删除:标记→确认→文件进回收站,清空后物理删除", async () => {
    await $('[data-asset$="e2e_b.jpg"]').waitForExist({ timeout: 15000 });
    await $('[data-asset$="e2e_b.jpg"]').click();
    await browser.keys("d"); // 标记待删除
    await $('[data-testid="sorting-confirm-delete"]').waitForClickable();
    await $('[data-testid="sorting-confirm-delete"]').click();
    await confirmDangerDialog();

    const root = projectRoot();
    const trashDir = path.join(root, ".ocard", "trash");
    await browser.waitUntil(
      () =>
        existsSync(trashDir) &&
        readdirSync(trashDir).some((f) => f.endsWith("e2e_b.jpg")),
      { timeout: 15000, timeoutMsg: "文件未进回收站" },
    );
    expect(
      existsSync(path.join(root, "1. 待分类/0824上午_A7M4_A_ZS/e2e_b.jpg")),
    ).toBe(false);

    // 回收站列表可见 → 清空(唯一物理删除入口)
    await $('[data-testid="sorting-open-trash"]').click();
    await $('[data-testid="trash-row"]').waitForExist({ timeout: 15000 });
    await $('[data-testid="trash-empty"]').click();
    await confirmDangerDialog();
    await browser.waitUntil(
      () => !readdirSync(trashDir).some((f) => f.endsWith("e2e_b.jpg")),
      { timeout: 15000, timeoutMsg: "清空回收站未物理删除" },
    );
    await $('[data-testid="trash-back"]').click();
  });

  it("交付打包:半天分包落盘,清单齐备,原件不动", async () => {
    await $('[data-testid="delivery-open"]').waitForClickable({ timeout: 15000 });
    await $('[data-testid="delivery-open"]').click();
    await confirmDangerDialog();
    await $('[data-testid="delivery-result"]').waitForExist({ timeout: 30000 });

    const root = projectRoot();
    const delivery = path.join(root, "交付");
    expect(existsSync(path.join(delivery, "交付总清单.txt"))).toBe(true);
    const packages = readdirSync(delivery).filter(
      (d) => !d.startsWith(".") && !d.endsWith(".txt"),
    );
    expect(packages.length).toBeGreaterThan(0);
    const pkg = path.join(delivery, packages[0]);
    expect(existsSync(path.join(pkg, "清单.txt"))).toBe(true);
    expect(existsSync(path.join(pkg, "2. 领导", "e2e_a.jpg"))).toBe(true);
    // 原件不动
    expect(existsSync(path.join(root, "2. 领导", "e2e_a.jpg"))).toBe(true);
    // 待修副本不交付
    expect(existsSync(path.join(pkg, "5. 精选/待修/e2e_c.jpg"))).toBe(false);
  });

  it("重跑交付:hash 校验跳过,不产生重复或残留", async () => {
    await $('[data-testid="delivery-close"]').click();
    await $('[data-testid="delivery-open"]').waitForClickable({ timeout: 15000 });
    await $('[data-testid="delivery-open"]').click();
    await confirmDangerDialog();
    await $('[data-testid="delivery-result"]').waitForExist({ timeout: 30000 });

    const root = projectRoot();
    const delivery = path.join(root, "交付");
    const packages = readdirSync(delivery).filter(
      (d) => !d.startsWith(".") && !d.endsWith(".txt"),
    );
    const leaderDir = path.join(delivery, packages[0], "2. 领导");
    const files = readdirSync(leaderDir).filter((f) => !f.startsWith("."));
    expect(files).toEqual(["e2e_a.jpg"]);
    // 不残留 staging 文件,清单仍列出已交付文件
    expect(
      readdirSync(leaderDir).some((f) => f.includes("deliverypart")),
    ).toBe(false);
    const manifest = readFileSync(
      path.join(delivery, packages[0], "清单.txt"),
      "utf8",
    );
    expect(manifest.includes("e2e_a.jpg")).toBe(true);
  });
});
