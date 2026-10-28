// Pi-Remote 设置页 v2 · 宿主消费纯逻辑（Node，无浏览器）。
//
// 守住四类偏好 → 宿主决定的契约：
//   - privacyMode 是本机偏好（默认 false、逐字段 normalize、存储往返）；
//   - 默认设备只在「在线 + 当前无选中/当前选中离线 + 未手动选择」时自动选中，且同一 id 只应用一次；
//   - 通知门控：等待/出错/完成 × 仅页面外/总是 × 声音/角标，隐私模式不带正文；
//   - 快捷键：偏好键帽 → 事件匹配（修饰键顺序归一）、浏览器保留键、输入框/浮层保护。
import test from "node:test"
import assert from "node:assert/strict"

const host = await import("../ui/src/pi/model/settingsHost.ts")
const model = await import("../ui/src/pi/settings/model.ts")

const prefsOf = (patch = {}) => model.mergeSettingsPrefs(model.createDefaultSettingsPrefs(), patch)
const gateOf = (patch = {}) => host.notificationGateOf(prefsOf(patch))
const key = (k, mods = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })

/* ------------------------------------------------------------------ 本机偏好 */

test("privacyMode：默认关闭、逐字段 normalize、存储往返、坏值回落", () => {
  const defaults = model.createDefaultSettingsPrefs()
  assert.equal(defaults.privacyMode, false)
  assert.equal(model.DEFAULT_SETTINGS_PREFS.privacyMode, false)

  const on = model.setSettingsPref(defaults, "privacyMode", true)
  assert.equal(on.privacyMode, true)
  assert.equal(defaults.privacyMode, false, "纯函数不得原地改入参")

  const parsed = model.parseSettingsLocal({ v: 1, prefs: { privacyMode: true }, updatedAt: 7 })
  assert.equal(parsed.prefs.privacyMode, true)
  assert.equal(parsed.prefs.notifyWaiting, true, "其余字段回落默认值")
  assert.equal(model.parseSettingsLocal({ v: 1, prefs: { privacyMode: "yes" } }).prefs.privacyMode, false)
  assert.equal(model.parseSettingsLocal({ v: 1, prefs: {} }).prefs.privacyMode, false, "旧数据缺字段 = 关闭")

  const storage = new Map()
  const fake = {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, String(v)),
  }
  assert.equal(model.saveSettingsLocal(fake, on), true)
  const reread = model.loadSettingsLocal(fake).prefs
  assert.equal(reread.privacyMode, true)
  assert.equal(host.readPiSettingsPrefs(fake).privacyMode, true)
  assert.equal(host.readPiSettingsPrefs(null).privacyMode, false)
})

/* ------------------------------------------------------------------ 默认设备 */

test("默认设备：在线 + 无选中 / 选中离线才自动选；手动 / 已应用 / 离线都不动", () => {
  const devices = [
    { id: "d-mbp", online: true },
    { id: "d-win", online: false },
  ]
  const base = { devices, selectedDeviceId: null, defaultDeviceId: "d-mbp", manual: false, appliedDefaultId: null }
  assert.equal(host.defaultDevicePickOf(base), "d-mbp", "无选中 → 选默认设备")
  assert.equal(host.defaultDevicePickOf({ ...base, selectedDeviceId: "d-win" }), "d-mbp", "当前选中离线 → 选默认设备")
  assert.equal(host.defaultDevicePickOf({ ...base, selectedDeviceId: "d-nope" }), "d-mbp", "当前选中不在名册 → 视为离线")
  assert.equal(host.defaultDevicePickOf({ ...base, selectedDeviceId: "d-mbp" }), null, "当前选中的就是它 → 不动")
  assert.equal(
    host.defaultDevicePickOf({ ...base, devices: [...devices, { id: "d-studio", online: true }], selectedDeviceId: "d-studio" }),
    null,
    "当前选中另一台在线设备 → 不抢用户的选择",
  )
  assert.equal(host.defaultDevicePickOf({ ...base, manual: true }), null, "本会话手动选择过 → 不覆盖")
  assert.equal(host.defaultDevicePickOf({ ...base, appliedDefaultId: "d-mbp" }), null, "同一个默认设备只应用一次")
  assert.equal(host.defaultDevicePickOf({ ...base, defaultDeviceId: "" }), null, "未设置默认设备")
  assert.equal(host.defaultDevicePickOf({ ...base, defaultDeviceId: "d-win" }), null, "默认设备离线")
})

/* ------------------------------------------------------------------ 通知 */

test("通知门控：等待 / 出错 / 完成 × 仅页面外 / 总是 × 声音 / 角标", () => {
  const gate = gateOf()
  assert.deepEqual(gate, {
    waiting: true,
    error: true,
    complete: false,
    onlyWhenAway: true,
    sound: false,
    badge: true,
    privacy: false,
  })

  // 完成默认关：完成类通知一律不发，等待/出错照旧。
  assert.equal(host.notificationEventOn(gate, "done"), false)
  assert.equal(host.notificationEventOn(gate, "error"), true)
  assert.equal(host.notificationEventOn(gate, "waiting"), true)

  const allOn = gateOf({ notifyComplete: true, notifySound: true })
  assert.equal(host.notificationBadgeVisible(allOn, "done", true), true)
  assert.equal(host.notificationBadgeVisible(allOn, "done", false), false, "仅页面外：在场不弹角标")
  assert.equal(host.notificationSoundVisible(allOn, "done", false), false, "仅页面外：在场不响")
  assert.equal(host.notificationSoundVisible(allOn, "done", true), true)

  const always = gateOf({ notifyComplete: true, notifySound: true, notifyOnlyWhenAway: false })
  assert.equal(host.notificationBadgeVisible(always, "done", false), true, "总是提醒：在场也弹角标")
  assert.equal(host.notificationSoundVisible(always, "done", false), true, "总是提醒：在场也响")
  assert.equal(host.notificationAwayOk(always, false), true)

  const badgeOff = gateOf({ notifyComplete: true, notifyBadge: false })
  assert.equal(host.notificationBadgeVisible(badgeOff, "done", true), false, "角标关闭 → 不发标签页提醒")
  assert.equal(host.titleWaitingCountOf(badgeOff, 3), 0, "角标关闭 → 等待前缀也关闭")
  const waitingOff = gateOf({ notifyWaiting: false })
  assert.equal(host.titleWaitingCountOf(waitingOff, 3), 0)
  assert.equal(host.titleWaitingCountOf(allOn, 3), 3)
  // 「仅页面外」对等待角标同样生效；「总是提醒」才常驻。
  assert.equal(host.notificationBadgeVisible(allOn, "waiting", false), false)
  assert.equal(host.notificationBadgeVisible(gateOf({ notifyOnlyWhenAway: false }), "waiting", false), true)

  const errorOff = gateOf({ notifyError: false, notifyComplete: true })
  assert.equal(host.notificationEventOn(errorOff, "error"), false)
  assert.equal(host.notificationBadgeVisible(errorOff, "error", true), false)
})

test("隐私模式：标题不带会话正文；应用内提醒始终只有事件类型", () => {
  const normal = gateOf({ notifyComplete: true })
  const privacy = gateOf({ notifyComplete: true, privacyMode: true })
  assert.equal(host.titleRoomOf("修复登录按钮", normal), "修复登录按钮")
  assert.equal(host.titleRoomOf("修复登录按钮", privacy), "", "隐私模式下标题不出现正文")

  const notice = host.notificationNoticeOf(normal, "done", true)
  assert.deepEqual(notice, { level: "success", title: "任务完成" })
  assert.deepEqual(host.notificationNoticeOf(privacy, "done", true), notice, "隐私模式不改变提醒文案（本来就不带正文）")
  assert.deepEqual(host.notificationNoticeOf(normal, "error", true), { level: "error", title: "回合出错" })
  assert.equal(host.notificationNoticeOf(normal, "done", false), null, "仅页面外：在场不发应用内提醒")
  assert.deepEqual(host.notificationNoticeOf(gateOf({ notifyComplete: true, notifyOnlyWhenAway: false }), "done", false), notice)
  assert.equal(host.notificationNoticeOf(gateOf({ notifyComplete: false }), "done", true), null)
  assert.equal(host.notificationNoticeOf(gateOf({ notifyError: false }), "error", true), null)
})

/* ------------------------------------------------------------------ 快捷键 */

test("快捷键：默认表 16 个动作，偏好键位命中 / 修饰键顺序无关 / 组字与长按跳过", () => {
  const defaults = model.defaultSettingsShortcuts()
  const bindings = host.shortcutBindingsOf(defaults)
  assert.equal(bindings.length, 16)
  assert.deepEqual(
    bindings.map((item) => item.id),
    [
      "newSession",
      "globalSearch",
      "archiveSession",
      "pinSession",
      "previousSession",
      "nextSession",
      "toggleSidebar",
      "openSettings",
      "sendMessage",
      "insertNewline",
      "stopGeneration",
      "switchModel",
      "cycleThinkingLevel",
      "toggleThinkingBlock",
      "queueSend",
      "steerSend",
    ],
  )
  assert.equal(bindings[0].route, "new-session")
  assert.equal(bindings[8].route, "composer.send")

  assert.equal(host.shortcutHitOf(defaults, key("N", { metaKey: true }), "mac").id, "newSession")
  assert.equal(host.shortcutHitOf(defaults, key("k", { metaKey: true }), "mac").id, "globalSearch")
  assert.equal(host.shortcutHitOf(defaults, key("Enter"), "mac").id, "sendMessage")
  assert.equal(host.shortcutHitOf(defaults, key("Enter", { shiftKey: true }), "mac").id, "insertNewline")
  assert.equal(host.shortcutHitOf(defaults, key("Escape"), "mac").id, "stopGeneration")
  assert.equal(host.shortcutHitOf(defaults, key("o", { ctrlKey: true }), "other").id, "toggleThinkingBlock")

  // 自定义键位：Ctrl+Alt+N；同一组合的修饰键顺序在存储里不敏感
  const custom = model.mergeSettingsPrefs(prefsOf(), { shortcuts: { ...defaults, newSession: ["⌥", "Ctrl", "N"] } }).shortcuts
  assert.equal(host.shortcutHitOf(custom, key("N", { ctrlKey: true, altKey: true }), "other").id, "newSession")
  assert.equal(host.shortcutHitOf(custom, key("N", { metaKey: true }), "mac"), null, "旧默认键位已被自定义覆盖（键位表里没有 ⌘N）")

  assert.equal(host.shortcutHitOf(defaults, key("N", { metaKey: true, isComposing: true }), "mac"), null)
  assert.equal(host.shortcutHitOf(defaults, key("N", { metaKey: true, keyCode: 229 }), "mac"), null)
  assert.equal(host.shortcutHitOf(defaults, key("N", { metaKey: true, repeat: true }), "mac"), null)
  assert.equal(host.shortcutHitOf(defaults, key("Shift", { shiftKey: true }), "mac"), null, "只按修饰键不触发")
})

test("快捷键：浏览器保留键识别与提示文案", () => {
  assert.equal(host.browserShortcutConflictOf(["⌘", "N"], "mac"), true)
  assert.equal(host.browserShortcutConflictOf(["Ctrl", "N"], "other"), true)
  assert.equal(host.browserShortcutConflictOf(["⌘", "N"], "other"), false, "不同平台不串味")
  assert.equal(host.browserShortcutConflictOf(["Ctrl", "L"], "other"), true, "Ctrl+L = 地址栏")
  assert.equal(host.browserShortcutConflictOf(["Ctrl", "L"], "mac"), false, "mac 上 Ctrl+L 不是浏览器保留键")
  assert.equal(host.browserShortcutConflictOf(["Ctrl", "Shift", "N"], "other"), false)

  const bindings = host.shortcutBindingsOf(model.defaultSettingsShortcuts())
  const newSession = host.shortcutHitOf(model.defaultSettingsShortcuts(), key("N", { metaKey: true }), "mac")
  assert.equal(newSession.browserConflict, true)
  assert.match(host.browserShortcutHintOf(newSession), /⌘N/)
  assert.match(host.browserShortcutHintOf(newSession), /设置 › 快捷键/)
  assert.equal(bindings.find((item) => item.id === "newSession").keys.join(""), "⌘N")
})

test("快捷键焦点保护：输入框让键、composer 保留 Esc、带强修饰键仍分发", () => {
  assert.equal(host.shortcutBlockedByFocus(["Enter"], "composer"), true)
  assert.equal(host.shortcutBlockedByFocus(["⇧", "Enter"], "composer"), true)
  assert.equal(host.shortcutBlockedByFocus(["Esc"], "composer"), false, "composer 里的 Esc 仍可停止生成")
  assert.equal(host.shortcutBlockedByFocus(["⇧", "Tab"], "composer"), false, "⇧Tab 是焦点导航键，不产生文字（默认循环思考档）")
  assert.equal(host.shortcutBlockedByFocus(["⇧", "Tab"], "editable"), true, "普通输入框里的 ⇧Tab 仍归表单焦点导航")
  assert.equal(host.shortcutBlockedByFocus(["Esc"], "editable"), true, "改名 / 搜索框的 Esc 归输入框")
  assert.equal(host.shortcutBlockedByFocus(["⌘", "K"], "editable"), false, "⌘ 组合在输入框里仍分发")
  assert.equal(host.shortcutBlockedByFocus(["Ctrl", "N"], "editable"), false)
  assert.equal(host.shortcutBlockedByFocus(["Enter"], "other"), false)
})

test("快捷键：菜单 / 弹窗 / 面板 / 设置页打开时不抢键", () => {
  const closed = { menu: false, sheet: false, dialog: false, palette: false, settings: false }
  assert.equal(host.shortcutBlockedByOverlay(closed), false)
  for (const field of ["menu", "sheet", "dialog", "palette", "settings"]) {
    assert.equal(host.shortcutBlockedByOverlay({ ...closed, [field]: true }), true, `${field} 打开时应让键`)
  }
})
