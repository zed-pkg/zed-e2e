/**
 * Unit tests for the stack harness's process-reaping safety checks. These run
 * without booting the stack (`npm run test:harness`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { isStillOurProcess } from "./stack.ts";

test("a live process is recognized by its own binary path", () => {
  // This test process is node; execPath is exactly what `ps -o args=` shows.
  assert.equal(isStillOurProcess(process.pid, process.execPath), true);
});

test("a recycled pid is NOT killed: same pid, different binary", () => {
  // The dangerous case — the pid is alive, but it is somebody else's process
  // now. Verifying against the recorded binary is what prevents the kill.
  assert.equal(
    isStillOurProcess(process.pid, "/nonexistent/zed-api-server"),
    false,
    "a live pid running a different binary must not be treated as ours",
  );
});

test("an unverifiable pidfile (no recorded binary) is never killed", () => {
  assert.equal(isStillOurProcess(process.pid, ""), false);
});

test("a dead pid is not ours", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid!;
  await once(child, "exit");
  assert.equal(isStillOurProcess(pid, process.execPath), false);
});

test("nonsense pids are rejected rather than signalled", () => {
  for (const pid of [0, -1, 2 ** 31]) {
    assert.equal(isStillOurProcess(pid, process.execPath), false, `pid ${pid}`);
  }
});
