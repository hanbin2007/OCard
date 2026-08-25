# UX 波双路评审收敛记录(2026-08-25)

## 范围

用户反馈驱动的 UX 波(基准 `941deff..1a01495`,收敛修复 `ce82fe0`):
新人引导向导、tauri-plugin-dialog 文件夹选择器、15 分钟会话守卫、
系统内置盘过滤+卷刷新、全局滚动收口、失败提示补漏(含全局
unhandledrejection 兜底网)、转码入口去死门、当前项目显性指示。

## 评审配置

按全局约定并行两路,独立成稿后收敛:

- Claude 路:opus,报告见 `archives/2026-08-25-ux-wave-opus-review.md`
- codex 路:gpt-5.6-sol,`model_reasoning_effort="max"`,只读,
  报告见 `archives/2026-08-25-ux-wave-codex-review.md`

## 收敛结果(全部修复于 ce82fe0)

两路撞车(独立发现同一问题,置信度最高):

| 问题 | opus | codex |
|---|---|---|
| 会话门盖住二次确认框(z 50<80),对应测试假绿 | P0 | P1 |
| 会话门无焦点陷阱,Tab 绕过后审计记错人 | P1 | P0 |
| 首跑/换根后不重拉,旧选中项悬空 | P1 | P1 |
| toast 覆盖内容顶部拦截点击 | P1 | P2 |
| 顶栏 chip 绕过交付打包导航锁 | P2 | P1 |
| unhandledrejection 丢栈/同 code 折叠 | P2 | P2 |

单路独家(均已修):

- codex:**真首跑到不了向导**(bootstrap 并发拉 list_projects 被后端拒绝
  → 错误页);手打同名绕过二次确认;换源卡不清旧时段前缀;armed 翻转
  不重置闲置计时;闲置询问 z=50 会被全屏预览(z=60)盖住。
- opus:`data-inapplicable` 无样式;dialog 无 max-height 矮窗不可达;
  确认屏系统盘 danger 拦截;volumes Path::starts_with;DevicesScreen
  报错串味;option 内按钮 tab 停靠点;PathField 零覆盖;E2E 红因
  (toast 拦截)与修复方向。

外加用户实测反馈「UI 元素重叠」:TopBar 重构为三列网格
(左标题簇|中当前项目|右动作),几何实测 900px 窄窗零交叠;
toast 改右下角浮动卡片(容器 pointer-events:none)。

## 方法论沉淀

- **jsdom 假绿是本轮最大教训**:层叠(z-index)、命中测试、布局遮挡
  在组件测试里全部不可见。新增 `src/styles/stacking.test.ts` 按 CSS 文本
  静态钉住浮层层级与 pointer-events 关系;凡涉浮层层级的改动必须同步该闸。
- preloaded 跳过 bootstrap 的测试盲区:关键首跑/重拉路径必须有
  不带 preloaded、spy 后端返回序列的真实链路测试。
- 「进屏自动刷新」会喂饱「手动刷新」的断言:装桩必须在初次自动动作
  落定之后。

## 终态

前端 629 测试 / Rust 203 / clippy·tsc 干净;CI(lint + 三平台构建 +
Linux E2E)在 `ce82fe0` 全绿——E2E 分类冒烟此前因 toast 拦截而红,
本轮修复后恢复,属实证收口。
