import importlib.util
from pathlib import Path


def load_clawbeat_module():
    module_path = Path(__file__).with_name("clawbeat.py")
    spec = importlib.util.spec_from_file_location("clawbeat", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_hermes_idle_zero_message_status_is_not_active_even_when_recent():
    clawbeat = load_clawbeat_module()

    active, reason = clawbeat.runtime_status_is_active({
        "harness": "hermes",
        "state": "idle",
        "startedAt": "2999-01-01T00:00:00.000Z",
        "metadata": {
            "pidAlive": False,
            "messageCount": 0,
            "toolCallCount": 0,
            "updatedAt": "2999-01-01T00:00:00.000Z",
        },
    })

    assert active is False
    assert reason == "Hermes session idle"


def test_hermes_running_status_is_active():
    clawbeat = load_clawbeat_module()

    active, reason = clawbeat.runtime_status_is_active({
        "harness": "hermes",
        "state": "running",
        "metadata": {"pidAlive": True},
    })

    assert active is True
    assert reason == "Hermes session running"


def test_canonical_runtime_signal_is_authoritative_for_both_harnesses():
    clawbeat = load_clawbeat_module()

    active, reason = clawbeat.runtime_status_is_active({
        "harness": "openclaw",
        "state": "running",
        "canonicalRuntime": {
            "state": "stale",
            "reasonCode": "canonical_evidence_stale",
        },
    })
    assert active is False
    assert reason == "Canonical runtime stale (canonical_evidence_stale)"

    active, reason = clawbeat.runtime_status_is_active({
        "harness": "hermes",
        "state": "idle",
        "canonicalRuntime": {
            "state": "active",
            "reasonCode": "recent_meaningful_progress",
        },
    })
    assert active is True
    assert reason == "Canonical runtime active (recent_meaningful_progress)"


def test_auto_pick_disabled_main_task_is_direct_even_with_history():
    clawbeat = load_clawbeat_module()
    task = {
        "autoStart": False,
        "executionProfile": {"mode": "main", "harness": "hermes"},
        "activeAgent": None,
        "acpSessionKey": None,
        "sessionRefs": ["hermes:tool:historical-attempt"],
    }
    assert clawbeat.is_externally_managed(task) is True

    task["acpSessionKey"] = "hermes:tool:current-attempt"
    assert clawbeat.is_externally_managed(task) is False


if __name__ == "__main__":
    # Lightweight fallback for stripped-down QA environments where pytest is not
    # installed. The documented regression command still uses pytest when
    # available, but this lets reviewers run `python3 cli/test_...py` without
    # adding Python packages to the orchestration host.
    tests = [
        test_hermes_idle_zero_message_status_is_not_active_even_when_recent,
        test_hermes_running_status_is_active,
        test_canonical_runtime_signal_is_authoritative_for_both_harnesses,
        test_auto_pick_disabled_main_task_is_direct_even_with_history,
    ]
    for test in tests:
        test()
    print(f"{len(tests)} tests passed")
