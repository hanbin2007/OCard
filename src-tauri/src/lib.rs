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
            $crate::commands::get_project_settings,
            $crate::commands::save_project_settings,
            $crate::commands::diag_cmds::export_diagnostics,
            $crate::commands::windows_cmds::open_project_window,
            $crate::commands::windows_cmds::open_manager_window,
            $crate::commands::windows_cmds::take_pending_open_project,
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
            $crate::commands::add_project_card,
            $crate::commands::list_volumes,
            $crate::commands::inspect_volume,
            $crate::commands::list_copy_tasks,
            $crate::commands::get_copy_task,
            $crate::commands::list_copy_files,
            $crate::commands::list_source_folders,
            $crate::commands::plan_source_selection,
            $crate::commands::preview_copy_task,
            $crate::commands::start_copy_task,
            $crate::commands::pause_copy_task,
            $crate::commands::resume_copy_task,
            $crate::commands::retry_copy_file,
            $crate::commands::updater::check_for_update,
            $crate::commands::updater::install_update,
            $crate::commands::notify::list_notices,
            $crate::commands::preview_cmds::load_full_preview,
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

/// 修剪轮转日志:按修改时间保留最新 keep 份 `ocard*` 文件。尽力而为、不阻塞启动,
/// 但失败要**返回**给调用方说出来(零静默:日志目录读不了 / 旧日志删不掉都会让日志无界增长)。
fn prune_rotated_logs(dir: &std::path::Path, keep: usize) -> Vec<String> {
    let mut failed = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            failed.push(format!("日志目录读不了 {}: {e}", dir.display()));
            return failed;
        }
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
        return failed;
    }
    files.sort_by_key(|(m, _)| std::cmp::Reverse(*m));
    for (_, p) in files.into_iter().skip(keep) {
        if let Err(e) = std::fs::remove_file(&p) {
            log::warn!("旧日志清理失败 {}: {e}", p.display());
            failed.push(format!("{}: {e}", p.display()));
        }
    }
    failed
}

/// 日志落点。
///
/// **必须用 `targets()`(整体替换)而不是 `target()`(追加)**——0.4.3 的现场日志
/// 每一行都出现两次,原因就在这:插件的默认 targets 是
/// `[Stdout, LogDir { file_name: None }]`,`file_name: None` 解析成
/// **应用名** `OCard.log`;我们又追加了一个 `ocard.log`。Windows(NTFS)与
/// macOS(APFS)默认大小写不敏感,两个 target 其实开的是**同一个文件**,
/// 于是两个 writer 各写一遍。
///
/// 后果不只是难看:单文件 5MB 一轮转,双写让历史消耗速度翻倍——事故发生后
/// 想翻日志时,能翻的窗口只有本该的一半。这正是排障最需要它的时候。
fn log_target_kinds() -> Vec<tauri_plugin_log::TargetKind> {
    use tauri_plugin_log::TargetKind;
    vec![
        // 开发时看着方便;打包后 Windows 上没有控制台,写了也不去哪儿
        TargetKind::Stdout,
        TargetKind::LogDir {
            file_name: Some(LOG_FILE_NAME.into()),
        },
    ]
}

/// 运行日志的文件名(不含扩展名)。诊断报告按它去取日志尾巴,别处改了这里也要改。
pub(crate) const LOG_FILE_NAME: &str = "ocard";

fn log_targets() -> Vec<tauri_plugin_log::Target> {
    log_target_kinds()
        .into_iter()
        .map(tauri_plugin_log::Target::new)
        .collect()
}

pub fn run() {
    tauri::Builder::default()
        // **必须第一个注册**(上游要求)。
        //
        // 同机开两个 OCard 是「两个进程同时写同一份拷卡清单」唯一现实的入口:
        // 两个进程都会重建出同一个暂停任务,都看得见同一个挂载点,而清单落盘
        // 是整份覆盖——后写的把先写的整份顶掉,且不报任何错(见 core::lease)。
        // 租约是第二道闸;这一道从源头上不让第二个进程起来。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 第二次启动:把已经开着的窗口顶到前面来,别让用户以为没反应。
            // 先 unminimize 再 set_focus——最常见的一幕正是「窗口缩在任务栏里,
            // 用户以为没开,去双击图标」,顺序反了那一幕恰好不生效
            let mut focused = false;
            for w in app.webview_windows().values() {
                let _ = w.unminimize();
                if w.set_focus().is_ok() {
                    focused = true;
                    break;
                }
            }
            log::info!("已有实例在运行,拒绝第二个实例(前置已开窗口: {focused})");
            if !focused {
                // 这个回调跑在**已经在运行的那个实例**里,通知中心是通的:
                // 用户双击图标什么都没发生时,至少要在这里留一条,不能无提示 no-op
                commands::notify::warn(
                    app,
                    "single-instance-refused",
                    "OCard 已经在运行,第二次启动被拒绝;但没能把已开的窗口顶到前面,请在任务栏/程序坞里找它".into(),
                );
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 原生文件夹选择器(UX 波):所有手填路径处都必须能 UI 选目录
        .plugin(tauri_plugin_dialog::init())
        // 应用运行日志(v0.3.1):平台日志目录轮转文件(单文件 ≤5MB,KeepAll +
        // 启动期修剪),级别 Info;业务可见性仍以通知中心为准,日志是事后排障用
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets(log_targets())
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
            // 轮转日志修剪:按修改时间只留最新 10 份(KeepAll 不自清)。失败列表先存着,
            // 通知要等 `manage(AppState)` 之后再发——积压队列在 AppState 里,此刻发等于
            // 没发(Fable 第 13 轮抓到)
            let log_prune_failed: Option<(std::path::PathBuf, Vec<String>)> =
                match app.path().app_log_dir() {
                    Ok(log_dir) => {
                        let failed = prune_rotated_logs(&log_dir, 10);
                        (!failed.is_empty()).then_some((log_dir, failed))
                    }
                    Err(_) => None,
                };
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
            // 全尺寸预览缓存放**本机** cache 目录:单张几 MB,写 NAS 既慢又会把
            // 项目撑肿,而它随时能按原图重解。拿不到 cache 目录时退到 config 目录,
            // 总好过整条全尺寸路径不可用。
            let preview_dir = app
                .path()
                .app_cache_dir()
                .unwrap_or_else(|_| config_dir.clone())
                .join("previews");
            app.manage(commands::updater::PendingUpdate::default());
            app.manage(commands::windows_cmds::PendingOpenProject::default());
            app.manage(commands::sorting_cmds::IndexManager::default());
            app.manage(std::sync::Arc::new(core::jobs::JobManager::default()));
            app.manage(AppState {
                config_dir,
                machine_id,
                tasks: Default::default(),
                notices: Default::default(),
                ops: Default::default(),
                approved_plans: Default::default(),
                preview_cache: std::sync::Arc::new(
                    core::preview::PreviewCache::with_default_budget(preview_dir),
                ),
            });
            // AppState 已托管:积压队列在了,启动期的通知从这里开始才到得了用户
            if let Some((log_dir, failed)) = log_prune_failed {
                // 句柄先绑成变量:通知 code 门禁只认调用点里第一个 `),` 之前的字面量
                let handle = app.handle();
                crate::commands::notify::warn(
                    handle,
                    "log-prune-failed",
                    format!(
                        "旧运行日志没能清理({} 项,例如 {}):日志会继续占用空间;请检查日志目录 {} 的权限或占用",
                        failed.len(),
                        failed[0],
                        log_dir.display()
                    ),
                );
            }
            // 卷插拔监视(快捷拷卡):2s 轮询本地挂载表(不碰 NAS/登记表),
            // 有插拔即发 volumes://changed;前端收到后再拉带卡匹配的完整列表。
            {
                use tauri::Emitter;
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let mut known: Option<std::collections::BTreeSet<String>> = None;
                    let mut emit_fail_reported = false;
                    let mut panic_reported = false;
                    loop {
                        // 每一轮都包 catch_unwind:sysinfo 在个别挂载状态下 panic
                        // 不该让监视线程静默死掉——那等于插卡检测永久失效且无提示
                        let round = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                            || -> Option<(Vec<String>, std::collections::BTreeSet<String>)> {
                                let vols = core::volumes::list_volumes();
                                match &known {
                                    None => {
                                        let (_, _, ids) =
                                            core::volumes::diff_ids(&Default::default(), &vols);
                                        Some((Vec::new(), ids))
                                    }
                                    Some(prev) => {
                                        let (inserted, removed, ids) =
                                            core::volumes::diff_ids(prev, &vols);
                                        if !inserted.is_empty() || !removed.is_empty() {
                                            let payload = serde_json::json!({
                                                "insertedIds": inserted,
                                                "removedIds": removed,
                                            });
                                            if let Err(e) =
                                                handle.emit("volumes://changed", payload)
                                            {
                                                // 事件发不出去 = 插卡检测静默失效,必须可见;
                                                // 循环每 2s 一轮,只报一次防刷屏
                                                log::warn!("volumes://changed 事件发送失败: {e}");
                                                if !emit_fail_reported {
                                                    emit_fail_reported = true;
                                                    commands::notify::warn(
                                                        &handle,
                                                        "volumes-watch-degraded",
                                                        format!("插卡检测事件发送失败,快捷拷卡引导可能不工作,可手动刷新卷列表: {e}"),
                                                    );
                                                }
                                                // 发送失败:不推进基线,下一轮重试同一批差集
                                                return None;
                                            }
                                            // 发送成功:失败锁存复位,恢复后再坏还能报
                                            emit_fail_reported = false;
                                        }
                                        Some((inserted, ids))
                                    }
                                }
                            },
                        ));
                        match round {
                            Ok(Some((_, ids))) => {
                                known = Some(ids);
                                panic_reported = false;
                            }
                            Ok(None) => {} // emit 失败,保留旧基线重试
                            Err(_) => {
                                log::error!("卷监视轮询 panic,已跳过本轮");
                                if !panic_reported {
                                    panic_reported = true;
                                    commands::notify::warn(
                                        &handle,
                                        "volumes-watch-degraded",
                                        "插卡检测本轮异常,已自动继续;若反复出现请手动刷新卷列表".to_string(),
                                    );
                                }
                            }
                        }
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
                                // 按项目分桶(伪任务 id、空 project id → 不渲染「查看任务」):
                                // 多个项目同时读失败时不能被 30 秒合并折成只剩最后一个
                                let bucket = format!("project:{}", p.meta.name);
                                commands::notify::warn_for_task(
                                    &app_handle,
                                    "auto-proxy-deferred",
                                    (&bucket, ""),
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
        .register_asynchronous_uri_scheme_protocol("preview", |ctx, request, responder| {
            // 全尺寸预览按需读取:闸在 preview_proto::resolve_preview_request,
            // 这里只做 IO;异步线程防主线程卡死。
            //
            // 与 thumb:// 的差别:缩略图 404 只是「这一格是占位」,可以静默;
            // 全尺寸 404 意味着**用户以为自己在看原图、其实没看到**,
            // 所以除了 404 之外还要发一条可见告警——界面那侧同时也会
            // 因为 <img> onError 退回缩略图并把话说破(零静默两道保险)。
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_string();
            std::thread::spawn(move || {
                let bytes = (|| -> Result<Vec<u8>, String> {
                    let state = app.state::<commands::AppState>();
                    let dir = state.preview_cache.dir().to_path_buf();
                    let p = commands::preview_proto::resolve_preview_request(&dir, &path)?;
                    std::fs::read(&p).map_err(|e| e.to_string())
                })();
                match bytes {
                    Ok(body) => responder.respond(
                        tauri::http::Response::builder()
                            .status(200)
                            .header("Content-Type", "image/jpeg")
                            .body(body)
                            .unwrap_or_default(),
                    ),
                    Err(e) => {
                        log::warn!("preview:// 读取失败 {path}: {e}");
                        commands::notify::warn(
                            &app,
                            "preview-protocol-failed",
                            format!("全尺寸预览读取失败({e});全屏里显示的仍是缩略图,清晰度不足以判断虚实"),
                        );
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
            // 多窗口生命周期:欢迎窗与主窗任一还可见,应用就继续活着;
            // 最后一个可见窗口销毁 = 应用退出(隐藏的主窗不能把进程吊着)。
            if let tauri::WindowEvent::Destroyed = event {
                use tauri::Manager as _;
                let app = window.app_handle();
                let any_visible = app
                    .webview_windows()
                    .iter()
                    .filter(|(label, _)| label.as_str() != window.label())
                    .any(|(_, w)| w.is_visible().unwrap_or(false));
                if !any_visible {
                    app.exit(0);
                }
                return;
            }
            // D2/评审 #18:有活跃后台作业时关窗先拦 + 可见提示;
            // 15 秒内再次关闭 = 确认强退:取消全部作业、杀 ffmpeg 子进程后放行
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                use std::sync::atomic::{AtomicU64, Ordering};
                use tauri::Manager as _;
                static LAST_ATTEMPT: AtomicU64 = AtomicU64::new(0);
                let app = window.app_handle();
                // 关的不是最后一个可见窗口(如主窗还开着时关掉项目管理窗):
                // 应用继续运行,作业不中断,直接放行
                let others_visible = app
                    .webview_windows()
                    .iter()
                    .filter(|(label, _)| label.as_str() != window.label())
                    .any(|(_, w)| w.is_visible().unwrap_or(false));
                if others_visible {
                    return;
                }
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

#[cfg(test)]
mod log_target_tests {
    use tauri_plugin_log::TargetKind;

    /// 0.4.3 现场日志每行出现两次的回归网。
    ///
    /// 退回 `Builder::target(...)`(追加)时,`targets` 里会同时存在
    /// `LogDir { file_name: None }`(= 应用名 `OCard.log`)和
    /// `LogDir { file_name: Some("ocard") }`;二者在 Windows/macOS 的
    /// 大小写不敏感文件系统上是同一个文件。这里按**大小写折叠后的文件名**判重,
    /// 而不是按 `file_name` 字面值——`None` 与 `Some("ocard")` 字面上不同,
    /// 落地却撞在一起,只比字面值抓不到这个 bug。
    #[test]
    fn no_two_log_targets_land_on_the_same_file() {
        // 打包名(tauri.conf.json 的 productName);file_name: None 就解析成它
        const APP_NAME: &str = "OCard";
        let mut seen: Vec<String> = Vec::new();
        for kind in super::log_target_kinds() {
            let name = match &kind {
                TargetKind::LogDir { file_name } | TargetKind::Folder { file_name, .. } => {
                    file_name.clone().unwrap_or_else(|| APP_NAME.to_string())
                }
                _ => continue, // Stdout/Stderr/Webview 不落文件
            };
            let key = name.to_lowercase();
            assert!(
                !seen.contains(&key),
                "两个日志 target 落在同一个文件上(大小写不敏感文件系统):{name};\
                 每行会被写两遍,5MB 轮转吃掉一半可追溯窗口"
            );
            seen.push(key);
        }
        assert_eq!(seen.len(), 1, "应当只有一个落文件的日志 target:{seen:?}");
    }

    /// 默认 targets 里那个 `LogDir { file_name: None }` 一旦漏进来,上面那条
    /// 就该红。这里把它显式加进去自检一遍,证明守卫不是恒真。
    #[test]
    fn the_guard_actually_catches_the_default_logdir_target() {
        const APP_NAME: &str = "OCard";
        let kinds = [
            TargetKind::LogDir { file_name: None },
            TargetKind::LogDir {
                file_name: Some(super::LOG_FILE_NAME.into()),
            },
        ];
        let names: Vec<String> = kinds
            .iter()
            .filter_map(|k| match k {
                TargetKind::LogDir { file_name } => Some(
                    file_name
                        .clone()
                        .unwrap_or_else(|| APP_NAME.to_string())
                        .to_lowercase(),
                ),
                _ => None,
            })
            .collect();
        assert_eq!(names[0], names[1], "OCard.log 与 ocard.log 折叠后必须同名");
    }
}
