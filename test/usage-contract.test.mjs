// P10 契约/协议/格式化测试（纯函数 + 静态契约，不联网）：
// shared validate/format + protocol cap/limits 同步 + extension/relay 镜像常量 + useRelay 帧入口静态断言。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  formatTokenCount, formatCount, usageDeltaOf, heatmapScaleOf,
  localDayKey, addDaysToDayKey, dayKeyDiff, weekdayOfDayKey, dayKeyRange,
} from "../ui/src/pi/usage/format.ts"
import { validateUsageSnapshot, piUsageEmptySnapshot, USAGE_SENSITIVE_KEY_POLICY } from "../ui/src/pi/usage/validate.ts"
import { USAGE_ACTIVITY_VERSION, USAGE_DAYS_MAX, USAGE_MODELS_MAX, USAGE_SNAPSHOT_MAX_BYTES, USAGE_REQUEST_TIMEOUT_MS, USAGE_CACHE_TTL_MS } from "../ui/src/pi/usage/types.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")
const proto = JSON.parse(read("protocol/v4.json"))
const relayProto = JSON.parse(read("relay/protocol.json"))

test("格式化：Token K/M、千分位、环比、热力图分位数（长尾）", () => {
  assert.equal(formatTokenCount(0), "0")
  assert.equal(formatTokenCount(999), "999")
  assert.equal(formatTokenCount(1000), "1K")
  assert.equal(formatTokenCount(1530), "1.5K")
  assert.equal(formatTokenCount(86400), "86.4K")
  assert.equal(formatTokenCount(12_600_000), "12.6M")
  assert.equal(formatCount(3214), "3,214")
  assert.deepEqual(usageDeltaOf(120, 100), { show: true, dir: "up", ratio: 0.2, text: "↑20%" })
  assert.equal(usageDeltaOf(100, 0).show, false, "前一窗口无数据不显示环比")
  assert.equal(usageDeltaOf(100, 0).text, "数据积累中")
  // 长尾：90 个 1 + 5 个 100 + 1 个 10000；分位数分档后大值必须进最高档
  const values = [...Array(90).fill(1), ...Array(5).fill(100), 10000]
  const scale = heatmapScaleOf(values)
  assert.equal(scale.levels, 5)
  assert.equal(scale.bucketOf(0), 0)
  assert.equal(scale.bucketOf(10000), 4)
  assert.ok(scale.thresholds.length >= 1)
  assert.equal(scale.bucketOf(1) <= scale.bucketOf(10000), true)
})

test("本地日键/加减/星期/区间：跨月、星期与 366 天窗口", () => {
  assert.match(localDayKey(Date.UTC(2026, 9, 27, 4, 0, 0)), /^2026-10-2[67]$/)
  assert.equal(addDaysToDayKey("2026-10-31", 1), "2026-11-01")
  assert.equal(addDaysToDayKey("2026-01-01", -1), "2025-12-31")
  assert.equal(dayKeyDiff("2026-10-01", "2026-10-27"), 26)
  assert.equal(weekdayOfDayKey("2026-10-27"), 2, "2026-10-27 是周二")
  const range = dayKeyRange("2026-10-25", "2026-10-27")
  assert.deepEqual(range, ["2026-10-25", "2026-10-26", "2026-10-27"])
  assert.equal(dayKeyRange("2026-01-01", "2026-12-31").length, 365)
})

test("校验：空快照合法；敏感键/倒序日期/cost 一律拒绝；快照超限拒绝", () => {
  const empty = piUsageEmptySnapshot({ deviceId: "d1" })
  assert.equal(validateUsageSnapshot(empty).ok, true)
  assert.deepEqual(USAGE_SENSITIVE_KEY_POLICY.includes("cost"), true)
  const withCost = piUsageEmptySnapshot({ deviceId: "d1" })
  withCost.days = [{ date: "2026-10-20", tokens: { total: 1, input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, messages: { user: 1, assistant: 0 }, sessions: 1 }]
  withCost.range = { firstDay: "2026-10-20", lastDay: "2026-10-20", days: 1 }
  withCost.summary.totals.tokens = 1
  withCost.cost = 0.01
  assert.equal(validateUsageSnapshot(withCost).ok, false)
  const unsorted = piUsageEmptySnapshot({ deviceId: "d1" })
  unsorted.days = [
    { date: "2026-10-21", tokens: { total: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, messages: { user: 0, assistant: 0 }, sessions: 1 },
    { date: "2026-10-20", tokens: { total: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, messages: { user: 0, assistant: 0 }, sessions: 1 },
  ]
  unsorted.range = { firstDay: "2026-10-21", lastDay: "2026-10-20", days: 2 }
  assert.equal(validateUsageSnapshot(unsorted).ok, false)
  // 超限：models 8 行 × 超大字符串
  const big = piUsageEmptySnapshot({ deviceId: "d1" })
  big.summary.models = Array.from({ length: USAGE_MODELS_MAX }, (_, i) => ({ provider: "p".repeat(20000), model: "m".repeat(20000) + i, tokens: i }))
  assert.equal(validateUsageSnapshot(big).ok, false)
})

test("协议：usage.activity.v1 cap/limits 三处同步（v4.json / relay 副本 / extension PROTOCOL+CLIENT_CAPS / relay caps）", () => {
  assert.equal(USAGE_ACTIVITY_VERSION, "usage.activity.v1")
  assert.equal(typeof proto.caps["usage.activity.v1"], "string")
  assert.equal(proto.limits.usageDaysMax, USAGE_DAYS_MAX)
  assert.equal(proto.limits.usageModelsMax, USAGE_MODELS_MAX)
  assert.equal(proto.limits.usageSnapshotMaxBytes, USAGE_SNAPSHOT_MAX_BYTES)
  assert.equal(proto.limits.usageRequestTimeoutMs, USAGE_REQUEST_TIMEOUT_MS)
  assert.deepEqual(relayProto, proto, "relay/protocol.json 必须与 v4.json 同步")
  const extSrc = read("extension/pi-remote-sync.ts")
  assert.match(extSrc, /const CLIENT_CAPS = \[[^\]]*"usage\.activity\.v1"/)
  assert.match(extSrc, /"usage\.activity\.v1": "/, "extension PROTOCOL 块含 cap 说明（sync.cjs 生成）")
  assert.match(read("relay/wire.js"), /"usage\.activity\.v1"/, "relay RELAY_CAPS 声明")
  assert.match(read("relay/usage.js"), /USAGE_CACHE_TTL_MS = 5 \* 60 \* 1000/, "缓存 TTL 5min")
})

test("UI 接口约定：useRelay 暴露 getUsage；useUsageActivity 来自 @/pi/usage，且不造假数据", () => {
  const relaySrc = read("ui/src/relay/useRelay.ts")
  assert.match(relaySrc, /const getUsage = useCallback/)
  assert.match(relaySrc, /type: "usage_get"/)
  assert.match(relaySrc, /if \(type === "usage_snapshot"\)/)
  const bar = read("ui/src/pi/usage/index.ts")
  assert.match(bar, /useUsageActivity/)
  const hook = read("ui/src/pi/usage/useUsage.ts")
  for (const needle of ["export function useUsageActivity", "\"unsupported\"", "\"no_data\"", "validateUsageSnapshot", "snapshot: UsageSnapshotV1 | null"]) assert.ok(hook.includes(needle), needle)
  // hook 不自造数据：不允许出现字面量 totals 0 当作真实快照返回（只允许空态 reason）
  assert.doesNotMatch(hook, /tokens:\s*0/)
})
