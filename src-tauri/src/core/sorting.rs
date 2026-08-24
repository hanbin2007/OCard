//! 分类工作台核心(M2 任务2):分类移动、精选复制、回收站三件套。
//! 不变量:
//! - **零覆盖**:任何移动/复制/恢复,目标已存在即失败该项,绝不替换;
//! - **两段式删除**:trash 只移入 `.ocard/trash`,`empty_trash` 是全应用唯一物理删除;
//! - 批量操作逐项返回结果(部分失败必须可表达,前端恢复失败项选中态)。

use super::journal::{self, Event};
use super::project::{self, Scenario, STATE_DIR};
use super::{CoreError, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const TRASH_DIR: &str = "trash";
const TRASH_INDEX: &str = "index.jsonl";

/// 审计事件类型(分类环节)。
pub mod kind {
    pub const ASSETS_MOVED: &str = "assets_moved";
    pub const ASSETS_CURATED: &str = "assets_curated";
    pub const ASSETS_TRASHED: &str = "assets_trashed";
    pub const ASSETS_RESTORED: &str = "assets_restored";
    pub const TRASH_EMPTIED: &str = "trash_emptied";
}

/// 单项操作结果(组装 BulkResult 用)。
#[derive(Debug)]
pub struct ItemOutcome {
    pub asset_id: String,
    pub result: std::result::Result<(), String>,
}

#[derive(Debug, Clone)]
pub struct CategoryInfo {
    pub id: String,
    pub name: String,
    pub folder_name: String,
    /// "inbox" | "custom" | "curated" | "other"
    pub kind: &'static str,
    pub count: usize,
    pub hotkey: Option<u8>,
}

/// 列出工况 B 项目的分类夹(含计数)。工况 A 无分类概念,返回错误。
pub fn list_categories(
    project_root: &Path,
    meta: &project::ProjectMeta,
) -> Result<Vec<CategoryInfo>> {
    if meta.scenario != Scenario::B {
        return Err(CoreError::Invalid("工况 A 项目没有分类工作台".into()));
    }
    let dirs = project::scenario_b_dirs(&meta.categories);
    let mut out = Vec::new();
    for (i, folder) in dirs.iter().enumerate() {
        let (kind, name, hotkey): (&'static str, String, Option<u8>) = if i == 0 {
            ("inbox", "待分类".to_string(), None)
        } else if folder.ends_with(project::CURATED_DIR_NAME) {
            ("curated", project::CURATED_DIR_NAME.to_string(), None)
        } else if folder.ends_with(project::MISC_DIR_NAME) {
            ("other", project::MISC_DIR_NAME.to_string(), None)
        } else {
            let idx = i as u8; // 自定义分类从第 2 夹开始,热键 1 起
            (
                "custom",
                meta.categories.get(i - 1).cloned().unwrap_or_default(),
                (idx <= 9).then_some(idx),
            )
        };
        out.push(CategoryInfo {
            id: folder.clone(),
            name,
            folder_name: folder.clone(),
            kind,
            count: count_files(&project_root.join(folder)),
            hotkey,
        });
    }
    Ok(out)
}

fn count_files(dir: &Path) -> usize {
    let mut n = 0usize;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = fs::read_dir(&d) else {
            continue;
        };
        for e in entries.flatten() {
            let name = e.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                n += 1;
            }
        }
    }
    n
}

fn rel_to_native(rel: &str) -> PathBuf {
    rel.split('/').collect()
}

fn file_name_of(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

/// 零覆盖移动:目标存在即失败。
fn move_no_replace(src: &Path, dst: &Path) -> std::result::Result<(), String> {
    if !src.is_file() {
        return Err("源文件不存在或不可读".into());
    }
    if dst.exists() {
        return Err(format!("目标已存在同名文件,拒绝覆盖: {}", dst.display()));
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目标夹失败: {e}"))?;
    }
    fs::rename(src, dst).map_err(|e| format!("移动失败: {e}"))
}

/// 批量移动素材到分类夹(扁平落位,保留文件名)。
pub fn move_assets(
    project_root: &Path,
    asset_ids: &[String],
    category_folder: &str,
) -> Vec<ItemOutcome> {
    asset_ids
        .iter()
        .map(|id| {
            let src = project_root.join(rel_to_native(id));
            let dst = project_root.join(category_folder).join(file_name_of(id));
            ItemOutcome {
                asset_id: id.clone(),
                result: move_no_replace(&src, &dst),
            }
        })
        .collect()
}

/// 批量精选:**复制**进「精选/待修」,原件留在原地(PRD §5.4)。
pub fn curate_assets(project_root: &Path, asset_ids: &[String]) -> Vec<ItemOutcome> {
    let curated_todo = find_curated_todo(project_root);
    asset_ids
        .iter()
        .map(|id| {
            let src = project_root.join(rel_to_native(id));
            let result = match &curated_todo {
                None => Err("找不到「精选/待修」文件夹".to_string()),
                Some(dir) => {
                    let dst = dir.join(file_name_of(id));
                    if !src.is_file() {
                        Err("源文件不存在或不可读".into())
                    } else if dst.exists() {
                        Err(format!(
                            "「待修」中已有同名文件,拒绝覆盖: {}",
                            dst.display()
                        ))
                    } else {
                        fs::create_dir_all(dir)
                            .map_err(|e| format!("创建待修夹失败: {e}"))
                            .and_then(|_| {
                                fs::copy(&src, &dst)
                                    .map(|_| ())
                                    .map_err(|e| format!("复制失败: {e}"))
                            })
                    }
                }
            };
            ItemOutcome {
                asset_id: id.clone(),
                result,
            }
        })
        .collect()
}

fn find_curated_todo(project_root: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(project_root).ok()?;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.ends_with(project::CURATED_DIR_NAME) && e.path().is_dir() {
            return Some(e.path().join(project::CURATED_TODO));
        }
    }
    None
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashRecord {
    pub id: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub original_path: String,
    pub trashed_at: DateTime<Utc>,
    pub operator: String,
    /// trash 目录内的落位文件名。
    pub stored_as: String,
}

pub fn trash_dir(project_root: &Path) -> PathBuf {
    project_root.join(STATE_DIR).join(TRASH_DIR)
}

fn trash_index_path(project_root: &Path) -> PathBuf {
    trash_dir(project_root).join(TRASH_INDEX)
}

fn append_trash_record(project_root: &Path, rec: &TrashRecord) -> std::result::Result<(), String> {
    let mut line = serde_json::to_string(rec).map_err(|e| e.to_string())?;
    line.push('\n');
    use std::io::Write;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(trash_index_path(project_root))
        .map_err(|e| e.to_string())?;
    f.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

/// 读取回收站(以磁盘实存为准;索引坏行计数上报)。
pub fn list_trash(project_root: &Path) -> Result<(Vec<TrashRecord>, usize)> {
    let path = trash_index_path(project_root);
    let mut out = Vec::new();
    let mut skipped = 0usize;
    if !path.exists() {
        return Ok((out, 0));
    }
    let bytes = fs::read(&path)?;
    let text = String::from_utf8_lossy(&bytes);
    let dir = trash_dir(project_root);
    for line in text.lines() {
        match serde_json::from_str::<TrashRecord>(line) {
            Ok(rec) => {
                // 只报告仍实存的(恢复/清空后旧行残留属正常)
                if dir.join(&rec.stored_as).is_file() {
                    out.retain(|r: &TrashRecord| r.id != rec.id);
                    out.push(rec);
                }
            }
            Err(_) => skipped += 1,
        }
    }
    Ok((out, skipped))
}

/// 批量移入回收站(两段式删除的第二段;第一段是前端确认)。
pub fn trash_assets(project_root: &Path, asset_ids: &[String], operator: &str) -> Vec<ItemOutcome> {
    let dir = trash_dir(project_root);
    asset_ids
        .iter()
        .map(|id| {
            let src = project_root.join(rel_to_native(id));
            let result = (|| -> std::result::Result<(), String> {
                let meta = fs::metadata(&src).map_err(|_| "源文件不存在或不可读".to_string())?;
                fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let rec_id = uuid::Uuid::new_v4().to_string();
                let stored_as = format!("{rec_id}_{}", file_name_of(id));
                let dst = dir.join(&stored_as);
                move_no_replace(&src, &dst)?;
                let rec = TrashRecord {
                    id: rec_id,
                    file_name: file_name_of(id).to_string(),
                    size_bytes: meta.len(),
                    original_path: id.clone(),
                    trashed_at: Utc::now(),
                    operator: operator.to_string(),
                    stored_as: stored_as.clone(),
                };
                // 索引写失败必须回滚移动:文件在回收站却无索引 = 变相丢失
                if let Err(e) = append_trash_record(project_root, &rec) {
                    let _ = fs::rename(&dst, &src);
                    return Err(format!("回收站索引写入失败,已还原文件: {e}"));
                }
                Ok(())
            })();
            ItemOutcome {
                asset_id: id.clone(),
                result,
            }
        })
        .collect()
}

/// 恢复:按 originalPath 放回,零覆盖。
pub fn restore_from_trash(project_root: &Path, entry_ids: &[String]) -> Result<Vec<ItemOutcome>> {
    let (records, _) = list_trash(project_root)?;
    let dir = trash_dir(project_root);
    Ok(entry_ids
        .iter()
        .map(|eid| {
            let result = match records.iter().find(|r| &r.id == eid) {
                None => Err("回收站中找不到该条目".to_string()),
                Some(rec) => {
                    let src = dir.join(&rec.stored_as);
                    let dst = project_root.join(rel_to_native(&rec.original_path));
                    move_no_replace(&src, &dst)
                }
            };
            ItemOutcome {
                asset_id: eid.clone(),
                result,
            }
        })
        .collect())
}

/// 清空回收站:**全应用唯一物理删除入口**。返回删除数;逐文件失败计数上报。
pub fn empty_trash(project_root: &Path) -> Result<(usize, usize)> {
    let (records, _) = list_trash(project_root)?;
    let dir = trash_dir(project_root);
    let mut deleted = 0usize;
    let mut failed = 0usize;
    for rec in &records {
        match fs::remove_file(dir.join(&rec.stored_as)) {
            Ok(()) => deleted += 1,
            Err(_) => failed += 1,
        }
    }
    // 全部成功才重置索引;有失败保留索引以便重试
    if failed == 0 {
        let _ = fs::remove_file(trash_index_path(project_root));
    }
    Ok((deleted, failed))
}

/// 写分类环节审计事件(经调用方的 append_audit 兜底通道)。
pub fn audit_event(machine: &str, operator: &str, kind: &str, detail: serde_json::Value) -> Event {
    journal::Event::new(machine, operator, kind, detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use tempfile::tempdir;

    fn setup_project() -> (tempfile::TempDir, PathBuf, project::ProjectMeta) {
        let tmp = tempdir().unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 8, 24).unwrap();
        let root = project::create_project(
            tmp.path(),
            date,
            "校运会",
            Scenario::B,
            &["开幕式".into(), "比赛".into()],
        )
        .unwrap();
        let meta = project::load_meta(&root).unwrap();
        // 放三张素材进待分类
        let inbox = root.join("1. 待分类/0824上午_A7M4_A_ZS");
        fs::create_dir_all(&inbox).unwrap();
        for n in ["a.jpg", "b.jpg", "c.jpg"] {
            fs::write(inbox.join(n), vec![7u8; 100]).unwrap();
        }
        (tmp, root, meta)
    }

    fn asset(rel: &str) -> String {
        format!("1. 待分类/0824上午_A7M4_A_ZS/{rel}")
    }

    #[test]
    fn categories_layout_and_hotkeys() {
        let (_t, root, meta) = setup_project();
        let cats = list_categories(&root, &meta).unwrap();
        let kinds: Vec<_> = cats.iter().map(|c| c.kind).collect();
        assert_eq!(kinds, vec!["inbox", "custom", "custom", "curated", "other"]);
        assert_eq!(cats[1].hotkey, Some(1));
        assert_eq!(cats[2].hotkey, Some(2));
        assert_eq!(cats[0].count, 3);
        assert_eq!(cats[1].folder_name, "2. 开幕式");
    }

    #[test]
    fn move_flattens_and_refuses_overwrite() {
        let (_t, root, _m) = setup_project();
        let out = move_assets(&root, &[asset("a.jpg")], "2. 开幕式");
        assert!(out[0].result.is_ok());
        assert!(root.join("2. 开幕式/a.jpg").is_file());
        assert!(!root.join(asset("a.jpg")).exists());

        // 再放一个同名的进待分类,移动必须拒绝覆盖
        fs::write(root.join(asset("a.jpg")), vec![9u8; 50]).unwrap();
        let out2 = move_assets(&root, &[asset("a.jpg")], "2. 开幕式");
        assert!(out2[0].result.as_ref().unwrap_err().contains("拒绝覆盖"));
        assert_eq!(
            fs::read(root.join("2. 开幕式/a.jpg")).unwrap(),
            vec![7u8; 100]
        );
    }

    #[test]
    fn curate_copies_and_original_stays() {
        let (_t, root, _m) = setup_project();
        let out = curate_assets(&root, &[asset("b.jpg")]);
        assert!(out[0].result.is_ok());
        assert!(root.join(asset("b.jpg")).is_file(), "精选是复制,原件保留");
        assert!(root.join("4. 精选/待修/b.jpg").is_file());
        // 重复精选:拒绝覆盖
        let out2 = curate_assets(&root, &[asset("b.jpg")]);
        assert!(out2[0].result.as_ref().unwrap_err().contains("拒绝覆盖"));
    }

    #[test]
    fn trash_restore_roundtrip_and_empty_is_only_physical_delete() {
        let (_t, root, _m) = setup_project();
        let out = trash_assets(&root, &[asset("c.jpg")], "赵晋宇");
        assert!(out[0].result.is_ok());
        assert!(!root.join(asset("c.jpg")).exists());

        let (records, skipped) = list_trash(&root).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(skipped, 0);
        assert_eq!(records[0].original_path, asset("c.jpg"));
        assert_eq!(records[0].operator, "赵晋宇");

        // 恢复
        let restored = restore_from_trash(&root, &[records[0].id.clone()]).unwrap();
        assert!(restored[0].result.is_ok());
        assert!(root.join(asset("c.jpg")).is_file());
        assert!(list_trash(&root).unwrap().0.is_empty());

        // 再删一次并清空:物理删除
        trash_assets(&root, &[asset("c.jpg")], "赵晋宇");
        let (deleted, failed) = empty_trash(&root).unwrap();
        assert_eq!((deleted, failed), (1, 0));
        assert!(list_trash(&root).unwrap().0.is_empty());
    }

    #[test]
    fn restore_refuses_overwrite() {
        let (_t, root, _m) = setup_project();
        trash_assets(&root, &[asset("a.jpg")], "ZS");
        // 原位置被新文件占据
        fs::write(root.join(asset("a.jpg")), b"new").unwrap();
        let (records, _) = list_trash(&root).unwrap();
        let restored = restore_from_trash(&root, &[records[0].id.clone()]).unwrap();
        assert!(restored[0]
            .result
            .as_ref()
            .unwrap_err()
            .contains("拒绝覆盖"));
        // 回收站里的文件安然无恙
        assert_eq!(list_trash(&root).unwrap().0.len(), 1);
    }

    #[test]
    fn bulk_partial_failure_is_expressed() {
        let (_t, root, _m) = setup_project();
        let out = move_assets(
            &root,
            &[asset("a.jpg"), "1. 待分类/不存在.jpg".to_string()],
            "3. 比赛",
        );
        assert!(out[0].result.is_ok());
        assert!(out[1].result.is_err());
    }
}
