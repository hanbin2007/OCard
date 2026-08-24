//! 平台原生文件系统增强(M2 技术债批):
//! - [`rename_no_replace`]:原子防覆盖改名(macOS `renamex_np(RENAME_EXCL)`、
//!   Linux `renameat2(RENAME_NOREPLACE)`、Windows `MoveFileExW` 无替换旗标——
//!   三者在目标已存在时都原子失败),文件系统不支持时回退 hard_link 再回退复查+rename;
//! - [`read_file_uncached`]:绕页缓存回读(macOS `F_NOCACHE`、Linux `posix_fadvise(DONTNEED)`;
//!   Windows 的 `FILE_FLAG_NO_BUFFERING` 需扇区对齐读,复杂度高,**如实记录为未覆盖边界**,
//!   该平台回退普通读)。

use std::fs;
use std::io::{self, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// 「最后回退(复查+rename)被真实使用」标记。该回退只在文件系统既不支持
/// 平台原子原语也不支持硬链接时触发,存在检查-改名窗口(NAS 上可达网络往返
/// 量级)。零静默原则:上层取走标记后必须给用户一次可见警告。
static UNSAFE_FALLBACK_USED: AtomicBool = AtomicBool::new(false);

/// 取走「最后回退被使用」标记(swap 语义,取走即清零)。
pub fn take_unsafe_fallback_flag() -> bool {
    UNSAFE_FALLBACK_USED.swap(false, Ordering::Relaxed)
}

/// 原子防覆盖改名:目标已存在时失败(`AlreadyExists`),绝不替换。
pub fn rename_no_replace(src: &Path, dst: &Path) -> io::Result<()> {
    platform_rename_no_replace(src, dst).or_else(|e| {
        if e.kind() == io::ErrorKind::AlreadyExists {
            return Err(e);
        }
        // 平台原语不可用(旧内核/异构文件系统):hard_link 仍是原子防覆盖
        match fs::hard_link(src, dst) {
            Ok(()) => fs::remove_file(src),
            Err(le) if le.kind() == io::ErrorKind::AlreadyExists => {
                Err(io::Error::new(io::ErrorKind::AlreadyExists, le))
            }
            Err(_) => {
                // 最后回退:复查+rename。窗口在本地盘是微秒级,在不支持
                // 原语/硬链接的网络盘上可达网络往返量级——置标记让上层告警
                UNSAFE_FALLBACK_USED.store(true, Ordering::Relaxed);
                if dst.exists() {
                    return Err(io::Error::from(io::ErrorKind::AlreadyExists));
                }
                fs::rename(src, dst)
            }
        }
    })
}

#[cfg(target_os = "macos")]
fn platform_rename_no_replace(src: &Path, dst: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let s = CString::new(src.as_os_str().as_bytes())?;
    let d = CString::new(dst.as_os_str().as_bytes())?;
    // renamex_np: RENAME_EXCL = 目标存在即 EEXIST,原子
    const RENAME_EXCL: u32 = 0x00000004;
    let rc = unsafe { libc::renamex_np(s.as_ptr(), d.as_ptr(), RENAME_EXCL) };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn platform_rename_no_replace(src: &Path, dst: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let s = CString::new(src.as_os_str().as_bytes())?;
    let d = CString::new(dst.as_os_str().as_bytes())?;
    let rc = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            s.as_ptr(),
            libc::AT_FDCWD,
            d.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "windows")]
fn platform_rename_no_replace(src: &Path, dst: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    let w = |p: &Path| -> Vec<u16> {
        p.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };
    let s = w(src);
    let d = w(dst);
    // 不带 MOVEFILE_REPLACE_EXISTING:目标存在时失败,原子
    extern "system" {
        fn MoveFileExW(
            lpExistingFileName: *const u16,
            lpNewFileName: *const u16,
            dwFlags: u32,
        ) -> i32;
    }
    const MOVEFILE_COPY_ALLOWED: u32 = 0x2;
    let rc = unsafe { MoveFileExW(s.as_ptr(), d.as_ptr(), MOVEFILE_COPY_ALLOWED) };
    if rc != 0 {
        Ok(())
    } else {
        let e = io::Error::last_os_error();
        // ERROR_ALREADY_EXISTS(183)/ERROR_FILE_EXISTS(80) 归一为 AlreadyExists
        match e.raw_os_error() {
            Some(80) | Some(183) => Err(io::Error::from(io::ErrorKind::AlreadyExists)),
            _ => Err(e),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn platform_rename_no_replace(_src: &Path, _dst: &Path) -> io::Result<()> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

/// 打开文件并尽量绕过页缓存(校验用:让回读尽量来自介质而非内存)。
/// Windows 回退普通打开(如实标注的边界,见模块文档)。
pub fn open_uncached(path: &Path) -> io::Result<fs::File> {
    let file = fs::File::open(path)?;
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        unsafe {
            libc::fcntl(file.as_raw_fd(), libc::F_NOCACHE, 1);
        }
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        unsafe {
            libc::posix_fadvise(file.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED);
        }
    }
    Ok(file)
}

/// 绕页缓存读取整个文件(小文件/测试用;大文件请用 open_uncached 流式处理)。
pub fn read_file_uncached(path: &Path) -> io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    open_uncached(path)?.read_to_end(&mut buf)?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn rename_no_replace_moves_and_refuses_existing() {
        let tmp = tempdir().unwrap();
        let a = tmp.path().join("a.bin");
        let b = tmp.path().join("b.bin");
        fs::write(&a, b"data").unwrap();

        rename_no_replace(&a, &b).unwrap();
        assert!(!a.exists());
        assert_eq!(fs::read(&b).unwrap(), b"data");

        // 目标已存在:必须原子失败,且两边内容不变
        fs::write(&a, b"other").unwrap();
        let err = rename_no_replace(&a, &b).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&a).unwrap(), b"other");
        assert_eq!(fs::read(&b).unwrap(), b"data");
    }

    #[test]
    fn uncached_read_returns_full_content() {
        let tmp = tempdir().unwrap();
        let p = tmp.path().join("x.bin");
        let payload = vec![0x5Au8; 3 * 1024 * 1024];
        fs::write(&p, &payload).unwrap();
        assert_eq!(read_file_uncached(&p).unwrap(), payload);
    }
}
