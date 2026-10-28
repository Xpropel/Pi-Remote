// 第 5 章发送状态机 S0–S7 / 键盘分流 / 同 tick 并发锁的纯逻辑测试。
// P7 B2e（决定 17）：读旧 composer 部件 / composer.css 的 3 个用例删了（键帽提示时机、复制 morph、V2 CSS 契约）；纯逻辑用例照旧。
// 不启动浏览器、不依赖 React；Node ≥22.18 直接剥离 TS 类型 import .ts 源文件。
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  ACK_TIMEOUT_MS,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_TOTAL_BYTES,
  COMPOSER_TEXT_MAX,
  S4_SEND_MODE,
  acquireInFlight,
  createSendLock,
  decideEnter,
  decideEscape,
  deriveComposer,
  expireInFlight,
  inFlightExpired,
  placeholderFor,
  releaseInFlight,
} from "../ui/src/chat/composerMachine.ts"
import { deliveryPlan } from "../ui/src/chat/composerTools.ts"
import {
  BACK_TO_BOTTOM_SCROLL_MS,
  BACK_TO_BOTTOM_SIZE_PX,
  BACK_TO_BOTTOM_SMOOTH_MAX_PX,
  BACK_TO_BOTTOM_THRESHOLD_PX,
  COPY_FEEDBACK_HOLD_MS,
  HOVER_REVEAL_IN_MS,
  HOVER_REVEAL_OUT_MS,
  KBD_FONT_PX,
  MOTION_LOOP_BUDGET,
  PRESS_MS,
  PRESS_SCALE,
  SENDING_HINT_DELAY_MS,
  SESSION_SWITCH_MS,
  SESSION_SWITCH_OFFSET_PX,
  SLASH_ROW_HEIGHT_PX,
  TOOLTIP_FIRST_DELAY_MS,
  TOOLTIP_WARM_WINDOW_MS,
  backToBottomPlan,
  backToBottomVisible,
  connectionChip,
  copyFeedbackAfter,
  selectLoopBudget,
  sendingHintVisible,
} from "../ui/src/chat/composer/interaction.ts"

const IDLE = { draft: "", online: true, deviceOnline: true, deviceName: "MacBook" }

test("S0：空输入不可发但可输入；桌面占位含 Enter，移动端永不含键名", () => {
  const desktop = deriveComposer(IDLE)
  assert.equal(desktop.state, "S0")
  assert.equal(desktop.canSend, false)
  assert.equal(desktop.canType, true)
  assert.equal(desktop.sendKind, "none")
  assert.equal(desktop.delivery, null)
  assert.equal(desktop.stopVisible, false)
  assert.equal(desktop.blockReason, "empty")
  assert.equal(desktop.placeholder, "给 MacBook 上的 Pi 发消息，Enter 发送…")

  const mobile = deriveComposer({ ...IDLE, mobile: true })
  assert.equal(mobile.placeholder, "给 MacBook 上的 Pi 发消息…")
  assert.equal(mobile.placeholder.includes("Enter"), false, "移动端占位不得出现键名")

  const unknown = deriveComposer({})
  assert.equal(unknown.placeholder, "给本机 Pi 发消息，Enter 发送…")

  assert.equal(deriveComposer({ ...IDLE, draft: "   \n\t " }).state, "S0", "仅空白仍是 S0")
})

test("S0–S7 全部可达，且 S1 走 prompt、S2 锁发送但保留输入", () => {
  const states = [
    deriveComposer(IDLE).state,
    deriveComposer({ ...IDLE, draft: "你好" }).state,
    deriveComposer({ ...IDLE, draft: "下一条", sending: true }).state,
    deriveComposer({ ...IDLE, generating: true }).state,
    deriveComposer({ ...IDLE, generating: true, draft: "排队" }).state,
    deriveComposer({ ...IDLE, online: false, draft: "离线写" }).state,
    deriveComposer({ ...IDLE, draft: "重试", failurePulse: true, lastFailure: { retryable: true } }).state,
    deriveComposer({ ...IDLE, revoked: true }).state,
  ]
  assert.deepEqual(states, ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7"])

  const ready = deriveComposer({ ...IDLE, draft: "你好" })
  assert.equal(ready.canSend, true)
  assert.equal(ready.canType, true)
  assert.equal(ready.blockReason, null)
  assert.equal(ready.sendKind, "send")
  assert.deepEqual(ready.delivery, deliveryPlan("auto", false))
  assert.equal(ready.delivery.command, "prompt")

  const sending = deriveComposer({ ...IDLE, draft: "继续打字", sending: true })
  assert.equal(sending.state, "S2")
  assert.equal(sending.canSend, false, "S2 锁住发送动作")
  assert.equal(sending.canType, true, "S2 不锁输入")
  assert.equal(sending.sendKind, "none")
  assert.equal(sending.delivery, null)
  assert.equal(sending.blockReason, "sending")
  assert.equal(sending.placeholder, "正在发送，可继续输入…")
  assert.equal(decideEnter({ ui: sending }).action, "noop", "S2 再按 Enter 静默无操作")

  const sendingWhileGenerating = deriveComposer({ ...IDLE, draft: "排队", sending: true, generating: true })
  assert.equal(sendingWhileGenerating.state, "S2")
  assert.equal(sendingWhileGenerating.stopVisible, true, "生成中不能因为等 ack 把停止键藏掉")
})

test("S3/S4：生成中空草稿只有停止；有草稿时发送键与停止键并存，且投递固定 follow_up", () => {
  const empty = deriveComposer({ ...IDLE, generating: true })
  assert.equal(empty.state, "S3")
  assert.equal(empty.canSend, false)
  assert.equal(empty.stopVisible, true)
  assert.equal(empty.sendKind, "none")
  assert.equal(empty.placeholder, "Pi 正在回复，输入后 Enter 将排队发送…")

  const queued = deriveComposer({ ...IDLE, generating: true, draft: "等会再说" })
  assert.equal(queued.state, "S4")
  assert.equal(queued.canSend, true)
  assert.equal(queued.stopVisible, true, "S4 发送键与停止键并存")
  assert.equal(queued.sendKind, "queue")
  assert.deepEqual(queued.delivery, deliveryPlan("follow_up", true))
  assert.equal(queued.delivery.command, "follow_up")
  assert.equal(S4_SEND_MODE, "follow_up")
  assert.equal(deliveryPlan("auto", true).command, "steer", "默认 auto 在忙时是 steer，S4 不能复用它")
  assert.notDeepEqual(queued.delivery, deliveryPlan("auto", true))
  assert.equal(decideEnter({ ui: queued }).action, "queue")

  const mobile = deriveComposer({ ...IDLE, generating: true, draft: "等会", mobile: true })
  assert.equal(mobile.placeholder, "Pi 正在回复，可继续输入…")
  assert.equal(mobile.placeholder.includes("Enter"), false)
})

test("S5：断线 / 设备离线 / 设备忙都可写、可发送，sendKind=outbox 且不立刻走网络", () => {
  const cases = [
    { facts: { online: false }, placeholder: "已离线，写好后将排队，恢复连接自动发送…" },
    { facts: { deviceOnline: false }, placeholder: "MacBook 离线，可先写好，恢复后发送…" },
    { facts: { deviceBusy: true }, placeholder: "设备忙，消息将排队，空闲后自动发送…" },
  ]
  for (const item of cases) {
    const ui = deriveComposer({ ...IDLE, draft: "先写下来", ...item.facts })
    assert.equal(ui.state, "S5", JSON.stringify(item.facts))
    assert.equal(ui.canType, true, "S5 必须能输入")
    assert.equal(ui.canSend, true, "S5 点发送是入队，不是禁用")
    assert.equal(ui.sendKind, "outbox")
    assert.equal(ui.delivery, null, "S5 不直接调用 prompt/follow_up")
    assert.equal(ui.placeholder, item.placeholder)
    assert.equal(decideEnter({ ui }).action, "enqueue")
  }

  const offlineEmpty = deriveComposer({ ...IDLE, draft: "", online: false })
  assert.equal(offlineEmpty.state, "S0")
  assert.equal(offlineEmpty.canSend, false)
  assert.equal(offlineEmpty.placeholder, "已离线，写好后将排队，恢复连接自动发送…", "空输入也要显示离线占位")

  const mobileOffline = deriveComposer({ ...IDLE, online: false, draft: "离线", mobile: true })
  assert.equal(mobileOffline.placeholder, "已离线，消息将排队发送…")
  assert.equal(mobileOffline.placeholder.includes("Enter"), false)
})

test("S6：失败只存在一帧，按当前草稿回落 S1/S0；不回写输入框", () => {
  const failed = deriveComposer({
    ...IDLE,
    draft: "用户新打的字",
    failurePulse: true,
    lastFailure: { retryable: true },
  })
  assert.equal(failed.state, "S6")
  assert.equal(failed.fallbackState, "S1")
  assert.equal(failed.canSend, true)
  assert.equal(failed.sendKind, "send")
  assert.equal(failed.canRetry, true)
  assert.deepEqual(failed.failure, { retryable: true })
  assert.equal(failed.placeholder, "给 MacBook 上的 Pi 发消息，Enter 发送…")

  const nextFrame = deriveComposer({ ...IDLE, draft: "用户新打的字", lastFailure: { retryable: true } })
  assert.equal(nextFrame.state, "S1", "下一帧立即回落")
  assert.equal(nextFrame.fallbackState, null)
  assert.equal(nextFrame.canRetry, true, "气泡上的重试入口仍在")
  assert.equal(nextFrame.canType, true)

  const emptyFailure = deriveComposer({
    ...IDLE,
    draft: "",
    failurePulse: true,
    lastFailure: { retryable: false },
  })
  assert.equal(emptyFailure.state, "S6")
  assert.equal(emptyFailure.fallbackState, "S0")
  assert.equal(emptyFailure.canRetry, false)
  assert.equal(emptyFailure.canSend, false)

  assert.equal(decideEnter({ ui: failed }).action, "send", "S6 的 Enter 按回落态处理")
  assert.equal(decideEnter({ ui: emptyFailure }).action, "noop")
})

test("S7：撤销/只读整体禁用，输入、附件、发送、停止全部关掉", () => {
  const revoked = deriveComposer({ ...IDLE, draft: "写一半", revoked: true, generating: true, sending: true })
  assert.equal(revoked.state, "S7")
  assert.equal(revoked.canSend, false)
  assert.equal(revoked.canType, false)
  assert.equal(revoked.canAttach, false)
  assert.equal(revoked.stopVisible, false)
  assert.equal(revoked.sendKind, "none")
  assert.equal(revoked.delivery, null)
  assert.equal(revoked.blockReason, "revoked")
  assert.equal(revoked.placeholder, "该设备已被撤销，无法发送消息")
  assert.equal(decideEnter({ ui: revoked }).action, "noop")

  const readonly = deriveComposer({ ...IDLE, readonly: true })
  assert.equal(readonly.state, "S7")
  assert.equal(readonly.blockReason, "readonly")
  assert.equal(readonly.placeholder, "当前会话只读，无法发送消息")
})

test("超长：达到上限仍可发，超过 100000 字锁发送但保留编辑能力", () => {
  const atLimit = deriveComposer({ ...IDLE, draft: "x".repeat(COMPOSER_TEXT_MAX) })
  assert.equal(atLimit.state, "S1")
  assert.equal(atLimit.overLimit, false)
  assert.equal(atLimit.canSend, true)

  const over = deriveComposer({ ...IDLE, draft: "x".repeat(COMPOSER_TEXT_MAX + 1) })
  assert.equal(over.state, "S1")
  assert.equal(over.canSend, false, "超长不能发")
  assert.equal(over.canType, true, "仍要能删减")
  assert.equal(over.overLimit, true)
  assert.equal(over.blockReason, "overlong")
  assert.equal(over.delivery, null, "被限制时不能给出可执行的投递方案")
  assert.equal(over.sendTitle.includes(String(COMPOSER_TEXT_MAX)), true)
})

test("附件限制：上传中/失败/超过 5 个/超过 25MB 都锁发送；达到上限禁加附件", () => {
  const ready = deriveComposer({
    ...IDLE,
    draft: "带附件",
    attachments: { count: 2, totalBytes: 1024 },
  })
  assert.equal(ready.canSend, true)
  assert.equal(ready.canAttach, true)
  assert.equal(ready.attachmentBlocked, false)

  const uploading = deriveComposer({
    ...IDLE,
    draft: "带附件",
    attachments: { count: 1, uploading: 1 },
  })
  assert.equal(uploading.canSend, false)
  assert.equal(uploading.attachmentBlocked, true)
  assert.equal(uploading.blockReason, "attachment-uploading")
  assert.equal(uploading.delivery, null)

  const failed = deriveComposer({
    ...IDLE,
    draft: "带附件",
    attachments: { count: 1, failed: 1 },
  })
  assert.equal(failed.canSend, false)
  assert.equal(failed.blockReason, "attachment-failed")

  const tooMany = deriveComposer({
    ...IDLE,
    draft: "带附件",
    attachments: { count: ATTACHMENT_MAX_COUNT + 1, totalBytes: 1024 },
  })
  assert.equal(tooMany.canSend, false)
  assert.equal(tooMany.blockReason, "attachment-count")
  assert.equal(tooMany.canAttach, false)

  const atCount = deriveComposer({
    ...IDLE,
    draft: "带附件",
    attachments: { count: ATTACHMENT_MAX_COUNT, totalBytes: 1024 },
  })
  assert.equal(atCount.canSend, true, "5 个仍可发送")
  assert.equal(atCount.canAttach, false, "达到 5 个后不能再加")

  const tooBig = deriveComposer({
    ...IDLE,
    draft: "带附件",
    attachments: { count: 1, totalBytes: ATTACHMENT_MAX_TOTAL_BYTES + 1 },
  })
  assert.equal(tooBig.canSend, false)
  assert.equal(tooBig.blockReason, "attachment-size")

  const atBytes = deriveComposer({
    ...IDLE,
    draft: "带附件",
    attachments: { count: 1, totalBytes: ATTACHMENT_MAX_TOTAL_BYTES },
  })
  assert.equal(atBytes.canSend, true, "正好 25MB 可发送")
  assert.equal(atBytes.canAttach, false, "再加就会超合计上限")
})

test("键盘分流：桌面 Enter 发送/排队/入队，Shift+Enter 换行，移动端 Enter 永远换行", () => {
  const s1 = deriveComposer({ ...IDLE, draft: "发" })
  const s4 = deriveComposer({ ...IDLE, generating: true, draft: "排" })
  const s5 = deriveComposer({ ...IDLE, online: false, draft: "等" })
  const s0 = deriveComposer(IDLE)
  const s3 = deriveComposer({ ...IDLE, generating: true })

  assert.equal(decideEnter({ ui: s1 }).action, "send")
  assert.equal(decideEnter({ ui: s4 }).action, "queue")
  assert.equal(decideEnter({ ui: s5 }).action, "enqueue")
  assert.equal(decideEnter({ ui: s0 }).action, "noop")
  assert.equal(decideEnter({ ui: s3 }).action, "noop")

  assert.equal(decideEnter({ ui: s1, shiftKey: true }).action, "newline")
  assert.equal(decideEnter({ ui: s1, mobile: true }).action, "newline")
  assert.equal(decideEnter({ ui: s1, mobile: true, shiftKey: true }).action, "newline")
  assert.equal(decideEnter({ ui: s1, menuOpen: true }).action, "menu")
  assert.equal(decideEnter({ ui: s1, menuOpen: true, isComposing: true }).action, "ime")
  assert.equal(decideEnter({ ui: s1, isComposing: true }).action, "ime")
  assert.equal(decideEnter({ ui: s1, compositionJustEnded: true }).action, "ime", "compositionend 同 tick 的 Enter 仍按组字确认")
})

test("Esc 分层：菜单 → 浮层 → 模态 → 通知 → 停止生成 → 无操作", () => {
  assert.equal(decideEscape({ menuOpen: true, modalOpen: true, noticeCount: 2, generating: true }), "menu")
  assert.equal(decideEscape({ popoverOpen: true, modalOpen: true, noticeCount: 2, generating: true }), "popover")
  assert.equal(decideEscape({ modalOpen: true, noticeCount: 2, generating: true }), "modal")
  assert.equal(decideEscape({ noticeCount: 2, generating: true }), "notice")
  assert.equal(decideEscape({ generating: true }), "stop")
  assert.equal(decideEscape({}), "none")
})

test("in-flight 纯函数：同 tick 只接受一次，token 不匹配的 ack 不能释放别人的锁", () => {
  const first = acquireInFlight(null, "cid-a", 1000)
  assert.equal(first.acquired, true)
  assert.equal(first.next.token, "cid-a")
  assert.equal(first.expired, null)

  const second = acquireInFlight(first.next, "cid-b", 1000)
  assert.equal(second.acquired, false, "同 tick 第二次必须被拒")
  assert.equal(second.next, first.next, "被拒时状态原样返回")

  const wrongAck = releaseInFlight(first.next, "cid-b")
  assert.equal(wrongAck, first.next, "晚到/错 token 的 ack 不清锁")
  assert.equal(releaseInFlight(first.next, "cid-a"), null)

  assert.equal(inFlightExpired(first.next, 1000 + ACK_TIMEOUT_MS - 1), false)
  assert.equal(inFlightExpired(first.next, 1000 + ACK_TIMEOUT_MS), true, "8s 到点即过期")
  const expired = expireInFlight(first.next, 1000 + ACK_TIMEOUT_MS)
  assert.equal(expired.next, null)
  assert.equal(expired.expired, "cid-a")

  const afterExpiry = acquireInFlight(first.next, "cid-c", 1000 + ACK_TIMEOUT_MS)
  assert.equal(afterExpiry.acquired, true)
  assert.equal(afterExpiry.expired, "cid-a")
})

test("发送锁控制器：同 tick 三连点只发一条，超时后可重新获取", async () => {
  let clock = 0
  const lock = createSendLock({ now: () => clock })

  let sent = 0
  const submit = async (token) => {
    if (!lock.acquire(token)) return "locked"
    sent += 1
    await Promise.resolve()
    lock.release(token)
    return "sent"
  }

  const results = await Promise.all([submit("cid-1"), submit("cid-2"), submit("cid-3")])
  assert.equal(sent, 1, "Promise.all 三连点只允许一条真正发出")
  assert.deepEqual(results.sort(), ["locked", "locked", "sent"])

  clock = 500
  assert.equal(lock.acquire("cid-4"), true)
  assert.equal(lock.locked(), true)
  assert.equal(lock.acquire("cid-5"), false)
  assert.equal(lock.release("cid-wrong"), false)
  assert.equal(lock.release("cid-4"), true)
  assert.equal(lock.locked(), false)

  clock = 1000
  assert.equal(lock.acquire("cid-6"), true)
  clock = 1000 + ACK_TIMEOUT_MS
  assert.equal(lock.locked(), false, "到 ack 超时后锁自动失效")
  assert.equal(lock.current(), null)
  clock = 1000 + ACK_TIMEOUT_MS
  assert.equal(lock.acquire("cid-7"), true)

  clock = 1000 + ACK_TIMEOUT_MS * 2
  assert.equal(lock.expire(), "cid-7")
  assert.equal(lock.locked(), false)
})

test("UI 的 sending 事实来自锁：acquire 之后同一帧就是 S2，且仍可继续输入下一条", () => {
  let clock = 0
  const lock = createSendLock({ now: () => clock })
  assert.equal(lock.acquire("cid"), true)
  const ui = deriveComposer({ ...IDLE, draft: "下一条准备", sending: lock.locked() })
  assert.equal(ui.state, "S2")
  assert.equal(ui.canSend, false)
  assert.equal(ui.canType, true)
  clock += ACK_TIMEOUT_MS
  assert.equal(lock.locked(), false)
  assert.equal(deriveComposer({ ...IDLE, draft: "下一条准备", sending: lock.locked() }).state, "S1")
})

test("占位文案随状态切换，且不与当前动作矛盾", () => {
  assert.equal(placeholderFor("S1", { deviceName: "书房 Mac" }), "给 书房 Mac 上的 Pi 发消息，Enter 发送…")
  assert.equal(placeholderFor("S3", {}), "Pi 正在回复，输入后 Enter 将排队发送…")
  assert.equal(placeholderFor("S5", { online: false, mobile: true }), "已离线，消息将排队发送…")
  assert.equal(placeholderFor("S5", { deviceOnline: false }), "设备离线，可先写好，恢复后发送…")
  assert.equal(placeholderFor("S5", { deviceBusy: true }), "设备忙，消息将排队，空闲后自动发送…")
  assert.equal(placeholderFor("S7", { revoked: true }), "该设备已被撤销，无法发送消息")

  // 桌面空闲才允许出现快捷键名；移动/离线/生成中不得承诺 Enter 发送。
  assert.equal(placeholderFor("S1", { mobile: true }).includes("Enter"), false)
  assert.equal(placeholderFor("S5", { deviceBusy: true }).includes("Enter"), false)
  assert.equal(placeholderFor("S3", { mobile: true }).includes("Enter"), false)
})


test("V2 微交互数值：悬停 120/80、按压 0.97/80、转场 160+4、复制 1.2s、回底 120/32", () => {
  assert.equal(HOVER_REVEAL_IN_MS, 120)
  assert.equal(HOVER_REVEAL_OUT_MS, 80)
  assert.equal(PRESS_SCALE, 0.97)
  assert.equal(PRESS_MS, 80)
  assert.equal(SESSION_SWITCH_MS, 160)
  assert.equal(SESSION_SWITCH_OFFSET_PX, 4)
  assert.equal(COPY_FEEDBACK_HOLD_MS, 1200)
  assert.equal(BACK_TO_BOTTOM_THRESHOLD_PX, 120)
  assert.equal(BACK_TO_BOTTOM_SIZE_PX, 32)
  assert.equal(BACK_TO_BOTTOM_SMOOTH_MAX_PX, 2000)
  assert.equal(BACK_TO_BOTTOM_SCROLL_MS, 240)
  assert.equal(SLASH_ROW_HEIGHT_PX, 30)
  assert.equal(KBD_FONT_PX, 11)
  assert.equal(TOOLTIP_FIRST_DELAY_MS, 500)
  assert.equal(TOOLTIP_WARM_WINDOW_MS, 3000)
  assert.equal(MOTION_LOOP_BUDGET, 2)
  assert.equal(copyFeedbackAfter(true), "copied")
  assert.equal(copyFeedbackAfter(false), "failed")
})

test("回底钮：距底 >120 且（未读>0 或流式）才出现；≤2000 平滑、以上即时；计数 99+", () => {
  assert.equal(backToBottomVisible(120, 1, false), false, "刚好 120 不出现")
  assert.equal(backToBottomVisible(121, 0, false), false, "只往上翻没有新东西不出现")
  assert.equal(backToBottomVisible(121, 1, false), true)
  assert.equal(backToBottomVisible(121, 0, true), true, "流式中只显图标")
  assert.deepEqual(backToBottomPlan({ distancePx: 1999, unread: 10 }), {
    visible: true,
    behavior: "smooth",
    label: "10 条新消息",
    unread: 10,
  })
  assert.equal(backToBottomPlan({ distancePx: 2001, unread: 1 }).behavior, "instant")
  assert.equal(backToBottomPlan({ distancePx: 3000, unread: 120 }).label, "99+ 条新消息")
})

test("发送中延迟：ack ≤200ms 永不显示，>200ms 才显形（S0–S7 不变）", () => {
  assert.equal(SENDING_HINT_DELAY_MS, 200)
  for (const elapsed of [0, 1, 50, 199, 200]) assert.equal(sendingHintVisible(elapsed), false, String(elapsed))
  for (const elapsed of [201, 1200]) assert.equal(sendingHintVisible(elapsed), true, String(elapsed))
})

test("连接 6 态：一个状态点 + 一句话；重连第 2 次起才带次数与倒计时", () => {
  const connecting = connectionChip({ authed: false, everConnected: false, retryAt: null })
  assert.equal(connecting.state, "connecting")
  assert.equal(connecting.breathing, true)

  const firstRetry = connectionChip({ authed: false, everConnected: true, retryAt: 5000, retryCount: 1, now: 0 })
  assert.equal(firstRetry.state, "reconnecting")
  assert.equal(firstRetry.countdownSeconds, null)
  assert.equal(firstRetry.label, "重连中…")

  const laterRetry = connectionChip({ authed: false, everConnected: true, retryAt: 12_000, retryCount: 3, now: 0 })
  assert.equal(laterRetry.countdownSeconds, 12)
  assert.match(laterRetry.label, /第 3 次/)
  assert.equal(laterRetry.breathing, true)

  const offline = connectionChip({ authed: false, everConnected: true, retryAt: null })
  assert.equal(offline.state, "offline")
  assert.equal(offline.breathing, false)
  assert.equal(offline.shape, "ring")

  const deviceOffline = connectionChip({
    authed: true,
    everConnected: true,
    retryAt: null,
    device: { name: "MacBook", online: false },
  })
  assert.equal(deviceOffline.state, "device-offline")
  assert.equal(deviceOffline.label, "MacBook 离线")

  const busy = connectionChip({ authed: true, everConnected: true, retryAt: null, busy: true })
  assert.equal(busy.state, "device-busy")
  assert.equal(busy.breathing, false)

  const connected = connectionChip({ authed: true, everConnected: true, retryAt: null })
  assert.equal(connected.state, "connected")
  assert.equal(connected.tone, "success")
  assert.equal(connected.breathing, false)
})

test("循环动画预算：最多 2 个；流式光标永不降级", () => {
  const all = [
    { id: "skeleton", kind: "skeleton" },
    { id: "spinner", kind: "spinner" },
    { id: "connection", kind: "connection" },
    { id: "caret", kind: "caret" },
  ]
  const budget = selectLoopBudget(all)
  assert.deepEqual(budget.active.map((loop) => loop.kind), ["caret", "connection"])
  assert.deepEqual(budget.degraded.map((loop) => loop.kind), ["spinner", "skeleton"])

  const noCaret = selectLoopBudget(all.filter((loop) => loop.kind !== "caret"))
  assert.deepEqual(noCaret.active.map((loop) => loop.kind), ["connection", "spinner"])
  assert.deepEqual(noCaret.degraded.map((loop) => loop.kind), ["skeleton"])
})




test("P3-2 纯图片可发送：无正文 + 有待发图片不再判 empty", () => {
  const idle = deriveComposer({ ...IDLE, pendingImages: 1 })
  assert.equal(idle.state, "S1", "纯图片空闲应为 S1")
  assert.equal(idle.canSend, true)
  assert.equal(idle.blockReason, null)
  assert.equal(idle.sendKind, "send")

  const blankText = deriveComposer({ ...IDLE, draft: "  \n ", pendingImages: 2 })
  assert.equal(blankText.state, "S1", "空白正文 + 图片仍算有内容")
  assert.equal(blankText.canSend, true)

  const generating = deriveComposer({ ...IDLE, generating: true, pendingImages: 1 })
  assert.equal(generating.state, "S4", "纯图片生成中应为 S4 而非 S3")
  assert.equal(generating.canSend, true)

  const offline = deriveComposer({ ...IDLE, online: false, pendingImages: 1 })
  assert.equal(offline.state, "S5", "纯图片离线应为 S5")
  assert.equal(offline.sendKind, "outbox")

  const enter = decideEnter({ ui: idle })
  assert.equal(enter.action, "send", "纯图片时 Enter 应走发送")

  // 旧调用方只传 attachments.count 时回落同一口径
  const viaAttachments = deriveComposer({ ...IDLE, attachments: { count: 1 } })
  assert.equal(viaAttachments.state, "S1")
  assert.equal(viaAttachments.canSend, true)

  // 无图无文仍是 empty（旧口径不回归）
  const empty = deriveComposer({ ...IDLE, pendingImages: 0 })
  assert.equal(empty.state, "S0")
  assert.equal(empty.blockReason, "empty")
})

test("P3-3 草稿落盘：分房存取、清空删除、超限淘汰最久未用", async () => {
  const { readRoomDraft, saveRoomDraft, parseDraftTable, pruneDraftTable, DRAFTS_MAX_ROOMS } = await import(
    "../ui/src/relay/drafts.ts"
  )
  const map = new Map()
  const fake = {
    get: (k) => (map.has(k) ? map.get(k) : null),
    set: (k, v) => {
      map.set(k, v)
      return true
    },
    remove: (k) => {
      map.delete(k)
    },
  }

  saveRoomDraft("room-a", "写了一半", fake, 1000)
  saveRoomDraft("room-b", "另一间的话", fake, 2000)
  assert.equal(readRoomDraft("room-a", fake), "写了一半")
  assert.equal(readRoomDraft("room-b", fake), "另一间的话", "两房草稿互不串")

  saveRoomDraft("room-a", "", fake, 3000)
  assert.equal(readRoomDraft("room-a", fake), "", "清空即删条目，发送后不复活")
  assert.equal(readRoomDraft("room-b", fake), "另一间的话")

  const table = {}
  for (let i = 0; i < DRAFTS_MAX_ROOMS + 5; i += 1) table[`r${i}`] = { text: `t${i}`, at: i }
  const pruned = pruneDraftTable(table)
  assert.equal(Object.keys(pruned).length, DRAFTS_MAX_ROOMS)
  assert.equal(pruned.r0, undefined, "最久未用先淘汰")
  assert.ok(pruned[`r${DRAFTS_MAX_ROOMS + 4}`], "最近使用的保留")

  assert.deepEqual(parseDraftTable("not json"), {})
  assert.deepEqual(parseDraftTable(null), {})
})
