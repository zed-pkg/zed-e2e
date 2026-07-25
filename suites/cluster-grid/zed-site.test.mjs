// Cluster-grid e2e: drive a LIVE zed property through the deployed
// dd-browser-test-server (the k8s browser grid on AWS/Hetzner) under all three
// server-side engines — playwright, puppeteer, AND selenium — via the same
// declarative POST /run contract the DD cluster suites use. The browser runs in
// the cluster, not here, so there are no local browser deps.
//
// Self-skipping: runs only when BOTH env vars are set, so `npm test` and CI
// without grid access are unaffected.
//
//   BROWSER_TEST_URL    base URL of dd-browser-test-server, e.g. after
//                       `kubectl --context dd-ec2-admin port-forward \
//                          svc/dd-browser-test-server 18104:8104`
//                       -> http://localhost:18104
//   SERVER_AUTH_SECRET  x-server-auth header (from the cluster's dd-agent-secrets)
//   ZED_SITE_URL        target; defaults to https://zed-pkg.github.io/
//
// See docs/cluster-grid.md.
import test from "node:test";
import assert from "node:assert/strict";

const SERVER = (process.env.BROWSER_TEST_URL || "").replace(/\/$/, "");
const AUTH = process.env.SERVER_AUTH_SECRET || "";
const SITE = (process.env.ZED_SITE_URL || "https://zed-pkg.github.io/").replace(/\/+$/, "/");
const enabled = Boolean(SERVER && AUTH);
const ENGINES = ["playwright", "puppeteer", "selenium"];

/** POST a declarative scenario to the grid and return its result. */
async function runOnGrid(tool, steps) {
  const res = await fetch(`${SERVER}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-server-auth": AUTH },
    body: JSON.stringify({ tool, url: SITE, steps }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`grid ${tool} -> ${res.status}: ${body}`);
  return JSON.parse(body);
}

const HOME_STEPS = [
  { action: "goto", url: SITE, waitUntil: "domcontentloaded" },
  { action: "waitForSelector", selector: ".eyebrow" },
  { action: "extractText", selector: ".eyebrow", name: "eyebrow" },
  { action: "extractText", selector: "a.btn.primary", name: "cta" },
];

for (const engine of ENGINES) {
  test(`grid/${engine}: renders the live zed home page`, { skip: !enabled }, async () => {
    const r = await runOnGrid(engine, HOME_STEPS);
    const ex = r.extracted || {};
    // NOTE: Selenium's getText() returns CSS-rendered text (the .eyebrow is
    // text-transform:uppercase), while Playwright/Puppeteer return the raw DOM
    // text — so match case-insensitively across engines.
    assert.match(ex.eyebrow || "", /early access/i, `${engine} eyebrow: ${ex.eyebrow}`);
    assert.match(ex.cta || "", /brew install/i, `${engine} cta: ${ex.cta}`);
  });
}

test("grid is reachable and advertises all three engines", { skip: !enabled }, async () => {
  const res = await fetch(`${SERVER}/healthz`, { headers: { "x-server-auth": AUTH } });
  assert.equal(res.ok, true, "browser-test-server /healthz");
  const desc = await (await fetch(`${SERVER}/`, { headers: { "x-server-auth": AUTH } })).json();
  for (const engine of ENGINES) assert.ok(desc.tools.includes(engine), `grid supports ${engine}`);
});
