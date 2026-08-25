# M3 决策门(D 波)裁决记录(2026-08-24)

计划 v2.1 要求 D 波产出裁决记录文档(评审 A9 补账)。

## D1 制品矩阵
- **ffmpeg**:三平台 GPL 静态构建,镜像于本仓 release `ffmpeg-b1`;
  Windows/Linux = BtbN n8.1 gpl,macOS arm64 = martin-riedl.de 9.0.1;
  SHA-256 清单 `src-tauri/binaries/SHA256SUMS.txt`,fetch 脚本 fail-closed;
  GPL 声明与源码获取 `docs/ffmpeg-license.md`;CI/Release 全 job 拉取+缓存;
  installer 内容校验(mac .app 实检+deb 解包实检+SHA;Windows 由同一打包路径的
  mac/linux 腿覆盖,声明边界)。
- **ORT spike:通过**——ort 2.0.0-rc(CPU EP)静态链接,无 dylib 分发矩阵;
  过程记录:rc.13 的 download 脚本需显式 `tls-rustls` feature,`ndarray` 集成
  broken 弃用(裸 (shape,Vec) 张量 API);构建期从 pyke 镜像下载 onnxruntime
  静态库(CI 网络依赖,声明)。**GPU EP(CoreML/DirectML)顺延**:非同一
  二进制的 feature 开关,三套矩阵不值当,验收基线本就是 CPU。
- **模型**:YuNet face_detection_yunet_2023mar.onnx(**MIT**,opencv_zoo),
  SHA-256 `8f2383e4...2fa4` 钉死入库+启动校验(哈希不符=禁用 AI 硬失败;
  缺失=降级无人脸+可见 error);LICENSE 入 `src-tauri/resources/models/`。
- **embedding 模型:砍**(opus 裁决采纳)——聚类用纯算法基线
  (时间邻近+dHash),同等效果、零模型/许可证/打包风险;实测不够再议。
- **闭眼:砍**(gate 触发)——无许可证干净且经真实样本验证的开闭眼模型;
  YuNet 5 点每眼仅 1 点,EAR 不可实现;PRD §5.5 已如实更新。

## D2 Job 协议
状态机合法转移表+终态不可逆+取消/完成 CAS 竞争(running 取消只置标志,
终态由 worker 发布——评审 P0-3 修正后完全合规);作业不持久化,幂等由输出
语义承担(already-transcoded skip / verified-skip);retranscode 为唯一覆盖入口
(前端二次确认,先删后转);auto_proxy 意图入 manifest,at-least-once 补投递
(attempts≥3 放弃+可见告知);退出确认+子进程登记强杀;staging 带
machineId+jobId,作业起点全根清理本机残留+可见提示。

## D3 互斥矩阵
OpsMutex Arc+owned guard;delivery↔sorting 互斥不变;transcode 独立 lane
(同 kind 串行+同项目防重,auto 补投递允许排队);analyze 不进互斥
(missing 语义);install_update 闸 = tasks.any_running ∪ jobs.any_active。

## D4 分析存储
每机 `features-<id>.jsonl` 纯追加;记录含源指纹/schema/算法版本/shot_at/faces;
读端版本全匹配才采信;冲突取 analyzedAt 最新、持平 machineId 字典序大;
不缓存 groupId(查询时确定性现算);列表分页尾部按组延展保证不跨页。

## D5 范围裁决
跨机分类事件重放/状态折叠、RAW libraw 全解码:顺延(M2 声明语义为长期);
「待修→已修」提示与交付「已上传」勾选:并入 M3 已交付;
真实 1000×24MP SLA 报告:依赖用户素材,收口报告中征集(合成基准
0.114s/张、18 核外推 ≈7s 仅作工程预验)。
