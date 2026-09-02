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

### `plan_source_selection(volumeId, folders, confirmInstanceId?) -> SourcePlanDto`

进入双确认屏时调用，给出「这次到底要拷多少、有谁被改名」。

**副作用（2026-08-28 起）**：本命令在返回计划**之前**会给源卡写入身份指纹
`.ocard-volume-id`（不存在才创建，幂等）。理由见「计划绑定令牌 › 介质绑定」。
写不进去（写保护 / 卷不在挂载列表 / 系统内置盘）时**不阻断**，但会发
`volume-uid-unwritable` / `volume-uid-skipped` 告警，明说「本次计划**没有**绑定到
具体介质」——不许静默降级，也不许在任何地方宣称绑定完成。

`confirmInstanceId` 是**可选**参数：一个确认页实例的稳定 id（前端自己生成，页面
存活期间不变，换一次确认屏换一个）。后端按它淘汰计划快照——同一个确认页来回改
勾选只占一个槽，不会把别的确认屏正在用的那份挤掉。

> **前端待办**：给每个确认页生成一个 id（`crypto.randomUUID()` 即可）并在每次
> `planSourceSelection` 时原样带上。不传也能用（退化成「按时间顺序 + TTL 淘汰」），
> 但多个确认屏并发时快照可能被挤掉，`PLAN_CHANGED` 的报文就只能给泛化原因。

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

- **构成**：形如 `ocard-plan-v3:<卷>:<选择>:<文件集>:<修改时间>`，四段各是一个 xxh3。
  对前端是**不透明字符串**，原样回传即可，不要解析、不要拼接、不要缓存过夜。
  - `<卷>` = 卷身份「挂载点 + 卷名 + 卡指纹」——识别「换了一张卡」；
  - `<选择>` = 排序去重后的 selection——识别「提交的勾选范围不是确认时那一份」。
    勾选顺序与重复项不影响令牌；
  - `<文件集>` = 排序后的 `(source_rel, target_rel, size)` 三元组——识别增删 /
    改大小 / 落点被重新规划；
  - `<修改时间>` = 排序后的 `(source_rel, source_mtime_ns)`——识别
    **同大小、修改时间变了的替换**。这正是 size-only 摘要漏掉的那一类，而它在
    换卡场景里完全可能发生；令牌的全部意义是「你批准的就是将要执行的」。
  分段不是给前端解析用的，是为了让后端的拒绝报文说得出**对的**原因。

  > **为什么 v2 → v3**：v2 把「选择」和「文件集」压在同一段里。于是「卡完全没变、
  > 只是提交选择 B 时误带了选择 A 的令牌」这种纯前端状态错配，逐条 diff 会显示
  > 「A 的文件被删、B 的文件新增」，报文断言「卡上的文件变了」——**把前端错配说成
  > 有人动了卡**，用户会跑去数卡上的文件、怀疑同事。说错原因比不说更糟。
  > v2 令牌一律判「无法识别」并要求重新确认（fail-closed），不会被误判成「没变」。
- **回传**：前端把 `planSourceSelection` 返回的 `planDigest` 原样放进
  `StartCopyInput.planDigest`。
- **比对**：`start_copy_task` 重扫后现算一份，不一致就在**任何** UID /
  manifest / 审计副作用之前返回 `PLAN_CHANGED: <人话说明>`（沿用仓库已有的
  `TARGET_EXISTS:` 错误码模式）。
- **拒绝报文必须区分原因**（说错原因比不说更糟，会把人引向错误的排查方向）。
  逐段比对定性，再用后端缓存的那份「批准过的计划」逐条点名：
  比对顺序 = 解释力从强到弱：**卷 → 选择 → 文件集 → 修改时间**。前面的原因能解释
  后面所有差异，先说它才不会把人引向错误的排查方向；**选择必须排在文件集之前**
  ——勾选范围换了，文件集当然跟着不同，这时候说「卡上的文件变了」就是在冤枉这张卡。

  | 定性 | 报文要说的事 |
  |---|---|
  | 卷身份变了 | 再逐段细分（见下）——先去看插的是哪张卡 |
  | 勾选范围变了 | 「本次提交的勾选范围与你确认时的那一份不是同一套」+ 点名两边差在哪（确认时勾了这次没勾 / 这次多勾了）+ **明说「这与卡上的内容无关」**。一个字都不许提「卡上的文件变了」 |
  | 文件集变了 | 增删了什么、多少个（新增 N 个（…）；少了 M 个（…）；大小变了 K 个（…）；落点被重新规划 J 个（…）） |
  | 只有 mtime 变了 | 「有 N 个文件在你确认之后被改动过（大小没变，但内容可能不同）」并点名前几个 |
  | 令牌形态不认识 | 「无法识别你回传的确认令牌」——别乱扣「卡被人动过」 |

  卷身份段本身还要再分，身份串是 `挂载点\0卷名\0卡指纹`：

  | 哪一段变了 | 报文要说的事 |
  |---|---|
  | 指纹从**无到有** | 「确认时读不到也没能写上指纹，现在卡上有一个：**可能**是 OCard 后来写的，也**可能**换上了另一张已带指纹的卡——当时没能完成介质绑定，两者**无法区分**」。规划期会主动创建指纹，所以这一支只在绑定**失败**（写保护 / 非挂载卷）时出现，那时我们手上没有任何介质证据，**不许**断言「源卷本身没换」 |
  | 指纹从有到无 | 「读不到源卷上的身份指纹了」 |
  | 指纹两侧都有且不同 | 「确实是另一张卡」 |
  | 挂载点 / 卷名变了 | 分别点名旧值与新值 |
  | **快照拿不到** | 只能说「卷身份对不上，具体哪一段变了无法判定」+ 披露快照已被淘汰。**不许**扣「不是同一张卡」这种帽子——摘要只证明这一段不同，证明不了是换卡 |

  逐条明细、旧的卷身份串与旧的 selection 都来自后端进程内缓存（最近 16 份计划、
  单份上限 5 万文件、TTL 30 分钟，按 `confirmInstanceId` 替换同一确认页的旧计划）。
  缓存拿不到时（应用重启过 / 计划过大 / 过期 / 被挤掉）报文**明说**拿不到，
  不含糊、不编，且**所有分支**一律只给泛化原因。所有情形的处置都一样：退回双确认屏
  重新确认。

### 介质绑定（`plan_source_selection` 的副作用）

规划**返回之前**就要拿到稳定的介质标识（读到、或创建 `.ocard-volume-id`）。

此前 UID 要到 `start_copy_task` 的摘要比对**之后**才创建，于是确认时的卡 A 根本
没有 UID：随后换成同卷名、同挂载点、文件元数据也一模一样的另一张未标记的卡 B，
三段摘要一字不差，**B 会按 A 的批准直接开跑**。卷名、挂载点、文件大小与 mtime
全都可以在两张卡之间一致，只有指纹是随介质走的。

绑定失败（写保护 / 非挂载卷 / 系统内置盘）时：不阻断规划，但

- 必须发 `volume-uid-unwritable` / `volume-uid-skipped` 告警，明说「本次计划
  **没有**绑定到具体介质」及其后果；
- 后续任何诊断措辞都**不得**声称完成了介质绑定（见上表「指纹从无到有」那一行）。

### 令牌保护不了什么（声明边界，不是缺陷）

令牌是**元数据级绑定**，不是**内容级绑定**。它绑的是
`(卷身份, 选择, [source_rel, target_rel, size], [source_rel, mtime])`——
从头到尾没有读过任何一个字节的文件内容。因此以下情形**绕得过令牌**：

1. **保留时间戳的内容替换**：`cp -p` / `touch -r` / rsync `--times` 写入的同大小
   替换，size 与 mtime 都不变，摘要一模一样；
2. **比对通过之后、实际复制之前**改源文件：`start_copy_task` 比完摘要就去起
   worker，那之后源卡仍然可写，谁都能在那个窗口里换掉文件。

**为什么不做**：内容级绑定意味着确认时把整张卡完整读一遍算哈希、开拷前再读一遍，
一张 512G 的卡多两轮全量读，现场时间与介质寿命都付不起。这是**明确接受**的边界。

**那谁在管这一半**：引擎。落点被占用时按内容哈希裁决——同内容视为已交付，
**内容不同一律报冲突、绝不覆盖、绝不静默当成功**；每个文件落地后还要绕页缓存回读
校验。所以「令牌漏掉的替换」的后果是**报冲突让人工裁决**，不是静默写坏。

**续传完全不受令牌保护。** `resume_copy_task` 不接受也不比对 `planDigest`——
续传是**另一次授权**，走的是另一套闸：清单路径合法性、卷身份重解析
（`prepare_resume`：卷名 + 指纹）、以及续传前逐条 diff 的可见告警
（`copy-resume-size-changed` / `copy-resume-content-replaced` /
`copy-resume-new-files` / `copy-resume-scope-widened`）。前端不要以为「开拷时的
令牌」还在保护续传。
- **缺字段策略（不许 fail-open）**：`source_folders` 非空而 `plan_digest`
  缺失 → **拒绝**，并提示升级客户端 / 退回确认屏；整卷（`source_folders` 为空）
  豁免，行为与老客户端逐字节一致。
- **前端处理**：拿到 `PLAN_CHANGED:` 必须重新拉 `planSourceSelection` 并
  **退回双确认屏重新确认**，把冒号后面的原因**原样展示给用户**（那句话是区分
  「换卡了」「多了文件」「文件被改过」的唯一线索）。
  **绝不自动重试**——自动重试等于替用户批准了一份他没看过的清单。

## 系统项（取代原「隐藏项（点开头的条目）」一节）

扫描只排除**明确列举**的系统项，其余点开头的条目**一律照拷**。

判据在 `core::copy` 的四张表，三处扫描（整卷递归、列可勾选文件夹、列直接子文件）
共用同一份常量：

- `SYSTEM_ITEM_NAMES`——**精确名**。默认就用这张表。
- `SYSTEM_ITEM_PREFIXES`——真·前缀。**只允许**放「尾巴是原文件名、没有任何形状
  可校验」的条目，目前只有 `._`。
- `SYSTEM_ITEM_TAILED`——「命名空间前缀 + 规范定死的尾巴」，尾巴的**字符集与
  最短长度一并校验**。
- `SYSTEM_ITEM_SUFFIXES`——本工具自己的临时名后缀。

| 条目 | 判据 | 是什么 | 为什么排除 |
|---|---|---|---|
| `.Trashes` | 精确名 | macOS 卷级废纸篓 | 用户**已经删掉**的东西 |
| `.Trash` | 精确名 | freedesktop 给可移动盘定义的**共享**回收站（`$topdir/.Trash/$uid`） | 已删除的素材连同 `.trashinfo` 被当素材备份甚至交付 = 隐私泄漏 + 容量膨胀 |
| `.fseventsd` | 精确名 | FSEvents 事件日志数据库 | 操作系统的记账 |
| `.Spotlight-V100` | 精确名 | Spotlight 索引 | 操作系统的记账 |
| `.TemporaryItems` | 精确名 | 系统临时文件暂存 | 操作系统的记账 |
| `.DocumentRevisions-V100` | 精确名 | 文档版本数据库 | 操作系统的记账 |
| `.DS_Store` | 精确名 | Finder 窗口/图标位置 | 纯显示设置 |
| `System Volume Information` | 精确名 | Windows 卷影/索引元数据 | 操作系统的记账（常带 ACL 读不动） |
| `$RECYCLE.BIN` / `RECYCLER` | 精确名 | Windows 回收站 | 用户已经删掉的东西 |
| `Thumbs.db` / `desktop.ini` | 精确名 | 资源管理器缩略图缓存 / 文件夹显示设置 | 机器生成的显示配置 |
| `@eaDir` / `.@__thumb` | 精确名 | 群晖的元数据与缩略图目录 | NAS 的记账（打包路径复用本名单） |
| `.AppleDouble` / `.AppleDB` / `.AppleDesktop` / `.apdisk` | 精确名 | netatalk/AFP 共享的元数据 | NAS 的记账 |
| `.ocard` / `.ocard-volume-id` | **精确名** | 项目元数据目录 / 卡根身份指纹 | 不排除会把上次写的指纹当素材拷走 |
| `._*` | 前缀 | AppleDouble 伴生文件 | 尾巴就是原素材的文件名（`._DSC0001.JPG`），没有形状可校验，只能按前缀认；它是**伴生**元数据，不是素材本体 |
| `.Trash-<uid>` | 前缀 + 尾巴**纯十进制**、≥1 位 | freedesktop 按 uid 分的回收站 | 用户已经删掉的东西 |
| `.smbdelete<令牌>` | 前缀 + 尾巴**字母/数字/点**、≥4 位 | SMB silly-rename 残骸 | 已经被删掉的东西 |
| `.nfs<十六进制>` | 前缀 + 尾巴**全十六进制**、≥8 位 | NFS silly-rename 残骸 | 已经被删掉的东西 |
| `*.ocardpart` / `*.curatepart` | 后缀 | 本工具自己的写入临时名 | 内容**不完整**；交付一个截断的文件比漏掉它更坏 |

> **`.ocard` 从前缀改成精确名（2026-08-28，P0）**：它曾躺在 `SYSTEM_ITEM_PREFIXES`
> 里，于是卡上的 `.ocardinal.mov`、`.ocard-notes.txt`、`.ocard_backup/` 整个不进
> 计划，告警还断言它们「不是素材」，整卷任务照样给「本卡可格式化」——**形状判据
> 兜底 → 漏拷却报成功**的原样复发，只是范围小一点。
>
> 同一条教训适用于**每一条**带尾巴的条目：`.trash-交接单.txt`、`.nfs-交接单.txt`
> 只比前缀就会被静默吞掉。所以尾巴有规范形状的一律进 `SYSTEM_ITEM_TAILED` 并
> **连形状一起校验**；`SYSTEM_ITEM_PREFIXES` 里只留尾巴真的不可预测的那一条。
>
> **加条目的门槛**：加错方向是**漏拷**，所以门槛是「确定不是素材」**且**「现实中
> 真的会出现在扫描范围里」。据此**没有**加入 `LOST.DIR`（Android fsck 恢复目录）
> 与 `FOUND.000`/`*.CHK`（chkdsk 恢复片段）——它们里面可能就是恢复出来的素材片段，
> 多拷不是漏拷。

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
  走 TargetNameKey（Unicode 规范等价 + Unicode 大小写折叠），不按字节比。
- **仍然可见**：命中白名单的条目照旧计数并上报——`SourcePlanDto.hiddenSkipped`
  / `hiddenSamples`、manifest 的 `hidden_skipped` / `hidden_samples`、开拷前的
  `copy-hidden-skipped` 告警。字段名与通知码**保持不变**（改名会当场打断并行
  开发的前端），只有语义与文案改成「系统项」。

  > **前端待办**：双确认屏里那句「N 个「.」开头的条目不在本次范围内」现在**说
  > 错了**——点开头的素材已经会被拷贝。文案要改成「N 个系统项（废纸篓、索引、
  > `.DS_Store` 等）不在本次范围内」。

- **对续传的影响**：老 manifest 的 `planned` 是升级前锁定的，不受影响；但续传时
  重扫会多出一批以前被排除、现在算素材的文件。
  - 按文件夹续传：落点已锁定，新冒出来的不进清单，走 `copy-resume-new-files` 告警；
  - 整卷续传：新冒出来的会被**真的拷贝**、任务完成度回退，走
    `copy-resume-scope-widened` 告警。

### 扫描策略版本 `scanPolicyVersion`

`CopyManifest.scan_policy_version` / `CopyTaskDto.scanPolicyVersion`：

| 值 | 含义 |
|---|---|
| `0`（老清单缺字段） | **旧口径**：以点开头的条目一律跳过。这一版会漏拷卡上合法的点开头素材，而整卷任务照样报 100% 与「本卡可格式化」 |
| `1` | 当前口径：只排除上面表里明确列举的系统项 |

两件事需要它：

1. **归因**。「点开头的条目这次才冒出来」有两种原因：策略升级，或者卡上**真的**
   新增了这些文件。**两者长得一模一样**，唯一的证据就是这个版本号。此前两条续传
   告警一律断言「不是这张卡被人动过」——本版本新建的任务在暂停期间用户真的新增了
   `.clip.mov` 时，那句话就是在编，用户会因此放过一次真实变更。现在的措辞是：
   - 清单版本 `< 当前`：「**可能**是策略升级带来的，也**可能**是卡上真的新增了，
     两者**无法区分**」——即便是旧清单也**不排除**卡内容变化；
   - 清单版本 `== 当前`：「策略升级解释不了它们，应当按源卷内容变化来核对」。
2. **旧的假绿**。升级**前**就已经 `completed: true` 的整卷任务，当时按旧口径漏拷了
   点开头的素材、报了 100% 与「本卡可格式化」。`rebuild_tasks` 只重建**未完成**的
   清单，两条续传告警都够不到它——这是唯一一处「旧的假绿被新代码原样继承下去」。
   后端把版本号落在三处:`CopyManifest.scan_policy_version`(清单本体)、
   `CopyTaskDto.scanPolicyVersion`(任务 DTO)、以及 `copy_started` /
   `copy_completed` 两个审计事件的 `scanPolicyVersion` 字段。

   **注意 DTO 那一路够不到已完成的老任务**:`rebuild_tasks` 只重建
   `completed == false` 的清单,所以升级前就跑完的那批任务根本不会出现在
   `list_copy_tasks` 里。要标注它们只能读**审计日志**(字段缺失 = 旧口径)。

   > **前端待办**：凡是 `scanPolicyVersion === 0` 的拷卡记录，界面必须标注
   > 「这条记录出自旧的扫描口径，当时点开头的素材未被拷贝，100% 与『可格式化』
   > 不可信」。不要按普通绿色显示。

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

  名单为此新增 `SYSTEM_ITEM_SUFFIXES`：`.ocardpart`（拷卡写入临时名）与
  `.curatepart`（精选复制临时名）。**两者都不以点开头**，所以旧判据从来没挡住过
  `.ocardpart` —— 它今天已经能被打进交付包，而那是断连时留下的**半截文件**；
  交付一个截断的文件比漏掉它更坏。

  `.ocard/`（项目自己的 manifest / journal / trash / settings）由三道独立保证挡住：
  扫描起点扎在各素材子树、精确名 `.ocard` 在名单里、命令层另有命名空间闸。
  **注意判据是按名字比的**：扫描起点一旦上提到项目根，第一道就没了。

### packaging 自己的半截文件（不进源卷白名单）

交付打包有两个**自己的** staging 临时名：`.<uuid>.deliverypart`（单文件落包）与
`.<uuid>.manifestpart`（清单原子写）。进程被杀 / NAS 断连时它们按设计留在交付目录
里，内容不完整；重跑交付时若不认出来，会作为普通文件进入**包清单、包文件数与容量**。

判据留在 `core::packaging` 内部，**不扩大 `copy::SYSTEM_ITEM_SUFFIXES`**：那份名单
是**源卷**扫描的口径，卡上永远不会出现 packaging 的内部临时名，把 NAS 内部命名塞进
源卷白名单等于让「卡上什么不算素材」这条判据白白变宽，而变宽的方向就是漏拷。

判据认得**严**：必须是 `.` + 规范 UUID（8-4-4-4-12）+ 固定后缀，少一位都不认
（`.not-a-uuid.deliverypart` 是用户文件，照常交付）。命中的条目**隔离但不删除**
（证据留在盘上让人核对），并逐条发 `delivery-scan-degraded` 告警——绝不静默跳过。

## 落点身份键（TargetNameKey）

判断「两个落点在目的地上是不是同一个文件」只能用一把尺子：
`NFC(default_case_fold(NFD(name)))`——**Unicode 规范等价 + Unicode 默认（full）
大小写折叠**。规划、全计划预检、目标夹占用检查、`.ocardpart` 保留字检查四处必须
共用它，系统项白名单也用它做归一。

- **规范等价**：macOS 上 `é.mov` 可能是 NFC（U+00E9）也可能是 NFD（`e` + U+0301），
  两串字节不同、文件系统却视为同名。不归一会规划出两个「不冲突」的落点，
  内容相同时第二个直接复用第一个的物理文件并报 `all_verified`——
  **两个源最终只剩一个目录项，用户以为都备份了**。
- **大小写折叠**：目的地常是 APFS/exFAT/SMB，`DSC1.JPG` 与 `dsc1.jpg` 是同一个文件。

  用的是 Unicode **默认（full）折叠**（CaseFolding.txt 的 C + F 类，
  `caseless::default_case_fold_str`），**不是 `to_lowercase()`**。APFS 的大小写不敏感
  比较按 Unicode 折叠实现，要求 `σ` / `ς` / `Σ` 三者等价，而 `to_lowercase()` 做不到
  两件事：① `ς`（词尾 sigma）本来就是小写，原样留下，于是大小写敏感的源卷上
  `σ.mov` 与 `ς.mov` 折出两个不同的键；② Rust 的 `str::to_lowercase` 实现了
  Final_Sigma 位置规则（`ΟΔΟΣ` → `οδο` + **ς**），同一个词的大小写变体因此折出
  不同的键。两条都与上面的 NFC 那条**完全同形**：静默合并、两个源只剩一个目录项。

  full 比 simple 折叠**更容易判成同名**（`ß` → `ss`、`ﬁ` → `fi`），方向与本函数的
  安全方向一致。

方向永远是宁可多判成撞名（多一次可见改名）也不漏判（静默合并）。

**源侧选择的去重与此无关**：`plan_source_selection` / `start_copy_task` 收到的
`folders` **只按字节完全相同**去重。源卷可能大小写敏感，`DCIM` 与 `dcim` 是
两个真实存在的目录，合并会静默丢掉一整个文件夹；折叠后同名的分组只发告警，
不合并。

## 源卷解析

`volumeId` 必须能解析到 `core::volumes::list_volumes()` 里的真实挂载卷，
否则一律拒绝：任意可读目录都能当源的话，`list_source_folders` /
`plan_source_selection` 就能被用来读卡外的目录树、文件计数与部分文件名。

**四个入口一个不漏**：`list_source_folders`、`plan_source_selection`、
`start_copy_task`、**`inspect_volume`**。`inspect_volume` 此前漏了这道闸——它会递归
扫描给定目录并返回文件数、容量与拍摄时间范围，等于一个任意目录的读取探针。

## 扫描的符号链接口径

**所有**扫描一律 `DirEntry::file_type()`（不解析链接），链接一概跳过 + 计数 +
可见告警（`copy-symlinks-skipped`），**不许**用 `Path::is_dir()`（跟随链接）。

分类计数（`core::sorting::count_files`）此前用的是 `Path::is_dir()`。旧的
「点开头一律跳过」规则恰好把 `.assets` 这类链接挡在外面，口径放宽之后就挡不住了：
跟随一个指向祖先的链接会无限递归，指向项目外的链接会把外部文件算进角标，
而正式扫描从来不跟随链接——两个数字都出自 OCard，却对不上。

## 准备阶段的并发（0.4.4 起由任务租约挡住）

此前留档的「`Paused → Preparing → Running` 缺一个状态机 CAS」在 0.4.4 由任务租约
（`core::lease`）解决：`resume_copy_task` 第一件事就是 `lease::acquire`，同进程并发的
第二次 resume 在那里撞 Busy（pid 活着、token 不同），走不到复扫与写回；跨进程的第二次
resume 同样被租约拒绝并可见地通知。`spawn_worker` 里的 `swap(true)` 只剩最后一道保险，
守着「上一次运行还在收尾」这段时间里的重复「继续」。

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

export interface CopyTask {
  /* …既有字段不变… */
  /** 锁定这份任务清单时的扫描策略版本。`0` = 旧口径（点开头一律跳过）：
   *  那一版会漏拷点开头的素材却照样报 100%，界面必须标注，不要按普通绿色显示 */
  scanPolicyVersion: number;
}

export function listSourceFolders(volumeId: string): Promise<SourceFolder[]>;
export function planSourceSelection(
  volumeId: string,
  folders: string[],
  /** 确认页实例 id（页面存活期间不变）。可选，但不传时多确认屏并发会让
   *  后端快照被挤掉，PLAN_CHANGED 报文只能给泛化原因 */
  confirmInstanceId?: string,
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
  **写回失败一律 fail-closed 拒绝续传**：worker 会拿着内存里刷新过的新计划开跑，
  却基于磁盘上的旧 `planned` 保存进度——审计范围与实际拷贝范围就此分叉，事后查到的
  「拷了什么」不是真的拷了什么。只发告警然后放行是不够的。
- 续传前的**逐条 diff 与告警两条路径必须一致**：整卷路径此前没有 `resized` /
  `retimed` 告警，于是暂停期间被改大小、或同大小改了 mtime 的文件会被新计划直接
  覆盖，把用户批准过的 size/mtime 基线**无声抹掉**。union 与持久化**之前**先 diff。
- 扫描期的跳过计数（符号链接 / 系统项）在**每一个**出口（含失败出口）都要
  取走并聚合成告警；留着会算到下一次操作头上，报数失真。
- `plan_source_selection` 必须把返回的计划**与当时的卷身份原串、规范化后的
  selection** 按 `planDigest` 存进 `AppState.approved_plans`（有界，见「计划绑定
  令牌」），否则 `PLAN_CHANGED` 只说得出「哪一类变了」，说不出「多了哪几个」
  「勾选差在哪」。
- manifest 落 `scan_policy_version`（见「扫描策略版本」），`CopyTaskDto` 透传。
- 交付打包的 staging 残留判据留在 `core::packaging` 内部，**不进**源卷白名单。
