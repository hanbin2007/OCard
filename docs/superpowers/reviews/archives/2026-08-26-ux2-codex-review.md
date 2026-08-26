**P0 Findings**
- `[P0]` 切项目后可能清空错误项目的回收站。[Sidebar.tsx:217](/Users/zhb/Documents/OCard/src/components/Sidebar.tsx:217) 现在只切换 `projectId`，页面继续挂载；[TrashScreen.tsx:26](/Users/zhb/Documents/OCard/src/screens/TrashScreen.tsx:26) 重新加载时没有清空旧 `entries`，按钮也未因 `loading` 禁用。此时 [TrashScreen.tsx:77](/Users/zhb/Documents/OCard/src/screens/TrashScreen.tsx:77) 的确认文案展示项目 A 的旧数量，却以当前项目 B 调用 `emptyTrash`。在 B 加载完成前点击并确认，会不可逆删除 B 的回收站内容。

**P1 Findings**
- `[P1]` 拷卡确认跨项目遗留，可能把素材送入错误项目。[CopyTaskScreen.tsx:71](/Users/zhb/Documents/OCard/src/screens/CopyTaskScreen.tsx:71) 的卷、目标和确认预览状态不会随项目重置；预览按旧项目生成于 [CopyTaskScreen.tsx:357](/Users/zhb/Documents/OCard/src/screens/CopyTaskScreen.tsx:357)，但最终确认使用当前项目提交于 [CopyTaskScreen.tsx:308](/Users/zhb/Documents/OCard/src/screens/CopyTaskScreen.tsx:308)。切项目后仍可确认旧预览，却实际启动新项目任务。
- `[P1]` 整理页同样保留旧项目资产和操作状态。[SortingScreen.tsx:233](/Users/zhb/Documents/OCard/src/screens/SortingScreen.tsx:233) 仅置 `loading`，不清空资产、选择、预览和待删除状态；[SortingScreen.tsx:567](/Users/zhb/Documents/OCard/src/screens/SortingScreen.tsx:567) 等操作把旧相对路径与新 `projectId` 组合。若新旧项目存在同名相对路径，可移动、分类或删除新项目文件。
- `[P1]` `Select` 的 ARIA 焦点模型不成立。[controls.tsx:149](/Users/zhb/Documents/OCard/src/components/controls.tsx:149) 把 DOM 焦点移到 `listbox`，但 [controls.tsx:274](/Users/zhb/Documents/OCard/src/components/controls.tsx:274) 只用 `data-active` 标记选项；既没有聚焦 `option`，也没有 `aria-activedescendant`。键盘视觉高亮不会可靠地被读屏宣布，不符合 [WAI-ARIA combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)。
- `[P1]` 存储卡 UID 没有唯一性约束。[commands/mod.rs:347](/Users/zhb/Documents/OCard/src-tauri/src/commands/mod.rs:347) 写入 UID 后，[registry.rs:126](/Users/zhb/Documents/OCard/src-tauri/src/core/registry.rs:126) 可把同一 UID 登记到多张卡；UI 也允许再次选择已匹配卷。随后 [commands/mod.rs:425](/Users/zhb/Documents/OCard/src-tauri/src/commands/mod.rs:425) 用 `find` 任取第一张，卡和机位归属将取决于登记顺序。
- `[P1]` 存在 UID 时仍无条件回退卷标匹配。[commands/mod.rs:425](/Users/zhb/Documents/OCard/src-tauri/src/commands/mod.rs:425) 在 UID 未登记、损坏或读取失败后，会按卷标匹配任何卡，包括已有不同 UID 的卡。UID 指向 A、卷标指向 B 时，若 A 已登记则正确选 A；但未知 UID 会错误选 B。卷标回退应仅限 `volume_uid == None` 的旧卡，并区分“文件不存在”和“读取/格式失败”。
- `[P1]` 路径校验挡住了普通任意目录，却没有形成可靠的“可插拔卡”写入边界。[commands/mod.rs:350](/Users/zhb/Documents/OCard/src-tauri/src/commands/mod.rs:350) 要求 `PathBuf` 精确等于枚举挂载点，因此常规 `../`、别名字符串不能绕过；但 [volumes.rs:30](/Users/zhb/Documents/OCard/src-tauri/src/core/volumes.rs:30) 只按路径判断系统盘，[DevicesScreen.tsx:314](/Users/zhb/Documents/OCard/src/screens/DevicesScreen.tsx:314) 也仅过滤 `isSystem`。内部数据盘、NAS、备份卷仍可被写入指纹；枚举和写入之间还存在卸载、替换挂载点的 TOCTOU 窗口。

**P2 Findings**
- `[P2]` `Select` 几何和动态选项边界未封闭。[controls.tsx:132](/Users/zhb/Documents/OCard/src/components/controls.tsx:132) 强制最小 `maxHeight=120`，高缩放或极矮 CSS viewport 下可能超过上下实际空间；没有横向 viewport 夹持。[controls.tsx:120](/Users/zhb/Documents/OCard/src/components/controls.tsx:120) 的 `activeIndex` 仅在打开时初始化，打开期间选项缩短可越界，空列表按 End 还会得到 `-1`。受控值不在选项中时 [controls.tsx:226](/Users/zhb/Documents/OCard/src/components/controls.tsx:226) 显示占位符，却保留陈旧值；设备刷新后 UI 可显示“请选择”，提交仍发送失效挂载点。
- `[P2]` 指纹失败语义不够可诊断，也不是事务式操作。[volumes.rs:138](/Users/zhb/Documents/OCard/src-tauri/src/core/volumes.rs:138) 把全部 I/O 原因折叠为 `None`；已存在但为空或损坏的文件因 `create_new` 永远无法修复，却在 [commands/mod.rs:358](/Users/zhb/Documents/OCard/src-tauri/src/commands/mod.rs:358) 被泛化成“只读/写保护”。而指纹先于 NAS、机位和日志登记校验写入，后续失败会留下孤儿指纹。首次拷卡并发本身使用 `create_new` 和重读，幂等性已核，没有重复覆盖问题。
- `[P2]` `copy_incomplete` 本次二进制内口径正确，但没有版本偏差兜底。[dto.rs:18](/Users/zhb/Documents/OCard/src-tauri/src/commands/dto.rs:18) 与前端均把字段设为必需；新前端连接旧后端时 `undefined` 会被当作 false，旧前端连接新后端则可能显示 `N/undefined`。标准 Tauri OTA 是整包更新，通常不会半升级，但开发、缓存或资产错配时会静默误导。
- `[P2]` “已拷 N 张”实际统计的是完成 manifest 数。[catalog.rs:145](/Users/zhb/Documents/OCard/src-tauri/src/core/catalog.rs:145) 没有按物理卡 UID 去重，同一卡多次完整拷贝会显示多张。[ProjectsScreen.tsx:108](/Users/zhb/Documents/OCard/src/screens/ProjectsScreen.tsx:108) 应改成“完成 N 次拷卡”，或改为按来源 UID 去重。
- `[P2]` 新测试没有钉住高风险行为：侧栏测试只验证路由不变；控件测试未覆盖真实焦点、读屏、缩放定位、选项动态变化及 Tab；后端未覆盖 UID 冲突、卷标冲突、损坏指纹、系统盘边界和 TOCTOU；VirtualGrid 未测试手动滚走后对同一下标再次请求；[stacking.test.ts:29](/Users/zhb/Documents/OCard/src/styles/stacking.test.ts:29) 也没有验证注释声称的 `select-pop` 层级关系。

**已核**
- `Select` 的外点、滚动、缩放和 Tab 监听均有对应清理，未发现事件泄漏。当前调用点不在对话框或会话门中：`z=70` 可盖过普通 dialog 的 `z=50`；若以后放入 `z=80/90` 的会话门或 elevated dialog，portal 会被盖住。
- `Checkbox` 使用真实 input、透明铺满 16×16 控件区，外层 label 扩大整行命中，原生焦点和 disabled 链路保留。现有 children 只有文本或 `strong`，没有嵌套按钮、链接等交互元素。
- `has_incomplete_copy = any(!completed)` 与“存在已发起但未完整验证的拷贝任务”一致；假进度已移除。旧 Registry 卡的 `volume_uid` 有 serde 默认，旧卡卷标回退路径仍在。
- `.dialog max-height: 100%` 在固定 overlay、全局 `border-box` 和自身 `overflow-y:auto` 下成立。
- `scrollbar-width` 已由 Safari 18.2 支持，而 `scrollbar-color` 到 Safari 26.2 才加入；现代 Chromium/WebView2 支持二者，旧运行时会退回系统滚动条，属于外观退化而非滚动失效。[WebKit 18.2](https://webkit.org/blog/16301/webkit-features-in-safari-18-2/)、[WebKit 26.2](https://webkit.org/blog/17640/webkit-features-for-safari-26-2/)、[Chrome scrollbar styling](https://developer.chrome.com/docs/css-ui/scrollbar-styling)
- `VirtualGrid` 的 ref 确实只响应下标变化并在无目标时复位；代价是用户手动滚离当前格后，再发同值 Home 请求仍无法重新定位，且列数变化不再重锚。旧标量 effect 对“相同值重新请求”也无法表达，因此不算本提交新增回归，但仍缺少请求序号式 API 和测试。

只读检查完成：stat 为 22 files、`+992/-170`；完整 diff 与相关上下文已审阅，`git diff --check`、`pnpm exec tsc --noEmit` 均通过，工作树保持干净。未运行可能产生缓存或构建产物的完整测试套件。

REVIEW_DONE
