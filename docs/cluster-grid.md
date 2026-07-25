# Cluster-grid browser e2e

The local suites (`suites/playwright`, `suites/puppeteer`, `suites/selenium`)
run browsers **on your machine** against a locally-booted stack. This suite is
the opposite: it drives a **live zed property** through the browser grid
**deployed in the k8s cluster** (`dd-browser-test-server` on AWS/Hetzner), under
all three server-side engines. The browser runs in the cluster; there are no
local browser dependencies here.

Use it to prove a released, public zed surface renders correctly on real
Chromium across Playwright, Puppeteer, and Selenium — the same
`POST /run` contract the DD cluster suites (`k8s-cluster` repo) use.

## The deployed grid

`dd-browser-test-server` is a Fastify service (`:8104`) that drives Chromium via
Playwright / Puppeteer / Selenium from declarative step scripts. It fronts
`dd-selenium-server` (Selenium Grid on `:4444`, pod-internal only). Both live in
the `default` namespace of the AWS cluster (kube context `dd-ec2-admin`). Auth is
a shared `x-server-auth` header (`SERVER_AUTH_SECRET` in the cluster's
`dd-agent-secrets`). The Grid `:4444` is never exposed, so the authenticated
`/run` API is the only entrypoint.

| Endpoint | Purpose |
|---|---|
| `POST /run` | run `{ tool, url, steps[] }`, returns `{ extracted, … }` |
| `GET /healthz` | liveness |
| `GET /` | descriptor incl. supported `tools` |

Step actions include `goto`, `waitForSelector`, `click`, `fill`, `press`,
`extractText`, `extractAttribute`, `screenshot`.

## Running it

```sh
# 1. Tunnel to the deployed server (AWS cluster). Leave this running.
kubectl --context dd-ec2-admin port-forward svc/dd-browser-test-server 18104:8104

# 2. Pull the shared auth secret from the cluster (stays in your shell).
export SERVER_AUTH_SECRET=$(kubectl --context dd-ec2-admin \
  get secret dd-agent-secrets -o jsonpath='{.data.SERVER_AUTH_SECRET}' | base64 -d)

# 3. Run the suite (defaults to https://zed-pkg.github.io/).
export BROWSER_TEST_URL=http://localhost:18104
npm run e2e:cluster-grid
```

The suite **self-skips** unless both `BROWSER_TEST_URL` and `SERVER_AUTH_SECRET`
are set, so `npm test` and CI without grid access are unaffected. Override the
target with `ZED_SITE_URL`.

To run against the Hetzner cluster instead, point `--context` at
`kind-fiducia-hetzner` (the grid must be deployed there; today it runs on AWS).

## Cross-engine note

Selenium's `getText()` returns **CSS-rendered** text while Playwright and
Puppeteer return the raw DOM `textContent`. The zed home page's `.eyebrow` is
`text-transform: uppercase`, so Selenium reports `V0.1 - EARLY ACCESS` where the
other two report `v0.1 - early access`. Assertions here match
case-insensitively; keep that difference in mind when adding steps.
