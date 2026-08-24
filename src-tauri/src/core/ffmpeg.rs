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
pub fn run_with_timeout(
    bin: &PathBuf,
    args: &[&str],
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let mut child = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动失败: {e}"))?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|e| format!("读取输出失败: {e}"));
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("超时({}s)已强杀", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("等待进程失败: {e}")),
        }
    }
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

    #[test]
    fn candidates_always_include_software_fallback() {
        let caps: Vec<_> = candidates().iter().map(|c| c.capability).collect();
        assert!(caps.contains(&"h264_sw"));
        assert!(caps.contains(&"hevc_sw"));
        assert!(caps.contains(&"hevc10_sw"));
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
        // 不存在的目录:错误信息可见(零静默),不 panic
        std::env::set_var("OCARD_FFMPEG_DIR", "/nonexistent-ocard-test");
        let err = sidecar_path("ffmpeg").unwrap_err();
        assert!(err.contains("找不到"));
        std::env::remove_var("OCARD_FFMPEG_DIR");
    }
}
