// One chat's link to its Claude terminal: send, interrupt, keys, status, approvals and the Alt+T terminal view.
import { exec, hc, run, agents, terminals, panes, focused, layout, window, shared, setShared, nextCommand, checking } from "herdr";
import { parseApproval } from "./approval.js";

/** Height of the terminal view's strip, inside whatever pane header the layout draws above it. */
export const STRIP = 32;
/** The label the attach hook sets on a terminal that has a chat pane. */
export const LABEL = "claude-chat";

export class Chat {
  constructor(terminal) {
    this.terminal = terminal;
    this.approval = null;
    this.handlers = {};
    this.hadAgent = false;
    this.goneSince = 0;
  }

  /** Starts the key-command loop and the status watch; call once from `init`. */
  start(cx, attach) {
    if (checking() || !this.terminal) return;
    if (attach && !this.attach(cx)) {
      // why: the hook's split lands before panes() lists the pane; checking often keeps Claude's TUI on screen as briefly as possible.
      const until = Date.now() + 5000;
      const poll = cx.timer.every(50, (cx) => { if (this.attach(cx) || Date.now() > until) poll.cancel(); });
    }
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "toggle") this.onToggleKey(cx);
        else this.handlers[c]?.(cx);
        cx.notify();
      }
    });
    cx.timer.every(800, (cx) => this.tick(cx));
  }

  /** Runs `fn(cx)` when this mod gets key command `name` (keys.json `claude-chat.<name>`, or "focus"). */
  on(name, fn) { this.handlers[name] = fn; }

  get agent() { return agents().find((a) => a.address === this.terminal) ?? null; }
  get alive() { return terminals().some((t) => t.address === this.terminal); }
  /** working, blocked, done, idle; "ended" once the terminal is gone. */
  get status() { return this.agent?.status ?? (this.alive ? "idle" : "ended"); }
  get busy() { return this.status === "working"; }
  get termPane() { return this.terminal ? panes().find((p) => p.terminal === this.terminal) ?? null : null; }
  /** This chat's own pane: the claude-chat pane in its terminal's tab. */
  get pane() {
    const tp = this.termPane;
    // shortcut: one chat pane per tab; two Claudes split into one tab would share it, upgrade by passing the pane id once Herdr gives mods theirs.
    return tp ? panes().find((p) => p.mod === "claude-chat" && p.tab === tp.tab) ?? null : null;
  }
  get cwd() { return this.termPane?.cwd ?? null; }
  get branch() { return this.termPane?.branch ?? null; }
  /** Claude's session title (its terminal title), else the tab's name. */
  get title() {
    const t = (this.agent?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
    if (t && !/^claude( code)?$/i.test(t)) return t;
    const a = this.agent;
    return a && !/^\d+$/.test(a.tab_name) ? a.tab_name : "Claude";
  }
  /** The terminal view shows when this chat's pane is not the zoomed one. */
  get terminalView() { const p = this.pane; return !!p && !p.zoomed; }

  /** Types text into Claude's prompt and presses Enter; resolves with an error message or null. */
  async send(text) {
    if (!this.terminal || !text.trim()) return null;
    // why: hc send waits for good while text typed in the TUI sits unsent; a killed wait never fires later.
    const r = await exec("hc", ["send", "--json", this.terminal, text], { timeout: 5000 }).catch(() => null);
    if (!r) return "Claude's terminal has unsent text. Press Alt+T to send or clear it there.";
    return r.code === 0 ? null : (r.stderr || r.stdout).trim() || "send failed";
  }
  /** Stops the running turn. */
  async interrupt() { if (this.terminal) await hc(["keys", this.terminal, "esc"]); }
  /** Presses named keys in the TUI (`hc keys` names: enter, esc, shift+tab, 1, ...). */
  async keys(...names) { if (this.terminal && names.length) await hc(["keys", this.terminal, ...names]); }
  /** Picks one of `approval.options`. */
  async answer(option) {
    this.approval = null;
    await this.keys(...option.keys);
  }

  /** Flips between the chat and the live TUI; the Claude process is never touched. */
  toggle(cx) {
    const p = this.pane, tp = this.termPane;
    if (!p || !tp) return;
    this.want = { chat: !p.zoomed, from: Date.now() + 400, until: Date.now() + 2000 };
    if (p.zoomed) {
      run("pane.zoom", { pane: p.pane });
      this.barPx = STRIP + paneHeader();
      run("layout.resize", { id: p.pane, px: this.barPx });
      run("pane.focus", { pane: tp.pane });
    } else {
      run("pane.zoom", { pane: p.pane });
      run("pane.focus", { pane: p.pane });
      // why: pane.focus lands after this returns and would take the keyboard from the composer again.
      if (cx) cx.timer.after(120, () => this.handlers.focus?.());
      else this.handlers.focus?.();
    }
  }

  /** The scaffold's name for `toggle`. */
  toggleTerminal(cx) { this.toggle(cx); }

  onToggleKey(cx) {
    const f = focused(), p = this.pane;
    if (!f || !p || f.tab !== p.tab) return;
    // why: alt-t is bound globally, so a shell split beside the chat still gets its own Alt+T.
    if (f.terminal && f.terminal !== this.terminal) { hc(["keys", f.terminal, "alt+t"]); return; }
    this.toggle(cx);
  }

  /** Moves the chat above its terminal and zooms it, once per terminal; false until its pane shows up in `panes()`. */
  attach(cx) {
    const key = `claude-chat.attached.${this.terminal}`;
    if (shared(key)) return true;
    const p = this.pane, tp = this.termPane;
    if (!p || !tp) return false;
    setShared(key, true);
    run("pane.swap", { pane: p.pane, target: tp.pane });
    // why: the zoom hides the terminal but keeps its split size, and Claude's screen is all the streaming reads; a resize sent with the swap is lost.
    cx.timer.after(150, () => {
      this.barPx = STRIP + paneHeader();
      run("layout.resize", { id: p.pane, px: this.barPx });
      run("pane.zoom", { pane: p.pane });
      run("pane.focus", { pane: p.pane });
      this.handlers.focus?.();
    });
    return true;
  }

  tick(cx) {
    // why: a pane.zoom was seen to drop twice in the live test, leaving the view half flipped; one retry heals it.
    const w = this.want, wp = this.pane;
    if (w && wp && Date.now() > w.from && Date.now() < w.until && wp.zoomed !== w.chat) {
      this.want = null;
      run("pane.zoom", { pane: wp.pane });
      if (w.chat) run("pane.focus", { pane: wp.pane });
    } else if (w && Date.now() >= w.until) this.want = null;
    // why: a layout switch in the terminal view keeps the old height, which clips or pads the bar under another pane header.
    if (wp && !wp.zoomed && this.barPx !== STRIP + paneHeader()) {
      this.barPx = STRIP + paneHeader();
      run("layout.resize", { id: wp.pane, px: this.barPx });
    }
    // why: agent.focus (the agents list) zooms the terminal itself, which hides the chat and with it the only taker of Alt+T.
    const tp = this.termPane;
    if (tp?.zoomed && wp && focused()?.tab === tp.tab) {
      run("pane.zoom", { pane: wp.pane });
      run("pane.focus", { pane: wp.pane });
      this.handlers.focus?.();
    }
    const s = this.status;
    if (this.agent) { this.hadAgent = true; this.goneSince = 0; }
    if (s === "blocked") {
      cx.spawn(async (cx) => {
        const r = await hc(["read", this.terminal, "--lines", "40"]);
        const a = r.code === 0 ? parseApproval(r.stdout) : null;
        if (JSON.stringify(a) !== JSON.stringify(this.approval)) { this.approval = a; cx.notify(); }
      });
    } else if (this.approval) { this.approval = null; cx.notify(); }
    // why: Herdr clears "done" only when the terminal is looked at, and the chat view hides it; herdr.seen=<turn> is that look.
    if (s === "done" && !this.terminalView && this.pane && focused()?.tab === this.pane.tab && window()?.active) {
      const turn = terminals().find((t) => t.address === this.terminal)?.turn;
      if (turn != null) hc(["label", this.terminal, `herdr.seen=${turn}`]);
    }
    // why: Claude quit in its shell (or the terminal closed): the chat steps aside so the shell is usable again.
    if (this.hadAgent && !this.agent) {
      this.goneSince ||= Date.now();
      if (Date.now() - this.goneSince > 3000) this.detach();
    }
  }

  detach() {
    const p = this.pane;
    this.hadAgent = false;
    setShared(`claude-chat.attached.${this.terminal}`, null);
    if (this.alive) hc(["label", this.terminal, `${LABEL}=`]);
    if (p) run("pane.close", { pane: p.pane });
  }
}

/** Height of the header the shown layout draws on every pane (Herdr's main: 30; 0 when it draws none). */
export function paneHeader(root = layout()) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object") continue;
    const h = n.content?.tab ? n.content?.pane?.header : null;
    if (h) return (h.reveal ?? "always") === "always" ? h.height ?? 30 : 0;
    if (n.content?.tab) return 0;
    stack.push(...(n.children ?? []), ...(n.floating ?? []));
  }
  return 0;
}
