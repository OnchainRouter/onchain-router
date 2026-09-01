"""Subprocess adapter for the authoritative TypeScript Buyer Runtime."""

from __future__ import annotations

import json
import re
import subprocess
from .bridge import bounded_run
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Final

_MAX_BRIDGE_RESPONSE_BYTES: Final = 16 * 1024 * 1024
_ENDPOINTS: Final = frozenset(
    {
        "/v1/chat/completions",
        "/v1/messages",
        "/v1/images/generations",
        "/v1/audio/speech",
        "/v1/audio/transcriptions",
    }
)


class BuyerRuntimeError(RuntimeError):
    """A stable Buyer Runtime outcome and its safe retry directive."""

    def __init__(self, code: str, retry: str, message: str, reference: str | None = None):
        super().__init__(message)
        self.code = code
        self.retry = retry
        self.reference = reference


class OnchainRouterBuyer:
    """Use one unlocked local buyer profile without handling wallet secrets."""

    def __init__(
        self,
        *,
        profile: str | Path | None = None,
        command: Sequence[str] = ("onchain-router",),
        timeout_seconds: float = 330.0,
    ) -> None:
        if not command or any(not isinstance(item, str) or not item for item in command):
            raise ValueError("command must contain non-empty strings")
        if timeout_seconds <= 0 or timeout_seconds > 600:
            raise ValueError("timeout_seconds must be between 0 and 600")
        self._command = tuple(command)
        self._profile = str(Path(profile).expanduser().resolve()) if profile is not None else None
        self._timeout_seconds = timeout_seconds

    def status(self) -> dict[str, Any]:
        return self._run({"action": "status"})

    def models(self) -> dict[str, Any]:
        return self._run({"action": "models"})

    def pricing(self) -> dict[str, Any]:
        return self._run({"action": "pricing"})

    def voices(self) -> dict[str, Any]:
        return self._run({"action": "voices"})

    def balance(self) -> dict[str, Any]:
        return self._run({"action": "balance"})

    def receipt(self, idempotency_key: str) -> dict[str, Any]:
        self._identifier(idempotency_key)
        return self._run({"action": "receipt", "idempotencyKey": idempotency_key})

    def lock(self) -> dict[str, Any]:
        return self._run({"action": "lock"})

    def execute(
        self,
        endpoint: str,
        body: Mapping[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        if endpoint not in _ENDPOINTS:
            raise ValueError("endpoint is not supported by the Buyer Runtime")
        if not isinstance(body.get("model"), str) or not body["model"]:
            raise ValueError("body requires an explicit model")
        request: dict[str, Any] = {"action": "execute", "endpoint": endpoint, "body": dict(body)}
        if idempotency_key is not None:
            self._identifier(idempotency_key)
            request["idempotencyKey"] = idempotency_key
        return self._run(request)

    def chat(
        self,
        *,
        model: str,
        messages: Sequence[Mapping[str, Any]],
        idempotency_key: str | None = None,
        **parameters: Any,
    ) -> dict[str, Any]:
        return self.execute(
            "/v1/chat/completions",
            self._body(
                {"model": model, "messages": [dict(message) for message in messages]}, parameters
            ),
            idempotency_key=idempotency_key,
        )

    def messages(
        self,
        *,
        model: str,
        messages: Sequence[Mapping[str, Any]],
        idempotency_key: str | None = None,
        **parameters: Any,
    ) -> dict[str, Any]:
        return self.execute(
            "/v1/messages",
            self._body(
                {"model": model, "messages": [dict(message) for message in messages]}, parameters
            ),
            idempotency_key=idempotency_key,
        )

    def images(
        self,
        *,
        model: str,
        prompt: str,
        idempotency_key: str | None = None,
        **parameters: Any,
    ) -> dict[str, Any]:
        return self.execute(
            "/v1/images/generations",
            self._body({"model": model, "prompt": prompt}, parameters),
            idempotency_key=idempotency_key,
        )

    def speech(
        self,
        *,
        model: str,
        text: str,
        idempotency_key: str | None = None,
        **parameters: Any,
    ) -> dict[str, Any]:
        return self.execute(
            "/v1/audio/speech",
            self._body({"model": model, "input": text}, parameters),
            idempotency_key=idempotency_key,
        )

    def transcriptions(
        self,
        *,
        model: str,
        audio_base64: str,
        acknowledge_provider_retention: bool = False,
        idempotency_key: str | None = None,
        **parameters: Any,
    ) -> dict[str, Any]:
        if acknowledge_provider_retention is not True:
            raise ValueError("Explicit acknowledgement is required: ElevenLabs may retain audio and transcripts independently of Onchain Router staging deletion.")
        return self.execute(
            "/v1/audio/transcriptions",
            self._body({"model": model, "audio_base64": audio_base64, "acknowledge_provider_retention": True}, parameters),
            idempotency_key=idempotency_key,
        )

    @staticmethod
    def _identifier(value: str) -> None:
        if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", value) is None:
            raise ValueError("idempotency_key is invalid")

    @staticmethod
    def _body(required: Mapping[str, Any], parameters: Mapping[str, Any]) -> dict[str, Any]:
        overlap = set(required).intersection(parameters)
        if overlap:
            raise ValueError(f"parameters cannot override required fields: {', '.join(sorted(overlap))}")
        return {**required, **parameters}

    def _run(self, request: Mapping[str, Any]) -> dict[str, Any]:
        command = [*self._command, "_bridge"]
        if self._profile is not None:
            command.extend(("--profile", self._profile))
        try:
            encoded = json.dumps(request, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError) as error:
            raise ValueError("request is not JSON serializable") from error
        if len(encoded.encode("utf-8")) > 35 * 1024 * 1024:
            raise ValueError("request exceeds the local bridge byte limit")
        try:
            completed = bounded_run(command, encoded, self._timeout_seconds)
        except FileNotFoundError as error:
            raise BuyerRuntimeError(
                "RuntimeUnavailable", "do_not_retry", "onchain-router CLI was not found"
            ) from error
        except subprocess.TimeoutExpired as error:
            raise BuyerRuntimeError(
                "RuntimeUnavailable", "retry_same_idempotency_key", "buyer bridge timed out"
            ) from error
        except (OSError, ValueError) as error:
            raise BuyerRuntimeError("RuntimeUnavailable", "retry_same_idempotency_key", "buyer bridge did not complete safely") from error
        if completed.returncode != 0:
            raise BuyerRuntimeError("RuntimeUnavailable", "retry_same_idempotency_key", "buyer bridge exited unexpectedly")
        if len(completed.stdout.encode("utf-8")) > _MAX_BRIDGE_RESPONSE_BYTES:
            raise BuyerRuntimeError(
                "RuntimeUnavailable", "do_not_retry", "buyer bridge response exceeded 16 MiB"
            )
        try:
            envelope = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise BuyerRuntimeError(
                "RuntimeUnavailable", "do_not_retry", "buyer bridge returned malformed JSON"
            ) from error
        if not isinstance(envelope, dict) or envelope.get("version") != 1:
            raise BuyerRuntimeError(
                "RuntimeUnavailable", "do_not_retry", "buyer bridge returned an invalid envelope"
            )
        if envelope.get("ok") is not True:
            failure = envelope.get("error")
            if not isinstance(failure, dict):
                raise BuyerRuntimeError(
                    "RuntimeUnavailable", "do_not_retry", "buyer bridge returned an invalid error"
                )
            raise BuyerRuntimeError(
                str(failure.get("code", "RuntimeUnavailable")),
                str(failure.get("retry", "do_not_retry")),
                str(failure.get("message", "buyer request failed")),
                str(failure["reference"]) if failure.get("reference") else None,
            )
        result = envelope.get("result")
        if not isinstance(result, dict):
            raise BuyerRuntimeError(
                "RuntimeUnavailable", "do_not_retry", "buyer bridge result is not an object"
            )
        return result
