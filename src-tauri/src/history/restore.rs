//! Reading files of a snapshot and bringing the project (or one part) back to it.

use std::path::Path;

use crate::project::ProjectSnapshot;

pub fn read_part(_dir: &Path, _id: &str, _file: &str) -> Result<String, String> {
    Err("Version history is not available yet".into())
}

pub fn restore(_dir: &Path, _id: &str) -> Result<ProjectSnapshot, String> {
    Err("Version history is not available yet".into())
}

pub fn restore_part(_dir: &Path, _id: &str, _file: &str) -> Result<ProjectSnapshot, String> {
    Err("Version history is not available yet".into())
}
