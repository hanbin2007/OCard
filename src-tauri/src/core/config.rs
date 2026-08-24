//! 工作站本机配置:操作人(当前登记的 DIT)与 NAS 根路径。
//! 存于应用配置目录,项目状态本身全在 NAS(PRD §6.3)。

use super::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const CONFIG_FILE: &str = "workstation.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkstationConfig {
    #[serde(default)]
    pub operator: String,
    #[serde(default)]
    pub nas_root: Option<PathBuf>,
}

pub fn load(config_dir: &Path) -> WorkstationConfig {
    fs::read(config_dir.join(CONFIG_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn save(config_dir: &Path, cfg: &WorkstationConfig) -> Result<()> {
    fs::create_dir_all(config_dir)?;
    fs::write(
        config_dir.join(CONFIG_FILE),
        serde_json::to_vec_pretty(cfg)?,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn missing_file_yields_default() {
        let tmp = tempdir().unwrap();
        assert_eq!(load(tmp.path()), WorkstationConfig::default());
    }

    #[test]
    fn save_load_roundtrip() {
        let tmp = tempdir().unwrap();
        let cfg = WorkstationConfig {
            operator: "赵晋宇".into(),
            nas_root: Some(PathBuf::from("/Volumes/NAS/摄影")),
        };
        save(tmp.path(), &cfg).unwrap();
        assert_eq!(load(tmp.path()), cfg);
    }
}
