"use strict";
/**
 * deploy/cloudflared.cjs：参数拼装铁规（只穿 viewer 端口、localPort 进隧道直接抛错）、
 * 网址解析、二进制解析顺序（env > PATH > 缓存 > 下载）与下载哈希校验失败路径（全 mock，不联网）、
 * startTunnel 生命周期（假子进程 + 假 /ready 探针）。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const cf = require("../deploy/cloudflared.cjs");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-cf-test-"));
}

async function until(fn, what, ms = 4000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("等待超时：" + what);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

test("buildTunnelArgs：目标写死回环 viewer 端口一个源，带 --no-autoupdate 与独立 metrics", () => {
  const args = cf.buildTunnelArgs({ viewerPort: 7002, localPort: 7001, metricsPort: 20241 });
  assert.deepEqual(args, ["tunnel", "--url", "http://127.0.0.1:7002", "--no-autoupdate", "--metrics", "127.0.0.1:20241"]);
  assert.equal(args.filter((a) => a === "--url").length, 1);
});

test("buildTunnelArgs：viewerPort 与 localPort 相同直接抛错（本地通道永不进隧道）", () => {
  assert.throws(() => cf.buildTunnelArgs({ viewerPort: 7001, localPort: 7001, metricsPort: 20241 }), /本地通道永不进隧道/);
  assert.throws(() => cf.buildTunnelArgs({ viewerPort: 0, localPort: 7001, metricsPort: 20241 }), /viewerPort/);
  assert.throws(() => cf.buildTunnelArgs({ viewerPort: 7002, localPort: 7001, metricsPort: 70000 }), /metricsPort/);
});

test("verifyTunnelArgsSafe：自家参数过核对；指向本地通道/外网/多源一律给出原因", () => {
  const good = cf.buildTunnelArgs({ viewerPort: 7002, localPort: 7001, metricsPort: 20241 });
  assert.equal(cf.verifyTunnelArgsSafe(good, { viewerPort: 7002, localPort: 7001 }), "");
  assert.match(cf.verifyTunnelArgsSafe(["tunnel", "--url", "http://127.0.0.1:7001"], { viewerPort: 7002, localPort: 7001 }), /不是 viewer 端口|本地通道/);
  assert.match(cf.verifyTunnelArgsSafe(["tunnel", "--url", "http://192.168.1.10:7002"], { viewerPort: 7002, localPort: 7001 }), /不是回环/);
  assert.match(cf.verifyTunnelArgsSafe(["tunnel", "--url", "http://127.0.0.1:7002", "--url", "http://127.0.0.1:7002"], { viewerPort: 7002, localPort: 7001 }), /恰好一个/);
  assert.match(cf.verifyTunnelArgsSafe(["tunnel", "--url", "http://127.0.0.1:7002", "https://evil.example.com"], { viewerPort: 7002, localPort: 7001 }), /混入/);
  assert.match(cf.verifyTunnelArgsSafe(["run", "--url", "http://127.0.0.1:7002"], { viewerPort: 7002, localPort: 7001 }), /tunnel 子命令/);
});

test("extractTunnelUrl：横幅行里抓网址；无关文本/别的域名抓不到", () => {
  const banner = "2026-10-28T00:00:00Z INF |  https://brave-fox-123.trycloudflare.com  |";
  assert.equal(cf.extractTunnelUrl(banner), "https://brave-fox-123.trycloudflare.com");
  assert.equal(cf.extractTunnelUrl("Your quick Tunnel has been created! Visit it at https://a-b-c.trycloudflare.com/"), "https://a-b-c.trycloudflare.com");
  assert.equal(cf.extractTunnelUrl("https://example.com/trycloudflare.com"), null);
  assert.equal(cf.extractTunnelUrl("http://x-y.trycloudflare.com"), null);
  assert.equal(cf.extractTunnelUrl("还没有网址"), null);
  assert.equal(cf.extractTunnelUrl(""), null);
});

test("钉死校验表：各平台资产名与 sha256 形状齐全，下载地址指向钉死版本", () => {
  for (const key of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"]) {
    const asset = cf.releaseAsset(...key.split(/-(?=[^-]*$)/));
    assert.ok(asset, key);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    assert.ok(asset.file.includes("cloudflared"), asset.file);
  }
  const asset = cf.releaseAsset("linux", "x64");
  assert.equal(cf.releaseDownloadUrl(asset), `https://github.com/cloudflare/cloudflared/releases/download/${cf.CLOUDFLARED_VERSION}/cloudflared-linux-amd64`);
  assert.equal(cf.releaseAsset("freebsd", "x64"), null);
});

/** 假的 --version spawnSync：认出被问的二进制就回版本号 */
function fakeVersionSpawn() {
  return (bin, args) => {
    if (Array.isArray(args) && args[0] === "--version") return { status: 0, stdout: "cloudflared version 2026.10.4 (built 2026-10-26)" };
    return { status: 1, stdout: "" };
  };
}

test("resolveCloudflared：PI_REMOTE_CLOUDFLARED_BIN 显式指定优先", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "cloudflared");
  fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
  const r = await cf.resolveCloudflared({ environ: { PI_REMOTE_CLOUDFLARED_BIN: bin, PATH: "" }, spawnSyncImpl: fakeVersionSpawn(), cacheDir: path.join(dir, "cache") });
  assert.equal(r.source, "env");
  assert.equal(r.bin, bin);
  await assert.rejects(() => cf.resolveCloudflared({ environ: { PI_REMOTE_CLOUDFLARED_BIN: path.join(dir, "nope"), PATH: "" } }), /不存在或不可执行/);
});

test("resolveCloudflared：系统 PATH 已装其次", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "cloudflared"), "#!/bin/sh\n", { mode: 0o755 });
  const r = await cf.resolveCloudflared({ environ: { PATH: binDir }, spawnSyncImpl: fakeVersionSpawn(), cacheDir: path.join(dir, "cache") });
  assert.equal(r.source, "path");
  assert.equal(r.version, "2026.10.4");
});

test("resolveCloudflared：缓存命中要过哈希；下载成功落缓存且可执行", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const payload = Buffer.from("fake-cloudflared-binary-bytes");
  const table = { [`${process.platform}-${process.arch}`]: { file: "cloudflared-fake", sha256: sha256(payload) } };
  const cacheDir = path.join(dir, "cache");

  // 先下载：downloadImpl 写假字节，哈希对得上 → source=download
  const r1 = await cf.resolveCloudflared({
    environ: { PATH: "" },
    cacheDir,
    releaseTable: table,
    downloadImpl: async (url, dest) => {
      assert.ok(url.endsWith("/cloudflared-fake"), url);
      fs.writeFileSync(dest, payload);
    },
  });
  assert.equal(r1.source, "download");
  assert.equal(fs.readFileSync(r1.bin).toString(), payload.toString());
  if (process.platform !== "win32") assert.equal(fs.statSync(r1.bin).mode & 0o111, 0o111);

  // 再解析：缓存哈希一致 → source=cache，不再触发下载
  const r2 = await cf.resolveCloudflared({
    environ: { PATH: "" },
    cacheDir,
    releaseTable: table,
    downloadImpl: async () => {
      throw new Error("不该再下载");
    },
  });
  assert.equal(r2.source, "cache");
});

test("resolveCloudflared：下载哈希对不上 → 报错且不留二进制；不许下载时明确报错", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const table = { [`${process.platform}-${process.arch}`]: { file: "cloudflared-fake", sha256: sha256(Buffer.from("real-bytes")) } };
  const cacheDir = path.join(dir, "cache");
  await assert.rejects(
    () =>
      cf.resolveCloudflared({
        environ: { PATH: "" },
        cacheDir,
        releaseTable: table,
        downloadImpl: async (url, dest) => fs.writeFileSync(dest, "tampered-bytes"),
      }),
    /哈希校验失败/,
  );
  assert.equal(fs.existsSync(cf.cachedBinaryPath(cacheDir)), false);
  await assert.rejects(() => cf.resolveCloudflared({ environ: { PATH: "" }, cacheDir, releaseTable: table, allowDownload: false }), /还没装/);
});

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.exitCode = null;
    this.signalCode = null;
    this.killCalls = [];
  }
  unref() {}
  kill(sig) {
    this.killCalls.push(sig);
    return true;
  }
  exit(code, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

test("startTunnel：抓网址回调、/ready 通了才算就绪、stop 连进程组一起收", async () => {
  const child = new FakeChild(4242);
  const groupKills = [];
  let urlSeen = "";
  let probes = 0;
  const handle = cf.startTunnel({
    bin: "/fake/cloudflared",
    viewerPort: 7002,
    localPort: 7001,
    metricsPort: 20241,
    home: tmpDir(),
    spawnImpl: () => child,
    killImpl: (pid, sig) => groupKills.push([pid, sig]),
    probeReady: async () => ++probes >= 3,
    pollMs: 10,
    onUrl: (u) => {
      urlSeen = u;
    },
  });
  await until(() => handle.args, "参数拼装完成");
  assert.deepEqual(handle.args, ["tunnel", "--url", "http://127.0.0.1:7002", "--no-autoupdate", "--metrics", "127.0.0.1:20241"]);
  child.stderr.emit("data", "INF |  https://brave-fox-123.trycloudflare.com  |");
  const ready = await handle.ready;
  assert.equal(ready.url, "https://brave-fox-123.trycloudflare.com");
  assert.equal(urlSeen, "https://brave-fox-123.trycloudflare.com");
  assert.equal(handle.state(), "ready");
  assert.equal(handle.url(), "https://brave-fox-123.trycloudflare.com");
  const stopPromise = handle.stop();
  // stop 先发 SIGTERM 给进程组，等 exit；这里手动让子进程退场
  await until(() => groupKills.length > 0, "组 SIGTERM 已发出");
  assert.deepEqual(groupKills[0], [-4242, "SIGTERM"]);
  child.exit(0);
  await stopPromise;
  assert.equal(handle.state(), "stopped");
});

test("startTunnel：就绪前子进程退出 → ready 拒绝且 onExit 触发", async () => {
  const child = new FakeChild(4243);
  let exitInfo = null;
  const handle = cf.startTunnel({
    bin: "/fake/cloudflared",
    viewerPort: 7002,
    localPort: 7001,
    metricsPort: 20242,
    home: tmpDir(),
    spawnImpl: () => child,
    probeReady: async () => false,
    pollMs: 10,
    onExit: (info) => {
      exitInfo = info;
    },
  });
  await until(() => handle.args, "参数拼装完成");
  child.stderr.emit("data", "ERR boom");
  child.exit(1);
  await assert.rejects(() => handle.ready, /就绪前退出/);
  assert.equal(handle.state(), "failed");
  assert.equal(exitInfo.code, 1);
});

test("startTunnel：viewerPort 与 localPort 相同在拼装阶段就拒绝，根本不拉进程", async () => {
  let spawned = false;
  const handle = cf.startTunnel({
    bin: "/fake/cloudflared",
    viewerPort: 7001,
    localPort: 7001,
    metricsPort: 20243,
    home: tmpDir(),
    spawnImpl: () => {
      spawned = true;
      return new FakeChild(4244);
    },
    probeReady: async () => true,
  });
  await assert.rejects(() => handle.ready, /本地通道永不进隧道/);
  assert.equal(spawned, false);
});
