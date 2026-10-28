// UI 低危 1–13（变体 / 容器 / relay 草稿、outbox、注意力线）的最小回归：
// 1) 被删会话信号过期不再误弹新建页；2) 加载/报错屏深色不再整屏刷白；3) 错误边界随皮肤复位；
// 4) Claude/Codex 配对入口看服务端能力；5) Codex 状态色独立 token；6) 切皮肤保留新建页草稿；
// 7) 重同步定时器带房间标记；8) 草稿跨标签页同步（P12 已修，这里只钉接线）；9) outbox 回放认领分自他；
// 10) 只增登记表封顶（含缓慢泄漏的 terminalHistoryIds）；11) 重复 message_start 去重；
// 12) 主 effect 卸载清定时器；13) queue-sync 不再每帧全表扫转录。
// 纯函数直接 import；接线 / 样式类用源码口径断言（node --test 直接跑 .ts）。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { purgeSignalDecision } from "../ui/src/pi/containers/purgeSignal.ts"
import { variantFallbackTheme } from "../ui/src/pi/variants/fallback.ts"
import { DRAFTS_STORAGE_KEY, newSessionDraftOf, setNewSessionDraft, subscribeNewSessionDraft } from "../ui/src/relay/drafts.ts"
import {
  EMPTY_OUTBOX,
  newOutboxOwner,
  outboxClaimedBy,
  outboxOf,
  outboxReducer,
  parseOutbox,
  serializeOutbox,
} from "../ui/src/pi/model/outbox.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")

function ruleBody(css, selector) {
  const at = css.indexOf(selector)
  assert.ok(at >= 0, `缺选择器 ${selector}`)
  const open = css.indexOf("{", at)
  const close = css.indexOf("}", open)
  assert.ok(open >= 0 && close > open, `选择器 ${selector} 没有规则体`)
  return css.slice(open + 1, close)
}

/* ------------------------------------------------------------------ 1. 被删会话信号 */

describe("1) 被删会话信号：过期信号只记账、不误弹新建页", () => {
  const purge = { id: "gone", at: 10 }
  const decision = (patch = {}) => purgeSignalDecision({ purge, handledAt: 0, roomId: "", view: "session", ...patch })

  test("本意场景：roomId 已清、还在会话视图 → 进新建页", () => {
    assert.equal(decision(), "navigate")
  })
  test("用户已离开会话视图（设置 / 新建页）→ 消费掉，不再事后抢界面", () => {
    assert.equal(decision({ view: "settings" }), "consume")
    assert.equal(decision({ view: "new" }), "consume")
  })
  test("用户已打开另一个会话 → 消费掉；roomId 仍是被删的房间 → 等 clearRoom", () => {
    assert.equal(decision({ roomId: "other" }), "consume")
    assert.equal(decision({ roomId: "gone" }), "wait")
  })
  test("没有新信号 / 已处理过 → idle", () => {
    assert.equal(purgeSignalDecision({ purge: null, handledAt: 0, roomId: "", view: "session" }), "idle")
    assert.equal(decision({ handledAt: 10 }), "idle")
  })
  test("PiAppBody 先消费过期信号、再走原导航 effect（原有守卫保留）", () => {
    const src = read("ui/src/pi/containers/PiAppBody.tsx")
    assert.match(src, /purgeSignalDecision\(/)
    assert.match(src, /if \(decision === "consume"\) handledPurgeAt\.current = purge\.at/)
    assert.match(src, /if \(!purge \|\| purge\.at === handledPurgeAt\.current\) return/)
    assert.match(src, /if \(relay\.roomId\) return/)
    assert.match(src, /if \(ui\.view !== "session"\) return/)
    // 消费 effect 必须声明在导航 effect 之前（同一次渲染按声明顺序跑）
    assert.ok(src.indexOf("purgeSignalDecision(") < src.indexOf("act.newSession()"))
  })
})

/* ------------------------------------------------------------------ 2. 加载 / 报错屏主题 */

describe("2) 变体加载 / 报错屏：深色模式不再整屏浅色", () => {
  const doc = (theme) => ({ documentElement: { getAttribute: (name) => (name === "data-pi-theme" ? theme : null) } })
  const storage = (value) => ({ getItem: (key) => (key === "pi_remote_pi_prefs" ? value : null) })

  test("优先读 <html data-pi-theme>（切皮肤空窗期也拿得到旧主题）", () => {
    assert.equal(variantFallbackTheme(doc("dark"), null, false), "dark")
    assert.equal(variantFallbackTheme(doc("light"), storage(JSON.stringify({ v: 1, theme: "dark" })), true), "light")
  })
  test("属性被 PiRoot 清掉时回落到 prefs（新键 → 旧键 → 系统）", () => {
    assert.equal(variantFallbackTheme(doc(null), storage(JSON.stringify({ v: 1, theme: "dark" })), false), "dark")
    assert.equal(variantFallbackTheme(doc(null), storage("{bad json"), true), "dark", "坏 JSON 跟随系统")
    assert.equal(variantFallbackTheme(doc(null), storage("null"), false), "light")
    const legacy = { getItem: (key) => (key === "pi-remote.theme" ? "dark" : null) }
    assert.equal(variantFallbackTheme(doc(null), legacy, false), "dark", "旧主题键仍可迁移")
  })
  test("加载屏 / 错误屏自己的根带 data-pi-root + data-pi-theme（共享深色 token 落到本地）", () => {
    const loading = read("ui/src/pi/variants/index.ts")
    assert.match(loading, /"data-pi-root": ""/)
    assert.match(loading, /"data-pi-theme": resolved/)
    assert.match(loading, /variantFallbackTheme\(\)/)
    const boundary = read("ui/src/pi/PiVariantBoundary.tsx")
    assert.match(boundary, /data-pi-root=""/)
    assert.match(boundary, /data-pi-theme=\{theme\}/)
    assert.match(boundary, /variantFallbackTheme\(\)/)
  })
})

describe("3) 变体错误边界：换皮肤自动复位", () => {
  test("state 记住 failed 属于哪个变体；props.variant 变化立即清错误态", () => {
    const src = read("ui/src/pi/PiVariantBoundary.tsx")
    assert.match(src, /variant: PiUiVariant/)
    assert.match(src, /state: PiVariantBoundaryState = \{ failed: false, message: "", variant: this\.props\.variant \}/)
    assert.match(src, /static getDerivedStateFromProps\(/)
    assert.match(src, /if \(props\.variant === state\.variant\) return null/)
    assert.match(src, /return \{ failed: false, message: "", variant: props\.variant \}/)
  })
})

/* ------------------------------------------------------------------ 4. 配对入口 */

describe("4) Claude / Codex 配对按钮看服务端能力", () => {
  test("ClaudeBoot：no-devices 用 view.pairing、all-offline 用 relay.canManageDevices", () => {
    const src = read("ui/src/pi/variants/claude/pages/ClaudeBoot.tsx")
    assert.match(src, /const canPair = !!relay\.canManageDevices/)
    assert.match(src, /view\.pairing \? \(/)
    assert.match(src, /canPair \? \(/)
  })
  test("CodexBoot：无 device.token 不画配对按钮", () => {
    const src = read("ui/src/pi/variants/codex/pages/CodexBoot.tsx")
    assert.match(src, /const canPair = !!relay\.canManageDevices/)
    assert.match(src, /\) : canPair \? \(/)
  })
})

/* ------------------------------------------------------------------ 5. Codex 状态色 */

describe("5) Codex 状态色用独立 token，不借用 diff", () => {
  const tokens = read("ui/src/pi/variants/codex/styles/tokens.css")
  const css = read("ui/src/pi/variants/codex/styles/codex.css")

  test("浅 / 深两套都定义了状态 token", () => {
    for (const name of ["--codex-status-ok", "--codex-status-ok-bg", "--codex-status-warn", "--codex-status-warn-bg", "--codex-status-bad"]) {
      assert.equal((tokens.match(new RegExp(`${name}:`, "g")) ?? []).length, 2, `${name} 应有浅 / 深两份`)
    }
  })
  test("工具 / 设备 / 检查 / 能力等状态规则不再引用 --codex-diff-*", () => {
    const selectors = [
      '.cx-set-dot[data-online]',
      '.cx-tool-exit[data-ok]',
      '.cx-tool-status[data-tone="ok"]',
      '.cx-tool-status[data-tone="fail"]',
      '.cx-terminal-output[data-failed]',
      '.cx-statusline-dot[data-tone="ok"]',
      '.cx-badge[data-tone="ok"]',
      '.cx-badge[data-tone="warn"]',
      '.cx-pr-icon[data-state="open"]',
      '.cx-pr-check[data-status="ok"]',
      '.cx-ext-status[data-status="available"]',
    ]
    for (const selector of selectors) {
      let from = 0
      for (;;) {
        const at = css.indexOf(selector, from)
        if (at < 0) break
        const body = ruleBody(css.slice(at), selector)
        assert.doesNotMatch(body, /--codex-diff-/, `${selector} 仍借用 diff token：${body.trim()}`)
        from = at + selector.length
      }
    }
  })
  test("diff 自身仍用 diff token（语义没被抹平）", () => {
    assert.match(ruleBody(css, '.cx-diff-row[data-kind="add"]'), /--codex-diff-add-bg/)
  })
})

/* ------------------------------------------------------------------ 6. 新建页草稿跨皮肤 */

describe("6) 切皮肤保留新建页未发送草稿", () => {
  test("共享 store：读 / 写 / 订阅 / 函数式更新 / 同值不通知", () => {
    setNewSessionDraft("")
    let hits = 0
    const off = subscribeNewSessionDraft(() => {
      hits += 1
    })
    setNewSessionDraft("给新会话的第一条")
    assert.equal(newSessionDraftOf(), "给新会话的第一条")
    assert.equal(hits, 1)
    setNewSessionDraft("给新会话的第一条")
    assert.equal(hits, 1, "值没变不触发重渲染")
    setNewSessionDraft((prev) => `${prev} + 补充`)
    assert.equal(newSessionDraftOf(), "给新会话的第一条 + 补充")
    assert.equal(hits, 2)
    off()
    setNewSessionDraft("")
    assert.equal(hits, 2, "取消订阅后不再通知")
  })
  test("三套新建页都从 @/relay/drafts 读同一份草稿", () => {
    for (const file of ["ui/src/pi/containers/NewSessionContainer.tsx", "ui/src/pi/variants/claude/pages/ClaudeNewSession.tsx", "ui/src/pi/variants/codex/pages/CodexNewSession.tsx"]) {
      const src = read(file)
      assert.match(src, /from "@\/relay\/drafts"/, `${file} 要 import 共享草稿 store`)
      assert.match(src, /useSyncExternalStore\(subscribeNewSessionDraft, newSessionDraftOf, newSessionDraftOf\)/, `${file} 要用共享快照`)
      assert.doesNotMatch(src, /const \[draft, setDraft\] = useState/, `${file} 不能再各自 useState`)
    }
  })
})

/* ------------------------------------------------------------------ 7. 重同步房间标记 */

describe("7) 重同步定时器带房间标记，换房不再替新房多发订阅", () => {
  const src = read("ui/src/relay/useRelay.ts")
  test("pendingResync 记录房间；sendResync 校验房间仍是当前房", () => {
    assert.match(src, /const pendingResyncRef = useRef<\{ since: boolean; room: string \} \| null>\(null\)/)
    assert.match(src, /const sendResync = useCallback\(\(since: boolean, room: string = roomRef\.current\) => \{/)
    assert.match(src, /if \(!id \|\| roomRef\.current !== id\) return/)
    assert.match(src, /pendingResyncRef\.current = \{ since, room: id \}/)
  })
  test("定时器回调、auth_result 补发、换房清标记都按房间对号", () => {
    assert.match(src, /if \(roomRef\.current !== room\) return\s*\n\s*sendResync\(since, room\)/)
    assert.match(src, /sendResync\(pendingResync\.since, pendingResync\.room\)/)
    assert.match(src, /pendingResyncRef\.current && pendingResyncRef\.current\.room !== id/)
    assert.match(src, /resyncTimerRef\.current = null\s*\n\s*\}\s*\n\s*pendingResyncRef\.current = null\s*\n\s*resyncAtRef\.current = 0/)
  })
})

/* ------------------------------------------------------------------ 8. 草稿跨标签页（P12 verified） */

describe("8) 草稿跨标签页同步：P12 已修，接线仍在", () => {
  const src = read("ui/src/relay/useRelay.ts")
  test("storage 事件按草稿键同步、用基线防覆盖；落盘带 shouldPersistDraft 闸门", () => {
    assert.match(src, /window\.addEventListener\("storage", onStorage\)/)
    assert.match(src, /event\.key === DRAFTS_STORAGE_KEY/)
    assert.match(src, /roomDraftFromRaw\(event\.newValue, key\)/)
    assert.match(src, /reconcileRemoteDraft\(draftRef\.current, draftBaseRef\.current, remote\)/)
  })
  test("草稿键没被本次改动挪走（只加不改）", () => {
    assert.equal(DRAFTS_STORAGE_KEY, "pi_remote_drafts_v1")
  })
})

/* ------------------------------------------------------------------ 9. outbox 认领归属 */

describe("9) outbox 回放认领：跨标签页分得清自他", () => {
  const enqueue = outboxReducer(EMPTY_OUTBOX, { type: "enqueue", roomId: "r1", cid: "c1", dedupeKey: "d1", text: "排队的一条", at: 1 })
  const claimedA = outboxReducer(enqueue, { type: "replay", roomId: "r1", cid: "c1", owner: "tab-A" })
  const entryOf = (state) => outboxOf(state, "r1")[0]

  test("认领写入 claim；认领者可判别", () => {
    assert.equal(entryOf(claimedA).status, "replaying")
    assert.equal(entryOf(claimedA).claim, "tab-A")
    assert.equal(outboxClaimedBy(claimedA, "r1", "c1", "tab-A"), true)
    assert.equal(outboxClaimedBy(claimedA, "r1", "c1", "tab-B"), false)
  })
  test("别的标签页既不能再认领、也不能用 sent/fail/requeue 改这条", () => {
    assert.equal(outboxReducer(claimedA, { type: "replay", roomId: "r1", cid: "c1", owner: "tab-B" }), claimedA)
    assert.equal(outboxReducer(claimedA, { type: "sent", roomId: "r1", cid: "c1", owner: "tab-B" }), claimedA)
    assert.equal(outboxReducer(claimedA, { type: "fail", roomId: "r1", cid: "c1", error: "x", owner: "tab-B" }), claimedA)
    assert.equal(outboxReducer(claimedA, { type: "requeue", roomId: "r1", cid: "c1", owner: "tab-B" }), claimedA)
  })
  test("认领者自己的结果照常生效；载入 recover 清掉 claim", () => {
    assert.equal(entryOf(outboxReducer(claimedA, { type: "sent", roomId: "r1", cid: "c1", owner: "tab-A" })), undefined)
    const recovered = outboxReducer(claimedA, { type: "recover", error: "页面在回放途中关掉了" })
    assert.equal(entryOf(recovered).status, "failed")
    assert.equal(entryOf(recovered).claim, undefined)
    assert.equal(entryOf(recovered).unknown, true)
  })
  test("持久化往返保留 claim；旧格式（无 claim）仍能解析", () => {
    const roundtrip = parseOutbox(serializeOutbox(claimedA))
    assert.equal(entryOf(roundtrip).claim, "tab-A")
    const legacy = parseOutbox(JSON.stringify({ v: 1, rooms: { r1: [{ cid: "c1", dedupeKey: "d1", text: "旧条目", at: 1, status: "replaying" }] } }))
    assert.equal(entryOf(legacy).status, "replaying")
    assert.equal(entryOf(legacy).claim, undefined)
  })
  test("认领 id 每个标签页各自生成、两次不同", () => {
    const a = newOutboxOwner()
    const b = newOutboxOwner()
    assert.ok(a && b && a !== b)
  })
})

/* ------------------------------------------------------------------ 10. 只增登记表 */

describe("10) 只增登记表封顶（其中 terminalHistoryIds 是缓慢泄漏路径）", () => {
  const src = read("ui/src/relay/useRelay.ts")
  test("terminalHistoryIds / knownRoomIds / suppressStartedRooms 按上限丢最旧", () => {
    assert.match(src, /capGrowingSet\(terminalHistoryIdsRef\.current, TERMINAL_HISTORY_IDS_MAX\)/)
    assert.match(src, /capGrowingSet\(knownRoomIds\.current, KNOWN_ROOM_IDS_MAX\)/)
    assert.match(src, /capGrowingSet\(suppressStartedRoomsRef\.current, SUPPRESSED_STARTED_ROOMS_MAX\)/)
    assert.match(src, /while \(set\.size > max\)/)
  })
  test("resolvedArmingAt 在启动取消 / 超时时一并清理（不再只增）", () => {
    assert.match(src, /const at = pendingWatchRef\.current\[deviceId\]\?\.at \?\? armingRef\.current\[deviceId\]\?\.at\s*\n\s*if \(at !== undefined\) resolvedArmingAt\.current\.delete\(at\)/)
    assert.match(src, /resolvedArmingAt\.current\.delete\(pending\.at\)/)
  })
  test("purgedSessions 不封顶的理由写在源码（B1 过滤要求页面生命周期内完整）", () => {
    assert.match(src, /purgedSessionsRef 不封顶/)
  })
})

/* ------------------------------------------------------------------ 11. 重复 message_start */

describe("11) 重复 message_start 不留下幽灵气泡", () => {
  const src = read("ui/src/relay/useRelay.ts")
  test("起始帧先过 messageStartSeen 再 dispatch", () => {
    assert.match(src, /const started = \(event\.message \|\| \{\}\) as AgentMessage\s*\n(?:\s*\/\/[^\n]*\n)+\s*if \(started\.role === "assistant" && messageStartSeen\(started\)\) break\s*\n\s*dispatch\(\{ type: "message-start", message: started \}\)/)
  })
  test("去重按 timestamp + model，保留最近 50 条；换房清空", () => {
    assert.match(src, /const lastMessageStartsRef = useRef<Array<\{ stamp: number; model: string; at: number \}>>\(\[\]\)/)
    assert.match(src, /recent\.some\(\(entry\) => entry\.stamp === stamp && entry\.model === model/)
    assert.match(src, /if \(recent\.length > 50\) recent\.splice\(0, recent\.length - 50\)/)
    assert.match(src, /lastMessageStartsRef\.current = \[\]/)
  })
})

/* ------------------------------------------------------------------ 12. 主 effect 卸载 */

describe("12) 主 effect 卸载时清掉定时器", () => {
  const src = read("ui/src/relay/useRelay.ts")
  test("cleanup 清惰性发送 / 发送 ack / 会话补拉定时器", () => {
    assert.match(src, /主 effect 卸载：惰性发送 \/ 发送 ack \/ 会话清单补拉的定时器一并清掉/)
    assert.match(src, /clearLazyTimers\(\)\s*\n\s*clearSendAckTimer\(\)\s*\n\s*for \(const timer of sessionRefreshTimersRef\.current\) window\.clearTimeout\(timer\)/)
  })
  test("会话补拉 setTimeout 登记到集合，触发后自删", () => {
    assert.match(src, /sessionRefreshTimersRef\.current\.delete\(timer\)/)
    assert.match(src, /sessionRefreshTimersRef\.current\.add\(timer\)/)
  })
})

/* ------------------------------------------------------------------ 13. queue-sync 全表扫 */

describe("13) queue-sync 只在本页乐观气泡命中时进 reducer", () => {
  const src = read("ui/src/relay/useRelay.ts")
  test("先按本地 cid + 变化签名判断，不再无条件 dispatch queue-sync", () => {
    assert.match(src, /const localEchoCidsRef = useRef\(new Set<string>\(\)\)/)
    assert.match(src, /const hasLocalQueueCid = useCallback\(/)
    assert.match(src, /const lastQueueSyncRef = useRef\(new Map<string, string>\(\)\)/)
    assert.match(src, /lastQueueSyncRef\.current\.get\(item\.cid\) === signature/)
    assert.equal((src.match(/if \(hasLocalQueueCid\(next\.items\)\) dispatch\(\{ type: "queue-sync"/g) ?? []).length, 2, "remote_queue_state 与 queue_get 两处都要先判")
    assert.equal((src.match(/dispatch\(\{ type: "queue-sync"/g) ?? []).length, 2, "不能有无条件 dispatch")
  })
  test("每个 echo 气泡的 cid 都记进集合（send / 回放 / 惰性 / 排队）", () => {
    assert.equal((src.match(/noteLocalEchoCid\(/g) ?? []).length >= 4, true)
  })
})
