// settings_set 写桥：白名单校验、全局 agentDir 原子写、0600、失败不破坏原文件、
// 诚实 restartRequired；同时回归 get_settings 只读脱敏行为不变。
// 运行时不碰真实 ~/.pi：所有写测试都用临时 PI_CODING_AGENT_DIR。
import test, { after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createJiti } from "jiti"

const LOG_PATH = path.join(os.tmpdir(), `pi-remote-settings-write-${process.pid}.log`)
process.env.PI_REMOTE_LOG = LOG_PATH
process.env.PI_REMOTE_TOKEN = ""
const jiti = createJiti(import.meta.url, { interopDefault: false })
const ext = await jiti.import(new URL("../extension/pi-remote-sync.ts", import.meta.url).pathname)

const isPosix = process.platform !== "win32"
const isRoot = typeof process.getuid === "function" && process.getuid() === 0
const tempDirs = []
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  for (const file of [LOG_PATH, LOG_PATH + ".old"]) fs.rmSync(file, { force: true })
})

function tempDir(prefix = "pi-remote-settings-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeJson(file, value, mode) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  fs.writeFileSync(file, text, { mode: mode ?? 0o600 })
  if (mode !== undefined && isPosix) fs.chmodSync(file, mode)
  return text
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

function badArgs(fn, pattern) {
  return assert.throws(fn, (e) => {
    assert.equal(e.code, "bad_args", e.message)
    if (pattern) assert.match(e.message, pattern)
    return true
  })
}

/** 设置 agentDir 并在结束后恢复（测试文件内顺序执行，不影响其他文件）。 */
function useAgentDir(dir) {
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  return () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
  }
}

test("settingsFilePath：PI_CODING_AGENT_DIR 优先、~ 展开、默认 ~/.pi/agent；只落到 settings.json", () => {
  const home = path.join(os.tmpdir(), "settings-home")
  assert.equal(ext.settingsFilePath({}, home), path.join(home, ".pi", "agent", "settings.json"))
  assert.equal(ext.settingsFilePath({ PI_CODING_AGENT_DIR: "  " }, home), path.join(home, ".pi", "agent", "settings.json"))
  assert.equal(ext.settingsFilePath({ PI_CODING_AGENT_DIR: path.join(os.tmpdir(), "agent-x") }, home), path.join(os.tmpdir(), "agent-x", "settings.json"))
  assert.equal(ext.settingsFilePath({ PI_CODING_AGENT_DIR: "~/agent-y" }, home), path.join(home, "agent-y", "settings.json"))
  assert.equal(ext.settingsFilePath({ PI_CODING_AGENT_DIR: "~" }, home), path.join(home, "settings.json"))
  const fileUrl = pathToFileURL(path.join(os.tmpdir(), "agent-z")).href
  assert.equal(ext.settingsFilePath({ PI_CODING_AGENT_DIR: fileUrl }, home), path.join(os.tmpdir(), "agent-z", "settings.json"))
})

test("白名单：全部允许字段（嵌套 + 点号）归一为点号扁平；七档 thinking level 全收", () => {
  const patch = {
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 16000 },
    hideThinkingBlock: false,
    defaultProjectTrust: "never",
    enableInstallTelemetry: false,
    enableSkillCommands: true,
    images: { blockImages: true, autoResize: false },
    defaultThinkingLevel: "xhigh",
    defaultModel: "  step-5-preview  ",
    defaultProvider: " stepfun ",
  }
  const normalized = ext.validateSettingsPatch(patch)
  assert.deepEqual({ ...normalized }, {
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    "compaction.enabled": true,
    "compaction.reserveTokens": 0,
    "compaction.keepRecentTokens": 16000,
    hideThinkingBlock: false,
    defaultProjectTrust: "never",
    enableInstallTelemetry: false,
    enableSkillCommands: true,
    "images.blockImages": true,
    "images.autoResize": false,
    defaultThinkingLevel: "xhigh",
    defaultModel: "step-5-preview",
    defaultProvider: "stepfun",
  })
  assert.equal(Object.getPrototypeOf(normalized), null, "归一结果用 null 原型，避免原型键污染")

  assert.deepEqual({ ...ext.validateSettingsPatch({ "compaction.enabled": false, "images.blockImages": true }) },
    { "compaction.enabled": false, "images.blockImages": true })
  for (const level of ext.SETTINGS_THINKING_LEVELS) {
    assert.deepEqual({ ...ext.validateSettingsPatch({ defaultThinkingLevel: level }) }, { defaultThinkingLevel: level })
  }
  for (const mode of ["one-at-a-time", "all"]) {
    assert.deepEqual({ ...ext.validateSettingsPatch({ steeringMode: mode, followUpMode: mode }) }, { steeringMode: mode, followUpMode: mode })
  }
  for (const trust of ["ask", "always", "never"]) {
    assert.deepEqual({ ...ext.validateSettingsPatch({ defaultProjectTrust: trust }) }, { defaultProjectTrust: trust })
  }
  for (const n of [0, 1, 16384, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual({ ...ext.validateSettingsPatch({ compaction: { reserveTokens: n, keepRecentTokens: n } }) },
      { "compaction.reserveTokens": n, "compaction.keepRecentTokens": n })
  }
})

test("白名单拒绝：未知字段（含嵌套/点号）、原型键、空补丁、重复、model/provider 不成对", () => {
  for (const [patch, pattern] of [
    [{ theme: "light" }, /theme/],
    [{ terminal: { showImages: true } }, /terminal/],
    [{ compaction: { modelOverrides: {} } }, /compaction\.modelOverrides/],
    [{ "compaction.enabled.extra": true }, /compaction\.enabled\.extra/],
    [{ "compaction.modelOverrides": {} }, /compaction\.modelOverrides/],
    [{ "": true }, /不在写桥白名单/],
  ]) {
    badArgs(() => ext.validateSettingsPatch(patch), pattern)
  }
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const patch = JSON.parse(`{"${key}":{"polluted":true}}`)
    badArgs(() => ext.validateSettingsPatch(patch), new RegExp(key))
  }
  assert.equal({}.polluted, undefined, "原型不能被补丁污染")

  badArgs(() => ext.validateSettingsPatch(null), /settings 对象/)
  badArgs(() => ext.validateSettingsPatch([]), /settings 对象/)
  badArgs(() => ext.validateSettingsPatch("x"), /settings 对象/)
  badArgs(() => ext.validateSettingsPatch(1), /settings 对象/)
  badArgs(() => ext.validateSettingsPatch({}), /至少要有一个/)
  badArgs(() => ext.validateSettingsPatch({ compaction: {} }), /不能是空对象/)
  badArgs(() => ext.validateSettingsPatch({ compaction: true }), /必须是对象/)
  badArgs(() => ext.validateSettingsPatch({ images: null }), /必须是对象/)
  badArgs(() => ext.validateSettingsPatch({ compaction: { enabled: true }, "compaction.enabled": false }), /重复/)
  badArgs(() => ext.validateSettingsPatch({ defaultModel: "m" }), /成对/)
  badArgs(() => ext.validateSettingsPatch({ defaultProvider: "p" }), /成对/)
  assert.doesNotThrow(() => ext.validateSettingsPatch({ defaultModel: "m", defaultProvider: "p" }))
})

test("类型/范围按 pi 1.3 schema 校验：枚举、布尔、非负安全整数、字符串", () => {
  for (const field of ["steeringMode", "followUpMode"]) {
    for (const value of ["one", "all ", "", 1, null]) badArgs(() => ext.validateSettingsPatch({ [field]: value }), new RegExp(field))
  }
  for (const field of ["compaction.enabled", "hideThinkingBlock", "enableInstallTelemetry", "enableSkillCommands"]) {
    for (const value of [1, 0, "true", null, {}]) badArgs(() => ext.validateSettingsPatch({ [field]: value }), new RegExp(field.replace(".", "\\.")))
  }
  for (const field of ["images.blockImages", "images.autoResize"]) {
    for (const value of [1, "false", null]) badArgs(() => ext.validateSettingsPatch({ [field]: value }), new RegExp(field.replace(".", "\\.")))
  }
  for (const field of ["compaction.reserveTokens", "compaction.keepRecentTokens"]) {
    for (const value of [-1, 1.5, "10", null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      badArgs(() => ext.validateSettingsPatch({ [field]: value }), new RegExp(field.replace(".", "\\.")))
    }
  }
  for (const value of ["sometimes", "ALWAYS", "", 1, null]) {
    badArgs(() => ext.validateSettingsPatch({ defaultProjectTrust: value }), /defaultProjectTrust/)
  }
  for (const value of ["none", "HIGH", "", 1, null]) {
    badArgs(() => ext.validateSettingsPatch({ defaultThinkingLevel: value }), /defaultThinkingLevel/)
  }
  for (const field of ["defaultModel", "defaultProvider"]) {
    for (const value of ["", "   ", "a".repeat(201), "a\nb", 5, null, {}]) {
      badArgs(() => ext.validateSettingsPatch({ defaultModel: "m", defaultProvider: "p", [field]: value }), new RegExp(field))
    }
  }
})

test("settings_set 合法写：合并保留未知键、0600、只回 applied/restartRequired，不泄露路径与密钥", async () => {
  const agentDir = tempDir()
  const file = path.join(agentDir, "settings.json")
  const existing = {
    defaultProvider: "old-provider",
    defaultModel: "old-model",
    apiKey: "sk-should-never-appear",
    compaction: { reserveTokens: 1000, modelOverrides: { "p/m": { reserveTokens: 5 } } },
    packages: ["npm:pi-subagents"],
  }
  writeJson(file, existing, 0o644)
  const restore = useAgentDir(agentDir)
  try {
    const bridge = new ext.Bridge()
    bridge.pi = { getSettings: () => ({ steeringMode: "one-at-a-time", defaultProvider: "old-provider", defaultModel: "old-model" }) }
    const result = await bridge.executeCommand("settings_set", {
      settings: {
        steeringMode: "all",
        compaction: { enabled: false, keepRecentTokens: 123 },
        defaultProvider: "new-provider",
        defaultModel: "new-model",
      },
    })
    assert.equal(result.ok, true)
    assert.equal(result.restartRequired, true)
    assert.match(result.restartReason, /内存/)
    assert.match(result.reloadHint, /重启/)
    assert.deepEqual(result.applied, {
      steeringMode: "all",
      "compaction.enabled": false,
      "compaction.keepRecentTokens": 123,
      defaultProvider: "new-provider",
      defaultModel: "new-model",
    })

    const wire = JSON.stringify(result)
    assert.equal(wire.includes(agentDir), false, "不得回传路径")
    assert.equal(wire.includes("sk-should-never-appear"), false, "不得回传密钥")
    assert.equal("settings" in result, false, "不得回传完整设置")
    assert.equal("path" in result, false)

    const saved = readJson(file)
    assert.equal(saved.apiKey, "sk-should-never-appear", "文件里的其他键原样保留")
    assert.equal(saved.compaction.reserveTokens, 1000, "未触碰的嵌套字段保留")
    assert.deepEqual(saved.compaction.modelOverrides, existing.compaction.modelOverrides)
    assert.equal(saved.compaction.enabled, false)
    assert.equal(saved.compaction.keepRecentTokens, 123)
    assert.equal(saved.steeringMode, "all")
    assert.equal(saved.defaultProvider, "new-provider")
    assert.equal(saved.defaultModel, "new-model")
    assert.deepEqual(saved.packages, ["npm:pi-subagents"])

    if (isPosix) assert.equal(fs.statSync(file).mode & 0o777, 0o600, "已有 0644 文件写入后收紧到 0600")
    assert.deepEqual(fs.readdirSync(agentDir).filter((name) => name.includes(".tmp-")), [], "不留临时文件")

    // 写文件不会假装热更新：运行中的 getSettings 还是旧值；诚实要求重启
    assert.equal(bridge.cmdGetSettings().settings.steeringMode, "one-at-a-time")
    assert.equal(bridge.cmdGetSettings().settings.defaultProvider, "old-provider")
  } finally {
    restore()
  }
})

test("settings_set 命令帧：command_result 带 applied/restartRequired；bad_args 帧不写文件", async () => {
  const agentDir = tempDir()
  const file = path.join(agentDir, "settings.json")
  const restore = useAgentDir(agentDir)
  try {
    const bridge = new ext.Bridge()
    bridge.connected = true
    bridge.roomId = "r1"
    const sent = []
    bridge.ws = { bufferedAmount: 0, send: (s) => sent.push(JSON.parse(s)), close() {} }
    bridge.runCommand({ id: "s1", room: "r1", command: "settings_set", args: { settings: { steeringMode: "all" } }, timeoutMs: 5000 })
    const waitFor = async (id) => {
      const deadline = Date.now() + 2000
      while (!sent.some((f) => f.type === "command_result" && f.id === id) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10))
      }
      return sent.find((f) => f.type === "command_result" && f.id === id)
    }
    const ok = await waitFor("s1")
    assert.equal(ok.ok, true)
    assert.deepEqual(ok.data.applied, { steeringMode: "all" })
    assert.equal(ok.data.restartRequired, true)
    assert.equal(JSON.stringify(ok).includes(agentDir), false, "命令帧不回传路径")
    assert.equal(readJson(file).steeringMode, "all")

    const before = fs.readFileSync(file, "utf8")
    bridge.runCommand({ id: "s2", room: "r1", command: "settings_set", args: { settings: { theme: "light" } }, timeoutMs: 5000 })
    const bad = await waitFor("s2")
    assert.equal(bad.ok, false)
    assert.equal(bad.code, "bad_args")
    assert.equal(fs.readFileSync(file, "utf8"), before)
  } finally {
    restore()
  }
})

test("settings_set 新文件：目录/文件权限 0600、空文件与 BOM 文件按空设置处理", async () => {
  const agentDir = tempDir()
  const file = path.join(agentDir, "settings.json")
  const restore = useAgentDir(agentDir)
  try {
    const bridge = new ext.Bridge()
    const result = await bridge.executeCommand("settings_set", { settings: { hideThinkingBlock: true } })
    assert.deepEqual(result.applied, { hideThinkingBlock: true })
    assert.equal(readJson(file).hideThinkingBlock, true)
    if (isPosix) {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600)
      assert.equal(fs.statSync(agentDir).mode & 0o777, 0o700)
    }
    fs.writeFileSync(file, "")
    await bridge.executeCommand("settings_set", { settings: { "images.autoResize": false } })
    assert.equal(readJson(file)["images"].autoResize, false)
    fs.writeFileSync(file, "\uFEFF" + JSON.stringify({ images: { blockImages: true } }))
    await bridge.executeCommand("settings_set", { settings: { enableSkillCommands: true } })
    const saved = readJson(file)
    assert.equal(saved.enableSkillCommands, true)
    assert.equal(saved.images.blockImages, true)
  } finally {
    restore()
  }
})

test("settings_set 参数 wrapper：settings / patch / 平铺都收；同带两者、非对象、空参数拒绝", async () => {
  const agentDir = tempDir()
  const restore = useAgentDir(agentDir)
  try {
    const bridge = new ext.Bridge()
    assert.deepEqual((await bridge.executeCommand("settings_set", { settings: { steeringMode: "all" } })).applied, { steeringMode: "all" })
    assert.deepEqual((await bridge.executeCommand("settings_set", { patch: { followUpMode: "all" } })).applied, { followUpMode: "all" })
    assert.deepEqual((await bridge.executeCommand("settings_set", { hideThinkingBlock: true })).applied, { hideThinkingBlock: true })
    await assert.rejects(bridge.executeCommand("settings_set"), (e) => e.code === "bad_args")
    await assert.rejects(bridge.executeCommand("settings_set", null), (e) => e.code === "bad_args")
    await assert.rejects(bridge.executeCommand("settings_set", { settings: [] }), (e) => e.code === "bad_args")
    await assert.rejects(bridge.executeCommand("settings_set", { settings: { steeringMode: "all" }, patch: { steeringMode: "all" } }),
      (e) => e.code === "bad_args" && /不能同时带/.test(e.message))
  } finally {
    restore()
  }
})

test("未知/非法字段、坏 JSON、顶层非对象、嵌套非对象：拒绝且原文件逐字不变", async () => {
  const agentDir = tempDir()
  const file = path.join(agentDir, "settings.json")
  const restore = useAgentDir(agentDir)
  try {
    const bridge = new ext.Bridge()
    const cases = [
      [{ settings: { theme: "light" } }, "bad_args"],
      [{ settings: { compaction: { modelOverrides: {} } } }, "bad_args"],
      [{ settings: { steeringMode: "steer" } }, "bad_args"],
      [{ settings: { defaultModel: "m" } }, "bad_args"],
    ]
    for (const [args, code] of cases) {
      const before = writeJson(file, { keep: "me", compaction: { reserveTokens: 7 } }, 0o644)
      const beforeMode = fs.statSync(file).mode & 0o777
      await assert.rejects(bridge.executeCommand("settings_set", args), (e) => e.code === code)
      assert.equal(fs.readFileSync(file, "utf8"), before, "拒绝时文件正文不变")
      assert.equal(fs.statSync(file).mode & 0o777, beforeMode, "拒绝时权限不变")
    }

    for (const bad of ["{\"theme\":", "[]", "null", "\"x\"", "42"]) {
      const before = writeJson(file, bad, 0o644)
      await assert.rejects(bridge.executeCommand("settings_set", { settings: { steeringMode: "all" } }),
        (e) => e.code === "internal" && /未写入/.test(e.message))
      assert.equal(fs.readFileSync(file, "utf8"), before)
    }

    const nonObjectNested = writeJson(file, { compaction: "not-an-object", images: [] }, 0o644)
    await assert.rejects(bridge.executeCommand("settings_set", { settings: { compaction: { enabled: true } } }),
      (e) => e.code === "internal" && /compaction 不是对象/.test(e.message))
    assert.equal(fs.readFileSync(file, "utf8"), nonObjectNested)

    const tooBig = "{\"x\":\"" + "a".repeat(1024 * 1024 + 10) + "\"}"
    writeJson(file, tooBig, 0o644)
    await assert.rejects(bridge.executeCommand("settings_set", { settings: { steeringMode: "all" } }),
      (e) => e.code === "internal" && /过大/.test(e.message))
    assert.equal(fs.readFileSync(file, "utf8"), tooBig)
  } finally {
    restore()
  }
})

test("符号链接 settings.json 拒绝写入，链接与目标都不变", { skip: !isPosix }, async () => {
  const agentDir = tempDir()
  const targetDir = tempDir()
  const target = path.join(targetDir, "real-settings.json")
  const link = path.join(agentDir, "settings.json")
  const before = writeJson(target, { steeringMode: "one-at-a-time" }, 0o600)
  fs.symlinkSync(target, link)
  const restore = useAgentDir(agentDir)
  try {
    const bridge = new ext.Bridge()
    await assert.rejects(bridge.executeCommand("settings_set", { settings: { steeringMode: "all" } }),
      (e) => e.code === "internal" && /符号链接/.test(e.message))
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true)
    assert.equal(fs.readFileSync(target, "utf8"), before)
  } finally {
    restore()
  }
})

test("原子性：fsync / rename 失败、tmp 半写失败 → 原文件不变、tmp 清理", async () => {
  const agentDir = tempDir()
  const file = path.join(agentDir, "settings.json")
  const before = writeJson(file, { steeringMode: "one-at-a-time", keep: true }, 0o600)

  const failAt = (method, impl) => new Proxy(fs, {
    get(target, prop) {
      if (prop === method) return impl
      const value = target[prop]
      return typeof value === "function" ? value.bind(target) : value
    },
  })

  const cases = [
    ["renameSync", () => { const e = new Error("rename boom"); e.code = "EIO"; throw e; }],
    ["fsyncSync", () => { throw new Error("fsync boom"); }],
    ["chmodSync", () => { throw new Error("chmod boom"); }],
    ["writeFileSync", (fd, data) => { fs.writeSync(fd, String(data).slice(0, 8)); throw new Error("disk full"); }],
  ]
  for (const [method, impl] of cases) {
    assert.throws(() => ext.settingsWritePatch(file, { steeringMode: "all" }, { fs: failAt(method, impl) }),
      (e) => {
        assert.equal(e.code, "internal")
        assert.match(e.message, /原文件未改动/)
        assert.equal(e.message.includes(agentDir), false, "IO 错误不回传绝对路径")
        return true
      }, method)
    assert.equal(fs.readFileSync(file, "utf8"), before, method + " 失败后原文件不变")
    assert.deepEqual(fs.readdirSync(agentDir).filter((name) => name.includes(".tmp-")), [], method + " 失败后不留 tmp")
  }
})

test("IO 错误只回错误码，不回传文件路径/目录", () => {
  const agentDir = tempDir()
  const file = path.join(agentDir, "settings.json")
  writeJson(file, { steeringMode: "one-at-a-time" }, 0o600)
  const failingFs = new Proxy(fs, {
    get(target, prop) {
      if (prop === "readFileSync") {
        return () => {
          const e = new Error(`EACCES: permission denied, open '${file}'`)
          e.code = "EACCES"
          throw e
        }
      }
      const value = target[prop]
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  assert.throws(() => ext.settingsWritePatch(file, { steeringMode: "all" }, { fs: failingFs }),
    (e) => {
      assert.equal(e.code, "internal")
      assert.match(e.message, /EACCES/)
      assert.equal(e.message.includes(agentDir), false)
      assert.equal(e.message.includes("settings.json"), false)
      return true
    })
  assert.equal(readJson(file).steeringMode, "one-at-a-time")
})

test("原子写顺序：open(wx,0600) → write → fsync → close → chmod → rename", () => {
  const agentDir = tempDir()
  const file = path.join(agentDir, "settings.json")
  writeJson(file, { keep: 1 }, 0o600)
  const calls = []
  const spy = new Proxy(fs, {
    get(target, prop) {
      const value = target[prop]
      if (typeof value !== "function") return value
      const wrapped = (...args) => {
        if (["openSync", "writeFileSync", "fsyncSync", "closeSync", "chmodSync", "renameSync"].includes(prop)) {
          calls.push({ op: prop, args })
        }
        return value.apply(target, args)
      }
      return wrapped
    },
  })
  const result = ext.settingsWritePatch(file, { steeringMode: "all" }, { fs: spy })
  assert.deepEqual(result.applied, { steeringMode: "all" })
  const ops = calls.filter((c) => c.op !== "openSync" || !String(c.args[0]).startsWith(agentDir + path.sep + "."))
  const main = calls.filter((c) => c.op !== "openSync" || String(c.args[0]).includes("settings.json.tmp-") || c.args[0] === agentDir)
  const seq = main.map((c) => c.op)
  assert.ok(seq.indexOf("writeFileSync") < seq.indexOf("fsyncSync"), "先写后 fsync")
  assert.ok(seq.indexOf("fsyncSync") < seq.indexOf("renameSync"), "fsync 在 rename 前")
  assert.ok(seq.indexOf("chmodSync") < seq.indexOf("renameSync"), "chmod 在 rename 前")
  const tmpOpen = calls.find((c) => c.op === "openSync" && String(c.args[0]).includes(".settings.json.tmp-"))
  assert.ok(tmpOpen, "写的是同目录 .tmp")
  assert.equal(tmpOpen.args[1], "wx", "tmp 用 wx 防碰撞")
  assert.equal(tmpOpen.args[2], 0o600, "tmp 创建即 0600")
  assert.deepEqual(fs.readdirSync(agentDir).filter((name) => name.includes(".tmp-")), [])
  void ops
})

test("写失败旧文件不变（真实只读目录）", { skip: !isPosix || isRoot }, async () => {
  const agentDir = tempDir()
  const file = path.join(agentDir, "settings.json")
  const before = writeJson(file, { steeringMode: "one-at-a-time" }, 0o600)
  const restore = useAgentDir(agentDir)
  fs.chmodSync(agentDir, 0o500)
  try {
    const bridge = new ext.Bridge()
    await assert.rejects(bridge.executeCommand("settings_set", { settings: { steeringMode: "all" } }),
      (e) => e.code === "internal")
    assert.equal(fs.readFileSync(file, "utf8"), before)
    assert.deepEqual(fs.readdirSync(agentDir).filter((name) => name.includes(".tmp-")), [])
  } finally {
    fs.chmodSync(agentDir, 0o700)
    restore()
  }
})

test("只写全局 agentDir，不创建项目本地 .pi/settings.json", async () => {
  const agentDir = tempDir()
  const projectDir = tempDir("pi-remote-project-")
  const previousCwd = process.cwd()
  const restore = useAgentDir(agentDir)
  process.chdir(projectDir)
  try {
    const bridge = new ext.Bridge()
    await bridge.executeCommand("settings_set", { settings: { enableInstallTelemetry: false } })
    assert.equal(fs.existsSync(path.join(projectDir, ".pi", "settings.json")), false, "不写项目本地设置")
    assert.equal(readJson(path.join(agentDir, "settings.json")).enableInstallTelemetry, false)
  } finally {
    process.chdir(previousCwd)
    restore()
  }
})

test("get_settings 行为保留：只读 + 敏感键脱敏；settings_set 不冒充热更新", async () => {
  const bridge = new ext.Bridge()
  bridge.pi = {
    getSettings: () => ({
      apiKey: "sk-live-secret",
      refresh_token: "rt-live",
      maxTokens: 42,
      compaction: { reserveTokens: 1234 },
    }),
  }
  const got = await bridge.executeCommand("get_settings")
  assert.equal(got.settings.apiKey, "***")
  assert.equal(got.settings.refresh_token, "***")
  assert.equal(got.settings.maxTokens, 42, "maxTokens 不因 token$ 规则被误打码")
  assert.equal(got.settings.compaction.reserveTokens, 1234)

  const agentDir = tempDir()
  const restore = useAgentDir(agentDir)
  try {
    const written = await bridge.executeCommand("settings_set", { settings: { steeringMode: "all" } })
    assert.equal(written.restartRequired, true)
    assert.equal("sk-live-secret" in written, false)
    assert.equal(bridge.cmdGetSettings().settings.steeringMode, undefined, "运行中 pi 的内存设置没有变")
  } finally {
    restore()
  }
})

test("RPC_UNSUPPORTED 文案指向 settings_set，并保留 retry 未开放的边界", async () => {
  const bridge = new ext.Bridge()
  await assert.rejects(bridge.executeCommand("set_steering_mode", { mode: "all" }),
    (e) => e.code === "unsupported" && /settings_set/.test(e.message) && /steeringMode/.test(e.message))
  await assert.rejects(bridge.executeCommand("set_follow_up_mode", { mode: "all" }),
    (e) => e.code === "unsupported" && /settings_set/.test(e.message) && /followUpMode/.test(e.message))
  await assert.rejects(bridge.executeCommand("set_auto_compaction", { enabled: true }),
    (e) => e.code === "unsupported" && /settings_set/.test(e.message) && /compaction\.enabled/.test(e.message))
  await assert.rejects(bridge.executeCommand("set_auto_retry", { enabled: true }),
    (e) => e.code === "unsupported" && /retry\.enabled/.test(e.message))
})
