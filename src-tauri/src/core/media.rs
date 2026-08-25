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

/// 缓存键:相对路径 + 大小 + mtime 的 xxh3——同名同大小替换(mtime 变)
/// 也会失效重建(复验轮二:缓存键不含 mtime 会抵消指纹重索引的意义)。
fn thumb_cache_name(rel_path: &str, size: u64, mtime_nanos: u128) -> String {
    let key = format!("{rel_path}\u{0}{size}\u{0}{mtime_nanos}");
    format!("{:016x}.jpg", xxhash_rust::xxh3::xxh3_64(key.as_bytes()))
}

/// 文件 mtime 的纳秒表示(取不到按 0:键退化为路径+大小,仍安全)。
pub fn mtime_nanos(meta: &fs::Metadata) -> u128 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// EXIF Orientation(1-8;取不到按 1)。
pub fn exif_orientation(abs_path: &Path) -> u32 {
    let Ok(file) = fs::File::open(abs_path) else {
        return 1;
    };
    let mut reader = BufReader::new(file);
    let Ok(exif) = exif::Reader::new().read_from_container(&mut reader) else {
        return 1;
    };
    exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .filter(|v| (1..=8).contains(v))
        .unwrap_or(1)
}

/// 按 EXIF Orientation 摆正图像(镜像方向 2/4/5/7 与旋转合并处理)。
pub fn apply_orientation(img: image::DynamicImage, orientation: u32) -> image::DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

/// 提取 EXIF 拍摄时间的**墙钟**(DateTimeOriginal 优先,其次 DateTime)。
/// EXIF 不带时区:这就是相机表盘上的时间。半天分包等「以拍摄现场为准」的
/// 判定必须直接用它,绝不能先套一个时区再转回来(codex 评审 9:那样
/// 非 UTC 时区会把 10:30 翻成下午)。
pub fn exif_shot_naive(abs_path: &Path) -> Option<NaiveDateTime> {
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
                return Some(naive);
            }
        }
    }
    None
}

/// EXIF 拍摄时间的绝对时刻:墙钟按**本机时区**解释后转 UTC(展示用)。
/// 相机与工作站同时区时准确;跨时区拍摄是 EXIF 自身的边界,如实近似。
pub fn exif_shot_at(abs_path: &Path) -> Option<DateTime<Utc>> {
    let naive = exif_shot_naive(abs_path)?;
    Some(
        naive
            .and_local_timezone(chrono::Local)
            .earliest()
            .map(|t| t.to_utc())
            // 夏令时空档等罕见歧义:退化为按 UTC 解释,总好过丢时间
            .unwrap_or_else(|| DateTime::from_naive_utc_and_offset(naive, Utc)),
    )
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
    let cache = dir.join(thumb_cache_name(rel_path, meta.len(), mtime_nanos(&meta)));
    if cache.is_file() {
        // 缓存命中要验完整性:半截/损坏的缓存(断电、并发写事故)必须自愈,
        // 否则坏图永远占着缓存键(评审 M2)
        if looks_like_valid_jpeg(&cache) {
            return Ok(AssetIndex {
                rel_path: rel_path.to_string(),
                kind,
                shot_at,
                thumb: Some(cache),
            });
        }
        let _ = fs::remove_file(&cache);
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

/// 轻量 JPEG 完整性检查:SOI(FFD8)开头 + EOI(FFD9)结尾。
/// 挡得住半截文件与非 JPEG 垃圾;不做全解码(索引热路径,开销要小)。
pub(crate) fn looks_like_valid_jpeg(path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = fs::File::open(path) else {
        return false;
    };
    let mut head = [0u8; 2];
    let mut tail = [0u8; 2];
    if f.read_exact(&mut head).is_err()
        || f.seek(SeekFrom::End(-2)).is_err()
        || f.read_exact(&mut tail).is_err()
    {
        return false;
    }
    head == [0xFF, 0xD8] && tail == [0xFF, 0xD9]
}

fn write_jpeg(img: &image::DynamicImage, dir: &Path, cache: &Path) -> Option<PathBuf> {
    fs::create_dir_all(dir).ok()?;
    // 临时名带随机后缀:thumbs 在 NAS 上多机共享,固定 tmp 名会互相截断(评审 M2)
    let tmp = dir.join(format!(
        ".{}.{}.thumbpart",
        cache.file_stem().unwrap_or_default().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    {
        let mut out = fs::File::create(&tmp).ok()?;
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, THUMB_QUALITY);
        if img.to_rgb8().write_with_encoder(encoder).is_err() {
            drop(out);
            let _ = fs::remove_file(&tmp);
            return None;
        }
    }
    match super::fsx::rename_no_replace(&tmp, cache) {
        Ok(()) => Some(cache.to_path_buf()),
        // 别机先写完:验一下成品再采信——若既有文件是坏的(复验 11:
        // 删除失败的坏缓存会走到这里),不能原样端给界面
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let _ = fs::remove_file(&tmp);
            looks_like_valid_jpeg(cache).then(|| cache.to_path_buf())
        }
        Err(_) => {
            let _ = fs::remove_file(&tmp);
            None
        }
    }
}

/// 从已解码整图写入共享缩略图缓存(分析流水线的单次解码复用;
/// 已有有效缓存直接跳过)。返回缓存是否就绪。
pub fn store_thumb_from_image(
    project_root: &Path,
    rel_path: &str,
    size: u64,
    mtime: u128,
    img: &image::DynamicImage,
) -> bool {
    let dir = thumbs_dir(project_root);
    let cache = dir.join(thumb_cache_name(rel_path, size, mtime));
    if cache.is_file() && looks_like_valid_jpeg(&cache) {
        return true;
    }
    let thumb = img.thumbnail(THUMB_MAX_EDGE, THUMB_MAX_EDGE);
    write_jpeg(&thumb, &dir, &cache).is_some()
}

/// 素材对应的缩略图缓存路径(存在与否由调用方检查)。
pub fn cached_thumb_path(
    project_root: &Path,
    rel_path: &str,
    size: u64,
    mtime_nanos: u128,
) -> PathBuf {
    thumbs_dir(project_root).join(thumb_cache_name(rel_path, size, mtime_nanos))
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
    fn corrupt_thumb_cache_self_heals() {
        // 评审 M2:半截缓存不能永远占着缓存键
        let tmp = tempdir().unwrap();
        let project = tmp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let photo = tmp.path().join("IMG_0002.jpg");
        write_test_jpeg(&photo, 800, 600);
        let size = fs::metadata(&photo).unwrap().len();

        // 伪造一个损坏的缓存文件(无 JPEG 头尾)
        let mt = mtime_nanos(&fs::metadata(&photo).unwrap());
        let cache = cached_thumb_path(&project, "IMG_0002.jpg", size, mt);
        fs::create_dir_all(cache.parent().unwrap()).unwrap();
        fs::write(&cache, b"truncated-garbage").unwrap();

        let idx = index_asset(&project, &photo, "IMG_0002.jpg").unwrap();
        let thumb = idx.thumb.expect("损坏缓存应被重建");
        assert!(image::open(&thumb).is_ok(), "重建后必须是可解码的 JPEG");
        // 目录里不残留 thumbpart 临时文件
        let leftovers: Vec<_> = fs::read_dir(thumbs_dir(&project))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("thumbpart"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn exif_naive_is_wall_clock_without_timezone_math() {
        // exif_shot_at 是 naive 的本地化包装:两者必须表示同一墙钟
        let tmp = tempdir().unwrap();
        let photo = tmp.path().join("noexif.jpg");
        write_test_jpeg(&photo, 32, 32);
        // 测试图无 EXIF:两个口径都应为 None(回退逻辑在调用方)
        assert!(exif_shot_naive(&photo).is_none());
        assert!(exif_shot_at(&photo).is_none());
    }

    #[test]
    fn cache_key_changes_with_size() {
        assert_ne!(
            thumb_cache_name("a.jpg", 100, 1),
            thumb_cache_name("a.jpg", 101, 1)
        );
        assert_ne!(
            thumb_cache_name("a.jpg", 100, 1),
            thumb_cache_name("b.jpg", 100, 1)
        );
        // mtime 变 → 键变(同名同大小替换要失效)
        assert_ne!(
            thumb_cache_name("a.jpg", 100, 1),
            thumb_cache_name("a.jpg", 100, 2)
        );
    }
}
