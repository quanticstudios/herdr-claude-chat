// Todo cards, subagents, thinking, command and pasted chips, notices and turn footers.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { toolRow } from "./tools.js";
import { markdown } from "./md.js";
import { dur, count, money, stripAnsi, textOf, progress, firstLine, summary, lineCount, headLines, agentInfo, elapsed, noticeKind, grouped } from "./sys.js";

const ic = (n) => `mods/claude-chat/icons/sys/${n}.svg`;
const AGENTS = new Set(["Task", "Agent", "Workflow"]);
const OUTPUT_LINES = 12;

const rgb = (s) => [1, 3, 5].map((i) => parseInt((s ?? "#000000").slice(i, i + 2), 16) || 0);
/** `fg` at opacity `a` over `bg`, flattened to an opaque color. */
function mix(bg, fg, a) {
  const b = rgb(bg), f = rgb(fg);
  return "#" + b.map((v, i) => Math.round(v + (f[i] - v) * a).toString(16).padStart(2, "0")).join("");
}

function colors(t) {
  const c = t.c;
  // why: herdr's working/done/blocked are status hues per theme (win98's done is blue); ANSI keeps red, yellow, green, blue.
  return { ...c, red: c.ansi1, yellow: c.ansi3, green: c.ansi2, blue: c.ansi4 };
}

function icon(name, size, color) {
  return svg(ic(name)).size(size).flex_none().text_color(color);
}

function chevron(open, c, size = 12) {
  return icon(open ? "down" : "right", size, c.muted);
}

/** A clickable element that flips `key` in the chat's open state. */
function toggler(el, key, ctx) {
  return el.id(`sys-${key}`).cursor_pointer().on_click((_e, cx) => { ctx.toggle(key); cx.notify(); });
}

/** Renders a todo, thinking, command, notice or turn item, or a SYSTEM_TOOLS tool item. */
export function systemRow(item, ctx) {
  switch (item.kind) {
    case "todo": return todoCard(item, ctx);
    case "thinking": return thinkingRow(item, ctx);
    case "command": return commandItem(item, ctx);
    case "notice": return notice(item, ctx);
    case "turn": return turnFooter(item, ctx);
    case "tool":
      if (AGENTS.has(item.name)) return agentCard(item, ctx);
      // why: TodoWrite and TaskCreate/TaskUpdate calls fold into the one todo item the model keeps.
      if (/^(TodoWrite|Task(Create|Update|List|Get))$/.test(item.name)) return div();
      return toolRow(item, ctx);
    case "reply": return markdown(item.text, ctx);
  }
  return div();
}

function todoLine(x, ctx) {
  const t = ctx.t, c = colors(t);
  const st = x.status;
  const mark = st === "completed" ? icon("check", 14, c.green)
    : st === "in_progress" ? icon("spinner", 14, c.blue).spin(800)
    : icon("circle", 14, c.dim);
  return h_flex().items_start().gap(8).py(3)
    .child(div().pt(2).flex_none().child(mark))
    .child(div().flex_1().min_w(0).text_size(t.size.ui).line_height(1.45)
      .text_color(st === "in_progress" ? c.foreground : c.muted)
      .when(st === "in_progress", (el) => el.font_weight(500))
      .when(st === "completed", (el) => el.line_through())
      .child(st === "in_progress" ? (x.activeText || x.text) : x.text));
}

function todoCard(item, ctx) {
  const t = ctx.t, c = colors(t), p = progress(item.items);
  return v_flex().w_full().px(16).py(12).rounded(t.radius.card).bg(c.surface).border_1().border_color(c.border)
    .child(h_flex().items_center().justify_between().pb(6)
      .child(div().text_size(t.size.small).font_weight(500).text_color(c.muted).child("Plan"))
      .child(div().text_size(t.size.small).text_color(c.muted).child(`${p.done} of ${p.total}`)))
    .children((item.items ?? []).map((x) => todoLine(x, ctx)));
}

/** The compact live plan above the composer while a turn runs, or null. */
export function liveTodo(todo, ctx) {
  const p = progress(todo?.items);
  if (!p.total || p.done === p.total) return null;
  const t = ctx.t, c = colors(t);
  const key = `${todo.id}:live`, open = ctx.open(key);
  const next = p.now ?? todo.items.find((x) => x.status === "pending");
  const bar = toggler(h_flex(), key, ctx).h(36).px(14).gap(8).items_center().hover((s) => s.bg(c.hover))
    .child(p.now ? icon("spinner", 14, c.blue).spin(800) : icon("circle", 14, c.dim))
    .child(div().flex_1().min_w(0).truncate().text_size(t.size.ui)
      .text_color(p.now ? c.foreground : c.muted).when(Boolean(p.now), (el) => el.font_weight(500))
      .child(p.now ? (p.now.activeText || p.now.text) : `Next: ${next.text}`))
    .child(div().flex_none().text_size(t.size.small).text_color(c.muted).child(`${p.done} of ${p.total}`))
    .child(icon(open ? "down" : "up", 12, c.muted));
  return v_flex().w_full().rounded(t.radius.card).bg(c.surface).border_1().border_color(c.border).overflow_hidden()
    .when(open, (el) => el.child(v_flex().id(`sys-${key}-list`).max_h(240).overflow_y_scroll().px(16).pt(10).pb(6)
      .border_b_1().border_color(c.border).children(todo.items.map((x) => todoLine(x, ctx)))))
    .child(bar);
}

const SUMMARY_MAX = 400;

function thinkingRow(item, ctx) {
  const t = ctx.t, c = colors(t);
  const label = item.seconds >= 1 ? `Thought for ${dur(item.seconds)}` : "Thought";
  const row = h_flex().h(t.row).gap(6).items_center().text_size(t.size.ui).text_color(c.muted);
  if (item.text == null || !item.text.trim()) return row.child(label);
  // why: Claude Code prints short thinking as a visible progress line ("· summary"), so the chat shows it too.
  if (item.text.trim().length <= SUMMARY_MAX && !/\n\s*\n/.test(item.text.trim())) {
    return div().w_full().py(2).text_size(t.size.ui).line_height(1.55).text_color(c.muted).child(item.text.trim());
  }
  const open = ctx.open(item.id);
  const body = mix(c.background, c.muted, 0.9);
  return v_flex().w_full()
    .child(toggler(row, item.id, ctx).hover((s) => s.text_color(c.foreground)).child(label).child(chevron(open, c)))
    .when(open, (el) => el.child(v_flex().ml(5).pl(14).py(4).gap(10).border_l_2().border_color(c.border)
      .text_size(t.size.ui).line_height(1.6).italic().text_color(body)
      .children(item.text.trim().split(/\n\s*\n/).map((para) => div().child(para.trim())))));
}

function quietBlock(text, key, ctx) {
  const t = ctx.t, c = colors(t);
  const open = ctx.open(key);
  const head = headLines(text, OUTPUT_LINES);
  return v_flex().w_full().rounded(t.radius.block).bg(c.surface).border_1().border_color(c.border).overflow_hidden()
    .child(div().id(`sys-${key}-x`).overflow_x_scroll().px(14).py(10)
      .font_family(t.font.mono).text_size(12).line_height(1.55).text_color(mix(c.background, c.foreground, 0.8))
      .whitespace_nowrap()
      .children((open ? text.replace(/\n$/, "") : head.text).split("\n").map((l) => div().min_h(18).child(l || " "))))
    .when(head.more > 0, (el) => el.child(toggler(h_flex(), key, ctx).h(28).px(14).gap(6).items_center()
      .border_t_1().border_color(c.border).text_size(t.size.small).font_weight(500).text_color(c.muted)
      .hover((s) => s.bg(c.hover).text_color(c.foreground))
      .child(open ? "Show less" : `Show all ${lineCount(text)} lines`)));
}

function commandItem(item, ctx) {
  const t = ctx.t, c = colors(t);
  const name = item.name.startsWith("/") ? item.name : `/${item.name}`;
  const chip = h_flex().id(`sys-${item.id}-chip`).flex_none().max_w(t.measure * 0.84).gap(6).items_center()
    .px(12).py(7).rounded(t.radius.card).rounded_br(4).bg(c.raised)
    .font_family(t.font.mono).text_size(t.size.code)
    .child(div().flex_none().text_color(c.accent).child(name))
    .when(Boolean(item.args), (el) => el.child(div().min_w(0).truncate().text_color(c.foreground).child(item.args)));
  const out = stripAnsi(textOf(item.output, ctx.full)).replace(/^\n+|\s+$/g, "");
  return v_flex().w_full().gap(8)
    .child(h_flex().w_full().justify_end().child(item.args ? chip.tooltip(`${name} ${item.args}`) : chip))
    .when(Boolean(out), (el) => el.child(quietBlock(out, `${item.id}:out`, ctx)));
}

/** A "Pasted text · N lines" chip for a user bubble that expands to the pasted text. */
export function pastedChip(p, ctx, key) {
  const t = ctx.t, c = colors(t);
  key ??= `paste:${p.lines}:${p.text.length}:${p.text.slice(0, 24)}`;
  const open = ctx.open(key);
  const lines = p.lines ?? lineCount(p.text);
  const chip = toggler(h_flex(), key, ctx).flex_none().h(28).px(10).gap(6).items_center()
    .rounded(t.radius.chip).bg(c.raised).border_1().border_color(c.border).hover((s) => s.bg(c.hover))
    .text_size(t.size.small).font_weight(500).text_color(c.muted)
    .child(icon("clipboard", 13, c.muted))
    .child(`Pasted text · ${lines} ${lines === 1 ? "line" : "lines"}`)
    .child(chevron(open, c));
  return v_flex().gap(6).items_end()
    .child(chip)
    .when(open, (el) => el.child(div().id(`sys-${key}-body`).w_full().max_h(320).overflow_y_scroll()
      .px(12).py(10).rounded(t.radius.block).bg(c.surface).border_1().border_color(c.border)
      .font_family(t.font.mono).text_size(12).line_height(1.55).text_color(mix(c.background, c.foreground, 0.85))
      .child(p.text)));
}

function divider(label, ctx, extra) {
  const t = ctx.t, c = colors(t);
  const line = () => div().flex_1().h(1).bg(c.border);
  return h_flex().w_full().h(t.row).gap(10).items_center()
    .child(line())
    .child(h_flex().flex_none().gap(6).items_center().text_size(t.size.small).font_weight(500).text_color(c.muted)
      .child(label).when(Boolean(extra), (el) => el.child(extra)))
    .child(line());
}

function quietRow(iconName, iconColor, text, ctx) {
  const t = ctx.t, c = colors(t);
  return h_flex().w_full().min_h(24).gap(8).items_center().text_size(t.size.small).text_color(c.muted)
    .when(Boolean(iconName), (el) => el.child(icon(iconName, 13, iconColor)))
    .child(div().min_w(0).truncate().child(text));
}

function notice(item, ctx) {
  const t = ctx.t, c = colors(t);
  const kind = noticeKind(item);
  const detail = textOf(item.detail, ctx.full).trim();
  const open = ctx.open(item.id);
  switch (kind) {
    case "interrupt": return quietRow("stop", c.muted, "Stopped", ctx);
    case "switch": return divider(item.text, ctx, icon("switch", 12, c.muted));
    case "task": return quietRow("check", c.green, item.text, ctx);
    case "compact":
      if (!detail) return divider("Conversation compacted", ctx);
      return v_flex().w_full().gap(8)
        .child(toggler(div(), item.id, ctx).w_full().child(divider("Conversation compacted", ctx, chevron(open, c))))
        .when(open, (el) => el.child(div().w_full().px(16).py(12).rounded(t.radius.card).bg(c.surface)
          .border_1().border_color(c.border).child(markdown(detail, ctx))));
    case "hook":
      if (!detail) return quietRow("shield", c.yellow, item.text, ctx);
      return v_flex().w_full().gap(6)
        .child(toggler(div(), item.id, ctx).w_full().child(quietRow("shield", c.yellow, item.text, ctx).child(chevron(open, c))))
        .when(open, (el) => el.child(quietBlock(detail, `${item.id}:hook`, ctx)));
    case "recap":
      return h_flex().w_full().gap(8).items_start().py(4).text_size(t.size.ui).line_height(1.5)
        .child(div().flex_none().font_weight(600).text_color(c.muted).child("※ Recap"))
        .child(div().flex_1().min_w(0).italic().text_color(c.muted).child(item.text));
    case "card": return noticeCard(item, detail, ctx);
  }
  return item.tone === "info" ? quietRow("info", c.accent, item.text, ctx) : quietRow(null, null, item.text, ctx);
}

function noticeCard(item, detail, ctx) {
  const t = ctx.t, c = colors(t);
  const tint = item.tone === "error" ? c.red : c.yellow;
  const head = headLines(detail, 3);
  const open = ctx.open(item.id);
  return v_flex().w_full().px(16).py(12).gap(6).rounded(t.radius.card)
    .bg(mix(c.background, tint, 0.08)).border_1().border_color(mix(c.background, tint, 0.35))
    .child(h_flex().gap(8).items_start()
      .child(div().pt(2).flex_none().child(icon("alert", 14, tint)))
      .child(div().flex_1().min_w(0).text_size(t.size.ui).line_height(1.45).font_weight(500).text_color(c.foreground).child(item.text)))
    .when(Boolean(detail), (el) => el.child(div().pl(22).text_size(t.size.small).line_height(1.45).text_color(c.muted)
      .child(open ? detail : head.text)))
    .when(head.more > 0, (el) => el.child(toggler(div(), item.id, ctx).pl(22).text_size(t.size.small).font_weight(500)
      .text_color(c.muted).hover((s) => s.text_color(c.foreground)).child(open ? "Show less" : "Show more")));
}

function turnFooter(item, ctx) {
  const t = ctx.t, c = colors(t);
  const k = item.tokens;
  const total = k ? k.input + k.output + (k.cacheRead ?? 0) + (k.cacheWrite ?? 0) : 0;
  const parts = [dur(item.seconds), total ? `${count(total)} tokens` : "", money(item.cost)].filter(Boolean);
  const row = h_flex().id(`sys-${item.id}`).pb(16).gap(6).items_center().text_size(t.size.small).text_color(c.muted);
  if (!parts.length) return row;
  const tip = k && [`Input ${grouped(k.input)}`, `Output ${grouped(k.output)}`,
    k.cacheRead ? `Cache read ${grouped(k.cacheRead)}` : "", k.cacheWrite ? `Cache write ${grouped(k.cacheWrite)}` : "",
    item.cost != null ? `Cost ${money(item.cost)}` : ""].filter(Boolean).join(" · ");
  return (tip ? row.tooltip(tip) : row).child(parts.join(" · "));
}

const STATUS = {
  running: ["spinner", "blue", "Running"],
  done: ["check", "green", "Done"],
  error: ["xcircle", "red", "Failed"],
  denied: ["xcircle", "muted", "Denied"],
};

function agentChild(ch, ctx) {
  if (ch.kind === "tool") return AGENTS.has(ch.name) ? div().px(8).py(4).child(agentCard(ch, ctx)) : toolRow(ch, ctx);
  if (ch.kind === "reply") {
    const t = ctx.t;
    return div().px(12).py(4).text_size(t.size.small).text_color(t.c.muted).truncate().child(firstLine(ch.text));
  }
  return div().px(12).child(systemRow(ch, ctx));
}

function agentCard(item, ctx) {
  const t = ctx.t, c = colors(t);
  const info = agentInfo(item);
  const [glyph, tone, word] = STATUS[item.status] ?? STATUS.running;
  const open = ctx.open(item.id);
  const secs = elapsed(item);
  const meta = [info.tools ? `${info.tools} ${info.tools === 1 ? "tool" : "tools"}` : "", dur(secs)].filter(Boolean).join(" · ");
  const kids = item.children ?? [];
  const mark = icon(glyph, 14, c[tone]);
  const header = toggler(h_flex(), item.id, ctx).h(40).px(14).gap(8).items_center().hover((s) => s.bg(c.hover))
    .child(item.status === "running" ? mark.spin(800) : mark)
    .child(div().flex_1().min_w(0).truncate().text_size(t.size.ui).font_weight(500).text_color(c.foreground).child(info.title))
    .child(div().flex_none().px(6).py(2).rounded(t.radius.chip).bg(c.raised).text_size(t.size.small).text_color(c.muted).child(info.type))
    .when(Boolean(meta), (el) => el.child(div().flex_none().text_size(t.size.small).text_color(c.muted).child(meta)))
    .when(item.status === "denied" || item.status === "error", (el) => el.child(div().flex_none().text_size(t.size.small).text_color(c[tone]).child(word)))
    .child(chevron(open, c));
  const result = textOf(item.result?.text, ctx.full).trim();
  const rkey = `${item.id}:result`, ropen = ctx.open(rkey);
  const latest = kids.length && item.status === "running" && !open ? kids[kids.length - 1] : null;
  return v_flex().w_full().rounded(t.radius.card).bg(c.surface).border_1().border_color(c.border).overflow_hidden()
    .child(header)
    .when(Boolean(latest), (el) => el.child(div().pb(4).opacity(0.85).child(agentChild(latest, ctx))))
    .when(open && kids.length > 0, (el) => el.child(v_flex().py(4).border_t_1().border_color(c.border)
      .children(kids.map((ch) => agentChild(ch, ctx)))))
    .when(Boolean(result) && item.status !== "running", (el) => el.child(toggler(v_flex(), rkey, ctx).px(14).py(10).gap(6)
      .border_t_1().border_color(c.border).hover((s) => s.bg(c.hover))
      .child(ropen
        ? div().child(markdown(result, ctx))
        : h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(t.size.ui)
            .text_color(item.result?.isError ? c.red : c.muted).child(summary(result)))
          .child(chevron(false, c)))
      .when(ropen, (x) => x.child(div().text_size(t.size.small).font_weight(500).text_color(c.muted).child("Show less")))));
}
