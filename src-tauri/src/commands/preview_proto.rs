//! `preview://` 全尺寸预览协议:按需读**本机**预览缓存文件。
//!
//! 为什么不走 IPC 返回 base64:一张 4500 万像素的预览 JPEG 有几 MB,
//! base64 还要再胀 1/3,整包塞进一次 invoke 回包会把 webview 卡住。
//! 与 `thumb://` 同构:命令层负责解码落盘,协议层只负责把文件递出去。
//!
//! 安全(与 `thumb_proto` 同一套纪律——这是 webview 可达的文件读原语):
//! - URL 路径仅接受 `/<cacheName>` 一段;
//! - cacheName 必须精确匹配 `^[0-9a-f]{16}\.jpg$`(缓存命名不变量,
//!   判据与 `core::preview::is_cache_name` 同一个函数,不另写一套);
//! - 读取路径钉死在 `<预览缓存目录>/<cacheName>`,缓存文件自身拒符号链接;
//! - canonical 落点必须仍在缓存目录内;
//! - 任何闸拒绝/读失败返回 404。

use std::path::{Path, PathBuf};

/// 解析并校验一次全尺寸预览请求,返回可读的缓存文件绝对路径。
/// 纯函数:一切闸都在这里,协议处理器只做 IO。
pub fn resolve_preview_request(cache_dir: &Path, url_path: &str) -> Result<PathBuf, String> {
    // 与 thumb 同规矩:webview 会百分号编码,先 decode 再进闸
    let decoded = percent_encoding::percent_decode_str(url_path)
        .decode_utf8()
        .map_err(|_| "路径不是合法 UTF-8".to_string())?;
    let url_path: &str = &decoded;
    let mut segs = url_path.trim_start_matches('/').split('/');
    let (Some(cache_name), None) = (segs.next(), segs.next()) else {
        return Err("路径段数不合法".into());
    };
    if !crate::core::preview::is_cache_name(cache_name) {
        return Err(format!("缓存名不合白名单: {cache_name}"));
    }
    let path = cache_dir.join(cache_name);
    if crate::core::paths::is_symlink(&path) {
        return Err("缓存文件是符号链接,拒绝".into());
    }
    // 缓存目录存在才锚(不存在时读取自然 404)
    if cache_dir.is_dir() {
        crate::core::paths::assert_within(cache_dir, &path)?;
    }
    Ok(path)
}

/// 前端可用的全尺寸预览 URL(平台差异同 thumb:Windows 映射为 http://preview.localhost)。
pub fn preview_url(cache_file_name: &str) -> String {
    if cfg!(windows) {
        format!("http://preview.localhost/{cache_file_name}")
    } else {
        format!("preview://localhost/{cache_file_name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn accepts_only_whitelisted_shape() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path();
        std::fs::create_dir_all(dir).unwrap();
        let ok = resolve_preview_request(dir, "/0123456789abcdef.jpg").unwrap();
        assert!(ok.ends_with("0123456789abcdef.jpg"));

        for bad in [
            "/",                          // 空段
            "/a/0123456789abcdef.jpg",    // 段数超
            "/../0123456789abcdef.jpg",   // 段数超(逃逸)
            "/0123456789ABCDEF.jpg",      // 大写(非缓存命名不变量)
            "/0123456789abcde.jpg",       // 长度不对
            "/0123456789abcdef.png",      // 扩展名
            "/0123456789abcdeg.jpg",      // 非 hex
            "/%2E%2E%2F0123456789ab.jpg", // 编码逃逸
        ] {
            assert!(resolve_preview_request(dir, bad).is_err(), "{bad} 必须被拒");
        }
    }

    /// 缓存目录整个是我们自己的,但缓存文件本身仍可能被换成链接
    /// (共享 /tmp、被别的进程写),落点必须仍在缓存目录内。
    #[cfg(unix)]
    #[test]
    fn symlinked_cache_file_rejected() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path().join("previews");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("evil.jpg"), b"x").unwrap();
        std::os::unix::fs::symlink(outside.join("evil.jpg"), dir.join("0123456789abcdef.jpg"))
            .unwrap();
        assert!(resolve_preview_request(&dir, "/0123456789abcdef.jpg").is_err());
    }

    #[test]
    fn url_shape_matches_platform() {
        let url = preview_url("0123456789abcdef.jpg");
        assert!(url.ends_with("/0123456789abcdef.jpg"));
        assert!(url.starts_with(if cfg!(windows) {
            "http://preview.localhost"
        } else {
            "preview://localhost"
        }));
    }
}
