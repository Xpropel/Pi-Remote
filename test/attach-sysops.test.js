// System operations (attach side): operation state machine, validation error
// codes, pi install detection, supervised self-restart, component update.
// Every external effect is injected (registry, downloads, npm, signals), so
// no test here touches the real npm / GitHub / a real pi process.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const attach = require("../deploy/attach.cjs");

// Keep the session root in a sandbox, like attach.test.js does.
const SHARED_SESSION_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sysops-session-root-"));
process.env.PI_CODING_AGENT_SESSION_DIR = SHARED_SESSION_ROOT;
process.on("exit", () => {
  try {
    fs.rmSync(SHARED_SESSION_ROOT, { recursive: true, force: true });
  } catch {}
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-sysops-"));
}

async function waitFor(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor timed out");
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/** Windows-platform controller with a stubbed pi detection; ops IO is injected per test. */
function makeCtl(extra = {}) {
  const dir = tmpDir();
  const frames = [];
  const exits = [];
  const ctl = new attach.AttachController({
    platform: "win32",
    relay: "ws://127.0.0.1:7001",
    deviceId: "dev-ops",
    accountId: "admin",
    deviceName: "Windows",
    projects: ["D:\\work\\app"],
    attachFile: path.join(dir, "remote-attach.json"),
    maxHours: 12,
    existsDir: () => true,
    exitHome: dir,
    launchWaitMs: 0,
    spawnImpl: () => ({ unref() {}, on() {} }),
    spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "" }),
    sessionLookup: async () => null,
    writeOut: () => {},
    exit: (code) => exits.push(code),
    status: false,
    opsDetectPi: () => ({ currentVersion: "1.3.0", installMethod: "npm-global", packageDir: null, piPath: "pi" }),
    opsDelay: () => Promise.resolve(),
    ...extra,
  });
  ctl.ws = {
    readyState: 1,
    send(payload) {
      frames.push(JSON.parse(payload));
    },
    close() {},
  };
  let sequence = 0;
  const send = async (command, args = {}) => {
    sequence += 1;
    const id = "cmd-" + sequence;
    // Async handlers (update checks) reply after handleMessage returns; wait for the frame.
    await ctl.handleMessage({ type: "command", id, command, args });
    await waitFor(() => frames.some((frame) => frame.id === id), 2000);
    return frames.find((frame) => frame.id === id);
  };
  return { ctl, frames, exits, dir, send };
}

/* ---------------- Pure decision functions ---------------- */

test("classifyPiInstallMethod: npm root match, prefix layout, shim fallback, other, unknown", () => {
  assert.equal(attach.classifyPiInstallMethod({ packageDir: null }), "unknown");
  assert.equal(
    attach.classifyPiInstallMethod({
      packageDir: "/usr/lib/node_modules/@earendil-works/pi-coding-agent",
      npmGlobalRoot: "/usr/lib/node_modules",
      platform: "linux",
    }),
    "npm-global",
  );
  // nvm-style prefix: npm root -g points elsewhere, but the prefix layout and
  // its own npm shim identify it as an npm global install.
  assert.equal(
    attach.classifyPiInstallMethod({
      packageDir: "/home/u/.nvm/versions/node/v22.1.0/lib/node_modules/@earendil-works/pi-coding-agent",
      npmGlobalRoot: "/usr/lib/node_modules",
      npmShimExists: true,
      platform: "linux",
    }),
    "npm-global",
  );
  // The strict prefix layout alone identifies an npm global install: a pi
  // installed with `npm i -g --prefix <dir>` gets no npm shim in that prefix
  // and its root need not match the PATH npm's root at all.
  assert.equal(
    attach.classifyPiInstallMethod({
      packageDir: "/home/u/.nvm/versions/node/v22.1.0/lib/node_modules/@earendil-works/pi-coding-agent",
      npmGlobalRoot: "/usr/lib/node_modules",
      npmShimExists: false,
      platform: "linux",
    }),
    "npm-global",
  );
  // A project-local install is a package in node_modules, but not global.
  assert.equal(
    attach.classifyPiInstallMethod({
      packageDir: "/home/u/project/node_modules/@earendil-works/pi-coding-agent",
      npmGlobalRoot: "/usr/lib/node_modules",
      npmShimExists: false,
      platform: "linux",
    }),
    "other",
  );
  assert.equal(
    attach.classifyPiInstallMethod({
      packageDir: "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent",
      npmGlobalRoot: "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules",
      platform: "win32",
    }),
    "npm-global",
  );
});

test("piInstallPlan: prefix layout carries the update prefix; the default prefix needs none", () => {
  // The sandbox layout from acceptance: pi installed with
  // `npm i -g --prefix ~/.local`, the PATH npm's global root is
  // /usr/lib/node_modules, and the prefix holds no npm shim. The plan must
  // still classify npm-global and target ~/.local, or the update would
  // install into the wrong prefix.
  assert.deepEqual(
    attach.piInstallPlan({
      packageDir: "/home/u/.local/lib/node_modules/@earendil-works/pi-coding-agent",
      npmGlobalRoot: "/usr/lib/node_modules",
      npmShimExists: false,
      platform: "linux",
    }),
    { installMethod: "npm-global", updatePrefix: "/home/u/.local" },
  );
  // Windows prefix layout: <prefix>/node_modules/<pkg>.
  assert.deepEqual(
    attach.piInstallPlan({
      packageDir: "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent",
      npmGlobalRoot: "C:\\Program Files\\nodejs\\node_modules",
      npmShimExists: false,
      platform: "win32",
    }),
    { installMethod: "npm-global", updatePrefix: "C:\\Users\\u\\AppData\\Roaming\\npm" },
  );
  // A prefix layout that IS the PATH npm's own prefix: a plain global
  // install lands in the same place, so no --prefix is carried.
  assert.deepEqual(
    attach.piInstallPlan({
      packageDir: "/usr/lib/node_modules/@earendil-works/pi-coding-agent",
      npmGlobalRoot: "/usr/lib/node_modules",
      platform: "linux",
    }),
    { installMethod: "npm-global", updatePrefix: null },
  );
  // A project-local install stays "other" and carries no prefix.
  assert.deepEqual(
    attach.piInstallPlan({
      packageDir: "/home/u/project/node_modules/@earendil-works/pi-coding-agent",
      npmGlobalRoot: "/usr/lib/node_modules",
      npmShimExists: false,
      platform: "linux",
    }),
    { installMethod: "other", updatePrefix: null },
  );
  assert.deepEqual(attach.piInstallPlan({ packageDir: null }), { installMethod: "unknown", updatePrefix: null });
});

test("npmPrefixForPackageDir: strict global layouts only", () => {
  assert.equal(
    attach.npmPrefixForPackageDir("/home/u/.local/lib/node_modules/@earendil-works/pi-coding-agent", "linux"),
    "/home/u/.local",
  );
  assert.equal(
    attach.npmPrefixForPackageDir("C:\\npm-prefix\\node_modules\\@earendil-works\\pi-coding-agent", "win32"),
    "C:\\npm-prefix",
  );
  // POSIX without the lib segment is a project-local install, not a prefix.
  assert.equal(attach.npmPrefixForPackageDir("/home/u/project/node_modules/@earendil-works/pi-coding-agent", "linux"), null);
  assert.equal(attach.npmPrefixForPackageDir("/home/u/project/lib/other", "linux"), null);
  assert.equal(attach.npmPrefixForPackageDir(null, "linux"), null);
});

test("npmShimPathForPackageDir: prefix layouts only", () => {
  assert.equal(
    attach.npmShimPathForPackageDir("/home/u/.local/lib/node_modules/@earendil-works/pi-coding-agent", "linux"),
    "/home/u/.local/bin/npm",
  );
  assert.equal(
    attach.npmShimPathForPackageDir("C:\\npm-prefix\\node_modules\\@earendil-works\\pi-coding-agent", "win32"),
    "C:\\npm-prefix\\npm.cmd",
  );
  assert.equal(attach.npmShimPathForPackageDir("/home/u/project/src", "linux"), null);
  assert.equal(attach.npmShimPathForPackageDir(null, "linux"), null);
});

test("findPiPackageDir: walks up to the pi package.json and reads its version", () => {
  const dir = tmpDir();
  const packageDir = path.join(dir, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
  fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.4.2" }));
  const found = attach.findPiPackageDir(path.join(packageDir, "dist", "cli.js"), "linux");
  assert.equal(found.version, "1.4.2");
  assert.equal(found.packageDir, packageDir);
  assert.equal(attach.findPiPackageDir(path.join(dir, "elsewhere.txt"), "linux"), null);
});

test("parseSha256Sums + pickReleaseAsset", () => {
  const sums = attach.parseSha256Sums("ABCDEF" + "0".repeat(58) + "  Pi-Remote-device-linux-v1.zip\n" + "f".repeat(64) + " *SHA256SUMS.txt\r\nnot a sum line\n");
  assert.equal(sums.get("Pi-Remote-device-linux-v1.zip"), "abcdef" + "0".repeat(58));
  assert.equal(sums.get("SHA256SUMS.txt"), "f".repeat(64));
  const asset = attach.pickReleaseAsset(
    [
      { name: "Pi-Remote-relay-v2.0.0.zip", browser_download_url: "https://example/relay" },
      { name: "Pi-Remote-device-linux-v2.0.0.zip", browser_download_url: "https://example/linux" },
      { name: "Pi-Remote-device-macos-v2.0.0.zip" },
    ],
    /^Pi-Remote-device-linux-v.+\.zip$/,
  );
  assert.equal(asset.browser_download_url, "https://example/linux");
  assert.equal(attach.pickReleaseAsset(null, /x/), null);
});

/* ---------------- Read-only commands ---------------- */

test("get_pi_update_info: canUpdate when the registry is newer; check failure degrades to null + checkError", async () => {
  const urls = [];
  const newer = makeCtl({
    opsFetchJson: async (url) => {
      urls.push(url);
      return { version: "1.4.2" };
    },
  });
  const infoFrame = await newer.send("get_pi_update_info");
  assert.equal(infoFrame.ok, true);
  assert.equal(infoFrame.data.currentVersion, "1.3.0");
  assert.equal(infoFrame.data.latestVersion, "1.4.2");
  assert.equal(infoFrame.data.installMethod, "npm-global");
  assert.equal(infoFrame.data.canUpdate, true);
  // Attach-side availability facts ride this reply: with an active session
  // get_host_diag is answered by the extension and carries none of them.
  assert.equal(infoFrame.data.supervised, false);
  assert.equal(infoFrame.data.launchedPiCount, 0);
  assert.equal(infoFrame.data.attachVersion, "4.0.0");
  assert.match(urls[0], /registry\.npmjs\.org\/%40earendil-works%2Fpi-coding-agent\/latest/);

  const failing = makeCtl({
    opsFetchJson: async () => {
      throw new Error("network down");
    },
  });
  const failedFrame = await failing.send("get_pi_update_info");
  assert.equal(failedFrame.data.latestVersion, null);
  assert.equal(failedFrame.data.canUpdate, false);
  assert.match(failedFrame.data.checkError, /network down/);

  const current = makeCtl({ opsFetchJson: async () => ({ version: "1.3.0" }) });
  const currentFrame = await current.send("get_pi_update_info");
  assert.equal(currentFrame.data.canUpdate, false);
});

test("get_pi_update_info: a prefix-layout install reports its update prefix and can update", async () => {
  const prefixed = makeCtl({
    opsDetectPi: () => ({
      currentVersion: "1.3.0",
      installMethod: "npm-global",
      updatePrefix: "/home/u/.local",
      packageDir: "/home/u/.local/lib/node_modules/@earendil-works/pi-coding-agent",
      piPath: "pi",
    }),
    opsFetchJson: async () => ({ version: "1.4.2" }),
  });
  const frame = await prefixed.send("get_pi_update_info");
  assert.equal(frame.ok, true);
  assert.equal(frame.data.installMethod, "npm-global");
  assert.equal(frame.data.updatePrefix, "/home/u/.local");
  assert.equal(frame.data.canUpdate, true);
});

test("get_operation_status: replies with the attach-held operation status object", async () => {
  const { ctl, send } = makeCtl();
  const idle = await send("get_operation_status");
  assert.equal(idle.ok, true);
  assert.deepEqual(idle.data.operationStatus, ctl.operationStatus);
  assert.equal(idle.data.operationStatus.state, "idle");

  ctl.operationStatus = { state: "running", kind: "update_pi", phase: "installing", startedAt: 42, finishedAt: null, detail: null, error: null };
  const running = await send("get_operation_status");
  assert.equal(running.data.operationStatus.state, "running");
  assert.equal(running.data.operationStatus.kind, "update_pi");
  assert.equal(running.data.operationStatus.phase, "installing");
});

test("get_host_diag: attach reply carries install method, supervision, operation status, launched count", async () => {
  const { ctl, send } = makeCtl();
  const frame = await send("get_host_diag");
  assert.equal(frame.ok, true);
  assert.equal(frame.data.piVersion, "1.3.0");
  assert.equal(frame.data.piInstallMethod, "npm-global");
  assert.equal(frame.data.supervised, false);
  assert.equal(frame.data.operationStatus.state, "idle");
  assert.equal(frame.data.launchedPiCount, 0);
  assert.equal(frame.data.attach.version, "4.0.0");
  assert.ok(ctl.registerFrame().device.features.includes("device.ops"), "register frame advertises device.ops");
});

/* ---------------- Validation error paths ---------------- */

test("harness_restart with an empty launch ledger replies no_launched_pi", async () => {
  const { send } = makeCtl();
  const frame = await send("harness_restart");
  assert.equal(frame.ok, false);
  assert.equal(frame.code, "no_launched_pi");
});

test("update_pi validation: unsupported_install_method / update_check_failed / already_latest, installer never runs", async () => {
  let installs = 0;
  const opsRunCommand = async () => {
    installs += 1;
    return { code: 0, stdoutTail: "", stderrTail: "" };
  };
  const other = makeCtl({
    opsRunCommand,
    opsDetectPi: () => ({ currentVersion: "1.3.0", installMethod: "other", packageDir: null, piPath: "pi" }),
    opsFetchJson: async () => ({ version: "1.4.2" }),
  });
  const otherFrame = await other.send("update_pi");
  assert.equal(otherFrame.code, "unsupported_install_method");

  const unchecked = makeCtl({
    opsRunCommand,
    opsFetchJson: async () => {
      throw new Error("offline");
    },
  });
  const uncheckedFrame = await unchecked.send("update_pi");
  assert.equal(uncheckedFrame.code, "update_check_failed");

  const latest = makeCtl({ opsRunCommand, opsFetchJson: async () => ({ version: "1.3.0" }) });
  const latestFrame = await latest.send("update_pi");
  assert.equal(latestFrame.code, "already_latest");
  assert.equal(installs, 0);
});

test("a second mutating operation while one is running replies operation_in_progress", async () => {
  const { ctl, send } = makeCtl({
    supervised: true,
    // The self-restart exit waits on this delay; leaving it pending keeps the operation "running".
    opsDelay: () => new Promise(() => {}),
  });
  const accepted = await send("restart_host");
  assert.equal(accepted.ok, true);
  assert.equal(accepted.data.accepted, true);
  assert.ok(accepted.data.operationId);
  assert.equal(ctl.operationStatus.state, "running");
  const blocked = await send("harness_restart");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "operation_in_progress");
  const blockedUpdate = await send("update_pi");
  assert.equal(blockedUpdate.code, "operation_in_progress");
});

/* ---------------- update_pi ---------------- */

test("update_pi: fixed npm command, restart phase, verify against the registry version", async () => {
  let installedVersion = "1.3.0";
  const commands = [];
  const { ctl, send } = makeCtl({
    opsDetectPi: () => ({ currentVersion: installedVersion, installMethod: "npm-global", packageDir: null, piPath: "pi" }),
    opsFetchJson: async () => ({ version: "1.4.2" }),
    opsRunCommand: async (file, args) => {
      commands.push([file, ...args]);
      installedVersion = "1.4.2";
      return { code: 0, stdoutTail: "", stderrTail: "" };
    },
  });
  const frame = await send("update_pi");
  assert.equal(frame.ok, true);
  assert.equal(frame.data.accepted, true);
  await waitFor(() => ctl.operationStatus.state !== "running");
  // Windows runs npm through cmd.exe (the npm shim is a .cmd); the argv after
  // the wrapper is exactly the fixed install command, nothing request-derived.
  assert.deepEqual(commands, [["cmd.exe", "/c", "npm", "install", "-g", "@earendil-works/pi-coding-agent@latest"]]);
  assert.equal(ctl.operationStatus.state, "succeeded");
  assert.match(ctl.operationStatus.detail, /1\.4\.2/);
});

test("update_pi: a probed update prefix is targeted with --prefix, the rest stays the fixed command", async () => {
  let installedVersion = "1.3.0";
  const commands = [];
  const { ctl, send } = makeCtl({
    opsDetectPi: () => ({
      currentVersion: installedVersion,
      installMethod: "npm-global",
      updatePrefix: "/home/u/.local",
      packageDir: "/home/u/.local/lib/node_modules/@earendil-works/pi-coding-agent",
      piPath: "pi",
    }),
    opsFetchJson: async () => ({ version: "1.4.2" }),
    opsRunCommand: async (file, args) => {
      commands.push([file, ...args]);
      installedVersion = "1.4.2";
      return { code: 0, stdoutTail: "", stderrTail: "" };
    },
  });
  const frame = await send("update_pi");
  assert.equal(frame.ok, true);
  assert.equal(frame.data.accepted, true);
  await waitFor(() => ctl.operationStatus.state !== "running");
  // Only the --prefix pair is added (from the file-system-probed detection
  // result); the package spec is still the fixed constant.
  assert.deepEqual(commands, [
    ["cmd.exe", "/c", "npm", "install", "-g", "--prefix", "/home/u/.local", "@earendil-works/pi-coding-agent@latest"],
  ]);
  // The verifying phase re-detects on disk and confirms the new version.
  assert.equal(ctl.operationStatus.state, "succeeded");
  assert.match(ctl.operationStatus.detail, /1\.4\.2/);
});

test("update_pi: a failed install leaves pi untouched and does not restart anything", async () => {
  let restarts = 0;
  const { ctl, send } = makeCtl({
    opsFetchJson: async () => ({ version: "1.4.2" }),
    opsRunCommand: async () => ({ code: 1, stdoutTail: "", stderrTail: "npm ERR! boom" }),
  });
  ctl.restartAllLaunchedPi = async () => {
    restarts += 1;
    return { restarted: 0, failed: [] };
  };
  const frame = await send("update_pi");
  assert.equal(frame.data.accepted, true);
  await waitFor(() => ctl.operationStatus.state !== "running");
  assert.equal(ctl.operationStatus.state, "failed");
  assert.match(ctl.operationStatus.error, /boom/);
  assert.equal(restarts, 0);
});

/* ---------------- restart_host + pending marker ---------------- */

test("restart_host: unsupervised replies not_supervised; supervised exits 75 with a pending marker", async () => {
  const plain = makeCtl();
  const plainFrame = await plain.send("restart_host");
  assert.equal(plainFrame.ok, false);
  assert.equal(plainFrame.code, "not_supervised");
  assert.deepEqual(plain.exits, []);

  const supervised = makeCtl({ supervised: true });
  const frame = await supervised.send("restart_host");
  assert.equal(frame.ok, true);
  assert.equal(frame.data.accepted, true);
  await waitFor(() => supervised.exits.length > 0);
  assert.deepEqual(supervised.exits, [75]);
  const marker = JSON.parse(fs.readFileSync(path.join(supervised.dir, "operation-pending.json"), "utf8"));
  assert.equal(marker.kind, "restart_host");
  assert.equal(typeof marker.startedAt, "number");
});

test("boot completes a restart_host pending marker into a succeeded status and deletes it", async () => {
  const first = makeCtl({ supervised: true });
  await first.send("restart_host");
  await waitFor(() => first.exits.length > 0);
  assert.ok(fs.existsSync(path.join(first.dir, "operation-pending.json")));

  const second = makeCtl({ attachFile: path.join(first.dir, "remote-attach.json") });
  assert.equal(second.ctl.operationStatus.state, "succeeded");
  assert.equal(second.ctl.operationStatus.kind, "restart_host");
  assert.equal(fs.existsSync(path.join(first.dir, "operation-pending.json")), false);
});

/* ---------------- harness_restart ---------------- */

test("harness_restart: a window-launched pi (no tmux handle) fails per process with its room id", async () => {
  const { ctl, send } = makeCtl();
  ctl.onlineRooms = [{ id: "s9", cwd: "D:\\work\\app", online: true }];
  ctl.spawnedByCwd.set("d:\\work\\app", { at: Date.now(), roomId: "s9" });
  const frame = await send("harness_restart");
  assert.equal(frame.ok, true);
  assert.equal(frame.data.accepted, true);
  await waitFor(() => ctl.operationStatus.state !== "running");
  assert.equal(ctl.operationStatus.state, "failed");
  assert.equal(ctl.operationStatus.result.restarted, 0);
  assert.equal(ctl.operationStatus.result.failed.length, 1);
  assert.equal(ctl.operationStatus.result.failed[0].roomId, "s9");
  assert.match(ctl.operationStatus.result.failed[0].error, /cannot signal/);
});

/**
 * Fake tmux for the restart happy path: sessions are a name -> { pids, dead }
 * map; signals land through the injected kill and flip panes dead.
 */
function fakeTmuxWorld() {
  const sessions = new Map();
  const signals = [];
  let newSessionCount = 0;
  const spawnSyncImpl = (file, args) => {
    if (args[0] === "-V") return { status: 0, stdout: "tmux 3.4\n" };
    if (args[0] === "list-panes") {
      if (!args.includes("-t")) return { status: 1, stdout: "", stderr: "no target" };
      const name = String(args[args.indexOf("-t") + 1] || "").replace(/^=/, "").replace(/:$/, "");
      const session = sessions.get(name);
      if (!session) return { status: 1, stdout: "", stderr: "can't find session" };
      const format = String(args[args.indexOf("-F") + 1] || "");
      if (format.includes("pane_pid")) return { status: 0, stdout: session.pids.join("\n") + "\n" };
      if (format.includes("pane_dead_status")) return { status: 0, stdout: session.dead ? "1 0\n" : "0 \n" };
      return { status: 0, stdout: (session.dead ? "1" : "0") + "\n" };
    }
    if (args[0] === "kill-session") {
      const name = String(args[args.indexOf("-t") + 1] || "").replace(/^=/, "");
      sessions.delete(name);
      return { status: 0, stdout: "" };
    }
    if (args[0] === "capture-pane") return { status: 0, stdout: "" };
    return { status: 0, stdout: "" };
  };
  const spawnImpl = (file, args) => {
    const child = new EventEmitter();
    child.unref = () => {};
    if (args[0] === "new-session") {
      newSessionCount += 1;
      const name = String(args[args.indexOf("-s") + 1]);
      sessions.set(name, { pids: [5000 + newSessionCount], dead: false });
    }
    setImmediate(() => child.emit("exit", 0));
    return child;
  };
  const killProcess = (pid, signal) => {
    signals.push([pid, signal]);
    for (const session of sessions.values()) {
      if (session.pids.includes(Math.abs(pid))) session.dead = true;
    }
  };
  return { sessions, signals, spawnSyncImpl, spawnImpl, killProcess, newSessions: () => newSessionCount };
}

test("harness_restart: tmux pi is SIGTERMed, relaunched with its session, and confirmed when the room returns", async () => {
  const dir = tmpDir();
  const app = path.join(dir, "app");
  fs.mkdirSync(app);
  const startPi = path.join(dir, "start-pi.sh");
  fs.writeFileSync(startPi, "exit 0\n");
  const world = fakeTmuxWorld();
  world.sessions.set("pi-old-session", { pids: [4321], dead: false });
  const frames = [];
  const ctl = new attach.AttachController({
    platform: "linux",
    relay: "ws://127.0.0.1:7001",
    deviceId: "dev-linux",
    projects: [app],
    attachFile: path.join(dir, "remote-attach.json"),
    startPi,
    status: false,
    exit: () => {},
    writeOut: () => {},
    spawnImpl: world.spawnImpl,
    spawnSyncImpl: world.spawnSyncImpl,
    tmuxSettleMs: 5,
    exitHome: dir,
    sessionLookup: async (id) => (id === "s1" ? { id: "s1", path: path.join(dir, "t_s1.jsonl"), cwd: app, deleted: false } : null),
    opsKillProcess: world.killProcess,
    opsStopGraceMs: 400,
    opsRoomWaitMs: 3000,
  });
  ctl.ws = {
    readyState: 1,
    send(payload) {
      frames.push(JSON.parse(payload));
    },
    close() {},
  };
  ctl.spawnedBySession.set("s1", { at: Date.now(), tmuxSession: "pi-old-session" });

  await ctl.handleMessage({ type: "command", id: "r1", command: "harness_restart", args: {} });
  const accepted = frames.find((frame) => frame.id === "r1");
  assert.equal(accepted.ok, true);
  assert.equal(accepted.data.accepted, true);

  // The old pane got SIGTERM (process-group form first), a new tmux session was launched.
  await waitFor(() => world.newSessions() >= 1);
  assert.ok(world.signals.some(([pid, signal]) => pid === -4321 && signal === "SIGTERM"));
  // The room comes back; the waiter settles and the operation lands as succeeded.
  ctl.observeRooms([{ id: "s1", cwd: app, online: true }]);
  await waitFor(() => ctl.operationStatus.state !== "running");
  assert.equal(ctl.operationStatus.state, "succeeded");
  assert.equal(ctl.operationStatus.result.restarted, 1);
  assert.deepEqual(ctl.operationStatus.result.failed, []);
});

/* ---------------- update_components ---------------- */

const RELEASE = {
  tag_name: "v9.9.9",
  assets: [
    { name: "Pi-Remote-device-windows-v9.9.9.zip", browser_download_url: "https://example.test/device.zip" },
    { name: "SHA256SUMS.txt", browser_download_url: "https://example.test/SHA256SUMS.txt" },
  ],
};

function componentKit(t) {
  const kit = tmpDir();
  t.after(() => fs.rmSync(kit, { recursive: true, force: true }));
  fs.mkdirSync(path.join(kit, "deploy"), { recursive: true });
  fs.mkdirSync(path.join(kit, "extension"), { recursive: true });
  fs.writeFileSync(path.join(kit, "deploy", "attach.cjs"), "OLD ATTACH\n");
  fs.writeFileSync(path.join(kit, "extension", "pi-remote-sync.ts"), "OLD EXTENSION\n");
  const syncTarget = path.join(kit, "installed", "pi-remote-sync.ts");
  return { kit, syncTarget };
}

test("update_components: unsupervised replies not_supervised before anything is fetched", async () => {
  let fetches = 0;
  const { send } = makeCtl({
    opsFetchJson: async () => {
      fetches += 1;
      return RELEASE;
    },
  });
  const frame = await send("update_components");
  assert.equal(frame.ok, false);
  assert.equal(frame.code, "not_supervised");
  assert.equal(fetches, 0);
});

test("update_components: sha256 mismatch fails before the swap and touches no file", async (t) => {
  const { kit, syncTarget } = componentKit(t);
  const zipBytes = Buffer.from("fake zip bytes");
  const { ctl, exits, send } = makeCtl({
    supervised: true,
    deployRoot: kit,
    extensionSyncFile: syncTarget,
    opsFetchJson: async () => RELEASE,
    opsDownloadFile: async (url, dest) => {
      if (url.endsWith("SHA256SUMS.txt")) fs.writeFileSync(dest, "0".repeat(64) + "  Pi-Remote-device-windows-v9.9.9.zip\n");
      else fs.writeFileSync(dest, zipBytes);
    },
    opsSha256File: async (file) => sha256Hex(fs.readFileSync(file)),
    opsExtractZip: async () => {
      throw new Error("extract must not run after a checksum failure");
    },
  });
  const frame = await send("update_components");
  assert.equal(frame.data.accepted, true);
  await waitFor(() => ctl.operationStatus.state !== "running");
  assert.equal(ctl.operationStatus.state, "failed");
  assert.match(ctl.operationStatus.error, /sha256 mismatch/);
  assert.equal(fs.readFileSync(path.join(kit, "deploy", "attach.cjs"), "utf8"), "OLD ATTACH\n");
  assert.deepEqual(exits, []);
});

test("update_components: download, verify, swap with backup, sync extension, supervised restart; next boot completes it", async (t) => {
  const { kit, syncTarget } = componentKit(t);
  const zipBytes = Buffer.from("fake zip bytes");
  const { ctl, exits, dir, send } = makeCtl({
    supervised: true,
    deployRoot: kit,
    extensionSyncFile: syncTarget,
    opsFetchJson: async () => RELEASE,
    opsDownloadFile: async (url, dest) => {
      if (url.endsWith("SHA256SUMS.txt")) fs.writeFileSync(dest, sha256Hex(zipBytes) + "  Pi-Remote-device-windows-v9.9.9.zip\n");
      else fs.writeFileSync(dest, zipBytes);
    },
    opsSha256File: async (file) => sha256Hex(fs.readFileSync(file)),
    opsExtractZip: async (zipPath, destDir) => {
      fs.mkdirSync(path.join(destDir, "deploy"), { recursive: true });
      fs.mkdirSync(path.join(destDir, "extension"), { recursive: true });
      fs.writeFileSync(path.join(destDir, "deploy", "attach.cjs"), "NEW ATTACH\n");
      fs.writeFileSync(path.join(destDir, "extension", "pi-remote-sync.ts"), "NEW EXTENSION\n");
    },
  });
  const frame = await send("update_components");
  assert.equal(frame.data.accepted, true);
  await waitFor(() => exits.length > 0);
  assert.deepEqual(exits, [attach.OPS_RESTART_EXIT_CODE]);
  assert.equal(fs.readFileSync(path.join(kit, "deploy", "attach.cjs"), "utf8"), "NEW ATTACH\n");
  assert.equal(fs.readFileSync(path.join(kit, "extension", "pi-remote-sync.ts"), "utf8"), "NEW EXTENSION\n");
  assert.equal(fs.readFileSync(syncTarget, "utf8"), "NEW EXTENSION\n");
  const backups = fs.readdirSync(path.join(dir, "component-backup"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, "component-backup", backups[0], "deploy", "attach.cjs"), "utf8"), "OLD ATTACH\n");
  const marker = JSON.parse(fs.readFileSync(path.join(dir, "operation-pending.json"), "utf8"));
  assert.equal(marker.kind, "update_components");

  // The relaunched window completes the marker: extension is in sync.
  const nextBoot = makeCtl({
    attachFile: path.join(dir, "remote-attach.json"),
    deployRoot: kit,
    extensionSyncFile: syncTarget,
  });
  // Boot completion deletes the marker but holds the status non-terminal
  // until the pi restart attempt lands the single final write.
  assert.equal(nextBoot.ctl.operationStatus.state, "running");
  assert.equal(nextBoot.ctl.operationStatus.kind, "update_components");
  assert.equal(fs.existsSync(path.join(dir, "operation-pending.json")), false);
  nextBoot.ctl.consumeComponentUpdatePiRestart();
  await waitFor(() => nextBoot.ctl.operationStatus.state === "succeeded");
  // This window's ledger is empty, and the final detail says so.
  assert.match(nextBoot.ctl.operationStatus.detail, /Device components updated/);
  assert.match(nextBoot.ctl.operationStatus.detail, /no launched Pi processes to restart/);
  assert.deepEqual(nextBoot.ctl.operationStatus.result, { restarted: 0, failed: [] });
});

test("boot completion of update_components: boot restarts launched pi onto the new extension; a pi failure stays a succeeded update", async (t) => {
  // Fresh device dir holding only a pending update_components marker, with
  // the extension already swapped and synced (the post-restart state).
  const kit = tmpDir();
  t.after(() => fs.rmSync(kit, { recursive: true, force: true }));
  fs.mkdirSync(path.join(kit, "extension"), { recursive: true });
  fs.writeFileSync(path.join(kit, "extension", "pi-remote-sync.ts"), "NEW EXTENSION\n");
  const syncTarget = path.join(kit, "installed", "pi-remote-sync.ts");
  fs.mkdirSync(path.dirname(syncTarget), { recursive: true });
  fs.writeFileSync(syncTarget, "NEW EXTENSION\n");
  const agentDir = tmpDir();
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(agentDir, "operation-pending.json"), JSON.stringify({ kind: "update_components", startedAt: 1234 }));

  const bootWith = (summary) => {
    const booted = makeCtl({
      attachFile: path.join(agentDir, "remote-attach.json"),
      deployRoot: kit,
      extensionSyncFile: syncTarget,
    });
    // Boot completion alone never publishes a terminal state anymore:
    // the pi restart attempt below lands the final write.
    assert.equal(booted.ctl.operationStatus.state, "running");
    assert.equal(booted.ctl.operationStatus.finishedAt, null);
    booted.ctl.dirs = [];
    let calls = 0;
    booted.ctl.restartAllLaunchedPi = async () => {
      calls += 1;
      return summary;
    };
    return { booted, calls: () => calls };
  };

  const okRun = bootWith({ restarted: 2, failed: [] });
  await okRun.booted.ctl.bootDirs();
  await waitFor(() => /Pi restarted to load the new extension/.test(okRun.booted.ctl.operationStatus.detail || ""));
  assert.equal(okRun.calls(), 1);
  assert.equal(okRun.booted.ctl.operationStatus.state, "succeeded");
  assert.match(okRun.booted.ctl.operationStatus.detail, /Device components updated/);
  assert.deepEqual(okRun.booted.ctl.operationStatus.result, { restarted: 2, failed: [] });

  // The marker was consumed by the first boot; rewrite it for the failure run.
  fs.writeFileSync(path.join(agentDir, "operation-pending.json"), JSON.stringify({ kind: "update_components", startedAt: 1234 }));
  const failRun = bootWith({ restarted: 1, failed: [{ roomId: "r9", error: "room did not come back" }] });
  await failRun.booted.ctl.bootDirs();
  await waitFor(() => /did not restart to load the new extension/.test(failRun.booted.ctl.operationStatus.detail || ""));
  assert.equal(failRun.calls(), 1);
  // Best effort: the component update result is not flipped to failed.
  assert.equal(failRun.booted.ctl.operationStatus.state, "succeeded");
  assert.match(failRun.booted.ctl.operationStatus.detail, /1 of 2 Pi processes/);
  assert.match(failRun.booted.ctl.operationStatus.detail, /room did not come back/);
});

test("boot completion of update_components: no terminal state is visible while the pi restart attempt is still pending", async (t) => {
  // Same post-restart device state as the previous test.
  const kit = tmpDir();
  t.after(() => fs.rmSync(kit, { recursive: true, force: true }));
  fs.mkdirSync(path.join(kit, "extension"), { recursive: true });
  fs.writeFileSync(path.join(kit, "extension", "pi-remote-sync.ts"), "NEW EXTENSION\n");
  const syncTarget = path.join(kit, "installed", "pi-remote-sync.ts");
  fs.mkdirSync(path.dirname(syncTarget), { recursive: true });
  fs.writeFileSync(syncTarget, "NEW EXTENSION\n");
  const agentDir = tmpDir();
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(agentDir, "operation-pending.json"), JSON.stringify({ kind: "update_components", startedAt: 1234 }));

  const booted = makeCtl({
    attachFile: path.join(agentDir, "remote-attach.json"),
    deployRoot: kit,
    extensionSyncFile: syncTarget,
  });
  booted.ctl.dirs = [];
  // A pi restart attempt that only returns when the test releases it.
  let releaseRestart = null;
  let restartCalls = 0;
  booted.ctl.restartAllLaunchedPi = () => {
    restartCalls += 1;
    return new Promise((resolve) => {
      releaseRestart = () => resolve({ restarted: 1, failed: [] });
    });
  };
  await booted.ctl.bootDirs();
  assert.equal(restartCalls, 1);
  // Give the completion chain every chance to misbehave: while the
  // attempt is pending, the status must not read as a finished
  // operation (a polling UI stops at the first terminal state it sees).
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(booted.ctl.operationStatus.state, "running");
  assert.equal(booted.ctl.operationStatus.finishedAt, null);
  assert.equal(booted.ctl.operationStatus.detail, null);

  releaseRestart();
  await waitFor(() => booted.ctl.operationStatus.state === "succeeded");
  // The single terminal write already carries the pi segment.
  assert.match(booted.ctl.operationStatus.detail, /Device components updated/);
  assert.match(booted.ctl.operationStatus.detail, /Pi restarted to load the new extension \(1 process\)/);
  assert.ok(booted.ctl.operationStatus.finishedAt > 0);
  assert.deepEqual(booted.ctl.operationStatus.result, { restarted: 1, failed: [] });
});

/* ---------------- Component update merge semantics (defect B) ---------------- */

test("update_components: the swap merges over deploy/ — files the package does not carry survive", async (t) => {
  const { kit, syncTarget } = componentKit(t);
  // A repository-tree install carries deploy files the curated release
  // package never ships; attach itself needs start-pi.sh to launch pi.
  fs.writeFileSync(path.join(kit, "deploy", "start-pi.sh"), "START PI SCRIPT\n");
  fs.mkdirSync(path.join(kit, "deploy", "docker"), { recursive: true });
  fs.writeFileSync(path.join(kit, "deploy", "docker", "keep.txt"), "KEEP ME\n");
  const zipBytes = Buffer.from("fake zip bytes");
  const { ctl, exits, dir, send } = makeCtl({
    supervised: true,
    deployRoot: kit,
    extensionSyncFile: syncTarget,
    opsFetchJson: async () => RELEASE,
    opsDownloadFile: async (url, dest) => {
      if (url.endsWith("SHA256SUMS.txt")) fs.writeFileSync(dest, sha256Hex(zipBytes) + "  Pi-Remote-device-windows-v9.9.9.zip\n");
      else fs.writeFileSync(dest, zipBytes);
    },
    opsSha256File: async (file) => sha256Hex(fs.readFileSync(file)),
    opsExtractZip: async (zipPath, destDir) => {
      fs.mkdirSync(path.join(destDir, "deploy"), { recursive: true });
      fs.mkdirSync(path.join(destDir, "extension"), { recursive: true });
      fs.writeFileSync(path.join(destDir, "deploy", "attach.cjs"), "NEW ATTACH\n");
      fs.writeFileSync(path.join(destDir, "deploy", "new-tool.sh"), "NEW TOOL\n");
      fs.writeFileSync(path.join(destDir, "extension", "pi-remote-sync.ts"), "NEW EXTENSION\n");
    },
  });
  const frame = await send("update_components");
  assert.equal(frame.data.accepted, true);
  await waitFor(() => exits.length > 0);
  assert.deepEqual(exits, [attach.OPS_RESTART_EXIT_CODE]);
  // Package files landed (overwrite + addition)...
  assert.equal(fs.readFileSync(path.join(kit, "deploy", "attach.cjs"), "utf8"), "NEW ATTACH\n");
  assert.equal(fs.readFileSync(path.join(kit, "deploy", "new-tool.sh"), "utf8"), "NEW TOOL\n");
  // ...and every file the package does not carry is still there, untouched.
  assert.equal(fs.readFileSync(path.join(kit, "deploy", "start-pi.sh"), "utf8"), "START PI SCRIPT\n");
  assert.equal(fs.readFileSync(path.join(kit, "deploy", "docker", "keep.txt"), "utf8"), "KEEP ME\n");
  // The backup still snapshots the whole pre-update tree.
  const backups = fs.readdirSync(path.join(dir, "component-backup"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, "component-backup", backups[0], "deploy", "start-pi.sh"), "utf8"), "START PI SCRIPT\n");
});

test("component swap rollback: overwritten files restored, added files removed, unlisted files kept", async (t) => {
  const { kit } = componentKit(t);
  fs.writeFileSync(path.join(kit, "deploy", "start-pi.sh"), "START PI SCRIPT\n");
  const extracted = tmpDir();
  t.after(() => fs.rmSync(extracted, { recursive: true, force: true }));
  fs.mkdirSync(path.join(extracted, "deploy"), { recursive: true });
  fs.mkdirSync(path.join(extracted, "extension"), { recursive: true });
  fs.writeFileSync(path.join(extracted, "deploy", "attach.cjs"), "NEW ATTACH\n");
  fs.writeFileSync(path.join(extracted, "deploy", "added-tool.sh"), "ADDED BY UPDATE\n");
  fs.writeFileSync(path.join(extracted, "extension", "pi-remote-sync.ts"), "NEW EXTENSION\n");

  const { ctl } = makeCtl({ deployRoot: kit });
  const backupDir = ctl.backupComponentFiles();
  ctl.installComponentFiles(extracted);
  assert.equal(fs.readFileSync(path.join(kit, "deploy", "attach.cjs"), "utf8"), "NEW ATTACH\n");
  assert.equal(fs.readFileSync(path.join(kit, "deploy", "added-tool.sh"), "utf8"), "ADDED BY UPDATE\n");
  assert.deepEqual(ctl.componentUpdateAddedFiles, ["added-tool.sh"]);

  ctl.restoreComponentBackup(backupDir);
  // Overwritten files are back to their pre-update bytes...
  assert.equal(fs.readFileSync(path.join(kit, "deploy", "attach.cjs"), "utf8"), "OLD ATTACH\n");
  assert.equal(fs.readFileSync(path.join(kit, "extension", "pi-remote-sync.ts"), "utf8"), "OLD EXTENSION\n");
  // ...files the update added are gone again...
  assert.equal(fs.existsSync(path.join(kit, "deploy", "added-tool.sh")), false);
  // ...and files the package never carried were never touched.
  assert.equal(fs.readFileSync(path.join(kit, "deploy", "start-pi.sh"), "utf8"), "START PI SCRIPT\n");
  assert.deepEqual(ctl.componentUpdateAddedFiles, []);
});

/* ---------------- Pending pi restart without start directories (defect A) ---------------- */

/** Device dir in the post-component-update state: marker pending, extension swapped and synced. */
function pendingUpdateKit(t) {
  const kit = tmpDir();
  t.after(() => fs.rmSync(kit, { recursive: true, force: true }));
  fs.mkdirSync(path.join(kit, "extension"), { recursive: true });
  fs.writeFileSync(path.join(kit, "extension", "pi-remote-sync.ts"), "NEW EXTENSION\n");
  const syncTarget = path.join(kit, "installed", "pi-remote-sync.ts");
  fs.mkdirSync(path.dirname(syncTarget), { recursive: true });
  fs.writeFileSync(syncTarget, "NEW EXTENSION\n");
  const agentDir = tmpDir();
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(agentDir, "operation-pending.json"), JSON.stringify({ kind: "update_components", startedAt: 1234 }));
  return { kit, syncTarget, agentDir };
}

test("boot completion without start directories: registration consumes the pending pi restart, bootDirs never runs", async (t) => {
  const { kit, syncTarget, agentDir } = pendingUpdateKit(t);
  const booted = makeCtl({
    attachFile: path.join(agentDir, "remote-attach.json"),
    deployRoot: kit,
    extensionSyncFile: syncTarget,
  });
  // The marker was consumed at construction; the restart flag is pending
  // and the status is held non-terminal until the restart attempt lands
  // the final write. This window has no start directories, so bootDirs
  // can never fire.
  assert.equal(booted.ctl.operationStatus.state, "running");
  assert.equal(booted.ctl.operationStatus.finishedAt, null);
  assert.equal(booted.ctl.pendingComponentUpdatePiRestart, true);
  assert.deepEqual(booted.ctl.dirs, []);
  let bootDirsCalls = 0;
  const originalBootDirs = booted.ctl.bootDirs.bind(booted.ctl);
  booted.ctl.bootDirs = async () => {
    bootDirsCalls += 1;
    return originalBootDirs();
  };
  let restartCalls = 0;
  booted.ctl.restartAllLaunchedPi = async () => {
    restartCalls += 1;
    return { restarted: 1, failed: [] };
  };
  assert.equal(restartCalls, 0);

  await booted.ctl.handleMessage({ type: "auth_result", ok: true });

  await waitFor(() => /Pi restarted to load the new extension/.test(booted.ctl.operationStatus.detail || ""));
  assert.equal(restartCalls, 1);
  assert.equal(bootDirsCalls, 0);
  assert.equal(booted.ctl.pendingComponentUpdatePiRestart, false);
  assert.equal(booted.ctl.operationStatus.state, "succeeded");
  assert.match(booted.ctl.operationStatus.detail, /Device components updated/);
  assert.deepEqual(booted.ctl.operationStatus.result, { restarted: 1, failed: [] });
});

test("boot completion without start directories and an empty ledger: flag cleared, detail says no pi needed a restart", async (t) => {
  const { kit, syncTarget, agentDir } = pendingUpdateKit(t);
  const booted = makeCtl({
    attachFile: path.join(agentDir, "remote-attach.json"),
    deployRoot: kit,
    extensionSyncFile: syncTarget,
  });
  assert.equal(booted.ctl.pendingComponentUpdatePiRestart, true);
  booted.ctl.restartAllLaunchedPi = async () => ({ restarted: 0, failed: [] });

  await booted.ctl.handleMessage({ type: "auth_result", ok: true });

  await waitFor(() => /no launched Pi processes to restart/.test(booted.ctl.operationStatus.detail || ""));
  assert.equal(booted.ctl.pendingComponentUpdatePiRestart, false);
  assert.equal(booted.ctl.operationStatus.state, "succeeded");
  assert.match(booted.ctl.operationStatus.detail, /Device components updated/);
});
