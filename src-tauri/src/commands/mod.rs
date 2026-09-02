//! Tauri 命令层:实现 `src/api/index.ts` 里标注的全部 invoke 契约。
//! 错误统一映射为字符串消息(前端 toast 展示)。
//!
//! ## 命令一律 `#[tauri::command(async)]`
//! Tauri v2 的同步命令跑在**主线程**:任何 NAS/磁盘 IO(statfs 在半死的
//! SMB/NFS 挂载上会无限期阻塞)都会把整个 UI 冻成「未响应」,GTK 主循环
//! 饿死后 WebKit 合成状态错乱还可能直接 SEGV(Arch 实机 coredump)。
//! `(async)` 让同步签名的命令在独立任务上执行,主线程只做 UI。
//! 新增命令必须沿用 `(async)`,除非确有主线程需求并写明原因。

pub mod analysis_cmds;
pub mod diag_cmds;
pub mod dto;
pub mod finalcut_cmds;
#[cfg(all(test, not(windows)))]
mod integration_tests;
pub mod notify;
pub mod preview_cmds;
pub mod preview_proto;
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
    /// 双确认屏批准过的计划快照(见 [`ApprovedPlans`])。
    pub approved_plans: ApprovedPlans,
    /// 全屏预览的全尺寸取图缓存(本机、有界 LRU,见 [`crate::core::preview::PreviewCache`])。
    /// 放进 AppState 是因为 `preview://` 协议处理器也要问它「缓存目录在哪」。
    pub preview_cache: std::sync::Arc<crate::core::preview::PreviewCache>,
}

/// 最多留几份批准过的计划(用户来回改勾选会连着拉好几次计划,只有最后一份会被批准)。
///
/// R13 C5:这条上限只是**兜底**。正常淘汰按「确认页实例 id」替换 + TTL,
/// 否则五个确认页并发规划时,较旧的那次大扫描晚完成,会按「全局完成顺序」
/// 把当前正开着的那份计划挤掉——用户还在看着确认屏,快照已经没了。
const APPROVED_PLAN_SLOTS: usize = 16;
/// 快照的存活时长。确认屏开着不动一整天之后再提交,那份计划早就不该被信任了;
/// 到点淘汰也让被遗忘的槽位不会一直占着。
const APPROVED_PLAN_TTL: std::time::Duration = std::time::Duration::from_secs(30 * 60);
/// 单份计划超过这么多文件就只记令牌、不记明细(几十万文件的卡不该把内存吃掉)。
/// 记不下明细这件事会在报错里明说,不静默降级。
const APPROVED_PLAN_MAX_FILES: usize = 50_000;

/// 双确认屏批准过的计划快照(按 `planDigest` 存;仅进程内,不落盘)。
///
/// 存在的**唯一**理由:`start_copy_task` 发现令牌对不上时要说清「到底哪儿变了」。
/// 只靠摘要分段只能说出「哪一类变了」,说不出「多了哪几个文件」「是哪几个被改动
/// 过」——而这两句话指向完全不同的排查方向(去数卡上的文件 vs 去查是谁动了源),
/// 说错原因比不说更糟。
///
/// 有界:最多 [`APPROVED_PLAN_SLOTS`] 份 + [`APPROVED_PLAN_TTL`] 到期淘汰,
/// 单份超过 [`APPROVED_PLAN_MAX_FILES`] 只记令牌不记明细。
/// 查不到明细时报文会**明说**查不到,不会假装说得出。
#[derive(Default)]
pub struct ApprovedPlans {
    /// 队首最旧
    slots: std::sync::Mutex<std::collections::VecDeque<ApprovedSnapshot>>,
}

/// 一份批准过的计划的快照。
#[derive(Clone)]
pub struct ApprovedSnapshot {
    pub digest: String,
    /// 确认那一刻的卷身份原串(见 `volume_identity`)。留着它才说得出
    /// 「卷身份为什么变了」——尤其是「指纹是 OCard 自己后写上去的」这一种。
    pub volume_identity: String,
    /// 确认那一刻**规范化后**的源选择(`copy::normalized_selection`)。
    /// R13 C1:选择独占摘要一段之后,「勾选范围对不上」要能逐条点名到底差在哪。
    pub selection: Vec<String>,
    /// `None` = 当时文件数超上限,没留逐条明细
    pub files: Option<Vec<copy::PlannedFile>>,
    /// 发出这份计划的确认页实例 id(前端传;老客户端不传 = None)。
    /// 有它才能按「同一个确认页的新一份计划替换旧一份」淘汰,而不是按全局顺序。
    pub instance_id: Option<String>,
    /// 记下的时刻(TTL 用)。
    pub remembered_at: std::time::Instant,
}

/// 回忆一份批准过的计划的结果。三种情形的报文措辞必须不同——
/// 「没留明细」和「没这份令牌」是两回事。
pub enum RecalledPlan {
    /// 找到了确认时的那份计划,可以逐条对比
    Found(ApprovedSnapshot),
    /// 记得这个令牌,但当时文件数超过上限,没留逐条明细
    TooLargeToKeep(ApprovedSnapshot),
    /// 没有这个令牌(应用重启过,或中间又拉了好几次计划把它挤掉了)
    Forgotten,
}

impl RecalledPlan {
    fn snapshot(&self) -> Option<&ApprovedSnapshot> {
        match self {
            Self::Found(s) | Self::TooLargeToKeep(s) => Some(s),
            Self::Forgotten => None,
        }
    }
}

impl ApprovedPlans {
    /// 记下一份刚返回给双确认屏的计划。
    ///
    /// 淘汰顺序(R13 C5):① 过期的先丢;② 同一个确认页实例的旧计划被新计划
    /// **替换**——用户在一个确认屏上来回改勾选只该占一个槽,不该把别的确认屏
    /// 挤掉;③ 兜底才按最旧丢。此前只有 ③,于是五个确认页并发规划时,较旧的
    /// 那次大扫描晚完成就会挤掉当前可见的计划。
    pub fn remember(
        &self,
        digest: &str,
        volume_identity: &str,
        selection: &[String],
        plan: &[copy::PlannedFile],
        instance_id: Option<&str>,
    ) {
        let snap = ApprovedSnapshot {
            digest: digest.to_string(),
            volume_identity: volume_identity.to_string(),
            selection: selection.to_vec(),
            files: (plan.len() <= APPROVED_PLAN_MAX_FILES).then(|| plan.to_vec()),
            instance_id: instance_id.map(str::to_string),
            remembered_at: std::time::Instant::now(),
        };
        let mut slots = self.slots.lock().unwrap();
        let now = std::time::Instant::now();
        slots.retain(|s| now.duration_since(s.remembered_at) < APPROVED_PLAN_TTL);
        // 同一份计划被反复拉取时只留一份(前端进确认屏可能重复调用)
        slots.retain(|s| s.digest != digest);
        // 同一个确认页实例的上一份计划:替换,不占新槽
        if let Some(id) = instance_id {
            slots.retain(|s| s.instance_id.as_deref() != Some(id));
        }
        slots.push_back(snap);
        while slots.len() > APPROVED_PLAN_SLOTS {
            slots.pop_front();
        }
    }

    /// 按令牌回忆。**不取走**:同一个令牌可能被连着提交两次(用户重试),
    /// 第二次也该拿到同样的说明。过期的一律当作没有(措辞与被挤掉的一致:
    /// 两者都只能给泛化原因)。
    pub fn recall(&self, digest: &str) -> RecalledPlan {
        let slots = self.slots.lock().unwrap();
        let now = std::time::Instant::now();
        match slots
            .iter()
            .find(|s| s.digest == digest && now.duration_since(s.remembered_at) < APPROVED_PLAN_TTL)
        {
            Some(s) if s.files.is_some() => RecalledPlan::Found(s.clone()),
            Some(s) => RecalledPlan::TooLargeToKeep(s.clone()),
            None => RecalledPlan::Forgotten,
        }
    }
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn get_project<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    project_id: String,
) -> CmdResult<Option<ProjectDto>> {
    Ok(list_projects(app, state)?
        .into_iter()
        .find(|p| p.id == project_id))
}

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn list_cameras<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
) -> CmdResult<Vec<registry::CameraReg>> {
    let load = registry::load(&nas_root(&app, &state)?).map_err(err)?;
    notice_registry_health(&app, &load);
    Ok(load.registry.cameras)
}

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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
#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn inspect_volume<R: tauri::Runtime>(
    app: AppHandle<R>,
    volume_id: String,
) -> CmdResult<VolumeInspectionDto> {
    // R13 D1:源卷必须解析到权威卷清单,口径与另外三个入口
    // (`list_source_folders` / `plan_source_selection` / `start_copy_task`)一致。
    // 少这道闸,任意可读目录都能当源:递归扫描卡外的目录树,并把文件数、容量、
    // 时间范围原样返回给调用方。
    let root = ensure_source_volume(&volume_id)?;
    let scanned = copy::scan_source(&root);
    // R10:失败出口也要取走计数并告警——计数留着会算到下一次操作头上,报数失真
    notice_scan_skips(&app);
    let files = scanned.map_err(err)?;
    let total_bytes = files.iter().map(|f| f.size).sum();

    // EXIF 拍摄时间优先(M2 技术债:mtime 会因拷贝/修复时间戳失真);
    // 大卡按步长采样(≤300 个样本)控制 EXIF 解析耗时
    let mut earliest: Option<chrono::DateTime<Utc>> = None;
    let mut latest: Option<chrono::DateTime<Utc>> = None;
    let step = files.len().div_ceil(300).max(1); // 向上取整:301-599 个也只采 ≤300 样本
    for (i, f) in files.iter().enumerate() {
        if i % step != 0 {
            continue;
        }
        let p: PathBuf = f.rel.split('/').fold(root.clone(), |acc, c| acc.join(c));
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

// ---------- 源文件夹多选 ----------

/// 测试用的「额外可信卷」。生产构建里这段整体不存在(`cfg(test)`),
/// 只是让集成测试能拿一个临时目录当卡跑真实命令链路——不是给生产留后门。
#[cfg(test)]
pub(crate) static TEST_EXTRA_VOLUMES: std::sync::Mutex<Vec<PathBuf>> =
    std::sync::Mutex::new(Vec::new());

/// 测试里把一个临时目录登记成「插着的卡」,离开作用域自动摘除。
#[cfg(test)]
pub(crate) struct TestVolumeGuard(PathBuf);

#[cfg(test)]
impl TestVolumeGuard {
    pub(crate) fn mount(p: &Path) -> Self {
        TEST_EXTRA_VOLUMES.lock().unwrap().push(p.to_path_buf());
        Self(p.to_path_buf())
    }
}

#[cfg(test)]
impl Drop for TestVolumeGuard {
    fn drop(&mut self) {
        let mut v = TEST_EXTRA_VOLUMES.lock().unwrap();
        if let Some(i) = v.iter().position(|p| p == &self.0) {
            v.remove(i);
        }
    }
}

/// 当前可作为拷卡源的权威卷清单。
fn known_source_volumes() -> Vec<volumes::VolumeInfo> {
    #[allow(unused_mut)]
    let mut list = volumes::list_volumes();
    #[cfg(test)]
    for p in TEST_EXTRA_VOLUMES.lock().unwrap().iter() {
        list.push(volumes::VolumeInfo {
            name: p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            mount_point: p.clone(),
            removable: true,
            system: false,
            total_bytes: 0,
            available_bytes: 0,
            file_system: "test".into(),
        });
    }
    list
}

/// 源卷解析闸。返回权威挂载点。
///
/// R9:此前只检查「是不是个文件夹」,于是 `list_source_folders` /
/// `plan_source_selection` 接受**任意可读目录**当 volumeId——能读到卡外的
/// 目录树、文件计数与部分文件名。拷贝本身另有 `validate_copy_paths` 兜底,
/// 但读取边界已经越过,报错也不准。先解析到权威卷清单再谈可达性。
///
/// 零静默:卷不在清单/不存在/挂载点半死/没权限必须各说各的,
/// 绝不吞成空列表——用户会把「列不出来」读成「卡是空的」。
pub(crate) fn ensure_source_volume(volume_id: &str) -> CmdResult<PathBuf> {
    let want = normalize_lexical(Path::new(volume_id));
    let Some(vol) = known_source_volumes()
        .into_iter()
        .find(|v| normalize_lexical(&v.mount_point) == want)
    else {
        // 先把「路径根本不存在」与「存在但不是挂载卷」分开说,否则用户
        // 对着一个明明能在访达里打开的目录看「不在挂载卷列表中」会一头雾水
        return Err(match std::fs::metadata(&want) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                format!("源卷不存在或已被拔出: {}", want.display())
            }
            _ => format!(
                "所选源不是当前挂载的存储卷,拒绝作为拷卡源读取: {}。请在卷列表里选择真实插着的卡",
                want.display()
            ),
        });
    };
    let root = vol.mount_point;
    match std::fs::metadata(&root) {
        Ok(m) if m.is_dir() => Ok(root),
        Ok(_) => Err(format!("源卷路径不是文件夹: {}", root.display())),
        Err(e) => Err(match e.kind() {
            std::io::ErrorKind::NotFound => {
                format!("源卷不存在或已被拔出: {}", root.display())
            }
            std::io::ErrorKind::PermissionDenied => format!(
                "没有访问源卷的权限,请在系统的隐私/磁盘访问设置中授权 OCard 后重试: {}",
                root.display()
            ),
            _ => format!(
                "源卷不可访问(挂载点可能已断开,建议重新插拔存储卡): {} — {e}",
                root.display()
            ),
        }),
    }
}

/// `parse_selection` 的产物:规范化后的选择 + 需要向用户点名的告警。
pub(crate) struct ParsedSelection {
    pub selection: copy::SourceSelection,
    /// 折叠后同名(大小写/NFC)的分组描述,供命令层发可见告警。
    pub aliases: Vec<String>,
}

/// 把前端传来的文件夹列表转成引擎口径的选择。空 = 整卷(契约)。
/// 每一项都要过相对路径闸:空串(卷根)放行,其余必须是安全相对路径——
/// `../` 之类等于让拷贝去读卡外的东西。
///
/// R1:去重**只按字节完全相同**。此前按目的地的大小写口径(`fold_key`)给
/// **源侧**选择去重,源卷大小写敏感时(大小写敏感 APFS / Linux ext4 导出 /
/// 部分 SMB·NFS / 磁盘映像)`DCIM` 与 `dcim` 是两个真实存在的不同目录,
/// `list_source_folders` 会两条都列出来让用户勾——勾了之后第二个被**无声丢弃**,
/// 漏拷却报 all_verified。`scan_selection` 里的 `files.sort(); files.dedup()`
/// 已按真实 rel 天然收敛,字节重复项本来就安全,不需要请求层再裁一刀。
///
/// 折叠后同名的两项仍然保留(不合并),但要点名告警:源卷若其实大小写不敏感,
/// 这两项会扫出同一批文件,用户有权在开拷前知道。
fn parse_selection(folders: &[String]) -> CmdResult<ParsedSelection> {
    let mut clean: Vec<String> = Vec::with_capacity(folders.len());
    for f in folders {
        if !f.is_empty() && !crate::core::paths::is_safe_rel(f) {
            return Err(format!("文件夹路径非法,拒绝执行: {f}"));
        }
        if !clean.iter().any(|c| c == f) {
            clean.push(f.clone());
        }
    }
    // 折叠同名分组(≥2 项才报):只告警,绝不静默合并
    let mut aliases: Vec<String> = Vec::new();
    let mut seen: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for f in &clean {
        seen.entry(copy::target_name_key(f))
            .or_default()
            .push(if f.is_empty() {
                "卡根目录".to_string()
            } else {
                f.clone()
            });
    }
    let mut groups: Vec<Vec<String>> = seen.into_values().filter(|g| g.len() > 1).collect();
    groups.sort();
    for g in groups {
        aliases.push(g.join("、"));
    }
    Ok(ParsedSelection {
        selection: copy::SourceSelection::from_folders(clean),
        aliases,
    })
}

/// 折叠同名的源文件夹选择告警(零静默:不合并,但必须点名)。
fn notice_selection_aliases<R: tauri::Runtime>(app: &AppHandle<R>, aliases: &[String]) {
    if aliases.is_empty() {
        return;
    }
    notify::warn(
        app,
        "source-folders-case-alias",
        format!(
            "勾选里有 {} 组只差大小写(或 Unicode 写法)的文件夹({}):它们会各扫一遍。若这张卡的文件系统大小写不敏感,同一批文件会被规划两次并因撞名被加前缀——请确认这是你要的",
            aliases.len(),
            aliases.join(" / ")
        ),
    );
}

/// 扫描期被跳过条目的聚合告警:符号链接 + 明确列举的系统项。
///
/// **每一个**扫描出口(含失败出口)都必须调用:计数是按线程累计的,不取走
/// 就会算到下一次操作头上,报数失真(`copy::take_scan_symlinks_skipped`
/// 自己的文档也点名了这条不变式)。
fn notice_scan_skips<R: tauri::Runtime>(app: &AppHandle<R>) {
    let n = copy::take_scan_symlinks_skipped();
    if n > 0 {
        notify::warn(
            app,
            "copy-symlinks-skipped",
            format!("源卷上发现 {n} 个符号链接,已跳过(链接目标不会被拷贝)"),
        );
    }
    let (skipped, samples) = copy::take_scan_system_skipped();
    if skipped > 0 {
        // R11:排除口径已收紧成明确列举的系统项(`.Trashes`/`System Volume
        // Information` 之类),点开头的素材不再被误伤。即便如此,排除了什么也必须
        // 报到用户面前:配上「100% 完成 → 可格式化」这句话,静默排除就是引导
        // 用户格式化掉没备份的东西。
        //
        // 通知码沿用 `copy-hidden-skipped`(与前端契约字段 `hiddenSkipped` 同源,
        // 改名会当场打断并行开发的前端);文案按新语义重写。
        //
        // R13 A1:措辞只能陈述**判据**(「命中系统项名单」),不能替名单打包票说
        // 「这些都不是素材」——名单一旦写宽(`.ocard` 那条前缀就是),这句断言会
        // 把真素材说成垃圾。样例超过 5 条时点不全名,更不该把没点到的也一并断言。
        let more = (samples.len() as u64) < skipped;
        notify::warn(
            app,
            "copy-hidden-skipped",
            format!(
                "源卷上有 {skipped} 个条目命中了系统项名单(废纸篓、索引、`.DS_Store`、NAS 记账目录等),不在本次范围内:{}{}。点开头的素材(如 .clip.mov)会照常拷贝;{}",
                samples.join("、"),
                if more { " 等" } else { "" },
                if more {
                    "样例只列前几条,若你怀疑其中有真素材,请对照卡上的完整列表核对后再决定是否格式化"
                } else {
                    "若这里面有你要的素材,请核对后再决定是否格式化"
                }
            ),
        );
    }
}

/// 目标夹里已存在同名文件的可见告警(不阻断:引擎对同内容复用、异内容拒覆盖,
/// 但用户有权在开拷**之前**就知道这次会碰上哪些已有文件)。
///
/// R6 两处:
/// - 读目标夹失败**只有 `NotFound` 能解释成「还没创建」**。此前 `let Ok(..) else
///   { continue }` 把「NAS 断了 / 无权限」也吞成「没有可撞的东西」,而扁平化模式下
///   这条预警恰恰是最该有的——必须在开拷前返回 Err。
/// - 撞名判定改 `HashSet`:此前 `clashes.contains(&..)` 是 Vec 线性查找,重复拷进
///   同一目标夹时每个文件都撞名,5 万文件 = 十亿量级比较,而本函数在起 worker
///   **之前同步跑**,UI 会卡死几十秒。
pub(crate) fn notice_target_name_clashes<R: tauri::Runtime>(
    app: &AppHandle<R>,
    plan: &[copy::PlannedFile],
    dest_targets: &[PathBuf],
) -> CmdResult<()> {
    let mut clashes: Vec<String> = Vec::new(); // 保序,消息里的样例稳定
    let mut clashed: std::collections::HashSet<String> = std::collections::HashSet::new();
    for d in dest_targets {
        let entries = match std::fs::read_dir(d) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue, // 还没创建
            Err(e) => {
                return Err(format!(
                "无法读取目标夹,拒绝开拷(读不到就没法在开拷前告诉你会撞上哪些同名文件): {} — {e}",
                d.display()
            ))
            }
        };
        let mut existing: std::collections::HashSet<String> = std::collections::HashSet::new();
        for entry in entries {
            let entry = entry.map_err(|e| {
                format!(
                    "读取目标夹条目失败,拒绝开拷(目录可能在读的过程中断开): {} — {e}",
                    d.display()
                )
            })?;
            existing.insert(copy::target_name_key(&entry.file_name().to_string_lossy()));
        }
        for p in plan {
            // 只看扁平落点(整卷带层级的落点由目录结构天然隔开)
            if !p.target_rel.contains('/')
                && existing.contains(&copy::target_name_key(&p.target_rel))
                && clashed.insert(p.target_rel.clone())
            {
                clashes.push(p.target_rel.clone());
            }
        }
    }
    if clashes.is_empty() {
        return Ok(());
    }
    let shown: Vec<&str> = clashes.iter().take(5).map(|s| s.as_str()).collect();
    notify::warn(
        app,
        "copy-target-name-clash",
        format!(
            "目标夹里已有 {} 个同名文件({}{}):内容相同会直接复用,内容不同会在拷到它时报冲突并停在该文件上——请确认这次拷的不是另一张卡的同名素材",
            clashes.len(),
            shown.join("、"),
            if clashes.len() > shown.len() { " 等" } else { "" }
        ),
    );
    Ok(())
}

/// 列出源卷里可勾选的文件夹(含卷根)。勾选后只拷该文件夹的直接子文件。
#[tauri::command(async)]
pub fn list_source_folders<R: tauri::Runtime>(
    app: AppHandle<R>,
    volume_id: String,
) -> CmdResult<Vec<SourceFolderDto>> {
    let root = ensure_source_volume(&volume_id)?;
    let listed = copy::list_source_folders(&root);
    notice_scan_skips(&app);
    let (folders, unreadable) = listed.map_err(err)?;
    // 零静默:读不动的子目录被跳过了,必须逐条报出来——否则用户看到的
    // 文件夹列表是残缺的,而他不会知道
    if !unreadable.is_empty() {
        let names: Vec<&str> = unreadable
            .iter()
            .take(5)
            .map(|u| u.rel_path.as_str())
            .collect();
        notify::warn(
            &app,
            "source-folders-unreadable",
            format!(
                "源卷上有 {} 个目录读不动,已从列表中跳过(这些目录里的文件不会被拷贝): {}{} — 首个原因: {}",
                unreadable.len(),
                names.join("、"),
                if unreadable.len() > names.len() {
                    " 等"
                } else {
                    ""
                },
                unreadable[0].reason
            ),
        );
    }
    Ok(folders
        .into_iter()
        .map(|f| SourceFolderDto {
            rel_path: f.rel_path,
            file_count: f.file_count,
            total_bytes: f.total_bytes,
            has_subfolders: f.has_subfolders,
        })
        .collect())
}

/// 规划一次源选择:这次到底要拷多少、有谁会被改名(双确认屏用)。
/// `folders` 为空 = 整卷(整卷保留原层级,不会撞名,`renamed_files` 恒为空)。
#[tauri::command(async)]
pub fn plan_source_selection<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    volume_id: String,
    folders: Vec<String>,
    confirm_instance_id: Option<String>,
) -> CmdResult<SourcePlanDto> {
    let root = ensure_source_volume(&volume_id)?;
    let parsed = parse_selection(&folders)?;
    notice_selection_aliases(&app, &parsed.aliases);
    let selection = parsed.selection;
    // R13 C2(P0):**在算令牌之前**把计划绑到一块物理介质上。
    // 此前 UID 是在 `start_copy_task` 的摘要比对**之后**才创建的,于是确认时的卡 A
    // 根本没有 UID:随后换成同卷名、同挂载点、文件元数据也相同的另一张未标记的卡 B,
    // 三段摘要一字不差,B 会按 A 的批准直接开跑。绑定失败时**不得宣称**绑定完成
    // ——告警与后续诊断措辞都必须是不确定的(见 `why_volume_differs`)。
    bind_medium_identity(&app, &root);
    let scanned = copy::scan_selection(&root, &selection);
    let (hidden_skipped, hidden_samples) = peek_skipped_for_dto();
    notice_scan_skips(&app);
    let (plan, renamed, total_bytes) = scanned.map_err(err)?;
    // R5:用户在双确认屏批准的是**这一份**计划;`start_copy_task` 重扫后
    // 必须比对同一个摘要,不一致就退回重新确认(知情同意,不自动重试)
    let identity = volume_identity(&root);
    let plan_digest = copy::plan_digest(&selection, &plan, &identity);
    // R11:留一份快照(计划 + 卷身份原串 + 规范化选择),好让「令牌对不上」时
    // 能说清到底哪儿变了
    state.approved_plans.remember(
        &plan_digest,
        &identity,
        &copy::normalized_selection(&selection),
        &plan,
        confirm_instance_id.as_deref(),
    );
    Ok(SourcePlanDto {
        file_count: plan.len(),
        total_bytes,
        renamed_files: renamed
            .into_iter()
            .map(|r| RenamedFileDto {
                source_rel: r.source_rel,
                target_rel: r.target_rel,
            })
            .collect(),
        hidden_skipped,
        hidden_samples,
        plan_digest,
    })
}

/// 把「这次规划/这次拷贝」绑到一块**物理介质**上:取得(必要时创建)卡根的
/// `.ocard-volume-id`。返回 `Some(uid)` = 绑定成功。
///
/// R13 C2(P0):绑定必须发生在**返回计划之前**,不能等到摘要比对之后。
/// 卷名 + 挂载点 + 文件元数据都可以在两张卡之间完全一致,只有指纹是随介质走的;
/// 没有它,「这是你确认时那张卡」这句话就没有任何证据。
///
/// 零静默 + 不许自吹:拿不到指纹时**如实告警**说明降级后果,并且绝不在任何地方
/// 宣称完成了介质绑定(诊断措辞见 `why_volume_differs`)。
/// - 系统内置盘不写(与 `create_storage_card` 同一道闸:在 `/` 造出指纹文件会让
///   启动盘被认成登记卡);
/// - 不在挂载列表里的卷不写(不核实挂载点就写 = 往任意目录塞文件)。
fn bind_medium_identity<R: tauri::Runtime>(app: &AppHandle<R>, root: &Path) -> Option<String> {
    let mounted = known_source_volumes()
        .into_iter()
        .find(|v| normalize_lexical(&v.mount_point) == normalize_lexical(root));
    let label = mounted
        .as_ref()
        .map(|v| v.name.clone())
        .unwrap_or_else(|| root.display().to_string());
    match &mounted {
        Some(v) if v.system => {
            notify::warn(
                app,
                "volume-uid-skipped",
                format!(
                    "源「{label}」是系统内置盘,不在其上写身份指纹:本次计划**没有**绑定到具体介质,\
                     确认与开拷之间换了盘将无法被发现"
                ),
            );
            None
        }
        Some(_) => {
            let uid = volumes::ensure_volume_uid(root);
            if uid.is_none() {
                notify::warn(
                    app,
                    "volume-uid-unwritable",
                    format!(
                        "无法在卡「{label}」上写入身份指纹(可能写保护):本次计划**没有**绑定到具体介质,\
                         确认与开拷之间换成同卷名的另一张未标记的卡将无法被发现;中断后续传也只能按卷名匹配"
                    ),
                );
            }
            uid
        }
        None => {
            notify::warn(
                app,
                "volume-uid-skipped",
                format!(
                    "所选源「{label}」不是当前挂载的卷,跳过身份指纹写入:本次计划**没有**绑定到具体介质;\
                     中断后续传将按卷名匹配,同名卡存在误认风险"
                ),
            );
            None
        }
    }
}

/// 摘要里的卷身份:挂载点 + 卷名 + 卡指纹。
/// 换卡(哪怕挂到同一个挂载点、连文件列表都碰巧一样)必须让摘要变化。
fn volume_identity(root: &Path) -> String {
    let name = known_source_volumes()
        .into_iter()
        .find(|v| normalize_lexical(&v.mount_point) == normalize_lexical(root))
        .map(|v| v.name)
        .unwrap_or_default();
    let uid = volumes::read_volume_uid(root).unwrap_or_default();
    format!("{}\u{0}{name}\u{0}{uid}", root.display())
}

/// 取本线程扫描期排除的系统项(**不清零**:随后的 `notice_scan_skips`
/// 才负责取走并告警,DTO 这里只是顺带把同一组数字带给双确认屏)。
fn peek_skipped_for_dto() -> (u64, Vec<String>) {
    let taken = copy::take_scan_system_skipped();
    copy::restore_scan_system_skipped(taken.clone());
    taken
}

// ---------- 拷卡任务 ----------

#[tauri::command(async)]
pub fn list_copy_tasks(state: State<AppState>, project_id: Option<String>) -> Vec<CopyTaskDto> {
    state.tasks.snapshots(project_id.as_deref())
}

#[tauri::command(async)]
pub fn get_copy_task(state: State<AppState>, task_id: String) -> Option<CopyTaskDto> {
    state
        .tasks
        .get(&task_id)
        .map(|h| tasks::summary_of(&h.snap()))
}

#[tauri::command(async)]
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
    let snap = handle.snap();
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
    let known = known_source_volumes();
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
///
/// R6:读不动**不等于**空。只有 `NotFound` 能解释成「还没创建」,其余
/// (NAS 断了 / 无权限)此前被 `unwrap_or(false)` 吞成「空目录」,直接跳过这道
/// 人工确认闸。读不动就当场报错——这道闸的意义正是防同名重复拷卡。
/// 可读性一律先探(即使用户已确认继续),坏掉的目的地不该等写了清单才发现。
pub(crate) fn check_existing_target(dest_targets: &[PathBuf], confirmed: bool) -> CmdResult<()> {
    for t in dest_targets {
        let non_empty = match std::fs::read_dir(t) {
            Ok(mut d) => match d.next() {
                Some(Ok(_)) => true,
                None => false,
                Some(Err(e)) => {
                    return Err(format!(
                        "无法读取目标夹,拒绝开拷(读不到就没法判断是不是同名重复拷卡): {} — {e}",
                        t.display()
                    ))
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => {
                return Err(format!(
                    "无法读取目标夹,拒绝开拷(读不到就没法判断是不是同名重复拷卡): {} — {e}",
                    t.display()
                ))
            }
        };
        if non_empty && !confirmed {
            return Err(format!(
                "TARGET_EXISTS: 目标夹已存在且非空: {}。可能是同名重复拷卡;确认继续将只补缺失文件、绝不覆盖已有文件",
                t.display()
            ));
        }
    }
    Ok(())
}

/// 解析一次拷卡任务的真实落盘目标(不落任何盘)。供前端双确认屏展示真值(评审 H6/P1-6)。
#[tauri::command(async)]
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
    // 预览也走同一条规范化(路径闸在这里就该拒非法项),口径与 start 一致
    let parsed = parse_selection(&input.source_folders)?;
    let (dto, _) = tasks::build_task(
        &input,
        &stats.root,
        stats.meta.scenario,
        "",
        &camera.code,
        &op,
        &[],
        "preview",
        &parsed.selection.to_folders(),
    )
    .map_err(err)?;
    Ok(serde_json::json!({
        "targetFolder": dto.target_folder,
        "destinations": dto.destinations,
    }))
}

/// 「a、b、c 等 5 个」——数量给全,样例最多三条。
fn name_a_few(items: &[String]) -> String {
    const SHOWN: usize = 3;
    let shown: Vec<&str> = items.iter().take(SHOWN).map(|s| s.as_str()).collect();
    format!(
        "{} 个({}{})",
        items.len(),
        shown.join("、"),
        if items.len() > shown.len() {
            " 等"
        } else {
            ""
        }
    )
}

/// 「确认时那份计划没留下来」的两种不同说法(措辞必须分开:一个是内存被挤掉了,
/// 一个是当初就没留;含糊其辞会让用户以为工具在敷衍)。
fn no_detail_tail(recalled: &RecalledPlan) -> &'static str {
    match recalled {
        RecalledPlan::Found(_) => "",
        RecalledPlan::TooLargeToKeep(_) => {
            "(本次计划文件数超过上限,确认时未保留逐条明细,无法点名是哪几个)"
        }
        RecalledPlan::Forgotten => {
            "(确认时的那份计划已不在内存中——应用重启过,或中间又拉过好几次计划——无法点名是哪几个)"
        }
    }
}

/// 卷身份为什么变了。
///
/// 身份串是 `挂载点\0卷名\0卡指纹`(见 `volume_identity`)。**必须逐段说**:
/// 其中「指纹从无到有」这一种根本不是换卡——`start_copy_task` 自己会往卡上写
/// `.ocard-volume-id`,首拷失败后重试同一个令牌就会撞上它。这时候报「你换了一
/// 张卡」是彻头彻尾的假警报,会让人去翻读卡器而不是去看真正的失败原因。
///
/// R13 C5:**快照拿不到时不许扣具体帽子**。此前这里直接断言「不是同一张卡」,
/// 既没披露快照已被淘汰,也没有任何证据支撑那句话——摘要只能证明「卷身份段
/// 对不上」,而挂载点变了、卷名变了、指纹是 OCard 自己后写的,都会让那一段变。
fn why_volume_differs(recalled: &RecalledPlan, now: &str) -> String {
    let Some(then) = recalled.snapshot().map(|s| s.volume_identity.as_str()) else {
        return format!(
            "源卷的身份(挂载点 / 卷名 / 卡指纹)与你确认时那一份对不上。具体是哪一段变了无法判定{}——\
             既可能是换了卡或换了读卡器,也可能只是 OCard 在确认之后往卡上写了身份指纹。",
            no_detail_tail(recalled)
        );
    };
    let split = |s: &str| {
        let mut it = s.split('\u{0}');
        let mount = it.next().unwrap_or_default().to_string();
        let name = it.next().unwrap_or_default().to_string();
        let uid = it.next().unwrap_or_default().to_string();
        (mount, name, uid)
    };
    let (m0, n0, u0) = split(then);
    let (m1, n1, u1) = split(now);
    if u0.is_empty() && !u1.is_empty() && m0 == m1 && n0 == n1 {
        // R13 C2:这里**不能**断言「指纹是 OCard 写的、源卷没换」。
        // 规划时会先给卡创建指纹(见 `plan_source_selection`),`u0` 为空只可能是
        // 那一步**失败**了(写保护 / 卷不在挂载列表)——而失败时我们并没有拿到
        // 任何介质标识,所以现在卡上这个指纹到底是 OCard 后来写的,还是换上来的
        // 另一张已标记的卡自带的,**没有证据可以区分**。措辞必须留有余地。
        return "确认时读不到(也没能写上)这张卡的身份指纹,现在卡上有一个。\
                它可能是 OCard 在确认之后才写上去的,也可能是换上了另一张已经带指纹的卡——\
                当时没能完成介质绑定,两者无法区分。请重新确认前先核对插着的是不是同一张卡。"
            .to_string();
    }
    if !u0.is_empty() && u1.is_empty() {
        return "读不到源卷上的身份指纹了(卡可能被换成了另一张、或指纹文件被删)。".to_string();
    }
    if !u0.is_empty() && !u1.is_empty() && u0 != u1 {
        return "源卷不是你确认时的那一张卡:卡上的身份指纹变了(确实是另一张卡)。".to_string();
    }
    if m0 != m1 {
        return format!("源卷的挂载点变了(确认时是 {m0},现在是 {m1})——卡被重新挂载或换了读卡器。");
    }
    if n0 != n1 {
        return format!("源卷的卷名变了(确认时是「{n0}」,现在是「{n1}」)。");
    }
    // 三段逐段都相等、整串却不同:只可能是身份串的形态变了(工具自身的问题),
    // 这时候更不该扣「你换了卡」的帽子
    "源卷的身份串与确认时那一份对不上,但逐段比对不出差异(工具内部状态异常)。".to_string()
}

/// 令牌对不上时的人话报文。
///
/// R11:**原因必须说对**。「多了 3 个文件」和「有 2 个文件被改动过」指向完全不同
/// 的排查方向(去数卡上的文件 vs 去查是谁动了源文件),说错原因比不说更糟。
/// 三类原因的处置都是退回双确认屏重新确认,但说法必须各是各的。
///
/// 定性来自摘要分段(总是拿得到),明细来自 [`ApprovedPlans`] 里那份批准过的
/// 计划(可能拿不到)。拿不到明细就**明说**拿不到,不含糊、不编。
///
/// R13 C1:勾选范围自成一段、且比文件集**先判**。此前两者共用一段,「卡完全没变、
/// 只是提交选择 B 时误带了选择 A 的令牌」会被逐条 diff 报成「A 被删、B 新增」,
/// 于是断言「卡上的文件变了」——把前端状态错配说成有人动了卡。
fn plan_changed_message(
    state: &AppState,
    approved: &str,
    fresh: &str,
    fresh_plan: &[copy::PlannedFile],
    volume_identity: &str,
    fresh_selection: &[String],
) -> String {
    let recalled = state.approved_plans.recall(approved);
    let diff = match &recalled {
        RecalledPlan::Found(s) => s
            .files
            .as_deref()
            .map(|old| copy::diff_plans(old, fresh_plan)),
        _ => None,
    };
    let why = match copy::classify_plan_change(approved, fresh) {
        // 走到这里说明两串不相等,不可能判成 None;真出现就说明比对口径有 bug,
        // 照样 fail-closed,但要说得让人看得出是工具的问题
        copy::PlanChange::None => {
            "确认令牌与本次计划的比对结果自相矛盾(工具内部状态异常)。".to_string()
        }
        copy::PlanChange::Unrecognized => {
            "无法识别你回传的确认令牌(可能来自旧版本的确认屏,或令牌在回传路上被改写)。"
                .to_string()
        }
        // 卷身份能解释后面所有差异,所以优先说它——先让人去看插的是哪张卡,
        // 而不是去数文件。但「哪一段变了」必须说准(见 why_volume_differs)
        copy::PlanChange::Volume => why_volume_differs(&recalled, volume_identity),
        // R13 C1:勾选范围对不上 = 前端把**另一次规划**的令牌带过来了(或用户在
        // 确认屏之外改了勾选)。这不是卡的问题,一个字都不能提「卡上的文件变了」。
        copy::PlanChange::Selection => {
            let named = recalled.snapshot().map(|s| {
                let then: std::collections::HashSet<&str> =
                    s.selection.iter().map(String::as_str).collect();
                let now: std::collections::HashSet<&str> =
                    fresh_selection.iter().map(String::as_str).collect();
                let label = |f: &str| {
                    if f.is_empty() {
                        "卡根目录".to_string()
                    } else {
                        f.to_string()
                    }
                };
                let mut only_then: Vec<String> =
                    then.difference(&now).map(|f| label(f)).collect();
                let mut only_now: Vec<String> = now.difference(&then).map(|f| label(f)).collect();
                only_then.sort();
                only_now.sort();
                (only_then, only_now)
            });
            match named {
                Some((only_then, only_now)) if !only_then.is_empty() || !only_now.is_empty() => {
                    let mut parts = Vec::new();
                    if !only_then.is_empty() {
                        parts.push(format!("确认时勾了、这次没勾:{}", name_a_few(&only_then)));
                    }
                    if !only_now.is_empty() {
                        parts.push(format!("这次多勾了:{}", name_a_few(&only_now)));
                    }
                    format!(
                        "本次提交的勾选范围(选中的文件夹)与你确认时的那一份不是同一套:{}。\
                         这与卡上的内容无关——多半是确认屏与提交用的不是同一次规划。",
                        parts.join(";")
                    )
                }
                _ => format!(
                    "本次提交的勾选范围(选中的文件夹)与你确认时的那一份不是同一套{}。\
                     这与卡上的内容无关——多半是确认屏与提交用的不是同一次规划。",
                    no_detail_tail(&recalled)
                ),
            }
        }
        copy::PlanChange::FileSet => match &diff {
            Some(d) if d.file_set_changed() => {
                let mut parts = Vec::new();
                if !d.added.is_empty() {
                    parts.push(format!("新增 {}", name_a_few(&d.added)));
                }
                if !d.removed.is_empty() {
                    parts.push(format!("少了 {}", name_a_few(&d.removed)));
                }
                if !d.resized.is_empty() {
                    parts.push(format!("大小变了 {}", name_a_few(&d.resized)));
                }
                if !d.retargeted.is_empty() {
                    parts.push(format!("落点被重新规划 {}", name_a_few(&d.retargeted)));
                }
                format!("卡上的文件在你确认之后变了:{}。", parts.join(";"))
            }
            // 勾选范围已经先判过(Selection 段相同才会走到这里),所以文件集段不同
            // 却逐条比不出差异,只可能是工具自身的口径出了问题——照样拦,但不扣帽子
            Some(_) => {
                "文件集摘要与确认时那一份对不上,逐条却比不出差异(工具内部状态异常)。"
                    .to_string()
            }
            None => format!(
                "卡上的文件在你确认之后有增删或改动,现在共 {} 个文件{}。",
                fresh_plan.len(),
                no_detail_tail(&recalled)
            ),
        },
        copy::PlanChange::ContentReplaced => match &diff {
            Some(d) if !d.retimed.is_empty() => format!(
                "有 {} 个文件在你确认之后被改动过(大小没变,但内容可能已经不是你确认时看到的那份):{}。",
                d.retimed.len(),
                name_a_few(&d.retimed)
            ),
            // 摘要说修改时间变了、逐条却比不出来:只可能是某个文件的 mtime 在
            // 「读得到」与「读不到(记 0)」之间跳了一次。照样拦,但别乱扣帽子
            Some(_) => "卡上有文件的修改时间在你确认之后变得读不出来(或从读不出来变成读得出来),\
                 无法确认内容还是你批准的那份。"
                .to_string(),
            None => format!(
                "有文件在你确认之后被改动过(大小没变、修改时间变了,内容可能已经不是你确认时看到的那份){}。",
                no_detail_tail(&recalled)
            ),
        },
    };
    format!("PLAN_CHANGED: {why}这次不会按旧清单开跑。请重新核对本次要拷的范围与改名清单后再确认。")
}

#[tauri::command(async)]
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

    // 源卷解析到权威卷清单(R9):拷贝前的读取边界也必须是真卡,不是任意目录
    let source_root = ensure_source_volume(&input.volume_id)?;
    // 空 / 不传 = 整卷(与改造前逐字节同路径);非空 = 按文件夹多选 + 落盘扁平化
    let parsed = parse_selection(&input.source_folders)?;
    notice_selection_aliases(&app, &parsed.aliases);
    let selection = parsed.selection;
    let scanned = copy::scan_selection(&source_root, &selection);
    let (hidden_skipped, hidden_samples) = peek_skipped_for_dto();
    // 零静默:扫描跳过的符号链接/系统项必须让用户知道(它们不会被拷贝)
    notice_scan_skips(&app);
    let (plan, renamed, _) = scanned.map_err(err)?;
    if plan.is_empty() {
        return Err(match &selection {
            copy::SourceSelection::WholeVolume => "源卷上没有可拷贝的素材".into(),
            copy::SourceSelection::Folders(_) => {
                "所选文件夹里没有可拷贝的素材(只拷直接子文件,子目录需要单独勾选)".to_string()
            }
        });
    }
    // 源必须是当前真实挂载的卷:这是后面写卡片指纹文件的前提
    // (codex 评审 12:不核实挂载点就写指纹,等于往任意目录塞文件)
    let mounted = known_source_volumes()
        .into_iter()
        .find(|v| v.mount_point == source_root);
    let volume_name = mounted
        .as_ref()
        .map(|v| v.name.clone())
        .unwrap_or_else(|| input.volume_id.clone());

    // ---- R5:双确认屏批准的那份计划,和这里重扫出来的这份,必须是同一份 ----
    // 闸放在**任何** UID / manifest / 审计副作用之前:窗口内换卡、别的进程写入、
    // 文件被删,都会让 L2 ≠ L1(被删的已确认文件直接从新计划里消失,剩下的照样
    // 能 all_verified);新出现的重名还会改变已批准的改名清单。
    let identity = volume_identity(&source_root);
    let fresh_digest = copy::plan_digest(&selection, &plan, &identity);
    match input.plan_digest.as_deref().filter(|d| !d.is_empty()) {
        Some(approved) if approved != fresh_digest => {
            return Err(plan_changed_message(
                &state,
                approved,
                &fresh_digest,
                &plan,
                &identity,
                &copy::normalized_selection(&selection),
            ));
        }
        Some(_) => {}
        // 缺字段 = 老客户端或绕过了双确认屏。**不许 fail-open 成整卷**:
        // 按文件夹拷时改名清单与范围都是用户逐条批准过的东西,没有令牌就没有
        // 「批准过」这件事;整卷保留原层级、不改名,才可以豁免(向后兼容)。
        None => {
            if !matches!(selection, copy::SourceSelection::WholeVolume) {
                return Err(
                    "按文件夹拷卡必须带上双确认屏返回的 planDigest(缺少它就无法确认你批准的范围与改名清单还成立)。请退回确认屏重新核对;若客户端版本过旧,请先升级 OCard"
                        .to_string(),
                );
            }
        }
    }

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
        &plan,
        &m.id,
        // R2:DTO 必须报**引擎真正采用的** selection,不是原始输入。
        // 前端据 `task.sourceFolders` 决定拷完说「本卡可格式化」还是「这是部分
        // 拷贝,请勿格式化」——判据不可信 = 可能引导用户格式化掉未备份素材;
        // 而 manifest 存的是 `selection.to_folders()`,重启后 `rebuild_tasks`
        // 也读它,两边分叉会让同一个任务重启前后显示的范围不一样。
        &selection.to_folders(),
    )
    .map_err(err)?;

    // 落盘路径本身也用归一形式,存储/展示/校验三者一致
    let dest_targets: Vec<PathBuf> = dest_targets.iter().map(|t| normalize_lexical(t)).collect();
    validate_copy_paths(&source_root, &dest_targets)?;
    check_existing_target(&dest_targets, input.confirm_existing_target)?;
    // 零静默:扁平化把「目标夹已有同名文件」从边角情形变成常态
    //(先拷 100MSDCF 再拷 101MSDCF 到同一个夹子)。同名同内容会被复用、
    // 同名不同内容会在拷到那一刻报冲突——开拷前就该点名,别让人拷到一半才知道。
    // 读不动目标夹时这里会返回 Err(R6),因此必须排在任何写入之前。
    notice_target_name_clashes(&app, &plan, &dest_targets)?;

    // 卡片指纹:身份随卡走。规划期(`plan_source_selection`)已经绑过一次,这里
    // 再绑一次是为了覆盖「整卷拷可以不带令牌」和「规划时写不进、现在写得进」两种
    // 路径;`ensure_volume_uid` 幂等,已有指纹时直接读回。
    // 写保护/非挂载卷/系统盘拿不到指纹的告警口径与规划期同一份(零静默,且不许
    // 宣称完成了介质绑定)。
    let source_uid = bind_medium_identity(&app, &source_root);
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
    // 持久化完整计划清单:续传/重建以它兜底,源文件消失必须被发现(复核 P0)。
    // 落点在此刻锁定(含重名改写结果),续传只认这份,不再重新规划。
    m.planned = plan.iter().map(manifest::PlannedFile::from_plan).collect();
    // 审计痕迹:勾了哪些夹子、谁被改了名——事后必须查得到(改名=系统动了用户的文件名)
    m.source_selection = selection.to_folders();
    m.renamed_files = renamed;
    // R7/R11:被系统项名单排除掉的条目也进清单,事后查得到这次到底没拷什么
    // (字段名沿用 hidden_*:它同时是前端契约字段名,改名会打断并行开发的前端)
    m.hidden_skipped = hidden_skipped;
    m.hidden_samples = hidden_samples;
    let first_save = manifest::save(&stats.root, &m).map_err(err)?;
    // 重试后成功也要说;这条命令线程上的降级标记在这里带任务 scope 取走
    crate::core::fsx::note_retried_writes(first_save.0.retries as u64);
    sorting_cmds::notify_if_unsafe_fallback_for(&app, Some((&m.id, &stats.folder_name)));

    // 零静默,且必须在清单**落盘之后**才说(不然「已写入清单」是空头支票):
    // 系统替用户改了文件名,双确认屏之外再兜一次底
    if !m.renamed_files.is_empty() {
        let r = &m.renamed_files[0];
        notify::warn(
            &app,
            "copy-flatten-renamed",
            format!(
                "本次有 {} 个同名文件被加前缀区分(如 {} → {}),完整清单已写入拷卡清单可供事后核对",
                m.renamed_files.len(),
                r.source_rel,
                r.target_rel
            ),
        );
    }
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
                // 审计:整卷 = 空数组;按夹子拷时连改名条数一并留痕
                "sourceFolders": m.source_selection,
                "renamedCount": m.renamed_files.len(),
                // R13 C6:这次用的是哪一版扫描口径(缺字段/0 = 旧口径,会漏拷
                // 点开头的素材却照样报 100%)。审计行必须自带这个证据。
                "scanPolicyVersion": m.scan_policy_version,
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
        plan: std::sync::Mutex::new(plan),
        dest_targets,
        machine_id: state.machine_id.clone(),
        config_dir: state.config_dir.clone(),
        lease: Default::default(),
    });
    state.tasks.insert(dto.id.clone(), handle.clone());
    tasks::spawn_worker(app, handle);
    Ok(dto)
}

#[tauri::command(async)]
pub fn pause_copy_task(state: State<AppState>, task_id: String) -> CmdResult<()> {
    let handle = state
        .tasks
        .get(&task_id)
        .ok_or_else(|| format!("任务不存在: {task_id}"))?;
    handle.pause_requested.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command(async)]
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
        // **第一件事是拿租约**,在读清单之前:另一个进程可能正跑着这个任务,
        // 先读再拿会拿着它释放前的陈旧快照去覆盖它最后写的进度。准备阶段的
        // 刷新计划那次写因此也在保护内;租约随后交给 worker 接手。
        // 同进程并发两次 resume 也会在这里被第二次的 Busy 挡住(token 不同)。
        let (operator, task_id_for_lease, project_id_for_lease) = {
            let s = handle.snap();
            (s.operator.clone(), s.id.clone(), s.project_id.clone())
        };
        let lease = crate::core::lease::acquire(
            &handle.project_root,
            &handle.manifest_id,
            &handle.machine_id,
            &operator,
        );
        // 租约取得(原子建文件)在这条命令线程上完成,降级标记是线程局部的:在 `?` **之前**
        // 取走、带 scope——Busy 早退时留在运行时线程上的标记会被下一条命令当成自己的
        sorting_cmds::notify_if_unsafe_fallback_for(
            &app,
            Some((&task_id_for_lease, &project_id_for_lease)),
        );
        let lease = lease.map_err(|e| {
            let msg = e.to_string();
            if matches!(e, crate::core::CoreError::Busy(_)) {
                // 先 clone 再放锁:notify 会写日志 + IPC,不该持着 snapshot 锁做
                let (id, pid) = {
                    let s = handle.snap();
                    (s.id.clone(), s.project_id.clone())
                };
                // 锁目录异常(链接 / 异物)不是「别的进程在跑」:标题也要换,否则用户
                // 先去别的机器上白找一圈
                // code 直接写字面量(通知 code 门禁只认调用点里的字面量);锁目录异常
                // 用 error 级——它不会自己好,不该 6 秒后自动收起
                if msg.starts_with(crate::core::lease::LOCK_DIR_BROKEN_PREFIX) {
                    notify::error_for_task(
                        &app,
                        "copy-resume-lease-lock-broken",
                        (&id, &pid),
                        msg.clone(),
                    );
                } else {
                    notify::warn_for_task(&app, "copy-resume-lease-held", (&id, &pid), msg.clone());
                }
            }
            msg
        })?;
        // 从这里到交给 worker 之间的任何早退(清单损坏、卷没插回……)都要有释放判定
        let mut keeper = tasks::LeaseKeeper::new(
            app.clone(),
            lease,
            "续传准备中断、回滚",
            (task_id_for_lease.clone(), project_id_for_lease.clone()),
            handle.clone(),
        );
        if let Some(note) = keeper.lease_mut().took_over_stale.take() {
            notify::warn_for_task(
                &app,
                "task-lease-taken-over",
                (&task_id_for_lease, &project_id_for_lease),
                note,
            );
        }
        // 续传身份核对(评审 M10/P0-1)+ 按卷名重解析挂载点(复核必修 A:
        // 卡后插/换挂载口场景,插回原卡即可续传,无需重启应用)
        let m = manifest::load(&handle.project_root, &handle.manifest_id).map_err(err)?;
        // R2 P0:持久化清单是外部可篡改输入——任何非法相对路径(`..`/绝对/空段)
        // 都说明清单损坏或被篡改,整单拒绝续传(fail-closed,可见报错),
        // 绝不静默丢弃单条(丢弃=静默漏拷)。闸在卷重解析之前:清单坏了就该
        // 直说,不能先让用户「插回原卡」再报废(R3-F2:也让闸不依赖挂载环境)。
        // 源与目标两条路径都要过闸:源侧越界=去卡外读文件,目标侧越界=写到目的地根外
        if let Some(bad) = m.planned.iter().find(|p| {
            !crate::core::paths::is_safe_rel(&p.rel_path)
                || !crate::core::paths::is_safe_rel(p.source())
        }) {
            return Err(err(format!(
                "任务清单损坏或被篡改(非法相对路径 {:?}),拒绝续传;请重新发起拷贝",
                if crate::core::paths::is_safe_rel(&bad.rel_path) {
                    bad.source()
                } else {
                    &bad.rel_path
                }
            )));
        }
        // 选择本身也是清单的一部分,同样要过闸(复扫会照着它去 read_dir)
        if let Some(bad) = m
            .source_selection
            .iter()
            .find(|f| !f.is_empty() && !crate::core::paths::is_safe_rel(f))
        {
            return Err(err(format!(
                "任务清单损坏或被篡改(非法源文件夹 {bad:?}),拒绝续传;请重新发起拷贝"
            )));
        }
        // 两个持久化信号必须自洽:`source_selection` 被清空、planned 却带着扁平落点时,
        // 按整卷解读会把整张卡按原目录结构灌进那个扁平化的目标夹(且悄无声息)。
        // 反向(选了夹子但源=目标)是合法的——只勾卷根时落点本来就等于源。
        if m.source_selection.is_empty() && m.planned.iter().any(|p| !p.source_rel.is_empty()) {
            return Err(err(
                "任务清单口径自相矛盾(没有源选择记录,计划里却有扁平化落点),拒绝续传;请重新发起拷贝"
                    .to_string(),
            ));
        }
        // 只看可移动卷:系统盘永远在场,混进来会让「没有检测到可移动卷」
        // 分支永不可达,报文失真(复验 18)
        let vols: Vec<(PathBuf, String)> = volumes::removable_volumes()
            .into_iter()
            .map(|v| (v.mount_point, v.name))
            .collect();
        let recorded = handle.source_root_guard().clone();
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
            let mut src = handle.source_root_guard();
            *src = resolved.clone();
        }
        {
            let mut snap = handle.snap();
            snap.volume_id = resolved.display().to_string();
        }
        // 刷新清单:源卡内容可能在暂停期间变化,快照与引擎必须消费同一份新清单。
        // (planned 的合法性已在上方 manifest 加载后整单校验。)
        // R8:清单里的 size/mtime 若被刷新,必须**连同持久化的 planned 一起**更新
        // 并落盘——只改内存会留下 `planned.size = 旧值` / `entry.size = 新值` /
        // `completed = true` 的自相矛盾清单。
        let mut m = m;
        let plan = refresh_resume_plan(
            &app,
            &mut m,
            &handle.project_root,
            &resolved,
            keeper.lease(),
            (&task_id_for_lease, &project_id_for_lease),
        )?;
        let mut snap = handle.snap();
        let old: std::collections::HashMap<String, &'static str> = snap
            .files
            .iter()
            .map(|f| (f.id.clone(), f.status))
            .collect();
        snap.total_bytes = plan.iter().map(|p| p.size).sum();
        snap.files = plan
            .iter()
            .map(|p| {
                let mut f = tasks::file_item_dto(p);
                f.status = old.get(&f.id).copied().unwrap_or("pending");
                f
            })
            .collect();
        snap.file_count = Some(plan.len());
        *handle.plan_guard() = plan;
        // 准备阶段(刷新计划落盘、栅栏取锁)在这条命令线程上留下的线程局部降级:交给 worker
        // 之前带 scope 取走——正常路径守卫不再 Drop,没有别的取走者(Fable 第 13 轮)
        sorting_cmds::notify_if_unsafe_fallback_for(
            &app,
            Some((&task_id_for_lease, &project_id_for_lease)),
        );
        // 准备完毕,租约交给 worker(它接手后一直持有到任务结束)
        *handle.lease_slot() = Some(keeper.into_lease());
    }

    tasks::spawn_worker(app, handle);
    Ok(())
}

/// 续传前刷新清单。
/// - **整卷**:重扫全卷 ∪ 持久化计划——计划内但已从源消失的文件必须留在清单里
///   (引擎打不开源就记失败,绝不静默漏拷,复核 P0);卡上新增的文件照旧带上。
/// - **按文件夹**:落点在开拷那一刻就锁定了(重名前缀是拿**整组**文件算出来的,
///   卡上多一个同名文件会让已拷文件换个落点,续传就认不出它已经拷过),
///   所以只认持久化计划;卡上新增的文件不悄悄带进来,而是发可见告警让用户另起任务。
///
/// R8:任何对计划的刷新(size / mtime)都必须**原子地**同时落到
/// `m.planned` 与磁盘上的清单。只改内存里的 `handle.plan` 会留下
/// `planned.size = 旧值`、`entry.size = 新值`、`completed = true`
/// 的自相矛盾清单——事后既查不清拷的到底是哪一版,重启重建也会用错尺寸。
fn refresh_resume_plan<R: tauri::Runtime>(
    app: &AppHandle<R>,
    m: &mut manifest::CopyManifest,
    project_root: &Path,
    source_root: &Path,
    lease: &crate::core::lease::Held,
    task: (&str, &str),
) -> CmdResult<Vec<copy::PlannedFile>> {
    let selection = copy::SourceSelection::from_folders(m.source_selection.clone());
    if matches!(selection, copy::SourceSelection::WholeVolume) {
        let scanned = copy::scan_source(source_root);
        // R10:失败出口也要取走计数(留着会算到下一次操作头上,报数失真)
        notice_scan_skips(app);
        let mut files = scanned.map_err(err)?;
        // R13 C4:union **之前**先按老基线逐条 diff。整卷路径此前没有 resized /
        // retimed 告警(只有按文件夹的那条有):暂停期间源文件被改大小、或同大小
        // 改了 mtime,新计划会直接覆盖持久化的 size/mtime,把用户批准过的那份基线
        // 无声抹掉——之后再也查不出「拷的到底是哪一版」。
        let old_plan: Vec<copy::PlannedFile> = m.planned.iter().map(|p| p.to_plan()).collect();
        if !old_plan.is_empty() {
            let fresh_plan = copy::plan_whole_volume(&files);
            notice_resume_baseline_diff(
                app,
                &copy::diff_plans(&old_plan, &fresh_plan),
                "源卷上",
                task,
            );
        }
        for p in &m.planned {
            if !files.iter().any(|f| f.rel == p.rel_path) {
                // 计划内、源上已消失:留在清单里让引擎显式记失败,绝不静默漏拷
                files.push(copy::ScannedFile {
                    rel: p.rel_path.clone(),
                    size: p.size,
                    mtime_ns: p.source_mtime_ns,
                });
            }
        }
        files.sort();
        let plan = copy::plan_whole_volume(&files);
        // R11:排除口径收紧后,续传老任务时会有一批**以前被排除、现在算素材**的
        // 文件(点开头的合法素材)第一次进入整卷计划并被拷贝。多拷不是漏拷,但
        // 用户会看到「已经跑完的任务又冒出新文件」——不解释清楚,他会以为卡被人动过。
        notice_policy_widened(
            app,
            m.planned.iter().map(|p| p.rel_path.as_str()),
            &plan,
            m.scan_policy_version,
            task,
        );
        persist_refreshed_plan(app, m, project_root, &plan, lease, task)?;
        return Ok(plan);
    }

    if m.planned.is_empty() {
        return Err(
            "任务清单缺少开拷时锁定的文件列表,无法续传;请重新发起拷卡(不会覆盖已拷素材)".into(),
        );
    }
    let mut plan: Vec<copy::PlannedFile> = m.planned.iter().map(|p| p.to_plan()).collect();
    // 复查源卡:落点沿用锁定的,**尺寸取当前实际值**——暂停期间文件被改写时,
    // 沿用旧 size 会让 manifest 记下与实际内容不符的长度(进度也会失真),
    // 续传下一轮才靠哈希发现问题。失败不阻断续传,但必须可见。
    let scanned = copy::scan_selection(source_root, &selection);
    notice_scan_skips(app);
    match scanned {
        Ok((fresh, _, _)) => {
            // 与整卷路径同一份逐条 diff(R13 C4):被改大小、或同大小改了 mtime 的
            // 文件意味着**开拷时批准的基线即将被新值覆盖**,两条路径的告警必须一致。
            // 只比 size 的话「同大小内容被替换」完全无声,而它恰恰是最危险的一种。
            let mut d = copy::PlanDiff::default();
            for p in plan.iter_mut() {
                if let Some(f) = fresh.iter().find(|f| f.source_rel == p.source_rel) {
                    if f.size != p.size {
                        d.resized.push(p.source_rel.clone());
                    } else if p.source_mtime_ns != 0
                        && f.source_mtime_ns != 0
                        && f.source_mtime_ns != p.source_mtime_ns
                    {
                        d.retimed.push(p.source_rel.clone());
                    }
                    p.size = f.size;
                    p.source_mtime_ns = f.source_mtime_ns;
                }
            }
            d.resized.sort();
            d.retimed.sort();
            notice_resume_baseline_diff(app, &d, "所选文件夹里", task);
            let added: Vec<&str> = fresh
                .iter()
                .filter(|f| !plan.iter().any(|p| p.source_rel == f.source_rel))
                .map(|f| f.source_rel.as_str())
                .collect();
            if !added.is_empty() {
                // R11 / R13 C6:排除口径从「点开头一律跳过」收紧成明确列举的系统项
                // 之后,**升级前**建的任务续传时会凭空多出一批点开头的文件。
                // 但反过来,本版本新建的任务在暂停期间用户真的新增了 `.clip.mov`,
                // 也长这个样子——两者从这里看**分辨不出来**。旧措辞直接断言
                // 「并不是这张卡被人动过」就是在编:归因错了,用户会放过一次真实变更。
                // 判据只有清单里的 `scan_policy_version`(缺失 = 旧口径)。
                let widened = added.iter().filter(|r| has_dot_segment(r)).count();
                let because = if widened > 0 {
                    format!(
                        ";其中 {widened} 个是「.」开头的条目{}",
                        policy_upgrade_caveat(m.scan_policy_version)
                    )
                } else {
                    String::new()
                };
                notify::warn_for_task(app, "copy-resume-new-files", task,
                    format!(
                        "所选文件夹里新增了 {} 个文件({}{}),不在本任务开拷时锁定的清单内,本次续传不会拷它们{because};需要的话请对这些文件另发起一次拷卡",
                        added.len(),
                        added.iter().take(3).copied().collect::<Vec<_>>().join("、"),
                        if added.len() > 3 { " 等" } else { "" },
                    ),
                );
            }
            persist_refreshed_plan(app, m, project_root, &plan, lease, task)?;
        }
        Err(e) => notify::warn_for_task(
            app,
            "copy-resume-rescan-failed",
            task,
            format!("续传前复查源卷失败,已按开拷时锁定的清单继续(卡上新增的文件不会被发现;若这份清单是旧版本写的、没有记录修改时间,拷贝期间的源稳定性只能按开拷快照判,同一时间槽内的等长改写挡不住): {e}"),
        ),
    }
    Ok(plan)
}

/// 相对路径里有没有「.」开头的一段(文件名或中间某级目录)。
/// R11 的口径变化只可能让这类条目凭空出现,用它把「口径变了」和「卡被人动过」
/// 这两种截然不同的原因分开。
fn has_dot_segment(rel: &str) -> bool {
    rel.split('/').any(|s| s.starts_with('.'))
}

/// 「点开头的条目这次才冒出来」的归因措辞(R13 C6)。
///
/// 两种原因长得一模一样,而清单里唯一的证据是 `scan_policy_version`:
/// - 缺失(0)= 这份清单是**旧口径**下锁定的,策略升级足以解释;
/// - 已是当前版本 = 锁定时就已经是新口径,策略升级**解释不了**,只能是卡上真的
///   多了东西。
///
/// 即便是前者也**不能排除**卡内容同时发生了变化——所以措辞一律留有余地。
/// 说错原因比不说更糟:断言「不是这张卡被人动过」会让用户放过一次真实变更。
fn policy_upgrade_caveat(scan_policy_version: u32) -> String {
    if scan_policy_version < manifest::SCAN_POLICY_VERSION {
        format!(
            "——本任务的清单是在扫描策略 v{scan_policy_version}(旧口径:点开头一律排除)下锁定的,\
             当前是 v{}(只排除废纸篓、索引这类明确的系统项)。它们**可能**是策略升级带来的,\
             也**可能**是确认之后卡上真的新增了这些文件——两者无法区分,请核对后再做判断",
            manifest::SCAN_POLICY_VERSION
        )
    } else {
        "——本任务锁定时就已经是当前扫描策略,策略升级解释不了它们,\
         应当按「源卷内容在开拷之后发生了变化」来核对"
            .to_string()
    }
}

/// 整卷续传时,因排除口径收紧而**新进入计划**的条目的可见告警。
///
/// 零静默:这批文件会被真的拷到目的地,任务的文件数和「完成」判定都跟着变。
/// 老任务的 `planned` 是升级前锁定的,升级后重扫会多出这些条目——但同样的形状
/// 也可能来自「卡上真的新增了点开头的素材」,归因必须留有余地(R13 C6)。
fn notice_policy_widened<'a, R: tauri::Runtime>(
    app: &AppHandle<R>,
    locked: impl Iterator<Item = &'a str>,
    plan: &[copy::PlannedFile],
    scan_policy_version: u32,
    task: (&str, &str),
) {
    let locked: std::collections::HashSet<&str> = locked.collect();
    let newly: Vec<&str> = plan
        .iter()
        .map(|p| p.target_rel.as_str())
        .filter(|rel| !locked.contains(rel) && has_dot_segment(rel))
        .collect();
    if newly.is_empty() {
        return;
    }
    notify::warn_for_task(app, "copy-resume-scope-widened", task,
        format!(
            "续传时新纳入了 {} 个「.」开头的条目({}{}),它们**会被拷贝**{}。任务进度会因此回退到未完成,拷完再看「可格式化」提示",
            newly.len(),
            newly.iter().take(3).copied().collect::<Vec<_>>().join("、"),
            if newly.len() > 3 { " 等" } else { "" },
            policy_upgrade_caveat(scan_policy_version),
        ),
    );
}

/// 续传前「新旧计划逐条差异」的可见告警(R13 C4)。
///
/// 整卷与按文件夹两条路径共用同一套措辞:被改了大小、或同大小改了 mtime 的文件,
/// 意味着**用户批准过的那份 size/mtime 基线即将被新值覆盖**。不点破就等于无声
/// 抹掉基线——事后再也说不清「拷的到底是哪一版」。
fn notice_resume_baseline_diff<R: tauri::Runtime>(
    app: &AppHandle<R>,
    d: &copy::PlanDiff,
    scope: &str,
    task: (&str, &str),
) {
    if !d.resized.is_empty() {
        notify::warn_for_task(app, "copy-resume-size-changed", task,
            format!(
                "{scope}有 {} 个文件在暂停期间大小变了({}),已按当前实际大小续传,开拷时记录的基线会被覆盖;若这不是预期,请核对是否换了卡或有人动过源文件",
                d.resized.len(),
                name_a_few(&d.resized)
            ),
        );
    }
    if !d.retimed.is_empty() {
        notify::warn_for_task(app, "copy-resume-content-replaced", task,
            format!(
                "{scope}有 {} 个文件大小没变、修改时间却变了({})——内容很可能被替换过。续传会按内容哈希重新核对,已拷到目的地的旧版本不会被覆盖(会报冲突让你人工裁决);若这不是预期,请核对是否换了卡",
                d.retimed.len(),
                name_a_few(&d.retimed)
            ),
        );
    }
}

/// 把刷新后的计划原子写回清单(planned + completed 一起,同一次 save)。
///
/// R13 C3(P0):写回失败必须 **fail-closed**。此前只发一条告警就放行,而 worker
/// 会拿着内存里的新计划开跑、按**磁盘上的旧 `planned`** 保存进度——审计范围与
/// 实际拷贝范围就此分叉,事后查到的「拷了什么」不是真的拷了什么。清单是这个
/// 工具的审计凭证,写不进去就没有资格继续。
fn persist_refreshed_plan<R: tauri::Runtime>(
    app: &AppHandle<R>,
    m: &mut manifest::CopyManifest,
    project_root: &Path,
    plan: &[copy::PlannedFile],
    lease: &crate::core::lease::Held,
    // 通知带任务 scope:两个任务同时点「继续」时,无 scope 的同 code 会后一条顶掉前一条
    task: (&str, &str),
) -> CmdResult<()> {
    let refreshed: Vec<manifest::PlannedFile> =
        plan.iter().map(manifest::PlannedFile::from_plan).collect();
    if refreshed == m.planned {
        return Ok(()); // 一个字没变,不必重写
    }
    m.planned = refreshed;
    // 计划变了就还没跑完:`completed` 必须跟着回落,否则会留下
    // 「清单说完成了、里面却有未验证项」的自相矛盾状态
    m.completed = false;
    // 计划换代:自动转代理的完成标记与重试预算都是上一代的,一并失效——否则按旧计划
    // 跑完的代理作业晚一步回来,会把这一代标成「代理已完成」,新增文件永远不再自动转代理
    // 持久化清单是不可信输入:u64::MAX 在 release 构建会绕回第 0 代,fail-closed
    m.plan_generation = m
        .plan_generation
        .checked_add(1)
        .ok_or_else(|| "清单的计划代次已达上限,拒绝续传;请重新发起拷贝".to_string())?;
    m.proxy_completed = false;
    m.proxy_attempts = 0;
    // 调用方(resume_copy_task)已经持有这个任务的租约,这次写在保护内;而且写在
    // **栅栏**内:持有 Held 本身挡不住「进程休眠超过 TTL 后被接管」,栅栏在落盘前
    // 持锁核对 token,不是自己的就不写(codex r6)
    let saved = lease.fence().and_then(|fence| {
        // 改名之前再问一句栅栏还在不在(守门版 save),写完再复核一次
        let r = manifest::save_guarded(project_root, m, &|| fence.still_mine())?;
        // 落盘后复核栅栏:被外部回收 = 这次落盘期间可能有人接管,接管者的清单可能刚被
        // 这次整份重写顶掉——按写失败处理并说出来,不能一声不吭(第九轮评审)
        if !fence.still_mine() {
            let mut why = String::from(
                "落盘之后发现本任务的租约栅栏已不成立(读不到锁标记,或盘上租约已不是本任务的;可能是存储抖了一下,也可能是锁被外部回收 / 被别的进程接管;这里分不出来),这次写回不可信;请确认没有别的 OCard 在跑这个任务",
            );
            // NAS 上留持久化的不可信标记(本机通知别的机器看不见)
            if let Err(e) = manifest::mark_suspect(project_root, &m.id, &why) {
                why.push_str(&format!("。而且没能写下「不可信」标记({e})"));
            }
            return Err(crate::core::CoreError::Busy(why));
        }
        drop(fence);
        Ok(r)
    });
    if let Ok((wr, path)) = &saved {
        if wr.retries > 0 {
            // 与拷卡那条路的 fs-write-contention 口径一致:被占用后重试成功也要可见
            notify::warn_for_task(
                app,
                "fs-write-contention",
                task,
                format!(
                    "写入拷卡清单时被别的程序占着,重试 {} 轮后成功:{}。多半是杀毒软件或 NAS 索引正在扫这个目录;若反复出现,把该目录加入杀毒软件排除项",
                    wr.retries,
                    path.display()
                ),
            );
        }
    }
    if let Err(e) = saved {
        // 锁目录异常(链接 / 异物)不会自己好:单独一条 error 级、抬头就说「需人工清理」
        if e.to_string()
            .starts_with(crate::core::lease::LOCK_DIR_BROKEN_PREFIX)
        {
            notify::error_for_task(app, "copy-resume-lease-lock-broken", task, e.to_string());
        }
        // 栅栏那一支(Busy)不是写权限问题,别把人支去查权限——本模块反复强调的那条
        let msg = if e.to_string().contains("不可信") {
            // 改名已经发生、写后复核才失败:盘上多半就是这份,不能说「未能写回」
            format!(
                "续传前刷新的文件清单写回了但不能确认(写后复核发现租约锁标记不在了),已拒绝续传:{e}。请确认没有别的 OCard 在跑这个任务(或检查清单目录里的租约锁目录)后再试"
            )
        } else if matches!(e, crate::core::CoreError::Busy(_)) {
            format!(
                "续传前刷新的文件清单**未能**写回拷卡清单,已拒绝续传:{e}。请确认没有别的 OCard 在跑这个任务(或检查清单目录里的租约锁目录)后再试"
            )
        } else {
            format!(
                "续传前刷新的文件清单**未能**写回拷卡清单,已拒绝续传(继续跑会让审计范围与实际拷贝范围对不上:\
                 worker 用的是刷新后的新清单,磁盘上却还是旧的那份)。请排查目的地/NAS 是否可写后重试: {e}"
            )
        };
        notify::warn_for_task(app, "copy-resume-manifest-not-persisted", task, msg.clone());
        return Err(msg);
    }
    Ok(())
}

/// 启动时从各项目未完成的 manifest 重建 paused 任务(评审 H3/P0-3):
/// 崩溃/重启后任务不再消失,可从任务列表续传。
/// 残留临时文件的存活门槛。比任何一次正常的「写→改名」都长得多,
/// 又短到不会让垃圾在 NAS 上过夜。
const STALE_TEMP_AGE: std::time::Duration = std::time::Duration::from_secs(3600);

/// 清掉原子写留下的孤儿临时文件。
///
/// [`crate::core::fsx::write_atomic`] 用**唯一**临时名(修的是「两处同时写会
/// 互相截断」),代价是:进程在「写完临时文件」和「改名」之间被杀掉/断电/
/// NAS 断连时,那个文件永远留在盘上,而且每次都是新名字——**无界累积**,
/// 每个还都是一份完整清单。旧的固定名至少会被下一次覆盖掉。
///
/// 零静默:清了几个要说一声,清不掉也要说一声。
#[derive(Default)]
pub(crate) struct SweepTally {
    pub removed: usize,
    pub stuck: usize,
    /// 出问题的目录(删不掉 / 扫不动),报文里要点名——「把目录加进排除项」
    /// 这条建议,没有目录用户不知道该加哪个
    pub trouble: Vec<String>,
}

pub(crate) fn sweep_stale_temp_files(dir: &std::path::Path, tally: &mut SweepTally) {
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        // 目录不存在 = 这个项目还没拷过卡,正常
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        // 其余(权限不足、NAS 半死)是真的没扫成:吞掉就是无提示 fail-open
        Err(_) => {
            tally.stuck += 1;
            tally.trouble.push(dir.display().to_string());
            return;
        }
    };
    // 年龄用 NAS 自己的时钟量(与租约模块同一把尺子):本机比 NAS 快一小时以上时,
    // 别的工作站此刻正在「写临时文件 → 改名」窗口里的那份会被当孤儿删掉。探针写不成
    // 就退回本机时钟(与此前行为相同)
    let Some(now) = crate::core::lease::nas_now(dir) else {
        // fail-closed:探针写不进就不删——退回本机时钟的话,本机快一小时以上时会把别的
        // 工作站此刻正在改名窗口里的临时文件当孤儿删掉。算作「扫不动」并点名目录
        tally.stuck += 1;
        tally
            .trouble
            .push(format!("{}(时钟探针写不进,本次跳过清扫)", dir.display()));
        return;
    };
    let (mut removed, mut stuck) = (0usize, 0usize);
    for e in rd {
        // 逐项枚举失败(NAS 半死时常见)不能 flatten 掉:那一项到底是什么、
        // 清没清,我们不知道——按「没扫成」计,让用户知道这个目录没扫干净
        let Ok(e) = e else {
            stuck += 1;
            continue;
        };
        let name = e.file_name().to_string_lossy().to_string();
        if !name.starts_with('.') || !name.ends_with(crate::core::fsx::TMP_SUFFIX) {
            continue;
        }
        let age = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok());
        match age {
            // 读不到 mtime:不知道它多老,不敢删,也不能假装没看见
            None => {
                stuck += 1;
                continue;
            }
            Some(a) if a <= STALE_TEMP_AGE => continue, // 可能是另一台机器**此刻**正在写的
            Some(_) => {}
        }
        match std::fs::remove_file(e.path()) {
            Ok(()) => removed += 1,
            Err(_) => stuck += 1,
        }
    }
    tally.removed += removed;
    tally.stuck += stuck;
    if stuck > 0 {
        tally.trouble.push(dir.display().to_string());
    }
}

/// 把全部项目的清扫结果**汇总成一条**再发。
///
/// 逐项目发会被通知的 30 秒合并窗口折成一条,而合并只保留最后一条的正文——
/// 项目 A 清了 7 个、B 清了 1 个、C 清了 3 个,用户看到的是「清理了 3 个(C 的路径)×3」,
/// 前两个的数量和路径全丢。「删不掉」那条尤其需要点名目录。
fn report_sweep<R: tauri::Runtime>(app: &AppHandle<R>, tally: &SweepTally) {
    if tally.removed > 0 {
        notify::info(
            app,
            "stale-temp-swept",
            format!("清理了 {} 个上次异常退出留下的临时清单文件", tally.removed),
        );
    }
    if tally.stuck > 0 {
        // 通知正文只列前 5 个;其余的名字必须**有地方落地**——「把目录加进杀软
        // 排除项」这条建议对第 6 个之后的目录才有得执行。诊断报告会带上日志
        for d in &tally.trouble {
            log::warn!("残留临时清单文件没能清掉(目录): {d}");
        }
        let dirs = tally.trouble.iter().take(5).cloned().collect::<Vec<_>>();
        let more = tally.trouble.len().saturating_sub(dirs.len());
        notify::warn(
            app,
            "stale-temp-stuck",
            format!(
                "{} 处残留的临时清单文件没能清掉(权限不足、被占用,或目录读不动),已留在盘上:{}{}",
                tally.stuck,
                dirs.join("、"),
                if more > 0 {
                    format!(",另有 {more} 处(全部目录见运行日志)")
                } else {
                    String::new()
                }
            ),
        );
    }
}

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
    let mut sweep = SweepTally::default();
    for p in projects {
        sweep_stale_temp_files(&manifest::manifest_dir(&p.root), &mut sweep);
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
        // 带「不可信」标记的清单(被迟到的写入顶掉过)即使写着 completed 也按未完成展示:
        // 续传会按哈希重新确认,跑完才清标记。系统替用户改了判断,要说
        // 读不出标记(权限 / SMB 瞬断)也按不可信处理:把读错误当「没有标记」,写着
        // completed 的任务就会被静默当成已完成(codex 终审 P0)
        let mut suspects: Vec<(String, String)> = Vec::new();
        for m in list.manifests.iter().filter(|m| m.completed) {
            match manifest::suspect(&p.root, &m.id) {
                Ok(None) => {}
                Ok(Some(why)) => suspects.push((m.id.clone(), why)),
                Err(e) => suspects.push((m.id.clone(), format!("(标记读不出:{e};按不可信处理)"))),
            }
        }
        for (mid, why) in &suspects {
            notify::warn_for_task(
                app,
                "manifest-suspect",
                (mid, &p.folder_name),
                format!(
                    "「{}」下清单 {}… 写着已完成,但它旁边有「不可信」标记、或标记读不出(标记是上一次运行写完后发现租约锁已丢时留下的,这份内容可能盖掉了接管方的进度):已按未完成任务展示,续传会按哈希重新确认。详情:{}",
                    p.folder_name,
                    &mid[..8.min(mid.len())],
                    why.trim()
                ),
            );
        }
        let suspect_ids: std::collections::HashSet<String> =
            suspects.into_iter().map(|(id, _)| id).collect();
        for m in list
            .manifests
            .into_iter()
            .filter(|m| !m.completed || suspect_ids.contains(&m.id))
        {
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
            // 旧格式 manifest 无 planned 时退回 entries(那时源即目标,无扁平化)
            let plan: Vec<copy::PlannedFile> = if m.planned.is_empty() {
                if !m.source_selection.is_empty() {
                    // 按夹子拷的任务没有 planned = 清单残缺:entries 的 rel 是扁平落点,
                    // 拿它当源路径会指向卡上根本不存在的文件。宁可不重建也不给错清单
                    notify::warn(
                        app,
                        "rebuild-selection-manifest-incomplete",
                        format!(
                            "项目「{}」的任务「{}」记录了按文件夹拷贝,却缺少开拷时锁定的文件清单,无法自动续传;重新发起拷卡即可,不会覆盖已有素材",
                            p.folder_name, m.target_rel
                        ),
                    );
                    continue;
                }
                m.entries
                    .iter()
                    .map(|e| copy::PlannedFile {
                        source_rel: e.rel_path.clone(),
                        target_rel: e.rel_path.clone(),
                        size: e.size,
                        // 旧格式清单没有 mtime 基线,0 = 「无从比对」
                        source_mtime_ns: 0,
                    })
                    .collect()
            } else {
                m.planned.iter().map(|p| p.to_plan()).collect()
            };
            let files: Vec<CopyFileItemDto> = plan
                .iter()
                .map(|p| {
                    let mut f = tasks::file_item_dto(p);
                    // 完成状态一律按**目标** rel 认(manifest 口径)
                    f.status = if m.is_done(&p.target_rel, p.size) {
                        "verified"
                    } else {
                        "pending"
                    };
                    f.hash = m
                        .entries
                        .iter()
                        .find(|e| e.rel_path == p.target_rel && !e.xxh3.is_empty())
                        .map(|e| e.xxh3.clone());
                    f
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
                tags: m.tags.clone(),
                target_folder: m
                    .target_rel
                    .rsplit('/')
                    .next()
                    .unwrap_or(&m.target_rel)
                    .to_string(),
                source_folders: m.source_selection.clone(),
                // 重建的任务照实报清单里的口径版本:0 = 旧口径锁定的清单
                scan_policy_version: m.scan_policy_version,
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
                status_counts: None, // 快照对外发布时由 summary_of 现算
                files,
            };
            let handle = Arc::new(TaskHandle {
                pause_requested: AtomicBool::new(false),
                running: AtomicBool::new(false),
                snapshot: std::sync::Mutex::new(dto),
                project_root: p.root.clone(),
                manifest_id: m.id.clone(),
                source_root: std::sync::Mutex::new(source_root),
                plan: std::sync::Mutex::new(plan),
                dest_targets,
                machine_id: state.machine_id.clone(),
                config_dir: state.config_dir.clone(),
                lease: Default::default(),
            });
            state.tasks.insert(m.id.clone(), handle);
        }
    }
    // 全部项目扫完再汇总成一条:逐项目发会被 30 秒合并窗口折掉计数和目录
    report_sweep(app, &sweep);
    // 这条线程上 NAS 时钟探针删不掉之类的线程局部降级也在这里取走(无任务 scope:启动期)
    sorting_cmds::notify_if_unsafe_fallback(app);
}

/// 单文件重试:失败文件在 manifest 中未验证,重跑任务即只补拷这些文件。
#[tauri::command(async)]
pub fn retry_copy_file<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    task_id: String,
    _file_id: String,
) -> CmdResult<()> {
    resume_copy_task(app, state, task_id)
}
