//! 命令层集成测试网(M3 W1):mock runtime 驱动**与生产完全同一张**
//! invoke_handler 表(`ocard_invoke_handler!`),验证「命令接线」层——
//! M2 终审抓到的「互斥闸漏接 trash_assets」正是这一层的空白。
//! 每一波新增命令都必须在这里挂用例。

use crate::commands::AppState;
use serde_json::{json, Value};
use tauri::ipc::InvokeBody;
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{Manager, WebviewWindow};

/// 起一个带真实 AppState + 临时 NAS 的 mock 应用,返回窗口句柄与目录守卫。
fn mock_app() -> (
    WebviewWindow<tauri::test::MockRuntime>,
    tempfile::TempDir,
    std::path::PathBuf,
) {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    std::fs::create_dir_all(&config_dir).unwrap();
    let nas = tmp.path().join("nas");
    std::fs::create_dir_all(&nas).unwrap();
    crate::core::config::save(
        &config_dir,
        &crate::core::config::WorkstationConfig {
            operator: "集成测试".into(),
            nas_root: Some(nas.clone()),
            recent_projects: Vec::new(),
        },
    )
    .unwrap();

    let app = mock_builder()
        .invoke_handler(crate::ocard_invoke_handler!())
        .build(mock_context(noop_assets()))
        .unwrap();
    app.manage(crate::commands::sorting_cmds::IndexManager::default());
    app.manage(std::sync::Arc::new(crate::core::jobs::JobManager::default()));
    app.manage(AppState {
        config_dir,
        machine_id: "TEST-MACHINE".into(),
        tasks: Default::default(),
        notices: Default::default(),
        ops: Default::default(),
        approved_plans: Default::default(),
        preview_cache: std::sync::Arc::new(
            crate::core::preview::PreviewCache::with_default_budget(
                tmp.path().join("cache/previews"),
            ),
        ),
    });
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    // TempDir 必须活到测试结束;app 由 window 持有引用计数
    (window, tmp, nas)
}

fn invoke(
    window: &WebviewWindow<tauri::test::MockRuntime>,
    cmd: &str,
    args: Value,
) -> Result<Value, Value> {
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|b| b.deserialize::<Value>().unwrap())
}

fn create_b_project(window: &WebviewWindow<tauri::test::MockRuntime>) -> String {
    let created = invoke(
        window,
        "create_project",
        json!({"input": {"name": "集成B", "date": "20260824", "scenario": "B",
                "categories": ["开幕式"]}}),
    )
    .expect("建项目应成功");
    created["id"].as_str().unwrap().to_string()
}

fn create_a_project(window: &WebviewWindow<tauri::test::MockRuntime>) -> String {
    let created = invoke(
        window,
        "create_project",
        json!({"input": {"name": "集成A", "date": "20260824", "scenario": "A"}}),
    )
    .expect("建项目应成功");
    created["id"].as_str().unwrap().to_string()
}

#[test]
fn sorting_full_chain_through_real_handler() {
    let (window, _tmp, nas) = mock_app();
    let pid = create_b_project(&window);
    // 注入素材
    let inbox = nas.join(&pid).join("1. 待分类/0824上午_A7M4_A_ZS");
    std::fs::create_dir_all(&inbox).unwrap();
    std::fs::write(inbox.join("a.jpg"), vec![7u8; 64]).unwrap();

    // move 经真实 handler 落盘
    let res = invoke(
        &window,
        "move_assets",
        json!({"projectId": pid, "assetIds": ["1. 待分类/0824上午_A7M4_A_ZS/a.jpg"],
               "categoryId": "2. 开幕式"}),
    )
    .expect("移动应成功");
    assert_eq!(res["succeeded"].as_array().unwrap().len(), 1);
    assert!(nas.join(&pid).join("2. 开幕式/a.jpg").is_file());
}

#[test]
fn delivering_gate_wired_into_trash_command() {
    // M2 终审缺陷的回归网:交付互斥闸必须真的接在 trash_assets 命令上
    let (window, _tmp, nas) = mock_app();
    let pid = create_b_project(&window);
    let inbox = nas.join(&pid).join("1. 待分类/x");
    std::fs::create_dir_all(&inbox).unwrap();
    std::fs::write(inbox.join("b.jpg"), b"data").unwrap();

    // 模拟交付进行中(持有 delivery guard)
    let state = window.state::<AppState>();
    let _delivery = state.ops.begin_delivery(&pid).unwrap();

    for cmd in ["trash_assets", "move_assets", "curate_assets"] {
        let mut args = json!({"projectId": pid, "assetIds": ["1. 待分类/x/b.jpg"]});
        if cmd == "move_assets" {
            args["categoryId"] = json!("2. 开幕式");
        }
        let err = invoke(&window, cmd, args).expect_err(&format!("{cmd} 在交付中必须被拒"));
        assert!(
            err.as_str().unwrap_or_default().contains("交付打包进行中"),
            "{cmd}: {err}"
        );
    }
    let err = invoke(&window, "empty_trash", json!({"projectId": pid}))
        .expect_err("empty_trash 在交付中必须被拒");
    assert!(err.as_str().unwrap_or_default().contains("交付打包进行中"));
    // 文件原地未动
    assert!(inbox.join("b.jpg").is_file());
}

#[test]
fn path_escape_rejected_through_real_handler() {
    // 路径闸接线:恶意 id 经真实 IPC 编解码后仍被拒
    let (window, _tmp, nas) = mock_app();
    let pid = create_b_project(&window);
    std::fs::write(nas.join("受害者.jpg"), b"outside").unwrap();

    let res = invoke(
        &window,
        "trash_assets",
        json!({"projectId": pid, "assetIds": ["../受害者.jpg"]}),
    )
    .expect("命令本身成功,逐项失败");
    assert_eq!(res["succeeded"].as_array().unwrap().len(), 0);
    assert_eq!(res["failed"].as_array().unwrap().len(), 1);
    assert!(nas.join("受害者.jpg").is_file(), "项目外文件必须无恙");
}

#[test]
fn delivery_job_end_to_end_through_real_handler() {
    // W2:start_delivery 作业化全链路——排队→运行→done,结果与磁盘一致
    let (window, _tmp, nas) = mock_app();
    let pid = create_b_project(&window);
    std::fs::write(nas.join(&pid).join("2. 开幕式/a.jpg"), vec![1u8; 100]).unwrap();

    let snap =
        invoke(&window, "start_delivery", json!({"projectId": pid})).expect("发起交付作业应成功");
    let job_id = snap["id"].as_str().unwrap().to_string();

    // 重复投递:同项目同 kind 不允许两个活跃作业并存(R2 P2:原断言恒真,改为
    // 真不变量——无论 dup 被拒还是首个已完成后合法接受,活跃 delivery ≤ 1)
    let dup = invoke(&window, "start_delivery", json!({"projectId": pid}));
    {
        let jobs = window.state::<std::sync::Arc<crate::core::jobs::JobManager>>();
        let active = jobs
            .snapshots()
            .iter()
            .filter(|s| s.kind == crate::core::jobs::JobKind::Delivery && !s.state.is_terminal())
            .count();
        assert!(
            active <= 1,
            "同项目不允许两个活跃交付作业并存(active={active}, dup={dup:?})"
        );
    }

    // 轮询到终态
    let mut last = json!(null);
    for _ in 0..200 {
        last = invoke(&window, "get_job", json!({"jobId": job_id})).expect("查询作业应成功");
        if ["done", "failed", "cancelled"].contains(&last["state"].as_str().unwrap_or_default()) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(last["state"], "done", "作业应完成: {last}");
    let result = &last["result"];
    assert_eq!(result["totalFiles"], 1);
    // 磁盘断言:包与清单落盘
    let delivery = nas.join(&pid).join("交付");
    assert!(delivery.join("交付总清单.txt").is_file());
    // list_jobs 能看到该作业
    let jobs = invoke(&window, "list_jobs", json!({})).unwrap();
    assert!(jobs
        .as_array()
        .unwrap()
        .iter()
        .any(|j| j["id"] == job_id.as_str()));
}

// ---------- M3 命令挂网(评审 #13:每波新命令必须有网) ----------

#[test]
fn m3_commands_wired_and_gated() {
    let (window, _tmp, nas) = mock_app();
    let pid = create_b_project(&window);

    // ffmpeg_status:mock 环境无 sidecar → missing 且原因可见(零静默形状)。
    // 持环境锁:并行的真 ffmpeg 测试会临时设 OCARD_FFMPEG_DIR,撞上会假红
    {
        let _g = crate::core::ffmpeg::FFMPEG_ENV_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let st = invoke(&window, "ffmpeg_status", json!({})).unwrap();
        assert_eq!(st["status"], "missing");
        assert!(st["error"].as_str().unwrap_or_default().len() > 3);
    }

    // 转码/归档只认工况 A:B 项目必须被拒且报文点名
    let e = invoke(
        &window,
        "start_proxy_transcode",
        json!({"input": {"projectId": pid}}),
    )
    .expect_err("B 项目转码必须拒");
    assert!(e.as_str().unwrap().contains("工况 A"));
    let e = invoke(
        &window,
        "start_archive_transcode",
        json!({"input": {"projectId": pid, "tier": "balanced", "outputDir": "/tmp/x"}}),
    )
    .expect_err("B 项目归档必须拒");
    assert!(e.as_str().unwrap().contains("工况 A"));

    // 成片校验只认工况 A
    let e = invoke(&window, "check_final_cuts", json!({"projectId": pid}))
        .expect_err("B 项目成片校验必须拒");
    assert!(e.as_str().unwrap().contains("工况 A"));

    // 流转提示(B 项目,空):正常返回空表
    let hints = invoke(&window, "curated_flow_hints", json!({"projectId": pid})).unwrap();
    assert_eq!(hints.as_array().unwrap().len(), 0);

    // 交付状态回读闭环
    let s0 = invoke(&window, "get_delivery_status", json!({"projectId": pid})).unwrap();
    assert_eq!(s0["uploaded"], false);
    let s1 = invoke(
        &window,
        "set_delivery_status",
        json!({"projectId": pid, "uploaded": true}),
    )
    .unwrap();
    assert_eq!(s1["uploaded"], true);
    let s2 = invoke(&window, "get_delivery_status", json!({"projectId": pid})).unwrap();
    assert_eq!(s2["uploaded"], true);
    assert!(s2["updatedBy"].as_str().is_some());

    // 分析作业:注入一张真 JPEG → 发起 → 轮询终态 done,特征落盘
    let inbox = nas.join(&pid).join("1. 待分类/x");
    std::fs::create_dir_all(&inbox).unwrap();
    let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(320, 240, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, 99])
    }));
    img.save(inbox.join("a.jpg")).unwrap();
    let snap = invoke(&window, "start_analysis", json!({"projectId": pid})).unwrap();
    let job_id = snap["id"].as_str().unwrap().to_string();
    let mut last = json!(null);
    for _ in 0..300 {
        last = invoke(&window, "get_job", json!({"jobId": job_id})).unwrap();
        if ["done", "failed", "cancelled"].contains(&last["state"].as_str().unwrap_or_default()) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(last["state"], "done", "{last}");
    assert_eq!(last["result"]["analyzed"], 1);
    assert!(nas
        .join(&pid)
        .join(".ocard/analysis/features-TEST-MACHINE.jsonl")
        .is_file());

    // 分析后的列表带 judgement(挂网到 list_pending_assets 契约)
    let page = invoke(
        &window,
        "list_pending_assets",
        json!({"projectId": pid, "offset": 0, "limit": 50}),
    )
    .unwrap();
    assert!(page["items"][0]["judgement"]["score"].is_number());

    // 转码能力探测:mock 无 sidecar → 状态机可达(idle→probing/failed),不 panic
    let cap = invoke(&window, "transcode_capabilities", json!({})).unwrap();
    assert!(["idle", "probing", "ready", "failed"]
        .contains(&cap["status"].as_str().unwrap_or_default()));
    // 诊断导出无素材路径字段
    let diag = invoke(&window, "transcode_diagnostics", json!({})).unwrap();
    assert!(diag.get("ffmpeg").is_some());

    // cancel_job 挂网(R2:此前零测试):不存在的作业必须报错;
    // 对已终态作业请求取消要拿回原状态,不得谎称已取消
    let e = invoke(&window, "cancel_job", json!({"jobId": "不存在的作业"}))
        .expect_err("未知 jobId 必须报错");
    assert!(e.as_str().unwrap().len() > 3);
    let done = invoke(&window, "cancel_job", json!({"jobId": job_id})).unwrap();
    assert_eq!(done["state"], "done", "终态作业的取消请求必须原样返回终态");

    // list_remote_activity 挂网(R2:此前零测试):形状可用,分析作业不产生
    // copy/transcode 活动条目
    let acts = invoke(&window, "list_remote_activity", json!({"projectId": pid})).unwrap();
    assert!(acts.is_array(), "{acts}");
    assert_eq!(acts.as_array().unwrap().len(), 0, "分析不产生远端活动条目");

    // list_audit_log 挂网(v0.3.1):建项目事件在账,最新在前,形状齐全
    let audit = invoke(&window, "list_audit_log", json!({"projectId": pid})).unwrap();
    let events = audit.as_array().unwrap();
    assert!(!events.is_empty(), "至少有 project_created: {audit}");
    assert!(
        events.iter().any(|e| e["kind"] == "project_created"),
        "{audit}"
    );
    for e in events {
        assert!(e["ts"].is_string() && e["machine"].is_string() && e["operator"].is_string());
    }
    let ts: Vec<&str> = events.iter().map(|e| e["ts"].as_str().unwrap()).collect();
    let mut sorted = ts.clone();
    sorted.sort_by(|a, b| b.cmp(a));
    assert_eq!(ts, sorted, "必须最新在前");
}

// ---------- R3-F2 闸接线回归(评审缺口 3:修复点必须有命令层网) ----------

/// R3-F2 集成断言加强:cancel_job 行为级(此前仅「未知 id 报错/终态原样
/// 返回」形状级)——排队中的活跃作业请求取消必须真进 cancelled 终态;
/// dup 拒绝确定性化(此前依赖「首个作业尚未完成」的时序):活跃作业在场
/// 时同项目必拒,终态后必须重新放行。
#[test]
fn cancel_and_dup_assertions_are_behavior_level() {
    let (window, _tmp, _nas) = mock_app();
    let pid = create_b_project(&window);

    // 排队中的真实作业(不启动 worker):活跃态确定,无时序竞争
    let jobs = window.state::<std::sync::Arc<crate::core::jobs::JobManager>>();
    let queued = jobs.create(crate::core::jobs::JobKind::Delivery, &pid);
    let dup = invoke(&window, "start_delivery", json!({"projectId": pid}))
        .expect_err("已有活跃交付作业时必须拒绝");
    assert!(
        dup.as_str()
            .unwrap_or_default()
            .contains("已有交付打包作业"),
        "{dup}"
    );

    let s = invoke(
        &window,
        "cancel_job",
        json!({"jobId": queued.snapshot().id}),
    )
    .unwrap();
    assert_eq!(s["state"], "cancelled", "排队作业取消必须真进终态: {s}");

    // 终态解除活跃:同项目必须重新放行(空项目交付会正常跑完,不影响断言)
    invoke(&window, "start_delivery", json!({"projectId": pid}))
        .expect("取消进入终态后必须允许重新发起");
}

/// R3-F2 集成断言加强:list_remote_activity 折叠正例(此前仅空表形状)——
/// 他机 started 必须出现(copy 与 transcode 两类),completed 后必须折叠
/// 消失,本机事件不上榜。
#[test]
fn remote_activity_folds_started_completed_pairs() {
    let (window, _tmp, nas) = mock_app();
    let pid = create_b_project(&window);
    let root = nas.join(&pid);
    let ev = |machine: &str, kind: &str, data: Value| {
        crate::core::journal::append(
            &root,
            &crate::core::journal::Event::new(machine, "远端操作员", kind, data),
        )
        .unwrap()
    };

    ev(
        "REMOTE-1",
        crate::core::journal::kind::COPY_STARTED,
        json!({"taskId": "t1", "volume": "SD01", "camera": "A7M4_A_ZS", "targetFolder": "x"}),
    );
    ev(
        "TEST-MACHINE",
        crate::core::journal::kind::COPY_STARTED,
        json!({"taskId": "t9"}),
    );
    ev(
        "REMOTE-2",
        "transcode_started",
        json!({"jobId": "j1", "folders": "20260824_A7M4_A_ZS"}),
    );
    let acts = invoke(&window, "list_remote_activity", json!({"projectId": pid})).unwrap();
    let arr = acts.as_array().unwrap();
    assert_eq!(
        arr.len(),
        2,
        "他机 copy+transcode 各一条,本机不上榜: {acts}"
    );
    assert!(arr
        .iter()
        .any(|a| a["activity"] == "copy" && a["machine"] == "REMOTE-1"));
    assert!(arr
        .iter()
        .any(|a| a["activity"] == "transcode" && a["machine"] == "REMOTE-2"));

    ev(
        "REMOTE-1",
        crate::core::journal::kind::COPY_COMPLETED,
        json!({"taskId": "t1"}),
    );
    ev("REMOTE-2", "transcode_completed", json!({"jobId": "j1"}));
    let acts = invoke(&window, "list_remote_activity", json!({"projectId": pid})).unwrap();
    assert_eq!(
        acts.as_array().unwrap().len(),
        0,
        "started/completed 配对后必须折叠: {acts}"
    );
}

/// R3-F2 闸族接线:delivery-status 读写闸——`.ocard` 被换成指向项目外的
/// 符号链接时 set/get 都必须拒绝,状态文件不得写到项目外。在
/// set_delivery_status 里删掉 ensure_dir_within、get 里删掉 assert_within,
/// 本测试红。
#[cfg(unix)]
#[test]
fn delivery_status_refuses_symlinked_state_dir() {
    let (window, tmp, nas) = mock_app();
    let pid = create_b_project(&window);
    let root = nas.join(&pid);
    let outside = tmp.path().join("outside");

    // 把真实 .ocard 挪到项目外再换链接:项目 meta 经链接仍可读,
    // 使测试确实走到 delivery-status 的落地闸而不是死在 find_project
    let state_dir = root.join(".ocard");
    std::fs::rename(&state_dir, &outside).unwrap();
    std::os::unix::fs::symlink(&outside, &state_dir).unwrap();

    let e = invoke(
        &window,
        "set_delivery_status",
        json!({"projectId": pid, "uploaded": true}),
    )
    .expect_err("符号链接 .ocard 必须拒写");
    assert!(
        e.as_str().unwrap_or_default().contains("根之外"),
        "报文必须点名落地闸: {e}"
    );
    assert!(
        !outside.join("delivery-status.json").exists(),
        "状态不得经链接写到项目外"
    );
    invoke(&window, "get_delivery_status", json!({"projectId": pid}))
        .expect_err("符号链接 .ocard 读取同样必须拒绝");
}

/// R2 P0-1 接线回归:持久化清单被篡改(`../` 项)后,resume 必须整单拒绝,
/// 且闸在卷重解析之前——报文点名篡改,而不是让用户「插回原卡」。
/// (拷卡发起要求源恰为真实挂载卷,mock 环境不可伪造;任务句柄按生产
/// 同构直接落 TaskManager,resume 命令本身仍走真实 handler 全链路。)
/// 在 resume_copy_task 里删掉 planned 校验块本测试红。
#[test]
fn resume_rejects_tampered_manifest_through_real_handler() {
    use std::sync::atomic::AtomicBool;
    let (window, tmp, nas) = mock_app();
    let pid = create_b_project(&window);
    let project_root = nas.join(&pid);

    // 生产同构的持久化清单……
    let mut m = crate::core::manifest::CopyManifest::new(
        "1. 待分类/0824上午_A7M4_A_ZS",
        "SDXC_01",
        "A7M4_A_ZS",
        "ZS",
        "",
    );
    m.planned.push(crate::core::manifest::PlannedFile {
        rel_path: "DCIM/IMG_0001.JPG".into(),
        size: 64,
        source_rel: String::new(),
        source_mtime_ns: 0,
    });
    crate::core::manifest::save(&project_root, &m).unwrap();
    // ……随后在 NAS 上被篡改:planned 注入逃逸项
    let mfile = project_root.join(format!(".ocard/manifests/{}.json", m.id));
    let mut v: Value = serde_json::from_slice(&std::fs::read(&mfile).unwrap()).unwrap();
    v["planned"]
        .as_array_mut()
        .unwrap()
        .push(json!({"rel_path": "../逃逸.bin", "size": 4}));
    std::fs::write(&mfile, serde_json::to_vec_pretty(&v).unwrap()).unwrap();

    // 任务句柄(暂停态,与 start_copy_task 落进 TaskManager 的结构一致)
    let dest = project_root.join("1. 待分类/0824上午_A7M4_A_ZS");
    let state = window.state::<AppState>();
    state.tasks.insert(
        "t-tampered".into(),
        std::sync::Arc::new(crate::commands::tasks::TaskHandle {
            pause_requested: AtomicBool::new(false),
            running: AtomicBool::new(false),
            snapshot: std::sync::Mutex::new(crate::commands::dto::CopyTaskDto {
                id: "t-tampered".into(),
                project_id: pid.clone(),
                volume_id: tmp.path().join("card").display().to_string(),
                volume_name: "SDXC_01".into(),
                camera_id: "cam-1".into(),
                camera_code: "A7M4_A_ZS".into(),
                note: String::new(),
                tags: Vec::new(),
                target_folder: "0824上午_A7M4_A_ZS".into(),
                source_folders: Vec::new(),
                scan_policy_version: crate::core::manifest::SCAN_POLICY_VERSION,
                destinations: Vec::new(),
                files: Vec::new(),
                file_count: None,
                status_counts: None,
                total_bytes: 0,
                copied_bytes: 0,
                speed_bytes_per_sec: 0,
                state: "paused",
                progress_revision: None,
                operator: "ZS".into(),
                started_at: String::new(),
                finished_at: None,
            }),
            project_root: project_root.clone(),
            manifest_id: m.id.clone(),
            source_root: std::sync::Mutex::new(tmp.path().join("card")),
            plan: std::sync::Mutex::new(Vec::new()),
            dest_targets: vec![dest],
            machine_id: "TEST-MACHINE".into(),
            config_dir: tmp.path().join("config"),
            lease: Default::default(),
        }),
    );

    let e = invoke(&window, "resume_copy_task", json!({"taskId": "t-tampered"}))
        .expect_err("篡改清单必须拒绝续传");
    assert!(
        e.as_str()
            .unwrap_or_default()
            .contains("任务清单损坏或被篡改"),
        "报文必须点名篡改而非挂载环境: {e}"
    );
    // 逃逸落点(目的地根上一级)不得出现任何写入
    assert!(!project_root.join("1. 待分类/逃逸.bin").exists());
}

/// R2 成对承诺兑现:auto_proxy 意图链挂网——意图必须真正走到作业管理器
/// (重试计数先持久化、真实产生转码作业),连续三次未整批完成必须放弃:
/// proxy_completed 置位防重放 + 可见告警。删 dispatch_auto_proxy 里的
/// attempts 持久化/放弃分支/spawn_proxy_job 调用,本测试对应断言红。
#[test]
fn auto_proxy_intent_chain_wired() {
    let (window, tmp, nas) = mock_app();
    let pid = create_a_project(&window);
    let project_root = nas.join(&pid);
    let config_dir = tmp.path().join("config");

    // 拷卡完成、带 auto_proxy 意图的清单(与 start_copy_task 落盘结构一致)
    let mut m = crate::core::manifest::CopyManifest::new(
        "2. 原始素材/20260824_A7M4_A_ZS",
        "SDXC_01",
        "A7M4_A_ZS",
        "ZS",
        "",
    );
    m.auto_proxy = true;
    m.completed = true;
    crate::core::manifest::save(&project_root, &m).unwrap();

    let app = window.app_handle();
    crate::commands::transcode_cmds::dispatch_auto_proxy(
        app,
        &project_root,
        "TEST-MACHINE",
        &config_dir,
        "ZS",
        &m,
    );
    // 计数先于作业持久化(放弃上限的根据),意图真实落到作业管理器
    let m1 = crate::core::manifest::load(&project_root, &m.id).unwrap();
    assert_eq!(m1.proxy_attempts, 1, "意图派发必须先持久化重试计数");
    assert!(!m1.proxy_completed);
    let jobs = window.state::<std::sync::Arc<crate::core::jobs::JobManager>>();
    assert!(
        jobs.snapshots()
            .iter()
            .any(|s| s.kind == crate::core::jobs::JobKind::Transcode),
        "意图必须产生真实转码作业"
    );

    // 放弃路径:attempts 已达上限 → 不再重投,置位防重放,可见告警
    let mut m3 = crate::core::manifest::CopyManifest::new(
        "2. 原始素材/20260824_DJIRonin4D_B_ZS",
        "SDXC_02",
        "DJIRonin4D_B_ZS",
        "ZS",
        "",
    );
    m3.auto_proxy = true;
    m3.completed = true;
    m3.proxy_attempts = 3;
    crate::core::manifest::save(&project_root, &m3).unwrap();
    crate::commands::transcode_cmds::dispatch_auto_proxy(
        app,
        &project_root,
        "TEST-MACHINE",
        &config_dir,
        "ZS",
        &m3,
    );
    let m3r = crate::core::manifest::load(&project_root, &m3.id).unwrap();
    assert!(m3r.proxy_completed, "三次未整批完成必须放弃并防重放");
    let notices = invoke(&window, "list_notices", json!({})).unwrap();
    assert!(
        notices
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["code"] == "auto-proxy-abandoned"),
        "放弃必须可见告警: {notices}"
    );
}

/// R4 终审 P0-3 接线回归:符号链接项目经真实 handler 必须整体不可见/不可用
/// (catalog 跳过 → find_project 报「项目不存在」),不许把 NAS 外实体当项目锚。
#[cfg(unix)]
#[test]
fn symlinked_project_is_invisible_through_real_handler() {
    let (window, tmp, nas) = mock_app();
    // NAS 外造一个合法项目,再在 NAS 内放同名链接
    let outside = tmp.path().join("outside-nas");
    let date = chrono::NaiveDate::from_ymd_opt(2026, 8, 25).unwrap();
    let real = crate::core::project::create_project(
        &outside,
        date,
        "外部",
        crate::core::project::Scenario::B,
        &["开幕式".into()],
    )
    .unwrap();
    let name = real.file_name().unwrap().to_string_lossy().to_string();
    std::os::unix::fs::symlink(&real, nas.join(&name)).unwrap();

    let e = invoke(&window, "get_delivery_status", json!({"projectId": name}))
        .expect_err("链接项目必须不可用");
    assert!(
        e.as_str().unwrap_or_default().contains("项目不存在")
            || e.as_str().unwrap_or_default().contains("符号链接"),
        "报文要如实: {e}"
    );
}

/// R2 P0-4 接线回归:归档输出根的**祖先**是指向项目区的符号链接时,
/// 字符串级检查全部放行,必须由 canonicalize 复核闸拒绝——在
/// start_archive_transcode 里删掉 canonicalize 复核块本测试红。
#[cfg(unix)]
#[test]
fn archive_output_ancestor_symlink_refused_through_real_handler() {
    let (window, tmp, nas) = mock_app();
    let pid = create_a_project(&window);

    // tmp/escape_link -> 项目根;输出目录字符串上完全在项目外
    let link = tmp.path().join("escape_link");
    std::os::unix::fs::symlink(nas.join(&pid), &link).unwrap();
    let out_dir = link.join("归档区");

    let e = invoke(
        &window,
        "start_archive_transcode",
        json!({"input": {"projectId": pid, "tier": "balanced",
               "outputDir": out_dir.display().to_string()}}),
    )
    .expect_err("经链接祖先指进项目区的输出根必须被拒");
    assert!(
        e.as_str().unwrap_or_default().contains("经符号链接"),
        "报文必须点名链接绕过: {e}"
    );
    // 不得创建归档作业
    let jobs = window.state::<std::sync::Arc<crate::core::jobs::JobManager>>();
    assert!(
        jobs.snapshots()
            .iter()
            .all(|s| s.kind != crate::core::jobs::JobKind::Transcode),
        "拒绝路径不得留下转码作业"
    );
    // R4(终审 P0-5):拒绝必须**零文件系统副作用**——老实现先 create_dir_all
    // 再 canonicalize,会先在项目内建出「归档区」再报错
    assert!(
        !nas.join(&pid).join("归档区").exists(),
        "闸必须先于副作用:项目内不得出现被创建的输出目录"
    );
}

// ---------- 真实链路行为级(完整网络会话兑现:行为级验证不再只属于 E2E/CI) ----------

/// 把仓内 target-triple 命名的 sidecar 以裸名注入一个**进程内共用的固定目录**,
/// 返回该目录。sidecar 缺失(未跑 scripts/fetch-ffmpeg.sh)时返回 None,
/// 调用方如实跳过。
///
/// 为什么落在 `target/` 而不是各用例自己的 TempDir(修一类假红):
/// `transcode_cmds` 的 `PROBE_STATE` 是**进程级**缓存,里面存的是 ffmpeg /
/// ffprobe 的**绝对路径**;而 `transcode_capabilities` 会在后台线程里读
/// `OCARD_FFMPEG_DIR`,它并不持有 `FFMPEG_ENV_LOCK`。于是只要某个用例在
/// 别的用例设着 env 的窗口里触发一次探测,这份全局缓存就会记下**那个用例的
/// 临时目录**;等那个 TempDir 随用例结束被删掉,后面真正用转码的用例就会
/// 拿着一条死路径去 spawn,报出 `No such file or directory`——一个和被测
/// 逻辑毫无关系的假红,而且只在并行跑全量时出现。
///
/// 固定目录让「被别人缓存下来的路径」始终有效,从根上消掉这一类竞态。
#[cfg(unix)]
fn stage_sidecar_dir(_tmp: &std::path::Path) -> Option<std::path::PathBuf> {
    let bins = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("test-sidecar");
    std::fs::create_dir_all(&dir).ok()?;
    for name in ["ffmpeg", "ffprobe"] {
        let src = std::fs::read_dir(&bins)
            .ok()?
            .flatten()
            .map(|e| e.path())
            .find(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().starts_with(&format!("{name}-")))
                    .unwrap_or(false)
                    && p.extension().is_none_or(|e| e != "txt")
            })?;
        let link = dir.join(name);
        // 目录是共用的:并行用例会同时来铺,已经铺好就直接用。
        // 但要验一眼链接确实指得到东西——半截的链接比没有还糟
        match std::os::unix::fs::symlink(&src, &link) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return None,
        }
        if !link.is_file() {
            return None;
        }
    }
    Some(dir)
}

/// R2 P1 行为级(真 ffmpeg):代理转码端到端——转出真产物;重跑幂等且
/// 「既有产物」经 ffprobe 验真才计完成;坏产物如实报失败绝不采信;
/// hwenc-fallback 告警与真实硬编探测结果一致(无硬编必须告警——Linux
/// 容器/runner;有硬编不得误报——macOS runner 的 VideoToolbox 真探针会过)。
/// sidecar 由 scripts/fetch-ffmpeg.sh 拉取(CI 在 cargo test 前已就位)。
#[cfg(unix)]
#[test]
fn proxy_transcode_end_to_end_with_real_ffmpeg() {
    let (window, tmp, nas) = mock_app();
    let Some(ffdir) = stage_sidecar_dir(tmp.path()) else {
        // CI 上 sidecar 必须在 cargo test 前就位(各 job 的 fetch-ffmpeg 步骤);
        // 缺失=流程坏了,硬失败——绝不允许在 CI 静默空转
        assert!(
            std::env::var_os("CI").is_none(),
            "CI 上缺 sidecar:fetch-ffmpeg 步骤未生效,拒绝静默跳过"
        );
        eprintln!("跳过:src-tauri/binaries 无 sidecar(先跑 scripts/fetch-ffmpeg.sh)");
        return;
    };
    // env 是进程全局:与 ffmpeg.rs 的 env 测试共用进程级互斥,持锁贯穿全程。
    // R4:panic 也要清 env(否则失败会连锁污染并行的 missing 断言)——Drop 兜底
    struct EnvGuard;
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            std::env::remove_var("OCARD_FFMPEG_DIR");
        }
    }
    let _g = crate::core::ffmpeg::FFMPEG_ENV_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    std::env::set_var("OCARD_FFMPEG_DIR", &ffdir);
    let _env_guard = EnvGuard;

    let pid = create_a_project(&window);
    let cam_dir = nas.join(&pid).join("2. 原始素材/20260824_A7M4_A_ZS");
    std::fs::create_dir_all(&cam_dir).unwrap();
    // 真视频源:1s 640x360 纯色(低负载,不触发高负载跳过规则)
    let src = cam_dir.join("C0001.MP4");
    let out = std::process::Command::new(ffdir.join("ffmpeg"))
        .args([
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=640x360:d=1:r=25",
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx264",
        ])
        .arg(&src)
        .output()
        .expect("生成测试视频失败");
    assert!(
        out.status.success() && src.is_file(),
        "ffmpeg 生成源视频失败: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    let run_job = || {
        let snap = invoke(
            &window,
            "start_proxy_transcode",
            // 代理默认只转高负载素材;测试片是低负载,走「整夹强制全转」
            json!({"input": {"projectId": pid, "forceAll": true}}),
        )
        .expect("发起代理转码应成功");
        let job_id = snap["id"].as_str().unwrap().to_string();
        let mut last = json!(null);
        // 首轮含编码器真探针(逐 encoder 带超时),预算放宽
        for _ in 0..2400 {
            last = invoke(&window, "get_job", json!({"jobId": job_id})).unwrap();
            if ["done", "failed", "cancelled"].contains(&last["state"].as_str().unwrap_or_default())
            {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        last
    };

    // 第一轮:真转码出产物
    let r1 = run_job();
    assert_eq!(r1["state"], "done", "{r1}");
    assert_eq!(r1["result"]["converted"], 1, "{r1}");
    let final_out = nas
        .join(&pid)
        .join("4. 转码素材/20260824_A7M4_A_ZS/C0001_MP4_proxy.mp4");
    assert!(final_out.is_file(), "代理产物必须落盘");
    // hwenc-fallback 告警必须与真实探测结果一致(R2 P1):无硬编(Linux
    // 容器/runner)必须可见;有硬编(macOS VideoToolbox)不得误报。
    // 作业已跑过 capabilities_blocking,PROBE_STATE 为 Ready,命令直接回缓存
    let caps = invoke(&window, "transcode_capabilities", json!({})).unwrap();
    assert_eq!(caps["status"], "ready", "{caps}");
    let has_hw = caps["report"]["winners"]
        .as_object()
        .map(|w| w.keys().any(|k| k.ends_with("_hw")))
        .unwrap_or(false);
    let notices = invoke(&window, "list_notices", json!({})).unwrap();
    let fallback_seen = notices
        .as_array()
        .unwrap()
        .iter()
        .any(|n| n["code"] == "hwenc-fallback");
    assert_eq!(
        fallback_seen, !has_hw,
        "软编回退告警必须与硬编探测一致(has_hw={has_hw}): {notices}"
    );

    // 第二轮:幂等——既有产物 ffprobe 验真通过才计 alreadyTranscoded
    let r2 = run_job();
    assert_eq!(r2["state"], "done", "{r2}");
    assert_eq!(r2["result"]["alreadyTranscoded"], 1, "{r2}");
    assert_eq!(r2["result"]["converted"], 0, "{r2}");

    // 第三轮:坏产物绝不采信(R2 P1「存在即成功」修复的行为级证据)
    std::fs::write(&final_out, b"garbage-not-a-video").unwrap();
    let r3 = run_job();
    assert_eq!(r3["state"], "done", "{r3}");
    assert_eq!(
        r3["result"]["alreadyTranscoded"], 0,
        "坏产物不得计入完成: {r3}"
    );
    assert_eq!(r3["result"]["converted"], 0, "{r3}");
    let msg = r3["result"]["failures"][0]["message"]
        .as_str()
        .unwrap_or_default();
    assert!(msg.contains("未通过完整校验"), "坏产物必须如实报失败: {r3}");

    // 第四轮(R4 终审 P0-6):**合法但错误**的既有产物——把 1s 源的有效代理
    // 冒充 3s 新源的产物,只验 codec 会放行,完整校验必须按时长偏差拒绝
    let src2 = cam_dir.join("C0002.MP4");
    let out2 = std::process::Command::new(ffdir.join("ffmpeg"))
        .args([
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=25:duration=3",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            &src2.to_string_lossy(),
        ])
        .output()
        .unwrap();
    assert!(out2.status.success(), "生成 3s 测试源失败");
    // 清掉 C0001 的垃圾产物,让两支都重转出**有效**代理
    std::fs::remove_file(&final_out).unwrap();
    let r4a = run_job();
    assert_eq!(r4a["result"]["converted"], 2, "两支源都应重转成功: {r4a}");
    // R5 三票反例:**保留正确 sidecar、只替换视频文件**——用 C0001 的有效代理
    // 顶换 C0002 的产物(C0002 的 sidecar 原样保留)。来源指纹匹配,但
    // sidecar 里钉住的产物哈希必须把它拦下(时长校验是后面的第二道防线)
    let fake_done = final_out.with_file_name("C0002_MP4_proxy.mp4");
    std::fs::remove_file(&fake_done).unwrap();
    std::fs::copy(&final_out, &fake_done).unwrap();
    let r4 = run_job();
    let fails = r4["result"]["failures"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(
        fails.iter().any(|f| {
            f["rel"].as_str().unwrap_or_default().ends_with("C0002.MP4")
                && f["message"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("产物哈希与指纹记录不符")
        }),
        "保留 sidecar 只换视频必须被产物哈希绑定拒绝: {r4}"
    );
    assert_eq!(
        r4["result"]["alreadyTranscoded"], 1,
        "C0001 的真产物照常计入完成: {r4}"
    );

    // 第五轮(R5 终审):**同时长同几何的他源产物**——先修好 C0002(重转出
    // 真 3s 代理),再造 C0003(同参数另一画面),把 C0002 的真代理冒充给
    // C0003(无 sidecar):属性全对,必须由来源指纹拒绝
    std::fs::remove_file(&fake_done).unwrap();
    let r5a = run_job();
    assert_eq!(r5a["result"]["converted"], 1, "C0002 重转应成功: {r5a}");
    let src3 = cam_dir.join("C0003.MP4");
    let out3 = std::process::Command::new(ffdir.join("ffmpeg"))
        .args([
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=640x360:rate=25:duration=3",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            &src3.to_string_lossy(),
        ])
        .output()
        .unwrap();
    assert!(out3.status.success(), "生成 C0003 失败");
    std::fs::copy(&fake_done, final_out.with_file_name("C0003_MP4_proxy.mp4")).unwrap();
    let r5 = run_job();
    let fails5 = r5["result"]["failures"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(
        fails5.iter().any(|f| {
            f["rel"].as_str().unwrap_or_default().ends_with("C0003.MP4")
                && f["message"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("来源指纹")
        }),
        "同时长他源产物必须被来源指纹拒绝: {r5}"
    );
    assert_eq!(
        r5["result"]["alreadyTranscoded"], 2,
        "C0001/C0002 照常: {r5}"
    );
}

/// R2 P1 行为级(真模型 + 真 ort 推理):YuNet 检测器加载仓内模型
/// (SHA 钉死)并真实跑推理——faces 必须是 Some(数字)而非 None,
/// 且不得出现 ai-models-corrupt 告警。合成图无脸,0 即正确;
/// 判别点在「检测器在场时 faces 绝不为 null」。
#[test]
fn analysis_runs_real_yunet_inference() {
    let models = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/models");
    assert!(
        models.join(crate::core::yunet::YUNET_FILE).is_file(),
        "仓内应有 YuNet 模型"
    );
    std::env::set_var("OCARD_MODELS_DIR", &models);

    let (window, _tmp, nas) = mock_app();
    let pid = create_b_project(&window);
    let inbox = nas.join(&pid).join("1. 待分类/x");
    std::fs::create_dir_all(&inbox).unwrap();
    let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(320, 240, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
    }));
    img.save(inbox.join("a.jpg")).unwrap();

    let snap = invoke(&window, "start_analysis", json!({"projectId": pid})).unwrap();
    let job_id = snap["id"].as_str().unwrap().to_string();
    let mut last = json!(null);
    for _ in 0..600 {
        last = invoke(&window, "get_job", json!({"jobId": job_id})).unwrap();
        if ["done", "failed", "cancelled"].contains(&last["state"].as_str().unwrap_or_default()) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(last["state"], "done", "{last}");
    assert_eq!(last["result"]["analyzed"], 1, "{last}");

    // 特征落盘里 faces 必须是数字(检测器在场,推理真实跑过)
    let text = std::fs::read_to_string(
        nas.join(&pid)
            .join(".ocard/analysis/features-TEST-MACHINE.jsonl"),
    )
    .unwrap();
    let rec: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    assert!(
        rec["faces"].is_number(),
        "检测器在场时 faces 必须为数字(推理失败才是 null): {rec}"
    );
    // 模型校验/加载不得报损坏
    let notices = invoke(&window, "list_notices", json!({})).unwrap();
    assert!(
        !notices
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["code"] == "ai-models-corrupt"),
        "真模型不得报损坏: {notices}"
    );
}

#[test]
fn create_storage_card_bind_rejects_unmounted_and_system_paths() {
    // 插卡绑定的两道闸(UX 波二评审 P1/P4):
    // 1) 任意目录(未挂载)不许写指纹;2) 系统内置盘一律拒绑。
    let (window, _tmp, _nas) = mock_app();
    let cam = invoke(
        &window,
        "create_camera",
        json!({"input": {"model": "A7M4", "position": "A", "operatorAlias": "ZS"}}),
    )
    .expect("登记相机应成功");
    let cam_id = cam["id"].as_str().unwrap().to_string();

    // 未挂载的任意目录:ensure_volume_uid 之前就必须拦下(不留无主指纹)
    let stray = tempfile::tempdir().unwrap();
    let err = invoke(
        &window,
        "create_storage_card",
        json!({"input": {"label": "SD-X", "cameraId": cam_id, "capacityBytes": 1,
                "bindMountPath": stray.path().to_string_lossy()}}),
    )
    .expect_err("未挂载路径必须拒绝");
    assert!(
        err.as_str().unwrap().contains("未挂载"),
        "错误应指明未挂载: {err}"
    );
    assert!(
        !stray
            .path()
            .join(crate::core::volumes::VOLUME_UID_FILE)
            .exists(),
        "拒绝路径上不得留下指纹文件"
    );

    // 系统盘(mac/linux 上 `/` 必在挂载列表且 system=true)
    let err = invoke(
        &window,
        "create_storage_card",
        json!({"input": {"label": "SD-Y", "cameraId": cam_id, "capacityBytes": 1,
                "bindMountPath": "/"}}),
    )
    .expect_err("系统盘必须拒绝");
    assert!(
        err.as_str().unwrap().contains("系统内置盘"),
        "错误应指明系统盘: {err}"
    );
}

#[cfg(test)]
mod match_card_tests {
    use crate::commands::match_card;
    use crate::core::registry::StorageCard;

    fn card(id: &str, label: &str, uid: Option<&str>) -> StorageCard {
        StorageCard {
            id: id.into(),
            label: label.into(),
            camera_id: "cam".into(),
            capacity_bytes: 1,
            serial: None,
            volume_uid: uid.map(str::to_string),
            created_at: chrono::Utc::now(),
        }
    }

    #[test]
    fn uid_beats_label() {
        // 指纹指向 A、卷标同 B:以指纹为准,且差异必须上报
        let cards = vec![card("a", "CFE-01", Some("u1")), card("b", "SDCARD", None)];
        let (hit, conflict) = match_card(&cards, Some("u1"), "SDCARD");
        assert_eq!(hit.as_deref(), Some("a"));
        assert!(conflict.unwrap().contains("以指纹为准"));
    }

    #[test]
    fn duplicate_uid_matches_nothing_and_reports() {
        let cards = vec![
            card("a", "CFE-01", Some("u1")),
            card("b", "CFE-02", Some("u1")),
        ];
        let (hit, conflict) = match_card(&cards, Some("u1"), "ANY");
        assert!(hit.is_none());
        assert!(conflict.unwrap().contains("多张卡"));
    }

    #[test]
    fn unknown_uid_only_falls_back_to_unbound_cards() {
        // 卷带未登记指纹,卷标对上的卡绑着别的指纹:不许静默配对
        let cards = vec![card("b", "SDCARD", Some("u2"))];
        let (hit, conflict) = match_card(&cards, Some("u-unknown"), "SDCARD");
        assert!(hit.is_none());
        assert!(conflict.unwrap().contains("重新绑定"));
        // 卷标对上的是从未绑过指纹的旧卡:允许弱匹配
        let cards = vec![card("b", "SDCARD", None)];
        let (hit, conflict) = match_card(&cards, Some("u-unknown"), "SDCARD");
        assert_eq!(hit.as_deref(), Some("b"));
        assert!(conflict.is_none());
    }

    #[test]
    fn no_uid_label_match_stays() {
        let cards = vec![card("b", "SDCARD", None)];
        let (hit, conflict) = match_card(&cards, None, "sdcard");
        assert_eq!(hit.as_deref(), Some("b"));
        assert!(conflict.is_none());
    }
}

#[test]
fn project_cards_roundtrip_and_validation() {
    // 项目用卡清单(UX 波三):set→读回;未登记的卡拒绝;x/y 随清单出现
    let (window, _tmp, _nas) = mock_app();
    let project_id = create_b_project(&window);
    let cam = invoke(
        &window,
        "create_camera",
        json!({"input": {"model": "Z9", "position": "E", "operatorAlias": "CQ"}}),
    )
    .expect("登记相机应成功");
    let card = invoke(
        &window,
        "create_storage_card",
        json!({"input": {"label": "SD-06", "cameraId": cam["id"], "capacityBytes": 1}}),
    )
    .expect("登记卡应成功");
    let card_id = card["id"].as_str().unwrap().to_string();

    // 未配置时:项目不带 x/y 字段
    let projects = invoke(&window, "list_projects", json!({})).unwrap();
    let p = projects
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == json!(project_id.clone()))
        .unwrap();
    assert!(p.get("cardRosterTotal").is_none(), "未配置不得伪造分母");

    // 未登记的卡进清单必须拒绝
    let err = invoke(
        &window,
        "set_project_cards",
        json!({"projectId": project_id, "cardIds": ["ghost-card"]}),
    )
    .expect_err("幽灵卡必须拒绝");
    assert!(err.as_str().unwrap().contains("未登记"));

    // set → 读回(含去重)
    let dto = invoke(
        &window,
        "set_project_cards",
        json!({"projectId": project_id, "cardIds": [card_id.clone(), card_id.clone()]}),
    )
    .expect("设置清单应成功");
    assert_eq!(dto["cardIds"], json!([card_id.clone()]));
    assert_eq!(dto["copiedCardIds"], json!([]));

    let listed = invoke(
        &window,
        "list_project_cards",
        json!({"projectId": project_id}),
    )
    .unwrap();
    assert_eq!(listed["cardIds"], json!([card_id.clone()]));

    // x/y 字段随清单出现:y=1,x=0
    let projects = invoke(&window, "list_projects", json!({})).unwrap();
    let p = projects
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == json!(project_id))
        .unwrap();
    assert_eq!(p["cardRosterTotal"], json!(1));
    assert_eq!(p["cardRosterDone"], json!(0));
}

#[test]
fn project_cards_empty_and_pruned_semantics() {
    // 空清单等价未配置(不出现 0/0);登记卡删除后旧清单不锁死(评审 P1)
    let (window, _tmp, _nas) = mock_app();
    let project_id = create_b_project(&window);
    let cam = invoke(
        &window,
        "create_camera",
        json!({"input": {"model": "R5C", "position": "C", "operatorAlias": "WH"}}),
    )
    .unwrap();
    let card = invoke(
        &window,
        "create_storage_card",
        json!({"input": {"label": "CF-04", "cameraId": cam["id"], "capacityBytes": 1}}),
    )
    .unwrap();
    let card_id = card["id"].as_str().unwrap().to_string();

    invoke(
        &window,
        "set_project_cards",
        json!({"projectId": project_id, "cardIds": [card_id.clone()]}),
    )
    .unwrap();

    // 删除登记卡后:x/y 字段消失(清单只剩死 id,过滤后为空 = 未配置)
    invoke(
        &window,
        "delete_storage_card",
        json!({"cardId": card_id.clone()}),
    )
    .unwrap();
    let projects = invoke(&window, "list_projects", json!({})).unwrap();
    let p = projects
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == json!(project_id.clone()))
        .unwrap();
    assert!(
        p.get("cardRosterTotal").is_none(),
        "死 id 不得撑分母,空清单等价未配置: {p}"
    );

    // 关键:清单里带着已注销 id 时仍可编辑——旧 id 被剔除而不是整单拒绝
    let dto = invoke(
        &window,
        "set_project_cards",
        json!({"projectId": project_id, "cardIds": [card_id]}),
    )
    .expect("含已注销 id 的清单编辑不得被锁死");
    assert_eq!(dto["cardIds"], json!([]));
}

/// 「按文件夹多选」两条新命令的接线 + 契约字段名(前端逐字按这些键取值)。
/// 同时钉住零静默:源卷不可达必须报人话,绝不吞成空列表(空列表 =
/// 用户会当成「卡是空的」而去格式化)。
#[test]
fn source_folder_commands_wired_through_real_handler() {
    let (window, tmp, _nas) = mock_app();
    let card = tmp.path().join("card");
    std::fs::create_dir_all(card.join("DCIM/100MSDCF")).unwrap();
    std::fs::create_dir_all(card.join("DCIM/101MSDCF")).unwrap();
    std::fs::create_dir_all(card.join("空夹")).unwrap();
    std::fs::write(card.join("DCIM/100MSDCF/DSC1.JPG"), vec![1u8; 1000]).unwrap();
    std::fs::write(card.join("DCIM/101MSDCF/DSC1.JPG"), vec![2u8; 2000]).unwrap();
    std::fs::write(card.join("ROOT.MP4"), vec![3u8; 3000]).unwrap();
    let vid = card.display().to_string();
    // R9:源卷必须先解析到权威卷清单——测试里把这张「卡」登记进去
    let _mounted = crate::commands::TestVolumeGuard::mount(&card);

    let list =
        invoke(&window, "list_source_folders", json!({"volumeId": vid})).expect("列文件夹应成功");
    let rels: Vec<&str> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["relPath"].as_str().unwrap())
        .collect();
    assert_eq!(rels, vec!["", "DCIM", "DCIM/100MSDCF", "DCIM/101MSDCF"]);
    assert_eq!(list[0]["fileCount"], 1);
    assert_eq!(list[0]["totalBytes"], 3000);
    assert_eq!(list[0]["hasSubfolders"], true);

    // 两个夹子里各有一个 DSC1.JPG:必须给出改名清单(camelCase 逐字对齐)
    let plan = invoke(
        &window,
        "plan_source_selection",
        json!({"volumeId": vid, "folders": ["DCIM/100MSDCF", "DCIM/101MSDCF"]}),
    )
    .expect("规划应成功");
    assert_eq!(plan["fileCount"], 2);
    assert_eq!(plan["totalBytes"], 3000);
    let renamed = plan["renamedFiles"].as_array().unwrap();
    assert_eq!(renamed.len(), 2, "重名必须逐条列出: {plan}");
    assert!(renamed.iter().any(
        |r| r["sourceRel"] == "DCIM/100MSDCF/DSC1.JPG" && r["targetRel"] == "100MSDCF_DSC1.JPG"
    ));

    // 空数组 = 整卷:保留层级,不会撞名
    let whole = invoke(
        &window,
        "plan_source_selection",
        json!({"volumeId": vid, "folders": []}),
    )
    .expect("整卷规划应成功");
    assert_eq!(whole["fileCount"], 3);
    assert_eq!(whole["totalBytes"], 6000);
    assert!(whole["renamedFiles"].as_array().unwrap().is_empty());

    // 卷不存在:报人话,不返回空列表
    let e = invoke(
        &window,
        "list_source_folders",
        json!({"volumeId": tmp.path().join("拔掉了").display().to_string()}),
    )
    .expect_err("不存在的卷必须报错而非空列表");
    assert!(
        e.as_str()
            .unwrap_or_default()
            .contains("源卷不存在或已被拔出"),
        "{e}"
    );

    // R9:存在、可读,但**不是挂载卷**的目录不许当拷卡源——
    // 否则能拿它读到卡外的目录树、文件计数与部分文件名
    let outside = tmp.path().join("卡外目录");
    std::fs::create_dir_all(outside.join("私人")).unwrap();
    std::fs::write(outside.join("私人/机密.txt"), b"x").unwrap();
    for cmd in ["list_source_folders", "plan_source_selection"] {
        let e = invoke(
            &window,
            cmd,
            json!({"volumeId": outside.display().to_string(), "folders": []}),
        )
        .unwrap_err();
        assert!(
            e.as_str()
                .unwrap_or_default()
                .contains("不是当前挂载的存储卷"),
            "{cmd}: {e}"
        );
    }

    // 路径逃逸:拒绝
    let e = invoke(
        &window,
        "plan_source_selection",
        json!({"volumeId": vid, "folders": ["../外面"]}),
    )
    .expect_err("越界文件夹必须被拒");
    assert!(
        e.as_str().unwrap_or_default().contains("文件夹路径非法"),
        "{e}"
    );
}

/// 续传前的清单刷新:整卷保持历史行为(重扫 ∪ 锁定清单),
/// 按文件夹则只认开拷时锁定的落点——卡上新增的文件不悄悄带进来,
/// 但必须发用户可见的告警(零静默:跳过任何东西都要说)。
#[test]
fn resume_plan_refresh_locks_targets_for_folder_selection() {
    use crate::core::manifest::{CopyManifest, PlannedFile};
    let (window, tmp, _nas) = mock_app();
    let app = window.app_handle();
    let card = tmp.path().join("card");
    std::fs::create_dir_all(card.join("D")).unwrap();
    std::fs::write(card.join("D/a.jpg"), vec![1u8; 10]).unwrap();
    std::fs::write(card.join("D/新来的.jpg"), vec![2u8; 20]).unwrap();
    // R8:刷新出来的计划要原子写回清单,所以需要一个真的项目根
    let project_root = tmp.path().join("proj");
    std::fs::create_dir_all(&project_root).unwrap();

    // 整卷:重扫到的新文件照旧带上,计划内已消失的文件也留着(引擎会记失败)
    let mut whole = CopyManifest::new("t", "card", "A7M4_A_ZS", "ZS", "");
    whole.planned = vec![
        PlannedFile {
            rel_path: "D/a.jpg".into(),
            size: 10,
            source_rel: String::new(),
            source_mtime_ns: 0,
        },
        PlannedFile {
            rel_path: "D/没了.jpg".into(),
            size: 99,
            source_rel: String::new(),
            source_mtime_ns: 0,
        },
    ];
    let plan = crate::commands::refresh_resume_plan(app, &mut whole, &project_root, &card).unwrap();
    let mut rels: Vec<&str> = plan.iter().map(|p| p.target_rel.as_str()).collect();
    rels.sort();
    assert_eq!(rels, vec!["D/a.jpg", "D/新来的.jpg", "D/没了.jpg"]);
    assert!(
        plan.iter().all(|p| p.source_rel == p.target_rel),
        "整卷源即目标"
    );

    // 按文件夹:落点已锁定,新增文件不进清单,但要有可见告警
    let mut folder = CopyManifest::new("t", "card", "A7M4_A_ZS", "ZS", "");
    folder.source_selection = vec!["D".into()];
    folder.planned = vec![PlannedFile {
        rel_path: "a.jpg".into(),
        size: 10,
        source_rel: "D/a.jpg".into(),
        source_mtime_ns: 0,
    }];
    let plan =
        crate::commands::refresh_resume_plan(app, &mut folder, &project_root, &card).unwrap();
    assert_eq!(plan.len(), 1, "新增文件不得改动锁定的清单: {plan:?}");
    assert_eq!(plan[0].source_rel, "D/a.jpg");
    assert_eq!(plan[0].target_rel, "a.jpg");
    let notices = invoke(&window, "list_notices", json!({})).unwrap();
    assert!(
        notices
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["code"] == "copy-resume-new-files"),
        "跳过新增文件必须发用户可见告警: {notices}"
    );

    // 暂停期间源文件被改写:尺寸必须取当前实际值(沿用旧 size 会让 manifest
    // 记下与内容不符的长度、进度也失真),并且这件事要说出来
    folder.completed = true; // 模拟「上一轮跑完标了完成」的清单
    crate::core::manifest::save(&project_root, &folder).unwrap();
    std::fs::write(card.join("D/a.jpg"), vec![9u8; 25]).unwrap();
    let plan =
        crate::commands::refresh_resume_plan(app, &mut folder, &project_root, &card).unwrap();
    assert_eq!(plan[0].size, 25, "尺寸必须跟上源文件的实际变化");
    assert_eq!(plan[0].target_rel, "a.jpg", "落点仍沿用锁定值");
    let notices = invoke(&window, "list_notices", json!({})).unwrap();
    assert!(
        notices
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["code"] == "copy-resume-size-changed"),
        "源文件变了必须可见告警: {notices}"
    );

    // R8(必修):刷新出来的尺寸必须**原子地**同时落到内存与磁盘上的 planned。
    // 只改内存会留下 `planned.size = 旧值` / `entry.size = 新值` /
    // `completed = true` 的自相矛盾清单。
    assert_eq!(folder.planned[0].size, 25, "内存里的 planned 要跟上");
    assert!(!folder.completed, "计划变了就还没跑完,completed 必须回落");
    assert_ne!(
        folder.planned[0].source_mtime_ns, 0,
        "要记下源文件身份/mtime"
    );
    let saved = crate::core::manifest::load(&project_root, &folder.id).unwrap();
    assert_eq!(
        saved.planned[0].size, 25,
        "持久化的 planned 必须跟着更新,否则清单自相矛盾"
    );
    assert!(!saved.completed);

    // 同大小、内容被换掉(只有 mtime 会动):此前完全没有告警
    std::thread::sleep(std::time::Duration::from_millis(10));
    std::fs::write(card.join("D/a.jpg"), vec![7u8; 25]).unwrap();
    let f = std::fs::OpenOptions::new()
        .write(true)
        .open(card.join("D/a.jpg"))
        .unwrap();
    f.set_times(
        std::fs::FileTimes::new()
            .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(60)),
    )
    .unwrap();
    drop(f);
    crate::commands::refresh_resume_plan(app, &mut folder, &project_root, &card).unwrap();
    let notices = invoke(&window, "list_notices", json!({})).unwrap();
    assert!(
        notices
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["code"] == "copy-resume-content-replaced"),
        "同大小但内容被替换必须可见告警: {notices}"
    );
}

/// R11 影响面 + R13 C6(归因):排除口径收紧后续传**升级前**建的任务,会凭空冒出
/// 一批点开头的文件。用户看到「卡上多了文件」的第一反应是有人动过这张卡——那是
/// 完全错误的排查方向,必须说清可能是口径变了。
///
/// 但**反过来断言「不是这张卡被人动过」同样是编造**:本版本新建的任务在暂停期间
/// 用户真的新增了一个 `.clip.mov`,长得一模一样。唯一的证据是清单里的
/// `scan_policy_version`(缺失 = 旧口径),而且即便是旧口径也**不能排除**卡上真的
/// 变了。两个方向都要测到。
/// (删掉 `policy_upgrade_caveat`、或让它无视版本号,本测试必红。)
#[test]
fn resume_explains_files_that_appeared_because_the_scan_policy_widened() {
    use crate::core::manifest::{CopyManifest, PlannedFile};
    let (window, tmp, _nas) = mock_app();
    let app = window.app_handle();
    let card = tmp.path().join("card-widened");
    std::fs::create_dir_all(card.join("D")).unwrap();
    std::fs::write(card.join("D/a.jpg"), vec![1u8; 10]).unwrap();
    // 升级前这个文件因为「点开头」被排除,所以不在老任务锁定的清单里
    std::fs::write(card.join("D/.clip.mov"), vec![2u8; 20]).unwrap();
    let project_root = tmp.path().join("proj-widened");
    std::fs::create_dir_all(&project_root).unwrap();

    // ① 按文件夹:落点已锁定,新冒出来的不进清单,但要说清为什么会冒出来
    let mut folder = CopyManifest::new("t", "card", "A7M4_A_ZS", "ZS", "");
    // 升级前锁定的清单:老 manifest 没有这个字段,反序列化为 0 = 旧口径
    folder.scan_policy_version = 0;
    folder.source_selection = vec!["D".into()];
    folder.planned = vec![PlannedFile {
        rel_path: "a.jpg".into(),
        size: 10,
        source_rel: "D/a.jpg".into(),
        source_mtime_ns: 0,
    }];
    let plan =
        crate::commands::refresh_resume_plan(app, &mut folder, &project_root, &card).unwrap();
    assert_eq!(plan.len(), 1, "锁定的清单不受影响: {plan:?}");
    let notices = invoke(&window, "list_notices", json!({})).unwrap();
    let msg = notices
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["code"] == "copy-resume-new-files")
        .map(|n| n["message"].as_str().unwrap_or_default().to_string())
        .unwrap_or_else(|| panic!("必须发新增文件告警: {notices}"));
    assert!(msg.contains("D/.clip.mov"), "新增的要点名: {msg}");
    assert!(
        msg.contains("旧口径") && msg.contains("可能"),
        "旧清单要说清可能是策略升级带来的: {msg}"
    );
    assert!(
        msg.contains("无法区分"),
        "但不能排除卡上真的变了——不许下定论: {msg}"
    );
    assert!(
        !msg.contains("不是这张卡被人动过"),
        "没有证据排除卡内容变化,不许这么说: {msg}"
    );

    // ② 整卷:新冒出来的会被**真的拷贝**,任务完成度也会回退——更要说清楚
    let mut whole = CopyManifest::new("t", "card", "A7M4_A_ZS", "ZS", "");
    whole.scan_policy_version = 0; // 同上:升级前锁定的清单
    whole.planned = vec![PlannedFile {
        rel_path: "D/a.jpg".into(),
        size: 10,
        source_rel: String::new(),
        source_mtime_ns: 0,
    }];
    let plan = crate::commands::refresh_resume_plan(app, &mut whole, &project_root, &card).unwrap();
    assert_eq!(plan.len(), 2, "整卷续传会把它带上: {plan:?}");
    let notices = invoke(&window, "list_notices", json!({})).unwrap();
    let msg = notices
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["code"] == "copy-resume-scope-widened")
        .map(|n| n["message"].as_str().unwrap_or_default().to_string())
        .unwrap_or_else(|| panic!("整卷续传纳入新条目必须可见: {notices}"));
    assert!(msg.contains("D/.clip.mov"), "新纳入的要点名: {msg}");
    assert!(
        msg.contains("会被拷贝") && msg.contains("旧口径"),
        "要说清会被拷贝、且可能是口径变了: {msg}"
    );
    assert!(
        !msg.contains("不是这张卡被人动过"),
        "没有证据排除卡内容变化,不许这么说: {msg}"
    );

    // ③ **本版本**锁定的清单里冒出点开头的文件:策略升级解释不了,必须按
    //    「卡上真的变了」来说。旧措辞会把这一次真实变更说成「升级带来的」,
    //    用户于是放过它——归因错误比不归因更糟。
    let mut fresh = CopyManifest::new("t", "card", "A7M4_A_ZS", "ZS", "");
    assert_eq!(
        fresh.scan_policy_version,
        crate::core::manifest::SCAN_POLICY_VERSION,
        "前置断言:新清单记的是当前口径"
    );
    fresh.source_selection = vec!["D".into()];
    fresh.planned = vec![PlannedFile {
        rel_path: "a.jpg".into(),
        size: 10,
        source_rel: "D/a.jpg".into(),
        source_mtime_ns: 0,
    }];
    crate::commands::refresh_resume_plan(app, &mut fresh, &project_root, &card).unwrap();
    let notices = invoke(&window, "list_notices", json!({})).unwrap();
    let msg = notices
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|n| n["code"] == "copy-resume-new-files")
        .map(|n| n["message"].as_str().unwrap_or_default().to_string())
        .unwrap_or_else(|| panic!("必须发新增文件告警: {notices}"));
    assert!(
        msg.contains("策略升级解释不了"),
        "本版本锁定的清单不许把真实新增甩锅给策略升级: {msg}"
    );
}

/// R13 C3(P0):续传前刷新的清单**写回失败就不许续传**(fail-closed)。
///
/// 此前只发一条告警就放行:worker 拿着内存里刷新过的新计划开跑,却基于**磁盘上
/// 的旧 `planned`** 保存进度——审计范围与实际拷贝范围就此分叉,事后查到的
/// 「拷了什么」不是真的拷了什么。清单是这个工具的审计凭证。
///
/// 判别性:把 `persist_refreshed_plan` 改回只告警不返回 Err,本测试必红。
#[test]
fn resume_refuses_when_the_refreshed_manifest_cannot_be_persisted() {
    use crate::core::manifest::{CopyManifest, PlannedFile};
    let (window, tmp, _nas) = mock_app();
    let app = window.app_handle();
    let card = tmp.path().join("card-nopersist");
    std::fs::create_dir_all(card.join("D")).unwrap();
    // 暂停期间文件被改大了 → 刷新后的计划与锁定的那份不同 → 必须写回
    std::fs::write(card.join("D/a.jpg"), vec![1u8; 999]).unwrap();

    let project_root = tmp.path().join("proj-nopersist");
    // 把 `.ocard/manifests` 占成一个**普通文件**:manifest::save 必然失败
    std::fs::create_dir_all(project_root.join(".ocard")).unwrap();
    std::fs::write(project_root.join(".ocard/manifests"), b"not a dir").unwrap();

    let mut m = CopyManifest::new("t", "card", "A7M4_A_ZS", "ZS", "");
    m.source_selection = vec!["D".into()];
    m.planned = vec![PlannedFile {
        rel_path: "a.jpg".into(),
        size: 10, // 与盘上的 999 不一致 → 刷新必然改动清单
        source_rel: "D/a.jpg".into(),
        source_mtime_ns: 0,
    }];
    let e = crate::commands::refresh_resume_plan(app, &mut m, &project_root, &card)
        .expect_err("写不回清单就不许续传");
    assert!(
        e.contains("拒绝续传") && e.contains("审计范围"),
        "必须说清为什么拒绝: {e}"
    );
    let notices = invoke(&window, "list_notices", json!({})).unwrap();
    assert!(
        notices
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["code"] == "copy-resume-manifest-not-persisted"),
        "拒绝之外还要有可见告警: {notices}"
    );
}

/// R13 C4(P1):**整卷**续传也必须对新旧计划逐条 diff。
///
/// 按文件夹的那条路径早就有 `resized` / `retimed` 告警,整卷路径没有:暂停期间
/// 文件被改大小、或同大小改了 mtime,新计划会直接持久化,把用户批准过的
/// size/mtime 基线**无声抹掉**——事后再也查不出「拷的到底是哪一版」。
///
/// 判别性:去掉整卷分支里的 `notice_resume_baseline_diff` 调用,本测试必红。
#[test]
fn whole_volume_resume_reports_baseline_changes_before_overwriting_them() {
    use crate::core::manifest::{CopyManifest, PlannedFile};
    let (window, tmp, _nas) = mock_app();
    let app = window.app_handle();
    let card = tmp.path().join("card-baseline");
    std::fs::create_dir_all(card.join("D")).unwrap();
    std::fs::write(card.join("D/grown.jpg"), vec![1u8; 50]).unwrap();
    std::fs::write(card.join("D/swapped.jpg"), vec![2u8; 20]).unwrap();
    let project_root = tmp.path().join("proj-baseline");
    std::fs::create_dir_all(&project_root).unwrap();

    let swapped_meta = std::fs::metadata(card.join("D/swapped.jpg")).unwrap();
    let mut m = CopyManifest::new("t", "card", "A7M4_A_ZS", "ZS", "");
    m.planned = vec![
        // 锁定时是 10 字节,现在盘上是 50 → resized
        PlannedFile {
            rel_path: "D/grown.jpg".into(),
            size: 10,
            source_rel: String::new(),
            source_mtime_ns: 0,
        },
        // 大小一样,但 mtime 与盘上不同 → retimed(同大小内容被替换)
        PlannedFile {
            rel_path: "D/swapped.jpg".into(),
            size: 20,
            source_rel: String::new(),
            source_mtime_ns: crate::core::media::mtime_nanos(&swapped_meta) + 1_000_000_000,
        },
    ];
    crate::commands::refresh_resume_plan(app, &mut m, &project_root, &card).unwrap();

    let notices = invoke(&window, "list_notices", json!({})).unwrap();
    let find = |code: &str| -> String {
        notices
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["code"] == code)
            .map(|n| n["message"].as_str().unwrap_or_default().to_string())
            .unwrap_or_else(|| panic!("整卷续传必须发 {code}: {notices}"))
    };
    let resized = find("copy-resume-size-changed");
    assert!(
        resized.contains("D/grown.jpg") && resized.contains("基线"),
        "改大小的要点名,并说清基线会被覆盖: {resized}"
    );
    let retimed = find("copy-resume-content-replaced");
    assert!(
        retimed.contains("D/swapped.jpg"),
        "同大小改 mtime 的要点名: {retimed}"
    );
}

/// R13 C5(P1):快照淘汰必须按**确认页实例**替换,不是按全局完成顺序。
///
/// 五个确认页并发规划时,较旧的那次大扫描晚完成,会把当前正开着的那份计划挤掉
/// ——用户还看着确认屏,后端已经不记得他批准的是什么了。
///
/// 判别性:把 `remember` 里按 `instance_id` 替换那一段去掉,并把槽位改回 4,
/// 本测试必红。
#[test]
fn approved_plans_are_evicted_per_confirm_page_not_globally() {
    let (window, tmp, _nas) = mock_app();
    let card = tmp.path().join("card-slots");
    std::fs::create_dir_all(card.join("D")).unwrap();
    std::fs::write(card.join("D/a.jpg"), vec![1u8; 10]).unwrap();
    let _mounted = crate::commands::TestVolumeGuard::mount(&card);
    let vid = card.display().to_string();
    let app = window.app_handle();
    let state: tauri::State<crate::commands::AppState> = app.state();

    // 甲确认页:拉一份计划并记住它的令牌
    let first = invoke(
        &window,
        "plan_source_selection",
        json!({"volumeId": vid, "folders": ["D"], "confirmInstanceId": "page-甲"}),
    )
    .unwrap();
    let approved = first["planDigest"].as_str().unwrap().to_string();

    // 乙确认页在同一张卡上来回改勾选,连拉 20 次计划(每次令牌都不同:
    // 勾选段不同)。这些全部属于**同一个确认页实例**,只该占一个槽。
    for i in 0..20 {
        std::fs::write(card.join(format!("D/n{i}.jpg")), vec![9u8; 10]).unwrap();
        invoke(
            &window,
            "plan_source_selection",
            json!({"volumeId": vid, "folders": ["D"], "confirmInstanceId": "page-乙"}),
        )
        .unwrap();
    }

    // 甲那份必须还在——快照在,才说得出「到底哪儿变了」
    assert!(
        matches!(
            state.approved_plans.recall(&approved),
            crate::commands::RecalledPlan::Found(_)
        ),
        "别的确认页反复规划,不该把当前这份挤掉"
    );
}

/// R13 D1(P1):`inspect_volume` 也必须过源卷解析闸。
///
/// 另外三个入口(`list_source_folders` / `plan_source_selection` /
/// `start_copy_task`)都过了 `ensure_source_volume`,只有它没过:任意可读目录
/// 都能当源,递归扫描卡外的目录树并返回文件数、容量、时间范围。
///
/// 判别性:把 `ensure_source_volume` 换回 `PathBuf::from`,本测试必红。
#[test]
fn inspect_volume_refuses_paths_that_are_not_mounted_volumes() {
    let (window, tmp, _nas) = mock_app();
    let outsider = tmp.path().join("不是卡的普通目录");
    std::fs::create_dir_all(outsider.join("私人")).unwrap();
    std::fs::write(outsider.join("私人/机密.jpg"), vec![1u8; 10]).unwrap();

    let e = invoke(
        &window,
        "inspect_volume",
        json!({"volumeId": outsider.display().to_string()}),
    )
    .unwrap_err();
    assert!(
        e.as_str()
            .unwrap_or_default()
            .contains("不是当前挂载的存储卷"),
        "任意目录不许当拷卡源被扫描: {e}"
    );

    // 真卡照旧可用
    let card = tmp.path().join("card-inspect");
    std::fs::create_dir_all(card.join("D")).unwrap();
    std::fs::write(card.join("D/a.jpg"), vec![1u8; 10]).unwrap();
    let _mounted = crate::commands::TestVolumeGuard::mount(&card);
    let out = invoke(
        &window,
        "inspect_volume",
        json!({"volumeId": card.display().to_string()}),
    )
    .expect("真卡必须照旧能看");
    assert_eq!(out["fileCount"], 1);
}

/// R13 D2(P1):分类计数不许**跟随符号链接**。
///
/// 判据从「点开头一律跳过」放宽之后,`.assets` 这类链接不再被形状挡住;
/// `Path::is_dir()` 会解析链接,于是计数可能无限递归、把项目外的文件也算进角标,
/// 而正式扫描(`copy::scan_source`)从来不跟随链接——两个数字都出自 OCard,
/// 却对不上。链接一律跳过并**可见告警**(与其它扫描同口径)。
///
/// 判别性:把 `count_files` 里的 `file_type()` 换回 `Path::is_dir()`,本测试必红
/// (角标会把链接目录里的文件算进来,告警也不会发)。
#[test]
fn category_count_does_not_follow_symlinks_and_reports_them() {
    let (window, tmp, nas) = mock_app();
    let pid = create_b_project(&window);
    let root = nas.join(&pid);
    let cat = root.join("2. 开幕式");
    std::fs::write(cat.join("real.jpg"), b"x").unwrap();

    // 项目**外**的一棵树,用一个点开头的链接名挂进分类夹
    let outside = tmp.path().join("项目外");
    std::fs::create_dir_all(&outside).unwrap();
    for i in 0..5 {
        std::fs::write(outside.join(format!("外部{i}.jpg")), b"x").unwrap();
    }
    std::os::unix::fs::symlink(&outside, cat.join(".assets")).unwrap();

    let cats = invoke(&window, "list_categories", json!({"projectId": pid})).unwrap();
    let count = cats
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["folderName"] == "2. 开幕式")
        .map(|c| c["count"].as_u64().unwrap())
        .expect("分类必须在列表里");
    assert_eq!(count, 1, "链接指向的项目外文件不许被算进角标: {cats}");

    let notices = invoke(&window, "list_notices", json!({})).unwrap();
    assert!(
        notices
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["code"] == "copy-symlinks-skipped"),
        "跳过的链接必须可见,不许静默: {notices}"
    );
}

/// R1(必修):请求层去重**只按字节完全相同**。
///
/// 此前拿目的地的大小写口径(`fold_key`)给**源侧**选择去重:源卷大小写敏感时
/// (大小写敏感 APFS / Linux ext4 导出 / 部分 SMB·NFS / 磁盘映像)`DCIM` 与
/// `dcim` 是两个真实存在的不同目录,`list_source_folders` 会两条都列出来让用户勾,
/// 勾了之后第二个被**无声丢弃**——漏拷一整个文件夹,任务却报 all_verified。
/// (把去重改回大小写不敏感,本测试必红。)
#[test]
fn selection_keeps_case_distinct_folders_and_dedupes_only_exact_bytes() {
    let parsed = crate::commands::parse_selection(&[
        "DCIM/100MSDCF".to_string(),
        "dcim/100msdcf".to_string(),
        // 字节完全相同的重复项才去重(重复本身无害:scan_selection 的
        // sort+dedup 会按真实 rel 收敛)
        "DCIM/100MSDCF".to_string(),
    ])
    .unwrap();
    match &parsed.selection {
        crate::core::copy::SourceSelection::Folders(f) => {
            assert_eq!(
                f,
                &vec!["DCIM/100MSDCF".to_string(), "dcim/100msdcf".to_string()],
                "只差大小写的两项是源卷上两个真实目录,一个都不许丢"
            );
        }
        other => panic!("应为 Folders: {other:?}"),
    }
    // 不合并,但要点名告警(源卷若其实大小写不敏感,用户有权知道这两项会各扫一遍)
    assert_eq!(parsed.aliases.len(), 1, "{:?}", parsed.aliases);
    assert!(parsed.aliases[0].contains("DCIM/100MSDCF"));
}

/// 契约字段名是前后端唯一的约定面:`sourceFolders` 拼错一个字母就会被
/// `#[serde(default)]` 悄悄吞成整卷——用户勾了三个夹子,后端拷了整张卡。
#[test]
fn start_copy_input_accepts_contract_field_names() {
    use crate::commands::dto::StartCopyInput;
    let input: StartCopyInput = serde_json::from_value(json!({
        "projectId": "p", "volumeId": "/Volumes/CARD", "cameraId": "c",
        "targetPrefix": "20260828", "destinations": [{"kind": "nas", "path": "/nas"}],
        "sourceFolders": ["DCIM/100MSDCF", ""]
    }))
    .expect("契约字段名必须能反序列化");
    assert_eq!(input.source_folders, vec!["DCIM/100MSDCF", ""]);
    // 不传 = 整卷(老客户端一个字都不用改)
    let legacy: StartCopyInput = serde_json::from_value(json!({
        "projectId": "p", "volumeId": "/Volumes/CARD", "cameraId": "c",
        "targetPrefix": "20260828", "destinations": [{"kind": "nas", "path": "/nas"}]
    }))
    .unwrap();
    assert!(legacy.source_folders.is_empty());
}

/// 续传闸:`source_selection` 被清空、planned 却带着扁平落点时,
/// 按整卷解读会把整张卡按原目录结构灌进那个扁平化的目标夹。必须 fail-closed。
/// (删掉 resume_copy_task 里的口径自洽检查,本测试必红。)
#[test]
fn resume_rejects_manifest_with_contradictory_scope() {
    use std::sync::atomic::AtomicBool;
    let (window, tmp, nas) = mock_app();
    let pid = create_b_project(&window);
    let project_root = nas.join(&pid);

    let mut m = crate::core::manifest::CopyManifest::new(
        "1. 待分类/0824上午_A7M4_A_ZS",
        "SDXC_01",
        "A7M4_A_ZS",
        "ZS",
        "",
    );
    // 扁平落点(源≠目标)却没有源选择记录 = 口径自相矛盾
    m.planned.push(crate::core::manifest::PlannedFile {
        rel_path: "IMG_0001.JPG".into(),
        size: 64,
        source_rel: "DCIM/100MSDCF/IMG_0001.JPG".into(),
        source_mtime_ns: 0,
    });
    crate::core::manifest::save(&project_root, &m).unwrap();

    let dest = project_root.join("1. 待分类/0824上午_A7M4_A_ZS");
    let state = window.state::<AppState>();
    state.tasks.insert(
        "t-contradictory".into(),
        std::sync::Arc::new(crate::commands::tasks::TaskHandle {
            pause_requested: AtomicBool::new(false),
            running: AtomicBool::new(false),
            snapshot: std::sync::Mutex::new(crate::commands::dto::CopyTaskDto {
                id: "t-contradictory".into(),
                project_id: pid.clone(),
                volume_id: tmp.path().join("card").display().to_string(),
                volume_name: "SDXC_01".into(),
                camera_id: "cam-1".into(),
                camera_code: "A7M4_A_ZS".into(),
                note: String::new(),
                tags: Vec::new(),
                target_folder: "0824上午_A7M4_A_ZS".into(),
                source_folders: Vec::new(),
                scan_policy_version: crate::core::manifest::SCAN_POLICY_VERSION,
                destinations: Vec::new(),
                files: Vec::new(),
                file_count: None,
                status_counts: None,
                total_bytes: 0,
                copied_bytes: 0,
                speed_bytes_per_sec: 0,
                state: "paused",
                progress_revision: None,
                operator: "ZS".into(),
                started_at: String::new(),
                finished_at: None,
            }),
            project_root: project_root.clone(),
            manifest_id: m.id.clone(),
            source_root: std::sync::Mutex::new(tmp.path().join("card")),
            plan: std::sync::Mutex::new(Vec::new()),
            dest_targets: vec![dest],
            machine_id: "TEST-MACHINE".into(),
            config_dir: tmp.path().join("config"),
            lease: Default::default(),
        }),
    );

    let e = invoke(
        &window,
        "resume_copy_task",
        json!({"taskId": "t-contradictory"}),
    )
    .expect_err("口径矛盾的清单必须拒绝续传");
    assert!(
        e.as_str().unwrap_or_default().contains("口径自相矛盾"),
        "报文要点名口径问题: {e}"
    );
}

// ============ 双路评审收敛出的必修项:命令层回归网 ============

/// 端到端拷卡:一次钉住 R2(DTO 报的是引擎口径的 selection)、
/// R5(计划绑定令牌)、R7/R11(系统项被排除且可见、点开头的素材照拷)三条接线。
#[test]
fn start_copy_binds_the_approved_plan_and_reports_engine_selection() {
    let (window, tmp, nas) = mock_app();
    let pid = create_b_project(&window);
    let project_root = nas.join(&pid);
    let cam = invoke(
        &window,
        "create_camera",
        json!({"input": {"model": "A7M4", "position": "A", "operatorAlias": "ZS"}}),
    )
    .expect("登记相机应成功");
    let cam_id = cam["id"].as_str().unwrap().to_string();

    let card = tmp.path().join("card-e2e");
    std::fs::create_dir_all(card.join("D")).unwrap();
    std::fs::write(card.join("D/a.jpg"), vec![1u8; 10]).unwrap();
    std::fs::write(card.join("D/b.jpg"), vec![2u8; 20]).unwrap();
    // R11:合法但点开头的素材**必须**进计划(漏拷却报成功是最不能接受的失败形态)
    std::fs::write(card.join("D/.clip.mov"), vec![3u8; 30]).unwrap();
    // R7/R11:明确列举的系统项仍然排除,且必须被数出来告诉用户
    std::fs::write(card.join("D/.DS_Store"), vec![4u8; 40]).unwrap();
    let _mounted = crate::commands::TestVolumeGuard::mount(&card);
    let vid = card.display().to_string();

    let plan = invoke(
        &window,
        "plan_source_selection",
        json!({"volumeId": vid, "folders": ["D"]}),
    )
    .expect("规划应成功");
    assert_eq!(plan["fileCount"], 3, "点开头的素材必须在计划里: {plan}");
    assert_eq!(plan["hiddenSkipped"], 1, "系统项必须报出来: {plan}");
    assert_eq!(plan["hiddenSamples"][0], "D/.DS_Store");
    let digest = plan["planDigest"].as_str().unwrap().to_string();
    assert!(!digest.is_empty(), "计划必须带绑定令牌: {plan}");

    let dest = tmp.path().join("backup");
    let input = |extra: Value| -> Value {
        let mut base = json!({
            "projectId": pid, "volumeId": vid, "cameraId": cam_id,
            "note": "", "tags": ["开幕式"], "targetPrefix": "0824上午",
            "destinations": [{"kind": "local", "path": dest.display().to_string()}],
            // 故意传一份**未规范化**的输入:字节重复项
            "sourceFolders": ["D", "D"],
        });
        for (k, v) in extra.as_object().unwrap() {
            base[k] = v.clone();
        }
        json!({ "input": base })
    };

    // R5-①:按文件夹拷却没带令牌 → 拒绝。**绝不许 fail-open 成整卷**
    let e = invoke(&window, "start_copy_task", input(json!({}))).unwrap_err();
    assert!(
        e.as_str().unwrap_or_default().contains("planDigest"),
        "缺令牌必须点名说清楚: {e}"
    );

    // R5-②:双确认之后卡上内容变了 → PLAN_CHANGED,且**任何副作用之前**就拒
    std::fs::write(card.join("D/c.jpg"), vec![4u8; 40]).unwrap();
    let e = invoke(
        &window,
        "start_copy_task",
        input(json!({"planDigest": digest})),
    )
    .unwrap_err();
    let msg = e.as_str().unwrap_or_default().to_string();
    assert!(msg.starts_with("PLAN_CHANGED:"), "{msg}");
    assert!(msg.contains("重新核对"), "要告诉用户去重新核对: {msg}");
    // R11:原因必须说对且点得出名字——说错原因会把人引向错误的排查方向
    assert!(
        msg.contains("新增 1 个") && msg.contains("D/c.jpg"),
        "增删必须说清是什么、多少个: {msg}"
    );
    assert_eq!(
        crate::core::manifest::list(&project_root)
            .unwrap()
            .manifests
            .len(),
        0,
        "被拒的任务不许留下清单"
    );
    // R13 C2:指纹是**规划**那一步写的(介质绑定必须发生在返回计划之前),
    // 不是这次被拒的 start 写的。被拒的 start 不许留下任何**新**副作用。
    assert!(
        card.join(crate::core::volumes::VOLUME_UID_FILE).exists(),
        "规划阶段就该把计划绑到这块介质上"
    );
    assert!(!dest.exists(), "被拒的任务不许创建目的地");

    // R5-③:重新拉计划拿到新令牌 → 放行
    let plan2 = invoke(
        &window,
        "plan_source_selection",
        json!({"volumeId": vid, "folders": ["D"]}),
    )
    .unwrap();
    let task = invoke(
        &window,
        "start_copy_task",
        input(json!({"planDigest": plan2["planDigest"].clone()})),
    )
    .expect("新令牌必须能开跑");

    // R2:DTO 报的是**引擎真正采用的** selection(去重后的 ["D"]),不是原始输入
    assert_eq!(
        task["sourceFolders"],
        json!(["D"]),
        "sourceFolders 必须与 manifest / 引擎同源: {task}"
    );
    let m = &crate::core::manifest::list(&project_root)
        .unwrap()
        .manifests[0];
    assert_eq!(m.source_selection, vec!["D".to_string()], "三边同源");
    assert_eq!(m.hidden_skipped, 1, "排除的条目要落进清单供事后核对");
    // R11:点开头的素材必须真的在锁定清单里(不是只统计了事)
    assert!(
        m.planned.iter().any(|p| p.source() == "D/.clip.mov"),
        "点开头的素材必须进锁定清单: {:?}",
        m.planned
    );

    // R7/R11:开拷前必须发过可见告警
    let notices = invoke(&window, "list_notices", json!({})).unwrap();
    assert!(
        notices
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["code"] == "copy-hidden-skipped"),
        "系统项被排除必须可见: {notices}"
    );
}

/// R11:令牌对不上时,**三类原因必须各说各的**——说错原因比不说更糟,
/// 会把人引向错误的排查方向(去数文件 vs 去查是谁动了卡)。
/// (把 `plan_changed_message` 换回一句笼统的「计划变了」,本测试必红。)
#[test]
fn plan_changed_message_names_the_actual_cause() {
    let (window, tmp, _nas) = mock_app();
    let card = tmp.path().join("card-why");
    std::fs::create_dir_all(card.join("D")).unwrap();
    std::fs::write(card.join("D/a.jpg"), vec![1u8; 10]).unwrap();
    std::fs::write(card.join("D/b.jpg"), vec![2u8; 20]).unwrap();
    let _mounted = crate::commands::TestVolumeGuard::mount(&card);
    let vid = card.display().to_string();
    let ask = |state: &crate::commands::AppState, approved: &str| -> String {
        let (plan, _, _) = crate::core::copy::scan_selection(
            &card,
            &crate::core::copy::SourceSelection::from_folders(vec!["D".into()]),
        )
        .unwrap();
        let _ = crate::core::copy::take_scan_system_skipped();
        let identity = crate::commands::volume_identity(&card);
        let fresh = crate::core::copy::plan_digest(
            &crate::core::copy::SourceSelection::from_folders(vec!["D".into()]),
            &plan,
            &identity,
        );
        crate::commands::plan_changed_message(
            state,
            approved,
            &fresh,
            &plan,
            &identity,
            &crate::core::copy::normalized_selection(
                &crate::core::copy::SourceSelection::from_folders(vec!["D".into()]),
            ),
        )
    };

    let plan = invoke(
        &window,
        "plan_source_selection",
        json!({"volumeId": vid, "folders": ["D"]}),
    )
    .expect("规划应成功");
    let approved = plan["planDigest"].as_str().unwrap().to_string();
    let app = window.app_handle();
    let state: tauri::State<crate::commands::AppState> = app.state();

    // ① 同大小、内容被替换(只有 mtime 会动):不能报成「文件被增删」
    std::fs::write(card.join("D/a.jpg"), vec![9u8; 10]).unwrap();
    let f = std::fs::OpenOptions::new()
        .write(true)
        .open(card.join("D/a.jpg"))
        .unwrap();
    f.set_times(
        std::fs::FileTimes::new()
            .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(60)),
    )
    .unwrap();
    drop(f);
    let msg = ask(&state, &approved);
    assert!(
        msg.contains("被改动过") && msg.contains("大小没变") && msg.contains("D/a.jpg"),
        "同大小内容被换掉要说对原因并点名: {msg}"
    );
    assert!(!msg.contains("新增"), "别把「被改动」说成「增删」: {msg}");

    // ② 文件集变了:说清增删了什么、多少个
    std::fs::remove_file(card.join("D/b.jpg")).unwrap();
    std::fs::write(card.join("D/c.jpg"), vec![3u8; 30]).unwrap();
    let msg = ask(&state, &approved);
    assert!(
        msg.contains("新增 1 个") && msg.contains("D/c.jpg"),
        "新增要点名: {msg}"
    );
    assert!(
        msg.contains("少了 1 个") && msg.contains("D/b.jpg"),
        "删除要点名: {msg}"
    );

    // ③ 令牌根本认不出来(旧版本客户端 / 被改写):fail-closed 且说得对
    let msg = ask(&state, "deadbeefdeadbeef");
    assert!(
        msg.contains("无法识别") && msg.starts_with("PLAN_CHANGED:"),
        "认不出的令牌要说认不出,别乱扣「卡被人动过」: {msg}"
    );

    // ④ 记不住确认时那份计划(应用重启/被挤掉)时,必须**明说**说不出是哪几个,
    //    不许含糊其辞假装说得出
    let msg = ask(
        &state,
        &crate::core::copy::plan_digest(
            &crate::core::copy::SourceSelection::from_folders(vec!["D".into()]),
            &[],
            &crate::commands::volume_identity(&card),
        ),
    );
    assert!(
        msg.contains("已不在内存中"),
        "拿不到明细就明说拿不到: {msg}"
    );

    // ⑤ 卷身份变了:指纹从有到无(卡被换成了另一张、或指纹被删)必须点名指纹,
    //    而不是含糊说「计划变了」。
    let plan2 = invoke(
        &window,
        "plan_source_selection",
        json!({"volumeId": vid, "folders": ["D"]}),
    )
    .expect("规划应成功");
    let approved2 = plan2["planDigest"].as_str().unwrap().to_string();
    std::fs::remove_file(card.join(crate::core::volumes::VOLUME_UID_FILE)).unwrap();
    let msg = ask(&state, &approved2);
    assert!(
        msg.contains("读不到源卷上的身份指纹"),
        "指纹从有到无要点名指纹: {msg}"
    );
}

/// R13 C1(P0):**勾选范围对不上**必须独立成一类原因,报文里一个字都不能提
/// 「卡上的文件变了」。
///
/// 场景:卡完全没有变,只是前端提交选择 B 时误带了选择 A 的令牌。共用摘要段时
/// 逐条 diff 会显示「A 的文件被删、B 的文件新增」,报文于是断言「卡上的文件在你
/// 确认之后变了」——把前端状态错配说成有人动了卡。说错原因比不说更糟:用户会
/// 跑去数卡上的文件、怀疑同事动过这张卡。
///
/// 判别性:把摘要的选择段并回文件集段(或把 `Selection` 分支删掉),本测试必红。
#[test]
fn mismatched_selection_token_never_blames_the_card() {
    let (window, tmp, _nas) = mock_app();
    let card = tmp.path().join("card-sel");
    std::fs::create_dir_all(card.join("A")).unwrap();
    std::fs::create_dir_all(card.join("B")).unwrap();
    std::fs::write(card.join("A/a.jpg"), vec![1u8; 10]).unwrap();
    std::fs::write(card.join("B/b.jpg"), vec![2u8; 20]).unwrap();
    let _mounted = crate::commands::TestVolumeGuard::mount(&card);
    let vid = card.display().to_string();

    // 确认屏 A:勾了 A
    let plan_a = invoke(
        &window,
        "plan_source_selection",
        json!({"volumeId": vid, "folders": ["A"]}),
    )
    .unwrap();
    let token_a = plan_a["planDigest"].as_str().unwrap().to_string();

    // 提交的却是选择 B(卡上一个字节都没动)
    let app = window.app_handle();
    let state: tauri::State<crate::commands::AppState> = app.state();
    let sel_b = crate::core::copy::SourceSelection::from_folders(vec!["B".into()]);
    let (plan_b, _, _) = crate::core::copy::scan_selection(&card, &sel_b).unwrap();
    let _ = crate::core::copy::take_scan_system_skipped();
    let identity = crate::commands::volume_identity(&card);
    let fresh = crate::core::copy::plan_digest(&sel_b, &plan_b, &identity);
    let msg = crate::commands::plan_changed_message(
        &state,
        &token_a,
        &fresh,
        &plan_b,
        &identity,
        &crate::core::copy::normalized_selection(&sel_b),
    );

    assert!(
        msg.contains("勾选范围") && msg.contains("与卡上的内容无关"),
        "必须说成勾选范围对不上: {msg}"
    );
    assert!(
        !msg.contains("卡上的文件在你确认之后变了"),
        "卡一个字节都没动,不许说卡上的文件变了: {msg}"
    );
    assert!(
        !msg.contains("新增") && !msg.contains("少了"),
        "不许把选择差异说成文件增删: {msg}"
    );
    // 差在哪也要说得出来
    assert!(
        msg.contains('A') && msg.contains('B'),
        "要点名两边勾的到底差在哪: {msg}"
    );
}

/// R13 C2(P0):**规划返回之前**就必须把计划绑到一块物理介质上。
///
/// 此前 UID 要到 `start_copy_task` 的摘要比对**之后**才创建,于是确认时的卡 A
/// 根本没有 UID。随后换上同卷名、同挂载点、文件元数据也一模一样的另一张未标记的
/// 卡 B —— 三段摘要一字不差,**B 会按 A 的批准直接开跑**。
///
/// 判别性:把 `plan_source_selection` 里的 `bind_medium_identity` 去掉,
/// 第一组断言(规划后卡上必须有指纹)必红;第二组(换成未标记的卡必须被拦下)
/// 也必红——两张卡的摘要会完全相同。
#[test]
fn planning_binds_the_plan_to_a_physical_medium_before_returning() {
    let (window, tmp, _nas) = mock_app();
    let make_card = |p: &std::path::Path| {
        std::fs::create_dir_all(p.join("D")).unwrap();
        std::fs::write(p.join("D/a.jpg"), vec![1u8; 10]).unwrap();
    };
    let card_a = tmp.path().join("card-A");
    make_card(&card_a);
    let _mounted = crate::commands::TestVolumeGuard::mount(&card_a);
    assert!(
        crate::core::volumes::read_volume_uid(&card_a).is_none(),
        "前置断言:卡上原本没有指纹"
    );

    let plan = invoke(
        &window,
        "plan_source_selection",
        json!({"volumeId": card_a.display().to_string(), "folders": ["D"]}),
    )
    .expect("规划应成功");
    let approved = plan["planDigest"].as_str().unwrap().to_string();
    let uid_a = crate::core::volumes::read_volume_uid(&card_a)
        .expect("规划返回时卡上必须已经有身份指纹——否则这份计划没绑定任何介质");

    // 换成一张**内容与元数据完全相同、但没有指纹**的另一张卡:必须被拦下。
    // 用同一个挂载点重建目录,连 mtime 都对齐,只有指纹不同。
    let meta = std::fs::metadata(card_a.join("D/a.jpg")).unwrap();
    std::fs::remove_dir_all(&card_a).unwrap();
    make_card(&card_a);
    let f = std::fs::OpenOptions::new()
        .write(true)
        .open(card_a.join("D/a.jpg"))
        .unwrap();
    f.set_times(std::fs::FileTimes::new().set_modified(meta.modified().unwrap()))
        .unwrap();
    drop(f);
    assert!(
        crate::core::volumes::read_volume_uid(&card_a).is_none(),
        "前置断言:换上来的这张卡没有指纹"
    );

    let app = window.app_handle();
    let state: tauri::State<crate::commands::AppState> = app.state();
    let sel = crate::core::copy::SourceSelection::from_folders(vec!["D".into()]);
    let (fresh_plan, _, _) = crate::core::copy::scan_selection(&card_a, &sel).unwrap();
    let _ = crate::core::copy::take_scan_system_skipped();
    let identity = crate::commands::volume_identity(&card_a);
    let fresh = crate::core::copy::plan_digest(&sel, &fresh_plan, &identity);
    assert_ne!(
        approved, fresh,
        "同名同挂载点同元数据的另一张未标记卡,摘要必须不同(指纹 {uid_a} 是唯一的区分)"
    );
    let msg = crate::commands::plan_changed_message(
        &state,
        &approved,
        &fresh,
        &fresh_plan,
        &identity,
        &crate::core::copy::normalized_selection(&sel),
    );
    assert!(
        msg.contains("身份指纹"),
        "换成未标记的卡必须点名指纹这一段: {msg}"
    );
}

/// R13 C2(P0):介质绑定**失败**时,诊断措辞不许自称完成了绑定。
///
/// 规划时会尝试给卡创建指纹;失败(写保护 / 卷不在挂载列表)时快照里的指纹段
/// 是空的。这时候卡上冒出一个指纹,既可能是 OCard 后来写的,也可能是换上了
/// 另一张已带指纹的卡——**没有证据可以区分**。旧措辞直接断言「源卷本身没换」,
/// 是一句无凭无据的话。
///
/// 判别性:把 `why_volume_differs` 的那一支改回断言式措辞,本测试必红。
#[test]
fn unbound_medium_yields_uncertain_diagnosis_not_a_claim() {
    let snap = crate::commands::ApprovedSnapshot {
        digest: "d".into(),
        // 挂载点与卷名都没变,只有指纹从「空」变成「有」
        volume_identity: "/Volumes/CARD\u{0}CARD\u{0}".into(),
        selection: Vec::new(),
        files: Some(Vec::new()),
        instance_id: None,
        remembered_at: std::time::Instant::now(),
    };
    let msg = crate::commands::why_volume_differs(
        &crate::commands::RecalledPlan::Found(snap),
        "/Volumes/CARD\u{0}CARD\u{0}some-uid",
    );
    assert!(
        msg.contains("无法区分") || msg.contains("可能"),
        "没有证据就不许下结论: {msg}"
    );
    assert!(
        !msg.contains("源卷本身没换"),
        "当时根本没完成介质绑定,不许断言源卷没换: {msg}"
    );
}

/// R13 C5:确认时那份快照被淘汰(应用重启 / 被挤掉 / 过期)时,**所有分支**
/// 都只能给泛化原因并披露「快照没了」,不许扣「不是同一张卡」这种具体帽子。
///
/// 判别性:把 `why_volume_differs` 的 `None` 分支改回旧的断言式措辞,本测试必红。
#[test]
fn forgotten_snapshot_never_accuses_a_card_swap() {
    let msg = crate::commands::why_volume_differs(
        &crate::commands::RecalledPlan::Forgotten,
        "/Volumes/CARD\u{0}CARD\u{0}uid",
    );
    assert!(msg.contains("已不在内存中"), "必须披露快照已被淘汰: {msg}");
    assert!(
        msg.contains("无法判定"),
        "拿不到快照就说不出是哪一段变了: {msg}"
    );
    assert!(
        !msg.contains("不是你确认时的那一张卡"),
        "没有证据不许断言换了卡: {msg}"
    );
}

/// R2 单元级:`build_task` 必须照传进来的 selection 填 DTO,不许回头读
/// `input.source_folders`。这个字段是「拷完能不能说本卡可格式化」的唯一判据。
/// (把 `source_folders: source_folders.to_vec()` 改回 `input.source_folders.clone()`,
///  本测试必红。)
#[test]
fn build_task_reports_the_engine_selection_not_the_raw_input() {
    let tmp = tempfile::tempdir().unwrap();
    let input: crate::commands::dto::StartCopyInput = serde_json::from_value(json!({
        "projectId": "p", "volumeId": "/Volumes/CARD", "cameraId": "c",
        "targetPrefix": "0824上午",
        "destinations": [{"kind": "local", "path": tmp.path().display().to_string()}],
        // 原始输入:重复项(引擎会去重成一条)
        "sourceFolders": ["DCIM/100MSDCF", "DCIM/100MSDCF"],
    }))
    .unwrap();
    let engine_selection = vec!["DCIM/100MSDCF".to_string()];
    let (dto, _) = crate::commands::tasks::build_task(
        &input,
        tmp.path(),
        crate::core::project::Scenario::B,
        "CARD",
        "A7M4_A_ZS",
        "ZS",
        &[],
        "mid",
        &engine_selection,
    )
    .unwrap();
    assert_eq!(dto.source_folders, engine_selection);
    assert_ne!(
        dto.source_folders, input.source_folders,
        "前置断言:两者必须真的不同,否则这条测不出东西"
    );
}

/// R6:目标夹读不动 ≠ 空。`NotFound` 才能解释成「还没创建」,
/// 其余(NAS 断了 / 无权限)必须在开拷前返回 Err——否则撞名预警整段消失,
/// 而扁平化模式下这条预警恰恰是最该有的。
#[cfg(unix)]
#[test]
fn unreadable_target_dir_is_an_error_not_an_empty_dir() {
    use std::os::unix::fs::PermissionsExt;
    let (window, tmp, _nas) = mock_app();
    let app = window.app_handle();
    let plan = vec![crate::core::copy::PlannedFile {
        source_rel: "A/DSC1.JPG".into(),
        target_rel: "DSC1.JPG".into(),
        size: 1,
        source_mtime_ns: 0,
    }];

    let locked = tmp.path().join("dest-locked");
    std::fs::create_dir_all(&locked).unwrap();
    std::fs::write(locked.join("DSC1.JPG"), b"x").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let clash_err =
        crate::commands::notice_target_name_clashes(app, &plan, std::slice::from_ref(&locked));
    let exists_err = crate::commands::check_existing_target(std::slice::from_ref(&locked), false);
    // 先复原权限,别把不可删目录留给 TempDir
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(
        clash_err.unwrap_err().contains("无法读取目标夹"),
        "读不动的目标夹不许当成「没有可撞的东西」"
    );
    assert!(
        exists_err.unwrap_err().contains("无法读取目标夹"),
        "读不动的目标夹不许当成「空目录」而跳过人工确认闸"
    );

    // 不存在 = 还没创建,照旧放行
    let missing = tmp.path().join("还没建");
    assert!(crate::commands::notice_target_name_clashes(
        app,
        &plan,
        std::slice::from_ref(&missing)
    )
    .is_ok());
    assert!(crate::commands::check_existing_target(&[missing], false).is_ok());
}

/// R6:撞名判定必须是 `HashSet` 而非 Vec 线性查找。重复拷进同一目标夹时每个
/// 文件都撞名,5 万文件 = 十亿量级比较,而本函数在起 worker **之前同步跑**,
/// UI 会卡死几十秒。(改回 `clashes.contains(..)`,本测试会超时必红。)
#[test]
fn target_clash_scan_is_not_quadratic() {
    let (window, tmp, _nas) = mock_app();
    let app = window.app_handle();
    const N: usize = 30_000;
    let dest = tmp.path().join("dest-big");
    std::fs::create_dir_all(&dest).unwrap();
    let plan: Vec<crate::core::copy::PlannedFile> = (0..N)
        .map(|i| {
            let name = format!("DSC{i:05}.JPG");
            std::fs::write(dest.join(&name), b"x").unwrap();
            crate::core::copy::PlannedFile {
                source_rel: format!("A/{name}"),
                target_rel: name,
                size: 1,
                source_mtime_ns: 0,
            }
        })
        .collect();
    let t0 = std::time::Instant::now();
    crate::commands::notice_target_name_clashes(app, &plan, &[dest]).unwrap();
    let elapsed = t0.elapsed();
    assert!(
        elapsed < std::time::Duration::from_secs(10),
        "全部撞名的 {N} 个文件必须线性处理完,实际耗时 {elapsed:?}"
    );
}

/// R10:扫描期的跳过计数在**失败出口**也必须被取走。
/// 计数留着会算到下一次操作头上,报数失真(`notice_scan_skips` 的不变式)。
#[cfg(unix)]
#[test]
fn scan_skip_counters_are_drained_on_failure_paths() {
    use crate::core::copy;
    let (window, tmp, _nas) = mock_app();
    let app = window.app_handle();
    let card = tmp.path().join("card-drain");
    std::fs::create_dir_all(card.join("A")).unwrap();
    std::fs::write(card.join("A/real.jpg"), b"x").unwrap();
    std::os::unix::fs::symlink(card.join("A/real.jpg"), card.join("A/link.jpg")).unwrap();
    // R13 E2:**系统项**计数此前只在开头被清零,却从没被制造、也从没被断言——
    // 把系统项那一路的 drain 删掉,这个测试照样绿。两个计数器是两条独立的腿,
    // 必须各自制造、各自断言。
    std::fs::write(card.join("A/.DS_Store"), b"junk").unwrap();
    std::fs::create_dir_all(card.join("A/.Trashes")).unwrap();
    let project_root = tmp.path().join("proj-drain");
    std::fs::create_dir_all(&project_root).unwrap();
    let _ = copy::take_scan_symlinks_skipped();
    let _ = copy::take_scan_system_skipped();

    // 按文件夹续传:先扫到 A(数出 1 个链接),再撞上不存在的 GONE → 复扫失败
    let mut m = crate::core::manifest::CopyManifest::new("t", "card", "A7M4_A_ZS", "ZS", "");
    m.source_selection = vec!["A".into(), "GONE".into()];
    m.planned = vec![crate::core::manifest::PlannedFile {
        rel_path: "real.jpg".into(),
        size: 1,
        source_rel: "A/real.jpg".into(),
        source_mtime_ns: 0,
    }];
    crate::commands::refresh_resume_plan(app, &mut m, &project_root, &card).unwrap();
    assert_eq!(
        copy::take_scan_symlinks_skipped(),
        0,
        "复扫失败的出口也必须取走链接计数"
    );
    assert_eq!(
        copy::take_scan_system_skipped().0,
        0,
        "复扫失败的出口同样必须取走**系统项**计数(留着会算到下一次操作头上)"
    );

    // 整卷续传:根目录下有链接,子目录读不动 → scan_source 数完链接才失败
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(card.join("A"), std::fs::Permissions::from_mode(0o000)).unwrap();
    let mut whole = crate::core::manifest::CopyManifest::new("t", "card", "A7M4_A_ZS", "ZS", "");
    let r = crate::commands::refresh_resume_plan(app, &mut whole, &project_root, &card);
    std::fs::set_permissions(card.join("A"), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(r.is_err(), "读不动的子目录必须让整卷复扫失败");
    assert_eq!(
        copy::take_scan_symlinks_skipped(),
        0,
        "整卷复扫的失败出口同样必须取走计数"
    );
    assert_eq!(
        copy::take_scan_system_skipped().0,
        0,
        "整卷复扫的失败出口同样必须取走系统项计数"
    );

    // inbox 扫描也要取(此前从不取,会把计数算到下一次拷卡头上)
    let inbox = project_root.join(crate::core::project::PENDING_DIR_B);
    std::fs::create_dir_all(&inbox).unwrap();
    std::fs::write(inbox.join("x.jpg"), b"x").unwrap();
    std::os::unix::fs::symlink(inbox.join("x.jpg"), inbox.join("y.jpg")).unwrap();
    crate::commands::sorting_cmds::inbox_files_for_analysis(app, &project_root).unwrap();
    assert_eq!(
        copy::take_scan_symlinks_skipped(),
        0,
        "inbox 扫描必须取走计数并告警"
    );
    assert_eq!(
        copy::take_scan_system_skipped().0,
        0,
        "inbox 扫描的系统项计数同样必须被取走"
    );
    let notices = invoke(&window, "list_notices", json!({})).unwrap();
    let codes: Vec<&str> = notices
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["code"].as_str().unwrap_or_default())
        .collect();
    assert!(
        codes.contains(&"copy-symlinks-skipped"),
        "跳过链接必须有可见告警: {notices}"
    );
    // 零静默:被排除的系统项也必须真的报到用户面前,不只是被计数后丢掉
    assert!(
        codes.contains(&"copy-hidden-skipped"),
        "排除系统项必须有可见告警: {notices}"
    );
}

// ---------- R12:NAS 侧三条路径与拷卡共用同一份系统项名单 ----------

/// 成片校验(`check_final_cuts`)扫「6. 成片」。
///
/// R12 之前这里是「以点开头一律跳过」:一个点开头的成片**根本不出现在报告里**,
/// 用户就以为它合规,交付当天才发现名字不对。收口后它照样进报告——按 grammar
/// 判成不合规、**标黄可见**,而不是被悄悄拿掉。系统项则必须仍被排除。
///
/// 变异:把判据改回 `name.starts_with('.')` → `.20260824_...` 从 items 消失,本测试红。
#[test]
fn final_cut_check_reports_dot_prefixed_files_and_hides_system_items() {
    let (window, _tmp, nas) = mock_app();
    let pid = create_a_project(&window);
    let dir = nas.join(&pid).join("6. 成片");
    std::fs::write(dir.join("20260824_校运会_4K_交付_V1.mp4"), b"m").unwrap();
    // 点开头的成片:必须可见(它会被判成「日期段不是有效的 YYYYMMDD」)
    std::fs::write(dir.join(".20260824_校运会_4K_交付_V1.mp4"), b"m").unwrap();
    // R13 A1:只是**以 `.ocard` 开头**的用户文件不是系统项,必须照常进报告。
    // 旧口径把 `.ocard` 当前缀,于是它连同 `.ocardinal.mov` 这类合法素材一起
    // 被静默排除——「形状判据兜底 → 漏拷却报成功」的同型错误。
    std::fs::write(dir.join(".ocard-notes.txt"), b"user file").unwrap();
    // 系统项 / 本工具自己的落盘:一个都不许进报告
    std::fs::write(dir.join(".DS_Store"), b"junk").unwrap();
    std::fs::write(dir.join("._20260824_校运会_4K_交付_V1.mp4"), b"junk").unwrap();
    std::fs::write(dir.join(".ocard-volume-id"), b"junk").unwrap();
    std::fs::write(dir.join("Thumbs.db"), b"junk").unwrap();
    std::fs::write(dir.join("成片.mp4.tag.ocardpart"), b"half").unwrap();
    std::fs::create_dir_all(dir.join(".ocard/journal")).unwrap();
    std::fs::write(dir.join(".ocard/journal/j.jsonl"), b"{}").unwrap();

    let report = invoke(&window, "check_final_cuts", json!({"projectId": pid})).unwrap();
    let mut names: Vec<String> = report["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["fileName"].as_str().unwrap().to_string())
        .collect();
    names.sort();
    assert_eq!(
        names,
        vec![
            ".20260824_校运会_4K_交付_V1.mp4".to_string(),
            ".ocard-notes.txt".to_string(),
            "20260824_校运会_4K_交付_V1.mp4".to_string(),
        ],
        "点开头的成片(以及只是名字像本工具落盘的用户文件)必须进报告,系统项必须不进"
    );
    // 可见 = 带上人话理由,而不是静默消失
    let dotted = report["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["fileName"] == ".20260824_校运会_4K_交付_V1.mp4")
        .unwrap();
    assert_eq!(dotted["valid"], false);
    assert!(!dotted["issues"].as_array().unwrap().is_empty());
}

/// 「待修→已修」流转提示(`curated_flow_hints`)扫「精选/待修」「精选/已修」。
///
/// 点开头的原稿拷得进 NAS、在分类界面看得见、能被精选进「待修」——这里再按
/// 「点开头」把它筛掉,它就永远拿不到流转提示,用户以为修完的东西还压着一份原稿。
///
/// 同时守两条不许放进来的:
/// - 精选复制的落地临时名 `.<uuid>.curatepart` 是**半截文件**;
/// - 主名切分必须在下标 > 0 处——否则 `.alpha` 与 `.beta` 的主名都是空串,
///   会被判成同一件,提示用户删掉一份毫不相干的原稿。
///
/// 变异:把判据改回 `n.starts_with('.')` → `.raw.mov` 那条提示消失,本测试红。
#[test]
fn curated_flow_hints_see_dot_prefixed_assets_but_not_system_items() {
    let (window, _tmp, nas) = mock_app();
    let pid = create_b_project(&window);
    let curated = nas.join(&pid).join("3. 精选");
    let (todo, done) = (curated.join("待修"), curated.join("已修"));
    // 点开头的原稿修完了:必须给出流转提示
    std::fs::write(todo.join(".raw.mov"), b"a").unwrap();
    std::fs::write(done.join(".raw.mp4"), b"b").unwrap();
    // 普通原稿:原有行为不变
    std::fs::write(todo.join("a.jpg"), b"a").unwrap();
    std::fs::write(done.join("a.png"), b"b").unwrap();
    // 系统项两边都有,不许配成一条提示
    std::fs::write(todo.join(".DS_Store"), b"junk").unwrap();
    std::fs::write(done.join(".DS_Store"), b"junk").unwrap();
    // 半截文件(精选复制的临时名):不许出现
    std::fs::write(todo.join(".9f1c-0000.curatepart"), b"half").unwrap();
    std::fs::write(done.join(".9f1c-0001.curatepart"), b"half").unwrap();
    // 两个毫不相干的「点开头且只有这一个点」的文件:主名不许都塌成空串
    std::fs::write(todo.join(".alpha"), b"a").unwrap();
    std::fs::write(done.join(".beta"), b"b").unwrap();

    let hints = invoke(&window, "curated_flow_hints", json!({"projectId": pid})).unwrap();
    let mut ids: Vec<String> = hints
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["todoAssetId"].as_str().unwrap().to_string())
        .collect();
    ids.sort();
    assert_eq!(
        ids,
        vec![
            "3. 精选/待修/.raw.mov".to_string(),
            "3. 精选/待修/a.jpg".to_string(),
        ],
        "点开头的原稿必须拿到提示;系统项/半截文件/无关的点开头文件都不许配对"
    );
}

/// **`.ocard/` 及其内容绝不许出现在 NAS 侧任何一条素材路径上。**
/// 把项目自己的清单/日志/回收站当成素材,轻则计数说谎,重则顺着同一份口径被打进
/// 交付包发给客户。这条测试从**命令层**(前端真正调用的入口)正面钉住它。
#[test]
fn ocard_state_dir_never_leaks_into_any_nas_material_path() {
    let (window, _tmp, nas) = mock_app();
    let pid = create_b_project(&window);
    let root = nas.join(&pid);

    // 项目状态目录里放满诱饵:清单、日志、设置、回收站里已删除的素材
    std::fs::create_dir_all(root.join(".ocard/trash")).unwrap();
    std::fs::write(root.join(".ocard/settings.json"), b"{}").unwrap();
    std::fs::write(root.join(".ocard/manifests/m.json"), b"{}").unwrap();
    std::fs::write(root.join(".ocard/journal/j.jsonl"), b"{}").unwrap();
    std::fs::write(root.join(".ocard/trash/uuid_已删.jpg"), b"deleted").unwrap();
    // 再在素材夹**内部**种一份同名目录,正面考共享名单的 `.ocard` 前缀项
    for cat in ["1. 待分类", "2. 开幕式", "3. 精选/待修", "3. 精选/已修"] {
        std::fs::create_dir_all(root.join(cat).join(".ocard/trash")).unwrap();
        std::fs::write(root.join(cat).join(".ocard/trash/诱饵.jpg"), b"x").unwrap();
        std::fs::write(root.join(cat).join(".ocard-volume-id"), b"id").unwrap();
    }
    std::fs::write(root.join("1. 待分类/真素材.jpg"), b"real").unwrap();
    // 交付只取「已分类夹 + 精选/已修」(待分类不交付),真素材得放在这两处
    std::fs::write(root.join("2. 开幕式/待交付.jpg"), b"real").unwrap();

    // ① 分类计数:只数得到真素材
    let cats = invoke(&window, "list_categories", json!({"projectId": pid})).unwrap();
    let inbox = &cats.as_array().unwrap()[0];
    assert_eq!(inbox["count"], 1, "`.ocard` 里的东西绝不许算进分类计数");

    // ② 素材列表:`.ocard` 一条都不许出现
    let page = invoke(
        &window,
        "list_pending_assets",
        json!({"projectId": pid, "offset": 0, "limit": 200}),
    )
    .unwrap();
    let ids: Vec<String> = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids, vec!["1. 待分类/真素材.jpg".to_string()]);

    // ③ 流转提示:两边都有 `.ocard/trash/诱饵.jpg`,绝不许配成一条提示
    let hints = invoke(&window, "curated_flow_hints", json!({"projectId": pid})).unwrap();
    assert!(
        hints.as_array().unwrap().is_empty(),
        "`.ocard` 绝不许进流转提示: {hints}"
    );

    // ④ 交付打包:包里一个 `.ocard` 都不许有(把项目元数据发给客户是灾难)
    let snap = invoke(&window, "start_delivery", json!({"projectId": pid})).unwrap();
    let job_id = snap["id"].as_str().unwrap().to_string();
    let mut last = json!(null);
    for _ in 0..300 {
        last = invoke(&window, "get_job", json!({"jobId": job_id})).unwrap();
        if ["done", "failed", "cancelled"].contains(&last["state"].as_str().unwrap_or_default()) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(last["state"], "done", "{last}");
    let mut packaged = Vec::new();
    let mut stack = vec![root.join("交付")];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                packaged.push(p.strip_prefix(&root).unwrap().display().to_string());
            }
        }
    }
    assert!(
        !packaged.iter().any(|p| p.contains(".ocard")),
        "`.ocard` 绝不许被打进交付包: {packaged:?}"
    );
    assert!(
        packaged.iter().any(|p| p.contains("待交付.jpg")),
        "真素材必须进包: {packaged:?}"
    );
}

/// 全屏预览的全尺寸取图(load_full_preview)接线。
///
/// 本用例守的是这条 bug 的核心:**全屏里必须能拿到原始像素的图**,
/// 拿不到时必须返回一句**说清为什么**的话,而不是返回成功让界面
/// 停在放大的缩略图上装作没事。
#[test]
fn full_preview_returns_native_pixels_and_names_every_failure() {
    let (window, tmp, nas) = mock_app();
    let pid = create_b_project(&window);
    let inbox = nas.join(&pid).join("1. 待分类");
    std::fs::create_dir_all(&inbox).unwrap();

    // ① JPEG:必须是原始像素,不是 320px 缩略图
    let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(1200, 800, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, 77])
    }));
    img.save(inbox.join("DSC_0001.jpg")).unwrap();
    let got = invoke(
        &window,
        "load_full_preview",
        json!({"projectId": pid, "assetId": "1. 待分类/DSC_0001.jpg"}),
    )
    .expect("JPEG 必须能取到全尺寸");
    assert_eq!(got["width"], 1200, "{got}");
    assert_eq!(got["height"], 800, "{got}");
    assert_eq!(got["sourceWidth"], 1200);
    assert_eq!(got["downscaled"], false, "没超上限就必须是原始像素");
    assert_eq!(got["fromCache"], false);
    let url = got["url"].as_str().unwrap().to_string();
    assert!(url.contains(".jpg"), "{url}");

    // 落盘的确实是全尺寸,不是缩略图(直接量一下缓存文件)
    let cache_name = url.rsplit('/').next().unwrap();
    let cached = tmp.path().join("cache/previews").join(cache_name);
    assert!(
        cached.is_file(),
        "预览必须落进本机缓存: {}",
        cached.display()
    );
    assert_eq!(image::image_dimensions(&cached).unwrap(), (1200, 800));

    // ② 第二次命中缓存,尺寸口径不变(缓存里不许端出一份说不清的元信息)
    let again = invoke(
        &window,
        "load_full_preview",
        json!({"projectId": pid, "assetId": "1. 待分类/DSC_0001.jpg"}),
    )
    .unwrap();
    assert_eq!(again["fromCache"], true, "{again}");
    assert_eq!(again["width"], 1200);
    assert_eq!(again["downscaled"], false);

    // ③ 各类失败各说各的话。这个 .NEF 里装的是垃圾字节:RAW 现在有解码器
    // 认领了,所以它必须报成「内嵌预览损坏」,不能再报「格式不支持」——
    // 后者会把人引去找解码器,而毛病在文件本身
    std::fs::write(inbox.join("DSC_0002.NEF"), b"raw bytes").unwrap();
    let raw = invoke(
        &window,
        "load_full_preview",
        json!({"projectId": pid, "assetId": "1. 待分类/DSC_0002.NEF"}),
    )
    .unwrap_err()
    .as_str()
    .unwrap()
    .to_string();
    assert!(
        raw.contains("损坏") && raw.contains("nef"),
        "坏 RAW 要点名是文件坏了、坏在哪个格式: {raw}"
    );
    assert!(
        !raw.contains("尚未接入"),
        "RAW 已接入内嵌预览,不该再说「尚未接入」: {raw}"
    );

    std::fs::write(inbox.join("readme.txt"), b"not an image").unwrap();
    let other = invoke(
        &window,
        "load_full_preview",
        json!({"projectId": pid, "assetId": "1. 待分类/readme.txt"}),
    )
    .unwrap_err()
    .as_str()
    .unwrap()
    .to_string();
    assert!(other.contains("不是本工具能解码"), "{other}");

    // 视频与 HEIC 现在有解码器认领:**不再**是「格式不支持」。
    // 这个 .MP4 里装的是垃圾字节,所以必须报成「文件损坏」——
    // 把损坏说成「格式不支持」会把人引去找解码器,而毛病在文件本身
    std::fs::write(inbox.join("CLIP0001.MP4"), b"video bytes").unwrap();
    let video = invoke(
        &window,
        "load_full_preview",
        json!({"projectId": pid, "assetId": "1. 待分类/CLIP0001.MP4"}),
    )
    .unwrap_err()
    .as_str()
    .unwrap()
    .to_string();
    assert!(
        !video.contains("尚未接入") && !video.contains("不是本工具能解码"),
        "视频已接入抽帧,不该再报「格式不支持」: {video}"
    );
    // sidecar 在场时报「损坏」,不在场时报「缺 ffmpeg」——两句都合法,
    // 但都必须点名到底是哪一种,不能笼统一句「加载失败」
    assert!(
        video.contains("损坏") || video.contains("ffmpeg"),
        "视频失败要点名是文件坏了还是缺组件: {video}"
    );

    std::fs::write(inbox.join("broken.jpg"), b"this is definitely not a jpeg").unwrap();
    let broken = invoke(
        &window,
        "load_full_preview",
        json!({"projectId": pid, "assetId": "1. 待分类/broken.jpg"}),
    )
    .unwrap_err()
    .as_str()
    .unwrap()
    .to_string();
    assert!(broken.contains("损坏"), "损坏文件要说是损坏: {broken}");

    for (a, b) in [(&raw, &other), (&raw, &video), (&other, &video)] {
        assert_ne!(a, b, "两类失败说了同一句话,等于没分类");
    }

    // ④ 相对路径闸:前端传来的 assetId 逃不出项目根
    for evil in ["../../etc/passwd", "/etc/passwd", "1. 待分类/../../x.jpg"] {
        assert!(
            invoke(
                &window,
                "load_full_preview",
                json!({"projectId": pid, "assetId": evil}),
            )
            .is_err(),
            "{evil} 必须被拒"
        );
    }
}

/// 全屏预览的 **RAW 内嵌预览**接线。
///
/// 守的是这一路最容易复发的那件事:**「够不够用」必须原样走到界面**。
/// 内嵌预览取到了 ≠ 够用——半幅/缩略级的图判不了 1:1 的虚实,
/// 把它当原图端上去只是换了个方式继续骗人。所以四档 adequacy 各自
/// 在 DTO 上留什么、缓存命中那条路会不会把警示弄丢,都在这里钉死。
#[test]
fn full_preview_wires_raw_embedded_with_its_adequacy() {
    use crate::core::raw_fixture::SynthRaw;

    let (window, tmp, nas) = mock_app();
    let pid = create_b_project(&window);
    let inbox = nas.join(&pid).join("1. 待分类");
    std::fs::create_dir_all(&inbox).unwrap();

    let get = |name: &str| -> serde_json::Value {
        invoke(
            &window,
            "load_full_preview",
            json!({"projectId": pid, "assetId": format!("1. 待分类/{name}")}),
        )
        .unwrap_or_else(|e| panic!("{name} 应能取出内嵌预览,实得 {e}"))
    };

    // ① 四档 adequacy 各自到达界面
    SynthRaw::new((1600, 1067), Some((1620, 1080))).write(&inbox.join("FULL.NEF"));
    SynthRaw::new((1600, 1067), Some((3000, 2000))).write(&inbox.join("HALF.ARW"));
    SynthRaw::new((800, 533), Some((3000, 2000))).write(&inbox.join("TINY.CR2"));
    SynthRaw::new((1600, 1067), None).write(&inbox.join("NOSIZE.DNG"));

    let full = get("FULL.NEF");
    assert_eq!(full["kind"], "rawEmbedded", "{full}");
    assert_eq!(full["rawAdequacy"], "fullSize", "{full}");
    assert!(
        full["rawWarning"].is_null(),
        "全尺寸内嵌预览没有尺寸方面的警示(「这是机内渲染」那句由界面补): {full}"
    );
    assert_eq!(full["width"], 1600, "{full}");
    assert_eq!(full["downscaled"], false);

    let half = get("HALF.ARW");
    assert_eq!(half["rawAdequacy"], "reduced", "{half}");
    let half_warn = half["rawWarning"].as_str().expect("半幅级必须有常驻警示");
    assert!(
        half_warn.contains("1600×1067") && half_warn.contains("3000×2000"),
        "半幅警示要写清内嵌预览多大、原图多大: {half_warn}"
    );

    let tiny = get("TINY.CR2");
    assert_eq!(tiny["rawAdequacy"], "thumbnailOnly", "{tiny}");
    assert!(tiny["rawWarning"].as_str().unwrap().contains("判不了虚实"));

    let unknown = get("NOSIZE.DNG");
    assert_eq!(
        unknown["rawAdequacy"], "unknown",
        "读不到原图尺寸时不许假装是全尺寸: {unknown}"
    );
    assert!(unknown["rawWarning"].as_str().unwrap().contains("无法确认"));

    // 四档的话必须互不相同,否则等于没分档
    let mut said: Vec<String> = [&half, &tiny, &unknown]
        .iter()
        .map(|v| v["rawWarning"].as_str().unwrap().to_string())
        .collect();
    said.sort();
    said.dedup();
    assert_eq!(said.len(), 3, "三档警示说了同一句话,等于没分档");

    // ② 落盘的确实是内嵌预览那张图(不是 320px 缩略图)
    let cache_name = full["url"].as_str().unwrap().rsplit('/').next().unwrap();
    let cached = tmp.path().join("cache/previews").join(cache_name);
    assert_eq!(image::image_dimensions(&cached).unwrap(), (1600, 1067));

    // ③ **缓存命中不许把警示弄丢**。这是这条 bug 最省事的复发路径:
    // 第一次老老实实说「这是半幅」,第二次走缓存就悄悄闭嘴了
    let again = get("HALF.ARW");
    assert_eq!(again["fromCache"], true, "{again}");
    assert_eq!(again["kind"], "rawEmbedded", "{again}");
    assert_eq!(again["rawAdequacy"], "reduced", "缓存命中也必须报半幅");
    assert_eq!(
        again["rawWarning"], half["rawWarning"],
        "缓存命中的警示必须与首次一字不差"
    );
    assert_eq!(again["sourceWidth"], 1600, "{again}");
    assert_eq!(again["sourceHeight"], 1067, "{again}");

    // ④ 方向:EXIF 说转 90° 就转,而且解码路径与缓存路径转得一样多
    SynthRaw::new((1600, 1067), Some((3000, 2000)))
        .with_orientation(6)
        .write(&inbox.join("ROT.NEF"));
    let rot = get("ROT.NEF");
    assert_eq!(
        (rot["width"].as_u64(), rot["height"].as_u64()),
        (Some(1067), Some(1600))
    );
    let rot_cached = get("ROT.NEF");
    assert_eq!(rot_cached["fromCache"], true);
    assert_eq!(
        (
            rot_cached["sourceWidth"].as_u64(),
            rot_cached["sourceHeight"].as_u64()
        ),
        (Some(1067), Some(1600)),
        "缓存那条路报的尺寸必须也是摆正后的: {rot_cached}"
    );

    // ⑤ 相机已经把预览摆正过时不许再转一次(转两次是倒的,比不转更糟)
    SynthRaw::new((1067, 1600), Some((3000, 2000)))
        .with_orientation(6)
        .write(&inbox.join("UPRIGHT.NEF"));
    let upright = get("UPRIGHT.NEF");
    assert_eq!(
        (upright["width"].as_u64(), upright["height"].as_u64()),
        (Some(1067), Some(1600)),
        "已摆正的预览再转一次会把它转倒: {upright}"
    );
}

/// 全屏预览的**视频抽帧**接线(真 ffmpeg sidecar)。
///
/// 守三件事:
/// 1. 视频在全屏里**真的出画面**了——此前这里只有一句「暂时看不到画面」;
/// 2. 抽的不是第 0 帧。用例造的素材前 1 秒是纯黑(模拟打板/黑头),
///    取回来的那一帧必须是**亮的**——这是「抽哪一帧」那个设计决定的
///    唯一硬证据,把 FRAME_AT_SEC 改回 0 本用例立刻变红;
/// 3. 拿到的是一帧静止画面这件事**说得出口**:kind/frameAtSec 必须一路
///    传到前端,否则用户看着一张静图不知道它代表整段素材的哪个瞬间。
#[cfg(unix)]
#[test]
fn full_preview_extracts_a_video_frame_with_real_ffmpeg() {
    let (window, tmp, nas) = mock_app();
    let Some(ffdir) = stage_sidecar_dir(tmp.path()) else {
        assert!(
            std::env::var_os("CI").is_none(),
            "CI 上缺 sidecar:fetch-ffmpeg 步骤未生效,拒绝静默跳过"
        );
        eprintln!("跳过:src-tauri/binaries 无 sidecar(先跑 scripts/fetch-ffmpeg.sh)");
        return;
    };
    struct EnvGuard;
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            std::env::remove_var("OCARD_FFMPEG_DIR");
        }
    }
    let _g = crate::core::ffmpeg::FFMPEG_ENV_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    std::env::set_var("OCARD_FFMPEG_DIR", &ffdir);
    let _env_guard = EnvGuard;

    let pid = create_b_project(&window);
    let inbox = nas.join(&pid).join("1. 待分类");
    std::fs::create_dir_all(&inbox).unwrap();
    let ffmpeg = ffdir.join("ffmpeg");

    // 前 1 秒纯黑 + 后 3 秒纯白:实拍素材开头常常是黑场/板子,
    // 拿第 0 帧当预览等于给用户看一片黑
    let clip = inbox.join("C0001.MP4");
    let out = std::process::Command::new(&ffmpeg)
        .args([
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=640x360:d=1:r=25",
            "-f",
            "lavfi",
            "-i",
            "color=c=white:s=640x360:d=3:r=25",
            "-filter_complex",
            "[0:v][1:v]concat=n=2:v=1[v]",
            "-map",
            "[v]",
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx264",
        ])
        .arg(&clip)
        .output()
        .expect("生成测试视频失败");
    assert!(
        out.status.success() && clip.is_file(),
        "ffmpeg 生成源视频失败: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    let got = invoke(
        &window,
        "load_full_preview",
        json!({"projectId": pid, "assetId": "1. 待分类/C0001.MP4"}),
    )
    .expect("视频必须能取到一帧画面");

    // ① 真的出画面了,而且是整帧分辨率(不是 320px 缩略图)
    assert_eq!(got["width"], 640, "{got}");
    assert_eq!(got["height"], 360, "{got}");
    assert_eq!(got["sourceWidth"], 640);
    assert_eq!(got["downscaled"], false);
    // ② 这是「一帧」这件事必须说得出口
    assert_eq!(got["kind"], "videoFrame", "视频帧不能冒充原图: {got}");
    assert_eq!(
        got["frameAtSec"].as_f64(),
        Some(crate::core::preview_ffmpeg::FRAME_AT_SEC),
        "抽的是第几秒必须一路传到界面: {got}"
    );
    assert!(
        (got["durationSec"].as_f64().unwrap_or(0.0) - 4.0).abs() < 0.5,
        "整段时长也要报出来: {got}"
    );

    // ③ 抽的不是黑场那一帧——「靠前但不为 0」这个决定的硬证据
    let cache_name = got["url"].as_str().unwrap().rsplit('/').next().unwrap();
    let cached = tmp.path().join("cache/previews").join(cache_name);
    let frame = image::open(&cached).expect("落盘的预览必须可解码");
    assert_eq!((frame.width(), frame.height()), (640, 360));
    let rgb = frame.to_rgb8();
    let mean: f64 = rgb.pixels().map(|p| p.0[0] as f64).sum::<f64>() / rgb.pixels().len() as f64;
    assert!(
        mean > 200.0,
        "抽到的应是第 1 秒的白场;均值 {mean:.1} 说明取的还是开头的黑帧"
    );

    // ④ 命中缓存时,「这是第几秒」不能丢——否则第二次打开同一条素材,
    //    界面就变成举着一张来路不明的静图
    let again = invoke(
        &window,
        "load_full_preview",
        json!({"projectId": pid, "assetId": "1. 待分类/C0001.MP4"}),
    )
    .expect("第二次必须命中缓存");
    assert_eq!(again["fromCache"], true, "{again}");
    assert_eq!(again["kind"], "videoFrame", "{again}");
    assert_eq!(
        again["frameAtSec"].as_f64(),
        Some(crate::core::preview_ffmpeg::FRAME_AT_SEC),
        "缓存命中也要说得出第几秒: {again}"
    );
    assert_eq!(again["sourceWidth"], 640, "{again}");

    // ⑤ 比抽帧偏移还短的素材:退回第 0 秒,而不是判成失败
    let short = inbox.join("C0002.MP4");
    let out = std::process::Command::new(&ffmpeg)
        .args([
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=320x240:r=25:d=0.4",
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx264",
        ])
        .arg(&short)
        .output()
        .expect("生成短视频失败");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let tiny = invoke(
        &window,
        "load_full_preview",
        json!({"projectId": pid, "assetId": "1. 待分类/C0002.MP4"}),
    )
    .expect("0.4 秒的素材也必须出画面,不能因为 -ss 越界就判失败");
    assert_eq!(tiny["width"], 320, "{tiny}");
    assert_eq!(
        tiny["frameAtSec"].as_f64(),
        Some(0.0),
        "短片要退回第 0 秒: {tiny}"
    );

    // ⑥ 坏文件报「损坏」,不报「格式不支持」——两者指向完全不同的排查方向
    std::fs::write(inbox.join("C0003.MP4"), vec![0x5Au8; 40_000]).unwrap();
    let broken = invoke(
        &window,
        "load_full_preview",
        json!({"projectId": pid, "assetId": "1. 待分类/C0003.MP4"}),
    )
    .unwrap_err()
    .as_str()
    .unwrap()
    .to_string();
    assert!(broken.contains("损坏"), "坏视频要说是损坏: {broken}");
    assert!(
        !broken.contains("解码器"),
        "别把坏文件说成缺解码器: {broken}"
    );
}

/// 全屏预览的 **HEIC/HEIF** 接线(真 ffmpeg sidecar)。
///
/// 这里同时是「HEIC 到底能不能解」那个结论的可执行版本:能不能解**不做
/// 编译期假设**,由这条用例在每台机器上真解一次来回答。`.heic` 容器里
/// 装的可能是 HEVC 也可能是 AV1,所以两种都要过一遍。
#[cfg(unix)]
#[test]
fn full_preview_decodes_heif_with_real_ffmpeg() {
    let (window, tmp, nas) = mock_app();
    let Some(ffdir) = stage_sidecar_dir(tmp.path()) else {
        assert!(
            std::env::var_os("CI").is_none(),
            "CI 上缺 sidecar:fetch-ffmpeg 步骤未生效,拒绝静默跳过"
        );
        eprintln!("跳过:src-tauri/binaries 无 sidecar(先跑 scripts/fetch-ffmpeg.sh)");
        return;
    };
    struct EnvGuard;
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            std::env::remove_var("OCARD_FFMPEG_DIR");
        }
    }
    let _g = crate::core::ffmpeg::FFMPEG_ENV_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    std::env::set_var("OCARD_FFMPEG_DIR", &ffdir);
    let _env_guard = EnvGuard;

    let pid = create_b_project(&window);
    let inbox = nas.join(&pid).join("1. 待分类");
    std::fs::create_dir_all(&inbox).unwrap();
    let ffmpeg = ffdir.join("ffmpeg");

    // 真 HEIF 家族文件:ffmpeg 没有 heif 复用器,但 avif 复用器写出来的
    // 就是 ISOBMFF/HEIF 结构(AVIF 本就是「装 AV1 的 HEIF」),
    // 走的是与 .heic 完全相同的那条解复用+解码路径,而且三平台都造得出来
    let heif = inbox.join("IMG_0001.heif");
    let out = std::process::Command::new(&ffmpeg)
        .args([
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=640x480:d=1",
            "-frames:v",
            "1",
            "-c:v",
            "libaom-av1",
            "-still-picture",
            "1",
            "-f",
            "avif",
        ])
        .arg(&heif)
        .output()
        .expect("生成 HEIF 素材失败");
    assert!(
        out.status.success() && heif.is_file(),
        "ffmpeg 生成 HEIF 失败: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    let got = invoke(
        &window,
        "load_full_preview",
        json!({"projectId": pid, "assetId": "1. 待分类/IMG_0001.heif"}),
    )
    .expect("HEIF 必须能解出整幅");
    assert_eq!(got["width"], 640, "{got}");
    assert_eq!(got["height"], 480, "{got}");
    assert_eq!(got["sourceWidth"], 640);
    assert_eq!(got["downscaled"], false);
    // HEIC 解出来的**就是这张照片本身**,不是「其中一帧」:
    // 和 JPEG 同级,界面没有额外的话要说
    assert_eq!(got["kind"], "original", "HEIC 是原图不是视频帧: {got}");
    assert!(got["frameAtSec"].is_null(), "静态图没有「第几秒」: {got}");

    // macOS 上顺手用系统的 sips 造一张**真 HEVC 编码、带拼贴网格**的 .heic:
    // 这是 iPhone 实际产出的形态,拼贴那条路(整图尺寸只在 stream_groups 里)
    // 只有它才走得到
    #[cfg(target_os = "macos")]
    {
        let src = inbox.join("_src.jpg");
        image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(1600, 1200, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 90])
        }))
        .save(&src)
        .unwrap();
        let heic = inbox.join("IMG_0002.heic");
        let sips = std::process::Command::new("/usr/bin/sips")
            .args(["-s", "format", "heic"])
            .arg(&src)
            .arg("--out")
            .arg(&heic)
            .output();
        std::fs::remove_file(&src).ok();
        if matches!(&sips, Ok(o) if o.status.success()) && heic.is_file() {
            let got = invoke(
                &window,
                "load_full_preview",
                json!({"projectId": pid, "assetId": "1. 待分类/IMG_0002.heic"}),
            )
            .expect("真 HEIC(HEVC)必须能解出整幅");
            // 拼贴网格:逐块是 512×512,整图才是 1600×1200。
            // 报成 512 就说明 stream_groups 那条路断了,像素上限也会跟着失效
            assert_eq!(got["width"], 1600, "拼贴 HEIC 要拼回整图: {got}");
            assert_eq!(got["height"], 1200, "{got}");
            assert_eq!(got["kind"], "original", "{got}");
        } else {
            eprintln!("跳过真 HEIC 分支:sips 不可用");
        }
    }
}

/* ------------------------------------------------------------------ *
 * 诊断报告导出(0.4.3 现场事故的后续):报错能看见但取不走,排障只能靠猜。
 * 这里考的是**报告里真有排障要用的东西**——只断言「命令返回 Ok」的话,
 * 一份空文件照样绿。
 * ------------------------------------------------------------------ */
#[test]
fn diagnostics_report_carries_what_triage_actually_needs() {
    let (window, _tmp, nas) = mock_app();
    let app = window.app_handle();

    // 造一条现场:界面上出现过的那句报错必须能在报告里找回来
    crate::commands::notify::error(
        app,
        "copy-task-paused",
        "拷卡任务「0831上午_DJIMINI4P_B_LQX」已中断并转入暂停".into(),
    );

    let state = app.state::<AppState>();
    let report = crate::commands::diag_cmds::build_report(app, &state);

    assert!(
        report.contains(env!("CARGO_PKG_VERSION")),
        "要有版本号:\n{report}"
    );
    assert!(report.contains("TEST-MACHINE"), "要有机器 ID:\n{report}");
    assert!(report.contains("集成测试"), "要有操作人:\n{report}");
    assert!(
        report.contains(&nas.display().to_string()),
        "要有 NAS 根路径:\n{report}"
    );
    assert!(
        report.contains("NAS 可达     : 可达"),
        "要探一次可达性:\n{report}"
    );
    assert!(
        report.contains("0831上午_DJIMINI4P_B_LQX"),
        "界面上出现过的报错必须在报告里找得回来:\n{report}"
    );
    assert!(
        report.contains("copy-task-paused"),
        "通知 code 是分类的依据:\n{report}"
    );
    // 抬头必须逐项写明带出去了什么——让人知道自己在往外发什么。
    // 只写一句「不含素材内容」是不够的:操作人姓名、机器 ID、日志全文都在里面
    for item in ["操作人姓名", "机器 ID", "不含素材文件本身", "运行日志"] {
        assert!(report.contains(item), "抬头漏了「{item}」:\n{report}");
    }
}

/// 报告里必须真的有「哪个文件为什么失败」。
///
/// 这是评审抓到的 P0:`build_report` 原先走 `TaskManager::snapshots()`,而它过
/// `summary_of` 会把 `files` 清空——于是「文件 N」恒为 0、失败明细一个字节都不
/// 输出。一个拷了 400 个、失败 12 个的任务在报告里干干净净,那不是缺信息,
/// 是主动误导。本测试从 TaskManager 一路考到报告正文。
#[test]
fn diagnostics_report_names_the_files_that_failed_and_why() {
    use crate::commands::dto::{CopyFileItemDto, CopyTaskDto};
    let (window, _tmp, _nas) = mock_app();
    let app = window.app_handle();
    let state = app.state::<AppState>();

    let snap = CopyTaskDto {
        id: "task-diag-1".into(),
        project_id: "proj-1".into(),
        volume_id: "/Volumes/CARD".into(),
        volume_name: "CARD".into(),
        camera_id: "cam-1".into(),
        camera_code: "DJIMINI4P".into(),
        note: String::new(),
        tags: Vec::new(),
        target_folder: "0831上午_DJIMINI4P_B_LQX".into(),
        source_folders: Vec::new(),
        scan_policy_version: 1,
        destinations: Vec::new(),
        files: Vec::new(),
        file_count: None,
        status_counts: None,
        total_bytes: 2,
        copied_bytes: 1,
        speed_bytes_per_sec: 0,
        state: "paused",
        progress_revision: Some(1),
        operator: "集成测试".into(),
        started_at: "2026-08-31T03:32:00Z".into(),
        finished_at: None,
    };
    let mut snap = snap;
    snap.files = vec![
        CopyFileItemDto {
            status: "verified",
            ..item("DCIM/100MEDIA/DJI_0001.MP4")
        },
        CopyFileItemDto {
            status: "failed",
            error: Some("写入失败: 拒绝访问(系统错误码 5)".into()),
            ..item("DCIM/100MEDIA/DJI_0002.MP4")
        },
    ];
    state.tasks.insert(
        snap.id.clone(),
        std::sync::Arc::new(crate::commands::tasks::TaskHandle {
            pause_requested: Default::default(),
            running: Default::default(),
            snapshot: std::sync::Mutex::new(snap),
            project_root: std::path::PathBuf::from("/nowhere"),
            manifest_id: "m".into(),
            source_root: std::sync::Mutex::new(std::path::PathBuf::from("/card")),
            plan: Default::default(),
            dest_targets: Vec::new(),
            machine_id: "TEST-MACHINE".into(),
            config_dir: std::path::PathBuf::from("/nowhere"),
            lease: Default::default(),
        }),
    );

    let report = crate::commands::diag_cmds::build_report(app, &state);
    assert!(
        report.contains("DJI_0002.MP4"),
        "失败文件必须点名:\n{report}"
    );
    assert!(
        report.contains("系统错误码 5"),
        "失败原因原文必须留住:\n{report}"
    );
    assert!(
        report.contains("失败 1"),
        "总账要对得上(status_counts):\n{report}"
    );
    assert!(
        !report.contains("/ 文件 0"),
        "文件数不许恒为 0(那正是 snapshots() 清空 files 的症状):\n{report}"
    );
}

fn item(path: &str) -> crate::commands::dto::CopyFileItemDto {
    crate::commands::dto::CopyFileItemDto {
        id: path.into(),
        path: path.into(),
        name: path.rsplit('/').next().unwrap_or(path).into(),
        size_bytes: 1,
        status: "pending",
        hash: None,
        error: None,
        targets: None,
    }
}

/// NAS 掉线时报告本身不能跟着废掉:那正是最需要它的时候。
#[test]
fn diagnostics_report_still_builds_when_the_nas_is_gone() {
    let (window, tmp, nas) = mock_app();
    let app = window.app_handle();
    std::fs::remove_dir_all(&nas).unwrap();

    let state = app.state::<AppState>();
    let report = crate::commands::diag_cmds::build_report(app, &state);
    assert!(report.contains("NAS 可达     : 不可达"), "{report}");
    assert!(report.contains("重新挂载"), "不可达也要给下一步:\n{report}");
    drop(tmp);
}

/* ------------------------------------------------------------------ *
 * 任务租约:同一份清单同时只允许一个进程写。
 *
 * 清单落盘是**整份覆盖**,两处同时写时后写的会把先写的整份顶掉;而自从临时
 * 文件名改成唯一的之后,这件事连个错都不报了——更干净,也更难发现。
 * ------------------------------------------------------------------ */

/// 续传的第一步必须是拿租约——在读清单、重解析卷之前。另一个进程正跑着这个
/// 任务时,这里要被挡住,而且要挡在**任何**副作用之前。去掉那次 acquire、
/// 或把它挪到 `manifest::load` 之后,本测试红(挡住的会变成「源卷未挂载」之类
/// 完全不相干的错)。
#[test]
fn resume_is_refused_before_touching_anything_while_another_process_holds_the_task() {
    use crate::commands::dto::CopyTaskDto;
    use crate::core::lease::{lease_path, Lease};
    let (window, _tmp, nas) = mock_app();
    let app = window.app_handle();
    let state = app.state::<AppState>();
    let project_root = nas.join("proj");
    std::fs::create_dir_all(crate::core::manifest::manifest_dir(&project_root)).unwrap();

    let m = crate::core::manifest::CopyManifest::new("1. 待分类/x", "CARD", "A_B_C", "张三", "");
    crate::core::manifest::save(&project_root, &m).unwrap();
    let other = Lease {
        machine_id: "OTHER-MACHINE".into(),
        pid: 4242,
        token: uuid::Uuid::new_v4().to_string(),
        operator: "李四".into(),
        host: "他们的机器".into(),
        heartbeat_at: chrono::Utc::now().to_rfc3339(),
    };
    std::fs::write(
        lease_path(&project_root, &m.id).unwrap(),
        serde_json::to_vec(&other).unwrap(),
    )
    .unwrap();

    let snap = CopyTaskDto {
        id: "task-lease-1".into(),
        project_id: "proj".into(),
        volume_id: "/definitely/not/mounted".into(),
        volume_name: "CARD".into(),
        camera_id: "cam-1".into(),
        camera_code: "A_B_C".into(),
        note: String::new(),
        tags: Vec::new(),
        target_folder: "1. 待分类/x".into(),
        source_folders: Vec::new(),
        scan_policy_version: 1,
        destinations: Vec::new(),
        files: Vec::new(),
        file_count: None,
        status_counts: None,
        total_bytes: 0,
        copied_bytes: 0,
        speed_bytes_per_sec: 0,
        state: "paused",
        progress_revision: Some(1),
        operator: "张三".into(),
        started_at: "2026-08-31T03:32:00Z".into(),
        finished_at: None,
    };
    state.tasks.insert(
        snap.id.clone(),
        std::sync::Arc::new(crate::commands::tasks::TaskHandle {
            pause_requested: Default::default(),
            running: Default::default(),
            snapshot: std::sync::Mutex::new(snap.clone()),
            project_root: project_root.clone(),
            manifest_id: m.id.clone(),
            // 故意给一个不存在的源卷:若续传在拿租约**之前**就去解析卷,
            // 错会变成「源卷未挂载」,而不是「正被别人执行」
            source_root: std::sync::Mutex::new(std::path::PathBuf::from("/definitely/not/mounted")),
            plan: Default::default(),
            dest_targets: Vec::new(),
            machine_id: "TEST-MACHINE".into(),
            config_dir: std::path::PathBuf::from("/nowhere"),
            lease: Default::default(),
        }),
    );

    let err = invoke(&window, "resume_copy_task", json!({ "taskId": snap.id })).unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("正被"), "要在任何副作用之前被租约挡住: {msg}");
    assert!(msg.contains("李四"), "{msg}");
    // 磁盘上的清单一个字节都不许被动过
    let on_disk = crate::core::manifest::load(&project_root, &m.id).unwrap();
    assert!(on_disk.planned.is_empty(), "被拒绝之后还是把计划写进去了");
    // 零静默:拒绝也要进通知中心,不能只在命令返回值里
    let notices = state.notices.lock().unwrap();
    assert!(
        notices.iter().any(|n| n.code == "copy-resume-lease-held"),
        "拒绝续传没有可见通知: {:?}",
        notices.iter().map(|n| &n.code).collect::<Vec<_>>()
    );
}

/* ------------------------------------------------------------------ *
 * 启动期残留临时文件清扫
 * ------------------------------------------------------------------ */

#[test]
fn the_sweep_removes_only_old_orphans_and_never_swallows_a_scan_failure() {
    use crate::commands::{sweep_stale_temp_files, SweepTally};
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("manifests");
    std::fs::create_dir_all(&dir).unwrap();

    let old = dir.join(".m.json.deadbeef.ocardtmp");
    let fresh = dir.join(".m.json.cafebabe.ocardtmp");
    let real = dir.join("m.json");
    for p in [&old, &fresh, &real] {
        std::fs::write(p, b"{}").unwrap();
    }
    // 把 old 的 mtime 推到两小时前(门槛是一小时)
    let two_hours_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(7200);
    std::fs::File::options()
        .write(true)
        .open(&old)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(two_hours_ago))
        .unwrap();

    let mut tally = SweepTally::default();
    sweep_stale_temp_files(&dir, &mut tally);
    assert_eq!(tally.removed, 1, "只该清掉过了门槛的那个");
    assert!(!old.exists(), "旧残留没被清掉");
    assert!(
        fresh.exists(),
        "刚写出来的临时文件被清掉了——那可能是另一个进程**此刻**正在写的那一个"
    );
    assert!(real.exists(), "正式清单被误删");

    // 目录不存在 = 这个项目还没拷过卡,不是故障,不许计数
    let mut t2 = SweepTally::default();
    sweep_stale_temp_files(&tmp.path().join("nope"), &mut t2);
    assert_eq!((t2.removed, t2.stuck), (0, 0), "目录不存在不该算成故障");

    // 其余错误(权限不足 / NAS 半死)必须留下痕迹:吞掉就是无提示 fail-open
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } != 0 {
            let locked = tmp.path().join("locked");
            std::fs::create_dir_all(&locked).unwrap();
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
            let mut t3 = SweepTally::default();
            sweep_stale_temp_files(&locked, &mut t3);
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();
            assert_eq!(t3.stuck, 1, "扫不动必须计数并上报,不能一声不吭");
            assert_eq!(t3.trouble.len(), 1, "要点名是哪个目录");
        }
    }
}
