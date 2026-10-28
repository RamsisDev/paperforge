//! Paragraph and character styles: a Pandoc div (`::: {.note}`) or span (`[x]{.smallcaps}`)
//! whose class names a style of `paper.json` becomes that style's LaTeX environment or command,
//! defined in the preamble.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StyleKind {
    Paragraph,
    Character,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Style {
    /// The div or span class.
    pub name: String,
    pub kind: StyleKind,
    /// LaTeX around `#1`, which stands for the styled text.
    pub latex: String,
}

/// Pandoc metadata naming the styled classes for `paper.lua`: `div:note span:smallcaps`.
pub const METADATA_KEY: &str = "pf-styles";

const ENVIRONMENT_PREFIX: &str = "pf-";
const COMMAND_PREFIX: &str = "pfstyle";

/// Lowercase words joined by single hyphens, so the class reads the same in Pandoc's Markdown,
/// in its metadata (no `--` dashes) and in a LaTeX environment name.
fn valid_name(name: &str) -> bool {
    name.starts_with(|c: char| c.is_ascii_lowercase())
        && name.split('-').all(|w| !w.is_empty() && w.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()))
}

pub fn environment_name(name: &str) -> String {
    format!("{ENVIRONMENT_PREFIX}{name}")
}

/// Control words are letters only: digits become `A`..`J` and hyphens `Z`, which a lowercase
/// name cannot contain, so different names never share a command. `paper.lua` does the same.
pub fn command_name(name: &str) -> String {
    let encoded: String = name
        .chars()
        .map(|c| match c {
            '0'..='9' => char::from(b'A' + (c as u8 - b'0')),
            '-' => 'Z',
            c => c,
        })
        .collect();
    format!("\\{COMMAND_PREFIX}{encoded}")
}

pub fn validate(styles: &[Style]) -> Result<(), String> {
    for (i, style) in styles.iter().enumerate() {
        let name = &style.name;
        if !valid_name(name) {
            return Err(format!(
                "'{name}' is not a valid style name: use lowercase letters and digits, words joined by single hyphens"
            ));
        }
        if styles[..i].iter().any(|s| s.name == *name) {
            return Err(format!("There are two styles named '{name}'"));
        }
        let holes = style.latex.matches("#1").count();
        if holes == 0 || (style.kind == StyleKind::Paragraph && holes > 1) {
            let times = if style.kind == StyleKind::Paragraph { "once" } else { "at least once" };
            return Err(format!("The LaTeX of style '{name}' must contain #1, where the text goes, {times}"));
        }
    }
    Ok(())
}

/// The preamble lines defining every style.
pub fn definitions(styles: &[Style]) -> String {
    let mut out = String::new();
    for style in styles {
        let latex = style.latex.trim();
        match style.kind {
            StyleKind::Paragraph => {
                let (begin, end) = latex.split_once("#1").unwrap_or((latex, ""));
                out.push_str(&format!(
                    "\\newenvironment{{{}}}{{{}}}{{{}}}\n",
                    environment_name(&style.name),
                    begin.trim(),
                    end.trim()
                ));
            }
            StyleKind::Character => {
                out.push_str(&format!("\\newcommand{{{}}}[1]{{{latex}}}\n", command_name(&style.name)));
            }
        }
    }
    out
}

/// The value of [`METADATA_KEY`]; empty without styles.
pub fn metadata(styles: &[Style]) -> String {
    styles
        .iter()
        .map(|s| format!("{}:{}", if s.kind == StyleKind::Paragraph { "div" } else { "span" }, s.name))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn style(name: &str, kind: StyleKind, latex: &str) -> Style {
        Style { name: name.into(), kind, latex: latex.into() }
    }

    #[test]
    fn command_names_are_letters_only_and_distinct() {
        assert_eq!(command_name("smallcaps"), "\\pfstylesmallcaps");
        assert_eq!(command_name("key-word2"), "\\pfstylekeyZwordC");
        assert_ne!(command_name("a-b"), command_name("ab"));
        assert_ne!(command_name("a1"), command_name("ab"));
        assert_eq!(environment_name("key-word2"), "pf-key-word2");
    }

    #[test]
    fn definitions_cover_both_kinds() {
        let styles = [
            style("note", StyleKind::Paragraph, "\\begin{quote}\\itshape\n#1\n\\end{quote}\n"),
            style("key-word2", StyleKind::Character, " \\textbf{#1} "),
        ];
        assert_eq!(
            definitions(&styles),
            "\\newenvironment{pf-note}{\\begin{quote}\\itshape}{\\end{quote}}\n\
             \\newcommand{\\pfstylekeyZwordC}[1]{\\textbf{#1}}\n"
        );
        assert_eq!(metadata(&styles), "div:note span:key-word2");
        assert_eq!(definitions(&[]), "");
        assert_eq!(metadata(&[]), "");
    }

    #[test]
    fn validation_rejects_unsafe_names_duplicates_and_missing_text() {
        let ok = |name: &str| validate(&[style(name, StyleKind::Character, "#1")]).is_ok();
        for name in ["note", "key-word", "h2", "a-1-b"] {
            assert!(ok(name), "{name}");
        }
        for name in ["", "Note", "2col", "-x", "x-", "a--b", "a_b", "a b", "x}\\evil", "é"] {
            assert!(!ok(name), "{name}");
        }
        let twice = [style("x", StyleKind::Character, "#1"), style("x", StyleKind::Paragraph, "#1")];
        assert!(validate(&twice).unwrap_err().contains("two styles"));
        assert!(validate(&[style("x", StyleKind::Character, "\\textsc{}")]).is_err());
        assert!(validate(&[style("x", StyleKind::Paragraph, "#1 and #1")]).is_err());
        assert!(validate(&[style("x", StyleKind::Character, "\\textsc{#1}\\index{#1}")]).is_ok());
    }
}
