# zed-e2e

End-to-end tests for the [zed-pkg](https://github.com/zed-pkg) registry stack. One harness boots
the whole system — Postgres (Docker), `zed-api-server.rs`, `zed-web-server.rs` — and three
browser frameworks plus the `zed` CLI drive it:

| Suite | Framework | What it covers |
| --- | --- | --- |
| `suites/playwright` | Playwright Test | Web UI flows (browse, search, package pages) + API contract + CLI publish/install round-trips |
| `suites/puppeteer` | Puppeteer + `node:test` | Web UI smoke + HTMX behaviors in raw Chromium |
| `suites/selenium` | selenium-webdriver + `node:test` | Cross-driver UI verification (chromedriver) |
| `suites/cluster-grid` | deployed k8s browser grid | Drives a live zed site through the AWS/Hetzner `dd-browser-test-server` under playwright/puppeteer/selenium — no local browser. Opt-in; see [docs/cluster-grid.md](docs/cluster-grid.md) |

## Prerequisites

- Docker (for Postgres 16)
- Rust toolchain (builds the two servers + CLI in debug mode on first run)
- Node 20+
- A Chrome/Chromium install for the Puppeteer and Selenium suites. Puppeteer
  downloads its own Chromium; Selenium uses [Selenium Manager] (built into
  `selenium-webdriver` 4.x) to fetch the chromedriver matching your installed
  Chrome — no pinned `chromedriver` package, so there is never a version-skew
  failure.

[Selenium Manager]: https://www.selenium.dev/documentation/selenium_manager/

Sibling checkouts are expected at `../zed-api-server.rs`, `../zed-web-server.rs`, `../zed-cli`.

## Run

```bash
npm install
npx playwright install chromium

npm run e2e             # all three suites (playwright -> puppeteer -> selenium)
npm run e2e:auth        # CLI Supabase/shared-auth aliases + token lifecycle
npm run e2e:playwright
npm run e2e:puppeteer
npm run e2e:selenium
```

Each suite boots (and tears down) the stack itself. To reuse one stack across suites:

```bash
npm run stack:up        # boots postgres + api + web, prints URLs
ZED_E2E_API_URL=http://127.0.0.1:48080 ZED_E2E_WEB_URL=http://127.0.0.1:48081 npm run e2e
npm run stack:down
```

Ports: API `48080`, web `48081`, Postgres `55432` (container `zed-e2e-postgres`).
Logs and state live under `.stack/`. The CLI runs against a throwaway `ZED_PKG_HOME`
under `.stack/zed-pkg-home` so your real `~/.zed-pkg` store is never touched.

## Tagged release testing

`.github/workflows/tagged-e2e.yml` runs the full stack with an immutable zed CLI
ref. For a zed CLI release, create the same `v*` tag in this repository; the
workflow checks out the matching `zed-cli` tag and current server components.
It can also be launched manually with explicit tag or SHA inputs for every
component. Tags are preferred for releases, while SHAs remain available for
one-off diagnostics.
