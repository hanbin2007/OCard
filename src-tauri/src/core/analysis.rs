//! 本地 AI 选片——客观分析核心(M3 W7a,PRD §5.5,纯算法层):
//! - **单次解码流水线**(计划 C2:千张 ≤5min 的瓶颈在 JPEG 解码,不在推理):
//!   一次 `image::open` 产出 → 高分辨率中心裁块清晰度(计划 C3:不在 320px 上算,
//!   降采样是低通,糊片会被抹平)→ 64×64 灰度 dHash+直方图 → 320 缩略图回填共享缓存;
//! - 特征缓存:`.ocard/analysis/features-<机器ID>.jsonl` 每机纯追加(计划 D4,
//!   与 журнал 同构零跨机写竞争);记录带源指纹/schema/算法版本,
//!   读端只采信全匹配,跨机同键冲突取 analyzedAt 最新、持平 machineId 字典序大;
//! - **不缓存 groupId**(计划 C5):聚类是全集操作,查询时确定性现算;
//! - AI 只标注不动文件(PRD §5.5 底线)。
//!
//! 能力边界(诚实声明):清晰度/曝光是客观指标;审美不做;
//! 人脸/闭眼归 W7b(ONNX),本层不涉。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const ANALYSIS_DIR: &str = "analysis";
/// 特征 schema 版本:字段变更时递增,旧记录自动视为未分析。
pub const SCHEMA_VERSION: u32 = 1;
/// 算法版本:评分/哈希算法变更时递增。
pub const ALGO_VERSION: u32 = 2; // v2:解码统一 EXIF 摆正(dHash/清晰度口径随之变化)

/// 连拍聚类的时间窗(秒)与 dHash 汉明距阈值。
pub const BURST_GAP_SECS: i64 = 3;
pub const BURST_HAMMING_MAX: u32 = 12;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureRecord {
    pub rel: String,
    /// 源指纹:xxh3(rel + size + mtime_nanos)。
    pub src_fingerprint: u64,
    pub schema_version: u32,
    pub algo_version: u32,
    /// 64-bit 差值哈希(相似聚类用)。
    pub dhash: u64,
    /// 清晰度(中心裁块拉普拉斯方差,已对数压缩到 0-100 量级)。
    pub sharpness: f32,
    /// 过曝/欠曝像素占比(0-1)。
    pub over_exposed: f32,
    pub under_exposed: f32,
    /// 拍摄时刻(epoch 秒,EXIF 优先 mtime 回退;聚类排序用,避免列表期重读 EXIF)。
    pub shot_at_epoch: Option<i64>,
    /// 检出人脸数(None=本次分析时人脸检测不可用;闭眼检测已砍,见 yunet.rs 边界)。
    #[serde(default)]
    pub faces: Option<u32>,
    /// 产出 faces 的模型身份(SHA-256 前 8 位;None=无人脸信息)。
    /// R4 终审 P0-9:缓存必须携带模型身份,模型修复/更换后可判定重算。
    #[serde(default)]
    pub faces_model: Option<String>,
    pub analyzed_at: chrono::DateTime<chrono::Utc>,
    pub machine_id: String,
}

/// 当前人脸模型身份(SHA-256 前 8 位;与 FeatureRecord.faces_model 同口径)。
pub fn current_faces_model() -> &'static str {
    &super::yunet::YUNET_SHA256[..8]
}

/// 缓存记录的「人脸信息等级」:2=当前模型的有效结果;1=旧模型结果;0=无。
/// 冲突合并与缓存命中共用同一把尺(R5 终审:模型身份必须进裁决,
/// 旧模型的 Some 不许永久命中,也不许在合并里压过当前模型)。
fn faces_rank(rec: &FeatureRecord) -> u8 {
    match (&rec.faces, rec.faces_model.as_deref()) {
        (Some(_), Some(m)) if m == current_faces_model() => 2,
        (Some(_), _) => 1,
        _ => 0,
    }
}

/// 缓存命中判定(R4/R5 终审 P0-9):检测器缺席=任何记录都命中(无从重算);
/// 检测器在场=只有**当前模型**的有效人脸结果才命中——faces=None、
/// 旧模型结果、失败记录都必须重算(模型修复/更换后自愈)。
pub fn cache_hit(rec: &FeatureRecord, detector_present: bool) -> bool {
    !detector_present || faces_rank(rec) == 2
}

pub fn src_fingerprint(rel: &str, size: u64, mtime_nanos: u128) -> u64 {
    xxhash_rust::xxh3::xxh3_64(format!("{rel}\u{0}{size}\u{0}{mtime_nanos}").as_bytes())
}

pub fn analysis_dir(project_root: &Path) -> PathBuf {
    project_root
        .join(super::project::STATE_DIR)
        .join(ANALYSIS_DIR)
}

fn features_path(project_root: &Path, machine_id: &str) -> PathBuf {
    analysis_dir(project_root).join(format!("features-{machine_id}.jsonl"))
}

/// 追加一条特征记录(每机一份纯追加;目录过落地闸)。
pub fn append_feature(
    project_root: &Path,
    machine_id: &str,
    rec: &FeatureRecord,
) -> Result<(), String> {
    let dir = analysis_dir(project_root);
    super::paths::ensure_dir_within(project_root, &dir)?;
    let path = features_path(project_root, machine_id);
    if super::paths::is_symlink(&path) {
        return Err("特征文件是符号链接,拒绝写入".into());
    }
    let mut line = serde_json::to_string(rec).map_err(|e| e.to_string())?;
    line.push('\n');
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    f.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

/// 读取合并全部机器的特征(版本全匹配才采信;同键冲突按计划 D4 规则)。
/// 返回 (指纹→记录, 坏行数, 目录读错)。R2 P1:`.ocard/analysis` 存在但
/// 不可读(NAS 抖动/权限)时以前静默返回空表——界面上全部 AI 角标凭空消失
/// 且零提示;现在把 IO 错误如实上浮,由命令层给可见 warning。
/// `NotFound` 仍是正常态(项目从未分析过)。
pub fn load_features(
    project_root: &Path,
) -> (
    std::collections::HashMap<u64, FeatureRecord>,
    usize,
    Option<String>,
) {
    let mut out: std::collections::HashMap<u64, FeatureRecord> = Default::default();
    let mut skipped = 0usize;
    let dir = analysis_dir(project_root);
    // R4(终审 P0-3):读路径 canonical 只读闸——`.ocard/analysis` 被换成链接时
    // 拒读并上浮(与写侧 ensure_dir_within 同源),绝不静默把外部特征注入
    if let Err(e) = super::paths::assert_within(project_root, &dir) {
        if dir.exists() {
            return (out, 0, Some(e));
        }
        return (out, 0, None); // 目录不存在=未分析过,正常态
    }
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (out, 0, None),
        Err(e) => return (out, 0, Some(format!("分析缓存目录不可读: {e}"))),
    };
    for e in entries {
        let Ok(e) = e else {
            skipped += 1; // R5:目录项错误不再静默 flatten
            continue;
        };
        let name = e.file_name().to_string_lossy().to_string();
        if !name.starts_with("features-") || !name.ends_with(".jsonl") {
            continue;
        }
        if super::paths::is_symlink(&e.path()) {
            skipped += 1; // R5:链接特征文件不读(防外部特征注入)
            continue;
        }
        let Ok(text) = std::fs::read_to_string(e.path()) else {
            skipped += 1;
            continue;
        };
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<FeatureRecord>(line) {
                Ok(rec)
                    if rec.schema_version == SCHEMA_VERSION && rec.algo_version == ALGO_VERSION =>
                {
                    match out.get(&rec.src_fingerprint) {
                        // R4/R5 终审 P0-9:**人脸信息等级优先于新鲜度**(双向对称,
                        // 与读入顺序无关):当前模型结果 > 旧模型结果 > 无信息;
                        // 等级相同才比新鲜度(analyzedAt 最新胜;持平 machineId
                        // 字典序大者胜,确定性)。
                        Some(cur) if faces_rank(cur) < faces_rank(&rec) => {
                            out.insert(rec.src_fingerprint, rec);
                        }
                        Some(cur) if faces_rank(&rec) < faces_rank(cur) => {}
                        Some(cur)
                            if (cur.analyzed_at, &cur.machine_id)
                                >= (rec.analyzed_at, &rec.machine_id) => {}
                        _ => {
                            out.insert(rec.src_fingerprint, rec);
                        }
                    }
                }
                Ok(_) => {} // 版本不匹配 = 视为未分析(会被重算),不算坏行
                Err(_) => skipped += 1,
            }
        }
    }
    (out, skipped, None)
}

// ---------- 单次解码的特征提取(纯函数) ----------

/// 从整图一次性提取全部特征(调用方负责唯一一次解码)。
pub fn extract_features(img: &image::DynamicImage) -> (u64, f32, f32, f32) {
    let gray_small = image::imageops::grayscale(&img.resize_exact(
        64,
        64,
        image::imageops::FilterType::Triangle,
    ));
    let dhash = dhash64(&gray_small);
    let (over, under) = exposure_fractions(&gray_small);
    let sharp = sharpness_center_crop(img);
    (dhash, sharp, over, under)
}

/// 9×8 差值哈希(灰度 64×64 再缩到 9×8;相邻像素比较出 64 bit)。
fn dhash64(gray64: &image::GrayImage) -> u64 {
    let g = image::imageops::resize(gray64, 9, 8, image::imageops::FilterType::Triangle);
    let mut bits: u64 = 0;
    let mut i = 0;
    for y in 0..8 {
        for x in 0..8 {
            if g.get_pixel(x, y)[0] > g.get_pixel(x + 1, y)[0] {
                bits |= 1 << i;
            }
            i += 1;
        }
    }
    bits
}

pub fn hamming(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

/// 过曝/欠曝占比(灰度直方图端部)。
fn exposure_fractions(gray: &image::GrayImage) -> (f32, f32) {
    let total = (gray.width() * gray.height()) as f32;
    if total == 0.0 {
        return (0.0, 0.0);
    }
    let mut over = 0u32;
    let mut under = 0u32;
    for p in gray.pixels() {
        let v = p[0];
        if v >= 250 {
            over += 1;
        } else if v <= 5 {
            under += 1;
        }
    }
    (over as f32 / total, under as f32 / total)
}

/// 归一化区域(如人脸框)的清晰度:裁块后按同一拉普拉斯口径计算。
/// 人脸在场时清晰度以最大脸区域为准(对焦在脸=可用,背景糊无妨)。
pub fn sharpness_region(img: &image::DynamicImage, x: f32, y: f32, w: f32, h: f32) -> f32 {
    let (iw, ih) = (img.width() as f32, img.height() as f32);
    // 外扩 20% 再裁,防框贴边切掉高频细节
    let ex = (w * 0.2).max(0.02);
    let ey = (h * 0.2).max(0.02);
    // 边界数学(评审 #23):先夹 x0 保证右侧至少 8px,再夹宽度,杜绝 clamp(min>max) panic
    let x0 = (((x - ex) * iw).max(0.0) as u32).min(img.width().saturating_sub(8));
    let y0 = (((y - ey) * ih).max(0.0) as u32).min(img.height().saturating_sub(8));
    let max_w = img.width() - x0;
    let max_h = img.height() - y0;
    let cw = (((w + 2.0 * ex) * iw) as u32)
        .clamp(1, max_w)
        .max(max_w.min(8));
    let ch = (((h + 2.0 * ey) * ih) as u32)
        .clamp(1, max_h)
        .max(max_h.min(8));
    laplacian_score(&image::imageops::grayscale(&img.crop_imm(x0, y0, cw, ch)))
}

/// 清晰度:原始分辨率中心裁块(≤512²)的拉普拉斯方差,log 压缩到 0-100 量级。
/// 在整图降采样上算会把糊片和清晰片抹平(计划 C3)。
fn sharpness_center_crop(img: &image::DynamicImage) -> f32 {
    let (w, h) = (img.width(), img.height());
    let cw = w.min(512);
    let ch = h.min(512);
    let x = (w - cw) / 2;
    let y = (h - ch) / 2;
    let crop = img.crop_imm(x, y, cw, ch);
    laplacian_score(&image::imageops::grayscale(&crop))
}

fn laplacian_score(gray: &image::GrayImage) -> f32 {
    let (gw, gh) = gray.dimensions();
    if gw < 3 || gh < 3 {
        return 0.0;
    }
    let mut sum = 0.0f64;
    let mut sum_sq = 0.0f64;
    let n = ((gw - 2) * (gh - 2)) as f64;
    for y in 1..gh - 1 {
        for x in 1..gw - 1 {
            let c = gray.get_pixel(x, y)[0] as f64;
            let lap = -4.0 * c
                + gray.get_pixel(x - 1, y)[0] as f64
                + gray.get_pixel(x + 1, y)[0] as f64
                + gray.get_pixel(x, y - 1)[0] as f64
                + gray.get_pixel(x, y + 1)[0] as f64;
            sum += lap;
            sum_sq += lap * lap;
        }
    }
    let mean = sum / n;
    let var = (sum_sq / n - mean * mean).max(0.0);
    // log 压缩:var 1→0,10⁴→~66,10⁶→100
    ((var + 1.0).log10() * 16.7).clamp(0.0, 100.0) as f32
}

// ---------- 聚类与荐优(查询时现算,确定性) ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetJudgement {
    pub group_id: Option<String>,
    /// 检出人脸数(None=分析时检测不可用)。
    pub faces: Option<u32>,
    pub score: f32,
    pub blurry: bool,
    pub over_exposed: bool,
    pub under_exposed: bool,
    /// 组内首选(荐优);无组时高分单张也不标(避免噪声)。
    pub suggested_keep: bool,
}

/// 输入:按拍摄时间排好序的 (rel, shot_at_epoch_secs, feature)。
/// 输出:rel → 判定。groupId 确定性:组首的 rel 的 xxh3。
pub fn judge(
    ordered: &[(String, Option<i64>, Option<FeatureRecord>)],
) -> std::collections::HashMap<String, AssetJudgement> {
    let mut out: std::collections::HashMap<String, AssetJudgement> = Default::default();
    // 分组:时间邻近 + dHash 相近(与前一张比较,链式成组)
    let mut groups: Vec<Vec<usize>> = Vec::new();
    for i in 0..ordered.len() {
        let can_chain = i > 0
            && match (&ordered[i - 1], &ordered[i]) {
                ((_, Some(t0), Some(f0)), (_, Some(t1), Some(f1))) => {
                    (t1 - t0).abs() <= BURST_GAP_SECS
                        && hamming(f0.dhash, f1.dhash) <= BURST_HAMMING_MAX
                }
                _ => false,
            };
        if can_chain {
            groups.last_mut().unwrap().push(i);
        } else {
            groups.push(vec![i]);
        }
    }
    for g in &groups {
        let group_id = if g.len() >= 2 {
            Some(format!(
                "g{:016x}",
                xxhash_rust::xxh3::xxh3_64(ordered[g[0]].0.as_bytes())
            ))
        } else {
            None
        };
        // 组内评分与荐优(确定性 tie-break:分数持平取 rel 字典序小者)
        let mut best: Option<(f32, &str)> = None;
        for &i in g {
            let (rel, _, feat) = &ordered[i];
            let (score, blurry, over, under) = match feat {
                Some(f) => {
                    let penalty = (f.over_exposed + f.under_exposed) * 40.0;
                    let score = (f.sharpness - penalty).clamp(0.0, 100.0);
                    (
                        score,
                        f.sharpness < 25.0,
                        f.over_exposed > 0.15,
                        f.under_exposed > 0.30,
                    )
                }
                None => (0.0, false, false, false),
            };
            if group_id.is_some() && feat.is_some() {
                match best {
                    Some((bs, brel))
                        if (bs, std::cmp::Reverse(brel))
                            >= (score, std::cmp::Reverse(rel.as_str())) => {}
                    _ => best = Some((score, rel.as_str())),
                }
            }
            out.insert(
                rel.clone(),
                AssetJudgement {
                    group_id: group_id.clone(),
                    faces: feat.as_ref().and_then(|f| f.faces),
                    score,
                    blurry,
                    over_exposed: over,
                    under_exposed: under,
                    suggested_keep: false,
                },
            );
        }
        if let Some((_, keep_rel)) = best {
            if let Some(j) = out.get_mut(keep_rel) {
                j.suggested_keep = true;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    /// R2 P1 接线回归:`.ocard/analysis` 存在但不可读(此处用文件占位模拟)
    /// 时必须上浮 read_err——此前静默返回空表,AI 角标凭空消失且零提示。
    /// 把 load_features 的 IO 错误分支改回静默空表本测试红。
    #[test]
    fn load_features_surfaces_unreadable_dir() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".ocard")).unwrap();
        std::fs::write(analysis_dir(tmp.path()), b"not-a-dir").unwrap();
        let (map, skipped, read_err) = load_features(tmp.path());
        assert!(map.is_empty());
        assert_eq!(skipped, 0);
        assert!(
            read_err.is_some_and(|e| e.contains("分析缓存目录不可读")),
            "目录读错必须如实上浮"
        );
        // NotFound 仍是正常态(从未分析过)
        let fresh = tempfile::tempdir().unwrap();
        assert!(load_features(fresh.path()).2.is_none());
    }

    fn feat(dhash: u64, sharp: f32) -> FeatureRecord {
        FeatureRecord {
            rel: String::new(),
            src_fingerprint: 0,
            schema_version: SCHEMA_VERSION,
            algo_version: ALGO_VERSION,
            dhash,
            sharpness: sharp,
            over_exposed: 0.0,
            under_exposed: 0.0,
            shot_at_epoch: None,
            faces: None,
            faces_model: None,
            analyzed_at: Utc::now(),
            machine_id: "M".into(),
        }
    }

    #[test]
    fn dhash_similarity_behaviour() {
        // 递减 vs 递增水平渐变:dHash 的相邻列比较给出全 1 vs 全 0 位串
        let falling = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(200, 150, |x, _| {
            let v = (255 - x * 255 / 200) as u8;
            image::Rgb([v, v, v])
        }));
        let (h1, _, _, _) = extract_features(&falling);
        let (h2, _, _, _) = extract_features(&falling);
        assert_eq!(h1, h2);
        let rising = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(200, 150, |x, _| {
            let v = (x * 255 / 200) as u8;
            image::Rgb([v, v, v])
        }));
        let (h3, _, _, _) = extract_features(&rising);
        assert!(
            hamming(h1, h3) > BURST_HAMMING_MAX,
            "结构不同的图必须拉开距离: {}",
            hamming(h1, h3)
        );
    }

    #[test]
    fn sharpness_separates_blur_from_detail() {
        // 高频纹理 vs 平滑渐变:清晰度分数必须显著分离(糊片检出的根)
        let sharp_img =
            image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(600, 600, |x, y| {
                let v = if (x / 2 + y / 2) % 2 == 0 { 0 } else { 255 };
                image::Rgb([v, v, v])
            }));
        let blurry_img =
            image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(600, 600, |x, _| {
                let v = (x * 255 / 600) as u8;
                image::Rgb([v, v, v])
            }));
        let (_, s1, _, _) = extract_features(&sharp_img);
        let (_, s2, _, _) = extract_features(&blurry_img);
        assert!(s1 > 60.0, "棋盘纹理应高分: {s1}");
        assert!(s2 < 25.0, "平滑渐变应低分: {s2}");
    }

    #[test]
    fn exposure_fractions_detect_clipping() {
        let over = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            100,
            100,
            image::Rgb([255, 255, 255]),
        ));
        let (_, _, o, u) = extract_features(&over);
        assert!(o > 0.9 && u < 0.01);
    }

    #[test]
    fn judge_groups_bursts_and_suggests_best() {
        let base = 1_000_000i64;
        let ordered = vec![
            ("a/1.jpg".to_string(), Some(base), Some(feat(0b1111, 80.0))),
            (
                "a/2.jpg".to_string(),
                Some(base + 1),
                Some(feat(0b1110, 95.0)),
            ),
            (
                "a/3.jpg".to_string(),
                Some(base + 2),
                Some(feat(0b1111, 60.0)),
            ),
            // 时间断裂:独立单张
            (
                "a/4.jpg".to_string(),
                Some(base + 100),
                Some(feat(0b1111, 99.0)),
            ),
            // 时间近但内容远:不并组
            (
                "a/5.jpg".to_string(),
                Some(base + 101),
                Some(feat(!0u64, 50.0)),
            ),
        ];
        let j = judge(&ordered);
        let g1 = j["a/1.jpg"].group_id.clone().expect("前三张应成组");
        assert_eq!(j["a/2.jpg"].group_id.as_ref(), Some(&g1));
        assert_eq!(j["a/3.jpg"].group_id.as_ref(), Some(&g1));
        assert!(j["a/2.jpg"].suggested_keep, "组内最清晰者荐优");
        assert!(!j["a/1.jpg"].suggested_keep && !j["a/3.jpg"].suggested_keep);
        assert!(j["a/4.jpg"].group_id.is_none(), "时间断裂不成组");
        assert!(j["a/5.jpg"].group_id.is_none(), "内容差异大不成组");
        assert!(!j["a/4.jpg"].suggested_keep, "无组单张不标荐优(避免噪声)");
    }

    #[test]
    fn judge_is_deterministic_across_machines() {
        let base = 0i64;
        let ordered = vec![
            ("x/1.jpg".to_string(), Some(base), Some(feat(1, 70.0))),
            ("x/2.jpg".to_string(), Some(base + 1), Some(feat(1, 70.0))),
        ];
        let a = judge(&ordered);
        let b = judge(&ordered);
        assert_eq!(
            serde_json::to_string(&a["x/1.jpg"]).unwrap(),
            serde_json::to_string(&b["x/1.jpg"]).unwrap()
        );
        // 分数持平:rel 字典序小者荐优(确定性 tie-break)
        assert!(a["x/1.jpg"].suggested_keep);
        assert!(!a["x/2.jpg"].suggested_keep);
    }

    #[test]
    fn feature_store_roundtrip_version_filter_and_conflict() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        std::fs::create_dir_all(&root).unwrap();
        let mut rec = feat(42, 55.0);
        rec.rel = "1. 待分类/a.jpg".into();
        rec.src_fingerprint = 777;
        append_feature(&root, "M1", &rec).unwrap();

        // 同键更新:analyzedAt 更新者胜
        let mut newer = rec.clone();
        newer.sharpness = 66.0;
        newer.analyzed_at = rec.analyzed_at + chrono::Duration::seconds(5);
        newer.machine_id = "M2".into();
        append_feature(&root, "M2", &newer).unwrap();

        // 版本不匹配的记录被无声过滤(视为未分析,不算坏行)
        let mut old = rec.clone();
        old.algo_version = ALGO_VERSION + 1;
        old.src_fingerprint = 888;
        append_feature(&root, "M1", &old).unwrap();

        // 坏行计数
        let p = features_path(&root, "M1");
        let mut text = std::fs::read_to_string(&p).unwrap();
        text.push_str("{corrupt\n");
        std::fs::write(&p, text).unwrap();

        let (map, skipped, _) = load_features(&root);
        assert_eq!(map.len(), 1);
        assert_eq!(map[&777].sharpness, 66.0, "冲突取最新");
        assert_eq!(skipped, 1);
    }

    /// R2 变异复核(P2-新1):旧冲突断言依赖 read_dir 的目录序,把规则改成
    /// 「先到先得」照样绿。现把新旧两条记录写进**同一个文件**,并两种行序
    /// 各验一遍——只有真按 (analyzedAt, machineId) 取最新才能双向通过。
    #[test]
    fn conflict_rule_is_order_independent_within_one_file() {
        for reversed in [false, true] {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path().join("proj");
            std::fs::create_dir_all(&root).unwrap();
            let mut older = feat(1, 11.0);
            older.rel = "1. 待分类/a.jpg".into();
            older.src_fingerprint = 999;
            let mut newer = older.clone();
            newer.sharpness = 22.0;
            newer.analyzed_at = older.analyzed_at + chrono::Duration::seconds(9);
            newer.machine_id = "MZ".into();
            let (first, second) = if reversed {
                (&newer, &older)
            } else {
                (&older, &newer)
            };
            append_feature(&root, "M1", first).unwrap();
            append_feature(&root, "M1", second).unwrap();
            let (map, _, _) = load_features(&root);
            assert_eq!(
                map[&999].sharpness, 22.0,
                "行序 reversed={reversed} 下也必须取 analyzedAt 最新"
            );
        }
    }

    /// R4 终审 P0-9:新记录无人脸信息不许覆盖旧记录的有效人脸(跨机上
    /// 「坏机器最新」不能抹掉好结果);cache_hit 在检测器在场时拒绝 None 命中。
    #[test]
    fn faces_none_never_overwrites_some_and_recomputes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        std::fs::create_dir_all(&root).unwrap();
        let mut with_faces = feat(1, 10.0);
        with_faces.rel = "1. 待分类/a.jpg".into();
        with_faces.src_fingerprint = 555;
        with_faces.faces = Some(2);
        with_faces.faces_model = Some("8f2383e4".into());
        append_feature(&root, "M1", &with_faces).unwrap();
        let mut newer_none = with_faces.clone();
        newer_none.faces = None;
        newer_none.faces_model = None;
        newer_none.analyzed_at = with_faces.analyzed_at + chrono::Duration::seconds(60);
        newer_none.machine_id = "MZ".into();
        append_feature(&root, "MZ", &newer_none).unwrap();
        let (map, _, _) = load_features(&root);
        assert_eq!(map[&555].faces, Some(2), "有人脸信息优先于新鲜度");

        assert!(cache_hit(&with_faces, true), "当前模型结果命中");
        assert!(!cache_hit(&newer_none, true), "检测器在场时 None 必须重算");
        assert!(
            cache_hit(&newer_none, false),
            "检测器缺席时 None 记录照常命中"
        );
        // R5:旧模型的 Some 不许命中(模型更换后必须重算),合并里也输给当前模型
        let mut old_model = with_faces.clone();
        old_model.faces_model = Some("deadbeef".into());
        old_model.analyzed_at = with_faces.analyzed_at + chrono::Duration::seconds(120);
        assert!(!cache_hit(&old_model, true), "旧模型结果必须重算");
        let tmp2 = tempfile::tempdir().unwrap();
        let root2 = tmp2.path().join("proj");
        std::fs::create_dir_all(&root2).unwrap();
        append_feature(&root2, "M1", &old_model).unwrap();
        append_feature(&root2, "M1", &with_faces).unwrap();
        let (map2, _, _) = load_features(&root2);
        assert_eq!(
            map2[&555].faces_model.as_deref(),
            Some(current_faces_model()),
            "当前模型结果在合并里胜过更新的旧模型结果"
        );
    }

    /// R2 变异复核(收敛 #23):sharpness_region 在极小图与贴边框上不得 panic,
    /// 且返回有限值。
    #[test]
    fn sharpness_region_survives_tiny_images_and_edge_rects() {
        for (w, h) in [(1u32, 1u32), (4, 4), (8, 3), (16, 16)] {
            let img = image::DynamicImage::new_rgb8(w, h);
            for (x, y, rw, rh) in [
                (0.0f32, 0.0f32, 1.0f32, 1.0f32),
                (0.95, 0.95, 0.2, 0.2), // 贴右下边、外扩越界
                (0.0, 0.0, 0.01, 0.01), // 近零宽高
                (0.5, 0.9, 1.0, 0.5),   // 高度越界
            ] {
                let v = sharpness_region(&img, x, y, rw, rh);
                assert!(v.is_finite(), "{w}x{h} rect=({x},{y},{rw},{rh}) → {v}");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn feature_append_refuses_symlinked_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        std::fs::create_dir_all(root.join(".ocard")).unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, analysis_dir(&root)).unwrap();
        let mut rec = feat(1, 1.0);
        rec.rel = "x".into();
        assert!(append_feature(&root, "M", &rec).is_err());
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
    }
}

#[cfg(test)]
mod bench {
    use super::*;

    /// 工程预验(非 SLA 证据;SLA 须用户提供真实素材,计划 W7):
    /// 合成 24MP JPEG 单张全流水线耗时 → 外推千张多核吞吐。
    /// 运行:`cargo test --release bench_single_24mp -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_single_24mp_pipeline() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("bench.jpg");
        // 带高频纹理的 6000×4000(避免纯色被编码器秒杀)
        let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(6000, 4000, |x, y| {
            image::Rgb([
                ((x * 7 + y * 3) % 256) as u8,
                ((x * 3) % 256) as u8,
                ((y * 5) % 256) as u8,
            ])
        }));
        img.save(&path).unwrap();
        let n = 8;
        let t0 = std::time::Instant::now();
        for _ in 0..n {
            let decoded = image::open(&path).unwrap();
            let _ = extract_features(&decoded);
        }
        let per = t0.elapsed().as_secs_f64() / n as f64;
        let cores = std::thread::available_parallelism()
            .map(|c| c.get())
            .unwrap_or(4);
        let est_1000 = per * 1000.0 / (cores.saturating_sub(1).max(1)) as f64;
        eprintln!("单张 24MP 全流水线 {per:.3}s;{cores} 核外推千张 ≈ {est_1000:.0}s(预算 300s)");
        assert!(
            est_1000 < 300.0,
            "工程预验超预算:外推千张 {est_1000:.0}s ≥ 300s"
        );
    }
}
