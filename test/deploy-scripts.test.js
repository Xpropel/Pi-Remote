// 部署脚本：Windows 的 .ps1 与 macOS / Linux 的 .sh 在服务器上执行的脚本必须逐字相同；
// 占位参数、带 token 的单元文件都要在连接服务器之前拦下（用 PATH 上的假 ssh/scp 证明没连）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEPLOY = path.join(__dirname, "..", "deploy");
const read = (name) => fs.readFileSync(path.join(DEPLOY, name), "utf8").replace(/\r\n/g, "\n");

function psBodies(name) {
  const out = {};
  for (const m of read(name).matchAll(/\$(\w+)Body = @'\n([\s\S]*?)\n'@/g)) out[m[1].toUpperCase()] = m[2];
  return out;
}

function psRelayBodies() {
  return psBodies("deploy-relay.ps1");
}

function shBodies(name) {
  const out = {};
  for (const m of read(name).matchAll(/^IFS= read -r -d '' (\w+)_BODY <<'\1_BODY' \|\| true\n([\s\S]*?)\n\1_BODY$/gm)) out[m[1]] = m[2];
  return out;
}

function psFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `找不到 PowerShell 函数 ${name}`);
  return braceBlockFrom(source, start);
}

function braceBlockFrom(source, start) {
  const open = source.indexOf("{", start);
  assert.ok(open >= 0, "找不到代码块起始 {");
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  assert.fail("PowerShell 代码块没有闭合");
  return "";
}

/**
 * 静态检查 .ps1：BOM、无 CR、here-string 成对，以及字符串/注释以外的括号平衡。
 * 本机没有 PowerShell 时这是保底的结构检查；有 pwsh 时另有 ParseFile 用例。
 */
function assertPs1Structure(name) {
  const src = read(name);
  assert.equal(src.includes("\r"), false, name + " 不能有 CR");
  assert.equal(src.charCodeAt(0), 0xfeff, name + " 需要 UTF-8 BOM（Windows PowerShell 5.1 才会按 UTF-8 读中文）");
  const stack = [];
  const pairs = { ")": "(", "]": "[", "}": "{" };
  let state = "code";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (state === "lineComment") {
      if (ch === "\n") state = "code";
      continue;
    }
    if (state === "blockComment") {
      if (ch === "#" && src[i + 1] === ">") {
        state = "code";
        i++;
      }
      continue;
    }
    if (state === "single") {
      if (ch === "'") {
        if (src[i + 1] === "'") i++;
        else state = "code";
      }
      continue;
    }
    if (state === "double") {
      if (ch === "`") i++;
      else if (ch === '"') state = "code";
      continue;
    }
    if (state === "hereSingle" || state === "hereDouble") {
      const close = state === "hereSingle" ? "'@" : '"@';
      if (ch === "\n" && src.startsWith(close, i + 1)) {
        state = "code";
        i += 2;
      }
      continue;
    }
    if (ch === "#") {
      state = "lineComment";
      continue;
    }
    if (ch === "<" && src[i + 1] === "#") {
      state = "blockComment";
      i++;
      continue;
    }
    if (ch === "'") {
      state = "single";
      continue;
    }
    if (ch === '"') {
      state = "double";
      continue;
    }
    if (ch === "@" && (src[i + 1] === "'" || src[i + 1] === '"')) {
      const quote = src[i + 1];
      assert.equal(src[i + 2], "\n", `${name}: here-string @${quote} 后必须立即换行（位置 ${i}）`);
      state = quote === "'" ? "hereSingle" : "hereDouble";
      i += 2;
      continue;
    }
    if ("([{".includes(ch)) stack.push({ ch, at: i });
    else if (")]}".includes(ch)) {
      const open = stack.pop();
      assert.ok(open, `${name}: 多余的 ${ch}（位置 ${i}）`);
      assert.equal(open.ch, pairs[ch], `${name}: ${ch} 与 ${open.ch} 不匹配（位置 ${i}）`);
    }
  }
  assert.equal(state, "code", `${name}: 结尾还有未闭合的 ${state}`);
  assert.equal(stack.length, 0, `${name}: 未闭合的括号 ${stack.map((x) => x.ch).join("")}`);
}

const hasPwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" }).status === 0;

test("deploy-relay：.sh 与 .ps1 在服务器上跑的脚本逐字相同（含已加固的 RESTART）", () => {
  const ps = psRelayBodies();
  const sh = shBodies("deploy-relay.sh");
  assert.deepEqual(Object.keys(ps).sort(), ["FINALIZE", "PREP", "PROMOTE", "RESTART", "ROLLBACK", "VERIFY"]);
  assert.deepEqual(Object.keys(sh).sort(), Object.keys(ps).sort());
  for (const key of Object.keys(ps)) {
    assert.equal(sh[key], ps[key], key + " 两边不一致");
  }
  // RESTART 的加固必须已经同步到 Windows：失败即退出，不能再 || true 后报假 OK。
  assert.doesNotMatch(ps.RESTART, /\|\| true/, "RESTART 不能再用 || true 吞掉失败");
  const okAt = ps.RESTART.indexOf('echo "OK code_owned_by_root"');
  assert.ok(okAt > 0);
  assert.ok(ps.RESTART.lastIndexOf("FAIL perms_") < okAt, "OK 只能出现在所有权限步骤之后");
});

test("deploy-web：.sh 的四个远端脚本与 .ps1 逐字相同", () => {
  const ps = psBodies("deploy-web.ps1");
  const sh = shBodies("deploy-web.sh");
  assert.deepEqual(Object.keys(ps).sort(), ["PERMS", "RESTORE", "SNAPSHOT", "WEB"]);
  assert.deepEqual(Object.keys(sh).sort(), Object.keys(ps).sort());
  for (const key of Object.keys(ps)) {
    assert.equal(sh[key], ps[key], key + " 两边不一致");
  }
  // 防回退：Windows 也必须部署前快照、失败还原、覆盖懒加载 chunk 的可读权限。
  assert.match(ps.SNAPSHOT, /cp -a web web\.prev/);
  assert.match(ps.RESTORE, /mv "\$src" web/);
  assert.match(ps.PERMS, /chmod -R a\+rX,go-w web/);
  assert.match(ps.PERMS, /find web -type f -not -perm -004 -print/);
  assert.match(ps.PERMS, /find web -type d -not -perm -001 -print/);
});

test("PowerShell 部署脚本：BOM、here-string、括号/引号平衡（无 pwsh 时的静态语法检查）", () => {
  for (const name of ["deploy-relay.ps1", "deploy-web.ps1"]) assertPs1Structure(name);
});

test("PowerShell 部署脚本：有 pwsh 时用 ParseFile 验证语法", { skip: !hasPwsh }, () => {
  for (const name of ["deploy-relay.ps1", "deploy-web.ps1"]) {
    const file = path.join(DEPLOY, name).replace(/'/g, "''");
    const command =
      "$tokens = $null; $errors = $null; " +
      `[System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$tokens, [ref]$errors) | Out-Null; ` +
      "if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }";
    const r = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8" });
    assert.equal(r.status, 0, name + ": " + r.stdout + r.stderr);
  }
});

test("PowerShell 内嵌的远端脚本：here-string 完整且 bash -n 通过", { skip: process.platform === "win32" }, () => {
  const expected = {
    "deploy-relay.ps1": ["FINALIZE", "PREP", "PROMOTE", "RESTART", "ROLLBACK", "VERIFY"],
    "deploy-web.ps1": ["PERMS", "RESTORE", "SNAPSHOT", "WEB"],
  };
  for (const [name, keys] of Object.entries(expected)) {
    const bodies = psBodies(name);
    assert.deepEqual(Object.keys(bodies).sort(), keys);
    for (const [key, body] of Object.entries(bodies)) {
      assert.ok(body.length > 0, `${name} ${key} 的 body 不能为空`);
      const r = spawnSync("/bin/bash", ["-n"], { input: body, encoding: "utf8" });
      assert.equal(r.status, 0, `${name} ${key}: ${r.stderr}`);
    }
  }
});

test("deploy-relay.ps1：RESTART 失败不打印 OK，验证失败自动回滚并 exit 1", () => {
  const src = read("deploy-relay.ps1");
  const ps = psRelayBodies();
  assert.equal(ps.RESTART, shBodies("deploy-relay.sh").RESTART, "RESTART 必须与 .sh 同步");
  assert.doesNotMatch(ps.RESTART, /\|\| true/);
  assert.match(ps.RESTART, /chmod 600 "\$envfile" \|\| \{ echo "FAIL perms_env_mode \$envfile"; exit 1; \}/);
  assert.match(ps.RESTART, /chown root:root "\$app" \|\| \{ echo "FAIL perms_app_owner \$app"; exit 1; \}/);
  assert.match(ps.RESTART, /systemctl restart pi-remote\.service/);
  const okAt = ps.RESTART.indexOf('echo "OK code_owned_by_root"');
  assert.ok(okAt > 0);
  assert.ok(ps.RESTART.lastIndexOf("FAIL perms_") < okAt, "失败退出必须发生在假 OK 之前");

  const auto = psFunction(src, "Invoke-AutoRollback");
  assert.match(auto, /Invoke-RemoteBash \$rollbackBody/, "自动回滚必须真正执行 ROLLBACK body");
  assert.match(auto, /Invoke-RemoteBash \$verifyBody/, "回滚后要重新做回环验证");
  assert.match(auto, /Get-LoopbackCode \$verifyResult/);
  assert.match(auto, /if \(\$verifyResult\.Exit -ne 0 -or \$code -ne "200"\)/, "回滚后只要求 200");
  assert.match(auto, /exit 1/);

  const restartAt = src.indexOf("$restartResult = Invoke-RemoteBash $restartBody");
  const restartIf = src.indexOf("if ($restartResult.Exit -ne 0)", restartAt);
  assert.ok(restartAt > 0 && restartIf > restartAt, "重启结果必须检查 Exit");
  const restartBlock = braceBlockFrom(src, restartIf);
  assert.match(restartBlock, /Invoke-AutoRollback "服务重启或权限归一化失败"/, "重启失败要自动回滚");
  assert.doesNotMatch(restartBlock, /DONE\. relay 已更新/, "失败路径不能打印成功");

  const verifyAt = src.indexOf("$verifyResult = Invoke-RemoteBash", restartAt);
  const verifyIf = src.indexOf("if ($verifyResult.Exit -ne 0 -or $verifyCode -ne \"200\")", verifyAt);
  assert.ok(verifyAt > restartAt && verifyIf > verifyAt, "端口验证结果必须检查 Exit 和 HTTP 200");
  const verifyBlock = braceBlockFrom(src, verifyIf);
  assert.match(verifyBlock, /Invoke-AutoRollback "端口验证失败/, "验证失败要自动回滚");
  assert.match(verifyBlock, /wantProto/, "失败信息要带上目标协议版本");
  assert.doesNotMatch(verifyBlock, /DONE\. relay 已更新/, "验证失败不能打印成功");
  assert.ok(src.indexOf("Write-RemoteReport (Invoke-RemoteBash $finalizeBody)") > verifyIf);
});

test("deploy-web.ps1：快照/还原/权限检查与 .sh 同源，失败和验证失败都自动还原", () => {
  const src = read("deploy-web.ps1");
  const ps = psBodies("deploy-web.ps1");
  const sh = shBodies("deploy-web.sh");
  for (const key of ["SNAPSHOT", "RESTORE", "PERMS", "WEB"]) {
    assert.equal(ps[key], sh[key], key + " 必须与 .sh 同步");
  }
  const restore = psFunction(src, "Restore-Web");
  assert.match(restore, /Invoke-WebRemote \$restoreBody/, "还原必须执行 RESTORE body");
  assert.match(restore, /Invoke-WebRemote \$permsBody/, "还原后要补一次可读权限");
  assert.match(restore, /web\.prev/, "提示里要说明 web.prev 回滚位置");

  const snapshotAt = src.indexOf("$snapshotResult = Invoke-WebRemote $snapshotBody");
  const webAt = src.indexOf("$webResult = Invoke-WebRemote $webBody");
  const permsAt = src.indexOf("$permsResult = Invoke-WebRemote $permsBody", webAt);
  assert.ok(snapshotAt > 0, "部署前必须先快照");
  assert.ok(webAt > snapshotAt, "快照成功后才解压/切换");
  assert.ok(permsAt > webAt, "切换后才做权限归一化");

  const webIf = src.indexOf("if ($webResult.Exit -ne 0)", webAt);
  const webBlock = braceBlockFrom(src, webIf);
  assert.match(webBlock, /Restore-Web \| Out-Null/, "解压/切换失败要还原");
  assert.match(webBlock, /throw "部署失败：已尝试还原上一版/);

  const permsIf = src.indexOf("if ($permsResult.Exit -ne 0)", permsAt);
  const permsBlock = braceBlockFrom(src, permsIf);
  assert.match(permsBlock, /Restore-Web \| Out-Null/, "权限失败要还原");
  assert.match(permsBlock, /throw "部署失败：已尝试还原上一版/);

  // 懒加载 chunk：从本地构建产物抽一个非 index-* 的 chunk，并纳入远端 HTTP 验证
  assert.match(src, /Where-Object \{ \$_.Name -like "\*\.js" -and \$_.Name -notlike "index-\*" \}/);
  assert.match(src, /\$paths \+= "\/assets\/\$lazy"/, "懒加载 chunk 必须加入验证地址");

  const failedAt = src.indexOf("if ($failed -ne 0)");
  const failedBlock = braceBlockFrom(src, failedAt);
  assert.match(failedBlock, /Restore-Web \| Out-Null/, "验证失败要还原");
  assert.match(failedBlock, /throw "\$failed 个地址验证失败；已尝试还原上一版/);
  assert.ok(src.indexOf('Write-Host "DONE. 打开') > failedAt, "DONE 只能在验证通过后打印");
});

test("deploy-relay 回环验证：部署时旧版首页的 200 不算数，回滚时照旧认首页", { skip: process.platform === "win32" }, (t) => {
  const body = shBodies("deploy-relay.sh").VERIFY;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-verify-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "bin"));
  // 假 curl：/healthz 回 $HEALTH（旧版 relay 在这里回的是首页），看首页的一律 200；假 sleep 不等
  fs.writeFileSync(path.join(dir, "bin", "curl"), '#!/bin/sh\ncase "$*" in\n  *healthz*) printf "%s" "$HEALTH" ;;\n  *) printf 200 ;;\nesac\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "bin", "sleep"), "#!/bin/sh\n", { mode: 0o755 });
  const run = (prefix, health) =>
    spawnSync("/bin/bash", ["-c", prefix + body], {
      env: { ...process.env, PATH: path.join(dir, "bin") + path.delimiter + process.env.PATH, HEALTH: health },
      encoding: "utf8",
    });
  const v4 = '{"ok":true,"proto":4,"version":"4.0.0","uptimeSec":3}';
  const oldIndex = "<!doctype html><html><body><div id=\"root\"></div></body></html>";

  let r = run("want_proto=4\n", v4);
  assert.match(r.stdout, /^HTTP_CODE=200$/m);
  assert.match(r.stdout, /^OK healthz_proto=4$/m);

  r = run("want_proto=4\n", oldIndex);
  assert.match(r.stdout, /^FAIL healthz_proto_not_4$/m);
  assert.notEqual(r.status, 0);

  r = run("want_proto=40\n", v4);
  assert.match(r.stdout, /^FAIL healthz_proto_not_40$/m, "4 不能当成 40");

  r = run("", oldIndex);
  assert.match(r.stdout, /^HTTP_CODE=200$/m);
  assert.doesNotMatch(r.stdout, /healthz_proto/);
});

const SH_SCRIPTS = ["start-pi.sh", "attach.sh", "sync-extension.sh", "deploy-relay.sh", "deploy-web.sh", "linux/push.sh"];

test("shell 脚本：LF、可执行、bash 3.2 语法通过", { skip: process.platform === "win32" }, () => {
  for (const name of SH_SCRIPTS) {
    const file = path.join(DEPLOY, name);
    assert.equal(fs.readFileSync(file, "utf8").includes("\r"), false, name + " 不能有 CR");
    assert.ok(fs.statSync(file).mode & 0o111, name + " 要有可执行位");
    const r = spawnSync("/bin/bash", ["-n", file], { encoding: "utf8" });
    assert.equal(r.status, 0, name + ": " + r.stderr);
  }
});

test("POSIX sh 脚本：sh -n 语法通过", { skip: process.platform === "win32" }, () => {
  for (const name of ["attach.sh", "linux/device.sh"]) {
    const r = spawnSync("/bin/sh", ["-n", path.join(DEPLOY, name)], { encoding: "utf8" });
    assert.equal(r.status, 0, name + ": " + r.stderr);
  }
});

/** 拷一份 deploy/ + relay/ 到临时目录，PATH 前面放会记账的假 ssh / scp / npm / curl */
function sandbox(unitText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deploy-sh-"));
  fs.mkdirSync(path.join(root, "deploy"));
  fs.mkdirSync(path.join(root, "relay"));
  fs.mkdirSync(path.join(root, "bin"));
  for (const name of ["deploy-relay.sh", "deploy-web.sh", "verify.html"]) {
    fs.copyFileSync(path.join(DEPLOY, name), path.join(root, "deploy", name));
    fs.chmodSync(path.join(root, "deploy", name), 0o755);
  }
  fs.writeFileSync(path.join(root, "deploy", "pi-remote.service"), unitText ?? read("pi-remote.service"), "utf8");
  fs.writeFileSync(path.join(root, "deploy", "known_hosts"), "", "utf8");
  for (const f of ["server.js", "store.js", "index.js", "protocol.json"]) fs.writeFileSync(path.join(root, "relay", f), "// x\n", "utf8");
  const calls = path.join(root, "calls.log");
  for (const tool of ["ssh", "scp", "npm", "curl"]) {
    fs.writeFileSync(path.join(root, "bin", tool), `#!/bin/sh\necho "${tool} $*" >> '${calls}'\nexit 1\n`, { mode: 0o755 });
  }
  const run = (script, args) => {
    const r = spawnSync("/bin/bash", [path.join(root, "deploy", script), ...args], {
      env: { ...process.env, PATH: path.join(root, "bin") + path.delimiter + process.env.PATH },
      encoding: "utf8",
    });
    const log = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "";
    return { ...r, calls: log };
  };
  return { root, run };
}

test("占位参数：不构建、不连接服务器，直接报错", { skip: process.platform === "win32" }, (t) => {
  const box = sandbox();
  t.after(() => fs.rmSync(box.root, { recursive: true, force: true }));
  for (const [script, args] of [
    ["deploy-relay.sh", []],
    ["deploy-relay.sh", ["--server", "root@<你的服务器IP>"]],
    ["deploy-relay.sh", ["--server", "root@<你的服务器IP>", "--rollback"]],
    ["deploy-relay.sh", ["--server", "has space@host"]],
    ["deploy-web.sh", []],
    ["deploy-web.sh", ["--server", "root@1.2.3.4", "--viewer-base", "http://1.2.3.4:7002/?token=x"]],
  ]) {
    const r = box.run(script, args);
    assert.notEqual(r.status, 0, script + " " + args.join(" "));
    assert.equal(r.calls, "", "没有调用 ssh/scp/npm/curl：" + r.calls);
  }
});

test("单元文件写了 token 或打开了正文持久化：上传前拒绝，不连服务器", { skip: process.platform === "win32" }, (t) => {
  const base = read("pi-remote.service");
  for (const extra of [
    'Environment="PI_REMOTE_LOCAL_TOKEN=abc"',
    "Environment=PI_REMOTE_VIEWER_TOKEN=abc",
    "Environment=PI_REMOTE_PERSIST_TRANSCRIPTS=1",
  ]) {
    const box = sandbox(base.replace("[Install]", extra + "\n\n[Install]"));
    t.after(() => fs.rmSync(box.root, { recursive: true, force: true }));
    const r = box.run("deploy-relay.sh", ["--server", "root@1.2.3.4"]);
    assert.notEqual(r.status, 0, extra);
    assert.match(r.stderr, /拒绝上传/, extra);
    assert.equal(r.calls, "", extra);
  }
  const ok = sandbox(base);
  t.after(() => fs.rmSync(ok.root, { recursive: true, force: true }));
  const r = ok.run("deploy-relay.sh", ["--server", "root@1.2.3.4"]);
  assert.match(r.calls, /^ssh /m, "单元干净时才会去连服务器（假 ssh 返回失败，脚本随即停下）");
  assert.notEqual(r.status, 0);
});

function makeTemp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeExec(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function makeBin(dir, scripts) {
  const bin = path.join(dir, "bin");
  for (const [name, text] of Object.entries(scripts)) writeExec(path.join(bin, name), text);
  return bin;
}

function runBody(body, env, args = []) {
  return spawnSync("/bin/bash", ["-c", body, "--", ...args], { env, encoding: "utf8" });
}

test("deploy-relay RESTART（.sh 与 .ps1 同一 body）：权限归一化不再 || true，失败退出非零且不打印假 OK", { skip: process.platform === "win32" }, (t) => {
  const body = psRelayBodies().RESTART;
  assert.equal(body, shBodies("deploy-relay.sh").RESTART, "Windows 的 RESTART 必须与 .sh 同步");
  assert.doesNotMatch(body, /\|\| true/, "权限/身份归一化不能再用 || true 吞掉失败");
  for (const name of [
    "FAIL perms_env_mode",
    "FAIL perms_unit_mode",
    "FAIL perms_app_owner",
    "FAIL perms_tree_owner",
    "FAIL perms_norm_dir",
    "FAIL perms_norm_script",
    "FAIL perms_norm_exec",
    "FAIL perms_norm_file",
    "FAIL perms_data_owner",
    "FAIL perms_config_mode",
  ]) {
    assert.match(body, new RegExp(name), name);
  }
  const okAt = body.indexOf('echo "OK code_owned_by_root"');
  assert.ok(okAt > 0);
  assert.ok(body.lastIndexOf("FAIL perms_") < okAt, "OK 只能出现在所有权限步骤之后");

  const dir = makeTemp(t, "pi-restart-");
  const app = path.join(dir, "app");
  fs.mkdirSync(path.join(app, "data", "accounts"), { recursive: true });
  fs.mkdirSync(path.join(app, "data", "rooms"), { recursive: true });
  fs.mkdirSync(path.join(app, "logs"), { recursive: true });
  fs.mkdirSync(path.join(app, "relay"), { recursive: true });
  fs.writeFileSync(path.join(app, "relay", "config.json"), '{"localToken":"x","viewerToken":"y"}\n');
  const envFile = path.join(dir, "pi-remote.env");
  fs.writeFileSync(envFile, "PI_REMOTE_LOCAL_TOKEN=x\nPI_REMOTE_VIEWER_TOKEN=y\n");
  fs.chmodSync(envFile, 0o644);
  const unit = path.join(dir, "pi-remote.service");
  fs.writeFileSync(unit, "[Unit]\nDescription=test\n");
  const bin = makeBin(dir, {
    chown: '#!/bin/sh\nif [ "${FAIL_CHOWN:-0}" = 1 ]; then echo "chown: simulated failure" >&2; exit 1; fi\nexit 0\n',
    useradd: "#!/bin/sh\nexit 0\n",
    "id": "#!/bin/sh\nexit 1\n",
    stat: '#!/bin/sh\nif [ "$1" = "-c" ]; then printf "600\\n"; exit 0; fi\nexec /usr/bin/stat "$@"\n',
    systemctl: '#!/bin/sh\n[ "$1" = "is-active" ] && echo active\nexit 0\n',
    sleep: "#!/bin/sh\nexit 0\n",
    find: "#!/bin/sh\nexit 0\n",
  });
  const env = {
    ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    PI_REMOTE_APP_DIR: app,
    PI_REMOTE_ENV_FILE: envFile,
    PI_REMOTE_UNIT_FILE: unit,
    PI_REMOTE_DROPIN_FILE: path.join(dir, "no-dropin.conf"),
    FAIL_CHOWN: "0",
  };
  let r = runBody(body, env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^OK code_owned_by_root$/m);
  assert.equal((fs.statSync(envFile).mode & 0o777).toString(8), "600", "ENV 文件必须收紧到 600");
  assert.equal((fs.statSync(unit).mode & 0o777).toString(8), "644");

  r = runBody(body, { ...env, FAIL_CHOWN: "1" });
  assert.notEqual(r.status, 0, "chown 失败必须退出非零");
  assert.match(r.stdout, /^FAIL perms_app_owner /m, "要保留可诊断输出");
  assert.doesNotMatch(r.stdout, /OK code_owned_by_root/, "失败时不能打印假 OK");
  assert.doesNotMatch(r.stdout, /OK service_user/);
});

test("deploy-web（.sh 与 .ps1 同一 body）：旧版快照/失败还原、权限覆盖懒加载 chunk", { skip: process.platform === "win32" }, (t) => {
  const bodies = psBodies("deploy-web.ps1");
  const sh = shBodies("deploy-web.sh");
  for (const key of ["SNAPSHOT", "RESTORE", "PERMS", "WEB"]) {
    assert.equal(bodies[key], sh[key], key + " 必须与 .sh 同步");
  }
  for (const key of ["SNAPSHOT", "RESTORE", "PERMS", "WEB"]) assert.ok(bodies[key], key);
  const src = read("deploy-web.sh");
  const failAt = src.indexOf('if [ "$failed" -ne 0 ]');
  assert.ok(failAt > 0, "验证失败分支应在");
  assert.ok(src.indexOf("restore_web || true", failAt) > failAt, "验证失败要自动还原上一版");
  assert.match(bodies.SNAPSHOT, /cp -a web web\.prev/, "部署前要保留整份旧站");
  assert.match(bodies.PERMS, /chmod -R a\+rX,go-w web/, "web/ 要补 chmod，且覆盖整棵目录");
  assert.match(bodies.PERMS, /assets/, "权限检查要覆盖懒加载 chunk");
  assert.doesNotMatch(bodies.PERMS, /chmod[^\n]*\|\| true/);

  const dir = makeTemp(t, "pi-web-bodies-");
  const app = path.join(dir, "app");
  fs.mkdirSync(path.join(app, "web", "assets"), { recursive: true });
  fs.writeFileSync(path.join(app, "web", "index.html"), "old-index\n");
  fs.writeFileSync(path.join(app, "web", "assets", "lazy-old.js"), "old-chunk\n");
  fs.chmodSync(path.join(app, "web", "assets", "lazy-old.js"), 0o600);
  const env = { ...process.env, PI_REMOTE_APP_DIR: app };
  let r = runBody(bodies.SNAPSHOT, env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK web_prev_kept/);
  assert.equal(fs.readFileSync(path.join(app, "web.prev", "index.html"), "utf8"), "old-index\n");

  // 模拟新版已经切上去：还原必须回到整份旧站
  fs.rmSync(path.join(app, "web"), { recursive: true, force: true });
  fs.mkdirSync(path.join(app, "web", "assets"), { recursive: true });
  fs.writeFileSync(path.join(app, "web", "index.html"), "new-index\n");
  fs.writeFileSync(path.join(app, "web", "assets", "lazy-new.js"), "new-chunk\n");
  r = runBody(bodies.RESTORE, env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK web_restored/);
  assert.equal(fs.readFileSync(path.join(app, "web", "index.html"), "utf8"), "old-index\n");
  assert.equal(fs.existsSync(path.join(app, "web.prev")), false);
  assert.equal(fs.readFileSync(path.join(app, "web.failed", "index.html"), "utf8"), "new-index\n");

  // 权限：懒加载 chunk 也要对 other 可读（目录可进入）
  const bin = makeBin(dir, { chown: "#!/bin/sh\nexit 0\n" });
  r = runBody(bodies.PERMS, { ...env, PATH: bin + path.delimiter + process.env.PATH });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK web_perms/);
  const lazyMode = fs.statSync(path.join(app, "web", "assets", "lazy-old.js")).mode & 0o777;
  assert.equal(lazyMode & 0o044, 0o044, "懒加载 chunk 必须组/其他可读");
  assert.equal(fs.statSync(path.join(app, "web")).mode & 0o111, 0o111, "web 目录必须可进入");
});

test("deploy-relay：验证/重启失败自动回滚，并退出非零", { skip: process.platform === "win32" }, (t) => {
  const dir = makeTemp(t, "pi-relay-rollback-");
  fs.mkdirSync(path.join(dir, "deploy"));
  fs.mkdirSync(path.join(dir, "relay"));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.mkdirSync(path.join(dir, "state"));
  for (const name of ["deploy-relay.sh", "pi-remote.service"]) {
    fs.copyFileSync(path.join(DEPLOY, name), path.join(dir, "deploy", name));
  }
  fs.chmodSync(path.join(dir, "deploy", "deploy-relay.sh"), 0o755);
  fs.writeFileSync(path.join(dir, "deploy", "known_hosts"), "");
  for (const f of ["server.js", "store.js", "index.js"]) fs.writeFileSync(path.join(dir, "relay", f), "// x\n");
  fs.writeFileSync(path.join(dir, "relay", "protocol.json"), '{\n  "proto": 4\n}\n');
  const calls = path.join(dir, "state", "calls.log");
  writeExec(path.join(dir, "bin", "scp"), `#!/bin/sh\necho scp >> '${calls}'\nexit 0\n`);
  const ssh = `#!/bin/bash
root='${dir}'
calls='${calls}'
args="$*"
case "$args" in
  *md5sum*)
    files="\${args##*md5sum }"
    for f in $files; do
      if command -v md5sum >/dev/null 2>&1; then h=$(md5sum "$root/relay/$f" | cut -d' ' -f1); else h=$(md5 -q "$root/relay/$f"); fi
      printf '%s  %s\\n' "$h" "$f"
    done
    exit 0
    ;;
esac
body=$(cat)
case "$body" in
  *staging_ready*)
    echo prep >> "$calls"
    printf 'OK staging_ready\\nOK data_accounts_kept\\n'
    ;;
  *promoted*)
    echo promote >> "$calls"
    printf 'OK promoted\\n'
    ;;
  *code_owned_by_root*)
    echo restart >> "$calls"
    if [ "\${RESTART_FAILS:-0}" = 1 ]; then
      printf 'FAIL perms_app_owner /opt/pi-remote/app\\n'
      exit 1
    fi
    printf 'OK code_owned_by_root\\nOK service_user\\nactive\\n'
    ;;
  *rollback_from*)
    echo rollback >> "$calls"
    printf 'OK rollback_from relay.cur\\nOK data_accounts_kept\\nactive\\n'
    ;;
  *HTTP_CODE*)
    echo verify >> "$calls"
    if [ "\${VERIFY_FAILS:-0}" = 1 ]; then
      case "$body" in
        *want_proto=4*)
          printf 'HTTP_CODE=200\\nFAIL healthz_proto_not_4\\n'
          exit 1
          ;;
      esac
    fi
    printf 'HTTP_CODE=200\\nOK data_accounts_kept\\n'
    ;;
  *)
    echo unknown >> "$calls"
    exit 1
    ;;
esac
`;
  writeExec(path.join(dir, "bin", "ssh"), ssh);
  const run = (flags, extra = []) =>
    spawnSync("/bin/bash", [path.join(dir, "deploy", "deploy-relay.sh"), "--server", "root@1.2.3.4", ...extra], {
      env: { ...process.env, PATH: path.join(dir, "bin") + path.delimiter + process.env.PATH, ...flags },
      encoding: "utf8",
    });
  const callList = () =>
    (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : []).filter((x) => x && x !== "scp");
  fs.writeFileSync(calls, "");

  // 1) 权限归一化/重启失败：自动回滚，不能把坏版本留在线上
  let r = run({ RESTART_FAILS: "1", VERIFY_FAILS: "0" });
  assert.notEqual(r.status, 0, "部署失败必须退出非零");
  assert.deepEqual(callList(), ["prep", "promote", "restart", "rollback", "verify"]);
  assert.match(r.stdout, /自动回滚/, "要明确提示自动回滚");
  assert.match(r.stdout, /已自动回滚到部署前版本/);
  assert.doesNotMatch(r.stdout, /DONE\. relay 已更新/, "失败不能打印成功");

  // 2) 新版起来但 /healthz 协议不对：同样自动回滚
  fs.writeFileSync(calls, "");
  r = run({ RESTART_FAILS: "0", VERIFY_FAILS: "1" });
  assert.notEqual(r.status, 0);
  assert.deepEqual(callList(), ["prep", "promote", "restart", "verify", "rollback", "verify"]);
  assert.match(r.stdout, /端口验证失败/);
  assert.match(r.stdout, /已自动回滚到部署前版本/);
  assert.doesNotMatch(r.stdout, /DONE\. relay 已更新/);

  // 3) 手动 --rollback 仍是独立路径：不应受自动回滚逻辑影响
  fs.writeFileSync(calls, "");
  r = run({ RESTART_FAILS: "0", VERIFY_FAILS: "0" }, ["--rollback"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(callList(), ["rollback", "verify"]);
  assert.match(r.stdout, /DONE\. relay 代码已回滚并重启/);
});

test("linux/push.sh：暂存目录构建后原子切换，失败保留旧版", { skip: process.platform === "win32" }, (t) => {
  const body = shBodies("linux/push.sh").PUSH;
  assert.ok(body);
  assert.match(body, /staging="\$\{dir\}\.new\.\$\$"/, "要先解到独立暂存目录");
  assert.match(body, /as_user tar -xf - -C "\$staging"/, "解包不能直接写正式目录");
  assert.doesNotMatch(body, /as_user tar -xf - -C "\$dir"/, "不能在正式目录原地解包");
  assert.match(body, /npm ci/, "依赖在暂存目录装");
  assert.match(body, /mv "\$dir" "\$dir\.prev"/, "切换前保留旧版");
  assert.match(body, /mv "\$staging" "\$dir"/, "暂存目录整体改名成正式目录");
  assert.match(body, /trap 'rm -f "\$tar_in"; rm -rf "\$staging"' EXIT/, "失败要清理暂存目录");

  const dir = makeTemp(t, "pi-push-body-");
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const target = path.join(home, "pi-remote");
  fs.mkdirSync(path.join(target, "deploy"), { recursive: true });
  fs.writeFileSync(path.join(target, "version.txt"), "old\n");
  fs.writeFileSync(path.join(target, ".env"), "PI_REMOTE_RELAY=ws://old\n");
  fs.chmodSync(path.join(target, ".env"), 0o644);
  writeExec(path.join(target, "deploy", "sync-extension.sh"), "#!/bin/sh\nexit 0\n");

  const kit = path.join(dir, "kit");
  fs.mkdirSync(path.join(kit, "deploy", "linux"), { recursive: true });
  fs.writeFileSync(path.join(kit, "version.txt"), "new\n");
  fs.writeFileSync(path.join(kit, "package.json"), "{}\n");
  fs.writeFileSync(path.join(kit, "package-lock.json"), "{}\n");
  writeExec(path.join(kit, "deploy", "sync-extension.sh"), "#!/bin/sh\nexit 0\n");
  fs.writeFileSync(path.join(kit, "deploy", "linux", "device.cjs"), "// stub\n");
  const tarPath = path.join(home, "pi-remote-device-kit.tar");
  const tar = spawnSync("tar", ["-cf", tarPath, "-C", kit, "."], { encoding: "utf8" });
  assert.equal(tar.status, 0, tar.stderr);

  const bin = makeBin(dir, {
    npm: '#!/bin/sh\nif [ "${FAIL_NPM:-0}" = 1 ]; then exit 1; fi\nexit 0\n',
    node: "#!/bin/sh\nexit 0\n",
  });
  const user = os.userInfo().username;
  // 以普通用户跑时顺便验证默认拒绝 root；CI 本身是 root 时用 --allow-root 等价开关继续跑完整流程
  const allowRoot = user === "root" ? "1" : "0";
  const env = {
    ...process.env,
    HOME: home,
    PATH: bin + path.delimiter + process.env.PATH,
    FAIL_NPM: "0",
  };

  // 成功：正式目录整体换成新版，旧版留在 .prev/，.env 原位保留并收紧 600
  let r = runBody(body, env, [user, target, allowRoot]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(fs.readFileSync(path.join(target, "version.txt"), "utf8"), "new\n");
  assert.equal(fs.readFileSync(path.join(target, ".env"), "utf8"), "PI_REMOTE_RELAY=ws://old\n");
  assert.equal((fs.statSync(path.join(target, ".env")).mode & 0o777).toString(8), "600");
  assert.equal(fs.readFileSync(path.join(home, "pi-remote.prev", "version.txt"), "utf8"), "old\n");
  assert.match(r.stdout, /OK swapped /);
  assert.match(r.stdout, /OK done /);

  // npm 失败：旧目录原封不动，不能留下新旧混合
  fs.rmSync(path.join(home, "pi-remote.prev"), { recursive: true, force: true });
  fs.rmSync(path.join(target, "version.txt"));
  fs.writeFileSync(path.join(target, "version.txt"), "old\n");
  fs.chmodSync(path.join(target, ".env"), 0o644);
  // 上一轮结束时 PUSH_BODY 的 EXIT trap 删掉了 $HOME 里的 tar 包，重跑前重新打包
  const tar2 = spawnSync("tar", ["-cf", tarPath, "-C", kit, "."], { encoding: "utf8" });
  assert.equal(tar2.status, 0, tar2.stderr);
  r = runBody(body, { ...env, FAIL_NPM: "1" }, [user, target, allowRoot]);
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(path.join(target, "version.txt"), "utf8"), "old\n", "失败后旧版必须还在");
  assert.equal(fs.existsSync(path.join(home, "pi-remote.prev")), false, "失败时不应换版");
  assert.equal((fs.statSync(path.join(target, ".env")).mode & 0o777).toString(8), "644", "失败不能改旧 .env");
  assert.match(r.stdout, /FAIL npm_ci /);
  assert.deepEqual(fs.readdirSync(home).filter((n) => n.startsWith("pi-remote.new.")), [], "暂存目录要清理");

  // 扩展同步是切换后的最后一步：它失败必须把旧套件换回来，而不是把新版留在线上
  writeExec(path.join(kit, "deploy", "sync-extension.sh"), "#!/bin/sh\nexit 1\n");
  const tar3 = spawnSync("tar", ["-cf", tarPath, "-C", kit, "."], { encoding: "utf8" });
  assert.equal(tar3.status, 0, tar3.stderr);
  r = runBody(body, { ...env, FAIL_NPM: "0" }, [user, target, allowRoot]);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /FAIL extension_sync/);
  assert.match(r.stdout, /OK restored /);
  assert.equal(fs.readFileSync(path.join(target, "version.txt"), "utf8"), "old\n", "扩展失败要恢复旧版");
  assert.equal(fs.readFileSync(path.join(home, "pi-remote.failed", "version.txt"), "utf8"), "new\n", "新版留在 .failed/");
});

test("deploy-relay RESTART: a 600/700 tree is normalized, node_modules untouched, scripts stay executable", { skip: process.platform === "win32" }, (t) => {
  const body = psRelayBodies().RESTART;
  assert.equal(body, shBodies("deploy-relay.sh").RESTART, "RESTART must stay in sync with .sh");
  // The normalization must prune node_modules: rewriting its modes once
  // stripped the exec bits from its .bin shims and broke the build.
  assert.match(body, /-name node_modules/, "normalization must exclude node_modules");
  assert.match(body, /FAIL perms_norm_dir/);
  assert.match(body, /FAIL perms_norm_file/);

  const mode = (p) => fs.statSync(p).mode & 0o777;
  const dir = makeTemp(t, "pi-restart-norm-");
  const app = path.join(dir, "app");
  fs.mkdirSync(path.join(app, "data", "accounts"), { recursive: true });
  fs.mkdirSync(path.join(app, "data", "rooms"), { recursive: true });
  fs.mkdirSync(path.join(app, "logs"), { recursive: true });
  fs.mkdirSync(path.join(app, "relay", "sub"), { recursive: true });
  fs.mkdirSync(path.join(app, "node_modules", "ws"), { recursive: true });
  fs.mkdirSync(path.join(app, "node_modules", ".bin"), { recursive: true });
  // Simulate a tree copied from a macOS working copy: files 600, dirs 700.
  const put = (rel, m) => {
    const p = path.join(app, rel);
    fs.writeFileSync(p, "x\n");
    fs.chmodSync(p, m);
    return p;
  };
  const serverJs = put(path.join("relay", "server.js"), 0o600);
  const subDir = path.join(app, "relay", "sub");
  const storeJs = put(path.join("relay", "sub", "store.js"), 0o600);
  fs.chmodSync(subDir, 0o700);
  const startSh = put("start.sh", 0o600);
  const toolBin = put("toolbin", 0o700);
  const pkgJson = put("package.json", 0o600);
  const nmFile = put(path.join("node_modules", "ws", "index.js"), 0o600);
  const nmShim = put(path.join("node_modules", ".bin", "shim"), 0o755);
  const dataFile = put(path.join("data", "rooms", "index.json"), 0o644);
  const cfg = path.join(app, "relay", "config.json");
  fs.writeFileSync(cfg, '{"localToken":"x","viewerToken":"y"}\n');
  fs.chmodSync(cfg, 0o600);
  const envFile = path.join(dir, "pi-remote.env");
  fs.writeFileSync(envFile, "PI_REMOTE_LOCAL_TOKEN=x\nPI_REMOTE_VIEWER_TOKEN=y\n");
  fs.chmodSync(envFile, 0o644);
  const unit = path.join(dir, "pi-remote.service");
  fs.writeFileSync(unit, "[Unit]\nDescription=test\n");
  // Fake only the account/service tools; find and chmod stay real so the
  // normalization itself is what gets measured.
  const bin = makeBin(dir, {
    chown: "#!/bin/sh\nexit 0\n",
    useradd: "#!/bin/sh\nexit 0\n",
    id: "#!/bin/sh\nexit 1\n",
    stat: '#!/bin/sh\nif [ "$1" = "-c" ]; then printf "600\\n"; exit 0; fi\nexec /usr/bin/stat "$@"\n',
    systemctl: '#!/bin/sh\n[ "$1" = "is-active" ] && echo active\nexit 0\n',
    sleep: "#!/bin/sh\nexit 0\n",
  });
  const env = {
    ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    PI_REMOTE_APP_DIR: app,
    PI_REMOTE_ENV_FILE: envFile,
    PI_REMOTE_UNIT_FILE: unit,
    PI_REMOTE_DROPIN_FILE: path.join(dir, "no-dropin.conf"),
  };
  const r = runBody(body, env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /^OK code_owned_by_root$/m);
  assert.equal(mode(serverJs), 0o644, "600 code file must become readable (644)");
  assert.equal(mode(storeJs), 0o644);
  assert.equal(mode(subDir), 0o755, "700 dir must become traversable (755)");
  assert.equal(mode(startSh), 0o755, "shell script must gain its exec bit (755)");
  assert.equal(mode(toolBin), 0o755, "an already-executable payload keeps 755");
  assert.equal(mode(pkgJson), 0o644);
  assert.equal(mode(nmFile), 0o600, "node_modules is excluded: its files keep their modes");
  assert.equal(mode(nmShim), 0o755, "node_modules .bin shims keep their exec bits");
  assert.equal(mode(dataFile) & 0o077, 0, "data/ stays locked down (no group/other access)");
  assert.equal(mode(cfg), 0o640, "config.json is still re-tightened to 640 by its dedicated step");
  assert.equal(mode(envFile), 0o600, "env file still ends at 600");
});

test("linux/push.sh PUSH: a kit packed with 600/700 modes is normalized on install", { skip: process.platform === "win32" }, (t) => {
  const body = shBodies("linux/push.sh").PUSH;
  assert.ok(body);
  assert.match(body, /OK perms_normalized/, "PUSH must normalize modes after extraction");
  assert.match(body, /FAIL perms /, "normalization failure must abort before the swap");

  const mode = (p) => fs.statSync(p).mode & 0o777;
  const dir = makeTemp(t, "pi-push-norm-");
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const target = path.join(home, "pi-remote");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "version.txt"), "old\n");
  fs.writeFileSync(path.join(target, ".env"), "PI_REMOTE_RELAY=ws://old\n");

  // Build the kit, then squeeze every file to 600 and every dir to 700,
  // like a tar packed from a macOS working copy.
  const kit = path.join(dir, "kit");
  const kitFile = (rel, text) => {
    const p = path.join(kit, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return p;
  };
  kitFile("version.txt", "new\n");
  kitFile("package.json", "{}\n");
  kitFile("package-lock.json", "{}\n");
  kitFile(".env.example", "PI_REMOTE_RELAY=\n");
  kitFile(path.join("protocol", "v4.json"), "{}\n");
  kitFile(path.join("extension", "pi-remote-sync.ts"), "// ext\n");
  kitFile(path.join("deploy", "attach.cjs"), "// attach\n");
  kitFile(path.join("deploy", "session-library.cjs"), "// lib\n");
  kitFile(path.join("deploy", "attach.sh"), "#!/bin/sh\nexit 0\n");
  kitFile(path.join("deploy", "start-pi.sh"), "#!/bin/sh\nexit 0\n");
  kitFile(path.join("deploy", "sync-extension.sh"), "#!/bin/sh\nexit 0\n");
  kitFile(path.join("deploy", "linux", "device.cjs"), "// stub\n");
  kitFile(path.join("deploy", "linux", "device.sh"), "#!/bin/sh\nexit 0\n");
  for (const rel of fs.readdirSync(kit, { recursive: true })) {
    const p = path.join(kit, rel);
    if (fs.statSync(p).isDirectory()) fs.chmodSync(p, 0o700);
    else fs.chmodSync(p, 0o600);
  }
  const tarPath = path.join(home, "pi-remote-device-kit.tar");
  const tar = spawnSync("tar", ["-cf", tarPath, "-C", kit, "."], { encoding: "utf8" });
  assert.equal(tar.status, 0, tar.stderr);

  const bin = makeBin(dir, {
    npm: "#!/bin/sh\nexit 0\n",
    node: "#!/bin/sh\nexit 0\n",
  });
  const user = os.userInfo().username;
  const allowRoot = user === "root" ? "1" : "0";
  const env = { ...process.env, HOME: home, PATH: bin + path.delimiter + process.env.PATH };
  const r = runBody(body, env, [user, target, allowRoot]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /OK perms_normalized/);
  assert.equal(fs.readFileSync(path.join(target, "version.txt"), "utf8"), "new\n");
  assert.equal(mode(path.join(target, "package.json")), 0o644, "plain files land 644");
  assert.equal(mode(path.join(target, "deploy", "attach.cjs")), 0o644);
  assert.equal(mode(path.join(target, "deploy")), 0o755, "dirs land 755");
  assert.equal(mode(path.join(target, "deploy", "linux")), 0o755);
  assert.equal(mode(path.join(target, "deploy", "attach.sh")), 0o755, "shell entry points land executable");
  assert.equal(mode(path.join(target, "deploy", "start-pi.sh")), 0o755);
  assert.equal(mode(path.join(target, "deploy", "linux", "device.sh")), 0o755);
  assert.equal(mode(path.join(target, ".env")), 0o600, ".env is copied in after normalization and stays 600");
});
