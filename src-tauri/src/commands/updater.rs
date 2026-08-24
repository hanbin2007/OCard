//! 静默 OTA:后台检查 GitHub Release 的 latest.json,签名校验通过后
//! 静默下载安装,重启生效。"静默"指无需用户操作;按零静默 UX 原则,
//! 更新就绪与失败都经通知中心告知用户。
//!
//! 发布门:Release 工作流产出的是草稿 Release,**人工点发布**后 OTA 才会分发——
//! 这是既定的人工质量闸,不是缺陷。

use super::notify;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// 检查间隔:4 小时。
const CHECK_INTERVAL: Duration = Duration::from_secs(4 * 3600);
/// 已就绪的更新只提示一次,避免每 4 小时重复打扰。
static UPDATE_READY: AtomicBool = AtomicBool::new(false);
/// 上次后台检查是否失败:失败通知只在「转入失败」时发一次(每次故障期一条),
/// 既满足零静默原则,又不在离线外勤时无限刷屏。
static LAST_CHECK_FAILED: AtomicBool = AtomicBool::new(false);

/// 后台静默更新循环:启动即查一次,此后周期性检查。
pub async fn silent_update_loop(app: AppHandle) {
    loop {
        check_and_install(&app, false).await;
        tokio::time::sleep(CHECK_INTERVAL).await;
    }
}

/// 执行一次检查+静默安装。`manual` 为 true 时(用户点「检查更新」)
/// 无更新/失败也要给出反馈;后台模式只在有实质进展或降级时发声。
pub async fn check_and_install(app: &AppHandle, manual: bool) -> String {
    if UPDATE_READY.load(Ordering::SeqCst) {
        return "ready".into();
    }
    let updater = match app.updater() {
        Ok(u) => u,
        // 平台不支持(如 deb/rpm 安装的 Linux):不是降级,静默跳过;手动检查时如实告知
        Err(_) => return "unsupported".into(),
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            match update.download_and_install(|_, _| {}, || {}).await {
                Ok(()) => {
                    UPDATE_READY.store(true, Ordering::SeqCst);
                    notify::emit_notice(
                        app,
                        "info",
                        "update-ready",
                        format!("已在后台更新到 v{version},重启应用后生效"),
                    );
                    "ready".into()
                }
                Err(e) => {
                    notify::warn(
                        app,
                        "update-install-failed",
                        format!("v{version} 更新下载或安装失败: {e}"),
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
            // 零静默:检查失败必须可见。后台模式按「故障期」去重——
            // 只在从正常转入失败时发一次,恢复后再失败会再次提示;手动检查始终告知。
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
pub async fn check_for_update(app: AppHandle) -> Result<String, String> {
    Ok(check_and_install(&app, true).await)
}
