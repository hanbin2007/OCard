**终审结论**
# 终审:不通过

R4 确实补上了归档零副作用闸、部分项目根检查、时长 fail-closed、退化计数等重要内容，但原九项必修中只有第 3 项完整闭环。其余多项仍能被上一票的核心反例或相邻变体击穿，不能作为 M3 放行版本。

本票始终以指定对象 `64febca58e133a18f6e656062db400cd367f7726` 的 `git show` 内容为准。评审期间工作树被外部推进到 `7050d29`，该后续提交未计入结论。全程只读，未改文件，也未运行会产生构建产物的测试。

**阻塞发现**
1. **P0，resume 仍会把同大小源文件篡改误判为完成。**  
   [`file_done`](/Users/zhb/Documents/OCard/src-tauri/src/core/copy.rs:135) 只重新哈希目标文件，不接收也不检查源根。源文件同大小变化而目标仍匹配旧 manifest 时，会直接 `SkippedResume`。源祖先闸和目标路径闸都位于后续 `copy_one`，因此 resume 命中会绕过它们。新增测试只篡改目标文件，未覆盖该反例。

2. **P0，resume 的目标祖先闸也不完整。**  
   `file_done` 仅拒绝最终目标是 symlink，没有对目标根及中间祖先执行 `assert_within`。新增测试覆盖的是最终文件 symlink，不是目标根或中间目录链接。并且任务预统计和正式复制各调用一次 `file_done`，已验证产物会被全量哈希两遍，既昂贵又没有换来正确性。

3. **P0，既有转码产物仍无来源身份验证。**  
   [`verify_output`](/Users/zhb/Documents/OCard/src-tauri/src/core/transcode.rs:386) 增加了时长校验，但没有源指纹或可信 sidecar。同样时长、codec、pix_fmt、音频形态的视频，即使来自另一源文件仍会通过。代理对小于目标高度的源不校验高度，归档传入 `None`，不校验完整几何尺寸。第四轮真 ffmpeg 测试只证明 1 秒产物不能冒充 3 秒源，未覆盖同长度错源、错分辨率及归档路径。

4. **P0，项目状态读边界仍可跟随链接。**  
   [`manifest::list`](/Users/zhb/Documents/OCard/src-tauri/src/core/manifest.rs:140) 没有 canonical 闸；[`journal::read_all`](/Users/zhb/Documents/OCard/src-tauri/src/core/journal.rs:88) 和 [`analysis::load_features`](/Users/zhb/Documents/OCard/src-tauri/src/core/analysis.rs:126) 只检查目录，没有检查其中每个文件。单个 manifest、journal 或 features 文件 symlink 仍可读入项目外内容，manifest 还会被启动恢复和重建流程消费。现有测试只覆盖整个 `.ocard` 或项目目录链接。

5. **P0，`faces_model` 只是记账字段，没有进入缓存裁决。**  
   [`FeatureRecord::cache_hit`](/Users/zhb/Documents/OCard/src-tauri/src/core/analysis.rs:55) 仍只看 `faces.is_some()` 和 detector 是否存在，不比较当前模型身份，也没有预处理版本。旧模型得到的 `Some` 会永久命中；冲突合并同样无条件偏好任意 `Some`。新增测试是布尔及合并单测，没有覆盖模型变化、推理失败、缺失模型后恢复的端到端重算。

6. **P0，取消与完成仍不是同一原子裁决。**  
   [`finish`](/Users/zhb/Documents/OCard/src-tauri/src/core/jobs.rs:140) 在状态锁内读取另一个 atomic cancel；[`request_cancel`](/Users/zhb/Documents/OCard/src-tauri/src/core/jobs.rs:265) 先释放状态锁再设置 cancel。仍存在“取消读到 Running，finish 读到 false，取消置 true，finish 写 Done”的交错。新增测试没有强制这个窗口。guard 获取失败还会手写 Failed，绕过统一 `finish`。

7. **P0，转码 intent 和终态审计仍有出口缺口。**  
   [`TranscodeExitGuard`](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:448) 在 job body 内才创建，排队期间取消的自动代理任务不会进入 body，intent 无法释放。Drop 又先释放 intent、后写失败审计，存在重新调度窗口；正常路径先 disarm、后追加终态审计，审计异常时失去兜底。

8. **P1，时间戳仍未统一在首次读取前采集。**  
   部分目标恢复时，复制流程先哈希源文件，之后才取 [`src_meta`](/Users/zhb/Documents/OCard/src-tauri/src/core/copy.rs:376)。交付流程在 [`exif_shot_naive`](/Users/zhb/Documents/OCard/src-tauri/src/core/packaging.rs:303) 读取源后，才进入 `deliver_one` 采集元数据。新增测试没有实际改变并断言 atime/created，仅保留了 mtime 类覆盖。

9. **P1，错误即空集和缩略图缓存验真仍不真实。**  
   Final Cut flow hints 仍使用 [`flatten`/`unwrap_or(false)`](/Users/zhb/Documents/OCard/src-tauri/src/commands/finalcut_cmds.rs:176)，features 枚举也仍有 `entries.flatten()`。视频缩略图只检查 JPEG 首尾标记；测试中的 5 字节“JPEG”并不可解码。损坏缓存直接返回失败而不删除重建，ffmpeg 新输出 rename 后也不再验真，测试没有实际覆盖 `AlreadyExists` 竞争分支。

**九项复核**

| 上一票必修 | 复核结果 |
|---|---|
| 1. canonical 项目根与所有状态读写 | 部分落地，未通过 |
| 2. resume 哈希、源/目标祖先闸 | 部分落地，未通过 |
| 3. 归档 canonical_projection 先于副作用 | 已闭环 |
| 4. 既有转码产物完整验证 | 仅时长等属性，未通过 |
| 5. 首次读取前采集时间戳 | 部分落地，未通过 |
| 6. 消灭错误转空集 | 仍有明确残留，未通过 |
| 7. faces 模型及预处理身份、自愈 | 字段已加，语义未闭环 |
| 8. 出口审计、intent、原子终态 | 部分落地，未通过 |
| 9. 账面及针对性测试 | 仍不完整 |

源码统计显示相对父提交新增 **13 个** Rust `#[test]` 函数，不是 15 个独立测试；另有既有 ffmpeg 测试扩展第四轮。R3 文档仍同时保留 “A1-A14 Blocked” 和旧处置文字，账面互相矛盾。

另外，指定对象 64 仍包含后续 `7050d29` 专门修正的 `clippy::question_mark` 写法，而 CI 明确执行 `cargo clippy --all-targets -- -D warnings`。因此 64 本身也没有可接受的 lint 绿章。

**可交接遗留**
Linux 无法恢复 birthtime、真实 VAAPI/nv12 硬件覆盖、24MP 千张性能 SLA、YuNet 召回率、ORT 供应链和窄 TOCTOU 可继续作为声明边界。全局退化计数在并发任务间归因不精确、best-effort 清理中的部分 `flatten` 可列 P2。

**最小必修清单**
1. 将 resume 做成一次性裁决：先闸住源和所有目标根/祖先，再校验源与全部目标哈希；补源同大小篡改、目标根及中间链接测试，并去掉双重哈希。
2. 给 manifest、journal、features 目录及每个条目统一加项目根读闸，缓存键命中前同样验证，并消除 correctness 路径的错误转空集。
3. 为代理和归档建立绑定源指纹的 provenance，完整校验尺寸/宽高比；补同长度错源、错尺寸及归档测试。
4. 将模型和预处理身份纳入缓存命中及冲突合并，补模型变更和恢复后的端到端重算测试。
5. 用同一同步域原子裁决 cancel/terminal state，覆盖 guard 获取失败；保证排队取消也释放 intent，并先持久化终态审计再开放重调度。
6. 在任何 EXIF、哈希或复制读取前采集源元数据，补真正的 atime/created 变更测试。
7. 用真实 JPEG 解码验证缓存，损坏时原子重建；修正测试数量和 R3 状态文字，并让指定放行对象通过完整 CI。

REVIEW_DONE
