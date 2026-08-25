**终审结论**

终审:通过

审查基准为 `74ce9c400a1426c039e8d764d3b24474783daf2a`，HEAD 一致，工作树干净。未发现数据安全、静默成功或功能整体失效级阻塞。

**三条闭环核对**

1. **目的地 canonical 投影：闭环。**  
   [`validate_dest_layout_projected`](/Users/zhb/Documents/OCard/src-tauri/src/core/paths.rs:252)先做词法检查，再投影源及全部目的地，复检双向嵌套和重复目标。开拷入口在[mod.rs](/Users/zhb/Documents/OCard/src-tauri/src/commands/mod.rs:511)，续传入口在[tasks.rs](/Users/zhb/Documents/OCard/src-tauri/src/commands/tasks.rs:219)接入；两者均早于目的地目录创建。判别力测试确实证明“词法放行、投影拒绝”。

2. **provenance 安全及 fail-closed：实质闭环。**  
   [`write_provenance`](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:266)改为 `Result`，使用 UUID 临时名、终名链接检查和 `rename_no_replace`。代理与归档写入失败均进入失败清单，不增加 `converted`；自动代理仅在零失败时写 `proxy_completed`，[条件明确成立](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:923)。

3. **产物绑定及几何验证：闭环。**  
   sidecar 写入 `outXxh3`，复用既有产物时重新计算并比较产物哈希，[校验路径完整](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:289)。代理验证要求高度严格等于 1080、宽度按源比例和 `-2` 偶数规则限制在 ±2；归档严格维持源几何，[实现见 transcode.rs](/Users/zhb/Documents/OCard/src-tauri/src/core/transcode.rs:387)。640×360 真 ffmpeg 路径同时覆盖低分辨率放大。

**附带修复**

- `run_copy` 在 `file_done` 哈希前预采集源 metadata，修复验证读取污染 atime 的顺序问题，[接线正确](/Users/zhb/Documents/OCard/src-tauri/src/core/copy.rs:238)。
- created 测试已预拉开 45 天，不再可能由空实现靠容差混过。
- 视频缩略图测试现同时证明坏缓存可重建为真 JPEG，以及不可解码新产物会被清理。

**P2 交接遗留**

- provenance 临时文件目前仍由 `std::fs::write` 创建，并非字面意义上的 `create_new` 独占打开，也没有独立的临时路径拒链接操作。UUID 已消除原来可预测文件名的现实攻击面，因此不按终审尺度阻塞；后续宜改为 `OpenOptions::create_new(true)`，并清理部分写入失败留下的临时文件。
- “保留 sidecar、替换视频”轮使用 1 秒与 3 秒产物，虽然哈希专属报文断言能锁住校验接线，但最强证据仍可补成“同时间、同几何、保留 sidecar、只换视频”。
- provenance 写失败的计数和 `proxy_completed` 行为尚无专门故障注入测试；生产分支静态闭环。
- rotation/SAR 可见误拒、intent claim 到 bind 微窗口，以及目录校验后的外部替换竞态，继续按已声明边界交接。

全程只读，未执行会生成 `target` 或临时素材的 `cargo test`、clippy；`201/0` 和 clippy 结果未作为独立证据。已执行的 `git diff --check` 无格式问题。CI 绿章仍应作为发布流程门槛，但不改变本次代码终审通过结论。

REVIEW_DONE
