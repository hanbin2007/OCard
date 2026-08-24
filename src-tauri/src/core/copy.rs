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
    pub rel_path: String,
    pub size: u64,
    pub status: FileStatus,
}

#[derive(Debug)]
pub struct CopyOutcome {
    pub files: Vec<FileReport>,
    pub bytes_copied: u64,
    /// 全部文件均已验证(含续传跳过的)。为 true 才提示「本卡可格式化」。
    pub all_verified: bool,
}

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
    FileFinished {
        rel_path: &'a str,
        status: &'a FileStatus,
    },
}

/// 扫描源:递归列出全部普通文件(相对路径统一 `/` 分隔)。
/// 跳过点开头的隐藏项(存储卡上的 .Trashes/.fseventsd 等系统残留)。
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

/// 执行拷卡。`project_root` 用于逐文件持久化 manifest(断点续传依据)。
pub fn run_copy(
    req: &CopyRequest,
    m: &mut CopyManifest,
    project_root: &Path,
    mut progress: impl FnMut(Progress),
) -> Result<CopyOutcome> {
    assert!(!req.destinations.is_empty(), "至少需要一个目的地");
    let files = scan_source(&req.source_root)?;
    let total_bytes: u64 = files.iter().map(|(_, s)| *s).sum();
    progress(Progress::Scanned {
        total_files: files.len(),
        total_bytes,
    });

    let mut reports = Vec::with_capacity(files.len());
    let mut bytes_copied = 0u64;
    let total = files.len();

    for (index, (rel, size)) in files.iter().enumerate() {
        progress(Progress::FileStarted {
            rel_path: rel,
            index,
            total,
        });

        let status = if m.is_done(rel, *size) {
            FileStatus::SkippedResume
        } else {
            match copy_one(&req.source_root, rel, &req.destinations) {
                Ok(xxh3) => {
                    m.upsert(ManifestEntry {
                        rel_path: rel.clone(),
                        size: *size,
                        xxh3,
                        verified: true,
                    });
                    bytes_copied += size;
                    FileStatus::Copied
                }
                Err(e) => {
                    m.upsert(ManifestEntry {
                        rel_path: rel.clone(),
                        size: *size,
                        xxh3: String::new(),
                        verified: false,
                    });
                    FileStatus::Failed(e.to_string())
                }
            }
        };
        // 逐文件落盘,任意时刻中断都可续传
        manifest::save(project_root, m)?;
        progress(Progress::FileFinished {
            rel_path: rel,
            status: &status,
        });
        reports.push(FileReport {
            rel_path: rel.clone(),
            size: *size,
            status,
        });
    }

    let all_verified = !reports.is_empty()
        && reports
            .iter()
            .all(|r| !matches!(r.status, FileStatus::Failed(_)));
    m.completed = all_verified;
    manifest::save(project_root, m)?;

    Ok(CopyOutcome {
        files: reports,
        bytes_copied,
        all_verified,
    })
}

/// 拷贝单个文件到全部目的地:读一次源、边读边算哈希、写 N 份临时文件,
/// 逐目的地回读校验,全部通过后统一改名。返回源文件 xxh3。
fn copy_one(source_root: &Path, rel: &str, destinations: &[PathBuf]) -> Result<String> {
    let src_path = source_root.join(rel_to_native(rel));
    let mut src = File::open(&src_path)?;

    let finals: Vec<PathBuf> = destinations
        .iter()
        .map(|d| d.join(rel_to_native(rel)))
        .collect();
    let parts: Vec<PathBuf> = finals
        .iter()
        .map(|f| {
            f.with_file_name(format!(
                "{}{PART_SUFFIX}",
                f.file_name().unwrap().to_string_lossy()
            ))
        })
        .collect();

    let result = (|| -> Result<String> {
        let mut writers = Vec::with_capacity(parts.len());
        for part in &parts {
            if let Some(parent) = part.parent() {
                fs::create_dir_all(parent)?;
            }
            writers.push(File::create(part)?);
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
        }
        for mut w in writers {
            w.flush()?;
            w.sync_all()?;
        }
        let src_hash = format!("{:016x}", hasher.digest());

        // 逐目的地回读校验
        for part in &parts {
            let dest_hash = hash::xxh3_file(part)?;
            if dest_hash != src_hash {
                return Err(super::CoreError::Invalid(format!(
                    "校验不一致: {} (源 {src_hash} / 目标 {dest_hash})",
                    part.display()
                )));
            }
        }
        // 全部通过,统一改名
        for (part, fin) in parts.iter().zip(&finals) {
            fs::rename(part, fin)?;
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

/// 把 `/` 分隔的相对路径转为本平台路径。
fn rel_to_native(rel: &str) -> PathBuf {
    rel.split('/').collect()
}

#[cfg(test)]
mod tests {
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
        let out = run_copy(&req, &mut m, &project, |_| events += 1).unwrap();

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
        run_copy(&req, &mut m, &project, |_| {}).unwrap();

        // 第二次执行:全部续传跳过,拷贝字节为 0
        let out = run_copy(&req, &mut m, &project, |_| {}).unwrap();
        assert!(out
            .files
            .iter()
            .all(|f| f.status == FileStatus::SkippedResume));
        assert_eq!(out.bytes_copied, 0);
        assert!(out.all_verified);
    }

    #[test]
    fn source_change_invalidates_resume() {
        let (_tmp, req, mut m, project) = setup();
        run_copy(&req, &mut m, &project, |_| {}).unwrap();
        // 源文件变大(模拟同名不同内容)
        fs::write(req.source_root.join("CLIP0001.MP4"), vec![9u8; 12000]).unwrap();

        let out = run_copy(&req, &mut m, &project, |_| {}).unwrap();
        let clip = out
            .files
            .iter()
            .find(|f| f.rel_path == "CLIP0001.MP4")
            .unwrap();
        assert_eq!(clip.status, FileStatus::Copied);
        assert_eq!(out.bytes_copied, 12000);
    }

    #[test]
    fn write_failure_marks_file_failed_but_continues() {
        let (_tmp, req, mut m, project) = setup();
        // 目标位置被同名目录占据 → 该文件写入失败,其余文件应不受影响
        fs::create_dir_all(req.destinations[0].join("CLIP0001.MP4")).unwrap();

        let out = run_copy(&req, &mut m, &project, |_| {}).unwrap();
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
}
