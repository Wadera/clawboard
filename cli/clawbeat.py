#!/usr/bin/env python3
"""clawbeat - Heartbeat watchdog CLI for OpenClaw orchestration.

Checks system state and outputs JSON telling the watchdog what to do.
Run periodically (e.g., every 15 minutes); outputs HEARTBEAT_OK or WAKE commands.

Usage:
    python3 cli/clawbeat.py           # normal run
    python3 cli/clawbeat.py --verbose # debug output to stderr
    python3 cli/clawbeat.py --dry-run # no side effects (skips dedup)

Output (JSON to stdout, single line):
    {"action": "HEARTBEAT_OK", "reason": "Active sub-agent on task abc123"}
    {"action": "WAKE", "message": "ORCHESTRATE: ...", "reason": "1 stuck task",
     "task_id": "abc123", "attempt": 1, "recommended_action": "review",
     "wake_type": "review_needed"}

Features:
- Lifecycle-aware: understands 6-state subtask lifecycle
  (empty → in_progress → review → completed/blocked/skipped)
- Wake type differentiation: spawn_agent, review_needed, stale_agent,
  complete_task, escalate_human
- Dependency awareness: skips tasks with unmet dependencies
- Blocked subtask detection: suppresses wakes, flags for human
- Per-wake-type dedup windows
- Context gathering via clawboard CLI
- Retry tracking with escalation
- Circuit breaker for agent spawns
- Rich, multi-paragraph prompts with full context
"""

import sys
import os
import json
import argparse
import subprocess
from pathlib import Path
from datetime import datetime, timedelta, timezone

# ─── Config ───

# API configuration - override with environment variables
API_BASE = os.getenv("CLAWBOARD_API_URL", "http://localhost:3001")
TOKEN_ENV = os.getenv("CLAWBOARD_TOKEN", "")
CONFIG_DIR = Path(os.getenv("CLAWBOARD_CONFIG_DIR", "~/.config/clawboard")).expanduser()
TOKEN_FILE = CONFIG_DIR / "config.json"

SESSIONS_DIR = Path("~/.openclaw/agents/main/sessions/").expanduser()
ORCHESTRATION_LOG = Path("/tmp/orchestration-actions.log")
RETRY_TRACKER_FILE = Path("/tmp/clawbeat-retries.json")

# Timing thresholds (in minutes)
ACTIVE_AGENT_THRESHOLD = 9
PROCESS_STALE_THRESHOLD = 9

# Legacy dedup window (fallback if wake_type not in DEDUP_WINDOWS)
DEDUP_WINDOW_MINUTES = 9

# Retry escalation threshold
ESCALATION_THRESHOLD = 3

# Circuit breaker for agent spawns (P0)
MAX_SPAWNS_PER_HOUR = 3
SPAWN_COOLDOWN_MINUTES = 15

# Log rotation settings (P1)
MAX_LOG_LINES = 500
KEEP_LOG_LINES = 200
RETRY_TRACKER_MAX_AGE_HOURS = 24

# ─── Wake Types & Dedup Windows ───

WAKE_TYPE_SPAWN = "spawn_agent"
WAKE_TYPE_REVIEW = "review_needed"
WAKE_TYPE_STALE = "stale_agent"
WAKE_TYPE_COMPLETE = "complete_task"
WAKE_TYPE_ESCALATE = "escalate_human"

# Per-wake-type dedup windows (minutes). None = suppress until status changes.
DEDUP_WINDOWS = {
    WAKE_TYPE_SPAWN: 10,       # 10 min
    WAKE_TYPE_REVIEW: 19,      # 19 min (~2 heartbeat ticks)
    WAKE_TYPE_STALE: 9,        # 9 min
    WAKE_TYPE_COMPLETE: 9,     # 9 min
    WAKE_TYPE_ESCALATE: None,  # Suppress until unblocked
}

# ─── Globals ───

VERBOSE = False
DRY_RUN = False


def log(msg: str) -> None:
    """Log to stderr if verbose mode is enabled."""
    if VERBOSE:
        print(f"[clawbeat] {msg}", file=sys.stderr)


def output(action: str, reason: str, message: str = None,
           blocked_tasks: list = None) -> None:
    """Output JSON result to stdout and exit."""
    result = {"action": action, "reason": reason}
    if message:
        result["message"] = message
    if blocked_tasks:
        result["blocked_tasks"] = [
            {"id": t.get("id", "")[:8], "title": t.get("title", "")}
            for t in blocked_tasks
        ]
    print(json.dumps(result))
    sys.exit(0)


def output_wake(reason: str, message: str, task_id: str = None,
                attempt: int = 1, recommended_action: str = "review",
                wake_type: str = None) -> None:
    """Output WAKE JSON with extended fields and exit.

    Args:
        reason: Short description of why we're waking
        message: Full multi-paragraph prompt with context
        task_id: Task ID (first 8 chars stored)
        attempt: Retry attempt number
        recommended_action: One of: review, spawn_agent, restart_process,
            escalate, escalate_human
        wake_type: One of: spawn_agent, review_needed, stale_agent,
            complete_task, escalate_human
    """
    result = {
        "action": "WAKE",
        "reason": reason,
        "message": message,
    }
    if task_id:
        result["task_id"] = task_id[:8]
        # Write to dedup log
        if not DRY_RUN:
            try:
                with open(ORCHESTRATION_LOG, "a") as f:
                    ts = datetime.now(timezone.utc).strftime("%H:%M")
                    wt = wake_type or "unknown"
                    f.write(f"{ts} | {task_id[:8]} | WAKE sent by clawbeat ({wt})\n")
                log(f"Wrote dedup entry for {task_id[:8]} ({wt})")
            except OSError as e:
                log(f"Failed to write dedup log: {e}")
    result["attempt"] = attempt
    result["recommended_action"] = recommended_action
    if wake_type:
        result["wake_type"] = wake_type
    print(json.dumps(result))
    sys.exit(0)


# ─── API Helpers ───

def get_api_token() -> str:
    """Read API token from config file or environment variable."""
    if TOKEN_ENV:
        return TOKEN_ENV

    # Try config.json (clawbeat's primary format: {"api_token": "..."})
    try:
        with open(TOKEN_FILE) as f:
            config = json.load(f)
        token = config.get("api_token") or config.get("token")
        if token:
            return token
    except (FileNotFoundError, json.JSONDecodeError, KeyError) as e:
        log(f"Failed to read config.json: {e}")

    # Fallback: token.json (clawboard CLI's format: {"token": "...", "expires_at": ...})
    token_json = CONFIG_DIR / "token.json"
    try:
        with open(token_json) as f:
            cached = json.load(f)
        token = cached.get("token", "")
        if token:
            return token
    except (FileNotFoundError, json.JSONDecodeError, KeyError) as e:
        log(f"Failed to read token.json: {e}")

    return ""


def api_get(path: str) -> dict:
    """Make GET request to ClawBoard API. Returns empty dict on failure."""
    token = get_api_token()
    if not token:
        log("No API token available")
        return {}

    url = f"{API_BASE}{path}"
    log(f"GET {url}")

    try:
        import requests
        headers = {"Authorization": f"Bearer {token}"}
        resp = requests.get(url, headers=headers, timeout=10)
        resp.raise_for_status()
        return resp.json()
    except ImportError:
        pass
    except Exception as e:
        log(f"requests failed: {e}")
        return {}

    try:
        import urllib.request
        import urllib.error

        req = urllib.request.Request(url)
        req.add_header("Authorization", f"Bearer {token}")
        req.add_header("Content-Type", "application/json")

        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        log(f"urllib failed: {e}")
        return {}


# ─── Retry Tracking ───

def load_retry_tracker() -> dict:
    """Load retry tracker from file. Returns empty dict on failure."""
    if not RETRY_TRACKER_FILE.exists():
        return {}
    try:
        with open(RETRY_TRACKER_FILE) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        log(f"Failed to load retry tracker: {e}")
        return {}


def save_retry_tracker(data: dict) -> None:
    """Save retry tracker to file."""
    if DRY_RUN:
        log("Dry run - skipping retry tracker save")
        return
    try:
        with open(RETRY_TRACKER_FILE, 'w') as f:
            json.dump(data, f, indent=2)
    except OSError as e:
        log(f"Failed to save retry tracker: {e}")


def get_retry_count(task_id: str) -> tuple[int, list[str]]:
    """Get retry count and history for a task."""
    tracker = load_retry_tracker()
    short_id = task_id[:8]

    if short_id in tracker:
        entry = tracker[short_id]
        return entry.get("count", 0), entry.get("history", [])

    return 0, []


def record_retry(task_id: str, action: str) -> int:
    """Increment retry counter and add action to history. Returns new count."""
    tracker = load_retry_tracker()
    short_id = task_id[:8]
    now = datetime.now(timezone.utc).isoformat()

    if short_id in tracker:
        entry = tracker[short_id]
        entry["count"] = entry.get("count", 0) + 1
        entry["last"] = now
        entry["history"] = entry.get("history", [])[-9:] + [action]
    else:
        tracker[short_id] = {
            "count": 1,
            "first": now,
            "last": now,
            "history": [action]
        }

    save_retry_tracker(tracker)
    return tracker[short_id]["count"]


def clear_retry_count(task_id: str) -> None:
    """Clear retry count for a task (called when task completes)."""
    tracker = load_retry_tracker()
    short_id = task_id[:8]

    if short_id in tracker:
        del tracker[short_id]
        save_retry_tracker(tracker)
        log(f"Cleared retry count for {short_id}")


# ─── Circuit Breaker (P0) ───

def record_spawn(task_id: str) -> None:
    """Record a spawn attempt for circuit breaker tracking."""
    tracker = load_retry_tracker()
    short_id = task_id[:8]
    now = datetime.now(timezone.utc).isoformat()

    if short_id not in tracker:
        tracker[short_id] = {
            "count": 0, "first": now, "last": now,
            "history": [], "spawn_history": []
        }

    entry = tracker[short_id]
    if "spawn_history" not in entry:
        entry["spawn_history"] = []

    entry["spawn_history"].append(now)
    entry["last"] = now

    cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
    entry["spawn_history"] = [
        ts for ts in entry["spawn_history"]
        if _parse_iso_timestamp(ts) and _parse_iso_timestamp(ts) > cutoff
    ]

    save_retry_tracker(tracker)
    log(f"Recorded spawn for {short_id}, total this hour: {len(entry['spawn_history'])}")


def _parse_iso_timestamp(ts_str: str) -> datetime | None:
    """Parse ISO timestamp string to datetime. Returns None on failure."""
    try:
        if ts_str.endswith("Z"):
            return datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        dt = datetime.fromisoformat(ts_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None


def check_circuit_breaker(task_id: str) -> tuple[bool, str]:
    """Check if circuit breaker should block spawns for this task.

    Returns (should_block, reason).
    """
    tracker = load_retry_tracker()
    short_id = task_id[:8]

    if short_id not in tracker:
        return False, ""

    entry = tracker[short_id]
    spawn_history = entry.get("spawn_history", [])

    if not spawn_history:
        return False, ""

    cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
    recent_spawns = [
        ts for ts in spawn_history
        if _parse_iso_timestamp(ts) and _parse_iso_timestamp(ts) > cutoff
    ]

    if len(recent_spawns) >= MAX_SPAWNS_PER_HOUR:
        return True, (
            f"Circuit breaker tripped: {len(recent_spawns)} spawns in the last hour "
            f"(max {MAX_SPAWNS_PER_HOUR}). Task needs human review."
        )

    if recent_spawns:
        last_spawn = _parse_iso_timestamp(recent_spawns[-1])
        if last_spawn:
            cooldown_cutoff = datetime.now(timezone.utc) - timedelta(
                minutes=SPAWN_COOLDOWN_MINUTES)
            if last_spawn > cooldown_cutoff:
                minutes_ago = (datetime.now(timezone.utc) - last_spawn).total_seconds() / 60
                return True, (
                    f"Spawn cooldown active: last spawn was {minutes_ago:.0f} minutes ago "
                    f"(cooldown: {SPAWN_COOLDOWN_MINUTES} min)"
                )

    return False, ""


def get_spawn_count_last_hour(task_id: str) -> int:
    """Get the number of spawns for a task in the last hour."""
    tracker = load_retry_tracker()
    short_id = task_id[:8]

    if short_id not in tracker:
        return 0

    spawn_history = tracker[short_id].get("spawn_history", [])
    cutoff = datetime.now(timezone.utc) - timedelta(hours=1)

    return len([
        ts for ts in spawn_history
        if _parse_iso_timestamp(ts) and _parse_iso_timestamp(ts) > cutoff
    ])


# ─── Subtask Lifecycle Analysis ───

def analyze_subtask_states(subtasks: list[dict]) -> dict:
    """Analyze subtask states and return a lifecycle summary.

    Returns dict with:
        has_blocked: bool — any subtask in "blocked" state
        blocked_subtasks: list — subtasks that are blocked (with index)
        has_review: bool — any subtask in "review" state
        review_subtasks: list — subtasks in review (with index)
        has_in_progress: bool — any subtask in "in_progress" state
        all_done: bool — all subtasks completed or skipped
        all_empty: bool — all subtasks in "empty" state (no work started)
        counts: dict — count per status
        total: int — total subtask count
    """
    counts = {}
    blocked_subtasks = []
    review_subtasks = []

    for i, st in enumerate(subtasks):
        status = st.get("status", "empty")
        counts[status] = counts.get(status, 0) + 1
        if status == "blocked":
            blocked_subtasks.append({"index": i, **st})
        elif status == "review":
            review_subtasks.append({"index": i, **st})

    total = len(subtasks)
    done_count = counts.get("completed", 0) + counts.get("skipped", 0)

    return {
        "has_blocked": len(blocked_subtasks) > 0,
        "blocked_subtasks": blocked_subtasks,
        "has_review": len(review_subtasks) > 0,
        "review_subtasks": review_subtasks,
        "has_in_progress": counts.get("in_progress", 0) > 0,
        "all_done": total > 0 and done_count == total,
        "all_empty": total > 0 and counts.get("empty", 0) == total,
        "counts": counts,
        "total": total,
    }


# ─── Dependency Checking ───

def check_task_dependencies(task: dict) -> tuple[bool, list[str]]:
    """Check if a task has unmet dependencies.

    Looks at task's dependsOn/blockedBy fields. If the list endpoint
    doesn't include dependency details, fetches the full task.

    Returns (has_unmet_deps, list_of_unmet_dep_ids).
    """
    task_id = task.get("id", "")

    # Check dependsOn (list of task IDs or objects)
    depends_on = task.get("dependsOn", []) or []
    blocked_by = task.get("blockedBy", []) or []

    dep_ids = []
    for dep in depends_on + blocked_by:
        if isinstance(dep, str):
            dep_ids.append(dep)
        elif isinstance(dep, dict):
            dep_ids.append(dep.get("id", dep.get("taskId", "")))

    if not dep_ids:
        log(f"Task {task_id[:8]} has no dependencies")
        return False, []

    # Check each dependency's status
    unmet = []
    for dep_id in dep_ids:
        if not dep_id:
            continue
        dep_task = api_get(f"/tasks/{dep_id}")
        dep_data = dep_task.get("task", dep_task)
        dep_status = dep_data.get("status", "")

        if dep_status not in ("completed", "archived"):
            unmet.append(dep_id[:8])
            log(f"Unmet dependency: {dep_id[:8]} (status: {dep_status})")

    return len(unmet) > 0, unmet


# ─── Context Gathering ───

def run_clawboard_command(args: list[str]) -> tuple[bool, str]:
    """Run clawboard CLI command and return (success, output)."""
    cmd = ["python3", "cli/clawboard"] + args
    log(f"Running: {' '.join(cmd)}")

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
            cwd=str(Path(__file__).resolve().parent.parent)
        )
        if result.returncode == 0:
            return True, result.stdout.strip()
        else:
            log(f"clawboard failed: {result.stderr}")
            return False, result.stderr.strip()
    except subprocess.TimeoutExpired:
        log("clawboard command timed out")
        return False, "Command timed out"
    except Exception as e:
        log(f"Failed to run clawboard: {e}")
        return False, str(e)


def gather_task_context(task_id: str) -> dict:
    """Fetch rich context for a task using clawboard CLI + files.

    Returns dict with:
        task_details: Full task info from clawboard get
        subtasks: List of subtasks with status
        notes: Task notes
        project_info: Project context if available
        process_state: Process status file contents
        previous_errors: Errors from recent session logs
    """
    context = {
        "task_details": None,
        "subtasks": [],
        "notes": "",
        "project_info": None,
        "process_state": None,
        "previous_errors": []
    }

    short_id = task_id[:8]

    # 1. Get task details via clawboard
    success, cli_output = run_clawboard_command(["get", short_id])
    if success:
        context["task_details"] = cli_output
        subtasks = []
        in_subtasks = False
        for line in cli_output.split('\n'):
            if 'Subtasks:' in line:
                in_subtasks = True
                continue
            if in_subtasks and line.strip().startswith(
                    ('⬜', '🔄', '✅', '🚫', '⏭', '🔵', '-', '*', '[')):
                subtasks.append(line.strip())
            elif in_subtasks and line.strip() and not line.startswith(' '):
                in_subtasks = False
        context["subtasks"] = subtasks
    else:
        log(f"Failed to get task details: {cli_output}")

    # 2. Get project context
    if context["task_details"]:
        for line in context["task_details"].split('\n'):
            if 'Project:' in line:
                project = line.split('Project:')[-1].strip()
                if project and project != '—':
                    success, proj_output = run_clawboard_command([
                        "project", "context", project, "--role", "orchestrator"
                    ])
                    if success:
                        context["project_info"] = proj_output
                break

    # 3. Read process status file
    status_file = get_task_status_file(task_id)
    if status_file.exists():
        try:
            with open(status_file) as f:
                context["process_state"] = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            log(f"Failed to read process status: {e}")

    # 4. Look for recent errors in session logs
    if SESSIONS_DIR.exists():
        try:
            recent_sessions = sorted(
                [f for f in SESSIONS_DIR.iterdir() if f.suffix == ".jsonl"],
                key=lambda x: x.stat().st_mtime,
                reverse=True
            )[:3]

            errors = []
            for session_file in recent_sessions:
                try:
                    with open(session_file) as f:
                        for line in f:
                            if short_id in line and (
                                    'error' in line.lower()
                                    or 'failed' in line.lower()):
                                errors.append(line.strip()[:200])
                except OSError:
                    pass
            context["previous_errors"] = errors[:5]
        except OSError as e:
            log(f"Failed to scan session logs: {e}")

    return context


# ─── Prompt Builders ───

def build_escalation_summary(task_id: str, retry_count: int,
                             context: dict) -> list[str]:
    """Build a structured escalation summary."""
    short_id = task_id[:8]
    lines = [
        "### 🚨 ESCALATE TO HUMAN REQUIRED",
        "",
        f"**This task has failed {retry_count} times without resolution.**",
        "",
        "**What's stuck:**",
    ]

    tracker = load_retry_tracker()
    if short_id in tracker:
        history = tracker[short_id].get("history", [])
        if history:
            failure_counts = {}
            for h in history:
                failure_counts[h] = failure_counts.get(h, 0) + 1
            for failure, count in sorted(failure_counts.items(),
                                         key=lambda x: -x[1]):
                lines.append(f"  - {failure}: {count}x")

    lines.extend([
        "",
        "**Why automated retry won't help:**",
        "  - Pattern suggests structural issue, not transient failure",
        "  - Same errors recurring indicates need for human decision",
        "",
        "**Recommended human actions:**",
        f"  1. Review task details: `clawboard get {short_id}`",
        f"  2. Check logs for root cause",
        f"  3. Either fix the underlying issue OR mark blocked: "
        f"`clawboard update {short_id} --tags blocked-human`",
        "",
    ])

    return lines


def build_spawn_prompt(task: dict, context: dict) -> str:
    """Build spawn-ready prompt for new tasks.

    Includes full task details, subtasks, project context, and
    CLAWBOARD_AGENT=1 env var instruction for permission enforcement.
    """
    task_id = task.get("id", "")[:8]
    task_title = task.get("title", "Unknown")
    thinking = task.get("thinking", "low")
    priority = task.get("priority", "normal")

    lines = [
        f"## ORCHESTRATE: Spawn Agent for Task [{task_id}]",
        "",
        f"**Task:** {task_title}",
        f"**Priority:** {priority}",
        f"**Thinking Level:** {thinking}",
        f"**Wake Type:** spawn_agent",
        "",
    ]

    # Task details
    if context.get("task_details"):
        lines.extend([
            "### Task Details",
            "```",
            context["task_details"][:1500],
            "```",
            "",
        ])

    # Project context
    if context.get("project_info"):
        lines.extend([
            "### Project Context",
            "```",
            context["project_info"][:1000],
            "```",
            "",
        ])

    # Subtasks
    if context.get("subtasks"):
        lines.extend(["### Subtasks", ""])
        for i, subtask in enumerate(context["subtasks"]):
            lines.append(f"{i}. {subtask}")
        lines.append("")

    # Spawn instructions with CLAWBOARD_AGENT=1
    lines.extend([
        "### ACTION REQUIRED",
        "",
        "**1. Set task to in-progress:**",
        "```bash",
        f"clawboard move {task_id} in-progress",
        "```",
        "",
        "**2. Get agent spawn prompt:**",
        "```bash",
        f"clawboard spawn {task_id}",
        "```",
        "",
        "**3. Spawn agent with CLAWBOARD_AGENT=1:**",
        "```python",
        f"sessions_spawn(",
        f'    label="{task_id}-agent",',
        f'    task="[paste prompt from clawboard spawn]",',
        f'    thinking="{thinking}"',
        f")",
        "```",
        "",
        "**⚠️ IMPORTANT:** The spawn prompt MUST include:",
        "```",
        "export CLAWBOARD_AGENT=1",
        "```",
        "This restricts the agent to only set subtasks to in_progress/review.",
        "Agents CANNOT mark completed/blocked/skipped.",
        "",
        "**4. Log your action:**",
        "```bash",
        f'echo "$(date -u +%H:%M) | {task_id} | Spawned agent" '
        f">> /tmp/orchestration-actions.log",
        "```",
    ])

    return "\n".join(lines)


def build_review_prompt(task: dict, context: dict,
                        subtask_analysis: dict) -> str:
    """Build review prompt for tasks with subtasks in review state.

    Orchestrator should check code, git commits, browser test, then
    approve/reject/block each subtask.
    """
    task_id = task.get("id", "")[:8]
    task_title = task.get("title", "Unknown")
    review_subtasks = subtask_analysis.get("review_subtasks", [])
    counts = subtask_analysis.get("counts", {})

    lines = [
        f"## ORCHESTRATE: Review Needed for Task [{task_id}]",
        "",
        f"**Task:** {task_title}",
        f"**Wake Type:** review_needed",
        f"**Status Summary:** "
        f"{counts.get('review', 0)} in review, "
        f"{counts.get('completed', 0)} completed, "
        f"{counts.get('empty', 0)} not started, "
        f"{counts.get('in_progress', 0)} in progress",
        "",
    ]

    # Task details
    if context.get("task_details"):
        lines.extend([
            "### Task Details",
            "```",
            context["task_details"][:1500],
            "```",
            "",
        ])

    # Subtasks needing review
    lines.extend([
        "### Subtasks Awaiting Review",
        "",
    ])
    for st in review_subtasks:
        idx = st.get("index", "?")
        text = st.get("text", "Unknown subtask")
        lines.append(f"  🔄 **[{idx}]** {text}")
    lines.append("")

    # All subtasks status
    if context.get("subtasks"):
        lines.extend(["### All Subtasks", ""])
        for i, subtask in enumerate(context["subtasks"]):
            lines.append(f"  {i}. {subtask}")
        lines.append("")

    # Review instructions
    lines.extend([
        "### ACTION REQUIRED",
        "",
        "**1. Verify the work:**",
        "```bash",
        f"clawboard get {task_id} -v",
        "```",
        "",
        "**2. Check git commits:**",
        "```bash",
        "cd /path/to/repo && git log --oneline -10",
        "```",
        "",
        "**3. Browser verification:**",
        "Navigate to the dev site and visually verify changes work.",
        "",
        "**4. For EACH subtask in review:**",
        "",
        f"  - ✅ Approve: `clawboard approve-subtask {task_id} INDEX`",
        f"  - ❌ Reject:  `clawboard reject-subtask {task_id} INDEX "
        f"--note \"Reason\"`",
        f"  - 🚫 Block:   `clawboard block-subtask {task_id} INDEX "
        f"--reason \"Why blocked\"`",
        "",
        "**5. After all subtasks reviewed:**",
        f"  - If all approved: `clawboard move {task_id} completed`",
        f"  - If rejected: task stays in-progress, respawn agent with fix "
        f"instructions",
        "",
        "**6. Log your action:**",
        "```bash",
        f'echo "$(date -u +%H:%M) | {task_id} | Reviewed — '
        f'approved/rejected" >> /tmp/orchestration-actions.log',
        "```",
    ])

    return "\n".join(lines)


def build_stale_agent_prompt(task: dict, context: dict,
                             retry_count: int) -> str:
    """Build prompt for in-progress tasks with dead/stale agent sessions.

    Orchestrator should investigate and respawn or escalate.
    """
    task_id = task.get("id", "")[:8]
    task_title = task.get("title", "Unknown")

    lines = [
        f"## ORCHESTRATE: Stale Agent for Task [{task_id}]",
        "",
        f"**Task:** {task_title}",
        f"**Wake Type:** stale_agent",
        f"**Attempt:** {retry_count + 1}",
        "",
    ]

    # Escalation warning
    if retry_count >= ESCALATION_THRESHOLD:
        lines.extend(build_escalation_summary(task_id, retry_count, context))

    # Process state
    if context.get("process_state"):
        state = context["process_state"]
        lines.extend([
            "### Process State",
            f"- **Running:** {state.get('running', 'unknown')}",
            f"- **PID:** {state.get('pid', 'N/A')}",
            f"- **Last Updated:** {state.get('updated', 'N/A')}",
        ])
        if state.get("current"):
            lines.append(f"- **Current Step:** {state.get('current')}")
        if state.get("error"):
            lines.append(f"- **Error:** {state.get('error')}")
        lines.append("")

    # Task details
    if context.get("task_details"):
        lines.extend([
            "### Task Details",
            "```",
            context["task_details"][:1000],
            "```",
            "",
        ])

    # Action instructions
    lines.extend([
        "### ACTION REQUIRED",
        "",
        "**1. Check what happened:**",
        "```bash",
        f"cat /tmp/task-{task_id}-status.json 2>/dev/null",
        f"ps -ef | grep -E '{task_id}' | grep -v grep",
        "```",
        "",
        "**2. Check session activity:**",
        "```bash",
        f"ls -lt ~/.openclaw/agents/main/sessions/ | head -5",
        "```",
        "",
        "**3. Decide next action:**",
        "",
    ])

    if retry_count < ESCALATION_THRESHOLD:
        lines.extend([
            f"- **If finished:** `clawboard move {task_id} completed`",
            f"- **If failed but fixable:** Respawn agent with fix instructions",
            f"- **If needs human help:** "
            f"`clawboard update {task_id} --tags blocked-human`",
            "",
        ])
    else:
        lines.extend([
            f"⚠️ **This task has stalled {retry_count} times.**",
            f"- **Consider escalating to Wadera**",
            f"- **Or block it:** "
            f"`clawboard update {task_id} --tags blocked-human`",
            "",
        ])

    lines.extend([
        "**Log your action:**",
        "```bash",
        f'echo "$(date -u +%H:%M) | {task_id} | ACTION" '
        f">> /tmp/orchestration-actions.log",
        "```",
    ])

    # Previous errors
    if context.get("previous_errors"):
        lines.extend(["", "### Previous Errors", "```"])
        for err in context["previous_errors"][:3]:
            lines.append(err[:150])
        lines.append("```")

    return "\n".join(lines)


def build_complete_task_prompt(task: dict, context: dict,
                               subtask_analysis: dict) -> str:
    """Build prompt for tasks where all subtasks are completed/skipped.

    Orchestrator should move task to completed.
    """
    task_id = task.get("id", "")[:8]
    task_title = task.get("title", "Unknown")
    counts = subtask_analysis.get("counts", {})

    lines = [
        f"## ORCHESTRATE: All Subtasks Done — Complete Task [{task_id}]",
        "",
        f"**Task:** {task_title}",
        f"**Wake Type:** complete_task",
        f"**Subtask Summary:** "
        f"{counts.get('completed', 0)} completed, "
        f"{counts.get('skipped', 0)} skipped",
        "",
    ]

    # Task details (brief)
    if context.get("task_details"):
        lines.extend([
            "### Task Details",
            "```",
            context["task_details"][:800],
            "```",
            "",
        ])

    # Subtask list
    if context.get("subtasks"):
        lines.extend(["### Subtasks (all done)", ""])
        for i, subtask in enumerate(context["subtasks"]):
            lines.append(f"  {i}. {subtask}")
        lines.append("")

    lines.extend([
        "### ACTION REQUIRED",
        "",
        "All subtasks are completed or skipped. Move the task to completed:",
        "",
        "```bash",
        f"clawboard move {task_id} completed "
        f"--notes \"All subtasks done — auto-detected by clawbeat\"",
        "```",
        "",
        "**Log your action:**",
        "```bash",
        f'echo "$(date -u +%H:%M) | {task_id} | Completed — '
        f'all subtasks done" >> /tmp/orchestration-actions.log',
        "```",
    ])

    return "\n".join(lines)


def build_escalate_human_prompt(task: dict, context: dict,
                                subtask_analysis: dict) -> str:
    """Build escalation prompt for tasks with blocked subtasks.

    Includes Discord notification flag and suppresses future wakes.
    """
    task_id = task.get("id", "")[:8]
    task_title = task.get("title", "Unknown")
    blocked = subtask_analysis.get("blocked_subtasks", [])

    lines = [
        f"## 🚨 ESCALATE: Blocked Subtasks in Task [{task_id}]",
        "",
        f"**Task:** {task_title}",
        f"**Wake Type:** escalate_human",
        f"**Blocked Subtasks:** {len(blocked)}",
        "",
        "### Blocked Subtasks",
        "",
    ]

    for st in blocked:
        idx = st.get("index", "?")
        text = st.get("text", "Unknown")
        reason = st.get("blockedReason", "No reason given")
        lines.append(f"  🚫 **[{idx}]** {text}")
        lines.append(f"     Reason: {reason}")
        lines.append("")

    lines.extend([
        "### ACTION REQUIRED",
        "",
        "**1. Send Discord notification to Wadera:**",
        "This task has blocked subtasks that need human intervention.",
        "",
        "**2. Suppress future wakes:**",
        "Clawbeat will NOT wake for this task again until the blocked",
        "subtask is unblocked.",
        "",
        "**3. To unblock when ready:**",
        f"```bash",
        f"clawboard start-subtask {task_id} INDEX  "
        f"# Moves blocked → in_progress",
        f"```",
        "",
        "**Log your action:**",
        "```bash",
        f'echo "$(date -u +%H:%M) | {task_id} | ESCALATED — '
        f'blocked subtask, notified human" >> /tmp/orchestration-actions.log',
        "```",
    ])

    return "\n".join(lines)


def build_stuck_prompt(task: dict, context: dict, retry_count: int) -> str:
    """Build review prompt for stuck tasks (legacy backward compat)."""
    task_id = task.get("id", "")[:8]
    task_title = task.get("title", "Unknown")

    lines = [
        f"## ORCHESTRATE: Stuck Task [{task_id}] Needs Review",
        "",
        f"**Task:** {task_title}",
        f"**Attempt:** {retry_count + 1}",
        f"**Wake Type:** review_needed (legacy stuck)",
        "",
    ]

    if retry_count >= ESCALATION_THRESHOLD:
        lines.extend(build_escalation_summary(task_id, retry_count, context))

    if context.get("task_details"):
        lines.extend([
            "### Task Details",
            "```",
            context["task_details"][:1500],
            "```",
            "",
        ])

    if context.get("subtasks"):
        lines.extend(["### Subtasks", ""])
        for i, subtask in enumerate(context["subtasks"]):
            lines.append(f"{i}. {subtask}")
        lines.append("")

    lines.extend([
        "### ACTION REQUIRED",
        "",
        "**Review each in_review (🔄) subtask:**",
        "",
        f"1. Check work: `clawboard get {task_id}`",
        f"2. Verify in browser (visual check)",
        "",
        "**Then for EACH subtask:**",
        f"- Approve: `clawboard approve-subtask {task_id} INDEX`",
        f"- Reject: `clawboard reject-subtask {task_id} INDEX "
        f"--note \"Reason\"`",
        "",
        "**After all subtasks reviewed:**",
        f"- If all approved: `clawboard move {task_id} completed`",
        f"- If rejected: `clawboard move {task_id} in-progress` "
        f"and respawn agent",
        "",
        "**Log your action:**",
        f"```bash",
        f'echo "$(date -u +%H:%M) | {task_id} | ACTION" '
        f">> /tmp/orchestration-actions.log",
        f"```",
    ])

    if context.get("previous_errors"):
        lines.extend(["", "### Previous Errors (from session logs)", "```"])
        for err in context["previous_errors"][:3]:
            lines.append(err[:150])
        lines.append("```")

    return "\n".join(lines)


# ─── Multi-Signal Completion Detection (P1) ───

def check_recent_git_commits(task_id: str, hours: int = 2) -> list[str]:
    """Check for recent git commits mentioning the task ID."""
    short_id = task_id[:8]
    commits = []

    try:
        result = subprocess.run(
            ["git", "log", f"--since={hours} hours ago",
             "--oneline", f"--grep={short_id}"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0 and result.stdout.strip():
            commits = result.stdout.strip().split('\n')
            log(f"Found {len(commits)} git commits mentioning {short_id}")
    except (subprocess.TimeoutExpired, OSError) as e:
        log(f"Git commit check failed: {e}")

    return commits


def check_session_file_activity(task_id: str,
                                minutes: int = 30) -> dict:
    """Check if any session files mention the task ID and were recently
    modified.

    Returns dict with active, session, last_modified.
    """
    if not SESSIONS_DIR.exists():
        return {"active": False}

    short_id = task_id[:8]
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=minutes)

    try:
        for entry in sorted(
            SESSIONS_DIR.iterdir(),
            key=lambda x: x.stat().st_mtime,
            reverse=True
        ):
            if entry.suffix != ".jsonl" or ".deleted." in entry.name:
                continue

            mtime = datetime.fromtimestamp(entry.stat().st_mtime,
                                           tz=timezone.utc)
            if mtime < cutoff:
                break

            try:
                with open(entry) as f:
                    content = f.read()
                    if short_id in content:
                        return {
                            "active": True,
                            "session": entry.name,
                            "last_modified": mtime.isoformat()
                        }
            except OSError:
                continue
    except OSError as e:
        log(f"Session file check failed: {e}")

    return {"active": False}


def is_task_actually_done(task: dict) -> tuple[bool, str]:
    """Multi-signal completion detection.

    Returns (is_done, reason_if_done).
    """
    task_id = task.get("id", "")
    status = task.get("status", "")

    # Signal 1: API status
    if status == "completed":
        return True, "API status is completed"

    # Signal 2: All subtasks completed
    subtasks = task.get("subtasks", [])
    if subtasks and all(
            s.get("status") in ("completed", "skipped") for s in subtasks):
        return True, f"All {len(subtasks)} subtasks are completed/skipped"

    # Signal 3: Process status file
    status_file = get_task_status_file(task_id)
    if status_file.exists():
        try:
            with open(status_file) as f:
                proc_status = json.load(f)
            if proc_status.get("completed"):
                return True, "Process status file indicates completion"
            if (not proc_status.get("running", True)
                    and proc_status.get("exit_code") == 0):
                return True, "Process exited successfully"
        except (json.JSONDecodeError, OSError):
            pass

    # Signal 4: Recent git commits
    commits = check_recent_git_commits(task_id, hours=4)
    for commit in commits:
        commit_lower = commit.lower()
        if any(word in commit_lower
               for word in ["complete", "done", "finish", "close"]):
            return True, f"Git commit indicates completion: {commit[:50]}"

    return False, ""


# ─── Step 1: Check Active Sub-agents ───

def check_active_subagents() -> tuple[bool, str]:
    """Check for recently active sub-agent sessions.

    Returns (is_active, reason_string).
    """
    if not SESSIONS_DIR.exists():
        log(f"Sessions dir not found: {SESSIONS_DIR}")
        return False, ""

    cutoff = datetime.now(timezone.utc) - timedelta(
        minutes=ACTIVE_AGENT_THRESHOLD)
    log(f"Checking sessions modified after {cutoff.isoformat()}")

    active_sessions = []
    try:
        for entry in SESSIONS_DIR.iterdir():
            if entry.suffix == ".jsonl" and ".deleted." not in entry.name:
                mtime = datetime.fromtimestamp(entry.stat().st_mtime,
                                               tz=timezone.utc)
                if mtime > cutoff:
                    try:
                        with open(entry, 'r') as f:
                            first_line = f.readline().strip()
                            if first_line:
                                first_obj = json.loads(first_line)
                                session_key = first_obj.get("sessionKey", "")
                                if "subagent" not in session_key:
                                    log(f"  Skipping non-subagent: "
                                        f"{entry.name} (key: {session_key})")
                                    continue
                    except Exception:
                        log(f"  Skipping unreadable: {entry.name}")
                        continue
                    active_sessions.append(entry.name)
                    log(f"  Active subagent: {entry.name} "
                        f"(modified {mtime.isoformat()})")
    except OSError as e:
        log(f"Error reading sessions: {e}")
        return False, ""

    if active_sessions:
        return True, active_sessions[0]

    return False, ""


# ─── Step 2: Check Tasks by Status ───

def check_stuck_tasks() -> list[dict]:
    """Fetch tasks with status=stuck. Excludes blocked-human tagged."""
    data = api_get("/tasks?status=stuck")
    tasks = data.get("tasks", [])
    actionable = []
    for t in tasks:
        tags = t.get("tags", [])
        if "blocked-human" in tags:
            log(f"  Skipping human-blocked: {t.get('id', '?')[:8]}")
            continue
        actionable.append(t)
    log(f"Found {len(actionable)} stuck tasks "
        f"({len(tasks) - len(actionable)} blocked-human, skipped)")
    return actionable


def fetch_tasks_by_status(status: str) -> list[dict]:
    """Fetch tasks by status, excluding blocked-human tagged."""
    data = api_get(f"/tasks?status={status}")
    tasks = data.get("tasks", [])
    actionable = []
    for t in tasks:
        tags = t.get("tags", [])
        if "blocked-human" in tags:
            log(f"  Skipping human-blocked: {t.get('id', '?')[:8]}")
            continue
        actionable.append(t)
    log(f"Found {len(actionable)} {status} tasks")
    return actionable


# ─── Step 3: Process Status Checks ───

def get_task_status_file(task_id: str) -> Path:
    """Get the status file path for a task (first 8 chars of ID)."""
    return Path(f"/tmp/task-{task_id[:8]}-status.json")


def is_pid_alive(pid: int) -> bool:
    """Check if a process is still running."""
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def check_process_status(task: dict) -> tuple[str, str]:
    """Check external process status for an in-progress task.

    Returns (status, reason) where status is one of:
    alive, finished, died, no_process.
    """
    task_id = task.get("id", "")
    task_title = task.get("title", "Unknown")

    status_file = get_task_status_file(task_id)
    log(f"Checking status file: {status_file}")

    if not status_file.exists():
        return ("no_process",
                f"In-progress with no agent or process: "
                f"[{task_id[:8]}] '{task_title}'")

    try:
        with open(status_file) as f:
            status = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        log(f"Failed to read status file: {e}")
        return ("no_process",
                f"In-progress with no agent or process: "
                f"[{task_id[:8]}] '{task_title}'")

    running = status.get("running", False)
    pid = status.get("pid")
    updated_str = status.get("updated", "")

    updated = _parse_iso_timestamp(updated_str) if updated_str else None

    if not running:
        return ("finished",
                f"External process finished for "
                f"[{task_id[:8]}] '{task_title}'")

    if pid and not is_pid_alive(pid):
        return ("died",
                f"External process died for [{task_id[:8]}] '{task_title}'")

    if updated:
        stale_cutoff = datetime.now(timezone.utc) - timedelta(
            minutes=PROCESS_STALE_THRESHOLD)
        if updated < stale_cutoff:
            return ("died",
                    f"External process died for "
                    f"[{task_id[:8]}] '{task_title}'")

    log(f"Process alive for task {task_id[:8]}")
    return "alive", ""


def detect_dead_agent_session(task_id: str) -> tuple[bool, str]:
    """Check if task shows in-progress but agent session is dead."""
    session_info = check_session_file_activity(
        task_id, minutes=PROCESS_STALE_THRESHOLD)

    if session_info.get("active"):
        return False, ""

    status_file = get_task_status_file(task_id)
    if status_file.exists():
        try:
            with open(status_file) as f:
                proc_status = json.load(f)

            if proc_status.get("running"):
                pid = proc_status.get("pid")
                if pid and not is_pid_alive(pid):
                    return (True,
                            f"Process {pid} is dead but status file "
                            f"says running")

                updated = proc_status.get("updated", "")
                if updated:
                    update_time = _parse_iso_timestamp(updated)
                    if update_time:
                        stale_cutoff = datetime.now(timezone.utc) - timedelta(
                            minutes=PROCESS_STALE_THRESHOLD)
                        if update_time < stale_cutoff:
                            return (True,
                                    f"Status file is stale "
                                    f"(last update: {updated})")
        except (json.JSONDecodeError, OSError):
            pass

    return False, ""


# ─── Dedup Logic (Lifecycle-Aware) ───

# Action types that indicate a true resolution (suppress subsequent WAKEs permanently)
# Only terminal states: task is done or needs human intervention.
# Everything else (approved, rejected, reviewed) should re-notify the orchestrator.
RESOLUTION_ACTIONS = {
    "completed", "blocked"
}

# Action types that indicate an agent is working (time-limited suppression)
# Uses ACTIVE_AGENT_THRESHOLD (9min) — if agent hasn't reported back, re-evaluate.
AGENT_ACTIONS = {"spawned", "agent_running"}

# Non-terminal orchestrator actions — suppress briefly then re-notify
# These need orchestrator follow-up (send back to agent, complete, or block)
ORCHESTRATOR_ACTIONS = {"escalated", "reviewed", "approved", "rejected"}

# Action types that are just notifications
WAKE_ACTIONS = {"wake sent by clawbeat", "wake"}


def parse_orchestration_log(max_lines: int = 50
                            ) -> list[tuple[datetime, str, str]]:
    """Parse orchestration actions log.

    Format: HH:MM | TASK_ID | ACTION_TAKEN
    Returns list of (datetime, task_id, action).
    """
    if not ORCHESTRATION_LOG.exists():
        log("No orchestration log found")
        return []

    entries = []
    today = datetime.now(timezone.utc).date()

    try:
        with open(ORCHESTRATION_LOG) as f:
            lines = f.readlines()[-max_lines:]

        for line in lines:
            line = line.strip()
            if not line or "|" not in line:
                continue

            parts = [p.strip() for p in line.split("|")]
            if len(parts) >= 2:
                time_str = parts[0]
                task_id = parts[1]
                action = parts[2] if len(parts) > 2 else ""

                try:
                    hour, minute = map(int, time_str.split(":"))
                    entry_time = datetime(
                        today.year, today.month, today.day,
                        hour, minute, tzinfo=timezone.utc)
                    entries.append((entry_time, task_id, action))
                except ValueError:
                    log(f"Failed to parse log line: {line}")
    except OSError as e:
        log(f"Failed to read orchestration log: {e}")

    return entries


def classify_action(action_str: str) -> str:
    """Classify an action string. Returns: wake, resolution, agent, or unknown."""
    action_lower = action_str.lower()

    for wake_action in WAKE_ACTIONS:
        if wake_action in action_lower:
            return "wake"

    for resolution in RESOLUTION_ACTIONS:
        if resolution in action_lower:
            return "resolution"

    for agent_action in AGENT_ACTIONS:
        if agent_action in action_lower:
            return "agent"

    for orch_action in ORCHESTRATOR_ACTIONS:
        if orch_action in action_lower:
            return "orchestrator"

    return "unknown"


def get_last_action_for_task(task_id: str
                             ) -> tuple[str, str, datetime | None]:
    """Get the most recent action for a task.

    Returns (action_type, action_str, timestamp).
    """
    entries = parse_orchestration_log()
    short_id = task_id[:8]

    for entry_time, entry_task_id, action in reversed(entries):
        if (entry_task_id.startswith(short_id)
                or short_id.startswith(entry_task_id)):
            action_type = classify_action(action)
            return action_type, action, entry_time

    return "none", "", None


def get_last_wake_type_for_task(task_id: str) -> tuple[str | None,
                                                       datetime | None]:
    """Get the last wake_type sent for a task from the dedup log.

    Parses entries like: "WAKE sent by clawbeat (review_needed)"
    Returns (wake_type, timestamp) or (None, None).
    """
    entries = parse_orchestration_log()
    short_id = task_id[:8]

    for entry_time, entry_task_id, action in reversed(entries):
        if (entry_task_id.startswith(short_id)
                or short_id.startswith(entry_task_id)):
            if "WAKE sent by clawbeat" in action:
                # Extract wake_type from parentheses
                if "(" in action and ")" in action:
                    wt = action.split("(")[-1].rstrip(")")
                    return wt, entry_time
                return None, entry_time
    return None, None


def should_suppress_wake(task_id: str,
                         wake_type: str = "unknown") -> bool:
    """Check if we should suppress a WAKE for this task.

    Lifecycle-aware dedup:
    - Uses per-wake-type dedup windows from DEDUP_WINDOWS
    - If last action was a resolution, suppress
    - escalate_human: suppress until task status changes (no time window)
    - Same wake_type within its window: suppress
    """
    if DRY_RUN:
        log("Dry run - skipping dedup check")
        return False

    short_id = task_id[:8]
    last_action_type, last_action, last_time = get_last_action_for_task(
        task_id)

    if last_action_type == "none":
        log(f"No previous action for {short_id}, allowing WAKE")
        return False

    # If last action was a resolution, suppress permanently
    if last_action_type == "resolution":
        log(f"Suppressing WAKE for {short_id}: "
            f"last action was resolution '{last_action}'")
        return True

    # If last action was agent spawn/running, suppress for ACTIVE_AGENT_THRESHOLD (9min)
    # After that, the agent is assumed stale and we should re-evaluate
    if last_action_type == "agent" and last_time:
        cutoff = datetime.now(timezone.utc) - timedelta(
            minutes=ACTIVE_AGENT_THRESHOLD)
        if last_time > cutoff:
            log(f"Suppressing WAKE for {short_id}: "
                f"agent action '{last_action}' at {last_time} "
                f"(within {ACTIVE_AGENT_THRESHOLD}min agent window)")
            return True
        else:
            log(f"Agent action for {short_id} is stale "
                f"({last_action} at {last_time}), allowing re-evaluation")
            return False

    # Orchestrator actions (approved/rejected/reviewed/escalated) — use dedup window
    # These need follow-up: orchestrator should complete, block, or re-assign
    if last_action_type == "orchestrator" and last_time:
        dedup_minutes = DEDUP_WINDOWS.get(wake_type, DEDUP_WINDOW_MINUTES)
        if dedup_minutes is None:
            dedup_minutes = DEDUP_WINDOW_MINUTES  # Default 30min, not permanent
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=dedup_minutes)
        if last_time > cutoff:
            log(f"Suppressing WAKE for {short_id}: "
                f"orchestrator action '{last_action}' at {last_time} "
                f"(within {dedup_minutes}min window)")
            return True
        else:
            log(f"Orchestrator action for {short_id} is past window "
                f"({last_action} at {last_time}), re-notifying")
            return False

    # For escalate_human: check if last wake was also escalate_human
    # If so, suppress (until status changes, detected by resolution action)
    if wake_type == WAKE_TYPE_ESCALATE:
        last_wt, _ = get_last_wake_type_for_task(task_id)
        if last_wt == WAKE_TYPE_ESCALATE:
            log(f"Suppressing escalate_human for {short_id}: "
                f"already escalated, waiting for status change")
            return True

    # Time-based dedup with per-type window
    if last_action_type == "wake" and last_time:
        dedup_minutes = DEDUP_WINDOWS.get(wake_type, DEDUP_WINDOW_MINUTES)
        if dedup_minutes is None:
            # None means suppress until resolution
            log(f"Suppressing WAKE for {short_id}: "
                f"type {wake_type} suppresses until resolution")
            return True

        cutoff = datetime.now(timezone.utc) - timedelta(
            minutes=dedup_minutes)
        if last_time > cutoff:
            log(f"Suppressing WAKE for {short_id}: "
                f"recently woken at {last_time} "
                f"(window: {dedup_minutes}min for {wake_type})")
            return True

    return False


# ─── Log Rotation (P1) ───

def rotate_orchestration_log() -> None:
    """Rotate orchestration log if it exceeds MAX_LOG_LINES."""
    if DRY_RUN:
        log("Dry run - skipping log rotation")
        return

    if not ORCHESTRATION_LOG.exists():
        return

    try:
        with open(ORCHESTRATION_LOG) as f:
            lines = f.readlines()

        if len(lines) > MAX_LOG_LINES:
            log(f"Rotating orchestration log: "
                f"{len(lines)} → {KEEP_LOG_LINES} lines")
            with open(ORCHESTRATION_LOG, 'w') as f:
                f.writelines(lines[-KEEP_LOG_LINES:])
    except OSError as e:
        log(f"Failed to rotate orchestration log: {e}")


def cleanup_retry_tracker() -> None:
    """Clean up retry tracker entries older than max age."""
    if DRY_RUN:
        log("Dry run - skipping retry tracker cleanup")
        return

    tracker = load_retry_tracker()
    if not tracker:
        return

    cutoff = datetime.now(timezone.utc) - timedelta(
        hours=RETRY_TRACKER_MAX_AGE_HOURS)
    to_remove = []

    for task_id, entry in tracker.items():
        last_str = entry.get("last", "")
        last_time = _parse_iso_timestamp(last_str) if last_str else None

        if last_time and last_time < cutoff:
            to_remove.append(task_id)
            log(f"Cleaning up stale retry entry: {task_id} "
                f"(last: {last_str})")

    if to_remove:
        for task_id in to_remove:
            del tracker[task_id]
        save_retry_tracker(tracker)
        log(f"Cleaned up {len(to_remove)} stale retry tracker entries")


# ─── Main Decision Tree (Lifecycle-Aware) ───

def run_heartbeat() -> None:
    """Execute the lifecycle-aware heartbeat decision tree.

    Priority order:
    1. Active sub-agents → HEARTBEAT_OK
    2. Blocked subtasks → escalate_human (suppress future wakes)
    3. All subtasks done → complete_task
    4. Subtasks in review → review_needed
    5. Stuck tasks (legacy) → review_needed
    6. Stale/dead agents → stale_agent
    7. Auto-start tasks (with dep check) → spawn_agent
    8. Maintenance
    9. All clear
    """

    # ── Step 1: Check active sub-agents ──
    log("Step 1: Checking active sub-agents...")
    is_active, session_name = check_active_subagents()
    if is_active:
        output("HEARTBEAT_OK", f"Active sub-agent: {session_name}")

    # ── Step 2: Fetch all active tasks ──
    log("Step 2: Fetching active tasks...")
    in_progress_tasks = fetch_tasks_by_status("in-progress")
    review_tasks = fetch_tasks_by_status("review")
    stuck_tasks = check_stuck_tasks()

    # Collect blocked tasks for reporting (even if we don't wake for them)
    all_blocked = []

    # ── Step 3: Analyze in-progress and review tasks ──
    log("Step 3: Analyzing task lifecycle states...")

    # Categorize tasks by what action they need
    needs_escalation = []   # blocked subtasks
    needs_completion = []   # all subtasks done
    needs_review = []       # subtasks in review
    needs_stale_check = []  # in-progress, may have dead agent

    for task in in_progress_tasks + review_tasks:
        task_id = task.get("id", "")
        subtasks = task.get("subtasks", [])
        analysis = analyze_subtask_states(subtasks)

        log(f"  Task {task_id[:8]}: "
            f"blocked={analysis['has_blocked']}, "
            f"review={analysis['has_review']}, "
            f"all_done={analysis['all_done']}, "
            f"counts={analysis['counts']}")

        # Priority 1: Blocked subtasks → escalate
        if analysis["has_blocked"]:
            needs_escalation.append((task, analysis))
            all_blocked.append(task)
            continue

        # Priority 2: All subtasks done → complete
        if analysis["all_done"] and subtasks:
            needs_completion.append((task, analysis))
            continue

        # Priority 3: Subtasks in review → review needed
        if analysis["has_review"]:
            needs_review.append((task, analysis))
            continue

        # Priority 4: In-progress with potentially dead agent
        if task.get("status") == "in-progress":
            needs_stale_check.append((task, analysis))

    # ── Step 4: Process escalation (blocked subtasks) ──
    if needs_escalation:
        log("Step 4: Processing blocked tasks...")
        for task, analysis in needs_escalation:
            task_id = task.get("id", "")

            if should_suppress_wake(task_id, WAKE_TYPE_ESCALATE):
                log(f"  Suppressed escalation for {task_id[:8]}")
                continue

            context = gather_task_context(task_id)
            retry_count = record_retry(task_id, "Blocked subtask")
            message = build_escalate_human_prompt(task, context, analysis)

            output_wake(
                reason=f"Task {task_id[:8]} has blocked subtasks — "
                       f"needs human attention",
                message=message,
                task_id=task_id,
                attempt=retry_count,
                recommended_action="escalate_human",
                wake_type=WAKE_TYPE_ESCALATE,
            )

        # If all escalations were suppressed, note it and continue
        log("  All escalations suppressed, continuing...")

    # ── Step 5: Process completion candidates ──
    if needs_completion:
        log("Step 5: Processing completion candidates...")
        for task, analysis in needs_completion:
            task_id = task.get("id", "")

            if should_suppress_wake(task_id, WAKE_TYPE_COMPLETE):
                log(f"  Suppressed completion for {task_id[:8]}")
                continue

            context = gather_task_context(task_id)
            message = build_complete_task_prompt(task, context, analysis)

            output_wake(
                reason=f"Task {task_id[:8]} — all subtasks done, "
                       f"ready to complete",
                message=message,
                task_id=task_id,
                attempt=1,
                recommended_action="review",
                wake_type=WAKE_TYPE_COMPLETE,
            )

    # ── Step 6: Process review candidates ──
    if needs_review:
        log("Step 6: Processing review candidates...")
        for task, analysis in needs_review:
            task_id = task.get("id", "")

            if should_suppress_wake(task_id, WAKE_TYPE_REVIEW):
                log(f"  Suppressed review for {task_id[:8]}")
                continue

            context = gather_task_context(task_id)
            message = build_review_prompt(task, context, analysis)

            output_wake(
                reason=f"Task {task_id[:8]} — subtasks in review, "
                       f"needs orchestrator verification",
                message=message,
                task_id=task_id,
                attempt=1,
                recommended_action="review",
                wake_type=WAKE_TYPE_REVIEW,
            )

    # ── Step 7: Process stuck tasks (legacy backward compat) ──
    if stuck_tasks:
        log("Step 7: Processing stuck tasks (legacy)...")
        task = stuck_tasks[0]
        task_id = task.get("id", "")

        # Analyze subtasks for stuck tasks too
        subtasks = task.get("subtasks", [])
        analysis = analyze_subtask_states(subtasks)

        # If stuck task has blocked subtasks, treat as escalation
        if analysis["has_blocked"]:
            if not should_suppress_wake(task_id, WAKE_TYPE_ESCALATE):
                context = gather_task_context(task_id)
                retry_count = record_retry(task_id, "Blocked subtask (stuck)")
                message = build_escalate_human_prompt(
                    task, context, analysis)
                output_wake(
                    reason=f"Stuck task {task_id[:8]} has blocked subtasks",
                    message=message,
                    task_id=task_id,
                    attempt=retry_count,
                    recommended_action="escalate_human",
                    wake_type=WAKE_TYPE_ESCALATE,
                )
        # If all done, treat as completion
        elif analysis["all_done"] and subtasks:
            if not should_suppress_wake(task_id, WAKE_TYPE_COMPLETE):
                context = gather_task_context(task_id)
                message = build_complete_task_prompt(
                    task, context, analysis)
                output_wake(
                    reason=f"Stuck task {task_id[:8]} — all subtasks done",
                    message=message,
                    task_id=task_id,
                    attempt=1,
                    recommended_action="review",
                    wake_type=WAKE_TYPE_COMPLETE,
                )
        else:
            # Standard stuck task review
            if not should_suppress_wake(task_id, WAKE_TYPE_REVIEW):
                context = gather_task_context(task_id)
                retry_count, history = get_retry_count(task_id)
                new_count = record_retry(task_id, "Review needed")
                message = build_stuck_prompt(task, context, retry_count)

                rec_action = ("escalate_human"
                              if retry_count >= ESCALATION_THRESHOLD
                              else "review")
                output_wake(
                    reason=f"Task {task_id[:8]} stuck — needs review",
                    message=message,
                    task_id=task_id,
                    attempt=new_count,
                    recommended_action=rec_action,
                    wake_type=WAKE_TYPE_REVIEW,
                )

    # ── Step 8: Check in-progress tasks for stale agents ──
    if needs_stale_check:
        log("Step 8: Checking for stale agents...")
        for task, analysis in needs_stale_check:
            task_id = task.get("id", "")

            # Multi-signal completion check first
            is_done, done_reason = is_task_actually_done(task)
            if is_done:
                log(f"Task {task_id[:8]} appears done: {done_reason}")
                if not should_suppress_wake(task_id, WAKE_TYPE_COMPLETE):
                    context = gather_task_context(task_id)
                    message = build_complete_task_prompt(
                        task, context, analysis)
                    output_wake(
                        reason=f"Task {task_id[:8]} appears done "
                               f"({done_reason})",
                        message=message,
                        task_id=task_id,
                        attempt=1,
                        recommended_action="review",
                        wake_type=WAKE_TYPE_COMPLETE,
                    )
                continue

            # Check for dead agent session
            is_dead, dead_reason = detect_dead_agent_session(task_id)
            if is_dead:
                if should_suppress_wake(task_id, WAKE_TYPE_STALE):
                    log(f"  Suppressed stale_agent for {task_id[:8]}")
                    continue

                context = gather_task_context(task_id)
                retry_count, _ = get_retry_count(task_id)
                new_count = record_retry(task_id, f"Dead agent: {dead_reason}")
                message = build_stale_agent_prompt(
                    task, context, retry_count)

                rec_action = ("escalate_human"
                              if retry_count >= ESCALATION_THRESHOLD
                              else "restart_process")
                output_wake(
                    reason=f"Task {task_id[:8]} — agent session dead",
                    message=message,
                    task_id=task_id,
                    attempt=new_count,
                    recommended_action=rec_action,
                    wake_type=WAKE_TYPE_STALE,
                )

            # Check process status
            proc_status, reason = check_process_status(task)
            if proc_status != "alive":
                if should_suppress_wake(task_id, WAKE_TYPE_STALE):
                    log(f"  Suppressed stale for {task_id[:8]}")
                    continue

                context = gather_task_context(task_id)
                retry_count, _ = get_retry_count(task_id)
                new_count = record_retry(task_id, f"Process {proc_status}")
                message = build_stale_agent_prompt(
                    task, context, retry_count)

                rec_action = ("escalate_human"
                              if retry_count >= ESCALATION_THRESHOLD
                              else "restart_process")
                output_wake(
                    reason=f"Task {task_id[:8]} stalled — {proc_status}",
                    message=message,
                    task_id=task_id,
                    attempt=new_count,
                    recommended_action=rec_action,
                    wake_type=WAKE_TYPE_STALE,
                )

    # ── Step 9: Check auto-start tasks (with dependency awareness) ──
    log("Step 9: Checking auto-start tasks...")
    todo_tasks = fetch_tasks_by_status("todo")
    autostart_tasks = [t for t in todo_tasks if t.get("autoStart")]
    log(f"Found {len(autostart_tasks)} auto-start tasks "
        f"(of {len(todo_tasks)} total todo)")

    for task in autostart_tasks:
        task_id = task.get("id", "")
        task_title = task.get("title", "Unknown")

        # Dependency check — skip tasks with unmet deps
        has_unmet, unmet_ids = check_task_dependencies(task)
        if has_unmet:
            log(f"Skipping {task_id[:8]}: unmet dependencies: "
                f"{', '.join(unmet_ids)}")
            continue

        # Dedup check (1 hour window for spawns)
        if should_suppress_wake(task_id, WAKE_TYPE_SPAWN):
            log(f"Suppressed spawn for {task_id[:8]}")
            continue

        # Circuit breaker check
        should_block, block_reason = check_circuit_breaker(task_id)
        if should_block:
            log(f"Circuit breaker blocked spawn for {task_id[:8]}: "
                f"{block_reason}")
            record_retry(task_id, f"Circuit breaker: {block_reason}")
            output_wake(
                reason=f"Circuit breaker tripped for {task_id[:8]}",
                message=(
                    f"## ORCHESTRATE: Task [{task_id[:8]}] "
                    f"Needs Human Review\n\n"
                    f"**Task:** {task_title}\n\n"
                    f"### ⚠️ CIRCUIT BREAKER TRIPPED\n\n"
                    f"{block_reason}\n\n"
                    f"**Action Required:** Review this task manually.\n\n"
                    f"Options:\n"
                    f"- Fix the underlying issue and retry\n"
                    f"- Mark as blocked: `clawboard update {task_id[:8]} "
                    f"--tags blocked-human`\n"
                    f"- Clear retry tracker: delete entry from "
                    f"/tmp/clawbeat-retries.json\n"
                ),
                task_id=task_id,
                attempt=get_spawn_count_last_hour(task_id) + 1,
                recommended_action="escalate_human",
                wake_type=WAKE_TYPE_ESCALATE,
            )

        # Gather context and build spawn prompt
        log(f"Preparing spawn for {task_id[:8]}...")
        record_spawn(task_id)
        context = gather_task_context(task_id)
        message = build_spawn_prompt(task, context)

        output_wake(
            reason=f"Auto-start task ready: {task_title}",
            message=message,
            task_id=task_id,
            attempt=1,
            recommended_action="spawn_agent",
            wake_type=WAKE_TYPE_SPAWN,
        )

    # ── Step 10: Maintenance ──
    log("Step 10: Running maintenance...")
    rotate_orchestration_log()
    cleanup_retry_tracker()

    # ── Step 11: All clear ──
    log("Step 11: All clear, returning HEARTBEAT_OK")
    if all_blocked:
        output(
            "HEARTBEAT_OK",
            f"All systems nominal ({len(all_blocked)} tasks with blocked "
            f"subtasks — suppressed)",
            blocked_tasks=all_blocked,
        )
    else:
        output("HEARTBEAT_OK", "All systems nominal")


def main():
    global VERBOSE, DRY_RUN

    parser = argparse.ArgumentParser(
        description="Heartbeat watchdog CLI for OpenClaw orchestration "
                    "(lifecycle-aware)"
    )
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Enable debug output to stderr")
    parser.add_argument("--dry-run", "-n", action="store_true",
                        help="No side effects (skip dedup logging)")
    parser.add_argument(
        "--api", type=str, default=None,
        help="ClawBoard API URL "
             "(default: CLAWBOARD_API_URL env or http://localhost:3001/api)")
    parser.add_argument(
        "--token", type=str, default=None,
        help="API authentication token "
             "(default: CLAWBOARD_TOKEN env or config file)")

    args = parser.parse_args()
    VERBOSE = args.verbose
    DRY_RUN = args.dry_run

    if args.api:
        global API_BASE
        API_BASE = args.api

    if args.token:
        global TOKEN_ENV
        TOKEN_ENV = args.token

    try:
        run_heartbeat()
    except Exception as e:
        log(f"Unexpected error: {e}")
        output("HEARTBEAT_OK",
               f"Error during check: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
