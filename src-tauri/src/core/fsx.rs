//! 平台原生文件系统增强(M2 技术债批):
//! - [`rename_no_replace`]:原子防覆盖改名(macOS `renamex_np(RENAME_EXCL)`、
//!   Linux `renameat2(RENAME_NOREPLACE)`、Windows `MoveFileExW` 无替换旗标——
//!   三者在目标已存在时都原子失败),文件系统不支持时回退 hard_link 再回退复查+rename;
//! - [`read_file_uncached`]:绕页缓存回读(macOS `F_NOCACHE`、Linux `posix_fadvise(DONTNEED)`;
//!   Windows 的 `FILE_FLAG_NO_BUFFERING` 需扇区对齐读,复杂度高,**如实记录为未覆盖边界**,
//!   该平台回退普通读)。

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

thread_local! {
    /// 「最后回退(发布锁 + 复查 + rename)被真实使用」标记。**线程局部**:拷卡 worker、
    /// 分类 / 交付命令、转码作业各在自己的线程上做改名、也在同一线程的收尾取走标记——
    /// 进程级的一个标记会被并发的别的任务先取走、归错任务(codex 终审)。
    /// 用了线程池的调用方(分析)要在池线程上取,再汇总到作业。
    static UNSAFE_FALLBACK_USED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// 没删掉的临时文件(落位后的临时名 / 探针 / 发布锁 / 原子写的临时文件)的**路径**:
    /// 目标已经发布,这不是失败,但留下的文件是可见的降级,上层要点名说——只有拷卡目录和
    /// 清单目录里的有清扫认得,其它目录里的要人按路径手删。
    static LEFTOVER_SOURCES: std::cell::RefCell<Vec<PathBuf>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// 取走**本线程**的「最后回退被使用」标记(取走即清零)。
pub fn take_unsafe_fallback_flag() -> bool {
    UNSAFE_FALLBACK_USED.with(|c| c.replace(false))
}

fn mark_unsafe_fallback() {
    UNSAFE_FALLBACK_USED.with(|c| c.set(true));
}

/// 取走并清零**本线程**的「临时文件没删掉」计数(给上层告警用):落位后的临时名、探针、
/// 发布锁、原子写的临时文件——删不掉的都算,日志不是出口。
pub fn take_leftover_sources() -> Vec<PathBuf> {
    LEFTOVER_SOURCES.with(|c| std::mem::take(&mut *c.borrow_mut()))
}

/// 记一个本线程「临时文件没删掉」的路径(fsx 内外都用;租约的时钟探针也走这里)。
pub fn note_leftover_temp(path: &Path) {
    LEFTOVER_SOURCES.with(|c| c.borrow_mut().push(path.to_path_buf()));
}

thread_local! {
    /// 系统替用户重试并**成功**的写入次数(占用重试):成功了也要说——它是「这台机器上有
    /// 东西在抢文件」的信号,收尾聚合成一条 info。线程局部,同上。
    static RETRIED_WRITES: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// 记本线程一次「重试后成功」的写入(带重试轮数)。
pub fn note_retried_writes(retries: u64) {
    if retries > 0 {
        RETRIED_WRITES.with(|c| c.set(c.get() + retries));
    }
}

/// 取走并清零本线程的「重试后成功」轮数。
pub fn take_retried_writes() -> u64 {
    RETRIED_WRITES.with(|c| c.replace(0))
}

/// 原语级(renamex_np / renameat2 / MoveFileExW)的「不支持」:只有这种才允许退到硬链接。
/// 占用(5/32/33)、权限、瞬断一律**不**回退:回退到「复查+rename」是可覆盖的竞态,
/// 一次瞬时的 AccessDenied 就把安全关键路径推进去,而调用方的占用重试本来会处理它
/// (codex 终审 P0)。EPERM **不**在原语级名单里:粘滞位 / chattr +i 这类权限问题不该
/// 被当成「不支持」而走进回退梯子(fable 终审)。
fn native_unsupported(e: &io::Error) -> bool {
    if e.kind() == io::ErrorKind::Unsupported {
        return true;
    }
    #[cfg(unix)]
    {
        // 用值比较而不是模式:Linux 上 ENOTSUP == EOPNOTSUPP,写成模式会是「不可达分支」
        let code = e.raw_os_error();
        [libc::EINVAL, libc::ENOSYS, libc::ENOTSUP, libc::EOPNOTSUPP]
            .iter()
            .any(|c| Some(*c) == code)
    }
    #[cfg(windows)]
    {
        // ERROR_INVALID_FUNCTION(1) / ERROR_NOT_SUPPORTED(50) / ERROR_INVALID_PARAMETER(87)
        // / ERROR_CALL_NOT_IMPLEMENTED(120):SMB / exFAT 上 no-replace 原语的典型回答
        matches!(e.raw_os_error(), Some(1) | Some(50) | Some(87) | Some(120))
    }
}

/// 硬链接级的「不支持」:原语级那些,外加 EPERM——Linux VFS 对没有 link 操作的文件系统
/// (FAT/exFAT)固定答 EPERM(macOS 本机 exFAT 答的是 ENOTSUP,已在原语级名单里)。
fn link_unsupported(e: &io::Error) -> bool {
    if native_unsupported(e) {
        return true;
    }
    #[cfg(unix)]
    {
        e.raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// 这个目录能不能建硬链接——按**文件系统**缓存的探针。别靠 errno 猜:Samba 导出的
/// FAT/exFAT 后端(NAS 上插的 USB 盘、路由器 USB 共享)对 link() 答 EPERM,Samba 再把它
/// 映成 ACCESS_DENIED,macOS 客户端拿到的是 EACCES——按「占用 / 权限原样上抛」处理的话,
/// 每个文件的落位都会响亮地失败(fable 终审)。探针:建一个唯一临时文件、对它做一次
/// 硬链接、删掉两者。分类(fable 第四轮抓到此前把 EACCES 也归成「支持」,探针成了空操作):
/// - `Ok` → 支持;
/// - 探针文件刚建好就不见了(NotFound / Interrupted:并发清扫 / 抖动)→ **不下结论、不缓存**;
/// - 其余一律「不支持」:我们刚在这个目录 `create_new` 成功,对自己刚建的文件做同目录硬链接
///   还拿到权限错误,不是瞬时的。误判「无」的代价是复查+rename + 可见 UNSAFE 告警(可见降级),
///   误判「有」的代价是这个目标上任务不可用。
fn dir_supports_hard_links(dir: &Path) -> bool {
    type Cache = std::collections::HashMap<(std::path::PathBuf, u64), bool>;
    static CACHE: std::sync::OnceLock<std::sync::Mutex<Cache>> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    // 能力是按文件系统的,不是按路径:同一挂载点先后插不同的盘(DIT 常给所有 shuttle 盘
    // 起同名)时按路径缓存会答错——键带上设备号(Windows 上用卷根)
    let key = fs_key(dir);
    if let Some(v) = cache
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&key)
        .copied()
    {
        return v;
    }
    match dir_supports_hard_links_with(dir, |a, b| fs::hard_link(a, b)) {
        Some(v) => {
            cache
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(key, v);
            v
        }
        // 不下结论:按「支持」走一次(真正的错误会在正常路径上响亮地报出来),下次再探
        None => true,
    }
}

/// 缓存键:按**文件系统**——unix 用 `st_dev`(取得到就不再带目录路径,同一卷只探一次);
/// 取不到设备号退回目录路径。Windows 没有稳定的设备号,退回卷根前缀(同一盘符先后映射到
/// 不同后端时会陈旧,后果是响亮的逐文件失败而不是静默;补齐要读卷序列号,留待下一版)。
fn fs_key(dir: &Path) -> (std::path::PathBuf, u64) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match fs::metadata(dir).map(|m| m.dev()) {
            Ok(dev) if dev != 0 => (std::path::PathBuf::new(), dev),
            _ => (dir.to_path_buf(), 0),
        }
    }
    #[cfg(not(unix))]
    {
        let root = dir
            .components()
            .next()
            .map(|c| std::path::PathBuf::from(c.as_os_str()))
            .unwrap_or_else(|| dir.to_path_buf());
        (root, 0)
    }
}

/// [`dir_supports_hard_links`] 的本体,`link` 可注入:`Some(true)` 支持、`Some(false)` 不支持、
/// `None` 不下结论(探针文件都没建成 / 刚建好就不见了)。
fn dir_supports_hard_links_with(
    dir: &Path,
    link: impl Fn(&Path, &Path) -> io::Result<()>,
) -> Option<bool> {
    let tag = &uuid::Uuid::new_v4().simple().to_string()[..8];
    let a = dir.join(format!(".hlprobe.{tag}{TMP_SUFFIX}"));
    let b = dir.join(format!(".hlprobe.{tag}.l{TMP_SUFFIX}"));
    let f = match fs::OpenOptions::new().write(true).create_new(true).open(&a) {
        Ok(f) => f,
        // 探针文件都建不了(目录没权限 / 不存在 / 盘满):不下结论
        Err(_) => return None,
    };
    drop(f);
    let r = link(&a, &b);
    for p in [&b, &a] {
        // 删也走占用重试(杀软刚打开探针文件);交付目录里的探针残留没有清扫认得
        // (.ocardtmp 清扫只扫清单目录),删不掉至少要说
        if let Err(f) = retry_contended(|| match fs::remove_file(p) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            r => r,
        }) {
            log::warn!("硬链接探针文件没删掉 {}: {}", p.display(), f.source);
            note_leftover_temp(p);
        }
    }
    match r {
        Ok(()) => Some(true),
        // 「不支持」(errno 名单)与「拒绝访问」(Samba 把后端的 EPERM 映成 ACCESS_DENIED)
        // 才算不支持;EIO / ETIMEDOUT / ENOTCONN 这类抖动**不下结论、不缓存**——否则一次
        // 抖动就把一个本来支持硬链接的目标钉成永久降级(fable 第五轮)
        Err(e) if link_unsupported(&e) || e.kind() == io::ErrorKind::PermissionDenied => {
            Some(false)
        }
        Err(_) => None,
    }
}

/// 原子防覆盖改名:目标已存在时失败(`AlreadyExists`),绝不替换。
///
/// 契约:返回 `Ok` 当且仅当目标已发布;返回 `Err(AlreadyExists)` 当且仅当目标本来就在;
/// 其余 `Err` 表示目标**没有**发布、可按原因重试。hard_link 成功之后源删不掉不算失败
/// (目标已经在了),只记一笔留给上层告警——否则调用方重试一次撞上 AlreadyExists,会把
/// 自己刚发布的文件误报成「别的任务写的」。
pub fn rename_no_replace(src: &Path, dst: &Path) -> io::Result<()> {
    rename_no_replace_with(
        src,
        dst,
        platform_rename_no_replace,
        |s, d| fs::hard_link(s, d),
        dir_supports_hard_links,
    )
}

/// [`rename_no_replace`] 的本体,两级原语可注入——好直接考「瞬时 AccessDenied 不许回退」。
fn rename_no_replace_with(
    src: &Path,
    dst: &Path,
    native: impl Fn(&Path, &Path) -> io::Result<()>,
    link: impl Fn(&Path, &Path) -> io::Result<()>,
    dir_has_hard_links: impl Fn(&Path) -> bool,
) -> io::Result<()> {
    match native(src, dst) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(e),
        Err(e) if !native_unsupported(&e) => Err(e),
        // 目标目录根本不支持硬链接(探针说的,不是猜的):直接走发布锁 + 复查 + rename 并置可见标记
        Err(_) if !dir_has_hard_links(dst.parent().unwrap_or(Path::new("."))) => {
            mark_unsafe_fallback();
            checked_rename_under_publish_lock(src, dst)
        }
        // 平台原语不可用(旧内核/异构文件系统):hard_link 仍是原子防覆盖
        Err(_) => match link(src, dst) {
            Ok(()) => {
                match fs::remove_file(src) {
                    Ok(()) => {}
                    Err(ce) if ce.kind() == io::ErrorKind::NotFound => {}
                    Err(ce) => {
                        log::warn!(
                            "落位成功但临时名没删掉 {}: {ce}(目标已发布;临时文件留给清扫)",
                            src.display()
                        );
                        note_leftover_temp(src);
                    }
                }
                Ok(())
            }
            Err(le) if le.kind() == io::ErrorKind::AlreadyExists => {
                Err(io::Error::new(io::ErrorKind::AlreadyExists, le))
            }
            Err(le) if !link_unsupported(&le) => Err(le),
            Err(_) => {
                // 最后回退:发布锁 + 复查 + rename——置标记让上层告警
                mark_unsafe_fallback();
                checked_rename_under_publish_lock(src, dst)
            }
        },
    }
}

/// 最后一级回退的「复查 + rename」本身有 TOCTOU:两个任务(同日期同机位的两张卡,目标夹
/// 与文件名都相同)都看到目标不在、后一个普通 rename 会替换前一个,而两边的 part 都已各自
/// 校验通过——两份清单都报成功,盘上却只剩一份(codex 终审 P0)。所以在目标路径上先用
/// `create_new` 建一个**发布锁**(O_EXCL 在 FAT / SMB2+ 上都是原子的),锁内再复查 + rename;
/// 别的发布者撞上锁 = 按占用重试,重试完还在 = 可见失败并点名锁文件让人核对。
/// 崩溃残留的锁**不在这里回收**(年龄回收有 ABA),由开拷前的清扫按 30 分钟收。
fn checked_rename_under_publish_lock(src: &Path, dst: &Path) -> io::Result<()> {
    let lock = publish_lock_path(dst);
    // 锁在就是在:**不在热路径上回收**。按年龄回收有 ABA(两个回收者 / 时钟快的机器偷走
    // 新鲜锁 / 原持有者的 rename 卡住两分钟后迟到完成),任何一种都能让两份清单都报成功而
    // 盘上只剩一份(codex 终审)。撞锁按占用重试几轮,仍在就可见失败并点名锁文件;崩溃残留
    // 由开拷前的清扫按 30 分钟(NAS 时钟)收走——卡住半小时的 rename 不是现实场景
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock)
    {
        Ok(f) => drop(f),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            return Err(publish_lock_busy(e, &lock))
        }
        Err(e) => return Err(e),
    }
    let r = if dst.exists() {
        Err(io::Error::from(io::ErrorKind::AlreadyExists))
    } else {
        fs::rename(src, dst)
    };
    if let Err(f) = retry_contended(|| match fs::remove_file(&lock) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        r => r,
    }) {
        // 交付目录里的锁残留没有启动清扫认得(只扫清单目录),开拷前的 part 清扫会顺手收;
        // 删不掉至少要说
        log::warn!("发布锁没删掉 {}: {}", lock.display(), f.source);
        note_leftover_temp(&lock);
    }
    r
}

/// 发布锁的落点:与目标同目录,`.<目标名>.publish<TMP_SUFFIX>`。
fn publish_lock_path(dst: &Path) -> std::path::PathBuf {
    let name = dst
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    dst.with_file_name(format!(".{name}.publish{TMP_SUFFIX}"))
}

/// 「另一个发布者持着发布锁」的报文标记:调用方据此把它从「权限 / 杀软」里分出来。
pub const PUBLISH_LOCK_HELD: &str = "目标路径正被另一个发布者持有发布锁";

/// 别的发布者正持着这个目标路径的发布锁:按「占用」上抛(PermissionDenied 在 is_contention
/// 名单里),调用方的占用重试会再来几轮;重试完还在就是 AlreadyExists 级别的冲突。
fn publish_lock_busy(e: io::Error, lock: &Path) -> io::Error {
    // 点名锁文件 + 补救写在这里:分类 / 转码 / 交付把这段原文带进逐项失败,一处修全部
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        format!(
            "{PUBLISH_LOCK_HELD} {}(或是崩溃残留;发布锁不自动回收,开拷前的清扫只收超过 30 分钟的)。确认没有别的 OCard 在往这里写之后可手动删除该锁文件再重试:{e}",
            lock.display()
        ),
    )
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

// 绕缓存请求被内核拒绝的次数(R4 终审 P1:此前返回值被忽略,「介质回读」
// 保证会无提示退化成普通缓存读;计数由命令层聚合为可见提示)。
thread_local! {
    /// 线程局部(与其它降级计数同理:并行任务不许互相领走)。
    static UNCACHED_FALLBACKS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// 取走**本线程**的绕缓存退化计数(取走即清零)。
pub fn take_uncached_fallbacks() -> u64 {
    UNCACHED_FALLBACKS.with(|c| c.replace(0))
}

fn note_uncached_fallback() {
    UNCACHED_FALLBACKS.with(|c| c.set(c.get() + 1));
}

/// 打开**源**文件供拷贝 / 哈希读取。Windows 上以「只允许别人读」的共享模式打开
/// (`FILE_SHARE_READ`):正持着写句柄的程序会让这次打开报共享冲突——按占用重试几轮
/// (杀软 / 索引器的短暂写句柄),仍被占着就可见失败并说明原因与下一步;而我们持着句柄
/// 期间任何人都打不开写句柄——这是 Windows 上唯一可靠的「拷贝期间没人在写」证明:Windows
/// 只保证写句柄**关闭后**修改时间才正确,写入过程中按元数据看不出(codex 终审 r17)。
/// 其它平台没有强制共享模式,靠大小 + 修改时间的前后核对。
pub fn open_source(path: &Path) -> io::Result<fs::File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x0000_0001;
        let mut got: Option<fs::File> = None;
        match retry_contended(|| {
            got = Some(
                fs::OpenOptions::new()
                    .read(true)
                    .share_mode(FILE_SHARE_READ)
                    .open(path)?,
            );
            Ok(())
        }) {
            Ok(_) => Ok(got.expect("重试成功必有句柄")),
            Err(f) => Err(if matches!(f.source.raw_os_error(), Some(32) | Some(33)) {
                // 报文带原因与下一步(可见 ≠ 可用):裸的 os error 32 没人看得懂
                io::Error::new(
                    f.source.kind(),
                    format!(
                        "源文件正被别的程序打开写入(共享冲突,已重试 {} 轮仍被占着): {}。请确认没有设备 / 程序在写这张卡,再点「重试全部失败文件」",
                        f.retries, f.source
                    ),
                )
            } else {
                f.source
            }),
        }
    }
    #[cfg(not(windows))]
    {
        fs::File::open(path)
    }
}

/// 打开文件并尽量绕过页缓存(校验用:让回读尽量来自介质而非内存)。
/// Windows 回退普通打开(如实标注的边界,见模块文档)。
pub fn open_uncached(path: &Path) -> io::Result<fs::File> {
    let file = fs::File::open(path)?;
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        let rc = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_NOCACHE, 1) };
        if rc != 0 {
            note_uncached_fallback();
        }
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let rc = unsafe { libc::posix_fadvise(file.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };
        if rc != 0 {
            note_uncached_fallback();
        }
    }
    #[cfg(windows)]
    {
        // Windows 无扇区对齐读实现,固定按退化计数(声明边界的可见化)
        note_uncached_fallback();
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

    /// 降级标记如今是线程局部的;历史上是进程级的,考它的用例仍串行(无害),否则并行跑时一个
    /// 用例刚置位、另一个就把它取走(Windows CI 上真的撞过)
    fn flag_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 原语报的是**占用 / 权限**(不是「不支持」):不许回退到硬链接或复查+rename——
    /// 那条尾路是可覆盖的竞态,一次瞬时的 AccessDenied 不该把安全关键路径推进去。
    #[test]
    fn a_transient_access_denied_never_falls_back_to_the_overwriting_path() {
        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("a.tmp");
        let dst = t.path().join("a");
        std::fs::write(&src, b"x").unwrap();
        let _serial = flag_lock();
        let _ = take_unsafe_fallback_flag();
        let linked = std::cell::Cell::new(false);
        let r = rename_no_replace_with(
            &src,
            &dst,
            |_, _| Err(io::Error::from(io::ErrorKind::PermissionDenied)),
            |_, _| {
                linked.set(true);
                Ok(())
            },
            |_| true,
        );
        assert!(
            matches!(&r, Err(e) if e.kind() == io::ErrorKind::PermissionDenied),
            "占用 / 权限要原样上抛: {r:?}"
        );
        assert!(!linked.get(), "不许回退到硬链接");
        assert!(!dst.exists() && src.exists(), "什么都不许动");
        assert!(!take_unsafe_fallback_flag(), "更不许走到复查+rename");
    }

    /// 原语「不支持」→ 硬链接;硬链接也「不支持」→ 复查+rename(置可见标记);
    /// 硬链接说目标已在 → AlreadyExists。
    #[test]
    fn only_unsupported_errors_walk_down_the_fallback_ladder() {
        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("b.tmp");
        let dst = t.path().join("b");
        std::fs::write(&src, b"x").unwrap();
        let _serial = flag_lock();
        let _ = take_unsafe_fallback_flag();
        let unsupported = || io::Error::from(io::ErrorKind::Unsupported);
        rename_no_replace_with(
            &src,
            &dst,
            |_, _| Err(unsupported()),
            |_, _| Err(unsupported()),
            |_| true,
        )
        .unwrap();
        assert!(
            dst.exists() && !src.exists(),
            "最后一级要真的把文件发布出去"
        );
        assert!(
            take_unsafe_fallback_flag(),
            "走到复查+rename 必须置可见标记"
        );

        std::fs::write(&src, b"y").unwrap();
        let r = rename_no_replace_with(
            &src,
            &dst,
            |_, _| Err(unsupported()),
            |_, _| Err(io::Error::from(io::ErrorKind::AlreadyExists)),
            |_| true,
        );
        assert!(
            matches!(&r, Err(e) if e.kind() == io::ErrorKind::AlreadyExists),
            "{r:?}"
        );
        assert_eq!(
            std::fs::read(&dst).unwrap(),
            b"x",
            "已存在的目标一个字节都不许动"
        );
    }

    /// Windows:别的程序持着写句柄时,源文件打不开(共享冲突 = 可见失败),持着我们的句柄
    /// 时别人也拿不到写句柄——拷贝期间没人在写的证明。
    #[cfg(windows)]
    #[test]
    fn a_source_held_open_for_writing_cannot_be_opened_for_copying_on_windows() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("A.MP4");
        std::fs::write(&p, b"x").unwrap();
        // 写者(默认共享模式:允许读写删)
        let writer = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
        let r = open_source(&p);
        assert!(
            matches!(&r, Err(e) if e.raw_os_error() == Some(32)),
            "有写句柄时源必须打不开: {r:?}"
        );
        drop(writer);
        let reader = open_source(&p).unwrap();
        // 我们持着句柄期间,写句柄拿不到
        let w2 = std::fs::OpenOptions::new().write(true).open(&p);
        assert!(
            matches!(&w2, Err(e) if e.raw_os_error() == Some(32)),
            "我们读着时别人不许开写句柄: {w2:?}"
        );
        drop(reader);
    }

    /// 降级标记是线程局部的:别的线程(别的任务)的回退不会被本线程取走、归错任务。
    #[test]
    fn the_fallback_flag_is_per_thread() {
        let _serial = flag_lock();
        let _ = take_unsafe_fallback_flag();
        std::thread::spawn(|| {
            mark_unsafe_fallback();
            assert!(take_unsafe_fallback_flag(), "自己线程上置的标记自己取得到");
        })
        .join()
        .unwrap();
        assert!(!take_unsafe_fallback_flag(), "别的线程的标记不许漏到本线程");
    }

    /// 最后一级回退在目标路径上先拿发布锁:别的发布者持着锁时不许复查+rename(那正是
    /// 两个任务互相覆盖的窗口),按占用上抛;锁陈旧(崩溃残留)也照样按占用上抛(不在热路径
    /// 回收),锁没了才发布、发布完自己的锁清掉。
    #[test]
    fn the_checked_rename_fallback_respects_a_publish_lock_on_the_final_path() {
        let _serial = flag_lock();
        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("e.tmp");
        let dst = t.path().join("e");
        std::fs::write(&src, b"x").unwrap();
        let unsupported = || io::Error::from(io::ErrorKind::Unsupported);
        let lock = publish_lock_path(&dst);
        std::fs::write(&lock, b"").unwrap(); // 别的发布者刚拿到锁(新鲜)
        let r = rename_no_replace_with(
            &src,
            &dst,
            |_, _| Err(unsupported()),
            |_, _| Err(unsupported()),
            |_| false,
        );
        assert!(
            matches!(&r, Err(e) if e.kind() == io::ErrorKind::PermissionDenied),
            "锁被占着要按占用上抛,不许绕过去改名: {r:?}"
        );
        assert!(!dst.exists() && src.exists(), "锁被占时什么都不许动");
        assert!(lock.exists(), "别人的锁不许删");
        // 陈旧的锁(崩溃残留)也**不在这里回收**(年龄回收有 ABA):照样按占用上抛
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        std::fs::File::options()
            .write(true)
            .open(&lock)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(old))
            .unwrap();
        let r = rename_no_replace_with(
            &src,
            &dst,
            |_, _| Err(unsupported()),
            |_, _| Err(unsupported()),
            |_| false,
        );
        assert!(
            matches!(&r, Err(e) if e.kind() == io::ErrorKind::PermissionDenied),
            "陈旧锁也不在热路径回收: {r:?}"
        );
        assert!(lock.exists() && !dst.exists());
        // 锁没了才发布,发布完自己的锁要清掉
        std::fs::remove_file(&lock).unwrap();
        rename_no_replace_with(
            &src,
            &dst,
            |_, _| Err(unsupported()),
            |_, _| Err(unsupported()),
            |_| false,
        )
        .unwrap();
        assert!(dst.exists() && !src.exists());
        assert!(!lock.exists(), "发布完发布锁要清掉");
        let _ = take_unsafe_fallback_flag();
    }

    /// 探针的分类是整件事的关键:自己刚建的文件、同目录硬链接还拿到 EACCES,就是「不支持」;
    /// 此前把 EACCES 归成「支持」,探针对它要解决的那个场景是空操作(fable 第四轮)。
    #[test]
    fn the_hard_link_probe_treats_access_denied_as_unsupported() {
        let t = tempfile::tempdir().unwrap();
        let denied = dir_supports_hard_links_with(t.path(), |_, _| {
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        });
        assert_eq!(
            denied,
            Some(false),
            "探针文件自己刚建成,link 再拒绝访问 = 不支持"
        );
        let ok = dir_supports_hard_links_with(t.path(), |a, b| fs::hard_link(a, b));
        assert_eq!(ok, Some(true), "本机盘要能建硬链接");
        let vanished = dir_supports_hard_links_with(t.path(), |_, _| {
            Err(io::Error::from(io::ErrorKind::NotFound))
        });
        assert_eq!(vanished, None, "探针文件刚建好就不见了:不下结论");
        let flaky = dir_supports_hard_links_with(t.path(), |_, _| {
            Err(io::Error::from(io::ErrorKind::TimedOut))
        });
        assert_eq!(flaky, None, "NAS 抖动(超时)不下结论,更不许缓存成「不支持」");
        let nowhere =
            dir_supports_hard_links_with(&t.path().join("nope"), |a, b| fs::hard_link(a, b));
        assert_eq!(nowhere, None, "探针文件都建不成:不下结论");
        assert_eq!(
            std::fs::read_dir(t.path()).unwrap().count(),
            0,
            "探针不许留下文件"
        );
    }

    /// 目标目录探针说「没有硬链接」(Samba 导出的 FAT/exFAT):原语不支持之后**不去**
    /// 试 link(那里会拿到 EACCES,被当成瞬时错误响亮地失败),直接复查+rename 并置标记。
    #[test]
    fn a_directory_without_hard_links_goes_straight_to_the_checked_rename() {
        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("c.tmp");
        let dst = t.path().join("c");
        std::fs::write(&src, b"x").unwrap();
        let _serial = flag_lock();
        let _ = take_unsafe_fallback_flag();
        let linked = std::cell::Cell::new(false);
        rename_no_replace_with(
            &src,
            &dst,
            |_, _| Err(io::Error::from(io::ErrorKind::Unsupported)),
            |_, _| {
                linked.set(true);
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            },
            |_| false,
        )
        .expect("没有硬链接的目录要能落位");
        assert!(!linked.get(), "探针已说没有硬链接,不该再去试 link");
        assert!(dst.exists() && !src.exists());
        assert!(
            take_unsafe_fallback_flag(),
            "走了复查+rename 必须置可见标记"
        );
    }

    /// 探针说「有硬链接」时,link 的 EACCES 就是瞬时的:原样上抛,不许走复查+rename。
    #[test]
    fn a_link_access_denied_on_a_hard_link_capable_directory_is_propagated() {
        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("d.tmp");
        let dst = t.path().join("d");
        std::fs::write(&src, b"x").unwrap();
        let _serial = flag_lock();
        let _ = take_unsafe_fallback_flag();
        let r = rename_no_replace_with(
            &src,
            &dst,
            |_, _| Err(io::Error::from(io::ErrorKind::Unsupported)),
            |_, _| Err(io::Error::from(io::ErrorKind::PermissionDenied)),
            |_| true,
        );
        assert!(
            matches!(&r, Err(e) if e.kind() == io::ErrorKind::PermissionDenied),
            "{r:?}"
        );
        assert!(!dst.exists() && src.exists());
        assert!(!take_unsafe_fallback_flag());
    }

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

    /// 契约:每一次**实际改名尝试**之前都要再问守门人。第一次改名撞上占用进入重试、
    /// 第二次问时锁已经没了 → 不许发布,并且把已经为占用重试过的那一轮报出来。
    /// 把实现退化成「入口问一次、之后不再问」,这条必红。
    #[test]
    fn a_guard_that_says_no_on_the_retry_still_blocks_publish_and_keeps_the_retry_count() {
        let t = tempfile::tempdir().unwrap();
        let target = t.path().join("m.json");
        // 守门人看事实:第一次问时锁还在,之后没了
        let lock = t.path().join("lock");
        std::fs::write(&lock, b"").unwrap();
        let asked = std::cell::Cell::new(0u32);
        let guard = || {
            asked.set(asked.get() + 1);
            let ok = lock.exists();
            let _ = std::fs::remove_file(&lock); // 第一次问完锁就没了
            ok
        };
        let mut renames = 0u32;
        let r = write_atomic_guarded_with(&target, b"{}", &guard, |from, to| {
            renames += 1;
            if renames == 1 {
                // 第一次:目标被占(杀软扫描),走占用重试
                return Err(io::Error::from(io::ErrorKind::PermissionDenied));
            }
            fs::rename(from, to)
        });
        assert!(
            matches!(r, Err(GuardedWrite::Refused { retries: 1 })),
            "第二次问守门人已说不,且要报出此前那一轮占用重试: {r:?}"
        );
        assert_eq!(asked.get(), 2, "每次实际改名之前都要问一次");
        assert_eq!(renames, 1, "守门人说不之后不许再试改名");
        assert!(!target.exists(), "说不之后仍发布了");
        assert_eq!(
            std::fs::read_dir(t.path()).unwrap().count(),
            0,
            "临时文件没清掉"
        );
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

// 拷贝后时间戳保留失败计数(零静默:命令层取走后聚合告警)。
thread_local! {
    /// 时间戳保留失败计数,**线程局部**(与降级标记同理:并行拷卡时不许被先收尾的任务领走)。
    static TIMES_PRESERVE_FAILURES: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// 取走时间戳保留失败数(swap 清零)。
pub fn take_times_preserve_failures() -> u64 {
    TIMES_PRESERVE_FAILURES.with(|c| c.replace(0))
}

/// 外部记入 N 次保留失败(如:源元数据在读取前就拿不到,时间戳注定无法保留)。
pub fn note_times_preserve_failures(n: u64) {
    TIMES_PRESERVE_FAILURES.with(|c| c.set(c.get() + n));
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
        note_times_preserve_failures(1);
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
    write_atomic_guarded_with(path, bytes, before_publish, |from, to| fs::rename(from, to))
}

/// [`write_atomic_guarded`] 的本体,`rename` 可注入——好直接考「第一次改名撞上占用
/// 重试、第二次问守门人时它已经说不」这条契约。
fn write_atomic_guarded_with(
    path: &Path,
    bytes: &[u8],
    before_publish: &dyn Fn() -> bool,
    mut rename: impl FnMut(&Path, &Path) -> io::Result<()>,
) -> Result<WriteReport, GuardedWrite> {
    let refused = std::cell::Cell::new(false);
    let attempts = std::cell::Cell::new(0u32);
    let r = write_atomic_with(path, bytes, |from, to| {
        attempts.set(attempts.get() + 1);
        if !before_publish() {
            refused.set(true);
            return Err(io::Error::other("write fence refused"));
        }
        rename(from, to)
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
        Err(e) => {
            log::warn!("原子写的临时文件清不掉,已留在盘上: {} — {e}", tmp.display());
            note_leftover_temp(tmp);
        }
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
