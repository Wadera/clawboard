import importlib.util
import pathlib
import tempfile
import unittest

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("avatar", ROOT / "scripts" / "hermes_status_avatar.py")
assert spec is not None and spec.loader is not None
avatar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(avatar)


class SchedulerContractTests(unittest.TestCase):
    def test_checked_in_prompt_has_truthful_one_shot_boundaries(self):
        contract = (ROOT / "docs" / "hermes-status-scheduler-contract.md").read_text()
        required = [
            "MUST attempt one avatar",
            "exactly one image_generate tool call",
            "do not retry",
            "no local image generation",
            "continue with no avatar",
            "zero or one publication attempts",
            "event_id exactly task:<UUID>",
        ]
        for clause in required:
            self.assertIn(clause, contract)
        self.assertNotIn("scripts/hermes_status_avatar.py --prompt", contract)

    def test_delivers_a_real_256px_png_with_stable_local_url(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source = root / "remote-delivery.jpg"
            output = root / "generated" / "hermes-status"
            Image.new("RGB", (640, 384), "blue").save(source)
            url = avatar.deliver_avatar(source, "task:516c4974-1234-4abc-8def-1234567890ab", output, root)
            delivered = output / pathlib.Path(url).name
            self.assertEqual(url, f"/media/generated/hermes-status/{avatar.safe_output_name('task:516c4974-1234-4abc-8def-1234567890ab')}")
            with Image.open(delivered) as image:
                self.assertEqual(image.size, (256, 256))
                self.assertEqual(image.format, "PNG")

    def test_rejects_output_outside_allowed_generated_media_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source = root / "remote.png"
            Image.new("RGB", (8, 8)).save(source)
            with self.assertRaisesRegex(ValueError, "outside"):
                avatar.deliver_avatar(source, "task:id", root / "escape", root / "allowed")


if __name__ == "__main__":
    unittest.main()
