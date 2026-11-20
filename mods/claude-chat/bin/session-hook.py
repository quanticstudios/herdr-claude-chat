#!/usr/bin/env python3
"""Claude Code SessionStart hook that records which transcript a herdr terminal writes."""
import json, os, sys, time

# invariant: prints nothing and exits 0, since SessionStart stdout reaches Claude's context.
try:
    term = os.environ.get("HC_TERMINAL_ID")
    if term and "/" not in term:
        hook = json.load(sys.stdin)
        core = os.environ.get("HC_SESSION") or "default"
        d = os.path.join(os.path.expanduser("~"), ".local", "state", "herdr-claude-chat", "bindings", core)
        os.makedirs(d, exist_ok=True)
        rec = {"session_id": hook.get("session_id"), "transcript_path": hook.get("transcript_path"),
               "source": hook.get("source"), "cwd": hook.get("cwd"), "at": int(time.time() * 1000), "pid": os.getppid()}
        tmp = os.path.join(d, ".%s.%d" % (term, os.getpid()))
        with open(tmp, "w") as f:
            json.dump(rec, f)
        os.replace(tmp, os.path.join(d, term + ".json"))
except Exception:
    pass
sys.exit(0)
