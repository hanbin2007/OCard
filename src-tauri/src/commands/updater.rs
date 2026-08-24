//! 静默 OTA:后台检查 GitHub Release 的 latest.json,签名校验通过后
//! **只静默下载**;安装由用户在设置中主动触发「重启并更新」。
//!
//! 为什么不后台安装:Windows 上 updater 安装会直接退出进程(上游行为),
//! 后台安装可能当场杀掉在途拷卡任务(codex 四轮 P1)。因此:
//! - 后台:检查 + 下载 + 通知「已就绪」;
//! - 安装:用户点击触发,且**有运行中拷卡任务时拒绝**;
//! - 全程 IN_PROGRESS 串行化,后台与手动检查不并发。
//!
//! 发布门:Release 工作流产出草稿,人工发布后 OTA 才分发(既定人工质量闸)。

use super::notify;
use super::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

/// 检查间隔:4 小时。
const CHECK_INTERVAL: Duration = Duration::from_secs(4 * 3600);
/// 串行闸:检查/下载/安装全程互斥,后台循环与手动检查不并发。
static IN_PROGRESS: AtomicBool = AtomicBool::new(false);
/// 上次检查是否失败:失败通知按「故障期」去重(转入失败时发一次);
/// **任何一次成功的 check()**(无论有无更新)都会结束故障期。
static LAST_CHECK_FAILED: AtomicBool = AtomicBool::new(false);

/// 已下载待安装的更新(字节留在内存,由用户触发安装)。
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>);

/// 后台静默更新循环:启动即查一次,此后周期性检查。
pub async fn silent_update_loop<R: tauri::Runtime>(app: AppHandle<R>) {
    loop {
        check_and_download(&app, false).await;
        tokio::time::sleep(CHECK_INTERVAL).await;
    }
}

/// 执行一次检查+静默下载(不安装)。`manual` 时无更新/失败也给反馈。
pub async fn check_and_download<R: tauri::Runtime>(app: &AppHandle<R>, manual: bool) -> String {
    if IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return "busy".into();
    }
    let result = do_check_and_download(app, manual).await;
    IN_PROGRESS.store(false, Ordering::SeqCst);
    result
}

async fn do_check_and_download<R: tauri::Runtime>(app: &AppHandle<R>, manual: bool) -> String {
    if let Some(pending) = app.try_state::<PendingUpdate>() {
        if pending.0.lock().unwrap().is_some() {
            return "ready".into();
        }
    }
    let updater = match app.updater() {
        Ok(u) => u,
        // 平台不支持(如 deb/rpm 安装的 Linux):非降级,手动检查时如实告知
        Err(_) => return "unsupported".into(),
    };
    match updater.check().await {
        Ok(Some(update)) => {
            LAST_CHECK_FAILED.store(false, Ordering::SeqCst);
            let version = update.version.clone();
            match update.download(|_, _| {}, || {}).await {
                Ok(bytes) => {
                    if let Some(pending) = app.try_state::<PendingUpdate>() {
                        *pending.0.lock().unwrap() = Some((update, bytes));
                    }
                    notify::info(
                        app,
                        "update-ready",
                        format!(
                            "v{version} 已在后台下载完成;到设置中点「安装更新」完成安装(不会打断拷卡)"
                        ),
                    );
                    "ready".into()
                }
                Err(e) => {
                    notify::warn(
                        app,
                        "update-download-failed",
                        format!("v{version} 更新下载失败: {e}"),
                    );
                    "failed".into()
                }
            }
        }
        Ok(None) => {
            LAST_CHECK_FAILED.store(false, Ordering::SeqCst);
            "uptodate".into()
        }
        Err(e) => {
            // 零静默:检查失败必须可见,按故障期去重;手动检查始终告知
            let first_failure = !LAST_CHECK_FAILED.swap(true, Ordering::SeqCst);
            if manual || first_failure {
                notify::warn(
                    app,
                    "update-check-failed",
                    format!("检查更新失败(离线或更新源不可达): {e}"),
                );
            }
            "check-failed".into()
        }
    }
}

/// 手动检查更新(设置界面「检查更新」按钮)。
#[tauri::command]
pub async fn check_for_update<R: tauri::Runtime>(app: AppHandle<R>) -> Result<String, String> {
    Ok(check_and_download(&app, true).await)
}

/// 用户主动安装已下载的更新。有运行中拷卡任务时拒绝(安装会退出进程);
/// 与检查/下载共用同一串行闸(codex 五轮:安装可与下载并发)。
#[tauri::command]
pub fn install_update<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    if IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return Err("后台正在检查或下载更新,请稍候再试".into());
    }
    let result = do_install(&app, &state);
    IN_PROGRESS.store(false, Ordering::SeqCst);
    result
}

fn do_install<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &tauri::State<AppState>,
) -> Result<(), String> {
    let jobs_active = app
        .try_state::<std::sync::Arc<crate::core::jobs::JobManager>>()
        .map(|j| j.any_active())
        .unwrap_or(false);
    if jobs_active {
        return Err(
            "有后台作业(交付/转码/分析)进行中,安装更新会中断它们;请等作业完成或取消后再试".into(),
        );
    }
    if state.tasks.any_running() {
        return Err("有拷卡任务正在进行,安装更新会中断它们;请等任务完成或暂停后再更新".into());
    }
    let pending_state = app.try_state::<PendingUpdate>().ok_or("更新状态不可用")?;
    // 不预先 take:安装失败时保留已下载的包,无需重新下载(codex 五轮回归项)
    {
        let guard = pending_state.0.lock().unwrap();
        let Some((update, bytes)) = guard.as_ref() else {
            return Err("没有已下载的更新;请先检查更新".into());
        };
        // install 在 Windows 上启动安装器并退出进程;macOS/Linux 替换后重启由用户完成
        update.install(bytes).map_err(|e| {
            notify::error(app, "update-install-failed", format!("更新安装失败: {e}"));
            format!("更新安装失败: {e}")
        })?;
    }
    *pending_state.0.lock().unwrap() = None;
    // 到达此处的平台(mac/linux):提示重启
    notify::info(
        app,
        "update-installed",
        "更新已安装,重启应用后生效".to_string(),
    );
    Ok(())
}
