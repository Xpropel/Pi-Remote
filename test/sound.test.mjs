// R5-4 补测：第 1 轮完成提示音的声音消费决策逻辑（此前零用例）。
// sound.ts 本体耦合 React / 偏好读取 / WebAudio，决策部分已最小抽取到纯模块
// soundDecision.ts（零导入），这里直接驱动它验行为；sound.ts 侧的接线
// （双闸实参现读、hook 消费回路、按谱排程）用源码断言钉住，与
// quick-settings / context-ring 的接线断言同法。不启动浏览器、不依赖 React。
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  completionSoundGate,
  decideTurnEndSound,
  toneSpecsFor,
} from "../ui/src/chat/composer/soundDecision.ts"

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
const soundTs = source("../ui/src/chat/composer/sound.ts")

/* ---------------- 双闸：开关 × 页面不在场 ---------------- */

test("提示音双闸：开关关时不响（在不在场都不响）", () => {
  assert.equal(completionSoundGate({ enabled: false, away: true }), false)
  assert.equal(completionSoundGate({ enabled: false, away: false }), false)
})

test("提示音双闸：开关开但页面在场时不响", () => {
  assert.equal(completionSoundGate({ enabled: true, away: false }), false)
})

test("提示音双闸：开关开且页面不在场才放行发声", () => {
  assert.equal(completionSoundGate({ enabled: true, away: true }), true)
})

/* ---------------- turnEnd 消费决策：seq 去重 / 静默消费 ---------------- */

test("提示音消费：失焦到达的新 seq 消费且响 done", () => {
  const d = decideTurnEndSound({ seq: 7, error: false, consumedSeq: 0, away: true })
  assert.deepEqual(d, { consume: true, kind: "done" })
})

test("提示音消费：聚焦时静默消费——消费但不响，之后失焦不补响", () => {
  // 聚焦时到达：seq 被记为已消费，kind=null（静默）。
  const focused = decideTurnEndSound({ seq: 7, error: false, consumedSeq: 0, away: false })
  assert.deepEqual(focused, { consume: true, kind: null })
  // 同一 seq 之后页面失焦再评估：已消费，不得补响、不得重复消费。
  const laterAway = decideTurnEndSound({ seq: 7, error: false, consumedSeq: 7, away: true })
  assert.deepEqual(laterAway, { consume: false, kind: null })
})

test("提示音消费：同一 seq 只消费一次，失焦重复评估不重响", () => {
  const first = decideTurnEndSound({ seq: 3, error: false, consumedSeq: 0, away: true })
  assert.deepEqual(first, { consume: true, kind: "done" })
  const again = decideTurnEndSound({ seq: 3, error: false, consumedSeq: 3, away: true })
  assert.deepEqual(again, { consume: false, kind: null })
})

test("提示音消费：新 seq 才再响（逐回合推进）", () => {
  const first = decideTurnEndSound({ seq: 3, error: false, consumedSeq: 0, away: true })
  assert.equal(first.kind, "done")
  const next = decideTurnEndSound({ seq: 4, error: false, consumedSeq: 3, away: true })
  assert.deepEqual(next, { consume: true, kind: "done" })
})

/* ---------------- 音色分流：error 与 done ---------------- */

test("提示音消费：error 结束走 error 音色，done 走 done 音色", () => {
  const err = decideTurnEndSound({ seq: 9, error: true, consumedSeq: 0, away: true })
  assert.deepEqual(err, { consume: true, kind: "error" })
  const ok = decideTurnEndSound({ seq: 9, error: false, consumedSeq: 0, away: true })
  assert.deepEqual(ok, { consume: true, kind: "done" })
  // 聚焦时 error 信号同样只是静默消费，不因 error 而破例发声。
  const errFocused = decideTurnEndSound({ seq: 9, error: true, consumedSeq: 0, away: false })
  assert.deepEqual(errFocused, { consume: true, kind: null })
})

test("提示音音色谱：done 单音上行，error 双音下行，参数互不相同", () => {
  const done = toneSpecsFor("done")
  assert.deepEqual(done, [{ from: 587, to: 880, at: 0, dur: 0.18 }])
  assert.ok(done[0].to > done[0].from, "done 必须上行")

  const error = toneSpecsFor("error")
  assert.deepEqual(error, [
    { from: 262, to: 247, at: 0, dur: 0.11 },
    { from: 196, to: 185, at: 0.13, dur: 0.17 },
  ])
  assert.ok(error.every((t) => t.to < t.from), "error 必须双音下行")
  assert.notDeepEqual(toneSpecsFor("done"), toneSpecsFor("error"))
})

/* ---------------- sound.ts 接线：决策函数的实参口径 ---------------- */

test("提示音接线：playCompletionSound 的双闸实参是现读开关 + pageAway 同源口径", () => {
  // P13：设置 v2 传入 enabled；未传时仍现读旧键 completionSoundEnabled()，不许缓存成状态。
  assert.match(soundTs, /const enabled = options\.enabled \?\? completionSoundEnabled\(\)/)
  assert.match(soundTs, /completionSoundGate\(\{ enabled, away: pageAway\(\), requireAway: options\.requireAway !== false \}\)/)
  assert.doesNotMatch(soundTs, /useState\(completionSoundEnabled/)
  // P7 B4：style/prefs.ts 删了，提示音开关改读 pi/hooks/useLegacyStyle（同一个旧键 pi_remote_style、同一口径）
  assert.match(soundTs, /loadLegacyStyle\(\)\.completionSound === true/)
})

test("提示音接线：hook 经 decideTurnEndSound 消费 seq，kind 非空才发声", () => {
  assert.match(soundTs, /decideTurnEndSound\(\{[\s\S]*?seq: signal\.seq,[\s\S]*?error: signal\.error,[\s\S]*?consumedSeq: consumedRef\.current,[\s\S]*?away,[\s\S]*?awayOnly: onlyWhenAway,[\s\S]*?\}\)/)
  assert.match(soundTs, /if \(!decision\.consume\) return/)
  assert.match(soundTs, /consumedRef\.current = signal\.seq/)
  assert.match(soundTs, /if \(decision\.kind\) playCompletionSound\(decision\.kind, \{ enabled: soundEnabled, requireAway: onlyWhenAway \}\)/)
  // 信号仍按当前房间过滤（与角标同源），别房信号不进决策。
  assert.match(soundTs, /relay\.turnEnd\.roomId === relay\.roomId/)
})

test("设置 v2 提示音：事件类型关闭 / 提示音关闭 / 仅页面外 都静默消费", () => {
  const always = { seq: 12, error: false, consumedSeq: 0, away: false, awayOnly: false }
  assert.equal(decideTurnEndSound(always).kind, "done", "总是提醒：页面在场也响")
  assert.equal(decideTurnEndSound({ ...always, enabled: false }).kind, null, "提示音关闭")
  assert.equal(decideTurnEndSound({ ...always, doneEnabled: false }).kind, null, "任务完成时关闭")
  assert.equal(decideTurnEndSound({ ...always, error: false, errorEnabled: false }).kind, "done", "出错关闭不影响完成")
  assert.equal(decideTurnEndSound({ ...always, error: true, errorEnabled: false }).kind, null, "出错时关闭")
  assert.equal(decideTurnEndSound({ ...always, awayOnly: true }).kind, null, "仅页面外：在场不响")
  assert.equal(completionSoundGate({ enabled: true, away: false, requireAway: false }), true)
  assert.equal(completionSoundGate({ enabled: true, away: false, requireAway: true }), false)
})

test("提示音接线：playTones 按 toneSpecsFor 逐音排程，未解锁仍静默跳过", () => {
  assert.match(soundTs, /for \(const spec of toneSpecsFor\(kind\)\) scheduleTone\(ctx, spec\)/)
  assert.match(soundTs, /if \(!ctx \|\| ctx\.state !== "running"\) return false/)
  // 试听不走双闸：仍直接 playTones，不得经 playCompletionSound 被开关拦下。
  const testSoundBody = soundTs.split("export function playTestSound")[1].split("export function useCompletionSound")[0]
  assert.match(testSoundBody, /playTones\(kind\)/)
  assert.ok(!/playCompletionSound/.test(testSoundBody), "试听不得走双闸入口")
})
