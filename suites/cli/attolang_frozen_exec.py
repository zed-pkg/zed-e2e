#!/usr/bin/env python3
"""Run a caller-supplied compiler command using frozen Zed AttoLang roots.

This is an adapter, NOT a compiler conformance oracle: even a successful
compiler command is not by itself proof that an AttoLang guest executed.
"""

from __future__ import annotations

import argparse
import json
import os
import stat
from pathlib import Path
import subprocess
import sys
import tempfile

MAX_JSON_BYTES = 1024 * 1024
MAX_PATHS = 512
MAX_PATH_BYTES = 4096


class AdmissionError(Exception):
    pass


def _require_native_marker(root: Path) -> None:
    """Require one regular native marker, never both or a symlink."""
    found = []
    for name in (".atto.pkg.toml", ".ores.pkg.toml"):
        marker = root / name
        try:
            metadata = marker.lstat()
        except FileNotFoundError:
            continue
        if not stat.S_ISREG(metadata.st_mode):
            raise AdmissionError(f"AttoLang marker {marker} must be a regular file")
        found.append(name)
    if len(found) != 1:
        raise AdmissionError(
            f"expected exactly one AttoLang source marker at {root}: "
            ".atto.pkg.toml or legacy .ores.pkg.toml"
        )


def _run_zed(zed: str, args: list[str], root: Path) -> None:
    completed = subprocess.run([zed, *args], cwd=root, check=False)
    if completed.returncode != 0:
        raise AdmissionError(f"zed {' '.join(args)} failed (exit {completed.returncode})")


def _project_paths(zed: str, root: Path) -> str:
    # Do not capture arbitrary CLI output in memory. The JSON bridge is
    # untrusted input even when its producer is a real Zed executable.
    with tempfile.TemporaryFile(mode="w+b") as output:
        result = subprocess.run(
            [zed, "attolang", "paths", "--json"],
            cwd=root,
            stdout=output,
            check=False,
        )
        if result.returncode != 0:
            raise AdmissionError(f"zed attolang paths --json failed (exit {result.returncode})")
        size = output.tell()
        if size > MAX_JSON_BYTES:
            raise AdmissionError("Zed path projection exceeds 1 MiB")
        output.seek(0)
        try:
            data = json.loads(output.read().decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise AdmissionError("invalid UTF-8 or JSON in Zed path projection") from exc

    if not isinstance(data, dict) or data.get("env") != "ATTO_PATHS":
        raise AdmissionError("Zed did not return canonical ATTO_PATHS metadata")
    if data.get("legacy_env") != "ORES_PATHS":
        raise AdmissionError("Zed did not declare the ORES_PATHS compatibility alias")
    paths = data.get("paths")
    if not isinstance(paths, list) or not 1 <= len(paths) <= MAX_PATHS:
        raise AdmissionError("expected 1 to 512 installed AttoLang paths")
    seen: set[str] = set()
    for raw in paths:
        if not isinstance(raw, str) or not raw or len(raw.encode("utf-8")) > MAX_PATH_BYTES:
            raise AdmissionError("empty, non-string or oversized package root")
        if raw in seen:
            raise AdmissionError("duplicate AttoLang import root")
        seen.add(raw)
        if any(ord(c) < 32 or ord(c) == 127 for c in raw) or os.pathsep in raw:
            raise AdmissionError("control character or path-list delimiter in import root")
        if os.name != "nt" and "\\" in raw:
            raise AdmissionError("backslash in POSIX import root")
        path = Path(raw)
        # The bridge is always invoked at the root, not in a nested cwd;
        # paths should be lexical slots below that root, not an arbitrary
        # compiler filesystem search path injected by a caller.
        if path.is_absolute() or any(part in ("..", ".") for part in raw.replace("\\", "/").split("/")):
            raise AdmissionError("absolute or traversing AttoLang import root")
        if not (root / path).is_dir():
            raise AdmissionError("Zed import root is absent or not a directory")
        _require_native_marker(root / path)

    value = data.get("value")
    joined = os.pathsep.join(paths)
    if not isinstance(value, str) or value != joined:
        raise AdmissionError("Zed path-list value differs from its JSON paths")
    return joined


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--" not in argv:
        print("usage: attolang_frozen_exec.py [--project DIR] [--zed ZED] -- COMPILER [ARGS...]", file=sys.stderr)
        return 2
    separator = argv.index("--")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=Path.cwd())
    parser.add_argument("--zed", default="zed")
    args = parser.parse_args(argv[:separator])
    compiler_command = argv[separator + 1 :]
    if not compiler_command:
        print("compiler command required after --", file=sys.stderr)
        return 2
    root = args.project.resolve()
    for filename in (".zpkg.toml", ".zpkg.lock"):
        if not (root / filename).is_file():
            print(f"AttoLang admission failed: missing {filename}", file=sys.stderr)
            return 2
    try:
        _require_native_marker(root)
        # No lifecycle shortcuts: reject malformed lockfiles, then enforce
        # the actual frozen installation before projecting path roots.
        _run_zed(args.zed, ["validate", "--require-lock"], root)
        _run_zed(args.zed, ["install", "--frozen"], root)
        projected = _project_paths(args.zed, root)
    except (AdmissionError, OSError) as exc:
        print(f"AttoLang admission failed: {exc}", file=sys.stderr)
        return 2

    env = os.environ.copy()
    # Keep the canonical and old compiler spellings synchronized. Ambient
    # ORES_PATHS/ATTO_PATHS may not override the locked Zed projection.
    env.update(ATTO_PATHS=projected, ORES_PATHS=projected, ORESLANG_PATH=projected)
    try:
        return subprocess.run(compiler_command, cwd=root, env=env, check=False).returncode
    except OSError as exc:
        print(f"AttoLang compiler invocation failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
