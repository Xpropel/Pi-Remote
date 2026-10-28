// R3-6 上下文用量圆环：呈现决策（contextRingOf）fixture 验 + 状态行接线断言。
// P7 B2f（决定 8、17）：读旧 ComposerFooter（chat/ui.tsx、settings.css）的两个接线用例删了；用量改查新界面：ComposerContainer 用 relay/contextUsage 的 contextReadout，交给 PiComposerStatusRow（末尾一条）。
// 决策口径：有可信比例才上环且比例与 contextReadout.percent 一致；
// none / untrusted / 窗口可信但无用量 → 不上环，只呈诚实文本。
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { contextReadout, contextRingOf } from "../ui/src/relay/contextUsage.ts"

test("圆环：可信窗口时比例与 contextReadout.percent 一致", () => {
  const half = contextReadout({ tokens: 64000, contextWindow: 128000, percent: 50 })
  assert.equal(half.state, "ok")
  const ring = contextRingOf(half.percent)
  assert.ok(ring != null)
  assert.equal(ring.fraction, half.percent)
  assert.equal(ring.fraction, 0.5)
  assert.equal(ring.tone, "ok")

  const tiny = contextReadout({ tokens: 1561, contextWindow: 1_000_000, percent: 0.1561 })
  const tinyRing = contextRingOf(tiny.percent)
  assert.ok(tinyRing != null)
  assert.ok(Math.abs(tinyRing.fraction - tiny.percent) < 1e-12)
  assert.equal(tinyRing.tone, "ok")
})

test("圆环：色调阈值 ≥70% 警告、≥90% 危险", () => {
  assert.equal(contextRingOf(0.69)?.tone, "ok")
  assert.equal(contextRingOf(0.7)?.tone, "warn")
  assert.equal(contextRingOf(0.89)?.tone, "warn")
  assert.equal(contextRingOf(0.9)?.tone, "bad")
})

test("圆环：超 100% 满格，真实百分比仍由文案保留", () => {
  const overflow = contextReadout({ tokens: 200000, contextWindow: 128000, percent: 156.25 })
  assert.ok(overflow.percent > 1)
  const ring = contextRingOf(overflow.percent)
  assert.ok(ring != null)
  assert.equal(ring.fraction, 1)
  assert.equal(ring.tone, "bad")
  assert.equal(overflow.label, "上下文 156.3%")
})

test("圆环：none / untrusted / 无用量时不上环（诚实态只呈文本）", () => {
  const none = contextReadout(null)
  assert.equal(none.state, "none")
  assert.equal(contextRingOf(none.percent), null)

  const untrusted = contextReadout({ tokens: 1561, contextWindow: 1280, percent: 122 })
  assert.equal(untrusted.state, "untrusted")
  assert.equal(untrusted.percent, null)
  assert.equal(contextRingOf(untrusted.percent), null)
  assert.match(untrusted.label, /窗口未知/)
  assert.equal(untrusted.label.includes("%"), false)

  const noFraction = contextReadout({ contextWindow: 200000 })
  assert.equal(noFraction.state, "ok")
  assert.equal(noFraction.percent, null)
  assert.equal(contextRingOf(noFraction.percent), null)
  assert.equal(noFraction.label, "窗口 200,000")

  assert.equal(contextRingOf(null), null)
  assert.equal(contextRingOf(undefined), null)
  assert.equal(contextRingOf(Number.NaN), null)
})


test("圆环百分比结构化出口（R4-3②）：labelParts 只在有可信比例时拆出数字段", () => {
  // 恒等式：label === before + (percent ?? "") + after，四态都成立
  const cases = [
    contextReadout({ tokens: 64000, contextWindow: 128000, percent: 50 }),
    contextReadout({ tokens: 200000, contextWindow: 128000, percent: 156.25 }),
    contextReadout(null),
    contextReadout({ tokens: 1561, contextWindow: 1280, percent: 122 }),
    contextReadout({ contextWindow: 200000 }),
  ]
  for (const readout of cases) {
    const { before, percent, after } = readout.labelParts
    assert.equal(readout.label, before + (percent ?? "") + after)
  }

  // 有可信比例：数字段即 percentText 原文，前缀为「上下文 」
  const half = contextReadout({ tokens: 64000, contextWindow: 128000, percent: 50 })
  assert.deepEqual(half.labelParts, { before: "上下文 ", percent: "50%", after: "" })

  // 超 100%：原文案保留，数字段同样拆出（呈现层同样加粗）
  const overflow = contextReadout({ tokens: 200000, contextWindow: 128000, percent: 156.25 })
  assert.equal(overflow.label, "上下文 156.3%")
  assert.deepEqual(overflow.labelParts, { before: "上下文 ", percent: "156.3%", after: "" })

  // 诚实态三态：percent 恒 null、before 即整串 label，呈现与拆分前逐字一致
  const none = contextReadout(null)
  assert.deepEqual(none.labelParts, { before: "", percent: null, after: "" })
  const untrusted = contextReadout({ tokens: 1561, contextWindow: 1280, percent: 122 })
  assert.equal(untrusted.labelParts.percent, null)
  assert.equal(untrusted.labelParts.before, untrusted.label)
  const noFraction = contextReadout({ contextWindow: 200000 })
  assert.equal(noFraction.labelParts.percent, null)
  assert.equal(noFraction.labelParts.before, "窗口 200,000")
})
test("圆环接线（P7 B2f 改查新界面）：ComposerContainer 用 contextReadout 算用量，PiComposerStatusRow 画 PiContextRing", () => {
  const container = readFileSync(new URL("../ui/src/pi/containers/ComposerContainer.tsx", import.meta.url), "utf8")
  const statusRow = readFileSync(new URL("../ui/src/components/pi/composer/PiComposerStatusRow.tsx", import.meta.url), "utf8")
  assert.match(container, /import \{ contextReadout \} from "@\/relay\/contextUsage"/)
  assert.match(container, /context: contextReadout\(relay\.usage\?\.contextUsage\)/)
  assert.match(statusRow, /PiContextRing/)
})
