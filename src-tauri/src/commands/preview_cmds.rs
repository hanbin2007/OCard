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

use super::{find_project, nas_root, AppState};
use crate::core::{media, preview};
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
}

/// 解一张全尺寸预览并返回可直接放进 `<img src>` 的 URL。
///
/// 失败一律是 `Err(说明为什么的整句话)`——三类(格式不支持 / 超尺寸上限 /
/// 解码失败)各说各的,界面原样展示。
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

    // 格式判定放最前面:RAW/视频即使文件不在也该报「格式不支持」,
    // 报成「文件没了」会把人引到完全错的排查方向
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

    // 命中缓存:尺寸从文件头读回来(两次头读,不解码),不额外存一份元数据表——
    // 元数据表一旦与磁盘不同步,就会出现「说是原始像素、其实是上次那张缩放图」
    if cache.hit(&cache_name).is_some() {
        if let Ok(dto) = cached_dto(cache.dir().join(&cache_name), &abs, &cache_name) {
            return Ok(dto);
        }
        // 缓存里的东西读不回尺寸:当未命中重解,不拿一份说不清的元信息糊弄界面
    }

    // 解码闸:一直按着方向键翻图时,不设闸会有十几个整幅解码同时在内存里
    let _permit = cache.decode_permit();
    // 拿到闸期间别人可能已经解好了同一张
    if cache.hit(&cache_name).is_some() {
        if let Ok(dto) = cached_dto(cache.dir().join(&cache_name), &abs, &cache_name) {
            return Ok(dto);
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

    Ok(FullPreviewDto {
        url: super::preview_proto::preview_url(&cache_name),
        width: pmeta.width,
        height: pmeta.height,
        source_width: pmeta.source_width,
        source_height: pmeta.source_height,
        downscaled: pmeta.downscaled,
        from_cache: false,
    })
}

/// 从既有缓存文件 + 原文件的**文件头**重建一份 DTO(不解码整幅)。
fn cached_dto(
    cache_path: PathBuf,
    abs: &std::path::Path,
    cache_name: &str,
) -> std::result::Result<FullPreviewDto, preview::PreviewError> {
    let (w, h) = image::image_dimensions(&cache_path)
        .map_err(|e| preview::PreviewError::Decode(e.to_string()))?;
    let (sw, sh) = preview::oriented_dimensions(abs)?;
    Ok(FullPreviewDto {
        url: super::preview_proto::preview_url(cache_name),
        width: w,
        height: h,
        source_width: sw,
        source_height: sh,
        // 判据与解码时同源:长边超过上限才叫缩放
        downscaled: sw.max(sh) > preview::MAX_EDGE,
        from_cache: true,
    })
}
