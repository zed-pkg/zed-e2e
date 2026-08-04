from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "zed-develop-windows-clean-room.yml"
SUITE = ROOT / "tests" / "cli" / "zed_develop_windows_clean_room.py"
RUNNER = ROOT / "tests" / "cli" / "run_zed_develop_windows_clean_room.py"
POLICY = ROOT / "tests" / "cli" / "test_zed_develop_windows_policy.py"
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
USES = re.compile(r"(?m)^\s*uses:\s*([^\s@]+)@([^\s#]+)")
ENV_PIN = re.compile(
    r"(?m)^\s{2}(ZED_CLI_SHA|ZED_INTERFACES_SHA|FLAGS2ENV_SHA):\s*([0-9a-f]+)\s*$"
)


class WindowsCleanRoomWorkflowPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")
        cls.suite = SUITE.read_text(encoding="utf-8")
        cls.runner = RUNNER.read_text(encoding="utf-8")

    def test_review_main_schedule_and_manual_triggers_are_fail_closed(self) -> None:
        for required in (
            "pull_request:",
            "push:",
            "branches: [main]",
            "schedule:",
            "workflow_dispatch:",
        ):
            self.assertIn(required, self.workflow)
        self.assertNotIn("pull_request_target:", self.workflow)

    def test_workflow_uses_an_explicit_windows_runner_and_timeout(self) -> None:
        self.assertRegex(self.workflow, r"(?m)^\s{4}runs-on:\s*windows-2022\s*$")
        self.assertRegex(self.workflow, r"(?m)^\s{4}timeout-minutes:\s*40\s*$")
        self.assertNotIn("windows-latest", self.workflow)

    def test_workflow_is_read_only_and_has_no_secret_channel(self) -> None:
        self.assertRegex(
            self.workflow,
            r"(?m)^permissions:\s*$\n\s{2}contents:\s*read\s*$",
        )
        self.assertIsNone(
            re.search(r"(?m)^\s+[A-Za-z0-9_-]+:\s*write\s*$", self.workflow)
        )
        for forbidden in (
            "${{ secrets.",
            "secrets: inherit",
            "persist-credentials: true",
            "id-token: write",
        ):
            self.assertNotIn(forbidden, self.workflow)

    def test_all_remote_actions_are_immutable(self) -> None:
        calls = USES.findall(self.workflow)
        self.assertGreaterEqual(len(calls), 4)
        for action, revision in calls:
            with self.subTest(action=action):
                self.assertRegex(revision, FULL_SHA)

    def test_cli_interface_and_flags_contracts_are_pinned(self) -> None:
        pins = dict(ENV_PIN.findall(self.workflow))
        self.assertEqual(
            set(pins),
            {"ZED_CLI_SHA", "ZED_INTERFACES_SHA", "FLAGS2ENV_SHA"},
        )
        for name, revision in pins.items():
            with self.subTest(name=name):
                self.assertRegex(revision, FULL_SHA)
        self.assertIn("ref: ${{ env.ZED_CLI_SHA }}", self.workflow)
        self.assertIn("ref: ${{ env.ZED_INTERFACES_SHA }}", self.workflow)
        self.assertIn(
            "$expectedInterface = 'rev = \"' + $env:ZED_INTERFACES_SHA + '\"'",
            self.workflow,
        )
        self.assertIn(
            "$expectedFlags = 'rev = \"' + $env:FLAGS2ENV_SHA + '\"'",
            self.workflow,
        )
        self.assertIn("$cargo.Contains($expectedInterface)", self.workflow)
        self.assertIn("$cargo.Contains($expectedFlags)", self.workflow)

    def test_workflow_builds_the_real_locked_windows_candidate(self) -> None:
        self.assertIn("cargo build", self.workflow)
        self.assertIn("--locked", self.workflow)
        self.assertIn("--bin zed", self.workflow)
        self.assertIn("target\\debug\\zed.exe", self.workflow)
        self.assertIn("zed_develop_windows_clean_room.py", self.workflow)
        self.assertIn("run_zed_develop_windows_clean_room.py", self.workflow)
        self.assertIn("test_zed_develop_windows_policy.py", self.workflow)

    def test_source_cleanliness_is_proved_without_cleanup_masking(self) -> None:
        self.assertIn("Prove all source checkouts remained clean", self.workflow)
        self.assertIn("status --porcelain=v1 --untracked-files=all", self.workflow)
        for forbidden in (
            "git clean",
            "git reset",
            "Remove-Item -Recurse",
            "__pycache__",
        ):
            self.assertNotIn(forbidden, self.workflow)
        self.assertRegex(
            self.workflow,
            r"(?m)^\s{2}PYTHONDONTWRITEBYTECODE:\s*'1'\s*$",
        )

    def test_evidence_is_short_lived_and_runner_temporary(self) -> None:
        self.assertIn("Upload non-secret Windows acceptance evidence", self.workflow)
        self.assertRegex(
            self.workflow,
            r"(?s)Upload non-secret Windows acceptance evidence.*?if:\s*always\(\)",
        )
        retention = re.search(r"(?m)^\s+retention-days:\s*(\d+)\s*$", self.workflow)
        self.assertIsNotNone(retention)
        self.assertLessEqual(int(retention.group(1)), 7)
        self.assertIn("${{ runner.temp }}\\zed-develop-windows", self.workflow)
        self.assertIn("if-no-files-found: error", self.workflow)

    def test_suite_covers_shells_profiles_venv_and_failure_boundaries(self) -> None:
        for expected in (
            "powershell-profile-fixture-active",
            "powershell-no-profile-command",
            "powershell-child-exit-propagation",
            "cmd-managed-environment",
            "cmd-child-exit-propagation",
            "default-comspec-command",
            "windows-project-python-venv",
            "isolated-home-and-userprofile-no-credential-copy",
            "invalid-enum-diagnostic",
            "conflicting-mode-diagnostic",
            "redirected-interactive-rejected",
        ):
            self.assertIn(expected, self.suite)
        self.assertIn("-NoProfile", self.suite)
        self.assertIn("Scripts", self.suite)

    def test_cmd_adapter_uses_relative_call_and_preserves_errorlevel(self) -> None:
        self.assertIn("zed-develop-cmd-contract.cmd", self.runner)
        self.assertIn("zed-develop-cmd-launcher.cmd", self.runner)
        self.assertIn("call zed-develop-cmd-contract.cmd\\r\\n", self.runner)
        self.assertIn('set "zed_contract_exit=%errorlevel%"', self.runner)
        self.assertIn("exit /b %zed_contract_exit%", self.runner)
        self.assertIn(
            'parts[command_index] = "call zed-develop-cmd-launcher.cmd"',
            self.runner,
        )
        self.assertNotIn("call \"{assertion_batch}\"", self.runner)
        self.assertNotIn("call \"{launcher_batch}\"", self.runner)
        self.assertNotIn("parts[command_index] = f'\"{launcher_batch}\"'", self.runner)

    def test_every_declared_canary_is_checked_and_not_retained(self) -> None:
        for canary in (
            "INHERITED_SECRET",
            "ZED_PKG_TOKEN",
            "DOTENV_CANARY",
            "DIRENV_CANARY",
            "PROD_ENV_CANARY",
            "PROFILE_CANARY",
            "CODEX_CANARY",
            "AWS_CANARY",
            "GCLOUD_CANARY",
            "GH_CANARY",
            "NPM_CANARY",
        ):
            self.assertIn(f'"{canary}"', self.suite)
        self.assertIn("assert_no_canaries", self.suite)
        self.assertIn('"credential_canaries_retained": False', self.suite)
        self.assertIn('"temporary_home_retained": False', self.suite)
        self.assertIn('"external_registry_required": False', self.suite)


if __name__ == "__main__":
    unittest.main()
