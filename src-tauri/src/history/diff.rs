//! Comparing snapshots: word diff of parts, plain-language changes of `paper.json` and `refs.bib`.

use std::path::Path;

use super::VersionDiff;

pub fn diff(_dir: &Path, _from: &str, _to: Option<&str>) -> Result<VersionDiff, String> {
    Err("Version history is not available yet".into())
}
