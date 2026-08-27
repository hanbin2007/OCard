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
    /// 有已发起但未完成的拷卡任务。
    pub copy_incomplete: bool,
    /// 项目用卡清单大小(x/y 的 y;UX 波三)。None = 尚未配置/记录过用卡,
    /// 前端回退按「N 次拷卡」显示——分母必须是真实清单,不许任务数冒充。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card_roster_total: Option<usize>,
    /// 用卡清单中已有完成拷卡的卡数(x)。与 card_roster_total 同生同灭。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card_roster_done: Option<usize>,
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
    /// 插卡绑定:当前挂载的卷路径。传入时当场在卡根写 `.ocard-volume-id`
    /// 指纹并存入登记表(强身份);不传 = 仅卷标弱匹配。
    #[serde(default)]
    pub bind_mount_path: Option<String>,
    /// 绑定时前端所见的卷名:后端与实际挂载核对,防「拔 A 插 B 同挂载点」
    /// 把指纹写到另一张卡(评审 P1)。
    #[serde(default)]
    pub bind_volume_name: Option<String>,
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
    /// 卡匹配判别:matched(认出登记卡)/unregistered(确认未登记)/
    /// unavailable(登记表读不到,无法核对)/conflict(匹配冲突)。
    /// 「读不到」与「确认未登记」必须可分——快捷拷卡把 unavailable
    /// 当 unregistered 会引导重复登记(评审 P0)。
    pub match_status: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProjectDto {
    pub id: String,
    pub name: String,
    pub folder_name: String,
    pub scenario: String,
    pub last_opened_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkstationInfoDto {
    pub machine_id: String,
    pub operator: String,
    pub nas_root: String,
    /// 本机最近打开的项目,新→旧(欢迎窗口列表)
    pub recent_projects: Vec<RecentProjectDto>,
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

/// 任务级全量状态计数:不受 list_copy_files 分页影响的真值(UX 评审 2.5)。
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyStatusCountsDto {
    pub pending: usize,
    pub copied: usize,
    pub verified: usize,
    pub failed: usize,
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
    /// 兼容留存的可读备注(新任务 = 标签拼串);界面呈现以 tags 为准
    pub note: String,
    /// 内容标签(Notion 式);旧 manifest 重建的任务为空
    pub tags: Vec<String>,
    pub target_folder: String,
    pub destinations: Vec<CopyDestinationDto>,
    pub files: Vec<CopyFileItemDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_counts: Option<CopyStatusCountsDto>,
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
    /// 内容标签;老客户端不传时默认空(note 仍可承载自由文本)
    #[serde(default)]
    pub tags: Vec<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_counts: Option<CopyStatusCountsDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCardsDto {
    /// 项目用卡清单(登记卡 id,保持配置顺序)
    pub card_ids: Vec<String>,
    /// 清单中已有完成拷卡的卡 id
    pub copied_card_ids: Vec<String>,
}
