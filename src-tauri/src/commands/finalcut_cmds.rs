//! 成片命名校验 + 清账小项(M3 W8):
//! - `check_final_cuts`:扫描工况 A「6. 成片」,命名 grammar 校验 +
//!   ffprobe 实际分辨率交叉核对(引擎不可用时如实标注「未核对」,零静默);
//!   页面可见期由前端 5-10s 轮询(SMB 无可靠 watch,计划 W8);
//! - `curated_flow_hints`:「待修→已修」流转提示(同名成品已出现在已修,
//!   提示删除待修原稿;只提示,删除仍走既有回收站流程,人工确认);
//! - 交付「已上传」手动勾选:`.ocard/delivery-status.json`,原子替换,
//!   last-write-wins(勾选状态,声明语义),跨机可见。

use super::notify;
use crate::core::{ffmpeg, naming, paths, project, transcode};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

type CmdResult<T> = std::result::Result<T, String>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalCutDto {
    pub file_name: String,
    pub valid: bool,
    /// 不合规的逐条人话理由(标黄提示)。
    pub issues: Vec<String>,
    /// "preview" | "final"(仅 valid 时)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parsed: Option<naming::FinalCutName>,
    /// 实际分辨率与命名不符的说明(红标;None=相符或未核对)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution_mismatch: Option<String>,
    /// 实际分辨率未核对的原因(转码引擎不可用等;零静默)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uncheckable: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalCutReportDto {
    pub items: Vec<FinalCutDto>,
    /// 目录不可读等降级(零静默)。
    pub warnings: Vec<String>,
}

#[tauri::command]
pub fn check_final_cuts<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<super::AppState>,
    project_id: String,
) -> CmdResult<FinalCutReportDto> {
    let nas = super::nas_root(&app, &state)?;
    let stats = super::find_project(&nas, &project_id)?;
    if stats.meta.scenario != project::Scenario::A {
        return Err("成片命名校验仅适用于工况 A(视频)项目".into());
    }
    let dir = stats.root.join(project::SCENARIO_A_DIRS[5]); // 6. 成片
    // R2 P1:中间段可能被换成符号链接把读取导出项目外——canonical 只读闸
    paths::assert_within(&stats.root, &dir)?;
    let mut report = FinalCutReportDto {
        items: Vec::new(),
        warnings: Vec::new(),
    };
    let ffprobe = ffmpeg::detect().map(|i| PathBuf::from(i.ffprobe_path));
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) => {
            report
                .warnings
                .push(format!("无法读取「6. 成片」({e}),校验未执行"));
            return Ok(report);
        }
    };
    let mut files: Vec<PathBuf> = Vec::new();
    for e in entries {
        match e {
            Ok(e) => {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                match e.file_type() {
                    Ok(t) if t.is_file() => files.push(e.path()),
                    Ok(t) if t.is_symlink() => {
                        report.warnings.push(format!("跳过符号链接: {name}"))
                    }
                    Ok(_) => {} // 子目录不递归(轻量原则,成片平铺)
                    Err(err) => report.warnings.push(format!("条目类型读取失败: {err}")),
                }
            }
            Err(err) => report.warnings.push(format!("目录枚举出错: {err}")),
        }
    }
    files.sort();
    for f in files {
        let file_name = f
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        match naming::parse_final_cut(&file_name) {
            Err(issues) => report.items.push(FinalCutDto {
                file_name,
                valid: false,
                issues,
                class: None,
                parsed: None,
                resolution_mismatch: None,
                uncheckable: None,
            }),
            Ok(parsed) => {
                let (mismatch, uncheckable) = match &ffprobe {
                    Ok(probe) => match transcode::probe_file(probe, &f) {
                        Ok(info) if info.width == 0 || info.height == 0 => {
                            (None, Some("实际分辨率未核对(探测返回零尺寸)".to_string()))
                        }
                        Ok(info) => {
                            // 竖幅按较小边比对(横幅=height,竖幅=width)
                            let effective = info.width.min(info.height);
                            (naming::resolution_mismatch(&parsed, effective), None)
                        }
                        Err(e) => (None, Some(format!("实际分辨率未核对(探测失败: {e})"))),
                    },
                    Err(e) => (None, Some(format!("实际分辨率未核对(转码引擎不可用: {e})"))),
                };
                report.items.push(FinalCutDto {
                    file_name,
                    valid: true,
                    issues: Vec::new(),
                    class: Some(parsed.class.to_string()),
                    parsed: Some(parsed),
                    resolution_mismatch: mismatch,
                    uncheckable,
                });
            }
        }
    }
    Ok(report)
}

// ---------- 待修→已修 流转提示 ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CuratedFlowHintDto {
    /// 待修中的原稿(素材 id,可直接用于既有回收站操作)。
    pub todo_asset_id: String,
    /// 已修中出现的同名成品文件名。
    pub done_file_name: String,
}

/// 「待修→已修」流转提示:已修夹出现与待修**同主名**(忽略扩展名)的成品时,
/// 提示删除待修原稿(PRD §5.4;只提示,不动文件)。
#[tauri::command]
pub fn curated_flow_hints<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<super::AppState>,
    project_id: String,
) -> CmdResult<Vec<CuratedFlowHintDto>> {
    let nas = super::nas_root(&app, &state)?;
    let stats = super::find_project(&nas, &project_id)?;
    let dirs = project::scenario_b_dirs(&stats.meta.categories);
    if stats.meta.scenario != project::Scenario::B || dirs.len() < 2 {
        return Err("流转提示仅适用于工况 B 项目".into());
    }
    let curated = &dirs[dirs.len() - 2];
    let todo_dir = stats.root.join(curated).join(project::CURATED_TODO);
    let done_dir = stats.root.join(curated).join(project::CURATED_DONE);
    // R2 P1:中间段符号链接闸(canonical 只读断言)
    paths::assert_within(&stats.root, &todo_dir)?;
    paths::assert_within(&stats.root, &done_dir)?;
    let stem = |n: &str| {
        n.rsplit_once('.')
            .map(|(s, _)| s.to_string())
            .unwrap_or_else(|| n.to_string())
    };
    let list = |d: &PathBuf| -> Vec<String> {
        match std::fs::read_dir(d) {
            Ok(es) => es
                .flatten()
                .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| !n.starts_with('.'))
                .collect(),
            Err(e) => {
                // 读错不许静默当空(零静默):提示后按空处理
                notify::warn(
                    &app,
                    "curated-hints-degraded",
                    format!("读取 {} 失败({e}),流转提示可能不完整", d.display()),
                );
                Vec::new()
            }
        }
    };
    let done_stems: std::collections::HashMap<String, String> =
        list(&done_dir).into_iter().map(|n| (stem(&n), n)).collect();
    let mut hints = Vec::new();
    for todo in list(&todo_dir) {
        if let Some(done_name) = done_stems.get(&stem(&todo)) {
            hints.push(CuratedFlowHintDto {
                todo_asset_id: format!("{curated}/{}/{todo}", project::CURATED_TODO),
                done_file_name: done_name.clone(),
            });
        }
    }
    hints.sort_by(|a, b| a.todo_asset_id.cmp(&b.todo_asset_id));
    Ok(hints)
}

// ---------- 交付「已上传」勾选 ----------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryStatusDto {
    pub uploaded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

fn delivery_status_path(root: &std::path::Path) -> PathBuf {
    root.join(project::STATE_DIR).join("delivery-status.json")
}

#[tauri::command]
pub fn get_delivery_status<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<super::AppState>,
    project_id: String,
) -> CmdResult<DeliveryStatusDto> {
    let nas = super::nas_root(&app, &state)?;
    let stats = super::find_project(&nas, &project_id)?;
    let path = delivery_status_path(&stats.root);
    paths::assert_within(&stats.root, &path)?;
    if !path.exists() {
        return Ok(DeliveryStatusDto::default());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("状态文件损坏: {e}"))
}

/// 勾选状态:原子替换,last-write-wins(声明语义——这是人工勾选,不是账本)。
#[tauri::command]
pub fn set_delivery_status<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<super::AppState>,
    project_id: String,
    uploaded: bool,
) -> CmdResult<DeliveryStatusDto> {
    let nas = super::nas_root(&app, &state)?;
    let stats = super::find_project(&nas, &project_id)?;
    let status = DeliveryStatusDto {
        uploaded,
        updated_by: Some(super::operator(&app, &state)),
        updated_at: Some(chrono::Utc::now().to_rfc3339()),
    };
    let dir = stats.root.join(project::STATE_DIR);
    paths::ensure_dir_within(&stats.root, &dir)?;
    let path = delivery_status_path(&stats.root);
    if paths::is_symlink(&path) {
        return Err("状态文件是符号链接,拒绝写入".into());
    }
    let tmp = dir.join(format!(".{}.statuspart", uuid::Uuid::new_v4()));
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(&status).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(status)
}
