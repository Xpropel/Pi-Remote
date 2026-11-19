// macOS 设备（deploy/darwin/device.cjs）的命令行为——.env 生成、root 拦截、tmux 参数形状、
// 窗口起停与失败现场、pi 会话列表；与 linux-device.test.cjs 结构对齐，但适配 darwin。
// tmux 用假的（记账 + 按脚本回话），不依赖真实 macOS 环境。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const device = require("../deploy/darwin/device.cjs");
const attach = require("../deploy/attach.cjs");

const REPO = path.join(import.meta.dirname, "..");

function tmp(prefix) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const KIT_FILES = ["deploy/attach.cjs", "deploy/session-library.cjs", "deploy/start-pi.sh", "deploy/darwin/device.cjs", "deploy/darwin/device.sh", "deploy/darwin/supervise-attach.sh", "extension/pi-remote-sync.ts", "protocol/v4.json", ".env.example"];

/** 沙箱：套件（只拷用得到的文件）+ 家目录 + 两个项目目录。.env 写在沙箱里，不碰仓库的 */
function sandbox(t) {
  const root = tmp("pi-darwin-dev-");
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
  fs.mkdirSync(path.join(work, "a b;"), { recursive: true });
  return { root, kit, home, work, envPath: path.join(kit, ".env") };
}

function fakePi(file, version = "1.0.2") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n[ "$1" = --version ] && echo ${version}\n`, { mode: 0o755 });
  return file;
}

/** 假 tmux：记下每次调用；会话表按 new-session / kill-session 增减 */
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
    platform: "darwin",
    uid: 501,
    user: "piuser",
    env: { PATH: "/usr/bin:/bin", HOME: box.home, LANG: "en_US.UTF-8", ...(extra.env || {}) },
    tmux: extra.tmux ? extra.tmux.run : fakeTmux().run,
    out: (line) => out.push(String(line)),
    err: (line) => err.push(String(line)),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    upWaitMs: 400,
    downWaitMs: 300,
    // 只在沙箱里找 pi：开发机装没装 pi 不影响结果
    piFallbacks: [path.join(box.home, ".local", "bin", "pi"), path.join(box.home, ".npm-global", "bin", "pi")],
    ...extra.opts,
  });
  return { ctx, out, err, text: () => out.join("\n"), errText: () => err.join("\n") };
}

function pairedEnv(box, extra = "") {
  fs.writeFileSync(
    box.envPath,
    ["PI_REMOTE_RELAY=ws://127.0.0.1:7001", "PI_REMOTE_DEVICE_ID=dev-mac-1", "PI_REMOTE_DEVICE_TOKEN=tok-abc", `PI_REMOTE_PROJECTS=${path.join(box.work, "app")}`, extra, ""].join("\n"),
    { mode: 0o600 },
  );
}

/** 假 attach：tmux 开窗口时按 attach 的样子写状态文件（认证通过后才写） */
function writesState(box, deviceId = "dev-mac-1") {
  return () => {
    const file = path.join(box.home, ".pi", "agent", "remote-attach.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, deviceId, accountId: "admin", relay: "ws://127.0.0.1:7001", startedAt: Date.now(), expiresAt: Date.now() + 2 * 3600e3 }));
  };
}

// ---------- init ----------

test("init：新建 .env（600）沿用模板，relay 走回环、清掉占位 token 和示例标签、拉起方式 tmux、pi 写成绝对路径", async (t) => {
  const box = sandbox(t);
  const pi = fakePi(path.join(box.home, ".local", "bin", "pi"));
  const app = path.join(box.work, "app");
  const other = path.join(box.work, "we ird $x");
  const { ctx, text } = ctxFor(box);
  assert.equal(await device.main(["init", "--projects", `${app}/; ${other}`, "--name", "MacBook"], ctx), 0);
  assert.equal(fs.statSync(box.envPath).mode & 0o777, 0o600);
  const env = attach.parseEnv(fs.readFileSync(box.envPath, "utf8"));
  assert.equal(env.PI_REMOTE_RELAY, device.LOOPBACK_RELAY);
  assert.equal(env.PI_REMOTE_TOKEN, "", "模板里的 change-me 不能留着去登录");
  assert.equal(env.PI_REMOTE_LABEL, "", "「我的电脑」不是 Mac 的名字");
  assert.equal(env.PI_REMOTE_DEVICE_NAME, "MacBook");
  assert.equal(env.PI_REMOTE_PROJECTS, `${app};${other}`, "末尾斜杠、分号两侧空格去掉；$ 和空格原样");
  assert.equal(env.PI_REMOTE_LAUNCHER, "tmux", "macOS device.sh 默认用 tmux");
  assert.equal(env.PI_REMOTE_PI_BIN, pi, "pi 不在 PATH 里也找得到，并写死成绝对路径");
  assert.match(text(), /未配对/);
  assert.match(text(), /device\.sh pair XXXX-XXXX/);
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

// ---------- root ----------

test("root：init / pair / up / start 一律拒绝；darwin 不给 adduser 建议", async (t) => {
  const box = sandbox(t);
  const tmux = fakeTmux();
  for (const args of [["init"], ["pair", "ABCD-EFGH"], ["up"], ["start", box.work]]) {
    const { ctx, errText } = ctxFor(box, { tmux, opts: { uid: 0 } });
    assert.equal(await device.main(args, ctx), 2, args[0]);
    assert.match(errText(), /不要用 root/, args[0]);
    // macOS 版不给 adduser 建议（Linux 版有）
    assert.doesNotMatch(errText(), /adduser/, args[0] + " 不该出 adduser");
  }
  assert.equal(fs.existsSync(box.envPath), false);
  assert.equal(tmux.calls.some((c) => c[0] === "new-session"), false);
});

// ---------- up ----------

test("up：没配对先拦；tmux 命令通过 darwin/supervise-attach.sh 带 PI_REMOTE_SUPERVISED=1 拉起", async (t) => {
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
    "/usr/bin/env", `PI_REMOTE_EXIT_FILE=${attachExit}`, "PI_REMOTE_SUPERVISED=1",
    "/bin/sh", path.join(box.kit, "deploy", "darwin", "supervise-attach.sh"),
    process.execPath, path.join(box.kit, "deploy", "attach.cjs"), "--max-hours", "36",
    path.join(box.work, "app"), path.join(box.work, "a b\\;"),
    ";", "set-option", "-w", "-t", `=${device.ATTACH_SESSION}:`, "remain-on-exit", "failed",
  ]);
  for (const c of tmux.calls) if (c.includes("-t")) assert.match(c[c.indexOf("-t") + 1], /^=/, "目标一律 = 精确匹配：" + c.join(" "));
  assert.match(text(), /连接窗口已打开/);
  assert.match(text(), /tmux attach -t pi-remote-attach/);
});

test("up：窗口已开不重开；没有 tmux 时给 brew 安装提示", async (t) => {
  const box = sandbox(t);
  pairedEnv(box);
  const tmux = fakeTmux({ onNew: writesState(box) });
  const { ctx } = ctxFor(box, { tmux });
  assert.equal(await device.main(["up"], ctx), 0);

  const before = tmux.calls.length;
  const again = ctxFor(box, { tmux });
  assert.equal(await device.main(["up"], again.ctx), 0);
  assert.equal(tmux.calls.slice(before).some((c) => c[0] === "new-session"), false, "窗口已经开着就不再开第二个");
  assert.match(again.text(), /连接窗口开着（tmux 会话 pi-remote-attach）/);

  const missing = ctxFor(box, { tmux: fakeTmux({ version: "" }) });
  assert.equal(await device.main(["up"], missing.ctx), 1);
  assert.match(missing.errText(), /brew install tmux/, "macOS 应提示 brew install");
});

test("up：窗口当场退出时把窗格里的原因抓出来", async (t) => {
  const box = sandbox(t);
  pairedEnv(box);
  const tmux = fakeTmux({
    onNew: (s) => {
      s.dead = true;
      s.status = 1;
      s.screen = ["正在连接…", "relay 鉴权失败：这台设备已被撤销"];
    },
  });
  const { ctx, errText } = ctxFor(box, { tmux });
  assert.equal(await device.main(["up"], ctx), 1);
  assert.match(errText(), /退出码 1/);
  assert.match(errText(), /已被撤销/);
  assert.equal(tmux.sessions.has(device.ATTACH_SESSION), false, "失败现场抓完就收掉");
});

// ---------- down ----------

test("down：关闭 tmux 会话", async (t) => {
  const box = sandbox(t);
  pairedEnv(box);
  const state = path.join(box.home, ".pi", "agent", "remote-attach.json");
  const tmux = fakeTmux({ onNew: writesState(box) });
  const upCtx = ctxFor(box, { tmux });
  assert.equal(await device.main(["up"], upCtx.ctx), 0);
  assert.ok(tmux.sessions.has(device.ATTACH_SESSION));

  // 真 attach 收到 SIGHUP 会自己删状态文件；假的这里替它删
  const killing = fakeTmux();
  killing.sessions.set(device.ATTACH_SESSION, tmux.sessions.get(device.ATTACH_SESSION));
  const origRun = killing.run;
  killing.run = (args, opts) => {
    if (args[0] === "kill-session") fs.rmSync(state, { force: true });
    return origRun(args, opts);
  };
  const { ctx, text } = ctxFor(box, { tmux: killing });
  assert.equal(await device.main(["down"], ctx), 0);
  assert.match(text(), /连接窗口已关闭/);
  assert.equal(killing.sessions.has(device.ATTACH_SESSION), false);
});

test("down：窗口没开时清残留", async (t) => {
  const box = sandbox(t);
  const { ctx, text } = ctxFor(box);
  assert.equal(await device.main(["down"], ctx), 0);
  assert.match(text(), /没有在运行/);
});

// ---------- sessions / clean ----------

test("sessions：列出 pi 的 tmux 会话", async (t) => {
  const box = sandbox(t);
  const tmux = fakeTmux();
  tmux.sessions.set("pi-app-abc123456789", { name: "pi-app-abc123456789", cwd: "/tmp/app", dead: false, status: null, screen: [], created: Math.floor(Date.now() / 1000) });
  tmux.sessions.set("pi-web-def456789012", { name: "pi-web-def456789012", cwd: "/tmp/web", dead: true, status: 0, screen: [], created: Math.floor(Date.now() / 1000) });
  const { ctx, text } = ctxFor(box, { tmux });
  assert.equal(await device.main(["sessions"], ctx), 0);
  assert.match(text(), /pi-app-abc123456789/);
  assert.match(text(), /运行中/);
  assert.match(text(), /已退出/);
  assert.match(text(), /clean/);
});

test("clean：收掉已退出的 pi 会话", async (t) => {
  const box = sandbox(t);
  const tmux = fakeTmux();
  tmux.sessions.set("pi-dead-aaa123456789", { name: "pi-dead-aaa123456789", cwd: "/tmp", dead: true, status: 1, screen: [], created: Math.floor(Date.now() / 1000) });
  tmux.sessions.set("pi-alive-bbb123456789", { name: "pi-alive-bbb123456789", cwd: "/tmp", dead: false, status: null, screen: [], created: Math.floor(Date.now() / 1000) });
  const { ctx, text } = ctxFor(box, { tmux });
  assert.equal(await device.main(["clean"], ctx), 0);
  assert.match(text(), /收掉了 1 个/);
  assert.equal(tmux.sessions.has("pi-dead-aaa123456789"), false);
  assert.ok(tmux.sessions.has("pi-alive-bbb123456789"));
});

// ---------- help ----------

test("help：打出帮助文本", async (t) => {
  const box = sandbox(t);
  const { ctx, text } = ctxFor(box);
  assert.equal(await device.main(["help"], ctx), 0);
  assert.match(text(), /macOS 设备/);
  assert.match(text(), /device\.sh init/);
  assert.match(text(), /device\.sh up/);
  assert.match(text(), /device\.sh doctor/);
});

test("未知命令返回 2", async (t) => {
  const box = sandbox(t);
  const { ctx, errText } = ctxFor(box);
  assert.equal(await device.main(["bogus"], ctx), 2);
  assert.match(errText(), /未知命令/);
});

// ---------- superviseSh 路径指向 darwin ----------

test("makeContext：superviseSh 和 deviceSh 指向 deploy/darwin/", (t) => {
  const ctx = device.makeContext({ kit: "/fake/kit", platform: "darwin" });
  assert.match(ctx.superviseSh, /deploy\/darwin\/supervise-attach\.sh$/);
  assert.match(ctx.deviceSh, /deploy\/darwin\/device\.sh$/);
});

// ---------- piFallbacks 包含 Homebrew 路径 ----------

test("piFallbacks：包含 /opt/homebrew/bin/pi 和 /usr/local/bin/pi", (t) => {
  const fb = device.piFallbacks("/Users/test", {});
  assert.ok(fb.includes("/opt/homebrew/bin/pi"), "应包含 Apple Silicon Homebrew 路径");
  assert.ok(fb.includes("/usr/local/bin/pi"), "应包含 Intel Homebrew 路径");
});

// ---------- findPi ----------

test("findPi：PIN → PATH → 常见位置", (t) => {
  const box = { home: "/tmp/pi-test-find-" + process.pid };
  fs.mkdirSync(box.home, { recursive: true });
  const pi = fakePi(path.join(box.home, ".local", "bin", "pi"));
  const ctx = device.makeContext({ home: box.home, env: { PATH: "", HOME: box.home }, piFallbacks: [pi] });
  const found = device.findPi(ctx, "");
  assert.ok(found);
  assert.equal(found.path, pi);
  assert.equal(found.ok, true);
  fs.rmSync(box.home, { recursive: true, force: true });
});
