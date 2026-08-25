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
                target_folder: "0824上午_A7M4_A_ZS".into(),
                destinations: Vec::new(),
                files: Vec::new(),
                file_count: None,
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
            dest_targets: vec![dest],
            machine_id: "TEST-MACHINE".into(),
            config_dir: tmp.path().join("config"),
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

/// 把仓内 target-triple 命名的 sidecar 以裸名注入独立目录,返回该目录。
/// sidecar 缺失(未跑 scripts/fetch-ffmpeg.sh)时返回 None,调用方如实跳过。
#[cfg(unix)]
fn stage_sidecar_dir(tmp: &std::path::Path) -> Option<std::path::PathBuf> {
    let bins = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
    let dir = tmp.join("ffmpeg-dir");
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
        std::os::unix::fs::symlink(src, dir.join(name)).ok()?;
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
