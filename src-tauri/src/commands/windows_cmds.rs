//! 窗口编排:欢迎/项目管理窗口(`welcome`)↔ 主窗口(`main`)。
//!
//! 启动时两个窗口都由 tauri.conf.json 声明:`welcome` 可见、`main` 隐藏。
//! 「打开项目」由本模块完成三件事:记本机最近打开 → 显示主窗口并投递
//! projectId → 销毁欢迎窗口。主窗口可能被现场重建(用户关掉主窗口后
//! 从欢迎窗再开项目),事件可能早于前端监听注册——所以 projectId 同时
//! 走「暂存 + 事件」双通道,前端启动先消费暂存,再靠事件接后续投递。

use super::{config, find_project, nas_root, notify, AppState};
use crate::core::project::Scenario;
use tauri::{AppHandle, Emitter, Manager, State};

/// 主窗口待打开的项目(见模块头「双通道」说明)。
#[derive(Default)]
pub struct PendingOpenProject(pub std::sync::Mutex<Option<String>>);

type CmdResult<T> = std::result::Result<T, String>;

fn window_config<R: tauri::Runtime>(
    app: &AppHandle<R>,
    label: &str,
) -> CmdResult<tauri::utils::config::WindowConfig> {
    app.config()
        .app
        .windows
        .iter()
        .find(|w| w.label == label)
        .cloned()
        .ok_or_else(|| format!("窗口配置缺失: {label}"))
}

/// 取到 `main` 窗口;被用户关掉时按配置重建(隐藏态,由调用方 show)。
fn ensure_main_window<R: tauri::Runtime>(app: &AppHandle<R>) -> CmdResult<tauri::WebviewWindow<R>> {
    if let Some(w) = app.get_webview_window("main") {
        return Ok(w);
    }
    let cfg = window_config(app, "main")?;
    tauri::WebviewWindowBuilder::from_config(app, &cfg)
        .map_err(|e| format!("重建主窗口失败: {e}"))?
        .build()
        .map_err(|e| format!("重建主窗口失败: {e}"))
}

/// 在主窗口中打开项目(欢迎窗口调用)。
#[tauri::command]
pub fn open_project_window<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    pending: State<PendingOpenProject>,
    project_id: String,
) -> CmdResult<()> {
    // 先验证项目当下真实存在(最近列表可能指向已被删除/改名的项目)
    let nas = nas_root(&app, &state)?;
    let stats = find_project(&nas, &project_id)?;

    // 记本机最近打开。失败不阻断打开,但必须可见(零静默)
    let (mut cfg, _) = config::load_checked(&state.config_dir);
    cfg.record_recent(config::RecentProjectEntry {
        id: project_id.clone(),
        name: stats.meta.name.clone(),
        folder_name: stats.folder_name.clone(),
        scenario: match stats.meta.scenario {
            Scenario::A => "A".into(),
            Scenario::B => "B".into(),
        },
        last_opened_at: chrono::Local::now().to_rfc3339(),
    });
    if let Err(e) = config::save(&state.config_dir, &cfg) {
        notify::warn(
            &app,
            "recent-projects-save-failed",
            format!("最近项目记录保存失败(不影响打开): {e}"),
        );
    }

    let main = ensure_main_window(&app)?;
    // 双通道投递:暂存(主窗口刚重建、监听未注册时启动自取)+ 事件(已在跑时即时收)
    *pending.0.lock().map_err(|_| "内部状态锁中毒")? = Some(project_id.clone());
    if let Err(e) = app.emit_to(
        "main",
        "app://open-project",
        serde_json::json!({
            "projectId": project_id,
        }),
    ) {
        // 事件发不出去还有暂存通道兜底;仍要记日志便于排障
        log::warn!("app://open-project 事件发送失败: {e}");
    }
    main.show().map_err(|e| format!("显示主窗口失败: {e}"))?;
    let _ = main.unminimize();
    let _ = main.set_focus();

    // 销毁欢迎窗口。稍作延迟,让本条 IPC 的响应先回到欢迎窗前端,
    // 避免调用方 promise 悬死在被销毁的 webview 里。
    if let Some(welcome) = app.get_webview_window("welcome") {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(200));
            let _ = welcome.destroy();
        });
    }
    Ok(())
}

/// 打开欢迎/项目管理窗口(主窗口侧栏调用;已存在则聚焦,不存在则重建)。
#[tauri::command]
pub fn open_manager_window<R: tauri::Runtime>(app: AppHandle<R>) -> CmdResult<()> {
    if let Some(w) = app.get_webview_window("welcome") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    let cfg = window_config(&app, "welcome")?;
    let w = tauri::WebviewWindowBuilder::from_config(&app, &cfg)
        .map_err(|e| format!("打开项目管理窗口失败: {e}"))?
        .build()
        .map_err(|e| format!("打开项目管理窗口失败: {e}"))?;
    let _ = w.set_focus();
    Ok(())
}

/// 主窗口启动时消费一次「待打开项目」(取后即清)。
#[tauri::command]
pub fn take_pending_open_project(pending: State<PendingOpenProject>) -> CmdResult<Option<String>> {
    Ok(pending.0.lock().map_err(|_| "内部状态锁中毒")?.take())
}
