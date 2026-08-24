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
