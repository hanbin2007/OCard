pub mod core;

// 命令层将在核心模块齐备后接入(见 docs/superpowers/plans/2026-08-24-m1-plan.md 任务4);
// 暂保留脚手架 greet 供前端 mock 期调用。
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! You've been greeted from Rust!")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
