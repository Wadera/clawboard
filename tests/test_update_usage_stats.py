import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "scripts" / "update_usage_stats.py"
SPEC = importlib.util.spec_from_file_location("update_usage_stats", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
usage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(usage)


class UsageStatsTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.outfile = Path(self.tempdir.name) / "usage-stats.json"
        self.authfile = Path(self.tempdir.name) / "auth.json"
        self.sessions = Path(self.tempdir.name) / "sessions"
        self.sessions.mkdir()
        self.patches = [
            mock.patch.object(usage, "OUTFILE", self.outfile),
            mock.patch.object(usage, "AUTH_FILE", self.authfile),
            mock.patch.object(usage, "SESSIONS_DIR", self.sessions),
        ]
        for patcher in self.patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    def write_existing(self):
        self.outfile.write_text(json.dumps({
            "session": {"label": "5h", "percentLeft": 85, "timeLeft": "1h"},
            "weekly": {"label": "Weekly", "percentLeft": 95, "timeLeft": "6d"},
            "updatedAt": "2026-07-07T19:57:02Z",
            "checkedAt": "2026-07-07T19:57:02Z",
        }))

    def test_failure_preserves_values_and_exposes_actionable_class(self):
        self.write_existing()
        first = lambda: (_ for _ in ()).throw(
            usage.RefreshFailure("oauth_token_expired", "OpenAI Codex OAuth expired; re-authenticate")
        )
        second = lambda: (_ for _ in ()).throw(
            usage.RefreshFailure("openclaw_provider_missing", "OpenClaw returned no provider usage windows")
        )

        with mock.patch.object(usage, "now_utc", return_value=datetime(2026, 7, 16, 18, 30, tzinfo=timezone.utc)):
            self.assertFalse(usage.refresh([first, second]))

        result = json.loads(self.outfile.read_text())
        self.assertEqual(result["session"]["percentLeft"], 85)
        self.assertEqual(result["weekly"]["percentLeft"], 95)
        self.assertEqual(result["lastSuccessAt"], "2026-07-07T19:57:02Z")
        self.assertEqual(result["dataAge"], 772378)
        self.assertEqual(result["dataAgeUnit"], "seconds")
        self.assertEqual(result["failureClass"], "oauth_token_expired")
        self.assertEqual(result["attemptFailures"], ["oauth_token_expired", "openclaw_provider_missing"])
        self.assertIn("re-authenticate", result["statusReason"])
        self.assertIn("preserving previous snapshot", result["statusReason"])

    def test_success_replaces_failed_snapshot_and_clears_failure(self):
        self.write_existing()
        live = {
            "session": {"label": "5h", "percentLeft": 72, "timeLeft": "4h"},
            "weekly": {"label": "Weekly", "percentLeft": 81, "timeLeft": "4d"},
            "updatedAt": "2026-07-16T18:30:00Z",
            "checkedAt": "2026-07-16T18:30:00Z",
            "lastSuccessAt": "2026-07-16T18:30:00Z",
            "dataAge": 0,
            "dataAgeUnit": "seconds",
            "failureClass": None,
            "statusReason": "live provider usage snapshot",
        }

        self.assertTrue(usage.refresh([lambda: live]))
        self.assertEqual(json.loads(self.outfile.read_text()), live)
        self.assertFalse(list(self.outfile.parent.glob(f".{self.outfile.name}.*")))

    def test_quota_entry_uses_seconds_and_clamps_percent(self):
        checked = datetime(2026, 7, 16, 18, 0, tzinfo=timezone.utc)
        reset = checked.timestamp() + 3660
        result = usage.quota_entry({
            "used_percent": 105,
            "reset_at": reset,
            "limit_window_seconds": 18000,
        }, "5h", checked)
        self.assertEqual(result["label"], "5h")
        self.assertEqual(result["percentLeft"], 0)
        self.assertEqual(result["timeLeft"], "1h 1m")
        self.assertEqual(result["resetAt"], "2026-07-16T19:01:00Z")

    def test_missing_auth_is_a_precise_failure(self):
        with self.assertRaises(usage.RefreshFailure) as caught:
            usage.direct_codex_usage()
        self.assertEqual(caught.exception.code, "auth_store_unavailable")

    def test_hermes_usage_accepts_current_plan_with_weekly_window_only(self):
        completed = mock.Mock(returncode=0, stdout=json.dumps({
            "plan": "pro",
            "primary_window": {
                "used_percent": 20,
                "reset_at": datetime(2026, 7, 23, 4, 16, 17, tzinfo=timezone.utc).timestamp(),
                "limit_window_seconds": 7 * 24 * 3600,
            },
            "secondary_window": None,
        }))
        with mock.patch.object(usage.subprocess, "run", return_value=completed), \
                mock.patch.object(usage, "now_utc", return_value=datetime(2026, 7, 17, 2, 21, 50, tzinfo=timezone.utc)):
            result = usage.hermes_codex_usage()

        self.assertNotIn("session", result)
        self.assertEqual(result["weekly"]["percentLeft"], 80)
        self.assertEqual(result["weekly"]["label"], "Weekly")
        self.assertEqual(result["source"], "hermes-codex-usage-api")
        self.assertIsNone(result["failureClass"])
        self.assertIn("5h window not provided", result["statusReason"])

    def test_hermes_usage_failure_is_non_secret_and_precise(self):
        completed = mock.Mock(returncode=1, stdout="", stderr="sensitive provider detail")
        with mock.patch.object(usage.subprocess, "run", return_value=completed):
            with self.assertRaises(usage.RefreshFailure) as caught:
                usage.hermes_codex_usage()
        self.assertEqual(caught.exception.code, "hermes_usage_failed")
        self.assertNotIn("sensitive", caught.exception.detail)

    def test_empty_openclaw_provider_list_is_a_precise_failure(self):
        completed = mock.Mock(returncode=0, stdout=json.dumps({"usage": {"providers": []}}))
        with mock.patch.object(usage.subprocess, "run", return_value=completed):
            with self.assertRaises(usage.RefreshFailure) as caught:
                usage.openclaw_usage()
        self.assertEqual(caught.exception.code, "openclaw_provider_missing")

    def write_transcript_usage(self, timestamp: str):
        item = {
            "timestamp": timestamp,
            "message": {
                "role": "toolResult",
                "toolName": "session_status",
                "content": "Usage: 5h 12% left ⏱1h · Week 34% left ⏱5d",
            },
        }
        (self.sessions / "usage.jsonl").write_text(json.dumps(item) + "\n")

    def test_transcript_fallback_preserves_source_age(self):
        self.write_transcript_usage("2026-07-17T02:29:00Z")
        with mock.patch.object(usage, "now_utc", return_value=datetime(2026, 7, 17, 2, 30, tzinfo=timezone.utc)):
            result = usage.transcript_usage()
        self.assertEqual(result["updatedAt"], "2026-07-17T02:29:00Z")
        self.assertEqual(result["dataAge"], 60)
        self.assertEqual(result["statusReason"], "recent transcript usage snapshot")

    def test_transcript_fallback_rejects_old_or_untimed_quota(self):
        for timestamp in ("2026-06-17T02:30:00Z", ""):
            with self.subTest(timestamp=timestamp):
                for child in self.sessions.iterdir():
                    child.unlink()
                self.write_transcript_usage(timestamp)
                with mock.patch.object(usage, "now_utc", return_value=datetime(2026, 7, 17, 2, 30, tzinfo=timezone.utc)):
                    with self.assertRaises(usage.RefreshFailure) as caught:
                        usage.transcript_usage()
                self.assertEqual(caught.exception.code, "transcript_usage_stale")


if __name__ == "__main__":
    unittest.main()
