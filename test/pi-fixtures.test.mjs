// P5.2 live fixtures（ui/src/pi/dev/fixtures/live/*.ts）：每屏一份 relay 原始状态，这里用真实函数算出界面关键值，
// 和 replica 屏（R/replica/src/screens/pi/{a,b,c}/<id>.tsx）对照。对不上的地方是 relay 数据缺口，断言写真实结果并标出缺口号（见 R2/logs/side-fixtures/report.md）。
// 纯 Node 测试：fixture 与模型只 import .ts、相对路径带扩展名，node --test 直接加载。
import test from "node:test"
import assert from "node:assert/strict"
import { readdirSync } from "node:fs"
import { attentionItemsOf, attentionCountOf, attentionCountByDevice } from "../ui/src/relay/attention.ts"
import { linkView, linkBannerText, firstConnecting } from "../ui/src/relay/presence.ts"
import {
  mergeDeviceSessions,
  rosterActive,
  attachCommand,
  formatPairCode,
  pairRemainText,
  pairCommands,
  deviceAuthState,
  canRevoke,
  windowRemainText,
  adminTokenReady,
  cwdInProjects,
  pickDefaultDevice,
} from "../ui/src/relay/devices.ts"
import { groupItems, toolDisplayState } from "../ui/src/relay/transcript.ts"
import { contextReadout, contextRingOf } from "../ui/src/relay/contextUsage.ts"
import { canMutateRemoteQueueItem, remoteQueueSourceLabel } from "../ui/src/relay/remoteQueue.ts"
import { deriveComposer, ATTACHMENT_MAX_COUNT } from "../ui/src/chat/composerMachine.ts"
import { searchSessions, bodySearchPageOf, highlightParts, BODY_SEARCH_QUERY_MIN } from "../ui/src/shell/searchModel.ts"
import { parseMentionTrigger, collectTranscriptFiles, filterMentionFiles } from "../ui/src/chat/composer/mention.ts"
import { parseResourceCommands } from "../ui/src/chat/slashParse.ts"
import { parseThinkingLevels, currentThinkingLevel, thinkingLevelLabel } from "../ui/src/chat/thinkingLevels.ts"
import { visibleTerminalItems, terminalRetentionMs } from "../ui/src/chat/capsules/terminalModel.ts"
import { workingCapsuleView } from "../ui/src/chat/capsules/workingModel.ts"
import { sidebarGroups } from "../ui/src/pi/model/sidebarGroups.ts"
import { rowMarkerOf } from "../ui/src/pi/model/rowMarker.ts"
import { trayItemsOf, queueSectionsOf } from "../ui/src/pi/model/tray.ts"
import { composerButtonOf, composerBlockOf, composerButtonLabel } from "../ui/src/pi/model/composerButton.ts"
import { composerReasonOf } from "../ui/src/pi/model/composerReason.ts"
import { dialogCardState } from "../ui/src/pi/model/dialogCard.ts"
import { phoneDockLayout } from "../ui/src/pi/model/phoneDock.ts"
import { mergeExploreRuns, toolWeightOf } from "../ui/src/pi/model/toolWeight.ts"
import { turnReceipts } from "../ui/src/pi/model/receipts.ts"
import { changesOfSession } from "../ui/src/pi/model/changes.ts"
import { costNoteOf } from "../ui/src/pi/model/costNote.ts"
import { migratePiPrefs, setPiPref, DEFAULT_PI_PREFS } from "../ui/src/pi/model/prefs.ts"
import { liveRelayOf } from "../ui/src/pi/dev/fixtures/derive.ts"
import { MOCK_NOW } from "../ui/src/pi/dev/fixtures/types.ts"
import { KEYBOARD_TEST_PATH, VIEWPORT_PATH, CONVERSATION_PATH, PI_REMOTE, NOTES, MBP, STUDIO, THINKPAD } from "../ui/src/pi/dev/fixtures/shared.ts"

const LIVE_DIR = new URL("../ui/src/pi/dev/fixtures/live/", import.meta.url)
const S = 1000

async function load(id, options) {
  const mod = await import(new URL(`${id}.ts`, LIVE_DIR).href)
  const fx = mod.default
  return { fx, mod, relay: liveRelayOf(fx, options) }
}

/* ---------------- 容器胶水（P5 的容器照这个口径取 relay 的切片） ---------------- */

function attentionOf(r) {
  return attentionItemsOf({
    currentRoomId: r.roomId ?? "",
    rooms: r.rooms ?? [],
    dialogs: r.dialogs ?? [],
    uiPrompt: r.uiPrompt ?? null,
    turnEnd: r.turnEnd ?? null,
    roomTurnEnds: r.roomTurnEnds ?? [],
    selectedDevice: r.selectedDevice ?? null,
  })
}
/** 侧栏要全部设备的会话：按设备 mergeDeviceSessions，再带上 deviceId（relay.listedSessions 只有选中设备） */
function sidebarSessionsOf(r) {
  return (r.devices ?? []).flatMap((d) => mergeDeviceSessions(d, r.rooms ?? [], r.sessionsByDevice?.[d.id] ?? []).map((s) => ({ ...s, deviceId: d.id })))
}
function linkOf(r, now) {
  return linkView({ token: r.token ?? "", authed: r.authed ?? false, everConnected: r.everConnected ?? false, retryAt: r.retryAt ?? null }, now)
}
function deviceOf(r) {
  return r.selectedDevice ? { name: r.selectedDevice.name, online: r.selectedDevice.online } : null
}
function trayOf(r, fx) {
  const link = linkOf(r, fx.now)
  return trayItemsOf({
    taskList: r.taskList,
    remoteQueue: r.remoteQueue?.items,
    localQueue: r.queue,
    outbox: fx.outbox,
    terminals: r.terminalItems,
    changes: changesOfSession(r.transcript?.items),
    linkOk: link.kind === "ok",
    deviceOnline: r.selectedDevice?.online ?? true,
  })
}
function reasonOf(r, fx, blockedBy = null) {
  return composerReasonOf(linkOf(r, fx.now), deviceOf(r), { state: r.composer.state }, blockedBy, !r.lazySession)
}
/** 当前会话的最后一个回合：从最后一条用户消息起 */
function lastTurn(items) {
  let k = items.length - 1
  while (k > 0 && items[k].kind !== "user") k--
  return items.slice(k)
}
const labels = (tray) => tray.map((x) => x.label)

/* ---------------- 通用 ---------------- */

const IDS = readdirSync(LIVE_DIR).filter((f) => f.endsWith(".ts")).map((f) => f.slice(0, -3)).sort()

test("每份 live fixture：id 与文件名一致、now 固定为 MOCK_NOW、不写 useRelay 的派生字段", async () => {
  // P4.2 mock 线新增 p4-devices / p4-workbench；数量只增不减（每份都逐项校验）
  assert.ok(IDS.length >= 32, `fixture 数量异常：${IDS.length}`)
  assert.equal(MOCK_NOW, 1792809720000, "= replica shared/mock.ts 的 MOCK_NOW")
  for (const id of IDS) {
    const { fx } = await load(id)
    assert.equal(fx.id, id)
    assert.equal(fx.now, MOCK_NOW)
    for (const key of ["composer", "listedSessions", "selectedDevice", "pendingStart", "retryReady"]) {
      assert.ok(!(key in fx.relay), `${id} 不应直接写派生字段 ${key}`)
    }
  }
})

/* ================================================================ a 区 */

test("a/login：没有 token 时 linkView 是 ok（登录页），不算首次连接，「连接」不可点", async () => {
  const { relay, fx } = await load("login")
  assert.equal(linkOf(relay, fx.now).kind, "ok")
  assert.equal(firstConnecting({ token: relay.token, authed: relay.authed, everConnected: relay.everConnected, retryAt: relay.retryAt }), false)
  assert.equal(relay.token.trim() !== "", false, "token 去空白后为空 → 连接禁用（design §9.2）")
  assert.deepEqual(attentionOf(relay), [])
})

test("a/boot-loading：首次连接（first），列表没有组，不出空会话卡", async () => {
  const { relay, fx } = await load("boot-loading")
  assert.equal(linkOf(relay, fx.now).kind, "first")
  assert.equal(firstConnecting({ token: relay.token, authed: relay.authed, everConnected: relay.everConnected, retryAt: relay.retryAt }), true)
  const model = sidebarGroups(sidebarSessionsOf(relay), relay.devices, attentionOf(relay))
  assert.equal(model.groups.length, 0)
  assert.equal(model.attentionRows.length, 0)
  assert.equal(relay.roomId, "", "没有房间 → 主区只有 Spinner")
})

test("a/session-list：需要处理组、按设备 / 目录分组、更多 7、文件夹行、离线组", async () => {
  const { relay } = await load("session-list")
  // P9 A（room.dialogs）：relay 现在给名册条目带上别的房间的等待摘要。fixture 是 P5 的旧数据
  // （缺口 G1：r-s3 的「等你回答」拿不到），这里按协议补上 r-s3 的 waiting，再喂同一批真实函数。
  const withWaiting = (answerable) => ({
    ...relay,
    rooms: relay.rooms.map((room) =>
      room.id === "r-s3"
        ? { ...room, waiting: [{ dialogId: "dlg-7f3", kind: "select", title: "允许 pi 运行这条命令吗？", startedAt: MOCK_NOW - 60 * S, answerable }] }
        : room,
    ),
  })
  const live = withWaiting(true)
  const attention = attentionOf(live)
  // replica 4 行（waiting r-s3、error r-s6、device-offline ThinkPad〔G2 侧栏补，不在 attentionItemsOf 里〕、done r-s4）
  assert.deepEqual(attention.map((x) => `${x.kind}:${x.roomId}`), ["waiting:r-s3", "error:r-s6", "done:r-s4"])
  const model = sidebarGroups(sidebarSessionsOf(live), live.devices, attention)
  assert.deepEqual(model.attentionRows.map((x) => `${x.id}:${x.marker}`), ["r-s3:waiting", "r-s6:error", "r-s4:unread"])
  assert.equal(model.attentionRows[0].trailingText, "等你回答", "P9 A：等你回答的行尾文案")
  assert.equal(model.attentionRows[0].trailingTone, "attention")
  assert.deepEqual(model.groups.map((g) => g.label), [
    "MacBook Pro/pi-remote",
    "MacBook Pro/notes-app",
    "MacBook Pro/dotfiles",
    "Mac Studio/billing-service",
    "Mac Studio/infra",
    "ThinkPad/game-tools",
  ])
  assert.equal(model.groups.reduce((n, g) => n + g.rows.length, 0), 10)
  const piRemote = model.groups[0]
  assert.equal(piRemote.rows.length, 5)
  assert.equal(piRemote.more, 7)
  assert.equal(model.groups[2].folderOnly, true, "dotfiles 没有会话 → 文件夹行")
  const thinkpad = model.groups[5]
  assert.equal(thinkpad.offline, true)
  assert.equal(thinkpad.rows[0].dimmed, true)
  assert.equal(thinkpad.rows[0].marker, "unloaded")
  const marker = Object.fromEntries(model.groups.flatMap((g) => g.rows).map((x) => [x.id, x.marker]))
  assert.equal(marker["r-s2"], "running")
  assert.equal(marker["r-s4"], "unread")
  assert.equal(marker["r-s6"], "error")
  assert.equal(marker["s7"], "unloaded")
  assert.equal(marker["r-s3"], "waiting", "P9 A：replica 的 waiting 现在拿得到了（G1 已补）")
  const rS3 = piRemote.rows.find((x) => x.id === "r-s3")
  assert.equal(rS3.trailingText, "等你回答")
  assert.equal(rS3.trailingTone, "attention")
  // 这个网页不能直接答（relay 去掉 answerable）：行尾改成「等你在电脑上回答」
  const notAnswerable = sidebarGroups(sidebarSessionsOf(withWaiting(false)), live.devices, attentionOf(withWaiting(false)))
  assert.equal(notAnswerable.groups[0].rows.find((x) => x.id === "r-s3").trailingText, "等你在电脑上回答")
  // G3（P5 a 线已修）：活动房间行的 updatedAt 回落到清单里的会话 / 房间 lastActivity → 行尾有时间（replica r-s1「2m」）
  assert.equal(piRemote.rows.find((x) => x.id === "r-s1").at, MOCK_NOW - 2 * 60 * S)
  assert.equal(model.groups[4].rows[0].at, MOCK_NOW - 24 * 3600 * S, "索引行有时间")
})

test("a/session-list states：展开「更多 7」出 12 行；不分组 17 行、离线行副标题带「 · 未连接」", async () => {
  const { relay } = await load("session-list")
  const sessions = sidebarSessionsOf(relay)
  const attention = attentionOf(relay)
  const open = sidebarGroups(sessions, relay.devices, attention, { expanded: [`d-mbp:${PI_REMOTE}`] })
  assert.equal(open.groups[0].rows.length, 12)
  assert.equal(open.groups[0].expanded, true)
  const flat = sidebarGroups(sessions, relay.devices, attention, { grouping: "flat" })
  assert.equal(flat.groups.length, 1)
  assert.equal(flat.groups[0].rows.length, 17)
  assert.equal(flat.groups[0].rows.find((x) => x.id === "r-s8").subtitle, "ThinkPad/game-tools · 未连接")
  // G3（P5 a 线已修）：活动房间有了真实时间，平铺按 updatedAt 倒序同 replica：r-s2 在最上、最旧的 s18 在最后
  assert.equal(flat.groups[0].rows[0].id, "r-s2")
  assert.equal(flat.groups[0].rows.at(-1).id, "s18")
})

test("a/session-search：标题匹配 2（本地过滤）、正文匹配 2（search_session_bodies，扫完 13 个文件）、命中词切段", async () => {
  const { relay } = await load("session-search")
  const titles = searchSessions(relay.listedSessions, "键盘")
  assert.deepEqual(titles.map((x) => x.id), ["r-s1", "r-s10"])
  assert.ok("键盘".length >= BODY_SEARCH_QUERY_MIN, "两个字够发正文搜索")
  const page = bodySearchPageOf(await relay.searchSessionBodies("键盘"))
  assert.equal(page.results.length, 2)
  assert.deepEqual(page.results.map((x) => x.matchCount), [1, 2])
  assert.equal(page.scannedFiles, 13)
  assert.equal(page.truncated, false)
  assert.deepEqual(highlightParts(page.results[0].snippets[0].text, "键盘").filter((p) => p.hit).map((p) => p.text), ["键盘"])
})

test("a/session-menu：r-s4 不是当前会话、不忙、已载入（正在运行：P8 R25 起删除置灰，规则见 test/pi-delete-route）；活动房间行的消息数回落到清单的 31（G3 已修）", async () => {
  const { relay } = await load("session-menu")
  const row = relay.listedSessions.find((x) => x.id === "r-s4")
  assert.equal(row.openable, true)
  assert.equal(row.busy, false)
  assert.notEqual(row.id, relay.roomId, "r-s4 不是当前会话")
  assert.equal(row.title, "整理 README 的配对步骤")
  // replica sheet 副标题「MacBook Pro/pi-remote · 31 条」：G3（P5 a 线已修）后房间行的 messageCount 回落到清单里同 id 的会话
  assert.equal(relay.sessionsByDevice["d-mbp"].find((x) => x.id === "r-s4").messageCount, 31)
  assert.equal(row.messageCount, 31)
})

test("a/session-info：上下文 30.9%（可信、上环、未预警）、缓存命中 87%、分支 main、设备 MacBook Pro", async () => {
  const { relay } = await load("session-info")
  const readout = contextReadout(relay.usage.contextUsage)
  assert.equal(readout.state, "ok")
  assert.equal(readout.label, "上下文 30.9%")
  assert.deepEqual(contextRingOf(readout.percent), { fraction: 0.309, tone: "ok" })
  const t = relay.usage.tokens
  assert.equal(Math.round((t.cacheRead / (t.input + t.cacheRead)) * 100), 87, "model/sessionInfo.ts 还没有，这里照计划的公式算")
  assert.equal(relay.usage.cost, 3.84)
  assert.deepEqual(await relay.runCommand("get_git_branch"), { branch: "main", repoRoot: PI_REMOTE, detached: false })
  assert.equal(relay.selectedDevice.name, "MacBook Pro")
  assert.equal(`${relay.modelMeta.name} · ${relay.thinkingLevel}`, "Claude Sonnet 4.5 · medium")
})

test("a/no-devices：名册生效但为空，列表没有组、没有注意力，能配对", async () => {
  const { relay } = await load("no-devices")
  assert.equal(rosterActive({ deviceMode: relay.deviceMode, devices: relay.devices, rooms: relay.rooms }), true)
  const model = sidebarGroups(sidebarSessionsOf(relay), relay.devices, attentionOf(relay))
  assert.equal(model.groups.length, 0)
  assert.equal(model.attentionRows.length, 0)
  assert.equal(relay.canManageDevices, true, "显示「配对新设备」")
  assert.equal(relay.selectedDevice, null)
})

test("a/reconnecting：waiting 4 秒、composer「写好先排队 / 未连接服务器 · 发送会排队」、tray「排队 1 · 等重连」", async () => {
  const { relay, fx } = await load("reconnecting")
  const link = linkOf(relay, fx.now)
  assert.deepEqual(link, { kind: "waiting", seconds: 4, first: false })
  assert.equal(linkBannerText(link), "和服务器的连接断了，4 秒后重连")
  assert.equal(relay.retryCount, 3)
  // replica dock 标 S5；空框断线在真实状态机里是 S0（S5 要有内容）
  assert.equal(relay.composer.state, "S0")
  const reason = reasonOf(relay, fx)
  assert.equal(reason.placeholder, "写好先排队")
  assert.equal(reason.note, "未连接服务器 · 发送会排队")
  assert.equal(reason.tone, "warn")
  assert.equal(reason.live, false, "连接状态由 PiStatusLine 播报")
  assert.equal(labels(trayOf(relay, fx))[0], "排队 1 · 等重连")
  const sections = queueSectionsOf(relay.remoteQueue.items, relay.queue, fx.outbox, false, true)
  assert.deepEqual(sections.map((x) => x.title), ["本页待发 · 等重连"])
})

test("a/device-offline：「ThinkPad 未连接 · 上线后发送」、Windows attach 命令、设备掉线注意力、ThinkPad 组离线", async () => {
  const { relay, fx } = await load("device-offline")
  const reason = reasonOf(relay, fx)
  assert.equal(reason.note, "ThinkPad 未连接 · 上线后发送")
  assert.equal(reason.placeholder, "写好先排队")
  assert.equal(reason.tone, "warn")
  assert.equal(reason.showDevice, false, "原因已写设备名")
  assert.equal(attachCommand(relay.selectedDevice.platform), "deploy\\attach.cmd")
  const attention = attentionOf(relay)
  assert.ok(attention.some((x) => x.kind === "device-offline" && x.key === "device:d-win" && x.title === "ThinkPad"))
  assert.equal(relay.composer.canType, true, "输入照常可写")
  const model = sidebarGroups(sidebarSessionsOf(relay), relay.devices, attention)
  assert.equal(model.groups.find((g) => g.deviceId === "d-win").offline, true)
  assert.equal(relay.transcript.items.length, 2, "保留最后快照，不清空正文")
})

test("a/device-pairing：配对码 K7Q4-MX2P 剩 9:12、两条接入命令、设备鉴权态与撤销", async () => {
  const { relay, fx } = await load("device-pairing")
  assert.equal(adminTokenReady(relay.adminToken), true)
  const pair = await relay.createPairCode(relay.adminToken)
  assert.equal(formatPairCode(pair.code), "K7Q4-MX2P")
  assert.equal(pairRemainText(pair.expiresAt - fx.now), "9:12")
  const commands = Object.fromEntries(pairCommands(pair.code).map((x) => [x.platform, x.command]))
  assert.equal(commands.unix, "deploy/attach.sh --pair K7Q4-MX2P")
  assert.equal(commands.windows, "node deploy\\attach.cjs --pair K7Q4-MX2P")
  assert.deepEqual(relay.devices.map((d) => deviceAuthState(d).text), ["已配对", "已配对", "已配对"])
  assert.equal(canRevoke(THINKPAD), true)
  // replica「窗口剩余 21h」用 piDuration（P3.2 才进 ui）；现有 windowRemainText 写成 21:00
  assert.equal(windowRemainText(STUDIO.windowExpiresAt - fx.now), "21:00")
})

test("a/background-alerts：通知槽只放 1 张 warning，后面排 2 条；注意力计数 2（replica「‹ 4」，G1 / G2）", async () => {
  const { relay } = await load("background-alerts")
  assert.equal(relay.notices.length, 1)
  assert.equal(relay.notices[0].level, "warning")
  assert.equal(relay.notices[0].title, "刚才的操作结果未知")
  assert.equal(relay.noticeQueue, 2)
  assert.equal(attentionCountOf(attentionOf(relay)), 2)
})

/* ================================================================ b 区 */

test("b/conversation：最后一回合 2 组、探索合并「查看了 3 个文件，搜索 2 次」、用时 2m 14s、思考写「已思考」（G4）", async () => {
  const { relay, fx } = await load("conversation")
  const turn = lastTurn(relay.transcript.items)
  assert.deepEqual(groupItems(turn).map((g) => g.role), ["user", "assistant"])
  const runs = mergeExploreRuns(turn[1].blocks)
  assert.deepEqual(runs.map((x) => (x.kind === "explore" ? x.summary.text : x.block.kind)), ["thinking", "查看了 3 个文件，搜索 2 次", "tool"])
  const receipts = turnReceipts({ items: turn })
  assert.equal(receipts.workedMs, 134 * S)
  assert.deepEqual(receipts.thinking, { text: "已思考", ms: null }, "replica「思考 6 秒」要 observedMs")
  assert.equal(toolWeightOf("edit"), "diff")
  assert.equal(toolWeightOf("bash"), "terminal")
  assert.equal(relay.composer.state, "S0")
  assert.deepEqual(composerButtonOf(relay.composer.state, false), { variant: "send-muted", disabled: true, ghostStop: false })
  assert.deepEqual(trayOf(relay, fx).map((x) => x.kind), ["changes"])
  assert.equal(labels(trayOf(relay, fx))[0], "改动 +32 −9", "改动 pill 的数字来自 details.patch（G5）")
  assert.equal(turn[0].images[0].omitted, true, "用户卡截图走 get_image")
})

test("b/conversation-streaming：S3 黑圆停止、tray 任务 2/4 · 终端 1 · 改动、一条 subagent 在跑", async () => {
  const { relay, fx } = await load("conversation-streaming")
  assert.equal(relay.composer.state, "S3")
  assert.equal(relay.composer.stopVisible, true)
  assert.equal(composerBlockOf(relay.composer.state, null).button.variant, "stop")
  const tray = trayOf(relay, fx)
  assert.deepEqual(tray.map((x) => x.kind), ["tasks", "terminal", "changes"])
  assert.equal(tray[0].label, "任务 2/4")
  assert.equal(tray[0].running, true)
  assert.equal(tray[1].label, "终端 1")
  assert.equal(tray[1].running, true)
  assert.deepEqual(workingCapsuleView(relay.agentState, fx.now), { kind: "working", count: 1, succeeded: 0, failed: 0, aborted: 0 })
  const live = relay.transcript.items.find((x) => x.key === relay.transcript.liveKey)
  assert.equal(live.live, true)
  assert.equal(toolDisplayState(live.blocks.at(-1)), "running")
  assert.equal(reasonOf(relay, fx).placeholder, "继续追问…")
})

test("b/approval-waiting：S3 + blockedBy approval → 输入已禁用 / 先回答上面的问题、停止钮保留、卡剩 82 秒", async () => {
  const { relay, fx } = await load("approval-waiting")
  assert.equal(relay.composer.state, "S3", "审批禁用不是 S7")
  const card = dialogCardState(relay.dialogs[0], null, fx.now)
  assert.equal(card.state, "open")
  assert.equal(card.remainingSec, 82)
  assert.equal(card.observe, false)
  assert.equal(card.blocksComposer, true)
  const blockedBy = card.blocksComposer ? "approval" : null
  const block = composerBlockOf(relay.composer.state, blockedBy)
  assert.equal(block.button.variant, "stop")
  assert.equal(block.readOnly, true)
  assert.equal(block.menusEnabled, false)
  const reason = reasonOf(relay, fx, blockedBy)
  assert.equal(reason.placeholder, "输入已禁用")
  assert.equal(reason.note, "先回答上面的问题")
  assert.equal(reason.tone, "warn")
  const attention = attentionOf(relay)
  assert.equal(attention[0].key, "dialog:dlg-7f3")
  assert.equal(attention[0].title, "给 history-backfill 补测试")
  assert.equal(attention[0].detail, "等你处理：允许 pi 运行这条命令吗？")
  // replica 画成「等你确认」（waiting_approval）；现在的协议里停在 input-available（G6）
  assert.equal(toolDisplayState(relay.transcript.items.at(-1).blocks.at(-1)), "running")
  assert.equal(labels(trayOf(relay, fx))[0], "改动 +12 −0")
})

test("b/stream-errors：进入 r-s6 清掉它的出错条目；失败 / 已拒绝 / 超时三种工具态；回合出错 overloaded_error；发送失败", async () => {
  const { relay } = await load("stream-errors")
  const attention = attentionOf(relay)
  assert.ok(!attention.some((x) => x.roomId === "r-s6"))
  assert.deepEqual(attention.map((x) => x.key), ["turn:r-s4:7"])
  const tools = relay.transcript.items.flatMap((x) => (x.kind === "assistant" ? x.blocks.filter((b) => b.kind === "tool") : []))
  assert.deepEqual(tools.map((b) => toolDisplayState(b)), ["failed", "denied", "failed"])
  assert.equal(tools[2].outcome, "timeout")
  const failedTurn = relay.transcript.items.find((x) => x.kind === "assistant" && x.stopReason === "error")
  assert.equal(failedTurn.errorMessage, "overloaded_error")
  const lastUser = relay.transcript.items.at(-1)
  assert.equal(lastUser.failed, "ack timeout")
  assert.equal(relay.history.status, "error", "流顶「更早的消息加载失败 · 重试」")
  assert.equal(relay.retryReady, true, "用户卡下「重试」可点")
})

test("b/session-archived：本机记录 3 条、更早 22 条没放进来；占位「发送时载入」+「Mac Studio · 未载入，发第一条时载入」", async () => {
  const { relay, fx } = await load("session-archived")
  const view = relay.sessionArchive("s7")
  assert.equal(view.items.length, 3)
  assert.equal(view.truncated, true)
  assert.equal(view.omitted, 22)
  assert.equal(view.total, 64)
  // ArchiveSession 只有 user / assistant 文字：replica 的摘要、!bash、扩展消息、过大图占位出不来（G9）
  assert.deepEqual([...new Set(view.items.map((x) => x.kind))], ["user", "assistant"])
  assert.ok(relay.rooms.some((x) => x.id === "s7"), "withLazyRoom 并入合成房间")
  const reason = reasonOf(relay, fx)
  assert.equal(reason.placeholder, "发送时载入")
  assert.equal(reason.note, "Mac Studio · 未载入，发第一条时载入")
  assert.equal(reason.tone, "default")
  assert.equal(relay.retryReady, false)
})

test("b/changes-pane：3 个文件（按第一次编辑的先后）、viewport 改了 2 次、edit 读 patch 带行号、合计 +32 −9（G5）", async () => {
  const { relay, fx } = await load("changes-pane")
  const changes = changesOfSession(relay.transcript.items)
  assert.deepEqual(changes.files.map((f) => f.path), [KEYBOARD_TEST_PATH, VIEWPORT_PATH, CONVERSATION_PATH])
  assert.deepEqual(changes.files.map((f) => f.edits), [1, 2, 1])
  assert.deepEqual([changes.files[0].added, changes.files[0].removed], [12, 0], "write 新文件全是增行")
  assert.equal(changes.files[0].rows[0].n, 1)
  assert.deepEqual(changes.files.slice(1).map((f) => [f.added, f.removed]), [[16, 6], [4, 3]], "edit 的计数来自 details.patch")
  assert.equal(changes.files[1].rows[0].n, 30, "patch 带文件行号（hunk @@ -30,8 +30,9 @@）")
  assert.equal(changes.files[1].rows.find((r) => r.kind === "add").n, 34, "第一处增行 = firstChangedLine")
  const viewportEdit = relay.transcript.items.flatMap((x) => (x.kind === "assistant" ? x.blocks : [])).find((b) => b.id === "toolu_01Kp2q")
  assert.equal(viewportEdit.firstChangedLine, 34)
  assert.deepEqual([changes.added, changes.removed], [32, 9])
  assert.equal(labels(trayOf(relay, fx)).at(-1), "改动 +32 −9")
})

test("b/terminal-pane：3 条命令都在保留期内（成功 30 秒、失败 60 秒）、终端 pill 计运行中的 1 条", async () => {
  const { relay, fx } = await load("terminal-pane")
  assert.equal(visibleTerminalItems(relay.terminalItems, fx.now).length, 3)
  assert.deepEqual(relay.terminalItems.map((x) => x.state), ["succeeded", "failed", "running"])
  assert.equal(terminalRetentionMs({ state: "succeeded" }), 30 * S)
  assert.equal(terminalRetentionMs({ state: "failed" }), 60 * S)
  assert.ok(fx.now - relay.terminalItems[0].endedAt < 30 * S)
  const pill = trayOf(relay, fx).find((x) => x.kind === "terminal")
  assert.equal(pill.label, "终端 1")
})

test("b/file-pane：get_file 回包照扩展 readFileInRoot 的契约（G10）：文件名、utf8、大小（按正文实际字节）、未截断", async () => {
  const { relay } = await load("file-pane")
  const file = await relay.getFile(VIEWPORT_PATH)
  assert.equal(file.name, "useMobileViewport.ts")
  assert.equal(file.encoding, "utf8")
  assert.equal(file.size, new TextEncoder().encode(file.data).length)
  assert.equal(file.truncated, false)
  assert.equal(file.data.split("\n").length - 1, 32, "32 行")
  assert.equal("path" in file || "text" in file, false, "replica 的 path / text 不是契约字段")
})

test("b/task-panel：tray「任务 2/4」在跑、进行中那项写 activeForm", async () => {
  const { relay, fx } = await load("task-panel")
  const pill = trayOf(relay, fx).find((x) => x.kind === "tasks")
  assert.equal(pill.label, "任务 2/4")
  assert.equal(pill.running, true)
  const doing = relay.taskList.filter((x) => x.status === "in_progress")
  assert.deepEqual(doing.map((x) => x.activeForm), ["正在跑横屏用例"])
  assert.equal(relay.taskList.filter((x) => x.status === "pending").length, 1)
})

/* ================================================================ c 区 */

test("c/new-session：没有房间、框空 → S0 浅灰钮；目录只能从 MacBook Pro 的 projects 里选", async () => {
  const { relay, fx } = await load("new-session")
  assert.equal(relay.composer.state, "S0")
  assert.deepEqual(composerButtonOf(relay.composer.state, false), { variant: "send-muted", disabled: true, ghostStop: false })
  assert.equal(composerButtonLabel(composerButtonOf(relay.composer.state, false)), "发送（不可用）")
  assert.equal(cwdInProjects(relay.selectedDevice.projects, PI_REMOTE), true)
  assert.equal(cwdInProjects(relay.selectedDevice.projects, "/tmp/elsewhere"), false)
  assert.equal(pickDefaultDevice(relay.devices, relay.rooms), "d-mbp")
  assert.equal(reasonOf(relay, fx).note, null)
})

test("c/new-session-picker：允许 3 个目录，「最近」= pi-remote、notes-app（dotfiles 没有会话）", async () => {
  const { relay } = await load("new-session-picker")
  assert.equal(relay.selectedDevice.projects.length, 3)
  const latest = new Map()
  for (const s of relay.sessionsByDevice[relay.selectedDeviceId]) latest.set(s.cwd, Math.max(latest.get(s.cwd) ?? 0, s.updatedAt))
  const recent = [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([cwd]) => cwd)
  assert.deepEqual(recent, [PI_REMOTE, NOTES])
  assert.ok(!recent.includes(MBP.projects[2]))
})

test("c/composer-keyboard：S1 可发、黑圆「发送」；手机键盘开着 dock 305 / 审批 203", async () => {
  const { relay, fx } = await load("composer-keyboard", { mobile: true })
  assert.equal(relay.composer.state, "S1")
  assert.equal(relay.composer.canSend, true)
  const button = composerButtonOf(relay.composer.state, true)
  assert.deepEqual(button, { variant: "send", disabled: false, ghostStop: false })
  assert.equal(composerButtonLabel(button), "发送")
  assert.ok(!/Enter/.test(relay.composer.placeholder), "手机占位不出现键名")
  assert.deepEqual(phoneDockLayout(508, true, 0), { dockMax: 305, approvalMax: 203, approvalHeight: 0 })
  assert.equal(reasonOf(relay, fx).note, null)
  assert.equal(relay.composer.delivery.command, "prompt", "不忙时 S1 发 prompt")
})

test("c/slash-menu：「/」是 S1；本机资源 2 条（模板 + 技能，都可执行）", async () => {
  const { relay } = await load("slash-menu")
  assert.equal(relay.composer.state, "S1")
  const resources = parseResourceCommands(await relay.runCommand("get_commands"))
  assert.deepEqual(resources.map((x) => x.name), ["review-pr", "release-notes"])
  assert.ok(resources.every((x) => x.executable))
})

test("c/mention-menu：触发词「mob」、候选按「文件名开头 > 文件名包含」排序，useMobileViewport.ts 在最后", async () => {
  const { relay } = await load("mention-menu")
  const trigger = parseMentionTrigger(relay.draft, relay.draft.length)
  assert.deepEqual(trigger, { start: 4, query: "mob" })
  const chosen = new Set(relay.pendingFiles.map((x) => x.path))
  const pool = collectTranscriptFiles(relay.transcript.items).filter((f) => !chosen.has(f.path))
  const hits = filterMentionFiles(pool, trigger.query).map((f) => f.path)
  assert.deepEqual(hits, [KEYBOARD_TEST_PATH, CONVERSATION_PATH, VIEWPORT_PATH])
  assert.equal(relay.composer.state, "S1")
})

test("c/attach-menu：S0 可加附件、菜单可开；附件上限 5", async () => {
  const { relay } = await load("attach-menu")
  assert.equal(relay.composer.canAttach, true)
  assert.equal(composerBlockOf(relay.composer.state, null).menusEnabled, true)
  assert.equal(ATTACHMENT_MAX_COUNT, 5)
  assert.equal(relay.lazySession ?? null, null, "已载入：「命令…」可用")
})

test("c/model-menu：5 档思考级别、当前 medium、当前模型 Claude Sonnet 4.5", async () => {
  const { relay } = await load("model-menu")
  const levels = parseThinkingLevels(await relay.runCommand("get_available_thinking_levels"))
  assert.deepEqual(levels, ["off", "minimal", "low", "medium", "high"])
  assert.equal(currentThinkingLevel(levels, relay.thinkingLevel), "medium")
  // replica 分段控件写「中」；现有显示名是英文 Medium（文案待 P5 定）
  assert.equal(thinkingLevelLabel("medium"), "Medium")
  assert.equal(relay.modelMeta.name, "Claude Sonnet 4.5")
  const models = await relay.runCommand("get_available_models")
  const configured = new Set(models.available.map((x) => `${x.provider}/${x.id}`))
  assert.deepEqual(models.models.filter((x) => !configured.has(`${x.provider}/${x.id}`)).map((x) => x.name), ["Qwen3 Coder"], "未配置 = 不在 available 里")
  // G12：费用说明由 cost.tiers 推出，只有 Gemini 有分档
  assert.deepEqual(
    models.models.map((x) => costNoteOf(x.cost)),
    [null, null, null, "输入超过 200k 时单价翻倍", null, null],
  )
})

test("c/queue-panel：两段（网页发的 q1、终端里排的 1 条），已插入的 q2 不出；tray「排队 2」", async () => {
  const { relay, fx } = await load("queue-panel")
  const sections = queueSectionsOf(relay.remoteQueue.items, relay.queue, fx.outbox, true, true)
  assert.deepEqual(sections.map((x) => x.title), ["网页发的", "终端里排的 · 只读"])
  assert.deepEqual(sections[0].items.map((x) => x.id), ["q1"])
  assert.deepEqual(sections[1].items, [{ segment: "follow_up", text: "跑一下 lint" }])
  assert.equal(canMutateRemoteQueueItem(sections[0].items[0]), true)
  assert.equal(remoteQueueSourceLabel("web"), "网页")
  const tray = trayOf(relay, fx)
  assert.deepEqual(tray.map((x) => x.label).slice(0, 2), ["任务 2/4", "排队 2"])
})

test("c/queue-panel states：离线 outbox → 三段「本页待发 · 等重连 / 网页发的 / 终端里排的 · 只读」、pill 计数含 outbox", async () => {
  const { relay, fx } = await load("queue-panel")
  const outbox = (await load("reconnecting")).fx.outbox
  const sections = queueSectionsOf(relay.remoteQueue.items, relay.queue, outbox, false, true)
  assert.deepEqual(sections.map((x) => x.title), ["本页待发 · 等重连", "网页发的", "终端里排的 · 只读"])
  const tray = trayItemsOf({ remoteQueue: relay.remoteQueue.items, localQueue: relay.queue, outbox, linkOk: false, deviceOnline: true })
  assert.equal(tray[0].label, "排队 3 · 等重连")
  assert.equal(queueSectionsOf(relay.remoteQueue.items, relay.queue, outbox, true, true)[0].title, "本页待发", "连着时不写「等重连」")
  assert.equal(fx.outbox, undefined, "主图没有 outbox")
})

test("c/command-palette：最近 4 个会话的行首标记；在线时命令可用", async () => {
  const { relay } = await load("command-palette")
  const attention = attentionOf(relay)
  const forRoom = (id) => attention.find((x) => x.roomId === id && x.kind !== "device-offline") ?? null
  const rows = ["r-s1", "r-s2", "r-s3", "r-s4"].map((id) => {
    const s = relay.listedSessions.find((x) => x.id === id)
    return rowMarkerOf(forRoom(id), s.busy, s.online, s.openable)
  })
  // replica：idle / running / waiting / unread；r-s3 的 waiting 拿不到（G1）
  assert.deepEqual(rows, ["idle", "running", "idle", "unread"])
  assert.equal(relay.authed && relay.online, true, "命令项可用")
})

test("c/dialog-usage：48 条 = 你 8 + pi 20 + 工具结果 20，与清单 messageCount 对上；上下文 30.9%、缓存命中 87%", async () => {
  const { relay } = await load("dialog-usage")
  const stats = await relay.runCommand("get_session_stats")
  assert.equal(stats.userMessages + stats.assistantMessages + stats.toolResults, stats.totalMessages)
  assert.equal(stats.totalMessages, relay.sessionsByDevice["d-mbp"].find((x) => x.id === "r-s1").messageCount)
  assert.equal(contextReadout(stats.contextUsage).label, "上下文 30.9%")
  assert.equal(Math.round((stats.tokens.cacheRead / (stats.tokens.input + stats.tokens.cacheRead)) * 100), 87)
  assert.equal(Object.keys(stats.costByModel).length, 2, "按模型两行")
})

test("c/settings：空存储的偏好 = 默认（跟随系统 / 平衡 / 插入当前回合 / 提示音关）；设备行鉴权与窗口剩余", async () => {
  const { relay, fx } = await load("settings")
  const prefs = migratePiPrefs(null, null)
  assert.deepEqual(prefs, DEFAULT_PI_PREFS)
  assert.equal(prefs.delivery, "steer")
  assert.equal(prefs.completionSound, false)
  assert.equal(deviceAuthState(THINKPAD).text, "已配对")
  assert.equal(windowRemainText(MBP.windowExpiresAt - fx.now), "5:12")
  assert.ok(relay.serverCaps.includes("device.token"))
})

test("c/quick-settings：每台设备的会话数、筛选 MacBook Pro 后组头只写目录名、切分组清掉展开", async () => {
  const { relay } = await load("quick-settings")
  const counts = Object.fromEntries(relay.devices.map((d) => [d.name, relay.sessionsByDevice[d.id].length]))
  assert.deepEqual(counts, { "MacBook Pro": 13, "Mac Studio": 3, ThinkPad: 1 })
  const filtered = sidebarGroups(sidebarSessionsOf(relay), relay.devices, attentionOf(relay), { filter: "d-mbp" })
  assert.deepEqual(filtered.groups.map((g) => g.label), ["pi-remote", "notes-app", "dotfiles"])
  assert.equal(setPiPref(DEFAULT_PI_PREFS, "grouping", "flat").clearExpanded, true)
  const byDevice = attentionCountByDevice(attentionOf(relay))
  assert.deepEqual([byDevice.get("d-mbp"), byDevice.get("d-studio"), byDevice.get("d-win")], [1, 1, undefined])
})

/* ---------------- P5 c 线：未载入会话、设备在线时按在线算（composerFactsOf，brief 16:45）：写了草稿是 S1，发第一条走 lazySend，不进 outbox ---------------- */

test("未载入会话：session-archived 上写草稿 → composerFactsOf 按在线算，S1 / sendKind send（不是 S5 outbox）；设备离线时仍是 S5", async () => {
  const { fx } = await load("session-archived")
  assert.equal(liveRelayOf(fx).composer.state, "S0", "空草稿")
  const drafted = liveRelayOf({ ...fx, relay: { ...fx.relay, draft: "先灰度一台" } })
  assert.equal(drafted.composer.state, "S1")
  assert.equal(drafted.composer.sendKind, "send")
  // 设备离线：deviceOnline=false 照旧给 S5（发送进 outbox 的口径不变）
  const offline = liveRelayOf({
    ...fx,
    relay: { ...fx.relay, draft: "先灰度一台", devices: fx.relay.devices.map((d) => (d.id === "d-studio" ? { ...d, online: false } : d)) },
  })
  assert.equal(offline.composer.state, "S5")
  // 已载入、房间不在线（不是 lazySession）：照旧 S5
  const notLazy = liveRelayOf({ ...fx, relay: { ...fx.relay, draft: "x", lazySession: null } })
  assert.equal(notLazy.composer.state, "S5")
  assert.equal(deriveComposer({ draft: "x", online: true }).state, "S1")
})

