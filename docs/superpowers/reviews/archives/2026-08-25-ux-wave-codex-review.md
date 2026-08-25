**Findings**
**P0**
- [SessionGuard.tsx:164](/Users/zhb/Documents/OCard/src/components/SessionGuard.tsx:164) 会话门只是视觉遮罩，没有转移/圈定焦点，也未把后台设为 `inert`。会话结束后焦点回到 `body`，`Tab` 会先进入 DOM 前面的侧栏和业务控件；已打开抽屉的全局焦点圈仍会在后台抢键盘事件（[AuditLogDrawer.tsx:179](/Users/zhb/Documents/OCard/src/components/AuditLogDrawer.tsx:179)）。键盘或辅助技术可以在未确认操作员时继续触发业务，审计仍归到上一人，守卫的核心安全不变量失效。

**P1**
- [SessionGuard.tsx:121](/Users/zhb/Documents/OCard/src/components/SessionGuard.tsx:121)、[SessionGuard.tsx:234](/Users/zhb/Documents/OCard/src/components/SessionGuard.tsx:234) 浮层层级反了：闲置询问沿用普通 `z=50`，会被 `z=60` 的全屏预览盖住；结束门为 `z=80`，但它打开的 `ConfirmDialog` 又是 `z=50`（[components.css:882](/Users/zhb/Documents/OCard/src/styles/components.css:882)、[components.css:1604](/Users/zhb/Documents/OCard/src/styles/components.css:1604)）。实际点击“继续上一位”后确认框不可见、不可点，DOM 单测仍会误报通过。
- [SessionGuard.tsx:96](/Users/zhb/Documents/OCard/src/components/SessionGuard.tsx:96) 在“换一位操作人”输入框填入原姓名会直接 `resume()`，绕过强制二次确认；[SessionGuard.test.tsx:160](/Users/zhb/Documents/OCard/src/components/SessionGuard.test.tsx:160) 还把这个违规路径固化成了预期行为。
- [store.tsx:683](/Users/zhb/Documents/OCard/src/state/store.tsx:683) 真正首跑仍会先并发调用 `listProjects()`，而后端在 NAS 根为空时直接拒绝（[commands/mod.rs:191](/Users/zhb/Documents/OCard/src-tauri/src/commands/mod.rs:191)）；[App.tsx:56](/Users/zhb/Documents/OCard/src/App.tsx:56) 又先渲染错误页，因此 NAS 未配置的新用户根本看不到两步向导。设置齿轮虽可兜底，但从空根保存时 [SettingsDialog.tsx:210](/Users/zhb/Documents/OCard/src/components/SettingsDialog.tsx:210) 不触发 reload，还要人工再点“重试”。
- [SettingsDialog.tsx:205](/Users/zhb/Documents/OCard/src/components/SettingsDialog.tsx:205) 换 NAS 后虽然 reload，但 [store.tsx:347](/Users/zhb/Documents/OCard/src/state/store.tsx:347) 无条件保留旧 `selectedProjectId/selectedTaskId`。新根没有该 ID 时状态悬空；若新根恰有同名 ID，则会静默选中另一 NAS 的同名项目。设置测试使用 `preloaded`，会令 bootstrap/reload 直接跳过，未覆盖真实路径。
- [volumes.rs:28](/Users/zhb/Documents/OCard/src-tauri/src/core/volumes.rs:28) 判定的是挂载路径习惯，不是“内置盘”：Windows 的内部 `D:`、macOS 内部附加卷 `/Volumes/Data`、Linux 挂在 `/mnt/data` 的内部盘都会漏标；Linux 挂在 `/srv/nas` 的 NAS 或自定义介质反而被标成系统盘。默认安全过滤因此存在明显漏口，且 Windows 测试明确把所有非系统盘符视作非系统。
- [base.css:10](/Users/zhb/Documents/OCard/src/styles/base.css:10) 全局锁滚动后，[components.css:882](/Users/zhb/Documents/OCard/src/styles/components.css:882) 的 overlay 和 [components.css:899](/Users/zhb/Documents/OCard/src/styles/components.css:899) 的 dialog 都没有 `max-height/overflow-y`。设置中展开探测明细或导出 6 行诊断后，底部“取消/保存”在矮窗中会被裁掉且无法滚到。
- [TopBar.tsx:58](/Users/zhb/Documents/OCard/src/components/TopBar.tsx:58) 当前项目黄标始终可导航，未读取 `selectDeliveryWorking`。交付打包时侧栏刻意锁页（[Sidebar.tsx:170](/Users/zhb/Documents/OCard/src/components/Sidebar.tsx:170)），但黄标可直接回项目列表，再切换项目使锁自动解除，导致进行中的交付结果面板和未交付明细被卸载。
- [CopyTaskScreen.tsx:174](/Users/zhb/Documents/OCard/src/screens/CopyTaskScreen.tsx:174) 换源卷时没有先清空 `targetPrefix/prefixInferred`。若上一张卡探查成功、下一张失败，界面仍保留并标作“推断得出”的旧时段；新增通知虽可见，用户仍可能把新卡拷进旧时段目录。

**P2**
- [store.tsx:591](/Users/zhb/Documents/OCard/src/state/store.tsx:591) `unhandledrejection` 无条件 `preventDefault()`，却只保留 `message`，会丢失浏览器控制台中的 stack；所有异常还共用 `unhandled-error`，随后被 [store.tsx:291](/Users/zhb/Documents/OCard/src/state/store.tsx:291) 折叠，较早的不同错误原因会被覆盖。`NoticeDto` 字段结构本身复用正确。
- [SessionGuard.tsx:43](/Users/zhb/Documents/OCard/src/components/SessionGuard.tsx:43) `armed` 从 false 变 true 时未重置 phase/时间戳。若用户在引导页停留超过 15 分钟，完成设置后约 10 秒就会收到闲置询问。测试只覆盖“始终未 armed”，也未钉住阈值前后、prompt 中活动、切换操作员失败。
- [components.css:1351](/Users/zhb/Documents/OCard/src/styles/components.css:1351) toast 的层级相对通知面板和模态框正确，但绝对定位没有给 `.content` 留位；最多三条且 error 永不自动收起，会直接盖住页面顶部操作，包括错误页的恢复按钮，与“不遮挡操作”的注释相反。
- [ProjectsScreen.tsx:159](/Users/zhb/Documents/OCard/src/screens/ProjectsScreen.tsx:159) 在 `role="option"` 内加入可聚焦按钮，破坏了 listbox 的单一 roving-tabstop 模型；键盘会进入每行按钮，读屏器也不保证暴露 option 内的交互控件。
- 测试存在系统性盲区：[SettingsDialog.test.tsx:454](/Users/zhb/Documents/OCard/src/components/SettingsDialog.test.tsx:454) 用预载数据绕过真实首跑；[CopyTaskScreen.test.tsx:550](/Users/zhb/Documents/OCard/src/screens/CopyTaskScreen.test.tsx:550) 的“手动刷新”可由进屏自动刷新提前满足；[e2eAnchors.test.tsx:133](/Users/zhb/Documents/OCard/src/e2eAnchors.test.tsx:133) 仅检查锚点存在，未覆盖原生 PathField、滚动几何、z-index 和焦点隔离。

**已核**
- 已核：prompt 弹出后的 pointer/key/wheel 活动只更新 `lastActivityRef`，不会延长基于 `promptAtRef` 的 5 分钟 grace；稳定 `armed` 下 phase 切换会正确清理并重建 interval；换人 API 失败会留在门内并显示错误。
- 已核：前端过滤谓词包含 `v.id === volumeId`，已选系统卷不会因关闭开关而消失；`VolumeDto.is_system` 到前端 `isSystem` 的序列化链正确。
- 已核：分类工作台 `.sorting__grid`、审计抽屉 `.drawer__body`、通知面板列表仍有独立滚动，问题集中在通用 dialog。
- 已核：PathField 在 `dest-row` 的 `minmax(0,1fr)` 内具备 `min-width:0`；`readOnly` 隐藏浏览按钮、`disabled` 禁用输入与按钮、浏览器/vitest 环境隐藏按钮，三项语义自洽。
- 已核：建项、相机/卡登记、卷探查及文件明细新增失败路径均有可见反馈；转码入口与两种屏内空态实现完整。

按要求全程只读；已通读完整 diff 和相关上下文，`git diff --check` 无问题，未运行测试套件。

REVIEW_DONE
