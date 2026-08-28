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
    /// 被**系统项名单**排除的条目数（见「系统项」一节）
    /// 字段名沿用 hiddenSkipped，语义已改为「系统项」
    pub hidden_skipped: u64,
    /// 上述条目的前几条路径（样例，最多 5 条）
    pub hidden_samples: Vec<String>,
    /// 本次计划的绑定令牌（见「计划绑定令牌」一节）；对前端**不透明**
    pub plan_digest: String,
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
/// 双确认屏返回的 `plan_digest`，原样回传。
/// **`source_folders` 非空时必须带**；整卷豁免（向后兼容）
#[serde(default)]
pub plan_digest: Option<String>,
```

## 计划绑定令牌（`planDigest`）

用户在双确认屏批准的是那一刻的清单 L1，`start_copy_task` 真正执行的是重扫得到
的 L2。窗口内换卡、另一进程写入、文件被删都会让 L2 ≠ L1——被删的已确认文件
直接从新计划里消失，剩下的仍能 `all_verified = true`；新出现的重名还会改变
已批准的改名清单。两次之间必须有令牌绑定。

- **构成**：形如 `ocard-plan-v2:<卷>:<文件集>:<修改时间>`，三段各是一个 xxh3。
  对前端是**不透明字符串**，原样回传即可，不要解析、不要拼接、不要缓存过夜。
  - `<卷>` = 卷身份「挂载点 + 卷名 + 卡指纹」——识别「换了一张卡」；
  - `<文件集>` = 排序后的规范化 selection + 排序后的
    `(source_rel, target_rel, size)` 三元组——识别增删 / 改大小 / 落点被重新
    规划 / 勾选范围变了。勾选顺序不影响令牌；
  - `<修改时间>` = 排序后的 `(source_rel, source_mtime_ns)`——识别
    **同大小、内容被替换**。这正是 size-only 摘要漏掉的那一类，而它在换卡场景
    里完全可能发生；令牌的全部意义是「你批准的就是将要执行的」，漏掉这一类就
    白立了。
  分段不是给前端解析用的，是为了让后端的拒绝报文说得出**对的**原因。
- **回传**：前端把 `planSourceSelection` 返回的 `planDigest` 原样放进
  `StartCopyInput.planDigest`。
- **比对**：`start_copy_task` 重扫后现算一份，不一致就在**任何** UID /
  manifest / 审计副作用之前返回 `PLAN_CHANGED: <人话说明>`（沿用仓库已有的
  `TARGET_EXISTS:` 错误码模式）。
- **拒绝报文必须区分原因**（说错原因比不说更糟，会把人引向错误的排查方向）。
  逐段比对定性，再用后端缓存的那份「批准过的计划」逐条点名：
  | 定性 | 报文要说的事 |
  |---|---|
  | 卷身份变了 | 再逐段细分（见下）——先去看插的是哪张卡 |
  | 文件集变了 | 增删了什么、多少个（新增 N 个（…）；少了 M 个（…）；大小变了 K 个（…）；落点被重新规划 J 个（…）） |
  | 文件一条没变、文件集摘要却不同 | 「本次提交的勾选范围与你确认时的那一份不一致」 |
  | 只有 mtime 变了 | 「有 N 个文件在你确认之后被改动过（大小没变，但内容可能不同）」并点名前几个 |
  | 令牌形态不认识 | 「无法识别你回传的确认令牌」——别乱扣「卡被人动过」 |

  卷身份段本身还要再分，身份串是 `挂载点\0卷名\0卡指纹`：

  | 哪一段变了 | 报文要说的事 |
  |---|---|
  | 指纹从**无到有** | 「指纹是在你确认之后才写上去的（OCard 自己写的），源卷本身没换」——`start_copy_task` 会往卡上写 `.ocard-volume-id`，首拷在那之后失败、用同一个令牌重试就会撞上这一种。报「你换了一张卡」是彻头彻尾的假警报 |
  | 指纹从有到无 | 「读不到源卷上的身份指纹了」 |
  | 指纹两侧都有且不同 | 「确实是另一张卡」 |
  | 挂载点 / 卷名变了 | 分别点名旧值与新值 |

  逐条明细与旧的卷身份串都来自后端进程内缓存（最近 4 份计划、单份上限 5 万
  文件）。缓存拿不到时（应用重启过 / 计划过大）报文**明说**拿不到，不含糊、
  不编。所有情形的处置都一样：退回双确认屏重新确认。
- **缺字段策略（不许 fail-open）**：`source_folders` 非空而 `plan_digest`
  缺失 → **拒绝**，并提示升级客户端 / 退回确认屏；整卷（`source_folders` 为空）
  豁免，行为与老客户端逐字节一致。
- **前端处理**：拿到 `PLAN_CHANGED:` 必须重新拉 `planSourceSelection` 并
  **退回双确认屏重新确认**，把冒号后面的原因**原样展示给用户**（那句话是区分
  「换卡了」「多了文件」「文件被改过」的唯一线索）。
  **绝不自动重试**——自动重试等于替用户批准了一份他没看过的清单。

## 系统项（取代原「隐藏项（点开头的条目）」一节）

扫描只排除**明确列举**的系统项，其余点开头的条目**一律照拷**。

判据在 `core::copy::SYSTEM_ITEM_NAMES` / `SYSTEM_ITEM_PREFIXES`，三处扫描
（整卷递归、列可勾选文件夹、列直接子文件）共用同一份常量：

| 条目 | 是什么 | 为什么排除 |
|---|---|---|
| `.Trashes` | macOS 卷级废纸篓 | 用户**已经删掉**的东西 |
| `.fseventsd` | FSEvents 事件日志数据库 | 操作系统的记账 |
| `.Spotlight-V100` | Spotlight 索引 | 操作系统的记账 |
| `.TemporaryItems` | 系统临时文件暂存 | 操作系统的记账 |
| `.DocumentRevisions-V100` | 文档版本数据库 | 操作系统的记账 |
| `.DS_Store` | Finder 窗口/图标位置 | 纯显示设置 |
| `._*` | AppleDouble 伴生文件 | 资源分支/扩展属性的**伴生**数据，不是素材本体 |
| `System Volume Information` | Windows 卷影/索引元数据 | 操作系统的记账（常带 ACL 读不动） |
| `$RECYCLE.BIN` / `RECYCLER` | Windows 回收站 | 用户已经删掉的东西 |
| `Thumbs.db` / `desktop.ini` | 资源管理器缩略图缓存 / 文件夹显示设置 | 机器生成的显示配置 |
| `.Trash-<uid>` | freedesktop.org 按 uid 分的回收站 | 用户已经删掉的东西 |
| `.smbdelete*` / `.nfs*` | SMB/NFS 删除挂起的 silly-rename 残骸 | 已经被删掉的东西 |
| `@eaDir` / `.@__thumb` | 群晖的元数据与缩略图目录 | NAS 的记账（打包路径复用本名单） |
| `.AppleDouble` / `.AppleDB` / `.AppleDesktop` / `.apdisk` | netatalk/AFP 共享的元数据 | NAS 的记账 |
| `.ocard*` | 本工具自己的落盘（`.ocard-volume-id` 等） | 不排除会把上次写的指纹当素材拷走 |

名单由 **拷卡的三处扫描 + 交付打包（`core::packaging`）** 共用。打包必须用同一份：
拷卡既然把 `.clip.mov` 拷进了素材夹，打包时再按「点开头」把它筛掉，就是在交付
环节静默漏掉一个素材，而包清单照样报完整。NAS 组的条目正是为这次复用而列的
（卡上不会有，NAS 上遍地都是）。

- **为什么不再用「以点开头」这种形状判据**：这是备份工具。卡上以点开头的合法
  素材（某些机型的 `.clip.mov`、被误设隐藏属性的素材、用户自建的隐藏素材夹）
  会从未进入计划，而整卷任务照样报 100% 完成并给出「本卡可格式化」的信号。
  **漏拷却报成功**是这个工具最不能接受的失败形态；可见告警只能缓解，不能替代
  拷对。
- **大小写**：exFAT/APFS 上 `.ds_store` 与 `.DS_Store` 是同一个文件，白名单比对
  走 TargetNameKey（NFC + 大小写折叠），不按字节比。
- **仍然可见**：命中白名单的条目照旧计数并上报——`SourcePlanDto.hiddenSkipped`
  / `hiddenSamples`、manifest 的 `hidden_skipped` / `hidden_samples`、开拷前的
  `copy-hidden-skipped` 告警。字段名与通知码**保持不变**（改名会当场打断并行
  开发的前端），只有语义与文案改成「系统项」。

  > **前端待办**：双确认屏里那句「N 个「.」开头的条目不在本次范围内」现在**说
  > 错了**——点开头的素材已经会被拷贝。文案要改成「N 个系统项（废纸篓、索引、
  > `.DS_Store` 等）不在本次范围内」。

- **对续传的影响**：老 manifest 的 `planned` 是升级前锁定的，不受影响；但续传时
  重扫会多出一批以前被排除、现在算素材的文件。两条路径都必须**说清是 OCard 改
  了口径，不是卡被人动过**（否则用户会去查是谁动了这张卡——完全错误的排查方向）：
  - 按文件夹续传：落点已锁定，新冒出来的不进清单，走 `copy-resume-new-files`
    告警，其中点开头的那些额外说明口径变化；
  - 整卷续传：新冒出来的会被**真的拷贝**、任务完成度回退，走
    `copy-resume-scope-widened` 告警。

- **已收口（2026-08-28）**：`core::sorting`（分类计数、回收站孤儿扫描）、
  `commands::transcode_cmds`（转码源递归、相机夹枚举）、
  `commands::finalcut_cmds`（成片命名校验、待修→已修流转提示）原本各有一份
  「以点开头一律跳过」，现已全部统一到 `copy::is_system_item`。

  收口不只是为了一致——旧判据在**两个方向上都是错的**：
  - 漏拷方向：`.clip.mov` 能拷进 NAS、能在分类界面看到、能被移进交付目录，
    但转码取源与分类计数会把它筛掉，用户看得见、点得动、最后打不进包。
  - 放行方向：群晖的 `@eaDir` **不以点开头**，旧判据一路放行 ——
    `@eaDir/SYNOPHOTO_FILM_*.mp4`（群晖自己生成的低码率预览）会被当成源素材
    去转码，`@eaDir` 本身会被当成一个相机夹递归进去，缩略图还给分类计数灌水。

  名单为此新增第三类 `SYSTEM_ITEM_SUFFIXES`：`.ocardpart`（拷卡写入临时名）与
  `.curatepart`（精选复制临时名）。**两者都不以点开头**，所以旧判据从来没挡住过
  `.ocardpart` —— 它今天已经能被打进交付包，而那是断连时留下的**半截文件**；
  交付一个截断的文件比漏掉它更坏。

  `.ocard/`（项目自己的 manifest / journal / trash / settings）由三道独立保证挡住：
  扫描起点扎在各素材子树、`.ocard` 前缀在名单里、命令层另有命名空间闸。
  **注意判据是按名字比的**：扫描起点一旦上提到项目根，第一道就没了。

## 落点身份键（TargetNameKey）

判断「两个落点在目的地上是不是同一个文件」只能用一把尺子：
**Unicode NFC 归一 + 大小写折叠**。规划、全计划预检、目标夹占用检查、
`.ocardpart` 保留字检查四处必须共用它。

- 大小写：目的地常是 APFS/exFAT/SMB，`DSC1.JPG` 与 `dsc1.jpg` 是同一个文件；
- NFC：macOS 上 `é.mov` 可能是 NFC（U+00E9）也可能是 NFD（`e` + U+0301），
  两串字节不同、文件系统却视为同名。不归一会规划出两个「不冲突」的落点，
  内容相同时第二个直接复用第一个的物理文件并报 `all_verified`——
  **两个源最终只剩一个目录项，用户以为都备份了**。

方向永远是宁可多判成撞名（多一次可见改名）也不漏判（静默合并）。

**源侧选择的去重与此无关**：`plan_source_selection` / `start_copy_task` 收到的
`folders` **只按字节完全相同**去重。源卷可能大小写敏感，`DCIM` 与 `dcim` 是
两个真实存在的目录，合并会静默丢掉一整个文件夹；折叠后同名的分组只发告警，
不合并。

## 源卷解析

`volumeId` 必须能解析到 `core::volumes::list_volumes()` 里的真实挂载卷，
否则一律拒绝：任意可读目录都能当源的话，`list_source_folders` /
`plan_source_selection` 就能被用来读卡外的目录树、文件计数与部分文件名。

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
  /** 被排除的**系统项**数（字段名沿用 hidden*，语义见「系统项」一节）。
   *  文案不要再写「「.」开头的条目」——点开头的素材现在会照常拷贝 */
  hiddenSkipped: number;
  hiddenSamples: string[];
  /** 不透明令牌，原样回传给 startCopyTask，不要解析 */
  planDigest: string;
}

export interface StartCopyInput {
  /* …既有字段不变… */
  /** 空 / 省略 = 整卷 */
  sourceFolders?: string[];
  /** sourceFolders 非空时**必须**带上 plan 返回的 planDigest */
  planDigest?: string;
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
- manifest 里要落 `source_selection` 与 `renamed_files`，审计可追溯；
  另落 `hidden_skipped` / `hidden_samples`（系统项）与 `PlannedFile.source_mtime_ns`
  （同大小但内容被替换的唯一廉价判据，同时也是 `planDigest` 第三段的来源），
  三者都 `#[serde(default)]` + 空值不落盘。
- `CopyTaskDto.source_folders` 必须来自 `selection.to_folders()`，**不是**
  `input.source_folders`：这个字段是「拷完能不能说本卡可格式化」的唯一判据，
  与 manifest 分叉会让同一个任务重启前后显示的范围不一样。
- 规划器产出的落点必须在 TargetNameKey 口径下**两两不同**，且任何被系统改写
  的名字都要进 `renamed_files`；全局唯一性兜底必须覆盖「没有目录层级可加」的
  卷根文件（否则它们永不参与冲突消解，会规划出折叠后同键的两个落点，
  任务开拷即被引擎预检 Err 掉）。
- 续传前刷新出来的 size/mtime 必须**原子地**同时写回 `m.planned` 并落盘
  （只改内存会留下 `planned.size` 与 `entries.size` 互相矛盾的清单）。
- 扫描期的跳过计数（符号链接 / 系统项）在**每一个**出口（含失败出口）都要
  取走并聚合成告警；留着会算到下一次操作头上，报数失真。
- `plan_source_selection` 必须把返回的计划**与当时的卷身份原串**按 `planDigest`
  存进 `AppState.approved_plans`（有界，见「计划绑定令牌」），否则 `PLAN_CHANGED`
  只说得出「哪一类变了」，说不出「多了哪几个」，也分不出「指纹是 OCard 自己
  后写上去的」和「真的换了一张卡」。
