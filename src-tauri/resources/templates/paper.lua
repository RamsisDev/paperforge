-- Paper conventions on top of Pandoc Markdown:
--   one part = one chapter    -> in chapter templates, later `#` headings of a part are sections
--   @fig:x / @tbl:x / @sec:x  -> \ref{...}      @eq:x -> \eqref{...}
--   $$ ... $$ {#eq:x}         -> numbered equation with \label
--   {.wide} on a figure/table -> spans both columns (figure* / table*)
--   tables                    -> table float + tabular (longtable breaks two-column classes)

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

local function read_meta(meta)
  numeric_only = meta["numeric-only-citations"] == true
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

return {
  { Meta = read_meta, Pandoc = scope_headings_to_file },
  { Cite = Cite, Para = Para, Figure = Figure, Table = Table },
}
