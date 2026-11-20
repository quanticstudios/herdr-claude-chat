// Finds a Claude terminal's transcript and reads it newest first in bounded pages, then live.
import { exec, hc, appHome, watchFolder } from "herdr";

const POLL_MS = 2000;
const REBIND_POLLS = 5;

/** Path of `bin/transcript.py` in this mod's folder. */
export const helperPath = () => `${appHome()}/mods/claude-chat/bin/transcript.py`;

async function py(args, timeout = 30000) {
  // why: `image()` draws only files inside the app folder, so images are written there.
  const r = await exec("python3", ["-I", helperPath(), "--cache", `${appHome()}/.cache/claude-chat`, ...args], { timeout });
  if (r.code !== 0) throw new Error(`transcript ${args[0]} failed: ${(r.stderr || "").trim().slice(-400) || "exit " + r.code}`);
  return JSON.parse(r.stdout);
}

/**
 * Where a herdr terminal's Claude writes its transcript, or null.
 * @param term a `terminals()` / `hc ls --json` row, or an address such as `t5k`.
 * @returns `verified` is true only when Claude itself named the file (the SessionStart hook or its pid record); `how` is hook, pid, resume or guess.
 */
export async function findBinding(term) {
  const address = typeof term === "string" ? term : term?.address;
  if (!address) return null;
  const r = await hc(["get", address, "--json"]);
  const g = r.code === 0 ? JSON.parse(r.stdout) : {};
  const found = await py(["find", JSON.stringify({
    address,
    pid: g.pid ?? null,
    fgpid: g.foreground?.pid ?? null,
    cwd: g.cwd ?? (typeof term === "object" ? term.cwd : null),
    argv: g.foreground?.argv ?? g.argv ?? [],
    created_ms: g.created_ms ?? 0,
  })]);
  return found.path ? found : null;
}

/** The transcript path for a herdr terminal row whose agent is claude-code, or null. */
export async function findTranscript(term) {
  return (await findBinding(term))?.path ?? null;
}

const RULE = /^─{8,}$/;
const BULLET = /^[●⏺] /;
const PROMPT = /^[❯>] /;
const FOLDED = /^[A-Z][a-z]+(?: for)? \d+ [a-z]+(?: [a-z]+)?(?:, [a-z]+(?: for)? \d+ [a-z]+(?: [a-z]+)?)*…?(?: \(.*\))?$/;

/**
 * The reply Claude is writing, read from its TUI screen text, or null when the screen's last block is not prose.
 * @param cols the terminal width, to join lines the TUI wrapped; 0 keeps lines as drawn.
 * @returns `partial` is true when the reply's start scrolled out of what was read.
 */
export function parseScreen(screen, cols = 0) {
  const lines = screen.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  let cut = lines.length;
  for (let i = lines.length - 1; i > 0; i--) {
    if (/^[❯>]/.test(lines[i]) && RULE.test(lines[i - 1])) { cut = i - 1; break; }
  }
  let top = -1;
  for (let i = cut - 1; i >= 0; i--) if (PROMPT.test(lines[i])) { top = i; break; }
  const blocks = [];
  // why: with the prompt scrolled away, the first lines continue a block whose bullet is out of view.
  let cur = top < 0 ? { lines: [], tool: false, partial: true } : null;
  if (cur) blocks.push(cur);
  for (let i = top + 1; i < cut; i++) {
    const l = lines[i];
    if (BULLET.test(l)) {
      cur = { lines: [l.slice(2)], tool: false };
      blocks.push(cur);
    } else if (cur && /^\s+⎿/.test(l)) {
      // why: a running tool's bullet blinks off, so its header can read as the previous block's last line.
      if (cur.lines.length > 1 || cur.partial) {
        cur = { lines: [cur.lines.pop()], tool: true };
        blocks.push(cur);
      }
      cur.tool = true;
    } else if (cur && (l === "" || l.startsWith("  "))) {
      cur.lines.push(l.slice(2));
    } else {
      cur = null;
    }
  }
  for (const b of blocks) while (b.lines.length && b.lines[b.lines.length - 1] === "") b.lines.pop();
  // why: a one-line block with a wide gap is a status row drawn above the input, not prose.
  const prose = blocks.filter((b) => b.lines.length && !(b.lines.length === 1 && /\S\s{6,}\S/.test(b.lines[0])));
  const last = prose[prose.length - 1];
  if (!last || last.tool) return null;
  // why: the TUI folds tool calls into a trailing "Read 1 file, ran 1 shell command" line and marks prose " · summary".
  const kept = [...last.lines];
  const drop = (l) => l.trim() === "" || l.trim() === "· summary" || FOLDED.test(l.trim());
  while (kept.length && drop(kept[kept.length - 1])) kept.pop();
  if (!kept.length) return null;
  kept[kept.length - 1] = kept[kept.length - 1].replace(/\s+· summary$/, "");
  return { text: unwrap(kept, cols - 2), partial: !!last.partial };
}

/** Joins lines the TUI broke at width: a break where the next line's first word would not have fit. */
function unwrap(lines, width) {
  if (width <= 0) return lines.join("\n");
  const out = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const prev = out[out.length - 1], l = lines[i];
    const word = l.split(" ")[0];
    const wrapped = prev !== "" && l !== "" && !/^\s*([-*•]|\d+\.) /.test(l) && prev.length + 1 + word.length > width;
    if (wrapped) out[out.length - 1] = prev + " " + l.trimStart();
    else out.push(l);
  }
  return out.join("\n");
}

const HOLD_MS = 5000;
const norm = (t) => (typeof t === "string" ? t : "").toLowerCase().replace(/[^a-z0-9]/g, "");
let streamN = 0;

/**
 * The provisional reply after one screen read: the same item while text grows, never shorter, held `HOLD_MS` once prose leaves the screen.
 * @param cur the current provisional `reply` item, or null; `s` a `screenText` result, or null.
 * @returns `cur` itself when nothing visible changed, so callers redraw only on a new object.
 */
export function nextStream(cur, s, now) {
  if (s?.text) {
    const k = norm(s.text);
    if (cur) {
      const c = norm(cur.text);
      if (c.startsWith(k)) { cur.seen = now; return cur; }
      // shortcut: a reply longer than the 400 lines read starts mid-text and replaces the item, until hc read can page further.
      if (k.startsWith(c.slice(0, 40))) return { ...cur, text: s.text, seen: now };
      // why: Claude keeps only a screenful of the reply it is writing, so its start scrolls away; splice where the screen's first line already is.
      const head = s.text.split("\n").map((l) => l.trim()).find((l) => l.length >= 12);
      // why: the screen's first line keeps growing after the last read, so only its start is sure to be in cur.
      const at = head ? cur.text.lastIndexOf(head.slice(0, 40)) : -1;
      if (at > 0) return { ...cur, text: cur.text.slice(0, at) + s.text.slice(s.text.indexOf(head)), seen: now };
      // why: a slow poll can miss a whole screenful; keep what was read with a gap mark until the transcript's copy replaces it.
      if (s.partial) return { ...cur, text: `${cur.text}\n\n…\n\n${s.text}`, seen: now };
    }
    return { kind: "reply", id: `__stream${++streamN}`, at: now, text: s.text, streaming: true, seen: now };
  }
  return cur && now - cur.seen < HOLD_MS ? cur : null;
}

/** True when the transcript's items already hold the provisional reply's text, after the last prompt. */
export function landed(stream, items) {
  const k = norm(stream.text).slice(0, 32);
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user") return false;
    if (it.kind === "reply" && norm(it.text).includes(k)) return true;
  }
  return false;
}

// why: screenText polls several times a second, and a terminal's width rarely changes.
const widths = new Map();

/** The reply in progress on a Claude terminal's screen (see `parseScreen`), for showing before the transcript has it. */
export async function screenText(term) {
  const address = typeof term === "string" ? term : term?.address;
  if (!address) return null;
  const known = widths.get(address);
  const fresh = known && Date.now() - known.at < 10000;
  const [r, g] = await Promise.all([hc(["read", address, "--lines", "400"]), fresh ? null : hc(["get", address, "--json"])]);
  if (r.code !== 0) return null;
  if (g) widths.set(address, { cols: g.code === 0 ? JSON.parse(g.stdout).cols ?? 0 : 0, at: Date.now() });
  return { ...parseScreen(r.stdout, widths.get(address).cols), working: parseWorking(r.stdout) };
}

const SPIN = /^[·✢✳✶✻✽*✺] (\S.*?…)(?: \((.+?)\))?\s*$/;
/** Claude's spinner line above its input box ("✽ Architecting… (6s · ↓ 344 tokens)"), as `{verb, detail}`, or null. */
export function parseWorking(screen) {
  const lines = screen.replace(/\r/g, "").split("\n").map((l) => l.trim());
  let i = lines.length - 1;
  while (i > 0 && !(/^[❯>]/.test(lines[i]) && RULE.test(lines[i - 1]))) i--;
  for (let j = i - 2, n = 0; j >= 0 && n < 8; j--, n++) {
    const m = SPIN.exec(lines[j]);
    if (m) return { verb: m[1], detail: m[2] ?? "" };
  }
  return null;
}


/** First code points of a Clipped head, safe to pass as one argv word. */
const prefixOf = (head) => Array.from(head.split("\0")[0]).slice(0, 32).join("");

/**
 * A live feed over one transcript, yielding parsed records oldest first, each with `$at`, its byte offset.
 * @remarks Pass `{term}` so `next()` follows the terminal to a new transcript after /clear or /resume.
 */
export class Feed {
  constructor(path, opts = {}) {
    this.path = path;
    this.term = opts.term ?? null;
    this.binding = opts.binding ?? null;
    this.end = 0;
    this.ino = 0;
    this.cursor = 0;
    this.closed = false;
    this.quiet = 0;
  }

  /** Feed for a terminal, or null when no transcript is found yet. */
  static async forTerminal(term) {
    const b = await findBinding(term);
    return b ? new Feed(b.path, { term, binding: b }) : null;
  }

  /** True when Claude itself named this transcript, so sending to the terminal reaches this chat. */
  get verified() {
    return !!this.binding?.verified;
  }

  /** The newest turns, back to the last compaction or a byte budget. */
  async tail() {
    const p = await py(["tail", this.path]);
    this.end = p.end;
    this.ino = p.ino;
    this.cursor = p.cursor;
    return { lines: p.lines, hasOlder: p.hasOlder };
  }

  /** The page before what was read so far. */
  async older() {
    if (this.cursor <= 0) return { lines: [], hasOlder: false };
    const p = await py(["older", this.path, String(this.cursor)]);
    this.cursor = p.cursor;
    return { lines: p.lines, hasOlder: p.hasOlder };
  }

  /**
   * Resolves with lines written since the last read, once there are any.
   * @param cx the async context, for the poll fallback when the folder watch misses a write.
   * @returns `reset: true` means the transcript was replaced (truncated, rewritten, a new session) and `lines` is a fresh tail.
   */
  async next(cx) {
    while (!this.closed) {
      const dir = this.path.slice(0, this.path.lastIndexOf("/"));
      const w = watchFolder(dir);
      try {
        const got = await this.poll();
        if (got) return got;
        // why: a new session's project folder may not exist yet, and then the watch rejects.
        const watched = w.then((p) => p, () => (cx ? new Promise(() => {}) : null));
        const paths = await (cx ? Promise.race([watched, cx.sleep(POLL_MS).then(() => null)]) : watched);
        const other = (paths ?? []).some((p) => p.endsWith(".jsonl") && p !== this.path && p.lastIndexOf("/") === dir.length);
        if (this.term && (other || ++this.quiet >= REBIND_POLLS)) {
          this.quiet = 0;
          const moved = await this.rebind();
          if (moved) return moved;
        }
      } finally {
        w.cancel();
      }
    }
    return { lines: [], reset: false, closed: true };
  }

  async poll() {
    for (;;) {
      const r = await py(["since", this.path, String(this.end), String(this.ino)]);
      if (r.reset) {
        if (r.gone && this.term) return await this.rebind();
        if (r.gone) return null;
        return { ...(await this.tail()), reset: true };
      }
      this.end = r.end;
      if (r.lines.length) return { lines: r.lines, reset: false };
      if (!r.more) return null;
    }
  }

  /** Switches to the terminal's current transcript when Claude started a new one. */
  async rebind() {
    const b = await findBinding(this.term).catch(() => null);
    if (!b || b.path === this.path) {
      if (b) this.binding = b;
      return null;
    }
    this.path = b.path;
    this.binding = b;
    return { ...(await this.tail()), reset: true, path: b.path };
  }

  /** The whole text behind a Clipped field, capped at 4 MiB; null when the line changed. */
  async full(clipped) {
    const r = await py(["full", this.path, String(clipped.at), String(clipped.bytes), prefixOf(clipped.head)]);
    return r.text;
  }

  /** Writes the images of the line at byte offset `at` to the cache; ImageRef-shaped results in order. */
  async images(at) {
    return (await py(["images", this.path, String(at)])).images;
  }

  /** Stops `next()`. */
  close() {
    this.closed = true;
  }
}
