//! 全尺寸预览:**按需**把原图解成整幅位图,供全屏预览判虚实/判对焦。
//!
//! 为什么单开一条路:`media.rs` 生成的是 320px 缩略图,全屏里放大看到的
//! 是插值出来的糊块——而选片时在全屏里判的恰恰是「虚不虚、对焦对不对」。
//! 拿放大的缩略图当原图下判断,是把错误决定伪装成正确决定。
//!
//! 三条硬约束(评审口径):
//! - **按需**:只有打开全屏时才解。索引阶段一张都不解(整库全尺寸 = 几十 GB)。
//! - **有上限**:超过 [`MAX_DECODE_PIXELS`] 的单张(扫描件/接片)直接拒绝解码,
//!   并把「为什么停在缩略图」当面说清;超过 [`MAX_EDGE`] 的缩放呈现,同样说清。
//! - **缓存有界**:本机缓存目录按 LRU 淘汰(字节数 + 条目数双上限),
//!   不写 NAS——全尺寸 JPEG 每张几 MB,写共享盘既慢又会把项目撑肿。
//!
//! ## 能力边界(如实声明,零静默)
//!
//! 本机构建的 `image` crate 只编了 `jpeg` + `png`(见 Cargo.toml),于是:
//! - JPEG / PNG:能解全尺寸;
//! - RAW(CR3/ARW/NEF/RAF/DNG…):**解不了**。缩略图来自相机内嵌的 EXIF 小预览,
//!   全尺寸要接 libraw,尚未接入 —— 界面必须当面说,不能停在缩略图装作没事;
//! - HEIC/HEIF:**解不了**(未编入解码器);
//! - 视频:**解不了**(抽帧未接入全屏预览路径)。
//!
//! 这几类的处置一律是「返回一条说明为什么的错误」,由界面原样展示。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 全尺寸解码的像素上限。
///
/// 1.2 亿像素的 RGB8 缓冲约 360MB,已经是单张图能吃的极限;再往上(亿级扫描件、
/// 几十张接片)必须拒绝,否则一次全屏预览就能把工作站打到交换分区。
/// 拒绝时**当面说清**原图多大、上限多大,不静默停在缩略图。
pub const MAX_DECODE_PIXELS: u64 = 120_000_000;

/// 呈现的长边上限。
///
/// 定在 8192:主流机身(含 4500 万像素级的 8192×5464)都在这条线以内,
/// 也就是**绝大多数照片按原始像素呈现**,放大到 1:1 看得到真实锐度。
/// 超过这条线才缩放,并且缩放这件事要写在界面上——「你看到的不是原始像素」
/// 是判虚实时必须知道的前提。
pub const MAX_EDGE: u32 = 8192;

/// 本机预览缓存的字节上限(超出按 LRU 淘汰)。
pub const CACHE_MAX_BYTES: u64 = 512 * 1024 * 1024;
/// 本机预览缓存的条目上限(与字节上限任一触顶即淘汰)。
pub const CACHE_MAX_ENTRIES: usize = 256;

/// 预览 JPEG 的编码质量。比缩略图(78)高得多:这份图是拿来判锐度的,
/// 压缩痕迹会被误读成「糊」。
const PREVIEW_QUALITY: u8 = 92;

/// 本机构建**能**解成全尺寸位图的扩展名。
///
/// 依据是 Cargo.toml 里 `image` crate 的 features(当前只有 `jpeg` + `png`)。
/// 改那一行 features 必须同步改这里,否则界面会承诺一个解不出来的东西。
pub const FULL_DECODE_EXTS: [&str; 3] = ["jpg", "jpeg", "png"];

/// 解不了全尺寸的原因分类。每一类的措辞都不一样——
/// 「RAW 没接 libraw」和「这个文件坏了」指向完全不同的处置,说错比不说更糟。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unsupported {
    /// RAW:缩略图只是相机内嵌的小预览,全尺寸要 libraw
    Raw(String),
    /// 视频:全屏预览没接抽帧
    Video(String),
    /// HEIC/HEIF:解码器未编入本机构建
    Heif(String),
    /// 其余非图像/未知扩展名
    Other(String),
}

impl std::fmt::Display for Unsupported {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Raw(ext) => write!(
                f,
                "RAW(.{ext})尚未接入全尺寸解码(本机构建不含 libraw)。\
                 你看到的是相机内嵌的小预览,判不了虚实——请打开配套 JPEG,或用 RAW 处理软件看原片"
            ),
            Self::Video(ext) => write!(
                f,
                "视频(.{ext})的全屏预览尚未接入抽帧,暂时看不到画面;\
                 请用转码后的代理片或外部播放器查看"
            ),
            Self::Heif(ext) => write!(f, "HEIC/HEIF(.{ext})的解码器未编入本机构建,无法显示原图"),
            Self::Other(ext) => write!(f, "「.{ext}」不是本工具能解码的图像格式,无法显示原图"),
        }
    }
}

/// 全尺寸预览失败的分类。**每一类都必须能独立成句**:界面直接把它显示给用户。
#[derive(Debug)]
pub enum PreviewError {
    /// 原文件已不在原处(索引期间被分类走/删掉)
    SourceGone,
    /// 本机构建解不了这种格式
    Unsupported(Unsupported),
    /// 超过全尺寸解码的像素上限
    TooLarge {
        pixels: u64,
        limit: u64,
        w: u32,
        h: u32,
    },
    /// 格式支持、文件也在,但解码失败(损坏/截断)
    Decode(String),
    /// 缓存读写等 IO 失败
    Io(String),
}

impl std::fmt::Display for PreviewError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SourceGone => write!(
                f,
                "原文件已不在项目里(可能刚被分类、移动或删除),无法解码全尺寸预览"
            ),
            Self::Unsupported(u) => write!(f, "{u}"),
            Self::TooLarge {
                pixels,
                limit,
                w,
                h,
            } => write!(
                f,
                "原图 {w}×{h}(约 {})超过全尺寸解码上限 {}——再解会把内存吃爆,已停在缩略图;\
                 请用外部看图软件查看这张",
                human_pixels(*pixels),
                human_pixels(*limit),
            ),
            Self::Decode(e) => write!(f, "全尺寸解码失败(文件可能损坏或被截断): {e}"),
            Self::Io(e) => write!(f, "全尺寸预览写入本机缓存失败: {e}"),
        }
    }
}

/// 把像素数写成中文习惯的量级。报「128000000 像素」没人读得动,
/// 而这句话正是用户判断「是不是该换个软件打开」的依据。
pub fn human_pixels(n: u64) -> String {
    if n >= 100_000_000 {
        format!("{:.1} 亿像素", n as f64 / 100_000_000.0)
    } else if n >= 10_000 {
        format!("{:.0} 万像素", n as f64 / 10_000.0)
    } else {
        format!("{n} 像素")
    }
}

/// 小写扩展名(无扩展名返回空串)。
fn ext_of(rel: &str) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    match name.rsplit_once('.') {
        Some((_, e)) if !e.is_empty() => e.to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// 这个文件本机**能不能**解全尺寸。纯函数,分类逻辑的唯一真相来源。
pub fn full_decode_support(rel: &str) -> Result<(), Unsupported> {
    let ext = ext_of(rel);
    if FULL_DECODE_EXTS.contains(&ext.as_str()) {
        return Ok(());
    }
    let upper = ext.to_ascii_uppercase();
    Err(match super::media::classify(rel) {
        super::media::AssetKind::Raw => Unsupported::Raw(upper),
        super::media::AssetKind::Video => Unsupported::Video(upper),
        // classify 把 heic 归 Photo(它确实是照片),但本机构建没编 HEIF 解码器
        super::media::AssetKind::Photo => Unsupported::Heif(upper),
        super::media::AssetKind::Other => Unsupported::Other(upper),
    })
}

/// 一次全尺寸解码的结果元信息。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreviewMeta {
    /// 呈现尺寸(可能因超过 [`MAX_EDGE`] 而小于原始尺寸)
    pub width: u32,
    pub height: u32,
    /// 摆正之后的原始尺寸
    pub source_width: u32,
    pub source_height: u32,
    /// 是否因超过长边上限被缩放(true 时界面必须说明「不是原始像素」)
    pub downscaled: bool,
}

/// 读文件头拿摆正后的原始尺寸(不解码整幅)。
pub fn oriented_dimensions(abs: &Path) -> Result<(u32, u32), PreviewError> {
    let (w, h) = image::image_dimensions(abs).map_err(|e| match e {
        image::ImageError::IoError(io) if io.kind() == std::io::ErrorKind::NotFound => {
            PreviewError::SourceGone
        }
        other => PreviewError::Decode(other.to_string()),
    })?;
    // EXIF 5–8 是带 90° 旋转的方向:摆正后宽高互换,报给界面的必须是摆正后的
    Ok(if (5..=8).contains(&super::media::exif_orientation(abs)) {
        (h, w)
    } else {
        (w, h)
    })
}

/// 按需解一张全尺寸预览(不落盘,调用方负责缓存)。
///
/// `max_pixels` / `max_edge` 作参数而不是直读常量:上限本身是这条路径最要紧的
/// 防线,单测必须能在不造一张一亿像素图的前提下把它打红。
pub fn decode_full_preview_with_limits(
    abs: &Path,
    rel: &str,
    max_pixels: u64,
    max_edge: u32,
) -> Result<(image::DynamicImage, PreviewMeta), PreviewError> {
    full_decode_support(rel).map_err(PreviewError::Unsupported)?;
    if !abs.is_file() {
        return Err(PreviewError::SourceGone);
    }
    let (sw, sh) = oriented_dimensions(abs)?;
    let pixels = u64::from(sw) * u64::from(sh);
    if pixels > max_pixels {
        return Err(PreviewError::TooLarge {
            pixels,
            limit: max_pixels,
            w: sw,
            h: sh,
        });
    }

    // 解码器自身也要设闸:文件头里写的尺寸可以撒谎,真正的分配发生在解码器内部。
    // 上面那道闸负责「说人话」,这道负责「即使头撒谎也炸不了内存」。
    // 从 no_limits() 起手而不是 default():default 自带 512MiB 的 max_alloc,
    // 与这里要表达的上限是两个数,叠在一起会让「上限到底是多少」说不清。
    let mut limits = image::Limits::no_limits();
    let edge_cap = max_edge.max(sw).max(sh);
    limits.max_image_width = Some(edge_cap);
    limits.max_image_height = Some(edge_cap);
    // 4 字节/像素 + 一点解码器自身的周转余量
    limits.max_alloc = Some(
        max_pixels
            .saturating_mul(4)
            .saturating_add(64 * 1024 * 1024),
    );

    let mut reader = image::ImageReader::open(abs)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                PreviewError::SourceGone
            } else {
                PreviewError::Io(e.to_string())
            }
        })?
        .with_guessed_format()
        .map_err(|e| PreviewError::Decode(e.to_string()))?;
    reader.limits(limits);
    let img = reader
        .decode()
        .map_err(|e| PreviewError::Decode(e.to_string()))?;
    let img = super::media::apply_orientation(img, super::media::exif_orientation(abs));

    let (w, h) = (img.width(), img.height());
    let downscaled = w.max(h) > max_edge;
    let img = if downscaled {
        // Triangle 而不是 Lanczos3:走到这一步的都是超大图,Lanczos3 在上亿像素上
        // 要跑十几秒;而这一张已经**当面声明过是缩放图**,锐度本就不作数
        img.resize(max_edge, max_edge, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let meta = PreviewMeta {
        width: img.width(),
        height: img.height(),
        source_width: w,
        source_height: h,
        downscaled,
    };
    Ok((img, meta))
}

/// 生产口径的解码(上限取本模块常量)。
pub fn decode_full_preview(
    abs: &Path,
    rel: &str,
) -> Result<(image::DynamicImage, PreviewMeta), PreviewError> {
    decode_full_preview_with_limits(abs, rel, MAX_DECODE_PIXELS, MAX_EDGE)
}

/// 预览缓存文件名。与缩略图同一套不变量:`^[0-9a-f]{16}\.jpg$`。
/// 键含 mtime,原文件被替换即自然失效。`p:` 前缀让它与缩略图键不同名,
/// 免得哪天两个缓存目录合并时撞键。
pub fn preview_cache_name(rel: &str, size: u64, mtime_nanos: u128) -> String {
    let key = format!("p:{rel}\u{0}{size}\u{0}{mtime_nanos}");
    format!("{:016x}.jpg", xxhash_rust::xxh3::xxh3_64(key.as_bytes()))
}

/// 把解好的整幅图编码成预览 JPEG 字节。
pub fn encode_preview(img: &image::DynamicImage) -> Result<Vec<u8>, PreviewError> {
    let mut buf = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, PREVIEW_QUALITY);
    img.to_rgb8()
        .write_with_encoder(encoder)
        .map_err(|e| PreviewError::Decode(e.to_string()))?;
    Ok(buf)
}

/* ------------------------------------------------------------------ *
 * 本机预览缓存(有界 LRU)
 * ------------------------------------------------------------------ */

#[derive(Default)]
struct CacheIndex {
    /// 是否已经把磁盘上的既有缓存文件盘进来(冷启动后第一次访问时做)
    seeded: bool,
    /// 单调递增的「最近使用」计数器
    tick: u64,
    /// 缓存名 → (字节数, 最近使用序号)
    entries: HashMap<String, (u64, u64)>,
    total_bytes: u64,
}

/// 全尺寸预览的本机缓存。
///
/// **淘汰策略:LRU**(最近最少使用者先走),两条上限任一触顶即淘汰——
/// 字节数上限挡住「几张巨图就把盘吃满」,条目数上限挡住「几千张小图把目录撑爆」。
/// 「最近使用」的次序是进程内维护的计数器;冷启动时从磁盘 mtime 盘一次,
/// 于是上一次会话留下的缓存仍然可用,而且是按新旧顺序先淘汰旧的。
///
/// 缓存放**本机**(应用 cache 目录),不放 NAS:一张全尺寸预览几 MB,
/// 写共享盘既慢、又会把项目目录撑肿,而它随时可以按原图重解。
pub struct PreviewCache {
    dir: PathBuf,
    max_bytes: u64,
    max_entries: usize,
    index: Mutex<CacheIndex>,
    /// 解码闸:同一时刻只放一张进解码器。
    ///
    /// 一直按着方向键翻图时,每一张都会发一次解码;不设闸的话十几个 45MP 解码
    /// 会同时在内存里,`MAX_DECODE_PIXELS` 那道单张上限就形同虚设。
    decode_gate: Mutex<()>,
}

impl PreviewCache {
    pub fn new(dir: PathBuf, max_bytes: u64, max_entries: usize) -> Self {
        Self {
            dir,
            max_bytes,
            max_entries,
            index: Mutex::new(CacheIndex::default()),
            decode_gate: Mutex::new(()),
        }
    }

    /// 生产口径(上限取本模块常量)。
    pub fn with_default_budget(dir: PathBuf) -> Self {
        Self::new(dir, CACHE_MAX_BYTES, CACHE_MAX_ENTRIES)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 取解码闸。返回的 guard 一旦落地就自动放行(panic 也放行,不会把闸卡死)。
    pub fn decode_permit(&self) -> std::sync::MutexGuard<'_, ()> {
        self.decode_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, CacheIndex> {
        self.index
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 冷启动后第一次访问:把磁盘上的既有缓存盘进索引。
    /// 不盘的话,上一次会话留下的文件既不计入预算、也永远不会被淘汰(缓存无界)。
    fn seed(index: &mut CacheIndex, dir: &Path) {
        if index.seeded {
            return;
        }
        index.seeded = true;
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut found: Vec<(std::time::SystemTime, String, u64)> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                if !is_cache_name(&name) {
                    return None;
                }
                let meta = e.metadata().ok()?;
                if !meta.is_file() {
                    return None;
                }
                Some((
                    meta.modified().unwrap_or(std::time::UNIX_EPOCH),
                    name,
                    meta.len(),
                ))
            })
            .collect();
        // 旧的排前面 = 先被淘汰。mtime 相同的按名字定序,免得淘汰顺序随机
        found.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        for (_, name, size) in found {
            index.tick += 1;
            let tick = index.tick;
            index.total_bytes += size;
            index.entries.insert(name, (size, tick));
        }
    }

    /// 命中缓存:更新「最近使用」并返回文件路径。
    /// 索引里有、盘上却没了(被外部清理)时按未命中处理并修正账目。
    pub fn hit(&self, name: &str) -> Option<PathBuf> {
        let mut index = self.lock();
        Self::seed(&mut index, &self.dir);
        let (size, _) = *index.entries.get(name)?;
        let path = self.dir.join(name);
        if !path.is_file() || !super::media::looks_like_valid_jpeg(&path) {
            index.entries.remove(name);
            index.total_bytes = index.total_bytes.saturating_sub(size);
            return None;
        }
        index.tick += 1;
        let tick = index.tick;
        index.entries.insert(name.to_string(), (size, tick));
        Some(path)
    }

    /// 把一份新解好的预览写进缓存,并按预算淘汰。返回落盘路径。
    pub fn store(&self, name: &str, bytes: &[u8]) -> Result<PathBuf, PreviewError> {
        std::fs::create_dir_all(&self.dir).map_err(|e| PreviewError::Io(e.to_string()))?;
        let path = self.dir.join(name);
        // 先写临时名再改名:半截文件不会被当成有效缓存端给界面
        let tmp = self
            .dir
            .join(format!(".{name}.{}.part", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, bytes).map_err(|e| PreviewError::Io(e.to_string()))?;
        if let Err(e) = std::fs::rename(&tmp, &path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(PreviewError::Io(e.to_string()));
        }

        let mut index = self.lock();
        Self::seed(&mut index, &self.dir);
        if let Some((old, _)) = index.entries.remove(name) {
            index.total_bytes = index.total_bytes.saturating_sub(old);
        }
        index.tick += 1;
        let tick = index.tick;
        index.total_bytes += bytes.len() as u64;
        index
            .entries
            .insert(name.to_string(), (bytes.len() as u64, tick));
        self.evict_locked(&mut index, name);
        Ok(path)
    }

    /// 淘汰到预算之内。`keep` 是刚刚写进去的那个,任何情况下都不淘汰它——
    /// 否则单张大于整个预算时会出现「刚写完就被自己删掉」的空转。
    fn evict_locked(&self, index: &mut CacheIndex, keep: &str) {
        while index.total_bytes > self.max_bytes || index.entries.len() > self.max_entries {
            let Some((victim, size)) = index
                .entries
                .iter()
                .filter(|(name, _)| name.as_str() != keep)
                .min_by_key(|(name, (_, tick))| (*tick, (*name).clone()))
                .map(|(name, (size, _))| (name.clone(), *size))
            else {
                break; // 只剩 keep 一条了,再淘汰就是把刚写的删掉
            };
            index.entries.remove(&victim);
            index.total_bytes = index.total_bytes.saturating_sub(size);
            let _ = std::fs::remove_file(self.dir.join(&victim));
        }
    }

    /// 当前缓存条目数(测试与诊断用)。
    pub fn len(&self) -> usize {
        let mut index = self.lock();
        Self::seed(&mut index, &self.dir);
        index.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 当前缓存占用字节(测试与诊断用)。
    pub fn bytes(&self) -> u64 {
        let mut index = self.lock();
        Self::seed(&mut index, &self.dir);
        index.total_bytes
    }
}

/// 缓存文件名不变量:`^[0-9a-f]{16}\.jpg$`。
/// 协议闸与目录盘点共用同一个判据——两处写两套判据早晚会漂移。
pub fn is_cache_name(name: &str) -> bool {
    name.len() == 20
        && name.ends_with(".jpg")
        && name[..16]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_jpeg(path: &Path, w: u32, h: u32) {
        let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(w, h, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        }));
        img.save(path).unwrap();
    }

    #[test]
    fn support_classification_names_the_real_reason() {
        assert!(full_decode_support("a/IMG_0001.JPG").is_ok());
        assert!(full_decode_support("a/b.png").is_ok());
        assert_eq!(
            full_decode_support("a/DSC_0001.NEF"),
            Err(Unsupported::Raw("NEF".into()))
        );
        assert_eq!(
            full_decode_support("a/x.cr3"),
            Err(Unsupported::Raw("CR3".into()))
        );
        assert_eq!(
            full_decode_support("a/CLIP.MP4"),
            Err(Unsupported::Video("MP4".into()))
        );
        assert_eq!(
            full_decode_support("a/x.heic"),
            Err(Unsupported::Heif("HEIC".into()))
        );
        assert_eq!(
            full_decode_support("a/readme.txt"),
            Err(Unsupported::Other("TXT".into()))
        );
    }

    /// 三类失败的措辞必须互不相同、且各自点名原因——
    /// 「加载失败」一句话打发是这条 bug 的另一种形态。
    #[test]
    fn every_failure_class_says_something_different() {
        let raw = PreviewError::Unsupported(Unsupported::Raw("NEF".into())).to_string();
        let video = PreviewError::Unsupported(Unsupported::Video("MP4".into())).to_string();
        let too_big = PreviewError::TooLarge {
            pixels: 140_000_000,
            limit: MAX_DECODE_PIXELS,
            w: 14_000,
            h: 10_000,
        }
        .to_string();
        let broken = PreviewError::Decode("truncated".into()).to_string();
        let gone = PreviewError::SourceGone.to_string();

        assert!(raw.contains("libraw"), "RAW 要点名缺的是什么: {raw}");
        assert!(video.contains("抽帧"), "视频要点名缺的是什么: {video}");
        assert!(
            too_big.contains("1.4 亿像素") && too_big.contains("1.2 亿像素"),
            "超限要同时报出原图多大、上限多大: {too_big}"
        );
        assert!(broken.contains("损坏"), "{broken}");
        assert!(gone.contains("不在项目里"), "{gone}");

        let all = [&raw, &video, &too_big, &broken, &gone];
        for (i, a) in all.iter().enumerate() {
            for b in all.iter().skip(i + 1) {
                assert_ne!(a, b, "两类失败说了同一句话,等于没分类");
            }
        }
    }

    #[test]
    fn human_pixels_reads_like_chinese() {
        assert_eq!(human_pixels(120_000_000), "1.2 亿像素");
        assert_eq!(human_pixels(45_000_000), "4500 万像素");
        assert_eq!(human_pixels(900), "900 像素");
    }

    #[test]
    fn decodes_photo_at_native_resolution() {
        let tmp = tempdir().unwrap();
        let p = tmp.path().join("IMG_0001.jpg");
        write_jpeg(&p, 1600, 900);
        let (img, meta) = decode_full_preview(&p, "IMG_0001.jpg").unwrap();
        assert_eq!((img.width(), img.height()), (1600, 900));
        assert_eq!(
            meta,
            PreviewMeta {
                width: 1600,
                height: 900,
                source_width: 1600,
                source_height: 900,
                downscaled: false,
            },
            "没超上限就必须是原始像素——这条一松,修的这个 bug 就白修了"
        );
    }

    #[test]
    fn oversized_is_downscaled_and_says_so() {
        let tmp = tempdir().unwrap();
        let p = tmp.path().join("pano.jpg");
        // 长边超过 MAX_EDGE,总像素很小:单独打「长边缩放」这条路径
        write_jpeg(&p, MAX_EDGE + 808, 40);
        let (img, meta) = decode_full_preview(&p, "pano.jpg").unwrap();
        assert!(meta.downscaled, "超过长边上限必须标记为缩放");
        assert_eq!(img.width(), MAX_EDGE);
        assert_eq!(meta.source_width, MAX_EDGE + 808);
        assert!(meta.width < meta.source_width);
    }

    #[test]
    fn pixel_ceiling_refuses_before_allocating() {
        let tmp = tempdir().unwrap();
        let p = tmp.path().join("big.jpg");
        write_jpeg(&p, 400, 300);
        // 上限压到 1000 像素:400×300 必须被挡下,且报文点名两个数字
        let err = decode_full_preview_with_limits(&p, "big.jpg", 1_000, MAX_EDGE).unwrap_err();
        match err {
            PreviewError::TooLarge {
                pixels,
                limit,
                w,
                h,
            } => {
                assert_eq!((pixels, limit, w, h), (120_000, 1_000, 400, 300));
            }
            other => panic!("超限必须走 TooLarge,实际 {other:?}"),
        }
    }

    #[test]
    fn corrupt_file_is_decode_error_not_unsupported() {
        let tmp = tempdir().unwrap();
        let p = tmp.path().join("broken.jpg");
        std::fs::write(&p, b"not a jpeg at all, but long enough to have a header").unwrap();
        assert!(matches!(
            decode_full_preview(&p, "broken.jpg"),
            Err(PreviewError::Decode(_))
        ));
    }

    #[test]
    fn missing_file_is_source_gone() {
        let tmp = tempdir().unwrap();
        let p = tmp.path().join("nope.jpg");
        assert!(matches!(
            decode_full_preview(&p, "nope.jpg"),
            Err(PreviewError::SourceGone)
        ));
    }

    #[test]
    fn unsupported_never_touches_the_disk() {
        // RAW/视频的判定必须在碰文件之前:文件不存在也要报「格式不支持」,
        // 不能报成「文件没了」——那会把用户引到完全错的排查方向
        let tmp = tempdir().unwrap();
        let p = tmp.path().join("DSC_0001.NEF");
        assert!(matches!(
            decode_full_preview(&p, "DSC_0001.NEF"),
            Err(PreviewError::Unsupported(Unsupported::Raw(_)))
        ));
    }

    #[test]
    fn cache_name_matches_thumb_style_whitelist() {
        let n = preview_cache_name("1. 待分类/a.jpg", 100, 7);
        assert!(is_cache_name(&n), "{n}");
        // 键含 size 与 mtime:原文件被替换即失效
        assert_ne!(n, preview_cache_name("1. 待分类/a.jpg", 101, 7));
        assert_ne!(n, preview_cache_name("1. 待分类/a.jpg", 100, 8));
        // 与缩略图键不同名(前缀区分),两个缓存目录合并也不会撞
        assert!(!is_cache_name("0123456789ABCDEF.jpg"));
        assert!(!is_cache_name("0123456789abcde.jpg"));
        assert!(!is_cache_name("0123456789abcdef.png"));
    }

    /// 一份**真的能通过完整性校验**的预览 JPEG(不能用补零撑长度:
    /// 尾部补零会破坏 EOI 标记,`hit` 会把它当半截缓存拒掉,用例就假绿了)。
    fn body(w: u32, h: u32) -> Vec<u8> {
        let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(w, h, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 200])
        }));
        encode_preview(&img).unwrap()
    }

    #[test]
    fn cache_evicts_least_recently_used_by_entry_count() {
        let tmp = tempdir().unwrap();
        let cache = PreviewCache::new(tmp.path().to_path_buf(), u64::MAX, 2);
        let body = body(8, 8);
        let a = "000000000000000a.jpg";
        let b = "000000000000000b.jpg";
        let c = "000000000000000c.jpg";
        cache.store(a, &body).unwrap();
        cache.store(b, &body).unwrap();
        // 摸一下 a:它变成最近使用,该被淘汰的是 b
        assert!(cache.hit(a).is_some());
        cache.store(c, &body).unwrap();

        assert_eq!(cache.len(), 2);
        assert!(tmp.path().join(a).is_file(), "刚摸过的 a 不该被淘汰");
        assert!(!tmp.path().join(b).exists(), "最久未用的 b 必须被删掉");
        assert!(tmp.path().join(c).is_file());
    }

    #[test]
    fn cache_evicts_by_byte_budget_and_keeps_the_newcomer() {
        let tmp = tempdir().unwrap();
        let body = body(64, 64);
        // 预算只装得下一条
        let cache = PreviewCache::new(tmp.path().to_path_buf(), body.len() as u64, 999);
        let a = "000000000000000a.jpg";
        let b = "000000000000000b.jpg";
        cache.store(a, &body).unwrap();
        cache.store(b, &body).unwrap();
        assert_eq!(cache.len(), 1);
        assert!(!tmp.path().join(a).exists());
        assert!(tmp.path().join(b).is_file(), "刚写进去的绝不能被自己淘汰");
        assert!(cache.bytes() <= body.len() as u64);
    }

    #[test]
    fn cache_seeds_from_disk_so_last_session_counts_against_the_budget() {
        let tmp = tempdir().unwrap();
        let body = body(8, 8);
        // 上一次会话留下的两份缓存(直接写盘,不经索引)
        std::fs::write(tmp.path().join("000000000000000a.jpg"), &body).unwrap();
        std::fs::write(tmp.path().join("000000000000000b.jpg"), &body).unwrap();
        // 不认识的文件不算(不是缓存名不变量)
        std::fs::write(tmp.path().join("garbage.txt"), b"x").unwrap();

        let cache = PreviewCache::new(tmp.path().to_path_buf(), u64::MAX, 2);
        assert_eq!(cache.len(), 2, "冷启动必须盘点既有缓存,否则缓存无界");
        cache.store("000000000000000c.jpg", &body).unwrap();
        assert_eq!(cache.len(), 2);
        assert!(tmp.path().join("garbage.txt").is_file(), "不认识的文件不碰");
    }

    #[test]
    fn cache_hit_repairs_accounting_when_file_vanished() {
        let tmp = tempdir().unwrap();
        let body = body(8, 8);
        let cache = PreviewCache::new(tmp.path().to_path_buf(), u64::MAX, 999);
        let a = "000000000000000a.jpg";
        cache.store(a, &body).unwrap();
        std::fs::remove_file(tmp.path().join(a)).unwrap();
        assert!(cache.hit(a).is_none(), "盘上没了就必须按未命中处理");
        assert_eq!(cache.len(), 0);
        assert_eq!(cache.bytes(), 0, "账目要跟着修正,否则预算越算越少");
    }

    #[test]
    fn cache_hit_rejects_truncated_file() {
        let tmp = tempdir().unwrap();
        let body = body(8, 8);
        let cache = PreviewCache::new(tmp.path().to_path_buf(), u64::MAX, 999);
        let a = "000000000000000a.jpg";
        cache.store(a, &body).unwrap();
        std::fs::write(tmp.path().join(a), b"half").unwrap();
        assert!(cache.hit(a).is_none(), "半截缓存宁可重解也不端给界面");
    }

    #[test]
    fn store_leaves_no_part_files_behind() {
        let tmp = tempdir().unwrap();
        let body = body(8, 8);
        let cache = PreviewCache::new(tmp.path().to_path_buf(), u64::MAX, 999);
        cache.store("000000000000000a.jpg", &body).unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".part"))
            .collect();
        assert!(leftovers.is_empty());
    }
}
