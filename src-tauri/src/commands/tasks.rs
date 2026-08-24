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
    pub dest_targets: Vec<PathBuf>,
    pub machine_id: String,
    /// 应用配置目录(审计 outbox 兜底用)。
    pub config_dir: PathBuf,
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
        self.inner.lock().unwrap().insert(task_id, handle);
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
    t.files = Vec::new();
    t
}

pub fn file_status_str(status: &copy::FileStatus) -> &'static str {
    match status {
        copy::FileStatus::Copied | copy::FileStatus::SkippedResume => "verified",
        copy::FileStatus::Failed(_) => "failed",
    }
}

/// 启动(或续跑)一个任务的后台工作线程。
pub fn spawn_worker(app: AppHandle, handle: Arc<TaskHandle>) {
    // 先清暂停标志再判 running:若旧 worker 还在跑且刚收到暂停请求,
    // 用户此刻点「继续」应让旧 worker 撤销暂停继续跑(评审 L19/P1-9)。
    handle.pause_requested.store(false, Ordering::SeqCst);
    if handle.running.swap(true, Ordering::SeqCst) {
        return; // 已有工作线程在跑(暂停请求已被上面撤销)
    }
    std::thread::spawn(move || {
        let outcome = run_worker(&app, &handle);
        if let Err(e) = &outcome {
            let mut snap = handle.snapshot.lock().unwrap();
            // IO 类错误(NAS 抖动/断连)是可恢复的暂停,不是死路(评审 H4)
            if matches!(e, crate::core::CoreError::Io(_)) {
                snap.state = "paused";
            } else {
                snap.state = "failed";
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
            drop(snap);
            eprintln!("拷卡任务中断: {e}");
        }
        // 终态事件在 running=false 之后发(复核 P1-9):此刻点「继续」已能启动新 worker;
        // 事件读的是实时快照,若新 worker 已接手则发出的就是其当前状态,不会回退 UI
        handle.running.store(false, Ordering::SeqCst);
        let mut snap = handle.snapshot.lock().unwrap();
        let ev = final_event(&mut snap, Vec::new());
        drop(snap);
        let _ = app.emit(PROGRESS_EVENT, &ev);
    });
}

/// 续传源卷解析(纯函数,可测):记录的挂载点上卷名相符则沿用;
/// 否则按 manifest 卷名在当前挂载卷中重解析(卡后插/换挂载点,复核必修 A);
/// 都找不到给出准确报错。
pub fn resolve_resume_source(
    recorded_mount: &std::path::Path,
    expected_label: &str,
    volumes: &[(PathBuf, String)],
) -> std::result::Result<PathBuf, String> {
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

/// 续传准备(纯函数,可测):按卷名重解析源挂载点后,**必须**与固定目的地
/// 重新做布局校验(codex 终验 P0:重插的卡可能挂到目的地祖先,写回源卡)。
pub fn prepare_resume(
    recorded_mount: &std::path::Path,
    expected_label: &str,
    volumes: &[(PathBuf, String)],
    dest_targets: &[PathBuf],
) -> std::result::Result<PathBuf, String> {
    let resolved = resolve_resume_source(recorded_mount, expected_label, volumes)?;
    crate::core::paths::validate_dest_layout(&resolved, dest_targets)?;
    Ok(resolved)
}

/// journal 追加带重试;彻底失败时写本机 outbox 兜底,绝不静默丢审计(评审 P1-7)。
pub fn append_audit(
    project_root: &std::path::Path,
    outbox_dir: &std::path::Path,
    ev: &journal::Event,
) {
    for _ in 0..3 {
        if journal::append(project_root, ev).is_ok() {
            return;
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
        eprintln!("审计事件未能写入项目 journal,已落本机 outbox: {}", ev.kind);
    } else {
        eprintln!(
            "警告:审计事件写项目 journal 与本机 outbox 均失败: {}",
            ev.kind
        );
    }
}

fn run_worker(app: &AppHandle, handle: &TaskHandle) -> crate::core::Result<()> {
    let mut m = manifest::load(&handle.project_root, &handle.manifest_id)?;

    let req = copy::CopyRequest {
        source_root: handle.source_root.lock().unwrap().clone(),
        destinations: handle.dest_targets.clone(),
        task_tag: handle.manifest_id.chars().take(8).collect(),
    };

    // 单一清单:引擎、manifest、UI 快照消费同一份文件列表(评审 M11/P1-11)。
    // 从 manifest+目标实存恢复初始进度(续传场景)。
    let files: Vec<(String, u64)>;
    {
        let mut snap = handle.snapshot.lock().unwrap();
        snap.state = "running";
        snap.finished_at = None;
        let mut done_bytes = 0u64;
        for f in snap.files.iter_mut() {
            if copy::file_done(&m, &f.id, f.size_bytes, &req.destinations) {
                f.status = "verified";
                done_bytes += f.size_bytes;
            } else if f.status == "verified" {
                f.status = "pending"; // manifest 说验证过但目标不在了 → 重拷
            }
        }
        snap.copied_bytes = done_bytes;
        files = snap
            .files
            .iter()
            .map(|f| (f.id.clone(), f.size_bytes))
            .collect();
    }

    let mut last_emit = Instant::now();
    let mut window_bytes = 0u64;
    let mut window_start = Instant::now();

    let outcome = copy::run_copy(&req, &files, &mut m, &handle.project_root, |p| {
        let mut changed: Vec<CopyFileItemDto> = Vec::new();
        let mut force_emit = false;
        {
            let mut snap = handle.snapshot.lock().unwrap();
            match &p {
                copy::Progress::Scanned { .. } | copy::Progress::FileStarted { .. } => {}
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
        if handle.pause_requested.load(Ordering::SeqCst) {
            copy::CopyControl::Pause
        } else {
            copy::CopyControl::Continue
        }
    })?;

    // 收尾:状态、审计、终态事件
    let task_id;
    let operator;
    {
        let mut snap = handle.snapshot.lock().unwrap();
        operator = snap.operator.clone();
        task_id = snap.id.clone();
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
        let written = snap.copied_bytes;
        for d in snap.destinations.iter_mut() {
            d.state = dest_state;
            d.written_bytes = written;
        }
        // 终态事件由 spawn_worker 在 running=false 之后统一发出(复核 P1-9)
    }

    for f in &outcome.files {
        if let copy::FileStatus::Failed(e) = &f.status {
            append_audit(
                &handle.project_root,
                &handle.config_dir,
                &journal::Event::new(
                    handle.machine_id.clone(),
                    operator.clone(),
                    journal::kind::COPY_FILE_FAILED,
                    serde_json::json!({"taskId": task_id, "file": f.rel_path, "error": e}),
                ),
            );
        }
    }
    if !outcome.paused {
        append_audit(
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
                }),
            ),
        );
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
    }
}

fn final_event(snap: &mut CopyTaskDto, changed: Vec<CopyFileItemDto>) -> CopyProgressEventDto {
    let mut ev = progress_event(snap, changed);
    ev.changed_destinations = snap.destinations.clone();
    ev
}

/// 由 StartCopyInput 组装任务快照与落盘目标。
/// 目标夹命名走规范函数(评审 M14/P1-13):工况 A 强制 YYYYMMDD 前缀。
#[allow(clippy::too_many_arguments)]
pub fn build_task(
    input: &StartCopyInput,
    project_root: &std::path::Path,
    scenario: project::Scenario,
    volume_name: &str,
    camera_code: &str,
    operator: &str,
    files: &[(String, u64)],
    manifest_id: &str,
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

    let total_bytes = files.iter().map(|(_, s)| *s).sum();
    let file_dtos = files
        .iter()
        .map(|(rel, size)| CopyFileItemDto {
            id: rel.clone(),
            path: rel.clone(),
            name: rel.rsplit('/').next().unwrap_or(rel).to_string(),
            size_bytes: *size,
            status: "pending",
            hash: None,
            error: None,
            targets: None,
        })
        .collect();

    let dto = CopyTaskDto {
        id: manifest_id.to_string(),
        project_id: input.project_id.clone(),
        volume_id: input.volume_id.clone(),
        volume_name: volume_name.to_string(),
        camera_id: input.camera_id.clone(),
        camera_code: camera_code.to_string(),
        note: input.note.clone(),
        target_folder,
        destinations: dest_dtos,
        files: file_dtos,
        file_count: Some(files.len()),
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
            resolve_resume_source(&PathBuf::from("/Volumes/CARD"), "CARD", &v).unwrap(),
            PathBuf::from("/Volumes/CARD")
        );
    }

    #[test]
    fn card_replugged_at_new_mount_is_re_resolved() {
        // 卡后插被挂到了新位置(复核必修 A 的核心场景)
        let v = vols(&[("/Volumes/CARD 1", "CARD")]);
        assert_eq!(
            resolve_resume_source(&PathBuf::from("/Volumes/CARD"), "CARD", &v).unwrap(),
            PathBuf::from("/Volumes/CARD 1")
        );
    }

    #[test]
    fn different_card_at_recorded_mount_is_rejected() {
        // 同一挂载点换了另一张卡 → 拒绝(评审 M10)
        let v = vols(&[("/Volumes/CARD", "OTHER")]);
        let err = resolve_resume_source(&PathBuf::from("/Volumes/CARD"), "CARD", &v).unwrap_err();
        assert!(err.contains("源卷不匹配"), "{err}");
    }

    #[test]
    fn missing_card_reports_unmounted() {
        let v = vols(&[("/Volumes/ELSE", "ELSE")]);
        let err = resolve_resume_source(&PathBuf::from("/Volumes/CARD"), "CARD", &v).unwrap_err();
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
        let err = prepare_resume(&abs("/mnt/e"), "CARD", &vols, &dests).unwrap_err();
        assert!(err.contains("嵌套"), "{err}");
    }

    #[test]
    fn rebind_with_disjoint_layout_succeeds() {
        let vols: Vec<(PathBuf, String)> = vec![(abs("/mnt/g"), "CARD".to_string())];
        let dests = vec![abs("/nas/target"), abs("/backup/target")];
        assert_eq!(
            prepare_resume(&abs("/mnt/e"), "CARD", &vols, &dests).unwrap(),
            abs("/mnt/g")
        );
    }
}
