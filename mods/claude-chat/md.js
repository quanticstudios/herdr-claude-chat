// Markdown to gpui elements for Claude's replies: mdparse.js blocks, prose through selectable TextView.html.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { parse, readFileHref, tableWidths } from "./mdparse.js";
import { tint } from "./mdcode.js";
import { unzoom } from "./theme.js";

const ICON = "mods/claude-chat/icons/";
const cache = new Map();
const copied = new Set();
const widths = new Map();

/** Parsed blocks for one reply text, parsed once and kept while recent. */
export function blocksFor(text) {
  let b = cache.get(text);
  if (b) return b;
  b = parse(text);
  cache.set(text, b);
  // why: a streaming reply adds one entry per chunk; drop the oldest instead of growing for ever.
  if (cache.size > 400) cache.delete(cache.keys().next().value);
  return b;
}

/** Mixes two `#rrggbb` colors; `k` 0 is `a`, 1 is `b`. */
export function mix(a, b, k) {
  const p = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  if (!/^#[0-9a-f]{6}/i.test(a ?? "") || !/^#[0-9a-f]{6}/i.test(b ?? "")) return a;
  const x = p(a), y = p(b);
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * k).toString(16).padStart(2, "0")).join("");
}

const hash = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

/** Renders one reply's markdown; `key` (the item id) keeps selection and `<details>` state while it streams. */
export function markdown(text, ctx, key) {
  const t = ctx.t;
  const c = t.c;
  const s = {
    ctx, t, c,
    key: key ?? "md-" + hash(text),
    prose: mix(c.foreground, c.background, 0.1),
    code: mix(c.foreground, c.background, 0.15),
    codeBg: c.surface ?? c.raised,
  };
  // why: x-scroll areas take the vertical wheel in GPUI, so tables and code scroll only when wider than this.
  const width = widths.get(s.key) ?? 880;
  return v_flex().id(s.key + ":md").w_full().min_w(0).font_family(t.font.ui).text_size(14).line_height("22px").text_color(s.prose)
    .on_size_change((size, cx) => { const w = unzoom(size.width); if (Math.abs((widths.get(s.key) ?? 0) - w) > 1) { widths.set(s.key, w); cx.notify(); } })
    .children(renderBlocks(blocksFor(text), s, s.key, false, width));
}

function gapBefore(prev, b, tight) {
  if (!prev) return 0;
  if (b.type === "h") return 20;
  if (prev.type === "h") return 6;
  if (tight && b.type === "list") return 4;
  if (b.type === "hr" || prev.type === "hr") return 16;
  if (b.type === "code" || prev.type === "code" || b.type === "table" || prev.type === "table") return 12;
  return tight ? 6 : 10;
}

function renderBlocks(blocks, s, id, tight, w) {
  return blocks.map((b, i) => block(b, s, `${id}.${i}`, tight, w).mt(gapBefore(blocks[i - 1], b, tight)));
}

function onLink(s) {
  return (url, _cx) => {
    const f = readFileHref(url);
    if (!f) return s.ctx.openUrl(url);
    const abs = f.path.startsWith("/") || f.path.startsWith("~") || !s.ctx.cwd ? f.path : `${s.ctx.cwd.replace(/\/$/, "")}/${f.path.replace(/^\.\//, "")}`;
    s.ctx.openFile(abs, f.line);
  };
}

function text(x, s, id) {
  return TextView.html(id, x.html || "&#8203;").selectable(true).on_link_click(onLink(s));
}

function block(b, s, id, tight, w) {
  const { c } = s;
  switch (b.type) {
    case "p":
      return div().w_full().child(text(b, s, id));
    case "h":
      return div().w_full().text_color(c.foreground).font_weight(600)
        .text_size(b.level <= 2 ? 16 : 14).line_height(b.level <= 2 ? "22px" : "20px").child(text(b, s, id));
    case "hr":
      return div().w_full().h(1).bg(c.border);
    case "quote":
      return h_flex().w_full().items_stretch().gap(12)
        .child(div().w(3).flex_none().rounded(2).bg(c.border))
        .child(v_flex().flex_1().min_w(0).text_color(mix(c.foreground, c.background, 0.3)).children(renderBlocks(b.blocks, s, id, tight, w - 15)));
    case "list":
      return list(b, s, id, w);
    case "code":
      return codeBlock(b, s, id, w);
    case "table":
      return table(b, s, id, w);
    case "details":
      return details(b, s, id, w);
  }
  return div();
}

function list(b, s, id, w) {
  const { c } = s;
  const depth = id.split(".").filter((p) => p === "L").length;
  const digits = b.ordered ? String(b.start + b.items.length - 1).length : 0;
  const gutter = b.ordered ? Math.max(20, 10 + digits * 8) : 20;
  return v_flex().w_full().gap(4).children(b.items.map((it, k) => {
    const marker = it.task !== null
      ? checkbox(it.task, s)
      : div().w(gutter).flex_none().pr(b.ordered ? 6 : 0).text_color(c.muted)
        .when(b.ordered, (el) => el.text_right()).when(!b.ordered, (el) => el.pl(6))
        .child(b.ordered ? `${b.start + k}.` : ["•", "◦", "▪"][depth % 3]);
    return h_flex().w_full().items_start()
      .child(marker)
      .child(v_flex().flex_1().min_w(0)
        .when(it.task === true, (el) => el.text_color(c.muted))
        .children(renderBlocks(it.blocks, s, `${id}.L.${k}`, true, w - gutter)));
  }));
}

function checkbox(on, s) {
  const { c } = s;
  return div().w(20).h(22).flex_none().flex().items_center().child(
    div().size(14).rounded(4).border(1).border_color(on ? c.accent : c.input ?? c.border).bg(on ? c.accent : c.background)
      .flex().items_center().justify_center()
      .when(on, (el) => el.child(svg(ICON + "check.svg").size(10).text_color(c.accent_foreground ?? c.background))));
}

function copyButton(textToCopy, s, id) {
  const { c } = s;
  const done = copied.has(id);
  return h_flex().id(id + ":copy").h(28).px(8).gap(6).rounded(6).items_center().cursor_pointer()
    .text_size(12).font_weight(500).text_color(c.muted)
    .hover((st) => st.bg(c.hover).text_color(c.foreground))
    .on_click((_e, cx) => {
      s.ctx.copy(textToCopy);
      copied.add(id);
      cx.notify();
      cx.timer.after(1500, (cx) => { copied.delete(id); cx.notify(); });
    })
    .child(svg(ICON + (done ? "check.svg" : "copy.svg")).size(13))
    .child(done ? "Copied" : "Copy");
}

const LANG = { ts: "TypeScript", tsx: "TSX", js: "JavaScript", jsx: "JSX", py: "Python", rs: "Rust", go: "Go", sh: "Shell", bash: "Bash", zsh: "Zsh", json: "JSON", yaml: "YAML", yml: "YAML", md: "Markdown", diff: "Diff", sql: "SQL", rb: "Ruby", toml: "TOML", html: "HTML", css: "CSS", swift: "Swift", kt: "Kotlin", c: "C", cpp: "C++", java: "Java" };

function codeBlock(b, s, id, w) {
  const { c, t } = s;
  const diff = b.lang === "diff" || b.lang === "patch" || (!b.lang && /^(?:--- |\+\+\+ |@@ )/m.test(b.text) && /^[+-]/m.test(b.text));
  const colors = { kw: c.ansi5 ?? c.accent, str: c.ansi2 ?? c.done, num: c.ansi3 ?? c.blocked, com: c.muted,
    fn: c.ansi4 ?? c.accent, type: c.ansi6 ?? c.accent, op: c.muted };
  const lines = b.text.split("\n");
  const row = (line, k) => {
    const el = h_flex().id(`${id}:l${k}`).min_w_full().px(14).h(19).flex_none().whitespace_nowrap();
    if (diff) {
      const add = line.startsWith("+") && !line.startsWith("+++");
      const del = line.startsWith("-") && !line.startsWith("---");
      const meta = line.startsWith("@@") || line.startsWith("+++") || line.startsWith("---");
      const col = add ? c.ansi2 ?? c.done : del ? c.ansi1 ?? c.blocked : meta ? c.muted : s.code;
      return el.when(add || del, (e) => e.bg(mix(c.background, col, 0.14))).text_color(col).child(line || " ");
    }
    return el.children(tint(line, b.lang).map((r) => r.k ? div().text_color(colors[r.k]).when(r.k === "com", (d) => d.italic()).child(r.v) : r.v))
      .when(!line, (e) => e.child(" "));
  };
  return v_flex().w_full().rounded(t.radius.block).border(1).border_color(c.border).bg(s.codeBg).overflow_hidden()
    .child(h_flex().h(30).pl(14).pr(1).items_center().justify_between().border_b(1).border_color(c.border)
      .child(div().text_size(12).font_weight(500).line_height("12px").text_color(c.muted).child(diff && !b.lang ? "Diff" : LANG[b.lang] ?? (b.lang || "Text")))
      .child(copyButton(b.text, s, id)))
    .child(div().id(id + ":scroll").w_full().when(Math.max(...lines.map((l) => l.length)) * 7.3 + 30 > w, (el) => el.overflow_x_scroll()).child(
      v_flex().py(12).font_family(t.font.mono).text_size(12).line_height("19px").text_color(s.code).children(lines.map(row))));
}

function table(b, s, id, w) {
  const { c } = s;
  const cols = tableWidths(b, w);
  const total = cols.reduce((a, x) => a + x, 0);
  const row = (cells, r, head) => h_flex().w(total).flex_none().items_start()
    .when(head || r < b.rows.length - 1, (el) => el.border_b(1).border_color(head ? c.input ?? c.border : c.border))
    .when(head, (el) => el.bg(s.codeBg).text_color(c.foreground).font_weight(500))
    .children(cells.map((x, k) => div().w(cols[k]).flex_none().px(12).py(head ? 6 : 8)
      .when(b.align[k] === "right", (el) => el.text_right()).when(b.align[k] === "center", (el) => el.text_center())
      .child(text(x, s, `${id}:${head ? "h" : r}:${k}`))));
  return div().id(id + ":scroll").w_full().when(total > w + 1, (el) => el.overflow_x_scroll()).child(
    v_flex().w(total).rounded(s.t.radius.block).border(1).border_color(c.border).overflow_hidden()
      .child(row(b.head, -1, true)).children(b.rows.map((r, i) => row(r, i, false))));
}

function details(b, s, id, w) {
  const { c, ctx } = s;
  const open = ctx.open(id);
  return v_flex().w_full()
    .child(h_flex().id(id + ":toggle").h(28).gap(6).px(6).ml(-6).rounded(6).items_center().cursor_pointer()
      .text_color(c.foreground).font_weight(500).hover((st) => st.bg(c.hover))
      .on_click((_e, cx) => { cx.notify(); ctx.toggle(id); })
      .child(svg(ICON + (open ? "chevron-down.svg" : "chevron-right.svg")).size(14).text_color(c.muted))
      .child(b.summary.text))
    .when(open, (el) => el.child(v_flex().pl(20).pt(6).children(renderBlocks(b.blocks, s, id, false, w - 20))));
}
