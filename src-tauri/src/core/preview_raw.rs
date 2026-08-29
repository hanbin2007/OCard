//! RAW 内嵌预览提取:把相机自己渲染进 RAW 里的那张 JPEG 预览**按标签取出来**。
//!
//! ## 为什么要有这个模块
//!
//! 全屏预览接了全分辨率解码,但本机构建不含 libraw,RAW 解不了。目前 RAW 在
//! 全屏里显示的是 `media.rs` 走 EXIF `THUMBNAIL` IFD 拿到的那张内嵌小图——
//! 常见 160×120。选片时要在全屏里判虚实、判对焦,160×120 放大成插值糊块,
//! **判不了**,还会把错误判断伪装成正确判断。
//!
//! 而绝大多数 RAW 里其实还躺着一张**全尺寸(或接近全尺寸)的 JPEG**:那是
//! 相机机内渲染的成片,位置由各家格式**定义好的标签**确定性地指出来。
//! exiftool 的 `JpgFromRaw` / `PreviewImage` 读的就是这些标签。
//!
//! ## 「按标签取」和「扫最大的 JPEG」的区别
//!
//! 这两件事经常被混为一谈,但可靠性天差地别:
//!
//! - **扫字节流找 `FFD8…FFD9`**:纯启发式。RAW 里同时存在缩略图、预览图、
//!   MakerNote 里的对焦点图、甚至无损 JPEG 压缩的**原始 CFA 马赛克数据**
//!   (它也以 `FFD8` 开头!)。挑错了就是给用户看**另一张图**——这正是上一轮
//!   被否掉的做法,否得对。
//! - **本模块的做法**:只从各家格式**规范里定义的指针标签**取数据
//!   (TIFF 的 `JPEGInterchangeFormat` / 单条带 `StripOffsets`、Panasonic 的
//!   `JpgFromRaw`、RAF 头部的 JPEG 偏移字段、CR3 轨道的 `stco`+`stsz`)。
//!   每一处都是「这里有一张本帧的预览图」的**结构性声明**,不是猜。
//!
//! 一个文件里可能有多处这样的**声明**(缩略图 IFD + 预览 SubIFD)。它们都是
//! 同一帧的不同分辨率渲染,所以在**已声明的候选之间**选分辨率最高的那个,
//! 是「选清晰度」,不是「猜位置」——不会换成别的图。
//!
//! ## 取到之后还要过三道闸
//!
//! 1. 起始必须是 SOI(`FFD8`),结尾必须能找到 EOI(`FFD9`);
//! 2. 必须能被 `image` 解出真实宽高(挡住无损 JPEG / SOF3 之类解不了的东西);
//! 3. 宽高**如实返回**,并算出 [`EmbeddedPreview::fraction_of_full`]。
//!
//! 第 3 条是最要紧的:内嵌预览**不一定**是全尺寸。有的机型只塞 1/2 幅,老机型
//! 只有缩略级。把一张 1/4 幅的图当全尺寸交上去,只是换了个方式继续骗用户。
//! 所以调用方必须看 `fraction_of_full` / [`EmbeddedPreview::adequacy`] /
//! [`EmbeddedPreview::warning`] 决定要不要当面提示,不能默认「取到了就够用」。
//!
//! ## 能力边界(如实声明)
//!
//! - **能取**:TIFF/IFD 系(DNG、NEF、ARW、CR2、ORF、RW2、PEF、SRW…)、
//!   Canon CR3(ISO-BMFF)、Fujifilm RAF(自有头部)。
//! - **取不到就报错,不返回垃圾**:见 [`RawError`] 的五类。
//! - **不解 RAW 本身**:这里没有去马赛克、没有白平衡。取出来的是相机的渲染,
//!   不是「原始数据」。要看真正的 RAW 需要另立一项(见模块末尾的评估注释)。
//! - **不解析 MakerNote**:各家 MakerNote 的偏移基准不统一(有的相对文件头,
//!   有的相对 MakerNote 起点,有的加密),解析它是另一个量级的工作量和风险。
//!   少数只把预览放在 MakerNote 里的机型会落到 `NoPreview`——**如实报错**,
//!   而不是退回去扫字节流。
//! - **只认 JPEG 预览**:少数 RAW 用未压缩 TIFF 存预览,本模块不取(会落到
//!   `NoPreview` 或被更大的 JPEG 候选盖过)。
//! - **不改 `preview.rs`**:本模块是独立件,接线在别处做。
//!
//! ## 接线契约(给把它接进全屏预览的人)
//!
//! 1. **`warning()` 不是可选的。** 它返回 `Some(_)` 就必须让用户看见。
//!    界面上不显示这句话,就等于告诉一个正在判虚实的人「这是原图」——
//!    那比停在缩略图更糟,因为他会据此下判断。
//! 2. **`orientation` 要按 [`super::media::apply_orientation`] 施加**,和索引
//!    路径同口径,否则同一张图在网格里和全屏里方向不一致。本模块已经处理了
//!    「相机把预览提前摆正过」的情形(那时返回 1),调用方无脑施加即可。
//! 3. **`source` 适合进日志、不适合直接进 UI**:它是标签名与结构路径,给排查
//!    用;给用户的话在 `warning()` 里。
//! 4. **`RawError` 的 Display 就是给用户看的文案**,原样展示即可,不要再包一层
//!    「预览失败」之类的笼统措辞盖掉分类信息。`is_source_gone()` 对应
//!    `preview.rs` 的 `SourceGone` 语义。
//! 5. **成功不等于够用**:`adequacy()` 是 `FullSize` 才可以当全分辨率原图对待。

use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

// ---------------------------------------------------------------------------
// 上限常量:这段代码要喂任意存储卡内容,所有分配都必须先过上限 + 文件真实长度
// ---------------------------------------------------------------------------

/// 单块**元数据**读取上限(IFD 表、盒子头、CFA 目录之类)。
/// 正常 RAW 的元数据块都在几十 KB 量级,4MB 已经是几百倍余量。
const MAX_META_CHUNK: usize = 4 * 1024 * 1024;

/// 内嵌预览 JPEG 的字节上限。
///
/// 中画幅 1.5 亿像素机身的机内全尺寸 JPEG 约 30-50MB,96MB 留了两倍余量;
/// 再大的「预览」不可能是相机写的,只可能是损坏的长度字段或恶意构造。
pub const MAX_PREVIEW_BYTES: usize = 96 * 1024 * 1024;

/// 遍历 IFD 的数量上限。真实 RAW 最多十几个 IFD;64 足够,同时挡住
/// 被构造成互相指来指去的 IFD 图(另有 `seen` 集合挡环)。
const MAX_IFDS: usize = 64;

/// 单个 IFD 的条目数上限。真实 IFD 最多几百条。
const MAX_IFD_ENTRIES: usize = 4096;

/// `SubIFDs`(0x014A)指针数组的取用上限。
const MAX_SUBIFDS: usize = 32;

/// 一次实际读取并校验的候选数上限。真实文件最多 3-4 个候选。
const MAX_CANDIDATES: usize = 8;

/// ISO-BMFF 盒子遍历的总数上限。
///
/// 遍历本身是**非递归**的(每一层由调用方显式下钻,见 [`trak_stbl`]),
/// 所以不存在深递归爆栈的入口;这个预算挡的是「被构造成几百万个零长盒子」
/// 的文件——所有层共用同一个预算,总工作量因此有硬上限。
const MAX_BMFF_BOXES: usize = 4096;

/// EOI 之后允许存在的填充字节数。少数机型会在 JPEG 后补几个字节对齐,
/// 裁掉 EOI 之后的尾巴不会改变图像内容,但超过这个量说明取错了范围。
const MAX_TRAILING_PAD: usize = 1024;

/// 「能拿来判虚实」的绝对长边下限。
///
/// 低于这个长边,不管它占原图多大比例,放进全屏都是插值糊块——例如一张
/// 640×480 的预览即便来自 640×480 的「原图」,也不足以判断对焦。
/// 这是绝对闸,先于比例判断生效。
pub const MIN_USABLE_EDGE: u32 = 1024;

/// 长边达到原始尺寸的这个比例,才认为「等同全尺寸」。
/// 不取 1.0 是因为传感器尺寸普遍带遮蔽边(如 6048×4024 出 6000×4000),
/// 机内全尺寸 JPEG 天然就是 0.99 左右。
pub const FULL_SIZE_FRACTION: f32 = 0.90;

/// 长边达到原始尺寸的这个比例,算「半幅级」——够看构图,不够抠对焦。
pub const REDUCED_FRACTION: f32 = 0.45;

// ---------------------------------------------------------------------------
// 扩展名
// ---------------------------------------------------------------------------

/// 本模块认作 RAW 的扩展名(小写)。
///
/// 必须是 [`super::media::classify`] 里 `AssetKind::Raw` 那一支的**超集**:
/// 应用把某个扩展名当 RAW、这里却说「不是 RAW」,用户拿到的会是一句
/// 自相矛盾的提示。`raw_extension_superset` 单测钉死这个包含关系。
pub const RAW_EXTENSIONS: &[&str] = &[
    // TIFF/IFD 结构
    "dng", "cr2", "nef", "nrw", "arw", "sr2", "srf", "orf", "rw2", "rwl", "pef", "srw", "erf",
    "3fr", "iiq", "dcr", "kdc", "mos", "raw", // 自有容器
    "cr3", "raf", // 已知容器但本模块尚未支持(会给点名的 UnsupportedFormat)
    "crw", "mrw", "x3f",
];

/// 取相对路径/绝对路径的扩展名(小写)。没有扩展名返回空串。
fn extension_of(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    match name.rsplit_once('.') {
        // stem 为空是 `.CR3` 这种隐藏文件,不是「扩展名为 cr3 的文件」
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => ext.to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// 这个相对路径看起来是不是 RAW(仅看扩展名,不读文件)。
pub fn is_raw_extension(rel: &str) -> bool {
    let ext = extension_of(rel);
    !ext.is_empty() && RAW_EXTENSIONS.contains(&ext.as_str())
}

/// 扩展名对应的容器类型。
enum Container {
    /// 经典 TIFF/IFD(含 Panasonic 的 0x0055、Olympus 的 0x4F52 等变体魔数)
    Tiff,
    /// Canon CR3:ISO base media file format
    Cr3,
    /// Fujifilm RAF:自有头部
    Raf,
    /// 认得出是 RAW,但容器结构本模块没实现——点名原因
    Unsupported(&'static str),
}

fn container_for(ext: &str) -> Container {
    match ext {
        "cr3" => Container::Cr3,
        "raf" => Container::Raf,
        // CIFF 是 Canon EOS D30/10D 时代的自有容器,和 TIFF 完全不同
        "crw" => Container::Unsupported("CRW 用的是 Canon CIFF 容器(不是 TIFF),本模块未实现"),
        "mrw" => Container::Unsupported("MRW 用的是 Minolta 自有块结构(不是 TIFF),本模块未实现"),
        "x3f" => Container::Unsupported("X3F 用的是 Sigma FOVb 容器(不是 TIFF),本模块未实现"),
        _ => Container::Tiff,
    }
}

// ---------------------------------------------------------------------------
// 错误分类:每一条都会被原样做成用户可见文案,所以每一条都要能独立成句
// ---------------------------------------------------------------------------

/// 取内嵌预览失败的原因。分类必须具体:「这不是 RAW」「这个格式没做」
/// 「这个文件里就是没有预览」「有但坏了」指向的处置完全不同。
#[derive(Debug)]
pub enum RawError {
    /// 扩展名不在 RAW 列表里——调用方路由错了
    NotRaw { ext: String },
    /// 认得出是 RAW,但容器结构尚未支持
    UnsupportedFormat { ext: String, reason: String },
    /// 结构完好,但文件里没有任何标签声明的内嵌预览
    NoPreview {
        ext: String,
        /// 检查过几处可能放预览的结构位置(诊断用)
        examined: usize,
    },
    /// 找到了标签声明的预览,但数据不是一张完整可解的 JPEG
    Corrupt { ext: String, detail: String },
    /// 读文件失败
    Io {
        path: String,
        kind: std::io::ErrorKind,
        detail: String,
    },
}

impl RawError {
    /// 原文件已不在原处(被分类走/删掉)——调用方通常要区别对待。
    pub fn is_source_gone(&self) -> bool {
        matches!(self, Self::Io { kind, .. } if *kind == std::io::ErrorKind::NotFound)
    }
}

impl std::fmt::Display for RawError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotRaw { ext } => {
                if ext.is_empty() {
                    write!(f, "这个文件没有扩展名,不能按 RAW 处理")
                } else {
                    write!(f, "「.{ext}」不是本工具认识的 RAW 格式,没有内嵌预览可取")
                }
            }
            Self::UnsupportedFormat { ext, reason } => write!(
                f,
                "RAW(.{ext})的内嵌预览尚未支持:{reason}。\
                 全屏里只能停在相机的小缩略图,判不了虚实——请打开配套 JPEG 或用 RAW 处理软件看原片"
            ),
            Self::NoPreview { ext, examined } => write!(
                f,
                "这个 .{ext} 文件里没有可用的内嵌预览(已按格式规范检查过 {examined} 处标签位置)。\
                 相机可能没写全尺寸预览,或把它放在了本模块不解析的 MakerNote 里"
            ),
            Self::Corrupt { ext, detail } => write!(
                f,
                "这个 .{ext} 文件的内嵌预览损坏,取不出完整图像({detail})。\
                 文件可能在传输中被截断,建议重新从存储卡拷贝并校验"
            ),
            Self::Io { path, kind, detail } => {
                if *kind == std::io::ErrorKind::NotFound {
                    write!(f, "原文件已不在原处({path}),无法读取内嵌预览")
                } else {
                    write!(f, "读取 {path} 失败:{detail}")
                }
            }
        }
    }
}

impl std::error::Error for RawError {}

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

/// 从 RAW 里取出来的一张内嵌 JPEG 预览。
pub struct EmbeddedPreview {
    /// 校验通过的完整 JPEG 字节(尾部填充已裁掉)
    pub jpeg: Vec<u8>,
    /// **实测**宽高(由 `image` 从 JPEG 头解出,不是标签里声明的值)
    pub width: u32,
    pub height: u32,
    /// 相对原始感光尺寸的**长边**占比;拿不到原始尺寸时为 None
    pub fraction_of_full: Option<f32>,
    /// 原始尺寸(拿到才有)。留着是为了让告警能说出具体数字:
    /// 「内嵌预览 1616×1080,原图 6960×4640」比一句「只有 23%」有用得多。
    pub full_size: Option<(u32, u32)>,
    /// EXIF orientation(1..=8),与既有解码路径同口径地摆正
    /// (见 `media::apply_orientation`)。若判定预览已被相机摆正过,这里是 1。
    pub orientation: u16,
    /// 从哪个标签/结构取出来的,用于诊断与告警措辞
    pub source: &'static str,
}

/// 手写而不是 derive:`jpeg` 是几 MB 的字节流,derive 出来的 Debug 会把它
/// 整个倒进日志/断言失败信息里,既看不懂又能塞爆终端。这里只报长度。
impl std::fmt::Debug for EmbeddedPreview {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EmbeddedPreview")
            .field("jpeg_bytes", &self.jpeg.len())
            .field("width", &self.width)
            .field("height", &self.height)
            .field("fraction_of_full", &self.fraction_of_full)
            .field("full_size", &self.full_size)
            .field("orientation", &self.orientation)
            .field("source", &self.source)
            .finish()
    }
}

/// 这张预览够不够拿来判虚实。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewAdequacy {
    /// 长边 ≥ 原图的 [`FULL_SIZE_FRACTION`]:可以按 1:1 判对焦
    FullSize,
    /// 半幅级:够看构图和大面积失焦,抠不了细节
    Reduced,
    /// 缩略级:**判不了虚实**,必须当面说
    ThumbnailOnly,
    /// 拿不到原始尺寸,无法断定占比(长边本身已过绝对下限)
    Unknown,
}

impl std::fmt::Display for PreviewAdequacy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FullSize => write!(f, "全尺寸"),
            Self::Reduced => write!(f, "半幅级"),
            Self::ThumbnailOnly => write!(f, "缩略级"),
            Self::Unknown => write!(f, "占比未知"),
        }
    }
}

impl EmbeddedPreview {
    /// 长边像素数。
    pub fn long_edge(&self) -> u32 {
        self.width.max(self.height)
    }

    /// 这张预览够不够判虚实。
    ///
    /// 绝对下限先生效:长边低于 [`MIN_USABLE_EDGE`] 一律算缩略级,哪怕它
    /// 「占原图 100%」——那种情况下原图本身就小到判不了。
    pub fn adequacy(&self) -> PreviewAdequacy {
        if self.long_edge() < MIN_USABLE_EDGE {
            return PreviewAdequacy::ThumbnailOnly;
        }
        match self.fraction_of_full {
            Some(f) if f >= FULL_SIZE_FRACTION => PreviewAdequacy::FullSize,
            Some(f) if f >= REDUCED_FRACTION => PreviewAdequacy::Reduced,
            Some(_) => PreviewAdequacy::ThumbnailOnly,
            None => PreviewAdequacy::Unknown,
        }
    }

    /// 必须当面告诉用户的话。`None` 表示这张可以直接当全尺寸用。
    ///
    /// 零静默:调用方要么显示这句话,要么就别用这张图——不允许静默地
    /// 把一张 1/4 幅的预览当成原图交给正在判虚实的人。
    pub fn warning(&self) -> Option<String> {
        let size = format!("{}×{}", self.width, self.height);
        let full = self
            .full_size
            .map(|(w, h)| format!(",原始尺寸 {w}×{h}"))
            .unwrap_or_default();
        match self.adequacy() {
            PreviewAdequacy::FullSize => None,
            // 文案是纯文本:界面可能直接塞进 Text 节点,不保证渲染 Markdown,
            // 用星号做强调只会让用户看到一堆 `**`
            PreviewAdequacy::Reduced => Some(format!(
                "这是相机内嵌的「半幅」预览({size}{full}),不是全分辨率原图:\
                 构图和明显跑焦看得出,细微的虚实判不准——要抠对焦请用 RAW 处理软件"
            )),
            PreviewAdequacy::ThumbnailOnly => Some(format!(
                "这只是相机内嵌的「缩略级」预览({size}{full}),\
                 放大后是插值糊块,判不了虚实和对焦——请打开配套 JPEG 或用 RAW 处理软件看原片"
            )),
            PreviewAdequacy::Unknown => Some(format!(
                "这是相机内嵌的预览({size}),读不到 RAW 的原始感光尺寸,\
                 无法确认它是不是全分辨率——判虚实前请留意这一点"
            )),
        }
    }
}

// ---------------------------------------------------------------------------
// 字节源:所有读取都经过它,统一做边界检查
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum ReadFail {
    /// 偏移/长度越出文件边界——损坏或恶意构造
    OutOfBounds {
        off: u64,
        len: usize,
        size: u64,
    },
    /// 声明长度超过本模块愿意分配的上限
    TooLarge {
        len: usize,
        limit: usize,
    },
    Io(std::io::Error),
}

impl std::fmt::Display for ReadFail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OutOfBounds { off, len, size } => write!(
                f,
                "标签指向的位置越界(偏移 {off} + 长度 {len} 超出文件 {size} 字节)"
            ),
            Self::TooLarge { len, limit } => write!(
                f,
                "标签声明的长度 {len} 字节超过本模块上限 {limit} 字节,不予分配"
            ),
            Self::Io(e) => write!(f, "读取失败:{e}"),
        }
    }
}

/// 带边界检查的随机读。
///
/// **绝不按文件里写的长度直接分配内存**:先卡 `limit`,再卡文件真实长度,
/// 两道都过了才 `vec![0; len]`。
trait ByteSource {
    fn size(&self) -> u64;
    fn read_at(&mut self, off: u64, len: usize, limit: usize) -> Result<Vec<u8>, ReadFail>;

    /// 读元数据(用 [`MAX_META_CHUNK`] 上限)
    fn meta(&mut self, off: u64, len: usize) -> Result<Vec<u8>, ReadFail> {
        self.read_at(off, len, MAX_META_CHUNK)
    }
}

struct FileSource {
    file: File,
    size: u64,
}

impl FileSource {
    fn open(path: &Path) -> std::io::Result<Self> {
        let file = File::open(path)?;
        let size = file.metadata()?.len();
        Ok(Self { file, size })
    }
}

impl ByteSource for FileSource {
    fn size(&self) -> u64 {
        self.size
    }

    fn read_at(&mut self, off: u64, len: usize, limit: usize) -> Result<Vec<u8>, ReadFail> {
        if len > limit {
            return Err(ReadFail::TooLarge { len, limit });
        }
        let end = off.checked_add(len as u64).ok_or(ReadFail::OutOfBounds {
            off,
            len,
            size: self.size,
        })?;
        if end > self.size {
            return Err(ReadFail::OutOfBounds {
                off,
                len,
                size: self.size,
            });
        }
        self.file.seek(SeekFrom::Start(off)).map_err(ReadFail::Io)?;
        // 到这一步 len 既 ≤ limit 也 ≤ 文件真实长度,分配是安全的
        let mut buf = vec![0u8; len];
        self.file.read_exact(&mut buf).map_err(ReadFail::Io)?;
        Ok(buf)
    }
}

/// 内存里的 TIFF 片段(CR3 的 CMT1/CMT2 盒子)。
struct SliceSource<'a> {
    data: &'a [u8],
}

impl ByteSource for SliceSource<'_> {
    fn size(&self) -> u64 {
        self.data.len() as u64
    }

    fn read_at(&mut self, off: u64, len: usize, limit: usize) -> Result<Vec<u8>, ReadFail> {
        if len > limit {
            return Err(ReadFail::TooLarge { len, limit });
        }
        let size = self.size();
        let start = usize::try_from(off).map_err(|_| ReadFail::OutOfBounds { off, len, size })?;
        let end = start
            .checked_add(len)
            .ok_or(ReadFail::OutOfBounds { off, len, size })?;
        self.data
            .get(start..end)
            .map(|s| s.to_vec())
            .ok_or(ReadFail::OutOfBounds { off, len, size })
    }
}

// ---------------------------------------------------------------------------
// 小端/大端读取helper(全部返回 Option,越界即 None,不 panic)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Endian {
    Little,
    Big,
}

fn rd_u16(e: Endian, b: &[u8], at: usize) -> Option<u16> {
    let s = b.get(at..at.checked_add(2)?)?;
    let a = [s[0], s[1]];
    Some(match e {
        Endian::Little => u16::from_le_bytes(a),
        Endian::Big => u16::from_be_bytes(a),
    })
}

fn rd_u32(e: Endian, b: &[u8], at: usize) -> Option<u32> {
    let s = b.get(at..at.checked_add(4)?)?;
    let a = [s[0], s[1], s[2], s[3]];
    Some(match e {
        Endian::Little => u32::from_le_bytes(a),
        Endian::Big => u32::from_be_bytes(a),
    })
}

fn be_u16(b: &[u8], at: usize) -> Option<u16> {
    rd_u16(Endian::Big, b, at)
}

fn be_u32(b: &[u8], at: usize) -> Option<u32> {
    rd_u32(Endian::Big, b, at)
}

fn be_u64(b: &[u8], at: usize) -> Option<u64> {
    let s = b.get(at..at.checked_add(8)?)?;
    let mut a = [0u8; 8];
    a.copy_from_slice(s);
    Some(u64::from_be_bytes(a))
}

// ---------------------------------------------------------------------------
// TIFF / IFD
// ---------------------------------------------------------------------------

// TIFF 6.0 / TIFF-EP / EXIF / DNG 标签号。每个的语义写在使用处。
const T_NEW_SUBFILE_TYPE: u16 = 0x00FE;
const T_IMAGE_WIDTH: u16 = 0x0100;
const T_IMAGE_LENGTH: u16 = 0x0101;
const T_COMPRESSION: u16 = 0x0103;
const T_PHOTOMETRIC: u16 = 0x0106;
const T_STRIP_OFFSETS: u16 = 0x0111;
const T_ORIENTATION: u16 = 0x0112;
const T_STRIP_BYTE_COUNTS: u16 = 0x0117;
const T_SUB_IFDS: u16 = 0x014A;
const T_JPEG_IF: u16 = 0x0201;
const T_JPEG_IF_LEN: u16 = 0x0202;
const T_EXIF_IFD: u16 = 0x8769;
const T_PIXEL_X_DIM: u16 = 0xA002;
const T_PIXEL_Y_DIM: u16 = 0xA003;
const T_DNG_DEFAULT_CROP_SIZE: u16 = 0xC620;

// Panasonic RW2 在 IFD0 里用的自有标签(exiftool `Image::ExifTool::PanasonicRaw`)
const T_PANA_IMAGE_HEIGHT: u16 = 0x0006;
const T_PANA_IMAGE_WIDTH: u16 = 0x0007;
const T_PANA_JPG_FROM_RAW: u16 = 0x002E;

// PhotometricInterpretation 里表示「这不是给人看的图」的两个值——
// 命中就必须跳过,否则会把原始 CFA 马赛克(无损 JPEG,同样以 FFD8 开头)
// 当成预览交出去,那就是真的给用户看了另一张图。
const PHOTOMETRIC_CFA: u64 = 32803;
const PHOTOMETRIC_LINEAR_RAW: u64 = 34892;

const SRC_TIFF_JPEG_IF: &str = "TIFF IFD · JPEGInterchangeFormat/Length(0x0201/0x0202)";
const SRC_TIFF_STRIP_JPEG: &str =
    "TIFF IFD · StripOffsets/StripByteCounts + Compression=JPEG(0x0111/0x0117/0x0103)";
const SRC_PANA_JPG_FROM_RAW: &str = "Panasonic RW2 IFD0 · JpgFromRaw(0x002E)";
const SRC_RAF_HEADER: &str = "Fujifilm RAF 头部 · JPEG 偏移/长度(0x54/0x58)";
const SRC_CR3_TRAK: &str = "Canon CR3 moov/trak/mdia/minf/stbl · stco+stsz 首样本";
const SRC_CR3_THMB: &str = "Canon CR3 moov/uuid · THMB";

/// 一条 IFD 记录(12 字节)。
#[derive(Clone, Copy)]
struct Entry {
    tag: u16,
    ty: u16,
    count: u32,
    /// 值区原始 4 字节:≤4 字节的值内联在这里,否则这里是偏移
    val: [u8; 4],
}

/// 类型宽度(字节)。未知类型返回 None——未知类型的值区长度算不出来,
/// 一律当作不可用,不去猜。
fn type_width(ty: u16) -> Option<u32> {
    Some(match ty {
        1 | 2 | 6 | 7 => 1,   // BYTE / ASCII / SBYTE / UNDEFINED
        3 | 8 => 2,           // SHORT / SSHORT
        4 | 9 | 11 | 13 => 4, // LONG / SLONG / FLOAT / IFD
        5 | 10 | 12 => 8,     // RATIONAL / SRATIONAL / DOUBLE
        16..=18 => 8,         // LONG8 / SLONG8 / IFD8(BigTIFF,这里只为算长度)
        _ => return None,
    })
}

impl Entry {
    /// 值区总字节数。
    fn byte_len(&self) -> Option<u64> {
        Some(u64::from(type_width(self.ty)?) * u64::from(self.count))
    }

    /// 值区在文件里的绝对偏移与长度;值内联(≤4 字节)时为 None。
    fn blob(&self, e: Endian) -> Option<(u64, usize)> {
        let total = self.byte_len()?;
        if total <= 4 {
            return None;
        }
        let off = u64::from(rd_u32(e, &self.val, 0)?);
        Some((off, usize::try_from(total).ok()?))
    }
}

struct Ifd {
    entries: Vec<Entry>,
}

impl Ifd {
    fn get(&self, tag: u16) -> Option<&Entry> {
        self.entries.iter().find(|e| e.tag == tag)
    }
}

/// 取一条 entry 的前 `max` 个整数值(只处理整数类;其他类型返回空)。
fn entry_uints(e: Endian, src: &mut dyn ByteSource, en: &Entry, max: usize) -> Vec<u64> {
    let width = match en.ty {
        1 | 2 | 6 | 7 => 1usize,
        3 | 8 => 2,
        4 | 9 | 13 => 4,
        _ => return Vec::new(),
    };
    let want = (en.count as usize).min(max);
    if want == 0 {
        return Vec::new();
    }
    let total = u64::from(en.count) * width as u64;
    let bytes = if total <= 4 {
        en.val.to_vec()
    } else {
        let Some(off) = rd_u32(e, &en.val, 0) else {
            return Vec::new();
        };
        // 只读需要的前 want 个,不按 count 全读——count 可以是伪造的 40 亿
        match src.meta(u64::from(off), want * width) {
            Ok(b) => b,
            Err(_) => return Vec::new(),
        }
    };
    (0..want)
        .filter_map(|i| {
            let at = i * width;
            Some(match width {
                1 => u64::from(*bytes.get(at)?),
                2 => u64::from(rd_u16(e, &bytes, at)?),
                _ => u64::from(rd_u32(e, &bytes, at)?),
            })
        })
        .collect()
}

fn tag_uint(e: Endian, src: &mut dyn ByteSource, ifd: &Ifd, tag: u16) -> Option<u64> {
    let en = ifd.get(tag)?;
    entry_uints(e, src, en, 1).first().copied()
}

/// 读一个 IFD:2 字节条目数 + N×12 字节条目 + 4 字节 next 指针。
fn read_ifd(e: Endian, src: &mut dyn ByteSource, off: u64) -> Option<(Ifd, u64)> {
    let head = src.meta(off, 2).ok()?;
    let count = rd_u16(e, &head, 0)? as usize;
    if count == 0 || count > MAX_IFD_ENTRIES {
        return None;
    }
    let body = src.meta(off + 2, count * 12).ok()?;
    let entries = (0..count)
        .filter_map(|i| {
            let at = i * 12;
            let mut val = [0u8; 4];
            val.copy_from_slice(body.get(at + 8..at + 12)?);
            Some(Entry {
                tag: rd_u16(e, &body, at)?,
                ty: rd_u16(e, &body, at + 2)?,
                count: rd_u32(e, &body, at + 4)?,
                val,
            })
        })
        .collect::<Vec<_>>();
    // next 指针缺失(文件末尾被截断)不算致命:当作链结束
    let next = src
        .meta(off + 2 + (count as u64) * 12, 4)
        .ok()
        .and_then(|b| rd_u32(e, &b, 0))
        .map(u64::from)
        .unwrap_or(0);
    Some((Ifd { entries }, next))
}

/// 广度优先遍历 IFD 图:IFD 链(next)+ SubIFDs(0x014A)+ ExifIFD(0x8769)。
///
/// 为什么要走 SubIFDs:DNG/NEF/ARW 的**全尺寸**预览就放在 SubIFD 里
/// (TIFF-EP 规定 IFD0 存缩略图,全分辨率图像与其他分辨率的渲染放 SubIFD)。
/// 只看 IFD0/IFD1 就只能拿到 160×120——正是现在的问题。
///
/// `seen` 挡自引用和环,`MAX_IFDS` 挡爆炸式的 SubIFD 图。
fn walk_ifds(e: Endian, src: &mut dyn ByteSource, first: u64) -> Vec<Ifd> {
    let mut out = Vec::new();
    let mut seen: HashSet<u64> = HashSet::new();
    let mut queue: Vec<u64> = vec![first];
    while let Some(off) = queue.pop() {
        if out.len() >= MAX_IFDS || off == 0 || !seen.insert(off) {
            continue;
        }
        let Some((ifd, next)) = read_ifd(e, src, off) else {
            continue;
        };
        if next != 0 {
            queue.push(next);
        }
        if let Some(en) = ifd.get(T_SUB_IFDS) {
            for sub in entry_uints(e, src, en, MAX_SUBIFDS) {
                queue.push(sub);
            }
        }
        if let Some(en) = ifd.get(T_EXIF_IFD) {
            if let Some(v) = entry_uints(e, src, en, 1).first() {
                queue.push(*v);
            }
        }
        out.push(ifd);
    }
    out
}

// ---------------------------------------------------------------------------
// 候选:一处「标签声明这里有一张预览 JPEG」的位置
// ---------------------------------------------------------------------------

struct Candidate {
    off: u64,
    len: usize,
    source: &'static str,
}

/// 从一个 IFD 里收集**标签声明**的预览位置。
///
/// 两种声明形式(都来自规范,不是猜):
///
/// 1. `JPEGInterchangeFormat`(0x0201)+ `JPEGInterchangeFormatLength`(0x0202)。
///    TIFF 6.0 里它是缩略图指针;TIFF-EP / 各家 RAW 沿用同一对标签存
///    「另一幅 JPEG 图像」,exiftool 按所在 IFD 分别叫它 ThumbnailImage /
///    PreviewImage / JpgFromRaw / OtherImage。Nikon NEF 的全尺寸 JPEG 就在
///    SubIFD 的这一对标签上。
///
/// 2. `StripOffsets`(0x0111)+ `StripByteCounts`(0x0117),且
///    `Compression`(0x0103)= 6(旧式 JPEG)或 7(新式 JPEG),且只有一个条带。
///    这是 DNG 规范给预览图规定的存法(DNG spec: previews are stored as a
///    single strip),Canon CR2 的 IFD0 全尺寸预览也是这个形式。
///
/// **必须排除的**:`PhotometricInterpretation` 为 CFA(32803)或 LinearRaw
/// (34892)的 IFD——那是原始感光数据,无损 JPEG 压缩的 CFA 同样以 FFD8 开头,
/// 取出来就是给用户看一张马赛克图。这道闸是这个函数里最关键的一行。
fn candidates_in_ifd(
    e: Endian,
    src: &mut dyn ByteSource,
    ifd: &Ifd,
    is_rw2: bool,
) -> Vec<Candidate> {
    let mut out = Vec::new();

    // 形式 1
    let off = tag_uint(e, src, ifd, T_JPEG_IF);
    let len = tag_uint(e, src, ifd, T_JPEG_IF_LEN);
    if let (Some(off), Some(len)) = (off, len) {
        if len > 0 {
            if let Ok(len) = usize::try_from(len) {
                out.push(Candidate {
                    off,
                    len,
                    source: SRC_TIFF_JPEG_IF,
                });
            }
        }
    }

    // 形式 2
    let compression = tag_uint(e, src, ifd, T_COMPRESSION);
    let photometric = tag_uint(e, src, ifd, T_PHOTOMETRIC);
    let is_jpeg_compression = matches!(compression, Some(6) | Some(7));
    // PhotometricInterpretation 缺失时放行:CR2 的 IFD0 就不写它,而三道
    // JPEG 校验闸(SOI/EOI/可解尺寸)仍然拦得住非图像数据。
    let is_viewable = !matches!(
        photometric,
        Some(PHOTOMETRIC_CFA) | Some(PHOTOMETRIC_LINEAR_RAW)
    );
    if is_jpeg_compression && is_viewable {
        let so = ifd.get(T_STRIP_OFFSETS);
        let sc = ifd.get(T_STRIP_BYTE_COUNTS);
        if let (Some(so), Some(sc)) = (so, sc) {
            // 只认单条带:多条带的 JPEG 需要按 TIFF 的分片规则重组,那不是
            // 一张能直接交出去的完整 JPEG。RAW 里的预览按规范都是单条带。
            if so.count == 1 && sc.count == 1 {
                let off = entry_uints(e, src, so, 1).first().copied();
                let len = entry_uints(e, src, sc, 1).first().copied();
                if let (Some(off), Some(len)) = (off, len) {
                    if len > 0 {
                        if let Ok(len) = usize::try_from(len) {
                            out.push(Candidate {
                                off,
                                len,
                                source: SRC_TIFF_STRIP_JPEG,
                            });
                        }
                    }
                }
            }
        }
    }

    // 形式 3:Panasonic RW2 把整张 JPEG 直接当作 0x002E 标签的值存着
    // (类型 UNDEFINED,count 就是字节数)。只在 RW2 魔数下认这个标签,
    // 免得在别家格式里撞上同号标签。
    if is_rw2 {
        if let Some(en) = ifd.get(T_PANA_JPG_FROM_RAW) {
            if let Some((off, len)) = en.blob(e) {
                out.push(Candidate {
                    off,
                    len,
                    source: SRC_PANA_JPG_FROM_RAW,
                });
            }
        }
    }

    out
}

// ---------------------------------------------------------------------------
// JPEG 校验:取出来的必须确实是一张完整、可解的 JPEG
// ---------------------------------------------------------------------------

/// 校验并规整一段字节。返回(裁掉尾部填充的字节,宽,高)。
fn validate_jpeg(mut bytes: Vec<u8>) -> Result<(Vec<u8>, u32, u32), String> {
    if bytes.len() < 4 {
        return Err(format!("只有 {} 字节,不可能是一张 JPEG", bytes.len()));
    }
    if bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return Err(format!(
            "开头不是 JPEG 的 SOI 标记(是 {:02X}{:02X})",
            bytes[0], bytes[1]
        ));
    }
    // 结尾必须是 EOI。少数机型在 EOI 后补对齐字节,允许裁掉一小段尾巴——
    // EOI 之后的内容不参与解码,裁掉不改变图像;但超过 MAX_TRAILING_PAD
    // 说明取到的范围本身就不对,不能当作「有点脏但没事」放过去。
    if bytes[bytes.len() - 2..] != [0xFF, 0xD9] {
        let from = bytes.len().saturating_sub(MAX_TRAILING_PAD + 2);
        let eoi = bytes[from..]
            .windows(2)
            .rposition(|w| w == [0xFF, 0xD9])
            .map(|p| from + p);
        match eoi {
            Some(p) => bytes.truncate(p + 2),
            None => {
                return Err(format!(
                    "结尾找不到 JPEG 的 EOI 标记(数据被截断或取错了范围,共 {} 字节)",
                    bytes.len()
                ))
            }
        }
    }
    // 第三道闸:必须真能解出尺寸。挡住 SOF3(无损 JPEG,原始感光数据常用)
    // 和头部损坏的东西——它们同样有 SOI/EOI,但不是能显示的图。
    let mut reader = image::ImageReader::new(std::io::Cursor::new(&bytes));
    reader.set_format(image::ImageFormat::Jpeg);
    let (w, h) = reader
        .into_dimensions()
        .map_err(|e| format!("JPEG 头解不出尺寸:{e}"))?;
    if w == 0 || h == 0 {
        return Err("JPEG 头里的尺寸是 0".to_string());
    }
    Ok((bytes, w, h))
}

/// 依次读取并校验候选,挑分辨率最高的一个。
///
/// 为什么可以「挑最大」:每个候选都是**标签声明**的、本帧的预览渲染,
/// 它们之间只差分辨率。在已声明的候选里选最大,是选清晰度,不是猜位置。
///
/// 返回 `Err(String)` 表示「有候选但没有一个通得过校验」——这和「压根没有
/// 候选」是两类错误,必须分开报。
type Realized = (Vec<u8>, u32, u32, &'static str);

fn realize_best(src: &mut dyn ByteSource, cands: &[Candidate]) -> Result<Realized, String> {
    // 先按**声明的字节数**从大到小排,再截到 MAX_CANDIDATES。
    // 为什么要排:真实文件只有 3-4 个候选,但一个损坏/恶意构造的文件可以
    // 声明上百个。若不排序就截断,截掉的可能恰好是那张全尺寸预览,用户会
    // 拿到一张缩略图却以为是全尺寸——静默降级,正是要避免的事。
    // 字节数大不等于像素多,所以这只决定**先看谁**,最终仍按实测像素挑。
    let mut order: Vec<&Candidate> = cands.iter().collect();
    order.sort_by_key(|c| std::cmp::Reverse(c.len));

    let mut best: Option<Realized> = None;
    let mut first_failure: Option<String> = None;
    for c in order.into_iter().take(MAX_CANDIDATES) {
        // 先只读 2 字节看 SOI,再决定要不要把整块拉进内存。
        // 这不是省几个字节的事:CR3 的原始数据轨道首样本动辄几十 MB,
        // 只为确认「它不是 JPEG」就整块读进来,一次全屏预览要白读几十 MB。
        match src.read_at(c.off, 2, 2) {
            Ok(b) if b == [0xFF, 0xD8] => {}
            Ok(b) => {
                first_failure.get_or_insert_with(|| {
                    format!(
                        "{} → 开头不是 JPEG 的 SOI 标记(是 {:02X}{:02X})",
                        c.source, b[0], b[1]
                    )
                });
                continue;
            }
            Err(e) => {
                first_failure.get_or_insert_with(|| format!("{} → {e}", c.source));
                continue;
            }
        }
        let bytes = match src.read_at(c.off, c.len, MAX_PREVIEW_BYTES) {
            Ok(b) => b,
            Err(e) => {
                first_failure.get_or_insert_with(|| format!("{} → {e}", c.source));
                continue;
            }
        };
        match validate_jpeg(bytes) {
            Ok((bytes, w, h)) => {
                let better = best.as_ref().is_none_or(|(_, bw, bh, _)| {
                    u64::from(w) * u64::from(h) > u64::from(*bw) * u64::from(*bh)
                });
                if better {
                    best = Some((bytes, w, h, c.source));
                }
            }
            Err(e) => {
                first_failure.get_or_insert_with(|| format!("{} → {e}", c.source));
            }
        }
    }
    best.ok_or_else(|| first_failure.unwrap_or_else(|| "候选为空".to_string()))
}

// ---------------------------------------------------------------------------
// 原始尺寸与 fraction_of_full
// ---------------------------------------------------------------------------

/// 尺寸是否落在「真实相机」的合理范围内。用来挡住损坏/伪造的尺寸字段,
/// 免得算出一个荒唐的比例去误导用户。
fn plausible_size(w: u64, h: u64) -> bool {
    w > 0 && h > 0 && w <= 200_000 && h <= 200_000 && w * h <= 4_000_000_000
}

fn as_size(w: u64, h: u64) -> Option<(u32, u32)> {
    if plausible_size(w, h) {
        Some((w as u32, h as u32))
    } else {
        None
    }
}

/// 这个 IFD 是不是「降分辨率的附属图像」。
///
/// `NewSubfileType`(0x00FE)是位域,bit0 置位表示降分辨率(TIFF 6.0 的
/// NewSubfileType 定义,TIFF-EP / DNG 沿用)。标签缺失时返回 `None`——
/// 「不知道」和「知道它不是」是两回事,调用处按各自的需要区别处理。
fn is_reduced_resolution(e: Endian, src: &mut dyn ByteSource, ifd: &Ifd) -> Option<bool> {
    tag_uint(e, src, ifd, T_NEW_SUBFILE_TYPE).map(|v| v & 1 == 1)
}

/// 找 RAW 的**原始感光/输出尺寸**。按可靠性排优先级,拿不到就返回 None——
/// 宁可诚实地说「不知道占比」,也不编一个数出来。
///
/// 1. Panasonic RW2 的 0x0007/0x0006(ImageWidth/ImageHeight):RW2 的 IFD0
///    不写标准的 0x0100/0x0101,只有这一对是权威。
/// 2. DNG `DefaultCropSize`(0xC620):DNG 规范里「这张 RAW 的输出尺寸」。
/// 3. `NewSubfileType` bit0 = 0 的那个 IFD 的 ImageWidth/ImageLength。
///    TIFF-EP/DNG 规定 bit0 清零 = 全分辨率主图像,置位 = 降分辨率附属图像。
/// 4. 所有**未标降分辨率**的 IFD 里 ImageWidth×ImageLength 最大的那组。兜
///    Canon CR2 这种不写 NewSubfileType 的格式(它的 RAW IFD 有真实感光尺寸)。
///    取最大值会把带遮蔽边的感光尺寸算进去,于是 fraction 略微**偏小**——
///    偏小意味着「该提醒时提醒了,不该提醒时多提醒一次」,方向是安全的。
/// 5. ExifIFD `PixelXDimension`/`PixelYDimension`(0xA002/0xA003)。放最后是
///    因为个别机型会把它写成预览的尺寸,那样会把比例算成 1.0——高估是危险方向。
fn full_size_from_ifds(
    e: Endian,
    src: &mut dyn ByteSource,
    ifds: &[Ifd],
    is_rw2: bool,
) -> Option<(u32, u32)> {
    if is_rw2 {
        let w = tag_uint(e, src, ifds.first()?, T_PANA_IMAGE_WIDTH);
        let h = tag_uint(e, src, ifds.first()?, T_PANA_IMAGE_HEIGHT);
        if let (Some(w), Some(h)) = (w, h) {
            if let Some(s) = as_size(w, h) {
                return Some(s);
            }
        }
    }
    for ifd in ifds {
        if let Some(en) = ifd.get(T_DNG_DEFAULT_CROP_SIZE) {
            let v = entry_uints(e, src, en, 2);
            if v.len() == 2 {
                if let Some(s) = as_size(v[0], v[1]) {
                    return Some(s);
                }
            }
        }
    }
    for ifd in ifds {
        // NewSubfileType 是位域,bit0 = 降分辨率的附属图像。bit0 为 0 才是主图像。
        if is_reduced_resolution(e, src, ifd) == Some(false) {
            let w = tag_uint(e, src, ifd, T_IMAGE_WIDTH);
            let h = tag_uint(e, src, ifd, T_IMAGE_LENGTH);
            if let (Some(w), Some(h)) = (w, h) {
                if let Some(s) = as_size(w, h) {
                    return Some(s);
                }
            }
        }
    }
    let mut biggest: Option<(u32, u32)> = None;
    for ifd in ifds {
        // 明确标着「降分辨率」的 IFD 不能拿它的尺寸当原始尺寸——否则一张
        // 半幅预览会把自己的尺寸报成原图,fraction 变 1.0,告警消失,
        // 用户以为在看全分辨率。这是本函数里唯一会**高估**的方向,必须堵死。
        if is_reduced_resolution(e, src, ifd) == Some(true) {
            continue;
        }
        let w = tag_uint(e, src, ifd, T_IMAGE_WIDTH);
        let h = tag_uint(e, src, ifd, T_IMAGE_LENGTH);
        if let (Some(w), Some(h)) = (w, h) {
            if let Some((w, h)) = as_size(w, h) {
                let better = biggest.is_none_or(|(bw, bh)| {
                    u64::from(w) * u64::from(h) > u64::from(bw) * u64::from(bh)
                });
                if better {
                    biggest = Some((w, h));
                }
            }
        }
    }
    if biggest.is_some() {
        return biggest;
    }
    for ifd in ifds {
        let w = tag_uint(e, src, ifd, T_PIXEL_X_DIM);
        let h = tag_uint(e, src, ifd, T_PIXEL_Y_DIM);
        if let (Some(w), Some(h)) = (w, h) {
            if let Some(s) = as_size(w, h) {
                return Some(s);
            }
        }
    }
    None
}

/// 内嵌预览长边 ÷ 原始长边。
///
/// 为什么用长边而不是面积:判虚实看的是**线性分辨率**(同一根头发占多少像素)。
/// 一张「半幅」预览按面积算是 25%,读起来像比实际更糟;按长边算是 50%,
/// 才是「每个方向少一半像素」的真实含义。长边比还与横竖摆放无关,
/// 预览有没有被相机提前摆正都不影响结果。
fn fraction_of(pw: u32, ph: u32, full: Option<(u32, u32)>) -> Option<f32> {
    let (fw, fh) = full?;
    let f = fw.max(fh);
    if f == 0 {
        return None;
    }
    // clamp:损坏的尺寸字段不该让比例跑到离谱的数量级
    Some((pw.max(ph) as f32 / f as f32).clamp(0.0, 4.0))
}

/// 内嵌预览是不是**已经**被相机摆正过。
///
/// 为什么要判:既有解码路径的口径是「RAW 的 EXIF Orientation 是权威,
/// 内嵌预览没摆正」(见 `media.rs` 的 `make_raw_thumb`)。但确实有机型写的是
/// 已摆正的预览。对一张已摆正的图再转 90°,结果是**倒着的**——比不转更糟。
///
/// 只在证据明确时才推翻:原始尺寸已知、orientation 是 90° 类(5..=8)、
/// 且预览的横竖朝向与原图**相反**。接近正方形的一律不判(比例噪声会误伤)。
fn preview_already_upright(pw: u32, ph: u32, full: (u32, u32), orientation: u16) -> bool {
    if !(5..=8).contains(&orientation) {
        return false;
    }
    let (fw, fh) = full;
    let near_square = |a: u32, b: u32| {
        let (lo, hi) = if a < b { (a, b) } else { (b, a) };
        f64::from(hi) <= f64::from(lo) * 1.05
    };
    if near_square(pw, ph) || near_square(fw, fh) {
        return false;
    }
    (pw > ph) != (fw > fh)
}

/// 组装最终结果:算比例、定方向。
fn finish(realized: Realized, full: Option<(u32, u32)>, raw_orientation: u16) -> EmbeddedPreview {
    let (jpeg, width, height, source) = realized;
    let orientation = match full {
        Some(f) if preview_already_upright(width, height, f, raw_orientation) => 1,
        _ => raw_orientation,
    };
    EmbeddedPreview {
        jpeg,
        width,
        height,
        fraction_of_full: fraction_of(width, height, full),
        full_size: full,
        orientation,
        source,
    }
}

fn clamp_orientation(v: Option<u64>) -> u16 {
    match v {
        Some(v) if (1..=8).contains(&v) => v as u16,
        _ => 1,
    }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/// 从 RAW 里取出相机内嵌的 JPEG 预览。
///
/// 成功返回的一定是一张**校验过的完整 JPEG**,宽高是实测值。
/// 调用方在把它当成「原图」交给用户之前,必须看
/// [`EmbeddedPreview::adequacy`] / [`EmbeddedPreview::warning`]。
pub fn extract_embedded_preview(abs: &Path) -> Result<EmbeddedPreview, RawError> {
    let ext = extension_of(&abs.to_string_lossy());
    if !RAW_EXTENSIONS.contains(&ext.as_str()) {
        return Err(RawError::NotRaw { ext });
    }
    // 「尚未支持」在开文件之前就短路:这类错误和文件里有什么无关,
    // 而且这样一来下面的 match 就没有 unreachable 分支——本模块实现段
    // 因此一个 `unwrap`/`expect`/`panic!`/`unreachable!` 都不剩,
    // 「喂任意存储卡内容都不 panic」是结构上的性质,不是论证出来的。
    let container = match container_for(&ext) {
        Container::Unsupported(reason) => {
            return Err(RawError::UnsupportedFormat {
                ext,
                reason: reason.to_string(),
            })
        }
        other => other,
    };
    let mut src = FileSource::open(abs).map_err(|e| RawError::Io {
        path: abs.display().to_string(),
        kind: e.kind(),
        detail: e.to_string(),
    })?;
    match container {
        Container::Cr3 => extract_cr3(&mut src, &ext),
        Container::Raf => extract_raf(&mut src, &ext),
        // Unsupported 已在上面短路,剩下的一律走 TIFF/IFD 路线
        _ => extract_tiff(&mut src, &ext),
    }
}

// ---------------------------------------------------------------------------
// TIFF/IFD 系:DNG / NEF / ARW / CR2 / ORF / RW2 / PEF / SRW …
// ---------------------------------------------------------------------------

/// 经典 TIFF 头:字节序(II/MM)+ 魔数 + 首个 IFD 偏移。
///
/// 魔数各家有变体,都是**规范里写死的常量**,不是猜:
/// - 42(0x2A):标准 TIFF,DNG/NEF/ARW/CR2/PEF/SRW… 都用它
/// - 85(0x55):Panasonic RW2
/// - 0x4F52 / 0x5352:Olympus ORF(文件头是 "IIRO" / "IIRS")
/// - 43(0x2B):BigTIFF——结构不同(8 字节偏移),本模块不支持,点名报错
fn extract_tiff(src: &mut FileSource, ext: &str) -> Result<EmbeddedPreview, RawError> {
    let head = src.meta(0, 8).map_err(|e| RawError::Corrupt {
        ext: ext.to_string(),
        detail: format!("读不到 TIFF 文件头:{e}"),
    })?;
    let endian = match &head[0..2] {
        b"II" => Endian::Little,
        b"MM" => Endian::Big,
        other => {
            return Err(RawError::Corrupt {
                ext: ext.to_string(),
                detail: format!(
                    "文件头不是 TIFF 的字节序标记 II/MM(读到 {:02X}{:02X})",
                    other[0], other[1]
                ),
            })
        }
    };
    let magic = rd_u16(endian, &head, 2).unwrap_or(0);
    if magic == 43 {
        return Err(RawError::UnsupportedFormat {
            ext: ext.to_string(),
            reason: "这是 BigTIFF 变体(魔数 43,偏移为 8 字节),结构与经典 TIFF 不同".to_string(),
        });
    }
    let is_rw2 = magic == 85;
    if !matches!(magic, 42 | 85 | 0x4F52 | 0x5352) {
        return Err(RawError::UnsupportedFormat {
            ext: ext.to_string(),
            reason: format!("TIFF 魔数 {magic} 不是本模块认识的任何一种 RAW 变体"),
        });
    }
    let first = u64::from(rd_u32(endian, &head, 4).unwrap_or(0));
    let ifds = walk_ifds(endian, src, first);
    if ifds.is_empty() {
        return Err(RawError::Corrupt {
            ext: ext.to_string(),
            detail: "首个 IFD 读不出来(偏移越界或条目数非法)".to_string(),
        });
    }

    let mut cands = Vec::new();
    for ifd in &ifds {
        cands.extend(candidates_in_ifd(endian, src, ifd, is_rw2));
    }
    if cands.is_empty() {
        return Err(RawError::NoPreview {
            ext: ext.to_string(),
            examined: ifds.len(),
        });
    }
    let realized = realize_best(src, &cands).map_err(|detail| RawError::Corrupt {
        ext: ext.to_string(),
        detail: format!(
            "{} 处标签声明了内嵌预览,但没有一处能取出完整 JPEG:{detail}",
            cands.len()
        ),
    })?;

    let full = full_size_from_ifds(endian, src, &ifds, is_rw2);
    // Orientation 以 IFD0 为准(TIFF 里 0x0112 描述的是主图像的摆放)
    let orientation = clamp_orientation(tag_uint(endian, src, &ifds[0], T_ORIENTATION));
    Ok(finish(realized, full, orientation))
}

// ---------------------------------------------------------------------------
// Canon CR3:ISO base media file format(ISO/IEC 14496-12)
// ---------------------------------------------------------------------------

/// Canon 在 CR3 的 `moov` 里放元数据用的 uuid(exiftool `Canon.pm` 记录的常量)。
/// 它下面挂 CMT1(IFD0 风格的 EXIF)、CMT2(ExifIFD)、CMT3/CMT4、THMB。
const CANON_META_UUID: [u8; 16] = [
    0x85, 0xc0, 0xb6, 0x87, 0x82, 0x0f, 0x11, 0xe0, 0x81, 0x11, 0xf4, 0xce, 0x46, 0x2b, 0x6a, 0x48,
];

struct BmffBox {
    kind: [u8; 4],
    payload_off: u64,
    payload_len: u64,
}

/// 读 `[start, end)` 区间里的同级盒子。
///
/// 盒子头:`u32 size` + `u32 type`;`size == 1` 时后跟 `u64 largesize`;
/// `size == 0` 表示「一直到容器结尾」。所有长度都对着 `end` 做边界检查,
/// `budget` 限制总盒子数(挡住被构造成几百万个空盒子的文件)。
fn read_boxes(src: &mut dyn ByteSource, start: u64, end: u64, budget: &mut usize) -> Vec<BmffBox> {
    let mut out = Vec::new();
    let mut off = start;
    while off + 8 <= end {
        if *budget == 0 {
            break;
        }
        *budget -= 1;
        let Ok(head) = src.meta(off, 8) else { break };
        let size32 = be_u32(&head, 0).unwrap_or(0);
        let mut kind = [0u8; 4];
        kind.copy_from_slice(&head[4..8]);
        let (header_len, size) = match size32 {
            1 => {
                let Ok(ext) = src.meta(off + 8, 8) else { break };
                let Some(large) = be_u64(&ext, 0) else { break };
                (16u64, large)
            }
            0 => (8u64, end - off),
            n => (8u64, u64::from(n)),
        };
        if size < header_len || off.checked_add(size).is_none_or(|e| e > end) {
            break;
        }
        out.push(BmffBox {
            kind,
            payload_off: off + header_len,
            payload_len: size - header_len,
        });
        off += size;
    }
    out
}

fn find_box<'a>(boxes: &'a [BmffBox], kind: &[u8; 4]) -> Option<&'a BmffBox> {
    boxes.iter().find(|b| &b.kind == kind)
}

/// 在 `stbl` 里取「第一个样本」的位置与大小。
///
/// - `stsz`:version/flags(4)+ sample_size(4)+ sample_count(4);
///   sample_size 非 0 表示所有样本等长,否则后面跟 sample_count 个 u32 表。
/// - `stco` / `co64`:version/flags(4)+ entry_count(4)+ 各 chunk 的偏移
///   (`stco` 为 u32,`co64` 为 u64)。
///
/// CR3 里存 JPEG 预览的轨道只有一个样本、一个 chunk,所以「首 chunk 偏移 +
/// 首样本大小」就是那张 JPEG 的确切范围。这是结构性定位,不是扫描。
fn stbl_first_sample(src: &mut dyn ByteSource, stbl: &[BmffBox]) -> Option<(u64, usize)> {
    let stsz = find_box(stbl, b"stsz")?;
    let head = src.meta(stsz.payload_off, 12).ok()?;
    let sample_size = be_u32(&head, 4)?;
    let sample_count = be_u32(&head, 8)?;
    if sample_count == 0 {
        return None;
    }
    let size = if sample_size != 0 {
        sample_size
    } else {
        let tbl = src.meta(stsz.payload_off + 12, 4).ok()?;
        be_u32(&tbl, 0)?
    };
    if size == 0 {
        return None;
    }

    let (co_box, wide) = match find_box(stbl, b"stco") {
        Some(b) => (b, false),
        None => (find_box(stbl, b"co64")?, true),
    };
    let n = if wide { 8usize } else { 4 };
    let head = src.meta(co_box.payload_off, 8).ok()?;
    if be_u32(&head, 4)? == 0 {
        return None;
    }
    let first = src.meta(co_box.payload_off + 8, n).ok()?;
    let off = if wide {
        be_u64(&first, 0)?
    } else {
        u64::from(be_u32(&first, 0)?)
    };
    Some((off, size as usize))
}

/// `stsd` 里第一个 sample entry 声明的宽高。
///
/// VisualSampleEntry 的布局(ISO/IEC 14496-12):盒子头 8 字节,
/// 之后 reserved[6] + data_reference_index(2) = 8,
/// pre_defined(2) + reserved(2) + pre_defined[3](12) = 16,
/// 于是 `width` 在盒子起点 +32、`height` 在 +34,均为大端 u16。
fn stsd_dimensions(src: &mut dyn ByteSource, stbl: &[BmffBox]) -> Option<(u32, u32)> {
    let stsd = find_box(stbl, b"stsd")?;
    // stsd 自身:version/flags(4)+ entry_count(4),之后才是 sample entry 盒子
    let entries = read_boxes(
        src,
        stsd.payload_off + 8,
        stsd.payload_off + stsd.payload_len,
        &mut 8,
    );
    let first = entries.first()?;
    // first.payload_off 已经跳过了 8 字节盒子头,所以 width 在 payload +24
    let b = src.meta(first.payload_off + 24, 4).ok()?;
    let w = u64::from(be_u16(&b, 0)?);
    let h = u64::from(be_u16(&b, 2)?);
    as_size(w, h)
}

/// 走 trak → mdia → minf → stbl。
fn trak_stbl(src: &mut dyn ByteSource, trak: &BmffBox, budget: &mut usize) -> Option<Vec<BmffBox>> {
    let end = trak.payload_off + trak.payload_len;
    let mdia = {
        let boxes = read_boxes(src, trak.payload_off, end, budget);
        let b = find_box(&boxes, b"mdia")?;
        (b.payload_off, b.payload_off + b.payload_len)
    };
    let minf = {
        let boxes = read_boxes(src, mdia.0, mdia.1, budget);
        let b = find_box(&boxes, b"minf")?;
        (b.payload_off, b.payload_off + b.payload_len)
    };
    let stbl = {
        let boxes = read_boxes(src, minf.0, minf.1, budget);
        let b = find_box(&boxes, b"stbl")?;
        (b.payload_off, b.payload_off + b.payload_len)
    };
    Some(read_boxes(src, stbl.0, stbl.1, budget))
}

/// CR3 的 `THMB` 盒子:version/flags(4)+ width(2)+ height(2)+ 长度(4)
/// 加未知(4),之后才是 JPEG 数据。只按这个布局取,取不到就放弃这个候选;
/// 它本来也只是 160×120 级的缩略图,判不了虚实,真正有用的是轨道里那张。
const THMB_JPEG_OFFSET: u64 = 16;

fn extract_cr3(src: &mut FileSource, ext: &str) -> Result<EmbeddedPreview, RawError> {
    let size = src.size();
    let mut budget = MAX_BMFF_BOXES;
    let top = read_boxes(src, 0, size, &mut budget);
    if find_box(&top, b"ftyp").is_none() {
        return Err(RawError::Corrupt {
            ext: ext.to_string(),
            detail: "文件开头没有 ISO-BMFF 的 ftyp 盒子,不是有效的 CR3 容器".to_string(),
        });
    }
    let Some(moov) = find_box(&top, b"moov") else {
        return Err(RawError::Corrupt {
            ext: ext.to_string(),
            detail: "找不到 moov 盒子,CR3 的元数据与预览轨道都在它里面".to_string(),
        });
    };
    let moov_end = moov.payload_off + moov.payload_len;
    let moov_children = read_boxes(src, moov.payload_off, moov_end, &mut budget);

    // ---- Canon uuid 里的 CMT1(方向)、CMT2(原始尺寸)、THMB(缩略图) ----
    let mut orientation = 1u16;
    let mut full: Option<(u32, u32)> = None;
    let mut cands: Vec<Candidate> = Vec::new();
    let mut examined = 0usize;

    for b in moov_children.iter().filter(|b| &b.kind == b"uuid") {
        let Ok(id) = src.meta(b.payload_off, 16) else {
            continue;
        };
        if id != CANON_META_UUID {
            continue;
        }
        let kids = read_boxes(
            src,
            b.payload_off + 16,
            b.payload_off + b.payload_len,
            &mut budget,
        );
        for kid in &kids {
            match &kid.kind {
                b"CMT1" | b"CMT2" => {
                    let Ok(blob) = src.meta(
                        kid.payload_off,
                        usize::try_from(kid.payload_len).unwrap_or(usize::MAX),
                    ) else {
                        continue;
                    };
                    // CMT1/CMT2 的内容是一段完整的 TIFF(自带 II*\0 头)
                    let mut mem = SliceSource { data: &blob };
                    let Ok(h) = mem.meta(0, 8) else { continue };
                    let e = match &h[0..2] {
                        b"II" => Endian::Little,
                        b"MM" => Endian::Big,
                        _ => continue,
                    };
                    let first = u64::from(rd_u32(e, &h, 4).unwrap_or(0));
                    let ifds = walk_ifds(e, &mut mem, first);
                    if kid.kind == *b"CMT1" {
                        if let Some(ifd0) = ifds.first() {
                            orientation =
                                clamp_orientation(tag_uint(e, &mut mem, ifd0, T_ORIENTATION));
                        }
                    } else if full.is_none() {
                        // CMT2 是 ExifIFD 的内容,PixelXDimension/PixelYDimension
                        // 在这里就是主图像(即 RAW 输出)的尺寸
                        for ifd in &ifds {
                            let w = tag_uint(e, &mut mem, ifd, T_PIXEL_X_DIM);
                            let h2 = tag_uint(e, &mut mem, ifd, T_PIXEL_Y_DIM);
                            if let (Some(w), Some(h2)) = (w, h2) {
                                full = as_size(w, h2);
                                if full.is_some() {
                                    break;
                                }
                            }
                        }
                    }
                }
                b"THMB" => {
                    examined += 1;
                    if kid.payload_len > THMB_JPEG_OFFSET {
                        let len = kid.payload_len - THMB_JPEG_OFFSET;
                        if let Ok(len) = usize::try_from(len) {
                            cands.push(Candidate {
                                off: kid.payload_off + THMB_JPEG_OFFSET,
                                len,
                                source: SRC_CR3_THMB,
                            });
                        }
                    }
                }
                _ => {}
            }
        }
    }

    // ---- 各条轨道的首个样本 ----
    // CR3 通常有 4 条轨道:预览 JPEG、小尺寸预览、CRAW 原始数据、CTMD 元数据。
    // 原始数据与元数据轨道的样本不是 JPEG,三道校验闸会把它们挡掉;
    // 这里不按格式码筛选,是因为 Canon 给预览轨道也标了 'CRAW',
    // 按格式码筛反而会误伤。「首样本 + 校验」比「猜哪条轨道」可靠。
    let mut trak_dims: Option<(u32, u32)> = None;
    for trak in moov_children.iter().filter(|b| &b.kind == b"trak") {
        let Some(stbl) = trak_stbl(src, trak, &mut budget) else {
            continue;
        };
        examined += 1;
        if let Some((w, h)) = stsd_dimensions(src, &stbl) {
            let better = trak_dims
                .is_none_or(|(bw, bh)| u64::from(w) * u64::from(h) > u64::from(bw) * u64::from(bh));
            if better {
                trak_dims = Some((w, h));
            }
        }
        if let Some((off, len)) = stbl_first_sample(src, &stbl) {
            cands.push(Candidate {
                off,
                len,
                source: SRC_CR3_TRAK,
            });
        }
    }

    // CMT2 拿不到就退回轨道声明的最大尺寸(CRAW 轨道的 VisualSampleEntry
    // 写的是感光尺寸);两者都没有就诚实地返回 None。
    let full = full.or(trak_dims);

    if cands.is_empty() {
        return Err(RawError::NoPreview {
            ext: ext.to_string(),
            examined,
        });
    }
    let n = cands.len();
    let realized = realize_best(src, &cands).map_err(|detail| RawError::Corrupt {
        ext: ext.to_string(),
        detail: format!("{n} 处结构声明了内嵌图像,但没有一处能取出完整 JPEG:{detail}"),
    })?;
    Ok(finish(realized, full, orientation))
}

// ---------------------------------------------------------------------------
// Fujifilm RAF
// ---------------------------------------------------------------------------

/// RAF 头部布局(Fujifilm 自有,exiftool `FujiFilm.pm` 与多份公开逆向文档一致):
/// ```text
/// 0x00  16B  魔数 "FUJIFILMCCD-RAW "
/// 0x10   4B  格式版本
/// 0x14   8B  相机编号
/// 0x1C  32B  相机型号字符串
/// 0x3C   4B  目录版本
/// 0x40  20B  未知
/// 0x54   4B  JPEG 图像偏移   (大端)
/// 0x58   4B  JPEG 图像长度   (大端)
/// 0x5C   4B  CFA 头偏移      (大端)
/// 0x60   4B  CFA 头长度      (大端)
/// ```
/// RAF 里所有多字节整数都是大端。0x54/0x58 指向的是相机机内渲染的
/// **全尺寸 JPEG**(自带 EXIF),这是 RAF 唯一的预览入口,确定性最高。
const RAF_MAGIC: &[u8; 16] = b"FUJIFILMCCD-RAW ";
const RAF_JPEG_OFF: usize = 0x54;
const RAF_JPEG_LEN: usize = 0x58;
const RAF_CFA_HDR_OFF: usize = 0x5C;
const RAF_CFA_HDR_LEN: usize = 0x60;
/// CFA 目录里的 `RawImageFullSize`:2 个大端 u16,顺序是(高,宽)。
const RAF_TAG_FULL_SIZE: u16 = 0x0100;
const RAF_MAX_CFA_ENTRIES: usize = 256;

fn extract_raf(src: &mut FileSource, ext: &str) -> Result<EmbeddedPreview, RawError> {
    let head = src.meta(0, 0x64 + 4).map_err(|e| RawError::Corrupt {
        ext: ext.to_string(),
        detail: format!("读不到 RAF 头部:{e}"),
    })?;
    if &head[0..16] != RAF_MAGIC {
        return Err(RawError::Corrupt {
            ext: ext.to_string(),
            detail: "文件开头不是 RAF 魔数 \"FUJIFILMCCD-RAW \"".to_string(),
        });
    }
    let jpeg_off = be_u32(&head, RAF_JPEG_OFF).unwrap_or(0);
    let jpeg_len = be_u32(&head, RAF_JPEG_LEN).unwrap_or(0);
    if jpeg_off == 0 || jpeg_len == 0 {
        return Err(RawError::NoPreview {
            ext: ext.to_string(),
            examined: 1,
        });
    }
    let cands = [Candidate {
        off: u64::from(jpeg_off),
        len: jpeg_len as usize,
        source: SRC_RAF_HEADER,
    }];
    let realized = realize_best(src, &cands).map_err(|detail| RawError::Corrupt {
        ext: ext.to_string(),
        detail: format!("RAF 头部声明的 JPEG 取不出来:{detail}"),
    })?;

    let full = raf_full_size(
        src,
        be_u32(&head, RAF_CFA_HDR_OFF).unwrap_or(0),
        be_u32(&head, RAF_CFA_HDR_LEN).unwrap_or(0),
    );
    // RAF 的内嵌 JPEG 自带完整 EXIF,方向以它自己写的为准
    let orientation = clamp_orientation(jpeg_exif_orientation(&realized.0).map(u64::from));
    Ok(finish(realized, full, orientation))
}

/// 解析 RAF 的 CFA 目录,取 `RawImageFullSize`。
///
/// 目录布局:`u32 条目数`,之后每条 `u16 tag + u16 size + size 字节数据`。
/// 取不到就返回 None——`fraction_of_full` 会诚实地变成 None,而不是编一个值。
fn raf_full_size(src: &mut dyn ByteSource, hdr_off: u32, hdr_len: u32) -> Option<(u32, u32)> {
    if hdr_off == 0 || hdr_len < 4 {
        return None;
    }
    let blob = src
        .meta(u64::from(hdr_off), usize::try_from(hdr_len).ok()?)
        .ok()?;
    let count = (be_u32(&blob, 0)? as usize).min(RAF_MAX_CFA_ENTRIES);
    let mut at = 4usize;
    for _ in 0..count {
        let tag = be_u16(&blob, at)?;
        let size = be_u16(&blob, at + 2)? as usize;
        let data_at = at + 4;
        if tag == RAF_TAG_FULL_SIZE && size >= 4 {
            let h = u64::from(be_u16(&blob, data_at)?);
            let w = u64::from(be_u16(&blob, data_at + 2)?);
            return as_size(w, h);
        }
        at = data_at.checked_add(size)?;
        if at > blob.len() {
            return None;
        }
    }
    None
}

/// 读一段 JPEG 字节自带的 EXIF Orientation。
fn jpeg_exif_orientation(jpeg: &[u8]) -> Option<u16> {
    let mut cursor = std::io::Cursor::new(jpeg);
    let meta = exif::Reader::new().read_from_container(&mut cursor).ok()?;
    let v = meta
        .get_field(exif::Tag::Orientation, exif::In::PRIMARY)?
        .value
        .get_uint(0)?;
    if (1..=8).contains(&v) {
        Some(v as u16)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------
//
// ## 样本来源与局限(必须先读这一段)
//
// **这里没有一张真机 RAW。** 本机与仓库都搜过(`find` 全盘 + Spotlight 按
// `public.camera-raw-image` 查),一张 CR3/ARW/NEF/RAF/DNG 都没有;也没有
// exiftool / dcraw 可以拿来交叉验证。所以下面全部是**按各格式公开规范手工
// 合成的最小容器**:TIFF/IFD 结构、Panasonic RW2 的 0x0055 魔数、Canon CR3
// 的 ISO-BMFF 盒子树、Fujifilm RAF 的固定头部,偏移全部真算,JPEG 全部是
// `image` 真编出来的。
//
// 合成样本**能**证明的:标签与偏移语义解读得对不对、单条带/CFA/多条带那几道
// 闸有没有生效、边界检查会不会被越界与超大长度打穿、错误落在不落在正确的分类。
//
// 合成样本**不能**证明的:真实机身在真实文件里究竟把预览写在哪一支
// (某台机身的全尺寸 JPEG 在 SubIFD 的第几个、ORF 实际用的是 0x4F52 还是
// 0x5352、CR3 的第几条轨道是预览而不是原始数据)。这些只能靠真机样张回归。
// **接线前请务必用真 RAW 各跑一遍**,CR3 与 ARW/ORF 尤其要看——这两处是本
// 模块最依赖公开逆向文档、最可能与真实文件有出入的地方。
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // ---------------------- 合成样本工具 ----------------------

    /// 一张真 JPEG(带纹理,免得被编码器压成退化码流)。
    fn jpeg_of(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbImage::from_fn(w, h, |x, y| {
            image::Rgb([(x % 251) as u8, (y % 241) as u8, ((x ^ y) % 233) as u8])
        });
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(
                &mut std::io::Cursor::new(&mut out),
                image::ImageFormat::Jpeg,
            )
            .unwrap();
        out
    }

    /// 给一段 JPEG 拼上带 Orientation 的 APP1(与 `analysis_cmds.rs` 的
    /// 样张生成同一手法)。
    fn with_exif_orientation(jpeg: &[u8], orientation: u16) -> Vec<u8> {
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
        out
    }

    /// 一条 IFD 记录的值。
    #[derive(Clone)]
    enum TD {
        /// 整数值(按类型宽度写)
        Uints(Vec<u32>),
        /// 原样字节(类型宽度必须是 1)
        Bytes(Vec<u8>),
        /// 指向第 i 个 IFD 的偏移
        IfdRefs(Vec<usize>),
        /// 第 i 个 blob 的偏移 / 字节数
        BlobOff(usize),
        BlobLen(usize),
        /// 写死的 u32——用来构造越界偏移与超大长度
        RawU32(u32),
    }

    struct T {
        tag: u16,
        ty: u16,
        data: TD,
    }

    fn t(tag: u16, ty: u16, data: TD) -> T {
        T { tag, ty, data }
    }
    /// SHORT(类型 3)
    fn sh(tag: u16, v: u32) -> T {
        t(tag, 3, TD::Uints(vec![v]))
    }
    /// LONG(类型 4)
    fn lo(tag: u16, v: u32) -> T {
        t(tag, 4, TD::Uints(vec![v]))
    }

    struct IfdSpec {
        tags: Vec<T>,
        /// IFD 链的下一环(索引);None 表示链到此为止
        next: Option<usize>,
    }

    fn ifd(tags: Vec<T>) -> IfdSpec {
        IfdSpec { tags, next: None }
    }

    fn ty_w(ty: u16) -> usize {
        match ty {
            1 | 2 | 6 | 7 => 1,
            3 | 8 => 2,
            5 | 10 | 12 => 8,
            _ => 4,
        }
    }

    fn count_of(d: &TD) -> u32 {
        match d {
            TD::Uints(v) => v.len() as u32,
            TD::Bytes(b) => b.len() as u32,
            TD::IfdRefs(v) => v.len() as u32,
            TD::BlobOff(_) | TD::BlobLen(_) | TD::RawU32(_) => 1,
        }
    }

    /// 手工合成经典 TIFF 容器。
    ///
    /// 布局:8 字节头 → 各 IFD 依次排开 → 超过 4 字节的值区(堆)→ 各 blob。
    /// 所有偏移都真算,没有占位符——这样测试里的越界/损坏就只能来自我们
    /// **故意**写坏的那个字段,不会是构造器自己的 bug。
    fn build_tiff(le: bool, magic: u16, ifds: &[IfdSpec], blobs: &[Vec<u8>]) -> Vec<u8> {
        let enc16 = |v: u16| {
            if le {
                v.to_le_bytes()
            } else {
                v.to_be_bytes()
            }
        };
        let enc32 = |v: u32| {
            if le {
                v.to_le_bytes()
            } else {
                v.to_be_bytes()
            }
        };

        let mut ifd_off = Vec::new();
        let mut at = 8u32;
        for s in ifds {
            ifd_off.push(at);
            at += 2 + 12 * s.tags.len() as u32 + 4;
        }
        let mut val_off: Vec<Vec<u32>> = Vec::new();
        for s in ifds {
            let mut row = Vec::new();
            for tg in &s.tags {
                let len = count_of(&tg.data) as usize * ty_w(tg.ty);
                if len > 4 {
                    row.push(at);
                    at += len as u32;
                    at += at % 2;
                } else {
                    row.push(0);
                }
            }
            val_off.push(row);
        }
        let mut blob_off = Vec::new();
        for b in blobs {
            at += at % 2;
            blob_off.push(at);
            at += b.len() as u32;
        }

        let mut out = vec![0u8; at as usize];
        out[0..2].copy_from_slice(if le { b"II" } else { b"MM" });
        out[2..4].copy_from_slice(&enc16(magic));
        let first = if ifds.is_empty() { 0 } else { ifd_off[0] };
        out[4..8].copy_from_slice(&enc32(first));

        for (i, s) in ifds.iter().enumerate() {
            let base = ifd_off[i] as usize;
            out[base..base + 2].copy_from_slice(&enc16(s.tags.len() as u16));
            for (j, tg) in s.tags.iter().enumerate() {
                let e = base + 2 + j * 12;
                out[e..e + 2].copy_from_slice(&enc16(tg.tag));
                out[e + 2..e + 4].copy_from_slice(&enc16(tg.ty));
                out[e + 4..e + 8].copy_from_slice(&enc32(count_of(&tg.data)));
                let bytes: Vec<u8> = match &tg.data {
                    TD::Uints(v) => v
                        .iter()
                        .flat_map(|&x| match ty_w(tg.ty) {
                            1 => vec![x as u8],
                            2 => enc16(x as u16).to_vec(),
                            _ => enc32(x).to_vec(),
                        })
                        .collect(),
                    TD::Bytes(b) => b.clone(),
                    TD::IfdRefs(v) => v.iter().flat_map(|&k| enc32(ifd_off[k]).to_vec()).collect(),
                    TD::BlobOff(k) => enc32(blob_off[*k]).to_vec(),
                    TD::BlobLen(k) => enc32(blobs[*k].len() as u32).to_vec(),
                    TD::RawU32(v) => enc32(*v).to_vec(),
                };
                if bytes.len() <= 4 {
                    out[e + 8..e + 8 + bytes.len()].copy_from_slice(&bytes);
                } else {
                    let o = val_off[i][j] as usize;
                    out[e + 8..e + 12].copy_from_slice(&enc32(val_off[i][j]));
                    out[o..o + bytes.len()].copy_from_slice(&bytes);
                }
            }
            let nx = base + 2 + s.tags.len() * 12;
            let next = s.next.map(|k| ifd_off[k]).unwrap_or(0);
            out[nx..nx + 4].copy_from_slice(&enc32(next));
        }
        for (k, b) in blobs.iter().enumerate() {
            let o = blob_off[k] as usize;
            out[o..o + b.len()].copy_from_slice(b);
        }
        out
    }

    fn write_tmp(dir: &tempfile::TempDir, name: &str, data: &[u8]) -> PathBuf {
        let p = dir.path().join(name);
        std::fs::write(&p, data).unwrap();
        p
    }

    /// 一个「DNG/TIFF-EP 风格」的三 IFD 容器:
    /// IFD0 = 160×120 缩略图 + SubIFDs 指针,SubIFD#1 = 单条带 JPEG 预览,
    /// SubIFD#2 = 原始 CFA(PhotometricInterpretation=32803)。
    fn dng_like_with_thumb(
        thumb: Vec<u8>,
        preview: (Vec<u8>, u32, u32),
        cfa: (Vec<u8>, u32, u32),
        orientation: u32,
    ) -> Vec<u8> {
        let (pj, pw, ph) = preview;
        let (cj, cw, ch) = cfa;
        build_tiff(
            true,
            42,
            &[
                ifd(vec![
                    lo(T_NEW_SUBFILE_TYPE, 1),
                    sh(T_IMAGE_WIDTH, 160),
                    sh(T_IMAGE_LENGTH, 120),
                    sh(T_ORIENTATION, orientation),
                    t(T_JPEG_IF, 4, TD::BlobOff(0)),
                    t(T_JPEG_IF_LEN, 4, TD::BlobLen(0)),
                    t(T_SUB_IFDS, 4, TD::IfdRefs(vec![1, 2])),
                ]),
                ifd(vec![
                    lo(T_NEW_SUBFILE_TYPE, 1),
                    sh(T_IMAGE_WIDTH, pw),
                    sh(T_IMAGE_LENGTH, ph),
                    sh(T_COMPRESSION, 7),
                    sh(T_PHOTOMETRIC, 6),
                    t(T_STRIP_OFFSETS, 4, TD::BlobOff(1)),
                    t(T_STRIP_BYTE_COUNTS, 4, TD::BlobLen(1)),
                ]),
                ifd(vec![
                    lo(T_NEW_SUBFILE_TYPE, 0),
                    sh(T_IMAGE_WIDTH, cw),
                    sh(T_IMAGE_LENGTH, ch),
                    sh(T_COMPRESSION, 7),
                    sh(T_PHOTOMETRIC, PHOTOMETRIC_CFA as u32),
                    t(T_STRIP_OFFSETS, 4, TD::BlobOff(2)),
                    t(T_STRIP_BYTE_COUNTS, 4, TD::BlobLen(2)),
                ]),
            ],
            &[thumb, pj, cj],
        )
    }

    // ---------------------- 扩展名 / 路由 ----------------------

    #[test]
    fn raw_extension_is_a_superset_of_media_classify() {
        // 应用把某个扩展名当 RAW、本模块却说「不是 RAW」,用户会拿到一句
        // 自相矛盾的提示。这里把包含关系钉死。
        for ext in ["arw", "cr2", "cr3", "nef", "raf", "orf", "rw2", "dng"] {
            let rel = format!("素材/DSC_0001.{ext}");
            assert_eq!(
                super::super::media::classify(&rel),
                super::super::media::AssetKind::Raw,
                "media::classify 不再把 .{ext} 当 RAW 了,两处必须同步"
            );
            assert!(is_raw_extension(&rel), ".{ext} 必须被认作 RAW");
        }
    }

    #[test]
    fn extension_detection_handles_paths_and_case() {
        assert!(is_raw_extension("a/b/IMG_1234.CR3"));
        assert!(is_raw_extension("IMG.cr3"));
        assert!(!is_raw_extension("a/b/IMG_1234.jpg"));
        assert!(!is_raw_extension("a.raw/noext"));
        assert!(!is_raw_extension("no_extension"));
        // 隐藏文件不是「扩展名为 cr3」
        assert!(!is_raw_extension(".cr3"));
    }

    #[test]
    fn non_raw_file_reports_not_raw() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write_tmp(&tmp, "a.jpg", &jpeg_of(64, 48));
        let err = extract_embedded_preview(&p).unwrap_err();
        assert!(matches!(err, RawError::NotRaw { .. }), "{err:?}");
        assert!(err.to_string().contains("jpg"), "文案要点名扩展名:{err}");
    }

    #[test]
    fn known_but_unimplemented_containers_are_named() {
        let tmp = tempfile::tempdir().unwrap();
        for (ext, needle) in [("crw", "CIFF"), ("mrw", "Minolta"), ("x3f", "FOVb")] {
            let p = write_tmp(&tmp, &format!("a.{ext}"), b"whatever");
            let err = extract_embedded_preview(&p).unwrap_err();
            assert!(
                matches!(err, RawError::UnsupportedFormat { .. }),
                ".{ext} 应报 UnsupportedFormat,实得 {err:?}"
            );
            let msg = err.to_string();
            assert!(msg.contains(ext), "文案要点名扩展名:{msg}");
            assert!(msg.contains(needle), "文案要说清是哪种容器:{msg}");
        }
    }

    #[test]
    fn missing_file_is_io_and_flags_source_gone() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("gone.dng");
        let err = extract_embedded_preview(&p).unwrap_err();
        assert!(matches!(err, RawError::Io { .. }), "{err:?}");
        assert!(err.is_source_gone());
        assert!(err.to_string().contains("已不在原处"), "{err}");
    }

    // ---------------------- TIFF/IFD:正常取出 ----------------------

    /// 全尺寸预览必须从 **SubIFD 的单条带 JPEG** 取,而不是 IFD0 的 160×120
    /// 缩略图,也**绝不能**是标着 PhotometricInterpretation=CFA 的那一支。
    ///
    /// CFA 那支里故意放了一张**更大**的 JPEG(1400×900):如果 CFA 闸失效,
    /// 「挑最大」就会挑中它,断言立刻变红。真实文件里那一支是无损 JPEG 压缩的
    /// 原始马赛克数据,取出来就是给用户看另一张图。
    #[test]
    fn dng_style_takes_tagged_full_size_preview_never_the_cfa_strip() {
        let tmp = tempfile::tempdir().unwrap();
        let data = dng_like_with_thumb(
            jpeg_of(160, 120),
            (jpeg_of(1280, 854), 1280, 854),
            (jpeg_of(1400, 900), 1280, 854),
            1,
        );
        let p = write_tmp(&tmp, "a.dng", &data);
        let pv = extract_embedded_preview(&p).unwrap();

        assert_eq!((pv.width, pv.height), (1280, 854), "取错了那一支");
        assert_eq!(pv.source, SRC_TIFF_STRIP_JPEG);
        assert_eq!(pv.full_size, Some((1280, 854)));
        assert!((pv.fraction_of_full.unwrap() - 1.0).abs() < 0.01);
        assert_eq!(pv.adequacy(), PreviewAdequacy::FullSize);
        assert!(
            pv.warning().is_none(),
            "全尺寸不该有告警:{:?}",
            pv.warning()
        );
        assert_eq!(pv.orientation, 1);
        // 交回的必须是真能解开的完整 JPEG,而不是一段看着像 JPEG 的字节
        let img = image::load_from_memory(&pv.jpeg).unwrap();
        assert_eq!((img.width(), img.height()), (1280, 854));
    }

    /// 只有缩略级预览时必须**判别得出来**并给出告警——这是本模块最要紧的一条:
    /// 把 160×120 当全尺寸交上去,只是换个方式继续骗用户。
    #[test]
    fn thumbnail_only_preview_is_flagged_not_passed_off_as_full() {
        let tmp = tempfile::tempdir().unwrap();
        let data = build_tiff(
            true,
            42,
            &[
                ifd(vec![
                    lo(T_NEW_SUBFILE_TYPE, 1),
                    sh(T_ORIENTATION, 1),
                    t(T_JPEG_IF, 4, TD::BlobOff(0)),
                    t(T_JPEG_IF_LEN, 4, TD::BlobLen(0)),
                    t(T_SUB_IFDS, 4, TD::IfdRefs(vec![1])),
                ]),
                ifd(vec![
                    lo(T_NEW_SUBFILE_TYPE, 0),
                    lo(T_IMAGE_WIDTH, 6000),
                    lo(T_IMAGE_LENGTH, 4000),
                    sh(T_COMPRESSION, 34713), // 厂商私有压缩,不是 JPEG
                    sh(T_PHOTOMETRIC, PHOTOMETRIC_CFA as u32),
                ]),
            ],
            &[jpeg_of(160, 120)],
        );
        let p = write_tmp(&tmp, "a.nef", &data);
        let pv = extract_embedded_preview(&p).unwrap();

        assert_eq!((pv.width, pv.height), (160, 120));
        assert_eq!(pv.source, SRC_TIFF_JPEG_IF);
        assert_eq!(pv.full_size, Some((6000, 4000)));
        let f = pv.fraction_of_full.unwrap();
        assert!((f - 160.0 / 6000.0).abs() < 0.001, "占比算错了:{f}");
        assert_eq!(pv.adequacy(), PreviewAdequacy::ThumbnailOnly);
        let w = pv.warning().expect("缩略级必须有告警");
        assert!(w.contains("判不了虚实"), "{w}");
        assert!(
            w.contains("160×120") && w.contains("6000×4000"),
            "告警要说出具体尺寸:{w}"
        );
    }

    /// 半幅预览要归到 Reduced,并明说「抠不了对焦」。
    #[test]
    fn half_size_preview_is_reported_as_reduced() {
        let tmp = tempfile::tempdir().unwrap();
        let data = build_tiff(
            true,
            42,
            &[
                ifd(vec![
                    lo(T_NEW_SUBFILE_TYPE, 1),
                    sh(T_COMPRESSION, 7),
                    sh(T_PHOTOMETRIC, 6),
                    sh(T_IMAGE_WIDTH, 1200),
                    sh(T_IMAGE_LENGTH, 800),
                    t(T_STRIP_OFFSETS, 4, TD::BlobOff(0)),
                    t(T_STRIP_BYTE_COUNTS, 4, TD::BlobLen(0)),
                    t(T_SUB_IFDS, 4, TD::IfdRefs(vec![1])),
                ]),
                ifd(vec![
                    lo(T_NEW_SUBFILE_TYPE, 0),
                    sh(T_IMAGE_WIDTH, 2400),
                    sh(T_IMAGE_LENGTH, 1600),
                ]),
            ],
            &[jpeg_of(1200, 800)],
        );
        let p = write_tmp(&tmp, "a.arw", &data);
        let pv = extract_embedded_preview(&p).unwrap();
        assert!((pv.fraction_of_full.unwrap() - 0.5).abs() < 0.01);
        assert_eq!(pv.adequacy(), PreviewAdequacy::Reduced);
        assert!(pv.warning().unwrap().contains("半幅"));
    }

    /// 大端(MM)TIFF 也要能读——老机型与部分 NEF 用大端。
    #[test]
    fn big_endian_tiff_is_parsed() {
        let tmp = tempfile::tempdir().unwrap();
        let data = build_tiff(
            false,
            42,
            &[ifd(vec![
                sh(T_ORIENTATION, 8),
                sh(T_IMAGE_WIDTH, 1280),
                sh(T_IMAGE_LENGTH, 854),
                t(T_JPEG_IF, 4, TD::BlobOff(0)),
                t(T_JPEG_IF_LEN, 4, TD::BlobLen(0)),
            ])],
            &[jpeg_of(1280, 854)],
        );
        let p = write_tmp(&tmp, "a.nef", &data);
        let pv = extract_embedded_preview(&p).unwrap();
        assert_eq!((pv.width, pv.height), (1280, 854));
        assert_eq!(pv.orientation, 8);
    }

    /// 拿不到原始尺寸时 `fraction_of_full` 必须是 None——不许编一个数。
    /// 标着「降分辨率」的 IFD,它自己的 ImageWidth 不许被当成原始尺寸。
    ///
    /// 这是本模块唯一会**高估**的方向:一张半幅预览若把自己的尺寸报成原图,
    /// fraction 就变成 1.0,告警消失,用户以为在看全分辨率——静默骗人。
    /// 这里宁可报「占比未知」并给出提示。
    #[test]
    fn reduced_resolution_ifd_dimensions_are_not_taken_as_full_size() {
        let tmp = tempfile::tempdir().unwrap();
        let data = build_tiff(
            true,
            42,
            &[ifd(vec![
                lo(T_NEW_SUBFILE_TYPE, 1), // 降分辨率
                sh(T_IMAGE_WIDTH, 1280),
                sh(T_IMAGE_LENGTH, 854),
                t(T_JPEG_IF, 4, TD::BlobOff(0)),
                t(T_JPEG_IF_LEN, 4, TD::BlobLen(0)),
            ])],
            &[jpeg_of(1280, 854)],
        );
        let p = write_tmp(&tmp, "a.dng", &data);
        let pv = extract_embedded_preview(&p).unwrap();
        assert_eq!(pv.full_size, None, "降分辨率 IFD 的尺寸不是原始尺寸");
        assert_eq!(pv.fraction_of_full, None);
        assert_eq!(pv.adequacy(), PreviewAdequacy::Unknown);
        assert!(pv.warning().is_some(), "占比未知也要给提示,不能静默");
    }

    #[test]
    fn unknown_full_size_reports_none_not_a_guess() {
        let tmp = tempfile::tempdir().unwrap();
        let data = build_tiff(
            true,
            42,
            &[ifd(vec![
                t(T_JPEG_IF, 4, TD::BlobOff(0)),
                t(T_JPEG_IF_LEN, 4, TD::BlobLen(0)),
            ])],
            &[jpeg_of(1280, 854)],
        );
        let p = write_tmp(&tmp, "a.pef", &data);
        let pv = extract_embedded_preview(&p).unwrap();
        assert_eq!(pv.fraction_of_full, None);
        assert_eq!(pv.full_size, None);
        assert_eq!(pv.adequacy(), PreviewAdequacy::Unknown);
        assert!(pv.warning().unwrap().contains("读不到"));
    }

    // ---------------------- TIFF/IFD:该拒的要拒 ----------------------

    /// 只有 CFA 那一支时,必须报「没有可用预览」,而不是把马赛克数据交出去。
    #[test]
    fn cfa_only_file_reports_no_preview() {
        let tmp = tempfile::tempdir().unwrap();
        let data = build_tiff(
            true,
            42,
            &[ifd(vec![
                lo(T_NEW_SUBFILE_TYPE, 0),
                sh(T_IMAGE_WIDTH, 1280),
                sh(T_IMAGE_LENGTH, 854),
                sh(T_COMPRESSION, 7),
                sh(T_PHOTOMETRIC, PHOTOMETRIC_CFA as u32),
                t(T_STRIP_OFFSETS, 4, TD::BlobOff(0)),
                t(T_STRIP_BYTE_COUNTS, 4, TD::BlobLen(0)),
            ])],
            &[jpeg_of(1280, 854)],
        );
        let p = write_tmp(&tmp, "a.dng", &data);
        let err = extract_embedded_preview(&p).unwrap_err();
        assert!(matches!(err, RawError::NoPreview { .. }), "{err:?}");
    }

    /// LinearRaw(34892)同样要拒。
    #[test]
    fn linear_raw_photometric_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let data = build_tiff(
            true,
            42,
            &[ifd(vec![
                sh(T_COMPRESSION, 7),
                sh(T_PHOTOMETRIC, PHOTOMETRIC_LINEAR_RAW as u32),
                t(T_STRIP_OFFSETS, 4, TD::BlobOff(0)),
                t(T_STRIP_BYTE_COUNTS, 4, TD::BlobLen(0)),
            ])],
            &[jpeg_of(1280, 854)],
        );
        let p = write_tmp(&tmp, "a.dng", &data);
        assert!(matches!(
            extract_embedded_preview(&p).unwrap_err(),
            RawError::NoPreview { .. }
        ));
    }

    /// 多条带的不取:那不是一张能直接交出去的完整 JPEG。
    #[test]
    fn multi_strip_jpeg_is_not_taken() {
        let tmp = tempfile::tempdir().unwrap();
        let jpeg = jpeg_of(1280, 854);
        let half = jpeg.len() as u32 / 2;
        let data = build_tiff(
            true,
            42,
            &[ifd(vec![
                sh(T_COMPRESSION, 7),
                sh(T_PHOTOMETRIC, 6),
                t(T_STRIP_OFFSETS, 4, TD::Uints(vec![0, half])),
                t(T_STRIP_BYTE_COUNTS, 4, TD::Uints(vec![half, half])),
            ])],
            &[jpeg],
        );
        let p = write_tmp(&tmp, "a.dng", &data);
        assert!(matches!(
            extract_embedded_preview(&p).unwrap_err(),
            RawError::NoPreview { .. }
        ));
    }

    /// 偏移指到文件外:必须报损坏,不能 panic,也不能返回垃圾。
    #[test]
    fn offset_past_eof_is_corrupt() {
        let tmp = tempfile::tempdir().unwrap();
        let data = build_tiff(
            true,
            42,
            &[ifd(vec![
                t(T_JPEG_IF, 4, TD::RawU32(9_000_000)),
                t(T_JPEG_IF_LEN, 4, TD::RawU32(4096)),
            ])],
            &[],
        );
        let p = write_tmp(&tmp, "a.dng", &data);
        let err = extract_embedded_preview(&p).unwrap_err();
        assert!(matches!(err, RawError::Corrupt { .. }), "{err:?}");
        assert!(err.to_string().contains("损坏"), "{err}");
    }

    /// 长度字段越界:同样报损坏,而且**不能**按它写的长度去分配内存。
    #[test]
    fn length_past_eof_is_corrupt_without_allocating() {
        let tmp = tempfile::tempdir().unwrap();
        let data = build_tiff(
            true,
            42,
            &[ifd(vec![
                t(T_JPEG_IF, 4, TD::BlobOff(0)),
                // 50MB:小于 MAX_PREVIEW_BYTES,所以只能靠「文件真实长度」这道闸拦住
                t(T_JPEG_IF_LEN, 4, TD::RawU32(50_000_000)),
            ])],
            &[jpeg_of(64, 48)],
        );
        let p = write_tmp(&tmp, "a.dng", &data);
        let err = extract_embedded_preview(&p).unwrap_err();
        assert!(matches!(err, RawError::Corrupt { .. }), "{err:?}");
        assert!(err.to_string().contains("越界"), "{err}");
    }

    /// 荒唐的长度(接近 4GB):在碰文件之前就被上限挡住。
    #[test]
    fn absurd_length_hits_the_cap_first() {
        let tmp = tempfile::tempdir().unwrap();
        let data = build_tiff(
            true,
            42,
            &[ifd(vec![
                t(T_JPEG_IF, 4, TD::BlobOff(0)),
                t(T_JPEG_IF_LEN, 4, TD::RawU32(0xFFFF_FFF0)),
            ])],
            &[jpeg_of(64, 48)],
        );
        let p = write_tmp(&tmp, "a.dng", &data);
        let err = extract_embedded_preview(&p).unwrap_err();
        assert!(matches!(err, RawError::Corrupt { .. }), "{err:?}");
        assert!(err.to_string().contains("上限"), "{err}");
    }

    /// 半截 JPEG(没有 EOI):报损坏,不许把半张图当图返回。
    #[test]
    fn truncated_jpeg_is_corrupt() {
        let tmp = tempfile::tempdir().unwrap();
        let mut jpeg = jpeg_of(1280, 854);
        jpeg.truncate(jpeg.len() - 2000);
        let data = build_tiff(
            true,
            42,
            &[ifd(vec![
                t(T_JPEG_IF, 4, TD::BlobOff(0)),
                t(T_JPEG_IF_LEN, 4, TD::BlobLen(0)),
            ])],
            &[jpeg],
        );
        let p = write_tmp(&tmp, "a.dng", &data);
        let err = extract_embedded_preview(&p).unwrap_err();
        assert!(matches!(err, RawError::Corrupt { .. }), "{err:?}");
        assert!(
            err.to_string().contains("截断") || err.to_string().contains("EOI"),
            "{err}"
        );
    }

    /// 标签指向的地方根本不是 JPEG:报损坏。
    #[test]
    fn garbage_at_declared_offset_is_corrupt() {
        let tmp = tempfile::tempdir().unwrap();
        let data = build_tiff(
            true,
            42,
            &[ifd(vec![
                t(T_JPEG_IF, 4, TD::BlobOff(0)),
                t(T_JPEG_IF_LEN, 4, TD::BlobLen(0)),
            ])],
            &[vec![0x41u8; 4096]],
        );
        let p = write_tmp(&tmp, "a.dng", &data);
        let err = extract_embedded_preview(&p).unwrap_err();
        assert!(matches!(err, RawError::Corrupt { .. }), "{err:?}");
        assert!(err.to_string().contains("SOI"), "{err}");
    }

    /// EOI 之后的少量填充可以裁掉;裁掉的只是不参与解码的尾巴。
    #[test]
    fn small_trailing_padding_after_eoi_is_trimmed() {
        let tmp = tempfile::tempdir().unwrap();
        let mut jpeg = jpeg_of(1280, 854);
        let real = jpeg.len();
        jpeg.extend_from_slice(&[0u8; 8]);
        let data = build_tiff(
            true,
            42,
            &[ifd(vec![
                t(T_JPEG_IF, 4, TD::BlobOff(0)),
                t(T_JPEG_IF_LEN, 4, TD::BlobLen(0)),
            ])],
            &[jpeg],
        );
        let p = write_tmp(&tmp, "a.dng", &data);
        let pv = extract_embedded_preview(&p).unwrap();
        assert_eq!(pv.jpeg.len(), real);
        assert_eq!(&pv.jpeg[pv.jpeg.len() - 2..], &[0xFF, 0xD9]);
    }

    /// 尾巴太长说明取到的范围本身就不对,不能当「有点脏但没事」放过去。
    #[test]
    fn long_trailing_garbage_is_corrupt() {
        let tmp = tempfile::tempdir().unwrap();
        let mut jpeg = jpeg_of(1280, 854);
        jpeg.extend_from_slice(&vec![0u8; MAX_TRAILING_PAD + 64]);
        let data = build_tiff(
            true,
            42,
            &[ifd(vec![
                t(T_JPEG_IF, 4, TD::BlobOff(0)),
                t(T_JPEG_IF_LEN, 4, TD::BlobLen(0)),
            ])],
            &[jpeg],
        );
        let p = write_tmp(&tmp, "a.dng", &data);
        assert!(matches!(
            extract_embedded_preview(&p).unwrap_err(),
            RawError::Corrupt { .. }
        ));
    }

    /// 自引用的 IFD 链不能把遍历卡死。
    #[test]
    fn self_referencing_ifd_chain_terminates() {
        let tmp = tempfile::tempdir().unwrap();
        let data = build_tiff(
            true,
            42,
            &[IfdSpec {
                tags: vec![
                    t(T_JPEG_IF, 4, TD::BlobOff(0)),
                    t(T_JPEG_IF_LEN, 4, TD::BlobLen(0)),
                    // SubIFDs 也指回自己,两条回路一起试
                    t(T_SUB_IFDS, 4, TD::IfdRefs(vec![0])),
                ],
                next: Some(0),
            }],
            &[jpeg_of(1280, 854)],
        );
        let p = write_tmp(&tmp, "a.dng", &data);
        // 没有卡死,而且照样把预览取了出来
        let pv = extract_embedded_preview(&p).unwrap();
        assert_eq!((pv.width, pv.height), (1280, 854));
    }

    /// IFD 条目数被写成 65535:不能照着它去读,直接判损坏。
    #[test]
    fn absurd_ifd_entry_count_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let mut data = build_tiff(
            true,
            42,
            &[ifd(vec![
                t(T_JPEG_IF, 4, TD::BlobOff(0)),
                t(T_JPEG_IF_LEN, 4, TD::BlobLen(0)),
            ])],
            &[jpeg_of(320, 240)],
        );
        // IFD0 起点固定在 8,前 2 字节就是条目数
        data[8] = 0xFF;
        data[9] = 0xFF;
        let p = write_tmp(&tmp, "a.dng", &data);
        let err = extract_embedded_preview(&p).unwrap_err();
        assert!(matches!(err, RawError::Corrupt { .. }), "{err:?}");
    }

    #[test]
    fn not_a_tiff_header_is_corrupt() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write_tmp(&tmp, "a.dng", b"RIFF____WEBPVP8 ....");
        let err = extract_embedded_preview(&p).unwrap_err();
        assert!(matches!(err, RawError::Corrupt { .. }), "{err:?}");
        assert!(err.to_string().contains("II/MM"), "{err}");
    }

    #[test]
    fn bigtiff_is_named_as_unsupported() {
        let tmp = tempfile::tempdir().unwrap();
        let data = build_tiff(true, 43, &[ifd(vec![sh(T_ORIENTATION, 1)])], &[]);
        let p = write_tmp(&tmp, "a.dng", &data);
        let err = extract_embedded_preview(&p).unwrap_err();
        assert!(matches!(err, RawError::UnsupportedFormat { .. }), "{err:?}");
        assert!(err.to_string().contains("BigTIFF"), "{err}");
    }

    // ---------------------- Panasonic RW2 ----------------------

    /// RW2 的魔数是 0x0055,预览是 IFD0 的 0x002E(JpgFromRaw),整张 JPEG
    /// 直接当标签的值存着;输出尺寸在 0x0007/0x0006。
    #[test]
    fn panasonic_rw2_jpg_from_raw_is_taken() {
        let tmp = tempfile::tempdir().unwrap();
        let data = build_tiff(
            true,
            85,
            &[ifd(vec![
                sh(T_PANA_IMAGE_HEIGHT, 854),
                sh(T_PANA_IMAGE_WIDTH, 1280),
                sh(T_ORIENTATION, 1),
                t(T_PANA_JPG_FROM_RAW, 7, TD::Bytes(jpeg_of(1280, 854))),
            ])],
            &[],
        );
        let p = write_tmp(&tmp, "a.rw2", &data);
        let pv = extract_embedded_preview(&p).unwrap();
        assert_eq!(pv.source, SRC_PANA_JPG_FROM_RAW);
        assert_eq!((pv.width, pv.height), (1280, 854));
        assert_eq!(pv.full_size, Some((1280, 854)));
        assert_eq!(pv.adequacy(), PreviewAdequacy::FullSize);
    }

    /// 0x002E 只在 RW2 魔数下才认——别家格式里的同号标签不许当预览用。
    #[test]
    fn tag_002e_is_only_honoured_for_rw2_magic() {
        let tmp = tempfile::tempdir().unwrap();
        let data = build_tiff(
            true,
            42, // 标准 TIFF 魔数,不是 RW2
            &[ifd(vec![t(
                T_PANA_JPG_FROM_RAW,
                7,
                TD::Bytes(jpeg_of(1280, 854)),
            )])],
            &[],
        );
        let p = write_tmp(&tmp, "a.dng", &data);
        assert!(matches!(
            extract_embedded_preview(&p).unwrap_err(),
            RawError::NoPreview { .. }
        ));
    }

    // ---------------------- Canon CR3(ISO-BMFF) ----------------------

    fn bmff_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut v = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(kind);
        v.extend_from_slice(payload);
        v
    }

    fn stsd_box(w: u16, h: u16) -> Vec<u8> {
        let mut se = Vec::new();
        se.extend_from_slice(&[0u8; 6]); // reserved
        se.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
        se.extend_from_slice(&[0u8; 2]); // pre_defined
        se.extend_from_slice(&[0u8; 2]); // reserved
        se.extend_from_slice(&[0u8; 12]); // pre_defined[3]
        se.extend_from_slice(&w.to_be_bytes());
        se.extend_from_slice(&h.to_be_bytes());
        se.extend_from_slice(&0x0048_0000u32.to_be_bytes()); // horizresolution
        se.extend_from_slice(&0x0048_0000u32.to_be_bytes()); // vertresolution
        se.extend_from_slice(&[0u8; 4]); // reserved
        se.extend_from_slice(&1u16.to_be_bytes()); // frame_count
        se.extend_from_slice(&[0u8; 32]); // compressorname
        se.extend_from_slice(&24u16.to_be_bytes()); // depth
        se.extend_from_slice(&(-1i16).to_be_bytes()); // pre_defined
        let entry = bmff_box(b"CRAW", &se);
        let mut p = vec![0u8; 4];
        p.extend_from_slice(&1u32.to_be_bytes());
        p.extend_from_slice(&entry);
        bmff_box(b"stsd", &p)
    }

    fn trak_box(w: u16, h: u16, sample_size: u32, sample_off: u32) -> Vec<u8> {
        let mut stbl = stsd_box(w, h);
        let mut stsz = vec![0u8; 4];
        stsz.extend_from_slice(&sample_size.to_be_bytes());
        stsz.extend_from_slice(&1u32.to_be_bytes());
        stbl.extend(bmff_box(b"stsz", &stsz));
        let mut stco = vec![0u8; 4];
        stco.extend_from_slice(&1u32.to_be_bytes());
        stco.extend_from_slice(&sample_off.to_be_bytes());
        stbl.extend(bmff_box(b"stco", &stco));
        let stbl = bmff_box(b"stbl", &stbl);
        let minf = bmff_box(b"minf", &stbl);
        let mdia = bmff_box(b"mdia", &minf);
        bmff_box(b"trak", &mdia)
    }

    fn thmb_box(jpeg: &[u8], w: u16, h: u16) -> Vec<u8> {
        let mut p = vec![0u8; 4]; // version/flags
        p.extend_from_slice(&w.to_be_bytes());
        p.extend_from_slice(&h.to_be_bytes());
        p.extend_from_slice(&(jpeg.len() as u32).to_be_bytes());
        p.extend_from_slice(&[0u8; 4]); // unknown
        p.extend_from_slice(jpeg);
        bmff_box(b"THMB", &p)
    }

    /// 合成 CR3:ftyp + moov{uuid(Canon){CMT1,CMT2,THMB?}, trak*} + mdat。
    /// `moov` 里的 stco 要指进 mdat,而 mdat 的位置又取决于 moov 的长度——
    /// 先用占位偏移量出 moov 的长度,再用真偏移重建(长度不变,断言钉住)。
    fn build_cr3(
        traks: &[(u16, u16, Vec<u8>)],
        thmb: Option<(Vec<u8>, u16, u16)>,
        cmt1: Option<Vec<u8>>,
        cmt2: Option<Vec<u8>>,
    ) -> Vec<u8> {
        let mut ftyp_payload = b"crx ".to_vec();
        ftyp_payload.extend_from_slice(&0u32.to_be_bytes());
        ftyp_payload.extend_from_slice(b"crx isom");
        let ftyp = bmff_box(b"ftyp", &ftyp_payload);

        let build_moov = |mdat_off: u32| -> Vec<u8> {
            let mut uuid_payload = CANON_META_UUID.to_vec();
            if let Some(c) = &cmt1 {
                uuid_payload.extend(bmff_box(b"CMT1", c));
            }
            if let Some(c) = &cmt2 {
                uuid_payload.extend(bmff_box(b"CMT2", c));
            }
            if let Some((j, w, h)) = &thmb {
                uuid_payload.extend(thmb_box(j, *w, *h));
            }
            let mut moov = bmff_box(b"uuid", &uuid_payload);
            let mut at = mdat_off;
            for (w, h, data) in traks {
                moov.extend(trak_box(*w, *h, data.len() as u32, at));
                at += data.len() as u32;
            }
            bmff_box(b"moov", &moov)
        };

        let probe = build_moov(0);
        let mdat_off = (ftyp.len() + probe.len() + 8) as u32;
        let moov = build_moov(mdat_off);
        assert_eq!(moov.len(), probe.len(), "两趟 moov 长度必须一致");

        let mut mdat_payload = Vec::new();
        for (_, _, d) in traks {
            mdat_payload.extend_from_slice(d);
        }
        let mut out = ftyp;
        out.extend(moov);
        out.extend(bmff_box(b"mdat", &mdat_payload));
        out
    }

    /// CMT1 风格的 TIFF 片段(IFD0:Orientation)。
    fn cmt1_blob(orientation: u32) -> Vec<u8> {
        build_tiff(true, 42, &[ifd(vec![sh(T_ORIENTATION, orientation)])], &[])
    }
    /// CMT2 风格的 TIFF 片段(ExifIFD:PixelXDimension/PixelYDimension)。
    fn cmt2_blob(w: u32, h: u32) -> Vec<u8> {
        build_tiff(
            true,
            42,
            &[ifd(vec![lo(T_PIXEL_X_DIM, w), lo(T_PIXEL_Y_DIM, h)])],
            &[],
        )
    }

    /// CR3 的全尺寸预览在轨道里:stco 首 chunk + stsz 首样本。
    /// 另外两条轨道(原始 CRAW、CTMD 元数据)的样本不是 JPEG,必须被校验闸挡掉。
    #[test]
    fn cr3_takes_the_track_sample_not_the_thumbnail() {
        let tmp = tempfile::tempdir().unwrap();
        let data = build_cr3(
            &[
                (1280, 854, jpeg_of(1280, 854)),
                (6000, 4000, vec![0xAB; 512]), // 原始 CRAW:不是 JPEG
                (0, 0, b"CTMD\0\0\0\0metadata".to_vec()),
            ],
            Some((jpeg_of(160, 120), 160, 120)),
            Some(cmt1_blob(6)),
            Some(cmt2_blob(1280, 854)),
        );
        let p = write_tmp(&tmp, "a.cr3", &data);
        let pv = extract_embedded_preview(&p).unwrap();
        assert_eq!(pv.source, SRC_CR3_TRAK);
        assert_eq!((pv.width, pv.height), (1280, 854));
        assert_eq!(pv.full_size, Some((1280, 854)));
        assert_eq!(pv.adequacy(), PreviewAdequacy::FullSize);
        // Orientation 来自 CMT1;预览与原图同为横构图,不算「已摆正」
        assert_eq!(pv.orientation, 6);
        assert!(image::load_from_memory(&pv.jpeg).is_ok());
    }

    /// 只有 THMB 的 CR3(或轨道解析不出来时)必须落到缩略级并给告警,
    /// 不能因为「取到了」就当全尺寸。
    #[test]
    fn cr3_with_only_thmb_is_thumbnail_level() {
        let tmp = tempfile::tempdir().unwrap();
        let data = build_cr3(
            &[],
            Some((jpeg_of(160, 120), 160, 120)),
            Some(cmt1_blob(1)),
            None,
        );
        let p = write_tmp(&tmp, "a.cr3", &data);
        let pv = extract_embedded_preview(&p).unwrap();
        assert_eq!(pv.source, SRC_CR3_THMB);
        assert_eq!((pv.width, pv.height), (160, 120));
        assert_eq!(pv.adequacy(), PreviewAdequacy::ThumbnailOnly);
        assert!(pv.warning().unwrap().contains("判不了虚实"));
    }

    /// 没有 CMT2 时用轨道声明的最大尺寸兜底(CRAW 轨道写的是感光尺寸)。
    #[test]
    fn cr3_falls_back_to_track_dimensions_for_full_size() {
        let tmp = tempfile::tempdir().unwrap();
        let data = build_cr3(
            &[
                (1280, 854, jpeg_of(1280, 854)),
                (6000, 4000, vec![0xAB; 512]),
            ],
            None,
            Some(cmt1_blob(1)),
            None,
        );
        let p = write_tmp(&tmp, "a.cr3", &data);
        let pv = extract_embedded_preview(&p).unwrap();
        assert_eq!(pv.full_size, Some((6000, 4000)));
        assert!((pv.fraction_of_full.unwrap() - 1280.0 / 6000.0).abs() < 0.001);
        assert_eq!(pv.adequacy(), PreviewAdequacy::ThumbnailOnly);
    }

    #[test]
    fn cr3_without_moov_is_corrupt() {
        let tmp = tempfile::tempdir().unwrap();
        let mut data = bmff_box(b"ftyp", b"crx \0\0\0\0crx isom");
        data.extend(bmff_box(b"mdat", &[0u8; 32]));
        let p = write_tmp(&tmp, "a.cr3", &data);
        let err = extract_embedded_preview(&p).unwrap_err();
        assert!(matches!(err, RawError::Corrupt { .. }), "{err:?}");
        assert!(err.to_string().contains("moov"), "{err}");
    }

    #[test]
    fn cr3_without_ftyp_is_corrupt() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write_tmp(&tmp, "a.cr3", &[0u8; 128]);
        let err = extract_embedded_preview(&p).unwrap_err();
        assert!(matches!(err, RawError::Corrupt { .. }), "{err:?}");
        assert!(err.to_string().contains("ftyp"), "{err}");
    }

    /// 轨道样本全不是 JPEG:报「有声明但取不出完整 JPEG」,不是 NoPreview,
    /// 也不是把 CRAW 数据当图交出去。
    #[test]
    fn cr3_with_no_jpeg_track_is_corrupt_not_silent() {
        let tmp = tempfile::tempdir().unwrap();
        let data = build_cr3(&[(6000, 4000, vec![0xAB; 512])], None, None, None);
        let p = write_tmp(&tmp, "a.cr3", &data);
        let err = extract_embedded_preview(&p).unwrap_err();
        assert!(matches!(err, RawError::Corrupt { .. }), "{err:?}");
    }

    // ---------------------- Fujifilm RAF ----------------------

    /// RAF 头部布局见 [`RAF_MAGIC`] 附近的注释。CFA 目录里的 0x0100
    /// (RawImageFullSize)是(高,宽)顺序。
    fn build_raf(jpeg: &[u8], full: Option<(u16, u16)>) -> Vec<u8> {
        let mut out = vec![0u8; 0x68];
        out[0..16].copy_from_slice(RAF_MAGIC);
        let mut cfa = Vec::new();
        if let Some((w, h)) = full {
            cfa.extend_from_slice(&1u32.to_be_bytes()); // 条目数
            cfa.extend_from_slice(&RAF_TAG_FULL_SIZE.to_be_bytes());
            cfa.extend_from_slice(&4u16.to_be_bytes()); // 数据长度
            cfa.extend_from_slice(&h.to_be_bytes());
            cfa.extend_from_slice(&w.to_be_bytes());
        }
        let cfa_off = out.len() as u32;
        out.extend_from_slice(&cfa);
        let jpeg_off = out.len() as u32;
        out.extend_from_slice(jpeg);
        out[RAF_JPEG_OFF..RAF_JPEG_OFF + 4].copy_from_slice(&jpeg_off.to_be_bytes());
        out[RAF_JPEG_LEN..RAF_JPEG_LEN + 4].copy_from_slice(&(jpeg.len() as u32).to_be_bytes());
        if !cfa.is_empty() {
            out[RAF_CFA_HDR_OFF..RAF_CFA_HDR_OFF + 4].copy_from_slice(&cfa_off.to_be_bytes());
            out[RAF_CFA_HDR_LEN..RAF_CFA_HDR_LEN + 4]
                .copy_from_slice(&(cfa.len() as u32).to_be_bytes());
        }
        out
    }

    #[test]
    fn raf_header_jpeg_is_taken_with_full_size_from_cfa_header() {
        let tmp = tempfile::tempdir().unwrap();
        let jpeg = with_exif_orientation(&jpeg_of(1280, 854), 6);
        let data = build_raf(&jpeg, Some((1280, 854)));
        let p = write_tmp(&tmp, "a.raf", &data);
        let pv = extract_embedded_preview(&p).unwrap();
        assert_eq!(pv.source, SRC_RAF_HEADER);
        assert_eq!((pv.width, pv.height), (1280, 854));
        assert_eq!(pv.full_size, Some((1280, 854)));
        assert_eq!(pv.adequacy(), PreviewAdequacy::FullSize);
        // RAF 的内嵌 JPEG 自带 EXIF,方向以它为准
        assert_eq!(pv.orientation, 6);
    }

    #[test]
    fn raf_without_cfa_header_reports_unknown_fraction() {
        let tmp = tempfile::tempdir().unwrap();
        let data = build_raf(&jpeg_of(1280, 854), None);
        let p = write_tmp(&tmp, "a.raf", &data);
        let pv = extract_embedded_preview(&p).unwrap();
        assert_eq!(pv.fraction_of_full, None);
        assert_eq!(pv.adequacy(), PreviewAdequacy::Unknown);
        assert_eq!(pv.orientation, 1, "样张没有 EXIF,方向应回落到 1");
    }

    #[test]
    fn raf_with_zero_length_jpeg_is_no_preview() {
        let tmp = tempfile::tempdir().unwrap();
        let mut data = build_raf(&jpeg_of(320, 240), None);
        data[RAF_JPEG_LEN..RAF_JPEG_LEN + 4].copy_from_slice(&0u32.to_be_bytes());
        let p = write_tmp(&tmp, "a.raf", &data);
        assert!(matches!(
            extract_embedded_preview(&p).unwrap_err(),
            RawError::NoPreview { .. }
        ));
    }

    #[test]
    fn raf_with_bad_magic_is_corrupt() {
        let tmp = tempfile::tempdir().unwrap();
        let mut data = build_raf(&jpeg_of(320, 240), None);
        data[0..4].copy_from_slice(b"XXXX");
        let p = write_tmp(&tmp, "a.raf", &data);
        let err = extract_embedded_preview(&p).unwrap_err();
        assert!(matches!(err, RawError::Corrupt { .. }), "{err:?}");
        assert!(err.to_string().contains("FUJIFILM"), "{err}");
    }

    #[test]
    fn raf_offset_past_eof_is_corrupt() {
        let tmp = tempfile::tempdir().unwrap();
        let mut data = build_raf(&jpeg_of(320, 240), None);
        data[RAF_JPEG_OFF..RAF_JPEG_OFF + 4].copy_from_slice(&9_000_000u32.to_be_bytes());
        let p = write_tmp(&tmp, "a.raf", &data);
        assert!(matches!(
            extract_embedded_preview(&p).unwrap_err(),
            RawError::Corrupt { .. }
        ));
    }

    // ---------------------- 方向与占比的单元逻辑 ----------------------

    #[test]
    fn fraction_uses_long_edge_and_is_none_without_full_size() {
        assert_eq!(fraction_of(1280, 854, None), None);
        assert!((fraction_of(3000, 2000, Some((6000, 4000))).unwrap() - 0.5).abs() < 1e-6);
        // 预览已摆正(竖)、原图未摆正(横)时,长边比仍然是 0.5
        assert!((fraction_of(2000, 3000, Some((6000, 4000))).unwrap() - 0.5).abs() < 1e-6);
    }

    #[test]
    fn already_upright_preview_is_not_rotated_twice() {
        // 原图横放 6000×4000、orientation=6(顺时针 90°),预览却是竖的
        // → 相机已经摆正过,再转一次就倒了
        assert!(preview_already_upright(2000, 3000, (6000, 4000), 6));
        // 预览与原图同为横构图 → 没摆正,orientation 照常生效
        assert!(!preview_already_upright(3000, 2000, (6000, 4000), 6));
        // orientation 是 180°/镜像类,不涉及横竖互换,一律不推翻
        assert!(!preview_already_upright(2000, 3000, (6000, 4000), 3));
        // 接近正方形:比例噪声可能误判,不推翻
        assert!(!preview_already_upright(2010, 2000, (4000, 4010), 6));
    }

    /// 端到端:预览是竖的、原图是横的、IFD0 写着 orientation=6,
    /// 交出来的 orientation 必须是 1(否则调用方会把它转成倒的)。
    #[test]
    fn pre_rotated_preview_reports_orientation_one() {
        let tmp = tempfile::tempdir().unwrap();
        let data = build_tiff(
            true,
            42,
            &[
                ifd(vec![
                    sh(T_ORIENTATION, 6),
                    t(T_JPEG_IF, 4, TD::BlobOff(0)),
                    t(T_JPEG_IF_LEN, 4, TD::BlobLen(0)),
                    t(T_SUB_IFDS, 4, TD::IfdRefs(vec![1])),
                ]),
                ifd(vec![
                    lo(T_NEW_SUBFILE_TYPE, 0),
                    sh(T_IMAGE_WIDTH, 1500),
                    sh(T_IMAGE_LENGTH, 1000),
                ]),
            ],
            &[jpeg_of(700, 1050)],
        );
        let p = write_tmp(&tmp, "a.dng", &data);
        let pv = extract_embedded_preview(&p).unwrap();
        assert_eq!((pv.width, pv.height), (700, 1050));
        assert_eq!(pv.orientation, 1, "已摆正的预览不能再转一次");
    }

    // ---------------------- 随机损坏:不许 panic,不许返回垃圾 ----------------------

    /// 这段代码要喂任意存储卡内容,所以随机翻字节 + 随机截断都不许 panic,
    /// 而且**只要返回 Ok**,交出去的就必须是一张真正以 SOI 开头、EOI 结尾、
    /// 头部能解出尺寸的 JPEG——「宁可报错也不返回垃圾」这条要扛得住随机损坏。
    ///
    /// 用固定种子的 xorshift,失败可复现。
    #[test]
    fn randomly_corrupted_files_never_panic_and_never_return_garbage() {
        let tmp = tempfile::tempdir().unwrap();
        let seeds: Vec<(&str, Vec<u8>)> = vec![
            (
                "f.dng",
                dng_like_with_thumb(
                    jpeg_of(160, 120),
                    (jpeg_of(480, 320), 480, 320),
                    (jpeg_of(320, 200), 480, 320),
                    6,
                ),
            ),
            (
                "f.rw2",
                build_tiff(
                    true,
                    85,
                    &[ifd(vec![
                        sh(T_PANA_IMAGE_HEIGHT, 320),
                        sh(T_PANA_IMAGE_WIDTH, 480),
                        t(T_PANA_JPG_FROM_RAW, 7, TD::Bytes(jpeg_of(480, 320))),
                    ])],
                    &[],
                ),
            ),
            (
                "f.cr3",
                build_cr3(
                    &[(480, 320, jpeg_of(480, 320)), (6000, 4000, vec![0xAB; 256])],
                    Some((jpeg_of(160, 120), 160, 120)),
                    Some(cmt1_blob(6)),
                    Some(cmt2_blob(480, 320)),
                ),
            ),
            ("f.raf", build_raf(&jpeg_of(480, 320), Some((480, 320)))),
        ];

        let mut state = 0x2545_F491_4F6C_DD1Du64;
        let mut rng = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };

        let mut succeeded = 0usize;
        let mut decoded = 0usize;
        for (name, base) in &seeds {
            for round in 0..100 {
                let mut data = base.clone();
                let flips = 1 + (rng() % 8) as usize;
                for _ in 0..flips {
                    let i = (rng() as usize) % data.len();
                    data[i] ^= (rng() % 255) as u8 + 1;
                }
                if round % 3 == 0 {
                    let cut = (rng() as usize) % data.len();
                    data.truncate(cut);
                }
                let p = write_tmp(&tmp, name, &data);
                // 不 panic 本身就是断言:panic 会直接让这条测试红
                if let Ok(pv) = extract_embedded_preview(&p) {
                    succeeded += 1;
                    assert!(pv.jpeg.len() >= 4, "{name}/{round}:返回了空数据");
                    assert_eq!(&pv.jpeg[..2], &[0xFF, 0xD8], "{name}/{round}:开头不是 SOI");
                    assert_eq!(
                        &pv.jpeg[pv.jpeg.len() - 2..],
                        &[0xFF, 0xD9],
                        "{name}/{round}:结尾不是 EOI"
                    );
                    assert!(pv.width > 0 && pv.height > 0, "{name}/{round}:尺寸为 0");
                    // 熵编码段被翻掉的样本本来就解不开(那是真损坏,调用方会
                    // 如实报错);但只要解得开,尺寸就必须与上报的一致
                    if let Ok(img) = image::load_from_memory(&pv.jpeg) {
                        decoded += 1;
                        assert_eq!(
                            (img.width(), img.height()),
                            (pv.width, pv.height),
                            "{name}/{round}:上报尺寸与实际解出的不一致"
                        );
                    }
                }
            }
        }
        // 自证:全都失败的话这条测试什么也没验证到
        assert!(succeeded > 30, "成功路径覆盖太少(仅 {succeeded} 次)");
        assert!(decoded > 10, "完整解码路径覆盖太少(仅 {decoded} 次)");
    }

    #[test]
    fn adequacy_absolute_floor_beats_a_perfect_ratio() {
        // 「占原图 100%」但只有 800px 长边,一样判不了对焦
        let pv = EmbeddedPreview {
            jpeg: Vec::new(),
            width: 800,
            height: 600,
            fraction_of_full: Some(1.0),
            full_size: Some((800, 600)),
            orientation: 1,
            source: SRC_TIFF_JPEG_IF,
        };
        assert_eq!(pv.adequacy(), PreviewAdequacy::ThumbnailOnly);
        assert!(pv.warning().is_some());
    }
}
