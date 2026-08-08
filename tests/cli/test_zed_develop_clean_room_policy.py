from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "zed-develop-clean-room.yml"
SUITE = ROOT / "tests" / "cli" / "zed_develop_clean_room.py"
POLICY_TEST = ROOT / "tests" / "cli" / "test_zed_develop_clean_room_policy.py"
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
USES = re.compile(r"(?m)^\s*uses:\s*([^\s@]+)@([^\s#]+)")
ENV_PIN = re.compile(
    r"(?m)^\s{2}(ZED_CLI_SHA|ZED_INTERFACES_SHA|FLAGS2ENV_SHA):\s*([0-9a-f]+)\s*$"
)


class CleanRoomWorkflowPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")
        cls.suite = SUITE.read_text(encoding="utf-8")

    def test_workflow_covers_review_main_schedule_and_manual_replay(self) -> None:
        for required in (
            "pull_request:",
            "push:",
            "branches: [main]",
            "schedule:",
            "workflow_dispatch:",
        ):
            self.assertIn(required, self.workflow)
        self.assertNotIn("pull_request_target:", self.workflow)

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

    def test_every_remote_action_is_pinned_to_a_full_commit(self) -> None:
        calls = USES.findall(self.workflow)
        self.assertGreaterEqual(len(calls), 4)
        for action, revision in calls:
            with self.subTest(action=action):
                self.assertRegex(revision, FULL_SHA)

    def test_candidate_contract_and_parser_revisions_are_exact(self) -> None:
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
            "ref: ${{ github.event.pull_request.head.sha || github.sha }}",
            self.workflow,
        )
        self.assertIn('grep -F "rev = \\"$ZED_INTERFACES_SHA\\""', self.workflow)
        self.assertIn('grep -F "rev = \\"$FLAGS2ENV_SHA\\""', self.workflow)

    def test_linux_and_macos_matrix_is_explicit_and_bounded(self) -> None:
        self.assertIn("ubuntu-24.04", self.workflow)
        self.assertIn("macos-15", self.workflow)
        self.assertRegex(self.workflow, r"(?m)^\s{4}timeout-minutes:\s*40\s*$")
        self.assertIn("fail-fast: false", self.workflow)
        self.assertIn("if [[ \"$RUNNER_OS\" == 'Linux' ]]", self.workflow)
        self.assertIn("arguments+=(--expect-fish)", self.workflow)

    def test_workflow_runs_the_policy_test_and_the_external_suite(self) -> None:
        self.assertIn(str(POLICY_TEST.relative_to(ROOT)), self.workflow)
        self.assertIn(
            "python3 -m unittest -v zed-e2e/tests/cli/test_zed_develop_clean_room_policy.py",
            self.workflow,
        )
        self.assertIn(
            "python3 zed-e2e/tests/cli/zed_develop_clean_room.py",
            self.workflow,
        )
        self.assertIn("cargo build", self.workflow)
        self.assertIn("--locked", self.workflow)

    def test_policy_validation_is_bytecode_free_and_does_not_hide_mutation(self) -> None:
        self.assertRegex(
            self.workflow,
            r"(?m)^\s{2}PYTHONDONTWRITEBYTECODE:\s*'1'\s*$",
        )
        self.assertIn("compile(source, str(path), \"exec\")", self.workflow)
        self.assertNotIn("python3 -m py_compile", self.workflow)
        for cleanup in ("rm -rf", "find . -name '__pycache__'", "git clean"):
            self.assertNotIn(cleanup, self.workflow)

    def test_evidence_is_short_lived_non_secret_and_uploaded_on_failure(self) -> None:
        self.assertIn("Upload non-secret acceptance evidence", self.workflow)
        self.assertRegex(
            self.workflow,
            r"(?s)Upload non-secret acceptance evidence.*?if:\s*always\(\)",
        )
        self.assertIn("if-no-files-found: error", self.workflow)
        retention = re.search(r"(?m)^\s+retention-days:\s*(\d+)\s*$", self.workflow)
        self.assertIsNotNone(retention)
        self.assertLessEqual(int(retention.group(1)), 7)
        self.assertIn("${{ runner.temp }}/zed-develop/${{ runner.os }}/", self.workflow)
        self.assertNotIn("${{ github.workspace }}/", self.workflow.split("Upload non-secret", 1)[1])

    def test_suite_contains_all_credential_and_environment_canaries(self) -> None:
        for canary in (
            "INHERITED_SECRET",
            "ZED_PKG_TOKEN",
            "DOTENV_CANARY",
            "DIRENV_CANARY",
            "PROD_ENV_CANARY",
            "CODEX_CANARY",
            "AWS_CANARY",
            "GCLOUD_CANARY",
            "GH_CANARY",
            "NPM_CANARY",
        ):
            self.assertIn(f'"{canary}"', self.suite)
        self.assertIn("assert_no_canaries", self.suite)
        self.assertIn('"credential_canaries_retained": False', self.suite)
        self.assertIn('"external_registry_required": False', self.suite)

    def test_checkout_cleanliness_is_part_of_the_acceptance_boundary(self) -> None:
        self.assertIn("Prove source checkouts remained clean", self.workflow)
        self.assertIn("zed-e2e zed-cli zed-interfaces", self.workflow)
        self.assertIn("status --porcelain=v1 --untracked-files=all", self.workflow)


if __name__ == "__main__":
    unittest.main()
