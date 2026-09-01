from __future__ import annotations

import hashlib
import importlib.util
import tempfile
import unittest
import zipfile
from pathlib import Path


def load_builder():
    path = Path(__file__).resolve().parents[1] / "scripts" / "build_wheel.py"
    spec = importlib.util.spec_from_file_location("buyer_wheel_builder", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("wheel builder could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WheelBuildTest(unittest.TestCase):
    def test_build_is_reproducible_and_contains_required_metadata(self) -> None:
        builder = load_builder()
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            sentinel = Path(first) / "keep-me"
            sentinel.write_text("preserved")
            first_wheel = builder.build(Path(first))
            second_wheel = builder.build(Path(second))
            self.assertEqual(sentinel.read_text(), "preserved")
            self.assertEqual(
                hashlib.sha256(first_wheel.read_bytes()).digest(),
                hashlib.sha256(second_wheel.read_bytes()).digest(),
            )
            with zipfile.ZipFile(first_wheel) as archive:
                names = set(archive.namelist())
                self.assertIn("onchain_router/__init__.py", names)
                self.assertIn("onchain_router/client.py", names)
                self.assertIn("onchain_router-0.1.0.dist-info/RECORD", names)
                license_path = "onchain_router-0.1.0.dist-info/licenses/LICENSE"
                self.assertIn(license_path, names)
                self.assertEqual(
                    archive.read(license_path),
                    (Path(__file__).resolve().parents[1] / "LICENSE").read_bytes(),
                )
                metadata = archive.read("onchain_router-0.1.0.dist-info/METADATA").decode()
                self.assertIn("Metadata-Version: 2.4", metadata)
                self.assertIn("License-Expression: MIT", metadata)
                self.assertIn(f"License-File: {license_path}", metadata)
                self.assertIn("Description-Content-Type: text/markdown", metadata)
                readme = (Path(__file__).resolve().parents[1] / "README.md").read_text()
                self.assertTrue(metadata.endswith(readme))
                self.assertIn("## Quick start", metadata)
                self.assertIn("## Security", metadata)
                self.assertNotIn("License: Proprietary", metadata)


if __name__ == "__main__":
    unittest.main()
