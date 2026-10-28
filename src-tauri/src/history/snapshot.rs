//! Autosaves and versions: trees from the working copy, commit messages and trailers.

use std::path::Path;

use super::VersionInfo;

pub fn autosave(_dir: &Path, _reason: Option<&str>) -> Result<Option<VersionInfo>, String> {
    Ok(None)
}

pub fn save_version(
    _dir: &Path,
    _label: Option<&str>,
    _note: Option<&str>,
    _reason: Option<&str>,
) -> Result<Option<VersionInfo>, String> {
    Err("Version history is not available yet".into())
}
