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
