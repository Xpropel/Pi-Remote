// P10.3「使用活动」mock 工装单测（task-27 M1）：
// 1. 四组 fixture 必须通过 arch `usage.activity.v1` 契约校验（`validateUsageSnapshot`）；
// 2. 确定性：重复构建 deepEqual、无 Math.random/Date.now/wall clock；
// 3. normal：设计样张数字（自洽口径）+ 展示串与共享 `format.ts` 完全一致；
// 4. 模型 68/24/8、热力图长尾分档、今天格与最活跃日 tooltip 数据；
// 5. empty / sparse / longtail 边界（0 值、数据积累中、9 天占 80%、前 4 + 其他合并）；
// 6. 静态 JSON 快照（`.agents/.../usage-fixtures/`）与生成器一致、无敏感字段；
// 7. 正式代码不 import fixture JSON；package.json 已注册本测试。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import {
  PI_UI_USAGE_FIXTURES,
  PI_UI_USAGE_FIXTURE_IDS,
  PI_UI_USAGE_STATES,
  PI_UI_USAGE_STATE_IDS,
  PI_UI_USAGE_UNAVAILABLE_REASONS,
  PI_UI_USAGE_MOCK_DEVICE_ID,
  PI_UI_USAGE_MOCK_GENERATED_AT,
  PI_UI_USAGE_MOCK_TIMEZONE,
  PI_UI_USAGE_MOCK_TODAY,
  PI_UI_USAGE_MOCK_YEAR_START,
  formatUsageDayLabel,
  piUiUsageFixtureDayKeys,
  piUiUsageFixtureMeta,
  piUiUsageFixtureMetaOf,
  piUiUsageFixtureOf,
  piUiUsageFixtures,
  piUiUsageLast30Of,
  piUiUsageModelDisplayRows,
  piUiUsageStateMetaOf,
  piUiUsageMonthTokensOf,
  piUiUsagePrev30Of,
  piUiUsageYearTokensOf,
} from "../ui/src/pi/dev/usage/index.ts"
import { validateUsageSnapshot } from "../ui/src/pi/usage/validate.ts"
import { addDaysToDayKey, dayKeyDiff, dayKeyRange, formatCount, formatTokenCount, heatmapScaleOf, usageDeltaOf } from "../ui/src/pi/usage/format.ts"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const REPO_ROOT = (() => {
  try {
    const common = execSync("git rev-parse --git-common-dir", { cwd: ROOT, encoding: "utf8" }).trim()
    return path.dirname(path.resolve(ROOT, common))
  } catch {
    return ROOT
  }
})()
const FIXTURES_DIR = path.join(REPO_ROOT, ".agents/tasks/pi-ui-refs-2026-10-26/usage-fixtures")
const FORBIDDEN_KEYS = new Set(["cost", "content", "cwd", "title", "text", "path", "body", "prompt", "messagesText"])

const collectForbidden = (value, hits = []) => {
  if (Array.isArray(value)) {
    for (const item of value) collectForbidden(item, hits)
    return hits
  }
  if (!value || typeof value !== "object") return hits
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) hits.push(key)
    collectForbidden(child, hits)
  }
  return hits
}

test("五组 fixture 均通过 usage.activity.v1 契约校验", () => {
  assert.deepEqual(PI_UI_USAGE_FIXTURE_IDS, ["design", "realistic", "short", "empty", "longtail"])
  for (const id of PI_UI_USAGE_FIXTURE_IDS) {
    const snapshot = PI_UI_USAGE_FIXTURES[id]
    const result = validateUsageSnapshot(snapshot)
    assert.equal(result.ok, true, `${id} 校验失败：${result.ok ? "" : result.errors.join("；")}`)
    assert.equal(snapshot.v, "usage.activity.v1")
    assert.equal(snapshot.generatedAt, PI_UI_USAGE_MOCK_GENERATED_AT)
    assert.equal(snapshot.deviceId, PI_UI_USAGE_MOCK_DEVICE_ID)
    assert.deepEqual(snapshot.timezone, PI_UI_USAGE_MOCK_TIMEZONE)
    assert.equal(snapshot.summary.modelsWindowDays, 30)
    assert.equal(snapshot.coverage.source, "pi-sessions")
    for (const day of snapshot.days) {
      assert.equal(day.tokens.total, day.tokens.input + day.tokens.output + day.tokens.cacheRead + day.tokens.cacheWrite)
      for (const value of [day.messages.user, day.messages.assistant, day.sessions, day.tokens.total]) assert.ok(Number.isInteger(value) && value >= 0)
    }
  }
})

test("fixture 确定性：重复构建 deepEqual，且生成器无 wall clock/随机", () => {
  const first = piUiUsageFixtures()
  const second = piUiUsageFixtures()
  assert.deepEqual(first, second)
  assert.equal(JSON.stringify(first), JSON.stringify(second))
  for (const id of PI_UI_USAGE_FIXTURE_IDS) assert.deepEqual(PI_UI_USAGE_FIXTURES[id], first[id])
  const genSource = fs.readFileSync(path.join(ROOT, "ui/src/pi/dev/usage/generate.ts"), "utf8")
  assert.equal(/Math\.random\s*\(/.test(genSource), false, "generate.ts 不得用 Math.random()")
  assert.equal(/Date\.now\s*\(/.test(genSource), false, "generate.ts 不得用 Date.now()（固定 generatedAt）")
})

test("design：设计对图样张（严格保留样张数字，显式非自洽）", () => {
  const snapshot = PI_UI_USAGE_FIXTURES.design
  const meta = piUiUsageFixtureMeta().design
  assert.equal(meta.valid, true)
  assert.equal(snapshot.days.length, 365)
  assert.deepEqual(snapshot.range, { firstDay: PI_UI_USAGE_MOCK_YEAR_START, lastDay: PI_UI_USAGE_MOCK_TODAY, days: 365 })
  assert.deepEqual(piUiUsageLast30Of(snapshot), { tokens: 12_600_000, messagesUser: 3_214, sessions: 97, activeDays: 24 })
  assert.deepEqual(piUiUsagePrev30Of(snapshot), { tokens: 9_130_435, messagesUser: 2_870, sessions: 8, activeDays: 8 })
  // 非自洽样张：前 30 天显式提到 9.13M ⇒ days 全年 = 23.5M；设计稿全年 18.9M 只保留在 designTargets
  assert.equal(piUiUsageYearTokensOf(snapshot), 23_530_435)
  assert.equal(meta.display.tokenDelta, "↑38%")
  assert.deepEqual(meta.designTargets, {
    tokenDeltaText: "↑38%",
    yearTokens: 18_900_000,
    monthShareText: "67%",
    peakTokensText: "214K",
    note: "设计稿目标值（非自洽）：对图/验证引用该组；days 派生年度=23.5M/月占 54%，属样张口径差异。",
  })
  assert.deepEqual(snapshot.summary.streaks, { current: 6, longest: 9 })
  assert.equal(piUiUsageMonthTokensOf(snapshot, "2026-10"), 12_600_000)
  // 设计样张：峰值显式覆盖为 214K（日数据真实峰值 1.3M —— 对图样张非自洽，见 README）
  assert.deepEqual(snapshot.summary.peaks.tokens, { date: "2026-10-19", value: 214_000 })
  assert.deepEqual(snapshot.summary.peaks.messages, { date: "2026-10-22", value: 412 })
  const actualPeak = Math.max(...snapshot.days.map((day) => day.tokens.total))
  assert.ok(actualPeak > snapshot.summary.peaks.tokens.value, "design 允许 summary.peaks 覆盖日数据（非自洽样张）")
  const today = snapshot.days.find((day) => day.date === PI_UI_USAGE_MOCK_TODAY)
  assert.ok(today && today.sessions > 0, "normal 必须包含活跃的今天")
  // 今天在近 30 天窗口内
  assert.ok(meta.last30.activeDays === 24)
})


test("realistic：自洽数据（窗口/峰值/全年/前 30 天互证，用于 e2e 与数据正确性）", () => {
  const snapshot = PI_UI_USAGE_FIXTURES.realistic
  const meta = piUiUsageFixtureMeta().realistic
  assert.equal(meta.valid, true)
  assert.equal(snapshot.days.length, 365)
  const last30 = piUiUsageLast30Of(snapshot)
  const prev30 = piUiUsagePrev30Of(snapshot)
  assert.deepEqual(last30, { tokens: 12_600_000, messagesUser: 3_214, sessions: 97, activeDays: 24 })
  assert.deepEqual(prev30, { tokens: 4_500_000, messagesUser: 2_870, sessions: 8, activeDays: 8 })
  assert.deepEqual(meta.last30, last30)
  assert.equal(piUiUsageYearTokensOf(snapshot), 18_900_000)
  assert.equal(piUiUsageMonthTokensOf(snapshot, "2026-10"), 12_600_000)
  assert.ok(piUiUsageYearTokensOf(snapshot) > last30.tokens + prev30.tokens, "全年必须 ≥ 近30天+前30天")
  assert.ok(last30.tokens >= Math.max(...snapshot.days.map((day) => day.tokens.total)), "近 30 天总量必须 ≥ 单日峰值")
  const actualPeakTokens = Math.max(...snapshot.days.map((day) => day.tokens.total))
  const actualPeakMessages = Math.max(...snapshot.days.map((day) => day.messages.user))
  assert.deepEqual(snapshot.summary.peaks.tokens, { date: "2026-10-19", value: actualPeakTokens })
  assert.deepEqual(snapshot.summary.peaks.messages, { date: "2026-10-22", value: actualPeakMessages })
  assert.equal(actualPeakMessages, 412)
  // design 与 realistic 仅差：前 30 天窗口 token 被设计稿覆盖为 9.13M（其余日数据一致）
  const prevWindow = new Set(dayKeyRange(addDaysToDayKey(PI_UI_USAGE_MOCK_TODAY, -59), addDaysToDayKey(PI_UI_USAGE_MOCK_TODAY, -30)))
  const designDays = PI_UI_USAGE_FIXTURES.design.days
  assert.equal(designDays.length, snapshot.days.length)
  snapshot.days.forEach((day, index) => {
    const other = designDays[index]
    assert.equal(other.date, day.date)
    if (!prevWindow.has(day.date)) assert.deepEqual(other, day, `${day.date} 除 design 前 30 天外应与 realistic 一致`)
  })
  assert.equal(meta.display.tokenDelta, "↑180%")
  assert.equal(meta.display.peakTokens?.text, "1.3M")
})

test("design：卡片/环比/页脚展示串与 format.ts 一致（峰值 214K）", () => {
  const meta = piUiUsageFixtureMeta().design
  assert.equal(meta.display.tokens, "12.6M")
  assert.equal(meta.display.messagesUser, "3,214")
  assert.equal(meta.display.activeDays, "24")
  assert.deepEqual(meta.display.streak, { current: 6, longest: 9 })
  assert.equal(meta.display.tokenDelta, "↑38%")
  assert.equal(meta.display.messageDelta, "↑12%")
  assert.equal(meta.display.yearTokens, "23.5M") // days 派生；设计稿 18.9M 见 designTargets
  assert.equal(meta.display.monthTokens, "12.6M")
  assert.equal(meta.display.monthShare, "54%") // days 派生；设计稿 67% 见 designTargets
  assert.equal(meta.display.peakTokens?.date, "2026-10-19")
  assert.equal(meta.display.peakTokens?.dayLabel, formatUsageDayLabel("2026-10-19"))
  assert.equal(meta.display.peakTokens?.text, "214K")
  assert.equal(meta.display.mostActiveMessages?.value, 412)
  assert.equal(meta.display.mostActiveMessages?.text, "412")
  assert.equal(meta.display.mostActiveMessages?.sessions, 17)
  assert.equal(formatUsageDayLabel("2026-10-22"), "10月22日 · 周四")
  // 与 format.ts 直接一致（防 UI 与 mock 各自格式化漂移）
  assert.equal(meta.display.tokens, formatTokenCount(meta.last30.tokens))
  assert.equal(meta.display.messagesUser, formatCount(meta.last30.messagesUser))
  assert.equal(meta.display.tokenDelta, usageDeltaOf(meta.last30.tokens, meta.prev30?.tokens ?? 0).text)
  assert.equal(meta.display.messageDelta, usageDeltaOf(meta.last30.messagesUser, meta.prev30?.messagesUser ?? 0).text)
})

test("design：最活跃日 tooltip 数据（86.4K / 412 条 / 17 次）+ 模型 68/24/8 + 长尾分档", () => {
  const snapshot = PI_UI_USAGE_FIXTURES.design
  const day = snapshot.days.find((entry) => entry.date === "2026-10-22")
  assert.ok(day)
  assert.equal(formatTokenCount(day.tokens.total), "86.4K")
  assert.equal(day.messages.user, 412)
  assert.equal(day.sessions, 17)
  const meta = piUiUsageFixtureMeta().design
  assert.deepEqual(
    meta.display.models.map((row) => [row.label, row.pctText]),
    [
      ["step-5-preview", "68%"],
      ["step-3.7-flash", "24%"],
      ["gpt-6.1-sol", "8%"],
    ],
  )
  assert.equal(snapshot.summary.models.reduce((sum, row) => sum + row.tokens, 0), 12_600_000)
  // 热力图分档：365 格 = 82 个有量日 + 283 个空白；today 有量、落 1–4 档
  assert.equal(meta.heatmap.positiveDays, 82)
  assert.equal(meta.heatmap.levels[0], 283)
  assert.equal(meta.heatmap.levels.reduce((sum, count) => sum + count, 0), 365)
  assert.ok(meta.heatmap.todayLevel >= 1 && meta.heatmap.todayLevel <= 4)
  assert.equal(piUiUsageFixtureDayKeys(snapshot).length, 365)
})

test("empty：空态快照不报错，零值/空数组/null 齐全", () => {
  const snapshot = PI_UI_USAGE_FIXTURES.empty
  const meta = piUiUsageFixtureMeta().empty
  assert.equal(meta.valid, true)
  assert.equal(snapshot.days.length, 0)
  assert.deepEqual(snapshot.range, { firstDay: null, lastDay: null, days: 0 })
  assert.deepEqual(snapshot.summary.totals, { tokens: 0, messagesUser: 0, messagesAssistant: 0, sessions: 0, activeDays: 0 })
  assert.deepEqual(snapshot.summary.streaks, { current: 0, longest: 0 })
  assert.equal(snapshot.summary.peaks.tokens, null)
  assert.equal(snapshot.summary.peaks.messages, null)
  assert.deepEqual(snapshot.summary.models, [])
  assert.deepEqual(piUiUsageLast30Of(snapshot), { tokens: 0, messagesUser: 0, sessions: 0, activeDays: 0 })
  assert.equal(meta.prev30, null)
  assert.equal(meta.display.tokens, "0")
  assert.equal(meta.display.messagesUser, "0")
  assert.equal(meta.display.tokenDelta, "数据积累中")
  assert.equal(meta.display.monthShare, "0%")
  assert.deepEqual(meta.heatmap.levels, [0, 0, 0, 0, 0])
  const scale = heatmapScaleOf([], 5)
  assert.deepEqual(scale.thresholds, [])
  assert.equal(scale.bucketOf(0), 0)
})

test("short：<30 天 → 数据积累中 + 当前连续 3 天 + 12 天窗口", () => {
  const snapshot = PI_UI_USAGE_FIXTURES.short
  const meta = piUiUsageFixtureMeta().short
  assert.equal(meta.valid, true)
  assert.equal(snapshot.days.length, 12)
  assert.equal(snapshot.range.days, 12)
  assert.equal(snapshot.range.lastDay, PI_UI_USAGE_MOCK_TODAY)
  assert.equal(meta.prev30, null)
  assert.equal(meta.display.tokenDelta, "数据积累中")
  assert.equal(meta.display.messageDelta, "数据积累中")
  assert.deepEqual(snapshot.summary.streaks, { current: 3, longest: 4 })
  assert.equal(meta.display.activeDays, "12")
  // 日期严格升序且在最近 14 天内
  const dates = snapshot.days.map((day) => day.date)
  assert.deepEqual(dates, [...dates].sort())
  assert.equal(new Set(dates).size, dates.length)
  const today = snapshot.days.find((day) => day.date === PI_UI_USAGE_MOCK_TODAY)
  assert.ok(today && today.sessions > 0)
})

test("longtail：9 个高峰日占 80% 总量 + 前 4 + 其他合并", () => {
  const snapshot = PI_UI_USAGE_FIXTURES.longtail
  const meta = piUiUsageFixtureMeta().longtail
  assert.equal(meta.valid, true)
  assert.equal(snapshot.days.length, 365)
  const heavy = snapshot.days.filter((day) => day.tokens.total === 1_680_000)
  assert.equal(heavy.length, 9)
  assert.equal(piUiUsageYearTokensOf(snapshot), 18_900_000)
  assert.equal(meta.heatmap.positiveDays, 129) // 120 低用量日 + 9 高峰日
  assert.equal(meta.heatmap.levels[0], 236)
  const scale = heatmapScaleOf(snapshot.days.map((day) => day.tokens.total), 5)
  for (const day of heavy) assert.equal(scale.bucketOf(day.tokens.total), 4, `${day.date} 应为最高档`)
  const display = piUiUsageModelDisplayRows(snapshot.summary.models, 4)
  assert.equal(snapshot.summary.models.length, 8)
  assert.equal(display.length, 5) // 前 4 + 其他
  assert.deepEqual(display.map((row) => row.pctText ?? "").length, 5)
  const other = display[display.length - 1]
  assert.equal(other.other, true)
  assert.equal(other.label, "其他模型")
  assert.deepEqual(display.slice(0, 4).map((row) => Math.round(row.share * 100)), [68, 24, 4, 2])
  assert.equal(Math.round(other.share * 100), 2)
})


test("error / unavailable 状态 fixture：available=false + 五 reason + capabilityMissing", () => {
  assert.deepEqual(PI_UI_USAGE_STATE_IDS, ["error", "unavailable"])
  assert.deepEqual(PI_UI_USAGE_UNAVAILABLE_REASONS, ["no_data", "device_offline", "unsupported", "timeout", "stale"])
  assert.deepEqual(PI_UI_USAGE_STATES.error, { kind: "error", id: "error", message: "使用活动数据拉取失败", retryable: true })
  for (const reason of PI_UI_USAGE_UNAVAILABLE_REASONS) {
    const state = PI_UI_USAGE_STATES.unavailable[reason]
    assert.equal(state.kind, "unavailable")
    assert.equal(state.reason, reason)
    assert.equal(state.capabilityMissing, reason === "unsupported")
    const meta = piUiUsageStateMetaOf("unavailable", reason)
    assert.equal(meta.available, false)
    assert.equal(meta.state, "unavailable")
    assert.equal(meta.reason, reason)
  }
  const errorMeta = piUiUsageStateMetaOf("error")
  assert.equal(errorMeta.state, "error")
  assert.equal(errorMeta.available, false)
  assert.equal(errorMeta.reason, null)
})

test("realistic 覆盖跨年、首尾不完整周；日期工具覆盖闰日（2024-02-29）", () => {
  const snapshot = PI_UI_USAGE_FIXTURES.realistic
  const dates = new Set(snapshot.days.map((day) => day.date))
  assert.ok(dates.has("2025-12-31") && dates.has("2026-01-01"), "必须跨年")
  assert.ok(dates.has(PI_UI_USAGE_MOCK_YEAR_START) && dates.has(PI_UI_USAGE_MOCK_TODAY))
  const firstWeekday = new Date(`${PI_UI_USAGE_MOCK_YEAR_START}T00:00:00Z`).getUTCDay()
  const lastWeekday = new Date(`${PI_UI_USAGE_MOCK_TODAY}T00:00:00Z`).getUTCDay()
  assert.notEqual(firstWeekday, 1, "首日不是周一 → 首周不完整")
  assert.notEqual(lastWeekday, 0, "末日不是周日 → 末周不完整")
  const leap = dayKeyRange("2024-02-28", "2024-03-01")
  assert.deepEqual(leap, ["2024-02-28", "2024-02-29", "2024-03-01"])
  assert.equal(addDaysToDayKey("2024-02-28", 1), "2024-02-29")
  assert.equal(dayKeyDiff("2024-02-28", "2024-03-01"), 2)
})

test("静态 JSON 快照与生成器一致、无敏感字段（本地验收必须存在）", (t) => {
  if (!fs.existsSync(FIXTURES_DIR)) {
    t.skip(`未找到 ${FIXTURES_DIR}；先跑 node 开发工具（未随公开仓提供）`)
    return
  }
  const readme = fs.readFileSync(path.join(FIXTURES_DIR, "README.md"), "utf8")
  assert.match(readme, /usage\.activity\.v1/)
  for (const id of PI_UI_USAGE_FIXTURE_IDS) {
    const file = path.join(FIXTURES_DIR, `${id}.json`)
    assert.ok(fs.existsSync(file), `缺 ${id}.json`)
    const raw = fs.readFileSync(file, "utf8")
    const parsed = JSON.parse(raw)
    assert.deepEqual(parsed, PI_UI_USAGE_FIXTURES[id], `${id}.json 与生成器输出不一致（重跑 gen-usage-fixtures.mjs）`)
    assert.deepEqual(collectForbidden(parsed), [])
    assert.equal(validateUsageSnapshot(parsed).ok, true)
  }
  const statesFile = path.join(FIXTURES_DIR, "states.json")
  assert.ok(fs.existsSync(statesFile), "缺 states.json")
  const states = JSON.parse(fs.readFileSync(statesFile, "utf8"))
  assert.equal(states.error.kind, "error")
  assert.deepEqual(states.unavailable.map((state) => state.reason), [...PI_UI_USAGE_UNAVAILABLE_REASONS])
  assert.deepEqual(collectForbidden(states), [])
})

test("正式代码不 import usage-fixtures JSON（dev-only 生成器才是唯一数据源）", () => {
  const offenders = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue
        walk(file)
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        const source = fs.readFileSync(file, "utf8")
        if (/(?:from\s*|import\s*\()\s*["'][^"']*usage-fixtures/.test(source)) offenders.push(path.relative(ROOT, file))
      }
    }
  }
  walk(path.join(ROOT, "ui/src"))
  assert.deepEqual(offenders, [])
})


test("生产隔离：变体/设置页不引用 dev fixture 与 dev overrides；页面组件不引用 pi/dev", () => {
  const offenders = []
  const walk = (dir, forbidden) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue
        walk(file, forbidden)
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        // 只扫代码（去掉注释，避免文档注释里的 dev 说明误报）
        const source = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
        for (const pattern of forbidden) {
          if (pattern.test(source)) offenders.push({ file: path.relative(ROOT, file), term: String(pattern) })
        }
      }
    }
  }
  // 1) 三套变体（生产挂载）不得引用 mock fixture / dev overrides / dev preview
  walk(path.join(ROOT, "ui/src/pi/variants"), [/PI_UI_USAGE_FIXTURES/, /designTargets/, /displayOverrides/, /previewState/, /previewReason/, /devPreview/, /usage-fixtures/])
  // 2) Settings 挂载的 <UsageActivityPage> 标签不得传 dev 专用 props
  const mountChecks = []
  for (const file of ["ui/src/pi/variants/claude/pages/ClaudeSettingsPage.tsx", "ui/src/pi/variants/codex/pages/CodexSettingsPage.tsx", "ui/src/pi/usage/PiSettingsUsageMount.tsx"]) {
    const full = path.join(ROOT, file)
    if (!fs.existsSync(full)) continue
    const source = fs.readFileSync(full, "utf8")
    for (const match of source.match(/<UsageActivityPage[\s\S]*?\/?>/g) ?? []) {
      if (/snapshot=|displayOverrides=|previewState=|previewReason=/.test(match)) mountChecks.push({ file, tag: match.replace(/\s+/g, " ").slice(0, 160) })
    }
  }
  // 3) 产品共享页（@/pi/usage）不得 import dev mock / fixture
  walk(path.join(ROOT, "ui/src/pi/usage"), [/pi\/dev\/usage/, /PI_UI_USAGE_FIXTURES/, /designTargets/, /usage-fixtures/, /devPreview/])
  assert.deepEqual(offenders, [])
  assert.deepEqual(mountChecks, [])
})

test("package.json 已注册本测试（npm test 覆盖）", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))
  assert.ok(pkg.scripts.test.includes("test/pi-ui-usage-mock.test.mjs"))
})

test("fixture 选择回退与 meta 一致性", () => {
  assert.equal(piUiUsageFixtureOf("nope").id, "realistic")
  assert.equal(piUiUsageFixtureOf("normal").id, "realistic", "旧称 normal = realistic")
  assert.equal(piUiUsageFixtureOf("sparse").id, "short", "旧称 sparse = short")
  assert.equal(piUiUsageFixtureOf("empty").snapshot.days.length, 0)
  assert.equal(piUiUsageFixtureMetaOf("empty").display.tokens, "0")
  const metas = piUiUsageFixtureMeta()
  for (const id of PI_UI_USAGE_FIXTURE_IDS) {
    assert.equal(metas[id].valid, true)
    assert.deepEqual(metas[id].validationErrors, [])
    assert.equal(metas[id].id, id)
  }
})
