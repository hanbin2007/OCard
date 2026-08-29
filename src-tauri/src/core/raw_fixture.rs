//! 合成 RAW 样本(**只在测试里编译**)。
//!
//! 为什么单开一份而不是复用 `preview_raw` 里的构造器:那一套住在
//! `preview_raw` 的 `#[cfg(test)] mod tests` 里,是它自己 43 条用例的私产;
//! 把它开成 `pub(crate)` 等于去动那个模块。接线这一侧要的东西也小得多——
//! 只需要**一种**形状:一个 IFD0 同时声明「原始感光尺寸」和「内嵌 JPEG
//! 在哪」,这正是 CR2 的样子。四档 adequacy 靠调这两组数字就能全部造出来。
//!
//! ## 这份样本能证明什么、不能证明什么
//!
//! 能证明:接线把 `adequacy` / `warning` / 方向 / 上限 / 缓存这几件事**接对了**。
//! **不能**证明真实机身把预览写在哪一支——那要拿真机 RAW 才验得了。

/// 一个合成 RAW 的规格。
pub struct SynthRaw {
    /// 内嵌预览 JPEG 的像素(未摆正)
    pub preview: (u32, u32),
    /// 写进 IFD0 的原始感光尺寸。
    /// `None` = 文件里**根本没声明**原图多大 —— 对应 `Unknown` 档:
    /// 那时既不能说它是全尺寸,也不能说它不是
    pub full: Option<(u32, u32)>,
    /// IFD0 的 EXIF Orientation(1..=8)
    pub orientation: u16,
}

impl SynthRaw {
    /// 四档里最常用的那种:横构图,方向正立。
    pub fn new(preview: (u32, u32), full: Option<(u32, u32)>) -> Self {
        Self {
            preview,
            full,
            orientation: 1,
        }
    }

    pub fn with_orientation(mut self, o: u16) -> Self {
        self.orientation = o;
        self
    }

    /// 造出这份 RAW 的字节。
    ///
    /// 结构是**经典 TIFF**:8 字节头 → IFD0 → JPEG blob。所有值都塞得进
    /// 条目自带的 4 字节里,所以不需要值堆——偏移只有一处要算,构造器
    /// 自己出错的余地被压到最小。
    pub fn bytes(&self) -> Vec<u8> {
        let jpeg = jpeg_of(self.preview.0, self.preview.1);

        // (tag, type, value)。TIFF 要求条目按 tag 升序,这里手工保持有序
        let mut tags: Vec<(u16, u16, u32)> = Vec::new();
        if let Some((fw, fh)) = self.full {
            // NewSubfileType 的 bit0 = 0 → 这是主图像,它的尺寸就是原始感光
            // 尺寸。不写这三条时 `full_size_from_ifds` 无从下手,于是 Unknown
            tags.push((0x00FE, 4, 0)); // NewSubfileType = 0
            tags.push((0x0100, 4, fw)); // ImageWidth
            tags.push((0x0101, 4, fh)); // ImageLength
        }
        tags.push((0x0112, 3, u32::from(self.orientation))); // Orientation(SHORT)
                                                             // JPEGInterchangeFormat / -Length:偏移待填(下面算出来再回写)
        tags.push((0x0201, 4, 0));
        tags.push((0x0202, 4, jpeg.len() as u32));

        let ifd_at = 8usize;
        let after_ifd = ifd_at + 2 + 12 * tags.len() + 4;
        let blob_at = after_ifd + after_ifd % 2; // 对齐到偶数,和真文件一个习惯
        for t in tags.iter_mut() {
            if t.0 == 0x0201 {
                t.2 = blob_at as u32;
            }
        }

        let mut out = vec![0u8; blob_at];
        out[0..2].copy_from_slice(b"II");
        out[2..4].copy_from_slice(&42u16.to_le_bytes());
        out[4..8].copy_from_slice(&(ifd_at as u32).to_le_bytes());
        out[ifd_at..ifd_at + 2].copy_from_slice(&(tags.len() as u16).to_le_bytes());
        for (i, (tag, ty, val)) in tags.iter().enumerate() {
            let e = ifd_at + 2 + i * 12;
            out[e..e + 2].copy_from_slice(&tag.to_le_bytes());
            out[e + 2..e + 4].copy_from_slice(&ty.to_le_bytes());
            out[e + 4..e + 8].copy_from_slice(&1u32.to_le_bytes()); // count = 1
                                                                    // SHORT 占低 2 字节,LONG 占 4 字节;两者都塞得进条目内联区
            out[e + 8..e + 12].copy_from_slice(&val.to_le_bytes());
        }
        // 下一个 IFD 的偏移 = 0(链到此为止),vec 已经是 0,无需再写
        out.extend_from_slice(&jpeg);
        out
    }

    /// 直接落一份到磁盘。
    pub fn write(&self, path: &std::path::Path) {
        std::fs::write(path, self.bytes()).unwrap();
    }
}

/// 一张真 JPEG(带纹理,免得被编码器压成退化码流)。
fn jpeg_of(w: u32, h: u32) -> Vec<u8> {
    let img = image::RgbImage::from_fn(w, h, |x, y| {
        image::Rgb([(x % 251) as u8, (y % 241) as u8, ((x ^ y) % 233) as u8])
    });
    let mut out = Vec::new();
    image::DynamicImage::ImageRgb8(img)
        .write_to(
            &mut std::io::Cursor::new(&mut out),
            image::ImageFormat::Jpeg,
        )
        .unwrap();
    out
}
