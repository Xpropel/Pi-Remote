// macOS / Linux 三个 .sh 壳的测试。start-pi.sh：.env 解析规则与 start-pi.cmd、attach.cjs 对齐（引号、键名空格、
// 值首尾空格、注释、BOM、CRLF、特殊字符），值绝不被 shell 展开，参数原样传给 pi，退出码透传；PATH 里没有 node、
// 脚本被软链时也能起。attach.sh / sync-extension.sh：软链、找 node、扩展同步。
// 用 PATH 上的假 pi / 假 node 代替真的；用 /bin/bash 跑，覆盖 macOS 自带的 bash 3.2。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const attach = require("../deploy/attach.cjs");

const SRC = path.join(__dirname, "..", "deploy", "start-pi.sh");
const KEYS = ["PI_REMOTE_RELAY", "PI_REMOTE_TOKEN", "PI_REMOTE_LABEL", "PI_REMOTE_DEVICE_NAME", "PI_REMOTE_DEVICE_ID", "PI_SPACED", "PI_EQ", "PI_REMOTE_EMPTY", "PI_DOLLAR", "PI_SQ", "PI_LAST"];

const ENV_LINES = [
  "\uFEFF# 注释行",
  "PI_REMOTE_RELAY=ws://127.0.0.1:7001",
  'PI_REMOTE_TOKEN="tok-123!"',
  "PI_REMOTE_LABEL = a&b|c>d!e ",
  'PI_REMOTE_DEVICE_NAME="我的电脑"',
  "PI_REMOTE_DEVICE_ID = dev-9 ",
  "PI_SPACED = a b c ",
  "PI_EQ=x=y",
  "PI_REMOTE_EMPTY=",
  "PI_DOLLAR=$HOME `id` $(id) ${PATH}",
  "PI_SQ=' single q '",
  "BAD KEY=1",
  "   # 缩进的注释",
  "PI_LAST=no-newline",
];

function setup(lineEnd) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-startsh-"));
  fs.mkdirSync(path.join(root, "deploy"), { recursive: true });
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.copyFileSync(SRC, path.join(root, "deploy", "start-pi.sh"));
  const out = path.join(root, "pi-seen.json");
  const fakePi = path.join(root, "bin", "pi");
  fs.writeFileSync(
    fakePi,
    [
      "#!/usr/bin/env node",
      `const keys = ${JSON.stringify(KEYS)};`,
      "const env = {}; for (const k of keys) env[k] = process.env[k] === undefined ? null : process.env[k];",
      `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ env, argv: process.argv.slice(2), cwd: process.cwd() }), 'utf8');`,
      "process.exit(3);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(root, ".env"), ENV_LINES.join(lineEnd), "utf8");
  return { root, out };
}

function run(lineEnd) {
  const { root, out } = setup(lineEnd);
  fs.mkdirSync(path.join(root, "work dir"));
  const work = fs.realpathSync(path.join(root, "work dir"));
  try {
    const env = { ...process.env, PATH: path.join(root, "bin") + path.delimiter + process.env.PATH };
    for (const k of Object.keys(env)) if (/^PI_REMOTE_|^PI_SPACED$|^PI_EQ$|^PI_DOLLAR$|^PI_SQ$|^PI_LAST$/.test(k)) delete env[k];
    const r = spawnSync("/bin/bash", [path.join(root, "deploy", "start-pi.sh"), "--flag", "fix it!", "x", "p&q", "$HOME"], { cwd: work, env, encoding: "utf8" });
    const seen = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : null;
    return { r, seen, work };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const [name, lineEnd] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
  test(`start-pi.sh（.env 用 ${name}）：去引号/去空格、值不展开、空值不覆盖、参数与退出码原样`, { skip: process.platform === "win32" && "start-pi.sh 只在 macOS / Linux 上跑" }, () => {
    const { r, seen, work } = run(lineEnd);
    assert.ok(seen, "假 pi 必须被调用\n" + r.stdout + r.stderr);
    assert.equal(r.stderr.trim(), "", "stderr 必须干净\n" + r.stderr);
    assert.equal(seen.env.PI_REMOTE_RELAY, "ws://127.0.0.1:7001");
    assert.equal(seen.env.PI_REMOTE_TOKEN, "tok-123!", "值去引号，! 保留");
    assert.equal(seen.env.PI_REMOTE_LABEL, "a&b|c>d!e", "键名去尾随空格、值去首尾空格，& | > ! 不被执行也不丢");
    assert.equal(seen.env.PI_REMOTE_DEVICE_NAME, "我的电脑", "UTF-8 中文值原样");
    assert.equal(seen.env.PI_REMOTE_DEVICE_ID, "dev-9", "两侧都有空格也能解析");
    assert.equal(seen.env.PI_SPACED, "a b c", "值内部空格保留");
    assert.equal(seen.env.PI_EQ, "x=y", "值里的 = 保留");
    assert.equal(seen.env.PI_REMOTE_EMPTY, null, ".env 里留空的键不覆盖（不设置）");
    assert.equal(seen.env.PI_DOLLAR, "$HOME `id` $(id) ${PATH}", "值绝不被 shell 展开或执行");
    assert.equal(seen.env.PI_SQ, "single q", "单引号也去掉一对");
    assert.equal(seen.env.PI_LAST, "no-newline", "最后一行没有换行也要读到");
    assert.deepEqual(seen.argv, ["--flag", "fix it!", "x", "p&q", "$HOME"], "参数原样传给 pi");
    assert.equal(seen.cwd, work, "在调用方目录里起 pi");
    assert.match(r.stdout, /relay=ws:\/\/127\.0\.0\.1:7001/);
    assert.equal(r.status, 3, "pi 的退出码透传");
  });
}

test("start-pi.sh 与 attach.cjs 对同一份 .env 解析结果一致", { skip: process.platform === "win32" }, () => {
  const { r, seen } = run("\r\n");
  assert.ok(seen, r.stderr);
  const parsed = attach.parseEnv(ENV_LINES.join("\n"));
  for (const key of KEYS) {
    const want = parsed[key] === undefined || parsed[key] === "" ? null : parsed[key];
    assert.equal(seen.env[key], want, key);
  }
});

test("start-pi.sh 是 LF 换行、可执行；PI_REMOTE_PI_BIN 指向不存在的文件时退出码 127", { skip: process.platform === "win32" }, () => {
  const text = fs.readFileSync(SRC, "utf8");
  assert.equal(text.includes("\r"), false, "CRLF 会让 bash 报 $'\\r': command not found");
  assert.ok(fs.statSync(SRC).mode & 0o111, "要有可执行位");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-startsh-nopi-"));
  try {
    fs.mkdirSync(path.join(root, "deploy"));
    fs.copyFileSync(SRC, path.join(root, "deploy", "start-pi.sh"));
    fs.writeFileSync(path.join(root, ".env"), `PI_REMOTE_PI_BIN=${path.join(root, "no-such-pi")}\n`, "utf8");
    const r = spawnSync("/bin/bash", [path.join(root, "deploy", "start-pi.sh")], {
      cwd: root,
      env: { HOME: root, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    assert.equal(r.status, 127);
    assert.match(r.stderr, /pi not found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** 假 node：把收到的参数和 PATH 记下来。pi 写成 #!/usr/bin/env node，和 npm / Homebrew 装出来的一样 */
function fakeNodePair(dir, out) {
  fs.mkdirSync(dir, { recursive: true });
  const node = path.join(dir, "node");
  fs.writeFileSync(node, `#!/bin/sh\nprintf '%s\\n' "$PATH" "$@" > ${JSON.stringify(out)}\nexit 5\n`, { mode: 0o755 });
  const pi = path.join(dir, "pi");
  fs.writeFileSync(pi, "#!/usr/bin/env node\n", { mode: 0o755 });
  return { node, pi };
}

test("start-pi.sh：PATH 里没有 node（tmux / launchd 拉起）也能起 pi——pi 同目录的 node 放到 PATH 最前", { skip: process.platform === "win32" }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-startsh-node-")));
  try {
    fs.mkdirSync(path.join(root, "deploy"));
    fs.copyFileSync(SRC, path.join(root, "deploy", "start-pi.sh"));
    const out = path.join(root, "node-seen.txt");
    const { pi } = fakeNodePair(path.join(root, "brew bin"), out);
    fs.writeFileSync(path.join(root, ".env"), `PI_REMOTE_PI_BIN=${pi}\n`, "utf8");
    const r = spawnSync("/bin/bash", [path.join(root, "deploy", "start-pi.sh"), "--version"], {
      cwd: root,
      env: { HOME: root, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    assert.equal(r.status, 5, "退出码来自 pi 同目录的 node\n" + r.stderr);
    const [seenPath, script, arg] = fs.readFileSync(out, "utf8").split("\n");
    assert.equal(seenPath, `${path.join(root, "brew bin")}:/usr/bin:/bin`);
    assert.deepEqual([script, arg], [pi, "--version"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("start-pi.sh 被软链到别处也能找到自己的 .env", { skip: process.platform === "win32" }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-startsh-link-")));
  try {
    fs.mkdirSync(path.join(root, "repo", "deploy"), { recursive: true });
    fs.copyFileSync(SRC, path.join(root, "repo", "deploy", "start-pi.sh"));
    const out = path.join(root, "node-seen.txt");
    const { pi } = fakeNodePair(path.join(root, "bin"), out);
    fs.writeFileSync(path.join(root, "repo", ".env"), `PI_REMOTE_PI_BIN=${pi}\nPI_REMOTE_RELAY=ws://linked:7001\n`, "utf8");
    fs.mkdirSync(path.join(root, "home", "bin"), { recursive: true });
    fs.symlinkSync("../../repo/deploy/start-pi.sh", path.join(root, "home", "bin", "pi-remote"));
    const r = spawnSync("/bin/bash", [path.join(root, "home", "bin", "pi-remote")], { cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stdout, /relay=ws:\/\/linked:7001/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("start-pi.sh：PI_REMOTE_EXIT_FILE 注入时，正常退出 / 找不到 pi / 被信号打断都落盘退出码", { skip: process.platform === "win32" }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-startsh-exit-")));
  const deploy = path.join(root, "deploy");
  const exitFile = path.join(root, "agent", "pi-remote-exit", "s.code");
  const run = (extraEnv = {}) =>
    spawnSync("/bin/bash", [path.join(deploy, "start-pi.sh")], {
      cwd: root,
      env: { HOME: root, PATH: "/usr/bin:/bin", PI_REMOTE_EXIT_FILE: exitFile, ...extraEnv },
      encoding: "utf8",
    });
  try {
    fs.mkdirSync(deploy, { recursive: true });
    fs.copyFileSync(SRC, path.join(deploy, "start-pi.sh"));
    const pi = path.join(root, "bin", "pi");
    fs.mkdirSync(path.dirname(pi), { recursive: true });
    fs.writeFileSync(pi, "#!/bin/sh\nexit 42\n", { mode: 0o755 });
    fs.writeFileSync(path.join(root, ".env"), `PI_REMOTE_PI_BIN=${pi}\n`, "utf8");

    let r = run();
    assert.equal(r.status, 42, r.stderr);
    assert.equal(fs.readFileSync(exitFile, "utf8").trim(), "42", "正常退出落盘");

    fs.writeFileSync(path.join(root, ".env"), `PI_REMOTE_PI_BIN=${path.join(root, "no-such-pi")}\n`, "utf8");
    fs.rmSync(exitFile);
    r = run();
    assert.equal(r.status, 127);
    assert.equal(fs.readFileSync(exitFile, "utf8").trim(), "127", "找不到 pi 也落盘");

    fs.writeFileSync(pi, "#!/bin/bash\nkill -TERM $$\n", { mode: 0o755 });
    fs.writeFileSync(path.join(root, ".env"), `PI_REMOTE_PI_BIN=${pi}\n`, "utf8");
    fs.rmSync(exitFile);
    r = run();
    assert.equal(r.status, 143, "pi 按信号退出时 shell 拿到的状态");
    assert.equal(fs.readFileSync(exitFile, "utf8").trim(), "143", "信号退出也落盘");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("start-pi.sh：PATH 里没有 pi 时从 ~/.nvm/versions/node/*/bin 按版本序取最新", { skip: process.platform === "win32" }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-startsh-nvm-")));
  const home = path.join(root, "home");
  const out = path.join(root, "nvm-seen.txt");
  try {
    fs.mkdirSync(path.join(root, "deploy"), { recursive: true });
    fs.copyFileSync(SRC, path.join(root, "deploy", "start-pi.sh"));
    const mk = (version, label) => {
      const dir = path.join(home, ".nvm", "versions", "node", version, "bin");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "pi"), `#!/bin/sh\nprintf '%s\\n' ${label} > ${JSON.stringify(out)}\nexit 0\n`, { mode: 0o755 });
    };
    mk("v9.1.0", "old");
    mk("v22.23.4", "new");
    fs.writeFileSync(path.join(root, ".env"), "PI_REMOTE_RELAY=ws://nvm:7001\n", "utf8");
    const r = spawnSync("/bin/bash", [path.join(root, "deploy", "start-pi.sh")], {
      cwd: root,
      env: { HOME: home, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(out, "utf8").trim(), "new", "按版本号而不是字典序取最新");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const ATTACH_SH = path.join(__dirname, "..", "deploy", "attach.sh");

test("attach.sh：经软链调用也找得到 attach.cjs，参数原样交给 node", { skip: process.platform === "win32" }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-attachsh-")));
  try {
    const out = path.join(root, "node-seen.txt");
    fakeNodePair(path.join(root, "nodebin"), out);
    fs.mkdirSync(path.join(root, "bin"));
    fs.symlinkSync(ATTACH_SH, path.join(root, "bin", "pi-attach"));
    const r = spawnSync("/bin/sh", [path.join(root, "bin", "pi-attach"), "--pair", "ABCD-EFGH", "a b"], {
      env: { HOME: root, PATH: `${path.join(root, "nodebin")}:/usr/bin:/bin` },
      encoding: "utf8",
    });
    assert.equal(r.status, 5, r.stderr);
    const seen = fs.readFileSync(out, "utf8").split("\n");
    assert.deepEqual(seen.slice(1, 5), [fs.realpathSync(path.join(__dirname, "..", "deploy", "attach.cjs")), "--pair", "ABCD-EFGH", "a b"]);
    assert.equal(fs.readFileSync(ATTACH_SH, "utf8").includes("\r"), false);
    assert.ok(fs.statSync(ATTACH_SH).mode & 0o111, "要有可执行位");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("attach.sh：PATH 里没有 node 时从 ~/.nvm/versions/node/*/bin 按版本序取最新", { skip: process.platform === "win32" }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-attachsh-nvm-")));
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
    // 只保留 shell 脚本自己要用的工具，PATH 里没有 node（模拟 launchd / cron）
    const tools = path.join(root, "tools");
    fs.mkdirSync(tools);
    for (const name of ["readlink", "dirname", "awk", "sort", "tail"]) {
      const src = [`/usr/bin/${name}`, `/bin/${name}`].find((p) => fs.existsSync(p));
      assert.ok(src, "测试机缺少 " + name);
      fs.symlinkSync(src, path.join(tools, name));
    }
    const r = spawnSync("/bin/sh", [ATTACH_SH, "--pair", "ABCD-EFGH"], {
      env: { HOME: home, PATH: tools },
      encoding: "utf8",
    });
    assert.equal(r.status, 5, r.stderr);
    const seen = fs.readFileSync(out, "utf8").trim().split("\n");
    assert.equal(seen[0], "new", "按版本号而不是字典序取最新");
    assert.equal(seen[1], path.join(__dirname, "..", "deploy", "attach.cjs"));
    assert.deepEqual(seen.slice(2), ["--pair", "ABCD-EFGH"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const SYNC_SH = path.join(__dirname, "..", "deploy", "sync-extension.sh");
const EXT_SRC = path.join(__dirname, "..", "extension", "pi-remote-sync.ts");

test("sync-extension.sh：拷到 PI_CODING_AGENT_DIR/extensions 并校验；已软链到源码时不动；失败不留临时文件", { skip: process.platform === "win32" }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-syncsh-")));
  const run = () => spawnSync("/bin/bash", [SYNC_SH], { env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root, "agent") }, encoding: "utf8" });
  const extDir = path.join(root, "agent", "extensions");
  const dst = path.join(extDir, "pi-remote-sync.ts");
  try {
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /OK 扩展已同步/);
    assert.equal(fs.readFileSync(dst, "utf8"), fs.readFileSync(EXT_SRC, "utf8"));

    fs.rmSync(dst);
    fs.symlinkSync(EXT_SRC, dst);
    const linked = run();
    assert.equal(linked.status, 0, linked.stderr);
    assert.match(linked.stdout, /已链接到源码/);
    assert.equal(fs.lstatSync(dst).isSymbolicLink(), true, "开发用的软链不能被换成副本");

    fs.rmSync(dst);
    fs.chmodSync(extDir, 0o555);
    const denied = run();
    fs.chmodSync(extDir, 0o755);
    if (process.getuid && process.getuid() !== 0) {
      assert.notEqual(denied.status, 0);
      assert.deepEqual(fs.readdirSync(extDir), [], "失败后目录里不留半截文件");
    }
  } finally {
    try { fs.chmodSync(extDir, 0o755); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});
