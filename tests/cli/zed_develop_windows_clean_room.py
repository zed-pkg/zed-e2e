#!/usr/bin/env python3
"""Independent Windows acceptance for `zed develop` and `zed dev`.

The suite imports no zed-cli test helpers. It executes one immutable Windows
candidate as an external consumer and retains only bounded, non-secret evidence.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Mapping, Sequence

CLEAN_ENV_KEYS = {
    "CLASSPATH",
    "HOME",
    "IN_NIX_SHELL",
    "PYTHONPATH",
    "SHELL",
    "USERPROFILE",
    "VIRTUAL_ENV",
    "ZED_PKG_ALLOW_BUILD",
    "ZED_PKG_AUTH_URL",
    "ZED_PKG_FROZEN",
    "ZED_PKG_HOME",
    "ZED_PKG_REGISTRY",
    "ZED_PKG_SUPABASE_KEY",
    "ZED_PKG_SUPABASE_URL",
    "ZED_PKG_TOKEN",
}
CLEAN_ENV_PREFIXES = ("ZED_DEV_",)
CANARIES = {
    "INHERITED_SECRET": "windows-clean-room-inherited-secret-canary",
    "ZED_PKG_TOKEN": "windows-clean-room-registry-token-canary",
    "DOTENV_CANARY": "windows-clean-room-dotenv-canary",
    "DIRENV_CANARY": "windows-clean-room-direnv-canary",
    "PROD_ENV_CANARY": "windows-clean-room-production-env-canary",
    "PROFILE_CANARY": "windows-clean-room-powershell-profile-canary",
    "CODEX_CANARY": "windows-clean-room-codex-credential-canary",
    "AWS_CANARY": "windows-clean-room-aws-credential-canary",
    "GCLOUD_CANARY": "windows-clean-room-gcloud-credential-canary",
    "GH_CANARY": "windows-clean-room-gh-credential-canary",
    "NPM_CANARY": "windows-clean-room-npm-credential-canary",
}
PROFILE_ENV = "ZED_WINDOWS_PROFILE_CANARY"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zed", required=True, type=Path)
    parser.add_argument("--artifact-dir", required=True, type=Path)
    parser.add_argument("--candidate-sha", required=True)
    parser.add_argument("--interfaces-sha", required=True)
    parser.add_argument("--flags2env-sha", required=True)
    return parser.parse_args()


def clean_environment() -> dict[str, str]:
    environment = {
        key: value
        for key, value in os.environ.items()
        if key not in CLEAN_ENV_KEYS
        and not any(key.startswith(prefix) for prefix in CLEAN_ENV_PREFIXES)
    }
    environment.update(
        {
            "CI": "1",
            "NO_COLOR": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
    )
    return environment


def run(
    command: Sequence[str | os.PathLike[str]],
    *,
    cwd: Path,
    environment: Mapping[str, str],
    check: bool = True,
    timeout: int = 120,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [os.fspath(part) for part in command],
        cwd=cwd,
        env=dict(environment),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )
    if check and result.returncode != 0:
        raise AssertionError(
            "command failed\n"
            f"argv={command!r}\n"
            f"cwd={cwd}\n"
            f"exit={result.returncode}\n"
            f"stdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        )
    return result


def run_bytes(
    command: Sequence[str | os.PathLike[str]],
    *,
    cwd: Path,
    environment: Mapping[str, str],
    check: bool = True,
    timeout: int = 120,
) -> subprocess.CompletedProcess[bytes]:
    result = subprocess.run(
        [os.fspath(part) for part in command],
        cwd=cwd,
        env=dict(environment),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )
    if check and result.returncode != 0:
        raise AssertionError(
            "command failed\n"
            f"argv={command!r}\n"
            f"cwd={cwd}\n"
            f"exit={result.returncode}\n"
            f"stdout:\n{result.stdout.decode(errors='replace')}\n"
            f"stderr:\n{result.stderr.decode(errors='replace')}"
        )
    return result


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def locate(program: str) -> Path:
    path = shutil.which(program)
    if not path:
        raise AssertionError(f"required Windows program is unavailable: {program}")
    return Path(path).resolve(strict=True)


def path_key(path: Path) -> str:
    return os.path.normcase(os.path.normpath(os.fspath(path.resolve())))


def assert_no_canaries(text: str, context: str) -> None:
    leaked = [name for name, value in CANARIES.items() if value in text]
    if leaked:
        raise AssertionError(f"{context} leaked canaries: {leaked}")


def managed_environment(
    zed: Path,
    spelling: str,
    *,
    cwd: Path,
    environment: Mapping[str, str],
    extra: Sequence[str] = (),
    global_options: Sequence[str] = (),
) -> tuple[dict[str, str], bytes, bytes]:
    result = run_bytes(
        [
            zed,
            *global_options,
            spelling,
            "--no-install",
            "--nix",
            "never",
            "--mise",
            "never",
            "--python-venv",
            "never",
            *extra,
            "--print-env",
        ],
        cwd=cwd,
        environment=environment,
    )
    parsed = json.loads(result.stdout.decode("utf-8"))
    if not isinstance(parsed, dict) or not all(
        isinstance(key, str) and isinstance(value, str)
        for key, value in parsed.items()
    ):
        raise AssertionError(f"managed environment is not a string map: {parsed!r}")
    return parsed, result.stdout, result.stderr


def assert_project_root(environment: Mapping[str, str], project: Path) -> None:
    actual = Path(environment["ZED_DEV_PROJECT_ROOT"])
    if path_key(actual) != path_key(project):
        raise AssertionError(f"project root mismatch: actual={actual}, expected={project}")


def ps_quote(value: str | os.PathLike[str]) -> str:
    return "'" + os.fspath(value).replace("'", "''") + "'"


def python_check_script(python: Path, marker: str) -> str:
    code = (
        "import os, pathlib; "
        "assert os.environ['ZED_DEV'] == '1'; "
        "assert pathlib.Path.cwd().resolve() == "
        "pathlib.Path(os.environ['ZED_DEV_PROJECT_ROOT']).resolve(); "
        f"print({marker!r})"
    )
    return f"& {ps_quote(python)} -c {ps_quote(code)}"


def discover_powershell_profiles(
    powershell: Path,
    source_home: Path,
    environment: Mapping[str, str],
) -> list[Path]:
    script = (
        "$ErrorActionPreference = 'Stop'; "
        "Write-Output $HOME; "
        "Write-Output $PROFILE.CurrentUserAllHosts; "
        "Write-Output $PROFILE.CurrentUserCurrentHost"
    )
    result = run(
        [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        cwd=source_home,
        environment=environment,
    )
    lines = [Path(line.strip()) for line in result.stdout.splitlines() if line.strip()]
    if len(lines) < 3:
        raise AssertionError(f"unexpected PowerShell profile discovery: {lines!r}")
    if path_key(lines[0]) != path_key(source_home):
        raise AssertionError(f"PowerShell HOME was not isolated: {lines[0]}")
    profiles: list[Path] = []
    home_prefix = path_key(source_home) + os.sep
    for profile in lines[1:]:
        key = path_key(profile)
        if not key.startswith(home_prefix):
            raise AssertionError(f"refusing to write a profile outside temporary HOME: {profile}")
        if profile not in profiles:
            profiles.append(profile)
    return profiles


def install_profile_canaries(profiles: Sequence[Path]) -> None:
    body = (
        f"$env:{PROFILE_ENV} = '{CANARIES['PROFILE_CANARY']}'\n"
        f"Write-Output '{CANARIES['PROFILE_CANARY']}'\n"
    )
    for profile in profiles:
        write(profile, body)


def prove_profile_fixture_is_active(
    powershell: Path,
    source_home: Path,
    environment: Mapping[str, str],
) -> None:
    fixture_environment = dict(environment)
    fixture_environment.pop(PROFILE_ENV, None)
    result = run(
        [
            powershell,
            "-NoLogo",
            "-NonInteractive",
            "-Command",
            f"if ($env:{PROFILE_ENV} -ne '{CANARIES['PROFILE_CANARY']}') {{ exit 47 }}; exit 0",
        ],
        cwd=source_home,
        environment=fixture_environment,
        check=False,
    )
    if result.returncode != 0 or CANARIES["PROFILE_CANARY"] not in result.stdout:
        raise AssertionError(
            "PowerShell profile fixture was not active without -NoProfile\n"
            f"exit={result.returncode}\nstdout={result.stdout!r}\nstderr={result.stderr!r}"
        )


def assert_failure(
    result: subprocess.CompletedProcess[str],
    expected: Sequence[str],
    context: str,
) -> None:
    if result.returncode == 0:
        raise AssertionError(f"{context} unexpectedly succeeded")
    combined = result.stdout + result.stderr
    for fragment in expected:
        if fragment not in combined:
            raise AssertionError(f"{context} omitted {fragment!r}: {combined!r}")
    assert_no_canaries(combined, context)


def main() -> int:
    if os.name != "nt":
        raise SystemExit("this acceptance suite requires native Windows")

    args = parse_args()
    zed = args.zed.resolve(strict=True)
    artifact_dir = args.artifact_dir.resolve()
    artifact_dir.mkdir(parents=True, exist_ok=True)
    python = Path(sys.executable).resolve(strict=True)
    powershell = locate("pwsh.exe")
    cmd = locate("cmd.exe")
    completed: list[str] = []

    with tempfile.TemporaryDirectory(prefix="zed-develop-windows-clean-room-") as raw_temp:
        temporary_root = Path(raw_temp).resolve()
        project = temporary_root / "project"
        nested = project / "src" / "nested"
        source_home = temporary_root / "source-home"
        zed_home = temporary_root / "zed-home"
        explicit_home = temporary_root / "explicit-zed-home"
        nested.mkdir(parents=True)
        source_home.mkdir()
        zed_home.mkdir()

        write(project / "package.json", "{}\n")
        write(project / ".env", f"DOTENV_CANARY={CANARIES['DOTENV_CANARY']}\n")
        write(project / ".envrc", f"$env:DIRENV_CANARY='{CANARIES['DIRENV_CANARY']}'\n")
        write(project / "env" / ".prod.env", f"PROD_ENV_CANARY={CANARIES['PROD_ENV_CANARY']}\n")
        write(source_home / ".codex" / "auth.json", json.dumps({"token": CANARIES["CODEX_CANARY"]}))
        write(source_home / ".aws" / "credentials", f"[default]\naws_secret_access_key={CANARIES['AWS_CANARY']}\n")
        write(
            source_home / ".config" / "gcloud" / "application_default_credentials.json",
            json.dumps({"private_key": CANARIES["GCLOUD_CANARY"]}),
        )
        write(source_home / ".config" / "gh" / "hosts.yml", f"github.com:\n  oauth_token: {CANARIES['GH_CANARY']}\n")
        write(source_home / ".npmrc", f"//registry.invalid/:_authToken={CANARIES['NPM_CANARY']}\n")

        environment = clean_environment()
        environment.update(
            {
                "HOME": str(source_home),
                "USERPROFILE": str(source_home),
                "COMSPEC": str(cmd),
                "ZED_PKG_HOME": str(zed_home),
                "INHERITED_SECRET": CANARIES["INHERITED_SECRET"],
                "ZED_PKG_TOKEN": CANARIES["ZED_PKG_TOKEN"],
            }
        )
        environment.pop(PROFILE_ENV, None)

        profiles = discover_powershell_profiles(powershell, source_home, environment)
        install_profile_canaries(profiles)
        prove_profile_fixture_is_active(powershell, source_home, environment)
        completed.append("powershell-profile-fixture-active")

        initial_entries = {entry.name for entry in project.iterdir()}
        canonical, canonical_bytes, canonical_stderr = managed_environment(
            zed, "develop", cwd=nested, environment=environment
        )
        alias, alias_bytes, alias_stderr = managed_environment(
            zed, "dev", cwd=nested, environment=environment
        )
        if canonical_bytes != alias_bytes or canonical_stderr != alias_stderr or canonical != alias:
            raise AssertionError("`zed develop` and `zed dev` managed output differs")
        if canonical.get("ZED_DEV") != "1":
            raise AssertionError("ZED_DEV is not active")
        assert_project_root(canonical, project)
        assert_no_canaries(
            (canonical_bytes + canonical_stderr).decode("utf-8", errors="replace"),
            "managed environment",
        )
        completed.extend(
            [
                "canonical-alias-byte-equivalence",
                "nested-project-root-selection",
                "managed-overlay-secret-redaction",
            ]
        )

        routed, routed_bytes, routed_stderr = managed_environment(
            zed,
            "dev",
            cwd=nested,
            environment=environment,
            global_options=(
                "--registry=http://127.0.0.1:9",
                f"--home={explicit_home}",
            ),
        )
        assert_project_root(routed, project)
        assert_no_canaries(
            (routed_bytes + routed_stderr).decode("utf-8", errors="replace"),
            "global-option routing",
        )
        completed.append("global-options-before-alias")

        isolated, isolated_bytes, isolated_stderr = managed_environment(
            zed,
            "dev",
            cwd=nested,
            environment=environment,
            extra=("--isolated-home",),
        )
        expected_managed_home = (project / ".zed" / "dev" / "home").resolve()
        for key in ("HOME", "USERPROFILE"):
            if path_key(Path(isolated[key])) != path_key(expected_managed_home):
                raise AssertionError(f"{key} was not isolated: {isolated[key]!r}")
        for relative in (
            ".codex/auth.json",
            ".aws/credentials",
            ".config/gcloud/application_default_credentials.json",
            ".config/gh/hosts.yml",
            ".npmrc",
        ):
            if (expected_managed_home / relative).exists():
                raise AssertionError(f"credential was copied into isolated home: {relative}")
        assert_no_canaries(
            (isolated_bytes + isolated_stderr).decode("utf-8", errors="replace"),
            "isolated home",
        )
        completed.append("isolated-home-and-userprofile-no-credential-copy")

        unexpected_entries = {entry.name for entry in project.iterdir()} - (initial_entries | {".zed"})
        if unexpected_entries:
            raise AssertionError(f"--no-install created unexpected project entries: {unexpected_entries}")
        if (project / ".zpkg.toml").exists() or (project / ".zpkg.lock").exists():
            raise AssertionError("--no-install created Zed manifest or lock state")
        completed.append("bounded-no-install-write-set")

        ps_script = (
            f"if (Test-Path Env:{PROFILE_ENV}) {{ throw 'profile loaded' }}; "
            "if ($env:ZED_DEV -ne '1') { throw 'managed environment missing' }; "
            "if (-not (Test-Path -LiteralPath "
            "(Join-Path $env:ZED_DEV_PROJECT_ROOT 'package.json') -PathType Leaf)) { "
            "throw 'project root does not own package.json' }; "
            "if (Test-Path Env:DOTENV_CANARY) { throw 'dotenv loaded' }; "
            "Write-Output 'windows-pwsh-clean-room-ok'; exit 29"
        )
        ps_result = run(
            [
                zed,
                "dev",
                "--no-install",
                "--nix",
                "never",
                "--mise",
                "never",
                "--python-venv",
                "never",
                "--shell",
                powershell,
                "-c",
                ps_script,
            ],
            cwd=nested,
            environment=environment,
            check=False,
        )
        if ps_result.returncode != 29 or "windows-pwsh-clean-room-ok" not in ps_result.stdout:
            raise AssertionError(
                f"PowerShell command/exit contract failed: {ps_result.returncode}\n"
                f"stdout={ps_result.stdout!r}\nstderr={ps_result.stderr!r}"
            )
        assert_no_canaries(ps_result.stdout + ps_result.stderr, "PowerShell command")
        completed.extend(["powershell-no-profile-command", "powershell-child-exit-propagation"])

        cmd_script = (
            'if not "%ZED_DEV%"=="1" exit /b 41 & '
            'if not exist "%ZED_DEV_PROJECT_ROOT%\\package.json" exit /b 42 & '
            'echo windows-cmd-clean-room-ok & exit /b 31'
        )
        cmd_result = run(
            [
                zed,
                "dev",
                "--no-install",
                "--nix",
                "never",
                "--mise",
                "never",
                "--python-venv",
                "never",
                "--shell",
                cmd,
                "-c",
                cmd_script,
            ],
            cwd=nested,
            environment=environment,
            check=False,
        )
        if cmd_result.returncode != 31 or "windows-cmd-clean-room-ok" not in cmd_result.stdout:
            raise AssertionError(
                f"cmd.exe command/exit contract failed: {cmd_result.returncode}\n"
                f"stdout={cmd_result.stdout!r}\nstderr={cmd_result.stderr!r}"
            )
        assert_no_canaries(cmd_result.stdout + cmd_result.stderr, "cmd.exe command")
        completed.extend(["cmd-managed-environment", "cmd-child-exit-propagation"])

        default_cmd = run(
            [
                zed,
                "dev",
                "--no-install",
                "--nix",
                "never",
                "--mise",
                "never",
                "--python-venv",
                "never",
                "-c",
                "echo windows-default-comspec-ok",
            ],
            cwd=nested,
            environment=environment,
        )
        if "windows-default-comspec-ok" not in default_cmd.stdout:
            raise AssertionError("default COMSPEC shell was not used")
        completed.append("default-comspec-command")

        environment_only = dict(environment)
        environment_only.update(
            {
                "ZED_DEV_COMMAND": "Write-Output 'windows-flags2env-ok'",
                "ZED_DEV_SHELL": str(powershell),
                "ZED_DEV_NIX": "never",
                "ZED_DEV_MISE": "never",
                "ZED_DEV_NO_INSTALL": "yes",
                "ZED_DEV_PYTHON_VENV": "never",
            }
        )
        env_result = run([zed, "dev"], cwd=nested, environment=environment_only)
        if "windows-flags2env-ok" not in env_result.stdout:
            raise AssertionError("environment-only flags2env invocation failed")
        assert_no_canaries(env_result.stdout + env_result.stderr, "flags2env environment")
        completed.append("flags2env-environment-only")

        precedence_environment = dict(environment)
        precedence_environment["ZED_DEV_NIX"] = "required"
        precedence_environment["ZED_DEV_MISE"] = "required"
        precedence = run(
            [
                zed,
                "dev",
                "--no-install",
                "--nix",
                "never",
                "--mise",
                "never",
                "--python-venv",
                "never",
                "--shell",
                powershell,
                "-c",
                "Write-Output 'windows-cli-precedence-ok'",
            ],
            cwd=nested,
            environment=precedence_environment,
        )
        if "windows-cli-precedence-ok" not in precedence.stdout:
            raise AssertionError("CLI did not override inherited Nix/mise modes")
        completed.append("cli-over-environment-precedence")

        python_project = temporary_root / "python-project"
        python_nested = python_project / "nested"
        python_nested.mkdir(parents=True)
        write(
            python_project / "pyproject.toml",
            "[project]\nname = 'windows-clean-room-python'\nversion = '0.0.0'\n",
        )
        venv = python_project / ".custom" / "venv"
        venv_code = (
            "import os, pathlib, sys; "
            "expected=pathlib.Path(os.environ['VIRTUAL_ENV']).resolve(); "
            "assert pathlib.Path(sys.prefix).resolve() == expected; "
            "assert expected == pathlib.Path(os.environ['ZED_DEV_PROJECT_ROOT'], '.custom', 'venv').resolve(); "
            "assert pathlib.Path(sys.executable).parent.name.lower() == 'scripts'; "
            "print('windows-python-venv-ok')"
        )
        venv_script = f"python -c {ps_quote(venv_code)}"
        venv_result = run(
            [
                zed,
                "dev",
                "--no-install",
                "--nix",
                "never",
                "--mise",
                "never",
                "--python-venv",
                "required",
                "--python",
                python,
                "--venv",
                ".custom/venv",
                "--shell",
                powershell,
                "-c",
                venv_script,
            ],
            cwd=python_nested,
            environment=environment,
            timeout=180,
        )
        if "windows-python-venv-ok" not in venv_result.stdout or not (venv / "Scripts").is_dir():
            raise AssertionError(
                f"Windows Python venv contract failed\nstdout={venv_result.stdout!r}\n"
                f"stderr={venv_result.stderr!r}"
            )
        completed.append("windows-project-python-venv")

        missing_shell = temporary_root / "missing-shell.exe"
        missing = run(
            [
                zed,
                "dev",
                "--no-install",
                "--nix",
                "never",
                "--mise",
                "never",
                "--python-venv",
                "never",
                "--shell",
                missing_shell,
                "-c",
                "echo never",
            ],
            cwd=project,
            environment=environment,
            check=False,
        )
        assert_failure(missing, ("starting development shell", "missing-shell.exe"), "missing shell")
        completed.append("missing-shell-diagnostic")

        invalid = run(
            [zed, "dev", "--nix", "sometimes"],
            cwd=project,
            environment=environment,
            check=False,
        )
        assert_failure(invalid, ("--nix", "sometimes"), "invalid enum")
        completed.append("invalid-enum-diagnostic")

        conflict = run(
            [zed, "dev", "--print-env", "-c", "echo never"],
            cwd=project,
            environment=environment,
            check=False,
        )
        assert_failure(conflict, ("--print-env", "--command"), "conflicting mode")
        completed.append("conflicting-mode-diagnostic")

        redirected = run(
            [
                zed,
                "dev",
                "--no-install",
                "--nix",
                "never",
                "--mise",
                "never",
                "--python-venv",
                "never",
                "--shell",
                powershell,
            ],
            cwd=project,
            environment=environment,
            check=False,
        )
        assert_failure(redirected, ("needs a real terminal",), "redirected interactive")
        completed.append("redirected-interactive-rejected")

        report: dict[str, Any] = {
            "schema": "zed-develop-windows-clean-room/v1",
            "candidate_sha": args.candidate_sha,
            "interfaces_sha": args.interfaces_sha,
            "flags2env_sha": args.flags2env_sha,
            "platform": sys.platform,
            "python": sys.version.split()[0],
            "powershell": str(powershell),
            "cmd": str(cmd),
            "managed_environment_sha256": hashlib.sha256(canonical_bytes).hexdigest(),
            "managed_keys": sorted(canonical),
            "assertions": completed,
            "assertion_count": len(completed),
            "credential_canaries_retained": False,
            "external_registry_required": False,
            "temporary_home_retained": False,
        }
        report_path = artifact_dir / "zed-develop-windows-clean-room.json"
        report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print(f"Windows zed develop clean-room contract passed: {len(completed)} assertions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
