//! 项目文件夹模板(OB/GF 001 表1/表2 的代码化)与项目元数据。

use super::{naming, CoreError, Result};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// 工况:A = 视频录像(需剪辑),B = 仅拍照。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Scenario {
    A,
    B,
}

/// 工况 A 的固定子文件夹(序号取齐方案已于 2026-08-24 确认)。
pub const SCENARIO_A_DIRS: [&str; 6] = [
    "1. 工程文件",
    "2. 原始素材",
    "3. 特别素材",
    "4. 转码素材",
    "5. 文字素材",
    "6. 成片",
];

pub const PENDING_DIR_B: &str = "1. 待分类";
pub const CURATED_DIR_NAME: &str = "精选";
pub const CURATED_TODO: &str = "待修";
pub const CURATED_DONE: &str = "已修";
pub const MISC_DIR_NAME: &str = "其他";

/// OCard 项目状态目录(位于项目文件夹内,NAS 上多工作站共享)。
pub const STATE_DIR: &str = ".ocard";
pub const MANIFEST_DIR: &str = "manifests";
pub const JOURNAL_DIR: &str = "journal";
const META_FILE: &str = "project.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMeta {
    pub name: String,
    pub date: NaiveDate,
    pub scenario: Scenario,
    /// 工况 B 的分类名(不含序号);工况 A 为空。
    pub categories: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub ocard_version: String,
}

/// 计算工况 B 的全部子文件夹名(带序号)。
pub fn scenario_b_dirs(categories: &[String]) -> Vec<String> {
    let mut dirs = vec![PENDING_DIR_B.to_string()];
    for (i, cat) in categories.iter().enumerate() {
        dirs.push(format!("{}. {}", i + 2, naming::sanitize_component(cat)));
    }
    let n = categories.len() + 1;
    dirs.push(format!("{}. {}", n + 1, CURATED_DIR_NAME));
    dirs.push(format!("{}. {}", n + 2, MISC_DIR_NAME));
    dirs
}

/// 在 `nas_root` 下按规范创建项目文件夹结构,返回项目路径。
pub fn create_project(
    nas_root: &Path,
    date: NaiveDate,
    name: &str,
    scenario: Scenario,
    categories: &[String],
) -> Result<PathBuf> {
    let folder = naming::project_folder_name(date, name)?;
    let root = nas_root.join(&folder);
    if root.exists() {
        return Err(CoreError::AlreadyExists(root.display().to_string()));
    }
    // 分类名校验:空名、路径分隔符、保留名(与固定夹「待分类/精选/其他」同名
    // 或以其结尾)都拒绝——夹名带序号前缀,结尾撞名会让人无法分辨(评审 M1)
    for c in categories {
        let c = c.trim();
        if c.is_empty() {
            return Err(CoreError::Invalid("分类名不能为空".into()));
        }
        if c.contains('/') || c.contains('\\') {
            return Err(CoreError::Invalid(format!("分类名不能包含路径分隔符: {c}")));
        }
        for reserved in ["待分类", CURATED_DIR_NAME, MISC_DIR_NAME] {
            if c.ends_with(reserved) {
                return Err(CoreError::Invalid(format!(
                    "分类名不能是「{reserved}」或以它结尾(与固定文件夹混淆): {c}"
                )));
            }
        }
        // Windows 保留设备名(NAS 共享给 Windows 工作站时会建不出/打不开)
        let stem = c.split('.').next().unwrap_or(c).to_ascii_uppercase();
        let is_dev = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.len() == 4
                && stem.as_bytes()[3].is_ascii_digit());
        if is_dev {
            return Err(CoreError::Invalid(format!(
                "分类名「{c}」是 Windows 保留设备名,跨平台会不可用"
            )));
        }
    }

    match scenario {
        Scenario::A => {
            for d in SCENARIO_A_DIRS {
                fs::create_dir_all(root.join(d))?;
            }
        }
        Scenario::B => {
            let dirs = scenario_b_dirs(categories);
            for d in &dirs {
                fs::create_dir_all(root.join(d))?;
            }
            // 精选夹内含「待修」「已修」;按布局下标定位(倒数第二),不猜名字
            let curated = &dirs[dirs.len() - 2];
            fs::create_dir_all(root.join(curated).join(CURATED_TODO))?;
            fs::create_dir_all(root.join(curated).join(CURATED_DONE))?;
        }
    }

    fs::create_dir_all(root.join(STATE_DIR).join(MANIFEST_DIR))?;
    fs::create_dir_all(root.join(STATE_DIR).join(JOURNAL_DIR))?;

    let meta = ProjectMeta {
        name: naming::sanitize_component(name),
        date,
        scenario,
        categories: categories
            .iter()
            .map(|c| naming::sanitize_component(c))
            .collect(),
        created_at: Utc::now(),
        ocard_version: env!("CARGO_PKG_VERSION").to_string(),
    };
    save_meta(&root, &meta)?;
    Ok(root)
}

pub fn save_meta(project_root: &Path, meta: &ProjectMeta) -> Result<()> {
    let path = project_root.join(STATE_DIR).join(META_FILE);
    fs::write(path, serde_json::to_vec_pretty(meta)?)?;
    Ok(())
}

pub fn load_meta(project_root: &Path) -> Result<ProjectMeta> {
    let path = project_root.join(STATE_DIR).join(META_FILE);
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

/// 拷卡素材落地的根:工况 A 是「2. 原始素材」,工况 B 是「1. 待分类」。
pub fn raw_material_dir(project_root: &Path, scenario: Scenario) -> PathBuf {
    match scenario {
        Scenario::A => project_root.join(SCENARIO_A_DIRS[1]),
        Scenario::B => project_root.join(PENDING_DIR_B),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn date() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 8, 24).unwrap()
    }

    #[test]
    fn scenario_b_dirs_numbering_follows_spec() {
        let cats = vec!["开幕式".to_string(), "比赛".to_string(), "颁奖".to_string()];
        assert_eq!(
            scenario_b_dirs(&cats),
            vec![
                "1. 待分类",
                "2. 开幕式",
                "3. 比赛",
                "4. 颁奖",
                "5. 精选",
                "6. 其他"
            ]
        );
    }

    #[test]
    fn create_project_a_builds_template() {
        let tmp = tempdir().unwrap();
        let root = create_project(tmp.path(), date(), "校运会", Scenario::A, &[]).unwrap();
        assert_eq!(
            root.file_name().unwrap().to_str().unwrap(),
            "20260824_校运会"
        );
        for d in SCENARIO_A_DIRS {
            assert!(root.join(d).is_dir(), "缺少 {d}");
        }
        assert!(root.join(STATE_DIR).join(MANIFEST_DIR).is_dir());
        assert!(root.join(STATE_DIR).join(JOURNAL_DIR).is_dir());
        let meta = load_meta(&root).unwrap();
        assert_eq!(meta.scenario, Scenario::A);
        assert_eq!(meta.name, "校运会");
    }

    #[test]
    fn create_project_b_builds_template_with_curated_children() {
        let tmp = tempdir().unwrap();
        let cats = vec!["开幕式".to_string(), "比赛".to_string()];
        let root = create_project(tmp.path(), date(), "校运会", Scenario::B, &cats).unwrap();
        assert!(root.join("1. 待分类").is_dir());
        assert!(root.join("2. 开幕式").is_dir());
        assert!(root.join("3. 比赛").is_dir());
        assert!(root.join("4. 精选").join("待修").is_dir());
        assert!(root.join("4. 精选").join("已修").is_dir());
        assert!(root.join("5. 其他").is_dir());
    }

    #[test]
    fn create_project_refuses_duplicate() {
        let tmp = tempdir().unwrap();
        create_project(tmp.path(), date(), "校运会", Scenario::A, &[]).unwrap();
        assert!(matches!(
            create_project(tmp.path(), date(), "校运会", Scenario::A, &[]),
            Err(CoreError::AlreadyExists(_))
        ));
    }

    #[test]
    fn raw_material_dir_by_scenario() {
        let p = Path::new("/nas/20260824_x");
        assert!(raw_material_dir(p, Scenario::A).ends_with("2. 原始素材"));
        assert!(raw_material_dir(p, Scenario::B).ends_with("1. 待分类"));
    }
}
