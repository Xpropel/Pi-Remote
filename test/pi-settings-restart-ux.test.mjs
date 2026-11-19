// Pi-Remote 设置页 · Pi 重启体验闭环测试（纯 Node：直载 .ts 纯逻辑 + 页面接线静态守卫）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")

const restartLogic = await import("../ui/src/pi/settings/pages/settingsPiRestart.ts")
const writeLogic = await import("../ui/src/pi/settings/pages/settingsWrite.ts")
const opsLogic = await import("../ui/src/pi/settings/pages/systemOpsLogic.ts")

test("settingsPiRestart：解析目标设备与能力门控（显式设备 / 回退设备 / 离线 / 无 device.ops）", () => {
  const noopRun = async () => ({})
  const macOnline = {
    id: "dev-mac",
    name: "MacBook",
    platform: "macos",
    online: true,
    features: [opsLogic.DEVICE_OPS_CAP],
  }
  const linuxOffline = {
    id: "dev-linux",
    name: "BuildBox",
    platform: "linux",
    online: false,
    features: [opsLogic.DEVICE_OPS_CAP],
  }
  const legacyOnline = {
    id: "dev-legacy",
    name: "OldPi",
    platform: "linux",
    online: true,
    features: [],
  }

  // 显式选中的离线设备不会被静默跳到别的在线设备
  const selectedOffline = restartLogic.settingsPiRestartTargetOf({
    selectedDeviceId: "dev-linux",
    devices: [macOnline, linuxOffline],
    rooms: [],
    browserOnline: true,
    runDeviceCommand: noopRun,
  })
  assert.equal(selectedOffline.deviceId, "dev-linux")
  assert.equal(selectedOffline.canRestart, false)
  assert.equal(selectedOffline.reason, opsLogic.SYSTEM_OPS_OFFLINE_TEXT)

  // 未选设备时，若唯一在线设备具备 device.ops，自动选中它，并统计运行中会话占用
  const fallbackOnline = restartLogic.settingsPiRestartTargetOf({
    selectedDeviceId: null,
    devices: [macOnline, linuxOffline],
    rooms: [{ id: "r1", deviceId: "dev-mac", online: true, busy: true }],
    browserOnline: true,
    runDeviceCommand: noopRun,
  })
  assert.equal(fallbackOnline.deviceId, "dev-mac")
  assert.equal(fallbackOnline.deviceName, "MacBook")
  assert.equal(fallbackOnline.canRestart, true)
  assert.equal(fallbackOnline.reason, "")
  assert.deepEqual(fallbackOnline.busy, { generating: true, pendingDialog: false })

  // 缺少 device.ops 时给出明确升级提示
  const noOps = restartLogic.settingsPiRestartTargetOf({
    selectedDeviceId: "dev-legacy",
    devices: [legacyOnline],
    rooms: [],
    browserOnline: true,
    runDeviceCommand: noopRun,
  })
  assert.equal(noOps.canRestart, false)
  assert.equal(noOps.reason, opsLogic.SYSTEM_OPS_UNSUPPORTED_TEXT)

  // 浏览器离线时禁止重启
  const browserOffline = restartLogic.settingsPiRestartTargetOf({
    selectedDeviceId: "dev-mac",
    devices: [macOnline],
    rooms: [],
    browserOnline: false,
    runDeviceCommand: noopRun,
  })
  assert.equal(browserOffline.canRestart, false)
  assert.match(browserOffline.reason, /浏览器离线/)
})

test("settingsPiRestart：各阶段横幅与按钮状态文案", () => {
  const pending = restartLogic.settingsPiRestartBannerOf({
    pendingRestart: true,
    phase: "idle",
    canRestart: true,
    unsupportedReason: "",
  })
  assert.equal(pending.tone, "warn")
  assert.equal(pending.title, "有设置待重启 Pi 生效")
  assert.equal(pending.buttonLabel, "重启 Pi")
  assert.equal(pending.buttonDisabled, false)

  const running = restartLogic.settingsPiRestartBannerOf({
    pendingRestart: true,
    phase: "running",
    canRestart: true,
    unsupportedReason: "",
  })
  assert.equal(running.buttonDisabled, true)
  assert.equal(running.title, "正在重启 Pi…")
  assert.equal(running.buttonLabel, "重启中…")

  const succeeded = restartLogic.settingsPiRestartBannerOf({
    pendingRestart: false,
    phase: "succeeded",
    canRestart: true,
    unsupportedReason: "",
  })
  assert.equal(succeeded.tone, "ok")
  assert.equal(succeeded.title, writeLogic.SETTINGS_RESTART_APPLIED_TEXT)

  const failed = restartLogic.settingsPiRestartBannerOf({
    pendingRestart: true,
    phase: "failed",
    error: "tmux exited",
    canRestart: true,
    unsupportedReason: "",
  })
  assert.equal(failed.tone, "bad")
  assert.equal(failed.buttonLabel, "重试重启")
  assert.equal(failed.description, "tmux exited")
})

test("设置页重启 Pi 闭环接线：Context / Hooks / 反馈条 / 左栏 / 各配置页 / 设备页", () => {
  const contextSrc = read("ui/src/pi/settings/SettingsContext.tsx")
  assert.match(contextSrc, /export function useOptionalSettings/)

  const writeHooksSrc = read("ui/src/pi/settings/pages/settingsWriteHooks.ts")
  assert.match(writeHooksSrc, /export function clearSettingsOverlayTarget/)
  assert.match(writeHooksSrc, /export function notifySettingsPiRestarted/)
  assert.match(writeHooksSrc, /export function useSettingsPendingRestart/)
  assert.match(writeHooksSrc, /SETTINGS_RESTART_APPLIED_TEXT/)

  const feedbackSrc = read("ui/src/pi/settings/pages/settingsWriteFeedback.tsx")
  assert.match(feedbackSrc, /data-settings-restart-pi/)
  assert.match(feedbackSrc, /SettingsPiRestartDialog/)
  assert.match(feedbackSrc, /useOptionalSettings/)

  const settingsPageSrc = read("ui/src/pi/settings/SettingsPage.tsx")
  assert.match(settingsPageSrc, /SettingsRailRestart/)
  assert.match(settingsPageSrc, /data-settings-rail-restart-btn/)
  assert.doesNotMatch(settingsPageSrc, /MobileSettingsPage|settings-mobile/)

  const mobileIndexSrc = read("ui/src/pi/settings/mobile/pages/IndexPage.tsx")
  assert.match(mobileIndexSrc, /data-settings-mobile-restart-btn/)
  assert.match(mobileIndexSrc, /SettingsPiRestartDialog/)

  const generalSrc = read("ui/src/pi/settings/pages/GeneralPage.tsx")
  const mobileGeneralSrc = read("ui/src/pi/settings/mobile/pages/GeneralPage.tsx")
  for (const src of [generalSrc, mobileGeneralSrc]) {
    assert.match(src, /label="运行与重启"/)
    assert.match(src, /title="重启 Pi"/)
    assert.match(src, /SettingsPiRestartDialog/)
  }

  const modelSrc = read("ui/src/pi/settings/pages/ModelPage.tsx")
  const mobileModelSrc = read("ui/src/pi/settings/mobile/pages/ModelPage.tsx")
  for (const src of [modelSrc, mobileModelSrc]) {
    assert.match(src, /title="重启 Pi"/)
    assert.match(src, /topWriteHint/)
    assert.match(src, /!modelsLoading && modelsConfigQuery\.phase !== "loading"/)
    assert.ok(src.indexOf('title="刷新模型目录"') < src.indexOf('title="重启 Pi"'))
  }

  const extSrc = read("ui/src/pi/settings/pages/ExtensionsPage.tsx")
  const mobileExtSrc = read("ui/src/pi/settings/mobile/pages/ExtensionsPage.tsx")
  assert.match(extSrc, /<SettingsWriteNote feedback=\{mcpFeedback\} \/>/)
  assert.match(mobileExtSrc, /<MobileSettingsWriteNote feedback=\{mcpFeedback\} \/>/)

  const devicesSrc = read("ui/src/pi/settings/pages/DevicesPage.tsx")
  assert.match(devicesSrc, /useSettingsPendingRestart/)
  assert.match(devicesSrc, /deviceOpsSupportedOf/)
})
