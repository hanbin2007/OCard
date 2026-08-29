//! 用捆绑的 ffmpeg sidecar 取一张**静止画面**:视频抽帧 + HEIC/HEIF 解静态图。
//!
//! ## 为什么走 sidecar 而不是新加 C 依赖
//!
//! 本项目**已经**在打包 ffmpeg/ffprobe(`core::ffmpeg`,转码功能在用),
//! 三平台的下载与校验流程都跑通了。视频抽帧和 HEIC 解码都能落在这条既有的
//! 路上,于是「全屏预览看不到画面」这件事不需要引入 libheif / libavcodec
//! 这类新的 C 依赖,也不会动到打包矩阵。这是这条路线成立的**全部**理由。
//!
//! ## 为什么不预先声明「支持 / 不支持 HEIC」
//!
//! 三平台的 sidecar 是各自下载的构建,裁剪程度不一样;而且 `.heic` 容器里
//! 装的既可能是 HEVC 也可能是 AV1,同一个「HEIC 支持」的布尔值对两者会给出
//! 相反的答案。所以这里**不存**任何编译期的能力常量:
//! - 能不能解,靠**真的去解一次**回答;
//! - 解不了时,靠运行期问二进制自己要的解码器清单
//!   ([`crate::core::ffmpeg::video_decoders`])把缺的那个**点名**说出来。
//!
//! ## 零静默
//!
//! 五类失败(sidecar 缺失 / 文件损坏 / 没有视频轨 / 编码没有解码器 / 超时)
//! 各说各的话,措辞互不相同——它们指向完全不同的处置,含糊成一句
//! 「加载失败」比不说更糟。

use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 抽帧的目标时间点(秒)。
///
/// **为什么不是第 0 帧**:实拍素材的开头几乎总是废的——打板、场记板、
/// 摄影机自动曝光/白平衡还在收敛、或者干脆是一段黑场。拿第 0 帧当预览,
/// 用户在选片屏上看到的是一片黑,既认不出这是哪条,也判不了任何东西。
///
/// **为什么是 1.0 秒而不是「时长的 10%」**:百分比对一条 10 分钟的长镜头
/// 会落到第 60 秒,那个位置和这条素材的「开头长什么样」已经没关系了;
/// 而固定偏移是个**能写进界面的确定的数**——用户看到静止画面时,
/// 我们要能明确告诉他「这是第 1.0 秒的一帧」。1 秒足够越过板子和黑头,
/// 又仍然在这条镜头的开头。
pub const FRAME_AT_SEC: f64 = 1.0;

/// 短于这个时长的视频直接取第 0 秒。
///
/// 留 0.2 秒余量而不是拿 `duration > FRAME_AT_SEC` 卡:`-ss` 落在最后一帧
/// 之后时 ffmpeg 一帧都不吐、以非零退出码收场(实测退出码 234),
/// 而那是一条**本来能出画面**的素材被判成失败。
pub const MIN_DURATION_FOR_OFFSET: f64 = FRAME_AT_SEC + 0.2;

/// ffprobe 读元信息的超时。素材在慢速 NAS 上时首次打开会慢。
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
/// 抽帧本身的超时(与 `analysis_cmds` 的视频缩略图同一档)。
const EXTRACT_TIMEOUT: Duration = Duration::from_secs(30);

/// 这张静止画面是怎么来的。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StillKind {
    /// 视频抽的一帧(**不是**整段视频,界面必须说清)
    VideoFrame,
    /// HEIC/HEIF 的静态图(就是这张照片本身,不是「其中一帧」)
    HeifStill,
}

impl StillKind {
    /// 报错时用来指代这个文件的名词。
    fn noun(self) -> &'static str {
        match self {
            Self::VideoFrame => "视频",
            Self::HeifStill => "HEIC/HEIF 图片",
        }
    }
}

/// sidecar 取图失败的分类。**每一类都必须能独立成句**,并且指向不同的处置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StillError {
    /// 应用目录里根本没有 ffmpeg/ffprobe(安装包损坏 / 精简分发)
    SidecarMissing(String),
    /// ffprobe/ffmpeg 打不开这个文件:损坏、截断、或者压根不是媒体文件
    Corrupt { noun: &'static str, detail: String },
    /// 容器读得开,但里面没有视频轨(纯音频的 .mov、只剩音轨的残片)
    NoVideoStream { noun: &'static str },
    /// 这台机器打包的 ffmpeg 里没有这个编码的解码器
    UnsupportedCodec { noun: &'static str, codec: String },
    /// 超时被强杀(慢速网络盘,或损坏文件让 ffmpeg 空转)
    Timeout { stage: &'static str, secs: u64 },
    /// ffmpeg 自称成功,但吐出来的东西解不成图
    Output { noun: &'static str, detail: String },
}

impl std::fmt::Display for StillError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SidecarMissing(why) => write!(
                f,
                "本机装的应用里找不到 ffmpeg 组件({why}),视频与 HEIC 的预览都解不出来;\
                 重新安装应用可修复"
            ),
            Self::Corrupt { noun, detail } => write!(
                f,
                "这个{noun}打不开——文件已损坏或被截断(ffmpeg: {detail});\
                 请回源盘核对这个文件"
            ),
            Self::NoVideoStream { noun } => write!(
                f,
                "这个{noun}里没有视频轨(可能只剩音轨或元数据),没有画面可以取"
            ),
            Self::UnsupportedCodec { noun, codec } => write!(
                f,
                "这台机器上打包的 ffmpeg 没有「{codec}」解码器,解不出这个{noun}的画面;\
                 三个平台的 ffmpeg 裁剪程度不同,同一个文件换台机器可能就能看"
            ),
            Self::Timeout { stage, secs } => write!(
                f,
                "{stage}超过 {secs} 秒仍未完成,已强制结束;\
                 素材可能在很慢的网络盘上,也可能损坏到让 ffmpeg 空转"
            ),
            Self::Output { noun, detail } => write!(
                f,
                "ffmpeg 报告成功却没给出能解码的画面({detail}),这个{noun}的预览取不到"
            ),
        }
    }
}

/// 一次 ffprobe 的结果:够用来选帧、判上限、并在失败时点名原因。
#[derive(Debug, Clone, PartialEq)]
pub struct Probed {
    pub codec: String,
    /// **整图/整帧**的编码尺寸(HEIC 拼贴网格已还原成整图,见 [`tile_grid_dimensions`])
    pub width: u32,
    pub height: u32,
    /// 视频时长;静态图与读不出时长的容器为 None
    pub duration_sec: Option<f64>,
}

/// 定位一对 sidecar。缺失是**四类失败里的一类**,不能和「文件坏了」混为一谈。
fn sidecars() -> Result<(PathBuf, PathBuf), StillError> {
    let ffmpeg = super::ffmpeg::sidecar_path("ffmpeg").map_err(StillError::SidecarMissing)?;
    let ffprobe = super::ffmpeg::sidecar_path("ffprobe").map_err(StillError::SidecarMissing)?;
    Ok((ffmpeg, ffprobe))
}

/// 从 ffprobe JSON 里取「拼贴网格」的整图尺寸。
///
/// 为什么必须单独取:HEIC 常把一张照片切成很多块 HEVC 小图存(实测 iPhone
/// 风格的 1920×1080 被切成 12 块 512×512),这时 `-show_streams` 报的是
/// **单块**的尺寸。拿 512×512 去和「一亿两千万像素上限」比,等于这道闸对
/// HEIC 完全失效;报给界面的「原始尺寸」也会是错的。
///
/// 纯函数:拼贴网格的 JSON 结构值得被单测钉住,而造一张真拼贴 HEIC 很麻烦。
pub fn tile_grid_dimensions(json_text: &str) -> Option<(u32, u32)> {
    #[derive(Deserialize)]
    struct Root {
        stream_groups: Option<Vec<Group>>,
    }
    #[derive(Deserialize)]
    struct Group {
        #[serde(rename = "type")]
        kind: Option<String>,
        components: Option<Vec<Component>>,
    }
    #[derive(Deserialize)]
    struct Component {
        width: Option<u32>,
        height: Option<u32>,
    }
    let root: Root = serde_json::from_str(json_text).ok()?;
    root.stream_groups?
        .iter()
        .filter(|g| g.kind.as_deref() == Some("Tile Grid"))
        .flat_map(|g| g.components.iter().flatten())
        .find_map(|c| match (c.width, c.height) {
            (Some(w), Some(h)) if w > 0 && h > 0 => Some((w, h)),
            _ => None,
        })
}

/// 从 ffprobe JSON 里取第一条视频轨的旋转角(display matrix;无则 0)。
///
/// 为什么要它:ffmpeg 抽帧时**默认按 display matrix 摆正**(实测 640×360 带
/// rotation:90 的素材抽出来是 360×640),而 `-show_streams` 报的 width/height
/// 是**摆正前**的。两者直接混用,竖拍视频报给界面的「原始尺寸」就是躺倒的,
/// 命中缓存那条路还会据此把 `downscaled` 算错。
///
/// 纯函数:造一个真的带 display matrix 的素材很费事,而这段解析值得钉住。
pub fn display_rotation(json_text: &str) -> i32 {
    #[derive(Deserialize)]
    struct Root {
        streams: Option<Vec<Stream>>,
    }
    #[derive(Deserialize)]
    struct Stream {
        codec_type: Option<String>,
        side_data_list: Option<Vec<SideData>>,
    }
    #[derive(Deserialize)]
    struct SideData {
        rotation: Option<f64>,
    }
    let Ok(root) = serde_json::from_str::<Root>(json_text) else {
        return 0;
    };
    let rot = root
        .streams
        .unwrap_or_default()
        .into_iter()
        .find(|s| s.codec_type.as_deref() == Some("video"))
        .and_then(|s| s.side_data_list)
        .unwrap_or_default()
        .into_iter()
        .find_map(|d| d.rotation)
        .unwrap_or(0.0);
    // ffprobe 会给出 -90 这类负角;归一到 [0,360)
    let normalized = rot.round() as i64 % 360;
    (if normalized < 0 {
        normalized + 360
    } else {
        normalized
    }) as i32
}

/// 旋转角是否让宽高互换(90 / 270)。
fn swaps_axes(rotation: i32) -> bool {
    rotation == 90 || rotation == 270
}

/// 读一遍元信息:编码名、整图尺寸、时长。
///
/// 这次额外的进程调用是**值得的**,它一次买到三样东西:
/// 1. 时长——才能在「视频比 1 秒还短」时退回第 0 秒,而不是让 `-ss` 越界
///    把一条能出画面的素材判成失败;
/// 2. 编码名——失败时才点得出「缺的是哪个解码器」,而不是笼统一句「不支持」;
/// 3. 一个干净的「这压根不是媒体文件」信号——把「损坏」和「编码不支持」
///    分开,而这两句话指向完全不同的排查方向。
pub fn probe(abs: &Path, kind: StillKind) -> Result<Probed, StillError> {
    let (_, ffprobe) = sidecars()?;
    let path = abs.to_string_lossy().to_string();
    let args = [
        "-hide_banner",
        "-v",
        "error",
        // 供应链纪律(与 transcode::probe_file 同源):素材路径是外部输入,
        // 协议白名单钉死本地文件,杜绝构造 URL 状文件名去开网络/设备协议
        "-protocol_whitelist",
        "file",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        // 拼贴网格的整图尺寸只在 stream_groups 里
        "-show_stream_groups",
        &path,
    ];
    let out = super::ffmpeg::run_with_timeout(&ffprobe, &args, PROBE_TIMEOUT).map_err(|e| {
        if e.contains("超时") {
            StillError::Timeout {
                stage: "读取媒体信息",
                secs: PROBE_TIMEOUT.as_secs(),
            }
        } else {
            StillError::Corrupt {
                noun: kind.noun(),
                detail: e,
            }
        }
    })?;
    if !out.status.success() {
        return Err(StillError::Corrupt {
            noun: kind.noun(),
            detail: tail_of(&out.stderr),
        });
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // 解析口径与转码那条路共用一个纯函数,不另写一套(两套早晚会漂移)
    let info = super::transcode::parse_ffprobe_json(&text).map_err(|e| {
        // 能打开、却挑不出视频轨(纯音频 mov / 只剩音轨的残片)与「文件坏了」
        // 是两回事。判据取 `parse_ffprobe_json` 那句原话——同模块常量级的
        // 耦合,`no_video_stream_is_not_reported_as_corrupt` 用真 JSON 钉住它,
        // 那句话哪天改了测试会红,不会悄悄退化成「损坏」
        if e.contains("没有视频流") {
            StillError::NoVideoStream { noun: kind.noun() }
        } else {
            StillError::Corrupt {
                noun: kind.noun(),
                detail: e,
            }
        }
    })?;
    // 拼贴网格优先:它才是整图尺寸,逐块的 512×512 会让像素上限对 HEIC 失效
    let (w, h) = tile_grid_dimensions(&text).unwrap_or((info.width, info.height));
    // 报**摆正后**的尺寸:抽帧本身就是摆正的,两者不一致会让竖拍素材的
    // 「原始尺寸」躺倒,命中缓存那条路还会据此把 downscaled 算错
    let (width, height) = if swaps_axes(display_rotation(&text)) {
        (h, w)
    } else {
        (w, h)
    };
    Ok(Probed {
        codec: info.codec,
        width,
        height,
        duration_sec: info.duration_secs,
    })
}

/// 这台机器解不解得了这个编码。解不了就**点名**缺的是哪个解码器。
///
/// 运行期问二进制自己,不写编译期常量:三平台 sidecar 的裁剪程度不同,
/// 写死哪一边都会在另一边骗人。
pub fn ensure_decodable(probed: &Probed, kind: StillKind) -> Result<(), StillError> {
    let (ffmpeg, _) = sidecars()?;
    let codec = probed.codec.trim();
    if codec.is_empty() {
        return Err(StillError::UnsupportedCodec {
            noun: kind.noun(),
            codec: "未知编码".into(),
        });
    }
    // 清单读不出来时**不拦**:让后面真解一次去回答,失败也有具体报文。
    // 在这里拿「问不到清单」当「不支持」,会把一堆本来能看的素材白白拒掉
    let Ok(decoders) = super::ffmpeg::video_decoders(&ffmpeg) else {
        return Ok(());
    };
    if decoders.contains(codec) {
        return Ok(());
    }
    Err(StillError::UnsupportedCodec {
        noun: kind.noun(),
        codec: codec.to_string(),
    })
}

/// 该抽第几秒。视频短于 [`MIN_DURATION_FOR_OFFSET`] 就退回第 0 秒;
/// 时长读不出来时先按 [`FRAME_AT_SEC`] 试,取不到再由 [`extract`] 回退。
pub fn frame_time_for(kind: StillKind, duration_sec: Option<f64>) -> f64 {
    match kind {
        // 静态图没有时间轴
        StillKind::HeifStill => 0.0,
        StillKind::VideoFrame => match duration_sec {
            Some(d) if d.is_finite() && d < MIN_DURATION_FOR_OFFSET => 0.0,
            _ => FRAME_AT_SEC,
        },
    }
}

/// 构造一次取图的 ffmpeg 参数(纯函数,可测)。
///
/// 纪律与 `core::ffmpeg` / `core::transcode` 一致:参数一律数组、绝不拼 shell、
/// `-nostdin -hide_banner`、**永不 `-y`**(输出走 stdout,没有覆盖问题)。
///
/// 几个刻意的选择:
/// - **输出 PNG 而不是 MJPEG**:这张图是拿来判虚实的,再压一道有损会把
///   压缩痕迹伪装成「拍虚了」。PNG 无损,后面统一按预览质量编一次 JPEG,
///   于是视频帧和照片走的是**同样多**的有损次数。实测 4K 一帧 PNG 比
///   MJPEG 只慢 ~80ms(0.20s vs 0.12s),换掉一整道有损很划算;
/// - **`-ss` 放在 `-i` 前面**:走的是快速关键帧定位,不用把前面的帧全解一遍;
/// - **不写 `-map`**:HEIC 的拼贴网格要靠 ffmpeg 默认的流组选择去 xstack
///   拼回整图,一旦写死 `-map 0:v:0` 就只能拿到左上角那一块;
/// - **`-an -sn -dn`** 丢掉音轨/字幕/数据轨,而不是用 `-map` 去挑视频轨,
///   同样是为了不破坏上面那条拼贴逻辑。
pub fn extract_args(abs: &Path, at_sec: f64) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-v".into(),
        "error".into(),
        "-protocol_whitelist".into(),
        "file".into(),
    ];
    if at_sec > 0.0 {
        args.extend(["-ss".into(), format!("{at_sec:.3}")]);
    }
    args.extend(["-i".into(), abs.to_string_lossy().to_string()]);
    args.extend([
        "-an".into(),
        "-sn".into(),
        "-dn".into(),
        "-frames:v".into(),
        "1".into(),
        "-f".into(),
        "image2".into(),
        "-c:v".into(),
        "png".into(),
        "-".into(),
    ]);
    args
}

/// 一次成功取图的结果。
#[derive(Debug, Clone, PartialEq)]
pub struct Still {
    pub png: Vec<u8>,
    /// **实际**抽的是第几秒。
    ///
    /// 静态图为 None(没有时间轴);视频在时长读不出、且退回过第 0 秒时
    /// 也可能是 None——见 [`extract`] 里对「说不准就别说」的处置。
    pub at_sec: Option<f64>,
    /// 整段时长(读不出为 None)
    pub duration_sec: Option<f64>,
}

/// 真去取一张静止画面(PNG 字节;不解码、不落盘,由调用方处置)。
///
/// 调用方**必须**先持有解码闸:一个 ffmpeg 进程能吃掉一整个核,按住方向键
/// 翻图时不设闸会同时起十几个。
pub fn extract(abs: &Path, kind: StillKind, probed: &Probed) -> Result<Still, StillError> {
    let (ffmpeg, _) = sidecars()?;
    let target = frame_time_for(kind, probed.duration_sec);

    let run = |at: f64| -> Result<Vec<u8>, StillError> {
        let args = extract_args(abs, at);
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let out =
            super::ffmpeg::run_with_timeout(&ffmpeg, &refs, EXTRACT_TIMEOUT).map_err(|e| {
                if e.contains("超时") {
                    StillError::Timeout {
                        stage: "取画面",
                        secs: EXTRACT_TIMEOUT.as_secs(),
                    }
                } else {
                    StillError::Corrupt {
                        noun: kind.noun(),
                        detail: e,
                    }
                }
            })?;
        if !out.status.success() || out.stdout.is_empty() {
            return Err(StillError::Corrupt {
                noun: kind.noun(),
                detail: tail_of(&out.stderr),
            });
        }
        Ok(out.stdout)
    };

    // 时长读不出来的容器(部分 MTS / 残缺 mp4)会让 `-ss 1.0` 落到最后一帧
    // 之后,ffmpeg 一帧不吐。这时——也**只有**这时——退回第 0 秒重试一次。
    //
    // 为什么不在时长已知时也兜这一手:那样「到底抽的是第几秒」就不再由
    // (时长 → 时间点)唯一决定,而命中缓存那条路正是靠这个确定性重算出
    // 「这是第几秒」的。留着一条会悄悄换帧的退路,等于让界面有机会
    // 举着第 0 秒的画面说「这是第 1 秒」——那正是这个功能要修的那类谎话。
    // 时长已知却仍抽不出帧,是真的出了问题,该如实报错,不该拿另一帧顶上。
    let may_retry = probed.duration_sec.is_none() && target > 0.0;
    match run(target) {
        Ok(png) => Ok(Still {
            png,
            at_sec: (kind == StillKind::VideoFrame).then_some(target),
            duration_sec: probed.duration_sec,
        }),
        Err(first) if may_retry => match run(0.0) {
            Ok(png) => Ok(Still {
                png,
                // 走到这里说明时长未知:命中缓存时**重算不出**这个 0.0,
                // 于是干脆不声称具体秒数,由界面说「开头的一帧」。
                // 说不准就别说,比两条路各说一个数要好
                at_sec: None,
                duration_sec: None,
            }),
            // 两次都失败:报**第一次**的原因。第 0 秒那次的报文里往往只剩
            // 「没有帧」这种二阶症状,说不出真正的病因
            Err(_) => Err(first),
        },
        Err(e) => Err(e),
    }
}

/// stderr 尾部(报文要能进界面:太长的没人读,取最后几行就够定位)。
fn tail_of(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let tail: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .rev()
        .take(2)
        .collect();
    if tail.is_empty() {
        return "没有更多信息".into();
    }
    let mut s = tail.into_iter().rev().collect::<Vec<_>>().join("; ");
    if s.chars().count() > 200 {
        s = s.chars().take(200).collect::<String>() + "…";
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_offset_skips_the_slate_but_falls_back_on_short_clips() {
        // 常规素材:越过打板/黑头
        assert_eq!(
            frame_time_for(StillKind::VideoFrame, Some(5.0)),
            FRAME_AT_SEC
        );
        // 比偏移还短:必须回到 0,否则 -ss 越界会把能出画面的素材判成失败
        assert_eq!(frame_time_for(StillKind::VideoFrame, Some(0.4)), 0.0);
        assert_eq!(frame_time_for(StillKind::VideoFrame, Some(1.0)), 0.0);
        // 边界:恰好等于门槛按「够长」处理
        assert_eq!(
            frame_time_for(StillKind::VideoFrame, Some(MIN_DURATION_FOR_OFFSET)),
            FRAME_AT_SEC
        );
        // 时长未知:先按偏移试(extract 会在失败后回退 0)
        assert_eq!(frame_time_for(StillKind::VideoFrame, None), FRAME_AT_SEC);
        assert_eq!(
            frame_time_for(StillKind::VideoFrame, Some(f64::NAN)),
            FRAME_AT_SEC
        );
        // 静态图没有时间轴
        assert_eq!(frame_time_for(StillKind::HeifStill, Some(9.0)), 0.0);
    }

    #[test]
    fn extract_args_follow_the_house_discipline() {
        let p = Path::new("/nas/项目/1. 待分类/C0001.MP4");
        let a = extract_args(p, 1.0);
        assert!(a.contains(&"-nostdin".to_string()));
        assert!(!a.contains(&"-y".to_string()), "永不 -y");
        assert!(
            a.contains(&"-protocol_whitelist".to_string()) && a.contains(&"file".to_string()),
            "外部路径必须钉死 file 协议"
        );
        // -ss 必须在 -i 之前(快速关键帧定位)
        let ss = a.iter().position(|s| s == "-ss").expect("应有 -ss");
        let i = a.iter().position(|s| s == "-i").expect("应有 -i");
        assert!(ss < i, "-ss 要放在 -i 前面");
        assert_eq!(a[ss + 1], "1.000");
        // 输出:PNG 到 stdout,不落临时文件
        let n = a.len();
        assert_eq!(&a[n - 5..], &["-f", "image2", "-c:v", "png", "-"]);
        // 绝不写 -map:HEIC 拼贴网格要靠默认流组选择拼回整图
        assert!(!a.iter().any(|s| s == "-map"), "写死 -map 会只拿到一块拼贴");
        assert!(a.contains(&"-an".to_string()));
        // 路径原样进数组(不拼 shell),中文/空格都不需要转义
        assert!(a.contains(&p.to_string_lossy().to_string()));
    }

    #[test]
    fn zero_offset_omits_seek_entirely() {
        let a = extract_args(Path::new("/x/a.heic"), 0.0);
        assert!(!a.contains(&"-ss".to_string()), "静态图不该带 -ss");
    }

    /// 拼贴 HEIC 的整图尺寸只在 stream_groups 里;拿逐块尺寸当整图,
    /// 像素上限对 HEIC 就完全失效了。
    #[test]
    fn tile_grid_reports_whole_image_not_one_tile() {
        let json = r#"{
          "stream_groups": [{
            "index": 0, "type": "Tile Grid",
            "components": [{"nb_tiles": 12, "coded_width": 2048, "coded_height": 1536,
                            "width": 1920, "height": 1080}]
          }],
          "streams": [{"codec_type":"video","codec_name":"hevc","width":512,"height":512}]
        }"#;
        assert_eq!(tile_grid_dimensions(json), Some((1920, 1080)));
        // 没有拼贴网格时返回 None,调用方回落到流尺寸
        assert_eq!(
            tile_grid_dimensions(r#"{"stream_groups": [], "streams": []}"#),
            None
        );
        // 别的类型的流组不能误当拼贴网格
        assert_eq!(
            tile_grid_dimensions(
                r#"{"stream_groups":[{"type":"IAMF Audio Element",
                     "components":[{"width":9,"height":9}]}]}"#
            ),
            None
        );
        assert_eq!(tile_grid_dimensions("not json"), None);
    }

    /// 竖拍视频:ffmpeg 抽帧会摆正,probe 报的尺寸必须跟着摆正,
    /// 否则界面上的「原始尺寸」是躺倒的。
    #[test]
    fn rotation_is_read_and_normalized() {
        let with_rot = |r: &str| {
            format!(
                r#"{{"streams":[{{"codec_type":"video","codec_name":"h264",
                    "width":640,"height":360,
                    "side_data_list":[{{"side_data_type":"Display Matrix","rotation":{r}}}]}}]}}"#
            )
        };
        assert_eq!(display_rotation(&with_rot("90")), 90);
        assert_eq!(
            display_rotation(&with_rot("-90")),
            270,
            "负角要归一到 [0,360)"
        );
        assert_eq!(display_rotation(&with_rot("180")), 180);
        assert_eq!(display_rotation(&with_rot("-180")), 180);
        // 没有 side_data / 不是视频轨 / 坏 JSON 一律按不旋转
        assert_eq!(
            display_rotation(r#"{"streams":[{"codec_type":"video","width":9}]}"#),
            0
        );
        assert_eq!(
            display_rotation(
                r#"{"streams":[{"codec_type":"audio",
                    "side_data_list":[{"rotation":90}]}]}"#
            ),
            0,
            "音轨的 side_data 不能拿来转画面"
        );
        assert_eq!(display_rotation("not json"), 0);

        assert!(swaps_axes(90) && swaps_axes(270));
        assert!(!swaps_axes(0) && !swaps_axes(180));
    }

    /// 五类失败必须各说各的话,并且各自点名一个**不同的处置方向**。
    /// 含糊成一句「加载失败」正是这条 bug 的另一种形态。
    #[test]
    fn every_failure_class_says_something_different() {
        let all = [
            StillError::SidecarMissing("应用目录缺少 ffmpeg".into()),
            StillError::Corrupt {
                noun: "视频",
                detail: "moov atom not found".into(),
            },
            StillError::NoVideoStream { noun: "视频" },
            StillError::UnsupportedCodec {
                noun: "视频",
                codec: "vvc".into(),
            },
            StillError::Timeout {
                stage: "取画面",
                secs: 30,
            },
            StillError::Output {
                noun: "视频",
                detail: "0 字节".into(),
            },
        ];
        let texts: Vec<String> = all.iter().map(|e| e.to_string()).collect();
        // 各自点名了什么
        assert!(texts[0].contains("重新安装"), "{}", texts[0]);
        assert!(texts[1].contains("损坏"), "{}", texts[1]);
        assert!(texts[2].contains("没有视频轨"), "{}", texts[2]);
        assert!(
            texts[3].contains("vvc") && texts[3].contains("解码器"),
            "缺哪个解码器要点名: {}",
            texts[3]
        );
        assert!(texts[4].contains("30 秒"), "{}", texts[4]);
        for (i, a) in texts.iter().enumerate() {
            for b in texts.iter().skip(i + 1) {
                assert_ne!(a, b, "两类失败说了同一句话,等于没分类");
            }
        }
    }

    /// 「里面没有视频轨」必须和「文件坏了」分开:前者该去找原始素材,
    /// 后者该去回源盘核对。这条同时钉住 `parse_ffprobe_json` 的那句原话——
    /// 它一改,这里立刻红,而不是悄悄退化成「损坏」。
    #[test]
    fn no_video_stream_is_not_reported_as_corrupt() {
        let audio_only = r#"{"streams":[{"codec_type":"audio","codec_name":"aac"}],
                             "format":{"duration":"3.0"}}"#;
        let err = super::super::transcode::parse_ffprobe_json(audio_only).unwrap_err();
        assert!(
            err.contains("没有视频流"),
            "probe() 的分类判据依赖这句原话: {err}"
        );
    }

    #[test]
    fn stderr_tail_is_short_and_never_empty() {
        assert_eq!(tail_of(b""), "没有更多信息");
        assert_eq!(tail_of(b"  \n \n"), "没有更多信息");
        let many = (0..50)
            .map(|i| format!("line{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let t = tail_of(many.as_bytes());
        assert_eq!(t, "line48; line49", "只留尾部两行");
        let long = "x".repeat(500);
        assert!(tail_of(long.as_bytes()).chars().count() <= 201);
    }
}
