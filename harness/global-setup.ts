import { startStack } from "./stack.js";

export default async function globalSetup(): Promise<void> {
  const stack = await startStack();
  process.env.ZED_E2E_API_URL_RESOLVED = stack.apiUrl;
  process.env.ZED_E2E_WEB_URL_RESOLVED = stack.webUrl;
}
