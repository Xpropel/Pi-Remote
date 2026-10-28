// deploy/attach.cjs 本地安全 guard（Round 1 事故补丁）：
// ① env 来源显式可配（--env > ATTACH_ENV_FILE > 默认根 .env，且默认会打印风险提示）
// ② 非 localhost relay 且未 --allow-remote → 启动前直接退出；③ 本文件只验证纯函数/CLI 静态行为，不真实连接。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"

const require = createRequire(import.meta.url)
const attach = require("../deploy/attach.cjs")
const ROOT = path.resolve(import.meta.dirname, "..")

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-attach-guard-"))

test("isLocalRelayHost：只认 localhost / 127.0.0.0/8 / ::1", () => {
  for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.8.9.10", "::1", "[::1]", " 127.0.0.1 "]) {
    assert.equal(attach.isLocalRelayHost(host), true, host)
  }
  for (const host of ["relay.prod.example", "10.0.0.5", "192.168.1.2", "0.0.0.0", "localhost.evil.com", "", null, "128.0.0.1"]) {
    assert.equal(attach.isLocalRelayHost(host), false, String(host))
  }
})

test("relayHostOf：解析 ws/wss；非法地址返回 null", () => {
  assert.equal(attach.relayHostOf("ws://127.0.0.1:7001"), "127.0.0.1")
  assert.equal(attach.relayHostOf("wss://relay.example.com/path"), "relay.example.com")
  assert.equal(attach.relayHostOf("not a url"), null)
  assert.equal(attach.relayHostOf(""), null)
})

test("attachRelaySafetyError：本地放行；远端默认阻止；--allow-remote 放行；非法地址阻止", () => {
  assert.equal(attach.attachRelaySafetyError("ws://127.0.0.1:7001"), null)
  assert.equal(attach.attachRelaySafetyError("ws://localhost:7001"), null)
  const blocked = attach.attachRelaySafetyError("ws://relay.prod.example:7001")
  assert.ok(blocked, "远端 relay 默认必须阻止")
  assert.match(blocked, /非本地 relay/)
  assert.match(blocked, /relay\.prod\.example/)
  assert.match(blocked, /--allow-remote/)
  assert.equal(attach.attachRelaySafetyError("ws://relay.prod.example:7001", { allowRemote: true }), null)
  assert.match(attach.attachRelaySafetyError("nope"), /无法解析/)
})

test("resolveEnvFile：--env > ATTACH_ENV_FILE > 默认根 .env（来源可追踪）", () => {
  const def = attach.resolveEnvFile([], {})
  assert.deepEqual(def, { path: path.join(ROOT, ".env"), source: "默认根 .env", explicit: false })
  assert.deepEqual(attach.resolveEnvFile([], { ATTACH_ENV_FILE: "/tmp/pi-attach.env" }), {
    path: "/tmp/pi-attach.env",
    source: "ATTACH_ENV_FILE",
    explicit: true,
  })
  assert.deepEqual(attach.resolveEnvFile(["--env", "/tmp/cli.env"], { ATTACH_ENV_FILE: "/tmp/var.env" }), {
    path: "/tmp/cli.env",
    source: "--env",
    explicit: true,
  })
  assert.deepEqual(attach.resolveEnvFile(["--env=/tmp/eq.env"], {}).path, "/tmp/eq.env")
  assert.deepEqual(attach.resolveEnvFile([], {}, "/tmp/custom-root"), {
    path: "/tmp/custom-root/.env",
    source: "默认根 .env",
    explicit: false,
  })
})

test("parseArgs：--env / --allow-remote 解析；--env 缺值报错", () => {
  const args = attach.parseArgs(["--env", "/tmp/x.env", "--allow-remote"])
  assert.equal(args.env, "/tmp/x.env")
  assert.equal(args.allowRemote, true)
  assert.equal(attach.parseArgs(["--env=/tmp/y.env"]).env, "/tmp/y.env")
  assert.equal(attach.parseArgs([]).allowRemote, false, "默认不允许远端")
  assert.throws(() => attach.parseArgs(["--env"]), /--env 需要/)
})

test("doctor：非本地 relay 只给警告（只读探测，不退出、不鉴权）", async () => {
  const dir = tmpDir()
  const envPath = path.join(dir, ".env")
  fs.writeFileSync(envPath, "PI_REMOTE_RELAY=ws://relay.prod.example:7001\nPI_REMOTE_DEVICE_ID=d1\nPI_REMOTE_TOKEN=t\n", "utf8")
  const lines = []
  const code = await attach.doctorMain({}, envPath, {
    writeOut: (line) => lines.push(String(line)),
    platform: "darwin",
    probe: async () => ({ ok: true }),
    env: { PI_REMOTE_ATTACH_FILE: path.join(dir, "none.json"), PI_REMOTE_PI_BIN: process.execPath },
    spawnSyncImpl: () => ({ status: 0, stdout: "" }),
  })
  assert.equal(code, 0)
  assert.ok(lines.some((line) => line.includes("非本地 relay")), lines.join("\n"))
  fs.rmSync(dir, { recursive: true, force: true })
})

test("CLI guard：远端 relay 启动前退出（exit 2），本地测试环境不会真的连出去", () => {
  const dir = tmpDir()
  const envPath = path.join(dir, "local-test.env")
  fs.writeFileSync(envPath, "PI_REMOTE_RELAY=ws://relay.prod.example:7001\nPI_REMOTE_DEVICE_ID=guard-device\nPI_REMOTE_TOKEN=guard-token\n", "utf8")
  const r = spawnSync(process.execPath, [path.join(ROOT, "deploy/attach.cjs"), "--env", envPath], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 15000,
  })
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /非本地 relay/)
  assert.match(r.stderr, /relay\.prod\.example/)
  assert.match(r.stderr, /--allow-remote/)
  // env 来源日志（①）：显式 --env 必须打印来源
  assert.match(r.stdout, /env 文件：.*local-test\.env（来源：--env）/)
  // 本地测试 env 文件里没有生产令牌；guard 在构造连接前退出（不产生 relay 连接）
  fs.rmSync(dir, { recursive: true, force: true })
})

test("CLI guard：--env 指向不存在的文件 → 退出 1 并报错（不落回默认根 .env）", () => {
  const missing = path.join(tmpDir(), "missing.env")
  const r = spawnSync(process.execPath, [path.join(ROOT, "deploy/attach.cjs"), "--env", missing], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 15000,
  })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stderr, /找不到 --env\/ATTACH_ENV_FILE 指定的 env 文件/)
})
