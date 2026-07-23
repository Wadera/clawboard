import contextlib
import importlib.util
import json
import os
import tempfile
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


@contextlib.contextmanager
def no_wake_harness_env():
    """Ensure CLAWBEAT_WAKE_HARNESS is unset for the duration."""
    saved = os.environ.pop("CLAWBEAT_WAKE_HARNESS", None)
    try:
        yield
    finally:
        if saved is not None:
            os.environ["CLAWBEAT_WAKE_HARNESS"] = saved


def write_config(tmpdir: str, wake_delivery: dict | None) -> Path:
    path = Path(tmpdir) / "config.json"
    data = {"token": "tok-test", "api": "http://localhost:3001"}
    if wake_delivery is not None:
        data["wake_delivery"] = wake_delivery
    path.write_text(json.dumps(data))
    return path


class FakePopen:
    """Records the argv/kwargs of the launch instead of spawning."""
    calls = []

    def __init__(self, cmd, **kwargs):
        FakePopen.calls.append((cmd, kwargs))
        self.pid = 4242


class ExplodingPopen:
    def __init__(self, cmd, **kwargs):
        raise OSError("sudo unavailable")


def test_default_config_absent_is_openclaw_only():
    clawbeat = load_clawbeat_module()
    with no_wake_harness_env(), tempfile.TemporaryDirectory() as tmp:
        missing = Path(tmp) / "does-not-exist.json"
        with patched(clawbeat, TOKEN_FILE=missing):
            cfg = clawbeat.get_wake_delivery_config()

    assert cfg["primary"] == "openclaw"
    assert cfg["fallbacks"] == []
    assert cfg["hermes_orchestrator_session"] is None
    assert cfg["hermes_model"] is None
    assert cfg["openclaw_session"] is None


def test_env_override_takes_precedence_over_config():
    clawbeat = load_clawbeat_module()
    with no_wake_harness_env(), tempfile.TemporaryDirectory() as tmp:
        cfg_path = write_config(tmp, {"primary": "openclaw", "fallbacks": []})
        os.environ["CLAWBEAT_WAKE_HARNESS"] = "hermes"
        try:
            with patched(clawbeat, TOKEN_FILE=cfg_path):
                cfg = clawbeat.get_wake_delivery_config()
        finally:
            del os.environ["CLAWBEAT_WAKE_HARNESS"]

    assert cfg["primary"] == "hermes"


def test_config_chain_hermes_primary_openclaw_fallback():
    clawbeat = load_clawbeat_module()
    with no_wake_harness_env(), tempfile.TemporaryDirectory() as tmp:
        cfg_path = write_config(tmp, {
            "primary": "hermes",
            "fallbacks": ["openclaw"],
            "hermes_orchestrator_session": "20260701_000000_abc123",
            "openclaw_session": "agent:main:explicit:main",
        })
        with patched(clawbeat, TOKEN_FILE=cfg_path):
            cfg = clawbeat.get_wake_delivery_config()

    assert cfg["primary"] == "hermes"
    assert cfg["fallbacks"] == ["openclaw"]
    assert cfg["hermes_orchestrator_session"] == "20260701_000000_abc123"
    assert cfg["openclaw_session"] == "agent:main:explicit:main"


def test_cron_deliver_chain_order_hermes_then_openclaw():
    clawbeat = load_clawbeat_module()
    attempts = []
    gateway_kwargs = {}
    logs = []

    def fake_hermes(message, wake_type=None, task_id=None):
        attempts.append("hermes")
        return False

    def fake_gateway(message, wake_now=True, wake_type=None, task_id=None,
                     session_key="agent:main:main"):
        attempts.append("openclaw")
        gateway_kwargs.update(wake_now=wake_now, session_key=session_key)
        return True

    with no_wake_harness_env(), tempfile.TemporaryDirectory() as tmp:
        cfg_path = write_config(tmp, {
            "primary": "hermes",
            "fallbacks": ["openclaw"],
            "openclaw_session": "agent:main:explicit:main",
        })
        with patched(
            clawbeat,
            TOKEN_FILE=cfg_path,
            deliver_to_hermes_main=fake_hermes,
            deliver_to_gateway=fake_gateway,
            check_user_active=lambda: False,
            cron_log=logs.append,
        ):
            exit_code = None
            try:
                clawbeat.cron_deliver("WAKE", "test reason", "wake body",
                                      wake_type="review_needed", task_id=None)
            except SystemExit as e:
                exit_code = e.code

    assert exit_code == 0
    assert attempts == ["hermes", "openclaw"]
    assert gateway_kwargs["session_key"] == "agent:main:explicit:main"
    assert gateway_kwargs["wake_now"] is True
    assert any("hermes delivery failed - trying next" in line
               for line in logs)
    assert any(line.startswith("Delivered via openclaw") for line in logs)


def test_cron_deliver_all_targets_failed_exits_1():
    clawbeat = load_clawbeat_module()
    logs = []

    with no_wake_harness_env(), tempfile.TemporaryDirectory() as tmp:
        cfg_path = write_config(tmp, {
            "primary": "hermes",
            "fallbacks": ["openclaw"],
        })
        with patched(
            clawbeat,
            TOKEN_FILE=cfg_path,
            deliver_to_hermes_main=lambda *a, **k: False,
            deliver_to_gateway=lambda *a, **k: False,
            check_user_active=lambda: False,
            cron_log=logs.append,
        ):
            exit_code = None
            try:
                clawbeat.cron_deliver("WAKE", "test reason", "wake body",
                                      wake_type="stale_agent", task_id=None)
            except SystemExit as e:
                exit_code = e.code

    assert exit_code == 1
    assert any("DELIVERY FAILED" in line for line in logs)


def _run_hermes_main(clawbeat, wake_delivery, popen_cls,
                     wake_type="review_needed", task_id="0be67335-full-id"):
    """deliver_to_hermes_main with all host touchpoints stubbed out."""
    FakePopen.calls = []
    with no_wake_harness_env(), tempfile.TemporaryDirectory() as tmp:
        cfg_path = write_config(tmp, wake_delivery)
        fake_bin = Path(tmp) / "hermes"
        fake_bin.write_text("#!/bin/sh\n")
        log_dir = Path(tmp) / "wake-logs"
        with patched(
            clawbeat,
            TOKEN_FILE=cfg_path,
            DRY_RUN=False,
            get_api_token=lambda: "tok-test",
            HERMES_BIN=fake_bin,
            HERMES_WAKE_LOG_DIR=log_dir,
            cron_log=lambda *a, **k: None,
        ):
            saved_popen = clawbeat.subprocess.Popen
            clawbeat.subprocess.Popen = popen_cls
            try:
                result = clawbeat.deliver_to_hermes_main(
                    "wake body", wake_type=wake_type, task_id=task_id)
            finally:
                clawbeat.subprocess.Popen = saved_popen
    return result


def test_deliver_to_hermes_main_argv_with_resume():
    clawbeat = load_clawbeat_module()
    result = _run_hermes_main(clawbeat, {
        "primary": "hermes",
        "fallbacks": ["openclaw"],
        "hermes_orchestrator_session": "20260701_000000_abc123",
        "hermes_model": "openai-codex/gpt-5.5-mini",
    }, FakePopen)

    assert result is True
    assert len(FakePopen.calls) == 1
    cmd, kwargs = FakePopen.calls[0]

    # Orchestrator scaffold: sudo as hermes with HOME set.
    assert cmd[:4] == ["sudo", "-n", "-u", "hermes"]
    assert "HOME=/home/hermes" in cmd
    assert "CLAWBOARD_TOKEN=tok-test" in cmd
    assert "NO_COLOR=1" in cmd

    # NOT the QA role — this is the orchestrator.
    assert "CLAWBOARD_QA_AGENT=1" not in cmd
    assert "CLAWBOARD_ROLE=qa" not in cmd

    # Source tag prefix + short task id.
    source = cmd[cmd.index("--source") + 1]
    assert source.startswith("clawbeat-orchestrate:review_needed:0be67335:")

    # Configured model + resume session.
    assert cmd[cmd.index("-m") + 1] == "openai-codex/gpt-5.5-mini"
    assert cmd[cmd.index("--resume") + 1] == "20260701_000000_abc123"

    # Detached launch semantics.
    assert kwargs["start_new_session"] is True

    # Hermes footer appended to the wake body.
    message = cmd[cmd.index("-q") + 1]
    assert message.startswith("wake body")
    assert "Discord" in message
    assert "clawboard" in message
    assert "/srv/ai-stack/logs/orchestration-actions.log" in message
    assert "message tool" not in message
    assert "channel:1465806566350651484" not in message


def test_deliver_to_hermes_main_no_resume_and_default_model():
    clawbeat = load_clawbeat_module()
    result = _run_hermes_main(clawbeat, {
        "primary": "hermes",
        "fallbacks": [],
    }, FakePopen)

    assert result is True
    cmd, _ = FakePopen.calls[0]
    assert "--resume" not in cmd
    assert cmd[cmd.index("-m") + 1] == "openai-codex/gpt-5.5"


def test_deliver_to_hermes_main_returns_false_when_popen_raises():
    clawbeat = load_clawbeat_module()
    result = _run_hermes_main(clawbeat, {"primary": "hermes"},
                              ExplodingPopen)
    assert result is False


def test_hermes_footer_replaces_openclaw_message_tool_footer():
    clawbeat = load_clawbeat_module()
    footer = clawbeat.build_hermes_wake_footer()

    assert "orchestrator session" in footer
    assert "Discord" in footer
    assert "clawboard" in footer
    assert "hermes send" in footer
    assert "/srv/ai-stack/logs/orchestration-actions.log" in footer
    assert "/tmp/orchestration-actions.log" in footer
    # No OpenClaw message-tool semantics.
    assert "message tool" not in footer
    assert "channel:1465806566350651484" not in footer


def test_blocked_human_wake_message_switches_on_primary():
    clawbeat = load_clawbeat_module()
    task = {"id": "0be67335-full-id", "title": "Test task"}

    with no_wake_harness_env(), tempfile.TemporaryDirectory() as tmp:
        hermes_cfg = write_config(tmp, {"primary": "hermes",
                                        "fallbacks": ["openclaw"]})
        with patched(clawbeat, TOKEN_FILE=hermes_cfg):
            hermes_msg = clawbeat.build_blocked_human_wake_message(
                task, "waiting on creds", "discord body")

        openclaw_cfg = write_config(tmp, None)  # no wake_delivery block
        with patched(clawbeat, TOKEN_FILE=openclaw_cfg):
            openclaw_msg = clawbeat.build_blocked_human_wake_message(
                task, "waiting on creds", "discord body")

    # Hermes primary: native Discord instructions, no message-tool syntax.
    assert "DM Wadera on Discord directly" in hermes_msg
    assert "hermes send" in hermes_msg
    assert 'message(action="send"' not in hermes_msg

    # OpenClaw primary (default): existing message-tool syntax preserved.
    assert 'message(action="send"' in openclaw_msg
    assert "hermes send" not in openclaw_msg


def test_blocked_human_and_escalate_wakes_include_stale_check():
    """Re-tag fight regression: wake messages must instruct the orchestrator
    to verify current task status FIRST and treat the wake as stale (no
    re-tagging, no status change) when the task is no longer blocked."""
    clawbeat = load_clawbeat_module()
    task = {"id": "0be67335-full-id", "title": "Test task"}

    with no_wake_harness_env(), tempfile.TemporaryDirectory() as tmp:
        cfg = write_config(tmp, None)
        with patched(clawbeat, TOKEN_FILE=cfg):
            blocked_msg = clawbeat.build_blocked_human_wake_message(
                task, "waiting on creds", "discord body")

    escalate_msg = clawbeat.build_escalate_human_prompt(
        task, {}, {"blocked_subtasks": [
            {"index": 0, "text": "Do thing", "blockedReason": "creds"}]})

    for msg in (blocked_msg, escalate_msg):
        assert "STEP 0" in msg
        assert "STALE" in msg
        assert "clawboard get 0be67335" in msg
        assert "re-tag blocked-human" in msg
        assert "do nothing" in msg.lower()

    # The stale check must come BEFORE the action instructions.
    assert blocked_msg.index("STEP 0") < blocked_msg.index("Action Required")
    assert escalate_msg.index("STEP 0") < escalate_msg.index("ACTION REQUIRED")


def test_blocked_human_dedup_requires_backend_transport_receipt():
    clawbeat = load_clawbeat_module()
    task = {
        "id": "0be67335-full-id",
        "title": "Test task",
        "status": "stuck",
        "updated": "2026-07-16T07:00:00Z",
        "tags": ["blocked-human"],
    }
    recorded = []
    wakes = []

    with patched(
        clawbeat,
        fetch_blocked_human_stuck_tasks=lambda: [task],
        clean_blocked_notify_tracker=lambda _ids: None,
        should_notify_blocked_human=lambda _id: True,
        get_blocked_reason=lambda _task: "waiting on approval",
        api_post=lambda _path, _payload: {"status": "sent", "receipt": {"providerMessageId": "m-1"}},
        record_blocked_human_notified=lambda task_id, _title: recorded.append(task_id),
        output_wake=lambda **_kwargs: wakes.append("wake"),
    ):
        clawbeat.check_and_notify_blocked_human_tasks()

    assert recorded == [task["id"]]
    assert wakes == []

    recorded.clear()
    with patched(
        clawbeat,
        fetch_blocked_human_stuck_tasks=lambda: [task],
        clean_blocked_notify_tracker=lambda _ids: None,
        should_notify_blocked_human=lambda _id: True,
        get_blocked_reason=lambda _task: "waiting on approval",
        api_post=lambda _path, _payload: {},
        record_blocked_human_notified=lambda task_id, _title: recorded.append(task_id),
        output_wake=lambda **_kwargs: wakes.append("fallback"),
    ):
        clawbeat.check_and_notify_blocked_human_tasks()

    assert recorded == []
    assert wakes == ["fallback"]


if __name__ == "__main__":
    # Lightweight fallback for stripped-down QA environments where pytest is
    # not installed (matches test_clawbeat_runtime_status.py style).
    tests = [
        test_default_config_absent_is_openclaw_only,
        test_env_override_takes_precedence_over_config,
        test_config_chain_hermes_primary_openclaw_fallback,
        test_cron_deliver_chain_order_hermes_then_openclaw,
        test_cron_deliver_all_targets_failed_exits_1,
        test_deliver_to_hermes_main_argv_with_resume,
        test_deliver_to_hermes_main_no_resume_and_default_model,
        test_deliver_to_hermes_main_returns_false_when_popen_raises,
        test_hermes_footer_replaces_openclaw_message_tool_footer,
        test_blocked_human_wake_message_switches_on_primary,
        test_blocked_human_and_escalate_wakes_include_stale_check,
        test_blocked_human_dedup_requires_backend_transport_receipt,
    ]
    for test in tests:
        test()
    print(f"{len(tests)} tests passed")
