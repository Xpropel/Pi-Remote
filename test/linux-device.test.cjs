// Linux 设备（服务器式，deploy/README.md）：deploy/linux/device.cjs 的命令行为——.env 生成、root 拦截、tmux 参数形状、
// 窗口起停与失败现场、pi 会话列表；配对与体检走进程内真 relay；push.sh 的参数拦截，以及用假 ssh/scp/npm
// 在本机把「服务器端脚本」完整跑一遍。tmux 用假的（记账 + 按脚本回话），真 tmux 的用例在 linux-tmux.test.cjs。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const device = require("../deploy/linux/device.cjs");
const attach = require("../deploy/attach.cjs");

const REPO = path.join(__dirname, "..");
const ADMIN_TOKEN = "test-admin-token-linux-6c2e";
const LINUX_DIR = path.join(REPO, "deploy", "linux");
const KIT_FILES = ["deploy/attach.cjs", "deploy/session-library.cjs", "deploy/start-pi.sh", "deploy/linux/device.cjs", "deploy/linux/device.sh", "extension/pi-remote-sync.ts", "protocol/v4.json", ".env.example"];

function tmp(prefix) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** 沙箱：套件（只拷用得到的文件）+ 家目录 + 两个项目目录。.env 写在沙箱里，不碰仓库的 */
function sandbox(t) {
  const root = tmp("pi-linux-dev-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const kit = path.join(root, "kit");
  for (const rel of KIT_FILES) {
    fs.mkdirSync(path.dirname(path.join(kit, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(kit, rel));
  }
  const home = path.join(root, "home");
  const work = path.join(root, "work");
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  fs.mkdirSync(path.join(work, "app"), { recursive: true });
  fs.mkdirSync(path.join(work, "we ird $x"), { recursive: true });
  // 末尾是分号的目录：tmux 会把末尾的 ; 当命令分隔符
  fs.mkdirSync(path.join(work, "a b;"), { recursive: true });
  return { root, kit, home, work, envPath: path.join(kit, ".env") };
}

function fakePi(file, version = "1.0.2") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n[ "$1" = --version ] && echo ${version}\n`, { mode: 0o755 });
  return file;
}

/** 假 tmux：记下每次调用；会话表按 new-session / kill-session 增减；list-panes、capture-pane 按会话表回话。
 *  collapsed = true 模拟 tmux 3.4 在 LANG=C 下把制表符净化成下划线；extraLines 模拟幻影行。 */
function fakeTmux({ version = "tmux 3.4", onNew, collapsed = false, extraLines = [] } = {}) {
  const calls = [];
  const envs = [];
  const sessions = new Map();
  const target = (args) => {
    const t = args[args.indexOf("-t") + 1] || "";
    return t.replace(/^=/, "").replace(/:$/, "");
  };
  const run = (args) => {
    calls.push(args.slice());
    const cmd = args[0];
    if (cmd === "-V") {
      if (!version) return { status: null, error: Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" }) };
      return { status: 0, stdout: version + "\n" };
    }
    if (cmd === "has-session") return { status: sessions.has(target(args)) ? 0 : 1 };
    if (cmd === "new-session") {
      const name = args[args.indexOf("-s") + 1];
      if (sessions.has(name)) return { status: 1, stderr: "duplicate session: " + name };
      const sess = { name, cwd: args[args.indexOf("-c") + 1], dead: false, status: null, screen: [], created: Math.floor(Date.now() / 1000) };
      sessions.set(name, sess);
      if (onNew) onNew(sess, args);
      return { status: 0 };
    }
    if (cmd === "kill-session") {
      sessions.delete(target(args));
      return { status: 0 };
    }
    if (cmd === "list-sessions") {
      return { status: 0, stdout: [...sessions.keys()].join("\n") + "\n" };
    }
    if (cmd === "list-panes" && args.includes("-a")) {
      if (!sessions.size) return { status: 1, stderr: "no server running" };
      const sep = collapsed ? "_" : "\t";
      const lines = [...sessions.values()].map((s) => [s.name, s.dead ? "1" : "0", s.status == null ? "" : String(s.status), s.cwd, String(s.created)].join(sep));
      if (collapsed) lines.push(...extraLines);
      return { status: 0, stdout: lines.join("\n") + "\n" };
    }
    if (cmd === "list-panes") {
      const s = sessions.get(target(args));
      if (!s) return { status: 1, stderr: "can't find session" };
      const sep = collapsed ? "_" : "\t";
      return { status: 0, stdout: `${s.dead ? 1 : 0}${sep}${s.status == null ? "" : s.status}\n` };
    }
    if (cmd === "capture-pane") {
      const s = sessions.get(target(args));
      if (!s) return { status: 1 };
      return { status: 0, stdout: s.screen.join("\n") + "\n\n\n" };
    }
    return { status: 0 };
  };
  const wrapped = (args, opts) => {
    envs.push(opts && opts.env);
    return run(args);
  };
  return { run: wrapped, calls, envs, sessions };
}

function ctxFor(box, extra = {}) {
  const out = [];
  const err = [];
  const ctx = device.makeContext({
    kit: box.kit,
    home: box.home,
    cwd: box.work,
    platform: "linux",
    uid: 1000,
    user: "piagent",
    env: { PATH: "/usr/bin:/bin", HOME: box.home, LANG: "C.UTF-8", ...(extra.env || {}) },
    tmux: extra.tmux ? extra.tmux.run : fakeTmux().run,
    out: (line) => out.push(String(line)),
    err: (line) => err.push(String(line)),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    upWaitMs: 400,
    downWaitMs: 300,
    // 只在沙箱里找 pi：开发机 /usr/local/bin 里装没装 pi 不影响结果
    piFallbacks: [path.join(box.home, ".local", "bin", "pi"), path.join(box.home, ".npm-global", "bin", "pi")],
    ...extra.opts,
  });
  return { ctx, out, err, text: () => out.join("\n"), errText: () => err.join("\n") };
}

function pairedEnv(box, extra = "") {
  fs.writeFileSync(
    box.envPath,
    ["PI_REMOTE_RELAY=ws://127.0.0.1:7001", "PI_REMOTE_DEVICE_ID=dev-linux-1", "PI_REMOTE_DEVICE_TOKEN=tok-abc", `PI_REMOTE_PROJECTS=${path.join(box.work, "app")}`, extra, ""].join("\n"),
    { mode: 0o600 },
  );
}

/** 假 attach：tmux 开窗口时按 attach 的样子写状态文件（认证通过后才写） */
function writesState(box, deviceId = "dev-linux-1") {
  return () => {
    const file = path.join(box.home, ".pi", "agent", "remote-attach.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, deviceId, accountId: "admin", relay: "ws://127.0.0.1:7001", startedAt: Date.now(), expiresAt: Date.now() + 2 * 3600e3 }));
  };
}

test("init：新建 .env（600）沿用模板，relay 走回环、清掉占位 token 和示例标签、拉起方式 tmux、pi 写成绝对路径；再跑只补缺的", async (t) => {
  const box = sandbox(t);
  const pi = fakePi(path.join(box.home, ".local", "bin", "pi"));
  const app = path.join(box.work, "app");
  const other = path.join(box.work, "we ird $x");
  const { ctx, text } = ctxFor(box);
  assert.equal(await device.main(["init", "--projects", `${app}/; ${other}`, "--name", "阿里云"], ctx), 0);
  assert.equal(fs.statSync(box.envPath).mode & 0o777, 0o600);
  const raw = fs.readFileSync(box.envPath, "utf8");
  assert.match(raw, /^# pi-remote 本机配置模板/, "保留模板里的注释，用户打开 .env 看得懂每一项");
  const env = attach.parseEnv(raw);
  assert.equal(env.PI_REMOTE_RELAY, device.LOOPBACK_RELAY);
  assert.equal(env.PI_REMOTE_TOKEN, "", "模板里的 change-me 不能留着去登录");
  assert.equal(env.PI_REMOTE_LABEL, "", "「我的电脑」不是服务器的名字");
  assert.equal(env.PI_REMOTE_DEVICE_NAME, "阿里云");
  assert.equal(env.PI_REMOTE_PROJECTS, `${app};${other}`, "末尾斜杠、分号两侧空格去掉；$ 和空格原样");
  assert.equal(env.PI_REMOTE_LAUNCHER, "tmux");
  assert.equal(env.PI_REMOTE_PI_BIN, pi, "pi 不在 PATH 里也找得到，并写死成绝对路径");
  assert.equal(env.PI_REMOTE_ACCOUNT, "admin");
  assert.match(text(), /未配对/);
  assert.match(text(), /device\.sh pair XXXX-XXXX/);

  attach.writeEnvVars(box.envPath, { PI_REMOTE_RELAY: "ws://10.0.0.5:7001", PI_REMOTE_DEVICE_NAME: "别动" });
  fs.chmodSync(box.envPath, 0o644);
  const again = ctxFor(box);
  assert.equal(await device.main(["init"], again.ctx), 0);
  const env2 = attach.parseEnv(fs.readFileSync(box.envPath, "utf8"));
  assert.equal(env2.PI_REMOTE_RELAY, "ws://10.0.0.5:7001", "已有的值不改");
  assert.equal(env2.PI_REMOTE_DEVICE_NAME, "别动");
  assert.equal(env2.PI_REMOTE_PROJECTS, `${app};${other}`);
  assert.equal(fs.statSync(box.envPath).mode & 0o777, 0o600, "权限收紧回 600");
  assert.match(again.text(), /已补全/);
});

test("init：参数校验——relay 要 ws(s)://，白名单要绝对路径且目录存在，名字不能换行；出错不生成 .env", async (t) => {
  const box = sandbox(t);
  for (const args of [
    ["init", "--relay", "http://x:7001"],
    ["init", "--projects", "relative/dir"],
    ["init", "--projects", path.join(box.work, "nope")],
    ["init", "--projects", path.join(box.work, "a b;")],
    ["init", "--projects", ";"],
    ["init", "--name", "a\nb"],
    ["init", "--bogus", "1"],
    ["init", "extra"],
  ]) {
    const { ctx, errText } = ctxFor(box);
    assert.equal(await device.main(args, ctx), 2, args.join(" "));
    assert.ok(errText(), args.join(" "));
    assert.equal(fs.existsSync(box.envPath), false, args.join(" "));
  }
});

test("root：init / pair / up / start 一律拒绝并说明原因；PI_REMOTE_ALLOW_ROOT=1 才放行；doctor 记一项 fail", async (t) => {
  const box = sandbox(t);
  const tmux = fakeTmux();
  for (const args of [["init"], ["pair", "ABCD-EFGH"], ["up"], ["start", box.work]]) {
    const { ctx, errText } = ctxFor(box, { tmux, opts: { uid: 0 } });
    assert.equal(await device.main(args, ctx), 2, args[0]);
    assert.match(errText(), /不要用 root/, args[0]);
    assert.match(errText(), /adduser/);
  }
  assert.equal(fs.existsSync(box.envPath), false);
  assert.equal(tmux.calls.some((c) => c[0] === "new-session"), false);

  const allowed = ctxFor(box, { tmux, opts: { uid: 0 }, env: { PI_REMOTE_ALLOW_ROOT: "1" } });
  assert.equal(await device.main(["init"], allowed.ctx), 0);

  const doc = ctxFor(box, { tmux, opts: { uid: 0 } });
  await device.main(["doctor"], doc.ctx);
  assert.match(doc.text(), /^\[fail\] 以 root 运行/m);
});

test("up：没配对先拦；tmux 命令拆成参数、-t 精确匹配、≥3.2 加 remain-on-exit failed；相对目录按调用方解开；窗口已开不重开", async (t) => {
  const box = sandbox(t);
  const none = ctxFor(box);
  assert.equal(await device.main(["up"], none.ctx), 1);
  assert.match(none.errText(), /还没配对/);

  pairedEnv(box);
  const tmux = fakeTmux({ onNew: writesState(box) });
  const { ctx, text } = ctxFor(box, { tmux });
  assert.equal(await device.main(["up", "--max-hours", "36", "app", path.join(box.work, "a b;")], ctx), 0);
  const created = tmux.calls.find((c) => c[0] === "new-session");
  const attachExit = attach.exitCodePath(device.ATTACH_SESSION, box.home);
  assert.deepEqual(created, [
    "new-session", "-d", "-s", device.ATTACH_SESSION, "-c", box.kit,
    "/usr/bin/env", `PI_REMOTE_EXIT_FILE=${attachExit}`,
    process.execPath, path.join(box.kit, "deploy", "attach.cjs"), "--max-hours", "36",
    path.join(box.work, "app"), path.join(box.work, "a b\\;"),
    ";", "set-option", "-w", "-t", `=${device.ATTACH_SESSION}:`, "remain-on-exit", "failed",
  ]);
  for (const c of tmux.calls) if (c.includes("-t")) assert.match(c[c.indexOf("-t") + 1], /^=/, "目标一律 = 精确匹配：" + c.join(" "));
  assert.match(text(), /连接窗口已打开/);
  assert.match(text(), /tmux attach -t pi-remote-attach/);
  assert.match(text(), /在 tmux 里拉起/);

  const before = tmux.calls.length;
  const again = ctxFor(box, { tmux });
  assert.equal(await device.main(["up"], again.ctx), 0);
  assert.equal(tmux.calls.slice(before).some((c) => c[0] === "new-session"), false, "窗口已经开着就不再开第二个");
  assert.match(again.text(), /连接窗口开着（tmux 会话 pi-remote-attach）/);

  fs.rmSync(path.join(box.home, ".pi", "agent", "remote-attach.json"));
  const old = fakeTmux({ version: "tmux 3.0a", onNew: writesState(box) });
  assert.equal(await device.main(["up"], ctxFor(box, { tmux: old }).ctx), 0);
  assert.equal(old.calls.find((c) => c[0] === "new-session").includes("remain-on-exit"), false, "3.2 以前没有 failed 这个值，不能加");

  const missing = ctxFor(box, { tmux: fakeTmux({ version: "" }) });
  assert.equal(await device.main(["up"], missing.ctx), 1);
  assert.match(missing.errText(), /apt install -y tmux/);

  const badDir = ctxFor(box, { tmux: fakeTmux() });
  assert.equal(await device.main(["up", "no-such-dir"], badDir.ctx), 2);
  assert.equal(await device.main(["up", "--max-hours", "0"], ctxFor(box).ctx), 2);
});

test("up：窗口当场退出（例如令牌被撤销）时把窗格里的原因抓出来、收掉会话、退出码 1；残留的失败现场下次 up 先收掉再开", async (t) => {
  const box = sandbox(t);
  pairedEnv(box);
  const tmux = fakeTmux({
    onNew: (s) => {
      s.dead = true;
      s.status = 1;
      s.screen = ["正在连接…", "relay 鉴权失败：这台设备已被撤销，请重新配对。在网页上生成配对码后运行：deploy/attach.sh --pair <配对码>"];
    },
  });
  const { ctx, errText } = ctxFor(box, { tmux });
  assert.equal(await device.main(["up"], ctx), 1);
  assert.match(errText(), /退出码 1/);
  assert.match(errText(), /已被撤销/);
  assert.equal(tmux.sessions.has(device.ATTACH_SESSION), false, "失败现场抓完就收掉");

  const left = fakeTmux({ onNew: writesState(box) });
  left.sessions.set(device.ATTACH_SESSION, { name: device.ATTACH_SESSION, cwd: box.kit, dead: true, status: 1, screen: [], created: 1 });
  const retry = ctxFor(box, { tmux: left });
  assert.equal(await device.main(["up"], retry.ctx), 0);
  assert.ok(left.calls.some((c) => c[0] === "kill-session"), "上次留下的死窗口先收掉");
  assert.ok(left.calls.some((c) => c[0] === "new-session"));

  const state = path.join(box.home, ".pi", "agent", "remote-attach.json");
  const foreign = ctxFor(box, { tmux: fakeTmux() });
  assert.equal(await device.main(["up"], foreign.ctx), 1, "前台终端里已经开着一个窗口：不悄悄把它顶下线");
  assert.match(foreign.errText(), /不在 tmux 里，pid \d+.*先关掉它再 up/);

  fs.rmSync(state);
  const silent = fakeTmux({ onNew: (s) => s });
  const slow = ctxFor(box, { tmux: silent });
  assert.equal(await device.main(["up"], slow.ctx), 1, "等不到状态文件：窗口还在重连，如实报出来");
  assert.match(slow.errText(), /没连上 relay/);
  assert.equal(silent.sessions.has(device.ATTACH_SESSION), true, "还活着的窗口不收，它会自己重连");
});

test("up：tmux 丢了窗格退出码时，读 attach.cjs 落盘的退出码再报原因", async (t) => {
  const box = sandbox(t);
  pairedEnv(box);
  const attachExit = attach.exitCodePath(device.ATTACH_SESSION, box.home);
  const tmux = fakeTmux({
    onNew: (s) => {
      s.dead = true;
      s.status = null; // tmux 3.4 丢 #{pane_dead_status} 的现场
      s.screen = ["attach 启动失败"];
      attach.writeExitCodePath(attachExit, 143);
    },
  });
  const { ctx, errText } = ctxFor(box, { tmux });
  assert.equal(await device.main(["up"], ctx), 1);
  assert.match(errText(), /退出码 143/);
  assert.equal(fs.existsSync(attachExit), false, "失败现场读完后清掉落盘码");
});

test("up：窗口会话整个收掉时也读落盘退出码，不只剩一个问号", async (t) => {
  const box = sandbox(t);
  pairedEnv(box);
  const attachExit = attach.exitCodePath(device.ATTACH_SESSION, box.home);
  let tmux;
  tmux = fakeTmux({
    onNew: (s) => {
      // 模拟 pi/attach 退得比 remain-on-exit 还快：会话直接没了
      attach.writeExitCodePath(attachExit, 143);
      tmux.sessions.delete(s.name);
    },
  });
  const { ctx, errText } = ctxFor(box, { tmux });
  assert.equal(await device.main(["up"], ctx), 1);
  assert.match(errText(), /连接窗口刚开就退出了（退出码 143）/);
  assert.equal(fs.existsSync(attachExit), false, "读完后清掉落盘码");
});

test("down：kill-session 精确匹配；没开时清掉残留状态文件；窗口不是 device.sh 开的就不动它", async (t) => {
  const box = sandbox(t);
  pairedEnv(box);
  const state = path.join(box.home, ".pi", "agent", "remote-attach.json");
  const tmux = fakeTmux({ onNew: writesState(box) });
  assert.equal(await device.main(["up"], ctxFor(box, { tmux }).ctx), 0);
  // 真 attach 收到 SIGHUP 会自己删状态文件；假的这里替它删
  const killing = fakeTmux();
  killing.sessions.set(device.ATTACH_SESSION, tmux.sessions.get(device.ATTACH_SESSION));
  const run = killing.run;
  killing.run = (args) => {
    if (args[0] === "kill-session") fs.rmSync(state, { force: true });
    return run(args);
  };
  const down = ctxFor(box, { tmux: killing });
  assert.equal(await device.main(["down"], down.ctx), 0);
  assert.deepEqual(killing.calls.find((c) => c[0] === "kill-session"), ["kill-session", "-t", "=" + device.ATTACH_SESSION]);
  assert.match(down.text(), /已关闭/);

  fs.writeFileSync(state, JSON.stringify({ pid: 999999, deviceId: "dev-linux-1", expiresAt: Date.now() + 1e6 }));
  const stale = ctxFor(box, { tmux: fakeTmux() });
  assert.equal(await device.main(["down"], stale.ctx), 0);
  assert.equal(fs.existsSync(state), false, "进程早没了的状态文件顺手清掉");

  fs.writeFileSync(state, JSON.stringify({ pid: process.pid, deviceId: "dev-linux-1", expiresAt: Date.now() + 1e6 }));
  const foreign = ctxFor(box, { tmux: fakeTmux() });
  assert.equal(await device.main(["down"], foreign.ctx), 1);
  assert.match(foreign.errText(), new RegExp(`pid ${process.pid}`));
  assert.equal(fs.existsSync(state), true, "别人开的窗口不替它关");
});

test("sessions / clean：只列 pi- 会话（不含连接窗口），已退出的标退出码；clean 只收已退出的", async (t) => {
  const box = sandbox(t);
  const tmux = fakeTmux();
  const add = (name, dead, status, cwd) => tmux.sessions.set(name, { name, cwd, dead, status, screen: [], created: tmux.sessions.size + 1 });
  add(device.ATTACH_SESSION, false, null, box.kit);
  add("pi-app-k1", false, null, path.join(box.work, "app"));
  add("pi-bad-k2", true, 127, path.join(box.work, "a b;"));
  add("work", false, null, box.home);
  const ls = ctxFor(box, { tmux });
  assert.equal(await device.main(["sessions"], ls.ctx), 0);
  assert.match(ls.text(), /pi-app-k1 .*运行中/);
  assert.match(ls.text(), /pi-bad-k2 .*已退出（退出码 127）/);
  assert.doesNotMatch(ls.text(), /pi-remote-attach|\bwork\b +~/);
  assert.match(ls.text(), /clean/);

  const badExit = attach.exitCodePath("pi-bad-k2", box.home);
  attach.writeExitCodePath(badExit, 127);
  const clean = ctxFor(box, { tmux });
  assert.equal(await device.main(["clean"], clean.ctx), 0);
  assert.deepEqual([...tmux.sessions.keys()].sort(), ["pi-app-k1", device.ATTACH_SESSION, "work"]);
  assert.match(clean.text(), /pi-bad-k2/);
  assert.equal(fs.existsSync(badExit), false, "clean 顺手收掉落盘退出码");

  const empty = ctxFor(box, { tmux: fakeTmux() });
  assert.equal(await device.main(["sessions"], empty.ctx), 0);
  assert.match(empty.text(), /没有 pi 的 tmux 会话/);
});

test("sessions 显示：cwd 里的 $ 还原成真实路径（纯显示，不带转义反斜杠）", async (t) => {
  assert.equal(device.displayPathOf("/home/piagent/we ird \\$x"), "/home/piagent/we ird $x", "还原 \\$");
  assert.equal(device.displayPathOf("/home/piagent/plain $x"), "/home/piagent/plain $x", "没有转义的路径原样");
  assert.equal(device.displayPathOf("C:\\work\\$x"), "C:\\work$x", "只还原紧挨着的 \\$，不动 Windows 分隔符");
  const box = sandbox(t);
  const tmux = fakeTmux();
  // 两个目录：一个真实 $，一个被外层转义成 \$；列表里都应显示成真实 $（命令执行仍用各自的 cwd）
  const raw = path.join(box.work, "we ird $x");
  const escaped = path.join(box.work, "we ird \\$x");
  tmux.sessions.set("pi-raw-k3", { name: "pi-raw-k3", cwd: raw, dead: false, status: null, screen: [], created: 1 });
  tmux.sessions.set("pi-esc-k4", { name: "pi-esc-k4", cwd: escaped, dead: false, status: null, screen: [], created: 2 });
  const ls = ctxFor(box, { tmux });
  assert.equal(await device.main(["sessions"], ls.ctx), 0);
  assert.match(ls.text(), /pi-raw-k3 .*we ird \$x .*运行中/);
  assert.match(ls.text(), /pi-esc-k4 .*we ird \$x .*运行中/);
  assert.doesNotMatch(ls.text(), /\\\$x/, "显示里不能留转义反斜杠");
});

test("tmux 3.4 + LANG=C：注入 UTF-8 locale；输出净化成下划线时按真实会话名解析、丢幻影行；退出码窗格优先/落盘回落", async (t) => {
  const box = sandbox(t);
  const app = path.join(box.work, "app");
  const weird = path.join(box.work, "a b;");
  const build = (collapsedTmux) => {
    const add = (name, dead, status, cwd, screen = []) => collapsedTmux.sessions.set(name, { name, cwd, dead, status, screen, created: collapsedTmux.sessions.size + 1 });
    add(device.ATTACH_SESSION, false, null, box.kit);
    add("pi-app-k1", false, null, app);
    add("pi-bad_k2", true, 127, weird);
    add("pi-fieldless-k3", true, null, app);
    add("work", false, null, box.home);
  };

  // 1) 本机有 UTF-8 locale：调用 tmux 前注入（fake tmux 仍返回净化后的下划线，走兼容解析）
  const tmux = fakeTmux({ collapsed: true, extraLines: ["ghost_0__/tmp_123"] });
  build(tmux);
  attach.writeExitCodePath(attach.exitCodePath("pi-fieldless-k3", box.home), 143);
  const injected = ctxFor(box, {
    tmux,
    env: { LANG: "C" },
    opts: { localeSpawn: () => ({ status: 0, stdout: "C\nC.utf8\nen_US.utf8\n" }) },
  });
  assert.equal(await device.main(["sessions"], injected.ctx), 0);
  assert.match(injected.text(), /pi-app-k1 .*运行中/);
  assert.match(injected.text(), /pi-bad_k2 .*已退出（退出码 127）/);
  assert.match(injected.text(), /pi-fieldless-k3 .*已退出（退出码 143）/, "窗格字段丢了就读落盘");
  assert.doesNotMatch(injected.text(), /ghost|pi-remote-attach|\bwork\b +~/);
  assert.ok(tmux.envs.some((env) => env && env.LC_ALL === "C.UTF-8"), "tmux 客户端要注入探测到的 UTF-8 locale");

  // 2) 本机没有任何 UTF-8 locale：不注入，兼容解析照常工作
  const tmux2 = fakeTmux({ collapsed: true, extraLines: ["ghost_0__/tmp_123"] });
  build(tmux2);
  attach.writeExitCodePath(attach.exitCodePath("pi-fieldless-k3", box.home), 143);
  const fallback = ctxFor(box, {
    tmux: tmux2,
    env: { LANG: "C" },
    opts: { localeSpawn: () => ({ status: 1, stdout: "" }) },
  });
  assert.equal(await device.main(["sessions"], fallback.ctx), 0);
  assert.match(fallback.text(), /pi-app-k1 .*运行中/);
  assert.match(fallback.text(), /pi-bad_k2 .*已退出（退出码 127）/);
  assert.match(fallback.text(), /pi-fieldless-k3 .*已退出（退出码 143）/);
  assert.doesNotMatch(fallback.text(), /ghost/);
  assert.ok(!tmux2.envs.some((env) => env && env.LC_ALL), "探不到就绝不能瞎注入");
});

test("nvm：findPi / piFallbacks 按 node 版本序取最新（系统服务 / cron 的精简 PATH）", (t) => {
  const box = sandbox(t);
  const oldBin = path.join(box.home, ".nvm", "versions", "node", "v9.1.0", "bin");
  const newBin = path.join(box.home, ".nvm", "versions", "node", "v22.23.4", "bin");
  fakePi(path.join(oldBin, "pi"));
  fakePi(path.join(newBin, "pi"));
  const ctx = device.makeContext({
    kit: box.kit,
    home: box.home,
    cwd: box.work,
    platform: "linux",
    uid: 1000,
    user: "piagent",
    env: { PATH: "/usr/bin:/bin", HOME: box.home, LANG: "C.UTF-8" },
    out: () => {},
    err: () => {},
  });
  assert.deepEqual(attach.nvmNodeBins(box.home, ctx.env), [newBin, oldBin], "按版本号从新到旧，不是字典序");
  assert.equal(device.findPi(ctx, "").path, path.join(newBin, "pi"));
});

test("start：拉起形状与 attach 一致（/bin/bash start-pi.sh，--session 原样），不在白名单、窗口没开都给提示", async (t) => {
  const box = sandbox(t);
  pairedEnv(box);
  const tmux = fakeTmux();
  const s = ctxFor(box, { tmux });
  const dir = path.join(box.work, "a b;");
  assert.equal(await device.main(["start", dir, "--session", "0199abcd"], s.ctx), 0);
  const c = tmux.calls.find((x) => x[0] === "new-session");
  const name = c[c.indexOf("-s") + 1];
  assert.match(name, /^pi-a_b_-[a-z0-9]+$/);
  const piExit = attach.exitCodePath(name, box.home);
  assert.deepEqual(c.slice(4), ["-c", path.join(box.work, "a b\\;"), "/usr/bin/env", `PI_REMOTE_EXIT_FILE=${piExit}`, "/bin/bash", path.join(box.kit, "deploy", "start-pi.sh"), "--session", "0199abcd", ";", "set-option", "-w", "-t", `=${name}:`, "remain-on-exit", "failed"]);
  assert.match(s.text(), /不在 PI_REMOTE_PROJECTS 里/);
  assert.match(s.text(), /连接窗口没开/);

  const bad = ctxFor(box, { tmux });
  assert.equal(await device.main(["start"], bad.ctx), 2);
  assert.equal(await device.main(["start", path.join(box.work, "nope")], ctxFor(box, { tmux }).ctx), 2);
});

test("小工具：tmux 末尾分号转义、/healthz 地址、node 版本门槛、配对码校验在连接之前", async (t) => {
  assert.equal(attach.tmuxArg("/srv/a;"), "/srv/a\\;");
  assert.equal(attach.tmuxArg("/srv/a\\;"), "/srv/a\\\\;");
  assert.equal(attach.tmuxArg("/srv/a;b"), "/srv/a;b");
  assert.equal(device.healthUrl("ws://127.0.0.1:7001", {}), "http://127.0.0.1:7002/healthz");
  assert.equal(device.healthUrl("ws://127.0.0.1:17301", { PI_REMOTE_VIEWER_PORT: "17302" }), "http://127.0.0.1:17302/healthz");
  assert.equal(device.healthUrl("wss://pi.example.com/local", {}), "https://pi.example.com/healthz", "反代（没写端口）就同源");
  assert.equal(device.nodeVersionOk("22.18.0"), true);
  assert.equal(device.nodeVersionOk("22.17.1"), false);
  assert.equal(device.nodeVersionOk("24.1.0"), true);
  assert.equal(device.nodeVersionOk("20.19.0"), false);

  const box = sandbox(t);
  const tmux = fakeTmux();
  const bad = ctxFor(box, { tmux });
  assert.equal(await device.main(["pair", "1234-5678"], bad.ctx), 2, "0、1 不在配对码字母表里");
  assert.match(bad.errText(), /配对码应为 8 位/);
  assert.equal(fs.existsSync(box.envPath), false, "坏配对码不生成 .env、不连 relay");
});

test("配对与体检（进程内真 relay）：device.sh pair 把令牌写进 .env（600，不打印）→ doctor 的健康检查与令牌鉴权都过 → 网页撤销后 doctor 报被撤销", async (t) => {
  const { startRelay } = require("../relay/server.js");
  const WebSocket = require("ws");
  const box = sandbox(t);
  const relay = await startRelay({
    localPort: 0,
    viewerPort: 0,
    dataDir: path.join(box.root, "rooms"),
    accountsDir: path.join(box.root, "accounts"),
    quiet: true,
    exitOnListenError: false,
    localToken: "lt",
    viewerToken: "vt",
    adminToken: ADMIN_TOKEN,
    persistTranscripts: false,
  });
  t.after(() => relay.close());
  const viewer = new WebSocket(`ws://127.0.0.1:${relay.viewerPort}/`);
  const frames = [];
  viewer.on("message", (d) => frames.push(JSON.parse(String(d))));
  await new Promise((r) => viewer.once("open", r));
  t.after(() => viewer.close());
  const take = async (pred) => {
    for (let i = 0; i < 300 && !frames.some(pred); i++) await new Promise((r) => setTimeout(r, 10));
    const hit = frames.find(pred);
    assert.ok(hit, "等不到帧");
    return hit;
  };
  viewer.send(JSON.stringify({ type: "auth", role: "viewer", token: "vt", proto: 4, caps: ["err.v4", "device.token"] }));
  await take((f) => f.type === "auth_result" && f.ok);
  viewer.send(JSON.stringify({ type: "pair_create", id: "pc1", name: "阿里云", adminToken: ADMIN_TOKEN }));
  const code = (await take((f) => f.type === "ack" && f.id === "pc1")).data.code;

  fakePi(path.join(box.home, ".local", "bin", "pi"));
  const relayUrl = `ws://127.0.0.1:${relay.localPort}`;
  const env = { PI_REMOTE_VIEWER_PORT: String(relay.viewerPort) };
  const pair = ctxFor(box, { env });
  assert.equal(await device.main(["pair", code.toLowerCase(), "--relay", relayUrl], pair.ctx), 0, pair.errText());
  const saved = attach.parseEnv(fs.readFileSync(box.envPath, "utf8"));
  assert.ok(saved.PI_REMOTE_DEVICE_ID);
  assert.ok(saved.PI_REMOTE_DEVICE_TOKEN && saved.PI_REMOTE_DEVICE_TOKEN.length >= 40);
  assert.equal(saved.PI_REMOTE_RELAY, relayUrl);
  assert.equal(saved.PI_REMOTE_LAUNCHER, "tmux", "没有 .env 时先按 init 生成");
  assert.equal(fs.statSync(box.envPath).mode & 0o777, 0o600);
  assert.equal(pair.text().includes(saved.PI_REMOTE_DEVICE_TOKEN), false, "令牌不打印");
  assert.match(pair.text(), /device\.sh up/);
  const listed = await take((f) => f.type === "room_list" && (f.devices || []).some((d) => d.id === saved.PI_REMOTE_DEVICE_ID));
  assert.equal(listed.devices.find((d) => d.id === saved.PI_REMOTE_DEVICE_ID).platform, "linux");

  // 扩展装好，doctor 只剩「窗口没开」一条 warn
  fs.mkdirSync(path.join(box.home, ".pi", "agent", "extensions"), { recursive: true });
  fs.copyFileSync(path.join(box.kit, "extension", "pi-remote-sync.ts"), path.join(box.home, ".pi/agent/extensions/pi-remote-sync.ts"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(box.kit, "node_modules"));
  const doc = ctxFor(box, { env });
  assert.equal(await device.main(["doctor"], doc.ctx), 0, doc.text());
  assert.match(doc.text(), /^\[ok\]   relay 健康（proto 4/m);
  assert.match(doc.text(), /^\[ok\]   设备令牌有效$/m);
  assert.match(doc.text(), /^\[ok\]   relay ws:\/\/127\.0\.0\.1:\d+（回环/m);
  assert.match(doc.text(), /^\[ok\]   pi 1\.0\.2/m);
  assert.match(doc.text(), /^\[warn\] 连接窗口没开/m);
  assert.match(doc.text(), /全部通过/);

  viewer.send(JSON.stringify({ type: "device_revoke", id: "rv1", deviceId: saved.PI_REMOTE_DEVICE_ID, adminToken: ADMIN_TOKEN }));
  await take((f) => f.type === "ack" && f.id === "rv1");
  const revoked = ctxFor(box, { env });
  assert.equal(await device.main(["doctor"], revoked.ctx), 1);
  assert.match(revoked.text(), /^\[fail\] 这台设备在网页上被撤销了/m);

  const status = ctxFor(box, { env });
  assert.equal(await device.main(["status"], status.ctx), 0);
  assert.match(status.text(), /relay：ws:\/\/127\.0\.0\.1:\d+ · proto 4/);
  assert.match(status.text(), /连接窗口没开/);
});

test("doctor：缺 tmux、缺 pi、缺依赖、.env 权限过宽、relay 不在回环、没配对、扩展没同步、语言环境——逐条报出来", async (t) => {
  const box = sandbox(t);
  // 0.0.0.0 不算回环（要提示改），连它的 viewer 端口 1 会被立刻拒绝（健康检查不用等超时）
  fs.writeFileSync(box.envPath, "PI_REMOTE_RELAY=ws://0.0.0.0:1\nPI_REMOTE_TOKEN=legacy\nPI_REMOTE_DEVICE_ID=d1\nPI_REMOTE_PROJECTS=/no/such\n", { mode: 0o644 });
  fs.chmodSync(box.envPath, 0o644);
  const { ctx, text } = ctxFor(box, { tmux: fakeTmux({ version: "" }), env: { LANG: "C", PI_REMOTE_VIEWER_PORT: "1" } });
  assert.equal(await device.main(["doctor"], ctx), 1);
  const out = text();
  assert.match(out, /^\[fail\] 找不到 tmux/m);
  assert.match(out, /^\[fail\] 找不到 pi：npm i -g --prefix ~\/\.local @earendil-works\/pi-coding-agent/m);
  assert.match(out, /^\[fail\] 缺依赖 ws/m);
  assert.match(out, /^\[warn\] \.env 权限 644/m);
  assert.match(out, /^\[warn\] relay ws:\/\/0\.0\.0\.0:1：relay 就在这台服务器上时改成 ws:\/\/127\.0\.0\.1:7001/m);
  assert.match(out, /^\[warn\] 白名单里这些目录不存在：\/no\/such/m);
  assert.match(out, /^\[warn\] 只有共享令牌/m);
  assert.match(out, /^\[fail\] 扩展还没装到 ~\/\.pi\/agent\/extensions\/pi-remote-sync\.ts/m);
  assert.match(out, /^\[fail\] relay 健康检查失败/m);
  assert.match(out, /^\[warn\] 语言环境 C/m);
  assert.match(out, /项要处理/);
});

test("doctor：PI_REMOTE_PI_BIN 写错时报「路径不存在」，不是笼统的「不可执行」", async (t) => {
  const box = sandbox(t);
  pairedEnv(box);
  const missing = path.join(box.home, "no-such-pi");
  const { ctx, text } = ctxFor(box, { tmux: fakeTmux(), env: { PI_REMOTE_PI_BIN: missing } });
  assert.equal(await device.main(["doctor"], ctx), 1);
  assert.match(text(), new RegExp(`^\\[fail\\] PI_REMOTE_PI_BIN=${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} 路径不存在$`, "m"));
  assert.doesNotMatch(text(), /不可执行/);
});

test("deploy/linux 下的 shell 脚本：LF、可执行、bash 3.2 语法通过；device.sh 经符号链接调用也找得到 device.cjs", { skip: process.platform === "win32" }, (t) => {
  const scripts = fs.readdirSync(LINUX_DIR).filter((n) => n.endsWith(".sh"));
  assert.deepEqual(scripts.sort(), ["device.sh", "push.sh"]);
  for (const name of scripts) {
    const file = path.join(LINUX_DIR, name);
    const text = fs.readFileSync(file, "utf8");
    assert.equal(text.includes("\r"), false, name + " 不能有 CR");
    assert.ok(fs.statSync(file).mode & 0o111, name + " 要有可执行位");
    const r = spawnSync("/bin/bash", ["-n", file], { encoding: "utf8" });
    assert.equal(r.status, 0, name + ": " + r.stderr);
    // UTF-8 环境下 macOS 的 bash 3.2 把中文的首字节当成变量名的一部分（$server（ → 变量 server\xef 未定义）
    const glued = text.split("\n").filter((line) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line));
    assert.deepEqual(glued, [], name + "：紧贴中文的变量要写成 ${var}");
  }
  const bin = tmp("pi-linux-link-");
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  fs.symlinkSync(path.join(LINUX_DIR, "device.sh"), path.join(bin, "pi-remote"));
  const r = spawnSync(path.join(bin, "pi-remote"), ["help"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pi-remote Linux 设备/);
});

test("device.sh：PATH 里没有 node 时从 ~/.nvm/versions/node/*/bin 按版本序取最新", { skip: process.platform === "win32" }, () => {
  const root = tmp("pi-device-nvm-");
  try {
    const home = path.join(root, "home");
    const out = path.join(root, "node-seen.txt");
    const mk = (version, label) => {
      const dir = path.join(home, ".nvm", "versions", "node", version, "bin");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "node"), `#!/bin/sh\nprintf '%s\\n' ${label} "$@" > ${JSON.stringify(out)}\nexit 5\n`, { mode: 0o755 });
    };
    mk("v9.1.0", "old");
    mk("v22.23.4", "new");
    const tools = path.join(root, "tools");
    fs.mkdirSync(tools);
    for (const name of ["readlink", "dirname", "awk", "sort", "tail"]) {
      const src = [`/usr/bin/${name}`, `/bin/${name}`].find((p) => fs.existsSync(p));
      assert.ok(src, "测试机缺少 " + name);
      fs.symlinkSync(src, path.join(tools, name));
    }
    const r = spawnSync("/bin/sh", [path.join(LINUX_DIR, "device.sh"), "help"], {
      env: { HOME: home, PATH: tools },
      encoding: "utf8",
    });
    assert.equal(r.status, 5, r.stderr);
    const seen = fs.readFileSync(out, "utf8").trim().split("\n");
    assert.equal(seen[0], "new", "按版本号而不是字典序取最新");
    assert.equal(seen[1], path.join(LINUX_DIR, "device.cjs"));
    assert.equal(seen[2], "help");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ---------- push.sh ---------- */

/** 拷一份仓库里 push.sh 要打包的文件到临时仓库；PATH 前面放假 ssh / scp / npm */
function pushSandbox(t, { live = false } = {}) {
  const root = tmp("pi-linux-push-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const files = ["package.json", "package-lock.json", ".env.example", "protocol/v4.json", "extension/pi-remote-sync.ts", "deploy/attach.cjs", "deploy/session-library.cjs", "deploy/attach.sh", "deploy/start-pi.sh", "deploy/sync-extension.sh", "deploy/linux/device.cjs", "deploy/linux/device.sh", "deploy/linux/push.sh"];
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(repo, rel));
    fs.chmodSync(path.join(repo, rel), fs.statSync(path.join(REPO, rel)).mode & 0o777);
  }
  fs.writeFileSync(path.join(repo, ".env"), "PI_REMOTE_DEVICE_TOKEN=must-not-ship\n");
  fs.writeFileSync(path.join(repo, "deploy", "known_hosts"), "");
  const bin = path.join(root, "bin");
  const remoteHome = path.join(root, "remote-home");
  fs.mkdirSync(bin);
  fs.mkdirSync(remoteHome);
  const calls = path.join(root, "calls.log");
  if (!live) {
    for (const tool of ["ssh", "scp", "npm"]) fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> '${calls}'\nexit 1\n`, { mode: 0o755 });
  } else {
    // 假 ssh：丢掉 -o 选项和主机名，把远端命令交给本机 bash（HOME 换成「服务器」的家目录）
    fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/bash\necho "ssh $*" >> '${calls}'\nwhile [ "$1" = -o ]; do shift 2; done\nshift\nexport HOME='${remoteHome}'\nexec bash -c "$1"\n`, { mode: 0o755 });
    // 假 scp：把 主机:相对路径 落到「服务器」家目录
    fs.writeFileSync(path.join(bin, "scp"), `#!/bin/bash\necho "scp $*" >> '${calls}'\nfor a; do last=$a; done\nsrc=\${@: -2:1}\ncp "$src" '${remoteHome}'/"\${last#*:}"\n`, { mode: 0o755 });
    // 假 npm：ci 时把仓库的 node_modules 链过来（不联网）
    fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\necho "npm $* @ $PWD" >> '${calls}'\n[ "$1" = ci ] && ln -s '${path.join(REPO, "node_modules")}' node_modules\nexit 0\n`, { mode: 0o755 });
  }
  const run = (args) => {
    const r = spawnSync("/bin/bash", [path.join(repo, "deploy", "linux", "push.sh"), ...args], {
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, HOME: path.join(root, "local-home") },
      encoding: "utf8",
    });
    return { ...r, calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "" };
  };
  return { root, repo, remoteHome, run };
}

test("push.sh：占位 server、坏用户名、root、坏目录——都在打包和连接之前停下", { skip: process.platform === "win32" }, (t) => {
  const box = pushSandbox(t);
  for (const args of [
    [],
    ["--server", "root@<你的服务器IP>", "--user", "piagent"],
    ["--server", "has space@host"],
    ["--server", "root@1.2.3.4"],
    ["--server", "root@1.2.3.4", "--user", "root"],
    ["--server", "1.2.3.4", "--user", "Pi Agent"],
    ["--server", "root@1.2.3.4", "--user", "piagent", "--dir", "relative/dir"],
    ["--server", "root@1.2.3.4", "--user", "piagent", "--dir", "/home/piagent/../root"],
    ["--server", "root@1.2.3.4", "--user", "piagent", "--dir", "/"],
    ["--server", "root@1.2.3.4", "--user", "piagent", "--dir", "/home/a b"],
    ["--server", "root@1.2.3.4", "--bogus"],
  ]) {
    const r = box.run(args);
    assert.notEqual(r.status, 0, args.join(" "));
    assert.equal(r.calls, "", "没有调用 ssh/scp/npm：" + args.join(" ") + "\n" + r.calls);
  }
  const r = box.run(["--server", "root@1.2.3.4", "--user", "piagent"]);
  assert.match(r.calls, /^scp /m, "参数都对才会去连（假 scp 返回失败，脚本随即停下）");
  assert.notEqual(r.status, 0);
});

test("push.sh 全流程（假 ssh 在本机跑服务器端脚本）：只带套件文件不带 .env、保留并收紧已有 .env、装依赖、同步扩展、跑 doctor", { skip: process.platform === "win32" }, (t) => {
  const me = os.userInfo().username;
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(me) || me === "root") return t.skip("本机用户名不适合当设备用户：" + me);
  const box = pushSandbox(t, { live: true });
  const dir = path.join(box.remoteHome, "pi-remote");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".env"), "PI_REMOTE_DEVICE_ID=keep-me\n", { mode: 0o644 });
  fs.chmodSync(path.join(dir, ".env"), 0o644);
  const r = box.run(["--server", `${me}@devbox`, "--dir", dir]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const rel of ["deploy/attach.cjs", "deploy/session-library.cjs", "deploy/start-pi.sh", "deploy/sync-extension.sh", "deploy/linux/device.cjs", "deploy/linux/device.sh", "extension/pi-remote-sync.ts", "protocol/v4.json", "package.json"]) {
    assert.ok(fs.existsSync(path.join(dir, rel)), rel);
  }
  assert.ok(fs.statSync(path.join(dir, "deploy/linux/device.sh")).mode & 0o111, "可执行位跟着走");
  assert.equal(fs.existsSync(path.join(dir, "deploy/linux/push.sh")), false, "push.sh 只在本机用，不进套件");
  assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), "PI_REMOTE_DEVICE_ID=keep-me\n", "服务器上已有的 .env 原样保留，本机的 .env 不带过去");
  assert.equal(fs.statSync(path.join(dir, ".env")).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(box.remoteHome, "pi-remote-device-kit.tar")), false, "上传的压缩包用完就删");
  assert.equal(
    fs.readFileSync(path.join(box.remoteHome, ".pi/agent/extensions/pi-remote-sync.ts"), "utf8"),
    fs.readFileSync(path.join(REPO, "extension/pi-remote-sync.ts"), "utf8"),
    "扩展装进设备用户的 ~/.pi/agent/extensions",
  );
  // 依赖在 <目录>.new.<pid> 暂存目录里装，装好才整体换版；不能直接写正式目录
  assert.match(r.calls, /^npm ci --omit=dev .*--registry=https:\/\/registry\.npmmirror\.com @ .*pi-remote\.new\.\d+$/m);
  assert.match(r.calls, /^scp .*@devbox:pi-remote-device-kit\.tar$/m, "传到登录用户家目录，不经 /tmp");
  assert.match(r.stdout, /体检（device\.sh doctor）/);
  assert.match(r.stdout, /\[ok\]   依赖 ws 已装/);
  assert.match(r.stdout, /\[ok\]   扩展已同步/);
  assert.match(r.stdout, /DONE\./);
  assert.match(r.stdout, /device\.sh init --projects/);
});
