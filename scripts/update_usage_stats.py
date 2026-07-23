#!/usr/bin/env python3
"""Refresh ClawBoard's OpenAI Codex usage snapshot without hiding failures.

This script is intended to replace the host's legacy update-usage-stats.py while
keeping the existing cron entry unchanged. It writes provider values only after
a successful response. Failed refreshes preserve the last good values, advance
``checkedAt``, and expose a non-secret failure class and actionable reason.
"""

from __future__ import annotations

import glob
import json
import os
import re
import subprocess
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

SESSIONS_DIR = Path(os.environ.get("OPENCLAW_SESSIONS_DIR", "/home/clawd/.openclaw/agents/main/sessions"))
OUTFILE = Path(os.environ.get("USAGE_STATS_FILE", str(SESSIONS_DIR / "usage-stats.json")))
AUTH_FILE = Path(os.environ.get("OPENCLAW_AUTH_FILE", "/home/clawd/.openclaw/agents/main/agent/auth-profiles.json"))
OPENCLAW_BIN = os.environ.get("OPENCLAW_BIN", "/home/clawd/.npm-global/bin/openclaw")
HERMES_PYTHON = os.environ.get("HERMES_PYTHON", "/home/hermes/hermes-agent/venv/bin/python")
HERMES_AGENT_DIR = os.environ.get("HERMES_AGENT_DIR", "/home/hermes/hermes-agent")
HERMES_USAGE_USER = os.environ.get("HERMES_USAGE_USER", "hermes")
USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
MAX_TRANSCRIPTS = 5
MAX_SEARCH_BYTES = 5_000_000
MAX_TRANSCRIPT_AGE_SECONDS = 20 * 60

HERMES_USAGE_SCRIPT = r"""
import json
import httpx
from agent.account_usage import _resolve_codex_usage_credentials, _resolve_codex_usage_url

token, base_url, account_id = _resolve_codex_usage_credentials(None, None)
headers = {
    "Authorization": f"Bearer {token}",
    "Accept": "application/json",
    "User-Agent": "codex-cli",
}
if account_id:
    headers["ChatGPT-Account-Id"] = account_id
response = httpx.get(_resolve_codex_usage_url(base_url), headers=headers, timeout=15.0)
response.raise_for_status()
payload = response.json() or {}
rate_limit = payload.get("rate_limit") or {}
safe = {"plan": payload.get("plan_type")}
for name in ("primary_window", "secondary_window"):
    window = rate_limit.get(name)
    if isinstance(window, dict):
        safe[name] = {
            key: window.get(key)
            for key in ("used_percent", "reset_at", "limit_window_seconds")
        }
print(json.dumps(safe, separators=(",", ":")))
"""


class RefreshFailure(RuntimeError):
    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def fmt_ts(value: datetime) -> str:
    return value.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(value: object) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def format_duration(seconds: float) -> str:
    seconds = max(0, int(seconds))
    days, remainder = divmod(seconds, 86400)
    hours, remainder = divmod(remainder, 3600)
    minutes, _ = divmod(remainder, 60)
    if days:
        return f"{days}d {hours}h" if hours else f"{days}d"
    if hours:
        return f"{hours}h {minutes}m" if minutes else f"{hours}h"
    return f"{minutes}m"


def load_existing() -> Optional[dict]:
    try:
        return json.loads(OUTFILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def write_atomic(payload: dict) -> None:
    OUTFILE.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{OUTFILE.name}.", dir=OUTFILE.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, OUTFILE)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def quota_entry(window: dict, label: str, checked_at: datetime) -> dict:
    used = max(0, min(100, int(window.get("used_percent") or 0)))
    reset_value = window.get("reset_at")
    reset_at = None
    time_left = "unknown"
    if reset_value is not None:
        try:
            reset = datetime.fromtimestamp(float(reset_value), tz=timezone.utc)
            reset_at = fmt_ts(reset)
            time_left = format_duration((reset - checked_at).total_seconds())
        except (TypeError, ValueError, OverflowError):
            pass
    seconds = window.get("limit_window_seconds")
    if label == "5h" and seconds:
        try:
            hours = round(float(seconds) / 3600)
            if hours > 0:
                label = f"{hours}h"
        except (TypeError, ValueError):
            pass
    return {
        "label": label,
        "percentLeft": 100 - used,
        "timeLeft": time_left,
        "resetAt": reset_at,
    }


def _window_kind(window: dict, fallback: str) -> str:
    try:
        raw_seconds = window.get("limit_window_seconds")
        if raw_seconds is None:
            return fallback
        seconds = float(raw_seconds)
    except (TypeError, ValueError):
        return fallback
    if seconds <= 6 * 3600:
        return "session"
    if seconds >= 24 * 3600:
        return "weekly"
    return fallback


def hermes_codex_usage() -> dict:
    """Read Codex quota through Hermes without crossing the OAuth boundary."""
    command = [
        "sudo", "-n", "-u", HERMES_USAGE_USER,
        "env", "HOME=/home/hermes", f"PYTHONPATH={HERMES_AGENT_DIR}",
        HERMES_PYTHON, "-c", HERMES_USAGE_SCRIPT,
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RefreshFailure("hermes_usage_failed", "Hermes Codex usage source failed") from error
    if result.returncode != 0:
        raise RefreshFailure("hermes_usage_failed", "Hermes Codex usage source failed")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RefreshFailure("hermes_usage_invalid", "Hermes Codex usage output was invalid") from error

    checked_at = now_utc()
    entries: dict[str, dict] = {}
    for source_name, fallback in (("primary_window", "session"), ("secondary_window", "weekly")):
        window = payload.get(source_name)
        if not isinstance(window, dict) or window.get("used_percent") is None:
            continue
        kind = _window_kind(window, fallback)
        entries[kind] = quota_entry(window, "5h" if kind == "session" else "Weekly", checked_at)
    if not entries:
        raise RefreshFailure("hermes_windows_missing", "Hermes Codex usage omitted quota windows")

    missing = [label for key, label in (("session", "5h"), ("weekly", "weekly")) if key not in entries]
    reason = "live OpenAI Codex usage via Hermes OAuth"
    if missing:
        reason += f"; {', '.join(missing)} window not provided by the current plan"
    return {
        **entries,
        "updatedAt": fmt_ts(checked_at),
        "checkedAt": fmt_ts(checked_at),
        "lastSuccessAt": fmt_ts(checked_at),
        "dataAge": 0,
        "dataAgeUnit": "seconds",
        "source": "hermes-codex-usage-api",
        "provider": "openai-codex",
        "plan": payload.get("plan"),
        "failureClass": None,
        "statusReason": reason,
    }


def direct_codex_usage() -> dict:
    try:
        auth = json.loads(AUTH_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RefreshFailure("auth_store_unavailable", "Codex auth store is unavailable") from error

    profiles = [
        value for value in (auth.get("profiles") or {}).values()
        if isinstance(value, dict) and value.get("provider") == "openai-codex"
    ]
    if not profiles:
        raise RefreshFailure("auth_profile_missing", "No OpenAI Codex OAuth profile is configured")

    failures: list[str] = []
    for profile in profiles:
        token = str(profile.get("access") or "").strip()
        if not token:
            failures.append("auth_token_missing")
            continue
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "originator": "openclaw",
            "User-Agent": "openclaw-usage-telemetry/1",
        }
        account_id = str(profile.get("accountId") or "").strip()
        if account_id:
            headers["ChatGPT-Account-Id"] = account_id
        try:
            with urllib.request.urlopen(
                urllib.request.Request(USAGE_URL, headers=headers, method="GET"), timeout=20
            ) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as error:
            failures.append("oauth_token_expired" if error.code == 401 else f"provider_http_{error.code}")
            continue
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            failures.append("provider_unreachable")
            continue

        rate_limit = payload.get("rate_limit") or {}
        primary = rate_limit.get("primary_window") or {}
        secondary = rate_limit.get("secondary_window") or {}
        if not primary or not secondary:
            failures.append("provider_payload_incomplete")
            continue
        checked_at = now_utc()
        plan = payload.get("plan_type")
        return {
            "session": quota_entry(primary, "5h", checked_at),
            "weekly": quota_entry(secondary, "Weekly", checked_at),
            "updatedAt": fmt_ts(checked_at),
            "checkedAt": fmt_ts(checked_at),
            "lastSuccessAt": fmt_ts(checked_at),
            "dataAge": 0,
            "dataAgeUnit": "seconds",
            "source": "chatgpt-wham-usage",
            "provider": "openai-codex",
            "plan": plan,
            "failureClass": None,
            "statusReason": "live ChatGPT/OpenAI Codex usage snapshot",
        }

    code = "oauth_token_expired" if "oauth_token_expired" in failures else (failures[-1] if failures else "provider_refresh_failed")
    detail = {
        "oauth_token_expired": "OpenAI Codex OAuth expired; re-authenticate the OpenClaw Codex provider",
        "auth_token_missing": "OpenAI Codex OAuth profile has no access token",
        "provider_unreachable": "OpenAI Codex usage endpoint is unreachable",
        "provider_payload_incomplete": "OpenAI Codex usage response omitted quota windows",
    }.get(code, "OpenAI Codex usage refresh failed")
    raise RefreshFailure(code, detail)


def openclaw_usage() -> dict:
    try:
        result = subprocess.run(
            [OPENCLAW_BIN, "status", "--usage", "--json"],
            capture_output=True, text=True, timeout=45, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RefreshFailure("openclaw_command_failed", "OpenClaw usage command failed") from error
    if result.returncode != 0:
        raise RefreshFailure("openclaw_command_failed", "OpenClaw usage command failed")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RefreshFailure("openclaw_payload_invalid", "OpenClaw usage output was invalid") from error
    usage = payload.get("usage") or {}
    providers = usage.get("providers") or []
    provider = next((item for item in providers if item.get("windows")), None)
    if not provider:
        raise RefreshFailure("openclaw_provider_missing", "OpenClaw returned no provider usage windows")
    windows = provider.get("windows") or []
    primary = next((item for item in windows if str(item.get("label", "")).lower() == "5h"), None)
    weekly = next((item for item in windows if str(item.get("label", "")).lower() in {"week", "weekly"}), None)
    if not primary or not weekly:
        raise RefreshFailure("openclaw_windows_missing", "OpenClaw omitted 5h or weekly usage window")
    checked_at = now_utc()

    def convert(window: dict, label: str) -> dict:
        reset = window.get("resetAt")
        reset_seconds = float(reset) / 1000 if reset else None
        return quota_entry({
            "used_percent": window.get("usedPercent"),
            "reset_at": reset_seconds,
        }, label, checked_at)

    updated_ms = usage.get("updatedAt")
    updated_at = datetime.fromtimestamp(float(updated_ms) / 1000, tz=timezone.utc) if updated_ms else checked_at
    return {
        "session": convert(primary, "5h"),
        "weekly": convert(weekly, "Weekly"),
        "updatedAt": fmt_ts(updated_at),
        "checkedAt": fmt_ts(checked_at),
        "lastSuccessAt": fmt_ts(updated_at),
        "dataAge": max(0, int((checked_at - updated_at).total_seconds())),
        "dataAgeUnit": "seconds",
        "source": "openclaw-status",
        "provider": provider.get("provider") or "unknown",
        "plan": provider.get("plan"),
        "failureClass": None,
        "statusReason": "live provider usage snapshot",
    }


def transcript_usage() -> dict:
    candidates = sorted(glob.glob(str(SESSIONS_DIR / "*.jsonl")), key=os.path.getmtime, reverse=True)
    pattern = re.compile(r"Usage: \d+h (\d+)% left .(.+?) . Week (\d+)% left .(.+?)$", re.MULTILINE)
    stale_match_found = False
    for candidate in candidates[:MAX_TRANSCRIPTS]:
        try:
            size = os.path.getsize(candidate)
            with open(candidate, "r", encoding="utf-8", errors="ignore") as stream:
                if size > MAX_SEARCH_BYTES:
                    stream.seek(size - MAX_SEARCH_BYTES)
                    stream.readline()
                lines = stream.readlines()
        except OSError:
            continue
        for line in reversed(lines):
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            message = item.get("message") or {}
            if message.get("role") != "toolResult" or message.get("toolName") != "session_status":
                continue
            content = message.get("content") or []
            text = content if isinstance(content, str) else "\n".join(
                str(part.get("text") or "") for part in content if isinstance(part, dict)
            )
            match = pattern.search(text)
            if not match:
                continue
            checked_at = now_utc()
            captured_at = parse_ts(item.get("timestamp"))
            if captured_at is None:
                stale_match_found = True
                continue
            data_age = max(0, int((checked_at - captured_at).total_seconds()))
            if captured_at > checked_at or data_age > MAX_TRANSCRIPT_AGE_SECONDS:
                stale_match_found = True
                continue
            return {
                "session": {"label": "5h", "percentLeft": int(match.group(1)), "timeLeft": match.group(2).strip()},
                "weekly": {"label": "Weekly", "percentLeft": int(match.group(3)), "timeLeft": match.group(4).strip()},
                "updatedAt": fmt_ts(captured_at), "checkedAt": fmt_ts(checked_at),
                "lastSuccessAt": fmt_ts(captured_at), "dataAge": data_age, "dataAgeUnit": "seconds",
                "source": "transcript-fallback", "provider": "unknown", "plan": None,
                "failureClass": None, "statusReason": "recent transcript usage snapshot",
            }
    if stale_match_found:
        raise RefreshFailure("transcript_usage_stale", "Transcript usage snapshot is stale or lacks source time")
    raise RefreshFailure("transcript_usage_missing", "No recent transcript contains provider usage windows")


def preserve_failure(failures: list[RefreshFailure]) -> None:
    existing = load_existing()
    if not existing:
        return
    checked_at = now_utc()
    primary = failures[0] if failures else RefreshFailure("provider_refresh_failed", "Usage refresh failed")
    updated_at = parse_ts(existing.get("updatedAt"))
    existing.update({
        "checkedAt": fmt_ts(checked_at),
        "lastSuccessAt": existing.get("lastSuccessAt") or existing.get("updatedAt"),
        "dataAge": max(0, int((checked_at - updated_at).total_seconds())) if updated_at else 0,
        "dataAgeUnit": "seconds",
        "failureClass": primary.code,
        "statusReason": f"usage refresh failed: {primary.detail}; preserving previous snapshot",
        "attemptFailures": [failure.code for failure in failures],
    })
    write_atomic(existing)


def refresh(sources: Optional[list[Callable[[], dict]]] = None) -> bool:
    failures: list[RefreshFailure] = []
    for source in sources or [hermes_codex_usage, direct_codex_usage, openclaw_usage, transcript_usage]:
        try:
            write_atomic(source())
            return True
        except RefreshFailure as failure:
            failures.append(failure)
    preserve_failure(failures)
    return False


def main() -> int:
    return 0 if refresh() else 1


if __name__ == "__main__":
    raise SystemExit(main())
