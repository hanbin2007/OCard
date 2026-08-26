//! 项目目录扫描:遍历 NAS 根,凡含 `.ocard/project.json` 的一级子目录即项目,
//! 并从 manifest 汇总拷卡统计。

use super::manifest;
use super::project::{self, ProjectMeta};
use super::Result;
use chrono::{DateTime, Utc};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct ProjectStats {
    pub root: PathBuf,
    pub folder_name: String,
    pub meta: ProjectMeta,
    /// 已完成(全部校验通过)的拷卡任务数。
    pub cards_copied: usize,
    /// 是否存在未完成的拷卡任务。
    pub has_incomplete_copy: bool,
    pub bytes_copied: u64,
    pub asset_count: usize,
    /// 本项目已发起过的拷卡任务(manifest)总数。
    pub manifest_count: usize,
    /// 各次拷卡的最大目的地数(0 表示还没拷过)。
    pub destination_max: usize,
    /// 项目用卡清单(登记卡 id;UX 波三):journal 折叠结果。
    /// None = 从未配置也从未自动记录——x/y 无从谈起,回退按次数显示。
    pub card_roster: Option<Vec<String>>,
    /// 已完成拷卡的来源身份(指纹优先,卷名兜底),供命令层映射到登记卡。
    pub completed_sources: Vec<CopySource>,
    pub updated_at: DateTime<Utc>,
}

/// 一次已完成拷卡的来源识别信息。
#[derive(Debug, Clone)]
pub struct CopySource {
    pub volume_name: String,
    pub source_uid: Option<String>,
}

/// 扫描结果:项目列表 + 需要上报用户的告警(UX 原则:跳过不允许静默)。
#[derive(Debug, Default, Clone)]
pub struct CatalogScan {
    pub projects: Vec<ProjectStats>,
    /// 疑似项目但元数据损坏/不可读的目录(有 .ocard 却解析失败)。
    pub warnings: Vec<String>,
}

/// 短 TTL 扫描缓存(M3 W3):同一 NAS 根 2 秒内的重复扫描直接复用——
/// 命令层每次调用都全 NAS 扫描的成本(M2 评审 M7)由此消化。
/// 计划的逐项目指纹条款收窄为纯 TTL(评审复核后修正理由:统计确实全部来自
/// manifests,指纹在技术上可行;真实取舍是**简单性**——TTL 把一切陈旧
/// (含跨机写入)硬性封顶在 2 秒且无指纹失效的正确性风险;指纹留作后续
/// 性能优化项)。本机变更命令调 [`invalidate_cache`] 立即失效。
/// opus 复审已裁决接受该收窄。
type ScanCacheMap = std::collections::HashMap<PathBuf, (std::time::Instant, CatalogScan)>;
static SCAN_CACHE: std::sync::Mutex<Option<ScanCacheMap>> = std::sync::Mutex::new(None);
const SCAN_TTL_MS: u128 = 2000;

/// 本机变更(建项目/拷卡落盘/分类操作)后按 NAS 根失效,下次访问重扫。
pub fn invalidate_cache(nas_root: &Path) {
    if let Some(map) = SCAN_CACHE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_mut()
    {
        map.remove(nas_root);
    }
}

/// 带缓存的扫描:命令层一律走这里;需要绕过缓存的测试用 [`scan`]。
pub fn scan_cached(nas_root: &Path) -> Result<CatalogScan> {
    {
        let cache = SCAN_CACHE.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((at, scan)) = cache.as_ref().and_then(|m| m.get(nas_root)) {
            if at.elapsed().as_millis() < SCAN_TTL_MS {
                return Ok(scan.clone());
            }
        }
    }
    let fresh = scan(nas_root)?;
    SCAN_CACHE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_or_insert_with(Default::default)
        .insert(
            nas_root.to_path_buf(),
            (std::time::Instant::now(), fresh.clone()),
        );
    Ok(fresh)
}

/// 扫描 NAS 根下的全部项目(仅一级子目录)。
/// 普通目录(无 .ocard)正常跳过;**有 .ocard 但元数据坏掉的目录进 warnings**。
pub fn scan(nas_root: &Path) -> Result<CatalogScan> {
    let mut out = CatalogScan::default();
    if !nas_root.exists() {
        // 零静默:配置了 NAS 根但路径不可达,不能伪装成「零项目」
        out.warnings.push(format!(
            "NAS 根路径不存在或不可达: {}(项目列表为空可能并非真实状态)",
            nas_root.display()
        ));
        return Ok(out);
    }
    for entry in fs::read_dir(nas_root)? {
        let entry = entry?;
        let path = entry.path();
        // R4(终审 P0-3):项目目录不许是符号链接——NAS 外的「OCard 形状」目录
        // 经链接混入项目列表,是后续一切状态读写的锚点污染;跳过并可见
        match entry.file_type() {
            Ok(t) if t.is_symlink() => {
                out.warnings
                    .push(format!("跳过符号链接目录(不作为项目): {}", path.display()));
                continue;
            }
            Ok(t) if !t.is_dir() => continue,
            Ok(_) => {}
            Err(e) => {
                out.warnings.push(format!(
                    "目录项类型读取失败,已跳过: {}({e})",
                    path.display()
                ));
                continue;
            }
        }
        let Ok(meta) = project::load_meta(&path) else {
            if path.join(project::STATE_DIR).exists() {
                out.warnings.push(format!(
                    "目录「{}」含 .ocard 状态但项目元数据损坏或不可读,已跳过",
                    path.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default()
                ));
            }
            continue;
        };
        let folder = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let manifests = match manifest::list(&path) {
            Ok(list) => {
                if list.skipped > 0 {
                    out.warnings.push(format!(
                        "项目「{folder}」有 {} 份拷卡清单损坏或不可读,统计与续传可能不完整",
                        list.skipped
                    ));
                }
                list.manifests
            }
            Err(e) => {
                out.warnings
                    .push(format!("项目「{folder}」的拷卡清单目录不可读: {e}"));
                Vec::new()
            }
        };
        let cards_copied = manifests.iter().filter(|m| m.completed).count();
        let has_incomplete_copy = manifests.iter().any(|m| !m.completed);
        let bytes_copied = manifests
            .iter()
            .flat_map(|m| &m.entries)
            .filter(|e| e.verified)
            .map(|e| e.size)
            .sum();
        let asset_count = manifests
            .iter()
            .flat_map(|m| &m.entries)
            .filter(|e| e.verified)
            .count();
        let updated_at = manifests
            .iter()
            .map(|m| m.created_at)
            .max()
            .unwrap_or(meta.created_at);
        let manifest_count = manifests.len();
        let completed_sources: Vec<CopySource> = manifests
            .iter()
            .filter(|m| m.completed)
            .map(|m| CopySource {
                volume_name: m.source_label.clone(),
                source_uid: m.source_uid.clone(),
            })
            .collect();
        // 用卡清单:项目 journal 按时序折叠(set 整体替换,used 增量并入)。
        // 读失败进 warnings(零静默),清单按「未配置」处理。
        let card_roster: Option<Vec<String>> = match crate::core::journal::read_all(&path) {
            Ok(read) => {
                // 半损也要出声:最新的清单设定可能恰好在坏行里(零静默铁律)
                if read.skipped_lines > 0 || read.unreadable_files > 0 {
                    out.warnings.push(format!(
                        "项目「{folder}」日志有损坏数据(跳过 {} 行、{} 个文件),用卡清单可能不完整",
                        read.skipped_lines, read.unreadable_files
                    ));
                }
                let mut roster: Option<Vec<String>> = None;
                for ev in &read.events {
                    match ev.kind.as_str() {
                        crate::core::journal::kind::PROJECT_CARDS_SET => {
                            // 载荷坏了 = 未知,不是空清单:跳过该事件并出声,
                            // 保留上一次有效设定(未知折成零同样是假话)
                            match ev.data.get("cardIds").and_then(|v| v.as_array()) {
                                Some(a) => {
                                    roster = Some(
                                        a.iter()
                                            .filter_map(|x| x.as_str().map(str::to_string))
                                            .collect(),
                                    );
                                }
                                None => out.warnings.push(format!(
                                    "项目「{folder}」的用卡清单事件载荷损坏,已跳过该条设定"
                                )),
                            }
                        }
                        crate::core::journal::kind::PROJECT_CARD_USED
                        | crate::core::journal::kind::PROJECT_CARD_ADDED => {
                            if let Some(id) = ev.data.get("cardId").and_then(|v| v.as_str()) {
                                let r = roster.get_or_insert_with(Vec::new);
                                if !r.iter().any(|x| x == id) {
                                    r.push(id.to_string());
                                }
                            }
                        }
                        _ => {}
                    }
                }
                roster
            }
            Err(e) => {
                out.warnings.push(format!(
                    "项目「{folder}」的日志不可读,用卡清单按未配置处理: {e}"
                ));
                None
            }
        };
        let destination_max = manifests
            .iter()
            .map(|m| m.destinations.len())
            .max()
            .unwrap_or(0);
        out.projects.push(ProjectStats {
            folder_name: folder,
            root: path,
            meta,
            cards_copied,
            has_incomplete_copy,
            bytes_copied,
            asset_count,
            manifest_count,
            destination_max,
            card_roster,
            completed_sources,
            updated_at,
        });
    }
    out.projects.sort_by(|a, b| {
        b.meta
            .date
            .cmp(&a.meta.date)
            .then(a.folder_name.cmp(&b.folder_name))
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::manifest::{CopyManifest, ManifestEntry};
    use crate::core::project::Scenario;
    use chrono::NaiveDate;
    use tempfile::tempdir;

    #[test]
    fn scan_finds_projects_and_aggregates_manifests() {
        let tmp = tempdir().unwrap();
        let d1 = NaiveDate::from_ymd_opt(2026, 8, 24).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2026, 8, 20).unwrap();
        let p1 = project::create_project(tmp.path(), d1, "校运会", Scenario::B, &["比赛".into()])
            .unwrap();
        project::create_project(tmp.path(), d2, "开学典礼", Scenario::A, &[]).unwrap();
        // 干扰项:普通目录不算项目
        fs::create_dir_all(tmp.path().join("随便一个文件夹")).unwrap();

        let mut m = CopyManifest::new(
            "1. 待分类/0824上午_A7M4_A_ZS",
            "SD01",
            "A7M4_A_ZS",
            "ZS",
            "",
        );
        m.upsert(ManifestEntry {
            rel_path: "a.jpg".into(),
            size: 100,
            xxh3: "aa".into(),
            verified: true,
        });
        m.upsert(ManifestEntry {
            rel_path: "b.jpg".into(),
            size: 50,
            xxh3: String::new(),
            verified: false,
        });
        m.completed = false;
        manifest::save(&p1, &m).unwrap();

        let stats = scan(tmp.path()).unwrap().projects;
        assert_eq!(stats.len(), 2);
        // 按日期倒序:校运会(0824)在前
        assert_eq!(stats[0].folder_name, "20260824_校运会");
        assert_eq!(stats[0].cards_copied, 0);
        assert!(stats[0].has_incomplete_copy);
        assert_eq!(stats[0].bytes_copied, 100);
        assert_eq!(stats[0].asset_count, 1);
        assert_eq!(stats[1].folder_name, "20260820_开学典礼");
        assert_eq!(stats[1].asset_count, 0);
    }
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn cached_scan_reuses_until_invalidated() {
        let tmp = tempdir().unwrap();
        let nas = tmp.path();
        let date = chrono::NaiveDate::from_ymd_opt(2026, 8, 24).unwrap();
        project::create_project(nas, date, "缓存一", project::Scenario::B, &[]).unwrap();
        invalidate_cache(nas);
        assert_eq!(scan_cached(nas).unwrap().projects.len(), 1);

        // TTL 内直接在磁盘上加项目:缓存仍旧(陈旧封顶 2s 的声明语义)
        project::create_project(nas, date, "缓存二", project::Scenario::B, &[]).unwrap();
        assert_eq!(
            scan_cached(nas).unwrap().projects.len(),
            1,
            "TTL 内复用缓存"
        );

        // 本机变更钩子失效后立即可见
        invalidate_cache(nas);
        assert_eq!(scan_cached(nas).unwrap().projects.len(), 2);

        // 换根不串缓存
        let tmp2 = tempdir().unwrap();
        assert_eq!(scan_cached(tmp2.path()).unwrap().projects.len(), 0);
    }

    #[test]
    fn worker_and_config_switch_invalidation_paths() {
        // W3 复审欠账:worker 失效钩子等价路径 + 配置切根路径都要有测试
        let tmp = tempdir().unwrap();
        let nas = tmp.path();
        let date = chrono::NaiveDate::from_ymd_opt(2026, 8, 24).unwrap();
        project::create_project(nas, date, "甲", project::Scenario::B, &[]).unwrap();
        invalidate_cache(nas);
        assert_eq!(scan_cached(nas).unwrap().projects.len(), 1);

        // 模拟拷卡 worker 收尾:project_root.parent() 失效(tasks.rs 同一调用形状)
        let proot = nas.join(scan_cached(nas).unwrap().projects[0].folder_name.clone());
        project::create_project(nas, date, "乙", project::Scenario::B, &[]).unwrap();
        invalidate_cache(proot.parent().unwrap());
        assert_eq!(
            scan_cached(nas).unwrap().projects.len(),
            2,
            "worker 路径失效生效"
        );

        // 配置切根:两根缓存互不污染,来回切都各自正确
        let tmp2 = tempdir().unwrap();
        let nas2 = tmp2.path();
        project::create_project(nas2, date, "丙", project::Scenario::B, &[]).unwrap();
        invalidate_cache(nas2);
        assert_eq!(scan_cached(nas2).unwrap().projects.len(), 1);
        assert_eq!(
            scan_cached(nas).unwrap().projects.len(),
            2,
            "切回原根仍正确"
        );
    }

    /// R4 终审 P0-3:符号链接目录不作为项目(NAS 外的 OCard 形状目录经链接
    /// 混入=状态锚点污染),必须跳过并给可见警告。
    #[cfg(unix)]
    #[test]
    fn symlinked_project_dir_is_skipped_with_warning() {
        let tmp = tempfile::tempdir().unwrap();
        let nas = tmp.path().join("nas");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&nas).unwrap();
        // NAS 外造一个「合法项目形状」目录
        let date = chrono::NaiveDate::from_ymd_opt(2026, 8, 25).unwrap();
        let real = super::super::project::create_project(
            &outside,
            date,
            "外部",
            super::super::project::Scenario::B,
            &["开幕式".into()],
        )
        .unwrap();
        let name = real.file_name().unwrap();
        std::os::unix::fs::symlink(&real, nas.join(name)).unwrap();
        let scan = scan(&nas).unwrap();
        assert!(
            scan.projects.is_empty(),
            "链接项目不得入列: {:?}",
            scan.projects
                .iter()
                .map(|p| &p.folder_name)
                .collect::<Vec<_>>()
        );
        assert!(
            scan.warnings.iter().any(|w| w.contains("符号链接")),
            "跳过必须可见: {:?}",
            scan.warnings
        );
    }
}
