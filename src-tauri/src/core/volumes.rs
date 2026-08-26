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
    /// 系统内置盘(启动盘/系统分区):拷卡源默认隐藏,防止误把本机磁盘当卡拷。
    pub system: bool,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub file_system: String,
}

/// 判定挂载点是否属于系统内置盘(启动盘/系统分区)。按平台挂载习惯判定:
/// - macOS:`/` 与 `/System/Volumes/*`(启动卷组);外接盘都在 `/Volumes/*`。
/// - Windows:系统盘符(`SystemDrive`,通常 `C:`)。
/// - Linux:可移动介质通常挂在 `/media`、`/run/media`、`/mnt` 下,
///   其余(`/`、`/home`、`/boot`,也包括 `/srv`、`/data` 等手工挂载点)
///   一律按系统盘对待——误藏可由 UI 开关找回,误露启动盘代价更高。
///
/// 口径:只针对「启动卷/系统分区」;第二块内录数据盘不会被标记,
/// 拷卡确认屏对系统盘另有 danger 提示兜底。判定只影响默认过滤。
pub fn is_system_mount(mount: &std::path::Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        // Path::starts_with 按路径组件比对:/System/VolumesFoo 不会误命中
        return mount == std::path::Path::new("/") || mount.starts_with("/System/Volumes");
    }
    #[cfg(windows)]
    {
        let sys_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        let m = mount.to_string_lossy().to_ascii_uppercase();
        let sys = sys_drive.to_ascii_uppercase();
        return m == sys || m == format!("{sys}\\");
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let m = mount.to_string_lossy();
        return !(m.starts_with("/media/")
            || m.starts_with("/run/media/")
            || m.starts_with("/mnt/"));
    }
    #[allow(unreachable_code)]
    false
}

/// 列出全部挂载卷。
/// 两次挂载表快照的差集(卷 id = 挂载路径):返回 (新插入, 已移除)。
/// 纯函数,卷监视线程用它判定插拔事件;顺序稳定(按 current/prev 原序)。
pub fn diff_ids(
    prev: &std::collections::BTreeSet<String>,
    current: &[VolumeInfo],
) -> (Vec<String>, Vec<String>) {
    let cur_ids: std::collections::BTreeSet<String> = current
        .iter()
        .map(|v| v.mount_point.display().to_string())
        .collect();
    let inserted = current
        .iter()
        .map(|v| v.mount_point.display().to_string())
        .filter(|id| !prev.contains(id))
        .collect();
    let removed = prev
        .iter()
        .filter(|id| !cur_ids.contains(*id))
        .cloned()
        .collect();
    (inserted, removed)
}

pub fn list_volumes() -> Vec<VolumeInfo> {
    let disks = Disks::new_with_refreshed_list();
    disks
        .iter()
        .map(|d| VolumeInfo {
            name: d.name().to_string_lossy().to_string(),
            mount_point: d.mount_point().to_path_buf(),
            removable: d.is_removable(),
            system: is_system_mount(d.mount_point()),
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

    #[test]
    fn system_mount_detection_per_platform() {
        use std::path::Path;
        #[cfg(target_os = "macos")]
        {
            assert!(is_system_mount(Path::new("/")));
            assert!(is_system_mount(Path::new("/System/Volumes/Data")));
            assert!(!is_system_mount(Path::new("/Volumes/SDCARD")));
            assert!(!is_system_mount(Path::new("/Volumes/DIT-NAS")));
        }
        #[cfg(windows)]
        {
            assert!(is_system_mount(Path::new("C:\\")));
            assert!(is_system_mount(Path::new("c:")));
            assert!(!is_system_mount(Path::new("E:\\")));
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            assert!(is_system_mount(Path::new("/")));
            assert!(is_system_mount(Path::new("/home")));
            assert!(!is_system_mount(Path::new("/media/user/SDCARD")));
            assert!(!is_system_mount(Path::new("/run/media/user/SDCARD")));
            assert!(!is_system_mount(Path::new("/mnt/card")));
        }
    }

    #[test]
    fn current_machine_reports_at_least_one_system_volume() {
        // 真机上系统盘一定在列且被标记(macOS `/`、Windows C:、Linux `/`)。
        // 容器环境(overlayfs 被 sysinfo 滤掉)可能一张盘都列不出,不算失败
        let vols = list_volumes();
        if !vols.is_empty() {
            assert!(vols.iter().any(|v| v.system));
        }
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
    let path = mount.join(VOLUME_UID_FILE);
    match std::fs::File::create_new(&path) {
        Ok(mut f) => {
            use std::io::Write;
            match f.write_all(uid.as_bytes()) {
                Ok(()) => Some(uid),
                Err(_) => {
                    // 写不进内容就别留 0 字节壳:否则这张卡永远拿不到指纹
                    drop(f);
                    let _ = std::fs::remove_file(&path);
                    None
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // 竞选落败:胜者可能刚建好还没写完内容,短暂重试再放弃
            for _ in 0..5 {
                if let Some(uid) = read_volume_uid(mount) {
                    return Some(uid);
                }
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
            read_volume_uid(mount)
        }
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
    fn empty_shell_file_yields_none_not_panic() {
        // 复验:竞选落败读到空壳(胜者写入失败残留)→ 重试后返回 None,
        // 每次都会伴随上层的可见警告,不静默
        let tmp = tempdir().unwrap();
        std::fs::write(tmp.path().join(VOLUME_UID_FILE), b"").unwrap();
        assert!(ensure_volume_uid(tmp.path()).is_none());
    }

    #[test]
    fn missing_or_garbage_is_none() {
        let tmp = tempdir().unwrap();
        assert!(read_volume_uid(tmp.path()).is_none());
        std::fs::write(tmp.path().join(VOLUME_UID_FILE), "  \n").unwrap();
        assert!(read_volume_uid(tmp.path()).is_none());
    }

    fn vol(path: &str) -> VolumeInfo {
        VolumeInfo {
            name: path.trim_start_matches("/Volumes/").to_string(),
            mount_point: std::path::PathBuf::from(path),
            removable: true,
            system: false,
            total_bytes: 0,
            available_bytes: 0,
            file_system: "exfat".to_string(),
        }
    }

    #[test]
    fn diff_ids_detects_insert_and_remove() {
        let prev: std::collections::BTreeSet<String> =
            ["/Volumes/A".to_string(), "/Volumes/B".to_string()].into();
        let cur = [vol("/Volumes/B"), vol("/Volumes/C")];
        let (ins, rem) = diff_ids(&prev, &cur);
        assert_eq!(ins, vec!["/Volumes/C".to_string()]);
        assert_eq!(rem, vec!["/Volumes/A".to_string()]);
    }

    #[test]
    fn diff_ids_no_change_is_empty() {
        let prev: std::collections::BTreeSet<String> = ["/Volumes/A".to_string()].into();
        let (ins, rem) = diff_ids(&prev, &[vol("/Volumes/A")]);
        assert!(ins.is_empty());
        assert!(rem.is_empty());
    }
}
