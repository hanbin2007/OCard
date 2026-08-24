//! 分类工作台命令层(M2):契约见 src/api/types.ts。
//! - 分页列素材(缩略图 base64 内联,未索引到为 None → UI 占位);
//! - 后台索引线程:首次列出即启动,进度经 `index://progress` 推送,失败计数可见;
//! - 批量操作返回 BulkResult(部分失败逐条给原因);
//! - 连拍分组(groupId)v1 不实现,归 M3 AI 选片聚类——如实声明,不糊弄。

use super::notify;
use super::{find_project, nas_root, operator, AppState};
use crate::core::{copy, media, project, sorting};
use base64::Engine;
use chrono::Utc;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

pub const INDEX_EVENT: &str = "index://progress";

type CmdResult<T> = std::result::Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------- DTO ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SortingAssetDto {
    pub id: String,
    pub file_name: String,
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shot_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shot_at_fallback: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetPageDto {
    pub items: Vec<SortingAssetDto>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SortingCategoryDto {
    pub id: String,
    pub name: String,
    pub folder_name: String,
    pub kind: &'static str,
    pub count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hotkey: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkResultDto {
    pub succeeded: Vec<String>,
    pub failed: Vec<BulkFailure>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkFailure {
    pub asset_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntryDto {
    pub id: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub original_path: String,
    pub trashed_at: String,
    pub operator: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexingStatusDto {
    pub project_id: String,
    pub indexed: usize,
    pub total: usize,
    pub running: bool,
    pub failed: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgressEventDto {
    #[serde(flatten)]
    pub status: IndexingStatusDto,
    pub occurred_at: String,
}

// ---------- 索引管理 ----------

#[derive(Debug, Clone, Default)]
pub struct IndexState {
    pub indexed: usize,
    pub total: usize,
    pub failed: usize,
    pub running: bool,
}

#[derive(Default)]
pub struct IndexManager(pub Mutex<HashMap<String, IndexState>>);

fn emit_index_progress(app: &AppHandle, project_id: &str, st: &IndexState) {
    let _ = app.emit(
        INDEX_EVENT,
        &IndexProgressEventDto {
            status: IndexingStatusDto {
                project_id: project_id.to_string(),
                indexed: st.indexed,
                total: st.total,
                running: st.running,
                failed: st.failed,
            },
            occurred_at: Utc::now().to_rfc3339(),
        },
    );
}

/// 需要时启动该项目的后台索引线程(幂等:已在跑则不重复)。
fn ensure_indexing(
    app: &AppHandle,
    project_id: &str,
    project_root: &Path,
    files: &[(String, u64)],
) {
    let mgr = app.state::<IndexManager>();
    {
        let mut map = mgr.0.lock().unwrap();
        let st = map.entry(project_id.to_string()).or_default();
        if st.running {
            return;
        }
        // 已全部索引且清单规模没变:不重启
        if st.total == files.len() && st.indexed + st.failed >= st.total && st.total > 0 {
            return;
        }
        *st = IndexState {
            indexed: 0,
            total: files.len(),
            failed: 0,
            running: true,
        };
    }
    let app = app.clone();
    let project_id = project_id.to_string();
    let project_root = project_root.to_path_buf();
    let files: Vec<(String, u64)> = files.to_vec();
    std::thread::spawn(move || {
        let mut last_emit = std::time::Instant::now();
        for (rel, _) in &files {
            let abs = project_root.join(rel.split('/').collect::<PathBuf>());
            let ok = media::index_asset(&project_root, &abs, rel)
                .map(|i| i.thumb.is_some() || !matches!(i.kind, media::AssetKind::Photo))
                .unwrap_or(false);
            let mgr = app.state::<IndexManager>();
            let mut map = mgr.0.lock().unwrap();
            let st = map.entry(project_id.clone()).or_default();
            if ok {
                st.indexed += 1;
            } else {
                st.failed += 1;
            }
            let snapshot = st.clone();
            drop(map);
            if last_emit.elapsed().as_millis() >= 500 {
                last_emit = std::time::Instant::now();
                emit_index_progress(&app, &project_id, &snapshot);
            }
        }
        let mgr = app.state::<IndexManager>();
        let mut map = mgr.0.lock().unwrap();
        let st = map.entry(project_id.clone()).or_default();
        st.running = false;
        let snapshot = st.clone();
        drop(map);
        emit_index_progress(&app, &project_id, &snapshot);
        // 零静默:索引失败数最终不为零,给一条汇总告警
        if snapshot.failed > 0 {
            notify::warn(
                &app,
                "index-failures",
                format!(
                    "项目素材索引完成,{} 个文件无法生成预览(损坏或不支持的格式),网格中以占位显示",
                    snapshot.failed
                ),
            );
        }
    });
}

// ---------- 命令 ----------

fn inbox_rel_files(project_root: &Path) -> CmdResult<Vec<(String, u64)>> {
    let inbox = project_root.join(project::PENDING_DIR_B);
    let mut files = copy::scan_source(&inbox).map_err(err)?;
    // 相对路径补上「1. 待分类/」前缀,作为项目内稳定 id
    for f in files.iter_mut() {
        f.0 = format!("{}/{}", project::PENDING_DIR_B, f.0);
    }
    files.sort();
    Ok(files)
}

fn asset_dto(project_root: &Path, rel: &str, size: u64) -> SortingAssetDto {
    let abs = project_root.join(rel.split('/').collect::<PathBuf>());
    let kind = media::classify(rel);
    let exif_time = media::exif_shot_at(&abs);
    let fallback = exif_time.is_none();
    let shot_at = exif_time.or_else(|| {
        std::fs::metadata(&abs)
            .ok()
            .and_then(|m| m.modified().ok())
            .map(chrono::DateTime::<Utc>::from)
    });
    let thumb_path = media::cached_thumb_path(project_root, rel, size);
    let thumb = thumb_path
        .is_file()
        .then(|| std::fs::read(&thumb_path).ok())
        .flatten()
        .map(|bytes| {
            format!(
                "data:image/jpeg;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )
        });
    SortingAssetDto {
        id: rel.to_string(),
        file_name: rel.rsplit('/').next().unwrap_or(rel).to_string(),
        size_bytes: size,
        shot_at: shot_at.map(|t| t.to_rfc3339()),
        shot_at_fallback: shot_at.is_some().then_some(fallback).filter(|f| *f),
        thumbnail: thumb,
        kind: match kind {
            media::AssetKind::Photo => "photo",
            media::AssetKind::Raw => "raw",
            media::AssetKind::Video | media::AssetKind::Other => "video",
        },
        group_id: None, // 连拍分组归 M3 聚类,如实为 None
    }
}

#[tauri::command]
pub fn list_pending_assets(
    app: AppHandle,
    state: State<AppState>,
    project_id: String,
    offset: usize,
    limit: usize,
) -> CmdResult<AssetPageDto> {
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    let files = inbox_rel_files(&stats.root)?;
    ensure_indexing(&app, &project_id, &stats.root, &files);
    let total = files.len();
    let items = files
        .iter()
        .skip(offset)
        .take(limit.min(500))
        .map(|(rel, size)| asset_dto(&stats.root, rel, *size))
        .collect();
    Ok(AssetPageDto { items, total })
}

#[tauri::command]
pub fn list_categories(
    app: AppHandle,
    state: State<AppState>,
    project_id: String,
) -> CmdResult<Vec<SortingCategoryDto>> {
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    Ok(sorting::list_categories(&stats.root, &stats.meta)
        .map_err(err)?
        .into_iter()
        .map(|c| SortingCategoryDto {
            id: c.id,
            name: c.name,
            folder_name: c.folder_name,
            kind: c.kind,
            count: c.count,
            hotkey: c.hotkey,
        })
        .collect())
}

fn bulk(outcomes: Vec<sorting::ItemOutcome>) -> BulkResultDto {
    let mut res = BulkResultDto {
        succeeded: Vec::new(),
        failed: Vec::new(),
    };
    for o in outcomes {
        match o.result {
            Ok(()) => res.succeeded.push(o.asset_id),
            Err(message) => res.failed.push(BulkFailure {
                asset_id: o.asset_id,
                message,
            }),
        }
    }
    res
}

/// 批量操作的审计事件(汇总一条,失败逐项列出)。
#[allow(clippy::too_many_arguments)]
fn audit_bulk(
    app: &AppHandle,
    state: &State<AppState>,
    project_root: &Path,
    kind: &str,
    detail: &str,
    result: &BulkResultDto,
) {
    let op = operator(app, state);
    super::tasks::append_audit(
        app,
        project_root,
        &state.config_dir,
        &sorting::audit_event(
            &state.machine_id,
            &op,
            kind,
            serde_json::json!({
                "detail": detail,
                "succeeded": result.succeeded.len(),
                "failed": result.failed,
            }),
        ),
    );
}

#[tauri::command]
pub fn move_assets(
    app: AppHandle,
    state: State<AppState>,
    project_id: String,
    asset_ids: Vec<String>,
    category_id: String,
) -> CmdResult<BulkResultDto> {
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    // 分类夹白名单:category_id 必须是该项目已知分类
    let cats = sorting::list_categories(&stats.root, &stats.meta).map_err(err)?;
    if !cats
        .iter()
        .any(|c| c.id == category_id && c.kind != "inbox")
    {
        return Err(format!("未知分类: {category_id}"));
    }
    let res = bulk(sorting::move_assets(&stats.root, &asset_ids, &category_id));
    audit_bulk(
        &app,
        &state,
        &stats.root,
        sorting::kind::ASSETS_MOVED,
        &category_id,
        &res,
    );
    Ok(res)
}

#[tauri::command]
pub fn curate_assets(
    app: AppHandle,
    state: State<AppState>,
    project_id: String,
    asset_ids: Vec<String>,
) -> CmdResult<BulkResultDto> {
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    let res = bulk(sorting::curate_assets(&stats.root, &asset_ids));
    audit_bulk(
        &app,
        &state,
        &stats.root,
        sorting::kind::ASSETS_CURATED,
        "精选/待修",
        &res,
    );
    Ok(res)
}

#[tauri::command]
pub fn trash_assets(
    app: AppHandle,
    state: State<AppState>,
    project_id: String,
    asset_ids: Vec<String>,
) -> CmdResult<BulkResultDto> {
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    let op = operator(&app, &state);
    let res = bulk(sorting::trash_assets(&stats.root, &asset_ids, &op));
    audit_bulk(
        &app,
        &state,
        &stats.root,
        sorting::kind::ASSETS_TRASHED,
        "回收站",
        &res,
    );
    Ok(res)
}

#[tauri::command]
pub fn list_trash(
    app: AppHandle,
    state: State<AppState>,
    project_id: String,
) -> CmdResult<Vec<TrashEntryDto>> {
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    let (records, skipped) = sorting::list_trash(&stats.root).map_err(err)?;
    if skipped > 0 {
        notify::warn(
            &app,
            "trash-index-degraded",
            format!("回收站索引有 {skipped} 行损坏被跳过,列表可能不完整"),
        );
    }
    Ok(records
        .into_iter()
        .map(|r| TrashEntryDto {
            id: r.id,
            file_name: r.file_name,
            size_bytes: r.size_bytes,
            original_path: r.original_path,
            trashed_at: r.trashed_at.to_rfc3339(),
            operator: r.operator,
        })
        .collect())
}

#[tauri::command]
pub fn restore_from_trash(
    app: AppHandle,
    state: State<AppState>,
    project_id: String,
    entry_ids: Vec<String>,
) -> CmdResult<BulkResultDto> {
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    let res = bulk(sorting::restore_from_trash(&stats.root, &entry_ids).map_err(err)?);
    audit_bulk(
        &app,
        &state,
        &stats.root,
        sorting::kind::ASSETS_RESTORED,
        "恢复",
        &res,
    );
    Ok(res)
}

#[tauri::command]
pub fn empty_trash(app: AppHandle, state: State<AppState>, project_id: String) -> CmdResult<usize> {
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    let (deleted, failed) = sorting::empty_trash(&stats.root).map_err(err)?;
    let op = operator(&app, &state);
    super::tasks::append_audit(
        &app,
        &stats.root,
        &state.config_dir,
        &sorting::audit_event(
            &state.machine_id,
            &op,
            sorting::kind::TRASH_EMPTIED,
            serde_json::json!({ "deleted": deleted, "failed": failed }),
        ),
    );
    if failed > 0 {
        notify::warn(
            &app,
            "trash-empty-partial",
            format!("清空回收站:{deleted} 个已删除,{failed} 个删除失败(索引已保留,可重试)"),
        );
    }
    Ok(deleted)
}

#[tauri::command]
pub fn indexing_status(app: AppHandle, project_id: String) -> IndexingStatusDto {
    let mgr = app.state::<IndexManager>();
    let map = mgr.0.lock().unwrap();
    let st = map.get(&project_id).cloned().unwrap_or_default();
    IndexingStatusDto {
        project_id,
        indexed: st.indexed,
        total: st.total,
        running: st.running,
        failed: st.failed,
    }
}
