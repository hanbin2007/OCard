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
