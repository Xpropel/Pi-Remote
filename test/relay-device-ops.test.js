"use strict";
// System operations (device.ops), relay side: command whitelist + timeout
// tiers, routing to the device connection (attach) with or without an active
// session, and the attach-cap -> roster features passthrough the UI gates on.
// Real startRelay + ws fakes; the fake attach only records and replies.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { startRelay } = require("../relay/server.js");
const { DEVICE_COMMANDS, READONLY_DEVICE_COMMANDS, DEVICE_OPERATION_COMMANDS, commandTimeoutMs } = require("../relay/commands");
const { RELAY_CAPS } = require("../relay/wire");
const PROTOCOL = require("../relay/protocol.json");

const LOCAL_TOKEN = "local-token-0123456789abcdef";
const VIEWER_TOKEN = "viewer-token-0123456789abcde";
const ADMIN_TOKEN = "admin-token-0123456789abcdef0";

const MUTATING_OPS = ["harness_restart", "update_pi", "restart_host", "update_components"];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-relay-"));
}

function boot(dataDir = tmpDir()) {
  return startRelay({
    localPort: 0,
    viewerPort: 0,
    dataDir,
    quiet: true,
    exitOnListenError: false,
    localToken: LOCAL_TOKEN,
    viewerToken: VIEWER_TOKEN,
    adminToken: ADMIN_TOKEN,
    flushIntervalMs: 10,
    perMessageDeflate: false,
    persistTranscripts: true,
  });
}

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const frames = [];
  const waiters = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    frames.push(msg);
    for (const w of [...waiters]) {
      if (!w.pred(msg)) continue;
      msg.__taken = true;
      waiters.splice(waiters.indexOf(w), 1);
      clearTimeout(w.timer);
      w.resolve(msg);
      break;
    }
  });
  const api = {
    ws,
    frames,
    opened: new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }),
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    wait(pred, ms = 3000, what = "frame") {
      const hit = frames.find((f) => !f.__taken && pred(f));
      if (hit) {
        hit.__taken = true;
        return Promise.resolve(hit);
      }
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`timed out waiting for ${what}; got: ${frames.map((f) => f.type).join(",")}`));
        }, ms) };
        waiters.push(w);
      });
    },
    type(type, extra = () => true, ms) {
      return api.wait((f) => f.type === type && extra(f), ms, type);
    },
    close() {
      ws.terminate();
    },
  };
  return api;
}

/** Fake attach window: auth with the given caps, then register the device.
 *  Resolves once the registration room_list comes back (the sync point the
 *  existing relay tests use). */
async function attachWindow(relay, device, caps) {
  const w = client(relay.localPort);
  await w.opened;
  w.send({
    type: "auth", role: "local", token: LOCAL_TOKEN, proto: 4, caps,
    client: { kind: "attach", version: "4.0.0", platform: device.platform || "macos" },
  });
  await w.type("auth_result");
  w.send({ type: "device_register", device });
  await w.wait((f) => f.type === "room_list", 3000, "room_list after device_register");
  return w;
}

/** Fake extension: one socket registering one room bound to the device. */
async function extensionRoom(relay, roomId, deviceId) {
  const c = client(relay.localPort);
  await c.opened;
  c.send({ type: "auth", role: "local", token: LOCAL_TOKEN, proto: 4, caps: ["err.v4"], client: { kind: "extension", version: "4.0.0", platform: "macos" } });
  await c.type("auth_result");
  c.send({ type: "room_register", room: { id: roomId, label: roomId, cwd: "/tmp", epoch: 1, instance: "inst-" + roomId, deviceId } });
  await c.type("room_registered");
  return c;
}

async function viewer(relay) {
  const v = client(relay.viewerPort);
  await v.opened;
  v.send({ type: "auth", role: "viewer", token: VIEWER_TOKEN, proto: 4, caps: ["err.v4"] });
  const auth = await v.type("auth_result");
  assert.equal(auth.ok, true);
  return { v, auth };
}

const deviceOf = (id) => ({ id, name: "Mac " + id, platform: "macos", projects: ["/tmp"], windowExpiresAt: Date.now() + 3600_000 });

test("device.ops registration: whitelist membership, read-only split, timeout tiers, caps", () => {
  assert.deepEqual([...DEVICE_OPERATION_COMMANDS].sort(), [...MUTATING_OPS].sort(), "DEVICE_OPERATION_COMMANDS is exactly the four mutating ops");
  for (const command of [...MUTATING_OPS, "get_pi_update_info", "get_operation_status"]) {
    assert.ok(DEVICE_COMMANDS.has(command), command + " must be in the device command whitelist");
  }
  assert.ok(READONLY_DEVICE_COMMANDS.has("get_pi_update_info"), "get_pi_update_info is a read-only member of the ops group");
  assert.ok(READONLY_DEVICE_COMMANDS.has("get_operation_status"), "get_operation_status is a read-only member of the ops group");
  assert.equal(commandTimeoutMs("get_operation_status", {}), 10000, "the operation status read is a local attach answer: 10s");
  for (const command of MUTATING_OPS) {
    assert.ok(!READONLY_DEVICE_COMMANDS.has(command), command + " mutates device state and must not be read-only");
  }
  for (const command of READONLY_DEVICE_COMMANDS) {
    assert.ok(DEVICE_COMMANDS.has(command), "read-only set stays a subset of the whitelist: " + command);
  }
  assert.equal(commandTimeoutMs("get_pi_update_info", {}), 20000, "registry check from the device side gets 20s");
  for (const command of MUTATING_OPS) {
    assert.equal(commandTimeoutMs(command, {}), 15000, command + " only waits for the acceptance reply: 15s");
  }
  assert.ok(typeof PROTOCOL.caps["device.ops"] === "string" && PROTOCOL.caps["device.ops"], "cap registered in protocol/v4.json");
  assert.ok(RELAY_CAPS.includes("device.ops"), "relay advertises device.ops (its routing/whitelist/timeouts are implemented)");
});

test("device.ops routing without an active session: the whole group reaches attach", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const DEV = "dev-ops-nosession";
  const win = await attachWindow(relay, deviceOf(DEV), ["err.v4", "device.ops"]);
  t.after(() => win.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());

  // Read-only member: 20s tier, no room on either leg, data passes through.
  v.send({ type: "command", id: "u1", deviceId: DEV, command: "get_pi_update_info", args: {} });
  const infoAccepted = await v.type("command_accepted", (f) => f.id === "u1");
  assert.equal(infoAccepted.timeoutMs, 20000);
  assert.equal("room" in infoAccepted, false, "device-addressed ops carry no room");
  const infoForwarded = await win.type("command", (f) => f.command === "get_pi_update_info");
  assert.equal("room" in infoForwarded, false, "forwarded frame carries no room");
  assert.equal(infoForwarded.deviceId, DEV);
  const infoData = { currentVersion: "1.3.0", latestVersion: "1.4.2", installMethod: "npm-global", canUpdate: true };
  win.send({ type: "command_result", id: infoForwarded.id, ok: true, data: infoData });
  const infoAck = await v.type("ack", (f) => f.id === "u1");
  assert.equal(infoAck.ok, true);
  assert.deepEqual(infoAck.data, infoData);

  // Status member: same direct-to-attach route at the 10s tier; the UI polls
  // this instead of get_host_diag so progress reads never land on the extension.
  v.send({ type: "command", id: "u2", deviceId: DEV, command: "get_operation_status", args: {} });
  const statusAccepted = await v.type("command_accepted", (f) => f.id === "u2");
  assert.equal(statusAccepted.timeoutMs, 10000);
  assert.equal("room" in statusAccepted, false, "device-addressed status reads carry no room");
  const statusForwarded = await win.type("command", (f) => f.command === "get_operation_status");
  assert.equal("room" in statusForwarded, false, "forwarded frame carries no room");
  const statusData = { operationStatus: { state: "running", kind: "update_pi", phase: "installing", startedAt: 123, finishedAt: null, detail: null, error: null } };
  win.send({ type: "command_result", id: statusForwarded.id, ok: true, data: statusData });
  const statusAck = await v.type("ack", (f) => f.id === "u2");
  assert.equal(statusAck.ok, true);
  assert.deepEqual(statusAck.data, statusData);

  // Mutating members: without this routing they would die with
  // device_no_active_session; instead each reaches attach at the 15s tier and
  // the fire-and-track acceptance reply passes through untouched.
  for (const [index, command] of MUTATING_OPS.entries()) {
    const id = "op" + index;
    v.send({ type: "command", id, deviceId: DEV, command, args: {} });
    const accepted = await v.type("command_accepted", (f) => f.id === id);
    assert.equal(accepted.timeoutMs, 15000, command);
    const forwarded = await win.type("command", (f) => f.command === command);
    assert.equal("room" in forwarded, false, command + " forwarded without a room");
    win.send({ type: "command_result", id: forwarded.id, ok: true, data: { accepted: true, operationId: "op-" + index } });
    const ack = await v.type("ack", (f) => f.id === id);
    assert.equal(ack.ok, true, command);
    assert.deepEqual(ack.data, { accepted: true, operationId: "op-" + index }, command);
  }

  // An attach-side validation error passes through with its code intact.
  v.send({ type: "command", id: "opx", deviceId: DEV, command: "update_pi", args: {} });
  await v.type("command_accepted", (f) => f.id === "opx");
  const deniedForwarded = await win.type("command", (f) => f.command === "update_pi");
  win.send({ type: "command_result", id: deniedForwarded.id, ok: false, error: "pi is not an npm global install", code: "unsupported_install_method" });
  const deniedAck = await v.type("ack", (f) => f.id === "opx");
  assert.equal(deniedAck.ok, false);
  assert.equal(deniedAck.code, "unsupported_install_method");
});

test("device.ops routing with an active session: still attach, never the room", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const DEV = "dev-ops-session";
  const win = await attachWindow(relay, deviceOf(DEV), ["err.v4", "device.ops"]);
  t.after(() => win.close());
  const ext = await extensionRoom(relay, "room-ops-session", DEV);
  t.after(() => ext.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());

  v.send({ type: "command", id: "r1", deviceId: DEV, command: "harness_restart", args: {} });
  await v.type("command_accepted", (f) => f.id === "r1");
  const forwarded = await win.type("command", (f) => f.command === "harness_restart");
  win.send({ type: "command_result", id: forwarded.id, ok: true, data: { accepted: true, operationId: "op-r1" } });
  const ack = await v.type("ack", (f) => f.id === "r1");
  assert.equal(ack.ok, true);

  // The status read takes the same direct route with a session live: the
  // extension's get_host_diag shape has no attach-side fields, so this read
  // must not fall into the room either.
  v.send({ type: "command", id: "r2", deviceId: DEV, command: "get_operation_status", args: {} });
  await v.type("command_accepted", (f) => f.id === "r2");
  const statusForwarded = await win.type("command", (f) => f.command === "get_operation_status");
  win.send({ type: "command_result", id: statusForwarded.id, ok: true, data: { operationStatus: { state: "idle", kind: null, phase: null, startedAt: null, finishedAt: null, detail: null, error: null } } });
  const statusAck = await v.type("ack", (f) => f.id === "r2");
  assert.equal(statusAck.ok, true);
  // Give a wrongly-routed copy a chance to arrive, then prove the extension
  // connection never saw the operation.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(ext.frames.some((f) => f.type === "command"), false, "extension room connection must not receive device operations");
});

test("device.ops cap passthrough: roster features carry the cap only when attach declares it", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const withOps = await attachWindow(relay, deviceOf("dev-with-ops"), ["err.v4", "device.ops", "fs.browse"]);
  t.after(() => withOps.close());
  const withoutOps = await attachWindow(relay, deviceOf("dev-without-ops"), ["err.v4", "fs.browse"]);
  t.after(() => withoutOps.close());

  const { auth } = await viewer(relay);
  const opsEntry = auth.devices.find((entry) => entry.id === "dev-with-ops");
  const plainEntry = auth.devices.find((entry) => entry.id === "dev-without-ops");
  assert.ok(opsEntry && plainEntry, "both devices are on the roster");
  assert.ok(opsEntry.features.includes("device.ops"), "declaring attach surfaces device.ops in features");
  assert.ok(opsEntry.features.includes("fs.browse"), "existing features passthrough is unchanged");
  assert.ok(!plainEntry.features.includes("device.ops"), "non-declaring attach does not gain the cap");
  assert.ok(plainEntry.features.includes("fs.browse"));
});
