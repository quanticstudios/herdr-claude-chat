// A small per-line syntax tint for code blocks: comments, strings, numbers and keywords. Pure.

const KW = new Set(("abstract as async await break case catch class const continue def default defer del delete do elif else enum " +
  "export extends false final finally fn for from func function go if impl import in interface is let match mod mut new nil " +
  "none null package pass private protected pub public raise return self static struct super switch this throw throws trait " +
  "true try type typeof undefined unsafe use var void where while with yield True False None").split(" "));

const HASH = new Set(["sh", "bash", "zsh", "shell", "console", "py", "python", "rb", "ruby", "yaml", "yml", "toml", "dockerfile", "make", "makefile", "r", "pl", "perl", "conf", "ini", "nix"]);
const DASH = new Set(["sql", "lua", "hs", "haskell"]);
const NONE = new Set(["", "text", "txt", "plain", "md", "markdown", "diff", "patch", "log", "output"]);

/**
 * Splits one code line into `{k?, v}` runs; `k` is `kw`, `str`, `num` or `com`. Joined `v`s give the line back.
 * @remarks Per line, so a block comment or string spanning lines tints only its first line.
 */
export function tint(line, lang) {
  if (NONE.has(lang)) return [{ v: line }];
  const hash = HASH.has(lang);
  const dash = DASH.has(lang);
  const out = [];
  let plain = "";
  const push = (k, v) => { if (plain) { out.push({ v: plain }); plain = ""; } out.push({ k, v }); };
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    const c = line[i];
    if ((hash && c === "#" && (i === 0 || /\s/.test(line[i - 1]))) || (!hash && !dash && rest.startsWith("//")) || (dash && rest.startsWith("--"))) {
      push("com", rest);
      break;
    }
    if (!hash && !dash && rest.startsWith("/*")) {
      const e = rest.indexOf("*/", 2);
      const v = e < 0 ? rest : rest.slice(0, e + 2);
      push("com", v);
      i += v.length;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += line[j] === "\\" ? 2 : 1;
      const v = line.slice(i, j + 1);
      push("str", v);
      i += v.length;
      continue;
    }
    const num = /^\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\w*/i.exec(rest);
    if (num && (i === 0 || !/\w/.test(line[i - 1]))) { push("num", num[0]); i += num[0].length; continue; }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word) {
      if (KW.has(word[0])) push("kw", word[0]);
      else plain += word[0];
      i += word[0].length;
      continue;
    }
    plain += c;
    i++;
  }
  if (plain) out.push({ v: plain });
  return out;
}
