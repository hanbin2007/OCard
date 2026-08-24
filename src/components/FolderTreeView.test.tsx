import { describe, expect, it } from "vitest";
import { buildFolderTree } from "../lib/folderTree";
import { treeToLines } from "./FolderTreeView";

describe("treeToLines", () => {
  it("最后一项用 └─，其余用 ├─", () => {
    const lines = treeToLines(buildFolderTree("A"));
    expect(lines).toHaveLength(6);
    expect(lines[0].branch).toBe("├─ ");
    expect(lines[5].branch).toBe("└─ ");
    expect(lines[5].name).toBe("6. 成片");
  });

  it("子级缩进带竖线，末级不带", () => {
    const lines = treeToLines(buildFolderTree("B", ["领导"]));
    const child = lines.find((l) => l.name === "待修");
    expect(child?.depth).toBe(1);
    expect(child?.branch).toBe("│  ├─ ");
  });

  it("行数等于文件夹总数", () => {
    const tree = buildFolderTree("B", ["领导", "会场"]);
    expect(treeToLines(tree)).toHaveLength(7);
  });
});
