//! 工作站身份:首次启动生成 UUID 并持久化于应用配置目录,
//! 作为多机事件日志的机器标识(PRD §6.3)。

use super::Result;
use std::fs;
use std::path::Path;

const ID_FILE: &str = "machine-id";

/// 读取(或首次生成)本机 ID。`config_dir` 为应用配置目录。
pub fn machine_id(config_dir: &Path) -> Result<String> {
    let path = config_dir.join(ID_FILE);
    if let Ok(existing) = fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    fs::create_dir_all(config_dir)?;
    fs::write(&path, &id)?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn generates_once_and_is_stable() {
        let tmp = tempdir().unwrap();
        let a = machine_id(tmp.path()).unwrap();
        let b = machine_id(tmp.path()).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.len(), 36);
    }

    #[test]
    fn distinct_dirs_get_distinct_ids() {
        let t1 = tempdir().unwrap();
        let t2 = tempdir().unwrap();
        assert_ne!(
            machine_id(t1.path()).unwrap(),
            machine_id(t2.path()).unwrap()
        );
    }
}
