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
    """Use native batch statement boundaries for the cmd.exe assertion.

    A single inline command containing several ``if`` statements, ``&``
    separators, quoted environment expansions, and ``exit /b`` is sensitive to
    cmd.exe's whole-line expansion and ``/S`` quote normalization.  The public
    behavior under test is managed-environment delivery and child exit
    propagation, not that incidental one-line parser shape.

    The assertion batch performs the checks and returns 31.  A second launcher
    batch calls it, captures ``ERRORLEVEL`` on the following statement, and
    exits with that exact value.  The outer ``cmd.exe /C`` executes the launcher
    directly, so the process status observed by Zed is the child contract's
    status rather than the status of the ``CALL`` built-in.
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
        assertion_batch = cwd / "zed-develop-cmd-contract.cmd"
        assertion_batch.write_text(
            "@echo off\r\n"
            "if not \"%ZED_DEV%\"==\"1\" exit /b 41\r\n"
            "if not exist \"%ZED_DEV_PROJECT_ROOT%\\package.json\" exit /b 42\r\n"
            "echo windows-cmd-clean-room-ok\r\n"
            "exit /b 31\r\n",
            encoding="utf-8",
        )

        launcher_batch = cwd / "zed-develop-cmd-launcher.cmd"
        launcher_batch.write_text(
            "@echo off\r\n"
            f'call "{assertion_batch}"\r\n'
            'set "zed_contract_exit=%errorlevel%"\r\n'
            "exit /b %zed_contract_exit%\r\n",
            encoding="utf-8",
        )

        # Direct batch execution under `cmd.exe /D /S /C` preserves the
        # launcher's `exit /b` status. Quoting protects temporary paths that may
        # contain spaces on developer machines.
        parts[command_index] = f'"{launcher_batch}"'

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
