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

/// 源与目的地布局校验:绝对路径、拒绝源目标双向嵌套、拒绝重复目的地。
/// 一切比较基于词法归一后的路径。
pub fn validate_dest_layout(source_root: &Path, dest_targets: &[PathBuf]) -> Result<(), String> {
    let source_root = normalize_lexical(source_root);
    let normalized: Vec<PathBuf> = dest_targets.iter().map(|t| normalize_lexical(t)).collect();
    for t in &normalized {
        if !t.is_absolute() {
            return Err(format!("目的地必须是绝对路径: {}", t.display()));
        }
        if t.starts_with(&source_root) || source_root.starts_with(t) {
            return Err(format!(
                "目的地与源卷互相嵌套,拒绝执行(会写回源卡): {}",
                t.display()
            ));
        }
    }
    for (i, a) in normalized.iter().enumerate() {
        for b in normalized.iter().skip(i + 1) {
            if a == b {
                return Err(format!("两个目的地指向同一位置: {}", a.display()));
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
