//! 拷卡任务编排:后台线程驱动 core::copy,快照供查询,进度经 tauri 事件推送。

use super::dto::*;
use crate::core::{copy, journal, manifest, naming, project};
use chrono::Utc;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter};

pub const PROGRESS_EVENT: &str = "copy://progress";
/// 进度事件最小间隔(字节级进度节流;文件级事件不节流)。
const EMIT_INTERVAL_MS: u128 = 200;

pub struct TaskHandle {
    pub pause_requested: AtomicBool,
    pub running: AtomicBool,
    pub snapshot: Mutex<CopyTaskDto>,
    pub project_root: PathBuf,
    pub manifest_id: String,
    /// 源卷挂载点。可变:续传时可能按卷名重解析到新挂载点(卡后插/换口)。
    pub source_root: Mutex<PathBuf>,
    /// 引擎清单:每项自带源与目标相对路径(整卷时两者相同)。
    /// 与快照 `files` 按 `target_rel == CopyFileItemDto.id` 一一对应——
    /// 快照是给人看的展示层,落点权威只有这一份,不从展示字段反推路径。
    pub plan: Mutex<Vec<copy::PlannedFile>>,
    pub dest_targets: Vec<PathBuf>,
    pub machine_id: String,
    /// 应用配置目录(审计 outbox 兜底用)。
    pub config_dir: PathBuf,
    /// 续传路径在 worker 起来**之前**就取得的租约(刷新计划那次写也在保护内),
    /// worker 起来后接手。开拷路径为空,worker 自己取。
    pub lease: Mutex<Option<crate::core::lease::Held>>,
}

#[derive(Default)]
pub struct TaskManager {
    inner: Mutex<HashMap<String, Arc<TaskHandle>>>,
}

impl TaskManager {
    pub fn get(&self, task_id: &str) -> Option<Arc<TaskHandle>> {
        self.inner.lock().unwrap().get(task_id).cloned()
    }

    pub fn insert(&self, task_id: String, handle: Arc<TaskHandle>) {
        let mut map = self.inner.lock().unwrap();
        map.insert(task_id, handle);
        // 句柄回收(L20):终态任务超过 40 个时按完成时间淘汰最旧,防止全天拷卡后
        // 内存里堆满文件级快照
        const KEEP: usize = 40;
        if map.len() > KEEP {
            let mut finished: Vec<(String, String)> = map
                .iter()
                .filter(|(_, h)| {
                    let s = h.snapshot.lock().unwrap();
                    matches!(s.state, "done" | "failed")
                })
                .map(|(k, h)| (k.clone(), h.snapshot.lock().unwrap().started_at.clone()))
                .collect();
            finished.sort_by(|a, b| a.1.cmp(&b.1));
            let excess = map.len().saturating_sub(KEEP);
            for (k, _) in finished.into_iter().take(excess) {
                map.remove(&k);
            }
        }
    }

    /// 请求暂停全部在跑的拷贝任务(确认退出用,R2 P1:此前退出只管
    /// 作业与 ffmpeg,拷卡线程被硬杀在半写 .part 上;暂停走引擎安全点,
    /// part 残留由同任务重启清理,manifest 支持续传)。
    pub fn pause_all(&self) {
        for h in self.inner.lock().unwrap().values() {
            if h.running.load(Ordering::SeqCst) {
                h.pause_requested.store(true, Ordering::SeqCst);
            }
        }
    }

    /// 是否有任务的工作线程正在运行(安装更新前的安全闸)。
    pub fn any_running(&self) -> bool {
        self.inner
            .lock()
            .unwrap()
            .values()
            .any(|h| h.running.load(Ordering::SeqCst))
    }

    /// **含逐文件明细**的完整快照。只给诊断报告用。
    ///
    /// [`Self::snapshots`] 走 [`summary_of`],那一步会把 `files` 清空(列表契约:
    /// 明细另有分页命令去取)。诊断报告拿它就永远是「文件 0、没有失败文件」——
    /// 一个拷了 400 个文件、失败了 12 个的任务在报告里干干净净,
    /// 那不是信息缺失,是主动误导。
    pub fn detailed_snapshots(&self) -> Vec<CopyTaskDto> {
        let map = self.inner.lock().unwrap();
        let mut out: Vec<CopyTaskDto> = map
            .values()
            .map(|h| h.snapshot.lock().unwrap().clone())
            .collect();
        out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        out
    }

    pub fn snapshots(&self, project_id: Option<&str>) -> Vec<CopyTaskDto> {
        let map = self.inner.lock().unwrap();
        let mut out: Vec<CopyTaskDto> = map
            .values()
            .map(|h| summary_of(&h.snapshot.lock().unwrap()))
            .filter(|t| project_id.is_none_or(|p| t.project_id == p))
            .collect();
        out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        out
    }
}

/// 列表用摘要:按契约 files 置空、fileCount 保留。
pub fn summary_of(dto: &CopyTaskDto) -> CopyTaskDto {
    let mut t = dto.clone();
    t.file_count = Some(t.files.len());
    t.status_counts = Some(status_counts(&t.files));
    t.files = Vec::new();
    t
}

/// 全量状态计数(UX 评审 2.5):快照/进度事件自带聚合真值,
/// 前端不必翻完分页明细才看得到「已校验 x/y」总账。
pub fn status_counts(files: &[CopyFileItemDto]) -> CopyStatusCountsDto {
    let mut c = CopyStatusCountsDto::default();
    for f in files {
        match f.status {
            "copied" => c.copied += 1,
            "verified" => c.verified += 1,
            "failed" => c.failed += 1,
            // 未知状态按未完成计:总账宁可保守,不虚报完成
            _ => c.pending += 1,
        }
    }
    c
}

pub fn file_status_str(status: &copy::FileStatus) -> &'static str {
    match status {
        copy::FileStatus::Copied | copy::FileStatus::SkippedResume => "verified",
        copy::FileStatus::Failed(_) => "failed",
        // 主动中止的不是失败:续传会重拷,快照里回到待处理
        copy::FileStatus::AbortedMidFile => "pending",
    }
}

/// 启动(或续跑)一个任务的后台工作线程。
///
/// ## 已知未修:`Paused → Preparing → Running` 缺一个状态机 CAS(R12/R13 连续两轮被点名)
///
/// `running` 只是一个布尔。`resume_copy_task` 的流程是「读 `running` → 重解析源卷
/// → 复扫刷新清单 → 写回 `handle.plan`/快照 → `spawn_worker`」,这一整段**不是原子的**:
/// 两个 `resume` 并发进来时,两边都可能读到 `running == false`,于是**两遍**复扫、
/// 两遍写 `handle.plan`,最后靠这里的 `swap(true)` 只让一个 worker 真的起来。
/// 后果是准备阶段的副作用(清单写回、告警)可能重复,而不是两个 worker 同时拷同一份
/// 计划(那一层由 `swap` 挡住了)。
///
/// 为什么这一轮**没有**修:不是本轮引入的缺陷,正确的修法是把任务状态从布尔升级成
/// 一个 `Paused/Preparing/Running/Done` 状态机,并让整个准备阶段跑在一次 CAS 之内
/// ——改动面横跨 `TaskHandle`、`resume_copy_task`、`rebuild_tasks` 与全部快照读写,
/// 与本轮的白名单/令牌修复混在一起会让评审无法归因。留档在此与契约文档「已知未修」
/// 一节,下一轮单独做。
pub fn spawn_worker<R: tauri::Runtime>(app: AppHandle<R>, handle: Arc<TaskHandle>) {
    // 先清暂停标志再判 running:若旧 worker 还在跑且刚收到暂停请求,
    // 用户此刻点「继续」应让旧 worker 撤销暂停继续跑(评审 L19/P1-9)。
    handle.pause_requested.store(false, Ordering::SeqCst);
    if handle.running.swap(true, Ordering::SeqCst) {
        // 已有工作线程在跑(暂停请求已被上面撤销)。这也覆盖「上一次运行正在收尾」
        // 的窗口:用户点「继续」→ 界面闪一下 → 又回到暂停,若一声不吭就是静默 no-op
        let (id, pid) = {
            let s = handle.snapshot.lock().unwrap();
            (s.id.clone(), s.project_id.clone())
        };
        super::notify::info_for_task(
            &app,
            "copy-resume-already-running",
            (&id, &pid),
            "这个任务的上一次运行还没退出(正在收尾或仍在拷贝),本次「继续」没有另起新的运行;若它正在收尾,稍候再点一次".into(),
        );
        return;
    }
    std::thread::spawn(move || {
        // running 的复位放进 guard:下面任何路径(含二次 panic)都会清,否则任务
        // 永远卡在「运行中」
        struct RunningGuard<'a>(&'a AtomicBool);
        impl Drop for RunningGuard<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _running = RunningGuard(&handle.running);
        // panic 也要有终态:否则 running 永远是 true、任务卡在「运行中」、
        // 没有一条通知——用户只能重启应用
        let outcome = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_worker(&app, &handle)
        })) {
            Ok(r) => r,
            Err(payload) => {
                let what = payload
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| payload.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "(无说明)".into());
                Err(crate::core::CoreError::Invalid(format!(
                    "拷卡线程异常终止(程序内部错误:{what})。已拷部分与清单不受影响,可点「继续」续传;请导出诊断报告"
                )))
            }
        };
        // 拷卡写了 manifest/素材:目录统计缓存立即失效(M3 W3)
        if let Some(nas) = handle.project_root.parent() {
            crate::core::catalog::invalidate_cache(nas);
        }
        // 拷贝路径也消费 fsx 回退标记(终审:告警不能只挂在分类命令上)
        super::sorting_cmds::notify_if_unsafe_fallback(&app);
        // 拷完自动转代理(M3 T1.5):任务 done 且 manifest 带意图 → 派发作业
        if outcome.is_ok()
            && handle
                .snapshot
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .state
                == "done"
        {
            // 读不出清单就派不了自动转代理。此前是 `if let Ok(..)` 一声不吭:
            // 任务显示完成、代理却始终不出现,用户没有任何解释可循
            match manifest::load(&handle.project_root, &handle.manifest_id) {
                Err(e) => super::notify::warn(
                    &app,
                    "auto-proxy-deferred",
                    format!(
                        "拷卡已完成,但读不出清单,自动转代理这一步没能派发(素材不受影响,下次启动会补投):{e}"
                    ),
                ),
                Ok(m) => {
                    let (cfg, _) = crate::core::config::load_checked(&handle.config_dir);
                    super::transcode_cmds::dispatch_auto_proxy(
                        &app,
                        &handle.project_root,
                        &handle.machine_id,
                        &handle.config_dir,
                        &cfg.operator,
                        &m,
                    );
                }
            }
        }
        if let Err(e) = &outcome {
            let mut snap = handle.snapshot.lock().unwrap_or_else(|p| p.into_inner());
            snap.state = state_after_error(e);
            if snap.state == "failed" {
                snap.finished_at = Some(Utc::now().to_rfc3339());
            }
            // 目的地状态与任务终态保持一致(终验缺陷 #3)
            let dest_state = if snap.state == "paused" {
                "idle"
            } else {
                "error"
            };
            for d in snap.destinations.iter_mut() {
                d.state = dest_state;
            }
            snap.speed_bytes_per_sec = 0;
            // 原因也写进目的地,任务详情页点得开(不然只有一个红字 failed)
            for d in snap.destinations.iter_mut() {
                d.error = Some(e.to_string());
            }
            let folder = snap.target_folder.clone();
            let task_id = snap.id.clone();
            let proj_id = snap.project_id.clone();
            let paused = snap.state == "paused";
            drop(snap);
            log::warn!("拷卡任务中断: {e}");
            // 零静默:整任务级的中断此前只写 stderr(notify 模块头写着「只写
            // stderr 不算提示」),用户只看到任务变红、没有一个失败文件、没有原因
            // code 分两个:「可续传的暂停」和「真失败」在界面上是两件事,
            // 压在同一个 code 下会被合并窗口折叠成一条,还共用一个抬头
            // 带 task_id:界面才能给出「查看任务」把人送到那个「继续」跟前,
            // 并行拷卡同时暂停时也不会被合并成一条
            super::notify::error_for_task(
                &app,
                if paused {
                    "copy-task-paused"
                } else {
                    "copy-task-aborted"
                },
                (&task_id, &proj_id),
                if paused {
                    format!(
                        "拷卡任务「{folder}」已中断并转入暂停,已拷部分不会丢,排除原因后点「继续」即可从断点接着拷。\n原因:{e}\n{DIAG_HINT}"
                    )
                } else {
                    format!("拷卡任务「{folder}」失败。\n原因:{e}\n{DIAG_HINT}")
                },
            );
        }
        // 终态事件在 running=false 之后发(复核 P1-9):此刻点「继续」已能启动新 worker;
        // 事件读的是实时快照,若新 worker 已接手则发出的就是其当前状态,不会回退 UI
        drop(_running); // running=false 之后再发终态事件(此刻点「继续」已能起新 worker)
        let mut snap = handle.snapshot.lock().unwrap_or_else(|p| p.into_inner());
        let ev = final_event(&mut snap, Vec::new());
        drop(snap);
        let _ = app.emit(PROGRESS_EVENT, &ev);
    });
}

/// 续传源卷解析(纯函数,可测)。
/// **指纹优先**(M2 技术债:卷标弱身份根治):manifest 记录了卡指纹时,
/// 只认指纹匹配的卷——同名不同卡直接拒绝;指纹缺失(写保护卡/旧任务)
/// 退回卷名匹配:记录挂载点卷名相符沿用,否则按卷名全局重解析。
pub fn resolve_resume_source(
    recorded_mount: &std::path::Path,
    expected_label: &str,
    expected_uid: Option<&str>,
    volumes: &[(PathBuf, String)],
    read_uid: &dyn Fn(&std::path::Path) -> Option<String>,
) -> std::result::Result<PathBuf, String> {
    if let Some(uid) = expected_uid {
        for (mp, _) in volumes {
            if read_uid(mp).as_deref() == Some(uid) {
                return Ok(mp.clone());
            }
        }
        // 区分「没插卡」与「插了别的卡」,报文各说各的(评审 L3)
        if volumes.is_empty() {
            return Err(format!(
                "没有检测到可移动卷:请插入原卡「{expected_label}」后再续传"
            ));
        }
        return Err(format!(
            "当前挂载的卷中没有一张带有原卡的身份指纹:请插回原卡「{expected_label}」。若卡已被格式化,请重新发起拷卡(不会覆盖已拷素材)"
        ));
    }
    if let Some((mp, name)) = volumes.iter().find(|(mp, _)| mp == recorded_mount) {
        if name == expected_label {
            return Ok(mp.clone());
        }
    }
    if let Some((mp, _)) = volumes.iter().find(|(_, name)| name == expected_label) {
        return Ok(mp.clone());
    }
    if volumes.iter().any(|(mp, _)| mp == recorded_mount) {
        Err(format!(
            "源卷不匹配:任务记录的是「{expected_label}」,当前该位置挂载的是其他卷。请插回原卡"
        ))
    } else {
        Err(format!("源卷未挂载:请插回「{expected_label}」后再续传"))
    }
}

/// 续传准备(纯函数,可测):重解析源挂载点后,**必须**与固定目的地
/// 重新做布局校验(codex 终验 P0:重插的卡可能挂到目的地祖先,写回源卡)。
pub fn prepare_resume(
    recorded_mount: &std::path::Path,
    expected_label: &str,
    expected_uid: Option<&str>,
    volumes: &[(PathBuf, String)],
    dest_targets: &[PathBuf],
    read_uid: &dyn Fn(&std::path::Path) -> Option<String>,
) -> std::result::Result<PathBuf, String> {
    let resolved = resolve_resume_source(
        recorded_mount,
        expected_label,
        expected_uid,
        volumes,
        read_uid,
    )?;
    // R5 终审:续传同样走 canonical 投影复检(防目的地根上级链接回源卡)
    crate::core::paths::validate_dest_layout_projected(&resolved, dest_targets)?;
    Ok(resolved)
}

/// journal 追加带重试;彻底失败时写本机 outbox 兜底,绝不静默丢审计(评审 P1-7)。
/// 任何降级都向 UI 发用户可见通知(UX 原则:fail-open 不允许无提示)。
/// 审计事件的落盘结局:调用方若把事件当**配置**用(如用卡清单),
/// 非 Written 必须按失败处理——outbox 只保审计不丢,不保配置生效。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditWrite {
    Written,
    Outboxed,
    Lost,
}

pub fn append_audit<R: tauri::Runtime>(
    app: &AppHandle<R>,
    project_root: &std::path::Path,
    outbox_dir: &std::path::Path,
    ev: &journal::Event,
) -> AuditWrite {
    for _ in 0..3 {
        if journal::append(project_root, ev).is_ok() {
            return AuditWrite::Written;
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    let _ = std::fs::create_dir_all(outbox_dir);
    let mut outboxed = false;
    if let Ok(mut line) = serde_json::to_string(ev) {
        line.push('\n');
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(outbox_dir.join("journal-outbox.jsonl"))
        {
            outboxed = f.write_all(line.as_bytes()).is_ok();
        }
    }
    if outboxed {
        super::notify::warn(
            app,
            "audit-outbox",
            format!(
                "审计事件「{}」未能写入项目日志(NAS 可能不可达),已暂存本机,恢复后需人工合并 outbox",
                ev.kind
            ),
        );
        AuditWrite::Outboxed
    } else {
        super::notify::error(
            app,
            "audit-lost",
            format!(
                "审计事件「{}」写项目日志与本机暂存均失败,审计链出现缺口",
                ev.kind
            ),
        );
        AuditWrite::Lost
    }
}

/// 中断之后任务落到哪个状态。
///
/// IO 类错误(NAS 抖一下、杀毒软件占一下清单文件)是**可恢复的暂停**,不是死路
/// (评审 H4):已拷部分完好,点「继续」就从断点接着走。其余按失败终结。
///
/// 单独成函数只为一件事:判定必须走 [`CoreError::is_io`]。写成
/// `matches!(e, CoreError::Io(_))` 会把带人话的 `IoDetail` 漏判成死路——
/// 用户会被迫整卡重拷,而错的只是一次瞬时占用。
fn state_after_error(e: &crate::core::CoreError) -> &'static str {
    if e.is_resumable() {
        "paused"
    } else {
        "failed"
    }
}

/// 报错报文的固定尾巴。0.4.3 现场事故的真正痛点不是「看不见」,而是看见了也
/// **取不走**:运行日志躺在系统日志目录里,界面上一个入口都没有,用户只能
/// 把那一行报错抄给维护者。有了导出入口就得在出事的地方指过去。
const DIAG_HINT: &str = "把现场发给维护者:设置 → 关于与更新 → 导出诊断报告。";

fn run_worker<R: tauri::Runtime>(
    app: &AppHandle<R>,
    handle: &TaskHandle,
) -> crate::core::Result<()> {
    // 独占租约:同一个任务同时只允许一个进程写它的清单。
    // 清单落盘是整份覆盖,两处同时写时后写的会把先写的**整份顶掉**,而且
    // 自从临时名改成唯一的之后,这件事连个错都不报了(见 core::lease 模块头)。
    //
    // 顺序:**先租约,再读清单**。反过来会读到旧持有者释放前的快照,然后拿着
    // 陈旧的 entries 把人家最后写的进度整份顶掉。
    let operator = handle.snapshot.lock().unwrap().operator.clone();
    let taken = handle.lease.lock().unwrap().take();
    let mut lease = match taken {
        Some(h) => h, // 续传路径已在准备阶段取得(刷新计划那次写也在保护内)
        None => crate::core::lease::acquire(
            &handle.project_root,
            &handle.manifest_id,
            &handle.machine_id,
            &operator,
        )?,
    };
    if let Some(note) = lease.took_over_stale.take() {
        // 接管别人/自己残留的租约是「系统替用户做了决定」,零静默要求说出来;
        // 带任务:并行拷卡时同 code 的通知会按任务分桶,不会互相顶掉正文
        let (id, pid) = {
            let s = handle.snapshot.lock().unwrap();
            (s.id.clone(), s.project_id.clone())
        };
        super::notify::warn_for_task(app, "task-lease-taken-over", (&id, &pid), note);
    }
    let mut m = manifest::load(&handle.project_root, &handle.manifest_id)?;

    // 租约实现了 Drop:下面任何路径(含 panic)都会释放。显式 release 只是
    // 把意图写明,并顺手自查一次——删不掉时别人要白等 TTL,用户有权知道
    let outcome = run_worker_locked(app, handle, &mut m, &lease);
    let lease_file = lease.path().to_path_buf();
    match lease.release() {
        crate::core::lease::Released::Removed => {}
        // 被接管:轮询阶段已经报过 task-lease-lost,这里不重复
        crate::core::lease::Released::TakenOver => {}
        crate::core::lease::Released::RemoveFailed(why) => {
            // 留下的是**我们自己的**租约:别的机器要等 TTL;本机在本次运行期间也续不了
            // (pid 还活着,不算残留;重启 OCard 后 pid 不在了就能立刻接管)。得说清楚,
            // 否则用户点「继续」会撞上「本进程内的另一次续传」然后一头雾水
            super::notify::warn(
                app,
                "task-lease-left-behind",
                format!(
                    "任务结束后没能删掉自己的租约文件({why}):{}。别的机器在 {} 分钟内、本机在本次运行期间续这个任务都会被它挡住;重启 OCard 或手动删除该文件可立刻解锁",
                    lease_file.display(),
                    crate::core::lease::LEASE_TTL.num_minutes()
                ),
            );
        }
        crate::core::lease::Released::NoLock(why) => {
            // 没拿到接管锁就没敢删——盘上那份**可能已经是接管方的**。这里绝不能
            // 建议「手动删除」:照做就是删掉一个正在拷卡的进程的租约
            super::notify::warn(
                app,
                "task-lease-left-behind",
                format!(
                    "任务结束时没能确认租约文件的归属({why}),没有删除:{}。它可能仍是本进程的(别的机器要等 {} 分钟、本机重启 OCard 后可续),也可能已被别的进程接管——删除前请先确认没有别的 OCard 在跑这个任务",
                    lease_file.display(),
                    crate::core::lease::LEASE_TTL.num_minutes()
                ),
            );
        }
    }
    outcome
}

fn run_worker_locked<R: tauri::Runtime>(
    app: &AppHandle<R>,
    handle: &TaskHandle,
    m: &mut manifest::CopyManifest,
    lease: &crate::core::lease::Held,
) -> crate::core::Result<()> {
    let req = copy::CopyRequest {
        source_root: handle.source_root.lock().unwrap().clone(),
        destinations: handle.dest_targets.clone(),
        task_tag: handle.manifest_id.chars().take(8).collect(),
        // 口径取自 manifest(持久化的开拷选择):重启重建的任务也用同一把尺子
        selection: copy::SourceSelection::from_folders(m.source_selection.clone()),
    };

    // 单一清单:引擎、manifest、UI 快照消费同一份文件列表(评审 M11/P1-11)。
    // 从 manifest+目标实存恢复初始进度(续传场景)。
    let plan: Vec<copy::PlannedFile> = handle.plan.lock().unwrap().clone();
    if plan.is_empty() {
        // 零静默:清单为空说明接线出了问题,绝不能「跑完 0 个文件」再报成功
        return Err(crate::core::CoreError::Invalid(
            "任务清单为空,拒绝执行(请重新发起拷卡)".into(),
        ));
    }
    {
        let mut snap = handle.snapshot.lock().unwrap();
        // 引擎清单与 UI 快照必须按目标 rel 一一对应:对不上就会出现「文件在拷、
        // 界面不动」的静默失配,宁可当场拒绝也不让它悄悄跑
        let ids: std::collections::HashSet<&str> =
            snap.files.iter().map(|f| f.id.as_str()).collect();
        let orphan = plan
            .iter()
            .find(|p| !ids.contains(p.target_rel.as_str()))
            .map(|p| p.target_rel.clone());
        if let Some(rel) = orphan {
            return Err(crate::core::CoreError::Invalid(format!(
                "任务清单与界面快照不一致(缺少 {rel}),拒绝执行;请重新发起拷卡"
            )));
        }
        snap.state = "running";
        snap.finished_at = None;
        let mut done_bytes = 0u64;
        for f in snap.files.iter_mut() {
            // 轻量预判(仅 UI 快照口径);权威裁决在引擎 file_done(R5:免双重哈希)。
            // f.id 是**目标** rel,与 manifest 同口径
            if copy::file_done_light(m, &f.id, f.size_bytes, &req.destinations) {
                f.status = "verified";
                done_bytes += f.size_bytes;
            } else if f.status == "verified" {
                f.status = "pending"; // manifest 说验证过但目标不在了 → 重拷
            }
        }
        snap.copied_bytes = done_bytes;
    }

    let mut last_emit = Instant::now();
    let mut window_bytes = 0u64;
    let mut window_start = Instant::now();
    // 每类占用只发第一条(带路径,可执行);总数留给收尾那两条。
    // 收集在这里、出锁之后再发:notify 会写日志 + app.emit,不该在持有
    // snapshot 锁的时候做 IPC(同函数下面几行也是刻意先 drop 再 emit)
    let mut contention_reported: std::collections::HashSet<copy::ContentionKind> =
        Default::default();
    let mut pending_contention: Vec<(copy::ContentionKind, String, u32)> = Vec::new();
    let mut lease_stop_reported = false;
    let task_for_notices = {
        let s = handle.snapshot.lock().unwrap();
        (s.id.clone(), s.project_id.clone())
    };

    let outcome = copy::run_copy(&req, &plan, m, &handle.project_root, |p| {
        let mut changed: Vec<CopyFileItemDto> = Vec::new();
        let mut force_emit = false;
        {
            let mut snap = handle.snapshot.lock().unwrap();
            match &p {
                copy::Progress::Scanned { .. }
                | copy::Progress::FileStarted { .. }
                // 落盘前的租约询问:结论由回调末尾统一的 lease.poll() 给出
                | copy::Progress::AboutToSave { .. } => {}
                copy::Progress::Contention {
                    kind,
                    path,
                    retries,
                } => {
                    // 每类只报第一次:零静默要的是「当场知道」,不是把两小时里的
                    // 每一次重试都堆进通知积压(总数由收尾那条给)
                    if contention_reported.insert(*kind) {
                        pending_contention.push((*kind, path.display().to_string(), *retries));
                    }
                }
                copy::Progress::BytesCopied { delta, .. } => {
                    snap.copied_bytes += delta;
                    window_bytes += delta;
                }
                copy::Progress::FileFinished { rel_path, status } => {
                    force_emit = true;
                    if let Some(f) = snap.files.iter_mut().find(|f| f.id == *rel_path) {
                        f.status = file_status_str(status);
                        if let copy::FileStatus::Failed(e) = status {
                            f.error = Some(e.clone());
                        }
                        changed.push(f.clone());
                    }
                }
            }
            let elapsed = window_start.elapsed();
            if elapsed.as_millis() >= 1000 {
                snap.speed_bytes_per_sec = (window_bytes as f64 / elapsed.as_secs_f64()) as u64;
                window_bytes = 0;
                window_start = Instant::now();
            }
            if force_emit || last_emit.elapsed().as_millis() >= EMIT_INTERVAL_MS {
                last_emit = Instant::now();
                let ev = progress_event(&mut snap, changed);
                drop(snap);
                let _ = app.emit(PROGRESS_EVENT, &ev);
            }
        }
        // 锁已出:占用告警在这里发。notify 会写日志 + app.emit(IPC),
        // 持着 snapshot 锁做这些事是全文件唯一的例外,不留
        for (kind, path, retries) in pending_contention.drain(..) {
            // 两类各用各的 code:共用一个会在 30 秒合并窗口里互相顶掉正文,
            // 更要紧的素材那条可能就此消失
            let (code, what) = match kind {
                copy::ContentionKind::Manifest => ("fs-write-contention", "写入拷卡清单"),
                copy::ContentionKind::Material => {
                    ("material-rename-contention", "素材文件落位改名")
                }
            };
            super::notify::warn_for_task(
                app,
                code,
                (&task_for_notices.0, &task_for_notices.1),
                format!(
                    "{what}时被别的程序占着,重试 {retries} 轮后成功:{path}。多半是杀毒软件或 NAS 索引正在扫这个文件所在的目录;若反复出现,把该目录加入杀毒软件排除项,否则下次可能直接中断任务"
                ),
            );
        }
        // 租约状态轮询(心跳由独立线程推进,这里只看结论)。两种情况都要**立刻**停,
        // 而且不再写清单(CopyControl::Abort):Lost = 别人已合法接管,再写就是把人家
        // 记下的进度整份顶掉;AtRisk = 心跳很久没成功,再拷下去很快就会变成 Lost
        let lease_verdict = match lease.poll() {
            crate::core::lease::LeaseStatus::Ok => None,
            crate::core::lease::LeaseStatus::Lost(who) => {
                if !lease_stop_reported {
                    lease_stop_reported = true;
                    super::notify::error_for_task(
                        app,
                        "task-lease-lost",
                        (&task_for_notices.0, &task_for_notices.1),
                        format!(
                            "本进程不再持有这个任务的租约,现在是 {who} 持有(可能是本机心跳中断过,也可能是租约文件被外部删除或替换)。为避免两边同时写清单,已在文件边界停下并放弃写回,转为暂停。请确认那边的进度,再决定在哪边续传"
                        ),
                    );
                }
                Some(copy::CopyControl::Abort)
            }
            crate::core::lease::LeaseStatus::AtRisk(why) => {
                if !lease_stop_reported {
                    lease_stop_reported = true;
                    super::notify::error_for_task(
                        app,
                        "task-lease-at-risk",
                        (&task_for_notices.0, &task_for_notices.1),
                        format!(
                            "任务租约的心跳出了问题:{why}。为避免被别的进程接管后两边同时写清单,已在文件边界停下并放弃写回,转为暂停;排查后点「继续」"
                        ),
                    );
                }
                Some(copy::CopyControl::Abort)
            }
        };
        if let Some(abort) = lease_verdict {
            handle.pause_requested.store(true, Ordering::SeqCst);
            return abort;
        }
        if handle.pause_requested.load(Ordering::SeqCst) {
            copy::CopyControl::Pause
        } else {
            copy::CopyControl::Continue
        }
    })?;

    // 收尾:状态、审计、终态事件
    let task_id;
    let operator;
    let target_folder;
    {
        let mut snap = handle.snapshot.lock().unwrap();
        operator = snap.operator.clone();
        task_id = snap.id.clone();
        target_folder = snap.target_folder.clone();
        snap.speed_bytes_per_sec = 0;
        snap.state = if outcome.paused {
            "paused"
        } else if outcome.all_verified {
            "done"
        } else {
            "failed"
        };
        if !outcome.paused {
            snap.finished_at = Some(Utc::now().to_rfc3339());
        }
        let dest_state = match snap.state {
            "done" => "done",
            "paused" => "idle",
            _ => "error",
        };
        // 主动中止时,快照的 copied_bytes 吃进了当前文件的部分 delta,而那个 part
        // 已被清掉;按引擎的 bytes_copied(只算落位的)回填,别让界面虚高
        if outcome.aborted {
            snap.copied_bytes = outcome.bytes_copied;
        }
        let written = snap.copied_bytes;
        for d in snap.destinations.iter_mut() {
            d.state = dest_state;
            d.written_bytes = written;
        }
        // 终态事件由 spawn_worker 在 running=false 之后统一发出(复核 P1-9)
    }

    // 收尾总账:开头那条只报了第一次(带路径),这里给总数——用户要能判断
    // 「偶发一次」和「五百次」的区别,后者说明这台机器上必须去改杀软配置
    let total_retries = outcome.write_retries + outcome.material_retries;
    if total_retries > 0 {
        super::notify::warn_for_task(
            app,
            "fs-write-contention-total",
            (&task_id, &task_for_notices.1),
            format!(
                "本次拷卡累计 {total_retries} 轮落盘重试(写清单 {} 轮、素材落位 {} 轮;每轮最多等 0.9 秒)。任务结果不受影响,但它解释了为什么慢;把项目目录加入杀毒软件排除项可以消掉",
                outcome.write_retries, outcome.material_retries
            ),
        );
    }

    // 零静默中的最高危一条:部分拷贝完成时,`all_verified` 只代表**所选文件夹**
    // 全过了,卡上其余内容一个字节都没拷。UI 那句「本卡可格式化」在这种任务上
    // 是错的,会直接导致用户格式化掉没备份的素材——后端必须自己喊一嗓子。
    if !outcome.paused && outcome.all_verified && !m.source_selection.is_empty() {
        super::notify::warn(
            app,
            "copy-partial-scope-done",
            format!(
                "任务「{target_folder}」只拷贝了所选的 {} 个文件夹({}),卡上其余内容**没有**备份——请勿据此格式化这张卡",
                m.source_selection.len(),
                m.source_selection
                    .iter()
                    .map(|f| if f.is_empty() { "卡根目录" } else { f.as_str() })
                    .take(5)
                    .collect::<Vec<_>>()
                    .join("、")
            ),
        );
    }

    for f in &outcome.files {
        // AbortedMidFile 不进失败审计:那是主动中止,续传会重拷,不是这个文件失败
        if let copy::FileStatus::Failed(e) = &f.status {
            append_audit(
                app,
                &handle.project_root,
                &handle.config_dir,
                &journal::Event::new(
                    handle.machine_id.clone(),
                    operator.clone(),
                    journal::kind::COPY_FILE_FAILED,
                    // file = 落点,sourceFile = 卡上的真实文件:扁平化改名后
                    // 只报落点,事后没法回卡上找这个文件
                    serde_json::json!({
                        "taskId": task_id,
                        "file": f.rel_path,
                        "sourceFile": f.source_rel,
                        "error": e,
                    }),
                ),
            );
        }
    }
    if !outcome.paused {
        append_audit(
            app,
            &handle.project_root,
            &handle.config_dir,
            &journal::Event::new(
                handle.machine_id.clone(),
                operator,
                journal::kind::COPY_COMPLETED,
                serde_json::json!({
                    "taskId": task_id,
                    "manifestId": handle.manifest_id,
                    "allVerified": outcome.all_verified,
                    "bytesCopied": outcome.bytes_copied,
                    // 审计必须记下这次的范围:allVerified 在部分拷贝下只覆盖所选夹子
                    "sourceFolders": m.source_selection,
                    // R13 C6:也记下扫描策略版本。缺这个字段(或为 0)的历史行
                    // 出自**旧口径**——当时点开头的素材根本没进计划,`allVerified`
                    // 与「本卡可格式化」都不可信。审计日志是唯一能追溯到那批
                    // 「假绿」的地方,没有版本号就永远分不出真绿假绿。
                    "scanPolicyVersion": m.scan_policy_version,
                }),
            ),
        );
    }
    if outcome.aborted {
        // 审计与总账已经写完,现在才把「租约没了」抛上去让任务落到暂停
        return Err(copy::lease_abort());
    }
    Ok(())
}

fn progress_event(snap: &mut CopyTaskDto, changed: Vec<CopyFileItemDto>) -> CopyProgressEventDto {
    let rev = snap.progress_revision.unwrap_or(0) + 1;
    snap.progress_revision = Some(rev);
    CopyProgressEventDto {
        task_id: snap.id.clone(),
        revision: rev,
        occurred_at: Utc::now().to_rfc3339(),
        copied_bytes: snap.copied_bytes,
        speed_bytes_per_sec: snap.speed_bytes_per_sec,
        state: snap.state,
        changed_files: changed,
        changed_destinations: Vec::new(),
        status_counts: Some(status_counts(&snap.files)),
    }
}

fn final_event(snap: &mut CopyTaskDto, changed: Vec<CopyFileItemDto>) -> CopyProgressEventDto {
    let mut ev = progress_event(snap, changed);
    ev.changed_destinations = snap.destinations.clone();
    ev
}

/// 计划项 → 快照文件项。`id` 用**目标** rel(manifest/续传的身份,不可换);
/// `path`/`name` 用**源**路径(types.ts 明确写着 path 是「源卡内相对路径」,
/// 界面上人要按它回卡上找文件)。落点被改写的清单单独走 renamed_files 呈现。
pub fn file_item_dto(p: &copy::PlannedFile) -> CopyFileItemDto {
    CopyFileItemDto {
        id: p.target_rel.clone(),
        path: p.source_rel.clone(),
        name: p
            .source_rel
            .rsplit('/')
            .next()
            .unwrap_or(&p.source_rel)
            .to_string(),
        size_bytes: p.size,
        status: "pending",
        hash: None,
        error: None,
        targets: None,
    }
}

/// 由 StartCopyInput 组装任务快照与落盘目标。
/// 目标夹命名走规范函数(评审 M14/P1-13):工况 A 强制 YYYYMMDD 前缀。
///
/// `source_folders` 必须由调用方传**引擎真正采用的** selection
/// (`SourceSelection::to_folders()`),不能拿 `input.source_folders` 原始输入:
/// DTO 的这个字段是「拷完能不能说本卡可格式化」的唯一判据,与 manifest 分叉
/// 会让同一个任务重启前后显示的范围不一样,判据一旦不可信就可能引导用户
/// 格式化掉未备份素材(R2)。
#[allow(clippy::too_many_arguments)]
pub fn build_task(
    input: &StartCopyInput,
    project_root: &std::path::Path,
    scenario: project::Scenario,
    volume_name: &str,
    camera_code: &str,
    operator: &str,
    plan: &[copy::PlannedFile],
    manifest_id: &str,
    source_folders: &[String],
) -> crate::core::Result<(CopyTaskDto, Vec<PathBuf>)> {
    let target_folder = match scenario {
        project::Scenario::A => {
            let date = chrono::NaiveDate::parse_from_str(
                &naming::validate_date_prefix(&input.target_prefix)?,
                "%Y%m%d",
            )
            .expect("validate_date_prefix 已校验");
            naming::card_folder_name_a(date, camera_code)
        }
        project::Scenario::B => naming::card_folder_name_b(&input.target_prefix, camera_code)?,
    };
    let raw_dir = project::raw_material_dir(project_root, scenario);

    let mut dest_dtos = Vec::new();
    let mut dest_targets = Vec::new();
    for (i, d) in input.destinations.iter().enumerate() {
        // NAS 主目的地按规范落在项目素材根下;本地/移动硬盘以所选路径为基底
        let base = if d.kind == "nas" {
            raw_dir.clone()
        } else {
            PathBuf::from(&d.path)
        };
        let target = base.join(&target_folder);
        dest_dtos.push(CopyDestinationDto {
            id: format!("dest-{i}"),
            kind: d.kind.clone(),
            path: target.display().to_string(),
            state: "writing",
            written_bytes: 0,
            verified_bytes: None,
            error: None,
        });
        dest_targets.push(target);
    }

    let total_bytes = plan.iter().map(|p| p.size).sum();
    let file_dtos = plan.iter().map(file_item_dto).collect();

    let dto = CopyTaskDto {
        id: manifest_id.to_string(),
        project_id: input.project_id.clone(),
        volume_id: input.volume_id.clone(),
        volume_name: volume_name.to_string(),
        camera_id: input.camera_id.clone(),
        camera_code: camera_code.to_string(),
        note: input.note.clone(),
        tags: input.tags.clone(),
        target_folder,
        source_folders: source_folders.to_vec(),
        // 新任务一律是当前口径(与 `manifest::CopyManifest::new` 同源)
        scan_policy_version: manifest::SCAN_POLICY_VERSION,
        destinations: dest_dtos,
        files: file_dtos,
        file_count: Some(plan.len()),
        status_counts: None, // 快照对外发布时由 summary_of 现算
        total_bytes,
        copied_bytes: 0,
        speed_bytes_per_sec: 0,
        state: "running",
        progress_revision: Some(0),
        operator: operator.to_string(),
        started_at: Utc::now().to_rfc3339(),
        finished_at: None,
    };
    Ok((dto, dest_targets))
}

#[cfg(test)]
mod tests {
    /// 0.4.3 现场事故的回归网:`manifest::save` 的拒绝访问现在是 `IoDetail`,
    /// 判定退回 `matches!(e, CoreError::Io(_))` 时本测试红——那一退就把
    /// 「杀毒软件占了一下清单」判成死路,整卡素材被迫重拷。
    #[test]
    fn io_class_interruptions_pause_for_resume_everything_else_ends_the_task() {
        use crate::core::CoreError;
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert_eq!(super::state_after_error(&CoreError::Io(denied)), "paused");
        assert_eq!(
            super::state_after_error(&CoreError::io_detail(
                "写入拷卡清单",
                std::path::Path::new("Z:/p/.ocard/manifests/a.json"),
                &std::io::Error::from(std::io::ErrorKind::PermissionDenied),
            )),
            "paused",
            "带人话的 IO 错误还是 IO 错误,必须可续传"
        );
        // 清单损坏/被篡改这类不是「等一下就好」,续传只会一直撞同一堵墙
        assert_eq!(
            super::state_after_error(&CoreError::Invalid("任务清单为空".into())),
            "failed"
        );
        // 被别人暂时占着(租约):等那边结束就能续,判成 failed 会把用户引去看
        // 一份不存在的红字明细
        assert_eq!(
            super::state_after_error(&CoreError::Busy("正被别人执行".into())),
            "paused"
        );
    }

    use super::resolve_resume_source;
    use std::path::PathBuf;

    fn vols(list: &[(&str, &str)]) -> Vec<(PathBuf, String)> {
        list.iter()
            .map(|(mp, n)| (PathBuf::from(mp), n.to_string()))
            .collect()
    }

    #[test]
    fn same_mount_same_label_is_reused() {
        let v = vols(&[("/Volumes/CARD", "CARD")]);
        assert_eq!(
            resolve_resume_source(&PathBuf::from("/Volumes/CARD"), "CARD", None, &v, &|_| None)
                .unwrap(),
            PathBuf::from("/Volumes/CARD")
        );
    }

    #[test]
    fn card_replugged_at_new_mount_is_re_resolved() {
        // 卡后插被挂到了新位置(复核必修 A 的核心场景)
        let v = vols(&[("/Volumes/CARD 1", "CARD")]);
        assert_eq!(
            resolve_resume_source(&PathBuf::from("/Volumes/CARD"), "CARD", None, &v, &|_| None)
                .unwrap(),
            PathBuf::from("/Volumes/CARD 1")
        );
    }

    #[test]
    fn different_card_at_recorded_mount_is_rejected() {
        // 同一挂载点换了另一张卡 → 拒绝(评审 M10)
        let v = vols(&[("/Volumes/CARD", "OTHER")]);
        let err =
            resolve_resume_source(&PathBuf::from("/Volumes/CARD"), "CARD", None, &v, &|_| None)
                .unwrap_err();
        assert!(err.contains("源卷不匹配"), "{err}");
    }

    #[test]
    fn missing_card_reports_unmounted() {
        let v = vols(&[("/Volumes/ELSE", "ELSE")]);
        let err =
            resolve_resume_source(&PathBuf::from("/Volumes/CARD"), "CARD", None, &v, &|_| None)
                .unwrap_err();
        assert!(err.contains("源卷未挂载"), "{err}");
    }
}

#[cfg(test)]
mod prepare_resume_tests {
    use super::prepare_resume;
    use crate::core::paths::tests::abs;
    use std::path::PathBuf;

    #[test]
    fn rebind_landing_on_dest_ancestor_is_rejected() {
        // codex 微验 #17:resume 接线级覆盖——重插的卡挂到了备份目的地的祖先盘符
        let vols: Vec<(PathBuf, String)> = vec![(abs("/mnt/f"), "CARD".to_string())];
        let dests = vec![abs("/mnt/f/Backup/target")];
        let err =
            prepare_resume(&abs("/mnt/e"), "CARD", None, &vols, &dests, &|_| None).unwrap_err();
        assert!(err.contains("嵌套"), "{err}");
    }

    #[test]
    fn rebind_with_disjoint_layout_succeeds() {
        let vols: Vec<(PathBuf, String)> = vec![(abs("/mnt/g"), "CARD".to_string())];
        let dests = vec![abs("/nas/target"), abs("/backup/target")];
        assert_eq!(
            prepare_resume(&abs("/mnt/e"), "CARD", None, &vols, &dests, &|_| None).unwrap(),
            abs("/mnt/g")
        );
    }
}

#[cfg(test)]
mod uid_resolution_tests {
    use super::resolve_resume_source;
    use crate::core::paths::tests::abs;
    use std::path::PathBuf;

    fn vols(list: &[(&str, &str)]) -> Vec<(PathBuf, String)> {
        list.iter()
            .map(|(mp, n)| (abs(mp), n.to_string()))
            .collect()
    }

    #[test]
    fn uid_match_wins_over_label_and_mount() {
        // 卡后插挂到新位置、卷名还被改了:指纹照样找到它
        let v = vols(&[("/Volumes/RENAMED", "OTHER")]);
        let hit = abs("/Volumes/RENAMED");
        let resolved =
            resolve_resume_source(&abs("/Volumes/OLD"), "CARD", Some("uid-123"), &v, &|p| {
                (p == hit).then(|| "uid-123".to_string())
            })
            .unwrap();
        assert_eq!(resolved, abs("/Volumes/RENAMED"));
    }

    #[test]
    fn same_label_different_card_rejected_by_uid() {
        // 同名不同卡(相机格式化后的典型):指纹不符必须拒绝——弱身份根治的核心断言
        let v = vols(&[("/Volumes/CARD", "CARD")]);
        let err = resolve_resume_source(
            &abs("/Volumes/CARD"),
            "CARD",
            Some("uid-original"),
            &v,
            &|_| Some("uid-impostor".to_string()),
        )
        .unwrap_err();
        assert!(err.contains("身份指纹"), "{err}");
        assert!(err.contains("插回原卡"), "{err}");
    }

    #[test]
    fn uid_mismatch_message_distinguishes_no_volume_at_all() {
        // 评审 L3:没插卡与插错卡要说不同的话
        let err = resolve_resume_source(
            &abs("/Volumes/CARD"),
            "CARD",
            Some("uid-original"),
            &[],
            &|_| None,
        )
        .unwrap_err();
        assert!(err.contains("没有检测到可移动卷"), "{err}");
    }

    #[test]
    fn missing_uid_falls_back_to_label() {
        let v = vols(&[("/Volumes/CARD", "CARD")]);
        let resolved =
            resolve_resume_source(&abs("/Volumes/CARD"), "CARD", None, &v, &|_| None).unwrap();
        assert_eq!(resolved, abs("/Volumes/CARD"));
    }
}
