// 第 5 章通知 V2（M1–M8）的纯 reducer 测试：单槽、队列上限 5、按 key 合并、
// P7 B2e（决定 17）：读 NoticeStack.tsx 的源码用例删了；noticeCore / noticeBridge / noticeStore 的行为用例照旧。
// error 抢占、warning actions、hover/focus 暂停、关闭与槽位准入。
// 不启动浏览器、不依赖 React；Node ≥22.18 直接剥离 TS 类型 import .ts 源文件。
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  NOTICE_QUEUE_LIMIT,
  NOTICE_MAX_VISIBLE,
  NOTICE_MAX_VISIBLE_MOBILE,
  NOTICE_MAX_ACTIONS,
  NOTICE_WARNING_ACTION_TTL_MS,
  announcementFor,
  clearNotices,
  dismissNotice,
  dismissTopNotice,
  emptyNotices,
  noticeActionCloses,
  noticeDedupeKey,
  noticeEntersSlot,
  noticeReducer,
  noticeTtlMs,
  pauseNotice,
  pushNotice,
  resumeNotice,
  retractNoticeScope,
  setNoticeMaxVisible,
  tickNotices,
} from "../ui/src/chat/noticeCore.ts"
import { noticeChannel, noticeLevelForTone } from "../ui/src/chat/composer/noticeBridge.ts"

const ids = (rows) => rows.map((row) => row.id)

function add(state, id, level, now = 0, extra = {}) {
  return pushNotice(state, { id, level, title: id, ...extra }, now)
}

test("V2 默认：同屏 1 张（桌面与移动同口径）、等待队列上限 5", () => {
  assert.equal(NOTICE_MAX_VISIBLE, 1)
  assert.equal(NOTICE_MAX_VISIBLE_MOBILE, 1)
  assert.equal(NOTICE_QUEUE_LIMIT, 5)
  const state = emptyNotices()
  assert.equal(state.maxVisible, 1)
  assert.deepEqual(state.visible, [])
  assert.deepEqual(state.queue, [])
})

test("单槽：warning 挤 info、error 挤 warning，关闭后按 error > warning > info/success 补位", () => {
  let state = emptyNotices()
  state = add(state, "i1", "info", 0)
  state = add(state, "s1", "success", 1)
  state = add(state, "w1", "warning", 2)
  assert.deepEqual(ids(state.visible), ["w1"], "warning 只抢占 info/success")

  state = add(state, "e1", "error", 3)
  assert.deepEqual(ids(state.visible), ["e1"], "error 抢占 warning")
  assert.deepEqual(ids(state.queue), ["w1", "i1", "s1"], "始终只有 1 张可见，队列按级别排序")

  state = dismissNotice(state, "e1", 4)
  assert.deepEqual(ids(state.visible), ["w1"], "error 退场后 warning 补位")
  assert.equal(state.visible[0].expiresAt, 8004, "补位时重新计全量 ttl")

  state = dismissNotice(state, "w1", 5)
  assert.deepEqual(ids(state.visible), ["i1"])
  assert.deepEqual(ids(state.queue), ["s1"])
})

test("M4 合并：同 dedupeKey 不新增卡、以新文案为准、计数 +1、可见时 ttl 从此刻重计", () => {
  let state = emptyNotices()
  state = add(state, "a", "warning", 0, { title: "附件太大了", body: "第一次", dedupeKey: "attach.limit" })
  state = add(state, "b", "warning", 1000, { title: "附件超出限制", body: "第二次", dedupeKey: "attach.limit" })

  assert.equal(state.visible.length, 1, "同 key 不新增")
  const merged = state.visible[0]
  assert.equal(merged.id, "a", "沿用旧 id")
  assert.equal(merged.count, 2)
  assert.equal(merged.title, "附件超出限制")
  assert.equal(merged.body, "第二次")
  assert.equal(merged.expiresAt, 9000, "warning 8s 从合并时刻重计")
  assert.equal(tickNotices(state, 8999).visible.length, 1)
  assert.equal(tickNotices(state, 9000).visible.length, 0)

  const plain = add(emptyNotices(), "p1", "info", 0, { title: "同一文案" })
  const sameText = add(plain, "p2", "info", 10, { title: "同一文案" })
  assert.equal(sameText.visible.length, 1)
  assert.equal(sameText.queue.length, 1, "没有 dedupeKey 时绝不按文案合并")
})

test("M4 合并：排队中的同 key 也合并并保持在队列里", () => {
  let state = emptyNotices()
  state = add(state, "visible", "warning", 0)
  state = add(state, "q", "warning", 1, { title: "旧", dedupeKey: "outbox.pause" })
  state = add(state, "q2", "warning", 2, { title: "新", dedupeKey: "outbox.pause" })

  assert.deepEqual(ids(state.visible), ["visible"])
  assert.deepEqual(ids(state.queue), ["q"])
  assert.equal(state.queue[0].count, 2)
  assert.equal(state.queue[0].title, "新")
})

test("M3 error 抢占：非 error 未展示满 ttl 50% 回队列；超过 50% 直接丢弃", () => {
  let early = add(emptyNotices(), "i", "info", 0)
  early = add(early, "e", "error", 1000)
  assert.deepEqual(ids(early.visible), ["e"])
  assert.deepEqual(ids(early.queue), ["i"], "展示 1s（<2.5s）回队首")

  let late = add(emptyNotices(), "i", "info", 0)
  late = add(late, "e", "error", 4000)
  assert.deepEqual(ids(late.visible), ["e"])
  assert.deepEqual(ids(late.queue), [], "展示 4s（>2.5s）直接丢弃")

  let warning = add(emptyNotices(), "w", "warning", 0)
  warning = add(warning, "e", "error", 7000)
  assert.deepEqual(ids(warning.queue), ["w"], "warning 被抢占后一律回队列")

  let errors = add(emptyNotices(), "e1", "error", 0)
  errors = add(errors, "e2", "error", 1)
  assert.deepEqual(ids(errors.visible), ["e1"], "error 不挤 error")
  assert.deepEqual(ids(errors.queue), ["e2"])
})

test("M5 scope 顶替：同 scope 新通知顶掉可见/排队项，不同 scope 互不影响", () => {
  let state = emptyNotices()
  state = add(state, "down", "warning", 0, { title: "连接已中断", scope: "connection" })
  state = add(state, "up", "success", 2, { title: "已重新连接", scope: "connection" })
  assert.deepEqual(ids(state.visible), ["up"], "恢复通知顶替中断警告")

  let queued = emptyNotices()
  queued = add(queued, "visible", "warning", 0)
  queued = add(queued, "old", "warning", 1, { scope: "connection" })
  queued = add(queued, "new", "success", 2, { scope: "connection" })
  assert.deepEqual(ids(queued.visible), ["visible"], "不同 scope 的可见卡不受影响")
  assert.deepEqual(ids(queued.queue), ["new"], "排队中的旧 scope 也移除")
})

test("M2 队列上限 5：溢出先丢最旧 info/success，其次 warning，最后 error；同 key 不重复", () => {
  let state = add(emptyNotices(), "visible", "warning", 0)
  for (let index = 0; index < 7; index += 1) state = add(state, `i${index}`, "info", index + 1)
  assert.equal(state.visible.length, 1)
  assert.equal(state.visible[0].id, "visible", "info 不抢占 warning")
  assert.equal(state.queue.length, NOTICE_QUEUE_LIMIT, "队列严格封顶 5")
  assert.deepEqual(ids(state.queue), ["i2", "i3", "i4", "i5", "i6"], "丢最旧的两条 info")

  state = add(state, "warn", "warning", 20)
  assert.equal(state.queue.length, 5)
  assert.equal(state.queue.some((row) => row.id === "warn"), true, "有 info 时先丢 info")

  let errors = add(emptyNotices(), "visible-error", "error", 0)
  for (let index = 0; index < 7; index += 1) errors = add(errors, `e${index}`, "error", index + 1)
  assert.equal(errors.queue.length, 5, "队列全为 error 时也守住 5 条上限")
  assert.deepEqual(ids(errors.queue), ["e6", "e5", "e4", "e3", "e2"], "保留最新的 5 条 error")
})

test("M3 warning 抢占：只挤 info/success，不挤 warning/error；info/success 永不抢占", () => {
  let info = add(emptyNotices(), "i", "info", 0)
  info = add(info, "w", "warning", 100)
  assert.deepEqual(ids(info.visible), ["w"], "warning 抢占 info")
  assert.deepEqual(ids(info.queue), ["i"])

  let success = add(emptyNotices(), "s", "success", 0)
  success = add(success, "w", "warning", 100)
  assert.deepEqual(ids(success.visible), ["w"], "warning 抢占 success")

  let warning = add(emptyNotices(), "w1", "warning", 0)
  warning = add(warning, "w2", "warning", 100)
  assert.deepEqual(ids(warning.visible), ["w1"], "warning 不抢占 warning")
  assert.deepEqual(ids(warning.queue), ["w2"])

  let error = add(emptyNotices(), "e", "error", 0)
  error = add(error, "w", "warning", 100)
  assert.deepEqual(ids(error.visible), ["e"], "warning 不抢占 error")
  assert.deepEqual(ids(error.queue), ["w"])

  let noPreempt = add(emptyNotices(), "w", "warning", 0)
  noPreempt = add(noPreempt, "i", "info", 100)
  noPreempt = add(noPreempt, "s", "success", 200)
  assert.deepEqual(ids(noPreempt.visible), ["w"], "info/success 永不抢占")
})

test("M4 合并默认 key：未显式给 dedupeKey 时取首个稳定 code；只认 key 不认文案", () => {
  assert.equal(noticeDedupeKey({ codes: ["composer.ack-timeout", "other"] }), "composer.ack-timeout")
  assert.equal(noticeDedupeKey({ dedupeKey: "explicit", codes: ["code"] }), "explicit")
  assert.equal(noticeDedupeKey({}), null)

  let state = pushNotice(emptyNotices(), { level: "warning", title: "旧文案", codes: ["same.code"] }, 0)
  state = pushNotice(state, { level: "warning", title: "新文案", codes: ["same.code"] }, 1000)
  assert.equal(state.visible.length, 1)
  assert.equal(state.visible[0].count, 2)
  assert.equal(state.visible[0].title, "新文案")
  assert.equal(state.visible[0].dedupeKey, "same.code")
  state = pushNotice(state, { level: "warning", title: "第三次文案", codes: ["same.code"] }, 2000)
  assert.equal(state.visible.length, 1)
  assert.equal(state.visible[0].count, 3, "三连发只一张卡，计数 ×3")
  assert.equal(state.visible[0].expiresAt, 10_000, "ttl 从第三次触发起重新计时")
})

test("M7 准入硬约束：codes/channel 为 progress/connectivity 时 pushNotice 直接拒绝", () => {
  assert.equal(noticeEntersSlot({}), true)
  assert.equal(noticeEntersSlot({ codes: ["other"] }), true)
  for (const code of ["progress", "compaction", "summarization", "truncated", "lazy-send", "connectivity"]) {
    assert.equal(noticeEntersSlot({ codes: [code] }), false, code)
    const state = pushNotice(emptyNotices(), { level: "warning", title: code, codes: [code] }, 0)
    assert.deepEqual(state.visible, [])
    assert.deepEqual(state.queue, [])
  }
  assert.equal(noticeEntersSlot({ channel: "progress" }), false)
  assert.equal(noticeEntersSlot({ channel: "connectivity" }), false)
})

test("M1/M8 warning actions：最多保留两个操作，带操作时 ttl 60s", () => {
  assert.equal(NOTICE_MAX_ACTIONS, 2)
  const input = {
    level: "warning",
    title: "连接不稳定",
    actions: [
      { id: "retry", label: "重试", kind: "primary" },
      { id: "details", label: "详情" },
      { id: "ignore", label: "忽略" },
    ],
  }
  const state = pushNotice(emptyNotices(), input, 0)
  assert.equal(state.visible[0].actions.length, 2, "第三操作被裁掉")
  assert.deepEqual(state.visible[0].actions.map((action) => action.id), ["retry", "details"])
  assert.equal(state.visible[0].expiresAt, NOTICE_WARNING_ACTION_TTL_MS)
})

test("M8 ttl：info 5s / success 4s / warning 8s / warning+actions 60s / error 永不", () => {
  assert.equal(noticeTtlMs("info"), 5000)
  assert.equal(noticeTtlMs("success"), 4000)
  assert.equal(noticeTtlMs("warning"), 8000)
  assert.equal(noticeTtlMs("warning", [{ id: "retry", label: "重试" }]), NOTICE_WARNING_ACTION_TTL_MS)
  assert.equal(noticeTtlMs("error"), null)

  const action = add(emptyNotices(), "a", "warning", 0, { actions: [{ id: "retry", label: "重试" }] })
  assert.equal(action.visible[0].expiresAt, NOTICE_WARNING_ACTION_TTL_MS)
  assert.equal(tickNotices(action, NOTICE_WARNING_ACTION_TTL_MS - 1).visible.length, 1)
  assert.equal(tickNotices(action, NOTICE_WARNING_ACTION_TTL_MS).visible.length, 0)

  const error = add(emptyNotices(), "e", "error", 0)
  assert.equal(tickNotices(error, 10 ** 9).visible.length, 1)
})

test("M8 悬停 / 焦点叠加暂停；全部移出后按剩余时长继续", () => {
  let state = add(emptyNotices(), "a", "info", 0)
  state = pauseNotice(state, "a", "hover", 4000)
  assert.equal(state.visible[0].expiresAt, null)
  assert.equal(state.visible[0].remainingMs, 1000)

  state = pauseNotice(state, "a", "focus", 4100)
  assert.deepEqual(state.visible[0].pausedBy, ["hover", "focus"])
  assert.equal(tickNotices(state, 20_000).visible.length, 1, "暂停期间不消失")

  state = resumeNotice(state, "a", "hover", 20_000)
  assert.deepEqual(state.visible[0].pausedBy, ["focus"])
  state = resumeNotice(state, "a", "focus", 30_000)
  assert.equal(state.visible[0].expiresAt, 31_000)
  assert.equal(tickNotices(state, 30_999).visible.length, 1)
  assert.equal(tickNotices(state, 31_000).visible.length, 0)
})

test("关闭：× / Esc 关最上层 / scope 撤回 / 清空，均按队列补位", () => {
  let state = add(emptyNotices(), "a", "info", 0)
  state = add(state, "b", "warning", 1)
  state = dismissNotice(state, "a", 2000)
  assert.deepEqual(ids(state.visible), ["b"])

  let top = emptyNotices()
  top = add(top, "old", "info", 0)
  top = add(top, "new", "info", 1)
  top = dismissTopNotice(top, 10)
  assert.deepEqual(ids(top.visible), ["new"])

  let scoped = add(emptyNotices(), "conn", "warning", 0, { scope: "connection" })
  scoped = add(scoped, "waiting", "info", 1)
  scoped = retractNoticeScope(scoped, "connection", 10)
  assert.deepEqual(ids(scoped.visible), ["waiting"], "撤回后队列补位")

  const cleared = clearNotices(scoped)
  assert.deepEqual(cleared.visible, [])
  assert.deepEqual(cleared.queue, [])
})

test("响应式上限：从 2 降回 1 时只保留一张，其余回队列", () => {
  let state = emptyNotices({ maxVisible: 2 })
  state = add(state, "a", "info", 0)
  state = add(state, "b", "info", 1)
  state = add(state, "c", "info", 2)
  assert.deepEqual(ids(state.visible), ["a", "b"])

  state = setNoticeMaxVisible(state, 1, 10)
  assert.deepEqual(ids(state.visible), ["a"])
  assert.deepEqual(ids(state.queue), ["b", "c"])
})

test("actions：默认点击关闭、声明 keepOpen 才保留；播报级别按 level 区分", () => {
  assert.equal(noticeActionCloses({ id: "retry", label: "重试" }), true)
  assert.equal(noticeActionCloses({ id: "detail", label: "查看详情", keepOpen: true }), false)
  assert.deepEqual(announcementFor({ level: "error", title: "发送失败", body: "请重试" }), {
    politeness: "assertive",
    text: "发送失败。请重试",
  })
  assert.deepEqual(announcementFor({ level: "warning", title: "连接中断", body: "" }), {
    politeness: "polite",
    text: "连接中断",
  })
})

test("reducer 事件串联：push / pause / resume / tick / dismiss-top / clear", () => {
  let state = emptyNotices()
  state = noticeReducer(state, { type: "push", notice: { id: "a", level: "info", title: "A" }, now: 0 })
  assert.equal(state.visible.length, 1)
  state = noticeReducer(state, { type: "pause", id: "a", reason: "hover", now: 1000 })
  state = noticeReducer(state, { type: "tick", now: 10_000 })
  assert.equal(state.visible.length, 1, "暂停期间 tick 不删卡")
  state = noticeReducer(state, { type: "resume", id: "a", reason: "hover", now: 10_000 })
  state = noticeReducer(state, { type: "tick", now: 14_000 })
  assert.equal(state.visible.length, 0)

  state = noticeReducer(state, { type: "push", notice: { id: "b", level: "error", title: "B" }, now: 14_000 })
  state = noticeReducer(state, { type: "dismiss-top", now: 14_001 })
  assert.equal(state.visible.length, 0)

  state = noticeReducer(state, { type: "clear" })
  assert.deepEqual(state.visible, [])
  assert.deepEqual(state.queue, [])
})

test("M7 槽位准入：progress / connectivity 走状态行，不占通知槽；旧 tone 仍映射正确", () => {
  assert.equal(noticeChannel(["connectivity", "progress"]), "connectivity")
  assert.equal(noticeChannel(["connectivity"]), "connectivity")
  for (const code of ["progress", "compaction", "summarization", "truncated", "lazy-send"]) {
    assert.equal(noticeChannel([code]), "progress", code)
  }
  assert.equal(noticeChannel(["other"]), "stack")
  assert.equal(noticeChannel(), "stack")
  assert.equal(noticeLevelForTone("bad"), "error")
  assert.equal(noticeLevelForTone("warn"), "warning")
})

test("useNotices 不再按桌面/移动放大上限：始终 setMaxVisible(1)", () => {
  const source = readFileSync(new URL("../ui/src/chat/composer/useNotices.ts", import.meta.url), "utf8")
  assert.match(source, /NOTICE_MAX_VISIBLE/)
  assert.doesNotMatch(source, /NOTICE_MAX_VISIBLE_MOBILE/, "V2 两端同口径")
  assert.match(source, /setMaxVisible\(NOTICE_MAX_VISIBLE\)/)
})


test("生命周期只由类型字段决定：源码不得对 title/body 做字符串匹配", () => {
  const source = readFileSync(new URL("../ui/src/chat/noticeCore.ts", import.meta.url), "utf8")
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
  assert.doesNotMatch(code, /(?:title|body)[^\n;]{0,60}\.(?:includes|match|test|search|indexOf)\s*\(/)
  assert.doesNotMatch(code, /new\s+RegExp\s*\([^)]*(?:title|body)/)
})
