//! 流式 xxHash3-64 文件校验(规范:拷贝需要使用 HASH 检验是否拷贝完全)。

use super::Result;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use xxhash_rust::xxh3::Xxh3;

const BUF_SIZE: usize = 1024 * 1024;

/// 计算文件的 xxHash3-64,返回 16 位十六进制小写字符串。
pub fn xxh3_file(path: &Path) -> Result<String> {
    // 打不开要带步骤与路径:裸的「IO 错误: 拒绝访问 (os error 5)」正是 0.4.3 事故的形状
    let f =
        File::open(path).map_err(|e| super::CoreError::io_detail("打开文件(哈希)", path, &e))?;
    xxh3_reader(f)
}

/// 哈希**源**文件:按 [`fsx::open_source_retried`](super::fsx::open_source_retried) 打开
/// (Windows 上排他于写者、按占用重试),打不开的报文带步骤、路径、原因与重试轮数。
pub fn xxh3_file_source(path: &Path) -> Result<String> {
    let f = super::fsx::open_source_retried(path)
        .map_err(|f| super::CoreError::io_detail_retried("打开源文件(哈希)", path, &f))?;
    xxh3_reader(f)
}

/// 校验专用:尽量绕页缓存读取后计算哈希(M2 技术债:回读命中页缓存会弱化校验)。
pub fn xxh3_file_uncached(path: &Path) -> Result<String> {
    xxh3_reader(super::fsx::open_uncached(path)?)
}

fn xxh3_reader(mut file: File) -> Result<String> {
    let mut hasher = Xxh3::new();
    let mut buf = vec![0u8; BUF_SIZE];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:016x}", hasher.digest()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn hashes_are_stable_and_content_sensitive() {
        let tmp = tempdir().unwrap();
        let a = tmp.path().join("a.bin");
        let b = tmp.path().join("b.bin");
        std::fs::write(&a, b"hello ocard").unwrap();
        std::fs::write(&b, b"hello ocard!").unwrap();

        let ha1 = xxh3_file(&a).unwrap();
        let ha2 = xxh3_file(&a).unwrap();
        let hb = xxh3_file(&b).unwrap();
        assert_eq!(ha1, ha2);
        assert_ne!(ha1, hb);
        assert_eq!(ha1.len(), 16);
    }

    #[test]
    fn hashes_large_multi_buffer_file() {
        let tmp = tempdir().unwrap();
        let p = tmp.path().join("big.bin");
        let mut f = std::fs::File::create(&p).unwrap();
        let chunk = vec![0xABu8; 512 * 1024];
        for _ in 0..5 {
            f.write_all(&chunk).unwrap(); // 2.5 MiB,跨多个缓冲区
        }
        drop(f);
        let h1 = xxh3_file(&p).unwrap();
        let h2 = xxh3_file(&p).unwrap();
        assert_eq!(h1, h2);
    }
}
