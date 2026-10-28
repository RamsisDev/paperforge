//! The timeline: versions and autosaves merged by time, with milestone names.

use std::path::Path;

use super::VersionInfo;

pub fn list(_dir: &Path, _include_autosaves: bool, _before: Option<&str>, _limit: usize) -> Result<Vec<VersionInfo>, String> {
    Err("Version history is not available yet".into())
}

pub fn label(_dir: &Path, _id: &str, _label: Option<&str>) -> Result<VersionInfo, String> {
    Err("Version history is not available yet".into())
}
