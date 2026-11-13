// S2 第六轮 · 提示：
//   1. N9 回位校验：排队的卡（尤其被挤下去的）上屏前先确认还有效——离最近一次推送超过自己的 ttl（error 2 倍）、
//      或产生它的上下文（room:<id>）已撤回，就丢弃；「已切换到」不再在等待提醒撤回 / 到期后冒出来停 8 秒；
//   2. 压缩出错写人话（与回合出错同一套认法），原始 errorMessage 不进提示；session_compact_failed 不再另报一张；
//   3. 画廊 LiveRoute 的通知栈接口与 useRelay 一一对应（撤回、操作按钮、Esc、清空）。
// 纯 reducer 直接跑；React / useRelay 接线看源码。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"

const core = await import("../ui/src/chat/noticeCore.ts")
const bridge = await import("../ui/src/chat/composer/noticeBridge.ts")
const host = await import("../ui/src/pi/model/settingsHost.ts")
const settings = await import("../ui/src/pi/settings/model.ts")

const read = (p) => fs.readFileSync(new URL(`../ui/src/${p}`, import.meta.url), "utf8")
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
const ids = (items) => items.map((item) => item.id)
const titles = (items) => items.map((item) => item.title)

const gate = host.notificationGateOf(
  settings.mergeSettingsPrefs(settings.createDefaultSettingsPrefs(), { notifyWaiting: true, notifyOnlyWhenAway: false }),
)
const waiting = host.notificationNoticeOf(gate, "waiting", false)
const switched = bridge.legacyNoticeInput({ text: "已切换到「s2」", tone: "warn", context: "room:r2" }, false)
const sticky = { id: "s", level: "warning", title: "本会话已达保存上限", sticky: true }

describe("N9 回位校验", () => {
  test("复现：「已切换到」被等待提醒挤下去；等待提醒撤回时它已过自己的 8s → 不再摆回来", () => {
    let state = core.pushNotice(core.emptyNotices(), switched, 0)
    state = core.pushNotice(state, waiting, 2_600)
    assert.deepEqual(titles(state.visible), ["有任务等你回答"])
    assert.deepEqual(titles(state.queue), ["已切换到「s2」"], "刚被挤下去时还新，回队首")
    const retracted = core.retractNoticeScope(state, host.WAITING_NOTICE_SCOPE, 9_000)
    assert.deepEqual(retracted.visible, [], "撤回等待提醒后不把旧的「已切换到」摆回来")
    assert.deepEqual(retracted.queue, [])
    const expired = core.tickNotices(state, 2_600 + 8_000)
    assert.deepEqual(expired.visible, [], "等待提醒自己到期也一样")
    assert.deepEqual(expired.queue, [])
  })

  test("打断很短（还在自己的 ttl 内）：照常补位，重新计全量 ttl（N7 不变）", () => {
    let state = core.pushNotice(core.emptyNotices(), switched, 0)
    state = core.pushNotice(state, waiting, 1_000)
    state = core.retractNoticeScope(state, host.WAITING_NOTICE_SCOPE, 3_000)
    assert.deepEqual(titles(state.visible), ["已切换到「s2」"])
    assert.equal(state.visible[0].expiresAt, 3_000 + 8_000)
  })

  test("noticeStaleAt：推送时刻 + 自己的 ttl；error 2 倍；带操作按 60s 算；sticky 不过时", () => {
    const at = (level, extra = {}) => core.noticeStaleAt({ level, actions: [], sticky: false, pushedAt: 1_000, ...extra })
    const retry = [{ id: "retry", label: "重试" }]
    assert.equal(at("info"), 6_000)
    assert.equal(at("success"), 5_000)
    assert.equal(at("warning"), 9_000)
    assert.equal(at("error"), 25_000, "被警告打断的错误要能在警告走完后补位（R4）")
    assert.equal(at("warning", { actions: retry }), 61_000)
    assert.equal(at("error", { actions: retry }), 121_000)
    assert.equal(at("error", { sticky: true }), null)
  })

  test("R4 不变：错误被警告打断、警告走完后补位；打断得太久（超过 24s）就不回来了", () => {
    let state = core.pushNotice(core.emptyNotices(), { id: "e", level: "error", title: "回合出错" }, 0)
    state = core.pushNotice(state, { id: "w", level: "warning", title: "同一目录已有会话，已切换到它" }, 5_000)
    assert.deepEqual(ids(core.tickNotices(state, 13_000).visible), ["e"])
    let held = core.pushNotice(core.emptyNotices(), { id: "e", level: "error", title: "回合出错" }, 0)
    held = core.pushNotice(held, { id: "w", level: "warning", title: "有任务等你回答" }, 5_000)
    held = core.pauseNotice(held, "w", "hover", 6_000)
    held = core.resumeNotice(held, "w", "hover", 30_000)
    held = core.tickNotices(held, 30_000 + 7_000)
    assert.deepEqual(held.visible, [], "用户指着警告看了很久：旧错误已是旧闻")
    assert.deepEqual(held.queue, [])
  })

  test("排在常驻卡后面的旧闻到点就清掉（「+N」不算它们）；常驻卡被挤下去不过时，之后回来", () => {
    let state = core.pushNotice(core.emptyNotices(), sticky, 0)
    state = core.pushNotice(state, { id: "i", level: "info", title: "已复制" }, 1_000)
    assert.equal(state.queue.length, 1)
    state = core.tickNotices(state, 6_000)
    assert.deepEqual(state.queue, [])
    assert.deepEqual(ids(state.visible), ["s"])

    let evicted = core.pushNotice(core.emptyNotices(), sticky, 0)
    evicted = core.pushNotice(evicted, { id: "e", level: "error", title: "发送失败" }, 600_000)
    assert.deepEqual(ids(evicted.queue), ["s"])
    evicted = core.tickNotices(evicted, 600_000 + 12_000)
    assert.deepEqual(ids(evicted.visible), ["s"])
  })

  test("合并（N3）算一次新推送：从合并时刻重新起算", () => {
    let state = core.pushNotice(core.emptyNotices(), sticky, 0)
    state = core.pushNotice(state, { level: "info", title: "已复制", dedupeKey: "copy" }, 1_000)
    state = core.pushNotice(state, { level: "info", title: "已复制", dedupeKey: "copy" }, 5_000)
    state = core.tickNotices(state, 7_000)
    assert.equal(state.queue.length, 1)
    assert.equal(state.queue[0].count, 2)
    assert.equal(core.tickNotices(state, 10_000).queue.length, 0)
  })

  test("调用方传的 createdAt 不参与（只看 reducer 自己的推送时刻）", () => {
    let state = core.pushNotice(core.emptyNotices(), sticky, 0)
    state = core.pushNotice(state, { id: "i", level: "info", title: "旧时间戳", createdAt: -1_000_000 }, 1_000)
    assert.equal(state.queue[0].pushedAt, 1_000)
    assert.equal(core.tickNotices(state, 5_000).queue.length, 1)
  })

  test("页面在后台：可见卡照旧冻结（R4）；冻结很久的卡被挤下去时已过时，直接丢不回队首", () => {
    let state = core.pushNotice(core.emptyNotices(), { id: "e", level: "error", title: "回合出错" }, 0)
    state = core.setNoticesHidden(state, true, 1_000)
    assert.equal(core.tickNotices(state, 600_000).visible.length, 1, "后台不过期")
    state = core.pushNotice(state, { id: "w", level: "warning", title: "有任务等你回答" }, 600_000)
    assert.deepEqual(ids(state.visible), ["w"])
    assert.deepEqual(state.queue, [])
  })

  test("上下文撤回：这个上下文里产生、还没轮到的卡一起丢；屏上的照常走完；同上下文不互相顶替（不是 N4）", () => {
    let state = core.pushNotice(core.emptyNotices(), { id: "done", level: "success", title: "任务完成", context: "room:A" }, 0)
    state = core.pushNotice(state, { id: "w", level: "warning", title: "有任务等你回答", scope: host.WAITING_NOTICE_SCOPE }, 1_000)
    assert.deepEqual(ids(state.queue), ["done"])
    state = core.retractNoticeScope(state, "room:A", 2_000)
    assert.deepEqual(state.queue, [], "离开 A：A 里的「任务完成」不会在别的会话里冒出来")
    assert.deepEqual(ids(state.visible), ["w"])

    const shown = core.retractNoticeScope(core.pushNotice(core.emptyNotices(), switched, 0), "room:r2", 1_000)
    assert.deepEqual(titles(shown.visible), ["已切换到「s2」"], "已在屏上的照常走完")

    let both = core.pushNotice(core.emptyNotices(), { id: "x", level: "warning", title: "x", context: "room:A" }, 0)
    both = core.pushNotice(both, { id: "y", level: "warning", title: "y", context: "room:A" }, 100)
    assert.deepEqual(ids(both.visible), ["y"])
    assert.deepEqual(ids(both.queue), ["x"])
  })

  test("store 的计时也盯着排队卡的过时时刻；早到的计时器会重排", () => {
    const store = code(read("chat/composer/noticeStore.ts"))
    assert.match(store, /\.\.\.state\.queue\.map\(noticeStaleAt\)/)
    assert.match(store, /dispatch\(\{ type: "tick", now: Date\.now\(\) \}\)\s*scheduleTick\(\)/)
  })
})

describe("谁带上下文", () => {
  test("旧 setNotice 的 context 原样进栈；没给就不带", () => {
    assert.equal(switched.context, "room:r2")
    assert.equal(switched.level, "warning")
    assert.equal("context" in bridge.legacyNoticeInput({ text: "已复制", tone: "warn" }, false), false)
  })

  test("useRelay：两处「已切换到」带 room:<新会话>；离开会话（clearRoom）按同一个 key 撤回", () => {
    const relay = code(read("relay/useRelay.ts"))
    assert.match(relay, /type Notice = \{ text: string; tone: "warn" \| "bad"; codes\?: NoticeCode\[\]; scope\?: string; context\?: string \} \| null/)
    assert.match(relay, /setNotice\(\{ text: `已切换到「\$\{roomTitle\(picked\.room\)\}」`, tone: "warn", context: `room:\$\{picked\.room\.id\}` \}\)/)
    assert.match(relay, /setNotice\(\{ text: `已切换到「\$\{roomTitle\(switched\)\}」`, tone: "warn", context: `room:\$\{switched\.id\}` \}\)/)
    assert.match(relay, /if \(roomRef\.current\) retractNoticeStack\(`room:\$\{roomRef\.current\}`\)/)
    assert.match(relay, /pushNotice\(legacyNoticeInput\(next, linkDown\)\)/)
  })

  test("回合结果卡带 room:<回合所在会话>；等待提醒是全局的，不带", () => {
    const hook = code(read("pi/hooks/useCompletionNotice.ts"))
    assert.match(hook, /pushNotice\(\{ \.\.\.notice, context: `room:\$\{signal\.roomId\}` \}\)/)
    assert.match(hook, /pushNotice\(notice\)/)
    assert.match(read("pi/model/settingsHost.ts"), /context\?: string/)
  })
})

describe("压缩出错的提示", () => {
  const say = bridge.compactionErrorNotice

  test("模型服务出错：与回合出错同一套认法，原文不进提示", () => {
    const busy = say('Compaction failed: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')
    assert.equal(busy.tone, "bad")
    assert.match(busy.text, /^上下文压缩失败：/)
    assert.match(busy.text, /（529）$/)
    assert.doesNotMatch(busy.text, /overloaded|\{|Compaction/i)
    const auto = say("Auto-compaction failed: 401 Unauthorized")
    assert.match(auto.text, /^上下文压缩失败：.+（401）$/)
    assert.doesNotMatch(auto.text, /Unauthorized|Auto-compaction/)
  })

  test("pi 自己写死的几种结果单独写", () => {
    assert.deepEqual(say("Already compacted"), { text: "上下文刚压缩过，没有新内容可压缩", tone: "warn" })
    assert.deepEqual(say("Nothing to compact (session too small)"), { text: "会话还很短，不需要压缩", tone: "warn" })
    assert.deepEqual(say("Compaction cancelled"), { text: "上下文压缩已中止", tone: "warn" })
    assert.deepEqual(say("Context overflow recovery failed after one compact-and-retry attempt."), {
      text: "压缩后上下文仍超出模型上限，可换用上下文更大的模型",
      tone: "bad",
    })
  })

  test("认不出 / 不是字符串：只写「上下文压缩失败」", () => {
    assert.deepEqual(say("Compaction failed: something odd happened"), { text: "上下文压缩失败", tone: "bad" })
    assert.deepEqual(say(undefined), { text: "上下文压缩失败", tone: "bad" })
    assert.deepEqual(say({ message: "x" }), { text: "上下文压缩失败", tone: "bad" })
  })

  test("useRelay：compaction_end 出错走 compactionErrorNotice；session_compact_failed 不再另报（避免「×2」和中止时的假「失败」）", () => {
    const relay = code(read("relay/useRelay.ts"))
    assert.match(relay, /else if \(event\.errorMessage\) setNotice\(compactionErrorNotice\(event\.errorMessage\)\)/)
    assert.match(relay, /case "session_compact_failed":\s*break/)
    assert.doesNotMatch(relay, /压缩失败：\$\{/)
  })
})

describe("画廊 LiveRoute 的通知栈接线", () => {
  const live = code(read("pi/dev/LiveRoute.tsx"))

  test("与 useRelay 的通知栈接口一一对应，都走真实 store", () => {
    for (const [field, store] of [
      ["pushNotice", "push"],
      ["dismissNotice", "dismiss"],
      ["dismissTopNotice", "dismissTop"],
      ["pauseNotice", "pause"],
      ["resumeNotice", "resume"],
      ["runNoticeAction", "runAction"],
      ["clearNotices", "clear"],
      ["retractNoticeScope", "retract"],
    ]) {
      assert.match(live, new RegExp(`${field}: noticeStore\\.${store},`), field)
    }
    const relay = code(read("relay/useRelay.ts"))
    for (const field of ["dismissTopNotice", "runNoticeAction", "clearNotices", "retractNoticeScope"]) {
      assert.match(relay, new RegExp(`\\b${field}\\b`), `useRelay 也有 ${field}`)
    }
  })

  test("notify=waiting-stop：开弹窗 3 秒后关掉，看等待提醒按 scope 撤回", () => {
    assert.match(live, /kind === "waiting-stop" \? kind : null/)
    assert.match(live, /const waits = notify === "waiting" \|\| notify === "waiting-stop"/)
    assert.match(live, /notify === "waiting-stop" \? window\.setTimeout\(\(\) => setWaitingEvent\(false\), 3600\) : undefined/)
  })
})
