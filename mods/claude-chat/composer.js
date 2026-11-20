// The composer: textarea, image tokens, slash and @ menus, model/effort/mode chips, and the approval card.
import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex, Popup, Textarea, TextareaState, ScrollHandle } from "gpui-base";
import { agents, terminals, hc, exec, home, appHome, readTextFile, checking, shared, setShared } from "herdr";
import * as c from "./compose.js";
import { markdown } from "./md.js";
import { parseApproval } from "./approval.js";

const M = "mods/claude-chat";
const icon = (name, size, color) => svg(`${M}/icons/${name}.svg`).size(size).flex_none().text_color(color);
const sleep = (cx, ms) => new Promise((done) => cx.timer.after(ms, () => done()));

// Saves the clipboard's image (or takes file "$2") as "$1.<ext>", writes a 128px center-cropped "$1.thumb.png", prints the image path.
const CLIP = String.raw`base="$1"; mkdir -p "$(dirname "$base")"
grab() { t="$1"; out="$base.$(printf %s "$t" | sed 's|image/||; s|jpeg|jpg|; s|+xml||')"; }
if [ -n "$2" ]; then
  out="$2"
elif [ -n "$WAYLAND_DISPLAY" ] && command -v wl-paste >/dev/null 2>&1; then
  t=$(wl-paste --list-types 2>/dev/null | grep -m1 '^image/') || exit 3
  grab "$t"; wl-paste --type "$t" > "$out" || exit 4
elif command -v xclip >/dev/null 2>&1; then
  t=$(xclip -selection clipboard -t TARGETS -o 2>/dev/null | grep -m1 '^image/') || exit 3
  grab "$t"; xclip -selection clipboard -t "$t" -o > "$out" || exit 4
else
  out="$base.png"
  python3 -c 'import sys,gi; gi.require_version("Gtk","3.0"); from gi.repository import Gtk,Gdk
i=Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).wait_for_image()
sys.exit(3) if i is None else i.savev(sys.argv[1],"png",[],[])' "$out" || exit 3
fi
python3 -c 'import sys,gi; gi.require_version("GdkPixbuf","2.0"); from gi.repository import GdkPixbuf as P
p=P.Pixbuf.new_from_file(sys.argv[1]); w,h=p.get_width(),p.get_height(); s=min(w,h)
p.new_subpixbuf((w-s)//2,(h-s)//2,s,s).scale_simple(128,128,P.InterpType.HYPER).savev(sys.argv[2],"png",[],[])' "$out" "$base.thumb.png" 2>/dev/null
echo "$out"`;

// Lists commands and skills as name<TAB>description<TAB>source, user ones first, then the project's.
// why: plugin skills sit behind a 7 MB installed_plugins.json, past readTextFile's 1 MiB, so a helper lists them.
const commandsHelper = () => `${appHome()}/mods/claude-chat/bin/commands.py`;

let bound = false;

const PLACEHOLDER = { idle: "Reply to Claude", working: "Enter: Claude sees it at its next step · Alt+Enter: send when it finishes", blocked: "Answer above, or type to queue" };
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** The blocked screen's prompt: the composer's reader first, then chat.js's, which also knows unnumbered prompts. */
function promptOf(screen) {
  const p = c.readPrompt(screen);
  if (p) return p;
  const a = parseApproval(screen);
  if (!a) return null;
  return {
    title: a.title, body: a.lines.join("\n"), question: a.question, esc: true, kind: "approval",
    options: a.options.map((o) => ({ key: String(o.n), label: o.label, detail: "", keys: o.keys })),
  };
}

/** One placement for every composer popover: its left edge on the trigger's, opening upward 6 above it. */
function anchored(id, trigger, open, content) {
  return Popup.new(id, trigger).anchor("bottom_left").when(open, (el) => el.content(div().pb(6).child(content)));
}

/** The composer of one chat; built in the view's init, drawn with render(ctx). */
export class Composer {
  constructor(chat, cx) {
    this.chat = chat;
    this.store = `composer:${chat.terminal ?? "fixture"}`;
    this.ta = TextareaState.new({ placeholder: "" });
    this.ta.set_auto_grow(1, 10);
    this.cardFocus = cx.focus_handle();
    this.images = [];
    this.history = this.load("history", []);
    this.recall = -1;
    this.queued = [];
    // invariant: held messages stay in the chat, never in Claude's input, until a turn ends; so they can still be edited or dropped.
    this.held = this.load("held", []);
    this.footer = this.load("footer", { model: null, effort: null, mode: null, context: null });
    this.footerAt = 0;
    this.want = null;
    this.prompt = null;
    this.pop = null;
    this.menuAt = 0;
    this.menuScroll = ScrollHandle.new();
    this.commands = c.BUILTINS;
    this.files = null;
    this.notice = null;
    this.focused = false;
    this.hoverThumb = null;
    this.settings = {};
    this.lastStatus = null;
    this.turn = null;
    const draft = this.load("draft", null);
    if (draft?.content) {
      this.images = draft.images ?? [];
      this.ta.set_value(draft.content);
    }
    this.ta.on("change", (_e, cx) => this.changed(cx));
    this.ta.on("paste_other", (_e, cx) => this.pasteImage(cx));
    this.ta.on("submit", (e, cx) => this.enter(e, cx));
    if (!bound) {
      // why: the textarea takes Up, Down and Tab itself, so the composer claims them only while a menu or the history needs them.
      bound = cx.bind_keys(["up", "down", "tab"].map((k) => ({ keystroke: k, action: `composer_${k}`, context: "ComposerNav > Input" }))) > 0;
    }
    // why: Alt+T back to the chat, and pane.go onto it, hand the keyboard to whatever the composer shows.
    chat.on?.("focus", () => (this.prompt ? this.cardFocus.focus() : this.ta.focus()));
    if (checking() || !chat.terminal) return;
    cx.spawn(async (cx) => {
      try { this.settings = JSON.parse((await readTextFile(`${home()}/.claude/settings.json`)) ?? "{}"); } catch { this.settings = {}; }
      const r = await exec("python3", ["-I", commandsHelper(), this.cwd() || home()]).catch(() => null);
      if (r) this.commands = c.parseCommands(r.stdout);
      cx.notify();
    });
    // why: tick awaits; a timer's or init's cx is only good until the callback returns, so its notify after a read redrew nothing.
    cx.timer.every(1000, (cx) => { cx.spawn(async (cx) => this.tick(cx)); });
    cx.spawn(async (cx) => this.tick(cx));
  }

  load(name, fallback) {
    try { return JSON.parse(localStorage.getItem(`${this.store}:${name}`)) ?? fallback; } catch { return fallback; }
  }
  save(name, value) {
    try { localStorage.setItem(`${this.store}:${name}`, JSON.stringify(value)); } catch { /* why: a full or missing store only loses the draft */ }
  }

  // why: auto mode is an account feature, so once any chat's footer shows it every chat offers it.
  get seenAuto() { return shared("claude-chat.auto") === true; }
  sawAuto() { if (!this.seenAuto) setShared("claude-chat.auto", true); }

  term() { return terminals().find((t) => t.address === this.chat.terminal) ?? null; }
  status() { return agents().find((a) => a.address === this.chat.terminal)?.status ?? this.chat.status ?? "idle"; }
  cwd() { return this.term()?.cwd ?? ""; }

  // ---- reading the TUI ----

  async read() {
    // why: 200 lines of history keep the last "Set effort level" acknowledgement in view after it scrolls off.
    // why: the tick waits on this read, and one hc read that never returned froze the approval card for good.
    const r = await exec("hc", ["read", this.chat.terminal, "--lines", "200"], { timeout: 4000 }).catch(() => null);
    return r && r.code === 0 ? r.stdout : null;
  }

  async tick(cx) {
    if (this.reading) return;
    this.reading = true;
    try {
      const status = this.status();
      const turn = this.term()?.turn ?? 0;
      // why: a turn that runs straight into a queued message never bumps hc's turn count, so the transcript decides.
      const left = c.stillQueued(this.queued, this.chat.items);
      if (left.length !== this.queued.length) { this.queued = left; cx.notify(); }
      if (status === "idle" || status === "done" || (this.turn != null && turn > this.turn)) {
        this.queued = this.queued.filter((q) => q.turn >= turn && status === "working");
      }
      this.turn = turn;
      if (this.held.length && (status === "idle" || status === "done") && Date.now() - (this.sentAt ?? 0) > 3000) this.flushHeld(cx);
      const due = status === "blocked" || status !== this.lastStatus || Date.now() - this.footerAt > 4000;
      this.lastStatus = status;
      if (!due) return;
      const screen = await this.read();
      if (screen == null) return;
      this.footerAt = Date.now();
      const f = c.readFooter(screen);
      this.footer = {
        model: f.model ?? this.footer.model,
        effort: f.effort ?? this.footer.effort,
        mode: f.box ? f.mode : this.footer.mode,
        context: f.box ? f.context : this.footer.context,
      };
      this.save("footer", this.footer);
      if (f.mode === "auto") this.sawAuto();
      const was = c.promptKey(this.prompt);
      const cardHad = this.cardFocus.is_focused();
      this.prompt = status === "blocked" ? promptOf(screen) ?? { unknown: true } : null;
      if (this.prompt && c.promptKey(this.prompt) !== was) this.cardFocus.focus();
      // why: the card leaves with the prompt; without this the keyboard goes nowhere after an answer from the TUI or the sidebar.
      else if (!this.prompt && cardHad) this.ta.focus();
      if (this.want && Date.now() > this.want.until) this.want = null;
      cx.notify();
    } finally {
      this.reading = false;
    }
  }

  /** The model, effort and mode to show: an optimistic pick, then the footer, the claude flags, Claude's settings. */
  values() {
    const argv = this.term()?.argv ?? [];
    const w = this.want ?? {};
    const model = w.model ? c.modelName(w.model) : this.footer.model ?? c.modelName(c.flag(argv, "--model") ?? this.settings.model);
    const effort = w.effort ?? this.footer.effort ?? c.flag(argv, "--effort") ?? this.settings.effortLevel ?? null;
    const mode = w.mode ?? this.footer.mode ?? c.flag(argv, "--permission-mode") ?? (c.mayBypass([c.flag(argv, "--permission-mode")]) ? "bypassPermissions" : null);
    return { model, effort, mode, bypass: c.mayBypass(argv) || mode === "bypassPermissions" };
  }

  // ---- the draft ----

  changed(cx) {
    const content = this.ta.content();
    // why: deleting an [Image #N] token in the text drops its image, so the chip row follows the text.
    const live = new Set(content.tokens.map((t) => t.token.id));
    this.images = this.images.filter((im) => live.has(im.id));
    if (!content.text) this.images = [];
    this.save("draft", content.text ? { content, images: this.images } : null);
    let text = content.text;
    let caret = this.ta.selected_range().end;
    // why: Enter types its newline before `submit` arrives, and that newline must not close the menu Enter is picking from.
    if ((this.pop === "slash" || this.pop === "at") && text[caret - 1] === "\n") {
      text = text.slice(0, caret - 1) + text.slice(caret);
      caret--;
    }
    const slash = c.slashWord(text, caret);
    const at = slash == null ? c.atWord(text, caret) : null;
    const was = this.pop;
    this.pop = slash != null ? "slash" : at ? "at" : this.pop === "slash" || this.pop === "at" ? null : this.pop;
    if (this.pop !== was || this.pop === "slash" || this.pop === "at") { this.menuAt = 0; this.menuScroll.scroll_to_item(0); }
    if (this.pop === "at" && !this.files) this.loadFiles(cx);
    cx.notify();
  }

  loadFiles(cx) {
    this.files = [];
    cx.spawn(async (cx) => {
      const cwd = this.cwd();
      if (!cwd) return;
      let r = await exec("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd }).catch(() => null);
      if (!r || r.code !== 0) r = await exec("find", [".", "-maxdepth", "4", "-type", "f", "-not", "-path", "*/.*"], { cwd }).catch(() => null);
      this.files = (r?.stdout ?? "").split("\n").map((l) => l.replace(/^\.\//, "")).filter(Boolean).slice(0, 20000);
      cx.notify();
    });
  }

  menuItems() {
    const text = this.ta.value();
    const caret = this.ta.selected_range().end;
    if (this.pop === "slash") {
      const q = c.slashWord(text, caret) ?? "";
      return c.filterBy(this.commands, q, (x) => [x.name, ...(x.aliases ?? [])], 1000)
        .map((x) => ({ id: x.name, label: "/" + x.name + (x.aliases?.length ? ` (${x.aliases.join(", ")})` : ""), desc: x.desc, x }));
    }
    if (this.pop === "at") {
      const q = c.atWord(text, caret)?.query ?? "";
      return c.filterBy(this.files ?? [], q, (x) => x, 200).map((p) => ({ id: p, label: p, desc: "", x: p }));
    }
    return [];
  }

  pick(item, cx) {
    const text = this.ta.value();
    if (this.pop === "slash") {
      this.ta.set_selected_range({ start: 0, end: c.firstSpace(text) });
      this.ta.replace(`/${item.x.name} `);
    } else if (this.pop === "at") {
      const w = c.atWord(text, this.ta.selected_range().end);
      if (w) {
        this.ta.set_selected_range({ start: w.start, end: w.end });
        this.ta.replace(`@${item.x} `);
      }
    }
    this.pop = null;
    this.ta.focus();
    cx.notify();
  }

  addImage(path, thumb) {
    const n = c.nextImage(this.images);
    const id = `img-${n}-${Date.now()}`;
    this.images.push({ id, n, path, thumb });
    this.ta.replace_with_token({ id, text: `[Image #${n}]`, label: `Image #${n}` });
    this.ta.replace(" ");
  }

  /** Saves the clipboard image, or makes a thumbnail for a dropped file, and adds its token. */
  pasteImage(cx, file = "") {
    if (checking()) return;
    cx.spawn(async (cx) => {
      // why: image() reads only files inside the app folder, so pastes and thumbnails live there.
      const base = `${appHome()}/.cache/claude-chat/img-${Date.now()}-${(this.seq = (this.seq ?? 0) + 1)}`;
      const r = await exec("sh", ["-c", CLIP, "sh", base, file]).catch(() => null);
      const path = r?.code === 0 ? r.stdout.trim().split("\n").pop() : "";
      if (!path) { this.say(cx, r?.code === 3 ? "The clipboard has no image" : "Couldn't read the clipboard image"); return; }
      this.addImage(path, `${base}.thumb.png`);
      this.ta.focus();
      cx.notify();
    });
  }

  dropped(paths, cx) {
    for (const p of paths) {
      if (IMAGE_EXT.test(p)) this.pasteImage(cx, p);
      else this.ta.replace(`@${p} `);
    }
    this.ta.focus();
    cx.notify();
  }

  /** A path under the app folder as image() takes it: relative to the folder. */
  appPath(path) {
    const root = appHome() + "/";
    return path.startsWith(root) ? path.slice(root.length) : path;
  }

  removeImage(id, cx) {
    this.ta.set_value(c.dropToken(this.ta.content(), id));
    this.images = this.images.filter((im) => im.id !== id);
    this.hoverThumb = null;
    this.changed(cx);
  }

  say(cx, text) {
    this.notice = text;
    const at = Date.now();
    this.noticeAt = at;
    cx.timer.after(4000, (cx) => { if (this.noticeAt === at) { this.notice = null; cx.notify(); } });
    cx.notify();
  }

  // ---- sending ----

  async submit(cx) {
    const content = this.ta.content();
    const text = c.promptText(content, this.images);
    if (!text || this.sending) return;
    const status = this.status();
    if (status === "blocked") {
      const no = this.denyOption();
      if (!no) { this.say(cx, "Answer Claude's question first; your message stays here"); return; }
      this.ta.set_value("");
      this.save("draft", null);
      this.answer(no.key, cx, text);
      return;
    }
    this.sending = true;
    const images = this.images;
    this.ta.set_value("");
    this.images = [];
    this.save("draft", null);
    this.pop = null;
    this.recall = -1;
    const err = await this.chat.send(text).catch((e) => String(e));
    this.sending = false;
    if (err) {
      // invariant: a failed send never loses the draft; it comes back unless something new was typed.
      if (!this.ta.value()) { this.ta.set_value(content); this.images = images; this.save("draft", { content, images }); }
      this.say(cx, `Couldn't send: ${String(err).split("\n")[0]}`);
      return;
    }
    this.sentAt = Date.now();
    this.history = [...this.history.filter((h) => h !== content.text), content.text].slice(-50);
    this.save("history", this.history);
    if (status === "working") this.queued.push({ text: content.text, turn: this.term()?.turn ?? 0, at: Date.now() });
    cx.notify();
  }

  /** Keeps the box's message in the chat to send when the current turn ends. */
  hold(cx) {
    const content = this.ta.content();
    if (!c.promptText(content, this.images)) return;
    this.held.push({ content, images: this.images });
    this.ta.set_value("");
    this.images = [];
    this.save("draft", null);
    this.save("held", this.held);
    cx.notify();
  }

  /** Sends the first held message. */
  async flushHeld(cx) {
    const h = this.held[0];
    if (!h || this.sending) return;
    this.sending = true;
    this.sentAt = Date.now();
    const err = await this.chat.send(c.promptText(h.content, h.images)).catch((e) => String(e));
    this.sending = false;
    if (err) { this.say(cx, `Couldn't send the held message: ${String(err).split("\n")[0]}`); return; }
    this.held = this.held.filter((x) => x !== h);
    this.save("held", this.held);
    this.history = [...this.history.filter((x) => x !== h.content.text), h.content.text].slice(-50);
    this.save("history", this.history);
    cx.notify();
  }

  /** Edit puts a held message back in the box, up moves it one place earlier, drop removes it. */
  heldAction(i, what, cx) {
    const h = this.held[i];
    if (!h) return;
    if (what === "up" && i > 0) [this.held[i - 1], this.held[i]] = [h, this.held[i - 1]];
    else this.held.splice(i, 1);
    if (what === "edit") { this.ta.set_value(h.content); this.images = h.images ?? []; this.ta.focus(); }
    this.save("held", this.held);
    cx.notify();
  }

  recallHistory(dir, cx) {
    if (!this.history.length) return false;
    const next = this.recall < 0 ? (dir < 0 ? this.history.length - 1 : -1) : this.recall + dir;
    if (next < 0 || next >= this.history.length) {
      if (this.recall >= 0 && dir > 0) { this.recall = -1; this.ta.set_value(""); cx.notify(); return true; }
      return false;
    }
    this.recall = next;
    this.ta.set_value(this.history[next]);
    this.ta.set_selected_range({ start: this.history[next].length, end: this.history[next].length });
    cx.notify();
    return true;
  }

  interrupt(cx) {
    cx.spawn(async () => { await this.chat.interrupt(); });
  }

  /** Enter in the textarea, which has already typed its newline: picks the menu row, or sends. */
  enter(e, cx) {
    if (e.secondary || e.shift) return;
    const caret = this.ta.selected_range().end;
    if (this.ta.value()[caret - 1] === "\n") {
      this.ta.set_selected_range({ start: caret - 1, end: caret });
      this.ta.replace("");
    }
    const menu = this.pop === "slash" || this.pop === "at" ? this.menuItems() : null;
    if (menu?.length) { this.pick(menu[Math.min(this.menuAt, menu.length - 1)], cx); return; }
    cx.spawn(async (cx) => this.submit(cx));
  }

  /** Whether Up, Down and Tab belong to the composer: a menu is open, the box is empty, or it shows a recalled prompt. */
  navigable() {
    if (this.pop === "slash" || this.pop === "at") return true;
    const v = this.ta.value();
    return !v || (this.recall >= 0 && v === this.history[this.recall]);
  }

  nav(k, cx) {
    const menu = this.pop === "slash" || this.pop === "at" ? this.menuItems() : null;
    if (menu?.length) {
      if (k === "tab") this.pick(menu[Math.min(this.menuAt, menu.length - 1)], cx);
      else {
        this.menuAt = (this.menuAt + (k === "up" ? -1 : 1) + menu.length) % menu.length;
        this.menuScroll.scroll_to_item(this.menuAt);
      }
      cx.notify();
      return;
    }
    if (k !== "tab") this.recallHistory(k === "up" ? -1 : 1, cx);
  }

  /** Keys the textarea leaves to the composer: Enter sends, menus move, Esc stops, Shift+Tab cycles the mode. */
  key(e, cx) {
    const k = e.keystroke;
    if (!this.focused) { this.focused = true; cx.notify(); }
    if (k === "escape") {
      if (this.pop) { this.pop = null; cx.notify(); } else if (this.status() === "working") this.interrupt(cx);
      cx.stop_propagation(); return;
    }
    if (k === "shift-enter") { this.ta.replace("\n"); cx.stop_propagation(); return; }
    if (k === "alt-enter") {
      if (this.status() === "idle" || this.status() === "done") cx.spawn(async (cx) => this.submit(cx));
      else this.hold(cx);
      cx.stop_propagation(); return;
    }
    if (k === "alt-backspace") {
      const end = this.ta.selected_range().end;
      this.ta.set_selected_range({ start: c.wordStart(this.ta.value(), end), end });
      this.ta.replace("");
      cx.stop_propagation(); return;
    }
    if (k === "shift-tab") {
      const v = this.values();
      const choices = c.modeChoices(v.bypass, this.seenAuto);
      this.setMode(c.nextMode(v.mode ?? "default", choices), cx);
      cx.stop_propagation(); return;
    }
  }

  // ---- settings: model, effort, mode ----

  choose(what, value, cx) {
    this.pop = null;
    this.want = { ...(this.want ?? {}), [what]: value, until: Date.now() + 8000 };
    cx.notify();
    if (what === "mode") return this.setMode(value, cx);
    const cmd = what === "model" ? `/model ${value}` : `/effort ${value}`;
    cx.spawn(async (cx) => {
      if (this.status() === "working" || this.status() === "blocked") { this.want = null; this.say(cx, "Claude is busy; change it when the turn ends"); return; }
      const err = await this.chat.send(cmd).catch((e) => String(e));
      if (err) { this.want = null; this.say(cx, `Couldn't send ${cmd}`); }
      // why: the TUI shows a new effort only briefly, so a pick that went through is the reading from now on.
      else { this.footer[what] = what === "model" ? c.modelName(value) : value; this.save("footer", this.footer); }
      this.footerAt = 0;
      cx.notify();
    });
  }

  /** Presses Shift+Tab until the footer reads `target`: one press, then waits for the footer to move, at most two cycles. */
  setMode(target, cx) {
    this.want = { ...(this.want ?? {}), mode: target, until: Date.now() + 15000 };
    cx.notify();
    cx.spawn(async (cx) => {
      let mode = c.readFooter(await this.read()).mode;
      for (let i = 0; mode && i < 10; i++) {
        if (mode === "auto") this.sawAuto();
        if (mode === target) { this.footer.mode = target; this.want = null; cx.notify(); return; }
        await this.chat.keys("shift+tab");
        // why: the TUI redraws its footer up to a second or two after a press; pressing again before it moves overshoots.
        let next = mode;
        for (let j = 0; j < 12 && next === mode; j++) {
          await sleep(cx, 250);
          const f = c.readFooter(await this.read());
          if (f.box && f.mode) next = f.mode;
        }
        if (next === mode) break;
        mode = next;
      }
      this.want = null;
      this.footerAt = 0;
      this.say(cx, `Couldn't switch to ${c.modeName(target)}`);
    });
  }

  // ---- approvals ----

  /** The open approval's "No" option, which a typed reason answers. */
  denyOption() {
    return this.prompt?.kind === "approval" ? this.prompt.options.find((o) => /^no\b/i.test(o.label)) ?? null : null;
  }

  /** Presses an approval key after re-reading the screen; a changed prompt refuses and shows the new one. `then` is sent once Claude stops waiting. */
  answer(key, cx, then) {
    const asked = c.promptKey(this.prompt);
    cx.spawn(async (cx) => {
      const screen = await this.read();
      const now = screen == null ? null : promptOf(screen);
      if (c.promptKey(now) !== asked) { this.prompt = now ?? (this.status() === "blocked" ? { unknown: true } : null); this.say(cx, now ? "The prompt changed; here is the new one" : "That prompt was already answered"); return; }
      await this.chat.keys(...(this.prompt?.options?.find((o) => o.key === key)?.keys ?? [key]));
      this.prompt = null;
      this.ta.focus();
      this.footerAt = 0;
      cx.notify();
      if (!then) return;
      // why: the TUI takes typed text only once its prompt is gone, so the reason waits for the screen to drop it.
      for (let i = 0; i < 30; i++) {
        const s = await this.read();
        if (s != null && !promptOf(s)) break;
        await new Promise((resolve) => cx.timer.after(100, () => resolve()));
      }
      const err = await this.chat.send(then).catch((e) => String(e));
      if (err) { this.ta.set_value(then); this.say(cx, `Couldn't send the reason: ${String(err).split("\n")[0]}`); }
    });
  }

  // ---- drawing ----

  render(ctx) {
    const t = ctx.t;
    const status = this.status();
    const showCard = status === "blocked" && this.prompt;
    return v_flex().flex_none().w_full().max_w(t.measure).mx_auto().px(24).pb(16).pt(12).gap(8).font_family(t.font.ui)
      .when(this.queued.length > 0, (el) => el.child(this.queuedRow(t)))
      .when(this.held.length > 0, (el) => el.child(this.heldRow(t)))
      .when(Boolean(this.notice), (el) => el.child(div().text_size(t.size.small).text_color(t.c.muted).child(this.notice)))
      .when(showCard, (el) => el.child(this.card(t, ctx)))
      .when(!showCard || Boolean(this.denyOption()), (el) => el.child(this.box(t, status)));
  }

  queuedRow(t) {
    return v_flex().gap(4).children(this.queued.map((q, i) =>
      h_flex().id(`queued-${i}`).gap(8).items_center().px(12).h(28).rounded(t.radius.chip).bg(t.c.raised)
        .child(div().text_size(t.size.small).font_weight(500).text_color(q.sending ? t.c.accent : t.c.muted).flex_none().child(q.sending ? "Sending…" : "Queued"))
        .child(div().flex_1().min_w(0).truncate().text_size(t.size.small).text_color(t.c.foreground).child(q.text.replace(/\s+/g, " ")))
        .when(i === 0 && !q.sending, (el) => el.child(div().id("queued-send").flex_none().px(6).rounded(6).cursor_pointer()
          .text_size(t.size.small).font_weight(500).text_color(t.c.muted).hover((s) => s.bg(t.c.hover).text_color(t.c.foreground))
          .tooltip("Stop the current turn; Claude takes the queue next (Esc)")
          .on_click((_e, cx) => { q.sending = true; this.interrupt(cx); cx.notify(); }).child("Send now")))));
  }

  heldRow(t) {
    const act = (id, label, tip, onClick) => div().id(id).flex_none().px(6).rounded(6).cursor_pointer()
      .text_size(t.size.small).font_weight(500).text_color(t.c.muted).hover((s) => s.bg(t.c.hover).text_color(t.c.foreground))
      .tooltip(tip).on_click((_e, cx) => onClick(cx)).child(label);
    return v_flex().gap(4).children(this.held.map((h, i) =>
      h_flex().id(`held-${i}`).gap(8).items_center().px(12).h(28).rounded(t.radius.chip).border(1).border_color(t.c.border)
        .child(div().text_size(t.size.small).font_weight(500).text_color(t.c.muted).flex_none().child(i === 0 ? "Next" : `Then ${i + 1}`))
        .child(div().flex_1().min_w(0).truncate().text_size(t.size.small).text_color(t.c.foreground).child(c.promptText(h.content, h.images ?? []).replace(/\s+/g, " ")))
        .child(act(`held-edit-${i}`, "Edit", "Back into the box", (cx) => this.heldAction(i, "edit", cx)))
        .when(i > 0, (el) => el.child(act(`held-up-${i}`, "↑", "Send earlier", (cx) => this.heldAction(i, "up", cx))))
        .child(act(`held-drop-${i}`, "✕", "Drop it", (cx) => this.heldAction(i, "drop", cx)))));
  }

  box(t, status) {
    const ring = this.focused ? c.mix(t.c.surface, t.c.accent, 0.55) : t.c.input ?? t.c.border;
    const items = this.pop === "slash" || this.pop === "at" ? this.menuItems() : [];
    const card = v_flex().id("composer-card").w_full().rounded(t.radius.card).border(1).border_color(ring).bg(t.c.surface)
      .on_drop((e, cx) => this.dropped(e.paths, cx))
      // why: the textarea reports no focus or blur, so presses inside and outside the card stand in for them.
      .on_mouse_down("left", (_e, cx) => { if (!this.focused) { this.focused = true; cx.notify(); } })
      // why: no notify here; a redraw mid-press swallowed the first click on a popover row.
      .on_mouse_down_out(() => { this.focused = false; })
      .when(this.images.length > 0, (el) => el.child(this.thumbs(t)))
      .child(
        div().id("composer-text").relative().px(16).pt(this.images.length ? 8 : 12).pb(4).text_size(t.size.body)
          .line_height(`${Math.round(t.lh.body * t.size.body)}px`).text_color(t.c.foreground)
          .key_context(this.navigable() ? "ComposerNav" : "Composer")
          .on_action("composer_up", (_e, cx) => this.nav("up", cx))
          .on_action("composer_down", (_e, cx) => this.nav("down", cx))
          .on_action("composer_tab", (_e, cx) => this.nav("tab", cx))
          .on_key_down((e, cx) => this.key(e, cx))
          .child(Textarea.new(this.ta).w_full().token((tk) => this.tokenChip(t, tk)))
          // why: TextareaState's placeholder is fixed at creation, and this one follows the chat's state.
          .when(!this.ta.value(), (el) => el.child(div().absolute().top(this.images.length ? 8 : 12).left(16).text_color(t.c.muted)
            .child(status === "blocked" && this.denyOption() ? "Or type why not, and Enter denies with it" : PLACEHOLDER[status] ?? PLACEHOLDER.idle))))
      .child(this.controls(t, status));
    return anchored("composer-menu", card, items.length > 0, this.menu(t, items));
  }

  tokenChip(t, tk) {
    const sel = tk.selected;
    return div().px(6).rounded(4).bg(c.mix(t.c.surface, t.c.accent, sel ? 0.35 : 0.16)).text_color(t.c.accent)
      .text_size(t.size.body).child(tk.token.label ?? tk.token.text.replace(/^\[|\]$/g, ""));
  }

  thumbs(t) {
    return h_flex().px(16).pt(10).gap(8).flex_wrap().children(this.images.map((im) =>
      div().id(`thumb-${im.id}`).relative().size(64).flex_none().rounded(t.radius.block).overflow_hidden().border(1)
        .border_color(t.c.border).bg(t.c.raised)
        .on_hover((h, cx) => { this.hoverThumb = h ? im.id : this.hoverThumb === im.id ? null : this.hoverThumb; cx.notify(); })
        .tooltip(`Image #${im.n}`)
        .child(image(this.appPath(im.thumb ?? im.path)).size_full())
        .when(this.hoverThumb === im.id, (el) => el.child(
          div().id(`thumb-x-${im.id}`).absolute().top(4).right(4).size(20).rounded(10).flex().items_center().justify_center()
            .bg(c.mix(t.c.background, "#000000", 0.4)).cursor_pointer().tooltip("Remove")
            .on_click((_e, cx) => this.removeImage(im.id, cx))
            .child(icon("x", 12, "#ffffff"))))));
  }

  chip(t, id, label, opts = {}) {
    const open = this.pop === id;
    const trigger = h_flex().id(`chip-${id}`).h(28).px(8).gap(4).items_center().rounded(t.radius.chip).cursor_pointer()
      .when(open, (el) => el.bg(t.c.hover)).hover((s) => s.bg(t.c.hover)).tooltip(opts.tip ?? label)
      // why: the textarea's key handler is what closes a popover on Esc, so it keeps the keyboard while one is open.
      .on_click((_e, cx) => { this.pop = open ? null : id; this.ta.focus(); cx.notify(); })
      .when(Boolean(opts.icon), (el) => el.child(icon(opts.icon, 13, opts.color ?? t.c.muted)))
      .child(div().text_size(t.size.small).font_weight(500).text_color(opts.color ?? (opts.unset ? t.c.dim : t.c.muted)).child(label))
      .child(icon("down", 12, t.c.dim));
    return anchored(`pop-${id}`, trigger, open, this.list(t, id, opts.items ?? [], opts.current));
  }

  list(t, id, items, current) {
    return v_flex().id(`list-${id}`).min_w(180).p(4).gap(2).rounded(8).border(1).border_color(t.c.border).bg(t.c.popover ?? t.c.surface).shadow_md()
      .on_mouse_down_out((_e, cx) => { if (this.pop === id) { this.pop = null; cx.notify(); } })
      .children(items.map((it) =>
        h_flex().id(`opt-${id}-${it.value}`).flex_none().h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.c.hover)).when(it.value === current, (el) => el.bg(t.c.selected))
          .on_click((_e, cx) => this.choose(id, it.value, cx))
          .child(div().flex_1().text_size(t.size.ui).text_color(it.color ?? t.c.foreground).child(it.label))
          .when(it.value === current, (el) => el.child(div().text_size(t.size.small).text_color(t.c.muted).child("✓")))));
  }

  menu(t, items) {
    const at = Math.min(this.menuAt, Math.max(0, items.length - 1));
    const what = this.pop === "slash" ? "command" : "file";
    const count = `${items.length === 200 && what === "file" ? "200+" : items.length} ${what}${items.length === 1 ? "" : "s"}`;
    const list = v_flex().id("menu").max_h(320).overflow_y_scroll().track_scroll(this.menuScroll).p(4).gap(2)
      .children(items.map((it, i) =>
        h_flex().id(`menu-${i}`).flex_none().h(30).px(8).gap(10).items_center().rounded(6).cursor_pointer()
          .when(i === at, (el) => el.bg(t.c.selected)).hover((s) => s.bg(t.c.hover))
          .on_click((_e, cx) => this.pick(it, cx))
          .child(div().flex_none().max_w(220).truncate().text_size(t.size.ui).font_weight(500).text_color(t.c.foreground).child(it.label))
          .child(div().flex_1().min_w(0).truncate().text_size(t.size.small).text_color(t.c.muted).child(it.desc))));
    return v_flex().w(420).rounded(8).border(1).border_color(t.c.border).bg(t.c.popover ?? t.c.surface).shadow_md().overflow_hidden()
      .child(list)
      .child(h_flex().h(26).px(12).gap(8).items_center().border_t(1).border_color(t.c.border).text_size(t.size.tiny).text_color(t.c.dim)
        .child(div().flex_1().child(count)).child("↑↓ choose · Enter pick · Tab complete · Esc close"));
  }

  controls(t, status) {
    const v = this.values();
    const red = t.c.ansi1 ?? "#e5484d";
    const modes = c.modeChoices(v.bypass, this.seenAuto || v.mode === "auto").map((m) =>
      ({ value: m, label: c.modeName(m), color: m === "bypassPermissions" ? red : null }));
    const models = c.MODELS.map((m) => ({ value: m, label: c.modelName(m) }));
    const efforts = c.EFFORTS.map((e) => ({ value: e, label: c.effortName(e) }));
    const busy = status === "working";
    const empty = !this.ta.value().trim();
    const bypass = v.mode === "bypassPermissions";
    return h_flex().h(36).px(8).pb(4).gap(2).items_center()
      .child(this.chip(t, "mode", c.modeName(v.mode ?? "default"), {
        items: modes, current: v.mode ?? "default", tip: "Permission mode · Shift+Tab",
        icon: bypass ? "shield-alert" : null, color: bypass ? red : null,
      }))
      .child(this.chip(t, "model", v.model || "Model", { items: models, tip: "Model", unset: !v.model, current: c.MODELS.find((m) => c.modelName(m) === v.model) ?? null }))
      .child(this.chip(t, "effort", c.effortName(v.effort) || "Effort", { items: efforts, tip: "Effort", unset: !v.effort, current: v.effort }))
      .child(div().flex_1())
      .when(Boolean(this.footer.context), (el) => el.child(this.meter(t)))
      .child(busy
        ? div().id("stop").size(28).rounded(t.radius.chip).flex().items_center().justify_center().bg(t.c.foreground).cursor_pointer()
          .tooltip("Stop · Esc").on_click((_e, cx) => this.interrupt(cx)).child(icon("stop", 12, t.c.background))
        : div().id("send").size(28).rounded(t.radius.chip).flex().items_center().justify_center()
          .bg(empty ? t.c.raised : t.c.solid ?? t.c.accent).when(!empty, (el) => el.cursor_pointer())
          .tooltip("Send · Enter").on_click((_e, cx) => cx.spawn(async (cx) => this.submit(cx)))
          .child(icon("arrow-up", 15, empty ? t.c.dim : t.c.solid_foreground ?? "#ffffff")));
  }

  meter(t) {
    const ctxv = this.footer.context;
    const warn = c.meterWarn(ctxv.pct);
    const color = warn ? t.c.ansi3 ?? t.c.blocked : t.c.muted;
    const label = ctxv.total ? `${c.tokens(ctxv.used)} / ${c.tokens(ctxv.total)}` : `${ctxv.pct}%`;
    return h_flex().id("meter").gap(8).items_center().mr(8).tooltip(`Context: ${ctxv.pct}% used`)
      .child(div().w(46).h(4).rounded(2).bg(t.c.raised).child(div().h(4).rounded(2).bg(warn ? color : t.c.dim).w(Math.max(2, Math.round(46 * Math.min(100, ctxv.pct) / 100)))))
      .child(div().min_w(72).text_size(t.size.small).font_weight(500).text_color(color).child(label));
  }

  card(t, ctx) {
    const p = this.prompt;
    const yellow = t.c.ansi3 ?? t.c.blocked;
    const button = (id, key, label, primary, onClick, danger) =>
      h_flex().id(id).h(28).px(12).gap(8).items_center().rounded(t.radius.chip).cursor_pointer()
        .bg(primary ? t.c.solid ?? t.c.accent : danger ? c.mix(t.c.surface, t.c.ansi1 ?? t.c.blocked, 0.16) : t.c.raised)
        .hover((s) => s.opacity(0.9)).tooltip(key === "esc" ? "Esc" : `Press ${key}`)
        .on_click((_e, cx) => onClick(cx))
        .when(Boolean(key), (el) => el.child(div().text_size(t.size.small).font_weight(500)
          .text_color(primary ? t.c.solid_foreground ?? "#fff" : t.c.dim).child(key === "esc" ? "Esc" : key)))
        .child(div().text_size(t.size.ui).font_weight(500)
          .text_color(primary ? t.c.solid_foreground ?? "#fff" : danger ? t.c.ansi1 ?? t.c.blocked : t.c.foreground).child(label));
    const terminal = h_flex().id("card-terminal").h(28).px(10).gap(6).items_center().rounded(t.radius.chip).cursor_pointer()
      .hover((s) => s.bg(t.c.hover)).tooltip("Open terminal · Alt+T")
      .on_click((_e, cx) => { this.chat.toggleTerminal(cx); cx.notify(); })
      .child(icon("terminal", 13, t.c.muted)).child(div().text_size(t.size.small).font_weight(500).text_color(t.c.muted).child("Open terminal"));
    const title = p.unknown ? "Claude is waiting in the terminal" : p.kind === "plan" ? "Plan ready" : p.title || "Claude needs you";
    const red = t.c.ansi1 ?? t.c.blocked;
    const isNo = (o) => p.kind === "approval" && /^no\b/i.test(o.label);
    const options = p.unknown ? [] : p.options;
    const longOptions = p.kind === "question" || options.some((o) => o.label.length > 28);
    const body = p.body ? p.body.split("\n").slice(0, 10).join("\n") : "";
    // why: the screen hard-wraps the plan and shows only its start; the ExitPlanMode call carries the whole markdown.
    const planItem = p.kind === "plan" ? (this.chat.items ?? []).findLast((it) => it.kind === "tool" && it.name === "ExitPlanMode" && it.input?.plan) : null;
    return v_flex().id("approval").track_focus(this.cardFocus).w_full().rounded(10).border(1)
      .border_color(c.mix(t.c.surface, yellow, 0.45)).bg(t.c.surface).px(16).py(12).gap(8)
      .on_key_down((e, cx) => {
        const k = e.keystroke;
        const o = options.find((x) => x.key === k);
        if (o) { this.answer(o.key, cx); cx.stop_propagation(); } else if (k === "escape" && !p.unknown) { this.answer("esc", cx); cx.stop_propagation(); }
      })
      .child(h_flex().gap(8).items_center()
        .child(icon("shield-alert", 14, yellow))
        .child(div().flex_1().min_w(0).truncate().text_size(t.size.ui).font_weight(600).text_color(t.c.foreground).child(title))
        .when(!p.unknown && p.esc, (el) => el.child(div().text_size(t.size.small).text_color(t.c.dim).child("Esc deny")))
        .child(terminal))
      // A plan is prose; a command or a file is mono.
      .when(Boolean(planItem), (el) => el.child(div().id("plan-body").max_h(320).overflow_y_scroll().px(12).py(8).rounded(t.radius.chip).bg(t.c.raised)
        .child(markdown(planItem.input.plan, ctx, `${planItem.id}:plan`))))
      .when(Boolean(body) && !planItem, (el) => el.child(div().px(10).py(8).rounded(t.radius.chip).bg(t.c.raised)
        .font_family(p.kind === "plan" ? t.font.ui : t.font.mono).text_size(p.kind === "plan" ? t.size.ui : 12)
        .line_height(p.kind === "plan" ? "19px" : "18px").text_color(t.c.foreground).child(body)))
      .when(Boolean(p.question), (el) => el.child(div().text_size(t.size.ui).text_color(t.c.foreground).child(p.question)))
      .when(longOptions, (el) => el.child(v_flex().gap(4).children(options.map((o, i) =>
        h_flex().id(`opt-${o.key}`).gap(10).px(10).py(6).rounded(t.radius.chip).cursor_pointer().when(i === 0, (el) => el.bg(t.c.raised))
          .hover((s) => s.bg(t.c.hover)).tooltip(`Press ${o.key}`)
          .on_click((_e, cx) => this.answer(o.key, cx))
          .child(div().size(18).flex_none().rounded(4).bg(t.c.raised).border(1).border_color(t.c.border).flex().items_center().justify_center()
            .text_size(t.size.tiny).font_weight(600).text_color(isNo(o) ? red : t.c.muted).child(o.key))
          .child(v_flex().flex_1().gap(2)
            .child(div().text_size(t.size.ui).font_weight(500).text_color(isNo(o) ? red : t.c.foreground).child(o.label))
            .when(Boolean(o.detail) && o.detail !== o.label, (el) => el.child(div().text_size(t.size.small).text_color(t.c.muted).child(o.detail))))))))
      .when(!longOptions && options.length > 0, (el) => el.child(h_flex().gap(8).flex_wrap()
        .children(options.map((o, i) => button(`ans-${o.key}`, o.key, o.label, i === 0, (cx) => this.answer(o.key, cx), isNo(o))))))
      .when(!p.unknown && p.esc && !this.denyOption(), (el) => el.child(h_flex().child(button("ans-esc", "esc", "Cancel", false, (cx) => this.answer("esc", cx)))))
      .when(options.length > 1, (el) => el.child(div().text_size(t.size.tiny).text_color(t.c.dim)
        .child(`1–${options.length} choose${p.esc ? " · Esc deny" : ""}${this.denyOption() ? " · a reason typed below denies with it" : ""}`)));
  }
}

/** Draws the composer a view built in init, or a quiet strip before it exists. */
export function composer(chat, ctx) {
  return chat.composer ? chat.composer.render(ctx) : div().h(56);
}
