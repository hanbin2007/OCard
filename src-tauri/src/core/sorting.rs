//! 分类工作台核心(M2 任务2):分类移动、精选复制、回收站三件套。
//! 不变量:
//! - **路径闸**:一切外部传入的项目内相对路径(asset_ids、回收站索引里的
//!   original_path/stored_as)都是不可信输入,必须过 [`resolve_in_project`],
//!   拒绝任何越界(`..`、绝对路径、盘符、反斜杠);
//! - **零覆盖**:任何移动/复制/恢复走 `fsx::rename_no_replace`/独占创建,
//!   目标已存在即失败该项,绝不替换;
//! - **两段式删除**:trash 只移入 `.ocard/trash`,`empty_trash` 是全应用唯一物理删除,
//!   且只重写索引中本轮删除的行——并发机器新写的行原样保留;
//! - 批量操作逐项返回结果(部分失败必须可表达,前端恢复失败项选中态)。

use super::journal::{self, Event};
use super::project::{self, Scenario, STATE_DIR};
use super::{fsx, paths, CoreError, Result};
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

// ---------- 路径闸(评审 F1) ----------

/// 把不可信的项目内相对路径解析为绝对路径,拒绝任何逃逸。
/// 只接受 `/` 分隔的相对路径;每段必须是普通文件名成分
/// (拒绝 `..`、`.`、空段、盘符/根前缀、反斜杠);
/// 拼接归一后再断言仍位于项目根之内(比较用大小写/别名安全键)。
pub fn resolve_in_project(project_root: &Path, rel: &str) -> std::result::Result<PathBuf, String> {
    if rel.is_empty() {
        return Err("路径为空".into());
    }
    if rel.contains('\\') {
        return Err(format!("路径包含非法分隔符「\\」: {rel}"));
    }
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err(format!("路径包含非法成分: {rel}"));
        }
        // 冒号在所有平台统一拒绝:Windows 上 `C:` 是盘符前缀,
        // 而 FAT/NTFS 文件名本就不允许冒号——这里不能依赖本机平台的解析语义
        if seg.contains(':') {
            return Err(format!("路径包含非法成分: {rel}"));
        }
        // 逐段按平台语义解析:必须恰好是一个普通成分
        let mut comps = Path::new(seg).components();
        match (comps.next(), comps.next()) {
            (Some(std::path::Component::Normal(_)), None) => {}
            _ => return Err(format!("路径包含非法成分: {rel}")),
        }
    }
    let joined = project_root.join(rel.split('/').collect::<PathBuf>());
    let normalized = paths::normalize_lexical(&joined);
    let root_key = paths::comparison_key(&paths::normalize_lexical(project_root));
    let key = paths::comparison_key(&normalized);
    if key == root_key || !key.starts_with(&root_key) {
        return Err(format!("路径越界(不在项目内): {rel}"));
    }
    Ok(normalized)
}

/// 校验单个文件名成分(回收站 stored_as 等,不允许任何分隔符)。
fn valid_single_segment(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && name != "."
        && name != ".."
        && {
            let mut comps = Path::new(name).components();
            matches!(
                (comps.next(), comps.next()),
                (Some(std::path::Component::Normal(_)), None)
            )
        }
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
/// 夹角色按**布局下标**判定(scenario_b_dirs 的顺序是结构保证),
/// 不再用 ends_with 猜名字——自定义分类叫「运动会精选」也不会被误判(评审 M1)。
pub fn list_categories(
    project_root: &Path,
    meta: &project::ProjectMeta,
) -> Result<Vec<CategoryInfo>> {
    if meta.scenario != Scenario::B {
        return Err(CoreError::Invalid("工况 A 项目没有分类工作台".into()));
    }
    let dirs = project::scenario_b_dirs(&meta.categories);
    let last = dirs.len() - 1;
    let mut out = Vec::new();
    for (i, folder) in dirs.iter().enumerate() {
        let (kind, name, hotkey): (&'static str, String, Option<u8>) = if i == 0 {
            ("inbox", "待分类".to_string(), None)
        } else if i == last - 1 {
            ("curated", project::CURATED_DIR_NAME.to_string(), None)
        } else if i == last {
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

/// 「精选/待修」目录:按布局下标从 meta 推导,不扫描目录名。
pub fn curated_todo_dir(project_root: &Path, meta: &project::ProjectMeta) -> Option<PathBuf> {
    if meta.scenario != Scenario::B {
        return None;
    }
    let dirs = project::scenario_b_dirs(&meta.categories);
    let curated = dirs.get(dirs.len() - 2)?;
    Some(project_root.join(curated).join(project::CURATED_TODO))
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

fn file_name_of(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

/// 零覆盖移动:平台原子原语,目标存在即失败(评审 H4:不再 exists+rename)。
fn move_no_replace(src: &Path, dst: &Path) -> std::result::Result<(), String> {
    if !src.is_file() {
        return Err("源文件不存在或不可读".into());
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目标夹失败: {e}"))?;
    }
    fsx::rename_no_replace(src, dst).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            format!("目标已存在同名文件,拒绝覆盖: {}", dst.display())
        } else {
            format!("移动失败: {e}")
        }
    })
}

/// 批量移动素材到分类夹(扁平落位,保留文件名)。
/// asset_ids 与 category_folder 都过路径闸;调用方还需按分类白名单校验 category。
pub fn move_assets(
    project_root: &Path,
    asset_ids: &[String],
    category_folder: &str,
) -> Vec<ItemOutcome> {
    let cat_dir = resolve_in_project(project_root, category_folder);
    asset_ids
        .iter()
        .map(|id| {
            let result = (|| -> std::result::Result<(), String> {
                let src = resolve_in_project(project_root, id)?;
                let dir = cat_dir.clone()?;
                move_no_replace(&src, &dir.join(file_name_of(id)))
            })();
            ItemOutcome {
                asset_id: id.clone(),
                result,
            }
        })
        .collect()
}

/// 批量精选:**复制**进「精选/待修」,原件留在原地(PRD §5.4)。
/// 复制经唯一临时文件落地再原子改名,断电/并发不会留下半截或覆盖(评审 H4)。
pub fn curate_assets(
    project_root: &Path,
    meta: &project::ProjectMeta,
    asset_ids: &[String],
) -> Vec<ItemOutcome> {
    let curated_todo = curated_todo_dir(project_root, meta);
    asset_ids
        .iter()
        .map(|id| {
            let result = (|| -> std::result::Result<(), String> {
                let src = resolve_in_project(project_root, id)?;
                let dir = curated_todo
                    .clone()
                    .ok_or_else(|| "找不到「精选/待修」文件夹".to_string())?;
                if !src.is_file() {
                    return Err("源文件不存在或不可读".into());
                }
                let dst = dir.join(file_name_of(id));
                fs::create_dir_all(&dir).map_err(|e| format!("创建待修夹失败: {e}"))?;
                if dst.exists() {
                    return Err(format!(
                        "「待修」中已有同名文件,拒绝覆盖: {}",
                        dst.display()
                    ));
                }
                let tmp = dir.join(format!(".{}.curatepart", uuid::Uuid::new_v4()));
                fs::copy(&src, &tmp).map_err(|e| format!("复制失败: {e}"))?;
                fsx::rename_no_replace(&tmp, &dst).map_err(|e| {
                    let _ = fs::remove_file(&tmp);
                    if e.kind() == std::io::ErrorKind::AlreadyExists {
                        format!("「待修」中已有同名文件,拒绝覆盖: {}", dst.display())
                    } else {
                        format!("落位失败: {e}")
                    }
                })
            })();
            ItemOutcome {
                asset_id: id.clone(),
                result,
            }
        })
        .collect()
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

/// 回收站读取结果:实存记录 + 坏行数 + 孤儿文件(有实体无索引,不可恢复但必须可见)。
#[derive(Debug, Default)]
pub struct TrashList {
    pub records: Vec<TrashRecord>,
    pub skipped: usize,
    pub orphans: Vec<String>,
}

/// 读取回收站(以磁盘实存为准;索引坏行与孤儿文件都计数上报,零静默)。
/// stored_as 含分隔符/越界成分的行按坏行处理(索引是共享可写文件,不可信)。
pub fn list_trash(project_root: &Path) -> Result<TrashList> {
    let path = trash_index_path(project_root);
    let dir = trash_dir(project_root);
    let mut out = TrashList::default();
    let mut referenced: std::collections::HashSet<String> = Default::default();
    if path.exists() {
        let bytes = fs::read(&path)?;
        let text = String::from_utf8_lossy(&bytes);
        for line in text.lines() {
            match serde_json::from_str::<TrashRecord>(line) {
                Ok(rec) if valid_single_segment(&rec.stored_as) => {
                    referenced.insert(rec.stored_as.clone());
                    // 只报告仍实存的(恢复/清空后旧行残留属正常)
                    if dir.join(&rec.stored_as).is_file() {
                        out.records.retain(|r: &TrashRecord| r.id != rec.id);
                        out.records.push(rec);
                    }
                }
                _ => out.skipped += 1,
            }
        }
    }
    // 孤儿扫描:索引写失败且回滚失败的文件不能凭空消失(评审 H2)
    if let Ok(entries) = fs::read_dir(&dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name == TRASH_INDEX || name.starts_with('.') || !e.path().is_file() {
                continue;
            }
            if !referenced.contains(&name) {
                out.orphans.push(name);
            }
        }
    }
    out.orphans.sort();
    Ok(out)
}

/// 批量移入回收站(两段式删除的第二段;第一段是前端确认)。
/// 索引写失败时尝试回滚移动;回滚也失败时**如实报告文件滞留回收站**,
/// 该文件会以孤儿身份出现在 list_trash(评审 H2:不再假装已还原)。
pub fn trash_assets(project_root: &Path, asset_ids: &[String], operator: &str) -> Vec<ItemOutcome> {
    let dir = trash_dir(project_root);
    asset_ids
        .iter()
        .map(|id| {
            let result = (|| -> std::result::Result<(), String> {
                let src = resolve_in_project(project_root, id)?;
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
                    return match fsx::rename_no_replace(&dst, &src) {
                        Ok(()) => Err(format!("回收站索引写入失败,已还原文件: {e}")),
                        Err(rb) => Err(format!(
                            "回收站索引写入失败({e}),且文件还原失败({rb}):文件滞留在回收站目录「{stored_as}」,可在回收站的孤儿列表中找到"
                        )),
                    };
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
/// originalPath 来自共享索引文件,按不可信输入过路径闸(评审 F1)。
pub fn restore_from_trash(project_root: &Path, entry_ids: &[String]) -> Result<Vec<ItemOutcome>> {
    let list = list_trash(project_root)?;
    let dir = trash_dir(project_root);
    Ok(entry_ids
        .iter()
        .map(|eid| {
            let result = match list.records.iter().find(|r| &r.id == eid) {
                None => Err("回收站中找不到该条目".to_string()),
                Some(rec) => resolve_in_project(project_root, &rec.original_path)
                    .map_err(|e| format!("恢复目标路径非法(索引可能被篡改): {e}"))
                    .and_then(|dst| move_no_replace(&dir.join(&rec.stored_as), &dst)),
            };
            ItemOutcome {
                asset_id: eid.clone(),
                result,
            }
        })
        .collect())
}

/// 清空回收站的结果。
#[derive(Debug, Default)]
pub struct EmptyTrashOutcome {
    pub deleted: usize,
    pub failed: usize,
    /// 索引重写失败(文件删除结果不受影响;陈旧行会在下次列出/清空时自愈)。
    pub index_rewrite_error: Option<String>,
}

/// 清空回收站:**全应用唯一物理删除入口**。
/// 索引处理(评审 H3):只把**本轮成功删除**的行过滤掉,原子重写;
/// 并发机器在读取之后新追加的行,以及删除失败的行,原样保留。
/// 读取→重写之间仍有极小的并发追加窗口(无锁 NAS 的固有边界),
/// 窗口内丢的只是索引行,文件实体还在,会以孤儿形式可见,不会静默丢失。
pub fn empty_trash(project_root: &Path) -> Result<EmptyTrashOutcome> {
    let list = list_trash(project_root)?;
    let dir = trash_dir(project_root);
    let mut out = EmptyTrashOutcome::default();
    let mut deleted_ids: std::collections::HashSet<String> = Default::default();
    for rec in &list.records {
        match fs::remove_file(dir.join(&rec.stored_as)) {
            Ok(()) => {
                out.deleted += 1;
                deleted_ids.insert(rec.id.clone());
            }
            Err(_) => out.failed += 1,
        }
    }
    // 重写失败不吞掉删除结果:降级上报,陈旧行由「文件已不存在」过滤自愈
    if let Err(e) = rewrite_index_excluding(project_root, &deleted_ids) {
        out.index_rewrite_error = Some(e.to_string());
    }
    Ok(out)
}

/// 重写回收站索引,滤掉指定 id 的行;其余行(包括解析不了的坏行,
/// 以及实体仍存在的并发新行)逐字节保留。写入经唯一临时文件原子替换。
fn rewrite_index_excluding(
    project_root: &Path,
    exclude_ids: &std::collections::HashSet<String>,
) -> Result<()> {
    let path = trash_index_path(project_root);
    if !path.exists() {
        return Ok(());
    }
    let bytes = fs::read(&path)?;
    let text = String::from_utf8_lossy(&bytes);
    let mut kept = String::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let drop_line = serde_json::from_str::<TrashRecord>(line)
            .map(|rec| {
                // 已删除的行滤掉;此外顺带压缩掉「文件已不存在」的陈旧行
                exclude_ids.contains(&rec.id)
                    || (valid_single_segment(&rec.stored_as)
                        && !trash_dir(project_root).join(&rec.stored_as).is_file())
            })
            .unwrap_or(false); // 坏行保留:不销毁读不懂的数据
        if !drop_line {
            kept.push_str(line);
            kept.push('\n');
        }
    }
    if kept.is_empty() {
        fs::remove_file(&path)?;
        return Ok(());
    }
    let tmp = path.with_file_name(format!(".{}.indexpart", uuid::Uuid::new_v4()));
    fs::write(&tmp, kept.as_bytes())?;
    fs::rename(&tmp, &path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })?;
    Ok(())
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

    // ---------- 路径闸(评审 F1 要求的逃逸用例) ----------

    #[test]
    fn resolve_rejects_parent_dir_escape() {
        let (_t, root, _m) = setup_project();
        assert!(resolve_in_project(&root, "../外面.jpg").is_err());
        assert!(resolve_in_project(&root, "1. 待分类/../../外面.jpg").is_err());
    }

    #[test]
    fn resolve_rejects_absolute_and_prefix() {
        let (_t, root, _m) = setup_project();
        assert!(resolve_in_project(&root, "/etc/passwd").is_err());
        assert!(resolve_in_project(&root, "C:/Windows/system32").is_err());
        assert!(resolve_in_project(&root, "").is_err());
    }

    #[test]
    fn resolve_rejects_backslash() {
        let (_t, root, _m) = setup_project();
        assert!(resolve_in_project(&root, "..\\..\\外面.jpg").is_err());
        assert!(resolve_in_project(&root, "1. 待分类\\a.jpg").is_err());
    }

    #[test]
    fn resolve_rejects_dot_and_empty_segments() {
        let (_t, root, _m) = setup_project();
        assert!(resolve_in_project(&root, "./a.jpg").is_err());
        assert!(resolve_in_project(&root, "a//b.jpg").is_err());
        // 合法路径通过
        assert!(resolve_in_project(&root, &asset("a.jpg")).is_ok());
    }

    #[test]
    fn escape_attempts_fail_across_operations() {
        let (_t, root, _m) = setup_project();
        // 越界 id 在 move/trash/curate 里都必须逐项失败,不碰文件系统
        let meta = project::load_meta(&root).unwrap();
        let evil = vec!["../../受害者.jpg".to_string()];
        assert!(move_assets(&root, &evil, "2. 开幕式")[0].result.is_err());
        assert!(trash_assets(&root, &evil, "ZS")[0].result.is_err());
        assert!(curate_assets(&root, &meta, &evil)[0].result.is_err());
        // 分类夹本身越界也不行
        let out = move_assets(&root, &[asset("a.jpg")], "../别的项目");
        assert!(out[0].result.is_err());
        assert!(root.join(asset("a.jpg")).is_file(), "源文件不许被动过");
    }

    #[test]
    fn restore_rejects_tampered_original_path() {
        let (_t, root, _m) = setup_project();
        trash_assets(&root, &[asset("a.jpg")], "ZS");
        // 篡改索引:original_path 指向项目外
        let idx = trash_index_path(&root);
        let text = fs::read_to_string(&idx).unwrap();
        let tampered = text.replace("1. 待分类", "../越狱");
        fs::write(&idx, tampered).unwrap();
        let list = list_trash(&root).unwrap();
        assert_eq!(list.records.len(), 1);
        let restored = restore_from_trash(&root, &[list.records[0].id.clone()]).unwrap();
        let err = restored[0].result.as_ref().unwrap_err();
        assert!(err.contains("非法"), "错误要点名路径非法: {err}");
        // 文件仍安全地留在回收站
        assert_eq!(list_trash(&root).unwrap().records.len(), 1);
    }

    #[test]
    fn trash_index_with_traversal_stored_as_is_skipped() {
        let (_t, root, _m) = setup_project();
        fs::create_dir_all(trash_dir(&root)).unwrap();
        let rec = TrashRecord {
            id: "x".into(),
            file_name: "a.jpg".into(),
            size_bytes: 1,
            original_path: asset("a.jpg"),
            trashed_at: Utc::now(),
            operator: "ZS".into(),
            stored_as: "../../逃逸.jpg".into(),
        };
        append_trash_record(&root, &rec).unwrap();
        let list = list_trash(&root).unwrap();
        assert!(list.records.is_empty());
        assert_eq!(list.skipped, 1, "stored_as 越界的行按坏行计数");
    }

    // ---------- 分类 ----------

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
    fn category_named_like_reserved_words_is_not_misdetected() {
        // 评审 M1:旧版本创建的项目可能带「运动会精选」这类分类名
        // (新版创建入口已拒绝),角色判定必须按下标,不能被名字骗
        let tmp = tempdir().unwrap();
        let root = tmp.path().join("旧项目");
        let meta = project::ProjectMeta {
            name: "校运会".into(),
            date: NaiveDate::from_ymd_opt(2026, 8, 24).unwrap(),
            scenario: Scenario::B,
            categories: vec!["运动会精选".into(), "其他花絮".into()],
            created_at: Utc::now(),
            ocard_version: "test".into(),
        };
        for d in project::scenario_b_dirs(&meta.categories) {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        let cats = list_categories(&root, &meta).unwrap();
        let kinds: Vec<_> = cats.iter().map(|c| c.kind).collect();
        assert_eq!(kinds, vec!["inbox", "custom", "custom", "curated", "other"]);
        // 精选目录也从 meta 推导,不受相似名字干扰
        let todo = curated_todo_dir(&root, &meta).unwrap();
        assert!(todo.ends_with("4. 精选/待修"));
    }

    #[test]
    fn reserved_category_names_rejected_at_creation() {
        let tmp = tempdir().unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 8, 24).unwrap();
        for bad in ["精选", "运动会精选", "其他", "待分类", "a/b", ""] {
            let r = project::create_project(
                tmp.path(),
                date,
                "校运会",
                Scenario::B,
                &[bad.to_string()],
            );
            assert!(r.is_err(), "分类名「{bad}」应被拒绝");
        }
        // 只是包含、不以保留名结尾:合法
        assert!(project::create_project(
            tmp.path(),
            date,
            "校运会",
            Scenario::B,
            &["精选花絮".into()],
        )
        .is_ok());
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
        let (_t, root, meta) = setup_project();
        let out = curate_assets(&root, &meta, &[asset("b.jpg")]);
        assert!(out[0].result.is_ok());
        assert!(root.join(asset("b.jpg")).is_file(), "精选是复制,原件保留");
        assert!(root.join("4. 精选/待修/b.jpg").is_file());
        // 没有残留临时文件
        let leftovers: Vec<_> = fs::read_dir(root.join("4. 精选/待修"))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("curatepart"))
            .collect();
        assert!(leftovers.is_empty());
        // 重复精选:拒绝覆盖
        let out2 = curate_assets(&root, &meta, &[asset("b.jpg")]);
        assert!(out2[0].result.as_ref().unwrap_err().contains("拒绝覆盖"));
    }

    // ---------- 回收站 ----------

    #[test]
    fn trash_restore_roundtrip_and_empty_is_only_physical_delete() {
        let (_t, root, _m) = setup_project();
        let out = trash_assets(&root, &[asset("c.jpg")], "赵晋宇");
        assert!(out[0].result.is_ok());
        assert!(!root.join(asset("c.jpg")).exists());

        let list = list_trash(&root).unwrap();
        assert_eq!(list.records.len(), 1);
        assert_eq!(list.skipped, 0);
        assert!(list.orphans.is_empty());
        assert_eq!(list.records[0].original_path, asset("c.jpg"));
        assert_eq!(list.records[0].operator, "赵晋宇");

        // 恢复
        let restored = restore_from_trash(&root, &[list.records[0].id.clone()]).unwrap();
        assert!(restored[0].result.is_ok());
        assert!(root.join(asset("c.jpg")).is_file());
        assert!(list_trash(&root).unwrap().records.is_empty());

        // 再删一次并清空:物理删除
        trash_assets(&root, &[asset("c.jpg")], "赵晋宇");
        let out = empty_trash(&root).unwrap();
        assert_eq!((out.deleted, out.failed), (1, 0));
        assert!(list_trash(&root).unwrap().records.is_empty());
    }

    #[test]
    fn restore_refuses_overwrite() {
        let (_t, root, _m) = setup_project();
        trash_assets(&root, &[asset("a.jpg")], "ZS");
        // 原位置被新文件占据
        fs::write(root.join(asset("a.jpg")), b"new").unwrap();
        let list = list_trash(&root).unwrap();
        let restored = restore_from_trash(&root, &[list.records[0].id.clone()]).unwrap();
        assert!(restored[0]
            .result
            .as_ref()
            .unwrap_err()
            .contains("拒绝覆盖"));
        // 回收站里的文件安然无恙
        assert_eq!(list_trash(&root).unwrap().records.len(), 1);
    }

    #[test]
    fn empty_trash_preserves_concurrent_rows_from_other_machines() {
        // 评审 H3 的跨机用例:重写只滤掉本轮删除的行,别机新行原样保留
        let (_t, root, _m) = setup_project();
        trash_assets(&root, &[asset("a.jpg")], "A机");
        trash_assets(&root, &[asset("b.jpg")], "B机");
        let list = list_trash(&root).unwrap();
        let a_id = list
            .records
            .iter()
            .find(|r| r.operator == "A机")
            .unwrap()
            .id
            .clone();
        // 模拟:只删 A 的行(相当于 A 机读到快照后,B 机的行是并发新增)
        let mut only_a: std::collections::HashSet<String> = Default::default();
        only_a.insert(a_id);
        rewrite_index_excluding(&root, &only_a).unwrap();
        let after = list_trash(&root).unwrap();
        assert_eq!(after.records.len(), 1, "B 机的行必须幸存");
        assert_eq!(after.records[0].operator, "B机");
    }

    #[test]
    fn empty_trash_keeps_corrupt_lines() {
        let (_t, root, _m) = setup_project();
        trash_assets(&root, &[asset("a.jpg")], "ZS");
        // 追加一行坏数据:清空重写后必须原样保留(不销毁读不懂的数据)
        let idx = trash_index_path(&root);
        let mut text = fs::read_to_string(&idx).unwrap();
        text.push_str("{corrupt-not-json\n");
        fs::write(&idx, &text).unwrap();

        let out = empty_trash(&root).unwrap();
        assert_eq!((out.deleted, out.failed), (1, 0));
        assert!(out.index_rewrite_error.is_none());
        let text_after = fs::read_to_string(&idx).unwrap();
        assert!(text_after.contains("{corrupt-not-json"), "坏行不销毁");
        assert!(!text_after.contains("a.jpg"), "已删除的行要滤掉");
    }

    #[cfg(unix)]
    #[test]
    fn empty_trash_failed_delete_keeps_row_and_degrades() {
        use std::os::unix::fs::PermissionsExt;
        let (_t, root, _m) = setup_project();
        trash_assets(&root, &[asset("a.jpg")], "ZS");
        // 回收站目录只读:删除与索引重写都会失败,但必须降级不炸、行保留可重试
        let dir = trash_dir(&root);
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        let out = empty_trash(&root).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!((out.deleted, out.failed), (0, 1), "删不掉要如实计失败");
        let after = list_trash(&root).unwrap();
        assert_eq!(after.records.len(), 1, "删除失败的行必须保留可重试");
    }

    #[test]
    fn orphan_files_in_trash_are_visible() {
        let (_t, root, _m) = setup_project();
        fs::create_dir_all(trash_dir(&root)).unwrap();
        fs::write(trash_dir(&root).join("孤儿_x.jpg"), b"data").unwrap();
        let list = list_trash(&root).unwrap();
        assert_eq!(list.orphans, vec!["孤儿_x.jpg".to_string()]);
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
