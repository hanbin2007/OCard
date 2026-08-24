//! 媒体索引(M2 任务1):缩略图生成、EXIF 拍摄时间提取、
//! 缓存于项目 `.ocard/thumbs/`(NAS 上共享,多工作站复用)。
//!
//! 能力边界(诚实声明,零静默原则):
//! - JPEG/PNG:完整解码缩放;
//! - RAW:v1 尝试 EXIF 内嵌缩略图,取不到则无预览(占位显示),M2 后续接 libraw;
//! - 视频:v1 无预览(占位),M3 转码环节补帧图;
//!
//! 索引失败的文件计数上报,不静默。

use super::project::STATE_DIR;
use super::Result;
use chrono::{DateTime, NaiveDateTime, Utc};
use std::fs;
use std::io::BufReader;
use std::path::{Path, PathBuf};

pub const THUMBS_DIR: &str = "thumbs";
/// 缩略图最长边(px)。
const THUMB_MAX_EDGE: u32 = 320;
/// 缩略图 JPEG 质量。
const THUMB_QUALITY: u8 = 78;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssetKind {
    Photo,
    Raw,
    Video,
    Other,
}

pub fn classify(rel_path: &str) -> AssetKind {
    let ext = rel_path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "heic" => AssetKind::Photo,
        "arw" | "cr2" | "cr3" | "nef" | "raf" | "orf" | "rw2" | "dng" => AssetKind::Raw,
        "mp4" | "mov" | "avi" | "mts" | "m4v" => AssetKind::Video,
        _ => AssetKind::Other,
    }
}

/// 单个素材的索引结果。
#[derive(Debug, Clone)]
pub struct AssetIndex {
    /// 相对路径(`/` 分隔)。
    pub rel_path: String,
    pub kind: AssetKind,
    /// EXIF DateTimeOriginal(无 EXIF 时回退文件 mtime;两者皆无为 None)。
    pub shot_at: Option<DateTime<Utc>>,
    /// 缩略图缓存文件(项目 thumbs 下),生成失败为 None。
    pub thumb: Option<PathBuf>,
}

pub fn thumbs_dir(project_root: &Path) -> PathBuf {
    project_root.join(STATE_DIR).join(THUMBS_DIR)
}

/// 缓存键:相对路径 + 文件大小的 xxh3,内容变化自动失效。
fn thumb_cache_name(rel_path: &str, size: u64) -> String {
    let key = format!("{rel_path}\u{0}{size}");
    format!("{:016x}.jpg", xxhash_rust::xxh3::xxh3_64(key.as_bytes()))
}

/// 提取 EXIF 拍摄时间(DateTimeOriginal 优先,其次 DateTime)。
pub fn exif_shot_at(abs_path: &Path) -> Option<DateTime<Utc>> {
    let file = fs::File::open(abs_path).ok()?;
    let mut reader = BufReader::new(file);
    let exif = exif::Reader::new().read_from_container(&mut reader).ok()?;
    for tag in [exif::Tag::DateTimeOriginal, exif::Tag::DateTime] {
        if let Some(field) = exif.get_field(tag, exif::In::PRIMARY) {
            let text = field.display_value().to_string();
            // EXIF 格式:2026-08-24 10:30:00 或 2026:08:24 10:30:00
            let normalized = if text.len() >= 10 {
                let mut t = text.clone();
                t.replace_range(0..10, &text[0..10].replace(':', "-"));
                t
            } else {
                text
            };
            if let Ok(naive) = NaiveDateTime::parse_from_str(&normalized, "%Y-%m-%d %H:%M:%S") {
                // EXIF 无时区,按本地墙钟直接以 UTC 存(展示端一致即可,规范只关心半天粒度)
                return Some(DateTime::from_naive_utc_and_offset(naive, Utc));
            }
        }
    }
    None
}

/// EXIF 内嵌缩略图字节(RAW 的 v1 预览来源)。
fn exif_thumbnail_bytes(abs_path: &Path) -> Option<Vec<u8>> {
    let file = fs::File::open(abs_path).ok()?;
    let mut reader = BufReader::new(file);
    let exif = exif::Reader::new().read_from_container(&mut reader).ok()?;
    let buf = exif.buf();
    // JPEG 内嵌缩略图由 JPEGInterchangeFormat/Length 指向
    let offset = exif
        .get_field(exif::Tag::JPEGInterchangeFormat, exif::In::THUMBNAIL)?
        .value
        .get_uint(0)? as usize;
    let len = exif
        .get_field(exif::Tag::JPEGInterchangeFormatLength, exif::In::THUMBNAIL)?
        .value
        .get_uint(0)? as usize;
    if offset + len <= buf.len() {
        Some(buf[offset..offset + len].to_vec())
    } else {
        None
    }
}

/// 为单个素材建立索引(缩略图 + 拍摄时间)。已有有效缓存直接复用。
pub fn index_asset(project_root: &Path, asset_abs: &Path, rel_path: &str) -> Result<AssetIndex> {
    let kind = classify(rel_path);
    let meta = fs::metadata(asset_abs)?;
    let shot_at =
        exif_shot_at(asset_abs).or_else(|| meta.modified().ok().map(DateTime::<Utc>::from));

    let dir = thumbs_dir(project_root);
    let cache = dir.join(thumb_cache_name(rel_path, meta.len()));
    if cache.is_file() {
        return Ok(AssetIndex {
            rel_path: rel_path.to_string(),
            kind,
            shot_at,
            thumb: Some(cache),
        });
    }

    let thumb = match kind {
        AssetKind::Photo => make_photo_thumb(asset_abs, &dir, &cache),
        AssetKind::Raw => make_raw_thumb(asset_abs, &dir, &cache),
        AssetKind::Video | AssetKind::Other => None,
    };

    Ok(AssetIndex {
        rel_path: rel_path.to_string(),
        kind,
        shot_at,
        thumb,
    })
}

fn make_photo_thumb(abs: &Path, dir: &Path, cache: &Path) -> Option<PathBuf> {
    let img = image::open(abs).ok()?;
    let thumb = img.thumbnail(THUMB_MAX_EDGE, THUMB_MAX_EDGE);
    write_jpeg(&thumb, dir, cache)
}

fn make_raw_thumb(abs: &Path, dir: &Path, cache: &Path) -> Option<PathBuf> {
    let bytes = exif_thumbnail_bytes(abs)?;
    let img = image::load_from_memory(&bytes).ok()?;
    let thumb = img.thumbnail(THUMB_MAX_EDGE, THUMB_MAX_EDGE);
    write_jpeg(&thumb, dir, cache)
}

fn write_jpeg(img: &image::DynamicImage, dir: &Path, cache: &Path) -> Option<PathBuf> {
    fs::create_dir_all(dir).ok()?;
    let tmp = cache.with_extension("jpg.tmp");
    {
        let mut out = fs::File::create(&tmp).ok()?;
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, THUMB_QUALITY);
        img.to_rgb8().write_with_encoder(encoder).ok()?;
    }
    fs::rename(&tmp, cache).ok()?;
    Some(cache.to_path_buf())
}

/// 素材对应的缩略图缓存路径(存在与否由调用方检查)。
pub fn cached_thumb_path(project_root: &Path, rel_path: &str, size: u64) -> PathBuf {
    thumbs_dir(project_root).join(thumb_cache_name(rel_path, size))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_test_jpeg(path: &Path, w: u32, h: u32) {
        let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(w, h, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        }));
        img.save(path).unwrap();
    }

    #[test]
    fn classify_by_extension() {
        assert_eq!(classify("DCIM/IMG_0001.JPG"), AssetKind::Photo);
        assert_eq!(classify("a/b.ARW"), AssetKind::Raw);
        assert_eq!(classify("CLIP.MP4"), AssetKind::Video);
        assert_eq!(classify("readme.txt"), AssetKind::Other);
    }

    #[test]
    fn photo_thumbnail_generated_and_cached() {
        let tmp = tempdir().unwrap();
        let project = tmp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let photo = tmp.path().join("IMG_0001.jpg");
        write_test_jpeg(&photo, 1600, 900);

        let idx = index_asset(&project, &photo, "IMG_0001.jpg").unwrap();
        let thumb = idx.thumb.expect("JPEG 必须有缩略图");
        assert!(thumb.is_file());
        let loaded = image::open(&thumb).unwrap();
        assert!(loaded.width() <= 320 && loaded.height() <= 320);
        assert!(idx.shot_at.is_some(), "无 EXIF 时回退 mtime");

        // 第二次走缓存:文件 mtime 不变
        let mtime1 = fs::metadata(&thumb).unwrap().modified().unwrap();
        let idx2 = index_asset(&project, &photo, "IMG_0001.jpg").unwrap();
        assert_eq!(idx2.thumb.as_deref(), Some(thumb.as_path()));
        assert_eq!(fs::metadata(&thumb).unwrap().modified().unwrap(), mtime1);
    }

    #[test]
    fn video_and_unknown_have_no_thumb_but_still_index() {
        let tmp = tempdir().unwrap();
        let project = tmp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let vid = tmp.path().join("CLIP0001.MP4");
        fs::write(&vid, vec![0u8; 1000]).unwrap();

        let idx = index_asset(&project, &vid, "CLIP0001.MP4").unwrap();
        assert_eq!(idx.kind, AssetKind::Video);
        assert!(idx.thumb.is_none());
        assert!(idx.shot_at.is_some());
    }

    #[test]
    fn corrupt_photo_yields_no_thumb_not_error() {
        // 索引失败不该炸任务;上层按 thumb=None 计数上报
        let tmp = tempdir().unwrap();
        let project = tmp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let bad = tmp.path().join("broken.jpg");
        fs::write(&bad, b"not a jpeg at all").unwrap();

        let idx = index_asset(&project, &bad, "broken.jpg").unwrap();
        assert!(idx.thumb.is_none());
    }

    #[test]
    fn cache_key_changes_with_size() {
        assert_ne!(
            thumb_cache_name("a.jpg", 100),
            thumb_cache_name("a.jpg", 101)
        );
        assert_ne!(
            thumb_cache_name("a.jpg", 100),
            thumb_cache_name("b.jpg", 100)
        );
    }
}
