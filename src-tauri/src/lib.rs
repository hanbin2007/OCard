pub mod commands;
pub mod core;

use commands::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
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
                delivering: Default::default(),
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
        .invoke_handler(tauri::generate_handler![
            commands::get_workstation_info,
            commands::set_workstation_info,
            commands::list_projects,
            commands::get_project,
            commands::create_project,
            commands::preview_folder_tree,
            commands::list_cameras,
            commands::create_camera,
            commands::delete_camera,
            commands::list_storage_cards,
            commands::create_storage_card,
            commands::delete_storage_card,
            commands::list_volumes,
            commands::inspect_volume,
            commands::list_copy_tasks,
            commands::get_copy_task,
            commands::list_copy_files,
            commands::preview_copy_task,
            commands::start_copy_task,
            commands::pause_copy_task,
            commands::resume_copy_task,
            commands::retry_copy_file,
            commands::updater::check_for_update,
            commands::updater::install_update,
            commands::notify::list_notices,
            commands::sorting_cmds::list_pending_assets,
            commands::sorting_cmds::list_categories,
            commands::sorting_cmds::move_assets,
            commands::sorting_cmds::curate_assets,
            commands::sorting_cmds::trash_assets,
            commands::sorting_cmds::list_trash,
            commands::sorting_cmds::restore_from_trash,
            commands::sorting_cmds::empty_trash,
            commands::sorting_cmds::indexing_status,
            commands::sorting_cmds::build_delivery,
            commands::sorting_cmds::list_remote_activity,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
