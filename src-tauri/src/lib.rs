pub mod commands;
pub mod core;

use commands::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// 全部 IPC 命令的唯一清单:生产与集成测试共用同一张表,
/// 防止「测试网测的接线」与「真实应用的接线」分叉(M3 W1)。
#[macro_export]
macro_rules! ocard_invoke_handler {
    () => {
        tauri::generate_handler![
            $crate::commands::get_workstation_info,
            $crate::commands::set_workstation_info,
            $crate::commands::list_projects,
            $crate::commands::get_project,
            $crate::commands::create_project,
            $crate::commands::preview_folder_tree,
            $crate::commands::list_cameras,
            $crate::commands::create_camera,
            $crate::commands::delete_camera,
            $crate::commands::list_storage_cards,
            $crate::commands::create_storage_card,
            $crate::commands::delete_storage_card,
            $crate::commands::list_volumes,
            $crate::commands::inspect_volume,
            $crate::commands::list_copy_tasks,
            $crate::commands::get_copy_task,
            $crate::commands::list_copy_files,
            $crate::commands::preview_copy_task,
            $crate::commands::start_copy_task,
            $crate::commands::pause_copy_task,
            $crate::commands::resume_copy_task,
            $crate::commands::retry_copy_file,
            $crate::commands::updater::check_for_update,
            $crate::commands::updater::install_update,
            $crate::commands::notify::list_notices,
            $crate::commands::sorting_cmds::list_pending_assets,
            $crate::commands::sorting_cmds::list_categories,
            $crate::commands::sorting_cmds::move_assets,
            $crate::commands::sorting_cmds::curate_assets,
            $crate::commands::sorting_cmds::trash_assets,
            $crate::commands::sorting_cmds::list_trash,
            $crate::commands::sorting_cmds::restore_from_trash,
            $crate::commands::sorting_cmds::empty_trash,
            $crate::commands::sorting_cmds::indexing_status,
            $crate::commands::sorting_cmds::start_delivery,
            $crate::commands::sorting_cmds::list_jobs,
            $crate::commands::sorting_cmds::get_job,
            $crate::commands::sorting_cmds::cancel_job,
            $crate::commands::transcode_cmds::ffmpeg_status,
            $crate::commands::transcode_cmds::transcode_capabilities,
            $crate::commands::transcode_cmds::transcode_diagnostics,
            $crate::commands::transcode_cmds::start_proxy_transcode,
            $crate::commands::analysis_cmds::start_analysis,
            $crate::commands::sorting_cmds::list_remote_activity,
        ]
    };
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let machine_id = core::machine::machine_id(&config_dir)
                .map_err(|e| format!("初始化机器 ID 失败: {e}"))?;
            app.manage(commands::updater::PendingUpdate::default());
            app.manage(commands::sorting_cmds::IndexManager::default());
            app.manage(std::sync::Arc::new(core::jobs::JobManager::default()));
            app.manage(AppState {
                config_dir,
                machine_id,
                tasks: Default::default(),
                notices: Default::default(),
                ops: Default::default(),
            });
            // sidecar 缺失立即可见(零静默 ffmpeg-missing)
            commands::transcode_cmds::notify_ffmpeg_missing_on_startup(app.handle());
            // auto_proxy 意图补投递(at-least-once:整批成功才置位,skip 语义容忍重复)
            {
                let app_handle = app.handle().clone();
                let state = app.state::<AppState>();
                let config_dir = state.config_dir.clone();
                let machine_id = state.machine_id.clone();
                std::thread::spawn(move || {
                    let (cfg, _) = core::config::load_checked(&config_dir);
                    let Some(nas) = cfg.nas_root else { return };
                    let Ok(scan) = core::catalog::scan_cached(&nas) else { return };
                    for p in scan.projects {
                        let Ok(listing) = core::manifest::list(&p.root) else { continue };
                        for m in listing.manifests {
                            commands::transcode_cmds::dispatch_auto_proxy(
                                &app_handle,
                                &p.root,
                                &machine_id,
                                &config_dir,
                                &cfg.operator,
                                &m,
                            );
                        }
                    }
                });
            }
            // 崩溃/重启后从未完成的 manifest 重建可续传任务
            commands::rebuild_tasks(app.handle(), &app.state::<AppState>());
            // 静默 OTA:后台周期检查、签名校验、静默安装,重启生效
            let update_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                commands::updater::silent_update_loop(update_handle).await;
            });
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("thumb", |ctx, request, responder| {
            // 缩略图按需读取(M3 W4):闸在 thumb_proto::resolve_thumb_request,
            // 这里只做 IO;异步线程防主线程卡死;失败聚合告警(零静默)
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_string();
            std::thread::spawn(move || {
                use std::sync::atomic::{AtomicU32, Ordering};
                static CONSECUTIVE_FAILS: AtomicU32 = AtomicU32::new(0);
                let bytes = (|| -> Result<Vec<u8>, String> {
                    let state = app.state::<commands::AppState>();
                    let (cfg, _) = core::config::load_checked(&state.config_dir);
                    let nas = cfg.nas_root.ok_or("未配置 NAS 根路径")?;
                    let p = commands::thumb_proto::resolve_thumb_request(&nas, &path)?;
                    std::fs::read(&p).map_err(|e| e.to_string())
                })();
                match bytes {
                    Ok(body) => {
                        CONSECUTIVE_FAILS.store(0, Ordering::Relaxed);
                        responder.respond(
                            tauri::http::Response::builder()
                                .status(200)
                                .header("Content-Type", "image/jpeg")
                                .body(body)
                                .unwrap_or_default(),
                        );
                    }
                    Err(e) => {
                        // 单张失败=占位(既有语义);连续大量失败=协议/NAS 级异常,必须可见
                        let n = CONSECUTIVE_FAILS.fetch_add(1, Ordering::Relaxed) + 1;
                        if n == 20 {
                            commands::notify::warn(
                                &app,
                                "thumb-protocol-degraded",
                                format!("缩略图服务连续 {n} 次读取失败(最近一次: {e}),网格可能大面积显示占位图;请检查 NAS 连接"),
                            );
                            CONSECUTIVE_FAILS.store(0, Ordering::Relaxed);
                        }
                        responder.respond(
                            tauri::http::Response::builder()
                                .status(404)
                                .body(Vec::new())
                                .unwrap_or_default(),
                        );
                    }
                }
            });
        })
        .invoke_handler(crate::ocard_invoke_handler!())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
