# M1 实现评审收敛(2026-08-24)

两路独立评审:Claude opus(42 次工具调用逐行核实)+ gpt-5.6-sol(max effort,静态只读)。
**共同结论:M1 不可收口。** 骨架方向正确(临时名+回读校验+改名、逐文件 manifest、免锁 journal、DTO 契约层干净),但数据安全线上有交叉证实的致命/高危缺陷,最坏结果一致指向:**UI 显示"校验 100% 通过,可格式化",而素材实际被覆盖/漏拷/写错位置。**

## 修复集合(M1 收口硬门槛)

| # | 问题(两路编号) | 修法 | 归属 |
|---|---|---|---|
| 1 | 同名目标静默覆盖 + 跨任务临时文件竞态(F1/P0-2) | copy_one 目标已存在→哈希相同视为已完成、不同报 Conflict 绝不覆盖;part 名带任务 id;create_new | Rust |
| 2 | 续传假阳性:不核对目标存在(H2/P0-1) | is_done 增加逐目的地 stat(存在+尺寸);manifest 记录目的地列表已具备 | Rust |
| 3 | 换卡续传不校验源身份(M10/P0-1) | manifest 记源卷名,resume 时与当前挂载卷比对,不符拒绝 | Rust |
| 4 | 重启后任务不可续传(H3/P0-3) | 启动扫描各项目 completed=false 的 manifest 重建 paused 任务 | Rust |
| 5 | NAS 抖动→failed 死路(H4) | IO 类错误按 paused 收尾而非 failed;manifest 落盘失败=暂停点 | Rust |
| 6 | 空路径写 CWD / 路径不设防(H5/P1-5) | 后端强制绝对路径、拒绝源目标嵌套、volume_id 白名单校验;前端空行判错 | Rust+UI |
| 7 | 双确认屏路径与实际不符(H6/P1-6) | 新命令 preview_copy_task 返回解析后的真实目的地,确认屏显示真值;NAS 行改只读"项目自动推导" | Rust+UI |
| 8 | journal 非 UTF-8 炸全局 + 排序不确定(H7/M17/P1-8) | 逐行 lossy 容错、单文件失败跳过;排序键 (ts, machine, 行号) 确定化 | Rust |
| 9 | pause/resume 竞态(L19/P1-9) | resume 先清 pause 标志再判 running | Rust |
| 10 | 前端订阅断裂(H8/P1-10) | 常驻单一全局 listener 按 taskId 归约;start/resume/retry 后拉快照对账 | UI |
| 11 | listCopyFiles 零调用、allVerified 判定脆弱(M12) | 选中任务分页拉明细;可格式化提示改判 state==done | UI |
| 12 | 双扫描不一致(M11/P1-11) | run_copy 接受预扫清单,与快照/manifest 同源 | Rust |
| 13 | 命名双实现漂移、规范函数是死代码(M13/M14/P1-13) | Rust 为权威:大写化/去连字符/去空白对齐前端;build_task 走 card_folder_name_*,工况A 校验 YYYYMMDD | Rust |
| 14 | 汇总口径错误(M15/P2-16) | destination_count 取 manifest 实际值;cards_total 改为本项目 manifest 数 | Rust |
| 15 | 审计 fail-open(P1-7) | journal 追加失败重试+本机 outbox 兜底,不再裸 `let _ =` | Rust |
| 16 | 登记表低垂果实(P1-12 部分) | register_card 校验相机存在;delete_camera 级联写 card_deleted 事件 | Rust |
| 17 | 测试盲区(M18/codex) | 新增:目标已存在冲突(哈希异同两路)、续传目标被删、part 残留清理、换卡拒绝;cargo test 上三平台矩阵 | Rust+CI |

## 显式推迟到 M2(记录为已知边界,不改语义宣称)

- 回读校验的页缓存问题(M9):当前校验覆盖传输链路,不覆盖落盘静默损坏;M2 用 F_NOCACHE/O_DIRECT 直读。
- 多机任务可见性与 journal 读回轮询(M16/P0-3 后半):M1 为单机闭环,M2 实现 5–10s 跨机对账。
- 逐目的地独立恢复模型(P1-4):M1 保持"全目的地原子"语义(任一失败整文件重来,不覆盖故安全),M2 拆分。
- EXIF 拍摄时间(P2-14):M1 用 mtime 推断+人工确认兜底,PRD 已注明"可改"。
- 项目创建事务性(P2-15)、进度事件 delta 专用 DTO、registry 完整引用约束、symlink/空目录语义(L22)。
