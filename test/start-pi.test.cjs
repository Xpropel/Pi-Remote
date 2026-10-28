// Windows 本机端脚本测试。
// 静态检查（各平台都跑）：.cmd 只含 ASCII、CRLF 换行，attach.cmd 不回显命令行，sync-extension.ps1 带 BOM。
// start-pi.cmd（仅 Windows）：.env 解析与 attach.cjs 的 parseEnv 对拍（引号、键名空格、值首尾空格、注释、
// 特殊字符），参数里的 ! 原样传给 pi，结束后恢复调用方的代码页。用 PATH 上的假 pi.cmd（与 npm 生成的
// shim 一样用 %* 转发）代替真 pi，在 chcp 936 和 chcp 65001 两种控制台下各跑一遍：结果不能依赖当前控制台代码页。
// attach.cmd、sync-extension.ps1（仅 Windows）：参数与退出码透传；扩展同步认 PI_CODING_AGENT_DIR；
// attach.cmd 显式探测 node（PATH / where / 常见安装位置 / nvm-windows）；sync-extension.ps1 与 .sh 一样保护同文件/软链。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const attach = require("../deploy/attach.cjs");

const DEPLOY = path.join(__dirname, "..", "deploy");
const SRC = path.join(DEPLOY, "start-pi.cmd");
const ATTACH_CMD = path.join(DEPLOY, "attach.cmd");
const SYNC_PS1 = path.join(DEPLOY, "sync-extension.ps1");
const WINDOWS_ONLY = process.platform !== "win32" && "只在 Windows 上跑";

test("start-pi.cmd、attach.cmd 只含 ASCII、CRLF 换行：chcp 65001 后 cmd 按字节偏移重读脚本，多字节注释会被当成命令执行", () => {
  for (const file of [SRC, ATTACH_CMD]) {
    const bytes = fs.readFileSync(file);
    const bad = [...bytes].findIndex((b) => b > 0x7f);
    assert.equal(bad, -1, path.basename(file) + " 第 " + bad + " 字节不是 ASCII");
    const text = bytes.toString("latin1");
    assert.equal((text.match(/(^|[^\r])\n/g) || []).length, 0, path.basename(file) + " 有不带 CR 的换行（.gitattributes 管着 *.cmd eol=crlf）");
  }
});

test("start-pi.cmd 先认 PI_REMOTE_PI_BIN（可执行校验）再 PATH / npm 全局，与 start-pi.sh 同口径", () => {
  const text = fs.readFileSync(SRC, "latin1");
  assert.match(text, /if defined PI_REMOTE_PI_BIN call :resolve_pinned_pi/);
  assert.match(text, /if exist "%PI_REMOTE_PI_BIN%\\"/, "目录不算可执行文件");
  assert.match(text, /PI_EXT/);
  for (const ext of [".exe", ".cmd", ".bat", ".com"]) assert.ok(text.includes(`"${ext}"`), "认 " + ext);
  assert.match(text, /where pi\.cmd/);
  assert.match(text, /where pi\.exe/);
  assert.match(text, /%APPDATA%\\npm\\pi\.cmd/);
  assert.match(text, /%LOCALAPPDATA%\\npm\\pi\.cmd/);
  assert.match(text, /%ProgramFiles%\\nodejs\\pi\.cmd/);
  assert.match(text, /call "%PI_BIN%" %\*/);
  assert.match(text, /exit \/b 127/);
  assert.doesNotMatch(text, /^\s*call pi %\*$/m, "不能再只认 PATH 上的 pi");
});

test("attach.cmd：先显式探测 node（PATH / where / 常见安装位置 / nvm-windows），找不到给可操作错误和 127", () => {
  const text = fs.readFileSync(ATTACH_CMD, "latin1");
  assert.doesNotMatch(text, /^\s*@?node\s+"%~dp0attach\.cjs"/m, "不能只写一行 @node，找不到时只剩系统原始报错");
  assert.match(text, /where node\.exe/);
  assert.match(text, /%ProgramFiles%\\nodejs\\node\.exe/);
  assert.match(text, /%LOCALAPPDATA%\\Programs\\nodejs\\node\.exe/);
  assert.match(text, /NVM_SYMLINK/);
  assert.match(text, /Node\.js 22\.18/);
  assert.match(text, /exit \/b 127/);
});

test("sync-extension.ps1 与 .sh 同口径：同文件/软链不覆盖，先写临时文件再改名", () => {
  const ps = fs.readFileSync(SYNC_PS1, "utf8");
  const sh = fs.readFileSync(path.join(DEPLOY, "sync-extension.sh"), "utf8");
  assert.match(sh, /-ef/, ".sh 用 -ef 判断同一个文件");
  assert.match(ps, /LinkType/, "识别符号链接/硬链接");
  assert.match(ps, /GetFullPath/, "比较解析后的真实路径");
  assert.match(ps, /hardlink list/);
  assert.ok(ps.includes('$tmp = "$dst.tmp.$PID"'), "临时文件与目标同目录");
  assert.ok(ps.includes('Move-Item -LiteralPath $tmp -Destination $dst -Force'));
  assert.ok(ps.includes('Remove-Item -LiteralPath $tmp'), "失败不留半截临时文件");
  assert.doesNotMatch(ps, /Copy-Item -LiteralPath \$src -Destination \$dst -Force/, "不能直接覆盖目标");
});

test("attach.cmd 不回显命令行：用户敲 deploy\\attach.cmd --pair 时只看到 attach 自己的输出", () => {
  const lines = fs.readFileSync(ATTACH_CMD, "latin1").split("\r\n").filter((l) => l.trim());
  assert.ok(lines.length >= 1);
  if (!/^@echo off$/i.test(lines[0])) for (const l of lines) assert.match(l, /^@/, "没有 @echo off 时每行都要以 @ 开头：" + l);
});

test("sync-extension.ps1 是带 BOM 的 UTF-8：Windows PowerShell 5.1 把不带 BOM 的脚本按 ANSI 读，中文会乱码甚至解析失败", () => {
  const bytes = fs.readFileSync(SYNC_PS1);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

// 假 pi 要报告的变量：.env 里出现过的键、写坏的键可能落成的名字、start-pi.cmd 自己的临时变量
const KEYS = [
  "PI_REMOTE_RELAY", "PI_REMOTE_TOKEN", "PI_REMOTE_LABEL", "PI_REMOTE_DEVICE_NAME", "PI_REMOTE_DEVICE_ID",
  "PI_SPACED", "PI_EQ", "PI_REMOTE_EMPTY", "PI_SQ", "PI_SQ_ONE", "PI_PCT", "PI_INDENTED", "PI_DQ_INNER",
  "BAD", "BAD KEY", "#", "_K", "_V", "_KEY", "_KREST",
];
const ENV_LINES = [
  "# 注释行",
  "PI_REMOTE_RELAY=ws://127.0.0.1:7001",
  'PI_REMOTE_TOKEN="tok-123!"',
  "PI_REMOTE_LABEL = a&b|c>d!e ",
  'PI_REMOTE_DEVICE_NAME="我的电脑"',
  "PI_REMOTE_DEVICE_ID = dev-9 ",
  "PI_SPACED = a b c ",
  "PI_EQ=x=y",
  "PI_REMOTE_EMPTY=",
  "PI_SQ=' single q '",
  "PI_SQ_ONE='",
  "PI_PCT=50%off %PATH%",
  "BAD KEY=1",
  "   # PI_INDENTED=1",
  'PI_DQ_INNER=say "hi" now',
  "",
];
// 和 parseEnv 有意不同的地方（start-pi.cmd 头注释里写着）：值里的双引号全部去掉
const KNOWN_DIFF = { PI_DQ_INNER: "say hi now" };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-startpi-"));
  fs.mkdirSync(path.join(root, "deploy"), { recursive: true });
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.copyFileSync(SRC, path.join(root, "deploy", "start-pi.cmd"));
  const out = path.join(root, "pi-seen.json");
  // 假 pi：把收到的环境变量和参数写成 JSON（UTF-8），退出码 3
  fs.writeFileSync(
    path.join(root, "bin", "fakepi.js"),
    [
      `const keys = ${JSON.stringify(KEYS)};`,
      "const env = {}; for (const k of keys) env[k] = process.env[k] === undefined ? null : process.env[k];",
      `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ env, argv: process.argv.slice(2) }), 'utf8');`,
      "process.exit(3);",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(root, "bin", "pi.cmd"), '@node "%~dp0fakepi.js" %*\r\n', "utf8");
  fs.writeFileSync(path.join(root, ".env"), ENV_LINES.join("\r\n"), "utf8");
  return { root, out };
}

function runUnder(cp) {
  const { root, out } = setup();
  try {
    const driver = path.join(root, "drive.cmd");
    fs.writeFileSync(
      driver,
      [
        "@echo off",
        `chcp ${cp} >nul`,
        `call "${path.join(root, "deploy", "start-pi.cmd")}" --flag "fix it!" x "p&q"`,
        "echo EXIT=%ERRORLEVEL%",
        "chcp",
        "",
      ].join("\r\n"),
      "ascii",
    );
    const env = { ...process.env, PATH: path.join(root, "bin") + path.delimiter + process.env.PATH };
    for (const k of Object.keys(env)) if (/^PI_|^BAD$|^_K|^_V$/i.test(k)) delete env[k];
    const run = spawnSync("cmd.exe", ["/d", "/c", driver], { env, encoding: "latin1" });
    const seen = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : null;
    return { run, seen, stdout: run.stdout || "", stderr: run.stderr || "" };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const cp of [936, 65001]) {
  test(`start-pi.cmd（控制台 chcp ${cp}）：.env 与 parseEnv 对拍，特殊字符与 ! 原样，无 stderr，退出码透传，代码页还原`, { skip: WINDOWS_ONLY }, () => {
    const { run, seen, stdout, stderr } = runUnder(cp);
    assert.equal(stderr.trim(), "", "stderr 必须干净：任何一行被当成命令都算回归\n" + stderr);
    assert.doesNotMatch(stdout, /not recognized|is not recognized/i, "没有命令解析失败");
    assert.ok(seen, "假 pi 必须被调用\n" + stdout);
    // parseEnv 把 "BAD KEY" 也当键（attach 只按固定的键名取值，等于没有）；能当环境变量名的才比
    const parsed = attach.parseEnv(ENV_LINES.join("\r\n"));
    for (const k of KEYS) {
      const want = k in KNOWN_DIFF ? KNOWN_DIFF[k] : /^[A-Za-z_]\w*$/.test(k) && parsed[k] ? parsed[k] : null;
      assert.equal(seen.env[k], want, `${k}：start-pi.cmd 和 parseEnv 不一致`);
    }
    // 对拍之外再把关键几条写明，免得 parseEnv 改了这里跟着悄悄变
    assert.equal(seen.env.PI_REMOTE_TOKEN, "tok-123!", "值去引号，! 保留");
    assert.equal(seen.env.PI_REMOTE_LABEL, "a&b|c>d!e", "键名去尾随空格、值去首尾空格，& | > ! 不被执行也不丢");
    assert.equal(seen.env.PI_REMOTE_DEVICE_NAME, "我的电脑", "UTF-8 中文值原样");
    assert.equal(seen.env.PI_SQ, "single q", "成对的单引号去掉，里面再去首尾空格");
    assert.equal(seen.env.PI_SQ_ONE, "'", "只有一个引号不算成对");
    assert.equal(seen.env.PI_PCT, "50%off %PATH%", "% 不被展开");
    assert.equal(seen.env.PI_REMOTE_EMPTY, null, ".env 里留空的键不覆盖（不设置）");
    assert.equal(seen.env.BAD, null, "键名带空格整行跳过，不能只取第一个词");
    assert.equal(seen.env.PI_INDENTED, null, "缩进的注释也是注释");
    assert.equal(seen.env._KEY, null, "临时变量不能漏进 pi 的环境");
    assert.deepEqual(seen.argv, ["--flag", "fix it!", "x", "p&q"], "参数里的 ! 和 & 原样传给 pi");
    assert.match(stdout, /relay=ws:\/\/127\.0\.0\.1:7001/);
    assert.match(stdout, /EXIT=3/, "pi 的退出码透传");
    const m = stdout.match(/(\d+)\s*\.?\s*$/);
    assert.ok(m, "拿不到结束时的代码页\n" + stdout);
    assert.equal(Number(m[1]), cp, "结束后必须还原调用方的代码页");
    assert.equal(run.status, 0);
  });
}

test("start-pi.cmd：PI_REMOTE_PI_BIN 优先（可执行校验），坏路径回落 npm 全局", { skip: WINDOWS_ONLY }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-startpi-bin-"));
  try {
    fs.mkdirSync(path.join(root, "deploy"));
    fs.copyFileSync(SRC, path.join(root, "deploy", "start-pi.cmd"));
    fs.writeFileSync(path.join(root, ".env"), "PI_REMOTE_RELAY=ws://127.0.0.1:7001\r\n", "ascii");
    const pinnedDir = path.join(root, "pinned dir");
    fs.mkdirSync(pinnedDir);
    const pinned = path.join(pinnedDir, "my pi.cmd");
    fs.writeFileSync(pinned, "@echo off\r\necho PINNED\r\nexit /b 7\r\n", "ascii");
    const driver = path.join(root, "drive.cmd");
    fs.writeFileSync(
      driver,
      ["@echo off", `call "${path.join(root, "deploy", "start-pi.cmd")}" --flag`, "echo EXIT=%ERRORLEVEL%", ""].join("\r\n"),
      "ascii",
    );
    const env = { ...process.env, PATH: path.join(process.env.SystemRoot || "C:\\Windows", "system32"), APPDATA: path.join(root, "appdata") };
    for (const k of Object.keys(env)) if (/^PI_/i.test(k)) delete env[k];
    env.PI_REMOTE_PI_BIN = pinned;
    let run = spawnSync("cmd.exe", ["/d", "/c", driver], { env, encoding: "latin1" });
    assert.match(run.stdout, /PINNED/, run.stdout + run.stderr);
    assert.match(run.stdout, /EXIT=7/, "PI_REMOTE_PI_BIN 的退出码透传");
    assert.doesNotMatch(run.stdout, /not an executable file/);

    fs.mkdirSync(path.join(env.APPDATA, "npm"), { recursive: true });
    fs.writeFileSync(path.join(env.APPDATA, "npm", "pi.cmd"), "@echo off\r\necho FALLBACK\r\nexit /b 8\r\n", "ascii");
    env.PI_REMOTE_PI_BIN = path.join(root, "missing.cmd");
    run = spawnSync("cmd.exe", ["/d", "/c", driver], { env, encoding: "latin1" });
    assert.match(run.stdout, /not an executable file/, "坏路径要告警");
    assert.match(run.stdout, /FALLBACK/, "坏路径回落到 %APPDATA%\\npm\\pi.cmd\n" + run.stdout);
    assert.match(run.stdout, /EXIT=8/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("attach.cmd：不回显命令行，参数原样交给 attach.cjs，退出码透传", { skip: WINDOWS_ONLY }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-attachcmd-"));
  try {
    fs.mkdirSync(path.join(root, "deploy"));
    fs.copyFileSync(ATTACH_CMD, path.join(root, "deploy", "attach.cmd"));
    const out = path.join(root, "argv.json");
    fs.writeFileSync(
      path.join(root, "deploy", "attach.cjs"),
      `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(5);\n`,
    );
    // 直接让 cmd 跑 attach.cmd（不经 @echo off 的驱动脚本），回显是开着的，才测得出 @
    const line = `""${path.join(root, "deploy", "attach.cmd")}" --pair "AB CD-2345" x!y"`;
    const run = spawnSync("cmd.exe", ["/d", "/s", "/c", line], { encoding: "latin1", windowsVerbatimArguments: true });
    assert.equal(run.status, 5, "attach.cjs 的退出码透传\n" + run.stdout + run.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), ["--pair", "AB CD-2345", "x!y"]);
    assert.doesNotMatch(run.stdout || "", /attach\.cjs/, "命令行不能被回显出来\n" + run.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sync-extension.ps1：认 PI_CODING_AGENT_DIR；没设时同步到 %USERPROFILE%\\.pi\\agent\\extensions", { skip: WINDOWS_ONLY }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-syncps1-"));
  try {
    fs.mkdirSync(path.join(root, "deploy"));
    fs.mkdirSync(path.join(root, "extension"));
    fs.copyFileSync(SYNC_PS1, path.join(root, "deploy", "sync-extension.ps1"));
    const body = "// 扩展 " + Date.now() + "\n";
    fs.writeFileSync(path.join(root, "extension", "pi-remote-sync.ts"), body, "utf8");
    const home = path.join(root, "home");
    const run = (extra) => {
      const env = { ...process.env };
      for (const k of Object.keys(env)) if (/^PI_CODING_AGENT_DIR$/i.test(k)) delete env[k];
      Object.assign(env, { USERPROFILE: home }, extra);
      return spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "deploy", "sync-extension.ps1")], { env, encoding: "utf8" });
    };

    const agent = path.join(root, "agent dir");
    let r = run({ PI_CODING_AGENT_DIR: agent });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(path.join(agent, "extensions", "pi-remote-sync.ts"), "utf8"), body);
    assert.equal(fs.existsSync(path.join(home, ".pi")), false, "设了 PI_CODING_AGENT_DIR 就不该再写默认目录");

    r = run({});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(path.join(home, ".pi", "agent", "extensions", "pi-remote-sync.ts"), "utf8"), body);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
