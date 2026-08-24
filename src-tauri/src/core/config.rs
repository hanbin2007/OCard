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

/// 读取配置,区分三种情况(零静默原则,codex 四轮 P1):
/// 文件不存在=首跑正常(None);解析失败=损坏;读取失败(权限/IO)=不可读——
/// 后两者都会被按未配置处理,用户必须知情,返回具体问题描述。
pub fn load_checked(config_dir: &Path) -> (WorkstationConfig, Option<String>) {
    match fs::read(config_dir.join(CONFIG_FILE)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (WorkstationConfig::default(), None),
        Err(e) => (
            WorkstationConfig::default(),
            Some(format!(
                "本机配置文件不可读(权限或 IO 问题): {e};已按未配置状态处理"
            )),
        ),
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(cfg) => (cfg, None),
            Err(_) => (
                WorkstationConfig::default(),
                Some("本机配置文件损坏,已按未配置状态处理;请重新填写设置".to_string()),
            ),
        },
    }
}

pub fn load(config_dir: &Path) -> WorkstationConfig {
    load_checked(config_dir).0
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
