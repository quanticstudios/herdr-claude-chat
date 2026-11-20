#!/usr/bin/env python3
"""Adds or removes the claude-chat Claude Code hooks in settings.json, idempotently."""
import json, os, sys

USAGE = "usage: install-hook.py [--uninstall] [--settings <path>]  (default: $CLAUDE_CONFIG_DIR or ~/.claude)\n"


def main(argv):
    args = argv[1:]
    if "-h" in args or "--help" in args:
        sys.stdout.write(USAGE)
        return 0
    uninstall = "--uninstall" in args
    settings = args[args.index("--settings") + 1] if "--settings" in args else os.path.join(
        os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"), "settings.json")
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    wanted = [("SessionStart", {"type": "command", "command": "python3 -I '%s'" % os.path.join(root, "bin", "session-hook.py"), "timeout": 5})]
    hooks_dir = os.path.join(root, "hooks")
    # why: every hooks/<Event>-<name> script becomes a hook for that event; bash runs it even when a copy lost its exec bit.
    for name in sorted(os.listdir(hooks_dir)) if os.path.isdir(hooks_dir) else []:
        wanted.append((name.split("-", 1)[0], {"type": "command", "command": "bash '%s'" % os.path.join(hooks_dir, name)}))
    try:
        with open(settings) as f:
            text = f.read()
        data = json.loads(text) if text.strip() else {}
    except FileNotFoundError:
        text, data = None, {}
    except ValueError as e:
        sys.stderr.write("%s is not valid JSON (%s); left it alone\n" % (settings, e))
        return 1
    hooks = data.setdefault("hooks", {})
    cmd = lambda h: h.get("command", "")
    mine = {h["command"] for _, h in wanted}
    ours = lambda h: cmd(h) in mine or "/claude-chat/hooks/" in cmd(h) or ("claude-chat" in cmd(h) and cmd(h).endswith("session-hook.py'"))
    for event in list(hooks):
        for g in hooks[event]:
            g["hooks"] = [h for h in g.get("hooks", []) if not ours(h)]
        hooks[event] = [g for g in hooks[event] if g.get("hooks")]
    if not uninstall:
        for event, h in wanted:
            hooks.setdefault(event, []).append({"hooks": [h]})
    for event in [e for e in hooks if not hooks[e]]:
        del hooks[event]
    if not hooks:
        del data["hooks"]
    new = json.dumps(data, indent=2) + "\n"
    if new == text:
        print("unchanged: %s" % settings)
        return 0
    os.makedirs(os.path.dirname(os.path.abspath(settings)), exist_ok=True)
    tmp = settings + ".claude-chat.tmp"
    with open(tmp, "w") as f:
        f.write(new)
    os.replace(tmp, settings)
    print("%s: %s" % ("removed" if uninstall else "installed", settings))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
