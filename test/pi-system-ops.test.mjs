// System operations (settings > devices): pure availability/copy logic in
// systemOpsLogic.ts plus the wiring of both devices pages. No browser, no
// real device commands -- the logic consumes contract-shaped plain objects.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")
const ops = await import("../ui/src/pi/settings/pages/systemOpsLogic.ts")

const NOW = 1_760_000_000_000

function device(over = {}) {
  return { id: "dev-1", name: "测试设备", platform: "macos", online: true, features: ["device.ops"], ...over }
}

function diag(over = {}) {
  return {
    piVersion: "1.3.0",
    nodeVersion: "v22.23.4",
    platform: "macos",
    arch: "arm64",
    extensionVersion: "4.0.0",
    attachVersion: "4.0.0",
    piInstallMethod: "npm-global",
    supervised: true,
    launchedPiCount: 1,
    operationStatus: ops.IDLE_OPERATION_STATUS,
    ...over,
  }
}

function updateInfo(over = {}) {
  return { currentVersion: "1.3.0", latestVersion: "1.4.2", installMethod: "npm-global", canUpdate: true, checkError: null, ...over }
}

function facts(over = {}) {
  return { device: device(), diag: diag(), update: updateInfo(), updateCheckError: null, busy: { generating: false, pendingDialog: false }, ...over }
}

const rowOf = (rows, kind) => rows.find((row) => row.kind === kind)

test("cap gate: only a roster features entry of device.ops opens the area", () => {
  assert.equal(ops.deviceOpsSupportedOf(device()), true)
  assert.equal(ops.deviceOpsSupportedOf(device({ features: [] })), false)
  assert.equal(ops.deviceOpsSupportedOf(device({ features: undefined })), false)
  assert.equal(ops.deviceOpsSupportedOf(device({ features: ["session.files"] })), false)
})

test("diag normalize: contract fields, attach version shapes, junk falls back to unknown", () => {
  const parsed = ops.systemOpsDiagOf({
    piVersion: "1.3.0",
    nodeVersion: "v22.23.4",
    platform: "macos",
    arch: "arm64",
    extensionVersion: "4.0.0",
    attach: { active: true, deviceId: "dev-1", version: "4.0.0" },
    piInstallMethod: "npm-global",
    supervised: true,
    launchedPiCount: 2,
    operationStatus: { state: "running", kind: "update_pi", phase: "installing", startedAt: NOW - 5000, finishedAt: null, detail: null, error: null },
  })
  assert.equal(parsed.attachVersion, "4.0.0")
  assert.equal(parsed.supervised, true)
  assert.equal(parsed.launchedPiCount, 2)
  assert.equal(parsed.operationStatus.state, "running")
  assert.equal(parsed.operationStatus.kind, "update_pi")

  assert.equal(ops.systemOpsDiagOf({ attach: "4.0.0" }).attachVersion, "4.0.0")
  assert.equal(ops.systemOpsDiagOf({ attachVersion: "4.1.0" }).attachVersion, "4.1.0")

  const bare = ops.systemOpsDiagOf({ piVersion: "1.3.0" })
  assert.equal(bare.attachVersion, "")
  assert.equal(bare.supervised, null)
  assert.equal(bare.launchedPiCount, null)
  assert.deepEqual(bare.operationStatus, ops.IDLE_OPERATION_STATUS)

  assert.equal(ops.systemOpsDiagOf(null), null)
  assert.equal(ops.systemOpsDiagOf("diag"), null)
  assert.deepEqual(ops.normalizeOperationStatus({ state: "bogus" }), ops.IDLE_OPERATION_STATUS)
  assert.deepEqual(ops.normalizeOperationStatus(undefined), ops.IDLE_OPERATION_STATUS)
})

test("update info normalize: passthrough, missing pieces stay unknown", () => {
  const info = ops.normalizePiUpdateInfo({ currentVersion: "1.3.0", latestVersion: null, installMethod: "other", canUpdate: false, checkError: "registry unreachable" })
  assert.deepEqual(info, {
    currentVersion: "1.3.0",
    latestVersion: null,
    installMethod: "other",
    canUpdate: false,
    checkError: "registry unreachable",
    supervised: null,
    launchedPiCount: null,
    attachVersion: "",
  })
  assert.equal(ops.normalizePiUpdateInfo({}), null)
  assert.equal(ops.normalizePiUpdateInfo(null), null)
})

test("update info normalize: attach-side facts ride the same reply", () => {
  const info = ops.normalizePiUpdateInfo({
    currentVersion: "1.3.0",
    latestVersion: "1.4.2",
    installMethod: "npm-global",
    canUpdate: true,
    supervised: false,
    launchedPiCount: 3,
    attachVersion: "4.1.0",
  })
  assert.equal(info.supervised, false)
  assert.equal(info.launchedPiCount, 3)
  assert.equal(info.attachVersion, "4.1.0")
})

test("operation status reply: { operationStatus } parsed, junk yields null for the diag fallback", () => {
  const running = { state: "running", kind: "update_pi", phase: "installing", startedAt: NOW - 1000, finishedAt: null, detail: null, error: null }
  assert.deepEqual(ops.operationStatusReplyOf({ operationStatus: running }), running)
  assert.deepEqual(ops.operationStatusReplyOf({ operationStatus: { state: "bogus" } }), ops.IDLE_OPERATION_STATUS)
  assert.equal(ops.operationStatusReplyOf({}), null)
  assert.equal(ops.operationStatusReplyOf(null), null)
  assert.equal(ops.operationStatusReplyOf("running"), null)
})

test("status merge on open: the fresher of the diag copy and the direct-read copy wins", () => {
  const older = { state: "succeeded", kind: "harness_restart", phase: null, startedAt: NOW - 200_000, finishedAt: NOW - 150_000, detail: "older result", error: null }
  const newer = { state: "succeeded", kind: "update_pi", phase: null, startedAt: NOW - 100_000, finishedAt: NOW - 50_000, detail: "newer result", error: null }

  // Both sides empty: nothing to restore.
  assert.deepEqual(ops.mergedOperationStatusOf(ops.IDLE_OPERATION_STATUS, null), ops.IDLE_OPERATION_STATUS)
  assert.deepEqual(ops.mergedOperationStatusOf(ops.IDLE_OPERATION_STATUS, ops.IDLE_OPERATION_STATUS), ops.IDLE_OPERATION_STATUS)

  // Only one side carries an operation: that side is used. The diag-idle /
  // direct-result pair is the active-session case -- the extension answered
  // get_host_diag without the field, so only the direct read brings the
  // previous operation's result back.
  assert.deepEqual(ops.mergedOperationStatusOf(older, null), older)
  assert.deepEqual(ops.mergedOperationStatusOf(ops.IDLE_OPERATION_STATUS, newer), newer)

  // Both sides carry an operation: the fresher stamp wins, either way round.
  assert.deepEqual(ops.mergedOperationStatusOf(newer, older), newer)
  assert.deepEqual(ops.mergedOperationStatusOf(older, newer), newer)

  // A running status is stamped by its startedAt, so a just-started
  // operation beats an older finished one...
  const running = { state: "running", kind: "restart_host", phase: "restarting", startedAt: NOW - 10_000, finishedAt: null, detail: null, error: null }
  assert.deepEqual(ops.mergedOperationStatusOf(running, newer), running)
  // ...and equal stamps go to the direct read, the dedicated channel.
  const tied = { ...newer, detail: "direct read copy" }
  assert.deepEqual(ops.mergedOperationStatusOf({ ...newer, detail: "diag copy" }, tied), tied)
})

test("availability facts: the update-info reply wins over diag, diag is the fallback", () => {
  // With an active session the extension answers get_host_diag and its shape
  // has no attach fields; stale diag values must not override the attach reply.
  const overridden = ops.operationRowsOf(
    facts({ diag: diag({ supervised: true, launchedPiCount: 2 }), update: updateInfo({ supervised: false, launchedPiCount: 0 }) }),
    ops.IDLE_OPERATION_STATUS,
    NOW,
  )
  assert.equal(rowOf(overridden, "restart_host").buttonEnabled, false)
  assert.match(rowOf(overridden, "restart_host").description, /不是常驻方式启动/)
  assert.equal(rowOf(overridden, "update_components").buttonEnabled, false)
  assert.equal(rowOf(overridden, "harness_restart").buttonEnabled, false)
  assert.match(rowOf(overridden, "harness_restart").description, /不是由 Pi-Remote 拉起/)

  const fallback = ops.operationRowsOf(
    facts({ diag: diag({ supervised: false, launchedPiCount: 0 }), update: updateInfo({ supervised: null, launchedPiCount: null }) }),
    ops.IDLE_OPERATION_STATUS,
    NOW,
  )
  assert.equal(rowOf(fallback, "restart_host").buttonEnabled, false)
  assert.equal(rowOf(fallback, "harness_restart").buttonEnabled, false)

  // Attach version cell prefers the update-info reply over the diag parse.
  const cells = ops.versionCellsOf(diag({ attachVersion: "4.0.0" }), updateInfo({ attachVersion: "4.1.0" }))
  assert.equal(cells[2].value, "4.1.0")
  const cellsFallback = ops.versionCellsOf(diag({ attachVersion: "4.0.0" }), updateInfo({ attachVersion: "" }))
  assert.equal(cellsFallback[2].value, "4.0.0")
})

test("busy: generating and pending dialogs come from the device's online rooms only", () => {
  const rooms = [
    { deviceId: "dev-1", online: true, busy: true },
    { deviceId: "dev-1", online: true, waiting: [{ dialogId: "d1", kind: "ask" }] },
    { deviceId: "dev-2", online: true, busy: true },
    { deviceId: "dev-1", online: false, waitingPrompt: { id: "p1" } },
  ]
  assert.deepEqual(ops.deviceBusyOf(rooms, "dev-1"), { generating: true, pendingDialog: true })
  assert.deepEqual(ops.deviceBusyOf(rooms, "dev-2"), { generating: true, pendingDialog: false })
  assert.deepEqual(ops.deviceBusyOf([], "dev-1"), { generating: false, pendingDialog: false })
  assert.deepEqual(ops.deviceBusyOf([{ deviceId: "dev-1", online: true, waitingPrompt: { id: "p" } }], "dev-1"), {
    generating: false,
    pendingDialog: true,
  })
})

test("version cells: five cells, update tag only when canUpdate, node v-prefix stripped", () => {
  const cells = ops.versionCellsOf(diag(), updateInfo())
  assert.deepEqual(
    cells.map((cell) => cell.label),
    ["Pi 版本", "扩展版本", "Attach 版本", "Node", "平台"],
  )
  assert.equal(cells[0].value, "1.3.0")
  assert.equal(cells[0].tag, "新版 1.4.2")
  assert.equal(cells[3].value, "22.23.4")
  assert.equal(cells[4].value, "macOS · arm64")
  assert.equal(ops.versionCellsOf(diag(), updateInfo({ canUpdate: false }))[0].tag, null)
  assert.equal(ops.versionCellsOf(diag({ piVersion: "" }), null)[0].value, "未提供")
})

test("rows: update available -- primary button names the target; busy device warns in both update and restart rows", () => {
  const rows = ops.operationRowsOf(facts({ busy: { generating: true, pendingDialog: false } }), ops.IDLE_OPERATION_STATUS, NOW)
  const update = rowOf(rows, "update_pi")
  assert.equal(update.buttonLabel, "更新到 1.4.2")
  assert.equal(update.buttonPrimary, true)
  assert.equal(update.buttonEnabled, true)
  assert.match(update.warningText, /正在生成一轮回复/)
  assert.match(update.description, /更新到 1\.4\.2（当前 1\.3\.0）/)
  const restart = rowOf(rows, "harness_restart")
  assert.match(restart.warningText, /现在重启会打断它/)
  assert.match(restart.description, /重启后自动回到当前会话/)
  assert.equal(restart.buttonEnabled, true)
})

test("rows: update unavailable reasons are the row description", () => {
  const latest = rowOf(ops.operationRowsOf(facts({ update: updateInfo({ canUpdate: false }) }), ops.IDLE_OPERATION_STATUS, NOW), "update_pi")
  assert.equal(latest.buttonLabel, "已是最新")
  assert.equal(latest.buttonEnabled, false)
  assert.match(latest.description, /已是最新版本/)

  const other = rowOf(ops.operationRowsOf(facts({ update: updateInfo({ installMethod: "other", canUpdate: false }) }), ops.IDLE_OPERATION_STATUS, NOW), "update_pi")
  assert.equal(other.buttonEnabled, false)
  assert.match(other.description, /不是通过 npm 安装/)

  const unknown = rowOf(ops.operationRowsOf(facts({ update: updateInfo({ installMethod: "unknown", canUpdate: false }) }), ops.IDLE_OPERATION_STATUS, NOW), "update_pi")
  assert.match(unknown.description, /无法确认这台设备上 Pi 的安装方式/)

  const checkFailed = rowOf(
    ops.operationRowsOf(facts({ update: updateInfo({ latestVersion: null, canUpdate: false, checkError: "registry unreachable" }) }), ops.IDLE_OPERATION_STATUS, NOW),
    "update_pi",
  )
  assert.equal(checkFailed.buttonLabel, "重新检查")
  assert.equal(checkFailed.buttonAction, "recheck")
  assert.equal(checkFailed.buttonEnabled, true)
  assert.match(checkFailed.description, /registry unreachable/)

  const commandFailed = rowOf(ops.operationRowsOf(facts({ update: null, updateCheckError: "设备没有回应：请重试" }), ops.IDLE_OPERATION_STATUS, NOW), "update_pi")
  assert.equal(commandFailed.buttonAction, "recheck")
  assert.match(commandFailed.description, /无法检查更新/)
})

test("rows: restart Pi needs a launched pi; unknown count stays available", () => {
  const none = rowOf(ops.operationRowsOf(facts({ diag: diag({ launchedPiCount: 0 }) }), ops.IDLE_OPERATION_STATUS, NOW), "harness_restart")
  assert.equal(none.buttonEnabled, false)
  assert.match(none.description, /不是由 Pi-Remote 拉起/)
  const unknown = rowOf(ops.operationRowsOf(facts({ diag: diag({ launchedPiCount: null }) }), ops.IDLE_OPERATION_STATUS, NOW), "harness_restart")
  assert.equal(unknown.buttonEnabled, true)
})

test("rows: host restart and component update need a supervised attach", () => {
  const unsupervised = ops.operationRowsOf(facts({ diag: diag({ supervised: false }) }), ops.IDLE_OPERATION_STATUS, NOW)
  assert.equal(rowOf(unsupervised, "restart_host").buttonEnabled, false)
  assert.match(rowOf(unsupervised, "restart_host").description, /不是常驻方式启动/)
  assert.equal(rowOf(unsupervised, "update_components").buttonEnabled, false)
  assert.match(rowOf(unsupervised, "update_components").description, /不是常驻方式启动/)
  const unknown = ops.operationRowsOf(facts({ diag: diag({ supervised: null }) }), ops.IDLE_OPERATION_STATUS, NOW)
  assert.equal(rowOf(unknown, "restart_host").buttonEnabled, false)
  assert.match(rowOf(unknown, "restart_host").description, /未提供启动方式信息/)
  const supervised = ops.operationRowsOf(facts(), ops.IDLE_OPERATION_STATUS, NOW)
  assert.equal(rowOf(supervised, "restart_host").buttonEnabled, true)
  assert.equal(rowOf(supervised, "update_components").buttonEnabled, true)
})

test("rows: a running operation turns its row into the progress row and disables the others", () => {
  const status = { state: "running", kind: "update_pi", phase: "installing", startedAt: NOW - 24_000, finishedAt: null, detail: null, error: null }
  const rows = ops.operationRowsOf(facts(), status, NOW)
  const running = rowOf(rows, "update_pi")
  assert.equal(running.phaseText, "正在安装 1.4.2")
  assert.match(running.description, /^已用时 24 秒。/)
  assert.equal(running.buttonLabel, null)
  for (const kind of ["harness_restart", "restart_host", "update_components"]) {
    assert.equal(rowOf(rows, kind).buttonEnabled, false, `${kind} disabled while update runs`)
  }
})

test("rows: the failed operation carries the raw error and a retry", () => {
  const status = {
    state: "failed",
    kind: "update_components",
    phase: "verifying",
    startedAt: NOW - 90_000,
    finishedAt: NOW - 60_000,
    detail: null,
    error: "sha256 mismatch: expected 9f2c, got 77d0",
  }
  const rows = ops.operationRowsOf(facts(), status, NOW)
  const failed = rowOf(rows, "update_components")
  assert.equal(failed.title, "更新设备端组件 — 失败")
  assert.equal(failed.failed, true)
  assert.equal(failed.errorText, "sha256 mismatch: expected 9f2c, got 77d0")
  assert.equal(failed.buttonLabel, "重试")
  assert.equal(failed.buttonAction, "retry")
  assert.equal(failed.buttonEnabled, true)
  assert.equal(rowOf(rows, "harness_restart").buttonEnabled, true)
})

test("result row: succeeded status renders title + finished time + attach detail", () => {
  const status = { state: "succeeded", kind: "harness_restart", phase: null, startedAt: NOW - 200_000, finishedAt: NOW - 120_000, detail: "Pi 1.4.2 已在运行，会话已恢复", error: null }
  const result = ops.operationResultOf(status, NOW)
  assert.equal(result.title, "Pi 已重启")
  assert.match(result.text, /^2 分钟前完成 · Pi 1\.4\.2 已在运行/)
  assert.equal(ops.operationResultOf(ops.IDLE_OPERATION_STATUS, NOW), null)
  assert.equal(ops.operationResultOf({ ...status, state: "failed" }, NOW), null)
})

test("phase and elapsed text", () => {
  assert.equal(ops.operationPhaseTextOf({ state: "running", kind: "update_components", phase: "downloading", startedAt: NOW, finishedAt: null, detail: null, error: null }, null), "正在下载设备包")
  assert.equal(ops.operationPhaseTextOf({ state: "running", kind: "restart_host", phase: null, startedAt: NOW, finishedAt: null, detail: null, error: null }, null), "正在重启设备端")
  assert.equal(ops.operationElapsedTextOf(NOW - 24_000, NOW), "已用时 24 秒")
  assert.equal(ops.operationElapsedTextOf(NOW - 125_000, NOW), "已用时 2 分 05 秒")
  assert.equal(ops.operationStartedStatusOf("update_pi", NOW).phase, "checking")
  assert.equal(ops.operationStartedStatusOf("restart_host", NOW).state, "running")
})

test("confirm copy: busy facts are stated, idle facts stay plain", () => {
  const busy = ops.operationConfirmOf("harness_restart", { deviceName: "AdeMacBook-Pro", busy: { generating: true, pendingDialog: true }, update: updateInfo() })
  assert.equal(busy.title, "重启这台设备的 Pi？")
  assert.match(busy.body, /正在生成一轮回复，重启会打断这一轮/)
  assert.match(busy.body, /尚未回答的提问会随之失效/)
  assert.match(busy.body, /会话记录不会丢失/)
  assert.equal(busy.confirmLabel, "重启 Pi")

  const idle = ops.operationConfirmOf("harness_restart", { deviceName: "AdeMacBook-Pro", busy: { generating: false, pendingDialog: false }, update: updateInfo() })
  assert.doesNotMatch(idle.body, /打断/)
  assert.match(idle.body, /会结束并重新启动/)

  const update = ops.operationConfirmOf("update_pi", { deviceName: "AdeMacBook-Pro", busy: { generating: false, pendingDialog: false }, update: updateInfo() })
  assert.match(update.body, /从 1\.3\.0 更新到 1\.4\.2/)
  assert.match(update.body, /安装失败时现有 Pi 不受影响/)
  assert.equal(update.confirmLabel, "更新到 1.4.2")

  const components = ops.operationConfirmOf("update_components", { deviceName: "AdeMacBook-Pro", busy: { generating: false, pendingDialog: false }, update: null })
  assert.match(components.body, /校验或替换失败时自动恢复原文件/)
})

test("command error text: contract codes mapped, others fall back to the device error text", () => {
  assert.equal(ops.operationErrorTextOf({ code: "no_launched_pi" }), "这台设备上没有由 Pi-Remote 拉起的 Pi")
  assert.equal(ops.operationErrorTextOf({ code: "update_check_failed" }), "检查更新失败，无法连接 npm 注册表")
  assert.equal(ops.operationErrorTextOf({ code: "not_supervised" }), "设备端不是常驻方式启动，无法远程执行此操作")
  assert.equal(ops.operationErrorTextOf({ code: "operation_in_progress" }), "这台设备已有操作在进行中")
  assert.equal(ops.operationErrorTextOf(new Error("原始错误")), "原始错误")
  // Command rejections arrive as Error objects carrying a code (RelayError shape).
  const coded = new Error("服务端原文")
  coded.code = "mystery"
  assert.equal(ops.operationErrorTextOf(coded), "服务端原文")
})

test("wiring: both devices pages mount the ops UI, commands and polling follow the contract", () => {
  const desktop = read("ui/src/pi/settings/pages/DevicesPage.tsx")
  assert.match(desktop, /DeviceSystemOps/)
  assert.match(desktop, />\s*系统操作\s*</)
  const panel = read("ui/src/pi/settings/pages/DeviceSystemOps.tsx")
  assert.match(panel, /deviceOpsSupportedOf/)
  assert.match(panel, /viewport="desktop"/)
  const mobile = read("ui/src/pi/settings/mobile/pages/DevicesPage.tsx")
  assert.match(mobile, /MobileSystemOpsPage/)
  const mobileOps = read("ui/src/pi/settings/mobile/pages/SystemOpsPage.tsx")
  assert.match(mobileOps, /viewport="phone"/)
  const hook = read("ui/src/pi/settings/pages/useSystemOps.ts")
  assert.match(hook, /get_pi_update_info/)
  assert.match(hook, /get_host_diag/)
  assert.match(hook, /get_operation_status/)
  assert.match(hook, /mergedOperationStatusOf/)
  assert.match(hook, /POLL_MS = 2000/)
})
