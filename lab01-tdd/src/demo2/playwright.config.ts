import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const port = 3000;
const baseURL = `http://127.0.0.1:${port}`;

// Config for the demo2 Playwright examples. Playwright starts the bug report
// site itself (see webServer) and opens a visible browser so students can watch
// each step.
export default defineConfig({
  testDir: fileURLToPath(new URL("./playwright", import.meta.url)),
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: fileURLToPath(
          new URL("./playwright/report.json", import.meta.url),
        ),
      },
    ],
  ],
  use: {
    baseURL,
    headless: false,
    launchOptions: { slowMo: 400 },
  },
  webServer: {
    command: "node --import tsx src/demo2/server.ts",
    cwd: projectRoot,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
