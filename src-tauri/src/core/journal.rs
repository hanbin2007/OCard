//! 多工作站免锁协同:每台机器只追加写自己的 `journal-<机器ID>.jsonl`,
//! 读取时合并所有机器的事件按时间戳重放。SMB 上无跨平台可靠文件锁,
//! 此设计从根上避免并发写冲突。
//!
//! 通用机制按「日志目录」工作;项目级日志在 `<项目>/.ocard/journal/`,
//! 全 NAS 共享的登记表日志在 `<NAS根>/.ocard-registry/`(见 registry 模块)。

use super::project::{JOURNAL_DIR, STATE_DIR};
use super::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// 事件类型常量(字符串形式,保证新老版本互通)。
pub mod kind {
    pub const PROJECT_CREATED: &str = "project_created";
    pub const CAMERA_REGISTERED: &str = "camera_registered";
    pub const CAMERA_DELETED: &str = "camera_deleted";
    pub const CARD_REGISTERED: &str = "card_registered";
    pub const CARD_DELETED: &str = "card_deleted";
    /// 项目用卡清单整体设定(UX 波三:x/y 的真分母)。data: {"cardIds": [...]}
    pub const PROJECT_CARDS_SET: &str = "project_cards_set";
    /// 拷卡时实际用到某张登记卡(自动并入用卡清单)。data: {"cardId": "..."}
    pub const PROJECT_CARD_USED: &str = "project_card_used";
    /// 手动把一张卡增量加入用卡清单(快捷拷卡引导)。与 USED 同型折叠——
    /// 可交换的追加事件,多机并发加卡不会像整表 SET 那样互相覆盖。
    /// data: {"cardId": "..."}
    pub const PROJECT_CARD_ADDED: &str = "project_card_added";
    pub const COPY_STARTED: &str = "copy_started";
    pub const COPY_COMPLETED: &str = "copy_completed";
    pub const COPY_FILE_FAILED: &str = "copy_file_failed";
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub ts: DateTime<Utc>,
    pub machine: String,
    pub operator: String,
    pub kind: String,
    #[serde(default)]
    pub data: serde_json::Value,
}

impl Event {
    pub fn new(
        machine: impl Into<String>,
        operator: impl Into<String>,
        kind: impl Into<String>,
        data: serde_json::Value,
    ) -> Self {
        Self {
            ts: Utc::now(),
            machine: machine.into(),
            operator: operator.into(),
            kind: kind.into(),
            data,
        }
    }
}

/// 追加一条事件到指定日志目录下本机的日志文件(单行 JSON)。
pub fn append_in(dir: &Path, event: &Event) -> Result<()> {
    fs::create_dir_all(dir)?;
    let mut line = serde_json::to_string(event)?;
    line.push('\n');
    let file = dir.join(format!("journal-{}.jsonl", event.machine));
    let mut f = OpenOptions::new().create(true).append(true).open(file)?;
    f.write_all(line.as_bytes())?;
    Ok(())
}

/// 合并读取的结果与健康度。容错跳过的坏数据**必须**上报给用户
/// (UX 原则:fail-open 不允许无提示),调用方据此发通知。
#[derive(Debug, Default)]
pub struct JournalRead {
    pub events: Vec<Event>,
    /// 解析失败被跳过的行数(半行写入/版本差异/损坏)。
    pub skipped_lines: usize,
    /// 读取失败被跳过的日志文件数。
    pub unreadable_files: usize,
}

/// 合并读取目录下所有工作站的事件。
/// 容错:非 UTF-8 字节 lossy 处理、解析失败的行跳过、单个文件读取失败跳过——
/// 任何坏数据都不毁掉整个状态(SMB 断连可能撕开多字节字符),但计数上报。
/// 排序确定化:主键时间戳,并列时按 (机器文件名, 文件内行号) 裁决,
/// 保证任意工作站折叠出同一结果。
pub fn read_all_in(dir: &Path) -> Result<JournalRead> {
    let mut keyed: Vec<(chrono::DateTime<Utc>, String, usize, Event)> = Vec::new();
    let mut out = JournalRead::default();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if !(name.starts_with("journal-") && name.ends_with(".jsonl")) {
            continue;
        }
        if super::paths::is_symlink(&path) {
            out.unreadable_files += 1; // R5:链接日志文件不读,计数上报
            continue;
        }
        let Ok(bytes) = fs::read(&path) else {
            out.unreadable_files += 1;
            continue; // 单文件读取失败不中断整目录,但计数上报
        };
        let text = String::from_utf8_lossy(&bytes);
        for (idx, line) in text.lines().enumerate() {
            match serde_json::from_str::<Event>(line) {
                Ok(ev) => keyed.push((ev.ts, name.clone(), idx, ev)),
                Err(_) => out.skipped_lines += 1,
            }
        }
    }
    keyed.sort_by(|a, b| (a.0, &a.1, a.2).cmp(&(b.0, &b.1, b.2)));
    out.events = keyed.into_iter().map(|(_, _, _, e)| e).collect();
    Ok(out)
}

fn project_journal_dir(project_root: &Path) -> PathBuf {
    project_root.join(STATE_DIR).join(JOURNAL_DIR)
}

/// 项目级日志:追加(R2 P0:`.ocard`/`journal` 中间段防符号链接偷渡)。
pub fn append(project_root: &Path, event: &Event) -> Result<()> {
    let dir = project_journal_dir(project_root);
    super::paths::ensure_dir_within(project_root, &dir).map_err(super::CoreError::Invalid)?;
    append_in(&dir, event)
}

/// 项目级日志:合并读取(R4:读路径同样过 canonical 只读闸)。
pub fn read_all(project_root: &Path) -> Result<JournalRead> {
    let dir = project_journal_dir(project_root);
    super::paths::assert_within(project_root, &dir).map_err(super::CoreError::Invalid)?;
    read_all_in(&dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    /// R3:append 的 `.ocard` 落地闸接线回归——中间段被换成指向项目外的
    /// 符号链接时必须拒写(在 append 里删掉 ensure_dir_within 调用本测试红)。
    #[cfg(unix)]
    #[test]
    fn append_refuses_symlinked_state_dir() {
        let tmp = tempdir().unwrap();
        let project = tmp.path().join("project");
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, project.join(STATE_DIR)).unwrap();
        let ev = Event::new("mac-01", "E2E", kind::COPY_STARTED, json!({}));
        assert!(append(&project, &ev).is_err(), "符号链接 .ocard 必须拒写");
        assert!(
            !outside.join(JOURNAL_DIR).exists(),
            "日志不得经链接写到项目外"
        );
    }

    #[test]
    fn append_and_merge_multiple_machines() {
        let tmp = tempdir().unwrap();
        let e1 = Event::new(
            "mac-01",
            "赵晋宇",
            kind::COPY_STARTED,
            json!({"card": "SD01"}),
        );
        let e2 = Event::new(
            "win-02",
            "李启轩",
            kind::COPY_STARTED,
            json!({"card": "SD02"}),
        );
        append(tmp.path(), &e1).unwrap();
        append(tmp.path(), &e2).unwrap();
        append(
            tmp.path(),
            &Event::new(
                "mac-01",
                "赵晋宇",
                kind::COPY_COMPLETED,
                json!({"card": "SD01"}),
            ),
        )
        .unwrap();

        let all = read_all(tmp.path()).unwrap().events;
        assert_eq!(all.len(), 3);
        let dir = tmp.path().join(".ocard/journal");
        assert!(dir.join("journal-mac-01.jsonl").exists());
        assert!(dir.join("journal-win-02.jsonl").exists());
        assert!(all.windows(2).all(|w| w[0].ts <= w[1].ts));
    }

    #[test]
    fn bad_lines_are_skipped() {
        let tmp = tempdir().unwrap();
        let e = Event::new("mac-01", "ZS", kind::CAMERA_REGISTERED, json!({}));
        append(tmp.path(), &e).unwrap();
        let file = tmp.path().join(".ocard/journal/journal-mac-01.jsonl");
        let mut content = fs::read_to_string(&file).unwrap();
        content.push_str("{\"ts\": \"broken");
        fs::write(&file, content).unwrap();

        let r = read_all(tmp.path()).unwrap();
        assert_eq!(r.events.len(), 1);
        assert_eq!(r.skipped_lines, 1, "坏行必须被计数上报,不允许静默");
    }

    #[test]
    fn generic_dir_api_works_standalone() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path().join("registry");
        append_in(
            &dir,
            &Event::new("m1", "ZS", kind::CAMERA_REGISTERED, json!({"id": "c1"})),
        )
        .unwrap();
        append_in(
            &dir,
            &Event::new("m2", "LQ", kind::CAMERA_REGISTERED, json!({"id": "c2"})),
        )
        .unwrap();
        assert_eq!(read_all_in(&dir).unwrap().events.len(), 2);
    }
}
