//! 拷卡清单(manifest):记录每次拷卡任务的逐文件哈希与校验状态,
//! 既是审计凭证,也是断点续传的依据。存放于项目 `.ocard/manifests/`。

use super::project::{MANIFEST_DIR, STATE_DIR};
use super::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ManifestEntry {
    /// 相对于拷卡目标文件夹的路径(统一 `/` 分隔,跨平台互通)。
    pub rel_path: String,
    pub size: u64,
    pub xxh3: String,
    /// 目标端回读校验是否通过。
    pub verified: bool,
}

/// 开拷前锁定的计划清单项(评审复核 P0:清单必须持久化,
/// 暂停期间源文件消失时续传必须发现「计划内未拷」而非静默漏拷)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlannedFile {
    pub rel_path: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CopyManifest {
    pub id: String,
    /// 拷卡目标文件夹(相对项目根),如 `2. 原始素材/20260824_DJIRonin4D_B_ZS`。
    pub target_rel: String,
    /// 源卷标识(卷名/挂载点描述)。
    pub source_label: String,
    pub camera_code: String,
    pub operator: String,
    /// 摄影师+DIT 双确认的内容备注。
    pub note: String,
    /// 目的地路径(展示用,同时支撑项目统计里的目的地数)。
    #[serde(default)]
    pub destinations: Vec<String>,
    /// 开拷时刻的完整源清单(不可变);续传/重建以它为准判断「计划内未完成」。
    #[serde(default)]
    pub planned: Vec<PlannedFile>,
    pub created_at: DateTime<Utc>,
    pub completed: bool,
    pub entries: Vec<ManifestEntry>,
}

impl CopyManifest {
    pub fn new(
        target_rel: impl Into<String>,
        source_label: impl Into<String>,
        camera_code: impl Into<String>,
        operator: impl Into<String>,
        note: impl Into<String>,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            target_rel: target_rel.into(),
            source_label: source_label.into(),
            camera_code: camera_code.into(),
            operator: operator.into(),
            note: note.into(),
            destinations: Vec::new(),
            planned: Vec::new(),
            created_at: Utc::now(),
            completed: false,
            entries: Vec::new(),
        }
    }

    /// 断点续传判断:该文件是否已拷贝并通过校验(大小一致)。
    pub fn is_done(&self, rel_path: &str, size: u64) -> bool {
        self.entries
            .iter()
            .any(|e| e.rel_path == rel_path && e.size == size && e.verified)
    }

    pub fn upsert(&mut self, entry: ManifestEntry) {
        if let Some(e) = self
            .entries
            .iter_mut()
            .find(|e| e.rel_path == entry.rel_path)
        {
            *e = entry;
        } else {
            self.entries.push(entry);
        }
    }
}

pub fn manifest_dir(project_root: &Path) -> PathBuf {
    project_root.join(STATE_DIR).join(MANIFEST_DIR)
}

pub fn save(project_root: &Path, m: &CopyManifest) -> Result<()> {
    let dir = manifest_dir(project_root);
    fs::create_dir_all(&dir)?;
    let tmp = dir.join(format!("{}.json.tmp", m.id));
    fs::write(&tmp, serde_json::to_vec_pretty(m)?)?;
    fs::rename(&tmp, dir.join(format!("{}.json", m.id)))?;
    Ok(())
}

pub fn load(project_root: &Path, id: &str) -> Result<CopyManifest> {
    let path = manifest_dir(project_root).join(format!("{id}.json"));
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

/// 清单列表 + 健康度(损坏清单计数必须上报,零静默原则)。
#[derive(Debug, Default)]
pub struct ManifestList {
    pub manifests: Vec<CopyManifest>,
    /// 损坏/不可读被跳过的清单文件数。
    pub skipped: usize,
}

pub fn list(project_root: &Path) -> Result<ManifestList> {
    let dir = manifest_dir(project_root);
    let mut out = ManifestList::default();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().is_some_and(|e| e == "json") {
            match fs::read(&path) {
                Ok(bytes) => match serde_json::from_slice::<CopyManifest>(&bytes) {
                    Ok(m) => out.manifests.push(m),
                    Err(_) => out.skipped += 1,
                },
                Err(_) => out.skipped += 1,
            }
        }
    }
    out.manifests.sort_by_key(|m| m.created_at);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample() -> CopyManifest {
        let mut m = CopyManifest::new(
            "2. 原始素材/20260824_A7M4_A_ZS",
            "SDXC_01",
            "A7M4_A_ZS",
            "赵晋宇",
            "开幕式素材",
        );
        m.upsert(ManifestEntry {
            rel_path: "DCIM/100/IMG_0001.JPG".into(),
            size: 100,
            xxh3: "aa".into(),
            verified: true,
        });
        m
    }

    #[test]
    fn save_load_roundtrip_and_list() {
        let tmp = tempdir().unwrap();
        let m = sample();
        save(tmp.path(), &m).unwrap();
        let loaded = load(tmp.path(), &m.id).unwrap();
        assert_eq!(loaded.entries, m.entries);
        assert_eq!(loaded.camera_code, "A7M4_A_ZS");
        let l = list(tmp.path()).unwrap();
        assert_eq!(l.manifests.len(), 1);
        assert_eq!(l.skipped, 0);
    }

    #[test]
    fn is_done_requires_verified_and_size_match() {
        let mut m = sample();
        assert!(m.is_done("DCIM/100/IMG_0001.JPG", 100));
        assert!(!m.is_done("DCIM/100/IMG_0001.JPG", 101));
        assert!(!m.is_done("DCIM/100/IMG_0002.JPG", 100));
        m.upsert(ManifestEntry {
            rel_path: "DCIM/100/IMG_0001.JPG".into(),
            size: 100,
            xxh3: "aa".into(),
            verified: false,
        });
        assert!(!m.is_done("DCIM/100/IMG_0001.JPG", 100));
        assert_eq!(m.entries.len(), 1, "upsert 应覆盖同路径条目");
    }
}
