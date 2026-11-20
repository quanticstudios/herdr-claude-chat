// What a tool row says, worked out from a tool item without drawing; pure, run by toolview.check.mjs.

const BASH = new Set(["Bash", "bash", "shell"]);
const SHELL_READ = new Set(["BashOutput", "TaskOutput"]);
const SHELL_STOP = new Set(["KillShell", "KillBash", "TaskStop"]);

/** A Text field as a string, without the notes Claude Code adds for the model. */
export function plain(text) {
  if (text == null) return "";
  const s = typeof text === "string" ? text : `${text.head}\n${text.tail}`;
  return clean(s);
}

/** s without system reminders and tool_use_error tags. */
export function clean(s) {
  return s.replace(/\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, "\n")
    .replace(/<\/?tool_use_error>/g, "").trim();
}

/** path relative to cwd when it sits under it. */
export function rel(path, cwd) {
  if (!path || !cwd) return path ?? "";
  const base = cwd.endsWith("/") ? cwd : cwd + "/";
  if (path === cwd) return ".";
  return path.startsWith(base) ? path.slice(base.length) : path;
}

/** path made absolute against cwd, for opening. */
export function abs(path, cwd) {
  if (!path || path.startsWith("/") || path.includes("://") || !cwd) return path;
  return cwd.replace(/\/$/, "") + "/" + path.replace(/^\.\//, "");
}

/** n with its noun, plural when it needs one. */
export function plural(n, noun) {
  const many = noun.endsWith("ch") ? noun + "es" : noun + "s";
  return `${n} ${n === 1 ? noun : many}`;
}

/** Seconds as a row shows them: 0.4s, 12s, 2m 5s. */
export function duration(s) {
  if (s == null || !isFinite(s)) return "";
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

/** The first line of s that says something. */
export function firstLine(s) {
  for (const l of (s ?? "").split("\n")) if (l.trim()) return l.trim();
  return "";
}

/** A tool's first argument as one short line: its first string, else its first number or bool. */
export function firstArg(input) {
  let other = "";
  for (const v of Object.values(input ?? {})) {
    if (typeof v === "string" && v.trim()) return firstLine(v);
    if ((typeof v === "number" || typeof v === "boolean") && !other) other = String(v);
  }
  return other;
}

/** snake_case, kebab-case and camelCase as words. */
export function words(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[_\-. ]+/).filter(Boolean);
}

/** An MCP tool name as people say it, so mcp__plugin_linear_linear__save_issue is Linear · save issue. */
export function mcpName(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name ?? "");
  if (!m) return null;
  let sw = words(m[1]);
  if (sw.length > 2 && sw[0] === "claude" && sw[1] === "ai") sw = sw.slice(2);
  if (sw.length > 1 && sw[0] === "plugin") sw = sw.slice(1);
  sw = sw.filter((w, i) => i === 0 || w.toLowerCase() !== sw[i - 1].toLowerCase());
  let tw = words(m[2]);
  const last = sw[sw.length - 1]?.toLowerCase();
  if (tw.length > 1 && tw[0].toLowerCase() === last) tw = tw.slice(1);
  if (tw.length > 1 && tw[tw.length - 1].toLowerCase() === "mcp") tw = tw.slice(0, -1);
  const server = sw.join(" ");
  return { server: server.charAt(0).toUpperCase() + server.slice(1), tool: tw.join(" ").toLowerCase() };
}

/** s indented when it is JSON, else s. */
export function pretty(s) {
  const t = (s ?? "").trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return s ?? "";
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return s; }
}

/** u as a link chip says it: host and path, without the scheme, the www prefix or a trailing slash. */
export function shortUrl(u) {
  const m = /^[a-z]+:\/\/(?:www\.)?([^/?#]+)([^?#]*)/i.exec(u ?? "");
  return m ? m[1] + m[2].replace(/\/$/, "") : u ?? "";
}

/** u's domain. */
export function host(u) {
  const m = /^[a-z]+:\/\/(?:www\.)?([^/?#:]+)/i.exec(u ?? "");
  return m ? m[1] : "";
}

/** Grep's output read in its output mode as files with match counts, plus the total matches. */
export function grepHits(mode, out) {
  const hits = [], at = new Map();
  let matches = 0;
  const add = (p, n) => {
    if (!at.has(p)) { at.set(p, hits.length); hits.push({ path: p, n: 0 }); }
    hits[at.get(p)].n += n;
  };
  for (let l of (out ?? "").trim().split("\n")) {
    l = l.replace(/\r$/, "");
    if (!l || l === "--" || /^Found \d+ /.test(l) || /^No (files|matches) found/.test(l) || l.startsWith("(Results are truncated")) continue;
    if (mode === "content") {
      const m = /^(.+?):(\d+):/.exec(l);
      if (m) { add(m[1], 1); matches++; continue; }
      if (/^(.+?)-(\d+)-/.test(l)) continue;
      const i = l.indexOf(":");
      if (i > 0 && /[/.]/.test(l.slice(0, i))) { add(l.slice(0, i), 1); matches++; }
    } else if (mode === "count") {
      const m = /^(.+):(\d+)$/.exec(l);
      if (m) { add(m[1], +m[2]); matches += +m[2]; }
    } else add(l.trim(), 0);
  }
  return { hits, matches };
}

/** A search's result line: 12 matches in 3 files, 3 files, No matches. */
export function hitsLine(hits, matches) {
  if (!hits.length) return "No matches";
  if (matches > 0) return `${plural(matches, "match")} in ${plural(hits.length, "file")}`;
  return plural(hits.length, "file");
}

/** Glob's output as files. */
export function globHits(out) {
  return (out ?? "").trim().split("\n").map((l) => l.trim())
    .filter((l) => l && !l.startsWith("No files found") && !l.startsWith("(Results are truncated"))
    .map((path) => ({ path, n: 0 }));
}

/** The pages a WebSearch result lists after its "Links:" lines, deduplicated. */
export function webSources(out) {
  const all = [], seen = new Set();
  for (const m of (out ?? "").matchAll(/Links: (\[.*?\])(?=\n|$)/g)) {
    let got;
    try { got = JSON.parse(m[1]); } catch { continue; }
    for (const s of got) if (s?.url && !seen.has(s.url)) { seen.add(s.url); all.push({ title: s.title || s.url, url: s.url }); }
  }
  return all;
}

const READ_LINE = /^\s*(\d+)(?:→|\t)(.*)$/;

/** Read's output as numbered lines and the range it covers; ok is false when it isn't numbered. */
export function readLines(out) {
  const lines = (out ?? "").replace(/\n+$/, "").split("\n");
  const rows = [];
  let n = 0, lo = 0, hi = 0;
  for (const l of lines) {
    const m = READ_LINE.exec(l);
    if (m) { const k = +m[1]; if (!n) lo = k; hi = k; n++; rows.push({ n: k, text: m[2] }); }
    else rows.push({ n: null, text: l });
  }
  return { rows, lo, hi, ok: n > 0 && n * 5 >= lines.length * 4 };
}

/** Diff rows from a structuredPatch, each line with its old and new numbers. */
export function patchRows(patch) {
  const rows = [];
  for (const h of patch ?? []) {
    let o = h.oldStart ?? 1, n = h.newStart ?? 1;
    rows.push({ kind: "hunk", text: `@@ -${o},${h.oldLines ?? 0} +${n},${h.newLines ?? 0} @@` });
    for (const l of h.lines ?? []) {
      const s = l[0], text = l.slice(1);
      if (s === "-") rows.push({ kind: "del", old: o++, text });
      else if (s === "+") rows.push({ kind: "add", new: n++, text });
      else if (s !== "\\") rows.push({ kind: "ctx", old: o++, new: n++, text });
    }
  }
  return rows;
}

/** Unnumbered diff rows for an edit that came without a patch: shared lines as context around the change. */
export function editRows(oldS, newS, label) {
  const a = (oldS ?? "").split("\n"), b = (newS ?? "").split("\n");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const rows = label ? [{ kind: "hunk", text: label }] : [];
  for (const t of a.slice(0, p)) rows.push({ kind: "ctx", text: t });
  for (const t of a.slice(p, a.length - s)) rows.push({ kind: "del", text: t });
  for (const t of b.slice(p, b.length - s)) rows.push({ kind: "add", text: t });
  for (const t of a.slice(a.length - s)) rows.push({ kind: "ctx", text: t });
  return rows;
}

/** A new file's lines as added rows numbered from 1. */
export function createdRows(content) {
  const lines = (content ?? "").replace(/\n$/, "").split("\n");
  return lines.map((text, i) => ({ kind: "add", new: i + 1, text }));
}

/** How many lines rows add and remove. */
export function counts(rows) {
  let add = 0, del = 0;
  for (const r of rows) { if (r.kind === "add") add++; else if (r.kind === "del") del++; }
  return { add, del };
}

/** An edit tool's diff rows, from its patch when the item has one. */
export function diffOf(item) {
  const i = item.input ?? {};
  if (isCreated(item) && i.content != null) return createdRows(i.content);
  if (item.patch?.length) return patchRows(item.patch);
  switch (item.name) {
    case "Write": return createdRows(i.content);
    case "NotebookEdit": return i.edit_mode === "delete" ? [] : createdRows(i.new_source).map((r) => ({ ...r, new: undefined }));
    case "MultiEdit": {
      const ed = i.edits ?? [];
      return ed.flatMap((e, k) => editRows(e.old_string, e.new_string, ed.length > 1 ? `Edit ${k + 1} of ${ed.length}` : ""));
    }
    default: return editRows(i.old_string, i.new_string, "");
  }
}

/** Whether a Write made a new file. */
export function isCreated(item) {
  if (item.created != null) return item.created;
  return item.name === "Write" && /^File created/.test(plain(item.result?.text));
}

/** Whether the person refused the call. */
export function isDenied(item) {
  return item.status === "denied" ||
    /^The user doesn't want to (proceed|take this action)/.test(plain(item.result?.text));
}

/** A failed shell's exit code from its output's "Exit code N" line, or null. */
export function exitCode(item) {
  const m = /^Exit code (-?\d+)/m.exec(plain(item.result?.text));
  return m ? +m[1] : null;
}

/** A failed call's error as one line, past a shell's exit code line. */
export function errorLine(item) {
  for (const l of plain(item.result?.text).split("\n")) {
    const t = l.trim();
    if (t && !/^Exit code -?\d+$/.test(t)) return t;
  }
  return "";
}

/** The one-line header's parts and which body the row opens to (diff, shell, read, hits, sources, text, prose, json). */
export function describe(item, cwd = "") {
  const i = item.input ?? {}, out = plain(item.result?.text);
  const v = { icon: "wrench", verb: item.name, arg: "", mono: false, prompt: false, note: "", link: "",
    linkKind: "", result: "", tone: "muted", body: null, add: 0, del: 0, hits: [], sources: [], denied: false };
  const done = item.status === "done";
  const setPath = (p) => { if (p) { v.arg = rel(p, cwd); v.link = abs(p, cwd); v.linkKind = "file"; } };
  const mcp = mcpName(item.name);
  if (BASH.has(item.name)) {
    v.icon = "terminal"; v.verb = i.description ?? ""; v.arg = firstLine(i.command); v.mono = v.prompt = true;
    v.body = "shell";
    if (item.status === "error") { const c = exitCode(item); if (c != null) { v.result = `exit ${c}`; v.tone = "error"; } }
  } else if (SHELL_READ.has(item.name) || SHELL_STOP.has(item.name)) {
    v.icon = "terminal"; v.verb = SHELL_READ.has(item.name) ? "Shell output" : "Stop shell";
    v.arg = i.bash_id ?? i.shell_id ?? i.task_id ?? ""; v.mono = true;
    if (out) v.body = "text";
  } else if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(item.name)) {
    v.icon = item.name === "NotebookEdit" ? "notebook-pen" : "file-pen-line";
    v.verb = item.name === "MultiEdit" ? "Edit" : item.name === "NotebookEdit" ? "Edit notebook" : item.name;
    setPath(i.file_path ?? i.notebook_path);
    if (isCreated(item)) { v.verb = "Created"; v.icon = "file-plus"; }
    if (item.status !== "error" && !isDenied(item)) {
      const c = counts(diffOf(item));
      v.add = c.add; v.del = c.del; v.body = "diff";
    }
  } else if (item.name === "Read" || item.name === "NotebookRead") {
    v.icon = "file-text"; v.verb = "Read"; setPath(i.file_path ?? i.notebook_path);
    if (item.result?.images?.length) v.result = plural(item.result.images.length, "image");
    else if (done) {
      const r = readLines(out);
      if (i.offset != null || i.limit != null) {
        const lo = r.ok ? r.lo : (i.offset ?? 1), hi = r.ok ? r.hi : lo + (i.limit ?? 1) - 1;
        v.result = `lines ${lo}–${hi}`;
      } else if (r.ok) v.result = plural(r.hi - r.lo + 1, "line");
      if (out) v.body = "read";
    }
  } else if (item.name === "Grep") {
    v.icon = "search"; v.verb = "Grep"; v.arg = i.pattern ?? ""; v.mono = true;
    if (i.path && i.path !== ".") v.note = "in " + rel(i.path, cwd);
    if (done) {
      const g = grepHits(i.output_mode, out);
      v.hits = g.hits; v.result = hitsLine(g.hits, g.matches);
      if (g.hits.length) v.body = "hits";
    }
  } else if (item.name === "Glob") {
    v.icon = "folder-search"; v.verb = "Glob"; v.arg = i.pattern ?? ""; v.mono = true;
    if (i.path && i.path !== ".") v.note = "in " + rel(i.path, cwd);
    if (done) {
      v.hits = globHits(out); v.result = v.hits.length ? plural(v.hits.length, "file") : "No files";
      if (v.hits.length) v.body = "hits";
    }
  } else if (item.name === "LS") {
    v.icon = "folder"; v.verb = "List"; setPath(i.path);
    if (done && out) v.body = "text";
  } else if (item.name === "WebSearch") {
    v.icon = "globe"; v.verb = "Search the web"; v.arg = i.query ?? "";
    if (done) { v.sources = webSources(out); if (v.sources.length) { v.result = plural(v.sources.length, "source"); v.body = "sources"; } }
  } else if (item.name === "WebFetch") {
    v.icon = "link"; v.verb = "Fetch";
    if (i.url) { v.arg = shortUrl(i.url); v.link = i.url; v.linkKind = "url"; }
    if (done && out) v.body = "prose";
  } else if (item.name === "Skill") {
    v.icon = "sparkles"; v.verb = "Using skill"; v.arg = i.skill ?? i.command ?? i.name ?? "";
  } else if (item.name === "AskUserQuestion") {
    v.icon = "list-tree"; v.verb = "Asked"; v.arg = firstLine(i.questions?.[0]?.question ?? "");
    // why: the answer comes back as "<question>"="<answer>" pairs; the row shows the answers.
    const answers = [...out.matchAll(/"[^"]*"="([^"]*)"/g)].map((x) => x[1]);
    if (answers.length) v.result = answers.join(", ");
  } else if (item.name === "ExitPlanMode") {
    v.icon = "list-tree"; v.verb = "Plan"; v.body = "json";
    v.arg = firstLine((i.plan ?? "").replace(/^#+\s*/, ""));
    if (done && /approved/i.test(out)) v.result = "Approved";
  } else if (item.name === "ToolSearch") {
    v.icon = "search"; v.verb = "Load tools"; v.arg = i.query ?? "";
  } else if (mcp) {
    v.icon = "plug"; v.verb = `${mcp.server} · ${mcp.tool}`; v.arg = firstArg(i); v.body = "json";
  } else {
    v.arg = firstArg(i); v.body = "json";
  }
  if (isDenied(item)) { v.result = "Denied"; v.tone = "muted"; v.denied = true; if (v.body !== "json") v.body = null; }
  else if (item.status === "error") {
    if (!(BASH.has(item.name) && v.result)) v.result = errorLine(item);
    v.tone = "error";
    if (v.body !== "shell" && v.body !== "json") v.body = out.includes("\n") ? "text" : null;
  }
  return v;
}

/** The 256-color palette's color n (16 and up) as hex; 0-15 come from the theme. */
export function xterm(n) {
  const hex = (x) => x.toString(16).padStart(2, "0");
  if (n >= 232) { const g = 8 + (n - 232) * 10; return `#${hex(g)}${hex(g)}${hex(g)}`; }
  n -= 16;
  const s = [0, 95, 135, 175, 215, 255];
  return `#${hex(s[Math.floor(n / 36)])}${hex(s[Math.floor(n / 6) % 6])}${hex(s[n % 6])}`;
}

/** A command's output as lines of `{ text, fg, bold }` runs, where `fg` is null, a 0-15 theme index or hex.
 *  @remarks A carriage return keeps only what follows it, as a terminal shows a progress bar's last state. */
export function ansiLines(s) {
  const st = { fg: null, bold: false };
  const out = [];
  for (let line of (s ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const cr = line.replace(/\r+$/, "").lastIndexOf("\r");
    if (cr >= 0) line = line.slice(cr + 1);
    const runs = [];
    let buf = "";
    const flush = () => { if (buf) runs.push({ text: buf, fg: st.fg, bold: st.bold }); buf = ""; };
    for (let k = 0; k < line.length;) {
      const ch = line[k];
      if (ch !== "\x1b") {
        if (ch === "\t") buf += "    "; else if (ch >= " ") buf += ch;
        k++; continue;
      }
      const rest = line.slice(k);
      const m = /^\x1b\[([0-9;?]*)([@-~])/.exec(rest) ?? /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(rest);
      if (!m) { k++; continue; }
      k += m[0].length;
      if (m[2] !== "m") continue;
      flush();
      sgr(st, m[1]);
    }
    flush();
    out.push(runs);
  }
  return out;
}

function sgr(st, params) {
  const p = params === "" ? [0] : params.split(";").map((x) => +x || 0);
  for (let k = 0; k < p.length; k++) {
    const c = p[k];
    if (c === 0) { st.fg = null; st.bold = false; }
    else if (c === 1) st.bold = true;
    else if (c === 22) st.bold = false;
    else if (c >= 30 && c <= 37) st.fg = c - 30;
    else if (c >= 90 && c <= 97) st.fg = c - 90 + 8;
    else if (c === 39) st.fg = null;
    else if (c === 38 && p[k + 1] === 5) { const n = p[k + 2] ?? 0; st.fg = n < 16 ? n : xterm(n); k += 2; }
    else if (c === 38 && p[k + 1] === 2) {
      const h = (x) => Math.max(0, Math.min(255, x ?? 0)).toString(16).padStart(2, "0");
      st.fg = `#${h(p[k + 2])}${h(p[k + 3])}${h(p[k + 4])}`; k += 4;
    } else if (c === 48 && p[k + 1] === 5) k += 2;
    else if (c === 48 && p[k + 1] === 2) k += 4;
  }
}

/** The last n of lines, and how many came before them. */
export function tail(lines, n) {
  return lines.length <= n ? { shown: lines, hidden: 0 } : { shown: lines.slice(-n), hidden: lines.length - n };
}

/** Hex color a mixed toward hex color b by p from 0 to 1, dropping a's alpha. */
export function mix(a, b, p) {
  const rgb = (h) => { const x = (h ?? "#000000").replace("#", ""); return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) || 0); };
  const A = rgb(a), B = rgb(b);
  return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * p).toString(16).padStart(2, "0")).join("");
}
