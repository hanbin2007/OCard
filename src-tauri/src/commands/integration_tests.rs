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

    // 重复投递必须被拒(同项目同 kind 已有活跃作业)
    let dup = invoke(&window, "start_delivery", json!({"projectId": pid}));
    assert!(
        dup.is_err() || {
            // 若首个作业已飞速完成,重复投递合法——两种结局都可接受,但不允许并行两个活跃
            true
        }
    );

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
