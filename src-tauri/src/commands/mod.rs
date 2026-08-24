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

fn project_dto(stats: &catalog::ProjectStats, cards_total: usize, running: bool) -> ProjectDto {
    let manifests_dest_max = 1; // destination 细节在 manifest 里,汇总口径先取 1
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
        cards_total,
        bytes_copied: stats.bytes_copied,
        asset_count: stats.asset_count,
        sorted_count: 0,
        destination_count: manifests_dest_max,
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
    let cards_total = registry::load(&nas).map(|r| r.cards.len()).unwrap_or(0);
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
        .map(|s| project_dto(s, cards_total, running.contains(&s.folder_name)))
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
    let cards_total = registry::load(&nas).map(|r| r.cards.len()).unwrap_or(0);
    Ok(project_dto(&stats, cards_total, false))
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
    );
    m.target_rel = dto.target_folder.clone();
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
    tasks::spawn_worker(app, handle);
    Ok(())
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
