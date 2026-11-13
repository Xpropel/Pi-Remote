// S2 第五轮 · 提示：
//   1. 「有任务等你回答」在提醒过的等待全部结束（答了 / 取消 / 停止回合关掉弹窗）后按 scope 撤回，不再停满 8 秒；
//   2. pi 自动重试的提示写人话（与流里出错行同一套认法），原始 errorMessage 不进提示；几次尝试 / 成功 / 放弃互相顶替。
// 纯函数直接跑，进通知栈的效果用 noticeCore 验；React / useRelay 接线看源码。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"

const host = await import("../ui/src/pi/model/settingsHost.ts")
const settings = await import("../ui/src/pi/settings/model.ts")
const bridge = await import("../ui/src/chat/composer/noticeBridge.ts")
const core = await import("../ui/src/chat/noticeCore.ts")

const read = (p) => fs.readFileSync(new URL(`../ui/src/${p}`, import.meta.url), "utf8")
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
const gate = host.notificationGateOf(
  settings.mergeSettingsPrefs(settings.createDefaultSettingsPrefs(), { notifyWaiting: true, notifyOnlyWhenAway: false }),
)
const titlesOf = (state) => [...state.visible, ...state.queue].map((item) => item.title)

describe("等待提醒的撤回", () => {
  const step = (ledger, waitingKeys, knownKeys = waitingKeys) => host.waitingNoticeStep(ledger, { ready: true, waitingKeys, knownKeys })
  /** 模拟 useWaitingNotice 的一步：返回新账本和这一步做了什么 */
  const run = (ledger, waitingKeys, knownKeys) => {
    const r = step(ledger, waitingKeys, knownKeys)
    const announced = r.fresh.length > 0 ? host.waitingNoticeAnnounced(r.ledger, r.fresh) : r.ledger
    return { ledger: announced, fresh: r.fresh, retract: r.retract }
  }

  test("提醒卡带 WAITING_NOTICE_SCOPE；提醒过的等待都结束 → 撤回一次，之后不再撤", () => {
    assert.equal(host.notificationNoticeOf(gate, "waiting", false).scope, host.WAITING_NOTICE_SCOPE)
    let r = run(null, [])
    r = run(r.ledger, ["dialog:A:1"])
    assert.deepEqual(r.fresh, ["dialog:A:1"])
    assert.equal(r.retract, false)
    r = run(r.ledger, [])
    assert.equal(r.retract, true, "答了 / 取消 / 停止回合（dialog_close）后撤回")
    r = run(r.ledger, [])
    assert.equal(r.retract, false, "只撤一次")
  })

  test("还有提醒过的在等就不撤；新开的另记一笔，全部结束才撤", () => {
    let r = run(null, [])
    r = run(r.ledger, ["dialog:A:1"])
    r = run(r.ledger, ["dialog:A:1", "dialog:B:2"])
    assert.deepEqual(r.fresh, ["dialog:B:2"])
    r = run(r.ledger, ["dialog:B:2"])
    assert.equal(r.retract, false, "B 还在等")
    r = run(r.ledger, [])
    assert.equal(r.retract, true)
  })

  test("没弹过提醒（开关关着 / 仅页面外）就没有可撤的；页面打开时已挂着的也不算", () => {
    let r = step(null, ["dialog:A:1"])
    r = step(r.ledger, ["dialog:A:1", "dialog:B:2"])
    assert.deepEqual(r.fresh, ["dialog:B:2"], "新事件照常识别")
    r = step(r.ledger, [])
    assert.equal(r.retract, false, "没记过 announced，不撤别人的卡")
  })

  test("切会话：实时弹窗晚一步到、等待还在名册 / 账本里 → 不撤也不重弹", () => {
    let r = run(null, [])
    r = run(r.ledger, ["dialog:A:1"])
    r = run(r.ledger, [], ["dialog:A:1"])
    assert.equal(r.retract, false, "账本里还在等")
    r = run(r.ledger, ["dialog:A:1"])
    assert.deepEqual(r.fresh, [], "同一个等待回来不重弹")
    assert.equal(r.retract, false)
  })

  test("进通知栈：按 scope 撤回只拿掉等待卡，回合结果卡留着", () => {
    const waiting = host.notificationNoticeOf(gate, "waiting", false)
    const done = host.notificationNoticeOf(
      host.notificationGateOf(settings.mergeSettingsPrefs(settings.createDefaultSettingsPrefs(), { notifyComplete: true, notifyOnlyWhenAway: false })),
      "done",
      false,
    )
    let state = core.pushNotice(core.emptyNotices(), done, 0)
    state = core.pushNotice(state, waiting, 10)
    state = core.pushNotice(state, waiting, 20)
    assert.deepEqual(titlesOf(state).sort(), ["任务完成", "有任务等你回答"].sort())
    state = core.retractNoticeScope(state, host.WAITING_NOTICE_SCOPE, 30)
    assert.deepEqual(titlesOf(state), ["任务完成"])
  })

  test("接线：useWaitingNotice 先记账再撤回（开关关掉后也撤），弹了才记 announced", () => {
    const hook = code(read("pi/hooks/useCompletionNotice.ts"))
    assert.match(hook, /retractNoticeScope: \(scope: string\) => void/)
    assert.match(
      hook,
      /ledgerRef\.current = step\.ledger\s*if \(step\.retract\) retractNoticeScope\(WAITING_NOTICE_SCOPE\)\s*if \(!enabled \|\| step\.fresh\.length === 0\) return/,
    )
    assert.match(hook, /if \(notice\) \{\s*pushNotice\(notice\)\s*ledgerRef\.current = waitingNoticeAnnounced\(ledgerRef\.current, step\.fresh\)\s*\}/)
    assert.match(hook, /\}, \[waitingKeys, knownKeys, ready, away, enabled, gate, pushNotice, retractNoticeScope\]\)/)
    assert.match(read("relay/useRelay.ts"), /retractNoticeScope: noticeStack\.retract,/)
  })
})

describe("自动重试提示", () => {
  const OVERLOADED = '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'

  test("原因：与流里出错行同一套认法，带状态码；认不出写「模型服务报错」，原文不进提示", () => {
    assert.equal(bridge.autoRetryReasonOf(OVERLOADED), "模型服务繁忙（529）")
    assert.equal(bridge.autoRetryReasonOf("429 status code (no body)"), "请求太频繁（429）")
    assert.equal(bridge.autoRetryReasonOf("Connection error."), "网络连接中断")
    assert.equal(bridge.autoRetryReasonOf("fetch failed"), "网络连接中断")
    assert.equal(bridge.autoRetryReasonOf("Request timed out."), "请求超时")
    assert.equal(bridge.autoRetryReasonOf("Something odd happened"), "模型服务报错")
    assert.equal(bridge.autoRetryReasonOf('{"weird":true}'), "模型服务报错")
    assert.equal(bridge.autoRetryReasonOf(undefined), "模型服务报错")
  })

  test("开始：「模型服务繁忙（529），正在重试（1/3）」进通知栈；没带原因的只是输入区状态行", () => {
    const start = bridge.autoRetryStartNotice({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: OVERLOADED })
    assert.deepEqual(start, { text: "模型服务繁忙（529），正在重试（1/3）", tone: "warn", scope: bridge.AUTO_RETRY_NOTICE_SCOPE })
    assert.equal(bridge.autoRetryStartNotice({ attempt: 2, errorMessage: "fetch failed" }).text, "网络连接中断，正在重试", "次数不全就不写")
    assert.equal(bridge.autoRetryStartNotice({ attempt: "x", maxAttempts: 3, errorMessage: "fetch failed" }).text, "网络连接中断，正在重试")
    const bare = bridge.autoRetryStartNotice({ attempt: 1, maxAttempts: 3 })
    assert.deepEqual(bare, { text: "正在重试", tone: "warn", codes: ["progress"] })
    assert.equal(bridge.noticeChannel(bare.codes), "progress")
    for (const notice of [start, bridge.autoRetryStartNotice({ errorMessage: "Something odd happened" })]) {
      assert.doesNotMatch(notice.text, /[{}"]|overloaded|Something/, "原文不进提示")
    }
  })

  test("结束：成功 / 被停止 / 放弃（带次数与原因）", () => {
    assert.deepEqual(bridge.autoRetryEndNotice({ success: true, attempt: 2 }), { text: "重试已成功", tone: "warn", scope: bridge.AUTO_RETRY_NOTICE_SCOPE })
    for (const finalError of ["Retry cancelled", "Retry canceled.", "retry was cancelled"]) {
      assert.deepEqual(bridge.autoRetryEndNotice({ success: false, attempt: 1, finalError }), { text: "已停止重试", tone: "warn", scope: bridge.AUTO_RETRY_NOTICE_SCOPE }, finalError)
    }
    assert.deepEqual(bridge.autoRetryEndNotice({ success: false, attempt: 3, finalError: OVERLOADED }), {
      text: "重试 3 次仍未成功：模型服务繁忙（529）",
      tone: "bad",
      scope: bridge.AUTO_RETRY_NOTICE_SCOPE,
    })
    assert.equal(bridge.autoRetryEndNotice({ success: false, finalError: "Something odd happened" }).text, "自动重试没有成功：模型服务报错")
    assert.equal(bridge.autoRetryEndNotice({ success: false, attempt: 2 }).text, "重试 2 次仍未成功")
  })

  test("进通知栈：几次尝试、成功 / 放弃互相顶替，只留最新一张", () => {
    const push = (state, notice, now) => core.pushNotice(state, bridge.legacyNoticeInput(notice, false), now)
    let state = push(core.emptyNotices(), bridge.autoRetryStartNotice({ attempt: 1, maxAttempts: 3, errorMessage: OVERLOADED }), 0)
    state = push(state, bridge.autoRetryStartNotice({ attempt: 2, maxAttempts: 3, errorMessage: OVERLOADED }), 10)
    assert.deepEqual(titlesOf(state), ["模型服务繁忙（529），正在重试（2/3）"])
    state = push(state, bridge.autoRetryEndNotice({ success: false, attempt: 3, finalError: OVERLOADED }), 20)
    assert.deepEqual(titlesOf(state), ["重试 3 次仍未成功：模型服务繁忙（529）"])
    assert.equal(state.visible[0].level, "error")
    state = push(core.emptyNotices(), bridge.autoRetryStartNotice({ attempt: 1, maxAttempts: 3, errorMessage: OVERLOADED }), 0)
    state = push(state, bridge.autoRetryEndNotice({ success: true, attempt: 1 }), 10)
    assert.deepEqual(titlesOf(state), ["重试已成功"])
  })

  test("接线：useRelay 两个事件都走 noticeBridge，不再直接塞原文", () => {
    const relay = code(read("relay/useRelay.ts"))
    assert.match(relay, /import \{[^}]*\bautoRetryEndNotice\b[^}]*\bautoRetryStartNotice\b[^}]*\} from "@\/chat\/composer\/noticeBridge"/)
    assert.match(relay, /case "auto_retry_start":[\s\S]{0,400}?setNotice\(autoRetryStartNotice\(event\)\)\s*break/)
    assert.match(relay, /case "auto_retry_end":[\s\S]{0,200}?setNotice\(autoRetryEndNotice\(event\)\)/)
    const at = relay.indexOf('case "auto_retry_start":')
    const retry = relay.slice(at, relay.indexOf("case ", relay.indexOf('case "auto_retry_end":') + 1))
    assert.doesNotMatch(retry, /event\.errorMessage|event\.finalError/, "原文只交给 noticeBridge")
  })
})
