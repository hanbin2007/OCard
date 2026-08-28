# 拷卡「按文件夹多选」接口契约（2026-08-28）

后端（Rust）与拷卡界面（React）并行开发的**唯一**约定面。两侧都以本文为准，
任何一侧想改字段名，先改本文再动代码。

## 语义

- 选择单位是**文件夹**，勾选后只拷该文件夹的**直接子文件**；子目录不递归，
  子目录自身作为**独立可勾选条目**出现在列表里。
- 落盘**扁平化**：不保留文件夹名、不保留层级，所有选中内容平铺进目标夹。
- 重名处理：不冲突的文件名**一个字都不改**（素材文件名是相机连号，改了就对不上）；
  只有冲突的那一组，从最深一级目录名开始逐级向上追加，直到组内唯一
  （最短可区分前缀）。被改写的必须进 `renamedFiles`。
- **零静默**：加前缀等于系统替用户改了文件名，双确认屏必须明示清单，不得静默。
- 不传 / 传空数组 = 整卷（向后兼容，老客户端与老 manifest 行为不变）。

## 命令

### `list_source_folders(volumeId: String) -> Vec<SourceFolderDto>`

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFolderDto {
    /// 相对卷根，'/' 分隔，无前后斜杠；"" = 卷根自身的直接子文件
    pub rel_path: String,
    /// 该文件夹**直接子文件**数（不含子目录内的）
    pub file_count: usize,
    pub total_bytes: u64,
    /// 是否还有子目录（子目录自身另有独立条目）
    pub has_subfolders: bool,
}
```

排序：`rel_path` 字典序；`""`（卷根）恒排第一。
只列**含直接子文件**或**含子目录**的文件夹，空目录不列。

### `plan_source_selection(volumeId: String, folders: Vec<String>) -> SourcePlanDto`

进入双确认屏时调用，给出「这次到底要拷多少、有谁被改名」。

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePlanDto {
    pub file_count: usize,
    pub total_bytes: u64,
    /// **只含被改写的**；没有重名时为空数组
    pub renamed_files: Vec<RenamedFileDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamedFileDto {
    pub source_rel: String,
    pub target_rel: String,
}
```

`folders` 为空 = 整卷；整卷时 `renamed_files` 恒为空（保留原层级，不会撞名）。

### `StartCopyInput` 增补

```rust
/// 空 / 不传 = 整卷。非空 = 只拷这些文件夹的直接子文件，落盘扁平化
#[serde(default)]
pub source_folders: Vec<String>,
```

## TypeScript 侧

```ts
export interface SourceFolder {
  relPath: string;
  fileCount: number;
  totalBytes: number;
  hasSubfolders: boolean;
}

export interface RenamedFile {
  sourceRel: string;
  targetRel: string;
}

export interface SourcePlan {
  fileCount: number;
  totalBytes: number;
  renamedFiles: RenamedFile[];
}

export interface StartCopyInput {
  /* …既有字段不变… */
  /** 空 / 省略 = 整卷 */
  sourceFolders?: string[];
}

export function listSourceFolders(volumeId: string): Promise<SourceFolder[]>;
export function planSourceSelection(
  volumeId: string,
  folders: string[],
): Promise<SourcePlan>;
```

`CopyTaskPreview` **不变**——它只负责解析真实落盘路径，规模与改名清单走
`planSourceSelection`，两件事不要塞进同一个命令。

## 引擎侧要点（后端专属）

- `manifest::PlannedFile` 现只有 `rel_path` + `size`，引擎用同一个 `rel`
  既当源又当目标。扁平化要求两者分离：
  - `rel_path` 的语义**保持为目标相对路径**（断点续传认的就是它，不能改口径）；
  - 新增 `#[serde(default)] source_rel: String`，空串 = 与 `rel_path` 相同。
    老 manifest 反序列化后行为逐字节不变。
- `ManifestEntry.rel_path` 同样保持为**目标**相对路径。
- `CopyRequest` 带上 `SourceSelection`，`run_copy` 走 `scan_selection`。
- manifest 里要落 `source_selection` 与 `renamed_files`，审计可追溯。
