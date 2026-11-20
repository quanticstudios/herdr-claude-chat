#!/usr/bin/env python3
"""Reads Claude Code transcripts for the claude-chat mod in bounded pages; run with python3 -I."""
import base64, hashlib, json, os, re, sys

USAGE = """usage: transcript.py [--cache <dir>] <command> ...
  find <json>                        {path, sessionId, verified, how} for a herdr terminal
  tail <path>                        the newest lines, back to the last compaction or a budget
  older <path> <cursor>              the page that ends at cursor (a byte offset)
  since <path> <offset> <ino>        complete lines written after offset, or {reset: true}
  full <path> <at> <bytes> <prefix>  the whole string a Clipped field stands for, capped
  images <path> <at>                 writes that line's base64 images to the cache
Lines come back parsed with $at (byte offset). Strings over CLIP chars become Clipped
{head, tail, bytes, at}; base64 image sources become {type: "path", path, media_type, at, i},
with images written to --cache (default ~/.cache/herdr-claude-chat).
"""

CHUNK = 1 << 20
RECORD_CAP = 8 << 20  # why: a bigger record is skimmed from its ends, never held whole
PAGE_RAW = 64 << 20
PAGE_OUT = 1536 << 10
PAGE_LINES = 800
NEW_RAW = 16 << 20
CLIP, HEAD, TAIL = 12000, 4000, 1500
IMG_BUDGET = 24 << 20
FULL_CAP = 4 << 20
# why: request and file-history records are big and carry nothing the chat draws.
SKIP = {"api-request", "api-request-blob", "api-request-shape", "file-history-snapshot", "file-history-delta"}

HOME = os.path.expanduser("~")
CACHE = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.join(HOME, ".cache"), "herdr-claude-chat")
# why: fixed under HOME so the hook (Claude's env) and this reader (the app's env) agree.
STATE = os.path.join(HOME, ".local", "state", "herdr-claude-chat")


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))


def spans_back(f, end):
    """(start, stop) of each line ending at or before end, newest first, one chunk in memory."""
    pos = line_end = end
    while pos > 0:
        n = min(CHUNK, pos)
        pos -= n
        f.seek(pos)
        buf = f.read(n)
        i = len(buf)
        while (j := buf.rfind(b"\n", 0, i)) >= 0:
            s = pos + j + 1
            if s < line_end:
                yield s, line_end
            line_end, i = s, j
    if line_end > 0:
        yield 0, line_end


def spans_fwd(f, start, size):
    """(start, stop) of each complete line from start, oldest first; a partial last line is left out."""
    pos = line_start = start
    while pos < size:
        f.seek(pos)
        buf = f.read(min(CHUNK, size - pos))
        if not buf:
            break
        i = 0
        while (j := buf.find(b"\n", i)) >= 0:
            yield line_start, pos + j + 1
            line_start, i = pos + j + 1, j + 1
        pos += len(buf)


def complete_end(f, size):
    """The offset just past the last newline, where complete lines stop."""
    for s, e in spans_back(f, size):
        f.seek(e - 1)
        return e if f.read(1) == b"\n" else s
    return 0


def jstr(frag):
    """Decodes a cut JSON string body, dropping a half escape at its end."""
    for cut in range(0, 8):
        try:
            return json.loads('"' + frag[: len(frag) - cut] + '"')
        except ValueError:
            continue
    return ""


def grab(key, *texts):
    for t in texts:
        m = re.search(r'"%s"\s*:\s*"((?:[^"\\]|\\.)*)"' % key, t)
        if m:
            return jstr(m.group(1))
    return None


def skim(f, s, e):
    """Stands in for a record over RECORD_CAP, read from its first and last windows only."""
    f.seek(s)
    head = f.read(256 << 10).decode("utf-8", "replace")
    f.seek(max(s, e - (64 << 10)))
    tail = f.read(64 << 10).decode("utf-8", "replace")
    obj = {"_oversized": e - s}
    for k in ("type", "uuid", "parentUuid", "timestamp", "sessionId", "subtype"):
        v = grab(k, head, tail)
        if v is not None:
            obj[k] = v
    obj.setdefault("type", "unknown")
    if '"isSidechain":true' in head:
        obj["isSidechain"] = True
    m = re.search(r'"(?:text|content)"\s*:\s*"((?:[^"\\]|\\.){0,%d})' % (HEAD * 2), head)
    text = {"head": jstr(m.group(1))[:HEAD] if m else "", "tail": "", "bytes": e - s, "at": s}
    tid = grab("tool_use_id", head)
    if obj["type"] == "user" and tid:
        block = {"type": "tool_result", "tool_use_id": tid, "content": text, "is_error": '"is_error":true' in head + tail}
        obj["message"] = {"role": "user", "content": [block]}
    elif obj["type"] == "assistant":
        m = re.search(r'"type"\s*:\s*"tool_use"\s*,\s*"id"\s*:\s*"([^"]+)"\s*,\s*"name"\s*:\s*"([^"]+)"', head)
        block = {"type": "tool_use", "id": m.group(1), "name": m.group(2), "input": {"_clipped": text}} if m else {"type": "text", "text": text}
        obj["message"] = {"role": "assistant", "content": [block]}
    return obj


class Images:
    def __init__(self, budget):
        self.budget = budget

    def write(self, src):
        data = src["data"]
        ext = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}.get(src.get("media_type"), "img")
        path = os.path.join(CACHE, hashlib.sha1(data.encode()).hexdigest() + "." + ext)
        if os.path.exists(path):
            return path
        size = len(data) * 3 // 4
        if size > self.budget:
            return None
        self.budget -= size
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".%d.tmp" % os.getpid()
        with open(tmp, "wb") as w:
            w.write(base64.b64decode(data))
        os.replace(tmp, path)
        return path


def clip(v, at, imgs, n):
    if isinstance(v, str):
        if len(v) <= CLIP:
            return v
        return {"head": v[:HEAD], "tail": v[-TAIL:], "bytes": len(v.encode("utf-8", "replace")), "at": at}
    if isinstance(v, list):
        return [clip(x, at, imgs, n) for x in v]
    if isinstance(v, dict):
        if v.get("type") == "base64" and isinstance(v.get("data"), str):
            n[0] += 1
            return {"type": "path", "path": imgs.write(v) if imgs else None, "media_type": v.get("media_type"),
                    "at": at, "i": n[0] - 1}
        return {k: clip(x, at, imgs, n) for k, x in v.items()}
    return v


def load(f, s, e, imgs):
    """The record at [s, e) parsed and clipped, or None for blank, broken and skipped ones."""
    if e - s > RECORD_CAP:
        obj = skim(f, s, e)
    else:
        f.seek(s)
        try:
            obj = json.loads(f.read(e - s))
        except ValueError:
            return None
        if not isinstance(obj, dict):
            return None
        obj = clip(obj, s, imgs, [0])
    if obj.get("type") in SKIP:
        return None
    obj["$at"] = s
    return obj


def page(path, end, stop_at_compaction):
    """Lines before end, read newest first and returned oldest first."""
    if not os.path.exists(path):
        return out({"lines": [], "cursor": 0, "hasOlder": False, "end": 0, "size": 0, "ino": 0})
    st = os.stat(path)
    imgs = Images(IMG_BUDGET)
    parts, used, raw = [], 0, 0
    with open(path, "rb") as scan, open(path, "rb") as f:
        if end is None:
            end = complete_end(scan, st.st_size)
        first = end
        for s, e in spans_back(scan, end):
            if parts and (raw + e - s > PAGE_RAW or len(parts) >= PAGE_LINES):
                break
            obj = load(f, s, e, imgs)
            if obj is not None:
                text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
                if parts and used + len(text) > PAGE_OUT:
                    break
                parts.append(text)
                used += len(text)
            raw += e - s
            first = s
            if obj and stop_at_compaction and obj.get("type") == "system" and obj.get("subtype") == "compact_boundary":
                break
    parts.reverse()
    sys.stdout.write('{"lines":[%s],"cursor":%d,"hasOlder":%s,"end":%d,"size":%d,"ino":%d}' % (
        ",".join(parts), first, "true" if first > 0 else "false", end, st.st_size, st.st_ino))


def since(path, off, ino):
    try:
        st = os.stat(path)
    except FileNotFoundError:
        if ino == 0:  # why: a new session's file appears with its first message
            return out({"lines": [], "end": 0, "more": False, "size": 0, "ino": 0})
        return out({"reset": True, "gone": True})
    with open(path, "rb") as scan, open(path, "rb") as f:
        if st.st_ino != ino or st.st_size < off:
            return out({"reset": True})
        if off > 0:
            scan.seek(off - 1)
            if scan.read(1) != b"\n":  # why: rewritten in place under the same inode
                return out({"reset": True})
        imgs = Images(IMG_BUDGET)
        parts, used, end, more = [], 0, off, False
        for s, e in spans_fwd(scan, off, st.st_size):
            if parts and (e - off > NEW_RAW or used > PAGE_OUT or len(parts) >= PAGE_LINES):
                more = True
                break
            end = e
            obj = load(f, s, e, imgs)
            if obj is not None:
                text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
                parts.append(text)
                used += len(text)
    sys.stdout.write('{"lines":[%s],"end":%d,"more":%s,"size":%d,"ino":%d}' % (
        ",".join(parts), end, "true" if more else "false", st.st_size, st.st_ino))


def walk_strings(v):
    if isinstance(v, str):
        yield v
    elif isinstance(v, list):
        for x in v:
            yield from walk_strings(x)
    elif isinstance(v, dict):
        for x in v.values():
            yield from walk_strings(x)


def line_at(path, at):
    """The end offset of the complete line starting at at, or None."""
    with open(path, "rb") as scan:
        return next((e for s, e in spans_fwd(scan, at, os.stat(path).st_size)), None)


def full(path, at, size, prefix):
    e = line_at(path, at)
    if e is None:
        return out({"text": None})
    with open(path, "rb") as f:
        f.seek(at)
        if e - at > RECORD_CAP:
            frag = f.read(FULL_CAP + 4096).decode("utf-8", "replace")
            m = re.search(r'"(?:text|content)"\s*:\s*"', frag)
            return out({"text": jstr(frag[m.end():m.end() + FULL_CAP]) if m else "", "truncated": True})
        obj = json.loads(f.read(e - at))
    for v in walk_strings(obj):
        if len(v) > CLIP and v.startswith(prefix) and len(v.encode("utf-8", "replace")) == size:
            return out({"text": v[:FULL_CAP], "truncated": len(v) > FULL_CAP})
    out({"text": None})


def images(path, at):
    e = line_at(path, at)
    if e is None or e - at > RECORD_CAP:
        return out({"images": []})
    with open(path, "rb") as f:
        f.seek(at)
        obj = json.loads(f.read(e - at))
    found, imgs = [], Images(1 << 62)

    def walk(v):
        if isinstance(v, dict):
            if v.get("type") == "base64" and isinstance(v.get("data"), str):
                found.append({"path": imgs.write(v), "media_type": v.get("media_type"), "at": at, "i": len(found)})
                return
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
    walk(obj)
    out({"images": found})


def encode(cwd):
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


def project_dir(config, cwd):
    base = os.path.join(config, "projects")
    d = os.path.join(base, encode(cwd))
    if os.path.isdir(d) or len(encode(cwd)) <= 200:
        return d
    # why: Claude cuts very long folder names and adds a hash.
    for name in os.listdir(base) if os.path.isdir(base) else []:
        if name.startswith(encode(cwd)[:200]):
            return os.path.join(base, name)
    return d


def config_of(pid):
    """CLAUDE_CONFIG_DIR of a process, reading that one variable only."""
    try:
        with open("/proc/%d/environ" % pid, "rb") as f:
            for kv in f.read().split(b"\0"):
                if kv.startswith(b"CLAUDE_CONFIG_DIR="):
                    return kv.split(b"=", 1)[1].decode()
    except (OSError, ValueError):
        pass
    return None


def proc_start(pid):
    try:
        with open("/proc/%d/stat" % pid) as f:
            return f.read().rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def descendants(pid, depth=3):
    found, level = [pid], [pid]
    for _ in range(depth):
        nxt = []
        for p in level:
            try:
                for t in os.listdir("/proc/%d/task" % p):
                    with open("/proc/%d/task/%s/children" % (p, t)) as f:
                        nxt += [int(c) for c in f.read().split()]
            except OSError:
                pass
        found += nxt
        level = nxt
    return found


def find(info):
    addr, cwd = info.get("address"), info.get("cwd") or ""
    created = (info.get("created_ms") or 0) / 1000
    pids = [p for p in (info.get("fgpid"), info.get("pid")) if p]
    configs = []
    for p in pids:
        c = config_of(p)
        if c and c not in configs:
            configs.append(c)
    if os.path.join(HOME, ".claude") not in configs:
        configs.append(os.path.join(HOME, ".claude"))
    live = [d for p in pids for d in descendants(p)]
    # 1. The SessionStart hook's record, which Claude writes on start, /resume and /clear.
    # why: a verified path is returned before its file exists, since a new session writes nothing until its first message.
    if addr:
        core = os.environ.get("HC_SESSION") or "default"
        try:
            with open(os.path.join(STATE, "bindings", core, addr + ".json")) as f:
                b = json.load(f)
            if b.get("at", 0) / 1000 >= created - 5 and b.get("transcript_path") and (not live or b.get("pid") in live):
                return {"path": b["transcript_path"], "sessionId": b.get("session_id"), "verified": True, "how": "hook"}
        except (OSError, ValueError):
            pass
    # 2. Claude's own pid record, <config>/sessions/<pid>.json, checked against the process start time.
    for p in live:
        for c in configs:
            try:
                with open(os.path.join(c, "sessions", "%d.json" % p)) as f:
                    s = json.load(f)
            except (OSError, ValueError):
                continue
            if s.get("procStart") and s["procStart"] != proc_start(p):
                continue
            path = os.path.join(project_dir(c, s.get("cwd") or cwd), s["sessionId"] + ".jsonl")
            return {"path": path, "sessionId": s["sessionId"], "verified": True, "how": "pid"}
    # 3. Guesses: an explicit session id in argv, else the newest transcript written since the terminal started.
    argv = info.get("argv") or []
    for flag in ("--resume", "-r", "--session-id"):
        if flag in argv[:-1]:
            sid = argv[argv.index(flag) + 1]
            for c in configs:
                path = os.path.join(project_dir(c, cwd), sid + ".jsonl")
                if os.path.exists(path):
                    return {"path": path, "sessionId": sid, "verified": False, "how": "resume"}
    best = None
    for c in configs:
        d = project_dir(c, cwd)
        try:
            names = [n for n in os.listdir(d) if n.endswith(".jsonl")]
        except OSError:
            continue
        for n in names:
            m = os.stat(os.path.join(d, n)).st_mtime
            if m >= created - 2 and (best is None or m > best[0]):
                best = (m, os.path.join(d, n))
    if best:
        return {"path": best[1], "sessionId": os.path.basename(best[1])[:-6], "verified": False, "how": "guess"}
    return {"path": None, "verified": False, "how": "none"}


def main(argv):
    global CACHE
    if len(argv) > 2 and argv[1] == "--cache":
        CACHE, argv = argv[2], argv[:1] + argv[3:]
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "tail":
        page(argv[2], None, True)
    elif cmd == "older":
        page(argv[2], int(argv[3]), False)
    elif cmd == "since":
        since(argv[2], int(argv[3]), int(argv[4]))
    elif cmd == "full":
        full(argv[2], int(argv[3]), int(argv[4]), argv[5] if len(argv) > 5 else "")
    elif cmd == "images":
        images(argv[2], int(argv[3]))
    elif cmd == "find":
        out(find(json.loads(argv[2])))
    else:
        sys.stderr.write(USAGE)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
