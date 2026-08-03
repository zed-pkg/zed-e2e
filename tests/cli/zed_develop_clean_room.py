#!/usr/bin/env python3
"""Independent clean-room acceptance for `zed develop` / `zed dev`.

The suite intentionally imports no zed-cli test helpers. It executes one exact
built candidate as an external consumer and records only non-secret evidence.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pty
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Mapping, Sequence

CLEAN_ENV_PREFIXES = ("ZED_DEV_",)
CLEAN_ENV_KEYS = {
    "CLASSPATH",
    "IN_NIX_SHELL",
    "PYTHONPATH",
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
CANARIES = {
    "INHERITED_SECRET": "clean-room-inherited-secret-canary",
    "ZED_PKG_TOKEN": "clean-room-registry-token-canary",
    "DOTENV_CANARY": "clean-room-dotenv-canary",
    "DIRENV_CANARY": "clean-room-direnv-canary",
    "PROD_ENV_CANARY": "clean-room-production-env-canary",
    "CODEX_CANARY": "clean-room-codex-credential-canary",
    "AWS_CANARY": "clean-room-aws-credential-canary",
    "GCLOUD_CANARY": "clean-room-gcloud-credential-canary",
    "GH_CANARY": "clean-room-gh-credential-canary",
    "NPM_CANARY": "clean-room-npm-credential-canary",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zed", required=True, type=Path)
    parser.add_argument("--artifact-dir", required=True, type=Path)
    parser.add_argument("--candidate-sha", required=True)
    parser.add_argument("--interfaces-sha", required=True)
    parser.add_argument("--expect-fish", action="store_true")
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
            "TERM": "xterm-256color",
        }
    )
    return environment


def run(
    command: Sequence[str | os.PathLike[str]],
    *,
    cwd: Path,
    environment: Mapping[str, str],
    check: bool = True,
    timeout: int = 90,
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


def write(path: Path, content: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    path.chmod(mode)


def managed_environment(
    zed: Path,
    spelling: str,
    *,
    cwd: Path,
    environment: Mapping[str, str],
    extra: Sequence[str] = (),
    global_options: Sequence[str] = (),
) -> tuple[dict[str, str], str, str]:
    result = run(
        [
            zed,
            *global_options,
            spelling,
            "--no-install",
            "--nix",
            "never",
            "--python-venv",
            "never",
            *extra,
            "--print-env",
        ],
        cwd=cwd,
        environment=environment,
    )
    parsed = json.loads(result.stdout)
    if not isinstance(parsed, dict) or not all(
        isinstance(key, str) and isinstance(value, str)
        for key, value in parsed.items()
    ):
        raise AssertionError(f"managed environment is not a string map: {parsed!r}")
    return parsed, result.stdout, result.stderr


def assert_no_canaries(text: str, context: str) -> None:
    leaked = [name for name, value in CANARIES.items() if value in text]
    if leaked:
        raise AssertionError(f"{context} leaked canaries: {leaked}")


def assert_project_root(environment: Mapping[str, str], project: Path) -> None:
    actual = Path(environment["ZED_DEV_PROJECT_ROOT"]).resolve()
    expected = project.resolve()
    if actual != expected:
        raise AssertionError(f"project root mismatch: actual={actual}, expected={expected}")


def shell_assertion(python: Path, marker: str) -> str:
    program = (
        "import os; "
        "assert os.environ['ZED_DEV'] == '1'; "
        "assert os.path.realpath(os.getcwd()) == "
        "os.path.realpath(os.environ['ZED_DEV_PROJECT_ROOT']); "
        f"print({marker!r})"
    )
    return f"{shlex.quote(str(python))} -c {shlex.quote(program)}"


def execute_shell_case(
    zed: Path,
    *,
    project: Path,
    environment: Mapping[str, str],
    shell: Path,
    python: Path,
    marker: str,
) -> None:
    result = run(
        [
            zed,
            "dev",
            "--no-install",
            "--nix",
            "never",
            "--python-venv",
            "never",
            "--shell",
            shell,
            "-c",
            shell_assertion(python, marker),
        ],
        cwd=project / "src" / "nested",
        environment=environment,
    )
    if marker not in result.stdout:
        raise AssertionError(f"{shell.name} did not emit {marker!r}: {result.stdout!r}")
    assert_no_canaries(result.stdout + result.stderr, f"{shell.name} command")


def execute_pty_case(
    zed: Path,
    *,
    project: Path,
    environment: Mapping[str, str],
    temporary_root: Path,
) -> None:
    shell = temporary_root / "pty-shell"
    write(
        shell,
        "#!/bin/sh\n"
        "set -eu\n"
        "test -t 0\n"
        "test -t 1\n"
        "test \"$ZED_DEV\" = 1\n"
        "test \"$(pwd -P)\" = \"$(cd \"$ZED_DEV_PROJECT_ROOT\" && pwd -P)\"\n",
        0o700,
    )

    pid, descriptor = pty.fork()
    if pid == 0:
        os.chdir(project)
        os.execve(
            str(zed),
            [
                str(zed),
                "dev",
                "--no-install",
                "--nix",
                "never",
                "--python-venv",
                "never",
                "--shell",
                str(shell),
            ],
            dict(environment),
        )

    _, status = os.waitpid(pid, 0)
    os.close(descriptor)
    if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
        raise AssertionError(f"interactive PTY shell failed with wait status {status}")


def top_level_entries(project: Path) -> set[str]:
    return {entry.name for entry in project.iterdir()}


def main() -> int:
    args = parse_args()
    zed = args.zed.resolve(strict=True)
    if not os.access(zed, os.X_OK):
        raise SystemExit(f"zed candidate is not executable: {zed}")

    artifact_dir = args.artifact_dir.resolve()
    artifact_dir.mkdir(parents=True, exist_ok=True)
    python = Path(sys.executable).resolve(strict=True)
    shells: dict[str, Path] = {}
    for name in ("bash", "zsh", "fish"):
        located = shutil.which(name)
        if located:
            shells[name] = Path(located).resolve(strict=True)
    for required in ("bash", "zsh"):
        if required not in shells:
            raise SystemExit(f"required shell is unavailable: {required}")
    if args.expect_fish and "fish" not in shells:
        raise SystemExit("Fish was required by the workflow but is unavailable")

    completed: list[str] = []
    with tempfile.TemporaryDirectory(prefix="zed-develop-clean-room-") as raw_temp:
        temporary_root = Path(raw_temp).resolve()
        source_home = temporary_root / "source-home"
        zed_home = temporary_root / "zed-home"
        explicit_zed_home = temporary_root / "explicit-zed-home"
        project = temporary_root / "project"
        nested = project / "src" / "nested"
        nested.mkdir(parents=True)
        zed_home.mkdir()

        write(project / "package.json", "{}\n")
        write(project / ".env", f"DOTENV_CANARY={CANARIES['DOTENV_CANARY']}\n")
        write(
            project / ".envrc",
            f"export DIRENV_CANARY={CANARIES['DIRENV_CANARY']}\n",
        )
        write(
            project / "env" / ".prod.env",
            f"PROD_ENV_CANARY={CANARIES['PROD_ENV_CANARY']}\n",
        )
        write(
            source_home / ".codex" / "auth.json",
            json.dumps({"token": CANARIES["CODEX_CANARY"]}) + "\n",
        )
        write(
            source_home / ".aws" / "credentials",
            f"[default]\naws_secret_access_key={CANARIES['AWS_CANARY']}\n",
        )
        write(
            source_home / ".config" / "gcloud" / "application_default_credentials.json",
            json.dumps({"private_key": CANARIES["GCLOUD_CANARY"]}) + "\n",
        )
        write(
            source_home / ".config" / "gh" / "hosts.yml",
            f"github.com:\n  oauth_token: {CANARIES['GH_CANARY']}\n",
        )
        write(source_home / ".npmrc", f"//registry.invalid/:_authToken={CANARIES['NPM_CANARY']}\n")

        environment = clean_environment()
        environment.update(
            {
                "HOME": str(source_home),
                "ZED_PKG_HOME": str(zed_home),
                "INHERITED_SECRET": CANARIES["INHERITED_SECRET"],
                "ZED_PKG_TOKEN": CANARIES["ZED_PKG_TOKEN"],
            }
        )

        initial_entries = top_level_entries(project)
        canonical, canonical_source, canonical_stderr = managed_environment(
            zed,
            "develop",
            cwd=nested,
            environment=environment,
        )
        alias, alias_source, alias_stderr = managed_environment(
            zed,
            "dev",
            cwd=nested,
            environment=environment,
        )
        if alias_source != canonical_source or alias_stderr != canonical_stderr:
            raise AssertionError("`zed dev` and `zed develop` produced different output")
        if alias != canonical:
            raise AssertionError("alias and canonical managed environment maps differ")
        if canonical.get("ZED_DEV") != "1":
            raise AssertionError(f"ZED_DEV is not active: {canonical!r}")
        assert_project_root(canonical, project)
        assert_no_canaries(canonical_source + canonical_stderr, "--print-env")
        if str(source_home) in canonical_source or str(zed) in canonical_source:
            raise AssertionError("managed JSON leaked source-home or candidate-checkout paths")
        completed.append("canonical-alias-byte-equivalence")
        completed.append("nested-project-root-selection")
        completed.append("managed-overlay-secret-redaction")

        global_environment, global_source, global_stderr = managed_environment(
            zed,
            "dev",
            cwd=nested,
            environment=environment,
            global_options=(
                "--registry=http://127.0.0.1:9",
                f"--home={explicit_zed_home}",
            ),
        )
        assert_project_root(global_environment, project)
        assert_no_canaries(global_source + global_stderr, "global-option routing")
        completed.append("global-options-before-alias")

        isolated, isolated_source, isolated_stderr = managed_environment(
            zed,
            "dev",
            cwd=nested,
            environment=environment,
            extra=("--isolated-home",),
        )
        expected_isolated_home = (project / ".zed" / "dev" / "home").resolve()
        actual_isolated_home = Path(isolated["HOME"]).resolve()
        if actual_isolated_home != expected_isolated_home:
            raise AssertionError(
                f"isolated HOME mismatch: actual={actual_isolated_home}, "
                f"expected={expected_isolated_home}"
            )
        if not expected_isolated_home.is_dir():
            raise AssertionError("isolated HOME was not created")
        for relative in (
            ".codex/auth.json",
            ".aws/credentials",
            ".config/gcloud/application_default_credentials.json",
            ".config/gh/hosts.yml",
            ".npmrc",
        ):
            if (expected_isolated_home / relative).exists():
                raise AssertionError(f"credential was copied into isolated HOME: {relative}")
        assert_no_canaries(isolated_source + isolated_stderr, "isolated HOME")
        completed.append("isolated-home-does-not-copy-credentials")

        allowed_entries = initial_entries | {".zed"}
        unexpected_entries = top_level_entries(project) - allowed_entries
        if unexpected_entries:
            raise AssertionError(f"--no-install created unexpected project entries: {unexpected_entries}")
        if (project / ".zpkg.toml").exists() or (project / ".zpkg.lock").exists():
            raise AssertionError("--no-install mutated Zed manifest or lock state")
        completed.append("bounded-no-install-write-set")

        for name in ("bash", "zsh"):
            execute_shell_case(
                zed,
                project=project,
                environment=environment,
                shell=shells[name],
                python=python,
                marker=f"{name}-clean-room-ok",
            )
            completed.append(f"real-{name}-command")
        if "fish" in shells:
            execute_shell_case(
                zed,
                project=project,
                environment=environment,
                shell=shells["fish"],
                python=python,
                marker="fish-clean-room-ok",
            )
            completed.append("real-fish-command")

        dotenv_program = (
            "import os; "
            "assert 'DOTENV_CANARY' not in os.environ; "
            "assert 'DIRENV_CANARY' not in os.environ; "
            "assert 'PROD_ENV_CANARY' not in os.environ; "
            "print('dotenv-boundary-ok')"
        )
        dotenv_result = run(
            [
                zed,
                "dev",
                "--no-install",
                "--nix",
                "never",
                "--python-venv",
                "never",
                "--shell",
                shells["bash"],
                "-c",
                f"{shlex.quote(str(python))} -c {shlex.quote(dotenv_program)}",
            ],
            cwd=nested,
            environment=environment,
        )
        if "dotenv-boundary-ok" not in dotenv_result.stdout:
            raise AssertionError("dotenv boundary command did not complete")
        completed.append("no-implicit-dotenv-or-direnv")

        environment_only = dict(environment)
        environment_only.update(
            {
                "ZED_DEV_COMMAND": shell_assertion(python, "flags2env-env-ok"),
                "ZED_DEV_SHELL": str(shells["bash"]),
                "ZED_DEV_NIX": "never",
                "ZED_DEV_NO_INSTALL": "yes",
                "ZED_DEV_PYTHON_VENV": "never",
            }
        )
        env_result = run([zed, "dev"], cwd=nested, environment=environment_only)
        if "flags2env-env-ok" not in env_result.stdout:
            raise AssertionError("environment-only flags2env invocation failed")
        completed.append("flags2env-environment-only")

        precedence_environment = dict(environment)
        precedence_environment["ZED_DEV_NIX"] = "required"
        precedence = run(
            [
                zed,
                "dev",
                "--no-install",
                "--nix",
                "never",
                "--python-venv",
                "never",
                "--shell",
                shells["bash"],
                "-c",
                shell_assertion(python, "cli-precedence-ok"),
            ],
            cwd=nested,
            environment=precedence_environment,
        )
        if "cli-precedence-ok" not in precedence.stdout:
            raise AssertionError("explicit CLI option did not override inherited mode")
        completed.append("cli-over-environment-precedence")

        python_project = temporary_root / "python-project"
        (python_project / "nested").mkdir(parents=True)
        write(
            python_project / "pyproject.toml",
            "[project]\nname = 'clean-room-python'\nversion = '0.0.0'\n",
        )
        venv = python_project / ".custom" / "venv"
        venv_program = (
            "import os, pathlib, sys; "
            "expected=pathlib.Path(os.environ['VIRTUAL_ENV']).resolve(); "
            "assert expected == pathlib.Path(sys.prefix).resolve(); "
            "assert expected == pathlib.Path(os.environ['ZED_DEV_PROJECT_ROOT'], '.custom/venv').resolve(); "
            "print('python-venv-ok')"
        )
        venv_result = run(
            [
                zed,
                "dev",
                "--no-install",
                "--nix",
                "never",
                "--python-venv",
                "required",
                "--python",
                python,
                "--venv",
                ".custom/venv",
                "--shell",
                shells["bash"],
                "-c",
                f"python -c {shlex.quote(venv_program)}",
            ],
            cwd=python_project / "nested",
            environment=environment,
            timeout=120,
        )
        if "python-venv-ok" not in venv_result.stdout or not venv.is_dir():
            raise AssertionError("custom Python virtual environment was not activated")
        completed.append("custom-project-python-venv")

        nix_project = temporary_root / "nix-project"
        (nix_project / ".nix").mkdir(parents=True)
        write(nix_project / ".nix" / "flake.nix", "{}\n")
        write(nix_project / "package.json", "{}\n")
        nix_environment = dict(environment)
        nix_environment["IN_NIX_SHELL"] = "impure"
        nix_result = run(
            [
                zed,
                "dev",
                "--no-install",
                "--nix",
                "required",
                "--python-venv",
                "never",
                "--shell",
                shells["bash"],
                "-c",
                shell_assertion(python, "nix-recursion-guard-ok"),
            ],
            cwd=nix_project,
            environment=nix_environment,
        )
        if "nix-recursion-guard-ok" not in nix_result.stdout:
            raise AssertionError("already-inside-Nix execution did not complete")
        completed.append("already-inside-nix-recursion-guard")

        exited = run(
            [
                zed,
                "dev",
                "--no-install",
                "--nix",
                "never",
                "--python-venv",
                "never",
                "--shell",
                shells["bash"],
                "-c",
                "exit 37",
            ],
            cwd=project,
            environment=environment,
            check=False,
        )
        if exited.returncode != 37:
            raise AssertionError(f"child exit code was not propagated: {exited.returncode}")
        completed.append("child-exit-code-propagation")

        missing_shell = temporary_root / "missing-shell"
        missing = run(
            [
                zed,
                "dev",
                "--no-install",
                "--nix",
                "never",
                "--python-venv",
                "never",
                "--shell",
                missing_shell,
                "-c",
                "true",
            ],
            cwd=project,
            environment=environment,
            check=False,
        )
        if missing.returncode == 0 or "starting development shell" not in missing.stderr:
            raise AssertionError(f"missing shell diagnostic drifted: {missing.stderr!r}")
        assert_no_canaries(missing.stdout + missing.stderr, "missing-shell diagnostic")
        completed.append("missing-shell-diagnostic")

        no_tty = run(
            [
                zed,
                "dev",
                "--no-install",
                "--nix",
                "never",
                "--python-venv",
                "never",
                "--shell",
                shells["bash"],
            ],
            cwd=project,
            environment=environment,
            check=False,
        )
        if no_tty.returncode == 0 or "needs a real terminal" not in no_tty.stderr:
            raise AssertionError(f"redirected interactive diagnostic drifted: {no_tty.stderr!r}")
        completed.append("redirected-interactive-rejected")

        execute_pty_case(
            zed,
            project=project,
            environment=environment,
            temporary_root=temporary_root,
        )
        completed.append("real-pty-entry")

        report: dict[str, Any] = {
            "schema": "zed-develop-clean-room/v1",
            "candidate_sha": args.candidate_sha,
            "interfaces_sha": args.interfaces_sha,
            "platform": sys.platform,
            "python": sys.version.split()[0],
            "shells": {name: str(path) for name, path in sorted(shells.items())},
            "managed_environment_sha256": hashlib.sha256(
                canonical_source.encode("utf-8")
            ).hexdigest(),
            "managed_keys": sorted(canonical),
            "assertions": completed,
            "assertion_count": len(completed),
            "credential_canaries_retained": False,
            "external_registry_required": False,
        }
        report_path = artifact_dir / "zed-develop-clean-room.json"
        report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        report_path.chmod(stat.S_IRUSR | stat.S_IWUSR)

    print(f"zed develop clean-room contract passed: {len(completed)} assertions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
