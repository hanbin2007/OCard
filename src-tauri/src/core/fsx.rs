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
/// 绕缓存请求被内核拒绝的次数(R4 终审 P1:此前返回值被忽略,「介质回读」
/// 保证会无提示退化成普通缓存读;计数由命令层聚合为可见提示)。
static UNCACHED_FALLBACKS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 取走绕缓存退化计数(swap 清零)。
pub fn take_uncached_fallbacks() -> u64 {
    UNCACHED_FALLBACKS.swap(0, std::sync::atomic::Ordering::Relaxed)
}

pub fn open_uncached(path: &Path) -> io::Result<fs::File> {
    let file = fs::File::open(path)?;
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        let rc = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_NOCACHE, 1) };
        if rc != 0 {
            UNCACHED_FALLBACKS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let rc = unsafe { libc::posix_fadvise(file.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };
        if rc != 0 {
            UNCACHED_FALLBACKS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
    #[cfg(windows)]
    {
        // Windows 无扇区对齐读实现,固定按退化计数(声明边界的可见化)
        UNCACHED_FALLBACKS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
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

/// 拷贝后时间戳保留失败计数(零静默:命令层取走后聚合告警)。
static TIMES_PRESERVE_FAILURES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 取走时间戳保留失败数(swap 清零)。
pub fn take_times_preserve_failures() -> u64 {
    TIMES_PRESERVE_FAILURES.swap(0, std::sync::atomic::Ordering::Relaxed)
}

/// 外部记入 N 次保留失败(如:源元数据在读取前就拿不到,时间戳注定无法保留)。
pub fn note_times_preserve_failures(n: u64) {
    TIMES_PRESERVE_FAILURES.fetch_add(n, std::sync::atomic::Ordering::Relaxed);
}

/// 把源文件的时间戳复制到目标(拷卡/交付/精选的复制路径都要调):
/// - mtime/atime:三平台;
/// - **创建时间**:macOS/Windows 可设,Linux 文件系统不支持设置 btime
///   (声明边界:Linux 上创建时间为拷贝时刻,mtime 仍与源一致)。
///
/// 失败不阻塞复制(数据本体安全),计数由上层聚合为可见 warning。
/// 返回 Ok(true)=全字段保留;Ok(false)=部分字段(atime/创建时间)取不到,
/// 已按可得字段保留(R4 终审:部分退化也要计数可见,不再静默跳过);
/// mtime 取不到=Err(mtime 是硬承诺)。
pub fn preserve_times(src_meta: &fs::Metadata, dst: &Path) -> io::Result<bool> {
    let mut full = true;
    let mut times = fs::FileTimes::new();
    // mtime 是硬承诺,取不到按失败计
    times = times.set_modified(src_meta.modified()?);
    match src_meta.accessed() {
        Ok(a) => times = times.set_accessed(a),
        Err(_) => full = false,
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::FileTimesExt;
        match src_meta.created() {
            Ok(c) => times = times.set_created(c),
            Err(_) => full = false,
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTimesExt;
        match src_meta.created() {
            Ok(c) => times = times.set_created(c),
            Err(_) => full = false,
        }
    }
    let f = fs::OpenOptions::new().write(true).open(dst)?;
    f.set_times(times)?;
    Ok(full)
}

/// 带失败计数的便捷封装(复制落位后调用)。
pub fn preserve_times_counted(src_meta: &fs::Metadata, dst: &Path) {
    // Err(含 mtime 缺失)与部分退化(Ok(false))都计入聚合告警,零静默
    if !matches!(preserve_times(src_meta, dst), Ok(true)) {
        TIMES_PRESERVE_FAILURES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
}

#[cfg(test)]
mod times_tests {
    use super::*;
    use tempfile::tempdir;

    /// R2 变异复核:旧版用 `fs::copy` 造场景,而 macOS 的 `fs::copy` 本身就
    /// 克隆时间戳——把 `preserve_times` 改成空操作断言照样通过(恒真)。
    /// 现在按生产形状造场景:目标是**新写出的文件**(时间戳=现在),
    /// `preserve_times` 必须把它拉回源的旧值,空操作必红。
    #[test]
    fn preserve_times_actually_rewrites_target_mtime() {
        let tmp = tempdir().unwrap();
        let src = tmp.path().join("src.bin");
        let dst = tmp.path().join("dst.bin");
        fs::write(&src, b"data").unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(86400 * 30);
        let f = fs::OpenOptions::new().write(true).open(&src).unwrap();
        f.set_times(fs::FileTimes::new().set_modified(old)).unwrap();
        drop(f);
        let src_meta = fs::metadata(&src).unwrap();

        // 生产形状:目标是刚写出的新文件(mtime=现在,与源相差 30 天)
        fs::write(&dst, b"data").unwrap();
        let before = fs::metadata(&dst).unwrap().modified().unwrap();
        assert!(
            before
                .duration_since(src_meta.modified().unwrap())
                .map(|d| d.as_secs() > 86400)
                .unwrap_or(false),
            "前置:新写目标的 mtime 必须明显晚于源,否则本测试退化为恒真"
        );

        preserve_times(&src_meta, &dst).unwrap();
        let dm = fs::metadata(&dst).unwrap().modified().unwrap();
        let sm = src_meta.modified().unwrap();
        let diff = dm
            .duration_since(sm)
            .unwrap_or_else(|e| e.duration())
            .as_secs();
        assert!(diff <= 2, "mtime 必须被改写为源值(差 {diff}s)");
    }

    /// 计数→告警取数的接线(R2 变异复核:取数改常量 0 时此测试红)。
    #[test]
    fn times_failure_counter_roundtrip() {
        let _ = take_times_preserve_failures(); // 清零(其它测试可能污染)
        note_times_preserve_failures(2);
        let tmp = tempdir().unwrap();
        let src = tmp.path().join("s");
        fs::write(&src, b"x").unwrap();
        let meta = fs::metadata(&src).unwrap();
        // 目标不存在 → preserve_times_counted 记 1 次失败
        preserve_times_counted(&meta, &tmp.path().join("不存在"));
        // 计数器全局共享,并行测试可能有额外增量——只断下界,不断精确值
        assert!(take_times_preserve_failures() >= 3, "计数→取数接线必须通");
    }
}
