use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON 错误: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Invalid(String),
    #[error("目标已存在: {0}")]
    AlreadyExists(String),
}

pub type Result<T> = std::result::Result<T, CoreError>;
