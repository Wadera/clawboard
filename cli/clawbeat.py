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
import shutil
import subprocess
import hashlib
from pathlib import Path
from datetime import datetime, timedelta, timezone

# ─── Config ───

# API configuration - override with environment variables
API_BASE = os.getenv("CLAWBOARD_API_URL", "http://localhost:3001")
TOKEN_ENV = os.getenv("CLAWBOARD_TOKEN", "")
CONFIG_DIR = Path(os.getenv("CLAWBOARD_CONFIG_DIR", "~/.config/clawboard")).expanduser()
TOKEN_FILE = CONFIG_DIR / "config.json"

SESSIONS_DIR = Path("~/.openclaw/agents/main/sessions/").expanduser()

# Durable clawbeat state (survives reboots). A reboot on 2026-07-04 wiped
# /tmp and caused duplicate notifications, so the three state files now live
# under /srv/ai-stack/logs/clawbeat/. The legacy /tmp paths are kept for
# rollout compat: wake-dedup entries are written to BOTH ledgers, reads come
# from the durable path (merged with any legacy-only entries), and legacy
# files are migrated to the durable dir on start when the durable copy is
# absent (see migrate_legacy_state_files).
DURABLE_STATE_DIR = Path("/srv/ai-stack/logs/clawbeat")
ORCHESTRATION_LOG = DURABLE_STATE_DIR / "orchestration-actions.log"
LEGACY_ORCHESTRATION_LOG = Path("/tmp/orchestration-actions.log")
RETRY_TRACKER_FILE = DURABLE_STATE_DIR / "clawbeat-retries.json"
LEGACY_RETRY_TRACKER_FILE = Path("/tmp/clawbeat-retries.json")
CRON_LOG_FILE = Path("/tmp/clawbeat-cron.log")
# Tracks which blocked-human tasks have already been notified (dedup for Discord DMs).
BLOCKED_NOTIFY_FILE = DURABLE_STATE_DIR / "clawbeat-blocked-notified.json"
LEGACY_BLOCKED_NOTIFY_FILE = Path("/tmp/clawbeat-blocked-notified.json")
# Quota guard ledger (retry-tracker-style rolling event timestamps).
QUOTA_LEDGER_FILE = DURABLE_STATE_DIR / "clawbeat-quota.json"

# ClawBoard dashboard base URL — used to build per-task deep links in notifications.
DASHBOARD_URL = "https://nimspace.skyday.eu/dashboard"
# Discord user target for blocked-task notifications (Wadera).
DISCORD_NOTIFY_USER = "user:204643948960940033"

# Hermes-native QA/orchestration runner for Hermes-harness tasks.
HERMES_HOME = Path("/home/hermes")
HERMES_BIN = HERMES_HOME / "hermes-agent/venv/bin/hermes"


def resolve_hermes_qa_repo(env=None, module_file=None):
    """Resolve an existing checkout for Hermes QA without host-specific paths.

    A valid explicit override wins, followed by the deployed-repo mount/path.
    Missing or stale configured paths fall back to the checkout containing this
    script so a bad environment value cannot disable every reviewer wake.
    """
    env = os.environ if env is None else env
    module_file = Path(__file__) if module_file is None else Path(module_file)
    checkout_root = module_file.resolve().parents[1]
    for raw_path in (
        env.get("CLAWBEAT_HERMES_QA_REPO"),
        env.get("DEPLOYED_REPO_PATH"),
        str(checkout_root),
    ):
        if not raw_path:
            continue
        candidate = Path(raw_path).expanduser().resolve()
        if candidate.is_dir():
            return candidate
    return checkout_root


HERMES_QA_REPO = resolve_hermes_qa_repo()
HERMES_QA_LOG_DIR = Path("/tmp/clawbeat-hermes-qa")
HERMES_QA_PATH = "/home/hermes/.npm-global/bin:/home/hermes/tools:/usr/bin:/bin"
HERMES_QA_MODEL = os.getenv("CLAWBEAT_HERMES_QA_MODEL", "openai-codex/gpt-5.5")
HERMES_QA_MAX_TURNS = os.getenv("CLAWBEAT_HERMES_QA_MAX_TURNS", "30")

# Hermes ORCHESTRATOR wake delivery (primary orchestration channel when the
# wake_delivery config selects "hermes"). Separate log dir from the QA runner
# so orchestration wakes are easy to audit independently.
HERMES_WAKE_LOG_DIR = Path("/tmp/clawbeat-hermes-wakes")
HERMES_MAIN_DEFAULT_MODEL = "openai-codex/gpt-5.5"

# Default OpenClaw gateway session key for wake delivery. Overridable via the
# wake_delivery.openclaw_session config field (OpenClaw 2026.6.11 renamed the
# live session to agent:main:explicit:main; keep the legacy literal as the
# zero-config default).
OPENCLAW_DEFAULT_SESSION_KEY = "agent:main:main"

# Timing thresholds (in minutes)
ACTIVE_AGENT_THRESHOLD = 9
PROCESS_STALE_THRESHOLD = 9

# Transactional scheduler rollout. Disabled preserves the legacy read-only
# classification/wake path. When enabled, a spawn wake is emitted only after
# the backend atomically reserves the task and its resource lease.
HARDENED_ORCHESTRATION_ENV = "CLAWBEAT_HARDENED_ORCHESTRATION_ENABLED"
HARDENED_LEASE_TTL_ENV = "CLAWBEAT_LEASE_TTL_MS"

# Grace period after task is spawned (moved to in-progress) before stale
# detection kicks in. Cron sessions take time to queue and start.
SPAWN_GRACE_PERIOD_MINUTES = 5

# Legacy dedup window (fallback if wake_type not in DEDUP_WINDOWS)
DEDUP_WINDOW_MINUTES = 9

# Retry escalation threshold
ESCALATION_THRESHOLD = 3

# Externally-managed tasks (in-progress, no activeAgent, empty sessionRefs)
# are orchestrator-direct work: clawbeat never restarts or stuck-marks them.
# It only escalates to a human once they exceed this in-progress age.
EXTERNALLY_MANAGED_MAX_HOURS = 12

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
# New: direct Discord notification when a task is stuck + tagged blocked-human.
# Clawbeat sends this wake BEFORE checking for active sub-agents so the human
# is always notified immediately, regardless of current agent activity.
WAKE_TYPE_BLOCKED_HUMAN = "blocked_human"

# Per-wake-type dedup windows (minutes). None = suppress until status changes.
DEDUP_WINDOWS = {
    WAKE_TYPE_SPAWN: 10,           # 10 min
    WAKE_TYPE_REVIEW: 19,          # 19 min (~2 heartbeat ticks)
    WAKE_TYPE_STALE: 9,            # 9 min
    WAKE_TYPE_COMPLETE: 9,         # 9 min
    WAKE_TYPE_ESCALATE: None,      # Suppress until unblocked
    WAKE_TYPE_BLOCKED_HUMAN: None, # Suppress until task is no longer stuck/blocked-human
}

# ─── Cron Mode Config ───

# User activity threshold in milliseconds (9 min)
USER_ACTIVE_THRESHOLD_MS = 9 * 60 * 1000
# OpenClaw gateway config path
OPENCLAW_CONFIG = Path("~/.openclaw/openclaw.json").expanduser()

# Gateway auth — password needed for CLI calls since device pairing changes
def _get_gateway_password() -> str:
    """Read gateway password from OpenClaw config."""
    try:
        import json5
        cfg = json5.loads(OPENCLAW_CONFIG.read_text())
        return cfg.get("gateway", {}).get("auth", {}).get("password", "")
    except Exception:
        try:
            # Fallback: simple JSON parse
            import json
            text = OPENCLAW_CONFIG.read_text()
            # Strip comments and trailing commas for json5 compat
            cfg = json.loads(text)
            return cfg.get("gateway", {}).get("auth", {}).get("password", "")
        except Exception:
            return os.environ.get("OPENCLAW_GATEWAY_PASSWORD", "")

# ─── Globals ───

VERBOSE = False
DRY_RUN = False
CRON_MODE = False  # When True, deliver directly via gateway instead of stdout
SESSION_STATUS_CACHE: dict[str, dict] = {}


def log(msg: str) -> None:
    """Log to stderr if verbose mode is enabled."""
    if VERBOSE:
        print(f"[clawbeat] {msg}", file=sys.stderr)


def cron_log(msg: str) -> None:
    """Log to the cron log file (always, not just verbose). Also logs verbose."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    log(msg)
    try:
        with open(CRON_LOG_FILE, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


# ─── Durable State Migration ───

def migrate_legacy_state_files() -> None:
    """Migrate legacy /tmp state files into the durable state directory.

    Creates DURABLE_STATE_DIR when missing (clawd-writable). For each
    (legacy, durable) pair, copies the legacy file ONLY when the durable file
    does not exist yet — first run after rollout, or a host where /tmp still
    holds the freshest state. Never deletes or truncates the legacy files.

    No-op in dry-run mode to avoid side effects during testing.
    """
    if DRY_RUN:
        log("Dry run - skipping legacy state migration")
        return

    try:
        DURABLE_STATE_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        log(f"Could not create durable state dir {DURABLE_STATE_DIR}: {e}")
        return

    pairs = [
        (LEGACY_RETRY_TRACKER_FILE, RETRY_TRACKER_FILE),
        (LEGACY_BLOCKED_NOTIFY_FILE, BLOCKED_NOTIFY_FILE),
        (LEGACY_ORCHESTRATION_LOG, ORCHESTRATION_LOG),
    ]
    for legacy, durable in pairs:
        try:
            if durable.exists() or not legacy.exists():
                continue
            shutil.copy2(legacy, durable)
            log(f"Migrated legacy state file {legacy} -> {durable}")
        except OSError as e:
            log(f"Failed to migrate {legacy} -> {durable}: {e}")


# ─── Gateway Delivery (Cron Mode) ───

def get_openclaw_bin() -> str:
    """Find the openclaw binary path."""
    # Check common locations
    for path in [
        Path("~/.npm-global/bin/openclaw").expanduser(),
        Path("/usr/local/bin/openclaw"),
        Path("/usr/bin/openclaw"),
    ]:
        if path.exists():
            return str(path)
    # Fallback to PATH
    return "openclaw"


def check_user_active() -> bool:
    """Check if Wadera is actively chatting (main session updated < 9min ago).

    Uses `openclaw gateway call status --json` to get session timestamps.
    Returns True if user is active, False if idle.
    """
    try:
        result = subprocess.run(
            [get_openclaw_bin(), "gateway", "call", "status", "--json",
             "--password", _get_gateway_password()],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode != 0:
            log(f"Gateway status check failed: {result.stderr[:200]}")
            return False  # Assume idle on failure

        # Parse JSON from output (skip any non-JSON preamble like Doctor warnings)
        stdout = result.stdout
        json_start = stdout.find("{")
        if json_start < 0:
            log("No JSON found in gateway status output")
            return False

        data = json.loads(stdout[json_start:])
        sessions = data.get("sessions", {}).get("recent", [])

        # OpenClaw 2026.6.11 renamed the live main session key from
        # agent:main:main to agent:main:explicit:main (the legacy entry is
        # frozen at pre-upgrade values). Accept both, preferring the live one.
        main_keys = ("agent:main:explicit:main", "agent:main:main")
        by_key = {s.get("key"): s for s in sessions if s.get("key") in main_keys}
        for key in main_keys:
            session = by_key.get(key)
            if session is None:
                continue
            age_ms = session.get("age", float("inf"))
            is_active = age_ms < USER_ACTIVE_THRESHOLD_MS
            log(f"Main session ({key}) age: {age_ms}ms, "
                f"active={is_active} (threshold={USER_ACTIVE_THRESHOLD_MS}ms)")
            return is_active

        log("Main session not found in status response")
        return False

    except subprocess.TimeoutExpired:
        log("Gateway status check timed out")
        return False
    except (json.JSONDecodeError, KeyError, TypeError) as e:
        log(f"Failed to parse gateway status: {e}")
        return False
    except FileNotFoundError:
        log("openclaw binary not found")
        return False


# ─── Cron Job State Checking ───

def get_cron_jobs() -> list[dict]:
    """Fetch all cron jobs from the OpenClaw gateway via `cron.list`.

    Returns list of job dicts (each has id, name, state with nextRunAtMs /
    runningAtMs / lastRunAtMs / lastStatus).  Returns [] on any failure.
    """
    try:
        result = subprocess.run(
            [get_openclaw_bin(), "gateway", "call", "cron.list", "--json",
             "--password", _get_gateway_password()],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode != 0:
            log(f"cron.list failed (rc={result.returncode}): "
                f"{result.stderr[:200]}")
            return []

        stdout = result.stdout.strip()
        # Find the first JSON object/array (skip preamble warnings)
        json_obj_start = stdout.find("{")
        json_arr_start = stdout.find("[")

        if json_obj_start < 0 and json_arr_start < 0:
            log("cron.list: no JSON in output")
            return []

        # Prefer whichever starts first
        if json_arr_start >= 0 and (
                json_obj_start < 0 or json_arr_start < json_obj_start):
            data = json.loads(stdout[json_arr_start:])
            if isinstance(data, list):
                return data
        else:
            data = json.loads(stdout[json_obj_start:])
            if isinstance(data, list):
                return data
            if isinstance(data, dict):
                # Wrapped as {"jobs": [...]}
                for key in ("jobs", "crons", "items"):
                    if isinstance(data.get(key), list):
                        return data[key]

        log(f"cron.list: unexpected format: {stdout[:200]}")
        return []

    except subprocess.TimeoutExpired:
        log("cron.list timed out")
        return []
    except (json.JSONDecodeError, KeyError, TypeError) as e:
        log(f"cron.list parse error: {e}")
        return []
    except FileNotFoundError:
        log("openclaw binary not found for cron.list")
        return []


def _check_cron_job_active(job: dict) -> tuple[bool, str]:
    """Determine if a cron job dict represents an active (queued/running) job.

    Returns (is_active, reason).
    """
    state = job.get("state") or {}
    job_id = str(job.get("id", ""))[:8]
    running_at_ms = state.get("runningAtMs")
    next_run_at_ms = state.get("nextRunAtMs")
    last_status = state.get("lastStatus") or "unknown"

    if running_at_ms:
        log(f"    Cron job {job_id} is RUNNING (runningAtMs={running_at_ms})")
        return True, "cron job running"

    if next_run_at_ms:
        log(f"    Cron job {job_id} is QUEUED "
            f"(nextRunAtMs={next_run_at_ms}, no runningAtMs)")
        return True, "cron job queued"

    log(f"    Cron job {job_id} is idle/done (lastStatus={last_status})")
    return False, f"cron job {last_status}"


def is_cron_session_active(task: dict) -> tuple[bool, str]:
    """Check whether the task's cron session is queued or currently running.

    Two lookup strategies (tried in order):

    1. **sessionKey-based** (preferred): task.activeAgent.sessionKey =
       "cron:<uuid>" → find job by UUID in cron.list.

    2. **Name-based fallback**: look for a job named "spawn-task-<task-id>"
       in cron.list.  This handles the common case where ClawBoard hasn't
       (yet) populated activeAgent.sessionKey.

    Returns (is_active, reason):
        (True,  "cron job queued")       — job exists, waiting for a slot
        (True,  "cron job running")      — job is actively executing
        (False, "not a cron session")    — no cron reference found for task
        (False, "cron job not found")    — job deleted / never existed
        (False, "cron job <status>")     — job finished / errored
    """
    task_id = task.get("id", "")
    short_id = task_id[:8]

    # ── Strategy 1: activeAgent.sessionKey ──
    active_agent = task.get("activeAgent") or {}
    session_key = (
        active_agent.get("sessionKey")
        or active_agent.get("session_key")
        or ""
    )

    if session_key and session_key.startswith("cron:"):
        job_id = session_key[len("cron:"):]
        if job_id:
            log(f"  Task {short_id}: looking up cron job by sessionKey "
                f"{job_id[:8]}…")
            jobs = get_cron_jobs()
            job = next(
                (j for j in jobs if str(j.get("id", "")) == job_id),
                None,
            )
            if job is None:
                log(f"  Cron job {job_id[:8]} not found")
                return False, "cron job not found"
            return _check_cron_job_active(job)

    # ── Strategy 2: name-based fallback ("spawn-task-<short-id>") ──
    # Used when activeAgent.sessionKey is not populated in the API response.
    log(f"  Task {short_id}: no cron sessionKey — trying name-based lookup "
        f"('spawn-task-{short_id}')…")
    jobs = get_cron_jobs()

    # Match on job name containing the 8-char task ID
    name_pattern = f"spawn-task-{short_id}"
    matching_jobs = [
        j for j in jobs
        if name_pattern in (j.get("name") or "")
    ]

    if not matching_jobs:
        log(f"  Task {short_id}: no cron job found with name containing "
            f"'{name_pattern}'")
        return False, "not a cron session"

    # If multiple matches (shouldn't happen), prefer the most recently created
    job = max(matching_jobs, key=lambda j: j.get("createdAtMs", 0))
    log(f"  Task {short_id}: found cron job by name: "
        f"{job.get('id', '')[:8]} ({job.get('name', '')})")
    return _check_cron_job_active(job)


def is_task_recently_spawned(
    task: dict,
    grace_minutes: int = SPAWN_GRACE_PERIOD_MINUTES,
) -> tuple[bool, str]:
    """Return True if the task was moved to in-progress within the grace period.

    Checks a range of timestamp fields (API may expose different names) and
    returns (is_recent, reason_string).  If no timestamp is available, returns
    (False, "no timestamp") so detection proceeds normally.
    """
    task_id = task.get("id", "")[:8]

    # Try common timestamp field names for "moved to in-progress"
    for field in (
        "startedAt", "started_at",
        "inProgressAt", "in_progress_at",
        "updatedAt", "updated_at",
        "lastUpdatedAt", "last_updated_at",
    ):
        ts_str = task.get(field)
        if not ts_str:
            continue
        ts = _parse_iso_timestamp(str(ts_str))
        if ts is None:
            continue
        age_minutes = (
            datetime.now(timezone.utc) - ts
        ).total_seconds() / 60
        if age_minutes < grace_minutes:
            log(f"  Task {task_id} within spawn grace period: "
                f"{age_minutes:.1f}m old via '{field}' "
                f"(grace={grace_minutes}m)")
            return (
                True,
                f"spawned {age_minutes:.0f}m ago (grace: {grace_minutes}m)",
            )
        else:
            log(f"  Task {task_id} beyond grace period: "
                f"{age_minutes:.1f}m old via '{field}'")
            return False, f"spawned {age_minutes:.0f}m ago"

    log(f"  Task {task_id}: no usable timestamp for grace period check")
    return False, "no timestamp available"


def get_task_execution_profile(task: dict) -> dict:
    """Return normalized execution metadata for a task."""
    active_agent = task.get("activeAgent") or {}
    profile = task.get("executionProfile") or {}
    mode = profile.get("mode") or task.get("executionMode") or "subagent"
    harness = (
        active_agent.get("harness")
        or profile.get("harness")
        or "openclaw"
    )
    interactive = bool(task.get("acpSessionKey") or mode == "interactive")
    session_key = (
        active_agent.get("sessionKey")
        or active_agent.get("session_key")
        or task.get("acpSessionKey")
        or ""
    )

    return {
        "mode": mode,
        "harness": harness,
        "interactive": interactive,
        "session_key": session_key,
        "access_profile": profile.get("accessProfile") or "safe",
        "required_capabilities": profile.get("requiredCapabilities") or [],
        "allow_override_at_spawn": bool(profile.get("allowOverrideAtSpawn")),
    }


def fetch_task_session_status(task: dict, refresh: bool = False) -> dict:
    """Fetch harness-aware runtime state for a task via the ClawBoard API."""
    task_id = task.get("id", "")
    if not task_id:
        return {}

    if not refresh and task_id in SESSION_STATUS_CACHE:
        return SESSION_STATUS_CACHE[task_id]

    execution = get_task_execution_profile(task)
    fallback = {
        "taskId": task_id,
        "sessionKey": execution["session_key"] or None,
        "executionMode": execution["mode"],
        "interactive": execution["interactive"],
        "harness": execution["harness"],
        "state": "none" if not execution["session_key"] else "unknown",
        "reason": None,
        "lookupFailed": False,
        "metadata": {},
    }

    try:
        response = api_get(f"/tasks/{task_id}/session-status")
        data = response.get("data") if isinstance(response, dict) else None
        if isinstance(data, dict):
            merged = {**fallback, **data}
            SESSION_STATUS_CACHE[task_id] = merged
            return merged
    except Exception as e:
        log(f"Failed to fetch task session status for {task_id[:8]}: {e}")
        fallback["reason"] = f"session-status unavailable: {e}"
        fallback["lookupFailed"] = True

    SESSION_STATUS_CACHE[task_id] = fallback
    return fallback


def get_runtime_status_timestamp(runtime_status: dict) -> datetime | None:
    """Extract the best available timestamp from a session-status payload."""
    meta = runtime_status.get("metadata") or {}
    for field in ("updatedAt", "startedAt", "endedAt"):
        value = runtime_status.get(field) or meta.get(field)
        if not value:
            continue
        parsed = _parse_iso_timestamp(str(value))
        if parsed is not None:
            return parsed
    return None


def runtime_status_is_active(runtime_status: dict,
                             active_minutes: int = ACTIVE_AGENT_THRESHOLD
                             ) -> tuple[bool, str]:
    """Return whether runtime status shows an agent that is actively working."""
    if not runtime_status:
        return False, "no runtime status"

    canonical = runtime_status.get("canonicalRuntime")
    if isinstance(canonical, dict):
        state = str(canonical.get("state") or "unknown")
        reason = str(canonical.get("reasonCode") or "unspecified")
        # A canonical attempt signal is authoritative for both harnesses. In
        # particular, executor/PID "running" must not mask stale, orphaned, or
        # finished sourced evidence.
        return state == "active", f"Canonical runtime {state} ({reason})"

    harness = runtime_status.get("harness") or "openclaw"
    state = str(runtime_status.get("state") or "unknown")

    if harness == "hermes":
        if state in ("starting", "running"):
            return True, f"Hermes session {state}"
        # Hermes runtime classification already folds PID liveness and fresh
        # message/tool activity into starting/running. Once it reports idle,
        # a recent startedAt/updatedAt timestamp alone is not proof of live
        # work; treating it as active recreates the zero-message stale-session
        # orchestration bug and blocks the one-retry bypass path.
        return False, f"Hermes session {state}"

    if state in ("queued", "running", "active",
                 "busy", "thinking", "tool-use", "typing"):
        return True, f"OpenClaw session {state}"
    if state == "idle":
        updated = get_runtime_status_timestamp(runtime_status)
        if updated is not None:
            cutoff = datetime.now(timezone.utc) - timedelta(
                minutes=active_minutes)
            if updated > cutoff:
                age_seconds = (
                    datetime.now(timezone.utc) - updated
                ).total_seconds()
                return True, (
                    f"OpenClaw session idle but active {age_seconds:.0f}s ago"
                )
    return False, f"OpenClaw session {state}"


def should_route_orchestration_wake(task: dict) -> tuple[bool, str]:
    """Whether orchestration wakes should be sent for this task.

    OpenClaw tasks route through the OpenClaw main orchestration session.
    Hermes tasks route through a dedicated Hermes-native QA/orchestrator
    launch path so review/completion/stale decisions are handled by a separate
    Hermes worker with access to Spark + Bitwarden rather than by the
    implementing subagent or the OpenClaw main session.
    """
    execution = get_task_execution_profile(task)
    harness = execution.get("harness") or "openclaw"
    task_id = task.get("id", "")[:8]
    if harness == "hermes":
        return True, f"task {task_id} routes via Hermes QA"
    return True, "openclaw-routable"

def build_spawn_command(task: dict) -> str:
    """Build the harness-aware spawn command for the task."""
    task_id = task.get("id", "")[:8]
    execution = get_task_execution_profile(task)
    parts = [
        "clawboard", "spawn", task_id, "--run", "--harness",
        execution["harness"],
    ]
    task_model = task.get("model")
    if task_model:
        parts.extend(["--model", task_model])
    if execution["interactive"]:
        parts.append("--interactive")
    else:
        parts.append("--fire-and-forget")
    return " ".join(parts)


def launch_hermes_qa_wake(message: str, task_id: str | None = None,
                          wake_type: str | None = None) -> bool:
    """Launch a dedicated Hermes QA/orchestrator turn on the host.

    Runs as the hermes OS user so the worker can access Spark browser helpers,
    Bitwarden helpers, and Hermes runtime state directly. This is intentionally
    separate from the implementing task worker.
    """
    token = get_api_token()
    if not token:
        cron_log("Hermes QA launch skipped: no ClawBoard API token available")
        return False

    if not HERMES_BIN.exists():
        cron_log(f"Hermes QA launch skipped: binary missing at {HERMES_BIN}")
        return False

    if not HERMES_QA_REPO.exists():
        cron_log(f"Hermes QA launch skipped: repo missing at {HERMES_QA_REPO}")
        return False

    try:
        HERMES_QA_LOG_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        cron_log(f"Hermes QA launch skipped: could not create log dir: {e}")
        return False

    short_id = (task_id or "main")[:8]
    wake_label = wake_type or "wake"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    source_tag = f"clawbeat:{wake_label}:{short_id}:{stamp}"
    log_path = HERMES_QA_LOG_DIR / f"{stamp}-{short_id}-{wake_label}.log"

    cmd = [
        "sudo", "-n", "-u", "hermes",
        "env",
        f"HOME={HERMES_HOME}",
        f"PATH={HERMES_QA_PATH}",
        "BITWARDENCLI_APPDATA_DIR=/home/hermes/.config/Bitwarden CLI",
        f"CLAWBOARD_API_URL={API_BASE}",
        f"CLAWBOARD_TOKEN={token}",
        "CLAWBOARD_QA_AGENT=1",
        "CLAWBOARD_ROLE=qa",
        "NO_COLOR=1",
        str(HERMES_BIN),
        "chat",
        "-q", message,
        "-Q",
        "--source", source_tag,
        "--max-turns", HERMES_QA_MAX_TURNS,
        "-m", HERMES_QA_MODEL,
    ]

    try:
        with open(log_path, "a") as log_file:
            proc = subprocess.Popen(
                cmd,
                cwd=str(HERMES_QA_REPO),
                stdin=subprocess.DEVNULL,
                stdout=log_file,
                stderr=log_file,
                start_new_session=True,
                text=True,
            )
        cron_log(
            f"Launched Hermes QA wake for {short_id} ({wake_label}) pid={proc.pid} log={log_path}"
        )
        record_quota_event("hermes_turns")
        return True
    except Exception as e:
        cron_log(f"Hermes QA launch failed for {short_id} ({wake_label}): {e}")
        return False


def build_hermes_wake_footer() -> str:
    """Footer appended to orchestration wakes delivered to Hermes.

    Replaces the OpenClaw message-tool footer semantics that
    tools/clawbeat-deliver.js appends on the gateway path (Hermes replies
    natively on Discord and has no OpenClaw message tool).
    """
    return "\n".join([
        "",
        "---",
        "[ClawBeat orchestration wake — delivered into your persistent "
        "Hermes orchestrator session]",
        "- Act on this wake using the canonical `clawboard` CLI (already on "
        "your PATH) for spawn/review/update actions.",
        "- When Wadera must be notified, reply/DM her natively on Discord "
        "via your own channel access, or use `hermes send`.",
        "- Append every action you take to "
        "/srv/ai-stack/logs/orchestration-actions.log AND write the dedup "
        "line to /tmp/orchestration-actions.log if it is writable for you.",
    ])


def deliver_to_hermes_main(message: str, wake_type: str | None = None,
                           task_id: str | None = None) -> bool:
    """Deliver an orchestration wake to the persistent Hermes orchestrator.

    Modeled on launch_hermes_qa_wake (same sudo/env scaffold, detached
    Popen), but runs Hermes as the ORCHESTRATOR — no QA role env — and
    resumes the pinned orchestrator session when one is configured so all
    wakes share cross-wake context. Returns True when the detached launch
    succeeds (rc-less semantics, same as the QA branch).
    """
    if DRY_RUN:
        cron_log("DRY RUN: Would deliver via Hermes orchestrator: "
                 f"{message[:200]}...")
        return True

    token = get_api_token()
    if not token:
        cron_log("Hermes orchestrator wake skipped: no ClawBoard API token "
                 "available")
        return False

    if not HERMES_BIN.exists():
        cron_log(f"Hermes orchestrator wake skipped: binary missing at "
                 f"{HERMES_BIN}")
        return False

    try:
        HERMES_WAKE_LOG_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        cron_log(f"Hermes orchestrator wake skipped: could not create log "
                 f"dir: {e}")
        return False

    delivery = get_wake_delivery_config()
    model = delivery.get("hermes_model") or HERMES_MAIN_DEFAULT_MODEL
    resume_session = delivery.get("hermes_orchestrator_session")

    short_id = (task_id or "main")[:8]
    wake_label = wake_type or "wake"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    source_tag = f"clawbeat-orchestrate:{wake_label}:{short_id}:{stamp}"
    log_path = HERMES_WAKE_LOG_DIR / f"{stamp}-{short_id}-{wake_label}.log"

    full_message = message + build_hermes_wake_footer()

    cmd = [
        "sudo", "-n", "-u", "hermes",
        "env",
        f"HOME={HERMES_HOME}",
        f"PATH={HERMES_QA_PATH}",
        "BITWARDENCLI_APPDATA_DIR=/home/hermes/.config/Bitwarden CLI",
        f"CLAWBOARD_API_URL={API_BASE}",
        f"CLAWBOARD_TOKEN={token}",
        "NO_COLOR=1",
        str(HERMES_BIN),
        "chat",
        "-q", full_message,
        "-Q",
        "--source", source_tag,
        "--max-turns", HERMES_QA_MAX_TURNS,
        "-m", model,
    ]
    if resume_session:
        cmd.extend(["--resume", resume_session])

    try:
        with open(log_path, "a") as log_file:
            proc = subprocess.Popen(
                cmd,
                cwd=str(HERMES_HOME),
                stdin=subprocess.DEVNULL,
                stdout=log_file,
                stderr=log_file,
                start_new_session=True,
                text=True,
            )
        cron_log(
            f"Launched Hermes orchestrator wake for {short_id} "
            f"({wake_label}) pid={proc.pid} log={log_path}"
        )
        record_quota_event("hermes_turns")
        return True
    except Exception as e:
        cron_log(f"Hermes orchestrator wake launch failed for {short_id} "
                 f"({wake_label}): {e}")
        return False


def deliver_to_gateway(message: str, wake_now: bool = True,
                       wake_type: str = None, task_id: str = None,
                       session_key: str = OPENCLAW_DEFAULT_SESSION_KEY) -> bool:
    """Deliver a message to the main session via direct gateway agent RPC.

    Uses clawbeat-deliver.js which connects to the gateway WebSocket,
    authenticates with token+password, and injects the message as a
    user-role message into the target session (default agent:main:main,
    overridable via the wake_delivery.openclaw_session config field) via
    the gateway `agent` RPC.

    This is intentionally the same behavioral delivery mechanism we want
    from ClawBeat: direct injection into the main session as if someone
    spoke in-session, not a background system event.

    Returns True on success, False on failure.
    """
    if DRY_RUN:
        mode = "now" if wake_now else "next-heartbeat"
        cron_log(f"DRY RUN: Would deliver via WebSocket RPC (mode={mode}): "
                 f"{message[:200]}...")
        return True

    # Method: Node.js WebSocket RPC (reliable, no device pairing needed)
    deliver_script = Path(__file__).resolve().parent.parent / "tools" / "clawbeat-deliver.js"
    if not deliver_script.exists():
        # Fallback path
        deliver_script = Path.home() / "clawd" / "tools" / "clawbeat-deliver.js"

    node_path = str(Path.home() / ".npm-global/lib/node_modules/openclaw/node_modules")

    env = os.environ.copy()
    env["NODE_PATH"] = node_path

    key_parts = [
        "clawbeat",
        wake_type or "wake",
        task_id or "main",
        hashlib.sha1(message.encode("utf-8")).hexdigest()[:16],
    ]
    idempotency_key = ":".join(key_parts)

    try:
        result = subprocess.run(
            ["node", str(deliver_script), message, session_key, idempotency_key],
            capture_output=True, text=True, timeout=20, env=env,
        )
        if result.returncode == 0:
            cron_log(
                f"Delivered via gateway agent RPC to {session_key} "
                f"(idempotency={idempotency_key}): {message[:100]}..."
            )
            return True
        cron_log(f"WebSocket RPC failed (rc={result.returncode}): "
                 f"{result.stderr[:200]}")
    except subprocess.TimeoutExpired:
        cron_log("WebSocket RPC delivery timed out")
    except FileNotFoundError:
        cron_log("node binary not found")

    return False


def _deliver_fallback_cron(message: str, wake_now: bool = True) -> bool:
    """Fallback delivery via cron one-shot if direct injection fails.

    NOTE: This uses --system-event which the AI may ignore. Only used
    as a last resort when gateway call agent fails.
    """
    wake_mode = "now" if wake_now else "next-heartbeat"
    cmd = [
        get_openclaw_bin(), "cron", "add",
        "--at", "1m",
        "--session", "main",
        "--system-event", message,
        "--wake", wake_mode,
        "--delete-after-run",
        "--name", f"clawbeat-{datetime.now(timezone.utc).strftime('%H%M')}",
        "--description", "Auto-generated by clawbeat --cron (fallback)",
        "--password", _get_gateway_password(),
    ]

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=15,
        )
        if result.returncode != 0:
            cron_log(f"Fallback cron also failed: {result.stderr[:300]}")
            return False

        cron_log(f"Fallback delivered via cron (wake={wake_mode}): "
                 f"{message[:100]}...")
        return True

    except (subprocess.TimeoutExpired, FileNotFoundError):
        cron_log("Fallback cron delivery failed")
        return False


def cron_deliver(action: str, reason: str, message: str = None,
                 wake_type: str = None, task_id: str = None) -> None:
    """Deliver clawbeat result via the correct orchestration channel in cron mode.

    - HEARTBEAT_OK → log silently and exit
    - WAKE for Hermes-harness tasks → launch dedicated Hermes QA worker
    - All other WAKEs → walk the configured [primary]+fallbacks delivery
      chain (hermes → deliver_to_hermes_main; openclaw → user-idle gated
      deliver_to_gateway). First success wins; all failed → exit 1.
    """
    if action == "HEARTBEAT_OK":
        cron_log(f"OK: {reason}")
        sys.exit(0)

    if not message:
        cron_log(f"WAKE with no message, skipping: {reason}")
        sys.exit(0)

    if task_id:
        task_payload = api_get(f"/tasks/{task_id}")
        task = task_payload.get("task", task_payload)
        if task:
            execution = get_task_execution_profile(task)
            if (execution.get("harness") or "openclaw") == "hermes":
                cron_log(
                    f"Routing wake via Hermes QA launch: task={task_id[:8]} wake_type={wake_type or 'wake'}"
                )
                success = launch_hermes_qa_wake(message, task_id=task_id, wake_type=wake_type)
                if not success:
                    cron_log(f"DELIVERY FAILED (Hermes QA): {reason}")
                    sys.exit(1)
                sys.exit(0)

    delivery = get_wake_delivery_config()
    targets = [delivery["primary"]] + list(delivery["fallbacks"])
    openclaw_session = (delivery.get("openclaw_session")
                        or OPENCLAW_DEFAULT_SESSION_KEY)

    for target in targets:
        if target == "hermes":
            success = deliver_to_hermes_main(
                message, wake_type=wake_type, task_id=task_id,
            )
        else:  # openclaw
            user_active = check_user_active()

            if user_active:
                cron_log(f"User ACTIVE — delivering as background event: "
                         f"{reason}")
                success = deliver_to_gateway(
                    message, wake_now=False, wake_type=wake_type,
                    task_id=task_id, session_key=openclaw_session,
                )
            else:
                cron_log(f"User IDLE — delivering as immediate wake: "
                         f"{reason}")
                success = deliver_to_gateway(
                    message, wake_now=True, wake_type=wake_type,
                    task_id=task_id, session_key=openclaw_session,
                )

        if success:
            cron_log(f"Delivered via {target}: {reason}")
            sys.exit(0)

        cron_log(f"{target} delivery failed - trying next")

    cron_log(f"DELIVERY FAILED: {reason}")
    sys.exit(1)

def output(action: str, reason: str, message: str = None,
           blocked_tasks: list = None) -> None:
    """Output JSON result to stdout and exit.

    In cron mode, delivers via gateway instead of stdout.
    """
    if CRON_MODE:
        cron_deliver(action, reason, message)
        return  # cron_deliver calls sys.exit

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
        # Write to dedup ledger. Durable path is the source of truth; the
        # legacy /tmp ledger is dual-written for backward compat during the
        # durable-state rollout (other tools may still tail it).
        if not DRY_RUN:
            ts = datetime.now(timezone.utc).isoformat()
            wt = wake_type or "unknown"
            line = f"{ts} | {task_id[:8]} | WAKE sent by clawbeat ({wt})\n"
            for ledger_path in (ORCHESTRATION_LOG, LEGACY_ORCHESTRATION_LOG):
                try:
                    with open(ledger_path, "a") as f:
                        f.write(line)
                    log(f"Wrote dedup entry for {task_id[:8]} ({wt}) "
                        f"to {ledger_path}")
                except OSError as e:
                    log(f"Failed to write dedup log {ledger_path}: {e}")
    result["attempt"] = attempt
    result["recommended_action"] = recommended_action
    if wake_type:
        result["wake_type"] = wake_type

    if CRON_MODE:
        cron_deliver("WAKE", reason, message, wake_type=wake_type,
                     task_id=task_id)
        return  # cron_deliver calls sys.exit

    print(json.dumps(result))
    sys.exit(0)


# ─── API Helpers ───

def _token_expired(data: dict) -> bool:
    """Check if token is expired via expires_at field or JWT exp claim."""
    import time
    now = time.time()

    # Check explicit expires_at field first
    expires_at = data.get("expires_at")
    if expires_at is not None:
        try:
            return float(expires_at) < now
        except (ValueError, TypeError):
            pass

    # Decode JWT exp claim from the token itself (no signature verification)
    token = data.get("api_token") or data.get("token") or ""
    if token and token.count(".") == 2:
        try:
            import base64
            payload = token.split(".")[1]
            # Fix padding
            payload += "=" * (4 - len(payload) % 4)
            claims = json.loads(base64.urlsafe_b64decode(payload))
            exp = claims.get("exp")
            if exp and float(exp) < now:
                return True
        except Exception:
            pass

    return False  # No expiry info — assume valid


def get_api_token() -> str:
    """Read API token from config file or environment variable."""
    if TOKEN_ENV:
        return TOKEN_ENV

    # Token file candidates in priority order
    candidates = [
        ("config.json", TOKEN_FILE, ["api_token", "token"]),
        ("token.json", CONFIG_DIR / "token.json", ["token"]),
        # Legacy: nimtasks_token.json (old clawtasks CLI format)
        ("nimtasks_token.json", Path("~/.config/nim-tools/nimtasks_token.json").expanduser(), ["token"]),
    ]

    for label, path, keys in candidates:
        try:
            with open(path) as f:
                data = json.load(f)
            if _token_expired(data):
                log(f"Skipping {label}: token expired")
                continue
            for key in keys:
                token = data.get(key)
                if token:
                    return token
        except (FileNotFoundError, json.JSONDecodeError, KeyError) as e:
            pass  # Silently try next candidate

    log("No valid API token found in any config file")
    return ""


def get_wake_delivery_config() -> dict:
    """Read the optional "wake_delivery" block from the ClawBoard config file.

    Reads the SAME config.json that get_api_token uses (TOKEN_FILE). Shape:

        {"primary": "hermes"|"openclaw",
         "fallbacks": ["openclaw", ...],
         "hermes_orchestrator_session": str|None,
         "hermes_model": str|None,
         "openclaw_session": str|None}

    The CLAWBEAT_WAKE_HARNESS env var overrides `primary` when set to a
    valid target. Default when the block is absent: primary=openclaw with
    no fallbacks — zero behavior change until the config key is added.
    """
    config = {
        "primary": "openclaw",
        "fallbacks": [],
        "hermes_orchestrator_session": None,
        "hermes_model": None,
        "openclaw_session": None,
    }

    try:
        with open(TOKEN_FILE) as f:
            data = json.load(f)
        raw = data.get("wake_delivery")
        if isinstance(raw, dict):
            primary = raw.get("primary")
            if primary in ("hermes", "openclaw"):
                config["primary"] = primary
            fallbacks = raw.get("fallbacks")
            if isinstance(fallbacks, list):
                config["fallbacks"] = [
                    t for t in fallbacks if t in ("hermes", "openclaw")
                ]
            for key in ("hermes_orchestrator_session", "hermes_model",
                        "openclaw_session"):
                value = raw.get(key)
                if isinstance(value, str) and value:
                    config[key] = value
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass

    env_primary = os.getenv("CLAWBEAT_WAKE_HARNESS", "").strip().lower()
    if env_primary in ("hermes", "openclaw"):
        config["primary"] = env_primary

    return config


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


def api_post(path: str, payload: dict) -> dict:
    """POST JSON to ClawBoard as the scheduler role; return {} on failure."""
    token = get_api_token()
    if not token:
        log("No API token available")
        return {}
    url = f"{API_BASE}{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "x-clawboard-role": "orchestrator",
    }
    try:
        import requests
        resp = requests.post(url, headers=headers, json=payload, timeout=10)
        if resp.status_code >= 400:
            log(f"POST {url} failed ({resp.status_code}): {resp.text[:200]}")
            return {}
        return resp.json()
    except ImportError:
        pass
    except Exception as e:
        log(f"requests POST failed: {e}")
        return {}

    try:
        import urllib.request
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode(),
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        log(f"urllib POST failed: {e}")
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


# ─── Quota Guard (provider-quota-aware wake throttle) ───
#
# Clawbeat used to fire wakes/spawns regardless of provider quota. The quota
# guard is an opt-in throttle read from the SAME config.json wake_delivery
# uses (TOKEN_FILE):
#
#     "quota_guard": {"enabled": true,
#                     "max_spawn_wakes_per_hour": 6,
#                     "max_hermes_turns_per_hour": 20}
#
# Counts are tracked in a retry-tracker-style JSON ledger of rolling event
# timestamps. Each spawn_agent wake emitted counts one spawn-wake event;
# each Hermes chat launch (orchestrator wake or QA wake) counts one
# hermes-turn event. When either budget is exhausted, spawn wakes are
# deferred for the tick (logged, no stuck-marking, no notification).
# Absent config block (or enabled=false) = disabled = zero behavior change.

def get_quota_guard_config() -> dict:
    """Read the optional "quota_guard" block from the ClawBoard config file."""
    config = {
        "enabled": False,
        "max_spawn_wakes_per_hour": 6,
        "max_hermes_turns_per_hour": 20,
    }
    try:
        with open(TOKEN_FILE) as f:
            data = json.load(f)
        raw = data.get("quota_guard")
        if isinstance(raw, dict):
            config["enabled"] = bool(raw.get("enabled", False))
            for key in ("max_spawn_wakes_per_hour",
                        "max_hermes_turns_per_hour"):
                value = raw.get(key)
                if (isinstance(value, int) and not isinstance(value, bool)
                        and value > 0):
                    config[key] = value
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    return config


def load_quota_ledger() -> dict:
    """Load the quota event ledger. Returns empty dict on failure."""
    if not QUOTA_LEDGER_FILE.exists():
        return {}
    try:
        with open(QUOTA_LEDGER_FILE) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        log(f"Failed to load quota ledger: {e}")
        return {}


def save_quota_ledger(data: dict) -> None:
    """Save the quota event ledger. No-op in dry-run mode."""
    if DRY_RUN:
        log("Dry run - skipping quota ledger save")
        return
    try:
        with open(QUOTA_LEDGER_FILE, "w") as f:
            json.dump(data, f, indent=2)
    except OSError as e:
        log(f"Failed to save quota ledger: {e}")


def _recent_quota_events(events: list) -> list[str]:
    """Filter a list of ISO timestamps down to the last hour."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
    recent = []
    for ts_str in events or []:
        ts = _parse_iso_timestamp(str(ts_str))
        if ts is not None and ts > cutoff:
            recent.append(ts_str)
    return recent


def record_quota_event(kind: str) -> None:
    """Record one quota event ("spawn_wakes" or "hermes_turns") right now.

    Prunes events older than the rolling one-hour window. No-op when the
    quota guard is disabled so the ledger file is never created on hosts
    that don't opt in.
    """
    if not get_quota_guard_config()["enabled"]:
        return
    ledger = load_quota_ledger()
    events = _recent_quota_events(ledger.get(kind, []))
    events.append(datetime.now(timezone.utc).isoformat())
    ledger[kind] = events
    save_quota_ledger(ledger)
    log(f"Recorded quota event '{kind}' ({len(events)} in last hour)")


def check_quota_guard() -> tuple[bool, str]:
    """Whether spawn_agent wakes must be deferred this tick.

    Returns (should_defer, reason). Always (False, ...) when the guard is
    disabled or the config block is absent.
    """
    config = get_quota_guard_config()
    if not config["enabled"]:
        return False, "quota guard disabled"

    ledger = load_quota_ledger()

    spawn_events = _recent_quota_events(ledger.get("spawn_wakes", []))
    if len(spawn_events) >= config["max_spawn_wakes_per_hour"]:
        return True, (
            f"{len(spawn_events)} spawn wakes in the last hour "
            f"(max {config['max_spawn_wakes_per_hour']})"
        )

    turn_events = _recent_quota_events(ledger.get("hermes_turns", []))
    if len(turn_events) >= config["max_hermes_turns_per_hour"]:
        return True, (
            f"{len(turn_events)} Hermes turns in the last hour "
            f"(max {config['max_hermes_turns_per_hour']})"
        )

    return False, ""


# ─── Subtask Lifecycle Analysis ───

def analyze_subtask_states(subtasks: list[dict]) -> dict:
    """Analyze subtask states and return a lifecycle summary.

    Returns dict with:
        has_blocked: bool — any subtask in "blocked" state
        blocked_subtasks: list — subtasks that are blocked (with index)
        has_review: bool — any subtask in "review" state
        review_subtasks: list — subtasks in review (with index)
        has_in_progress: bool — any subtask in "in_progress" state
        review_ready: bool — review exists and every other required subtask is
            already in review/completed/skipped
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

    review_ready = (
        len(review_subtasks) > 0
        and counts.get("in_progress", 0) == 0
        and counts.get("empty", 0) == 0
        and counts.get("blocked", 0) == 0
    )

    return {
        "has_blocked": len(blocked_subtasks) > 0,
        "blocked_subtasks": blocked_subtasks,
        "has_review": len(review_subtasks) > 0,
        "review_subtasks": review_subtasks,
        "has_in_progress": counts.get("in_progress", 0) > 0,
        "review_ready": review_ready,
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
    """Build a harness-aware spawn prompt for dependency-unblocked tasks."""
    task_id = task.get("id", "")[:8]
    task_title = task.get("title", "Unknown")
    thinking = task.get("thinking", "low")
    priority = task.get("priority", "normal")
    execution = get_task_execution_profile(task)
    spawn_cmd = build_spawn_command(task)

    lines = [
        f"## ORCHESTRATE: Spawn Agent for Task [{task_id}]",
        "",
        f"**Task:** {task_title}",
        f"**Priority:** {priority}",
        f"**Thinking Level:** {thinking}",
        f"**Harness:** {execution['harness']}",
        f"**Execution Mode:** {execution['mode']}",
        f"**Wake Type:** spawn_agent",
        "",
    ]

    if context.get("task_details"):
        lines.extend([
            "### Task Details",
            "```",
            context["task_details"][:1500],
            "```",
            "",
        ])

    if context.get("project_info"):
        lines.extend([
            "### Project Context",
            "```",
            context["project_info"][:1000],
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
        "This task is dependency-unblocked and ready to advance.",
        "Spawn it using the task's configured harness/profile instead of assuming OpenClaw cron semantics.",
        "",
        "**1. Review the task context (sanity check only):**",
        "```bash",
        f"clawboard get {task_id} -v",
        "```",
        "",
        "**2. Launch the task on the configured harness:**",
        "```bash",
        spawn_cmd,
        "```",
        "",
        "**3. Keep dependency flow intact:**",
        "- Do not rewrite the task's execution profile unless there's a clear blocker.",
        "- If spawn fails because the harness runtime is unavailable, leave a precise blocker/review note instead of silently switching harnesses.",
        "- The spawned implementation worker is not the final verifier of its own work. When it hands off, route it back through independent QA review before approval.",
        "",
        "**4. Log your action:**",
        "```bash",
        f"echo \"$(date -u +%Y-%m-%dT%H:%M:%S+00:00) | {task_id} | Spawned {execution['harness']} agent\" >> /tmp/orchestration-actions.log",
        "```",
    ])

    return "\n".join(lines)


def build_review_prompt(task: dict, context: dict,
                        subtask_analysis: dict) -> str:
    """Build the independent QA review prompt for tasks in review state."""
    task_id = task.get("id", "")[:8]
    task_title = task.get("title", "Unknown")
    review_subtasks = subtask_analysis.get("review_subtasks", [])
    counts = subtask_analysis.get("counts", {})

    lines = [
        f"## QA REVIEW: Independent Verification Needed for Task [{task_id}]",
        "",
        f"**Task:** {task_title}",
        f"**Wake Type:** review_needed",
        f"**Status Summary:** "
        f"{counts.get('review', 0)} in review, "
        f"{counts.get('completed', 0)} completed, "
        f"{counts.get('empty', 0)} not started, "
        f"{counts.get('in_progress', 0)} in progress",
        "",
        "You are the separate QA/orchestrator reviewer for this task.",
        "Do NOT trust the implementing subagent's claims as sufficient proof.",
        "Gather your own evidence, write a durable review report, then decide whether to pass, reject with feedback, escalate to a human, or respawn follow-up fix work.",
        "",
    ]

    if context.get("task_details"):
        lines.extend([
            "### Task Details",
            "```",
            context["task_details"][:1800],
            "```",
            "",
        ])

    lines.extend([
        "### Subtasks Awaiting Review",
        "",
    ])
    for st in review_subtasks:
        idx = st.get("index", "?")
        text = st.get("text", "Unknown subtask")
        lines.append(f"  🔄 **[{idx}]** {text}")
    lines.append("")

    if context.get("subtasks"):
        lines.extend(["### All Subtasks", ""])
        for i, subtask in enumerate(context["subtasks"]):
            lines.append(f"  {i}. {subtask}")
        lines.append("")

    lines.extend([
        "### ACTION REQUIRED",
        "",
        "**1. Start with task truth and current evidence:**",
        "```bash",
        f"clawboard get {task_id}",
        f"clawboard session-status {task_id}",
        "```",
        "",
        "**2. Inspect implementation evidence independently:**",
        "```bash",
        "git status --short --branch",
        "git log --oneline -10",
        "```",
        "",
        "**3. If browser or authenticated verification is needed, use the real QA path:**",
        "```bash",
        "~/tools/spark-browser-open 'https://nimspace.skyday.eu/dashboard-dev/'",
        "~/tools/spark-cdp-tunnel 9223",
        "~/tools/bw-ensure-session >/dev/null",
        "```",
        "Operator approval is already granted for Spark shared-browser and Bitwarden use in this smoke task.",
        "Do not print secrets into reports or chat.",
        "Do not use sudo in this QA run; you are already executing in the hermes OS-user context.",
        "",
        "**4. Write a durable QA report with evidence and findings:**",
        "```bash",
        f"clawboard report create 'QA review — {task_id}' --tasks {task_id} --tags qa,review",
        "```",
        "",
        "**5. Apply the decision based on your independent findings:**",
        "- **Pass:** approve every subtask that is actually in review, then move the task completed only when all subtasks are done:",
        "```bash",
        f"clawboard review {task_id}",
        f"clawboard approve-subtask {task_id} <index>",
        f"clawboard move {task_id} completed",
        "```",
        "- **Reject:** reject the failing reviewed subtask(s) with concrete evidence, move the task back to in-progress, then optionally respawn follow-up implementation work:",
        "```bash",
        f'clawboard reject-subtask {task_id} <index> --note "Concrete QA finding"',
        f"clawboard move {task_id} in-progress",
        f"clawboard spawn {task_id} --run --harness hermes --interactive",
        "```",
        "- **Escalate to human:** move to stuck or add blocked-human when judgment/risk is too high:",
        "```bash",
        f"clawboard move {task_id} stuck",
        f"clawboard update {task_id} --tags blocked-human",
        "```",
        "",
        "**6. Important policy:**",
        "- The implementing worker is not allowed to self-certify final acceptance.",
        "- If you spawn follow-up fix work, that new attempt must come back through QA review again before approval.",
        "- Prefer reject/escalate over a vague pass when evidence is weak.",
        "",
        "**7. Log your action:**",
        "```bash",
        f'echo "$(date -u +%Y-%m-%dT%H:%M:%S+00:00) | {task_id} | QA reviewed" >> /tmp/orchestration-actions.log',
        "```",
    ])

    return "\n".join(lines)

def build_stale_agent_prompt(task: dict, context: dict,
                             retry_count: int) -> str:
    """Build prompt for in-progress tasks with dead/stale agent sessions."""
    task_id = task.get("id", "")[:8]
    task_title = task.get("title", "Unknown")
    execution = get_task_execution_profile(task)
    runtime_status = fetch_task_session_status(task)
    runtime_meta = runtime_status.get("metadata") or {}

    lines = [
        f"## ORCHESTRATE: Stale Agent for Task [{task_id}]",
        "",
        f"**Task:** {task_title}",
        f"**Harness:** {execution['harness']}",
        f"**Execution Mode:** {execution['mode']}",
        f"**Wake Type:** stale_agent",
        f"**Attempt:** {retry_count + 1}",
        "",
    ]

    if retry_count >= ESCALATION_THRESHOLD:
        lines.extend(build_escalation_summary(task_id, retry_count, context))

    lines.extend([
        "### Runtime State",
        f"- **Harness:** {runtime_status.get('harness', execution['harness'])}",
        f"- **Session Key:** {runtime_status.get('sessionKey', execution['session_key']) or 'N/A'}",
        f"- **State:** {runtime_status.get('state', 'unknown')}",
        f"- **Interactive:** {runtime_status.get('interactive', execution['interactive'])}",
        f"- **Started At:** {runtime_status.get('startedAt', 'N/A')}",
    ])
    if runtime_meta.get("updatedAt"):
        lines.append(f"- **Last Runtime Update:** {runtime_meta.get('updatedAt')}")
    if runtime_meta.get("pid") is not None:
        lines.append(f"- **PID:** {runtime_meta.get('pid')}")
    if runtime_meta.get("pidAlive") is not None:
        lines.append(f"- **PID Alive:** {runtime_meta.get('pidAlive')}")
    if runtime_status.get("reason"):
        lines.append(f"- **Reason:** {runtime_status.get('reason')}")
    lines.append("")

    if context.get("process_state"):
        state = context["process_state"]
        lines.extend([
            "### Legacy Process State",
            f"- **Running:** {state.get('running', 'unknown')}",
            f"- **PID:** {state.get('pid', 'N/A')}",
            f"- **Last Updated:** {state.get('updated', 'N/A')}",
        ])
        if state.get("current"):
            lines.append(f"- **Current Step:** {state.get('current')}")
        if state.get("error"):
            lines.append(f"- **Error:** {state.get('error')}")
        lines.append("")

    if context.get("task_details"):
        lines.extend([
            "### Task Details",
            "```",
            context["task_details"][:1000],
            "```",
            "",
        ])

    lines.extend([
        "### ACTION REQUIRED",
        "",
        "**1. Check the harness-aware runtime status first:**",
        "```bash",
        f"clawboard session-status {task_id}",
        "```",
        "",
        "**2. Review task details and current progress:**",
        "```bash",
        f"clawboard get {task_id} -v",
        "```",
        "",
        "**3. Decide next action:**",
        "",
    ])

    if retry_count < ESCALATION_THRESHOLD:
        lines.extend([
            f"- **If finished:** `clawboard move {task_id} completed`",
            f"- **If recoverable:** restart via `{build_spawn_command(task)} --force` or leave a review note with exact recovery steps",
            f"- **If blocked on runtime or missing context:** `clawboard update {task_id} --tags blocked-human`",
            "",
        ])
    else:
        lines.extend([
            f"⚠️ **This task has stalled {retry_count} times.**",
            f"- **Escalate to a human unless you have a verified recovery path**",
            f"- **Or block it:** `clawboard update {task_id} --tags blocked-human`",
            "",
        ])

    lines.extend([
        "**Log your action:**",
        "```bash",
        f'echo "$(date -u +%Y-%m-%dT%H:%M:%S+00:00) | {task_id} | ACTION" '
        f">> /tmp/orchestration-actions.log",
        "```",
    ])

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
        f'echo "$(date -u +%Y-%m-%dT%H:%M:%S+00:00) | {task_id} | Completed — '
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
        "### ⚠️ STEP 0 — VERIFY BEFORE ACTING (stale-wake check)",
        "This wake may be STALE. FIRST verify the task's CURRENT status:",
        "```bash",
        f"clawboard get {task_id}",
        "```",
        "- If the task/subtasks are NO LONGER blocked (e.g. a human already "
        "reset the task to todo or unblocked the subtask), this wake is "
        "STALE: **do nothing**. Do NOT re-tag blocked-human, do NOT change "
        "task status, do NOT notify. Log 'stale escalate wake ignored' and "
        "stop.",
        "- Only proceed below if the blocked state is still current.",
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
        f'echo "$(date -u +%Y-%m-%dT%H:%M:%S+00:00) | {task_id} | ESCALATED — '
        f'blocked subtask, notified human" >> /tmp/orchestration-actions.log',
        "```",
    ])

    return "\n".join(lines)


def build_access_override_guidance(task: dict) -> list[str]:
    """Return policy guidance for orchestrator access/capability escalation."""
    execution = get_task_execution_profile(task)
    task_id = task.get("id", "")[:8]
    model = task.get("model") or HERMES_QA_MODEL
    caps = execution.get("required_capabilities") or []
    caps_text = ",".join(caps) if caps else ""
    suggested_caps = sorted(set(caps + ["browser", "host-browser", "elevated", "network", "long-running"]))
    suggested_caps_text = ",".join(suggested_caps)
    lines = [
        "### Access / spawn-override policy",
        "",
        f"- Current access profile: `{execution.get('access_profile', 'safe')}`",
        f"- Current required capabilities: `{caps_text or 'none'}`",
        f"- Allow spawn-time overrides: `{execution.get('allow_override_at_spawn')}`",
        f"- Saved model: `{model}`",
        "",
        "If the previous worker was blocked only because its runtime lacked access/tools, do not treat that as task failure by itself.",
    ]
    if execution.get("allow_override_at_spawn"):
        lines.extend([
            "Because spawn-time overrides are allowed, you may broaden the next attempt just enough to satisfy the missing capability boundary.",
            "Prefer the host-side Hermes QA/orchestrator path you are already running in for Bitwarden/Spark/browser/SSH checks; it has the real homelab access that the backend-container implementation worker may lack.",
            "If you respawn an implementation worker, make the added access explicit and preserve the task model:",
            "```bash",
            f"clawboard spawn {task_id} --run --harness hermes --interactive --model {model} --access-profile elevated --required-capabilities {suggested_caps_text} --force",
            "```",
            "Only add valid ClawBoard capability tags. Put specific missing tools such as Bitwarden, SSH, n8n API, and NFS verification into execution notes / reports rather than invalid capability tags.",
        ])
    else:
        lines.extend([
            "Spawn-time overrides are NOT allowed. Stay within the saved execution profile.",
            "If required access is missing, do not silently broaden permissions or switch runtimes. Leave a precise blocker report and escalate to the human/orchestrator.",
        ])
    lines.extend([
        "",
        "Use ClawBoard via the CLI, not raw API calls. In this host-side QA run prefer:",
        "```bash",
        "export CLAWBOARD_QA_AGENT=1 CLAWBOARD_ROLE=qa",
        "CB=\"python3 cli/clawboard\"",
        f"$CB get {task_id}",
        f"$CB session-status {task_id}",
        "```",
        "Do not use sudo for ClawBoard/Spark/Bitwarden helper commands in the Hermes QA worker; it is already running as the hermes OS user with the intended helper access.",
    ])
    return lines

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

    lines.extend(build_access_override_guidance(task))

    lines.extend([
        "",
        "### ACTION REQUIRED",
        "",
        "This is a stuck-task orchestration wake, not automatically a QA approval wake.",
        "First decide whether the task is genuinely ready for review, needs a capability-aware continuation, or must remain blocked.",
        "",
        "**1. Check task/session truth:**",
        "```bash",
        f"$CB get {task_id}",
        f"$CB session-status {task_id}",
        "```",
        "",
        "**2. If subtasks are still empty/in-progress:**",
        "- Do not approve them as review work.",
        "- If missing access is the blocker and overrides are allowed, continue/respawn with the explicit missing capabilities above.",
        "- If you can safely perform the narrow fix from this host-side QA context, do it, then return the task to the normal implementation/review workflow with a durable report.",
        "",
        "**3. If subtasks are actually in review:**",
        f"- Approve: `$CB approve-subtask {task_id} INDEX`",
        f'- Reject: `$CB reject-subtask {task_id} INDEX --note "Concrete reason"`',
        "",
        "**4. Completion / handoff policy:**",
        f"- If you respawn/continue work: `$CB move {task_id} in-progress` and use the override-aware spawn command when allowed.",
        f"- If you cannot proceed within allowed access: `$CB move {task_id} stuck` and create/link a blocker report.",
        f"- If all implementation subtasks are finished: `$CB review {task_id}` and stop; independent QA must verify next.",
        "",
        "**5. Log your action:**",
        "```bash",
        f'echo "$(date -u +%Y-%m-%dT%H:%M:%S+00:00) | {task_id} | ACTION" >> /tmp/orchestration-actions.log',
        "```",
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
    """Check for recently active task workers across OpenClaw and Hermes."""
    cutoff = datetime.now(timezone.utc) - timedelta(
        minutes=ACTIVE_AGENT_THRESHOLD)

    # Preserve the legacy OpenClaw session-file scan for parity.
    if SESSIONS_DIR.exists():
        log(f"Checking OpenClaw sessions modified after {cutoff.isoformat()}")
        try:
            for entry in SESSIONS_DIR.iterdir():
                if entry.suffix != ".jsonl" or ".deleted." in entry.name:
                    continue
                mtime = datetime.fromtimestamp(entry.stat().st_mtime,
                                               tz=timezone.utc)
                if mtime <= cutoff:
                    continue
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
                    log(f"  Skipping unreadable: {entry.name}")
                    continue
                log(f"  Active OpenClaw subagent: {entry.name} (modified {mtime.isoformat()})")
                return True, entry.name
        except OSError as e:
            log(f"Error reading OpenClaw sessions: {e}")

    # Hermes tasks do not emit OpenClaw JSONL session files, so consult the
    # harness-aware session-status adapter for any in-progress Hermes tasks.
    try:
        for task in fetch_tasks_by_status("in-progress"):
            execution = get_task_execution_profile(task)
            if execution["harness"] != "hermes" or not execution["session_key"]:
                continue
            runtime_status = fetch_task_session_status(task)
            is_active, reason = runtime_status_is_active(runtime_status)
            if is_active:
                return True, f"{task.get('id', '')[:8]} ({reason})"
    except Exception as e:
        log(f"Failed to inspect Hermes runtime activity: {e}")

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


def hardened_orchestration_enabled() -> bool:
    """Parse the transactional scheduler switch exactly and fail closed."""
    raw = os.getenv(HARDENED_ORCHESTRATION_ENV, "false")
    if raw == "true":
        return True
    if raw == "false" or raw == "":
        return False
    raise RuntimeError(f"{HARDENED_ORCHESTRATION_ENV} must be exactly true or false")


def claim_hardened_spawn(task: dict) -> bool:
    """Reserve a spawn atomically when the hardened rollout is enabled."""
    if not hardened_orchestration_enabled():
        return True
    if DRY_RUN:
        log(f"Dry run - would transactionally claim {task.get('id', '')[:8]}")
        return True

    task_id = str(task.get("id") or "")
    snapshot = task.get("updated") or task.get("updatedAt") or task.get("updated_at")
    execution = get_task_execution_profile(task)
    harness = execution.get("harness")
    project_key = task.get("projectId") or task.get("project_id") or task.get("project") or "unscoped"
    if not task_id or not snapshot or harness not in ("hermes", "openclaw"):
        log(f"Hardened claim rejected locally for {task_id[:8]}: missing task snapshot/harness")
        return False

    raw_ttl = os.getenv(HARDENED_LEASE_TTL_ENV, "900000")
    if not raw_ttl.isdigit():
        log(f"Hardened claim rejected locally: {HARDENED_LEASE_TTL_ENV} must be an integer")
        return False
    ttl_ms = int(raw_ttl)
    if ttl_ms < 30000 or ttl_ms > 3600000:
        log(f"Hardened claim rejected locally: {HARDENED_LEASE_TTL_ENV} is out of bounds")
        return False

    response = api_post(f"/tasks/orchestration/{task_id}/claim", {
        "snapshotUpdatedAt": snapshot,
        "harness": harness,
        "resourceKey": f"project:{project_key}",
        "ttlSeconds": ttl_ms // 1000,
        "metadata": {"source": "clawbeat", "wakeType": WAKE_TYPE_SPAWN},
    })
    lease = response.get("lease") if response.get("success") else None
    if not isinstance(lease, dict) or not lease.get("id"):
        log(f"Hardened claim failed for {task_id[:8]}; spawn wake suppressed")
        return False
    if response.get("acquired") is not True:
        log(f"Hardened claim replayed for {task_id[:8]}; duplicate spawn wake suppressed")
        return False
    log(f"Hardened claim reserved task {task_id[:8]} with lease {str(lease['id'])[:8]}")
    return True


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


def detect_dead_agent_session(task_id: str, task: dict | None = None,
                              runtime_status: dict | None = None) -> tuple[bool, str]:
    """Check if task shows in-progress but a previously linked agent session is dead."""
    task = task or {}
    execution = get_task_execution_profile(task)
    session_key = execution["session_key"]
    harness = execution["harness"]

    if harness == "hermes":
        runtime_status = runtime_status or fetch_task_session_status(task)
        state = str(runtime_status.get("state") or "unknown")
        updated = get_runtime_status_timestamp(runtime_status)
        cutoff = datetime.now(timezone.utc) - timedelta(
            minutes=PROCESS_STALE_THRESHOLD)
        meta = runtime_status.get("metadata") or {}
        pid_alive = bool(meta.get("pidAlive"))

        if runtime_status.get("lookupFailed"):
            return False, ""
        if state in ("starting", "running"):
            return False, ""
        if state == "completed":
            return False, ""
        if state == "failed":
            return True, "Hermes session failed"
        if state == "idle":
            if updated is not None and updated < cutoff:
                return True, (
                    f"Hermes session idle since {updated.isoformat()}"
                )
            if updated is None and not pid_alive and session_key:
                return True, "Hermes session idle with no live pid or timestamp"
            return False, ""
        if state in ("none", "unknown") and session_key and not pid_alive:
            if updated is not None and updated < cutoff:
                return True, f"Hermes session unavailable since {updated.isoformat()}"
            return False, ""
        return False, ""

    status_file = get_task_status_file(task_id)
    has_status_file = status_file.exists()

    # No linked child session and no tracked external process means there is
    # nothing concrete to call "dead". Skip stale-agent classification.
    if not session_key and not has_status_file:
        return False, ""

    session_info = check_session_file_activity(
        task_id, minutes=PROCESS_STALE_THRESHOLD)

    if session_info.get("active"):
        return False, ""

    if has_status_file:
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

    # If there was a linked session key but no recent session activity, that is
    # meaningful stale evidence.
    if session_key:
        return True, f"Linked session inactive: {session_key}"

    return False, ""


# ─── Externally-Managed Task Detection ───
#
# An in-progress task with NO activeAgent AND empty sessionRefs is
# externally managed: the orchestrator is working it directly, without a
# spawned agent session. There is nothing for clawbeat to restart and
# nothing meaningful to stuck-mark. Evidence of the failure mode this
# guards against: 2026-07-04 00:55 "Stale OpenClaw restart failed; task
# marked stuck" fired on dde076d7/9b0b4b22 while the orchestrator was
# actively working both tasks.

def is_externally_managed(task: dict) -> bool:
    """Return True when the task has no agent session at all.

    No current activeAgent/session and either no history or an explicit
    autoStart=false main-session profile = orchestrator-direct work.
    """
    active_agent = task.get("activeAgent") or {}
    current_session = (task.get("acpSessionKey")
                       or task.get("acp_session_key")
                       or active_agent.get("sessionKey"))
    session_refs = task.get("sessionRefs") or []
    if active_agent or current_session:
        return False

    execution = get_task_execution_profile(task)
    # Main-session tasks with auto pickup explicitly disabled are direct work.
    # Historical sessionRefs are audit history and must not make ClawBeat
    # restart/stuck-mark a task that has no current writer runtime.
    if task.get("autoStart") is False and execution.get("mode") == "main":
        return True

    return not session_refs


def get_task_in_progress_hours(task: dict) -> float | None:
    """Hours since the task entered in-progress.

    Prefers startedAt; falls back to updated-style timestamps. Returns None
    when no usable timestamp is present.
    """
    for field in (
        "startedAt", "started_at",
        "inProgressAt", "in_progress_at",
        "updatedAt", "updated_at", "updated",
    ):
        ts_str = task.get(field)
        if not ts_str:
            continue
        ts = _parse_iso_timestamp(str(ts_str))
        if ts is None:
            continue
        return (datetime.now(timezone.utc) - ts).total_seconds() / 3600
    return None


def build_externally_managed_escalation_prompt(task: dict,
                                               hours: float) -> str:
    """Escalation prompt for an externally-managed task in progress >12h."""
    task_id = task.get("id", "")[:8]
    task_title = task.get("title", "Unknown")

    lines = [
        f"## 🚨 ESCALATE: Externally Managed Task [{task_id}] "
        f"In Progress > {EXTERNALLY_MANAGED_MAX_HOURS}h",
        "",
        f"**Task:** {task_title}",
        f"**Wake Type:** escalate_human",
        f"**In progress for:** {hours:.1f} hours",
        "",
        "This task has NO agent session (no activeAgent, empty sessionRefs) —",
        "it is externally managed (orchestrator-direct work). Clawbeat will",
        "NOT restart it or mark it stuck; there is no agent session to",
        "restart.",
        "",
        "### ACTION REQUIRED",
        "",
        "**1. Check whether the work is still genuinely in flight:**",
        "```bash",
        f"clawboard get {task_id}",
        "```",
        "",
        "**2. Decide manually:**",
        f"- Still being worked → leave it alone.",
        f"- Finished → `clawboard move {task_id} completed`",
        f"- Abandoned → move it back to todo, or block it: "
        f"`clawboard update {task_id} --tags blocked-human`",
        "",
        "**Log your action:**",
        "```bash",
        f'echo "$(date -u +%Y-%m-%dT%H:%M:%S+00:00) | {task_id} | ACTION" '
        f">> /tmp/orchestration-actions.log",
        "```",
    ]
    return "\n".join(lines)


def handle_externally_managed_task(task: dict) -> bool:
    """Guard used by the stale-agent and legacy-stuck steps.

    Returns True when the task is externally managed — the caller MUST skip
    all restart/stuck-marking for it. As a side effect, escalates via a
    normal escalate wake (subject to the usual dedup suppression) when the
    task has been in-progress for more than EXTERNALLY_MANAGED_MAX_HOURS.
    Returns False when the task has an agent session (normal handling).
    """
    if not is_externally_managed(task):
        return False

    task_id = task.get("id", "")
    log(f"  Task {task_id[:8]}: externally managed (no agent session) "
        f"- skipping")

    hours = get_task_in_progress_hours(task)
    if hours is None or hours <= EXTERNALLY_MANAGED_MAX_HOURS:
        return True

    if should_suppress_wake(task_id, WAKE_TYPE_ESCALATE):
        log(f"  Suppressed externally-managed escalation for {task_id[:8]}")
        return True

    message = build_externally_managed_escalation_prompt(task, hours)
    output_wake(
        reason=(f"Externally managed task {task_id[:8]} in-progress for "
                f"{hours:.0f}h — needs human check"),
        message=message,
        task_id=task_id,
        attempt=1,
        recommended_action="escalate_human",
        wake_type=WAKE_TYPE_ESCALATE,
    )
    return True


# ─── Dedup Logic (Lifecycle-Aware) ───

# Action types that indicate a true resolution (suppress subsequent WAKEs permanently)
# Only terminal states: task is done or needs human intervention.
# Everything else (approved, rejected, reviewed) should re-notify the orchestrator.
RESOLUTION_ACTIONS = {
    # Terminal state only. Do not treat phrases like "blocked subtask" as
    # permanent resolution; those still require orchestration after unblocking.
    "completed"
}

# Action types that indicate an agent is working (time-limited suppression)
# Uses ACTIVE_AGENT_THRESHOLD (9min) — if agent hasn't reported back, re-evaluate.
AGENT_ACTIONS = {"spawned", "agent_running"}

# Non-terminal orchestrator actions — suppress briefly then re-notify
# These need orchestrator follow-up (send back to agent, complete, or block)
ORCHESTRATOR_ACTIONS = {"escalated", "reviewed", "approved", "rejected"}

# Action types that are just notifications
WAKE_ACTIONS = {"wake sent by clawbeat", "wake"}


def _parse_orchestration_log_file(path: Path, max_lines: int = 50
                                  ) -> list[tuple[datetime, str, str]]:
    """Parse one orchestration actions ledger file.

    Format: ISO_TIMESTAMP | TASK_ID | ACTION_TAKEN
    Also supports legacy HH:MM format (assumes today, with midnight rollback).
    Returns list of (datetime, task_id, action).
    """
    if not path.exists():
        return []

    entries = []
    now = datetime.now(timezone.utc)

    try:
        with open(path) as f:
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
                    # Try ISO format first (new format)
                    entry_time = _parse_iso_timestamp(time_str)
                    if entry_time is None:
                        # Legacy HH:MM format — assume today, but roll back
                        # to yesterday if result would be in the future
                        hour, minute = map(int, time_str.split(":"))
                        entry_time = datetime(
                            now.year, now.month, now.day,
                            hour, minute, tzinfo=timezone.utc)
                        if entry_time > now:
                            entry_time -= timedelta(days=1)
                    entries.append((entry_time, task_id, action))
                except ValueError:
                    log(f"Failed to parse log line: {line}")
    except OSError as e:
        log(f"Failed to read orchestration log {path}: {e}")

    return entries


def parse_orchestration_log(max_lines: int = 50
                            ) -> list[tuple[datetime, str, str]]:
    """Parse the orchestration dedup ledger (durable path is authoritative).

    During the durable-state rollout, orchestrator agents may still append
    action lines only to the legacy /tmp ledger, so legacy-only entries are
    merged in (exact duplicates from clawbeat's dual-write are dropped) and
    the combined list is sorted chronologically — callers rely on
    reversed(entries) returning the most recent action first.
    """
    entries = _parse_orchestration_log_file(ORCHESTRATION_LOG, max_lines)
    legacy_entries = _parse_orchestration_log_file(
        LEGACY_ORCHESTRATION_LOG, max_lines)

    if not entries and not legacy_entries:
        log("No orchestration log found")
        return []

    if legacy_entries:
        seen = set(entries)
        entries.extend(e for e in legacy_entries if e not in seen)
        entries.sort(key=lambda e: e[0])

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


# ─── Blocked-Human Task Notifications ───
#
# When the orchestrator marks a task as blocked-human (status=stuck +
# tag "blocked-human"), there is no one to automatically pick it back up.
# Clawbeat detects these tasks and sends a direct Discord DM to the human
# (Wadera) so she knows to unblock the work.
#
# Flow:
#   1. Fetch all stuck tasks that have the "blocked-human" tag.
#   2. For each task NOT yet recorded in BLOCKED_NOTIFY_FILE, send a WAKE
#      event to the main session with instructions to DM the human.
#   3. Record the notification in BLOCKED_NOTIFY_FILE so future heartbeats
#      do NOT repeat the same DM.
#   4. When a task is no longer stuck/blocked-human (orchestration resolved
#      it), remove it from BLOCKED_NOTIFY_FILE so a new notification fires
#      if the task ever enters the blocked state again.
#
# This check runs BEFORE the active-sub-agent guard so that blocked tasks
# always reach the human even while agents are busy on other tasks.

def load_blocked_notify_tracker() -> dict:
    """Load the blocked-human notification dedup tracker from disk.

    Returns a dict keyed by 8-char task ID short form:
        {"<short_id>": {"notified_at": "<ISO>", "title": "<str>"}, ...}
    Returns empty dict on failure or if the file doesn't exist yet.
    """
    if not BLOCKED_NOTIFY_FILE.exists():
        return {}
    try:
        with open(BLOCKED_NOTIFY_FILE) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        log(f"Failed to load blocked notify tracker: {e}")
        return {}


def save_blocked_notify_tracker(data: dict) -> None:
    """Persist the blocked-human notification tracker to disk.

    No-op in dry-run mode to avoid side effects during testing.
    """
    if DRY_RUN:
        log("Dry run - skipping blocked notify tracker save")
        return
    try:
        with open(BLOCKED_NOTIFY_FILE, "w") as f:
            json.dump(data, f, indent=2)
    except OSError as e:
        log(f"Failed to save blocked notify tracker: {e}")


def should_notify_blocked_human(task_id: str) -> bool:
    """Return True if we should send a Discord notification for this task.

    Suppresses the notification if the task ID is already recorded in
    BLOCKED_NOTIFY_FILE (meaning we already DM'd the human for it).
    The entry is only removed when the task is no longer stuck/blocked-human,
    so re-notification only happens if the task unblocks and re-blocks later.

    Dry-run mode always returns True (simulate, never suppress).
    """
    if DRY_RUN:
        log("Dry run - not suppressing blocked-human notification")
        return True

    tracker = load_blocked_notify_tracker()
    short_id = task_id[:8]

    if short_id in tracker:
        notified_at = tracker[short_id].get("notified_at", "?")
        log(f"  Suppressing blocked-human notification for {short_id} "
            f"(already notified at {notified_at})")
        return False

    return True


def record_blocked_human_notified(task_id: str, task_title: str) -> None:
    """Record receipt-backed blocked-human notification completion.

    Called only AFTER the backend durable notification route returns sent or
    deduplicated with a transport receipt. Failed delivery remains retryable.
    The entry is cleaned up by clean_blocked_notify_tracker() when the task
    leaves stuck/blocked-human.
    """
    if DRY_RUN:
        log(f"Dry run - would record blocked-human notification for "
            f"{task_id[:8]}")
        return

    tracker = load_blocked_notify_tracker()
    short_id = task_id[:8]
    now = datetime.now(timezone.utc).isoformat()
    tracker[short_id] = {
        "notified_at": now,
        "title": task_title,
    }
    save_blocked_notify_tracker(tracker)
    log(f"Recorded blocked-human notification for {short_id}")


def clean_blocked_notify_tracker(current_blocked_short_ids: set) -> None:
    """Remove tracker entries for tasks that are no longer blocked-human.

    Called after fetching the current set of stuck+blocked-human tasks.
    Any tracker entry whose ID is NOT in current_blocked_short_ids means
    the task has been unblocked (or completed/archived), so we remove it.
    This allows a fresh notification if the task somehow becomes
    stuck+blocked-human again in the future.
    """
    if DRY_RUN:
        return

    tracker = load_blocked_notify_tracker()
    if not tracker:
        return

    to_remove = [
        short_id for short_id in tracker
        if short_id not in current_blocked_short_ids
    ]

    if to_remove:
        for short_id in to_remove:
            log(f"  Clearing blocked notify entry for {short_id} "
                f"(task no longer stuck/blocked-human)")
            del tracker[short_id]
        save_blocked_notify_tracker(tracker)
        log(f"Cleared {len(to_remove)} resolved blocked-human tasks "
            f"from tracker")


def fetch_blocked_human_stuck_tasks() -> list:
    """Fetch tasks with status=stuck AND the 'blocked-human' tag.

    These are tasks the orchestrator has explicitly flagged as needing
    human intervention.  The regular check_stuck_tasks() skips them;
    this function collects them specifically for Discord notification.
    """
    data = api_get("/tasks?status=stuck")
    tasks = data.get("tasks", [])
    blocked = []
    for t in tasks:
        tags = t.get("tags", [])
        if "blocked-human" in tags:
            blocked.append(t)
            log(f"  Found stuck+blocked-human task: "
                f"{t.get('id', '?')[:8]} — {t.get('title', '')[:60]}")
    log(f"Found {len(blocked)} stuck+blocked-human task(s)")
    return blocked


def get_blocked_reason(task: dict) -> str:
    """Extract a human-readable blocked reason from a task.

    Checks in priority order:
    1. Any subtask's blockedReason field (set when a subtask is blocked).
    2. Task-level notes field (free-form orchestrator note).
    3. First 200 chars of description (fallback if notes absent).
    4. Hardcoded fallback: "No reason provided".
    """
    # 1. Subtask blockedReason
    subtasks = task.get("subtasks", [])
    for st in subtasks:
        reason = st.get("blockedReason") or st.get("blocked_reason")
        if reason:
            return str(reason).strip()

    # 2. Task notes
    notes = task.get("notes") or task.get("note")
    if notes:
        return str(notes).strip()[:300]

    # 3. Description (truncated)
    desc = task.get("description")
    if desc:
        desc = str(desc).strip()
        return desc[:200] + ("…" if len(desc) > 200 else "")

    return "No reason provided"


def build_blocked_human_discord_msg(task: dict, blocked_reason: str) -> str:
    """Build the Discord DM text sent to Wadera for a blocked task.

    Kept concise — this is a notification message, not a wall of text.
    Includes task title, short ID, the blocked reason, and a deep link
    to the task on the ClawBoard dashboard.
    """
    task_id = task.get("id", "")
    task_title = task.get("title", "Unknown task")
    short_id = task_id[:8]
    dashboard_link = f"{DASHBOARD_URL}/tasks/{task_id}"

    lines = [
        "🚧 **Task blocked — needs your attention**",
        "",
        f"**Task:** {task_title}",
        f"**ID:** `{short_id}`",
        f"**Status:** Stuck — waiting for human intervention",
        "",
        f"**Reason:** {blocked_reason}",
        "",
        f"**Dashboard:** <{dashboard_link}>",
    ]
    return "\n".join(lines)


def build_blocked_human_wake_message(
    task: dict,
    blocked_reason: str,
    discord_msg: str,
) -> str:
    """Build the WAKE / system-event message delivered to the main session.

    The orchestrator (main session AI) receives this via system-event and
    must:
      1. Send the Discord DM using the message tool.
      2. Log the action to /tmp/orchestration-actions.log.

    The message intentionally avoids triggering any spawning or review
    actions — it is purely a notification dispatch task.
    """
    task_id = task.get("id", "")
    task_title = task.get("title", "Unknown task")
    short_id = task_id[:8]

    escaped_msg = discord_msg.replace('"""', '"')

    if get_wake_delivery_config()["primary"] == "hermes":
        how_to_send = [
            "### How to Send (Discord — native)",
            "You are the Hermes orchestrator with your own Discord access.",
            f"- DM Wadera on Discord directly ({DISCORD_NOTIFY_USER}) or "
            "reply in the channel you share with her.",
            "- Or use: `hermes send --to discord:<wadera-dm-or-ops-channel> "
            '"<message>"`',
        ]
    else:
        how_to_send = [
            "### How to Send (message tool)",
            "```python",
            f'message(action="send", target="{DISCORD_NOTIFY_USER}",',
            f'        message="""{escaped_msg}""")',
            "```",
        ]

    lines = [
        f"## NOTIFY: Blocked Task [{short_id}] — Send Discord DM to Wadera",
        "",
        "### ⚠️ STEP 0 — VERIFY BEFORE ACTING (stale-wake check)",
        "This wake may be STALE. FIRST verify the task's CURRENT status:",
        "```bash",
        f"clawboard get {short_id}",
        "```",
        "- If the task is NO LONGER stuck / blocked-human (e.g. a human "
        "already reset it to todo, or it moved on), this wake is STALE: "
        "**do nothing**. Do NOT re-tag blocked-human, do NOT change task "
        "status, do NOT send the DM. Log 'stale blocked-human wake "
        "ignored' and stop.",
        "- Only proceed below if the task is still stuck and waiting on a "
        "human.",
        "",
        "**Action Required:** Send the Discord DM below to Wadera, then log "
        "the action.",
        "",
        "### Discord Message to Send",
        "```",
        discord_msg,
        "```",
        "",
        *how_to_send,
        "",
        f"**Task:** {task_title}",
        f"**ID:** {short_id}",
        f"**Blocked Reason:** {blocked_reason}",
        "",
        "### ⚠️ Notes — Read Before Acting",
        "- This is a **direct notification**, NOT an orchestration wake.",
        "- Do NOT spawn agents, review subtasks, or change task status.",
        "- Just send the Discord DM and log the action below.",
        "- Clawbeat will **suppress future notifications** for this task "
        "until it leaves the stuck+blocked-human state.",
        "",
        "### Log Action After Sending",
        "```bash",
        f'echo "$(date -u +%Y-%m-%dT%H:%M:%S+00:00) | {short_id} | '
        f'blocked-human-notified" >> /tmp/orchestration-actions.log',
        "```",
    ]
    return "\n".join(lines)


def check_and_notify_blocked_human_tasks() -> None:
    """Detect stuck+blocked-human tasks and trigger Discord notifications.

    This is called as the very first check in run_heartbeat() so that
    blocked-task notifications are never delayed by agent activity.

    Algorithm:
      1. Fetch all stuck tasks that carry the 'blocked-human' tag.
      2. Clean up the dedup tracker for tasks that are no longer blocked.
      3. For each task not yet in the dedup tracker, send ONE wake event
         (which tells the main session to DM Wadera) and return immediately.
         The remaining tasks will be picked up on subsequent heartbeat ticks.
      4. If all blocked tasks are already in the tracker, return silently
         (don't exit — let the normal heartbeat logic continue).
    """
    log("Step 0: Checking for stuck+blocked-human tasks (Discord notify)...")
    blocked_tasks = fetch_blocked_human_stuck_tasks()

    # Compute short IDs of currently blocked tasks for tracker cleanup.
    current_ids = {t.get("id", "")[:8] for t in blocked_tasks}
    clean_blocked_notify_tracker(current_ids)

    for task in blocked_tasks:
        task_id = task.get("id", "")
        task_title = task.get("title", "Unknown")

        if not should_notify_blocked_human(task_id):
            continue  # Already notified — suppress.

        blocked_reason = get_blocked_reason(task)
        discord_msg = build_blocked_human_discord_msg(task, blocked_reason)
        wake_msg = build_blocked_human_wake_message(
            task, blocked_reason, discord_msg)

        state_version = str(task.get("updated") or task.get("updatedAt") or
                            task.get("updated_at") or "stuck")
        delivery = api_post(
            f"/tasks/{task_id}/notifications/deliver",
            {
                "kind": "blocked-human",
                "stateVersion": state_version,
                "message": discord_msg,
            },
        )
        if delivery.get("status") in ("sent", "deduplicated"):
            record_blocked_human_notified(task_id, task_title)
            log(f"  Receipt-backed blocked-human notification complete for "
                f"{task_id[:8]} ({delivery.get('status')})")
            continue

        # Compatibility fallback while the new route is unavailable. Do not
        # complete dedup: a provisional wake is not a transport receipt and
        # failed delivery must remain retryable on the next heartbeat tick.
        log(f"  Durable blocked-human notification unavailable for "
            f"{task_id[:8]}; falling back without completing dedup")

        log(f"  Sending blocked-human notification fallback for "
            f"{task_id[:8]}: {task_title}")

        output_wake(
            reason=(f"Task {task_id[:8]} blocked — needs human attention: "
                    f"{task_title}"),
            message=wake_msg,
            task_id=task_id,
            attempt=1,
            recommended_action="notify_human",
            wake_type=WAKE_TYPE_BLOCKED_HUMAN,
        )
        # output_wake calls sys.exit; subsequent tasks handled next tick.

    log("Step 0 complete — no new blocked-human tasks to notify")


# ─── Main Decision Tree (Lifecycle-Aware) ───

def run_heartbeat() -> None:
    """Execute the lifecycle-aware heartbeat decision tree.

    Priority order:
    1. Discover active sub-agents (conflict diagnostics; no global early return)
    2. Blocked subtasks → escalate_human (suppress future wakes)
    3. All subtasks done → complete_task
    4. Subtasks in review → review_needed
    5. Stuck tasks (legacy) → review_needed
    6. Stale/dead agents → stale_agent
    7. Auto-start tasks (with dep check) → spawn_agent
    8. Maintenance
    9. All clear
    """
    SESSION_STATUS_CACHE.clear()

    # ── Durable state: migrate any legacy /tmp state files on start ──
    migrate_legacy_state_files()

    # ── Step 0: Check for stuck+blocked-human tasks and notify Wadera ──
    # Must run BEFORE the active-sub-agent guard so the human always gets
    # notified immediately, even when agents are busy with other tasks.
    check_and_notify_blocked_human_tasks()

    # ── Step 1: Check active sub-agents ──
    log("Step 1: Checking active sub-agents...")
    is_active, session_name = check_active_subagents()
    if is_active:
        # Active work is a task/resource conflict signal, not a global board
        # lock. Continue so unrelated review, escalation, completion and ready
        # tasks remain observable; candidate-specific guards below still avoid
        # duplicate work for the same task/session.
        log(f"  Active sub-agent observed: {session_name}; continuing per-task classification")

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

        # Priority 3: Review is ready only after all required implementation
        # work has reached review/completed/skipped. A later empty subtask means
        # the sequential implementation slice is not ready for QA yet.
        if analysis["review_ready"]:
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

            should_route, route_reason = should_route_orchestration_wake(task)
            if not should_route:
                log(f"  Skipping escalation for {task_id[:8]} ({route_reason})")
                continue

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

            should_route, route_reason = should_route_orchestration_wake(task)
            if not should_route:
                log(f"  Skipping completion wake for {task_id[:8]} ({route_reason})")
                continue

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

            should_route, route_reason = should_route_orchestration_wake(task)
            if not should_route:
                log(f"  Skipping review wake for {task_id[:8]} ({route_reason})")
                continue

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
        # Direct/main-session work is normally excluded from legacy restart
        # churn, but a blocked subtask is still a real escalation signal and
        # must not disappear merely because no child session exists.
        stuck_tasks = [
            t for t in stuck_tasks
            if analyze_subtask_states(t.get("subtasks", []))["has_blocked"]
            or not handle_externally_managed_task(t)
        ]
    if stuck_tasks:
        task = stuck_tasks[0]
        task_id = task.get("id", "")

        # Analyze subtasks for stuck tasks too
        subtasks = task.get("subtasks", [])
        analysis = analyze_subtask_states(subtasks)

        # If stuck task has blocked subtasks, treat as escalation
        if analysis["has_blocked"]:
            should_route, route_reason = should_route_orchestration_wake(task)
            if not should_route:
                log(f"  Skipping stuck escalation for {task_id[:8]} ({route_reason})")
            elif not should_suppress_wake(task_id, WAKE_TYPE_ESCALATE):
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
            should_route, route_reason = should_route_orchestration_wake(task)
            if not should_route:
                log(f"  Skipping stuck completion wake for {task_id[:8]} ({route_reason})")
            elif not should_suppress_wake(task_id, WAKE_TYPE_COMPLETE):
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
            should_route, route_reason = should_route_orchestration_wake(task)
            if not should_route:
                log(f"  Skipping stuck review for {task_id[:8]} ({route_reason})")
            elif not should_suppress_wake(task_id, WAKE_TYPE_REVIEW):
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

            # ── Externally managed (no activeAgent, empty sessionRefs) ──
            # Orchestrator-direct work: never restart or stuck-mark. Only a
            # >12h in-progress age escalates (handled inside the guard).
            if handle_externally_managed_task(task):
                continue

            execution = get_task_execution_profile(task)
            runtime_status = fetch_task_session_status(task)

            # ── Grace period: skip recently-spawned tasks ──
            # Freshly launched tasks need time to register with their runtime.
            is_recent, grace_reason = is_task_recently_spawned(task)
            if is_recent:
                log(f"  Skipping stale check for {task_id[:8]} "
                    f"(within grace period: {grace_reason})")
                continue

            # ── Harness-specific active checks ──
            if execution["harness"] == "openclaw":
                runtime_active, runtime_reason = runtime_status_is_active(
                    runtime_status, active_minutes=PROCESS_STALE_THRESHOLD)
                if runtime_active:
                    log(f"  Skipping stale check for {task_id[:8]} "
                        f"({runtime_reason})")
                    continue
                cron_active, cron_reason = is_cron_session_active(task)
                if cron_active:
                    log(f"  Skipping stale check for {task_id[:8]} "
                        f"({cron_reason})")
                    continue
            else:
                runtime_active, runtime_reason = runtime_status_is_active(
                    runtime_status, active_minutes=PROCESS_STALE_THRESHOLD)
                if runtime_active:
                    log(f"  Skipping stale check for {task_id[:8]} "
                        f"({runtime_reason})")
                    continue

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
            is_dead, dead_reason = detect_dead_agent_session(
                task_id, task, runtime_status)
            if is_dead:
                should_route, route_reason = should_route_orchestration_wake(task)
                if not should_route:
                    log(f"  Skipping stale-agent wake for {task_id[:8]} ({route_reason})")
                    continue
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

            # Legacy external process files still matter for OpenClaw and any
            # older workflows that write /tmp/task-<id>-status.json.
            proc_status, reason = check_process_status(task)
            if proc_status != "alive":
                should_route, route_reason = should_route_orchestration_wake(task)
                if not should_route:
                    log(f"  Skipping legacy process-stale wake for {task_id[:8]} ({route_reason})")
                    continue
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

        # Quota guard — defer spawn wakes when the provider-quota budget is
        # exhausted. Deliberately quiet: no stuck-marking, no notification;
        # the task is retried on a later tick once the window rolls over.
        should_defer, defer_reason = check_quota_guard()
        if should_defer:
            cron_log(f"quota guard: deferring spawn wake for {task_id[:8]} "
                     f"({defer_reason})")
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
                    f"{RETRY_TRACKER_FILE}\n"
                ),
                task_id=task_id,
                attempt=get_spawn_count_last_hour(task_id) + 1,
                recommended_action="escalate_human",
                wake_type=WAKE_TYPE_ESCALATE,
            )

        # Reserve the task only after every advisory guard passes. The backend
        # transaction rechecks snapshot, dependencies, harness and capacity.
        if not claim_hardened_spawn(task):
            continue

        # Gather context and build spawn prompt
        log(f"Preparing spawn for {task_id[:8]}...")
        record_spawn(task_id)
        record_quota_event("spawn_wakes")
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
    global VERBOSE, DRY_RUN, CRON_MODE

    parser = argparse.ArgumentParser(
        description="Heartbeat watchdog CLI for OpenClaw orchestration "
                    "(lifecycle-aware)"
    )
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Enable debug output to stderr")
    parser.add_argument("--dry-run", "-n", action="store_true",
                        help="No side effects (skip dedup logging)")
    parser.add_argument("--cron", action="store_true",
                        help="Cron mode: deliver directly via OpenClaw gateway "
                             "instead of JSON to stdout. Use with system crontab.")
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
    CRON_MODE = args.cron

    if args.api:
        global API_BASE
        API_BASE = args.api

    if args.token:
        global TOKEN_ENV
        TOKEN_ENV = args.token

    if CRON_MODE:
        cron_log("Starting clawbeat in cron mode")

    try:
        run_heartbeat()
    except Exception as e:
        log(f"Unexpected error: {e}")
        if CRON_MODE:
            cron_log(f"Error: {type(e).__name__}: {e}")
            sys.exit(1)
        output("HEARTBEAT_OK",
               f"Error during check: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
