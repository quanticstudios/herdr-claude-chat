// A small per-line syntax tint for code blocks: comments, strings, regexes, numbers, literals, keywords, function names, types and punctuation. Pure.

const KW = new Set(("abstract as async await break case catch class const continue def default defer del delete do elif else enum " +
  "export extends final finally fn for from func function go if impl import in interface is let match mod mut new " +
  "package pass private protected pub public raise return self static struct super switch this throw throws trait " +
  "try type typeof unsafe use var void where while with yield").split(" "));
const LIT = new Set("true false null undefined nil none None True False NaN Infinity".split(" "));
const DECL = new Set(["function", "def", "fn", "func", "class", "struct", "interface", "trait", "enum", "type"]);
const BUILTIN = new Set(("console process require module exports window document globalThis Math JSON Object Array Promise " +
  "String Number Boolean Date Error Map Set RegExp Symbol print len range str int float dict list tuple set").split(" "));
// why: a slash after one of these (or at line start) opens a regex literal, not a division.
const REGEX_BEFORE = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof)\s*$/;
const C_LIKE = new Set(["js", "jsx", "mjs", "cjs", "javascript", "ts", "tsx", "typescript"]);

const HASH = new Set(["sh", "bash", "zsh", "shell", "console", "py", "python", "rb", "ruby", "yaml", "yml", "toml", "dockerfile", "make", "makefile", "r", "pl", "perl", "conf", "ini", "nix"]);
const DASH = new Set(["sql", "lua", "hs", "haskell"]);
const NONE = new Set(["", "text", "txt", "plain", "md", "markdown", "diff", "patch", "log", "output"]);

/**
 * Splits one code line into `{k?, v}` runs; `k` is `kw`, `str`, `num`, `com`, `fn`, `type` or `op`. Joined `v`s give the line back.
 * @remarks Per line, so a block comment or string spanning lines tints only its first line.
 */
export function tint(line, lang) {
  if (NONE.has(lang)) return [{ v: line }];
  const hash = HASH.has(lang);
  const dash = DASH.has(lang);
  const regexes = C_LIKE.has(lang) || !lang;
  const out = [];
  let plain = "";
  let prevWord = "";
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
    if (regexes && c === "/" && REGEX_BEFORE.test(line.slice(0, i))) {
      const m = /^\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[a-z]*/.exec(rest);
      if (m) { push("str", m[0]); i += m[0].length; continue; }
    }
    const num = /^\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\w*/i.exec(rest);
    if (num && (i === 0 || !/\w/.test(line[i - 1]))) { push("num", num[0]); i += num[0].length; continue; }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word) {
      const w = word[0];
      const after = line.slice(i + w.length);
      const member = line[i - 1] === ".";
      if (!member && KW.has(w)) push("kw", w);
      else if (!member && LIT.has(w)) push("num", w);
      else if (DECL.has(prevWord) || /^\s*\(/.test(after)) push(/^[A-Z]/.test(w) && !/^\s*\(/.test(after) ? "type" : "fn", w);
      else if (!member && (BUILTIN.has(w) || /^[A-Z][a-z]\w*$/.test(w))) push("type", w);
      else plain += w;
      prevWord = w;
      i += w.length;
      continue;
    }
    if (/[{}()[\];,.]/.test(c)) { push("op", c); i++; continue; }
    if (!/\s/.test(c)) prevWord = "";
    plain += c;
    i++;
  }
  if (plain) out.push({ v: plain });
  return out;
}
