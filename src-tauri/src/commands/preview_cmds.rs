//! 全屏预览的全尺寸取图命令(契约见 src/api/types.ts 的 `FullPreview`)。
//!
//! 这条路径存在的理由:全屏预览此前放大的是 320px 缩略图,而选片时在全屏里
//! 判的就是虚实与对焦——**放大的缩略图判不了**,用户却会以为自己在看原图。
//!
//! 口径:
//! - **按需**:只有前端打开全屏才 invoke,索引阶段一张都不解;
//! - **不卡 UI**:`#[tauri::command(async)]`(见 `commands/mod.rs` 头部纪律);
//! - **有闸**:单张像素上限 + 同时只放一张进解码器(见 `core::preview`);
//! - **零静默**:解不了就返回一条**说明为什么**的错误,由界面原样展示;
//!   绝不返回 Ok 然后让界面停在缩略图装作没事。
//!
//! ## RAW 内嵌预览的「够不够用」采样(统计口径)
//!
//! RAW 走的是相机内嵌的 JPEG,而**内嵌预览多大由机身决定**:有的机身写全尺寸,
//! 有的只写半幅,老机身只有缩略级。将来要不要花力气接一个真正的 RAW 解码器,
//! 取决于「实际在用的这批机身里,有多少 RAW 只有半幅/缩略级预览」。
//!
//! 所以每解出/取回一张 RAW 内嵌预览,就往**运行日志**里落一行结构化采样
//! (见 [`log_raw_adequacy`])。为什么是日志,不是审计事件、也不是通知:
//!
//! - **不进项目日志(journal)**:那份日志是要被重放折叠成项目状态的,
//!   而「谁在哪台机器上打开过哪张大图」不是项目事实。一次选片翻几千张,
//!   几千行进去只会把重放拖慢,还写在 NAS 上;
//! - **不进通知中心**:用户该看见的那句话(半幅/缩略级判不了虚实)
//!   已经常驻在大图顶上了。再发一条通知是同一件事说两遍,属于噪音;
//!   通知位是留给「需要你现在做点什么」的;
//! - **落运行日志**:零新增基建(`tauri_plugin_log` 已经在轮转落盘,
//!   而且通知本来就镜像进这里),按行可 grep,带 `asset=` 于是重复打开
//!   同一张能靠 `sort -u` 去重。要那个比例时:
//!
//!   ```text
//!   grep raw-preview-adequacy ocard.log | sed 's/.*asset=//' | sort -u \
//!     | grep -o 'adequacy=[a-zA-Z]*' | sort | uniq -c
//!   ```

use super::{find_project, nas_root, AppState};
use crate::core::preview_raw::PreviewAdequacy;
use crate::core::{media, preview, preview_ffmpeg};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, State};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullPreviewDto {
    /// `preview://localhost/<cacheName>`(Windows 上是 http://preview.localhost/...)
    pub url: String,
    /// 实际呈现的像素尺寸
    pub width: u32,
    pub height: u32,
    /// 摆正后的原始像素尺寸
    pub source_width: u32,
    pub source_height: u32,
    /// true = 原图超过长边上限被缩放呈现。界面**必须**据此说明「不是原始像素」
    pub downscaled: bool,
    /// 本次是否命中本机缓存(诊断用;界面不据此改文案)
    pub from_cache: bool,
    /// 这张图**是什么**:`"original"` = 就是这张照片本身;
    /// `"videoFrame"` = 视频里的一帧;`"rawEmbedded"` = RAW 里相机自己
    /// 渲染进去的那张 JPEG。界面必须据此决定还要不要多说一句——
    /// 一帧静止画面代表不了一整条素材、一张内嵌预览不是解出来的 RAW,
    /// 不说清就是另一种静默降级。
    pub kind: &'static str,
    /// 视频帧:抽的是第几秒(非视频为 None)
    pub frame_at_sec: Option<f64>,
    /// 视频帧:整段多长(读不出为 None)
    pub duration_sec: Option<f64>,
    /// RAW 内嵌预览:够不够判虚实(四档,见 `core::preview_raw`)。
    /// `"fullSize"` | `"reduced"` | `"thumbnailOnly"` | `"unknown"`;
    /// 非 RAW 为 None。界面**必须**分四档处置——尤其不许把 `unknown`
    /// 当成 `fullSize`:那是「不知道」,不是「够用」。
    pub raw_adequacy: Option<&'static str>,
    /// RAW 内嵌预览:后端 `EmbeddedPreview::warning()` 的**原话**。
    /// 只有 `fullSize` 一档是 None——那一档要说的话由界面补
    /// (「这是机内渲染的 JPEG,不是解出来的 RAW」)。
    pub raw_warning: Option<String>,
}

impl FullPreviewDto {
    /// 把解码结果里的「来路」摊平进 DTO。序列化成扁平字段而不是嵌套对象:
    /// 前端 `previewNotice` 是个纯函数,扁平的形状让它一眼能读。
    fn with_source(mut self, source: &preview::PreviewSource) -> Self {
        match source {
            preview::PreviewSource::Original => {
                self.kind = "original";
            }
            preview::PreviewSource::VideoFrame {
                at_sec,
                duration_sec,
            } => {
                self.kind = "videoFrame";
                self.frame_at_sec = *at_sec;
                self.duration_sec = *duration_sec;
            }
            preview::PreviewSource::RawEmbedded {
                adequacy, warning, ..
            } => {
                self.kind = "rawEmbedded";
                self.raw_adequacy = Some(adequacy_code(*adequacy));
                // 原话透传:那句话是后端按 adequacy 算出来的,前端再拼一遍
                // 只会多出一条会漂移的措辞
                self.raw_warning = warning.clone();
            }
        }
        self
    }
}

/// `PreviewAdequacy` 的线上编码(前端按它分四档,不按中文文案匹配)。
fn adequacy_code(a: PreviewAdequacy) -> &'static str {
    match a {
        PreviewAdequacy::FullSize => "fullSize",
        PreviewAdequacy::Reduced => "reduced",
        PreviewAdequacy::ThumbnailOnly => "thumbnailOnly",
        PreviewAdequacy::Unknown => "unknown",
    }
}

/// 采样行的前缀。**改它就等于把历史日志和取数命令割裂开**,
/// 所以它是个常量,并且被单测钉着。
const RAW_ADEQUACY_TAG: &str = "[raw-preview-adequacy]";

/// 拼一行「够不够用」采样。非 RAW 返回 `None`(什么都不记)。
///
/// 做成纯函数是为了让这行的**形状**能被单测钉住:它是拿来回答
/// 「这批机身里有多少 RAW 只有半幅/缩略级预览」的原始数据,
/// 字段名一改,过去攒的日志就白攒了。
fn raw_adequacy_line(
    project_id: &str,
    asset_id: &str,
    source: &preview::PreviewSource,
    cached: bool,
) -> Option<String> {
    let preview::PreviewSource::RawEmbedded {
        adequacy,
        embedded,
        full,
        fraction,
        tag,
        ..
    } = source
    else {
        return None;
    };
    // 读不到的一律写 `unknown` 而不是留空:留空的字段在 grep 出来的行里
    // 会和「这一列不存在」混作一谈
    let full = full
        .map(|(w, h)| format!("{w}x{h}"))
        .unwrap_or_else(|| "unknown".to_string());
    let fraction = fraction
        .map(|f| format!("{f:.3}"))
        .unwrap_or_else(|| "unknown".to_string());
    Some(format!(
        "{RAW_ADEQUACY_TAG} project={project_id} asset={asset_id} adequacy={} \
         preview={}x{} full={full} fraction={fraction} cached={cached} tag={tag}",
        adequacy_code(*adequacy),
        embedded.0,
        embedded.1,
    ))
}

/// RAW 内嵌预览的「够不够用」采样,落一行运行日志(理由见模块头注释)。
///
/// 非 RAW 什么都不做。一行一次取图(命中缓存也算,带 `cached=`),
/// 带 `asset=` 于是同一张重复打开可以靠 `sort -u` 去重。
fn log_raw_adequacy(
    project_id: &str,
    asset_id: &str,
    source: &preview::PreviewSource,
    cached: bool,
) {
    if let Some(line) = raw_adequacy_line(project_id, asset_id, source, cached) {
        log::info!("{line}");
    }
}

/// 解一张全尺寸预览并返回可直接放进 `<img src>` 的 URL。
///
/// 失败一律是 `Err(说明为什么的整句话)`——格式不支持 / 超尺寸上限 / 解码失败 /
/// sidecar 那五类 / RAW 那五类,各说各的,界面原样展示。
///
/// **成功也不等于「没话说」**:RAW 走的是相机内嵌预览,它可能只有半幅甚至
/// 缩略级;那件事经 `rawAdequacy` / `rawWarning` 一路带到界面。
#[tauri::command(async)]
pub fn load_full_preview<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    project_id: String,
    asset_id: String,
) -> std::result::Result<FullPreviewDto, String> {
    // 外部输入的相对路径闸:asset_id 来自前端,必须过一遍才敢拼进项目根
    if !crate::core::paths::is_safe_rel(&asset_id) {
        return Err(format!("素材路径不合法: {asset_id}"));
    }
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;
    let abs = stats.root.join(asset_id.split('/').collect::<PathBuf>());
    crate::core::paths::assert_within(&stats.root, &abs)?;

    // 格式判定放最前面:没人认领的扩展名即使文件不在也该报「格式不支持」,
    // 报成「文件没了」会把人引到完全错的排查方向。
    // RAW/视频/HEIC 都有人认领,能不能解由真解一次来答
    if let Err(unsupported) = preview::full_decode_support(&asset_id) {
        return Err(unsupported.to_string());
    }
    let meta = std::fs::metadata(&abs).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            preview::PreviewError::SourceGone.to_string()
        } else {
            preview::PreviewError::Io(e.to_string()).to_string()
        }
    })?;
    let cache_name = preview::preview_cache_name(&asset_id, meta.len(), media::mtime_nanos(&meta));
    let cache = &state.preview_cache;

    let decoder = preview::decoder_for(&asset_id);

    // 三条出路(缓存命中两次 + 真解一次)在这里收成**一个**出口,
    // 于是 RAW 的 adequacy 采样不会漏掉其中任何一条
    let (dto, source) = 'resolve: {
        // 命中缓存:尺寸从文件头读回来(两次头读,不解码),不额外存一份元数据表——
        // 元数据表一旦与磁盘不同步,就会出现「说是原始像素、其实是上次那张缩放图」
        if cache.hit(&cache_name).is_some() {
            if let Ok(pair) = cached_dto(cache.dir().join(&cache_name), &abs, &cache_name, &decoder)
            {
                break 'resolve pair;
            }
            // 缓存里的东西读不回尺寸:当未命中重解,不拿一份说不清的元信息糊弄界面
        }

        // 解码闸:一直按着方向键翻图时,不设闸会有十几个整幅解码同时在内存里。
        // **sidecar 与 RAW 那几条支路同样受这道闸约束**:一个 ffmpeg 进程能吃满
        // 一个核、一张 45MP 内嵌 JPEG 解出来也是几百 MB,
        // 按住方向键扫过一串就会同时起十几个
        let _permit = cache.decode_permit();
        // 拿到闸期间别人可能已经解好了同一张
        if cache.hit(&cache_name).is_some() {
            if let Ok(pair) = cached_dto(cache.dir().join(&cache_name), &abs, &cache_name, &decoder)
            {
                break 'resolve pair;
            }
        }

        let (img, pmeta) = preview::decode_full_preview(&abs, &asset_id).map_err(|e| {
            log::warn!("全尺寸预览失败 {}/{}: {e}", project_id, asset_id);
            e.to_string()
        })?;
        let bytes = preview::encode_preview(&img).map_err(|e| e.to_string())?;
        drop(img); // 整幅位图尽早还给分配器,别和 JPEG 缓冲一起占着
        cache
            .store(&cache_name, &bytes)
            .map_err(|e| e.to_string())?;

        let dto = FullPreviewDto {
            url: super::preview_proto::preview_url(&cache_name),
            width: pmeta.width,
            height: pmeta.height,
            source_width: pmeta.source_width,
            source_height: pmeta.source_height,
            downscaled: pmeta.downscaled,
            from_cache: false,
            kind: "original",
            frame_at_sec: None,
            duration_sec: None,
            raw_adequacy: None,
            raw_warning: None,
        }
        .with_source(&pmeta.source);
        (dto, pmeta.source)
    };

    log_raw_adequacy(&project_id, &asset_id, &source, dto.from_cache);
    Ok(dto)
}

/// 从既有缓存文件 + 原文件重建一份 DTO(不解码整幅)。
///
/// 「原始尺寸从哪来」按解码器分道:
/// - JPEG/PNG 读原文件的**文件头**(两次头读,不解码);
/// - 视频/HEIC 读不出图像文件头(`image::image_dimensions` 对 mp4 只会报错),
///   改用一次 ffprobe。它比重新抽一帧便宜得多,而且和解码那条路问的是
///   **同一个来源**——不引入第二份可能与磁盘不同步的元数据;
/// - RAW 重跑一次 `extract_embedded_preview`。它读标签 + 读那段 JPEG 字节
///   (不解整幅、不重新编码),比整条解码路便宜得多;更要紧的是
///   **adequacy / warning 与解码那条路同源**。把这两样存进一份旁路元数据表
///   看着更省,但那张表一旦与磁盘不同步,就会出现「界面说全尺寸、
///   其实端的是上次那张半幅」——正是这一路要修的那个 bug。
///
/// 任何一步答不上来就返回 Err,由调用方当未命中重解:宁可多解一次,
/// 也不端一份说不清的元信息给界面。
fn cached_dto(
    cache_path: PathBuf,
    abs: &std::path::Path,
    cache_name: &str,
    decoder: &preview::PreviewDecoder,
) -> std::result::Result<(FullPreviewDto, preview::PreviewSource), preview::PreviewError> {
    let (w, h) = image::image_dimensions(&cache_path)
        .map_err(|e| preview::PreviewError::Decode(e.to_string()))?;
    let base = FullPreviewDto {
        url: super::preview_proto::preview_url(cache_name),
        width: w,
        height: h,
        source_width: w,
        source_height: h,
        downscaled: false,
        from_cache: true,
        kind: "original",
        frame_at_sec: None,
        duration_sec: None,
        raw_adequacy: None,
        raw_warning: None,
    };
    let kind = match decoder {
        preview::PreviewDecoder::Native => {
            let (sw, sh) = preview::oriented_dimensions(abs)?;
            return Ok((
                FullPreviewDto {
                    source_width: sw,
                    source_height: sh,
                    // 判据与解码时同源:长边超过上限才叫缩放
                    downscaled: sw.max(sh) > preview::MAX_EDGE,
                    ..base
                },
                preview::PreviewSource::Original,
            ));
        }
        preview::PreviewDecoder::RawEmbedded(_) => {
            // 报给界面的必须是**摆正后**的尺寸,和解码那条路(finish 量的是
            // 摆正后的图)一个口径
            let (source, (sw, sh)) = preview::raw_embedded_source(abs)?;
            return Ok((
                FullPreviewDto {
                    source_width: sw,
                    source_height: sh,
                    downscaled: sw.max(sh) > preview::MAX_EDGE,
                    ..base
                }
                .with_source(&source),
                source,
            ));
        }
        preview::PreviewDecoder::VideoFrame => preview_ffmpeg::StillKind::VideoFrame,
        preview::PreviewDecoder::HeifStill => preview_ffmpeg::StillKind::HeifStill,
        // 这一支根本不会落盘缓存(解码前就返回错误了)
        preview::PreviewDecoder::Unsupported(_) => {
            return Err(preview::PreviewError::Decode(
                "该格式没有可复用的缓存元信息".into(),
            ))
        }
    };
    let probed = preview_ffmpeg::probe(abs, kind).map_err(preview::PreviewError::Still)?;
    let dto = FullPreviewDto {
        source_width: probed.width,
        source_height: probed.height,
        downscaled: probed.width.max(probed.height) > preview::MAX_EDGE,
        ..base
    };
    let source = match kind {
        preview_ffmpeg::StillKind::HeifStill => preview::PreviewSource::Original,
        preview_ffmpeg::StillKind::VideoFrame => preview::PreviewSource::VideoFrame {
            // 时长已知时选帧是**确定性**的(时长 → 时间点是个纯函数,
            // 而且那条路不许退帧),所以不必把秒数存进缓存也能如实重算。
            // 时长读不出时解码那条路可能退回过开头,这里重算不出来——
            // 于是照样报 None,由界面说「开头的一帧」,不编一个数字
            at_sec: probed
                .duration_sec
                .map(|_| preview_ffmpeg::frame_time_for(kind, probed.duration_sec)),
            duration_sec: probed.duration_sec,
        },
    };
    Ok((dto.with_source(&source), source))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::preview::PreviewSource;

    fn raw(
        adequacy: PreviewAdequacy,
        full: Option<(u32, u32)>,
        fraction: Option<f32>,
    ) -> PreviewSource {
        PreviewSource::RawEmbedded {
            adequacy,
            embedded: (4128, 2752),
            full,
            fraction,
            tag: "TIFF IFD · JPEGInterchangeFormat",
            warning: Some("半幅".into()),
        }
    }

    /// 采样行的形状 = 将来回答「这批机身多少 RAW 只有半幅预览」的原始数据。
    /// 字段名一改,过去攒下的日志就白攒了,所以逐项钉住。
    #[test]
    fn adequacy_sample_line_carries_everything_the_question_needs() {
        let line = raw_adequacy_line(
            "20260824_校运会",
            "1. 待分类/DSC_0007.NEF",
            &raw(PreviewAdequacy::Reduced, Some((8256, 5504)), Some(0.5)),
            false,
        )
        .expect("RAW 必须落一行");
        // 前缀:取数命令按它 grep
        assert!(line.starts_with(RAW_ADEQUACY_TAG), "{line}");
        // asset:同一张重复打开靠它 `sort -u` 去重,不然比例会被翻图次数带偏
        assert!(line.contains("asset=1. 待分类/DSC_0007.NEF"), "{line}");
        // 机身线索:扩展名在 asset 里,标签位置在 tag 里
        assert!(
            line.contains("tag=TIFF IFD · JPEGInterchangeFormat"),
            "{line}"
        );
        assert!(line.contains("adequacy=reduced"), "{line}");
        assert!(line.contains("preview=4128x2752"), "{line}");
        assert!(line.contains("full=8256x5504"), "{line}");
        assert!(line.contains("fraction=0.500"), "{line}");
        assert!(line.contains("cached=false"), "{line}");
        // 单行:多行会把 grep 出来的记录切断
        assert!(!line.contains('\n'), "采样必须是单行: {line}");
    }

    /// 读不到的字段写 `unknown`,不留空——留空会和「这一列不存在」混作一谈。
    #[test]
    fn missing_numbers_say_unknown_rather_than_going_blank() {
        let line = raw_adequacy_line(
            "p",
            "a.NEF",
            &raw(PreviewAdequacy::Unknown, None, None),
            true,
        )
        .unwrap();
        assert!(line.contains("adequacy=unknown"), "{line}");
        assert!(line.contains("full=unknown"), "{line}");
        assert!(line.contains("fraction=unknown"), "{line}");
        assert!(line.contains("cached=true"), "{line}");
    }

    /// 非 RAW 一行都不记:这份采样只回答 RAW 那个问题,掺进别的会污染分母。
    #[test]
    fn non_raw_sources_are_not_sampled() {
        assert!(raw_adequacy_line("p", "a.jpg", &PreviewSource::Original, false).is_none());
        assert!(raw_adequacy_line(
            "p",
            "a.mp4",
            &PreviewSource::VideoFrame {
                at_sec: Some(1.0),
                duration_sec: Some(12.0),
            },
            false,
        )
        .is_none());
    }

    /// 四档的线上编码是前端分档的依据,不许悄悄改字符串。
    #[test]
    fn adequacy_codes_are_the_wire_contract() {
        assert_eq!(adequacy_code(PreviewAdequacy::FullSize), "fullSize");
        assert_eq!(adequacy_code(PreviewAdequacy::Reduced), "reduced");
        assert_eq!(
            adequacy_code(PreviewAdequacy::ThumbnailOnly),
            "thumbnailOnly"
        );
        assert_eq!(
            adequacy_code(PreviewAdequacy::Unknown),
            "unknown",
            "「不知道」不能编码成「够用」——那正是这一路要修的那个 bug"
        );
    }
}
