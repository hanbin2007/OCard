# M3 实现评审收敛(2026-08-24)

双路:opus(实跑三套件+基准,80 次工具调用)+ gpt-5.6-sol(max,实跑含 mac release 构建)。
**共同终判:不可收口。** 骨架获双路肯定(状态机/互斥矩阵/特征协议/路径闸族/YuNet 数学/
零静默 code 表大部/单次解码宣称属实);缺口集中在收口面与账面一致性。
本轮新教训:纪律条款(每波挂网、测试随波)在 W3 后失守;heredoc 内嵌 python 编辑
失败但命令链非 && 连接照常提交(脚本替换教训第三次变体)。

## P0(全修)

| # | 问题 | 修法 |
|---|---|---|
| 1 | thumb:// 未做 percent 解码:中文项目名(规范必然)缩略图 100% 404(opus;tauri 内置协议全都先 decode) | 处理器 percent_decode 后再进闸;补「编码中文/空格路径」测试 |
| 2 | CI installer 校验假绿:`set -e` 豁免 `&&` 左操作数,ffmpeg 缺失照样绿;无 SHA、无模型、查构建目录非安装包(opus 实跑复现) | 重写 fail-closed(逐条 if ! then exit)、加 sidecar SHA-256+模型校验、Linux 解包 .deb 验内容、case 加 `*)` 兜底;Windows 安装包内容核查以 mac/linux 腿覆盖同一打包路径为声明边界 |
| 3 | request_cancel 对 running 作业当场终态化:guard 仍被 worker 持有但 any_active=false → 更新闸提前放行、前端互斥态错乱;注释里的 finish_cancelled 不存在(双路) | running 只置 cancel 标志,终态由 worker 在安全点发布;queued 才直接终态;jobs 单测补「running 取消期间 any_active 仍真」 |
| 4 | auto_proxy 恶性状态也永久标完成:空 work、目录读错被吞、同名碰撞误报 already-transcoded 时 proxy_completed=true(codex 定点推演) | 完成条件加:work 非空、无目录读错;读错入 failures 可见;同名碰撞修复见 P1-3 |

## P1(同批必修)

5. 强制全转文案承诺重转、后端只跳判定;强制重转入口整体缺席(D2 明定)→ 后端加
   `retranscode`(先删后转,唯一覆盖入口),前端二次确认;文案改真话。
6. 代理输出名 `{stem}_proxy.mp4` 跨扩展名/大小写碰撞误报已转码 → 名带源扩展名
   `{stem}_{ext}_proxy.mp4`。
7. auto_proxy 多卡本会话丢投递(has_active 挡在 lane 队列之外)→ 派发路径允许排队
   (lane 串行天然消化),UI 手动路径保留防重;启动重放同项目多意图全投。
8. 永久失败无限重投 → manifest 记 proxy_attempts,≥3 放弃+audit+可见通知。
9. 连拍组展开层选中走裸 assetId,分类/精选/标删三路静默无效(前端)。
10. 预览双击/回车用 entries 下标索引 assets 数组,折叠/筛选后开错图(前端)。
11. 分析角标第二轮不刷新:per-job revision 被当全局令牌(前端,按 jobId+终态判)。
12. E2E 幂等断言空(transcode-already 无条件渲染)→ 真断言(重跑前后 proxy mtime
    不变 + 结果计数文本)。
13. 集成网 W2 后冻结,九个新命令零挂网;resolve_asset_a 零测试 → 补挂+补测。
14. PRD 账面:闭眼/embedding→纯算法/GPU EP 顺延未入 §5.5;c44ef94 宣称的 PRD 修改
    实际未落盘 → 全量核对后修正(用 Edit 工具,提交前 grep 验证)。
15. W6 归档转码只有纯函数未接线(PRD §5.6 承诺)→ 归档作业命令+UI+
    validate_dest_layout+空间预检+测试。
16. 视频首帧图(media.rs M2 记账)→ 分析作业对 Video 用 ffmpeg 抽帧进缩略图缓存
    (引擎缺失保持占位+既有 ffmpeg-missing 提示)。
17. RemoteActivityBanner 不显示他机转码(W6 明定)→ list_remote_activity 折叠
    transcode_started/completed。
18. 应用退出无活跃作业确认(D2)→ CloseRequested:有活跃作业先拦+提示,
    确认后取消作业(kill 子进程)再退。
19. staging 启动清理+可见提示(D2)→ 作业开始时全输出根清本机残留,数量入通知。
20. 零静默补漏:`disk-space-insufficient` code 落地(不足+无法探测都可见);
    `hwenc-fallback` 补 capabilities_blocking 路径;`job-cancelled` 覆盖排队取消与
    转码/分析取消;ai-models 语义对齐 D1(哈希不符=禁用 AI 硬失败,缺失=降级人脸并
    error);analysis-cache「结果本轮可用」改真话;flow_hints/analysis 目录读错上浮。
21. run_transcode 取消依赖 progress 行、无总超时 → 独立 watchdog(cancel+4h 上限)。
22. VAAPI 代理参数缺设备/hwupload,Linux 硬编必然白跑一遍 → proxy_args 按 encoder
    带 VAAPI 输入链(scale_vaapi)。
23. sharpness_region clamp min>max panic(小图贴边人脸)→ 边界数学修正+测试。
24. score 量纲:后端 0-100、前端低分阈值 0.4 → 前端阈值修正(前端)。
25. 分页组对齐:注释宣称「不跨页」实际会切断 → take 窗口尾部按组延展;
    分页 O(N) 特征重载 → 按 features 文件 mtime 的内存缓存。

## P2/账面(同批顺手)

- parse_final_cut 空段不一致(`__` 拒 `___` 放行)→ title 全下划线/空白拒;
  零宽高探测退化 → uncheckable 不标红;竖幅表达式死代码简化为 min(w,h)+注释。
- 组 id 前缀碰撞/重复 entry 防御、组内已选计数口径、GroupOverlay onError、
  listJobs 焦点对账/手动刷新、delivery-status 轮询(前端)。
- 注释与实况:jobs.rs finish_cancelled、transcode.rs 模块文档、catalog.rs 收窄理由
  (asset_count 实际来自 manifests——原理由错误,真实理由:TTL 简单且陈旧封顶更硬,
  指纹留作后续优化)、analysis.rs 直方图措辞、逻辑核措辞。
- D 波裁决记录文档补写(含 ORT spike 结果、闭眼 gate、SLA 依赖用户素材)。
- 成片校验 E2E spec;W3 失效路径补 2 测。

## 声明边界(双路认可或经裁决)

TTL 收窄(opus 裁决接受,理由改写如上);探测缓存键不含驱动标识(刷新按钮);
Windows 安装包内容核查由 mac/linux 腿覆盖;真实 1000×24MP SLA 报告依赖用户素材
(收口报告向用户征集);跨机分类重放/RAW 全解码维持 D5 顺延;YuNet 正脸召回率
以代码审查+空图零误报为界,行为级验收依赖真实样本(与 SLA 同批征集)。

---

# 第 2 轮复验(R2,基准 e267dd3)

双路独立复验(codex gpt-5.6-sol max ~60 万 token 只读核验;opus 腿实跑 148 测试
+ 12 项变异实验)。**双路一致判定:不可收口。**
两份完整报告存档于会话 scratchpad(m3-r2-codex-report.md / opus 报告见任务记录),
本节为合并后的处置清单。

## 主要一致结论

- 首轮 4 个 P0 的骨架修复扎实:percent-decode、cancel 语义、路径闸三项变异全部变红。
- 修复波自身留缺口:归档路径(落地闸/软编告警/staging 清理)系统性缺席代理路径已有的防护。
- 测试有效性重灾:12 项变异 9 项存活——时间戳保留三个调用点全删测试仍绿
  (根因:唯一测试用 fs::copy 造场景,macOS fs::copy 本身克隆时间戳,断言恒真);
  watchdog、VAAPI、sharpness_region、auto_proxy 链、cancel_job、list_remote_activity 零有效覆盖。

## R2 P0(合并,已抽验实锤)

1. **resume 清单任意路径**:planned rel 未校验 `..`/绝对路径即并入并 root.join(commands/mod.rs 合并处、copy.rs copy_one)。
2. **拷贝符号链接逃逸**:walk() 用跟随链接的 metadata();目的地中间目录无 canonical 闸。
3. **thumb/.ocard 中间组件无闸**:thumb 只查首尾;缩略图生成器、manifest/journal 直接读写 `.ocard`。
4. **归档输出祖先符号链接绕过**:validate 只查字符串前缀+末节点,写入 create_dir_all 不过闸。
5. **代理/归档不递归扫描**:相机夹只读第一层,真实嵌套结构(PRIVATE/M4ROOT/CLIP)零任务,auto_proxy 反复触顶后放弃。
6. **release.yml 无 sidecar 拉取**:三个 Release job 干净 runner 必失败,v0.3.0 无法出包。
7. **缩略图 EXIF 方向不定**(opus):索引路径不摆正、分析路径摆正,同一缓存键先到先得,竖拍缩略图方向随机且永久驻缓存。

## R2 P1(合并去重,必修)

后端:归档 hwenc-fallback 告警缺失;analysis 特征目录读错静默(收敛项 20 未兑现);
faces 推理失败记 0 并永久缓存(应 None+计数上报);已存在产物「存在即成功」不验有效性;
取消后发布 total/total 假进度;VAAPI 输出 nv12 与统一验证矩阵冲突、archive VAAPI 缺初始化链;
ffmpeg `-protocol_whitelist` 未落实、色彩标签验证未落实(计划明写,非可豁免边界);
时间戳:atime 在读后采集已失真、src metadata 获取失败静默;确认退出不停 copy task;
auto_proxy attempts/abandon 写盘 let _、无 intent 去重;analysis 缓存键 (count,max mtime) 过粗;
finalcut/delivery-status 路径无 canonical 闸;输出名大小写碰撞(clip.mov/clip.MOV)无测试;
CI:ffprobe 无 SHA 校验、Windows 模型无 SHA、find|head-1 pipefail SIGPIPE、
e2e-shots 对 fork PR 必红且 PR 全程持 contents:write。
前端(待动画批次落地后排它处理):mode 契约半落地(TS 仍结构嗅探);faces 结果无用户面;
FinalCutPanel 7s 全量扫描可重入+陈旧覆盖;mismatch 前后端类型不一致(string vs bool);
threshold 注释 0-1 陈旧。
测试补齐(成对承诺兑现):时间戳三调用点端到端 mtime 断言+告警拆线测;watchdog 卡死模拟;
VAAPI 参数 assert;sharpness_region 边界;auto_proxy 意图链挂网;cancel_job/list_remote_activity;
特征冲突断言确定性(现依赖 read_dir 顺序,变异实测无效);恒真断言清除(integration_tests dup)。

## R2 P2(顺手批/账面)

auto_proxy 计数写盘失败可见化;notify.rs level 注释补 info;「已取消」字符串分流改枚举;
used_encoder 末文件覆写;ALGO_VERSION 随 EXIF 摆正递增;PRD 文档矛盾清理
(RAW 全解码/GPU 表述与 D5 顺延冲突、「草案待确认」页眉、docs/PRD.md 指针);
终态 job 再 cancel 的误导反馈;A1-A14 台账在本文档补逐项映射;
jobs guard 释放窗口的后果在模块文档如实声明;ORT download-binaries 未纳入 SHA 钉死(声明或钉死)。

## 处置

按 P0 全修 + P1 全修 + 测试补齐开 R2 修复波;前端四项待 apple-design 动画批次交付后排它落地;
修复完成后进入 R3 复验(双路),通过后终审双票(gpt-5.6-sol max + fable-5)。

---

# A1-A14 宣称/实况台账(逐项映射,R1 源报告已归档)

源:R1 opus 实现评审报告(archives/2026-08-24-m3-r1-opus-report.md,自中断会话
机器的任务记录中完整恢复,解除 R3 的 Blocked 项)。逐项在当前 HEAD 的闭合映射:

| # | 原始发现(摘) | 闭合证据(HEAD) | 状态 |
|---|---|---|---|
| A1 | 测试网 W2 后冻结,9 个新命令零覆盖 | `m3_commands_wired_and_gated` 全命令挂网 + R3 M13a/b、M14a/b 行为级(cancel_job/dup/remote_activity) | ✅ |
| A2 | 归档只有纯函数,无命令/UI/落地闸 | `start_archive_transcode` + UI 三档 + validate_dest_layout + R2 canonical 祖先闸 + R3 M9 删闸红 | ✅ |
| A3 | 视频首帧图零实现 | analysis 作业 ffmpeg 抽帧进共享缓存(`AnalyzeOne::VideoThumb`),skipped 计数进结果与前端告警 | ✅ |
| A4 | 他机转码不呈现 | `list_remote_activity` 折叠 transcode_started/completed + 前端措辞;R3 M14a/b 删折叠/过滤均红 | ✅ |
| A5 | 宣称写入 PRD 实未改 | PRD 闭眼砍/embedding→纯算法/GPU 顺延全部落盘;R2 再修 libraw/GPU 矛盾与「草案」页眉;脚本替换纪律入 memory | ✅ |
| A6 | 无退出确认 | `on_window_event` CloseRequested 拦截 + 15s 二次确认强退(取消作业 + kill ffmpeg + R2 拷贝任务安全点暂停) | ✅ |
| A7 | 无启动期 staging 清理与提示 | 代理全输出根启动清理 + `transcode-staging-cleaned` notice;R2 归档补对称清理 | ✅ |
| A8 | disk-space-insufficient 不存在 | 代理/归档两路空间预检,不足与无法探测都发该 code | ✅ |
| A9 | 无 D 波裁决文档 | `2026-08-24-m3-decision-gate.md` | ✅ |
| A10 | CI 校验假绿/无 SHA/查错对象 | fail-closed 重写 → `scripts/verify-bundle.sh` 双边共用(ffmpeg/ffprobe/模型 SHA;dpkg 解包;release 三平台接入) | ✅ |
| A11 | W3 指纹收窄,失效路径测 1/3 | 收窄经裁决接受(理由已改写);缓存失效补测(worker/config-switch) | ✅(裁决) |
| A12 | 幂等断言为空 | E2E mtime 严格相等 + 目录精确清单;R3 M16 真 ffmpeg 行为级(验真/坏产物拒采信) | ✅ |
| A13 | 「不跨页」注释与实况不符 | 分页窗口尾部按组延展,注释与实况一致 | ✅ |
| A14 | finish_cancelled 幽灵注释 | `transition_from` 实现取消语义,注释清除;R3 M13a 行为级 | ✅ |

R2 codex 全量核验报告同批归档(archives/2026-08-24-m3-r2-codex-report.md)。
