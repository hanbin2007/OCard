//! 设备与存储卡登记表(PRD §5.1):全 NAS 共享,
//! 底层为 `<NAS根>/.ocard-registry/` 下的多机事件日志,读取时折叠。
//! 序列化字段与前端契约(src/api/types.ts)一致:camelCase。

use super::journal::{self, kind, Event};
use super::{naming, CoreError, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const REGISTRY_DIR: &str = ".ocard-registry";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CameraReg {
    pub id: String,
    pub model: String,
    /// 机位 A–Z,单字母字符串(与前端契约一致)。
    pub position: String,
    pub operator_alias: String,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StorageCard {
    pub id: String,
    pub label: String,
    pub camera_id: String,
    pub capacity_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Registry {
    pub cameras: Vec<CameraReg>,
    pub cards: Vec<StorageCard>,
}

pub fn registry_dir(nas_root: &Path) -> PathBuf {
    nas_root.join(REGISTRY_DIR)
}

/// 新建相机登记:校验并生成规范编码,写入事件日志。
pub fn register_camera(
    nas_root: &Path,
    machine: &str,
    operator: &str,
    model: &str,
    position: &str,
    operator_alias: &str,
    note: Option<String>,
) -> Result<CameraReg> {
    let pos_char = single_position_char(position)?;
    let code = naming::camera_code(model, pos_char, operator_alias)?;
    let cam = CameraReg {
        id: uuid::Uuid::new_v4().to_string(),
        model: model.trim().to_string(),
        position: pos_char.to_string(),
        operator_alias: operator_alias.trim().to_string(),
        code,
        note,
        created_at: Utc::now(),
    };
    let ev = Event::new(
        machine,
        operator,
        kind::CAMERA_REGISTERED,
        serde_json::to_value(&cam)?,
    );
    journal::append_in(&registry_dir(nas_root), &ev)?;
    Ok(cam)
}

pub fn delete_camera(
    nas_root: &Path,
    machine: &str,
    operator: &str,
    camera_id: &str,
) -> Result<()> {
    // 级联:该相机名下的卡一并写删除事件,避免折叠后出现孤儿卡(评审 P1-12)
    let reg = load(nas_root)?.registry;
    for card in reg.cards.iter().filter(|c| c.camera_id == camera_id) {
        let ev = Event::new(
            machine,
            operator,
            kind::CARD_DELETED,
            serde_json::json!({ "id": card.id }),
        );
        journal::append_in(&registry_dir(nas_root), &ev)?;
    }
    let ev = Event::new(
        machine,
        operator,
        kind::CAMERA_DELETED,
        serde_json::json!({ "id": camera_id }),
    );
    journal::append_in(&registry_dir(nas_root), &ev)
}

pub fn register_card(
    nas_root: &Path,
    machine: &str,
    operator: &str,
    label: &str,
    camera_id: &str,
    capacity_bytes: u64,
    serial: Option<String>,
) -> Result<StorageCard> {
    if label.trim().is_empty() {
        return Err(CoreError::Invalid("卡标签不能为空".into()));
    }
    // 引用校验:卡必须挂在已登记的相机上(评审 P1-12)
    if !load(nas_root)?
        .registry
        .cameras
        .iter()
        .any(|c| c.id == camera_id)
    {
        return Err(CoreError::Invalid(format!("相机未登记: {camera_id}")));
    }
    let card = StorageCard {
        id: uuid::Uuid::new_v4().to_string(),
        label: label.trim().to_string(),
        camera_id: camera_id.to_string(),
        capacity_bytes,
        serial,
        created_at: Utc::now(),
    };
    let ev = Event::new(
        machine,
        operator,
        kind::CARD_REGISTERED,
        serde_json::to_value(&card)?,
    );
    journal::append_in(&registry_dir(nas_root), &ev)?;
    Ok(card)
}

pub fn delete_card(nas_root: &Path, machine: &str, operator: &str, card_id: &str) -> Result<()> {
    let ev = Event::new(
        machine,
        operator,
        kind::CARD_DELETED,
        serde_json::json!({ "id": card_id }),
    );
    journal::append_in(&registry_dir(nas_root), &ev)
}

/// 登记表读取结果:折叠状态 + journal 健康度(坏数据计数必须上报,UX 原则)。
#[derive(Debug)]
pub struct RegistryLoad {
    pub registry: Registry,
    pub skipped_lines: usize,
    pub unreadable_files: usize,
    /// 事件外壳合法但 payload 解析失败被忽略的条数(零静默原则)。
    pub skipped_payloads: usize,
}

/// 读取并折叠当前登记表(同 id 后写胜;删除事件移除)。
pub fn load(nas_root: &Path) -> Result<RegistryLoad> {
    let read = journal::read_all_in(&registry_dir(nas_root))?;
    let mut reg = Registry::default();
    let mut skipped_payloads = 0usize;
    for ev in read.events {
        match ev.kind.as_str() {
            kind::CAMERA_REGISTERED => match serde_json::from_value::<CameraReg>(ev.data) {
                Ok(cam) => {
                    reg.cameras.retain(|c| c.id != cam.id);
                    reg.cameras.push(cam);
                }
                Err(_) => skipped_payloads += 1,
            },
            kind::CAMERA_DELETED => match ev.data.get("id").and_then(|v| v.as_str()) {
                Some(id) => reg.cameras.retain(|c| c.id != id),
                None => skipped_payloads += 1,
            },
            kind::CARD_REGISTERED => match serde_json::from_value::<StorageCard>(ev.data) {
                Ok(card) => {
                    reg.cards.retain(|c| c.id != card.id);
                    reg.cards.push(card);
                }
                Err(_) => skipped_payloads += 1,
            },
            kind::CARD_DELETED => match ev.data.get("id").and_then(|v| v.as_str()) {
                Some(id) => reg.cards.retain(|c| c.id != id),
                None => skipped_payloads += 1,
            },
            _ => {}
        }
    }
    Ok(RegistryLoad {
        registry: reg,
        skipped_lines: read.skipped_lines,
        unreadable_files: read.unreadable_files,
        skipped_payloads,
    })
}

fn single_position_char(position: &str) -> Result<char> {
    let mut chars = position.trim().chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) => Ok(c.to_ascii_uppercase()),
        _ => Err(CoreError::Invalid(format!(
            "机位必须是单个字母 A–Z,收到: {position:?}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn register_and_load_roundtrip() {
        let tmp = tempdir().unwrap();
        let cam =
            register_camera(tmp.path(), "m1", "赵晋宇", "DJI Ronin 4D", "b", "ZS", None).unwrap();
        assert_eq!(cam.code, "DJIRonin4D_B_ZS");
        assert_eq!(cam.position, "B");

        let card = register_card(
            tmp.path(),
            "m1",
            "赵晋宇",
            "CFE-01",
            &cam.id,
            128_000_000_000,
            None,
        )
        .unwrap();

        let reg = load(tmp.path()).unwrap().registry;
        assert_eq!(reg.cameras, vec![cam]);
        assert_eq!(reg.cards, vec![card]);
    }

    #[test]
    fn delete_removes_from_fold() {
        let tmp = tempdir().unwrap();
        let cam = register_camera(tmp.path(), "m1", "ZS", "A7M4", "A", "ZS", None).unwrap();
        let card = register_card(tmp.path(), "m2", "LQ", "SD-01", &cam.id, 64_000, None).unwrap();
        delete_camera(tmp.path(), "m2", "LQ", &cam.id).unwrap();
        delete_card(tmp.path(), "m1", "ZS", &card.id).unwrap();

        let reg = load(tmp.path()).unwrap().registry;
        assert!(reg.cameras.is_empty());
        assert!(reg.cards.is_empty());
    }

    #[test]
    fn validation_errors() {
        let tmp = tempdir().unwrap();
        assert!(register_camera(tmp.path(), "m", "o", "A7M4", "AB", "ZS", None).is_err());
        assert!(register_camera(tmp.path(), "m", "o", "A7M4", "1", "ZS", None).is_err());
        assert!(register_card(tmp.path(), "m", "o", "  ", "cid", 1, None).is_err());
    }
}
