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
            $crate::commands::sorting_cmds::build_delivery,
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
            app.manage(AppState {
                config_dir,
                machine_id,
                tasks: Default::default(),
                notices: Default::default(),
                ops: Default::default(),
            });
            // 崩溃/重启后从未完成的 manifest 重建可续传任务
            commands::rebuild_tasks(app.handle(), &app.state::<AppState>());
            // 静默 OTA:后台周期检查、签名校验、静默安装,重启生效
            let update_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                commands::updater::silent_update_loop(update_handle).await;
            });
            Ok(())
        })
        .invoke_handler(crate::ocard_invoke_handler!())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
