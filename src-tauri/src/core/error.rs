use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    /// 同样是 IO 类失败(可续传口径,见 [`CoreError::is_io`]),但带上
    /// 「哪一步、哪个文件、该做什么」。
    ///
    /// 存在的理由是一次真实事故:Windows 上拷卡跑到一半整任务中断,用户看到的
    /// 全部信息就是「IO 错误: 拒绝访问。 (os error 5)」——不知道是卡还是 NAS、
    /// 不知道是哪个文件、不知道下一步做什么。可见 ≠ 可用,零静默的下半句是人话。
    #[error("{0}")]
    IoDetail(String),
    #[error("JSON 错误: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Invalid(String),
    #[error("目标已存在: {0}")]
    AlreadyExists(String),
}

impl CoreError {
    /// 这次失败是不是「IO 类」。IO 类中断按**可续传的暂停**处理(NAS 抖一下、
    /// 杀毒软件占一下,素材没丢,接着拷就是);其余按失败终结。
    /// 判定必须走这里:`matches!(e, Io(_))` 会把 [`Self::IoDetail`] 漏成死路。
    pub fn is_io(&self) -> bool {
        matches!(self, Self::Io(_) | Self::IoDetail(_))
    }

    /// 同 [`Self::io_detail`],外加「已经自动重试了几轮」。
    ///
    /// 重试满还失败,基本就排除了「没有写权限」那一支——那种情况第一次就会失败,
    /// 也不会因为等一会儿好转。这句话是系统花了一秒半买来的,不说等于白花。
    pub fn io_detail_retried(
        what: &str,
        path: &std::path::Path,
        f: &crate::core::fsx::RetryFailure,
    ) -> Self {
        let note = f.note();
        Self::IoDetail(format!(
            "{what}失败: {} —— {}{}{note}",
            path.display(),
            explain_io(&f.source),
            if note.is_empty() { "" } else { " " },
        ))
    }

    /// 把一次 IO 失败翻成人话:做什么的时候、哪个路径、什么毛病、下一步干嘛。
    /// 原始错误码原样带上(`os error 5` 这种是远程排障唯一的硬证据)。
    pub fn io_detail(what: &str, path: &std::path::Path, e: &std::io::Error) -> Self {
        Self::IoDetail(format!(
            "{what}失败: {} —— {}",
            path.display(),
            explain_io(e)
        ))
    }
}

/// `std::io::Error` 的人话翻译:症状 + 该查什么。
///
/// **只描述症状,不描述本进程做过什么**。此前这里写着「自动重试后仍不放手」,
/// 可它同时被 `manifest::load`(读,不重试)和诊断报告的可达性探测(不重试)
/// 调用——对用户撒谎说系统试过了,而这句恰恰是把人往「杀毒软件」而不是
/// 「权限配置」引的那句。重试过没有,由真的重试过的调用点自己去说。
///
/// 同理,兜底句不写死「写入失败」:拼到「读取拷卡清单失败」上会自相矛盾。
/// 动作词一律由调用方的 `what` 参数提供。
pub fn explain_io(e: &std::io::Error) -> String {
    use std::io::ErrorKind as K;
    // 共享/锁冲突在 Windows 上是**明确**的占用,不该落到「多半是网络中断」
    #[cfg(windows)]
    let sharing_violation = matches!(e.raw_os_error(), Some(32) | Some(33));
    #[cfg(not(windows))]
    let sharing_violation = false;

    let advice = if sharing_violation {
        "文件正被另一个程序独占(共享冲突)。常见的是杀毒软件、Windows 搜索或 NAS 自己的索引正在扫这个目录;等它扫完,或把该目录加入杀毒软件排除项。"
    } else {
        match e.kind() {
            K::PermissionDenied => {
                if cfg!(windows) {
                    // Windows 把「有人占着」和「你没权限」压在同一个错误码 5 上,
                    // 从错误码分不开——两种都摆出来,不替用户猜一个
                    "拒绝访问。Windows 用同一个错误码表示两件事,都要查:① 文件正被别的程序开着(杀毒软件 / Windows 搜索 / NAS 索引);② 当前账号对这个目录没有写权限,或 SMB 登录会话过期了(在资源管理器里重连一次共享)。"
                } else {
                    "拒绝访问。检查该目录对当前账号的权限;若在网络盘上,也可能是挂载会话过期,重新挂载后再试。"
                }
            }
            K::NotFound => "路径不存在。目录可能被删了,或者 NAS / 存储卡已经掉线——重新挂载后再试。",
            K::StorageFull => "目标空间已满。清理出空间后再试。",
            K::ReadOnlyFilesystem => {
                "目标是只读的。检查共享/卷的读写权限(若目标是存储卡,也看一眼卡的写保护开关)。"
            }
            K::ConnectionAborted
            | K::ConnectionReset
            | K::BrokenPipe
            | K::TimedOut
            | K::HostUnreachable
            | K::NetworkDown
            | K::NetworkUnreachable => "连接中断。NAS / 网络掉线了,恢复后可以从断点接着来。",
            _ => "操作失败。若目标在 NAS 上,多半是连接中断;恢复后可以从断点接着来。",
        }
    };
    match e.raw_os_error() {
        Some(code) => format!("{advice}(系统错误码 {code}:{e})"),
        None => format!("{advice}({e})"),
    }
}

pub type Result<T> = std::result::Result<T, CoreError>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Error, ErrorKind};

    /// 可续传判定漏掉 IoDetail 时本测试红——漏了就等于把「NAS 抖了一下」
    /// 判成死路,任务再也接不上,用户只能整卡重拷。
    #[test]
    fn io_detail_counts_as_io_for_resume_classification() {
        assert!(CoreError::Io(Error::from(ErrorKind::PermissionDenied)).is_io());
        assert!(CoreError::io_detail(
            "写入清单",
            std::path::Path::new("/x"),
            &Error::from(ErrorKind::PermissionDenied)
        )
        .is_io());
        assert!(!CoreError::Invalid("坏清单".into()).is_io());
        assert!(!CoreError::AlreadyExists("/x".into()).is_io());
    }

    /// 事故原文是「IO 错误: 拒绝访问。 (os error 5)」:没有路径、没有下一步。
    /// 报文退回这种形态时本测试红。
    /// 平台各自的「拒绝访问」原始码:Windows `ERROR_ACCESS_DENIED(5)`
    /// (0.4.3 事故现场那个),POSIX `EACCES(13)`。用原始码而不是
    /// `ErrorKind` 构造,才能同时验到「kind 分类对」和「原始码留住了」。
    const DENIED_RAW: i32 = if cfg!(windows) { 5 } else { 13 };

    #[test]
    fn permission_denied_message_names_the_path_the_step_and_the_next_move() {
        let e = Error::from_raw_os_error(DENIED_RAW);
        assert_eq!(
            e.kind(),
            ErrorKind::PermissionDenied,
            "前置:本平台的拒绝访问码必须被识别成 PermissionDenied,否则本测试考的是回落分支"
        );
        let msg = CoreError::io_detail(
            "写入拷卡清单",
            std::path::Path::new("Z:/项目/.ocard/manifests/abc.json"),
            &e,
        )
        .to_string();
        assert!(msg.contains("写入拷卡清单"), "要说清是哪一步: {msg}");
        assert!(msg.contains("abc.json"), "要说清是哪个文件: {msg}");
        // 下一步的内容按平台不同:Windows 上错误码 5 同时代表「有人占着」和
        // 「没权限」,两种都要摆;POSIX 上 EACCES 基本是确定性的权限问题
        let must_mention = if cfg!(windows) {
            "杀毒软件"
        } else {
            "权限"
        };
        assert!(
            msg.contains(must_mention),
            "要给出可执行的下一步(本平台应提到「{must_mention}」): {msg}"
        );
        assert!(
            msg.contains(&format!("系统错误码 {DENIED_RAW}")),
            "原始错误码是远程排障的硬证据: {msg}"
        );
    }

    /// 原始错误码是远程排障唯一的硬证据,必须逐条留住。
    ///
    /// 此前这里全用 `Error::from(kind)` 构造 —— `raw_os_error()` 恒为 `None`,
    /// 于是**只走了没有错误码的那条分支**,测试名说的事一次都没验到,
    /// 而且带着一条恒真的 `assert!(!msg.is_empty())`(评审点名)。
    #[test]
    fn every_explained_kind_keeps_the_raw_code() {
        // (errno, 期望被识别成的 kind):都用真实的平台错误码构造
        // (errno, std 会把它分类成哪个 kind)。`None` = **std 根本不分类**
        // (落进 unstable 的 `Uncategorized`)——那恰恰是 `explain_io` 必须看
        // `raw_os_error()` 而不是 `kind()` 的理由:Windows 的
        // `ERROR_SHARING_VIOLATION(32)` / `ERROR_LOCK_VIOLATION(33)` 是明确的
        // 独占冲突,std 一个都没归类;只按 kind 判会把它们扫进「多半是网络中断」。
        let cases: &[(i32, Option<ErrorKind>)] = if cfg!(windows) {
            &[
                (2, Some(ErrorKind::NotFound)),         // ERROR_FILE_NOT_FOUND
                (5, Some(ErrorKind::PermissionDenied)), // ERROR_ACCESS_DENIED(事故现场那个)
                (32, None),                             // ERROR_SHARING_VIOLATION:std 不分类
                (112, Some(ErrorKind::StorageFull)),    // ERROR_DISK_FULL
            ]
        } else {
            &[
                (2, Some(ErrorKind::NotFound)),          // ENOENT
                (13, Some(ErrorKind::PermissionDenied)), // EACCES
                (28, Some(ErrorKind::StorageFull)),      // ENOSPC
                (32, Some(ErrorKind::BrokenPipe)),       // EPIPE
            ]
        };
        for (code, want_kind) in cases {
            let e = Error::from_raw_os_error(*code);
            if let Some(k) = want_kind {
                assert_eq!(
                    e.kind(),
                    *k,
                    "前置:本平台的 errno {code} 应被识别成 {k:?},否则下面考的是回落分支"
                );
            }
            let msg = explain_io(&e);
            assert!(
                msg.contains(&format!("系统错误码 {code}")),
                "errno {code} 的原始码没留住: {msg}"
            );
            // 报文必须有实际内容,不能只是把 errno 复述一遍
            assert!(msg.chars().count() > 20, "errno {code} 的报文太单薄: {msg}");
        }
    }

    /// Windows 上 ERROR_SHARING_VIOLATION(32) 是**明确的独占冲突**,不该落到
    /// 「多半是网络中断」那句通用兜底上——那会把人往完全错误的方向引。
    #[test]
    #[cfg(windows)]
    fn sharing_violation_is_named_as_contention_not_as_a_network_problem() {
        let msg = explain_io(&Error::from_raw_os_error(32));
        assert!(msg.contains("独占"), "{msg}");
        assert!(!msg.contains("网络中断"), "{msg}");
    }
}
