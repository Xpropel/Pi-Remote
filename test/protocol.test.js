// 协议唯一事实源 protocol/v4.json：副本不过期、错误码表形状正确。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const proto = require("../protocol/v4.json");
const { BEGIN, END } = require("../protocol/sync.cjs");

const ROOT = path.join(__dirname, "..");

/** 复制一份可独立运行的 sync.cjs + 事实源/副本，供标记损坏场景使用（不碰真实仓库文件） */
function syncFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-protocol-sync-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, "protocol", "sync.cjs");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "protocol", "sync.cjs"), script);
  fs.copyFileSync(path.join(ROOT, "protocol", "v4.json"), path.join(dir, "protocol", "v4.json"));

  const json = JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, "protocol", "v4.json"), "utf8")), null, 2) + "\n";
  const relayCopy = path.join(dir, "relay", "protocol.json");
  fs.mkdirSync(path.dirname(relayCopy), { recursive: true });
  fs.writeFileSync(relayCopy, json);

  const ext = path.join(dir, "extension", "pi-remote-sync.ts");
  fs.mkdirSync(path.dirname(ext), { recursive: true });
  fs.writeFileSync(ext, `// fixture head\n${BEGIN}\nconst PROTOCOL = ${json.trimEnd()} as const;\n${END}\n// fixture tail\n`);
  return { dir, script, ext, relayCopy };
}

test("relay/protocol.json 与扩展 PROTOCOL 块和 protocol/v4.json 一致（不一致就跑 node protocol/sync.cjs）", () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "protocol", "sync.cjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("低-11：PROTOCOL 块标记缺失/损坏时 --check 退出非 0 并报错，不静默通过", (t) => {
  const { script, ext, relayCopy } = syncFixture(t);
  const run = (args = []) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

  const clean = run(["--check"]);
  assert.equal(clean.status, 0, "夹具基线应通过：" + clean.stderr);
  const good = fs.readFileSync(ext, "utf8");

  const cases = [
    ["缺少 BEGIN", good.replace(BEGIN, "// head marker removed")],
    ["缺少 END", good.replace(END, "// tail marker removed")],
    ["两个标记都缺", good.replace(BEGIN, "// head marker removed").replace(END, "// tail marker removed")],
    ["END 在 BEGIN 之前", END + "\n" + good.replace(END, "// tail marker removed")],
    ["BEGIN 重复", good.replace(BEGIN, BEGIN + "\n" + BEGIN)],
    ["END 重复", good.replace(END, END + "\n" + END)],
  ];
  for (const [name, damaged] of cases) {
    fs.writeFileSync(ext, damaged);
    const r = run(["--check"]);
    assert.notEqual(r.status, 0, `${name} 时 --check 必须非 0，不能假绿`);
    assert.match(r.stderr, /协议同步失败|PROTOCOL|标记/, `${name} 必须报错，实际 stderr：${r.stderr}`);
  }

  // 写入模式同样不能静默跳过；plan() 在任一写盘之前抛错，不能先写一半
  fs.writeFileSync(relayCopy, "{}\n");
  const before = fs.readFileSync(ext, "utf8");
  const w = run();
  assert.notEqual(w.status, 0, "标记损坏时写入模式也必须失败");
  assert.match(w.stderr, /协议同步失败/);
  assert.equal(fs.readFileSync(ext, "utf8"), before, "标记损坏时不能改写扩展");
  assert.equal(fs.readFileSync(relayCopy, "utf8"), "{}\n", "标记损坏时不能先写一半 relay 副本");
});

test("错误码表：每个码都有文案和是否可重试；版本与上限齐全", () => {
  assert.equal(proto.proto, 4);
  assert.ok(proto.minProto <= proto.proto);
  for (const [code, def] of Object.entries(proto.errors)) {
    assert.match(code, /^[a-z][a-z0-9_]*$/, code);
    assert.equal(typeof def.message, "string", code);
    assert.ok(def.message.length > 0, code);
    assert.equal(typeof def.retryable, "boolean", code);
  }
  for (const key of ["cidMax", "deviceNameMax", "projectsMax", "projectPathMax", "pairCodeLength", "pairCodeAlphabet", "pairCodeTtlMs", "deviceTokenBytes"]) {
    assert.ok(key in proto.limits, key);
  }
  assert.equal(new Set(proto.limits.pairCodeAlphabet).size, proto.limits.pairCodeAlphabet.length);
  assert.doesNotMatch(proto.limits.pairCodeAlphabet, /[01IO]/, "配对码不用容易看错的字符");
});
