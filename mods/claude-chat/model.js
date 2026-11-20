// Claude Code transcript lines to Item[] (items.d.ts), pure and checked by model.check.mjs.

export const SYSTEM_TOOLS = ["TodoWrite", "TaskCreate", "TaskUpdate", "Task", "Agent", "Workflow"];

const AGENTS = ["Task", "Agent", "Workflow"];
const SHELL_READ = ["BashOutput", "TaskOutput"];
const SHELL_KILL = ["KillShell", "TaskStop"];
const INTERRUPT = "[Request interrupted by user";

/**
 * Reduces parsed transcript lines, oldest first, to items.
 * @param lines Claude Code JSONL objects; source.js may add `$at` (byte offset) and image `source.path`, and clip any string.
 */
export function reduce(lines) {
  return reduceInto(null, lines);
}

/**
 * Feeds more lines into an array from reduce() and returns it, mutated in place with ids kept.
 * @remarks Null starts fresh. A line whose uuid was already reduced is skipped, so re-reads are harmless.
 */
export function reduceInto(items, lines) {
  const s = items?.[STATE] ?? new Reducer();
  for (const l of lines) s.line(l);
  return s.items;
}

/**
 * Joins an older page in front of newer items, pairing results across the page edge and keeping one todo.
 * @remarks reduceInto() keeps working on the returned array.
 */
export function merge(older, newer) {
  const o = older[STATE], n = newer[STATE];
  if (!o || !n) return [...older, ...newer];
  for (const k of ["tools", "shells", "agents", "side"]) {
    for (const [key, v] of o[k]) if (!n[k].has(key)) n[k].set(key, v);
  }
  for (const u of o.seen) n.seen.add(u);
  const left = n.orphans.filter((retry) => !retry());
  n.orphans = [...o.orphans, ...left];
  const dup = o.todo && n.todo ? n.todo : null;
  if (o.todo || n.todo) {
    n.todoOps = [...o.todoOps, ...n.todoOps];
    const keep = o.todo ?? n.todo;
    if (dup) keep.at = dup.at;
    n.todo = keep;
    n.foldTodo();
  }
  if (o.turnAt && n.headTurn) {
    if (n.headTurn.timed) n.headTurn.item.seconds = secs(o.turnAt, n.headTurn.endAt);
    const tokens = sumUsage(new Map([...o.usage, ...n.headTurn.usage]));
    if (tokens) n.headTurn.item.tokens = tokens;
  } else if (o.turnAt && !n.closedAny && !n.turnByPrompt) {
    [n.turnAt, n.lastAt, n.turnByPrompt] = [o.turnAt, Math.max(n.lastAt, o.lastAt), o.turnByPrompt];
    n.usage = new Map([...o.usage, ...n.usage]);
  }
  const f = n.firstModel;
  const sw = f && o.model && o.model !== f.model && !o.modelCmd ? switchNotice(f.model, f.uuid, f.at) : null;

  n.imageN = Math.max(n.imageN, o.imageN);
  const tail = [];
  newer.forEach((it, i) => {
    if (sw && i === f.index) tail.push(sw);
    if (it !== dup && !n.dropped.has(it)) tail.push(it);
  });
  if (sw && f.index >= newer.length) tail.push(sw);
  n.items = hide([...older, ...tail], n);
  return n.items;
}

const STATE = Symbol("model state");
const hide = (arr, s) => Object.defineProperty(arr, STATE, { value: s, enumerable: false, configurable: true });

/** A Text field as a plain string, joining a Clipped head and tail. */
export function plain(x) {
  if (x == null) return "";
  return typeof x === "string" ? x : `${x.head}\n…\n${x.tail}`;
}

const ms = (ts) => {
  const t = Date.parse(ts ?? "");
  return Number.isNaN(t) ? 0 : t;
};
const secs = (a, b) => (a && b && b >= a ? Math.round((b - a) / 100) / 10 : undefined);
const tag = (s, name) => {
  const m = s.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}(?:\\s[^>]*)?>`));
  return m ? m[1] : null;
};
const sumUsage = (usage) => {
  if (!usage.size) return undefined;
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const u of usage.values()) {
    t.input += u.input_tokens ?? 0;
    t.output += u.output_tokens ?? 0;
    t.cacheRead += u.cache_read_input_tokens ?? 0;
    t.cacheWrite += u.cache_creation_input_tokens ?? 0;
  }
  return t;
};
/** A model id as people say it: `claude-sonnet-5-5` is "Sonnet 5.5". */
const modelName = (id) => {
  const [family, ...v] = id.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/\[.*\]$/, "").split("-");
  return `${family[0].toUpperCase()}${family.slice(1)}${v.length ? ` ${v.join(".")}` : ""}`;
};
const switchNotice = (model, uuid, at) => ({ kind: "notice", id: `switch:${uuid}`, at, tone: "info", what: "switch", text: `Switched to ${modelName(model)}` });
/** An API error notice; usage and rate limits are warnings with their reset time. */
const apiNotice = (id, at, raw) => {
  const reset = raw.match(/\|(\d{10})\s*$/);
  if (reset) {
    const d = new Date(Number(reset[1]) * 1000);
    const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
    return { kind: "notice", id, at, tone: "warn", what: "limit", text: `${raw.slice(0, reset.index).trim()} · resets ${hm}` };
  }
  if (LIMIT.test(raw)) return { kind: "notice", id, at, tone: "warn", what: "limit", text: raw };
  return { kind: "notice", id, at, tone: "error", what: "api", text: raw };
};
const LIMIT = /usage limit|rate limit|hit your (?:\w+ )?limit|limit reached/i;
const asBlocks = (c) => (Array.isArray(c) ? c : c != null ? [{ type: "text", text: c }] : []);
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const HIDDEN = /<(system-reminder|local-command-caveat|user-prompt-submit-hook|hook[\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1(?:\s[^>]*)?>/g;

class Reducer {
  constructor() {
    this.items = hide([], this);
    this.tools = new Map(); // tool_use id -> tool item, { attach, kill } for shell reads, or { todo } for plan calls
    this.shells = new Map(); // background shell id -> its Bash item
    this.agents = new Map(); // agentId -> Task/Agent item
    this.side = new Map(); // sidechain line uuid -> Task/Agent item
    this.seen = new Set();
    this.orphans = []; // retries for results whose call wasn't seen; each returns true once applied
    this.pending = new Map(); // shell read/kill id -> its raw result, while its shell is unknown
    this.dropped = new Set(); // rows merge() folded into an older page's shell
    this.todo = null;
    this.todoOps = [];
    this.turnAt = 0; // start of the open turn, 0 while idle
    this.turnByPrompt = false;
    this.closedAny = false;
    this.headTurn = null; // { item, endAt } of the first turn, when this page joined it midway
    this.lastAt = 0;
    this.lastUuid = "";
    this.lastCommand = null;
    this.imageN = 0;
    this.usage = new Map(); // message id -> usage, for the open turn
    this.model = ""; // the main thread's model so far
    this.modelCmd = false; // a /model command ran since the last reply, so its output already says it
    this.firstModel = null; // { model, uuid, at, index } of this page's first reply, for a switch at merge()
  }

  push(item, into) {
    (into ?? this.items).push(item);
    return item;
  }

  line(l) {
    if (!l || typeof l !== "object") return;
    if (l.uuid) {
      if (this.seen.has(l.uuid)) return;
      this.seen.add(l.uuid);
    }
    const at = ms(l.timestamp);
    if (l.isSidechain || l.parent_tool_use_id) return this.sidechain(l, at);
    if (l.type === "assistant") this.assistant(l, at, null);
    else if (l.type === "user") this.user(l, at);
    else if (l.type === "system") this.system(l, at);
    else if (l.type === "attachment") this.attachment(l, at);
    else return;
    if (this.turnAt && at) this.lastAt = at;
    if (l.uuid) this.lastUuid = l.uuid;
  }

  open(at, byPrompt = false) {
    if (this.turnAt) return;
    this.turnAt = this.lastAt = at || 1;
    this.turnByPrompt = byPrompt;
  }

  /** Closes the open turn, timed by Claude Code's turn_duration or else by timestamps. */
  close(id, at, durationMs) {
    if (!this.turnAt && durationMs == null) return;
    const seconds = durationMs != null ? Math.round(durationMs / 100) / 10 : secs(this.turnAt, this.lastAt);
    const item = this.push({ kind: "turn", id, at: at || this.lastAt, seconds });
    const tokens = sumUsage(this.usage);
    if (tokens) item.tokens = tokens;
    // why: a turn this page joined midway started on the older page; merge() re-times it.
    if (!this.closedAny && !this.turnByPrompt) this.headTurn = { item, endAt: this.lastAt, usage: this.usage, timed: durationMs == null };
    this.usage = new Map();
    this.closedAny = true;
    this.turnAt = 0;
  }

  assistant(l, at, into) {
    const m = l.message ?? {};
    const blocks = asBlocks(m.content);
    if (!into) {
      this.open(at);
      if (m.id && m.usage) this.usage.set(m.id, m.usage);
      if (m.model && m.model !== "<synthetic>") this.switchModel(m.model, l, at);
    }
    if (l.isApiErrorMessage) {
      const text = blocks.map((b) => plain(b.text)).join("\n").trim() || "API error";
      this.push(apiNotice(l.uuid, at, text), into);
      return;
    }
    blocks.forEach((b, i) => {
      const id = i ? `${l.uuid}:${i}` : l.uuid;
      if (b.type === "text") {
        const text = plain(b.text);
        if (text.trim() && text.trim() !== "(no content)") this.push({ kind: "reply", id, at, text }, into);
      } else if (b.type === "thinking" || b.type === "redacted_thinking") {
        const text = b.type === "thinking" && plain(b.thinking).trim() ? plain(b.thinking) : null;
        const seconds = l.thinkingDurationMs != null ? Math.round(l.thinkingDurationMs / 100) / 10 : undefined;
        this.push({ kind: "thinking", id, at, text, seconds }, into);
      } else if (b.type === "tool_use") {
        this.toolUse(b, at, into);
      }
    });
  }

  switchModel(model, l, at) {
    if (!this.model && !this.firstModel) this.firstModel = { model, uuid: l.uuid, at, index: this.items.length };
    else if (model !== this.model && !this.modelCmd) this.push(switchNotice(model, l.uuid, at));
    this.model = model;
    this.modelCmd = false;
  }

  toolUse(b, at, into) {
    const input = b.input ?? {};
    const name = b.name ?? "";
    if (name === "TodoWrite") {
      this.tools.set(b.id, { todo: true });
      return this.todoOp({ op: "write", todos: input.todos ?? [] }, at, into);
    }
    if (name === "TaskCreate") {
      const op = { op: "create", id: null, subject: input.subject, activeForm: input.activeForm };
      this.tools.set(b.id, { todo: op });
      return this.todoOp(op, at, into);
    }
    if (name === "TaskUpdate") {
      this.tools.set(b.id, { todo: true });
      return this.todoOp({ op: "update", ...input }, at, into);
    }
    const kill = SHELL_KILL.includes(name);
    const sid = input.bash_id ?? input.shell_id ?? input.task_id;
    const shellOp = sid != null && (kill || SHELL_READ.includes(name));
    const shell = shellOp ? this.shells.get(sid) : null;
    if (shell) return this.attach(b.id, shell, kill);
    const item = { kind: "tool", id: b.id, at, name, input, status: "running" };
    if (name === "Bash" && input.run_in_background) item.background = { shellId: "", running: true };
    if (AGENTS.includes(name)) item.children = [];
    this.tools.set(b.id, item);
    this.push(item, into);
    if (!shellOp || into) return;
    // why: the shell may be on an older page; merge() runs this to move the row onto it.
    const pend = { result: null };
    this.pending.set(b.id, pend);
    this.orphans.push(() => {
      const s = this.shells.get(sid);
      if (!s) return false;
      const entry = this.attach(b.id, s, kill);
      if (pend.result) this.applyResult(entry, ...pend.result);
      this.dropped.add(item);
      return true;
    });
  }

  attach(id, shell, kill) {
    const entry = { attach: shell, kill };
    this.tools.set(id, entry);
    if (kill) shell.background.running = false;
    return entry;
  }

  todoOp(op, at, into) {
    // why: a subagent's own plan stays out of the transcript's one todo item.
    if (into) return;
    this.todoOps.push(op);
    if (!this.todo) this.todo = this.push({ kind: "todo", id: "todo", at, items: [] });
    this.todo.at = at || this.todo.at;
    this.foldTodo();
  }

  foldTodo() {
    let list = [];
    let next = 1;
    for (const op of this.todoOps) {
      if (op.op === "write") {
        list = op.todos.map((t) => ({ text: plain(t.content), activeText: t.activeForm ? plain(t.activeForm) : undefined, status: t.status ?? "pending" }));
      } else if (op.op === "create") {
        // why: Claude Code numbers tasks 1, 2, 3...; the result's id overrides when it arrives.
        const id = op.id ?? String(next);
        next = Math.max(next + 1, Number(id) + 1 || 0);
        list.push({ key: id, text: plain(op.subject), activeText: op.activeForm ? plain(op.activeForm) : undefined, status: "pending" });
      } else if (op.op === "update") {
        const t = list.find((x) => x.key === String(op.taskId));
        if (!t) continue;
        if (op.status === "deleted") list = list.filter((x) => x !== t);
        else {
          if (op.status) t.status = op.status;
          if (op.subject) t.text = plain(op.subject);
          if (op.activeForm) t.activeText = plain(op.activeForm);
        }
      }
    }
    this.todo.items = list.map(({ key, ...t }) => (t.activeText === undefined ? { text: t.text, status: t.status } : t));
  }

  user(l, at) {
    const c = l.message?.content;
    const blocks = asBlocks(c);
    if (blocks.some((b) => b.type === "tool_result")) {
      for (const b of blocks) if (b.type === "tool_result") this.result(b, l, at);
      return;
    }
    const text = blocks.filter((b) => b.type === "text").map((b) => plain(b.text)).join("\n");
    const t = text.trim();
    if (l.isCompactSummary) {
      const n = this.items.findLast((it) => it.kind === "notice" && it.what === "compact");
      if (n) n.detail = text;
      return;
    }
    if (/<(local-command-stdout|local-command-stderr|command-name|bash-input|bash-stdout)>/.test(t)) return this.command(t, l, at);
    if (l.isMeta) return;
    if (l.origin?.kind === "task-notification" || t.startsWith("<task-notification>")) return this.taskNotice(t, l, at);
    if (t.startsWith(INTERRUPT)) {
      this.push({ kind: "notice", id: l.uuid, at, tone: "muted", what: "interrupt", text: "Interrupted" });
      this.lastAt = at || this.lastAt;
      this.close(`turn:${l.uuid}`, at);
      return;
    }
    this.prompt(text, blocks, l, at, false);
  }

  prompt(text, blocks, l, at, queued) {
    const pasted = [];
    let body = text.replace(/<pasted_content(?:\s[^>]*)?>([\s\S]*?)<\/pasted_content(?:\s[^>]*)?>/g, (_, p) => {
      const s = p.replace(/^\n/, "").replace(/\n$/, "");
      pasted.push({ text: s, lines: s.split("\n").length });
      return "";
    });
    body = body.replace(HIDDEN, "").trim();
    // why: the composer sends a pasted image as an @ mention of its cached file; the bubble shows the image, not the path.
    const mentioned = [];
    body = body.replace(/@(\S*\/\.cache\/claude-chat\/\S+\.(png|jpe?g|gif|webp))/gi, (_, path, ext) => {
      const n = ++this.imageN;
      mentioned.push({ path, media: `image/${ext.toLowerCase() === "jpg" ? "jpeg" : ext.toLowerCase()}`, n });
      return `[Image #${n}]`;
    }).trim();
    const imgs = blocks.filter((b) => b.type === "image");
    if (!body && !pasted.length && !imgs.length && !mentioned.length) return;
    const tokens = [...body.matchAll(/\[Image #(\d+)\]/g)].map((x) => Number(x[1]));
    const images = imgs.map((b, i) => {
      const n = l.imagePasteIds?.[i] ?? tokens[i] ?? this.imageN + 1;
      this.imageN = Math.max(this.imageN, n);
      return this.image(b, l, n);
    }).concat(mentioned);
    if (!queued) {
      this.close(`turn:${this.lastUuid}`, 0);
      this.open(at, true);
    }
    const item = { kind: "user", id: l.uuid, at, text: body, images, pasted };
    if (queued) item.queued = true;
    this.push(item);
  }

  image(b, l, n) {
    const src = b.source ?? {};
    const ref = { path: src.path ?? b.path ?? null, media: src.media_type ?? b.media_type ?? "image/png" };
    if (ref.path == null && l.$at != null) ref.at = l.$at;
    if (n != null) ref.n = n;
    return ref;
  }

  command(t, l, at) {
    const out = tag(t, "local-command-stdout") ?? tag(t, "local-command-stderr") ?? tag(t, "bash-stdout");
    const err = tag(t, "bash-stderr");
    const name = tag(t, "command-name");
    const bash = tag(t, "bash-input");
    if (name != null || bash != null) {
      this.close(`turn:${this.lastUuid}`, 0);
      const c = name != null
        ? { kind: "command", id: l.uuid, at, name: name.trim(), args: (tag(t, "command-args") ?? "").trim() }
        : { kind: "command", id: l.uuid, at, name: "!", args: bash.trim() };
      this.lastCommand = this.push(c);
      if (c.name === "/model") this.modelCmd = true;
      if (out == null && err == null) return;
    }
    const text = [out, err].filter((x) => x?.trim()).join("\n").replace(ANSI, "").replace(/^\n+|\s+$/g, "");
    const c = this.lastCommand;
    if (c && c.output == null) {
      c.output = text;
      return;
    }
    if (text) this.push({ kind: "notice", id: l.uuid, at, tone: "muted", text });
  }

  taskNotice(t, l, at) {
    const summary = (tag(t, "summary") ?? "").trim();
    const status = (tag(t, "status") ?? "").trim();
    const toolId = (tag(t, "tool-use-id") ?? "").trim();
    const stop = () => {
      const tool = this.tools.get(toolId);
      if (tool?.background) tool.background.running = false;
      return !!tool;
    };
    if (!stop() && toolId) this.orphans.push(stop);
    const what = summary.match(/"([^"]+)"/)?.[1] ?? (summary || "task");
    const failed = status === "failed" || status === "killed";
    this.push({ kind: "notice", id: l.uuid, at, tone: failed ? "error" : "muted", what: "task", text: `Background task ${failed ? status : "finished"}: ${what}` });
  }

  result(b, l, at) {
    const apply = () => {
      const t = this.tools.get(b.tool_use_id);
      if (t) this.applyResult(t, b, l, at);
      return !!t;
    };
    if (!apply()) this.orphans.push(apply);
  }

  applyResult(t, b, l, at) {
    const extra = l.toolUseResult;
    if (t.todo) {
      if (typeof t.todo === "object") {
        const id = extra?.task?.id ?? plain(typeof b.content === "string" ? b.content : "").match(/Task #(\w+)/)?.[1];
        if (id != null && this.todo) {
          t.todo.id = String(id);
          this.foldTodo();
        }
      }
      return;
    }
    const pend = this.pending.get(t.id);
    if (pend) pend.result = [b, l, at];
    const res = this.resultBody(b, l);
    if (t.attach) {
      const bg = t.attach.background;
      if (t.kill) bg.running = false;
      else {
        bg.output = res.text;
        const st = extra?.status ?? tag(plain(res.text), "status");
        if (st && st !== "running") bg.running = false;
      }
      return;
    }
    const denied = l.toolDenialKind || /^The user doesn't want to (proceed|take this action)/.test(plain(res.text));
    t.status = denied ? "denied" : res.isError ? "error" : "done";
    t.result = res;
    if (t.at && at) t.seconds = secs(t.at, at);
    if (Array.isArray(extra?.structuredPatch) && extra.structuredPatch.length) t.patch = extra.structuredPatch;
    if (extra?.type === "create") t.created = true;
    if (t.background) {
      const id = extra?.backgroundTaskId ?? plain(res.text).match(/with ID: (\w+)/)?.[1];
      if (id) {
        t.background.shellId = id;
        this.shells.set(id, t);
      } else t.background.running = false;
    }
    if (t.children && extra?.agentId) this.agents.set(extra.agentId, t);
  }

  resultBody(b, l) {
    const c = b.content;
    let text = "";
    const images = [];
    if (Array.isArray(c)) {
      const parts = [];
      for (const p of c) {
        if (p.type === "text") parts.push(p.text);
        else if (p.type === "image") images.push(this.image(p, l));
      }
      text = parts.length === 1 ? parts[0] : parts.map(plain).join("\n");
    } else if (c != null) text = c;
    return { text, images, isError: !!b.is_error };
  }

  system(l, at) {
    const st = l.subtype;
    const content = plain(l.content);
    if (st === "turn_duration") return this.close(l.uuid, at, l.durationMs ?? 0);
    if (st === "compact_boundary") {
      return this.push({ kind: "notice", id: l.uuid, at, tone: "info", what: "compact", text: "Conversation compacted" });
    }
    if (st === "local_command") return this.command(content, l, at);
    if (st === "api_error") {
      const e = l.error?.message ?? l.error?.error?.message ?? (typeof l.error === "string" ? l.error : "");
      const retry = l.retryAttempt ? ` (retry ${l.retryAttempt}${l.maxRetries ? ` of ${l.maxRetries}` : ""})` : "";
      return this.push(apiNotice(l.uuid, at, `API error${e ? `: ${e}` : ""}${retry}`));
    }
    if (st === "informational" && content.trim()) {
      return this.push({ kind: "notice", id: l.uuid, at, tone: l.level === "error" ? "error" : "muted", text: content.replace(ANSI, "").trim() });
    }
  }

  attachment(l, at) {
    const a = l.attachment ?? {};
    const human = !a.origin || a.origin.kind === "human";
    if (a.type === "queued_command" && human && (a.commandMode ?? "prompt") === "prompt") this.prompt(plain(a.prompt), [], l, at, true);
    else if (a.type === "hook_blocking_error" || a.type === "hook_non_blocking_error") {
      const blocked = a.type === "hook_blocking_error";
      const detail = plain(a.blockingError?.blockingError ?? a.blockingError ?? a.stderr ?? a.content).replace(ANSI, "").trim();
      const text = `${a.hookEvent ?? a.hookName ?? "A"} hook ${blocked ? "blocked" : "failed"}`;
      const n = { kind: "notice", id: l.uuid, at, tone: blocked ? "warn" : "muted", what: "hook", text };
      if (detail) n.detail = detail;
      this.push(n);
    }
  }

  sidechain(l, at) {
    const owner = this.owner(l);
    if (!owner) {
      this.orphans.push(() => !!this.owner(l) && (this.sidechain(l, at), true));
      return;
    }
    if (l.uuid) this.side.set(l.uuid, owner);
    if (l.agentId) this.agents.set(l.agentId, owner);
    if (l.type === "assistant") this.assistant(l, at, owner.children);
    else if (l.type === "user" && Array.isArray(l.message?.content)) {
      for (const b of l.message.content) if (b.type === "tool_result") this.result(b, l, at);
    }
  }

  /** The Task/Agent item a sidechain line belongs to, or null. */
  owner(l) {
    const byTool = this.tools.get(l.parent_tool_use_id);
    if (byTool?.children) return byTool;
    if (l.agentId && this.agents.has(l.agentId)) return this.agents.get(l.agentId);
    if (l.parentUuid && this.side.has(l.parentUuid)) return this.side.get(l.parentUuid);
    // why: a subagent's first line is its prompt, the only link to the call when agentId isn't known yet.
    if (l.type === "user" && !l.parentUuid) {
      const c = l.message?.content;
      const text = plain(typeof c === "string" ? c : c?.find?.((b) => b.type === "text")?.text).trim();
      const bound = new Set(this.agents.values());
      for (const t of this.tools.values()) {
        if (t.children && t.status === "running" && !bound.has(t) && plain(t.input?.prompt).trim() === text) return t;
      }
    }
    return null;
  }
}
