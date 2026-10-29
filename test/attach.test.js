const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const attach = require("../deploy/attach.cjs");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-attach-"));
}

// P9：attach 的会话根目录统一走 sessionRootFromEnv()（认 PI_CODING_AGENT_SESSION_DIR）。
// 默认指到临时目录，保证任何用例都不会读/写真实 ~/.pi；需要更强隔离的用例在用例内部覆盖。
const SHARED_SESSION_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-attach-session-root-"));
process.env.PI_CODING_AGENT_SESSION_DIR = SHARED_SESSION_ROOT;
process.on("exit", () => {
  try {
    fs.rmSync(SHARED_SESSION_ROOT, { recursive: true, force: true });
  } catch {}
});

// 下面多数用例写的是 Windows 路径：显式按 Windows 规则跑，在 Mac / Linux 上也照样验证 Windows 行为
function makeCtl(extra = {}) {
  const dir = tmpDir();
  const spawned = [];
  const frames = [];
  const logs = [];
  const ctl = new attach.AttachController({
    platform: "win32",
    relay: "ws://127.0.0.1:7001",
    token: "tok",
    deviceId: "dev-1",
    accountId: "admin",
    deviceName: "Windows",
    projects: ["D:\\work\\app"],
    attachFile: path.join(dir, "remote-attach.json"),
    maxHours: 12,
    existsDir: () => true,
    // 退出码落盘写到沙箱，不碰真实 ~/.pi；Windows 上线等待由需要的用例显式打开
    exitHome: dir,
    launchWaitMs: 0,
    spawnImpl: (file, args, opts) => {
      spawned.push({ file, args, opts });
      return { unref() {}, on() {} };
    },
    sessionLookup: async (id) => (id === "s1" ? { id: "s1", path: "C:\\sess\\t_s1.jsonl", cwd: "D:\\work\\app", deleted: false } : null),
    writeOut: (line) => logs.push(String(line)),
    exit: () => {},
    status: false,
    ...extra,
  });
  ctl.ws = {
    readyState: 1,
    send(s) {
      frames.push(JSON.parse(s));
    },
    close() {},
  };
  return { ctl, spawned, frames, logs, dir };
}

test("parseArgs：目录、--max-hours、--init；拒绝 --headless 和非正数", () => {
  const args = attach.parseArgs(["D:\\pi-myself", "D:\\work\\app", "--max-hours", "0.02", "--init"]);
  assert.deepEqual(args.dirs, ["D:\\pi-myself", "D:\\work\\app"]);
  assert.equal(args.maxHours, 0.02);
  assert.equal(args.init, true);
  assert.equal(attach.parseArgs(["--max-hours=1.5"]).maxHours, 1.5);
  assert.throws(() => attach.parseArgs(["--headless"]), /不支持 --headless/);
  assert.throws(() => attach.parseArgs(["--max-hours", "0"]), /正数/);
  assert.throws(() => attach.parseArgs(["--nope"]), /未知参数/);
});

test("--init 写入 deviceId/name/account/relay，已有 deviceId 时不改文件", () => {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, "PI_REMOTE_RELAY=ws://example:7001\nPI_REMOTE_TOKEN=secret\n", "utf8");
  if (process.platform !== "win32") fs.chmodSync(envPath, 0o644);
  const first = attach.initEnvFile(envPath, { uuid: "uuid-1", env: {}, platform: "win32" });
  assert.equal(first.changed, true);
  assert.equal(first.deviceId, "uuid-1");
  // --init 生成/追加的 .env 里有共享令牌：统一 0600
  if (process.platform !== "win32") assert.equal((fs.statSync(envPath).mode & 0o777).toString(8), "600");
  const text = fs.readFileSync(envPath, "utf8");
  assert.match(text, /PI_REMOTE_DEVICE_ID=uuid-1/);
  assert.match(text, /PI_REMOTE_ACCOUNT=admin/);
  assert.match(text, /PI_REMOTE_DEVICE_NAME=Windows/);
  assert.match(text, /PI_REMOTE_TOKEN=secret/);
  assert.match(text, /PI_REMOTE_RELAY=ws:\/\/example:7001/);
  assert.equal(text.match(/PI_REMOTE_RELAY=/g).length, 1);
  const second = attach.initEnvFile(envPath, { uuid: "uuid-2", env: { PI_REMOTE_DEVICE_ID: "from-env" } });
  assert.equal(second.changed, false);
  assert.equal(second.deviceId, "uuid-1");
  assert.equal(fs.readFileSync(envPath, "utf8"), text);

  const shadowed = path.join(dir, "shadow.env");
  fs.writeFileSync(shadowed, 'PI_REMOTE_DEVICE_ID="keep-me"\nPI_REMOTE_DEVICE_ID=\n', "utf8");
  const kept = attach.initEnvFile(shadowed, { uuid: "uuid-3", env: {} });
  assert.equal(kept.changed, false);
  assert.equal(kept.deviceId, "keep-me");
  assert.equal(fs.readFileSync(shadowed, "utf8").includes("uuid-3"), false);

  // macOS：新装的设备名用电脑名，不叫千篇一律的 "Mac"
  const macEnv = path.join(dir, "mac.env");
  attach.initEnvFile(macEnv, { uuid: "uuid-mac", env: {}, platform: "darwin", deviceName: "a-MacBook-Pro" });
  assert.match(fs.readFileSync(macEnv, "utf8"), /PI_REMOTE_DEVICE_NAME=a-MacBook-Pro/);
  const fallback = path.join(dir, "fallback.env");
  attach.initEnvFile(fallback, { uuid: "uuid-fb", env: {}, platform: "darwin", deviceName: "" });
  assert.match(fs.readFileSync(fallback, "utf8"), /PI_REMOTE_DEVICE_NAME=Mac/);

  const bare = path.join(dir, "bare.env");
  fs.writeFileSync(bare, "PI_REMOTE_TOKEN=secret\n", "utf8");
  const fromEnv = attach.initEnvFile(bare, { uuid: "uuid-4", env: { PI_REMOTE_DEVICE_ID: "from-env" } });
  assert.equal(fromEnv.changed, false);
  assert.equal(fromEnv.deviceId, "from-env");
  assert.equal(fs.readFileSync(bare, "utf8").includes("uuid-4"), false);
  assert.equal(fs.readFileSync(bare, "utf8").includes("PI_REMOTE_DEVICE_ID="), false);

  for (const [platform, name] of [["darwin", "Mac"], ["linux", "Linux"]]) {
    const p = path.join(dir, `${platform}.env`);
    attach.initEnvFile(p, { uuid: "uuid-" + platform, env: {}, platform });
    assert.match(fs.readFileSync(p, "utf8"), new RegExp(`PI_REMOTE_DEVICE_NAME=${name}\\n`), platform + " 的缺省设备名");
  }
});

test("loadConfig：文件里的非空值覆盖环境变量，account 缺省 admin", () => {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, "PI_REMOTE_TOKEN=\nPI_REMOTE_RELAY=ws://from-file:7001\nPI_REMOTE_PROJECTS=D:\\a; D:\\b;\n", "utf8");
  const cfg = attach.loadConfig(envPath, {
    PI_REMOTE_TOKEN: "from-env",
    PI_REMOTE_RELAY: "ws://from-env:7001",
    PI_REMOTE_DEVICE_ID: "from-env-id",
  }, "win32");
  assert.equal(cfg.token, "from-env");
  assert.equal(cfg.relay, "ws://from-file:7001");
  assert.equal(cfg.deviceId, "from-env-id");
  assert.equal(cfg.accountId, "admin");
  assert.equal(cfg.deviceName, "Windows");
  assert.deepEqual(cfg.projects, ["D:\\a", "D:\\b"]);
  assert.equal(cfg.launcher, "");

  const mac = attach.loadConfig(envPath, { PI_REMOTE_LAUNCHER: "tmux", PI_REMOTE_TERMINAL_APP: "iTerm" }, "darwin");
  assert.equal(mac.deviceName, "Mac");
  assert.equal(mac.launcher, "tmux");
  assert.equal(mac.terminalApp, "iTerm");
});

test("状态文件含 deviceId/accountId/relay/startedAt/expiresAt；到期或被顶替后删除，断线重连不删", () => {
  const { ctl, logs } = makeCtl({ now: 1_000_000, maxHours: 0.02 });
  assert.equal(ctl.expiresAt - ctl.startedAt, Math.round(0.02 * 3600 * 1000));
  ctl.writeState();
  const state = JSON.parse(fs.readFileSync(ctl.attachFile, "utf8"));
  assert.equal(state.deviceId, "dev-1");
  assert.equal(state.accountId, "admin");
  assert.equal(state.relay, "ws://127.0.0.1:7001");
  assert.equal(state.startedAt, ctl.startedAt);
  assert.equal(state.expiresAt, ctl.expiresAt);

  ctl.connected = true;
  ctl.onSocketClose();
  assert.equal(fs.existsSync(ctl.attachFile), true);
  assert.equal(ctl.reconnecting, true);
  assert.ok(ctl.reconnectTimer);
  assert.equal(ctl.reconnectTimer.hasRef(), true);
  clearTimeout(ctl.reconnectTimer);
  ctl.reconnectTimer = null;

  ctl.handleMessage({ type: "device_replaced" });
  assert.equal(fs.existsSync(ctl.attachFile), false);
  assert.ok(logs.includes("另一个窗口已开启"));

  const again = makeCtl();
  again.ctl.writeState();
  again.ctl.onExpire();
  assert.equal(fs.existsSync(again.ctl.attachFile), false);
  assert.ok(again.logs.includes("窗口已到时间，已断开"));
});

test("窗口定时器保持进程；进程退出钩子会删掉状态文件", () => {
  const { ctl } = makeCtl({
    WebSocketImpl: class {
      constructor() {}
      on() {}
      close() {}
    },
  });
  try {
    ctl.start();
    // 认证通过前不写状态文件：失败/提前退出时磁盘上不留"窗口开着"的假象
    assert.equal(fs.existsSync(ctl.attachFile), false);
    assert.equal(ctl.expiryTimer.hasRef(), true);
    assert.equal(typeof ctl._onExit, "function");
    ctl.handleMessage({ type: "auth_result", ok: true });
    assert.equal(fs.existsSync(ctl.attachFile), true, "认证成功才写状态文件");
    ctl._onExit();
    assert.equal(fs.existsSync(ctl.attachFile), false);
  } finally {
    ctl.shutdown();
  }
});

test("auth 成功后发 device_register，平台 windows，projects 与到期时刻原样带上", () => {
  const { ctl, frames } = makeCtl({ dirs: ["D:\\work\\app"] });
  let boots = 0;
  ctl.bootDirs = async () => {
    boots += 1;
  };
  ctl.handleMessage({ type: "auth_result", ok: true });
  ctl.handleMessage({ type: "auth_result", ok: true });
  // 目录拉起要等第一份 room_list：此刻 onlineRooms 还是空的，立即起会把已在跑的 pi 再拉一份
  assert.equal(boots, 0);
  ctl.handleMessage({ type: "room_list", rooms: [] });
  assert.equal(boots, 1);
  assert.equal(frames[0].type, "device_register");
  assert.equal(frames[0].accountId, "admin");
  assert.equal(frames[0].device.id, "dev-1");
  assert.equal(frames[0].device.name, "Windows");
  assert.equal(frames[0].device.platform, "windows");
  assert.deepEqual(frames[0].device.projects, ["D:\\work\\app"]);
  assert.equal(frames[0].device.windowExpiresAt, ctl.expiresAt);
  assert.equal(frames.length, 2);
});

test("状态行：已连接剩余时间与活动会话数，断线显示重连中", () => {
  const now = 1_700_000_000_000;
  const viewer = "http://127.0.0.1:7002/";
  const up = attach.statusText({ connected: true, reconnecting: false, expiresAt: now + 90_000, now, activeCount: 2, viewer });
  assert.match(up, /设备已连接 · 剩余 01:30 · 活动会话 2 个/);
  assert.match(up, /viewer 地址 http:\/\/127\.0\.0\.1:7002\//);
  assert.equal(attach.formatRemain(2 * 3600 * 1000 + 5 * 60 * 1000), "02:05");
  const down = attach.statusText({ connected: false, reconnecting: true, expiresAt: now, now, activeCount: 0, viewer });
  assert.match(down, /重连中…/);
  assert.equal(attach.viewerUrlFromRelay("wss://example.com:7001/ignored"), "https://example.com:7002/");
});

test("cwd 必须精确命中白名单（大小写与斜杠不计，子目录不算）", () => {
  const projects = ["D:\\work\\app"];
  assert.equal(attach.cwdAllowed("D:/work/app", projects, "win32"), true);
  assert.equal(attach.cwdAllowed("d:\\work\\app\\", projects, "win32"), true);
  assert.equal(attach.cwdAllowed("D:\\work\\app\\sub", projects, "win32"), false);
  assert.equal(attach.cwdAllowed("D:\\other", projects, "win32"), false);
  assert.equal(attach.cwdAllowed("D:\\work\\app&calc", projects, "win32"), false);
});

test("macOS 白名单不分大小写，Linux 区分；末尾斜杠不计，子目录不算", () => {
  const projects = ["/Users/user/CLI/Pi-Remote"];
  assert.equal(attach.cwdAllowed("/users/user/cli/pi-remote/", projects, "darwin"), true, "APFS 默认不分大小写");
  assert.equal(attach.cwdAllowed("/Users/user/CLI/Pi-Remote/sub", projects, "darwin"), false);
  assert.equal(attach.cwdAllowed("/Users/user/CLI/Pi-Remote", projects, "linux"), true);
  assert.equal(attach.cwdAllowed("/users/user/cli/pi-remote", projects, "linux"), false, "Linux 路径区分大小写");
  assert.equal(attach.cwdAllowed("/srv/a&b $x 'q'", ["/srv/a&b $x 'q'/"], "linux"), true, "POSIX 上 & $ 引号都是合法目录名");
  assert.equal(attach.cwdAllowed("/srv/a\nb", ["/srv/a\nb"], "linux"), false, "换行一律拒绝");
});

test("本机 POSIX 上白名单按真实路径比：符号链接指向的目录算同一个", { skip: process.platform === "win32" }, () => {
  const root = fs.realpathSync.native(tmpDir());
  const real = path.join(root, "Real Project");
  fs.mkdirSync(real);
  const link = path.join(root, "link");
  fs.symlinkSync(real, link);
  assert.equal(attach.cwdAllowed(real, [link]), true, "白名单写链接，pi 报的是真实路径");
  assert.equal(attach.cwdAllowed(link, [real]), true);
  assert.equal(attach.encodeCwdDir(link), attach.encodeCwdDir(real), "会话目录名按真实路径算，和 pi 一致");
});

test("平台标识与缺省设备名：windows / macos / linux", () => {
  assert.equal(attach.platformId("win32"), "windows");
  assert.equal(attach.platformId("darwin"), "macos");
  assert.equal(attach.platformId("linux"), "linux");
  assert.equal(attach.defaultDeviceName("win32"), "Windows");
  assert.equal(attach.defaultDeviceName("darwin"), "Mac");
  assert.equal(attach.defaultDeviceName("linux"), "Linux");
  const frame = attach.deviceRegisterFrame({ deviceId: "d", projects: ["/x"], windowExpiresAt: 1, platform: "darwin" });
  assert.equal(frame.device.platform, "macos");
  assert.equal(frame.device.name, "Mac");
  assert.equal(attach.startPiFor("win32").endsWith("start-pi.cmd"), true);
  assert.equal(attach.startPiFor("darwin").endsWith("start-pi.sh"), true);
  assert.equal(attach.startPiFor("linux").endsWith("start-pi.sh"), true);
});

test("拉起方式：Windows 固定新控制台；macOS 缺省 Terminal 可改 tmux；Linux 只有 tmux", () => {
  assert.deepEqual(attach.resolveLauncher("", "win32"), { launcher: "console", warning: "" });
  assert.equal(attach.resolveLauncher("tmux", "win32").launcher, "console");
  assert.match(attach.resolveLauncher("tmux", "win32").warning, /Windows/);
  assert.deepEqual(attach.resolveLauncher("", "darwin"), { launcher: "terminal", warning: "" });
  assert.deepEqual(attach.resolveLauncher("TMUX", "darwin"), { launcher: "tmux", warning: "" });
  assert.deepEqual(attach.resolveLauncher("", "linux"), { launcher: "tmux", warning: "" });
  assert.equal(attach.resolveLauncher("terminal", "linux").launcher, "tmux");
  assert.match(attach.resolveLauncher("terminal", "linux").warning, /不支持/);
  assert.equal(attach.resolveLauncher("iterm", "darwin").launcher, "terminal");
});

test("tmux：命令拆成独立参数直接 exec，不经 shell；会话名只含安全字符", () => {
  const spec = attach.buildSpawnSpec({
    cwd: "/srv/my app's $dir",
    sessionPath: "/home/u/.pi/agent/sessions/x/t_s1.jsonl",
    startPi: "/opt/pi remote/deploy/start-pi.sh",
    platform: "linux",
  });
  assert.equal(spec.file, "tmux");
  assert.deepEqual(spec.args.slice(0, 3), ["new-session", "-d", "-s"]);
  assert.match(spec.args[3], /^pi-my_app_s_dir-[a-z0-9]+$/);
  assert.deepEqual(spec.args.slice(4), [
    "-c", "/srv/my app's $dir",
    "/bin/bash", "/opt/pi remote/deploy/start-pi.sh",
    "--session", "/home/u/.pi/agent/sessions/x/t_s1.jsonl",
  ]);
  assert.equal(spec.options.detached, true);
  assert.equal(spec.options.stdio, "ignore");
  assert.notEqual(spec.options.shell, true);
  assert.equal(spec.script, undefined);
});

test("tmux 退出码落盘：拉起时注入 PI_REMOTE_EXIT_FILE，路径按会话名确定；会话名不能穿越目录", () => {
  const home = tmpDir();
  const spec = attach.buildSpawnSpec({
    cwd: "/srv/app",
    startPi: "/k/start-pi.sh",
    platform: "linux",
    keepFailed: true,
    exitHome: home,
  });
  const name = spec.tmuxSession;
  const envAt = spec.args.indexOf("/usr/bin/env");
  assert.ok(envAt > 0, spec.args.join(" "));
  assert.equal(spec.args[envAt + 1], `PI_REMOTE_EXIT_FILE=${attach.exitCodePath(name, home)}`);
  assert.equal(spec.args[envAt + 2], "/bin/bash");
  assert.equal(spec.exitFile, attach.exitCodePath(name, home));
  const evil = attach.exitCodePath("../../etc/passwd", home);
  assert.equal(path.dirname(evil), path.join(home, ".pi", "agent", "pi-remote-exit"), "会话名只进安全文件名，不进路径");
  assert.doesNotMatch(path.basename(evil), /[\\/]/, "文件名里不能有路径分隔符");
  assert.equal(attach.readExitCode(name, home), null);
  assert.equal(attach.writeExitCodePath(attach.exitCodePath(name, home), 143), true);
  assert.equal(attach.readExitCode(name, home), 143);
  attach.removeExitCode(name, home);
  assert.equal(attach.readExitCode(name, home), null);
});

test("attach 自己的退出码也落盘：device.sh up 在 tmux 丢窗格字段时还能报真实退出码", () => {
  const dir = tmpDir();
  const exitFile = path.join(dir, "attach.code");
  const codes = [];
  const { ctl } = makeCtl({ exitFile, exit: (code) => codes.push(code) });
  ctl.shutdown("鉴权失败", 1);
  assert.deepEqual(codes, [1], "退出码仍要反映到进程");
  assert.equal(fs.readFileSync(exitFile, "utf8").trim(), "1");
  ctl.shutdown("再来一次", 0);
  assert.equal(fs.readFileSync(exitFile, "utf8").trim(), "1", "已落盘后不能被第二次 shutdown 覆盖");
});

test("findPiBinary：PATH 找不到时从 HOME 的 nvm 版本目录按序找", () => {
  const home = tmpDir();
  const oldDir = path.join(home, ".nvm", "versions", "node", "v9.1.0", "bin");
  const newDir = path.join(home, ".nvm", "versions", "node", "v22.23.4", "bin");
  for (const dir of [oldDir, newDir]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "pi"), "", { mode: 0o755 });
  }
  const found = attach.findPiBinary(() => ({ status: 1, stdout: "" }), { HOME: home, PATH: "" });
  assert.equal(found, path.join(newDir, "pi"));
});

test("tmux 3.4 非 UTF-8：优先注入 C.UTF-8 / en_US.UTF-8；已是 UTF-8 或探不到不注入", () => {
  const localeRun = (stdout) => () => ({ status: 0, stdout });
  assert.equal(attach.availableUtf8Locale(localeRun("C\nC.utf8\nen_US.utf8\n"), {}, "linux"), "C.UTF-8");
  assert.equal(attach.availableUtf8Locale(localeRun("C\nen_US.utf8\n"), {}, "darwin"), "en_US.UTF-8");
  assert.equal(attach.availableUtf8Locale(localeRun("C\nPOSIX\n"), {}, "linux"), "");
  assert.equal(attach.availableUtf8Locale(() => ({ status: 1, stdout: "" }), {}, "linux"), "");
  assert.equal(attach.tmuxLocaleOverride(localeRun("C.utf8\n"), { LANG: "C" }, "linux"), "C.UTF-8");
  assert.equal(attach.tmuxLocaleOverride(localeRun("C.utf8\n"), { LANG: "C.UTF-8" }, "linux"), "", "已经是 UTF-8 不重复注入");
  assert.deepEqual(attach.tmuxEnvWithLocale({ LANG: "C", PATH: "/bin" }, "C.UTF-8"), { LANG: "C.UTF-8", PATH: "/bin", LC_ALL: "C.UTF-8" });
});

test("macOS Terminal：一次性 .command 脚本先删自己，路径单引号转义后原样到达 start-pi", { skip: process.platform === "win32" }, () => {
  const root = fs.realpathSync.native(tmpDir());
  const cwd = path.join(root, `we ird 'dir' $HOME \`id\` & ; "q"`);
  fs.mkdirSync(cwd);
  const out = path.join(root, "seen.txt");
  const fake = path.join(root, "fake start-pi.sh");
  fs.writeFileSync(fake, `printf '%s\\n' "$PWD" "$@" > ${attach.shellQuote(out)}\n`, "utf8");
  const sessionPath = path.join(root, "s 'x' $(id).jsonl");
  const spec = attach.buildSpawnSpec({ cwd, sessionPath, startPi: fake, platform: "darwin", scriptDir: root });
  assert.equal(spec.file, "open");
  assert.deepEqual(spec.args, ["-a", "Terminal", spec.script.path]);
  assert.equal(path.dirname(spec.script.path), root);
  assert.match(spec.script.path, /\.command$/);
  assert.equal(spec.script.mode, 0o700);
  assert.match(spec.script.text, /^#!\/bin\/bash\nrm -f -- "\$0"\n/);
  assert.equal(attach.buildSpawnSpec({ cwd, startPi: fake, platform: "darwin", terminalApp: "iTerm", scriptDir: root }).args[1], "iTerm");

  fs.writeFileSync(spec.script.path, spec.script.text, { mode: spec.script.mode });
  const run = require("node:child_process").spawnSync("/bin/bash", [spec.script.path], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.existsSync(spec.script.path), false, "脚本跑起来先删自己");
  assert.deepEqual(fs.readFileSync(out, "utf8").split("\n").slice(0, 3), [cwd, "--session", sessionPath]);
});

test("macOS harness_start：写脚本交给 open；open 失败时删脚本、清占用、可重试", async () => {
  const scriptDir = tmpDir();
  const children = [];
  const { ctl, spawned, frames } = makeCtl({
    platform: "darwin",
    projects: ["/Users/user/work/app"],
    scriptDir,
    // 这个用例只验脚本与 open 失败：不打开"等房间上线"，否则 open 退出码要等 Promise
    launchWaitMs: 0,
    spawnImpl: (file, args, opts) => {
      spawned.push({ file, args, opts });
      const handlers = {};
      const child = { unref() {}, on(event, fn) { handlers[event] = fn; } };
      children.push(handlers);
      return child;
    },
  });
  const startPi = path.join(scriptDir, "start-pi.sh");
  fs.writeFileSync(startPi, "", "utf8");
  ctl.startPi = startPi;
  await ctl.onHarness({ id: "m1", args: { cwd: "/users/user/work/app/" } });
  assert.equal(frames[0].ok, true, JSON.stringify(frames[0]));
  assert.equal(frames[0].status, "started");
  assert.equal(spawned[0].file, "open");
  const script = spawned[0].args[2];
  assert.equal(fs.existsSync(script), true, "脚本在 open 之前写好");
  assert.match(fs.readFileSync(script, "utf8"), /cd -- '\/users\/user\/work\/app' \|\| exit 1/);
  if (process.platform !== "win32") assert.equal((fs.statSync(script).mode & 0o777).toString(8), "700");

  const dup = await ctl.launch({ cwd: "/Users/user/work/app", source: "remote" });
  assert.equal(dup.status, "already_running", "大小写不同也是同一个目录");

  children[0].exit(1);
  assert.equal(fs.existsSync(script), false, "open 失败要删掉脚本");
  assert.equal(ctl.spawnedByCwd.size, 0, "open 失败要清占用");
  const again = await ctl.launch({ cwd: "/Users/user/work/app", source: "remote" });
  assert.equal(again.status, "started");
  children[1].exit(0);
  assert.equal(ctl.spawnedByCwd.size, 1, "正常退出不清占用");

  const reg = ctl.registerFrame();
  assert.equal(reg.device.platform, "macos");
});

test("macOS Terminal：等到房间上线才回 started，并把 roomId 带回网页", async () => {
  const scriptDir = tmpDir();
  const { ctl, spawned, frames } = makeCtl({
    platform: "darwin",
    projects: ["/Users/user/work/app"],
    scriptDir,
    launchWaitMs: 800,
    spawnImpl: (file, args, opts) => {
      spawned.push({ file, args, opts });
      return { unref() {}, on() {} };
    },
  });
  fs.writeFileSync(path.join(scriptDir, "start-pi.sh"), "", "utf8");
  ctl.startPi = path.join(scriptDir, "start-pi.sh");
  const pending = ctl.onHarness({ id: "m-wait", args: { cwd: "/Users/user/work/app" } });
  // 房间是 Terminal 里新起的 pi 注册的：在等待窗口内到达
  await new Promise((r) => setTimeout(r, 30));
  ctl.observeRooms([{ id: "room-new", cwd: "/Users/user/work/app", online: true, deviceId: "dev-1" }]);
  await pending;
  assert.equal(frames[0].ok, true, JSON.stringify(frames[0]));
  assert.equal(frames[0].status, "started");
  assert.equal(frames[0].roomId, "room-new");
  assert.equal(frames[0].data.roomId, "room-new");
  assert.equal(ctl.spawnedByCwd.size, 1, "成功上线要留着占用标记");
});

test("macOS Terminal：软超时按已启动处理，不删脚本/不清占用；宽限期后才允许重试", async () => {
  const scriptDir = tmpDir();
  const { ctl, spawned, frames } = makeCtl({
    platform: "darwin",
    projects: ["/Users/user/work/app"],
    scriptDir,
    launchWaitMs: 80,
    claimGraceMs: 60,
    spawnImpl: (file, args, opts) => {
      spawned.push({ file, args, opts });
      return { unref() {}, on() {} };
    },
  });
  fs.writeFileSync(path.join(scriptDir, "start-pi.sh"), "", "utf8");
  ctl.startPi = path.join(scriptDir, "start-pi.sh");

  await ctl.onHarness({ id: "m-timeout", args: { cwd: "/Users/user/work/app" } });
  assert.equal(frames[0].ok, true, JSON.stringify(frames[0]));
  assert.equal(frames[0].status, "started");
  assert.equal(ctl.spawnedByCwd.size, 1, "超时不能清占用：Terminal 可能只是还没跑起来，重试会起第二份 pi");
  const script = spawned[0].args[2];
  assert.equal(fs.existsSync(script), true, "超时不能删一次性脚本，否则 Terminal 还没执行就打不开了");

  const dup = await ctl.launch({ cwd: "/Users/user/work/app", source: "remote" });
  assert.equal(dup.status, "already_running", "宽限期内重试不能起第二份");

  await new Promise((r) => setTimeout(r, 120));
  assert.equal(ctl.spawnedByCwd.size, 0, "宽限期后释放占用，目录不会被锁 10 分钟");
  const again = ctl.launch({ cwd: "/Users/user/work/app", source: "remote" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(spawned.length, 2);
  ctl.observeRooms([{ id: "room-2", cwd: "/Users/user/work/app", online: true, deviceId: "dev-1" }]);
  const result = await again;
  assert.equal(result.status, "started");
  assert.equal(result.roomId, "room-2");
});

test("macOS Terminal：房间在宽限期内上线就取消占用回收，不会 30s 后误删", async () => {
  const scriptDir = tmpDir();
  const { ctl, logs } = makeCtl({
    platform: "darwin",
    projects: ["/Users/user/work/app"],
    scriptDir,
    launchWaitMs: 60,
    claimGraceMs: 100,
    spawnImpl: () => ({ unref() {}, on() {} }),
  });
  fs.writeFileSync(path.join(scriptDir, "start-pi.sh"), "", "utf8");
  ctl.startPi = path.join(scriptDir, "start-pi.sh");
  await ctl.launch({ cwd: "/Users/user/work/app", source: "remote" });
  assert.equal(ctl.spawnedByCwd.size, 1);
  ctl.observeRooms([{ id: "room-late", cwd: "/Users/user/work/app", online: true, deviceId: "dev-1" }]);
  await new Promise((r) => setTimeout(r, 160));
  assert.equal(ctl.spawnedByCwd.size, 1, "房间已上线，宽限计时器必须取消");
  assert.equal(logs.some((line) => /已释放占用/.test(line)), false);
});

test("macOS Terminal：open 非 0 退出时不等满超时，立刻报 spawn_failed", async () => {
  const scriptDir = tmpDir();
  const children = [];
  const { ctl, frames } = makeCtl({
    platform: "darwin",
    projects: ["/Users/user/work/app"],
    scriptDir,
    launchWaitMs: 5000,
    spawnImpl: () => {
      const handlers = {};
      children.push(handlers);
      return { unref() {}, on(event, fn) { handlers[event] = fn; } };
    },
  });
  fs.writeFileSync(path.join(scriptDir, "start-pi.sh"), "", "utf8");
  ctl.startPi = path.join(scriptDir, "start-pi.sh");
  const pending = ctl.onHarness({ id: "m-exit", args: { cwd: "/Users/user/work/app" } });
  await new Promise((r) => setTimeout(r, 30));
  children[0].exit(1);
  await pending;
  assert.equal(frames[0].ok, false);
  assert.equal(frames[0].code, "spawn_failed");
  assert.match(frames[0].error, /退出码 1/);
  assert.equal(ctl.spawnedByCwd.size, 0);
});

test("--doctor：缺 .env 判失败，只读不写任何文件", async () => {
  const dir = tmpDir();
  const lines = [];
  const code = await attach.doctorMain({}, path.join(dir, ".env"), {
    writeOut: (line) => lines.push(String(line)),
    platform: "darwin",
    // 本机环境里可能真的配了 PI_REMOTE_*（开发机/测试机）：这条用例要的是"空配置"，显式给空 env
    env: {},
    probe: async () => ({ ok: false, error: "ECONNREFUSED" }),
    spawnSyncImpl: () => ({ status: 1, error: new Error("not found"), stdout: "", stderr: "" }),
  });
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.includes("找不到 .env")), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("没有 PI_REMOTE_RELAY")), lines.join("\n"));
  assert.deepEqual(fs.readdirSync(dir), [], "自检不能往目录里写东西");
  assert.equal(attach.parseArgs(["--doctor"]).doctor, true);
});

test("--doctor：连接窗口状态文件是残留时给出警告，不误报在线", async () => {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, "PI_REMOTE_RELAY=ws://127.0.0.1:7001\nPI_REMOTE_DEVICE_ID=d1\nPI_REMOTE_TOKEN=t\n", "utf8");
  const state = path.join(dir, "state.json");
  fs.writeFileSync(state, JSON.stringify({ pid: 999999, deviceId: "d1", expiresAt: Date.now() + 3600_000 }), "utf8");
  const lines = [];
  const code = await attach.doctorMain({}, envPath, {
    writeOut: (line) => lines.push(String(line)),
    platform: "darwin",
    probe: async () => ({ ok: true }),
    env: { PI_REMOTE_ATTACH_FILE: state, PI_REMOTE_PI_BIN: process.execPath },
    spawnSyncImpl: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  assert.equal(code, 0, lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("残留")), lines.join("\n"));
  assert.ok(!lines.some((line) => /✓ 连接窗口：pid/.test(line)));
});

test("harness_start：白名单外拒绝，同目录不另起，sessionId 走独立 --session 参数", async () => {
  const { ctl, spawned, frames } = makeCtl();
  await ctl.onHarness({ id: "c-bad", command: "harness_start", args: { cwd: "D:\\secret" } });
  assert.equal(frames[0].ok, false);
  assert.equal(frames[0].code, "cwd_not_allowed");
  assert.equal(frames[0].error, "该目录不在这台设备的允许列表里");
  assert.equal(frames[0].data.code, "cwd_not_allowed");
  assert.equal(spawned.length, 0);

  await ctl.onHarness({ id: "c-both", args: { cwd: "D:\\work\\app", sessionId: "s1" } });
  assert.match(frames[1].error, /二选一/);

  await ctl.onHarness({ id: "c-miss", args: { sessionId: "missing" } });
  assert.equal(frames[2].code, "session_not_found");
  assert.equal(frames[2].error, "这台设备上没有这个会话");

  await ctl.onHarness({ id: "c-ok", args: { cwd: "D:\\work\\app" } });
  assert.equal(frames[3].ok, true);
  assert.equal(frames[3].status, "started");
  assert.deepEqual(frames[3].data, { ok: true, status: "started" });
  assert.equal(spawned.length, 1);
  const spec = spawned[0];
  assert.equal(spec.file, "cmd.exe");
  assert.equal(Array.isArray(spec.args), true);
  assert.deepEqual(spec.args.slice(0, 4), ["/c", "start", "", "/D"]);
  assert.equal(spec.args[4], path.win32.resolve("D:\\work\\app"));
  assert.equal(spec.args[5], path.join(__dirname, "..", "deploy", "start-pi.cmd"));
  assert.equal(spec.opts.detached, true);
  assert.equal(spec.opts.stdio, "ignore");
  assert.equal(spec.opts.windowsHide, false);
  assert.notEqual(spec.opts.shell, true);
  assert.equal(spec.args.join(" ").includes("&"), false);

  await ctl.onHarness({ id: "c-dup", args: { cwd: "d:/work/app" } });
  assert.equal(frames[4].ok, true);
  assert.equal(frames[4].status, "already_running");
  assert.equal(spawned.length, 1);
});

test("sessionId 拉起把 --session 和路径分成独立参数；在线房间直接 already_running", async () => {
  const { ctl, spawned, frames } = makeCtl();
  ctl.observeRooms([{ id: "room-9", cwd: "D:\\work\\app", online: true, deviceId: "dev-1" }]);
  await ctl.onHarness({ id: "c-on", args: { cwd: "D:\\work\\app" } });
  assert.equal(frames[0].status, "already_running");
  assert.equal(frames[0].roomId, "room-9");
  assert.deepEqual(frames[0].data, { ok: true, status: "already_running", roomId: "room-9" });
  assert.equal(spawned.length, 0);

  // 不清任何状态：同目录有在线房间（room-9）时，sessionId 形态也不能被它顶掉
  await ctl.onHarness({ id: "c-s", args: { sessionId: "s1" } });
  assert.equal(frames[1].status, "started", "sessionId 形态按 id 匹配：room-9 不是 s1，必须真拉起");
  assert.equal(spawned[0].args.at(-2), "--session");
  assert.equal(spawned[0].args.at(-1), "C:\\sess\\t_s1.jsonl");
  assert.equal(spawned[0].args.some((part) => String(part).includes("--session ")), false);

  // sessionId 对应的房间在线时，直接 already_running 那个房间，不再起第二份
  ctl.observeRooms([{ id: "s1", cwd: "D:\\work\\app", online: true, deviceId: "dev-1" }]);
  await ctl.onHarness({ id: "c-s2", args: { sessionId: "s1" } });
  assert.equal(frames[2].status, "already_running");
  assert.equal(frames[2].roomId, "s1");
  assert.equal(spawned.length, 1);
});

test("别的设备的在线房间不挡本机；本窗口见过上线再下线后可以再拉起", async () => {
  const { ctl, spawned } = makeCtl();
  ctl.observeRooms([{ id: "other", cwd: "D:\\work\\app", online: true, deviceId: "other-dev" }]);
  const first = await ctl.launch({ cwd: "D:\\work\\app", source: "remote" });
  assert.equal(first.status, "started");
  assert.equal(spawned.length, 1);

  ctl.observeRooms([{ id: "room-1", cwd: "D:\\work\\app", online: false, deviceId: "dev-1" }]);
  assert.equal(ctl.spawnedByCwd.size, 1, "还没见过上线，不能因为一条离线房间就把刚拉起的进程忘掉");

  ctl.observeRooms([{ id: "room-1", cwd: "D:\\work\\app", online: true, deviceId: "dev-1" }]);
  ctl.observeRooms([{ id: "room-1", cwd: "D:\\work\\app", online: false, deviceId: "dev-1" }]);
  assert.equal(ctl.spawnedByCwd.size, 0);
  const again = await ctl.launch({ cwd: "D:\\work\\app", source: "remote" });
  assert.equal(again.status, "started");
  assert.equal(spawned.length, 2);
});

test("本机入参目录可以不在白名单；远程不行。危险字符不进入 spawn", async () => {
  const { ctl, spawned } = makeCtl();
  const cli = await ctl.launch({ cwd: "D:\\other", source: "cli" });
  assert.equal(cli.status, "started");
  assert.equal(spawned.length, 1);
  const remote = await ctl.launch({ cwd: "D:\\other", source: "remote" });
  assert.equal(remote.code, "cwd_not_allowed");
  const bad = await ctl.launch({ cwd: "D:\\work\\app&calc", source: "cli" });
  assert.equal(bad.code, "spawn_failed");
  assert.match(bad.error, /不允许的字符/);
  assert.equal(spawned.length, 1);
});

test("starting 锁：前一次还在查会话时，后一次直接拒绝且不排队", async () => {
  const { ctl, frames } = makeCtl();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  ctl.sessionLookup = () => gate;
  const first = ctl.onHarness({ id: "1", args: { sessionId: "s1" } });
  const second = ctl.onHarness({ id: "2", args: { sessionId: "s1" } });
  await second;
  const busy = frames.find((frame) => frame.id === "2");
  assert.equal(busy.ok, false);
  assert.equal(busy.error, "正在启动另一个会话，请稍候");
  release({ id: "s1", path: "C:\\sess\\t_s1.jsonl", cwd: "D:\\work\\app", deleted: false });
  await first;
  assert.equal(frames.find((frame) => frame.id === "1").status, "started");
});

test("会话文件只按白名单目录的文件名查找，不读正文", () => {
  const root = tmpDir();
  const folder = path.join(root, attach.encodeCwdDir("D:\\work\\app"));
  fs.mkdirSync(folder, { recursive: true });
  const secret = "对话正文不应被读到";
  fs.writeFileSync(path.join(folder, "2026-01-01T00-00-00-000Z_s1.jsonl"), secret, "utf8");
  const other = path.join(root, attach.encodeCwdDir("D:\\secret"));
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, "2026-01-01T00-00-00-000Z_s9.jsonl"), secret, "utf8");
  assert.equal(attach.encodeCwdDir("D:\\pi-myself", "win32"), "--D--pi-myself--");
  assert.equal(attach.encodeCwdDir("/Users/user/CLI/Pi-Remote", "darwin"), "--Users-user-CLI-Pi-Remote--");
  assert.equal(attach.encodeCwdDir("/home/u/app", "linux"), "--home-u-app--");
  const hit = attach.findSessionFile("s1", ["D:\\work\\app"], root);
  assert.equal(hit.id, "s1");
  assert.equal(hit.cwd, path.resolve("D:\\work\\app"));
  assert.match(hit.path, /_s1\.jsonl$/);
  assert.equal(attach.findSessionFile("s9", ["D:\\work\\app"], root), null);
  assert.equal(attach.findSessionFile("../s1", ["D:\\work\\app"], root), null);
  assert.equal(fs.readFileSync(hit.path, "utf8"), secret);
});

test("findSessionFile 全程不打开会话文件（监视 fs 读取接口）", () => {
  const root = tmpDir();
  const folder = path.join(root, attach.encodeCwdDir("D:\\work\\app"));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "2026-01-01T00-00-00-000Z_s1.jsonl"), "正文", "utf8");
  const touched = [];
  const names = ["readFileSync", "openSync", "readFile", "open", "createReadStream"];
  const saved = {};
  for (const name of names) {
    saved[name] = fs[name];
    fs[name] = function (p, ...rest) {
      if (String(p).endsWith(".jsonl")) touched.push(name + ":" + p);
      return saved[name].call(this, p, ...rest);
    };
  }
  let hit;
  try {
    hit = attach.findSessionFile("s1", ["D:\\work\\app"], root);
  } finally {
    for (const name of names) fs[name] = saved[name];
  }
  assert.ok(hit && hit.path.endsWith("_s1.jsonl"));
  assert.deepEqual(touched, [], "只能按文件名匹配，不能读会话正文");
});

test("sessionId 形态的占用按会话 id 记：同目录刚拉起 s1，不挡 s2，也不挡 s1 以外的会话", async () => {
  const sessions = {
    s1: { id: "s1", path: "C:\\sess\\t_s1.jsonl", cwd: "D:\\work\\app", deleted: false },
    s2: { id: "s2", path: "C:\\sess\\t_s2.jsonl", cwd: "D:\\work\\app", deleted: false },
  };
  const { ctl, spawned } = makeCtl({ sessionLookup: async (id) => sessions[id] || null });
  const a = await ctl.launch({ sessionId: "s1", source: "remote" });
  assert.equal(a.status, "started");
  const b = await ctl.launch({ sessionId: "s2", source: "remote" });
  assert.equal(b.status, "started", "同目录另一个会话必须能打开");
  assert.equal(spawned.length, 2);
  assert.equal(spawned[1].args.at(-1), "C:\\sess\\t_s2.jsonl");
  const dup = await ctl.launch({ sessionId: "s1", source: "remote" });
  assert.equal(dup.status, "already_running", "s1 刚拉起还没上线，不重复起");
  assert.equal(spawned.length, 2);
  assert.equal(ctl.spawnedByCwd.size, 0, "sessionId 拉起不占用目录");
  // cwd 形态不被 sessionId 拉起挡住
  const byDir = await ctl.launch({ cwd: "D:\\work\\app", source: "remote" });
  assert.equal(byDir.status, "started");
  // s1 上线后清掉占用记录
  ctl.observeRooms([{ id: "s1", cwd: "D:\\work\\app", online: true, deviceId: "dev-1" }]);
  assert.equal(ctl.spawnedBySession.has("s1"), false);
  // 占用超过 10 分钟放行
  ctl.spawnedBySession.set("s2", { at: Date.now() - 11 * 60 * 1000 });
  const retry = await ctl.launch({ sessionId: "s2", source: "remote" });
  assert.equal(retry.status, "started");
});

test("重连认证不覆盖别的窗口写下的状态文件；文件不在或仍归本窗口时才重写", () => {
  const { ctl } = makeCtl();
  ctl.scheduleReconnect = () => {};
  ctl.handleMessage({ type: "auth_result", ok: true });
  assert.equal(JSON.parse(fs.readFileSync(ctl.attachFile, "utf8")).pid, process.pid);
  const foreign = { pid: process.pid + 100000, deviceId: "dev-1", expiresAt: Date.now() + 3600e3 };
  fs.writeFileSync(ctl.attachFile, JSON.stringify(foreign), "utf8");
  ctl.onSocketClose();
  ctl.handleMessage({ type: "auth_result", ok: true });
  assert.equal(JSON.parse(fs.readFileSync(ctl.attachFile, "utf8")).pid, foreign.pid, "别的窗口的状态不能被抢回来");
  fs.rmSync(ctl.attachFile);
  ctl.onSocketClose();
  ctl.handleMessage({ type: "auth_result", ok: true });
  assert.equal(JSON.parse(fs.readFileSync(ctl.attachFile, "utf8")).pid, process.pid, "文件不在了就重写");
  ctl.shutdown();
});

test("首份 room_list 前断线：兜底定时器取消，下次认证再挂，不拿空列表拉起", async () => {
  const { ctl, spawned } = makeCtl({ dirs: ["D:\\work\\app"] });
  ctl.scheduleReconnect = () => {};
  ctl.handleMessage({ type: "auth_result", ok: true });
  assert.ok(ctl.bootFallbackTimer);
  ctl.onSocketClose();
  assert.equal(ctl.bootFallbackTimer, null, "断线必须取消兜底定时器");
  assert.equal(ctl.pendingBoot, true, "目录仍待拉起");
  ctl.handleMessage({ type: "auth_result", ok: true });
  assert.ok(ctl.bootFallbackTimer, "重新认证后重新挂兜底");
  ctl.handleMessage({ type: "room_list", rooms: [{ id: "r1", cwd: "D:\\work\\app", online: true, deviceId: "dev-1" }] });
  assert.equal(ctl.bootFallbackTimer, null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(spawned.length, 0, "目录已有在线房间，不另起");
  ctl.shutdown();
});

test("会话列表缓存未命中时强制刷新一次：30s 内新建的会话也能找到", async () => {
  let calls = 0;
  let rows = [];
  const SM = { list: async () => { calls += 1; return rows.slice(); } };
  const dir = path.join(tmpDir(), "proj");
  assert.equal(await attach.defaultSessionLookup("new1", [dir], undefined, SM), null);
  const before = calls;
  rows = [{ id: "new1", path: "C:\\sess\\t_new1.jsonl", cwd: dir }];
  const hit = await attach.defaultSessionLookup("new1", [dir], undefined, SM);
  assert.ok(hit, "缓存里没有时要刷新再找");
  assert.equal(hit.path, "C:\\sess\\t_new1.jsonl");
  assert.ok(calls > before);
  const n = calls;
  await attach.defaultSessionLookup("new1", [dir], undefined, SM);
  assert.equal(calls, n, "命中缓存时不再列目录");
});

test("目录不存在时报 spawn_failed，不调用 spawn", async () => {
  const { ctl, spawned } = makeCtl({ existsDir: () => false });
  const result = await ctl.launch({ cwd: "D:\\work\\app", source: "remote" });
  assert.equal(result.code, "spawn_failed");
  assert.match(result.error, /目录不存在/);
  assert.equal(spawned.length, 0);
});

test("spawnedByCwd 有 10 分钟占用期：拉起后一直没上线，过期后允许重试", async () => {
  const { ctl, spawned } = makeCtl();
  const first = await ctl.launch({ cwd: "D:\\work\\app", source: "remote" });
  assert.equal(first.status, "started");
  const blocked = await ctl.launch({ cwd: "D:\\work\\app", source: "remote" });
  assert.equal(blocked.status, "already_running");
  assert.equal(blocked.roomId, null);
  assert.equal(spawned.length, 1);

  // pi 始终没上线：把占用记录的 at 拨到 11 分钟后，必须放行重试（否则这个目录永久打不开）
  const key = attach.normalizeDir("D:\\work\\app", "win32");
  const rec = ctl.spawnedByCwd.get(key);
  rec.at = Date.now() - 11 * 60 * 1000;
  const retried = await ctl.launch({ cwd: "D:\\work\\app", source: "remote" });
  assert.equal(retried.status, "started");
  assert.equal(spawned.length, 2);
});

test("spawn 失败立刻清占用标记，后续请求不被 already_running 挡住", async () => {
  const spawned = [];
  const { ctl } = makeCtl({
    spawnImpl: (file, args, opts) => {
      spawned.push({ file, args, opts });
      return {
        unref() {},
        on(event, handler) {
          if (event === "error") setImmediate(() => handler(new Error("spawn ENOENT")));
        },
      };
    },
  });
  const first = await ctl.launch({ cwd: "D:\\work\\app", source: "remote" });
  assert.equal(first.status, "started");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ctl.spawnedByCwd.size, 0, "启动失败必须清掉占用标记");
  const again = await ctl.launch({ cwd: "D:\\work\\app", source: "remote" });
  assert.equal(again.status, "started");
  assert.equal(spawned.length, 2);
});

test("鉴权失败：退出码 1、状态文件不留、onSocketClose 清空房间列表", async () => {
  const codes = [];
  const { ctl } = makeCtl({ exit: (code) => codes.push(code) });
  ctl.handleMessage({ type: "auth_result", ok: false, error: "token 不正确" });
  assert.deepEqual(codes, [1], "失败要反映到退出码，调用脚本不能当成功");
  assert.equal(fs.existsSync(ctl.attachFile), false, "认证失败不写状态文件");

  ctl.observeRooms([{ id: "r1", cwd: "D:\\work\\app", online: true, deviceId: "dev-1" }]);
  assert.equal(ctl.onlineRooms.length, 1);
  ctl.onSocketClose();
  assert.equal(ctl.onlineRooms.length, 0, "断线后房间列表失效，不能按旧状态判断已在运行");
});

test("viewer 地址端口可配，默认 7002", () => {
  assert.equal(attach.viewerUrlFromRelay("ws://1.2.3.4:7001"), "http://1.2.3.4:7002/");
  assert.equal(attach.viewerUrlFromRelay("ws://1.2.3.4:7001", 8080), "http://1.2.3.4:8080/");
  assert.equal(attach.parseArgs(["--viewer-port", "9090"]).viewerPort, 9090);
  assert.equal(attach.parseArgs(["--viewer-port=9091"]).viewerPort, 9091);
  assert.throws(() => attach.parseArgs(["--viewer-port", "0"]), /端口/);
});

test("残留状态文件：pid 已死或窗口早过期就清掉，别的窗口活着就不能动", async () => {
  const { spawn } = require("node:child_process");
  const { ctl } = makeCtl();
  ctl.scheduleReconnect = () => {};
  try {
    // 造一个确实已经退出的进程，拿它的 pid 当"上次被强杀的窗口"
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const deadPid = dead.pid;
    await new Promise((resolve) => dead.on("exit", resolve));
    fs.writeFileSync(ctl.attachFile, JSON.stringify({ pid: deadPid, deviceId: "dev-1", expiresAt: Date.now() + 3600e3 }), "utf8");
    ctl.clearStaleState();
    assert.equal(fs.existsSync(ctl.attachFile), false, "pid 已死的残留必须清掉");
    // 清掉之后本窗口才写得进状态、退出时才删得掉
    ctl.handleMessage({ type: "auth_result", ok: true });
    assert.equal(JSON.parse(fs.readFileSync(ctl.attachFile, "utf8")).pid, process.pid);

    // 窗口早过期：哪怕 pid 被系统复用着，也按残留处理
    fs.writeFileSync(ctl.attachFile, JSON.stringify({ pid: process.pid + 100000, expiresAt: Date.now() - 1000 }), "utf8");
    ctl.clearStaleState();
    assert.equal(fs.existsSync(ctl.attachFile), false, "早过期的窗口按残留清掉");

    // 别的窗口真活着：不能抢、也不能删
    const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
      fs.writeFileSync(ctl.attachFile, JSON.stringify({ pid: live.pid, deviceId: "dev-1", expiresAt: Date.now() + 3600e3 }), "utf8");
      ctl.clearStaleState();
      assert.equal(fs.existsSync(ctl.attachFile), true, "活着的别的窗口的状态不能动");
      ctl.handleMessage({ type: "auth_result", ok: true });
      assert.equal(JSON.parse(fs.readFileSync(ctl.attachFile, "utf8")).pid, live.pid, "也不该被抢回来");
    } finally {
      live.kill();
    }
  } finally {
    ctl.shutdown();
  }
});

// ---------- v4：配对与设备令牌 ----------

/** 假 relay socket：open 后记录收到的帧，按 reply 回一帧 */
function fakeRelaySocket(reply) {
  const seen = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.handlers = {};
      setImmediate(() => this.handlers.open && this.handlers.open());
    }
    on(event, fn) {
      this.handlers[event] = fn;
    }
    send(data) {
      const frame = JSON.parse(data);
      seen.push(frame);
      const out = reply(frame);
      if (out) setImmediate(() => this.handlers.message && this.handlers.message(JSON.stringify(out)));
    }
    close() {
      setImmediate(() => this.handlers.close && this.handlers.close());
    }
  }
  return { FakeWS, seen };
}

test("配对码：忽略大小写/空格/连字符，只认协议字母表与长度", () => {
  assert.equal(attach.normalizePairCode("abcd-efgh"), "ABCDEFGH");
  assert.equal(attach.normalizePairCode(" 2345 6789 "), "23456789");
  assert.throws(() => attach.normalizePairCode("ABCD-EFG"), /8 位/);
  assert.throws(() => attach.normalizePairCode("ABCD-EFG0"), /XXXX-XXXX/, "0 不在字母表里");
  assert.throws(() => attach.normalizePairCode("ABCD-EFGI"), /XXXX-XXXX/, "I 不在字母表里");
  assert.equal(attach.parseArgs(["--pair=wxyz-2345"]).pair, "WXYZ2345");
  assert.throws(() => attach.parseArgs(["--pair", "ABCD-EFGH", "--relay", "http://x"]), /ws:\/\//);
});

test("写 .env：就地替换已有键、追加缺的键；保留注释、CRLF 与 BOM；新建和已有文件都只给本人读写", () => {
  const dir = tmpDir();
  const crlf = path.join(dir, "win.env");
  fs.writeFileSync(crlf, "\uFEFF# 注释 PI_REMOTE_DEVICE_ID=不动\r\nPI_REMOTE_RELAY=ws://a:7001\r\nPI_REMOTE_DEVICE_ID=old\r\n", "utf8");
  if (process.platform !== "win32") fs.chmodSync(crlf, 0o644);
  attach.writeEnvVars(crlf, { PI_REMOTE_DEVICE_ID: "new-id", PI_REMOTE_DEVICE_TOKEN: "tok" });
  assert.equal(
    fs.readFileSync(crlf, "utf8"),
    "\uFEFF# 注释 PI_REMOTE_DEVICE_ID=不动\r\nPI_REMOTE_RELAY=ws://a:7001\r\nPI_REMOTE_DEVICE_ID=new-id\r\nPI_REMOTE_DEVICE_TOKEN=tok\r\n",
  );
  assert.equal(attach.loadConfig(crlf, {}).deviceToken, "tok");
  // 已有 .env 原来是 0644：写入设备令牌后必须收紧，不能沿用旧权限
  if (process.platform !== "win32") assert.equal((fs.statSync(crlf).mode & 0o777).toString(8), "600");
  const fresh = path.join(dir, "sub", "new.env");
  attach.writeEnvVars(fresh, { PI_REMOTE_RELAY: "ws://b:7001" });
  assert.equal(fs.readFileSync(fresh, "utf8"), "PI_REMOTE_RELAY=ws://b:7001\n");
  if (process.platform !== "win32") assert.equal((fs.statSync(fresh).mode & 0o777).toString(8), "600");
});

test("令牌文件权限：--init / writeEnvVars / --pair 都把已有的 0644 .env 收紧到 0600", { skip: process.platform === "win32" }, async () => {
  const dir = tmpDir();
  const modeOf = (p) => (fs.statSync(p).mode & 0o777).toString(8);
  const make = (name, text) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, text, "utf8");
    fs.chmodSync(p, 0o644);
    assert.equal(modeOf(p), "644");
    return p;
  };

  // 已有 deviceId：init 早退不改内容，但仍要收紧权限
  const kept = make("kept.env", "PI_REMOTE_RELAY=ws://r:7001\nPI_REMOTE_DEVICE_ID=keep-me\n");
  const keptResult = attach.initEnvFile(kept, { uuid: "uuid-new", env: {} });
  assert.equal(keptResult.changed, false);
  assert.equal(modeOf(kept), "600");
  assert.match(fs.readFileSync(kept, "utf8"), /PI_REMOTE_DEVICE_ID=keep-me/);

  // 追加 deviceId 的分支
  const appended = make("appended.env", "PI_REMOTE_RELAY=ws://r:7001\n");
  assert.equal(attach.initEnvFile(appended, { uuid: "uuid-a", env: {} }).changed, true);
  assert.equal(modeOf(appended), "600");

  // writeEnvVars 改写已有令牌
  const rewritten = make("rewritten.env", "PI_REMOTE_RELAY=ws://r:7001\nPI_REMOTE_DEVICE_TOKEN=old\n");
  attach.writeEnvVars(rewritten, { PI_REMOTE_DEVICE_TOKEN: "new-token" });
  assert.equal(modeOf(rewritten), "600");

  // --pair 直接写设备令牌（此前最容易漏掉 chmod 的路径）
  const paired = make("paired.env", "PI_REMOTE_RELAY=ws://relay:7001\nPI_REMOTE_DEVICE_ID=d1\n");
  const { FakeWS } = fakeRelaySocket(() => ({ type: "pair_result", ok: true, accountId: "admin", deviceId: "d1", deviceToken: "secret-token" }));
  const code = await attach.pairMain({ pair: "ABCDEFGH", relay: "" }, paired, {
    WebSocketImpl: FakeWS,
    platform: "darwin",
    env: {},
    writeOut: () => {},
    writeErr: () => {},
  });
  assert.equal(code, 0);
  assert.equal(modeOf(paired), "600");
  assert.equal(attach.loadConfig(paired, {}).deviceToken, "secret-token");
});

test("attach 鉴权帧：有设备令牌就按设备鉴权，共享 token 照带", () => {
  const f = attach.attachAuthFrame({ token: "lt", deviceId: "d1", deviceToken: "dt", platform: "darwin" });
  assert.deepEqual(
    { proto: f.proto, kind: f.client.kind, platform: f.client.platform, deviceId: f.deviceId, deviceToken: f.deviceToken, token: f.token },
    { proto: 4, kind: "attach", platform: "macos", deviceId: "d1", deviceToken: "dt", token: "lt" },
  );
  assert.deepEqual(f.caps, ["err.v4", "device.token", "session.files", "fs.browse"]);
  const legacy = attach.attachAuthFrame({ token: "lt", deviceId: "d1", platform: "win32" });
  assert.equal("deviceToken" in legacy, false);
  assert.equal(legacy.client.platform, "windows");
});

test("--pair：带上已有设备编号，成功后把编号和令牌写进 .env，令牌不打印", async () => {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, "PI_REMOTE_RELAY=ws://relay:7001\nPI_REMOTE_TOKEN=lt\nPI_REMOTE_DEVICE_ID=keep-me\nPI_REMOTE_DEVICE_NAME=书房 Mac\n", "utf8");
  const { FakeWS, seen } = fakeRelaySocket((frame) =>
    frame.type === "pair" ? { type: "pair_result", ok: true, accountId: "admin", deviceId: "keep-me", deviceToken: "secret-token" } : null,
  );
  const lines = [];
  const code = await attach.pairMain({ pair: "ABCDEFGH", relay: "" }, envPath, {
    WebSocketImpl: FakeWS,
    platform: "darwin",
    env: {},
    writeOut: (l) => lines.push(l),
    writeErr: (l) => lines.push(l),
  });
  assert.equal(code, 0, lines.join("\n"));
  // 阶段 1 起 pair 帧多带 keys{signPub, boxPub, pop}（旧 relay 忽略即可）；其余字段与旧形态一致
  const { keys: frameKeys, ...frameRest } = seen[0];
  assert.deepEqual(frameRest, { type: "pair", proto: 4, code: "ABCDEFGH", device: { id: "keep-me", name: "书房 Mac", platform: "macos" } });
  assert.ok(frameKeys && frameKeys.signPub && frameKeys.boxPub && frameKeys.pop, "pair 帧应带公钥与持有证明");
  const keyFile = path.join(dir, "pi-remote-device.key.json");
  const savedKeys = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  assert.equal(frameKeys.signPub, savedKeys.sign.pub, "帧里的公钥应与本机钥文件一致");
  const popOk = require("node:crypto").verify(
    null,
    Buffer.from("ABCDEFGH", "utf8"),
    require("node:crypto").createPublicKey({ key: Buffer.from(frameKeys.signPub, "base64"), format: "der", type: "spki" }),
    Buffer.from(frameKeys.pop, "base64"),
  );
  assert.equal(popOk, true, "pop 必须能被独立验签（relay 侧同法）");
  const cfg = attach.loadConfig(envPath, {});
  assert.equal(cfg.deviceId, "keep-me");
  assert.equal(cfg.deviceToken, "secret-token");
  assert.equal(cfg.token, "lt", "共享 token 保留（兼容期）");
  assert.equal(lines.join("\n").includes("secret-token"), false, "令牌不能出现在终端输出里");
});

test("--pair：新电脑没有 .env 也能配对（--relay 指定地址），失败时退出码 1 并说明原因", async () => {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  const ok = fakeRelaySocket(() => ({ type: "pair_result", ok: true, deviceId: "new-dev", deviceToken: "t" }));
  const quiet = { writeOut: () => {}, writeErr: () => {}, env: {}, platform: "win32" };
  assert.equal(await attach.pairMain({ pair: "ABCDEFGH", relay: "ws://r:7001" }, envPath, { ...quiet, WebSocketImpl: ok.FakeWS }), 0);
  assert.equal(ok.seen[0].device.id, undefined, "没有编号就让 relay 生成");
  assert.equal(ok.seen[0].device.name, "Windows");
  const cfg = attach.loadConfig(envPath, {}, "win32");
  assert.deepEqual([cfg.relay, cfg.deviceId, cfg.deviceToken, cfg.deviceName], ["ws://r:7001", "new-dev", "t", "Windows"]);

  const errs = [];
  const expired = fakeRelaySocket(() => ({ type: "pair_result", ok: false, code: "pair_expired", error: "配对码已过期，请重新生成" }));
  assert.equal(await attach.pairMain({ pair: "ABCDEFGH", relay: "ws://r:7001" }, path.join(dir, "x.env"), { ...quiet, writeErr: (l) => errs.push(l), WebSocketImpl: expired.FakeWS }), 1);
  assert.match(errs.join("\n"), /pair_expired/);
  assert.equal(fs.existsSync(path.join(dir, "x.env")), false, "失败不写文件");

  const old = fakeRelaySocket(() => ({ type: "error", code: "unknown_type", message: "未知消息类型：pair" }));
  const r = await attach.requestPairing({ relay: "ws://r:7001", code: "ABCDEFGH", WebSocketImpl: old.FakeWS, platform: "darwin" });
  assert.deepEqual([r.ok, r.code], [false, "unsupported"], "旧 relay 明确报不支持");
  const silent = fakeRelaySocket(() => null);
  const t = await attach.requestPairing({ relay: "ws://r:7001", code: "ABCDEFGH", WebSocketImpl: silent.FakeWS, platform: "darwin", timeoutMs: 30 });
  assert.equal(t.code, "timeout");
});

test("设备令牌被撤销：窗口退出码 1，并提示重新配对的命令", () => {
  const codes = [];
  const { ctl, logs } = makeCtl({ platform: "darwin", deviceToken: "dt", exit: (c) => codes.push(c) });
  ctl.handleMessage({ type: "auth_result", ok: false, code: "device_revoked", error: "这台设备已被撤销" });
  assert.deepEqual(codes, [1]);
  assert.match(logs.join("\n"), /attach\.sh --pair/);
  const legacy = makeCtl();
  legacy.ctl.handleMessage({ type: "auth_result", ok: true, auth: "legacy" });
  legacy.ctl.connected = true;
  assert.match(legacy.ctl.statusLine(), /共享令牌（建议配对）/);
  legacy.ctl.shutdown();
});

test("macOS / Linux 防休眠：窗口开着就挂 caffeinate / systemd-inhibit，状态行标出来，关窗口时结束；起不来不影响窗口", () => {
  const children = [];
  const fakeSpawn = (file, args, opts) => {
    const handlers = {};
    const child = { file, args, opts, killed: 0, unref() {}, on(ev, fn) { handlers[ev] = fn; }, kill() { this.killed++; }, handlers };
    children.push(child);
    return child;
  };
  const { ctl, logs } = makeCtl({ platform: "darwin", keepAwake: true, spawnImpl: fakeSpawn });
  ctl.armKeepAwake();
  ctl.armKeepAwake();
  assert.equal(children.length, 1, "只挂一个");
  assert.deepEqual([children[0].file, children[0].args], ["caffeinate", ["-i", "-w", String(process.pid)]]);
  assert.equal(children[0].opts.stdio, "ignore");
  assert.match(logs.join("\n"), /PI_REMOTE_KEEP_AWAKE=0/);
  ctl.handleMessage({ type: "auth_result", ok: true, auth: "token" });
  ctl.connected = true;
  assert.match(ctl.statusLine(), /活动会话 0 个 · 防休眠/);
  ctl.shutdown();
  assert.equal(children[0].killed, 1, "关窗口就放开睡眠");
  assert.equal(ctl.awakeChild, null);

  const broken = makeCtl({ platform: "darwin", keepAwake: true, spawnImpl: fakeSpawn });
  broken.ctl.armKeepAwake();
  children[1].handlers.error(new Error("spawn caffeinate ENOENT"));
  assert.equal(broken.ctl.awakeChild, null);
  assert.match(broken.logs.join("\n"), /防休眠没开起来（不影响连接）：spawn caffeinate ENOENT/);
  broken.ctl.connected = true;
  broken.ctl.authed = true;
  assert.doesNotMatch(broken.ctl.statusLine(), /防休眠/);
  broken.ctl.shutdown();

  const linux = makeCtl({ platform: "linux", keepAwake: true, spawnImpl: fakeSpawn });
  linux.ctl.armKeepAwake();
  assert.equal(children[2].file, "systemd-inhibit");
  assert.ok(children[2].args.includes("--what=idle:sleep"));
  assert.ok(children[2].args.includes("--mode=block"), "阻塞模式才会真正挡住 idle/sleep");
  assert.ok(children[2].args.includes("--who=pi-remote"));
  assert.equal(children[2].opts.stdio, "ignore");
  assert.equal(children[2].args[children[2].args.indexOf("/bin/sh") + 1], "-c");
  assert.match(children[2].args.join(" "), new RegExp(String(process.pid)), "抑制剂盯着本进程，attach 没了就退出");
  assert.match(linux.logs.join("\n"), /这台 Linux 设备不会空闲睡眠/);
  linux.ctl.connected = true;
  linux.ctl.authed = true;
  assert.match(linux.ctl.statusLine(), /防休眠/);
  linux.ctl.shutdown();
  assert.equal(children[2].killed, 1);

  for (const extra of [{ platform: "win32", keepAwake: true }, { platform: "darwin" }, { platform: "linux" }]) {
    const other = makeCtl({ ...extra, spawnImpl: fakeSpawn });
    other.ctl.armKeepAwake();
    other.ctl.shutdown();
  }
  assert.equal(children.length, 3, "win32、或没打开时不起防休眠进程");
});

test("PI_REMOTE_KEEP_AWAKE：macOS / Linux 缺省开，0/false/off/no 关；Windows 一律不开", () => {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, "PI_REMOTE_RELAY=ws://r:7001\n", "utf8");
  assert.equal(attach.loadConfig(envPath, {}, "darwin").keepAwake, true);
  assert.equal(attach.loadConfig(envPath, { PI_REMOTE_KEEP_AWAKE: "0" }, "darwin").keepAwake, false);
  assert.equal(attach.loadConfig(envPath, {}, "linux").keepAwake, true);
  assert.equal(attach.loadConfig(envPath, { PI_REMOTE_KEEP_AWAKE: "0" }, "linux").keepAwake, false);
  assert.equal(attach.loadConfig(envPath, {}, "win32").keepAwake, false);
  for (const off of ["0", "false", "OFF", " no "]) {
    assert.equal(attach.keepAwakeWanted(off, "darwin"), false, off);
    assert.equal(attach.keepAwakeWanted(off, "linux"), false, off);
  }
  for (const on of ["", "1", "true", "yes"]) {
    assert.equal(attach.keepAwakeWanted(on, "darwin"), true, on);
    assert.equal(attach.keepAwakeWanted(on, "linux"), true, on);
  }
  assert.equal(attach.keepAwakeWanted("1", "win32"), false);
  fs.writeFileSync(envPath, "PI_REMOTE_KEEP_AWAKE=off\n", "utf8");
  assert.equal(attach.loadConfig(envPath, { PI_REMOTE_KEEP_AWAKE: "1" }, "darwin").keepAwake, false, ".env 优先于环境变量");
});

test("attach 存活检测：静默 30s 先自己 ping，75s 一点动静都没有判死；terminate 不等握手，按断线处理并从头退避重连", () => {
  const { ctl, logs } = makeCtl();
  let pings = 0;
  let terminated = 0;
  ctl.ws = { readyState: 1, send() {}, close() {}, ping() { pings += 1; }, terminate() { terminated += 1; } };
  ctl.connected = true;
  ctl.authed = true;
  ctl.onlineRooms = [{ id: "r1", cwd: "D:\\work\\app", online: true }];
  ctl.backoff = 8000;
  const waits = [];
  ctl.scheduleReconnect = () => waits.push(ctl.backoff);
  const t0 = 1_000_000;
  ctl.lastSeen = t0;
  ctl.lastTick = t0;
  const verdicts = [];
  for (let s = 10; s <= 80; s += 10) verdicts.push(ctl.checkLiveness(t0 + s * 1000));
  assert.deepEqual(verdicts, ["ok", "ok", "ping", "ping", "ping", "ping", "ping", "dead"]);
  assert.equal(pings, 5);
  assert.equal(terminated, 1, "半开连接等不到 close 握手，直接 terminate");
  assert.deepEqual([ctl.ws, ctl.connected, ctl.authed, ctl.onlineRooms.length], [null, false, false, 0]);
  assert.deepEqual(waits, [1000], "退避从 1s 重新算");
  assert.match(logs.join("\n"), /连接没有响应（80s 没收到 relay 的任何消息），重连/);
  ctl.shutdown();
});

test("attach 存活检测：relay 的 ping、pong 和任何帧都算动静；定时器晚到 30s 以上 = 刚睡醒，立刻重连；断着时不判", () => {
  const realNow = Date.now;
  let now = 2_000_000;
  Date.now = () => now;
  const sockets = [];
  class FakeWS {
    constructor() {
      this.handlers = {};
      this.readyState = 1;
      this.terminated = 0;
      sockets.push(this);
    }
    on(event, fn) {
      this.handlers[event] = fn;
    }
    send() {}
    close() {}
    ping() {}
    terminate() {
      this.terminated += 1;
    }
  }
  const { ctl } = makeCtl({ WebSocketImpl: FakeWS });
  const waits = [];
  ctl.scheduleReconnect = () => waits.push(ctl.backoff);
  try {
    ctl.ws = null;
    ctl.connect();
    const ws = sockets[0];
    ws.handlers.open();
    assert.equal(ctl.lastSeen, now);
    for (const event of ["ping", "pong", "message"]) {
      now += 50_000;
      ws.handlers[event](event === "message" ? JSON.stringify({ type: "room_list", rooms: [] }) : Buffer.alloc(0));
      assert.equal(ctl.lastSeen, now, event + " 刷新最后动静");
    }
    ctl.lastTick = now;
    assert.equal(ctl.checkLiveness(now + 10_000), "ok");
    assert.equal(ctl.checkLiveness(now + 10_000 + 45_000), "wake");
    assert.equal(ws.terminated, 1);
    assert.equal(waits.length, 1);
    ws.handlers.close();
    assert.equal(waits.length, 1, "旧 socket 迟到的 close 不再触发一次重连");
    assert.equal(ctl.checkLiveness(now + 200_000), "idle", "断着的时候交给重连定时器");
  } finally {
    Date.now = realNow;
    ctl.shutdown();
  }
});

/* ================= P9 设备端（B 删除 / C 浏览）：全部用 mkdtemp 临时目录 ================= */

/** 临时会话根目录：覆盖 PI_CODING_AGENT_SESSION_DIR，用例结束恢复。 */
function tmpSessionRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-attach-sessions-"));
  const prev = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = root;
  t.after(() => {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** PATH 指到一个空临时目录：确定没有 trash，删除回退 unlink。 */
function withoutTrashOnPath(t) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "pi-attach-nobin-"));
  const prev = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => {
    process.env.PATH = prev;
    fs.rmSync(bin, { recursive: true, force: true });
  });
  return bin;
}

/** 在 PATH 里放一个假 trash（把参数移到 moved/ 里），返回 PATH 用的 bin 目录。 */
function withFakeTrash(t) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "pi-attach-bin-"));
  const moved = path.join(bin, "moved");
  fs.mkdirSync(moved, { recursive: true });
  if (process.platform === "win32") {
    // Windows 不能直接起 .cmd（Node EINVAL），attach.cjs 会经 cmd.exe 执行；这里用 cmd 的 move
    fs.writeFileSync(path.join(bin, "trash.cmd"), '@echo off\r\nmove /Y %* "' + moved + '\\" >nul\r\nexit /b 0\r\n');
  } else {
    fs.writeFileSync(
      path.join(bin, "trash"),
      "#!/bin/sh\n/bin/mkdir -p " + JSON.stringify(moved) + "\n/bin/mv -- \"$@\" " + JSON.stringify(moved + "/") + " 2>/dev/null\nexit 0\n",
    );
    fs.chmodSync(path.join(bin, "trash"), 0o755);
  }
  const prev = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => {
    process.env.PATH = prev;
    fs.rmSync(bin, { recursive: true, force: true });
  });
  return { bin, moved };
}

/** 写一个最小可解析的会话文件（P9 用例只按文件名找，不读正文）。 */
function writeSessionFile(root, id, opts = {}) {
  const dir = path.join(root, opts.dirName || "--proj--");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, (opts.ts || "1700000000000") + "_" + id + ".jsonl");
  const header = JSON.stringify({ type: "session", id, cwd: opts.cwd || path.join(os.tmpdir(), "proj"), timestamp: 1700000000000 });
  const msg = JSON.stringify({ type: "message", id: "m1", timestamp: 1700000000001, message: { role: "user", content: [{ type: "text", text: "hi" }] } });
  fs.writeFileSync(file, header + "\n" + msg + "\n");
  return file;
}

/** 本机平台的控制器（删除/浏览用例不能用 makeCtl 的默认 win32 路径规则）。 */
function p9Ctl(extra = {}) {
  const made = makeCtl({ platform: process.platform, ...extra });
  made.ctl.authed = true;
  return made;
}

function lastResult(frames) {
  const results = frames.filter((f) => f.type === "command_result");
  return results[results.length - 1];
}

function tmpBrowseRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-attach-browse-"));
  const rootReal = fs.realpathSync.native(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, rootReal };
}

test("loadConfig：P9 的 browseRoots（空=家目录、off=关闭）与 libraryRescanMs 键", () => {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, "PI_REMOTE_RELAY=ws://127.0.0.1:7001\nPI_REMOTE_BROWSE_ROOTS=off\nPI_REMOTE_LIBRARY_RESCAN_MS=9000\n");
  const cfg = attach.loadConfig(envPath, {}, "darwin");
  assert.deepEqual(cfg.browseRoots, []);
  assert.equal(cfg.libraryRescanMs, "9000");
  const defaulted = attach.loadConfig(path.join(dir, "missing.env"), {}, process.platform);
  assert.deepEqual(defaulted.browseRoots, [fs.realpathSync.native(os.homedir())], "不写这一项 = 家目录");
});

test("parseBrowseRoots：空=家目录；off/0/false=关闭；分号拆开、去重、丢掉不存在的、最多 8 个", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-attach-browse-cfg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = path.join(dir, "a");
  const b = path.join(dir, "b");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  const aReal = fs.realpathSync.native(a);
  const bReal = fs.realpathSync.native(b);
  const host = process.platform;
  assert.deepEqual(attach.parseBrowseRoots("", host), [fs.realpathSync.native(os.homedir())]);
  for (const off of ["off", "0", "false", "OFF"]) assert.deepEqual(attach.parseBrowseRoots(off, host), [], off);
  assert.deepEqual(attach.parseBrowseRoots([a, b, path.join(dir, "gone"), a].join(";"), host), [aReal, bReal]);
  const many = [];
  for (let i = 0; i < 10; i++) {
    const p = path.join(dir, "r" + i);
    fs.mkdirSync(p);
    many.push(p);
  }
  assert.equal(attach.parseBrowseRoots(many.join(";"), host).length, 8, "最多 8 个");
});

test("insideRoots：Windows 盘符/大小写/UNC 规则（纯函数）", () => {
  // spec §5.6 的原样用例：C:\Users\A\x 在根 c:/users/user 下面；C:\Users\Ab 不在 C:\Users\user 下面
  assert.equal(attach.insideRoots("C:\\Users\\user\\x", ["c:/users/user"], "win32"), true);
  assert.equal(attach.insideRoots("C:\\Users\\userb", ["C:\\Users\\user"], "win32"), false, "C:\\Users\\Ab 不是 C:\\Users\\A 的子目录");
  const roots = ["C:\\work", "\\\\server\\share\\team"];
  assert.equal(attach.insideRoots("c:\\work\\app", roots, "win32"), true, "盘符大小写不计");
  assert.equal(attach.insideRoots("C:\\WORK\\APP", roots, "win32"), true, "路径大小写不计");
  assert.equal(attach.insideRoots("C:\\other", roots, "win32"), false);
  assert.equal(attach.insideRoots("C:\\workshop", roots, "win32"), false, "前缀相同但不在目录下");
  assert.equal(attach.insideRoots("\\\\server\\share\\team\\x", roots, "win32"), true, "UNC 根目录内可以");
  assert.equal(attach.insideRoots("\\\\evil\\share", roots, "win32"), false, "UNC 不在任何根里：拒绝");
  assert.equal(attach.insideRoots("C:\\work", roots, "win32"), true, "等于根目录");
  assert.equal(attach.matchedRoot("C:\\work\\a", roots, "win32"), "C:\\work");
});

test("insideRoots：macOS 不分大小写、Linux 区分（纯函数）", () => {
  assert.equal(attach.insideRoots("/Users/me/Proj/x", ["/Users/Me/Proj"], "darwin"), true);
  assert.equal(attach.insideRoots("/Users/me/Proj/x", ["/Users/me/proj"], "linux"), false);
  assert.equal(attach.insideRoots("/Users/me/Proj", ["/Users/me/Proj"], "linux"), true);
  assert.equal(attach.insideRoots("/Users/me/ProjX", ["/Users/me/Proj"], "linux"), false);
});

test("hasTrashCommand / deleteLikePi：有 trash 用 trash，没有就 unlink", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-attach-del-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const emptyBin = path.join(dir, "empty");
  fs.mkdirSync(emptyBin);
  assert.equal(attach.hasTrashCommand(process.platform, { PATH: emptyBin }), false);
  const { bin } = withFakeTrash(t);
  assert.equal(attach.hasTrashCommand(process.platform, { PATH: bin }), true, "可执行的 trash 才算");

  const file1 = path.join(dir, "a_1.jsonl");
  fs.writeFileSync(file1, "{}\n");
  assert.deepEqual(attach.deleteLikePi(file1, process.platform, { PATH: bin }), { ok: true, method: "trash" });
  assert.equal(fs.existsSync(file1), false);
  assert.ok(fs.readdirSync(path.join(bin, "moved")).includes("a_1.jsonl"), "文件确实进了（假）废纸篓");

  const file2 = path.join(dir, "a_2.jsonl");
  fs.writeFileSync(file2, "{}\n");
  assert.deepEqual(attach.deleteLikePi(file2, process.platform, { PATH: emptyBin }), { ok: true, method: "unlink" });
  assert.equal(fs.existsSync(file2), false);

  // 空格、%、& 的路径：Windows 的 trash.cmd 经 cmd.exe 执行，目标路径不能被二次展开/截断
  const file3 = path.join(dir, "a 50% & b.jsonl");
  fs.writeFileSync(file3, "{}\n");
  assert.deepEqual(attach.deleteLikePi(file3, process.platform, { PATH: bin }), { ok: true, method: "trash" });
  assert.equal(fs.existsSync(file3), false);
  assert.ok(fs.readdirSync(path.join(bin, "moved")).includes("a 50% & b.jsonl"), "带空格/%/& 的文件名原样进废纸篓");
});

test("device_register：P9 带上 trash / features / browse.roots", (t) => {
  const { ctl } = p9Ctl({ browseRoots: ["/tmp/one", "/tmp/two"] });
  const { bin } = withFakeTrash(t);
  ctl.platform = process.platform;
  const withTrash = ctl.registerFrame();
  assert.equal(withTrash.type, "device_register");
  assert.equal(withTrash.device.trash, true);
  assert.deepEqual(withTrash.device.browse, { roots: ["/tmp/one", "/tmp/two"] });
  assert.deepEqual(withTrash.device.features, ["session.files", "fs.browse"]);
  process.env.PATH = bin; // withFakeTrash 已把 PATH 换过去；这里再确认无 trash 的平台组合
  assert.equal(Array.isArray(withTrash.device.projects), true);
});

test("reply：result.data 的字段并进 frame.data（P9 §4.5.4）", () => {
  const { ctl, frames } = p9Ctl();
  ctl.reply("id-1", { ok: true, status: "deleted", data: { method: "trash" } });
  assert.deepEqual(frames[0].data, { ok: true, status: "deleted", method: "trash" });
  ctl.reply("id-2", { ok: false, code: "session_running", error: "会话正在运行，不能删除" });
  assert.equal(frames[1].ok, false);
  assert.equal(frames[1].code, "session_running");
  assert.equal(frames[1].data.code, "session_running");
});

test("不认识的命令也立刻回 unknown_command（不让 relay 白等）", () => {
  const { ctl, frames } = p9Ctl();
  ctl.handleMessage({ type: "command", id: "c1", command: "delete_forever", args: {} });
  const result = lastResult(frames);
  assert.equal(result.ok, false);
  assert.equal(result.code, "unknown_command");
  assert.match(result.error, /delete_forever/);
});

test("onDeleteSession：trash 优先，回 data.method 并发 removed", async (t) => {
  const root = tmpSessionRoot(t);
  withFakeTrash(t);
  const file = writeSessionFile(root, "s1");
  const { ctl, frames } = p9Ctl();
  await ctl.onDeleteSession({ id: "cmd-1", args: { sessionId: "s1" } });
  assert.equal(fs.existsSync(file), false);
  const result = lastResult(frames);
  assert.equal(result.ok, true);
  assert.equal(result.status, "deleted");
  assert.equal(result.data.method, "trash");
  assert.ok(frames.some((f) => f.type === "session_manifest" && f.full === false && Array.isArray(f.removed) && f.removed.includes("s1")));
});

test("onDeleteSession：没有 trash 时回 method=unlink", async (t) => {
  const root = tmpSessionRoot(t);
  withoutTrashOnPath(t);
  writeSessionFile(root, "s2");
  const { ctl, frames } = p9Ctl();
  await ctl.onDeleteSession({ id: "cmd-2", args: { sessionId: "s2" } });
  assert.equal(lastResult(frames).data.method, "unlink");
});

test("onDeleteSession：在线房间 → session_running，文件不动", async (t) => {
  const root = tmpSessionRoot(t);
  withoutTrashOnPath(t);
  const file = writeSessionFile(root, "s3");
  const { ctl, frames } = p9Ctl();
  ctl.onlineRooms = [{ id: "s3", cwd: "/x", online: true }];
  await ctl.onDeleteSession({ id: "cmd-3", args: { sessionId: "s3" } });
  const result = lastResult(frames);
  assert.equal(result.ok, false);
  assert.equal(result.code, "session_running");
  assert.equal(fs.existsSync(file), true);
});

test("onDeleteSession：文件已不在 → already_deleted，并发出 removed", async (t) => {
  tmpSessionRoot(t);
  withoutTrashOnPath(t);
  const { ctl, frames } = p9Ctl();
  await ctl.onDeleteSession({ id: "cmd-4", args: { sessionId: "gone" } });
  const result = lastResult(frames);
  assert.equal(result.ok, true);
  assert.equal(result.status, "already_deleted");
  assert.equal(result.data.method, null);
  assert.ok(frames.some((f) => f.type === "session_manifest" && f.removed && f.removed.includes("gone")));
});

test("onDeleteSession：符号链接指向根目录外面 → 路径越界被拒", async (t) => {
  const root = tmpSessionRoot(t);
  withoutTrashOnPath(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-attach-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const outsideFile = writeSessionFile(outside, "evil", { dirName: "." });
  fs.symlinkSync(outside, path.join(root, "--linked--"), "dir");
  const { ctl, frames } = p9Ctl();
  await ctl.onDeleteSession({ id: "cmd-5", args: { sessionId: "evil" } });
  const result = lastResult(frames);
  assert.equal(result.ok, false);
  assert.equal(result.code, "bad_args");
  assert.match(result.error, /越界/);
  assert.equal(fs.existsSync(outsideFile), true, "根目录外的文件不能被删");
});

test("onDeleteSession：不合法 id → bad_args", async (t) => {
  tmpSessionRoot(t);
  const { ctl, frames } = p9Ctl();
  for (const bad of ["../../etc/passwd", "a b", "", "x".repeat(201)]) {
    await ctl.onDeleteSession({ id: "cmd-6", args: { sessionId: bad } });
    assert.equal(lastResult(frames).code, "bad_args", JSON.stringify(bad));
  }
});

test("反向扫描：删掉文件发 removed；新文件/改动发清单行 + session_archive", async (t) => {
  const root = tmpSessionRoot(t);
  withoutTrashOnPath(t);
  const f1 = writeSessionFile(root, "s1");
  const { ctl, frames } = p9Ctl();
  ctl.publishLibrary();
  await new Promise((r) => setTimeout(r, 120));
  const full = frames.find((f) => f.type === "session_manifest" && f.full === true);
  assert.ok(full, "auth 后有全量清单");
  assert.equal(full.scope, "device");
  assert.equal(full.root, root, "全量清单带会话根目录 absolute path");
  assert.deepEqual(full.sessions.map((row) => row.id), ["s1"]);

  fs.unlinkSync(f1);
  frames.length = 0;
  await ctl.rescanOnce();
  assert.ok(frames.some((f) => f.type === "session_manifest" && Array.isArray(f.removed) && f.removed.includes("s1")), "删掉的发 removed");

  const f2 = writeSessionFile(root, "s2");
  frames.length = 0;
  await ctl.rescanOnce();
  const added = frames.find((f) => f.type === "session_manifest" && f.sessions && f.sessions.length === 1 && f.sessions[0].id === "s2");
  assert.ok(added, "新文件发增量清单行");
  assert.equal(added.full, false);
  assert.ok(frames.some((f) => f.type === "session_archive" && f.session && f.session.id === "s2"), "新文件发正文摘要");

  frames.length = 0;
  const bumped = new Date(Date.now() + 60_000);
  fs.utimesSync(f2, bumped, bumped);
  await ctl.rescanOnce();
  assert.ok(frames.some((f) => f.type === "session_manifest" && f.sessions && f.sessions[0] && f.sessions[0].id === "s2"), "mtime 变了要重发");
});

test("onListDirs：browseRoots 为空 → browse_disabled", () => {
  const { ctl, frames } = p9Ctl();
  ctl.onListDirs({ id: "l0", args: {} });
  assert.equal(lastResult(frames).code, "browse_disabled");
});

test("onListDirs：相对路径/不安全字符 → bad_args", (t) => {
  const { rootReal } = tmpBrowseRoot(t);
  const { ctl, frames } = p9Ctl({ browseRoots: [rootReal] });
  ctl.onListDirs({ id: "l1", args: { path: "relative/dir" } });
  assert.equal(lastResult(frames).code, "bad_args");
  ctl.onListDirs({ id: "l2", args: { path: rootReal + "/bad\nname" } });
  assert.equal(lastResult(frames).code, "bad_args");
  ctl.onListDirs({ id: "l3", args: { path: 123 } });
  assert.equal(lastResult(frames).code, "bad_args");
});

test("onListDirs：不存在 / 不是目录 / 根目录外 分别有明确错误码", (t) => {
  const { rootReal } = tmpBrowseRoot(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-attach-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const file = path.join(rootReal, "not-a-dir.txt");
  fs.writeFileSync(file, "x");
  const { ctl, frames } = p9Ctl({ browseRoots: [rootReal] });
  ctl.onListDirs({ id: "l4", args: { path: path.join(rootReal, "nope") } });
  assert.equal(lastResult(frames).code, "fs_not_found");
  ctl.onListDirs({ id: "l5", args: { path: file } });
  assert.equal(lastResult(frames).code, "fs_not_dir");
  ctl.onListDirs({ id: "l6", args: { path: fs.realpathSync.native(outside) } });
  assert.equal(lastResult(frames).code, "fs_outside_root");
  // .. 逃逸：realpath 之后同样在根外
  ctl.onListDirs({ id: "l7", args: { path: path.join(rootReal, "..") } });
  assert.equal(lastResult(frames).code, "fs_outside_root");
  fs.mkdirSync(path.join(rootReal, "a"));
  ctl.onListDirs({ id: "l8", args: { path: path.join(rootReal, "a", "..", "..") } });
  assert.equal(lastResult(frames).code, "fs_outside_root", "a/../.. 逃出根目录要拒绝（realpath 之后比根目录）");
});

test("onListDirs：隐藏目录开关、符号链接（根内收、根外丢）、只收目录", (t) => {
  const { rootReal } = tmpBrowseRoot(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-attach-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(rootReal, ".hidden"));
  fs.mkdirSync(path.join(rootReal, "visible"));
  fs.writeFileSync(path.join(rootReal, "a.txt"), "x");
  fs.mkdirSync(path.join(rootReal, "real-sub"));
  fs.symlinkSync(path.join(rootReal, "real-sub"), path.join(rootReal, "link-in"), "dir");
  fs.symlinkSync(outside, path.join(rootReal, "link-out"), "dir");
  const { ctl, frames } = p9Ctl({ browseRoots: [rootReal] });

  ctl.onListDirs({ id: "n1", args: {} });
  let result = lastResult(frames);
  assert.equal(result.data.path, rootReal, "不带 path 时列第一个根目录");
  let names = result.data.entries.map((e) => e.name);
  assert.deepEqual(names, ["link-in", "real-sub", "visible"], "隐藏目录默认不列，链接只收根内目录");
  assert.deepEqual(result.data.entries.find((e) => e.name === "link-in").path, path.join(result.data.path, "link-in"), "path 写链接自己的路径");
  assert.equal(result.data.truncated, false);
  assert.equal(result.data.parent, null, "根目录 parent 为 null");
  assert.equal(result.data.root, rootReal);

  ctl.onListDirs({ id: "n2", args: { showHidden: true } });
  names = lastResult(frames).data.entries.map((e) => e.name);
  assert.deepEqual(names, [".hidden", "link-in", "real-sub", "visible"]);
});

test("onListDirs：numeric 排序、子目录的 parent 是上一级", (t) => {
  const { rootReal } = tmpBrowseRoot(t);
  fs.mkdirSync(path.join(rootReal, "item10"));
  fs.mkdirSync(path.join(rootReal, "item2"));
  fs.mkdirSync(path.join(rootReal, "item1"));
  fs.mkdirSync(path.join(rootReal, "sub"));
  fs.mkdirSync(path.join(rootReal, "sub", "child"));
  const { ctl, frames } = p9Ctl({ browseRoots: [rootReal] });
  ctl.onListDirs({ id: "s1", args: {} });
  assert.deepEqual(lastResult(frames).data.entries.map((e) => e.name), ["item1", "item2", "item10", "sub"]);
  ctl.onListDirs({ id: "s2", args: { path: path.join(rootReal, "sub") } });
  const data = lastResult(frames).data;
  assert.equal(data.parent, rootReal);
  assert.deepEqual(data.entries.map((e) => e.name), ["child"]);
});

test("onListDirs：超过 500 个目录只回 500 个，truncated 为 true", (t) => {
  const { rootReal } = tmpBrowseRoot(t);
  for (let i = 0; i < 600; i++) fs.mkdirSync(path.join(rootReal, "d" + String(i).padStart(3, "0")));
  const { ctl, frames } = p9Ctl({ browseRoots: [rootReal] });
  ctl.onListDirs({ id: "t1", args: {} });
  const data = lastResult(frames).data;
  assert.equal(data.entries.length, 500);
  assert.equal(data.truncated, true);
});

test("onListDirs：控制字符目录名跳过；无权限 → fs_denied（root 用户跳过）", (t) => {
  const { rootReal } = tmpBrowseRoot(t);
  try {
    fs.mkdirSync(path.join(rootReal, "bad\u0001name"));
  } catch {}
  const denied = path.join(rootReal, "denied");
  fs.mkdirSync(denied);
  const { ctl, frames } = p9Ctl({ browseRoots: [rootReal] });
  ctl.onListDirs({ id: "c1", args: { showHidden: true } });
  assert.deepEqual(lastResult(frames).data.entries.map((e) => e.name), ["denied"]);
  if (process.platform === "win32") return; // Windows 上目录权限语义不同，这条跳过
  if (typeof process.getuid === "function" && process.getuid() === 0) return; // root 不受目录权限限制
  fs.chmodSync(denied, 0o000);
  try {
    ctl.onListDirs({ id: "c2", args: { path: denied } });
    assert.equal(lastResult(frames).code, "fs_denied");
  } finally {
    fs.chmodSync(denied, 0o700);
  }
});

test("planLaunch：浏览根目录内的 cwd 允许远程拉起；根外仍 cwd_not_allowed", async (t) => {
  const { rootReal } = tmpBrowseRoot(t);
  const inside = path.join(rootReal, "newproj");
  const { ctl } = p9Ctl({ browseRoots: [rootReal], existsDir: () => true });
  const plan = await ctl.planLaunch({ cwd: inside, source: "remote" });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "spawn");
  assert.equal(plan.cwd, inside);
  const outside = path.join(os.tmpdir(), "pi-attach-not-allowed-" + Date.now());
  const rejected = await ctl.planLaunch({ cwd: outside, source: "remote" });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "cwd_not_allowed");
});

test("harness_start：浏览根目录下的新文件夹能拉起；根目录外回 cwd_not_allowed", async (t) => {
  const { rootReal } = tmpBrowseRoot(t);
  const inside = path.join(rootReal, "new-folder");
  const { ctl, frames, spawned } = p9Ctl({ browseRoots: [rootReal], existsDir: () => true, launchWaitMs: 0 });
  await ctl.onHarness({ id: "h1", args: { cwd: inside } });
  const started = lastResult(frames);
  assert.equal(started.ok, true);
  assert.equal(started.status, "started");
  assert.equal(spawned.length, 1, "真的调用了 spawn");
  const outside = path.join(os.tmpdir(), "pi-attach-harness-out-" + Date.now());
  await ctl.onHarness({ id: "h2", args: { cwd: outside } });
  const rejected = lastResult(frames);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "cwd_not_allowed");
  assert.equal(spawned.length, 1, "被拒绝的目录不 spawn");
});

test("planLaunch：sessionId 形态在全根找文件、读会话头 cwd，再按 launchAllowed 检查", async (t) => {
  const sessionRoot = tmpSessionRoot(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-attach-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const homeReal = fs.realpathSync.native(home);
  const cwdInside = path.join(homeReal, "proj");
  const file = writeSessionFile(sessionRoot, "s9", { dirName: "--elsewhere--", cwd: cwdInside });
  const { ctl } = p9Ctl({ browseRoots: [homeReal], existsDir: () => true, sessionLookup: null });
  const plan = await ctl.planLaunch({ sessionId: "s9", source: "remote" });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "spawn");
  assert.equal(plan.sessionId, "s9");
  assert.equal(plan.sessionPath, file, "在整个会话根目录里按 id 找到文件");
  assert.equal(plan.cwd, cwdInside, "从会话头读出 cwd");

  const outsideCwd = path.join(os.tmpdir(), "pi-attach-outside-proj-" + Date.now());
  writeSessionFile(sessionRoot, "s10", { dirName: "--out--", cwd: outsideCwd });
  const rejected = await ctl.planLaunch({ sessionId: "s10", source: "remote" });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "cwd_not_allowed", "会话头 cwd 不在白名单也不在浏览根 → 拒绝");
});

/* ================= P9 审查第 1 轮修复（P1-1 / P1-3 / P1-4 / P2-4） ================= */

/** 把文件 mtime 改成指定时刻（用来模拟"会话文件被写过"）。 */
function touchSessionFile(file, ms) {
  const when = new Date(ms);
  fs.utimesSync(file, when, when);
}

const FRAMES_TYPE = (frames, type) => frames.filter((f) => f.type === type);

test("P1-1 + BUG-4：在线会话 mtime 变化时扫描不发任何帧（扩展负责上报，且不整份读正文）", async (t) => {
  const root = tmpSessionRoot(t);
  withoutTrashOnPath(t);
  const file = writeSessionFile(root, "s1");
  const { ctl, frames } = p9Ctl();
  ctl.onlineRooms = [{ id: "s1", cwd: os.tmpdir(), online: true }];
  ctl.publishLibrary();
  await new Promise((r) => setTimeout(r, 120));
  frames.length = 0;

  touchSessionFile(file, Date.now() + 60_000);
  await ctl.rescanOnce();
  // BUG-4：在线会话由扩展上报（正文走房间实时流），扫描直接跳过：
  // 不读正文、不发清单行，避免大会话每 30s 被整份 readFileSync + 解析一遍。
  assert.equal(FRAMES_TYPE(frames, "session_manifest").length, 0, "在线会话扫描不发清单行");
  assert.equal(FRAMES_TYPE(frames, "session_archive").length, 0, "在线会话不补正文");
});

test("P1-1：非在线会话 mtime 变化补正文，但同一会话 10 分钟内最多一次", async (t) => {
  const root = tmpSessionRoot(t);
  withoutTrashOnPath(t);
  const file = writeSessionFile(root, "s1");
  const { ctl, frames } = p9Ctl();
  ctl.publishLibrary();
  await new Promise((r) => setTimeout(r, 120));

  // 把上次正文时间拨到 11 分钟前 → 允许补一次
  ctl.archiveSentAt.set("s1", Date.now() - 11 * 60 * 1000);
  frames.length = 0;
  touchSessionFile(file, Date.now() + 60_000);
  await ctl.rescanOnce();
  assert.equal(FRAMES_TYPE(frames, "session_archive").length, 1, "离线会话改动后补一次正文");

  // 10 分钟内再改一次：仍发清单行，但不再发正文
  frames.length = 0;
  touchSessionFile(file, Date.now() + 120_000);
  await ctl.rescanOnce();
  const again = FRAMES_TYPE(frames, "session_manifest");
  assert.equal(again.length, 1, "清单行照发");
  // BUG-4：扫描行不带 active，别把运行中/活动标记清掉（manifestRow 默认 active:false）
  assert.equal("active" in again[0].sessions[0], false, "扫描行不带 active 字段");
  assert.equal(FRAMES_TYPE(frames, "session_archive").length, 0, "10 分钟内不重复发正文");
});

test("P1-3：pathHint 指向根目录外的真实会话文件 → session_outside_root，不发 removed、不改文件", async (t) => {
  tmpSessionRoot(t);
  withoutTrashOnPath(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-attach-p1n3-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const file = writeSessionFile(outside, "s1", { dirName: "." });
  const { ctl, frames } = p9Ctl();
  await ctl.onDeleteSession({ id: "c1", args: { sessionId: "s1", pathHint: file } });
  const result = lastResult(frames);
  assert.equal(result.ok, false);
  assert.equal(result.code, "session_outside_root");
  assert.match(result.error, /不在设备的会话目录里/);
  assert.equal(FRAMES_TYPE(frames, "session_manifest").length, 0, "不发 removed（relay 不清副本）");
  assert.equal(fs.existsSync(file), true, "根目录外的文件不删");
});

test("P1-3：pathHint 名字不匹配 / 不存在 / 在根内但没扫到 → 维持 already_deleted", async (t) => {
  const root = tmpSessionRoot(t);
  withoutTrashOnPath(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-attach-p1n3b-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  // 名字对不上这个 id：即使文件存在、在根目录外，也不能算 session_outside_root
  const wrongName = writeSessionFile(outside, "other", { dirName: "." });
  // 根目录里存在但比 findSessionFileAnywhere 的一层扫描更深：在根内 → already_deleted
  const deep = path.join(root, "--proj--", "deep");
  fs.mkdirSync(deep, { recursive: true });
  const deepFile = path.join(deep, "1700000000000_s2.jsonl");
  fs.writeFileSync(deepFile, "{}\n");
  const { ctl, frames } = p9Ctl();
  await ctl.onDeleteSession({ id: "c2", args: { sessionId: "s1", pathHint: wrongName } });
  assert.equal(lastResult(frames).ok, true);
  assert.equal(lastResult(frames).status, "already_deleted");
  await ctl.onDeleteSession({ id: "c3", args: { sessionId: "s1", pathHint: path.join(outside, "nope.jsonl") } });
  assert.equal(lastResult(frames).status, "already_deleted");
  await ctl.onDeleteSession({ id: "c4", args: { sessionId: "s2", pathHint: deepFile } });
  assert.equal(lastResult(frames).status, "already_deleted", "根内的隐藏文件按已删处理，不报 outside");
  assert.equal(fs.existsSync(deepFile), true, "没扫到的文件不动");
});

test("P1-4：正文读不出来的文件仍进带 scope=device 的全量清单（relay 不会误打墓碑）", async (t) => {
  if (process.platform === "win32") return; // Windows 上 chmod 000 的权限语义不同
  if (typeof process.getuid === "function" && process.getuid() === 0) return; // root 读得到
  const root = tmpSessionRoot(t);
  withoutTrashOnPath(t);
  writeSessionFile(root, "ok");
  const bad = writeSessionFile(root, "bad");
  fs.chmodSync(bad, 0o000);
  try {
    const { ctl, frames } = p9Ctl();
    ctl.publishLibrary();
    await new Promise((r) => setTimeout(r, 120));
    const full = frames.find((f) => f.type === "session_manifest" && f.full === true);
    assert.ok(full, "有全量清单");
    const ids = full.sessions.map((row) => row.id).sort();
    assert.deepEqual(ids, ["bad", "ok"], "读失败的文件也在清单里");
    const badRow = full.sessions.find((row) => row.id === "bad");
    assert.equal(badRow.path, bad, "带上 path");
    // BUG-2：兜底行只带 id + path + updatedAt，其它字段必须缺省（undefined），不能写空值——
    // relay 的 _sessionFrom 对空值会当成新值，把索引里的名字/cwd/消息数/大小/创建时间清掉。
    assert.deepEqual(Object.keys(badRow).sort(), ["id", "path", "updatedAt"], "兜底行只带 id/path/updatedAt");
    // R3-1：updatedAt 必须是文件真实 mtime（relay 才不会用帧时间、把读不出的会话显示成「刚刚」）
    assert.equal(badRow.updatedAt, fs.statSync(bad).mtimeMs, "updatedAt 用文件真实 mtime");
    assert.equal(FRAMES_TYPE(frames, "session_archive").length, 1, "正文只发可读的那个");
  } finally {
    fs.chmodSync(bad, 0o600);
  }
});

test("P2-4：parseBrowseRoots 在 win32 下用 realpathSync.native 解开 junction（纯函数注入）", () => {
  const calls = [];
  const roots = attach.parseBrowseRoots("C:\\Users\\a\\link;D:\\work", "win32", {
    realpathNative: (p) => {
      calls.push(p);
      return p === "C:\\Users\\a\\link" ? "C:\\Users\\a\\real" : p;
    },
    isDir: () => true,
  });
  assert.deepEqual(roots, ["C:\\Users\\a\\real", "D:\\work"], "根目录按真实路径返回");
  assert.deepEqual(calls, ["C:\\Users\\a\\link", "D:\\work"], "每个根都过 native realpath");

  // 两个名字（链接 + 真身）解析到同一真实路径 → 去重后只剩一个
  const deduped = attach.parseBrowseRoots("C:\\Users\\a\\link;C:\\Users\\a\\real", "win32", {
    realpathNative: (p) => (p === "C:\\Users\\a\\link" ? "C:\\Users\\a\\real" : p),
    isDir: () => true,
  });
  assert.deepEqual(deduped, ["C:\\Users\\a\\real"]);
});

test("doctor 文案：Linux 的 tmux 安装提示按发行版给 apt/dnf/…，不出现 macOS 的 brew；平台标题首字母大写", () => {
  assert.equal(attach.platformLabel("linux"), "Linux");
  assert.equal(attach.platformLabel("darwin"), "macOS");
  assert.equal(attach.platformLabel("win32"), "Windows");
  assert.equal(attach.platformLabel("freebsd"), "Freebsd", "不认识的平台也不能全小写");

  assert.match(attach.tmuxInstallHint("darwin"), /brew install tmux/);
  assert.match(attach.tmuxInstallHint("linux", { exists: (p) => p === "/usr/bin/apt-get" }), /apt install -y tmux/);
  assert.match(attach.tmuxInstallHint("linux", { exists: (p) => p === "/usr/bin/dnf" }), /dnf install -y tmux/);
  assert.match(attach.tmuxInstallHint("linux", { exists: (p) => p === "/usr/bin/pacman" }), /pacman -S/);
  const fallback = attach.tmuxInstallHint("linux", { exists: () => false });
  assert.match(fallback, /apt install -y tmux/);
  assert.match(fallback, /dnf install -y tmux/);
  assert.doesNotMatch(fallback, /brew/, "Linux 上不能让人 brew install tmux");
  assert.match(attach.tmuxInstallHint("win32"), /不需要 tmux/);
});

test("doctor pi 路径可执行性：不存在 / 目录 / 没有执行位都给出具体原因", { skip: process.platform === "win32" }, () => {
  const dir = tmpDir();
  assert.match(attach.piBinaryProblem(path.join(dir, "missing-pi"), "linux"), /路径不存在/);
  assert.match(attach.piBinaryProblem(dir, "linux"), /不是可执行文件/);
  const plain = path.join(dir, "pi-noexec");
  fs.writeFileSync(plain, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(plain, 0o644);
  assert.match(attach.piBinaryProblem(plain, "linux"), /没有可执行权限/);
  const ok = path.join(dir, "pi-exec");
  fs.writeFileSync(ok, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(ok, 0o755);
  assert.equal(attach.piBinaryProblem(ok, "linux"), "");
  assert.equal(attach.piBinaryProblem("pi", "linux"), "", "PATH 探到的哨兵已经由 spawn 验证过");
});

test("doctor pi 路径可执行性：Windows 按扩展名只认 .exe/.cmd/.bat/.com", () => {
  const dir = tmpDir();
  for (const name of ["pi.exe", "pi.cmd", "pi.bat", "pi.com"]) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "");
    assert.equal(attach.piBinaryProblem(file, "win32"), "", name);
  }
  const ps1 = path.join(dir, "pi.ps1");
  fs.writeFileSync(ps1, "");
  assert.match(attach.piBinaryProblem(ps1, "win32"), /\.exe \/ \.cmd/);
  assert.match(attach.piBinaryProblem(path.join(dir, "nope.exe"), "win32"), /路径不存在/);
});

test("--doctor：Linux 标题是 Linux、tmux 提示不含 brew，防休眠那一行也在", async () => {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, "PI_REMOTE_RELAY=ws://127.0.0.1:7001\nPI_REMOTE_DEVICE_ID=d1\nPI_REMOTE_DEVICE_TOKEN=tok\nPI_REMOTE_LAUNCHER=tmux\n", "utf8");
  const lines = [];
  const code = await attach.doctorMain({}, envPath, {
    writeOut: (line) => lines.push(String(line)),
    platform: "linux",
    env: { PI_REMOTE_ATTACH_FILE: path.join(dir, "state.json"), PI_REMOTE_PI_BIN: process.execPath },
    probe: async () => ({ ok: true }),
    spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "" }),
  });
  const text = lines.join("\n");
  assert.equal(code, 1, text);
  assert.match(text, /^pi-remote doctor · Linux$/m);
  assert.doesNotMatch(text, /brew install tmux/);
  assert.match(text, /找不到 tmux；.*apt install -y tmux/);
  assert.ok(lines.some((line) => line.includes("防休眠")), "Linux 上防休眠要有一行体检结果\n" + text);
});

test("--doctor：PI_REMOTE_PI_BIN 写错时判 fail 并说明原因，不再报 ✓ pi", async () => {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, "PI_REMOTE_RELAY=ws://127.0.0.1:7001\nPI_REMOTE_DEVICE_ID=d1\nPI_REMOTE_DEVICE_TOKEN=tok\nPI_REMOTE_LAUNCHER=tmux\n", "utf8");
  const lines = [];
  const code = await attach.doctorMain({}, envPath, {
    writeOut: (line) => lines.push(String(line)),
    platform: "linux",
    env: { PI_REMOTE_ATTACH_FILE: path.join(dir, "state.json"), PI_REMOTE_PI_BIN: path.join(dir, "missing-pi") },
    probe: async () => ({ ok: true }),
    spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "" }),
  });
  const text = lines.join("\n");
  assert.equal(code, 1, text);
  assert.match(text, /✗ pi 路径不可用：路径不存在/);
  assert.doesNotMatch(text, /✓ pi：/);
});

test("findPiInfo：Windows 直接在 PATH 里找 pi.exe/.cmd/.bat（spawn 起不了 .cmd 时 doctor 仍看得见）", () => {
  const dir = tmpDir();
  const cmd = path.join(dir, "pi.cmd");
  fs.writeFileSync(cmd, "");
  const info = attach.findPiInfo(() => ({ status: 1, error: new Error("EINVAL") }), { Path: dir }, "win32");
  assert.equal(info.path, cmd);
  assert.equal(info.from, "PATH");
  assert.equal(attach.piBinaryProblem(info.path, "win32"), "", ".cmd 是 Windows 合法可执行");
});

test("displayPathOf：显示还原 \\$；命令执行用的原值不动", () => {
  assert.equal(attach.displayPathOf("/srv/we ird \\$x"), "/srv/we ird $x");
  assert.equal(attach.displayPathOf("/srv/plain $x"), "/srv/plain $x");
  assert.equal(attach.displayPathOf("C:\\work\\$x"), "C:\\work$x", "只还原紧挨着的 \\$，不动 Windows 分隔符");
  const { ctl, logs } = makeCtl({ platform: "linux" });
  ctl.writeOut("已拉起：" + attach.displayPathOf("/srv/we ird \\$x"));
  assert.match(logs.join("\n"), /已拉起：\/srv\/we ird \$x/);
});

// ---------- 加密阶段 1（设计 A §3）：设备身份钥 / 配对 v2 / ACK 自持 ----------

const nodeCrypto = require("node:crypto");
const relayUtil = require("../relay/util.js");

test("身份钥生成：形状与协议 limits 对齐、0600、二次 ensure 不覆盖", () => {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  const ctx = attach.ensureDeviceKeys(envPath, { env: {}, deviceId: "dev-1" });
  assert.equal(ctx.created, true);
  assert.equal(ctx.file, path.join(dir, "pi-remote-device.key.json"));
  assert.equal((fs.statSync(ctx.file).mode & 0o777).toString(8), "600");
  const saved = JSON.parse(fs.readFileSync(ctx.file, "utf8"));
  assert.equal(saved.v, 1);
  assert.equal(saved.deviceId, "dev-1");
  assert.equal(saved.sign.alg, "ed25519");
  assert.equal(saved.box.alg, "p256");
  assert.equal(Buffer.from(saved.sign.pub, "base64").length, 44, "Ed25519 spki der 恰为协议 limits signPubKeyBytes");
  assert.ok(Buffer.from(saved.box.pub, "base64").length <= 128, "P-256 spki der 不超 boxPubKeyBytes");
  const before = fs.readFileSync(ctx.file, "utf8");
  const again = attach.ensureDeviceKeys(envPath, { env: {}, deviceId: "dev-other" });
  assert.equal(again.created, false);
  assert.equal(again.keys.sign.pub, saved.sign.pub, "已有钥绝不重生成");
  assert.equal(fs.readFileSync(ctx.file, "utf8"), before, "已有钥文件逐字节不动（deviceId 也不顺手改）");
});

test("指纹与 relay/util.js 对拍一致（同源同算法）", () => {
  const dir = tmpDir();
  const ctx = attach.ensureDeviceKeys(path.join(dir, ".env"), { env: {} });
  const fp = attach.keyFingerprint(ctx.keys.sign.pub);
  assert.equal(fp, relayUtil.keyFingerprint(ctx.keys.sign.pub));
  assert.equal(fp.length, 16);
  assert.equal(attach.formatFingerprint(fp), relayUtil.formatFingerprint(fp));
  assert.match(attach.formatFingerprint(fp), /^([0-9a-f]{4} ){3}[0-9a-f]{4}$/);
});

test("PoP：对裸码签名可被独立验签（relay 验法），错码验不过", () => {
  const dir = tmpDir();
  const ctx = attach.ensureDeviceKeys(path.join(dir, ".env"), { env: {} });
  const pop = attach.signPairPop(ctx.keys, "ABCDEFGH");
  assert.ok(Buffer.from(pop, "base64").length <= 128, "签名不超 signatureMaxBytes");
  const pub = nodeCrypto.createPublicKey({ key: Buffer.from(ctx.keys.sign.pub, "base64"), format: "der", type: "spki" });
  assert.equal(nodeCrypto.verify(null, Buffer.from("ABCDEFGH", "utf8"), pub, Buffer.from(pop, "base64")), true);
  assert.equal(nodeCrypto.verify(null, Buffer.from("ABCDEFGX", "utf8"), pub, Buffer.from(pop, "base64")), false);
});

test("钥文件损坏：明确报错且不覆盖（坏 JSON / 公私钥不配对）", () => {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  const file = path.join(dir, "pi-remote-device.key.json");
  fs.writeFileSync(file, "{not json", "utf8");
  assert.throws(() => attach.loadDeviceKeys(file), /设备钥文件损坏/);
  assert.throws(() => attach.ensureDeviceKeys(envPath, { env: {} }), /设备钥文件损坏/);
  assert.equal(fs.readFileSync(file, "utf8"), "{not json", "损坏文件不许被静默覆盖");

  const ctx = attach.ensureDeviceKeys(path.join(dir, "sub", ".env"), { env: {} });
  const tampered = JSON.parse(fs.readFileSync(ctx.file, "utf8"));
  const other = attach.generateDeviceKeys("");
  tampered.sign.pub = other.sign.pub; // 公钥换成别人的：与私钥不成对
  fs.writeFileSync(ctx.file, JSON.stringify(tampered), "utf8");
  assert.throws(() => attach.loadDeviceKeys(ctx.file), /不成对|对不上/);
});

test("ACK 存取：往返、重读保留并发改动、ensure 幂等、首台判定三分支", () => {
  const dir = tmpDir();
  const ctx = attach.ensureDeviceKeys(path.join(dir, ".env"), { env: {} });
  const ack1 = nodeCrypto.randomBytes(32).toString("base64");
  let keys = attach.storeAccountAck(ctx.file, "admin", ack1);
  assert.equal(attach.accountAckOf(keys, "admin"), ack1);
  // 模拟扩展侧并发写：直接在盘上加一个账号的 ACK，本函数的下一次写必须保留它
  const onDisk = JSON.parse(fs.readFileSync(ctx.file, "utf8"));
  onDisk.contentKeys.other = "b3RoZXItYWNr";
  fs.writeFileSync(ctx.file, JSON.stringify(onDisk), "utf8");
  keys = attach.storeAccountAck(ctx.file, "second", "c2Vjb25kLWFjaw==");
  assert.equal(attach.accountAckOf(keys, "admin"), ack1);
  assert.equal(attach.accountAckOf(keys, "other"), "b3RoZXItYWNr");
  assert.equal(attach.accountAckOf(keys, "second"), "c2Vjb25kLWFjaw==");

  const gen = attach.ensureAccountAck(ctx.file, keys, "third");
  assert.equal(gen.created, true);
  assert.equal(Buffer.from(gen.ack, "base64").length, 32);
  const again = attach.ensureAccountAck(ctx.file, gen.keys, "third");
  assert.equal(again.created, false);
  assert.equal(again.ack, gen.ack, "已有 ACK 永不重生成（防分叉）");

  // finalizePairKeys：ackFp / grant / hasKeyHolder 任一在场 → 不生成；全缺席 → 生成自持
  const fresh = () => {
    const d = tmpDir();
    return attach.ensureDeviceKeys(path.join(d, ".env"), { env: {} });
  };
  const c1 = fresh();
  attach.finalizePairKeys(c1, { accountId: "admin", ackFp: "0123456789abcdef" });
  assert.equal(attach.accountAckOf(c1.keys, "admin"), "", "relay 已知 ACK 指纹时不许自生成");
  const c2 = fresh();
  attach.finalizePairKeys(c2, { accountId: "admin", contentKeyGrant: { to: "x", nonce: "n", ct: "c" } });
  assert.equal(attach.accountAckOf(c2.keys, "admin"), "", "grant 交付在途时不许自生成");
  const c3 = fresh();
  attach.finalizePairKeys(c3, { accountId: "admin" });
  assert.equal(Buffer.from(attach.accountAckOf(c3.keys, "admin"), "base64").length, 32, "首台钥设备生成并自持");
  const c4 = fresh();
  attach.finalizePairKeys(c4, { accountId: "admin", hasKeyHolder: true });
  assert.equal(attach.accountAckOf(c4.keys, "admin"), "", "账号已有其他持钥端时不许自生成（防 ACK 分叉）");
  const c5 = fresh();
  attach.finalizePairKeys(c5, { accountId: "admin", hasKeyHolder: false });
  assert.equal(Buffer.from(attach.accountAckOf(c5.keys, "admin"), "base64").length, 32, "hasKeyHolder=false 与缺席同口径：首台生成自持");
});

test("--pair 钥形态：keyRegistered 无令牌完成配对，.env 只写路径，ACK 自持生成，钥料不打印", async () => {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, "PI_REMOTE_RELAY=ws://relay:7001\nPI_REMOTE_DEVICE_" + "TOKEN=" + "stale-token" + "\n", "utf8");
  const { FakeWS, seen } = fakeRelaySocket((frame) =>
    frame.type === "pair" ? { type: "pair_result", ok: true, accountId: "admin", deviceId: "dev-key-1", keyRegistered: true } : null,
  );
  const lines = [];
  const code = await attach.pairMain({ pair: "ABCDEFGH", relay: "" }, envPath, {
    WebSocketImpl: FakeWS,
    platform: "darwin",
    env: {},
    writeOut: (l) => lines.push(l),
    writeErr: (l) => lines.push(l),
  });
  assert.equal(code, 0, lines.join("\n"));
  assert.ok(seen[0].keys && seen[0].keys.pop, "pair 帧带 keys+pop");
  const vars = attach.parseEnv(fs.readFileSync(envPath, "utf8"));
  assert.equal(vars.PI_REMOTE_DEVICE_ID, "dev-key-1");
  assert.equal(vars.PI_REMOTE_DEVICE_TOKEN, "", "钥形态把旧令牌清空（relay 侧令牌行已作废）");
  const keyFile = path.join(dir, "pi-remote-device.key.json");
  assert.equal(vars.PI_REMOTE_DEVICE_KEY_FILE, keyFile, ".env 只写钥文件路径");
  const keys = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  assert.equal(keys.deviceId, "dev-key-1", "deviceId 回填钥文件");
  assert.equal(Buffer.from(keys.contentKeys.admin, "base64").length, 32, "首台钥设备生成 ACK 自持");
  const text = lines.join("\n");
  assert.ok(!text.includes(keys.sign.priv), "私钥不许出现在输出里");
  assert.ok(!text.includes(keys.contentKeys.admin), "ACK 不许出现在输出里");
  assert.ok(!text.includes("stale-token"), "旧令牌不许出现在输出里");
  assert.match(text, /身份钥已登记/);
});

test("--pair 钥形态：relay 回 ackFp 时不自生成 ACK（等交付）", async () => {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  const { FakeWS } = fakeRelaySocket((frame) =>
    frame.type === "pair" ? { type: "pair_result", ok: true, accountId: "admin", deviceId: "dev-key-2", keyRegistered: true, ackFp: "0123456789abcdef" } : null,
  );
  const lines = [];
  const code = await attach.pairMain({ pair: "ABCDEFGH", relay: "ws://r:7001" }, envPath, {
    WebSocketImpl: FakeWS,
    platform: "darwin",
    env: {},
    writeOut: (l) => lines.push(l),
    writeErr: (l) => lines.push(l),
  });
  assert.equal(code, 0, lines.join("\n"));
  const keys = JSON.parse(fs.readFileSync(path.join(dir, "pi-remote-device.key.json"), "utf8"));
  assert.equal(keys.contentKeys, undefined, "账号已有 ACK 时本机不生成");
});

test("pair_result 双形态：带 deviceKeys 时令牌形态照收（旧 relay 逐字节兼容）", async () => {
  const dir = tmpDir();
  const ctx = attach.ensureDeviceKeys(path.join(dir, ".env"), { env: {} });
  const tok = fakeRelaySocket(() => ({ type: "pair_result", ok: true, accountId: "admin", deviceId: "d1", deviceToken: "tok-1" }));
  const r1 = await attach.requestPairing({ relay: "ws://r:7001", code: "ABCDEFGH", deviceKeys: ctx.keys, WebSocketImpl: tok.FakeWS, platform: "darwin" });
  assert.deepEqual([r1.ok, r1.deviceToken, !!r1.keyRegistered], [true, "tok-1", false]);
  assert.ok(tok.seen[0].keys.pop, "帧照样带 keys（旧 relay 忽略未知字段）");
  const key = fakeRelaySocket(() => ({ type: "pair_result", ok: true, deviceId: "d2", keyRegistered: true, hasKeyHolder: true }));
  const r2 = await attach.requestPairing({ relay: "ws://r:7001", code: "ABCDEFGH", deviceKeys: ctx.keys, WebSocketImpl: key.FakeWS, platform: "darwin" });
  assert.deepEqual([r2.ok, r2.keyRegistered, r2.deviceToken], [true, true, ""], "无令牌不算失败");
  assert.equal(r2.hasKeyHolder, true, "hasKeyHolder 原样带回（ACK 自持判定在落盘处）");
});

test("--pair 钥形态：hasKeyHolder=true → 不自生成 ACK，文案如实提示等索取", async () => {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  const { FakeWS } = fakeRelaySocket((frame) =>
    frame.type === "pair" ? { type: "pair_result", ok: true, accountId: "admin", deviceId: "dev-key-3", keyRegistered: true, hasKeyHolder: true } : null,
  );
  const lines = [];
  const code = await attach.pairMain({ pair: "ABCDEFGH", relay: "ws://r:7001" }, envPath, {
    WebSocketImpl: FakeWS,
    platform: "darwin",
    env: {},
    writeOut: (l) => lines.push(l),
    writeErr: (l) => lines.push(l),
  });
  assert.equal(code, 0, lines.join("\n"));
  const keys = JSON.parse(fs.readFileSync(path.join(dir, "pi-remote-device.key.json"), "utf8"));
  assert.equal(keys.contentKeys, undefined, "已有其他持钥端时本机不生成 ACK，钥文件不留该账号条目（防分叉）");
  const text = lines.join("\n");
  assert.match(text, /已有持钥设备/, "配对成功文案须如实显示尚未持有内容钥");
  assert.match(text, /索取/, "文案须说明上线后自动向持钥设备索取");
  assert.ok(!text.includes("本机持有本账号的内容钥"), "没持有不许装作持有");
});

test("--link 钥形态：pair_request 自带码 + keys/pop，核对字只展示 relay 回值，keyRegistered 落盘", async () => {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  const ctx = attach.ensureDeviceKeys(envPath, { env: {} });
  const seen = [];
  class LinkWS {
    constructor() {
      this.handlers = {};
      setImmediate(() => this.handlers.open && this.handlers.open());
    }
    on(ev, fn) {
      this.handlers[ev] = fn;
    }
    send(data) {
      const frame = JSON.parse(data);
      seen.push(frame);
      if (frame.type === "pair_request") {
        // relay 采用设备自带码：回展示形态与 SAS 核对字（核对字由 relay 算，本机只展示）
        const disp = frame.code.slice(0, 4) + "-" + frame.code.slice(4);
        setImmediate(() => this.handlers.message(JSON.stringify({ type: "pair_request_result", ok: true, code: disp, expiresAt: Date.now() + 60000, checkDigits: "07" })));
        setImmediate(() => this.handlers.message(JSON.stringify({ type: "pair_result", ok: true, accountId: "admin", deviceId: "dev-link", keyRegistered: true })));
      }
    }
    close() {}
  }
  let shown = null;
  const r = await attach.requestLinkAttempt({
    relay: "ws://r:7001",
    deviceKeys: ctx.keys,
    WebSocketImpl: LinkWS,
    platform: "darwin",
    onCode: (info) => {
      shown = info;
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.keyRegistered, true);
  assert.match(seen[0].code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/, "带钥申请自带一枚协议字母表的裸码");
  assert.equal(seen[0].keys.signPub, ctx.keys.sign.pub);
  const pub = nodeCrypto.createPublicKey({ key: Buffer.from(seen[0].keys.signPub, "base64"), format: "der", type: "spki" });
  assert.equal(nodeCrypto.verify(null, Buffer.from(seen[0].code, "utf8"), pub, Buffer.from(seen[0].keys.pop, "base64")), true, "pop 签的就是自带码（relay 同法验签）");
  assert.equal(shown.code, seen[0].code, "relay 采用设备自带码");
  assert.equal(shown.checkDigits, "07", "核对字是 relay 的值，本机不自算");
});

test("--pair：展示形态的码（XXXX-XXXX）也先归一再签 pop，与 relay 归一口径一致", async () => {
  const dir = tmpDir();
  const ctx = attach.ensureDeviceKeys(path.join(dir, ".env"), { env: {} });
  const { FakeWS, seen } = fakeRelaySocket(() => ({ type: "pair_result", ok: true, deviceId: "d3", deviceToken: "t3" }));
  const r = await attach.requestPairing({ relay: "ws://r:7001", code: "abcd-efgh", deviceKeys: ctx.keys, WebSocketImpl: FakeWS, platform: "darwin" });
  assert.equal(r.ok, true);
  assert.equal(seen[0].code, "ABCDEFGH", "帧里的码是归一后的裸码");
  const pub = nodeCrypto.createPublicKey({ key: Buffer.from(seen[0].keys.signPub, "base64"), format: "der", type: "spki" });
  assert.equal(nodeCrypto.verify(null, Buffer.from("ABCDEFGH", "utf8"), pub, Buffer.from(seen[0].keys.pop, "base64")), true);
});

test("--doctor：身份钥指纹可见、私钥与 ACK 不打印；无钥时提示尚未生成", async () => {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, "PI_REMOTE_RELAY=ws://127.0.0.1:7001\nPI_REMOTE_DEVICE_ID=d1\n", "utf8");
  const baseOpts = (lines) => ({
    writeOut: (l) => lines.push(String(l)),
    platform: "darwin",
    env: { PI_REMOTE_ATTACH_FILE: path.join(dir, "state.json"), PI_REMOTE_PI_BIN: process.execPath },
    probe: async () => ({ ok: true }),
    spawnSyncImpl: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  const lines1 = [];
  await attach.doctorMain({}, envPath, baseOpts(lines1));
  assert.ok(lines1.some((l) => l.includes("设备身份钥") && l.includes("尚未生成")), lines1.join("\n"));

  const ctx = attach.ensureDeviceKeys(envPath, { env: {} });
  attach.storeAccountAck(ctx.file, "admin", nodeCrypto.randomBytes(32).toString("base64"));
  const keysNow = attach.loadDeviceKeys(ctx.file);
  const lines2 = [];
  await attach.doctorMain({}, envPath, baseOpts(lines2));
  const text = lines2.join("\n");
  assert.ok(text.includes("设备身份钥") && text.includes(attach.formatFingerprint(attach.keyFingerprint(keysNow.sign.pub))), text);
  assert.ok(text.includes("账号内容钥"), text);
  assert.ok(!text.includes(keysNow.sign.priv), "私钥不许出现在 doctor 输出里");
  assert.ok(!text.includes(keysNow.contentKeys.admin), "ACK 不许出现在 doctor 输出里");
});

test("钥模式鉴权帧与应答签名：caps 带 crypto.auth、不带令牌，签名与 relay 的 authPayload 同口径", () => {
  const dir = tmpDir();
  const ctx = attach.ensureDeviceKeys(path.join(dir, ".env"), { env: {} });
  const frame = attach.attachKeyAuthFrame({ deviceId: "dev-1", keys: ctx.keys, platform: "darwin", clientNonce: "Y2xpZW50LW5vbmNlLTE2Yg==" });
  assert.equal(frame.type, "auth");
  assert.equal(frame.role, "local");
  assert.ok(frame.caps.includes("crypto.auth"));
  assert.ok(frame.caps.includes("session.files"), "既有能力位保留（relay 按 caps 算 features）");
  assert.equal(frame.keyFp, attach.keyFingerprint(ctx.keys.sign.pub));
  assert.equal("deviceToken" in frame, false, "带 keyFp 走挑战路，不许再带设备令牌");
  assert.equal("token" in frame, false);
  // 独立按 relay/pairing.js 的 authPayload 拼法验签
  const relayNonce = nodeCrypto.randomBytes(32);
  const clientNonce = Buffer.from(frame.clientNonce, "base64");
  const sig = attach.signAuthResponse(ctx.keys, "dev-1", relayNonce.toString("base64"), frame.clientNonce);
  const payload = Buffer.concat([Buffer.from("pi-remote-auth-v1", "utf8"), Buffer.from("dev-1", "utf8"), relayNonce, clientNonce]);
  const pub = nodeCrypto.createPublicKey({ key: Buffer.from(ctx.keys.sign.pub, "base64"), format: "der", type: "spki" });
  assert.equal(nodeCrypto.verify(null, payload, pub, Buffer.from(sig, "base64")), true);
});

test("连接窗口钥模式：收到 auth_challenge 回 auth_response；无钥窗口不作答", () => {
  const dir = tmpDir();
  const ctx = attach.ensureDeviceKeys(path.join(dir, ".env"), { env: {} });
  const { ctl, frames } = makeCtl({ deviceKeys: ctx.keys });
  ctl.pendingClientNonce = attach.newClientNonce();
  const relayNonce = nodeCrypto.randomBytes(32);
  ctl.handleMessage({ type: "auth_challenge", nonce: relayNonce.toString("base64"), expiresAt: Date.now() + 10000 });
  const resp = frames.find((f) => f.type === "auth_response");
  assert.ok(resp, "钥模式窗口必须应答挑战");
  const payload = Buffer.concat([Buffer.from("pi-remote-auth-v1", "utf8"), Buffer.from("dev-1", "utf8"), relayNonce, Buffer.from(ctl.pendingClientNonce, "base64")]);
  const pub = nodeCrypto.createPublicKey({ key: Buffer.from(ctx.keys.sign.pub, "base64"), format: "der", type: "spki" });
  assert.equal(nodeCrypto.verify(null, payload, pub, Buffer.from(resp.sig, "base64")), true);
  ctl.handleMessage({ type: "auth_result", ok: true, auth: "key", deviceId: "dev-1" });
  assert.equal(ctl.authed, true);
  assert.equal(ctl.authMode, "key");
  ctl.shutdown();

  const plain = makeCtl();
  plain.ctl.handleMessage({ type: "auth_challenge", nonce: relayNonce.toString("base64"), expiresAt: Date.now() + 10000 });
  assert.equal(plain.frames.some((f) => f.type === "auth_response"), false, "无钥窗口不许乱应答");
  plain.ctl.shutdown();
});

// ── Crypto Phase 3: session_archive producer sealing ─────────────────────
// Independent unwrap of the pinned ACK envelope layout -- base64 of
// nonce(12) || ciphertext || tag(16) -- using raw node:crypto only, never a
// producer helper, so a layout drift on either side fails here instead of
// round-tripping silently.
function openAckText(ack, ctB64) {
  const raw = Buffer.from(ctB64, "base64");
  const nonce = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(12, raw.length - 16);
  const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", ack, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

const ARCHIVE_ACK = Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex");
const ARCHIVE_ACK_B64 = ARCHIVE_ACK.toString("base64");
const MARKER_FIRST = "MARKER-FIRST looking for the launch checklist";
const MARKER_BODY = "MARKER-BODY the checklist is sealed and shipped";

function sampleArchive() {
  return {
    id: "sess-sealed-1",
    path: "C:\\sess\\t_sess-sealed-1.jsonl",
    cwd: "D:\\work\\app",
    name: "sealed chat",
    firstMessage: MARKER_FIRST,
    messageCount: 2,
    modified: "2024-01-01T00:00:00.000Z",
    sizeBytes: 1234,
    createdAt: 1700000000000,
    updatedAt: 1700000000001,
    parentSession: "p1",
    truncated: false,
    omitted: 0,
    messages: [
      { id: "m1", role: "user", text: MARKER_FIRST, timestamp: 1700000000001 },
      { id: "m2", role: "assistant", text: MARKER_BODY, timestamp: 1700000000002 },
    ],
  };
}

test("archiveWireBody: no ACK keeps the plaintext wire form byte-identical", () => {
  const archive = sampleArchive();
  const wired = attach.archiveWireBody(archive, null);
  assert.equal(JSON.stringify(wired), JSON.stringify(attach.archiveBody(archive)));
  assert.deepEqual(wired, attach.archiveBody(archive));
});

test("archiveWireBody: with an ACK the blob and firstMessage are sealed, metadata stays readable", () => {
  const archive = sampleArchive();
  const sealed = attach.archiveWireBody(archive, ARCHIVE_ACK);
  assert.equal(sealed.enc, 1);
  assert.equal(typeof sealed.ct, "string");
  assert.deepEqual(sealed.messages, [], "the outside carries an empty messages array; the body lives in the blob");
  const wire = JSON.stringify(sealed);
  assert.ok(!wire.includes("MARKER-FIRST") && !wire.includes("MARKER-BODY"), "no corpus plaintext anywhere in the sealed payload");
  // Tier-b metadata stays in the clear; local-only fields are still stripped.
  assert.equal(sealed.id, "sess-sealed-1");
  assert.equal(sealed.cwd, "D:\\work\\app");
  assert.equal(sealed.name, "sealed chat");
  assert.equal(sealed.messageCount, 2);
  assert.equal(sealed.path, undefined);
  assert.equal(sealed.sizeBytes, undefined);
  // Independent unwrap recovers the exact original message list.
  const parsed = JSON.parse(openAckText(ARCHIVE_ACK, sealed.ct));
  assert.deepEqual(parsed, { messages: attach.archiveBody(archive).messages });
  // firstMessage travels as its own ACK envelope { enc:1, ct }.
  assert.equal(typeof sealed.firstMessage, "object");
  assert.equal(sealed.firstMessage.enc, 1);
  assert.equal(openAckText(ARCHIVE_ACK, sealed.firstMessage.ct), MARKER_FIRST);
  // A wrong key cannot open either envelope.
  const other = Buffer.alloc(32, 9);
  assert.throws(() => openAckText(other, sealed.ct));
  assert.throws(() => openAckText(other, sealed.firstMessage.ct));
  // The local archive object is never mutated by sealing.
  assert.equal(archive.firstMessage, MARKER_FIRST);
  assert.equal(archive.messages.length, 2);
  assert.equal(archive.messages[1].text, MARKER_BODY);
});

function writeMarkerSessionFile(root, id) {
  const dir = path.join(root, "--proj--");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "1700000000000_" + id + ".jsonl");
  const lines = [
    JSON.stringify({ type: "session", id, cwd: path.join(os.tmpdir(), "proj"), timestamp: 1700000000000 }),
    JSON.stringify({ type: "message", id: "m1", timestamp: 1700000000001, message: { role: "user", content: MARKER_FIRST } }),
    JSON.stringify({ type: "message", id: "m2", timestamp: 1700000000002, message: { role: "assistant", content: MARKER_BODY } }),
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

test("session_archive flow: a device holding the ACK publishes sealed archives", async (t) => {
  const root = tmpSessionRoot(t);
  writeMarkerSessionFile(root, "sealed-flow");
  const { ctl, frames } = p9Ctl({ deviceKeys: { contentKeys: { admin: ARCHIVE_ACK_B64 } } });
  ctl.publishLibrary();
  await new Promise((r) => setTimeout(r, 120));
  const frame = frames.find((f) => f.type === "session_archive" && f.session && f.session.id === "sealed-flow");
  assert.ok(frame, "archive frame was published");
  assert.equal(frame.session.enc, 1);
  assert.ok(!JSON.stringify(frame).includes("MARKER-"), "no corpus plaintext in the whole frame");
  const parsed = JSON.parse(openAckText(ARCHIVE_ACK, frame.session.ct));
  assert.deepEqual(parsed.messages.map((m) => m.text), [MARKER_FIRST, MARKER_BODY]);
  assert.equal(frame.session.firstMessage.enc, 1);
  assert.equal(openAckText(ARCHIVE_ACK, frame.session.firstMessage.ct), MARKER_FIRST);
  ctl.shutdown();
});

test("session_archive flow: an ACK persisted to the key file after startup is picked up", async (t) => {
  const root = tmpSessionRoot(t);
  writeMarkerSessionFile(root, "sealed-late");
  const dir = tmpDir();
  const keyFile = path.join(dir, "pi-remote-device.key.json");
  const keys = attach.generateDeviceKeys("dev-1");
  keys.contentKeys = { admin: ARCHIVE_ACK_B64 };
  attach.writeDeviceKeyFile(keyFile, keys);
  // The window started with no keys at all; the ACK only exists in the file
  // (the extension persisted it there after a content_key_grant).
  const { ctl, frames } = p9Ctl({ deviceKeys: null, keyFilePath: keyFile });
  ctl.publishLibrary();
  await new Promise((r) => setTimeout(r, 120));
  const frame = frames.find((f) => f.type === "session_archive" && f.session && f.session.id === "sealed-late");
  assert.ok(frame, "archive frame was published");
  assert.equal(frame.session.enc, 1, "fresh key-file read finds the ACK and seals");
  assert.ok(!JSON.stringify(frame).includes("MARKER-"));
  ctl.shutdown();
});

test("session_archive flow: a legacy token device keeps publishing plaintext archives", async (t) => {
  const root = tmpSessionRoot(t);
  writeMarkerSessionFile(root, "plain-flow");
  const { ctl, frames } = p9Ctl();
  ctl.publishLibrary();
  await new Promise((r) => setTimeout(r, 120));
  const frame = frames.find((f) => f.type === "session_archive" && f.session && f.session.id === "plain-flow");
  assert.ok(frame, "archive frame was published");
  assert.equal(frame.session.enc, undefined);
  assert.equal(frame.session.firstMessage, MARKER_FIRST);
  assert.deepEqual(frame.session.messages.map((m) => m.text), [MARKER_FIRST, MARKER_BODY]);
  ctl.shutdown();
});

// ── Crypto Phase 3 follow-up: session_manifest preview sealing ──────────
// The manifest row's firstMessage is a body slice: with an ACK it leaves as
// an ACK envelope in firstMessageEnc (the extension's field and shape) and
// the plaintext preview is nulled; without an ACK the row is untouched.

test("manifestWireRow: no ACK keeps the manifest row byte-identical", () => {
  const archive = sampleArchive();
  const wired = attach.manifestWireRow(archive, null);
  const plain = require("../deploy/session-library.cjs").manifestRow(archive);
  assert.equal(JSON.stringify(wired), JSON.stringify(plain));
  assert.deepEqual(wired, plain);
  assert.equal(wired.firstMessage, MARKER_FIRST);
  assert.equal(wired.firstMessageEnc, undefined);
});

test("manifestWireRow: with an ACK the preview is sealed into firstMessageEnc and nulled in the clear", () => {
  const archive = sampleArchive();
  const row = attach.manifestWireRow(archive, ARCHIVE_ACK);
  assert.equal(row.firstMessage, null, "the plaintext preview never crosses");
  assert.equal(typeof row.firstMessageEnc, "object");
  assert.equal(row.firstMessageEnc.enc, 1);
  // Independent unwrap recovers the preview exactly.
  assert.equal(openAckText(ARCHIVE_ACK, row.firstMessageEnc.ct), MARKER_FIRST);
  assert.ok(!JSON.stringify(row).includes("MARKER-"), "no preview plaintext anywhere in the row");
  // Tier-b metadata stays in the clear.
  assert.equal(row.id, archive.id);
  assert.equal(row.cwd, archive.cwd);
  assert.equal(row.messageCount, archive.messageCount);
  // A wrong key cannot open the envelope.
  assert.throws(() => openAckText(Buffer.alloc(32, 9), row.firstMessageEnc.ct));
  // A row without a preview stays clean even with an ACK.
  const bare = attach.manifestWireRow({ ...archive, firstMessage: null }, ARCHIVE_ACK);
  assert.equal(bare.firstMessage, null);
  assert.equal(bare.firstMessageEnc, undefined);
});

test("session_manifest flow: a device holding the ACK publishes sealed manifest previews", async (t) => {
  const root = tmpSessionRoot(t);
  writeMarkerSessionFile(root, "sealed-manifest");
  const { ctl, frames } = p9Ctl({ deviceKeys: { contentKeys: { admin: ARCHIVE_ACK_B64 } } });
  ctl.publishLibrary();
  await new Promise((r) => setTimeout(r, 120));
  const frame = frames.find((f) => f.type === "session_manifest");
  assert.ok(frame, "manifest frame was published");
  const row = frame.sessions.find((s) => s.id === "sealed-manifest");
  assert.ok(row, "manifest carries the marker session row");
  assert.equal(row.firstMessage, null);
  assert.equal(row.firstMessageEnc.enc, 1);
  assert.equal(openAckText(ARCHIVE_ACK, row.firstMessageEnc.ct), MARKER_FIRST);
  assert.ok(!JSON.stringify(frame).includes("MARKER-"), "no preview plaintext anywhere in the manifest frame");
  ctl.shutdown();
});

test("session_manifest flow: a legacy token device keeps plaintext manifest previews", async (t) => {
  const root = tmpSessionRoot(t);
  writeMarkerSessionFile(root, "plain-manifest");
  const { ctl, frames } = p9Ctl();
  ctl.publishLibrary();
  await new Promise((r) => setTimeout(r, 120));
  const frame = frames.find((f) => f.type === "session_manifest");
  assert.ok(frame, "manifest frame was published");
  const row = frame.sessions.find((s) => s.id === "plain-manifest");
  assert.ok(row, "manifest carries the marker session row");
  assert.equal(row.firstMessage, MARKER_FIRST);
  assert.equal(row.firstMessageEnc, undefined);
  ctl.shutdown();
});

/* ---- Startup gate: a usable device key file counts as a credential ----
 * Regression (found by real end-to-end testing of a clean keyed install):
 * key-paired devices are issued NO token (PI_REMOTE_DEVICE_TOKEN stays
 * empty), so main()'s old gate (!cfg.token && !cfg.deviceToken) refused
 * them with "please pair first" even though they ARE paired. These tests
 * pin the gate predicate: key file for the same deviceId passes; missing,
 * corrupt, or different-deviceId key files still refuse; token devices are
 * unaffected. */

function keyGateFixture(t, { deviceId = "dev-key-gate", keyDeviceId = deviceId, envExtra = [], keyMode = "valid" } = {}) {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  const lines = [`PI_REMOTE_DEVICE_ID=${deviceId}`, "PI_REMOTE_RELAY=ws://127.0.0.1:7001", ...envExtra];
  fs.writeFileSync(envPath, lines.join("\n") + "\n");
  // deviceKeyFilePath() consults the process env var first; pin it off so
  // the fixture's default location (next to the .env file) is what resolves.
  const prev = process.env.PI_REMOTE_DEVICE_KEY_FILE;
  delete process.env.PI_REMOTE_DEVICE_KEY_FILE;
  t.after(() => {
    if (prev === undefined) delete process.env.PI_REMOTE_DEVICE_KEY_FILE;
    else process.env.PI_REMOTE_DEVICE_KEY_FILE = prev;
  });
  if (keyMode !== "missing") {
    const keyPath = attach.deviceKeyFilePath(envPath);
    if (keyMode === "corrupt") fs.writeFileSync(keyPath, "{not a key file");
    else attach.writeDeviceKeyFile(keyPath, attach.generateDeviceKeys(keyDeviceId));
  }
  return { dir, envPath };
}

// The exact credential half of main()'s startup gate, composed from the
// real loadConfig + hasUsableDeviceKey (deviceId presence is gated earlier
// in main and always set in these fixtures).
function startupGateRefuses(envPath) {
  const cfg = attach.loadConfig(envPath, {});
  return !cfg.relay || (!cfg.token && !cfg.deviceToken && !attach.hasUsableDeviceKey(envPath, cfg.deviceId));
}

test("startup gate: key-paired device with no tokens passes via its key file", (t) => {
  const { envPath } = keyGateFixture(t);
  const cfg = attach.loadConfig(envPath, {});
  assert.equal(cfg.token, "");
  assert.equal(cfg.deviceToken, "");
  assert.equal(attach.hasUsableDeviceKey(envPath, cfg.deviceId), true);
  assert.equal(startupGateRefuses(envPath), false, "keyed install must not be refused as unpaired");
});

test("startup gate: key file issued for a different deviceId does not pass", (t) => {
  const { envPath } = keyGateFixture(t, { keyDeviceId: "dev-someone-else" });
  const cfg = attach.loadConfig(envPath, {});
  assert.equal(attach.hasUsableDeviceKey(envPath, cfg.deviceId), false);
  assert.equal(startupGateRefuses(envPath), true);
});

test("startup gate: no key file and no tokens still refuses", (t) => {
  const { envPath } = keyGateFixture(t, { keyMode: "missing" });
  const cfg = attach.loadConfig(envPath, {});
  assert.equal(attach.hasUsableDeviceKey(envPath, cfg.deviceId), false);
  assert.equal(startupGateRefuses(envPath), true);
});

test("startup gate: corrupt key file does not pass and does not throw", (t) => {
  const { envPath } = keyGateFixture(t, { keyMode: "corrupt" });
  const cfg = attach.loadConfig(envPath, {});
  assert.equal(attach.hasUsableDeviceKey(envPath, cfg.deviceId), false);
  assert.equal(startupGateRefuses(envPath), true);
});

test("startup gate: token device without any key file still passes (unchanged)", (t) => {
  const { envPath } = keyGateFixture(t, { keyMode: "missing", envExtra: ["PI_REMOTE_DEVICE_TOKEN=tok-1"] });
  assert.equal(attach.hasUsableDeviceKey(envPath, "dev-key-gate"), false);
  assert.equal(startupGateRefuses(envPath), false, "device-token installs keep passing exactly as before");
});
