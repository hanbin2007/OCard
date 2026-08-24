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
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

fn out_push_entry_err(warnings: &mut Vec<String>, dir: &Path, err: std::io::Error) {
    warnings.push(format!("目录 {} 中有条目读取失败: {err}", dir.display()));
}

/// 收集一个目录下的全部文件(递归,忽略隐藏);不可读目录计入警告,不静默。
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
            if is_hidden(&e.file_name().to_string_lossy()) {
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
    dst_dir: &Path,
    dst: &Path,
) -> std::result::Result<bool, (&'static str, String)> {
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
    let tmp = dst_dir.join(format!(".{}.deliverypart", uuid::Uuid::new_v4()));
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
        Ok(()) => Ok(true),
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
            let rel = file
                .strip_prefix(project_root)
                .unwrap_or(&file)
                .to_string_lossy()
                .replace('\\', "/");
            // 与交付清单保留名撞名的源文件必须显式拒绝:静默交付会被清单
            // 生成器漏计/覆盖(codex 复验 P0)
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
            let meta_fs = match fs::metadata(&file) {
                Ok(m) => m,
                Err(e) => {
                    out.failures.push((rel, "error", format!("读取失败: {e}")));
                    continue;
                }
            };
            // 半天判定:EXIF 墙钟优先;无 EXIF 用 mtime 的本地墙钟;都没有用当前本地时间
            let shot = media::exif_shot_naive(&file)
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

            match deliver_one(project_root, &file, &dst_dir, &dst) {
                Ok(newly_copied) => {
                    if !out.packages.contains(&package) {
                        out.packages.push(package.clone());
                    }
                    if newly_copied {
                        out.total_bytes += meta_fs.len();
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
    }
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
                            _ => {}
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
    let tmp = dir.join(format!(".{}.manifestpart", uuid::Uuid::new_v4()));
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
