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

    /// 守门人说不:临时文件写了但不发布——目标不许出现,临时文件也不许留下。
    #[test]
    fn a_guarded_write_refused_before_publish_leaves_nothing_behind() {
        let t = tempfile::tempdir().unwrap();
        let target = t.path().join("m.json");
        let r = write_atomic_guarded(&target, b"{}", &|| false);
        assert!(
            matches!(r, Err(GuardedWrite::Refused { retries: 0 })),
            "{r:?}"
        );
        assert!(!target.exists(), "守门人说不之后仍发布了");
        let leftovers = std::fs::read_dir(t.path()).unwrap().count();
        assert_eq!(leftovers, 0, "临时文件没清掉");
    }

    /// 守门人放行:与普通 write_atomic 一样落盘。
    #[test]
    fn a_guarded_write_allowed_publishes_like_write_atomic() {
        let t = tempfile::tempdir().unwrap();
        let target = t.path().join("m.json");
        let r = write_atomic_guarded(&target, b"{\"a\":1}", &|| true).unwrap();
        assert_eq!(r.retries, 0);
        assert_eq!(std::fs::read(&target).unwrap(), b"{\"a\":1}");
    }
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

    /// R5 终审:atime 与(mac)创建时间也是保留承诺的一部分——
    /// 不只 mtime;新写目标经 preserve_times 后三者都要回到源值。
    #[test]
    fn preserve_times_covers_atime_and_created() {
        let tmp = tempdir().unwrap();
        let src = tmp.path().join("src.bin");
        let dst = tmp.path().join("dst.bin");
        fs::write(&src, b"data").unwrap();
        let old_m = std::time::SystemTime::now() - std::time::Duration::from_secs(86400 * 30);
        let old_a = std::time::SystemTime::now() - std::time::Duration::from_secs(86400 * 20);
        let f = fs::OpenOptions::new().write(true).open(&src).unwrap();
        #[cfg(target_os = "macos")]
        {
            // R5 三票:created 也要预先拉开——否则「源/目标同刻创建」下
            // 空实现也能靠 2 秒容差混过
            use std::os::macos::fs::FileTimesExt;
            let old_c = std::time::SystemTime::now() - std::time::Duration::from_secs(86400 * 45);
            f.set_times(
                fs::FileTimes::new()
                    .set_modified(old_m)
                    .set_accessed(old_a)
                    .set_created(old_c),
            )
            .unwrap();
        }
        #[cfg(not(target_os = "macos"))]
        f.set_times(fs::FileTimes::new().set_modified(old_m).set_accessed(old_a))
            .unwrap();
        drop(f);
        let src_meta = fs::metadata(&src).unwrap();
        fs::write(&dst, b"data").unwrap();
        assert!(matches!(preserve_times(&src_meta, &dst), Ok(true)));
        let dm = fs::metadata(&dst).unwrap();
        let close = |a: std::time::SystemTime, b: std::time::SystemTime| {
            a.duration_since(b)
                .unwrap_or_else(|e| e.duration())
                .as_secs()
                <= 2
        };
        assert!(
            close(dm.accessed().unwrap(), src_meta.accessed().unwrap()),
            "atime 必须保留"
        );
        #[cfg(target_os = "macos")]
        assert!(
            close(dm.created().unwrap(), src_meta.created().unwrap()),
            "macOS 创建时间必须保留"
        );
    }
}

/* ------------------------------------------------------------------ *
 * 原子写(替换语义)。0.4.3 现场事故:Windows 上拷卡跑到一半整任务中断,
 * 报文只有「IO 错误: 拒绝访问。 (os error 5)」——既没说是哪个文件,
 * 也没说该做什么。查下来是 `manifest::save` 的 `fs::write` + `fs::rename`:
 *
 * ① Windows 的 rename 是 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`(std 在拿到
 *    AccessDenied 后还会试一次 `FileRenameInfoEx` 的 POSIX 语义,但 SMB 上
 *    未必支持)。目标文件只要**被别的进程开着**且对方没给 FILE_SHARE_DELETE,
 *    就 ACCESS_DENIED(5)。杀毒软件、Windows Search、NAS 自己的索引在文件刚
 *    落地时抢着扫,是常态。POSIX 的 rename 不受打开句柄影响,所以
 *    macOS/Linux 上一次都没见过。
 * ② 清单是**每拷完一个文件就重写一次**的,一张两千个文件的卡就有两千次机会。
 * ③ 临时名固定成 `<id>.json.tmp`:同一任务被两处同时写时会互相截断,
 *    失败后临时文件还留在 NAS 上没人清。
 *
 * 对策:唯一临时名 + 对「占用类」错误做有界重试。Windows 把「有人占着」和
 * 「你真没权限」压在同一个错误码 5 上,从错误码分不开——只能靠重试分:
 * 重试后成功 = 占用,重试到底 = 真的写不了。
 *
 * **边界(不要过度承诺)**:这里的「原子」是**可见性原子**——读者要么看到旧的
 * 完整内容,要么看到新的完整内容,绝不会看到写了一半的。它**不是掉电原子**:
 * 没有 `sync_all`,也没有对目录项 fsync,断电后 rename 有可能先于数据落盘。
 * 按「每拷一个文件存一次」的频率,逐次 fsync 的代价在 NAS 上不可接受。
 * ------------------------------------------------------------------ */

/// 重试节奏(毫秒)。总计约 1.6s:够躲开杀毒软件的扫描窗口,又不至于让
/// 「真的没权限」这种确定性失败在界面上卡住太久。
///
/// 带抖动(见 [`backoff_with_jitter`]):两个进程同时撞上占用时,固定节奏会让
/// 它们在完全相同的时刻重试,锁步互相踩。
const WRITE_RETRY_BACKOFF_MS: [u64; 5] = [20, 60, 150, 400, 900];

/// 这次失败像不像「现在有人占着,等一下就好」。
///
/// Windows:`ERROR_ACCESS_DENIED(5)`(替换正被打开的目标)、
/// `ERROR_SHARING_VIOLATION(32)`、`ERROR_LOCK_VIOLATION(33)`。
/// POSIX 上 `PermissionDenied` 基本是确定性的,但 SMB/NFS 客户端会在
/// 会话重连的窗口里短暂返回 EACCES,重试同样划算。
fn is_contention(e: &io::Error) -> bool {
    if matches!(
        e.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::ResourceBusy
    ) {
        return true;
    }
    #[cfg(windows)]
    {
        matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33))
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// 第 `attempt` 次重试等多久。基数取自 [`WRITE_RETRY_BACKOFF_MS`],再叠 ±25%
/// 的抖动打散并发重试的锁步。抖动源用 uuid 的低位——这里不需要密码学随机,
/// 只需要两个进程不同步。
fn backoff_with_jitter(attempt: usize) -> std::time::Duration {
    let base = WRITE_RETRY_BACKOFF_MS[attempt];
    let noise = u128::from_le_bytes(*uuid::Uuid::new_v4().as_bytes()) as u64;
    // base/2 的一半 = ±25%
    let spread = (base / 2).max(1);
    let delta = noise % spread.max(1);
    std::time::Duration::from_millis(base - spread / 2 + delta)
}

/// 本次写入用的临时文件名。**每次调用都不同**:固定临时名是 0.4.3 事故的
/// 第三个因子——同一目标被两处同时写时会互相截断,失败后还留垃圾在 NAS 上。
///
/// 名字形状 `.<目标名>.<8 位十六进制>.tmp`,并统一以 [`TMP_SUFFIX`] 结尾,
/// 好让启动期的残留清扫认得出它。用 8 位而不是完整 uuid 是因为路径长度:
/// 36 位 uuid 会比目标名多出 41 个字符,项目路径深的 NAS 上原本能过 MAX_PATH
/// 的清单会因为临时名超长而失败,报的还是「路径不存在」这种完全错误的方向。
fn tmp_name_for(path: &Path) -> std::path::PathBuf {
    let dir = path.parent().unwrap_or(Path::new("."));
    let stem = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "out".into());
    let tag = &uuid::Uuid::new_v4().simple().to_string()[..8];
    dir.join(format!(".{stem}.{tag}{TMP_SUFFIX}"))
}

/// 原子写的临时文件后缀。启动期残留清扫按它识别(见 `commands::sweep_stale_temp_files`)。
pub const TMP_SUFFIX: &str = ".ocardtmp";

/// 一次原子写的结果:成功,外加**这次**为了躲开占用重试了几轮。
///
/// 重试次数按调用返回而不是进全局计数器(评审):`WRITE_CONTENTION` 那种
/// 进程级 static 会被拷卡/分类/转码三条路径互相抢走,谁先结束谁把计数领走,
/// 告警就归因到了错误的操作上——「把项目目录加进白名单」这条建议,用户
/// 因此不知道该加哪个目录。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WriteReport {
    pub retries: u32,
}

/// 原子写(替换语义):唯一临时文件 → 落盘 → rename 顶掉旧文件。
/// 占用类失败自动重试;失败时不留临时文件。
///
/// **只重试 rename,不重试写**(评审):临时文件是新建的唯一名,写它失败
/// 基本只有确定性原因(目录没权限、盘满、路径超长),重试纯属白等;而反复
/// 重写还会一次次重新触发杀毒软件对新文件的扫描,让重试自我续期。
///
/// 与 [`rename_no_replace`] 的分工:那个是**绝不覆盖**(拷贝落点,覆盖=毁素材);
/// 这个是**就要覆盖**(清单/状态文件,新版本本来就该顶掉旧版本)。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<WriteReport, RetryFailure> {
    write_atomic_with(path, bytes, |from, to| fs::rename(from, to))
}

/// 守门版 [`write_atomic`]:临时文件写完、**改名之前**再问一句 `before_publish`,答否
/// 就不发布(临时文件照常清掉)。给写栅栏用:写一份几 MB 的清单是落盘里最长的一段,
/// 栅栏在这一段里被回收的话,改名前还能拦住——事后 `still_mine` 只能发现,拦不住。
///
/// `before_publish` **会被调用多次**:改名撞上占用时每重试一轮都再问一次。它必须
/// 幂等、只看事实(锁标记还在不在),不能按调用次数计。
pub fn write_atomic_guarded(
    path: &Path,
    bytes: &[u8],
    before_publish: &dyn Fn() -> bool,
) -> Result<WriteReport, GuardedWrite> {
    let refused = std::cell::Cell::new(false);
    let attempts = std::cell::Cell::new(0u32);
    let r = write_atomic_with(path, bytes, |from, to| {
        attempts.set(attempts.get() + 1);
        if !before_publish() {
            refused.set(true);
            return Err(io::Error::other("write fence refused"));
        }
        fs::rename(from, to)
    });
    match r {
        Ok(w) => Ok(w),
        Err(_) if refused.get() => Err(GuardedWrite::Refused {
            retries: attempts.get().saturating_sub(1),
        }),
        Err(f) => Err(GuardedWrite::Failed(f)),
    }
}

/// [`write_atomic_guarded`] 的两种失败:守门人说不(带上说不之前已经为占用重试过的
/// 轮数——那是可见的降级,不能丢),或真正的写失败。
#[derive(Debug)]
pub enum GuardedWrite {
    Refused { retries: u32 },
    Failed(RetryFailure),
}

/// [`write_atomic`] 的本体,`rename` 可注入。
///
/// 存在只为一件事:让「write_atomic 到底有没有真的走重试」可以被直接断言。
/// 评审两路都指出过——只考 `retry_contended` 的话,把 `write_atomic` 里的
/// 重试拆掉换成裸 `fs::rename`,测试照样全绿。
fn write_atomic_with(
    path: &Path,
    bytes: &[u8],
    mut rename: impl FnMut(&Path, &Path) -> io::Result<()>,
) -> Result<WriteReport, RetryFailure> {
    // 临时名 8 位随机:撞车概率极低但不是零,而 `fs::write` 会把撞上的那份截断。
    // 用 create_new 取名,撞了就换一个,最多三次
    let mut tmp = tmp_name_for(path);
    let mut file = None;
    for _ in 0..3 {
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
        {
            Ok(f) => {
                file = Some(f);
                break;
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => tmp = tmp_name_for(path),
            Err(e) => {
                // 临时文件是**新建的唯一名**,建不出来只有确定性原因(目录没权限、
                // 盘满、路径超长),一轮都没重试过
                return Err(RetryFailure {
                    retries: 0,
                    source: e,
                });
            }
        }
    }
    let Some(mut f) = file else {
        return Err(RetryFailure {
            retries: 0,
            source: io::Error::new(io::ErrorKind::AlreadyExists, "临时文件名连续三次撞车"),
        });
    };
    if let Err(e) = std::io::Write::write_all(&mut f, bytes) {
        drop(f);
        cleanup_tmp(&tmp);
        return Err(RetryFailure {
            retries: 0,
            source: e,
        });
    }
    drop(f);

    match retry_contended(|| rename(&tmp, path)) {
        Ok(retries) => Ok(WriteReport { retries }),
        Err(e) => {
            cleanup_tmp(&tmp);
            Err(e)
        }
    }
}

/// 对「占用类」失败做有界重试,返回**重试轮数**(0 = 一次就成)。
///
/// 重试语义整个装在这里,不散在调用点上:这样它能被直接考——「失败两次、
/// 第三次成功」「一直失败要原样上抛」「确定性错误一次都不重试」三条路,
/// 都不需要真的去锁一个文件。评审两路都指出过:守卫全落在成功路径上时,
/// 把整个循环删掉照样绿。
/// 一次失败,外加**失败前已经重试了几轮**。
///
/// 轮数在失败路径上尤其值钱,而那恰恰是它此前被丢掉的地方:重试满 5 轮仍被拒,
/// 意味着系统已经用一秒半替用户排除掉了「真的没有写权限」那一支——真没权限的话
/// 第一次就失败,而且不会因为等一会儿就变。报文若不说这句,用户还得自己在
/// 「有人占着」和「没权限」两条分支里猜,那正是 0.4.3 事故里最贵的一步。
#[derive(Debug)]
pub struct RetryFailure {
    pub retries: u32,
    pub source: io::Error,
}

impl RetryFailure {
    /// 拼进报文的那半句(没重试过就是空串)。
    ///
    /// 措辞要诚实:重试满还失败**分不出**是「一直被占着」还是「权限/SMB 会话
    /// 问题」——持久的 ACL 错误每一轮都会返回同一个错误码,重试排除不了它。
    /// 只有「重试后成功」才能证明是瞬时占用。
    pub fn note(&self) -> String {
        if self.retries == 0 {
            String::new()
        } else {
            format!(
                "(已自动重试 {} 轮、等了约 {:.1} 秒仍被拒:要么一直被别的程序占着,要么是权限/SMB 会话问题——仅凭这个错误码分不出来,两条都要查)",
                self.retries,
                WRITE_RETRY_BACKOFF_MS[..self.retries as usize]
                    .iter()
                    .sum::<u64>() as f64
                    / 1000.0
            )
        }
    }
}

pub fn retry_contended(mut op: impl FnMut() -> io::Result<()>) -> Result<u32, RetryFailure> {
    let mut attempt = 0usize;
    loop {
        match op() {
            Ok(()) => return Ok(attempt as u32),
            Err(e) => {
                if attempt >= WRITE_RETRY_BACKOFF_MS.len() || !is_contention(&e) {
                    return Err(RetryFailure {
                        retries: attempt as u32,
                        source: e,
                    });
                }
                std::thread::sleep(backoff_with_jitter(attempt));
                attempt += 1;
            }
        }
    }
}

/// 清理没能改名成功的临时文件。清不掉要说话:NAS 上攒下无人认领的临时文件
/// 是**无界**的(每次都是新名字),而它们每个都是一份完整清单。
fn cleanup_tmp(tmp: &Path) {
    match fs::remove_file(tmp) {
        Ok(()) => {}
        // 本来就不在(写都没成功)——正常
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => log::warn!("原子写的临时文件清不掉,已留在盘上: {} — {e}", tmp.display()),
    }
}

#[cfg(test)]
mod write_atomic_tests {
    use super::*;
    use tempfile::tempdir;

    /// 目标目录里除 `keep` 之外的东西(= 残留临时文件)。
    fn strays(dir: &Path, keep: &str) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n != keep)
            .collect()
    }

    #[test]
    fn write_atomic_replaces_and_leaves_no_temp_files() {
        let tmp = tempdir().unwrap();
        let p = tmp.path().join("m.json");
        assert_eq!(write_atomic(&p, b"v1").unwrap().retries, 0);
        assert_eq!(fs::read(&p).unwrap(), b"v1");
        // 替换语义:第二次要顶掉第一次(与 rename_no_replace 相反)
        write_atomic(&p, b"v2").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"v2");

        let leftovers = strays(tmp.path(), "m.json");
        assert!(leftovers.is_empty(), "临时文件必须清干净: {leftovers:?}");
    }

    /// 临时名退回固定名(如 `<id>.json.tmp`)时本测试红——考的是真实实现,
    /// 不是 uuid 本身。
    #[test]
    fn write_atomic_uses_a_unique_temp_name_per_call() {
        let dir = Path::new("/x/y");
        let a = tmp_name_for(&dir.join("m.json"));
        let b = tmp_name_for(&dir.join("m.json"));
        assert_ne!(a, b, "同一目标两次写必须用不同的临时名");
        assert_eq!(
            a.parent(),
            Some(dir),
            "临时文件必须与目标同目录,rename 才是原子的"
        );
        for p in [&a, &b] {
            let n = p.file_name().unwrap().to_string_lossy();
            assert!(
                n.starts_with('.') && n.ends_with(TMP_SUFFIX),
                "临时名形状不对(启动期清扫按它识别残留): {n}"
            );
            // MAX_PATH:完整 uuid 会比目标名多出 41 个字符,项目路径深的 NAS 上
            // 原本能过的清单会因为临时名超长而失败,还报成「路径不存在」
            assert!(
                n.len() <= "m.json".len() + 24,
                "临时名比目标名长太多,深路径上会撞 MAX_PATH: {n}"
            );
        }
    }

    #[test]
    fn write_atomic_reports_hard_failures_instead_of_swallowing_them() {
        // 目录不存在 = 确定性失败,必须原样上抛(不能因为重试机制把它吞成 Ok)
        let tmp = tempdir().unwrap();
        let e = write_atomic(&tmp.path().join("nope").join("m.json"), b"x").unwrap_err();
        assert_eq!(e.source.kind(), io::ErrorKind::NotFound);
        assert_eq!(e.retries, 0, "确定性失败不该报出重试轮数");
    }

    /* ---------------- 重试本身的正向覆盖 ----------------
     *
     * 评审两路都指出:此前那几条守卫全在成功路径上,把整个重试循环删掉照样绿。
     * 重试是这波修复的核心,必须直接考「失败两次、第三次成功」这条路。
     */

    #[test]
    fn retry_succeeds_after_transient_contention_and_counts_the_retries() {
        let mut left = 2;
        let n = retry_contended(|| {
            if left > 0 {
                left -= 1;
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert_eq!(n, 2, "重试轮数要如实回报(告警的 ×N 全靠它)");
    }

    #[test]
    fn retry_gives_up_after_the_backoff_table_and_returns_the_real_error() {
        let mut calls = 0usize;
        let e = retry_contended(|| {
            calls += 1;
            Err::<(), _>(io::Error::from(io::ErrorKind::PermissionDenied))
        })
        .unwrap_err();
        assert_eq!(
            e.source.kind(),
            io::ErrorKind::PermissionDenied,
            "必须原样上抛真实错误"
        );
        assert_eq!(
            e.retries,
            WRITE_RETRY_BACKOFF_MS.len() as u32,
            "失败时也要带上已重试的轮数——那是「已经替用户排除了『没有写权限』」的硬证据"
        );
        assert!(
            e.note().contains("已自动重试"),
            "报文要说得出这句: {}",
            e.note()
        );
        assert_eq!(
            calls,
            WRITE_RETRY_BACKOFF_MS.len() + 1,
            "首次 + 每一档退避各一次,不能无限重试"
        );
    }

    /// 零覆盖保障不许被重试机制绕过:`AlreadyExists` = 目标已经被别人写了,
    /// 重试只会不停撞同一堵墙,而这堵墙本身就是保障。素材落位走的就是这条路。
    #[test]
    fn already_exists_is_never_treated_as_contention() {
        assert!(!is_contention(&io::Error::from(
            io::ErrorKind::AlreadyExists
        )));
        let mut calls = 0usize;
        let e = retry_contended(|| {
            calls += 1;
            Err::<(), _>(io::Error::from(io::ErrorKind::AlreadyExists))
        })
        .unwrap_err();
        assert_eq!(calls, 1, "目标已存在时一次都不许重试");
        assert_eq!(e.source.kind(), io::ErrorKind::AlreadyExists);
    }

    #[test]
    fn retry_does_not_touch_deterministic_failures() {
        // 盘满/路径不存在这类重试一万次也一样,必须立刻返回——把它们也重试
        // 会让确定性错误在界面上凭空卡住一秒多
        let mut calls = 0usize;
        let e = retry_contended(|| {
            calls += 1;
            Err::<(), _>(io::Error::from(io::ErrorKind::NotFound))
        })
        .unwrap_err();
        assert_eq!(calls, 1, "非占用类错误一次都不许重试");
        assert_eq!(e.source.kind(), io::ErrorKind::NotFound);
        assert_eq!(e.retries, 0);
        assert_eq!(e.note(), "", "没重试过就不许在报文里声称重试过");
    }

    /// `write_atomic` 自己有没有走重试。前两次 rename 报占用,第三次交给真的
    /// `fs::rename`——文件必须换成新内容、重试轮数如实回报、临时文件清干净。
    ///
    /// (POSIX 上造不出「目录可写但 rename 被占用」的真实场景:创建临时文件和
    /// rename 需要的是同一个目录写权限。所以这里注入 rename,而不是硬造锁。)
    #[test]
    fn write_atomic_itself_retries_the_rename_not_just_the_helper() {
        let tmp = tempdir().unwrap();
        let target = tmp.path().join("m.json");
        fs::write(&target, b"old").unwrap();

        let mut left = 2;
        let report = write_atomic_with(&target, b"new", |from, to| {
            if left > 0 {
                left -= 1;
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            } else {
                fs::rename(from, to)
            }
        })
        .expect("占用退去后必须自己熬过去");

        assert_eq!(
            report.retries, 2,
            "这次明明重试过两轮,却报了 {}",
            report.retries
        );
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert!(
            strays(tmp.path(), "m.json").is_empty(),
            "重试成功后不许留临时文件"
        );
    }

    /// 一直占用:错误原样上抛,旧内容不动,临时文件不许留下。
    #[test]
    fn write_atomic_gives_up_cleanly_when_contention_never_lifts() {
        let tmp = tempdir().unwrap();
        let target = tmp.path().join("m.json");
        fs::write(&target, b"old").unwrap();

        let e = write_atomic_with(&target, b"new", |_, _| {
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        })
        .unwrap_err();

        assert_eq!(e.source.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read(&target).unwrap(), b"old", "失败不许动到旧内容");
        assert!(
            strays(tmp.path(), "m.json").is_empty(),
            "失败后有残留临时文件(唯一名 = 无界累积)"
        );
    }

    /// 熬不过去时:错误上抛,旧内容不动,且临时文件不许留在盘上
    /// (唯一名 = 残留可以无界累积,每个都是一份完整清单)。
    #[test]
    #[cfg(unix)]
    fn write_atomic_cleans_up_its_temp_file_when_it_finally_gives_up() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("跳过:root 无视目录权限位,造不出这个场景");
            return;
        }
        let tmp = tempdir().unwrap();
        let dir = tmp.path().join("m");
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("m.json");
        fs::write(&target, b"old").unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o500)).unwrap();
        let e = write_atomic(&target, b"new").unwrap_err();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();

        assert_eq!(e.source.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read(&target).unwrap(), b"old", "失败不许动到旧内容");
        assert!(strays(&dir, "m.json").is_empty(), "失败后有残留临时文件");
    }
}
