//! Tauri 命令层:实现 `src/api/index.ts` 里标注的全部 invoke 契约。
//! 错误统一映射为字符串消息(前端 toast 展示)。

pub mod dto;
pub mod tasks;

use crate::core::{catalog, config, copy, journal, manifest, project, registry, volumes};
use chrono::{Local, NaiveDate, TimeZone, Utc};
use dto::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tasks::{TaskHandle, TaskManager};
use tauri::{AppHandle, State};

pub struct AppState {
    pub config_dir: PathBuf,
    pub machine_id: String,
    pub tasks: TaskManager,
}

type CmdResult<T> = std::result::Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn nas_root(state: &AppState) -> CmdResult<PathBuf> {
    config::load(&state.config_dir)
        .nas_root
        .ok_or_else(|| "尚未配置 NAS 根路径,请先在设置中配置".to_string())
}

fn operator(state: &AppState) -> String {
    let op = config::load(&state.config_dir).operator;
    if op.is_empty() {
        "未登记DIT".to_string()
    } else {
        op
    }
}

fn parse_compact_date(s: &str) -> CmdResult<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y%m%d").map_err(|_| format!("日期格式应为 YYYYMMDD: {s}"))
}

fn project_dto(stats: &catalog::ProjectStats, running: bool) -> ProjectDto {
    ProjectDto {
        id: stats.folder_name.clone(),
        name: stats.meta.name.clone(),
        date: stats.meta.date.format("%Y%m%d").to_string(),
        folder_name: stats.folder_name.clone(),
        scenario: stats.meta.scenario,
        categories: stats.meta.categories.clone(),
        relative_path: stats.folder_name.clone(),
        status: if running || stats.has_incomplete_copy {
            "copying"
        } else if stats.cards_copied > 0 {
            "sorting"
        } else {
            "draft"
        },
        cards_copied: stats.cards_copied,
        // 口径:本项目已发起拷卡的任务数(评审 M15/P2-16;项目级卡登记未建模,不冒充全局数)
        cards_total: stats.manifest_count,
        bytes_copied: stats.bytes_copied,
        asset_count: stats.asset_count,
        sorted_count: 0,
        destination_count: stats.destination_max.max(1),
        updated_at: stats.updated_at.to_rfc3339(),
    }
}

fn find_project(nas: &Path, project_id: &str) -> CmdResult<catalog::ProjectStats> {
    catalog::scan(nas)
        .map_err(err)?
        .into_iter()
        .find(|p| p.folder_name == project_id)
        .ok_or_else(|| format!("项目不存在: {project_id}"))
}

// ---------- 工作站 ----------

#[tauri::command]
pub fn get_workstation_info(state: State<AppState>) -> WorkstationInfoDto {
    let cfg = config::load(&state.config_dir);
    WorkstationInfoDto {
        machine_id: state.machine_id.clone(),
        operator: cfg.operator,
        nas_root: cfg
            .nas_root
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
    }
}

#[tauri::command]
pub fn set_workstation_info(
    state: State<AppState>,
    operator: String,
    nas_root: String,
) -> CmdResult<WorkstationInfoDto> {
    let cfg = config::WorkstationConfig {
        operator,
        nas_root: if nas_root.trim().is_empty() {
            None
        } else {
            Some(PathBuf::from(nas_root.trim()))
        },
    };
    config::save(&state.config_dir, &cfg).map_err(err)?;
    Ok(get_workstation_info(state))
}

// ---------- 项目 ----------

#[tauri::command]
pub fn list_projects(state: State<AppState>) -> CmdResult<Vec<ProjectDto>> {
    let nas = nas_root(&state)?;
    let running: Vec<String> = state
        .tasks
        .snapshots(None)
        .into_iter()
        .filter(|t| t.state == "running")
        .map(|t| t.project_id)
        .collect();
    Ok(catalog::scan(&nas)
        .map_err(err)?
        .iter()
        .map(|s| project_dto(s, running.contains(&s.folder_name)))
        .collect())
}

#[tauri::command]
pub fn get_project(state: State<AppState>, project_id: String) -> CmdResult<Option<ProjectDto>> {
    Ok(list_projects(state)?
        .into_iter()
        .find(|p| p.id == project_id))
}

#[tauri::command]
pub fn create_project(state: State<AppState>, input: NewProjectInput) -> CmdResult<ProjectDto> {
    let nas = nas_root(&state)?;
    let date = parse_compact_date(&input.date)?;
    let root = project::create_project(&nas, date, &input.name, input.scenario, &input.categories)
        .map_err(err)?;
    let _ = journal::append(
        &root,
        &journal::Event::new(
            state.machine_id.clone(),
            operator(&state),
            journal::kind::PROJECT_CREATED,
            serde_json::json!({"name": input.name, "scenario": input.scenario}),
        ),
    );
    let stats = find_project(&nas, &root.file_name().unwrap().to_string_lossy())?;
    Ok(project_dto(&stats, false))
}

#[tauri::command]
pub fn preview_folder_tree(
    scenario: project::Scenario,
    categories: Vec<String>,
) -> Vec<FolderNode> {
    match scenario {
        project::Scenario::A => project::SCENARIO_A_DIRS
            .iter()
            .map(|d| FolderNode {
                name: d.to_string(),
                children: None,
            })
            .collect(),
        project::Scenario::B => project::scenario_b_dirs(&categories)
            .into_iter()
            .map(|d| {
                let children = if d.ends_with(project::CURATED_DIR_NAME) {
                    Some(vec![
                        FolderNode {
                            name: project::CURATED_TODO.into(),
                            children: None,
                        },
                        FolderNode {
                            name: project::CURATED_DONE.into(),
                            children: None,
                        },
                    ])
                } else {
                    None
                };
                FolderNode { name: d, children }
            })
            .collect(),
    }
}

// ---------- 登记表 ----------

#[tauri::command]
pub fn list_cameras(state: State<AppState>) -> CmdResult<Vec<registry::CameraReg>> {
    Ok(registry::load(&nas_root(&state)?).map_err(err)?.cameras)
}

#[tauri::command]
pub fn create_camera(
    state: State<AppState>,
    input: NewCameraInput,
) -> CmdResult<registry::CameraReg> {
    registry::register_camera(
        &nas_root(&state)?,
        &state.machine_id,
        &operator(&state),
        &input.model,
        &input.position,
        &input.operator_alias,
        input.note,
    )
    .map_err(err)
}

#[tauri::command]
pub fn delete_camera(state: State<AppState>, camera_id: String) -> CmdResult<()> {
    registry::delete_camera(
        &nas_root(&state)?,
        &state.machine_id,
        &operator(&state),
        &camera_id,
    )
    .map_err(err)
}

#[tauri::command]
pub fn list_storage_cards(state: State<AppState>) -> CmdResult<Vec<registry::StorageCard>> {
    Ok(registry::load(&nas_root(&state)?).map_err(err)?.cards)
}

#[tauri::command]
pub fn create_storage_card(
    state: State<AppState>,
    input: NewStorageCardInput,
) -> CmdResult<registry::StorageCard> {
    registry::register_card(
        &nas_root(&state)?,
        &state.machine_id,
        &operator(&state),
        &input.label,
        &input.camera_id,
        input.capacity_bytes,
        input.serial,
    )
    .map_err(err)
}

#[tauri::command]
pub fn delete_storage_card(state: State<AppState>, card_id: String) -> CmdResult<()> {
    registry::delete_card(
        &nas_root(&state)?,
        &state.machine_id,
        &operator(&state),
        &card_id,
    )
    .map_err(err)
}

// ---------- 卷 ----------

#[tauri::command]
pub fn list_volumes(state: State<AppState>) -> Vec<VolumeDto> {
    let cards = nas_root(&state)
        .ok()
        .and_then(|nas| registry::load(&nas).ok())
        .map(|r| r.cards)
        .unwrap_or_default();
    volumes::list_volumes()
        .into_iter()
        .map(|v| {
            let matched = cards
                .iter()
                .find(|c| c.label.eq_ignore_ascii_case(&v.name))
                .map(|c| c.id.clone());
            VolumeDto {
                id: v.mount_point.display().to_string(),
                name: v.name,
                mount_path: v.mount_point.display().to_string(),
                capacity_bytes: v.total_bytes,
                used_bytes: v.total_bytes.saturating_sub(v.available_bytes),
                removable: v.removable,
                matched_card_id: matched,
            }
        })
        .collect()
}

#[tauri::command]
pub fn inspect_volume(volume_id: String) -> CmdResult<VolumeInspectionDto> {
    let root = PathBuf::from(&volume_id);
    let files = copy::scan_source(&root).map_err(err)?;
    let total_bytes = files.iter().map(|(_, s)| *s).sum();

    let mut earliest: Option<chrono::DateTime<Utc>> = None;
    let mut latest: Option<chrono::DateTime<Utc>> = None;
    for (rel, _) in &files {
        let p: PathBuf = rel.split('/').fold(root.clone(), |acc, c| acc.join(c));
        if let Ok(meta) = std::fs::metadata(&p) {
            if let Ok(modified) = meta.modified() {
                let t: chrono::DateTime<Utc> = modified.into();
                earliest = Some(earliest.map_or(t, |e| e.min(t)));
                latest = Some(latest.map_or(t, |l| l.max(t)));
            }
        }
    }
    let suggested_prefix = earliest
        .map(|t| {
            let local = Local.from_utc_datetime(&t.naive_utc());
            let half = if local.format("%H").to_string().parse::<u32>().unwrap_or(0) < 12 {
                "上午"
            } else {
                "下午"
            };
            format!("{}{half}", local.format("%m%d"))
        })
        .unwrap_or_else(|| Local::now().format("%m%d").to_string());

    Ok(VolumeInspectionDto {
        volume_id,
        file_count: files.len(),
        total_bytes,
        earliest_shot_at: earliest.map(|t| t.to_rfc3339()),
        latest_shot_at: latest.map(|t| t.to_rfc3339()),
        suggested_prefix,
    })
}

// ---------- 拷卡任务 ----------

#[tauri::command]
pub fn list_copy_tasks(state: State<AppState>, project_id: Option<String>) -> Vec<CopyTaskDto> {
    state.tasks.snapshots(project_id.as_deref())
}

#[tauri::command]
pub fn get_copy_task(state: State<AppState>, task_id: String) -> Option<CopyTaskDto> {
    state
        .tasks
        .get(&task_id)
        .map(|h| tasks::summary_of(&h.snapshot.lock().unwrap()))
}

#[tauri::command]
pub fn list_copy_files(
    state: State<AppState>,
    task_id: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> CmdResult<CopyFilePage> {
    let handle = state
        .tasks
        .get(&task_id)
        .ok_or_else(|| format!("任务不存在: {task_id}"))?;
    let snap = handle.snapshot.lock().unwrap();
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(200);
    Ok(CopyFilePage {
        total: snap.files.len(),
        items: snap
            .files
            .iter()
            .skip(offset)
            .take(limit)
            .cloned()
            .collect(),
    })
}

/// 校验源卷与目的地(评审 H5/P1-5):卷白名单、绝对路径、拒绝源目标嵌套。
fn validate_copy_paths(source_root: &Path, dest_targets: &[PathBuf]) -> CmdResult<()> {
    let known = volumes::list_volumes();
    if !known.iter().any(|v| v.mount_point == source_root) {
        return Err(format!(
            "源卷不在当前挂载卷列表中: {}",
            source_root.display()
        ));
    }
    for t in dest_targets {
        if !t.is_absolute() {
            return Err(format!("目的地必须是绝对路径: {}", t.display()));
        }
        if t.starts_with(source_root) || source_root.starts_with(t) {
            return Err(format!(
                "目的地与源卷互相嵌套,拒绝执行(会写回源卡): {}",
                t.display()
            ));
        }
    }
    // 两个目的地指向同一实际位置也拒绝
    for (i, a) in dest_targets.iter().enumerate() {
        for b in dest_targets.iter().skip(i + 1) {
            if a == b {
                return Err(format!("两个目的地指向同一位置: {}", a.display()));
            }
        }
    }
    Ok(())
}

/// 目标夹已存在且非空 → 需要人工确认(评审 F1 的第一道闸)。
fn check_existing_target(dest_targets: &[PathBuf], confirmed: bool) -> CmdResult<()> {
    if confirmed {
        return Ok(());
    }
    for t in dest_targets {
        let non_empty = std::fs::read_dir(t)
            .map(|mut d| d.next().is_some())
            .unwrap_or(false);
        if non_empty {
            return Err(format!(
                "TARGET_EXISTS: 目标夹已存在且非空: {}。可能是同名重复拷卡;确认继续将只补缺失文件、绝不覆盖已有文件",
                t.display()
            ));
        }
    }
    Ok(())
}

/// 解析一次拷卡任务的真实落盘目标(不落任何盘)。供前端双确认屏展示真值(评审 H6/P1-6)。
#[tauri::command]
pub fn preview_copy_task(
    state: State<AppState>,
    input: StartCopyInput,
) -> CmdResult<serde_json::Value> {
    let nas = nas_root(&state)?;
    let stats = find_project(&nas, &input.project_id)?;
    let reg = registry::load(&nas).map_err(err)?;
    let camera = reg
        .cameras
        .iter()
        .find(|c| c.id == input.camera_id)
        .ok_or_else(|| format!("相机未登记: {}", input.camera_id))?;
    let op = operator(&state);
    let (dto, _) = tasks::build_task(
        &input,
        &stats.root,
        stats.meta.scenario,
        "",
        &camera.code,
        &op,
        &[],
        "preview",
    )
    .map_err(err)?;
    Ok(serde_json::json!({
        "targetFolder": dto.target_folder,
        "destinations": dto.destinations,
    }))
}

#[tauri::command]
pub fn start_copy_task(
    app: AppHandle,
    state: State<AppState>,
    input: StartCopyInput,
) -> CmdResult<CopyTaskDto> {
    if input.destinations.is_empty() {
        return Err("至少需要一个目的地".into());
    }
    let nas = nas_root(&state)?;
    let stats = find_project(&nas, &input.project_id)?;
    let reg = registry::load(&nas).map_err(err)?;
    let camera = reg
        .cameras
        .iter()
        .find(|c| c.id == input.camera_id)
        .ok_or_else(|| format!("相机未登记: {}", input.camera_id))?;

    let source_root = PathBuf::from(&input.volume_id);
    let files = copy::scan_source(&source_root).map_err(err)?;
    if files.is_empty() {
        return Err("源卷上没有可拷贝的素材".into());
    }
    let volume_name = volumes::list_volumes()
        .into_iter()
        .find(|v| v.mount_point == source_root)
        .map(|v| v.name)
        .unwrap_or_else(|| input.volume_id.clone());

    let op = operator(&state);
    let mut m = manifest::CopyManifest::new("", &volume_name, &camera.code, &op, &input.note);
    let (dto, dest_targets) = tasks::build_task(
        &input,
        &stats.root,
        stats.meta.scenario,
        &volume_name,
        &camera.code,
        &op,
        &files,
        &m.id,
    )
    .map_err(err)?;

    validate_copy_paths(&source_root, &dest_targets)?;
    check_existing_target(&dest_targets, input.confirm_existing_target)?;

    // target_rel 带上素材根父级(评审 P1-13)
    let raw_dir_name = match stats.meta.scenario {
        project::Scenario::A => project::SCENARIO_A_DIRS[1],
        project::Scenario::B => project::PENDING_DIR_B,
    };
    m.target_rel = format!("{raw_dir_name}/{}", dto.target_folder);
    m.destinations = dest_targets
        .iter()
        .map(|p| p.display().to_string())
        .collect();
    manifest::save(&stats.root, &m).map_err(err)?;

    let _ = journal::append(
        &stats.root,
        &journal::Event::new(
            state.machine_id.clone(),
            op,
            journal::kind::COPY_STARTED,
            serde_json::json!({
                "taskId": dto.id,
                "camera": camera.code,
                "volume": volume_name,
                "note": input.note,
                "targetFolder": dto.target_folder,
            }),
        ),
    );

    let handle = Arc::new(TaskHandle {
        pause_requested: AtomicBool::new(false),
        running: AtomicBool::new(false),
        snapshot: std::sync::Mutex::new(dto.clone()),
        project_root: stats.root.clone(),
        manifest_id: m.id.clone(),
        source_root,
        dest_targets,
        machine_id: state.machine_id.clone(),
        config_dir: state.config_dir.clone(),
    });
    state.tasks.insert(dto.id.clone(), handle.clone());
    tasks::spawn_worker(app, handle);
    Ok(dto)
}

#[tauri::command]
pub fn pause_copy_task(state: State<AppState>, task_id: String) -> CmdResult<()> {
    let handle = state
        .tasks
        .get(&task_id)
        .ok_or_else(|| format!("任务不存在: {task_id}"))?;
    handle.pause_requested.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn resume_copy_task(app: AppHandle, state: State<AppState>, task_id: String) -> CmdResult<()> {
    let handle = state
        .tasks
        .get(&task_id)
        .ok_or_else(|| format!("任务不存在: {task_id}"))?;

    if !handle.running.load(Ordering::SeqCst) {
        // 续传身份核对(评审 M10/P0-1):同一挂载点可能已换了另一张卡
        let m = manifest::load(&handle.project_root, &handle.manifest_id).map_err(err)?;
        let current_name = volumes::list_volumes()
            .into_iter()
            .find(|v| v.mount_point == handle.source_root)
            .map(|v| v.name);
        match current_name {
            Some(name) if name == m.source_label => {}
            Some(name) => {
                return Err(format!(
                    "源卷不匹配:任务记录的是「{}」,当前挂载的是「{name}」。请插回原卡再续传",
                    m.source_label
                ));
            }
            None => {
                return Err(format!("源卷未挂载:请插回「{}」后再续传", m.source_label));
            }
        }
        // 刷新清单:源卡内容可能在暂停期间变化,快照与引擎必须消费同一份新清单
        let files = copy::scan_source(&handle.source_root).map_err(err)?;
        let mut snap = handle.snapshot.lock().unwrap();
        let old: std::collections::HashMap<String, &'static str> = snap
            .files
            .iter()
            .map(|f| (f.id.clone(), f.status))
            .collect();
        snap.total_bytes = files.iter().map(|(_, s)| *s).sum();
        snap.files = files
            .iter()
            .map(|(rel, size)| dto::CopyFileItemDto {
                id: rel.clone(),
                path: rel.clone(),
                name: rel.rsplit('/').next().unwrap_or(rel).to_string(),
                size_bytes: *size,
                status: old.get(rel).copied().unwrap_or("pending"),
                hash: None,
                error: None,
                targets: None,
            })
            .collect();
        snap.file_count = Some(files.len());
    }

    tasks::spawn_worker(app, handle);
    Ok(())
}

/// 启动时从各项目未完成的 manifest 重建 paused 任务(评审 H3/P0-3):
/// 崩溃/重启后任务不再消失,可从任务列表续传。
pub fn rebuild_tasks(state: &AppState) {
    let Some(nas) = config::load(&state.config_dir).nas_root else {
        return;
    };
    let Ok(projects) = catalog::scan(&nas) else {
        return;
    };
    let vols = volumes::list_volumes();
    for p in projects {
        let Ok(manifests) = manifest::list(&p.root) else {
            continue;
        };
        for m in manifests.into_iter().filter(|m| !m.completed) {
            let dest_targets: Vec<PathBuf> = m.destinations.iter().map(PathBuf::from).collect();
            if dest_targets.is_empty() {
                continue; // 旧格式 manifest,无法重建
            }
            // 源卷按卷名匹配当前挂载;找不到则置空,续传时会要求插回原卡
            let source_root = vols
                .iter()
                .find(|v| v.name == m.source_label)
                .map(|v| v.mount_point.clone())
                .unwrap_or_default();
            let files: Vec<CopyFileItemDto> = m
                .entries
                .iter()
                .map(|e| CopyFileItemDto {
                    id: e.rel_path.clone(),
                    path: e.rel_path.clone(),
                    name: e
                        .rel_path
                        .rsplit('/')
                        .next()
                        .unwrap_or(&e.rel_path)
                        .to_string(),
                    size_bytes: e.size,
                    status: if e.verified { "verified" } else { "pending" },
                    hash: (!e.xxh3.is_empty()).then(|| e.xxh3.clone()),
                    error: None,
                    targets: None,
                })
                .collect();
            let copied: u64 = m
                .entries
                .iter()
                .filter(|e| e.verified)
                .map(|e| e.size)
                .sum();
            let dto = CopyTaskDto {
                id: m.id.clone(),
                project_id: p.folder_name.clone(),
                volume_id: source_root.display().to_string(),
                volume_name: m.source_label.clone(),
                camera_id: String::new(),
                camera_code: m.camera_code.clone(),
                note: m.note.clone(),
                target_folder: m
                    .target_rel
                    .rsplit('/')
                    .next()
                    .unwrap_or(&m.target_rel)
                    .to_string(),
                destinations: m
                    .destinations
                    .iter()
                    .enumerate()
                    .map(|(i, d)| CopyDestinationDto {
                        id: format!("dest-{i}"),
                        kind: "local".into(),
                        path: d.clone(),
                        state: "idle",
                        written_bytes: copied,
                        verified_bytes: None,
                        error: None,
                    })
                    .collect(),
                total_bytes: m.entries.iter().map(|e| e.size).sum(),
                copied_bytes: copied,
                speed_bytes_per_sec: 0,
                state: "paused",
                progress_revision: Some(0),
                operator: m.operator.clone(),
                started_at: m.created_at.to_rfc3339(),
                finished_at: None,
                file_count: Some(files.len()),
                files,
            };
            let handle = Arc::new(TaskHandle {
                pause_requested: AtomicBool::new(false),
                running: AtomicBool::new(false),
                snapshot: std::sync::Mutex::new(dto),
                project_root: p.root.clone(),
                manifest_id: m.id.clone(),
                source_root,
                dest_targets,
                machine_id: state.machine_id.clone(),
                config_dir: state.config_dir.clone(),
            });
            state.tasks.insert(m.id.clone(), handle);
        }
    }
}

/// 单文件重试:失败文件在 manifest 中未验证,重跑任务即只补拷这些文件。
#[tauri::command]
pub fn retry_copy_file(
    app: AppHandle,
    state: State<AppState>,
    task_id: String,
    _file_id: String,
) -> CmdResult<()> {
    resume_copy_task(app, state, task_id)
}
