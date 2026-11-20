// Reads the prompt a blocked Claude shows (permission, trust, plan) off its screen text. Pure, no herdr imports.

const RULE = /^[\s─━╌┄═╭╮╰╯│]*$/;
const OPTION = /^\s*(❯|›|>)?\s*(?:(\d+)\.\s+)?(\S.*?)\s*$/;

/**
 * The open prompt at the bottom of `screen` (`hc read` output), or null.
 * @returns {{title: string, lines: string[], question: string, options: {n: number, label: string, selected: boolean, keys: string[]}[]} | null}
 */
export function parseApproval(screen) {
  const rows = String(screen ?? "").split("\n").map((r) => r.replace(/\s+$/, "").replace(/^\s*│\s?/, ""));
  // why: hc appends a note of its own below the screen when the program is blocked.
  while (rows.length && (rows.at(-1) === "" || rows.at(-1).startsWith("[hc]"))) rows.pop();
  let end = rows.length;
  while (end > 0 && !/^\s*(❯|›)\s/.test(rows[end - 1])) end--;
  if (!end) return null;
  let first = end - 1;
  while (first > 0 && isOption(rows[first - 1])) first--;
  let last = end - 1;
  while (last + 1 < rows.length && isOption(rows[last + 1])) last++;
  const opts = rows.slice(first, last + 1).map((r) => OPTION.exec(r));
  if (opts.length < 2) return null;
  const sel = opts.findIndex((m) => m[1]);
  const options = opts.map((m, i) => ({
    n: m[2] ? Number(m[2]) : i + 1,
    label: m[3].trim(),
    selected: i === sel,
    keys: m[2] ? [m[2]] : [...Array(Math.abs(i - sel)).fill(i > sel ? "down" : "up"), "enter"],
  }));
  let start = first - 1;
  while (start >= 0 && !isTopRule(rows[start])) start--;
  const above = rows.slice(start + 1, first).map((r) => r.trim())
    .filter((r) => r !== "" && !/^[╌┄]+$/.test(r) && !/^Tip:/.test(r));
  let q = above.findLastIndex((r) => r.endsWith("?"));
  if (q < 0) q = above.length - 1;
  const question = above[q] ?? "";
  const body = above.filter((_, i) => i !== q);
  return { title: body[0] ?? "", lines: body.slice(1), question, options };
}

function isOption(r) {
  return /^\s*(❯|›)?\s*\d+\.\s+\S/.test(r) || (/^\s{2,}\S/.test(r) && !RULE.test(r) && r.trim().length < 80);
}

function isTopRule(r) {
  return /^\s*[─━]{8,}\s*$/.test(r);
}
