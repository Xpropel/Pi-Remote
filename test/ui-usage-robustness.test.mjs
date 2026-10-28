// UI·usage 修复回归（纯函数 + 静态接线；不联网、不渲染 React）：
//  - 负时区（美洲）快照不再被整份拒收（validate 有符号偏移）；
//  - 「今天」用快照生成时间 + 设备时区偏移派生，不冒充查看端浏览器时区；
//  - 校验失败不再伪装成「还没有活动」：独立 invalid 原因 + 错误摘要 + 重试入口；
//  - 日级隔离降级：坏一天只丢那一天，结构错误/敏感键仍整份拒收；
//  - 低危回归：非法日历日（2/31）/回帧设备核对/覆盖与快照时间可见/8s 超时口径/未认证出口。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import {
  USAGE_DROPPED_WARNINGS_MAX,
  USAGE_TZ_OFFSET_MAX,
  isUsageDateKey,
  piUsageEmptySnapshot,
  validateUsageSnapshot,
} from "../ui/src/pi/usage/validate.ts"
import {
  addDaysToDayKey,
  dayKeyDiff,
  dayKeyInOffset,
  isValidDayKey,
  snapshotMomentLabel,
  todayDayKey,
  usageCoverageText,
  usageTodayDayKey,
  weekdayOfDayKey,
} from "../ui/src/pi/usage/format.ts"
import { usageFrameDeviceMatches } from "../ui/src/pi/usage/useUsage.ts"
import { USAGE_REQUEST_TIMEOUT_MS, USAGE_VIEWER_TIMEOUT_MS } from "../ui/src/pi/usage/types.ts"

const usageDay = (date, patch = {}) => ({
  date,
  tokens: { total: 10, input: 8, output: 2, cacheRead: 0, cacheWrite: 0 },
  messages: { user: 1, assistant: 1 },
  sessions: 1,
  ...patch,
})

/** 三天空快照骨架（summary/coverage/cache 用 piUsageEmptySnapshot 的合法默认值）。 */
const snapshotOf = (days, generatedAt = Date.UTC(2026, 9, 27, 4, 0, 0), timezone = { id: "Asia/Shanghai", offsetMinutes: 480 }) => {
  const snapshot = piUsageEmptySnapshot({ deviceId: "dev-usage", generatedAt, timezone })
  snapshot.days = days
  snapshot.range = { firstDay: days[0]?.date ?? null, lastDay: days[days.length - 1]?.date ?? null, days: days.length }
  return snapshot
}

test("负时区：美洲 -300 的快照通过校验（与 relay/扩展口径一致）；±14h 边界收、越界拒", () => {
  assert.equal(USAGE_TZ_OFFSET_MAX, 840)
  const ny = piUsageEmptySnapshot({ deviceId: "d-ny", generatedAt: Date.UTC(2026, 9, 28, 2, 0, 0), timezone: { id: "America/New_York", offsetMinutes: -300 } })
  const nyChecked = validateUsageSnapshot(ny)
  assert.equal(nyChecked.ok, true, nyChecked.ok ? "" : nyChecked.errors.join("；"))
  for (const offsetMinutes of [-840, -300, 0, 480, 840]) {
    const snapshot = piUsageEmptySnapshot({ timezone: { id: "tz", offsetMinutes } })
    assert.equal(validateUsageSnapshot(snapshot).ok, true, `offsetMinutes=${offsetMinutes} 应合法`)
  }
  for (const offsetMinutes of [-841, 841, -300.5, 480.5, Number.NaN, Infinity]) {
    const snapshot = piUsageEmptySnapshot({ timezone: { id: "tz", offsetMinutes } })
    assert.equal(validateUsageSnapshot(snapshot).ok, false, `offsetMinutes=${offsetMinutes} 应拒收`)
  }
})

test("日级隔离降级：坏一天只丢那一天，range 按存活天数重建，其余照常放行", () => {
  const snapshot = snapshotOf([usageDay("2026-10-25"), usageDay("2026-10-26", { tokens: { total: -1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }), usageDay("2026-10-27")])
  const checked = validateUsageSnapshot(snapshot)
  assert.equal(checked.ok, true)
  assert.equal(checked.droppedDays, 1)
  assert.deepEqual(checked.snapshot.days.map((day) => day.date), ["2026-10-25", "2026-10-27"])
  assert.deepEqual(checked.snapshot.range, { firstDay: "2026-10-25", lastDay: "2026-10-27", days: 2 }, "range 必须与存活天数一致")
  assert.equal(checked.warnings.length, 1)
  assert.match(checked.warnings[0], /days\[1\]/)
  // 原快照不被就地改写（UI 可能还要拿原始快照做诊断）
  assert.equal(snapshot.range.days, 3)
})

test("日级隔离降级：非法日期/缺字段的天各自丢弃；全坏也不升级成整份拒收", () => {
  const mixedSnapshot = snapshotOf([usageDay("2026-13-40"), usageDay("2026-10-26", { sessions: -2 }), usageDay("2026-10-27")])
  // range 的日期字段本身必须是合法日期（扩展生成时只可能给合法值）；这里模拟真实范围。
  mixedSnapshot.range = { firstDay: "2026-10-26", lastDay: "2026-10-27", days: 2 }
  const mixed = validateUsageSnapshot(mixedSnapshot)
  assert.equal(mixed.ok, true, mixed.ok ? "" : mixed.errors.join("；"))
  assert.equal(mixed.droppedDays, 2)
  assert.deepEqual(mixed.snapshot.days.map((day) => day.date), ["2026-10-27"])
  assert.deepEqual(mixed.snapshot.range, { firstDay: "2026-10-27", lastDay: "2026-10-27", days: 1 })

  const allBad = validateUsageSnapshot(snapshotOf([usageDay("2026-10-25", { messages: null }), usageDay("2026-10-26", { sessions: "1" })]))
  assert.equal(allBad.ok, true)
  assert.equal(allBad.droppedDays, 2)
  assert.deepEqual(allBad.snapshot.days, [])
  assert.deepEqual(allBad.snapshot.range, { firstDay: null, lastDay: null, days: 0 })
})

test("日级隔离只用于单日脏数据：结构错误/敏感键/summary 坏/倒序仍整份拒收", () => {
  const withCostInDay = snapshotOf([usageDay("2026-10-25"), usageDay("2026-10-26", { cost: 0.01 })])
  assert.equal(validateUsageSnapshot(withCostInDay).ok, false, "日对象里出现敏感键仍按隐私红线整份拒收")

  const noSummary = snapshotOf([usageDay("2026-10-25")])
  delete noSummary.summary
  assert.equal(validateUsageSnapshot(noSummary).ok, false)

  const daysNotArray = snapshotOf([usageDay("2026-10-25")])
  daysNotArray.days = { 0: usageDay("2026-10-25") }
  assert.equal(validateUsageSnapshot(daysNotArray).ok, false)

  const unsorted = snapshotOf([usageDay("2026-10-26"), usageDay("2026-10-25")])
  assert.equal(validateUsageSnapshot(unsorted).ok, false, "排序是结构约束，不做任意丢弃")

  const duplicated = snapshotOf([usageDay("2026-10-25"), usageDay("2026-10-25")])
  assert.equal(validateUsageSnapshot(duplicated).ok, false)

  const rangeMismatch = snapshotOf([usageDay("2026-10-25"), usageDay("2026-10-26")])
  rangeMismatch.range.days = 3
  assert.equal(validateUsageSnapshot(rangeMismatch).ok, false, "没有坏天时 range 不一致仍是结构错误")
})

test("日级告警有上限：400 天全坏也不会产出 400 条文案", () => {
  const days = []
  for (let i = 0; i < 120; i += 1) {
    const date = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10)
    days.push(usageDay(date, { tokens: null }))
  }
  const checked = validateUsageSnapshot(snapshotOf(days))
  assert.equal(checked.ok, true)
  assert.equal(checked.droppedDays, 120)
  assert.ok(checked.warnings.length <= USAGE_DROPPED_WARNINGS_MAX + 1, `warnings=${checked.warnings.length}`)
  assert.match(checked.warnings.at(-1), /另有 \d+ 天/)
})

test("「今天」锚点：用快照生成时间 + 设备偏移（负时区跨日），不用查看端时区", () => {
  assert.equal(dayKeyInOffset(Date.UTC(2026, 9, 28, 2, 0, 0), -300), "2026-10-27", "UTC 10-28 02:00 = 纽约 10-27 21:00")
  assert.equal(dayKeyInOffset(Date.UTC(2026, 9, 27, 17, 0, 0), 480), "2026-10-28", "UTC 10-27 17:00 = 上海 10-28 01:00")
  assert.equal(dayKeyInOffset(Date.UTC(2026, 9, 27, 4, 0, 0), 480), "2026-10-27")

  const snapshot = snapshotOf([usageDay("2026-10-25"), usageDay("2026-10-26")], Date.UTC(2026, 9, 28, 2, 0, 0), { id: "America/New_York", offsetMinutes: -300 })
  assert.equal(usageTodayDayKey(snapshot), "2026-10-27", "设备 10-27 生成 → 窗口以 10-27 为今天")
  // 生成时间换算出的日子早于范围末日（时钟/时区异常）：以末日为锚，不能把数据挡在“今天”之后
  assert.equal(
    usageTodayDayKey({ generatedAt: Date.UTC(2026, 9, 20, 2, 0, 0), timezone: { offsetMinutes: -300 }, range: { lastDay: "2026-10-26" } }),
    "2026-10-26",
  )
  // 生成时间缺失：退到快照范围最后一天
  assert.equal(usageTodayDayKey({ range: { lastDay: "2026-10-26" }, days: snapshot.days, timezone: snapshot.timezone }), "2026-10-26")
  // 都没有才退回查看端本地今天
  assert.equal(usageTodayDayKey(null, new Date(2026, 9, 27, 12).getTime()), todayDayKey(new Date(2026, 9, 27, 12).getTime()))
})

test("接线：页面用快照派生今天；校验失败走 invalid + 错误摘要 + 重试（静态断言）", () => {
  const page = fs.readFileSync(new URL("../ui/src/pi/usage/UsageActivityPage.tsx", import.meta.url), "utf8")
  assert.match(page, /const todayKey = usageTodayDayKey\(snapshot\)/, "今天必须由快照派生")
  assert.doesNotMatch(page, /todayDayKey\(\)/, "页面不能再直接用查看端浏览器时区")
  assert.match(page, /invalid: \{ title: "使用活动数据读取失败"/)
  assert.match(page, /reason === "invalid" && errorSummary/, "降级分支要渲染错误摘要")
  assert.match(page, /reason === "timeout" \|\| reason === "invalid"/, "invalid 也要有重试入口")
  assert.match(page, /data-pi-usage-error/)

  const hook = fs.readFileSync(new URL("../ui/src/pi/usage/useUsage.ts", import.meta.url), "utf8")
  assert.match(hook, /setReason\("invalid"\)/, "校验失败必须给独立原因，不能写 no_data")
  assert.doesNotMatch(hook, /setReason\("no_data"\)\s*\n\s*setError\("数据校验失败/, "校验失败不再伪装成没数据")
  assert.match(hook, /usageErrorSummaryOf\(checked\.errors\)/)
  assert.match(hook, /droppedDays > 0 \? usageErrorSummaryOf\(checked\.warnings, checked\.droppedDays\)/)
  assert.match(hook, /setError\(checked\.droppedDays > 0/, "日级降级要把摘要留给页面诊断")
})

test("低危 25 日期校验：2 月 31 日/非闰年 2 月 29 日不再被 Date.parse 归一化后放行", () => {
  assert.equal(isUsageDateKey("2024-02-29"), true, "闰年 2 月 29 日合法")
  for (const bad of ["2026-02-29", "2026-02-31", "2026-04-31", "2026-13-01", "2026-00-10", "2026-1-01", "2026-02-31T00:00:00Z"]) {
    assert.equal(isUsageDateKey(bad), false, `${bad} 必须非法`)
    assert.equal(isValidDayKey(bad), false, `format.isValidDayKey(${bad}) 必须非法`)
  }
  // 校验层：坏日期只丢该天（日级隔离），不会让整份快照失效或进入后续计算
  const badDay = snapshotOf([usageDay("2026-02-31")])
  badDay.range = { firstDay: "2026-02-28", lastDay: "2026-02-28", days: 1 }
  const checked = validateUsageSnapshot(badDay)
  assert.equal(checked.ok, true, checked.ok ? "" : checked.errors.join("；"))
  assert.equal(checked.droppedDays, 1)
  assert.deepEqual(checked.snapshot.days, [])
  assert.deepEqual(checked.snapshot.range, { firstDay: null, lastDay: null, days: 0 })
  // range 日期本身非法仍是结构错误（整份拒收）
  const badRange = snapshotOf([usageDay("2026-03-01")])
  badRange.range.firstDay = "2026-02-31"
  assert.equal(validateUsageSnapshot(badRange).ok, false)
  // 后续计算不再把 2 月 31 日静默换成 3 月 3 日
  assert.equal(addDaysToDayKey("2026-02-31", 1), "2026-02-31")
  assert.ok(Number.isNaN(dayKeyDiff("2026-02-31", "2026-03-03")))
  assert.ok(Number.isNaN(weekdayOfDayKey("2026-02-31")))
})

test("低危 22 回帧设备核对：显式 deviceId 不一致必须拒绝；旧 relay 漏字段按 requestId 兼容", () => {
  assert.equal(usageFrameDeviceMatches({ deviceId: "dev-a" }, "dev-a"), true)
  assert.equal(usageFrameDeviceMatches({ deviceId: " dev-a " }, "dev-a"), true)
  assert.equal(usageFrameDeviceMatches({ deviceId: "dev-b" }, "dev-a"), false, "回错设备不能展示")
  assert.equal(usageFrameDeviceMatches({}, "dev-a"), true, "旧 relay 漏 deviceId：保持兼容")
  assert.equal(usageFrameDeviceMatches({ deviceId: "  " }, "dev-a"), true, "空白等同缺省")
  assert.equal(usageFrameDeviceMatches({ deviceId: "dev-a" }, "  "), false, "没有请求设备时不匹配")
  const hook = fs.readFileSync(new URL("../ui/src/pi/usage/useUsage.ts", import.meta.url), "utf8")
  assert.match(hook, /usageFrameDeviceMatches\(frame, target\)/, "hook 必须在展示前核对回帧设备")
  assert.match(hook, /响应设备与请求设备不一致/)
})

test("低危 23 覆盖/快照时间可见：范围 + 设备时区快照时刻 + 截断/跳过的下限提示", () => {
  const snapshot = snapshotOf([usageDay("2026-10-25"), usageDay("2026-10-26")], Date.UTC(2026, 9, 27, 4, 0, 0), { id: "Asia/Shanghai", offsetMinutes: 480 })
  snapshot.coverage.truncated = true
  snapshot.coverage.skippedFiles = 3
  assert.equal(snapshotMomentLabel(snapshot), "2026-10-27 12:00", "generatedAt 按设备时区（+480）换算")
  assert.equal(snapshotMomentLabel({ generatedAt: Date.UTC(2026, 9, 28, 2, 0, 0), timezone: { offsetMinutes: -300 } }), "2026-10-27 21:00")
  assert.equal(snapshotMomentLabel(null), null)
  const text = usageCoverageText(snapshot)
  assert.match(text, /数据覆盖 2026-10-25 ~ 2026-10-26（2 天有记录）/)
  assert.match(text, /快照 2026-10-27 12:00（设备时间）/)
  assert.match(text, /扫描已截断/)
  assert.match(text, /数字可能只是下限/)
  assert.equal(usageCoverageText(null), null)

  // 未来日期混入（低危 26 的可见告警）：范围末日晚于设备今天
  const future = snapshotOf([usageDay("2026-10-26"), usageDay("2026-10-28")], Date.UTC(2026, 9, 27, 4, 0, 0), { id: "Asia/Shanghai", offsetMinutes: 480 })
  assert.match(usageCoverageText(future), /数据含晚于设备今天的日期，统计可能偏高/)

  // 页面必须把这一行渲染出来（不是只存在 helper 里）
  const page = fs.readFileSync(new URL("../ui/src/pi/usage/UsageActivityPage.tsx", import.meta.url), "utf8")
  assert.match(page, /usageCoverageText\(snapshot\)/)
  assert.match(page, /data-pi-usage-coverage/)
  const css = fs.readFileSync(new URL("../ui/src/pi/usage/usage.css", import.meta.url), "utf8")
  assert.match(css, /\.pi-usage-root \.pi-usage-coverage/)
})

test("低危 24 超时口径：viewer 上限由协议 8s 派生（9s），hook 不再等 12s 硬编码", () => {
  assert.equal(USAGE_REQUEST_TIMEOUT_MS, 8000)
  assert.equal(USAGE_VIEWER_TIMEOUT_MS, USAGE_REQUEST_TIMEOUT_MS + 1000)
  assert.ok(USAGE_VIEWER_TIMEOUT_MS < 12_000)
  const hook = fs.readFileSync(new URL("../ui/src/pi/usage/useUsage.ts", import.meta.url), "utf8")
  assert.match(hook, /USAGE_VIEWER_TIMEOUT_MS/, "hook 必须用共享超时常量")
  assert.doesNotMatch(hook, /12_?000/, "hook 不得再出现 12s 硬编码")
  assert.match(hook, /读取超时（\$\{Math\.round\(USAGE_VIEWER_TIMEOUT_MS \/ 1000\)\} 秒）/)
})

test("低危 27 未认证不再无限 loading：等待上限到点收口成可重试的 timeout，认证恢复后自动重跑", () => {
  const hook = fs.readFileSync(new URL("../ui/src/pi/usage/useUsage.ts", import.meta.url), "utf8")
  assert.match(hook, /authed === false[\s\S]*?setTimeout\([\s\S]*?USAGE_VIEWER_TIMEOUT_MS[\s\S]*?setLoading\(false\)[\s\S]*?setReason\("timeout"\)/, "未认证分支必须有超时出口")
  assert.match(hook, /等待 relay 认证超时/)
  assert.match(hook, /clearTimeout\(authTimer\)/, "认证恢复/卸载要清掉等待定时器")
  // 页面给 timeout 的重试入口（既有接线，防回退）
  const page = fs.readFileSync(new URL("../ui/src/pi/usage/UsageActivityPage.tsx", import.meta.url), "utf8")
  assert.match(page, /reason === "timeout" \|\| reason === "invalid"/)
})
