//! SyncTeX: the `paper.synctex.gz` Tectonic writes next to the PDF, read with a small parser of
//! its own. Combined with the `%PF:N` block markers of each fragment it links a spot of the PDF
//! to a Markdown line of a part, both ways.
//!
//! Records are `kind tag,line:h,v[:width,height,depth]` in scaled points from the top left of
//! the page (TeX's one-inch origin included); positions here are PDF points from the top left.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use serde::Serialize;

use crate::compiler::{self, Fragment};
use crate::markers::BlockMap;
use crate::project;

pub const SYNCTEX_FILE: &str = "paper.synctex.gz";
const SP_PER_BP: f64 = 65_781.76;
/// Height of the box drawn around a record no box encloses.
const FALLBACK_HEIGHT: f64 = 12.0;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    VBox,
    HBox,
    VoidVBox,
    VoidHBox,
    Glue,
    Kern,
    Current,
    Math,
}

impl Kind {
    fn from_char(c: char) -> Option<Self> {
        Some(match c {
            '[' => Self::VBox,
            '(' => Self::HBox,
            'v' => Self::VoidVBox,
            'h' => Self::VoidHBox,
            'g' => Self::Glue,
            'k' => Self::Kern,
            'x' => Self::Current,
            '$' => Self::Math,
            _ => return None,
        })
    }

    fn is_line_box(self) -> bool {
        matches!(self, Self::HBox | Self::VoidHBox)
    }

    /// Records TeX writes for the material itself, which carry the line it was read from;
    /// a paragraph's line boxes carry the line where the paragraph ended.
    fn is_leaf(self) -> bool {
        matches!(self, Self::Glue | Self::Kern | Self::Current | Self::Math | Self::VoidHBox)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Record {
    kind: Kind,
    page: u32,
    tag: u32,
    line: usize,
    h: i64,
    v: i64,
    width: i64,
    height: i64,
    depth: i64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Rect {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

impl Rect {
    fn contains(&self, x: f64, y: f64) -> bool {
        (self.left..=self.right).contains(&x) && (self.top..=self.bottom).contains(&y)
    }

    fn area(&self) -> f64 {
        (self.right - self.left) * (self.bottom - self.top)
    }

    /// Distance from the point to the rectangle, vertical distance weighing more: a click
    /// beside a line belongs to that line.
    fn distance(&self, x: f64, y: f64) -> f64 {
        let dx = (self.left - x).max(x - self.right).max(0.0);
        let dy = (self.top - y).max(y - self.bottom).max(0.0);
        dy * 4.0 + dx
    }
}

/// A line of a TeX input file.
#[derive(Debug, Clone, PartialEq)]
pub struct TexSpot {
    pub file: String,
    pub line: usize,
}

/// A region of a PDF page: 1-based page, PDF points from the top left.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct PdfBox {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Default)]
pub struct SyncTex {
    inputs: HashMap<u32, String>,
    records: Vec<Record>,
    unit: f64,
    magnification: f64,
    x_offset: f64,
    y_offset: f64,
}

fn parse_record(kind: Kind, page: u32, rest: &str) -> Option<Record> {
    let mut sections = rest.split(':');
    let mut link = sections.next()?.split(',');
    let tag = link.next()?.parse().ok()?;
    let line = link.next()?.parse().ok()?;
    let (h, v) = sections.next()?.split_once(',')?;
    let mut size = sections.next().unwrap_or_default().split(',').map(|n| n.parse::<i64>().unwrap_or(0));
    Some(Record {
        kind,
        page,
        tag,
        line,
        h: h.parse().ok()?,
        v: v.parse().ok()?,
        width: size.next().unwrap_or(0),
        height: size.next().unwrap_or(0),
        depth: size.next().unwrap_or(0),
    })
}

impl SyncTex {
    pub fn parse(text: &str) -> Self {
        let mut sync = SyncTex { unit: 1.0, magnification: 1000.0, ..SyncTex::default() };
        let mut content = false;
        let mut page = 0;
        for line in text.lines() {
            if let Some(input) = line.strip_prefix("Input:") {
                if let Some((tag, path)) = input.split_once(':')
                    && let Ok(tag) = tag.parse()
                    && !path.is_empty()
                {
                    sync.inputs.insert(tag, path.to_string());
                }
                continue;
            }
            if !content {
                let number = |prefix: &str| line.strip_prefix(prefix).and_then(|n| n.trim().parse::<f64>().ok());
                if let Some(n) = number("Unit:") {
                    sync.unit = n;
                } else if let Some(n) = number("Magnification:") {
                    sync.magnification = n;
                } else if let Some(n) = number("X Offset:") {
                    sync.x_offset = n;
                } else if let Some(n) = number("Y Offset:") {
                    sync.y_offset = n;
                }
                content = line == "Content:";
                continue;
            }
            if line.starts_with("Postamble:") {
                break;
            }
            let mut chars = line.chars();
            match chars.next() {
                Some('{') => page = chars.as_str().parse().unwrap_or(page),
                Some(c) => {
                    if let Some(record) = Kind::from_char(c).and_then(|kind| parse_record(kind, page, chars.as_str())) {
                        sync.records.push(record);
                    }
                }
                None => {}
            }
        }
        sync
    }

    pub fn read(path: &Path) -> Result<Self, String> {
        let file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut bytes = Vec::new();
        flate2::read::GzDecoder::new(file)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(Self::parse(&String::from_utf8_lossy(&bytes)))
    }

    fn points(&self, raw: i64, offset: f64) -> f64 {
        (raw as f64 * self.unit + offset) * self.magnification / 1000.0 / SP_PER_BP
    }

    fn rect(&self, r: &Record) -> Rect {
        Rect {
            left: self.points(r.h, self.x_offset),
            top: self.points(r.v - r.height, self.y_offset),
            right: self.points(r.h + r.width, self.x_offset),
            bottom: self.points(r.v + r.depth, self.y_offset),
        }
    }

    fn point(&self, r: &Record) -> (f64, f64) {
        (self.points(r.h, self.x_offset), self.points(r.v, self.y_offset))
    }

    fn line_boxes(&self, page: u32) -> impl Iterator<Item = (&Record, Rect)> {
        self.records
            .iter()
            .filter(move |r| r.page == page && r.kind.is_line_box() && r.width > 0 && r.height + r.depth > 0)
            .map(|r| (r, self.rect(r)))
    }

    /// The input line typeset at a spot of a page: the closest line box, then the material in
    /// it that starts at or before the spot.
    pub fn to_source(&self, page: u32, x: f64, y: f64) -> Option<TexSpot> {
        let (line_box, rect) = self
            .line_boxes(page)
            .filter(|(_, rect)| rect.contains(x, y))
            .min_by(|a, b| a.1.area().total_cmp(&b.1.area()))
            .or_else(|| self.line_boxes(page).min_by(|a, b| a.1.distance(x, y).total_cmp(&b.1.distance(x, y))))?;
        let leaves: Vec<(&Record, f64)> = self
            .records
            .iter()
            .filter(|r| r.page == page && r.kind.is_leaf() && self.inputs.contains_key(&r.tag))
            .filter_map(|r| {
                let (h, v) = self.point(r);
                rect.contains(h, v).then_some((r, h))
            })
            .collect();
        let leaf = leaves
            .iter()
            .filter(|(_, h)| *h <= x)
            .max_by(|a, b| a.1.total_cmp(&b.1))
            .or_else(|| leaves.iter().min_by(|a, b| a.1.total_cmp(&b.1)))
            .map_or(line_box, |(r, _)| *r);
        let file = self.inputs.get(&leaf.tag)?;
        Some(TexSpot { file: file.clone(), line: leaf.line })
    }

    /// Where a line of the inputs `file` accepts was first typeset: the line box around it, from
    /// that line's first material (a reflowed paragraph line starts mid-line) to the box's end.
    pub fn to_pdf(&self, file: impl Fn(&str) -> bool, line: usize) -> Option<PdfBox> {
        let record = self
            .records
            .iter()
            .filter(|r| r.line == line && self.inputs.get(&r.tag).is_some_and(|f| file(f)))
            .min_by_key(|r| (r.page, r.v, r.h))?;
        let (x, y) = self.point(record);
        let rect = self
            .line_boxes(record.page)
            .map(|(_, rect)| rect)
            .filter(|rect| rect.contains(x, y))
            .min_by(|a, b| a.area().total_cmp(&b.area()))
            .unwrap_or(Rect { left: x, top: y - FALLBACK_HEIGHT, right: x, bottom: y });
        let left = x.max(rect.left);
        Some(PdfBox {
            page: record.page,
            x: left,
            y: rect.top,
            width: rect.right - left,
            height: rect.bottom - rect.top,
        })
    }
}

/// A Markdown line of a part.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceSpot {
    pub part: String,
    /// 1-based.
    pub line: usize,
}

fn is_fragment_file(path: &str, fragment: &Fragment) -> bool {
    let name = Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or(path);
    name.strip_suffix(".tex").unwrap_or(name) == fragment.name
}

/// The fragment's LaTeX and the part's Markdown it was generated from.
async fn fragment_sources(dir: &Path, fragment: &Fragment) -> Option<(String, String)> {
    let tex = project::build_dir(dir).join(format!("{}.tex", fragment.name));
    let tex = tokio::fs::read_to_string(tex).await.ok()?;
    let markdown = tokio::fs::read_to_string(dir.join(&fragment.part)).await.ok()?;
    Some((tex, markdown))
}

fn project_fragments(dir: &Path) -> Result<Vec<Fragment>, String> {
    Ok(compiler::fragments(&project::read_meta(dir)?.parts))
}

/// The Markdown line typeset at a spot of the PDF; `None` outside the parts (title, abstract,
/// bibliography) or without SyncTeX data for it.
pub async fn source_at(sync: &SyncTex, dir: &Path, page: u32, x: f64, y: f64) -> Result<Option<SourceSpot>, String> {
    let Some(spot) = sync.to_source(page, x, y) else { return Ok(None) };
    let fragments = project_fragments(dir)?;
    let Some(fragment) = fragments.iter().find(|f| is_fragment_file(&spot.file, f)) else { return Ok(None) };
    let Some((tex, markdown)) = fragment_sources(dir, fragment).await else { return Ok(None) };
    let line = BlockMap::new(&tex, &markdown).markdown_line(spot.line);
    Ok(line.map(|line| SourceSpot { part: fragment.part.clone(), line }))
}

/// Where a Markdown line of a part was typeset: its own fragment line when TeX recorded it,
/// else the nearest recorded line of the same block.
pub async fn pdf_at(sync: &SyncTex, dir: &Path, part: &str, line: usize) -> Result<Option<PdfBox>, String> {
    let fragments = project_fragments(dir)?;
    let Some(fragment) = fragments.iter().find(|f| f.part == part) else { return Ok(None) };
    let Some((tex, markdown)) = fragment_sources(dir, fragment).await else { return Ok(None) };
    let Some((tex_line, (start, end))) = BlockMap::new(&tex, &markdown).tex_line(line) else { return Ok(None) };
    let mut nearest = (tex_line..=end).chain((start..tex_line).rev());
    Ok(nearest.find_map(|l| sync.to_pdf(|f| is_fragment_file(f, fragment), l)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed from a Tectonic run: `paper.tex` inputs `part-a.tex`, whose line 3 is a section
    /// heading and lines 7-8 one paragraph (typeset as a single line ending on line 9).
    const SAMPLE: &str = "SyncTeX Version:1
Input:1:/p/.build/paper.tex
Input:2:
Input:7:/p/.build/part-a.tex
Output:pdf
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
!222
{1
[1,6:4736287,46220575:26673152,41484288,0
(1,6:4736287,4736287:0,0,0
)
[1,6:8799519,44254495:22609920,36044800,0
(7,3:8799519,11033313:22609920,660603,183080
(7,3:8799519,11033313:1475031,619079,0
g7,3:8799519,11033313
g7,3:10274550,11033313
)
k7,3:31409439,11033313:18341484
g7,3:31409439,11033313
)
(7,9:8799519,12469403:22609920,462029,135003
g7,7:10492314,12469403
g7,7:12478710,12469403
g7,8:16945644,12469403
g7,8:18310759,12469403
k7,9:31409439,12469403:8472494
)
]
]
!1306
}1
{2
(1,4:8799519,8865055:22609920,454820,7208
g1,4:11476009,8865055
)
}2
Input:8:
Postamble:
Count:56
";

    fn pt(sp: i64) -> f64 {
        sp as f64 / SP_PER_BP
    }

    #[test]
    fn parses_inputs_and_records() {
        let sync = SyncTex::parse(SAMPLE);
        assert_eq!(sync.inputs.len(), 2);
        assert_eq!(sync.inputs[&7], "/p/.build/part-a.tex");
        assert_eq!(sync.records.iter().filter(|r| r.page == 1).count(), 15);
        assert_eq!(sync.records.iter().filter(|r| r.page == 2).count(), 2);
        let kern = sync.records.iter().find(|r| r.kind == Kind::Kern).unwrap();
        assert_eq!((kern.tag, kern.line, kern.h, kern.width), (7, 3, 31409439, 18341484));
        assert_eq!(pt(4736287).round(), 72.0);
    }

    #[test]
    fn pdf_spot_to_input_line() {
        let sync = SyncTex::parse(SAMPLE);
        let at = |x: i64, y: i64| sync.to_source(1, pt(x), pt(y)).map(|s| (s.file, s.line));
        let part = "/p/.build/part-a.tex".to_string();
        // On the first word of the paragraph, before any glue: the first record of the line.
        assert_eq!(at(9_000_000, 12_300_000), Some((part.clone(), 7)));
        // After the glue that the second source line starts with.
        assert_eq!(at(17_000_000, 12_400_000), Some((part.clone(), 8)));
        // On the heading.
        assert_eq!(at(9_500_000, 10_900_000), Some((part.clone(), 3)));
        // Beside the paragraph, in the margin: still that line.
        assert_eq!(at(2_000_000, 12_400_000), Some((part.clone(), 7)));
        assert_eq!(sync.to_source(2, 72.0, 100.0).map(|s| s.line), Some(4));
        assert_eq!(sync.to_source(3, 72.0, 100.0), None);
    }

    #[test]
    fn input_line_to_pdf_box() {
        let sync = SyncTex::parse(SAMPLE);
        let part_a = |f: &str| f.ends_with("/part-a.tex");
        let b = sync.to_pdf(part_a, 8).unwrap();
        assert_eq!(b.page, 1);
        // Line 8 starts mid-line, at its first glue.
        assert!((b.x - pt(16945644)).abs() < 1e-6, "{b:?}");
        assert!((b.x + b.width - pt(8799519 + 22609920)).abs() < 1e-6, "{b:?}");
        assert!((b.y - pt(12469403 - 462029)).abs() < 1e-6, "{b:?}");
        assert!((b.height - pt(462029 + 135003)).abs() < 1e-6, "{b:?}");
        // The heading's first record sits in its number's box, inside the heading line.
        assert!((sync.to_pdf(part_a, 3).unwrap().y - pt(11033313 - 619079)).abs() < 1e-6);
        assert_eq!(sync.to_pdf(part_a, 5), None);
        assert_eq!(sync.to_pdf(|f| f.ends_with("paper.tex"), 4).unwrap().page, 2);
    }

    #[test]
    fn reads_gzipped_files() {
        use std::io::Write;
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(SYNCTEX_FILE);
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(SAMPLE.as_bytes()).unwrap();
        std::fs::write(&path, gz.finish().unwrap()).unwrap();
        assert_eq!(SyncTex::read(&path).unwrap().records.len(), 17);
        assert!(SyncTex::read(&tmp.path().join("missing.gz")).is_err());
    }

    #[test]
    fn fragment_files_match_by_name() {
        let fragment = Fragment { part: "a.md".into(), name: "part-a".into() };
        assert!(is_fragment_file("/x/.build/part-a.tex", &fragment));
        assert!(is_fragment_file("part-a", &fragment));
        assert!(!is_fragment_file("/x/.build/part-a-2.tex", &fragment));
    }
}
