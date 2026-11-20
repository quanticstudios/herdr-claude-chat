// Markdown to blocks and inline spans for Claude's replies. Pure: no host imports, so `node md.check.mjs` runs it.

/**
 * Inline spans: `{t:"text",v}`, `{t:"code",v}`, `{t:"br"}`, `{t:"b"|"i"|"del",c}`,
 * `{t:"link",href,c}` and `{t:"file",path,line,c}` for `src/a.ts:47` style refs.
 */
export function inline(src) {
  // why: \u0000 marks a hard break (two trailing spaces or a backslash) so the scanner sees one line.
  return parseInline(src.replace(/(?: {2,}|\\)\n/g, "\u0000").replace(/\n/g, " "));
}

const PUNCT = /[!-\/:-@\[-`{-~]/;
const URL_RE = /^(?:https?:\/\/|www\.)[^\s<>]*[^\s<>.,;:!?'")\]*_~]/;
// why: a path needs a slash or a :line, so "1.2s" and "e.g." stay text while "src/a.ts" and "a.ts:4" link.
const FILE_RE = /^(?:\.{0,2}\/|~\/)?(?:[\w@.+-]+\/)+[\w@.+-]*\.\w+(?::\d+(?::\d+)?)?(?![\w\/])|^[\w@+-][\w@.+-]*\.[A-Za-z]\w*:\d+(?::\d+)?(?![\w\/])/;

function parseInline(s) {
  const out = [];
  let text = "";
  const flush = () => { if (text) { out.push({ t: "text", v: text }); text = ""; } };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const prev = i > 0 ? s[i - 1] : " ";
    if (ch === "\u0000") { flush(); out.push({ t: "br" }); i++; continue; }
    if (ch === "\\" && i + 1 < s.length && PUNCT.test(s[i + 1])) { text += s[i + 1]; i += 2; continue; }
    if (ch === "`") {
      const run = s.slice(i).match(/^`+/)[0];
      const end = s.indexOf(run, i + run.length);
      if (end > 0 && s[end + run.length] !== "`") {
        let v = s.slice(i + run.length, end);
        if (/^ .* $/.test(v) && v.trim()) v = v.slice(1, -1);
        flush();
        const ref = fileRef(v);
        out.push(ref ? { t: "file", ...ref, c: [{ t: "code", v }] } : { t: "code", v });
        i = end + run.length;
        continue;
      }
      text += run; i += run.length; continue;
    }
    if (ch === "[") {
      const m = matchLink(s, i);
      if (m) {
        flush();
        const c = parseInline(m.label);
        const ref = fileRef(m.href);
        out.push(ref && !/^\w+:\/\//.test(m.href) ? { t: "file", ...ref, c } : { t: "link", href: m.href, c });
        i = m.end;
        continue;
      }
    }
    if (ch === "<") {
      const m = s.slice(i).match(/^<((?:https?|mailto):[^\s<>]+)>/);
      if (m) { flush(); out.push({ t: "link", href: m[1], c: [{ t: "text", v: m[1] }] }); i += m[0].length; continue; }
      const br = s.slice(i).match(/^<br\s*\/?>/i);
      if (br) { flush(); out.push({ t: "br" }); i += br[0].length; continue; }
    }
    if ((ch === "*" || ch === "_" || ch === "~") && !(ch === "_" && /\w/.test(prev))) {
      const em = matchEmphasis(s, i);
      if (em) {
        flush();
        out.push(em.node);
        i = em.end;
        continue;
      }
    }
    if (/[\s(\[{"']/.test(prev) || i === 0) {
      const rest = s.slice(i);
      const u = rest.match(URL_RE);
      if (u) {
        flush();
        const href = u[0].startsWith("www.") ? "https://" + u[0] : u[0];
        out.push({ t: "link", href, c: [{ t: "text", v: u[0] }] });
        i += u[0].length;
        continue;
      }
      const f = rest.match(FILE_RE);
      if (f) {
        const v = f[0].replace(/[.,;:]+$/, "");
        flush();
        out.push({ t: "file", ...fileRef(v), c: [{ t: "text", v }] });
        i += v.length;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

/** Splits `src/a.ts:47:3` into a path and a line, or null when `s` is not a file reference. */
export function fileRef(s) {
  const m = s.match(FILE_RE);
  if (!m || m[0] !== s) return null;
  const [, path, line] = s.match(/^(.*?)(?::(\d+))?(?::\d+)?$/);
  return line ? { path, line: Number(line) } : { path };
}

function matchLink(s, i) {
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    if (s[j] === "\\") { j++; continue; }
    if (s[j] === "`") { const e = s.indexOf("`", j + 1); if (e > 0) { j = e; continue; } }
    if (s[j] === "[") depth++;
    else if (s[j] === "]" && --depth === 0) break;
  }
  if (j >= s.length || s[j + 1] !== "(") return null;
  const m = s.slice(j + 2).match(/^\s*<?([^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)>?(?:\s+"[^"]*")?\s*\)/);
  if (!m) return null;
  return { label: s.slice(i + 1, j), href: m[1], end: j + 2 + m[0].length };
}

function matchEmphasis(s, i) {
  const ch = s[i];
  let n = s.slice(i).match(ch === "*" ? /^\*+/ : ch === "_" ? /^_+/ : /^~+/)[0].length;
  if (ch === "~" && n !== 2) return null;
  if (n > 3) return null;
  const next = s[i + n];
  if (next === undefined || /\s/.test(next)) return null;
  for (let k = n; k >= 1; k--) {
    const close = findCloser(s, i + k, ch, k);
    if (close < 0) continue;
    const inner = s.slice(i + k, close);
    let c = parseInline(inner);
    let node;
    if (ch === "~") node = { t: "del", c };
    else if (k === 3) node = { t: "b", c: [{ t: "i", c }] };
    else node = { t: k === 2 ? "b" : "i", c };
    // why: "***a** b*" closes the bold first; the leftover opener wraps the rest as italic.
    if (k < n) {
      const outer = findCloser(s, close + k, ch, n - k);
      if (outer < 0) return { node: { t: "text", v: ch.repeat(n - k) }, end: i + n - k };
      const tail = parseInline(s.slice(close + k, outer));
      return { node: { t: n - k === 2 ? "b" : "i", c: [node, ...tail] }, end: outer + n - k };
    }
    return { node, end: close + k };
  }
  return null;
}

function findCloser(s, from, ch, k) {
  const delim = ch.repeat(k);
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") { j++; continue; }
    if (c === "`") {
      const run = s.slice(j).match(/^`+/)[0];
      const e = s.indexOf(run, j + run.length);
      if (e > 0) { j = e + run.length - 1; continue; }
      j += run.length - 1;
      continue;
    }
    if (c !== ch) continue;
    const run = s.slice(j).match(ch === "*" ? /^\*+/ : ch === "_" ? /^_+/ : /^~+/)[0].length;
    if (j === from || /\s/.test(s[j - 1])) { j += run - 1; continue; }
    if (ch === "_" && /\w/.test(s[j + run] ?? "")) { j += run - 1; continue; }
    if (run === k || (run === 3 && k < 3)) return j + (run - k);
    if (run > k && k === 1) { j += run - 1; continue; }
    if (run < k) { j += run - 1; continue; }
    return j;
  }
  return -1;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Spans as the HTML TextView draws; file refs become `file:///<encoded path>#L<line>` links. */
export function toHtml(spans) {
  return spans.map((n) => {
    switch (n.t) {
      case "text": return esc(n.v);
      case "code": return `<code>${esc(n.v)}</code>`;
      case "br": return "<br>";
      case "b": return `<strong>${toHtml(n.c)}</strong>`;
      case "i": return `<em>${toHtml(n.c)}</em>`;
      case "del": return `<del>${toHtml(n.c)}</del>`;
      case "link": return `<a href="${esc(n.href)}">${toHtml(n.c)}</a>`;
      case "file": return `<a href="${fileHref(n.path, n.line)}">${toHtml(n.c)}</a>`;
    }
    return "";
  }).join("");
}

/** The link a file ref carries, so a click comes back as one string. */
export function fileHref(path, line) {
  return "file:///" + encodeURIComponent(path) + (line ? `#L${line}` : "");
}

/** Reads `fileHref`'s link back, or null for any other URL. */
export function readFileHref(url) {
  const m = url.match(/^file:\/\/\/([^#]*)(?:#L(\d+))?$/);
  if (!m) return null;
  return { path: decodeURIComponent(m[1]), line: m[2] ? Number(m[2]) : undefined };
}

/** The visible text of spans, for copying and width estimates. */
export function plain(spans) {
  return spans.map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "br" ? "\n" : n.c ? plain(n.c) : "")).join("");
}

const inl = (src) => {
  const spans = inline(src);
  return { spans, html: toHtml(spans), text: plain(spans) };
};

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const TABLE_SEP = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;

const indentOf = (l) => l.match(/^ */)[0].length;
const isTableStart = (lines, i) => lines[i].includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-") && (lines[i + 1].includes("|") || lines[i].trim().startsWith("|"));
const startsBlock = (lines, i) => {
  const l = lines[i];
  return FENCE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || LIST.test(l) || /^\s*<\/?details/i.test(l) || isTableStart(lines, i);
};

/**
 * Blocks: `p`, `h` (level), `code` (lang, text, open while its fence is unclosed), `hr`, `quote` (blocks),
 * `list` (ordered, start, items of {task, blocks}), `table` (align, head, rows) and `details` (summary, blocks).
 */
export function parse(text) {
  return blocks(text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"));
}

function blocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = l.match(FENCE))) {
      const fence = m[1];
      const ind = indentOf(l);
      const body = [];
      i++;
      let open = true;
      while (i < lines.length) {
        if (new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(lines[i])) { open = false; i++; break; }
        body.push(lines[i].slice(Math.min(ind, indentOf(lines[i]))));
        i++;
      }
      out.push({ type: "code", lang: m[2].toLowerCase(), text: body.join("\n"), open });
      continue;
    }
    if ((m = l.match(HEADING))) {
      out.push({ type: "h", level: m[1].length, ...inl(m[2] ?? "") });
      i++;
      continue;
    }
    if (RULE.test(l)) {
      out.push({ type: "hr" });
      i++;
      continue;
    }
    if (/^\s*<details/i.test(l)) {
      const body = [];
      let depth = 0;
      let summary = "";
      for (; i < lines.length; i++) {
        let s = lines[i];
        depth += (s.match(/<details/gi) ?? []).length - (s.match(/<\/details>/gi) ?? []).length;
        const sm = s.match(/<summary>(.*?)<\/summary>/i);
        if (sm && !summary) { summary = sm[1]; s = s.replace(sm[0], ""); }
        s = s.replace(/^\s*<details[^>]*>/i, "").replace(/<\/details>\s*$/i, "");
        if (s.trim() || body.length) body.push(s);
        if (depth <= 0) { i++; break; }
      }
      out.push({ type: "details", summary: inl(summary || "Details"), blocks: blocks(body) });
      continue;
    }
    if (QUOTE.test(l)) {
      const body = [];
      while (i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !startsBlock(lines, i))) {
        const q = lines[i].match(QUOTE);
        body.push(q ? q[1] : lines[i]);
        i++;
      }
      out.push({ type: "quote", blocks: blocks(body) });
      continue;
    }
    if (isTableStart(lines, i)) {
      const cells = (row) => {
        const s = row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
        const parts = [];
        let cur = "";
        let code = false;
        for (let k = 0; k < s.length; k++) {
          if (s[k] === "\\" && s[k + 1] === "|") { cur += "|"; k++; continue; }
          if (s[k] === "`") code = !code;
          if (s[k] === "|" && !code) { parts.push(cur); cur = ""; continue; }
          cur += s[k];
        }
        parts.push(cur);
        return parts.map((c) => c.trim());
      };
      const head = cells(l);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) { rows.push(cells(lines[i])); i++; }
      const n = head.length;
      out.push({
        type: "table",
        align: Array.from({ length: n }, (_, k) => align[k] ?? "left"),
        head: head.map(inl),
        rows: rows.map((r) => Array.from({ length: n }, (_, k) => inl(r[k] ?? ""))),
      });
      continue;
    }
    if (LIST.test(l)) {
      const r = list(lines, i);
      out.push(r.block);
      i = r.end;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines, i) || (LIST.test(lines[i]) && !/^\s*(?:[-*+]|1[.)])\s/.test(lines[i])))) {
      para.push(lines[i].replace(/^\s+/, ""));
      i++;
    }
    out.push({ type: "p", ...inl(para.join("\n")) });
  }
  return out;
}

function list(lines, i) {
  const first = lines[i].match(LIST);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const block = { type: "list", ordered, start: ordered ? parseInt(first[2], 10) : 1, items: [] };
  let item = null;
  let contentIndent = 0;
  let blank = false;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { blank = true; if (item) item.lines.push(""); i++; continue; }
    const m = l.match(LIST);
    const ind = indentOf(l);
    if (m && ind >= base && ind < base + 4 && (!item || ind < contentIndent) && /\d/.test(m[2]) === ordered) {
      const raw = m[3] ?? "";
      const pad = (l.slice(m[1].length + m[2].length).match(/^[ \t]*/)[0].length || 1);
      contentIndent = m[1].length + m[2].length + Math.min(pad, 4);
      const task = raw.match(/^\[([ xX])\][ \t]+(.*)$/);
      item = { task: task ? task[1] !== " " : null, lines: [task ? task[2] : raw] };
      block.items.push(item);
      blank = false;
      i++;
      continue;
    }
    if (!item) break;
    if (ind >= contentIndent) { item.lines.push(l.slice(contentIndent)); blank = false; i++; continue; }
    if (!blank && !startsBlock(lines, i)) { item.lines.push(l.trim()); i++; continue; }
    if (!blank && m && ind > base) { item.lines.push(l.slice(Math.min(ind, contentIndent))); i++; continue; }
    break;
  }
  while (item && item.lines.length && !item.lines[item.lines.length - 1].trim()) item.lines.pop();
  block.items = block.items.map((it) => ({ task: it.task, blocks: blocks(it.lines) }));
  return { block, end: i };
}

// why: gpui-kit has no table layout, so columns come from text length at 14px Geist (about 7.7px a character).
const cellWidth = (x) => x.text.length * 7.7 + x.spans.filter((n) => n.t === "code" || n.c?.[0]?.t === "code").length * 8 + 32;
const wordWidth = (x) => Math.max(0, ...x.text.split(/\s+/).map((w) => w.length)) * 8.2 + 32;

/** Column widths for a table block: natural when they fit `avail`, shrunk toward their longest word when not. */
export function tableWidths(b, avail) {
  const rows = [b.head, ...b.rows];
  const nat = b.head.map((_, k) => Math.min(480, Math.max(48, ...rows.map((r) => cellWidth(r[k])))));
  const min = b.head.map((_, k) => Math.min(nat[k], Math.max(48, Math.min(240, Math.max(...rows.map((r) => wordWidth(r[k])))))));
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  if (sum(nat) <= avail) return nat.map(Math.round);
  if (sum(min) >= avail) return min.map(Math.round);
  const k = (avail - sum(min)) / (sum(nat) - sum(min));
  return nat.map((n, i) => Math.floor(min[i] + (n - min[i]) * k));
}
