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

/// 合并读取目录下所有工作站的事件,按时间戳排序。
/// 解析失败的行跳过(容忍半行写入/版本差异),不让单行坏数据毁掉整个状态。
pub fn read_all_in(dir: &Path) -> Result<Vec<Event>> {
    let mut events = Vec::new();
    if !dir.exists() {
        return Ok(events);
    }
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !(name.starts_with("journal-") && name.ends_with(".jsonl")) {
            continue;
        }
        for line in fs::read_to_string(&path)?.lines() {
            if let Ok(ev) = serde_json::from_str::<Event>(line) {
                events.push(ev);
            }
        }
    }
    events.sort_by_key(|e| e.ts);
    Ok(events)
}

fn project_journal_dir(project_root: &Path) -> PathBuf {
    project_root.join(STATE_DIR).join(JOURNAL_DIR)
}

/// 项目级日志:追加。
pub fn append(project_root: &Path, event: &Event) -> Result<()> {
    append_in(&project_journal_dir(project_root), event)
}

/// 项目级日志:合并读取。
pub fn read_all(project_root: &Path) -> Result<Vec<Event>> {
    read_all_in(&project_journal_dir(project_root))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

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

        let all = read_all(tmp.path()).unwrap();
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

        assert_eq!(read_all(tmp.path()).unwrap().len(), 1);
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
        assert_eq!(read_all_in(&dir).unwrap().len(), 2);
    }
}
