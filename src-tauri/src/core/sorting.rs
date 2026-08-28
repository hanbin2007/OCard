//! 分类工作台核心(M2 任务2):分类移动、精选复制、回收站三件套。
//! 不变量:
//! - **路径闸**:一切外部传入的项目内相对路径(asset_ids、回收站索引里的
//!   original_path/stored_as)都是不可信输入,必须过 [`resolve_asset_in_project`]:
//!   词法拒越界(`..`、绝对路径、盘符、反斜杠)+ 拒符号链接成分 +
//!   素材命名空间白名单(挡 `.ocard`/「交付」等内部目录);
//! - **零覆盖**:任何移动/复制/恢复走 `fsx::rename_no_replace`/独占创建,
//!   目标已存在即失败该项,绝不替换(fsx 在极少数异构文件系统上的最后回退
//!   存在微秒级复查窗口,见 fsx 模块文档,属已声明边界);
//! - **两段式删除**:trash 只移入 `.ocard/trash`,`empty_trash` 是全应用唯一物理删除;
//!   索引为**纯追加**(记录行+墓碑行),永不重写——并发机器任何时刻 append 都不丢;
//! - 批量操作逐项返回结果(部分失败必须可表达,前端恢复失败项选中态)。

use super::journal::{self, Event};
use super::project::{self, Scenario, STATE_DIR};
use super::{copy, fsx, paths, CoreError, Result};
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
    let norm_root = paths::normalize_lexical(project_root);
    let joined = project_root.join(rel.split('/').collect::<PathBuf>());
    let normalized = paths::normalize_lexical(&joined);
    let root_key = paths::comparison_key(&norm_root);
    let key = paths::comparison_key(&normalized);
    if key == root_key || !key.starts_with(&root_key) {
        return Err(format!("路径越界(不在项目内): {rel}"));
    }
    // 词法闸之外还要挡符号链接(复验 P0):项目目录树在共享 NAS 上同样不可信,
    // 项目内一个指向外部的链接会让 rename/copy/delete 实际作用在项目外。
    // 逐段检查已存在的成分;不存在的尾段(目标落位名)无链接可言。
    let mut cur = norm_root.clone();
    let Ok(below) = normalized.strip_prefix(&norm_root) else {
        // 理论不可达(上面已断言前缀),但安全闸失配必须拒绝而非放行(复验 P2)
        return Err(format!("路径前缀解析异常,拒绝操作: {rel}"));
    };
    for comp in below.components() {
        cur.push(comp);
        match fs::symlink_metadata(&cur) {
            Ok(md) if md.file_type().is_symlink() => {
                return Err(format!("路径包含符号链接,拒绝操作: {rel}"));
            }
            _ => {}
        }
    }
    Ok(normalized)
}

/// 目标目录落地闸(复验轮二 P0 + 终审修复):委托 [`paths::ensure_dir_within`],
/// 闸在副作用之前(链接祖先下的缺失子目录不会先在项目外被创建)。
fn ensure_dir_in_project(project_root: &Path, dir: &Path) -> std::result::Result<(), String> {
    paths::ensure_dir_within(project_root, dir)
}

/// 回收站路径闸(终审 P0:回收站**源端**同样要设防)——
/// `.ocard/trash` 目录过落地闸,`index.jsonl` 拒符号链接。
/// list/trash/restore/empty 的一切回收站访问都从这里拿路径。
fn checked_trash_dir(project_root: &Path) -> std::result::Result<PathBuf, String> {
    let dir = trash_dir(project_root);
    ensure_dir_in_project(project_root, &dir)?;
    if paths::is_symlink(&dir.join(TRASH_INDEX)) {
        return Err("回收站索引是符号链接,拒绝操作".into());
    }
    Ok(dir)
}

/// 素材命名空间闸:asset id 的首段必须是工况 B 布局中的可见文件夹。
/// [`resolve_in_project`] 只保证「在项目内」,但项目内还有 `.ocard`(清单/日志/
/// 回收站)与「交付」等内部命名空间——分类/回收站操作绝不允许触碰(复验 P0)。
pub fn resolve_asset_in_project(
    project_root: &Path,
    meta: &project::ProjectMeta,
    rel: &str,
) -> std::result::Result<PathBuf, String> {
    if meta.scenario != Scenario::B {
        return Err("仅工况 B 项目支持分类/回收站操作".into());
    }
    let first = rel.split('/').next().unwrap_or("");
    let dirs = project::scenario_b_dirs(&meta.categories);
    if !dirs.iter().any(|d| d == first) {
        return Err(format!(
            "路径不在素材命名空间内(首段须是分类布局文件夹): {rel}"
        ));
    }
    resolve_in_project(project_root, rel)
}

/// 工况 A 素材命名空间闸(M3 复审 E1:转码源必须限定在工况 A 布局内,
/// 且实际只允许「2. 原始素材」与「3. 特别素材」两个素材夹)。
pub fn resolve_asset_a_in_project(
    project_root: &Path,
    meta: &project::ProjectMeta,
    rel: &str,
) -> std::result::Result<PathBuf, String> {
    if meta.scenario != Scenario::A {
        return Err("仅工况 A 项目支持转码素材路径".into());
    }
    let first = rel.split('/').next().unwrap_or("");
    let allowed = [project::SCENARIO_A_DIRS[1], project::SCENARIO_A_DIRS[2]];
    if !allowed.contains(&first) {
        return Err(format!(
            "路径不在工况 A 素材命名空间内(须位于 {} / {}): {rel}",
            allowed[0], allowed[1]
        ));
    }
    resolve_in_project(project_root, rel)
}

/// 「文件滞留回收站」的稳定标记:核心层报文与命令层升级判定共用,
/// 避免文案改动让 error 升级静默失效(复验 P2)。
pub const STRANDED_MARKER: &str = "滞留在回收站目录";

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

/// 分类夹里的素材计数(递归)。
///
/// 排除口径必须与**列表本身**同源([`copy::is_system_item`]):列表走
/// `copy::scan_source`(R11 起只排除明确列举的系统项),这里若还按「以点开头
/// 一律跳过」,`.clip.mov` 就会**在列表里看得见、却不算进角标计数**——
/// 用户看到「待分类 12」却数出 13 张,而两个数字都出自 OCard 自己。
///
/// 起点是**分类夹**(`project_root.join(folder)`,folder 出自
/// `scenario_b_dirs`),不是项目根:`.ocard/`(清单、日志、回收站、分析缓存)
/// 是项目根的同级兄弟,永远不在这棵树里,不可能被计数。
/// R13 D2:类型判定必须走 `DirEntry::file_type()`(**不解析链接**),不能用
/// `Path::is_dir()`(**跟随链接**)。此前「点开头一律跳过」这条旧规则恰好把
/// `.assets` 这类链接挡在外面,口径放宽到点开头也算素材之后就挡不住了:
/// 跟随一个指向祖先的链接会无限递归,指向项目外的链接会把外部文件算进角标,
/// 而正式扫描(`copy::scan_source`)从来不跟随链接——两个数字都出自 OCard,
/// 却对不上。链接一律跳过并计数,由 `commands::notice_scan_skips` 统一告警
/// (与其它扫描同口径,零静默)。
fn count_files(dir: &Path) -> usize {
    let mut n = 0usize;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = fs::read_dir(&d) else {
            continue;
        };
        for e in entries.flatten() {
            let name = e.file_name();
            if copy::is_system_item(&name.to_string_lossy()) {
                continue;
            }
            let Ok(ft) = e.file_type() else {
                continue;
            };
            if ft.is_symlink() {
                copy::note_symlink_skipped();
                continue;
            }
            if ft.is_dir() {
                stack.push(e.path());
            } else if ft.is_file() {
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
fn move_no_replace(project_root: &Path, src: &Path, dst: &Path) -> std::result::Result<(), String> {
    if !src.is_file() {
        return Err("源文件不存在或不可读".into());
    }
    if let Some(parent) = dst.parent() {
        ensure_dir_in_project(project_root, parent)?;
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
/// asset_ids 过素材命名空间闸,category_folder 过布局白名单+路径闸;
/// 调用方还需按分类角色白名单校验 category(拒 inbox/curated)。
pub fn move_assets(
    project_root: &Path,
    meta: &project::ProjectMeta,
    asset_ids: &[String],
    category_folder: &str,
) -> Vec<ItemOutcome> {
    let cat_dir = (|| {
        let dirs = project::scenario_b_dirs(&meta.categories);
        if !dirs.iter().any(|d| d == category_folder) {
            return Err(format!("目标不是分类布局文件夹: {category_folder}"));
        }
        resolve_in_project(project_root, category_folder)
    })();
    asset_ids
        .iter()
        .map(|id| {
            let result = (|| -> std::result::Result<(), String> {
                let src = resolve_asset_in_project(project_root, meta, id)?;
                let dir = cat_dir.clone()?;
                move_no_replace(project_root, &src, &dir.join(file_name_of(id)))
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
                let src = resolve_asset_in_project(project_root, meta, id)?;
                let dir = curated_todo
                    .clone()
                    .ok_or_else(|| "找不到「精选/待修」文件夹".to_string())?;
                if !src.is_file() {
                    return Err("源文件不存在或不可读".into());
                }
                let dst = dir.join(file_name_of(id));
                ensure_dir_in_project(project_root, &dir)?;
                if dst.exists() {
                    return Err(format!(
                        "「待修」中已有同名文件,拒绝覆盖: {}",
                        dst.display()
                    ));
                }
                let tmp = dir.join(format!(".{}.curatepart", uuid::Uuid::new_v4()));
                // R4(终审 P0-7):时间戳快照在读源之前采集;取不到计数可见
                let src_meta = fs::metadata(&src).ok();
                if src_meta.is_none() {
                    fsx::note_times_preserve_failures(1);
                }
                fs::copy(&src, &tmp).map_err(|e| format!("复制失败: {e}"))?;
                if let Some(m) = &src_meta {
                    fsx::preserve_times_counted(m, &tmp);
                }
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

fn append_index_line(project_root: &Path, line: String) -> std::result::Result<(), String> {
    let dir = checked_trash_dir(project_root)?;
    let mut line = line;
    line.push('\n');
    use std::io::Write;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(TRASH_INDEX))
        .map_err(|e| e.to_string())?;
    f.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

fn append_trash_record(project_root: &Path, rec: &TrashRecord) -> std::result::Result<(), String> {
    append_index_line(
        project_root,
        serde_json::to_string(rec).map_err(|e| e.to_string())?,
    )
}

/// 墓碑行:标记某条记录已终结(物理删除/已恢复)。索引因此是**纯追加**文件,
/// 彻底消灭「读取→重写」的并发蒸发窗口(codex 复验 P0/H3 根治)。
#[derive(Debug, Serialize, Deserialize)]
struct TrashTombstone {
    deleted: String,
}

fn append_tombstone(project_root: &Path, id: &str) -> std::result::Result<(), String> {
    append_index_line(
        project_root,
        serde_json::to_string(&TrashTombstone {
            deleted: id.to_string(),
        })
        .map_err(|e| e.to_string())?,
    )
}

/// 回收站读取结果:实存记录 + 坏行数 + 孤儿文件(有实体无索引,不可恢复但必须可见)。
#[derive(Debug, Default)]
pub struct TrashList {
    pub records: Vec<TrashRecord>,
    pub skipped: usize,
    pub orphans: Vec<String>,
}

/// 读取回收站(以磁盘实存为准;索引坏行与孤儿文件都计数上报,零静默)。
/// 索引是纯追加文件:记录行 + 墓碑行(见 [`TrashTombstone`]);同 id 后行覆盖前行,
/// 墓碑终结记录。stored_as 含分隔符/越界成分的行按坏行处理(共享可写文件,不可信)。
pub fn list_trash(project_root: &Path) -> Result<TrashList> {
    let dir = checked_trash_dir(project_root).map_err(CoreError::Invalid)?;
    let path = dir.join(TRASH_INDEX);
    let mut out = TrashList::default();
    // 折叠:id → 最后一条记录;墓碑集合另记
    let mut by_id: std::collections::HashMap<String, TrashRecord> = Default::default();
    let mut tombstoned: std::collections::HashSet<String> = Default::default();
    if path.exists() {
        let bytes = fs::read(&path)?;
        let text = String::from_utf8_lossy(&bytes);
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<TrashRecord>(line) {
                Ok(rec) if valid_single_segment(&rec.stored_as) => {
                    by_id.insert(rec.id.clone(), rec);
                }
                Ok(_) => out.skipped += 1,
                Err(_) => match serde_json::from_str::<TrashTombstone>(line) {
                    Ok(t) => {
                        tombstoned.insert(t.deleted);
                    }
                    Err(_) => out.skipped += 1,
                },
            }
        }
    }
    // 存活引用 = 未被墓碑终结的折叠记录;被覆盖/被终结的 stored_as 不占引用,
    // 其残留实体会以孤儿现身(复验:重复 id 篡改不再让实体凭空隐身)
    let mut referenced: std::collections::HashSet<String> = Default::default();
    for (id, rec) in &by_id {
        if !tombstoned.contains(id) {
            referenced.insert(rec.stored_as.clone());
            // 只报告仍实存的(索引写失败回滚/外部干预后旧行残留属正常)
            if dir.join(&rec.stored_as).is_file() {
                out.records.push(rec.clone());
            }
        }
    }
    out.records.sort_by_key(|r| std::cmp::Reverse(r.trashed_at));
    // 孤儿扫描:索引写失败且回滚失败的文件不能凭空消失(评审 H2)
    //
    // 排除口径同样收口到 [`copy::is_system_item`](R12)。这一处的方向与别处相反
    // 但结论一致:孤儿扫描存在的意义就是**不让回收站里的文件凭空隐身**,所以判据
    // 越窄越好。按「以点开头」跳过,会让一个被手工丢进 `.ocard/trash` 的 `.clip.mov`
    // 既不在索引里、也不上报为孤儿——用户永远看不到它,直到清空回收站把它删掉。
    // (扫的是 `.ocard/trash` 的**直接子项**,名字形如 `<uuid>_<原名>`;
    // `.ocard` 本身是这个目录的祖先而非子项,不需要也轮不到这条判据来挡。)
    if let Ok(entries) = fs::read_dir(&dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name == TRASH_INDEX || copy::is_system_item(&name) || !e.path().is_file() {
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
pub fn trash_assets(
    project_root: &Path,
    meta: &project::ProjectMeta,
    asset_ids: &[String],
    operator: &str,
) -> Vec<ItemOutcome> {
    asset_ids
        .iter()
        .map(|id| {
            let result = (|| -> std::result::Result<(), String> {
                let src = resolve_asset_in_project(project_root, meta, id)?;
                let meta = fs::metadata(&src).map_err(|_| "源文件不存在或不可读".to_string())?;
                let dir = checked_trash_dir(project_root)?;
                let rec_id = uuid::Uuid::new_v4().to_string();
                let stored_as = format!("{rec_id}_{}", file_name_of(id));
                let dst = dir.join(&stored_as);
                move_no_replace(project_root, &src, &dst)?;
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

/// 恢复结果:逐项 + 墓碑写失败数(实体已回原位,行会被实存过滤隐藏,
/// 但失败必须上报——纯追加索引的完整性靠墓碑,复验 P2)。
#[derive(Debug, Default)]
pub struct RestoreOutcome {
    pub items: Vec<ItemOutcome>,
    pub tombstone_errors: usize,
}

/// 恢复:按 originalPath 放回,零覆盖。
/// originalPath 来自共享索引文件,按不可信输入过素材命名空间闸(评审 F1 + 复验 P0)。
pub fn restore_from_trash(
    project_root: &Path,
    meta: &project::ProjectMeta,
    entry_ids: &[String],
) -> Result<RestoreOutcome> {
    let list = list_trash(project_root)?;
    let dir = checked_trash_dir(project_root).map_err(CoreError::Invalid)?;
    let mut out = RestoreOutcome::default();
    for eid in entry_ids {
        let result = match list.records.iter().find(|r| &r.id == eid) {
            None => Err("回收站中找不到该条目".to_string()),
            Some(rec) => resolve_asset_in_project(project_root, meta, &rec.original_path)
                .map_err(|e| format!("恢复目标路径非法(索引可能被篡改): {e}"))
                .and_then(|dst| move_no_replace(project_root, &dir.join(&rec.stored_as), &dst))
                .inspect(|_| {
                    if append_tombstone(project_root, eid).is_err() {
                        out.tombstone_errors += 1;
                    }
                }),
        };
        out.items.push(ItemOutcome {
            asset_id: eid.clone(),
            result,
        });
    }
    Ok(out)
}

/// 清空回收站的结果。
#[derive(Debug, Default)]
pub struct EmptyTrashOutcome {
    pub deleted: usize,
    pub failed: usize,
    /// 墓碑追加失败(文件删除结果不受影响;无墓碑的陈旧行由实存过滤兜住)。
    pub index_rewrite_error: Option<String>,
}

/// 清空回收站:**全应用唯一物理删除入口**。
/// 索引处理(评审 H3 根治):删除成功即追加墓碑行——索引纯追加,永不重写,
/// 并发机器随时 append 都不会被蒸发;删除失败的行原样保留可重试。
/// 索引因此单调增长,属可接受成本(内部工具、行级体量);压缩归 M3。
pub fn empty_trash(project_root: &Path) -> Result<EmptyTrashOutcome> {
    let list = list_trash(project_root)?;
    let dir = checked_trash_dir(project_root).map_err(CoreError::Invalid)?;
    let mut out = EmptyTrashOutcome::default();
    let mut tombstone_errors = 0usize;
    for rec in &list.records {
        match fs::remove_file(dir.join(&rec.stored_as)) {
            Ok(()) => {
                out.deleted += 1;
                if let Err(e) = append_tombstone(project_root, &rec.id) {
                    tombstone_errors += 1;
                    out.index_rewrite_error = Some(e);
                }
            }
            Err(_) => out.failed += 1,
        }
    }
    if tombstone_errors > 0 {
        out.index_rewrite_error = Some(format!(
            "{tombstone_errors} 条删除标记写入失败: {}",
            out.index_rewrite_error.take().unwrap_or_default()
        ));
    }
    Ok(out)
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

    // ---------- 路径闸(评审 F1 + 复验 P0 的逃逸用例) ----------

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
    fn namespace_gate_blocks_internal_dirs() {
        // 复验 P0:.ocard(清单/日志/回收站)与「交付」不许被分类/回收站操作触碰
        let (_t, root, meta) = setup_project();
        fs::create_dir_all(root.join("交付")).unwrap();
        fs::write(root.join("交付/清单.txt"), b"x").unwrap();
        let manifest_like = root.join(".ocard/manifests/m.json");
        fs::write(&manifest_like, b"{}").unwrap();

        for evil in [".ocard/manifests/m.json", "交付/清单.txt"] {
            let evil = vec![evil.to_string()];
            assert!(
                trash_assets(&root, &meta, &evil, "ZS")[0].result.is_err(),
                "{evil:?} 不许进回收站"
            );
            assert!(move_assets(&root, &meta, &evil, "2. 开幕式")[0]
                .result
                .is_err());
            assert!(curate_assets(&root, &meta, &evil)[0].result.is_err());
        }
        assert!(manifest_like.is_file(), "内部文件必须原地未动");
        assert!(root.join("交付/清单.txt").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_inside_project_cannot_reach_outside() {
        // 复验 P0:项目内符号链接不许把操作带出项目
        let (tmp, root, meta) = setup_project();
        let outside = tmp.path().join("外部仓库");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("victim.jpg"), b"precious").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("1. 待分类/link")).unwrap();

        let via_link = vec!["1. 待分类/link/victim.jpg".to_string()];
        assert!(trash_assets(&root, &meta, &via_link, "ZS")[0]
            .result
            .is_err());
        assert!(move_assets(&root, &meta, &via_link, "2. 开幕式")[0]
            .result
            .is_err());
        assert!(curate_assets(&root, &meta, &via_link)[0].result.is_err());
        assert!(
            outside.join("victim.jpg").is_file(),
            "项目外文件必须安然无恙"
        );
        assert!(
            !root.join("4. 精选/待修/victim.jpg").exists(),
            "不许经链接复制进项目"
        );
    }

    #[test]
    fn escape_attempts_fail_and_victim_survives() {
        // 复验 P2:受害者真实存在,砍掉任何一道闸测试都必须红
        let (tmp, root, meta) = setup_project();
        fs::write(tmp.path().join("受害者.jpg"), b"outside").unwrap();
        let evil = vec!["../受害者.jpg".to_string()];
        assert!(move_assets(&root, &meta, &evil, "2. 开幕式")[0]
            .result
            .is_err());
        assert!(trash_assets(&root, &meta, &evil, "ZS")[0].result.is_err());
        assert!(curate_assets(&root, &meta, &evil)[0].result.is_err());
        assert_eq!(
            fs::read(tmp.path().join("受害者.jpg")).unwrap(),
            b"outside",
            "项目外文件不许被动"
        );
        assert!(!root.join("2. 开幕式/受害者.jpg").exists());
        assert!(!root.join("4. 精选/待修/受害者.jpg").exists());
        // 分类夹参数越界也不行
        let out = move_assets(&root, &meta, &[asset("a.jpg")], "../别的项目");
        assert!(out[0].result.is_err());
        assert!(root.join(asset("a.jpg")).is_file(), "源文件不许被动过");
    }

    #[test]
    fn restore_rejects_tampered_original_path() {
        let (_t, root, meta) = setup_project();
        trash_assets(&root, &meta, &[asset("a.jpg")], "ZS");
        // 篡改索引:original_path 指向项目外
        let idx = trash_dir(&root).join(TRASH_INDEX);
        let text = fs::read_to_string(&idx).unwrap();
        let tampered = text.replace("1. 待分类", "../越狱");
        fs::write(&idx, tampered).unwrap();
        let list = list_trash(&root).unwrap();
        assert_eq!(list.records.len(), 1);
        let restored = restore_from_trash(&root, &meta, &[list.records[0].id.clone()]).unwrap();
        let err = restored.items[0].result.as_ref().unwrap_err();
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
    fn scenario_a_namespace_gate() {
        // 评审 #13:resolve_asset_a_in_project 零测试 → 补齐
        let tmp = tempdir().unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 8, 24).unwrap();
        let root = project::create_project(tmp.path(), date, "晚会", Scenario::A, &[]).unwrap();
        let meta = project::load_meta(&root).unwrap();
        fs::create_dir_all(root.join("2. 原始素材/cam")).unwrap();
        fs::write(root.join("2. 原始素材/cam/v.mp4"), b"v").unwrap();

        assert!(resolve_asset_a_in_project(&root, &meta, "2. 原始素材/cam/v.mp4").is_ok());
        assert!(resolve_asset_a_in_project(&root, &meta, "3. 特别素材/x.mp4").is_ok());
        // 素材夹之外的一律拒(成片/工程文件/内部区/逃逸)
        for bad in [
            "6. 成片/a.mp4",
            "1. 工程文件/p.prproj",
            ".ocard/manifests/m.json",
            "../外面.mp4",
            "2. 原始素材/../6. 成片/a.mp4",
        ] {
            assert!(
                resolve_asset_a_in_project(&root, &meta, bad).is_err(),
                "{bad} 必须被拒"
            );
        }
        // 工况 B 项目走 A 闸必须拒
        let (_t2, broot, bmeta) = setup_project();
        assert!(resolve_asset_a_in_project(&broot, &bmeta, "2. 原始素材/x.mp4").is_err());
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
        for bad in [
            "精选",
            "运动会精选",
            "其他",
            "待分类",
            "a/b",
            "",
            "CON",
            "nul.txt",
        ] {
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
        let (_t, root, meta) = setup_project();
        let out = move_assets(&root, &meta, &[asset("a.jpg")], "2. 开幕式");
        assert!(out[0].result.is_ok());
        assert!(root.join("2. 开幕式/a.jpg").is_file());
        assert!(!root.join(asset("a.jpg")).exists());

        // 再放一个同名的进待分类,移动必须拒绝覆盖
        fs::write(root.join(asset("a.jpg")), vec![9u8; 50]).unwrap();
        let out2 = move_assets(&root, &meta, &[asset("a.jpg")], "2. 开幕式");
        assert!(out2[0].result.as_ref().unwrap_err().contains("拒绝覆盖"));
        assert_eq!(
            fs::read(root.join("2. 开幕式/a.jpg")).unwrap(),
            vec![7u8; 100]
        );
    }

    #[test]
    fn curate_copies_and_original_stays() {
        let (_t, root, meta) = setup_project();
        // R2 变异复核:精选复制也要保留源时间戳。
        // R3 声明:生产路径用 fs::copy 落临时文件,macOS 的 fs::copy 本身克隆
        // 时间戳——本断言在 macOS 恒真,判别力由 CI 三平台矩阵的 Linux/Windows
        // 腿提供(删 preserve_times_counted 在那两腿必红)。
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(86400 * 30);
        let f = fs::OpenOptions::new()
            .write(true)
            .open(root.join(asset("b.jpg")))
            .unwrap();
        f.set_times(fs::FileTimes::new().set_modified(old)).unwrap();
        drop(f);
        let out = curate_assets(&root, &meta, &[asset("b.jpg")]);
        assert!(out[0].result.is_ok());
        assert!(root.join(asset("b.jpg")).is_file(), "精选是复制,原件保留");
        assert!(root.join("4. 精选/待修/b.jpg").is_file());
        let dm = fs::metadata(root.join("4. 精选/待修/b.jpg"))
            .unwrap()
            .modified()
            .unwrap();
        let diff = dm
            .duration_since(old)
            .unwrap_or_else(|e| e.duration())
            .as_secs();
        assert!(diff <= 2, "精选产物 mtime 必须保留源值(差 {diff}s)");
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

    // ---------- 回收站(纯追加索引 + 墓碑) ----------

    #[test]
    fn trash_restore_roundtrip_and_empty_is_only_physical_delete() {
        let (_t, root, meta) = setup_project();
        let out = trash_assets(&root, &meta, &[asset("c.jpg")], "赵晋宇");
        assert!(out[0].result.is_ok());
        assert!(!root.join(asset("c.jpg")).exists());

        let list = list_trash(&root).unwrap();
        assert_eq!(list.records.len(), 1);
        assert_eq!(list.skipped, 0);
        assert!(list.orphans.is_empty());
        assert_eq!(list.records[0].original_path, asset("c.jpg"));
        assert_eq!(list.records[0].operator, "赵晋宇");

        // 恢复:文件回原位,墓碑终结索引行
        let restored = restore_from_trash(&root, &meta, &[list.records[0].id.clone()]).unwrap();
        assert!(restored.items[0].result.is_ok());
        assert_eq!(restored.tombstone_errors, 0);
        assert!(root.join(asset("c.jpg")).is_file());
        assert!(list_trash(&root).unwrap().records.is_empty());
        let text = fs::read_to_string(trash_dir(&root).join(TRASH_INDEX)).unwrap();
        assert!(text.contains("deleted"), "恢复成功要落墓碑");

        // 再删一次并清空:物理删除 + 墓碑,索引永不重写
        trash_assets(&root, &meta, &[asset("c.jpg")], "赵晋宇");
        let out = empty_trash(&root).unwrap();
        assert_eq!((out.deleted, out.failed), (1, 0));
        assert!(out.index_rewrite_error.is_none());
        assert!(list_trash(&root).unwrap().records.is_empty());
    }

    #[test]
    fn restore_refuses_overwrite() {
        let (_t, root, meta) = setup_project();
        trash_assets(&root, &meta, &[asset("a.jpg")], "ZS");
        // 原位置被新文件占据
        fs::write(root.join(asset("a.jpg")), b"new").unwrap();
        let list = list_trash(&root).unwrap();
        let restored = restore_from_trash(&root, &meta, &[list.records[0].id.clone()]).unwrap();
        assert!(restored.items[0]
            .result
            .as_ref()
            .unwrap_err()
            .contains("拒绝覆盖"));
        // 回收站里的文件安然无恙,且失败不落墓碑
        assert_eq!(list_trash(&root).unwrap().records.len(), 1);
    }

    #[test]
    fn empty_trash_never_rewrites_concurrent_appends_survive() {
        // H3 根治断言:清空前后,索引里既有行只增不减(纯追加)
        let (_t, root, meta) = setup_project();
        trash_assets(&root, &meta, &[asset("a.jpg")], "A机");
        let idx = trash_dir(&root).join(TRASH_INDEX);
        let before = fs::read_to_string(&idx).unwrap();

        // 模拟并发:另一台机器在清空进行前追加了一条记录+实体
        fs::write(trash_dir(&root).join("bb_b.jpg"), b"bb").unwrap();
        let concurrent = TrashRecord {
            id: "bb".into(),
            file_name: "b.jpg".into(),
            size_bytes: 2,
            original_path: asset("b.jpg"),
            trashed_at: Utc::now(),
            operator: "B机".into(),
            stored_as: "bb_b.jpg".into(),
        };
        append_trash_record(&root, &concurrent).unwrap();

        let out = empty_trash(&root).unwrap();
        assert_eq!(out.deleted, 2, "两条实存记录都被清空");
        let after = fs::read_to_string(&idx).unwrap();
        assert!(
            after.starts_with(&before),
            "索引必须纯追加:旧内容原样保留为前缀"
        );
        assert!(after.contains("bb"), "并发行原样保留");
        assert!(list_trash(&root).unwrap().records.is_empty());
    }

    #[test]
    fn empty_trash_keeps_corrupt_lines() {
        let (_t, root, meta) = setup_project();
        trash_assets(&root, &meta, &[asset("a.jpg")], "ZS");
        let idx = trash_dir(&root).join(TRASH_INDEX);
        let mut text = fs::read_to_string(&idx).unwrap();
        text.push_str("{corrupt-not-json\n");
        fs::write(&idx, &text).unwrap();

        let out = empty_trash(&root).unwrap();
        assert_eq!((out.deleted, out.failed), (1, 0));
        let text_after = fs::read_to_string(&idx).unwrap();
        assert!(text_after.contains("{corrupt-not-json"), "坏行不销毁");
        assert_eq!(list_trash(&root).unwrap().skipped, 1);
        assert!(list_trash(&root).unwrap().records.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn empty_trash_failed_delete_keeps_row_and_degrades() {
        use std::os::unix::fs::PermissionsExt;
        let (_t, root, meta) = setup_project();
        trash_assets(&root, &meta, &[asset("a.jpg")], "ZS");
        // 回收站目录只读:删除失败必须降级不炸、行保留可重试
        let dir = trash_dir(&root);
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        let out = empty_trash(&root).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!((out.deleted, out.failed), (0, 1), "删不掉要如实计失败");
        let after = list_trash(&root).unwrap();
        assert_eq!(after.records.len(), 1, "删除失败的行必须保留可重试");
    }

    #[test]
    fn duplicate_id_tampering_leaves_entity_visible_as_orphan() {
        // 复验:同 id 两条不同 stored_as 的篡改行,被覆盖的实体必须以孤儿现身
        let (_t, root, meta) = setup_project();
        trash_assets(&root, &meta, &[asset("a.jpg")], "ZS");
        let list = list_trash(&root).unwrap();
        let rec = &list.records[0];
        // 追加一条同 id 但 stored_as 指向别处的行(后行覆盖前行)
        let mut shadow = rec.clone();
        shadow.stored_as = "影子_x.jpg".into();
        fs::write(trash_dir(&root).join("影子_x.jpg"), b"shadow").unwrap();
        append_trash_record(&root, &shadow).unwrap();

        let after = list_trash(&root).unwrap();
        assert_eq!(after.records.len(), 1);
        assert_eq!(after.records[0].stored_as, "影子_x.jpg");
        assert_eq!(
            after.orphans,
            vec![rec.stored_as.clone()],
            "被覆盖的原实体不许凭空隐身"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_target_dirs_are_refused() {
        // 复验轮二 P0:目标目录(精选/待修、.ocard/trash)被换成指向项目外的
        // 链接时,写入必须被 canonicalize 闸拒绝
        let (tmp, root, meta) = setup_project();
        let outside = tmp.path().join("外部落点");
        fs::create_dir_all(&outside).unwrap();

        // 精选/待修 → 链接
        let curated_todo = root.join("4. 精选/待修");
        fs::remove_dir_all(&curated_todo).ok();
        std::os::unix::fs::symlink(&outside, &curated_todo).unwrap();
        let out = curate_assets(&root, &meta, &[asset("a.jpg")]);
        assert!(out[0].result.as_ref().unwrap_err().contains("符号链接"));
        assert!(
            fs::read_dir(&outside).unwrap().next().is_none(),
            "不许写进外部"
        );

        // .ocard/trash → 链接
        let tdir = trash_dir(&root);
        fs::create_dir_all(tdir.parent().unwrap()).unwrap();
        fs::remove_dir_all(&tdir).ok();
        std::os::unix::fs::symlink(&outside, &tdir).unwrap();
        let out = trash_assets(&root, &meta, &[asset("a.jpg")], "ZS");
        assert!(out[0].result.as_ref().unwrap_err().contains("符号链接"));
        // 终审 P0:回收站源端(list/empty)对被换链接的 trash 也 fail-closed
        assert!(
            list_trash(&root).is_err(),
            "list_trash 对链接 trash 必须拒绝"
        );
        assert!(
            empty_trash(&root).is_err(),
            "empty_trash 对链接 trash 必须拒绝"
        );
        assert!(root.join(asset("a.jpg")).is_file(), "源文件原地未动");
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
    }

    #[test]
    fn scenario_a_project_rejects_sorting_ops() {
        // 复验轮二:工况 A 的拒绝分支要有测试钉住
        let tmp = tempdir().unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 8, 24).unwrap();
        let root = project::create_project(tmp.path(), date, "婚礼", Scenario::A, &[]).unwrap();
        let meta = project::load_meta(&root).unwrap();
        fs::write(root.join("2. 原始素材/x.jpg"), b"x").unwrap();
        let ids = vec!["2. 原始素材/x.jpg".to_string()];
        assert!(trash_assets(&root, &meta, &ids, "ZS")[0].result.is_err());
        assert!(move_assets(&root, &meta, &ids, "2. 原始素材")[0]
            .result
            .is_err());
        assert!(root.join("2. 原始素材/x.jpg").is_file());
    }

    #[test]
    fn orphan_files_in_trash_are_visible() {
        let (_t, root, _m) = setup_project();
        fs::create_dir_all(trash_dir(&root)).unwrap();
        fs::write(trash_dir(&root).join("孤儿_x.jpg"), b"data").unwrap();
        let list = list_trash(&root).unwrap();
        assert_eq!(list.orphans, vec!["孤儿_x.jpg".to_string()]);
    }

    // ---------- R12:NAS 侧三条路径统一到 copy::is_system_item ----------

    /// 分类计数与列表必须同一把尺子:列表(`copy::scan_source`)会列出
    /// `.clip.mov`,角标计数就必须把它算进去,否则用户看到「12」却数出 13。
    /// 反过来,系统项(`.DS_Store`、群晖 `@eaDir`)不许把计数灌水。
    ///
    /// **`.ocard` 这条比什么都重要**:项目自己的元数据被当成素材,轻则计数说谎,
    /// 重则顺着同一份口径被打进交付包发给客户。这里把 `.ocard` 直接种进分类夹
    /// 内部(生产布局里它是项目根的兄弟,种进来是为了直接考共享名单的前缀项),
    /// 断言一个都数不出来。
    ///
    /// 变异:把 `count_files` 的判据改回 `name.starts_with('.')` → `.clip.mov`
    /// 与 `.素材夹/b.jpg` 数不到(11 != 13),本测试红。
    #[test]
    fn category_count_matches_the_listing_and_never_counts_ocard() {
        let (_t, root, meta) = setup_project();
        let inbox = root.join("1. 待分类");
        // 点开头的合法素材:必须算进计数。
        // 数量刻意多于下面「不以点开头的系统项」,两种错误才不会正好抵消
        // (变异验证跑出来过一次:漏数 2 个素材 + 多数 2 个垃圾 = 总数不变)
        fs::write(inbox.join(".clip.mov"), b"legit").unwrap();
        fs::write(inbox.join(".DSC0002.ARW"), b"legit").unwrap();
        fs::create_dir_all(inbox.join(".素材夹")).unwrap();
        fs::write(inbox.join(".素材夹/b.jpg"), b"legit").unwrap();
        // 系统项:不许算进计数
        fs::write(inbox.join(".DS_Store"), b"junk").unwrap();
        fs::write(inbox.join("._.clip.mov"), b"junk").unwrap();
        fs::create_dir_all(inbox.join("@eaDir")).unwrap();
        fs::write(inbox.join("@eaDir/SYNOPHOTO_THUMB_M.jpg"), b"junk").unwrap();
        fs::create_dir_all(inbox.join(".Trashes")).unwrap();
        fs::write(inbox.join(".Trashes/deleted.jpg"), b"junk").unwrap();
        // 本工具自己落下的半截文件:内容不完整,不是素材
        fs::write(inbox.join("C0001.MP4.tag.ocardpart"), b"half").unwrap();
        // 项目元数据:一个都不许数出来
        fs::create_dir_all(inbox.join(".ocard/manifests")).unwrap();
        fs::write(inbox.join(".ocard/manifests/m.json"), b"{}").unwrap();
        fs::write(inbox.join(".ocard/settings.json"), b"{}").unwrap();
        fs::create_dir_all(inbox.join(".ocard/trash")).unwrap();
        fs::write(inbox.join(".ocard/trash/已删.jpg"), b"deleted").unwrap();
        fs::write(inbox.join(".ocard-volume-id"), b"id").unwrap();

        let cats = list_categories(&root, &meta).unwrap();
        // setup 的 3 张 + `.clip.mov` + `.DSC0002.ARW` + `.素材夹/b.jpg`
        assert_eq!(cats[0].count, 6, "点开头的素材必须算进计数,系统项不许算");

        // 与列表口径一致:同一棵树用 copy::scan_source 数出来必须是同一个数
        let listed = copy::scan_source(&inbox).unwrap();
        let _ = copy::take_scan_system_skipped();
        assert_eq!(
            listed.len(),
            cats[0].count,
            "角标计数与列表必须同源: {:?}",
            listed.iter().map(|f| &f.rel).collect::<Vec<_>>()
        );
        assert!(
            !listed.iter().any(|f| f.rel.contains(".ocard")),
            "`.ocard` 绝不许出现在素材列表里: {:?}",
            listed.iter().map(|f| &f.rel).collect::<Vec<_>>()
        );
    }

    /// 回收站孤儿扫描:方向与别处相反但结论一致——判据越窄越好。
    /// 被手工丢进 `.ocard/trash` 的 `.clip.mov` 既不在索引里、也不上报为孤儿,
    /// 就等于让它凭空隐身,直到清空回收站把它删掉(零静默要堵的正是这个)。
    ///
    /// 变异:改回 `name.starts_with('.')` → `.clip.mov` 不再上报,本测试红。
    #[test]
    fn trash_orphan_scan_surfaces_dot_prefixed_files_but_not_system_items() {
        let (_t, root, _m) = setup_project();
        let dir = trash_dir(&root);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(".clip.mov"), b"legit").unwrap();
        fs::write(dir.join(".DS_Store"), b"junk").unwrap();
        fs::write(dir.join("._孤儿_x.jpg"), b"junk").unwrap();
        fs::write(dir.join(".9f1c-0000.curatepart"), b"half").unwrap();
        let list = list_trash(&root).unwrap();
        assert_eq!(
            list.orphans,
            vec![".clip.mov".to_string()],
            "点开头的素材必须以孤儿身份可见,系统项/半截文件不许刷屏"
        );
    }

    #[test]
    fn bulk_partial_failure_is_expressed() {
        let (_t, root, meta) = setup_project();
        let out = move_assets(
            &root,
            &meta,
            &[asset("a.jpg"), "1. 待分类/不存在.jpg".to_string()],
            "3. 比赛",
        );
        assert!(out[0].result.is_ok());
        assert!(out[1].result.is_err());
    }
}
