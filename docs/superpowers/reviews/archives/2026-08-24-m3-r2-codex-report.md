# OCard M3 第 2 轮复验报告

**最终判定：不可收口。**

评审固定在提交 `e267dd3333bd48f7fba95b7c6eaee488970db711`。评审期间工作树被外部推进到 `e6ee731f...`，差异仅涉及 CSS 和样式测试，以下涉及的后端、CI、E2E、文档及前端逻辑均与目标提交一致。

本轮严格只读，没有执行会写入 `target/`、缓存或测试产物的命令；测试结论来自测试代码审阅，而不是本轮运行结果。下述复现均为代码路径推演。

## 原问题复验

### P0

| 项 | 状态 | 证据与结论 |
|---|---|---|
| P0-1 缩略图 percent-decode | **已闭合** | 已先解码再校验，见 [thumb_proto.rs:17](/Users/zhb/Documents/OCard/src-tauri/src/commands/thumb_proto.rs:17)，拒绝双重编码测试见 [thumb_proto.rs:100](/Users/zhb/Documents/OCard/src-tauri/src/commands/thumb_proto.rs:100)。 |
| P0-2 CI fail-closed | **部分闭合** | ffmpeg、模型、解包路径已 fail-closed，见 [ci.yml:127](/Users/zhb/Documents/OCard/.github/workflows/ci.yml:127)；但 ffprobe 只检查存在或可执行，未校验已有哈希 [SHA256SUMS.txt:4](/Users/zhb/Documents/OCard/src-tauri/binaries/SHA256SUMS.txt:4)，Windows 模型也只检查存在 [ci.yml:169](/Users/zhb/Documents/OCard/.github/workflows/ci.yml:169)。 |
| P0-3 cancel/guard 竞态 | **部分闭合** | running job 现在只置取消标志 [jobs.rs:228](/Users/zhb/Documents/OCard/src-tauri/src/core/jobs.rs:228)，有阻塞体测试 [jobs.rs:563](/Users/zhb/Documents/OCard/src-tauri/src/core/jobs.rs:563)；但终态仍在 guard drop 前写入 [jobs.rs:320](/Users/zhb/Documents/OCard/src-tauri/src/core/jobs.rs:320)，`any_active()` 存在短暂假阴性窗口。 |
| P0-4 空目录被标成功 | **部分闭合** | 增加了目录错误和 `total == 0` 守卫 [transcode_cmds.rs:327](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:327)、[transcode_cmds.rs:629](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:629)；但扫描非递归且 `.flatten()` 静默丢目录项错误 [transcode_cmds.rs:338](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:338)，真实相机嵌套目录仍会得到零任务。 |

### P1

| 项 | 状态 | 证据与结论 |
|---|---|---|
| P1-5 手动重转确认 | **已闭合** | 后端拒绝隐式覆盖 [transcode_cmds.rs:476](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:476)，前端确认及测试 [TranscodeScreen.tsx:107](/Users/zhb/Documents/OCard/src/screens/TranscodeScreen.tsx:107)、[TranscodeScreen.test.tsx:195](/Users/zhb/Documents/OCard/src/screens/TranscodeScreen.test.tsx:195)。 |
| P1-6 输出名碰撞 | **部分闭合** | 名称加入扩展名 [transcode_cmds.rs:457](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:457)，但大小写敏感文件系统上的 `clip.mov`、`clip.MOV` 仍同时映射为 `clip_MOV_proxy.mp4`，且无碰撞测试。 |
| P1-7 auto_proxy 恢复/去重 | **部分闭合** | auto 可绕过 active-job 守卫 [transcode_cmds.rs:252](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:252)，启动恢复存在 [lib.rs:89](/Users/zhb/Documents/OCard/src-tauri/src/lib.rs:89)；未实现约定的 intent ID 去重，恢复错误和部分保存错误被静默忽略。 |
| P1-8 尝试次数/弃置 | **部分闭合** | 有 attempt 上限和 notice [transcode_cmds.rs:667](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:667)；计数保存失败被忽略 [transcode_cmds.rs:671](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:671)，可能无限重试，且缺审计闭环。 |
| P1-9 评分过滤语义 | **已闭合** | 前端判断及筛选已统一 [SortingScreen.tsx:471](/Users/zhb/Documents/OCard/src/screens/SortingScreen.tsx:471)、[sorting.ts:418](/Users/zhb/Documents/OCard/src/lib/sorting.ts:418)。 |
| P1-10 preview 重复 | **已闭合** | 生成唯一 preview 列表 [SortingScreen.tsx:142](/Users/zhb/Documents/OCard/src/screens/SortingScreen.tsx:142)，渲染使用该列表 [SortingScreen.tsx:609](/Users/zhb/Documents/OCard/src/screens/SortingScreen.tsx:609)。 |
| P1-11 分析刷新/缓存 | **部分闭合** | job ID 变化会刷新 [SortingScreen.tsx:234](/Users/zhb/Documents/OCard/src/screens/SortingScreen.tsx:234)；缓存键仍只有文件数和最大 mtime [sorting_cmds.rs:526](/Users/zhb/Documents/OCard/src-tauri/src/commands/sorting_cmds.rs:526)，非最大文件改变或粗粒度 NAS mtime 会命中陈旧缓存。 |
| P1-12 E2E 假断言 | **已闭合** | 已断言真实文件清单、数量和 mtime [transcode.e2e.mjs:70](/Users/zhb/Documents/OCard/e2e/specs/transcode.e2e.mjs:70)。 |
| P1-13 command 注册契约 | **部分闭合** | 有 handler/integration 对照 [lib.rs:13](/Users/zhb/Documents/OCard/src-tauri/src/lib.rs:13)、[integration_tests.rs:200](/Users/zhb/Documents/OCard/src-tauri/src/commands/integration_tests.rs:200)；遗漏 `list_remote_activity`，archive/proxy 只测 B gate，不测成功路径，重复项断言 [integration_tests.rs:165](/Users/zhb/Documents/OCard/src-tauri/src/commands/integration_tests.rs:165) 实际恒真。 |
| P1-14 PRD ledger | **未闭合** | 指定的 `docs/PRD.md` 不存在；替代文档仍标为“草案，待确认” [2026-08-24-ocard-prd.md:1](/Users/zhb/Documents/OCard/docs/superpowers/specs/2026-08-24-ocard-prd.md:1)，并同时保留 RAW 全解码、GPU 自动加速及延期 GPU 等冲突表述 [2026-08-24-ocard-prd.md:73](/Users/zhb/Documents/OCard/docs/superpowers/specs/2026-08-24-ocard-prd.md:73)。 |
| P1-15 archive 端到端 | **部分闭合** | 命令和 UI 已接通 [transcode_cmds.rs:723](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:723)、[TranscodeScreen.tsx:287](/Users/zhb/Documents/OCard/src/screens/TranscodeScreen.tsx:287)；仍有路径逃逸、VAAPI 参数、清理、notice 和成功测试缺口。 |
| P1-16 视频缩略图 | **部分闭合** | 后端已调用 ffmpeg [analysis_cmds.rs:256](/Users/zhb/Documents/OCard/src-tauri/src/commands/analysis_cmds.rs:256)；失败仅折叠成布尔值，TS 结果类型未携带 skipped/notice 字段 [types.ts:669](/Users/zhb/Documents/OCard/src/types.ts:669)，用户不可见。 |
| P1-17 远端活动终态 | **部分闭合** | fold 可处理 completed/cancelled [sorting_cmds.rs:1207](/Users/zhb/Documents/OCard/src-tauri/src/commands/sorting_cmds.rs:1207)；`transcode_started` 后的能力探测/扫描错误没有 failed 审计 [transcode_cmds.rs:272](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:272)，横幅会残留 24 小时。 |
| P1-18 关闭窗口保护 | **部分闭合** | 已检测 JobManager、TaskManager [lib.rs:170](/Users/zhb/Documents/OCard/src-tauri/src/lib.rs:170)；确认退出只取消 job/ffmpeg，没有暂停或取消正在写文件的 copy task。 |
| P1-19 临时文件清理 | **部分闭合** | proxy 有 best-effort 清理 [transcode_cmds.rs:391](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:391)；archive 无对称清理 [transcode_cmds.rs:918](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:918)，清理失败也无 notice。 |
| P1-20 零静默 fail-open | **部分闭合** | 部分失败已发 notice；但 feature 目录读取错误返回空结果 [analysis.rs:90](/Users/zhb/Documents/OCard/src-tauri/src/core/analysis.rs:90)，人脸推理错误转成 `faces=0` 并缓存 [analysis_cmds.rs:381](/Users/zhb/Documents/OCard/src-tauri/src/commands/analysis_cmds.rs:381)，flow-hints 前后端也会静默吞错。 |
| P1-21 独立 watchdog | **部分闭合** | 已加入取消轮询和 watchdog [transcode.rs:436](/Users/zhb/Documents/OCard/src-tauri/src/core/transcode.rs:436)，但没有针对 `run_transcode` 卡死/取消的回归测试。 |
| P1-22 VAAPI pipeline | **部分闭合** | proxy 加了 `init_hw_device`/`hwupload` [transcode.rs:249](/Users/zhb/Documents/OCard/src-tauri/src/core/transcode.rs:249)；输出为 NV12，却被统一验证器要求 yuv420p [transcode_cmds.rs:547](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:547)，archive VAAPI 又缺少初始化链 [transcode.rs:288](/Users/zhb/Documents/OCard/src-tauri/src/core/transcode.rs:288)。 |
| P1-23 sharpness 分母 | **部分闭合** | 数学实现已修正 [analysis.rs:190](/Users/zhb/Documents/OCard/src-tauri/src/core/analysis.rs:190)，但没有该函数或区域边界回归测试。 |
| P1-24 评分阈值 | **已闭合** | UI 已按 0–100 使用阈值 [SortingScreen.tsx:1187](/Users/zhb/Documents/OCard/src/screens/SortingScreen.tsx:1187)；TS 注释仍错误写成 0–1 [types.ts:653](/Users/zhb/Documents/OCard/src/types.ts:653)，降为 P2。 |
| P1-25 分组尾项/cache | **部分闭合** | 尾组已 flush [sorting_cmds.rs:496](/Users/zhb/Documents/OCard/src-tauri/src/commands/sorting_cmds.rs:496)；缓存键缺陷仍在且无失效测试。 |

## A1–A14 核验

convergence 文档及仓库没有给出 A1–A14 的逐项定义，因此不能把提交说明里的“已吸收”当作验收证据：

- **A9：已闭合。** 有独立决策记录 [2026-08-24-m3-decision-gate.md:3](/Users/zhb/Documents/OCard/docs/superpowers/plans/2026-08-24-m3-decision-gate.md:3)。
- **A5、A14：部分闭合。** 历史提交只把二者共同描述为 PRD ledger 修复，但 `docs/PRD.md` 缺失，替代 PRD 自相矛盾。
- **A1–A4、A6–A8、A10–A13：未闭合/不可验收。** 仓库只存在“A1–A9 全部吸收”的无证据声明 [2026-08-24-m3-plan.md:151](/Users/zhb/Documents/OCard/docs/superpowers/plans/2026-08-24-m3-plan.md:151)，没有可追溯定义、代码映射或测试。

## 新发现 P0

1. **P0-NEW-1：copy resume 可由 manifest 实现任意路径读写。** `planned` 相对路径未经 `..`、绝对路径或 canonical-prefix 校验便合并 [commands/mod.rs:750](/Users/zhb/Documents/OCard/src-tauri/src/commands/mod.rs:750)、重建 [commands/mod.rs:833](/Users/zhb/Documents/OCard/src-tauri/src/commands/mod.rs:833)，随后直接 `root.join(rel)` [copy.rs:257](/Users/zhb/Documents/OCard/src-tauri/src/core/copy.rs:257)。将 manifest 项改为 `../../victim`，resume 即可读取源根外文件并向目标根外写入。

2. **P0-NEW-2：copy 扫描和目标写入均可沿符号链接逃逸。** 递归扫描使用会跟随链接的 `metadata()` [copy.rs:80](/Users/zhb/Documents/OCard/src-tauri/src/core/copy.rs:80)，目标只做 lexical layout 判断 [paths.rs:54](/Users/zhb/Documents/OCard/src-tauri/src/core/paths.rs:54)。源目录链接可复制外部树或形成循环；目标中间目录链接可把写入导向挂载点外。

3. **P0-NEW-3：缩略图及 `.ocard` 状态目录缺少中间组件闸门。** 缩略图只拒绝项目根和最终文件本身为链接 [thumb_proto.rs:51](/Users/zhb/Documents/OCard/src-tauri/src/commands/thumb_proto.rs:51)，协议随后直接读取 [lib.rs:135](/Users/zhb/Documents/OCard/src-tauri/src/lib.rs:135)，生成器直接创建文件 [media.rs:238](/Users/zhb/Documents/OCard/src-tauri/src/core/media.rs:238)。令 `.ocard/thumbs` 指向外部目录即可读写项目外；manifest/journal 同样直接读写 [manifest.rs:111](/Users/zhb/Documents/OCard/src-tauri/src/core/manifest.rs:111)、[journal.rs:115](/Users/zhb/Documents/OCard/src-tauri/src/core/journal.rs:115)。

4. **P0-NEW-4：archive 输出路径可通过祖先符号链接绕过保护。** 校验仅检查字符串前缀和最终节点 [transcode_cmds.rs:763](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:763)，写入则直接落盘 [transcode_cmds.rs:918](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:918)。`/tmp/link/sub` 中 `link` 指向受保护目录时可通过全部检查。

5. **P0-NEW-5：代理和归档不递归扫描，真实相机目录会被判为零素材。** copy 保留嵌套目录，而 proxy/archive 只读 camera 目录第一层 [transcode_cmds.rs:327](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:327)、[transcode_cmds.rs:846](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:846)。典型 `PRIVATE/M4ROOT/CLIP/*.MP4` 不会转码，auto_proxy 多次重启后会达到尝试上限并放弃。

6. **P0-NEW-6：Release 在干净 runner 上缺少 sidecar 下载步骤。** `externalBin` 强制要求二进制 [tauri.conf.json:37](/Users/zhb/Documents/OCard/src-tauri/tauri.conf.json:37)，目录内容又被忽略 [.gitignore:1](/Users/zhb/Documents/OCard/src-tauri/binaries/.gitignore:1)；只有 CI 下载 [ci.yml:107](/Users/zhb/Documents/OCard/.github/workflows/ci.yml:107)，三个 Release job 均直接 build [release.yml:12](/Users/zhb/Documents/OCard/.github/workflows/release.yml:12)。新 tag runner 将因 sidecar 文件不存在而无法打包。

## 新发现 P1

- **P1-NEW-1：FFmpeg 安全及色彩合同未落实。** 决策要求 `-protocol_whitelist file` [2026-08-24-m3-plan.md:14](/Users/zhb/Documents/OCard/docs/superpowers/plans/2026-08-24-m3-plan.md:14)，代码完全没有；计划要求验证色彩标签 [2026-08-24-m3-plan.md:103](/Users/zhb/Documents/OCard/docs/superpowers/plans/2026-08-24-m3-plan.md:103)，实现却把它声明为未支持边界 [transcode.rs:7](/Users/zhb/Documents/OCard/src-tauri/src/core/transcode.rs:7)。这不是允许豁免的三类边界。

- **P1-NEW-2：存在即成功会永久接受损坏输出。** proxy/auto/archive 对最终文件只检查存在 [transcode_cmds.rs:469](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:469)、[transcode_cmds.rs:942](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:942)。预先放置空文件即可被计作已完成，auto manifest 也会错误闭合。

- **P1-NEW-3：取消后发布虚假进度。** proxy 无论取消位置都写 `progress(total,total)` [transcode_cmds.rs:584](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:584)，UI 又显示“已完成 done/total” [TranscodeScreen.tsx:425](/Users/zhb/Documents/OCard/src/screens/TranscodeScreen.tsx:425)。取消第 1/N 个文件后仍显示 N/N。

- **P1-NEW-4：分析缓存缺模型身份，推理失败被伪装为无人脸。** FeatureRecord 没有计划要求的模型 SHA/预处理版本 [analysis.rs:29](/Users/zhb/Documents/OCard/src-tauri/src/core/analysis.rs:29)，加载只校验 schema/algo [analysis.rs:112](/Users/zhb/Documents/OCard/src-tauri/src/core/analysis.rs:112)；YuNet 错误转成 `faces=0` 并缓存，违反零静默。

- **P1-NEW-5：YuNet 结果没有进入前端用户面。** 后端 judgment 包含 faces [analysis.rs:249](/Users/zhb/Documents/OCard/src-tauri/src/core/analysis.rs:249)，TS `AssetJudgement` 和 badge 均不包含人脸结果 [types.ts:653](/Users/zhb/Documents/OCard/src/types.ts:653)、[SortingScreen.tsx:1187](/Users/zhb/Documents/OCard/src/screens/SortingScreen.tsx:1187)。M3 宣称的 AI 人脸筛选不可观察。

- **P1-NEW-6：Final Cut 扫描可重入且有陈旧响应覆盖。** 前端每 7 秒启动一次完整扫描，没有 in-flight/序列保护 [FinalCutPanel.tsx:18](/Users/zhb/Documents/OCard/src/components/FinalCutPanel.tsx:18)，后端又逐文件执行最长 30 秒 ffprobe [finalcut_cmds.rs:92](/Users/zhb/Documents/OCard/src-tauri/src/commands/finalcut_cmds.rs:92)。大量素材时会持续叠加进程，并由旧请求覆盖新结果；交付状态 polling 与 toggle 也有同类竞态。

- **P1-NEW-7：Final Cut/交付状态读取未过 canonical 闸门。** proxy 目录、flow-hints 和 delivery status 均直接从拼接路径读取 [finalcut_cmds.rs:56](/Users/zhb/Documents/OCard/src-tauri/src/commands/finalcut_cmds.rs:56)、[finalcut_cmds.rs:164](/Users/zhb/Documents/OCard/src-tauri/src/commands/finalcut_cmds.rs:164)、[finalcut_cmds.rs:217](/Users/zhb/Documents/OCard/src-tauri/src/commands/finalcut_cmds.rs:217)，中间符号链接可读取项目外内容。

- **P1-NEW-8：时间戳“保留”仍会静默失真。** copy 在读取/哈希之后才采集 atime [copy.rs:313](/Users/zhb/Documents/OCard/src-tauri/src/core/copy.rs:313)，读取本身可能已经更新 atime；元数据获取失败又被静默忽略 [fsx.rs:202](/Users/zhb/Documents/OCard/src-tauri/src/core/fsx.rs:202)。现有测试只覆盖 mtime/macOS creation time，不覆盖 atime。

- **P1-NEW-9：确认退出不会停止 copy task。** 关闭处理器识别复制任务，却只取消 JobManager 和登记过的 ffmpeg 进程 [lib.rs:182](/Users/zhb/Documents/OCard/src-tauri/src/lib.rs:182)。用户确认退出时复制仍可能停在半写文件。

- **P1-NEW-10：CI 完整性验证与权限模型仍不合格。** ffprobe 未做 SHA 校验，运行时 `detect()` 也不执行 ffprobe [ffmpeg.rs:89](/Users/zhb/Documents/OCard/src-tauri/src/core/ffmpeg.rs:89)；E2E job 在执行 PR 代码时取得 `contents: write` 并无条件 force-push 截图 [ci.yml:194](/Users/zhb/Documents/OCard/.github/workflows/ci.yml:194)、[ci.yml:258](/Users/zhb/Documents/OCard/.github/workflows/ci.yml:258)，扩大供应链权限且会让无写权限来源出现测试后假红。

- **P1-NEW-11：M3 验收测试面仍不真实。** 没有 archive、Final Cut、analysis、cancel、符号链接闸门或完整 timestamp E2E；PRD 的 1000 张 24MP/5 分钟目标 [2026-08-24-ocard-prd.md:170](/Users/zhb/Documents/OCard/docs/superpowers/specs/2026-08-24-ocard-prd.md:170) 只有被忽略的合成外推测试 [analysis.rs:528](/Users/zhb/Documents/OCard/src-tauri/src/core/analysis.rs:528)，其注释明确说明不是 SLA 证明。

## P2

- `TranscodeJobResult` 后端已有 `mode`，TS 仍遗漏并依靠字段形状推断 [types.ts:535](/Users/zhb/Documents/OCard/src/types.ts:535)，修复宣称只闭合了后端。
- Final Cut mismatch 后端为字符串原因 [finalcut_cmds.rs:29](/Users/zhb/Documents/OCard/src-tauri/src/commands/finalcut_cmds.rs:29)，TS 定义为布尔值 [types.ts:682](/Users/zhb/Documents/OCard/src/types.ts:682)，UI 丢失具体原因。
- 对已终态 job 调用 cancel 仍设置标志并提示“将停止” [jobs.rs:232](/Users/zhb/Documents/OCard/src-tauri/src/core/jobs.rs:232)，属于误导性状态反馈。
- convergence 声称的 Final Cut E2E、sharpness 边界测试和 finalcut 名称边界测试均未出现。

Linux btime、Windows uncached read、Windows 集成测试 gate 按题目要求未计问题；GitHub 当前 macOS runner 架构也已对照[官方 Hosted Runners 表](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)，未作为缺陷提出。

综上，原问题中仍有大量“部分闭合”，并新增至少 6 个 P0，尤其是 manifest 任意路径、符号链接逃逸、真实相机嵌套目录完全漏转以及 Release 无法从干净 checkout 构建。当前 HEAD 不满足路径闸门、零静默及可交付构建三条基本收口条件。

REVIEW_DONE
