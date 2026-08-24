//! 交付打包(M2 任务4,PRD §5.7 / 规范第八条):
//! 将分好类的素材按**拍摄时间半天**分包(不压缩),生成交付清单;
//! 上传百度网盘与发链接由人工完成(既定边界)。
//!
//! 不变量:
//! - 打包是**复制**,分类夹原件不动;
//! - 零覆盖:包内已存在同名文件即失败该项(重跑安全);
//! - 每包生成 `清单.txt`,项目级生成总清单。

use super::media;
use super::project::{self, Scenario};
use super::{CoreError, Result};
use chrono::{DateTime, Datelike, Local, Timelike, Utc};
use std::fs;
use std::path::{Path, PathBuf};

/// 交付根目录名(位于项目根下,不参与工况 B 序号体系)。
pub const DELIVERY_DIR: &str = "交付";

/// 半天键:`MMDD上午` / `MMDD下午`(本地时间,规范以半天为粒度)。
pub fn half_day_key(t: DateTime<Utc>) -> String {
    let local = t.with_timezone(&Local);
    let half = if local.hour() < 12 {
        "上午"
    } else {
        "下午"
    };
    format!("{:02}{:02}{half}", local.month(), local.day())
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
    pub packages: Vec<String>,
    pub files: Vec<PackagedFile>,
    /// 逐文件失败(路径, 原因)——零静默。
    pub failures: Vec<(String, String)>,
    pub total_bytes: u64,
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// 收集一个分类夹下的全部文件(递归,忽略隐藏)。
fn collect(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = fs::read_dir(&d) else {
            continue;
        };
        for e in entries.flatten() {
            if is_hidden(&e.file_name().to_string_lossy()) {
                continue;
            }
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

/// 执行交付打包:纳入全部自定义分类 + 精选/已修 + 其他(规范第八条)。
/// 待分类与精选/待修不纳入(未完成分类/修图的不交付)。
pub fn build_delivery(project_root: &Path, meta: &project::ProjectMeta) -> Result<DeliveryOutcome> {
    if meta.scenario != Scenario::B {
        return Err(CoreError::Invalid("交付打包仅适用于工况 B".into()));
    }
    let dirs = project::scenario_b_dirs(&meta.categories);
    // 纳入:自定义分类(索引 1..=n)、精选/已修、其他
    let mut sources: Vec<(String, PathBuf)> = Vec::new();
    for (i, folder) in dirs.iter().enumerate() {
        if i == 0 {
            continue; // 待分类不交付
        }
        if folder.ends_with(project::CURATED_DIR_NAME) {
            sources.push((
                format!("{}/{}", project::CURATED_DIR_NAME, project::CURATED_DONE),
                project_root.join(folder).join(project::CURATED_DONE),
            ));
        } else {
            sources.push((folder.clone(), project_root.join(folder)));
        }
    }

    let delivery_root = project_root.join(DELIVERY_DIR);
    let mut out = DeliveryOutcome::default();

    for (category, dir) in &sources {
        for file in collect(dir) {
            let rel = file
                .strip_prefix(project_root)
                .unwrap_or(&file)
                .to_string_lossy()
                .replace('\\', "/");
            let meta_fs = match fs::metadata(&file) {
                Ok(m) => m,
                Err(e) => {
                    out.failures.push((rel, format!("读取失败: {e}")));
                    continue;
                }
            };
            let shot = media::exif_shot_at(&file)
                .or_else(|| meta_fs.modified().ok().map(DateTime::<Utc>::from))
                .unwrap_or_else(Utc::now);
            let package = half_day_key(shot);
            let dst_dir = delivery_root.join(&package).join(category);
            let dst = dst_dir.join(file.file_name().unwrap_or_default());

            let result = (|| -> std::result::Result<(), String> {
                if dst.exists() {
                    return Err("包内已存在同名文件,拒绝覆盖".into());
                }
                fs::create_dir_all(&dst_dir).map_err(|e| e.to_string())?;
                fs::copy(&file, &dst).map(|_| ()).map_err(|e| e.to_string())
            })();

            match result {
                Ok(()) => {
                    if !out.packages.contains(&package) {
                        out.packages.push(package.clone());
                    }
                    out.total_bytes += meta_fs.len();
                    out.files.push(PackagedFile {
                        source_rel: rel,
                        category: category.clone(),
                        package,
                        size_bytes: meta_fs.len(),
                    });
                }
                Err(e) => out.failures.push((rel, e)),
            }
        }
    }
    out.packages.sort();

    // 逐包清单 + 总清单
    for pkg in &out.packages {
        let files: Vec<&PackagedFile> = out.files.iter().filter(|f| &f.package == pkg).collect();
        let bytes: u64 = files.iter().map(|f| f.size_bytes).sum();
        let mut text = format!(
            "OCard 交付清单\n包: {pkg}\n生成时间: {}\n文件数: {}\n总容量: {} 字节\n\n",
            Local::now().format("%Y-%m-%d %H:%M:%S"),
            files.len(),
            bytes
        );
        for f in &files {
            text.push_str(&format!(
                "{}\t{} 字节\t来源: {}\n",
                f.category, f.size_bytes, f.source_rel
            ));
        }
        fs::write(delivery_root.join(pkg).join("清单.txt"), text)?;
    }
    let mut summary = format!(
        "OCard 交付总清单\n生成时间: {}\n包数: {}\n文件数: {}\n总容量: {} 字节\n失败: {}\n\n",
        Local::now().format("%Y-%m-%d %H:%M:%S"),
        out.packages.len(),
        out.files.len(),
        out.total_bytes,
        out.failures.len()
    );
    for pkg in &out.packages {
        let n = out.files.iter().filter(|f| &f.package == pkg).count();
        summary.push_str(&format!("{pkg}\t{n} 个文件\n"));
    }
    for (rel, e) in &out.failures {
        summary.push_str(&format!("[失败] {rel}: {e}\n"));
    }
    fs::create_dir_all(&delivery_root)?;
    fs::write(delivery_root.join("交付总清单.txt"), summary)?;

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use tempfile::tempdir;

    #[test]
    fn half_day_key_splits_at_noon() {
        // 用本地时区构造确定的上午/下午时刻
        let morning = Local::now()
            .with_timezone(&Local)
            .date_naive()
            .and_hms_opt(9, 0, 0)
            .unwrap();
        let afternoon = morning.with_hour(15).unwrap();
        let m_utc = morning.and_local_timezone(Local).unwrap().to_utc();
        let a_utc = afternoon.and_local_timezone(Local).unwrap().to_utc();
        assert!(half_day_key(m_utc).ends_with("上午"));
        assert!(half_day_key(a_utc).ends_with("下午"));
        assert_eq!(half_day_key(m_utc).len(), "0824上午".len());
    }

    #[test]
    fn delivery_packages_by_half_day_and_writes_manifests() {
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

        let out = build_delivery(&root, &meta).unwrap();
        assert_eq!(out.files.len(), 3);
        assert!(out.failures.is_empty());
        assert_eq!(out.total_bytes, 600);
        assert!(!out.packages.is_empty());

        let delivery = root.join(DELIVERY_DIR);
        assert!(delivery.join("交付总清单.txt").is_file());
        let pkg = &out.packages[0];
        assert!(delivery.join(pkg).join("清单.txt").is_file());
        assert!(delivery.join(pkg).join("2. 开幕式/a.jpg").is_file());
        assert!(delivery
            .join(pkg)
            .join(format!(
                "{}/{}",
                project::CURATED_DIR_NAME,
                project::CURATED_DONE
            ))
            .join("hero.jpg")
            .is_file());
        // 原件不动
        assert!(root.join("2. 开幕式/a.jpg").is_file());
        // 待修/待分类没进包
        let all: Vec<String> = out.files.iter().map(|f| f.source_rel.clone()).collect();
        assert!(!all
            .iter()
            .any(|r| r.contains("待修") || r.contains("待分类")));

        // 重跑:零覆盖 → 全部失败但不损坏既有包
        let again = build_delivery(&root, &meta).unwrap();
        assert_eq!(again.files.len(), 0);
        assert_eq!(again.failures.len(), 3);
        assert!(again.failures[0].1.contains("拒绝覆盖"));
    }
}
