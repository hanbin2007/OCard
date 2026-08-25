Verified all three. The CI `set -e` P0 is real (I had reasoned it wrong; empirical run confirms `exit 0` with both tests failing). Report follows.

---

# M3 实现评审（Claude 路）— 数据报告

## 1. 实跑结果

| 套件 | 命令 | 结果 |
|---|---|---|
| Rust | `cargo test --release` | **142 passed / 0 failed / 1 ignored**（0.62s） |
| 前端 | `pnpm test --run` | **27 files / 429 tests passed**（12.34s） |
| 构建 | `pnpm build`（`tsc && vite build`） | **通过**，74 modules，350.27 kB（gzip 104.90 kB） |
| 基准 | `cargo test --release bench_single_24mp -- --ignored --nocapture` | **PASS**：`单张 24MP 全流水线 0.114s；18 核外推千张 ≈ 7s（预算 300s）` |

**基准数的可信度限定**：该基准只量了 `image::open + extract_features`。它**没量** YuNet 推理（被 `yunet.rs:34` 的 `Mutex<Session>` 全局串行化，是真正的吞吐地板）、`store_thumb_from_image`（第 3 次全分辨率下采样）、`exif_shot_at` 的二次开文件、NAS 往返、特征落盘。真实 `analyze_one` 成本是它的数倍。7s vs 300s 有 40× 余量，**结论不翻盘**，但这个数字不能当 SLA 证据用（计划 W7 本就如此声明）。

---

## 2. 逐波对账表

| 波 | 计划要求 | 实况 | 判定 |
|---|---|---|---|
| **W1** 集成测试网 | mock runtime 驱动同一张 handler 表；**后续每波新命令必须挂网** | 网建了（`ocard_invoke_handler!` 生产/测试共用 ✓），4 个用例。`integration_tests.rs` **最后一次改动在 W2**（9e6d147） | ⚠️ **纪律条款违反**（见 A1） |
| **W2** JobManager + 交付作业化 | D2 状态机 / D3 互斥 / 取消写清单 / revision | 状态转移表逐条对上 ✓；OpsMutex 已 Arc+owned guard ✓；取消也写清单 + `delivery_cancelled` 审计 ✓；`delivery-result` testid 语义保留 ✓ | ⚠️ D2 三条未落地（P1-A、A6、A7） |
| **W3** ProjectStats 缓存 | 逐项目指纹 + TTL 2s；三类失效路径都测 | **明示收窄**为纯 TTL，理由写在 `catalog.rs:30-36` 请复审裁决；测试只覆盖 1 类失效 | ✅ **裁决：接受收窄**（TTL 对陈旧的封顶比指纹更硬），⚠️ 测试欠 2 类 |
| **W4** thumb:// | 协议闸 / thumbReady 判据切换 / 失败聚合 | 闸完备（白名单、段数、拒链接、字节切片证明安全）✓；判据切换**真实生效**（旧判据残留 rg = **0**）✓ | 🔴 **协议在生产上是坏的**（P0-1） |
| **W5** 转码底座 | 真探针 / 制品链路 / GPL 声明 | `lavfi testsrc2` 实编 3 帧 + 超时强杀 + capability×pix_fmt 粒度 ✓；`docs/ffmpeg-license.md` 版本/来源/SHA-256/源码获取途径齐全 ✓ | ✅ 达成 |
| **W6** 转码作业 | 代理 + **归档三档** + 首帧图 + 远端横幅 | 代理链完整；**归档只有纯函数没接线**；**首帧图未做**；**远端横幅不显示他机转码** | 🔴 **半达成**（A2、A3、A4） |
| **W7a/b** AI | 单次解码 / D4 协议 / 聚类确定性 / YuNet | 1 次 decode ✓；D4 逐条对上 ✓；tie-break 确定性 ✓；**YuNet 解码数学正确**（含 sw/sh 归一化）；SHA-256 硬失败 ✓ | ⚠️ **PRD 闭眼边界未更新**（A5） |
| **W8** 成片校验 + 清账 | grammar / ffprobe 交叉核对 / 流转提示 / 已上传勾选 | 三项都在；`curated_flow_hints` 拼的 id **过闸**（串起来验证通过） | ⚠️ 竖幅比对含死代码 + 退化输入误报（P2-9、P2-10） |
| **W9** 收口 | installer SHA-256 校验 / 变异矩阵 / 真实性能报告 / 双路评审 | installer 校验步骤**假绿**；无变异矩阵；无真实素材报告；无 M3 收敛文档；**无 D 波裁决记录文档** | 🔴 **未完成** |

---

## 3. P0

### P0-1｜`thumb://` 协议未做 percent 解码 — 中文项目名下缩略图 100% 失效
`src-tauri/src/lib.rs:124` + `src-tauri/src/commands/thumb_proto.rs:16`

```rust
let path = request.uri().path().to_string();   // ← 原始百分号编码
let p = commands::thumb_proto::resolve_thumb_request(&nas, &path)?;
```

**框架自身的判例是决定性的**：Tauri 2.11.5 内置的每一个协议处理器都先解码 ——
`protocol/asset.rs:35`、`protocol/tauri.rs:204`、`protocol/isolation.rs:101`、`ipc/protocol.rs:444` 全部是 `percent_encoding::percent_decode(request.uri().path()...)`。全仓 grep：`percent|urlencod|decodeURI` **零命中**。

`thumb_url()` 生成 `thumb://localhost/20260824_校运会/abc.jpg`；webview 构造请求时必然把非 ASCII 转义（`http::Uri` 只接受 ASCII），处理器拿到 `/20260824_%E6%A0%A1%E8%BF%90%E4%BC%9A/...`，`nas.join("20260824_%E6%A0%A1...")` 找不到目录 → 404。

**后果**：项目名按 OB/GF 001—2026 一律是 `YYYYMMDD_中文名`，**每一个真实项目的每一张缩略图都 404**。名字里有空格（`sanitize_component` 允许）同样中招。

**为什么测试全绿**：单测 `thumb_proto.rs:74` 传的是**已解码**路径；E2E 三个 spec 的项目名都是中文（`E2E冒烟/E2E转码/E2E分类`），但**没有任何一条断言渲染出来的缩略图** —— 全仓 e2e 目录里 `asset-thumb` 零命中。

**唯一的缓解**：零静默设计有效——`thumb-protocol-degraded` 会在连续 20 次失败后亮横幅，界面显示「预览不可用」而非假装正常。**降级可见，但功能整体报废。**

### P0-2｜CI installer 校验步骤在最该报错时静默变绿
`.github/workflows/ci.yml:127-141`（要害 135/137/139）

```bash
set -euo pipefail
case "${{ runner.os }}" in
  Linux) test -x src-tauri/target/release/ffmpeg && test -x src-tauri/target/release/ffprobe ;;
esac
echo "sidecars verified"
```

`set -e` 明文豁免「`&&` 列表中除最后一个之外的命令」。**ffmpeg 缺失（正是这道闸要抓的头号故障）是左操作数**，短路后 errexit 不触发，脚本一路跑到 `echo` 并以 0 退出。

**我实跑复现**：
```
$ bash -c 'set -euo pipefail; case Linux in Linux) test -x /nope/a && test -x /nope/b ;; esac; echo "sidecars verified"'
sidecars verified
EXIT=0
```
（只有 ffprobe 单独缺失时才会红——那半边恰好是最后一个命令。macOS 分支在 `bundle/macos` 存在但无 `.app` 时同样假绿。`case` 还缺 `*)` 兜底。）

**附带的实质缺口**：这一步只 `test -x/-f`，**没有 SHA-256 校验**，**完全没有检查模型资源**。计划 W9 要求的是「installer 解包校验（sidecar/**模型**存在+**SHA-256**）」，且 Linux/Windows 查的是 `target/release/` 下 tauri 的暂存拷贝，**不是安装包内容**——根本没证明 sidecar 进了 MSI/deb。

**后果**：W9 唯一的打包链路闸门对主要失效模式完全无效，CI 绿着放行一个装了却不能转码的包。违反「禁止无提示 fail-open」。

---

## 4. P1

### P1-1｜取消 running 作业时立刻置终态，安全闸随之提前打开
`src-tauri/src/core/jobs.rs:213-219`

```rust
pub fn request_cancel(&self, id: &str) -> Option<JobSnapshot> {
    handle.cancel.store(true, Ordering::SeqCst);
    handle.transition(JobState::Cancelled)   // Running→Cancelled 合法，当场生效
}
```
紧邻的注释写「running 的由 worker 在安全点调 **`finish_cancelled`**（锁内 CAS 防竞争）」——**全仓不存在 `finish_cancelled` 这个函数**。文档描述的设计没有实现。

D2 的「先到先得 + 竞输方放弃发布」本身是**满足**的（worker 晚到的 Done 会被 `transition` 拒绝）。真正的问题是终态提前：
- `any_active()` 立刻返回 false → **`install_update` 闸门（`updater.rs:135`）在 ffmpeg 子进程/交付复制仍在跑时放行**，正是它要防的事。
- 交付作业的 `DeliveryGuard` 仍被 worker 持有，但 job 已 cancelled → 前端「互斥由 job 状态派生」重新启用分类屏 → 用户按键得到「交付打包进行中」逐键报错。**这正是 W2 明令要消灭的 M2 老毛病**。
- 窗口不是微秒级：交付在**文件边界**才检查取消，一个大文件可能是分钟级。

### P1-2｜「强制全转」文案承诺了后端明确不做的事，覆盖入口整体缺席
`src/screens/TranscodeScreen.tsx:157` vs `src-tauri/src/commands/transcode_cmds.rs:396-400`

UI：「强制全转（忽略**「已转码 / 无需转码」**判定，**重转所有素材**）」
后端：`force_all` **只**跳过 `heavy_verdict`（`:363`）；已转码判定**完全不看 `force_all`**：
```rust
if final_out.exists() { result.already_transcoded += 1; continue; }
```
`:212` 注释自认「覆盖只属于**将来的**「强制重转」显式入口」。

计划 D2:47 要求「显式「强制重转」（**二次确认**，唯一覆盖入口，**先删后转**）」，W6:105 要求「整夹强制全转+**逐文件覆盖**」。TranscodeScreen 里连 `ConfirmDialog` 的 import 都没有。E2E 的 `confirmDangerDialogIfAny()`（`transcode.e2e.mjs:19-24`）是作者预期有确认框、实际扑空的化石。

**后果**：用户为修一批坏代理勾上「强制全转」，得到全量 `alreadyTranscoded` 跳过，坏文件原封不动，而界面计数看起来一切正常。

### P1-3｜代理输出名 `{stem}_proxy.mp4` 同名冲突被误报成「已转码」
`src-tauri/src/commands/transcode_cmds.rs:388` + `:396-400`，`VIDEO_EXTS` 见 `:179`

同一相机夹下 `C0001.MP4` + `C0001.MXF`（Sony XAVC 标准产物）、`A.MTS` + `A.MP4`（双记录）都映射到同一个 `C0001_proxy.mp4`。第一个转完，第二个 `final_out.exists()` → `already_transcoded += 1`，**报告说它已转码，实际它从未被转过**。大小写不敏感文件系统上 `A.mov`/`a.mov` 同理。属于静默的结果错报。

### P1-4｜多卡场景下 auto_proxy 的补投递本会话直接丢失
`src-tauri/src/commands/transcode_cmds.rs:249` + `:591-606`，派发点只有两处（`lib.rs:99` 启动重放、`tasks.rs:120` 拷完钩子），**无周期重试**。

拷 A 卡完成 → 转码作业跑起来（分钟级）→ 拷 B 卡完成 → `dispatch_auto_proxy` → `has_active(Transcode, project)` → Err → 只发一条 `auto-proxy-deferred` warn → **B 卡这一整轮不会再被投递**，要等下次启动应用。工况 A 多卡是常规工作流，不是崩溃边角。

lane 串行机制本来就能排队消化，但被 `has_active` 前置条件挡在了队列之外。启动重放同样：同项目多个未完成意图，一次启动只处理得了一个。

### P1-5｜连拍组展开层里选中的项，分类/精选/标删三条路径全部静默无效
`src/screens/SortingScreen.tsx:1019-1021`（overlay 传**裸 assetId**）vs `:914-918`（网格传 `entry.id`）+ `src/lib/sorting.ts:396-401`（`if (!entry) continue`）

我已核对源码确认两处 `onSelect` 用的是不同的 id 空间。折叠后选区认 entry id，组成员的裸 assetId 不在 `entries` 里 → `resolveEntryIds` 静默丢弃 → 返回 `[]` → `runAssign:446` / `runCurate:482` 命中 `targets.length === 0` 直接 return。

而 overlay 自己的文案（`:1269`）白纸黑字承诺「组内可以单独选中并执行分类/精选/标删」。**功能承诺与实现直接矛盾，且零反馈**。（键盘路径更彻底：overlay 渲染在挂 handler 的 `sorting__grid-wrap` 之外，合成事件不冒泡。）

### P1-6｜双击/回车预览开错图
`src/screens/SortingScreen.tsx:918`、`:916`、`:1026`

`onOpen={() => setPreviewIndex(index)}` 与 `setPreviewIndex(cursorIndex)` 给的都是 **entries 下标**，`assets[previewIndex]` 索引的是 **assets 原始数组**。只要前面有折叠组（N→1）或开了「只看建议保留」，两个下标空间就错位。`:588` 预览态左右键更危险：用 `assets.length` 算边界却索引 `assetIds`，越界写入 undefined cursor。

### P1-7｜第二次分析的角标永不刷新（per-job revision 被当作全局变更令牌）
`src/screens/SortingScreen.tsx:212-216`

`analyzeDoneRev = analyzeJob.revision` 作为 effect 依赖。但 `revision` 是**每个 job 独立**的计数器（`jobs.rs:88` 在 `JobHandle` 内，`:160` 每次 `create` 都 `AtomicU64::new(0)`）。两次分析事件条数相同时（文件数没变即为常态）revision 相同 → effect 不重跑 → 角标/折叠/筛选全停在上一轮。

### P1-8｜转码 E2E 的幂等断言是空断言
`e2e/specs/transcode.e2e.mjs:73-81`

`transcode-already` 在 `TranscodeScreen.tsx:290-294` 是**无条件渲染**的统计格（值为 0 也在）。第 59 行等到 `transcode-result` 时它就已存在 → `waitUntil` 立即返回 → 第二次转码根本没等它跑完。后续 `readdirSync().filter(f => !f.startsWith("."))` 又恰好滤掉了 staging 文件。**commit 6672c26 声称的「幂等重跑断言」不成立**——把后端 skip 逻辑删掉，E2E 依然全绿。

### P1-9｜集成测试网自 W2 后再未生长（纪律条款违反）
`src-tauri/src/commands/integration_tests.rs`（4 个 `#[test]`，最后改动 9e6d147 = W2）

W3–W8 新增 **9 个命令**（`ffmpeg_status`、`transcode_capabilities`、`transcode_diagnostics`、`start_proxy_transcode`、`start_analysis`、`check_final_cuts`、`curated_flow_hints`、`get_delivery_status`、`set_delivery_status`）**零命令层覆盖**。同时 `resolve_asset_a_in_project`——计划纪律条款点名新增、且写明「每处都是任务验收项」的那道闸——**零测试**（全仓仅 1 处调用、0 处测试）。

---

## 5. P2（择要）

| # | 位置 | 问题 |
|---|---|---|
| P2-1 | `sorting.ts:368-387` + `:394` | 同 groupId 被拆成两段时产生**重复 entry id**，`new Map` 后者覆盖前者 → 点这一格操作另一格的文件。当前靠后端排序不变量兜住，前端零防御 |
| P2-2 | `sorting.ts:344` | `group:` 前缀与真实 assetId 命名空间碰撞（macOS/Linux 路径含 `:` 合法） |
| P2-3 | `sorting_cmds.rs:456` vs `:487` | 注释宣称「同组**不跨分页**的结构保证」，实际 `.skip().take()` **无组边界对齐**——排序只保证连续，切页照样切断组 |
| P2-4 | `SortingScreen.tsx:1289-1293` | GroupOverlay 缩略图无 `onError`，404 露破图、不计入降级统计 |
| P2-5 | `SortingScreen.tsx:1185` | GroupCell 的 `failed` 态缺 URL 变化复位 |
| P2-6 | `store.tsx:714-735` | `listJobs()` 只在启动对账一次，无轮询/无手动刷新入口。丢一条 delivery 终态事件 → 分类屏永久禁用，**除重启无恢复路径** |
| P2-7 | `SortingScreen.tsx:946-950` | 「已选 N」显示条目数（8 张组算 1），按 D 后跳到「已标记 8 个」，破坏性操作前数量预期不一致 |
| P2-8 | `transcode_cmds.rs:332-341` | 空间预检不足只返回 job error，**没有计划点名的 `disk-space-insufficient` notice code**；`free_space_for` 返回 None 时预检**静默跳过** |
| P2-9 | `finalcut_cmds.rs:114-118` | **用户点名的竖幅 min/max**：`h.max(info.height.min(info.width))` 中第二项恒等于 `h`，整个表达式化简为 `min(w,h)`——**语义是对的**（横幅 min=height、竖幅 min=width，正是「竖幅按较小边」），但那半截是**死代码**，读起来像 bug |
| P2-10 | 同上 | `width==0`/`height==0`（探测退化）时算出「实际 0 像素」并**标红误报**，正确行为应是 `uncheckable` |
| P2-11 | `naming.rs:224` | `parse_final_cut` 空段处理不一致：`20260824__4K_成片_V1` 被拒（title=""），`20260824___4K_成片_V1` 被**放行**（title="_" 非空）。多点扩展名/Unicode/全角数字/字节切片安全性我都构造了反例——**其余全部正确**，`vu[1..]` 有 `starts_with('V')` 短路保护 |
| P2-12 | `analysis.rs:197-198` | `sharpness_region` 的 `clamp(8, ...)` 在 `iw < 400` 且人脸框贴右/下边时 **min > max 直接 panic**（如 iw=320, x=1.0 → `clamp(8, 7)`）。被 `analysis_cmds.rs:115` 的 per-item `catch_unwind` 兜住，报成「分析线程异常」误导性消息 |
| P2-13 | `transcode.rs:375-395` | `run_transcode` 的取消检查在 `reader.lines()` 循环内；ffmpeg 卡死不吐 progress 时取消无法生效，且 `child.wait()` 无取消检查、无总超时 |
| P2-14 | `ffmpeg.rs:156-170` vs `transcode.rs:199` | `proxy_args` 不带 VAAPI 的 `-init_hw_device`/`hwupload`，Linux 上硬编代理**必然运行时失败**再回落软编（有告警，不静默，但每次白跑一遍） |
| P2-15 | `transcode_cmds.rs:538-551` | 永久失败的文件使 `proxy_completed` 永不置位 → **每次启动无限重投**，无重试上限、无放弃标记 |
| P2-16 | `transcode_cmds.rs:401-410` | staging 清理只在**即将转码某文件时**清该文件所在夹，且 `already_transcoded` 分支 `continue` 在清理之前。D2 要求的「**启动**清理只清本机 + **可见提示**」两点都没有 |
| P2-17 | `sorting_cmds.rs:458` | `list_pending_assets` 每翻一页都重读全量 `features-*.jsonl` + 全集 `judge()` + 全量 `scan_source`（每文件一次 stat），SMB 上是 O(N) 每页 |

---

## 6. 宣称与实况不符清单

| # | 宣称出处 | 实况 | 严重度 |
|---|---|---|---|
| A1 | 计划 W1「后续每波的新命令都必须挂进这张网」 | 测试网 W2 后冻结；W3–W8 的 9 个新命令零覆盖 | P1 |
| A2 | 计划 W6「归档:三档按 backend 定质量映射…输出目录 `validate_dest_layout`」 | `archive_args`/`quality_args`/`ArchiveTier` **只是纯函数 + 单测**，无命令、无 UI、无落地闸。PRD §5.6 的归档档位整体未交付 | P1 |
| A3 | 计划 W6「视频首帧图：转码路径顺带 `-vf thumbnail` 抽帧进缩略图缓存」 | 全仓零实现；`media.rs:167` 仍是 `AssetKind::Video => None` | P2 |
| A4 | 计划 W6「RemoteActivityBanner 显示他机转码」 | `list_remote_activity` 只处理 `COPY_STARTED/COMPLETED`；`transcode_started/completed` 写进了 journal 但从不呈现 | P2 |
| A5 | **commit c44ef94「闭眼按 D1 gate 砍并记入 PRD 边界」** | `docs/superpowers/specs/2026-08-24-ocard-prd.md` 在 v0.2.0..HEAD **完全未被改动**（docs 只动了 ffmpeg-license.md 和计划本身）。PRD 第 15/83/85/126/170 行**仍把闭眼检测当作已交付能力**在写 | **P1**——典型的「宣称已修但替换未生效」 |
| A6 | 计划 D2「应用退出前确认活跃作业（提示等待/取消）；强退路径 kill/reap 子进程」 | 全仓无 `RunEvent::ExitRequested` / `on_window_event` / `CloseRequested` | P1 |
| A7 | 计划 D2「staging…**启动清理**只清本机+**可见提示**」 | 只有转码途中的就地清理，非启动期，无提示 | P2 |
| A8 | 计划零静默清单点名 `disk-space-insufficient` | **该 code 全仓不存在**（其余 8 个 code 全部存在且触发路径可达，我逐个 grep 验过） | P2 |
| A9 | 计划 D1「决策门（D 波…**产出裁决记录文档**）」 | `docs/superpowers/` 下无任何 D 波裁决文档 | P2 |
| A10 | 计划 W9 「installer 解包校验（sidecar/**模型**存在+**SHA-256**）」 | 见 P0-2：假绿、无 SHA、无模型、查的不是安装包 | P0 |
| A11 | 计划 W3「指纹逐项目取…三类失效路径都测」 | 指纹条款**明示收窄**（理由写在 `catalog.rs:30-36` 请复审裁决）——**我裁决接受**；但测试只覆盖 1 类失效 | 可接受 |
| A12 | commit 6672c26「幂等重跑断言」 | 空断言，见 P1-8 | P1 |
| A13 | 注释 `sorting_cmds.rs:456`「同组连续且**不跨分页**的结构保证」 | 只保证连续，不保证不跨页 | P2 |
| A14 | 注释 `jobs.rs:216`「worker 在安全点调 `finish_cancelled`」 | 该函数不存在，取消是当场终态化 | P1 |

**反向核实——以下宣称经查属实**（不是所有东西都坏）：
- W4「rg 对照：残留错误判据 0」——**属实**，5 处 `thumbReady` 判据、0 处旧判据残留。
- D2 状态转移表、终态不可逆、竞输方放弃发布、panic 转 failed 终态必发、progress 终态后忽略——逐条对上，单测覆盖到位。
- D3 OpsMutex Arc+owned guard、transcode 独立 lane、analyze 不进互斥、`install_update` 并入 JobManager 闸——全部接线正确。
- D4 特征存储协议（每机纯追加、版本全匹配才采信、冲突取 analyzedAt 最新持平取 machineId 字典序大、坏行计数）——逐条对上。
- **YuNet 解码数学正确**：stride 8/16/32 遍历、`sqrt(cls*obj)` 评分、`exp` bbox 解码、行列索引，与 OpenCV `FaceDetectorYN` 官方后处理一致；**用户怀疑的 letterbox 归一化用 `sw/sh` 而非 `iw/ih` 是正确写法**（内容只占 640×640 画布的左上 `sw×sh` 区域，除以 640 才是错的）。
- 「单次解码」**属实**（每条路径各数过：1 次 `image::open`，`store_thumb_from_image`/`sharpness_region`/`detect` 都复用已解码图，无二次解码）——代价是 3 次全分辨率下采样，属效率而非正确性问题。
- `faces: None`（检测器不可用）vs `Some(0)`（检测器可用、无脸）语义区分正确。
- **`curated_flow_hints` 拼出的 asset id 串到 trash 是安全的**：`{curated}` 取自 `scenario_b_dirs`，恰是 `resolve_asset_in_project` 白名单的同一来源；即使分类名含 `/`，首段比对也会失配拒绝。
- **`.github/workflows/ci.yml` 里没有任何 heredoc**（`rg '<<-?\s*[A-Za-z_'"'"'"]'` 零命中）——用户怀疑的 `PYEOF2` 嵌套缩进问题**不存在**；YAML 实跑 `yaml.safe_load` 合法。真正的 CI 缺陷是 `set -e` 的 `&&` 豁免（P0-2）。
- `scripts/fetch-ffmpeg.sh` **fail-closed 正确**（SHA 不符 → `rm -f` + `exit 1`，`pipefail` 让 `shasum||sha256sum` 回落真的生效）。
- E2E testid **30/30 全部命中** src。
- **AI 只标注不动文件**（PRD 底线）：`judgement`/`suggestedKeep`/`blurry` 的全部消费点只有 filter、角标、封面选优三类；5 个写操作调用点的目标参数一律来自选择集，**没有一条数据流从 judgement 通向写命令**。
- JobSnapshot 是按 `kind` 判别的 discriminated union，`result?` 可选，done 前读不会崩；revision 单调过滤 reducer 层正确，终态事件不可能被丢（后端同锁内自增同一 AtomicU64）。

---

## 7. 结论

M3 的骨架质量是高的：状态机、互斥矩阵、特征存储协议、路径闸族、真探针、零静默 code 表这些**难做对的部分基本都做对了**，YuNet 解码数学和路径闸串联经得起对抗性推演，三套件 571 个测试全绿，基准有 40× 余量。

但收口面上有两个各自独立、都能让功能整体报废的 P0（缩略图协议在真实项目名下 100% 失效；CI 唯一的打包闸门对头号故障假绿放行），9 个 P1，以及一份 14 项的宣称/实况偏差清单——其中 **A5（commit 声称已写入 PRD，PRD 一字未改）和 A2（归档转码只有纯函数没接线）是里程碑级的账面缺口**，A1/A12 说明本轮的「测试随波落地」和「每波挂网」纪律条款在 W3 之后就没有真正执行。W9 整波未开工。P0-2、P1-2、P1-5 三项都命中「禁止无提示 fail-open」的硬性原则。

**M3 实现评审：不可收口** —— 理由：两个 P0（thumb:// 协议在生产上对所有真实项目失效；CI installer 校验假绿放行不能转码的安装包）加上计划明列却未交付的 W6 归档转码与未更新的 PRD 闭眼边界，构成功能缺口 + 质量闸门失效 + 规格账面不符三重问题；W9 收口波尚未开始，双票终审不具备条件。建议按 P0 → P1 → A 类账面 的顺序开一轮修复波后重审。