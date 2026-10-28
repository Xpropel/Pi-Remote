// P5 c 线（p5-lane-c，PLAN 5.5）：composer / 菜单 / 弹窗 / 设置的视图模型（ui/src/pi/model/*）、composerFactsOf（relay/composerFacts.ts），
// 以及 c 区 live fixture 经真实函数算出来的界面（L2 的数字之外再锁一遍口径）。容器的源码契约（不用桩、不碰 pi/dev）也在这里查。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { composerFactsOf, lazyCountsOnline } from "../ui/src/relay/composerFacts.ts"
import { deriveComposer } from "../ui/src/chat/composerMachine.ts"
import { linkView } from "../ui/src/relay/presence.ts"
import { contextReadout } from "../ui/src/relay/contextUsage.ts"
import { parseResourceCommands } from "../ui/src/chat/slashParse.ts"
import { attentionItemsOf } from "../ui/src/relay/attention.ts"
import { composerBlockOf } from "../ui/src/pi/model/composerButton.ts"
import { queueSectionsOf, trayItemsOf } from "../ui/src/pi/model/tray.ts"
import { changesOfSession } from "../ui/src/pi/model/changes.ts"
import { composerViewOf, deliveryOf, PI_OVERLIMIT_NOTE } from "../ui/src/pi/model/composerView.ts"
import { contextWindowLabel, modelExplainerOf, modelPillName, modelRowsOf, thinkingLevelZh, thinkingSegmentsOf, modelContextWindowOf } from "../ui/src/pi/model/models.ts"
import { PI_SLASH_DESC_OVERRIDE, slashBrowseGroupsOf, slashBuiltinRows, slashResourceOf, slashResourceRow } from "../ui/src/pi/model/slashMenu.ts"
import { SLASH_BUILTINS_COPY } from "../ui/src/pi/model/slashBuiltins.ts"
import {
  bytesLabel,
  exportViewOf,
  forkMessagesOf,
  INSPECT_PAGES,
  jsonTextOf,
  sameToolSet,
  sessionStateRowsOf,
  settingsOf,
  systemPromptChars,
  systemPromptViewOf,
  toolRowsOf,
  treeDataOf,
  treeJumpNotice,
  usageStatsOf,
} from "../ui/src/pi/model/dialogsData.ts"
import { folderForDevice, newSessionDefaultsOf, offlineReasonOf, recentFoldersOf, sessionCountsOf, startingText } from "../ui/src/pi/model/newSession.ts"
import { settingsPrefsOf, settingsWritesOf } from "../ui/src/pi/model/settingsView.ts"
import { DEFAULT_PI_PREFS } from "../ui/src/pi/model/prefs.ts"
import { PALETTE_RECENT, PI_PALETTE_COMMANDS, paletteOfflineReasonOf, paletteSessionsOf } from "../ui/src/pi/model/palette.ts"
import { formatHostDiag, HOST_DIAG_EMPTY_TEXT, hostDiagSectionsOf, hostDiagUnavailableOf, hostDiagViewOf, normalizeHostDiag } from "../ui/src/pi/model/hostDiag.ts"
import { PROMPT_RECALL_IDLE, promptHistoryKey, promptRecallAfterDraft, promptRecallStep } from "../ui/src/pi/model/promptRecall.ts"
import { liveRelayOf } from "../ui/src/pi/dev/fixtures/derive.ts"
import { MOCK_NOW } from "../ui/src/pi/dev/fixtures/types.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8")
/** 去掉 /* *\/ 和 // 注释 */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
const LIVE = path.join(ROOT, "ui/src/pi/dev/fixtures/live")
async function load(id) {
  const fx = (await import(pathToFileURL(path.join(LIVE, `${id}.ts`)).href)).default
  return { fx, relay: liveRelayOf(fx) }
}
const FACTS = {
  draft: "",
  authed: true,
  browserOnline: true,
  roomId: "r-1",
  online: true,
  deviceMode: true,
  selectedDevice: { name: "MacBook Pro", online: true },
  lazySession: null,
  busy: false,
  sendMode: "auto",
  sending: false,
  failurePulse: false,
  lastFailure: null,
  pendingImages: 0,
  pendingFiles: 0,
}
const stateOf = (patch) => deriveComposer(composerFactsOf({ ...FACTS, ...patch })).state

/* ---------------- composerFactsOf（brief 16:45 未载入会话） ---------------- */

describe("composerFactsOf：useRelay 与 fixture 共用的输入卡事实", () => {
  test("在线 / 有草稿：S0 / S1；忙时有草稿 S4；没选会话时 link 不算离线", () => {
    assert.equal(stateOf({}), "S0")
    assert.equal(stateOf({ draft: "hi" }), "S1")
    assert.equal(stateOf({ draft: "hi", busy: true }), "S4")
    assert.equal(composerFactsOf({ ...FACTS, roomId: "", online: false }).online, true)
  })
  test("未载入会话（lazySession = 当前 roomId）、设备在线：按在线算 → S1（发第一条走 lazySend，不进 outbox）", () => {
    const lazy = { roomId: "s7", online: false, lazySession: { id: "s7" }, draft: "先灰度一台" }
    assert.equal(lazyCountsOnline({ ...FACTS, ...lazy }), true)
    assert.equal(stateOf(lazy), "S1")
    assert.equal(deriveComposer(composerFactsOf({ ...FACTS, ...lazy })).sendKind, "send")
  })
  test("未载入但设备离线 → S5；lazySession 不是当前房间 → 不算在线", () => {
    assert.equal(stateOf({ roomId: "s7", online: false, lazySession: { id: "s7" }, draft: "x", selectedDevice: { name: "ThinkPad", online: false } }), "S5")
    assert.equal(lazyCountsOnline({ ...FACTS, roomId: "s8", lazySession: { id: "s7" } }), false)
    assert.equal(stateOf({ roomId: "s8", online: false, lazySession: { id: "s7" }, draft: "x" }), "S5")
  })
  test("浏览器断网 / 没鉴权：S5（离线待发）；设备名、附件数照传", () => {
    assert.equal(stateOf({ browserOnline: false, draft: "x" }), "S5")
    assert.equal(stateOf({ authed: false, draft: "x" }), "S5")
    const facts = composerFactsOf({ ...FACTS, pendingImages: 2, pendingFiles: 1 })
    assert.deepEqual(facts.attachments, { count: 2 })
    assert.equal(facts.deviceName, "MacBook Pro")
    assert.equal(facts.pendingFiles, 1)
    assert.equal(composerFactsOf({ ...FACTS, deviceMode: false }).deviceOnline, undefined)
  })
})

/* ---------------- composerViewOf（占位、原因、状态行） ---------------- */

const OK = { kind: "ok" }
const view = (patch) => composerViewOf({ state: "S0", blockedBy: null, link: OK, device: { name: "MacBook Pro", online: true }, loaded: true, busy: false, ...patch })

describe("composerViewOf：四种短占位 + 原因进状态行（D14）", () => {
  test("默认：继续追问… · 设备 · 分支", () => {
    const v = view({ branch: "main" })
    assert.equal(v.placeholder, "继续追问…")
    assert.deepEqual(v.status, { device: "MacBook Pro", branch: "main" })
  })
  test("断开：写好先排队 + 未连接服务器 · 发送会排队（warn、live false，设备照写）", () => {
    const v = view({ link: { kind: "reconnecting" }, branch: "main" })
    assert.equal(v.placeholder, "写好先排队")
    assert.equal(v.status.note, "未连接服务器 · 发送会排队")
    assert.equal(v.status.tone, "warn")
    assert.equal(v.status.live, false)
    assert.equal(v.status.device, "MacBook Pro")
  })
  test("设备离线：<设备> 未连接 · 上线后发送，不重复写设备、分支", () => {
    const v = view({ device: { name: "ThinkPad", online: false }, branch: "main" })
    assert.equal(v.placeholder, "写好先排队")
    assert.equal(v.status.note, "ThinkPad 未连接 · 上线后发送")
    assert.equal(v.status.device, undefined)
    assert.equal(v.status.branch, undefined)
  })
  test("未载入：发送时载入 + <设备> · 未载入，发第一条时载入（default）", () => {
    const v = view({ loaded: false })
    assert.equal(v.placeholder, "发送时载入")
    assert.equal(v.status.note, "MacBook Pro · 未载入，发第一条时载入")
    assert.equal(v.status.tone, "default")
  })
  test("审批禁用：输入已禁用 + 先回答上面的问题（warn），不出投递选择器 / Spinner；S7 撤销写撤销原因", () => {
    const v = view({ state: "S3", blockedBy: "approval", busy: true, branch: "main" })
    assert.equal(v.placeholder, "输入已禁用")
    assert.equal(v.status.note, "先回答上面的问题")
    assert.equal(v.status.delivery, undefined)
    assert.equal(v.status.running, undefined)
    assert.equal(v.status.branch, "main", "设备 · 分支照写（design b/approval-waiting）")
    assert.equal(view({ state: "S7", blockReason: "revoked" }).status.note, "这台设备已被撤销 · 到设置里重新配对")
  })
  test("运行中出投递选择器（auto / steer = 插入当前回合，follow_up = 等这轮结束）", () => {
    assert.equal(view({ busy: true, sendMode: "auto" }).status.delivery, "steer")
    assert.equal(view({ busy: true, sendMode: "follow_up" }).status.delivery, "follow_up")
    assert.equal(view({}).status.delivery, undefined)
    assert.equal(deliveryOf("steer"), "steer")
  })
  test("上下文：只在窗口可信时给百分点；超长红字；extra 原样（截断由状态行做）；慢 ack 发送中…", () => {
    assert.deepEqual(view({ context: contextReadout({ tokens: 150000, contextWindow: 200000 }) }).status.context, { percent: 75, trusted: true })
    assert.equal(view({ context: contextReadout({ tokens: 61800 }) }).status.context, undefined)
    assert.equal(view({ overLimit: true }).status.note, PI_OVERLIMIT_NOTE)
    assert.equal(view({ overLimit: true }).status.tone, "error")
    assert.deepEqual(view({ extra: [" lint ok ", "", "tests 12/12"] }).status.extra, ["lint ok", "tests 12/12"])
    assert.equal(view({ state: "S2", slowAck: true }).status.note, "发送中…")
  })
})

/* ---------------- 模型菜单（G12 costNoteOf、中文档位） ---------------- */

describe("models：get_available_models / thinking levels → 菜单", () => {
  test("model-menu fixture：全部 models 按回包顺序，未配置标出，当前 ✓，规格、费用说明", async () => {
    const { relay } = await load("model-menu")
    const rows = modelRowsOf(await relay.runCommand("get_available_models"), relay)
    assert.deepEqual(rows.map((r) => r.name), ["Claude Sonnet 4.5", "Claude Opus 4.1", "GPT-5", "Gemini 2.5 Pro", "DeepSeek V3.1", "Qwen3 Coder"])
    assert.deepEqual(rows.filter((r) => r.current).map((r) => r.key), ["anthropic/claude-sonnet-4-5"])
    assert.deepEqual(rows.filter((r) => r.unconfigured).map((r) => r.key), ["qwen/qwen3-coder"])
    assert.deepEqual(rows.map((r) => r.spec), ["200k · 可发图片", "200k · 可发图片", "400k · 可发图片", "1M · 可发图片", "128k", "262k"])
    assert.equal(rows.find((r) => r.modelId === "gemini-2.5-pro").costNote, "输入超过 200k 时单价翻倍")
    assert.equal(rows.filter((r) => r.costNote).length, 1, "没有 tiers 的模型不写费用说明")
    const segments = thinkingSegmentsOf(await relay.runCommand("get_available_thinking_levels"))
    assert.deepEqual(segments.map((s) => s.label), ["关", "最少", "低", "中", "高"])
    assert.equal(modelPillName(relay), "Sonnet 4.5")
  })
  test("说明卡：标题、窗口、费用拆两行、provider/modelId；没有说明不出费用段", () => {
    const row = { key: "google/gemini-2.5-pro", provider: "google", modelId: "gemini-2.5-pro", name: "Gemini 2.5 Pro", spec: "1M", costNote: "输入超过 200k 时单价翻倍" }
    assert.deepEqual(modelExplainerOf(row, 1000000), { title: "Gemini 2.5 Pro", tagline: [], context: "上下文窗口 1M", cost: ["输入超过 200k 时", "单价翻倍"], version: ["google/gemini-2.5-pro"] })
    assert.equal(modelExplainerOf({ ...row, costNote: undefined }, null).cost, undefined)
    assert.equal(modelContextWindowOf({ models: [{ provider: "google", id: "gemini-2.5-pro", contextWindow: 1000000 }] }, "google/gemini-2.5-pro"), 1000000)
  })
  test("lane-real F-R3：已配置的排前面，未配置的接后面（各自保持回包顺序）", () => {
    const models = [{ provider: "x", id: "u1" }, { provider: "s", id: "a" }, { provider: "x", id: "u2" }, { provider: "s", id: "b" }]
    const rows = modelRowsOf({ models, available: [models[1], models[3]] }, { modelMeta: { provider: "s", modelId: "b" } })
    assert.deepEqual(rows.map((r) => [r.key, !!r.unconfigured, !!r.current]), [["s/a", false, false], ["s/b", false, true], ["x/u1", true, false], ["x/u2", true, false]])
  })
  test("只有一张表 / 坏条目 / 当前模型按名字认；档位不认识原样", () => {
    const rows = modelRowsOf({ available: [{ provider: "a", id: "m1", name: "M1" }, { provider: 3 }, { provider: "a" }] }, { model: "M1" })
    assert.deepEqual(rows.map((r) => [r.key, !!r.current, !!r.unconfigured]), [["a/m1", true, false]])
    assert.equal(thinkingLevelZh("ultra"), "ultra")
    assert.equal(contextWindowLabel(1048576), "1.05M")
    assert.equal(modelPillName({ model: "" }), null)
  })
})

/* ---------------- 斜杠菜单 ---------------- */

describe("slashMenu：常用 / 内置 / 本机资源", () => {
  test("内置清单 = chat/slashCommands.ts 的 COMMANDS（19 条，key / name / desc 逐条一致；P7 B2e 挪成纯数据后不再有副本）", async () => {
    const { COMMANDS } = await import("../ui/src/chat/slashCommands.ts")
    assert.equal(COMMANDS.length, 19)
    assert.deepEqual(SLASH_BUILTINS_COPY, COMMANDS.map(({ key, name, desc }) => ({ key, name, desc })))
    assert.deepEqual(SLASH_BUILTINS_COPY.map((r) => r.key), ["model", "thinking", "name", "compact", "regenerate", "session", "copy", "settings", "system", "follow", "new", "resume", "fork", "clone", "tree", "stats", "usage", "tools", "commands"])
  })

  test("slash-menu fixture：没有本机计数时没有常用组；资源命令说明照 resourceRow；/commands 说明改成命令面板", async () => {
    const { relay } = await load("slash-menu")
    const resources = parseResourceCommands(await relay.runCommand("get_commands"))
    const groups = slashBrowseGroupsOf(slashBuiltinRows(SLASH_BUILTINS_COPY), resources, [])
    assert.deepEqual(groups.map((g) => g.title), ["内置", "本机资源"])
    assert.equal(groups[0].rows.length, 19)
    assert.equal(groups[0].rows.find((r) => r.key === "commands").desc, PI_SLASH_DESC_OVERRIDE.commands)
    assert.deepEqual(groups[1].rows.map((r) => `${r.name} ${r.desc}`), ["/review-pr 执行 · 模板 · 按团队清单审一遍改动", "/release-notes 执行 · 技能 · 从提交记录整理发布说明"])
    assert.equal(slashResourceOf(resources, "resource:review-pr").name, "review-pr")
    assert.equal(slashResourceOf(resources, "compact"), null)
  })
  test("有计数：常用组（design：/compact /model /fork）排最前，从内置组摘走", () => {
    const groups = slashBrowseGroupsOf(slashBuiltinRows(SLASH_BUILTINS_COPY), [], ["/compact", "/model", "/fork"])
    assert.deepEqual(groups.map((g) => [g.title, g.rows.length]), [["常用", 3], ["内置", 16]])
    assert.deepEqual(groups[0].rows.map((r) => r.name), ["/compact", "/model", "/fork"])
    assert.equal(slashResourceRow({ name: "x", description: "", source: "weird", executable: false }).desc, "不可执行 · weird")
  })
})

/* ---------------- tray / 排队面板（fixture） ---------------- */

describe("tray 与排队面板：c 区 fixture", () => {
  test("queue-panel：任务 2/4 → 排队 2 → 终端 1 → 改动；面板两段（网页发的 / 终端里排的 · 只读）", async () => {
    const { relay } = await load("queue-panel")
    const tray = trayItemsOf({
      taskList: relay.taskList,
      remoteQueue: relay.remoteQueue.items,
      localQueue: relay.queue,
      outbox: relay.outbox,
      terminals: relay.terminalItems,
      changes: changesOfSession(relay.transcript.items),
      linkOk: true,
      deviceOnline: true,
    })
    assert.deepEqual(tray.map((t) => t.label.split(" ")[0] + " " + t.label.split(" ")[1]), ["任务 2/4", "排队 2", "终端 1", "改动 +32"])
    const sections = queueSectionsOf(relay.remoteQueue.items, relay.queue, relay.outbox, true, true)
    assert.deepEqual(sections.map((s) => s.title), ["网页发的", "终端里排的 · 只读"])
  })
  test("断线时有 outbox：第一段「本页待发 · 等重连」，pill「排队 N · 等重连」", async () => {
    const { fx } = await load("queue-panel")
    const relay = liveRelayOf({ ...fx, outbox: [{ cid: "c-1", text: "先别动 shell.css", status: "queued" }, { cid: "c-2", text: "补测试", status: "failed" }] })
    const sections = queueSectionsOf(relay.remoteQueue.items, relay.queue, relay.outbox, false, true)
    assert.equal(sections[0].title, "本页待发 · 等重连")
    assert.deepEqual(sections[0].items.map((i) => i.status), ["queued", "failed"])
    const tray = trayItemsOf({ remoteQueue: relay.remoteQueue.items, localQueue: relay.queue, outbox: relay.outbox, linkOk: false, deviceOnline: true })
    assert.equal(tray.find((t) => t.kind === "queue").label, "排队 4 · 等重连")
  })
  test("b/approval-waiting（PLAN 5.5 验证）：S3、blockedBy approval → 占位「输入已禁用」、状态行「先回答上面的问题」、黑圆钮仍是停止", async () => {
    const { fx, relay } = await load("approval-waiting")
    assert.equal(relay.composer.state, "S3")
    const block = composerBlockOf(relay.composer.state, "approval")
    assert.equal(block.button.variant, "stop")
    assert.equal(block.readOnly, true)
    const v = composerViewOf({
      state: relay.composer.state,
      blockedBy: "approval",
      link: linkView(relay, fx.now),
      device: { name: relay.selectedDevice.name, online: relay.selectedDevice.online },
      loaded: true,
      busy: relay.busy,
      sendMode: relay.sendMode,
    })
    assert.equal(v.placeholder, "输入已禁用")
    assert.equal(v.status.note, "先回答上面的问题")
    assert.equal(v.status.tone, "warn")
  })
})

/* ---------------- 弹窗家族的取数解析 ---------------- */

describe("dialogsData：弹窗家族（G03–G18）", () => {
  test("用量：dialog-usage fixture 的 get_session_stats → 48 = 你 8 + pi 20 + 工具结果 20；缺一项整组 null", async () => {
    const { relay } = await load("dialog-usage")
    assert.deepEqual(usageStatsOf(await relay.runCommand("get_session_stats")), { userMessages: 8, assistantMessages: 20, toolCalls: 20, toolResults: 20, totalMessages: 48 })
    assert.equal(usageStatsOf({ userMessages: 1 }), null)
    assert.equal(usageStatsOf(null), null)
  })
  test("当前状态：get_state → 键值行（模型名、消息数、运行态）；回包不是对象时运行态空", () => {
    const rows = Object.fromEntries(sessionStateRowsOf({ sessionName: "a", model: { name: "Claude Sonnet 4.5" }, messageCount: 1200, isStreaming: true, hasUI: false, mode: "rpc" }))
    assert.equal(rows["模型"], "Claude Sonnet 4.5")
    assert.equal(rows["消息数"], (1200).toLocaleString("zh-CN"))
    assert.equal(rows["运行态"], "输出中")
    assert.equal(rows["mode · hasUI"], "rpc · 无界面")
    assert.equal(Object.fromEntries(sessionStateRowsOf(null))["运行态"], "")
  })
  test("系统提示词：全文 / 截断（字数用 chars）/ 不支持写原因", () => {
    assert.equal(systemPromptChars(systemPromptViewOf({ prompt: "你好世界" })), 4)
    const cut = systemPromptViewOf({ prompt: "abc", truncated: true, chars: 9000 })
    assert.equal(systemPromptChars(cut), 9000)
    assert.deepEqual(systemPromptViewOf({ supported: false }), { kind: "reason", text: "当前会话不支持读取系统提示词" })
    assert.deepEqual(systemPromptViewOf(null), { kind: "reason", text: "没有返回系统提示词" })
  })
  test("工具：全表 + 已启用（全表没有的补在后面）；全表拿不到 = fallback；集合比较不看顺序", () => {
    const v = toolRowsOf({ tools: ["read", "extra"] }, { tools: [{ name: "read", description: "Read  a   file" }, "bash"] })
    assert.deepEqual(v.rows, [{ name: "read", description: "Read a file" }, { name: "bash" }, { name: "extra" }])
    assert.deepEqual(v.enabled, ["read", "extra"])
    assert.equal(v.fallback, false)
    assert.equal(toolRowsOf({ tools: ["read"] }, null).fallback, true)
    assert.equal(sameToolSet(["a", "b"], ["b", "a"]), true)
    assert.equal(sameToolSet(["a"], ["a", "b"]), false)
  })
  test("分叉 / 导出 / 树 / 设置 / 检视", () => {
    assert.deepEqual(forkMessagesOf({ messages: [{ entryId: "e1", text: "a\n  b" }, { text: "无 id" }] }), [{ id: "e1", text: "a b" }])
    assert.deepEqual(exportViewOf({ text: "x", truncated: true, chars: 10, bytes: 3 }), { text: "x", truncated: true, chars: 10, bytes: 3 })
    assert.equal(bytesLabel(512 * 1024), "512 KB")
    assert.deepEqual(treeDataOf({ tree: [], leafId: 7 }), { tree: [], leafId: "7" })
    assert.equal(treeJumpNotice({ summary: true }, true), "已总结离开的分支并跳到所选节点")
    assert.equal(treeJumpNotice({ noop: true }, false), "已跳到所选节点")
    assert.deepEqual(settingsOf({ settings: { a: 1 } }), { a: 1 })
    assert.equal(jsonTextOf({ s: "x".repeat(200_001) }).clipped, true)
    assert.equal(INSPECT_PAGES.length, 10)
  })
})

/* ---------------- 新建会话、设置、显示选项、命令面板 ---------------- */

describe("新建会话：预选设备和目录（M-04）、最近目录、启动说明", () => {
  test("new-session fixture：预选 MacBook Pro + pi-remote；最近 = pi-remote、notes-app（只留允许的目录）", async () => {
    const { relay } = await load("new-session")
    const pick = newSessionDefaultsOf({ devices: relay.devices, rooms: relay.rooms, sessionsByDevice: relay.sessionsByDevice, selectedDeviceId: relay.selectedDeviceId })
    assert.deepEqual(pick, { deviceId: "d-mbp", folder: "/Users/dev/code/pi-remote" })
    const mbp = relay.devices.find((d) => d.id === "d-mbp")
    assert.deepEqual(recentFoldersOf(relay.sessionsByDevice["d-mbp"], mbp.projects), ["/Users/dev/code/pi-remote", "/Users/dev/code/notes-app"])
    assert.deepEqual(sessionCountsOf(relay.sessionsByDevice, relay.devices), { "d-mbp": 13, "d-studio": 3, "d-win": 1 })
  })
  test("选中的设备离线：换成最近有活动的在线设备；换设备时目录不在允许范围就换成第一个", async () => {
    const { relay } = await load("new-session")
    const pick = newSessionDefaultsOf({ devices: relay.devices, rooms: relay.rooms, sessionsByDevice: relay.sessionsByDevice, selectedDeviceId: "d-win" })
    assert.notEqual(pick.deviceId, "d-win")
    const studio = relay.devices.find((d) => d.id === "d-studio")
    assert.equal(folderForDevice(studio, "/Users/dev/code/pi-remote"), "/Users/dev/work/billing-service")
    assert.equal(folderForDevice(studio, "/Users/dev/work/infra"), "/Users/dev/work/infra")
    assert.equal(startingText("MacBook Pro", MOCK_NOW - 12_400, MOCK_NOW), "正在 MacBook Pro 上启动 pi… 12s")
    assert.equal(startingText("MacBook Pro", MOCK_NOW, MOCK_NOW), "正在 MacBook Pro 上启动 pi…")
    assert.equal(offlineReasonOf("ThinkPad"), "ThinkPad 未连接 · 上线后才能新建会话")
  })
})

describe("设置 / 显示选项：偏好读写口径（三项读旧键、两边一起写）", () => {
  test("读：主题 / 密度 / 分组来自新偏好；提示音、网页回答、立即发送读旧键；投递读 relay.sendMode", () => {
    const p = settingsPrefsOf({ ...DEFAULT_PI_PREFS, deviceFilter: "d-mbp" }, { completionSound: true, dialogRemoteAnswer: true, queueSend: "steer" }, "follow_up")
    assert.deepEqual(p, {
      ui: "cursor",
      theme: "system",
      fontSize: "standard",
      density: "balanced",
      busyDelivery: "follow_up",
      sendNow: "after_tool",
      dialogRemote: true,
      sound: true,
      deviceFilter: "d-mbp",
      grouping: "device",
    })
    assert.equal(settingsPrefsOf(DEFAULT_PI_PREFS, {}, "auto").deviceFilter, "all")
    assert.equal(settingsPrefsOf(DEFAULT_PI_PREFS, {}, "auto").busyDelivery, "steer")
  })
  test("写：提示音 / 网页回答 = 新偏好 + 旧键；立即发送只写旧键；投递 = 偏好 + sendMode；全部设备 = null；字号没有落点", () => {
    assert.deepEqual(settingsWritesOf({ sound: true }), [
      { kind: "pref", key: "completionSound", value: true },
      { kind: "legacy", patch: { completionSound: true } },
    ])
    assert.deepEqual(settingsWritesOf({ sendNow: "after_tool" }), [{ kind: "legacy", patch: { queueSend: "steer" } }])
    assert.deepEqual(settingsWritesOf({ busyDelivery: "follow_up" }), [
      { kind: "pref", key: "delivery", value: "follow_up" },
      { kind: "sendMode", value: "follow_up" },
    ])
    assert.deepEqual(settingsWritesOf({ deviceFilter: "all" }), [{ kind: "pref", key: "deviceFilter", value: null }])
    assert.deepEqual(settingsWritesOf({ fontSize: "large" }), [])
    assert.deepEqual(settingsWritesOf({ dialogRemote: false }).map((w) => w.kind), ["pref", "legacy"])
  })
})

describe("命令面板：命令组、会话组（当前会话排第一 + 最近）、离线原因", () => {
  test("command-palette fixture：前 4 个 = r-s1（当前）、r-s2、r-s3、r-s4，组名「设备名/目录名」，标记照真实注意力", async () => {
    const { relay } = await load("command-palette")
    const attention = attentionItemsOf({
      currentRoomId: relay.roomId,
      rooms: relay.rooms,
      dialogs: relay.dialogs,
      uiPrompt: relay.uiPrompt,
      turnEnd: relay.turnEnd,
      roomTurnEnds: relay.roomTurnEnds,
      selectedDevice: relay.selectedDevice,
    })
    const sessions = paletteSessionsOf({ devices: relay.devices, rooms: relay.rooms, sessionsByDevice: relay.sessionsByDevice, attention, currentRoomId: relay.roomId })
    const top = sessions.slice(0, PALETTE_RECENT)
    assert.deepEqual(top.map((s) => s.id), ["r-s1", "r-s2", "r-s3", "r-s4"])
    assert.deepEqual(top.map((s) => s.group), ["MacBook Pro/pi-remote", "MacBook Pro/pi-remote", "MacBook Pro/pi-remote", "MacBook Pro/pi-remote"])
    // r-s2 运行中、r-s4 完成未读（roomTurnEnds）；r-s3 的「等你回答」relay 拿不到（缺口 G1）
    assert.deepEqual(top.map((s) => s.marker), ["idle", "running", "idle", "unread"])
    assert.equal(sessions.length, 17)
    assert.deepEqual(PI_PALETTE_COMMANDS.map((c) => c.key), ["new", "sidebar", "pane", "compact", "regenerate", "tree", "usage", "inspect", "settings"])
  })
  test("离线原因：服务器 / 没选会话 / 未载入 / 设备离线；都好时 null", () => {
    const ok = { authed: true, browserOnline: true, roomId: "r", online: true, loaded: true, deviceName: "MacBook Pro" }
    assert.equal(paletteOfflineReasonOf(ok), null)
    assert.equal(paletteOfflineReasonOf({ ...ok, browserOnline: false }), "未连接服务器 · 会话命令暂时不能用")
    assert.equal(paletteOfflineReasonOf({ ...ok, roomId: "" }), "先选一个会话 · 会话命令要在会话里用")
    assert.equal(paletteOfflineReasonOf({ ...ok, loaded: false }), "会话还没载入 · 发第一条之后才能用会话命令")
    assert.equal(paletteOfflineReasonOf({ ...ok, online: false }), "MacBook Pro 未连接 · 会话命令暂时不能用")
  })
})

/* ---------------- 源码契约 ---------------- */

describe("c 线容器的源码契约", () => {
  const C_CONTAINERS = ["ComposerContainer", "NewSessionContainer", "CommandPaletteContainer", "DialogsContainer", "SettingsContainer", "DisplayOptionsContainer"]
  test("c 线容器不再引用 PiStub；产品源码里没有 pi/dev/、MOCK_ 字样", () => {
    for (const name of C_CONTAINERS) {
      const src = read(`ui/src/pi/containers/${name}.tsx`)
      assert.ok(!/PiStub|from "\.\/stub"/.test(code(src)), `${name} 还在用桩`)
      assert.ok(!/pi\/dev\/|MOCK_/.test(src), `${name} 引用了开发画廊`)
    }
    for (const file of ["models", "slashMenu", "slashBuiltins", "composerView", "dialogsData", "newSession", "settingsView", "palette"]) {
      assert.ok(!/pi\/dev\/|MOCK_/.test(read(`ui/src/pi/model/${file}.ts`)), file)
    }
    assert.ok(!/pi\/dev\/|MOCK_/.test(read("ui/src/pi/containers/cShared.ts")), "cShared")
  })
  test("12 个新弹窗不再是桩（都画 PiDialog），各有一个下划线开发屏（P5.5 的 11 个 + 第 2 轮的主机诊断）", () => {
    const names = ["Regenerate", "Compact", "Fork", "Clone", "Tree", "Export", "HostSettings", "SystemPrompt", "Tools", "SessionState", "Inspect", "HostDiag"]
    const dev = fs.readdirSync(path.join(ROOT, "ui/src/pi/dev/screens/c/_dialogs")).filter((f) => !f.startsWith("_"))
    assert.equal(dev.length, names.length)
    for (const n of names) {
      const src = code(read(`ui/src/components/pi/composer/Pi${n}Dialog.tsx`))
      assert.match(src, /<PiDialog\b/, n)
      assert.ok(!/return null\s*}\s*$/.test(src.trim()), `${n} 还是桩`)
    }
  })
  test("useRelay 和 fixture 的 composer 都走 composerFactsOf（一个口径）", () => {
    assert.match(code(read("ui/src/relay/useRelay.ts")), /composerFactsOf\(\{/)
    assert.match(code(read("ui/src/pi/dev/fixtures/derive.ts")), /composerFactsOf\(\{/)
  })
  test("提示音 / 网页回答确认框的开关同时写旧键（useCompletionSound、dialog_answer_switch 现读旧键）", () => {
    assert.match(code(read("ui/src/pi/containers/cShared.ts")), /saveLegacyStyle\(w\.patch\)/)
    assert.match(code(read("ui/src/pi/containers/SettingsContainer.tsx")), /playTestSound\("done"\)/)
  })
})

// P7 B4：style/prefs.ts 删了，不再拿 loadStyle / saveStyle 对照；期望值照 P5 时对照出来的结果直接写（口径不变）
describe("旧键 pi_remote_style 的三项（model/legacyStyle.ts；P7 B4 前对照 style/prefs.ts，现在钉期望值）", () => {
  test("读：空、坏 JSON、数组、坏值都回默认，完整偏好取三项；写：合并、其余字段原样保留", async () => {
    const { LEGACY_STYLE_DEFAULTS, LEGACY_STYLE_KEY, legacyStyleOf, legacyStyleWrite } = await import("../ui/src/pi/model/legacyStyle.ts")
    assert.equal(LEGACY_STYLE_KEY, "pi_remote_style")
    assert.deepEqual({ ...LEGACY_STYLE_DEFAULTS }, { completionSound: false, dialogRemoteAnswer: false, queueSend: "interrupt" })
    for (const raw of [null, "{", "[]", JSON.stringify({ completionSound: "yes", dialogRemoteAnswer: 1, queueSend: "later" })]) {
      assert.deepEqual(legacyStyleOf(raw), { ...LEGACY_STYLE_DEFAULTS }, String(raw))
    }
    const full = JSON.stringify({ completionSound: true, dialogRemoteAnswer: true, queueSend: "steer", theme: "forest", chrome: "current" })
    assert.deepEqual(legacyStyleOf(full), { completionSound: true, dialogRemoteAnswer: true, queueSend: "steer" })
    const merged = legacyStyleWrite(full, { completionSound: false, queueSend: "interrupt" })
    assert.deepEqual(legacyStyleOf(merged), { completionSound: false, dialogRemoteAnswer: true, queueSend: "interrupt" })
    assert.equal(JSON.parse(merged).theme, "forest", "别的字段原样保留")
    assert.equal(JSON.parse(merged).chrome, "current")
    assert.equal(legacyStyleOf(legacyStyleWrite(null, { completionSound: true })).completionSound, true)
  })
})
/* ---------------- P5 第 2 轮（R2/reviews/p5.json） ---------------- */
const coded = (code, message = code) => Object.assign(new Error(message), { code })

describe("主机诊断（审查 P5-R1-1；design B07「设置 › 设备 › 某台 › 诊断」，口径照 HostDiagView）", () => {
  test("c/settings fixture：MacBook Pro 的 get_host_diag → 就绪四组（版本 / Attach / 最近错误 / 日志尾部）；日志里的 token 遮掉；复制只拼白名单", async () => {
    const { relay } = await load("settings")
    const data = await relay.runDeviceCommand("d-mbp", "get_host_diag")
    const view = hostDiagViewOf({ unavailable: null, phase: "ready", data })
    assert.equal(view.kind, "ready")
    assert.equal(view.refreshing, false)
    assert.equal(view.note, null)
    const s = hostDiagSectionsOf(view.diag)
    assert.deepEqual(s.version, [
      ["Pi", "1.3.0"],
      ["Node", "v22.18.0"],
      ["扩展", "4.0.0"],
      ["平台", "darwin · arm64"],
    ])
    assert.deepEqual(
      s.attach.map(([k]) => k),
      ["状态", "到期", "设备 ID", "弹窗捕获"],
    )
    assert.equal(s.attach[0][1], "已连接")
    assert.match(s.attach[1][1], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, "到期 = 本地时间（固定格式）")
    assert.equal(s.attach[2][1], "d-mbp")
    assert.equal(s.attach[3][1], "正常（弹窗内容可见） · 捕获 12 · 在开 0")
    assert.equal(s.errors.length, 1)
    assert.equal(s.errors[0].code, "timeout")
    assert.equal(s.errors[0].iso, new Date(MOCK_NOW - 40 * 60_000).toISOString())
    assert.match(s.logTail, /token=\[redacted\]/)
    assert.doesNotMatch(s.logTail, /fixture-local-token/)
    const copy = formatHostDiag(view.diag)
    assert.match(copy, /^Pi-Remote 主机诊断/)
    assert.match(copy, /Pi：1\.3\.0/)
    assert.doesNotMatch(copy, /fixture-local-token/)
  })

  test("四态：设备离线（不发命令）/ 加载中 / 不支持（unknown_command、回包没有可展示字段）/ 出错（红字 + 重试）；命令发出后掉线按离线写", async () => {
    const { relay } = await load("settings")
    const device = (id) => relay.devices.find((d) => d.id === id) ?? null
    const ok = { authed: true, browserOnline: true }
    const off = hostDiagUnavailableOf({ ...ok, device: device("d-win") })
    assert.equal(off, "ThinkPad 未连接：先在这台电脑上打开 attach 窗口，再读取诊断。")
    assert.deepEqual(hostDiagViewOf({ unavailable: off, phase: "idle" }), { kind: "offline", text: off })
    assert.equal(hostDiagUnavailableOf({ ...ok, authed: false, device: device("d-mbp") }), "未连接服务器：连上后再读取主机诊断。")
    assert.equal(hostDiagUnavailableOf({ ...ok, browserOnline: false, device: device("d-mbp") }), "未连接服务器：连上后再读取主机诊断。")
    assert.equal(hostDiagUnavailableOf({ ...ok, device: null }), "名册里没有这台设备了（可能已经撤销）。")
    assert.equal(hostDiagUnavailableOf({ ...ok, device: device("d-mbp") }), null)
    assert.equal(hostDiagUnavailableOf({ ...ok, device: device("d-studio") }), null)
    assert.deepEqual(hostDiagViewOf({ unavailable: null, phase: "loading" }), { kind: "loading" })
    const studio = await relay.runDeviceCommand("d-studio", "get_host_diag").then(
      () => null,
      (e) => e,
    )
    assert.equal(studio?.code, "unknown_command")
    assert.deepEqual(hostDiagViewOf({ unavailable: null, phase: "error", error: studio }), { kind: "unsupported", text: "当前 pi 扩展还没有 get_host_diag 命令，更新扩展后重试。" })
    assert.deepEqual(hostDiagViewOf({ unavailable: null, phase: "error", error: coded("unsupported", "当前模式不支持 get_host_diag。") }), {
      kind: "unsupported",
      text: "当前模式不支持 get_host_diag。",
    })
    assert.deepEqual(hostDiagViewOf({ unavailable: null, phase: "ready", data: {} }), { kind: "unsupported", text: HOST_DIAG_EMPTY_TEXT })
    assert.deepEqual(hostDiagViewOf({ unavailable: null, phase: "ready", data: undefined }), { kind: "unsupported", text: HOST_DIAG_EMPTY_TEXT })
    assert.deepEqual(hostDiagViewOf({ unavailable: null, phase: "error", error: coded("timeout") }), { kind: "error", text: "本机没有回应：请重试", code: "timeout" })
    assert.deepEqual(hostDiagViewOf({ unavailable: null, phase: "error", error: coded("device_offline") }), { kind: "offline", text: "设备未连接：先在电脑上打开 attach 窗口。" })
  })

  test("刷新：读取中接着显示上一次的结果（refreshing）；刷新失败留着上一次的结果、写一句；离线优先", () => {
    const last = normalizeHostDiag({ piVersion: "1.3.0" })
    assert.deepEqual(hostDiagViewOf({ unavailable: null, phase: "loading", last }), { kind: "ready", diag: last, refreshing: true, note: null })
    assert.deepEqual(hostDiagViewOf({ unavailable: null, phase: "error", error: coded("timeout"), last }), {
      kind: "ready",
      diag: last,
      refreshing: false,
      note: "刷新失败：本机没有回应：请重试；下面仍是上一次成功读取的结果。",
    })
    assert.equal(hostDiagViewOf({ unavailable: null, phase: "error", error: coded("unknown_command"), last }).kind, "unsupported", "扩展换旧了：不支持优先于旧结果")
    assert.equal(hostDiagViewOf({ unavailable: "x", phase: "ready", data: { piVersion: "1" }, last }).kind, "offline")
  })

  test("缺字段写「未提供」，不编（design §1.9）；平台缺、架构在 = 未提供 · arm64；没有错误、日志为空", () => {
    const s = hostDiagSectionsOf(normalizeHostDiag({ arch: "arm64", attach: { active: false } }))
    assert.deepEqual(s.version, [
      ["Pi", "未提供"],
      ["Node", "未提供"],
      ["扩展", "未提供"],
      ["平台", "未提供 · arm64"],
    ])
    assert.deepEqual(s.attach, [
      ["状态", "未连接"],
      ["到期", "未提供"],
      ["设备 ID", "未提供"],
      ["弹窗捕获", "未提供"],
    ])
    assert.deepEqual(s.errors, [])
    assert.equal(s.logTail, "（空）")
  })

  // P7 B2h：旧界面 HostDiagView.tsx 在 B3d 删除，「一份实现」只剩 pi/model/hostDiag.ts，读 HostDiagView 源码的几条删了
  test("一份实现：诊断的归约 / 遮罩 / 复制 / 错误文案只在 pi/model/hostDiag.ts，不带开发数据", () => {
    const model = read("ui/src/pi/model/hostDiag.ts")
    for (const name of ["normalizeHostDiag", "redactSecrets", "formatHostDiag", "hostDiagErrorText", "formatDiagTimestamp"]) {
      assert.match(model, new RegExp(`export function ${name}\\b`), name)
    }
    assert.ok(!/pi\/dev\/|MOCK_/.test(model))
  })


  test("接线：设置页设备行开 PI_UI_IDS.hostDiag（arg = 设备 id）；容器按设备发 get_host_diag（runDeviceCommand，不改状态层）；桌面 overlay、手机设置页 sheet 槽都挂了", () => {
    const settings = code(read("ui/src/pi/containers/SettingsContainer.tsx"))
    assert.match(settings, /action\.startsWith\("device:"\)\) openPiDialog\(props, \{ id: PI_UI_IDS\.hostDiag, arg: action\.slice\("device:"\.length\) \}\)/)
    assert.match(settings, /<HostDiagContainer \{\.\.\.props\} \/>/)
    const container = code(read("ui/src/pi/containers/HostDiagContainer.tsx"))
    assert.match(container, /run\(deviceId, "get_host_diag"\)/)
    assert.match(container, /useHostDiag\(relay\.runDeviceCommand, unavailable \? null : deviceId\)/, "离线 / 没连上时不发命令")
    assert.match(code(read("ui/src/pi/containers/DialogsContainer.tsx")), /<HostDiagContainer \{\.\.\.props\} \/>/)
    assert.match(code(read("ui/src/pi/containers/types.ts")), /hostDiag: "c:host-diag"/)
  })
})

describe("提示词历史 ↑ / ↓（审查 P5-R1-2；design K04「接到产品输入框」，口径照旧界面 faces.tsx + chat/promptHistory.ts）", () => {
  const key = (direction, value, at = value.length, end = at) => ({ direction, value, selectionStart: at, selectionEnd: end })
  async function history() {
    const { relay } = await load("conversation")
    const items = relay.transcript.items
    const users = items.filter((i) => i.kind === "user").map((i) => i.text.trim())
    return { items, newest: users[users.length - 1], older: users[users.length - 2] }
  }

  test("conversation fixture：空输入框 ↑ = 最新一条，再 ↑ 更早一条，↓ 翻回来，再 ↓ 回到原草稿（空）后不再拦", async () => {
    const { items, newest, older } = await history()
    assert.equal(newest, "手机上键盘收起时输入框会跳一下，帮我看看 useMobileViewport 的判定。")
    let step = promptRecallStep(PROMPT_RECALL_IDLE, items, key("older", "", 0))
    assert.equal(step.text, newest)
    assert.deepEqual(step.state, { index: 0, savedDraft: "", shown: newest })
    step = promptRecallStep(step.state, items, key("older", newest))
    assert.equal(step.text, older, "单行浏览中，光标在哪都拦")
    step = promptRecallStep(step.state, items, key("newer", older, 0))
    assert.equal(step.text, newest)
    step = promptRecallStep(step.state, items, key("newer", newest))
    assert.equal(step.text, "")
    assert.deepEqual(step.state, PROMPT_RECALL_IDLE)
    assert.equal(promptRecallStep(step.state, items, key("newer", "", 0)), null, "没在浏览时 ↓ 不拦")
  })

  test("有草稿：光标不在最前时 ↑ 不拦（照常移动光标）；在最前才进历史，翻回来还原原草稿", async () => {
    const { items, newest } = await history()
    assert.equal(promptRecallStep(PROMPT_RECALL_IDLE, items, key("older", "草稿")), null)
    const step = promptRecallStep(PROMPT_RECALL_IDLE, items, key("older", "草稿", 0))
    assert.equal(step.text, newest)
    assert.equal(step.state.savedDraft, "草稿")
    const back = promptRecallStep(step.state, items, key("newer", newest))
    assert.equal(back.text, "草稿")
    assert.deepEqual(back.state, PROMPT_RECALL_IDLE)
  })

  test("多行：浏览中 ↑ 只在光标在最前、↓ 只在光标在最后时拦；翻到最早一条之后 ↑ 不拦", () => {
    const items = [
      { kind: "user", text: "第一行\n第二行" },
      { kind: "assistant", text: "好" },
      { kind: "user", text: "最新" },
    ]
    const multi = "第一行\n第二行"
    let step = promptRecallStep(PROMPT_RECALL_IDLE, items, key("older", "", 0))
    step = promptRecallStep(step.state, items, key("older", "最新"))
    assert.equal(step.text, multi)
    const s = step.state
    assert.equal(promptRecallStep(s, items, key("older", multi, 4)), null, "多行、光标不在最前：↑ 移动光标")
    assert.equal(promptRecallStep(s, items, key("older", multi, 0)), null, "已经是最早的一条")
    assert.equal(promptRecallStep(s, items, key("newer", multi, 2)), null, "多行、光标不在最后：↓ 移动光标")
    assert.equal(promptRecallStep(s, items, key("newer", multi)).text, "最新")
  })

  test("退出浏览：草稿被改成别的就退出、还是自己填的那段不退出；历史指纹只随用户消息变；没有历史 ↑ 不拦", async () => {
    const { items, newest } = await history()
    const s = promptRecallStep(PROMPT_RECALL_IDLE, items, key("older", "", 0)).state
    assert.deepEqual(promptRecallAfterDraft(s, newest), s)
    assert.deepEqual(promptRecallAfterDraft(s, `${newest}！`), PROMPT_RECALL_IDLE)
    assert.deepEqual(promptRecallAfterDraft(PROMPT_RECALL_IDLE, "随便"), PROMPT_RECALL_IDLE)
    const withReply = [...items, { kind: "assistant", text: "流式更新" }]
    assert.equal(promptHistoryKey(withReply), promptHistoryKey(items), "助手的流式更新不改历史")
    assert.notEqual(promptHistoryKey([...items, { kind: "user", text: "新的一条" }]), promptHistoryKey(items))
    assert.equal(promptRecallStep(PROMPT_RECALL_IDLE, [], key("older", "", 0)), null)
  })

  test("接线：ComposerContainer 只在桌面传 onHistoryKey；部件在斜杠 / @ 菜单和输入法组字之后、只在桌面、无修饰键、可输入时回调", () => {
    const container = code(read("ui/src/pi/containers/ComposerContainer.tsx"))
    assert.match(container, /onHistoryKey=\{phone \? undefined : recallPrompt\}/)
    assert.match(container, /promptRecallStep\(recall\.current, items, key\)/)
    assert.match(container, /\}, \[historyKey, roomId\]\)/, "换会话 / 历史变了退出浏览")
    assert.match(code(read("ui/src/components/pi/composer/PiComposerDock.tsx")), /onHistoryKey=\{onHistoryKey\}/)
    const part = code(read("ui/src/components/pi/composer/PiFollowUpComposer.tsx"))
    const at = part.indexOf('(event.key === "ArrowUp" || event.key === "ArrowDown") && plain && !phone && onHistoryKey && !disabled && !blocked')
    assert.ok(at > 0, "只在桌面、无修饰键、可输入（不是 S7、不是审批只读）")
    assert.ok(part.indexOf("if (assist.onKeyDown(event)) return") < at, "斜杠 / @ 菜单先拦方向键")
    assert.ok(part.indexOf("event.nativeEvent.isComposing || event.keyCode === 229") < at, "输入法组字时不翻")
  })
})
