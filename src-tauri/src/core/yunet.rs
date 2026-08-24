//! YuNet 人脸检测(M3 W7b,PRD §5.5):ONNX Runtime CPU 推理。
//! 模型:face_detection_yunet_2023mar.onnx(MIT,opencv_zoo;SHA-256 钉死,
//! 校验失败=禁用人脸检测+可见 error,绝不静默退化)。
//! anchor-free 解码(stride 8/16/32):score=√(cls·obj),bbox exp 解码,NMS。
//!
//! 诚实边界(PRD):最小人脸 24px(输入尺度)以下不判;**闭眼检测已砍**
//! (无许可证干净且经真实样本验证的开闭眼模型;YuNet 5 点每眼仅 1 点,
//! EAR 不可实现——计划 D1 裁决,记入 PRD 能力边界)。

use std::path::Path;
use std::sync::Mutex;

/// 模型文件的 SHA-256(资源随包分发;启动校验)。
pub const YUNET_SHA256: &str = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4";
pub const YUNET_FILE: &str = "face_detection_yunet_2023mar.onnx";

const SCORE_THRESHOLD: f32 = 0.7;
const NMS_IOU: f32 = 0.3;
/// 输入尺度上的最小脸(合影中过小的脸不判——PRD 边界)。
const MIN_FACE_PX: f32 = 24.0;

#[derive(Debug, Clone)]
pub struct FaceBox {
    /// 相对原图的归一化坐标(0-1)。
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub score: f32,
}

pub struct FaceDetector {
    session: Mutex<ort::session::Session>,
}

/// SHA-256 校验(计划 D1:失败=硬失败)。
pub fn verify_model(path: &Path) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path).map_err(|e| format!("读取模型失败: {e}"))?;
    let digest = hex::encode(Sha256::digest(&bytes));
    if digest != YUNET_SHA256 {
        return Err(format!(
            "模型 SHA-256 不匹配(got {digest},want {YUNET_SHA256}),文件可能损坏或被替换"
        ));
    }
    Ok(())
}

impl FaceDetector {
    pub fn load(model_path: &Path) -> Result<Self, String> {
        verify_model(model_path)?;
        let session = ort::session::Session::builder()
            .and_then(|mut b| b.commit_from_file(model_path))
            .map_err(|e| format!("模型加载失败: {e}"))?;
        Ok(Self {
            session: Mutex::new(session),
        })
    }

    /// 检测(输入为已解码整图;内部缩放到 ≤320 边、32 对齐)。
    /// 推理经内部互斥串行(rayon 线程安全;单张 ~15ms,串行可承受)。
    pub fn detect(&self, img: &image::DynamicImage) -> Result<Vec<FaceBox>, String> {
        // 模型固定 640×640 输入:最长边缩到 640,右下黑边 letterbox
        let (ow, oh) = (img.width().max(1), img.height().max(1));
        let scale = 640.0 / ow.max(oh) as f32;
        let sw = ((ow as f32 * scale).round() as u32).clamp(1, 640);
        let sh = ((oh as f32 * scale).round() as u32).clamp(1, 640);
        let iw = 640u32;
        let ih = 640u32;
        let resized = img.resize_exact(sw, sh, image::imageops::FilterType::Triangle);
        let rgb = resized.to_rgb8();
        // BGR HWC→CHW,0-255 不归一(OpenCV YuNet 约定)
        let mut input = vec![0f32; (3 * iw * ih) as usize];
        let plane = (iw * ih) as usize;
        for y in 0..sh {
            for x in 0..sw {
                let p = rgb.get_pixel(x, y);
                let idx = (y * iw + x) as usize;
                input[idx] = p[2] as f32; // B
                input[plane + idx] = p[1] as f32; // G
                input[2 * plane + idx] = p[0] as f32; // R
            }
        }
        let tensor = ort::value::Tensor::from_array((
            [1usize, 3, ih as usize, iw as usize],
            input.into_boxed_slice(),
        ))
        .map_err(|e| format!("张量构造失败: {e}"))?;

        let mut session = self.session.lock().unwrap_or_else(|p| p.into_inner());
        let outputs = session
            .run(ort::inputs!["input" => tensor])
            .map_err(|e| format!("推理失败: {e}"))?;

        let mut faces: Vec<FaceBox> = Vec::new();
        for stride in [8u32, 16, 32] {
            let (cls_name, obj_name, bbox_name) = (
                format!("cls_{stride}"),
                format!("obj_{stride}"),
                format!("bbox_{stride}"),
            );
            let cls = extract(&outputs, &cls_name)?;
            let obj = extract(&outputs, &obj_name)?;
            let bbox = extract(&outputs, &bbox_name)?;
            let fw = (iw / stride) as usize;
            let fh = (ih / stride) as usize;
            let cells = fw * fh;
            if cls.len() < cells || obj.len() < cells || bbox.len() < cells * 4 {
                return Err(format!(
                    "输出形状异常 stride={stride}: cls={} obj={} bbox={}",
                    cls.len(),
                    obj.len(),
                    bbox.len()
                ));
            }
            for i in 0..cells {
                let score = (cls[i].clamp(0.0, 1.0) * obj[i].clamp(0.0, 1.0)).sqrt();
                if score < SCORE_THRESHOLD {
                    continue;
                }
                let (cy, cx) = (i / fw, i % fw);
                let dx = bbox[i * 4];
                let dy = bbox[i * 4 + 1];
                let dw = bbox[i * 4 + 2];
                let dh = bbox[i * 4 + 3];
                let ccx = (cx as f32 + dx) * stride as f32;
                let ccy = (cy as f32 + dy) * stride as f32;
                let w = dw.exp() * stride as f32;
                let h = dh.exp() * stride as f32;
                if w < MIN_FACE_PX || h < MIN_FACE_PX {
                    continue; // 过小的脸不判(诚实边界)
                }
                faces.push(FaceBox {
                    x: ((ccx - w / 2.0) / sw as f32).clamp(0.0, 1.0),
                    y: ((ccy - h / 2.0) / sh as f32).clamp(0.0, 1.0),
                    w: (w / sw as f32).min(1.0),
                    h: (h / sh as f32).min(1.0),
                    score,
                });
            }
        }
        Ok(nms(faces))
    }
}

fn extract(outputs: &ort::session::SessionOutputs, name: &str) -> Result<Vec<f32>, String> {
    let v = outputs
        .get(name)
        .ok_or_else(|| format!("模型缺少输出 {name}"))?;
    let (_, data) = v
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("输出 {name} 提取失败: {e}"))?;
    Ok(data.to_vec())
}

fn iou(a: &FaceBox, b: &FaceBox) -> f32 {
    let x1 = a.x.max(b.x);
    let y1 = a.y.max(b.y);
    let x2 = (a.x + a.w).min(b.x + b.w);
    let y2 = (a.y + a.h).min(b.y + b.h);
    let inter = (x2 - x1).max(0.0) * (y2 - y1).max(0.0);
    let union = a.w * a.h + b.w * b.h - inter;
    if union <= 0.0 {
        0.0
    } else {
        inter / union
    }
}

fn nms(mut faces: Vec<FaceBox>) -> Vec<FaceBox> {
    faces.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<FaceBox> = Vec::new();
    for f in faces {
        if kept.iter().all(|k| iou(k, &f) < NMS_IOU) {
            kept.push(f);
        }
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model_path() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/models")
            .join(YUNET_FILE)
    }

    #[test]
    fn model_hash_pinned_and_verifies() {
        verify_model(&model_path()).expect("随仓模型必须过 SHA-256 校验");
        // 篡改必须被拒
        let tmp = tempfile::tempdir().unwrap();
        let bad = tmp.path().join("bad.onnx");
        std::fs::write(&bad, b"tampered").unwrap();
        assert!(verify_model(&bad).unwrap_err().contains("SHA-256"));
    }

    #[test]
    fn detector_loads_and_runs_on_synthetic_images() {
        // 冒烟:加载真实模型,纯色图不许检出人脸(误报域),推理不 panic
        let det = FaceDetector::load(&model_path()).expect("模型应能加载");
        let blank = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            640,
            480,
            image::Rgb([128, 128, 128]),
        ));
        let faces = det.detect(&blank).expect("推理应成功");
        assert!(faces.is_empty(), "纯色图不该检出人脸: {}", faces.len());
    }

    #[test]
    fn nms_suppresses_overlaps() {
        let mk = |x, score| FaceBox {
            x,
            y: 0.1,
            w: 0.3,
            h: 0.3,
            score,
        };
        let kept = nms(vec![mk(0.10, 0.9), mk(0.12, 0.8), mk(0.60, 0.85)]);
        assert_eq!(kept.len(), 2, "重叠框只留最高分");
        assert!(kept.iter().any(|f| (f.x - 0.10).abs() < 1e-6));
        assert!(kept.iter().any(|f| (f.x - 0.60).abs() < 1e-6));
    }
}
