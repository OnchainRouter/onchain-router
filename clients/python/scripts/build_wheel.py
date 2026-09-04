"""Build a deterministic pure-Python wheel without downloading build tooling."""

from __future__ import annotations

import base64
import csv
import hashlib
import io
import zipfile
from pathlib import Path

NAME = "onchain_router"
VERSION = "0.1.0"
WHEEL_NAME = f"{NAME}-{VERSION}-py3-none-any.whl"
DIST_INFO = f"{NAME}-{VERSION}.dist-info"
TIMESTAMP = (1980, 1, 1, 0, 0, 0)


def _entry(path: str, data: bytes) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(path, TIMESTAMP)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    return info


def _digest(data: bytes) -> str:
    encoded = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=")
    return f"sha256={encoded.decode('ascii')}"


def build(output_directory: Path | None = None) -> Path:
    root = Path(__file__).resolve().parents[1]
    destination = output_directory or root / "dist"
    destination.mkdir(parents=True, mode=0o755, exist_ok=True)
    members: dict[str, bytes] = {}
    for source in sorted((root / "src" / NAME).glob("*.py")):
        members[f"{NAME}/{source.name}"] = source.read_bytes()
    members[f"{DIST_INFO}/licenses/LICENSE"] = (root / "LICENSE").read_bytes()
    readme = (root / "README.md").read_text(encoding="utf-8").rstrip() + "\n"
    members[f"{DIST_INFO}/METADATA"] = (
        "Metadata-Version: 2.4\n"
        "Name: onchain-router\n"
        f"Version: {VERSION}\n"
        "Summary: Python SDK for Onchain Router discovery, x402 payments, recovery, and receipts\n"
        "Requires-Python: >=3.10\n"
        "License-Expression: MIT\n"
        f"License-File: {DIST_INFO}/licenses/LICENSE\n"
        "Description-Content-Type: text/markdown\n"
        "Author: AgenticFI\n"
        "Project-URL: Homepage, https://onchainrouter.dev/docs/sdk\n"
        "Project-URL: Repository, https://github.com/AgenticFI/onchain-router-clients\n\n"
        f"{readme}"
    ).encode("utf-8")
    members[f"{DIST_INFO}/WHEEL"] = (
        "Wheel-Version: 1.0\n"
        "Generator: onchain-router-deterministic-builder\n"
        "Root-Is-Purelib: true\n"
        "Tag: py3-none-any\n"
    ).encode()
    members[f"{DIST_INFO}/top_level.txt"] = f"{NAME}\n".encode()
    record_path = f"{DIST_INFO}/RECORD"
    record = io.StringIO(newline="")
    writer = csv.writer(record, lineterminator="\n")
    for path, data in sorted(members.items()):
        writer.writerow((path, _digest(data), str(len(data))))
    writer.writerow((record_path, "", ""))
    members[record_path] = record.getvalue().encode()
    wheel = destination / WHEEL_NAME
    wheel.unlink(missing_ok=True)
    with zipfile.ZipFile(wheel, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path, data in sorted(members.items()):
            archive.writestr(_entry(path, data), data)
    return wheel


if __name__ == "__main__":
    print(build())
