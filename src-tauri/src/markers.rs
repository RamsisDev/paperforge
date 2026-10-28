//! Block markers: before conversion every top-level Markdown block gets a `<!--pf:N-->` comment
//! (N = its 1-based Markdown line), which `paper.lua` turns into a `%PF:N` line of the fragment.
//! The markers map fragment lines to Markdown lines and back.
//!
//! A marker must never change what Pandoc parses, so it only goes before a line that starts a
//! block after a blank line (or after an ATX heading), outside of fences, divs, comments, raw
//! LaTeX environments, multiline tables and anything a list, quote, footnote or definition list
//! may continue into.

const TEX_MARKER: &str = "%PF:";

/// The Markdown Pandoc reads, and the original lines that got a marker (ascending).
#[derive(Debug, Clone, PartialEq)]
pub struct Marked {
    pub text: String,
    pub lines: Vec<usize>,
}

impl Marked {
    /// The original line of a line of the marked text; each marker added two lines.
    pub fn original_line(&self, marked: usize) -> usize {
        let mut shift = 0;
        for &line in &self.lines {
            if line + shift + 2 > marked {
                break;
            }
            shift += 2;
        }
        marked.saturating_sub(shift).max(1)
    }

    /// Rewrites the `line N` positions in Pandoc's messages to original lines.
    pub fn remap_messages(&self, text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(i) = rest.find("line ") {
            let (head, tail) = rest.split_at(i + "line ".len());
            out.push_str(head);
            let digits = tail.len() - tail.trim_start_matches(|c: char| c.is_ascii_digit()).len();
            match tail[..digits].parse::<usize>() {
                Ok(n) => out.push_str(&self.original_line(n).to_string()),
                Err(_) => out.push_str(&tail[..digits]),
            }
            rest = &tail[digits..];
        }
        out.push_str(rest);
        out
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Container {
    None,
    List,
    Quote,
    Footnote,
    Definition,
}

fn indent_width(line: &str) -> usize {
    let mut width = 0;
    for c in line.chars() {
        match c {
            ' ' => width += 1,
            '\t' => width += 4 - width % 4,
            _ => break,
        }
    }
    width
}

fn is_blank(line: &str) -> bool {
    line.trim().is_empty()
}

fn followed_by_space(rest: &str) -> bool {
    rest.is_empty() || rest.starts_with([' ', '\t'])
}

/// `-`, `*`, `+`, `1.`, `1)`, `#.`, `a.`, `iv)`, `(1)`, `(@)`, `(@label)`.
fn is_list_marker(s: &str) -> bool {
    if let Some(rest) = s.strip_prefix(['-', '*', '+']) {
        return followed_by_space(rest);
    }
    let (body, rest) = match s.strip_prefix('(') {
        Some(inner) => match inner.split_once(')') {
            Some((body, rest)) => (body, rest),
            None => return false,
        },
        None => match s.find(['.', ')']) {
            Some(i) => (&s[..i], &s[i + 1..]),
            None => return false,
        },
    };
    let ordinal = !body.is_empty()
        && (body == "#"
            || body.len() <= 9 && body.chars().all(|c| c.is_ascii_digit())
            || body.len() == 1 && body.chars().all(|c| c.is_ascii_alphabetic())
            || body.chars().all(|c| "ivxlcdm".contains(c))
            || body.chars().all(|c| "IVXLCDM".contains(c)));
    let example = s.starts_with("(@") && body[1..].chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-');
    (ordinal || example) && followed_by_space(rest)
}

fn is_definition(s: &str) -> bool {
    s.strip_prefix([':', '~']).is_some_and(followed_by_space)
}

/// A definition (`:` or `~`) or a table caption (`:` or `Table:`); both attach to the block
/// before or after them.
fn is_attached(s: &str) -> bool {
    is_definition(s) || s.starts_with("Table:") || s.starts_with("table:")
}

fn is_dashes(s: &str) -> bool {
    let s = s.trim();
    s.len() >= 3 && s.chars().all(|c| c == '-')
}

/// An opening code fence: its character and length.
fn code_fence(s: &str) -> Option<(char, usize)> {
    let c = s.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let len = s.len() - s.trim_start_matches(c).len();
    (len >= 3 && (c == '~' || !s[len..].contains('`'))).then_some((c, len))
}

fn closes_fence(s: &str, (c, len): (char, usize)) -> bool {
    let s = s.trim_end();
    s.len() >= len && s.chars().all(|x| x == c)
}

/// `:::` lines: `Some(true)` opens a div (attributes follow), `Some(false)` closes one.
fn div_fence(s: &str) -> Option<bool> {
    let colons = s.len() - s.trim_start_matches(':').len();
    (colons >= 3).then(|| !s[colons..].trim().trim_end_matches(':').trim().is_empty())
}

/// `\begin{name}` at the start of a line: Pandoc reads the environment as one raw block, blank
/// lines included.
fn latex_environment(s: &str) -> Option<&str> {
    s.strip_prefix("\\begin{")?.split_once('}').map(|(name, _)| name)
}

/// A pipe, grid, simple or multiline table starting at line `i`, which a caption before it
/// belongs to.
fn starts_table(lines: &[&str], i: usize) -> bool {
    let s = lines[i].trim();
    let separator = lines.get(i + 1).map(|l| l.trim()).is_some_and(|l| {
        l.contains('-') && l.chars().all(|c| "-|:+= ".contains(c))
    });
    s.starts_with('|') || s.starts_with("+-") || s.starts_with("+=") || is_dashes(s) || separator
}

/// A term whose definition (`:` / `~`) follows on the next line, or after one blank line.
fn is_definition_term(lines: &[&str], i: usize) -> bool {
    let next = |k: usize| lines.get(k).map(|l| l.trim_end_matches('\r'));
    match next(i + 1) {
        Some(l) if is_blank(l) => next(i + 2).is_some_and(|l| is_definition(l.trim_start())),
        Some(l) => is_definition(l.trim_start()),
        None => false,
    }
}

/// The end of a multiline table or metadata block that opens with a dashed line at `i`: the
/// closing dashed (or `...`) line followed by a blank line. `None` when there is none.
fn dashed_region_end(lines: &[&str], i: usize) -> Option<usize> {
    let line = |k: usize| lines.get(k).map(|l| l.trim_end_matches('\r'));
    if !is_dashes(line(i)?) || line(i + 1).is_none_or(is_blank) {
        return None;
    }
    (i + 2..lines.len()).find(|&k| {
        let l = line(k).unwrap_or_default();
        (is_dashes(l) || l.trim() == "...") && line(k + 1).is_none_or(is_blank)
    })
}

/// The Markdown with a `<!--pf:N-->` line (and a blank line) before each top-level block.
pub fn mark_blocks(markdown: &str) -> Marked {
    let lines: Vec<&str> = markdown.split('\n').collect();
    let mut text = String::with_capacity(markdown.len() + lines.len() * 4);
    let mut marked_lines = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    let mut environment: Option<(&str, usize)> = None;
    let mut comment = false;
    let mut divs = 0usize;
    let mut skip_until = 0usize;
    let mut container = Container::None;
    let mut block_start = true;
    let mut after_caption = false;

    for (i, raw) in lines.iter().enumerate() {
        if i > 0 {
            text.push('\n');
        }
        let line = raw.trim_end_matches('\r');
        let indent = indent_width(line);
        let s = line.trim_start();
        let starts_block = std::mem::replace(&mut block_start, false);

        if i < skip_until {
            text.push_str(raw);
            continue;
        }
        if let Some(open) = fence {
            if closes_fence(s, open) {
                fence = None;
            }
            text.push_str(raw);
            continue;
        }
        if comment {
            comment = !line.contains("-->");
            text.push_str(raw);
            continue;
        }
        if let Some((name, depth)) = environment {
            if s.starts_with(&format!("\\begin{{{name}}}")) {
                environment = Some((name, depth + 1));
            } else if s.starts_with(&format!("\\end{{{name}}}")) {
                environment = (depth > 1).then_some((name, depth - 1));
            }
            text.push_str(raw);
            continue;
        }
        if is_blank(line) {
            block_start = true;
            text.push_str(raw);
            continue;
        }

        let in_container = container != Container::None;
        let top = divs == 0 && indent < 4;
        let mut heading = false;
        if starts_block {
            let continues = !top
                || (i == 0 && s.starts_with('%'))
                || (after_caption && starts_table(&lines, i))
                || is_attached(s)
                || (in_container && indent > 0)
                || match container {
                    Container::List => is_list_marker(s),
                    Container::Quote => s.starts_with('>'),
                    Container::Definition => is_definition_term(&lines, i),
                    Container::Footnote | Container::None => false,
                };
            after_caption = is_attached(s) && container != Container::Definition;
            if !continues {
                text.push_str(&format!("<!--pf:{}-->\n\n", i + 1));
                marked_lines.push(i + 1);
                container = if is_list_marker(s) {
                    Container::List
                } else if s.starts_with('>') {
                    Container::Quote
                } else if s.starts_with("[^") && s.contains("]:") {
                    Container::Footnote
                } else if is_definition_term(&lines, i) {
                    Container::Definition
                } else {
                    Container::None
                };
                heading = s.starts_with('#') && followed_by_space(s.trim_start_matches('#'));
            }
            if top && let Some(end) = dashed_region_end(&lines, i) {
                skip_until = end + 1;
            }
        }
        text.push_str(raw);

        if (indent < 4 || in_container)
            && let Some(open) = code_fence(s)
        {
            fence = Some(open);
            continue;
        }
        if let Some(opens) = div_fence(s) {
            if opens {
                divs += 1;
            } else {
                divs = divs.saturating_sub(1);
            }
            continue;
        }
        if s.starts_with("<!--") && !s[4..].contains("-->") {
            comment = true;
            continue;
        }
        if indent < 4 && let Some(name) = latex_environment(s) {
            if !s.contains(&format!("\\end{{{name}}}")) {
                environment = Some((name, 1));
            }
            continue;
        }
        // A one-line heading ends its block; Pandoc starts a new one on the next line.
        block_start = heading;
    }
    Marked { text, lines: marked_lines }
}

/// Splits text into lowercase words of three letters or more, for matching lines that render
/// the same words with different markup.
fn words(line: &str) -> Vec<String> {
    line.split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 3)
        .map(str::to_lowercase)
        .collect()
}

/// The candidate (index) sharing the most words with `target`, if any shares one.
fn best_by_words(target: &str, candidates: &[&str]) -> Option<usize> {
    let wanted = words(target);
    if wanted.is_empty() {
        return None;
    }
    candidates
        .iter()
        .enumerate()
        .map(|(i, c)| (i, words(c).iter().filter(|w| wanted.contains(w)).count()))
        .filter(|(_, n)| *n > 0)
        .max_by_key(|(i, n)| (*n, std::cmp::Reverse(*i)))
        .map(|(i, _)| i)
}

fn is_tex_marker(line: &str) -> bool {
    line.trim().strip_prefix(TEX_MARKER).is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// The LaTeX without its `%PF:N` lines and the blank line Pandoc puts after each, as exported.
pub fn strip_markers(tex: &str) -> String {
    let mut out = String::with_capacity(tex.len());
    let mut lines = tex.split_inclusive('\n').peekable();
    while let Some(line) = lines.next() {
        if is_tex_marker(line) {
            if lines.peek().is_some_and(|l| is_blank(l)) {
                lines.next();
            }
        } else {
            out.push_str(line);
        }
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Block {
    /// The block's first Markdown line.
    markdown: usize,
    /// The marker's fragment line.
    marker: usize,
}

/// 1-based inclusive range of the non-blank lines in `lines[from-1 .. to]`.
fn trimmed_range(lines: &[&str], from: usize, to: usize) -> (usize, usize) {
    let non_blank = |k: &usize| lines.get(k - 1).is_some_and(|l| !is_blank(l));
    let start = (from..=to).find(non_blank).unwrap_or(from);
    let end = (start..=to).rev().find(non_blank).unwrap_or(start);
    (start, end)
}

/// One top-level block on both sides: 1-based inclusive line ranges, blank edges trimmed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BlockSpan {
    pub tex: (usize, usize),
    pub markdown: (usize, usize),
}

/// The `%PF:N` markers of one fragment, with the Markdown it came from.
pub struct BlockMap<'a> {
    blocks: Vec<Block>,
    tex: Vec<&'a str>,
    markdown: Vec<&'a str>,
}

impl<'a> BlockMap<'a> {
    pub fn new(tex: &'a str, markdown: &'a str) -> Self {
        let tex: Vec<&str> = tex.lines().collect();
        let blocks = tex
            .iter()
            .enumerate()
            .filter_map(|(i, l)| {
                let n = l.trim().strip_prefix(TEX_MARKER)?.parse().ok().filter(|n| *n > 0)?;
                Some(Block { markdown: n, marker: i + 1 })
            })
            .collect();
        Self { blocks, tex, markdown: markdown.lines().collect() }
    }

    /// The fragment and Markdown line ranges (1-based, inclusive) of block `k`.
    fn ranges(&self, k: usize) -> ((usize, usize), (usize, usize)) {
        let block = self.blocks[k];
        let next = self.blocks.get(k + 1);
        let tex_end = next.map_or(self.tex.len(), |b| b.marker - 1);
        let md_end = next.map_or(self.markdown.len(), |b| b.markdown.saturating_sub(1)).max(block.markdown);
        (
            trimmed_range(&self.tex, block.marker + 1, tex_end.max(block.marker + 1)),
            trimmed_range(&self.markdown, block.markdown, md_end),
        )
    }

    /// Maps a line inside a block to the other side: the same offset when both sides have as
    /// many lines (Pandoc keeps paragraph lines with `--wrap=preserve`), else the line sharing
    /// the most words, else the offset clamped to the block.
    fn map_line(line: usize, from: (usize, usize), from_text: &[&str], to: (usize, usize), to_text: &[&str]) -> usize {
        let line = line.clamp(from.0, from.1);
        let by_offset = (to.0 + line - from.0).min(to.1);
        if from.1 - from.0 == to.1 - to.0 {
            return by_offset;
        }
        let candidates: Vec<&str> = (to.0..=to.1).map(|k| to_text.get(k - 1).copied().unwrap_or("")).collect();
        let target = from_text.get(line - 1).copied().unwrap_or("");
        best_by_words(target, &candidates).map_or(by_offset, |i| to.0 + i)
    }

    /// The Markdown line a fragment line came from.
    pub fn markdown_line(&self, tex_line: usize) -> Option<usize> {
        let k = self.blocks.iter().rposition(|b| b.marker <= tex_line)?;
        let (tex, md) = self.ranges(k);
        Some(Self::map_line(tex_line.max(tex.0), tex, &self.tex, md, &self.markdown))
    }

    /// The fragment line a Markdown line became, and the fragment lines of its whole block.
    pub fn tex_line(&self, markdown_line: usize) -> Option<(usize, (usize, usize))> {
        let k = self.blocks.iter().rposition(|b| b.markdown <= markdown_line)?;
        let (tex, md) = self.ranges(k);
        Some((Self::map_line(markdown_line.max(md.0), md, &self.markdown, tex, &self.tex), tex))
    }

    /// The block a Markdown line belongs to: the last one starting at or before it.
    pub fn block(&self, markdown_line: usize) -> Option<BlockSpan> {
        let k = self.blocks.iter().rposition(|b| b.markdown <= markdown_line)?;
        let (tex, markdown) = self.ranges(k);
        Some(BlockSpan { tex, markdown })
    }

    /// The fragment lines `from..=to` without marker lines.
    pub fn tex_text(&self, (from, to): (usize, usize)) -> String {
        let lines = self.tex.get(from.saturating_sub(1)..to.min(self.tex.len())).unwrap_or_default();
        lines.iter().filter(|l| !is_tex_marker(l)).copied().collect::<Vec<_>>().join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Markdown with each marked block start prefixed by `@`, for compact assertions.
    fn shown(markdown: &str) -> String {
        let marked = mark_blocks(markdown);
        let mut out: Vec<String> = Vec::new();
        for (i, line) in markdown.split('\n').enumerate() {
            let at = if marked.lines.contains(&(i + 1)) { "@" } else { "" };
            out.push(format!("{at}{line}"));
        }
        out.join("\n")
    }

    fn assert_marks(annotated: &str) {
        let markdown = annotated.replace("\n@", "\n").trim_start_matches('@').to_string();
        assert_eq!(shown(&markdown), annotated);
    }

    #[test]
    fn marks_headings_paragraphs_and_lines_after_headings() {
        assert_marks("@# Title\n@Text right after.\n\n@Para one\ncontinues.\n\n@## Sub\n@### Subsub\n");
        let marked = mark_blocks("# A\n\nText.\n");
        assert_eq!(marked.text, "<!--pf:1-->\n\n# A\n\n<!--pf:3-->\n\nText.\n");
        assert_eq!(marked.lines, [1, 3]);
    }

    #[test]
    fn never_splits_lists() {
        assert_marks("@- tight\n- list\n\n@After.\n");
        assert_marks("@- loose\n\n- list\n\n  continued paragraph\n\n- third\n\n@After.\n");
        assert_marks("@1. one\n\n2. two\n   - nested\n\n     - nested loose\n\n3) three\n\n(a) x\n\n(b) y\n\n@After.\n");
        assert_marks("@(@) example\n\n(@good) another\n\n@Done.\n");
    }

    #[test]
    fn skips_code_fences_and_their_contents() {
        assert_marks("@Text.\n\n    indented code\n\n    more code\n\n@After.\n");
        assert_marks("@```python\n# not a heading\n\nx = 1\n```\n\n@~~~~\n```\n\nstill code\n~~~~\n\n@End.\n");
        assert_marks("@```{=latex}\n\\begin{center}\n\nX\n\\end{center}\n```\n\n@After.\n");
        assert_marks("@- item\n\n  ```\n\nnot a block\n  ```\n\n@After.\n");
    }

    #[test]
    fn display_math_divs_and_raw_latex_stay_whole() {
        assert_marks("@$$\nE = mc^2\n$$ {#eq:x}\n\n@Text.\n");
        assert_marks("@::: {.note}\nInside.\n\nStill inside.\n\n::: {.inner}\nx\n:::\n\nInside too.\n:::\n\n@After.\n");
        assert_marks("@\\begin{figure}\n\\centering\n\n\\begin{figure}\n\n\\end{figure}\nx\n\n\\end{figure}\n\n@Done.\n");
        assert_marks("@<!-- a comment\n\nspanning blank lines -->\n\n@Text.\n");
    }

    #[test]
    fn tables_keep_their_captions_and_definition_lists_stay_whole() {
        assert_marks("@| a | b |\n|---|---|\n| 1 | 2 |\n\n: Results {#tbl:r}\n\n@Next paragraph.\n");
        assert_marks("@Intro.\n\nTable: Before\n\n  a   b\n  --- ---\n  1   2\n\n@After.\n");
        assert_marks("@Text.\n\nTable: Before\n\nA | B\n--|--\n1 | 2\n\n: Two\n\n+---+\n| x |\n+---+\n\n@After.\n");
        assert_marks("@![fig](x.png)\n\nTable: Before\n\nC   D\n--- ---\n3   4\n\n@After.\n");
        assert_marks("@-------------\n  A    B\n---- ----\n  1    x\n\n  2    y\n-------------\n\n: Multi {#tbl:m}\n\n@X\n");
        assert_marks("@Term\n:   def\n\nTerm 2\n\n:   def 2\n\n    more of def 2\n\n@After.\n");
    }

    #[test]
    fn quotes_footnotes_and_title_blocks() {
        assert_marks("@> quote\n\n> more quote\n\n@After.\n");
        assert_marks("@Text[^1].\n\n@[^1]: Note.\n\n    Second note paragraph.\n\n@After.\n");
        assert_marks("% Title\n% Author\n\n@Text.\n");
    }

    #[test]
    fn crlf_lines_are_marked_too() {
        let marked = mark_blocks("# A\r\n\r\nText.\r\n");
        assert_eq!(marked.lines, [1, 3]);
        assert!(marked.text.ends_with("<!--pf:3-->\n\nText.\r\n"), "{:?}", marked.text);
    }

    #[test]
    fn pandoc_positions_map_back_to_original_lines() {
        let marked = mark_blocks("# A\n\nText[^1].\n\n[^1]: x\n\n[^1]: y\n");
        // Original line 7 is marked line 7 + 2 per marker at or before it (lines 1, 3, 5, 7).
        assert_eq!(marked.original_line(15), 7);
        assert_eq!(marked.original_line(1), 1);
        assert_eq!(marked.original_line(3), 1);
        assert_eq!(
            marked.remap_messages("Duplicate note reference '1' at line 15 column 1\nline x"),
            "Duplicate note reference '1' at line 7 column 1\nline x"
        );
    }

    const MARKDOWN: &str = "# Intro\n\nFirst line\nsecond line.\n\n- apple pie\n- banana split\n\nEnd.\n";
    const TEX: &str = "%PF:1\n\n\\section{Intro}\\label{intro}\n\n%PF:3\n\nFirst line\nsecond line.\n\n%PF:6\n\n\
                       \\begin{itemize}\n\\tightlist\n\\item\n  apple pie\n\\item\n  banana split\n\\end{itemize}\n\n%PF:9\n\nEnd.\n";

    #[test]
    fn block_map_goes_both_ways() {
        let map = BlockMap::new(TEX, MARKDOWN);
        assert_eq!(map.markdown_line(3), Some(1));
        assert_eq!(map.markdown_line(7), Some(3));
        assert_eq!(map.markdown_line(8), Some(4));
        assert_eq!(map.markdown_line(5), Some(3));
        assert_eq!(map.markdown_line(17), Some(7));
        assert_eq!(map.markdown_line(12), Some(6));
        assert_eq!(map.markdown_line(22), Some(9));
        assert_eq!(map.tex_line(4), Some((8, (7, 8))));
        assert_eq!(map.tex_line(6), Some((15, (12, 18))));
        assert_eq!(map.tex_line(7), Some((17, (12, 18))));
        // The blank line after a block belongs to it.
        assert_eq!(map.tex_line(8), Some((17, (12, 18))));
        assert_eq!(map.tex_line(1), Some((3, (3, 3))));
        assert_eq!(BlockMap::new("no markers", MARKDOWN).markdown_line(1), None);
    }

    fn block_of(tex: &str, markdown: &str, line: usize) -> Option<(BlockSpan, String)> {
        let map = BlockMap::new(tex, markdown);
        map.block(line).map(|b| (b, map.tex_text(b.tex)))
    }

    #[test]
    fn blocks_cover_first_last_and_list_blocks() {
        let (first, latex) = block_of(TEX, MARKDOWN, 1).unwrap();
        assert_eq!(first, BlockSpan { tex: (3, 3), markdown: (1, 1) });
        assert_eq!(latex, "\\section{Intro}\\label{intro}");
        let (paragraph, latex) = block_of(TEX, MARKDOWN, 4).unwrap();
        assert_eq!(paragraph, BlockSpan { tex: (7, 8), markdown: (3, 4) });
        assert_eq!(latex, "First line\nsecond line.");
        let (list, latex) = block_of(TEX, MARKDOWN, 7).unwrap();
        assert_eq!(list, BlockSpan { tex: (12, 18), markdown: (6, 7) });
        assert!(latex.starts_with("\\begin{itemize}") && latex.ends_with("\\end{itemize}"), "{latex}");
        // The blank line after a block belongs to it.
        assert_eq!(block_of(TEX, MARKDOWN, 8).unwrap().0, list);
        let (last, latex) = block_of(TEX, MARKDOWN, 9).unwrap();
        assert_eq!(last, BlockSpan { tex: (22, 22), markdown: (9, 9) });
        assert_eq!(latex, "End.");
    }

    #[test]
    fn lines_without_a_marker_of_their_own_belong_to_the_block_before() {
        let markdown = "Text.\n\n$$\nE = mc^2\n$$ {#eq:x}\n\n| a |\n|---|\n| 1 |\n\n: Cap {#tbl:t}\n";
        assert_eq!(mark_blocks(markdown).lines, [1, 3, 7]);
        let tex = "%PF:1\n\nText.\n\n%PF:3\n\n\\begin{equation}\nE = mc^2\\label{eq:x}\\end{equation}\n\n\
                   %PF:7\n\n\\begin{table}\n\\caption{Cap}\\label{tbl:t}\n\\end{table}\n";
        let (math, latex) = block_of(tex, markdown, 4).unwrap();
        assert_eq!(math.markdown, (3, 5));
        assert_eq!(latex, "\\begin{equation}\nE = mc^2\\label{eq:x}\\end{equation}");
        let (table, latex) = block_of(tex, markdown, 11).unwrap();
        assert_eq!(table.markdown, (7, 11));
        assert!(latex.contains("\\caption{Cap}"), "{latex}");
        // A title block has no marker and no block.
        assert_eq!(block_of("%PF:4\n\nText.\n", "% Title\n% Author\n\nText.\n", 1), None);
    }

    #[test]
    fn stripping_markers_leaves_the_plain_fragment() {
        assert_eq!(
            strip_markers(TEX),
            "\\section{Intro}\\label{intro}\n\nFirst line\nsecond line.\n\n\\begin{itemize}\n\\tightlist\n\\item\n  \
             apple pie\n\\item\n  banana split\n\\end{itemize}\n\nEnd.\n"
        );
        assert_eq!(strip_markers("%PF:x\n%PF:\nText %PF:3\n"), "%PF:x\n%PF:\nText %PF:3\n");
        assert_eq!(strip_markers("%PF:1\r\n\r\nText.\r\n"), "Text.\r\n");
    }
}
