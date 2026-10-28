//! Discovering, creating and adopting the project's repository.

use std::path::Path;

use super::{HistoryStatus, RepoMode};

pub fn status(_dir: &Path) -> Result<HistoryStatus, String> {
    Ok(HistoryStatus { enabled: false, mode: RepoMode::None, branch: None, dirty: false, last_version: None, remote: None })
}

pub fn enable(_dir: &Path, _summary: &str) -> Result<HistoryStatus, String> {
    Err("Version history is not available yet".into())
}
