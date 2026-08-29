//! ffmpeg sidecar 底座(M3 W5,计划 T1.1/T1.2):
//! - sidecar 定位(捆绑于应用可执行文件旁;`OCARD_FFMPEG_DIR` 环境变量可覆盖,
//!   供 E2E/测试注入);缺失=可见 error,转码功能禁用态(零静默 `ffmpeg-missing`);
//! - 硬件编码**真探针**:`-f lavfi testsrc2` 实编数帧验退出码——
//!   `-encoders` 列出只代表编译进了,不代表驱动/设备可用(计划 B4);
//!   逐 encoder×pix_fmt 粒度(NVENC 存在 ≠ 支持 HEVC 10-bit);
//!   每个探针带超时+强杀(headless VAAPI 会挂死);
//! - 调用纪律(计划 B3):参数一律数组、绝不拼 shell;`-nostdin -hide_banner`;
//!   输出侧用 `-f null -` 或显式输出文件,**永不 `-y`**。

use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// 探针超时(单个 encoder)。
const PROBE_TIMEOUT: Duration = Duration::from_secs(12);

/// 测试内 `OCARD_FFMPEG_DIR` 的进程级互斥:env 是进程全局,并行测试
/// 同时改写会互相踩——所有触碰该变量的测试都必须先持有本锁。
#[cfg(test)]
pub(crate) static FFMPEG_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub const EXE_SUFFIX: &str = if cfg!(windows) { ".exe" } else { "" };

/// 定位 sidecar 二进制:`OCARD_FFMPEG_DIR` 覆盖优先(测试/E2E),
/// 否则应用可执行文件同目录(tauri externalBin 的落位处)。
pub fn sidecar_path(name: &str) -> Result<PathBuf, String> {
    let file = format!("{name}{EXE_SUFFIX}");
    if let Ok(dir) = std::env::var("OCARD_FFMPEG_DIR") {
        let p = PathBuf::from(dir).join(&file);
        return p
            .is_file()
            .then_some(p)
            .ok_or_else(|| format!("OCARD_FFMPEG_DIR 下找不到 {file}"));
    }
    let exe = std::env::current_exe().map_err(|e| format!("定位应用路径失败: {e}"))?;
    let dir = exe.parent().ok_or_else(|| "应用路径无父目录".to_string())?;
    let p = dir.join(&file);
    p.is_file()
        .then_some(p)
        .ok_or_else(|| format!("应用目录缺少 {file}(安装包可能损坏)"))
}

/// 带超时运行(超时强杀,绝不留僵尸;stdout/stderr 都收)。
///
/// **stdout/stderr 必须边跑边抽干**,不能只 `try_wait()` 轮询到进程退出再读:
/// 管道缓冲区在 macOS 上只有 64KiB,写满之后子进程会阻塞在 `write()` 上永远
/// 不退出,轮询方于是一路等到超时把一个**本来会成功**的调用判成失败。
/// 全屏预览抽一帧 4K 画面走 stdout 有 ~1MB,正好踩中这个坑(实测:一个
/// 8MiB 的 stdout 在纯轮询实现下 3 秒内不退出)。两条读线程各自抽干一路,
/// 是 `transcode::run` 早就在用的同一套办法。
pub fn run_with_timeout(
    bin: &PathBuf,
    args: &[&str],
    timeout: Duration,
) -> Result<std::process::Output, String> {
    use std::io::Read;

    let mut child = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动失败: {e}"))?;

    // take() 走 Option:超时分支要在不 move child 的前提下 kill 它
    fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
        let Some(mut p) = pipe else {
            return std::thread::spawn(Vec::new);
        };
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            // 读失败(进程被强杀)按「读到多少算多少」处理:错误分类靠退出码,
            // 不靠这里——为一次强杀丢掉已经读到的 stderr 反而说不清原因
            let _ = p.read_to_end(&mut buf);
            buf
        })
    }
    let out_thread = drain(child.stdout.take());
    let err_thread = drain(child.stderr.take());

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    // 强杀后管道关闭,两条读线程自然收尾;join 掉才不留悬挂线程
                    let _ = out_thread.join();
                    let _ = err_thread.join();
                    return Err(format!("超时({}s)已强杀", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = out_thread.join();
                let _ = err_thread.join();
                return Err(format!("等待进程失败: {e}"));
            }
        }
    };
    let stdout = out_thread.join().unwrap_or_default();
    let stderr = err_thread.join().unwrap_or_default();
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

/// 从 `ffmpeg -version` 首行提取版本号。
pub fn parse_version(first_line: &str) -> Option<String> {
    // 形如 "ffmpeg version n7.1-latest-... Copyright ..."
    let rest = first_line.strip_prefix("ffmpeg version ")?;
    Some(rest.split_whitespace().next()?.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegInfo {
    pub version: String,
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
}

/// 检测捆绑的 ffmpeg/ffprobe 是否可用。
pub fn detect() -> Result<FfmpegInfo, String> {
    let ffmpeg = sidecar_path("ffmpeg")?;
    let ffprobe = sidecar_path("ffprobe")?;
    let out = run_with_timeout(&ffmpeg, &["-hide_banner", "-version"], PROBE_TIMEOUT)?;
    if !out.status.success() {
        return Err("ffmpeg -version 退出码非零(二进制可能损坏)".into());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let version = text
        .lines()
        .next()
        .and_then(parse_version)
        .ok_or_else(|| "无法解析 ffmpeg 版本输出".to_string())?;
    Ok(FfmpegInfo {
        version,
        ffmpeg_path: ffmpeg.display().to_string(),
        ffprobe_path: ffprobe.display().to_string(),
    })
}

/* ------------------------------------------------------------------ *
 * 运行期**解码**能力清单
 * ------------------------------------------------------------------ */

/// 从 `ffmpeg -decoders` 的输出里挑出**视频**解码器名。
///
/// 纯函数,好让「这台机器到底解不解得了 X」的判据可以单测,而不必去凑一个
/// 缺 X 解码器的构建。表头到 ` ------ ` 为止,其后每行形如
/// ` V....D hevc                 HEVC (High Efficiency Video Coding)`;
/// 首列标志位以 `V` 开头的才是视频解码器。
pub fn parse_video_decoders(listing: &str) -> std::collections::BTreeSet<String> {
    let mut set = std::collections::BTreeSet::new();
    let mut started = false;
    for line in listing.lines() {
        if !started {
            // 分隔行只有一串短横;在它之前的都是图例
            started = line.trim() == "------";
            continue;
        }
        let mut it = line.split_whitespace();
        let (Some(flags), Some(name)) = (it.next(), it.next()) else {
            continue;
        };
        if flags.starts_with('V') {
            set.insert(name.to_string());
        }
    }
    set
}

/// 本次进程内缓存的解码器清单(键是 ffmpeg 路径:E2E 会换 sidecar 目录)。
static DECODERS: std::sync::OnceLock<
    std::sync::Mutex<
        std::collections::HashMap<PathBuf, std::sync::Arc<std::collections::BTreeSet<String>>>,
    >,
> = std::sync::OnceLock::new();

/// 这台机器上**打包进来的** ffmpeg 到底带了哪些视频解码器。
///
/// 为什么必须是运行期探测而不是编译期常量:三平台的 sidecar 是各自下载的
/// 构建,裁剪程度不一样——写死「支持 HEVC」在某个精简构建上就是骗人,
/// 写死「不支持」又会白白拒掉一堆本来能看的素材。口径与 `probe_capabilities()`
/// 的真探针一致:问二进制自己,不问源码。
///
/// 结果按二进制路径缓存:清单是固定的,而每开一次全屏预览都 spawn 一次
/// `-decoders` 太浪费。
pub fn video_decoders(
    ffmpeg: &PathBuf,
) -> Result<std::sync::Arc<std::collections::BTreeSet<String>>, String> {
    let map = DECODERS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    {
        let guard = map.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(hit) = guard.get(ffmpeg) {
            return Ok(hit.clone());
        }
    }
    let out = run_with_timeout(ffmpeg, &["-hide_banner", "-decoders"], PROBE_TIMEOUT)?;
    if !out.status.success() {
        return Err("ffmpeg -decoders 退出码非零(二进制可能损坏)".into());
    }
    let set = std::sync::Arc::new(parse_video_decoders(&String::from_utf8_lossy(&out.stdout)));
    map.lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(ffmpeg.clone(), set.clone());
    Ok(set)
}

/// 一个待探测的编码能力(encoder × 像素格式)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderCandidate {
    /// 稳定能力键,如 "h264_hw"、"hevc10_hw"、"h264_sw"。
    pub capability: &'static str,
    pub encoder: &'static str,
    pub pix_fmt: &'static str,
    /// VAAPI 需要的额外输入侧参数(设备+hwupload)。
    #[serde(skip)]
    pub extra_in: &'static [&'static str],
    #[serde(skip)]
    pub extra_filter: &'static [&'static str],
}

/// 平台候选表:探测顺序即优先级,同 capability 首个成功者胜出。
pub fn candidates() -> Vec<EncoderCandidate> {
    let mut v: Vec<EncoderCandidate> = Vec::new();
    let c = |capability, encoder, pix_fmt| EncoderCandidate {
        capability,
        encoder,
        pix_fmt,
        extra_in: &[],
        extra_filter: &[],
    };
    if cfg!(target_os = "macos") {
        v.push(c("h264_hw", "h264_videotoolbox", "yuv420p"));
        v.push(c("hevc_hw", "hevc_videotoolbox", "yuv420p"));
        v.push(c("hevc10_hw", "hevc_videotoolbox", "p010le"));
    }
    if cfg!(target_os = "windows") {
        for (cap, enc, fmt) in [
            ("h264_hw", "h264_nvenc", "yuv420p"),
            ("h264_hw", "h264_qsv", "yuv420p"),
            ("h264_hw", "h264_amf", "yuv420p"),
            ("hevc_hw", "hevc_nvenc", "yuv420p"),
            ("hevc_hw", "hevc_qsv", "yuv420p"),
            ("hevc_hw", "hevc_amf", "yuv420p"),
            ("hevc10_hw", "hevc_nvenc", "p010le"),
            ("hevc10_hw", "hevc_qsv", "p010le"),
            ("hevc10_hw", "hevc_amf", "p010le"),
        ] {
            v.push(c(cap, enc, fmt));
        }
    }
    if cfg!(target_os = "linux") {
        let vaapi_in: &'static [&'static str] = &[
            "-init_hw_device",
            "vaapi=va:/dev/dri/renderD128",
            "-filter_hw_device",
            "va",
        ];
        let vaapi_filter: &'static [&'static str] = &["-vf", "format=nv12,hwupload"];
        for (cap, enc) in [("h264_hw", "h264_vaapi"), ("hevc_hw", "hevc_vaapi")] {
            v.push(EncoderCandidate {
                capability: cap,
                encoder: enc,
                pix_fmt: "nv12",
                extra_in: vaapi_in,
                extra_filter: vaapi_filter,
            });
        }
        v.push(c("h264_hw", "h264_nvenc", "yuv420p"));
        v.push(c("hevc_hw", "hevc_nvenc", "yuv420p"));
        v.push(c("hevc10_hw", "hevc_nvenc", "p010le"));
    }
    // 软编回落(也要真探测:极端裁剪构建可能缺 libx26x)
    v.push(c("h264_sw", "libx264", "yuv420p"));
    v.push(c("hevc_sw", "libx265", "yuv420p"));
    v.push(c("hevc10_sw", "libx265", "yuv420p10le"));
    v
}

/// 构造一次真探针的参数(纯函数,可测)。
pub fn probe_args(cand: &EncoderCandidate) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-v".into(),
        "error".into(),
    ];
    args.extend(cand.extra_in.iter().map(|s| s.to_string()));
    args.extend([
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        "testsrc2=duration=0.2:size=320x240:rate=30".into(),
    ]);
    if cand.extra_filter.is_empty() {
        args.extend(["-pix_fmt".into(), cand.pix_fmt.into()]);
    } else {
        args.extend(cand.extra_filter.iter().map(|s| s.to_string()));
    }
    args.extend([
        "-c:v".into(),
        cand.encoder.into(),
        "-frames:v".into(),
        "3".into(),
        "-f".into(),
        "null".into(),
        "-".into(),
    ]);
    args
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityReport {
    pub ffmpeg: FfmpegInfo,
    /// capability 键 → 胜出 encoder(如 "hevc10_hw" → "hevc_nvenc")。
    pub winners: std::collections::BTreeMap<String, String>,
    /// 逐候选探测明细(设置页「能力」区与诊断导出用)。
    pub probes: Vec<(String, String, bool)>,
    pub probed_at: String,
}

/// 跑全套真探针(串行,单个 ≤12s;首个成功者代表该 capability)。
pub fn probe_capabilities() -> Result<CapabilityReport, String> {
    let info = detect()?;
    let ffmpeg = PathBuf::from(&info.ffmpeg_path);
    let mut winners = std::collections::BTreeMap::new();
    let mut probes = Vec::new();
    for cand in candidates() {
        if winners.contains_key(cand.capability) {
            continue; // 该能力已有胜出者
        }
        let args = probe_args(&cand);
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let ok = matches!(
            run_with_timeout(&ffmpeg, &arg_refs, PROBE_TIMEOUT),
            Ok(out) if out.status.success()
        );
        probes.push((cand.capability.to_string(), cand.encoder.to_string(), ok));
        if ok {
            winners.insert(cand.capability.to_string(), cand.encoder.to_string());
        }
    }
    Ok(CapabilityReport {
        ffmpeg: info,
        winners,
        probes,
        probed_at: chrono::Utc::now().to_rfc3339(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_parsing() {
        assert_eq!(
            parse_version("ffmpeg version n7.1-latest-win64-gpl-7.1 Copyright (c)").as_deref(),
            Some("n7.1-latest-win64-gpl-7.1")
        );
        assert_eq!(
            parse_version("ffmpeg version 7.1.1 Copyright").as_deref(),
            Some("7.1.1")
        );
        assert!(parse_version("garbage").is_none());
    }

    #[test]
    fn probe_args_discipline() {
        for cand in candidates() {
            let args = probe_args(&cand);
            // 纪律:必须 -nostdin;绝不 -y;输出走 -f null -
            assert!(args.contains(&"-nostdin".to_string()));
            assert!(!args.contains(&"-y".to_string()));
            let n = args.len();
            assert_eq!(&args[n - 3..], &["-f", "null", "-"]);
            assert!(args.contains(&cand.encoder.to_string()));
        }
    }

    /// 解码器清单靠**问二进制自己**,不靠编译期常量。这里钉住的是解析:
    /// 表头图例不能被当成解码器,音频/字幕行不能混进视频清单。
    #[test]
    fn decoder_listing_parses_only_video_rows() {
        let listing = "\
Decoders:
 V..... = Video
 A..... = Audio
 ------
 V....D hevc                 HEVC (High Efficiency Video Coding)
 V....D av1                  Alliance for Open Media AV1
 VFS..D h264                 H.264 / AVC
 A....D aac                  AAC (Advanced Audio Coding)
 S..... subrip               SubRip subtitle
";
        let set = parse_video_decoders(listing);
        assert!(set.contains("hevc") && set.contains("av1") && set.contains("h264"));
        assert!(!set.contains("aac"), "音频解码器不能混进视频清单");
        assert!(!set.contains("subrip"));
        // 图例行(`V..... = Video`)在分隔线之前,绝不能被当成一个叫「=」的解码器
        assert!(!set.contains("="));
        assert_eq!(set.len(), 3);
        // 没有分隔线时一条都不认(宁可答不上来,也别编一份假清单出来)
        assert!(parse_video_decoders("garbage\n V....D hevc x").is_empty());
    }

    #[test]
    fn candidates_always_include_software_fallback() {
        let caps: Vec<_> = candidates().iter().map(|c| c.capability).collect();
        assert!(caps.contains(&"h264_sw"));
        assert!(caps.contains(&"hevc_sw"));
        assert!(caps.contains(&"hevc10_sw"));
    }

    /// 回归:stdout 超过管道缓冲区(macOS 64KiB)时**必须照样跑完**。
    ///
    /// 只 `try_wait()` 轮询、不抽干管道的实现会在这里挂死——子进程阻塞在
    /// `write()` 上永不退出,调用方一路等到超时,把一个本来会成功的调用
    /// 判成失败。全屏预览抽一帧 4K 画面走 stdout 正好有 ~1MB,踩的就是这个。
    /// (把 `drain` 那两条读线程去掉,本用例立刻变红。)
    #[cfg(unix)]
    #[test]
    fn run_with_timeout_drains_stdout_larger_than_the_pipe_buffer() {
        let dd = PathBuf::from("/bin/dd");
        let out = run_with_timeout(
            &dd,
            &["if=/dev/zero", "bs=1048576", "count=8"],
            Duration::from_secs(20),
        )
        .expect("8MiB 的 stdout 不该把调用拖到超时");
        assert!(out.status.success());
        assert_eq!(out.stdout.len(), 8 * 1024 * 1024, "stdout 必须一个字节不少");
        // stderr 同样要收上来(dd 把统计信息写在 stderr)
        assert!(!out.stderr.is_empty(), "stderr 也要抽干");
    }

    #[cfg(unix)]
    #[test]
    fn run_with_timeout_kills_hung_process() {
        let sleep = PathBuf::from("/bin/sleep");
        let start = Instant::now();
        let err = run_with_timeout(&sleep, &["30"], Duration::from_millis(300)).unwrap_err();
        assert!(err.contains("超时"), "{err}");
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "必须强杀,不许等满"
        );
    }

    #[test]
    fn sidecar_env_override_and_missing_are_explicit() {
        let _g = super::FFMPEG_ENV_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        // 不存在的目录:错误信息可见(零静默),不 panic
        std::env::set_var("OCARD_FFMPEG_DIR", "/nonexistent-ocard-test");
        let err = sidecar_path("ffmpeg").unwrap_err();
        assert!(err.contains("找不到"));
        std::env::remove_var("OCARD_FFMPEG_DIR");
    }
}
