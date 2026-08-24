//! AI 客观分析作业(M3 W7a):单次解码流水线(rayon 并行、逐项 catch_unwind)、
//! 特征入每机纯追加缓存、缩略图顺带回填共享缓存。
//! 分析不进互斥(计划 D3):只读素材,文件被并发分类移走按 missing 处理。

use super::notify;
use super::sorting_cmds::JOB_EVENT;
use crate::core::jobs::{JobKind, JobManager, JobSnapshot};
use crate::core::{analysis, media};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisResultDto {
    pub analyzed: usize,
    /// 缓存命中(指纹一致,免重算)。
    pub cached: usize,
    /// 分析期间被移走/删除(不是失败)。
    pub missing: usize,
    pub failed: Vec<AnalysisFailureDto>,
    /// 特征缓存坏行(零静默)。
    pub cache_skipped_lines: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisFailureDto {
    pub rel: String,
    pub message: String,
}

/// 发起分析作业(工况 B「待分类」全量;幂等:指纹命中即缓存)。
#[tauri::command]
pub fn start_analysis<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<super::AppState>,
    project_id: String,
) -> std::result::Result<JobSnapshot, String> {
    let jobs = app.state::<Arc<JobManager>>().inner().clone();
    if jobs.has_active(JobKind::Analyze, &project_id) {
        return Err("该项目已有分析作业在进行中".into());
    }
    let nas = super::nas_root(&app, &state)?;
    let stats = super::find_project(&nas, &project_id)?;
    let files = super::sorting_cmds::inbox_files_for_analysis(&stats.root)?;
    let root = stats.root.clone();
    let machine_id = state.machine_id.clone();
    let handle = jobs.create(JobKind::Analyze, &project_id);
    let body_app = app.clone();
    let event_app = app.clone();
    let ret = handle.clone();

    jobs.run(
        handle.clone(),
        || Ok(()),
        move |h| {
            let (features, skipped) = analysis::load_features(&root);
            if skipped > 0 {
                notify::warn(
                    &body_app,
                    "analysis-cache-degraded",
                    format!("分析特征缓存有 {skipped} 行损坏被跳过,相关素材会重新分析"),
                );
            }
            let total = files.len();
            let done = AtomicUsize::new(0);
            let cached = AtomicUsize::new(0);
            let missing = AtomicUsize::new(0);
            let failures = std::sync::Mutex::new(Vec::<AnalysisFailureDto>::new());
            let new_features = std::sync::Mutex::new(Vec::<analysis::FeatureRecord>::new());
            let last_emit = std::sync::Mutex::new(std::time::Instant::now());

            // rayon 并行(物理核-1);每项 catch_unwind 隔离(计划 C2/W7)
            let workers = std::thread::available_parallelism()
                .map(|n| n.get().saturating_sub(1).max(1))
                .unwrap_or(2);
            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(workers)
                .build()
                .map_err(|e| format!("线程池创建失败: {e}"))?;
            pool.install(|| {
                use rayon::prelude::*;
                files.par_iter().for_each(|(rel, size, mtime)| {
                    if h.cancel_requested() {
                        return;
                    }
                    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        analyze_one(&root, &machine_id, rel, *size, *mtime, &features)
                    }));
                    match outcome {
                        Ok(AnalyzeOne::Cached) => {
                            cached.fetch_add(1, Ordering::Relaxed);
                        }
                        Ok(AnalyzeOne::Missing) => {
                            missing.fetch_add(1, Ordering::Relaxed);
                        }
                        Ok(AnalyzeOne::Fresh(rec)) => {
                            new_features
                                .lock()
                                .unwrap_or_else(|p| p.into_inner())
                                .push(rec);
                        }
                        Ok(AnalyzeOne::Failed(msg)) => failures
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .push(AnalysisFailureDto {
                                rel: rel.clone(),
                                message: msg,
                            }),
                        Err(_) => failures
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .push(AnalysisFailureDto {
                                rel: rel.clone(),
                                message: "分析线程异常(panic),该文件跳过".into(),
                            }),
                    }
                    let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                    h.progress(d, total, 0, Some(rel.clone()));
                    let mut le = last_emit.lock().unwrap_or_else(|p| p.into_inner());
                    if le.elapsed().as_millis() >= 500 {
                        *le = std::time::Instant::now();
                        let _ = body_app.emit(JOB_EVENT, &h.snapshot());
                    }
                });
            });

            // 特征串行落盘(并发 append 同一文件会交错断行)
            let fresh = new_features.into_inner().unwrap_or_default();
            let analyzed = fresh.len();
            let mut cache_write_failed = 0usize;
            for rec in &fresh {
                if analysis::append_feature(&root, &machine_id, rec).is_err() {
                    cache_write_failed += 1;
                }
            }
            if cache_write_failed > 0 {
                notify::warn(
                    &body_app,
                    "analysis-cache-degraded",
                    format!(
                        "{cache_write_failed} 条分析结果写入缓存失败(结果本轮可用,重启后这些素材会重新分析)"
                    ),
                );
            }
            let result = AnalysisResultDto {
                analyzed,
                cached: cached.load(Ordering::Relaxed),
                missing: missing.load(Ordering::Relaxed),
                failed: failures.into_inner().unwrap_or_default(),
                cache_skipped_lines: skipped,
            };
            if !result.failed.is_empty() {
                notify::warn(
                    &body_app,
                    "analysis-partial",
                    format!("分析完成,{} 个文件失败(损坏或不支持的格式)", result.failed.len()),
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

enum AnalyzeOne {
    Cached,
    Missing,
    Fresh(analysis::FeatureRecord),
    Failed(String),
}

fn analyze_one(
    root: &std::path::Path,
    machine_id: &str,
    rel: &str,
    size: u64,
    mtime: u128,
    features: &std::collections::HashMap<u64, analysis::FeatureRecord>,
) -> AnalyzeOne {
    let fp = analysis::src_fingerprint(rel, size, mtime);
    if features.contains_key(&fp) {
        return AnalyzeOne::Cached;
    }
    let abs: PathBuf = root.join(rel.split('/').collect::<PathBuf>());
    if !abs.exists() {
        return AnalyzeOne::Missing;
    }
    // 只分析可解码的照片(RAW 用内嵌预览归 W7b;视频不参与聚类评分)
    if !matches!(media::classify(rel), media::AssetKind::Photo) {
        return AnalyzeOne::Failed("非照片类型,客观分析暂不支持".into());
    }
    let img = match image::open(&abs) {
        Ok(i) => i,
        Err(_) if !abs.exists() => return AnalyzeOne::Missing,
        Err(e) => return AnalyzeOne::Failed(format!("解码失败: {e}")),
    };
    // 单次解码产出全部特征 + 回填共享缩略图缓存
    let (dhash, sharpness, over, under) = analysis::extract_features(&img);
    let _ = media::store_thumb_from_image(root, rel, size, mtime, &img);
    let shot_at_epoch = media::exif_shot_at(&abs)
        .map(|t| t.timestamp())
        .or_else(|| {
            std::fs::metadata(&abs)
                .ok()
                .and_then(|m| m.modified().ok())
                .map(|t| chrono::DateTime::<chrono::Utc>::from(t).timestamp())
        });
    AnalyzeOne::Fresh(analysis::FeatureRecord {
        rel: rel.to_string(),
        src_fingerprint: fp,
        schema_version: analysis::SCHEMA_VERSION,
        algo_version: analysis::ALGO_VERSION,
        dhash,
        sharpness,
        over_exposed: over,
        under_exposed: under,
        shot_at_epoch,
        analyzed_at: chrono::Utc::now(),
        machine_id: machine_id.to_string(),
    })
}
