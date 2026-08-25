**终审结论**

终审:不通过。

指定基线为 `f1a3bf1277dda1b19eb2d96b85d1df5e93f5cd67`。开审时 HEAD 与之完全一致且工作树干净。评审过程中外部提交将 HEAD 推进到 `12ab7de`，只追加了 fable-5 票文档；本报告始终按 `f1a3bf1` 对象复核，未引用该追加票，也未修改任何文件。

**P0 阻塞项**

1. **resume 仍可把“存在且同大小”静默当成功。** [`file_done`](/Users/zhb/Documents/OCard/src-tauri/src/core/copy.rs:133)只检查 manifest 的 `verified`、路径和文件大小，不重验 manifest 中已有的 xxh3。源文件或任一目标被替换为同大小内容后，续传仍会 `SkippedResume` 并可能给出 `all_verified`。现有 M8 只测 `../` 篡改，[未覆盖同大小篡改](/Users/zhb/Documents/OCard/src-tauri/src/commands/integration_tests.rs:465)。

2. **resume 源/目标的真实路径没有全程锚定。** [`copy_one`](/Users/zhb/Documents/OCard/src-tauri/src/core/copy.rs:280)只拒绝最终源节点是链接，不拒绝祖先链接；扫描跳过链接后，resume 又会把 planned 项并回清单，因此 `DCIM -> 外部目录` 下的 planned 文件仍可被读取。已有目标也在路径闸前直接 `exists/hash`，[并可经链接被采信](/Users/zhb/Documents/OCard/src-tauri/src/core/copy.rs:293)。

3. **项目根与 `.ocard` 边界没有统一闭合。** catalog 用 `path.is_dir()` 跟随项目目录链接，[可把 NAS 外的 OCard 形状目录认作项目](/Users/zhb/Documents/OCard/src-tauri/src/core/catalog.rs:93)；`project.json`、manifest、journal、analysis 的读路径均直接读取，[没有 project-root canonical 闸](/Users/zhb/Documents/OCard/src-tauri/src/core/project.rs:147)。`thumb://` 又只锚定 NAS 根，[允许 `.ocard/thumbs` 链到同一 NAS 的其他项目](/Users/zhb/Documents/OCard/src-tauri/src/commands/thumb_proto.rs:62)。这是路径读取、状态注入和后续外部写入风险。

4. **视频缩略图写路径绕过 `.ocard` 中间组件闸。** [`extract_video_thumb`](/Users/zhb/Documents/OCard/src-tauri/src/commands/analysis_cmds.rs:287)直接对 `.ocard/thumbs` 执行 `create_dir_all`，没有调用 `ensure_dir_within`；链接可把 ffmpeg 临时文件和最终 JPEG 写出项目。已有缓存也只检查 `is_file`，损坏 JPEG 会被计为成功；其他失败被压成 `false`，前端却统一误报“转码引擎不可用”。

5. **归档祖先链接闸发生在副作用之后。** [`create_dir_all(out_root)`](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:942)先执行，随后才 canonicalize 并拒绝。`link/sub` 指回项目时，代码会先在项目内创建 `sub` 再报错。M9 只断言报错和无作业，[没有断言目录未被创建](/Users/zhb/Documents/OCard/src-tauri/src/commands/integration_tests.rs:625)。

6. **`existence != success` 只修成了“codec 存在”。** 代理和归档的既有输出分别只验 `h264`、`hevc`，[没有调用完整 `verify_output`](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:563)。有效但时长、分辨率、像素格式、音频、HDR 或来源错误的文件仍会计入完成；`verify_output` 自身还在任一 duration 缺失时放行，且不验宽度、比例或来源身份。M16 第三轮仅放置垃圾字节，[没有测试“合法但错误”的视频](/Users/zhb/Documents/OCard/src-tauri/src/commands/integration_tests.rs:789)。

7. **时间戳三调用点只有 copy 路径语义正确。** copy 在读源前抓 metadata；精选先 `fs::copy` 后抓 metadata，[交付甚至在复制和两次 hash 后才抓](/Users/zhb/Documents/OCard/src-tauri/src/core/packaging.rs:157)，原 atime 已可能改变。两处 metadata 失败又被静默忽略；[`preserve_times`](/Users/zhb/Documents/OCard/src-tauri/src/core/fsx.rs:207)也会静默跳过取不到的 mtime/atime/created 字段。M5-M7 只断言 mtime，未覆盖 atime、created 和 metadata 失败。

8. **仍有错误即空集的静默路径。** 代理和归档的顶层相机夹枚举使用 `.flatten()` 与 `file_type().unwrap_or(false)`，[整个相机夹可被静默漏掉](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:389)。特征缓存计算同样吞掉 `read_dir`、entry 和 metadata 错误，[零键还可能命中旧空缓存并抹掉 read_err](/Users/zhb/Documents/OCard/src-tauri/src/commands/sorting_cmds.rs:554)。递归 helper 正确，不代表入口已递归闭合。

9. **R2 已指出的模型身份缓存缺口仍未修。** 计划要求模型 SHA 和预处理版本，[R2 原报告也明确列出](/Users/zhb/Documents/OCard/docs/superpowers/reviews/archives/2026-08-24-m3-r2-codex-report.md:76)，但 [`FeatureRecord`](/Users/zhb/Documents/OCard/src-tauri/src/core/analysis.rs:29)仍无这些字段。模型缺失或单图推理失败会落盘 `faces=None`，下次即在 [`contains_key` 处永久 Cached](/Users/zhb/Documents/OCard/src-tauri/src/commands/analysis_cmds.rs:373)；修复模型后也不会补算，跨机“最新记录胜”还可能让坏机器覆盖有效人脸结果。

**闭合链抽验**

| 关键项 | HEAD 实况 | 判定 |
|---|---|---|
| resume 清单闸 | 入口和引擎均有词法闸；无 hash 重验、无祖先 canonical 闸 | 未闭合 |
| `.ocard` 中间组件闸 | manifest/journal/照片 JPEG 写闸闭合；视频写、项目状态读取和跨项目协议未闭合 | 未闭合 |
| 归档祖先链接闸 | 能拒绝，但已先创建目录 | 未闭合 |
| 递归扫描 | 递归 helper 和嵌套测试有效；顶层枚举仍静默吞错 | 部分闭合 |
| 时间戳三调用点 | 三处调用存在；精选/交付抓取顺序及失败可见性错误 | 未闭合 |
| existence≠success | 垃圾文件会拒绝；合法错误产物和来源身份仍放行 | 未闭合 |
| release sidecar | 三平台构建前均 fetch+SHA；Linux 解包、macOS 包内/签名链、Windows staging 均 fail-closed | 在声明边界内闭合 |
| A5 PRD 账面 | 闭眼砍、纯算法聚类、GPU/libraw 顺延已落盘；映射表仍称整个 AI 由 ONNX 实现 | 部分闭合 |

**P1 遗留**

1. 转码先写 `transcode_started`，随后多个 `?` 可直接失败，[只有正常尾部才写 terminal audit](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:351)。他机活动会长期假活跃，auto-proxy 的 `INTENTS_IN_FLIGHT` 也可能留到进程重启。

2. JobManager 的取消与完成不是真正 CAS：先检查 cancel，再另行写 result 和 transition Done，[中间到达的取消会输给 Done](/Users/zhb/Documents/OCard/src-tauri/src/core/jobs.rs:329)。

3. PRD 映射表仍写“AI 智能选片由本地 ONNX 模型实现”，与纯算法聚类/评分实况冲突；R3 文档还保留“A1-A14 不可达”和“F2 继续”的旧状态。A5 不能标成完全闭合。

4. macOS/Linux 的 uncached 系统调用返回值被忽略；退化虽不改变 hash 数学结果，但“介质回读”保证会无提示变成普通缓存读。

**声明边界**

可接受：Linux btime 不可设置；Windows uncached 普通读取回退；真实 VAAPI/nv12 硬件验收后置；真实 1000×24MP SLA 与 YuNet 召回依赖用户素材；macOS 签名改写 Mach-O 后以暂存 SHA、Developer ID、app 签名和 notarization 合围。

有条件接受：Windows 安装包只验 staging、ORT `download-binaries` 未独立钉死、真实 SLA 尚未完成。这些只能记作外部验收或供应链债，不能表述成“已实证”。

不能接受：faces Err 测试后置不能豁免永久 `faces=None` 缓存；取消窗口后置不能豁免现有 check/transition 竞态；Linux btime 边界不能覆盖精选/交付 atime 抓取错误。项目根链接、同 NAS 跨项目 `.ocard`、合法错误转码产物和缓存读错命中均是此前未声明的新边界。

**放行前必修**

1. 建立统一的 checked project root，catalog 拒绝 symlink/junction 项目，并让所有 `.ocard` 读写及 `thumb://` 以项目根作 canonical 锚。
2. resume 对源和每个目标做真实路径闸及 manifest hash 重验，覆盖同大小篡改、祖先链接和既有目标链接。
3. 将归档输出祖先闸移到任何 `create_dir_all` 之前，并增加“拒绝后零文件系统副作用”测试。
4. 既有代理/归档产物复用统一走完整验证，并增加来源身份/sidecar；必需 probe 字段缺失必须失败。
5. 三处复制都在首次读取前抓完整时间戳；任何字段或 metadata 获取失败必须计数告警，补 atime/created 变异测试。
6. 清除 M3 用户路径中的 `.flatten()`、`.ok()`、`unwrap_or(false)` 错误即空集行为，特别是顶层相机夹、features cache 和 flow hints。
7. FeatureRecord 加模型/预处理身份，并让 `faces=None` 在模型恢复后可重算；补缺模、推理 Err、修复后重跑和跨机冲突测试。
8. 用作用域清理保证所有转码出口写 terminal audit、释放 intent；把 cancel-vs-done 做成锁内原子裁决。
9. 修正 PRD/计划/R3 状态账面，再重跑对应变异、Rust/前端全量、E2E、真 ffmpeg 和真 YuNet。

本票遵守只读要求，未运行会生成 `target`、临时素材或截图的测试套件；测试判定来自对测试源码、M1-M17 变异记录及仓内全链路实证的逐项复核。上述反例均不在现有变异矩阵内，因此历史全绿不能覆盖这些阻塞项。

REVIEW_DONE
