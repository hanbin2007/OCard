pub mod commands;
pub mod core;

use commands::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let machine_id = core::machine::machine_id(&config_dir)
                .map_err(|e| format!("初始化机器 ID 失败: {e}"))?;
            app.manage(AppState {
                config_dir,
                machine_id,
                tasks: Default::default(),
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
            commands::start_copy_task,
            commands::pause_copy_task,
            commands::resume_copy_task,
            commands::retry_copy_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
