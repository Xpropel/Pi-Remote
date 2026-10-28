// P9 修复线 W（review-1 P2-2）：标签页标题 + favicon 的「等你回答」提示。纯函数 + 源码口径。
// - presence.pageTitle：waiting 时前缀「? 」，优先级高于「● 」（运行中）和「✓」；无 waiting 行为不变；
// - badgeMarks：waiting 角标（蓝圈白色 ?）、标题前缀「? 」、优先级 badgeKindOf（waiting > 完成/出错）、
//   前缀清理（不出现「? ?」「? ●」）；
// - attention.attentionWaitingCountOf：计数来源（attentionItemsOf 的 waiting 条数，含别房 waiting / waitingPrompt）；
// - 接线：PiApp 把 waiting 传给 usePageTitle / useCompletionBadge；faviconBadge 在有 waiting 时不碰标题。
// 纯 Node 测试：只 import .ts（相对路径带扩展名），不加载 React / DOM。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { pageTitle } from "../ui/src/relay/presence.ts"
import { attentionItemsOf, attentionWaitingCountOf } from "../ui/src/relay/attention.ts"
import {
  BADGE_COLOR,
  badgeKindOf,
  badgeTitle,
  completionBadgeSvg,
  stripTitleMark,
  svgDataUri,
} from "../ui/src/chat/composer/badgeMarks.ts"

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8")
const ORIGINAL_SVG = readFileSync(new URL("../ui/public/favicon.svg", import.meta.url), "utf8")

describe("presence.pageTitle：等你回答的标题前缀", () => {
  const base = { room: "修 bug", busy: false, unseenDone: false, linkLost: false }
  test("waiting →「? 」；无 waiting 时旧行为逐条不变", () => {
    assert.equal(pageTitle({ ...base, waiting: true }), "? 修 bug · pi")
    assert.equal(pageTitle({ ...base, waiting: true, room: "" }), "? pi")
    // 旧行为（无 waiting / waiting=false）
    assert.equal(pageTitle(base), "修 bug · pi")
    assert.equal(pageTitle({ ...base, busy: true }), "● 修 bug · pi")
    assert.equal(pageTitle({ ...base, unseenDone: true }), "✓ 修 bug · pi")
    assert.equal(pageTitle({ ...base, linkLost: true }), "已断开 · 修 bug · pi")
    assert.equal(pageTitle({ ...base, waiting: false, busy: true }), "● 修 bug · pi")
  })
  test("优先级：waiting > ●（运行中）> ✓（后台跑完）", () => {
    assert.equal(pageTitle({ ...base, waiting: true, busy: true }), "? 修 bug · pi")
    assert.equal(pageTitle({ ...base, waiting: true, unseenDone: true }), "? 修 bug · pi")
    assert.equal(pageTitle({ ...base, waiting: true, busy: true, unseenDone: true }), "? 修 bug · pi")
    // 已断开仍排最前（断了的时候网页也答不了；review-1 P2-2 只要求压过 ● / ✓）
    assert.equal(pageTitle({ ...base, waiting: true, linkLost: true }), "已断开 · 修 bug · pi")
  })
})

describe("badgeMarks：waiting 角标的颜色 / 标题前缀 / 优先级", () => {
  test("颜色与标题前缀：等你回答 = 蓝（--cw-blue #047ABD）+「? 」，完成/出错原样", () => {
    assert.equal(BADGE_COLOR.waiting, "#047ABD")
    assert.equal(BADGE_COLOR.done, "#047ABD")
    assert.equal(BADGE_COLOR.error, "#9C4558")
    assert.equal(badgeTitle("会话 · pi", "waiting"), "? 会话 · pi")
    assert.equal(badgeTitle("", "waiting"), "? pi", "空标题回落 pi")
  })
  test("前缀清理：去掉 ? / ● / ✓ / !，反复叠加不出现「? ?」「? ●」", () => {
    assert.equal(stripTitleMark("? 会话 · pi"), "会话 · pi")
    assert.equal(stripTitleMark("● 会话 · pi"), "会话 · pi")
    assert.equal(stripTitleMark("已断开 · 会话 · pi"), "已断开 · 会话 · pi", "只去最前面的状态标记")
    assert.equal(badgeTitle(badgeTitle("会话 · pi", "waiting"), "waiting"), "? 会话 · pi", "不叠加")
    assert.equal(badgeTitle(badgeTitle("会话 · pi", "done"), "waiting"), "? 会话 · pi", "完成角标被 waiting 覆盖")
    assert.equal(badgeTitle(badgeTitle("会话 · pi", "waiting"), "done"), "● 会话 · pi", "waiting 结束后完成角标不继承 ?")
  })
  test("优先级 badgeKindOf：waiting > 完成 / 出错；没有 waiting 时保持原行为", () => {
    assert.equal(badgeKindOf({ waiting: 1, completion: "done" }), "waiting")
    assert.equal(badgeKindOf({ waiting: 3, completion: "error" }), "waiting")
    assert.equal(badgeKindOf({ waiting: 1, completion: null }), "waiting")
    assert.equal(badgeKindOf({ waiting: 0, completion: "done" }), "done")
    assert.equal(badgeKindOf({ waiting: 0, completion: "error" }), "error")
    assert.equal(badgeKindOf({ waiting: 0, completion: null }), null)
    assert.equal(badgeKindOf({ completion: "done" }), "done", "不传 waiting = 0，旧调用行为不变")
  })
})

describe("favicon SVG：waiting 蓝色问号圈角标", () => {
  test("保留原图，叠蓝圈 + 白色 ?，与原完成/出错角标互不串", () => {
    const waiting = completionBadgeSvg(ORIGINAL_SVG, "waiting")
    assert.ok(waiting.includes('class="mark"'), "原图路径仍在")
    assert.match(waiting, /<circle cx="438" cy="438" r="116" fill="#047ABD"/, "蓝圈（--cw-blue 浅色值）")
    assert.match(waiting, /M404 400a34 34 0 1 1 34 34v20/, "白色问号的上弧 + 短尾")
    assert.match(waiting, /<circle cx="438" cy="508" r="18" fill="#ffffff"\/>/, "问号的圆点")
    assert.doesNotMatch(waiting, /M438 366v104/, "不带出错角标的「!」竖线")
    assert.match(waiting, /<\/svg>$/, "仍是完整 SVG")
    // 完成 / 出错角标的行为不变（P7 B2g）
    const done = completionBadgeSvg(ORIGINAL_SVG, "done")
    assert.match(done, /r="116" fill="#047ABD"/)
    assert.doesNotMatch(done, /M404 400a34 34 0 1 1 34 34v20/)
    const error = completionBadgeSvg(ORIGINAL_SVG, "error")
    assert.match(error, /r="116" fill="#9C4558"/)
    assert.match(error, /M438 366v104/)
    // 颜色可传参；原图不合法时不伪造
    assert.match(completionBadgeSvg(ORIGINAL_SVG, "waiting", "#123456"), /r="116" fill="#123456"/)
    assert.equal(completionBadgeSvg("not an svg", "waiting"), "not an svg")
    assert.match(svgDataUri(waiting), /^data:image\/svg\+xml,/)
  })
})

describe("attentionWaitingCountOf：计数来源", () => {
  const room = (id, extra = {}) => ({
    id,
    label: null,
    name: null,
    firstMessage: null,
    cwd: `/w/${id}`,
    online: true,
    busy: false,
    viewers: 1,
    lastActivity: 0,
    deviceId: "dev-1",
    ...extra,
  })
  const itemsOf = (extra = {}) =>
    attentionItemsOf({
      currentRoomId: "room-a",
      rooms: [room("room-a"), room("room-b")],
      dialogs: [],
      uiPrompt: null,
      turnEnd: null,
      selectedDevice: { id: "dev-1", name: "我的电脑", online: true },
      ...extra,
    })
  test("当前房 dialog、别房 waiting、waitingPrompt 都计入；非 waiting 条目不计", () => {
    const current = itemsOf({ dialogs: [{ dialogId: "d-1", kind: "confirm", startedAt: 1 }] })
    assert.equal(attentionWaitingCountOf(current), 1)
    const other = itemsOf({
      rooms: [room("room-a"), room("room-b", { waiting: [{ dialogId: "d-2", kind: "select", startedAt: 2 }, { dialogId: "d-3", kind: "input", startedAt: 3 }] })],
    })
    assert.equal(attentionWaitingCountOf(other), 2)
    const promptOnly = itemsOf({
      rooms: [room("room-a"), room("room-b", { waiting: [], waitingPrompt: { kind: "confirm", title: "电脑上有一个确认框在等待", at: 4 } })],
    })
    assert.equal(attentionWaitingCountOf(promptOnly), 1)
    const nonWaiting = itemsOf({
      roomTurnEnds: [{ seq: 1, at: 5, roomId: "room-b", error: true }],
      selectedDevice: { id: "dev-1", name: "我的电脑", online: false },
    })
    assert.equal(attentionWaitingCountOf(nonWaiting), 0, "出错 / 掉线不算等你回答")
    assert.equal(attentionWaitingCountOf([]), 0)
  })
})

describe("接线（源码口径）：PiApp 算 waiting；faviconBadge 有 waiting 时不碰标题", () => {
  test("PiApp 的设置宿主：waiting 由 attentionItemsOf + attentionWaitingCountOf 算出，传给 usePageTitle / useCompletionBadge", () => {
    const app = read("ui/src/pi/PiApp.tsx")
    assert.match(app, /<PiSettingsHost\b/)
    assert.doesNotMatch(app, /useCompletionBadge\(|usePageTitle\(/, "PiApp 不再自己接线通知 hook（交给 PiSettingsHost）")
    const host = read("ui/src/pi/hooks/PiSettingsHost.tsx")
    assert.match(host, /attentionItemsOf\(\{/)
    assert.match(host, /attentionWaitingCountOf\(/)
    assert.match(host, /usePageTitle\(relay, waitingVisible/)
    assert.match(host, /useCompletionBadge\(relay, waitingVisible/)
  })
  test("usePageTitle 把 waiting 传进 pageTitle；faviconBadge 里 waiting 只画 favicon、标题交给 usePageTitle", () => {
    const hook = read("ui/src/chat/hooks.ts")
    assert.match(hook, /export function usePageTitle\(relay: Relay, waiting = 0, options: UsePageTitleOptions = \{\}\)/)
    assert.match(hook, /waiting: waiting > 0/)
    const badge = read("ui/src/chat/composer/faviconBadge.ts")
    assert.match(badge, /export function useCompletionBadge\(relay: BadgeRelay, waiting = 0, options: UseCompletionBadgeOptions = \{\}\)/)
    assert.match(badge, /badgeKindOf\(\{ waiting: waitingCount, completion: completionKind \}\)/)
    // waiting 分支必须在写标题之前 return（避免 MutationObserver 叠出「? ?」/「? ●」）
    const waitingAt = badge.indexOf('if (kind === "waiting") {')
    assert.ok(waitingAt > 0, "有 waiting 分支")
    const waitingBranch = badge.slice(waitingAt, badge.indexOf("return", waitingAt))
    assert.doesNotMatch(waitingBranch, /document\.title =/, "waiting 期间不改标题")
    assert.match(badge, /if \(!kind \|\| kind === "waiting"\) return/, "waiting 期间不挂 MutationObserver")
    // 标题前缀「? 」在 presence.pageTitle 里（纯函数已测），标题钩子只负责写它
    const presence = read("ui/src/relay/presence.ts")
    assert.match(presence, /if \(input\.waiting\) return `\? \$\{base\}`/)
  })
})
