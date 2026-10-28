-- Paper conventions on top of Pandoc Markdown:
--   one part = one chapter    -> in chapter templates, later `#` headings of a part are sections
--   @fig:x / @tbl:x / @sec:x  -> \ref{...}      @eq:x -> \eqref{...}
--   $$ ... $$ {#eq:x}         -> numbered equation with \label
--   {.wide} on a figure/table -> spans both columns (figure* / table*)
--   tables                    -> table float + tabular (longtable breaks two-column classes)
--   <!--pf:N--> block markers -> %PF:N comment lines (Markdown line N starts the next block)
--   ::: {.x} / [..]{.x}       -> \begin{pf-x}...\end{pf-x} / \pfstylex{...} for project styles
--   [..]{.comment …}          -> review markup: highlighted with a note in the review PDF
--                                (`pf-review` metadata), the bare text in the final one
--   [..]{.insertion …}        -> underlined in the review PDF, the bare text in the final one
--   [..]{.deletion …}         -> struck through in the review PDF, left out of the final one

local REF_PREFIXES = { fig = true, tbl = true, eq = true, sec = true }

local function is_ref(key)
  local prefix = key:match("^(%a+):")
  return prefix ~= nil and REF_PREFIXES[prefix] == true
end

-- Fragment options: the document's own options carry the standalone template.
local FRAGMENT_OPTIONS = { cite_method = PANDOC_WRITER_OPTIONS.cite_method }

local function latex(blocks)
  local doc = pandoc.Pandoc(blocks)
  local out = pandoc.write(doc, "latex", FRAGMENT_OPTIONS)
  return (out:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function latex_inlines(inlines)
  return latex({ pandoc.Plain(inlines) })
end

-- Set from metadata for numeric-only BibTeX styles, which cannot print author names.
local numeric_only = false

-- Styled classes from `pf-styles` metadata (`div:note span:smallcaps`), each mapped to its
-- LaTeX environment or command name as `styles.rs` defines them in the preamble.
local div_styles = {}
local span_styles = {}

local function style_command(name)
  local encoded = name:gsub("%d", function(d) return string.char(65 + tonumber(d)) end):gsub("%-", "Z")
  return "\\pfstyle" .. encoded
end

-- Set from `pf-review` metadata: the review PDF renders review markup, the final PDF strips it.
local review = false

local function read_meta(meta)
  numeric_only = meta["numeric-only-citations"] == true
  review = meta["pf-review"] == true
  local spec = meta["pf-styles"]
  if spec then
    for kind, name in pandoc.utils.stringify(spec):gmatch("(%a+):([%w%-]+)") do
      if kind == "div" then
        div_styles[name] = "pf-" .. name
      elseif kind == "span" then
        span_styles[name] = style_command(name)
      end
    end
  end
end

-- Set for the parts of chapter templates, where a part is one chapter. Every later heading at
-- the level of the part's first heading becomes its child (one level deeper, at most 6), so a
-- second `#` is a section of the chapter rather than a new chapter. Deeper headings keep their
-- level: a `##` already means a section. Identifiers and classes are untouched, and Pandoc
-- assigned the automatic ones while reading.
local function scope_headings_to_file(doc)
  if doc.meta["file-scoped-headings"] ~= true then
    return nil
  end
  local first_level = nil
  return doc:walk({
    Header = function(h)
      if first_level == nil then
        first_level = h.level
      elseif h.level == first_level then
        h.level = math.min(h.level + 1, 6)
        return h
      end
    end,
  })
end

local function Cite(el)
  local all_refs = true
  for _, c in ipairs(el.citations) do
    if not is_ref(c.id) then
      all_refs = false
    end
  end
  if not all_refs then
    if numeric_only then
      for _, c in ipairs(el.citations) do
        c.mode = "NormalCitation"
      end
      return el
    end
    return nil
  end
  local out = {}
  for i, c in ipairs(el.citations) do
    if i > 1 then
      table.insert(out, pandoc.Str(","))
      table.insert(out, pandoc.Space())
    end
    local cmd = c.id:match("^eq:") and "\\eqref" or "\\ref"
    table.insert(out, pandoc.RawInline("latex", cmd .. "{" .. c.id .. "}"))
  end
  return out
end

-- $$...$$ {#eq:x}
local function Para(el)
  local inlines = el.content
  if #inlines == 0 then
    return {}
  end
  local changed = false
  local out = {}
  local i = 1
  while i <= #inlines do
    local cur = inlines[i]
    if cur.t == "Math" and cur.mathtype == "DisplayMath" then
      local j = i + 1
      if inlines[j] and inlines[j].t == "Space" then
        j = j + 1
      end
      local label = inlines[j] and inlines[j].t == "Str" and inlines[j].text:match("^{#(eq:[^}]+)}$")
      if label then
        table.insert(out, pandoc.RawInline("latex",
          "\\begin{equation}" .. cur.text .. "\\label{" .. label .. "}\\end{equation}"))
        changed = true
        i = j + 1
      else
        table.insert(out, cur)
        i = i + 1
      end
    else
      table.insert(out, cur)
      i = i + 1
    end
  end
  if not changed then
    return nil
  end
  if #out == 1 then
    return pandoc.RawBlock("latex", out[1].text)
  end
  return pandoc.Para(out)
end

local function has_wide_class(el)
  local wide = el.classes and el.classes:includes("wide")
  pandoc.walk_block(el, {
    Image = function(img)
      if img.classes:includes("wide") then
        wide = true
      end
    end,
  })
  return wide
end

local function Figure(fig)
  if not has_wide_class(fig) then
    return nil
  end
  local tex = latex({ fig })
  tex = tex:gsub("\\begin{figure}", "\\begin{figure*}", 1):gsub("\\end{figure}", "\\end{figure*}", 1)
  return pandoc.RawBlock("latex", tex)
end

local ALIGN = { AlignLeft = "l", AlignRight = "r", AlignCenter = "c", AlignDefault = "l" }
local RAGGED = {
  AlignLeft = "\\raggedright",
  AlignRight = "\\raggedleft",
  AlignCenter = "\\centering",
  AlignDefault = "\\raggedright",
}

local function split_caption_label(inlines)
  local last = inlines[#inlines]
  if last and last.t == "Str" then
    local id = last.text:match("^{#([^}]+)}$")
    if id then
      local rest = pandoc.List(inlines):clone()
      rest:remove(#rest)
      while #rest > 0 and rest[#rest].t == "Space" do
        rest:remove(#rest)
      end
      return rest, id
    end
  end
  return inlines, nil
end

local function Table(tbl)
  local simple = pandoc.utils.to_simple_table(tbl)
  local caption, caption_id = split_caption_label(simple.caption)
  local id = tbl.identifier ~= "" and tbl.identifier or caption_id
  local wide = tbl.classes:includes("wide")

  local fixed_widths = false
  for _, w in ipairs(simple.widths) do
    if w > 0 then
      fixed_widths = true
    end
  end
  local cols = {}
  for i, align in ipairs(simple.aligns) do
    if fixed_widths then
      cols[i] = string.format(">{%s\\arraybackslash}p{\\dimexpr %.3f\\linewidth-2\\tabcolsep\\relax}",
        RAGGED[align], simple.widths[i])
    else
      cols[i] = ALIGN[align]
    end
  end

  local function row(cells)
    local rendered = {}
    for i, cell in ipairs(cells) do
      rendered[i] = latex(cell)
    end
    return table.concat(rendered, " & ") .. " \\\\"
  end

  local env = wide and "table*" or "table"
  local lines = { "\\begin{" .. env .. "}[htbp]", "\\centering" }
  if #caption > 0 then
    table.insert(lines, "\\caption{" .. latex_inlines(caption) .. "}" ..
      (id and ("\\label{" .. id .. "}") or ""))
  end
  table.insert(lines, "\\begin{tabular}{" .. table.concat(cols) .. "}")
  table.insert(lines, "\\toprule")
  local has_header = false
  for _, cell in ipairs(simple.headers) do
    if #cell > 0 then
      has_header = true
    end
  end
  if has_header then
    table.insert(lines, row(simple.headers))
    table.insert(lines, "\\midrule")
  end
  for _, r in ipairs(simple.rows) do
    table.insert(lines, row(r))
  end
  table.insert(lines, "\\bottomrule")
  table.insert(lines, "\\end{tabular}")
  table.insert(lines, "\\end{" .. env .. "}")
  return pandoc.RawBlock("latex", table.concat(lines, "\n"))
end

-- The element's styled classes, in order, and the element without them, or nil when it has none.
-- Classes the project does not style (Pandoc's own `.smallcaps`, `.mark`, …) stay on it.
local function split_styles(el, known)
  local styled, rest = {}, pandoc.List()
  for _, class in ipairs(el.classes) do
    if known[class] then
      table.insert(styled, known[class])
    else
      rest:insert(class)
    end
  end
  if #styled == 0 then
    return nil
  end
  el.classes = rest
  return styled, el
end

local function Div(el)
  local styled, inner = split_styles(el, div_styles)
  if not styled then
    return nil
  end
  local blocks = pandoc.List({ inner })
  if inner.identifier == "" and #inner.classes == 0 and #inner.attributes == 0 then
    blocks = inner.content
  end
  for i = #styled, 1, -1 do
    blocks:insert(1, pandoc.RawBlock("latex", "\\begin{" .. styled[i] .. "}"))
    blocks:insert(pandoc.RawBlock("latex", "\\end{" .. styled[i] .. "}"))
  end
  return blocks
end

-- Review markup ------------------------------------------------------------------------------

local PLAIN_INLINES = { Str = true, Space = true, SoftBreak = true }
local SPACE_INLINES = { Space = true, SoftBreak = true }
-- Formatting kept around its marked content.
local WRAPPER_INLINES = {
  Emph = true, Strong = true, Underline = true, SmallCaps = true, Strikeout = true,
  Superscript = true, Subscript = true, Quoted = true, Span = true,
}

-- Line breaks stay where the Markdown has them, as in the fragment, so lines keep mapping back.
local REVIEW_OPTIONS = { cite_method = PANDOC_WRITER_OPTIONS.cite_method, wrap_text = "wrap-preserve" }

local function review_latex(inlines)
  local out = pandoc.write(pandoc.Pandoc({ pandoc.Plain(inlines) }), "latex", REVIEW_OPTIONS)
  return (out:gsub("^%s+", ""):gsub("%s+$", ""))
end

-- The LaTeX of review markup already rendered, so an enclosing span does not mark it again.
local rendered = {}

local function rendered_latex(text)
  rendered[text] = true
  return pandoc.RawInline("latex", text)
end

-- Words whose LaTeX is a command or a group (`\%`, `\textbackslash{}`, `~`) are not plain for
-- soul, which reads its argument token by token.
local function soul_safe(str)
  return not review_latex({ str }):find("[\\{}~$^]")
end

-- Marks inlines for the review PDF. Runs of plain words go through `text_cmd` (built on soul's
-- `\hl`, which breaks lines but fails on math, citations and most commands); every other inline
-- goes through `box_cmd` (an unbreakable box); formatting stays around its marked content and
-- footnotes stay unmarked, since a box would swallow them. Spaces at the edges of a run stay
-- outside it.
local function review_mark(inlines, text_cmd, box_cmd)
  local out = pandoc.List()
  local run = pandoc.List()
  local function flush()
    while #run > 0 and SPACE_INLINES[run[1].t] do
      out:insert(run:remove(1))
    end
    local trailing = pandoc.List()
    while #run > 0 and SPACE_INLINES[run[#run].t] do
      trailing:insert(1, run:remove())
    end
    if #run > 0 then
      out:insert(rendered_latex(text_cmd .. "{" .. review_latex(run) .. "}"))
    end
    out:extend(trailing)
    run = pandoc.List()
  end
  for _, el in ipairs(inlines) do
    if PLAIN_INLINES[el.t] and (el.t ~= "Str" or soul_safe(el)) then
      run:insert(el)
    else
      flush()
      if WRAPPER_INLINES[el.t] then
        el.content = review_mark(el.content, text_cmd, box_cmd)
        out:insert(el)
      elseif el.t == "Note" or (el.t == "RawInline" and rendered[el.text]) then
        out:insert(el)
      else
        out:insert(rendered_latex(box_cmd .. "{" .. review_latex({ el }) .. "}"))
      end
    end
  end
  flush()
  return out
end

-- An attribute as literal LaTeX text.
local function attribute_latex(el, key)
  return review_latex(pandoc.Inlines(el.attributes[key] or ""))
end

local function unwrap(el)
  return el.content
end

-- Set on comments whose note cannot go into the margin: `\marginpar` fails in footnotes, floats
-- and table cells, and a heading would repeat it in the table of contents.
local INLINE_NOTE = "pf-inline-note"

local function mark_inline_notes(el)
  return el:walk({
    Span = function(span)
      if span.classes:includes("comment") then
        span.attributes[INLINE_NOTE] = "true"
        return span
      end
    end,
  })
end

local function review_comment(el)
  if el.attributes.resolved == "true" then
    return el.content
  end
  local note = el.attributes[INLINE_NOTE] and "\\pfcommentinline" or "\\pfcommentnote"
  local out = review_mark(el.content, "\\pfcommenthl", "\\pfcommentbox")
  out:insert(rendered_latex(note .. "{" .. attribute_latex(el, "author") .. "}{" .. attribute_latex(el, "text") .. "}"))
  return out
end

-- Left where the final PDF drops a deletion, so `close_deletions` can merge the spaces around it
-- the way Pandoc reads the text once the deletion is accepted.
local DELETED = "pf-deleted"

local function drop(_)
  return { pandoc.RawInline(DELETED, "") }
end

local function review_insertion(el)
  return review_mark(el.content, "\\pfinsertionhl", "\\pfinsertionbox")
end

local function review_deletion(el)
  return review_mark(el.content, "\\pfdeletionhl", "\\pfdeletionbox")
end

-- Span classes of review markup: `review` renders a span in the review PDF and `final` in the
-- final one, both returning inlines. The LaTeX commands they emit are defined in `review.rs`.
local REVIEW_SPANS = {
  comment = { review = review_comment, final = unwrap },
  insertion = { review = review_insertion, final = unwrap },
  deletion = { review = review_deletion, final = drop },
}

local function is_deleted(el)
  return el.t == "RawInline" and el.format == DELETED
end

-- Where deletions were dropped, the spaces around them become one (a line break if one of them
-- is), and none at the edges of the list, as Pandoc reads the text once they are accepted.
local function close_deletions(inlines)
  if not inlines:find_if(is_deleted) then
    return nil
  end
  local out = pandoc.List()
  local gap = pandoc.List()
  local function flush(at_end)
    local dropped = gap:find_if(is_deleted)
    if not dropped then
      out:extend(gap)
    elseif #out > 0 and not at_end then
      local spaces = gap:filter(function(el) return SPACE_INLINES[el.t] end)
      if #spaces > 0 then
        out:insert(spaces:find_if(function(el) return el.t == "SoftBreak" end) or spaces[1])
      end
    end
    gap = pandoc.List()
  end
  for _, el in ipairs(inlines) do
    if is_deleted(el) or SPACE_INLINES[el.t] then
      gap:insert(el)
    else
      flush(false)
      out:insert(el)
    end
  end
  flush(true)
  return out
end

-- A block that only held deletions, such as a list item.
local function drop_emptied(el)
  if #el.content == 0 then
    return {}
  end
end

local function review_kind(el)
  for _, class in ipairs(el.classes) do
    if REVIEW_SPANS[class] then
      return REVIEW_SPANS[class]
    end
  end
end

local function Span(el)
  local kind = review_kind(el)
  if kind then
    return review and kind.review(el) or kind.final(el)
  end
  local styled, inner = split_styles(el, span_styles)
  if not styled then
    return nil
  end
  local inlines = pandoc.List({ inner })
  if inner.identifier == "" and #inner.classes == 0 and #inner.attributes == 0 then
    inlines = inner.content
  end
  for i = #styled, 1, -1 do
    inlines:insert(1, pandoc.RawInline("latex", styled[i] .. "{"))
    inlines:insert(pandoc.RawInline("latex", "}"))
  end
  return inlines
end

-- The reader turns `[x]{.smallcaps}` and `[x]{.underline}` into elements of their own.
local function styled_element(class)
  return function(el)
    local command = span_styles[class]
    if not command then
      return nil
    end
    local inlines = pandoc.List(el.content)
    inlines:insert(1, pandoc.RawInline("latex", command .. "{"))
    inlines:insert(pandoc.RawInline("latex", "}"))
    return inlines
  end
end

local function prepare_review(doc)
  if not review then
    return nil
  end
  return doc:walk({
    Note = mark_inline_notes, Figure = mark_inline_notes, Table = mark_inline_notes, Header = mark_inline_notes,
  })
end

local function RawBlock(el)
  if el.format ~= "html" then
    return nil
  end
  local line = el.text:match("^<!%-%-pf:(%d+)%-%->$")
  if line then
    return pandoc.RawBlock("latex", "%PF:" .. line)
  end
end

return {
  { Meta = read_meta, Pandoc = scope_headings_to_file },
  { Pandoc = prepare_review },
  { Cite = Cite, Para = Para, Figure = Figure, Table = Table, RawBlock = RawBlock, Inlines = close_deletions,
    Plain = drop_emptied, Div = Div, Span = Span,
    SmallCaps = styled_element("smallcaps"), Underline = styled_element("underline") },
}
