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
//! 解码按**扩展名分派到不同解码器**(见 [`decoder_for`]),当前四条支路:
//! - JPEG / PNG:`image` crate 直解(Cargo.toml 里只编了这两个 feature);
//! - 视频(MP4/MOV/AVI/MTS/M4V):走捆绑的 ffmpeg sidecar **抽一帧**
//!   (见 [`crate::core::preview_ffmpeg`])。抽出来的是一帧静止画面,
//!   **不是整段视频**,界面必须说清这一点;
//! - HEIC/HEIF:同一条 sidecar 路径解静态图。能不能解**不做编译期假设**,
//!   靠真的解一次来回答(三平台的 ffmpeg 裁剪程度不同,`.heic` 里装的也可能
//!   是 HEVC 或 AV1,写死哪一边都会骗人);
//! - RAW(CR3/ARW/NEF/RAF/DNG…):走 [`crate::core::preview_raw`] 取**相机
//!   内嵌的那张 JPEG**(按各家格式规范里的指针标签取,不是扫字节流)。
//!   取到的是机内渲染的成片,**不是解出来的 RAW**;而且它**不一定是全尺寸**
//!   ——半幅/缩略级的内嵌预览判不了 1:1 的虚实。这两件事都必须一路传到界面,
//!   见 [`PreviewSource::RawEmbedded`]。
//!
//! 解不了的一律是「返回一条说明为什么的错误」,由界面原样展示。

use super::preview_ffmpeg::{self, StillKind};
use super::preview_raw::{self, PreviewAdequacy, RawError};
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

/// `image` crate 能直解成全尺寸位图的扩展名。
///
/// 依据是 Cargo.toml 里 `image` crate 的 features(当前只有 `jpeg` + `png`)。
/// 改那一行 features 必须同步改这里,否则界面会承诺一个解不出来的东西。
/// 注意这**不再**是「能不能全屏预览」的全部答案:视频与 HEIC 走的是
/// sidecar 那两条支路,见 [`decoder_for`]。
pub const FULL_DECODE_EXTS: [&str; 3] = ["jpg", "jpeg", "png"];

/// HEIC/HEIF 的扩展名(`media::classify` 把它们归 Photo,这里要单拎出来
/// 分派到 sidecar——`image` crate 解不了它们)。
pub const HEIF_EXTS: [&str; 2] = ["heic", "heif"];

/// 这个文件该交给**哪一个**解码器。
///
/// 分派是这条路径上唯一的真相来源:命令层、错误分类、界面文案全部从它出发。
/// 做成显式的枚举而不是一串 `if` 的理由,是这几条支路各自都会长大
/// (RAW 那条还没挂上),分派本身必须是个能一眼看全、能被单测枚举的东西。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreviewDecoder {
    /// `image` crate 直解整幅(JPEG/PNG)
    Native,
    /// ffmpeg sidecar 抽一帧(视频)
    VideoFrame,
    /// ffmpeg sidecar 解静态图(HEIC/HEIF)
    HeifStill,
    /// RAW:取相机内嵌的那张 JPEG(见 [`decode_raw_embedded`])。
    ///
    /// 带的是大写扩展名,只用于诊断与分派单测——真正判「这个容器认不认得」
    /// 的是 `preview_raw` 自己(它在开文件之前就能答 `NotRaw` /
    /// `UnsupportedFormat`),所以这里不再复制一份格式清单。
    RawEmbedded(String),
    /// 谁都解不了
    Unsupported(Unsupported),
}

/// 解不了全尺寸的原因分类。每一类的措辞都不一样——
/// 「这个格式没人认领」和「这个文件坏了」指向完全不同的处置,说错比不说更糟。
///
/// RAW 曾经也在这里(`Raw(ext)` = 尚未接入全尺寸解码)。现在 RAW 有人认领了,
/// 那个变体被**删掉**而不是留着:留一条写着「尚未接入」的话在代码里,
/// 早晚会有一条路把它端到用户脸上,而它已经不是真的了。
/// RAW 自己那五类具体原因由 [`RawError`] 负责,见 [`PreviewError::Raw`]。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unsupported {
    /// 非图像/未知扩展名
    Other(String),
}

impl std::fmt::Display for Unsupported {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
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
    /// 走 ffmpeg sidecar 的那两条支路(视频抽帧 / HEIC)自己的失败分类。
    /// 五类(sidecar 缺失 / 损坏 / 无视频轨 / 缺解码器 / 超时)各说各的话,
    /// 原样透传——在这里再包一层「预览失败:」只会把真正的原因推远。
    Still(preview_ffmpeg::StillError),
    /// RAW 内嵌预览那一支自己的失败分类,同样**原样透传**。
    ///
    /// 它的五类分得很细(不是 RAW / 这个容器没做 / 文件里就是没有内嵌预览 /
    /// 找到了但损坏 / 读文件失败),每一类指向的处置都不同;在这里裹一层
    /// 「RAW 预览失败」等于把 `preview_raw` 那轮分类的价值全部抹掉。
    /// 唯一不原样透传的是「原文件没了」——那条走 [`Self::SourceGone`],
    /// 与其它支路同口径(而且 `RawError` 的那句话里带着绝对路径)。
    Raw(RawError),
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
            Self::Still(e) => write!(f, "{e}"),
            Self::Raw(e) => write!(f, "{e}"),
        }
    }
}

impl PreviewError {
    /// 把 `preview_raw` 的错误接进本模块的分类。
    ///
    /// 「原文件已不在原处」并到 [`Self::SourceGone`]:它和 JPEG/视频那几支
    /// 遇到的是同一件事,应该给同一句话;其余四类原样透传。
    fn from_raw(e: RawError) -> Self {
        if e.is_source_gone() {
            Self::SourceGone
        } else {
            Self::Raw(e)
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

/// 按扩展名分派到解码器。纯函数,**分派逻辑的唯一真相来源**。
pub fn decoder_for(rel: &str) -> PreviewDecoder {
    let ext = ext_of(rel);
    if FULL_DECODE_EXTS.contains(&ext.as_str()) {
        return PreviewDecoder::Native;
    }
    if HEIF_EXTS.contains(&ext.as_str()) {
        return PreviewDecoder::HeifStill;
    }
    let upper = ext.to_ascii_uppercase();
    match super::media::classify(rel) {
        super::media::AssetKind::Video => PreviewDecoder::VideoFrame,
        super::media::AssetKind::Raw => PreviewDecoder::RawEmbedded(upper),
        // classify 把 heic 归 Photo,已在上面单独接走;剩下的 Photo 扩展名
        // 理应都在 FULL_DECODE_EXTS 里——真掉到这儿说明两张表漂移了
        super::media::AssetKind::Photo | super::media::AssetKind::Other => {
            PreviewDecoder::Unsupported(Unsupported::Other(upper))
        }
    }
}

/// 这个文件**有没有**解码器认领(不代表一定能解成功——视频/HEIC/RAW 能不能解
/// 只有真解一次才知道)。
///
/// 存在的理由是命令层要在**碰盘之前**先答一句:未知扩展名即使文件不在也该报
/// 「格式不支持」,报成「文件没了」会把人引到完全错的排查方向。
/// RAW 现在有人认领了——它自己那几类「不认识的容器」由 `preview_raw` 在
/// 开文件之前答(见 [`decode_raw_embedded`]),不需要在这里复制一份清单。
pub fn full_decode_support(rel: &str) -> Result<(), Unsupported> {
    match decoder_for(rel) {
        PreviewDecoder::Native
        | PreviewDecoder::VideoFrame
        | PreviewDecoder::HeifStill
        | PreviewDecoder::RawEmbedded(_) => Ok(()),
        PreviewDecoder::Unsupported(u) => Err(u),
    }
}

/// 这张预览图**到底是什么**。
///
/// 界面唯一该闭嘴的情形是「全尺寸到位、且是原始像素」。视频抽出来的一帧
/// 永远不满足这个条件——它是整段素材里的一个瞬间,静止画面上判不了运动、
/// 也判不了这条到底拍了什么。所以它必须带着「第几秒」一路传到界面上,
/// 而不是变成一张来路不明的静图。
///
/// **不是 `Copy`**:RAW 那一支要带一句已经写好的用户文案(`String`)。
/// 让它跟着 source 走而不是在命令层/前端各拼一遍,是为了保证界面上那句话
/// 与后端判定的 `adequacy` 永远同源——两处各写一套措辞,早晚会漂移成
/// 「界面说够用、后端算的是半幅」。
#[derive(Debug, Clone, PartialEq)]
pub enum PreviewSource {
    /// 就是这张图本身的像素(JPEG/PNG/HEIC)
    Original,
    /// 视频里的一帧
    VideoFrame {
        /// 抽的是第几秒。`None` = 时长读不出、退回了开头,说不准具体秒数——
        /// **说不准就别说**,好过让界面举着一个可能是错的数字
        at_sec: Option<f64>,
        /// 整段多长(读不出为 None)
        duration_sec: Option<f64>,
    },
    /// RAW 里相机自己渲染进去的那张 JPEG。
    ///
    /// 与 [`Self::VideoFrame`] 同型:两者都是「你看到的不是原图」,
    /// 所以都得带着足够说清这件事的数字一路走到界面上。RAW 这一支还多一层
    /// ——它**不一定够用**:内嵌预览可能只有半幅甚至缩略级,
    /// 那种尺寸下判 1:1 的虚实是自欺。[`PreviewAdequacy`] 就是这件事的答案,
    /// 界面必须按它分四档处置,不许把 `Unknown` 当 `FullSize`。
    RawEmbedded {
        /// 够不够判虚实(四档)
        adequacy: PreviewAdequacy,
        /// 内嵌预览的实测像素(**未摆正**,与 `warning` 里的数字同口径)
        embedded: (u32, u32),
        /// RAW 的原始感光尺寸;读不到为 `None`(那就是 `Unknown` 档)
        full: Option<(u32, u32)>,
        /// 内嵌预览长边占原图长边的比例(读不到原始尺寸为 `None`)
        fraction: Option<f32>,
        /// 从哪个标签/结构取出来的。**诊断与统计用,不进 UI 主文案**
        /// (接线契约第 3 条)——给用户的话在 `warning` 里
        tag: &'static str,
        /// `preview_raw::EmbeddedPreview::warning()` 的原话。
        /// `None` 只在 `FullSize` 档出现,**不代表没话说**:
        /// 「这是机内渲染的 JPEG,不是解出来的 RAW」那句由界面补
        warning: Option<String>,
    },
}

/// 一次全尺寸解码的结果元信息。
#[derive(Debug, Clone, PartialEq)]
pub struct PreviewMeta {
    /// 呈现尺寸(可能因超过 [`MAX_EDGE`] 而小于原始尺寸)
    pub width: u32,
    pub height: u32,
    /// 摆正之后的原始尺寸
    pub source_width: u32,
    pub source_height: u32,
    /// 是否因超过长边上限被缩放(true 时界面必须说明「不是原始像素」)
    pub downscaled: bool,
    /// 这张图的来路(界面据此决定还要不要多说一句)
    pub source: PreviewSource,
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
    // 分派在碰盘之前:未知格式即使文件不在也该报「格式不支持」,
    // 报成「文件没了」会把人引到完全错的排查方向
    let decoder = decoder_for(rel);
    if let PreviewDecoder::Unsupported(u) = decoder {
        return Err(PreviewError::Unsupported(u));
    }
    if !abs.is_file() {
        return Err(PreviewError::SourceGone);
    }
    match decoder {
        PreviewDecoder::Native => decode_native(abs, max_pixels, max_edge),
        PreviewDecoder::VideoFrame => {
            decode_via_sidecar(abs, StillKind::VideoFrame, max_pixels, max_edge)
        }
        PreviewDecoder::HeifStill => {
            decode_via_sidecar(abs, StillKind::HeifStill, max_pixels, max_edge)
        }
        PreviewDecoder::RawEmbedded(_) => decode_raw_embedded(abs, max_pixels, max_edge),
        // 上面已经提前返回
        PreviewDecoder::Unsupported(_) => unreachable!(),
    }
}

/// 给整幅位图套上「长边上限」并生成元信息。四条支路共用的收尾,
/// 所以「超过长边就缩放、并且**标记**缩放过」这条不会有哪条路漏掉。
fn finish(
    img: image::DynamicImage,
    max_edge: u32,
    source: PreviewSource,
) -> (image::DynamicImage, PreviewMeta) {
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
        source,
    };
    (img, meta)
}

/// 解码器自身的闸:文件头里写的尺寸可以撒谎,真正的分配发生在解码器内部。
/// 像素上限那道闸负责「说人话」,这道负责「即使头撒谎也炸不了内存」。
/// 从 `no_limits()` 起手而不是 `default()`:default 自带 512MiB 的 max_alloc,
/// 与这里要表达的上限是两个数,叠在一起会让「上限到底是多少」说不清。
fn decoder_limits(max_pixels: u64, edge_cap: u32) -> image::Limits {
    let mut limits = image::Limits::no_limits();
    limits.max_image_width = Some(edge_cap);
    limits.max_image_height = Some(edge_cap);
    // 4 字节/像素 + 一点解码器自身的周转余量
    limits.max_alloc = Some(
        max_pixels
            .saturating_mul(4)
            .saturating_add(64 * 1024 * 1024),
    );
    limits
}

/// JPEG / PNG:`image` crate 直解原文件。
fn decode_native(
    abs: &Path,
    max_pixels: u64,
    max_edge: u32,
) -> Result<(image::DynamicImage, PreviewMeta), PreviewError> {
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
    reader.limits(decoder_limits(max_pixels, max_edge.max(sw).max(sh)));
    let img = reader
        .decode()
        .map_err(|e| PreviewError::Decode(e.to_string()))?;
    let img = super::media::apply_orientation(img, super::media::exif_orientation(abs));
    Ok(finish(img, max_edge, PreviewSource::Original))
}

/// 视频 / HEIC:交给 ffmpeg sidecar 取一张静止画面。
///
/// 顺序是刻意的:**先 probe 再解**。probe 那一次进程调用买到三样东西——
/// 时长(决定抽第几秒、以及别让 `-ss` 越界)、编码名(缺解码器时点得出名)、
/// 以及整图尺寸(拿去过像素上限那道闸,和 JPEG 走的是同一道)。
fn decode_via_sidecar(
    abs: &Path,
    kind: StillKind,
    max_pixels: u64,
    max_edge: u32,
) -> Result<(image::DynamicImage, PreviewMeta), PreviewError> {
    let probed = preview_ffmpeg::probe(abs, kind).map_err(PreviewError::Still)?;

    // 像素上限对 sidecar 这两条支路一样生效:一张 1.5 亿像素的 HEIC 拼贴图
    // 和一张同样大的 JPEG 一样会把内存吃爆,没有理由只挡后者
    let pixels = u64::from(probed.width) * u64::from(probed.height);
    if pixels > max_pixels {
        return Err(PreviewError::TooLarge {
            pixels,
            limit: max_pixels,
            w: probed.width,
            h: probed.height,
        });
    }
    preview_ffmpeg::ensure_decodable(&probed, kind).map_err(PreviewError::Still)?;

    let still = preview_ffmpeg::extract(abs, kind, &probed).map_err(PreviewError::Still)?;
    let mut reader = image::ImageReader::new(std::io::Cursor::new(&still.png))
        .with_guessed_format()
        .map_err(|e| PreviewError::Decode(e.to_string()))?;
    // 尺寸已经过闸,但 PNG 是另一个进程吐出来的,仍然按同一套上限收着解
    reader.limits(decoder_limits(
        max_pixels,
        max_edge.max(probed.width).max(probed.height),
    ));
    let img = reader.decode().map_err(|e| {
        PreviewError::Still(preview_ffmpeg::StillError::Output {
            noun: if kind == StillKind::VideoFrame {
                "视频"
            } else {
                "HEIC/HEIF 图片"
            },
            detail: e.to_string(),
        })
    })?;
    // **不**在这里套 EXIF Orientation:ffmpeg 默认就按 display matrix 摆正了
    // (实测 640×360 带 rotation:90 的素材抽出来是 360×640),
    // 再摆一次等于把竖拍的转倒
    let source = match kind {
        // HEIC 解出来的就是这张照片本身的像素,和 JPEG 同级,没有额外的话要说
        StillKind::HeifStill => PreviewSource::Original,
        StillKind::VideoFrame => PreviewSource::VideoFrame {
            at_sec: still.at_sec,
            duration_sec: still.duration_sec,
        },
    };
    Ok(finish(img, max_edge, source))
}

/// RAW:取相机内嵌的那张 JPEG,当整幅解。
///
/// 收尾与其它三支**完全同路**——同一个 [`decoder_limits`](即使 `preview_raw`
/// 已经校验过这张 JPEG 解得出宽高,分配上限仍然由这里说了算)、同一个
/// [`finish`](长边缩放与 `downscaled` 标记),再往上同一个解码闸和同一个
/// [`PreviewCache`](都在命令层)。任何一条支路自己另起一套收尾,
/// 迟早会漏掉「缩放过」这类标记,而漏掉标记就是静默降级。
///
/// 与其它支路唯一不同的是它**成功了也可能不够用**:内嵌预览的尺寸由机身决定,
/// 半幅甚至缩略级都常见。那件事不在这里判、也不在这里瞒,而是原样打包进
/// [`PreviewSource::RawEmbedded`] 交给界面(接线契约第 1、5 条)。
fn decode_raw_embedded(
    abs: &Path,
    max_pixels: u64,
    max_edge: u32,
) -> Result<(image::DynamicImage, PreviewMeta), PreviewError> {
    let embedded = preview_raw::extract_embedded_preview(abs).map_err(PreviewError::from_raw)?;

    // 像素上限对这一支一样生效。中画幅机身的机内全尺寸 JPEG 能到 1.5 亿像素,
    // 解它和解一张同样大的 JPEG 一样会把内存吃爆,没有理由只挡后者
    let pixels = u64::from(embedded.width) * u64::from(embedded.height);
    if pixels > max_pixels {
        return Err(PreviewError::TooLarge {
            pixels,
            limit: max_pixels,
            w: embedded.width,
            h: embedded.height,
        });
    }

    let source = raw_source_of(&embedded);

    let mut reader = image::ImageReader::new(std::io::Cursor::new(&embedded.jpeg))
        .with_guessed_format()
        .map_err(|e| PreviewError::Decode(e.to_string()))?;
    reader.limits(decoder_limits(
        max_pixels,
        max_edge.max(embedded.width).max(embedded.height),
    ));
    let img = reader.decode().map_err(|e| {
        // 点名「坏的是内嵌预览、取自哪个标签」:`preview_raw` 已经验过这张
        // JPEG 能解出宽高,走到这一步说明是渐进式/CMYK 之类的解码器边界,
        // 说成笼统的「文件损坏」会让人去重拷一张其实没坏的卡
        PreviewError::Decode(format!("RAW 内嵌预览({})解不开: {e}", embedded.source))
    })?;

    // 方向按接线契约第 2 条:与索引路径同一个 `apply_orientation` 口径。
    // `preview_raw` 已经处理过「相机把预览摆正过」的情形(那时它返回 1),
    // 所以这里无脑施加即可——**再判一次等于把竖拍的转倒**
    let img = super::media::apply_orientation(img, u32::from(embedded.orientation));
    Ok(finish(img, max_edge, source))
}

/// 把一份内嵌预览的「够不够用」摊成 [`PreviewSource`]。
/// 解码路径与缓存命中路径共用它,两处各拼一遍早晚会漂移。
fn raw_source_of(e: &preview_raw::EmbeddedPreview) -> PreviewSource {
    PreviewSource::RawEmbedded {
        adequacy: e.adequacy(),
        embedded: (e.width, e.height),
        full: e.full_size,
        fraction: e.fraction_of_full,
        tag: e.source,
        warning: e.warning(),
    }
}

/// 只问「这张 RAW 的内嵌预览是什么、摆正后多大」,**不解整幅、不重新编码**。
///
/// 命中本机缓存那条路要用:落盘的 JPEG 已经在手上,缺的只是「它够不够用」。
/// 重跑一次标签解析(几十 KB 元数据 + 那段 JPEG 字节)远比整条解码路便宜,
/// 而且答案与解码那条路**同源**——旁存一份 adequacy 表看着更省,
/// 但表一旦与磁盘不同步就会说出「全尺寸」而端上半幅。
pub fn raw_embedded_source(abs: &Path) -> Result<(PreviewSource, (u32, u32)), PreviewError> {
    let e = preview_raw::extract_embedded_preview(abs).map_err(PreviewError::from_raw)?;
    // 摆正后宽高互换的只有 5..=8 这几档,与 `oriented_dimensions` 同判据
    let oriented = if (5..=8).contains(&e.orientation) {
        (e.height, e.width)
    } else {
        (e.width, e.height)
    };
    Ok((raw_source_of(&e), oriented))
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

    /// 分派表是这条路径的骨架:每一种扩展名到底交给谁,必须逐条钉住。
    #[test]
    fn dispatch_routes_each_extension_to_its_decoder() {
        assert_eq!(decoder_for("a/IMG_0001.JPG"), PreviewDecoder::Native);
        assert_eq!(decoder_for("a/b.png"), PreviewDecoder::Native);
        // 视频与 HEIC 都走 sidecar(此前两者都是「解不了」)
        assert_eq!(decoder_for("a/CLIP.MP4"), PreviewDecoder::VideoFrame);
        assert_eq!(decoder_for("a/C0001.mov"), PreviewDecoder::VideoFrame);
        assert_eq!(decoder_for("a/AVCHD.MTS"), PreviewDecoder::VideoFrame);
        assert_eq!(decoder_for("a/x.heic"), PreviewDecoder::HeifStill);
        assert_eq!(decoder_for("a/x.HEIF"), PreviewDecoder::HeifStill);
        // RAW 走内嵌预览提取
        assert_eq!(
            decoder_for("a/DSC_0001.NEF"),
            PreviewDecoder::RawEmbedded("NEF".into())
        );
        assert_eq!(
            decoder_for("a/x.cr3"),
            PreviewDecoder::RawEmbedded("CR3".into())
        );
        assert_eq!(
            decoder_for("a/readme.txt"),
            PreviewDecoder::Unsupported(Unsupported::Other("TXT".into()))
        );
    }

    /// 有解码器认领 ≠ 一定解得出来,但**没人认领**必须在碰盘前就说清。
    #[test]
    fn support_gate_only_rejects_the_unclaimed() {
        assert!(full_decode_support("a/IMG_0001.JPG").is_ok());
        assert!(
            full_decode_support("a/CLIP.MP4").is_ok(),
            "视频现在有人认领"
        );
        assert!(full_decode_support("a/x.heic").is_ok(), "HEIC 现在有人认领");
        assert!(
            full_decode_support("a/DSC_0001.NEF").is_ok(),
            "RAW 现在有人认领(内嵌预览);认不认得那个容器由 preview_raw 真取一次来答"
        );
        assert_eq!(
            full_decode_support("a/readme.txt"),
            Err(Unsupported::Other("TXT".into()))
        );
    }

    /// 各类失败的措辞必须互不相同、且各自点名原因——
    /// 「加载失败」一句话打发是这条 bug 的另一种形态。
    #[test]
    fn every_failure_class_says_something_different() {
        // RAW 那五类**原样透传**:在这里裹一层「RAW 预览失败」就等于把
        // preview_raw 分好的类又抹平回一句笼统的话
        let raw = PreviewError::Raw(preview_raw::RawError::NoPreview {
            ext: "nef".into(),
            examined: 3,
        })
        .to_string();
        let raw_container = PreviewError::Raw(preview_raw::RawError::UnsupportedFormat {
            ext: "crw".into(),
            reason: "CRW 用的是 Canon CIFF 容器".into(),
        })
        .to_string();
        let raw_corrupt = PreviewError::Raw(preview_raw::RawError::Corrupt {
            ext: "arw".into(),
            detail: "EOI 找不到".into(),
        })
        .to_string();
        let other = PreviewError::Unsupported(Unsupported::Other("TXT".into())).to_string();
        let too_big = PreviewError::TooLarge {
            pixels: 140_000_000,
            limit: MAX_DECODE_PIXELS,
            w: 14_000,
            h: 10_000,
        }
        .to_string();
        let broken = PreviewError::Decode("truncated".into()).to_string();
        let gone = PreviewError::SourceGone.to_string();
        // sidecar 那五类原样透传,不许在外面再裹一层把原因推远
        let no_ffmpeg = PreviewError::Still(preview_ffmpeg::StillError::SidecarMissing(
            "缺 ffmpeg".into(),
        ))
        .to_string();
        let codec = PreviewError::Still(preview_ffmpeg::StillError::UnsupportedCodec {
            noun: "视频",
            codec: "vvc".into(),
        })
        .to_string();
        let slow = PreviewError::Still(preview_ffmpeg::StillError::Timeout {
            stage: "取画面",
            secs: 30,
        })
        .to_string();

        assert!(
            raw.contains("没有可用的内嵌预览") && raw.contains("3 处"),
            "「文件里就是没有预览」要点名查过几处: {raw}"
        );
        assert!(
            raw_container.contains("CIFF"),
            "「这个容器没做」要点名是哪种容器: {raw_container}"
        );
        assert!(
            raw_corrupt.contains("损坏") && raw_corrupt.contains("EOI"),
            "「找到了但坏了」要点名坏在哪: {raw_corrupt}"
        );
        assert!(
            too_big.contains("1.4 亿像素") && too_big.contains("1.2 亿像素"),
            "超限要同时报出原图多大、上限多大: {too_big}"
        );
        assert!(broken.contains("损坏"), "{broken}");
        assert!(gone.contains("不在项目里"), "{gone}");
        assert!(no_ffmpeg.contains("重新安装"), "{no_ffmpeg}");
        assert!(codec.contains("vvc"), "缺哪个解码器要点名: {codec}");
        assert!(slow.contains("30 秒"), "{slow}");

        let all = [
            &raw,
            &raw_container,
            &raw_corrupt,
            &other,
            &too_big,
            &broken,
            &gone,
            &no_ffmpeg,
            &codec,
            &slow,
        ];
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
                source: PreviewSource::Original,
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
        // 未知格式的判定必须在碰文件之前:文件不存在也要报「格式不支持」,
        // 不能报成「文件没了」——那会把用户引到完全错的排查方向
        let tmp = tempdir().unwrap();
        let q = tmp.path().join("readme.txt");
        assert!(matches!(
            decode_full_preview(&q, "readme.txt"),
            Err(PreviewError::Unsupported(Unsupported::Other(_)))
        ));
        // `.CRW` 这种老 Canon 容器 `media::classify` 根本不当 RAW,所以它走的是
        // 「没人认领」而不是 RAW 那一支——两张表的分工在这里钉一下,
        // 免得哪天有人以为 preview_raw 的 `UnsupportedFormat` 会从这条路出来
        let crw = tmp.path().join("IMG_0001.CRW");
        assert!(matches!(
            decode_full_preview(&crw, "IMG_0001.CRW"),
            Err(PreviewError::Unsupported(Unsupported::Other(_)))
        ));
    }

    /// 反过来:**有人认领**的格式(视频/HEIC/RAW)文件不在时必须报「文件没了」,
    /// 不能因为解不了就笼统归到「格式不支持」——那是两个排查方向。
    #[test]
    fn claimed_formats_report_source_gone_when_missing() {
        let tmp = tempdir().unwrap();
        for name in ["CLIP0001.MP4", "IMG_0001.heic", "DSC_0001.NEF"] {
            let p = tmp.path().join(name);
            assert!(
                matches!(decode_full_preview(&p, name), Err(PreviewError::SourceGone)),
                "{name} 不在时应报「文件没了」"
            );
        }
    }

    /* --------------------------------------------------------------- *
     * RAW 内嵌预览接线
     * --------------------------------------------------------------- */

    use super::super::raw_fixture::SynthRaw;

    fn decode_raw(tmp: &tempfile::TempDir, name: &str, spec: SynthRaw) -> (u32, u32, PreviewMeta) {
        let p = tmp.path().join(name);
        spec.write(&p);
        let (img, meta) = decode_full_preview(&p, name).expect("合成 RAW 必须能取出内嵌预览");
        (img.width(), img.height(), meta)
    }

    fn raw_source(meta: &PreviewMeta) -> (PreviewAdequacy, Option<String>) {
        match &meta.source {
            PreviewSource::RawEmbedded {
                adequacy, warning, ..
            } => (*adequacy, warning.clone()),
            other => panic!("RAW 必须走 RawEmbedded 这一支,实得 {other:?}"),
        }
    }

    /// 四档 adequacy 各自的判定与「有没有话说」。
    ///
    /// 这是本次接线的核心契约:**只有 FullSize 一档可以没话说**。
    /// 其余三档漏掉任何一句,用户就会拿一张半幅/缩略级/来路不明的图去判虚实,
    /// 而这正是这一路要修的那个 bug 的另一种形态。
    #[test]
    fn four_adequacy_tiers_each_get_their_own_verdict() {
        let tmp = tempdir().unwrap();

        // ① FullSize:内嵌预览长边 ≈ 原图长边
        let (_, _, meta) = decode_raw(
            &tmp,
            "FULL.NEF",
            SynthRaw::new((1600, 1067), Some((1620, 1080))),
        );
        let (a, w) = raw_source(&meta);
        assert_eq!(a, PreviewAdequacy::FullSize);
        assert!(w.is_none(), "全尺寸档由 warning() 决定没话说: {w:?}");

        // ② Reduced:半幅级——**必须**有一句带两组尺寸的常驻警示
        let (_, _, meta) = decode_raw(
            &tmp,
            "HALF.ARW",
            SynthRaw::new((1600, 1067), Some((3000, 2000))),
        );
        let (a, w) = raw_source(&meta);
        assert_eq!(a, PreviewAdequacy::Reduced);
        let w = w.expect("半幅级必须有话说——没有这句,用户就拿半幅图去抠对焦了");
        assert!(
            w.contains("1600×1067") && w.contains("3000×2000"),
            "半幅警示要同时写清内嵌预览多大、原图多大: {w}"
        );
        assert!(w.contains("判不准") || w.contains("抠对焦"), "{w}");

        // ③ ThumbnailOnly:缩略级
        let (_, _, meta) = decode_raw(
            &tmp,
            "THUMB.CR2",
            SynthRaw::new((800, 533), Some((3000, 2000))),
        );
        let (a, w) = raw_source(&meta);
        assert_eq!(a, PreviewAdequacy::ThumbnailOnly);
        assert!(w.unwrap().contains("判不了虚实"));

        // ④ Unknown:读不到原图尺寸——**不许**当成 FullSize 蒙混过去
        let (_, _, meta) = decode_raw(&tmp, "NOSIZE.DNG", SynthRaw::new((1600, 1067), None));
        let (a, w) = raw_source(&meta);
        assert_eq!(
            a,
            PreviewAdequacy::Unknown,
            "拿不到原图尺寸时假装是全尺寸,是这条 bug 最隐蔽的一种复发"
        );
        assert!(w.unwrap().contains("无法确认"));
    }

    /// 方向按 `media::apply_orientation` 口径施加,而且**只施加一次**。
    #[test]
    fn orientation_is_applied_once_never_twice() {
        let tmp = tempdir().unwrap();

        // 相机没摆正预览(预览与原图同为横构图)、EXIF 说转 90°:这里要转
        let (w, h, meta) = decode_raw(
            &tmp,
            "ROT.NEF",
            SynthRaw::new((1600, 1067), Some((3000, 2000))).with_orientation(6),
        );
        assert_eq!((w, h), (1067, 1600), "orientation=6 必须摆正成竖构图");
        assert_eq!((meta.source_width, meta.source_height), (1067, 1600));

        // 相机**已经**把预览摆正过(预览竖、原图横):preview_raw 那边已经
        // 判过并返回 orientation=1,这里再转一次就会把它转倒
        let (w, h, _) = decode_raw(
            &tmp,
            "UPRIGHT.NEF",
            SynthRaw::new((1067, 1600), Some((3000, 2000))).with_orientation(6),
        );
        assert_eq!(
            (w, h),
            (1067, 1600),
            "相机已摆正的预览不许再转一次——转两次的结果是倒着的,比不转更糟"
        );
    }

    /// 像素上限与长边缩放对 RAW 这一支同样生效(四条支路共用一套收尾)。
    #[test]
    fn raw_shares_the_same_ceilings_as_every_other_branch() {
        let tmp = tempdir().unwrap();
        let p = tmp.path().join("BIG.NEF");
        SynthRaw::new((1600, 1067), Some((1620, 1080))).write(&p);

        // 像素上限:压到 1000,1600×1067 必须被挡下,且报文点名两个数字
        let err = decode_full_preview_with_limits(&p, "BIG.NEF", 1_000, MAX_EDGE).unwrap_err();
        match err {
            PreviewError::TooLarge {
                pixels,
                limit,
                w,
                h,
            } => {
                assert_eq!((pixels, limit, w, h), (1_707_200, 1_000, 1600, 1067));
            }
            other => panic!("超限必须走 TooLarge,实际 {other:?}"),
        }

        // 长边上限:压到 800,呈现的必须是缩放图**并且标记出来**
        let (img, meta) =
            decode_full_preview_with_limits(&p, "BIG.NEF", MAX_DECODE_PIXELS, 800).unwrap();
        assert!(meta.downscaled, "超过长边上限必须标记为缩放");
        assert_eq!(img.width(), 800);
        assert_eq!(meta.source_width, 1600);
    }

    /// 「文件里就是没有内嵌预览」与「有但坏了」是两个排查方向,不许混为一谈。
    #[test]
    fn raw_failures_keep_their_own_classification() {
        let tmp = tempdir().unwrap();
        // 结构完好、但一处预览标签都没有
        let p = tmp.path().join("EMPTY.NEF");
        std::fs::write(
            &p,
            // II + 42 + 首 IFD 偏移 8 + 一个只有 Orientation 的 IFD
            {
                let mut v = vec![0u8; 8 + 2 + 12 + 4];
                v[0..2].copy_from_slice(b"II");
                v[2..4].copy_from_slice(&42u16.to_le_bytes());
                v[4..8].copy_from_slice(&8u32.to_le_bytes());
                v[8..10].copy_from_slice(&1u16.to_le_bytes());
                v[10..12].copy_from_slice(&0x0112u16.to_le_bytes());
                v[12..14].copy_from_slice(&3u16.to_le_bytes());
                v[14..18].copy_from_slice(&1u32.to_le_bytes());
                v[18..22].copy_from_slice(&1u32.to_le_bytes());
                v
            },
        )
        .unwrap();
        let no_preview = decode_full_preview(&p, "EMPTY.NEF").unwrap_err();
        assert!(
            matches!(
                no_preview,
                PreviewError::Raw(preview_raw::RawError::NoPreview { .. })
            ),
            "{no_preview:?}"
        );

        // 标签指着一段不是 JPEG 的数据
        let q = tmp.path().join("BROKEN.NEF");
        let mut bytes = SynthRaw::new((64, 48), Some((640, 480))).bytes();
        let n = bytes.len();
        bytes[n - 32..].fill(0); // 把 JPEG 尾巴(含 EOI)抹掉
        std::fs::write(&q, &bytes).unwrap();
        let corrupt = decode_full_preview(&q, "BROKEN.NEF").unwrap_err();
        assert!(
            matches!(
                corrupt,
                PreviewError::Raw(preview_raw::RawError::Corrupt { .. })
            ),
            "{corrupt:?}"
        );
        assert_ne!(
            no_preview.to_string(),
            corrupt.to_string(),
            "「没有预览」和「预览坏了」说同一句话,等于没分类"
        );
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
