//! 用户可见通知通道(UX 硬性原则:禁止任何无提示的 fail-open)。
//! 任何降级/跳过/兜底路径都必须经此发出 warning/error,只写 stderr 不算提示。

use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const NOTICE_EVENT: &str = "app://notice";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeDto {
    /// "warning" | "error"
    pub level: &'static str,
    /// 稳定的机器码,前端按它去重/分组,如 "audit-outbox"
    pub code: String,
    pub message: String,
    pub occurred_at: String,
}

pub fn emit_notice(app: &AppHandle, level: &'static str, code: &str, message: String) {
    eprintln!("[{level}] {code}: {message}");
    let _ = app.emit(
        NOTICE_EVENT,
        &NoticeDto {
            level,
            code: code.to_string(),
            message,
            occurred_at: Utc::now().to_rfc3339(),
        },
    );
}

pub fn warn(app: &AppHandle, code: &str, message: String) {
    emit_notice(app, "warning", code, message);
}

pub fn error(app: &AppHandle, code: &str, message: String) {
    emit_notice(app, "error", code, message);
}
