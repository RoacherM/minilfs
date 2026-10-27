#!/usr/bin/env python3
"""Builds the data for replay.html from a Quarry-on-minilfs run.

  python3 docs/replay/extract.py <quarry test folder> > docs/replay/data.js

Reads (read-only): the folder's git history (all refs, refs/minilfs included), the lead's Pi session
(minilfs merge/apply/subagent calls), every sub-agent transcript (role, branch, start/end, tool
calls), and PROGRESS.md headings. Times are local (the run's timezone).
"""
import glob, json, os, re, subprocess, sys
from datetime import datetime, timezone

root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".")
sessions = os.path.join(root, ".quarry-agent", "sessions")


def local(ts):
    """ISO time (Z or offset) -> epoch seconds."""
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()


def rel_path(p):
    """A tool path relative to the project folder."""
    p = str(p or "")
    return p[len(root) + 1:] if p.startswith(root + "/") else p.lstrip("./")


BASH_KINDS = [
    # git writes first (commit, merge, ...): a command that also runs `git status` is still a commit
    ("git", re.compile(r"\bgit\s+(-c\s+\S*?('[^']*'|\"[^\"]*\")?\S*\s+)*(commit|merge|add|reset|checkout|switch|stash|rebase|cherry-pick|update-ref|commit-tree)\b")),
    ("test", re.compile(r"cargo\s+(test|nextest)|quarry-accept|quarry-slt|pytest|run Q\d\d")),
    ("lint", re.compile(r"cargo\s+(clippy|fmt)")),
    ("build", re.compile(r"cargo\s+(build|check|fetch|generate-lockfile|run)")),
]


# reading the tree from bash (cat, grep, sed -n, ls, head)
SHELL_READ = re.compile(r"^(cd \S+ (&&|;) )*(cat|grep|rg|sed -n|ls|head|tail|wc|find|tree)\b")
SHELL_EDIT = re.compile(r"python3? - <<|sed -i|perl -pi|tee |> ?[\w./-]+\.(rs|toml|py|slt|md|json)\b|cat > ")
GIT_READ = re.compile(r"\bgit\s+(log|status|diff|branch|fsck|rev-parse|show|for-each-ref)\b")


def bash_kind(cmd):
    for kind, rx in BASH_KINDS:
        if rx.search(cmd):
            return kind
    if GIT_READ.search(cmd):
        return "gitread"
    if SHELL_EDIT.search(cmd):
        return "write"
    if SHELL_READ.search(cmd.strip()):
        return "read"
    return "shell"


def action(t, name, a):
    """One tool call as a replay action, or None for tools the replay does not show."""
    act = {"t": t, "tool": name}
    if name in ("write", "edit", "read"):
        act["kind"] = name
        act["path"] = rel_path(a.get("path"))
    elif name == "bash":
        cmd = str(a.get("command", ""))
        act["kind"] = bash_kind(cmd)
        act["cmd"] = re.sub(r"\s+", " ", cmd.replace(root, "."))[:160]
    elif name in ("minilfs", "minilfs_apply"):
        act["kind"] = "minilfs"
        act["cmd"] = (name + " " + json.dumps(a, ensure_ascii=False))[:120]
    elif name in ("ls", "find", "grep"):
        act["kind"] = "read"
        act["path"] = rel_path(a.get("path")) or "."
    else:
        return None
    return act


def actions_of(path):
    """Every tool call in one transcript: { t, tool, kind, path|cmd, ok }. Reads both formats: a Pi
    session (message records with toolCall / toolResult) and a pi-subagents transcript (tool_start
    with argsPayload, tool_end with isError)."""
    out, pending = [], {}
    with open(path) as fh:
        for line in fh:
            try:
                e = json.loads(line)
            except Exception:
                continue
            rt = e.get("recordType")
            if rt == "tool_start":
                try:
                    a = json.loads(e.get("argsPayload") or "{}")
                except Exception:
                    a = {}
                act = action(local(e["timestamp"]), e.get("toolName"), a)
                if act:
                    pending[e["toolCallId"]] = act
                    out.append(act)
                continue
            if rt == "tool_end":
                act = pending.pop(e.get("toolCallId"), None)
                if act:
                    act["ok"] = str(e.get("isError")) not in ("True", "true")
                continue
            m = e.get("message") or {}
            if not isinstance(m, dict):
                continue
            if e.get("type") != "message" or not e.get("timestamp"):
                continue
            t = local(e["timestamp"])
            if m.get("role") == "assistant":
                for c in m.get("content", []):
                    if c.get("type") != "toolCall":
                        continue
                    act = action(t, c.get("name"), c.get("arguments") or {})
                    if not act:
                        continue
                    pending[c["id"]] = act
                    out.append(act)
            elif m.get("role") == "toolResult" and m.get("toolCallId") in pending:
                act = pending.pop(m["toolCallId"])
                text = "".join(x.get("text", "") for x in m.get("content", []))
                act["ok"] = not m.get("isError") and not re.search(r"exit code [1-9]|Command exited with code [1-9]|error\[E\d+\]|test result: FAILED", text)
    return out


# ---- git
out = subprocess.run(["git", "-C", root, "log", "--all", "--format=%H|%h|%P|%an|%aI|%s"], capture_output=True, text=True).stdout
full_to_short = {}
commits = []
for line in out.splitlines():
    full, short, parents, author, date, subject = line.split("|", 5)
    full_to_short[full] = short
    commits.append({"id": short, "full": full, "parents": parents.split(), "author": author, "t": local(date), "subject": subject})
for c in commits:
    c["parents"] = [full_to_short.get(p, p[:7]) for p in c["parents"]]
    del c["full"]
refs = {}
for line in subprocess.run(["git", "-C", root, "for-each-ref", "--format=%(refname)|%(objectname:short)", "refs/heads", "refs/minilfs"], capture_output=True, text=True).stdout.splitlines():
    name, oid = line.split("|")
    refs[name] = oid

# ---- sub-agent transcripts: who, when, which branch
workers = []
for f in sorted(glob.glob(os.path.join(sessions, "*", "subagent-artifacts", "*_transcript.jsonl"))):
    ts, role, branch, tools, gitc = [], None, None, 0, 0
    with open(f) as fh:
        for line in fh:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("timestamp"):
                ts.append(local(e["timestamp"]))
            if role is None:
                m = re.search(r"You are worker (P[123]|X[12]|S[12]|C)\b", line)
                if m:
                    role = m.group(1)
            for m in re.finditer(r"branch: (s-[0-9a-f]{10}-\d+)", line):
                branch = m.group(1)
            tools += line.count('"type":"toolCall"')
            gitc += len(re.findall(r"git commit", line))
    if ts and role:
        acts = actions_of(f)
        files = {}
        for a in acts:
            if a["kind"] in ("write", "edit") and a.get("path"):
                files[a["path"]] = files.get(a["path"], 0) + 1
        workers.append({"role": role, "start": ts[0], "end": ts[-1], "branch": branch, "tools": tools, "gitCommits": gitc,
                        "actions": acts, "files": files})

# ---- lead session: minilfs events, and the lead's own actions
events = []
lead_files = [p for p in glob.glob(os.path.join(sessions, "*", "*.jsonl"))]
lead_actions = []
for f in lead_files:
    lead_actions += actions_of(f)
for f in lead_files:
    calls = {}
    with open(f) as fh:
        for line in fh:
            try:
                e = json.loads(line)
            except Exception:
                continue
            m = e.get("message") or {}
            if e.get("type") != "message":
                continue
            if m.get("role") == "assistant":
                for c in m.get("content", []):
                    if c.get("type") == "toolCall" and c.get("name") in ("minilfs", "minilfs_apply", "subagent"):
                        calls[c["id"]] = (c["name"], c.get("arguments") or {})
            if m.get("role") == "toolResult" and m.get("toolCallId") in calls:
                name, args = calls.pop(m["toolCallId"])
                text = "".join(x.get("text", "") for x in m.get("content", []))
                t = local(e["timestamp"])
                if name == "minilfs_apply":
                    files = re.search(r"Applied (\d+) file", text)
                    git = re.search(r"Git: (\.git: [^\n]*)", text)
                    events.append({"t": t, "kind": "apply", "files": int(files.group(1)) if files else 0, "git": git.group(1)[:140] if git else ""})
                elif name == "minilfs" and args.get("action") == "merge":
                    conflict = text.startswith("CONFLICT") or "CONFLICT" in text[:80]
                    gitnote = "both sides ran git" in text
                    events.append({"t": t, "kind": "merge", "branch": args.get("branch"), "conflict": conflict, "gitNote": gitnote})
                elif name == "subagent" and args.get("async") and args.get("task"):
                    m2 = re.search(r"You are worker (P[123]|X[12]|S[12]|C)\b", args["task"])
                    events.append({"t": t, "kind": "spawn", "role": m2.group(1) if m2 else "?"})

# ---- rounds from PROGRESS.md (headings only)
rounds = []
try:
    for line in open(os.path.join(root, "PROGRESS.md")):
        if line.startswith("## "):
            rounds.append(line[3:].strip())
except FileNotFoundError:
    pass

run_dirs = sorted(glob.glob(os.path.join(root, "runs", "*", "started")))
started = float(open(run_dirs[-1]).read().strip()) if run_dirs else min(c["t"] for c in commits)
ended_f = os.path.join(os.path.dirname(run_dirs[-1]), "ended") if run_dirs else ""
ended = float(open(ended_f).read().strip()) if ended_f and os.path.exists(ended_f) else None

data = {
    "generatedAt": datetime.now(timezone.utc).timestamp(),
    "started": started,
    "ended": ended,
    "commits": sorted(commits, key=lambda c: c["t"]),
    "refs": refs,
    "workers": sorted(workers, key=lambda w: w["start"]),
    "events": sorted(events, key=lambda e: e["t"]),
    "rounds": rounds,
    "lead": {"actions": sorted(lead_actions, key=lambda a: a["t"])},
}
print("window.REPLAY = " + json.dumps(data, ensure_ascii=False) + ";")
