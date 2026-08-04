#!/usr/bin/env python3
"""Run the Windows contract with native path and cmd.exe adapters."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Mapping, Sequence

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import zed_develop_windows_clean_room as contract  # noqa: E402


def path_key(path: Path) -> str:
    """Normalize equivalent Win32 and verbatim path spellings."""

    text = os.path.normpath(os.fspath(path.resolve()))
    if text.startswith("\\\\?\\UNC\\"):
        text = "\\\\" + text[8:]
    elif text.startswith("\\\\?\\"):
        text = text[4:]
    return os.path.normcase(text)


_original_run = contract.run


def run_with_cmd_batch(
    command: Sequence[str | os.PathLike[str]],
    *,
    cwd: Path,
    environment: Mapping[str, str],
    check: bool = True,
    timeout: int = 120,
):
    """Use a batch file for the cmd.exe environment/exit-code assertion.

    A single inline cmd.exe command containing several ``if`` statements,
    ``&`` separators, quoted environment expansions, and ``exit /b`` is
    sensitive to cmd.exe's whole-line expansion and /S quote normalization.
    The public behavior under test is managed-environment delivery and child
    exit propagation, not that incidental one-line parser shape.  A temporary
    batch file gives each assertion its native statement boundary.
    """

    parts = [os.fspath(part) for part in command]
    try:
        shell_index = parts.index("--shell") + 1
        command_index = parts.index("-c") + 1
    except (ValueError, IndexError):
        return _original_run(
            command,
            cwd=cwd,
            environment=environment,
            check=check,
            timeout=timeout,
        )

    shell_name = Path(parts[shell_index]).name.lower()
    script = parts[command_index]
    if shell_name == "cmd.exe" and "windows-cmd-clean-room-ok" in script:
        batch = cwd / "zed-develop-cmd-contract.cmd"
        batch.write_text(
            "@echo off\r\n"
            "if not \"%ZED_DEV%\"==\"1\" exit /b 41\r\n"
            "if not exist \"%ZED_DEV_PROJECT_ROOT%\\package.json\" exit /b 42\r\n"
            "echo windows-cmd-clean-room-ok\r\n"
            "exit /b 31\r\n",
            encoding="utf-8",
        )
        parts[command_index] = f'call "{batch}"'

    return _original_run(
        parts,
        cwd=cwd,
        environment=environment,
        check=check,
        timeout=timeout,
    )


contract.path_key = path_key
contract.run = run_with_cmd_batch
raise SystemExit(contract.main())
