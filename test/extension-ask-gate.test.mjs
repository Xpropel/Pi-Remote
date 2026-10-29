// G1 ask_user / G2 审批门的工厂级测试（design-ask-cards.md §3/§4）。
// 本文件单独设非空 TOKEN：extension.test.mjs 里 TOKEN 为空、工厂会按「未配置」提前返回，测不到注册面。
import test from "node:test"
import assert from "node:assert/strict"
import { createJiti } from "jiti"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const LOG_PATH = path.join(os.tmpdir(), `pi-remote-ask-gate-test-${process.pid}.log`)
process.env.PI_REMOTE_LOG = LOG_PATH
process.env.PI_REMOTE_ATTACH_FILE = path.join(os.tmpdir(), `pi-remote-attach-ask-gate-${process.pid}-missing.json`)
process.env.PI_REMOTE_TOKEN = "ask-gate-test-token"
const jiti = createJiti(import.meta.url, { interopDefault: false })
const ext = await jiti.import(new URL("../extension/pi-remote-sync.ts", import.meta.url).pathname)
test.after(() => { try { fs.rmSync(LOG_PATH, { force: true }) } catch {} })

function fakePi(toolInfos = []) {
  const registered = []
  const handlers = new Map()
  const pi = {
    registerCommand: () => {},
    registerTool: (def) => registered.push(def),
    on: (name, fn) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn) },
    getAllTools: () => toolInfos,
    getActiveTools: () => [],
    setActiveTools: () => {},
  }
  return { pi, registered, handlers }
}

test("工厂注册：ask_user 为 model-only 且默认不激活；execute 经定义直达 Bridge", async () => {
  const { pi, registered } = fakePi()
  ext.default(pi)
  const def = registered.find((d) => d.name === "ask_user")
  assert.ok(def, "ask_user 已注册")
  assert.equal(def.exposure, "model-only")
  assert.equal(def.defaultActive, false)
  assert.deepEqual(def.parameters.required, ["question"])
  const ui = {
    select: async (title, options) => options[0],
    confirm: async () => true,
    input: async () => "x",
  }
  const r = await def.execute("tc-1", { question: "q", options: ["甲", "乙"], allowFreeText: false }, undefined, undefined, { hasUI: true, ui })
  assert.equal(r.details.answer, "甲")
})

test("工厂注册：tool_call 审批 handler 在 FORWARD 转发之前注册，默认关时零行为", async () => {
  const { pi, handlers } = fakePi([{ name: "bash", annotations: { destructiveHint: true } }])
  ext.default(pi)
  const list = handlers.get("tool_call") || []
  assert.ok(list.length >= 1, "tool_call handler 已注册")
  const gateHandler = list[0] // 工厂顺序：审批 handler 先于 FORWARD_EVENTS 的转发 handler
  const ui = { select: async () => { throw new Error("默认关不许弹窗") }, confirm: async () => true, input: async () => "x" }
  const out = await gateHandler({ type: "tool_call", toolName: "bash", input: { command: "rm -rf /" } }, { hasUI: true, ui })
  assert.equal(out, undefined, "默认关：高危调用直接放行")
})

test("工厂注册：env 开启审批门后，handler 经 ctx.ui 弹窗并按答复裁决", async () => {
  process.env.PI_REMOTE_APPROVAL_GATE = "1"
  try {
    const { pi, handlers } = fakePi([{ name: "bash", annotations: { destructiveHint: true } }])
    ext.default(pi)
    const gateHandler = (handlers.get("tool_call") || [])[0]
    const denyUi = { select: async (title, options) => options[2], confirm: async () => true, input: async () => "x" }
    const blocked = await gateHandler({ type: "tool_call", toolName: "bash", input: { command: "rm -rf build" } }, { hasUI: true, ui: denyUi })
    assert.equal(blocked.block, true)
    const allowUi = { select: async (title, options) => options[0], confirm: async () => true, input: async () => "x" }
    const allowed = await gateHandler({ type: "tool_call", toolName: "bash", input: { command: "ls" } }, { hasUI: true, ui: allowUi })
    assert.equal(allowed, undefined)
  } finally {
    delete process.env.PI_REMOTE_APPROVAL_GATE
  }
})

test("Bridge 开关初始值读 env：ask/gate/tier/tools 名单", () => {
  process.env.PI_REMOTE_ASK_USER = "1"
  process.env.PI_REMOTE_APPROVAL_GATE = "1"
  process.env.PI_REMOTE_APPROVAL_GATE_TIER = "list"
  process.env.PI_REMOTE_APPROVAL_GATE_TOOLS = "bash, write"
  try {
    const b = new ext.Bridge()
    assert.equal(b.askUserEnabled, true)
    assert.equal(b.approvalGateEnabled, true)
    assert.equal(b.approvalGateTier, "list")
    assert.deepEqual(b.approvalGateList, ["bash", "write"])
    b.clearTimers()
  } finally {
    delete process.env.PI_REMOTE_ASK_USER
    delete process.env.PI_REMOTE_APPROVAL_GATE
    delete process.env.PI_REMOTE_APPROVAL_GATE_TIER
    delete process.env.PI_REMOTE_APPROVAL_GATE_TOOLS
  }
  const plain = new ext.Bridge()
  assert.equal(plain.askUserEnabled, false)
  assert.equal(plain.approvalGateEnabled, false)
  assert.equal(plain.approvalGateTier, "high-risk")
  plain.clearTimers()
})
