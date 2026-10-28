// attach.cjs 的 tmux 拉起分支（Linux 只用它；macOS 的 PI_REMOTE_LAUNCHER=tmux 也走它，deploy/README.md §9）：
// 找不到 tmux 当场报错、等 tmux 回话、pi 当场退出报 spawn_failed（带退出码与原因）、≥3.2 留失败现场、
// 末尾分号转义、占用按 tmux 会话死活校验。tmux 用假的（同步查询 + 异步子进程都按脚本回话），不需要装 tmux。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const attach = require("../deploy/attach.cjs");

function tmp() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-linux-attach-")));
}

/**
 * 假 tmux：version 为空表示没装；panes(session) 返回该会话的窗格状态（null = 会话不存在）；
 * exitCode 是 new-session 的退出码（null = 一直不回话）；screen 是 capture-pane 的输出。
 */
function fakeTmux({ version = "tmux 3.4", exitCode = 0, panes = () => [{ dead: false }], screen = "" } = {}) {
  const spawned = [];
  const queries = [];
  const spawnSyncImpl = (file, args) => {
    queries.push(args);
    if (args[0] === "-V") return version ? { status: 0, stdout: version + "\n" } : { status: null, error: Object.assign(new Error("spawnSync tmux ENOENT"), { code: "ENOENT" }) };
    const target = String(args[args.indexOf("-t") + 1] || "").replace(/^=/, "").replace(/:$/, "");
    if (args[0] === "list-panes") {
      const list = panes(target);
      if (!list) return { status: 1, stdout: "", stderr: "can't find session" };
      const fmt = args[args.indexOf("-F") + 1];
      const lines = list.map((p) => (fmt.includes("pane_dead_status") ? `${p.dead ? 1 : 0} ${p.status == null ? "" : p.status}` : `${p.dead ? 1 : 0}`));
      return { status: 0, stdout: lines.join("\n") + "\n" };
    }
    if (args[0] === "capture-pane") return { status: 0, stdout: screen + "\n\n" };
    return { status: 0, stdout: "" };
  };
  const spawnImpl = (file, args, opts) => {
    const child = new EventEmitter();
    child.unref = () => {};
    spawned.push({ file, args, opts });
    if (exitCode != null) setImmediate(() => child.emit("exit", exitCode));
    return child;
  };
  return { spawnImpl, spawnSyncImpl, spawned, queries };
}

function makeCtl(tmux, extra = {}) {
  const dir = tmp();
  const app = path.join(dir, "app");
  fs.mkdirSync(app);
  const startPi = path.join(dir, "start-pi.sh");
  fs.writeFileSync(startPi, "exit 0\n");
  const frames = [];
  const logs = [];
  const ctl = new attach.AttachController({
    platform: "linux",
    relay: "ws://127.0.0.1:7001",
    deviceId: "dev-linux",
    projects: [app],
    attachFile: path.join(dir, "remote-attach.json"),
    startPi,
    status: false,
    exit: () => {},
    writeOut: (line) => logs.push(String(line)),
    spawnImpl: tmux.spawnImpl,
    spawnSyncImpl: tmux.spawnSyncImpl,
    tmuxSettleMs: 5,
    // 退出码落盘写到沙箱，不碰真实 ~/.pi
    exitHome: dir,
    ...extra,
  });
  ctl.ws = { readyState: 1, send: (s) => frames.push(JSON.parse(s)), close() {} };
  const harness = async (args) => {
    await ctl.onHarness({ id: "h" + frames.length, command: "harness_start", args });
    return frames[frames.length - 1];
  };
  return { ctl, app, dir, frames, logs, harness };
}

test("buildSpawnSpec（tmux）：末尾的 ; 写成 \\;、≥3.2 同一条命令里接 remain-on-exit failed、回带会话名", () => {
  const spec = attach.buildSpawnSpec({ cwd: "/srv/a b;", sessionPath: "/s/x;", startPi: "/k/start-pi.sh", platform: "linux", keepFailed: true });
  const name = spec.tmuxSession;
  assert.match(name, /^pi-a_b_-[a-z0-9]+$/);
  assert.deepEqual(spec.args, [
    "new-session", "-d", "-s", name, "-c", "/srv/a b\\;", "/bin/bash", "/k/start-pi.sh", "--session", "/s/x\\;",
    ";", "set-option", "-w", "-t", `=${name}:`, "remain-on-exit", "failed",
  ]);
  const old = attach.buildSpawnSpec({ cwd: "/srv/app", startPi: "/k/start-pi.sh", platform: "linux" });
  assert.equal(old.args.includes("remain-on-exit"), false, "缺省不加：3.2 以前没有 failed，加了整条命令报错");
  const mac = attach.buildSpawnSpec({ cwd: "/Users/user/app", startPi: "/k/start-pi.sh", platform: "darwin", scriptDir: os.tmpdir(), keepFailed: true });
  assert.equal(mac.file, "open", "macOS 缺省 Terminal，不受影响");
  assert.equal(mac.tmuxSession, undefined);
});

test("probeTmux：版本号、3.2 门槛、认不出的版本按新版、没装返回 null", () => {
  const run = (stdout, status = 0) => () => ({ status, stdout });
  assert.deepEqual(attach.probeTmux(run("tmux 3.4\n")), { version: "tmux 3.4", keepFailed: true });
  assert.equal(attach.probeTmux(run("tmux 3.2a")).keepFailed, true);
  assert.equal(attach.probeTmux(run("tmux 3.1c")).keepFailed, false);
  assert.equal(attach.probeTmux(run("tmux 2.9")).keepFailed, false);
  assert.equal(attach.probeTmux(run("tmux next-3.6")).keepFailed, true);
  assert.equal(attach.probeTmux(run("tmux master")).keepFailed, true);
  assert.equal(attach.probeTmux(run("", 1)), null);
  assert.equal(attach.probeTmux(() => ({ error: Object.assign(new Error("x"), { code: "ENOENT" }) })), null);
  assert.equal(attach.probeTmux(() => { throw new Error("boom"); }), null);
});

test("找不到 tmux：harness_start 直接回 spawn_failed（不再先回 started），不占用目录；装上 tmux 后不用重开窗口", async () => {
  const tmux = fakeTmux({ version: "" });
  const { ctl, app, harness } = makeCtl(tmux);
  const r = await harness({ cwd: app });
  assert.deepEqual([r.ok, r.code], [false, "spawn_failed"]);
  assert.match(r.error, /找不到 tmux.*apt install -y tmux/);
  assert.equal(tmux.spawned.length, 0);
  assert.equal(ctl.spawnedByCwd.size, 0, "没占用：装好 tmux 立刻能重试");

  const fixed = fakeTmux();
  ctl.spawnSyncImpl = fixed.spawnSyncImpl;
  ctl.spawnImpl = fixed.spawnImpl;
  const again = await harness({ cwd: app });
  assert.deepEqual([again.ok, again.status], [true, "started"]);
});

test("tmux 开会话失败（退出码非 0）：回 spawn_failed，占用清掉", async () => {
  const tmux = fakeTmux({ exitCode: 1 });
  const { ctl, app, harness, logs } = makeCtl(tmux);
  const r = await harness({ cwd: app });
  assert.deepEqual([r.ok, r.code], [false, "spawn_failed"]);
  assert.match(r.error, /tmux 退出码 1/);
  assert.equal(ctl.spawnedByCwd.size, 0);
  assert.ok(logs.some((l) => /启动失败：tmux 退出码 1/.test(l)), "窗口里也记一行");
});

test("pi 当场退出（找不到 pi = 127）：回 spawn_failed，带退出码、窗格最后一行和 tmux attach 提示；≥3.2 拉起时加了留现场", async () => {
  const tmux = fakeTmux({ panes: () => [{ dead: true, status: 127 }], screen: "[pi-remote] relay=ws://127.0.0.1:7001\n[error] pi not found: install it (npm i -g) or set PI_REMOTE_PI_BIN in .env" });
  const { ctl, app, harness } = makeCtl(tmux);
  const r = await harness({ cwd: app });
  assert.deepEqual([r.ok, r.code], [false, "spawn_failed"]);
  const name = tmux.spawned[0].args[3];
  assert.match(r.error, /^本机启动失败：pi 退出了（退出码 127）：\[error\] pi not found/);
  assert.match(r.error, new RegExp(`tmux attach -t ${name} 看现场`));
  assert.deepEqual(tmux.spawned[0].args.slice(-7), [";", "set-option", "-w", "-t", `=${name}:`, "remain-on-exit", "failed"]);
  assert.equal(ctl.spawnedByCwd.size, 0, "失败了就不占着目录");
  for (const q of tmux.queries) if (q.includes("-t")) assert.match(q[q.indexOf("-t") + 1], /^=/, "查询一律精确匹配：" + q.join(" "));
});

test("tmux < 3.2：不加 remain-on-exit；会话当场没了就报'刚起来就退出了'，提示手动跑 start-pi.sh", async () => {
  const tmux = fakeTmux({ version: "tmux 3.0a", panes: () => null });
  const { app, harness } = makeCtl(tmux);
  const r = await harness({ cwd: app });
  assert.equal(tmux.spawned[0].args.includes("remain-on-exit"), false);
  assert.deepEqual([r.ok, r.code], [false, "spawn_failed"]);
  assert.match(r.error, /pi 刚起来就退出了.*低于 3\.2.*start-pi\.sh/);
});

test("pi 正常跑着：回 started；同目录再点是已在运行；pi 退了（tmux 会话没了）立刻能重试，不用等 10 分钟", async () => {
  const gone = new Set();
  const tmux = fakeTmux({ panes: (s) => (gone.has(s) ? null : [{ dead: false }]) });
  const { ctl, app, harness } = makeCtl(tmux);
  const first = await harness({ cwd: app });
  assert.deepEqual([first.ok, first.status], [true, "started"]);
  const name = tmux.spawned[0].args[3];
  assert.equal([...ctl.spawnedByCwd.values()][0].tmuxSession, name, "占用记着会话名");
  const second = await harness({ cwd: app });
  assert.deepEqual([second.ok, second.status], [true, "already_running"]);
  assert.equal(tmux.spawned.length, 1);

  gone.add(name);
  const third = await harness({ cwd: app });
  assert.deepEqual([third.ok, third.status], [true, "started"], "pi 已经不在了：放行重拉");
  assert.equal(tmux.spawned.length, 2);
});

test("会话形态（sessionId）的占用同样按 tmux 死活校验；失败留下的死窗格也算不在", async () => {
  const dead = new Set();
  const tmux = fakeTmux({ panes: (s) => [dead.has(s) ? { dead: true, status: 1 } : { dead: false }] });
  const sessionPath = "/home/u/.pi/agent/sessions/x/t_s1.jsonl";
  const box = makeCtl(tmux);
  box.ctl.sessionLookup = async (id) => (id === "s1" ? { id: "s1", path: sessionPath, cwd: box.app, deleted: false } : null);
  const a = await box.harness({ sessionId: "s1" });
  assert.deepEqual([a.ok, a.status], [true, "started"]);
  const argv = tmux.spawned[0].args;
  const piAt = argv.indexOf(box.ctl.startPi);
  assert.deepEqual(argv.slice(piAt, piAt + 3), [box.ctl.startPi, "--session", sessionPath], "会话文件路径原样传给 start-pi.sh");
  assert.equal(argv[piAt - 3], "/usr/bin/env", "拉起时注入退出码落盘文件");
  assert.match(argv[piAt - 2], /^PI_REMOTE_EXIT_FILE=\/.*\.code$/);
  const b = await box.harness({ sessionId: "s1" });
  assert.equal(b.status, "already_running");
  dead.add(tmux.spawned[0].args[3]);
  const c = await box.harness({ sessionId: "s1" });
  assert.equal(c.status, "started", "窗格已退出（留着的现场）：不再挡着");
  assert.equal(tmux.spawned.length, 2);
});

test("tmux 一直不回话：等到上限按已拉起处理，不拖过 relay 的超时；查询 tmux 出错时按 pi 还在处理", async () => {
  const tmux = fakeTmux({ exitCode: null });
  const { ctl, app, harness } = makeCtl(tmux, { tmuxExitWaitMs: 30 });
  const t0 = Date.now();
  const r = await harness({ cwd: app });
  assert.deepEqual([r.ok, r.status], [true, "started"]);
  assert.ok(Date.now() - t0 < 1000);
  ctl.spawnSyncImpl = () => ({ error: new Error("EAGAIN") });
  const again = await harness({ cwd: app });
  assert.equal(again.status, "already_running", "查不了就别放行，免得双开");
});

test("等 tmux 期间又来一个拉起：回 harness_busy（协议码，网页按码提示重试），不排队", async () => {
  const tmux = fakeTmux({ exitCode: null });
  const { app, frames, ctl } = makeCtl(tmux, { tmuxExitWaitMs: 200 });
  const other = path.join(path.dirname(app), "other");
  fs.mkdirSync(other);
  ctl.projects.push(other);
  const first = ctl.onHarness({ id: "a", args: { cwd: app } });
  await new Promise((r) => setImmediate(r));
  await ctl.onHarness({ id: "b", args: { cwd: other } });
  const busy = frames.find((f) => f.id === "b");
  assert.deepEqual([busy.ok, busy.code, busy.error], [false, "harness_busy", "正在启动另一个会话，请稍候"]);
  await first;
  assert.equal(frames.find((f) => f.id === "a").status, "started");
  assert.equal(tmux.spawned.length, 1);
});

test("Windows 新控制台：也 arm 上线等待（房间上线回 started）；超时和启动命令非 0 都回 spawn_failed 并释放占用", async () => {
  function winCtl(dir, opts = {}) {
    const spawned = [];
    const frames = [];
    const ctl = new attach.AttachController({
      platform: "win32",
      relay: "ws://127.0.0.1:7001",
      deviceId: "dev-win",
      projects: ["D:\\work\\app"],
      attachFile: path.join(dir, "s.json"),
      startPi: __filename,
      existsDir: () => true,
      status: false,
      exit: () => {},
      writeOut: () => {},
      exitHome: dir,
      spawnImpl: (file, args) => {
        const child = new EventEmitter();
        child.unref = () => {};
        spawned.push({ file, args, child });
        return child;
      },
      spawnSyncImpl: () => {
        throw new Error("Windows 上不该查 tmux");
      },
      ...opts,
    });
    ctl.ws = { readyState: 1, send: (s) => frames.push(JSON.parse(s)), close() {} };
    return { ctl, spawned, frames };
  }

  // 房间在等待窗口内上线：started + roomId
  {
    const dir = tmp();
    const { ctl, spawned, frames } = winCtl(dir, { launchWaitMs: 80 });
    const pending = ctl.onHarness({ id: "w1", args: { cwd: "D:\\work\\app" } });
    await new Promise((r) => setTimeout(r, 10));
    ctl.observeRooms([{ id: "r1", cwd: "D:\\work\\app", online: true, deviceId: "dev-win" }]);
    await pending;
    assert.deepEqual([frames[0].ok, frames[0].status, frames[0].roomId], [true, "started", "r1"]);
    assert.equal(spawned[0].file, "cmd.exe");
  }

  // 超时：按失败回馈（不再静默 started），占用立即释放，可以重试
  {
    const dir = tmp();
    const { ctl, frames } = winCtl(dir, { launchWaitMs: 20 });
    await ctl.onHarness({ id: "w2", args: { cwd: "D:\\work\\app" } });
    assert.deepEqual([frames[0].ok, frames[0].code], [false, "spawn_failed"]);
    assert.match(frames[0].error, /没看到会话上线/);
    assert.equal(ctl.spawnedByCwd.size, 0, "超时失败不能继续占着目录");
  }

  // cmd.exe / start 非 0 退出：旧代码显式跳过 win32，现在要释放占用并回失败原因
  {
    const dir = tmp();
    const { ctl, frames, spawned } = winCtl(dir, { launchWaitMs: 1000 });
    const pending = ctl.onHarness({ id: "w3", args: { cwd: "D:\\work\\app" } });
    await new Promise((r) => setTimeout(r, 10));
    spawned[0].child.emit("exit", 9009);
    await pending;
    assert.deepEqual([frames[0].ok, frames[0].code], [false, "spawn_failed"]);
    assert.match(frames[0].error, /cmd\.exe 退出码 9009/);
    assert.equal(ctl.spawnedByCwd.size, 0);
  }
});

test("tmux 丢 pane_dead_status：窗格有值以窗格为准，空值时读落盘退出码", async () => {
  // 窗格字段有值：即使落盘写的是另一个码，也以窗格为准
  {
    const exitDir = tmp();
    const tmux = fakeTmux({
      panes: (s) => {
        attach.writeExitCodePath(attach.exitCodePath(s, exitDir), 99);
        return [{ dead: true, status: 127 }];
      },
    });
    const box = makeCtl(tmux, { exitHome: exitDir });
    const r = await box.harness({ cwd: box.app });
    assert.match(r.error, /退出码 127/);
  }
  // 窗格字段丢了（tmux 3.4 的现场）：读 start-pi.sh 落盘的退出码
  {
    const exitDir = tmp();
    const tmux = fakeTmux({
      panes: (s) => {
        attach.writeExitCodePath(attach.exitCodePath(s, exitDir), 143);
        return [{ dead: true, status: null }];
      },
    });
    const box = makeCtl(tmux, { exitHome: exitDir });
    const r = await box.harness({ cwd: box.app });
    assert.match(r.error, /退出码 143/);
  }
  // 会话已经整个收掉（pi 退得比 remain-on-exit 还快）：也只能读落盘
  {
    const exitDir = tmp();
    const tmux = fakeTmux({
      panes: (s) => {
        attach.writeExitCodePath(attach.exitCodePath(s, exitDir), 143);
        return null;
      },
    });
    const box = makeCtl(tmux, { exitHome: exitDir });
    const r = await box.harness({ cwd: box.app });
    assert.equal(r.code, "spawn_failed");
    assert.match(r.error, /退出码 143/);
  }
});
