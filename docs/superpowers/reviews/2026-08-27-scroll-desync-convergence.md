# 滚动条不同步:三轮误诊与最终收敛(2026-08-27)

用户症状:除项目管理页外,所有可滚屏幕「滚动和滚动条不同步」。
本记录同时留下**误诊过程**,因为它比结论更值钱——同一个坑掉进去三次。

## 三轮排查

| 轮次 | 假设 | 动作 | 结果 |
| --- | --- | --- | --- |
| 1 | 自定义 `::-webkit-scrollbar` 把滚动容器踢出 WebKit 合成器异步滚动 | 删伪元素,改标准 `scrollbar-width` | 没修好 |
| 2 | 滚动容器 `.content` 自身的 transform 过渡动画同上 | 动画挪到 `.content__inner`(af39168) | 没修好 |
| 3 | **嵌套滚动容器** | 见下 | 待用户复测 |

前两轮共同的错误:**在渲染引擎方向做自洽的机制推理,却没有任何测量**。两条改动本身都独立正确(值得保留),但都不是病因;它们的代码注释此前把「这就是病因」写成事实,是把后来者(和第三轮的自己)推进同一个坑的直接原因——本次已全部改写为「独立正确,但不是那次症状的病因」。

## 定向的两个问题

真正把方向掰正的是向用户提的两个判别性问题,而不是继续读代码:

- **「停下来也错位」** → 排除合成器/主线程相位差(那类问题松手必然收敛对齐)
- **「拖动滚动条本身也错位」** → 指向「条与内容分属不同容器」

结论:是布局层问题,与渲染引擎无关。**布局问题在 Chrome 里同样现形**,于是起 vite dev server 用浏览器直接量几何——一量就露馅,不到十分钟。

## 真因

一屏之内存在两个滚动容器:

- 拷卡屏:`.content`(可滚 198px)内嵌 `.files__scroll`(`max-height:420px; overflow-y:auto`,自滚 88px)
- 选片屏:`.content` 内嵌自滚的虚拟网格 `.sorting__grid`
- 项目管理页:`.welcome-sub__body`(auto)与屏内 `.content`(auto)两根条几乎重叠在同一条右缘——**这才是「拖条也错位」最贴切的现场**

鼠标落点决定滚哪一层,而用户盯的是主区右缘那根条。内层滚时它纹丝不动,内层到底后才突然接管。

## 不变式(修法的准绳)

评审(opus P1-3)纠正了第一版规矩的写法。最终口径:

> **同一片区域、同一时刻,只有一个容器会响应滚轮 / 出条。**

不是「结构上只许有一个 `overflow:auto`」——后者会逼出更坏的结果:一旦布局退化就宁可把内容裁掉(见 P0-1)。一个 `scrollHeight === clientHeight` 的兜底 auto 容器对用户不存在,却能在退化态兜住可达性。

## 双路评审(codex gpt-5.6-sol max + opus)结论与处置

codex `REQUEST_CHANGES`(P1×4);opus 报 **P0×2**(带 headless Chrome 实测数值)。两份高度互补,全部处置:

| 项 | 处置 |
| --- | --- |
| **P0-1**(opus)`.content--flush{overflow:hidden}` 在横幅堆叠时把内容裁成不可达,VirtualGrid 视口塌成 0 后静默退化为按 6 行渲染——**我自己造出了 fail-open** | 改兜底 `overflow-y:auto` + `.sorting__grid-wrap{min-height:160px}`。实测:日常态外层 `scrollHeight==clientHeight`(不出条、不吃滚轮),退化态可滚、网格保底 180px |
| **P0-2**(opus)/ P1-1(codex)`.files__scroll` 展开后 sticky 表头彻底失效(`overflow:hidden` 的祖先 `.list` 建立了 scrollport) | `.list--files{overflow:clip}`(`@supports` 包裹,老内核回退)。**第一版选择器写反了**(以为 `.list` 在 `.files__scroll` 内,实际是祖先),浏览器实测才发现;修正后实测表头 `top=0` 精确吸在 `.content` 顶边 |
| P1-1(opus)「加载更多」被自己推到几千像素外,统计头随之滚走 | 触底自动续拉(IntersectionObserver + `rootMargin:200px`),复用选片屏 `onEndReached` 范式;按钮保留为手动出口。注:DOM 总量本就与改前相同(旧的 420px 只是裁剪),真正的代价是导航距离 |
| P1-2(opus)af39168 的「全部屏幕都有 content__inner,无遗漏」不成立 | 选片屏确实没有,该屏自 af39168 起就没有进场动画、`--flush .content__inner` 是死规则。补上包裹层——**并因此引出高度链断裂**:`.sorting{height:100%}` 失去参照被撑到 3494px,外层日常态可滚 2876px(嵌套又回来了),补 `height:100%;min-height:0` 修复,实测三层 825=825=825 |
| P1-4(opus)`welcome.css` 不在样式守卫扫描内 | `tokens.test.ts` 的 `STYLESHEETS` 补 `welcome`;随即红出两条违规并修:`transition: background-color`→`background`;非浮层 `box-shadow` 改 `outline`(全仓唯一一处违反「阴影只给浮层」) |
| P1-5(opus)/ P1-4(codex)零布局回归测试 | jsdom 无布局,必然假绿 → 进 E2E(`smoke.e2e.mjs`):每屏断言①正文区至多一个**真的能滚**的容器;②不存在「能滚却被 hidden 裁掉」的容器(零静默) |
| P2 批 | 步骤序号 a11y(勾号 `aria-hidden` 后补 `sr-only` 序号 + `role="list"`);副行改「文件夹名 · 工况」且只有文件夹名用 mono(窄宽先截冗余标签而非有用信息);`--text-quaternary` 不存在→ tertiary;`.topbar__back` 多余 margin;reduced-motion 注释与事实对齐;`.welcome-recent__folder` 两条冲突 `display` 清理 |

## 声明边界

- **本次只是「浏览器实测嵌套已消除」,不等于「用户症状已消失」**——这正是前两轮的教训。结论待用户在 macOS 实机复测。
- 前两轮改动不回滚:各自独立正确,是合理的风险隔离,只是与本症状无因果。
- `NewProjectWizard` / `SortingScreen` 新增包裹层后 JSX 缩进未重排(仓库无 JS formatter,重排本身是巨大 diff),记为技术债。
- E2E 只在 Linux tauri-driver 上跑,macOS WKWebView 的原始症状仍需目标机验收。
