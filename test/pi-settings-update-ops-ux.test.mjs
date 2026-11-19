// Pi-Remote 设置页 · Pi 升级与系统操作体验闭环测试（纯 Node：直载 .ts 纯逻辑 + 页面接线静态守卫）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")

const aboutData = await import("../ui/src/pi/settings/pages/aboutData.ts")
const opsLogic = await import("../ui/src/pi/settings/pages/systemOpsLogic.ts")
const updateLogic = await import("../ui/src/pi/settings/pages/settingsPiUpdate.ts")

const NOW = 1_760_000_000_000

function readyTarget(over = {}) {
  return {
    deviceId: "dev-mac",
    deviceName: "Mac",
    canRestart: true,
    reason: "",
    busy: { generating: false, pendingDialog: false },
    ...over,
  }
}

function npmUpdate(over = {}) {
  return {
    currentVersion: "1.5.2",
    latestVersion: "1.5.2",
    installMethod: "npm-global",
    canUpdate: false,
    checkError: null,
    supervised: false,
    launchedPiCount: 1,
    attachVersion: "4.0.0",
    ...over,
  }
}

test("aboutData：GITHUB_RELEASES_API 指向真实仓库 Xpropel/Pi-Remote", () => {
  assert.equal(
    aboutData.GITHUB_RELEASES_API,
    "https://api.github.com/repos/Xpropel/Pi-Remote/releases?per_page=10",
  )
})

test("settingsPiUpdateRowOf：覆盖不可用 / 检查中 / 已是最新 / 有新版本(含忙碌警告) / 非 npm / 失败 / 运行中 / 其他操作互斥", () => {
  // 1. 离线或不支持 device.ops
  const offline = updateLogic.settingsPiUpdateRowOf({
    target: readyTarget({ canRestart: false, reason: opsLogic.SYSTEM_OPS_OFFLINE_TEXT }),
    checking: false,
    update: null,
    checkError: null,
    status: opsLogic.IDLE_OPERATION_STATUS,
    otherRunning: false,
    now: NOW,
  })
  assert.equal(offline.disabled, true)
  assert.equal(offline.actionKind, "none")
  assert.equal(offline.actionLabel, "不可用")
  assert.equal(offline.description, opsLogic.SYSTEM_OPS_OFFLINE_TEXT)

  // 2. 正在检查更新（尚无结果）
  const checking = updateLogic.settingsPiUpdateRowOf({
    target: readyTarget(),
    checking: true,
    update: null,
    checkError: null,
    status: opsLogic.IDLE_OPERATION_STATUS,
    otherRunning: false,
    now: NOW,
  })
  assert.equal(checking.disabled, true)
  assert.equal(checking.actionLabel, "检查中…")
  assert.match(checking.description, /npm 注册表/)

  // 3. 已是最新版本
  const latest = updateLogic.settingsPiUpdateRowOf({
    target: readyTarget(),
    checking: false,
    update: npmUpdate(),
    checkError: null,
    status: opsLogic.IDLE_OPERATION_STATUS,
    otherRunning: false,
    now: NOW,
  })
  assert.equal(latest.disabled, false)
  assert.equal(latest.canUpdate, false)
  assert.equal(latest.actionKind, "recheck")
  assert.equal(latest.actionLabel, "重新检查")
  assert.match(latest.description, /当前 Pi 1\.5\.2 已是最新版本/)

  // 4. 更新完成后的 latest 显示完成前缀
  const succeeded = updateLogic.settingsPiUpdateRowOf({
    target: readyTarget(),
    checking: false,
    update: npmUpdate({ currentVersion: "1.6.0", latestVersion: "1.6.0" }),
    checkError: null,
    status: {
      state: "succeeded",
      kind: "update_pi",
      phase: null,
      startedAt: NOW - 30_000,
      finishedAt: NOW - 2_000,
      detail: "Pi updated",
      error: null,
    },
    otherRunning: false,
    now: NOW,
  })
  assert.match(succeeded.description, /^已更新到最新版本 · 当前 Pi 1\.6\.0/)

  // 5. 发现新版本 + 忙碌提示
  const availBusy = updateLogic.settingsPiUpdateRowOf({
    target: readyTarget({ busy: { generating: true, pendingDialog: false } }),
    checking: false,
    update: npmUpdate({ currentVersion: "1.5.2", latestVersion: "1.6.0", canUpdate: true }),
    checkError: null,
    status: opsLogic.IDLE_OPERATION_STATUS,
    otherRunning: false,
    now: NOW,
  })
  assert.equal(availBusy.disabled, false)
  assert.equal(availBusy.canUpdate, true)
  assert.equal(availBusy.actionKind, "update")
  assert.equal(availBusy.actionLabel, "更新到 1.6.0")
  assert.equal(availBusy.badgeText, "新版 1.6.0")
  assert.match(availBusy.description, /正在生成回复/)
  assert.match(availBusy.description, /发现新版本 1\.6\.0/)

  // 6. 非 npm 全局安装（other / unknown）
  const otherInstall = updateLogic.settingsPiUpdateRowOf({
    target: readyTarget(),
    checking: false,
    update: npmUpdate({ latestVersion: null, installMethod: "other" }),
    checkError: null,
    status: opsLogic.IDLE_OPERATION_STATUS,
    otherRunning: false,
    now: NOW,
  })
  assert.equal(otherInstall.canUpdate, false)
  assert.equal(otherInstall.actionKind, "recheck")
  assert.match(otherInstall.description, /非 npm 全局安装/)

  const unknownInstall = updateLogic.settingsPiUpdateRowOf({
    target: readyTarget(),
    checking: false,
    update: npmUpdate({ currentVersion: "", latestVersion: null, installMethod: "unknown" }),
    checkError: null,
    status: opsLogic.IDLE_OPERATION_STATUS,
    otherRunning: false,
    now: NOW,
  })
  assert.match(unknownInstall.description, /未能识别 Pi 安装方式/)

  // 7. 注册表检查失败
  const checkErr = updateLogic.settingsPiUpdateRowOf({
    target: readyTarget(),
    checking: false,
    update: npmUpdate({ latestVersion: null, checkError: "ETIMEDOUT" }),
    checkError: null,
    status: opsLogic.IDLE_OPERATION_STATUS,
    otherRunning: false,
    now: NOW,
  })
  assert.equal(checkErr.canUpdate, false)
  assert.equal(checkErr.actionKind, "recheck")
  assert.match(checkErr.description, /检查更新失败：ETIMEDOUT/)

  // 8. 正在安装中
  const running = updateLogic.settingsPiUpdateRowOf({
    target: readyTarget(),
    checking: false,
    update: npmUpdate({ currentVersion: "1.5.2", latestVersion: "1.6.0", canUpdate: true }),
    checkError: null,
    status: {
      state: "running",
      kind: "update_pi",
      phase: "installing",
      startedAt: NOW - 24_000,
      finishedAt: null,
      detail: null,
      error: null,
    },
    otherRunning: false,
    now: NOW,
  })
  assert.equal(running.disabled, true)
  assert.equal(running.actionLabel, "更新中…")
  assert.match(running.description, /正在安装 1\.6\.0/)
  assert.match(running.description, /已用时 24 秒/)

  // 9. 上次更新失败（有新版本可直达重试更新）
  const failed = updateLogic.settingsPiUpdateRowOf({
    target: readyTarget(),
    checking: false,
    update: npmUpdate({ currentVersion: "1.5.2", latestVersion: "1.6.0", canUpdate: true }),
    checkError: null,
    status: {
      state: "failed",
      kind: "update_pi",
      phase: null,
      startedAt: NOW - 50_000,
      finishedAt: NOW - 10_000,
      detail: null,
      error: "EACCES",
    },
    otherRunning: false,
    now: NOW,
  })
  assert.equal(failed.disabled, false)
  assert.equal(failed.actionKind, "update")
  assert.equal(failed.actionLabel, "重试更新到 1.6.0")
  assert.match(failed.description, /上次更新失败：EACCES/)

  // 10. 同设备有其他操作正在进行
  const locked = updateLogic.settingsPiUpdateRowOf({
    target: readyTarget(),
    checking: false,
    update: npmUpdate({ latestVersion: "1.6.0", canUpdate: true }),
    checkError: null,
    status: opsLogic.IDLE_OPERATION_STATUS,
    otherRunning: true,
    now: NOW,
  })
  assert.equal(locked.disabled, true)
  assert.equal(locked.actionLabel, "请稍候")
})

test("compactSystemOpLabelOf 与 compactSystemOpsSummaryOf：单行紧凑标签与去重摘要", () => {
  const mkRow = (over) => ({
    kind: "update_pi",
    title: "更新 Pi",
    subtitle: "",
    description: "",
    buttonLabel: "检查更新",
    buttonAction: "run",
    buttonEnabled: true,
    buttonPrimary: false,
    phaseText: null,
    warningText: null,
    errorText: null,
    failed: false,
    ...over,
  })

  assert.equal(
    opsLogic.compactSystemOpLabelOf(mkRow({ kind: "update_pi", buttonPrimary: true, buttonLabel: "更新到 1.6.0" })),
    "更新 Pi (1.6.0)",
  )
  assert.equal(
    opsLogic.compactSystemOpLabelOf(mkRow({ kind: "update_pi", buttonAction: "recheck" })),
    "检查 Pi 更新",
  )
  assert.equal(
    opsLogic.compactSystemOpLabelOf(mkRow({ kind: "update_pi", buttonLabel: "已是最新" })),
    "Pi 已是最新",
  )
  assert.equal(
    opsLogic.compactSystemOpLabelOf(mkRow({ kind: "harness_restart", phaseText: "重启中" })),
    "重启 Pi 中…",
  )
  assert.equal(
    opsLogic.compactSystemOpLabelOf(mkRow({ kind: "update_components", buttonAction: "retry" })),
    "重试更新设备端组件",
  )

  const summary = opsLogic.compactSystemOpsSummaryOf(
    [
      mkRow({ kind: "update_pi", buttonEnabled: true, warningText: "当前会话忙；" }),
      mkRow({ kind: "harness_restart", buttonEnabled: false, description: "未绑定会话，仅可更新 Pi" }),
      mkRow({ kind: "restart_host", buttonEnabled: false, description: "设备端不是常驻方式启动" }),
      mkRow({ kind: "update_components", buttonEnabled: false, description: "设备端不是常驻方式启动" }),
    ],
    { kind: "harness_restart", ok: true, title: "Pi 已重启", text: "版本号未变化", finishedAt: NOW },
  )
  assert.equal(summary.runningRow, null)
  assert.equal(summary.failedRow, null)
  assert.equal(summary.okText, "Pi 已重启 · 版本号未变化")
  assert.equal(summary.warnText, "当前会话忙")
  assert.equal(
    summary.mutedText,
    "未绑定会话，仅可更新 Pi · 非守护模式启动，暂不支持远程重启或更新设备端组件",
  )
})

test("设置页升级 Pi 与系统操作接线守卫（含紧凑横向操作条）", () => {
  const sysOpsSrc = read("ui/src/pi/settings/pages/useSystemOps.ts")
  assert.match(sysOpsSrc, /notifySettingsPiRestarted/)
  assert.match(sysOpsSrc, /nextStatus\.kind === "harness_restart" \|\| nextStatus\.kind === "update_pi"/)

  const deviceSysOpsSrc = read("ui/src/pi/settings/pages/DeviceSystemOps.tsx")
  assert.match(deviceSysOpsSrc, /settings-ops-bar/)
  assert.match(deviceSysOpsSrc, /settings-ops-foot/)
  assert.match(deviceSysOpsSrc, /compactSystemOpLabelOf/)
  assert.match(deviceSysOpsSrc, /compactSystemOpsSummaryOf/)

  const mobileSysOpsSrc = read("ui/src/pi/settings/mobile/pages/SystemOpsPage.tsx")
  assert.match(mobileSysOpsSrc, /sm-ops-bar/)
  assert.match(mobileSysOpsSrc, /sm-ops-foot/)
  assert.match(mobileSysOpsSrc, /compactSystemOpLabelOf/)
  assert.match(mobileSysOpsSrc, /compactSystemOpsSummaryOf/)

  const generalSrc = read("ui/src/pi/settings/pages/GeneralPage.tsx")
  const mobileGeneralSrc = read("ui/src/pi/settings/mobile/pages/GeneralPage.tsx")
  assert.match(generalSrc, /SettingsActionBar/)
  assert.match(mobileGeneralSrc, /MobileActionBar/)
  for (const src of [generalSrc, mobileGeneralSrc]) {
    assert.match(src, /title="更新 Pi"/)
    assert.match(src, /title="重启 Pi"/)
    assert.match(src, /title="设备端更新与系统操作"/)
    assert.match(src, /SettingsPiUpdateDialog/)
  }

  const aboutSrc = read("ui/src/pi/settings/pages/AboutPage.tsx")
  const mobileAboutSrc = read("ui/src/pi/settings/mobile/pages/AboutPage.tsx")
  assert.match(aboutSrc, /resolveSettingsPiRestartDevice/)
  assert.match(aboutSrc, /设备运行与升级/)
  assert.match(aboutSrc, /settings-about-row--bar/)
  assert.match(aboutSrc, /settings-about-actions/)
  assert.match(aboutSrc, /更新 Pi/)
  assert.match(aboutSrc, /重启 Pi/)
  assert.match(aboutSrc, /系统操作/)
  assert.match(aboutSrc, /SettingsPiUpdateDialog/)

  assert.match(mobileAboutSrc, /resolveSettingsPiRestartDevice/)
  assert.match(mobileAboutSrc, /设备运行与升级/)
  assert.match(mobileAboutSrc, /MobileActionBar/)
  assert.match(mobileAboutSrc, /title="更新 Pi"/)
  assert.match(mobileAboutSrc, /title="重启 Pi"/)
  assert.match(mobileAboutSrc, /title="设备端更新与系统操作"/)
  assert.match(mobileAboutSrc, /SettingsPiUpdateDialog/)

  const modelSrc = read("ui/src/pi/settings/pages/ModelPage.tsx")
  const mobileModelSrc = read("ui/src/pi/settings/mobile/pages/ModelPage.tsx")
  assert.match(modelSrc, /SettingsActionBar/)
  assert.match(modelSrc, /SettingsActionButton/)
  assert.match(mobileModelSrc, /MobileActionBar/)
  assert.match(mobileModelSrc, /MobileActionButton/)

  const privacySrc = read("ui/src/pi/settings/pages/PrivacyPage.tsx")
  const mobilePrivacySrc = read("ui/src/pi/settings/mobile/pages/PrivacyPage.tsx")
  assert.match(privacySrc, /SettingsActionBar/)
  assert.match(privacySrc, /SettingsActionButton/)
  assert.match(mobilePrivacySrc, /MobileActionBar/)
  assert.match(mobilePrivacySrc, /MobileActionButton/)

  const devicesSrc = read("ui/src/pi/settings/pages/DevicesPage.tsx")
  assert.match(devicesSrc, /initialAutoExpandedRef/)
  assert.match(devicesSrc, />\s*系统操作\s*</)

  const mobileDevicesSrc = read("ui/src/pi/settings/mobile/pages/DevicesPage.tsx")
  assert.doesNotMatch(mobileDevicesSrc, /系统操作 · 更新与重启 Pi/)

  const settingsPageSrc = read("ui/src/pi/settings/SettingsPage.tsx")
  assert.match(settingsPageSrc, /data-settings-rail-update-btn/)
  assert.match(settingsPageSrc, /SettingsPiUpdateDialog/)
  assert.doesNotMatch(settingsPageSrc, /MobileSettingsPage|settings-mobile/)

  const mobileIndexSrc = read("ui/src/pi/settings/mobile/pages/IndexPage.tsx")
  assert.match(mobileIndexSrc, /data-settings-mobile-update-btn/)
  assert.match(mobileIndexSrc, /SettingsPiUpdateDialog/)
})
