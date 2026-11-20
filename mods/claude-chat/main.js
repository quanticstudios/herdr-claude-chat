// The Claude chat pane: header, transcript and composer over one Claude terminal's transcript.
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, exec, run, terminals, checking, appHome } from "herdr";
import { tokens, unzoom } from "./theme.js";
import * as model from "./model.js";
import * as source from "./source.js";
import * as system from "./system.js";
import { markdown } from "./md.js";
import { toolRow } from "./tools.js";
import { composer, Composer } from "./composer.js";
import { header, terminalBar } from "./header.js";
import { Chat } from "./chat.js";
import { Viewport } from "./scroll.js";

const elapsed = (ms) => { const n = Math.floor(ms / 1000); return n < 60 ? `${n}s` : `${Math.floor(n / 60)}m ${n % 60}s`; };
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const START = { kind: "start", id: "__start" };
const userSide = (it) => it && (it.kind === "user" || it.kind === "command");

/** Space between two items, from the spec: 32 between turns, 16 prompt to work, 12 work to reply. */
function gapBetween(prev, it) {
  if (!it) return 0;
  if (prev.kind === "start") return 24;
  if (userSide(it)) return userSide(prev) ? 8 : 32;
  if (userSide(prev)) return 16;
  if (it.kind === "reply") return 12;
  if (it.kind === "turn") return 8;
  if (it.kind === "tool" && prev.kind === "tool") return 2;
  return 8;
}

export default class ClaudeChat extends View {
  init(_p, cx) {
    this.p = props() ?? {};
    this.chat = new Chat(this.p.terminal ?? null);
    // why: sending from anywhere (Enter, a queued send) jumps to the bottom and follows.
    const send = this.chat.send.bind(this.chat);
    this.chat.send = (text) => { this.vp.pin(); return send(text); };
    this.chat.composer = new Composer(this.chat, cx);
    this.opened = new Set();
    this.vp = new Viewport();
    this.live = [];
    this.pending = [];
    this.gen = 0;
    this.media = new Map();
    this.fulls = new Map();
    this.wanted = [];
    this.setItems([]);
    this.ui = {};
    this.chat.start(cx, this.p.attach);
    if (!checking()) { this.awake(cx); this.start(cx); }
  }

  setItems(items, cx) {
    // why: redacted thinking has nothing to open, and a row per tool call is noise.
    items = items.filter((it) => it.kind !== "thinking" || it.text?.trim());
    const first = this.items?.[1];
    // invariant: items[0] is START, so a row's gap never depends on a row a prepended page can change.
    this.items = [START, ...items];
    this.chat.items = items;
    const at = new Map(this.items.map((it, i) => [it.id, i]));
    this.indexOf = (id) => at.get(id) ?? -1;
    const vp = this.vp;
    if (!vp.pinned && vp.topId === START.id && first && this.indexOf(first.id) > 1) {
      vp.topOff -= vp.height(START);
      vp.topId = first.id;
    }
    let i = items.length - 1;
    while (i >= 0 && items[i].kind !== "todo") i--;
    this.todo = items[i] ?? null;
    if (cx) this.cacheImages(cx);
  }

  /** Feeds lines that arrived since the last frame into the items and shows them. */
  rebuild(cx) {
    this.live = model.reduceInto(this.live, this.pending.splice(0));
    // invariant: the provisional reply leaves in the same rebuild that brings the transcript's copy, so no frame shows both or neither.
    const s = this.streamItem;
    this.setItems(s && !source.landed(s, this.live) ? [...this.live, this.revealed(s)] : this.live, cx);
  }

  /** The provisional reply cut to what the reveal has reached, so screen reads that land in chunks still read as a stream. */
  revealed(s) {
    if (s.id !== this.revealId) { this.revealId = s.id; this.shown = 0; }
    this.shown = Math.min(this.shown, s.text.length);
    return this.shown >= s.text.length ? s : { ...s, text: s.text.slice(0, this.shown) };
  }

  /** Moves the reveal on at a steady rate that drains the backlog in about one screen-read interval. */
  revealSoon(cx) {
    if (this.revealing) return;
    this.revealing = true;
    cx.timer.after(33, (cx) => {
      this.revealing = false;
      const s = this.streamItem;
      if (!s || s.id !== this.revealId || this.shown >= s.text.length) return;
      this.shown += this.rate;
      this.rebuild(cx);
      cx.notify();
      this.revealSoon(cx);
    });
  }

  /** Grows the reply Claude is writing from its TUI screen while the terminal works, because the transcript gets it only when the message ends. */
  async stream(cx, gen) {
    while (this.gen === gen) {
      // why: terminals() reports a Claude terminal's status even when agents() has no row for it.
      const working = this.chat.busy || terminals().find((t) => t.address === this.p.terminal)?.status === "working";
      if (!working && this.working) { this.working = null; this.workStart = 0; cx.notify(); }
      if (!working && !this.streamItem) { await cx.sleep(250); continue; }
      const s = working ? await source.screenText(this.p.terminal).catch(() => null) : null;
      if (this.gen !== gen) return;
      const next = source.nextStream(this.streamItem, s, Date.now());
      if (next !== this.streamItem) {
        const from = next && next.id === this.revealId ? this.shown : 0;
        this.rate = next ? Math.max(2, Math.ceil((next.text.length - from) / 7)) : 0;
        this.streamItem = next;
        this.flushSoon(cx);
        if (next) this.revealSoon(cx);
      }
      if (working && !this.workStart) this.workStart = Date.now();
      if (!working) this.workStart = 0;
      // why: Claude's fullscreen TUI hides its spinner line while reply text streams, so the chat counts the time itself.
      const w = !working ? null : s?.working ?? { verb: this.streamItem ? "Writing…" : this.working?.verb ?? "Working…", detail: elapsed(Date.now() - this.workStart) };
      if (w?.verb !== this.working?.verb || w?.detail !== this.working?.detail) { this.working = w; cx.notify(); }
      await cx.sleep(200);
    }
  }

  start(cx) {
    const gen = ++this.gen;
    this.phase = "loading";
    this.slow = false;
    this.error = null;
    // why: "Reading the chat..." shows only if the first page takes long enough to notice.
    cx.timer.after(400, (cx) => {
      if (this.gen === gen && this.phase === "loading") { this.slow = true; cx.notify(); }
    });
    cx.spawn(async (cx) => {
      try {
        await (this.p.fixture ? this.loadFixture(cx, gen) : this.loadTerminal(cx, gen));
      } catch (e) {
        if (this.gen !== gen) return;
        console.log(`claude-chat: reading ${this.p.terminal ?? this.p.fixture} failed: ${e?.stack ?? e}`);
        this.phase = "error";
        this.error = e?.message ?? String(e);
        cx.notify();
      }
    });
  }

  async loadFixture(cx, gen) {
    // why: readTextFile stops at 1 MiB and the large fixtures are bigger.
    const r = await exec("cat", [this.p.fixture]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `Can't read ${this.p.fixture}`);
    const all = JSON.parse(r.stdout);
    if (this.gen !== gen) return;
    // why: fixtures name their images relative to themselves so they work from any checkout.
    const dir = this.p.fixture.replace(/[^/]*$/, "");
    for (const it of all) for (const img of it.images ?? []) if (img.path && !img.path.startsWith("/")) img.path = dir + img.path;
    // why: previews show some rows open (`open: true` on an item) and a filled footer (props.footer).
    for (const it of all) if (it.open) this.opened.add(it.id);
    if (this.p.footer) Object.assign(this.chat.composer.footer, this.p.footer);
    this.phase = "ready";
    if (this.p.page) {
      // why: props.page (items per page) pages the fixture like a transcript, slowly, to check anchoring on prepend.
      let from = Math.max(0, all.length - this.p.page);
      this.olderPage = async () => {
        await new Promise((resolve) => cx.timer.after(600, () => resolve()));
        from = Math.max(0, from - this.p.page);
        this.hasOlder = from > 0;
        return all.slice(from);
      };
      this.hasOlder = from > 0;
      this.setItems(all.slice(from), cx);
      cx.notify();
      return this.maybeOlder(cx);
    }
    if (!this.p.replay) { this.setItems(all, cx); return cx.notify(); }
    // why: props.replay (ms per step) streams the fixture's last items in, to check following by eye.
    let k = Math.max(0, all.length - 30), grown = 0;
    this.setItems(all.slice(0, k), cx);
    cx.notify();
    cx.timer.every(this.p.replay, (cx) => {
      if (this.gen !== gen || k >= all.length) return;
      const it = all[k];
      if (it.kind === "reply" && grown < it.text.length) {
        grown += 48;
        this.setItems([...all.slice(0, k), { ...it, text: it.text.slice(0, grown), streaming: true }], cx);
      } else {
        k++; grown = 0;
        this.setItems(all.slice(0, k), cx);
      }
      cx.notify();
    });
  }

  async loadTerminal(cx, gen) {
    const row = terminals().find((t) => t.address === this.p.terminal) ?? { address: this.p.terminal };
    const feed = await source.Feed.forTerminal(row);
    if (this.gen !== gen) return;
    if (!feed) throw new Error("This Claude session's transcript isn't on disk yet.");
    this.feed = feed;
    const first = await feed.tail();
    if (this.gen !== gen) return;
    this.live = model.reduce(first.lines);
    this.pending = [];
    this.hasOlder = first.hasOlder;
    this.rebuild(cx);
    this.phase = "ready";
    cx.notify();
    this.maybeOlder(cx);
    this.streamItem = null;
    cx.spawn((cx) => this.stream(cx, gen));
    for (;;) {
      const more = await feed.next(cx);
      if (this.gen !== gen || more.closed) return;
      // why: a reset is a fresh tail (truncated file, or /clear and /resume moved to a new transcript).
      if (more.reset) {
        this.live = model.reduce(more.lines);
        this.pending = [];
        this.hasOlder = more.hasOlder;
        this.rebuild(cx);
        cx.notify();
        continue;
      }
      const lines = more.lines;
      if (!lines.length) continue;
      this.pending.push(...lines);
      this.flushSoon(cx);
    }
  }

  /** Coalesces live updates to one rebuild and redraw per frame. */
  flushSoon(cx) {
    if (this.flushing) return;
    this.flushing = true;
    cx.timer.after(16, (cx) => {
      this.flushing = false;
      this.rebuild(cx);
      cx.notify();
    });
  }

  /** Loads the page before what's shown once the reader is within a screen and a half of the top. */
  maybeOlder(cx) {
    if (!(this.feed || this.olderPage) || !this.hasOlder || this.loadingOlder || this.olderError) return;
    const near = Math.max(this.vp.vh, 400) * 1.5;
    if (this.vp.above(this.items, this.indexOf, near) >= near) return;
    this.loadingOlder = true;
    cx.notify();
    const gen = this.gen;
    cx.spawn(async (cx) => {
      try {
        if (this.olderPage) {
          this.setItems(await this.olderPage(), cx);
        } else {
          const page = await this.feed.older();
          if (this.gen !== gen) return;
          this.live = model.merge(model.reduce(page.lines), this.live);
          this.hasOlder = page.hasOlder;
          this.rebuild(cx);
        }
      } catch (e) {
        console.log(`claude-chat: older page failed: ${e?.stack ?? e}`);
        this.olderError = e?.message ?? String(e);
      }
      this.loadingOlder = false;
      cx.notify();
      this.maybeOlder(cx);
    });
  }

  ctx() {
    return {
      t: tokens(),
      cwd: this.p.cwd ?? "",
      open: (k) => this.opened.has(k),
      toggle: (k) => { this.opened.has(k) ? this.opened.delete(k) : this.opened.add(k); this.kick(); },
      openFile: (path, line) => run("pane.split", { direction: "right", mod: "files", props: { path, line } }),
      openUrl: (url) => run("app.open_url", { url }),
      copy: (text) => run("app.copy", { text }),
      full: (c) => this.full(c),
      notify: () => this.kick(),
    };
  }

  /** Wakes the view's own task to redraw and fetch queued full texts. */
  kick() { this.wake?.(); }

  // why: a render's cx dies when render returns, so ctx callbacks redraw through a task started in init.
  awake(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        await new Promise((resolve) => { this.wake = resolve; });
        for (const c of this.wanted.splice(0)) {
          if (this.feed) cx.spawn(async (cx) => { this.fulls.set(c.at, await this.feed.full(c)); cx.notify(); });
        }
        cx.notify();
      }
    });
  }

  /** A Clipped field's whole text once the source has read it, or null after asking for it. */
  full(c) {
    if (this.fulls.has(c.at)) return this.fulls.get(c.at);
    this.fulls.set(c.at, null);
    this.wanted.push(c);
    this.kick();
    return null;
  }

  /** A 64dp rounded thumbnail, cropped to fill when the image's size is known. */
  thumb(img, t, behind) {
    const S = 64, R = t.radius.block;
    const box = div().relative().size(S).flex_none().rounded(R).overflow_hidden().bg(t.c.surface);
    const m = img.path && this.media.get(img.path);
    if (m?.src && m.aspect) {
      const w = m.aspect >= 1 ? S * m.aspect : S, h = m.aspect >= 1 ? S : S / m.aspect;
      box.child(image(m.src).absolute().w(w).h(h).left((S - w) / 2).top((S - h) / 2));
    } else if (m?.src) {
      box.child(image(m.src).size_full());
    }
    // why: GPUI clips children to a rectangle, so a ring in the bubble's color rounds the image's corners.
    return box
      .child(div().absolute().left(-R).top(-R).size(S + 2 * R).rounded(2 * R).border(R).border_color(behind))
      .child(div().absolute().left(0).top(0).size(S).rounded(R).border(1).border_color(t.c.border));
  }

  /** Readies user images once each: a path under the app folder for `image()`, and the PNG's aspect ratio. */
  cacheImages(cx) {
    const home = appHome() + "/";
    for (const it of this.items) {
      if (it.kind !== "user" || !it.images?.length) continue;
      for (const img of it.images) {
        const path = img.path;
        if (!path || this.media.has(path)) continue;
        this.media.set(path, {});
        cx.spawn(async (cx) => {
          // why: `image()` reads only inside the app folder, so images from elsewhere get a cached copy.
          let src = path.startsWith(home) ? path.slice(home.length) : `.cache/claude-chat/${path.split("/").join("_")}`;
          if (!path.startsWith(home)) {
            const r = await exec("sh", ["-c", 'mkdir -p "$(dirname "$2")" && cp "$1" "$2"', "sh", path, home + src]);
            if (r.code !== 0) src = null;
          }
          // shortcut: only PNG headers give an aspect; other formats show whole, letterboxed, until a JPEG reader is worth it.
          const od = await exec("od", ["-An", "-tu1", "-j16", "-N8", path]);
          const b = od.stdout.split(" ").filter((s) => s.trim()).map(Number);
          const w = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0, h = ((b[4] << 24) | (b[5] << 16) | (b[6] << 8) | b[7]) >>> 0;
          const png = img.media === "image/png" && w > 0 && h > 0;
          this.media.set(path, { src, aspect: png ? w / h : null });
          cx.notify();
        });
      }
    }
  }

  pasted(p, i, it, ctx) {
    return system.pastedChip(p, ctx, `${it.id}:paste${i}`);
  }

  /** The live plan pinned above the composer while a turn runs, centered on the column. */
  plan(ctx) {
    // why: a fixture has no running turn, so it previews the live plan too.
    const live = this.todo && (this.chat.busy || this.p.fixture) ? system.liveTodo(this.todo, ctx) : null;
    if (!live) return null;
    return div().w_full().max_w(ctx.t.measure).mx_auto().px(24).pb(8).child(live);
  }

  user(it, ctx) {
    const t = ctx.t;
    const bubble = v_flex().max_w("84%").px(14).py(10).gap(8).bg(t.c.raised).rounded(t.radius.card).rounded_br(4)
      .text_size(t.size.body).line_height(1.55).text_color(t.c.foreground);
    if (it.text) bubble.child(div().child(it.text));
    if (it.pasted?.length) bubble.child(h_flex().flex_wrap().gap(8).children(it.pasted.map((p, i) => this.pasted(p, i, it, ctx))));
    if (it.images?.length) bubble.child(h_flex().flex_wrap().gap(8).children(it.images.map((img) => this.thumb(img, t, t.c.raised))));
    const col = v_flex().w_full().items_end().gap(4).child(it.queued ? bubble.opacity(0.6) : bubble);
    if (it.queued) col.child(div().text_size(t.size.small).text_color(t.c.muted).child("Queued"));
    return col;
  }

  row(it, ctx) {
    if (it.kind === "start") return this.topRow(ctx.t);
    if (it.kind === "user") return this.user(it, ctx);
    if (it.kind === "reply") return markdown(it.text, ctx, it.id);
    if (it.kind === "tool" && !model.SYSTEM_TOOLS.includes(it.name)) return toolRow(it, ctx);
    return system.systemRow(it, ctx);
  }

  /** One transcript row, centered at the measure and measured for the viewport. */
  rowEl(i, ctx) {
    const t = ctx.t, it = this.items[i];
    let body;
    try {
      body = this.row(it, ctx);
    } catch (e) {
      console.log(`claude-chat: drawing ${it.kind} ${it.id} failed: ${e?.stack ?? e}`);
      body = div().text_size(t.size.small).text_color(t.c.muted).child(`Couldn't draw this ${it.kind}.`);
    }
    return div().id(`r:${it.id}`).w_full().flex_none().pb(gapBetween(it, this.items[i + 1]))
      .on_size_change((s, cx) => { if (this.vp.measure(it.id, unzoom(s.height))) this.remeasured(cx); })
      .child(div().w_full().max_w(t.measure).mx_auto().px(24).child(body));
  }

  /** Redraws only when new heights change which rows the window holds. */
  remeasured(cx) {
    const w = this.vp.window(this.items, this.indexOf), d = this.drawn;
    if (!d || w.aStart !== d.aStart || w.start !== d.start || w.end !== d.end) cx.notify();
  }

  rows(from, to, ctx) {
    const out = [];
    for (let i = from; i < to; i++) out.push(this.rowEl(i, ctx));
    return out;
  }

  /** The topmost row: loading, an error, or the start of the conversation. */
  topRow(t) {
    if (this.olderError) {
      return h_flex().id("older-retry").w_full().justify_center().gap(8).pt(16).text_size(t.size.small).text_color(t.c.muted)
        .child(`Couldn't load earlier messages.`)
        .child(div().id("older-again").text_color(t.c.accent).cursor_pointer()
          .on_click((_e, cx) => { this.olderError = null; this.maybeOlder(cx); cx.notify(); }).child("Try again"));
    }
    if (this.loadingOlder) {
      return h_flex().w_full().justify_center().gap(6).pt(16).text_size(t.size.small).text_color(t.c.muted)
        .child(div().frames(SPINNER, 80)).child("Loading earlier messages");
    }
    return div();
  }

  transcript(ctx) {
    const t = ctx.t, vp = this.vp;
    const w = this.drawn = vp.window(this.items, this.indexOf);
    const area = div().id("tx").relative().flex_1().min_h(0).overflow_hidden()
      .on_size_change((s, cx) => { const h = unzoom(s.height); if (vp.vh !== h) { vp.vh = h; cx.notify(); } })
      .on_scroll_wheel((e, cx) => {
        const was = vp.pinned;
        vp.scroll(this.items, this.indexOf, e.delta.y);
        if (was && !vp.pinned) this.seen = this.items[this.items.length - 1].id;
        this.maybeOlder(cx);
        cx.notify();
      });
    if (w.pinned || !vp.vh) {
      // why: min_h keeps a short chat at the top; a long one grows up from the bottom edge.
      area.child(v_flex().absolute().left(0).right(0).bottom(0).min_h(vp.vh).pb(16)
        .children(this.rows(w.start, w.end, ctx)));
    } else {
      area.child(v_flex().absolute().left(0).right(0).bottom(vp.vh + w.off)
        .children(this.rows(w.aStart, w.start, ctx)));
      area.child(v_flex().absolute().left(0).right(0).top(-w.off).pb(16).children(this.rows(w.start, w.end, ctx)));
      area.child(this.scrollbar(w, t));
      area.child(this.jump(t));
    }
    return area;
  }

  /** A quiet position marker while scrolled up; the transcript follows the wheel, not a drag. */
  scrollbar(w, t) {
    const n = this.items.length, vh = this.vp.vh;
    const thumb = Math.max(32, Math.min(vh / 2, vh * 20 / Math.max(n, 1)));
    const at = (vh - thumb) * Math.min(1, w.start / Math.max(1, n - 10));
    return div().absolute().right(3).top(at).w(4).h(thumb).rounded(2).bg(t.c.border);
  }

  jump(t) {
    const fresh = this.seen != null && this.items[this.items.length - 1].id !== this.seen;
    return h_flex().absolute().left(0).right(0).bottom(8).justify_center().child(
      h_flex().id("jump").h(28).px(12).gap(6).rounded(14).bg(t.c.raised).border(1).border_color(t.c.input).shadow_md()
        .text_size(t.size.small).font_weight(500).text_color(fresh ? t.c.foreground : t.c.muted).cursor_pointer()
        .hover((s) => s.bg(t.c.selected))
        .on_click((_e, cx) => { this.vp.pin(); cx.notify(); })
        .child("↓").child(fresh ? "New output" : "Jump to latest"));
  }

  button(id, label, primary, t, onClick) {
    return h_flex().id(id).h(28).px(12).rounded(t.radius.chip).cursor_pointer()
      .text_size(t.size.ui).font_weight(500)
      .bg(primary ? t.c.solid : t.c.raised).text_color(primary ? t.c.solid_foreground : t.c.foreground)
      .hover((s) => s.opacity(0.9)).on_click(onClick).child(label);
  }

  /** "Reading the chat..." after a moment, or the error with its two ways out. */
  status(ctx) {
    const t = ctx.t;
    const center = v_flex().flex_1().min_h(0).items_center().justify_center().gap(12).px(24);
    if (this.phase === "loading") {
      if (!this.slow) return center;
      return center.child(h_flex().gap(8).text_size(t.size.ui).text_color(t.c.muted)
        .child(div().frames(SPINNER, 80)).child("Reading the chat..."));
    }
    return center.child(v_flex().max_w(420).gap(8).px(16).py(12).rounded(10).bg(t.c.surface).border(1).border_color(t.c.border)
      .child(div().text_size(t.size.ui).font_weight(500).text_color(t.c.foreground).child("Couldn't read this chat"))
      .child(div().text_size(t.size.small).line_height(1.45).text_color(t.c.muted).child(this.error ?? ""))
      .child(h_flex().gap(8).pt(4)
        .child(this.button("retry", "Try again", true, t, (_e, cx) => { this.start(cx); cx.notify(); }))
        .child(this.button("terminal", "Open terminal", false, t, (_e, cx) => { this.chat.toggleTerminal(cx); cx.notify(); })
          .tooltip("Alt+T"))));
  }

  /** A new chat: what it is and where it runs, until the first message. */
  empty(ctx) {
    const t = ctx.t;
    const cwd = (this.chat.cwd || this.p.cwd || "").replace(/^\/home\/[^/]+(?=\/|$)/, "~").replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
    return v_flex().flex_1().min_h(0).items_center().justify_center().gap(6).px(24)
      .child(h_flex().gap(10).items_center()
        .child(image("mods/claude-chat/icons/claude.svg").size(26).flex_none())
        .child(div().text_size(22).font_weight(600).text_color(t.c.foreground).child("Claude Code")))
      .when(Boolean(cwd), (el) => el.child(div().text_size(t.size.ui).text_color(t.c.muted).child(cwd)))
      .child(div().pt(10).text_size(t.size.small).text_color(t.c.dim).child("/ for commands · @ for files · Alt+T for the terminal"));
  }

  /** Claude's spinner line from its screen: what it is doing, for how long, and how many tokens. */
  workingRow(t) {
    const w = this.working;
    return h_flex().flex_none().w_full().max_w(t.measure).mx_auto().px(24).pt(4).h(28).gap(8).items_center().text_size(t.size.small)
      .child(div().flex_none().text_color(t.c.accent).frames(SPINNER, 80))
      .child(div().flex_none().font_weight(500).text_color(t.c.foreground).child(w.verb))
      .when(!!w.detail, (el) => el.child(div().min_w(0).truncate().text_color(t.c.muted).child(w.detail)));
  }

  render(cx) {
    const ctx = this.ctx();
    const plan = this.phase === "ready" ? this.plan(ctx) : null;
    const t = ctx.t;
    if (this.chat.terminalView) return terminalBar(this.chat, ctx);
    let body;
    try {
      // why: a new session's transcript already holds hook output and notices, none of which is a conversation yet.
      const started = this.streamItem || this.items.some((it) => it.kind === "user" || it.kind === "reply" || it.kind === "tool");
      body = this.phase !== "ready" ? this.status(ctx) : started ? this.transcript(ctx) : this.empty(ctx);
    } catch (e) {
      // why: the host keeps the last good frame silently on a throw; drawing the error says what broke.
      body = div().flex_1().p(24).text_size(t.size.small).text_color(t.c.muted).child(`Couldn't draw the chat: ${e?.stack ?? e}`);
    }
    return v_flex().size_full().bg(t.c.background).font_family(t.font.ui)
      .child(header(this.chat, ctx, this.ui)).child(body).when(!!plan, (el) => el.child(plan))
      .when(this.phase === "ready" && !!this.working, (el) => el.child(this.workingRow(t)))
      .child(composer(this.chat, ctx));
  }
}
