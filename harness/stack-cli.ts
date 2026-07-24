// `npm run stack:up` / `stack:down` — boot or tear down the shared stack so
// multiple suites can run against one instance (set ZED_E2E_API_URL /
// ZED_E2E_WEB_URL to the printed URLs).
import { startStack, stopStack, API_URL, WEB_URL } from "./stack.js";

const cmd = process.argv[2];

if (cmd === "up") {
  process.env.ZED_E2E_KEEP = "1";
  const stack = await startStack();
  console.log(`api: ${stack.apiUrl}`);
  console.log(`web: ${stack.webUrl}`);
  console.log(`\nexport ZED_E2E_API_URL=${API_URL}`);
  console.log(`export ZED_E2E_WEB_URL=${WEB_URL}`);
  process.exit(0);
} else if (cmd === "down") {
  delete process.env.ZED_E2E_KEEP;
  delete process.env.ZED_E2E_API_URL;
  await stopStack();
  console.log("stack torn down");
  process.exit(0);
} else {
  console.error("usage: stack-cli.ts <up|down>");
  process.exit(1);
}
