#!/usr/bin/env python3
"""Shows one Herdr pane and hides another in the layout document: layoutdoc.py show <pane> <pane-to-hide> | bar <chat> <terminal> <px> | unhide <pane> | drop <chat> <terminal> | release."""
import json
import secrets
import subprocess
import sys


def rpc(method, params):
    msgs = [{"jsonrpc": "2.0", "id": 1, "method": "hello", "params": {"generation": 1}},
            {"jsonrpc": "2.0", "id": 2, "method": method, "params": params}]
    out = subprocess.run(["hc", "connect"], input="".join(json.dumps(m) + "\n" for m in msgs),
                         capture_output=True, text=True, timeout=10).stdout
    for line in out.splitlines():
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get("id") == 2:
            if "error" in d:
                kind = ((d["error"].get("data") or {}).get("kind")) or ""
                raise RuntimeError(kind or d["error"].get("message") or "error")
            return d["result"]
    raise RuntimeError("no answer from hc connect")


def nodes(doc):
    for s in doc.get("spaces") or []:
        for t in s.get("tabs") or []:
            stack = [t.get("root")]
            while stack:
                n = stack.pop()
                if not n:
                    continue
                yield n
                stack.extend(n.get("children") or [])


def edit(doc, show, hide):
    """Marks `hide` hidden and `show` shown at weight sizes so the shown one fills the slot, or returns False when a pane is missing."""
    found = set()
    for n in nodes(doc):
        if n.get("id") == show:
            n.pop("hidden", None)
            n["size"] = {"weight": 1.0}
            found.add(show)
        elif hide and n.get("id") == hide:
            n["hidden"] = True
            n["size"] = {"weight": 1.0}
            found.add(hide)
    return found == {show} | ({hide} if hide else set())


def regroup(doc, chat, term):
    """Moves `term` into a column with `chat` where `chat` sits, so a split made beside the chat keeps its own room."""
    parent = {}
    for n in nodes(doc):
        for k in n.get("children") or []:
            parent[k.get("id")] = n
    pc, pt = parent.get(chat), parent.get(term)
    if not pc or not pt:
        return False
    tnode = next(k for k in pt["children"] if k.get("id") == term)
    pt["children"] = [k for k in pt["children"] if k.get("id") != term]
    i = next(i for i, k in enumerate(pc["children"]) if k.get("id") == chat)
    cnode = pc["children"][i]
    pc["children"][i] = {"type": "column", "id": "s" + secrets.token_hex(16), "size": cnode.get("size") or {"weight": 1.0},
                         "children": [cnode, tnode]}
    return True


def bar(doc, chat, term, px):
    """Shows both panes with `chat` first at `px` tall over `term`, or returns False when either is missing."""
    if not any(chat in [k.get("id") for k in n.get("children") or []] and term in [k.get("id") for k in n.get("children") or []] for n in nodes(doc)):
        if not regroup(doc, chat, term):
            return False
    for n in nodes(doc):
        kids = n.get("children") or []
        ids = [k.get("id") for k in kids]
        if chat in ids and term in ids:
            i, j = ids.index(chat), ids.index(term)
            if i > j:
                kids[i], kids[j] = kids[j], kids[i]
            for k in kids:
                if k.get("id") == chat:
                    k.pop("hidden", None)
                    k["size"] = {"px": float(px)}
                elif k.get("id") == term:
                    k.pop("hidden", None)
                    k["size"] = {"weight": 1.0}
            return True
    return False


def drop(doc, chat, term):
    """Removes the `chat` node and shows `term` in one write, or returns False when either is missing."""
    for n in nodes(doc):
        kids = n.get("children") or []
        if any(k.get("id") == chat for k in kids):
            n["children"] = [k for k in kids if k.get("id") != chat]
            return edit(doc, term, None)
    return False


def release(doc):
    """Unhides every terminal a claude-chat pane names, so removing the mod leaves no invisible panes."""
    terms = {((n.get("content") or {}).get("props") or {}).get("terminal") for n in nodes(doc) if (n.get("content") or {}).get("mod") == "claude-chat"}
    for n in nodes(doc):
        if n.get("hidden") and (n.get("content") or {}).get("terminal") in terms:
            n.pop("hidden", None)
            n["size"] = {"weight": 1.0}
    return True


def main(argv):
    need = {"show": 4, "bar": 5, "unhide": 3, "drop": 4, "release": 2}
    if len(argv) < 2 or argv[1] not in need or len(argv) < need[argv[1]]:
        sys.stderr.write(__doc__.split(": ", 1)[1] + "\n")
        return 2
    for _ in range(6):
        r = rpc("doc.get", {"name": "herdr-app"})
        doc = r.get("value") or {}
        if argv[1] == "release":
            ok = release(doc)
        elif argv[1] == "drop":
            ok = drop(doc, argv[2], argv[3])
        elif argv[1] == "bar":
            ok = bar(doc, argv[2], argv[3], argv[4])
        else:
            ok = edit(doc, argv[2], argv[3] if argv[1] == "show" else None)
        if not ok:
            sys.stderr.write("pane not found\n")
            return 1
        try:
            rpc("doc.set", {"name": "herdr-app", "value": doc, "version": r.get("version") or 0})
            return 0
        except RuntimeError as e:
            # why: the app writes the document on every split, resize and focus; a stale version just means read again.
            if str(e) != "conflict":
                sys.stderr.write(f"{e}\n")
                return 1
    sys.stderr.write("the layout kept changing\n")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
