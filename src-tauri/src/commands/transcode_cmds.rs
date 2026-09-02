//! 转码底座命令层(M3 W5):sidecar 状态、硬编能力探测(后台线程+缓存)、
//! 诊断导出。转码作业本体在 W6。

use super::notify;
use crate::core::ffmpeg::{self, CapabilityReport};
use serde::Serialize;
use std::sync::Mutex;
use tauri::AppHandle;

type CmdResult<T> = std::result::Result<T, String>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum FfmpegStatusDto {
    /// sidecar 可用。
    Ready { info: ffmpeg::FfmpegInfo },
    /// sidecar 缺失/损坏:转码功能禁用态(零静默)。
    Missing { error: String },
}

/// sidecar 状态(设置页「能力」区;缺失时前端显示禁用态与原因)。
#[tauri::command(async)]
pub fn ffmpeg_status() -> FfmpegStatusDto {
    match ffmpeg::detect() {
        Ok(info) => FfmpegStatusDto::Ready { info },
        Err(error) => FfmpegStatusDto::Missing { error },
    }
}

/// 启动时检测一次:缺失立即给用户可见 error(计划零静默清单 ffmpeg-missing)。
pub fn notify_ffmpeg_missing_on_startup<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Err(e) = ffmpeg::detect() {
        notify::error(
            app,
            "ffmpeg-missing",
            format!("转码引擎不可用({e}):转码相关功能已禁用;请重新安装应用或联系维护者"),
        );
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum CapabilityStateDto {
    Idle,
    Probing,
    Ready { report: CapabilityReport },
    Failed { error: String },
}

enum ProbeState {
    Idle,
    Probing,
    Ready(CapabilityReport),
    Failed(String),
}

static PROBE_STATE: Mutex<ProbeState> = Mutex::new(ProbeState::Idle);

fn probe_state_dto() -> CapabilityStateDto {
    match &*PROBE_STATE.lock().unwrap_or_else(|p| p.into_inner()) {
        ProbeState::Idle => CapabilityStateDto::Idle,
        ProbeState::Probing => CapabilityStateDto::Probing,
        ProbeState::Ready(r) => CapabilityStateDto::Ready { report: r.clone() },
        ProbeState::Failed(e) => CapabilityStateDto::Failed { error: e.clone() },
    }
}

/// 硬编能力探测:首次(或 refresh=true)在后台线程跑真探针(每个 ≤12s,串行),
/// 前端轮询本命令直到 ready/failed。缓存驻内存;换驱动/外接 GPU 后用刷新按钮
/// 重探(缓存键不含驱动标识,属声明边界——探测本身就是权威)。
#[tauri::command(async)]
pub fn transcode_capabilities<R: tauri::Runtime>(
    app: AppHandle<R>,
    refresh: Option<bool>,
) -> CmdResult<CapabilityStateDto> {
    let should_start = {
        let mut st = PROBE_STATE.lock().unwrap_or_else(|p| p.into_inner());
        match &*st {
            ProbeState::Probing => false,
            ProbeState::Ready(_) if !refresh.unwrap_or(false) => false,
            ProbeState::Failed(_) if !refresh.unwrap_or(false) => false,
            _ => {
                *st = ProbeState::Probing;
                true
            }
        }
    };
    if should_start {
        let app = app.clone();
        std::thread::spawn(move || {
            let result = ffmpeg::probe_capabilities();
            let mut st = PROBE_STATE.lock().unwrap_or_else(|p| p.into_inner());
            match result {
                Ok(report) => {
                    // 零静默:硬编全军覆没只剩软编时明确告知
                    let has_hw = report.winners.keys().any(|k| k.ends_with("_hw"));
                    if !has_hw {
                        notify::warn(
                            &app,
                            "hwenc-fallback",
                            "未探测到可用的硬件编码器,转码将使用软件编码(速度较慢);若本机有独显/核显,请检查驱动".into(),
                        );
                    }
                    *st = ProbeState::Ready(report);
                }
                Err(e) => {
                    notify::warn(
                        &app,
                        "hwenc-probe-failed",
                        format!("编码能力探测失败({e}),转码功能暂不可用;可在设置页重试"),
                    );
                    *st = ProbeState::Failed(e);
                }
            }
        });
    }
    Ok(probe_state_dto())
}

/// 诊断导出(计划可选建议):版本/探测明细/最近状态 + 最近运行日志尾
/// (32KB,v0.3.1),不含任何素材路径。
#[tauri::command(async)]
pub fn transcode_diagnostics<R: tauri::Runtime>(app: AppHandle<R>) -> serde_json::Value {
    use tauri::Manager as _;
    let recent_log = app
        .path()
        .app_log_dir()
        .ok()
        .map(|d| d.join("ocard.log"))
        .and_then(|p| std::fs::read(&p).ok())
        .map(|bytes| {
            let tail = &bytes[bytes.len().saturating_sub(32 * 1024)..];
            String::from_utf8_lossy(tail).into_owned()
        })
        .unwrap_or_else(|| "(暂无运行日志)".into());
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "ffmpeg": match ffmpeg::detect() {
            Ok(i) => serde_json::to_value(i).unwrap_or_default(),
            Err(e) => serde_json::json!({"error": e}),
        },
        "capabilities": serde_json::to_value(probe_state_dto()).unwrap_or_default(),
        "recentLog": recent_log,
    })
}

// ---------- 转码作业(M3 W6) ----------

use super::sorting_cmds::JOB_EVENT;
use crate::core::jobs::{JobKind, JobManager, JobSnapshot};
use crate::core::{ffmpeg as ff, paths, project, sorting, transcode};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager};

/// 代理转码作业的最终结果(JobSnapshot.result)。
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxyResultDto {
    /// 显式判别字段(代理与归档共用 kind "transcode",前端按此分流,不做结构嗅探)。
    pub mode: &'static str,
    pub converted: usize,
    pub already_transcoded: usize,
    /// 未选中(非高负载)文件与逐条理由——跳过必须可见(计划 B6)。
    pub skipped: Vec<SkippedDto>,
    pub failures: Vec<FailureDto>,
    pub used_encoder: String,
    pub output_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedDto {
    pub rel: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureDto {
    pub rel: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyInput {
    pub project_id: String,
    /// 限定的相机夹(「2. 原始素材」下的一级子夹名);None=全部。
    pub camera_folders: Option<Vec<String>>,
    /// 整夹强制全转(只跳过高负载判定;**不**触碰已有输出)。
    pub force_all: Option<bool>,
    /// 强制重转(唯一覆盖入口,D2):先删既有代理再转;前端必须二次确认。
    pub retranscode: Option<bool>,
}

const VIDEO_EXTS: &[&str] = &["mp4", "mov", "avi", "mts", "m4v", "mxf", "mkv"];

fn is_video(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// 递归收集相机夹下全部视频(R2 P0:真实相机结构是嵌套的——
/// 典型 `PRIVATE/M4ROOT/CLIP/*.MP4`;只读第一层会把整夹判成零素材,
/// auto_proxy 反复触顶后错误放弃)。规则与拷卡扫描同源:
/// 系统项跳过([`crate::core::copy::is_system_item`]);符号链接不跟随
/// (进 skipped,可见);目录/目录项读取错误进 errors(零静默,阻止 intent 标完成)。
///
/// R12:此前这里是「点开头一律跳过」,与拷卡扫描已经分叉——拷卡会把 `.clip.mov`
/// 真的拷进「2. 原始素材」,转码却取不到它的源,于是**素材在 NAS 上、界面上都在,
/// 却永远没有代理**,而且没有任何提示。收口后反向也变好了:群晖的 `@eaDir`
/// 不以点开头,旧判据放行,它里面的 `SYNOPHOTO_FILM_*.mp4` 会被当成源素材去转码;
/// 共享名单把它列进去了。
///
/// 起点是「2. 原始素材/<相机夹>」,`.ocard/` 不在这棵树里;而拷卡断连留下的
/// `<名字>.<tag>.ocardpart` 半截文件就落在这棵树里,由共享名单的后缀项挡住。
fn collect_videos_recursive(
    dir: &Path,
    rel_dir: &str,
    out: &mut Vec<(PathBuf, String)>,
    errors: &mut Vec<String>,
    symlinks: &mut Vec<String>,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            errors.push(format!("{rel_dir}: 目录读取失败: {e}"));
            return;
        }
    };
    for e in entries {
        let e = match e {
            Ok(e) => e,
            Err(ee) => {
                errors.push(format!("{rel_dir}: 目录项读取失败: {ee}"));
                continue;
            }
        };
        let name = e.file_name().to_string_lossy().to_string();
        if crate::core::copy::is_system_item(&name) {
            continue;
        }
        let child_rel = format!("{rel_dir}/{name}");
        let ft = match e.file_type() {
            Ok(t) => t,
            Err(ee) => {
                errors.push(format!("{child_rel}: 类型读取失败: {ee}"));
                continue;
            }
        };
        if ft.is_symlink() {
            symlinks.push(child_rel);
            continue;
        }
        let p = e.path();
        if ft.is_dir() {
            collect_videos_recursive(&p, &child_rel, out, errors, symlinks);
        } else if ft.is_file() && is_video(&p) {
            out.push((p, child_rel));
        }
    }
}

/// 产物来源指纹 sidecar(R5 终审):`<产物>.src.json` 记录源 rel 与
/// 指纹 xxh3(rel+size+mtime)。同时长同几何的「合法」视频仍可能来自另一
/// 源文件——完整属性校验之外,身份由 sidecar 绑定;缺失/不符=不计完成。
fn provenance_path(final_out: &Path) -> PathBuf {
    let mut os = final_out.as_os_str().to_os_string();
    os.push(".src.json");
    PathBuf::from(os)
}

fn src_provenance_fp(rel: &str, abs: &Path) -> Option<u64> {
    let meta = std::fs::metadata(abs).ok()?;
    Some(crate::core::analysis::src_fingerprint(
        rel,
        meta.len(),
        crate::core::media::mtime_nanos(&meta),
    ))
}

/// R5 三票:写入必须**安全且 fail-closed**——不可预测独占临时名(可预测名
/// 可被预置成指向项目外的链接,fs::write 会跟随并截断外部文件)、临时/终名
/// 拒链接、任何失败向上返回(调用方不得计 converted)。sidecar 同时绑定
/// **产物哈希**(只绑源指纹时,保留旧 sidecar 换掉视频仍可通过)。
fn write_provenance(final_out: &Path, rel: &str, abs: &Path) -> std::result::Result<(), String> {
    let fp = src_provenance_fp(rel, abs).ok_or("源文件元数据不可读")?;
    let out_hash =
        crate::core::hash::xxh3_file(final_out).map_err(|e| format!("产物哈希失败: {e}"))?;
    let body = serde_json::json!({
        "srcRel": rel,
        "srcFingerprint": fp.to_string(),
        "outXxh3": out_hash,
    });
    let sidecar = provenance_path(final_out);
    if paths::is_symlink(&sidecar) {
        return Err("来源指纹位置是符号链接,拒绝写入".into());
    }
    let tmp = final_out.with_file_name(format!(".{}.srcjson.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, serde_json::to_vec(&body).unwrap_or_default())
        .map_err(|e| format!("来源指纹写入失败: {e}"))?;
    let _ = std::fs::remove_file(&sidecar); // 本作业刚落位产物,残留旧 sidecar 属陈旧态
    crate::core::fsx::rename_no_replace(&tmp, &sidecar).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("来源指纹落位失败: {e}")
    })
}

/// 校验既有产物的来源身份 + 产物自身哈希;Err 携带人话原因。
fn provenance_matches(final_out: &Path, rel: &str, abs: &Path) -> std::result::Result<(), String> {
    let p = provenance_path(final_out);
    if paths::is_symlink(&p) {
        return Err("来源指纹记录是符号链接,拒绝采信".into());
    }
    let text = std::fs::read_to_string(&p)
        .map_err(|_| "缺少来源指纹记录(.src.json),无法确认产物属于当前源".to_string())?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "来源指纹记录损坏".to_string())?;
    let want = src_provenance_fp(rel, abs).ok_or("源文件元数据不可读")?;
    if v["srcFingerprint"].as_str() != Some(want.to_string().as_str()) {
        return Err("来源指纹不符:该产物属于另一版本/另一文件的源".into());
    }
    // R5 三票:sidecar 还要钉住产物本身——否则「留旧 sidecar、换新视频」可绕过
    let cur = crate::core::hash::xxh3_file(final_out).map_err(|e| format!("产物哈希失败: {e}"))?;
    if v["outXxh3"].as_str() != Some(cur.as_str()) {
        return Err("产物哈希与指纹记录不符(产物被替换过)".into());
    }
    Ok(())
}

/// 转码作业出口保证(R4 终审 P1):body 从任何一条 `?` 提前失败退出时,
/// terminal 审计(transcode_failed)与 auto_proxy intent 登记都必须归位——
/// 否则他机「正在转码」横幅假活跃 24h,intent 卡到进程重启。
/// 正常收尾路径写完 completed/cancelled 审计后调用 `disarm`;
/// intent 登记的移除由本 guard 统一负责(幂等)。
struct TranscodeExitGuard<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
    root: PathBuf,
    config_dir: PathBuf,
    machine_id: String,
    op: String,
    job_id: String,
    armed: bool,
}

impl<R: tauri::Runtime> TranscodeExitGuard<R> {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl<R: tauri::Runtime> Drop for TranscodeExitGuard<R> {
    fn drop(&mut self) {
        // R5 终审:先持久化终态审计,**再**释放 intent——反序会留下
        // 「intent 已空、审计未落」的重调度窗口
        if self.armed {
            super::tasks::append_audit(
                &self.app,
                &self.root,
                &self.config_dir,
                &crate::core::journal::Event::new(
                    self.machine_id.clone(),
                    self.op.clone(),
                    "transcode_failed",
                    serde_json::json!({ "jobId": self.job_id }),
                ),
            );
        }
        intent_release_by_job(&self.job_id);
    }
}

/// 顶层相机夹枚举(R4 终审 P0-8:`.flatten()`+`unwrap_or(false)` 会把
/// 读不出的条目静默当不存在,整夹漏转)。错误逐条收进 errors,由调用方
/// 转失败清单(并阻止 auto_proxy intent 标完成)。
///
/// R12:排除口径收口到 [`crate::core::copy::is_system_item`]。旧的「点开头一律
/// 跳过」在这里两头都错:被误设隐藏属性的相机夹(`.A7M4_A`)整夹漏转,而群晖的
/// `@eaDir` 因为不以点开头反倒被当成一个「相机夹」递归进去。
///
/// 起点是「2. 原始素材」,`.ocard/` 是项目根的同级兄弟,不会出现在这一层。
/// 枚举结果随后还要过 `sorting::resolve_asset_a_in_project` 的命名空间闸,
/// 那道闸只认「2. 原始素材」「3. 特别素材」两个首段,是第二层保证。
fn list_camera_folders(
    raw_root: &Path,
    raw_dir: &str,
) -> std::result::Result<(Vec<String>, Vec<String>), String> {
    let entries = std::fs::read_dir(raw_root).map_err(|e| format!("无法读取「{raw_dir}」: {e}"))?;
    let mut folders = Vec::new();
    let mut errors = Vec::new();
    for e in entries {
        let e = match e {
            Ok(e) => e,
            Err(ee) => {
                errors.push(format!("{raw_dir}: 目录项读取失败: {ee}"));
                continue;
            }
        };
        let name = e.file_name().to_string_lossy().to_string();
        if crate::core::copy::is_system_item(&name) {
            continue;
        }
        match e.file_type() {
            Ok(t) if t.is_symlink() => {
                errors.push(format!("{raw_dir}/{name}: 符号链接,不作为相机夹"));
            }
            Ok(t) if t.is_dir() => folders.push(name),
            Ok(_) => {}
            Err(ee) => errors.push(format!("{raw_dir}/{name}: 类型读取失败: {ee}")),
        }
    }
    folders.sort();
    Ok((folders, errors))
}

/// 批内输出名碰撞预检(R2 P1-6:大小写敏感文件系统上 `clip.mov` 与 `clip.MOV`
/// 会映射到同一个输出名——后到者会把先到者的产物误判为「已完成」)。
/// 返回被剔除的冲突项(rel 列表),调用方逐条入失败清单。
fn split_name_collisions(work: &mut Vec<(String, PathBuf, String)>) -> Vec<String> {
    let mut seen: std::collections::HashSet<(String, String)> = Default::default();
    let mut clashed: Vec<String> = Vec::new();
    work.retain(|(folder, abs, rel)| {
        let stem = abs
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_ascii_lowercase();
        let ext = abs
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_ascii_lowercase();
        if seen.insert((folder.clone(), format!("{stem}.{ext}"))) {
            true
        } else {
            clashed.push(rel.clone());
            false
        }
    });
    clashed
}

/// 磁盘可用空间(sysinfo:挂载点前缀最长匹配)。
fn free_space_for(path: &Path) -> Option<u64> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .iter()
        .filter(|d| path.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| d.available_space())
}

/// 取能力(缓存优先;未探测则同步探测并回填缓存)。
fn capabilities_blocking() -> Result<ff::CapabilityReport, String> {
    {
        let st = PROBE_STATE.lock().unwrap_or_else(|p| p.into_inner());
        if let ProbeState::Ready(r) = &*st {
            return Ok(r.clone());
        }
    }
    let report = ff::probe_capabilities()?;
    *PROBE_STATE.lock().unwrap_or_else(|p| p.into_inner()) = ProbeState::Ready(report.clone());
    Ok(report)
}

/// 发起代理转码作业(工况 A)。幂等:输出已存在=already-transcoded skip;
/// 绝不覆盖(覆盖只属于将来的「强制重转」显式入口)。
#[tauri::command(async)]
pub fn start_proxy_transcode<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<super::AppState>,
    input: ProxyInput,
) -> std::result::Result<JobSnapshot, String> {
    let nas = super::nas_root(&app, &state)?;
    let stats = super::find_project(&nas, &input.project_id)?;
    let op = super::operator(&app, &state);
    spawn_proxy_job(
        &app,
        stats.root.clone(),
        stats.meta.clone(),
        state.machine_id.clone(),
        state.config_dir.clone(),
        op,
        input,
        None,
    )
}

/// 内部派发(命令与 auto_proxy 补投递共用)。intent=Some(manifest id) 时,
/// 整批成功(未取消且零失败)后把该 manifest 的 proxy_completed 置位
/// (at-least-once 去重依据;失败/取消不置位,下次启动重投,skip 语义容忍重复)。
#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_proxy_job<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    root: PathBuf,
    meta: project::ProjectMeta,
    machine_id: String,
    config_dir: PathBuf,
    op: String,
    input: ProxyInput,
    intent_manifest: Option<String>,
) -> std::result::Result<JobSnapshot, String> {
    let jobs = app.state::<Arc<JobManager>>().inner().clone();
    // auto_proxy 补投递允许排队(lane 串行天然消化多卡,评审 P1-7);
    // UI 手动路径保留防重复点击
    if intent_manifest.is_none() && jobs.has_active(JobKind::Transcode, &input.project_id) {
        return Err("该项目已有转码作业在进行中".into());
    }
    if meta.scenario != project::Scenario::A {
        return Err("代理转码仅适用于工况 A(视频)项目".into());
    }
    let handle = jobs.create_op(JobKind::Transcode, Some("proxy"), &input.project_id);
    // intent 绑定到作业(R5:排队期被取消也能按 job 释放,不再卡到重启)
    if let Some(mid) = &intent_manifest {
        intent_bind(mid, &handle.snapshot().id);
    }
    let body_app = app.clone();
    let event_app = app.clone();
    let ret = handle.clone();
    let raw_dir = project::SCENARIO_A_DIRS[1].to_string();
    let out_root_rel = project::SCENARIO_A_DIRS[3].to_string(); // 4. 转码素材

    jobs.run(
        handle.clone(),
        || Ok(()), // transcode 不进 OpsMutex(计划 D3);同 kind 排队由 lane 承担
        move |h| {
            super::tasks::append_audit(
                &body_app,
                &root,
                &config_dir,
                &crate::core::journal::Event::new(
                    machine_id.clone(),
                    op.clone(),
                    "transcode_started",
                    serde_json::json!({
                        "jobId": h.snapshot().id,
                        "folders": input
                            .camera_folders
                            .as_ref()
                            .map(|f| f.join("、"))
                            .unwrap_or_else(|| "全部相机夹".into()),
                    }),
                ),
            );
            let mut exit_guard = TranscodeExitGuard {
                app: body_app.clone(),
                root: root.clone(),
                config_dir: config_dir.clone(),
                machine_id: machine_id.clone(),
                op: op.clone(),
                job_id: h.snapshot().id.clone(),
                armed: true,
            };
            let caps = capabilities_blocking()?;
            // 阻塞探测路径也要兑现 hwenc-fallback 告警(评审:不能只挂设置页路径)
            if !caps.winners.keys().any(|k| k.ends_with("_hw")) {
                notify::warn(
                    &body_app,
                    "hwenc-fallback",
                    "未探测到可用的硬件编码器,本次转码使用软件编码(速度较慢)".into(),
                );
            }
            let encoder = caps
                .winners
                .get("h264_hw")
                .or_else(|| caps.winners.get("h264_sw"))
                .cloned()
                .ok_or("没有任何可用的 H.264 编码器(硬编与软编探测都失败)")?;
            let ffmpeg_bin = PathBuf::from(&caps.ffmpeg.ffmpeg_path);
            let ffprobe_bin = PathBuf::from(&caps.ffmpeg.ffprobe_path);

            // 收集相机夹
            let raw_root = root.join(&raw_dir);
            let mut folder_enum_errors: Vec<String> = Vec::new();
            let folders: Vec<String> = match &input.camera_folders {
                Some(list) => list.clone(),
                None => {
                    let (folders, errs) = list_camera_folders(&raw_root, &raw_dir)?;
                    folder_enum_errors = errs;
                    folders
                }
            };

            // 收集视频文件(逐夹过工况 A 命名空间闸;R2 P0:递归收集,
            // 目录/目录项错误入失败清单并阻止 intent 标完成,符号链接入 skipped)
            let mut dir_errors: Vec<FailureDto> = Vec::new();
            for msg in folder_enum_errors.drain(..) {
                dir_errors.push(FailureDto {
                    rel: raw_dir.clone(),
                    message: msg,
                });
            }
            let mut symlink_skips: Vec<String> = Vec::new();
            let mut work: Vec<(String, PathBuf, String)> = Vec::new(); // (folder, abs, rel)
            for folder in &folders {
                let rel_dir = format!("{raw_dir}/{folder}");
                let dir = sorting::resolve_asset_a_in_project(&root, &meta, &rel_dir)?;
                let mut vids: Vec<(PathBuf, String)> = Vec::new();
                let mut errs: Vec<String> = Vec::new();
                collect_videos_recursive(&dir, &rel_dir, &mut vids, &mut errs, &mut symlink_skips);
                for msg in errs {
                    dir_errors.push(FailureDto {
                        rel: rel_dir.clone(),
                        message: msg,
                    });
                }
                for (p, rel) in vids {
                    work.push((folder.clone(), p, rel));
                }
            }
            work.sort_by(|a, b| a.2.cmp(&b.2));
            let clashed = split_name_collisions(&mut work);

            let mut result = ProxyResultDto {
                mode: "proxy",
                used_encoder: encoder.clone(),
                output_dir: root.join(&out_root_rel).display().to_string(),
                failures: dir_errors,
                ..Default::default()
            };
            for rel in clashed {
                result.failures.push(FailureDto {
                    rel,
                    message: "与同夹另一文件仅大小写不同,输出名会互相覆盖;请改名后再转".into(),
                });
            }
            for rel in symlink_skips {
                result.skipped.push(SkippedDto {
                    rel,
                    reason: "符号链接,不追踪(不会被转码)".into(),
                });
            }

            // 空间预检(启发式:代理约为源 1/8,再留 2GB 余量;不足=可见失败)
            let total_src: u64 = work
                .iter()
                .filter_map(|(_, p, _)| std::fs::metadata(p).ok().map(|m| m.len()))
                .sum();
            match free_space_for(&root) {
                Some(free) => {
                    let est = total_src / 8 + 2 * 1024 * 1024 * 1024;
                    if free < est {
                        notify::warn(
                            &body_app,
                            "disk-space-insufficient",
                            format!(
                                "转码空间预检失败:可用 {} GB,预估需要 {} GB",
                                free / 1_073_741_824,
                                est / 1_073_741_824
                            ),
                        );
                        return Err(format!(
                            "磁盘空间不足:可用 {} GB,预估需要 {} GB(代理输出+余量);请清理后重试",
                            free / 1_073_741_824,
                            est / 1_073_741_824
                        ));
                    }
                }
                None => notify::warn(
                    &body_app,
                    "disk-space-insufficient",
                    "无法探测目标磁盘可用空间,已跳过空间预检;若中途空间耗尽会逐文件失败".into(),
                ),
            }

            // 本机残留 staging 全输出根清理(D2:作业起点执行+可见提示)
            let mut cleaned = 0usize;
            let out_root = root.join(&out_root_rel);
            let mut stack = vec![out_root.clone()];
            while let Some(d) = stack.pop() {
                let Ok(entries) = std::fs::read_dir(&d) else { continue };
                for e in entries.flatten() {
                    let name = e.file_name().to_string_lossy().to_string();
                    if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        stack.push(e.path());
                    } else if name.starts_with(&format!(".{machine_id}."))
                        && name.contains(".transpart")
                        && std::fs::remove_file(e.path()).is_ok()
                    {
                        cleaned += 1;
                    }
                }
            }
            if cleaned > 0 {
                notify::info(
                    &body_app,
                    "transcode-staging-cleaned",
                    format!("清理了 {cleaned} 个上次未完成的转码半成品(本机残留)"),
                );
            }

            let total = work.len();
            let mut sw_fallback_notified = false;
            let mut units_done = 0usize;
            for (i, (folder, abs, rel)) in work.iter().enumerate() {
                if h.cancel_requested() {
                    break;
                }
                units_done = i;
                h.progress(i, total, 0, Some(rel.clone()));
                let _ = body_app.emit(JOB_EVENT, &h.snapshot());

                let info = match transcode::probe_file(&ffprobe_bin, abs) {
                    Ok(i) => i,
                    Err(e) => {
                        result.failures.push(FailureDto {
                            rel: rel.clone(),
                            message: format!("探测失败: {e}"),
                        });
                        continue;
                    }
                };
                let reasons = transcode::heavy_verdict(&info);
                if reasons.is_empty() && !input.force_all.unwrap_or(false) {
                    result.skipped.push(SkippedDto {
                        rel: rel.clone(),
                        reason: "非高负载素材(可整夹强制全转)".into(),
                    });
                    continue;
                }

                // 输出落位(全套路径闸)
                let out_dir = root.join(&out_root_rel).join(folder);
                if let Err(e) = {
                    // 输出目录闸:探针先行落地闸(与交付同源原语)
                    paths::ensure_dir_within(&root, &out_dir)
                } {
                    result.failures.push(FailureDto {
                        rel: rel.clone(),
                        message: e,
                    });
                    continue;
                }
                // 名带源扩展名:C0001.MP4 与 C0001.MXF 不再撞名误报(评审 P1-3)
                let stem = abs
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let ext = abs
                    .extension()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_ascii_uppercase();
                let final_out = out_dir.join(format!("{stem}_{ext}_proxy.mp4"));
                if paths::is_symlink(&final_out) {
                    result.failures.push(FailureDto {
                        rel: rel.clone(),
                        message: "输出位置是符号链接,拒绝".into(),
                    });
                    continue;
                }
                if final_out.exists() {
                    if input.retranscode.unwrap_or(false) {
                        // 唯一覆盖入口(D2):显式强制重转,先删后转(前端已二次确认)
                        let _ = std::fs::remove_file(provenance_path(&final_out));
                        if let Err(e) = std::fs::remove_file(&final_out) {
                            result.failures.push(FailureDto {
                                rel: rel.clone(),
                                message: format!("删除既有代理失败: {e}"),
                            });
                            continue;
                        }
                    } else {
                        // 幂等 skip(计划 D2)。R2 P1:「存在即成功」会永久采信坏产物——
                        // 计入完成前 ffprobe 验一次,坏产物如实报失败(覆盖仍只走重转入口)
                        // R4/R5(终审 P0-6):属性完整校验 + 来源指纹绑定——
                        // 「合法但他源」的视频也不许计入完成
                        let verdict = provenance_matches(&final_out, rel, abs)
                            .and_then(|_| transcode::probe_file(&ffprobe_bin, &final_out))
                            .and_then(|out_info| {
                                let pix_ok = out_info.pix_fmt == "yuv420p"
                                    || out_info.pix_fmt == "nv12";
                                if !pix_ok {
                                    return Err(format!("像素格式不符: {}", out_info.pix_fmt));
                                }
                                let pix = out_info.pix_fmt.clone();
                                transcode::verify_output(&out_info, "h264", Some(1080), &pix, &info)
                            });
                        match verdict {
                            Ok(()) => result.already_transcoded += 1,
                            Err(e) => result.failures.push(FailureDto {
                                rel: rel.clone(),
                                message: format!(
                                    "既有代理未通过完整校验({e}),未计入完成;可用「重新转码」覆盖"
                                ),
                            }),
                        }
                        continue;
                    }
                }
                // 本机残留 staging 清理(只清本机,启动/重跑安全)
                if let Ok(entries) = std::fs::read_dir(&out_dir) {
                    for e in entries.flatten() {
                        let name = e.file_name().to_string_lossy().to_string();
                        if name.starts_with(&format!(".{machine_id}.")) && name.contains(".transpart")
                        {
                            let _ = std::fs::remove_file(e.path());
                        }
                    }
                }
                let job_short = &h.snapshot().id[..8];
                let tmp = out_dir.join(format!(".{machine_id}.{job_short}.transpart.mp4"));

                let run_once = |enc: &str| -> std::result::Result<(), String> {
                    let args = transcode::proxy_args(abs, enc, &tmp);
                    let frac_rel = rel.clone();
                    let hh = &*h;
                    transcode::run_transcode(
                        &ffmpeg_bin,
                        &args,
                        &tmp,
                        info.duration_secs,
                        move |frac| {
                            let msg = match frac {
                                Some(f) => format!("{frac_rel} ({:.0}%)", f * 100.0),
                                None => format!("{frac_rel} (时长未知)"),
                            };
                            hh.progress(i, total, 0, Some(msg));
                        },
                        &|| hh.cancel_requested(),
                    )
                };
                let mut used = encoder.clone();
                let mut run_result = run_once(&encoder);
                if let Err(e) = &run_result {
                    if encoder != "libx264"
                        && transcode::is_hw_init_failure(e)
                        && !h.cancel_requested()
                    {
                        // 硬编运行时失败:同文件至多一次软编重试+可见告警(计划复审 #5)
                        if !sw_fallback_notified {
                            notify::warn(
                                &body_app,
                                "hwenc-runtime-fallback",
                                format!("硬件编码在实际素材上初始化失败({e}),本作业改用软件编码继续(速度较慢)"),
                            );
                            sw_fallback_notified = true;
                        }
                        used = "libx264".into();
                        run_result = run_once("libx264");
                    }
                }
                match run_result {
                    Ok(()) => {
                        // 落位前全量验证(计划复审 #5)。R2 P1:VAAPI 输出 nv12,
                        // 统一要求 yuv420p 会把全部 VAAPI 代理误判失败——按实际编码器放行
                        let verdict = transcode::probe_file(&ffprobe_bin, &tmp)
                            .and_then(|out_info| {
                                let pix_ok = out_info.pix_fmt == "yuv420p"
                                    || (used.contains("vaapi") && out_info.pix_fmt == "nv12");
                                if !pix_ok {
                                    return Err(format!("输出像素格式不符: {}", out_info.pix_fmt));
                                }
                                let pix = out_info.pix_fmt.clone();
                                transcode::verify_output(&out_info, "h264", Some(1080), &pix, &info)
                            })
                            .and_then(|_| {
                                crate::core::fsx::rename_no_replace(&tmp, &final_out)
                                    .map_err(|e| format!("落位失败: {e}"))
                            });
                        match verdict {
                            Ok(()) => match write_provenance(&final_out, rel, abs) {
                                Err(e) => result.failures.push(FailureDto {
                                    rel: rel.clone(),
                                    message: format!(
                                        "产物已生成但来源指纹写入失败({e}):未计入完成,重跑会重新校验"
                                    ),
                                }),
                                Ok(()) => {
                                    result.converted += 1;
                                    // R2 P2:末文件覆写会把混合批报成单一编码器——如实标「混合」
                                    if result.converted == 1 {
                                        result.used_encoder = used.clone();
                                    } else if result.used_encoder != used {
                                        result.used_encoder = "混合".into(); // 一旦混编,保持「混合」
                                    }
                                }
                            },
                            Err(e) => {
                                let _ = std::fs::remove_file(&tmp);
                                result.failures.push(FailureDto {
                                    rel: rel.clone(),
                                    message: format!("输出验证失败: {e}"),
                                });
                            }
                        }
                    }
                    Err(e) if transcode::is_cancelled_err(&e) => break,
                    Err(e) => {
                        result.failures.push(FailureDto {
                            rel: rel.clone(),
                            message: e,
                        });
                    }
                }
            }
            let cancelled = h.cancel_requested();
            // R2 P1:取消不许发布 total/total 假进度——按真实完成量收尾
            let final_units = if cancelled { units_done } else { total };
            h.progress(
                final_units,
                total,
                0,
                Some(if cancelled { "已取消" } else { "收尾" }.into()),
            );

            crate::core::catalog::invalidate_cache(root.parent().unwrap_or(&root));
            super::sorting_cmds::notify_if_unsafe_fallback(&body_app);
            let audit_kind = if cancelled {
                "transcode_cancelled"
            } else {
                "transcode_completed"
            };
            super::tasks::append_audit(
                &body_app,
                &root,
                &config_dir,
                &crate::core::journal::Event::new(
                    machine_id.clone(),
                    op.clone(),
                    audit_kind,
                    serde_json::json!({
                        "jobId": h.snapshot().id,
                        "converted": result.converted,
                        "alreadyTranscoded": result.already_transcoded,
                        "skipped": result.skipped.len(),
                        "failures": result.failures.len(),
                        "encoder": result.used_encoder,
                    }),
                ),
            );
            exit_guard.disarm(); // 终态审计已落,兜底解除(R5:顺序不许反)
            if !result.skipped.is_empty() {
                notify::info(
                    &body_app,
                    "transcode-skipped",
                    format!(
                        "{} 个文件按高负载判定被跳过(明细见转码结果;可用「整夹强制全转」),规则:HLG/PQ、10bit/422、ProRes/DNxHD、≥100Mbps、>4K",
                        result.skipped.len()
                    ),
                );
            }
            if !result.failures.is_empty() {
                notify::warn(
                    &body_app,
                    "transcode-partial",
                    format!("转码完成,但 {} 个文件失败(明细见转码结果)", result.failures.len()),
                );
            }
            // auto_proxy intent:整批成功才置位(计划 D2 at-least-once);
            // in-flight 登记的移除统一由 exit_guard 负责(含所有早退路径)
            if let Some(mid) = &intent_manifest {
                // 评审 P0-4:空清单/读错/取消都不许标完成——attempts 上限负责最终放弃
                if !cancelled && result.failures.is_empty() && total > 0 {
                    // 与放弃标记/重试计数同一条路:重读 + 看活租约 + 写回,写失败可见。
                    // 此前这里 `if let Ok(..)` 读不出清单就一声不吭——任务显示完成、
                    // 意图却没落盘,下次启动会重投一次,用户不知道为什么
                    // 三种结局都已在里面各自通知;完成标记写不写得进不改变本次作业的结果
                    let _ = save_proxy_state(&body_app, &root, &machine_id, mid, "完成标记",
                        "下次启动会重投一次(已转文件会安全跳过)", |fresh| {
                        // 盘上那份已经不是「已完成」(另一台机器续传把它打回了):不许标代理完成,
                        // 否则以后补拷的新文件永远不会再自动转代理
                        if !fresh.completed || !fresh.auto_proxy {
                            return false;
                        }
                        fresh.proxy_completed = true;
                        true
                    });
                }
            }
            serde_json::to_value(&result).map_err(|e| e.to_string())
        },
        move |s: JobSnapshot| {
            let _ = event_app.emit(JOB_EVENT, &s);
        },
    );
    Ok(ret.snapshot())
}

/// 在途 intent 登记(R2/评审 P1-7 → R5 终审):job_id → manifest id。
/// 登记与去重在**创建作业的同一临界区**内原子完成(spawn_proxy_job);
/// 释放有三条腿:作业体出口 guard、排队期被取消(cancel_job 按 job 释放)、
/// 进程重启自然清零。
static INTENTS_IN_FLIGHT: Mutex<Option<std::collections::HashMap<String, Option<String>>>> =
    Mutex::new(None);

/// 原子占位:同一 manifest 已在途则拒(返回 false)。占位发生在创建作业前,
/// 拿到 job id 后用 [`intent_bind`] 绑定,取消/出口按 job 释放。
fn intent_claim(mid: &str) -> bool {
    let mut g = INTENTS_IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    let map = g.get_or_insert_with(Default::default);
    if map.contains_key(mid) {
        return false;
    }
    map.insert(mid.to_string(), None);
    true
}

fn intent_bind(mid: &str, job_id: &str) {
    if let Some(map) = INTENTS_IN_FLIGHT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_mut()
    {
        map.insert(mid.to_string(), Some(job_id.to_string()));
    }
}

/// 直接按 manifest 释放(spawn 失败回滚用)。
fn intent_release_mid(mid: &str) {
    if let Some(map) = INTENTS_IN_FLIGHT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_mut()
    {
        map.remove(mid);
    }
}

/// 按作业释放登记(出口 guard 与排队取消共用;幂等)。
pub(crate) fn intent_release_by_job(job_id: &str) {
    if let Some(map) = INTENTS_IN_FLIGHT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_mut()
    {
        map.retain(|_, v| v.as_deref() != Some(job_id));
    }
}

/// auto_proxy 意图派发(拷卡完成钩子与启动补投递共用)。
/// 失败不炸调用方:派发失败给可见 warning(如已有作业在跑,下次启动仍会补投)。
/// 自动转代理的状态写回(放弃标记 / 重试计数)。
///
/// 这两处此前拿调用方给的 `m` 直接整份写回。启动补投那一轮的 `m` 来自
/// `manifest::list` 的快照——遍历 NAS 上全部项目之后可能已经旧了几十秒;
/// 而且它们不在任务租约之内。整份写回一份陈旧快照,会把 worker 刚记下的进度
/// 顶掉;反过来 worker 的下一次落盘又会把这里加的计数顶回去——「三次放弃」
/// 上限就这么静默失效。所以:写之前**重读**,再看有没有活着的 worker 在写。
///
/// 现在写之前短期取得任务租约(与 worker 同一把),不再是「检查后写」。
fn save_proxy_state<R: tauri::Runtime>(
    app: &AppHandle<R>,
    project_root: &Path,
    machine_id: &str,
    id: &str,
    what: &str,
    // 写不成的**后果**,各调用点各说各的:完成标记写不成 ≠ 计数写不成
    consequence: &str,
    // 在租约下**重读**的那份清单上再判一次资格:返回 false = 盘上那份已经不满足(另一台
    // 机器续传把 completed 打回了 false、或别的进程已经放弃/完成),不改、不写、不派发。
    // 此前只盲目执行 closure,资格全按调用方手里的陈旧快照(codex 终审 P0)
    mutate: impl FnOnce(&mut crate::core::manifest::CopyManifest) -> bool,
) -> Persist {
    // 短期持有真正的租约,而不是 live_holder 这种「检查后写」:worker 收尾那次
    // save 写的正是 completed=true,续传刷新又会把 completed 打回 false——写集合
    // 并不像此前注释说的那样不相交。Busy 就是可见出口;写完 Held 一 drop 就释放
    // 报文里带清单身份:同 code 的通知 30 秒内会合并,两份清单同时出事时正文得分得清。
    // project id 与任务重建同一口径(项目目录名):给空串的话这些通知永远不渲染
    // 「查看任务」,而其中好几条明摆着要人去看任务
    let which: String = id.chars().take(8).collect();
    let project_id: String = project_root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let lease = match crate::core::lease::acquire(project_root, id, machine_id, "") {
        Ok(mut h) => {
            // 接管别人/自己残留的租约是「系统替用户做了决定」:这里也必须说
            if let Some(note) = h.took_over_stale.take() {
                notify::warn_for_task(
                    app,
                    "task-lease-taken-over",
                    (id, &project_id),
                    format!("清单 {which}…:{note}"),
                );
            }
            h
        }
        Err(e) => {
            // 锁目录异常(链接 / 异物)不会自己好:error 级、抬头就说「需人工清理」。
            // code 直接写字面量(通知 code 门禁只认调用点里的字面量)
            let msg = format!("清单 {which}… 的自动转代理{what}没有写回:{e}。{consequence}");
            if e.to_string()
                .starts_with(crate::core::lease::LOCK_DIR_BROKEN_PREFIX)
            {
                notify::error_for_task(
                    app,
                    "copy-resume-lease-lock-broken",
                    (id, &project_id),
                    msg,
                );
            } else {
                notify::warn_for_task(app, "auto-proxy-state-unsaved", (id, &project_id), msg);
            }
            return Persist::NotPublished;
        }
    };
    // 租约下先看不可信标记:有(或读不出)就什么都不写、不派发(fail-closed)
    let suspect = match crate::core::manifest::suspect(project_root, id) {
        Ok(None) => None,
        Ok(Some(why)) => Some(why),
        Err(e) => Some(format!("(标记读不出:{e};按不可信处理)")),
    };
    let outcome = if let Some(why) = suspect {
        notify::warn_for_task(
            app,
            "auto-proxy-skipped-suspect",
            (id, &project_id),
            format!(
                "清单 {which}… 旁有「不可信」标记、或标记读不出({}):{what}本次不写回也不派发",
                why.trim()
            ),
        );
        Persist::Skipped
    } else {
        // 在租约下重读的那份上再判资格;不满足就不改不写
        let result = crate::core::manifest::load(project_root, id).and_then(|mut fresh| {
            if !mutate(&mut fresh) {
                return Ok(None);
            }
            // 写在栅栏内:持有 Held 本身挡不住「进程休眠超过 TTL 后被接管」,栅栏在落盘前
            // 持锁核对 token,不是自己的就不写(codex r6);改名之前再问一句(守门版 save)
            let fence = lease.fence()?;
            let (wr, path) =
                crate::core::manifest::save_guarded(project_root, &fresh, &|| fence.still_mine())?;
            // 写完再复核:此时改名**已经发生**,栅栏没了只能说「发布了但不能确认」,不能说
            // 「没有写回」——放弃标记若已落盘,下次启动就不会再重投,却没人告诉用户已放弃
            let unverified = !fence.still_mine();
            // NAS 上留持久化的不可信标记;写不成在下面的通知里如实说,不能谎称已留下
            let marker = if unverified {
                Some(crate::core::manifest::mark_suspect(
                    project_root,
                    id,
                    "自动转代理状态写回后发现租约锁已丢,这份清单可能盖掉了接管方的进度",
                ))
            } else {
                None
            };
            drop(fence);
            Ok(Some((wr, path, unverified, marker)))
        });
        match result {
            Ok(None) => {
                // 系统替用户做了「不做」的决定,要说:盘上那份已经不满足派发条件(多半是另一台
                // 机器续传把它打回了未完成,或别处已经放弃 / 完成)
                notify::info_for_task(
                    app,
                    "auto-proxy-skipped-stale",
                    (id, &project_id),
                    format!("清单 {which}… 在租约下重读后已不满足{what}的条件(可能另一台机器正在续传、或别处已处理),本次不写回也不派发"),
                );
                Persist::Skipped
            }
            Ok(Some((wr, path, unverified, marker))) => {
                // 被占用后重试成功的轮数在拷卡那条路上是可见的(fs-write-contention),口径一致
                if wr.retries > 0 {
                    notify::warn_for_task(
                        app,
                        "fs-write-contention",
                        (id, &project_id),
                        format!(
                            "写入拷卡清单时被别的程序占着,重试 {} 轮后成功:{}。多半是杀毒软件或 NAS 索引正在扫这个目录;若反复出现,把该目录加入杀毒软件排除项",
                            wr.retries,
                            path.display()
                        ),
                    );
                }
                if unverified {
                    notify::warn_for_task(
                        app,
                        "auto-proxy-state-unverified",
                        (id, &project_id),
                        format!(
                            "清单 {which}… 的自动转代理{what}已写回,但写完后读不到本任务的租约锁标记(可能是存储抖动,也可能是锁被外部回收),不能确认这份清单没有被别处顶掉;本次按已写回处理{}。请确认没有别的 OCard 在跑这个任务",
                            match &marker {
                                Some(Ok(())) => ",并已在清单旁留下「不可信」标记".to_string(),
                                Some(Err(e)) => format!(",而且没能在清单旁写下「不可信」标记({e}):下次启动会采信盘上这份,请人工核对"),
                                None => String::new(),
                            }
                        ),
                    );
                    Persist::PublishedUnverified
                } else {
                    Persist::Confirmed
                }
            }
            Err(e) => {
                // 栅栏拒绝(含锁目录异常)时根本没写,不能说「写入失败」
                if e.to_string()
                    .starts_with(crate::core::lease::LOCK_DIR_BROKEN_PREFIX)
                {
                    notify::error_for_task(
                        app,
                        "copy-resume-lease-lock-broken",
                        (id, &project_id),
                        format!("清单 {which}… 的自动转代理{what}没有写回:{e}。{consequence}"),
                    );
                } else if matches!(e, crate::core::CoreError::Busy(_)) {
                    notify::warn_for_task(
                        app,
                        "auto-proxy-state-unsaved",
                        (id, &project_id),
                        format!("清单 {which}… 的自动转代理{what}没有写回:{e}。{consequence}"),
                    );
                } else {
                    notify::warn_for_task(
                        app,
                        "auto-proxy-state-unsaved",
                        (id, &project_id),
                        format!("清单 {which}… 的自动转代理{what}写入失败({e})。{consequence}"),
                    );
                }
                Persist::NotPublished
            }
        }
    };
    // 释放要有判定:只靠 Drop 的话「没删掉 / 被接管」就成了无声
    let lease_file = lease.path().to_path_buf();
    super::tasks::report_lease_release(
        app,
        lease.release(),
        &lease_file,
        "自动转代理状态写回",
        false,
        Some((id, &project_id)),
    );
    outcome
}

/// [`save_proxy_state`] 的三种结局。`PublishedUnverified` 是「改名已经发生、但写完后
/// 栅栏没了」:盘上多半是这份,调用方要按「可能已写回」处理,不能当没写。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[must_use = "三种结局的后果各不相同,调用方必须分别处理"]
pub enum Persist {
    Confirmed,
    PublishedUnverified,
    NotPublished,
    /// 租约下重读后已不满足条件(或清单不可信):没改、没写、不派发,已通知。
    Skipped,
}

pub fn dispatch_auto_proxy<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    project_root: &Path,
    machine_id: &str,
    config_dir: &Path,
    operator: &str,
    m: &crate::core::manifest::CopyManifest,
) {
    if !m.auto_proxy || m.proxy_completed || !m.completed {
        return;
    }
    let project_id: String = project_root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    // 带「不可信」标记的清单:completed 可能是迟到的写入顶回来的,不按它派发。
    // 标记读不出也不派发(fail-closed)
    let suspect = match crate::core::manifest::suspect(project_root, &m.id) {
        Ok(None) => None,
        Ok(Some(why)) => Some(why),
        Err(e) => Some(format!("(标记读不出:{e};按不可信处理)")),
    };
    if let Some(why) = suspect {
        notify::warn_for_task(
            app,
            "auto-proxy-skipped-suspect",
            (&m.id, &project_id),
            format!(
                "「{}」的清单旁有「不可信」标记、或标记读不出({}),它写着已完成但可能是被迟到的写入顶回来的:本次不派发自动转代理;续传跑完、标记清掉后会再派发",
                m.target_rel,
                why.trim()
            ),
        );
        return;
    }
    // 永久失败不许无限重投(评审 P1-8):三次仍未整批成功即放弃,可见告知
    if m.proxy_attempts >= 3 {
        let persisted = save_proxy_state(
            app,
            project_root,
            machine_id,
            &m.id,
            "放弃标记",
            "本次不派发;放弃状态没有持久化,下次启动会再试一次写回",
            |fresh| {
                if !(fresh.auto_proxy
                    && fresh.completed
                    && !fresh.proxy_completed
                    && fresh.proxy_attempts >= 3)
                {
                    return false;
                }
                fresh.proxy_completed = true;
                true
            },
        );
        // 放弃标记写成了才能说「停止自动重试」;没写成就不是停止,是「这次没派发」。
        // 「写回了但不能确认」也要说停止:盘上多半已是放弃态,下次启动不会再重投,
        // 不说就是一次无声的放弃
        match persisted {
            Persist::Confirmed => notify::warn_for_task(
                app,
                "auto-proxy-abandoned",
                (&m.id, &project_id),
                format!(
                    "「{}」的自动转代理已连续 {} 次未能整批完成,停止自动重试;可在转码页手动执行(已转文件会安全跳过)",
                    m.target_rel, m.proxy_attempts
                ),
            ),
            // 改名已经发生但不能确认盘上是不是这份:不许确定地说「已停止」,也不派发
            Persist::PublishedUnverified => notify::warn_for_task(
                app,
                "auto-proxy-abandoned",
                (&m.id, &project_id),
                format!(
                    "「{}」的自动转代理已连续 {} 次未能整批完成;放弃标记可能已写回但不能确认,本次不派发,下次启动会重读确认。可在转码页手动执行(已转文件会安全跳过)",
                    m.target_rel, m.proxy_attempts
                ),
            ),
            Persist::NotPublished | Persist::Skipped => {}
        }
        return;
    }
    // 计数写不进去=放弃上限失效,存在无限重投风险,必须可见(R2 P2)
    // 计数写不进去 = 放弃上限失效 = 无限重投的风险:那就**不派发**这一次。
    // 通知已在 save_proxy_state 里发过,这里只中止(R2 P2 + 评审)。
    // 「写回了但不能确认」按 Persist 自己的口径**当已写回**照常派发:改名已经发生,
    // 计数多半在盘上、放弃上限仍然有效;若当没写回,每一次 unverified 都会烧掉一次
    // 重投额度却一个作业都不派,三次之后弹出「已连续 3 次未能整批完成」的假话
    // (opus r14)
    let reserved = save_proxy_state(
        app,
        project_root,
        machine_id,
        &m.id,
        "重试计数",
        "放弃上限会失效,本次不派发,下次启动再试",
        |fresh| {
            if !(fresh.auto_proxy
                && fresh.completed
                && !fresh.proxy_completed
                && fresh.proxy_attempts < 3)
            {
                return false;
            }
            fresh.proxy_attempts += 1;
            true
        },
    );
    if matches!(reserved, Persist::NotPublished | Persist::Skipped) {
        return;
    }
    let meta = match project::load_meta(project_root) {
        Ok(m) => m,
        Err(e) => {
            // R2 P2:元数据读不出时意图会静默蒸发——如实告知
            notify::warn_for_task(
                app,
                "auto-proxy-deferred",
                (&m.id, &project_id),
                format!("自动转代理未启动(项目元数据读取失败: {e});下次启动会重试"),
            );
            return;
        }
    };
    let raw_prefix = format!("{}/", project::SCENARIO_A_DIRS[1]);
    let Some(folder) = m.target_rel.strip_prefix(&raw_prefix) else {
        return; // 非工况 A 拷卡,无代理意图可言
    };
    let project_id = project_root
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let input = ProxyInput {
        project_id: project_id.clone(),
        camera_folders: Some(vec![folder.to_string()]),
        force_all: Some(false),
        retranscode: Some(false),
    };
    if !intent_claim(&m.id) {
        return; // 同一意图已在排队/执行(P1-7 去重),双投只会白跑一轮
    }
    if let Err(e) = spawn_proxy_job(
        app,
        project_root.to_path_buf(),
        meta,
        machine_id.to_string(),
        config_dir.to_path_buf(),
        operator.to_string(),
        input,
        Some(m.id.clone()),
    ) {
        intent_release_mid(&m.id);
        notify::warn_for_task(
            app,
            "auto-proxy-deferred",
            (&m.id, &project_id),
            format!("自动转代理暂未启动({e});下次启动应用会自动补投"),
        );
    }
}

// ---------- 归档转码(PRD §5.6 三档,评审 #15 接线) ----------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveInput {
    pub project_id: String,
    pub camera_folders: Option<Vec<String>>,
    pub tier: transcode::ArchiveTier,
    /// 输出目录(用户选择,绝对路径;必须在项目外——归档不改写项目区)。
    pub output_dir: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveResultDto {
    /// 显式判别字段(同上)。
    pub mode: &'static str,
    pub converted: usize,
    pub already_archived: usize,
    pub failures: Vec<FailureDto>,
    pub used_encoder: String,
    pub output_dir: String,
}

/// 发起归档转码作业(HEVC 三档;默认不动原件;零覆盖 + skip 幂等)。
#[tauri::command(async)]
pub fn start_archive_transcode<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<super::AppState>,
    input: ArchiveInput,
) -> std::result::Result<JobSnapshot, String> {
    let jobs = app.state::<Arc<JobManager>>().inner().clone();
    if jobs.has_active(JobKind::Transcode, &input.project_id) {
        return Err("该项目已有转码作业在进行中".into());
    }
    let nas = super::nas_root(&app, &state)?;
    let stats = super::find_project(&nas, &input.project_id)?;
    if stats.meta.scenario != project::Scenario::A {
        return Err("归档转码仅适用于工况 A(视频)项目".into());
    }
    let out_root = PathBuf::from(input.output_dir.trim());
    if !out_root.is_absolute() {
        return Err("输出目录必须是绝对路径".into());
    }
    // 布局闸(计划 B2):输出与素材源互不嵌套(现成原语,不手搓)
    let raw_root = stats.root.join(project::SCENARIO_A_DIRS[1]);
    paths::validate_dest_layout(&raw_root, std::slice::from_ref(&out_root))?;
    if out_root.starts_with(&stats.root) {
        return Err("归档输出目录不能位于项目内部(项目区不做归档写入)".into());
    }
    // R2 P0 → R4(终审 P0-5):canonical 复核必须在**任何副作用之前**——
    // `/tmp/link/sub` 指回项目时,老顺序会先在项目内建出 `sub` 再报错。
    // 用「最深已存在祖先」的 canonical 投影先裁决,过闸才允许创建。
    // (stats.root 出自 find_project,已是 canonical 锚。)
    let archive_bans = |candidate: &Path| -> std::result::Result<(), String> {
        if paths::comparison_key(candidate).starts_with(paths::comparison_key(&stats.root)) {
            return Err("归档输出目录实际位于项目内部(经符号链接),拒绝".into());
        }
        paths::validate_dest_layout(&raw_root, std::slice::from_ref(&candidate.to_path_buf()))
    };
    archive_bans(&paths::canonical_projection(&out_root)?)?;
    std::fs::create_dir_all(&out_root).map_err(|e| format!("创建输出目录失败: {e}"))?;
    if paths::is_symlink(&out_root) {
        return Err("输出目录是符号链接,拒绝".into());
    }
    // 创建后整体复核一次(防创建期间被替换;canonicalize→使用之间的极窄窗口
    // 属无锁共享盘固有边界,已声明)
    let out_root =
        std::fs::canonicalize(&out_root).map_err(|e| format!("输出目录解析失败: {e}"))?;
    archive_bans(&out_root)?;

    let handle = jobs.create_op(JobKind::Transcode, Some("archive"), &input.project_id);
    let root = stats.root.clone();
    let meta = stats.meta.clone();
    let machine_id = state.machine_id.clone();
    let config_dir = state.config_dir.clone();
    let op = super::operator(&app, &state);
    let body_app = app.clone();
    let event_app = app.clone();
    let ret = handle.clone();
    let raw_dir = project::SCENARIO_A_DIRS[1].to_string();
    let tier = input.tier;

    jobs.run(
        handle.clone(),
        || Ok(()),
        move |h| {
            super::tasks::append_audit(
                &body_app,
                &root,
                &config_dir,
                &crate::core::journal::Event::new(
                    machine_id.clone(),
                    op.clone(),
                    "transcode_started",
                    serde_json::json!({
                        "jobId": h.snapshot().id,
                        "folders": "归档",
                    }),
                ),
            );
            let mut exit_guard = TranscodeExitGuard {
                app: body_app.clone(),
                root: root.clone(),
                config_dir: config_dir.clone(),
                machine_id: machine_id.clone(),
                op: op.clone(),
                job_id: h.snapshot().id.clone(),
                armed: true,
            };
            let caps = capabilities_blocking()?;
            let ffmpeg_bin = PathBuf::from(&caps.ffmpeg.ffmpeg_path);
            let ffprobe_bin = PathBuf::from(&caps.ffmpeg.ffprobe_path);
            let pick = |ten_bit: bool| -> Option<String> {
                if ten_bit {
                    caps.winners
                        .get("hevc10_hw")
                        .or_else(|| caps.winners.get("hevc10_sw"))
                        .cloned()
                } else {
                    caps.winners
                        .get("hevc_hw")
                        .or_else(|| caps.winners.get("hevc_sw"))
                        .cloned()
                }
            };

            // 收集(与代理同一套闸)
            let raw_root = root.join(&raw_dir);
            let mut folder_enum_errors: Vec<String> = Vec::new();
            let folders: Vec<String> = match &input.camera_folders {
                Some(list) => list.clone(),
                None => {
                    let (folders, errs) = list_camera_folders(&raw_root, &raw_dir)?;
                    folder_enum_errors = errs;
                    folders
                }
            };
            let mut result = ArchiveResultDto {
                mode: "archive",
                output_dir: out_root.display().to_string(),
                ..Default::default()
            };
            for msg in folder_enum_errors.drain(..) {
                result.failures.push(FailureDto {
                    rel: raw_dir.clone(),
                    message: msg,
                });
            }
            let mut work: Vec<(String, PathBuf, String)> = Vec::new();
            for folder in &folders {
                let rel_dir = format!("{raw_dir}/{folder}");
                let dir = sorting::resolve_asset_a_in_project(&root, &meta, &rel_dir)?;
                // R2 P0:递归收集(真实相机结构嵌套);错误与符号链接都可见
                let mut vids: Vec<(PathBuf, String)> = Vec::new();
                let mut errs: Vec<String> = Vec::new();
                let mut links: Vec<String> = Vec::new();
                collect_videos_recursive(&dir, &rel_dir, &mut vids, &mut errs, &mut links);
                for msg in errs {
                    result.failures.push(FailureDto {
                        rel: rel_dir.clone(),
                        message: msg,
                    });
                }
                for rel in links {
                    result.failures.push(FailureDto {
                        rel,
                        message: "符号链接,不追踪(不会被归档)".into(),
                    });
                }
                for (p, rel) in vids {
                    work.push((folder.clone(), p, rel));
                }
            }
            work.sort_by(|a, b| a.2.cmp(&b.2));
            for rel in split_name_collisions(&mut work) {
                result.failures.push(FailureDto {
                    rel,
                    message: "与同夹另一文件仅大小写不同,输出名会互相覆盖;请改名后再归档".into(),
                });
            }

            // 空间预检:归档可接近源体积
            let total_src: u64 = work
                .iter()
                .filter_map(|(_, p, _)| std::fs::metadata(p).ok().map(|m| m.len()))
                .sum();
            match free_space_for(&out_root) {
                Some(free) if free < total_src + 2 * 1024 * 1024 * 1024 => {
                    notify::warn(
                        &body_app,
                        "disk-space-insufficient",
                        format!(
                            "归档空间预检失败:可用 {} GB,预估需要 {} GB",
                            free / 1_073_741_824,
                            (total_src + 2 * 1024 * 1024 * 1024) / 1_073_741_824
                        ),
                    );
                    return Err("输出磁盘空间不足(归档输出可接近源体积)".into());
                }
                None => notify::warn(
                    &body_app,
                    "disk-space-insufficient",
                    "无法探测输出磁盘可用空间,已跳过预检".into(),
                ),
                _ => {}
            }

            let total = work.len();
            let mut sw_fallback_notified = false;
            let mut units_done = 0usize;
            for (i, (folder, abs, rel)) in work.iter().enumerate() {
                if h.cancel_requested() {
                    break;
                }
                units_done = i;
                h.progress(i, total, 0, Some(rel.clone()));
                let _ = body_app.emit(JOB_EVENT, &h.snapshot());
                let info = match transcode::probe_file(&ffprobe_bin, abs) {
                    Ok(i) => i,
                    Err(e) => {
                        result.failures.push(FailureDto {
                            rel: rel.clone(),
                            message: format!("探测失败: {e}"),
                        });
                        continue;
                    }
                };
                let ten_bit = info.pix_fmt.contains("10le") || info.pix_fmt.contains("10be");
                let Some(encoder) = pick(ten_bit) else {
                    result.failures.push(FailureDto {
                        rel: rel.clone(),
                        message: format!("无可用 HEVC 编码器(10bit={ten_bit})"),
                    });
                    continue;
                };
                // R2 P0:相机子夹可能被预置为符号链接把写入导出根外——落地闸创建
                let out_dir = out_root.join(folder);
                if let Err(e) = paths::ensure_dir_within(&out_root, &out_dir) {
                    result.failures.push(FailureDto {
                        rel: rel.clone(),
                        message: format!("创建输出夹失败: {e}"),
                    });
                    continue;
                }
                // 本机残留 staging 清理(与代理路径同源;R2:归档此前缺席)
                if let Ok(entries) = std::fs::read_dir(&out_dir) {
                    for e in entries.flatten() {
                        let name = e.file_name().to_string_lossy().to_string();
                        if name.starts_with(&format!(".{machine_id}.")) && name.contains(".transpart")
                        {
                            let _ = std::fs::remove_file(e.path());
                        }
                    }
                }
                let stem = abs
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let ext = abs
                    .extension()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_ascii_uppercase();
                let tier_tag = match tier {
                    transcode::ArchiveTier::Quality => "hq",
                    transcode::ArchiveTier::Balanced => "std",
                    transcode::ArchiveTier::Compact => "min",
                };
                let final_out = out_dir.join(format!("{stem}_{ext}_hevc_{tier_tag}.mp4"));
                if paths::is_symlink(&final_out) {
                    result.failures.push(FailureDto {
                        rel: rel.clone(),
                        message: "输出位置是符号链接,拒绝".into(),
                    });
                    continue;
                }
                if final_out.exists() {
                    // R2 P1:「存在即成功」会永久采信坏产物(预置空文件也算完成)——
                    // 计入完成前用 ffprobe 验一次有效性,坏产物如实报失败
                    // R4/R5(终审 P0-6):属性完整校验 + 来源指纹绑定
                    let verdict = provenance_matches(&final_out, rel, abs)
                        .and_then(|_| transcode::probe_file(&ffprobe_bin, &final_out))
                        .and_then(|out_info| {
                            let pix_ok = matches!(
                                out_info.pix_fmt.as_str(),
                                "yuv420p" | "yuv420p10le" | "p010le" | "nv12"
                            );
                            if !pix_ok {
                                return Err(format!("像素格式不符: {}", out_info.pix_fmt));
                            }
                            let pix = out_info.pix_fmt.clone();
                            transcode::verify_output(&out_info, "hevc", None, &pix, &info)
                        });
                    match verdict {
                        Ok(()) => result.already_archived += 1,
                        Err(e) => result.failures.push(FailureDto {
                            rel: rel.clone(),
                            message: format!(
                                "既有归档产物未通过完整校验({e}),未计入完成;请人工确认后删除再归档"
                            ),
                        }),
                    }
                    continue;
                }
                // R2 P1:硬编缺位/失败不许静默退软编——与代理路径同一套可见性
                let hw_key = if ten_bit { "hevc10_hw" } else { "hevc_hw" };
                if !caps.winners.contains_key(hw_key) && !sw_fallback_notified {
                    notify::warn(
                        &body_app,
                        "hwenc-fallback",
                        "无可用硬件 HEVC 编码器,归档使用软件编码(明显较慢)".into(),
                    );
                    sw_fallback_notified = true;
                }
                let job_short = h.snapshot().id[..8].to_string();
                let tmp = out_dir.join(format!(".{machine_id}.{job_short}.transpart.mp4"));
                let run_once = |enc: &str| -> std::result::Result<(), String> {
                    let args = transcode::archive_args(abs, enc, tier, ten_bit, &tmp);
                    let frac_rel = rel.clone();
                    let hh = h;
                    transcode::run_transcode(
                        &ffmpeg_bin,
                        &args,
                        &tmp,
                        info.duration_secs,
                        move |frac| {
                            let msg = match frac {
                                Some(f) => format!("{frac_rel} ({:.0}%)", f * 100.0),
                                None => format!("{frac_rel} (时长未知)"),
                            };
                            hh.progress(i, total, 0, Some(msg));
                        },
                        &|| hh.cancel_requested(),
                    )
                };
                let mut used = encoder.clone();
                let mut run = run_once(&encoder);
                if let Err(e) = &run {
                    let sw_key = if ten_bit { "hevc10_sw" } else { "hevc_sw" };
                    if let Some(sw) = caps.winners.get(sw_key) {
                        if sw != &encoder
                            && transcode::is_hw_init_failure(e)
                            && !h.cancel_requested()
                        {
                            // 硬编运行时失败:同文件至多一次软编重试+可见告警(与代理同源)
                            if !sw_fallback_notified {
                                notify::warn(
                                    &body_app,
                                    "hwenc-runtime-fallback",
                                    format!("硬件编码在实际素材上初始化失败({e}),归档改用软件编码继续(明显较慢)"),
                                );
                                sw_fallback_notified = true;
                            }
                            used = sw.clone();
                            run = run_once(sw);
                        }
                    }
                }
                match run {
                    Ok(()) => {
                        let expect_pix = if ten_bit { "yuv420p10le" } else { "yuv420p" };
                        let verdict = transcode::probe_file(&ffprobe_bin, &tmp)
                            .and_then(|out_info| {
                                // 硬编 10bit 常输出 p010le,两者等价接受
                                let pix_ok = out_info.pix_fmt == expect_pix
                                    || (ten_bit && out_info.pix_fmt == "p010le");
                                if !pix_ok {
                                    return Err(format!("输出像素格式不符: {}", out_info.pix_fmt));
                                }
                                transcode::verify_output(
                                    &out_info,
                                    "hevc",
                                    None,
                                    &out_info.pix_fmt.clone(),
                                    &info,
                                )
                            })
                            .and_then(|_| {
                                crate::core::fsx::rename_no_replace(&tmp, &final_out)
                                    .map_err(|e| format!("落位失败: {e}"))
                            });
                        match verdict {
                            Ok(()) => match write_provenance(&final_out, rel, abs) {
                                Err(e) => result.failures.push(FailureDto {
                                    rel: rel.clone(),
                                    message: format!(
                                        "产物已生成但来源指纹写入失败({e}):未计入完成,重跑会重新校验"
                                    ),
                                }),
                                Ok(()) => {
                                    result.converted += 1;
                                    if result.converted == 1 {
                                        result.used_encoder = used.clone();
                                    } else if result.used_encoder != used {
                                        result.used_encoder = "混合".into(); // 一旦混编,保持「混合」
                                    }
                                }
                            },
                            Err(e) => {
                                let _ = std::fs::remove_file(&tmp);
                                result.failures.push(FailureDto {
                                    rel: rel.clone(),
                                    message: format!("输出验证失败: {e}"),
                                });
                            }
                        }
                    }
                    Err(e) if transcode::is_cancelled_err(&e) => break,
                    Err(e) => result.failures.push(FailureDto {
                        rel: rel.clone(),
                        message: e,
                    }),
                }
            }
            let cancelled = h.cancel_requested();
            // R2 P1:取消不许发布 total/total 假进度;归档同样补 fsx 回退标记消费
            let final_units = if cancelled { units_done } else { total };
            h.progress(
                final_units,
                total,
                0,
                Some(if cancelled { "已取消" } else { "收尾" }.into()),
            );
            super::sorting_cmds::notify_if_unsafe_fallback(&body_app);
            super::tasks::append_audit(
                &body_app,
                &root,
                &config_dir,
                &crate::core::journal::Event::new(
                    machine_id.clone(),
                    op.clone(),
                    if cancelled {
                        "transcode_cancelled"
                    } else {
                        "transcode_completed"
                    },
                    serde_json::json!({
                        "jobId": h.snapshot().id,
                        "archived": result.converted,
                        "failures": result.failures.len(),
                    }),
                ),
            );
            exit_guard.disarm(); // 终态审计已落,兜底解除(R5:顺序不许反)
            if !result.failures.is_empty() {
                notify::warn(
                    &body_app,
                    "transcode-partial",
                    format!(
                        "归档完成,但 {} 个文件失败(明细见结果)",
                        result.failures.len()
                    ),
                );
            }
            serde_json::to_value(&result).map_err(|e| e.to_string())
        },
        move |s: JobSnapshot| {
            let _ = event_app.emit(JOB_EVENT, &s);
        },
    );
    Ok(ret.snapshot())
}

#[cfg(test)]
mod scan_tests {
    use super::*;

    /// R2 P0:真实相机嵌套结构必须被递归收集(变异:改回单层 read_dir 本测试红)。
    #[test]
    fn recursive_scan_finds_nested_camera_layout() {
        let tmp = tempfile::tempdir().unwrap();
        let cam = tmp.path().join("A7M4_A");
        std::fs::create_dir_all(cam.join("PRIVATE/M4ROOT/CLIP")).unwrap();
        std::fs::write(cam.join("PRIVATE/M4ROOT/CLIP/C0001.MP4"), b"v").unwrap();
        std::fs::write(cam.join("TOP.MOV"), b"v").unwrap();
        // R12:被误设隐藏属性的素材夹/素材是**素材**,必须取得到源。
        // (旧口径「以点开头一律跳过」把它们整个挡在转码之外,而它们在
        // 分类界面上看得见——看得见却转不了码,还没有任何提示。)
        std::fs::create_dir_all(cam.join(".hidden")).unwrap();
        std::fs::write(cam.join(".hidden/x.mp4"), b"v").unwrap();
        std::fs::write(cam.join(".clip.mov"), b"v").unwrap();
        std::fs::write(cam.join("note.txt"), b"t").unwrap();
        let mut out = Vec::new();
        let mut errs = Vec::new();
        let mut links = Vec::new();
        collect_videos_recursive(&cam, "2. 原始素材/A7M4_A", &mut out, &mut errs, &mut links);
        let mut rels: Vec<&str> = out.iter().map(|(_, r)| r.as_str()).collect();
        rels.sort();
        assert_eq!(
            rels,
            vec![
                "2. 原始素材/A7M4_A/.clip.mov",
                "2. 原始素材/A7M4_A/.hidden/x.mp4",
                "2. 原始素材/A7M4_A/PRIVATE/M4ROOT/CLIP/C0001.MP4",
                "2. 原始素材/A7M4_A/TOP.MOV",
            ]
        );
        assert!(errs.is_empty(), "{errs:?}");
        assert!(links.is_empty());
    }

    /// R12:转码取源与拷卡/分类同一份口径([`crate::core::copy::is_system_item`])。
    ///
    /// 两个方向都要守住:
    /// - 点开头的**素材**(`.clip.mov`)必须取得到源——它拷得进 NAS、在分类
    ///   界面上看得见,取不到源就是「看得见却处理不了」的静默不一致;
    /// - 系统项必须仍被排除,尤其是**群晖 `@eaDir`**:它不以点开头,旧判据放行,
    ///   于是它里面的 `SYNOPHOTO_FILM_*.mp4`(NAS 自己生成的低码率预览)
    ///   会被当成源素材去转码,生成一份根本不是原片的代理。
    /// - 拷卡断连留下的 `<名字>.<tag>.ocardpart` 是**半截文件**,不是源。
    ///
    /// 变异:把判据改回 `name.starts_with('.')` → `.clip.mov` 取不到,本测试红。
    #[test]
    fn transcode_source_scan_shares_the_copy_whitelist() {
        let tmp = tempfile::tempdir().unwrap();
        let cam = tmp.path().join("A7M4_A");
        std::fs::create_dir_all(&cam).unwrap();
        std::fs::write(cam.join(".clip.mov"), b"v").unwrap();
        std::fs::create_dir_all(cam.join(".隐藏素材夹")).unwrap();
        std::fs::write(cam.join(".隐藏素材夹/C0002.MP4"), b"v").unwrap();
        // 系统项:一个都不许成为转码源
        std::fs::create_dir_all(cam.join("@eaDir")).unwrap();
        std::fs::write(cam.join("@eaDir/SYNOPHOTO_FILM_H264.mp4"), b"v").unwrap();
        std::fs::create_dir_all(cam.join(".@__thumb")).unwrap();
        std::fs::write(cam.join(".@__thumb/t.mp4"), b"v").unwrap();
        std::fs::create_dir_all(cam.join(".Trashes")).unwrap();
        std::fs::write(cam.join(".Trashes/已删.mp4"), b"v").unwrap();
        std::fs::write(cam.join("._C0001.MP4"), b"v").unwrap();
        std::fs::write(cam.join("C0003.MP4.tag.ocardpart"), b"half").unwrap();

        let mut out = Vec::new();
        let (mut errs, mut links) = (Vec::new(), Vec::new());
        collect_videos_recursive(&cam, "2. 原始素材/A7M4_A", &mut out, &mut errs, &mut links);
        let mut rels: Vec<&str> = out.iter().map(|(_, r)| r.as_str()).collect();
        rels.sort();
        assert_eq!(
            rels,
            vec![
                "2. 原始素材/A7M4_A/.clip.mov",
                "2. 原始素材/A7M4_A/.隐藏素材夹/C0002.MP4",
            ]
        );
    }

    /// **`.ocard/` 及其内容绝不许成为转码源。** 生产布局里 `.ocard` 是项目根的
    /// 兄弟、够不到「2. 原始素材」;这里把它直接种进相机夹和素材根,是为了正面
    /// 考共享名单的 `.ocard` 前缀项——两道保证都在,才敢说项目自己的清单、日志、
    /// 回收站不会被 ffmpeg 当成素材读进去、更不会顺着流水线进交付包。
    #[test]
    fn ocard_state_dir_is_never_a_transcode_source() {
        let tmp = tempfile::tempdir().unwrap();
        let raw = tmp.path().join("2. 原始素材");
        std::fs::create_dir_all(raw.join("A7M4_A")).unwrap();
        std::fs::write(raw.join("A7M4_A/C0001.MP4"), b"v").unwrap();
        // 项目状态目录(清单 / 日志 / 回收站 / 分析缓存),内含 .mp4 诱饵
        for d in [".ocard/manifests", ".ocard/journal", ".ocard/trash"] {
            std::fs::create_dir_all(raw.join(d)).unwrap();
            std::fs::create_dir_all(raw.join("A7M4_A").join(d)).unwrap();
            std::fs::write(raw.join(d).join("诱饵.mp4"), b"v").unwrap();
            std::fs::write(raw.join("A7M4_A").join(d).join("诱饵.mp4"), b"v").unwrap();
        }
        std::fs::write(raw.join(".ocard/settings.json"), b"{}").unwrap();

        // ① 顶层相机夹枚举:`.ocard` 不许被当成相机夹
        let (folders, errs) = list_camera_folders(&raw, "2. 原始素材").unwrap();
        assert_eq!(folders, vec!["A7M4_A".to_string()]);
        assert!(errs.is_empty(), "{errs:?}");

        // ② 递归取源:相机夹内部的 `.ocard` 也不许被下钻
        let mut out = Vec::new();
        let (mut errs, mut links) = (Vec::new(), Vec::new());
        collect_videos_recursive(
            &raw.join("A7M4_A"),
            "2. 原始素材/A7M4_A",
            &mut out,
            &mut errs,
            &mut links,
        );
        let rels: Vec<&str> = out.iter().map(|(_, r)| r.as_str()).collect();
        assert_eq!(rels, vec!["2. 原始素材/A7M4_A/C0001.MP4"]);
        assert!(
            !rels.iter().any(|r| r.contains(".ocard")),
            "`.ocard` 绝不许进转码源: {rels:?}"
        );
    }

    /// 相机夹枚举同样收口:被误设隐藏属性的相机夹(`.A7M4_A`)整夹漏转是
    /// 「一整张卡的素材没有代理」;而 `@eaDir` 不以点开头,旧判据会把它当成
    /// 一个相机夹递归进去。两个方向都在这条测试里。
    ///
    /// 变异:改回 `name.starts_with('.')` → `.A7M4_A` 消失、`@eaDir` 冒出来,必红。
    #[test]
    fn camera_folder_enumeration_shares_the_copy_whitelist() {
        let tmp = tempfile::tempdir().unwrap();
        let raw = tmp.path().join("2. 原始素材");
        for d in [
            "A7M4_A",
            ".A7M4_B",
            "@eaDir",
            ".@__thumb",
            ".Trashes",
            ".AppleDouble",
        ] {
            std::fs::create_dir_all(raw.join(d)).unwrap();
        }
        let (folders, errs) = list_camera_folders(&raw, "2. 原始素材").unwrap();
        assert_eq!(folders, vec![".A7M4_B".to_string(), "A7M4_A".to_string()]);
        assert!(errs.is_empty(), "{errs:?}");
    }

    /// 符号链接不追踪:进 links(上层转可见 skipped/failure),不入清单。
    #[cfg(unix)]
    #[test]
    fn recursive_scan_reports_symlinks_without_following() {
        let tmp = tempfile::tempdir().unwrap();
        let cam = tmp.path().join("CAM");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&cam).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("evil.MP4"), b"v").unwrap();
        std::os::unix::fs::symlink(&outside, cam.join("LINKED")).unwrap();
        let mut out = Vec::new();
        let mut errs = Vec::new();
        let mut links = Vec::new();
        collect_videos_recursive(&cam, "2. 原始素材/CAM", &mut out, &mut errs, &mut links);
        assert!(out.is_empty(), "链接目标不得被收集: {out:?}");
        assert_eq!(links, vec!["2. 原始素材/CAM/LINKED".to_string()]);
    }

    /// 目录不可读必须进 errors(零静默;阻止 auto_proxy intent 标完成)。
    #[cfg(unix)]
    #[test]
    fn recursive_scan_surfaces_unreadable_dirs() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let cam = tmp.path().join("CAM");
        let sealed = cam.join("SEALED");
        std::fs::create_dir_all(&sealed).unwrap();
        std::fs::set_permissions(&sealed, std::fs::Permissions::from_mode(0o000)).unwrap();
        let mut out = Vec::new();
        let mut errs = Vec::new();
        let mut links = Vec::new();
        collect_videos_recursive(&cam, "r", &mut out, &mut errs, &mut links);
        std::fs::set_permissions(&sealed, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            errs.iter().any(|e| e.contains("SEALED")),
            "不可读目录必须入 errors: {errs:?}"
        );
    }

    /// R4 终审 P0-8:顶层相机夹枚举里的链接/坏条目必须可见,不许静默当不存在。
    #[cfg(unix)]
    #[test]
    fn camera_folder_enumeration_surfaces_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let raw = tmp.path().join("2. 原始素材");
        std::fs::create_dir_all(raw.join("真夹")).unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, raw.join("链接夹")).unwrap();
        let (folders, errs) = list_camera_folders(&raw, "2. 原始素材").unwrap();
        assert_eq!(folders, vec!["真夹".to_string()]);
        assert!(
            errs.iter()
                .any(|e| e.contains("链接夹") && e.contains("符号链接")),
            "链接夹必须进错误清单: {errs:?}"
        );
        // 根不可读=顶层 Err(作业级失败,不静默)
        assert!(list_camera_folders(&tmp.path().join("不存在"), "x").is_err());
    }

    /// R5 终审:intent 占位/绑定/按 job 释放语义——排队取消路径靠它不卡死。
    #[test]
    fn intent_claim_bind_release_semantics() {
        let mid = format!("mid-{}", uuid::Uuid::new_v4());
        assert!(intent_claim(&mid), "首次占位成功");
        assert!(!intent_claim(&mid), "重复占位必须拒(去重)");
        intent_bind(&mid, "job-1");
        intent_release_by_job("job-别人");
        assert!(!intent_claim(&mid), "释放别的 job 不影响本意图");
        intent_release_by_job("job-1");
        assert!(intent_claim(&mid), "按 job 释放后可再次占位");
        intent_release_mid(&mid);
    }

    /// R2 P1-6:仅大小写不同的源文件映射同一输出名——后到者必须被剔除并可见。
    #[test]
    fn name_collisions_are_split_out() {
        let mut work = vec![
            (
                "CAM".to_string(),
                PathBuf::from("/x/clip.mov"),
                "2. 原始素材/CAM/clip.mov".to_string(),
            ),
            (
                "CAM".to_string(),
                PathBuf::from("/x/CLIP.MOV"),
                "2. 原始素材/CAM/CLIP.MOV".to_string(),
            ),
            (
                "CAM2".to_string(),
                PathBuf::from("/y/clip.mov"),
                "2. 原始素材/CAM2/clip.mov".to_string(),
            ),
        ];
        let clashed = split_name_collisions(&mut work);
        assert_eq!(clashed, vec!["2. 原始素材/CAM/CLIP.MOV".to_string()]);
        assert_eq!(work.len(), 2, "不同夹的同名不冲突");
    }
}
