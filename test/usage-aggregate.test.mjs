// P10 usage.activity.v1 聚合单测（fixture jsonl；不读用户真实 ~/.pi，不联网）。
// 覆盖：基本计数/口径、跨天与时区、模型切换与长尾、压缩/废弃分支/非消息条目、坏行、空目录、
//       增量缓存（命中/单文件变更/删除/损坏/时区变更）、400 天截断、extension 与 shared 契约一致性。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { createJiti } from "jiti"
import { addDaysToDayKey, localDayKey } from "../ui/src/pi/usage/format.ts"

const require = createRequire(import.meta.url)
const jiti = createJiti(import.meta.url, { interopDefault: false })
const ext = await jiti.import(new URL("../extension/pi-remote-sync.ts", import.meta.url).pathname)
const shared = await import("../ui/src/pi/usage/validate.ts")
const sharedTypes = await import("../ui/src/pi/usage/types.ts")

const SESSION_DAY = Date.UTC(2026, 9, 20, 12, 0, 0) // 2026-10-20T12:00Z
const mkTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-"))

const msg = (role, ts, opts = {}) => ({
  type: "message",
  id: opts.id ?? `m-${Math.random().toString(36).slice(2)}`,
  timestamp: new Date(ts).toISOString(),
  message: {
    role,
    timestamp: ts,
    ...(role === "assistant" ? { provider: opts.provider ?? "stepfun", model: opts.model ?? "step-5-preview", stopReason: opts.stopReason ?? "stop" } : null),
    ...(opts.usage ? { usage: opts.usage } : null),
    ...(opts.content ? { content: opts.content } : null),
  },
})
const usageOf = (totalTokens, input = totalTokens, output = 0, extra = {}) => ({ input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens, ...extra })
const sessionRow = (ts = SESSION_DAY) => ({ type: "session", version: 3, id: "s-test", timestamp: new Date(ts).toISOString(), cwd: "/tmp/project" })

/** 写一个会话文件：dir/--proj--/name.jsonl */
function writeSession(root, name, rows) {
  const dir = path.join(root, "--proj--")
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.jsonl`)
  fs.writeFileSync(file, rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n", "utf8")
  return file
}

test("基本口径：用户消息只数 role=user；assistant usage 计 token/模型；会话按 header 分天", async () => {
  const root = mkTemp()
  try {
    writeSession(root, "a", [
      sessionRow(SESSION_DAY),
      msg("system", SESSION_DAY),
      msg("user", SESSION_DAY + 1000, { content: [{ type: "text", text: "hello 正文不应进快照" }] }),
      msg("assistant", SESSION_DAY + 2000, { usage: usageOf(100, 90, 10) }),
      msg("toolResult", SESSION_DAY + 3000, { content: [{ type: "text", text: "tool 输出" }] }),
      msg("user", SESSION_DAY + 4000),
      msg("assistant", SESSION_DAY + 5000, { usage: usageOf(50, 40, 10), model: "gpt-6.1-sol", provider: "openai-codex" }),
      msg("custom", SESSION_DAY + 6000),
    ])
    writeSession(root, "b", [
      sessionRow(SESSION_DAY + 86_400_000),
      msg("user", SESSION_DAY + 86_400_000 + 1000),
      msg("assistant", SESSION_DAY + 86_400_000 + 2000, { usage: usageOf(25, 20, 5), stopReason: "error" }),
    ])
    const { snapshot, diagnostics } = await ext.usageScanSnapshot({ sessionRoot: root, cachePath: path.join(root, "usage-days.json"), now: SESSION_DAY + 3 * 86_400_000 })
    const v = shared.validateUsageSnapshot(snapshot)
    assert.equal(v.ok, true, JSON.stringify(v))
    assert.equal(snapshot.v, sharedTypes.USAGE_ACTIVITY_VERSION)
    assert.equal(snapshot.days.length, 2)
    const [d1, d2] = snapshot.days
    assert.equal(d1.sessions, 1)
    assert.equal(d1.messages.user, 2)
    assert.equal(d1.messages.assistant, 2)
    assert.deepEqual(d1.tokens, { total: 150, input: 130, output: 20, cacheRead: 0, cacheWrite: 0 })
    assert.equal(d2.messages.assistant, 1, "失败轮 assistant 也计数")
    assert.equal(snapshot.summary.totals.tokens, 175)
    assert.equal(snapshot.summary.totals.messagesUser, 3)
    assert.equal(snapshot.summary.totals.messagesAssistant, 3)
    assert.equal(snapshot.summary.totals.sessions, 2)
    assert.equal(snapshot.summary.models.length, 2)
    assert.equal(snapshot.summary.models[0].tokens, 125, "最近 30 天按模型 token 降序（step-5-preview: 100+25）")
    assert.equal(diagnostics.parsedFiles, 2)
    // 隐私：无正文/标题/cwd/cost 泄漏
    const json = JSON.stringify(snapshot)
    for (const bad of ["hello 正文", "tool 输出", "/tmp/project", "cost", "cwd"]) assert.equal(json.includes(bad), false, bad)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("跨天按本地时区：同一 UTC 时刻在上海/纽约落到不同自然日；时区变化作废缓存", async () => {
  const root = mkTemp()
  const oldTz = process.env.TZ
  try {
    writeSession(root, "tz", [sessionRow(Date.UTC(2026, 9, 26, 17, 30, 0)), msg("user", Date.UTC(2026, 9, 26, 17, 30, 0))])
    process.env.TZ = "Asia/Shanghai"
    const sh = await ext.usageScanSnapshot({ sessionRoot: root, cachePath: path.join(root, "cache.json"), now: Date.UTC(2026, 9, 27, 12) })
    assert.deepEqual(sh.snapshot.days.map((d) => d.date), ["2026-10-27"], "上海 = 10-27 01:30")
    process.env.TZ = "America/New_York"
    const ny = await ext.usageScanSnapshot({ sessionRoot: root, cachePath: path.join(root, "cache.json"), now: Date.UTC(2026, 9, 27, 12) })
    assert.deepEqual(ny.snapshot.days.map((d) => d.date), ["2026-10-26"], "纽约 = 10-26 13:30")
    assert.equal(ny.diagnostics.cacheHit, false, "时区变化 → 缓存作废重扫")
  } finally {
    process.env.TZ = oldTz
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("模型切换/长尾：model_change 行忽略，按 assistant.model 分组，>8 截断", async () => {
  const root = mkTemp()
  try {
    const rows = [sessionRow()]
    rows.push({ type: "model_change", id: "mc", provider: "stepfun", modelId: "should-be-ignored" })
    for (let i = 0; i < 12; i++) rows.push(msg("assistant", SESSION_DAY + i * 1000, { provider: "p", model: `m${i}`, usage: usageOf((i + 1) * 10) }))
    writeSession(root, "models", rows)
    const { snapshot } = await ext.usageScanSnapshot({ sessionRoot: root, cachePath: path.join(root, "c.json"), now: SESSION_DAY + 86_400_000 })
    assert.ok(snapshot.summary.models.length <= 8)
    assert.ok(snapshot.summary.models.every((m) => m.model !== "should-be-ignored"))
    assert.equal(snapshot.summary.models[0].model, "m11", "按 token 降序")
    assert.equal(snapshot.summary.models.reduce((n, m) => n + m.tokens, 0) > 0, true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("压缩/废弃分支/非消息条目：只计 message 的 user/assistant，其他条目跳过但不报错", async () => {
  const root = mkTemp()
  try {
    writeSession(root, "mixed", [
      sessionRow(),
      msg("system", SESSION_DAY),
      msg("user", SESSION_DAY + 1000),
      { type: "compaction", id: "c1", timestamp: new Date(SESSION_DAY + 2000).toISOString(), summary: "压缩摘要不应进快照" },
      { type: "compactionSummary", role: "user", content: "压缩摘要" },
      { type: "branchSummary", role: "assistant", content: "分支摘要" },
      msg("assistant", SESSION_DAY + 3000, { usage: usageOf(10) }),
      // 废弃分支：同文件里多 parentId 的 user/assistant 仍计入（v1 口径，文档注明）
      msg("user", SESSION_DAY + 4000, { id: "abandoned-user" }),
      msg("assistant", SESSION_DAY + 5000, { id: "abandoned-assistant", usage: usageOf(5) }),
    ])
    const { snapshot } = await ext.usageScanSnapshot({ sessionRoot: root, cachePath: path.join(root, "c.json"), now: SESSION_DAY + 86_400_000 })
    assert.equal(snapshot.days[0].messages.user, 2)
    assert.equal(snapshot.days[0].messages.assistant, 2)
    assert.equal(snapshot.days[0].tokens.total, 15)
    assert.equal(JSON.stringify(snapshot).includes("压缩摘要"), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("坏 jsonl 行/缺 header/空目录：坏行计 errors 不中断；无 header 时补记一个会话；空目录空快照", async () => {
  const root = mkTemp()
  try {
    writeSession(root, "bad", ["{not json", sessionRow(), msg("user", SESSION_DAY), msg("assistant", SESSION_DAY + 1000, { usage: usageOf(7) }), "{\"type\":\"message\"}"])
    writeSession(root, "noheader", [msg("user", SESSION_DAY + 86_400_000), msg("assistant", SESSION_DAY + 86_400_000 + 1000, { usage: usageOf(3) })])
    const { snapshot } = await ext.usageScanSnapshot({ sessionRoot: root, cachePath: path.join(root, "c.json"), now: SESSION_DAY + 3 * 86_400_000 })
    assert.equal(snapshot.coverage.errors >= 1, true)
    assert.equal(snapshot.summary.totals.sessions, 2, "缺 header 的文件也按 1 个会话计")
    assert.equal(snapshot.summary.totals.tokens, 10)
    const emptyRoot = mkTemp()
    const { snapshot: empty } = await ext.usageScanSnapshot({ sessionRoot: emptyRoot, cachePath: path.join(emptyRoot, "c.json"), now: Date.now() })
    assert.deepEqual(empty.days, [])
    assert.equal(empty.summary.totals.tokens, 0)
    assert.equal(shared.validateUsageSnapshot(empty).ok, true)
    fs.rmSync(emptyRoot, { recursive: true, force: true })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("增量缓存：二次命中、单文件变更只重扫该文件、删除文件、缓存损坏、400 天截断", async () => {
  const root = mkTemp()
  const cachePath = path.join(root, "usage-days.json")
  try {
    const fileA = writeSession(root, "a", [sessionRow(), msg("user", SESSION_DAY), msg("assistant", SESSION_DAY + 1000, { usage: usageOf(10) })])
    writeSession(root, "b", [sessionRow(), msg("user", SESSION_DAY), msg("assistant", SESSION_DAY + 1000, { usage: usageOf(20) })])
    const first = await ext.usageScanSnapshot({ sessionRoot: root, cachePath, now: SESSION_DAY + 86_400_000 })
    assert.equal(first.diagnostics.cacheHit, false)
    assert.equal(first.snapshot.cache.generatedFrom, "full")
    const second = await ext.usageScanSnapshot({ sessionRoot: root, cachePath, now: SESSION_DAY + 86_400_000 })
    assert.equal(second.diagnostics.cacheHit, true)
    assert.equal(second.diagnostics.cacheHitFiles, 2)
    assert.equal(second.diagnostics.parsedFiles, 0)
    assert.equal(second.snapshot.summary.totals.tokens, 30)
    // 单文件追加 → 只重扫它
    fs.appendFileSync(fileA, JSON.stringify(msg("assistant", SESSION_DAY + 2000, { usage: usageOf(5) })) + "\n")
    const third = await ext.usageScanSnapshot({ sessionRoot: root, cachePath, now: SESSION_DAY + 86_400_000 })
    assert.equal(third.diagnostics.parsedFiles, 1)
    assert.equal(third.diagnostics.cacheHitFiles, 1)
    assert.equal(third.snapshot.summary.totals.tokens, 35)
    // 删除文件 → 贡献移除
    fs.rmSync(path.join(root, "--proj--", "b.jsonl"))
    const fourth = await ext.usageScanSnapshot({ sessionRoot: root, cachePath, now: SESSION_DAY + 86_400_000 })
    assert.equal(fourth.snapshot.summary.totals.tokens, 15)
    assert.equal(fourth.snapshot.summary.totals.sessions, 1)
    // 缓存损坏 → 全量重扫
    fs.writeFileSync(cachePath, "{broken")
    const fifth = await ext.usageScanSnapshot({ sessionRoot: root, cachePath, now: SESSION_DAY + 86_400_000 })
    assert.equal(fifth.diagnostics.cacheHit, false)
    assert.equal(fifth.snapshot.summary.totals.tokens, 15)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }

  // 400 天截断（401 个会话日）
  const big = mkTemp()
  try {
    const rows = [sessionRow(Date.UTC(2025, 0, 1, 12))]
    for (let i = 0; i <= 400; i++) {
      const ts = Date.UTC(2025, 0, 1, 12) + i * 86_400_000
      rows.push(msg("user", ts))
    }
    writeSession(big, "long", rows)
    const { snapshot } = await ext.usageScanSnapshot({ sessionRoot: big, cachePath: path.join(big, "c.json"), now: Date.UTC(2026, 2, 1) })
    assert.equal(snapshot.days.length, sharedTypes.USAGE_DAYS_MAX)
    assert.equal(snapshot.coverage.truncated, true)
    assert.equal(shared.validateUsageSnapshot(snapshot).ok, true)
  } finally { fs.rmSync(big, { recursive: true, force: true }) }
})

test("extension 与 shared 契约一致：版本/空快照可被 shared 校验；常量一致", async () => {
  assert.equal(ext.USAGE_ACTIVITY_VERSION, sharedTypes.USAGE_ACTIVITY_VERSION)
  assert.equal(ext.USAGE_DAYS_MAX, sharedTypes.USAGE_DAYS_MAX)
  assert.equal(ext.USAGE_MODELS_MAX, sharedTypes.USAGE_MODELS_MAX)
  const empty = ext.usageEmptySnapshot({ deviceId: "dev-1" })
  const v = shared.validateUsageSnapshot(empty)
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.equal(empty.summary.modelsWindowDays, sharedTypes.USAGE_MODELS_MAX === 8 ? 30 : 30)
  // 日期/单位口径：空快照 range 无数据
  assert.equal(empty.range.firstDay, null)
  assert.equal(empty.days.length, 0)
})


test("summary.totals 只累计最近 30 天（本地今天为锚），历史 days 仍保留", async () => {
  const root = mkTemp()
  try {
    // 本地时区安全：用本地年月日构造时间（含今天 / 今天-29 / 今天-40 三个本地日）
    const { localDayKey, addDaysToDayKey } = await import("../ui/src/pi/usage/format.ts")
    const now = Date.now()
    const today = localDayKey(now)
    const dayKeyOf = (key) => { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d, 12, 0, 0).getTime() }
    const todayMs = dayKeyOf(today)
    const edgeMs = dayKeyOf(addDaysToDayKey(today, -29))
    const oldMs = dayKeyOf(addDaysToDayKey(today, -40))
    writeSession(root, "window", [
      sessionRow(todayMs),
      msg("user", oldMs, { id: "old-user" }),
      msg("assistant", oldMs + 1000, { id: "old-a", provider: "oldp", model: "oldm", usage: usageOf(1000) }),
      msg("user", edgeMs, { id: "edge-user" }),
      msg("assistant", edgeMs + 1000, { id: "edge-a", provider: "edgep", model: "edgem", usage: usageOf(7) }),
      msg("user", todayMs - 1000, { id: "today-user" }),
      msg("assistant", todayMs, { id: "today-a", provider: "todayp", model: "todaym", usage: usageOf(3) }),
    ])
    const { snapshot } = await ext.usageScanSnapshot({ sessionRoot: root, cachePath: path.join(root, "c.json"), now })
    assert.equal(snapshot.days.length, 3, "历史 days（40 天前）仍保留")
    assert.equal(snapshot.summary.totals.tokens, 10, "totals 只含近 30 天：7 + 3（不含 40 天前的 1000）")
    assert.equal(snapshot.summary.totals.messagesUser, 2, "近 30 天 user 消息：-29 天 + 今天")
    assert.equal(snapshot.summary.totals.messagesAssistant, 2)
    assert.equal(snapshot.summary.totals.sessions, 1, "会话 header 在今天")
    assert.equal(snapshot.summary.models.reduce((n, m) => n + m.tokens, 0), 10, "模型分布同 30 天窗口")
    assert.equal(snapshot.summary.models.some((m) => m.model === "oldm"), false, "40 天前模型不进近 30 天分布")
    assert.equal(snapshot.summary.modelsWindowDays, 30)
    assert.deepEqual(shared.validateUsageSnapshot(snapshot).ok, true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})


test("streak 与 activeDays 同口径：只有消息、没有新会话的日子也算活跃（跨过 streak 不被切断）", async () => {
  const root = mkTemp()
  try {
    const now = Date.now()
    const { localDayKey: dayKeyOfMs } = await import("../ui/src/pi/usage/format.ts")
    const today = localDayKey(now)
    const dayMs = (key) => { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d, 12, 0, 0).getTime() }
    const d1 = addDaysToDayKey(today, -3)
    const d2 = addDaysToDayKey(today, -2)
    const d3 = addDaysToDayKey(today, -1)
    writeSession(root, "streak-messages", [
      sessionRow(dayMs(d1)), // 只有 d1 有新会话；d2/d3 只有消息（旧实现 activeSet 只含 d1 → 连续被切成 1）
      msg("user", dayMs(d1) + 1000),
      msg("user", dayMs(d2) + 1000),
      msg("assistant", dayMs(d2) + 2000, { usage: usageOf(5) }),
      msg("user", dayMs(d3) + 1000),
    ])
    assert.equal(dayKeyOfMs(dayMs(d1)), d1)
    const { snapshot } = await ext.usageScanSnapshot({ sessionRoot: root, cachePath: path.join(root, "c.json"), now })
    assert.equal(snapshot.summary.totals.activeDays, 3, "近 30 天活跃天=3（d1/d2/d3 都有活动）")
    assert.equal(snapshot.summary.streaks.longest, 3, "最长连续 = 3（消息日跨过无新会话的日子）")
    assert.equal(snapshot.summary.streaks.current, 3, "当前连续 = 3（含昨天）")
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("连续 9 天 + 昨天孤立活跃：longest=9 / current=1（R9 真数据预期口径）", async () => {
  const root = mkTemp()
  try {
    const now = Date.now()
    const today = localDayKey(now)
    const dayMs = (key) => { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d, 12, 0, 0).getTime() }
    // 9 天连续活跃：-14..-6（只有第一天有 session header，其余靠消息算活跃）
    const streakStart = addDaysToDayKey(today, -14)
    const rows = [sessionRow(dayMs(streakStart))]
    for (let i = 0; i < 9; i++) {
      const key = addDaysToDayKey(streakStart, i)
      rows.push(msg("user", dayMs(key) + 1000))
      if (i === 4) rows.push(msg("assistant", dayMs(key) + 2000, { usage: usageOf(10) }))
    }
    // 昨天孤立活跃（今天无活动）→ current 只数到 1
    rows.push(msg("user", dayMs(addDaysToDayKey(today, -1)) + 1000))
    writeSession(root, "streak-nine", rows)
    const { snapshot } = await ext.usageScanSnapshot({ sessionRoot: root, cachePath: path.join(root, "c.json"), now })
    assert.equal(snapshot.summary.streaks.longest, 9, "最长连续 = 9")
    assert.equal(snapshot.summary.streaks.current, 1, "当前连续 = 1（只有昨天活跃）")
    assert.equal(snapshot.summary.totals.activeDays, 10, "近 30 天活跃天 = 9 + 1")
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})


test("peaks.messages 只数 user 消息（不叠加 assistant）：user 峰日 ≠ user+assistant 峰日时取 user", async () => {
  const root = mkTemp()
  try {
    const now = Date.now()
    const today = localDayKey(now)
    const dayMs = (key) => { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d, 12, 0, 0).getTime() }
    const dayA = addDaysToDayKey(today, -2) // user 3 + assistant 100 → 合计 103，但 user 只有 3
    const dayB = addDaysToDayKey(today, -1) // user 10 + assistant 2 → 合计 12，user 峰值 10
    const rows = [sessionRow(dayMs(dayA))]
    for (let i = 0; i < 3; i++) rows.push(msg("user", dayMs(dayA) + i * 1000, { id: `a-u${i}` }))
    for (let i = 0; i < 100; i++) rows.push(msg("assistant", dayMs(dayA) + 10_000 + i * 1000, { id: `a-a${i}`, usage: usageOf(10) })) // 1000 tokens
    for (let i = 0; i < 10; i++) rows.push(msg("user", dayMs(dayB) + i * 1000, { id: `b-u${i}` }))
    for (let i = 0; i < 2; i++) rows.push(msg("assistant", dayMs(dayB) + 20_000 + i * 1000, { id: `b-a${i}`, usage: usageOf(1) }))
    writeSession(root, "peaks", rows)
    const { snapshot } = await ext.usageScanSnapshot({ sessionRoot: root, cachePath: path.join(root, "c.json"), now })
    assert.deepEqual(snapshot.summary.peaks.tokens, { date: dayA, value: 1000 }, "tokens 峰 = 单日 totalTokens 最大日（dayA 1000）")
    assert.deepEqual(snapshot.summary.peaks.messages, { date: dayB, value: 10 }, "messages 峰 = user 消息数最大日（dayB 10）；dayA 合计 103 不应抢")
    assert.equal(snapshot.summary.modelsWindowDays, 30)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
