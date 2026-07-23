"""Runner-style tests for the clawbeat lifecycle hardening change-set:

1. Externally-managed task skip (no activeAgent + empty sessionRefs) in the
   stale-agent / legacy-stuck steps, incl. the >12h escalate branch.
2. Quota guard (provider-quota-aware spawn wake throttle), incl. the
   absent-config = disabled default.
3. Durable state ledger paths + /tmp -> durable migration + dual-write of
   wake-dedup entries.

Run with: python3 cli/test_clawbeat_lifecycle.py  (no pytest required)
"""

import contextlib
import importlib.util
import io
import json
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path


def load_clawbeat_module():
    module_path = Path(__file__).with_name("clawbeat.py")
    spec = importlib.util.spec_from_file_location("clawbeat", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@contextlib.contextmanager
def patched(module, **attrs):
    """Temporarily replace module attributes, restoring them afterwards."""
    saved = {name: getattr(module, name) for name in attrs}
    for name, value in attrs.items():
        setattr(module, name, value)
    try:
        yield
    finally:
        for name, value in saved.items():
            setattr(module, name, value)


def iso_hours_ago(hours: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()


def write_config(tmpdir: str, quota_guard: dict | None) -> Path:
    path = Path(tmpdir) / "config.json"
    data = {"token": "tok-test"}
    if quota_guard is not None:
        data["quota_guard"] = quota_guard
    path.write_text(json.dumps(data))
    return path


class WakeCaptured(Exception):
    """Raised by the fake output_wake so callers stop like sys.exit would."""


def make_wake_recorder(calls: list):
    def fake_output_wake(reason, message, task_id=None, attempt=1,
                         recommended_action="review", wake_type=None):
        calls.append({
            "reason": reason,
            "message": message,
            "task_id": task_id,
            "attempt": attempt,
            "recommended_action": recommended_action,
            "wake_type": wake_type,
        })
        raise WakeCaptured()
    return fake_output_wake


# ─── Task 59c6b6e3: externally-managed skip ───

def test_is_externally_managed_detection():
    clawbeat = load_clawbeat_module()

    # No activeAgent, no sessionRefs → externally managed.
    assert clawbeat.is_externally_managed(
        {"id": "dde076d7-x", "status": "in-progress"}) is True
    assert clawbeat.is_externally_managed(
        {"id": "dde076d7-x", "activeAgent": None, "sessionRefs": []}) is True

    # An activeAgent OR any sessionRef means a real agent session exists.
    assert clawbeat.is_externally_managed(
        {"id": "x", "activeAgent": {"sessionKey": "cron:abc"}}) is False
    assert clawbeat.is_externally_managed(
        {"id": "x", "sessionRefs": ["agent:main:subagent:foo"]}) is False


def test_externally_managed_young_task_skipped_without_wake():
    clawbeat = load_clawbeat_module()
    logs = []
    wakes = []

    task = {
        "id": "dde076d7-full-id",
        "title": "Orchestrator-direct work",
        "status": "in-progress",
        "startedAt": iso_hours_ago(2),
    }
    with patched(clawbeat,
                 log=logs.append,
                 output_wake=make_wake_recorder(wakes)):
        handled = clawbeat.handle_externally_managed_task(task)

    assert handled is True
    assert wakes == []  # No restart, no stuck-marking, no escalate.
    assert any(
        "externally managed (no agent session) - skipping" in line
        for line in logs)


def test_externally_managed_no_timestamp_skipped_without_wake():
    clawbeat = load_clawbeat_module()
    wakes = []
    task = {"id": "9b0b4b22-full-id", "title": "No timestamps"}
    with patched(clawbeat,
                 log=lambda *a, **k: None,
                 output_wake=make_wake_recorder(wakes)):
        assert clawbeat.handle_externally_managed_task(task) is True
    assert wakes == []


def test_task_with_agent_session_not_treated_as_externally_managed():
    clawbeat = load_clawbeat_module()
    task = {
        "id": "abc12345-full-id",
        "status": "in-progress",
        "activeAgent": {"sessionKey": "cron:1234"},
        "startedAt": iso_hours_ago(20),
    }
    assert clawbeat.handle_externally_managed_task(task) is False


def test_externally_managed_over_12h_escalates_via_normal_escalate_wake():
    clawbeat = load_clawbeat_module()
    wakes = []
    task = {
        "id": "dde076d7-full-id",
        "title": "Long-running orchestrator work",
        "status": "in-progress",
        "startedAt": iso_hours_ago(13),
    }
    with patched(clawbeat,
                 log=lambda *a, **k: None,
                 should_suppress_wake=lambda *a, **k: False,
                 output_wake=make_wake_recorder(wakes)):
        try:
            clawbeat.handle_externally_managed_task(task)
        except WakeCaptured:
            pass

    assert len(wakes) == 1
    wake = wakes[0]
    assert wake["wake_type"] == clawbeat.WAKE_TYPE_ESCALATE
    assert wake["recommended_action"] == "escalate_human"
    assert wake["task_id"] == "dde076d7-full-id"
    assert "Externally managed" in wake["reason"]
    # The prompt must forbid restart/stuck-marking (that was the bug).
    assert "NOT restart" in wake["message"]
    assert "no agent session to" in wake["message"]


def test_externally_managed_over_12h_respects_dedup_suppression():
    clawbeat = load_clawbeat_module()
    wakes = []
    task = {
        "id": "dde076d7-full-id",
        "title": "Already escalated",
        "startedAt": iso_hours_ago(14),
    }
    with patched(clawbeat,
                 log=lambda *a, **k: None,
                 should_suppress_wake=lambda *a, **k: True,
                 output_wake=make_wake_recorder(wakes)):
        handled = clawbeat.handle_externally_managed_task(task)

    assert handled is True
    assert wakes == []


def test_get_task_in_progress_hours_prefers_started_at():
    clawbeat = load_clawbeat_module()
    task = {
        "startedAt": iso_hours_ago(13),
        "updatedAt": iso_hours_ago(1),
    }
    hours = clawbeat.get_task_in_progress_hours(task)
    assert hours is not None and 12.9 < hours < 13.1

    # Falls back to updated when startedAt is absent.
    hours = clawbeat.get_task_in_progress_hours(
        {"updated": iso_hours_ago(5)})
    assert hours is not None and 4.9 < hours < 5.1

    assert clawbeat.get_task_in_progress_hours({}) is None


def test_review_ready_requires_no_later_empty_or_active_subtasks():
    clawbeat = load_clawbeat_module()

    partial = clawbeat.analyze_subtask_states([
        {"status": "completed"},
        {"status": "review"},
        {"status": "empty"},
    ])
    assert partial["has_review"] is True
    assert partial["has_in_progress"] is False
    assert partial["review_ready"] is False

    ready = clawbeat.analyze_subtask_states([
        {"status": "completed"},
        {"status": "review"},
        {"status": "skipped"},
    ])
    assert ready["review_ready"] is True

    blocked = clawbeat.analyze_subtask_states([
        {"status": "review"},
        {"status": "blocked"},
    ])
    assert blocked["review_ready"] is False


def test_active_worker_is_not_a_global_heartbeat_early_return():
    clawbeat = load_clawbeat_module()
    calls = []

    def final_output(action, reason, **kwargs):
        calls.append((action, reason, kwargs))
        raise WakeCaptured()

    with patched(
        clawbeat,
        migrate_legacy_state_files=lambda: None,
        check_and_notify_blocked_human_tasks=lambda: None,
        check_active_subagents=lambda: (True, "other-project-worker"),
        fetch_tasks_by_status=lambda _status: [],
        check_stuck_tasks=lambda: [],
        check_quota_guard=lambda: (False, ""),
        rotate_orchestration_log=lambda: None,
        cleanup_retry_tracker=lambda: None,
        log=lambda *_args, **_kwargs: None,
        output=final_output,
    ):
        try:
            clawbeat.run_heartbeat()
        except WakeCaptured:
            pass

    assert calls == [("HEARTBEAT_OK", "All systems nominal", {})]


# ─── Task a422c1eb: transactional spawn reservation ───

def _claim_task():
    return {
        "id": "a422c1eb-1111-4111-8111-111111111111",
        "updatedAt": "2026-07-16T00:00:00.000Z",
        "projectId": "project-1",
        "executionProfile": {"harness": "hermes"},
    }


def _claim_task_from_real_api():
    task = _claim_task()
    task["updated"] = task.pop("updatedAt")
    return task


def test_hardened_claim_disabled_preserves_legacy_path():
    clawbeat = load_clawbeat_module()
    old = os.environ.pop(clawbeat.HARDENED_ORCHESTRATION_ENV, None)
    try:
        with patched(clawbeat, api_post=lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("unexpected POST"))):
            assert clawbeat.claim_hardened_spawn(_claim_task()) is True
    finally:
        if old is not None:
            os.environ[clawbeat.HARDENED_ORCHESTRATION_ENV] = old


def test_hardened_claim_reserves_exact_snapshot_and_harness():
    clawbeat = load_clawbeat_module()
    calls = []
    old_enabled = os.environ.get(clawbeat.HARDENED_ORCHESTRATION_ENV)
    old_ttl = os.environ.get(clawbeat.HARDENED_LEASE_TTL_ENV)
    os.environ[clawbeat.HARDENED_ORCHESTRATION_ENV] = "true"
    os.environ[clawbeat.HARDENED_LEASE_TTL_ENV] = "60000"
    try:
        def fake_post(path, payload):
            calls.append((path, payload))
            return {"success": True, "acquired": True, "lease": {"id": "lease-1"}}
        with patched(clawbeat, api_post=fake_post, DRY_RUN=False):
            assert clawbeat.claim_hardened_spawn(_claim_task()) is True
    finally:
        for name, old in ((clawbeat.HARDENED_ORCHESTRATION_ENV, old_enabled),
                          (clawbeat.HARDENED_LEASE_TTL_ENV, old_ttl)):
            if old is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = old
    assert calls == [(
        "/tasks/orchestration/a422c1eb-1111-4111-8111-111111111111/claim",
        {
            "snapshotUpdatedAt": "2026-07-16T00:00:00.000Z",
            "harness": "hermes",
            "resourceKey": "project:project-1",
            "ttlSeconds": 60,
            "metadata": {"source": "clawbeat", "wakeType": "spawn_agent"},
        },
    )]


def test_hardened_claim_accepts_real_api_timestamp_and_suppresses_replay_wake():
    clawbeat = load_clawbeat_module()
    old = os.environ.get(clawbeat.HARDENED_ORCHESTRATION_ENV)
    os.environ[clawbeat.HARDENED_ORCHESTRATION_ENV] = "true"
    responses = iter([
        {"success": True, "acquired": True, "lease": {"id": "lease-1"}},
        {"success": True, "acquired": False, "lease": {"id": "lease-1"}},
    ])
    calls = []
    try:
        with patched(clawbeat, api_post=lambda path, payload: calls.append((path, payload)) or next(responses), DRY_RUN=False):
            assert clawbeat.claim_hardened_spawn(_claim_task_from_real_api()) is True
            assert clawbeat.claim_hardened_spawn(_claim_task_from_real_api()) is False
    finally:
        if old is None:
            os.environ.pop(clawbeat.HARDENED_ORCHESTRATION_ENV, None)
        else:
            os.environ[clawbeat.HARDENED_ORCHESTRATION_ENV] = old
    assert len(calls) == 2
    assert all(call[1]["snapshotUpdatedAt"] == "2026-07-16T00:00:00.000Z" for call in calls)


def test_hardened_claim_failure_and_dry_run_fail_closed_without_mutation():
    clawbeat = load_clawbeat_module()
    old = os.environ.get(clawbeat.HARDENED_ORCHESTRATION_ENV)
    os.environ[clawbeat.HARDENED_ORCHESTRATION_ENV] = "true"
    calls = []
    try:
        with patched(clawbeat, api_post=lambda *args: calls.append(args) or {}, DRY_RUN=False):
            assert clawbeat.claim_hardened_spawn(_claim_task()) is False
        with patched(clawbeat, api_post=lambda *args: calls.append(args) or {}, DRY_RUN=True):
            assert clawbeat.claim_hardened_spawn(_claim_task()) is True
    finally:
        if old is None:
            os.environ.pop(clawbeat.HARDENED_ORCHESTRATION_ENV, None)
        else:
            os.environ[clawbeat.HARDENED_ORCHESTRATION_ENV] = old
    assert len(calls) == 1


# ─── Task 25011693: quota guard ───

def test_quota_guard_absent_config_is_disabled_zero_behavior_change():
    clawbeat = load_clawbeat_module()
    with tempfile.TemporaryDirectory() as tmp:
        missing_cfg = Path(tmp) / "does-not-exist.json"
        ledger = Path(tmp) / "quota.json"
        with patched(clawbeat, TOKEN_FILE=missing_cfg,
                     QUOTA_LEDGER_FILE=ledger):
            config = clawbeat.get_quota_guard_config()
            should_defer, reason = clawbeat.check_quota_guard()
            clawbeat.record_quota_event("spawn_wakes")

    assert config["enabled"] is False
    assert config["max_spawn_wakes_per_hour"] == 6
    assert config["max_hermes_turns_per_hour"] == 20
    assert should_defer is False
    assert "disabled" in reason
    # Disabled guard never creates the ledger file.
    assert not ledger.exists()


def test_quota_guard_config_parsing_and_bad_values():
    clawbeat = load_clawbeat_module()
    with tempfile.TemporaryDirectory() as tmp:
        cfg = write_config(tmp, {
            "enabled": True,
            "max_spawn_wakes_per_hour": 3,
            "max_hermes_turns_per_hour": "not-an-int",
        })
        with patched(clawbeat, TOKEN_FILE=cfg):
            config = clawbeat.get_quota_guard_config()

    assert config["enabled"] is True
    assert config["max_spawn_wakes_per_hour"] == 3
    # Invalid value falls back to the default.
    assert config["max_hermes_turns_per_hour"] == 20


def test_quota_guard_under_limit_allows_spawn_wakes():
    clawbeat = load_clawbeat_module()
    with tempfile.TemporaryDirectory() as tmp:
        cfg = write_config(tmp, {"enabled": True})
        ledger = Path(tmp) / "quota.json"
        ledger.write_text(json.dumps({
            "spawn_wakes": [iso_hours_ago(0.5)],
            "hermes_turns": [iso_hours_ago(0.2)],
        }))
        with patched(clawbeat, TOKEN_FILE=cfg, QUOTA_LEDGER_FILE=ledger):
            should_defer, _ = clawbeat.check_quota_guard()
    assert should_defer is False


def test_quota_guard_spawn_budget_exhausted_defers():
    clawbeat = load_clawbeat_module()
    with tempfile.TemporaryDirectory() as tmp:
        cfg = write_config(tmp, {"enabled": True,
                                 "max_spawn_wakes_per_hour": 2})
        ledger = Path(tmp) / "quota.json"
        ledger.write_text(json.dumps({
            "spawn_wakes": [iso_hours_ago(0.9), iso_hours_ago(0.1)],
        }))
        with patched(clawbeat, TOKEN_FILE=cfg, QUOTA_LEDGER_FILE=ledger):
            should_defer, reason = clawbeat.check_quota_guard()
    assert should_defer is True
    assert "spawn wakes" in reason
    assert "max 2" in reason


def test_quota_guard_hermes_turn_budget_exhausted_defers():
    clawbeat = load_clawbeat_module()
    with tempfile.TemporaryDirectory() as tmp:
        cfg = write_config(tmp, {"enabled": True,
                                 "max_hermes_turns_per_hour": 3})
        ledger = Path(tmp) / "quota.json"
        ledger.write_text(json.dumps({
            "spawn_wakes": [],
            "hermes_turns": [iso_hours_ago(0.8), iso_hours_ago(0.4),
                             iso_hours_ago(0.1)],
        }))
        with patched(clawbeat, TOKEN_FILE=cfg, QUOTA_LEDGER_FILE=ledger):
            should_defer, reason = clawbeat.check_quota_guard()
    assert should_defer is True
    assert "Hermes turns" in reason


def test_quota_guard_stale_events_roll_out_of_the_window():
    clawbeat = load_clawbeat_module()
    with tempfile.TemporaryDirectory() as tmp:
        cfg = write_config(tmp, {"enabled": True,
                                 "max_spawn_wakes_per_hour": 2})
        ledger = Path(tmp) / "quota.json"
        # All events are older than one hour → budget is free again.
        ledger.write_text(json.dumps({
            "spawn_wakes": [iso_hours_ago(2), iso_hours_ago(1.5)],
        }))
        with patched(clawbeat, TOKEN_FILE=cfg, QUOTA_LEDGER_FILE=ledger):
            should_defer, _ = clawbeat.check_quota_guard()
    assert should_defer is False


def test_record_quota_event_appends_and_prunes():
    clawbeat = load_clawbeat_module()
    with tempfile.TemporaryDirectory() as tmp:
        cfg = write_config(tmp, {"enabled": True})
        ledger = Path(tmp) / "quota.json"
        ledger.write_text(json.dumps({
            "spawn_wakes": [iso_hours_ago(2), iso_hours_ago(0.5)],
        }))
        with patched(clawbeat, TOKEN_FILE=cfg, QUOTA_LEDGER_FILE=ledger,
                     DRY_RUN=False):
            clawbeat.record_quota_event("spawn_wakes")
        data = json.loads(ledger.read_text())

    # Old event pruned, recent one kept, new one appended.
    assert len(data["spawn_wakes"]) == 2


# ─── Task 04f745a8: durable state ledger + migration ───

def test_state_files_default_to_durable_dir():
    clawbeat = load_clawbeat_module()
    durable = Path("/srv/ai-stack/logs/clawbeat")
    assert clawbeat.DURABLE_STATE_DIR == durable
    assert clawbeat.RETRY_TRACKER_FILE == durable / "clawbeat-retries.json"
    assert (clawbeat.BLOCKED_NOTIFY_FILE
            == durable / "clawbeat-blocked-notified.json")
    assert (clawbeat.ORCHESTRATION_LOG
            == durable / "orchestration-actions.log")
    # Legacy /tmp paths preserved for rollout compat.
    assert (clawbeat.LEGACY_ORCHESTRATION_LOG
            == Path("/tmp/orchestration-actions.log"))
    assert (clawbeat.LEGACY_RETRY_TRACKER_FILE
            == Path("/tmp/clawbeat-retries.json"))
    assert (clawbeat.LEGACY_BLOCKED_NOTIFY_FILE
            == Path("/tmp/clawbeat-blocked-notified.json"))


def _durable_layout(tmp: str):
    """Return (durable_dir, legacy_dir, patch-kwargs) inside tmp."""
    durable_dir = Path(tmp) / "durable" / "clawbeat"
    legacy_dir = Path(tmp) / "legacy"
    legacy_dir.mkdir(parents=True)
    return durable_dir, legacy_dir, dict(
        DURABLE_STATE_DIR=durable_dir,
        RETRY_TRACKER_FILE=durable_dir / "clawbeat-retries.json",
        BLOCKED_NOTIFY_FILE=durable_dir / "clawbeat-blocked-notified.json",
        ORCHESTRATION_LOG=durable_dir / "orchestration-actions.log",
        LEGACY_RETRY_TRACKER_FILE=legacy_dir / "clawbeat-retries.json",
        LEGACY_BLOCKED_NOTIFY_FILE=(
            legacy_dir / "clawbeat-blocked-notified.json"),
        LEGACY_ORCHESTRATION_LOG=legacy_dir / "orchestration-actions.log",
    )


def test_migrate_copies_legacy_files_when_durable_absent():
    clawbeat = load_clawbeat_module()
    with tempfile.TemporaryDirectory() as tmp:
        durable_dir, legacy_dir, paths = _durable_layout(tmp)
        (legacy_dir / "clawbeat-retries.json").write_text('{"ab12cd34": {}}')
        (legacy_dir / "orchestration-actions.log").write_text(
            "2026-07-04T00:00:00+00:00 | ab12cd34 | spawned\n")
        # No legacy blocked-notified file → nothing to migrate for it.

        with patched(clawbeat, DRY_RUN=False, **paths):
            clawbeat.migrate_legacy_state_files()

        assert durable_dir.is_dir()
        assert (durable_dir / "clawbeat-retries.json").read_text() \
            == '{"ab12cd34": {}}'
        assert "ab12cd34 | spawned" in \
            (durable_dir / "orchestration-actions.log").read_text()
        assert not (durable_dir / "clawbeat-blocked-notified.json").exists()
        # Legacy files are copied, never deleted.
        assert (legacy_dir / "clawbeat-retries.json").exists()


def test_migrate_never_overwrites_existing_durable_state():
    clawbeat = load_clawbeat_module()
    with tempfile.TemporaryDirectory() as tmp:
        durable_dir, legacy_dir, paths = _durable_layout(tmp)
        durable_dir.mkdir(parents=True)
        (durable_dir / "clawbeat-retries.json").write_text('{"durable": 1}')
        (legacy_dir / "clawbeat-retries.json").write_text('{"legacy": 1}')

        with patched(clawbeat, DRY_RUN=False, **paths):
            clawbeat.migrate_legacy_state_files()

        assert (durable_dir / "clawbeat-retries.json").read_text() \
            == '{"durable": 1}'


def test_migrate_is_noop_in_dry_run():
    clawbeat = load_clawbeat_module()
    with tempfile.TemporaryDirectory() as tmp:
        durable_dir, legacy_dir, paths = _durable_layout(tmp)
        (legacy_dir / "clawbeat-retries.json").write_text("{}")
        with patched(clawbeat, DRY_RUN=True, **paths):
            clawbeat.migrate_legacy_state_files()
        assert not durable_dir.exists()


def test_output_wake_dual_writes_dedup_entry_to_durable_and_legacy():
    clawbeat = load_clawbeat_module()
    with tempfile.TemporaryDirectory() as tmp:
        durable_log = Path(tmp) / "durable-orchestration.log"
        legacy_log = Path(tmp) / "legacy-orchestration.log"
        stdout = io.StringIO()
        exit_code = None
        with patched(clawbeat,
                     DRY_RUN=False, CRON_MODE=False,
                     ORCHESTRATION_LOG=durable_log,
                     LEGACY_ORCHESTRATION_LOG=legacy_log):
            try:
                with contextlib.redirect_stdout(stdout):
                    clawbeat.output_wake(
                        reason="test", message="body",
                        task_id="ab12cd34-full", wake_type="spawn_agent")
            except SystemExit as e:
                exit_code = e.code

        assert exit_code == 0
        for ledger in (durable_log, legacy_log):
            content = ledger.read_text()
            assert "ab12cd34 | WAKE sent by clawbeat (spawn_agent)" in content

        result = json.loads(stdout.getvalue())
        assert result["action"] == "WAKE"
        assert result["task_id"] == "ab12cd34"


def test_parse_orchestration_log_reads_durable_and_merges_legacy():
    clawbeat = load_clawbeat_module()
    with tempfile.TemporaryDirectory() as tmp:
        durable_log = Path(tmp) / "durable.log"
        legacy_log = Path(tmp) / "legacy.log"
        shared = "2026-07-04T08:00:00+00:00 | ab12cd34 | " \
                 "WAKE sent by clawbeat (spawn_agent)"
        durable_log.write_text(shared + "\n")
        # Legacy has the duplicate dual-written line PLUS a newer
        # orchestrator action that only landed in /tmp during rollout.
        legacy_log.write_text(
            shared + "\n"
            "2026-07-04T09:00:00+00:00 | ab12cd34 | QA reviewed\n")

        with patched(clawbeat,
                     ORCHESTRATION_LOG=durable_log,
                     LEGACY_ORCHESTRATION_LOG=legacy_log):
            entries = clawbeat.parse_orchestration_log()

    assert len(entries) == 2  # duplicate collapsed
    # Chronological order: reversed() gives the newest action first.
    assert entries[-1][2] == "QA reviewed"


def test_parse_orchestration_log_survives_missing_legacy_file():
    clawbeat = load_clawbeat_module()
    with tempfile.TemporaryDirectory() as tmp:
        durable_log = Path(tmp) / "durable.log"
        durable_log.write_text(
            "2026-07-04T08:00:00+00:00 | ab12cd34 | completed\n")
        with patched(clawbeat,
                     ORCHESTRATION_LOG=durable_log,
                     LEGACY_ORCHESTRATION_LOG=Path(tmp) / "nope.log"):
            entries = clawbeat.parse_orchestration_log()
    assert len(entries) == 1
    assert entries[0][2] == "completed"


def test_hermes_qa_repo_prefers_valid_explicit_override():
    clawbeat = load_clawbeat_module()
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        override = root / "override"
        deployed = root / "deployed"
        checkout = root / "checkout"
        override.mkdir()
        deployed.mkdir()
        (checkout / "cli").mkdir(parents=True)
        resolved = clawbeat.resolve_hermes_qa_repo(
            {
                "CLAWBEAT_HERMES_QA_REPO": str(override),
                "DEPLOYED_REPO_PATH": str(deployed),
            },
            checkout / "cli" / "clawbeat.py",
        )
    assert resolved == override.resolve()


def test_hermes_qa_repo_falls_back_from_stale_paths_to_checkout():
    clawbeat = load_clawbeat_module()
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        checkout = root / "checkout"
        (checkout / "cli").mkdir(parents=True)
        resolved = clawbeat.resolve_hermes_qa_repo(
            {
                "CLAWBEAT_HERMES_QA_REPO": str(root / "missing-override"),
                "DEPLOYED_REPO_PATH": str(root / "missing-deployed"),
            },
            checkout / "cli" / "clawbeat.py",
        )
    assert resolved == checkout.resolve()


if __name__ == "__main__":
    # Lightweight fallback for stripped-down QA environments where pytest is
    # not installed (matches the other clawbeat test files).
    tests = [
        test_is_externally_managed_detection,
        test_externally_managed_young_task_skipped_without_wake,
        test_externally_managed_no_timestamp_skipped_without_wake,
        test_task_with_agent_session_not_treated_as_externally_managed,
        test_externally_managed_over_12h_escalates_via_normal_escalate_wake,
        test_externally_managed_over_12h_respects_dedup_suppression,
        test_get_task_in_progress_hours_prefers_started_at,
        test_review_ready_requires_no_later_empty_or_active_subtasks,
        test_active_worker_is_not_a_global_heartbeat_early_return,
        test_hardened_claim_disabled_preserves_legacy_path,
        test_hardened_claim_reserves_exact_snapshot_and_harness,
        test_hardened_claim_failure_and_dry_run_fail_closed_without_mutation,
        test_quota_guard_absent_config_is_disabled_zero_behavior_change,
        test_quota_guard_config_parsing_and_bad_values,
        test_quota_guard_under_limit_allows_spawn_wakes,
        test_quota_guard_spawn_budget_exhausted_defers,
        test_quota_guard_hermes_turn_budget_exhausted_defers,
        test_quota_guard_stale_events_roll_out_of_the_window,
        test_record_quota_event_appends_and_prunes,
        test_state_files_default_to_durable_dir,
        test_migrate_copies_legacy_files_when_durable_absent,
        test_migrate_never_overwrites_existing_durable_state,
        test_migrate_is_noop_in_dry_run,
        test_output_wake_dual_writes_dedup_entry_to_durable_and_legacy,
        test_parse_orchestration_log_reads_durable_and_merges_legacy,
        test_parse_orchestration_log_survives_missing_legacy_file,
        test_hermes_qa_repo_prefers_valid_explicit_override,
        test_hermes_qa_repo_falls_back_from_stale_paths_to_checkout,
    ]
    for test in tests:
        test()
    print(f"{len(tests)} tests passed")
