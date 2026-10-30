// Phase 4 slice T-1 (honest plaintext labels, phase-4 design section 2.5),
// UI side: the wire encReason is parsed strictly (unknown values dropped,
// never guessed), the session-row badge names the reason with the design's
// verbatim copy, and the settings plaintext list groups rooms by class with
// the design-bound actions. Pure functions are imported from the .ts
// sources, matching the repo's node --test convention.
import test from "node:test"
import assert from "node:assert/strict"

const devices = await import("../ui/src/relay/devices.ts")
const devicesLogic = await import("../ui/src/pi/settings/pages/devicesLogic.ts")

const { parseRooms, parseEncReason, encBadgeLabelOf, ENC_REASON_LABELS, ENC_FALLBACK_LABEL, mergeDeviceSessions } = devices
const { plaintextRoomGroupsOf, plaintextRoomTitleOf, PLAINTEXT_ACTION_LABELS } = devicesLogic

test("T-1 parse: encReason survives parseRooms only for known classes", () => {
  const [known] = parseRooms([{ id: "r1", enc: 0, encReason: "awaiting_key" }])
  assert.equal(known.enc, false)
  assert.equal(known.encReason, "awaiting_key")

  const [unknown] = parseRooms([{ id: "r2", enc: 0, encReason: "bogus_class" }])
  assert.equal(unknown.enc, false)
  assert.ok(!("encReason" in unknown), "an unknown class must be dropped, not passed through")

  const [absent] = parseRooms([{ id: "r3", enc: 0 }])
  assert.ok(!("encReason" in absent), "an old relay's silence stays silence")

  assert.equal(parseEncReason("orphan"), "orphan")
  assert.equal(parseEncReason("no_source"), "no_source")
  assert.equal(parseEncReason(""), undefined)
  assert.equal(parseEncReason(3), undefined)
  assert.equal(parseEncReason(undefined), undefined)
})

test("T-1 parse: ListedSession rows inherit encReason from their backing room", () => {
  const device = {
    id: "d1", accountId: "a", name: "dev", platform: "linux", online: true, projects: [], browseRoots: [],
    lastAttachAt: null, firstSeenAt: null, windowExpiresAt: null, auth: null, paired: true, latencyMs: null,
  }
  const room = {
    id: "r1", label: null, cwd: "/work", online: true, busy: false, viewers: 0, lastActivity: 5,
    deviceId: "d1", enc: false, encReason: "host_keyless",
  }
  const [row] = mergeDeviceSessions(device, [room], [])
  assert.equal(row.enc, false)
  assert.equal(row.encReason, "host_keyless")
})

test("T-1 labels: badge copy matches the design's state table verbatim", () => {
  assert.equal(ENC_REASON_LABELS.sealed, "已加密")
  assert.equal(ENC_REASON_LABELS.host_keyless, "未加密（设备未启用密钥）")
  assert.equal(ENC_REASON_LABELS.awaiting_key, "未加密（等内容钥/待迁移）")
  assert.equal(ENC_REASON_LABELS.no_source, "未加密（本机历史缺失）")
  assert.equal(ENC_REASON_LABELS.orphan, "未加密（设备已离线）")
  assert.equal(ENC_FALLBACK_LABEL, "未加密（旧设备）")

  assert.equal(encBadgeLabelOf(undefined, undefined), null, "relay never said: no badge")
  assert.equal(encBadgeLabelOf(undefined, "orphan"), null, "a reason without an enc statement still shows no badge")
  assert.equal(encBadgeLabelOf(true, "sealed"), "已加密")
  assert.equal(encBadgeLabelOf(true, undefined), "已加密")
  assert.equal(encBadgeLabelOf(false, "host_keyless"), "未加密（设备未启用密钥）")
  assert.equal(encBadgeLabelOf(false, "awaiting_key"), "未加密（等内容钥/待迁移）")
  assert.equal(encBadgeLabelOf(false, "no_source"), "未加密（本机历史缺失）")
  assert.equal(encBadgeLabelOf(false, "orphan"), "未加密（设备已离线）")
  assert.equal(encBadgeLabelOf(false, undefined), "未加密（旧设备）", "undetermined plaintext keeps the legacy label")
  assert.equal(encBadgeLabelOf(false, "sealed"), "未加密（旧设备）", "sealed on a plaintext room is a contradiction: fall back")
})

test("T-1 groups: plaintext rooms group by class in design order with bound actions", () => {
  const rooms = [
    { id: "enc1", enc: true, encReason: "sealed" },
    { id: "silent", enc: undefined },
    { id: "orphan1", enc: false, encReason: "orphan", deviceId: "gone" },
    { id: "keyless1", enc: false, encReason: "host_keyless", deviceId: "d1" },
    { id: "plain-old", enc: false },
    { id: "backlog1", enc: false, encReason: "awaiting_key", deviceId: "d2" },
    { id: "nosrc1", enc: false, encReason: "no_source", deviceId: "d2" },
    { id: "contra", enc: false, encReason: "sealed" },
  ]
  const groups = plaintextRoomGroupsOf(rooms)
  assert.deepEqual(groups.map((g) => g.key), ["host_keyless", "awaiting_key", "no_source", "orphan", "unknown"])
  assert.deepEqual(groups.map((g) => g.action), ["upgrade_device", "view_backlog", "orphan_disposal", "orphan_disposal", null])
  assert.deepEqual(groups[4].rooms.map((r) => r.id), ["plain-old", "contra"], "missing or contradictory reasons land in the undetermined group")
  assert.ok(!groups.some((g) => g.rooms.some((r) => r.id === "enc1" || r.id === "silent")), "sealed and unstated rooms are never listed as plaintext")

  assert.equal(PLAINTEXT_ACTION_LABELS.upgrade_device, "去升级这台设备")
  assert.equal(PLAINTEXT_ACTION_LABELS.view_backlog, "查看迁移积压")
  assert.equal(PLAINTEXT_ACTION_LABELS.orphan_disposal, "按孤儿房处置")

  assert.deepEqual(plaintextRoomGroupsOf([]), [])
  assert.deepEqual(plaintextRoomGroupsOf(undefined), [])
})

test("T-1 groups: row titles fall back name > first message > label > folder > short id", () => {
  assert.equal(plaintextRoomTitleOf({ id: "abcdef123456", name: "命名会话", firstMessage: "x" }), "命名会话")
  assert.equal(plaintextRoomTitleOf({ id: "abcdef123456", firstMessage: "第一条消息" }), "第一条消息")
  assert.equal(plaintextRoomTitleOf({ id: "abcdef123456", label: "标签" }), "标签")
  assert.equal(plaintextRoomTitleOf({ id: "abcdef123456", cwd: "/home/dev/proj" }), "proj")
  assert.equal(plaintextRoomTitleOf({ id: "abcdef123456", cwd: "C:\\work\\proj" }), "proj")
  assert.equal(plaintextRoomTitleOf({ id: "abcdef123456" }), "abcdef12")
})
