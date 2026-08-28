//! 拷卡引擎:单次读源、并行写多目的地、xxh3 校验、断点续传。
//!
//! 可靠性设计(PRD §5.3 / §6.4):
//! - 写入始终先落 `.ocardpart` 临时名,回读校验通过后才改名——NAS 断连不会留半个文件;
//! - 每完成一个文件就持久化 manifest,任务中断后按 manifest 续拷;
//! - 单文件失败只标记该文件,不作废整个任务。

use super::hash;
use super::manifest::{self, CopyManifest, ManifestEntry};
use super::Result;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const BUF_SIZE: usize = 4 * 1024 * 1024;
const PART_SUFFIX: &str = ".ocardpart";

#[derive(Debug, Clone)]
pub struct CopyRequest {
    /// 源(存储卡挂载点或其子目录)。
    pub source_root: PathBuf,
    /// 目的地:各「拷卡目标文件夹」绝对路径(NAS 主 + 备份盘),≥1 个。
    pub destinations: Vec<PathBuf>,
    /// 任务标识:让临时文件名任务唯一,杜绝跨任务/跨工作站同写一个 part 文件。
    pub task_tag: String,
    /// 本次任务的源选择口径。清单是可被篡改的持久化输入,引擎按它复核每一项
    /// 的源路径是否在用户当初勾选的范围内(整卷则要求源=目标),不符即拒。
    pub selection: SourceSelection,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FileStatus {
    /// 本次拷贝并校验通过。
    Copied,
    /// manifest 中已验证,断点续传跳过。
    SkippedResume,
    Failed(String),
}

#[derive(Debug, Clone)]
pub struct FileReport {
    /// **目标**相对路径(= manifest 与快照的文件标识)。
    pub rel_path: String,
    /// 源在卷内的相对路径(整卷时与 `rel_path` 相同);失败审计要点名卡上的真实文件。
    pub source_rel: String,
    pub size: u64,
    pub status: FileStatus,
}

#[derive(Debug)]
pub struct CopyOutcome {
    pub files: Vec<FileReport>,
    pub bytes_copied: u64,
    /// 全部文件均已验证(含续传跳过的)。为 true 才提示「本卡可格式化」。
    pub all_verified: bool,
    /// 因暂停请求提前停止(文件边界处停,manifest 可续传)。
    pub paused: bool,
}

/// 进度事件里的 `rel_path` 一律是**目标**相对路径:它同时是 manifest 键与
/// UI 快照的文件 id,扁平化改名后也只有它能把三边对上号。
#[derive(Debug)]
pub enum Progress<'a> {
    Scanned {
        total_files: usize,
        total_bytes: u64,
    },
    FileStarted {
        rel_path: &'a str,
        index: usize,
        total: usize,
    },
    /// 单文件内的增量字节(每个读写块回调一次,大文件进度靠它)。
    BytesCopied { rel_path: &'a str, delta: u64 },
    FileFinished {
        rel_path: &'a str,
        status: &'a FileStatus,
    },
}

/// 进度回调的返回值:在文件边界处响应暂停请求。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyControl {
    Continue,
    Pause,
}

thread_local! {
    /// 扫描期跳过的符号链接计数(R2 P0:`metadata()` 跟随链接会把卡外目录树
    /// 卷进拷贝清单,甚至链接环死循环)。零静默:命令层取走后聚合为可见 warning。
    ///
    /// **按线程**计数(双路评审):扫描与随后的 take 永远在同一个命令函数体里,
    /// 而进程级全局计数会被并发的另一次扫描抢走——浏览文件夹时顺手偷走拷卡的
    /// 跳过数,拷卡那条告警就静默消失了,正是零静默要堵的洞。
    static SCAN_SYMLINKS_SKIPPED: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

fn note_symlink_skipped() {
    SCAN_SYMLINKS_SKIPPED.with(|c| c.set(c.get() + 1));
}

/// 取走本线程扫描期的符号链接跳过数(取走即清零)。
pub fn take_scan_symlinks_skipped() -> u64 {
    SCAN_SYMLINKS_SKIPPED.with(|c| c.replace(0))
}

/// 源选择:整盘,或卡内若干文件夹(只取各自的**直接子文件**,不递归)。
///
/// DIT 常见诉求是「只要 100MSDCF 和 CLIP 里的素材」,而不是整张卡;
/// 且落到目标夹时不要相机那层目录名。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceSelection {
    /// 整盘递归(历史行为,保留目录结构)
    WholeVolume,
    /// 选中的文件夹(相对卷根、`/` 分隔;空串代表卷根自身)。
    /// 只取每个文件夹下的直接子文件,子目录需要另行勾选。
    Folders(Vec<String>),
}

impl SourceSelection {
    /// 空列表 = 整卷(契约:前端不传/传空数组都按整卷处理,老客户端行为不变)。
    pub fn from_folders(folders: Vec<String>) -> Self {
        if folders.is_empty() {
            Self::WholeVolume
        } else {
            Self::Folders(folders)
        }
    }

    /// 持久化形态(manifest 审计用):整卷 = 空列表。
    pub fn to_folders(&self) -> Vec<String> {
        match self {
            Self::WholeVolume => Vec::new(),
            Self::Folders(f) => f.clone(),
        }
    }

    /// 这条计划项是否符合本次选择的口径。清单经 NAS 持久化后可被篡改,
    /// 引擎按此复核:
    /// - 整卷:源即目标(保留原层级),任何源≠目标都说明清单被动过;
    /// - 选文件夹:源必须是**所选文件夹的直接子文件**,目标必须是扁平文件名。
    pub fn allows(&self, source_rel: &str, target_rel: &str) -> bool {
        match self {
            Self::WholeVolume => source_rel == target_rel,
            Self::Folders(folders) => {
                let parent = match source_rel.rfind('/') {
                    Some(i) => &source_rel[..i],
                    None => "",
                };
                !target_rel.contains('/') && folders.iter().any(|f| f == parent)
            }
        }
    }
}

/// 一个待拷文件:源相对路径(相对卷根)与它在目标夹里的落点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedFile {
    /// 卷内真实位置,如 `DCIM/100MSDCF/DSC001.JPG`
    pub source_rel: String,
    /// 目标夹内的相对落点。扁平化后通常就是文件名;重名时按下述规则加前缀
    pub target_rel: String,
    pub size: u64,
}

/// 因重名而被改写落点的文件(必须让用户看见——系统改了文件名,不许静默)
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RenamedFile {
    pub source_rel: String,
    pub target_rel: String,
}

/// 整卷清单 → 计划项:源即目标,保留原目录结构(历史行为)。
pub fn plan_whole_volume(files: &[(String, u64)]) -> Vec<PlannedFile> {
    files
        .iter()
        .map(|(rel, size)| PlannedFile {
            source_rel: rel.clone(),
            target_rel: rel.clone(),
            size: *size,
        })
        .collect()
}

/// 一个可勾选的源文件夹(相对卷根,`/` 分隔;空串 = 卷根自身)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceFolder {
    pub rel_path: String,
    /// **直接子文件**数(不含子目录内的)
    pub file_count: usize,
    pub total_bytes: u64,
    /// 是否还有子目录(子目录自身另有独立条目)
    pub has_subfolders: bool,
}

/// 把 `/` 分隔的相对路径接到根上(空串 = 根自身)。
fn rel_join(root: &Path, rel: &str) -> PathBuf {
    if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel_to_native(rel))
    }
}

/// 目录读取失败的人话翻译。零静默:源卷半死/无权限时绝不能吞成空列表,
/// 用户会当成「卡是空的」而去格式化。
fn dir_error(rel: &str, dir: &Path, e: &std::io::Error) -> super::CoreError {
    let what = if rel.is_empty() {
        "源卷根目录".to_string()
    } else {
        format!("文件夹「{rel}」")
    };
    let msg = match e.kind() {
        std::io::ErrorKind::NotFound => format!(
            "{what}不存在(卡可能已被拔出,或内容在选择之后发生了变化): {}",
            dir.display()
        ),
        std::io::ErrorKind::PermissionDenied => format!(
            "没有读取{what}的权限,请在系统的隐私/磁盘访问设置中授权 OCard 后重试: {}",
            dir.display()
        ),
        // 选中项其实是文件时报「挂载点断开」会把人引到完全错误的方向
        _ if dir.is_file() => format!("{what}不是文件夹,不能作为拷贝范围: {}", dir.display()),
        _ => format!(
            "读取{what}失败(挂载点可能已断开,建议重新插拔存储卡): {} — {e}",
            dir.display()
        ),
    };
    super::CoreError::Invalid(msg)
}

/// 列文件夹时读不动的目录(相机卡上常见:Windows 格式化留下的
/// `System Volume Information`/`$RECYCLE.BIN` 带 ACL)。
/// 不让它废掉整个选择器,但**必须**逐条报到用户面前。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnreadableFolder {
    pub rel_path: String,
    pub reason: String,
}

/// 列出卷内可勾选的文件夹(含卷根 `""`)。排序:`rel_path` 字典序,卷根恒第一。
/// 只列**含直接子文件**或**含已列出子目录**的,纯空目录树不列——勾了也拷不出
/// 东西,还会把真正的素材夹淹在噪声里。
/// 隐藏项与符号链接与拷贝口径一致:一律跳过,链接计数供上层告警。
///
/// 卷根读不动 = 硬错(吞成空列表会被读成「卡是空的」);**子目录**读不动只跳过
/// 该子树,连同原因一起回给调用方去告警——一个带 ACL 的
/// `System Volume Information` 不该让整张卡选不了。
pub fn list_source_folders(root: &Path) -> Result<(Vec<SourceFolder>, Vec<UnreadableFolder>)> {
    let mut out = Vec::new();
    let mut bad = Vec::new();
    // 卷根本身失败原样上抛(人话已在 dir_error 里)
    collect_folders(root, "", &mut out, &mut bad)?;
    // "" 在字典序里天然最小,卷根自动排第一
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    bad.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok((out, bad))
}

/// 返回「本文件夹是否入列」。`has_subfolders` 只在**真有子条目入列**时为 true:
/// 报了却点不出东西,等于骗用户去空文件夹里找素材。
fn collect_folders(
    root: &Path,
    rel: &str,
    out: &mut Vec<SourceFolder>,
    bad: &mut Vec<UnreadableFolder>,
) -> Result<bool> {
    let dir = rel_join(root, rel);
    let mut file_count = 0usize;
    let mut total_bytes = 0u64;
    let mut subs: Vec<String> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| dir_error(rel, &dir, &e))? {
        let entry = entry.map_err(|e| dir_error(rel, &dir, &e))?;
        let name = entry.file_name();
        let name = name.to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let ft = entry.file_type().map_err(|e| dir_error(rel, &dir, &e))?;
        if ft.is_symlink() {
            note_symlink_skipped();
            continue;
        }
        let meta = entry.metadata().map_err(|e| dir_error(rel, &dir, &e))?;
        if meta.is_dir() {
            subs.push(if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            });
        } else if meta.is_file() {
            file_count += 1;
            total_bytes += meta.len();
        }
    }
    let mut has_subfolders = false;
    for sub in subs {
        match collect_folders(root, &sub, out, bad) {
            Ok(listed) => has_subfolders |= listed,
            // 跳过读不动的子树:不入列(勾不了就别显示),但要带原因回去告警
            Err(e) => bad.push(UnreadableFolder {
                rel_path: sub,
                reason: e.to_string(),
            }),
        }
    }
    let listed = file_count > 0 || has_subfolders;
    if listed {
        out.push(SourceFolder {
            rel_path: rel.to_string(),
            file_count,
            total_bytes,
            has_subfolders,
        });
    }
    Ok(listed)
}

/// 列出某个文件夹下的**直接子文件**(不递归)。规则与 `walk` 一致:
/// 跳过隐藏项与符号链接。
fn list_direct_files(root: &Path, folder: &str) -> Result<Vec<(String, u64)>> {
    let dir = rel_join(root, folder);
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| dir_error(folder, &dir, &e))? {
        let entry = entry.map_err(|e| dir_error(folder, &dir, &e))?;
        let name = entry.file_name();
        let name = name.to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let ft = entry.file_type().map_err(|e| dir_error(folder, &dir, &e))?;
        if ft.is_symlink() {
            note_symlink_skipped();
            continue;
        }
        let meta = entry.metadata().map_err(|e| dir_error(folder, &dir, &e))?;
        if !meta.is_file() {
            continue;
        }
        let rel = if folder.is_empty() {
            name
        } else {
            format!("{folder}/{name}")
        };
        out.push((rel, meta.len()));
    }
    Ok(out)
}

/// 把「源相对路径」列表规划成扁平的目标落点,并解决重名。
///
/// 重名规则(用户选定):不改动不冲突的文件名;只给冲突的那些**从最深一级
/// 目录名开始、逐级向上追加**,直到该组内唯一——即「最短可区分前缀」。
/// 例:`100MSDCF/DSC1.JPG` 与 `101MSDCF/DSC1.JPG` → `100MSDCF_DSC1.JPG`
/// 与 `101MSDCF_DSC1.JPG`;若两侧目录名也相同则继续向上取一段。
/// 加完前缀仍与**别的组**撞名时补 `_2`、`_3`(见函数内的全局唯一性兜底)。
///
/// 撞名判定按 [`fold_key`] 大小写不敏感:目的地常是 APFS/exFAT/SMB,
/// `DSC1.JPG` 与 `dsc1.jpg` 在那儿是同一个文件——按字节比较会规划出两个
/// 「不冲突」的落点,拷到第二个时才炸(或同内容时静默并成一个)。
///
/// 排序稳定(按 source_rel),保证同一次选择的规划结果可复现——
/// manifest 与断点续传依赖 target_rel 稳定。
pub fn plan_flat_targets(files: &[(String, u64)]) -> (Vec<PlannedFile>, Vec<RenamedFile>) {
    use std::collections::{HashMap, HashSet};

    let mut by_name: HashMap<String, Vec<&String>> = HashMap::new();
    for (rel, _) in files {
        by_name
            .entry(fold_key(base_name(rel)))
            .or_default()
            .push(rel);
    }

    let mut planned = Vec::with_capacity(files.len());

    for (rel, size) in files {
        let base = base_name(rel);
        let group = &by_name[&fold_key(base)];
        if group.len() == 1 {
            planned.push(PlannedFile {
                source_rel: rel.clone(),
                target_rel: base.to_string(),
                size: *size,
            });
            continue;
        }
        // 冲突:逐级向上追加目录名,直到在该组内唯一
        let segs: Vec<&str> = rel.split('/').collect();
        let dirs = &segs[..segs.len().saturating_sub(1)];
        let mut target = base.to_string();
        for depth in 1..=dirs.len() {
            let prefix = dirs[dirs.len() - depth..].join("_");
            let candidate = format!("{prefix}_{base}");
            let unique = group.iter().filter(|other| **other != rel).all(|other| {
                let osegs: Vec<&str> = other.split('/').collect();
                let odirs = &osegs[..osegs.len().saturating_sub(1)];
                if odirs.len() < depth {
                    return true;
                }
                fold_key(&odirs[odirs.len() - depth..].join("_")) != fold_key(&prefix)
            });
            target = candidate;
            if unique {
                break;
            }
        }
        planned.push(PlannedFile {
            source_rel: rel.clone(),
            target_rel: target,
            size: *size,
        });
    }

    planned.sort_by(|a, b| a.source_rel.cmp(&b.source_rel));

    // 全局唯一性兜底:同名分组各自算前缀,**跨组**仍可能撞车——
    // 例如卡根本来就有个 `100MSDCF_DSC1.JPG`,而 `100MSDCF/DSC1.JPG`
    // 恰好被改写成同一个名字。两个源规划到同一落点 = 后者覆盖前者,
    // 绝不允许。先把「一个字没改」的原名占住(不冲突的名字优先级最高),
    // 被改写的再撞上就补 `_2`、`_3`。
    let mut taken: HashSet<String> = planned
        .iter()
        .filter(|p| p.target_rel == base_name(&p.source_rel))
        .map(|p| fold_key(&p.target_rel))
        .collect();
    for p in planned.iter_mut() {
        if p.target_rel == base_name(&p.source_rel) {
            continue;
        }
        if taken.insert(fold_key(&p.target_rel)) {
            continue;
        }
        let (stem, ext) = split_ext(&p.target_rel);
        for n in 2.. {
            let candidate = if ext.is_empty() {
                format!("{stem}_{n}")
            } else {
                format!("{stem}_{n}.{ext}")
            };
            if taken.insert(fold_key(&candidate)) {
                p.target_rel = candidate;
                break;
            }
        }
    }

    // 只有落盘名与原文件名不同的才算「被改写」(契约:清单只含被改写的)
    let renamed = planned
        .iter()
        .filter(|p| p.target_rel != base_name(&p.source_rel))
        .map(|p| RenamedFile {
            source_rel: p.source_rel.clone(),
            target_rel: p.target_rel.clone(),
        })
        .collect();
    (planned, renamed)
}

/// `a/b/c.JPG` → `c.JPG`
pub(crate) fn base_name(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

/// 落点撞名比较键:目的地文件系统(APFS/exFAT/SMB)通常大小写不敏感,
/// 判重必须按同一把尺子,否则「不冲突」的规划会在盘上变成同一个文件。
/// (Unicode 等价形式 NFC/NFD 的归一未做——没引入依赖;见交回说明。)
pub(crate) fn fold_key(name: &str) -> String {
    name.to_lowercase()
}

/// 拆主名与扩展名(无扩展名或以点开头时 ext 为空)。
fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i + 1..]),
        _ => (name, ""),
    }
}

/// 按选择扫描源。整盘 = 历史行为(递归、保留结构);
/// 选文件夹 = 只取直接子文件、扁平落点(重名按最短前缀区分)。
pub fn scan_selection(
    root: &Path,
    selection: &SourceSelection,
) -> Result<(Vec<PlannedFile>, Vec<RenamedFile>, u64)> {
    match selection {
        SourceSelection::WholeVolume => {
            let files = scan_source(root)?;
            let total = files.iter().map(|(_, s)| *s).sum();
            Ok((plan_whole_volume(&files), Vec::new(), total))
        }
        SourceSelection::Folders(folders) => {
            let mut files = Vec::new();
            for f in folders {
                // 闸放在扫描入口而不是只放在命令层:续传时选择来自可被改写的
                // manifest,`../` 会让复扫越过卷根去读卡外的目录
                if !f.is_empty() && !super::paths::is_safe_rel(f) {
                    return Err(super::CoreError::Invalid(format!(
                        "源文件夹路径非法,拒绝扫描: {f}"
                    )));
                }
                files.extend(list_direct_files(root, f)?);
            }
            files.sort();
            files.dedup();
            let total = files.iter().map(|(_, s)| *s).sum();
            let (planned, renamed) = plan_flat_targets(&files);
            Ok((planned, renamed, total))
        }
    }
}

/// 扫描源:递归列出全部普通文件(相对路径统一 `/` 分隔)。
/// 跳过点开头的隐藏项(存储卡上的 .Trashes/.fseventsd 等系统残留);
/// 符号链接不跟随(存储卡不产生合法链接),跳过并计数供上层告警。
pub fn scan_source(root: &Path) -> Result<Vec<(String, u64)>> {
    let mut out = Vec::new();
    walk(root, root, &mut out)?;
    out.sort();
    Ok(out)
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, u64)>) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        // file_type() 不跟随链接;链接一律跳过+计数(跟随会把根外树卷进来或死循环)
        let ft = entry.file_type()?;
        if ft.is_symlink() {
            note_symlink_skipped();
            continue;
        }
        let meta = entry.metadata()?;
        if meta.is_dir() {
            walk(root, &path, out)?;
        } else if meta.is_file() {
            let rel = path
                .strip_prefix(root)
                .expect("walk 始终在 root 之下")
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            out.push((rel, meta.len()));
        }
    }
    Ok(())
}

/// 轻量完成预判(UI 快照/任务重建用):只看 manifest 与目的地存在+尺寸,
/// **不做哈希**——权威裁决只在引擎的 [`file_done`] 一处(R5:消除预统计与
/// 正式复制的双重全量哈希)。`rel` 是**目标**相对路径(与 manifest 同口径)。
pub fn file_done_light(m: &CopyManifest, rel: &str, size: u64, destinations: &[PathBuf]) -> bool {
    if !m.is_done(rel, size) {
        return false;
    }
    destinations.iter().all(|d| {
        let p = d.join(rel_to_native(rel));
        !super::paths::is_symlink(&p)
            && fs::metadata(&p)
                .map(|meta| meta.is_file() && meta.len() == size)
                .unwrap_or(false)
    })
}

/// 续传跳过的一次性裁决(R4 哈希重验 → R5 终审收口):manifest 已验证 **且**
/// - **源**:非链接、canonical 在源根内、xxh3 与清单一致(R5:源被同大小
///   篡改时旧目标虽与清单一致,但新内容会被漏拷——必须重拷并走冲突可见);
/// - **每个目的地**:目的地根非链接、目标 canonical 在该根内(中间祖先链接
///   同拒)、非链接、尺寸一致、绕缓存回读 xxh3 与清单一致。
///
/// 清单条目一律按**目标**相对路径认(扁平化后源与目标不同名,断点续传的
/// 身份必须是落盘位置,否则改了名的文件每次续传都会被判成没拷过)。
///
/// 任何一条不满足=不算完成,引擎按正常路径重拷(既有目标不同内容=可见冲突)。
pub fn file_done(
    m: &CopyManifest,
    source_root: &Path,
    source_rel: &str,
    target_rel: &str,
    size: u64,
    destinations: &[PathBuf],
) -> bool {
    let Some(entry) = m
        .entries
        .iter()
        .find(|e| e.rel_path == target_rel && e.verified && e.size == size)
    else {
        return false;
    };
    let src = source_root.join(rel_to_native(source_rel));
    if super::paths::is_symlink(&src) || super::paths::assert_within(source_root, &src).is_err() {
        return false;
    }
    let src_ok = hash::xxh3_file(&src)
        .map(|h| h == entry.xxh3)
        .unwrap_or(false);
    if !src_ok {
        return false;
    }
    destinations.iter().all(|d| {
        if super::paths::is_symlink(d) {
            return false;
        }
        let p = d.join(rel_to_native(target_rel));
        // R5:中间祖先链接同样拒(canonical 断言),不只看末节点
        if super::paths::is_symlink(&p) || super::paths::assert_within(d, &p).is_err() {
            return false;
        }
        let size_ok = fs::metadata(&p)
            .map(|meta| meta.is_file() && meta.len() == size)
            .unwrap_or(false);
        if !size_ok {
            return false;
        }
        hash::xxh3_file_uncached(&p)
            .map(|h| h == entry.xxh3)
            .unwrap_or(false)
    })
}

/// 执行拷卡。`plan` 为调用方预先规划好的清单(与 UI 快照/manifest 同源,
/// 避免两次扫描产生分歧):每项自带**源**相对路径与**目标**相对路径,
/// 整卷时两者相同,选文件夹扁平化时两者分离。
/// `project_root` 用于逐文件持久化 manifest(断点续传依据)。
/// 回调返回 [`CopyControl::Pause`] 时在当前文件完成后停下,manifest 保证可续传。
pub fn run_copy(
    req: &CopyRequest,
    plan: &[PlannedFile],
    m: &mut CopyManifest,
    project_root: &Path,
    mut progress: impl FnMut(Progress) -> CopyControl,
) -> Result<CopyOutcome> {
    assert!(!req.destinations.is_empty(), "至少需要一个目的地");
    // 全计划预检,闸先于任何副作用:清单可能来自被改写的 manifest。
    // ① 落点必须两两不同(按目的地文件系统的大小写口径):两项共用一个落点时,
    //    第二项会被续传判定当成「已完成」跳过,整批却仍报完成 = 静默漏拷;
    // ② 落点不许占用引擎内部的 `.ocardpart` 命名空间:临时文件与正式文件同目录,
    //    别人的正式文件正好叫某项的 part 名时,会被那项的残留清理删掉。
    {
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for p in plan {
            if p.target_rel.ends_with(PART_SUFFIX) {
                return Err(super::CoreError::Invalid(format!(
                    "清单落点占用了引擎内部临时后缀 {PART_SUFFIX},拒绝执行: {}",
                    p.target_rel
                )));
            }
            if !seen.insert(fold_key(&p.target_rel)) {
                return Err(super::CoreError::Invalid(format!(
                    "清单里有两个文件规划到同一个落点,拒绝执行(会互相覆盖): {}",
                    p.target_rel
                )));
            }
        }
    }
    let total_bytes: u64 = plan.iter().map(|p| p.size).sum();
    let mut control = progress(Progress::Scanned {
        total_files: plan.len(),
        total_bytes,
    });

    let mut reports = Vec::with_capacity(plan.len());
    let mut bytes_copied = 0u64;
    let mut paused = false;
    // 连续 IO 失败视为基础设施故障(NAS 断连),转入暂停而非全部标失败(评审复核 P1)
    let mut consecutive_io = 0usize;
    let total = plan.len();

    for (index, item) in plan.iter().enumerate() {
        let (src_rel, rel, size) = (&item.source_rel, &item.target_rel, item.size);
        if control == CopyControl::Pause {
            paused = true;
            break;
        }
        control = progress(Progress::FileStarted {
            rel_path: rel,
            index,
            total,
        });
        if control == CopyControl::Pause {
            paused = true;
            break;
        }

        // 清单来自持久化存储(NAS 上可被改写):源路径必须仍落在用户当初勾选的
        // 范围内,否则等于拿旧任务的授权去读别处的文件——拒绝并可见记为失败
        let status = if !req.selection.allows(src_rel, rel) {
            FileStatus::Failed(format!(
                "清单项与本次源选择不符,拒绝执行: {src_rel} → {rel}(任务清单可能已损坏或被篡改,请重新发起拷贝)"
            ))
        } else {
            // R5 三票 P1:时间戳快照在 file_done 的源哈希**之前**采集——
            // 修复目标场景里,验证读同样会刷新源 atime
            let pre_meta = fs::metadata(req.source_root.join(rel_to_native(src_rel))).ok();
            if file_done(m, &req.source_root, src_rel, rel, size, &req.destinations) {
                FileStatus::SkippedResume
            } else {
                match copy_one(
                    &req.source_root,
                    src_rel,
                    rel,
                    pre_meta,
                    &req.destinations,
                    &req.task_tag,
                    &mut |delta| {
                        // 块级进度只上报,不在文件中途暂停
                        let _ = progress(Progress::BytesCopied {
                            rel_path: rel,
                            delta,
                        });
                    },
                ) {
                    Ok(xxh3) => {
                        consecutive_io = 0;
                        m.upsert(ManifestEntry {
                            rel_path: rel.clone(),
                            size,
                            xxh3,
                            verified: true,
                        });
                        bytes_copied += size;
                        FileStatus::Copied
                    }
                    Err(e) => {
                        if matches!(e, super::CoreError::Io(_)) {
                            consecutive_io += 1;
                        } else {
                            consecutive_io = 0;
                        }
                        m.upsert(ManifestEntry {
                            rel_path: rel.clone(),
                            size,
                            xxh3: String::new(),
                            verified: false,
                        });
                        FileStatus::Failed(e.to_string())
                    }
                }
            }
        };
        // 逐文件落盘,任意时刻中断都可续传
        manifest::save(project_root, m)?;
        control = progress(Progress::FileFinished {
            rel_path: rel,
            status: &status,
        });
        reports.push(FileReport {
            rel_path: rel.clone(),
            source_rel: src_rel.clone(),
            size,
            status,
        });
        if consecutive_io >= 3 {
            paused = true;
            break;
        }
    }

    let all_verified = !paused
        && reports.len() == total
        && !reports.is_empty()
        && reports
            .iter()
            .all(|r| !matches!(r.status, FileStatus::Failed(_)));
    m.completed = all_verified;
    manifest::save(project_root, m)?;

    Ok(CopyOutcome {
        files: reports,
        bytes_copied,
        all_verified,
        paused,
    })
}

/// 拷贝单个文件到全部目的地。核心安全语义(评审 F1/P0-2):
/// **绝不覆盖已存在的最终文件**——目标已存在时比对哈希:
/// 内容相同视为该目的地已完成(复用),内容不同报 Conflict 交人工裁决。
/// 临时文件名带任务标识,杜绝跨任务/跨工作站互写。
/// 流程:读一次源、边读边算哈希、写缺失目的地的临时文件,
/// 逐目的地回读校验,全部通过后统一改名。返回源文件 xxh3。
fn copy_one(
    source_root: &Path,
    source_rel: &str,
    target_rel: &str,
    src_meta: Option<fs::Metadata>,
    destinations: &[PathBuf],
    task_tag: &str,
    on_chunk: &mut dyn FnMut(u64),
) -> Result<String> {
    // R2 P0:两条 rel 都可能来自持久化清单(resume),被篡改为 `../../…` 即任意
    // 读写——源侧越界=任意读,目标侧越界=任意写,两侧都必须过闸。
    // 引擎层兜底闸:非法相对路径直接拒绝(入口处 resume 合并另有前置校验)。
    for rel in [source_rel, target_rel] {
        if !super::paths::is_safe_rel(rel) {
            return Err(super::CoreError::Invalid(format!(
                "清单相对路径非法,拒绝执行: {rel}"
            )));
        }
    }
    let src_path = source_root.join(rel_to_native(source_rel));
    // 扫描已跳过链接;这里再挡一道(清单项可能指向后来被替换成链接的路径)
    if super::paths::is_symlink(&src_path) {
        return Err(super::CoreError::Invalid(format!(
            "源文件是符号链接,拒绝拷贝: {source_rel}"
        )));
    }
    // R4(终审 P0-2):末节点检查挡不住**祖先**链接(DCIM → 外部目录时,
    // planned 项经 resume 并回后仍会读到卡外)——canonical 断言真实位置在源根内
    super::paths::assert_within(source_root, &src_path).map_err(super::CoreError::Invalid)?;

    // 时间戳快照由调用方在 file_done 源哈希之前采集传入(R5 三票 P1);
    // 获取失败计入保留失败聚合告警
    if src_meta.is_none() {
        super::fsx::note_times_preserve_failures(destinations.len() as u64);
    }

    // 落点用**目标** rel:扁平化后它与源路径不同(通常只是文件名)
    let finals: Vec<PathBuf> = destinations
        .iter()
        .map(|d| d.join(rel_to_native(target_rel)))
        .collect();

    // 目的地已有同名最终文件 → 先算源哈希,再逐一比对。
    // R4(终审 P0-2):裁决前先过闸——既有目标是链接或实际位置在目的地根外时,
    // 经链接 exists/hash 会把外部文件误当包内既有文件采信
    for (i, f) in finals.iter().enumerate() {
        if f.exists() {
            if super::paths::is_symlink(f) {
                return Err(super::CoreError::Invalid(format!(
                    "目标位置是符号链接,拒绝采信/写入: {}",
                    f.display()
                )));
            }
            super::paths::assert_within(&destinations[i], f).map_err(super::CoreError::Invalid)?;
        }
    }
    let pre_existing: Vec<usize> = finals
        .iter()
        .enumerate()
        .filter(|(_, f)| f.exists())
        .map(|(i, _)| i)
        .collect();

    let mut known_src_hash: Option<String> = None;
    if !pre_existing.is_empty() {
        let src_hash = hash::xxh3_file(&src_path)?;
        for &i in &pre_existing {
            let existing_hash = hash::xxh3_file(&finals[i])?;
            if existing_hash != src_hash {
                return Err(super::CoreError::Invalid(format!(
                    "目标已存在且内容不同,拒绝覆盖: {} (源 {src_hash} / 已有 {existing_hash})。\
                     可能是同名重复拷卡,请人工核对",
                    finals[i].display()
                )));
            }
        }
        if pre_existing.len() == finals.len() {
            // 所有目的地都已有同内容文件:无需写入;顺带清理本任务可能的残留 part(终验 #4)
            for f in &finals {
                let _ = fs::remove_file(f.with_file_name(format!(
                    "{}.{task_tag}{PART_SUFFIX}",
                    f.file_name().unwrap().to_string_lossy()
                )));
            }
            on_chunk(fs::metadata(&src_path)?.len());
            return Ok(src_hash);
        }
        known_src_hash = Some(src_hash);
    }

    // 只为缺失的目的地写临时文件
    let missing: Vec<usize> = (0..finals.len())
        .filter(|i| !pre_existing.contains(i))
        .collect();
    let parts: Vec<PathBuf> = missing
        .iter()
        .map(|&i| {
            finals[i].with_file_name(format!(
                "{}.{task_tag}{PART_SUFFIX}",
                finals[i].file_name().unwrap().to_string_lossy()
            ))
        })
        .collect();

    let mut src = File::open(&src_path)?;
    let result = (|| -> Result<String> {
        let mut writers = Vec::with_capacity(parts.len());
        for (part, &i) in parts.iter().zip(&missing) {
            if let Some(parent) = part.parent() {
                // R2 P0:目的地中间目录可能被预置为符号链接,把写入导向根外——
                // 走 canonicalize 落地闸(闸在副作用之前),不再裸 create_dir_all。
                // 目的地根是任务级已验证的用户目标(validate_dest_layout),
                // 可能尚不存在:拒链接后创建,再对根下段落闸
                let root = &destinations[i];
                if super::paths::is_symlink(root) {
                    return Err(super::CoreError::Invalid(format!(
                        "目的地根是符号链接,拒绝写入: {}",
                        root.display()
                    )));
                }
                fs::create_dir_all(root)?;
                super::paths::ensure_dir_within(root, parent).map_err(super::CoreError::Invalid)?;
            }
            // 同任务崩溃残留的 part 是自己的,清掉;create_new 拦截跨任务冲突
            let _ = fs::remove_file(part);
            writers.push(
                fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(part)?,
            );
        }

        let mut hasher = xxhash_rust::xxh3::Xxh3::new();
        let mut buf = vec![0u8; BUF_SIZE];
        loop {
            let n = src.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            for w in &mut writers {
                w.write_all(&buf[..n])?;
            }
            on_chunk(n as u64);
        }
        for mut w in writers {
            w.flush()?;
            w.sync_all()?;
        }
        let src_hash = format!("{:016x}", hasher.digest());
        if let Some(known) = &known_src_hash {
            if known != &src_hash {
                return Err(super::CoreError::Invalid(format!(
                    "源文件在两次读取之间发生变化: {source_rel}"
                )));
            }
        }

        // 逐目的地回读校验(绕页缓存,尽量读介质而非内存,M2 技术债)
        for part in &parts {
            let dest_hash = hash::xxh3_file_uncached(part)?;
            if dest_hash != src_hash {
                return Err(super::CoreError::Invalid(format!(
                    "校验不一致: {} (源 {src_hash} / 目标 {dest_hash})",
                    part.display()
                )));
            }
        }
        // 全部通过,原子防覆盖落位;落位后保留源时间戳
        // (mtime/atime 三平台;创建时间 mac/win——用户明确要求,Linux btime
        //  不可设置为声明边界;失败计数聚合为可见 warning,不阻塞拷贝;
        //  快照在读源之前采集,见 copy_one 开头)
        for (part, &i) in parts.iter().zip(&missing) {
            finalize_no_replace(part, &finals[i])?;
            if let Some(m) = &src_meta {
                super::fsx::preserve_times_counted(m, &finals[i]);
            }
        }
        Ok(src_hash)
    })();

    if result.is_err() {
        for part in &parts {
            let _ = fs::remove_file(part);
        }
    }
    result
}

/// 原子防覆盖落位(评审复核 P0:`rename` 会替换已存在目标,check→rename 有竞态窗口)。
/// 优先 `hard_link`:目标已存在时原子失败,不可能覆盖;成功后删除 part 名。
/// 文件系统不支持硬链接(部分 SMB/exFAT)时回退「存在性复查 + rename」,
/// 该回退窗口为微秒级且长窗口已被入口 pre_existing 检查夹住。
fn finalize_no_replace(part: &Path, fin: &Path) -> Result<()> {
    // 平台原生 no-replace 原子改名(renamex_np/renameat2/MoveFileEx),
    // 逐级回退见 fsx 模块(M2 技术债:替代此前的 hard_link 方案)
    super::fsx::rename_no_replace(part, fin).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            super::CoreError::Invalid(format!(
                "目标在拷贝期间被其他任务写入,拒绝覆盖: {}",
                fin.display()
            ))
        } else {
            super::CoreError::Io(e)
        }
    })
}

/// 把 `/` 分隔的相对路径转为本平台路径。
fn rel_to_native(rel: &str) -> PathBuf {
    rel.split('/').collect()
}

#[cfg(test)]
mod tests {

    fn f(rel: &str) -> (String, u64) {
        (rel.to_string(), 1)
    }

    #[test]
    fn flat_plan_keeps_unique_names_untouched() {
        let (planned, renamed) = plan_flat_targets(&[f("100MSDCF/A.JPG"), f("CLIP/B.MP4")]);
        assert_eq!(planned[0].target_rel, "A.JPG");
        assert_eq!(planned[1].target_rel, "B.MP4");
        // 不冲突就一个字都不改——素材文件名是相机连号,改了就对不上号
        assert!(renamed.is_empty());
    }

    #[test]
    fn flat_plan_disambiguates_only_the_clashing_ones() {
        let (planned, renamed) = plan_flat_targets(&[
            f("100MSDCF/DSC1.JPG"),
            f("101MSDCF/DSC1.JPG"),
            f("100MSDCF/ONLY.JPG"),
        ]);
        let t = |src: &str| {
            planned
                .iter()
                .find(|p| p.source_rel == src)
                .unwrap()
                .target_rel
                .clone()
        };
        assert_eq!(t("100MSDCF/DSC1.JPG"), "100MSDCF_DSC1.JPG");
        assert_eq!(t("101MSDCF/DSC1.JPG"), "101MSDCF_DSC1.JPG");
        // 没冲突的保持原名
        assert_eq!(t("100MSDCF/ONLY.JPG"), "ONLY.JPG");
        // 只有被改写的进入回执清单(要显式告诉用户)
        assert_eq!(renamed.len(), 2);
    }

    #[test]
    fn flat_plan_walks_further_up_when_parent_names_also_collide() {
        // 两侧最深一级目录名都叫 CLIP:加一级还撞,必须继续向上取
        let (planned, _) = plan_flat_targets(&[f("A/CLIP/C1.MP4"), f("B/CLIP/C1.MP4")]);
        let t: Vec<&str> = planned.iter().map(|p| p.target_rel.as_str()).collect();
        assert_eq!(t, vec!["A_CLIP_C1.MP4", "B_CLIP_C1.MP4"]);
        // 关键:两个落点必须互不相同,否则就是覆盖
        assert_ne!(planned[0].target_rel, planned[1].target_rel);
    }

    #[test]
    fn flat_plan_is_deterministic() {
        // 断点续传按 target_rel 认文件:同一组输入必须每次规划出同样的结果
        let input = [f("B/x.JPG"), f("A/x.JPG"), f("A/y.JPG")];
        let (p1, _) = plan_flat_targets(&input);
        let (p2, _) = plan_flat_targets(&input);
        assert_eq!(p1, p2);
    }

    #[test]
    fn scan_selection_takes_direct_children_only() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("CLIP/SUB")).unwrap();
        std::fs::write(root.join("CLIP/a.mp4"), b"aa").unwrap();
        std::fs::write(root.join("CLIP/SUB/deep.mp4"), b"bbb").unwrap();
        std::fs::write(root.join("other.txt"), b"c").unwrap();

        let (planned, renamed, total) =
            scan_selection(root, &SourceSelection::Folders(vec!["CLIP".into()])).unwrap();
        // 子目录不递归(它自己是另一个可勾选项),卷根的文件也不带进来
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].source_rel, "CLIP/a.mp4");
        assert_eq!(planned[0].target_rel, "a.mp4");
        assert_eq!(total, 2);
        assert!(renamed.is_empty());
    }

    #[test]
    fn scan_selection_whole_volume_keeps_structure() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("DCIM/100")).unwrap();
        std::fs::write(root.join("DCIM/100/a.jpg"), b"a").unwrap();

        let (planned, renamed, _) = scan_selection(root, &SourceSelection::WholeVolume).unwrap();
        // 整盘仍是历史行为:保留目录结构,不改名
        assert_eq!(planned[0].source_rel, "DCIM/100/a.jpg");
        assert_eq!(planned[0].target_rel, "DCIM/100/a.jpg");
        assert!(renamed.is_empty());
    }
    use super::*;
    use tempfile::tempdir;

    /// 造一张模拟存储卡。
    fn make_card(root: &Path) {
        fs::create_dir_all(root.join("DCIM/100MSDCF")).unwrap();
        fs::create_dir_all(root.join(".Trashes")).unwrap();
        fs::write(root.join("DCIM/100MSDCF/IMG_0001.JPG"), vec![1u8; 3000]).unwrap();
        fs::write(root.join("DCIM/100MSDCF/IMG_0002.JPG"), vec![2u8; 5000]).unwrap();
        fs::write(root.join("CLIP0001.MP4"), vec![3u8; 9000]).unwrap();
        fs::write(root.join(".Trashes/junk"), b"x").unwrap();
    }

    fn setup() -> (tempfile::TempDir, CopyRequest, CopyManifest, PathBuf) {
        let tmp = tempdir().unwrap();
        let card = tmp.path().join("card");
        make_card(&card);
        let dest1 = tmp.path().join("nas/2. 原始素材/20260824_A7M4_A_ZS");
        let dest2 = tmp.path().join("backup/20260824_A7M4_A_ZS");
        let project = tmp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let req = CopyRequest {
            source_root: card,
            destinations: vec![dest1, dest2],
            task_tag: "t1".into(),
            selection: SourceSelection::WholeVolume,
        };
        let m = CopyManifest::new(
            "2. 原始素材/20260824_A7M4_A_ZS",
            "card",
            "A7M4_A_ZS",
            "ZS",
            "",
        );
        (tmp, req, m, project)
    }

    #[test]
    fn scan_skips_hidden_and_sorts() {
        let tmp = tempdir().unwrap();
        make_card(tmp.path());
        let files = scan_source(tmp.path()).unwrap();
        let names: Vec<&str> = files.iter().map(|(r, _)| r.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "CLIP0001.MP4",
                "DCIM/100MSDCF/IMG_0001.JPG",
                "DCIM/100MSDCF/IMG_0002.JPG"
            ]
        );
    }

    #[test]
    fn copies_to_all_destinations_with_verify() {
        let (_tmp, req, mut m, project) = setup();
        let mut events = 0usize;
        let out = run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| {
                events += 1;
                CopyControl::Continue
            },
        )
        .unwrap();

        assert!(out.all_verified);
        assert_eq!(out.files.len(), 3);
        assert_eq!(out.bytes_copied, 17000);
        assert!(events >= 7, "Scanned + 每文件 Started/Finished");
        for d in &req.destinations {
            assert!(d.join("DCIM/100MSDCF/IMG_0001.JPG").is_file());
            assert!(d.join("CLIP0001.MP4").is_file());
        }
        // 无残留临时文件
        for d in &req.destinations {
            let mut found_part = false;
            let mut stack = vec![d.clone()];
            while let Some(p) = stack.pop() {
                for e in fs::read_dir(&p).unwrap() {
                    let e = e.unwrap().path();
                    if e.is_dir() {
                        stack.push(e);
                    } else if e.to_string_lossy().ends_with(PART_SUFFIX) {
                        found_part = true;
                    }
                }
            }
            assert!(!found_part);
        }
        // manifest 已完成、全部验证
        let saved = manifest::load(&project, &m.id).unwrap();
        assert!(saved.completed);
        assert!(saved.entries.iter().all(|e| e.verified));
    }

    #[test]
    fn resume_skips_verified_files() {
        let (_tmp, req, mut m, project) = setup();
        run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();

        // 第二次执行:全部续传跳过,拷贝字节为 0
        let out = run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        assert!(out
            .files
            .iter()
            .all(|f| f.status == FileStatus::SkippedResume));
        assert_eq!(out.bytes_copied, 0);
        assert!(out.all_verified);
    }

    #[test]
    fn same_name_different_content_is_conflict_never_overwrite() {
        // 评审 F1/P0-2 的核心场景:同名不同内容绝不覆盖
        let (_tmp, req, mut m, project) = setup();
        run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        let original = fs::read(req.destinations[0].join("CLIP0001.MP4")).unwrap();

        // 换卡:同名文件、不同内容(相机格式化后计数器重置)
        fs::write(req.source_root.join("CLIP0001.MP4"), vec![9u8; 12000]).unwrap();
        let mut m2 = CopyManifest::new(
            "2. 原始素材/20260824_A7M4_A_ZS",
            "card2",
            "A7M4_A_ZS",
            "ZS",
            "",
        );
        let out = run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m2,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();

        let clip = out
            .files
            .iter()
            .find(|f| f.rel_path == "CLIP0001.MP4")
            .unwrap();
        assert!(
            matches!(&clip.status, FileStatus::Failed(e) if e.contains("拒绝覆盖")),
            "同名不同内容必须报冲突,实际: {:?}",
            clip.status
        );
        assert!(!out.all_verified, "有冲突绝不能给出可格式化信号");
        // 两个目的地上的旧素材都毫发无损
        for d in &req.destinations {
            assert_eq!(fs::read(d.join("CLIP0001.MP4")).unwrap(), original);
        }
    }

    #[test]
    fn same_name_same_content_reuses_without_rewrite() {
        // 重复拷同一张卡:同内容直接确认,不重写、不报错
        let (_tmp, req, mut m, project) = setup();
        run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();

        let mut m2 = CopyManifest::new(
            "2. 原始素材/20260824_A7M4_A_ZS",
            "card-again",
            "A7M4_A_ZS",
            "ZS",
            "",
        );
        let out = run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m2,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        assert!(out.all_verified);
        assert!(out.files.iter().all(|f| f.status == FileStatus::Copied));
    }

    #[test]
    fn resume_recopies_when_target_file_deleted() {
        // 评审 H2/P0-1:manifest 说已验证,但备份盘上的文件没了 → 必须补拷,不能假绿灯
        let (_tmp, req, mut m, project) = setup();
        run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        fs::remove_file(req.destinations[1].join("CLIP0001.MP4")).unwrap();

        let out = run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        let clip = out
            .files
            .iter()
            .find(|f| f.rel_path == "CLIP0001.MP4")
            .unwrap();
        assert_eq!(clip.status, FileStatus::Copied, "目标缺失必须重拷而非跳过");
        assert!(req.destinations[1].join("CLIP0001.MP4").is_file());
        assert!(out.all_verified);
    }

    #[test]
    fn write_failure_marks_file_failed_but_continues() {
        let (_tmp, req, mut m, project) = setup();
        // 目标位置被同名目录占据 → 该文件写入失败,其余文件应不受影响
        fs::create_dir_all(req.destinations[0].join("CLIP0001.MP4")).unwrap();

        let out = run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        let clip = out
            .files
            .iter()
            .find(|f| f.rel_path == "CLIP0001.MP4")
            .unwrap();
        assert!(matches!(clip.status, FileStatus::Failed(_)));
        assert!(!out.all_verified);
        // 其他文件不受影响
        assert!(out
            .files
            .iter()
            .filter(|f| f.rel_path != "CLIP0001.MP4")
            .all(|f| f.status == FileStatus::Copied));
        // manifest 里失败文件未验证 → 下次续传会重试
        let saved = manifest::load(&project, &m.id).unwrap();
        let e = saved
            .entries
            .iter()
            .find(|e| e.rel_path == "CLIP0001.MP4")
            .unwrap();
        assert!(!e.verified);
        assert!(!saved.completed);
    }

    #[test]
    fn bytes_progress_covers_all_copied_bytes() {
        let (_tmp, req, mut m, project) = setup();
        let mut bytes = 0u64;
        run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |p| {
                if let Progress::BytesCopied { delta, .. } = p {
                    bytes += delta;
                }
                CopyControl::Continue
            },
        )
        .unwrap();
        assert_eq!(bytes, 17000);
    }

    #[test]
    fn pause_stops_at_file_boundary_and_resume_finishes() {
        let (_tmp, req, mut m, project) = setup();
        // 第一个文件完成后请求暂停
        let mut finished = 0usize;
        let out = run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |p| {
                if matches!(p, Progress::FileFinished { .. }) {
                    finished += 1;
                    if finished >= 1 {
                        return CopyControl::Pause;
                    }
                }
                CopyControl::Continue
            },
        )
        .unwrap();
        assert!(out.paused);
        assert!(!out.all_verified);
        assert_eq!(out.files.len(), 1);
        let saved = manifest::load(&project, &m.id).unwrap();
        assert!(!saved.completed);

        // 续传:剩余文件补齐,已拷的跳过
        let out2 = run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        assert!(!out2.paused);
        assert!(out2.all_verified);
        assert_eq!(
            out2.files
                .iter()
                .filter(|f| f.status == FileStatus::SkippedResume)
                .count(),
            1
        );
        assert_eq!(
            out2.files
                .iter()
                .filter(|f| f.status == FileStatus::Copied)
                .count(),
            2
        );
    }
}

#[cfg(test)]
mod review_regression_tests {
    use super::*;
    use crate::core::manifest::{self, CopyManifest};
    use tempfile::tempdir;

    fn make_card(root: &Path) {
        fs::create_dir_all(root.join("DCIM")).unwrap();
        fs::write(root.join("DCIM/IMG_0001.JPG"), vec![1u8; 3000]).unwrap();
        fs::write(root.join("DCIM/IMG_0002.JPG"), vec![2u8; 5000]).unwrap();
        fs::write(root.join("CLIP0001.MP4"), vec![3u8; 9000]).unwrap();
    }

    fn setup() -> (tempfile::TempDir, CopyRequest, CopyManifest, PathBuf) {
        let tmp = tempdir().unwrap();
        let card = tmp.path().join("card");
        make_card(&card);
        let req = CopyRequest {
            source_root: card,
            destinations: vec![
                tmp.path().join("nas/target"),
                tmp.path().join("backup/target"),
            ],
            task_tag: "regr".into(),
            selection: SourceSelection::WholeVolume,
        };
        let project = tmp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let m = CopyManifest::new("target", "card", "X_A_Y", "ZS", "");
        (tmp, req, m, project)
    }

    #[test]
    fn leftover_own_part_is_cleaned_and_recopied() {
        // 复核 #17:同任务崩溃残留的 part 不阻塞重拷,且不残留
        let (_tmp, req, mut m, project) = setup();
        let part_name = format!("CLIP0001.MP4.{}{}", req.task_tag, PART_SUFFIX);
        fs::create_dir_all(&req.destinations[0]).unwrap();
        fs::write(req.destinations[0].join(&part_name), b"stale junk").unwrap();

        let files = scan_source(&req.source_root).unwrap();
        let out = run_copy(&req, &plan_whole_volume(&files), &mut m, &project, |_| {
            CopyControl::Continue
        })
        .unwrap();
        assert!(out.all_verified);
        assert!(!req.destinations[0].join(&part_name).exists());
        assert_eq!(
            fs::read(req.destinations[0].join("CLIP0001.MP4")).unwrap(),
            vec![3u8; 9000]
        );
    }

    #[test]
    fn vanished_planned_file_fails_not_silently_skipped() {
        // 复核 P0:计划内文件从源消失(续传场景)必须显式失败,绝不 all_verified
        let (_tmp, req, mut m, project) = setup();
        let mut files = scan_source(&req.source_root).unwrap();
        files.push(("GONE.MP4".to_string(), 4242));
        files.sort();

        let out = run_copy(&req, &plan_whole_volume(&files), &mut m, &project, |_| {
            CopyControl::Continue
        })
        .unwrap();
        let gone = out.files.iter().find(|f| f.rel_path == "GONE.MP4").unwrap();
        assert!(matches!(gone.status, FileStatus::Failed(_)));
        assert!(!out.all_verified, "有计划内文件缺失绝不能给可格式化信号");
    }

    #[test]
    fn consecutive_io_failures_pause_instead_of_failing_all() {
        // 复核 P1:目的地不可写(NAS 断连形态)→ 连续 IO 失败转入暂停
        let (tmp, mut req, mut m, project) = setup();
        let blocked = tmp.path().join("blocked-parent");
        fs::write(&blocked, b"i am a file").unwrap();
        req.destinations = vec![blocked.join("sub")];

        let files = scan_source(&req.source_root).unwrap();
        let out = run_copy(&req, &plan_whole_volume(&files), &mut m, &project, |_| {
            CopyControl::Continue
        })
        .unwrap();
        assert!(out.paused, "连续 IO 失败应转入可续传的暂停,而非终态 failed");
        assert!(!out.all_verified);
        let saved = manifest::load(&project, &m.id).unwrap();
        assert!(!saved.completed);
    }

    /// R2 变异复核:删掉 copy_one 落位后的 preserve_times_counted,本测试必红。
    #[test]
    fn copy_preserves_source_mtime_end_to_end() {
        let (_tmp, req, mut m, project) = setup();
        let src = req.source_root.join("CLIP0001.MP4");
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(86400 * 30);
        let f = fs::OpenOptions::new().write(true).open(&src).unwrap();
        f.set_times(fs::FileTimes::new().set_modified(old)).unwrap();
        drop(f);
        run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        for d in &req.destinations {
            let dm = fs::metadata(d.join("CLIP0001.MP4"))
                .unwrap()
                .modified()
                .unwrap();
            let diff = dm
                .duration_since(old)
                .unwrap_or_else(|e| e.duration())
                .as_secs();
            assert!(diff <= 2, "拷贝产物 mtime 必须保留源值(差 {diff}s)");
        }
    }

    /// R2 P0:扫描不得跟随符号链接(卡外树/链接环),跳过要计数(供告警)。
    #[cfg(unix)]
    #[test]
    fn scan_skips_symlinks_and_counts() {
        let tmp = tempdir().unwrap();
        make_card(tmp.path());
        std::os::unix::fs::symlink(tmp.path().join("DCIM"), tmp.path().join("LINKDIR")).unwrap();
        std::os::unix::fs::symlink(tmp.path().join("CLIP0001.MP4"), tmp.path().join("LINK.MP4"))
            .unwrap();
        let files = scan_source(tmp.path()).unwrap();
        assert!(
            files.iter().all(|(r, _)| !r.contains("LINK")),
            "符号链接不得进入拷贝清单: {files:?}"
        );
        assert!(take_scan_symlinks_skipped() >= 2, "跳过必须计数");
    }

    /// R2 P0:清单(可被篡改的持久化输入)里的 `../` 项必须被引擎拒绝,
    /// 且不得在目的地根外产生任何写入。
    /// R3 修订:逃逸源文件必须真实存在,且断言闸缺席时写入实际会落到的
    /// 解析位置——否则源不存在时 File::open 一样失败,断言恒真,
    /// 闸被回退也测不红(R2 点名的恒真机理同型)。
    #[test]
    fn manifest_rel_escape_is_refused_by_engine() {
        let (tmp, req, mut m, project) = setup();
        // card/../escape.bin = tmp/escape.bin,真实存在(与清单里的 size 一致)
        fs::write(tmp.path().join("escape.bin"), b"boom").unwrap();
        let mut files = scan_source(&req.source_root).unwrap();
        files.push(("../escape.bin".into(), 4));
        let out = run_copy(&req, &plan_whole_volume(&files), &mut m, &project, |_| {
            CopyControl::Continue
        })
        .unwrap();
        assert!(!out.all_verified);
        assert!(
            out.files.iter().any(|f| f.rel_path == "../escape.bin"
                && matches!(f.status, FileStatus::Failed(_))),
            "逃逸项必须记为失败: {:?}",
            out.files
        );
        // dest.join("../escape.bin") 的解析位置:两个目的地根的上一级
        assert!(
            !tmp.path().join("nas/2. 原始素材/escape.bin").exists()
                && !tmp.path().join("backup/escape.bin").exists(),
            "目的地根外不得出现任何写入"
        );
    }

    /// R2 P0:目的地中间目录被预置为符号链接时必须拒写(canonical 落地闸),
    /// 根外目录不得收到文件。
    #[cfg(unix)]
    #[test]
    fn dest_symlinked_middle_dir_is_refused() {
        let (tmp, req, mut m, project) = setup();
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(&req.destinations[0]).unwrap();
        std::os::unix::fs::symlink(&outside, req.destinations[0].join("DCIM")).unwrap();
        let out = run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        assert!(!out.all_verified, "经链接的写入必须失败");
        assert!(
            !outside.join("100MSDCF").exists(),
            "不得经符号链接把素材写到目的地根外"
        );
    }

    /// R2 P0:清单项指向符号链接源文件时拒拷(不追踪链接目标)。
    #[cfg(unix)]
    #[test]
    fn symlinked_source_file_is_refused() {
        let (_tmp, req, mut m, project) = setup();
        std::os::unix::fs::symlink(
            req.source_root.join("CLIP0001.MP4"),
            req.source_root.join("ALIAS.MP4"),
        )
        .unwrap();
        let mut files = scan_source(&req.source_root).unwrap();
        assert!(files.iter().all(|(r, _)| r != "ALIAS.MP4"), "扫描已跳过");
        files.push(("ALIAS.MP4".into(), 9000));
        let out = run_copy(&req, &plan_whole_volume(&files), &mut m, &project, |_| {
            CopyControl::Continue
        })
        .unwrap();
        assert!(out
            .files
            .iter()
            .any(|f| f.rel_path == "ALIAS.MP4" && matches!(f.status, FileStatus::Failed(_))));
        assert!(!req.destinations[0].join("ALIAS.MP4").exists());
    }

    /// R4 终审 P0-1:目标被替换成**同大小不同内容**后,file_done 不许再判完成
    /// (只查存在+尺寸的旧实现对这条必绿——哈希重验是变异判别点)。
    #[test]
    fn resume_skip_reverifies_hash_not_just_size() {
        let (_t, req, mut m, project) = setup();
        run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        assert!(file_done(
            &m,
            &req.source_root,
            "CLIP0001.MP4",
            "CLIP0001.MP4",
            9000,
            &req.destinations
        ));
        // 同大小篡改:内容换、长度不变
        let victim = req.destinations[1].join("CLIP0001.MP4");
        let mut bytes = fs::read(&victim).unwrap();
        bytes[0] ^= 0xFF;
        fs::write(&victim, &bytes).unwrap();
        assert!(
            !file_done(
                &m,
                &req.source_root,
                "CLIP0001.MP4",
                "CLIP0001.MP4",
                9000,
                &req.destinations
            ),
            "同大小篡改必须让完成判定失效(哈希重验)"
        );
    }

    /// R5 终审:源文件被**同大小**篡改后,resume 不许再跳过——旧目标与清单
    /// 一致但新内容会被漏拷;file_done 必须重验源哈希。
    #[test]
    fn resume_skip_reverifies_source_hash() {
        let (_t, req, mut m, project) = setup();
        run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        assert!(file_done(
            &m,
            &req.source_root,
            "CLIP0001.MP4",
            "CLIP0001.MP4",
            9000,
            &req.destinations
        ));
        let src = req.source_root.join("CLIP0001.MP4");
        let mut bytes = fs::read(&src).unwrap();
        bytes[100] ^= 0xFF;
        fs::write(&src, &bytes).unwrap();
        assert!(
            !file_done(
                &m,
                &req.source_root,
                "CLIP0001.MP4",
                "CLIP0001.MP4",
                9000,
                &req.destinations
            ),
            "源被同大小篡改后不得跳过(会漏拷新内容)"
        );
    }

    /// R5 终审:目的地**中间祖先**是链接时,file_done 不许把链下文件当已完成。
    #[cfg(unix)]
    #[test]
    fn file_done_rejects_dest_ancestor_symlink() {
        let (tmp, req, mut m, project) = setup();
        run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        let rel = "DCIM/IMG_0001.JPG";
        assert!(
            file_done(&m, &req.source_root, rel, rel, 3000, &req.destinations),
            "基线:正常拷完必须判完成"
        );
        // 把 dest0 的 DCIM 换成指向外部同构树的链接(链下同内容文件)
        let outside = tmp.path().join("outside-tree");
        fs::create_dir_all(&outside).unwrap();
        fs::copy(req.destinations[0].join(rel), outside.join("IMG_0001.JPG")).unwrap();
        let dcim = req.destinations[0].join("DCIM");
        fs::remove_dir_all(&dcim).unwrap();
        std::os::unix::fs::symlink(&outside, &dcim).unwrap();
        assert!(
            !file_done(&m, &req.source_root, rel, rel, 3000, &req.destinations),
            "目的地中间祖先为链接时不得判完成(经链接读的是外部文件)"
        );
    }

    /// R4 终审 P0-2:源**祖先**目录被换成指向卡外的链接时,清单项必须被拒
    /// (末节点 is_symlink 挡不住这条)。
    #[cfg(unix)]
    #[test]
    fn source_ancestor_symlink_is_refused() {
        let (tmp, req, mut m, project) = setup();
        let outside = tmp.path().join("outside-src");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("EVIL.MP4"), vec![7u8; 64]).unwrap();
        // 卡上放一个指向卡外的目录链接,清单项穿过它
        std::os::unix::fs::symlink(&outside, req.source_root.join("LINKED")).unwrap();
        let mut files = scan_source(&req.source_root).unwrap();
        files.push(("LINKED/EVIL.MP4".into(), 64));
        let out = run_copy(&req, &plan_whole_volume(&files), &mut m, &project, |_| {
            CopyControl::Continue
        })
        .unwrap();
        assert!(out
            .files
            .iter()
            .any(|f| f.rel_path == "LINKED/EVIL.MP4" && matches!(f.status, FileStatus::Failed(_))));
        assert!(
            !req.destinations[0].join("LINKED/EVIL.MP4").exists(),
            "卡外文件不得经祖先链接被拷贝"
        );
    }

    /// R4 终审 P0-2:既有目标是符号链接时必须拒绝「采信为已完成」——
    /// 经链接做 exists/hash 会把外部文件误当包内既有文件。
    #[cfg(unix)]
    #[test]
    fn existing_target_via_symlink_is_not_adjudicated() {
        let (tmp, req, mut m, project) = setup();
        let outside = tmp.path().join("outside-dst");
        fs::create_dir_all(&outside).unwrap();
        // 外部同内容文件 + 目的地同名链接指过去(同内容→旧逻辑会静默当已完成)
        fs::write(outside.join("CLIP0001.MP4"), vec![3u8; 9000]).unwrap();
        fs::create_dir_all(&req.destinations[0]).unwrap();
        std::os::unix::fs::symlink(
            outside.join("CLIP0001.MP4"),
            req.destinations[0].join("CLIP0001.MP4"),
        )
        .unwrap();
        let out = run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        assert!(
            out.files
                .iter()
                .any(|f| f.rel_path == "CLIP0001.MP4" && matches!(f.status, FileStatus::Failed(_))),
            "链接目标必须显式失败,不许当作已交付: {:?}",
            out.files
        );
    }
}

/// 「按文件夹多选 + 落盘扁平化」贯通到引擎的回归网。
/// 关注点:源/目标分离、落点锁定后的续传身份、清单被篡改时的 fail-closed。
#[cfg(test)]
mod folder_selection_tests {
    use super::*;
    use crate::core::manifest::{self, CopyManifest};
    use tempfile::tempdir;

    /// 一张两个相机夹、且**跨夹重名**的卡(扁平化的典型冲突场景)。
    fn make_card(root: &Path) {
        fs::create_dir_all(root.join("DCIM/100MSDCF")).unwrap();
        fs::create_dir_all(root.join("DCIM/101MSDCF")).unwrap();
        fs::create_dir_all(root.join("EMPTY")).unwrap();
        fs::write(root.join("DCIM/100MSDCF/DSC1.JPG"), vec![1u8; 1000]).unwrap();
        fs::write(root.join("DCIM/100MSDCF/ONLY.JPG"), vec![2u8; 2000]).unwrap();
        fs::write(root.join("DCIM/101MSDCF/DSC1.JPG"), vec![3u8; 3000]).unwrap();
        fs::write(root.join("ROOT.MP4"), vec![4u8; 4000]).unwrap();
    }

    fn setup(
        selection: SourceSelection,
    ) -> (tempfile::TempDir, CopyRequest, CopyManifest, PathBuf) {
        let tmp = tempdir().unwrap();
        let card = tmp.path().join("card");
        make_card(&card);
        let project = tmp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let req = CopyRequest {
            source_root: card,
            destinations: vec![tmp.path().join("nas/target"), tmp.path().join("bak/target")],
            task_tag: "fsel".into(),
            selection,
        };
        let m = CopyManifest::new("target", "card", "A7M4_A_ZS", "ZS", "");
        (tmp, req, m, project)
    }

    fn folders(list: &[&str]) -> SourceSelection {
        SourceSelection::Folders(list.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn empty_selection_is_whole_volume() {
        // 契约:不传/传空数组 = 整卷(老客户端一个字都不用改)
        assert_eq!(
            SourceSelection::from_folders(Vec::new()),
            SourceSelection::WholeVolume
        );
        let tmp = tempdir().unwrap();
        make_card(tmp.path());
        let (a, _, ta) =
            scan_selection(tmp.path(), &SourceSelection::from_folders(Vec::new())).unwrap();
        let (b, _, tb) = scan_selection(tmp.path(), &SourceSelection::WholeVolume).unwrap();
        assert_eq!(a, b);
        assert_eq!(ta, tb);
        assert!(
            a.iter().all(|p| p.source_rel == p.target_rel),
            "整卷源即目标"
        );
    }

    #[test]
    fn folder_selection_flattens_and_separates_source_from_target() {
        let (_t, req, mut m, project) = setup(folders(&["DCIM/100MSDCF"]));
        let (plan, renamed, total) = scan_selection(&req.source_root, &req.selection).unwrap();
        assert_eq!(total, 3000);
        assert!(renamed.is_empty(), "只勾一个夹子不会撞名");
        m.planned = plan.iter().map(manifest::PlannedFile::from_plan).collect();

        let out = run_copy(&req, &plan, &mut m, &project, |_| CopyControl::Continue).unwrap();
        assert!(out.all_verified);
        for d in &req.destinations {
            // 落盘扁平:不带 DCIM/100MSDCF 这层
            assert!(d.join("DSC1.JPG").is_file());
            assert!(d.join("ONLY.JPG").is_file());
            assert!(!d.join("DCIM").exists(), "不得保留源目录结构");
        }
        // 源路径没被当成目标用,目标路径也没被当成源用
        let saved = manifest::load(&project, &m.id).unwrap();
        let mut keys: Vec<&str> = saved.entries.iter().map(|e| e.rel_path.as_str()).collect();
        keys.sort();
        assert_eq!(keys, vec!["DSC1.JPG", "ONLY.JPG"], "清单键必须是目标落点");
        let p = saved
            .planned
            .iter()
            .find(|p| p.rel_path == "DSC1.JPG")
            .unwrap();
        assert_eq!(p.source(), "DCIM/100MSDCF/DSC1.JPG");
    }

    #[test]
    fn renamed_file_resume_is_recognized_by_target_rel() {
        // 核心断言:落点被改写后,续传要按**目标** rel 认出它已经拷过——
        // 按源 rel 认的话每次续传都会重拷(且第二次会撞上「目标已存在」)
        let (_t, req, mut m, project) = setup(folders(&["DCIM/100MSDCF", "DCIM/101MSDCF"]));
        let (plan, renamed, _) = scan_selection(&req.source_root, &req.selection).unwrap();
        assert_eq!(renamed.len(), 2, "两个 DSC1.JPG 必须都被改写并留痕");
        m.planned = plan.iter().map(manifest::PlannedFile::from_plan).collect();
        m.source_selection = req.selection.to_folders();
        m.renamed_files = renamed.clone();

        let out = run_copy(&req, &plan, &mut m, &project, |_| CopyControl::Continue).unwrap();
        assert!(out.all_verified);
        for d in &req.destinations {
            assert!(d.join("100MSDCF_DSC1.JPG").is_file());
            assert!(d.join("101MSDCF_DSC1.JPG").is_file());
            assert!(d.join("ONLY.JPG").is_file());
        }

        // 续传:同一份锁定的计划再跑一遍,必须全部跳过、零字节
        let saved = manifest::load(&project, &m.id).unwrap();
        let resumed: Vec<PlannedFile> = saved.planned.iter().map(|p| p.to_plan()).collect();
        assert_eq!(resumed, plan, "持久化的计划必须能原样还原");
        let out2 = run_copy(&req, &resumed, &mut m, &project, |_| CopyControl::Continue).unwrap();
        assert!(
            out2.files
                .iter()
                .all(|f| f.status == FileStatus::SkippedResume),
            "改名后的续传必须按目标 rel 认出已完成: {:?}",
            out2.files
        );
        assert_eq!(out2.bytes_copied, 0);
        assert!(out2.all_verified);
    }

    #[test]
    fn plan_item_outside_selection_is_refused() {
        // 清单存在 NAS 上可被改写:把源指到没勾选的夹子 = 拿旧授权读别处的文件
        let (_t, req, mut m, project) = setup(folders(&["DCIM/100MSDCF"]));
        let (mut plan, _, _) = scan_selection(&req.source_root, &req.selection).unwrap();
        plan.push(PlannedFile {
            source_rel: "DCIM/101MSDCF/DSC1.JPG".into(),
            target_rel: "偷渡.JPG".into(),
            size: 3000,
        });
        let out = run_copy(&req, &plan, &mut m, &project, |_| CopyControl::Continue).unwrap();
        assert!(
            out.files
                .iter()
                .any(|f| f.rel_path == "偷渡.JPG" && matches!(f.status, FileStatus::Failed(_))),
            "未勾选目录的文件必须显式失败: {:?}",
            out.files
        );
        assert!(!out.all_verified, "有拒绝项绝不能给可格式化信号");
        assert!(!req.destinations[0].join("偷渡.JPG").exists());
    }

    #[test]
    fn whole_volume_plan_must_keep_source_equal_target() {
        // 整卷口径下源≠目标只可能来自清单被动过手脚:拒绝,不许悄悄改落点
        let (_t, req, mut m, project) = setup(SourceSelection::WholeVolume);
        let plan = vec![PlannedFile {
            source_rel: "ROOT.MP4".into(),
            target_rel: "改过的名字.MP4".into(),
            size: 4000,
        }];
        let out = run_copy(&req, &plan, &mut m, &project, |_| CopyControl::Continue).unwrap();
        assert!(matches!(out.files[0].status, FileStatus::Failed(_)));
        assert!(!req.destinations[0].join("改过的名字.MP4").exists());
    }

    /// 目标带目录段(越出扁平口径)必须被**选择闸**拒下——这条测的是
    /// `SourceSelection::allows`;`copy_one` 自己的目标侧路径闸另有直击测试
    /// (`copy_one_refuses_escaping_target_rel`)。
    #[test]
    fn target_rel_escape_is_refused_by_engine() {
        let (tmp, req, mut m, project) = setup(folders(&[""]));
        let plan = vec![PlannedFile {
            source_rel: "ROOT.MP4".into(),
            target_rel: "../逃逸.MP4".into(),
            size: 4000,
        }];
        let out = run_copy(&req, &plan, &mut m, &project, |_| CopyControl::Continue).unwrap();
        assert!(matches!(out.files[0].status, FileStatus::Failed(_)));
        assert!(
            !tmp.path().join("nas/逃逸.MP4").exists() && !tmp.path().join("bak/逃逸.MP4").exists(),
            "目的地根外不得出现任何写入"
        );
    }

    #[test]
    fn list_source_folders_orders_root_first_and_skips_empty_dirs() {
        let tmp = tempdir().unwrap();
        make_card(tmp.path());
        // 只含空子目录的树同样不该出现:点进去什么都没有
        fs::create_dir_all(tmp.path().join("EMPTY/更空")).unwrap();
        fs::create_dir_all(tmp.path().join(".Trashes")).unwrap();
        fs::write(tmp.path().join(".Trashes/junk"), b"x").unwrap();
        let (list, unreadable) = list_source_folders(tmp.path()).unwrap();
        assert!(unreadable.is_empty(), "正常卡不该有读不动的目录");
        let rels: Vec<&str> = list.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(
            rels,
            vec!["", "DCIM", "DCIM/100MSDCF", "DCIM/101MSDCF"],
            "卷根恒第一、字典序;空目录与隐藏项不列"
        );
        let root = &list[0];
        assert_eq!(root.file_count, 1, "卷根只算直接子文件");
        assert_eq!(root.total_bytes, 4000);
        assert!(root.has_subfolders);
        let dcim = &list[1];
        assert_eq!(dcim.file_count, 0, "DCIM 自身没有直接子文件");
        assert!(dcim.has_subfolders, "只有子目录也要列出来,否则点不进去");
        assert_eq!(list[2].file_count, 2);
        assert_eq!(list[2].total_bytes, 3000);
        assert!(!list[2].has_subfolders);
    }

    /// 修复:分组内各算前缀,**跨组**仍可能撞到同一个落点
    /// (根目录本来就有 `100MSDCF_DSC1.JPG`,而 `100MSDCF/DSC1.JPG` 恰好被改成同名)。
    /// 两个源规划到同一落点 = 后者覆盖前者,必须补序号错开。
    #[test]
    fn cross_group_target_collision_never_lands_on_one_file() {
        let f = |rel: &str| (rel.to_string(), 1u64);
        let (planned, renamed) = plan_flat_targets(&[
            f("100MSDCF/DSC1.JPG"),
            f("101MSDCF/DSC1.JPG"),
            f("100MSDCF_DSC1.JPG"),
        ]);
        let targets: Vec<&str> = planned.iter().map(|p| p.target_rel.as_str()).collect();
        let uniq: std::collections::HashSet<&&str> = targets.iter().collect();
        assert_eq!(uniq.len(), targets.len(), "落点必须互不相同: {targets:?}");
        // 没被改动的原名优先级最高:卡根那个文件一个字都不改
        let root = planned
            .iter()
            .find(|p| p.source_rel == "100MSDCF_DSC1.JPG")
            .unwrap();
        assert_eq!(root.target_rel, "100MSDCF_DSC1.JPG");
        // 让路的那个补序号,并且必须出现在改名清单里(不许静默)
        let moved = planned
            .iter()
            .find(|p| p.source_rel == "100MSDCF/DSC1.JPG")
            .unwrap();
        assert_eq!(moved.target_rel, "100MSDCF_DSC1_2.JPG");
        assert!(renamed
            .iter()
            .any(|r| r.target_rel == "100MSDCF_DSC1_2.JPG"));
    }

    /// 修复:落盘名与原名相同的不算「被改写」,不能混进改名清单
    /// (契约:`renamed_files` 只含被改写的;否则双确认屏会出现
    ///  「DSC1.JPG → DSC1.JPG」这种没意义还吓人的条目)。
    #[test]
    fn unchanged_name_is_never_reported_as_renamed() {
        let f = |rel: &str| (rel.to_string(), 1u64);
        // 卡根的 DSC1.JPG 与 100MSDCF/DSC1.JPG 同名:根那个没有目录可加,保持原名
        let (planned, renamed) = plan_flat_targets(&[f("DSC1.JPG"), f("100MSDCF/DSC1.JPG")]);
        let root = planned.iter().find(|p| p.source_rel == "DSC1.JPG").unwrap();
        assert_eq!(root.target_rel, "DSC1.JPG");
        assert_eq!(renamed.len(), 1, "只有真被改名的那个进清单: {renamed:?}");
        assert_eq!(renamed[0].source_rel, "100MSDCF/DSC1.JPG");
        assert_eq!(renamed[0].target_rel, "100MSDCF_DSC1.JPG");
    }

    /// 双路评审 P0/P1:目的地(APFS/exFAT/SMB)通常大小写不敏感,
    /// 按字节判重会规划出两个「不冲突」的落点,拷到第二个时才炸。
    #[test]
    fn case_only_difference_counts_as_a_clash() {
        let f = |rel: &str| (rel.to_string(), 1u64);
        let (planned, renamed) = plan_flat_targets(&[f("A/DSC1.JPG"), f("B/dsc1.jpg")]);
        let targets: Vec<&str> = planned.iter().map(|p| p.target_rel.as_str()).collect();
        assert_eq!(
            targets,
            vec!["A_DSC1.JPG", "B_dsc1.jpg"],
            "必须当成撞名各自加前缀"
        );
        assert_eq!(renamed.len(), 2, "两个都被改写,都要进清单");
    }

    /// 清单可被改写:两项共用一个落点时,第二项会被续传判定当成「已完成」跳过,
    /// 整批却仍报完成 = 静默漏拷。闸必须在任何副作用之前。
    #[test]
    fn duplicate_targets_in_plan_are_refused_before_any_write() {
        let (_t, req, mut m, project) = setup(folders(&["DCIM/100MSDCF", "DCIM/101MSDCF"]));
        let plan = vec![
            PlannedFile {
                source_rel: "DCIM/100MSDCF/DSC1.JPG".into(),
                target_rel: "X.JPG".into(),
                size: 1000,
            },
            PlannedFile {
                source_rel: "DCIM/101MSDCF/DSC1.JPG".into(),
                target_rel: "x.jpg".into(), // 大小写不同 = 同一个落点
                size: 3000,
            },
        ];
        let e = run_copy(&req, &plan, &mut m, &project, |_| CopyControl::Continue).unwrap_err();
        assert!(e.to_string().contains("同一个落点"), "{e}");
        assert!(!req.destinations[0].exists(), "拒绝要发生在任何写入之前");
    }

    /// 落点不许占用引擎内部的 `.ocardpart` 命名空间:临时文件与正式文件同目录,
    /// 别人的正式文件正好叫某项的 part 名时会被残留清理删掉。
    #[test]
    fn target_using_internal_part_suffix_is_refused() {
        let (_t, req, mut m, project) = setup(folders(&[""]));
        let plan = vec![PlannedFile {
            source_rel: "ROOT.MP4".into(),
            target_rel: format!("ROOT.MP4.{}{}", req.task_tag, PART_SUFFIX),
            size: 4000,
        }];
        let e = run_copy(&req, &plan, &mut m, &project, |_| CopyControl::Continue).unwrap_err();
        assert!(e.to_string().contains(PART_SUFFIX), "{e}");
    }

    /// 目标侧路径闸的**直击**测试:反斜杠段过得了 `allows`(不含 `/`),
    /// 但过不了 `is_safe_rel`——删掉 copy_one 里目标侧那道闸,本测试必红。
    #[test]
    fn copy_one_refuses_escaping_target_rel() {
        let (_t, req, mut m, project) = setup(folders(&[""]));
        let plan = vec![PlannedFile {
            source_rel: "ROOT.MP4".into(),
            target_rel: r"..\逃逸.MP4".into(),
            size: 4000,
        }];
        assert!(
            req.selection.allows("ROOT.MP4", r"..\逃逸.MP4"),
            "前置断言:这条要能过选择闸,才谈得上测目标侧路径闸"
        );
        let out = run_copy(&req, &plan, &mut m, &project, |_| CopyControl::Continue).unwrap();
        assert!(
            matches!(&out.files[0].status, FileStatus::Failed(e) if e.contains("清单相对路径非法")),
            "必须被目标侧路径闸拒: {:?}",
            out.files[0].status
        );
    }

    /// 零静默 + 可用性:相机卡上常有 Windows 留下的受限目录
    /// (`System Volume Information`),它不该让整个文件夹选择器不可用,
    /// 但被跳过的目录必须逐条报出来。
    #[cfg(unix)]
    #[test]
    fn unreadable_subdir_is_skipped_and_reported_not_fatal() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempdir().unwrap();
        make_card(tmp.path());
        let locked = tmp.path().join("System Volume Information");
        fs::create_dir_all(&locked).unwrap();
        fs::write(locked.join("inside.bin"), b"x").unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

        let (list, unreadable) = list_source_folders(tmp.path()).unwrap();
        // 复原权限,别把不可删目录留给 TempDir
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();

        assert!(
            list.iter().any(|f| f.rel_path == "DCIM/100MSDCF"),
            "其余目录必须照常可选"
        );
        assert_eq!(
            unreadable.len(),
            1,
            "读不动的目录必须报出来: {unreadable:?}"
        );
        assert_eq!(unreadable[0].rel_path, "System Volume Information");
        assert!(!unreadable[0].reason.is_empty());
    }

    /// 选择项非法时,扫描入口自己就要拒(续传时选择来自可被改写的 manifest)。
    #[test]
    fn scan_selection_refuses_escaping_folder() {
        let tmp = tempdir().unwrap();
        make_card(tmp.path());
        let e = scan_selection(tmp.path(), &folders(&["../外面"])).unwrap_err();
        assert!(e.to_string().contains("源文件夹路径非法"), "{e}");
    }

    #[test]
    fn missing_folder_reports_readable_error_not_empty_list() {
        // 零静默:选中的夹子没了要说人话,绝不能返回空清单让用户以为卡是空的
        let tmp = tempdir().unwrap();
        make_card(tmp.path());
        let e = scan_selection(tmp.path(), &folders(&["DCIM/199MSDCF"])).unwrap_err();
        let msg = e.to_string();
        assert!(
            msg.contains("DCIM/199MSDCF") && msg.contains("不存在"),
            "{msg}"
        );
    }
}
