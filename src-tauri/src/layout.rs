//! Page setup of the generic templates (`article`, `report`, `book`): margins, line spacing,
//! main font, running header and footer, line numbers. Journal templates fix all of this and do
//! not use the variables.
//!
//! Paper size, font size and columns are not here: they are `\documentclass` options, and live in
//! `PaperMeta::class_options` only, where they replace the template's default of the same kind.

use serde::{Deserialize, Serialize};

/// Header and footer text stands for `\thepage` where it says this.
pub const PAGE_PLACEHOLDER: &str = "{page}";
const MAX_SLOT_CHARS: usize = 120;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Layout {
    pub margins: Margins,
    pub line_spacing: LineSpacing,
    pub font: MainFont,
    pub header: Slots,
    pub footer: Slots,
    pub line_numbers: bool,
}

impl Default for Layout {
    fn default() -> Self {
        Self {
            margins: Margins::default(),
            line_spacing: LineSpacing::Single,
            font: MainFont::LatinModern,
            header: Slots::default(),
            footer: Slots::default(),
            line_numbers: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Margins {
    pub unit: Unit,
    pub top: f64,
    pub bottom: f64,
    /// The inner margin on two-sided pages (`book`).
    pub left: f64,
    pub right: f64,
}

impl Default for Margins {
    fn default() -> Self {
        Self { unit: Unit::Cm, top: 2.5, bottom: 2.5, left: 2.5, right: 2.5 }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    Cm,
    Mm,
    In,
}

impl Unit {
    fn name(self) -> &'static str {
        match self {
            Unit::Cm => "cm",
            Unit::Mm => "mm",
            Unit::In => "in",
        }
    }

    /// A margin wider than a sheet is a typo, not a layout.
    fn max_margin(self) -> f64 {
        match self {
            Unit::Cm => 10.0,
            Unit::Mm => 100.0,
            Unit::In => 4.0,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LineSpacing {
    Single,
    Onehalf,
    Double,
}

/// Only fonts in the offline TeX cache, so a font change never needs the network.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum MainFont {
    LatinModern,
    /// TeX Gyre Termes, a Times clone (the IEEE template's font).
    Termes,
    /// Linux Libertine (the ACM template's font).
    Libertine,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct Slots {
    pub left: String,
    pub center: String,
    pub right: String,
}

impl Slots {
    fn is_empty(&self) -> bool {
        [&self.left, &self.center, &self.right].iter().all(|s| s.trim().is_empty())
    }

    /// `\fancyhead[L]{…}`-style lines for the non-empty slots.
    fn commands(&self, command: &str) -> Vec<String> {
        [("L", &self.left), ("C", &self.center), ("R", &self.right)]
            .into_iter()
            .filter(|(_, text)| !text.trim().is_empty())
            .map(|(at, text)| format!("\\{command}[{at}]{{{}}}", slot_latex(text)))
            .collect()
    }
}

/// Template variables: `geometry` (the options of `\usepackage[…]{geometry}`, always set) and
/// `page-setup` (preamble lines after it, only when something differs from the default).
pub fn variables(layout: &Layout) -> Vec<(&'static str, String)> {
    let mut variables = vec![("geometry", geometry_options(&layout.margins))];
    let setup = preamble_lines(layout);
    if !setup.is_empty() {
        variables.push(("page-setup", setup.join("\n")));
    }
    variables
}

fn geometry_options(m: &Margins) -> String {
    let unit = m.unit.name();
    let length = |v: f64| format!("{}{unit}", number(v.clamp(0.0, m.unit.max_margin())));
    let [top, bottom, left, right] = [m.top, m.bottom, m.left, m.right].map(length);
    if [&bottom, &left, &right].iter().all(|v| **v == top) {
        format!("margin={top}")
    } else {
        format!("top={top},bottom={bottom},left={left},right={right}")
    }
}

/// Up to two decimals without trailing zeros; NaN (never produced by JSON) reads as 0.
fn number(v: f64) -> String {
    let v = if v.is_finite() { v } else { 0.0 };
    let s = format!("{v:.2}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-0" { "0".into() } else { s.into() }
}

fn preamble_lines(layout: &Layout) -> Vec<String> {
    let mut lines = Vec::new();
    match layout.font {
        MainFont::LatinModern => {}
        MainFont::Termes => lines.push(
            "\\setmainfont{texgyretermes}[Extension=.otf,UprightFont=*-regular,BoldFont=*-bold,\
             ItalicFont=*-italic,BoldItalicFont=*-bolditalic]"
                .into(),
        ),
        MainFont::Libertine => lines.push(
            "\\setmainfont{LinLibertine}[Extension=.otf,UprightFont=*_R,BoldFont=*_RB,\
             ItalicFont=*_RI,BoldItalicFont=*_RBI]"
                .into(),
        ),
    }
    match layout.line_spacing {
        LineSpacing::Single => {}
        LineSpacing::Onehalf => lines.push("\\usepackage[onehalfspacing]{setspace}".into()),
        LineSpacing::Double => lines.push("\\usepackage[doublespacing]{setspace}".into()),
    }
    if !(layout.header.is_empty() && layout.footer.is_empty()) {
        lines.extend(running_heads(&layout.header, &layout.footer));
    }
    if layout.line_numbers {
        lines.push("\\usepackage{lineno}".into());
        lines.push("\\linenumbers".into());
    }
    lines
}

/// An empty footer keeps the classes' centered page number. Chapter and title pages (LaTeX's
/// `plain` style) keep the footer but drop the header.
fn running_heads(header: &Slots, footer: &Slots) -> Vec<String> {
    let footer = if footer.is_empty() {
        vec!["\\fancyfoot[C]{\\thepage}".to_string()]
    } else {
        footer.commands("fancyfoot")
    };
    let mut lines = vec![
        "\\usepackage{fancyhdr}".to_string(),
        "\\setlength{\\headheight}{15pt}".into(),
        "\\pagestyle{fancy}".into(),
        "\\fancyhf{}".into(),
        "\\renewcommand{\\headrulewidth}{0pt}".into(),
    ];
    lines.extend(header.commands("fancyhead"));
    lines.extend(footer.iter().cloned());
    lines.push(format!("\\fancypagestyle{{plain}}{{\\fancyhf{{}}{}}}", footer.concat()));
    lines
}

/// Header and footer text is literal: LaTeX specials are escaped, `{page}` prints the page number.
fn slot_latex(text: &str) -> String {
    let text: String = text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_SLOT_CHARS).collect();
    text.split(PAGE_PLACEHOLDER).map(escape_latex).collect::<Vec<_>>().join("\\thepage{}")
}

fn escape_latex(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\textbackslash{}"),
            '^' => out.push_str("\\textasciicircum{}"),
            '~' => out.push_str("\\textasciitilde{}"),
            '{' | '}' | '$' | '&' | '#' | '_' | '%' => {
                out.push('\\');
                out.push(c);
            }
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(edit: impl FnOnce(&mut Layout)) -> Layout {
        let mut layout = Layout::default();
        edit(&mut layout);
        layout
    }

    fn setup(layout: &Layout) -> Vec<String> {
        preamble_lines(layout)
    }

    #[test]
    fn default_layout_is_the_old_hard_coded_geometry_and_nothing_else() {
        assert_eq!(variables(&Layout::default()), [("geometry", "margin=2.5cm".to_string())]);
    }

    #[test]
    fn margins_map_to_geometry_options() {
        let uniform = Margins { unit: Unit::Mm, top: 20.0, bottom: 20.0, left: 20.0, right: 20.0 };
        assert_eq!(geometry_options(&uniform), "margin=20mm");
        let mixed = Margins { unit: Unit::In, top: 1.0, bottom: 1.25, left: 1.5, right: 0.755 };
        assert_eq!(geometry_options(&mixed), "top=1in,bottom=1.25in,left=1.5in,right=0.76in");
    }

    #[test]
    fn margins_are_clamped_to_the_sheet() {
        let wild = Margins { unit: Unit::Cm, top: -3.0, bottom: 250.0, left: f64::NAN, right: 2.0 };
        assert_eq!(geometry_options(&wild), "top=0cm,bottom=10cm,left=0cm,right=2cm");
        assert_eq!(number(0.0), "0");
        assert_eq!(number(-0.001), "0");
        assert_eq!(number(3.0), "3");
    }

    #[test]
    fn spacing_font_and_line_numbers_map_to_packages() {
        assert_eq!(setup(&layout(|l| l.line_spacing = LineSpacing::Onehalf)), ["\\usepackage[onehalfspacing]{setspace}"]);
        assert_eq!(setup(&layout(|l| l.line_spacing = LineSpacing::Double)), ["\\usepackage[doublespacing]{setspace}"]);
        assert_eq!(setup(&layout(|l| l.line_numbers = true)), ["\\usepackage{lineno}", "\\linenumbers"]);
        let termes = setup(&layout(|l| l.font = MainFont::Termes));
        assert!(termes[0].starts_with("\\setmainfont{texgyretermes}[Extension=.otf,"), "{termes:?}");
        let libertine = setup(&layout(|l| l.font = MainFont::Libertine));
        assert!(libertine[0].contains("{LinLibertine}") && libertine[0].contains("BoldFont=*_RB"), "{libertine:?}");
    }

    #[test]
    fn header_and_footer_map_to_fancyhdr() {
        let both = layout(|l| {
            l.header = Slots { left: "Draft".into(), right: "A & B".into(), ..Slots::default() };
            l.footer = Slots { center: "Page {page}".into(), ..Slots::default() };
        });
        assert_eq!(
            setup(&both),
            [
                "\\usepackage{fancyhdr}",
                "\\setlength{\\headheight}{15pt}",
                "\\pagestyle{fancy}",
                "\\fancyhf{}",
                "\\renewcommand{\\headrulewidth}{0pt}",
                "\\fancyhead[L]{Draft}",
                "\\fancyhead[R]{A \\& B}",
                "\\fancyfoot[C]{Page \\thepage{}}",
                "\\fancypagestyle{plain}{\\fancyhf{}\\fancyfoot[C]{Page \\thepage{}}}",
            ]
        );
        let header_only = setup(&layout(|l| l.header.center = "Title".into()));
        assert!(header_only.contains(&"\\fancyfoot[C]{\\thepage}".to_string()), "{header_only:?}");
        assert!(setup(&layout(|l| l.footer.left = "  ".into())).is_empty());
    }

    #[test]
    fn slot_text_is_literal_latex() {
        assert_eq!(slot_latex(r"50% \relax {x}_1 #2 $y$ ~^"), r"50\% \textbackslash{}relax \{x\}\_1 \#2 \$y\$ \textasciitilde{}\textasciicircum{}");
        assert_eq!(slot_latex("{page} of\nmany\t{page}"), "\\thepage{} of many \\thepage{}");
        assert_eq!(slot_latex(&"x".repeat(500)).len(), MAX_SLOT_CHARS);
    }

    #[test]
    fn layout_json_is_camel_case_and_partial_objects_default() {
        let layout: Layout = serde_json::from_str(r#"{"lineSpacing":"onehalf","margins":{"top":3}}"#).unwrap();
        assert_eq!(layout.line_spacing, LineSpacing::Onehalf);
        assert_eq!(layout.margins, Margins { top: 3.0, ..Margins::default() });
        assert_eq!(layout.font, MainFont::LatinModern);
        let json = serde_json::to_value(Layout::default()).unwrap();
        assert_eq!(json["font"], "latinModern");
        assert_eq!(json["margins"]["unit"], "cm");
        assert_eq!(json["lineNumbers"], false);
        for bad in [r#"{"lineSpacing":"triple"}"#, r#"{"font":"Comic Sans"}"#, r#"{"margins":{"unit":"pt"}}"#] {
            assert!(serde_json::from_str::<Layout>(bad).is_err(), "{bad}");
        }
    }
}
