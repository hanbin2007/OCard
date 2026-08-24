# M2 实现评审收敛(2026-08-24)

双路:Claude opus(实跑双套件,51 次工具调用)+ gpt-5.6-sol(max)。**共同终判:不可收口。**
最刺眼的教训:M1 缺陷模式在 M2 新模块原样复发(路径不设防、exists+rename),而正确原语(`paths::normalize_lexical`、`fsx::rename_no_replace`)就在同一 crate 里没被调用。

## 收口硬门槛(P0/致命,全修)

| # | 问题(两路来源) | 修法 |
|---|---|---|
| 1 | asset_ids/original_path 路径逃逸,组合 empty_trash 成任意文件删除原语;Windows 反斜杠整体替换逃逸(Claude F1) | `resolve_in_project` 闸:拒 ParentDir/Root/Prefix/反斜杠,归一后断言在项目根内;move/curate/trash/restore 全走它;restore 的 original_path 按不可信输入处理;4 条逃逸测试 |
| 2 | 打包复制非原子:断连留截断文件,重跑标 already-exists 假安全(codex P0-4 + Claude H5 同名碰撞) | `.part` staging + fsx::rename_no_replace;已存在时 hash 比对:相同=verified-skip,不同=`name-collision` 机器码前端单列「未交付」 |
| 3 | 清单写失败 `?` 抛出,丢弃整个已完成交付结果+审计不落痕(Claude H1) | 清单失败降级为 failures 项+notify,函数返回 Ok;审计带 manifest_written |
| 4 | 清单被本轮结果整体覆盖,重跑后口径错误(Claude M5/codex) | 清单从目标包目录实况生成,原子替换 |
| 5 | trash 回滚失败裸 `let _` 且报文说谎;孤儿不可见(Claude H2) | 回滚失败如实报「文件滞留 trash」+notify::error;list_trash 把有实体无索引的孤儿计入并上报 |
| 6 | empty_trash 删整个索引,蒸发并发机器刚写的行(Claude H3) | 只重写过滤已删 id 的索引,原子替换;list_trash 与 empty 的窗口语义写明 |
| 7 | sorting move/restore 用 exists+rename、curate 用 exists+copy(Claude H4) | 统一 fsx::rename_no_replace / File::create_new |
| 8 | 精选点击=移动而非复制,素材卡进无流程位置(codex 11) | 前端分类条精选走 curateAssets;后端 move 白名单拒绝 curated |
| 9 | EXIF 墙钟按 UTC 再转 Local,半天分包时区翻转且跨机不一致(codex 9) | 分包直接用 EXIF NaiveDateTime 墙钟判半天;mtime 回退用本地时间;补 11:59/12:00 用例 |

## 同批必修(P1)

10. ends_with("精选"/"其他") 误判自定义分类(Claude M1)→ 按下标判定 + 保留名校验(前后端)
11. 缩略图 tmp 跨机撞车 + 损坏缓存永存(Claude M2/codex 7)→ 唯一 tmp 名 + no-replace + 命中时 JPEG 头尾校验
12. 索引线程 panic 无兜底、移走文件误报损坏(Claude M3)→ catch_unwind + NotFound 不计 failed
13. 索引完成当前页不刷新、监听未等 ready(codex 6)→ 事件驱动页刷新 + ready 串行
14. 通知同 code 高频冲刷积压,挤掉待确认 error(Claude M6)→ emit_notice 同 code 时间窗合并计数
15. ensure_indexing 判据换清单指纹(Claude M4)
16. 分类/回收站初始加载 fail-open(codex 13)→ error 态+重试入口,失败不渲染空态
17. 卡指纹写入前无卷白名单校验、并发 create 不原子(codex 12)→ 先验卷再写;create_new 竞选失败重读
18. uid 分支「未挂载/不匹配」报文区分(Claude L3)
19. emptyTrash 契约对齐 {removed}(L1/codex 16);AssetKind Other 契约加 "other"(L4)
20. 小项:L2 注释、L9 空 taskId 跳过、L6 unavailable 项目切换重置

## 修复落地记录(2026-08-24)

- `3b340a7` Rust 侧:P0 全部九项 + P1 中 10/11/12/14/15/17/18/19 后端半;Rust 69→87 测试
  (四组路径逃逸、篡改索引 restore 拒绝、stored_as 越界坏行、跨机并发行保留、
  只读目录删除失败降级、打包 name-collision/清单注入、EXIF 11:59-12:00 边界、
  损坏缩略图自愈、保留名拒绝、uid 报文区分)。
- `fc246cc` E2E:M2 分类流冒烟(建项目→注入素材→分类移动→两段删除→交付打包,磁盘断言);
  trash 滞留升级 error 通知(H2 收尾)。
- 前端两波(合并提交):#8/#13/#16/#19/#20 + 契约对齐
  (alreadyDelivered 正常块、name-collision+error 归「未交付」、manifest-error 单列黄块、
  缺省 kind 按真失败、missing 单列、repeats 增量计数、mock 同步);324→348 测试,
  关键项变异验证(其中两条无效测试被变异揪出后重写)。
- 待复验轮裁决:上述全部,以及计划修订区各项的宣称是否成立。

## 计划修订(记入 M2 语义宣称,架构项排 M3 前置批)

- 交付打包后台线程化+进度/取消+与分类互斥(codex 5/Claude M8):M2 交付为同步阻塞式,确认屏明示「打包期间请勿分类」;线程化归 M3 前置。
- 两机分类事件重放/分页 snapshot cursor(codex 8):M2 为「先 rename 者胜 + 跨机横幅提示」,PRD §6.3 的完整重放语义归 M3 前置。
- IPC 缩略图懒取/字节预算(codex 10):M2 页 200 张约 5MB 可用;资源协议懒取归 M3 前置。
- 每命令全 NAS 扫描的性能(Claude M7):ProjectStats 缓存归 M3 前置。
- sortedCount/delivering/done 状态折叠、绕缓存读能力模式上报(codex 14/15):M3 前置。
- E2E 扩展:分类流冒烟(建项目→注入素材→分类→打包磁盘断言)本批补。
