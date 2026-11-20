// Pure text helpers behind system.js, checked by sys.check.mjs.

/** Seconds as "4.2s", "12s", "1m 4s" or "2h 3m"; "" when unknown. */
export function dur(s) {
  if (s == null || !isFinite(s) || s < 0) return "";
  if (s < 10) return `${Math.round(s * 10) / 10}s`;
  s = Math.round(s);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`;
}

/** A token count as "950", "12.4K" or "1.2M". */
export function count(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, "")}K`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Dollars as "$0.04" or "<$0.01"; "" when unknown. */
export function money(x) {
  if (x == null) return "";
  return x > 0 && x < 0.01 ? "<$0.01" : `$${x.toFixed(2)}`;
}

/** Text without ANSI escape sequences (CSI, OSC) and lone carriage returns. */
export function stripAnsi(s) {
  return (s ?? "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r(?!\n)/g, "");
}

/** A `Text` as a string: the full text when `full` has it, else its head and tail. */
export function textOf(t, full) {
  if (t == null) return "";
  if (typeof t === "string") return t;
  return (full && full(t)) ?? `${t.head}\n…\n${t.tail}`;
}

/** The plan's progress: items done, the total, and the item in progress or null. */
export function progress(items) {
  const list = items ?? [];
  return {
    done: list.filter((x) => x.status === "completed").length,
    total: list.length,
    now: list.find((x) => x.status === "in_progress") ?? null,
  };
}

/** The first non-empty line without markdown marks, cut to `max` characters. */
export function firstLine(text, max = 140) {
  const line = (text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const clean = line.replace(/^(#+|[-*>]|\d+\.)\s+/, "").replace(/\*\*|__|`/g, "");
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + "…" : clean;
}

/** A one-line summary of markdown: its first line that isn't a heading, else its first line. */
export function summary(text, max = 140) {
  const body = (text ?? "").split("\n").find((l) => l.trim() && !/^\s*#/.test(l) && !/^\s*(```|---|\*\*\*)/.test(l));
  return firstLine(body ?? text, max);
}

/** Lines in a text, not counting a trailing newline. */
export function lineCount(text) {
  const s = (text ?? "").replace(/\n$/, "");
  return s ? s.split("\n").length : 0;
}

/** The first `n` lines and how many more were cut. */
export function headLines(text, n) {
  const lines = (text ?? "").replace(/\n$/, "").split("\n");
  return { text: lines.slice(0, n).join("\n"), more: Math.max(0, lines.length - n) };
}

/** A Task, Agent or Workflow item's card title, agent type and nested tool count. */
export function agentInfo(item) {
  const i = item.input ?? {};
  const isWorkflow = item.name === "Workflow";
  const title = firstLine(i.description ?? i.name ?? i.title ?? i.prompt ?? (isWorkflow ? "Workflow" : "Subagent"), 90);
  const type = isWorkflow ? "workflow" : (i.subagent_type ?? i.agent_type ?? "general-purpose");
  const tools = (item.children ?? []).filter((c) => c.kind === "tool").length;
  return { title, type, tools };
}

/** An item's seconds, or the time since it started while it runs, or null. */
export function elapsed(item, now = Date.now()) {
  if (item.seconds != null) return item.seconds;
  if (item.status === "running" && item.at) return Math.max(0, (now - item.at) / 1000);
  return null;
}

/** How a notice draws: interrupt, compact, switch, task, hook, recap, card (error or warn) or row. */
export function noticeKind(n) {
  if (["interrupt", "compact", "switch", "task", "hook", "recap"].includes(n.what)) return n.what;
  const t = n.text ?? "";
  if (/^\[?request interrupted/i.test(t) || /^(interrupted|stopped)\b/i.test(t)) return "interrupt";
  if (/^conversation compacted/i.test(t)) return "compact";
  if (/^background task/i.test(t)) return "task";
  if (/^(switched to|set model to|plan mode|accept edits|bypass permissions|default mode)/i.test(t)) return "switch";
  if (/^\S*\s?hook\b/i.test(t)) return "hook";
  if (n.tone === "error" || n.tone === "warn" || n.what === "api" || n.what === "limit") return "card";
  return "row";
}

/** An integer with thousands commas, since QuickJS's `toLocaleString` adds none. */
export function grouped(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
