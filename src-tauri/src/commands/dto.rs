//! 前后端契约 DTO,与 `src/api/types.ts` 一一对应(camelCase)。

use crate::core::project::Scenario;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDto {
    pub id: String,
    pub name: String,
    /// `YYYYMMDD`
    pub date: String,
    pub folder_name: String,
    pub scenario: Scenario,
    pub categories: Vec<String>,
    pub relative_path: String,
    pub status: &'static str,
    pub cards_copied: usize,
    pub cards_total: usize,
    pub bytes_copied: u64,
    pub asset_count: usize,
    pub sorted_count: usize,
    pub destination_count: usize,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProjectInput {
    pub name: String,
    /// `YYYYMMDD`
    pub date: String,
    pub scenario: Scenario,
    #[serde(default)]
    pub categories: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderNode {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FolderNode>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewCameraInput {
    pub model: String,
    pub position: String,
    pub operator_alias: String,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewStorageCardInput {
    pub label: String,
    pub camera_id: String,
    pub capacity_bytes: u64,
    #[serde(default)]
    pub serial: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeDto {
    pub id: String,
    pub name: String,
    pub mount_path: String,
    pub capacity_bytes: u64,
    pub used_bytes: u64,
    pub removable: bool,
    /// 系统内置盘:拷卡源默认过滤(UX 波),前端提供开关显示。
    pub is_system: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_card_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkstationInfoDto {
    pub machine_id: String,
    pub operator: String,
    pub nas_root: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyFileTargetResult {
    pub destination_id: String,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyFileItemDto {
    pub id: String,
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub targets: Option<Vec<CopyFileTargetResult>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyDestinationDto {
    pub id: String,
    pub kind: String,
    pub path: String,
    pub state: &'static str,
    pub written_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyTaskDto {
    pub id: String,
    pub project_id: String,
    pub volume_id: String,
    pub volume_name: String,
    pub camera_id: String,
    pub camera_code: String,
    pub note: String,
    pub target_folder: String,
    pub destinations: Vec<CopyDestinationDto>,
    pub files: Vec<CopyFileItemDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_count: Option<usize>,
    pub total_bytes: u64,
    pub copied_bytes: u64,
    pub speed_bytes_per_sec: u64,
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_revision: Option<u64>,
    pub operator: String,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartCopyDestination {
    pub kind: String,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartCopyInput {
    pub project_id: String,
    pub volume_id: String,
    pub camera_id: String,
    #[serde(default)]
    pub note: String,
    pub target_prefix: String,
    pub destinations: Vec<StartCopyDestination>,
    #[serde(default)]
    pub auto_proxy: bool,
    /// 目标夹已存在且非空时,须显式确认才继续(只补缺失文件,绝不覆盖)。
    #[serde(default)]
    pub confirm_existing_target: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeInspectionDto {
    pub volume_id: String,
    pub file_count: usize,
    pub total_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub earliest_shot_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_shot_at: Option<String>,
    pub suggested_prefix: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyFilePage {
    pub items: Vec<CopyFileItemDto>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyProgressEventDto {
    pub task_id: String,
    pub revision: u64,
    pub occurred_at: String,
    pub copied_bytes: u64,
    pub speed_bytes_per_sec: u64,
    pub state: &'static str,
    pub changed_files: Vec<CopyFileItemDto>,
    pub changed_destinations: Vec<CopyDestinationDto>,
}
