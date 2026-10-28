// 设置页 v2 · 第 5 轮修复回归（纯 Node，不启动浏览器）：
//   1. MULTI-01 跨标签页按字段 merge：A 改外观、B 改无关项都保留；快捷键按动作合并；
//   2. storage 事件同步（源码接线）与不再整包写回；
//   3. OFFLINE-01 / OFFLINE-02：设备离线时使用活动标缓存态并锁定分段、模型刷新禁用且有原因；
//   4. LAYOUT-01 / VIS-01：长字符串断行、添加设备行 / 外观勾的盒内溢出修正。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")

const model = await import("../ui/src/pi/settings/model.ts")

function memoryStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => Object.fromEntries(map),
  }
}

/* ------------------------------------------------------------------ */
/* MULTI-01 按字段 merge                                                */
/* ------------------------------------------------------------------ */

test("MULTI-01 两个标签页改不同字段：后写的 patch 不覆盖先写字段", () => {
  const storage = memoryStorage()
  // A：切浅色（只改 appearanceTheme）
  const afterA = model.patchSettingsLocal(storage, { appearanceTheme: "light" })
  assert.equal(afterA.appearanceTheme, "light")

  // B：改无关的减少动态效果（B 的内存里 appearanceTheme 仍是旧值，但只提交自己的 patch）
  const afterB = model.patchSettingsLocal(storage, { reducedMotion: true })
  assert.equal(afterB.reducedMotion, true)
  assert.equal(afterB.appearanceTheme, "light", "B 的无关写入把 A 的 appearanceTheme 回退了")

  // 第三个标签页再改别的字段也不影响前两项
  const afterC = model.patchSettingsLocal(storage, { notifySound: true, usageRange: "weekly" })
  assert.equal(afterC.notifySound, true)
  assert.equal(afterC.usageRange, "weekly")
  const stored = model.loadSettingsLocal(storage).prefs
  assert.equal(stored.appearanceTheme, "light")
  assert.equal(stored.reducedMotion, true)
  assert.equal(stored.notifySound, true)
  assert.equal(JSON.parse(storage.getItem(model.SETTINGS_STORAGE_KEY)).v, model.SETTINGS_STORAGE_VERSION)
})

test("MULTI-01 快捷键按动作合并：A/B 各改一个动作都保留", () => {
  const defaults = model.createDefaultSettingsPrefs()
  const latest = { ...defaults.shortcuts, newSession: ["Ctrl", "N"] }
  // B 页面的 prefs 里还是默认表（过期），本次只改了 globalSearch。
  const nextFromB = { ...defaults.shortcuts, globalSearch: ["Ctrl", "K"] }
  const merged = model.mergeSettingsShortcuts(defaults.shortcuts, latest, nextFromB)
  assert.deepEqual(merged.newSession, ["Ctrl", "N"], "B 的过期整表把 A 改的 newSession 盖回去了")
  assert.deepEqual(merged.globalSearch, ["Ctrl", "K"])
  assert.deepEqual(merged.archiveSession, defaults.shortcuts.archiveSession, "未改动作保持最新存储值")
})

test("MULTI-01 恢复默认是显式整份替换（不是 merge）", () => {
  const storage = memoryStorage()
  model.patchSettingsLocal(storage, { appearanceTheme: "light", reducedMotion: true, defaultDeviceId: "d-x" })
  const reset = model.replaceSettingsLocal(storage, model.resetSettingsPrefs())
  assert.equal(reset.appearanceTheme, "system")
  assert.equal(reset.reducedMotion, false)
  assert.equal(reset.defaultDeviceId, "")
  assert.deepEqual(model.loadSettingsLocal(storage).prefs, reset)
})

test("MULTI-01 settingsPrefsEqual 逐字段（含快捷键动作）", () => {
  const base = model.createDefaultSettingsPrefs()
  assert.equal(model.settingsPrefsEqual(base, model.createDefaultSettingsPrefs()), true)
  assert.equal(model.settingsPrefsEqual(base, model.setSettingsPref(base, "appearanceTheme", "light")), false)
  assert.equal(model.settingsPrefsEqual(base, model.setSettingsPref(base, "reducedMotion", true)), false)
  assert.equal(
    model.settingsPrefsEqual(base, model.mergeSettingsPrefs(base, { shortcuts: { ...base.shortcuts, newSession: ["Ctrl", "N"] } })),
    false,
    "快捷键动作变化要能被 storage 同步识别",
  )
  const sameShortcuts = model.mergeSettingsPrefs(base, { shortcuts: { ...base.shortcuts } })
  assert.equal(model.settingsPrefsEqual(base, sameShortcuts), true)
})

test("MULTI-01 设置 Context：读最新存储再写、监听 storage、不再整包覆盖", () => {
  const source = read("ui/src/pi/settings/SettingsContext.tsx")
  assert.match(source, /loadSettingsLocal\(target\(\)\)\.prefs/, "写入前未读最新存储")
  assert.match(source, /mergeSettingsPrefs\(latest, effective\)/, "未把本次 patch 合并到最新偏好")
  assert.match(source, /mergeSettingsShortcuts\(/, "快捷键未按动作合并")
  assert.match(source, /window\.addEventListener\("storage", onStorage\)/, "缺少跨标签页 storage 同步")
  assert.match(source, /settingsPrefsEqual\(latest, latestPrefs\.current\)/, "storage 同步未做值比较")
  assert.match(source, /window\.dispatchEvent\(new Event\(SETTINGS_PREFS_EVENT\)\)/, "写入后未当帧广播")
  assert.doesNotMatch(source, /setPrefs\(\(current\) => setSettingsPref\(current/, "仍在用旧 state 整包写回")
  assert.doesNotMatch(source, /useEffect\(\(\) => \{\s*saveSettingsLocal\(target\(\), prefs\)/, "不能每次渲染都把整个 prefs 写回")
})

test("MULTI-01 外观页只在宿主 style 真变化时回写，storage 同步的皮肤不被旧宿主盖回", () => {
  for (const file of [
    "ui/src/pi/settings/pages/AppearancePage.tsx",
    "ui/src/pi/settings/mobile/pages/AppearancePage.tsx",
  ]) {
    const source = read(file)
    assert.match(source, /hostStyle\.current === style/, `${file} 缺少宿主 style 变化判断`)
    assert.match(source, /styleSynced\.current = true/, `${file} 缺少首次进入对齐`)
  }
})

/* ------------------------------------------------------------------ */
/* 设备离线判断                                                        */
/* ------------------------------------------------------------------ */

test("设备离线只看 relay 的 devices / selectedDevice.online 字段", () => {
  assert.equal(
    model.settingsDeviceOfflineOf({ deviceMode: true, selectedDevice: { online: false }, selectedDeviceId: "d-win" }),
    true,
  )
  assert.equal(model.settingsDeviceOfflineOf({ deviceMode: true, selectedDevice: { online: true } }), false)
  assert.equal(
    model.settingsDeviceOfflineOf({
      deviceMode: true,
      selectedDevice: null,
      selectedDeviceId: "d-win",
      devices: [{ id: "d-win", online: false }],
    }),
    true,
    "selectedDevice 缺失时要回落 devices 名册",
  )
  assert.equal(model.settingsDeviceOfflineOf({ deviceMode: true, selectedDevice: null, devices: [] }), false, "没有设备不算离线")
  assert.equal(model.settingsDeviceOfflineOf({ deviceMode: false, selectedDevice: { online: false } }), false, "非设备模式不门控")
})

/* ------------------------------------------------------------------ */
/* OFFLINE-01 / OFFLINE-02                                             */
/* ------------------------------------------------------------------ */

test("OFFLINE-01 使用活动：设备离线 / relay 缓存时明示缓存态并锁定分段", () => {
  const page = read("ui/src/pi/settings/pages/UsagePage.tsx")
  assert.match(page, /settingsDeviceOfflineOf\(relay\)/)
  assert.match(page, /const offlineCache = deviceOffline \|\| usage\.stale \|\| usage\.reason === "device_offline"/)
  assert.match(page, /disabled=\{offlineCache\}/, "统计指标 / 查看方式未在缓存态禁用")
  assert.match(page, /data-settings-usage-offline=/, "缺少可测的缓存态标记")
  assert.match(page, /设备离线，显示上次缓存的数据（可能不是最新）/)
  assert.match(page, /统计指标 \/ 查看方式已锁定/)

  const mobile = read("ui/src/pi/settings/mobile/pages/UsagePage.tsx")
  assert.match(mobile, /disabled=\{offlineCache\}/)
  assert.match(mobile, /设备离线，显示上次缓存的数据（可能不是最新）/)
})

test("OFFLINE-02 模型页：设备离线时刷新模型目录禁用并写明原因", () => {
  const page = read("ui/src/pi/settings/pages/ModelPage.tsx")
  assert.match(page, /const deviceOffline = settingsDeviceOfflineOf\(relay\)/)
  assert.match(page, /disabled=\{!refreshReady \|\| modelsLoading\}/, "刷新模型目录仍可在离线时点击")
  assert.match(page, /设备离线，无法刷新模型目录；设备恢复连接后可重新读取/, "缺少离线原因")
})

/* ------------------------------------------------------------------ */
/* LAYOUT-01 / VIS-01                                                  */
/* ------------------------------------------------------------------ */

test("LAYOUT-01 长 URL / 长字符串在页盒内断行", () => {
  const css = read("ui/src/pi/settings/settings.css")
  assert.match(css, /\.settings-page \{[^}]*overflow-wrap: anywhere/s)
  assert.match(css, /\.settings-page \{[^}]*word-break: break-word/s)
  assert.match(css, /\.settings-row-description \{[^}]*overflow-wrap: anywhere/s)
  assert.match(css, /\.settings-row-description \{[^}]*word-break: break-word/s)
  assert.match(css, /\.settings-card \{[^}]*max-width: 100%/s)
  assert.match(css, /\.settings-card \{[^}]*min-width: 0/s)
  assert.match(css, /\.settings-row \{[^}]*min-width: 0/s)
  assert.match(css, /\.settings-row-title-text \{[^}]*overflow-wrap: anywhere/s)
})

test("VIS-01 添加设备行 / 外观选中勾不再越出页盒", () => {
  const devices = read("ui/src/pi/settings/pages/devices.css")
  // 页面作用域（0,2,0）压过外壳 `.settings-root button`（0,1,1）；width/margin 必须一起生效。
  assert.match(devices, /\.settings-devices \.settings-device-add \{[^}]*width: calc\(100% \+ 32px\)/s)
  assert.match(devices, /\.settings-devices \.settings-device-add \{[^}]*margin: 0 -16px/s)
  assert.doesNotMatch(devices, /^\.settings-device-add \{\n  display: flex;[\s\S]*?width: calc\(100% \+ 32px\)/m)

  const appearance = read("ui/src/pi/settings/pages/appearance.css")
  assert.match(appearance, /\.settings-appearance-cards \{[^}]*padding-inline-end: 8px/s, "最后一列没有给 -8px 的选中勾留位置")
})
