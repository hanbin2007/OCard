//! 用户可见通知通道(UX 硬性原则:禁止任何无提示的 fail-open)。
//! 任何降级/跳过/兜底路径都必须经此发出 warning/error,只写 stderr 不算提示。

use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub const NOTICE_EVENT: &str = "app://notice";
/// 积压上限:防无界增长,超限丢最旧(丢弃本身也是一种妥协,上限足够大)。
const BACKLOG_CAP: usize = 500;

/// 同 code+level 的合并窗口:窗口内重复通知折叠成一条并累计次数,
/// 防高频降级(如逐文件索引告警)把积压里待确认的 error 冲刷掉(评审 M6)。
const MERGE_WINDOW_SECS: i64 = 30;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeDto {
    /// "info" | "warning" | "error"(R2 P2:info 用于取消确认/清理完成等
    /// 非告警可见性;与前端 types.ts 的 NoticeLevel 保持一致)
    pub level: &'static str,
    /// 稳定的机器码,前端按它去重/分组,如 "audit-outbox"
    pub code: String,
    pub message: String,
    pub occurred_at: String,
    /// 合并窗口内的重复次数(≥2 时出现;前端展示「×N」)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repeats: Option<u32>,
}

pub fn emit_notice<R: tauri::Runtime>(
    app: &AppHandle<R>,
    level: &'static str,
    code: &str,
    message: String,
) {
    // 每条通知镜像进运行日志(v0.3.1:事后排障可复原用户当时看到了什么)
    match level {
        "error" => log::error!("[{code}] {message}"),
        "warning" => log::warn!("[{code}] {message}"),
        _ => log::info!("[{code}] {message}"),
    }
    let mut dto = NoticeDto {
        level,
        code: code.to_string(),
        message,
        occurred_at: Utc::now().to_rfc3339(),
        repeats: None,
    };
    // 先入积压再发事件:前端监听尚未就绪时(启动窗口)也不丢,
    // 就绪后经 list_notices 回放(codex 收口验证 P1:启动丢信)。
    if let Some(state) = app.try_state::<super::AppState>() {
        let mut backlog = state.notices.lock().unwrap();
        let now = Utc::now();
        let merged = backlog
            .iter_mut()
            .rev()
            .take(64)
            .find(|n| n.code == dto.code && n.level == dto.level)
            .filter(|n| {
                chrono::DateTime::parse_from_rfc3339(&n.occurred_at)
                    .map(|ts| (now - ts.to_utc()).num_seconds() <= MERGE_WINDOW_SECS)
                    .unwrap_or(false)
            });
        if let Some(n) = merged {
            n.repeats = Some(n.repeats.unwrap_or(1) + 1);
            n.message = dto.message.clone();
            n.occurred_at = dto.occurred_at.clone();
            dto = n.clone();
        } else {
            backlog.push(dto.clone());
            let overflow = backlog.len().saturating_sub(BACKLOG_CAP);
            if overflow > 0 {
                backlog.drain(0..overflow);
            }
        }
    }
    let _ = app.emit(NOTICE_EVENT, &dto);
}

/// 回放积压通知(前端启动订阅就绪后调用一次补账)。
#[tauri::command(async)]
pub fn list_notices(state: tauri::State<super::AppState>) -> Vec<NoticeDto> {
    state.notices.lock().unwrap().clone()
}

pub fn warn<R: tauri::Runtime>(app: &AppHandle<R>, code: &str, message: String) {
    emit_notice(app, "warning", code, message);
}

#[allow(dead_code)]
pub fn info<R: tauri::Runtime>(app: &AppHandle<R>, code: &str, message: String) {
    emit_notice(app, "info", code, message);
}

pub fn error<R: tauri::Runtime>(app: &AppHandle<R>, code: &str, message: String) {
    emit_notice(app, "error", code, message);
}
