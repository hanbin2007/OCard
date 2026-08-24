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
    pub source_root: PathBuf,
    pub dest_targets: Vec<PathBuf>,
    pub machine_id: String,
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
    if handle.running.swap(true, Ordering::SeqCst) {
        return; // 已有工作线程在跑
    }
    handle.pause_requested.store(false, Ordering::SeqCst);
    std::thread::spawn(move || {
        let outcome = run_worker(&app, &handle);
        handle.running.store(false, Ordering::SeqCst);
        if let Err(e) = outcome {
            let mut snap = handle.snapshot.lock().unwrap();
            snap.state = "failed";
            snap.finished_at = Some(Utc::now().to_rfc3339());
            let ev = final_event(&mut snap, Vec::new());
            drop(snap);
            let _ = app.emit(PROGRESS_EVENT, &ev);
            eprintln!("拷卡任务失败: {e}");
        }
    });
}

fn run_worker(app: &AppHandle, handle: &TaskHandle) -> crate::core::Result<()> {
    let mut m = manifest::load(&handle.project_root, &handle.manifest_id)?;

    // 从 manifest 恢复初始进度(续传场景)
    {
        let mut snap = handle.snapshot.lock().unwrap();
        snap.state = "running";
        snap.finished_at = None;
        let mut done_bytes = 0u64;
        for f in snap.files.iter_mut() {
            if m.is_done(&f.id, f.size_bytes) {
                f.status = "verified";
                done_bytes += f.size_bytes;
            }
        }
        snap.copied_bytes = done_bytes;
    }

    let req = copy::CopyRequest {
        source_root: handle.source_root.clone(),
        destinations: handle.dest_targets.clone(),
    };

    let mut last_emit = Instant::now();
    let mut window_bytes = 0u64;
    let mut window_start = Instant::now();

    let outcome = copy::run_copy(&req, &mut m, &handle.project_root, |p| {
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
        let ev = final_event(&mut snap, Vec::new());
        drop(snap);
        let _ = app.emit(PROGRESS_EVENT, &ev);
    }

    for f in &outcome.files {
        if let copy::FileStatus::Failed(e) = &f.status {
            let _ = journal::append(
                &handle.project_root,
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
        let _ = journal::append(
            &handle.project_root,
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
) -> (CopyTaskDto, Vec<PathBuf>) {
    let prefix = naming::sanitize_component(&input.target_prefix);
    let target_folder = format!("{prefix}_{camera_code}");
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
    (dto, dest_targets)
}
