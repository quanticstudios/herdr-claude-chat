#!/usr/bin/env python3
"""Prints the slash commands Claude Code offers in a folder as name, description, kind rows."""
import json
import os
import re
import shutil
import sys

HOME = os.path.expanduser("~")
CLAUDE = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(HOME, ".claude")


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def front(path):
    """The frontmatter's description, folded to one line, and user-invocable."""
    out = {}
    try:
        with open(path, errors="replace") as f:
            if f.readline().strip() != "---":
                return out
            lines = []
            for line in f:
                if line.strip() == "---":
                    break
                lines.append(line.rstrip("\n"))
    except OSError:
        return out
    i = 0
    while i < len(lines):
        key, _, val = lines[i].partition(":")
        key, val = key.strip(), val.strip()
        if key in ("description", "user-invocable") and not lines[i].startswith((" ", "\t")):
            if val in (">", "|", ">-", "|-", ">+", "|+", ""):
                block = []
                while i + 1 < len(lines) and (lines[i + 1].startswith((" ", "\t")) or not lines[i + 1].strip()):
                    i += 1
                    block.append(lines[i].strip())
                val = " ".join(b for b in block if b)
            out[key] = val.strip().strip("\"'")
        i += 1
    return out


def row(name, path, kind):
    fm = front(path)
    if fm.get("user-invocable", "").lower() == "false":
        return None
    desc = " ".join(fm.get("description", "").split())
    return f"{name}\t{desc[:240]}\t{kind}"


def skills(root, prefix=""):
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return []
    out = []
    for d in names:
        p = os.path.join(root, d, "SKILL.md")
        if os.path.isfile(p):
            out.append(row(prefix + d, p, "skill"))
    return out


def commands(root, prefix=""):
    out = []
    for base, dirs, files in os.walk(root):
        dirs.sort()
        rel = os.path.relpath(base, root)
        parts = [] if rel == "." else rel.split(os.sep)
        for f in sorted(files):
            if f.endswith(".md"):
                out.append(row(prefix + ":".join(parts + [f[:-3]]), os.path.join(base, f), "command"))
    return out


def install_path(entries, cwd):
    """The install that applies in cwd: the deepest project entry above it, else the user one, else the newest."""
    best, depth = None, -1
    for e in entries:
        pp = e.get("projectPath")
        if e.get("scope") in ("project", "local") and pp and (cwd == pp or cwd.startswith(pp.rstrip("/") + "/")):
            if len(pp) > depth:
                best, depth = e, len(pp)
    if not best:
        best = next((e for e in entries if e.get("scope") == "user"), None)
    if not best and entries:
        best = max(entries, key=lambda e: e.get("lastUpdated", ""))
    return best and best.get("installPath")


def paths(manifest, key, default):
    v = manifest.get(key)
    vals = v if isinstance(v, list) else [v] if isinstance(v, str) else []
    return vals or [default]


def plugins(cwd):
    enabled = {}
    for p in (os.path.join(CLAUDE, "settings.json"), os.path.join(cwd, ".claude", "settings.json"),
              os.path.join(cwd, ".claude", "settings.local.json")):
        enabled.update(load(p).get("enabledPlugins") or {})
    installed = load(os.path.join(CLAUDE, "plugins", "installed_plugins.json")).get("plugins") or {}
    out = []
    for key, on in sorted(enabled.items()):
        if not on or key not in installed:
            continue
        root = install_path(installed[key], cwd)
        if not root or not os.path.isdir(root):
            continue
        manifest = load(os.path.join(root, ".claude-plugin", "plugin.json"))
        name = manifest.get("name") or key.split("@")[0]
        for s in paths(manifest, "skills", "skills"):
            out += skills(os.path.normpath(os.path.join(root, s)), name + ":")
        for c in paths(manifest, "commands", "commands"):
            out += commands(os.path.normpath(os.path.join(root, c)), name + ":")
    return out


def claude_binary():
    """The real Claude Code executable, past mise shims and links, or None."""
    for c in (shutil.which("claude"), os.path.join(HOME, ".local", "bin", "claude"), os.path.join(CLAUDE, "local", "claude")):
        if c and os.path.isfile(c) and os.path.getsize(os.path.realpath(c)) > 10_000_000:
            return os.path.realpath(c)
    return None


def enclosing(data, i):
    """The top-level text of the object literal around index i, its full text, and the 12 chars before it."""
    depth, j = 0, i
    while True:
        j -= 1
        if j < max(0, i - 400):
            return None
        if data[j] == "}":
            depth += 1
        elif data[j] == "{":
            if depth == 0:
                break
            depth -= 1
    depth, k, top, quote = 0, j, [], None
    while k < min(len(data), j + 4000):
        ch = data[k]
        if quote:
            if ch == "\\":
                k += 2
                continue
            if ch == quote:
                quote = None
        elif ch in "\"'`":
            quote = ch
        elif ch in "{([":
            depth += 1
        elif ch in "})]":
            depth -= 1
            if depth == 0:
                return "".join(top), data[j:k + 1], data[j - 12:j]
        if depth == 1 and not (ch in "{([" and k == j):
            top.append(ch)
        k += 1
    return None


def builtins():
    """Built-in commands read from the Claude Code binary, so the list matches the installed version."""
    path = claude_binary()
    if not path:
        return []
    with open(path, "rb") as f:
        data = f.read().decode("latin-1")
    found = {}
    for m in re.finditer(r'name:"([a-z][a-z0-9-]*)"', data):
        name = m.group(1)
        if name in found:
            continue
        hit = enclosing(data, m.start())
        if not hit:
            continue
        top, full, before = hit
        typed = re.search(r'type:"(?:local|local-jsx|prompt)"', top)
        # why: unwrapped command objects carry a type; bundled skills and cloud commands arrive through a registration call instead.
        wrapped = re.search(r"[\w$]+\($", before) and not re.search(r"inputSchema|websiteUrl|hooksModule|userInvocable:!1", top)
        if not (typed or wrapped) or "isHidden:!0" in top:
            continue
        d = re.search(r'(?:^|,)(?:description|menuDescription):(?:"([^"]*)"|`([^`$]*)`)', top) \
            or re.search(r'get description\(\)\{return[^"]{0,60}"([^"]*)"', full)
        if not d:
            continue
        desc = next(g for g in d.groups() if g is not None)
        if re.match(r"\(removed\)|Renamed to", desc):
            continue
        al = re.search(r'aliases:\[([^\]]*)\]', full)
        aliases = re.findall(r'"([a-z][a-z0-9-]*)"', al.group(1)) if al else []
        found[name] = f"{name}\t{' '.join(desc.split())[:240]}\tbuilt-in\t{' '.join(aliases)}"
    return [found[n] for n in sorted(found)]


def main():
    cwd = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.getcwd())
    rows = builtins() + commands(os.path.join(CLAUDE, "commands")) + commands(os.path.join(cwd, ".claude", "commands"))
    rows += skills(os.path.join(CLAUDE, "skills")) + skills(os.path.join(cwd, ".claude", "skills"))
    rows += plugins(cwd)
    seen = set()
    for r in rows:
        if r and r.split("\t", 1)[0] not in seen:
            seen.add(r.split("\t", 1)[0])
            print(r)


if __name__ == "__main__":
    main()
