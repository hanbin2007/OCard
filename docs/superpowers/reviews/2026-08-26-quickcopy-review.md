# 快捷拷卡评审收敛记录(2026-08-26)

对象:快捷拷卡首版(commit `275d2a9`,用户点单:插卡检测→未登记引导登记、已登记问加入用卡清单并引导拷卡)。
双路评审:opus-4.8(带实测复现)+ gpt-5.6-sol(codex,max,只读)。codex 结论 Request changes(P0×8)。

## 共识 P0(全部修复)

| 项 | 修法 |
| --- | --- |
| 会话门键盘旁路(opus P0-1 = codex P0-1,opus 实测:门开着 Tab+Enter 能以上一位操作人身份写 NAS) | SessionGuard inert 选择器扩到 `.shell > .quick-copy`;stacking 用例名收窄为只钉 z 层;新增行为用例:门开(假时钟推进 15+5 分钟)时浮层必须落在 `[inert]` 子树内 |
| cardDraft 覆盖用户手改绑定卷/草稿复活绑错物理卡(opus P1-1/P1-2 实测 = codex P0-8) | 草稿只消费一次:进屏预填后立即 `cardDraftConsumed`,续接判定走本地 `quickDraftRef`;登记成功一律作废 ref(与续接判定解耦);卷已拔走时草稿作废并出声 |

## codex 独有 P0(逐条处置)

| 项 | 处置 |
| --- | --- |
| P0-2「读不到登记表/匹配冲突被误导成未登记」→ 引导重复登记 | **修复**:后端 `VolumeDto.match_status`(matched/unregistered/unavailable/conflict)判别字段;前端 unavailable/conflict 分支只给「重试核对/忽略」,不引导登记 |
| P0-5 draft 预填不清确认态 →「对着 A 的预览确认,任务落到 B」 | **修复**:copyDraft 消费时确认态整体归零(confirming/preview/prefix 等,与切项目归零同一套) |
| P0-6 joinAndCopy 旧闭包越过上下文;joinBusy 时「直接拷卡」未禁用 | **修复**:await 后经 `liveRef` 复核队首与项目未变才导航(变了只发「已加入」回执不导航);qc-copy 在 joinBusy 期间禁用 |
| P0-7 多机读-改-写整表覆盖丢清单 | **修复**:新增后端原子命令 `add_project_card`,写可交换增量事件 `PROJECT_CARD_ADDED`(与 PROJECT_CARD_USED 同型折叠),幂等;前端 joinAndCopy 改用它 |
| P0-3 挂载路径非物理卡身份(2s 窗口同路径换卡不发事件) | **声明边界**:拷卡有双确认屏(卷名/文件清单人工核对)+ draft 预填即清确认态兜底;device-token 贯穿与平台原生事件(PRD §6.5)一并做,记技术债 |
| P0-4 队首提前出队,多卡引导草稿单槽覆盖 | **声明边界**:同时只有一条引导草稿,后发起的引导覆盖先前的(符合「用户改主意」直觉);登记续接按队列顺序轮到 |

## P1(全部修复)

- **启动对账**(opus P1-5 = codex P1-1):订阅建立后拉一次全量卷入队(reducer 过滤),覆盖「先插卡后开软件」的标准动作;只在真后端跑(`volumesWatchAvailable`),mock/测试环境不制造噪声。emit 失败不再推进基线(下一轮重发同批差集),失败锁存在恢复后复位。
- **零静默缺口**(opus P1-3 = codex P1-3):登记续接的 listVolumes 失败改为可见 warning + `volumeMatchPatched` 定点补丁(不再拿闭包旧表整表覆盖);两处草稿静默丢弃补 info 提示(`quick-copy-draft-dropped`)。
- **toast 同角遮挡**(opus P1-4):浮层挪到左下(`left: calc(--sidebar-width + space-4)`),右下整角让给 toast 栈。
- **removable 硬过滤**(opus P1-6 = codex P1-4):改为只排除系统盘 + NAS 挂载卷,与全 App 口径一致(sysinfo 对读卡器常给 false)。
- **项目统计陈旧**(opus P1-7 = codex P1-5):加入清单成功后 `listProjects` → `projectsLoaded` 轻量对账。
- **乱序回踩/悬空队首**(opus P2-1/2-2 = codex P1-2):listVolumes 响应加单调 seq 守卫;`bootstrapped` 同样修剪队列;组件对悬空队首自愈出队。
- **假绿修正**(opus P1-8/P2-7/P2-8 = codex P1-6):stacking 用例名收窄;新增门 inert 行为用例;reducer 纯测试 7 例(过滤/去重/拔卡/整表替换/定点补丁);spy call-through 改 mockResolvedValue,不再污染模块级 mock。

## P2(修复摘要)

roster 状态按卷 id key 隔离(重插不复用旧结论);Esc=忽略;`role="region"`+`aria-live="polite"`(非模态 dialog 读屏不播报);「去拷卡」在未加入分支改「不加入,直接拷卡」;watcher 每轮 catch_unwind(panic 可见并继续);diff_ids 返回当前 id 集免重复计算、doc 归位;removedIds 注明保留字段;NOTICE_TITLES 补 quick-copy-draft-dropped。

## 声明边界(记录在案)

- 监视线程固定 2s 轮询、无停止通道:app 生命周期线程;平台原生事件(DiskArbitration/Win32/udev,PRD §6.5)落地时一并处理退避与停机。NAS statfs 阻塞可能让轮询临时停摆,恢复自愈。
- `PROJECT_CARDS_SET` 整表事件与增量 ADDED 并存:面板「整单编辑」仍走 SET(last-write-wins,既有声明),快捷加入走 ADDED(可交换)。
- 启动对账会对每次启动时已挂载的非系统卷各提示一次;忽略即出队,不持久记忆「已忽略」。
- e2e(wdio)层暂无快捷拷卡用例,锚点已预留。
