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
    /// 因暂停请求提前停止(文件边界处停,manifest 可续传)。
    pub paused: bool,
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

/// 判定文件是否「真正完成」:manifest 已验证 **且** 每个目的地上最终文件都在、尺寸一致。
/// 只信 manifest 会在备份盘被拔/目标被删后产生假绿灯(评审 H2/P0-1)。
pub fn file_done(m: &CopyManifest, rel: &str, size: u64, destinations: &[PathBuf]) -> bool {
    if !m.is_done(rel, size) {
        return false;
    }
    destinations.iter().all(|d| {
        fs::metadata(d.join(rel_to_native(rel)))
            .map(|meta| meta.is_file() && meta.len() == size)
            .unwrap_or(false)
    })
}

/// 执行拷卡。`files` 为调用方预先扫描的清单(与 UI 快照/manifest 同源,
/// 避免两次扫描产生分歧);`project_root` 用于逐文件持久化 manifest(断点续传依据)。
/// 回调返回 [`CopyControl::Pause`] 时在当前文件完成后停下,manifest 保证可续传。
pub fn run_copy(
    req: &CopyRequest,
    files: &[(String, u64)],
    m: &mut CopyManifest,
    project_root: &Path,
    mut progress: impl FnMut(Progress) -> CopyControl,
) -> Result<CopyOutcome> {
    assert!(!req.destinations.is_empty(), "至少需要一个目的地");
    let total_bytes: u64 = files.iter().map(|(_, s)| *s).sum();
    let mut control = progress(Progress::Scanned {
        total_files: files.len(),
        total_bytes,
    });

    let mut reports = Vec::with_capacity(files.len());
    let mut bytes_copied = 0u64;
    let mut paused = false;
    let total = files.len();

    for (index, (rel, size)) in files.iter().enumerate() {
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

        let status = if file_done(m, rel, *size, &req.destinations) {
            FileStatus::SkippedResume
        } else {
            match copy_one(
                &req.source_root,
                rel,
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
        control = progress(Progress::FileFinished {
            rel_path: rel,
            status: &status,
        });
        reports.push(FileReport {
            rel_path: rel.clone(),
            size: *size,
            status,
        });
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
    rel: &str,
    destinations: &[PathBuf],
    task_tag: &str,
    on_chunk: &mut dyn FnMut(u64),
) -> Result<String> {
    let src_path = source_root.join(rel_to_native(rel));

    let finals: Vec<PathBuf> = destinations
        .iter()
        .map(|d| d.join(rel_to_native(rel)))
        .collect();

    // 目的地已有同名最终文件 → 先算源哈希,再逐一比对
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
            // 所有目的地都已有同内容文件:无需写入
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
        for part in &parts {
            if let Some(parent) = part.parent() {
                fs::create_dir_all(parent)?;
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
                    "源文件在两次读取之间发生变化: {rel}"
                )));
            }
        }

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
        // 全部通过,统一落位;最终名若已被并发写入者占据,create 语义再拦一次
        for (part, &i) in parts.iter().zip(&missing) {
            if finals[i].exists() {
                return Err(super::CoreError::Invalid(format!(
                    "目标在拷贝期间被其他任务写入,拒绝覆盖: {}",
                    finals[i].display()
                )));
            }
            fs::rename(part, &finals[i])?;
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
            task_tag: "t1".into(),
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
            &scan_source(&req.source_root).unwrap(),
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
            &scan_source(&req.source_root).unwrap(),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();

        // 第二次执行:全部续传跳过,拷贝字节为 0
        let out = run_copy(
            &req,
            &scan_source(&req.source_root).unwrap(),
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
            &scan_source(&req.source_root).unwrap(),
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
            &scan_source(&req.source_root).unwrap(),
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
            &scan_source(&req.source_root).unwrap(),
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
            &scan_source(&req.source_root).unwrap(),
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
            &scan_source(&req.source_root).unwrap(),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        fs::remove_file(req.destinations[1].join("CLIP0001.MP4")).unwrap();

        let out = run_copy(
            &req,
            &scan_source(&req.source_root).unwrap(),
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
            &scan_source(&req.source_root).unwrap(),
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
            &scan_source(&req.source_root).unwrap(),
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
            &scan_source(&req.source_root).unwrap(),
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
            &scan_source(&req.source_root).unwrap(),
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
