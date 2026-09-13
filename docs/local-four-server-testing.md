# Local four-server testing

This repository can boot the four standard Rust server boundaries from sibling checkouts:

- `../zed-api-server.rs`
- `../zed-web-server.rs`
- `../zed-admin-api-server.rs`
- `../zed-admin-web-server.rs`

The admin pair remains a separate control plane. The runner does not invent or persist credentials and does not read plaintext `.env` files. Load the product and admin-plane runtime values through the existing `ores-sops`/SOPS + age flow before starting the stack.

## Commands

```sh
npm run local:validate # validate the checked-in four-server manifest only
npm run local:check    # additionally require all four sibling Cargo.toml files
npm run local:stack    # build --locked, boot all four, health-gate, run until Ctrl-C
npm run local:test     # boot all four, run the configured E2E command, always tear down
```

Default URLs are API `http://127.0.0.1:48080`, web `:48081`, admin API `:48082`, and admin web `:48083`. Override any port with `ZED_LOCAL_API_PORT`, `ZED_LOCAL_WEB_PORT`, `ZED_LOCAL_ADMIN_API_PORT`, or `ZED_LOCAL_ADMIN_WEB_PORT`.

The child test command receives `ZED_E2E_API_URL`, `ZED_E2E_WEB_URL`, `ZED_E2E_ADMIN_API_URL`, `ZED_E2E_ADMIN_WEB_URL`, and `ZED_E2E_BASE_URL`. Override the configured test command with `ZED_LOCAL_TEST_CMD`.

Each binary is built from its sibling checkout with `cargo build --locked`; startup fails on an occupied port or missing sibling, and every process must answer its `/healthz` probe before tests run. Logs are kept under `.local-stack/` for diagnosis. On test failure, SIGINT, or SIGTERM, the runner terminates the processes it started.

For admin services, provide the isolated `ADMIN_DATABASE_URL`, `SHARED_AUTH_ADMIN_*`, trusted CIDR, tenant, and application settings required by those servers. Do not reuse customer-realm database or authentication credentials for the admin pair.
