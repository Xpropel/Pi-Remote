"use strict";
/**
 * Phase 4 slice T-1 (honest plaintext labels, phase-4 design section 2.5):
 * the relay derives `encReason` for room_list entries from facts it already
 * holds (enc meta / device roster / account ackFp consensus), and the field
 * rides the same crypto.content cap gate as `enc` in roomsViewFor.
 *
 * Derivation contract under test:
 *   sealed       -- the room carries enc meta;
 *   host_keyless -- host on the roster without a registered identity key;
 *   awaiting_key -- host keyed + the account is known to have an ACK (live
 *                   consensus via ackFpLookup, or a sealed room's meta);
 *   orphan       -- host not on the roster, or offline beyond
 *                   cfg.cryptoOrphanDays (default 30);
 *   (omitted)    -- keyed host but no account ACK evidence: undetermined,
 *                   the UI keeps its legacy fallback label.
 * "no_source" is not derivable in T-1 (it arrives with the T-2 backlog
 * report frame) and is intentionally not asserted anywhere here.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { Rooms, roomsViewFor } = require("../relay/rooms.js");
const { UNREGISTERED_DEVICE } = require("../relay/devices.js");

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

/** Rooms with a fake transcript store (encInfo map) and an injectable roster. */
function makeRooms({ encMetas = {}, devices = [], ackFp = null, cfg = {} } = {}) {
  const rooms = new Rooms({ roomIdleEvictMs: 10 * 60_000, snapshotCacheTtlMs: 5_000, ...cfg });
  rooms.bindStore({
    encInfo(id) {
      return Object.prototype.hasOwnProperty.call(encMetas, id) ? encMetas[id] : null;
    },
  });
  rooms.deviceSnapshot = () => devices;
  rooms.ackFpLookup = () => ackFp;
  return rooms;
}

function addRoom(rooms, id, { deviceId = null, online = true, lastActivity = NOW } = {}) {
  const r = rooms.get(id);
  if (deviceId) r.deviceId = deviceId;
  r.online = online;
  r.lastActivity = lastActivity;
  return r;
}

function entryOf(rooms, id) {
  return rooms.list().find((e) => e.id === id);
}

test("T-1 derivation: sealed room reports sealed regardless of host state", () => {
  const rooms = makeRooms({ encMetas: { r1: { enc: 1, ackFp: "0123456789abcdef" } } });
  addRoom(rooms, "r1", { deviceId: "ghost" });
  const entry = entryOf(rooms, "r1");
  assert.equal(entry.enc, 1);
  assert.equal(entry.encReason, "sealed");
});

test("T-1 derivation: token-device room (host keyed-less on roster) is host_keyless", () => {
  const rooms = makeRooms({ devices: [{ id: "d1", online: true, lastAttachAt: NOW }] });
  addRoom(rooms, "r1", { deviceId: "d1" });
  const entry = entryOf(rooms, "r1");
  assert.equal(entry.enc, 0);
  assert.equal(entry.encReason, "host_keyless");
});

test("T-1 derivation: keyed host + live ackFp consensus is awaiting_key", () => {
  const rooms = makeRooms({
    devices: [{ id: "d1", online: true, lastAttachAt: NOW, keyFp: "fp1" }],
    ackFp: "0123456789abcdef",
  });
  addRoom(rooms, "r1", { deviceId: "d1" });
  assert.equal(entryOf(rooms, "r1").encReason, "awaiting_key");
});

test("T-1 derivation: keyed host + sealed-room meta on the account is awaiting_key (no live consensus)", () => {
  const rooms = makeRooms({
    encMetas: { sealed1: { enc: 1, ackFp: "0123456789abcdef" } },
    devices: [{ id: "d1", online: true, lastAttachAt: NOW, keyFp: "fp1" }],
    ackFp: null,
  });
  addRoom(rooms, "sealed1", { deviceId: "d1" });
  addRoom(rooms, "plain1", { deviceId: "d1" });
  assert.equal(entryOf(rooms, "plain1").encReason, "awaiting_key");
});

test("T-1 derivation: keyed host with no account ACK evidence omits encReason", () => {
  const rooms = makeRooms({
    devices: [{ id: "d1", online: true, lastAttachAt: NOW, keyFp: "fp1" }],
    ackFp: null,
  });
  addRoom(rooms, "r1", { deviceId: "d1" });
  const entry = entryOf(rooms, "r1");
  assert.equal(entry.enc, 0);
  assert.ok(!("encReason" in entry), "undetermined class must omit the field, not guess");
});

test("T-1 derivation: host missing from the roster is orphan", () => {
  const rooms = makeRooms({ devices: [] });
  addRoom(rooms, "r1", { deviceId: "gone-device" });
  assert.equal(entryOf(rooms, "r1").encReason, "orphan");
});

test("T-1 derivation: host offline beyond cryptoOrphanDays is orphan; inside the window it is not", () => {
  const devices = [{ id: "d1", online: false, lastAttachAt: NOW - 31 * DAY, keyFp: "fp1" }];
  const rooms = makeRooms({ devices, ackFp: "0123456789abcdef" });
  addRoom(rooms, "r1", { deviceId: "d1", online: false });
  assert.equal(entryOf(rooms, "r1").encReason, "orphan", "31 days offline crosses the default 30-day threshold");

  const freshDevices = [{ id: "d1", online: false, lastAttachAt: NOW - 10 * DAY, keyFp: "fp1" }];
  const rooms2 = makeRooms({ devices: freshDevices, ackFp: "0123456789abcdef" });
  addRoom(rooms2, "r1", { deviceId: "d1", online: false });
  assert.equal(entryOf(rooms2, "r1").encReason, "awaiting_key", "10 days offline stays backlog, not orphan");
});

test("T-1 derivation: an online host is never stale-orphaned, however old lastAttachAt looks", () => {
  const rooms = makeRooms({
    devices: [{ id: "d1", online: true, lastAttachAt: NOW - 90 * DAY, keyFp: "fp1" }],
    ackFp: "0123456789abcdef",
  });
  addRoom(rooms, "r1", { deviceId: "d1", online: true });
  assert.equal(entryOf(rooms, "r1").encReason, "awaiting_key");
});

test("T-1 derivation: cfg.cryptoOrphanDays overrides the 30-day default", () => {
  const rooms = makeRooms({
    devices: [{ id: "d1", online: false, lastAttachAt: NOW - 10 * DAY }],
    cfg: { cryptoOrphanDays: 7 },
  });
  addRoom(rooms, "r1", { deviceId: "d1", online: false });
  assert.equal(entryOf(rooms, "r1").encReason, "orphan");
});

test("T-1 derivation: legacy room without a device id lands on the unregistered pseudo-host (keyless)", () => {
  const rooms = makeRooms({ devices: [{ id: UNREGISTERED_DEVICE, online: true }] });
  addRoom(rooms, "r1", { deviceId: null, online: true });
  const entry = entryOf(rooms, "r1");
  assert.equal(entry.deviceId, UNREGISTERED_DEVICE);
  assert.equal(entry.encReason, "host_keyless");
});

test("T-1 view gate: encReason is stripped without crypto.content and kept with it", () => {
  const entry = { id: "r1", enc: 0, encReason: "orphan", label: null };
  const legacy = { _state: { caps: new Set(["room.attention", "room.dialogs", "dialog.respond", "room.activity", "room.schedule"]) } };
  const [stripped] = roomsViewFor(legacy, [entry]);
  assert.ok(!("enc" in stripped) && !("encReason" in stripped), "no crypto.content: neither field may leak");
  assert.ok("encReason" in entry, "the view must not mutate the raw entry");

  const modern = { _state: { caps: new Set(["crypto.content"]) } };
  const [kept] = roomsViewFor(modern, [entry]);
  assert.equal(kept.enc, 0);
  assert.equal(kept.encReason, "orphan");
});
