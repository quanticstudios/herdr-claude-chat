// The composer's pure logic (screen readers, modes, names, image tokens, menus), checked by compose.check.mjs.

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const MODELS = ["default", "opus", "opus[1m]", "sonnet", "haiku", "fable"];

const FAMILIES = { default: "Default", fable: "Fable 5.2", opus: "Opus 5.5", sonnet: "Sonnet 5.5", haiku: "Haiku 5.5" };

/** A model id or alias as people read it: "claude-sonnet-5-5" is "Sonnet 5.5", "opus[1m]" is "Opus 5.5 1M". */
export function modelName(id) {
  if (!id) return "";
  let s = String(id).trim();
  let wide = "";
  if (/\[1m\]$/i.test(s)) { s = s.slice(0, -4); wide = " 1M"; }
  const alias = FAMILIES[s.toLowerCase()];
  if (alias) return alias + wide;
  if (/^(Opus|Sonnet|Haiku|Fable) \d/.test(s)) return s + wide;
  const m = /^(?:claude-)?([a-z]+)-(\d+)(?:[.-](\d+))?(?:-.*)?$/i.exec(s);
  if (!m) return s + wide;
  // why: an 8-digit tail is a date stamp, not a minor version.
  const minor = m[3] && m[3].length !== 8 ? "." + m[3] : "";
  return m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() + " " + m[2] + minor + wide;
}

/** The effort chip's label: "High", "Extra high"; "" while unknown. */
export function effortName(e) {
  if (!e || e === "default") return "";
  return e === "xhigh" ? "Extra high" : e[0].toUpperCase() + e.slice(1);
}

export const MODES = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];
const MODE_NAMES = { default: "Default", acceptEdits: "Accept edits", plan: "Plan", auto: "Auto", bypassPermissions: "Bypass permissions" };
export const modeName = (m) => MODE_NAMES[m] ?? m ?? "";

/** The modes the mode popover offers: bypass only when the session may enter it, auto once the TUI showed it. */
export function modeChoices(bypass, auto) {
  return MODES.filter((m) => (m !== "bypassPermissions" || bypass) && (m !== "auto" || auto));
}

/** Whether a claude argv lets the session enter bypass permissions. */
export const mayBypass = (argv) =>
  (argv ?? []).some((a) => /^--(dangerously-skip-permissions|allow-dangerously-skip-permissions)$/.test(a) || a === "bypassPermissions");

/** The value of `--flag v` or `--flag=v` in argv, or null. */
export function flag(argv, name) {
  for (let i = 0; i < (argv ?? []).length; i++) {
    const a = String(argv[i]);
    if (a === name) return argv[i + 1] ?? null;
    if (a.startsWith(name + "=")) return a.slice(name.length + 1);
  }
  return null;
}

const RULE = /^\s*[─━]{8,}\s*$/;
// why: once a session has a name, Claude writes it into the input box's top rule.
const BOX_RULE = /^\s*[─━]{8,}(?: \S.* [─━]+)?\s*$/;

/** A count with a k or M suffix: "80k" is 80000. */
function count(s) {
  const m = /^([\d.]+)\s*([kKmM]?)$/.exec(s);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] ? (/[kK]/.test(m[2]) ? 1e3 : 1e6) : 1));
}

/** What Claude Code's footer says: model, effort, permission mode and context used; unknown values are null. */
export function readFooter(text) {
  const lines = String(text ?? "").split("\n").map((l) => l.replace(/\s+$/, ""));
  const out = { model: null, effort: null, mode: null, context: null, box: false, ack: null };
  // The input box is the last pair of rules; the status lines sit under it.
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (BOX_RULE.test(lines[i])) { last = i; break; }
  if (last < 0) return out;
  let first = -1;
  for (let i = last - 1; i >= Math.max(0, last - 40); i--) if (BOX_RULE.test(lines[i])) { first = i; break; }
  out.box = first >= 0 && lines.slice(first + 1, last).some((l) => /^\s*[❯>]/.test(l));
  for (const raw of lines.slice(last + 1)) {
    const l = raw.trim();
    const low = l.toLowerCase();
    if (/accept edits on/.test(low)) out.mode = "acceptEdits";
    else if (/plan mode on/.test(low)) out.mode = "plan";
    else if (/bypass permissions on/.test(low)) out.mode = "bypassPermissions";
    else if (/auto mode on/.test(low)) out.mode = "auto";
    else if (/manual mode on|default mode on/.test(low)) out.mode = "default";
    const fam = /^(Opus|Sonnet|Haiku|Fable) \d+(?:\.\d+)?(?: 1M)?/.exec(l);
    if (fam && !out.model) {
      out.model = fam[0];
      const parts = l.split(" · ").map((p) => p.trim());
      if (EFFORTS.includes(parts[1])) out.effort = parts[1];
    }
    const ctx = /(\d{1,3})%\s+([\d.]+[kKmM]?)\s*\/\s*([\d.]+[kKmM]?)/.exec(l);
    if (ctx && !out.context) out.context = { pct: Number(ctx[1]), used: count(ctx[2]), total: count(ctx[3]) };
    const left = /context left until auto-compact:\s*(\d{1,3})%/i.exec(l);
    if (left && !out.context) out.context = { pct: 100 - Number(left[1]), used: null, total: null };
  }
  if (out.box && !out.mode) out.mode = "default";
  // A status line that names no effort leaves the last acknowledgement ("⎿  Set effort level to medium") to say it.
  for (const l of lines) {
    const e = /⎿\s+Set effort level to (low|medium|high|xhigh|max)\b/.exec(l);
    if (e && !out.effort) out.ack = { ...out.ack, effort: e[1] };
    const m = /⎿\s+Set model to ((?:Opus|Sonnet|Haiku|Fable) \d+(?:\.\d+)?(?: 1M)?)/.exec(l);
    if (m && !out.model) out.ack = { ...out.ack, model: m[1] };
  }
  if (out.ack) { out.effort ??= out.ack.effort ?? null; out.model ??= out.ack.model ?? null; }
  // why: the effort indicator above the box ("◐ medium · /effort") outlives a status line that stops naming it.
  const top = first < 0 ? last : first;
  for (const l of lines.slice(Math.max(0, top - 3), top)) {
    const e = /(low|medium|high|xhigh|max)\s*·\s*\/effort/.exec(l);
    if (e) out.effort = e[1];
  }
  return out;
}

/** The mode Shift+Tab reaches from m, in the TUI's cycle order. */
export function nextMode(m, choices) {
  const i = choices.indexOf(m);
  return choices[(i + 1) % choices.length];
}

/** 950, 62K, 1M, 1.5M. */
export function tokens(n) {
  if (n == null) return "";
  if (n < 1000) return String(n);
  if (n < 999500) return Math.round(n / 1000) + "K";
  return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
}

/** The meter turns yellow at 75%. */
export const meterWarn = (pct) => pct >= 75;

// ---- the blocked prompt: an approval, a question or a plan, read off the screen ----

const OPTION = /^\s*(?:[❯›>]\s*)?(\d+)\.\s+(.+?)\s*$/;
// What sits under a prompt: the TUI's key hints, a plan's file, a session-name rule, and the note `hc read` adds.
const FOOT = /esc to cancel|enter to confirm|tab to amend|ctrl\+g to edit|enter to select|↑\/↓|arrow keys|^\[hc\] |^\s*~?\/\S+\.md\s*$|^\s*[─━]{3,}/i;
const DASH = /^\s*[╌┄─━]{3,}\s*$/;

/** The numbered prompt at the bottom of a blocked screen (title, body, question, options), or null. */
export function readPrompt(text) {
  const lines = String(text ?? "").split("\n").map((l) => l.replace(/\s+$/, ""));
  let i = lines.length - 1;
  let esc = false;
  while (i >= 0 && (!lines[i].trim() || FOOT.test(lines[i]))) { if (/esc/i.test(lines[i])) esc = true; i--; }
  const options = [];
  let pending = "";
  for (; i >= 0; i--) {
    const l = lines[i];
    const m = OPTION.exec(l);
    if (m) {
      options.unshift({ key: m[1], label: m[2].trim(), detail: pending, marked: /^\s*[❯›>]/.test(l) });
      pending = "";
      continue;
    }
    // An indented line under an option is its description; a blank line or a rule may separate options.
    if (!l.trim() || (options.length && RULE.test(l))) continue;
    if (/^\s{4,}\S/.test(l)) { pending = (l.trim() + " " + pending).trim(); continue; }
    break;
  }
  if (options.length < 2 || !options.some((o) => o.marked)) return null;
  // invariant: option numbers run 1..n; anything else is text that happened to look numbered.
  if (options.some((o, k) => Number(o.key) !== k + 1)) return null;
  const question = (lines[i] ?? "").trim();
  // The card's title is the first line after the rule that opens the prompt.
  let top = i - 1;
  while (top >= 0 && !RULE.test(lines[top]) && i - top < 40) top--;
  // why: a plan prompt rules off its question from the plan above it, so an empty section means look one rule higher.
  if (top > 0 && !lines.slice(top + 1, i).some((l) => l.trim())) {
    top--;
    while (top >= 0 && !RULE.test(lines[top]) && i - top < 80) top--;
  }
  // why: the TUI's tips and "requires approval" notes repeat what the card already says.
  const block = lines.slice(top + 1, i).filter((l) => !DASH.test(l) && !/^\s*(Tip:|This command requires approval)/.test(l));
  while (block.length && !block[0].trim()) block.shift();
  // AskUserQuestion heads its title with a checkbox glyph.
  const title = (block.shift() ?? "").trim().replace(/^[☐☒✔✓]\s*/, "");
  while (block.length && !block[block.length - 1].trim()) block.pop();
  while (block.length && !block[0].trim()) block.shift();
  // why: a multi-line command marks its continuation lines with a bar the card does not need.
  const body = dedent(block.map((l) => l.replace(/^(\s*)│ ?/, "$1")));
  const kind = /plan/i.test(title + " " + question) && /proceed|approve|execute/i.test(question) ? "plan"
    : options.some((o) => /^(yes|no)\b/i.test(o.label)) ? "approval" : "question";
  // why: the card shows keys on its buttons and in tooltips, so the TUI's "(shift+tab)" and "(esc)" hints go.
  const hint = (x) => (/^shift\+tab\b/i.test(x) ? "" : x.replace(/\s*\((?:shift\+tab|esc|tab)\)/gi, "").trim());
  return { title, body, question, options: options.map(({ key, label, detail }) => ({ key, label: hint(label), detail: hint(detail) })), esc, kind };
}

function dedent(lines) {
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length), 99);
  return lines.map((l) => l.slice(ind)).join("\n");
}

/** A prompt's identity, to tell whether the screen still shows the same one before pressing its key. */
export const promptKey = (p) => (p ? [p.title, p.body, p.question, ...p.options.map((o) => o.key + o.label)].join("\u0001") : "");

// ---- the draft: [Image #N] tokens and the images behind them ----

/** The next image number in a draft: one past the highest used, so numbers never repeat within it. */
export const nextImage = (images) => images.reduce((m, im) => Math.max(m, im.n), 0) + 1;

/** The images a draft still references, in token order; tokens are the textarea's InlineTokenSpans. */
export function liveImages(tokens, images) {
  const byId = new Map(images.map((im) => [im.id, im]));
  return [...tokens].sort((a, b) => a.range.start - b.range.start).map((t) => byId.get(t.token.id)).filter(Boolean);
}

/** The draft without one token, its range and the space after it, with later tokens moved back. */
export function dropToken(content, id) {
  const span = content.tokens.find((t) => t.token.id === id);
  if (!span) return content;
  const { start } = span.range;
  let { end } = span.range;
  if (content.text[end] === " ") end++;
  const cut = end - start;
  return {
    text: content.text.slice(0, start) + content.text.slice(end),
    tokens: content.tokens.filter((t) => t !== span)
      .map((t) => (t.range.start >= end ? { ...t, range: { start: t.range.start - cut, end: t.range.end - cut } } : t)),
  };
}

/** The text Claude gets: every image token becomes `@path`, which Claude Code attaches as an image. */
export function promptText(content, images) {
  const byId = new Map(images.map((im) => [im.id, im]));
  let out = "";
  let at = 0;
  for (const t of [...content.tokens].sort((a, b) => a.range.start - b.range.start)) {
    const im = byId.get(t.token.id);
    out += content.text.slice(at, t.range.start) + (im ? `@${im.path}` : content.text.slice(t.range.start, t.range.end));
    at = t.range.end;
  }
  return (out + content.text.slice(at)).trim();
}

// ---- the slash and @ menus ----

/** The slash word being typed: text starts with "/" and the caret is inside its first word. */
export function slashWord(text, caret) {
  if (!text.startsWith("/")) return null;
  const word = text.slice(0, firstSpace(text));
  return caret >= 1 && caret <= word.length ? word.slice(1) : null;
}

/** Where the first whitespace in text is, or its length; the runtime's regex string methods are unreliable. */
export function firstSpace(text) {
  let i = 0;
  while (i < text.length && !/\s/.test(text[i])) i++;
  return i;
}

/** Where the word before `caret` starts, skipping the spaces right before it, as Ctrl+Backspace counts. */
export function wordStart(text, caret) {
  let i = caret;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}

/** The @ word the caret is in: { start, end, query } for "@src/ma|", else null. */
export function atWord(text, caret) {
  let s = caret;
  while (s > 0 && !/\s/.test(text[s - 1])) s--;
  if (text[s] !== "@") return null;
  let e = caret;
  while (e < text.length && !/\s/.test(text[e])) e++;
  return { start: s, end: e, query: text.slice(s + 1, caret) };
}

/** Fuzzy score of query in s (letters in order), higher is better; -1 when it doesn't match. */
export function fuzzy(query, s) {
  const q = query.toLowerCase();
  const t = s.toLowerCase();
  if (!q) return 0;
  if (t.startsWith(q)) return 1000 - t.length;
  const at = t.indexOf(q);
  if (at >= 0) return 800 - at - t.length / 100;
  let j = 0, score = 0, prev = -2;
  for (let i = 0; i < t.length && j < q.length; i++) {
    if (t[i] !== q[j]) continue;
    score += i === prev + 1 ? 5 : /[/_\-. :]/.test(t[i - 1] ?? "/") ? 4 : 1;
    prev = i;
    j++;
  }
  return j === q.length ? score : -1;
}

/** The items matching query, best first, at most n; key picks the text, or texts, to match. */
export function filterBy(items, query, key, n = 50) {
  return items.map((it) => [Math.max(...[].concat(key(it)).map((k) => fuzzy(query, k))), it]).filter(([s]) => s >= 0)
    .sort((a, b) => b[0] - a[0]).slice(0, n).map(([, it]) => it);
}

/** Claude Code's built-in commands with what they do, for the slash menu. */
export const BUILTINS = [
  ["add-dir", "Add a working directory"], ["agents", "Manage agent configurations"], ["clear", "Clear the conversation"],
  ["compact", "Compact the conversation, keeping a summary"], ["config", "Open settings"], ["context", "Show context usage"],
  ["cost", "Show the session's cost and duration"], ["doctor", "Check the installation"], ["effort", "Set the effort level"],
  ["exit", "Exit Claude Code"], ["export", "Export the conversation"], ["help", "Show help"], ["hooks", "Manage hooks"],
  ["init", "Write a CLAUDE.md for this codebase"], ["mcp", "Manage MCP servers"], ["memory", "Edit memory files"],
  ["model", "Set the model"], ["permissions", "Manage tool permissions"], ["plugin", "Manage plugins"],
  ["resume", "Resume a conversation"], ["review", "Review a pull request"], ["rewind", "Rewind the conversation"],
  ["status", "Show version, model and account"], ["todos", "List the current todos"], ["usage", "Show plan usage limits"],
].map(([name, desc]) => ({ name, desc, source: "built-in" }));

/** Commands from the listing script's `name<TAB>description<TAB>source<TAB>aliases` lines, deduplicated; the fixed built-ins fill in when it read none. */
export function parseCommands(out) {
  const seen = new Set();
  const list = [];
  for (const line of String(out ?? "").split("\n")) {
    const [name, desc = "", source = "", aliases = ""] = line.split("\t");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    list.push({ name, desc: desc.replace(/^["']|["']$/g, "").trim(), source, aliases: aliases.split(" ").filter(Boolean) });
  }
  if (list.some((x) => x.source === "built-in")) return list;
  return [...BUILTINS, ...list.filter((x) => !BUILTINS.some((b) => b.name === x.name))];
}

const rgb = (s) => [1, 3, 5].map((i) => parseInt(String(s ?? "#000000").slice(i, i + 2), 16) || 0);

/** `fg` at opacity `a` over `bg`, as one opaque color (alpha in either input is ignored). */
export function mix(bg, fg, a) {
  const b = rgb(bg), f = rgb(fg);
  return "#" + b.map((v, i) => Math.round(v + (f[i] - v) * a).toString(16).padStart(2, "0")).join("");
}

const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
/** Queued messages the transcript does not show yet: a user item with the same text, written after it was queued, delivers one. */
export function stillQueued(queued, items) {
  const users = (items ?? []).filter((it) => it.kind === "user");
  return queued.filter((q) => !users.some((it) => it.at >= q.at - 2000 && squash(it.text) === squash(q.text)));
}
