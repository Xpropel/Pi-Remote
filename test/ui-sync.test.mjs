// 前端纯逻辑模块（不依赖 React）：transcript 归约、{rev, seq} 同步状态机、命令通道。
// P7 B2g（决定 17）：读旧界面 .tsx / .css（chat/parts、ui、dialogs、composer、capsules、shell、settings、FileViewer、index.css 等）的断言删掉，
// 只剩旧文件断言的 15 个用例整条删，19 个混合用例保留 useRelay / 保留模型的断言；任务清单、弹窗等待的纯函数改从 chat/composer/taskList.ts、promptModel.ts 引。逐条见 R2/test-rewrite.md。
// P7-R1-1：「第 5 章接线」里读 useRelay 的 3 条拆成独立用例保留，「完成信号接线」的 app-favicon 两条加回。
// Node ≥ 22.18 原生剥离 TS 类型，直接 import .ts 源文件。
import test from "node:test"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import assert from "node:assert/strict"
import { createJiti } from "jiti"
import { emptyTranscript, imageAddressOf, imagesOf, reduceTranscript } from "../ui/src/relay/transcript.ts"
import { emptySync, eventStep, snapshotStep } from "../ui/src/relay/sync.ts"
import { CommandChannel } from "../ui/src/relay/commands.ts"
import { PROTO, V3_SERVER, VIEWER_CAPS, authFrame, deviceRevokeFrame, hasCap, isCid, newCid, pairCreateFrame, serverInfo } from "../ui/src/relay/protocol.ts"
import {
  lazyRoomFromRow,
  lazySendPhaseText,
  lazySendTargets,
  stepLazySend,
  withLazyRoom,
} from "../ui/src/relay/lazySession.ts"
import { OFFLINE_SEND_COPY } from "../ui/src/chat/composer/composerPlan.ts"
import { decideEnter, deriveComposer } from "../ui/src/chat/composerMachine.ts"
import { PROGRESS_NOTICE_CODES, noticeChannel, noticeLevelForTone } from "../ui/src/chat/composer/noticeBridge.ts"
import { getNoticeSnapshot, noticeStore, resetNoticeStoreForTest } from "../ui/src/chat/composer/noticeStore.ts"
import { NOTICE_MAX_VISIBLE, NOTICE_QUEUE_LIMIT } from "../ui/src/chat/noticeCore.ts"
import {
  FORK_APPEND_HINT,
  FORK_BACKFILL_COPY,
  matchResourceCommand,
  mergeForkDraft,
  parseResourceCommands,
  parseSlash,
  parseSlashDetailed,
  resourceCommandText,
  resourceExecArgs,
  withoutSlash,
} from "../ui/src/chat/slashParse.ts"
import { DEFAULT_TREE_JUMP_MODE, TREE_JUMP_MODES, flattenTree, treeJumpArgs } from "../ui/src/chat/treeFlatten.ts"
import { optionsKey } from "../ui/src/chat/optionsKey.ts"
import { shouldShowUsage } from "../ui/src/chat/usageLine.ts"
import { currentThinkingLevel, parseThinkingLevels, thinkingLevelLabel } from "../ui/src/chat/thinkingLevels.ts"
import {
  COMPOSER_MAX_CHARS,
  MAX_PENDING_IMAGES,
  MIN_IMAGE_BUDGET_CHARS,
  SEND_IMAGE_MAX_CHARS,
  SEND_IMAGE_TOTAL_MAX_CHARS,
  decodeTextFile,
  deliveryPlan,
  imageBudgetFor,
  imageCharsTotal,
  insertFileBlock,
  mergeModelMeta,
  modelLabel,
  modelMetaFrom,
  modelTitle,
  parseSendMode,
  planSendImages,
  remainingImageSlots,
  sendModeLabel,
} from "../ui/src/chat/composerTools.ts"
import {
  ADMIN_TOKEN_COPY,
  ADMIN_TOKEN_STORAGE_KEY,
  DEVICE_COMMAND_TIMEOUT_MS,
  HARNESS_START_TIMEOUT_MS,
  RelayError,
  adminTokenErrorText,
  adminTokenReady,
  attachCommand,
  canRevoke,
  composerGate,
  cwdInProjects,
  deviceAuthState,
  deviceErrorText,
  devicesFromRoomList,
  findStartedRoom,
  formatPairCode,
  mergeDeviceSessions,
  newlyPaired,
  pairBaseline,
  pairCommands,
  idleDeviceHint,
  pairRemainText,
  parseRooms,
  parseSessionList,
  pickDefaultDevice,
  pickLoginRoom,
  platformLabel,
  preferredDeviceId,
  relativeTime,
  rosterActive,
  sessionEmptyHint,
  windowRemainText,
} from "../ui/src/relay/devices.ts"
import { contextReadout } from "../ui/src/relay/contextUsage.ts"
import {
  DEVICE_STRIP_LIMIT,
  deviceActivityAt,
  deviceGlyph,
  deviceTooltipData,
  sessionShowsSpinner,
  stripDeviceSelection,
} from "../ui/src/chat/deviceStripModel.ts"
import { firstConnecting, headerMeta, linkBannerText, linkView, nextUnseen, pageTitle, roomStatusText } from "../ui/src/relay/presence.ts"
import {
  canMutateRemoteQueueItem,
  parseRemoteQueueItem,
  parseRemoteQueueState,
  queueFullTextCacheStale,
  remoteQueueImagesLabel,
  remoteQueuePendingCount,
  remoteQueueSegmentLabel,
  remoteQueueStatusLabel,
  remoteQueueTextSummary,
} from "../ui/src/relay/remoteQueue.ts"
import { compactionNumbersOf, compactionResultText, formatTokenCount } from "../ui/src/relay/compactionResult.ts"

const require = createRequire(import.meta.url)
const user = (text) => ({ role: "user", content: [{ type: "text", text }] })
const asst = (text, extra = {}) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra })
const reduce = (state, ...actions) => actions.reduce(reduceTranscript, state)
const kinds = (s) => s.items.map((i) => `${i.kind}:${i.kind === "assistant" ? i.blocks.map((b) => b.text ?? b.name).join("|") : i.text ?? i.command}`)

test("transcript：快照重建线性，1 万条消息不卡", () => {
  const messages = []
  for (let k = 0; k < 5000; k += 1) messages.push(user(`q${k}`), asst(`a${k}`))
  const t0 = performance.now()
  const s = reduceTranscript(emptyTranscript(), { type: "snapshot", messages })
  const ms = performance.now() - t0
  assert.equal(s.items.length, 10000)
  assert.ok(ms < 500, `快照重建 ${ms.toFixed(0)}ms`)
  assert.equal(new Set(s.items.map((i) => i.key)).size, 10000, "key 唯一")
})

test("transcript：快照尾部 pending 助手消息成为 live，后续流式继续写进它", () => {
  let s = reduceTranscript(emptyTranscript(), { type: "snapshot", messages: [user("hi"), asst("par", { stopReason: "pending" })] })
  assert.ok(s.liveKey)
  s = reduce(s, { type: "message-update", event: { type: "text_delta", contentIndex: 0, delta: "tial" } })
  s = reduce(s, { type: "message-end", message: asst("partial done") })
  assert.deepEqual(kinds(s), ["user:hi", "assistant:partial done"])
  assert.equal(s.liveKey, null)
})

test("transcript：append 增量里的助手消息取代断线前的 live 气泡，其余按序追加", () => {
  let s = reduceTranscript(emptyTranscript(), { type: "snapshot", messages: [user("q1")] })
  s = reduce(s, { type: "message-start", message: { role: "assistant", content: [] } })
  s = reduce(s, { type: "message-update", event: { type: "text_delta", contentIndex: 0, delta: "半截" } })
  s = reduce(s, { type: "append", messages: [asst("完整回答"), user("q2"), asst("a2")] })
  assert.deepEqual(kinds(s), ["user:q1", "assistant:完整回答", "user:q2", "assistant:a2"])
  assert.equal(s.liveKey, null)
})

test("transcript：echo 乐观气泡被真实 user 消息取代；remote 回显不重复", () => {
  let s = reduce(emptyTranscript(), { type: "echo", text: "hello" }, { type: "echo", text: "hello" })
  assert.equal(s.items.length, 1)
  s = reduce(s, { type: "message-end", message: user("hello") })
  assert.deepEqual(kinds(s), ["user:hello"])
  assert.equal(s.items[0].echo, undefined)

  let r = reduce(emptyTranscript(), { type: "remote", text: "yo" }, { type: "echo", text: "yo" })
  assert.equal(r.items.length, 1, "先到的 remote 回显挡住发送方自己的 echo")
  r = reduce(r, { type: "message-end", message: user("yo") })
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].remote, true)
})

test("transcript：工具事件补到对应卡片；结果图片的结构化占位保留体积", () => {
  let s = reduce(emptyTranscript(), {
    type: "message-end",
    message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.png" } }] },
  })
  s = reduce(s, { type: "tool", id: "t1", patch: { outputText: "部分", state: "input-available" } })
  s = reduce(s, {
    type: "message-end",
    message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "image", mimeType: "image/png", data: "", omitted: true, omittedBytes: 307680 }] },
  })
  assert.equal(s.items.length, 1)
  const block = s.items[0].blocks[0]
  assert.equal(block.state, "output-available")
  assert.deepEqual(block.images, [{ data: "", mimeType: "image/png", omitted: true, bytes: 307680 }])
})

test("transcript 图片投影：entryId+blockIndex 只在完整时保留，omitted 也带 mime/bytes", () => {
  assert.deepEqual(imageAddressOf({ entryId: "e1", blockIndex: 2 }), { entryId: "e1", blockIndex: 2 })
  assert.deepEqual(imageAddressOf({ entryId: " e1 ", blockIndex: "2" }), { entryId: "e1", blockIndex: 2 }, "数字字符串归一")
  for (const bad of [
    {},
    { entryId: "", blockIndex: 0 },
    { entryId: "e1" },
    { blockIndex: 0 },
    { entryId: "e1", blockIndex: -1 },
    { entryId: "e1", blockIndex: 1.5 },
    { entryId: "e1", blockIndex: "x" },
    { entryId: "e1", blockIndex: "" },
  ]) {
    assert.equal(imageAddressOf(bad), null, JSON.stringify(bad))
  }

  const parts = imagesOf([
    { type: "image", mimeType: "image/png", data: "", omitted: true, omittedBytes: 2048, entryId: "e1", blockIndex: 2 },
    { type: "image", mimeType: "image/jpeg", data: "QUJD", entryId: "e2", blockIndex: 0 },
    { type: "image", mimeType: "image/webp", data: "", omitted: true, omittedBytes: 99, entryId: "e3" },
    { type: "image", mimeType: "image/gif", data: "", omitted: true, omittedBytes: 77, blockIndex: 1 },
    { type: "image", mimeType: "image/png", data: "QUJD", entryId: "e4", blockIndex: -1 },
    { type: "text", text: "noise" },
  ])
  assert.deepEqual(parts[0], {
    data: "",
    mimeType: "image/png",
    omitted: true,
    bytes: 2048,
    entryId: "e1",
    blockIndex: 2,
  }, "omitted 块保留定位与原始 mime/字节数")
  assert.deepEqual(parts[1], { data: "QUJD", mimeType: "image/jpeg", entryId: "e2", blockIndex: 0 })
  assert.deepEqual(parts[2], { data: "", mimeType: "image/webp", omitted: true, bytes: 99 }, "缺 blockIndex 就不带定位")
  assert.deepEqual(parts[3], { data: "", mimeType: "image/gif", omitted: true, bytes: 77 }, "缺 entryId 就不带定位")
  assert.deepEqual(parts[4], { data: "QUJD", mimeType: "image/png" }, "坏 blockIndex 不猜位置")

  // 工具结果消息进入 transcript 后，图片块上的定位字段原样保留。
  const state = reduceTranscript(emptyTranscript(), {
    type: "message-end",
    message: {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read",
      content: [
        { type: "image", mimeType: "image/png", data: "", omitted: true, omittedBytes: 4096, entryId: "e9", blockIndex: 3 },
      ],
    },
  })
  assert.deepEqual(state.items[0].blocks[0].images, [
    { data: "", mimeType: "image/png", omitted: true, bytes: 4096, entryId: "e9", blockIndex: 3 },
  ])
})

test("扩展投影/历史：图片块带 entryId+blockIndex；omitted 保留 mime/bytes；context_edit 不猜", async () => {
  process.env.PI_REMOTE_LOG = path.join(os.tmpdir(), `pi-remote-ui-sync-${process.pid}.log`)
  process.env.PI_REMOTE_ATTACH_FILE = path.join(os.tmpdir(), `pi-remote-ui-sync-attach-${process.pid}-missing.json`)
  const jiti = createJiti(import.meta.url, { interopDefault: false })
  const ext = await jiti.import(new URL("../extension/pi-remote-sync.ts", import.meta.url).pathname)

  const big = "A".repeat(300 * 1024)
  const userEntry = {
    id: "e1",
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "看图" }, { type: "image", mimeType: "image/png", data: big }] },
  }
  const toolEntry = {
    id: "e2",
    type: "message",
    message: { role: "toolResult", toolCallId: "t1", content: [{ type: "image", mimeType: "image/jpeg", data: big }] },
  }

  // 快照/get_messages 走 mirrorMessages：图片块带地址，shrink 后字段与 mime/bytes 都还在。
  const mirrored = ext.mirrorMessages([userEntry, toolEntry])
  assert.equal(mirrored[0].content[1].entryId, "e1")
  assert.equal(mirrored[0].content[1].blockIndex, 1)
  assert.equal(mirrored[1].content[0].entryId, "e2")
  assert.equal(mirrored[1].content[0].blockIndex, 0)
  const shrunk = ext.shrinkDeep(mirrored[1])
  assert.equal(shrunk.content[0].omitted, true)
  assert.equal(shrunk.content[0].data, "")
  assert.equal(shrunk.content[0].mimeType, "image/jpeg")
  assert.equal(shrunk.content[0].omittedBytes, Math.floor((big.length * 3) / 4))
  assert.equal(shrunk.content[0].entryId, "e2")
  assert.equal(shrunk.content[0].blockIndex, 0)

  const editedMessage = { role: "user", content: [{ type: "text", text: "edited" }] }
  const editedEntry = { id: "e3", type: "message", message: { role: "user", content: [{ type: "image", mimeType: "image/webp", data: big }] } }
  const projection = {
    entries: [
      { sourceEntry: userEntry, messages: [userEntry.message] },
      // context_edit：投影消息是新的 content，blockIndex 与原始条目对不上，不能写地址。
      { sourceEntry: editedEntry, messages: [editedMessage] },
    ],
    messages: [userEntry.message, editedMessage],
  }
  const b = new ext.Bridge()
  b.ctx = {
    sessionManager: {
      getEntries: () => [userEntry, toolEntry, editedEntry],
      getEntry: (id) => [userEntry, toolEntry, editedEntry].find((entry) => entry.id === id) || null,
      buildSessionProjection: () => projection,
    },
  }

  const history = await b.executeCommand("get_entries", {})
  assert.equal(history.entries[0].message.content[1].entryId, "e1")
  assert.equal(history.entries[0].message.content[1].blockIndex, 1)
  assert.equal(history.entries[0].message.content[1].omitted, true)
  assert.equal(history.entries[1].message.content[0].entryId, "e2")
  assert.equal(history.entries[1].message.content[0].blockIndex, 0)
  assert.equal(userEntry.message.content[1].entryId, undefined, "原条目不能被写脏（pi 活引用）")
  assert.equal(userEntry.message.content[1].blockIndex, undefined)

  const one = await b.executeCommand("get_entry", { entryId: "e1" })
  assert.equal(one.entry.message.content[1].entryId, "e1")
  assert.equal(one.entry.message.content[1].blockIndex, 1)

  const projected = await b.executeCommand("get_projection", {})
  assert.equal(projected.entries[0].messages[0].content[1].entryId, "e1")
  assert.equal(projected.entries[0].messages[0].content[1].blockIndex, 1)
  assert.equal(projected.messages[0].content[1].entryId, "e1", "扁平 messages 同样带地址")
  assert.equal(projected.messages[0].content[1].blockIndex, 1)
  assert.equal(projected.entries[1].messages[0].content[0].type, "text")
  assert.equal(projected.entries[1].messages[0].content[0].entryId, undefined, "context_edit 改写后的投影消息不写原图地址")
  assert.equal(projected.entries[1].sourceEntry.message.content[0].entryId, "e3", "sourceEntry 仍可精确定位")
  assert.equal(projected.entries[1].sourceEntry.message.content[0].blockIndex, 0)

  // 没有 id / content 不是数组时不带地址（不猜位置）。
  const anonymous = { type: "message", message: { role: "user", content: [{ type: "image", mimeType: "image/png", data: "QUJD" }] } }
  const anonymousMirror = ext.mirrorMessages([anonymous])[0]
  assert.equal(anonymousMirror.content[0].entryId, undefined)
  assert.equal(anonymousMirror.content[0].blockIndex, undefined)
})

test("sync：全量设基线；增量 baseSeq 对上才追加；对不上或 rev 变了要重订阅", () => {
  let sync = emptySync("r")
  let step = snapshotStep(sync, { rev: "A", seq: 10 })
  assert.equal(step.action, "full")
  sync = step.next
  assert.deepEqual(sync, { room: "r", rev: "A", seq: 10 })

  assert.equal(snapshotStep(sync, { delta: true, rev: "A", baseSeq: 10, seq: 12 }).action, "append")
  assert.equal(snapshotStep(sync, { delta: true, rev: "A", baseSeq: 10, seq: 12 }).next.seq, 12)
  assert.equal(snapshotStep(sync, { delta: true, rev: "A", baseSeq: 5, seq: 9 }).action, "ignore", "已经有了")
  assert.equal(snapshotStep(sync, { delta: true, rev: "A", baseSeq: 11, seq: 13 }).action, "resync-since", "缺口")
  assert.equal(snapshotStep(sync, { delta: true, rev: "B", baseSeq: 10, seq: 12 }).action, "resync-full")
})

test("sync：room_event 按 seq 去重、发现缺口；rev 变了要全量；新建存储的第一条直接接上", () => {
  const sync = { room: "r", rev: "A", seq: 10 }
  assert.equal(eventStep(sync, undefined, undefined).action, "apply", "流式事件不带 seq")
  assert.equal(eventStep(sync, 10, "A").action, "ignore")
  assert.equal(eventStep(sync, 11, "A").action, "apply")
  assert.equal(eventStep(sync, 11, "A").next.seq, 11)
  assert.equal(eventStep(sync, 13, "A").action, "resync-since")
  assert.equal(eventStep(sync, 1, "B").action, "resync-full")
  const fresh = eventStep({ room: "r", rev: null, seq: 0 }, 1, "C")
  assert.equal(fresh.action, "apply")
  assert.equal(fresh.next.rev, "C")
})

function fakeSocket() {
  return { readyState: 1, sent: [], send(data) { this.sent.push(JSON.parse(data)) } }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test("命令通道：受理后按 relay 给的 timeoutMs 计时，ack 结束", async () => {
  const ch = new CommandChannel({ acceptTimeoutMs: 30, slackMs: 10 })
  const ws = fakeSocket()
  ch.attach(ws)
  const p = ch.command("r", "compact", {})
  const frame = ws.sent[0]
  assert.equal(frame.type, "command")
  assert.equal(frame.dedupeKey, frame.id)
  ch.accepted(frame.id, 100)
  await sleep(60) // 超过受理超时，但已受理：不能判失败、不能重发
  assert.equal(ws.sent.length, 1)
  ch.ack({ id: frame.id, ok: true, data: { done: 1 } })
  assert.deepEqual(await p, { done: 1 })
  assert.equal(ch.size, 0)
})

test("命令通道：没等到受理回执，同一连接用同一 dedupeKey 重发一次，再没有就报丢失", async () => {
  const ch = new CommandChannel({ acceptTimeoutMs: 20 })
  const ws = fakeSocket()
  ch.attach(ws)
  const p = ch.command("r", "prompt", { message: "x" }, "LOST")
  await sleep(30)
  assert.equal(ws.sent.length, 2)
  assert.equal(ws.sent[1].id, ws.sent[0].id)
  assert.equal(ws.sent[1].dedupeKey, ws.sent[0].dedupeKey)
  await assert.rejects(p, /LOST/)
})

test("命令通道：断线挂起，重连到同一 relay（boot 相同）重发取回结果", async () => {
  const ch = new CommandChannel({ acceptTimeoutMs: 1000, graceMs: 500 })
  ch.connected("boot1")
  const a = fakeSocket()
  ch.attach(a)
  const p = ch.command("r", "steer", { message: "x" })
  ch.accepted(a.sent[0].id, 1000)
  ch.disconnected()
  const b = fakeSocket()
  ch.attach(b)
  ch.connected("boot1")
  assert.equal(b.sent.length, 1)
  assert.equal(b.sent[0].dedupeKey, a.sent[0].dedupeKey)
  ch.ack({ id: b.sent[0].id, ok: true, data: { disposition: "queued" }, dedup: true })
  assert.deepEqual(await p, { disposition: "queued" })
})

test("命令通道：relay 重启（boot 变了）只重发只读命令，有副作用的报结果未知", async () => {
  const ch = new CommandChannel({ acceptTimeoutMs: 1000, graceMs: 500 })
  ch.connected("boot1")
  const a = fakeSocket()
  ch.attach(a)
  const write = ch.command("r", "compact", {})
  const read = ch.command("r", "get_state", {})
  ch.disconnected()
  const b = fakeSocket()
  ch.attach(b)
  ch.connected("boot2")
  await assert.rejects(write, /relay 已重启/)
  assert.equal(b.sent.length, 1)
  assert.equal(b.sent[0].command, "get_state")
  ch.ack({ id: b.sent[0].id, ok: true, data: {} })
  await read
})

test("命令通道：raw 帧断线即失败、绝不重发；dispose 全部失败", async () => {
  const ch = new CommandChannel({ acceptTimeoutMs: 1000 })
  const ws = fakeSocket()
  ch.attach(ws)
  const raw = ch.raw({ type: "abort", room: "r" })
  const cmd = ch.command("r", "get_state", {})
  ch.disconnected()
  await assert.rejects(raw, /连接已断开/)
  ch.dispose("bye")
  await assert.rejects(cmd, /bye/)
  assert.equal(ws.sent.length, 2)
})

const dev = (online, projects = ["D:\\work"]) => ({
  id: "d1",
  accountId: "admin",
  name: "PC",
  platform: "windows",
  online,
  projects,
  lastAttachAt: 1,
})
const room = (extra = {}) => ({ id: "s1", label: "进行中", cwd: "D:\\work", online: true, busy: false, viewers: 1, deviceId: "d1", ...extra })
const sess = (extra = {}) => ({ id: "s1", name: "进行中", cwd: "D:\\work", messageCount: 4, sizeBytes: 10, updatedAt: 9, active: true, online: true, ...extra })

test("会话合并：活动房间和清单同 id 只保留活动项，未连接只读", () => {
  const online = mergeDeviceSessions(dev(true), [room()], [sess(), sess({ updatedAt: 1 })])
  assert.deepEqual(online.map((row) => row.id), ["s1"])
  assert.equal(online[0].openable, true)

  const idle = mergeDeviceSessions(dev(false), [room()], [sess(), { ...sess(), id: "s2", name: "旧的", online: false, active: false, updatedAt: 3 }])
  assert.deepEqual(idle.map((row) => `${row.id}:${row.openable}`), ["s1:false", "s2:false"])
})

test("会话标题：优先会话名，其次首条消息，不再用目录名", () => {
  const folderRoom = room({ label: "work" })
  const fromFirst = mergeDeviceSessions(dev(true), [folderRoom], [sess({ name: "", firstMessage: "帮我重构 relay 重连", path: "C:/sessions/a.jsonl" })])
  assert.equal(fromFirst[0].title, "帮我重构 relay 重连")
  assert.equal(fromFirst[0].path, "C:/sessions/a.jsonl")

  const fromName = mergeDeviceSessions(dev(true), [folderRoom], [sess({ name: "重连退避", firstMessage: "帮我重构 relay 重连" })])
  assert.equal(fromName[0].title, "重连退避")
})

test("fork 谱系（R3-3）：父在清单内标「源自 <父当前名>」；父删除后诚实态；非 fork 不占位", () => {
  const parent = sess({ id: "p1", name: "父会话", path: "C:/s/parent.jsonl", active: false, online: false, updatedAt: 5 })
  const child = sess({ id: "c1", name: "子会话", path: "C:/s/child.jsonl", active: false, online: false, updatedAt: 9, parentSession: "C:/s/parent.jsonl" })
  const rows = mergeDeviceSessions(dev(false), [], [child, parent])
  const childRow = rows.find((row) => row.id === "c1")
  assert.equal(childRow.parentLabel, "源自 父会话")
  assert.equal(rows.find((row) => row.id === "p1").parentLabel, undefined, "非 fork 会话不占位")
  // 父改名 → 呈现跟随当前名（呈现时解析，不是 fork 时写死的字符串）
  const renamed = mergeDeviceSessions(dev(false), [], [child, { ...parent, name: "父会话新名" }])
  assert.equal(renamed.find((row) => row.id === "c1").parentLabel, "源自 父会话新名")
  // 父不在清单 → 诚实态，不编造来源
  const orphaned = mergeDeviceSessions(dev(false), [], [child])
  assert.equal(orphaned.find((row) => row.id === "c1").parentLabel, "源会话已删除")
  // 父名为空时回退父的首条消息
  const fromFirst = mergeDeviceSessions(dev(false), [], [
    child,
    { ...parent, name: "", firstMessage: "父的首问" },
  ])
  assert.equal(fromFirst.find((row) => row.id === "c1").parentLabel, "源自 父的首问")
  // parseSessionList：清单帧 parentSession 透传，缺失为 null
  assert.equal(parseSessionList([{ id: "k", path: "C:/s/k.jsonl", parentSession: "C:/s/p.jsonl" }])[0].parentSession, "C:/s/p.jsonl")
  assert.equal(parseSessionList([{ id: "k", path: "C:/s/k.jsonl" }])[0].parentSession, null)
})

test("fork 谱系（C-3）：清单截断时父缺席只呈中性态，不假报已删除；父墓碑在清单内仍判已删除", () => {
  const parent = sess({ id: "p1", name: "父会话", path: "C:/s/parent.jsonl", active: false, online: false, updatedAt: 5 })
  const child = sess({ id: "c1", name: "子会话", path: "C:/s/child.jsonl", active: false, online: false, updatedAt: 9, parentSession: "C:/s/parent.jsonl" })
  // 清单不完整（truncated=true）+ 父不在清单 → 中性态：父可能只是被 200 上限截出
  const cut = mergeDeviceSessions(dev(false), [], [child], true)
  assert.equal(cut.find((row) => row.id === "c1").parentLabel, "源会话不在当前清单")
  // 清单完整 + 父不在 → 才许下"已删除"结论（与旧口径一致）
  const complete = mergeDeviceSessions(dev(false), [], [child], false)
  assert.equal(complete.find((row) => row.id === "c1").parentLabel, "源会话已删除")
  // 父行在清单内且带 deleted 墓碑 → 与截断无关，仍是已删除（结论有清单内证据）
  const tombstoned = mergeDeviceSessions(dev(false), [], [child, { ...parent, deleted: true }], true)
  assert.equal(tombstoned.find((row) => row.id === "c1").parentLabel, "源会话已删除")
  // 截断时父在清单内 → 正常呈谱系，不受中性态影响
  const found = mergeDeviceSessions(dev(false), [], [child, parent], true)
  assert.equal(found.find((row) => row.id === "c1").parentLabel, "源自 父会话")
})

test("未连接设备不能发消息；新建目录必须落在 projects 里", () => {
  const blocked = composerGate({ deviceMode: true, devices: [dev(false)], selectedDeviceId: "d1", online: true, roomId: "s1" })
  assert.equal(blocked.canSend, false)
  assert.match(blocked.placeholder, /deploy\\attach\.cmd/, "Windows 设备要提示能直接执行的 .cmd")

  const legacy = composerGate({ deviceMode: false, devices: [], rooms: [room()], online: true, roomId: "s1" })
  assert.equal(legacy.canSend, true)
  assert.equal(rosterActive({ deviceMode: true, devices: [], rooms: [room()] }), false)
  assert.equal(rosterActive({ deviceMode: true, devices: [dev(true)], rooms: [] }), true)

  assert.equal(cwdInProjects(["D:\\work"], "D:/work"), true)
  assert.equal(cwdInProjects(["D:\\work"], "C:\\temp"), false)
})

test("attach 命令按平台给：Mac/Linux 是 .sh，Windows 是 .cmd；窗口剩余和相对时间有人话", () => {
  assert.equal(attachCommand("macos"), "deploy/attach.sh")
  assert.equal(attachCommand("linux"), "deploy/attach.sh")
  assert.equal(attachCommand("windows"), "deploy\\attach.cmd")
  assert.equal(attachCommand(null), "deploy/attach.sh")
  const mac = { ...dev(false), platform: "macos" }
  const gate = composerGate({ deviceMode: true, devices: [mac], selectedDeviceId: "d1", online: true, roomId: "s1" })
  assert.match(gate.placeholder, /deploy\/attach\.sh/)
  assert.equal(windowRemainText(11 * 3600_000 + 32 * 60_000), "11:32")
  assert.equal(windowRemainText(65_000), "1:05")
  assert.equal(windowRemainText(-1), "已到期")
  const now = Date.parse("2026-10-21T12:00:00Z")
  assert.equal(relativeTime(now - 30_000, now), "刚刚")
  assert.equal(relativeTime(now - 5 * 60_000, now), "5 分钟前")
  assert.equal(relativeTime(now - 3 * 3600_000, now), "3 小时前")
  assert.equal(relativeTime(now - 2 * 86_400_000, now), "2 天前")
  assert.equal(relativeTime(0, now), "")
})

const stripDev = (id, options = {}) => ({
  id,
  accountId: "admin",
  name: id,
  platform: "windows",
  online: false,
  projects: [],
  lastAttachAt: null,
  windowExpiresAt: null,
  auth: "token",
  paired: true,
  ...options,
})

test("设备图标行：在线优先、组内首次连接从早到晚，最多 5 台且给出溢出数", () => {
  const devices = [
    // lastAttachAt 故意与 firstSeenAt 反向：排序不能再按最近活跃。
    stripDev("offline-new", { firstSeenAt: 900, lastAttachAt: 50 }),
    stripDev("online-old", { online: true, firstSeenAt: 100, lastAttachAt: 900 }),
    stripDev("offline-old", { firstSeenAt: 100, lastAttachAt: 900 }),
    stripDev("online-new", { online: true, firstSeenAt: 900, lastAttachAt: 100 }),
    stripDev("offline-mid", { firstSeenAt: 500, lastAttachAt: 500 }),
    stripDev("online-mid", { online: true, firstSeenAt: 500, lastAttachAt: 500 }),
    stripDev("offline-tail", { firstSeenAt: 50, lastAttachAt: 50 }),
  ]
  const { visible, overflow } = stripDeviceSelection(devices)
  assert.equal(DEVICE_STRIP_LIMIT, 5)
  assert.deepEqual(visible.map((device) => device.id), ["online-old", "online-mid", "online-new", "offline-tail", "offline-old"])
  assert.equal(overflow, 2)
  assert.deepEqual(stripDeviceSelection(devices.slice(0, 3)).overflow, 0)
  assert.equal(deviceActivityAt(stripDev("future-compatible", { lastAttachAt: 100, lastSeen: 700 })), 700, "兼容函数仍返回最近活跃，但排序不再使用")
  assert.equal(deviceActivityAt(stripDev("empty")), 0)
})

test("设备图标：macOS 笔记本、Windows 显示器、Linux 终端，未知平台回落显示器", () => {
  assert.equal(deviceGlyph("macos"), "laptop")
  assert.equal(deviceGlyph("darwin"), "laptop")
  assert.equal(deviceGlyph("win32"), "monitor")
  assert.equal(deviceGlyph("linux"), "terminal")
  assert.equal(deviceGlyph("freebsd"), "monitor")
})

test("设备 tooltip：只展示 relay 真实字段，不伪造 RTT / 速率", () => {
  const now = Date.parse("2026-10-21T12:00:00Z")
  const online = deviceTooltipData(
    stripDev("Studio Mac", {
      name: "Studio Mac",
      platform: "macos",
      online: true,
      lastAttachAt: now - 2 * 60_000,
      windowExpiresAt: now + 65_000,
    }),
    now,
  )
  assert.deepEqual(online, {
    name: "Studio Mac",
    platform: "macOS",
    online: true,
    status: "已连接",
    details: ["连接于 2 分钟前", "连接窗口剩余 1:05"],
  })
  const offline = deviceTooltipData(
    stripDev("Windows PC", {
      name: "Windows PC",
      platform: "windows",
      online: false,
      lastAttachAt: now - 3 * 3600_000,
    }),
    now,
  )
  assert.deepEqual(offline.details, ["上次上线 3 小时前"])
  assert.equal(offline.status, "未连接")
  assert.deepEqual(
    deviceTooltipData(stripDev("bare", { online: true, platform: "linux", lastAttachAt: null }), now).details,
    [],
    "没有连接时间/窗口就留空，不编造",
  )
  const expired = deviceTooltipData(stripDev("expired", { online: true, windowExpiresAt: now - 1 }), now)
  assert.deepEqual(expired.details, ["连接窗口已到期"])
  assert.doesNotMatch(JSON.stringify([online, offline, expired]), /RTT|速率|Mbps|KB\/s/i)
})

test("会话行 spinner：选中行听 relay.busy，其它行只有在线且 row.busy 才转", () => {
  const row = (extra = {}) => ({ id: "s1", openable: true, busy: true, ...extra })
  assert.equal(sessionShowsSpinner(row(), "s1", true), true, "当前选中且 relay.busy")
  assert.equal(sessionShowsSpinner(row(), "s1", false), false, "当前选中但空闲")
  assert.equal(sessionShowsSpinner(row(), "s2", false), true, "其它在线房间使用 row.busy")
  assert.equal(sessionShowsSpinner(row({ busy: false }), "s2", true), false, "其它空闲房间不显示")
  assert.equal(sessionShowsSpinner(row({ openable: false }), "s2", true), false, "离线房间即使 row.busy 也不显示")
})


test("断线重连期间发不出去但照样能打字；本来就不能发的，断线时也不能打字", () => {
  const linkDown = composerGate({ authed: false, deviceMode: false, devices: [], rooms: [room()], online: true, roomId: "s1" })
  assert.deepEqual([linkDown.canSend, linkDown.canType], [false, true])
  assert.match(linkDown.placeholder, /连上/)
  const idle = composerGate({ authed: false, deviceMode: false, devices: [], rooms: [room()], online: false, roomId: "s1" })
  assert.deepEqual([idle.canSend, idle.canType], [false, false])
  const up = composerGate({ authed: true, deviceMode: true, devices: [dev(true)], selectedDeviceId: "d1", online: true, roomId: "s1" })
  assert.deepEqual([up.canSend, up.canType], [true, true])
})

test("旧 relay 不带设备字段时不造空名册；房间里的未知设备不会把列表弄空", () => {
  const bare = [{ id: "r1", label: "旧会话", cwd: "D:/work", online: true }]
  assert.equal(rosterActive({ deviceMode: false, devices: devicesFromRoomList(undefined, bare), rooms: bare }), false)
  const filled = devicesFromRoomList([], bare)
  assert.equal(filled.some((item) => item.id === "未登记设备"), true)
  assert.equal(filled.length > 0, true)
})

test("findStartedRoom：session 形态只认 id 命中、在线、同设备的房间", () => {
  const seen = new Set()
  assert.equal(findStartedRoom({ kind: "session", key: "s1", seen }, "d1", [room()])?.id, "s1")
  assert.equal(findStartedRoom({ kind: "session", key: "s1", seen }, "d1", [room({ online: false })]), null)
  assert.equal(findStartedRoom({ kind: "session", key: "s1", seen }, "d2", [room()]), null)
  assert.equal(findStartedRoom({ kind: "session", key: "nope", seen }, "d1", [room()]), null)
})

test("findStartedRoom：cwd 形态跳过已见房间，多个同时在线时挑最近活动的", () => {
  const list = [
    room({ id: "old", lastActivity: 500 }),
    room({ id: "a", lastActivity: 100 }),
    room({ id: "b", lastActivity: 900 }),
  ]
  assert.equal(findStartedRoom({ kind: "cwd", key: "D:\\work", seen: new Set(["old"]) }, "d1", list)?.id, "b")
  assert.equal(findStartedRoom({ kind: "cwd", key: "D:\\work", seen: new Set(["a", "b", "old"]) }, "d1", list), null)
  assert.equal(findStartedRoom({ kind: "cwd", key: "D:\\other", seen: new Set() }, "d1", list), null)
  // 旧 relay 不下发 lastActivity（全 0）：退化成"列表最后一个"，与旧行为一致
  const legacy = [room({ id: "x" }), room({ id: "y" })]
  assert.equal(findStartedRoom({ kind: "cwd", key: "D:\\work", seen: new Set() }, "d1", legacy)?.id, "y")
})

test("惰性会话：合成房间只用于显示，同 id 的真实在线房间优先", () => {
  const row = {
    id: "s1",
    title: "旧会话",
    firstMessage: "第一条消息",
    cwd: "D:/work",
    online: false,
    busy: false,
    viewers: 0,
    messageCount: 4,
    updatedAt: 9,
    openable: false,
    deviceId: "d1",
  }
  const lazy = lazyRoomFromRow(row)
  assert.equal(lazy.id, "s1")
  assert.equal(lazy.online, true, "设备在线时合成房间可点选/可发送")
  assert.equal(lazy.deviceId, "d1")
  assert.equal(lazy.cwd, "D:/work")
  assert.deepEqual(withLazyRoom([], lazy), [lazy])

  // 真实离线房间被合成项替换，真实在线房间不重复、也不被合成项盖掉
  const offline = room({ id: "s1", online: false, cwd: "D:/work" })
  const replaced = withLazyRoom([offline], lazy)
  assert.equal(replaced.length, 1)
  assert.equal(replaced[0], lazy)
  const online = room({ id: "s1", online: true })
  assert.deepEqual(withLazyRoom([online], lazy), [online])
})

test("惰性发送状态机：点选不发送，房间上线只提交一次，切走/失败清队列", () => {
  const base = { token: 7, sessionId: "s1", deviceId: "d1", phase: "starting", text: "hi", image: null, cid: "c1" }
  assert.deepEqual(stepLazySend(null, { type: "harness-accepted" }), { send: null, action: "none" })
  assert.equal(lazySendTargets(base, "s1", "d1"), true)
  assert.equal(lazySendTargets(base, "s2", "d1"), false)

  const accepted = stepLazySend(base, { type: "harness-accepted" })
  assert.equal(accepted.send?.phase, "waiting")
  assert.equal(accepted.action, "none")

  // 别的房间/别的设备上线都不算目标就绪
  const wrongRoom = stepLazySend(accepted.send, { type: "room-ready", roomId: "s2", deviceId: "d1" })
  assert.equal(wrongRoom.action, "none")
  const wrongDevice = stepLazySend(accepted.send, { type: "room-ready", roomId: "s1", deviceId: "d2" })
  assert.equal(wrongDevice.action, "none")

  const ready = stepLazySend(accepted.send, { type: "room-ready", roomId: "s1", deviceId: "d1" })
  assert.equal(ready.action, "submit")
  assert.equal(ready.send?.phase, "sending")
  // subscribed / snapshot / room_list 会重复通知：第二次绝不能再 submit
  assert.equal(stepLazySend(ready.send, { type: "room-ready", roomId: "s1", deviceId: "d1" }).action, "none")
  assert.equal(lazySendTargets(ready.send, "s1", "d1"), true)

  assert.deepEqual(stepLazySend(ready.send, { type: "submitted" }), { send: null, action: "none" })
  assert.deepEqual(stepLazySend(accepted.send, { type: "cancelled" }), { send: null, action: "cancel" })
  assert.deepEqual(stepLazySend(accepted.send, { type: "failed" }), { send: null, action: "fail" })
  assert.match(lazySendPhaseText("starting"), /启动/)
  assert.match(lazySendPhaseText("waiting"), /载入/)
  assert.equal(lazySendPhaseText("sending"), "正在发送…")
})

test("惰性发送失败：产品接线不再把正文/图回写输入框，失败只留气泡", () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
  const relay = source("../ui/src/relay/useRelay.ts")
  assert.equal(relay.includes("restoreLazyDraft"), false, "不再导入 lazy 草稿回写")
  assert.equal(relay.includes("restoreLazyImage"), false, "不再导入 lazy 图片回写")
  assert.equal(relay.includes("restoreLazyComposer"), false, "不再有 restoreLazyComposer 辅助")
  assert.match(relay, /send-failed[^\n]*drop: false/, "lazy 发送失败也要把失败留在气泡里")
  assert.match(relay, /queueLazySend[\s\S]{0,1400}type: "echo"/, "排队时就出乐观气泡，启动失败才有气泡可标")
})

test("parseRooms：lastActivity 缺省 0，离线房间也带得动", () => {
  const rooms = parseRooms([
    { id: "s1", online: true },
    { id: "s2", online: false, lastActivity: 5 },
  ])
  assert.deepEqual(
    rooms.map((r) => [r.id, r.online, r.lastActivity]),
    [["s1", true, 0], ["s2", false, 5]],
  )
})

test("deviceErrorText：六个码有统一文案，spawn_failed 带原因，manifest_stale 透传", () => {
  for (const [code, text] of [
    ["no_device", "这台设备从未连接过"],
    ["device_offline", "设备未连接：先在电脑上打开 attach 窗口"],
    ["device_no_active_session", "这台设备没有在跑的会话：在左侧点选一个会话，发送第一条消息时载入；或新建会话"],
    ["cwd_not_allowed", "该目录不在这台设备的允许列表里"],
    ["session_not_found", "这台设备上没有这个会话（可能已删除）"],
    ["timeout", "本机没有回应，请重试"],
  ]) {
    assert.equal(deviceErrorText(new RelayError(code, "raw")), text)
  }
  assert.equal(deviceErrorText(new RelayError("spawn_failed", "端口占用")), "本机启动失败：端口占用")
  assert.equal(deviceErrorText(new RelayError("manifest_stale", "清单过期")), "清单过期")
  assert.equal(deviceErrorText(new Error("原文")), "原文")
  // 页面已没有“启用”按钮：空闲相关文案不能再让用户去找它
  assert.doesNotMatch(deviceErrorText(new RelayError("device_no_active_session", "raw")), /启用/)
})

test("deviceCommand：没受理按前端截止失败；受理后改按 relay 的 timeoutMs + 余量计时（relay 是唯一口径），绝不自动重发", async () => {
  const ch = new CommandChannel({ acceptTimeoutMs: 50, slackMs: 40 })
  const ws = fakeSocket()
  ch.attach(ws)
  // 1) 一直没有受理回执：到前端截止就失败
  const lost = ch.deviceCommand("d1", "switch_session", { sessionPath: "x" }, 60, "LOST")
  assert.equal(ws.sent[0].deviceId, "d1")
  await assert.rejects(lost, /LOST/)
  assert.equal(ws.sent.length, 1, "设备级命令超时不重发")

  // 2) relay 受理并说要等 120ms（比前端截止 60ms 长）：前端必须等 relay 的口径 + 余量，不能先判超时
  const p = ch.deviceCommand("d1", "harness_start", { cwd: "D:\\w" }, 60, "LOST2")
  const frame = ws.sent[1]
  ch.accepted(frame.id, 120)
  let settled = false
  p.then(() => (settled = true), () => (settled = true))
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(settled, false, "受理后不能按受理前的截止判失败")
  ch.ack({ id: frame.id, ok: true, data: { status: "started" } })
  assert.deepEqual(await p, { status: "started" })

  // 3) 受理后 relay 口径 + 余量也过了：失败
  const q = ch.deviceCommand("d1", "harness_start", {}, 60, "LOST3")
  ch.accepted(ws.sent[2].id, 20)
  await assert.rejects(q, /LOST3/)
  assert.equal(ws.sent.length, 3, "设备级命令绝不自动重发")
  assert.equal(ch.size, 0)
})

test("harness_start / 设备命令的截止常量比 relay 的口径多留余量", () => {
  const { DEFAULT_CONFIG, commandTimeoutMs } = require("../relay/server.js")
  const relayHarness = commandTimeoutMs("harness_start", {}, DEFAULT_CONFIG.harnessStartTimeoutMs)
  assert.equal(relayHarness, DEFAULT_CONFIG.harnessStartTimeoutMs, "relay 侧只有 cfg 一个口径")
  assert.ok(HARNESS_START_TIMEOUT_MS > relayHarness, `前端受理前上限 ${HARNESS_START_TIMEOUT_MS} 必须大于 relay 的 ${relayHarness}，否则两边同一刻各判一次超时`)
  const relaySession = commandTimeoutMs("switch_session", {}, DEFAULT_CONFIG.harnessStartTimeoutMs)
  assert.ok(DEVICE_COMMAND_TIMEOUT_MS > relaySession, `设备级截止 ${DEVICE_COMMAND_TIMEOUT_MS} 必须大于 relay 的 ${relaySession} 会话操作档`)
})

test("命令通道：relay 回带 id 的 error 帧（rate_limited）时对应命令立刻失败并带上 code", async () => {
  const ch = new CommandChannel({ acceptTimeoutMs: 5000 })
  const ws = fakeSocket()
  ch.attach(ws)
  const p = ch.command("r1", "get_state")
  const id = ws.sent[0].id
  assert.equal(ch.error({ id: "别人的", code: "rate_limited", message: "操作太频繁" }), false, "不属于本通道的 id 不处理")
  assert.equal(ch.error({ id, code: "rate_limited", message: "操作太频繁" }), true)
  await assert.rejects(p, (e) => e.code === "rate_limited" && /操作太频繁/.test(e.message))
  assert.equal(ch.size, 0)
})

test("斜杠命令只认整段输入开头：多行消息最后一行以 / 开头不算命令", () => {
  assert.deepEqual(parseSlash("/model"), { name: "model", arg: null })
  assert.deepEqual(parseSlash("/name 新名字"), { name: "name", arg: "新名字" })
  assert.equal(parseSlash("请看下面\n/compact"), null, "前面有正文时不能当命令执行（会吞掉正文）")
  assert.equal(parseSlash("说明 /tools 的作用"), null)
  assert.equal(withoutSlash("/model gpt"), "")
  assert.equal(withoutSlash("正文\n/model"), "正文\n/model", "不是命令就不改动草稿")
  // 资源命令名不是只有字母/连字符：skill:name、数字、下划线、点都要能整段认出；
  // raw 保留大小写（pi 按原始命令名派发），name 仍给内置命令做不区分大小写匹配。
  assert.deepEqual(parseSlashDetailed("/skill:deploy $1 \"a b\""), { name: "skill:deploy", raw: "skill:deploy", arg: "$1 \"a b\"" })
  assert.deepEqual(parseSlash("/review_2026.v2 正文"), { name: "review_2026.v2", arg: "正文" })
})

test("Fork 回填：空草稿直接放原文；已有草稿不覆盖，换行追加并提示", () => {
  assert.equal(FORK_BACKFILL_COPY, "这条消息已回到输入框，修改后发送即从新分支继续")
  assert.equal(FORK_APPEND_HINT, "已有草稿，已换行追加到末尾")
  assert.deepEqual(mergeForkDraft("", "  被分叉的消息  "), { text: "被分叉的消息", appended: false })
  assert.deepEqual(mergeForkDraft("   \n ", "被分叉的消息"), { text: "被分叉的消息", appended: false }, "空白草稿算空")
  assert.deepEqual(mergeForkDraft("我写到一半的草稿", "被分叉的消息"), { text: "我写到一半的草稿\n被分叉的消息", appended: true })
  assert.deepEqual(mergeForkDraft("已经带换行\n", "被分叉的消息"), { text: "已经带换行\n被分叉的消息", appended: true }, "不重复加空行")
  assert.deepEqual(mergeForkDraft("保留草稿", "   "), { text: "保留草稿", appended: false }, "没有回包文本时不覆盖")

  const relay = readFileSync(new URL("../ui/src/relay/useRelay.ts", import.meta.url), "utf8")
  assert.match(relay, /pendingBackfillRef/)
  assert.match(relay, /if \(roomRef\.current !== originRoom\)/)
  assert.match(relay, /const backfill = pendingBackfillRef\.current/)
  // P3-3 口径更新：新房订阅不再无条件清草稿——先把旧房草稿落盘，再恢复新房落盘草稿；
  // fork 回填仍最高优先（backfill ? backfill.text : …）。旧断言的 "" 已被 readRoomDraft(id) 取代。
  assert.match(relay, /setDraft\(backfill \? backfill\.text : readRoomDraft\(id\)\)/, "新房订阅换草稿槽后补回填/落盘恢复")
  assert.match(relay, /setTimeout\(\(\) => setNotice\(\{ text: notice, tone: "warn" \}\), 0\)/, "切换提示之后再压一次 fork 文案")
})

test("资源命令：get_commands 只认扩展/模板/技能，内置、脏条目、未知命令都不误触", () => {
  const commands = parseResourceCommands({
    commands: [
      { name: "review", description: " 审查改动 ", source: "prompt" },
      { name: "/release", description: "发布", source: "extension" },
      { name: "skill:deploy", description: "部署", source: "skill" },
      { name: "builtin-x", source: "builtin" },
      { name: "kind-builtin", kind: "builtin", source: "prompt" },
      { name: "weird", source: "plugin" },
      { name: "REVIEW", source: "extension" },
      { name: "坏 名字", source: "prompt" },
      { name: 42, source: "prompt" },
      null,
    ],
  })
  assert.deepEqual(commands.map((c) => `${c.name}:${c.source}:${c.executable}`), [
    "review:prompt:true",
    "release:extension:true",
    "skill:deploy:skill:true",
    "weird:plugin:false",
  ])
  assert.equal(commands[0].description, "审查改动")
  assert.equal(matchResourceCommand(commands, "review").name, "review")
  assert.equal(matchResourceCommand(commands, "REVIEW").name, "review", "回退到不区分大小写时用清单里的规范名")
  assert.equal(matchResourceCommand(commands, "skill:deploy").source, "skill")
  assert.equal(matchResourceCommand(commands, "nope"), null)
  assert.equal(matchResourceCommand(commands, "builtin-x"), null, "内置不进清单")
  assert.equal(matchResourceCommand(commands, "weird").executable, false, "不可执行命令仍保留说明")
  assert.equal(matchResourceCommand(commands, ""), null)
  assert.equal(matchResourceCommand(commands, "review 额外参数"), null, "只认整名，不拿正文前缀误触")
})

test("资源命令执行：走 prompt 注入并打开模板展开，参数原样交给 pi（$1/$@/${1:-默认}/引号）", () => {
  const text = resourceCommandText("review", "$1 $@ ${1:-默认} \"a b\" 'c d'")
  assert.equal(text, "/review $1 $@ ${1:-默认} \"a b\" 'c d'", "网页侧不改写参数，展开由 pi 完成")
  assert.deepEqual(resourceExecArgs(text), { message: text, expandPromptTemplates: true })
  assert.deepEqual(resourceExecArgs(text, { busy: true, followUp: true }), { message: text, expandPromptTemplates: true, streamingBehavior: "followUp" })
  assert.deepEqual(resourceExecArgs(text, { busy: true }), { message: text, expandPromptTemplates: true, streamingBehavior: "steer" })
  assert.deepEqual(resourceExecArgs(text, { busy: false, followUp: true }), { message: text, expandPromptTemplates: true }, "空闲不排队")
  assert.equal(resourceCommandText("release", null), "/release")

})

test("会话合并：设备在线时，还没进索引的离线房间留在列表末尾可回看，不被丢掉", () => {
  const rows = mergeDeviceSessions(dev(true), [room(), room({ id: "gone", label: "刚关掉", online: false })], [sess()])
  assert.deepEqual(rows.map((row) => `${row.id}:${row.openable}`), ["s1:true", "gone:false"])
  // 已在索引里的离线房间按索引行显示，不重复
  const dup = mergeDeviceSessions(dev(true), [room({ id: "s2", online: false })], [sess({ id: "s2", online: false, active: false })])
  assert.deepEqual(dup.map((row) => row.id), ["s2"])
})

test("会话树：线性链不加缩进，只有分叉处才加一级；长链不爆栈", () => {
  const node = (id, children = []) => ({ entry: { id, type: "message" }, label: id, children })
  // a → b → c，c 下分叉 d / e，e → f
  const tree = [node("a", [node("b", [node("c", [node("d"), node("e", [node("f")])])])])]
  const flat = flattenTree(tree, "f")
  assert.deepEqual(flat.map((n) => `${n.id}:${n.depth}`), ["a:0", "b:0", "c:0", "d:1", "e:1", "f:1"])
  assert.equal(flat.find((n) => n.id === "f").current, true)
  let deep = node("n0")
  for (let k = 1; k < 20000; k += 1) deep = node("n" + k, [deep])
  const long = flattenTree([deep], "")
  assert.equal(long.length, 20000)
  assert.equal(Math.max(...long.map((n) => n.depth)), 0, "两万层线性链缩进始终为 0")
})

test("optionsKey：同一批选项（新数组）键相同，选项真变了键才变", () => {
  const a = [{ id: "m1" }, { id: "m2" }]
  const b = [{ id: "m1" }, { id: "m2" }]
  // 引用不同但内容相同：ChoiceMenu 的渲染期对齐必须认为"没变"，否则高亮每次重渲都被打回第一项
  assert.notEqual(a, b)
  assert.equal(optionsKey(a), optionsKey(b))
  // 真的换了选项：键必须变，否则 aria-activedescendant 会指向不存在的项
  assert.notEqual(optionsKey(a), optionsKey([{ id: "m1" }, { id: "m3" }]))
  assert.notEqual(optionsKey(a), optionsKey([{ id: "m1" }]))
  assert.notEqual(optionsKey(a), optionsKey([{ id: "m2" }, { id: "m1" }]), "顺序不同也是不同的选项集")
  assert.equal(optionsKey([]), "[]")
  // id 里带分隔符也不能撞键（join("|") 会把这两组算成同一个键）
  assert.notEqual(optionsKey([{ id: "a|b" }, { id: "c" }]), optionsKey([{ id: "a" }, { id: "b|c" }]))
})

test("platformLabel：windows / macos / linux 的展示名，兼容老数据里的 darwin / win32", () => {
  assert.equal(platformLabel("windows"), "Windows")
  assert.equal(platformLabel("win32"), "Windows")
  assert.equal(platformLabel("macos"), "macOS")
  assert.equal(platformLabel("darwin"), "macOS")
  assert.equal(platformLabel("linux"), "Linux")
  assert.equal(platformLabel("freebsd"), "freebsd")
  assert.equal(platformLabel(""), "")
  assert.equal(platformLabel(undefined), "")
})

test("v4 握手：auth 带 proto/caps/client；relay 没带 proto 按 v3 处理，能力只认字符串", () => {
  const frame = authFrame("tok")
  assert.equal(frame.type, "auth")
  assert.equal(frame.role, "viewer")
  assert.equal(frame.token, "tok")
  assert.equal(frame.proto, PROTO)
  assert.deepEqual(frame.caps, [...VIEWER_CAPS])
  assert.equal(frame.client.kind, "viewer")
  assert.ok(frame.caps.includes("device.token"), "网页懂名册的 auth/paired 与配对、撤销")
  assert.ok(frame.caps.includes("room.attention"), "R3-1 注意力恢复通道已落地，声明须同轮（第 3 轮审查 A-1）：UI 消费 lastTurnEnd 摘要与 room_attention 帧，握手必须声明 room.attention，否则 relay 按 cap 分流时会把摘要剥掉")
  assert.ok(frame.caps.includes("prefs.sync"), "R4-1 主题偏好同步已落地，声明须同轮（A-6 纪律）：UI 上行 prefs_set 并消费 auth 快照 prefs 字段与 prefs_changed 帧，握手必须声明 prefs.sync，否则 relay 按 cap 分流时会把快照与广播剥掉")
  assert.ok(!frame.caps.includes("sync.v3") && !frame.caps.includes("room.label"), "local 通道的能力网页不声明")

  assert.deepEqual(serverInfo({}), V3_SERVER)
  assert.deepEqual(serverInfo({ proto: 3, caps: ["msg.cid"] }), V3_SERVER, "v3 relay 的 caps 不可信")
  const v4 = serverInfo({ proto: 4, caps: ["err.v4", "msg.cid", 7, "", "msg.cid"] })
  assert.deepEqual(v4, { proto: 4, caps: ["err.v4", "msg.cid"] })
  assert.equal(hasCap(v4, "msg.cid"), true)
  assert.equal(hasCap(v4, "device.token"), false)
  assert.equal(hasCap(V3_SERVER, "err.v4"), false)
})

test("cid：符合 [A-Za-z0-9_-]{1,64}，连发不重复", () => {
  const ids = new Set()
  for (let k = 0; k < 2000; k += 1) {
    const cid = newCid()
    assert.ok(isCid(cid), cid)
    ids.add(cid)
  }
  assert.equal(ids.size, 2000)
  assert.equal(isCid("a".repeat(64)), true)
  assert.equal(isCid("a".repeat(65)), false)
  assert.equal(isCid("带中文"), false)
  assert.equal(isCid(""), false)
  assert.equal(isCid(12), false)
})

const userItems = (s) => s.items.filter((i) => i.kind === "user").map((i) => `${i.text}:${i.cid ?? "-"}:${i.failed ? "failed" : i.status ?? "settled"}`)

test("transcript cid：同样内容连发两条各自对号，回显/送达/失败不串", () => {
  let s = reduce(
    emptyTranscript(),
    { type: "echo", text: "继续", cid: "c1" },
    { type: "echo", text: "继续", cid: "c2" },
    { type: "echo", text: "继续", cid: "c1" },
  )
  assert.deepEqual(userItems(s), ["继续:c1:sending", "继续:c2:sending"], "同 cid 重复 echo 不加气泡")
  s = reduce(s, { type: "remote", text: "继续", cid: "c1" }, { type: "remote-failed", text: "继续", error: "会话正忙", cid: "c2" })
  assert.deepEqual(userItems(s), ["继续:c1:echoed", "继续:c2:failed"])
  s = reduce(s, { type: "delivered", cid: "c1" })
  assert.deepEqual(userItems(s), ["继续:c1:delivered", "继续:c2:failed"])
  // pi 的 user 消息取代成功的那条，失败的留着可重试
  s = reduce(s, { type: "message-end", message: user("继续") })
  assert.deepEqual(userItems(s), ["继续:c2:failed", "继续:-:settled"])
  // 送达确认晚于 user 消息：气泡已被取代，什么都不变
  assert.equal(reduce(s, { type: "delivered", cid: "c1" }), s)
})

test("transcript：同文本多条乐观气泡被 user 消息先进先出取代", () => {
  let s = reduce(emptyTranscript(), { type: "echo", text: "好", cid: "a" }, { type: "echo", text: "好", cid: "b" })
  s = reduce(s, { type: "remote", text: "好", cid: "b" }, { type: "delivered", cid: "b" })
  s = reduce(s, { type: "message-end", message: user("好") })
  assert.deepEqual(userItems(s), ["好:b:delivered", "好:-:settled"], "取代最早的 a，而不是最近的 b")
  // 旧 relay（不带 cid）同样先进先出
  let t = reduce(emptyTranscript(), { type: "echo", text: "x" }, { type: "remote", text: "x" })
  t = reduce(t, { type: "message-end", message: user("x") })
  assert.deepEqual(kinds(t), ["user:x"])
})

test("transcript：发送命令失败时，发送中的气泡摘掉或标失败；已回显的不动", () => {
  const sending = reduce(emptyTranscript(), { type: "echo", text: "hi", cid: "c1" })
  assert.deepEqual(userItems(reduce(sending, { type: "send-failed", cid: "c1", error: "会话正忙", drop: true })), [])
  assert.deepEqual(userItems(reduce(sending, { type: "send-failed", cid: "c1", error: "会话正忙", drop: false })), ["hi:c1:failed"])
  const echoed = reduce(sending, { type: "remote", text: "hi", cid: "c1" })
  assert.equal(reduce(echoed, { type: "send-failed", cid: "c1", error: "没有收到回应", drop: true }), echoed, "消息已到本机，回执丢了也不摘")
  // 重试：先摘掉原失败气泡，再出一条新的
  const failed = reduce(sending, { type: "send-failed", cid: "c1", error: "会话正忙", drop: false })
  const retried = reduce(failed, { type: "drop", key: failed.items[0].key }, { type: "echo", text: "hi", cid: "c2" })
  assert.deepEqual(userItems(retried), ["hi:c2:sending"])
})

test("transcript：快照里带 cid 的远程回显并进同 cid 气泡，之后被 pi 的 user 消息取代", () => {
  let s = reduce(emptyTranscript(), { type: "echo", text: "看看", cid: "c1" })
  const echoRecord = { role: "user", remote: true, cid: "c1", content: [{ type: "text", text: "看看" }] }
  s = reduce(s, { type: "append", messages: [echoRecord] })
  assert.deepEqual(userItems(s), ["看看:c1:echoed"])
  s = reduce(s, { type: "message-end", message: user("看看") })
  assert.deepEqual(userItems(s), ["看看:-:settled"])
  assert.equal(s.items[0].remote, true)
  // 全量快照（换房/重连）：别的网页发的回显也按 cid 成气泡，能被取代
  const full = reduceTranscript(emptyTranscript(), { type: "snapshot", messages: [user("q"), { ...echoRecord, cid: "z9" }] })
  assert.deepEqual(userItems(full), ["q:-:settled", "看看:z9:echoed"])
  assert.deepEqual(userItems(reduce(full, { type: "message-end", message: user("看看") })), ["q:-:settled", "看看:-:settled"])
})

test("命令通道：自己判的失败带码——没回应/断线取不回结果 result_unknown，发不出去 offline，关闭 closed；ack 透传 code 与 retryable", async () => {
  const ch = new CommandChannel({ acceptTimeoutMs: 10, graceMs: 20 })
  const ws = fakeSocket()
  ch.attach(ws)
  ch.connected("boot1")
  const lost = ch.command("r", "prompt", { message: "x" }, "LOST")
  await assert.rejects(lost, (e) => e.code === "result_unknown" && e.message === "LOST")

  const busy = ch.command("r", "prompt", { message: "y" })
  ch.ack({ id: ws.sent.at(-1).id, ok: false, error: "会话正忙", code: "busy", retryable: true })
  await assert.rejects(busy, (e) => e.code === "busy" && e.retryable === true && e.message === "会话正忙")

  const device = ch.deviceCommand("d1", "harness_start", {}, 1000, "LOST")
  const parked = ch.command("r", "compact", {})
  ch.disconnected()
  await assert.rejects(device, (e) => e.code === "offline")
  ch.attach(fakeSocket())
  ch.connected("boot2")
  await assert.rejects(parked, (e) => e.code === "result_unknown" && /relay 已重启/.test(e.message))

  ch.attach(null)
  await assert.rejects(ch.command("r", "get_state"), (e) => e.code === "offline")
  const open = fakeSocket()
  ch.attach(open)
  const pending = ch.command("r", "get_state")
  ch.dispose("bye")
  await assert.rejects(pending, (e) => e.code === "closed" && e.message === "bye")
})

test("名册：解析 auth/paired，非法值落为 null/false，占位设备也有默认值", () => {
  const devices = devicesFromRoomList(
    [
      { id: "a", name: "Mac", platform: "macos", online: true, auth: "token", paired: true },
      { id: "b", name: "PC", platform: "windows", online: true, auth: "legacy", paired: false },
      { id: "c", name: "旧", online: false, auth: "weird", paired: "yes" },
    ],
    [{ id: "r1", online: true }],
  )
  assert.deepEqual(
    devices.map((d) => [d.id, d.auth, d.paired]),
    [["a", "token", true], ["b", "legacy", false], ["c", null, false], ["未登记设备", null, false]],
  )
})

test("配对码展示为 XXXX-XXXX，Windows 和 macOS / Linux 两条命令带同一个码；剩余时间 m:ss", () => {
  assert.equal(formatPairCode("abcd2345"), "ABCD-2345")
  assert.equal(formatPairCode("ABCD-2345"), "ABCD-2345")
  assert.equal(formatPairCode("ABC"), "ABC")
  assert.deepEqual(
    pairCommands("ABCD2345").map((c) => [c.label, c.command]),
    [["Windows", "node deploy\\attach.cjs --pair ABCD-2345"], ["macOS / Linux", "deploy/attach.sh --pair ABCD-2345"]],
  )
  assert.equal(pairRemainText(600_000), "10:00")
  assert.equal(pairRemainText(61_001), "1:02")
  assert.equal(pairRemainText(59_000), "0:59")
  assert.equal(pairRemainText(-5), "0:00")
})

test("设备鉴权状态文案；有令牌或正用令牌连着才能撤销，未登记设备不能撤", () => {
  assert.deepEqual(deviceAuthState({ auth: "token", paired: true }), { text: "已配对", tone: "ok" })
  assert.equal(deviceAuthState({ auth: "legacy", paired: true }).tone, "warn")
  assert.equal(deviceAuthState({ auth: "legacy", paired: false }).text, "旧令牌连接，未配对")
  assert.deepEqual(deviceAuthState({ auth: null, paired: false }), { text: "未配对", tone: "muted" })
  assert.equal(canRevoke({ id: "a", auth: null, paired: true }), true)
  assert.equal(canRevoke({ id: "a", auth: "token", paired: false }), true)
  assert.equal(canRevoke({ id: "a", auth: "legacy", paired: false }), false)
  assert.equal(canRevoke({ id: "未登记设备", auth: null, paired: true }), false)
})

test("配对成功识别：生成码之后新出现的已配对设备、或原来未配对的设备变成已配对", () => {
  const before = [{ id: "mac", paired: true }, { id: "pc", paired: false }]
  const baseline = pairBaseline(before)
  assert.equal(newlyPaired(baseline, before), null, "名册没变：还没配上")
  assert.equal(newlyPaired(baseline, [...before, { id: "new", paired: false }]), null, "新设备还没配对")
  assert.equal(newlyPaired(baseline, [...before, { id: "new", paired: true }])?.id, "new")
  assert.equal(newlyPaired(baseline, [{ id: "mac", paired: true }, { id: "pc", paired: true }])?.id, "pc")
  assert.equal(newlyPaired(baseline, [{ id: "mac", paired: false }, { id: "pc", paired: false }]), null, "撤销不算配对成功")
})

test("管理员令牌：进管理命令帧，不进 viewer 认证帧；本机 localStorage 键固定", async () => {
  assert.equal(ADMIN_TOKEN_STORAGE_KEY, "pi_remote_admin_token")
  assert.deepEqual(pairCreateFrame("admin-secret"), { type: "pair_create", adminToken: "admin-secret" })
  assert.deepEqual(deviceRevokeFrame("dev-1", "admin-secret"), { type: "device_revoke", deviceId: "dev-1", adminToken: "admin-secret" })
  assert.equal("adminToken" in authFrame("viewer-token"), false, "查看端认证仍只带 viewer token")

  const ch = new CommandChannel({ acceptTimeoutMs: 1000 })
  const ws = fakeSocket()
  ch.attach(ws)
  const pair = ch.raw(pairCreateFrame("secret-pair"))
  const revoke = ch.raw(deviceRevokeFrame("dev-1", "secret-revoke"))
  const [pairFrame, revokeFrame] = ws.sent
  assert.equal(pairFrame.type, "pair_create")
  assert.equal(pairFrame.adminToken, "secret-pair")
  assert.equal(revokeFrame.type, "device_revoke")
  assert.equal(revokeFrame.deviceId, "dev-1")
  assert.equal(revokeFrame.adminToken, "secret-revoke")
  ch.ack({ id: pairFrame.id, ok: true, data: { code: "ABCD-2345", expiresAt: Date.now() + 1000 } })
  ch.ack({ id: revokeFrame.id, ok: true, data: { revoked: 1, closed: 1 } })
  await Promise.all([pair, revoke])
})

test("管理员令牌：空值禁用管理入口，admin_required 统一成可读文案", () => {
  assert.equal(adminTokenReady(""), false)
  assert.equal(adminTokenReady("   "), false)
  assert.equal(adminTokenReady("secret"), true)
  assert.match(ADMIN_TOKEN_COPY.hint, /本机浏览器/)
  assert.match(ADMIN_TOKEN_COPY.required, /配对码|撤销设备/)
  assert.equal(adminTokenErrorText({ code: "admin_required" }), ADMIN_TOKEN_COPY.invalid)
  assert.match(ADMIN_TOKEN_COPY.invalid, /不正确\/未配置/)
  assert.match(adminTokenErrorText({ code: "timeout" }), /本机没有回应/)
})

test("设备管理弹窗源码：密码输入只存本机，空令牌禁用生成/撤销，失败走 admin_required 文案", () => {

  const useRelay = readFileSync(new URL("../ui/src/relay/useRelay.ts", import.meta.url), "utf8")
  assert.match(useRelay, /safeStore\.get\(ADMIN_TOKEN_STORAGE_KEY\)/)
  assert.match(useRelay, /safeStore\.set\(ADMIN_TOKEN_STORAGE_KEY, next\)/)
  assert.match(useRelay, /pairCreateFrame\(secret\)/)
  assert.match(useRelay, /deviceRevokeFrame\(deviceId, secret\)/)
  assert.equal((useRelay.match(/if \(!adminTokenReady\(secret\)\) throw new RelayError\("admin_required"/g) || []).length, 3, "三个管理 API 在空令牌时都不发帧")
})

test("连接状态：首次连接用加载条；断开后倒计时重连，连上过的叫重连、没连上过的叫连不上", () => {
  const base = { token: "t", authed: false, everConnected: false, retryAt: null }
  assert.deepEqual(linkView({ ...base, token: "" }, 0), { kind: "ok" }, "登录页不算断线")
  assert.deepEqual(linkView({ ...base, authed: true }, 0), { kind: "ok" })
  assert.equal(firstConnecting(base), true)
  assert.equal(firstConnecting({ ...base, everConnected: true }), false, "重连不出加载条")
  assert.equal(firstConnecting({ ...base, retryAt: 5000 }), false, "第一次就连不上：出横幅")

  const lost = linkView({ ...base, everConnected: true, retryAt: 10_000 }, 7_200)
  assert.deepEqual(lost, { kind: "waiting", seconds: 3, first: false })
  assert.equal(linkBannerText(lost), "和服务器的连接断了，3 秒后重连")
  assert.equal(linkBannerText(linkView({ ...base, retryAt: 10_000 }, 9_999)), "连不上服务器，1 秒后重试")
  assert.equal(linkView({ ...base, retryAt: 10_000 }, 12_000).seconds, 0, "倒计时不出负数")
  assert.deepEqual(linkView({ ...base, everConnected: true }, 0), { kind: "reconnecting" })
  assert.equal(linkBannerText({ kind: "ok" }), "")
})

test("头部状态行：状态在最前；服务器断开、设备未连接、会话已结束三种分开叫；刚掉线的过渡期不写已结束", () => {
  const input = {
    room: { cwd: "D:\\work\\pi-remote" },
    authed: true,
    everConnected: true,
    online: true,
    roomDown: false,
    busy: false,
    device: { name: "PC", online: true },
  }
  assert.deepEqual(headerMeta(input), ["在线", "pi-remote", "PC"])
  assert.equal(headerMeta({ ...input, busy: true })[0], "运行中")
  assert.equal(headerMeta({ ...input, online: false })[0], "pi-remote", "换会话的过渡期：不闪已结束")
  assert.equal(headerMeta({ ...input, online: false, roomDown: true })[0], "已结束")
  assert.deepEqual(headerMeta({ ...input, online: false, device: { name: "PC", online: false } }).slice(0, 3), ["设备未连接", "pi-remote", "PC"])
  assert.equal(headerMeta({ ...input, authed: false })[0], "服务器已断开")
  assert.equal(headerMeta({ ...input, authed: false, everConnected: false })[0], "连接中")
  assert.deepEqual(headerMeta({ ...input, room: null, device: null }), [])
  assert.equal(roomStatusText({ online: false, busy: false }), "已结束")
})

test("标签页标题：断线优先，其次运行中，后台跑完打勾；没选会话只写 pi", () => {
  const base = { room: "修 bug", busy: false, unseenDone: false, linkLost: false }
  assert.equal(pageTitle(base), "修 bug · pi")
  assert.equal(pageTitle({ ...base, room: "" }), "pi")
  assert.equal(pageTitle({ ...base, busy: true }), "● 修 bug · pi")
  assert.equal(pageTitle({ ...base, unseenDone: true }), "✓ 修 bug · pi")
  assert.equal(pageTitle({ ...base, busy: true, unseenDone: true }), "● 修 bug · pi")
  assert.equal(pageTitle({ ...base, busy: true, linkLost: true }), "已断开 · 修 bug · pi")
})

test("默认设备：有在线房间的优先；多台都有时选最近活动；都没有才退回第一台在线", () => {
  const windows = { ...dev(true), id: "win", name: "Windows" }
  const cloud = { ...dev(true), id: "cloud", name: "阿里云", platform: "linux" }
  const offline = room({ id: "old", deviceId: "win", online: false, lastActivity: 9999 })
  const live = room({ id: "demo", deviceId: "cloud", online: true, lastActivity: 50 })
  assert.equal(pickDefaultDevice([windows, cloud], [offline, live]), "cloud", "名册里 Windows 在前，也不能盖过正在跑的房间")
  assert.equal(
    pickDefaultDevice([windows, cloud], [live, room({ id: "newer", deviceId: "win", online: true, lastActivity: 80 })]),
    "win",
  )
  assert.equal(pickDefaultDevice([windows, cloud], [offline]), "win", "没有在线房间时退回第一台在线设备")
  assert.equal(pickDefaultDevice([{ ...windows, online: false }, { ...cloud, online: false }], []), "win")
  assert.equal(pickDefaultDevice([], [live]), null)
  assert.equal(
    pickDefaultDevice([windows, cloud], [
      room({ id: "a", deviceId: "win", lastActivity: 5 }),
      room({ id: "b", deviceId: "cloud", lastActivity: 5 }),
    ]),
    "cloud",
    "活动时间相同则取列表里更靠后的在线房间",
  )
  assert.equal(pickDefaultDevice([windows], [room({ id: "x", deviceId: "missing", lastActivity: 100 })]), "win")
})

test("登录后打开正在跑的房间：当前房间仍在线就留在原地，否则进选中设备上最近活动的", () => {
  const rooms = [
    room({ id: "old", deviceId: "win", online: false, lastActivity: 1 }),
    room({ id: "a", deviceId: "cloud", online: true, lastActivity: 10 }),
    room({ id: "b", deviceId: "cloud", online: true, lastActivity: 40 }),
    room({ id: "solo", deviceId: "win", online: true, lastActivity: 3 }),
  ]
  assert.equal(pickLoginRoom(rooms, "cloud", "", true), "b", "多个在线房间进最近活动的")
  assert.equal(pickLoginRoom(rooms, "win", "", true), "solo", "只有一个在线房间就打开它")
  assert.equal(pickLoginRoom(rooms, "cloud", "a", true), "a", "正在看的在线房间刷新后还留在原地")
  assert.equal(pickLoginRoom(rooms, "cloud", "old", true), "b")
  assert.equal(pickLoginRoom([rooms[0]], "win", "old", true), null, "没有在线房间就停在名册")
  assert.equal(pickLoginRoom(rooms, "cloud", "b", false), null)
  assert.equal(preferredDeviceId(rooms, "a", [{ id: "cloud", online: true }, { id: "win", online: true }]), "cloud")
  assert.equal(preferredDeviceId(rooms, "old", [{ id: "win", online: true }]), null, "离线旧会话不能把默认设备钉在 Windows")
  assert.equal(preferredDeviceId(rooms, "solo", [{ id: "win", online: false }]), null)
})

test("在线但没有正在跑的会话时，提示点选会话发送载入，或从允许的目录新建", () => {
  const device = dev(true, ["D:\\work\\demo", "D:\\work\\demo"])
  assert.match(idleDeviceHint(device, false), /没有正在跑的会话/)
  assert.match(idleDeviceHint(device, false), /点选一个会话/)
  assert.match(idleDeviceHint(device, false), /发送第一条消息时载入/)
  assert.match(idleDeviceHint(device, false), /新建会话/)
  assert.match(idleDeviceHint(device, false), /demo/)
  assert.doesNotMatch(idleDeviceHint(device, false), /启用/)
  assert.equal(idleDeviceHint(device, true), null)
  assert.equal(idleDeviceHint(dev(false, ["D:\\work"]), false), null)
  const noProjects = idleDeviceHint(dev(true, []), false)
  assert.match(noProjects, /没有允许的目录/)
  assert.match(noProjects, /点选已保存的会话/)
  assert.doesNotMatch(noProjects, /启用/)
  assert.match(sessionEmptyHint(null, false), /先选一台设备/)
  assert.match(sessionEmptyHint(dev(true, ["C:\\src\\Pi-Remote"]), false), /Pi-Remote/)
  assert.match(sessionEmptyHint(dev(true, ["C:\\src\\Pi-Remote"]), true), /正在跑的会话/)
})

test("上下文条：按 tokens/窗口 计算，pi 的百分点不再乘 100", () => {
  const live = contextReadout({ tokens: 1561, contextWindow: 1_000_000, percent: 0.1561 })
  assert.equal(live.state, "ok")
  assert.ok(Math.abs(live.percent - 1561 / 1_000_000) < 1e-12)
  assert.equal(live.label, "上下文 0.16%")
  assert.ok(live.percent < 0.9, "两句话不该把进度条涂红")

  const ok = contextReadout({ tokens: 1000, contextWindow: 128000, percent: 0.78125 })
  assert.equal(ok.state, "ok")
  assert.equal(ok.label, "上下文 0.78%")

  const overflow = contextReadout({ tokens: 200000, contextWindow: 128000, percent: 156.25 })
  assert.ok(overflow.percent > 1)
  assert.equal(overflow.label, "上下文 156.3%")

  const tiny = contextReadout({ tokens: 1561, contextWindow: 1280, percent: 122 })
  assert.equal(tiny.percent, null)
  assert.equal(tiny.state, "untrusted")
  assert.equal(tiny.label, `上下文 ${(1561).toLocaleString("zh-CN")} · 窗口未知`)
  assert.equal(tiny.label.includes("%"), false)
  assert.equal(tiny.title.includes("%"), false)
  assert.equal(tiny.title.includes("1280"), false)

  const missing = contextReadout({ tokens: 1561, percent: 1.22 })
  assert.equal(missing.percent, null)
  assert.match(missing.label, /窗口未知/)
  assert.equal(missing.label.includes("%"), false)

  assert.equal(contextReadout({ tokens: 4096, contextWindow: 8192, percent: 50 }).label, "上下文 50%")
  const below = contextReadout({ tokens: 10, contextWindow: 8191, percent: 0.5 })
  assert.equal(below.percent, null)
  assert.match(below.label, /窗口未知/)

  const fromPoints = contextReadout({ contextWindow: 1_000_000, percent: 0.1561 })
  assert.equal(fromPoints.label, "上下文 0.16%")

  assert.equal(contextReadout(null).label, "")
  assert.equal(contextReadout({ percent: 1.22, contextWindow: 100 }).label, "窗口未知")
  assert.equal(contextReadout({ percent: 1.22, contextWindow: 100 }).percent, null)
})

test("后台跑完标记：同一会话运行中→空闲且页面在后台才打勾；前台跑完、重新运行、换会话都不留", () => {
  const running = { busy: true, roomId: "r1", unseen: false }
  assert.equal(nextUnseen(running, { busy: false, roomId: "r1", hidden: true }), true)
  assert.equal(nextUnseen(running, { busy: false, roomId: "r1", hidden: false }), false, "在前台看着跑完的不用提醒")
  assert.equal(nextUnseen(running, { busy: false, roomId: "r2", hidden: true }), false, "换会话带来的空闲不算跑完")
  const marked = { busy: false, roomId: "r1", unseen: true }
  assert.equal(nextUnseen(marked, { busy: true, roomId: "r1", hidden: true }), false, "又开始跑了")
  assert.equal(nextUnseen({ ...marked, busy: false }, { busy: false, roomId: "r1", hidden: true }), true, "别的变化不清掉标记")
})


test("思考级别只解析实际返回值并规范化显示名", () => {
  assert.deepEqual(parseThinkingLevels({ levels: ["off", "minimal", "low", "medium", "high"] }), ["off", "minimal", "low", "medium", "high"])
  assert.deepEqual(parseThinkingLevels({ levels: [{ id: "low" }, { name: "medium" }, { level: "high" }] }), ["low", "medium", "high"])
  assert.deepEqual(parseThinkingLevels({ levels: ["high", "high"] }), ["high"])
  assert.deepEqual(parseThinkingLevels({ levels: "high" }), [])
  assert.equal(thinkingLevelLabel("xhigh"), "XHigh")
  assert.equal(thinkingLevelLabel("high"), "High")
  assert.equal(thinkingLevelLabel("custom"), "custom")
  assert.equal(currentThinkingLevel(["off", "high"], "HIGH"), "high")
  assert.equal(currentThinkingLevel(["off"], "max"), null)
  assert.equal(currentThinkingLevel([], "high"), null)
})
// P7-R1-1：原「第 5 章接线」用例读的旧 chat 层文件已删，读保留文件 useRelay.ts 的 3 条拆到这里保留。
test("useRelay 接线：通知走 useNotices / noticeChannel，离线发送给明确提示（P7 从「第 5 章接线」拆出）", () => {
  const relay = readFileSync(new URL("../ui/src/relay/useRelay.ts", import.meta.url), "utf8")
  assert.match(relay, /useNotices\(/, "useRelay 接 noticeCore 的通知栈")
  assert.match(relay, /noticeChannel\(/, "旧 setNotice 按稳定 code 分通道")
  assert.match(relay, /OFFLINE_SEND_COPY/, "离线发送给明确提示")
})
test("第 5 章投递/锁：S4 按 sendMode（默认 auto）投递，同步抢锁在清草稿之前，超时/晚到 ack 按 token 释放", () => {
  assert.match(OFFLINE_SEND_COPY, /输入框/)

  // S4 三种选择都从同一个 deliveryPlan 出口，UI 与发送共用：
  const base = { draft: "等会再说", online: true, deviceOnline: true, generating: true }
  assert.deepEqual(deriveComposer({ ...base, sendMode: "auto" }).delivery, deliveryPlan("auto", true))
  assert.equal(deriveComposer({ ...base, sendMode: "auto" }).delivery.command, "steer", "默认自动在忙时插入当前回合")
  assert.equal(deriveComposer({ ...base, sendMode: "steer" }).delivery.command, "steer")
  assert.equal(deriveComposer({ ...base, sendMode: "follow_up" }).delivery.command, "follow_up")
  assert.equal(deriveComposer({ ...base, sendMode: "follow_up" }).sendKind, "queue")
  assert.equal(deriveComposer({ ...base, sendMode: "auto" }).sendKind, "send")
  assert.equal(decideEnter({ ui: deriveComposer({ ...base, sendMode: "steer" }) }).action, "queue")
  // 省略 sendMode 只保留旧调用兼容；产品路径由 relay 显式传入。
  assert.equal(deriveComposer(base).delivery.command, "follow_up", "旧调用缺省仍回落 follow_up")

  const relay = readFileSync(new URL("../ui/src/relay/useRelay.ts", import.meta.url), "utf8")
  assert.match(relay, /const plan = deliveryPlan\(sendModeRef\.current, busyRef\.current\)/)
  assert.equal(relay.includes("planForSend("), false, "发送计划不再写死 busy→follow_up")
  assert.match(relay, /parseSendMode\(safeStore\.get\(SEND_MODE_KEY\)\)/, "投递方式从 localStorage 恢复，默认 auto")
  assert.match(relay, /sendModeRef\.current = next/)
  assert.equal(relay.includes('deliveryPlan("auto", busyRef.current)'), false, "不能回到 auto+busy 的旧写法")
  assert.match(relay, /sendLock\.current\.acquire\(cid\)/)
  assert.ok(
    relay.indexOf("sendLock.current.acquire(cid)") < relay.indexOf('if (fromDraft) setDraft("")'),
    "取锁必须早于清草稿/出气泡，同 tick 第二次 Enter 才拦得住",
  )
  assert.match(relay, /ACK_TIMEOUT_MS/)
  assert.match(relay, /sendLock\.current\.release\(cid\)/)
  assert.match(relay, /send-failed[^\n]*drop: false/, "失败留在气泡，不回写草稿")
  assert.equal(relay.includes("draftAfterSendFailure"), false, "不再调用 draftAfterSendFailure")
  assert.match(relay, /failurePulse/)
})

test("多图输入：5 张上限 / 单图 128K / 合计 192K 预算，入口走粘贴拖放多选且只拒单图", () => {
  assert.equal(MAX_PENDING_IMAGES, 5)
  assert.equal(SEND_IMAGE_MAX_CHARS, 131072)
  assert.equal(SEND_IMAGE_TOTAL_MAX_CHARS, 192 * 1024)
  assert.equal(remainingImageSlots(0), 5)
  assert.equal(remainingImageSlots(4), 1)
  assert.equal(remainingImageSlots(5), 0)
  assert.equal(remainingImageSlots(9), 0)
  assert.equal(imageCharsTotal([{ data: "aa" }, { data: "bbb" }]), 5)
  assert.equal(imageCharsTotal([]), 0)
  assert.equal(imageCharsTotal(null), 0)

  // 一次选 5 张时按合计预算均分，保证整批能进一帧；单张仍不突破 128K。
  const perFive = imageBudgetFor(0, 5)
  assert.equal(perFive, Math.floor(SEND_IMAGE_TOTAL_MAX_CHARS / 5))
  assert.ok(perFive > MIN_IMAGE_BUDGET_CHARS)
  assert.ok(perFive < SEND_IMAGE_MAX_CHARS)
  assert.equal(imageBudgetFor(0, 1), SEND_IMAGE_MAX_CHARS)
  assert.equal(imageBudgetFor(SEND_IMAGE_TOTAL_MAX_CHARS, 1), 0)
  assert.equal(imageBudgetFor(0, 0), 0)

  // 单张坏图不连坐：只把它从 images 里摘掉，其余图仍在；正文由调用方另发。
  const small = { data: "A".repeat(64), mimeType: "image/png" }
  const big = { data: "A".repeat(SEND_IMAGE_MAX_CHARS + 1), mimeType: "image/png" }
  const oneBad = planSendImages([big, small])
  assert.equal(oneBad.images.length, 1)
  assert.match(oneBad.notice, /超过 131072/)
  const overTotal = planSendImages([
    { data: "A".repeat(100_000), mimeType: "image/png" },
    { data: "A".repeat(100_000), mimeType: "image/png" },
  ])
  assert.equal(overTotal.images.length, 1, "合计超预算时仍保留放得下的图")
  assert.match(overTotal.notice, /图片合计超过 192K/)
  assert.equal(planSendImages([]).images, undefined)
  assert.equal(planSendImages([]).notice, "")

  const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
  const relay = source("../ui/src/relay/useRelay.ts")



  assert.match(relay, /const \[pendingImages, setPendingImagesState\] = useState<SendImage\[\]>\(\[\]\)/)
  assert.match(relay, /const addPendingImages = useCallback/)
  assert.match(relay, /const removePendingImage = useCallback/)
  assert.match(relay, /const clearPendingImages = useCallback/)
  assert.match(relay, /planSendImages\(attached\)/)
  assert.match(relay, /attachedPlan\.notice/, "图片问题只提示，不 return 掉整条消息")
  assert.match(relay, /if \(attached\.length\)[\s\S]{0,180}clearPendingImages\(\)/, "发送成功才清附图")
  assert.match(relay, /dropSentPendingImages\(attached\)/, "发送期间新加的图不能被旧请求清掉")
  assert.equal(/\bpendingImageRef\b/.test(relay), false, "单图 ref 已移除")
  assert.equal(/\bsetPendingImage\b/.test(relay), false, "单图 setter 已移除")

})

test("通知分通道：progress/connectivity 留状态行，其余进栈；同屏 1 张 + 队列 5", () => {
  assert.equal(noticeChannel(["connectivity", "progress"]), "connectivity")
  assert.equal(noticeChannel(["connectivity"]), "connectivity")
  for (const code of PROGRESS_NOTICE_CODES) {
    assert.equal(noticeChannel([code]), "progress", code)
  }
  assert.equal(noticeChannel(["summarization"]), "progress")
  assert.equal(noticeChannel(["truncated"]), "progress")
  assert.equal(noticeChannel(), "stack")
  assert.equal(noticeChannel(["lazy-send"]), "progress")
  assert.equal(noticeChannel(["whatever"]), "stack")
  assert.equal(noticeLevelForTone("bad"), "error")
  assert.equal(noticeLevelForTone("warn"), "warning")

  resetNoticeStoreForTest()
  try {
    noticeStore.setMaxVisible(NOTICE_MAX_VISIBLE)
    noticeStore.push({ id: "a", level: "warning", title: "第一条" })
    noticeStore.push({ id: "b", level: "info", title: "第二条" })
    noticeStore.push({ id: "c", level: "error", title: "第三条" })
    let snapshot = getNoticeSnapshot()
    assert.deepEqual(snapshot.visible.map((item) => item.id), ["c"], "error 抢占后只显示 1 张")
    assert.deepEqual(snapshot.queue.map((item) => item.id), ["a", "b"], "其余按级别进队列")
    assert.equal(snapshot.queue.length <= NOTICE_QUEUE_LIMIT, true)

    noticeStore.dismiss("c")
    snapshot = getNoticeSnapshot()
    assert.deepEqual(snapshot.visible.map((item) => item.id), ["a"], "关闭后队列补位")
    assert.deepEqual(snapshot.queue.map((item) => item.id), ["b"])

    noticeStore.push({ id: "c2", level: "warning", title: "第四条", dedupeKey: "same" })
    noticeStore.push({ id: "c3", level: "warning", title: "第五条", dedupeKey: "same" })
    snapshot = getNoticeSnapshot()
    const merged = [...snapshot.visible, ...snapshot.queue].find((item) => item.dedupeKey === "same")
    assert.equal(merged?.count, 2, "同 dedupeKey 合并计数而不是多一张")
  } finally {
    resetNoticeStoreForTest()
  }
})


test("token 用量行：只在最后一个有效块是文本的定稿回复末尾出现", () => {
  const text = (value) => ({ kind: "text", text: value })
  const thinking = (value) => ({ kind: "thinking", text: value })
  const tool = { kind: "tool", id: "t1", name: "bash", argsText: "", outputText: "", state: "output-available" }
  const item = (blocks, live = false) => ({ kind: "assistant", key: "a1", blocks, live })

  assert.equal(shouldShowUsage(item([thinking("想一想"), tool])), false, "只有 thinking + tool：中间工具段不显示")
  assert.equal(shouldShowUsage(item([thinking("想一想"), tool, text("最终回答")])), true, "text 在最后：最终回复要显示")
  assert.equal(shouldShowUsage(item([text("先说一句"), tool])), false, "tool 在最后：仍属于工具调用段")
  assert.equal(shouldShowUsage(item([text("只有文本")])), true)
  assert.equal(shouldShowUsage(item([thinking("只有思考")])), false)
  assert.equal(shouldShowUsage(item([])), false, "空 blocks 不显示")
  assert.equal(shouldShowUsage(item([text("还在流式")], true)), false, "live 流式时不显示")
  assert.equal(shouldShowUsage(item([text("   ")])), false, "空白文本不算有效块")

})

test("投递方式：自动/steer/follow_up 只在忙碌时生效，空闲明确回落 prompt", () => {
  assert.deepEqual(deliveryPlan("auto", true), { command: "steer", idleFallback: false })
  assert.deepEqual(deliveryPlan("auto", false), { command: "prompt", idleFallback: false })
  assert.deepEqual(deliveryPlan("steer", true), { command: "steer", idleFallback: false })
  assert.deepEqual(deliveryPlan("steer", false), { command: "prompt", idleFallback: true })
  assert.deepEqual(deliveryPlan("follow_up", true), { command: "follow_up", idleFallback: false })
  assert.deepEqual(deliveryPlan("follow_up", false), { command: "prompt", idleFallback: true })
  assert.equal(sendModeLabel("auto"), "自动")
  assert.equal(sendModeLabel("steer"), "插入当前回合")
  assert.equal(sendModeLabel("follow_up"), "排队")
  assert.equal(parseSendMode("follow_up"), "follow_up")
  assert.equal(parseSendMode("steer"), "steer")
  assert.equal(parseSendMode("queue"), "auto")
  assert.equal(parseSendMode(null), "auto")
})

test("模型显示：优先 modelId，完整 provider/modelId 放 tooltip，换模型不沿用旧名字", () => {
  const meta = modelMetaFrom({ provider: "stepfun", modelId: "step-5-preview", name: "Step 5 Preview" })
  assert.deepEqual(meta, { provider: "stepfun", modelId: "step-5-preview", name: "Step 5 Preview" })
  assert.equal(modelLabel(meta, "Step 5 Preview"), "step-5-preview")
  assert.equal(modelTitle(meta, "Step 5 Preview"), "stepfun/step-5-preview")
  assert.equal(modelLabel(modelMetaFrom({ name: "Only Name" }), "fallback"), "Only Name")
  assert.equal(modelTitle(modelMetaFrom({ name: "Only Name" }), "fallback"), "Only Name")
  assert.equal(modelLabel({}, "fallback-name"), "fallback-name")
  assert.equal(modelTitle({}, "fallback-name"), "fallback-name")
  assert.equal(modelLabel(null, ""), "模型")
  const merged = mergeModelMeta({ provider: "a", modelId: "m1", name: "Old" }, { provider: "b", modelId: "m2" })
  assert.deepEqual(merged, { provider: "b", modelId: "m2" }, "换模型后旧显示名不能盖上来")
  const same = mergeModelMeta({ provider: "a", modelId: "m1", name: "Nice" }, { provider: "a", modelId: "m1" })
  assert.equal(same.name, "Nice")
})

test("文本文件：只接受 UTF-8 文本，NUL/非法字节/空文件都拒绝", () => {
  const ok = decodeTextFile(new TextEncoder().encode("hello\r\nworld\r"))
  assert.deepEqual(ok, { ok: true, text: "hello\nworld\n" })
  const bom = decodeTextFile(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))
  assert.deepEqual(bom, { ok: true, text: "hi" })
  assert.match(decodeTextFile(new Uint8Array([0x61, 0x00, 0x62])).reason, /二进制/)
  assert.match(decodeTextFile(new Uint8Array([0xff, 0xfe, 0xfd])).reason, /UTF-8/)
  assert.match(decodeTextFile(new Uint8Array()).reason, /空/)
  assert.match(decodeTextFile(new TextEncoder().encode(" \n\t ")).reason, /空白/)
})

test("文本文件插入：带文件名 fenced block，受 8000 字上限截断，不撑爆 textarea", () => {
  const small = insertFileBlock("", "notes.txt", "line 1\nline 2")
  assert.equal(small.ok, true)
  assert.match(small.text, /^```notes\.txt\nline 1\nline 2\n```$/)
  assert.ok(small.text.length <= COMPOSER_MAX_CHARS)

  const appended = insertFileBlock("look:", "a.md", "body")
  assert.equal(appended.ok, true)
  assert.match(appended.text, /^look:\n\n```a\.md\nbody\n```$/)

  const long = insertFileBlock("hello", "big.txt", "x".repeat(9000))
  assert.equal(long.ok, true)
  assert.equal(long.truncated, true)
  assert.ok(long.omittedChars > 0)
  assert.ok(long.text.length <= COMPOSER_MAX_CHARS, "截断后不能超过 8000 字")
  assert.match(long.text, /^hello\n\n```big\.txt\nx+…\n```$/)
  assert.equal(long.text.includes("x".repeat(9000)), false)

  const full = insertFileBlock("a".repeat(COMPOSER_MAX_CHARS - 4), "f.txt", "body")
  assert.equal(full.ok, false)
  assert.match(full.reason, /8000/)

  const ticks = insertFileBlock("", "t.txt", "a ``` b")
  assert.equal(ticks.ok, true)
  assert.match(ticks.text, /^````t\.txt\n/)
  assert.match(ticks.text, /\n````$/)

  const weird = insertFileBlock("", "a\nb`.txt", "body")
  assert.equal(weird.ok, true)
  assert.match(weird.text, /^```a b \.txt\n/)
})


// ---------------------------------------------------------------------------
// 任务清单（task_list_state → relay.taskList → ComposerCard 内 TaskListCard）
// ---------------------------------------------------------------------------

const taskListJiti = createJiti(import.meta.url, { interopDefault: false, jsx: true })
const {
  TASK_LIST_AUTO_COLLAPSE_MS,
  parseTaskListEvent,
  summarizeTasks,
  taskListAfterEvent,
} = await taskListJiti.import("../ui/src/chat/composer/taskList.ts")

/** 后端契约 §task_list_state 的 fixture：三态 + activeForm + 可选 source/at。 */
const TASK_LIST_FRAME = {
  type: "task_list_state",
  source: "todo",
  at: 1750000000000,
  tasks: [
    { id: "t1", content: "梳理事件契约", status: "completed" },
    { id: "t2", content: "实现 taskList 消费", status: "in_progress", activeForm: "正在实现 taskList 消费" },
    { id: "t3", content: "补三皮肤与 390 适配", status: "pending" },
  ],
}

test("task_list_state fixture：事件驱动 taskList，空数组清空，非法帧保留上一帧", () => {
  let state = []
  state = taskListAfterEvent(state, TASK_LIST_FRAME)
  assert.deepEqual(state, TASK_LIST_FRAME.tasks, "合法事件原样落地，不在前端补字段")

  // 同 id 的新状态替换整份快照（不是增量合并）
  state = taskListAfterEvent(state, {
    type: "task_list_state",
    tasks: [
      { id: "t1", content: "梳理事件契约", status: "completed" },
      { id: "t2", content: "实现 taskList 消费", status: "completed" },
      { id: "t3", content: "补三皮肤与 390 适配", status: "completed" },
    ],
  })
  assert.equal(state.length, 3)
  assert.equal(summarizeTasks(state).allComplete, true, "3 条都完成")
  assert.equal(summarizeTasks(state).completed, 3)
  assert.equal(summarizeTasks(state).currentLabel, "全部完成")

  // 契约：空数组清空；非法帧（缺 tasks / tasks 不是数组）忽略，保留上一帧
  state = taskListAfterEvent(state, { type: "task_list_state", tasks: [] })
  assert.deepEqual(state, [], "空数组必须清空")
  const before = [{ id: "keep", content: "保留", status: "pending" }]
  assert.equal(taskListAfterEvent(before, { type: "task_list_state" }), before, "缺 tasks 不改状态")
  assert.equal(taskListAfterEvent(before, { type: "task_list_state", tasks: "bad" }), before, "tasks 非数组不改状态")
  assert.equal(taskListAfterEvent(before, null), before)
})

test("task_list_state：脏条目过滤不伪造（缺 id/正文/非法状态/重复 id 都跳过）", () => {
  const parsed = parseTaskListEvent({
    type: "task_list_state",
    tasks: [
      { id: "ok", content: " 正常项 ", status: "pending", activeForm: " 正在做 " },
      { id: "", content: "缺 id", status: "pending" },
      { id: "no-content", content: "   ", status: "pending" },
      { id: "bad-status", content: "状态非法", status: "doing" },
      { id: "ok", content: "重复 id", status: "completed" },
      null,
      "not-an-object",
    ],
  })
  assert.deepEqual(parsed, [{ id: "ok", content: "正常项", status: "pending", activeForm: "正在做" }])
  assert.equal(parseTaskListEvent({ type: "task_list_state", tasks: [] }).length, 0)
  assert.equal(parseTaskListEvent({ type: "task_list_state" }), null)
  assert.equal(
    parseTaskListEvent({ type: "task_list_state", tasks: [{ id: "x", content: "坏的", status: "doing" }] }),
    null,
    "非空数组全部认不出时按坏帧忽略，不清空现有清单",
  )
})

test("任务清单归纳：n/m 只数 completed，当前项优先 activeForm，待办回退 content", () => {
  const active = summarizeTasks(TASK_LIST_FRAME.tasks)
  assert.deepEqual(
    { total: active.total, completed: active.completed, allComplete: active.allComplete },
    { total: 3, completed: 1, allComplete: false },
  )
  assert.equal(active.current?.id, "t2")
  assert.equal(active.currentLabel, "正在实现 taskList 消费", "进行项显示 activeForm")

  const pendingOnly = summarizeTasks([
    { id: "a", content: "先做这个", status: "pending" },
    { id: "b", content: "再做这个", status: "pending" },
  ])
  assert.equal(pendingOnly.current?.id, "a", "没有进行项时当前项指向第一条待办")
  assert.equal(pendingOnly.currentLabel, "先做这个")
  assert.equal(pendingOnly.completed, 0)

  const empty = summarizeTasks([])
  assert.deepEqual(
    { total: empty.total, completed: empty.completed, allComplete: empty.allComplete, current: empty.current, currentLabel: empty.currentLabel },
    { total: 0, completed: 0, allComplete: false, current: null, currentLabel: "" },
  )
  assert.equal(TASK_LIST_AUTO_COLLAPSE_MS, 1500, "全部完成只短暂展开 1.5s")
})

test("任务清单接线：useRelay 消费事件并暴露 taskList，换房/重连清空，ComposerCard 挂在 textarea 上方", () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
  const relay = source("../ui/src/relay/useRelay.ts")

  assert.match(relay, /const \[taskList, setTaskList\] = useState<TaskListItem\[\]>\(\[\]\)/, "状态在 useRelay 内")
  assert.match(
    relay,
    /case "task_list_state":[\s\S]{0,260}setTaskList\(\(current\) => taskListAfterEvent\(current, event\)\)/,
    "只走同一个事件归约，不另造任务",
  )
  assert.match(relay, /\n\s+taskList,\n/, "Relay 暴露 taskList")
  assert.ok((relay.match(/setTaskList\(\[\]\)/g) || []).length >= 5, "换房、清房、惰性会话、建连、断线都清空")



})

// ---------------------------------------------------------------------------
// 本机弹窗等待（ui_prompt_start/end → relay.uiPrompt → ComposerCard 内状态条）
// ---------------------------------------------------------------------------

const promptJiti = createJiti(import.meta.url, { interopDefault: false, jsx: true })
const { dialogReceiptOf, dialogsAfterEvent, extStatusAfterEvent, formatDialogTiming, formatPromptWait, normalizeDialogCard, uiPromptAfterEvent } = await promptJiti.import("../ui/src/chat/composer/promptModel.ts")

test("ui_prompt fixture：start 设置/更新，end 清空，同弹窗重放不重置计时", () => {
  const start = { type: "ui_prompt_start", kind: "confirm", title: "是否继续？" }
  const opened = uiPromptAfterEvent(null, start, 1000)
  assert.deepEqual(opened, { kind: "confirm", title: "是否继续？", startedAt: 1000 })

  // 断线重连由 relay 缓存补发的同一条 start：保留第一次看到的时刻，等待时长不跳回 0
  assert.equal(uiPromptAfterEvent(opened, start, 9000).startedAt, 1000)
  assert.equal(uiPromptAfterEvent(opened, { ...start, title: "换了弹窗" }, 9000).startedAt, 9000, "新弹窗重新计时")
  assert.equal(uiPromptAfterEvent(opened, { type: "ui_prompt_end" }, 9000), null)
  assert.equal(uiPromptAfterEvent(opened, { type: "something_else" }, 9000), opened, "无关事件原样保留")

  // 没给内容也承认“有弹窗”，但字段留空，不补默认文案/类型
  assert.deepEqual(uiPromptAfterEvent(null, { type: "ui_prompt_start" }, 500), { kind: "", title: "", startedAt: 500 })
  assert.deepEqual(uiPromptAfterEvent(null, { type: "ui_prompt_start", kind: 7, title: null }, 500), {
    kind: "",
    title: "",
    startedAt: 500,
  })
})

test("dialog fixture（O1）：多槽 open/close 按 dialogId，交错不覆盖，坏帧保留上一帧", () => {
  const open1 = { type: "dialog_open", dialogId: "dlg-1", kind: "select", title: "选一个", options: ["甲", "乙"], startedAt: 1000 }
  const open2 = { type: "dialog_open", dialogId: "dlg-2", kind: "confirm", title: "确定？", message: "正文", timeout: 60000, startedAt: 2000 }
  let dialogs = dialogsAfterEvent([], open1, 5000)
  assert.equal(dialogs.length, 1)
  assert.equal(dialogs[0].startedAt, 1000, "计时锚点用帧内 startedAt，不用本地到达时刻")
  dialogs = dialogsAfterEvent(dialogs, open2, 6000)
  assert.equal(dialogs.length, 2, "第二个 dialog 交错打开不覆盖第一个")
  dialogs = dialogsAfterEvent(dialogs, { type: "dialog_close", dialogId: "dlg-1" }, 7000)
  assert.deepEqual(dialogs.map((d) => d.dialogId), ["dlg-2"], "close 只摘对应槽")
  // 同 id 重放（重连补发）：原位更新，不新增、不重置 startedAt
  const replayed = dialogsAfterEvent(dialogs, open2, 9999)
  assert.equal(replayed.length, 1)
  assert.equal(replayed[0].startedAt, 2000)
  // 坏帧与无关事件：同一引用原样返回
  assert.equal(dialogsAfterEvent(dialogs, { type: "dialog_open", kind: "select" }, 1), dialogs, "无 dialogId 不建卡")
  assert.equal(dialogsAfterEvent(dialogs, { type: "dialog_close", dialogId: "nope" }, 1), dialogs)
  assert.equal(dialogsAfterEvent(dialogs, { type: "message_start" }, 1), dialogs)
  // 计时：有 timeout 显示剩余，没有显示已等待
  assert.equal(formatDialogTiming(dialogs[0], 2000 + 15000), "剩余 0:45")
  assert.equal(formatDialogTiming({ dialogId: "x", kind: "input", startedAt: 1000 }, 61000), "已等待 1:00")
})

test("dialog fixture（O2）：answerable 归一保留、补发不丢；denied 回执只认 reason=denied", () => {
  const openAns = { type: "dialog_open", dialogId: "dlg-a", kind: "confirm", title: "删库？", answerable: true, timeout: 120000, startedAt: 3000 }
  const card = normalizeDialogCard(openAns, 9999)
  assert.equal(card.answerable, true, "answerable:true 进卡（可答渲染靠它）")
  assert.equal(card.timeout, 120000)
  // 非 true 一律不带（观察态卡不得长出应答区）
  assert.equal(normalizeDialogCard({ ...openAns, answerable: "yes" }, 1).answerable, undefined)
  assert.equal(normalizeDialogCard({ type: "dialog_open", dialogId: "d", kind: "confirm" }, 1).answerable, undefined)
  // 补发同 id：answerable 与 startedAt 都保留
  let dialogs = dialogsAfterEvent([], openAns, 5000)
  dialogs = dialogsAfterEvent(dialogs, openAns, 8000)
  assert.equal(dialogs.length, 1)
  assert.equal(dialogs[0].answerable, true)
  assert.equal(dialogs[0].startedAt, 3000)

  // 回执：denied 产出（kind/标题取被关卡片，理由取 close 帧原文）
  const receipt = dialogReceiptOf({ type: "dialog_close", dialogId: "dlg-a", reason: "denied", note: "先备份再说" }, dialogs[0], 12345)
  assert.deepEqual(receipt, { dialogId: "dlg-a", kind: "confirm", title: "删库？", note: "先备份再说", at: 12345 })
  // 无理由的 denied 也产出回执（note 缺省）
  assert.deepEqual(dialogReceiptOf({ type: "dialog_close", dialogId: "dlg-a", reason: "denied" }, dialogs[0], 7), {
    dialogId: "dlg-a",
    kind: "confirm",
    title: "删库？",
    at: 7,
  })
  // 其余关闭不留回执：answered / timeout / aborted / 无 reason 的 O1 关闭
  for (const reason of ["answered", "timeout", "aborted", undefined]) {
    assert.equal(dialogReceiptOf({ type: "dialog_close", dialogId: "dlg-a", reason }, dialogs[0], 1), null, `reason=${reason} 不产回执`)
  }
  assert.equal(dialogReceiptOf({ type: "dialog_open", dialogId: "dlg-a" }, dialogs[0], 1), null, "非 close 事件不产回执")
})

test("ext_status fixture（O1）：全量快照归一，坏帧保留上一份", () => {
  const good = {
    type: "ext_status",
    statuses: { branch: "main" },
    widgets: [{ key: "w", lines: ["行"], placement: "belowEditor" }, { key: "f", factory: true }, { bad: 1 }],
    title: "标题",
    working: { visible: true },
    tap: { state: "failed" },
    at: 42,
  }
  const snap = extStatusAfterEvent(null, good)
  assert.deepEqual(snap.statuses, { branch: "main" })
  assert.equal(snap.widgets.length, 2, "坏 widget 条目丢弃")
  assert.equal(snap.tap.state, "failed")
  assert.equal(snap.at, 42)
  assert.equal(extStatusAfterEvent(snap, { type: "ext_status", statuses: "坏" }), snap, "statuses 非对象不覆盖")
  assert.equal(extStatusAfterEvent(snap, { type: "other" }), snap)
})

test("等待时长：秒级 tick，m:ss，超过一小时才带小时", () => {
  assert.equal(formatPromptWait(0), "0:00")
  assert.equal(formatPromptWait(5_000), "0:05")
  assert.equal(formatPromptWait(133_000), "2:13")
  assert.equal(formatPromptWait(3_723_000), "1:02:03")
  assert.equal(formatPromptWait(-1), "0:00")
})

test("弹窗等待接线：状态只在 useRelay，结束/换房/断线清空，composer 栈顶挂载；O2 应答走 onAnswer 通道（第 2 轮 R2-1 更新，挂载口径 F4/B-10 更新）", () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
  const relay = source("../ui/src/relay/useRelay.ts")

  assert.match(relay, /const \[uiPrompt, setUiPrompt\] = useState<UiPrompt \| null>\(null\)/)
  assert.match(relay, /case "ui_prompt_start":[\s\S]{0,220}case "ui_prompt_end":[\s\S]{0,220}setUiPrompt\(\(current\) => uiPromptAfterEvent\(current, event, Date\.now\(\)\)\)/)
  assert.doesNotMatch(relay.slice(relay.indexOf('case "ui_prompt_start"'), relay.indexOf('case "extension_error"')), /setNotice/, "等待条走独立状态，不占通知槽")
  assert.match(relay, /\n\s+uiPrompt,\n/, "Relay 暴露 uiPrompt")

  const clears = (relay.match(/setUiPrompt\(null\)/g) || []).length
  assert.ok(clears >= 6, `换房/清房/断线/离线/切换选择都清空（实际 ${clears} 处）`)



})

test("注意力链路接线（F3 / B-1·B-2·B-3·B-8）：边沿在过滤前记账、回执随房清、计数单一出口、回执在归约内拼", () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
  const relay = source("../ui/src/relay/useRelay.ts")

  // B-1：名册边沿两处喂养（auth_result + room_list）；别房事件记账必须在房间过滤 return 之前
  assert.equal(
    (relay.match(/trackRoomListEdges\(roomTurnTrackerRef\.current, list, roomRef\.current\)/g) || []).length,
    2,
    "auth 与 room_list 都喂名册边沿",
  )
  const edgeAt = relay.indexOf("trackRoomEventEdge(roomTurnTrackerRef")
  const filterAt = relay.indexOf("if (msg.room && msg.room !== roomRef.current) return")
  assert.ok(edgeAt > 0 && filterAt > edgeAt, "别房事件边沿记账在房间过滤丢弃整帧之前")
  assert.match(relay, /trackRoomOfflineEdge\(roomTurnTrackerRef\.current, offlineId\)/, "下线走 offline 边沿（不伪造完成）")
  assert.match(relay, /forgetRoomTurnEnd\(roomTurnTrackerRef\.current, id\)/, "进房即清该房落定记录")
  assert.match(relay, /\n\s+roomTurnEnds,\n/, "Relay 暴露 roomTurnEnds")

  // B-2：回执清理点齐全（clearRoom / subscribe 切房 / onclose 断线 / connect 新连接 / 点选未载入会话）
  const receiptClears = (relay.match(/setDialogReceipts\(\[\]\)/g) || []).length
  assert.ok(receiptClears >= 5, `回执随清房/切房/断线清空（实际 ${receiptClears} 处）`)


  // B-8：dialog 归约内同步推进 dialogsRef，回执从归约前的卡片拼（不靠渲染后 effect 同步时序）
  assert.match(relay, /dialogsRef\.current = nextDialogs/, "归约处同步推进 dialogsRef")
  assert.match(relay, /const receipt = dialogReceiptOf\(event, closed\)/, "回执在归约内拼装")
})

test("注意力恢复通道接线（R3-1）：名册双点喂种子、room_attention 在过滤前处理、合并只走种子入口", () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
  const relay = source("../ui/src/relay/useRelay.ts")

  // 两处名册归约（auth_result + room_list）都在边沿记账之后紧接着消费同一份名册的 relay 摘要
  assert.equal((relay.match(/roomTurnSeedsOf\(msg\.rooms\)/g) || []).length, 2, "auth 与 room_list 都喂名册种子")
  // 种子合并只走 seedRoomTurnEnds 这一个入口函数（不许自造合并）：调用点六处——
  // 两处名册 + room_attention 帧一处 + 收件箱账本三处（D-§1：auth/room_list 的 inbox
  // 快照 + inbox_update 增量，账本 turn 条目同为「只补空缺」的种子，与名册摘要同源同规则）
  assert.equal((relay.match(/seedRoomTurnEnds\(/g) || []).length, 6, "种子合并入口函数唯一，调用点恰六处")
  // room_attention 与 room_offline 同级：必须在房间过滤 return 之前处理（说的正是别房）
  const attentionAt = relay.indexOf('type === "room_attention"')
  const filterAt = relay.indexOf("if (msg.room && msg.room !== roomRef.current) return")
  assert.ok(attentionAt > 0 && filterAt > attentionAt, "room_attention 在房间过滤丢弃整帧之前处理")
  assert.match(relay, /roomAttentionSeedOf\(msg\.room, msg\.lastTurnEnd\)/, "帧载荷先清洗再入追踪器")
  // null（已清）走 forget 路径，与本地进房即清同路
  assert.match(relay, /forgetRoomTurnEnd\(roomTurnTrackerRef\.current, parsed\.roomId\)/, "摘要已清经 forget 落地")
})

// ---------------------------------------------------------------------------
// 完成感知角标（turnEnd → 失焦/隐藏时标题与 favicon，可见后恢复）
// ---------------------------------------------------------------------------

const badgeJiti = createJiti(import.meta.url, { interopDefault: false })
const { badgeTitle, completionBadgeSvg, stripTitleMark, svgDataUri } = await badgeJiti.import(
  "../ui/src/chat/composer/faviconBadge.ts",
)

test("角标标题：成功 ● / 错误 !，先清旧前缀，反复叠加不产生 ● ●", () => {
  assert.equal(badgeTitle("会话 · pi", "done"), "● 会话 · pi")
  assert.equal(badgeTitle("会话 · pi", "error"), "! 会话 · pi")
  assert.equal(badgeTitle("✓ 会话 · pi", "done"), "● 会话 · pi", "去掉 usePageTitle 的后台完成标记")
  assert.equal(badgeTitle("● 会话 · pi", "error"), "! 会话 · pi", "成功/错误互相覆盖")
  assert.equal(badgeTitle(badgeTitle("会话 · pi", "done"), "done"), "● 会话 · pi", "不叠加")
  assert.equal(stripTitleMark("● 会话 · pi"), "会话 · pi")
  assert.equal(stripTitleMark("已断开 · 会话 · pi"), "已断开 · 会话 · pi", "只去最前面的状态标记")
  assert.equal(badgeTitle("", "done"), "● pi", "空标题回落到 pi")
})

test("角标 favicon：保留原始 SVG，完成蓝点、错误红点带 !，颜色可传参，数据 URI 可用（P7 B2g：绿 → 蓝，design I02）", () => {
  const original = readFileSync(new URL("../ui/public/favicon.svg", import.meta.url), "utf8")
  const done = completionBadgeSvg(original, "done")
  assert.ok(done.includes('class="mark"'), "原图路径仍在")
  assert.match(done, /<circle cx="438" cy="438" r="116" fill="#047ABD"/)
  assert.doesNotMatch(done, /M438 366v104/)

  const error = completionBadgeSvg(original, "error")
  assert.match(error, /<circle cx="438" cy="438" r="116" fill="#9C4558"/)
  assert.match(completionBadgeSvg(original, "done", "#123456"), /<circle cx="438" cy="438" r="116" fill="#123456"/, "颜色参数")
  assert.match(error, /M438 366v104/, "红点内白色 ! 竖线")
  assert.match(error, /<circle cx="438" cy="508" r="19" fill="#ffffff"\/>/, "! 的圆点")
  assert.equal(completionBadgeSvg("not an svg", "done"), "not an svg", "原图取不到时不伪造")
  assert.match(svgDataUri(done), /^data:image\/svg\+xml,/)
})

test("完成信号接线：busy true→false 才发，错误可辨识，失焦/隐藏才上角标，可见后写回原件", () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
  const relay = source("../ui/src/relay/useRelay.ts")
  const badge = source("../ui/src/chat/composer/faviconBadge.ts")
  const html = source("../ui/index.html")

  // useRelay：完成信号 + 错误判定 + 换房/离线清空；中断被明确锁掉
  assert.match(relay, /export type TurnEnd = \{ seq: number; at: number; roomId: string; error: boolean \}/)
  assert.match(relay, /const \[turnEnd, setTurnEnd\] = useState<TurnEnd \| null>\(null\)/)
  assert.match(relay, /setTurnEnd\(\{ seq: turnSeqRef\.current, at: Date\.now\(\), roomId: roomRef\.current, error \}\)/)
  assert.match(relay, /export function lastAssistantFailed/)
  assert.match(relay, /item\.stopReason === "error" \|\| !!item\.errorMessage/)
  assert.match(relay, /ended\.stopReason === "aborted"[\s\S]{0,180}turnEmittedRef\.current = true/, "中断不算完成")
  assert.match(relay, /case "agent_settled":[\s\S]{0,120}finishTurn\(\)/)
  assert.match(relay, /case "message_end":[\s\S]{0,900}finishTurn\(ended\.stopReason === "error"/)
  assert.match(relay, /if \(!msg\.busy\) \{[\s\S]{0,140}finishTurn/, "快照/订阅/room_state 的 busy→false 同样收口")
  assert.match(relay, /\n\s+turnEnd,\n/, "Relay 暴露 turnEnd")
  assert.ok((relay.match(/setTurnEnd\(null\)/g) || []).length >= 5, "换房/清房/离线/鉴权失败都清空旧信号")
  // 本地角标：只监听可见性/焦点，不碰 Notification/Audio；恢复写回原始 title/favicon
  assert.match(html, /<link id="app-favicon" rel="icon" type="image\/svg\+xml" href="\/favicon\.svg"/)
  assert.match(badge, /document\.addEventListener\("visibilitychange", update\)/)
  assert.match(badge, /window\.addEventListener\("focus", update\)/)
  assert.match(badge, /window\.addEventListener\("blur", update\)/)
  assert.match(badge, /document\.getElementById\("app-favicon"\)/)
  assert.match(badge, /link\.setAttribute\("href", originalFaviconHref\)/, "恢复写回抓到的原始 href")
  assert.match(badge, /current === lastAppliedRef\.current/, "恢复只覆盖自己最后写的那一版，不把新房间标题回写成旧名")
  assert.match(badge, /stripTitleMark\(document\.title\)/, "叠之前先清掉旧标记")
  assert.match(badge, /new MutationObserver\(apply\)/, "usePageTitle 后续改标题时角标不丢，也不叠加")
  assert.match(badge, /signal\.seq === consumedRef\.current/, "每条完成信号只消费一次，重新失焦不弹旧角标")
  assert.doesNotMatch(badge, /new Notification|Notification\.requestPermission|<audio|AudioContext/, "只做本地角标，不做系统通知/声音")
})

// ---------------------------------------------------------------------------
// P1 §10–§11：Inspector 文件预览（get_file）与主机诊断（get_host_diag）
// P7 B2g：旧 FileViewer.tsx 的归约用例删了（新界面同口径的 filePayloadOf / fileKindOf / fileErrorTextOf 在 test/pi-p5-b.test.mjs）；
// 诊断的纯函数改从 pi/model/hostDiag.ts 引（HostDiagView.tsx 原来就是从那里转出）。
// ---------------------------------------------------------------------------

const inspectorJiti = createJiti(import.meta.url, { interopDefault: false, jsx: true })
const {
  attachStateText,
  formatDiagTimestamp,
  formatHostDiag,
  hostDiagErrorCode,
  hostDiagErrorText,
  normalizeHostDiag,
  redactSecrets,
} = await inspectorJiti.import("../ui/src/pi/model/hostDiag.ts")

const codedError = (code, message = "raw") => Object.assign(new Error(message), { code })



const HOST_DIAG_FIXTURE = {
  piVersion: "0.9.1",
  nodeVersion: "22.18.0",
  platform: "darwin",
  arch: "arm64",
  extensionVersion: "0.4.2",
  attach: { active: true, expiresAt: 1_750_000_000_000, deviceId: "dev-01", token: "attach-secret" },
  recentErrors: [
    { code: "spawn_failed", message: "端口被占用 token=abc123", at: 1_750_000_000_000 },
    "纯文本错误",
    { code: "ignored", message: "  " },
    null,
  ],
  logTail: "boot ok\ntoken=sekret123\nbye",
  token: "viewer-token-secret",
}

test("get_host_diag 归约：只认契约字段，最近错误过滤脏条目，时间统一毫秒", () => {
  const diag = normalizeHostDiag(HOST_DIAG_FIXTURE)
  assert.ok(diag)
  assert.deepEqual(
    [diag.piVersion, diag.nodeVersion, diag.platform, diag.arch, diag.extensionVersion],
    ["0.9.1", "22.18.0", "darwin", "arm64", "0.4.2"],
  )
  assert.deepEqual(diag.attach, { active: true, expiresAt: 1_750_000_000_000, deviceId: "dev-01" })
  assert.equal(diag.recentErrors.length, 2, "空消息/非对象条目被跳过")
  assert.equal(diag.recentErrors[1].message, "纯文本错误")
  assert.match(diag.recentErrors[0].message, /\[redacted\]/)
  assert.doesNotMatch(diag.recentErrors[0].message, /abc123/)
  assert.doesNotMatch(diag.logTail, /sekret123/)
  assert.match(diag.logTail, /token=\[redacted\]/)

  // 秒级时间戳转毫秒；非法值留 null，不编造时间。
  assert.equal(normalizeHostDiag({ ...HOST_DIAG_FIXTURE, attach: { active: false, expiresAt: 1_750_000_000 } }).attach.expiresAt, 1_750_000_000_000)
  assert.equal(normalizeHostDiag({ ...HOST_DIAG_FIXTURE, attach: { active: false, expiresAt: "not-a-date" } }).attach.expiresAt, null)
  assert.equal(normalizeHostDiag({ piVersion: "1", recentErrors: "a\nb" }).recentErrors.length, 2, "字符串错误按行拆分")
  assert.equal(normalizeHostDiag({ piVersion: "1", logTail: ["a", "token=x"] }).logTail, "a\ntoken=[redacted]", "日志数组按行拼接")

  // 最近错误有限额，避免把整个日志塞进面板。
  const many = normalizeHostDiag({ piVersion: "1", recentErrors: Array.from({ length: 25 }, (_, index) => `e${index}`) })
  assert.equal(many.recentErrors.length, 20)

  assert.equal(normalizeHostDiag(null), null)
  assert.equal(normalizeHostDiag("bad"), null)
  assert.equal(normalizeHostDiag({}), null, "空对象按无数据处理")
  const attachOnly = normalizeHostDiag({ attach: { active: false } })
  assert.equal(attachOnly.attach.active, false)
  assert.equal(attachOnly.piVersion, "")
  assert.equal(attachStateText(true), "已连接")
  assert.equal(attachStateText(false), "未连接")
  assert.equal(attachStateText(null), "未知")
})

test("复制诊断：只拼白名单字段；日志/错误里的常见令牌形态被遮罩", () => {
  const diag = normalizeHostDiag(HOST_DIAG_FIXTURE)
  const copy = formatHostDiag(diag)
  assert.match(copy, /^Pi-Remote 主机诊断/)
  assert.match(copy, /Pi：0\.9\.1/)
  assert.match(copy, /Node：22\.18\.0/)
  assert.match(copy, /平台：darwin · arm64/)
  assert.match(copy, /Attach：已连接/)
  assert.match(copy, /最近错误（2）/)
  assert.match(copy, /\[spawn_failed\]/)
  assert.match(copy, /日志尾部：/)
  assert.doesNotMatch(copy, /attach-secret|viewer-token-secret|sekret123|abc123/, "未知 token 字段与日志里的令牌都不能被复制")
  assert.match(copy, /\[redacted\]/)

  assert.equal(formatHostDiag(normalizeHostDiag({ piVersion: "1" })).includes("（空）"), true)
  assert.match(formatDiagTimestamp(null), /^$/)
  assert.match(formatDiagTimestamp(1_750_000_000_000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)

  assert.equal(redactSecrets("Authorization: Bearer abcdefghijklmnop"), "Authorization: Bearer [redacted]")
  assert.equal(redactSecrets("Bearer abcdefghijkl"), "Bearer [redacted]")
  assert.equal(redactSecrets("password: \"hunter2\""), "password: \"[redacted]\"")
  assert.equal(redactSecrets("普通日志"), "普通日志", "不误伤正常日志")

  assert.match(hostDiagErrorText(codedError("unknown_command")), /更新扩展/)
  assert.match(hostDiagErrorText(codedError("unsupported", "当前模式不支持 get_host_diag")), /当前模式不支持/, "后端更具体的原因优先")
  assert.match(hostDiagErrorText(codedError("result_unknown")), /可能已经执行/)
  assert.match(hostDiagErrorText(codedError("device_offline")), /attach/)
  assert.equal(hostDiagErrorText(new Error("服务端原文")), "服务端原文")
  assert.equal(hostDiagErrorCode(codedError("timeout")), "timeout")
})

test("P1 接线：useRelay 暴露 getFile/getHostDiag；Inspector 文件页用真实回包、诊断并入连接页", () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
  const relay = source("../ui/src/relay/useRelay.ts")

  // useRelay：空路径本地拒绝；两条命令都走 runCommand；Relay 类型自动获得两个 API。
  assert.match(relay, /const getFile = useCallback/)
  assert.match(relay, /const getHostDiag = useCallback/)
  assert.match(relay, /if \(!target\) throw new RelayError\("path_required"/)
  assert.match(relay, /runCommand\("get_file", \{ path: target \}\)/)
  assert.match(relay, /runCommand\("get_host_diag"\)/)
  assert.match(relay, /runDeviceCommand\(deviceId, "get_host_diag"\)/, "名册模式按设备寻址，没有活动会话也能诊断")
  assert.match(relay, /\n\s+getFile,\n/)
  assert.match(relay, /\n\s+getHostDiag,\n/)
  // P9 C（spec §5.2）：新增的命令是 list_dirs——只列子目录名和路径，不返回文件、不传文件内容；
  // 仍然不允许「列文件」/「逐文件读取」这类文件枚举 API（数据接口纪律）。
  assert.match(relay, /runDeviceCommand\(deviceId, "list_dirs"/, "P9 C 的 list_dirs 只走设备命令（attach 的 fs.browse）")
  assert.doesNotMatch(relay, /read_dir|listFiles|list_files|readdir/, "没有列文件 API，避免误做成文件列表")




})

/* ---------- P1 §6：远程待发 state fixture / 本地气泡同步 / 不借任务清单视觉 ---------- */

const remoteQueueFixture = {
  type: "remote_queue_state",
  rev: 7,
  items: [
    {
      id: "rq_aaaa00000001",
      segment: "steer",
      source: "web",
      text: "先看 logs，再改 relay",
      images: [{ mimeType: "image/png", bytes: 1024 }],
      status: "pending",
      at: 1000,
      cid: "cid-a",
    },
    {
      id: "rq_bbbb00000002",
      segment: "follow_up",
      source: "web",
      text: "跑完再更新文档",
      images: [],
      status: "injected",
      at: 1001,
      injectedAt: 1002,
    },
    {
      id: "rq_cccc00000003",
      segment: "steer",
      source: "web",
      text: "这条会失败",
      images: [],
      status: "failed",
      at: 1003,
      error: "模型不可用",
      code: "internal",
    },
  ],
}

test("remote_queue_state fixture：整帧解析、pending/injected/failed 与图片元数据", () => {
  const parsed = parseRemoteQueueState(remoteQueueFixture)
  assert.ok(parsed)
  assert.equal(parsed.rev, 7)
  assert.deepEqual(parsed.items.map((item) => item.status), ["pending", "injected", "failed"])
  assert.deepEqual(parsed.items.map((item) => item.segment), ["steer", "follow_up", "steer"])
  assert.deepEqual(parsed.items[0].images, [{ mimeType: "image/png", bytes: 1024 }])
  assert.equal(parsed.items[0].cid, "cid-a")
  assert.equal(parsed.items[2].error, "模型不可用")
  assert.equal(remoteQueuePendingCount(parsed.items), 1)
  assert.equal(canMutateRemoteQueueItem(parsed.items[0]), true)
  assert.equal(canMutateRemoteQueueItem(parsed.items[1]), false)
  assert.equal(canMutateRemoteQueueItem(parsed.items[2]), false)
  assert.equal(remoteQueueSegmentLabel("steer"), "当前回合后")
  assert.equal(remoteQueueSegmentLabel("follow_up"), "等结束后")
  assert.equal(remoteQueueStatusLabel("injected"), "已注入")
  assert.equal(remoteQueueImagesLabel(parsed.items[0].images), "1 张图")
  assert.equal(remoteQueueTextSummary("a\n b   c"), "a b c")
  assert.equal(remoteQueueTextSummary("x".repeat(120), 10), "xxxxxxxxxx…")
})

test("remote_queue_state fixture：坏帧保留上一帧；空 items 清空；非法条目跳过", () => {
  assert.equal(parseRemoteQueueState({ items: "nope" }), null)
  assert.equal(parseRemoteQueueState(null), null)
  const empty = parseRemoteQueueState({ type: "remote_queue_state", rev: -3, items: [] })
  assert.deepEqual(empty, { rev: 0, items: [] })
  const mixed = parseRemoteQueueState({
    rev: 2,
    items: [
      remoteQueueFixture.items[0],
      { id: "bad" },
      { ...remoteQueueFixture.items[1], id: "rq_dup" },
      { ...remoteQueueFixture.items[1], id: "rq_dup" },
    ],
  })
  assert.deepEqual(mixed.items.map((item) => item.id), ["rq_aaaa00000001", "rq_dup"])
})

test("远程队列截断（R3-3 防丢字）：状态帧透传 truncated/textLen；单条回包解析全文形", () => {
  const parsed = parseRemoteQueueState({
    rev: 1,
    items: [
      { id: "rq_t1", segment: "steer", source: "web", text: "长".repeat(4000), images: [], status: "pending", at: 1, truncated: true, textLen: 5001 },
      { id: "rq_t2", segment: "steer", source: "web", text: "短", images: [], status: "pending", at: 2 },
    ],
  })
  assert.equal(parsed.items[0].truncated, true)
  assert.equal(parsed.items[0].textLen, 5001)
  assert.equal(parsed.items[1].truncated, undefined, "未截断条目不带标记")
  // queue_get full 回包：item.truncated=false + 全文，parseRemoteQueueItem 原样收下
  const full = parseRemoteQueueItem({ id: "rq_t1", segment: "steer", source: "web", text: "长".repeat(5001), images: [], status: "pending", at: 1, truncated: false, textLen: 5001 })
  assert.equal(full.text.length, 5001)
  assert.equal(full.truncated, false)
  assert.equal(parseRemoteQueueItem({ nope: 1 }), null)
  assert.equal(parseRemoteQueueItem(null), null)
})

test("排队全文指纹（C-8）：textHash 透传；缓存过期判定只认第三个指纹值（C-2）", () => {
  const withHash = parseRemoteQueueItem({ id: "rq_h", segment: "steer", source: "web", text: "正文", images: [], status: "pending", at: 1, textHash: "abcd1234" })
  assert.equal(withHash.textHash, "abcd1234", "状态帧/回包的全文指纹必须透传到 UI")
  const noHash = parseRemoteQueueItem({ id: "rq_h", segment: "steer", source: "web", text: "正文", images: [], status: "pending", at: 1 })
  assert.equal(noHash.textHash, undefined, "老扩展不带指纹时为 undefined，不编造")

  const item = (textHash) => ({ id: "rq_h", segment: "steer", source: "web", text: "x", images: [], status: "pending", at: 1, textHash })
  const base = { hash: "h2", frameHash: "h1" }
  // 条目消失 → 过期（清缓存）
  assert.equal(queueFullTextCacheStale(undefined, base), true)
  // 帧已跟上我方保存（指纹 == 缓存内容）→ 不过期
  assert.equal(queueFullTextCacheStale(item("h2"), base), false)
  // 帧还停在写入缓存那一刻（我方保存的回帧未到）→ 不过期，不误杀刚回写的缓存
  assert.equal(queueFullTextCacheStale(item("h1"), base), false)
  // 帧指纹变成第三个值 → 他端改过，过期
  assert.equal(queueFullTextCacheStale(item("h3"), base), true)
  // 拉取场景（hash == frameHash）：帧一变即过期
  assert.equal(queueFullTextCacheStale(item("h9"), { hash: "h1", frameHash: "h1" }), true)
  // 任一侧没指纹 → 不判过期（无从比对不假装能判）
  assert.equal(queueFullTextCacheStale(item(undefined), base), false)
  assert.equal(queueFullTextCacheStale(item("h3"), undefined), false)
  assert.equal(queueFullTextCacheStale(item("h3"), { hash: "", frameHash: "" }), false)
})

test("压缩量化（R3-3）：回包两种形态收割；呈现省量与百分比；缺值诚实省略不编造", () => {
  // 命令回包平铺形（cmdCompact 的 { ok, ...CompactionResult }）
  assert.deepEqual(compactionNumbersOf({ ok: true, tokensBefore: 123456, estimatedTokensAfter: 23456 }), { tokensBefore: 123456, estimatedTokensAfter: 23456 })
  // 事件嵌套形（SDK compaction_end.result）
  assert.deepEqual(compactionNumbersOf({ result: { tokensBefore: 1000, estimatedTokensAfter: 400 } }), { tokensBefore: 1000, estimatedTokensAfter: 400 })
  // 缺失/非法 → null，不猜
  assert.equal(compactionNumbersOf({}), null)
  assert.equal(compactionNumbersOf({ tokensBefore: -1 }), null)
  assert.equal(compactionNumbersOf(null), null)
  assert.equal(compactionNumbersOf({ tokensBefore: "很多" }), null)
  assert.equal(compactionResultText(null), "")
  assert.equal(compactionResultText({}), "")
  const text = compactionResultText({ tokensBefore: 123456, estimatedTokensAfter: 23456 })
  assert.equal(text, "已压缩：约 123,456 tokens → 23,456 tokens，省约 100,000 tokens（约 81%）")
  // 只缺一段时只呈有的一段
  assert.equal(compactionResultText({ tokensBefore: 5000 }), "已压缩：压缩前约 5,000 tokens")
  assert.equal(compactionResultText({ estimatedTokensAfter: 800 }), "已压缩：压缩后约 800 tokens")
  // 压后不小于压前时不说"省"
  assert.equal(compactionResultText({ tokensBefore: 100, estimatedTokensAfter: 120 }), "已压缩：约 100 tokens → 120 tokens")
  assert.equal(formatTokenCount(1234567), "1,234,567")
})

test("R3-3 接线：排队卡拉全文钩子、useRelay 暴露 queueFetchFullText/lastCompaction、CompactDialog 量化呈现、侧栏谱系行", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
  const relay = read("../ui/src/relay/useRelay.ts")
  assert.match(relay, /queueFetchFullText/)
  assert.match(relay, /lastCompaction/)
  assert.match(relay, /compactionNumbersOf/)
  assert.match(relay, /queue_edit", \{ id: target, text, \.\.\.\(baseHash \? \{ baseHash \} : \{\}\) \}/, "queueEdit 透传 baseHash（C-8）")
  assert.match(relay, /setLastCompaction\(null\)/, "compaction_start 清零 lastCompaction（C-5）")
})

test("transcript queue-sync：编辑后同步乐观气泡正文，失败状态落成 failed，queue-drop 只撤未送达气泡", () => {
  let s = reduce(emptyTranscript(), { type: "echo", text: "旧正文", cid: "cid-a" })
  assert.equal(s.items[0].text, "旧正文")
  s = reduce(s, {
    type: "queue-sync",
    items: [{ ...remoteQueueFixture.items[0], text: "编辑后的正文", status: "pending" }],
  })
  assert.equal(s.items[0].text, "编辑后的正文")
  assert.equal(s.items[0].echo, "编辑后的正文")
  assert.equal(s.items[0].failed, undefined)
  s = reduce(s, {
    type: "queue-sync",
    items: [{ ...remoteQueueFixture.items[0], text: "编辑后的正文", status: "failed", error: "注入失败" }],
  })
  assert.equal(s.items[0].failed, "注入失败")
  // 已送达的正文不因一次 cancel 命令被删
  s = reduce(s, { type: "delivered", cid: "cid-a" }, { type: "queue-drop", cid: "cid-a" })
  assert.equal(s.items.length, 1)
  assert.equal(s.items[0].status, "delivered")
})




test("远程待发接线：useRelay 消费 remote_queue_state，暴露 queue_get/edit/cancel，事件驱动不前端合成", () => {
  const source = readFileSync(new URL("../ui/src/relay/useRelay.ts", import.meta.url), "utf8")
  assert.match(source, /case "remote_queue_state"/)
  assert.match(source, /parseRemoteQueueState\(event\)/)
  assert.match(source, /dispatch\(\{ type: "queue-sync"/)
  assert.match(source, /"queue_edit"/)
  assert.match(source, /"queue_cancel"/)
  assert.match(source, /"queue_get"/)
  assert.match(source, /queueEdit,/)
  assert.match(source, /queueCancel,/)
  assert.match(source, /remoteQueue,/)
})



/* ---------------------------------------------------------------------------
 * 终端胶囊 / Working 胶囊（纯派生层 + 接线）
 * ------------------------------------------------------------------------- */

const terminalModel = await import("../ui/src/chat/capsules/terminalModel.ts")
const workingModel = await import("../ui/src/chat/capsules/workingModel.ts")
const capsuleFormat = await import("../ui/src/chat/capsules/capsuleFormat.ts")
const {
  TERMINAL_DONE_MS,
  TERMINAL_FAILED_DONE_MS,
  TERMINAL_PREVIEW_LINES,
  TERMINAL_TAIL_LINES,
  TERMINAL_UPDATE_FLUSH_MS,
  applyCarriageReturns,
  applyToolEndMeta,
  holdTerminalItems,
  isTerminalToolName,
  mergeTerminalHistoryItems,
  normalizeTerminalOutput,
  parseToolEndMetaFrame,
  pruneExpiredTerminalItems,
  reduceTerminalEvent,
  reduceTerminalEvents,
  settleTerminalItems,
  shiftTerminalEvent,
  stripAnsi,
  tailTerminalOutput,
  terminalCapsuleView,
  terminalClockOffset,
  terminalDisplayState,
  terminalElapsedMs,
  terminalHistoryItems,
  terminalOutputWindow,
  terminalRetentionMs,
  terminalStateForEnd,
  terminalWindowExpiresAt,
  visibleTerminalItems,
} = terminalModel
const {
  agentActivityLine,
  agentDisplayStatus,
  agentStateAfterEvent,
  parseAgentStateEvent,
  visibleAgentItems,
  workingCapsuleView,
} = workingModel
const { compactCapsuleCount, formatCapsuleElapsed, middleEllipsis } = capsuleFormat

const CAP_NOW = 1_700_000_000_000
const capStart = (id, command = "npm test", extra = {}) => ({
  type: "tool_execution_start",
  toolCallId: id,
  toolName: "bash",
  args: { command },
  startedAt: CAP_NOW,
  ...extra,
})
const capUpdate = (id, text, extra = {}) => ({
  type: "tool_execution_update",
  toolCallId: id,
  toolName: "bash",
  partialResult: { content: [{ type: "text", text }] },
  ...extra,
})
const capEnd = (id, extra = {}) => ({
  type: "tool_execution_end",
  toolCallId: id,
  toolName: "bash",
  isError: false,
  result: { content: [{ type: "text", text: "final" }] },
  endedAt: CAP_NOW + 5000,
  exit_code: 0,
  wall_time_seconds: 5,
  ...extra,
})

test("终端派生：end 状态五路 + 退出码/termStatus 只读结构化字段，不解析文本", () => {
  assert.equal(terminalStateForEnd({ isError: false, exitCode: 0 }), "succeeded")
  assert.equal(terminalStateForEnd({ isError: true, exitCode: 2 }), "failed")
  assert.equal(terminalStateForEnd({ isError: true, termStatus: "timeout" }), "timed_out")
  assert.equal(terminalStateForEnd({ isError: true, termStatus: "aborted" }), "aborted")
  assert.equal(terminalStateForEnd({ isError: false, exitCode: 2 }), "failed", "非零退出码虽非 isError 也归 failed")

  let items = reduceTerminalEvent([], capStart("t1"), CAP_NOW)
  items = reduceTerminalEvent(items, capEnd("t1", { isError: true, exit_code: 2, wall_time_seconds: 4.2, result: { content: [{ type: "text", text: "Command timed out after 5 seconds" }] } }), CAP_NOW + 5000)
  assert.equal(items[0].state, "failed", "文本里的 timed out 不参与判定")
  assert.equal(items[0].exitCode, 2)
  assert.equal(items[0].durationMs, 4200, "wall_time_seconds 秒 → 毫秒")

  items = reduceTerminalEvent([], capStart("t2"), CAP_NOW)
  items = reduceTerminalEvent(items, capEnd("t2", { isError: true, termStatus: "timeout" }), CAP_NOW + 5000)
  assert.equal(items[0].state, "timed_out")

  items = reduceTerminalEvent([], capStart("t3"), CAP_NOW)
  items = reduceTerminalEvent(items, capEnd("t3", { isError: true, termStatus: "aborted", wall_time_seconds: 1 }), CAP_NOW + 5000)
  assert.equal(items[0].state, "aborted")
})

test("终端派生：只认 bash/powershell、按 toolCallId 去重且状态单调", () => {
  assert.equal(isTerminalToolName("bash"), true)
  assert.equal(isTerminalToolName("PowerShell"), true)
  assert.equal(isTerminalToolName("read"), false)
  assert.equal(isTerminalToolName("subagent"), false)

  let items = []
  items = reduceTerminalEvent(items, capStart("a"), CAP_NOW)
  items = reduceTerminalEvent(items, capStart("a", "npm test"), CAP_NOW + 100)
  items = reduceTerminalEvent(items, capStart("b", "rg TODO", { toolName: "powershell" }), CAP_NOW + 200)
  items = reduceTerminalEvent(items, capStart("c", "cat x", { toolName: "read" }), CAP_NOW + 300)
  items = reduceTerminalEvent(items, { type: "tool_execution_start", toolName: "bash", args: { command: "no id" } }, CAP_NOW)
  assert.equal(items.length, 2, "同一 id 只留一条；read 与非 bash 不计入")
  assert.equal(items[0].startedAt, CAP_NOW, "重复 start 不重置耗时锚点")

  items = reduceTerminalEvent(items, capEnd("a"), CAP_NOW + 5000)
  const settled = items
  items = reduceTerminalEvent(items, capUpdate("a", "迟到输出"), CAP_NOW + 6000)
  assert.equal(items, settled, "已结束条目忽略迟到的 running 类 update")
  items = reduceTerminalEvent(items, capStart("a"), CAP_NOW + 7000)
  assert.equal(items, settled, "已结束条目忽略迟到的 start")
  items = reduceTerminalEvent(items, capEnd("a", { isError: true }), CAP_NOW + 8000)
  assert.equal(items, settled, "重复/迟到的权威 end 不覆盖已结束状态")
})

test("终端派生：settled 兜底推定取消，迟到 end 覆盖；批量 update 只留最新累积快照", () => {
  let items = [
    reduceTerminalEvent([], capStart("a"), CAP_NOW)[0],
    reduceTerminalEvent([], capStart("b"), CAP_NOW + 1000)[0],
  ]
  items = reduceTerminalEvents(items, [capUpdate("a", "one"), capUpdate("a", "one\ntwo")], CAP_NOW + 2000)
  assert.equal(items[0].output, "one\ntwo", "后一帧累积快照覆盖前一帧")
  items = settleTerminalItems(items, CAP_NOW + 9000)
  assert.equal(items[0].state, "aborted")
  assert.equal(items[0].inferredEnd, true)
  assert.equal(items[0].durationMs, 9000)
  const inferred = items
  items = reduceTerminalEvent(items, capUpdate("a", "late"), CAP_NOW + 9500)
  assert.equal(items, inferred, "推定结束后仍忽略 update")
  items = reduceTerminalEvent(items, capEnd("a", { isError: true, termStatus: "timeout", exit_code: 9, wall_time_seconds: 10 }), CAP_NOW + 10000)
  assert.equal(items[0].state, "timed_out")
  assert.equal(items[0].inferredEnd, false)
  assert.equal(items[0].exitCode, 9)
  assert.equal(items[0].durationMs, 10000)
})

test("终端派生：ANSI 剥离 + \\r 覆盖本行；尾巴只留最后 200 行并标截断", () => {
  const raw = "\u001b[31mred\u001b[0m\r\n\u001b[2KLine 2\nprogress 10%\rprogress 100%"
  assert.equal(stripAnsi(raw), "red\r\nLine 2\nprogress 10%\rprogress 100%")
  assert.equal(applyCarriageReturns("a\rb\rc"), "c")
  assert.equal(normalizeTerminalOutput(raw), "red\nLine 2\nprogress 100%")
  assert.equal(TERMINAL_TAIL_LINES, 200)

  const text = Array.from({ length: 260 }, (_, index) => `line ${index + 1}`).join("\n")
  const tail = tailTerminalOutput(text)
  assert.equal(tail.lines.length, 200)
  assert.equal(tail.lines[0], "line 61")
  assert.equal(tail.lines[199], "line 260")
  assert.equal(tail.truncated, true)
  assert.equal(tail.text, tail.lines.join("\n"))
  assert.equal(tailTerminalOutput("a\nb").truncated, false)

  let items = reduceTerminalEvent([], capStart("a"), CAP_NOW)
  items = reduceTerminalEvent(items, capUpdate("a", text), CAP_NOW + 1000)
  assert.equal(items[0].output.split("\n").length, 200, "派生层就截到 200 行，DOM 有上限")
  assert.equal(items[0].outputTruncated, true)
})

test("终端 stderr：只认数据层 details/structuredContent，剥 ANSI；合并文本不猜不染", () => {
  let items = reduceTerminalEvent([], capStart("e"), CAP_NOW)
  items = reduceTerminalEvent(
    items,
    capEnd("e", {
      result: {
        content: [{ type: "text", text: "out" }],
        details: { stderr: "\u001b[31mwarn\u001b[0m\nbad" },
      },
    }),
    CAP_NOW + 5000,
  )
  assert.equal(items[0].output, "out", "stdout 仍是 content 文本")
  assert.equal(items[0].stderr, "warn\nbad", "stderr 单独分流并剥 ANSI")

  let mergedOnly = reduceTerminalEvent([], capStart("m"), CAP_NOW)
  mergedOnly = reduceTerminalEvent(
    mergedOnly,
    capEnd("m", { result: { content: [{ type: "text", text: "out\nwarn\nbad" }] } }),
    CAP_NOW + 5000,
  )
  assert.equal(mergedOnly[0].stderr, undefined, "没有明确 stderr 字段就不从合并文本猜")

  let structured = reduceTerminalEvent([], capStart("sc"), CAP_NOW)
  structured = reduceTerminalEvent(
    structured,
    capEnd("sc", { result: { content: [{ type: "text", text: "out" }], structuredContent: { stderr: "structured" } } }),
    CAP_NOW + 5000,
  )
  assert.equal(structured[0].stderr, "structured", "structuredContent 也可带 stderr")
})

test("终端胶囊摘要：运行计数/完成态逐窗 30s（失败 60s）/取消字形/断线 unknown", () => {
  const running = [reduceTerminalEvent([], capStart("a"), CAP_NOW)[0], reduceTerminalEvent([], capStart("b"), CAP_NOW)[0]]
  let view = terminalCapsuleView(running, CAP_NOW + 10_000)
  assert.equal(view.kind, "running")
  assert.equal(view.count, 2)
  assert.equal(view.unknown, false)
  view = terminalCapsuleView(running, CAP_NOW + 10_000, true)
  assert.equal(view.unknown, true)
  assert.equal(terminalDisplayState(running[0], true), "unknown")
  assert.equal(terminalDisplayState(running[0], false), "running")

  let items = reduceTerminalEvent([], capStart("a"), CAP_NOW)
  items = reduceTerminalEvent(items, capEnd("a"), CAP_NOW + 5000)
  assert.equal(terminalCapsuleView(items, CAP_NOW + 5000).kind, "done")
  assert.equal(terminalCapsuleView(items, CAP_NOW + 5000 + TERMINAL_DONE_MS).kind, "done", "30s 边界仍在")
  assert.equal(terminalCapsuleView(items, CAP_NOW + 5000 + TERMINAL_DONE_MS + 1), null, "30s 后窗口消失")
  assert.equal(terminalCapsuleView([], CAP_NOW), null, "0 条不渲染")

  let failed = reduceTerminalEvent([], capStart("f"), CAP_NOW)
  failed = reduceTerminalEvent(failed, capEnd("f", { isError: true, exit_code: 2 }), CAP_NOW + 5000)
  const done = terminalCapsuleView(failed, CAP_NOW + 5000 + 59_000)
  assert.equal(done.kind, "done")
  assert.equal(done.failed, 1)
  assert.equal(done.glyph, "failure")
  assert.equal(terminalCapsuleView(failed, CAP_NOW + 5000 + TERMINAL_FAILED_DONE_MS + 1), null, "含失败停留 60s")

  // 每张已结束窗口按自己的完成态倒计时：成功 30s 先消失，失败窗口留到 60s。
  let successWindow = reduceTerminalEvent([], capStart("s"), CAP_NOW)
  successWindow = reduceTerminalEvent(successWindow, capEnd("s"), CAP_NOW + 5000)
  const mixed = [...successWindow, ...failed]
  assert.equal(terminalRetentionMs(successWindow[0]), TERMINAL_DONE_MS)
  assert.equal(terminalRetentionMs(failed[0]), TERMINAL_FAILED_DONE_MS)
  assert.equal(terminalWindowExpiresAt(successWindow[0]), CAP_NOW + 5000 + TERMINAL_DONE_MS)
  assert.deepEqual(
    visibleTerminalItems(mixed, CAP_NOW + 5000 + TERMINAL_DONE_MS + 1).map((item) => item.id),
    ["f"],
    "成功的窗口到点先走，失败窗口还在",
  )
  const onlyFailed = terminalCapsuleView(mixed, CAP_NOW + 5000 + TERMINAL_DONE_MS + 1)
  assert.equal(onlyFailed.kind, "done")
  assert.equal(onlyFailed.count, 1, "胶囊汇总跟着剩余窗口走")
  assert.equal(onlyFailed.failed, 1)
  assert.equal(terminalCapsuleView(mixed, CAP_NOW + 5000 + TERMINAL_FAILED_DONE_MS + 1), null, "最后一扇也走完才消失")

  let aborted = reduceTerminalEvent([], capStart("x"), CAP_NOW)
  aborted = reduceTerminalEvent(aborted, capEnd("x", { isError: true, termStatus: "aborted" }), CAP_NOW + 5000)
  aborted = terminalCapsuleView(aborted, CAP_NOW + 5000)
  assert.equal(aborted.glyph, "cancel")

  const withHint = terminalCapsuleView([...failed, ...running], CAP_NOW + 9000)
  assert.equal(withHint.kind, "running")
  assert.equal(withHint.count, 3, "胶囊 n 汇总坞里全部可见窗口（2 running + 1 失败）")
  assert.equal(withHint.failed, 1, "运行态保留窗内失败只做 ✕ 静默提示")

  // 旧完成窗口已经滚出后，新终端开始不能把旧窗口“复活”。
  const afterExpiry = reduceTerminalEvent(items, capStart("new", "echo hi", { startedAt: CAP_NOW + 5000 + 31_000 }), CAP_NOW + 5000 + 31_000)
  assert.deepEqual(afterExpiry.map((item) => item.id), ["new"], "过期窗口不随新终端复活")
  const withinWindow = reduceTerminalEvent(items, capStart("new", "echo hi", { startedAt: CAP_NOW + 20_000 }), CAP_NOW + 20_000)
  assert.deepEqual(withinWindow.map((item) => item.id), ["a", "new"], "保留窗内历史条目保留")
})

test("终端派生：条目上限 20，先滚最旧已结束；running 永不滚出", () => {
  let items = []
  for (let index = 0; index < 25; index += 1) {
    const id = `cap-${index}`
    items = reduceTerminalEvent(items, capStart(id, `echo ${index}`, { startedAt: CAP_NOW + index * 100 }), CAP_NOW + index * 100)
    items = reduceTerminalEvent(items, capEnd(id, { endedAt: CAP_NOW + index * 100 + 50 }), CAP_NOW + index * 100 + 50)
  }
  assert.equal(items.length, 20, "结束条目总数封顶 20")
  assert.equal(items[0].id, "cap-5", "最旧的 5 条已结束先滚出")
  assert.equal(items[19].id, "cap-24")

  let running = []
  for (let index = 0; index < 25; index += 1) {
    running = reduceTerminalEvent(running, capStart(`run-${index}`, "sleep 1", { startedAt: CAP_NOW + index * 10 }), CAP_NOW + index * 10)
  }
  assert.equal(running.length, 25, "同时跑 25 个照单全收，running 不滚出")
})

test("终端历史重建：tool_end_meta 补退出码/状态，帧未到不伪造，start/end 幂等合并", () => {
  const metaFrame = (entries) => ({ type: "tool_end_meta", entries })
  assert.equal(parseToolEndMetaFrame({ type: "other", entries: [] }), null, "只认契约帧")
  assert.deepEqual(parseToolEndMetaFrame({ type: "tool_end_meta" }), [], "缺 entries 是合法空帧")
  assert.deepEqual(
    parseToolEndMetaFrame(
      metaFrame([
        { toolCallId: "t1", exitCode: 2, wallTimeSeconds: 4.2, termStatus: "timeout", endedAt: CAP_NOW + 5000, isError: true },
        { toolCallId: "t1", exitCode: 0, endedAt: CAP_NOW },
        { toolCallId: "t2", exit_code: 1, wall_time_seconds: 2 },
        { toolCallId: "", exitCode: 0 },
        { toolCallId: "t3" },
        "bad",
      ]),
    ),
    [
      { toolCallId: "t1", exitCode: 2, wallTimeSeconds: 4.2, termStatus: "timeout", endedAt: CAP_NOW + 5000, isError: true },
      { toolCallId: "t2", exitCode: 1, wallTimeSeconds: 2 },
    ],
    "主字段优先；兼容旧字段；重复/空 id/无结束证据条目跳过",
  )

  const meta = parseToolEndMetaFrame(
    metaFrame([{ toolCallId: "m1", exitCode: 2, wallTimeSeconds: 4.2, termStatus: "timeout", endedAt: CAP_NOW + 5000, isError: true }]),
  )
  // 元数据先到、条目还没出现：只暂存，不凭空造条目。
  assert.deepEqual(applyToolEndMeta([], meta, CAP_NOW + 5000), [], "没有工具条目就不伪造终端")
  let items = reduceTerminalEvent([], capStart("m1"), CAP_NOW)
  items = applyToolEndMeta(items, meta, CAP_NOW + 5000)
  assert.equal(items[0].state, "timed_out")
  assert.equal(items[0].exitCode, 2)
  assert.equal(items[0].durationMs, 4200)
  assert.equal(items[0].endedAt, CAP_NOW + 5000)
  const once = applyToolEndMeta(items, meta, CAP_NOW + 9000)
  assert.equal(once, items, "重复应用同一份元数据保持原引用")

  // 先收到没有退出码的 live end，再补元数据：只补字段并给出权威状态。
  let enriched = reduceTerminalEvent([], capStart("m2"), CAP_NOW)
  enriched = reduceTerminalEvent(enriched, capEnd("m2", { exit_code: undefined, wall_time_seconds: undefined }), CAP_NOW + 5000)
  enriched = applyToolEndMeta(
    enriched,
    parseToolEndMetaFrame(metaFrame([{ toolCallId: "m2", exitCode: 7, wallTimeSeconds: 3, endedAt: CAP_NOW + 5000 }])),
    CAP_NOW + 6000,
  )
  assert.equal(enriched[0].state, "failed")
  assert.equal(enriched[0].exitCode, 7)
  assert.equal(enriched[0].durationMs, 3000)
  assert.equal(enriched[0].output, "final", "补元数据不能覆盖已有输出")
  const enrichedOnce = applyToolEndMeta(
    enriched,
    parseToolEndMetaFrame(metaFrame([{ toolCallId: "m2", exitCode: 7, wallTimeSeconds: 3, endedAt: CAP_NOW + 5000 }])),
    CAP_NOW + 7000,
  )
  assert.equal(enrichedOnce, enriched, "end + 重复元数据幂等")

  // 元数据先结束、live end 后到：live 结果仍要补进输出，不能被“已结束”挡住。
  let metaFirst = reduceTerminalEvent([], capStart("m5"), CAP_NOW)
  metaFirst = applyToolEndMeta(
    metaFirst,
    parseToolEndMetaFrame(metaFrame([{ toolCallId: "m5", exitCode: 0, wallTimeSeconds: 5, endedAt: CAP_NOW + 5000 }])),
    CAP_NOW + 5000,
  )
  assert.equal(metaFirst[0].metaEnded, true)
  metaFirst = reduceTerminalEvent(
    metaFirst,
    capEnd("m5", { result: { content: [{ type: "text", text: "late final" }] } }),
    CAP_NOW + 5100,
  )
  assert.equal(metaFirst[0].output, "late final", "live end 的结果覆盖空输出")
  assert.equal(metaFirst[0].metaEnded, false)

  // 只有 id/endedAt、没有 status：不改 running 状态，也不把“结束”当成成功。
  let neutral = reduceTerminalEvent([], capStart("m3"), CAP_NOW)
  const neutralMeta = parseToolEndMetaFrame(metaFrame([{ toolCallId: "m3", endedAt: CAP_NOW + 1000 }]))
  assert.equal(applyToolEndMeta(neutral, neutralMeta, CAP_NOW + 1500), neutral)

  // 推定结束后迟到元数据：以元数据为准。
  let inferred = settleTerminalItems([reduceTerminalEvent([], capStart("m4"), CAP_NOW)[0]], CAP_NOW + 2000)
  inferred = applyToolEndMeta(
    inferred,
    parseToolEndMetaFrame(metaFrame([{ toolCallId: "m4", termStatus: "aborted", exitCode: 130, endedAt: CAP_NOW + 2000 }])),
    CAP_NOW + 2500,
  )
  assert.equal(inferred[0].state, "aborted")
  assert.equal(inferred[0].inferredEnd, false)

  // transcript 工具块 + 元数据 = 历史条目；非 bash、无元数据、过期历史都不生成。
  const transcript = [
    {
      kind: "assistant",
      blocks: [
        { kind: "tool", id: "h1", name: "bash", input: { command: "npm test" }, outputText: "ok\n", stderr: "\u001b[31mwarn\u001b[0m" },
        { kind: "tool", id: "h2", name: "read", input: { path: "README.md" }, outputText: "noise" },
        { kind: "tool", id: "h3", name: "powershell", input: { command: "dir" }, outputText: "dir" },
        { kind: "tool", id: "old", name: "bash", input: { command: "old" }, outputText: "old" },
      ],
    },
  ]
  const metaMap = new Map([
    ["h1", { toolCallId: "h1", exitCode: 0, wallTimeSeconds: 3, endedAt: CAP_NOW + 5000 }],
    ["h2", { toolCallId: "h2", exitCode: 0, wallTimeSeconds: 1, endedAt: CAP_NOW + 5000 }],
    ["h3", { toolCallId: "h3", exitCode: 2, termStatus: "timeout", endedAt: CAP_NOW + 4000 }],
    ["old", { toolCallId: "old", exitCode: 0, endedAt: CAP_NOW - 120_000 }],
  ])
  assert.deepEqual(terminalHistoryItems(transcript, new Map(), CAP_NOW + 6000), [], "元数据未到不生成历史")
  const history = terminalHistoryItems(transcript, metaMap, CAP_NOW + 6000)
  assert.deepEqual(history.map((item) => item.id), ["h1", "h3"])
  assert.equal(history[0].command, "npm test")
  assert.equal(history[0].durationMs, 3000)
  assert.equal(history[0].startedAt, CAP_NOW + 2000, "用 endedAt - wallTime 推回锚点，不拿当前时刻冒充")
  assert.equal(history[0].output, "ok")
  assert.equal(history[0].stderr, "warn", "transcript 工具块的 stderr 只读带入窗口")
  assert.equal(history[1].state, "timed_out")
  assert.deepEqual(
    terminalHistoryItems(transcript, metaMap, CAP_NOW + 5000 + TERMINAL_DONE_MS + 1).map((item) => item.id),
    ["h3"],
    "历史也逐窗保留：成功 30s 先走，超时窗口 60s 还在",
  )
  assert.equal(terminalHistoryItems(transcript, metaMap, CAP_NOW + 5000 + TERMINAL_FAILED_DONE_MS + 1).length, 0, "过期历史不涌进胶囊")
  let current = reduceTerminalEvent([], capStart("live"), CAP_NOW)
  const merged = mergeTerminalHistoryItems(current, history, CAP_NOW + 6000)
  assert.deepEqual(merged.map((item) => item.id), ["live", "h1", "h3"], "按开始时间排序，缺锚点的历史在后")
  assert.equal(mergeTerminalHistoryItems(merged, history, CAP_NOW + 7000), merged, "历史合并幂等")
})

test("终端胶囊只在命令运行中出现，结束立即消失，不累计完成数", () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
  let items = reduceTerminalEvent([], capStart("live"), CAP_NOW)
  const running = terminalCapsuleView(items, CAP_NOW)
  assert.equal(running.kind, "running")
  assert.equal(running.count, 1)
  items = reduceTerminalEvent(items, capEnd("live"), CAP_NOW + 5000)
  const active = items.filter((item) => item.state === "running")
  assert.equal(active.length, 0, "结束条目不进入胶囊/窗口")
  assert.equal(visibleTerminalItems(active, CAP_NOW + 6000).length, 0)
  assert.equal(terminalCapsuleView(active, CAP_NOW + 6000), null)

})



test("终端输出尾巴：默认最后 10 行，展开才铺到 200 行（240px 内滚动）", () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
  assert.equal(TERMINAL_PREVIEW_LINES, 10)
  const lines = Array.from({ length: 26 }, (_, index) => `line ${index + 1}`)
  assert.deepEqual(terminalOutputWindow(lines, false), lines.slice(-10))
  assert.deepEqual(terminalOutputWindow(lines, true), lines)
  assert.deepEqual(terminalOutputWindow(lines.slice(-10), false), lines.slice(-10), "不足 10 行原样显示")

  const tail = tailTerminalOutput(Array.from({ length: 260 }, (_, index) => `line ${index + 1}`).join("\n"))
  assert.equal(tail.lines.length, 200)
  assert.equal(terminalOutputWindow(tail.lines, true).length, 200, "展开也仍最多 200 行")


})


test("终端时钟偏移：首帧 startedAt/at 校正，走字用校正锚点，已结束按 durationMs 冻结", () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
  const relayStart = capStart("clock", "npm test", { startedAt: CAP_NOW - 5000 })
  const offset = terminalClockOffset(relayStart, CAP_NOW)
  assert.equal(offset, 5000)
  const aligned = shiftTerminalEvent(relayStart, offset)
  assert.equal(aligned.startedAt, CAP_NOW, "事件锚点换成本地时钟")
  assert.equal(relayStart.startedAt, CAP_NOW - 5000, "不原地改事件")

  let items = reduceTerminalEvent([], aligned, CAP_NOW)
  assert.equal(items[0].startedAt, CAP_NOW, "走字锚点用校正后时间")
  assert.equal(terminalElapsedMs(items[0], CAP_NOW + 1500), 1500)
  items = reduceTerminalEvent(
    items,
    shiftTerminalEvent(capEnd("clock", { startedAt: CAP_NOW - 5000, endedAt: CAP_NOW + 5000, wall_time_seconds: 5 }), offset),
    CAP_NOW + 1500,
  )
  assert.equal(items[0].durationMs, 5000)
  assert.equal(terminalElapsedMs(items[0], CAP_NOW + 999_999), 5000, "已结束不再跟着 now 走")

  assert.equal(terminalClockOffset({ type: "tool_execution_start", at: CAP_NOW + 2000 }, CAP_NOW), -2000, "at 优先")
  assert.equal(terminalClockOffset({ type: "tool_execution_start" }, CAP_NOW), null, "无锚点不伪造偏移")
  assert.equal(shiftTerminalEvent(relayStart, 0), relayStart, "零偏移不改引用")

  const relay = source("../ui/src/relay/useRelay.ts")
  assert.match(relay, /terminalClockOffset\(event, now\)/)
  assert.match(relay, /terminalClockOffset\(frame, now\)/, "元数据帧也可做首帧校正")
  assert.match(relay, /shiftTerminalEvent\(/)
  assert.match(relay, /terminalOffsetRef\.current = null/, "换房归零后重新校正")
  assert.match(relay, /case "tool_end_meta":[\s\S]{0,160}consumeToolEndMeta/)
  assert.match(relay, /terminalEndMetaRef/, "元数据先暂存")
  assert.match(relay, /applyToolEndMeta\(next, \[meta\], now\)/, "start/end 后合并")
  assert.match(relay, /terminalHistoryItems\(transcriptRef\.current\.items/)
  assert.match(
    relay,
    /dispatch\(\{ type: "append", messages \}\)[\s\S]{0,160}terminalHistoryPendingRef\.current = true/,
    "增量快照落地后也重建历史（断线期间的 tool 块 + 已到元数据）",
  )
})


test("终端胶囊格式化：m:ss / h:mm:ss、中段省略、紧凑 99+", () => {
  assert.equal(formatCapsuleElapsed(0), "0:00")
  assert.equal(formatCapsuleElapsed(65_000), "1:05")
  assert.equal(formatCapsuleElapsed(3_665_000), "1:01:05")
  assert.equal(middleEllipsis("abcdefghij", 5).startsWith("ab"), true)
  assert.equal(middleEllipsis("abcdefghij", 5).endsWith("ij"), true)
  assert.equal(compactCapsuleCount(100), "99+")
  assert.equal(compactCapsuleCount(3), "3")
  assert.equal(TERMINAL_UPDATE_FLUSH_MS, 250)
})

const agentFrame = (agents) => ({ type: "agent_state", agents })
const agent = (over = {}) => ({
  id: "a1",
  seq: 1,
  name: "Reviewer",
  description: "审查改动",
  task: "检查 relay 缓存",
  status: "running",
  startedAt: CAP_NOW,
  ...over,
})

test("agent_state fixture：整帧替换、坏帧保留、脏条目跳过、depth>1 不渲染", () => {
  assert.deepEqual(parseAgentStateEvent(agentFrame([])), [])
  assert.equal(parseAgentStateEvent({ type: "agent_state" }), null, "缺 agents 是坏帧")
  assert.equal(parseAgentStateEvent({ type: "agent_state", agents: "bad" }), null)
  assert.equal(parseAgentStateEvent({ type: "agent_state", agents: [{ id: "x", status: "doing" }] }), null, "全脏帧不清空")

  let state = [agent()]
  state = agentStateAfterEvent(state, { type: "agent_state" })
  assert.equal(state.length, 1, "坏帧保留上一帧")
  state = agentStateAfterEvent(state, { type: "agent_state", agents: [] })
  assert.deepEqual(state, [], "空数组清空")

  const parsed = parseAgentStateEvent(
    agentFrame([
      agent({ id: "a1", seq: 3, name: "" }),
      agent({ id: "a1", seq: 4 }),
      agent({ id: "deep", depth: 2 }),
      agent({ id: "bad", status: "doing" }),
      agent({ id: "a2", status: "failed", error: "boom\nmore" }),
    ]),
  )
  assert.equal(parsed.length, 2, "重复 id、depth>1、非法状态都跳过")
  assert.equal(parsed[0].name, "Agent 3", "缺 name 回退 Agent {seq}")
  assert.equal(parsed[1].status, "failed")
})

test("Working 胶囊：queued+running 计数、✓/✕ 汇总、done 30s、无数据不渲染", () => {
  const items = [
    agent({ id: "a1", status: "running" }),
    agent({ id: "a2", status: "queued", startedAt: null }),
    agent({ id: "a3", status: "succeeded", endedAt: CAP_NOW + 2000 }),
    agent({ id: "a4", status: "failed", endedAt: CAP_NOW + 3000, error: "exit 2" }),
  ]
  let view = workingCapsuleView(items, CAP_NOW + 4000)
  assert.equal(view.kind, "working")
  assert.equal(view.count, 2, "queued 也算在工")
  assert.equal(view.succeeded, 1)
  assert.equal(view.failed, 1)
  assert.equal(agentDisplayStatus("queued"), "running", "一期 queued 按 running 呈现")
  assert.equal(agentActivityLine(items[3]), "exit 2", "失败条目活动行取 error 首行")

  assert.equal(workingCapsuleView([], CAP_NOW), null, "没有 agent_state 不渲染、不伪造")

  const doneItems = [
    agent({ id: "a1", status: "succeeded", endedAt: CAP_NOW + 1000 }),
    agent({ id: "a2", status: "succeeded", endedAt: CAP_NOW + 2000 }),
  ]
  view = workingCapsuleView(doneItems, CAP_NOW + 2000 + 29_999)
  assert.equal(view.kind, "done")
  assert.equal(view.count, 2)
  assert.equal(view.glyph, "success")
  assert.equal(workingCapsuleView(doneItems, CAP_NOW + 2000 + 30_001), null, "30s 后消失")
  assert.equal(visibleAgentItems(doneItems, CAP_NOW + 2000 + 30_001).length, 0)
  assert.equal(visibleAgentItems([...doneItems, agent({ id: "run" })], CAP_NOW + 999_999).length, 3, "有未结束条目时历史不滚出")

  const failedDone = workingCapsuleView([agent({ id: "f", status: "failed", endedAt: CAP_NOW + 1000 })], CAP_NOW + 1000)
  assert.equal(failedDone.glyph, "failure")
  assert.equal(failedDone.failed, 1)
})

test("胶囊接线：useRelay 消费 tool 三帧与 agent_state，ComposerCard 挂在任务卡下/textarea 上", () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
  const relay = source("../ui/src/relay/useRelay.ts")

  assert.match(relay, /const \[terminalItems, setTerminalItems\] = useState<TerminalItem\[\]>\(\[\]\)/)
  const startAt = relay.indexOf('case "tool_execution_start":')
  const updateAt = relay.indexOf('case "tool_execution_update":')
  assert.ok(startAt > 0 && updateAt > startAt, "工具三帧按 start/update/end 分流")
  assert.ok(relay.indexOf("applyTerminalEventNow(event as TerminalEvent)", startAt) > startAt, "start 立即归约")
  assert.match(relay, /scheduleTerminalUpdate\(event as TerminalEvent\)/, "update 走合并队列")
  assert.match(relay, /setTimeout\(\(\) => \{[\s\S]{0,200}?TERMINAL_UPDATE_FLUSH_MS\)/, "update 250ms 一帧")
  assert.ok(relay.indexOf("applyTerminalEventNow(event as TerminalEvent)", updateAt) > updateAt, "end 立即归约")
  assert.match(relay, /case "agent_settled"[\s\S]{0,500}settleTerminalsNow\(\)/, "settled 兜底")
  assert.match(relay, /case "agent_state":[\s\S]{0,200}setAgentState\(\(current\) => agentStateAfterEvent\(current, event\)\)/)
  assert.match(relay, /event\.type === "agent_start"[\s\S]{0,160}setAgentState\(\(current\) => \(current\.some\(agentIsActive\) \? current : \[\]\)\)/, "Working 完成态到下一回合开始为止")
  assert.match(relay, /\n\s+terminalItems,\n/)
  assert.match(relay, /\n\s+agentState,\n/)
  assert.match(relay, /resetTerminals\(\)[\s\S]{0,100}setAgentState\(\[\]\)/, "换房/清房清空胶囊数据")
})

/* ---- P2：树跳转 summarize 选项 + 未载入会话的文件级操作 ---- */

test("树跳转方式：默认直接跳转；只有明确选择才带 summarize:true", () => {
  assert.equal(DEFAULT_TREE_JUMP_MODE, "direct", "默认按 pi 规格：不总结");
  assert.deepEqual(TREE_JUMP_MODES.map((mode) => mode.id), ["direct", "summarize"]);
  assert.deepEqual(TREE_JUMP_MODES.map((mode) => mode.label), ["直接跳转", "跳转并总结"]);
  assert.deepEqual(treeJumpArgs("direct", "leaf-1"), { targetId: "leaf-1" });
  assert.deepEqual(treeJumpArgs("summarize", "leaf-1"), { targetId: "leaf-1", summarize: true });

})

test("会话菜单：未载入会话开放改名/导出/冷分叉，树/压缩/克隆仍要求活动会话", () => {

  const relay = readFileSync(new URL("../ui/src/relay/useRelay.ts", import.meta.url), "utf8")
  assert.match(relay, /runDeviceCommand\(deviceId, "rename_session_file", \{ sessionPath: target, name: next \}\)/)
  assert.match(relay, /runDeviceCommand\(deviceId, "export_session_file", \{ sessionPath: target, format \}\)/)
  assert.match(relay, /runDeviceCommand\(deviceId, "fork_session_file", \{ sessionPath: target \}\)/)
  assert.match(relay, /if \(!deviceModeRef\.current\) throw new RelayError\("unsupported"/, "旧 relay 明确拒绝而不是假装成功")
  assert.match(relay, /upsertSessionRow\(deviceId, \{ \.\.\.row, name: actual \}\)/, "改名后清单即时更新")
  assert.match(relay, /upsertSessionRow\(deviceId, sessionFileRow\(rec\.session\)\)/, "冷 fork 后新会话即时进列表")
  assert.match(relay, /\n\s+renameSessionFile,\n\s+exportSessionFile,\n\s+forkSessionFile,\n/, "三个入口对外暴露")
})

test("未载入会话对话框：改名/导出/冷 fork 都直接读目标文件，不要求先载入", () => {

  const commands = readFileSync(new URL("../relay/commands.js", import.meta.url), "utf8")
  assert.match(commands, /INACTIVE_SESSION_COMMANDS = new Set\(\["rename_session_file", "export_session_file", "fork_session_file"\]\)/)
  assert.match(commands, /command === "navigate_tree" && args && args\.summarize === true\) return 120000/)
  const viewer = readFileSync(new URL("../relay/viewer.js", import.meta.url), "utf8")
  assert.match(viewer, /INACTIVE_SESSION_COMMANDS\.has\(cmdName\) && DEVICE_COMMANDS\.has\(cmdName\)/, "无活动房间也直达设备")
  // P2-1（spec D8）：先按索引行的 cwd 找同目录在线房间（会话在别的项目时不能交给活动房间）；
  // 查不到索引行 / 那个目录没有在线房间时，退回原来的「活动房间 → 任一在线房间」逻辑。
  assert.match(viewer, /targetRoom = onlineRoomByCwd\(deviceId, row\.cwd, dev\.platform \|\| ""\)/, "P2-1：按索引行 cwd 选同目录房间")
  assert.match(viewer, /const active = dev\.activeRoomId \? rooms\.peek\(dev\.activeRoomId\) : null/, "退回活动房间作为兜底")
  assert.match(viewer, /if \(!local\) \{[\s\S]{0,300}?device_no_active_session/, "没有扩展连接时明确报错，不落到 attach 窗口")
  assert.match(viewer, /runCommand\(ws, msg, targetRoom, local, extra\)/, "inactive 命令交给目标 cwd 的房间连接（P2-1；targetRoom 为空时等价旧行为）")
})
