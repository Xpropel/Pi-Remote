// Device-owned switch sync (approval gate / remote dialog answering /
// ask_user tool): the pure state machine behind useRelay's push
// discipline, plus the ext_status switches normalization in promptModel.
// Pins the ownership rules: adopt device reports, push only explicit
// local changes, never push on connect, legacy fallback for bridges
// that cannot report.
import test from "node:test"
import assert from "node:assert/strict"

const sync = await import("../ui/src/pi/model/switchSync.ts")
const { extStatusAfterEvent, extStatusSwitchesOf } = await import("../ui/src/chat/composer/promptModel.ts")

test("switchSync: pending 模式不下达（等设备报告或旧桥判定）", () => {
  const entry = sync.switchSyncEntryInit()
  assert.equal(sync.switchSyncShouldPush(entry, "false"), false)
  assert.equal(sync.switchSyncShouldPush(entry, "true"), false)
})

test("switchSync: 设备报告被采纳为基线；本地值与基线一致不下达、偏离才下达", () => {
  const r1 = sync.switchSyncOnReport(sync.switchSyncEntryInit(), "true|list")
  assert.equal(r1.adopt, "true|list", "报告值要回写本地偏好（设置页显示设备真值）")
  assert.equal(r1.entry.mode, "device")
  assert.equal(sync.switchSyncShouldPush(r1.entry, "true|list"), false, "与设备一致：连上不下达")
  assert.equal(sync.switchSyncShouldPush(r1.entry, "false|list"), true, "用户显式改动：下达")
  const after = sync.switchSyncAfterPush(r1.entry, "false|list")
  assert.equal(sync.switchSyncShouldPush(after, "false|list"), false, "下达成功即新基线，不重复发")
})

test("switchSync: 设备侧后续变化（他端改动/桥重启回默认）再次被采纳", () => {
  const r1 = sync.switchSyncOnReport(sync.switchSyncEntryInit(), "true|high-risk")
  const r2 = sync.switchSyncOnReport(r1.entry, "false|high-risk")
  assert.equal(r2.adopt, "false|high-risk")
  assert.equal(sync.switchSyncShouldPush(r2.entry, "false|high-risk"), false)
  assert.equal(sync.switchSyncShouldPush(r2.entry, "true|high-risk"), true, "本地若还停在旧值，按用户改动下达")
})

test("switchSync: 无 switches 的快照 = 旧桥 → legacy 模式恢复旧纪律（进房/变化即下达）", () => {
  const r = sync.switchSyncOnReport(sync.switchSyncEntryInit(), null)
  assert.equal(r.entry.mode, "legacy")
  assert.equal(r.adopt, null, "旧桥没有真值可采纳")
  assert.equal(sync.switchSyncShouldPush(r.entry, "false|high-risk"), true, "legacy：进房即下达（与此前一致）")
  const after = sync.switchSyncAfterPush(r.entry, "false|high-risk")
  assert.equal(sync.switchSyncShouldPush(after, "false|high-risk"), false, "同值不重发")
  assert.equal(sync.switchSyncShouldPush(after, "true|high-risk"), true, "变化即发")
})

test("switchSync: legacy 中途收到报告升级为 device；device 模式不因缺字段降级", () => {
  const legacy = sync.switchSyncOnReport(sync.switchSyncEntryInit(), null).entry
  const up = sync.switchSyncOnReport(legacy, "true|all-non-readonly")
  assert.equal(up.entry.mode, "device")
  assert.equal(up.adopt, "true|all-non-readonly")
  const noDowngrade = sync.switchSyncOnReport(up.entry, null)
  assert.equal(noDowngrade.entry.mode, "device", "一次缺字段的快照不把设备模式打回 legacy")
  assert.equal(noDowngrade.adopt, null)
  assert.equal(sync.switchSyncShouldPush(noDowngrade.entry, "true|all-non-readonly"), false)
})

test("switchSync: ask_user 式单布尔开关——采纳后与设备一致不下达、显式偏离才下达、旧桥进房即下达", () => {
  const r1 = sync.switchSyncOnReport(sync.switchSyncEntryInit(), "true")
  assert.equal(r1.adopt, "true", "设备真值回写本地偏好（设置页显示设备状态）")
  assert.equal(sync.switchSyncShouldPush(r1.entry, "true"), false, "与设备一致：连上/进房不下达")
  assert.equal(sync.switchSyncShouldPush(r1.entry, "false"), true, "用户显式关掉：下达")
  const after = sync.switchSyncAfterPush(r1.entry, "false")
  assert.equal(sync.switchSyncShouldPush(after, "false"), false, "下达成功即新基线，不重复发")
  const legacy = sync.switchSyncOnReport(sync.switchSyncEntryInit(), null)
  assert.equal(legacy.entry.mode, "legacy")
  assert.equal(sync.switchSyncShouldPush(legacy.entry, "true"), true, "旧桥：进房即下达（旧纪律逐字保留）")
})

test("extStatusSwitchesOf: 合法块归一化；缺失/坏值回 null", () => {
  assert.deepEqual(
    extStatusSwitchesOf({ switches: { dialogRemoteAnswer: true, approvalGate: { enabled: false, tier: "list" }, askUserEnabled: false } }),
    { dialogRemoteAnswer: true, approvalGate: { enabled: false, tier: "list" }, askUserEnabled: false },
  )
  assert.equal(extStatusSwitchesOf({}), null, "旧桥不带字段")
  assert.equal(extStatusSwitchesOf(null), null)
  assert.equal(extStatusSwitchesOf({ switches: { dialogRemoteAnswer: "yes", approvalGate: { enabled: true, tier: "list" }, askUserEnabled: true } }), null)
  assert.equal(extStatusSwitchesOf({ switches: { dialogRemoteAnswer: true, approvalGate: { enabled: true, tier: "bogus" }, askUserEnabled: true } }), null, "非法 tier")
  assert.equal(extStatusSwitchesOf({ switches: { dialogRemoteAnswer: true } }), null, "缺审批门半块")
  assert.equal(extStatusSwitchesOf({ switches: { dialogRemoteAnswer: true, approvalGate: { enabled: true, tier: "list" } } }), null, "缺 askUser 半块")
  assert.equal(extStatusSwitchesOf({ switches: { dialogRemoteAnswer: true, approvalGate: { enabled: true, tier: "list" }, askUserEnabled: "yes" } }), null, "askUser 非布尔")
})

/* ---------------- round 2: baseline moves only on device report -------- */

test("switchSync: device 模式下达不挪基线——基线只在设备报告到达时移动", () => {
  const r1 = sync.switchSyncOnReport(sync.switchSyncEntryInit(), "false|high-risk")
  const after = sync.switchSyncAfterPush(r1.entry, "true|high-risk")
  assert.equal(after.sent, "false|high-risk", "下达后基线仍是上一次设备报告值，不是下达值")
  assert.equal(after.pushed, "true|high-risk", "下达值只记在途")
  assert.equal(sync.switchSyncShouldPush(after, "true|high-risk"), false, "在途值不重复下达（恰好一次）")
  const settled = sync.switchSyncOnReport(after, "true|high-risk", "true|high-risk")
  assert.equal(settled.entry.sent, "true|high-risk", "确认报告到达，基线才翻")
  assert.equal(settled.entry.pushed, undefined, "在途清空")
  assert.equal(settled.adopt, "true|high-risk")
})

test("switchSync: 在途下达遇先于下达的旧报告——基线更新，但本地不被打回、不重发", () => {
  const r1 = sync.switchSyncOnReport(sync.switchSyncEntryInit(), "false")
  const after = sync.switchSyncAfterPush(r1.entry, "true")
  const stale = sync.switchSyncOnReport(after, "false", "true")
  assert.equal(stale.adopt, null, "旧报告不回写本地：保住用户刚选的值")
  assert.equal(stale.entry.sent, "false", "基线照常更新为报告值")
  assert.equal(stale.entry.pushed, "true", "在途保留，等确认报告落定")
  assert.equal(sync.switchSyncShouldPush(stale.entry, "true"), false, "不因旧报告重复下达")
  const settled = sync.switchSyncOnReport(stale.entry, "true", "true")
  assert.equal(settled.entry.pushed, undefined)
  assert.equal(settled.entry.sent, "true")
  assert.equal(settled.adopt, "true")
})

test("switchSync C1/C2 序列: 两个全新观看端先后连同一设备（设备为关）——连接都不下达、显示都采纳为关；显式打开恰好下达一次", () => {
  // C1: local prefs pre-set gate ON, device is OFF.
  const c1Init = sync.switchSyncEntryInit()
  assert.equal(sync.switchSyncShouldPush(c1Init, "true|high-risk"), false, "C1 报告未到（pending）：连接不下达")
  const c1 = sync.switchSyncOnReport(c1Init, "false|high-risk", "true|high-risk")
  assert.equal(c1.adopt, "false|high-risk", "C1 报告到达：采纳设备值，设置显示关（不是本地的开）")
  assert.equal(sync.switchSyncShouldPush(c1.entry, "false|high-risk"), false, "C1 采纳后与基线一致：不下达，设备状态不变")
  // C2: local prefs pre-set gate OFF, device still OFF (C1 changed nothing).
  const c2Init = sync.switchSyncEntryInit()
  assert.equal(sync.switchSyncShouldPush(c2Init, "false|high-risk"), false, "C2 pending：不下达")
  const c2 = sync.switchSyncOnReport(c2Init, "false|high-risk", "false|high-risk")
  assert.equal(c2.adopt, "false|high-risk", "C2 同样采纳为关")
  assert.equal(sync.switchSyncShouldPush(c2.entry, "false|high-risk"), false)
  // C2 user explicitly turns the gate ON in settings.
  assert.equal(sync.switchSyncShouldPush(c2.entry, "true|high-risk"), true, "显式改动偏离基线：下达")
  const pushed = sync.switchSyncAfterPush(c2.entry, "true|high-risk")
  assert.equal(pushed.sent, "false|high-risk", "下达不挪基线")
  assert.equal(sync.switchSyncShouldPush(pushed, "true|high-risk"), false, "恰好一次：同值不再发")
  const settled = sync.switchSyncOnReport(pushed, "true|high-risk", "true|high-risk")
  assert.equal(settled.entry.sent, "true|high-risk", "设备报告确认后基线翻为开")
})

test("switchSyncViewFromEntries: pending/legacy 无设备真值；device 给报告值；在途下达时仍报设备值", () => {
  const pending = sync.switchSyncViewFromEntries(undefined, undefined, undefined)
  assert.equal(pending.mode, "pending")
  assert.equal(pending.approvalGateEnabled, null)
  assert.equal(pending.askUserEnabled, null)
  const dev = (v) => sync.switchSyncOnReport(sync.switchSyncEntryInit(), v).entry
  const view = sync.switchSyncViewFromEntries(dev("true"), dev("false|list"), dev("false"))
  assert.deepEqual(view, { mode: "device", dialogRemoteAnswer: true, approvalGateEnabled: false, approvalGateTier: "list", askUserEnabled: false })
  const legacy = sync.switchSyncOnReport(sync.switchSyncEntryInit(), null).entry
  const legacyView = sync.switchSyncViewFromEntries(legacy, legacy, legacy)
  assert.equal(legacyView.mode, "legacy")
  assert.equal(legacyView.askUserEnabled, null, "legacy 没有设备真值，显示回落本地偏好")
  const inflight = sync.switchSyncAfterPush(dev("false|high-risk"), "true|high-risk")
  const inflightView = sync.switchSyncViewFromEntries(dev("true"), inflight, dev("true"))
  assert.equal(inflightView.approvalGateEnabled, false, "在途未确认时视图仍是设备已报告值")
})

/* ---------------- round 2: settings display merge (the item-3 break) ----- */

const { legacyPrefsOf, legacyStyleOf } = await import("../ui/src/pi/model/legacyStyle.ts")
const { settingsPrefsOf } = await import("../ui/src/pi/model/settingsView.ts")
const { DEFAULT_PI_PREFS } = await import("../ui/src/pi/model/prefs.ts")

test("legacyPrefsOf: 六项全给具体值（空存储 = 与 PiPrefs 默认一致）；坏值逐项落默认", () => {
  const empty = legacyPrefsOf(null)
  assert.equal(empty.askUserEnabled, DEFAULT_PI_PREFS.askUserEnabled)
  assert.equal(empty.approvalGateEnabled, DEFAULT_PI_PREFS.approvalGateEnabled)
  assert.equal(empty.approvalGateTier, DEFAULT_PI_PREFS.approvalGateTier)
  assert.equal(empty.dialogRemoteAnswer, DEFAULT_PI_PREFS.dialogRemoteAnswer)
  assert.equal(empty.completionSound, DEFAULT_PI_PREFS.completionSound)
  const bad = legacyPrefsOf(JSON.stringify({ askUserEnabled: "yes", approvalGateTier: "bogus" }))
  assert.equal(bad.askUserEnabled, DEFAULT_PI_PREFS.askUserEnabled)
  assert.equal(bad.approvalGateTier, DEFAULT_PI_PREFS.approvalGateTier)
})

test("显示断点回归: 采纳只写旧键——设置页必须读 legacyPrefsOf 合并集才显示设备值；三项 legacyStyleOf 输入正是第 1 轮的洞", () => {
  // Device-adopted state lives in the legacy key: everything OFF.
  const raw = JSON.stringify({ completionSound: false, dialogRemoteAnswer: false, queueSend: "interrupt", askUserEnabled: false, approvalGateEnabled: false, approvalGateTier: "high-risk" })
  // The PiPrefs copy says the opposite for every switch (the C1 setup).
  const prefs = { ...DEFAULT_PI_PREFS, dialogRemoteAnswer: true, askUserEnabled: true, approvalGateEnabled: true, approvalGateTier: "list" }
  const merged = settingsPrefsOf(prefs, legacyPrefsOf(raw), "steer")
  assert.equal(merged.approvalGate, false, "审批门显示设备采纳值")
  assert.equal(merged.approvalGateTier, "high-risk")
  assert.equal(merged.askUser, false, "ask_user 显示设备采纳值")
  assert.equal(merged.dialogRemote, false)
  // The round-1 hole, kept as executable documentation: with the
  // three-field legacyStyleOf object the switch fields are undefined
  // and settingsPrefsOf falls back to the PiPrefs copy -- which is why
  // the live check read C1=ON / C2=OFF straight from local prefs.
  const holed = settingsPrefsOf(prefs, legacyStyleOf(raw), "steer")
  assert.equal(holed.approvalGate, true, "三项输入下审批门落回本地副本（第 1 轮断点）")
  assert.equal(holed.askUser, true, "三项输入下 ask_user 同样落回本地副本")
  assert.equal(holed.dialogRemote, false, "只有 dialogRemote 因在三项内而幸免")
})

/* ---------------- round 2: wiring guards --------------------------------- */

import fs from "node:fs"
const readUi = (p) => fs.readFileSync(new URL(`../ui/src/${p}`, import.meta.url), "utf8")

test("接线守卫: useSettingsPrefs 喂合并集；useRelay 暴露 switchSyncView；设置面 pending 时禁用三开关", () => {
  const cShared = readUi("pi/containers/cShared.ts")
  assert.match(cShared, /useLegacyPrefs\(\)/, "useSettingsPrefs 必须读含 G1/G2 的合并集（第 1 轮断点）")
  const relay = readUi("relay/useRelay.ts")
  assert.match(relay, /switchSyncView,/, "useRelay 返回对象要带 switchSyncView")
  const general = readUi("pi/settings/pages/GeneralPage.tsx")
  assert.match(general, /switchSyncView\.mode === "pending" && !!relay\.roomId/, "E4: 通用页同样只在已进房且该房 pending 时禁用")
  assert.match(general, /disabled=\{switchesPending\}/, "通用页三开关 + 档位在 pending 时禁用")
})

/* ---------------- D-1: display state (is device truth reachable?) ------ */

test("switchDisplayStateOf: 无身份/未登记 + pending = identity-required（本地值永不冒充设备真值）", () => {
  const pending = sync.SWITCH_SYNC_PENDING_VIEW
  assert.equal(sync.switchDisplayStateOf(pending, null), "identity-required", "没有身份对象")
  assert.equal(sync.switchDisplayStateOf(pending, undefined), "identity-required")
  assert.equal(sync.switchDisplayStateOf(pending, { hasIdentity: false, registered: false }), "identity-required", "从未启用身份（D-1 实测形态）")
  assert.equal(sync.switchDisplayStateOf(pending, { hasIdentity: true, registered: false }), "identity-required", "生成了钥但未登记：ext_status 仍到不了")
  assert.equal(sync.switchDisplayStateOf(pending, { hasIdentity: false, registered: true }), "identity-required", "半截状态不算可用身份")
})

test("switchDisplayStateOf: 有可用身份时 FIX-GATE 行为不变（pending 等首份报告、device 显示真值、legacy 照旧）", () => {
  const usable = { hasIdentity: true, registered: true }
  assert.equal(sync.switchDisplayStateOf(sync.SWITCH_SYNC_PENDING_VIEW, usable), "pending", "有身份：仍是原来的短暂 pending")
  const deviceView = { mode: "device", dialogRemoteAnswer: false, approvalGateEnabled: false, approvalGateTier: "list", askUserEnabled: false }
  assert.equal(sync.switchDisplayStateOf(deviceView, usable), "device")
  assert.equal(sync.switchDisplayStateOf(deviceView, null), "device", "报告已经到了就与身份无关")
  assert.equal(sync.switchDisplayStateOf({ ...sync.SWITCH_SYNC_PENDING_VIEW, mode: "legacy" }, null), "legacy", "旧桥：本地值即操作值，不改")
  assert.equal(sync.switchDisplayStateOf({ ...sync.SWITCH_SYNC_PENDING_VIEW, mode: "legacy" }, usable), "legacy")
})

test("D-1 接线守卫: 设置面按 switchDisplayStateOf 渲染 identity-required，并带启用身份的就地动作", () => {
  const general = readUi("pi/settings/pages/GeneralPage.tsx")
  assert.match(general, /switchDisplayStateOf\(relay\.switchSyncView, relay\.viewerIdentity\) === "identity-required"/, "通用页按纯函数判定 identity-required")
  assert.match(general, /title="启用观看端身份"/, "通用页对话组带启用动作行")
  assert.match(general, /setPage\("devices"\)/, "启用动作直达设备页（身份区所在页）")
  assert.ok((general.match(/需先启用身份/g) ?? []).length >= 3, "三开关 + 档位在 identity-required 时都不显示本地值")
  const sections = readUi("components/pi/composer/PiSettingsPage.tsx")
  assert.match(sections, /switchesIdentityRequired\?: boolean/, "共享设置节声明 identity-required 输入")
  assert.match(sections, /act\?\.\("enable-identity"\)/, "共享设置节带启用身份动作行")
})

test("extStatusAfterEvent: switches 进快照；坏帧保留上一份", () => {
  const ev = { type: "ext_status", statuses: { a: "1" }, widgets: [], title: null, working: null, tap: { state: "ok" }, switches: { dialogRemoteAnswer: false, approvalGate: { enabled: true, tier: "high-risk" }, askUserEnabled: true }, at: 3 }
  const snap = extStatusAfterEvent(null, ev)
  assert.deepEqual(snap.switches, { dialogRemoteAnswer: false, approvalGate: { enabled: true, tier: "high-risk" }, askUserEnabled: true })
  const plain = extStatusAfterEvent(null, { type: "ext_status", statuses: {}, widgets: [], at: 1 })
  assert.equal(plain.switches, null, "旧桥快照 switches 为 null")
})
