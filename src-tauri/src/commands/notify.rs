//! 用户可见通知通道(UX 硬性原则:禁止任何无提示的 fail-open)。
//! 任何降级/跳过/兜底路径都必须经此发出 warning/error,只写 stderr 不算提示。

use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub const NOTICE_EVENT: &str = "app://notice";
/// 积压上限:防无界增长,超限丢最旧(丢弃本身也是一种妥协,上限足够大)。
const BACKLOG_CAP: usize = 500;

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
    let dto = NoticeDto {
        level,
        code: code.to_string(),
        message,
        occurred_at: Utc::now().to_rfc3339(),
    };
    // 先入积压再发事件:前端监听尚未就绪时(启动窗口)也不丢,
    // 就绪后经 list_notices 回放(codex 收口验证 P1:启动丢信)。
    if let Some(state) = app.try_state::<super::AppState>() {
        let mut backlog = state.notices.lock().unwrap();
        backlog.push(dto.clone());
        let overflow = backlog.len().saturating_sub(BACKLOG_CAP);
        if overflow > 0 {
            backlog.drain(0..overflow);
        }
    }
    let _ = app.emit(NOTICE_EVENT, &dto);
}

/// 回放积压通知(前端启动订阅就绪后调用一次补账)。
#[tauri::command]
pub fn list_notices(state: tauri::State<super::AppState>) -> Vec<NoticeDto> {
    state.notices.lock().unwrap().clone()
}

pub fn warn(app: &AppHandle, code: &str, message: String) {
    emit_notice(app, "warning", code, message);
}

#[allow(dead_code)]
pub fn info(app: &AppHandle, code: &str, message: String) {
    emit_notice(app, "info", code, message);
}

pub fn error(app: &AppHandle, code: &str, message: String) {
    emit_notice(app, "error", code, message);
}
