//! 项目目录扫描:遍历 NAS 根,凡含 `.ocard/project.json` 的一级子目录即项目,
//! 并从 manifest 汇总拷卡统计。

use super::manifest;
use super::project::{self, ProjectMeta};
use super::Result;
use chrono::{DateTime, Utc};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct ProjectStats {
    pub root: PathBuf,
    pub folder_name: String,
    pub meta: ProjectMeta,
    /// 已完成(全部校验通过)的拷卡任务数。
    pub cards_copied: usize,
    /// 是否存在未完成的拷卡任务。
    pub has_incomplete_copy: bool,
    pub bytes_copied: u64,
    pub asset_count: usize,
    /// 本项目已发起过的拷卡任务(manifest)总数。
    pub manifest_count: usize,
    /// 各次拷卡的最大目的地数(0 表示还没拷过)。
    pub destination_max: usize,
    pub updated_at: DateTime<Utc>,
}

/// 扫描结果:项目列表 + 需要上报用户的告警(UX 原则:跳过不允许静默)。
#[derive(Debug, Default)]
pub struct CatalogScan {
    pub projects: Vec<ProjectStats>,
    /// 疑似项目但元数据损坏/不可读的目录(有 .ocard 却解析失败)。
    pub warnings: Vec<String>,
}

/// 扫描 NAS 根下的全部项目(仅一级子目录)。
/// 普通目录(无 .ocard)正常跳过;**有 .ocard 但元数据坏掉的目录进 warnings**。
pub fn scan(nas_root: &Path) -> Result<CatalogScan> {
    let mut out = CatalogScan::default();
    if !nas_root.exists() {
        // 零静默:配置了 NAS 根但路径不可达,不能伪装成「零项目」
        out.warnings.push(format!(
            "NAS 根路径不存在或不可达: {}(项目列表为空可能并非真实状态)",
            nas_root.display()
        ));
        return Ok(out);
    }
    for entry in fs::read_dir(nas_root)? {
        let path = entry?.path();
        if !path.is_dir() {
            continue;
        }
        let Ok(meta) = project::load_meta(&path) else {
            if path.join(project::STATE_DIR).exists() {
                out.warnings.push(format!(
                    "目录「{}」含 .ocard 状态但项目元数据损坏或不可读,已跳过",
                    path.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default()
                ));
            }
            continue;
        };
        let folder = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let manifests = match manifest::list(&path) {
            Ok(list) => {
                if list.skipped > 0 {
                    out.warnings.push(format!(
                        "项目「{folder}」有 {} 份拷卡清单损坏或不可读,统计与续传可能不完整",
                        list.skipped
                    ));
                }
                list.manifests
            }
            Err(e) => {
                out.warnings
                    .push(format!("项目「{folder}」的拷卡清单目录不可读: {e}"));
                Vec::new()
            }
        };
        let cards_copied = manifests.iter().filter(|m| m.completed).count();
        let has_incomplete_copy = manifests.iter().any(|m| !m.completed);
        let bytes_copied = manifests
            .iter()
            .flat_map(|m| &m.entries)
            .filter(|e| e.verified)
            .map(|e| e.size)
            .sum();
        let asset_count = manifests
            .iter()
            .flat_map(|m| &m.entries)
            .filter(|e| e.verified)
            .count();
        let updated_at = manifests
            .iter()
            .map(|m| m.created_at)
            .max()
            .unwrap_or(meta.created_at);
        let manifest_count = manifests.len();
        let destination_max = manifests
            .iter()
            .map(|m| m.destinations.len())
            .max()
            .unwrap_or(0);
        out.projects.push(ProjectStats {
            folder_name: folder,
            root: path,
            meta,
            cards_copied,
            has_incomplete_copy,
            bytes_copied,
            asset_count,
            manifest_count,
            destination_max,
            updated_at,
        });
    }
    out.projects.sort_by(|a, b| {
        b.meta
            .date
            .cmp(&a.meta.date)
            .then(a.folder_name.cmp(&b.folder_name))
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::manifest::{CopyManifest, ManifestEntry};
    use crate::core::project::Scenario;
    use chrono::NaiveDate;
    use tempfile::tempdir;

    #[test]
    fn scan_finds_projects_and_aggregates_manifests() {
        let tmp = tempdir().unwrap();
        let d1 = NaiveDate::from_ymd_opt(2026, 8, 24).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2026, 8, 20).unwrap();
        let p1 = project::create_project(tmp.path(), d1, "校运会", Scenario::B, &["比赛".into()])
            .unwrap();
        project::create_project(tmp.path(), d2, "开学典礼", Scenario::A, &[]).unwrap();
        // 干扰项:普通目录不算项目
        fs::create_dir_all(tmp.path().join("随便一个文件夹")).unwrap();

        let mut m = CopyManifest::new(
            "1. 待分类/0824上午_A7M4_A_ZS",
            "SD01",
            "A7M4_A_ZS",
            "ZS",
            "",
        );
        m.upsert(ManifestEntry {
            rel_path: "a.jpg".into(),
            size: 100,
            xxh3: "aa".into(),
            verified: true,
        });
        m.upsert(ManifestEntry {
            rel_path: "b.jpg".into(),
            size: 50,
            xxh3: String::new(),
            verified: false,
        });
        m.completed = false;
        manifest::save(&p1, &m).unwrap();

        let stats = scan(tmp.path()).unwrap().projects;
        assert_eq!(stats.len(), 2);
        // 按日期倒序:校运会(0824)在前
        assert_eq!(stats[0].folder_name, "20260824_校运会");
        assert_eq!(stats[0].cards_copied, 0);
        assert!(stats[0].has_incomplete_copy);
        assert_eq!(stats[0].bytes_copied, 100);
        assert_eq!(stats[0].asset_count, 1);
        assert_eq!(stats[1].folder_name, "20260820_开学典礼");
        assert_eq!(stats[1].asset_count, 0);
    }
}
