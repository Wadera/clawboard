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
    {"action": "WAKE", "message": "ORCHESTRATE: ...", "reason": "1 stuck task", "task_id": "abc123", "attempt": 1, "recommended_action": "review"}

Features:
- Context gathering via clawboard CLI
- Retry tracking with escalation
- Rich, multi-paragraph prompts with full context
- recommended_action field for orchestrator guidance
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
API_BASE = os.getenv("CLAWBOARD_API_URL", "http://localhost:3001/api")
TOKEN_ENV = os.getenv("CLAWBOARD_TOKEN", "")
CONFIG_DIR = Path(os.getenv("CLAWBOARD_CONFIG_DIR", "~/.config/clawboard")).expanduser()
TOKEN_FILE = CONFIG_DIR / "config.json"

SESSIONS_DIR = Path("~/.openclaw/agents/main/sessions/").expanduser()
ORCHESTRATION_LOG = Path("/tmp/orchestration-actions.log")
RETRY_TRACKER_FILE = Path("/tmp/clawbeat-retries.json")

# Timing thresholds (in minutes)
ACTIVE_AGENT_THRESHOLD = 9
PROCESS_STALE_THRESHOLD = 30
DEDUP_WINDOW_MINUTES = 30

# Retry escalation threshold
ESCALATION_THRESHOLD = 3

# ─── Globals ───

VERBOSE = False
DRY_RUN = False


def log(msg: str) -> None:
    """Log to stderr if verbose mode is enabled."""
    if VERBOSE:
        print(f"[clawbeat] {msg}", file=sys.stderr)


def output(action: str, reason: str, message: str = None) -> None:
    """Output JSON result to stdout and exit."""
    result = {"action": action, "reason": reason}
    if message:
        result["message"] = message
    print(json.dumps(result))
    sys.exit(0)


def output_wake(reason: str, message: str, task_id: str = None, 
                attempt: int = 1, recommended_action: str = "review") -> None:
    """Output WAKE JSON with extended fields and exit.
    
    Args:
        reason: Short description of why we're waking
        message: Full multi-paragraph prompt with context
        task_id: Task ID (first 8 chars stored)
        attempt: Retry attempt number
        recommended_action: One of: review, spawn_agent, restart_process, escalate
    """
    result = {
        "action": "WAKE",
        "reason": reason,
        "message": message,
    }
    if task_id:
        result["task_id"] = task_id[:8]
        # Write to dedup log so subsequent heartbeats don't re-wake for same task
        if not DRY_RUN:
            try:
                with open(ORCHESTRATION_LOG, "a") as f:
                    ts = datetime.now(timezone.utc).strftime("%H:%M")
                    f.write(f"{ts} | {task_id[:8]} | WAKE sent by clawbeat\n")
                log(f"Wrote dedup entry for {task_id[:8]}")
            except OSError as e:
                log(f"Failed to write dedup log: {e}")
    result["attempt"] = attempt
    result["recommended_action"] = recommended_action
    print(json.dumps(result))
    sys.exit(0)


# ─── API Helpers ───

def get_api_token() -> str:
    """Read API token from config file or environment variable."""
    # Try environment variable first
    if TOKEN_ENV:
        return TOKEN_ENV
    
    # Fall back to config file
    try:
        with open(TOKEN_FILE) as f:
            config = json.load(f)
        return config.get("api_token", "")
    except (FileNotFoundError, json.JSONDecodeError, KeyError) as e:
        log(f"Failed to read token: {e}")
        return ""


def api_get(path: str) -> dict:
    """Make GET request to ClawBoard API. Returns empty dict on failure."""
    token = get_api_token()
    if not token:
        log("No API token available")
        return {}
    
    url = f"{API_BASE}{path}"
    log(f"GET {url}")
    
    # Try requests first, fall back to urllib
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
    
    # Fallback to urllib
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
    """Get retry count and history for a task.
    
    Returns (count, history_list). Reset when task completes.
    """
    tracker = load_retry_tracker()
    short_id = task_id[:8]
    
    if short_id in tracker:
        entry = tracker[short_id]
        return entry.get("count", 0), entry.get("history", [])
    
    return 0, []


def record_retry(task_id: str, action: str) -> int:
    """Increment retry counter and add action to history.
    
    Returns the new count.
    """
    tracker = load_retry_tracker()
    short_id = task_id[:8]
    now = datetime.now(timezone.utc).isoformat()
    
    if short_id in tracker:
        entry = tracker[short_id]
        entry["count"] = entry.get("count", 0) + 1
        entry["last"] = now
        entry["history"] = entry.get("history", [])[-9:] + [action]  # Keep last 10
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
            cwd=str(Path(__file__).parent.parent)
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
    success, output = run_clawboard_command(["get", short_id])
    if success:
        context["task_details"] = output
        # Parse subtasks from output
        subtasks = []
        in_subtasks = False
        for line in output.split('\n'):
            if 'Subtasks:' in line:
                in_subtasks = True
                continue
            if in_subtasks and line.strip().startswith(('⬜', '🔄', '✅', '-', '*', '[')):
                subtasks.append(line.strip())
            elif in_subtasks and line.strip() and not line.startswith(' '):
                in_subtasks = False
        context["subtasks"] = subtasks
    else:
        log(f"Failed to get task details: {output}")
    
    # 2. Get project context (extract project from task output)
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
            )[:3]  # Last 3 sessions
            
            errors = []
            for session_file in recent_sessions:
                try:
                    with open(session_file) as f:
                        for line in f:
                            if short_id in line and ('error' in line.lower() or 'failed' in line.lower()):
                                errors.append(line.strip()[:200])  # Truncate long lines
                except OSError:
                    pass
            context["previous_errors"] = errors[:5]  # Keep max 5 errors
        except OSError as e:
            log(f"Failed to scan session logs: {e}")
    
    return context


# ─── Prompt Builders ───

def build_stuck_prompt(task: dict, context: dict, retry_count: int) -> str:
    """Build review prompt for stuck tasks.
    
    Includes: task details, subtask status table, which need review,
    exact approve/reject commands, retry warning if count > 3.
    """
    task_id = task.get("id", "")[:8]
    task_title = task.get("title", "Unknown")
    
    lines = [
        f"## ORCHESTRATE: Stuck Task [{task_id}] Needs Review",
        "",
        f"**Task:** {task_title}",
        f"**Attempt:** {retry_count + 1}",
        "",
    ]
    
    # Add escalation warning if needed
    if retry_count >= ESCALATION_THRESHOLD:
        lines.extend([
            "### ⚠️ ESCALATION REQUIRED",
            f"This task has failed {retry_count} times. The approach may be wrong.",
            "**Consider:** Review before attempting again.",
            "",
        ])
    
    # Add task details
    if context.get("task_details"):
        lines.extend([
            "### Task Details",
            "```",
            context["task_details"][:1500],  # Truncate if very long
            "```",
            "",
        ])
    
    # Add subtask table
    if context.get("subtasks"):
        lines.extend([
            "### Subtasks",
            "",
        ])
        for i, subtask in enumerate(context["subtasks"]):
            lines.append(f"{i}. {subtask}")
        lines.append("")
    
    # Add commands
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
        f"- Reject: `clawboard reject-subtask {task_id} INDEX --note \"Reason\"`",
        "",
        "**After all subtasks reviewed:**",
        f"- If all approved: `clawboard move {task_id} completed`",
        f"- If rejected: `clawboard move {task_id} in-progress` and respawn agent",
        "",
        "**Log your action:**",
        f"```bash",
        f"echo \"$(date -u +%H:%M) | {task_id} | ACTION\" >> /tmp/orchestration-actions.log",
        f"```",
    ])
    
    # Add previous errors if any
    if context.get("previous_errors"):
        lines.extend([
            "",
            "### Previous Errors (from session logs)",
            "```",
        ])
        for err in context["previous_errors"][:3]:
            lines.append(err[:150])
        lines.append("```")
    
    return "\n".join(lines)


def build_stalled_prompt(task: dict, context: dict, retry_count: int) -> str:
    """Build restart/escalate prompt for stalled in-progress tasks.
    
    Includes: what happened (process log), where it stopped,
    previous attempt errors, restart commands or escalation note.
    """
    task_id = task.get("id", "")[:8]
    task_title = task.get("title", "Unknown")
    
    lines = [
        f"## ORCHESTRATE: Stalled Task [{task_id}] Needs Attention",
        "",
        f"**Task:** {task_title}",
        f"**Attempt:** {retry_count + 1}",
        "",
    ]
    
    # Add escalation warning if needed
    if retry_count >= ESCALATION_THRESHOLD:
        lines.extend([
            "### ⚠️ ESCALATION REQUIRED",
            f"This task has failed {retry_count} times. The approach may be wrong.",
            "**Consider:** Review before attempting again.",
            "",
        ])
    
    # Add process state info
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
    
    # Add task details
    if context.get("task_details"):
        lines.extend([
            "### Task Details",
            "```",
            context["task_details"][:1000],
            "```",
            "",
        ])
    
    # Add commands
    lines.extend([
        "### ACTION REQUIRED",
        "",
        "**1. Check what happened:**",
        "```bash",
        f"cat /tmp/task-{task_id}-status.json 2>/dev/null",
        f"ps -ef | grep -E '{task_id}' | grep -v grep",
        "```",
        "",
        "**2. Decide next action:**",
        "",
    ])
    
    if retry_count < ESCALATION_THRESHOLD:
        lines.extend([
            f"- **If finished successfully:** `clawboard move {task_id} completed`",
            f"- **If failed but fixable:** Respawn agent with fix instructions",
            f"- **If process still running:** Wait or check logs",
            "",
        ])
    else:
        lines.extend([
            f"- **If finished:** `clawboard move {task_id} completed`",
            f"- **If not:** Consider escalating — this has failed {retry_count} times",
            "",
        ])
    
    lines.extend([
        "**Log your action:**",
        "```bash",
        f"echo \"$(date -u +%H:%M) | {task_id} | ACTION\" >> /tmp/orchestration-actions.log",
        "```",
    ])
    
    # Add previous errors
    if context.get("previous_errors"):
        lines.extend([
            "",
            "### Previous Errors",
            "```",
        ])
        for err in context["previous_errors"][:3]:
            lines.append(err[:150])
        lines.append("```")
    
    return "\n".join(lines)


def build_autostart_prompt(task: dict, context: dict) -> str:
    """Build spawn-ready prompt for auto-start tasks.
    
    Includes: full task details, subtasks, project context,
    suggested model/timeout, ready to paste into sessions_spawn.
    """
    task_id = task.get("id", "")[:8]
    task_title = task.get("title", "Unknown")
    thinking = task.get("thinking", "low")
    priority = task.get("priority", "normal")
    
    lines = [
        f"## ORCHESTRATE: Auto-Start Task [{task_id}] Ready",
        "",
        f"**Task:** {task_title}",
        f"**Priority:** {priority}",
        f"**Thinking Level:** {thinking}",
        "",
    ]
    
    # Add task details
    if context.get("task_details"):
        lines.extend([
            "### Task Details",
            "```",
            context["task_details"][:1500],
            "```",
            "",
        ])
    
    # Add project context
    if context.get("project_info"):
        lines.extend([
            "### Project Context",
            "```",
            context["project_info"][:1000],
            "```",
            "",
        ])
    
    # Add subtasks
    if context.get("subtasks"):
        lines.extend([
            "### Subtasks",
            "",
        ])
        for i, subtask in enumerate(context["subtasks"]):
            lines.append(f"{i}. {subtask}")
        lines.append("")
    
    # Add spawn instructions
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
        "**3. Spawn agent with appropriate thinking level:**",
        "```python",
        f"sessions_spawn(",
        f'    label="{task_id}-agent",',
        f'    task="[paste prompt from clawboard spawn]",',
        f'    thinking="{thinking}"',
        f")",
        "```",
        "",
        "**4. Log your action:**",
        "```bash",
        f"echo \"$(date -u +%H:%M) | {task_id} | Spawned agent\" >> /tmp/orchestration-actions.log",
        "```",
    ])
    
    return "\n".join(lines)


# ─── Step 1: Check Active Sub-agents ───

def check_active_subagents() -> tuple[bool, str]:
    """Check for recently active sub-agent sessions.
    
    Returns (is_active, reason_string).
    """
    if not SESSIONS_DIR.exists():
        log(f"Sessions dir not found: {SESSIONS_DIR}")
        return False, ""
    
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=ACTIVE_AGENT_THRESHOLD)
    log(f"Checking sessions modified after {cutoff.isoformat()}")
    
    # Identify the main and heartbeat session IDs to exclude them.
    # These sessions get written to on every heartbeat/interaction,
    # so their mtime is always fresh — they'd always look "active".
    # We find them by reading the first JSON line of each .jsonl which
    # contains the session key. Only count sessions with "subagent" in key.
    active_sessions = []
    try:
        for entry in SESSIONS_DIR.iterdir():
            if entry.suffix == ".jsonl" and ".deleted." not in entry.name:
                mtime = datetime.fromtimestamp(entry.stat().st_mtime, tz=timezone.utc)
                if mtime > cutoff:
                    # Check if this is a subagent session by reading first line
                    # which contains the session key. Only count subagent sessions.
                    try:
                        with open(entry, 'r') as f:
                            first_line = f.readline().strip()
                            if first_line:
                                first_obj = json.loads(first_line)
                                session_key = first_obj.get("sessionKey", "")
                                if "subagent" not in session_key:
                                    log(f"  Skipping non-subagent: {entry.name} (key: {session_key})")
                                    continue
                    except Exception:
                        # If we can't read the key, skip it to be safe
                        log(f"  Skipping unreadable: {entry.name}")
                        continue
                    active_sessions.append(entry.name)
                    log(f"  Active subagent: {entry.name} (modified {mtime.isoformat()})")
    except OSError as e:
        log(f"Error reading sessions: {e}")
        return False, ""
    
    if active_sessions:
        # Return the most recently modified one
        return True, active_sessions[0]
    
    return False, ""


# ─── Step 2: Check Stuck Tasks ───

def check_stuck_tasks() -> list[dict]:
    """Fetch tasks with status=stuck. Returns list of task dicts.
    
    Excludes tasks tagged 'blocked-human' — these need human intervention
    and shouldn't trigger automated wake events.
    """
    data = api_get("/tasks?status=stuck")
    tasks = data.get("tasks", [])
    # Filter out tasks that need human intervention
    actionable = []
    for t in tasks:
        tags = t.get("tags", [])
        if "blocked-human" in tags:
            log(f"  Skipping human-blocked task: {t.get('id', '?')[:8]}")
            continue
        actionable.append(t)
    log(f"Found {len(actionable)} stuck tasks ({len(tasks) - len(actionable)} blocked-human, skipped)")
    return actionable


# ─── Step 3: Check In-Progress Tasks ───

def get_task_status_file(task_id: str) -> Path:
    """Get the status file path for a task (first 8 chars of ID)."""
    short_id = task_id[:8]
    return Path(f"/tmp/task-{short_id}-status.json")


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
    - "alive": Process running normally
    - "finished": Process marked running=false
    - "died": PID dead or file stale
    - "no_process": No status file exists
    """
    task_id = task.get("id", "")
    task_title = task.get("title", "Unknown")
    
    status_file = get_task_status_file(task_id)
    log(f"Checking status file: {status_file}")
    
    if not status_file.exists():
        return "no_process", f"In-progress with no agent or process: [{task_id[:8]}] '{task_title}'"
    
    try:
        with open(status_file) as f:
            status = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        log(f"Failed to read status file: {e}")
        return "no_process", f"In-progress with no agent or process: [{task_id[:8]}] '{task_title}'"
    
    running = status.get("running", False)
    pid = status.get("pid")
    updated_str = status.get("updated", "")
    
    # Parse updated timestamp
    updated = None
    if updated_str:
        try:
            # Handle ISO format with or without Z suffix
            if updated_str.endswith("Z"):
                updated = datetime.fromisoformat(updated_str.replace("Z", "+00:00"))
            else:
                updated = datetime.fromisoformat(updated_str)
                if updated.tzinfo is None:
                    updated = updated.replace(tzinfo=timezone.utc)
        except ValueError as e:
            log(f"Failed to parse timestamp '{updated_str}': {e}")
    
    # Check if process has finished
    if not running:
        return "finished", f"External process finished for [{task_id[:8]}] '{task_title}'"
    
    # Check if PID is alive
    if pid and not is_pid_alive(pid):
        return "died", f"External process died for [{task_id[:8]}] '{task_title}'"
    
    # Check if status is stale (>30 min since last update)
    if updated:
        stale_cutoff = datetime.now(timezone.utc) - timedelta(minutes=PROCESS_STALE_THRESHOLD)
        if updated < stale_cutoff:
            return "died", f"External process died for [{task_id[:8]}] '{task_title}'"
    
    log(f"Process alive for task {task_id[:8]}")
    return "alive", ""


def check_in_progress_tasks() -> list[tuple[dict, str, str]]:
    """Check all in-progress tasks for orphaned/finished processes.
    
    Returns list of (task, status, reason) for tasks needing attention.
    """
    data = api_get("/tasks?status=in-progress")
    tasks = data.get("tasks", [])
    log(f"Found {len(tasks)} in-progress tasks")
    
    needs_attention = []
    for task in tasks:
        status, reason = check_process_status(task)
        if status != "alive":
            needs_attention.append((task, status, reason))
    
    return needs_attention


# ─── Step 4: Check Auto-start Tasks ───

def check_autostart_tasks() -> list[dict]:
    """Fetch todo tasks with autoStart=true."""
    data = api_get("/tasks?status=todo")
    tasks = data.get("tasks", [])
    autostart = [t for t in tasks if t.get("autoStart")]
    log(f"Found {len(autostart)} auto-start todo tasks (of {len(tasks)} total)")
    return autostart


# ─── Dedup Logic ───

def parse_orchestration_log() -> list[tuple[datetime, str, str]]:
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
        # Read last 10 lines
        with open(ORCHESTRATION_LOG) as f:
            lines = f.readlines()[-10:]
        
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
                    # Parse HH:MM and combine with today's date
                    hour, minute = map(int, time_str.split(":"))
                    entry_time = datetime(today.year, today.month, today.day, 
                                         hour, minute, tzinfo=timezone.utc)
                    entries.append((entry_time, task_id, action))
                except ValueError:
                    log(f"Failed to parse log line: {line}")
    except OSError as e:
        log(f"Failed to read orchestration log: {e}")
    
    return entries


def should_suppress_wake(task_id: str) -> bool:
    """Check if we should suppress a WAKE for this task (recent action)."""
    if DRY_RUN:
        log("Dry run - skipping dedup check")
        return False
    
    entries = parse_orchestration_log()
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=DEDUP_WINDOW_MINUTES)
    
    # Get short ID for matching (first 8 chars)
    short_id = task_id[:8]
    
    for entry_time, entry_task_id, action in entries:
        # Match if either ID starts with the other's prefix
        if (entry_task_id.startswith(short_id) or short_id.startswith(entry_task_id)):
            if entry_time > cutoff:
                log(f"Suppressing WAKE for {short_id}: recent action at {entry_time}")
                return True
    
    return False


# ─── Main Decision Tree ───

def run_heartbeat() -> None:
    """Execute the heartbeat decision tree."""
    
    # Step 1: Check active sub-agents
    log("Step 1: Checking active sub-agents...")
    is_active, session_name = check_active_subagents()
    if is_active:
        output("HEARTBEAT_OK", f"Active sub-agent: {session_name}")
    
    # Step 2: Check stuck tasks
    log("Step 2: Checking stuck tasks...")
    stuck_tasks = check_stuck_tasks()
    if stuck_tasks:
        task = stuck_tasks[0]
        task_id = task.get("id", "")
        task_title = task.get("title", "Unknown")
        
        if should_suppress_wake(task_id):
            output("HEARTBEAT_OK", f"dedup suppressed: {task_id[:8]}")
        
        # Gather context and build rich prompt
        log("Gathering context for stuck task...")
        context = gather_task_context(task_id)
        retry_count, history = get_retry_count(task_id)
        
        # Record this attempt
        new_count = record_retry(task_id, "Review needed")
        
        # Build rich prompt
        message = build_stuck_prompt(task, context, retry_count)
        
        # Determine recommended action
        if retry_count >= ESCALATION_THRESHOLD:
            recommended_action = "escalate"
        else:
            recommended_action = "review"
        
        output_wake(
            reason=f"Task {task_id[:8]} stuck — needs subtask review",
            message=message,
            task_id=task_id,
            attempt=new_count,
            recommended_action=recommended_action
        )
    
    # Step 3: Check in-progress tasks
    log("Step 3: Checking in-progress tasks...")
    attention_needed = check_in_progress_tasks()
    if attention_needed:
        task, status, reason = attention_needed[0]
        task_id = task.get("id", "")
        
        if should_suppress_wake(task_id):
            output("HEARTBEAT_OK", f"dedup suppressed: {task_id[:8]}")
        
        # Gather context and build rich prompt
        log("Gathering context for stalled task...")
        context = gather_task_context(task_id)
        retry_count, history = get_retry_count(task_id)
        
        # Record this attempt
        new_count = record_retry(task_id, f"Process {status}")
        
        # Build rich prompt
        message = build_stalled_prompt(task, context, retry_count)
        
        # Determine recommended action
        if retry_count >= ESCALATION_THRESHOLD:
            recommended_action = "escalate"
        elif status == "finished":
            recommended_action = "review"
        else:
            recommended_action = "restart_process"
        
        output_wake(
            reason=f"Task {task_id[:8]} stalled — {status}",
            message=message,
            task_id=task_id,
            attempt=new_count,
            recommended_action=recommended_action
        )
    
    # Step 4: Check auto-start tasks
    log("Step 4: Checking auto-start tasks...")
    autostart_tasks = check_autostart_tasks()
    if autostart_tasks:
        task = autostart_tasks[0]
        task_id = task.get("id", "")
        task_title = task.get("title", "Unknown")
        
        if should_suppress_wake(task_id):
            output("HEARTBEAT_OK", f"dedup suppressed: {task_id[:8]}")
        
        # Gather context and build rich prompt
        log("Gathering context for auto-start task...")
        context = gather_task_context(task_id)
        
        # Build rich prompt (no retry count for auto-start - it's a fresh task)
        message = build_autostart_prompt(task, context)
        
        output_wake(
            reason=f"Auto-start task ready: {task_title}",
            message=message,
            task_id=task_id,
            attempt=1,
            recommended_action="spawn_agent"
        )
    
    # Step 5: All clear
    log("Step 5: All clear, returning HEARTBEAT_OK")
    output("HEARTBEAT_OK", "All systems nominal")


def main():
    global VERBOSE, DRY_RUN
    
    parser = argparse.ArgumentParser(
        description="Heartbeat watchdog CLI for OpenClaw orchestration"
    )
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Enable debug output to stderr")
    parser.add_argument("--dry-run", "-n", action="store_true",
                        help="No side effects (skip dedup logging)")
    parser.add_argument("--api", type=str, default=None,
                        help="ClawBoard API URL (default: CLAWBOARD_API_URL env or http://localhost:3001/api)")
    parser.add_argument("--token", type=str, default=None,
                        help="API authentication token (default: CLAWBOARD_TOKEN env or config file)")
    
    args = parser.parse_args()
    VERBOSE = args.verbose
    DRY_RUN = args.dry_run
    
    # Override API base if provided
    if args.api:
        global API_BASE
        API_BASE = args.api
    
    # Override token if provided
    if args.token:
        global TOKEN_ENV
        TOKEN_ENV = args.token
    
    try:
        run_heartbeat()
    except Exception as e:
        # Never crash - output valid JSON even on error
        log(f"Unexpected error: {e}")
        output("HEARTBEAT_OK", f"Error during check: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
