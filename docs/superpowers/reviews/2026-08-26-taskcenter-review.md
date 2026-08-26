# 任务中心评审收敛记录(2026-08-26)

对象:任务中心首版(commit `8ab880e`,用户点单「有没有任务中心」→「要」)。
双路评审:opus-4.8(Agent)+ gpt-5.6-sol(codex exec,`model_reasoning_effort=max`,只读沙箱)。
收敛提交:`a626dc0`。前端 658 绿、Rust 211 绿、clippy/fmt 干净。

## 双方结论

- 两路均无 P0。
- opus:P1×2(历史 ISO 字符串排序在 +08:00/Z 混排下乱序且比较器违反反对称;取消/挂起无在途反馈、无终态预检)+ P2 批(通知抬头缺失、弹层不互斥、aria-label、queued 0/0、测试假绿等)。
- codex:P1×4,其中三个 opus 未覆盖——跨项目跳转绕过交付锁、历史行不可跳转(丢了 projectId/route)、拷卡终态事件不落 `finishedAt` 导致完成任务按启动时间排序;另有 P2×6(orphanProgress 被忽略、归档进行中误标「转码」、行内按钮无障碍名不可区分等)。

## 处置(全部落地)

| 项 | 修法 |
| --- | --- |
| 跨项目交付锁旁门(codex P1) | `jumpTo` 检查目标项目是否有 queued/running 交付作业,是则统一改道 `sorting`(交付面板所在地);当前项目交付中仍整体禁跳,与侧栏同一把锁 |
| 历史行不可跳转(codex P1) | 历史模型保留 `projectId/route/taskId`,渲染为按钮走同一 `jumpTo` 守卫 |
| 终态不落 finishedAt(codex P1) | `applyProgress` 归约 done/failed 事件时以 `event.occurredAt` 补 `finishedAt` |
| 交付取消结果可见性(codex P1) | 任务中心取消交付发 `delivery-cancelled` info 回执(x/y、部分产物保留、清单实况、重跑续打);用户进入该项目分类屏时 DeliveryPanel 仍呈现终态结果——双通道,不依赖 DeliveryButton 挂载 |
| 历史排序(opus P1 / codex P2) | `Date.parse` 数值比较,解析失败回退字符串序且守反对称;新增 +08:00/Z 混排回归测试 |
| 取消/挂起在途反馈(opus P1) | `busyId` 禁用 + 「处理中…/取消中…」;终态预检不发无效取消;失败 warning、too-late info |
| 归档误标(codex P2) | 后端 `JobSnapshot` 增 `operation`("proxy"/"archive",创建时写死),TS `TranscodeJob.operation`;进行中认 operation、终态优先 `result.mode`,缺省按代理显示不再确定性误标 |
| orphanProgress(codex P2) | 活动 orphan 计入计数并渲染不可操作的「正在读取任务详情…」占位行 |
| 弹层互斥(opus P2) | reducer:任务中心/通知面板/设置三者互相收起 |
| 通知抬头(opus P2) | NOTICE_TITLES 补 job-cancel-too-late / job-cancel-failed / copy-pause-failed / delivery-cancelled;too-late 三处统一 info 级 |
| 无障碍(codex P2 / opus P2) | 行主按钮稳定 aria-label(不随进度抖动);挂起/继续/取消按钮带类型+项目名 |
| 测试假绿(opus P2 / codex P2) | 取消用例 revision 前进+断言行入历史「已取消」;挂起用例断言「继续」出现;交付锁用例断言取消按钮仍可用;新增跨项目改道、历史跳转、8 条上限、排序回归;e2e 锚点登记 task-center-* |
| mockJobs 时间戳(opus P1 附带) | `nowLocalIso()` 统一本地偏移格式 |

## 声明边界(双方认可,不再追)

- `confirming` 是提交前确认界面,不算后台任务,排除合理。
- 历史 8 条上限是产品口径:翻旧账走审计日志。
- 交付取消后不强制跳转到目标项目分类屏:回执 + 面板双通道已保证可见性,强制切项目反而抢用户上下文。
- 会话门(inert `.main`)盖过任务中心面板:门开时本就该不可操作,层级正确。
