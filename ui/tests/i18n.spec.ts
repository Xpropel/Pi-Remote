import { test, expect, type Page } from "@playwright/test"
import { EN } from "../src/i18n/en.ts"

const SETTINGS = "pi_remote_pi_settings_v2"

async function relayFixture(page: Page) {
  await page.routeWebSocket(/ws:\/\/.*/, (socket) => {
    socket.onMessage((data) => {
      const frame = JSON.parse(String(data))
      if (frame.type === "auth") socket.send(JSON.stringify({
        type: "auth_result", ok: true, proto: 4, accountId: "admin",
        caps: ["err.v4", "sync.v3", "device.token", "room.label"],
        rooms: [], devices: [], serverName: "我的服务器", boot: "i18n-test",
      }))
    })
  })
}

async function openSettings(page: Page, layout: "desktop" | "phone", language: "en" | "zh-CN" = "en") {
  await page.getByRole("button", { name: language === "en" ? EN["设置"] : "设置", exact: true }).click()
  if (layout === "phone") await page.getByRole("button", { name: language === "en" ? EN["通用"] : "通用", exact: true }).click()
  await expect(page.locator('[data-settings-page="general"], [data-sm-page="general"]')).toBeVisible()
}

for (const layout of ["desktop", "phone"] as const) {
  test(`${layout}: English login and persistent settings language selector`, async ({ page }) => {
    await page.setViewportSize(layout === "phone" ? { width: 390, height: 844 } : { width: 1440, height: 960 })
    await relayFixture(page)
    await page.goto("/")
    await expect(page.locator("html")).toHaveAttribute("lang", "en")
    await expect(page.getByRole("heading", { name: "Connect to Pi-Remote" })).toBeVisible()
    await expect(page.getByLabel("Interface language", { exact: true })).toHaveValue("en")
    await page.getByLabel("Viewer token", { exact: true }).fill("test-viewer-not-a-real-credential")
    await page.getByRole("button", { name: "Connect", exact: true }).click()
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible()
    // This name arrived over the wire and must never be translated.
    await expect(page.getByText("我的服务器", { exact: true }).first()).toHaveText("我的服务器")
    await openSettings(page, layout)
    await expect(page.getByText("Startup and navigation", { exact: true })).toBeVisible()
    const picker = page.getByRole("combobox", { name: "Interface language", exact: true })
    await expect(picker).toHaveValue("en")
    await picker.selectOption("zh-CN")
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN")
    await page.reload()
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN")
    expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).prefs.language, SETTINGS)).toBe("zh-CN")
    await openSettings(page, layout, "zh-CN")
    await expect(page.getByText("启动与导航", { exact: true })).toBeVisible()
    await page.getByRole("combobox", { name: "界面语言", exact: true }).selectOption("en")
    await expect(page.locator("html")).toHaveAttribute("lang", "en")
    await openSettings(page, layout)
    await expect(page.getByText("Startup and navigation", { exact: true })).toBeVisible()
    await page.screenshot({ path: `node_modules/.tmp/i18n-results/settings-${layout}-en.png`, fullPage: true })
  })

  test(`${layout}: login language picker works before authentication`, async ({ page }) => {
    await page.setViewportSize(layout === "phone" ? { width: 390, height: 844 } : { width: 1440, height: 960 })
    await page.goto("/")
    await page.getByRole("combobox", { name: "Interface language", exact: true }).selectOption("zh-CN")
    await expect(page.getByRole("heading", { name: "连接 Pi-Remote", exact: true })).toBeVisible()
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN")
    await page.getByRole("combobox", { name: "界面语言", exact: true }).selectOption("en")
    await expect(page.getByRole("heading", { name: "Connect to Pi-Remote", exact: true })).toBeVisible()
    await page.screenshot({ path: `node_modules/.tmp/i18n-results/login-${layout}-en.png`, fullPage: true })
  })
}
