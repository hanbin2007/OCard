//! 路径安全:词法归一与源/目的地布局校验。
//! 开拷与**每一次续传/重绑**都必须过 [`validate_dest_layout`] 这道闸
//! (codex 终验 P0:重插的卡可能挂到某目的地的祖先路径,不复核会写回源卡)。

use std::path::{Component, Path, PathBuf};

/// 词法归一:消解 `.` 与 `..` 组件(`/Volumes/../Volumes/CARD` 这类别名
/// 能绕过 starts_with 嵌套检查)。根之上仍是根(POSIX `/..` ≡ `/`)。
/// 不触碰文件系统、不解析符号链接。
pub fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                let ends_at_root = matches!(
                    out.components().next_back(),
                    Some(Component::RootDir) | Some(Component::Prefix(_))
                );
                if ends_at_root {
                    // 丢弃:根之上仍是根
                } else if !out.pop() {
                    out.push(Component::ParentDir);
                }
            }
            other => out.push(other),
        }
    }
    out
}

/// 跨平台安全比较键:词法归一之上,Windows 再做大小写折叠与 `\\?\` 详细前缀剥离
/// (Windows 文件系统大小写不敏感,`E:\CARD` 与 `e:\card` 是同一棵树;
/// codex 收口验证 P0:大小写别名可绕过嵌套检查写回源卡)。
pub(crate) fn comparison_key(path: &Path) -> PathBuf {
    let n = normalize_lexical(path);
    if cfg!(windows) {
        let s = n.to_string_lossy().to_lowercase();
        // \\?\C:\x → c:\x;\\?\UNC\server\share → \\server\share(codex 四轮 P0:
        // 扩展 UNC 前缀剥成 unc\... 会与普通 UNC 失配,别名漏判)
        let s = match s.strip_prefix(r"\\?\") {
            Some(rest) => match rest.strip_prefix(r"unc\") {
                Some(unc_rest) => format!(r"\\{unc_rest}"),
                None => rest.to_string(),
            },
            None => s,
        };
        PathBuf::from(s)
    } else {
        n
    }
}

/// 源与目的地布局校验:绝对路径、拒绝源目标双向嵌套、拒绝重复目的地。
/// 一切比较基于 comparison_key(大小写/别名安全)。
pub fn validate_dest_layout(source_root: &Path, dest_targets: &[PathBuf]) -> Result<(), String> {
    let source_key = comparison_key(source_root);
    let normalized: Vec<PathBuf> = dest_targets.iter().map(|t| normalize_lexical(t)).collect();
    let keys: Vec<PathBuf> = dest_targets.iter().map(|t| comparison_key(t)).collect();
    for (t, k) in normalized.iter().zip(&keys) {
        if !t.is_absolute() {
            return Err(format!("目的地必须是绝对路径: {}", t.display()));
        }
        if k.starts_with(&source_key) || source_key.starts_with(k) {
            return Err(format!(
                "目的地与源卷互相嵌套,拒绝执行(会写回源卡): {}",
                t.display()
            ));
        }
    }
    for (i, a) in keys.iter().enumerate() {
        for (b, orig) in keys.iter().zip(&normalized).skip(i + 1) {
            if a == b {
                return Err(format!("两个目的地指向同一位置: {}", orig.display()));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// 平台感知的绝对路径构造:Windows 上 `/mnt/x` 不是绝对路径,
    /// 统一映射为 `C:\mnt\x`(codex 微验 #17:裸 POSIX 路径会打红 Windows CI)。
    pub(crate) fn abs(p: &str) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(format!("C:{}", p.replace('/', "\\")))
        } else {
            PathBuf::from(p)
        }
    }

    #[test]
    fn normalize_resolves_dot_and_dotdot_aliases() {
        assert_eq!(
            normalize_lexical(&abs("/Volumes/../Volumes/CARD")),
            abs("/Volumes/CARD")
        );
        assert_eq!(normalize_lexical(&abs("/a/./b/../c")), abs("/a/c"));
        assert_eq!(normalize_lexical(&abs("/a/b/")), abs("/a/b"));
    }

    #[test]
    fn normalize_clamps_parent_dir_at_root() {
        assert_eq!(
            normalize_lexical(&abs("/../Volumes/CARD")),
            abs("/Volumes/CARD")
        );
        assert_eq!(normalize_lexical(&abs("/../../x")), abs("/x"));
        // 相对路径的越根 `..` 保留(不属于绝对路径校验路径)
        assert_eq!(normalize_lexical(Path::new("../a")), PathBuf::from("../a"));
    }

    #[test]
    fn dest_layout_rejects_rebound_source_ancestor() {
        // codex 终验 P0 场景:重绑后的源挂载点是备份目的地的祖先(盘符漂移)
        assert!(
            validate_dest_layout(&abs("/mnt/f"), &[abs("/mnt/f/Backup/target")])
                .unwrap_err()
                .contains("嵌套")
        );
        // 反向嵌套同样拒绝
        assert!(validate_dest_layout(&abs("/mnt/f/card"), &[abs("/mnt/f")]).is_err());
        // `..` 别名伪装的嵌套也拦得住
        assert!(validate_dest_layout(&abs("/mnt/f"), &[abs("/mnt/../mnt/f/x")]).is_err());
        // 相对路径拒绝
        assert!(validate_dest_layout(&abs("/mnt/f"), &[PathBuf::from("relative/x")]).is_err());
        // 重复目的地拒绝
        assert!(
            validate_dest_layout(&abs("/mnt/card"), &[abs("/nas/t"), abs("/nas/../nas/t")])
                .is_err()
        );
        // 正常不相交布局通过
        assert!(
            validate_dest_layout(&abs("/mnt/card"), &[abs("/nas/t"), abs("/backup/t")]).is_ok()
        );
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn case_insensitive_nesting_is_rejected() {
        // codex 收口验证 P0:Windows 大小写别名绕过
        assert!(validate_dest_layout(
            &PathBuf::from(r"E:\CARD"),
            &[PathBuf::from(r"e:\card\Backup")]
        )
        .is_err());
        assert!(
            validate_dest_layout(&PathBuf::from(r"e:\card\sub"), &[PathBuf::from(r"E:\CARD")])
                .is_err()
        );
    }

    #[test]
    fn verbatim_prefix_alias_duplicate_is_rejected() {
        assert!(validate_dest_layout(
            &PathBuf::from(r"D:\src"),
            &[PathBuf::from(r"C:\nas\t"), PathBuf::from(r"\\?\C:\NAS\t")]
        )
        .is_err());
    }

    #[test]
    fn extended_unc_alias_matches_plain_unc() {
        // codex 四轮 P0:\\?\UNC\server\share 与 \\server\share 是同一位置
        assert!(validate_dest_layout(
            &PathBuf::from(r"D:\src"),
            &[
                PathBuf::from(r"\\server\share\t"),
                PathBuf::from(r"\\?\UNC\SERVER\share\t")
            ]
        )
        .is_err());
        // 扩展 UNC 源与普通 UNC 目的地嵌套同样拦截
        assert!(validate_dest_layout(
            &PathBuf::from(r"\\?\UNC\nas\card"),
            &[PathBuf::from(r"\\nas\card\backup")]
        )
        .is_err());
    }
}

/// 目录落地闸(终审修复):把目录实体 canonicalize 后断言仍在 root 之内。
/// 次序是关键——**闸在副作用之前**:先对「最深已存在祖先」断言,
/// 通过后才创建缺失段(缺失段由本进程刚创建,不可能是链接),
/// 最后整体复核一次(防创建期间被替换)。canonicalize→写入之间的
/// 极窄窗口是无锁共享盘的固有边界,已在评审收敛文档声明。
pub(crate) fn ensure_dir_within(root: &Path, dir: &Path) -> Result<(), String> {
    let canon_root = std::fs::canonicalize(root).map_err(|e| format!("根目录解析失败: {e}"))?;
    let root_key = comparison_key(&canon_root);
    let mut probe = dir.to_path_buf();
    while !probe.exists() {
        match probe.parent() {
            Some(p) => probe = p.to_path_buf(),
            None => return Err(format!("目录不在任何已存在路径下: {}", dir.display())),
        }
    }
    let canon_probe = std::fs::canonicalize(&probe).map_err(|e| format!("目录解析失败: {e}"))?;
    if !comparison_key(&canon_probe).starts_with(&root_key) {
        return Err(format!(
            "目录实际位置在根之外(疑似被符号链接替换),拒绝写入: {}",
            dir.display()
        ));
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let canon = std::fs::canonicalize(dir).map_err(|e| format!("目录解析失败: {e}"))?;
    if !comparison_key(&canon).starts_with(&root_key) {
        return Err(format!(
            "目录实际位置在根之外(疑似被符号链接替换),拒绝写入: {}",
            dir.display()
        ));
    }
    Ok(())
}

/// 判定路径自身是否为符号链接(不存在视为否)。
pub(crate) fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

#[cfg(test)]
mod dir_gate_tests {
    use super::*;
    use tempfile::tempdir;

    #[cfg(unix)]
    #[test]
    fn gate_refuses_before_side_effects() {
        // 终审 P0:链接祖先下的缺失子目录不许先在根外被创建
        let tmp = tempdir().unwrap();
        let root = tmp.path().join("root");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();

        let target = root.join("link/新子夹/更深");
        let err = ensure_dir_within(&root, &target).unwrap_err();
        assert!(err.contains("根之外"), "{err}");
        assert!(
            !outside.join("新子夹").exists(),
            "闸必须先于副作用:根外不许出现任何新目录"
        );
        // 正常目录通过并创建
        ensure_dir_within(&root, &root.join("a/b")).unwrap();
        assert!(root.join("a/b").is_dir());
    }
}
