//! 分类工作台命令层(M2):契约见 src/api/types.ts。
//! - 分页列素材(缩略图经 thumb:// 协议按需读取,未索引到为 None → UI 占位);
//! - 后台索引线程:首次列出即启动,进度经 `index://progress` 推送,失败计数可见;
//! - 批量操作返回 BulkResult(部分失败逐条给原因);
//! - 连拍分组(groupId)v1 不实现,归 M3 AI 选片聚类——如实声明,不糊弄。

use super::notify;
use super::{find_project, nas_root, operator, AppState};
use crate::core::{copy, media, project, sorting};
use chrono::Utc;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

pub const INDEX_EVENT: &str = "index://progress";
pub const JOB_EVENT: &str = "job://progress";

type CmdResult<T> = std::result::Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// 本机「交付 ↔ 分类/回收站」互斥(终审修复:原子、可单测、panic 安全)。
/// - 分类/回收站变更命令持 [`SortingGuard`] 直到操作结束;
/// - 交付打包持 [`DeliveryGuard`];两边在获取时互相检查,检查与占位在同一锁内,
///   不存在「检查通过后对方才置位」的重叠窗口;
/// - Guard 走 Drop 释放:任何 panic/早退都不会把闸永久卡死。
///
/// 跨机互斥是 M3 前置(无锁 NAS,已声明边界)。
#[derive(Default, Clone)]
pub struct OpsMutex(std::sync::Arc<Mutex<OpsState>>);

#[derive(Default)]
struct OpsState {
    delivering: Option<String>,
    sorting_ops: usize,
}

/// owned guard(M3 W2:作业线程要把 guard 带走,生命周期不能借命令栈)。
pub struct SortingGuard(std::sync::Arc<Mutex<OpsState>>);
pub struct DeliveryGuard(std::sync::Arc<Mutex<OpsState>>);

impl OpsMutex {
    fn lock(&self) -> std::sync::MutexGuard<'_, OpsState> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
    pub fn begin_sorting(&self, project_id: &str) -> std::result::Result<SortingGuard, String> {
        let mut st = self.lock();
        if st.delivering.as_deref() == Some(project_id) {
            return Err("交付打包进行中,分类与回收站操作已暂停,请等打包完成".into());
        }
        st.sorting_ops += 1;
        Ok(SortingGuard(self.0.clone()))
    }
    pub fn begin_delivery(&self, project_id: &str) -> std::result::Result<DeliveryGuard, String> {
        let mut st = self.lock();
        if st.delivering.is_some() {
            return Err("已有交付打包在进行中,请等它完成".into());
        }
        if st.sorting_ops > 0 {
            return Err("有分类/回收站操作正在进行,请稍候片刻再开始打包".into());
        }
        st.delivering = Some(project_id.to_string());
        Ok(DeliveryGuard(self.0.clone()))
    }
}

impl Drop for SortingGuard {
    fn drop(&mut self) {
        let mut st = self.0.lock().unwrap_or_else(|p| p.into_inner());
        st.sorting_ops = st.sorting_ops.saturating_sub(1);
    }
}

impl Drop for DeliveryGuard {
    fn drop(&mut self) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).delivering = None;
    }
}

/// fsx 最后回退(检查+改名)被使用过:发一次性告警(零静默,复验轮二 P1)。
/// 同点位顺带消费时间戳保留失败计数(拷贝路径共用的收尾钩子)。
pub(crate) fn notify_if_unsafe_fallback<R: tauri::Runtime>(app: &AppHandle<R>) {
    if crate::core::fsx::take_unsafe_fallback_flag() {
        notify::warn(
            app,
            "fsx-fallback-window",
            "当前文件系统不支持原子防覆盖改名与硬链接,零覆盖保障退化为「发布锁 + 复查后改名」:两个任务同时往同一路径写由发布锁串行,残余边界是崩溃残留锁的两分钟回收;建议确认 NAS 协议(SMB3/NFSv4)".into(),
        );
    }
    let left = crate::core::fsx::take_leftover_sources();
    if left > 0 {
        notify::warn(
            app,
            "fsx-leftover-temp",
            format!("{left} 个文件已正确落位,但落位后的临时名没删掉(多半是杀毒软件 / 索引器还占着);它们不影响内容,下次开拷前的清扫或启动清理会收走"),
        );
    }
    let n = crate::core::fsx::take_times_preserve_failures();
    if n > 0 {
        notify::warn(
            app,
            "timestamps-not-preserved",
            format!("{n} 个文件的源时间戳未能保留(目标文件系统限制或权限);文件内容不受影响"),
        );
    }
    let u = crate::core::fsx::take_uncached_fallbacks();
    if u > 0 {
        notify::info(
            app,
            "verify-cache-fallback",
            format!("{u} 次校验回读未能绕过系统缓存(内核拒绝直读请求);校验仍执行,但覆盖介质错误的能力退化为普通读"),
        );
    }
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
    /// 缩略图缓存已就绪(索引完成刷新判据——thumbnail 为 URL 后不能再用其存在性判断)。
    pub thumb_ready: bool,
    pub kind: &'static str,
    /// 客观分析判定(未分析为 None;AI 只标注不动文件)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub judgement: Option<crate::core::analysis::AssetJudgement>,
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
    /// 稳定机器码(交付打包用): "name-collision" | "error" | "manifest-error";
    /// 批量分类操作暂缺省。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
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
    /// 索引期间被移走/删除的文件数(信息性,不是失败)。
    pub missing: usize,
    /// 索引轮次(重启 +1)。前端用它区分「新一轮」与「同轮重复事件」。
    pub round: u64,
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
    /// 索引期间被移走/删除的文件(不算失败,不触发损坏告警,评审 M3)。
    pub missing: usize,
    pub running: bool,
    /// 待分类清单指纹(相对路径+大小+mtime):文件改名/替换但总数不变时也要重索引(评审 M4)。
    pub fingerprint: u64,
    /// 索引轮次:每次重启 +1。前端跨轮事件(数值恰好相同也)靠它区分(复验轮二 P1)。
    pub round: u64,
}

/// 待分类清单条目:相对路径、大小、mtime 纳秒(一次 stat,指纹与缓存键共用,
/// 复验 P2:不做第二次全量 stat)。
type InboxFile = (String, u64, u128);

/// 待分类清单指纹:路径+大小+mtime。带 mtime 才能捕捉「同名同大小替换」
/// (codex 复验 15)。
fn inbox_fingerprint(files: &[InboxFile]) -> u64 {
    let mut key = String::new();
    for (rel, size, mtime) in files {
        key.push_str(rel);
        key.push('\u{0}');
        key.push_str(&size.to_string());
        key.push('\u{0}');
        key.push_str(&mtime.to_string());
        key.push('\n');
    }
    xxhash_rust::xxh3::xxh3_64(key.as_bytes())
}

#[derive(Default)]
pub struct IndexManager(pub Mutex<HashMap<String, IndexState>>);

fn emit_index_progress<R: tauri::Runtime>(app: &AppHandle<R>, project_id: &str, st: &IndexState) {
    let _ = app.emit(
        INDEX_EVENT,
        &IndexProgressEventDto {
            status: IndexingStatusDto {
                project_id: project_id.to_string(),
                indexed: st.indexed,
                total: st.total,
                running: st.running,
                failed: st.failed,
                missing: st.missing,
                round: st.round,
            },
            occurred_at: Utc::now().to_rfc3339(),
        },
    );
}

/// 需要时启动该项目的后台索引线程(幂等:已在跑则不重复)。
fn ensure_indexing<R: tauri::Runtime>(
    app: &AppHandle<R>,
    project_id: &str,
    project_root: &Path,
    files: &[InboxFile],
) {
    // 空清单不 spawn 线程:没活可干还发 0/0 事件纯属浪费(复验 P2)
    if files.is_empty() {
        return;
    }
    let fingerprint = inbox_fingerprint(files);
    let mgr = app.state::<IndexManager>();
    {
        let mut map = mgr.0.lock().unwrap();
        let st = map.entry(project_id.to_string()).or_default();
        if st.running {
            return;
        }
        // 已全部索引且清单指纹没变:不重启(计数相同但文件被替换时指纹会变)
        if st.fingerprint == fingerprint
            && st.indexed + st.failed + st.missing >= st.total
            && st.total > 0
        {
            return;
        }
        *st = IndexState {
            indexed: 0,
            total: files.len(),
            failed: 0,
            missing: 0,
            running: true,
            fingerprint,
            round: st.round + 1,
        };
    }
    let app = app.clone();
    let project_id = project_id.to_string();
    let project_root = project_root.to_path_buf();
    let files: Vec<InboxFile> = files.to_vec();
    std::thread::spawn(move || {
        // 整体兜底:图像解码库对畸形文件可能 panic,索引线程死了必须可见,
        // 且状态要收尾(running=false),不能永远显示「索引中」(评审 M3)
        let loop_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut last_emit = std::time::Instant::now();
            for (rel, _, _) in &files {
                let abs = project_root.join(rel.split('/').collect::<PathBuf>());
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    media::index_asset(&project_root, &abs, rel)
                }));
                let mgr = app.state::<IndexManager>();
                let mut map = mgr.0.lock().unwrap();
                let st = map.entry(project_id.clone()).or_default();
                match outcome {
                    Ok(Ok(i))
                        if i.thumb.is_some() || !matches!(i.kind, media::AssetKind::Photo) =>
                    {
                        st.indexed += 1;
                    }
                    // 文件在索引期间被分类走/删除:不是损坏,单独计数(评审 M3)。
                    // 除 metadata 阶段的 NotFound 外,解码阶段发现文件已消失
                    // 也算 missing(codex 复验 12)
                    Ok(Err(crate::core::CoreError::Io(e)))
                        if e.kind() == std::io::ErrorKind::NotFound =>
                    {
                        st.missing += 1;
                    }
                    Ok(_) if !abs.exists() => st.missing += 1,
                    _ => st.failed += 1,
                }
                let snapshot = st.clone();
                drop(map);
                if last_emit.elapsed().as_millis() >= 500 {
                    last_emit = std::time::Instant::now();
                    emit_index_progress(&app, &project_id, &snapshot);
                }
            }
        }));
        let mgr = app.state::<IndexManager>();
        // 收尾必须成功:即使锁被循环里的 panic 毒化也要把 running 拉回 false,
        // 否则界面永远显示「索引中」(复验 P2)
        let mut map = match mgr.0.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let st = map.entry(project_id.clone()).or_default();
        st.running = false;
        let snapshot = st.clone();
        drop(map);
        emit_index_progress(&app, &project_id, &snapshot);
        notify_if_unsafe_fallback(&app);
        if loop_result.is_err() {
            notify::error(
                &app,
                "index-thread-panicked",
                "素材索引线程异常终止(可能遇到严重畸形的文件),部分素材无预览;重新进入分类页可重试"
                    .into(),
            );
            return;
        }
        // 零静默:真失败(损坏/不支持)给告警;被移走的只给提示,不吓唬人
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
        if snapshot.missing > 0 {
            notify::info(
                &app,
                "index-files-moved",
                format!(
                    "{} 个文件在索引期间被移动或删除(可能是本机或其他工作站在分类),已跳过",
                    snapshot.missing
                ),
            );
        }
    });
}

// ---------- 命令 ----------

pub(crate) fn inbox_files_for_analysis<R: tauri::Runtime>(
    app: &AppHandle<R>,
    project_root: &Path,
) -> CmdResult<Vec<InboxFile>> {
    inbox_rel_files(app, project_root)
}

fn inbox_rel_files<R: tauri::Runtime>(
    app: &AppHandle<R>,
    project_root: &Path,
) -> CmdResult<Vec<InboxFile>> {
    let inbox = project_root.join(project::PENDING_DIR_B);
    let scanned = copy::scan_source(&inbox);
    // R10:扫描期跳过的链接/隐藏项必须取走并告警——这里此前从不取,
    // 计数会留到下一次拷卡操作头上,把别人的告警数字算错
    super::notice_scan_skips(app);
    let mut files: Vec<InboxFile> = scanned
        .map_err(err)?
        .into_iter()
        .map(|f| {
            // 相对路径补上「1. 待分类/」前缀,作为项目内稳定 id;
            // mtime 由扫描一次取齐(指纹/缩略图缓存键共用)
            (
                format!("{}/{}", project::PENDING_DIR_B, f.rel),
                f.size,
                f.mtime_ns,
            )
        })
        .collect();
    files.sort();
    Ok(files)
}

fn asset_dto(
    project_root: &Path,
    project_id: &str,
    rel: &str,
    size: u64,
    mtime: u128,
    judgement: Option<crate::core::analysis::AssetJudgement>,
) -> SortingAssetDto {
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
    let thumb_path = media::cached_thumb_path(project_root, rel, size, mtime);
    // 命中也要验完整性:半截缓存宁可占位也不端破图给界面(复验 P2)。
    // W4:不再内联 base64,就绪时给 thumb:// URL(协议层再过一次闸)
    let thumb_ready = thumb_path.is_file() && media::looks_like_valid_jpeg(&thumb_path);
    let thumb = thumb_ready.then(|| {
        super::thumb_proto::thumb_url(
            project_id,
            &thumb_path.file_name().unwrap_or_default().to_string_lossy(),
        )
    });
    SortingAssetDto {
        id: rel.to_string(),
        file_name: rel.rsplit('/').next().unwrap_or(rel).to_string(),
        size_bytes: size,
        shot_at: shot_at.map(|t| t.to_rfc3339()),
        shot_at_fallback: shot_at.is_some().then_some(fallback).filter(|f| *f),
        thumbnail: thumb,
        thumb_ready,
        judgement,
        kind: match kind {
            media::AssetKind::Photo => "photo",
            media::AssetKind::Raw => "raw",
            media::AssetKind::Video => "video",
            media::AssetKind::Other => "other",
        },
        group_id: None, // 由 list_pending_assets 按 judgement 填充
    }
}

#[tauri::command(async)]
pub fn list_pending_assets<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    project_id: String,
    offset: usize,
    limit: usize,
) -> CmdResult<AssetPageDto> {
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    let mut files = inbox_rel_files(&app, &stats.root)?;
    ensure_indexing(&app, &project_id, &stats.root, &files);

    // 客观分析判定:特征缓存 + 查询时确定性聚类(计划 C5)。
    // 有分析结果时列表改按拍摄时间排序;分页窗口尾部按组延展(评审 #25:
    // 「不跨页」由这里真正保证,不再只是注释宣称)。
    let (features, feat_skipped, feat_read_err) = cached_features(&stats.root);
    // R2 P1:分析缓存读不了/坏行时,AI 角标会整体消失——必须可见,不许静默
    if let Some(e) = feat_read_err {
        notify::warn(
            &app,
            "analysis-cache-degraded",
            format!("{e};本页 AI 分析结果暂不可用"),
        );
    } else if feat_skipped > 0 {
        notify::warn(
            &app,
            "analysis-cache-degraded",
            format!("分析特征缓存有 {feat_skipped} 行损坏被跳过,相关素材显示为未分析"),
        );
    }
    let judgements = if features.is_empty() {
        Default::default()
    } else {
        let mut ordered: Vec<(
            String,
            Option<i64>,
            Option<crate::core::analysis::FeatureRecord>,
        )> = files
            .iter()
            .map(|(rel, size, mtime)| {
                let f = features
                    .get(&crate::core::analysis::src_fingerprint(rel, *size, *mtime))
                    .cloned();
                (rel.clone(), f.as_ref().and_then(|f| f.shot_at_epoch), f)
            })
            .collect();
        ordered.sort_by(|a, b| (a.1, &a.0).cmp(&(b.1, &b.0)));
        let j = crate::core::analysis::judge(&ordered);
        // 列表顺序与聚类顺序一致(时间序;未分析件按 None 排前,组不与其交错)
        let order: std::collections::HashMap<&str, usize> = ordered
            .iter()
            .enumerate()
            .map(|(i, (rel, _, _))| (rel.as_str(), i))
            .collect();
        files.sort_by_key(|(rel, _, _)| order.get(rel.as_str()).copied().unwrap_or(usize::MAX));
        j
    };

    let total = files.len();
    // 页窗口:尾部若切断连拍组,延展到组尾(组大小有限,延展有界)
    let start = offset.min(total);
    let mut end = (start + limit.min(200)).min(total);
    if end > start && end < total {
        let gid_of = |i: usize| judgements.get(&files[i].0).and_then(|j| j.group_id.clone());
        if let Some(gid) = gid_of(end - 1) {
            while end < total && gid_of(end) == Some(gid.clone()) {
                end += 1;
            }
        }
    }
    let items = files[start..end]
        .iter()
        .map(|(rel, size, mtime)| {
            let mut dto = asset_dto(
                &stats.root,
                &project_id,
                rel,
                *size,
                *mtime,
                judgements.get(rel).cloned(),
            );
            dto.group_id = dto.judgement.as_ref().and_then(|j| j.group_id.clone());
            dto
        })
        .collect();
    Ok(AssetPageDto { items, total })
}

/// 特征内存缓存(评审 #25 性能项):键=项目根,失效=features-*.jsonl 的
/// (数量, 最大 mtime, mtime+大小指纹和) 变化——分页翻页不再每页全量重读 NAS。
/// (R2 P1:仅 (数量,最大 mtime) 对「非最大文件变化」与粗粒度 NAS mtime 失明,
/// 指纹和补上这两个盲区;目录读错如实上浮,不缓存错误态。)
type FeaturesCacheMap = HashMap<
    PathBuf,
    (
        (usize, std::time::SystemTime, u64),
        std::collections::HashMap<u64, crate::core::analysis::FeatureRecord>,
        usize,
    ),
>;
static FEATURES_CACHE: Mutex<Option<FeaturesCacheMap>> = Mutex::new(None);

fn cached_features(
    project_root: &Path,
) -> (
    std::collections::HashMap<u64, crate::core::analysis::FeatureRecord>,
    usize,
    Option<String>,
) {
    let dir = crate::core::analysis::analysis_dir(project_root);
    let mut count = 0usize;
    let mut max_mtime = std::time::SystemTime::UNIX_EPOCH;
    let mut fp_sum = 0u64;
    // R4(终审 P0-8):键枚举中的任何错误(read_dir/条目/metadata)都不许
    // 静默吞——出错即旁路缓存直读 load_features(那里会把读错如实上浮),
    // 也绝不把错误态写进缓存(避免「零键命中旧空缓存抹掉 read_err」)。
    let mut enum_err = false;
    match std::fs::read_dir(&dir) {
        Ok(entries) => {
            for e in entries {
                let Ok(e) = e else {
                    enum_err = true;
                    continue;
                };
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with("features-") && name.ends_with(".jsonl") {
                    count += 1;
                    match e.metadata().and_then(|m| m.modified().map(|t| (m, t))) {
                        Ok((m, t)) => {
                            max_mtime = max_mtime.max(t);
                            let nanos = t
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_nanos() as u64)
                                .unwrap_or(0);
                            fp_sum = fp_sum.wrapping_add(xxhash_rust::xxh3::xxh3_64(
                                format!("{name}\u{0}{}\u{0}{nanos}", m.len()).as_bytes(),
                            ));
                        }
                        Err(_) => enum_err = true,
                    }
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => enum_err = true,
    }
    let key = (count, max_mtime, fp_sum);
    if !enum_err {
        let cache = FEATURES_CACHE.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(map) = cache.as_ref() {
            if let Some((k, feats, skipped)) = map.get(project_root) {
                if *k == key {
                    return (feats.clone(), *skipped, None);
                }
            }
        }
    }
    let (feats, skipped, read_err) = crate::core::analysis::load_features(project_root);
    if read_err.is_none() && !enum_err {
        FEATURES_CACHE
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get_or_insert_with(Default::default)
            .insert(project_root.to_path_buf(), (key, feats.clone(), skipped));
    }
    (feats, skipped, read_err)
}

#[tauri::command(async)]
pub fn list_categories<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    project_id: String,
) -> CmdResult<Vec<SortingCategoryDto>> {
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    let listed = sorting::list_categories(&stats.root, &stats.meta);
    // R13 D2:分类计数扫描跳过的符号链接必须可见(失败出口也要取走计数,
    // 留着会算到下一次操作头上)。角标数字与正式扫描同口径,不许静默分叉。
    crate::commands::notice_scan_skips(&app);
    Ok(listed
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
                kind: None,
            }),
        }
    }
    res
}

/// 批量操作的审计事件(汇总一条,失败逐项列出)。
#[allow(clippy::too_many_arguments)]
fn invalidate_catalog(project_root: &Path) {
    if let Some(nas) = project_root.parent() {
        crate::core::catalog::invalidate_cache(nas);
    }
}

fn audit_bulk<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &State<AppState>,
    project_root: &Path,
    kind: &str,
    detail: &str,
    result: &BulkResultDto,
) {
    invalidate_catalog(project_root);
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

#[tauri::command(async)]
pub fn move_assets<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    project_id: String,
    asset_ids: Vec<String>,
    category_id: String,
) -> CmdResult<BulkResultDto> {
    let _ops = state.ops.begin_sorting(&project_id)?;
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    // 分类夹白名单:必须是该项目已知分类;精选是复制语义,走 curate_assets,
    // move 到精选一律拒绝(codex 评审 11:防止素材被移出流程)
    let cats = sorting::list_categories(&stats.root, &stats.meta);
    // 同上:这条路径也会走分类计数扫描,跳过的链接同样要取走并告警
    crate::commands::notice_scan_skips(&app);
    let cats = cats.map_err(err)?;
    match cats.iter().find(|c| c.id == category_id) {
        Some(c) if c.kind == "custom" || c.kind == "other" => {}
        Some(c) if c.kind == "curated" => {
            return Err("「精选」是复制语义,请使用精选操作(curate),不能移动进精选夹".into())
        }
        _ => return Err(format!("未知分类: {category_id}")),
    }
    let res = bulk(sorting::move_assets(
        &stats.root,
        &stats.meta,
        &asset_ids,
        &category_id,
    ));
    notify_if_unsafe_fallback(&app);
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

#[tauri::command(async)]
pub fn curate_assets<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    project_id: String,
    asset_ids: Vec<String>,
) -> CmdResult<BulkResultDto> {
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    let _ops = state.ops.begin_sorting(&project_id)?;
    let res = bulk(sorting::curate_assets(&stats.root, &stats.meta, &asset_ids));
    notify_if_unsafe_fallback(&app);
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

#[tauri::command(async)]
pub fn trash_assets<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    project_id: String,
    asset_ids: Vec<String>,
) -> CmdResult<BulkResultDto> {
    let _ops = state.ops.begin_sorting(&project_id)?;
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    let op = operator(&app, &state);
    let res = bulk(sorting::trash_assets(
        &stats.root,
        &stats.meta,
        &asset_ids,
        &op,
    ));
    notify_if_unsafe_fallback(&app);
    // 「文件滞留回收站」是数据位置异常(既不在原位也不在索引),升级为 error 通知
    let stranded = res
        .failed
        .iter()
        .filter(|f| f.message.contains(sorting::STRANDED_MARKER))
        .count();
    if stranded > 0 {
        notify::error(
            &app,
            "trash-file-stranded",
            format!(
                "{stranded} 个文件移入回收站后索引写入失败且无法还原,滞留在回收站目录中;它们会显示为孤儿文件,需人工处理"
            ),
        );
    }
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

#[tauri::command(async)]
pub fn list_trash<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    project_id: String,
) -> CmdResult<Vec<TrashEntryDto>> {
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    let list = sorting::list_trash(&stats.root).map_err(err)?;
    if list.skipped > 0 {
        notify::warn(
            &app,
            "trash-index-degraded",
            format!(
                "回收站索引有 {} 行损坏或非法被跳过,列表可能不完整",
                list.skipped
            ),
        );
    }
    if !list.orphans.is_empty() {
        notify::warn(
            &app,
            "trash-orphan-files",
            format!(
                "回收站目录中有 {} 个无索引的孤儿文件(通常来自索引写入失败),它们不会被「清空回收站」删除,需人工在 .ocard/trash 下核查: {}",
                list.orphans.len(),
                list.orphans.join("、")
            ),
        );
    }
    Ok(list
        .records
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

#[tauri::command(async)]
pub fn restore_from_trash<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    project_id: String,
    entry_ids: Vec<String>,
) -> CmdResult<BulkResultDto> {
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    let _ops = state.ops.begin_sorting(&project_id)?;
    let restored =
        sorting::restore_from_trash(&stats.root, &stats.meta, &entry_ids).map_err(err)?;
    if restored.tombstone_errors > 0 {
        notify::warn(
            &app,
            "trash-tombstone-failed",
            format!(
                "{} 条恢复记录的索引标记写入失败(文件已恢复原位,不影响数据);回收站列表可能短暂显示陈旧条目",
                restored.tombstone_errors
            ),
        );
    }
    let res = bulk(restored.items);
    notify_if_unsafe_fallback(&app);
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmptyTrashResultDto {
    pub removed: usize,
    pub failed: usize,
}

#[tauri::command(async)]
pub fn empty_trash<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    project_id: String,
) -> CmdResult<EmptyTrashResultDto> {
    let _ops = state.ops.begin_sorting(&project_id)?;
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    let out = sorting::empty_trash(&stats.root).map_err(err)?;
    notify_if_unsafe_fallback(&app);
    let op = operator(&app, &state);
    super::tasks::append_audit(
        &app,
        &stats.root,
        &state.config_dir,
        &sorting::audit_event(
            &state.machine_id,
            &op,
            sorting::kind::TRASH_EMPTIED,
            serde_json::json!({ "deleted": out.deleted, "failed": out.failed }),
        ),
    );
    if let Some(e) = &out.index_rewrite_error {
        notify::warn(
            &app,
            "trash-index-rewrite-failed",
            format!(
                "清空回收站:文件已按结果删除,但索引更新失败({e});陈旧条目会在下次打开回收站时自动过滤"
            ),
        );
    }
    if out.failed > 0 {
        notify::warn(
            &app,
            "trash-empty-partial",
            format!(
                "清空回收站:{} 个已删除,{} 个删除失败(索引已保留,可重试)",
                out.deleted, out.failed
            ),
        );
    }
    Ok(EmptyTrashResultDto {
        removed: out.deleted,
        failed: out.failed,
    })
}

#[tauri::command(async)]
pub fn indexing_status<R: tauri::Runtime>(
    app: AppHandle<R>,
    project_id: String,
) -> IndexingStatusDto {
    let mgr = app.state::<IndexManager>();
    let map = mgr.0.lock().unwrap();
    let st = map.get(&project_id).cloned().unwrap_or_default();
    IndexingStatusDto {
        project_id,
        indexed: st.indexed,
        total: st.total,
        running: st.running,
        failed: st.failed,
        missing: st.missing,
        round: st.round,
    }
}

// ---------- 交付打包 ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryPackageDto {
    pub name: String,
    pub file_count: usize,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverySummaryDto {
    pub packages: Vec<DeliveryPackageDto>,
    pub total_files: usize,
    pub total_bytes: u64,
    /// 重跑时已在包内且 hash 校验一致的文件数(安全跳过,不算失败)。
    pub already_delivered: usize,
    pub failures: Vec<BulkFailure>,
    /// 交付根目录绝对路径(人工上传百度网盘的入口)。
    pub delivery_path: String,
}

/// 执行交付打包(PRD §5.7):半天分包、复制不动原件、清单落盘;
/// 上传与发链接人工完成(既定边界)。重跑安全(零覆盖,已打包项报失败)。
#[tauri::command(async)]
pub fn start_delivery<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    project_id: String,
) -> CmdResult<crate::core::jobs::JobSnapshot> {
    use crate::core::jobs::{JobKind, JobSnapshot};
    let jobs = app
        .state::<std::sync::Arc<crate::core::jobs::JobManager>>()
        .inner()
        .clone();
    if jobs.has_active(JobKind::Delivery, &project_id) {
        return Err("该项目已有交付打包作业在进行中".into());
    }
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;

    let handle = jobs.create(JobKind::Delivery, &project_id);
    let ops = state.ops.clone();
    let pid = project_id.clone();
    let machine_id = state.machine_id.clone();
    let config_dir = state.config_dir.clone();
    let op = operator(&app, &state);
    let root = stats.root.clone();
    let meta = stats.meta.clone();
    let body_app = app.clone();
    let event_app = app.clone();
    let body_handle = handle.clone();

    jobs.run(
        handle.clone(),
        move || ops.begin_delivery(&pid),
        move |h| {
            let mut last_emit = std::time::Instant::now();
            let out = crate::core::packaging::build_delivery_with(
                &root,
                &meta,
                &mut |done, total, bytes, current| {
                    h.progress(done, total, bytes, Some(current.to_string()));
                    if last_emit.elapsed().as_millis() >= 500 {
                        last_emit = std::time::Instant::now();
                        let _ = body_app.emit(JOB_EVENT, &h.snapshot());
                    }
                },
                &|| h.cancel_requested(),
            )
            .map_err(|e| e.to_string())?;
            invalidate_catalog(&root);
            notify_if_unsafe_fallback(&body_app);
            for w in &out.warnings {
                notify::warn(&body_app, "delivery-scan-degraded", w.clone());
            }

            // 包表用目标目录实况总量(重跑时不显示 0,codex 复验 P1)
            let packages: Vec<DeliveryPackageDto> = out
                .package_totals
                .iter()
                .map(|(name, file_count, bytes)| DeliveryPackageDto {
                    name: name.clone(),
                    file_count: *file_count,
                    bytes: *bytes,
                })
                .collect();
            let failures: Vec<BulkFailure> = out
                .failures
                .iter()
                .map(|(path, kind, message)| BulkFailure {
                    asset_id: path.clone(),
                    message: message.clone(),
                    kind: Some(kind),
                })
                .collect();

            // 审计:取消与完成分事件,取消也留痕(计划 W2)
            let audit_kind = if out.cancelled {
                "delivery_cancelled"
            } else {
                "delivery_built"
            };
            super::tasks::append_audit(
                &body_app,
                &root,
                &config_dir,
                &sorting::audit_event(
                    &machine_id,
                    &op,
                    audit_kind,
                    serde_json::json!({
                        "packages": out.packages,
                        "files": out.files.len(),
                        "bytes": out.total_bytes,
                        "alreadyDelivered": out.already_delivered,
                        "failures": failures.len(),
                        "cancelled": out.cancelled,
                    }),
                ),
            );
            if out.cancelled {
                notify::warn(
                    &body_app,
                    "job-cancelled",
                    format!(
                        "交付打包已取消:本轮已复制 {} 个文件(清单按实况更新,重跑会从断点安全续打)",
                        out.files.len()
                    ),
                );
            }
            if !failures.is_empty() {
                let collisions = failures
                    .iter()
                    .filter(|f| f.kind == Some("name-collision"))
                    .count();
                let msg = if collisions > 0 {
                    format!(
                        "交付打包完成,但 {} 个文件未交付,其中 {collisions} 个是同名不同内容的冲突,需人工核对包内文件(详见交付总清单)",
                        failures.len()
                    )
                } else {
                    format!(
                        "交付打包完成,但 {} 个文件失败(详见交付总清单)",
                        failures.len()
                    )
                };
                notify::warn(&body_app, "delivery-partial", msg);
            }
            let summary = DeliverySummaryDto {
                packages,
                total_files: out.files.len(),
                total_bytes: out.total_bytes,
                already_delivered: out.already_delivered,
                failures,
                delivery_path: root
                    .join(crate::core::packaging::DELIVERY_DIR)
                    .display()
                    .to_string(),
            };
            serde_json::to_value(summary).map_err(|e| e.to_string())
        },
        move |s: JobSnapshot| {
            let _ = event_app.emit(JOB_EVENT, &s);
        },
    );
    Ok(body_handle.snapshot())
}

#[tauri::command(async)]
pub fn list_jobs<R: tauri::Runtime>(app: AppHandle<R>) -> Vec<crate::core::jobs::JobSnapshot> {
    app.state::<std::sync::Arc<crate::core::jobs::JobManager>>()
        .snapshots()
}

#[tauri::command(async)]
pub fn get_job<R: tauri::Runtime>(
    app: AppHandle<R>,
    job_id: String,
) -> Option<crate::core::jobs::JobSnapshot> {
    app.state::<std::sync::Arc<crate::core::jobs::JobManager>>()
        .get(&job_id)
        .map(|h| h.snapshot())
}

#[tauri::command(async)]
pub fn cancel_job<R: tauri::Runtime>(
    app: AppHandle<R>,
    job_id: String,
) -> CmdResult<crate::core::jobs::JobSnapshot> {
    let jobs = app.state::<std::sync::Arc<crate::core::jobs::JobManager>>();
    // running 的作业由 worker 在安全点收尾;这里返回请求后的快照
    match jobs.request_cancel(&job_id) {
        Some(s) => {
            // 零静默:取消请求本身可见(排队取消立即终态,运行中在安全点生效;
            // R2 P2:已终态的作业如实说「无需取消」,不许谎称「将停止」)
            notify::info(
                &app,
                "job-cancelled",
                if s.state == crate::core::jobs::JobState::Cancelled {
                    "作业已取消".to_string()
                } else if s.state.is_terminal() {
                    "该作业已经结束,无需取消".to_string()
                } else {
                    "已请求取消,作业将在当前文件完成后停止".to_string()
                },
            );
            // R5 终审:排队期被取消的 auto_proxy 作业没有 body 出口——
            // 在这里按 job 释放 intent 登记(幂等,运行中作业由出口 guard 负责)
            if s.kind == crate::core::jobs::JobKind::Transcode
                && s.state == crate::core::jobs::JobState::Cancelled
            {
                super::transcode_cmds::intent_release_by_job(&s.id);
            }
            let _ = app.emit(JOB_EVENT, &s);
            Ok(s)
        }
        None => jobs
            .get(&job_id)
            .map(|h| h.snapshot())
            .ok_or_else(|| format!("作业不存在: {job_id}")),
    }
}

// ---------- 跨机活动可见(规范 §6.3,M2 技术债) ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteActivityDto {
    /// "copy" | "transcode"(前端按类型措辞)。
    pub activity: &'static str,
    pub machine: String,
    pub operator: String,
    pub volume: String,
    pub camera: String,
    pub target_folder: String,
    pub started_at: String,
}

/// 其他工作站在本项目上进行中的拷卡(copy_started 无对应 copy_completed,24h 内)。
/// 前端在拷卡屏轮询(约 10s),用于「避免重复拷同一张卡」。
/// 审计日志条目(v0.3.1 审计查看器;项目级 journal 合并倒序)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEventDto {
    pub ts: String,
    pub machine: String,
    pub operator: String,
    pub kind: String,
    pub data: serde_json::Value,
}

/// 项目全量审计日志(最新在前)。读取降级(坏行/坏文件)零静默上浮为 warning。
#[tauri::command(async)]
pub fn list_audit_log<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    project_id: String,
) -> CmdResult<Vec<AuditEventDto>> {
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    let read = crate::core::journal::read_all(&stats.root).map_err(err)?;
    if read.skipped_lines > 0 || read.unreadable_files > 0 {
        notify::warn(
            &app,
            "audit-log-degraded",
            format!(
                "审计日志有 {} 行损坏、{} 个文件不可读被跳过,列表可能不完整",
                read.skipped_lines, read.unreadable_files
            ),
        );
    }
    let mut out: Vec<AuditEventDto> = read
        .events
        .into_iter()
        .map(|e| AuditEventDto {
            ts: e.ts.to_rfc3339(),
            machine: e.machine,
            operator: e.operator,
            kind: e.kind,
            data: e.data,
        })
        .collect();
    out.reverse(); // read_all 升序 → 最新在前
    Ok(out)
}

#[tauri::command(async)]
pub fn list_remote_activity<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    project_id: String,
) -> CmdResult<Vec<RemoteActivityDto>> {
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    let read = crate::core::journal::read_all(&stats.root).map_err(err)?;
    if read.skipped_lines > 0 || read.unreadable_files > 0 {
        notify::warn(
            &app,
            "project-journal-degraded",
            format!(
                "项目日志有损坏数据(跳过 {} 行/{} 文件),跨机活动信息可能不完整",
                read.skipped_lines, read.unreadable_files
            ),
        );
    }
    let mut open: std::collections::HashMap<String, RemoteActivityDto> = Default::default();
    let cutoff = Utc::now() - chrono::Duration::hours(24);
    for ev in read.events {
        let task_id = ev
            .data
            .get("taskId")
            .or_else(|| ev.data.get("jobId"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        // 无 taskId 的事件配不成 started/completed 对,跳过,
        // 免得互相顶掉造成横幅误报(评审 L9)
        if task_id.is_empty() {
            continue;
        }
        match ev.kind.as_str() {
            k if k == crate::core::journal::kind::COPY_STARTED => {
                if ev.machine != state.machine_id && ev.ts >= cutoff {
                    let s = |key: &str| {
                        ev.data
                            .get(key)
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string()
                    };
                    open.insert(
                        task_id,
                        RemoteActivityDto {
                            activity: "copy",
                            machine: ev.machine.clone(),
                            operator: ev.operator.clone(),
                            volume: s("volume"),
                            camera: s("camera"),
                            target_folder: s("targetFolder"),
                            started_at: ev.ts.to_rfc3339(),
                        },
                    );
                }
            }
            k if k == crate::core::journal::kind::COPY_COMPLETED => {
                open.remove(&task_id);
            }
            // 他机转码可见(评审 #17;W6 明定)
            "transcode_started" => {
                if ev.machine != state.machine_id && ev.ts >= cutoff {
                    let folders = ev
                        .data
                        .get("folders")
                        .and_then(|v| v.as_str())
                        .unwrap_or("全部相机夹")
                        .to_string();
                    open.insert(
                        task_id,
                        RemoteActivityDto {
                            activity: "transcode",
                            machine: ev.machine.clone(),
                            operator: ev.operator.clone(),
                            volume: String::new(),
                            camera: folders.clone(),
                            target_folder: folders,
                            started_at: ev.ts.to_rfc3339(),
                        },
                    );
                }
            }
            "transcode_completed" | "transcode_cancelled" | "transcode_failed" => {
                open.remove(&task_id);
            }
            _ => {}
        }
    }
    let mut out: Vec<RemoteActivityDto> = open.into_values().collect();
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(out)
}

#[cfg(test)]
mod ops_mutex_tests {
    use super::OpsMutex;

    #[test]
    fn delivery_blocks_sorting_and_vice_versa() {
        let m = OpsMutex::default();
        let d = m.begin_delivery("p1").unwrap();
        // 交付中:同项目分类拒绝;其他项目不受影响
        assert!(m.begin_sorting("p1").is_err());
        assert!(m.begin_sorting("p2").is_ok());
        drop(d);
        // 释放后恢复
        let s = m.begin_sorting("p1").unwrap();
        // 分类进行中:交付拒绝(检查与占位同锁,无重叠窗口)
        assert!(m.begin_delivery("p1").is_err());
        drop(s);
        assert!(m.begin_delivery("p1").is_ok());
    }

    #[test]
    fn double_delivery_rejected_and_guard_drop_is_panic_safe() {
        let m = OpsMutex::default();
        let _d = m.begin_delivery("p1").unwrap();
        assert!(m.begin_delivery("p2").is_err());
        // panic 路径:guard 随栈展开释放,闸不会永久卡死
        let m2 = OpsMutex::default();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = m2.begin_delivery("p1").unwrap();
            panic!("boom");
        }));
        assert!(m2.begin_delivery("p1").is_ok(), "panic 后闸必须已释放");
    }

    #[test]
    fn concurrent_sorting_ops_counted() {
        let m = OpsMutex::default();
        let a = m.begin_sorting("p1").unwrap();
        let b = m.begin_sorting("p1").unwrap();
        drop(a);
        assert!(m.begin_delivery("p1").is_err(), "还有一个分类操作在途");
        drop(b);
        assert!(m.begin_delivery("p1").is_ok());
    }
}
