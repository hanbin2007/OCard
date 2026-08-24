//! 卷检测:列出当前挂载的卷,标记可移动卷(存储卡/读卡器)。
//! 首版走轮询(sysinfo 跨三平台),平台原生事件通知(DiskArbitration/
//! Win32 卷通知/udev)作为后续增强,见 PRD §6.5。

use serde::Serialize;
use std::path::PathBuf;
use sysinfo::Disks;

#[derive(Debug, Clone, Serialize)]
pub struct VolumeInfo {
    pub name: String,
    pub mount_point: PathBuf,
    pub removable: bool,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub file_system: String,
}

/// 列出全部挂载卷。
pub fn list_volumes() -> Vec<VolumeInfo> {
    let disks = Disks::new_with_refreshed_list();
    disks
        .iter()
        .map(|d| VolumeInfo {
            name: d.name().to_string_lossy().to_string(),
            mount_point: d.mount_point().to_path_buf(),
            removable: d.is_removable(),
            total_bytes: d.total_space(),
            available_bytes: d.available_space(),
            file_system: d.file_system().to_string_lossy().to_string(),
        })
        .collect()
}

/// 只列可移动卷(拷卡源的候选)。
pub fn removable_volumes() -> Vec<VolumeInfo> {
    list_volumes().into_iter().filter(|v| v.removable).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_at_least_the_system_volume() {
        let vols = list_volumes();
        assert!(!vols.is_empty(), "任何系统至少有一个挂载卷");
        for v in &vols {
            assert!(v.mount_point.exists(), "挂载点应存在: {:?}", v.mount_point);
        }
    }

    #[test]
    fn removable_is_subset() {
        let all = list_volumes().len();
        let removable = removable_volumes().len();
        assert!(removable <= all);
    }
}

/// 卡片身份指纹文件:首次拷卡时写在卡根目录,身份随卡走(跨平台、免 OS API);
/// 格式化后自然消失——格式化过的卡本就该视为新卡(M2 技术债:卷标弱身份根治)。
pub const VOLUME_UID_FILE: &str = ".ocard-volume-id";

/// 读取卡片指纹(不存在/不可读为 None)。
pub fn read_volume_uid(mount: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(mount.join(VOLUME_UID_FILE)).ok()?;
    let uid = raw.trim();
    (!uid.is_empty() && uid.len() <= 64).then(|| uid.to_string())
}

/// 读取或写入卡片指纹。卡写保护/只读时返回 None(调用方须告知用户退化为卷名匹配)。
/// 写入用 `create_new` 独占竞选:两台工作站同时首拷同一张卡时只有一台写成,
/// 落败方回读胜者的 uid,不会互相截断(codex 评审 12)。
/// 调用方必须先完成源路径校验(确认是已挂载卷)再调用——别往任意目录写指纹。
pub fn ensure_volume_uid(mount: &std::path::Path) -> Option<String> {
    if let Some(uid) = read_volume_uid(mount) {
        return Some(uid);
    }
    let uid = uuid::Uuid::new_v4().to_string();
    match std::fs::File::create_new(mount.join(VOLUME_UID_FILE)) {
        Ok(mut f) => {
            use std::io::Write;
            f.write_all(uid.as_bytes()).ok().map(|_| uid)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => read_volume_uid(mount),
        Err(_) => None,
    }
}

#[cfg(test)]
mod uid_tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn ensure_creates_once_and_rereads() {
        let tmp = tempdir().unwrap();
        let a = ensure_volume_uid(tmp.path()).unwrap();
        let b = ensure_volume_uid(tmp.path()).unwrap();
        assert_eq!(a, b);
        assert_eq!(read_volume_uid(tmp.path()).unwrap(), a);
    }

    #[test]
    fn missing_or_garbage_is_none() {
        let tmp = tempdir().unwrap();
        assert!(read_volume_uid(tmp.path()).is_none());
        std::fs::write(tmp.path().join(VOLUME_UID_FILE), "  \n").unwrap();
        assert!(read_volume_uid(tmp.path()).is_none());
    }
}
