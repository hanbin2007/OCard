# UX 波二实现评审(Claude/opus 路)· 基准 ed22838

评审时间:2026-08-26。与 codex(gpt-5.6-sol,max)并行的独立评审。
前置:vitest 641 全绿、tsc 无输出、cargo check 无警告——问题在测试照不到处。

## P0
无。

## P1

1. **Select `close()` 在 scroll 路径抢焦点**:`focus()` 默认 scroll-into-view,
   惯性滚动后触发器已出视口会被拽回——正是本波要根治的"滚动跳变"。
   修:scroll/resize 走 `close(false)`,回焦一律 `preventScroll`。
2. **绑定容量/卷标取前端缓存**:后端手握 `mounted`(实测容量/卷名)却用
   `input.capacity_bytes`;挂载点复用(拔 A 插 B 同挂 /Volumes/UNTITLED)
   会把指纹写到 B、登记表记着 A。修:容量用实测,卷名核对不一致即拒。
3. **volume_uid 无唯一性约束**:克隆卡/复制指纹文件/重复登记产生同 uid
   多卡,`find` 静默取第一条,还挂着绿色「指纹」徽标——比弱匹配更具
   欺骗性。修:登记查重拒绝;匹配命中多条降级为冲突并可见告警。
4. **安全链路零自动化覆盖**:mock runtime 现成却没用。补:未挂载路径拒/
   系统盘拒(且不留无主指纹)集成测试;匹配抽纯函数 `match_card` 加单测。
5. **listbox 缺 aria-activedescendant**:焦点在 ul、活动项只有视觉高亮,
   读屏听不到键盘选择——换掉原生 select 后可达性净损失。修:option 加
   id + ul 挂 activedescendant。

## P2(择要,全录见当日工作记录)

Esc 不 stopPropagation 会连关外层 dialog(潜伏雷);select-pop 层级注释
称被 stacking.test 钉住但实际无断言;受控值漂移后仍提交旧挂载点;
错误文案含 21 个连续空格;写指纹先于校验会留无主指纹;options 缩短
activeIndex 越界;`.checkbox` font-size 吃掉透传 text-xs;Field 与 Select
之间夹 div 截胡 aria 注入;VirtualGrid 同值重复请求不滚(SortingScreen
连续同项失败场景命中);系统盘可被放指纹文件冒充登记卡且 start_copy
不拒;uid 命中 A/卷标命中 B 静默取 A;status=draft 与「有未完成任务」
并存矛盾;列表 bytes 与未完成二选一少报事实;无 type-ahead;flip 分支
缺 maxHeight 下限;测试假绿点(fireEvent 直打 ul 绕开焦点、catch 吞错);
`* {scrollbar-*}` 应写 :root(继承属性)。

## 已核无问题

绑定路径闸无绕过(PathBuf components 比较,`..` 不解析构造不出别名;
TOCTOU 最坏留 36 字节文件,与 start_copy 同强度且多一道拒系统盘);
audit 已含 volume_uid(整卡序列化入 CARD_REGISTERED);网络卷不会被
同步 read(sysinfo 三平台过滤已核);copy_incomplete 契约迁移干净无残留;
`.dialog max-height:100%` 是真修复(旧 dvh 减常数比 overlay 内容区大 16px);
e2e 无 select 依赖;reduced-motion 覆盖新增动效;checkbox 原生语义完整。

(全部 P1 与主要 P2 已在 e353362 收敛修复;声明边界见收敛记录。)
