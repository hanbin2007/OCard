//! `thumb://` 缩略图协议(M3 W4):按需读缩略图缓存文件,替代 base64 内联,
//! 把 200 张/页的 IPC 体积从 ~5MB 降到 KB 级。
//!
//! 安全(计划 D1/纪律条款——这是一个 webview 可达的新文件读原语,必须设闸):
//! - URL 路径仅接受 `/<projectId>/<cacheName>` 两段;
//! - projectId 必须是单一普通成分(拒分隔符/../盘符/冒号);
//! - cacheName 必须精确匹配 `^[0-9a-f]{16}\.jpg$`(缩略图缓存的命名不变量);
//! - 实际读取路径钉死在 `<nas>/<projectId>/.ocard/thumbs/<cacheName>`,
//!   项目目录与缓存文件自身拒符号链接;
//! - 任何闸拒绝/读失败返回 404,连续失败聚合告警(零静默)由调用层计数。

use std::path::{Path, PathBuf};

/// 解析并校验一次缩略图请求,返回可读的缓存文件绝对路径。
/// 纯函数:一切闸都在这里,协议处理器只做 IO。
pub fn resolve_thumb_request(nas_root: &Path, url_path: &str) -> Result<PathBuf, String> {
    // webview 对非 ASCII 必然百分号编码(规范项目名是中文!);
    // 与 tauri 内置协议同规矩:先 decode 再进闸(评审 P0-1)
    let decoded = percent_encoding::percent_decode_str(url_path)
        .decode_utf8()
        .map_err(|_| "路径不是合法 UTF-8".to_string())?;
    let url_path: &str = &decoded;
    let mut segs = url_path.trim_start_matches('/').split('/');
    let (Some(project_id), Some(cache_name), None) = (segs.next(), segs.next(), segs.next()) else {
        return Err("路径段数不合法".into());
    };
    // projectId:单一普通成分(与 sorting 的段规则同源)
    if project_id.is_empty()
        || project_id.contains(['\\', ':'])
        || project_id == "."
        || project_id == ".."
    {
        return Err(format!("项目 id 非法: {project_id}"));
    }
    let mut comps = Path::new(project_id).components();
    if !matches!(
        (comps.next(), comps.next()),
        (Some(std::path::Component::Normal(_)), None)
    ) {
        return Err(format!("项目 id 非法: {project_id}"));
    }
    // cacheName:精确白名单 ^[0-9a-f]{16}\.jpg$
    let ok_name = cache_name.len() == 20
        && cache_name.ends_with(".jpg")
        && cache_name[..16]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase());
    if !ok_name {
        return Err(format!("缓存名不合白名单: {cache_name}"));
    }
    let project_root = nas_root.join(project_id);
    if crate::core::paths::is_symlink(&project_root) {
        return Err("项目目录是符号链接,拒绝".into());
    }
    let path = crate::core::media::thumbs_dir(&project_root).join(cache_name);
    if crate::core::paths::is_symlink(&path) {
        return Err("缓存文件是符号链接,拒绝".into());
    }
    // R2 P0:首尾两段检查挡不住中间组件(`.ocard`/`thumbs` 本身被换成链接)——
    // canonicalize 断言实际落点仍在 NAS 根之内(以 nas_root 为基准:项目目录
    // 可能尚不存在,此时最深已存在祖先就是 NAS 根,天然通过)
    crate::core::paths::assert_within(nas_root, &path)?;
    Ok(path)
}

/// 前端可用的缩略图 URL(平台差异:Windows 自定义协议映射为 http://thumb.localhost)。
pub fn thumb_url(project_id: &str, cache_file_name: &str) -> String {
    if cfg!(windows) {
        format!("http://thumb.localhost/{project_id}/{cache_file_name}")
    } else {
        format!("thumb://localhost/{project_id}/{cache_file_name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn accepts_only_whitelisted_shape() {
        let tmp = tempdir().unwrap();
        let nas = tmp.path();
        let ok = resolve_thumb_request(nas, "/20260824_项目/0123456789abcdef.jpg").unwrap();
        assert!(ok.ends_with("20260824_项目/.ocard/thumbs/0123456789abcdef.jpg"));

        for bad in [
            "/p",                         // 段数不足
            "/p/a/b.jpg",                 // 段数超
            "/../0123456789abcdef.jpg",   // 项目段逃逸
            "/p\\x/0123456789abcdef.jpg", // 反斜杠
            "/C:/0123456789abcdef.jpg",   // 盘符
            "/p/0123456789ABCDEF.jpg",    // 大写(非缓存命名不变量)
            "/p/0123456789abcde.jpg",     // 长度不对
            "/p/0123456789abcdef.png",    // 扩展名
            "/p/../0123456789abcdef.jpg", // 缓存段逃逸(段数会超)
            "/p/0123456789abcdeg.jpg",    // 非 hex
        ] {
            assert!(resolve_thumb_request(nas, bad).is_err(), "{bad} 必须被拒");
        }
    }

    #[test]
    fn percent_encoded_paths_decode_before_gates() {
        // 评审 P0-1:中文项目名经 webview 编码后必须还原;编码的逃逸照样被拒
        let tmp = tempdir().unwrap();
        let nas = tmp.path();
        let ok = resolve_thumb_request(
            nas,
            "/20260824_%E6%A0%A1%E8%BF%90%E4%BC%9A/0123456789abcdef.jpg",
        )
        .unwrap();
        assert!(ok.ends_with("20260824_校运会/.ocard/thumbs/0123456789abcdef.jpg"));
        // 编码的 ../ 不许绕闸
        assert!(resolve_thumb_request(nas, "/%2E%2E/0123456789abcdef.jpg").is_err());
        assert!(
            resolve_thumb_request(nas, "/p%2F..%2Fq/0123456789abcdef.jpg").is_err(),
            "解码引入的分隔符要落进段校验"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_project_or_cache_rejected() {
        let tmp = tempdir().unwrap();
        let nas = tmp.path();
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, nas.join("链接项目")).unwrap();
        assert!(
            resolve_thumb_request(nas, "/链接项目/0123456789abcdef.jpg").is_err(),
            "项目目录为链接必须拒"
        );

        let real = nas.join("真项目/.ocard/thumbs");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(outside.join("evil.jpg"), b"x").unwrap();
        std::os::unix::fs::symlink(outside.join("evil.jpg"), real.join("0123456789abcdef.jpg"))
            .unwrap();
        assert!(
            resolve_thumb_request(nas, "/真项目/0123456789abcdef.jpg").is_err(),
            "缓存文件为链接必须拒"
        );
    }

    /// R2 P0:首尾检查挡不住中间组件——`.ocard/thumbs` 整段被换成指向
    /// NAS 外的链接时,canonical 闸必须拒绝(变异:删 assert_within 本测试红)。
    #[cfg(unix)]
    #[test]
    fn symlinked_middle_component_rejected() {
        let tmp = tempdir().unwrap();
        let nas = tmp.path().join("nas");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(nas.join("项目/.ocard")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("0123456789abcdef.jpg"), b"x").unwrap();
        std::os::unix::fs::symlink(&outside, nas.join("项目/.ocard/thumbs")).unwrap();
        assert!(
            resolve_thumb_request(&nas, "/项目/0123456789abcdef.jpg").is_err(),
            "thumbs 段为链接必须拒(canonical 落点在 NAS 外)"
        );
        // 对照:真实目录下同名文件可通过
        let nas2 = tmp.path().join("nas2");
        std::fs::create_dir_all(nas2.join("项目/.ocard/thumbs")).unwrap();
        std::fs::write(nas2.join("项目/.ocard/thumbs/0123456789abcdef.jpg"), b"x").unwrap();
        assert!(resolve_thumb_request(&nas2, "/项目/0123456789abcdef.jpg").is_ok());
    }
}
