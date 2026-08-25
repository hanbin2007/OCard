**终审结论**

终审:不通过

审查对象为 `0e1352760d8ad1a5d3e3b43d1f4b5b0d93858e31`，HEAD 一致且工作树干净。全程只读；因测试会生成 `target` 和临时素材，未重新执行测试，`200/0` 与 clippy 结果不作为独立证据，仅复核代码及测试源码。

R5 已实质修复模型缓存、状态文件读闸、取消终态竞争等问题，但仍有以下数据安全及静默成功级缺口。

**P0 阻塞发现**

1. **目的地根的上级符号链接仍可绕过布局检查，把“备份”写回源卡。**

   [`validate_dest_layout`](/Users/zhb/Documents/OCard/src-tauri/src/core/paths.rs:56)只做词法比较。若源为 `/Volumes/CARD`，目的地为 `/tmp/link/backup`，而 `/tmp/link -> /Volumes/CARD`，布局检查会通过。

   正常拷贝随后在 [`copy.rs:436`](/Users/zhb/Documents/OCard/src-tauri/src/core/copy.rs:436)先执行 `create_dir_all(root)`，已经在源卡内创建目录；后续 `ensure_dir_within(root, parent)`只证明目标位于这个已经解析到源卡的根内，无法发现源/目的地实际重叠。resume 的 [`file_done`](/Users/zhb/Documents/OCard/src-tauri/src/core/copy.rs:178)同样把目的地自身的 canonical 路径作为信任根，因此可能把源卡上的所谓备份判成完成。

   新测试只覆盖 `dest/DCIM` 链到根外，没有覆盖“目的地根的祖先链回源卡”。这可能产生假绿灯，用户格式化源卡时同时丢失所谓备份，属于明确 P0。

2. **provenance 写入既不路径安全，也不 fail-closed。**

   [`write_provenance`](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:262)使用可预测的 `<产物>.src.json.tmp`，直接 `fs::write`，且忽略 rename 失败。预置该 tmp 为指向项目外文件的链接，会让 `fs::write` 跟随链接并截断外部文件。

   所有写入错误和源 metadata 错误都被吞掉，但代理和归档调用方仍立即增加 `converted`，[代理路径](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:813)和[归档路径](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:1451)均如此。auto-proxy 随后还可能写 `proxy_completed`，形成静默成功。

3. **sidecar 没有绑定产物本身，完整尺寸校验仍有明确漏口。**

   [`provenance_matches`](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:274)只比较当前源的 metadata 指纹，sidecar 不含产物哈希。先保留 C0001 的正确 sidecar，再仅用同时长、同几何的 C0002 视频替换 C0001 产物，来源指纹仍匹配，ffprobe 属性也可全部通过，错误素材会被静默计为 `alreadyTranscoded`。

   第五轮测试明确构造的是“无 sidecar”产物，[只证明缺 sidecar 会拒绝](/Users/zhb/Documents/OCard/src-tauri/src/commands/integration_tests.rs:892)，没有覆盖上述 stale-sidecar 反例。

   此外代理参数始终要求 `scale=-2:1080`，[但验证仅在源高度大于 1080 时要求输出为 1080](/Users/zhb/Documents/OCard/src-tauri/src/core/transcode.rs:400)。360p 源对应的 720p 同比例产物仍会通过，尚不能称为完整尺寸校验。

**七项复核**

| 必修项 | 结论 |
|---|---|
| 1. resume 一次性裁决 | 同大小源/目标篡改和目标内部祖先链接已修；目的地根上级链接回源卡仍为 P0 |
| 2. 状态目录、逐文件读闸、flatten 清零 | 代码闭环 |
| 3. provenance、几何与宽高比 | 未闭环，存在上述两个 P0 |
| 4. `faces_rank` 缓存及冲突合并 | 闭环 |
| 5. cancel/finish 原子裁决 | 闭环 |
| 6. intent 与审计出口 | 主路径闭环；仍有窄竞态，列为 P2 |
| 7. 时间戳与视频缩略图 | 生产代码大部落地，但仍有 P1/P2 证据缺口 |

**交接遗留**

- **P1：**resume 修复目标时，`run_copy` 先由 [`file_done` 哈希源](/Users/zhb/Documents/OCard/src-tauri/src/core/copy.rs:172)，失败后才进入 `copy_one` 获取 [`src_meta`](/Users/zhb/Documents/OCard/src-tauri/src/core/copy.rs:346)，因此保存的 atime 仍可能是验证读取后的值。
- **P2：**intent claim 与 bind 并非注释所称的同一临界区。作业在 [`jobs.create`](/Users/zhb/Documents/OCard/src-tauri/src/commands/transcode_cmds.rs:461)后已可见，随后才 bind；若此间被排队取消，按 job 释放看不到仍为 `None` 的绑定，可能卡到重启。
- **P2：**R5 实际新增 5 个 `#[test]` 函数并扩展既有测试，不是文档所写的“再 +7”。created 测试没有预先拉开源/目标 birthtime，空实现也可能通过两秒容差；视频缩略图假 ffmpeg 仍输出不可解码的 5 字节伪 JPEG，未证明坏缓存能够成功重建。
- **P2/边界：**宽高比比较未解析 rotation 与 sample aspect ratio，旋转或非方形像素素材可能被可见地误拒，可补测或明确声明。

**最小必修清单**

1. 在任何目录创建前，对源和全部目的地做 `canonical_projection`，以真实投影重新执行双向嵌套和重复目标检查；补“目的地祖先链回源卡且零副作用”的 start/resume 测试。
2. 将 provenance 写入改为返回 `Result` 的安全原子操作，使用不可跟随链接的独占临时文件；落盘失败必须计入 failure，且不得标记 converted/proxy_completed。
3. sidecar 记录并复核产物哈希，补“保留正确 sidecar、只替换视频”的反例；同时按生产滤镜计算精确预期尺寸，并覆盖低分辨率代理、错尺寸和归档路径。

REVIEW_DONE
