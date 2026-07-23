import importlib.util, io, json, pathlib, unittest
from contextlib import redirect_stdout
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("writer", ROOT / "scripts" / "hermes_operational_status.py")
writer = importlib.util.module_from_spec(spec); spec.loader.exec_module(writer)


class WriterTests(unittest.TestCase):
    def test_authenticated_bounded_payload_and_private_output(self):
        captured = {}
        def fake_post(api, key, payload):
            captured.update(api=api, key=key, payload=payload)
            return 201, {"success": True, "outcome": "created", "status": {"id": "status-1", "status_text": "private"}}
        stdout = io.StringIO()
        with patch.object(writer, "post_json", side_effect=fake_post), redirect_stdout(stdout):
            result = writer.main(["--api", "https://dev/api", "--api-key", "secret-key", "--event-id", "task:516c4974-1234-4abc-8def-1234567890ab",
                                  "--completed-at", "2026-07-12T12:00:00Z", "--mood", "Pleased",
                                  "--text", "I finally finished a meaningful goal and I feel pleased.",
                                  "--avatar-attempted", "--avatar-failure", "image_generate_failed"])
        self.assertEqual(result, 0)
        self.assertEqual(captured["key"], "secret-key")
        self.assertEqual(captured["payload"]["author_harness"], "hermes")
        self.assertTrue(captured["payload"]["avatar_attempted"])
        self.assertEqual(captured["payload"]["avatar_failure"], "image_generate_failed")
        output = stdout.getvalue()
        self.assertNotIn("secret-key", output)
        self.assertNotIn("meaningful goal", output)
        self.assertEqual(json.loads(output)["status_id"], "status-1")

    def test_suppression_is_nonzero_and_does_not_echo_server_detail(self):
        with patch.object(writer, "post_json", return_value=(409, {"success": False, "outcome": "suppressed", "reason": "daily_cap", "error": "private"})), redirect_stdout(io.StringIO()) as stdout:
            result = writer.main(["--api", "https://dev/api", "--api-key", "k", "--event-id", "task:516c4974-1234-4abc-8def-1234567890ab",
                                  "--completed-at", "2026-07-12T12:00:00Z", "--mood", "Pleased", "--text", "I completed something meaningful today.",
                                  "--avatar-attempted", "--avatar-failure", "delivery_failed"])
        self.assertEqual(result, 1)
        self.assertNotIn("private", stdout.getvalue())


if __name__ == "__main__": unittest.main()
