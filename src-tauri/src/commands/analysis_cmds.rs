//! AI 客观分析作业(M3 W7a):单次解码流水线(rayon 并行——逻辑核-1,
//! 计划「物理核」按标准库能力收窄为逻辑核并记录;逐项 catch_unwind)、
//! 特征入每机纯追加缓存、缩略图顺带回填共享缓存。
//! 分析不进互斥(计划 D3):只读素材,文件被并发分类移走按 missing 处理。

use super::notify;
use super::sorting_cmds::JOB_EVENT;
use crate::core::jobs::{JobKind, JobManager, JobSnapshot};
use crate::core::{analysis, media, yunet};
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
    /// 视频首帧图已就绪数 / 引擎缺失未抽帧数(零静默)。
    pub video_thumbs: usize,
    pub video_thumbs_skipped: usize,
    /// 特征缓存坏行(零静默)。
    pub cache_skipped_lines: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisFailureDto {
    pub rel: String,
    pub message: String,
}

/// AI 硬禁用标志(D1:模型哈希不符=篡改/损坏,禁用整个 AI 功能;
/// 模型「缺失」是打包问题,降级为无人脸分析并可见 error——两种语义分开)。
static AI_DISABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 人脸推理失败计数(R2 P1:失败=faces None,聚合为可见 warning,不伪装成 0 人脸)。
static FACE_DETECT_FAILURES: AtomicUsize = AtomicUsize::new(0);

/// 启动校验:模型存在但哈希不符 → 禁用 AI + 可见 error(计划 D1)。
pub fn verify_models_on_startup<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Ok(p) = resolve_model_path(app) {
        if let Err(e) = crate::core::yunet::verify_model(&p) {
            AI_DISABLED.store(true, std::sync::atomic::Ordering::SeqCst);
            notify::error(
                app,
                "ai-models-corrupt",
                format!("AI 模型校验失败({e}):AI 选片功能已禁用;请重新安装应用"),
            );
        }
    }
    // 模型缺失不在此禁用:分析仍可跑纯算法指标,人脸缺席在作业内可见上报
}

/// 发起分析作业(工况 B「待分类」全量;幂等:指纹命中即缓存)。
#[tauri::command(async)]
pub fn start_analysis<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<super::AppState>,
    project_id: String,
) -> std::result::Result<JobSnapshot, String> {
    if AI_DISABLED.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("AI 选片功能已禁用(模型校验失败,详见通知);请重新安装应用".into());
    }
    let jobs = app.state::<Arc<JobManager>>().inner().clone();
    if jobs.has_active(JobKind::Analyze, &project_id) {
        return Err("该项目已有分析作业在进行中".into());
    }
    let nas = super::nas_root(&app, &state)?;
    let stats = super::find_project(&nas, &project_id)?;
    let files = super::sorting_cmds::inbox_files_for_analysis(&app, &stats.root)?;
    let root = stats.root.clone();
    let machine_id = state.machine_id.clone();
    // 人脸模型:资源目录解析(测试/E2E 用 OCARD_MODELS_DIR 覆盖);
    // 校验/加载失败=可见 error + 本轮 faces=None(客观分析继续,零静默)
    let model_path = resolve_model_path(&app);
    // 视频首帧抽取用捆绑 ffmpeg(缺失=保持占位,启动期已有可见提示)
    let ffmpeg_bin = crate::core::ffmpeg::detect()
        .ok()
        .map(|i| PathBuf::from(i.ffmpeg_path));
    let handle = jobs.create(JobKind::Analyze, &project_id);
    let body_app = app.clone();
    let event_app = app.clone();
    let ret = handle.clone();

    jobs.run(
        handle.clone(),
        || Ok(()),
        move |h| {
            let detector = match &model_path {
                Ok(p) => match yunet::FaceDetector::load(p) {
                    Ok(d) => Some(d),
                    Err(e) => {
                        notify::error(
                            &body_app,
                            "ai-models-corrupt",
                            format!("人脸检测模型不可用({e}):本轮分析不含人脸信息,其余客观指标不受影响"),
                        );
                        None
                    }
                },
                Err(e) => {
                    notify::error(
                        &body_app,
                        "ai-models-corrupt",
                        format!("人脸检测模型未找到({e}):本轮分析不含人脸信息"),
                    );
                    None
                }
            };
            let detector = detector.as_ref();
            let (features, skipped, read_err) = analysis::load_features(&root);
            if let Some(e) = read_err {
                notify::warn(
                    &body_app,
                    "analysis-cache-degraded",
                    format!("{e};本轮将全量重新分析"),
                );
            }
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
            let vthumbs = AtomicUsize::new(0);
            let vthumbs_skipped = AtomicUsize::new(0);
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
                        analyze_one(
                            &root,
                            &machine_id,
                            rel,
                            *size,
                            *mtime,
                            &features,
                            detector,
                            ffmpeg_bin.as_ref(),
                        )
                    }));
                    match outcome {
                        Ok(AnalyzeOne::Cached) => {
                            cached.fetch_add(1, Ordering::Relaxed);
                        }
                        Ok(AnalyzeOne::Missing) => {
                            missing.fetch_add(1, Ordering::Relaxed);
                        }
                        Ok(AnalyzeOne::VideoThumb(ok)) => {
                            if ok {
                                vthumbs.fetch_add(1, Ordering::Relaxed);
                            } else {
                                vthumbs_skipped.fetch_add(1, Ordering::Relaxed);
                            }
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
                        "{cache_write_failed} 条分析结果写入缓存失败:这些素材的角标本轮不会出现,下次分析会重算"
                    ),
                );
            }
            let face_fail = FACE_DETECT_FAILURES.swap(0, Ordering::Relaxed);
            if face_fail > 0 {
                notify::warn(
                    &body_app,
                    "face-detect-degraded",
                    format!(
                        "{face_fail} 张图片人脸检测失败(已按「人脸信息不可用」记录,客观指标不受影响)"
                    ),
                );
            }
            let result = AnalysisResultDto {
                analyzed,
                cached: cached.load(Ordering::Relaxed),
                missing: missing.load(Ordering::Relaxed),
                video_thumbs: vthumbs.load(Ordering::Relaxed),
                video_thumbs_skipped: vthumbs_skipped.load(Ordering::Relaxed),
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
    /// 视频:只补首帧图进缩略图缓存(M2 media.rs 记账;不参与聚类评分)。
    VideoThumb(bool),
    Failed(String),
}

/// 视频首帧抽取进共享缩略图缓存(引擎缺失=false,保持占位——
/// 启动期已有 ffmpeg-missing 可见提示,这里不重复轰炸)。
fn extract_video_thumb(
    root: &std::path::Path,
    rel: &str,
    size: u64,
    mtime: u128,
    abs: &std::path::Path,
    ffmpeg_bin: Option<&PathBuf>,
) -> bool {
    let Some(bin) = ffmpeg_bin else { return false };
    let cache = media::cached_thumb_path(root, rel, size, mtime);
    if cache.is_file() {
        // R4→R5(终审):首尾标记挡不住「标记完好、数据烂掉」——真实解码验真;
        // 坏缓存当场删除,走下方原子重建(不删=永远占着缓存键)
        if image::open(&cache).is_ok() {
            return true;
        }
        let _ = std::fs::remove_file(&cache);
    }
    let Some(dir) = cache.parent() else {
        return false;
    };
    // R4(终审 P0-4):此前裸 create_dir_all 绕过 `.ocard` 中间组件闸——
    // 链接可把 ffmpeg 临时文件与最终 JPEG 写出项目;与照片写路径同源过闸
    if crate::core::paths::ensure_dir_within(root, dir).is_err() {
        return false;
    }
    let tmp = dir.join(format!(".{}.vthumb.jpg", uuid::Uuid::new_v4()));
    let args = [
        "-nostdin",
        "-hide_banner",
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-ss",
        "0.5",
        "-i",
        &abs.to_string_lossy(),
        "-frames:v",
        "1",
        "-vf",
        "scale=-2:320",
        "-q:v",
        "5",
        "-n",
        &tmp.to_string_lossy(),
    ];
    let ok = matches!(
        crate::core::ffmpeg::run_with_timeout(bin, &args, std::time::Duration::from_secs(30)),
        Ok(out) if out.status.success()
    ) && tmp.is_file();
    if !ok {
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    match crate::core::fsx::rename_no_replace(&tmp, &cache) {
        Ok(()) => {
            // R5:落位后的成品也真解码验一次(ffmpeg 声称成功≠可解码)
            if image::open(&cache).is_ok() {
                true
            } else {
                let _ = std::fs::remove_file(&cache);
                false
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // 别机先落位:真解码验既有成品再采信(R4/R5)
            let _ = std::fs::remove_file(&tmp);
            image::open(&cache).is_ok()
        }
        Err(_) => {
            let _ = std::fs::remove_file(&tmp);
            false
        }
    }
}

fn resolve_model_path<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> std::result::Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("OCARD_MODELS_DIR") {
        let p = PathBuf::from(dir).join(yunet::YUNET_FILE);
        return p
            .is_file()
            .then_some(p)
            .ok_or_else(|| format!("OCARD_MODELS_DIR 下找不到 {}", yunet::YUNET_FILE));
    }
    use tauri::path::BaseDirectory;
    use tauri::Manager as _;
    app.path()
        .resolve(
            format!("resources/models/{}", yunet::YUNET_FILE),
            BaseDirectory::Resource,
        )
        .map_err(|e| e.to_string())
        .and_then(|p| {
            p.is_file()
                .then_some(p)
                .ok_or_else(|| "安装包中缺少模型资源".to_string())
        })
}

#[allow(clippy::too_many_arguments)]
fn analyze_one(
    root: &std::path::Path,
    machine_id: &str,
    rel: &str,
    size: u64,
    mtime: u128,
    features: &std::collections::HashMap<u64, analysis::FeatureRecord>,
    detector: Option<&yunet::FaceDetector>,
    ffmpeg_bin: Option<&PathBuf>,
) -> AnalyzeOne {
    let fp = analysis::src_fingerprint(rel, size, mtime);
    if let Some(rec) = features.get(&fp) {
        // R4(终审 P0-9):判定单源在 analysis::cache_hit(faces=None + 检测器在场
        // 必须重算,模型修复后自愈)
        if analysis::cache_hit(rec, detector.is_some()) {
            return AnalyzeOne::Cached;
        }
    }
    let abs: PathBuf = root.join(rel.split('/').collect::<PathBuf>());
    if !abs.exists() {
        return AnalyzeOne::Missing;
    }
    match media::classify(rel) {
        media::AssetKind::Photo => {}
        media::AssetKind::Video => {
            // 视频:补首帧图(M2 记账),不参与聚类评分
            return AnalyzeOne::VideoThumb(extract_video_thumb(
                root, rel, size, mtime, &abs, ffmpeg_bin,
            ));
        }
        _ => return AnalyzeOne::Failed("非照片类型,客观分析暂不支持".into()),
    }
    let img = match image::open(&abs) {
        Ok(i) => i,
        Err(_) if !abs.exists() => return AnalyzeOne::Missing,
        Err(e) => return AnalyzeOne::Failed(format!("解码失败: {e}")),
    };
    // EXIF 方向摆正(评审:竖拍不摆正会毁掉 dHash 聚类与人脸检测)
    let img = media::apply_orientation(img, media::exif_orientation(&abs));
    // 单次解码产出全部特征 + 回填共享缩略图缓存
    let (dhash, mut sharpness, over, under) = analysis::extract_features(&img);
    // 人脸在场:清晰度改按最大脸区域(对焦在脸=可用)。
    // R2 P1:推理失败必须记 None(=不可用)并计数上报——记 0 会被永久缓存成
    // 「确实没有人脸」,与字段语义相悖且不可辨别。
    let faces = match detector {
        None => None,
        Some(d) => match d.detect(&img) {
            Ok(list) => {
                if let Some(best) = list
                    .iter()
                    .max_by(|a, b| (a.w * a.h).total_cmp(&(b.w * b.h)))
                {
                    sharpness = analysis::sharpness_region(&img, best.x, best.y, best.w, best.h);
                }
                Some(list.len() as u32)
            }
            Err(_) => {
                FACE_DETECT_FAILURES.fetch_add(1, Ordering::Relaxed);
                None
            }
        },
    };
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
        faces_model: faces
            .is_some()
            .then(|| yunet::YUNET_SHA256[..8].to_string()),
        faces,
        analyzed_at: chrono::Utc::now(),
        machine_id: machine_id.to_string(),
    })
}

#[cfg(test)]
mod exif_orientation_tests {
    use super::*;
    use crate::core::{analysis, media};

    /// 生成带 EXIF Orientation 的不对称 JPEG 样张(SOI 后拼接 APP1 段)。
    fn write_oriented_jpeg(path: &std::path::Path, orientation: u16) {
        let img = image::RgbImage::from_fn(80, 40, |x, y| {
            if x < 20 && y < 10 {
                image::Rgb([250, 250, 250])
            } else {
                image::Rgb([10, 10, 10])
            }
        });
        let mut jpeg = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(
                &mut std::io::Cursor::new(&mut jpeg),
                image::ImageFormat::Jpeg,
            )
            .unwrap();
        let field = exif::Field {
            tag: exif::Tag::Orientation,
            ifd_num: exif::In::PRIMARY,
            value: exif::Value::Short(vec![orientation]),
        };
        let mut w = exif::experimental::Writer::new();
        w.push_field(&field);
        let mut tiff = std::io::Cursor::new(Vec::new());
        w.write(&mut tiff, false).unwrap();
        let tiff = tiff.into_inner();
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(&tiff);
        let mut out = Vec::with_capacity(jpeg.len() + payload.len() + 4);
        out.extend_from_slice(&jpeg[..2]); // SOI
        out.extend_from_slice(&[0xFF, 0xE1]);
        out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        out.extend_from_slice(&payload);
        out.extend_from_slice(&jpeg[2..]);
        std::fs::write(path, out).unwrap();
    }

    /// R2 P0-7 / R3-F2:EXIF 方向样张——索引路径(decode_oriented)与
    /// 分析路径(analyze_one 的内联摆正,为区分 Missing/Failed 而复制)
    /// 必须同向。任一路丢掉摆正,两路 dhash 对不上,本测试红。
    #[test]
    fn index_and_analysis_orient_identically() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        std::fs::create_dir_all(root.join("素材")).unwrap();
        let rel = "素材/竖拍.jpg";
        let abs = root.join("素材").join("竖拍.jpg");
        write_oriented_jpeg(&abs, 6);

        // 样张自证:EXIF 必须真的读得出 Orientation=6(拼接失败即恒真,先挡住)
        assert_eq!(
            media::exif_orientation(&abs),
            6,
            "样张 EXIF 不可读,fixture 失效"
        );

        // 索引路径:Orientation=6 是 90° 旋转,宽高必须互换
        let oriented = media::decode_oriented(&abs).unwrap();
        assert_eq!(
            (oriented.width(), oriented.height()),
            (40, 80),
            "Orientation=6 必须旋转"
        );
        // 样张自证判别力:摆正前后 dhash 必须不同
        let raw = image::open(&abs).unwrap();
        assert_ne!(
            analysis::extract_features(&raw).0,
            analysis::extract_features(&oriented).0,
            "样张摆正前后 dhash 相同,本测试无判别力"
        );

        // 分析路径:经真实 analyze_one 提取的 dhash 与索引路径一致(两路同向)
        let meta = std::fs::metadata(&abs).unwrap();
        let out = analyze_one(
            &root,
            "TEST-MACHINE",
            rel,
            meta.len(),
            media::mtime_nanos(&meta),
            &std::collections::HashMap::new(),
            None,
            None,
        );
        let AnalyzeOne::Fresh(rec) = out else {
            panic!("分析应产出 Fresh 特征");
        };
        assert_eq!(
            rec.dhash,
            analysis::extract_features(&oriented).0,
            "分析路径与索引路径必须同向(dhash 一致)"
        );
        // ALGO_VERSION 断言:EXIF 统一摆正自 v2 起进入算法口径;改变方向
        // 语义或特征口径时必须递增 ALGO_VERSION,并让缓存整体失效。
        const {
            assert!(analysis::ALGO_VERSION >= 2, "EXIF 统一摆正要求 algo v2+");
        }
        assert_eq!(rec.algo_version, analysis::ALGO_VERSION);
    }
}

#[cfg(all(test, unix))]
mod video_thumb_tests {
    use super::*;

    /// R4 终审 P0-4:`.ocard` 被换成指向项目外的链接时,视频缩略图路径必须
    /// 在闸上拒绝——用「会真写文件」的假 ffmpeg 证明:删闸(裸 create_dir_all)
    /// 时假 ffmpeg 会把帧写进外部目录,本测试红。
    #[test]
    fn video_thumb_refuses_symlinked_state_dir() {
        use std::io::Write;
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, project.join(".ocard")).unwrap();
        // 假 ffmpeg:向最后一个参数写出「JPEG 形状」文件
        let fake = tmp.path().join("ffmpeg");
        {
            let mut f = std::fs::File::create(&fake).unwrap();
            f.write_all(
                b"#!/bin/sh\nfor last; do :; done\nprintf '\\xff\\xd8x\\xff\\xd9' > \"$last\"\n",
            )
            .unwrap();
        }
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let src = project.join("v.mp4");
        std::fs::write(&src, b"not-a-real-video").unwrap();

        let ok = extract_video_thumb(&project, "1. 待分类/v.mp4", 16, 1, &src, Some(&fake));
        assert!(!ok, "链接 .ocard 下必须拒绝生成");
        assert!(
            std::fs::read_dir(&outside).unwrap().next().is_none(),
            "帧文件不得经链接写到项目外"
        );
    }

    /// R5 三票:坏缓存必须**删除并原子重建成功**——假 ffmpeg 产出真可解码
    /// JPEG,证明重建路径闭环(而不是只证明拒绝);再用产出不可解码内容的
    /// 假 ffmpeg 证明落位后验真会拒绝并清理。
    #[test]
    fn video_thumb_rebuilds_corrupt_cache_with_real_jpeg() {
        use std::io::Write;
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let src = project.join("v.mp4");
        std::fs::write(&src, b"x").unwrap();
        let cache = media::cached_thumb_path(&project, "1. 待分类/v.mp4", 1, 1);
        std::fs::create_dir_all(cache.parent().unwrap()).unwrap();
        std::fs::write(&cache, b"garbage").unwrap();
        // 真 JPEG 素材(用 image 生成,保证可解码),假 ffmpeg = cp
        let real_jpg = tmp.path().join("real.jpg");
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            8,
            8,
            image::Rgb([128, 64, 32]),
        ))
        .save(&real_jpg)
        .unwrap();
        let fake_ok = tmp.path().join("ffmpeg");
        {
            let mut f = std::fs::File::create(&fake_ok).unwrap();
            f.write_all(
                format!(
                    "#!/bin/sh\nfor last; do :; done\ncp {} \"$last\"\n",
                    real_jpg.display()
                )
                .as_bytes(),
            )
            .unwrap();
        }
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake_ok, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            extract_video_thumb(&project, "1. 待分类/v.mp4", 1, 1, &src, Some(&fake_ok)),
            "坏缓存必须被删除并用真产物原子重建成功"
        );
        assert!(image::open(&cache).is_ok(), "重建后的缓存必须真可解码");

        // 场景二:产物不可解码 → 落位后验真必须拒绝并不留缓存
        std::fs::write(&cache, b"garbage-again").unwrap();
        let fake_bad = tmp.path().join("ffmpeg-bad");
        {
            let mut f = std::fs::File::create(&fake_bad).unwrap();
            f.write_all(
                b"#!/bin/sh\nfor last; do :; done\nprintf '\\xff\\xd8x\\xff\\xd9' > \"$last\"\n",
            )
            .unwrap();
        }
        std::fs::set_permissions(&fake_bad, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            !extract_video_thumb(&project, "1. 待分类/v.mp4", 1, 1, &src, Some(&fake_bad)),
            "不可解码产物不得计成功"
        );
        assert!(!cache.exists(), "不可解码产物不得留在缓存位");
    }
}
