import test from "node:test"
import assert from "node:assert/strict"
import { formatTokenCount, formatCount, usageDeltaOf, heatmapScaleOf, localDayKey, dayKeyDiff } from "../ui/src/pi/usage/format.ts"
import { piUsageEmptySnapshot, validateUsageSnapshot } from "../ui/src/pi/usage/validate.ts"

test("formatTokenCount：K/M 缩写（去尾 0、无冗余小数）", () => {
  assert.equal(formatTokenCount(0), "0")
  assert.equal(formatTokenCount(999), "999")
  assert.equal(formatTokenCount(86_400), "86.4K")
  assert.equal(formatTokenCount(12_600_000), "12.6M")
  assert.equal(formatTokenCount(120_000), "120K")
})

test("formatCount：千分位", () => {
  assert.equal(formatCount(3214), "3,214")
})

test("usageDeltaOf：前一窗口无数据 → 数据积累中", () => {
  assert.equal(usageDeltaOf(120, 0).show, false)
  assert.equal(usageDeltaOf(120, 0).text, "数据积累中")
  assert.equal(usageDeltaOf(126, 100).text, "↑26%")
  assert.equal(usageDeltaOf(80, 100).text, "↓20%")
})

test("heatmapScaleOf：分位数分档，0 固定 level 0，大值落最高档", () => {
  const scale = heatmapScaleOf([0, 0, 1, 2, 3, 4, 5, 10, 100, 1000])
  assert.equal(scale.bucketOf(0), 0)
  assert.equal(scale.bucketOf(1000), 4)
  assert.ok(scale.bucketOf(100) >= 3)
})

test("空态快照通过契约校验且带 0 汇总", () => {
  const snapshot = piUsageEmptySnapshot({ deviceId: "d-test" })
  const checked = validateUsageSnapshot(snapshot)
  assert.equal(checked.ok, true)
  assert.equal(snapshot.days.length, 0)
  assert.equal(snapshot.summary.totals.tokens, 0)
  assert.equal(snapshot.range.firstDay, null)
})

test("validateUsageSnapshot：拒绝敏感键（cost/content/cwd）", () => {
  const snapshot = piUsageEmptySnapshot()
  const bad = { ...snapshot, cost: 12 }
  assert.equal(validateUsageSnapshot(bad).ok, false)
})

test("localDayKey/dayKeyDiff：本地自然日", () => {
  const a = localDayKey(new Date(2026, 9, 26, 23, 30).getTime())
  const b = localDayKey(new Date(2026, 9, 27, 0, 10).getTime())
  assert.equal(a, "2026-10-26")
  assert.equal(dayKeyDiff(a, b), 1)
})

test("formatTokenCount：B 档（十亿）与 M 档边界", () => {
  assert.equal(formatTokenCount(2_747_235_645), "2.75B")
  assert.equal(formatTokenCount(890_530_616), "890.5M")
  assert.equal(formatTokenCount(1_000_000_000), "1B")
})

test("生产组件不包含 mock 生成器/假数据（mock 仅在 dev 模块）", async () => {
  const fs = await import("node:fs/promises")
  const product = await fs.readFile(new URL("../ui/src/pi/usage/UsageActivityPage.tsx", import.meta.url), "utf8")
  const index = await fs.readFile(new URL("../ui/src/pi/usage/index.ts", import.meta.url), "utf8")
  for (const marker of ["mockUsageSnapshot", "1103515245", "stepfun/step-5-preview"]) {
    assert.equal(product.includes(marker), false, `生产组件不应包含 ${marker}`)
    assert.equal(index.includes(marker), false, `index 不应导出 mock：${marker}`)
  }
  assert.equal(await fs.readFile(new URL("../ui/src/pi/dev/usage/mock.ts", import.meta.url), "utf8").then((text) => text.includes("mockUsageSnapshot")), true)
})

test("displayOverrides 仅 dev 对图使用：生产挂载不传（静态断言）", async () => {
  const fs = await import("node:fs/promises")
  const settings = await fs.readFile(new URL("../ui/src/pi/variants/claude/pages/ClaudeSettingsPage.tsx", import.meta.url), "utf8")
  const preview = await fs.readFile(new URL("../ui/src/pi/dev/usage/UsagePreview.tsx", import.meta.url), "utf8")
  assert.equal(settings.includes("displayOverrides"), false)
  assert.equal(settings.includes("designTargets"), false)
  assert.equal(preview.includes("displayOverrides"), true)
  assert.equal(preview.includes('params.fixture !== "design"'), true)
})

test("dev 三态 props 仅 devPreview 使用（生产 Settings 不传）", async () => {
  const fs = await import("node:fs/promises")
  const settings = await fs.readFile(new URL("../ui/src/pi/variants/claude/pages/ClaudeSettingsPage.tsx", import.meta.url), "utf8")
  const preview = await fs.readFile(new URL("../ui/src/pi/dev/usage/UsagePreview.tsx", import.meta.url), "utf8")
  assert.equal(settings.includes("previewState"), false)
  assert.equal(settings.includes("previewReason"), false)
  assert.equal(preview.includes("previewState"), true)
  assert.equal(preview.includes("previewReason"), true)
})

test("override 只影响展示：UsageActivityPage 内不把 overrides 用于数据计算", async () => {
  const fs = await import("node:fs/promises")
  const page = await fs.readFile(new URL("../ui/src/pi/usage/UsageActivityPage.tsx", import.meta.url), "utf8")
  assert.equal(page.includes("const totals = snapshot.summary.totals"), true)
  assert.equal(page.includes("windowStreak"), false)
  assert.equal(page.includes("export interface UsageDisplayOverrides"), true)
})


test("fixture 统计行只渲染一次（防重复回归）", async () => {
  const fs = await import("node:fs/promises")
  const page = await fs.readFile(new URL("../ui/src/pi/usage/UsageActivityPage.tsx", import.meta.url), "utf8")
  assert.equal(page.split("pi-usage-fixture-stats").length - 1, 1)
  const css = await fs.readFile(new URL("../ui/src/pi/usage/usage.css", import.meta.url), "utf8")
  assert.equal(css.split(".pi-usage-fixture-stats").length - 1, 1)
})


test("Claude 设置页「使用活动」只挂载一次（防重复渲染 P1 回归）", async () => {
  const fs = await import("node:fs/promises")
  const settings = await fs.readFile(new URL("../ui/src/pi/variants/claude/pages/ClaudeSettingsPage.tsx", import.meta.url), "utf8")
  assert.equal(settings.split("<UsageActivityPage").length - 1, 1)
  assert.equal(settings.split('section === "usage"').length - 1, 1)
  assert.equal(settings.includes('data-pi-usage-host="claude"'), true)
})


test("活跃天数固定 /30 天 + 页脚年度行按 days 派生（不依赖 displayOverrides）", async () => {
  const fs = await import("node:fs/promises")
  const page = await fs.readFile(new URL("../ui/src/pi/usage/UsageActivityPage.tsx", import.meta.url), "utf8")
  assert.equal(page.includes('unit: "/ 30 天"'), true)
  assert.equal(page.includes("value: String(totals.activeDays)"), true)
  assert.equal(page.includes("近一年共使用"), true)
  assert.equal(page.includes("const yearTokens = days.filter"), true)
  assert.equal(page.includes("overrides.yearTokensText ?? (yearTokens > 0"), true)
})


test("连续使用/活跃天数直接消费契约 summary（不在 UI 重算窗口）", async () => {
  const fs = await import("node:fs/promises")
  const page = await fs.readFile(new URL("../ui/src/pi/usage/UsageActivityPage.tsx", import.meta.url), "utf8")
  assert.equal(page.includes("snapshot.summary.streaks.longest"), true)
  assert.equal(page.includes("snapshot.summary.streaks.current"), true)
  assert.equal(page.includes('unit: "/ 30 天"'), true)
  assert.equal(page.includes("value: String(totals.activeDays)"), true)
})


test("tokenDeltaText 只影响 Token 总量卡（消息卡用真实环比）", async () => {
  const fs = await import("node:fs/promises")
  const page = await fs.readFile(new URL("../ui/src/pi/usage/UsageActivityPage.tsx", import.meta.url), "utf8")
  const start = page.indexOf("const summaryCards = [")
  const end = page.indexOf("]", start)
  const block = page.slice(start, end)
  assert.equal(block.split("tokenDeltaText").length - 1, 1)
  assert.equal(block.includes("sub: delta(totals.messagesUser, prevTotals.messages)"), true)
  assert.equal(page.includes("overrides.tokenDeltaText ?? delta(totals.messagesUser"), false)
})

test("design fixture：Token ↑38% override + 消息卡非 override（真实 delta）", async () => {
  const fs = await import("node:fs/promises")
  const preview = await fs.readFile(new URL("../ui/src/pi/dev/usage/UsagePreview.tsx", import.meta.url), "utf8")
  const fixtures = await fs.readFile(new URL("../ui/src/pi/dev/usage/fixtures.ts", import.meta.url), "utf8")
  assert.equal(fixtures.includes('tokenDeltaText: "↑38%"'), true)
  assert.equal(preview.includes("tokenDeltaText: `${targets.tokenDeltaText} 较前 30 天`"), true)
  assert.equal(preview.includes("messagesDelta"), false)
})
