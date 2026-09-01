import subprocess
import sys
import unittest
from unittest.mock import patch
from onchain_router.bridge import bounded_run


class BoundedBridgeTest(unittest.TestCase):
    def test_round_trip_never_captures_stderr(self):
        result = bounded_run([sys.executable, "-c", "import sys; print(sys.stdin.read()); print('secret',file=sys.stderr)"], "safe", 2)
        self.assertEqual(result.stdout.strip(), "safe")
        self.assertEqual(result.stderr, "")

    def test_output_is_bounded_while_reading(self):
        with patch("onchain_router.bridge.MAX_RESPONSE_BYTES", 1024):
            with self.assertRaises(ValueError):
                bounded_run([sys.executable, "-c", "print('x'*65536)"], "", 2)

    def test_timeout_stops_only_the_bridge_child(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            bounded_run([sys.executable, "-c", "import time; time.sleep(2)"], "", 0.05)
