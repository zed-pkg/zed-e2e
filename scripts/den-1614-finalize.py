#!/usr/bin/env python3
"""Finalize Windows assertions without relying on textual path prefixes."""

from pathlib import Path

source = Path("tests/cli/zed_develop_windows_clean_room.py")
text = source.read_text(encoding="utf-8")

old_powershell = '''        ps_script = (
            f"if (Test-Path Env:{PROFILE_ENV}) {{ throw 'profile loaded' }}; "
            "if ($env:ZED_DEV -ne '1') { throw 'managed environment missing' }; "
            "if ([IO.Path]::GetFullPath((Get-Location).Path) -ne "
            "[IO.Path]::GetFullPath($env:ZED_DEV_PROJECT_ROOT)) { throw 'root mismatch' }; "
            "if (Test-Path Env:DOTENV_CANARY) { throw 'dotenv loaded' }; "
            "Write-Output 'windows-pwsh-clean-room-ok'; exit 29"
        )
'''
new_powershell = '''        ps_script = (
            f"if (Test-Path Env:{PROFILE_ENV}) {{ throw 'profile loaded' }}; "
            "if ($env:ZED_DEV -ne '1') { throw 'managed environment missing' }; "
            "if (-not (Test-Path -LiteralPath "
            "(Join-Path $env:ZED_DEV_PROJECT_ROOT 'package.json') -PathType Leaf)) { "
            "throw 'project root does not own package.json' }; "
            "if (Test-Path Env:DOTENV_CANARY) { throw 'dotenv loaded' }; "
            "Write-Output 'windows-pwsh-clean-room-ok'; exit 29"
        )
'''

old_cmd = '''        cmd_script = (
            'if not "%ZED_DEV%"=="1" exit /b 41 & '
            'if not "%CD%"=="%ZED_DEV_PROJECT_ROOT%" exit /b 42 & '
            'echo windows-cmd-clean-room-ok & exit /b 31'
        )
'''
new_cmd = '''        cmd_script = (
            'if not "%ZED_DEV%"=="1" exit /b 41 & '
            'if not exist "%ZED_DEV_PROJECT_ROOT%\\\\package.json" exit /b 42 & '
            'echo windows-cmd-clean-room-ok & exit /b 31'
        )
'''

for old, new, label in (
    (old_powershell, new_powershell, "PowerShell"),
    (old_cmd, new_cmd, "cmd.exe"),
):
    if text.count(old) != 1:
        raise SystemExit(f"expected exactly one {label} assertion block")
    text = text.replace(old, new, 1)

source.write_text(text, encoding="utf-8")
Path(__file__).unlink()
