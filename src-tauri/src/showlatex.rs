//! "Show LaTeX": the generated LaTeX of one top-level Markdown block, read from the part's last
//! fragment through its `%PF:N` block markers.

use std::path::Path;

use serde::Serialize;

use crate::compiler;
use crate::markers::BlockMap;
use crate::project;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockLatex {
    /// The block's fragment lines, 1-based and inclusive.
    pub from_line: usize,
    pub to_line: usize,
    /// The block's Markdown lines, 1-based and inclusive.
    pub markdown_from: usize,
    pub markdown_to: usize,
    /// The fragment lines without the `%PF:` marker lines.
    pub latex: String,
    /// The part changed after the fragment was generated; the lines may not match any more.
    pub stale: bool,
}

/// The block of `markdown` around `line` in `tex`, a fragment generated from it.
pub fn block_in(tex: &str, markdown: &str, line: usize, stale: bool) -> Option<BlockLatex> {
    let map = BlockMap::new(tex, markdown);
    let block = map.block(line)?;
    Some(BlockLatex {
        from_line: block.tex.0,
        to_line: block.tex.1,
        markdown_from: block.markdown.0,
        markdown_to: block.markdown.1,
        latex: map.tex_text(block.tex),
        stale,
    })
}

/// The generated LaTeX of the block around a Markdown line (1-based) of a part. `content` is the
/// part as the editor has it, which may not be saved yet; the file on disk otherwise. `None`
/// before the part was first typeset or outside any block.
pub async fn block_latex(dir: &Path, part: &str, line: usize, content: Option<String>) -> Result<Option<BlockLatex>, String> {
    let meta = project::read_meta(dir)?;
    let Some(fragment) = compiler::fragments(&meta.parts).into_iter().find(|f| f.part == part) else {
        return Ok(None);
    };
    let build = project::build_dir(dir);
    let Ok(tex) = tokio::fs::read_to_string(build.join(fragment.tex_file())).await else { return Ok(None) };
    let markdown = match content {
        Some(content) => content,
        None => match tokio::fs::read_to_string(dir.join(part)).await {
            Ok(markdown) => markdown,
            Err(_) => return Ok(None),
        },
    };
    let built_from = tokio::fs::read_to_string(build.join(fragment.source_file())).await.unwrap_or_default();
    let stale = built_from != compiler::source_hash(markdown.as_bytes());
    Ok(block_in(&tex, &markdown, line, stale))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MARKDOWN: &str = "# Intro\n\nSome **bold** text\non two lines.\n\n$$\nE = mc^2\n$$ {#eq:x}\n";
    const TEX: &str = "%PF:1\n\n\\chapter{Intro}\\label{intro}\n\n%PF:3\n\nSome \\textbf{bold} text\non two lines.\n\n\
                       %PF:6\n\n\\begin{equation}E = mc^2\\label{eq:x}\\end{equation}\n";

    /// A project whose only part has `markdown` on disk and `tex` as its fragment.
    fn project_with(markdown: &str, tex: Option<&str>, built_from: Option<&str>) -> (tempfile::TempDir, String) {
        let tmp = tempfile::tempdir().unwrap();
        project::create(tmp.path(), None, "report", "", "").unwrap();
        let part = project::read_meta(tmp.path()).unwrap().parts[0].clone();
        project::save_part(tmp.path(), &part, markdown).unwrap();
        let fragment = &compiler::fragments(std::slice::from_ref(&part))[0];
        let build = project::build_dir(tmp.path());
        std::fs::create_dir_all(&build).unwrap();
        if let Some(tex) = tex {
            std::fs::write(build.join(fragment.tex_file()), tex).unwrap();
        }
        if let Some(source) = built_from {
            std::fs::write(build.join(fragment.source_file()), compiler::source_hash(source.as_bytes())).unwrap();
        }
        (tmp, part)
    }

    #[tokio::test]
    async fn returns_the_block_of_a_fresh_fragment() {
        let (tmp, part) = project_with(MARKDOWN, Some(TEX), Some(MARKDOWN));
        let block = block_latex(tmp.path(), &part, 4, None).await.unwrap().unwrap();
        assert_eq!(
            block,
            BlockLatex {
                from_line: 7,
                to_line: 8,
                markdown_from: 3,
                markdown_to: 4,
                latex: "Some \\textbf{bold} text\non two lines.".into(),
                stale: false,
            }
        );
        let math = block_latex(tmp.path(), &part, 8, None).await.unwrap().unwrap();
        assert_eq!((math.markdown_from, math.markdown_to), (6, 8));
        assert_eq!(math.latex, "\\begin{equation}E = mc^2\\label{eq:x}\\end{equation}");
    }

    #[tokio::test]
    async fn marks_blocks_stale_when_the_part_changed_since() {
        let edited = MARKDOWN.replace("bold", "strong");
        let (tmp, part) = project_with(&edited, Some(TEX), Some(MARKDOWN));
        assert!(block_latex(tmp.path(), &part, 4, None).await.unwrap().unwrap().stale);
        let unsaved = Some(MARKDOWN.to_string());
        assert!(!block_latex(tmp.path(), &part, 4, unsaved).await.unwrap().unwrap().stale);

        let (tmp, part) = project_with(MARKDOWN, Some(TEX), None);
        assert!(block_latex(tmp.path(), &part, 4, None).await.unwrap().unwrap().stale, "no source hash yet");
    }

    #[tokio::test]
    async fn none_without_a_fragment_or_a_block() {
        let (tmp, part) = project_with(MARKDOWN, None, Some(MARKDOWN));
        assert_eq!(block_latex(tmp.path(), &part, 3, None).await.unwrap(), None);
        assert_eq!(block_latex(tmp.path(), "sections/other.md", 3, None).await.unwrap(), None);
        let (tmp, part) = project_with(MARKDOWN, Some("no markers\n"), Some(MARKDOWN));
        assert_eq!(block_latex(tmp.path(), &part, 3, None).await.unwrap(), None);
    }
}
