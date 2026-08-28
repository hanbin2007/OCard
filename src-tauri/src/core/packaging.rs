//! 交付打包(M2 任务4,PRD §5.7 / 规范第八条):
//! 将分好类的素材按**拍摄时间半天**分包(不压缩),生成交付清单;
//! 上传百度网盘与发链接由人工完成(既定边界)。
//!
//! 不变量:
//! - 打包是**复制**,分类夹原件不动;
//! - 复制走 staging:先写唯一临时文件,**hash 校验**后原子改名落位——
//!   NAS 断连/断电绝不在包里留半截文件(codex 评审 P0);
//! - 零覆盖:包内已存在同名文件时 hash 比对——内容相同视为已交付(重跑安全),
//!   内容不同报 `name-collision`,绝不静默当成功(评审 H5);
//! - 半天判定用 EXIF **墙钟**(相机表盘时间),不做时区换算(codex 评审 9);
//! - 清单从目标包目录**实况**生成(重跑后口径正确,评审 M5);
//!   清单写失败降级为失败项上报,**绝不丢弃已完成的复制结果**(评审 H1);
//! - 分类夹内的子目录**扁平化**落包(包内按「包/分类/文件名」组织):
//!   跨子目录同名会报 name-collision 由人工裁决,属声明行为;
//! - 符号链接一律不交付(collect 不跟随,逐条警告);包目录落地前
//!   canonicalize 断言在项目内。

use super::project::{self, Scenario};
use super::{fsx, hash, media, CoreError, Result};
use chrono::{DateTime, Local, NaiveDateTime, Timelike, Utc};
use std::fs;
use std::path::{Path, PathBuf};

/// 交付根目录名(位于项目根下,不参与工况 B 序号体系)。
pub const DELIVERY_DIR: &str = "交付";
const MANIFEST_NAME: &str = "清单.txt";
const SUMMARY_NAME: &str = "交付总清单.txt";

/// 半天键:`MMDD上午` / `MMDD下午`。入参是**墙钟**(EXIF 原样时间或
/// 本地化后的 mtime),不含时区——半天归属以拍摄现场的表盘为准。
pub fn half_day_key(t: NaiveDateTime) -> String {
    use chrono::Datelike;
    let half = if t.hour() < 12 { "上午" } else { "下午" };
    format!("{:02}{:02}{half}", t.month(), t.day())
}

#[derive(Debug, Clone)]
pub struct PackagedFile {
    pub source_rel: String,
    pub category: String,
    pub package: String,
    pub size_bytes: u64,
}

#[derive(Debug, Default)]
pub struct DeliveryOutcome {
    /// 本轮涉及的包(有新复制或校验确认的)。
    pub packages: Vec<String>,
    /// 本轮**新复制**的文件。
    pub files: Vec<PackagedFile>,
    /// 已在包内且 hash 一致的文件数(重跑时的正常情况,校验过的安全跳过)。
    pub already_delivered: usize,
    /// 逐文件失败(路径, 机器码, 原因)——零静默。
    /// 机器码: "name-collision"(同名不同内容,需人工裁决)| "error" | "manifest-error"。
    pub failures: Vec<(String, &'static str, String)>,
    /// 目录扫描降级警告(不可读目录等),调用方须转通知。
    pub warnings: Vec<String>,
    /// 本轮新复制的字节数。
    pub total_bytes: u64,
    /// 各包**实况**总量(名称, 文件数, 字节)——从目标目录实扫,
    /// 重跑时也是真实累计口径(codex 复验:包计数不能只数本轮新复制)。
    pub package_totals: Vec<(String, usize, u64)>,
    /// 本轮被用户取消(取消也按实况写清单,目录不留说谎态——计划 W2)。
    pub cancelled: bool,
}

/// 打包时排除的条目。口径必须与拷卡扫描**同一份**([`super::copy::is_system_item`]):
/// R11 之后拷卡会把 `.clip.mov` 这类点开头的合法素材真的拷进素材夹,打包时再按
/// 「点开头」把它筛掉,就是在交付环节静默漏掉一个素材——而包清单照样报完整。
fn is_hidden(name: &str) -> bool {
    super::copy::is_system_item(name)
}

/// 单文件落包的 staging 临时名后缀(见 [`deliver_one`])。
const DELIVERY_PART_SUFFIX: &str = ".deliverypart";
/// 清单原子写的 staging 临时名后缀(见 [`write_atomic`])。
const MANIFEST_PART_SUFFIX: &str = ".manifestpart";

/// packaging **自己**在 NAS 上留下的半截文件的识别(R13 B2)。
///
/// 两种临时名(`.<uuid>.deliverypart` / `.<uuid>.manifestpart`)是「先写唯一临时
/// 名、校验/写完再原子改名」这套零覆盖写法的**设计产物**:进程被杀、NAS 断连、
/// 断电时它们按设计留在交付目录里,内容是**不完整的**。重跑交付时若不认出来,
/// 它们会作为普通文件进入包清单、包文件数与容量——交付一个截断的文件比漏掉它更坏。
///
/// **为什么不扩大 `copy::SYSTEM_ITEM_SUFFIXES`**:那份名单是**源卷**扫描的口径。
/// 卡上永远不会出现 packaging 的内部临时名,把 NAS 内部命名塞进源卷白名单等于
/// 让「卡上什么不算素材」这条判据白白变宽,而变宽的方向就是漏拷。判据留在
/// packaging 内部,并且认得**严**:必须是 `.` + 规范 UUID(8-4-4-4-12 十六进制)
/// + 固定后缀,少一位都不认——认宽了就会吞掉用户真的叫这个名字的交付物。
///
/// 返回 `Some(人话种类)` 表示命中。
fn packaging_temp_kind(name: &str) -> Option<&'static str> {
    let (uuid, kind) = if let Some(rest) = name.strip_suffix(DELIVERY_PART_SUFFIX) {
        (rest, "落包")
    } else {
        (name.strip_suffix(MANIFEST_PART_SUFFIX)?, "清单")
    };
    let uuid = uuid.strip_prefix('.')?;
    // uuid::Uuid 的解析比手写字符校验严(段长、连字符位置都查),直接用它
    uuid::Uuid::try_parse(uuid).ok().map(|_| kind)
}

fn out_push_entry_err(warnings: &mut Vec<String>, dir: &Path, err: std::io::Error) {
    warnings.push(format!("目录 {} 中有条目读取失败: {err}", dir.display()));
}

/// 收集一个目录下的全部文件(递归,只排除系统项,见 [`is_hidden`]);
/// 不可读目录计入警告,不静默。
/// **不跟随符号链接**(复验轮二 P0:链接目录会把收集范围递归到项目外),
/// 链接条目跳过并警告。
fn collect(dir: &Path, warnings: &mut Vec<String>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let entries = match fs::read_dir(&d) {
            Ok(e) => e,
            Err(e) => {
                if d != *dir || d.exists() {
                    warnings.push(format!("无法读取目录 {}: {e}", d.display()));
                }
                continue;
            }
        };
        for e in entries {
            let e = match e {
                Ok(e) => e,
                Err(err) => {
                    // 逐项枚举错误不许静默丢:漏文件要可见(终审零静默)
                    out_push_entry_err(warnings, &d, err);
                    continue;
                }
            };
            let name = e.file_name();
            let name = name.to_string_lossy();
            // R13 B2:packaging 自己的半截文件——隔离(不进包、不进清单计数)
            // **并且告警**,绝不静默跳过:它是上次打包被打断的证据,用户有权知道
            // 交付目录里躺着一个不完整的文件。
            if let Some(kind) = packaging_temp_kind(&name) {
                warnings.push(format!(
                    "交付目录里发现上次打包中断留下的半截{kind}文件,已隔离(不计入本次交付与包清单): {} —— 确认无用后可手工删除",
                    e.path().display()
                ));
                continue;
            }
            if is_hidden(&name) {
                continue;
            }
            let p = e.path();
            // DirEntry::file_type 不解析链接:链接一律不进包
            match e.file_type() {
                Ok(t) if t.is_symlink() => {
                    warnings.push(format!("跳过符号链接(不交付): {}", p.display()));
                }
                Ok(t) if t.is_dir() => stack.push(p),
                Ok(t) if t.is_file() => out.push(p),
                Ok(_) => warnings.push(format!("跳过非常规文件: {}", p.display())),
                Err(e) => warnings.push(format!("无法读取条目 {}: {e}", p.display())),
            }
        }
    }
    out.sort();
    out
}

/// 单文件落包:staging 复制 + hash 校验 + 原子改名;已存在时 hash 裁决。
/// 目标目录经 canonicalize 断言在项目内(复验轮二 P0:交付目录被换成
/// 符号链接不许把包写出项目)。返回 Ok(true)=新复制,Ok(false)=已交付。
fn deliver_one(
    project_root: &Path,
    src: &Path,
    src_meta: &fs::Metadata,
    dst_dir: &Path,
    dst: &Path,
) -> std::result::Result<bool, (&'static str, String)> {
    // R5(终审 P0-7):时间戳快照由调用方在**任何读源之前**(含 EXIF 半天
    // 判定的那次打开)采集并传入——本函数内不再二次采集
    let verdict_existing = |src: &Path, dst: &Path| {
        let sh = hash::xxh3_file(src).map_err(|e| ("error", format!("源文件校验失败: {e}")))?;
        let dh =
            hash::xxh3_file(dst).map_err(|e| ("error", format!("包内既有文件校验失败: {e}")))?;
        if sh == dh {
            Ok(false)
        } else {
            Err((
                "name-collision",
                "包内已存在同名但内容不同的文件(可能是上次中断残留或另一来源同名),已拒绝覆盖;请人工核对包内文件后再重打".to_string(),
            ))
        }
    };
    // 闸在一切判定与副作用之前(终审复票 P0):包目录先过落地闸
    // (探针先行,链接祖先下不会先在项目外建目录),dst 自身是链接也拒
    // (经链接做 exists/hash 判定会把外部文件误当包内既有文件)。
    super::paths::ensure_dir_within(project_root, dst_dir).map_err(|e| ("error", e))?;
    if super::paths::is_symlink(dst) {
        return Err((
            "error",
            format!("目标位置是符号链接,拒绝交付: {}", dst.display()),
        ));
    }
    if dst.exists() {
        return verdict_existing(src, dst);
    }
    let tmp = dst_dir.join(format!(".{}{DELIVERY_PART_SUFFIX}", uuid::Uuid::new_v4()));
    if let Err(e) = fs::copy(src, &tmp) {
        let _ = fs::remove_file(&tmp);
        return Err(("error", format!("复制失败: {e}")));
    }
    // 校验:源按普通读,落地文件绕页缓存回读,尽量读介质而非内存
    let sh = hash::xxh3_file(src);
    let th = hash::xxh3_file_uncached(&tmp);
    match (sh, th) {
        (Ok(a), Ok(b)) if a == b => {}
        (Ok(_), Ok(_)) => {
            let _ = fs::remove_file(&tmp);
            return Err((
                "error",
                "复制后校验不一致(介质或网络异常),已删除半成品".into(),
            ));
        }
        (Err(e), _) | (_, Err(e)) => {
            let _ = fs::remove_file(&tmp);
            return Err(("error", format!("复制校验失败: {e}")));
        }
    }
    match fsx::rename_no_replace(&tmp, dst) {
        Ok(()) => {
            // 保留源时间戳(快照由调用方在读源前采集)
            fsx::preserve_times_counted(src_meta, dst);
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // 并发竞争:别机先落位。弃临时文件,按既有文件裁决
            let _ = fs::remove_file(&tmp);
            verdict_existing(src, dst)
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(("error", format!("落位失败: {e}")))
        }
    }
}

/// 执行交付打包:纳入全部自定义分类 + 精选/已修 + 其他(规范第八条)。
/// 待分类与精选/待修不纳入(未完成分类/修图的不交付)。
/// 夹角色按布局下标判定,不猜目录名(评审 M1)。
pub fn build_delivery(project_root: &Path, meta: &project::ProjectMeta) -> Result<DeliveryOutcome> {
    build_delivery_with(project_root, meta, &mut |_, _, _, _| {}, &|| false)
}

/// 带进度与取消的交付打包(M3 W2 作业化):
/// `progress(done, total, bytes_done, current_rel)` 逐文件回调;
/// `cancelled()` 为真时在**文件边界**停止复制——清单仍按实况生成。
pub fn build_delivery_with(
    project_root: &Path,
    meta: &project::ProjectMeta,
    progress: &mut dyn FnMut(usize, usize, u64, &str),
    cancelled: &dyn Fn() -> bool,
) -> Result<DeliveryOutcome> {
    if meta.scenario != Scenario::B {
        return Err(CoreError::Invalid("交付打包仅适用于工况 B".into()));
    }
    let dirs = project::scenario_b_dirs(&meta.categories);
    let last = dirs.len() - 1;
    let mut sources: Vec<(String, PathBuf)> = Vec::new();
    for (i, folder) in dirs.iter().enumerate() {
        if i == 0 {
            continue; // 待分类不交付
        }
        if i == last - 1 {
            // 精选夹:只交付「已修」
            sources.push((
                format!("{folder}/{}", project::CURATED_DONE),
                project_root.join(folder).join(project::CURATED_DONE),
            ));
        } else {
            sources.push((folder.clone(), project_root.join(folder)));
        }
    }

    let delivery_root = project_root.join(DELIVERY_DIR);
    let mut out = DeliveryOutcome::default();

    // 先收集全部待处理文件(总数给进度),再逐个落包
    let mut work: Vec<(String, PathBuf)> = Vec::new();
    for (category, dir) in &sources {
        // 分类夹本身或其祖先被换成链接:整夹拒绝交付(终审复票:
        // 只查夹自身不够,「精选/已修」的父夹是链接同样会把扫描带出项目)
        let dir_escapes = super::paths::is_symlink(dir)
            || (dir.exists()
                && !matches!(
                    (fs::canonicalize(project_root), fs::canonicalize(dir)),
                    (Ok(cr), Ok(cd)) if super::paths::comparison_key(&cd)
                        .starts_with(super::paths::comparison_key(&cr))
                ));
        if dir_escapes {
            out.failures.push((
                category.clone(),
                "error",
                "分类夹实际位置在项目外(自身或祖先是符号链接),拒绝交付该夹".to_string(),
            ));
            continue;
        }
        for file in collect(dir, &mut out.warnings) {
            work.push((category.clone(), file));
        }
    }

    let total = work.len();
    let mut bytes_done: u64 = 0;
    for (i, (category, file)) in work.iter().enumerate() {
        if cancelled() {
            out.cancelled = true;
            break;
        }
        let rel = file
            .strip_prefix(project_root)
            .unwrap_or(file)
            .to_string_lossy()
            .replace('\\', "/");
        progress(i, total, bytes_done, &rel);
        // 与交付清单保留名撞名的源文件必须显式拒绝:静默交付会被清单
        // 生成器漏计/覆盖(codex 复验 P0;大小写不敏感)
        if let Some(name) = file.file_name().and_then(|n| n.to_str()) {
            let lower = name.to_lowercase();
            if lower == MANIFEST_NAME || lower == SUMMARY_NAME {
                out.failures.push((
                    rel,
                    "error",
                    format!("文件名与交付清单保留名「{name}」冲突,请改名后重新打包"),
                ));
                continue;
            }
        }
        let meta_fs = match fs::metadata(file) {
            Ok(m) => m,
            Err(e) => {
                out.failures.push((rel, "error", format!("读取失败: {e}")));
                continue;
            }
        };
        // 半天判定:EXIF 墙钟优先;无 EXIF 用 mtime 的本地墙钟;都没有用当前本地时间
        let shot = media::exif_shot_naive(file)
            .or_else(|| {
                meta_fs
                    .modified()
                    .ok()
                    .map(|m| DateTime::<Utc>::from(m).with_timezone(&Local).naive_local())
            })
            .unwrap_or_else(|| Local::now().naive_local());
        let package = half_day_key(shot);
        let dst_dir = delivery_root.join(&package).join(category);
        let dst = dst_dir.join(file.file_name().unwrap_or_default());

        match deliver_one(project_root, file, &meta_fs, &dst_dir, &dst) {
            Ok(newly_copied) => {
                if !out.packages.contains(&package) {
                    out.packages.push(package.clone());
                }
                if newly_copied {
                    out.total_bytes += meta_fs.len();
                    bytes_done += meta_fs.len();
                    out.files.push(PackagedFile {
                        source_rel: rel,
                        category: category.clone(),
                        package,
                        size_bytes: meta_fs.len(),
                    });
                } else {
                    out.already_delivered += 1;
                }
            }
            Err((kind, e)) => out.failures.push((rel, kind, e)),
        }
    }
    progress(
        total.min(out.files.len() + out.already_delivered + out.failures.len()),
        total,
        bytes_done,
        "清单生成中",
    );
    out.packages.sort();

    write_manifests(project_root, &delivery_root, &mut out);
    Ok(out)
}

/// 清单一律从目标包目录**实况**生成(重跑/多轮后口径始终正确);
/// 写失败降级为 `manifest-error` 失败项,不中断、不丢结果(评审 H1)。
fn write_manifests(project_root: &Path, delivery_root: &Path, out: &mut DeliveryOutcome) {
    // 交付根过落地闸:被换成链接时清单绝不写到项目外(终审 P0)
    if delivery_root.exists() {
        if let Err(e) = super::paths::ensure_dir_within(project_root, delivery_root) {
            out.failures.push((
                DELIVERY_DIR.to_string(),
                "manifest-error",
                format!("交付目录校验失败,清单未写入: {e}"),
            ));
            return;
        }
    }
    let mut pkg_dirs: Vec<String> = match fs::read_dir(delivery_root) {
        Ok(entries) => {
            let mut dirs = Vec::new();
            for e in entries {
                // 逐项错误与链接条目都不许静默(终审复票:包目录本身是链接
                // 会把清单写出项目;枚举错误会让清单漏包)
                match e {
                    Ok(e) => {
                        let name = e.file_name().to_string_lossy().to_string();
                        if is_hidden(&name) {
                            continue;
                        }
                        match e.file_type() {
                            Ok(t) if t.is_symlink() => out.failures.push((
                                format!("{DELIVERY_DIR}/{name}"),
                                "manifest-error",
                                "包目录是符号链接,清单未写入,需人工核查".to_string(),
                            )),
                            Ok(t) if t.is_dir() => dirs.push(name),
                            Ok(_) => {} // 交付根下的普通文件(总清单等),不是包
                            Err(err) => out.failures.push((
                                format!("{DELIVERY_DIR}/{name}"),
                                "manifest-error",
                                format!("条目类型读取失败,清单可能漏包: {err}"),
                            )),
                        }
                    }
                    Err(err) => out.failures.push((
                        DELIVERY_DIR.to_string(),
                        "manifest-error",
                        format!("交付目录枚举出错,清单可能不完整: {err}"),
                    )),
                }
            }
            dirs
        }
        Err(e) => {
            if delivery_root.exists() {
                out.failures.push((
                    DELIVERY_DIR.to_string(),
                    "manifest-error",
                    format!("无法读取交付目录,清单未更新: {e}"),
                ));
            }
            return; // 交付根不存在 = 本轮无任何产出,无清单可写
        }
    };
    pkg_dirs.sort();

    let mut summary_rows: Vec<(String, usize, u64)> = Vec::new();
    for pkg in &pkg_dirs {
        let pkg_dir = delivery_root.join(pkg);
        let mut warnings = Vec::new();
        let files: Vec<PathBuf> = collect(&pkg_dir, &mut warnings)
            .into_iter()
            .filter(|p| p.file_name().map(|n| n != MANIFEST_NAME).unwrap_or(true))
            .collect();
        out.warnings.extend(warnings);
        let mut bytes = 0u64;
        let mut text = String::new();
        for f in &files {
            let size = fs::metadata(f).map(|m| m.len()).unwrap_or(0);
            bytes += size;
            text.push_str(&format!(
                "{}\t{} 字节\n",
                f.strip_prefix(&pkg_dir).unwrap_or(f).display(),
                size
            ));
        }
        let head = format!(
            "OCard 交付清单\n包: {pkg}\n生成时间: {}\n文件数: {}\n总容量: {} 字节\n\n",
            Local::now().format("%Y-%m-%d %H:%M:%S"),
            files.len(),
            bytes
        );
        if let Err(e) = write_atomic(&pkg_dir.join(MANIFEST_NAME), &(head + &text)) {
            out.failures.push((
                format!("{DELIVERY_DIR}/{pkg}/{MANIFEST_NAME}"),
                "manifest-error",
                format!("包清单写入失败(文件已交付成功,仅清单缺失,可重跑补齐): {e}"),
            ));
        }
        summary_rows.push((pkg.clone(), files.len(), bytes));
    }

    let mut summary = format!(
        "OCard 交付总清单\n生成时间: {}\n包数: {}\n文件数: {}\n总容量: {} 字节\n本轮失败: {}\n\n",
        Local::now().format("%Y-%m-%d %H:%M:%S"),
        summary_rows.len(),
        summary_rows.iter().map(|r| r.1).sum::<usize>(),
        summary_rows.iter().map(|r| r.2).sum::<u64>(),
        out.failures.len()
    );
    for (pkg, n, b) in &summary_rows {
        summary.push_str(&format!("{pkg}\t{n} 个文件\t{b} 字节\n"));
    }
    for (rel, kind, e) in &out.failures {
        summary.push_str(&format!("[{kind}] {rel}: {e}\n"));
    }
    if let Err(e) = write_atomic(&delivery_root.join(SUMMARY_NAME), &summary) {
        out.failures.push((
            format!("{DELIVERY_DIR}/{SUMMARY_NAME}"),
            "manifest-error",
            format!("总清单写入失败(文件交付结果不受影响,可重跑补齐): {e}"),
        ));
    }
    out.package_totals = summary_rows;
}

/// 派生文件(清单)的原子写:唯一临时文件 + rename 替换(清单允许重生成覆盖)。
fn write_atomic(path: &Path, content: &str) -> std::io::Result<()> {
    if super::paths::is_symlink(path) {
        // 清单位置被链接占据:拒绝(rename 替换会写穿链接目标)
        return Err(std::io::Error::other("清单位置是符号链接,拒绝写入"));
    }
    let dir = path.parent().unwrap_or(Path::new("."));
    let tmp = dir.join(format!(".{}{MANIFEST_PART_SUFFIX}", uuid::Uuid::new_v4()));
    fs::write(&tmp, content.as_bytes())?;
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use tempfile::tempdir;

    #[test]
    fn half_day_key_splits_at_noon_on_wall_clock() {
        // codex 评审 9 的边界用例:墙钟 11:59 是上午,12:00 是下午,与时区无关
        let d = NaiveDate::from_ymd_opt(2026, 8, 24).unwrap();
        assert_eq!(half_day_key(d.and_hms_opt(11, 59, 59).unwrap()), "0824上午");
        assert_eq!(half_day_key(d.and_hms_opt(12, 0, 0).unwrap()), "0824下午");
        assert_eq!(half_day_key(d.and_hms_opt(0, 0, 0).unwrap()), "0824上午");
    }

    fn setup() -> (tempfile::TempDir, PathBuf, project::ProjectMeta) {
        let tmp = tempdir().unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 8, 24).unwrap();
        let root =
            project::create_project(tmp.path(), date, "校运会", Scenario::B, &["开幕式".into()])
                .unwrap();
        let meta = project::load_meta(&root).unwrap();
        fs::write(root.join("2. 开幕式/a.jpg"), vec![1u8; 100]).unwrap();
        fs::write(root.join("2. 开幕式/b.jpg"), vec![2u8; 200]).unwrap();
        fs::write(root.join("3. 精选/已修/hero.jpg"), vec![3u8; 300]).unwrap();
        // 待修与待分类不应交付
        fs::write(root.join("3. 精选/待修/raw.jpg"), vec![4u8; 50]).unwrap();
        fs::create_dir_all(root.join("1. 待分类/x")).unwrap();
        fs::write(root.join("1. 待分类/x/n.jpg"), vec![5u8; 60]).unwrap();
        (tmp, root, meta)
    }

    #[test]
    fn delivery_packages_and_rerun_is_verified_skip() {
        let (_t, root, meta) = setup();
        let out = build_delivery(&root, &meta).unwrap();
        assert_eq!(out.files.len(), 3);
        assert!(out.failures.is_empty(), "{:?}", out.failures);
        assert_eq!(out.already_delivered, 0);
        assert_eq!(out.total_bytes, 600);
        assert!(!out.packages.is_empty());

        let delivery = root.join(DELIVERY_DIR);
        assert!(delivery.join(SUMMARY_NAME).is_file());
        let pkg = &out.packages[0];
        assert!(delivery.join(pkg).join(MANIFEST_NAME).is_file());
        assert!(delivery.join(pkg).join("2. 开幕式/a.jpg").is_file());
        // 原件不动
        assert!(root.join("2. 开幕式/a.jpg").is_file());
        // 待修/待分类没进包
        let all: Vec<String> = out.files.iter().map(|f| f.source_rel.clone()).collect();
        assert!(!all
            .iter()
            .any(|r| r.contains("待修") || r.contains("待分类")));
        // 不残留 staging 临时文件
        let mut stack = vec![delivery.clone()];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).unwrap().flatten() {
                assert!(
                    !e.file_name().to_string_lossy().contains("deliverypart"),
                    "不许残留 staging 文件"
                );
                if e.path().is_dir() {
                    stack.push(e.path());
                }
            }
        }

        // 重跑:hash 一致 → 已交付跳过,不是失败(评审 H5)
        let again = build_delivery(&root, &meta).unwrap();
        assert_eq!(again.files.len(), 0);
        assert!(again.failures.is_empty(), "{:?}", again.failures);
        assert_eq!(again.already_delivered, 3);
        // 清单从实况生成:重跑后包清单仍列出全部 3 个文件(评审 M5)
        let manifest = fs::read_to_string(delivery.join(pkg).join(MANIFEST_NAME)).unwrap();
        assert!(manifest.contains("a.jpg") && manifest.contains("hero.jpg"));
        assert!(manifest.contains("文件数: 3") || manifest.contains("文件数: 2"),);
    }

    /// R13 B1(P0):打包腿的白名单**回归覆盖**。
    ///
    /// 评审做的变异:把 packaging 的排除收窄到只挡 `.ocard`(放行 `.ocardpart`、
    /// `@eaDir`、`._*`、`Thumbs.db`)——273 个用例**全绿**。也就是说「六处统一」
    /// 里的第六处只钉住了 1/N 的判据,而没钉住的恰好是本轮专门为它新增
    /// `SYSTEM_ITEM_SUFFIXES` 的那一项:`.ocardpart` 是断连留下的**半截文件**,
    /// 交付一个截断的文件比漏掉它更坏。全局退回旧判据的变异没抓到,是因为
    /// `.ocard` 本身以点开头、旧判据照样挡得住——一个正确的断言掩护了一整条
    /// 未覆盖的腿。
    ///
    /// 判别性:把 `is_hidden` 换成任何比 `copy::is_system_item` 窄的判据
    /// (只挡 `.ocard`、或退回 `starts_with('.')`),本测试必红。
    #[test]
    fn delivery_excludes_every_class_of_system_item_not_just_dot_prefixed() {
        let (_t, root, meta) = setup();
        let cat = root.join("2. 开幕式");
        // 拷卡引擎断连留下的**半截**素材文件(不以点开头,旧判据从来没挡住过)
        fs::write(cat.join("CLIP.MP4.t7f3a2.ocardpart"), vec![9u8; 11]).unwrap();
        // 群晖自己生成的低码率预览(目录名不以点开头)
        fs::create_dir_all(cat.join("@eaDir")).unwrap();
        fs::write(cat.join("@eaDir/SYNOPHOTO_FILM_x.mp4"), vec![9u8; 12]).unwrap();
        // AppleDouble 伴生文件
        fs::write(cat.join("._CLIP.MP4"), vec![9u8; 13]).unwrap();
        // 资源管理器缩略图缓存(不以点开头)
        fs::write(cat.join("Thumbs.db"), vec![9u8; 14]).unwrap();
        // 精选复制的半截文件(不以点开头)
        fs::write(
            root.join("3. 精选/已修/.9f1c0f6e-0000-4000-8000-000000000000.curatepart"),
            vec![9u8; 15],
        )
        .unwrap();
        // 真素材(点开头,必须**照常交付**——反方向的静默漏交付同样不可接受)
        fs::write(cat.join(".clip.mov"), vec![7u8; 16]).unwrap();

        let out = build_delivery(&root, &meta).unwrap();
        assert!(out.failures.is_empty(), "{:?}", out.failures);

        // 包里到底有什么:实扫交付目录(不信任 out.files,它只记本轮新复制的)
        let delivery = root.join(DELIVERY_DIR);
        let mut delivered: Vec<String> = Vec::new();
        let mut stack = vec![delivery.clone()];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).unwrap().flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if e.path().is_dir() {
                    stack.push(e.path());
                } else if n != MANIFEST_NAME && n != SUMMARY_NAME {
                    delivered.push(n);
                }
            }
        }
        delivered.sort();
        assert_eq!(
            delivered,
            vec![
                ".clip.mov".to_string(),
                "a.jpg".to_string(),
                "b.jpg".to_string(),
                "hero.jpg".to_string(),
            ],
            "包里只许有真素材(含点开头的合法素材),系统项一个都不许进"
        );

        // 包清单同样不许把系统项算进文件数/容量
        for pkg in &out.packages {
            let text = fs::read_to_string(delivery.join(pkg).join(MANIFEST_NAME)).unwrap();
            for junk in [
                "ocardpart",
                "SYNOPHOTO_FILM",
                "._CLIP.MP4",
                "Thumbs.db",
                "curatepart",
            ] {
                assert!(
                    !text.contains(junk),
                    "包清单里混进了系统项「{junk}」:\n{text}"
                );
            }
        }
    }

    /// R13 B2(P1):packaging **自己**的半截文件(`.<uuid>.deliverypart` /
    /// `.<uuid>.manifestpart`)。进程被杀后它们残留在交付目录里,重跑交付时会
    /// 作为正常文件进入包清单、文件数与容量。必须隔离,而且必须**可见告警**。
    ///
    /// 判别性:去掉 `collect` 里的 `packaging_temp_kind` 分支,第一组断言必红;
    /// 把告警改成静默 `continue`,第二组必红。
    #[test]
    fn packaging_own_leftover_parts_are_isolated_and_reported() {
        let (_t, root, meta) = setup();
        let first = build_delivery(&root, &meta).unwrap();
        let delivery = root.join(DELIVERY_DIR);
        let pkg_dir = delivery.join(&first.packages[0]).join("2. 开幕式");

        // 模拟「复制到一半进程被杀」:两种 staging 名各留一个
        let leftover_copy = pkg_dir.join(".2f1c0f6e-1111-4000-8000-000000000000.deliverypart");
        let leftover_manifest = pkg_dir.join(".3a2b0f6e-2222-4000-8000-000000000000.manifestpart");
        fs::write(&leftover_copy, vec![9u8; 4096]).unwrap();
        fs::write(&leftover_manifest, b"half written").unwrap();
        // 只是名字**像**、UUID 不合规范的用户文件:判据必须认得严,不许吞掉它
        let lookalike = pkg_dir.join(".not-a-uuid.deliverypart");
        fs::write(&lookalike, b"user file").unwrap();

        let out = build_delivery(&root, &meta).unwrap();

        // ① 隔离:不进包清单的文件数与容量
        let text =
            fs::read_to_string(delivery.join(&first.packages[0]).join(MANIFEST_NAME)).unwrap();
        assert!(
            !text.contains("deliverypart") || text.contains("not-a-uuid"),
            "packaging 自己的半截文件不许进包清单:\n{text}"
        );
        assert!(
            !text.contains("2f1c0f6e") && !text.contains("3a2b0f6e"),
            "两种 staging 残留都不许进包清单:\n{text}"
        );
        // 认得严:UUID 不合规范的同名后缀文件是用户文件,照常计入
        assert!(
            text.contains("not-a-uuid"),
            "判据必须认得严,不许把用户文件当 staging 残留吞掉:\n{text}"
        );

        // ② 可见告警:两条残留各点名一次,绝不静默跳过
        let warned = out.warnings.join("\n");
        assert!(
            warned.contains("2f1c0f6e") && warned.contains("落包"),
            "半截落包文件必须可见告警: {warned}"
        );
        assert!(
            warned.contains("3a2b0f6e") && warned.contains("清单"),
            "半截清单文件必须可见告警: {warned}"
        );

        // ③ 隔离 ≠ 删除:证据留在盘上让人核对
        assert!(leftover_copy.is_file() && leftover_manifest.is_file());
    }

    /// R2 变异复核:交付复制必须保留源 mtime。源 mtime 被改会影响半天分包,
    /// 所以在**全部包**里找落点,不假设它进第一个包。
    /// R3 声明:生产路径用 fs::copy 落临时文件,macOS 的 fs::copy 本身克隆
    /// 时间戳——本断言在 macOS 恒真,判别力由 CI 三平台矩阵的 Linux/Windows
    /// 腿提供(删 preserve_times_counted 在那两腿必红)。
    #[test]
    fn delivery_preserves_source_mtime() {
        let (_t, root, meta) = setup();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(86400 * 30);
        let f = fs::OpenOptions::new()
            .write(true)
            .open(root.join("2. 开幕式/a.jpg"))
            .unwrap();
        f.set_times(fs::FileTimes::new().set_modified(old)).unwrap();
        drop(f);
        let out = build_delivery(&root, &meta).unwrap();
        assert!(out.failures.is_empty(), "{:?}", out.failures);
        let delivery = root.join(DELIVERY_DIR);
        let delivered = out
            .packages
            .iter()
            .map(|p| delivery.join(p).join("2. 开幕式/a.jpg"))
            .find(|p| p.is_file())
            .expect("a.jpg 必须被交付到某个包");
        let dm = fs::metadata(&delivered).unwrap().modified().unwrap();
        let diff = dm
            .duration_since(old)
            .unwrap_or_else(|e| e.duration())
            .as_secs();
        assert!(diff <= 2, "交付产物 mtime 必须保留源值(差 {diff}s)");
    }

    #[test]
    fn truncated_leftover_is_name_collision_not_silent_success() {
        // codex P0 场景:包内已有同名**不同内容**(如上次断连的半截文件被手工改名),
        // 必须报 name-collision,绝不当成已交付
        let (_t, root, meta) = setup();
        let out1 = build_delivery(&root, &meta).unwrap();
        let pkg = &out1.packages[0];
        let victim = root.join(DELIVERY_DIR).join(pkg).join("2. 开幕式/a.jpg");
        fs::write(&victim, b"truncated!").unwrap(); // 篡改成半截内容

        let again = build_delivery(&root, &meta).unwrap();
        assert_eq!(again.already_delivered, 2, "另两个文件正常校验跳过");
        let collision: Vec<_> = again
            .failures
            .iter()
            .filter(|f| f.1 == "name-collision")
            .collect();
        assert_eq!(collision.len(), 1);
        assert!(collision[0].0.contains("a.jpg"));
        // 包内文件未被覆盖,源件未动
        assert_eq!(fs::read(&victim).unwrap(), b"truncated!");
        assert_eq!(
            fs::read(root.join("2. 开幕式/a.jpg")).unwrap(),
            vec![1u8; 100]
        );
    }

    #[test]
    fn reserved_manifest_names_are_rejected_not_swallowed() {
        // codex 复验 P0 的测试补钉:源文件叫 清单.txt / 交付总清单.txt 必须报错
        let (_t, root, meta) = setup();
        fs::write(root.join("2. 开幕式/清单.txt"), b"user file").unwrap();
        fs::write(root.join("2. 开幕式/交付总清单.txt"), b"user file 2").unwrap();
        let out = build_delivery(&root, &meta).unwrap();
        let reserved: Vec<_> = out
            .failures
            .iter()
            .filter(|f| f.2.contains("保留名"))
            .collect();
        assert_eq!(reserved.len(), 2, "{:?}", out.failures);
        // 未被静默交付
        let pkg = &out.packages[0];
        let pkg_manifest = root.join(DELIVERY_DIR).join(pkg).join("2. 开幕式/清单.txt");
        assert!(
            !pkg_manifest.exists() || fs::read(&pkg_manifest).unwrap() != b"user file",
            "用户的 清单.txt 不许混进包内清单位置"
        );
    }

    #[test]
    fn package_totals_reflect_reality_on_rerun() {
        // 复验 P2 测试补钉:重跑后包表是实况总量,不是本轮新复制数(0)
        let (_t, root, meta) = setup();
        build_delivery(&root, &meta).unwrap();
        let again = build_delivery(&root, &meta).unwrap();
        assert_eq!(again.files.len(), 0);
        let total_files: usize = again.package_totals.iter().map(|(_, n, _)| n).sum();
        assert_eq!(
            total_files, 3,
            "包表要报实况 3 个文件: {:?}",
            again.package_totals
        );
        let total_bytes: u64 = again.package_totals.iter().map(|(_, _, b)| b).sum();
        assert_eq!(total_bytes, 600);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_delivery_root_creates_nothing_outside() {
        // 终审复票 P0:「交付」根被换成指向项目外的链接时,
        // 不许在项目外产生任何新目录/文件(闸前零副作用),失败可见
        let (tmp, root, meta) = setup();
        let outside = tmp.path().join("外部交付");
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join(DELIVERY_DIR)).unwrap();

        let out = build_delivery(&root, &meta).unwrap();
        assert_eq!(out.files.len(), 0, "不许有任何文件被交付出去");
        assert!(!out.failures.is_empty(), "失败必须可见");
        assert!(
            fs::read_dir(&outside).unwrap().next().is_none(),
            "项目外不许出现任何新目录或文件"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_category_ancestor_is_refused() {
        // 终审复票:「精选」父夹被换链接,「精选/已修」扫描不得跟出项目
        let (tmp, root, meta) = setup();
        let outside = tmp.path().join("外部精选");
        fs::create_dir_all(outside.join("已修")).unwrap();
        fs::write(outside.join("已修/外部.jpg"), b"secret").unwrap();
        let curated = root.join("3. 精选");
        fs::remove_dir_all(&curated).unwrap();
        std::os::unix::fs::symlink(&outside, &curated).unwrap();

        let out = build_delivery(&root, &meta).unwrap();
        let all: Vec<_> = out.files.iter().map(|f| f.source_rel.clone()).collect();
        assert!(
            !all.iter().any(|r| r.contains("外部")),
            "链接祖先的内容不许进包"
        );
        assert!(
            out.failures.iter().any(|f| f.2.contains("符号链接")),
            "整夹拒绝必须可见: {:?}",
            out.failures
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_dir_in_category_is_skipped_with_warning() {
        // 复验轮二 P0:collect 不跟随链接,不把项目外内容卷进交付
        let (tmp, root, meta) = setup();
        let outside = tmp.path().join("外部");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.jpg"), b"secret").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("2. 开幕式/link")).unwrap();

        let out = build_delivery(&root, &meta).unwrap();
        assert!(
            out.warnings.iter().any(|w| w.contains("符号链接")),
            "跳过链接必须有警告: {:?}",
            out.warnings
        );
        let all: Vec<_> = out.files.iter().map(|f| f.source_rel.clone()).collect();
        assert!(
            !all.iter().any(|r| r.contains("secret")),
            "链接内容不许进包"
        );
    }

    #[test]
    fn cancel_stops_at_file_boundary_but_manifests_stay_honest() {
        // W2:取消也按实况写清单,交付目录绝不处于无清单说谎态
        let (_t, root, meta) = setup();
        let seen = std::sync::atomic::AtomicUsize::new(0);
        let out = build_delivery_with(&root, &meta, &mut |_, _, _, _| {}, &|| {
            // 放过第一个文件,之后取消
            seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) >= 1
        })
        .unwrap();
        assert!(out.cancelled, "取消要如实标记");
        assert!(out.files.len() < 3, "不许把剩余文件继续拷完");
        let delivery = root.join(DELIVERY_DIR);
        if !out.files.is_empty() {
            assert!(delivery.join("交付总清单.txt").is_file(), "取消后清单仍在");
            let pkg = &out.packages[0];
            assert!(delivery.join(pkg).join("清单.txt").is_file());
        }
    }

    #[test]
    fn manifest_write_failure_degrades_without_discarding_results() {
        // 评审 H1:清单写不进去,复制成果与失败明细必须原样返回
        let (_t, root, meta) = setup();
        let out1 = build_delivery(&root, &meta).unwrap();
        let pkg = out1.packages[0].clone();
        // 把包清单路径占成目录,写清单必失败
        let manifest_path = root.join(DELIVERY_DIR).join(&pkg).join(MANIFEST_NAME);
        fs::remove_file(&manifest_path).unwrap();
        fs::create_dir_all(&manifest_path).unwrap();

        let again = build_delivery(&root, &meta).unwrap();
        assert_eq!(again.already_delivered, 3, "复制结果不受清单失败影响");
        let manifest_fail: Vec<_> = again
            .failures
            .iter()
            .filter(|f| f.1 == "manifest-error")
            .collect();
        assert!(!manifest_fail.is_empty(), "清单失败必须可见");
        assert!(manifest_fail[0].2.contains("清单"));
    }
}
