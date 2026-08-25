//! OB/GF 001—2026 命名规则的代码化。
//! 所有生成的文件夹/文件名必须在 Windows/macOS/Linux 三平台合法互通。

use super::{CoreError, Result};
use chrono::NaiveDate;

/// Windows 文件名非法字符(超集,同时覆盖 macOS 的 `:` 与 `/`)。
const ILLEGAL: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|'];

/// 清洗单个路径组件:替换非法字符为下划线,去除首尾空白与结尾的点。
pub fn sanitize_component(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if ILLEGAL.contains(&c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim();
    if trimmed.is_empty() {
        "_".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 相机编码:`型号_机位_使用者`,如 `DJIRonin4D_B_ZS`。
/// 清洗规则(与前端 src/lib/naming.ts 保持一致,以此处为权威):
/// 型号与使用者剔除空白/下划线/连字符;使用者的 ASCII 字母统一大写。
pub fn camera_code(model: &str, position: char, operator: &str) -> Result<String> {
    let position = position.to_ascii_uppercase();
    if !position.is_ascii_uppercase() {
        return Err(CoreError::Invalid(format!(
            "机位必须是大写字母 A–Z,收到: {position:?}"
        )));
    }
    let strip = |s: &str| -> String {
        sanitize_component(s)
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '_' && *c != '-')
            .collect()
    };
    let model = strip(model);
    let operator = strip(operator).to_uppercase();
    if model.is_empty() || model == "_" {
        return Err(CoreError::Invalid("相机型号不能为空".into()));
    }
    if operator.is_empty() || operator == "_" {
        return Err(CoreError::Invalid("使用者代称不能为空".into()));
    }
    Ok(format!("{model}_{position}_{operator}"))
}

/// 项目文件夹名:`YYYYMMDD_项目名`,如 `20240101_XXX会议`。
pub fn project_folder_name(date: NaiveDate, name: &str) -> Result<String> {
    let name = sanitize_component(name);
    if name == "_" {
        return Err(CoreError::Invalid("项目名不能为空".into()));
    }
    Ok(format!("{}_{}", date.format("%Y%m%d"), name))
}

/// 工况 A 拷卡目标文件夹名:`YYYYMMDD_相机编码`(置于「2. 原始素材」下)。
pub fn card_folder_name_a(date: NaiveDate, camera_code: &str) -> String {
    format!("{}_{}", date.format("%Y%m%d"), camera_code)
}

/// 工况 B 拷卡目标文件夹名:`时段_相机编码`(置于「1. 待分类」下),
/// 时段如 `0101上午`。时段内部空白剔除(与前端预览一致)。
pub fn card_folder_name_b(period: &str, camera_code: &str) -> Result<String> {
    let period: String = sanitize_component(period)
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    if period.is_empty() || period == "_" {
        return Err(CoreError::Invalid("时段不能为空".into()));
    }
    Ok(format!("{period}_{camera_code}"))
}

/// 校验并规整工况 A 的日期前缀(必须是合法 `YYYYMMDD`)。
pub fn validate_date_prefix(prefix: &str) -> Result<String> {
    let p = prefix.trim();
    if NaiveDate::parse_from_str(p, "%Y%m%d").is_err() {
        return Err(CoreError::Invalid(format!(
            "工况 A 的目标夹前缀必须是 YYYYMMDD 日期,收到: {prefix:?}"
        )));
    }
    Ok(p.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn sanitize_replaces_illegal_and_trims() {
        assert_eq!(sanitize_component("a/b:c*d"), "a_b_c_d");
        assert_eq!(sanitize_component("  校运会照片。。"), "校运会照片。。");
        assert_eq!(sanitize_component(" name. "), "name");
        assert_eq!(sanitize_component("???"), "___");
        assert_eq!(sanitize_component("   "), "_");
    }

    #[test]
    fn camera_code_matches_spec_example_and_frontend_rules() {
        assert_eq!(
            camera_code("DJI Ronin 4D", 'B', "ZS").unwrap(),
            "DJIRonin4D_B_ZS"
        );
        assert_eq!(
            camera_code("A7M4", 'A', "李_启轩").unwrap(),
            "A7M4_A_李启轩"
        );
        // 与前端清洗规则对齐:小写机位/代称统一大写、连字符剔除
        assert_eq!(camera_code("A7-M4", 'a', "zs").unwrap(), "A7M4_A_ZS");
    }

    #[test]
    fn camera_code_rejects_bad_position() {
        assert!(camera_code("A7M4", '1', "ZS").is_err());
        assert!(camera_code("A7M4", '中', "ZS").is_err());
        assert!(camera_code("", 'A', "ZS").is_err());
    }

    #[test]
    fn date_prefix_validation() {
        assert_eq!(validate_date_prefix("20260824").unwrap(), "20260824");
        assert!(validate_date_prefix("0824上午").is_err());
        assert!(validate_date_prefix("20261341").is_err());
    }

    #[test]
    fn project_folder_name_matches_spec_example() {
        assert_eq!(
            project_folder_name(date("2024-01-01"), "XXX会议").unwrap(),
            "20240101_XXX会议"
        );
        assert!(project_folder_name(date("2024-01-01"), "  ").is_err());
    }

    #[test]
    fn card_folder_names() {
        assert_eq!(
            card_folder_name_a(date("2024-01-01"), "DJIRonin4D_B_ZS"),
            "20240101_DJIRonin4D_B_ZS"
        );
        assert_eq!(
            card_folder_name_b("0101上午", "DJIRonin4D_B_ZS").unwrap(),
            "0101上午_DJIRonin4D_B_ZS"
        );
        assert!(card_folder_name_b("  ", "X_A_Y").is_err());
    }
}

// ---------- 成片命名校验(M3 W8,PRD §5.8) ----------

/// 成片命名 grammar(计划 W8,无歧义化):
/// `日期_片名_分辨率_用途_版本[.扩展名]`,下划线分隔;
/// **从右往左取**后三段(分辨率/用途/版本),最左一段是日期,
/// 中间全部(可含下划线)是片名——「下划线片名规则」由此消解歧义。
/// - 日期:YYYYMMDD 且为有效日期;
/// - 分辨率 token 表:720P/1080P/2K/4K/8K(大小写不敏感);
///   720P=预览版,其余=成品(PRD:识别 720p 预览与 4K 成品);
/// - 用途:非空(规范未枚举,不做白名单);
/// - 版本:`V数字`(大小写不敏感)。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalCutName {
    pub date: String,
    pub title: String,
    pub resolution: String,
    pub purpose: String,
    pub version: String,
    /// "preview"(720P)| "final"(其余)。
    pub class: &'static str,
    /// 命名分辨率对应的期望像素高(ffprobe 交叉核对用)。
    pub expected_height: u32,
}

/// 分辨率 token 表(canonical 名, 期望高)。
const RESOLUTIONS: &[(&str, u32)] = &[
    ("720P", 720),
    ("1080P", 1080),
    ("2K", 1080),
    ("4K", 2160),
    ("8K", 4320),
];

/// 解析成片文件名;Err 内是逐条人话理由(标黄提示直接展示)。
pub fn parse_final_cut(file_name: &str) -> std::result::Result<FinalCutName, Vec<String>> {
    let stem = file_name
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(file_name);
    let parts: Vec<&str> = stem.split('_').collect();
    let mut issues = Vec::new();
    if parts.len() < 5 {
        issues.push(format!(
            "段数不足:应为「日期_片名_分辨率_用途_版本」至少 5 段,实际 {} 段",
            parts.len()
        ));
        return Err(issues);
    }
    let date = parts[0];
    let version = parts[parts.len() - 1];
    let purpose = parts[parts.len() - 2];
    let resolution = parts[parts.len() - 3];
    let title = parts[1..parts.len() - 3].join("_");

    if date.len() != 8
        || !date.bytes().all(|b| b.is_ascii_digit())
        || chrono::NaiveDate::parse_from_str(date, "%Y%m%d").is_err()
    {
        issues.push(format!("日期段「{date}」不是有效的 YYYYMMDD"));
    }
    if title.trim().trim_matches('_').is_empty() {
        issues.push("片名为空(或只含下划线)".into());
    }
    let res_upper = resolution.to_ascii_uppercase();
    let res_entry = RESOLUTIONS.iter().find(|(r, _)| *r == res_upper);
    if res_entry.is_none() {
        issues.push(format!(
            "分辨率段「{resolution}」不在允许表(720P/1080P/2K/4K/8K)"
        ));
    }
    if purpose.trim().is_empty() {
        issues.push("用途段为空".into());
    }
    let vu = version.to_ascii_uppercase();
    if !(vu.starts_with('V') && vu.len() > 1 && vu[1..].bytes().all(|b| b.is_ascii_digit())) {
        issues.push(format!("版本段「{version}」应为 V+数字(如 V1)"));
    }
    if !issues.is_empty() {
        return Err(issues);
    }
    let (canon, height) = res_entry.unwrap();
    Ok(FinalCutName {
        date: date.to_string(),
        title,
        resolution: canon.to_string(),
        purpose: purpose.to_string(),
        version: vu,
        class: if *canon == "720P" { "preview" } else { "final" },
        expected_height: *height,
    })
}

/// 实际分辨率交叉核对(计划 E9:「名字写 4K 实际 1080」才是真正值得抓的错)。
/// 容差 ±10%;竖幅视频按较小边比对由调用方先行处理。
pub fn resolution_mismatch(parsed: &FinalCutName, actual_height: u32) -> Option<String> {
    let expect = parsed.expected_height as f64;
    let actual = actual_height as f64;
    if (actual - expect).abs() / expect > 0.10 {
        Some(format!(
            "命名为 {}(期望约 {} 像素高),实际 {} 像素",
            parsed.resolution, parsed.expected_height, actual_height
        ))
    } else {
        None
    }
}

#[cfg(test)]
mod final_cut_tests {
    use super::*;

    #[test]
    fn parse_matrix() {
        let ok = parse_final_cut("20260824_校运会开幕式_4K_成片_V2.mp4").unwrap();
        assert_eq!(ok.title, "校运会开幕式");
        assert_eq!(ok.resolution, "4K");
        assert_eq!(ok.class, "final");
        assert_eq!(ok.version, "V2");

        // 片名含下划线:从右取段消解歧义
        let ok2 = parse_final_cut("20260824_校运会_上午_开幕式_720p_预览_v1.mov").unwrap();
        assert_eq!(ok2.title, "校运会_上午_开幕式");
        assert_eq!(ok2.class, "preview");
        assert_eq!(ok2.resolution, "720P");

        for bad in [
            "校运会_4K_成片_V1.mp4",         // 缺日期(段数不足)
            "20261399_片_4K_成片_V1.mp4",    // 无效日期
            "20260824_片_5K_成片_V1.mp4",    // 分辨率不在表
            "20260824_片_4K_成片_版本1.mp4", // 版本格式错
            "随便起名.mp4",                  // 完全不合规
        ] {
            assert!(parse_final_cut(bad).is_err(), "{bad} 应判不合规");
        }
        // 逐条理由是人话
        let issues = parse_final_cut("20261399_片_5K_成片_X1.mp4").unwrap_err();
        assert!(issues.len() >= 3, "{issues:?}");
    }

    #[test]
    fn resolution_cross_check() {
        let p = parse_final_cut("20260824_片_4K_成片_V1.mp4").unwrap();
        assert!(resolution_mismatch(&p, 2160).is_none());
        assert!(resolution_mismatch(&p, 2000).is_none(), "±10% 容差内");
        let m = resolution_mismatch(&p, 1080).unwrap();
        assert!(m.contains("4K") && m.contains("1080"));
    }
}
