//! The review PDF: the same document with its review markup rendered (comments, insertions and
//! deletions), compiled into a build directory of its own so switching between the review and
//! the final PDF never invalidates the other's fragments and .aux files.
//!
//! `paper.lua` reads [`METADATA_KEY`] and, per span class in its `REVIEW_SPANS` table, emits
//! LaTeX commands that [`PREAMBLE`] defines. The final PDF strips the markup in the filter, so
//! it needs no definitions. Every package used here is in the offline cache (`soul` and `xcolor`
//! come with every template's `common.tex`; `calc` too). The notes use the upright shape of the
//! body font only: bold, italic and sans faces at small sizes are separate font files that the
//! cache does not have for every size.
//!
//! Adding a kind of review markup: a `REVIEW_SPANS` entry in `paper.lua` (its `review` function
//! can reuse `review_mark` with two commands of its own: one for runs of plain words, built on
//! soul, and one boxing anything else) and the definitions of those commands here.

use std::path::{Path, PathBuf};

/// Pandoc metadata that switches `paper.lua` to review rendering.
pub const METADATA_KEY: &str = "pf-review";

/// Subdirectory of the build directory holding the review build.
pub const BUILD_SUBDIR: &str = "review";

/// LaTeX for the commands the filter emits in review mode, added to the preamble.
///
/// A comment's note (`\pfcommentnote`) goes into the margin when the margins leave room for it
/// and TeX is not in a box; otherwise, and for comments the filter found in footnotes, floats,
/// tables and headings (`\pfcommentinline`), where `\marginpar` is an error, it is printed
/// inline after the highlighted text.
///
/// Insertions are colored and underlined, deletions colored and struck through: soul's `\ul`
/// and `\st` for plain words, `\underline` and a rule over a box for anything else.
pub const PREAMBLE: &str = r"\makeatletter
\definecolor{pfcomment}{RGB}{255,226,122}
\definecolor{pfcommentink}{RGB}{150,80,0}
\definecolor{pfcommentpaper}{RGB}{255,247,214}
\newcounter{pfcomment}
\newif\ifpf@marginnotes
\newlength\pf@margin
\newlength\pf@notewidth
\AtBeginDocument{%
  \setlength\pf@margin{\paperwidth-1in-\hoffset-\oddsidemargin-\textwidth}%
  \ifdim\dimexpr1in+\hoffset+\oddsidemargin\relax<\pf@margin
    \setlength\pf@margin{1in+\hoffset+\oddsidemargin}\fi
  \if@twoside\ifdim\dimexpr1in+\hoffset+\evensidemargin\relax<\pf@margin
    \setlength\pf@margin{1in+\hoffset+\evensidemargin}\fi\fi
  \addtolength\pf@margin{-\marginparsep-4mm}%
  \ifdim\pf@margin<2cm\relax\pf@marginnotesfalse\else
    \pf@marginnotestrue\setlength\marginparwidth{\pf@margin}%
    \setlength\pf@notewidth{\marginparwidth-4pt-2\fboxrule}\fi}
\DeclareRobustCommand\pfcommenthl[1]{{\sethlcolor{pfcomment}\hl{#1}}}
\DeclareRobustCommand\pfcommentbox[1]{{\setlength\fboxsep{0pt}\colorbox{pfcomment}{\strut#1}}}
\newcommand\pf@commentlabel[1]{C\thepfcomment\ifx\relax#1\relax\else\ #1\fi:}
\DeclareRobustCommand\pfcommentnote[2]{%
  \stepcounter{pfcomment}%
  \ifinner\pf@inlinenote{#1}{#2}\else\ifpf@marginnotes
    \textsuperscript{\textcolor{pfcommentink}{C\thepfcomment}}%
    \marginpar{\setlength\fboxsep{2pt}\fcolorbox{pfcommentink}{pfcommentpaper}{%
      \parbox{\pf@notewidth}{\raggedright\footnotesize
        \textcolor{pfcommentink}{\pf@commentlabel{#1}} #2}}}%
  \else\pf@inlinenote{#1}{#2}\fi\fi}
\DeclareRobustCommand\pfcommentinline[2]{\stepcounter{pfcomment}\pf@inlinenote{#1}{#2}}
\newcommand\pf@inlinenote[2]{%
  {\footnotesize\textcolor{pfcommentink}{[\pf@commentlabel{#1}} #2\textcolor{pfcommentink}{]}}}
\definecolor{pfinsertion}{RGB}{0,92,197}
\definecolor{pfdeletion}{RGB}{196,30,58}
\newsavebox\pf@changebox
\DeclareRobustCommand\pfinsertionhl[1]{{\color{pfinsertion}\setulcolor{pfinsertion}\ul{#1}}}
\DeclareRobustCommand\pfinsertionbox[1]{{\color{pfinsertion}\underline{#1}}}
\DeclareRobustCommand\pfdeletionhl[1]{{\color{pfdeletion}\setstcolor{pfdeletion}\st{#1}}}
\DeclareRobustCommand\pfdeletionbox[1]{{\color{pfdeletion}\sbox\pf@changebox{#1}%
  \rlap{\usebox\pf@changebox}\rule[.5ex]{\wd\pf@changebox}{.4pt}}}
\makeatother";

/// Where a build in this mode lives: the project's build directory, or its review subdirectory.
pub fn build_dir(build: &Path, review: bool) -> PathBuf {
    if review { build.join(BUILD_SUBDIR) } else { build.to_path_buf() }
}
