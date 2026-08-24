//! 转码底座命令层(M3 W5):sidecar 状态、硬编能力探测(后台线程+缓存)、
//! 诊断导出。转码作业本体在 W6。

use super::notify;
use crate::core::ffmpeg::{self, CapabilityReport};
use serde::Serialize;
use std::sync::Mutex;
use tauri::AppHandle;

type CmdResult<T> = std::result::Result<T, String>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum FfmpegStatusDto {
    /// sidecar 可用。
    Ready { info: ffmpeg::FfmpegInfo },
    /// sidecar 缺失/损坏:转码功能禁用态(零静默)。
    Missing { error: String },
}

/// sidecar 状态(设置页「能力」区;缺失时前端显示禁用态与原因)。
#[tauri::command]
pub fn ffmpeg_status() -> FfmpegStatusDto {
    match ffmpeg::detect() {
        Ok(info) => FfmpegStatusDto::Ready { info },
        Err(error) => FfmpegStatusDto::Missing { error },
    }
}

/// 启动时检测一次:缺失立即给用户可见 error(计划零静默清单 ffmpeg-missing)。
pub fn notify_ffmpeg_missing_on_startup<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Err(e) = ffmpeg::detect() {
        notify::error(
            app,
            "ffmpeg-missing",
            format!("转码引擎不可用({e}):转码相关功能已禁用;请重新安装应用或联系维护者"),
        );
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum CapabilityStateDto {
    Idle,
    Probing,
    Ready { report: CapabilityReport },
    Failed { error: String },
}

enum ProbeState {
    Idle,
    Probing,
    Ready(CapabilityReport),
    Failed(String),
}

static PROBE_STATE: Mutex<ProbeState> = Mutex::new(ProbeState::Idle);

fn probe_state_dto() -> CapabilityStateDto {
    match &*PROBE_STATE.lock().unwrap_or_else(|p| p.into_inner()) {
        ProbeState::Idle => CapabilityStateDto::Idle,
        ProbeState::Probing => CapabilityStateDto::Probing,
        ProbeState::Ready(r) => CapabilityStateDto::Ready { report: r.clone() },
        ProbeState::Failed(e) => CapabilityStateDto::Failed { error: e.clone() },
    }
}

/// 硬编能力探测:首次(或 refresh=true)在后台线程跑真探针(每个 ≤12s,串行),
/// 前端轮询本命令直到 ready/failed。缓存驻内存;换驱动/外接 GPU 后用刷新按钮
/// 重探(缓存键不含驱动标识,属声明边界——探测本身就是权威)。
#[tauri::command]
pub fn transcode_capabilities<R: tauri::Runtime>(
    app: AppHandle<R>,
    refresh: Option<bool>,
) -> CmdResult<CapabilityStateDto> {
    let should_start = {
        let mut st = PROBE_STATE.lock().unwrap_or_else(|p| p.into_inner());
        match &*st {
            ProbeState::Probing => false,
            ProbeState::Ready(_) if !refresh.unwrap_or(false) => false,
            ProbeState::Failed(_) if !refresh.unwrap_or(false) => false,
            _ => {
                *st = ProbeState::Probing;
                true
            }
        }
    };
    if should_start {
        let app = app.clone();
        std::thread::spawn(move || {
            let result = ffmpeg::probe_capabilities();
            let mut st = PROBE_STATE.lock().unwrap_or_else(|p| p.into_inner());
            match result {
                Ok(report) => {
                    // 零静默:硬编全军覆没只剩软编时明确告知
                    let has_hw = report.winners.keys().any(|k| k.ends_with("_hw"));
                    if !has_hw {
                        notify::warn(
                            &app,
                            "hwenc-fallback",
                            "未探测到可用的硬件编码器,转码将使用软件编码(速度较慢);若本机有独显/核显,请检查驱动".into(),
                        );
                    }
                    *st = ProbeState::Ready(report);
                }
                Err(e) => {
                    notify::warn(
                        &app,
                        "hwenc-probe-failed",
                        format!("编码能力探测失败({e}),转码功能暂不可用;可在设置页重试"),
                    );
                    *st = ProbeState::Failed(e);
                }
            }
        });
    }
    Ok(probe_state_dto())
}

/// 诊断导出(计划可选建议):版本/探测明细/最近状态,不含任何素材路径。
#[tauri::command]
pub fn transcode_diagnostics() -> serde_json::Value {
    serde_json::json!({
        "ffmpeg": match ffmpeg::detect() {
            Ok(i) => serde_json::to_value(i).unwrap_or_default(),
            Err(e) => serde_json::json!({"error": e}),
        },
        "capabilities": serde_json::to_value(probe_state_dto()).unwrap_or_default(),
    })
}
