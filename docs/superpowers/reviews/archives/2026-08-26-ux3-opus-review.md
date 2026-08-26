# UX 波三实现评审(Claude/opus 路)· 基准 9731f1d

评审时间:2026-08-26。与 codex(gpt-5.6-sol,max)并行的独立评审。
前置:前端 646 / Rust 210 全绿——问题全在测试照不到处。

## P1(P0 无)

1. **toast 在会话门期间不可确认、不被播报**:NoticeToasts 挂在 .main 里,
   门把 .main inert;z=100 只赢视觉,inert 吞命中+无障碍树。修:出 .main
   挂 Shell 层 + fixed;结构测试钉死(.shell > .main .toasts 必须 null)。
2. **删除已入清单的登记卡 → 清单锁死 + y 永久虚高**:set 整单校验遇死 id
   即拒,面板任何编辑全失败只剩模板重置;y 计死 id、面板露裸 id。
   修:只校验新增、死 id 剔除+可见;live_roster 统一过滤。
3. **set 审计写失败(outbox)仍返回成功**:outbox 事件不进折叠,读回旧清单,
   前端刷回旧值,唯一提示是「审计暂存」——讲的不是清单。修:append_audit
   返回结局,非 Written 即 Err。
4. **编辑清单后列表不刷新**:同屏详情摘要/列表行 vs 面板两套数字。
   修:save 后 reload()。
5. **journal 半损静默**:skipped_lines/unreadable_files 被丢弃,最新 set
   恰在坏行时清单无声回退。修:计数入 warnings。
6. **配清单后次数消失**:清单外/未登记卡的完成拷卡不进 x/y 也不再显示。
   修:详情并列「共完成 N 次拷卡(部分来自清单外)」。
7. **bindStale 迁错类**:表单状态被系统改写属字段旁提示,不是提交后失败。
   修:回内联。

## P2(择要)

TrashScreen 部分失败被硬编码 error 且丢排障原因;NOTICE_TITLES 漏 19 个
code(一屏「发生错误」);Sorting 分析失败内联+toast 双报;DeliveryPanel
reveal 失败、FinalCutPanel 交付勾选写失败未迁移;空清单显示 0/0;面板
loadFailed 无重试、模板在读取中可点、登记表空时文案指路死胡同;同 label
多卡 find 任取第一张且 create 不查重名;match_card conflict 在 resolve/
自动并入被丢弃;catalog 每项目全量读 journal 的放大;start_copy 双
append_audit 阻塞放大;时钟漂移把刚删的卡加回;迁移断言不钉级别
(notice-toast-{level} testid 已有而未用);ProjectsScreen spy 无
mockImplementation 会污染模块级 mock 表。

## 已核

z 序 100>90/80 成立;::before 裁剪与暗色对比度达标(info 4.29/warn 6.04/
error 4.81:1);tokens.test 绿是真兼容(alias 于使用点代换,暗色自动跟随);
journal (ts,file,idx) 排序确定;HashSet 去重;uid=None 时兜底分支正确;
key={selected.id} 防串台;addId 复位;create_project 空卡表不误算;
scrollbar-width 单独存在无回归;reduced-motion 覆盖;「发起即 used、
完成才计 x」口径自洽。

(全部 P1 与主要 P2 已在 08e721c 收敛修复;边界声明见收敛记录。)
