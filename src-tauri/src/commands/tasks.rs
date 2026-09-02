//! 拷卡任务编排:后台线程驱动 core::copy,快照供查询,进度经 tauri 事件推送。

use super::dto::*;
use crate::core::{copy, journal, manifest, naming, project};
use chrono::Utc;
use std::collections::HashMap;
use std::path::Path;
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

impl TaskHandle {
    /// 中毒也照读:worker 持锁时 panic 会让这把锁中毒,之后界面每次刷新都撞
    /// `unwrap()` 再 panic——任务列表整个不动了,而通知中心一条没有。
    pub fn snap(&self) -> std::sync::MutexGuard<'_, CopyTaskDto> {
        self.snapshot.lock().unwrap_or_else(|p| p.into_inner())
    }
    pub fn plan_guard(&self) -> std::sync::MutexGuard<'_, Vec<copy::PlannedFile>> {
        self.plan.lock().unwrap_or_else(|p| p.into_inner())
    }
    pub fn source_root_guard(&self) -> std::sync::MutexGuard<'_, PathBuf> {
        self.source_root.lock().unwrap_or_else(|p| p.into_inner())
    }
    pub fn lease_slot(&self) -> std::sync::MutexGuard<'_, Option<crate::core::lease::Held>> {
        self.lease.lock().unwrap_or_else(|p| p.into_inner())
    }
}

#[derive(Default)]
pub struct TaskManager {
    inner: Mutex<HashMap<String, Arc<TaskHandle>>>,
}

impl TaskManager {
    pub fn get(&self, task_id: &str) -> Option<Arc<TaskHandle>> {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(task_id)
            .cloned()
    }

    pub fn insert(&self, task_id: String, handle: Arc<TaskHandle>) {
        let mut map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        map.insert(task_id, handle);
        // 句柄回收(L20):终态任务超过 40 个时按完成时间淘汰最旧,防止全天拷卡后
        // 内存里堆满文件级快照
        const KEEP: usize = 40;
        if map.len() > KEEP {
            let mut finished: Vec<(String, String)> = map
                .iter()
                .filter(|(_, h)| {
                    let s = h.snap();
                    matches!(s.state, "done" | "failed")
                })
                .map(|(k, h)| (k.clone(), h.snap().started_at.clone()))
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
        for h in self
            .inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
        {
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
        let map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let mut out: Vec<CopyTaskDto> = map.values().map(|h| h.snap().clone()).collect();
        out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        out
    }

    pub fn snapshots(&self, project_id: Option<&str>) -> Vec<CopyTaskDto> {
        let map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let mut out: Vec<CopyTaskDto> = map
            .values()
            .map(|h| summary_of(&h.snap()))
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
/// ## 准备阶段的并发(R12/R13 曾点名缺状态机 CAS,0.4.4 起由租约挡住)
///
/// `running` 只是一个布尔,但准备阶段的并发已经由**租约**挡住:`resume_copy_task` 第一件
/// 事就是 `lease::acquire`,同进程第二次并发 resume 会在那里撞 Busy(pid 活着、token 不同),
/// 走不到复扫与写回。这里的 `swap(true)` 只剩最后一道保险:守着「上一次运行还在收尾」
/// 这段时间里的重复「继续」。
pub fn spawn_worker<R: tauri::Runtime>(app: AppHandle<R>, handle: Arc<TaskHandle>) {
    // 先清暂停标志再判 running:若旧 worker 还在跑且刚收到暂停请求,
    // 用户此刻点「继续」应让旧 worker 撤销暂停继续跑(评审 L19/P1-9)。
    let revoked_pause = handle.pause_requested.swap(false, Ordering::SeqCst);
    if handle.running.swap(true, Ordering::SeqCst) {
        // 已有工作线程在跑。两种情况要分开说:它正在等暂停 → 用户的「继续」其实
        // 已经生效(暂停请求被撤销,旧运行接着跑);它正在收尾 → 本次没起新运行,
        // 稍候再点。混成一句「没生效」是误导
        let (id, pid) = {
            let s = handle.snap();
            (s.id.clone(), s.project_id.clone())
        };
        let msg = if revoked_pause {
            "已撤销暂停请求,上一次运行接着跑(没有另起新的运行)"
        } else {
            "这个任务的上一次运行还在收尾,本次「继续」没有另起新的运行;稍候再点一次"
        };
        // 两种情况 code 也分开:抬头「继续未生效」对「已撤销暂停请求、接着跑」是反的
        if revoked_pause {
            super::notify::info_for_task(
                &app,
                "copy-resume-revoked-pause",
                (&id, &pid),
                msg.into(),
            );
        } else {
            super::notify::info_for_task(
                &app,
                "copy-resume-already-running",
                (&id, &pid),
                msg.into(),
            );
        }
        // 防御:这条路现有顺序到不了「槽里还有一份带心跳的租约」(第二次续传会先被
        // acquire 的 Busy 挡住),但槽里一份 Held 一旦漏了就是本进程生命周期内的永久自锁
        if let Some(lease) = handle.lease_slot().take() {
            let lease_file = lease.path().to_path_buf();
            report_lease_release(
                &app,
                lease.release_reported(),
                &lease_file,
                "重复的续传请求回滚",
                false,
                Some((&id, &pid)),
            );
            // 释放(接管锁取得 / 标记删不掉)留在这条命令线程上的降级也带 scope 取走
            super::sorting_cmds::notify_if_unsafe_fallback_for(&app, Some((&id, &pid)));
        }
        return;
    }
    let app_for_spawn_error = app.clone();
    let handle_for_spawn_error = handle.clone();
    let spawned = std::thread::Builder::new().name("ocard-copy-worker".into()).spawn(move || {
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
        // 降级标记是线程局部的:拷卡 worker 在这条线程上落位,也在这里取走,并带任务 scope
        {
            let s = handle.snapshot.lock().unwrap_or_else(|p| p.into_inner());
            let (tid, pid) = (s.id.clone(), s.project_id.clone());
            drop(s);
            super::sorting_cmds::notify_if_unsafe_fallback_for(&app, Some((&tid, &pid)));
        }
        // 拷完自动转代理(M3 T1.5):任务 done 且 manifest 带意图 → 派发作业
        let done_task = {
            let s = handle.snapshot.lock().unwrap_or_else(|p| p.into_inner());
            (s.id.clone(), s.project_id.clone())
        };
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
                Err(e) => super::notify::warn_for_task(
                    &app,
                    "auto-proxy-deferred",
                    (&done_task.0, &done_task.1),
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
            let mut snap = handle.snap();
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
                if paused && e.to_string().contains(crate::core::lease::LOCK_DIR_BROKEN_PREFIX) {
                    // 锁目录不清理的话点「继续」也没用——最响最持久的这条不能给错指令
                    format!(
                        "拷卡任务「{folder}」已中断并转入暂停,已拷部分不会丢。这次的原因不会自己好:请先人工清理清单目录里的租约锁目录,再点「继续」。\n原因:{e}\n{DIAG_HINT}"
                    )
                } else if paused
                    && matches!(e, crate::core::CoreError::Busy(_))
                    && (e.to_string().contains("租约") || e.to_string().contains("接管锁"))
                {
                    // 租约原因的中止:上一条租约提示已经说了「先核对另一处」,这里不能反过来
                    // 让人「点继续」——照做会立刻撞上「任务正被别的进程执行,拒绝续传」
                    format!(
                        "拷卡任务「{folder}」已中断并转入暂停,已拷部分不会丢。原因见上一条租约提示:不要在两台机器上同时续传,确认另一处已停下后再点「继续」。\n原因:{e}\n{DIAG_HINT}"
                    )
                } else if paused {
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
        let mut snap = handle.snap();
        let ev = final_event(&mut snap, Vec::new());
        drop(snap);
        let _ = app.emit(PROGRESS_EVENT, &ev);
    });
    if let Err(e) = spawned {
        // 线程都起不来(句柄耗尽等):running 已经被 swap 成 true,必须清回去,
        // 否则任务永远「运行中」;并且要说。顺序:先释放租约、再清 running——
        // 反过来的话释放的那几秒里点「继续」会撞上「本进程内的另一次续传」
        // 续传阶段预先拿到的租约还在槽里、心跳还在跳:不释放的话下一次「继续」会先
        // 重新 acquire,被自己这份挡住,而报文说的是「稍后点继续」(codex r6)
        let (id, pid) = {
            let mut s = handle_for_spawn_error.snap();
            // 快照也要回到暂停:否则任务一直显示「运行中」,而根本没有线程在跑
            s.state = "paused";
            s.speed_bytes_per_sec = 0;
            for d in s.destinations.iter_mut() {
                d.state = "idle";
            }
            (s.id.clone(), s.project_id.clone())
        };
        if let Some(lease) = handle_for_spawn_error.lease_slot().take() {
            let lease_file = lease.path().to_path_buf();
            report_lease_release(
                &app_for_spawn_error,
                lease.release_reported(),
                &lease_file,
                "拷卡线程启动失败、回滚",
                false,
                Some((&id, &pid)),
            );
            super::sorting_cmds::notify_if_unsafe_fallback_for(
                &app_for_spawn_error,
                Some((&id, &pid)),
            );
        }
        handle_for_spawn_error
            .running
            .store(false, Ordering::SeqCst);
        super::notify::error_for_task(
            &app_for_spawn_error,
            "copy-worker-spawn-failed",
            (&id, &pid),
            format!("拷卡线程没能启动(系统资源不足:{e}),任务仍是暂停状态,可稍后点「继续」"),
        );
        let ev = {
            let mut snap = handle_for_spawn_error.snap();
            final_event(&mut snap, Vec::new())
        };
        let _ = app_for_spawn_error.emit(PROGRESS_EVENT, &ev);
    }
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
    handle: &Arc<TaskHandle>,
) -> crate::core::Result<()> {
    // 独占租约:同一个任务同时只允许一个进程写它的清单。
    // 清单落盘是整份覆盖,两处同时写时后写的会把先写的**整份顶掉**,而且
    // 自从临时名改成唯一的之后,这件事连个错都不报了(见 core::lease 模块头)。
    //
    // 顺序:**先租约,再读清单**。反过来会读到旧持有者释放前的快照,然后拿着
    // 陈旧的 entries 把人家最后写的进度整份顶掉。
    let operator = handle.snap().operator.clone();
    let taken = handle.lease_slot().take();
    let (id, pid) = {
        let s = handle.snap();
        (s.id.clone(), s.project_id.clone())
    };
    let lease = match taken {
        Some(h) => h, // 续传路径已在准备阶段取得(刷新计划那次写也在保护内)
        None => crate::core::lease::acquire(
            &handle.project_root,
            &handle.manifest_id,
            &handle.machine_id,
            &operator,
        )
        .inspect_err(|e| {
            // 锁目录异常(链接 / 异物)不会自己好:除了「已中断、可续传」那条,还要一条
            // 抬头就说「需人工清理」的,否则用户只会一遍遍点「继续」
            if e.to_string()
                .contains(crate::core::lease::LOCK_DIR_BROKEN_PREFIX)
            {
                super::notify::error_for_task(
                    app,
                    "copy-resume-lease-lock-broken",
                    (&id, &pid),
                    e.to_string(),
                );
            }
        })?,
    };
    // 读清单失败等早退也要有释放判定(守卫的 Drop 会说)
    let mut keeper = LeaseKeeper::new(
        app.clone(),
        lease,
        "任务异常中断",
        (id.clone(), pid.clone()),
        handle.clone(),
    );
    if let Some(note) = keeper.lease_mut().took_over_stale.take() {
        // 接管别人/自己残留的租约是「系统替用户做了决定」,零静默要求说出来;
        // 带任务:并行拷卡时同 code 的通知会按任务分桶,不会互相顶掉正文
        super::notify::warn_for_task(app, "task-lease-taken-over", (&id, &pid), note);
    }
    let mut m = manifest::load(&handle.project_root, &handle.manifest_id)?;

    // 守卫一直跟到 worker 结束:panic 展开、precheck 拒绝这类路径的释放判定由 Drop
    // 说出来(此前只覆盖起跑阶段,worker 里的 panic 走裸 Held::drop,「没删掉 / 被接管」
    // 只进日志)。正常结束走下面的显式 release,口径与「是否真的暂停」按结果定
    let outcome = run_worker_locked(app, handle, &mut m, keeper.lease());
    let lease = keeper.into_lease();
    if let Err(e) = &outcome {
        // 运行中(落盘时)才发现锁目录异常:除了「已中断、可续传」那条,还要一条抬头就说
        // 「需人工清理」的,否则用户会白点一次「继续」才拿到这句话
        if e.to_string()
            .contains(crate::core::lease::LOCK_DIR_BROKEN_PREFIX)
        {
            super::notify::error_for_task(
                app,
                "copy-resume-lease-lock-broken",
                (&id, &pid),
                e.to_string(),
            );
        }
    }
    let lease_file = lease.path().to_path_buf();
    // 「已暂停」只在结果确实是可续传的中断时才成立;跑完 / 真失败之后才在释放时发现被接管,
    // 抬头不能说「已暂停」
    // 按快照事实而不是按结果推:用户主动暂停时结果是 Ok,但任务确实处在可续传的暂停里
    let task_paused = handle.snap().state == "paused";
    report_lease_release(
        app,
        lease.release_reported(),
        &lease_file,
        "任务结束",
        task_paused,
        Some((&id, &pid)),
    );
    outcome
}

/// 「拿到租约之后、交给 worker 之前」这段路上的任何早退(`?`)都会让 `Held` 只走
/// Drop——释放了,但判定没人接:留下的自锁租约、被接管都成了无声。这个守卫在 Drop
/// 里把判定说出来;交给 worker 时用 `into_lease` 取走,守卫就不再管。
pub(crate) struct LeaseKeeper<R: tauri::Runtime> {
    lease: Option<crate::core::lease::Held>,
    app: AppHandle<R>,
    what: &'static str,
    task: (String, String),
    /// 报判定时查快照:任务此刻是不是真的处在可续传的暂停里(抬头据此选)
    handle: Arc<TaskHandle>,
}

impl<R: tauri::Runtime> LeaseKeeper<R> {
    pub(crate) fn new(
        app: AppHandle<R>,
        lease: crate::core::lease::Held,
        what: &'static str,
        task: (String, String),
        handle: Arc<TaskHandle>,
    ) -> Self {
        // 迟到的心跳降级的直达出口:释放只等心跳 5 秒,之后才退出的心跳线程直接经这里报,
        // 不依赖「之后还有别的收尾钩子」
        {
            let (app2, tid, pid) = (app.clone(), task.0.clone(), task.1.clone());
            lease.set_late_reporter(move |id, d| {
                let pid = if id == tid { pid.as_str() } else { "" };
                report_late_heartbeat(&app2, id, pid, d);
            });
        }
        Self {
            lease: Some(lease),
            app,
            what,
            task,
            handle,
        }
    }
    pub(crate) fn lease(&self) -> &crate::core::lease::Held {
        self.lease.as_ref().expect("租约已被取走")
    }
    pub(crate) fn lease_mut(&mut self) -> &mut crate::core::lease::Held {
        self.lease.as_mut().expect("租约已被取走")
    }
    pub(crate) fn into_lease(mut self) -> crate::core::lease::Held {
        self.lease.take().expect("租约已被取走")
    }
}

impl<R: tauri::Runtime> Drop for LeaseKeeper<R> {
    fn drop(&mut self) {
        if let Some(lease) = self.lease.take() {
            let path = lease.path().to_path_buf();
            let task_paused = self.handle.snap().state == "paused";
            report_lease_release(
                &self.app,
                lease.release_reported(),
                &path,
                self.what,
                task_paused,
                Some((&self.task.0, &self.task.1)),
            );
            // RAII 收尾器:早退路径(`?`)上这条线程攒下的线程局部降级(取得时的回退、
            // 不可信标记写入的重试、释放时接管锁回收探针的残留)在这里带 scope 取走,
            // 不留给下一条落到同一线程的命令
            super::sorting_cmds::notify_if_unsafe_fallback_for(
                &self.app,
                Some((&self.task.0, &self.task.1)),
            );
        }
    }
}

/// 「迟到的心跳线程」(释放之后才退出)攒下的降级的可见出口:三种降级 + 卡死那一句。
pub(crate) fn report_late_heartbeat<R: tauri::Runtime>(
    app: &AppHandle<R>,
    task_id: &str,
    project_id: &str,
    d: crate::core::lease::HeartbeatDegradations,
) {
    // scope 先绑成变量:通知 code 门禁只认调用点里第一个 `),` 之前的字面量
    let scope = Some((task_id, project_id));
    let who = format!("迟到的租约心跳线程(清单 {task_id})");
    report_heartbeat_degradations(app, scope, &who, &d);
    if d.heartbeat_stuck {
        super::notify::warn_scoped(
            app,
            scope,
            "task-lease-heartbeat-stuck",
            "租约心跳线程在释放之后才从 NAS 读写里醒来并退出;它攒下的降级已在上面补报".into(),
        );
    }
}

/// 心跳线程(或迟到的心跳线程)攒下的降级的可见出口:三种各一条,带任务 scope。
/// `who` 是口径前缀(「租约心跳线程」/「迟到的租约心跳线程」)。
pub(crate) fn report_heartbeat_degradations<R: tauri::Runtime>(
    app: &AppHandle<R>,
    task: Option<(&str, &str)>,
    who: &str,
    degraded: &crate::core::lease::HeartbeatDegradations,
) {
    if degraded.fallback_used {
        super::notify::warn_scoped(
            app,
            task,
            "fsx-fallback-window",
            format!(
                "{who}重建租约文件时:{}",
                super::sorting_cmds::FALLBACK_WINDOW_BODY
            ),
        );
    }
    if !degraded.leftovers.is_empty() {
        // 与拷卡 worker 的 fsx-leftover-temp 不同 code:同 code 30 秒内合并会让清单目录那条
        // 的例子路径被拷卡目录那条顶掉(Fable)
        super::notify::warn_scoped(
            app,
            task,
            "lease-heartbeat-leftover-temp",
            format!(
                "{who}有 {} 个临时文件没删掉(例如 {});清单目录里的由启动清理收,其它请按路径手动删除",
                degraded.leftovers.len(),
                degraded.leftovers[0].display()
            ),
        );
    }
    if degraded.retried_writes > 0 {
        super::notify::info_scoped(
            app,
            task,
            "fsx-write-retried",
            format!(
                "{who}写入被占用(多半是杀毒软件 / 索引器),系统重试了 {} 轮后成功;内容无误",
                degraded.retried_writes
            ),
        );
    }
}

/// 释放判定的可见出口。`Held` 的 Drop 也会释放,但没人接结果——「没删掉 / 被接管
/// / 心跳线程没退出」就成了无声。所有持有租约的路径都走这里:worker 收尾、代理状态
/// 保存、线程起不来时的回收直接调;续传准备与 worker 准备阶段的早退经 [`LeaseKeeper`]
/// 的 Drop 转到这里。
pub(crate) fn report_lease_release<R: tauri::Runtime>(
    app: &AppHandle<R>,
    released: (
        crate::core::lease::Released,
        crate::core::lease::HeartbeatDegradations,
    ),
    lease_file: &Path,
    // 报文的口径:「任务结束」/「自动转代理状态写回」/「拷卡线程启动失败、回滚」——
    // 三处复用同一段判定,但只有 worker 那一路真的有任务被暂停
    what: &str,
    task_paused: bool,
    // 任务身份:同 code 的通知 30 秒内会合并、后一条正文覆盖前一条——两张卡同时
    // 残留租约时没有 scope 就只剩一条。代理写回那一路没有 project id,给空串即可
    task: Option<(&str, &str)>,
) {
    let (released, degraded) = released;
    report_heartbeat_degradations(app, task, "租约心跳线程", &degraded);
    // 心跳线程 5 秒没退出:只有两个释放变体自带这件事,其余变体在这里补一句
    if degraded.heartbeat_stuck
        && !matches!(
            released,
            crate::core::lease::Released::RemovedHeartbeatStuck
                | crate::core::lease::Released::NoLockHeartbeatStuck(_)
        )
    {
        super::notify::warn_scoped(
            app,
            task,
            "task-lease-heartbeat-stuck",
            format!(
                "{what}:租约心跳线程 5 秒内没有退出(可能卡在 NAS 读写上),释放没有再等它。它醒来后会先查停止标记再动手,不会复活租约;它在那之后攒下的降级会直接补报出来"
            ),
        );
    }
    match released {
        crate::core::lease::Released::Removed => {}
        // 被接管:轮询阶段多半已经报过 task-lease-lost(同 code 同任务 30 秒内会合并,不会
        // 刷屏);但准备阶段就被接管、一次都没轮询过就早退的那条路此前是无声的
        crate::core::lease::Released::TakenOver => {
            super::notify::warn_scoped(
                app,
                task,
                if task_paused {
                    "task-lease-lost"
                } else {
                    "task-lease-lost-outside-run"
                },
                format!(
                    "{what}时确认本任务的租约已由别的进程持有;请核对另一处的进度,再决定在哪边续传"
                ),
            );
        }
        crate::core::lease::Released::RemoveFailed(why) => {
            // 留下的是**我们自己的**租约:别的机器要等 TTL;本机在本次运行期间也续不了
            // (pid 还活着,不算残留;重启 OCard 后 pid 不在了就能立刻接管)。得说清楚,
            // 否则用户点「继续」会撞上「本进程内的另一次续传」然后一头雾水
            super::notify::warn_scoped(
                app,
                task,
                "task-lease-left-behind",
                format!(
                    "{what}后没能删掉自己的租约文件({why}):{}。别的机器在 {} 分钟内、本机在本次运行期间续这个任务都会被它挡住;重启 OCard 或手动删除该文件可立刻解锁",
                    lease_file.display(),
                    crate::core::lease::LEASE_TTL.num_minutes()
                ),
            );
        }
        crate::core::lease::Released::RemovedHeartbeatStuck => {
            // 删成了;只是心跳线程还卡在存储上。如实说,别混进「没敢删」那一桶
            super::notify::warn_scoped(
                app,
                task,
                "task-lease-heartbeat-stuck",
                "任务租约已正常删除,但本机的心跳线程 5 秒内没有退出(多半卡在存储的一次读写上)。它醒来后不会再写租约,只是本次收尾慢了些;若经常出现,说明这台机器到 NAS 的连接不稳".into(),
            );
        }
        crate::core::lease::Released::NoLockHeartbeatStuck(why) => {
            // 不混进「没敢删」那一桶:那一桶会拼出「可能已被别的进程接管——删除前先确认」,
            // 与「是本机线程持着」自相矛盾。如实说两种可能,不承诺「不必处理」;
            // 后果里最贵的那半句不能漏:留下的租约 pid 是活着的本进程,本机本次运行期间
            // 也续不了,得重启 OCard
            super::notify::warn_scoped(
                app,
                task,
                "task-lease-left-behind-heartbeat-stuck",
                format!(
                    "{what}时{why}。它醒来时若正卡在写租约的那一拍上,会自己删掉租约;若卡在别处,这份租约会留到 {} 分钟后过期:{}。期间别的机器、以及本机在本次运行期间续这个任务都会被它挡住;重启 OCard 可立刻解锁,或确认本机 OCard 已退出后手动删除该文件",
                    crate::core::lease::LEASE_TTL.num_minutes(),
                    lease_file.display()
                ),
            );
        }
        crate::core::lease::Released::TakenOverUnnoticed => {
            // 释放时才第一次发现盘上是别人的:心跳线程没来得及报 Lost。要说,
            // 用户得知道从某一刻起这份进度可能有另一处在写
            super::notify::warn_scoped(
                app,
                task,
                // 只有 worker 那一路真的「已暂停」;别的调用方用另一个 code,标题才不撒谎
                if task_paused {
                    "task-lease-lost"
                } else {
                    "task-lease-lost-outside-run"
                },
                format!("{what}时发现租约已被别的进程接管(本机心跳没有及时发现)。请核对另一处的进度,再决定在哪边续传"),
            );
        }
        crate::core::lease::Released::NoLock(why)
            if why.contains(crate::core::lease::LOCK_DIR_BROKEN_PREFIX) =>
        {
            // 锁目录异常不会自己好:抬头要说「需人工清理」,而且是 error 级(不自动收起);
            // 后果那半句不能丢:租约留下了,别的机器要等 TTL、本机本次运行期间续不了,
            // 而锁目录不清理的话谁的接管都会被挡
            super::notify::error_scoped(
                app,
                task,
                "copy-resume-lease-lock-broken",
                format!(
                    "{what}时{why};租约文件没有删除:{}。别的机器在 {} 分钟内、本机在本次运行期间续这个任务都会被它挡住;而且锁目录不清理的话,谁来接管都会被挡——请先人工清理锁目录,再重启 OCard(或确认没有别的 OCard 在跑后删除该租约文件)",
                    lease_file.display(),
                    crate::core::lease::LEASE_TTL.num_minutes()
                ),
            );
        }
        crate::core::lease::Released::Unverified(why)
        | crate::core::lease::Released::NoLock(why) => {
            // 没拿到接管锁就没敢删——盘上那份**可能已经是接管方的**。这里绝不能
            // 建议「手动删除」:照做就是删掉一个正在拷卡的进程的租约
            super::notify::warn_scoped(
                app,
                task,
                "task-lease-left-behind",
                format!(
                    "{what}时没能确认租约文件的归属({why}),没有删除:{}。它可能仍是本进程的(别的机器要等 {} 分钟、本机重启 OCard 后可续),也可能已被别的进程接管——删除前请先确认没有别的 OCard 在跑这个任务",
                    lease_file.display(),
                    crate::core::lease::LEASE_TTL.num_minutes()
                ),
            );
        }
    }
}

fn run_worker_locked<R: tauri::Runtime>(
    app: &AppHandle<R>,
    handle: &TaskHandle,
    m: &mut manifest::CopyManifest,
    lease: &crate::core::lease::Held,
) -> crate::core::Result<()> {
    let task_prefix: String = handle.manifest_id.chars().take(8).collect();
    let run_tag = lease.run_tag();
    let req = copy::CopyRequest {
        source_root: handle.source_root_guard().clone(),
        destinations: handle.dest_targets.clone(),
        // 带本次持有的 run 标签:休眠后恢复的旧持有者永远碰不到本轮的 part(见
        // core::lease 模块头);上一轮的残留由下面的清扫按清单 id 前缀认领
        task_tag: format!("{task_prefix}-{run_tag}"),
        // 口径取自 manifest(持久化的开拷选择):重启重建的任务也用同一把尺子
        selection: copy::SourceSelection::from_folders(m.source_selection.clone()),
    };

    // 单一清单:引擎、manifest、UI 快照消费同一份文件列表(评审 M11/P1-11)。
    // 从 manifest+目标实存恢复初始进度(续传场景)。
    let plan: Vec<copy::PlannedFile> = handle.plan_guard().clone();
    if plan.is_empty() {
        // 零静默:清单为空说明接线出了问题,绝不能「跑完 0 个文件」再报成功
        return Err(crate::core::CoreError::Invalid(
            "任务清单为空,拒绝执行(请重新发起拷卡)".into(),
        ));
    }
    {
        let mut snap = handle.snap();
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
    // 租约原因的停止是**粘的**:一旦判了 Abort,后面每一次回调都答 Abort——poll()
    // 若在一拍成功后翻回 Ok,收尾路径不该又变成「继续」。它与用户的暂停请求分开记:
    // 此前借用 pause_requested,用户此刻点「继续」会被告知「已撤销暂停请求,接着跑」,
    // 而那次运行正在中止,根本不会接着跑
    let mut lease_aborted = false;
    // 心跳侧发现的原因(锁目录异常……)要带回收尾:那一支在落盘之前就 break,
    // abort_reason 为空,收尾若一律退回 lease_abort() 的通用报文,「需人工清理」就丢了
    let mut lease_abort_why: Option<String> = None;
    // 当前文件已进快照的字节(块级 delta 累加);中途中止时要从快照里减回去
    let mut current_file_delta = 0u64;
    let task_for_notices = {
        let s = handle.snap();
        (s.id.clone(), s.project_id.clone())
    };

    // 写栅栏:每次落盘都在租约锁下核对 token(见 lease::Held::fence)
    let fence = || -> crate::core::Result<Box<dyn copy::SaveFenceGuard>> {
        lease
            .fence()
            .map(|f| Box::new(f) as Box<dyn copy::SaveFenceGuard>)
    };
    // 持有租约的一方清掉上一轮(别的 run 标签,含旧格式)留下的 .ocardpart。系统替用户
    // 删了东西,要说;没删成的也要说——它们不会与本轮撞名,只是占着空间
    // 清扫在**栅栏内**:它专门删「别的 run」的 part,若本进程在拿到租约之后休眠、被接管,
    // 醒来直接清扫就会删掉接管者正在写的 part(codex r9)。栅栏持锁核对 token,不是自己
    // 的就不清、直接按中止处理
    let sweep_fence = match lease.fence() {
        Ok(f) => f,
        Err(e) => {
            return Err(crate::core::CoreError::Busy(format!(
                "开拷前核对租约失败,没有清扫残留也没有开始拷贝:{e}"
            )))
        }
    };
    let swept =
        copy::sweep_stale_parts(&handle.dest_targets, &plan, &task_prefix, &run_tag, &|| {
            sweep_fence.still_mine()
        });
    drop(sweep_fence);
    if !swept.removed.is_empty() {
        super::notify::info_for_task(
            app,
            "copy-stale-parts-swept",
            (&task_for_notices.0, &task_for_notices.1),
            format!(
                "清理了上次运行留下的 {} 个残留,例如 {}。没写完的半个文件(.ocardpart)本次会重新拷;超过 30 分钟的发布锁 / 时钟与硬链接探针残留(.ocardtmp)是上次崩溃留下的",
                swept.removed.len(),
                swept.removed[0].display()
            ),
        );
    }
    if !swept.failed.is_empty() {
        super::notify::warn_for_task(
            app,
            "copy-stale-parts-sweep-failed",
            (&task_for_notices.0, &task_for_notices.1),
            format!(
                "上次运行留下的 {} 个残留(.ocardpart 半个文件 / .ocardtmp 锁与探针)没能清掉,例如 {}({})。半个文件不影响本次拷贝但会一直占着空间;残留的发布锁会挡住同名文件的落位。可手动删除",
                swept.failed.len(),
                swept.failed[0].0.display(),
                swept.failed[0].1
            ),
        );
    }
    let outcome = copy::run_copy(&req, &plan, m, &handle.project_root, Some(&fence), |p| {
        let mut changed: Vec<CopyFileItemDto> = Vec::new();
        let mut force_emit = false;
        {
            let mut snap = handle.snap();
            match &p {
                copy::Progress::FileStarted { .. } => current_file_delta = 0,
                copy::Progress::Scanned { .. }
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
                    current_file_delta += delta;
                }
                copy::Progress::FileFinished { rel_path, status } => {
                    force_emit = true;
                    if matches!(status, copy::FileStatus::Failed(_)) {
                        // 失败的文件 part 已被引擎清掉:它的字节不能留在快照里,否则
                        // 回读校验 / 落位阶段失败的大文件会让进度虚高、进度条能过 100%
                        snap.copied_bytes = snap.copied_bytes.saturating_sub(current_file_delta);
                    }
                    if !matches!(status, copy::FileStatus::AbortedMidFile) {
                        current_file_delta = 0; // 正常结束的文件,字节留在快照里
                    }
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
            let what = match kind {
                copy::ContentionKind::Manifest => "写入拷卡清单",
                copy::ContentionKind::Material => "素材文件落位改名",
            };
            let msg = format!(
                "{what}时被别的程序占着,重试 {retries} 轮后成功:{path}。多半是杀毒软件或 NAS 索引正在扫这个文件所在的目录;若反复出现,把该目录加入杀毒软件排除项,否则下次可能直接中断任务"
            );
            // code 直接写字面量,不经变量:通知 code 门禁(NoticeCodes.contract)只认
            // 调用点里的字面量
            let task = (task_for_notices.0.as_str(), task_for_notices.1.as_str());
            match kind {
                copy::ContentionKind::Manifest => {
                    super::notify::warn_for_task(app, "fs-write-contention", task, msg)
                }
                copy::ContentionKind::Material => {
                    super::notify::warn_for_task(app, "material-rename-contention", task, msg)
                }
            }
        }
        // 租约状态轮询(心跳由独立线程推进,这里只看结论)。两种情况都要**立刻**停,
        // 而且不再写清单(CopyControl::Abort):Lost = 别人已合法接管,再写就是把人家
        // 记下的进度整份顶掉;AtRisk = 心跳很久没成功,再拷下去很快就会变成 Lost
        if lease_aborted {
            return copy::CopyControl::Abort;
        }
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
                    // 锁目录异常的那条专用通知由收尾按前缀统一发(原因经 lease_abort_why
                    // 带回),这里不再发——否则 30 秒内两条逐字相同的 error 叠成 ×2
                    lease_abort_why = Some(why.clone());
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
            lease_aborted = true;
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
        let mut snap = handle.snap();
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
        if snap.state == "done" {
            // 标记在收尾落盘**之前**已由引擎清掉(见 run_copy);这里只查不删——此刻还在的
            // 标记要么是删不掉,要么是收尾落盘之后又有迟到的写入留下的,两种都要说、都不能删
            match manifest::suspect(&handle.project_root, &handle.manifest_id) {
                Ok(None) => {}
                Ok(Some(why)) => super::notify::warn_for_task(
                    app,
                    "manifest-suspect-not-cleared",
                    (&task_for_notices.0, &task_for_notices.1),
                    format!("任务已完成,但清单旁仍有「不可信」标记(完成落盘之后可能又有迟到的写入,或标记删不掉):{}。下次启动它会被当作未完成展示、续传按哈希重新确认。先确认没有别的 OCard 在跑这个任务;确认后若标记仍在(多半是删不掉:权限 / 别的账号写的),可手动删除该标记文件", why.trim()),
                ),
                Err(e) => super::notify::warn_for_task(
                    app,
                    "manifest-suspect-not-cleared",
                    (&task_for_notices.0, &task_for_notices.1),
                    format!("任务已完成,但清单旁的「不可信」标记读不出({e});下次启动会按不可信处理(未完成展示)"),
                ),
            }
        }
        let dest_state = match snap.state {
            "done" => "done",
            "paused" => "idle",
            _ => "error",
        };
        // 主动中止时,快照的 copied_bytes 吃进了当前文件的部分 delta,而那个 part
        // 已被清掉——只把**这一个文件**的 delta 减回去。不能用引擎的 bytes_copied
        // 回填:那只算本次落位的,续传场景下会把 410GB 打回 10GB
        if outcome.aborted {
            snap.copied_bytes = snap.copied_bytes.saturating_sub(current_file_delta);
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
    // 连续 IO 失败的自动暂停:任务变成「已暂停」不算说了——原因要进通知中心(codex 终审 r18)
    if let Some(why) = &outcome.pause_reason {
        super::notify::error_for_task(
            app,
            "copy-task-paused",
            (&task_for_notices.0, &task_for_notices.1),
            format!("拷卡任务已自动暂停(可续传):{why}"),
        );
    }
    if outcome.baseline_degraded > 0 {
        super::notify::warn_for_task(
            app,
            "copy-baseline-degraded",
            (&task_for_notices.0, &task_for_notices.1),
            format!(
                "{} 个文件的清单没有记录规划时的修改时间(旧版本清单,或扫描时读不到):它们「拷贝期间源没被改写」只按开拷快照的大小与修改时间判,同一时间戳槽内的等长改写挡不住。要完整保障请重新发起拷贝(新清单会记录基准)",
                outcome.baseline_degraded
            ),
        );
    }
    if !outcome.paused && outcome.all_verified && !m.source_selection.is_empty() {
        // 带任务 scope:两张部分拷卡在 30 秒内完成时,无 scope 的同 code 会让后一张顶掉前一张
        // 「其余内容没有备份、请勿格式化」的正文——这条直接关联素材丢失(codex 终审)
        super::notify::warn_for_task(
            app,
            "copy-partial-scope-done",
            (&task_for_notices.0, &task_for_notices.1),
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
        // 审计与总账已经写完,现在才把原因抛上去让任务落到暂停。引擎给了具体原因
        // (栅栏拒绝 / 没拿到锁 / 栅栏被回收)就用它:没拿到锁 ≠ 被接管,不能一律说成后者
        return Err(match outcome.abort_reason.clone() {
            Some(why) => crate::core::CoreError::Busy(why),
            // 心跳侧带前缀的原因(锁目录异常)原样上抛:上层据前缀换抬头、改「点继续」的提示
            None => match lease_abort_why.take() {
                Some(why) if why.contains(crate::core::lease::LOCK_DIR_BROKEN_PREFIX) => {
                    crate::core::CoreError::Busy(why)
                }
                _ => copy::lease_abort(),
            },
        });
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
