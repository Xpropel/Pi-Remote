"use strict";
/**
 * relay/web.js 静态服务：入口、资源、404、路径穿越、Content-Type、HEAD、缓存头。
 * 全部走真实 viewer 端口（http.createServer → makeServeWeb），断言当前实现，不臆造新行为。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { startRelay } = require("../relay/server.js");
const { setQuiet } = require("../relay/util.js");

const LOCAL_TOKEN = "test-local-token-2f8c1d";
const VIEWER_TOKEN = "test-viewer-token-7a3b9e";
const INDEX = "<!doctype html><title>pi-test</title>";

let relay;
let base;
let webRoot;
let port;

function write(rel, content) {
  const file = path.join(webRoot, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** 直接发原始路径（http.request 不做路径归一化；服务端 new URL + decodeURIComponent 才是被测路径） */
function request(pathname, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, method, agent: false, headers: { Connection: "close" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-web-"));
  webRoot = path.join(base, "web");
  fs.mkdirSync(webRoot, { recursive: true });
  write("index.html", INDEX);
  write("assets/app-abcdef12.js", "console.log(1);\n");
  write("assets/plain.js", "console.log(2);\n");
  write("assets/app-abcde.css", "body { color: #000; }\n");
  write("assets/site.css", "body { margin: 0; }\n");
  write("assets/deep/app-abcdef12.js", "console.log(3);\n");
  write("icon.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
  write("image.png", "not-a-real-png");
  write("favicon.ico", "not-a-real-ico");
  write("font.woff2", "not-a-real-font");
  write("app.webmanifest", "{\"name\":\"pi\"}");
  write("data.json", "{\"ok\":true}");
  write("notes.txt", "plain text");
  // webRoot 外面的文件：路径穿越若成功就会读到它
  fs.writeFileSync(path.join(base, "secret.txt"), "TOP-SECRET");

  relay = await startRelay({
    localPort: 0,
    viewerPort: 0,
    dataDir: path.join(base, "data"),
    webRoot,
    quiet: true,
    exitOnListenError: false,
    localToken: LOCAL_TOKEN,
    viewerToken: VIEWER_TOKEN,
    perMessageDeflate: false,
  });
  port = relay.viewerPort;
});

after(async () => {
  try {
    if (relay) await relay.close();
  } finally {
    if (base) fs.rmSync(base, { recursive: true, force: true });
  }
});

test("GET / 与 /index.html：200 HTML、入口 no-cache；无扩展路径回退 index", async () => {
  for (const pathname of ["/", "/index.html", "/room/session-1"]) {
    const r = await request(pathname);
    assert.equal(r.status, 200, pathname);
    assert.equal(r.headers["content-type"], "text/html; charset=utf-8", pathname);
    assert.equal(r.headers["cache-control"], "no-cache", pathname + " 入口不能长缓存");
    assert.equal(r.body, INDEX, pathname);
  }

  // 目录路径没有扩展名：现有实现 readFile 失败后回退 index.html（不是目录列表）
  const dir = await request("/assets");
  assert.equal(dir.status, 200);
  assert.equal(dir.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(dir.body, INDEX);
});

test("静态资源 200 与 Content-Type 映射：已知扩展名按表，未知扩展名 octet-stream", async () => {
  const cases = [
    ["/assets/plain.js", "text/javascript; charset=utf-8"],
    ["/assets/site.css", "text/css; charset=utf-8"],
    ["/icon.svg", "image/svg+xml"],
    ["/image.png", "image/png"],
    ["/favicon.ico", "image/x-icon"],
    ["/font.woff2", "font/woff2"],
    ["/app.webmanifest", "application/manifest+json"],
    ["/data.json", "application/json; charset=utf-8"],
    ["/notes.txt", "application/octet-stream"],
  ];
  for (const [pathname, type] of cases) {
    const r = await request(pathname);
    assert.equal(r.status, 200, pathname);
    assert.equal(r.headers["content-type"], type, pathname);
    assert.equal(r.headers["cache-control"], "no-cache", pathname + " 未带内容 hash 只能 no-cache");
  }
  assert.equal((await request("/notes.txt")).body, "plain text");
});

test("缓存头：带内容 hash 的 /assets 产物 immutable；hash 太短/普通资源 no-cache", async () => {
  for (const pathname of ["/assets/app-abcdef12.js", "/assets/app-abcdef12.js?v=42", "/assets/deep/app-abcdef12.js"]) {
    const r = await request(pathname);
    assert.equal(r.status, 200, pathname);
    assert.equal(r.headers["cache-control"], "public, max-age=31536000, immutable", pathname);
  }

  // 现有规则：/assets/ 且文件名尾部 hash ≥6 位才 immutable；5 位不算
  for (const pathname of ["/assets/app-abcde.css", "/assets/plain.js", "/notes.txt", "/", "/room/session-1"]) {
    const r = await request(pathname);
    assert.equal(r.status, 200, pathname);
    assert.equal(r.headers["cache-control"], "no-cache", pathname);
  }
});

test("HEAD：和 GET 同状态/头，但没有正文", async () => {
  const index = await request("/", "HEAD");
  assert.equal(index.status, 200);
  assert.equal(index.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(index.headers["cache-control"], "no-cache");
  assert.equal(index.body, "");

  const asset = await request("/assets/app-abcdef12.js", "HEAD");
  assert.equal(asset.status, 200);
  assert.equal(asset.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(asset.body, "");

  const missing = await request("/missing.js", "HEAD");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(missing.body, "");
});

test("不存在文件：带扩展名 404，无扩展名回退 index；不存在的目录同样回退", async () => {
  for (const pathname of ["/missing.js", "/assets/missing.css", "/missing.png"]) {
    const r = await request(pathname);
    assert.equal(r.status, 404, pathname);
    assert.equal(r.headers["content-type"], "text/plain; charset=utf-8", pathname);
    assert.equal(r.body, "not found", pathname);
    assert.equal(r.headers["cache-control"], undefined, pathname + " 404 不带缓存头");
  }
  for (const pathname of ["/missing", "/missing/deep/route"]) {
    const r = await request(pathname);
    assert.equal(r.status, 200, pathname);
    assert.equal(r.body, INDEX, pathname + " 无扩展名走 SPA 回退");
  }
});

test("路径穿越/编码穿越：%2f 与 %5c 越界 403；%00 与坏转义 400；一律读不到 webRoot 外的文件", async () => {
  // 编码后的 ../ 不会被 new URL 归一化，decode 后交给 path.join 越界 → 403
  for (const pathname of [
    "/..%2fsecret.txt",
    "/%2e%2e%2fsecret.txt",
    "/..%5csecret.txt",
    "/assets/..%2f..%2fsecret.txt",
  ]) {
    const r = await request(pathname);
    assert.equal(r.status, 403, pathname);
    assert.equal(r.body, "403", pathname);
    assert.equal(r.body.includes("TOP-SECRET"), false, pathname + " 不能泄露父目录文件");
  }

  // 原始 ../ 会被 WHATWG URL 归一化成根内路径：读不到就是 404，而不是把父目录文件发出去
  const rawDot = await request("/../secret.txt");
  assert.equal(rawDot.status, 404);
  assert.equal(rawDot.body.includes("TOP-SECRET"), false);

  // 双重编码只解一层，落成 webRoot 内的字面文件名 → 404
  const double = await request("/%252e%252e%252fsecret.txt");
  assert.equal(double.status, 404);
  assert.equal(double.body.includes("TOP-SECRET"), false);

  // NUL 与非法百分号转义在进 fs 之前就被挡下（否则同步异常会挂住请求）
  for (const pathname of ["/%00", "/%E0%A4%A"]) {
    const r = await request(pathname);
    assert.equal(r.status, 400, pathname);
    assert.equal(r.body, "400", pathname);
  }
});

test("只接受 GET/HEAD：其余方法 405 + Allow，不落到静态文件", async () => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    const r = await request("/", method);
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.allow, "GET, HEAD", method);
    assert.equal(r.body, "", method);
  }
  // /healthz 只有 GET/HEAD 被 viewer.js 截获，POST 仍走静态服务 → 405
  assert.equal((await request("/healthz", "POST")).status, 405);
});

test("GET /healthz：JSON、no-store；HEAD 无正文（既有行为回归）", async () => {
  const r = await request("/healthz");
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(r.headers["cache-control"], "no-store");
  const body = JSON.parse(r.body);
  assert.equal(body.ok, true);
  assert.equal(typeof body.proto, "number");
  assert.equal(typeof body.version, "string");
  assert.equal(typeof body.uptimeSec, "number");
  assert.equal(typeof body.rooms.online, "number");
  assert.equal(typeof body.rooms.total, "number");
  assert.equal(typeof body.viewers, "number");
  assert.equal("rooms" in body, true);

  const head = await request("/healthz", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(head.headers["cache-control"], "no-store");
  assert.equal(head.body, "");
});

test("读取错误：ENOENT 仍 404/回退，其它读错误（ELOOP）500 且记日志", async (t) => {
  // 自指符号链接：stat 返回 ELOOP（不是 ENOENT），用来模拟权限/IO 类读失败
  const loop = path.join(webRoot, "broken.js");
  try {
    fs.symlinkSync("broken.js", loop);
  } catch {
    t.skip("当前平台不允许创建测试用符号链接");
    return;
  }
  // 目录带扩展名：沿用旧 readFile(EISDIR) 口径是 404，不升级成 500
  fs.mkdirSync(path.join(webRoot, "bundle.js"));
  assert.equal((await request("/bundle.js")).status, 404);

  const logged = [];
  t.mock.method(console, "log", (...args) => { logged.push(args); });
  setQuiet(false);
  t.after(() => setQuiet(true));

  const r = await request("/broken.js");
  assert.equal(r.status, 500);
  assert.equal(r.body, "500");
  assert.equal(r.headers["cache-control"], undefined, "错误响应不能带静态资源缓存头");
  assert.ok(
    logged.some((args) => args.some((a) => String(a).includes("静态资源读取失败"))),
    "非 ENOENT 读错误必须进日志，不能静默 404",
  );

  const head = await request("/broken.js", "HEAD");
  assert.equal(head.status, 500);
  assert.equal(head.body, "");
});

test("静态文件用流式发送：不再整份 fs.readFile 进内存", async (t) => {
  const readFile = t.mock.method(fs, "readFile");
  const r = await request("/assets/plain.js");
  assert.equal(r.status, 200);
  assert.equal(r.body, "console.log(2);\n");
  const underRoot = readFile.mock.calls.filter((c) => String(c.arguments[0] || "").startsWith(webRoot));
  assert.deepEqual(underRoot, [], "静态文件内容应由 createReadStream 流式发送");
});
