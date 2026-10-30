// Fix wave 2026-10-30 (web UI defects F1/F3/F4/F5/F7, A3-F2/F3/F4, inbox
// surface for the Claude/Codex shells). Pure functions are imported from
// the .ts sources directly; tsx/css surfaces use static source guards,
// matching the established test style in this repo.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")

const newSession = await import("../ui/src/pi/model/newSession.ts")
const folderExistence = await import("../ui/src/pi/model/folderExistence.ts")
const folderBrowser = await import("../ui/src/pi/model/folderBrowser.ts")
const modelData = await import("../ui/src/pi/settings/pages/modelData.ts")
const mobileModel = await import("../ui/src/pi/settings/mobile/model.ts")
const tray = await import("../ui/src/pi/model/tray.ts")
const inboxView = await import("../ui/src/pi/model/inboxView.ts")
const prefsModel = await import("../ui/src/pi/model/prefs.ts")
const legacyStyle = await import("../ui/src/pi/model/legacyStyle.ts")

/* ------------------------------------------------------------------ F3 -- */

const device = { id: "dev1", online: true, platform: "linux", projects: ["/root/proj"], browseRoots: ["/root"], features: [] }
const sessions = [
  { cwd: "/root/deleted", updatedAt: 200 },
  { cwd: "/root/live", updatedAt: 100 },
]

test("F3: recentFoldersOf skips folders proven missing (normalized keys)", () => {
  assert.deepEqual(newSession.recentFoldersOf(sessions, device, 5), ["/root/deleted", "/root/live"])
  assert.deepEqual(newSession.recentFoldersOf(sessions, device, 5, new Set(["/root/deleted"])), ["/root/live"])
  // The exclusion set holds raw paths; matching normalizes slashes/case.
  assert.deepEqual(newSession.recentFoldersOf(sessions, device, 5, new Set(["/ROOT/Deleted/"])), ["/root/live"])
})

test("F3: newSessionDefaultsOf never preselects a deleted workspace", () => {
  const input = { devices: [device], rooms: [], sessionsByDevice: { dev1: sessions }, selectedDeviceId: "dev1" }
  assert.equal(newSession.newSessionDefaultsOf(input).folder, "/root/deleted", "baseline: most recent wins")
  assert.equal(newSession.newSessionDefaultsOf(input, new Set(["/root/deleted"])).folder, "/root/live")
  assert.equal(
    newSession.newSessionDefaultsOf(input, new Set(["/root/deleted", "/root/live"])).folder,
    "/root/proj",
    "all recents gone -> first surviving project",
  )
  assert.equal(
    newSession.newSessionDefaultsOf(input, new Set(["/root/deleted", "/root/live", "/root/proj"])).folder,
    "/root",
    "projects gone too -> first surviving browse root",
  )
})

test("F3: folderForDevice and knownFoldersOf honor the exclusion set", () => {
  assert.equal(newSession.folderForDevice(device, "/root/deleted"), "/root/deleted")
  assert.equal(newSession.folderForDevice(device, "/root/deleted", new Set(["/root/deleted"])), "/root/proj")
  const known = folderBrowser.knownFoldersOf(device, sessions, new Set(["/root/deleted"]))
  assert.ok(!known.includes("/root/deleted"))
  assert.ok(known.includes("/root/live"))
})

test("F3: probeFolderExistence -- only fs_not_found proves missing; null is never cached", async () => {
  let calls = 0
  const okDirs = async () => {
    calls += 1
    return { entries: [] }
  }
  assert.equal(await folderExistence.probeFolderExistence("dev-probe", "/p/live", okDirs), "exists")
  assert.equal(await folderExistence.probeFolderExistence("dev-probe", "/p/live", okDirs), "exists")
  assert.equal(calls, 1, "verdict is cached")

  const notFound = async () => {
    const error = new Error("nope")
    error.code = "fs_not_found"
    throw error
  }
  assert.equal(await folderExistence.probeFolderExistence("dev-probe", "/p/gone", notFound), "missing")
  assert.ok(folderExistence.missingFoldersOf("dev-probe").has("/p/gone"))

  let deniedCalls = 0
  const denied = async () => {
    deniedCalls += 1
    const error = new Error("denied")
    error.code = "fs_denied"
    throw error
  }
  assert.equal(await folderExistence.probeFolderExistence("dev-probe", "/p/shy", denied), null)
  assert.equal(await folderExistence.probeFolderExistence("dev-probe", "/p/shy", denied), null)
  assert.equal(deniedCalls, 2, "inconclusive answers are re-probed, never cached")
  assert.ok(!folderExistence.missingFoldersOf("dev-probe").has("/p/shy"))
})

test("F3: the three shells snapshot known rooms so a room switch cannot steal the first prompt", () => {
  for (const rel of [
    "ui/src/pi/containers/NewSessionContainer.tsx",
    "ui/src/pi/variants/claude/pages/ClaudeNewSession.tsx",
    "ui/src/pi/variants/codex/pages/CodexNewSession.tsx",
  ]) {
    assert.match(read(rel), /knownRoomIds/, rel)
  }
})

/* ------------------------------------------------------------------ F1 -- */

test("F1: settings pages remember the current tab across shell remounts", () => {
  assert.match(read("ui/src/pi/settings/SettingsPage.tsx"), /lastSettingsPage/)
  assert.match(read("ui/src/pi/settings/mobile/MobileSettingsPage.tsx"), /lastMobileSettingsPage/)
})

/* ------------------------------------------------------------------ F4 -- */

test("F4: the queue tray pill carries a tooltip that says what clicking does", () => {
  const items = tray.trayItemsOf({ remoteQueue: [{ status: "pending" }, { status: "pending" }], localQueue: null, outbox: [], linkOk: true, deviceOnline: true })
  const queue = items.find((item) => item.kind === "queue")
  assert.ok(queue)
  assert.equal(queue.title, "排队中的消息，点开可编辑、取消或立即发送")
  assert.match(read("ui/src/components/pi/composer/PiTray.tsx"), /title=\{item\.title\}/)
})

test("F4: queued bubbles render queue actions in every shell", () => {
  const parts = read("ui/src/components/pi/conversation/PiTurnParts.tsx")
  assert.match(parts, /排队中/)
  assert.match(parts, /queueSendNow/)
  assert.match(parts, /queueCancel/)
  const transcript = read("ui/src/pi/containers/TranscriptContainer.tsx")
  assert.match(transcript, /queued: true/)
  assert.match(transcript, /sharedSendNowLock/)
  assert.match(read("ui/src/pi/variants/claude/thread/ClaudeThread.tsx"), /排队中/)
  assert.match(read("ui/src/pi/variants/codex/thread/CodexUserBubble.tsx"), /排队中/)
})

/* ------------------------------------------------------------------ F5 -- */

test("F5: no fee display remains on any usage surface", () => {
  const dialog = read("ui/src/components/pi/composer/PiUsageDialog.tsx")
  assert.doesNotMatch(dialog, /费用/)
  assert.doesNotMatch(dialog, /costByModel/)
  assert.match(dialog, /缓存命中/)
  assert.doesNotMatch(read("ui/src/components/pi/composer/PiComposerMenu.tsx"), /用量与费用/)
  const infoCard = read("ui/src/components/pi/shell/PiSessionInfoCard.tsx")
  assert.doesNotMatch(infoCard, /"cost"/)
  assert.doesNotMatch(read("ui/src/pi/variants/claude/overlays/ClaudeSessionInfoCard.tsx"), /tok\}/)
})

/* ------------------------------------------------------------------ F7 -- */

const providerRow = (id, name, configured, keys) => ({
  id,
  name,
  state: "ready",
  endpoint: null,
  configured,
  models: keys.map((key) => ({ key, provider: id, modelId: key.split("/")[1] ?? key, label: key.split("/")[1] ?? key, thinking: null, enabled: true })),
})

test("F7: defaultModelGroupsOf groups by provider and marks unconfigured providers", () => {
  const groups = modelData.defaultModelGroupsOf(
    [providerRow("stepfun", "StepFun", true, ["stepfun/a", "stepfun/b"]), providerRow("openai", "OpenAI", false, ["openai/c"])],
    "stepfun/a",
  )
  assert.deepEqual(groups.map((group) => group.label), ["StepFun", "OpenAI（未配置凭据）"])
  assert.deepEqual(groups[0].options.map((option) => option.value), ["stepfun/a", "stepfun/b"])
  // configured === null (unknown) must NOT be marked as unconfigured
  const unknown = modelData.defaultModelGroupsOf([providerRow("x", "XProv", null, ["x/m"])], "")
  assert.equal(unknown[0].label, "XProv")
})

test("F7: a stored current model missing from the catalog stays selectable in its own group", () => {
  const groups = modelData.defaultModelGroupsOf([providerRow("stepfun", "StepFun", true, ["stepfun/a"])], "gone/model")
  assert.equal(groups[0].options[0].value, "gone/model")
  assert.deepEqual(groups[1].options.map((option) => option.value), ["stepfun/a"])
})

test("F7: mobile modelGroupsOf groups choices under their provider rows", () => {
  const choices = [
    { key: "stepfun/a", provider: "stepfun", modelId: "a", label: "a" },
    { key: "openai/c", provider: "openai", modelId: "c", label: "c" },
    { key: "stepfun/b", provider: "stepfun", modelId: "b", label: "b" },
  ]
  const providers = [
    { id: "stepfun", name: "StepFun", connected: true, configured: true, models: 2, authSource: null },
    { id: "openai", name: "OpenAI", connected: false, configured: false, models: 1, authSource: null },
  ]
  const groups = mobileModel.modelGroupsOf(choices, providers)
  assert.deepEqual(groups.map((group) => group.label), ["StepFun", "OpenAI（未配置凭据）"])
  assert.deepEqual(groups[0].options.map((option) => option.value), ["stepfun/a", "stepfun/b"])
})

test("F7: both selects render optgroup headers", () => {
  assert.match(read("ui/src/pi/settings/ui.tsx"), /<optgroup/)
  assert.match(read("ui/src/pi/settings/mobile/atoms.tsx"), /<optgroup/)
})

/* ------------------------------------------------------------- A3-F2/F3 -- */

test("A3-F2: the viewer-list read waits out the identity reconnect instead of failing instantly", () => {
  const relay = read("ui/src/relay/useRelay.ts")
  assert.match(relay, /密钥登录被中转服务拒绝，无法读取观看端名册/)
  assert.match(relay, /浏览器处于离线状态，无法读取观看端名册/)
})

test("A3-F3: waiting-for-ACK copy is honest and the devices section re-reads on identity changes", () => {
  const logic = read("ui/src/pi/settings/pages/identityLogic.ts")
  assert.doesNotMatch(logic, /保持连接稍候即可/)
  assert.match(logic, /送达时间不确定/)
  assert.match(read("ui/src/relay/useRelay.ts"), /ackAskAtRef/)
  assert.match(read("ui/src/pi/settings/pages/IdentitySection.tsx"), /identitySignal/)
})

/* --------------------------------------------------------------- A3-F4 -- */

test("A3-F4: the Codex notice slot is in-flow on phone pages and cannot cover the back button", () => {
  const css = read("ui/src/pi/variants/codex/styles/codex.css")
  assert.match(css, /\.cx-phone-page \.cx-notice-slot\s*\{\s*position: static;/)
})

/* ------------------------------------------------------ inbox (item 10) -- */

const inboxEntry = (over) => ({ key: "k1", accountId: "default", roomId: "r1", deviceId: "d1", kind: "waiting", subkind: "ask", at: 1000, ...over })

test("inbox view model: groups in waiting/error/done order, empty groups dropped", () => {
  const groups = inboxView.inboxGroupsOf([
    inboxEntry({ key: "a", kind: "done", subkind: "turn" }),
    inboxEntry({ key: "b", kind: "waiting" }),
    inboxEntry({ key: "c", kind: "waiting", subkind: "prompt" }),
  ])
  assert.deepEqual(groups.map((group) => group.kind), ["waiting", "done"])
  assert.equal(groups[0].entries.length, 2)
  assert.equal(inboxView.inboxDetailOf(inboxEntry({})), "等你回答")
  assert.equal(inboxView.inboxDetailOf(inboxEntry({ kind: "done", subkind: "turn" })), "回合已完成，还没看")
})

test("inbox view model: only live answerable confirm dialogs can be answered in place", () => {
  const confirm = inboxEntry({ key: "dialog:d9", subkind: "dialog", dialogKind: "confirm", answerable: true })
  assert.deepEqual(inboxView.inboxConfirmAnswerOf(confirm), { dialogId: "d9", allowLabel: "允许", denyLabel: "拒绝" })
  assert.equal(inboxView.inboxConfirmAnswerOf(inboxEntry({ key: "dialog:d9", subkind: "dialog", dialogKind: "confirm", answerable: false })), null)
  assert.equal(inboxView.inboxConfirmAnswerOf(inboxEntry({ key: "dialog:d9", subkind: "dialog", dialogKind: "select", answerable: true })), null)
  assert.equal(inboxView.inboxConfirmAnswerOf(inboxEntry({})), null, "ask entries jump into the room -- the ledger has no payload")
})

test("item 10 (cross-stream): the UI ask_user defaults agree with the device-side gate (ON), explicit OFF honored", () => {
  // useRelay re-sends ask_user_switch from these prefs on every room entry;
  // an OFF fallback here would mask the device-side default-on fix.
  assert.equal(prefsModel.DEFAULT_PI_PREFS.askUserEnabled, true)
  assert.equal(legacyStyle.ASK_GATE_DEFAULTS.askUserEnabled, true)
  assert.equal(legacyStyle.askGatePrefsOf(null).askUserEnabled, true)
  assert.equal(legacyStyle.askGatePrefsOf("{}").askUserEnabled, true)
  // A stored explicit false still wins in both stores.
  assert.equal(legacyStyle.askGatePrefsOf(JSON.stringify({ askUserEnabled: false })).askUserEnabled, false)
  assert.equal(prefsModel.migratePiPrefs(JSON.stringify({ v: 1, askUserEnabled: false })).askUserEnabled, false)
  assert.equal(prefsModel.migratePiPrefs(null).askUserEnabled, true)
  // The approval gate is untouched: still default OFF.
  assert.equal(legacyStyle.ASK_GATE_DEFAULTS.approvalGateEnabled, false)
  assert.equal(prefsModel.DEFAULT_PI_PREFS.approvalGateEnabled, false)
})

/* --------------------------------------- post-wave micro-fix: identity -- */

test("identity ready state: re-register and forget actions are offered alongside export/import", () => {
  const section = read("ui/src/pi/settings/pages/IdentitySection.tsx")
  // Re-register reuses the enable/registration handler in both states.
  assert.match(section, /phase === "not-registered" \|\| phase === "ready" \? \([\s\S]*?重新登记/)
  // Forget is offered in the ready state too, gated on the bridge capability.
  assert.match(section, /phase === "not-registered" \|\| phase === "waiting-ack" \|\| phase === "ready" \? \([\s\S]*?忘记本机身份/)
  // Forgetting from any state still goes through the shared confirmation
  // panel, whose copy warns that an unbacked-up ACK copy is lost.
  assert.match(section, /data-settings-identity-panel="forget"[\s\S]*?用它加密过的历史将无法再解开[\s\S]*?确认忘记本机身份/)
})

test("inbox surface: every shell routes the inbox view and feeds the sidebar row", () => {
  assert.match(read("ui/src/pi/variants/claude/shell/ClaudeDesktopShell.tsx"), /ClaudeInboxPage/)
  assert.match(read("ui/src/pi/variants/codex/shell/CodexDesktop.tsx"), /CodexInboxPage/)
  assert.match(read("ui/src/pi/variants/claude/shell/ClaudePhoneShell.tsx"), /ClaudeInboxPage/)
  assert.match(read("ui/src/pi/variants/codex/shell/CodexPhone.tsx"), /CodexInboxPage/)
  assert.match(read("ui/src/pi/variants/claude/sidebar/ClaudeUnifiedSidebar.tsx"), /inboxCount/)
  assert.match(read("ui/src/pi/variants/codex/sidebar/CodexUnifiedSidebar.tsx"), /inboxCount/)
  assert.match(read("ui/src/pi/mobile/useMobileSidebarData.ts"), /inboxCount/)
  // Variant self-containment: the shells must not import the Cursor container.
  for (const rel of ["ui/src/pi/variants/claude/shell/ClaudeDesktopShell.tsx", "ui/src/pi/variants/codex/shell/CodexDesktop.tsx"]) {
    assert.doesNotMatch(read(rel), /pi\/containers\/InboxContainer/, rel)
  }
})
