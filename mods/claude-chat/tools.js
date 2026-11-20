// One row per tool call outside SYSTEM_TOOLS: a calm one-line summary that opens to the call's detail.
import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, exec } from "herdr";
import { describe, diffOf, ansiLines, readLines, pretty, plain, tail, duration, host, rel, abs, mix } from "./toolview.js";

const ICONS = "mods/claude-chat/tool-icons/";
const PAD = 8;
const INDENT = PAD + 12 + 8 + 14 + 8;
const LINE = 19;
const OUT_TAIL = 12, DIFF_HEAD = 60, CREATED_HEAD = 20, READ_HEAD = 24, LIST_HEAD = 12, TEXT_HEAD = 24;

const icon = (name, size, color) => svg(`${ICONS}${name}.svg`).w(size).h(size).flex_shrink_0().text_color(color);

// why: ctx.toggle notifies through the render's cx, which is stale by click time; the handler's own cx redraws.
function flip(ctx, key, cx) {
  try { ctx.toggle(key); } finally { cx.notify(); }
}

const copied = new Map();

// why: image() loads only from inside the app's folder, so an image elsewhere is copied in once.
function asset(path, ctx) {
  const home = appHome().replace(/\/$/, "") + "/";
  if (!path.startsWith("/")) return path;
  if (path.startsWith(home)) return path.slice(home.length);
  const local = `.cache/claude-chat/${path.split("/").join("_")}`;
  if (!copied.has(path)) {
    copied.set(path, false);
    exec("sh", ["-c", 'mkdir -p "$(dirname "$2")" && cp "$1" "$2"', "sh", path, home + local])
      .then((r) => { if (r.code === 0) { copied.set(path, true); ctx.notify(); } });
  }
  return copied.get(path) ? local : null;
}

/** The colors a tool row uses, from the theme. */
function palette(t) {
  const c = t.c;
  return {
    fg: c.foreground,
    arg: mix(c.foreground, c.background, 0.2),
    code: mix(c.foreground, c.background, 0.15),
    muted: c.muted,
    dim: c.dim ?? c.muted,
    red: c.ansi1,
    green: c.ansi2,
    box: c.surface ?? c.raised,
    border: c.border,
    hover: c.hover,
    addBg: mix(c.background, c.ansi2, 0.14),
    delBg: mix(c.background, c.ansi1, 0.14),
    hunkBg: mix(c.background, c.accent ?? c.ansi4, 0.08),
  };
}

/** A Text field shown in full once loaded through `ctx.full`, else its head and tail around a gap. */
function textOf(text, item, ctx, key) {
  if (text == null) return { s: "", clipped: false };
  if (typeof text === "string") return { s: text, clipped: false };
  if (ctx.open(key)) {
    const f = ctx.full(text);
    if (f != null) return { s: f, clipped: false };
  }
  const kb = Math.round(text.bytes / 1024);
  return { s: `${text.head}\n⋯ ${kb} KB more ⋯\n${text.tail}`, clipped: true };
}

/** Renders a tool item; subagent cards call it for their nested calls too. */
export function toolRow(item, ctx) {
  // why: a throw in render freezes the whole transcript on its last good frame, so one bad item gets a plain row.
  try { return row(item, ctx); } catch (e) {
    console.log(`claude-chat tools: ${item?.id} ${e?.message}`);
    return h_flex().h(ctx.t.row).px(PAD).gap(8).items_center().text_size(ctx.t.size.ui).text_color(ctx.t.c.muted)
      .child(div().w(12)).child(icon("wrench", 14, ctx.t.c.muted)).child(String(item?.name ?? "Tool"));
  }
}

function row(item, ctx) {
  const t = ctx.t, p = palette(t);
  const v = describe(item, ctx.cwd);
  const running = item.status === "running";
  const bg = item.background;
  // why: a running shell shows its output live; once it finishes the row folds back to one line.
  const defaultOpen = v.body === "shell" && (running || bg?.running === true);
  const hasBody = v.body != null;
  const open = hasBody && ctx.open(item.id) !== defaultOpen;
  const images = item.result?.images ?? [];
  return v_flex().w_full()
    .child(header(item, v, open, hasBody, ctx, p))
    .when(images.length > 0, (el) => el.child(thumbs(item, images, ctx, p)))
    .when(open, (el) => el.child(v_flex().pl(INDENT).pr(PAD).pt(2).pb(10).gap(8).child(body(item, v, ctx, p))));
}

function header(item, v, open, hasBody, ctx, p) {
  const t = ctx.t;
  const running = item.status === "running";
  const status = running
    ? icon("loader-circle", 14, t.c.working ?? p.muted).spin(800)
    : v.denied ? icon("ban", 14, p.muted)
    : item.status === "error" ? icon("circle-x", 14, p.red)
    : icon(v.icon, 14, p.muted);
  const bg = item.background;
  return h_flex().id(`tool:${item.id}`).h(t.row).px(PAD).gap(8).items_center().rounded(t.radius.chip)
    .text_size(t.size.ui)
    .when(hasBody, (el) => el.cursor_pointer().hover((s) => s.bg(p.hover)).on_click((_e, cx) => flip(ctx, item.id, cx)))
    .child(hasBody ? icon(open ? "chevron-down" : "chevron-right", 12, p.muted) : div().w(12).flex_shrink_0())
    .child(status)
    .when(!!v.verb, (el) => el.child(div().flex_shrink_0().font_weight(500).text_color(p.fg).whitespace_nowrap().child(v.verb)))
    .child(arg(item, v, ctx, p))
    .when(v.add > 0 || v.del > 0, (el) => el.child(h_flex().flex_shrink_0().gap(6).text_size(t.size.small)
      .when(v.add > 0, (e) => e.child(div().text_color(p.green).child(`+${v.add}`)))
      .when(v.del > 0, (e) => e.child(div().text_color(p.red).child(`−${v.del}`)))))
    .when(bg?.running === true, (el) => el.child(bgChip(t, p)))
    .when(!!v.result, (el) => el.child(div().min_w(0).max_w(t.measure * 0.45).truncate()
      .text_size(t.size.small).text_color(v.tone === "error" ? p.red : p.muted).child(v.result)))
    .when(item.seconds != null && !running, (el) => el.child(div().flex_shrink_0().text_size(t.size.small)
      .text_color(p.muted).child(duration(item.seconds))));
}

function arg(item, v, ctx, p) {
  const t = ctx.t;
  const note = div().flex_shrink_0().text_size(t.size.small).text_color(p.muted).whitespace_nowrap().child(v.note);
  const wrap = h_flex().flex_1().min_w(0).gap(8).items_center();
  if (!v.arg) return wrap;
  const end = (el) => el.when(!!v.note, (e) => e.child(note));
  const text = div().min_w(0).truncate().text_color(p.arg)
    .when(v.mono, (el) => el.font_family(t.font.mono).text_size(t.size.code));
  if (v.linkKind === "file") text.text_ellipsis_middle();
  if (!v.link) {
    return wrap.when(v.prompt, (el) => el.child(div().flex_shrink_0().font_family(t.font.mono).text_size(t.size.code)
      .text_color(p.dim).child("$"))).child(text.child(v.arg)).map(end);
  }
  const chip = h_flex().id(`link:${item.id}`).min_w(0).px(6).h(20).items_center().rounded(t.radius.chip)
    .bg(mix(t.c.background, t.c.foreground, 0.06)).cursor_pointer()
    .hover((s) => s.bg(mix(t.c.background, t.c.foreground, 0.12)))
    .tooltip(v.linkKind === "url" ? v.link : "Open file")
    .on_click((_e, cx) => { cx.stop_propagation(); v.linkKind === "url" ? ctx.openUrl(v.link) : ctx.openFile(v.link); })
    .child(text.child(v.arg));
  return wrap.child(chip).map(end);
}

function bgChip(t, p) {
  const live = t.c.working ?? p.muted;
  return h_flex().flex_shrink_0().gap(6).px(8).h(20).items_center().rounded(10)
    .bg(mix(t.c.background, live, 0.14)).text_size(t.size.small).text_color(p.fg)
    .child(div().w(6).h(6).rounded(3).bg(live).loop("opacity", { from: 0.35, to: 1, period: 1200 }))
    .child("Running in background");
}

function body(item, v, ctx, p) {
  switch (v.body) {
    case "diff": return diff(item, v, ctx, p);
    case "shell": return shell(item, ctx, p);
    case "read": return read(item, ctx, p);
    case "hits": return hits(item, v, ctx, p);
    case "sources": return sources(item, v, ctx, p);
    case "json": return json(item, ctx, p);
    case "prose": return prose(item, ctx, p);
    default: return text(item, ctx, p, item.status === "error" ? p.red : p.code);
  }
}

/** A rounded mono box whose rows scroll sideways together instead of wrapping. */
function monoBox(id, rows, ctx, p) {
  const t = ctx.t;
  return div().w_full().rounded(t.radius.block).border_1().border_color(p.border).bg(p.box).overflow_hidden()
    .child(h_flex().id(id).w_full().overflow_x_scroll()
      .child(v_flex().flex_shrink_0().min_w_full().py(6).font_family(t.font.mono).text_size(t.size.small)
        .text_color(p.code).children(rows)));
}

function showAll(key, label, ctx, p, after) {
  return div().id(`more:${key}`).px(6).h(24).flex().items_center().rounded(ctx.t.radius.chip)
    .text_size(ctx.t.size.small).font_weight(500).text_color(p.muted).cursor_pointer()
    .hover((s) => s.bg(p.hover).text_color(p.fg))
    .on_click((_e, cx) => { cx.stop_propagation(); flip(ctx, key, cx); after?.(); })
    .child(label);
}

function gutter(n, w, p) {
  return div().w(w).flex_shrink_0().pr(8).text_right().text_color(p.dim).child(n == null ? "" : String(n));
}

function diff(item, v, ctx, p) {
  const all = diffOf(item);
  const numbered = all.some((r) => r.old != null || r.new != null);
  const created = v.verb === "Created";
  const head = created ? CREATED_HEAD : DIFF_HEAD;
  const key = `${item.id}:all`;
  const rows = ctx.open(key) ? all : all.slice(0, head);
  const width = String(Math.max(0, ...all.map((r) => Math.max(r.old ?? 0, r.new ?? 0)))).length * 8 + 14;
  const el = rows.map((r) => {
    if (r.kind === "hunk") {
      return h_flex().h(LINE + 4).px(10).bg(p.hunkBg).text_color(p.muted).whitespace_nowrap().child(r.text);
    }
    const tint = created ? null : r.kind === "add" ? p.addBg : r.kind === "del" ? p.delBg : null;
    const sign = r.kind === "add" ? "+" : r.kind === "del" ? "−" : " ";
    const signColor = r.kind === "add" ? p.green : r.kind === "del" ? p.red : p.dim;
    return h_flex().h(LINE).items_center().whitespace_nowrap().when(!!tint, (e) => e.bg(tint))
      .when(numbered && !created, (e) => e.child(gutter(r.old, width, p)))
      .when(numbered, (e) => e.child(gutter(r.new, width, p)))
      .child(div().w(numbered ? 16 : 24).flex_shrink_0().pl(numbered ? 0 : 10).text_color(signColor).child(sign))
      .child(div().pr(12).child(r.text || " "));
  });
  const out = v_flex().w_full().gap(4).child(monoBox(`diff:${item.id}`, el, ctx, p));
  if (all.length > head) out.child(showAll(key, ctx.open(key) ? "Show less" : `Show all ${all.length} lines`, ctx, p));
  return out;
}

function ansiRow(runs, t, p) {
  return h_flex().h(LINE).px(12).whitespace_nowrap().children(runs.length ? runs.map((r) =>
    div().text_color(r.fg == null ? p.code : typeof r.fg === "number" ? t.c[`ansi${r.fg}`] : r.fg)
      .when(r.bold, (e) => e.font_weight(600)).child(r.text)) : [div().child(" ")]);
}

function shell(item, ctx, p) {
  const t = ctx.t, i = item.input ?? {};
  const cmd = i.command ?? "";
  const parts = v_flex().w_full().gap(8);
  if (cmd.includes("\n") || cmd.length > 72) {
    parts.child(monoBox(`cmd:${item.id}`, cmd.split("\n").map((l, k) => h_flex().h(LINE).px(12).whitespace_nowrap()
      .child(div().w(14).flex_shrink_0().text_color(p.dim).child(k ? "" : "$")).child(div().child(l || " "))), ctx, p));
  }
  const src = item.background?.output ?? item.result?.text;
  const key = `${item.id}:all`;
  const { s, clipped } = textOf(src, item, ctx, key);
  const out = plain(s).replace(/^Exit code -?\d+\n?/, "");
  if (!out) {
    const quiet = item.status === "running" ? "Running…" : item.background ? `Shell ${item.background.shellId}` : "No output";
    return parts.child(div().text_size(t.size.small).text_color(p.muted).child(quiet));
  }
  const lines = ansiLines(out);
  const { shown, hidden } = ctx.open(key) ? { shown: lines, hidden: 0 } : tail(lines, OUT_TAIL);
  parts.child(monoBox(`out:${item.id}`, shown.map((r) => ansiRow(r, t, p)), ctx, p));
  if (hidden > 0 || clipped) {
    parts.child(showAll(key, clipped ? "Show all" : `Show all ${lines.length} lines`, ctx, p));
  } else if (ctx.open(key) && lines.length > OUT_TAIL) parts.child(showAll(key, "Show less", ctx, p));
  return parts;
}

function read(item, ctx, p) {
  const key = `${item.id}:all`;
  const { s, clipped } = textOf(item.result?.text, item, ctx, key);
  const r = readLines(plain(s));
  const rows = ctx.open(key) ? r.rows : r.rows.slice(0, READ_HEAD);
  const width = String(r.hi || 1).length * 8 + 14;
  const el = rows.map((l) => h_flex().h(LINE).whitespace_nowrap()
    .when(r.ok, (e) => e.child(gutter(l.n, width, p))).child(div().pl(r.ok ? 0 : 12).pr(12).child(l.text || " ")));
  const out = v_flex().w_full().gap(4).child(monoBox(`read:${item.id}`, el, ctx, p));
  if (r.rows.length > READ_HEAD || clipped) out.child(showAll(key, ctx.open(key) && !clipped ? "Show less" : `Show all ${clipped ? "" : r.rows.length + " lines"}`.trim(), ctx, p));
  return out;
}

function listRow(id, ctx, p, left, right, onClick) {
  const t = ctx.t;
  return h_flex().id(id).h(t.row - 4).px(8).gap(12).items_center().text_size(t.size.ui).rounded(t.radius.chip).cursor_pointer()
    .hover((s) => s.bg(p.hover)).on_click((_e, cx) => { cx.stop_propagation(); onClick(); })
    .child(left).child(div().flex_1()).when(right != null, (e) => e.child(right));
}

function hits(item, v, ctx, p) {
  const t = ctx.t, key = `${item.id}:all`;
  const shown = ctx.open(key) ? v.hits : v.hits.slice(0, LIST_HEAD);
  const out = v_flex().w_full().gap(0).children(shown.map((h, k) => listRow(`hit:${item.id}:${k}`, ctx, p,
    div().min_w(0).truncate().text_ellipsis_middle().text_color(p.arg).child(rel(h.path, ctx.cwd)),
    h.n ? div().flex_shrink_0().text_size(t.size.small).text_color(p.muted).child(String(h.n)) : null,
    () => ctx.openFile(abs(h.path, ctx.cwd)))));
  if (v.hits.length > LIST_HEAD) out.child(showAll(key, ctx.open(key) ? "Show less" : `Show all ${v.hits.length}`, ctx, p));
  return out;
}

function sources(item, v, ctx, p) {
  const t = ctx.t;
  return v_flex().w_full().children(v.sources.map((s, k) => listRow(`src:${item.id}:${k}`, ctx, p,
    div().min_w(0).truncate().text_color(p.fg).child(s.title),
    div().flex_shrink_0().text_size(t.size.small).text_color(p.muted).child(host(s.url)),
    () => ctx.openUrl(s.url))));
}

function textBox(id, s, color, head, key, ctx, p, clipped) {
  const lines = s.split("\n");
  const shown = ctx.open(key) ? lines : lines.slice(0, head);
  const out = v_flex().w_full().gap(4).child(monoBox(id, shown.map((l) => h_flex().h(LINE).px(12).whitespace_nowrap()
    .text_color(color).child(l || " ")), ctx, p));
  if (lines.length > head || clipped) out.child(showAll(key, ctx.open(key) && !clipped ? "Show less" : clipped ? "Show all" : `Show all ${lines.length} lines`, ctx, p));
  return out;
}

function text(item, ctx, p, color) {
  const key = `${item.id}:all`;
  const { s, clipped } = textOf(item.result?.text, item, ctx, key);
  return textBox(`text:${item.id}`, plain(s), color, TEXT_HEAD, key, ctx, p, clipped);
}

function prose(item, ctx, p) {
  const t = ctx.t, key = `${item.id}:all`;
  const { s, clipped } = textOf(item.result?.text, item, ctx, key);
  const paras = plain(s).split(/\n\s*\n/);
  const shown = ctx.open(key) ? paras : paras.slice(0, 3);
  const out = v_flex().w_full().gap(4).child(v_flex().w_full().gap(8).px(14).py(10).rounded(t.radius.block)
    .border_1().border_color(p.border).bg(p.box).text_size(t.size.ui).line_height("19px").text_color(p.code)
    .children(shown.map((para) => div().child(para))));
  if (paras.length > 3 || clipped) out.child(showAll(key, ctx.open(key) && !clipped ? "Show less" : "Show all", ctx, p));
  return out;
}

function label(s, ctx, p) {
  return div().text_size(ctx.t.size.small).font_weight(500).text_color(p.muted).child(s);
}

function json(item, ctx, p) {
  const out = v_flex().w_full().gap(6);
  const input = JSON.stringify(item.input ?? {}, null, 2);
  out.child(label("Arguments", ctx, p)).child(textBox(`args:${item.id}`, input, p.code, TEXT_HEAD, `${item.id}:args`, ctx, p, false));
  if (item.result) {
    const key = `${item.id}:all`;
    const { s, clipped } = textOf(item.result.text, item, ctx, key);
    const body = pretty(plain(s));
    if (body) {
      out.child(label(item.status === "error" ? "Error" : "Result", ctx, p))
        .child(textBox(`res:${item.id}`, body, item.status === "error" ? p.red : p.code, TEXT_HEAD, key, ctx, p, clipped));
    }
  }
  return out;
}

function thumbs(item, images, ctx, p) {
  const t = ctx.t;
  return h_flex().pl(INDENT).pr(PAD).pt(4).pb(8).gap(8).flex_wrap().children(images.map((im, k) => {
    const key = `${item.id}:img${k}`;
    if (!im.path) {
      return h_flex().h(28).px(10).gap(6).items_center().rounded(t.radius.chip).bg(p.box)
        .text_size(t.size.small).text_color(p.muted).child(icon("image", 14, p.muted)).child("Image");
    }
    const big = ctx.open(key);
    const src = asset(im.path, ctx);
    const shot = src ? image(src).rounded(t.radius.block) : div().bg(p.box);
    return div().id(`img:${key}`).rounded(t.radius.block).border_1().border_color(p.border).overflow_hidden()
      .cursor_pointer().tooltip(big ? "Shrink" : "Enlarge")
      .on_click((_e, cx) => { cx.stop_propagation(); flip(ctx, key, cx); })
      .child(big ? shot.w(t.measure - INDENT - PAD).h((t.measure - INDENT - PAD) * 0.625) : shot.w(192).h(120));
  }));
}
