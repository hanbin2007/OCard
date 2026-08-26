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
            $crate::commands::list_project_cards,
            $crate::commands::set_project_cards,
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
            $crate::commands::transcode_cmds::start_archive_transcode,
            $crate::commands::analysis_cmds::start_analysis,
            $crate::commands::finalcut_cmds::check_final_cuts,
            $crate::commands::finalcut_cmds::curated_flow_hints,
            $crate::commands::finalcut_cmds::get_delivery_status,
            $crate::commands::finalcut_cmds::set_delivery_status,
            $crate::commands::sorting_cmds::list_remote_activity,
            $crate::commands::sorting_cmds::list_audit_log,
        ]
    };
}

/// 修剪轮转日志:按修改时间保留最新 keep 份 `ocard*` 文件(尽力而为,
/// 失败只记日志不阻塞启动)。
fn prune_rotated_logs(dir: &std::path::Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, std::path::PathBuf)> = entries
        .flatten()
        .filter(|e| {
            e.file_name().to_string_lossy().starts_with("ocard")
                && e.file_type().map(|t| t.is_file()).unwrap_or(false)
        })
        .filter_map(|e| {
            let m = e.metadata().ok()?.modified().ok()?;
            Some((m, e.path()))
        })
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort_by_key(|(m, _)| std::cmp::Reverse(*m));
    for (_, p) in files.into_iter().skip(keep) {
        if let Err(e) = std::fs::remove_file(&p) {
            log::warn!("旧日志清理失败 {}: {e}", p.display());
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 原生文件夹选择器(UX 波):所有手填路径处都必须能 UI 选目录
        .plugin(tauri_plugin_dialog::init())
        // 应用运行日志(v0.3.1):平台日志目录轮转文件(单文件 ≤5MB,KeepAll +
        // 启动期修剪),级别 Info;业务可见性仍以通知中心为准,日志是事后排障用
        .plugin(
            tauri_plugin_log::Builder::new()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("ocard".into()),
                    },
                ))
                .level(log::LevelFilter::Info)
                .max_file_size(5_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .build(),
        )
        .setup(|app| {
            // panic 也要落日志(默认 hook 只打 stderr,打包后不可见)
            {
                let default_hook = std::panic::take_hook();
                std::panic::set_hook(Box::new(move |info| {
                    log::error!("panic: {info}");
                    default_hook(info);
                }));
            }
            let config_dir = app.path().app_config_dir()?;
            // 轮转日志修剪:按修改时间只留最新 10 份(KeepAll 不自清)
            if let Ok(log_dir) = app.path().app_log_dir() {
                prune_rotated_logs(&log_dir, 10);
            }
            log::info!("OCard 启动,版本 {}", env!("CARGO_PKG_VERSION"));
            // Linux WebKit 崩溃规避状态落日志(main.rs 里设置,这里只报告——
            // 打包后 stderr 不可见,远程排障只能靠这份日志)
            #[cfg(target_os = "linux")]
            log::info!(
                "Linux WebKit 规避: DMABUF_RENDERER 禁用={} 加速合成禁用={} EGL_PLATFORM={:?} AppImage={}",
                std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").as_deref() == Ok("1"),
                std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").as_deref() == Ok("1"),
                std::env::var("EGL_PLATFORM").unwrap_or_default(),
                std::env::var_os("APPIMAGE").is_some(),
            );
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
            // 卷插拔监视(快捷拷卡):2s 轮询本地挂载表(不碰 NAS/登记表),
            // 有插拔即发 volumes://changed;前端收到后再拉带卡匹配的完整列表。
            {
                use tauri::Emitter;
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let mut known: Option<std::collections::BTreeSet<String>> = None;
                    let mut emit_fail_reported = false;
                    loop {
                        let vols = core::volumes::list_volumes();
                        let ids: std::collections::BTreeSet<String> = vols
                            .iter()
                            .map(|v| v.mount_point.display().to_string())
                            .collect();
                        if let Some(prev) = &known {
                            let (inserted, removed) = core::volumes::diff_ids(prev, &vols);
                            if !inserted.is_empty() || !removed.is_empty() {
                                let payload = serde_json::json!({
                                    "insertedIds": inserted,
                                    "removedIds": removed,
                                });
                                if let Err(e) = handle.emit("volumes://changed", payload) {
                                    // 事件发不出去 = 插卡检测静默失效,必须可见;
                                    // 但监视循环每 2s 一轮,只报一次防刷屏
                                    log::warn!("volumes://changed 事件发送失败: {e}");
                                    if !emit_fail_reported {
                                        emit_fail_reported = true;
                                        commands::notify::warn(
                                            &handle,
                                            "volumes-watch-degraded",
                                            format!("插卡检测事件发送失败,快捷拷卡引导可能不工作,可手动刷新卷列表: {e}"),
                                        );
                                    }
                                }
                            }
                        }
                        known = Some(ids);
                        std::thread::sleep(std::time::Duration::from_secs(2));
                    }
                });
            }
            // sidecar 缺失立即可见(零静默 ffmpeg-missing)
            commands::transcode_cmds::notify_ffmpeg_missing_on_startup(app.handle());
            // AI 模型启动校验(D1:哈希不符=禁用 AI,硬失败可见)
            commands::analysis_cmds::verify_models_on_startup(app.handle());
            // auto_proxy 意图补投递(at-least-once:整批成功才置位,skip 语义容忍重复)
            {
                let app_handle = app.handle().clone();
                let state = app.state::<AppState>();
                let config_dir = state.config_dir.clone();
                let machine_id = state.machine_id.clone();
                std::thread::spawn(move || {
                    let (cfg, _) = core::config::load_checked(&config_dir);
                    // 未配置 NAS = 正常初始态,无声跳过(声明);其余失败必须可见(R2 P2:
                    // NAS 未连时整条 at-least-once 补投递静默失效是零静默违规)
                    let Some(nas) = cfg.nas_root else { return };
                    let scan = match core::catalog::scan_cached(&nas) {
                        Ok(s) => s,
                        Err(e) => {
                            commands::notify::warn(
                                &app_handle,
                                "auto-proxy-deferred",
                                format!("启动补投递未执行(NAS 扫描失败: {e});自动转代理将在下次启动重试"),
                            );
                            return;
                        }
                    };
                    for p in scan.projects {
                        let listing = match core::manifest::list(&p.root) {
                            Ok(l) => l,
                            Err(e) => {
                                commands::notify::warn(
                                    &app_handle,
                                    "auto-proxy-deferred",
                                    format!("「{}」的拷卡清单读取失败({e}),该项目的自动转代理本次未检查", p.meta.name),
                                );
                                continue;
                            }
                        };
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
        .on_window_event(|window, event| {
            // D2/评审 #18:有活跃后台作业时关窗先拦 + 可见提示;
            // 15 秒内再次关闭 = 确认强退:取消全部作业、杀 ffmpeg 子进程后放行
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                use std::sync::atomic::{AtomicU64, Ordering};
                use tauri::Manager as _;
                static LAST_ATTEMPT: AtomicU64 = AtomicU64::new(0);
                let app = window.app_handle();
                let jobs_active = app
                    .try_state::<std::sync::Arc<core::jobs::JobManager>>()
                    .map(|j| j.any_active())
                    .unwrap_or(false);
                let tasks_running = app
                    .try_state::<commands::AppState>()
                    .map(|s| s.tasks.any_running())
                    .unwrap_or(false);
                if !jobs_active && !tasks_running {
                    return;
                }
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let last = LAST_ATTEMPT.swap(now, Ordering::SeqCst);
                if now.saturating_sub(last) <= 15 {
                    // 确认强退:请求取消全部活跃作业 + 暂停拷贝任务(安全点停笔,
                    // R2 P1:此前拷贝线程被硬杀在半写 .part 上)+ 杀子进程,放行关闭
                    if let Some(jobs) =
                        app.try_state::<std::sync::Arc<core::jobs::JobManager>>()
                    {
                        for s in jobs.snapshots() {
                            if !s.state.is_terminal() {
                                let _ = jobs.request_cancel(&s.id);
                            }
                        }
                    }
                    if let Some(state) = app.try_state::<commands::AppState>() {
                        state.tasks.pause_all();
                    }
                    core::transcode::kill_all_children();
                    return;
                }
                api.prevent_close();
                commands::notify::warn(
                    app,
                    "close-blocked-active-jobs",
                    "有后台作业(拷卡/交付/转码/分析)进行中,已阻止关闭;15 秒内再次关闭将取消作业并退出".into(),
                );
            }
        })
        .invoke_handler(crate::ocard_invoke_handler!())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
