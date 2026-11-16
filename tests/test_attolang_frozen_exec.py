"""Host-only adapter regression: does NOT execute AttoLang compiler guests."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest import mock
from types import SimpleNamespace
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "suites/cli/attolang_frozen_exec.py"


class FrozenAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for filename in (".zpkg.toml", ".zpkg.lock", ".ores.pkg.toml"):
            (self.root / filename).write_text("# test fixture\n", encoding="utf-8")
        self.package = "zed_modules/acme/example"
        (self.root / self.package).mkdir(parents=True)
        self.log = self.root / "commands.jsonl"
        self.projection = self.root / "paths.json"
        self.projection.write_text(json.dumps({
            "env": "ATTO_PATHS", "legacy_env": "ORES_PATHS",
            "paths": [self.package], "value": self.package,
        }), encoding="utf-8")
        self.zed = self.root / "fake_zed.py"
        self.zed.write_text(f"#!{sys.executable}\n" + '''
import json, os, pathlib, sys
root = pathlib.Path.cwd()
with (root / 'commands.jsonl').open('a') as f:
    f.write(json.dumps(sys.argv[1:]) + '\\n')
if os.getenv('FAIL_ZED') == sys.argv[1]:
    sys.exit(9)
if sys.argv[1:] == ['attolang', 'paths', '--json']:
    sys.stdout.buffer.write((root / 'paths.json').read_bytes())
''', encoding="utf-8")
        self.zed.chmod(0o755)
        self.compiler = self.root / "fake_compiler.py"
        self.compiler.write_text(f"#!{sys.executable}\n" + '''
import json, os, pathlib, sys
pathlib.Path('compiler-observed.json').write_text(json.dumps({
    'argv': sys.argv[1:], 'ATTO_PATHS': os.getenv('ATTO_PATHS'),
    'ORES_PATHS': os.getenv('ORES_PATHS'),
    'ORESLANG_PATH': os.getenv('ORESLANG_PATH'),
}))
sys.exit(int(os.getenv('COMPILER_EXIT', '0')))
''', encoding="utf-8")
        self.compiler.chmod(0o755)

    def run_adapter(self, extra_env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env.update(ATTO_PATHS="/ambient/untrusted", ORES_PATHS="/ambient/legacy")
        if extra_env:
            env.update(extra_env)
        return subprocess.run([sys.executable, str(SCRIPT), "--project", str(self.root),
                               "--zed", str(self.zed), "--", str(self.compiler),
                               "arg with spaces", "$(touch SHOULD_NOT_EXIST)"],
                              capture_output=True, text=True, env=env, check=False)

    def calls(self) -> list[list[str]]:
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_frozen_order_environment_and_argument_literalness(self) -> None:
        result = self.run_adapter()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls(), [
            ["validate", "--require-lock"], ["install", "--frozen"],
            ["attolang", "paths", "--json"],
        ])
        observed = json.loads((self.root / "compiler-observed.json").read_text())
        self.assertEqual(observed["argv"], ["arg with spaces", "$(touch SHOULD_NOT_EXIST)"])
        for key in ("ATTO_PATHS", "ORES_PATHS", "ORESLANG_PATH"):
            self.assertEqual(observed[key], self.package)
        self.assertFalse((self.root / "SHOULD_NOT_EXIST").exists())

    def test_compiler_failure_is_not_hidden(self) -> None:
        result = self.run_adapter({"COMPILER_EXIT": "7"})
        self.assertEqual(result.returncode, 7)

    def test_validate_failure_blocks_install_and_compiler(self) -> None:
        result = self.run_adapter({"FAIL_ZED": "validate"})
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.calls(), [["validate", "--require-lock"]])
        self.assertFalse((self.root / "compiler-observed.json").exists())

    def test_frozen_failure_blocks_path_export_and_compiler(self) -> None:
        result = self.run_adapter({"FAIL_ZED": "install"})
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.calls(), [["validate", "--require-lock"], ["install", "--frozen"]])
        self.assertFalse((self.root / "compiler-observed.json").exists())

    def test_missing_lock_fails_without_any_zed_invocation(self) -> None:
        (self.root / ".zpkg.lock").unlink()
        result = self.run_adapter()
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.calls(), [])

    def test_rejects_poisoned_paths_and_metadata(self) -> None:
        # Exercise production parsing for each mutation without subprocesses
        # per row. The separate positive/negative tests use real processes.
        import importlib.util
        spec = importlib.util.spec_from_file_location("atto_adapter", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        cases = [
            {"env": "ORES_PATHS"},
            {"legacy_env": "OTHER_PATHS"},
            {"paths": [], "value": ""},
            {"paths": [self.package, self.package], "value": os.pathsep.join([self.package] * 2)},
            {"paths": ["../outside"], "value": "../outside"},
            {"paths": ["/tmp/outside"], "value": "/tmp/outside"},
            {"paths": ["zed_modules/acme/missing"], "value": "zed_modules/acme/missing"},
            {"paths": ["x\\y"], "value": "x\\y"},
            {"paths": ["x\nspoof"], "value": "x\nspoof"},
            {"value": "not-actually-the-joined-paths"},
        ]
        if os.name == "nt":
            cases = [v for v in cases if v.get("value") != "x\\y"]
        baseline = json.loads(self.projection.read_text())
        for mutation in cases:
            with self.subTest(mutation=mutation):
                payload = json.dumps({**baseline, **mutation}).encode("utf-8")
                def fake_run(_args, **kwargs):
                    kwargs["stdout"].write(payload)
                    return SimpleNamespace(returncode=0)
                with mock.patch.object(module.subprocess, "run", side_effect=fake_run):
                    with self.assertRaises(module.AdmissionError):
                        module._project_paths("zed", self.root)

    def test_rejects_oversized_json_without_running_compiler(self) -> None:
        self.projection.write_bytes(b" " * (1024 * 1024 + 1))
        result = self.run_adapter()
        self.assertEqual(result.returncode, 2)
        self.assertFalse((self.root / "compiler-observed.json").exists())


if __name__ == "__main__":
    unittest.main()
