//! 工作站本机配置:操作人(当前登记的 DIT)与 NAS 根路径。
//! 存于应用配置目录,项目状态本身全在 NAS(PRD §6.3)。

use super::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const CONFIG_FILE: &str = "workstation.json";

/// 本机最近打开的记录上限:欢迎窗口一屏能看完,再多是噪声。
pub const RECENT_PROJECTS_MAX: usize = 10;

/// 本机「最近打开的项目」条目(欢迎窗口列表用)。
/// 冗余存 name/folder_name/scenario:NAS 断连时欢迎页仍能渲染出可读列表,
/// 打开动作再去真实校验项目是否还在。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecentProjectEntry {
    pub id: String,
    pub name: String,
    pub folder_name: String,
    /// "A" / "B"(与前端 Scenario 序列化一致)
    pub scenario: String,
    /// ISO 8601
    pub last_opened_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkstationConfig {
    #[serde(default)]
    pub operator: String,
    #[serde(default)]
    pub nas_root: Option<PathBuf>,
    /// 本机最近打开的项目,新→旧(旧配置文件没有此字段,默认空)。
    #[serde(default)]
    pub recent_projects: Vec<RecentProjectEntry>,
}

impl WorkstationConfig {
    /// 记一条最近打开:按 id 去重、插到最前、截到上限。
    pub fn record_recent(&mut self, entry: RecentProjectEntry) {
        self.recent_projects.retain(|r| r.id != entry.id);
        self.recent_projects.insert(0, entry);
        self.recent_projects.truncate(RECENT_PROJECTS_MAX);
    }
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
            recent_projects: vec![RecentProjectEntry {
                id: "p1".into(),
                name: "校运会".into(),
                folder_name: "20260824_校运会".into(),
                scenario: "B".into(),
                last_opened_at: "2026-08-24T14:35:00+08:00".into(),
            }],
        };
        save(tmp.path(), &cfg).unwrap();
        assert_eq!(load(tmp.path()), cfg);
    }

    #[test]
    fn legacy_config_without_recents_loads() {
        // 旧版 workstation.json 没有 recentProjects 字段,必须能读
        let tmp = tempdir().unwrap();
        fs::write(
            tmp.path().join("workstation.json"),
            r#"{"operator":"老配置","nasRoot":"/mnt/nas"}"#.as_bytes(),
        )
        .unwrap();
        let cfg = load(tmp.path());
        assert_eq!(cfg.operator, "老配置");
        assert!(cfg.recent_projects.is_empty());
    }

    fn recent(id: &str) -> RecentProjectEntry {
        RecentProjectEntry {
            id: id.into(),
            name: id.into(),
            folder_name: format!("20260801_{id}"),
            scenario: "A".into(),
            last_opened_at: "2026-08-01T09:00:00+08:00".into(),
        }
    }

    #[test]
    fn record_recent_dedupes_and_caps() {
        let mut cfg = WorkstationConfig::default();
        for i in 0..(RECENT_PROJECTS_MAX + 3) {
            cfg.record_recent(recent(&format!("p{i}")));
        }
        assert_eq!(cfg.recent_projects.len(), RECENT_PROJECTS_MAX);
        // 重开旧项目:去重并顶到最前
        cfg.record_recent(recent("p5"));
        assert_eq!(cfg.recent_projects[0].id, "p5");
        assert_eq!(
            cfg.recent_projects.iter().filter(|r| r.id == "p5").count(),
            1
        );
        assert_eq!(cfg.recent_projects.len(), RECENT_PROJECTS_MAX);
    }
}
