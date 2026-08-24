/** 文件夹树预览：等宽字体绘制 ├─ └─ 分支，供新建项目向导实时预览建夹结果。 */

import type { FolderNode } from "../api/types";

interface Line {
  key: string;
  branch: string;
  name: string;
  depth: number;
}

/** 把树拍成带分支符号的行；导出以便单测直接比对预览文本 */
export function treeToLines(nodes: FolderNode[], prefix = "", depth = 0): Line[] {
  const lines: Line[] = [];
  nodes.forEach((node, index) => {
    const last = index === nodes.length - 1;
    lines.push({
      key: `${prefix}${node.name}`,
      branch: `${prefix}${last ? "└─ " : "├─ "}`,
      name: node.name,
      depth,
    });
    if (node.children?.length) {
      lines.push(
        ...treeToLines(node.children, `${prefix}${last ? "   " : "│  "}`, depth + 1),
      );
    }
  });
  return lines;
}

export function FolderTreeView({
  root,
  nodes,
}: {
  root: string;
  nodes: FolderNode[];
}) {
  const lines = treeToLines(nodes);
  return (
    <div className="tree">
      <div className="tree__node">
        <span className="tree__name tree__name--root">{root || "（未命名项目）"}/</span>
      </div>
      {lines.map((line) => (
        <div className="tree__node" key={line.key}>
          <span className="tree__branch">{line.branch}</span>
          <span className={`tree__name${line.depth > 0 ? " tree__name--dim" : ""}`}>
            {line.name}
          </span>
        </div>
      ))}
    </div>
  );
}
