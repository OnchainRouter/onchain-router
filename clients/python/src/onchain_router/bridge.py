"""Bounded, shell-free subprocess transport. Never capture or expose CLI stderr."""

from __future__ import annotations

import subprocess
import threading
from collections.abc import Sequence

MAX_RESPONSE_BYTES = 16 * 1024 * 1024


def bounded_run(command: Sequence[str], payload: str, timeout: float) -> subprocess.CompletedProcess[str]:
    process = subprocess.Popen(
        command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, shell=False,
    )
    output = bytearray()
    errors: list[Exception] = []

    def write_input() -> None:
        try:
            assert process.stdin is not None
            process.stdin.write(payload.encode("utf-8"))
            process.stdin.close()
        except (BrokenPipeError, OSError, ValueError):
            pass

    def read_output() -> None:
        try:
            assert process.stdout is not None
            while True:
                chunk = process.stdout.read(65_536)
                if not chunk:
                    break
                if len(output) + len(chunk) > MAX_RESPONSE_BYTES:
                    raise ValueError("buyer bridge response exceeded its limit")
                output.extend(chunk)
        except Exception as error:
            errors.append(error)
            process.kill()

    writer = threading.Thread(target=write_input, daemon=True)
    reader = threading.Thread(target=read_output, daemon=True)
    writer.start()
    reader.start()
    try:
        process.wait(timeout=timeout)
        # A child must not keep an inherited output pipe open indefinitely.
        reader.join(timeout=min(timeout, 1.0))
        if reader.is_alive():
            raise subprocess.TimeoutExpired(command, timeout)
        if errors:
            raise ValueError("buyer bridge response exceeded its limit")
        return subprocess.CompletedProcess(command, process.returncode, output.decode("utf-8"), "")
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        writer.join(timeout=1)
        reader.join(timeout=1)
        if process.stdin is not None and not writer.is_alive():
            process.stdin.close()
        if process.stdout is not None and not reader.is_alive():
            process.stdout.close()
