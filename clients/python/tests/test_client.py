from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from onchain_router import BuyerRuntimeError, OnchainRouterBuyer


class BuyerClientTest(unittest.TestCase):
    @patch("onchain_router.client.bounded_run")
    def test_chat_uses_versioned_bridge_without_secrets(self, run) -> None:
        run.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout='{"version":1,"ok":true,"result":{"ok":true}}', stderr=""
        )
        buyer = OnchainRouterBuyer(profile="./profile", command=("router-cli",))
        self.assertEqual(
            buyer.chat(
                model="gemini-2.5-flash",
                messages=[{"role": "user", "content": "hello"}],
                idempotency_key="python-test-1",
                max_tokens=64,
            ),
            {"ok": True},
        )
        call = run.call_args
        self.assertEqual(call.args[0][0:2], ["router-cli", "_bridge"])
        request = json.loads(call.args[1])
        self.assertEqual(request["endpoint"], "/v1/chat/completions")
        self.assertEqual(request["idempotencyKey"], "python-test-1")
        self.assertNotIn("privateKey", call.args[1])
        self.assertNotIn("passphrase", call.args[1])
        self.assertEqual(call.args[2], 330.0)

    @patch("onchain_router.client.bounded_run")
    def test_preserves_stable_outcome_and_retry_directive(self, run) -> None:
        run.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout=json.dumps(
                {
                    "version": 1,
                    "ok": False,
                    "error": {
                        "code": "SettlementOutcomeUnknown",
                        "retry": "human_review",
                        "message": "outcome unknown",
                    },
                }
            ),
            stderr="",
        )
        with self.assertRaises(BuyerRuntimeError) as caught:
            OnchainRouterBuyer(command=("router-cli",)).status()
        self.assertEqual(caught.exception.code, "SettlementOutcomeUnknown")
        self.assertEqual(caught.exception.retry, "human_review")

    def test_rejects_arbitrary_endpoints_and_invalid_idempotency_keys(self) -> None:
        buyer = OnchainRouterBuyer(command=("router-cli",))
        with self.assertRaises(ValueError):
            buyer.execute("https://attacker.example/pay", {"model": "x"})
        with self.assertRaises(ValueError):
            buyer.chat(model="x", messages=[], idempotency_key="contains spaces")

    @patch("onchain_router.client.bounded_run", side_effect=FileNotFoundError())
    def test_missing_cli_is_a_safe_runtime_error(self, _run) -> None:
        with self.assertRaises(BuyerRuntimeError) as caught:
            OnchainRouterBuyer(command=("missing",)).models()
        self.assertEqual(caught.exception.code, "RuntimeUnavailable")
        self.assertEqual(caught.exception.retry, "do_not_retry")

    @patch("onchain_router.client.bounded_run")
    def test_convenience_methods_match_shared_cross_language_vectors(self, run) -> None:
        run.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout='{"version":1,"ok":true,"result":{"ok":true}}', stderr=""
        )
        vectors = json.loads(
            (Path(__file__).resolve().parents[3] / "test-vectors" / "buyer-adapter-v1.json").read_text()
        )
        buyer = OnchainRouterBuyer(command=("router-cli",))
        for case in vectors["cases"]:
            body = case["body"]
            method = case["method"]
            if method in ("chat", "messages"):
                getattr(buyer, method)(model=body["model"], messages=body["messages"])
            elif method == "images":
                buyer.images(model=body["model"], prompt=body["prompt"])
            elif method == "speech":
                buyer.speech(model=body["model"], text=body["input"])
            elif method == "transcriptions":
                buyer.transcriptions(model=body["model"], audio_base64=body["audio_base64"], acknowledge_provider_retention=True)
            else:
                self.fail(f"unknown vector method: {method}")
            request = json.loads(run.call_args.args[1])
            self.assertEqual(request["endpoint"], case["endpoint"])
            self.assertEqual(request["body"], body)


if __name__ == "__main__":
    unittest.main()
