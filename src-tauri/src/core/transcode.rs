//! 转码引擎核心(M3 W6,PRD §5.6):
//! - ffprobe 媒体信息解析(JSON);
//! - 「高负载素材判定」(计划 B6:不叫 Log 判定——元数据读不出 S-Log 之流,
//!   规则显式、逐文件给理由、跳过件必须可见);
//! - 代理/归档参数构造(纯函数;逐 backend 质量映射表);
//! - `-progress pipe:1` 解析(out_time_us 优先、progress=end 判终);
//! - 执行器:stderr/stdout 双读线程 + 看门狗(取消不依赖 progress 行,
//!   4h 总时长上限强杀)、staging 带机器标识、落位前 ffprobe 验证
//!   (codec/高度/pix_fmt/音频存在性/时长;色彩标签未纳入,属声明边界);
//! - 幂等:输出已存在 = `already-transcoded` skip;覆盖唯一入口=显式
//!   `retranscode`(前端二次确认,先删后转)——均已接线(计划 D2)。

use super::ffmpeg;
use serde::{Deserialize, Serialize};
use std::sync::Mutex as StdMutex;

/// 活跃 ffmpeg 子进程登记(强退路径 kill/reap 用,计划 D2/评审 #18)。
static ACTIVE_CHILDREN: StdMutex<Vec<u32>> = StdMutex::new(Vec::new());

fn register_child(pid: u32) {
    ACTIVE_CHILDREN
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .push(pid);
}

fn unregister_child(pid: u32) {
    ACTIVE_CHILDREN
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .retain(|p| *p != pid);
}

/// 强退清场:杀掉全部登记的 ffmpeg 子进程(半成品 staging 由下次作业清理)。
pub fn kill_all_children() {
    let pids: Vec<u32> = ACTIVE_CHILDREN
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .drain(..)
        .collect();
    for pid in pids {
        #[cfg(unix)]
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output();
        }
    }
}
use std::path::{Path, PathBuf};
use std::time::Duration;

/// ffprobe 出的媒体信息(转码判定所需的子集)。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub pix_fmt: String,
    pub bit_rate: Option<u64>,
    pub duration_secs: Option<f64>,
    pub color_transfer: Option<String>,
    pub has_audio: bool,
}

/// 解析 `ffprobe -print_format json -show_format -show_streams` 输出(纯函数)。
pub fn parse_ffprobe_json(json_text: &str) -> Result<MediaInfo, String> {
    #[derive(Deserialize)]
    struct Stream {
        codec_type: Option<String>,
        codec_name: Option<String>,
        width: Option<u32>,
        height: Option<u32>,
        pix_fmt: Option<String>,
        color_transfer: Option<String>,
        bit_rate: Option<String>,
    }
    #[derive(Deserialize)]
    struct Format {
        duration: Option<String>,
        bit_rate: Option<String>,
    }
    #[derive(Deserialize)]
    struct Root {
        streams: Option<Vec<Stream>>,
        format: Option<Format>,
    }
    let root: Root =
        serde_json::from_str(json_text).map_err(|e| format!("ffprobe 输出解析失败: {e}"))?;
    let streams = root.streams.unwrap_or_default();
    let video = streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video"))
        .ok_or("没有视频流")?;
    let has_audio = streams
        .iter()
        .any(|s| s.codec_type.as_deref() == Some("audio"));
    let fmt = root.format;
    let bit_rate = video
        .bit_rate
        .as_deref()
        .or(fmt.as_ref().and_then(|f| f.bit_rate.as_deref()))
        .and_then(|s| s.parse::<u64>().ok());
    Ok(MediaInfo {
        codec: video.codec_name.clone().unwrap_or_default(),
        width: video.width.unwrap_or(0),
        height: video.height.unwrap_or(0),
        pix_fmt: video.pix_fmt.clone().unwrap_or_default(),
        bit_rate,
        duration_secs: fmt
            .as_ref()
            .and_then(|f| f.duration.as_deref())
            .and_then(|s| s.parse::<f64>().ok()),
        color_transfer: video.color_transfer.clone(),
        has_audio,
    })
}

/// 对一个文件跑 ffprobe。
pub fn probe_file(ffprobe: &PathBuf, file: &Path) -> Result<MediaInfo, String> {
    let out = ffmpeg::run_with_timeout(
        ffprobe,
        &[
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            &file.to_string_lossy(),
        ],
        Duration::from_secs(30),
    )?;
    if !out.status.success() {
        return Err(format!(
            "ffprobe 失败: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    parse_ffprobe_json(&String::from_utf8_lossy(&out.stdout))
}

/// 高负载判定(计划 B6):规则显式,逐文件给理由;错判方向偏保守(多转不漏)。
/// 「整夹强制全转」由命令层参数承担。
pub fn heavy_verdict(info: &MediaInfo) -> Vec<String> {
    let mut reasons = Vec::new();
    let ct = info.color_transfer.as_deref().unwrap_or("");
    if ct == "arib-std-b67" {
        reasons.push("HLG 色彩传递(需要色调映射预览)".to_string());
    }
    if ct == "smpte2084" {
        reasons.push("PQ/HDR 色彩传递".to_string());
    }
    if info.pix_fmt.contains("10le")
        || info.pix_fmt.contains("10be")
        || info.pix_fmt.contains("422")
    {
        reasons.push(format!("高位深/高采样像素格式({})", info.pix_fmt));
    }
    if matches!(info.codec.as_str(), "prores" | "dnxhd" | "mpeg2video") {
        reasons.push(format!("中间编码格式({})", info.codec));
    }
    if let Some(br) = info.bit_rate {
        if br >= 100_000_000 {
            reasons.push(format!("高码率({} Mbps)", br / 1_000_000));
        }
    }
    if info.height > 2160 || info.width > 4096 {
        reasons.push(format!("超高分辨率({}×{})", info.width, info.height));
    }
    reasons
}

/// 归档三档(PRD §5.6:高质量/平衡/高压缩)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveTier {
    Quality,
    Balanced,
    Compact,
}

/// 逐 backend 质量映射表(计划复审 #5:不能把 CRF 机械映射成固定码率)。
/// 输出不变量:同 tier 下视觉质量近似;具体参数逐 backend 记录于此。
pub fn quality_args(encoder: &str, tier: ArchiveTier) -> Vec<String> {
    let s = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    match encoder {
        // 软编:CRF 语义
        "libx265" => match tier {
            ArchiveTier::Quality => s(&["-crf", "18", "-preset", "medium"]),
            ArchiveTier::Balanced => s(&["-crf", "23", "-preset", "medium"]),
            ArchiveTier::Compact => s(&["-crf", "28", "-preset", "medium"]),
        },
        "libx264" => match tier {
            ArchiveTier::Quality => s(&["-crf", "18", "-preset", "medium"]),
            ArchiveTier::Balanced => s(&["-crf", "23", "-preset", "medium"]),
            ArchiveTier::Compact => s(&["-crf", "28", "-preset", "medium"]),
        },
        // NVENC:恒定质量 -cq(数值与 CRF 感知近似档)
        e if e.ends_with("_nvenc") => match tier {
            ArchiveTier::Quality => s(&["-rc", "vbr", "-cq", "19", "-preset", "p5"]),
            ArchiveTier::Balanced => s(&["-rc", "vbr", "-cq", "24", "-preset", "p5"]),
            ArchiveTier::Compact => s(&["-rc", "vbr", "-cq", "29", "-preset", "p5"]),
        },
        // QSV:global_quality(ICQ)
        e if e.ends_with("_qsv") => match tier {
            ArchiveTier::Quality => s(&["-global_quality", "19"]),
            ArchiveTier::Balanced => s(&["-global_quality", "24"]),
            ArchiveTier::Compact => s(&["-global_quality", "29"]),
        },
        // AMF:qp 三元组
        e if e.ends_with("_amf") => match tier {
            ArchiveTier::Quality => s(&["-rc", "cqp", "-qp_i", "19", "-qp_p", "21"]),
            ArchiveTier::Balanced => s(&["-rc", "cqp", "-qp_i", "24", "-qp_p", "26"]),
            ArchiveTier::Compact => s(&["-rc", "cqp", "-qp_i", "29", "-qp_p", "31"]),
        },
        // VideoToolbox:质量标度 0-100
        e if e.ends_with("_videotoolbox") => match tier {
            ArchiveTier::Quality => s(&["-q:v", "65"]),
            ArchiveTier::Balanced => s(&["-q:v", "50"]),
            ArchiveTier::Compact => s(&["-q:v", "38"]),
        },
        // VAAPI:qp
        e if e.ends_with("_vaapi") => match tier {
            ArchiveTier::Quality => s(&["-qp", "19"]),
            ArchiveTier::Balanced => s(&["-qp", "24"]),
            ArchiveTier::Compact => s(&["-qp", "29"]),
        },
        _ => s(&["-crf", "23"]),
    }
}

/// 代理转码参数(1080p H.264 + AAC;`-n` 绝不覆盖)。纯函数可测。
pub fn proxy_args(src: &Path, encoder: &str, dst_tmp: &Path) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-v".into(),
        "error".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-n".into(),
    ];
    // VAAPI 需要设备初始化 + hwupload 滤镜链(评审 #22:否则 Linux 硬编必然白跑)
    if encoder.ends_with("_vaapi") {
        a.extend([
            "-init_hw_device".into(),
            "vaapi=va:/dev/dri/renderD128".into(),
            "-filter_hw_device".into(),
            "va".into(),
        ]);
    }
    a.extend(["-i".into(), src.to_string_lossy().into_owned()]);
    if encoder.ends_with("_vaapi") {
        a.extend([
            "-vf".into(),
            "format=nv12,hwupload,scale_vaapi=w=-2:h=1080".into(),
        ]);
    } else {
        a.extend(["-vf".into(), "scale=-2:1080".into()]);
    }
    a.extend(["-c:v".into(), encoder.into()]);
    // 代理码率档:硬编给显式码率,软编 CRF(代理不追求极致,统一观感即可)
    if encoder == "libx264" {
        a.extend(["-crf".into(), "22".into(), "-preset".into(), "fast".into()]);
    } else {
        a.extend(["-b:v".into(), "10M".into(), "-maxrate".into(), "16M".into()]);
    }
    if !encoder.ends_with("_vaapi") {
        a.extend(["-pix_fmt".into(), "yuv420p".into()]);
    }
    a.extend([
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "192k".into(),
        dst_tmp.to_string_lossy().into_owned(),
    ]);
    a
}

/// 归档转码参数(HEVC 10-bit 三档;源为 8-bit 时保持 8-bit)。
pub fn archive_args(
    src: &Path,
    encoder: &str,
    tier: ArchiveTier,
    ten_bit: bool,
    dst_tmp: &Path,
) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-v".into(),
        "error".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-n".into(),
        "-i".into(),
        src.to_string_lossy().into_owned(),
        "-c:v".into(),
        encoder.into(),
    ];
    a.extend(quality_args(encoder, tier));
    let pix = if ten_bit {
        if encoder.starts_with("lib") {
            "yuv420p10le"
        } else {
            "p010le"
        }
    } else {
        "yuv420p"
    };
    a.extend([
        "-pix_fmt".into(),
        pix.into(),
        "-c:a".into(),
        "copy".into(),
        dst_tmp.to_string_lossy().into_owned(),
    ]);
    a
}

/// `-progress pipe:1` 行解析(纯函数)。
#[derive(Debug, Clone, PartialEq)]
pub enum ProgressLine {
    /// 已输出时长(微秒)。
    OutTimeUs(u64),
    End,
    Other,
}

pub fn parse_progress_line(line: &str) -> ProgressLine {
    if let Some(v) = line.strip_prefix("out_time_us=") {
        return v
            .trim()
            .parse::<u64>()
            .map(ProgressLine::OutTimeUs)
            .unwrap_or(ProgressLine::Other);
    }
    if line.trim() == "progress=end" {
        return ProgressLine::End;
    }
    ProgressLine::Other
}

/// 落位前输出验证(计划复审 #5 全量):codec/高度/pix_fmt/音频/时长。
pub fn verify_output(
    out_info: &MediaInfo,
    expect_codec: &str,
    expect_height: Option<u32>,
    expect_pix_fmt: &str,
    src_info: &MediaInfo,
) -> Result<(), String> {
    if out_info.codec != expect_codec {
        return Err(format!(
            "输出编码不符:期望 {expect_codec},实际 {}",
            out_info.codec
        ));
    }
    if let Some(h) = expect_height {
        if out_info.height != h && src_info.height > h {
            return Err(format!("输出高度不符:期望 {h},实际 {}", out_info.height));
        }
    }
    if out_info.pix_fmt != expect_pix_fmt {
        return Err(format!(
            "输出像素格式不符:期望 {expect_pix_fmt},实际 {}",
            out_info.pix_fmt
        ));
    }
    if src_info.has_audio && !out_info.has_audio {
        return Err("源有音频但输出缺失音频流".into());
    }
    if let (Some(a), Some(b)) = (src_info.duration_secs, out_info.duration_secs) {
        if (a - b).abs() > 1.0 {
            return Err(format!("输出时长偏差过大:源 {a:.2}s,输出 {b:.2}s"));
        }
    }
    Ok(())
}

/// 执行一次转码:stdout 解析进度(回调),stderr 并发消费(尾部留错误报文),
/// cancel() 为真时强杀并清理 tmp。
pub fn run_transcode(
    ffmpeg_bin: &PathBuf,
    args: &[String],
    tmp_out: &Path,
    total_duration_secs: Option<f64>,
    mut on_progress: impl FnMut(Option<f32>),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    use std::io::{BufRead, BufReader, Read};
    use std::process::{Command, Stdio};
    let mut child = Command::new(ffmpeg_bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 ffmpeg 失败: {e}"))?;
    let child_pid = child.id();
    register_child(child_pid);
    // 任何返回路径都要注销登记
    struct Unregister(u32);
    impl Drop for Unregister {
        fn drop(&mut self) {
            unregister_child(self.0);
        }
    }
    let _unreg = Unregister(child_pid);

    // stderr 并发消费(计划 B5 首坑:不读会填满管道死锁),尾部 4KB 留作错误报文
    let mut stderr = child.stderr.take().unwrap();
    let err_tail = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
    let err_tail2 = err_tail.clone();
    let err_thread = std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = stderr.read(&mut buf) {
            if n == 0 {
                break;
            }
            let mut tail = err_tail2.lock().unwrap_or_else(|p| p.into_inner());
            tail.extend_from_slice(&buf[..n]);
            let len = tail.len();
            if len > 4096 {
                tail.drain(0..len - 4096);
            }
        }
    });

    // stdout 也走独立读线程 + 通道:取消/看门狗不依赖 ffmpeg 吐 progress
    // (评审 #21:卡死不吐行时取消要能生效,并设总时长上限)
    let stdout = child.stdout.take().unwrap();
    let (line_tx, line_rx) = std::sync::mpsc::channel::<String>();
    let out_thread = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line_tx.send(line).is_err() {
                break;
            }
        }
    });
    const MAX_WALL: Duration = Duration::from_secs(4 * 3600);
    let started = std::time::Instant::now();
    let mut saw_end = false;
    let status = loop {
        if cancelled() || started.elapsed() > MAX_WALL {
            let timed_out = started.elapsed() > MAX_WALL;
            let _ = child.kill();
            let _ = child.wait();
            drop(line_rx);
            let _ = out_thread.join();
            let _ = err_thread.join();
            let _ = std::fs::remove_file(tmp_out);
            return Err(if timed_out {
                format!("转码超时({}h 上限)已强杀", MAX_WALL.as_secs() / 3600)
            } else {
                "已取消".into()
            });
        }
        match line_rx.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => match parse_progress_line(&line) {
                ProgressLine::OutTimeUs(us) => {
                    let frac = total_duration_secs
                        .filter(|d| *d > 0.0)
                        .map(|d| ((us as f64 / 1_000_000.0) / d).clamp(0.0, 1.0) as f32);
                    on_progress(frac); // None = 不确定态(无时长流)
                }
                ProgressLine::End => saw_end = true,
                ProgressLine::Other => {}
            },
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if let Ok(Some(st)) = child.try_wait() {
                    break st;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                break child.wait().map_err(|e| format!("等待 ffmpeg 失败: {e}"))?;
            }
        }
        if let Ok(Some(st)) = child.try_wait() {
            // 进程已退:清空余量行再收尾
            while let Ok(line) = line_rx.try_recv() {
                if parse_progress_line(&line) == ProgressLine::End {
                    saw_end = true;
                }
            }
            break st;
        }
    };
    let _ = out_thread.join();
    let _ = err_thread.join();
    if cancelled() {
        let _ = std::fs::remove_file(tmp_out);
        return Err("已取消".into());
    }
    if !status.success() || !saw_end {
        let tail = err_tail.lock().unwrap_or_else(|p| p.into_inner());
        let msg = String::from_utf8_lossy(&tail);
        let _ = std::fs::remove_file(tmp_out);
        return Err(format!(
            "ffmpeg 退出异常(end={saw_end}): {}",
            msg.trim()
                .chars()
                .rev()
                .take(600)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        ));
    }
    Ok(())
}

/// 硬编运行时失败是否值得软编重试(初始化/设备/不支持类错误,计划复审 #5)。
pub fn is_hw_init_failure(err: &str) -> bool {
    let e = err.to_lowercase();
    [
        "cannot load",
        "no capable devices",
        "not supported",
        "failed to initialise",
        "failed to initialize",
        "device creation failed",
        "generic error in an external library",
        "unsupported",
    ]
    .iter()
    .any(|k| e.contains(k))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffprobe_json_parsing() {
        let j = r#"{"streams":[
            {"codec_type":"video","codec_name":"prores","width":3840,"height":2160,
             "pix_fmt":"yuv422p10le","color_transfer":"arib-std-b67","bit_rate":"220000000"},
            {"codec_type":"audio","codec_name":"pcm_s16le"}],
            "format":{"duration":"12.5","bit_rate":"230000000"}}"#;
        let info = parse_ffprobe_json(j).unwrap();
        assert_eq!(info.codec, "prores");
        assert_eq!((info.width, info.height), (3840, 2160));
        assert!(info.has_audio);
        assert_eq!(info.duration_secs, Some(12.5));
        assert_eq!(info.color_transfer.as_deref(), Some("arib-std-b67"));

        assert!(
            parse_ffprobe_json(r#"{"streams":[]}"#).is_err(),
            "无视频流要报错"
        );
        assert!(parse_ffprobe_json("not json").is_err());
    }

    #[test]
    fn heavy_verdict_reasons_are_explicit() {
        let mut info = MediaInfo {
            codec: "prores".into(),
            pix_fmt: "yuv422p10le".into(),
            color_transfer: Some("arib-std-b67".into()),
            bit_rate: Some(220_000_000),
            ..Default::default()
        };
        let reasons = heavy_verdict(&info);
        assert!(reasons.len() >= 4, "{reasons:?}");
        // 普通 8-bit H.264 低码率:不判高负载
        info = MediaInfo {
            codec: "h264".into(),
            pix_fmt: "yuv420p".into(),
            bit_rate: Some(50_000_000),
            width: 3840,
            height: 2160,
            ..Default::default()
        };
        assert!(heavy_verdict(&info).is_empty());
    }

    #[test]
    fn args_discipline_no_overwrite_and_array_form() {
        let src = Path::new("/in/a.mov");
        let tmp = Path::new("/out/.m.j.transpart.mp4");
        for args in [
            proxy_args(src, "h264_videotoolbox", tmp),
            proxy_args(src, "libx264", tmp),
            archive_args(src, "libx265", ArchiveTier::Balanced, true, tmp),
            archive_args(src, "hevc_nvenc", ArchiveTier::Quality, false, tmp),
        ] {
            assert!(args.contains(&"-nostdin".to_string()));
            assert!(args.contains(&"-n".to_string()), "必须 -n 防覆盖");
            assert!(!args.contains(&"-y".to_string()), "永不 -y");
            assert!(args.contains(&"-progress".to_string()));
        }
        // 10-bit 软编与硬编的像素格式各自正确
        let a = archive_args(src, "libx265", ArchiveTier::Quality, true, tmp);
        assert!(a.contains(&"yuv420p10le".to_string()));
        let b = archive_args(src, "hevc_nvenc", ArchiveTier::Quality, true, tmp);
        assert!(b.contains(&"p010le".to_string()));
    }

    #[test]
    fn quality_mapping_covers_all_backends() {
        for enc in [
            "libx265",
            "hevc_nvenc",
            "hevc_qsv",
            "hevc_amf",
            "hevc_videotoolbox",
            "hevc_vaapi",
        ] {
            for tier in [
                ArchiveTier::Quality,
                ArchiveTier::Balanced,
                ArchiveTier::Compact,
            ] {
                assert!(!quality_args(enc, tier).is_empty(), "{enc}");
            }
        }
    }

    #[test]
    fn progress_line_parsing() {
        assert_eq!(
            parse_progress_line("out_time_us=1500000"),
            ProgressLine::OutTimeUs(1_500_000)
        );
        assert_eq!(parse_progress_line("progress=end"), ProgressLine::End);
        assert_eq!(parse_progress_line("frame=42"), ProgressLine::Other);
        assert_eq!(parse_progress_line("out_time_us=N/A"), ProgressLine::Other);
    }

    #[test]
    fn output_verification_matrix() {
        let src = MediaInfo {
            duration_secs: Some(10.0),
            has_audio: true,
            height: 2160,
            ..Default::default()
        };
        let good = MediaInfo {
            codec: "h264".into(),
            height: 1080,
            pix_fmt: "yuv420p".into(),
            duration_secs: Some(10.3),
            has_audio: true,
            ..Default::default()
        };
        assert!(verify_output(&good, "h264", Some(1080), "yuv420p", &src).is_ok());
        // 五类失配逐一红
        let mut bad = good.clone();
        bad.codec = "hevc".into();
        assert!(verify_output(&bad, "h264", Some(1080), "yuv420p", &src).is_err());
        bad = good.clone();
        bad.height = 720;
        assert!(verify_output(&bad, "h264", Some(1080), "yuv420p", &src).is_err());
        bad = good.clone();
        bad.pix_fmt = "yuv422p".into();
        assert!(verify_output(&bad, "h264", Some(1080), "yuv420p", &src).is_err());
        bad = good.clone();
        bad.has_audio = false;
        assert!(verify_output(&bad, "h264", Some(1080), "yuv420p", &src).is_err());
        bad = good.clone();
        bad.duration_secs = Some(7.0);
        assert!(verify_output(&bad, "h264", Some(1080), "yuv420p", &src).is_err());
    }

    #[test]
    fn hw_init_failure_classifier() {
        assert!(is_hw_init_failure("Cannot load nvcuda.dll"));
        assert!(is_hw_init_failure("No capable devices found"));
        assert!(!is_hw_init_failure(
            "Invalid data found when processing input"
        ));
    }
}
