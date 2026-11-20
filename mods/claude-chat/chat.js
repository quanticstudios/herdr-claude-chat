// One chat's link to its Claude terminal: send, interrupt, keys, status, approvals and the Alt+T terminal view.
import { exec, hc, run, agents, terminals, panes, focused, layout, window, shared, setShared, nextCommand, checking, appHome } from "herdr";
import { parseApproval } from "./approval.js";

/** Height of the terminal view's strip, inside whatever pane header the layout draws above it. */
const STRIP = 32;
/** The label the attach hook sets on a terminal that has a chat pane. */
export const LABEL = "claude-chat";

/** Shows one pane and hides another in Herdr's layout document (`bin/layoutdoc.py`); resolves true when it took. */
async function layoutDoc(args) {
  const r = await exec("python3", ["-I", `${appHome()}/mods/claude-chat/bin/layoutdoc.py`, ...args], { timeout: 8000 }).catch(() => null);
  return r?.code === 0;
}

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
  get viewKey() { return `claude-chat.view.${this.terminal}`; }
  /** The terminal view shows the terminal under the chat's strip; the chat view hides the terminal. */
  get terminalView() { return shared(this.viewKey) === "terminal"; }

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

  /** Flips between the chat and the live TUI by hiding or showing the terminal; the Claude process is never touched. */
  toggle(cx) {
    const p = this.pane, tp = this.termPane;
    if (!p || !tp) return;
    const toChat = this.terminalView;
    setShared(this.viewKey, toChat ? "chat" : "terminal");
    const go = async (cx) => {
      // why: a hidden mod pane gets no key commands, so the terminal view keeps the chat as a strip that still hears Alt+T.
      if (!(await layoutDoc(toChat ? ["show", p.pane, tp.pane] : ["bar", p.pane, tp.pane, String(STRIP + paneHeader())]))) {
        setShared(this.viewKey, toChat ? "terminal" : "chat");
        return;
      }
      run("pane.focus", { pane: toChat ? p.pane : tp.pane });
      // why: pane.focus lands after this returns and would take the keyboard from the composer again.
      if (toChat) cx.timer.after(120, () => this.handlers.focus?.());
    };
    if (cx) cx.spawn(go);
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

  /** Hides the terminal behind the chat, once per terminal; false until both panes show up in `panes()`. */
  attach(cx) {
    const key = `claude-chat.attached.${this.terminal}`;
    if (shared(key) && shared(this.viewKey)) return true;
    const p = this.pane, tp = this.termPane;
    if (!p || !tp) return false;
    setShared(key, true);
    setShared(this.viewKey, "chat");
    // why: a chat attached by the old zoom keeps its zoom and its bar height; both go before the terminal hides.
    if (p.zoomed) run("pane.zoom", { pane: p.pane });
    // why: a hidden terminal keeps the size it had when hidden, and Claude's screen is all the streaming reads, so it takes the whole slot first.
    run("layout.resize", { id: p.pane, px: 1 });
    cx.timer.after(250, (cx) => cx.spawn(async (cx) => {
      await layoutDoc(["show", p.pane, tp.pane]);
      run("pane.focus", { pane: p.pane });
      this.handlers.focus?.();
      cx.notify();
    }));
    return true;
  }

  tick(cx) {
    const wp = this.pane, tp = this.termPane;
    // why: agent.focus (the agents list) zooms the terminal itself, which would cover the chat and with it the only taker of Alt+T.
    if (tp?.zoomed && wp && !this.terminalView && focused()?.tab === tp.tab) {
      run("pane.zoom", { pane: tp.pane });
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
      if (Date.now() - this.goneSince > 3000) this.detach(cx);
    }
  }

  /** Closes the chat pane and gives the terminal its slot back. */
  detach(cx) {
    const p = this.pane, tp = this.termPane;
    this.hadAgent = false;
    setShared(`claude-chat.attached.${this.terminal}`, null);
    setShared(this.viewKey, null);
    if (this.alive) hc(["label", this.terminal, `${LABEL}=`]);
    if (!p) return;
    if (!tp) { run("pane.close", { pane: p.pane }); return; }
    // why: a pane.close right after a separate unhide raced the app's copy of the layout and brought the chat back, so both go in one write.
    cx.spawn(async () => { if (await layoutDoc(["drop", p.pane, tp.pane])) run("pane.focus", { pane: tp.pane }); });
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
