//! Tauri 命令层:实现 `src/api/index.ts` 里标注的全部 invoke 契约。
//! 错误统一映射为字符串消息(前端 toast 展示)。

pub mod analysis_cmds;
pub mod dto;
pub mod finalcut_cmds;
#[cfg(all(test, not(windows)))]
mod integration_tests;
pub mod notify;
pub mod sorting_cmds;
pub mod tasks;
pub mod thumb_proto;
pub mod transcode_cmds;
pub mod updater;
pub mod windows_cmds;

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
    /// 通知积压:堵住「前端监听就绪前发出的通知永久丢失」的窗口。
    pub notices: std::sync::Mutex<Vec<notify::NoticeDto>>,
    /// 本机「交付 ↔ 分类/回收站」互斥闸(原子、可单测、panic 安全,见 OpsMutex)。
    pub ops: sorting_cmds::OpsMutex,
}

type CmdResult<T> = std::result::Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// 读配置并上报问题(零静默:业务路径的配置损坏/权限错误也必须可见,codex 五轮)。
fn load_config<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
) -> config::WorkstationConfig {
    let (cfg, problem) = config::load_checked(&state.config_dir);
    if let Some(msg) = problem {
        notify::warn(app, "workstation-config-degraded", msg);
    }
    cfg
}

pub(crate) fn nas_root<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
) -> CmdResult<PathBuf> {
    load_config(app, state)
        .nas_root
        .ok_or_else(|| "尚未配置 NAS 根路径,请先在设置中配置".to_string())
}

fn operator<R: tauri::Runtime>(app: &AppHandle<R>, state: &AppState) -> String {
    let op = load_config(app, state).operator;
    if op.is_empty() {
        "未登记DIT".to_string()
    } else {
        op
    }
}

fn parse_compact_date(s: &str) -> CmdResult<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y%m%d").map_err(|_| format!("日期格式应为 YYYYMMDD: {s}"))
}

/// 把完成拷卡的来源(指纹优先/卷名兜底)映射为登记卡 id 集。
fn resolve_done_card_ids(
    sources: &[catalog::CopySource],
    cards: &[registry::StorageCard],
) -> std::collections::HashSet<String> {
    sources
        .iter()
        .filter_map(|src| match_card(cards, src.source_uid.as_deref(), &src.volume_name).0)
        .collect()
}

fn project_dto(
    stats: &catalog::ProjectStats,
    // None = 登记表读取失败:x/y 报「未知」(字段缺席),不许把未知折成 0
    cards: Option<&[registry::StorageCard]>,
    running: bool,
) -> ProjectDto {
    ProjectDto {
        id: stats.folder_name.clone(),
        name: stats.meta.name.clone(),
        date: stats.meta.date.format("%Y%m%d").to_string(),
        folder_name: stats.folder_name.clone(),
        scenario: stats.meta.scenario,
        categories: stats.meta.categories.clone(),
        relative_path: stats.folder_name.clone(),
        // 有未完成 manifest 但无运行任务 = 暂停中(任务列表有续传入口),不再误标 copying(L21)
        status: if running {
            "copying"
        } else if stats.cards_copied > 0 {
            "sorting"
        } else {
            "draft"
        },
        cards_copied: stats.cards_copied,
        copy_incomplete: stats.has_incomplete_copy,
        card_roster_total: cards.and_then(|cards| {
            live_roster(stats, cards)
                .filter(|r| !r.is_empty())
                .map(|r| r.len())
        }),
        card_roster_done: cards.and_then(|cards| {
            live_roster(stats, cards)
                .filter(|r| !r.is_empty())
                .map(|roster| {
                    let done = resolve_done_card_ids(&stats.completed_sources, cards);
                    roster.iter().filter(|id| done.contains(*id)).count()
                })
        }),
        bytes_copied: stats.bytes_copied,
        asset_count: stats.asset_count,
        sorted_count: 0,
        // 如实报告:没拷过就是 0 个目的地,不虚报(复核 #14)
        destination_count: stats.destination_max,
        updated_at: stats.updated_at.to_rfc3339(),
    }
}

pub(crate) fn find_project(nas: &Path, project_id: &str) -> CmdResult<catalog::ProjectStats> {
    let mut stats = catalog::scan_cached(nas)
        .map_err(err)?
        .projects
        .into_iter()
        .find(|p| p.folder_name == project_id)
        .ok_or_else(|| format!("项目不存在: {project_id}"))?;
    // R4(终审 P0-3):项目根统一 canonical 锚——命令层一切 `.ocard` 读写、
    // 落地闸与协议闸都以这里返回的 root 为锚;链接项目与 NAS 外实体一律拒。
    if crate::core::paths::is_symlink(&stats.root) {
        return Err(format!("项目目录是符号链接,拒绝: {project_id}"));
    }
    let canon_nas = std::fs::canonicalize(nas).map_err(err)?;
    let canon = std::fs::canonicalize(&stats.root).map_err(err)?;
    if !crate::core::paths::comparison_key(&canon)
        .starts_with(crate::core::paths::comparison_key(&canon_nas))
    {
        return Err(format!("项目实际位置在 NAS 根之外,拒绝: {project_id}"));
    }
    stats.root = canon;
    Ok(stats)
}

// ---------- 工作站 ----------

#[tauri::command]
pub fn get_workstation_info<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
) -> WorkstationInfoDto {
    let (cfg, problem) = config::load_checked(&state.config_dir);
    if let Some(msg) = problem {
        notify::warn(&app, "workstation-config-degraded", msg);
    }
    WorkstationInfoDto {
        machine_id: state.machine_id.clone(),
        operator: cfg.operator,
        nas_root: cfg
            .nas_root
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        recent_projects: cfg
            .recent_projects
            .into_iter()
            .map(|r| RecentProjectDto {
                id: r.id,
                name: r.name,
                folder_name: r.folder_name,
                scenario: r.scenario,
                last_opened_at: r.last_opened_at,
            })
            .collect(),
    }
}

#[tauri::command]
pub fn set_workstation_info<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    operator: String,
    nas_root: String,
) -> CmdResult<WorkstationInfoDto> {
    // 改操作人/NAS 根不清空本机最近打开记录:先读旧配置保留 recents
    let (mut cfg, _) = config::load_checked(&state.config_dir);
    cfg.operator = operator;
    cfg.nas_root = if nas_root.trim().is_empty() {
        None
    } else {
        Some(PathBuf::from(nas_root.trim()))
    };
    config::save(&state.config_dir, &cfg).map_err(err)?;
    Ok(get_workstation_info(app, state))
}

// ---------- 项目级设置(标签库 + 备份目的地预设) ----------

#[tauri::command]
pub fn get_project_settings<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    project_id: String,
) -> CmdResult<project::ProjectSettings> {
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    project::load_settings(&stats.root)
        .map_err(|e| format!("读取项目设置失败(标签库/备份预设可能不可用): {e}"))
}

#[tauri::command]
pub fn save_project_settings<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    project_id: String,
    settings: project::ProjectSettings,
) -> CmdResult<project::ProjectSettings> {
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    project::save_settings(&stats.root, &settings).map_err(err)?;
    // 回读落盘结果:调用方拿到的就是共享文件里的真值
    project::load_settings(&stats.root).map_err(err)
}

// ---------- 项目 ----------

/// 上报登记表 journal 健康度(UX 原则:容错跳过必须让用户看见)。
fn notice_registry_health<R: tauri::Runtime>(app: &AppHandle<R>, load: &registry::RegistryLoad) {
    if load.skipped_lines > 0 || load.unreadable_files > 0 || load.skipped_payloads > 0 {
        notify::warn(
            app,
            "registry-journal-degraded",
            format!(
                "登记表日志存在损坏数据:已跳过 {} 行、{} 个文件、{} 条无效载荷。登记内容可能不完整,请检查 NAS 上的 .ocard-registry",
                load.skipped_lines, load.unreadable_files, load.skipped_payloads
            ),
        );
    }
}

fn notice_catalog_warnings<R: tauri::Runtime>(app: &AppHandle<R>, warnings: &[String]) {
    for w in warnings {
        notify::warn(app, "project-meta-corrupt", w.clone());
    }
}

#[tauri::command]
pub fn list_projects<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
) -> CmdResult<Vec<ProjectDto>> {
    let nas = nas_root(&app, &state)?;
    let running: Vec<String> = state
        .tasks
        .snapshots(None)
        .into_iter()
        .filter(|t| t.state == "running")
        .map(|t| t.project_id)
        .collect();
    let scan = catalog::scan_cached(&nas).map_err(err)?;
    notice_catalog_warnings(&app, &scan.warnings);
    let cards = match registry::load(&nas) {
        Ok(load) => {
            notice_registry_health(&app, &load);
            Some(load.registry.cards)
        }
        Err(e) => {
            notify::warn(
                &app,
                "volumes-registry-unavailable",
                format!("登记表读取失败,用卡进度暂时显示为未知: {e}"),
            );
            None
        }
    };
    Ok(scan
        .projects
        .iter()
        .map(|s| project_dto(s, cards.as_deref(), running.contains(&s.folder_name)))
        .collect())
}

#[tauri::command]
pub fn get_project<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    project_id: String,
) -> CmdResult<Option<ProjectDto>> {
    Ok(list_projects(app, state)?
        .into_iter()
        .find(|p| p.id == project_id))
}

#[tauri::command]
pub fn create_project<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    input: NewProjectInput,
) -> CmdResult<ProjectDto> {
    let nas = nas_root(&app, &state)?;
    let date = parse_compact_date(&input.date)?;
    let root = project::create_project(&nas, date, &input.name, input.scenario, &input.categories)
        .map_err(err)?;
    tasks::append_audit(
        &app,
        &root,
        &state.config_dir,
        &journal::Event::new(
            state.machine_id.clone(),
            operator(&app, &state),
            journal::kind::PROJECT_CREATED,
            serde_json::json!({"name": input.name, "scenario": input.scenario}),
        ),
    );
    catalog::invalidate_cache(&nas);
    let stats = find_project(&nas, &root.file_name().unwrap().to_string_lossy())?;
    // 新建项目还没有用卡记录,登记卡表在映射里用不上,给空表即可
    Ok(project_dto(&stats, Some(&[]), false))
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
        project::Scenario::B => {
            let dirs = project::scenario_b_dirs(&categories);
            let curated_idx = dirs.len() - 2; // 角色按布局下标,不猜名字(复验 10)
            dirs.into_iter()
                .enumerate()
                .map(|(i, d)| {
                    let children = if i == curated_idx {
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
                .collect()
        }
    }
}

// ---------- 登记表 ----------

#[tauri::command]
pub fn list_cameras<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
) -> CmdResult<Vec<registry::CameraReg>> {
    let load = registry::load(&nas_root(&app, &state)?).map_err(err)?;
    notice_registry_health(&app, &load);
    Ok(load.registry.cameras)
}

#[tauri::command]
pub fn create_camera<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    input: NewCameraInput,
) -> CmdResult<registry::CameraReg> {
    registry::register_camera(
        &nas_root(&app, &state)?,
        &state.machine_id,
        &operator(&app, &state),
        &input.model,
        &input.position,
        &input.operator_alias,
        input.note,
    )
    .map_err(err)
}

#[tauri::command]
pub fn delete_camera<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    camera_id: String,
) -> CmdResult<()> {
    registry::delete_camera(
        &nas_root(&app, &state)?,
        &state.machine_id,
        &operator(&app, &state),
        &camera_id,
    )
    .map_err(err)
}

#[tauri::command]
pub fn list_storage_cards<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
) -> CmdResult<Vec<registry::StorageCard>> {
    let load = registry::load(&nas_root(&app, &state)?).map_err(err)?;
    notice_registry_health(&app, &load);
    Ok(load.registry.cards)
}

/// 卷 ↔ 登记卡匹配(纯函数,单测锚点):uid 强匹配优先,卷标弱匹配兜底。
/// 返回 (匹配卡 id, 需要上报的冲突说明)。
/// - 同 uid 命中多张卡:克隆/重复登记,拒绝匹配并要求清理(零静默);
/// - uid 命中 A 而卷标同 B:以指纹为准,但差异必须可见。
pub(crate) fn match_card(
    cards: &[registry::StorageCard],
    uid: Option<&str>,
    volume_name: &str,
) -> (Option<String>, Option<String>) {
    let uid_hits: Vec<&registry::StorageCard> = uid
        .map(|u| {
            cards
                .iter()
                .filter(|c| c.volume_uid.as_deref() == Some(u))
                .collect()
        })
        .unwrap_or_default();
    if uid_hits.len() > 1 {
        let labels = uid_hits
            .iter()
            .map(|c| c.label.as_str())
            .collect::<Vec<_>>()
            .join("、");
        return (
            None,
            Some(format!(
                "卷「{volume_name}」的身份指纹同时登记在多张卡名下({labels}),已不匹配任何一张,请删除重复登记"
            )),
        );
    }
    if let Some(hit) = uid_hits.first() {
        let conflict = cards
            .iter()
            .find(|c| c.label.eq_ignore_ascii_case(volume_name))
            .filter(|b| b.id != hit.id)
            .map(|b| {
                format!(
                    "卷「{volume_name}」按指纹认定为「{}」,但卷标与另一张卡「{}」相同;以指纹为准",
                    hit.label, b.label
                )
            });
        return (Some(hit.id.clone()), conflict);
    }
    let label_hits: Vec<&registry::StorageCard> = cards
        .iter()
        .filter(|c| c.label.eq_ignore_ascii_case(volume_name))
        .collect();
    if label_hits.len() > 1 {
        let labels = label_hits
            .iter()
            .map(|c| c.label.as_str())
            .collect::<Vec<_>>()
            .join("、");
        return (
            None,
            Some(format!(
                "卷「{volume_name}」按卷标能对上多张登记卡({labels}),无法确定是哪张,请为旧卡补绑指纹"
            )),
        );
    }
    let label_hit = label_hits.first().copied();
    // 卷带着未登记的指纹时,卷标兜底只许落在「从未绑定过指纹」的旧卡上:
    // 卷标对上的卡绑着**别的**指纹 = 克隆/换卡,静默配对会稳定认错(codex P1)
    if uid.is_some() {
        if let Some(b) = label_hit {
            if b.volume_uid.is_some() {
                return (
                    None,
                    Some(format!(
                        "卷「{volume_name}」带有未登记的身份指纹,而同卷标的卡「{}」绑着另一枚指纹——可能是克隆卡或换过卡,请重新绑定登记",
                        b.label
                    )),
                );
            }
        }
    }
    (label_hit.map(|c| c.id.clone()), None)
}

#[tauri::command]
pub fn create_storage_card<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    input: NewStorageCardInput,
) -> CmdResult<registry::StorageCard> {
    // 插卡绑定(用户指正的登记盲区):不绑物理卡,之后只能靠「卷标==卡标签」
    // 弱匹配认卡。绑定 = 校验该卷确实挂载中 → 当场在卡根写身份指纹 → uid 入表。
    // 顺序原则(评审):一切无副作用校验(NAS 可达/标签/相机/卷名核对)先行,
    // 往卡上写指纹放在最后——校验失败不许在卡上留无主文件。
    let nas = nas_root(&app, &state)?;
    if input.label.trim().is_empty() {
        return Err("卡标签不能为空".into());
    }
    let reg = registry::load(&nas).map_err(err)?.registry;
    if !reg.cameras.iter().any(|c| c.id == input.camera_id) {
        return Err(format!("相机未登记: {}", input.camera_id));
    }
    // 标签唯一:卷名兜底匹配按标签认卡,重名会静默认错(评审 P2)
    if reg
        .cards
        .iter()
        .any(|c| c.label.eq_ignore_ascii_case(input.label.trim()))
    {
        return Err(format!(
            "卡面标签「{}」已被另一张卡使用,请换一个可辨识的标签",
            input.label.trim()
        ));
    }
    let (volume_uid, capacity_bytes) = match &input.bind_mount_path {
        None => (None, input.capacity_bytes),
        Some(raw) => {
            let mount = PathBuf::from(raw);
            let mounted = volumes::list_volumes()
                .into_iter()
                .find(|v| v.mount_point == mount)
                .ok_or_else(|| format!("要绑定的卷未挂载: {raw}"))?;
            if mounted.system {
                return Err(format!("拒绝绑定系统内置盘: {raw}"));
            }
            // 挂载点复用是现实场景(拔 A 插 B 都挂 /Volumes/UNTITLED):
            // 与前端所见卷名核对,不一致 = 卡已换,拒绝并要求刷新(评审 P1)
            if let Some(expect) = input.bind_volume_name.as_deref() {
                if !expect.trim().is_empty() && expect != mounted.name {
                    return Err(format!(
                        "该挂载点上的卡已变化(选择时是「{expect}」,现在是「{}」),请刷新卷列表后重选",
                        mounted.name
                    ));
                }
            }
            let uid = volumes::ensure_volume_uid(&mount).ok_or_else(|| {
                format!("无法在卡上写入身份指纹(卡可能写保护或只读): {raw}。解除写保护后重试,或改用「不绑定」登记(退化为卷标匹配)")
            })?;
            // 指纹唯一性:同 uid 已在别的卡名下 = 克隆卡/重复登记,
            // 「强匹配」会稳定认错卡,必须拒绝(评审 P1)
            if let Some(dup) = reg
                .cards
                .iter()
                .find(|c| c.volume_uid.as_deref() == Some(uid.as_str()))
            {
                return Err(format!(
                    "这张卡的身份指纹已登记在「{}」名下,不能重复登记;如需改绑请先删除原登记",
                    dup.label
                ));
            }
            // 容量以后端实测挂载卷为准,不信前端缓存(评审 P1)
            (Some(uid), mounted.total_bytes)
        }
    };
    registry::register_card(
        &nas,
        &state.machine_id,
        &operator(&app, &state),
        &input.label,
        &input.camera_id,
        capacity_bytes,
        input.serial,
        volume_uid,
    )
    .map_err(err)
}

#[tauri::command]
pub fn delete_storage_card<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    card_id: String,
) -> CmdResult<()> {
    registry::delete_card(
        &nas_root(&app, &state)?,
        &state.machine_id,
        &operator(&app, &state),
        &card_id,
    )
    .map_err(err)
}

// ---------- 项目用卡(UX 波三:x/y 的真分母) ----------

/// 清单里只认仍在登记表的卡:登记卡被注销后,项目 journal 里的旧 id
/// 不许再撑大分母、也不许在面板露裸 id(评审 P1)。
fn live_roster(
    stats: &catalog::ProjectStats,
    cards: &[registry::StorageCard],
) -> Option<Vec<String>> {
    stats.card_roster.as_ref().map(|roster| {
        roster
            .iter()
            .filter(|id| cards.iter().any(|c| &c.id == *id))
            .cloned()
            .collect()
    })
}

fn project_cards_dto(
    stats: &catalog::ProjectStats,
    cards: &[registry::StorageCard],
) -> ProjectCardsDto {
    let roster = live_roster(stats, cards).unwrap_or_default();
    let done = resolve_done_card_ids(&stats.completed_sources, cards);
    ProjectCardsDto {
        copied_card_ids: roster
            .iter()
            .filter(|id| done.contains(*id))
            .cloned()
            .collect(),
        card_ids: roster,
    }
}

#[tauri::command]
pub fn list_project_cards<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    project_id: String,
) -> CmdResult<ProjectCardsDto> {
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    let cards = registry::load(&nas).map_err(err)?.registry.cards;
    Ok(project_cards_dto(&stats, &cards))
}

#[tauri::command]
pub fn set_project_cards<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    project_id: String,
    card_ids: Vec<String>,
) -> CmdResult<ProjectCardsDto> {
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    let cards = registry::load(&nas).map_err(err)?.registry.cards;
    let existing: std::collections::HashSet<&String> = stats
        .card_roster
        .as_ref()
        .map(|r| r.iter().collect())
        .unwrap_or_default();
    // 去重保序;引用校验只针对**新增**的 id——已在清单里但登记卡被注销的 id
    // 静默剔除并可见告知,否则清单会被死 id 锁到只能整单重置(评审 P1)
    let mut seen = std::collections::HashSet::new();
    let mut ids: Vec<String> = Vec::new();
    let mut dropped = 0usize;
    for id in card_ids {
        let registered = cards.iter().any(|c| c.id == id);
        if !registered {
            if existing.contains(&id) {
                dropped += 1;
                continue;
            }
            return Err(format!("卡未登记,无法加入项目用卡清单: {id}"));
        }
        if seen.insert(id.clone()) {
            ids.push(id);
        }
    }
    if dropped > 0 {
        notify::warn(
            &app,
            "project-cards-pruned",
            format!("清单中有 {dropped} 张卡的登记已被删除,已一并从用卡清单移除"),
        );
    }
    let outcome = tasks::append_audit(
        &app,
        &stats.root,
        &state.config_dir,
        &journal::Event::new(
            state.machine_id.clone(),
            operator(&app, &state),
            journal::kind::PROJECT_CARDS_SET,
            serde_json::json!({ "cardIds": ids }),
        ),
    );
    // 这条事件是**配置**不是纯审计:没写进项目日志 = 清单没保存,
    // outbox 里的副本不会被折叠读到,必须如实报失败(评审 P1)
    if outcome != tasks::AuditWrite::Written {
        return Err("用卡清单未能写入项目日志(NAS 可能不可达),本次修改未保存,请稍后重试".into());
    }
    catalog::invalidate_cache(&nas);
    let stats = find_project(&nas, &project_id)?;
    Ok(project_cards_dto(&stats, &cards))
}

/// 原子追加一张卡到项目用卡清单(快捷拷卡引导)。
/// 与 set_project_cards 的整表覆盖不同:写可交换的增量事件,
/// 两台工作站同时各加一张卡不会互相覆盖(评审 P0)。
#[tauri::command]
pub fn add_project_card<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    project_id: String,
    card_id: String,
) -> CmdResult<ProjectCardsDto> {
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    let cards = registry::load(&nas).map_err(err)?.registry.cards;
    if !cards.iter().any(|c| c.id == card_id) {
        return Err(format!("卡未登记,无法加入项目用卡清单: {card_id}"));
    }
    // 已在清单里 = 幂等成功,不再写重复事件(折叠端也去重,双保险)
    let already = stats
        .card_roster
        .as_ref()
        .map(|r| r.iter().any(|x| x == &card_id))
        .unwrap_or(false);
    if !already {
        let outcome = tasks::append_audit(
            &app,
            &stats.root,
            &state.config_dir,
            &journal::Event::new(
                state.machine_id.clone(),
                operator(&app, &state),
                journal::kind::PROJECT_CARD_ADDED,
                serde_json::json!({ "cardId": card_id }),
            ),
        );
        // 配置类事件:没写进项目日志 = 没保存,必须如实报失败
        if outcome != tasks::AuditWrite::Written {
            return Err(
                "用卡清单未能写入项目日志(NAS 可能不可达),本次修改未保存,请稍后重试".into(),
            );
        }
        catalog::invalidate_cache(&nas);
    }
    let stats = find_project(&nas, &project_id)?;
    Ok(project_cards_dto(&stats, &cards))
}

// ---------- 卷 ----------

#[tauri::command]
pub fn list_volumes<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
) -> Vec<VolumeDto> {
    // 卡匹配是增强信息:登记表读不到时降级为「无法核对」,但必须告知(零静默);
    // 判别上「读不到」≠「未登记」——混为一谈会引导重复登记(评审 P0)
    let (cards, registry_ok) = match nas_root(&app, &state) {
        Err(_) => (Vec::new(), false), // NAS 未配置:首跑正常态,同样属「无法核对」
        Ok(nas) => match registry::load(&nas) {
            Ok(load) => {
                notice_registry_health(&app, &load);
                (load.registry.cards, true)
            }
            Err(e) => {
                notify::warn(
                    &app,
                    "volumes-registry-unavailable",
                    format!("登记表读取失败,卷列表暂无法关联已登记的卡: {e}"),
                );
                (Vec::new(), false)
            }
        },
    };
    volumes::list_volumes()
        .into_iter()
        .map(|v| {
            // 指纹优先:卡根 `.ocard-volume-id` 与登记表 volume_uid 对上 = 强匹配;
            // 读不到指纹或没登记 uid 时退回卷标弱匹配。系统盘不做指纹探测:
            // 在 `/` 放一个指纹文件不该让启动盘被认成登记卡(评审 P2)
            let uid = if v.system {
                None
            } else {
                volumes::read_volume_uid(&v.mount_point)
            };
            let (matched, conflict) = match_card(&cards, uid.as_deref(), &v.name);
            let match_status = if !registry_ok {
                "unavailable"
            } else if conflict.is_some() && matched.is_none() {
                "conflict"
            } else if matched.is_some() {
                "matched"
            } else {
                "unregistered"
            };
            if let Some(msg) = conflict {
                notify::warn(&app, "card-match-conflict", msg);
            }
            VolumeDto {
                id: v.mount_point.display().to_string(),
                name: v.name,
                mount_path: v.mount_point.display().to_string(),
                capacity_bytes: v.total_bytes,
                used_bytes: v.total_bytes.saturating_sub(v.available_bytes),
                removable: v.removable,
                is_system: v.system,
                matched_card_id: matched,
                match_status,
            }
        })
        .collect()
}

#[tauri::command]
pub fn inspect_volume(volume_id: String) -> CmdResult<VolumeInspectionDto> {
    let root = PathBuf::from(&volume_id);
    let files = copy::scan_source(&root).map_err(err)?;
    let total_bytes = files.iter().map(|(_, s)| *s).sum();

    // EXIF 拍摄时间优先(M2 技术债:mtime 会因拷贝/修复时间戳失真);
    // 大卡按步长采样(≤300 个样本)控制 EXIF 解析耗时
    let mut earliest: Option<chrono::DateTime<Utc>> = None;
    let mut latest: Option<chrono::DateTime<Utc>> = None;
    let step = files.len().div_ceil(300).max(1); // 向上取整:301-599 个也只采 ≤300 样本
    for (i, (rel, _)) in files.iter().enumerate() {
        if i % step != 0 {
            continue;
        }
        let p: PathBuf = rel.split('/').fold(root.clone(), |acc, c| acc.join(c));
        let t = crate::core::media::exif_shot_at(&p).or_else(|| {
            std::fs::metadata(&p)
                .ok()
                .and_then(|m| m.modified().ok())
                .map(chrono::DateTime::<Utc>::from)
        });
        if let Some(t) = t {
            earliest = Some(earliest.map_or(t, |e| e.min(t)));
            latest = Some(latest.map_or(t, |l| l.max(t)));
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

use crate::core::paths::normalize_lexical;

/// 校验源卷与目的地(评审 H5/P1-5):卷白名单 + 布局校验(core::paths)。
fn validate_copy_paths(source_root: &Path, dest_targets: &[PathBuf]) -> CmdResult<()> {
    let source_root_n = normalize_lexical(source_root);
    let known = volumes::list_volumes();
    if !known
        .iter()
        .any(|v| normalize_lexical(&v.mount_point) == source_root_n)
    {
        return Err(format!(
            "源卷不在当前挂载卷列表中: {}",
            source_root_n.display()
        ));
    }
    // R5 终审:canonical 投影复检(目的地根上级链接回源卡必须在此拦下)
    crate::core::paths::validate_dest_layout_projected(source_root, dest_targets)
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
pub fn preview_copy_task<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    input: StartCopyInput,
) -> CmdResult<serde_json::Value> {
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &input.project_id)?;
    let load = registry::load(&nas).map_err(err)?;
    notice_registry_health(&app, &load);
    let reg = load.registry;
    let camera = reg
        .cameras
        .iter()
        .find(|c| c.id == input.camera_id)
        .ok_or_else(|| format!("相机未登记: {}", input.camera_id))?;
    let op = operator(&app, &state);
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
pub fn start_copy_task<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    input: StartCopyInput,
) -> CmdResult<CopyTaskDto> {
    if input.destinations.is_empty() {
        return Err("至少需要一个目的地".into());
    }
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &input.project_id)?;
    let load = registry::load(&nas).map_err(err)?;
    notice_registry_health(&app, &load);
    let reg = load.registry;
    let camera = reg
        .cameras
        .iter()
        .find(|c| c.id == input.camera_id)
        .ok_or_else(|| format!("相机未登记: {}", input.camera_id))?;

    let source_root = PathBuf::from(&input.volume_id);
    let files = copy::scan_source(&source_root).map_err(err)?;
    // 零静默:扫描跳过的符号链接必须让用户知道(链接目标不会被拷贝)
    let symlinks_skipped = copy::take_scan_symlinks_skipped();
    if symlinks_skipped > 0 {
        notify::warn(
            &app,
            "copy-symlinks-skipped",
            format!("源卷上发现 {symlinks_skipped} 个符号链接,已跳过(链接目标不会被拷贝)"),
        );
    }
    if files.is_empty() {
        return Err("源卷上没有可拷贝的素材".into());
    }
    // 源必须是当前真实挂载的卷:这是后面写卡片指纹文件的前提
    // (codex 评审 12:不核实挂载点就写指纹,等于往任意目录塞文件)
    let mounted = volumes::list_volumes()
        .into_iter()
        .find(|v| v.mount_point == source_root);
    let volume_name = mounted
        .as_ref()
        .map(|v| v.name.clone())
        .unwrap_or_else(|| input.volume_id.clone());
    let op = operator(&app, &state);
    let mut m = manifest::CopyManifest::new("", &volume_name, &camera.code, &op, &input.note);
    m.tags = input.tags.clone();
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

    // 落盘路径本身也用归一形式,存储/展示/校验三者一致
    let dest_targets: Vec<PathBuf> = dest_targets.iter().map(|t| normalize_lexical(t)).collect();
    validate_copy_paths(&source_root, &dest_targets)?;
    check_existing_target(&dest_targets, input.confirm_existing_target)?;

    // 卡片指纹:身份随卡走。**全部路径校验通过后**才允许往卡上写文件;
    // 写保护/非挂载卷拿不到指纹要告知(退化为卷名匹配,零静默)
    let source_uid = if mounted.as_ref().is_some_and(|m| m.system) {
        // 系统盘不写指纹:create_storage_card 拒绑系统盘,这里保持同一道闸,
        // 否则拷贝路径能在 `/` 造出指纹文件让启动盘被认成登记卡(评审 P2)
        notify::warn(
            &app,
            "volume-uid-skipped",
            format!("源「{volume_name}」是系统内置盘,不在其上写身份指纹"),
        );
        None
    } else if mounted.is_some() {
        volumes::ensure_volume_uid(&source_root)
    } else {
        notify::warn(
            &app,
            "volume-uid-skipped",
            format!(
                "所选源「{volume_name}」不是当前挂载的卷,跳过身份指纹写入:中断后续传将按卷名匹配,同名卡存在误认风险"
            ),
        );
        None
    };
    if mounted.is_some() && source_uid.is_none() {
        notify::warn(
            &app,
            "volume-uid-unwritable",
            format!(
                "无法在卡「{volume_name}」上写入身份指纹(可能写保护):中断后续传将按卷名匹配,同名卡存在误认风险"
            ),
        );
    }
    m.source_uid = source_uid.clone();
    // 拷完自动转代理意图持久化(M3 T1.5:intent = manifest id,at-least-once 补投递)
    m.auto_proxy = input.auto_proxy && stats.meta.scenario == project::Scenario::A;

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
    // 持久化完整计划清单:续传/重建以它兜底,源文件消失必须被发现(复核 P0)
    m.planned = files
        .iter()
        .map(|(rel, size)| manifest::PlannedFile {
            rel_path: rel.clone(),
            size: *size,
        })
        .collect();
    manifest::save(&stats.root, &m).map_err(err)?;

    tasks::append_audit(
        &app,
        &stats.root,
        &state.config_dir,
        &journal::Event::new(
            state.machine_id.clone(),
            op.clone(),
            journal::kind::COPY_STARTED,
            serde_json::json!({
                "taskId": dto.id,
                "camera": camera.code,
                "volume": volume_name,
                "note": input.note,
                "tags": input.tags,
                "targetFolder": dto.target_folder,
            }),
        ),
    );

    // 用卡自动并入(UX 波三):这张卡真实用在了本项目上,清单跟着长——
    // 现场临时加卡不需要回头手改清单。折叠端按集合并入,重复事件无害。
    if let (Some(card_id), _) = match_card(&reg.cards, source_uid.as_deref(), &volume_name) {
        tasks::append_audit(
            &app,
            &stats.root,
            &state.config_dir,
            &journal::Event::new(
                state.machine_id.clone(),
                op,
                journal::kind::PROJECT_CARD_USED,
                serde_json::json!({ "cardId": card_id }),
            ),
        );
    }

    let handle = Arc::new(TaskHandle {
        pause_requested: AtomicBool::new(false),
        running: AtomicBool::new(false),
        snapshot: std::sync::Mutex::new(dto.clone()),
        project_root: stats.root.clone(),
        manifest_id: m.id.clone(),
        source_root: std::sync::Mutex::new(source_root),
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
pub fn resume_copy_task<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    task_id: String,
) -> CmdResult<()> {
    let handle = state
        .tasks
        .get(&task_id)
        .ok_or_else(|| format!("任务不存在: {task_id}"))?;

    if !handle.running.load(Ordering::SeqCst) {
        // 续传身份核对(评审 M10/P0-1)+ 按卷名重解析挂载点(复核必修 A:
        // 卡后插/换挂载口场景,插回原卡即可续传,无需重启应用)
        let m = manifest::load(&handle.project_root, &handle.manifest_id).map_err(err)?;
        // R2 P0:持久化清单是外部可篡改输入——任何非法相对路径(`..`/绝对/空段)
        // 都说明清单损坏或被篡改,整单拒绝续传(fail-closed,可见报错),
        // 绝不静默丢弃单条(丢弃=静默漏拷)。闸在卷重解析之前:清单坏了就该
        // 直说,不能先让用户「插回原卡」再报废(R3-F2:也让闸不依赖挂载环境)。
        if let Some(bad) = m
            .planned
            .iter()
            .find(|p| !crate::core::paths::is_safe_rel(&p.rel_path))
        {
            return Err(err(format!(
                "任务清单损坏或被篡改(非法相对路径 {:?}),拒绝续传;请重新发起拷贝",
                bad.rel_path
            )));
        }
        // 只看可移动卷:系统盘永远在场,混进来会让「没有检测到可移动卷」
        // 分支永不可达,报文失真(复验 18)
        let vols: Vec<(PathBuf, String)> = volumes::removable_volumes()
            .into_iter()
            .map(|v| (v.mount_point, v.name))
            .collect();
        let recorded = handle.source_root.lock().unwrap().clone();
        // 重解析 + 布局复核一体(codex 终验 P0:重插的卡可能挂到某目的地的
        // 祖先路径,不复核会把素材写回源卡);同时覆盖旧 manifest 的病态目的地。
        let resolved = tasks::prepare_resume(
            &recorded,
            &m.source_label,
            m.source_uid.as_deref(),
            &vols,
            &handle.dest_targets,
            &|p| volumes::read_volume_uid(p),
        )?;
        {
            let mut src = handle.source_root.lock().unwrap();
            *src = resolved.clone();
        }
        {
            let mut snap = handle.snapshot.lock().unwrap();
            snap.volume_id = resolved.display().to_string();
        }
        // 刷新清单:源卡内容可能在暂停期间变化,快照与引擎必须消费同一份新清单。
        // 与持久化的计划清单取并集:计划内但已从源消失的文件必须进清单
        // (引擎会因打不开源文件将其记为失败,绝不静默漏拷,复核 P0)。
        // (planned 的合法性已在上方 manifest 加载后整单校验。)
        let mut files = copy::scan_source(&resolved).map_err(err)?;
        let symlinks_skipped = copy::take_scan_symlinks_skipped();
        if symlinks_skipped > 0 {
            notify::warn(
                &app,
                "copy-symlinks-skipped",
                format!("源卷上发现 {symlinks_skipped} 个符号链接,已跳过(链接目标不会被拷贝)"),
            );
        }
        for p in &m.planned {
            if !files.iter().any(|(rel, _)| rel == &p.rel_path) {
                files.push((p.rel_path.clone(), p.size));
            }
        }
        files.sort();
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
pub fn rebuild_tasks<R: tauri::Runtime>(app: &AppHandle<R>, state: &AppState) {
    // 经统一入口:配置损坏/权限错误也要上报(codex 六轮:此处曾漏)
    let Some(nas) = load_config(app, state).nas_root else {
        return;
    };
    let scan = match catalog::scan_cached(&nas) {
        Ok(s) => s,
        Err(e) => {
            notify::warn(
                app,
                "rebuild-scan-failed",
                format!("启动时扫描项目失败,未完成的拷卡任务未能重建: {e}"),
            );
            return;
        }
    };
    notice_catalog_warnings(app, &scan.warnings);
    let projects = scan.projects;
    let vols = volumes::list_volumes();
    for p in projects {
        let list = match manifest::list(&p.root) {
            Ok(l) => l,
            Err(_) => {
                notify::warn(
                    app,
                    "rebuild-manifest-unreadable",
                    format!(
                        "项目「{}」的拷卡清单不可读,其中未完成任务未能重建",
                        p.folder_name
                    ),
                );
                continue;
            }
        };
        if list.skipped > 0 {
            notify::warn(
                app,
                "rebuild-manifest-corrupt",
                format!(
                    "项目「{}」有 {} 份拷卡清单损坏,对应任务未能重建",
                    p.folder_name, list.skipped
                ),
            );
        }
        for m in list.manifests.into_iter().filter(|m| !m.completed) {
            // 归一后再用:旧 manifest 可能携带 `..` 等病态目的地字符串(codex 终验 #6);
            // 续传时还会经 validate_dest_layout 与重绑后的源做嵌套复核
            let dest_targets: Vec<PathBuf> = m
                .destinations
                .iter()
                .map(|d| normalize_lexical(Path::new(d)))
                .collect();
            if dest_targets.is_empty() {
                // 零静默:旧格式清单缺目的地记录,无法重建必须告知
                notify::warn(
                    app,
                    "rebuild-legacy-manifest",
                    format!(
                        "项目「{}」的任务「{}」为旧格式清单(无目的地记录),无法自动续传;重新发起拷卡即可,不会覆盖已有素材",
                        p.folder_name, m.target_rel
                    ),
                );
                continue;
            }
            // 源卷按卷名匹配当前挂载;找不到则置空,续传时会要求插回原卡
            let source_root = vols
                .iter()
                .find(|v| v.name == m.source_label)
                .map(|v| v.mount_point.clone())
                .unwrap_or_default();
            // 重建以完整计划清单为准(entries 只含已处理过的文件,复核 P0);
            // 旧格式 manifest 无 planned 时退回 entries
            let files: Vec<CopyFileItemDto> = if m.planned.is_empty() {
                m.entries
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
                    .collect()
            } else {
                m.planned
                    .iter()
                    .map(|p| CopyFileItemDto {
                        id: p.rel_path.clone(),
                        path: p.rel_path.clone(),
                        name: p
                            .rel_path
                            .rsplit('/')
                            .next()
                            .unwrap_or(&p.rel_path)
                            .to_string(),
                        size_bytes: p.size,
                        status: if m.is_done(&p.rel_path, p.size) {
                            "verified"
                        } else {
                            "pending"
                        },
                        hash: None,
                        error: None,
                        targets: None,
                    })
                    .collect()
            };
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
                tags: m.tags.clone(),
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
                // 以重建出的完整清单为准(终验缺陷 #2:entries 之和会让早停任务进度虚高)
                total_bytes: files.iter().map(|f| f.size_bytes).sum(),
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
                source_root: std::sync::Mutex::new(source_root),
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
pub fn retry_copy_file<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    task_id: String,
    _file_id: String,
) -> CmdResult<()> {
    resume_copy_task(app, state, task_id)
}
