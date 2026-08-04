#!/usr/bin/env python3
"""Run the Windows contract with native path, PowerShell, and cmd adapters."""

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


def run_with_windows_adapters(
    command: Sequence[str | os.PathLike[str]],
    *,
    cwd: Path,
    environment: Mapping[str, str],
    check: bool = True,
    timeout: int = 120,
):
    """Use native statement boundaries while preserving strict shell contracts.

    The nested caller fixture has no manifest. Both child shells therefore prove
    they started at the selected project root by finding ``package.json`` in
    their own current directory and the nested fixture below it. This avoids
    mistaking equivalent ordinary and ``\\?\\`` path spellings for different
    directories.

    cmd.exe uses temporary batch files because a single compound command with
    several ``if`` statements, ``&`` separators, quoted environment expansion,
    and ``exit /b`` is sensitive to whole-line expansion and ``/S`` quote
    normalization. The launcher captures and returns the assertion batch's
    status on a separate native statement boundary.
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

    if shell_name in {"pwsh.exe", "powershell.exe"} and "windows-pwsh-clean-room-ok" in script:
        profile_env = contract.PROFILE_ENV
        parts[command_index] = (
            f"if (Test-Path Env:{profile_env}) {{ throw 'profile loaded' }}; "
            "if ($env:ZED_DEV -ne '1') { throw 'managed environment missing' }; "
            "if (-not (Test-Path -LiteralPath '.\\package.json' -PathType Leaf)) { "
            "throw 'child cwd does not own package.json' }; "
            "if (-not (Test-Path -LiteralPath '.\\src\\nested' -PathType Container)) { "
            "throw 'child cwd is not the selected project root' }; "
            "if (Test-Path Env:DOTENV_CANARY) { throw 'dotenv loaded' }; "
            "Write-Output 'windows-pwsh-clean-room-ok'; exit 29"
        )

    if shell_name == "cmd.exe" and "windows-cmd-clean-room-ok" in script:
        assertion_batch = cwd / "zed-develop-cmd-contract.cmd"
        assertion_batch.write_text(
            "@echo off\r\n"
            "if not \"%ZED_DEV%\"==\"1\" exit /b 41\r\n"
            "if not exist \".\\package.json\" exit /b 42\r\n"
            "if not exist \".\\src\\nested\\\" exit /b 43\r\n"
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
        parts[command_index] = f'"{launcher_batch}"'

    return _original_run(
        parts,
        cwd=cwd,
        environment=environment,
        check=check,
        timeout=timeout,
    )


contract.path_key = path_key
contract.run = run_with_windows_adapters
raise SystemExit(contract.main())
