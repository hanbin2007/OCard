pub mod analysis;
pub mod catalog;
pub mod config;
pub mod copy;
pub mod error;
pub mod ffmpeg;
pub mod fsx;
pub mod hash;
pub mod jobs;
pub mod journal;
pub mod machine;
pub mod manifest;
pub mod media;
pub mod naming;
pub mod packaging;
pub mod paths;
pub mod preview;
pub mod preview_ffmpeg;
pub mod preview_raw;
pub mod project;
/// 合成 RAW 样本(测试专用;接线侧的用例与集成用例共用一份构造器)
#[cfg(test)]
pub mod raw_fixture;
pub mod registry;
pub mod sorting;
pub mod transcode;
pub mod volumes;
pub mod yunet;

pub use error::{CoreError, Result};
