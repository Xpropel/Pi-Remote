import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests",
  testMatch: "i18n.spec.ts",
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  reporter: "list",
  outputDir: "./node_modules/.tmp/i18n-results",
  use: {
    baseURL: "http://127.0.0.1:7183",
    locale: "en-US",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
  webServer: {
    command: "npm run build && npm run preview -- --host 127.0.0.1 --port 7183 --strictPort",
    url: "http://127.0.0.1:7183",
    timeout: 120_000,
    reuseExistingServer: false,
  },
})
