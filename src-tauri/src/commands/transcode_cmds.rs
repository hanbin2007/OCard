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
#[tauri::command]
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
#[tauri::command]
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

/// 诊断导出(计划可选建议):版本/探测明细/最近状态,不含任何素材路径。
#[tauri::command]
pub fn transcode_diagnostics() -> serde_json::Value {
    serde_json::json!({
        "ffmpeg": match ffmpeg::detect() {
            Ok(i) => serde_json::to_value(i).unwrap_or_default(),
            Err(e) => serde_json::json!({"error": e}),
        },
        "capabilities": serde_json::to_value(probe_state_dto()).unwrap_or_default(),
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
#[tauri::command]
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
    let handle = jobs.create(JobKind::Transcode, &input.project_id);
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
            let folders: Vec<String> = match &input.camera_folders {
                Some(list) => list.clone(),
                None => std::fs::read_dir(&raw_root)
                    .map_err(|e| format!("无法读取「{raw_dir}」: {e}"))?
                    .flatten()
                    .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .filter(|n| !n.starts_with('.'))
                    .collect(),
            };

            // 收集视频文件(逐夹过工况 A 命名空间闸)
            let mut dir_errors: Vec<FailureDto> = Vec::new();
            let mut work: Vec<(String, PathBuf, String)> = Vec::new(); // (folder, abs, rel)
            for folder in &folders {
                let rel_dir = format!("{raw_dir}/{folder}");
                let dir = sorting::resolve_asset_a_in_project(&root, &meta, &rel_dir)?;
                let entries = match std::fs::read_dir(&dir) {
                    Ok(e) => e,
                    Err(e) => {
                        // 目录读错不许静默吞:入失败清单,且阻止 intent 标完成(评审 P0-4)
                        dir_errors.push(FailureDto {
                            rel: rel_dir.clone(),
                            message: format!("目录读取失败: {e}"),
                        });
                        continue;
                    }
                };
                for e in entries.flatten() {
                    let p = e.path();
                    if e.file_type().map(|t| t.is_file()).unwrap_or(false) && is_video(&p) {
                        let rel = format!(
                            "{rel_dir}/{}",
                            p.file_name().unwrap_or_default().to_string_lossy()
                        );
                        work.push((folder.clone(), p, rel));
                    }
                }
            }
            work.sort_by(|a, b| a.2.cmp(&b.2));

            let mut result = ProxyResultDto {
                used_encoder: encoder.clone(),
                output_dir: root.join(&out_root_rel).display().to_string(),
                failures: dir_errors,
                ..Default::default()
            };

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
            for (i, (folder, abs, rel)) in work.iter().enumerate() {
                if h.cancel_requested() {
                    break;
                }
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
                        if let Err(e) = std::fs::remove_file(&final_out) {
                            result.failures.push(FailureDto {
                                rel: rel.clone(),
                                message: format!("删除既有代理失败: {e}"),
                            });
                            continue;
                        }
                    } else {
                        // 幂等 skip(计划 D2):不覆盖、不比对——已有输出即已完成
                        result.already_transcoded += 1;
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
                        // 落位前全量验证(计划复审 #5)
                        let verdict = transcode::probe_file(&ffprobe_bin, &tmp)
                            .and_then(|out_info| {
                                transcode::verify_output(
                                    &out_info,
                                    "h264",
                                    Some(1080),
                                    "yuv420p",
                                    &info,
                                )
                            })
                            .and_then(|_| {
                                crate::core::fsx::rename_no_replace(&tmp, &final_out)
                                    .map_err(|e| format!("落位失败: {e}"))
                            });
                        match verdict {
                            Ok(()) => {
                                result.converted += 1;
                                result.used_encoder = used.clone();
                            }
                            Err(e) => {
                                let _ = std::fs::remove_file(&tmp);
                                result.failures.push(FailureDto {
                                    rel: rel.clone(),
                                    message: format!("输出验证失败: {e}"),
                                });
                            }
                        }
                    }
                    Err(e) if e == "已取消" => break,
                    Err(e) => {
                        result.failures.push(FailureDto {
                            rel: rel.clone(),
                            message: e,
                        });
                    }
                }
            }
            let cancelled = h.cancel_requested();
            h.progress(total, total, 0, Some("收尾".into()));

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
            // auto_proxy intent:整批成功才置位(计划 D2 at-least-once)
            if let Some(mid) = &intent_manifest {
                // 评审 P0-4:空清单/读错/取消都不许标完成——attempts 上限负责最终放弃
                if !cancelled && result.failures.is_empty() && total > 0 {
                    if let Ok(mut m) = crate::core::manifest::load(&root, mid) {
                        m.proxy_completed = true;
                        if let Err(e) = crate::core::manifest::save(&root, &m) {
                            notify::warn(
                                &body_app,
                                "auto-proxy-intent-degraded",
                                format!("自动转代理完成,但意图标记写入失败({e});下次启动会重投一次(已转文件会安全跳过)"),
                            );
                        }
                    }
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

/// auto_proxy 意图派发(拷卡完成钩子与启动补投递共用)。
/// 失败不炸调用方:派发失败给可见 warning(如已有作业在跑,下次启动仍会补投)。
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
    // 永久失败不许无限重投(评审 P1-8):三次仍未整批成功即放弃,可见告知
    if m.proxy_attempts >= 3 {
        let mut done = m.clone();
        done.proxy_completed = true;
        let _ = crate::core::manifest::save(project_root, &done);
        notify::warn(
            app,
            "auto-proxy-abandoned",
            format!(
                "「{}」的自动转代理已连续 {} 次未能整批完成,停止自动重试;可在转码页手动执行(已转文件会安全跳过)",
                m.target_rel, m.proxy_attempts
            ),
        );
        return;
    }
    {
        let mut bump = m.clone();
        bump.proxy_attempts += 1;
        let _ = crate::core::manifest::save(project_root, &bump);
    }
    let Ok(meta) = project::load_meta(project_root) else {
        return;
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
        project_id,
        camera_folders: Some(vec![folder.to_string()]),
        force_all: Some(false),
        retranscode: Some(false),
    };
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
        notify::warn(
            app,
            "auto-proxy-deferred",
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
    pub converted: usize,
    pub already_archived: usize,
    pub failures: Vec<FailureDto>,
    pub used_encoder: String,
    pub output_dir: String,
}

/// 发起归档转码作业(HEVC 三档;默认不动原件;零覆盖 + skip 幂等)。
#[tauri::command]
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
    std::fs::create_dir_all(&out_root).map_err(|e| format!("创建输出目录失败: {e}"))?;
    if paths::is_symlink(&out_root) {
        return Err("输出目录是符号链接,拒绝".into());
    }

    let handle = jobs.create(JobKind::Transcode, &input.project_id);
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
            let folders: Vec<String> = match &input.camera_folders {
                Some(list) => list.clone(),
                None => std::fs::read_dir(&raw_root)
                    .map_err(|e| format!("无法读取「{raw_dir}」: {e}"))?
                    .flatten()
                    .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .filter(|n| !n.starts_with('.'))
                    .collect(),
            };
            let mut result = ArchiveResultDto {
                output_dir: out_root.display().to_string(),
                ..Default::default()
            };
            let mut work: Vec<(String, PathBuf, String)> = Vec::new();
            for folder in &folders {
                let rel_dir = format!("{raw_dir}/{folder}");
                let dir = sorting::resolve_asset_a_in_project(&root, &meta, &rel_dir)?;
                match std::fs::read_dir(&dir) {
                    Ok(entries) => {
                        for e in entries.flatten() {
                            let p = e.path();
                            if e.file_type().map(|t| t.is_file()).unwrap_or(false) && is_video(&p) {
                                let rel = format!(
                                    "{rel_dir}/{}",
                                    p.file_name().unwrap_or_default().to_string_lossy()
                                );
                                work.push((folder.clone(), p, rel));
                            }
                        }
                    }
                    Err(e) => result.failures.push(FailureDto {
                        rel: rel_dir.clone(),
                        message: format!("目录读取失败: {e}"),
                    }),
                }
            }
            work.sort_by(|a, b| a.2.cmp(&b.2));

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
            for (i, (folder, abs, rel)) in work.iter().enumerate() {
                if h.cancel_requested() {
                    break;
                }
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
                let out_dir = out_root.join(folder);
                if let Err(e) = std::fs::create_dir_all(&out_dir) {
                    result.failures.push(FailureDto {
                        rel: rel.clone(),
                        message: format!("创建输出夹失败: {e}"),
                    });
                    continue;
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
                    result.already_archived += 1;
                    continue;
                }
                let job_short = h.snapshot().id[..8].to_string();
                let tmp = out_dir.join(format!(".{machine_id}.{job_short}.transpart.mp4"));
                let args = transcode::archive_args(abs, &encoder, tier, ten_bit, &tmp);
                let frac_rel = rel.clone();
                let hh = h;
                let run = transcode::run_transcode(
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
                );
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
                            Ok(()) => {
                                result.converted += 1;
                                result.used_encoder = encoder.clone();
                            }
                            Err(e) => {
                                let _ = std::fs::remove_file(&tmp);
                                result.failures.push(FailureDto {
                                    rel: rel.clone(),
                                    message: format!("输出验证失败: {e}"),
                                });
                            }
                        }
                    }
                    Err(e) if e == "已取消" => break,
                    Err(e) => result.failures.push(FailureDto {
                        rel: rel.clone(),
                        message: e,
                    }),
                }
            }
            let cancelled = h.cancel_requested();
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
