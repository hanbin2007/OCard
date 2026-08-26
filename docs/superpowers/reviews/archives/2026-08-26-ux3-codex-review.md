**Findings**
- `P0` [App.tsx:146](/Users/zhb/Documents/OCard/src/App.tsx:146)、[SessionGuard.tsx:99](/Users/zhb/Documents/OCard/src/components/SessionGuard.tsx:99)、[components.css:1354](/Users/zhb/Documents/OCard/src/styles/components.css:1354)：toast 确实位于被 `inert` 的 `.main` 内。`z-index:100` 只能让它显示在会话门上，不能恢复点击、焦点或无障碍树；换操作人失败后，error toast 的确认按钮不可操作，读屏也收不到这个唯一错误反馈。error 又永不自动消失，多条 toast 还可能遮住门内操作且无法清除。这条是实际的会话门错误路径阻断，建议把 toast host 移到 `.main` 外，或将门内提交错误留在门内。

- `P1` [mod.rs:575](/Users/zhb/Documents/OCard/src-tauri/src/commands/mod.rs:575)、[mod.rs:947](/Users/zhb/Documents/OCard/src-tauri/src/commands/mod.rs:947)、[tasks.rs:241](/Users/zhb/Documents/OCard/src-tauri/src/commands/tasks.rs:241)：`project_cards_set/used` 是权威状态，却复用了返回 `()` 的 best-effort `append_audit`。NAS journal 写失败时事件只进本机 outbox，仓库没有自动回放；`set_project_cards` 仍可能 `Ok` 返回旧清单，`start_copy_task` 也照常成功但卡永远未自动并入。toast 只说明“审计暂存”，并没有说明“清单未保存”。

- `P1` [ProjectCardsPanel.tsx:150](/Users/zhb/Documents/OCard/src/components/ProjectCardsPanel.tsx:150)、[catalog.rs:191](/Users/zhb/Documents/OCard/src-tauri/src/core/catalog.rs:191)：前端“添加/删除”由旧快照拼出整份列表，再调用整体替换。A 机加载 `[a]` 后，B 机产生 `used(b)`，随后 A 添加 `c` 写入 `[a,c]`，B 的真实用卡就被后来的 set 擦掉。排序虽确定，但不具备 merge-safe 语义；本机互斥锁也解决不了，需 per-card add/remove 事件或版本/CAS。

- `P1` [journal.rs:50](/Users/zhb/Documents/OCard/src-tauri/src/core/journal.rs:50)、[journal.rs:118](/Users/zhb/Documents/OCard/src-tauri/src/core/journal.rs:118)：多机顺序完全依赖各机 `Utc::now()`。`(ts,file,idx)` 能保证所有机器得出同一结果，但不能保证真实因果顺序；时钟落后的机器即使后来拷卡，`used` 仍可能排到 set 前并被清掉。核心承诺“拷卡自动并入”因此依赖未声明的时钟同步假设。

- `P1` [catalog.rs:186](/Users/zhb/Documents/OCard/src-tauri/src/core/catalog.rs:186)、[catalog.rs:192](/Users/zhb/Documents/OCard/src-tauri/src/core/catalog.rs:192)、[mod.rs:220](/Users/zhb/Documents/OCard/src-tauri/src/commands/mod.rs:220)：降级读把“未知”折成了“未配置/零”。单文件不可读和坏行由 `read_all` 以计数返回，但 catalog 完全忽略；合法事件外壳里的坏 `cardIds` 又被 `unwrap_or_default()` 当作空清单。登记表不可用时还会以空 cards 计算成 `0/y`。NAS 抖动时 x/y 会消失或归零，部分路径甚至没有告警。

- `P1` [ProjectCardsPanel.tsx:84](/Users/zhb/Documents/OCard/src/components/ProjectCardsPanel.tsx:84)、[ProjectCardsPanel.tsx:132](/Users/zhb/Documents/OCard/src/components/ProjectCardsPanel.tsx:132)：初始读取中或读取失败时，模板、Select 和添加仍可操作。此时 `rosterIds=[]`，点“添加”会把未知的既有清单整体替换为单张卡，属于可复现的数据覆盖竞态；`busy` 只保护保存请求，没有保护加载阶段。

- `P1` [ProjectCardsPanel.tsx:53](/Users/zhb/Documents/OCard/src/components/ProjectCardsPanel.tsx:53)、[ProjectsScreen.tsx:109](/Users/zhb/Documents/OCard/src/screens/ProjectsScreen.tsx:109)：保存后只更新面板局部 `roster`，没有更新或重拉 `state.projects`。因此面板显示新 x/y，而同屏列表和详情摘要继续显示旧 x/y/“未配置用卡”；现有测试只检查行数，没有覆盖这处不一致。

- `P1` [mod.rs:79](/Users/zhb/Documents/OCard/src-tauri/src/commands/mod.rs:79)、[mod.rs:417](/Users/zhb/Documents/OCard/src-tauri/src/commands/mod.rs:417)、[mod.rs:946](/Users/zhb/Documents/OCard/src-tauri/src/commands/mod.rs:946)：卷名兜底在多张未绑定卡同名时用 `.find()` 任取第一张，而登记层允许重名；完成进度会记到错误卡，自动并入也会污染清单。已有的 UID 冲突信息在新两个调用点也被丢弃，违背“零静默”。

- `P2` [ProjectCardsPanel.tsx:118](/Users/zhb/Documents/OCard/src/components/ProjectCardsPanel.tsx:118)、[mod.rs:533](/Users/zhb/Documents/OCard/src-tauri/src/commands/mod.rs:533)：已拷卡仍可无确认移出，x 只取当前 roster 交集。移除最后一张后，项目可能已有完成 manifest，却显示 `0/0 张`并隐藏“完成 N 次”，确有“明明拷了却不计”的困惑面。

- `P2` [ProjectCardsPanel.tsx:84](/Users/zhb/Documents/OCard/src/components/ProjectCardsPanel.tsx:84)：登记卡表为空时模板正确禁用，但正文仍让用户“套用模板或逐张添加”，两条路径都不可用，也没有引导去设备登记。

- `P2` [ProjectsScreen.tsx:123](/Users/zhb/Documents/OCard/src/screens/ProjectsScreen.tsx:123)：工况 A 在“分类进度”列画的是用卡进度条，旁边文字却仍是素材数量，视觉上把两种分母拼成了一项。

- `P2` [TrashScreen.tsx:98](/Users/zhb/Documents/OCard/src/screens/TrashScreen.tsx:98)、[PathField.tsx:45](/Users/zhb/Documents/OCard/src/components/PathField.tsx:45)：toast 迁移有上下文损失。回收站部分失败删掉了原横幅中的“文件占用/权限不足”排障信息；PathField 离开字段位置后又没有带 `pickerTitle`，多路径表单里无法从通知判断是哪一项失败。

**已核**
- journal 的 `(ts,file,idx)` tie-break 确定；set 后排序到其后的 used 会并入，重复 used 会去重。问题是上述并发快照与时钟因果性，而非折叠不确定。
- 同一卡多份完成 manifest 经 `HashSet` 只计一次，去重正确。
- `used` 在路径校验及 manifest 保存后、worker 启动前写入；未完成任务只增加 y、不增加 x。按“已实际发起使用”定义合理，outbox 可靠性问题除外。
- `ProjectCardsPanel key={selected.id}` 加 effect cancellation，项目切换竞态处理正确；Select 正常流程为受控值，保存后会清空。
- toast 竖条裁剪、reduced-motion、深浅主题 alias 均成立；alias 在根层引用深色会覆盖的基色，现有 tokens 深浅一致性不会被破坏。去除 `scrollbar-color` 也未见副作用。
- 除上述两处外，迁移点基本保留了后端原始错误及操作前缀。

按只读约束未运行会生成 `target`/Vite 缓存的测试；`git diff --check` 通过，工作树保持干净。

REVIEW_DONE
