# UX 波实现评审(Claude/opus 路)· 基准 1a01495

评审时间:2026-08-25。与 codex(gpt-5.6-sol,max)并行的独立评审。
前置:tsc 干净,vitest 34 文件/615 用例全绿——问题全在测试照不到的地方。

## P0

1. **会话门的二次确认对话框被自己的门盖住,实际点不到。**
   `.overlay--gate { z-index: 80 }` 与 ConfirmDialog 的 `.overlay`(z=50)
   是根层叠上下文里的兄弟,门盖住确认框;命中测试随绘制顺序,「取消」与
   「确认是 张三」都点不动。用户被挤向「手打同名 → 无确认放行」的旁路,
   正好打死了这个功能要防的事。jsdom 不做布局,`fireEvent.click` 直接派发
   到节点——对应测试是**假绿**。修法:确认框抬层(elevated),并加 CSS
   静态层叠检查。

## P1

2. **首跑引导配完 NAS 后不重拉数据**:只 dispatch `workstationUpdated`,
   bootstrap 时拉到的空清单原样留着;第二台工作站指向已有共享 NAS 时
   看到假的「还没有项目」。对应测试用 preloaded 跳过了 bootstrap,假绿。
3. **会话门没有焦点陷阱**:Tab 可以把焦点送到门后,回车即生效——会话
   终止后的操作仍记到上一位操作人头上。修法:门弹出期间 sidebar/main inert。
4. **toasts 绝对定位通栏覆盖内容顶部**:分类工作台 `content--flush` 下
   工具条整条被盖住且挡点击;error 级 toast 永不自动消失。
5. **`data-inapplicable` 无任何样式**:禁用的灰化去掉了、替代的视觉标注
   没加上,工况 B 下「代理转码」与可用项一模一样。

## P2(择要)

- SessionGuard 计时逻辑已核无漂移;prompt 期活动不影响终止判定已核;
  建议补「prompt 期狂动鼠标仍终止」「4 分钟未终止」两条边界测试。
- `startAs` 的 `!workstation` 静默 return 违反零静默,应给可见错误。
- 滚动收口对内部滚动区(sorting/drawer/notice-panel/files)已核全部仍可滚;
  `.dialog` 缺 max-height,body 锁滚后矮窗不可达。
- volumes:macOS 判定比注释更稳(sysinfo 会滤掉网络挂载),
  `to_string_lossy().starts_with` 应改 `Path::starts_with`;
  「宁可多隐藏」的注释与实现口径不符;真机断言在容器环境会莫名红。
- **过滤只是「藏」没有「拦」**:确认屏对 isSystem 应加 danger 横幅。
- 换 NAS 根 reload 后旧 selectedProjectId 悬空,应只保留仍存在的选中项。
- TopBar chip 绝对居中在窄窗会盖住标题(题:1280 下 chip 区间与长副标题
  相交);chip 未读 `selectDeliveryWorking`,可绕过交付打包导航锁(codex 同报)。
- unhandledrejection `preventDefault` 丢栈,应保留 console.error;
  reason 为 undefined 时文案兜底;`unhandled-error` 应登记抬头。
- DevicesScreen 两表单共用 submitError 且不清旧值会串味;
- ProjectsScreen 按钮嵌在 `role="option"` 里破坏 roving tabindex;
- 转码无项目空态在「一个项目都没有」时指路错误(应去新建);
- PathField/pickFolder 零测试覆盖(canPickFolder 在 vitest 恒 false),
  建议改函数导出以便 stub;defaultPath 传未必存在的手打路径有平台差异。

## 结论

方向与取舍都对(去死门、零静默补漏、状态显性化是实打实的改进),但
1 P0 + 4 P1,其中两个恰是本波自己立的目标只做了一半,且 P0 与 P1-2
都有假绿测试背书——修复必须连测试一起补。

(全部条目已在 ce82fe0 收敛修复;层叠关系新增 stacking.test 静态钉死。)
