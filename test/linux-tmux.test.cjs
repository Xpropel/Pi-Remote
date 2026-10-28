// Linux 设备（服务器式，deploy/README.md）的真 tmux 联调：每个用例一个独立的 tmux 服务（TMUX_TMPDIR 指到临时目录，
// 不碰开发机自己的 tmux），relay 在进程内用随机端口。没装 tmux 的机器整份跳过。
// tmux 新会话的环境取自 tmux 服务启动时的那份（不是发命令的客户端）：用例之间共用一个服务，
// 后面用例的窗口就会拿着前面用例的 HOME 跑，把状态文件写进开发机真正的 ~/.pi。所以一个用例一个服务。
//   1. attach 按 Linux 规则响应 harness_start：tmux 后台会话里起 start-pi，目录和 --session 原样到达
//   2. device.sh 全流程：init → pair → up（窗口在 tmux 里连上 relay）→ 网页 harness_start → pi 拿到 .env 的令牌起来
//      → status / sessions → down（状态文件删掉、pi 不受影响）
//   3. pi 起不来时 tmux 留现场（remain-on-exit failed），sessions 标退出码，clean 收掉；目录名末尾是分号也能起
//   4. attach 拉起时 pi 当场退出回 spawn_failed，修好后同目录立刻能重拉
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const attach = require("../deploy/attach.cjs");

const REPO = path.join(__dirname, "..");
const ADMIN_TOKEN = "test-admin-token-tmux-3a7d";
const KIT_FILES = [
  "deploy/attach.cjs",
  "deploy/session-library.cjs",
  "deploy/attach.sh",
  "deploy/start-pi.sh",
  "deploy/sync-extension.sh",
  "deploy/linux/device.cjs",
  "deploy/linux/device.sh",
  "extension/pi-remote-sync.ts",
  "protocol/v4.json",
  "package.json",
  ".env.example",
];

delete process.env.TMUX;
const probe = spawnSync("tmux", ["-V"], { encoding: "utf8" });
const NO_TMUX = probe.error || probe.status !== 0 ? "没装 tmux" : false;
const m = /(\d+)\.(\d+)/.exec(String(probe.stdout || ""));
const KEEPS_FAILED = !m || Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 2);

function tmp(prefix) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** 本用例专用的 tmux 服务（socket 路径有长度上限，放 /tmp 下的短目录）；进程内 spawn 的 tmux 也走它，用完关服务 */
function ownTmux(t, home) {
  const dir = fs.realpathSync.native(fs.mkdtempSync("/tmp/pitmx-"));
  const saved = { TMUX_TMPDIR: process.env.TMUX_TMPDIR, HOME: process.env.HOME };
  process.env.TMUX_TMPDIR = dir;
  if (home) process.env.HOME = home;
  const env = { ...process.env, TMUX_TMPDIR: dir };
  t.after(() => {
    spawnSync("tmux", ["kill-server"], { env });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, env };
}

const until = async (pred, ms = 5000, what = "条件") => {
  const t0 = Date.now();
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时：" + what);
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** 写一个假 pi：记下 cwd、参数和 pi-remote 的环境变量，然后挂着（tmux 会话不退） */
function fakePi(file, seenDir) {
  fs.writeFileSync(
    file,
    [
      "#!/bin/bash",
      `out=${attach.shellQuote(seenDir)}/pi-$$.txt`,
      'printf \'%s\\n\' "$PWD" "DEV=$PI_REMOTE_DEVICE_ID" "TOK=${PI_REMOTE_DEVICE_TOKEN:+set}" "RELAY=$PI_REMOTE_RELAY" "ARGS" "$@" > "$out"',
      "exec sleep 600",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return file;
}

function seen(dir) {
  return fs
    .readdirSync(dir)
    .filter((n) => /^pi-\d+\.txt$/.test(n))
    .map((n) => fs.readFileSync(path.join(dir, n), "utf8").split("\n"));
}

function tmuxPanes() {
  const r = spawnSync("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{pane_dead}\t#{pane_dead_status}\t#{session_path}"], { encoding: "utf8", env: process.env });
  if (r.status !== 0) return [];
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [name, dead, status, cwd] = l.split("\t");
      return { name, dead: dead === "1", status: status === "" ? null : Number(status), cwd };
    });
}

/** 沙箱套件 + 家目录：.env、状态文件、扩展目录都在沙箱里 */
function sandbox(t) {
  const root = tmp("pi-linux-tmux-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const kit = path.join(root, "kit");
  for (const rel of KIT_FILES) {
    fs.mkdirSync(path.dirname(path.join(kit, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(kit, rel));
    fs.chmodSync(path.join(kit, rel), fs.statSync(path.join(REPO, rel)).mode & 0o777);
  }
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(kit, "node_modules"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const seenDir = path.join(root, "seen");
  for (const d of [home, bin, seenDir]) fs.mkdirSync(d, { recursive: true });
  const tmux = ownTmux(t, home);
  const env = { PATH: bin + path.delimiter + process.env.PATH, HOME: home, LANG: "C.UTF-8", TMUX_TMPDIR: tmux.dir };
  const device = (args, extraEnv = {}, cwd = root) =>
    new Promise((resolve) => {
      // 异步起子进程：relay 在本进程里，同步等会把它的事件循环卡住
      const child = spawn(process.execPath, [path.join(kit, "deploy", "linux", "device.cjs"), ...args], { cwd, env: { ...env, ...extraEnv } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  return { root, kit, home, bin, seenDir, env, device };
}

async function relayWithViewer(t, root) {
  const { startRelay } = require("../relay/server.js");
  const WebSocket = require("ws");
  const relay = await startRelay({
    localPort: 0,
    viewerPort: 0,
    dataDir: path.join(root, "rooms"),
    accountsDir: path.join(root, "accounts"),
    quiet: true,
    exitOnListenError: false,
    localToken: "lt",
    viewerToken: "vt",
    adminToken: ADMIN_TOKEN,
    persistTranscripts: false,
  });
  const ws = new WebSocket(`ws://127.0.0.1:${relay.viewerPort}/`);
  const frames = [];
  ws.on("message", (d) => frames.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once("open", r));
  t.after(async () => {
    ws.close();
    await relay.close();
  });
  const take = (pred, what, ms) => until(() => frames.find(pred), ms, what);
  ws.send(JSON.stringify({ type: "auth", role: "viewer", token: "vt", proto: 4, caps: ["err.v4", "msg.cid", "device.token"] }));
  await take((f) => f.type === "auth_result" && f.ok, "viewer 鉴权");
  return { relay, frames, take, send: (o) => ws.send(JSON.stringify(o)) };
}

test("attach（Linux 规则）+ 真 tmux：harness_start 在后台会话里起 start-pi，空格、引号、$ 的目录和 --session 原样到达", { skip: NO_TMUX }, async (t) => {
  const root = tmp("pi-linux-attach-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "home"));
  ownTmux(t, path.join(root, "home"));
  const dirA = path.join(root, `my app's $dir`);
  const dirB = path.join(root, "b `x` & y");
  fs.mkdirSync(dirA);
  fs.mkdirSync(dirB);
  const seenDir = path.join(root, "seen");
  fs.mkdirSync(seenDir);
  const startPi = path.join(root, "fake start-pi.sh");
  fs.writeFileSync(startPi, `printf '%s\\n' "$PWD" "$@" > ${attach.shellQuote(seenDir)}/start-$$.txt\nexec sleep 600\n`);
  const sessionPath = path.join(root, "sess 'q' $(id).jsonl");
  const frames = [];
  const ctl = new attach.AttachController({
    platform: "linux",
    relay: "ws://127.0.0.1:9",
    deviceId: "dev-linux",
    projects: [dirA, dirB],
    attachFile: path.join(root, "remote-attach.json"),
    startPi,
    status: false,
    writeOut: () => {},
    exit: () => {},
    sessionLookup: async (id) => (id === "s1" ? { id: "s1", path: sessionPath, cwd: dirB, deleted: false } : null),
  });
  ctl.ws = { readyState: 1, send: (s) => frames.push(JSON.parse(s)), close() {} };

  await ctl.onHarness({ id: "h1", command: "harness_start", args: { cwd: dirA } });
  await ctl.onHarness({ id: "h2", command: "harness_start", args: { sessionId: "s1" } });
  assert.deepEqual(frames.map((f) => [f.id, f.ok, f.status]), [["h1", true, "started"], ["h2", true, "started"]]);
  const files = await until(() => {
    const names = fs.readdirSync(seenDir);
    return names.length === 2 ? names.map((n) => fs.readFileSync(path.join(seenDir, n), "utf8").trim().split("\n")) : null;
  }, 5000, "两份 start-pi 都跑起来");
  const byCwd = Object.fromEntries(files.map((lines) => [lines[0], lines.slice(1)]));
  assert.deepEqual(byCwd[dirA], [], "新会话不带参数");
  assert.deepEqual(byCwd[dirB], ["--session", sessionPath], "会话文件路径原样到达");
  const names = tmuxPanes().map((p) => p.name);
  assert.ok(names.some((n) => /^pi-my_app_s_dir-[a-z0-9]+$/.test(n)), names.join(" "));
  assert.ok(names.some((n) => /^pi-b_x_y-[a-z0-9]+$/.test(n)), names.join(" "));
});

test("device.sh 全流程（真 tmux + 进程内 relay）：init → pair → up → 网页 harness_start → pi 带着令牌起来 → status / sessions → down", { skip: NO_TMUX }, async (t) => {
  const box = sandbox(t);
  const { relay, frames, take, send } = await relayWithViewer(t, box.root);
  const app = path.join(box.root, "work", "app");
  const weird = path.join(box.root, "work", "we ird $x");
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(weird, { recursive: true });
  fakePi(path.join(box.bin, "pi"), box.seenDir);
  const relayUrl = `ws://127.0.0.1:${relay.localPort}`;
  const viewerEnv = { PI_REMOTE_VIEWER_PORT: String(relay.viewerPort) };

  const init = await box.device(["init", "--projects", `${app};${weird}`, "--relay", relayUrl, "--name", "阿里云"]);
  assert.equal(init.code, 0, init.stderr);
  send({ type: "pair_create", id: "pc1", name: "阿里云", adminToken: ADMIN_TOKEN });
  const code = (await take((f) => f.type === "ack" && f.id === "pc1", "配对码")).data.code;
  const pair = await box.device(["pair", code]);
  assert.equal(pair.code, 0, pair.stdout + pair.stderr);
  const env = attach.parseEnv(fs.readFileSync(path.join(box.kit, ".env"), "utf8"));
  assert.equal(env.PI_REMOTE_PI_BIN, path.join(box.bin, "pi"));

  const up = await box.device(["up", "--max-hours", "1"], viewerEnv);
  assert.equal(up.code, 0, up.stdout + up.stderr);
  assert.match(up.stdout, /连接窗口已打开（tmux 会话 pi-remote-attach）/);
  const listed = await take((f) => f.type === "room_list" && (f.devices || []).some((d) => d.id === env.PI_REMOTE_DEVICE_ID && d.online), "设备上线");
  const dev = listed.devices.find((d) => d.id === env.PI_REMOTE_DEVICE_ID);
  assert.deepEqual([dev.name, dev.auth, dev.paired, dev.platform], ["阿里云", "token", true, attach.platformId(process.platform)]);
  assert.deepEqual(dev.projects, [app, weird]);
  const state = JSON.parse(fs.readFileSync(path.join(box.home, ".pi", "agent", "remote-attach.json"), "utf8"));
  assert.equal(state.deviceId, env.PI_REMOTE_DEVICE_ID);

  send({ type: "command", id: "h1", deviceId: env.PI_REMOTE_DEVICE_ID, command: "harness_start", args: { cwd: weird } });
  const ack = await take((f) => f.type === "ack" && f.id === "h1", "harness_start 回执");
  assert.equal(ack.ok, true, JSON.stringify(ack));
  assert.equal(ack.data.status, "started");
  const [pi] = await until(() => (seen(box.seenDir).length ? seen(box.seenDir) : null), 5000, "pi 起来");
  assert.equal(pi[0], weird, "在网页选的目录里起");
  assert.deepEqual(pi.slice(1, 4), [`DEV=${env.PI_REMOTE_DEVICE_ID}`, "TOK=set", `RELAY=${relayUrl}`], "start-pi.sh 把 .env 的身份和令牌交给 pi");

  const sessions = await box.device(["sessions"]);
  assert.match(sessions.stdout, /pi-we_ird_x-[a-z0-9]+ .*we ird \$x .*运行中/);
  const status = await box.device(["status"], viewerEnv);
  assert.match(status.stdout, /连接窗口开着（tmux 会话 pi-remote-attach）/);
  assert.match(status.stdout, /relay：ws:\/\/127\.0\.0\.1:\d+ · proto 4 · .* · 在线设备 1/);
  assert.match(status.stdout, /阿里云（.*） · 已配对/);

  const again = await box.device(["up"], viewerEnv);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /连接窗口开着/);

  frames.length = 0;
  const down = await box.device(["down"]);
  assert.equal(down.code, 0, down.stdout + down.stderr);
  assert.equal(fs.existsSync(path.join(box.home, ".pi", "agent", "remote-attach.json")), false, "窗口关了，状态文件跟着删（扩展据此断开）");
  await take((f) => f.type === "room_list" && (f.devices || []).some((d) => d.id === env.PI_REMOTE_DEVICE_ID && !d.online), "设备离线");
  const left = tmuxPanes();
  assert.equal(left.some((p) => p.name === "pi-remote-attach"), false);
  assert.ok(left.some((p) => /^pi-we_ird_x-/.test(p.name) && !p.dead), "已拉起的 pi 不跟着窗口关");
});

test("pi 起不来时 tmux 留现场（≥3.2）：sessions 标退出码、clean 收掉；目录名末尾是分号也能起", { skip: NO_TMUX }, async (t) => {
  const box = sandbox(t);
  const semi = path.join(box.root, "work", "a b;");
  fs.mkdirSync(semi, { recursive: true });
  fakePi(path.join(box.bin, "pi"), box.seenDir);
  fs.writeFileSync(path.join(box.kit, ".env"), `PI_REMOTE_PI_BIN=${path.join(box.bin, "pi")}\n`, { mode: 0o600 });

  const ok = await box.device(["start", semi]);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  const [pi] = await until(() => (seen(box.seenDir).length ? seen(box.seenDir) : null), 5000, "pi 起来");
  assert.equal(pi[0], semi, "末尾的 ; 没被 tmux 当成命令分隔符");

  fs.writeFileSync(path.join(box.kit, ".env"), `PI_REMOTE_PI_BIN=${path.join(box.bin, "no-such-pi")}\n`, { mode: 0o600 });
  const work = path.join(box.root, "work", "broken");
  fs.mkdirSync(work, { recursive: true });
  const bad = await box.device(["start", work]);
  assert.equal(bad.code, 0, bad.stderr);
  const name = /tmux 会话 (pi-broken-[a-z0-9]+)/.exec(bad.stdout)[1];
  if (!KEEPS_FAILED) {
    await until(() => !tmuxPanes().some((p) => p.name === name), 5000, "旧 tmux 没有 failed：会话直接结束");
    return;
  }
  const pane = await until(() => tmuxPanes().find((p) => p.name === name && p.dead), 5000, "失败的窗格留着");
  assert.equal(pane.status, 127, "start-pi.sh 找不到 pi 的退出码");
  const ls = await box.device(["sessions"]);
  assert.match(ls.stdout, new RegExp(`${name} .*已退出（退出码 127）`));
  const shot = spawnSync("tmux", ["capture-pane", "-p", "-t", `=${name}:`], { encoding: "utf8" });
  assert.match(shot.stdout, /pi not found/, "tmux attach 进去看得到原因");
  const clean = await box.device(["clean"]);
  assert.match(clean.stdout, new RegExp(name));
  assert.equal(tmuxPanes().some((p) => p.name === name), false);
  assert.ok(tmuxPanes().some((p) => /^pi-a_b_-/.test(p.name) && !p.dead), "clean 只收已退出的");
});

test("attach（真 tmux）：目录名末尾是分号也能起；pi 当场退出回 spawn_failed（带退出码与原因）、现场留着，修好后同目录立刻能重拉", { skip: NO_TMUX }, async (t) => {
  const root = tmp("pi-linux-semi-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "home"));
  ownTmux(t, path.join(root, "home"));
  const dir = path.join(root, "a b;");
  fs.mkdirSync(dir);
  const out = path.join(root, "seen.txt");
  const startPi = path.join(root, "start-pi.sh");
  const good = `printf '%s\\n' "$PWD" > ${attach.shellQuote(out)}\nexec sleep 600\n`;
  fs.writeFileSync(startPi, "echo '[error] pi not found: install it (npm i -g) or set PI_REMOTE_PI_BIN in .env' >&2\nexit 127\n");
  const frames = [];
  const ctl = new attach.AttachController({ platform: "linux", relay: "ws://127.0.0.1:9", deviceId: "d", projects: [dir], attachFile: path.join(root, "s.json"), startPi, status: false, writeOut: () => {}, exit: () => {}, tmuxSettleMs: 400 });
  ctl.ws = { readyState: 1, send: (s) => frames.push(JSON.parse(s)), close() {} };

  await ctl.onHarness({ id: "bad", args: { cwd: dir } });
  const bad = frames.find((f) => f.id === "bad");
  assert.deepEqual([bad.ok, bad.code], [false, "spawn_failed"], JSON.stringify(bad));
  if (KEEPS_FAILED) {
    assert.match(bad.error, /pi 退出了（退出码 127）：\[error\] pi not found/);
    const name = /tmux attach -t (pi-\S+) 看现场/.exec(bad.error)[1];
    assert.ok(tmuxPanes().some((p) => p.name === name && p.dead && p.status === 127), "失败现场留着");
  } else {
    assert.match(bad.error, /pi 刚起来就退出了/);
  }

  fs.writeFileSync(startPi, good);
  await ctl.onHarness({ id: "good", args: { cwd: dir } });
  assert.deepEqual([frames.find((f) => f.id === "good").ok, frames.find((f) => f.id === "good").status], [true, "started"], "上一次失败没占着目录");
  await until(() => fs.existsSync(out), 3000, "pi 起来");
  assert.equal(fs.readFileSync(out, "utf8").trim(), dir, "末尾的 ; 原样到达，没被 tmux 当成分隔符");
});
