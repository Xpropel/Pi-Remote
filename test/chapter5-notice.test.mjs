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
  setNoticesHidden,
  tickNotices,
} from "../ui/src/chat/noticeCore.ts"
import { legacyNoticeInput, NOTICE_LINK_DOWN_SCOPE, noticeChannel, noticeLevelForTone } from "../ui/src/chat/composer/noticeBridge.ts"

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
  state = add(state, "q", "info", 1, { title: "旧", dedupeKey: "outbox.pause" })
  state = add(state, "q2", "info", 2, { title: "新", dedupeKey: "outbox.pause" })

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
  assert.deepEqual(ids(errors.visible), ["e2"], "R4：新 error 先上屏")
  assert.deepEqual(ids(errors.queue), ["e1"], "旧 error 回队首，不丢")
})

test("M5 scope 顶替：同 scope 新通知顶掉可见/排队项，不同 scope 互不影响", () => {
  let state = emptyNotices()
  state = add(state, "down", "warning", 0, { title: "连接已中断", scope: "connection" })
  state = add(state, "up", "success", 2, { title: "已重新连接", scope: "connection" })
  assert.deepEqual(ids(state.visible), ["up"], "恢复通知顶替中断警告")

  let queued = emptyNotices()
  queued = add(queued, "visible", "warning", 0)
  queued = add(queued, "old", "info", 1, { scope: "connection" })
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
  assert.deepEqual(ids(state.visible), ["warn"], "R4：新 warning 先上屏")
  assert.equal(state.queue[0].id, "visible", "被挤的 warning 回队首；有 info 时先丢 info")

  let errors = add(emptyNotices(), "visible-error", "error", 0)
  for (let index = 0; index < 7; index += 1) errors = add(errors, `e${index}`, "error", index + 1)
  assert.equal(errors.queue.length, 5, "队列全为 error 时也守住 5 条上限")
  assert.deepEqual(ids(errors.visible), ["e6"], "最新的 error 在屏上")
  assert.deepEqual(ids(errors.queue), ["e5", "e4", "e3", "e2", "e1"], "队列保留其后最新的 5 条，最早的丢弃")
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
  assert.deepEqual(ids(warning.visible), ["w2"], "R4：新 warning 抢占旧 warning")
  assert.deepEqual(ids(warning.queue), ["w1"])

  let error = add(emptyNotices(), "e", "error", 0)
  error = add(error, "w", "warning", 100)
  assert.deepEqual(ids(error.visible), ["w"], "R4：新 warning 不被旧 error 压在「+1」后面")
  assert.deepEqual(ids(error.queue), ["e"])

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

test("M8 ttl：info 5s / success 4s / warning 8s / error 12s / 带 actions 60s / sticky 永不", () => {
  assert.equal(noticeTtlMs("info"), 5000)
  assert.equal(noticeTtlMs("success"), 4000)
  assert.equal(noticeTtlMs("warning"), 8000)
  assert.equal(noticeTtlMs("warning", [{ id: "retry", label: "重试" }]), NOTICE_WARNING_ACTION_TTL_MS)
  assert.equal(noticeTtlMs("error"), 12_000)
  assert.equal(noticeTtlMs("error", [{ id: "retry", label: "重试" }]), NOTICE_WARNING_ACTION_TTL_MS)
  assert.equal(noticeTtlMs("error", [], true), null)

  const action = add(emptyNotices(), "a", "warning", 0, { actions: [{ id: "retry", label: "重试" }] })
  assert.equal(action.visible[0].expiresAt, NOTICE_WARNING_ACTION_TTL_MS)
  assert.equal(tickNotices(action, NOTICE_WARNING_ACTION_TTL_MS - 1).visible.length, 1)
  assert.equal(tickNotices(action, NOTICE_WARNING_ACTION_TTL_MS).visible.length, 0)

  const error = add(emptyNotices(), "e", "error", 0)
  assert.equal(tickNotices(error, 11_999).visible.length, 1)
  assert.equal(tickNotices(error, 12_000).visible.length, 0, "R4：error 不再常驻")
  const sticky = add(emptyNotices(), "cap", "error", 0, { sticky: true })
  assert.equal(tickNotices(sticky, 10 ** 9).visible.length, 1, "sticky 持续状态不自动消失")
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


test("R4 优先级：需要处理的新警告不被旧错误压在「+1」后面；旧错误回队首、到期后补位", () => {
  let state = add(emptyNotices(), "turn-error", "error", 0, { title: "回合出错" })
  state = add(state, "already-running", "warning", 5_000, { title: "同一目录已有会话，已切换到它" })
  assert.deepEqual(ids(state.visible), ["already-running"], "新警告立即上屏")
  assert.deepEqual(ids(state.queue), ["turn-error"], "旧错误不丢，回队首")
  state = tickNotices(state, 5_000 + 8_000)
  assert.deepEqual(ids(state.visible), ["turn-error"], "警告到期后旧错误补位")
  assert.equal(state.visible[0].expiresAt, 13_000 + 12_000, "补位后重新计全量 12s")
  // info / success 仍然永不抢占
  const calm = add(add(emptyNotices(), "e", "error", 0), "s", "success", 10)
  assert.deepEqual(ids(calm.visible), ["e"])
})

test("R4 用户正指着 / 聚焦的卡不被抢：新卡排到队首，移开后按剩余时长走完再补位", () => {
  let state = add(emptyNotices(), "reading", "warning", 0)
  state = pauseNotice(state, "reading", "focus", 1_000)
  state = add(state, "newer", "error", 2_000)
  assert.deepEqual(ids(state.visible), ["reading"], "焦点在卡上：不换卡，焦点不丢")
  assert.deepEqual(ids(state.queue), ["newer"])
  state = resumeNotice(state, "reading", "focus", 3_000)
  state = tickNotices(state, 3_000 + 7_000)
  assert.deepEqual(ids(state.visible), ["newer"])
})

test("R4 页面隐藏：倒计时冻结（含隐藏期间新上屏的），回到前台按剩余时长继续", () => {
  let state = add(emptyNotices(), "a", "error", 0)
  state = setNoticesHidden(state, true, 2_000)
  assert.equal(state.hidden, true)
  assert.deepEqual(state.visible[0].pausedBy, ["hidden"])
  assert.equal(tickNotices(state, 10 ** 7).visible.length, 1, "后台不过期")
  state = setNoticesHidden(state, false, 100_000)
  assert.equal(state.visible[0].expiresAt, 100_000 + 10_000, "回来后只剩 10s")

  let hidden = noticeReducer(emptyNotices(), { type: "set-hidden", hidden: true, now: 0 })
  hidden = noticeReducer(hidden, { type: "push", notice: { id: "done", level: "success", title: "任务完成" }, now: 50 })
  assert.equal(hidden.visible[0].expiresAt, null, "后台推来的提示上屏即冻结")
  assert.equal(tickNotices(hidden, 60_000).visible.length, 1)
  hidden = noticeReducer(hidden, { type: "set-hidden", hidden: false, now: 60_000 })
  assert.equal(hidden.visible[0].expiresAt, 64_000, "用户回来后才开始走 4s")
  // hover 与 hidden 叠加：回到前台仍在悬停就继续停
  let both = add(emptyNotices(), "b", "info", 0)
  both = pauseNotice(both, "b", "hover", 100)
  both = setNoticesHidden(both, true, 200)
  both = setNoticesHidden(both, false, 300)
  assert.deepEqual(both.visible[0].pausedBy, ["hover"])
  assert.equal(both.visible[0].expiresAt, null)

  const store = readFileSync(new URL("../ui/src/chat/composer/noticeStore.ts", import.meta.url), "utf8")
  assert.match(store, /document\.addEventListener\("visibilitychange", syncPageHidden\)/, "store 跟随页面可见性")
  assert.match(store, /type: "set-hidden", hidden: document\.visibilityState === "hidden"/)
})

test("R4 旧 setNotice 进栈：同级同文案连发合并 ×n；断线期间归 link-down，同 scope 新顶旧，重连撤回", () => {
  const offline = legacyNoticeInput({ text: "连接不可用", tone: "bad" }, true)
  assert.deepEqual(offline, { level: "error", title: "连接不可用", scope: NOTICE_LINK_DOWN_SCOPE, dedupeKey: "legacy:error:连接不可用" })
  const online = legacyNoticeInput({ text: "连接不可用", tone: "bad" }, false)
  assert.equal(online.scope, undefined, "在线时不归 link-down")
  assert.equal(legacyNoticeInput({ text: "x", tone: "warn", scope: "room:r1" }, true).scope, "room:r1", "调用方自带 scope 优先")

  let state = pushNotice(emptyNotices(), offline, 0)
  state = pushNotice(state, offline, 100)
  assert.equal(state.visible.length + state.queue.length, 1, "同一提示连发不多占一格")
  assert.equal(state.visible[0].count, 2)
  state = pushNotice(state, legacyNoticeInput({ text: "发送失败", tone: "bad" }, true), 200)
  assert.deepEqual(state.visible.map((item) => item.title), ["发送失败"])
  assert.equal(state.queue.length, 0, "断线期间的旧提示被新的顶替，不排成「+1」")
  state = pushNotice(state, legacyNoticeInput({ text: "关于本地的另一条提示", tone: "warn" }, false), 300)
  state = retractNoticeScope(state, NOTICE_LINK_DOWN_SCOPE, 400)
  assert.deepEqual(state.visible.map((item) => item.title), ["关于本地的另一条提示"], "重连撤回只收 link-down 的")
  assert.equal(state.queue.length, 0)

  const relay = readFileSync(new URL("../ui/src/relay/useRelay.ts", import.meta.url), "utf8")
  assert.match(relay, /const linkDown = !authedRef\.current \|\| wsRef\.current\?\.readyState !== WebSocket\.OPEN/)
  assert.match(relay, /pushNotice\(legacyNoticeInput\(next, linkDown\)\)/)
  const authOk = relay.slice(relay.indexOf('if (type === "auth_result")'), relay.indexOf("const info = serverInfo(msg)"))
  assert.match(authOk, /retractNoticeStack\(NOTICE_LINK_DOWN_SCOPE\)/, "auth_result ok 时撤回")
})

test("R4 层级：通知槽在 raised 层，菜单（popover）/ sheet / 弹窗都盖在它上面", () => {
  const shell = readFileSync(new URL("../ui/src/components/pi/shared/PiShell.tsx", import.meta.url), "utf8")
  const theme = readFileSync(new URL("../ui/src/components/pi/shared/pi-theme.css", import.meta.url), "utf8")
  const slots = [...shell.matchAll(/data-pi-notice-slot=""\s+className="([^"]+)"/g)].map((match) => match[1])
  assert.equal(slots.length, 2, "桌面 + 手机两个通知槽")
  for (const cls of slots) {
    assert.match(cls, /z-\(--cw-pi-z-raised\)/)
    assert.doesNotMatch(cls, /z-\(--cw-pi-z-(?:popover|sheet|modal|chrome)\)/)
  }
  const z = (name) => Number(theme.match(new RegExp(`--cw-pi-z-${name}: (\\d+);`))?.[1])
  assert.ok(z("raised") < z("popover") && z("popover") < z("sheet") && z("sheet") < z("modal"))
})

test("生命周期只由类型字段决定：源码不得对 title/body 做字符串匹配", () => {
  const source = readFileSync(new URL("../ui/src/chat/noticeCore.ts", import.meta.url), "utf8")
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
  assert.doesNotMatch(code, /(?:title|body)[^\n;]{0,60}\.(?:includes|match|test|search|indexOf)\s*\(/)
  assert.doesNotMatch(code, /new\s+RegExp\s*\([^)]*(?:title|body)/)
})
