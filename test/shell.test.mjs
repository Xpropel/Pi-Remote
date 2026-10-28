// 第 2 章 P0 桌面壳：断点 / 侧栏两档 / 会话项降级 / 令牌消费 / 源码守卫。
// P7 B2a（决定 17）：旧桌面壳（shell/*.tsx、shell.css、agent-window.css、inspectorModel / skeletonModel / agentWindow）删了，
// 读它们源码 / CSS 的用例删掉；保留的模型（breakpoints、shellModel、searchModel、deviceStripModel、connectionChip、useLinkState）照旧；
// 布局尺寸改读 pi-theme.css，⌘K 改查新界面的快捷键表与 PiSidebar。逐条清单见 R2/test-rewrite.md。
import test from "node:test"
import { readFileSync } from "node:fs"
import assert from "node:assert/strict"
import { BREAKPOINTS, PI_LAYOUT_BREAKPOINT, bpOf, isDesktop, isDesktopBreakpoint } from "../ui/src/shell/breakpoints.ts"
import {
  LINK_DEGRADE_MS,
  LINK_RECOVERED_MS,
  degradedLinkState,
  linkLabel,
  linkStateOf,
  sessionActivityAt,
  sessionPreview,
  sessionTimeLabel,
  sidebarDefault,
  sidebarWidth,
} from "../ui/src/shell/shellModel.ts"
import {
  BODY_SEARCH_QUERY_MAX,
  BODY_SEARCH_QUERY_MIN,
  SEARCH_DEBOUNCE_MS,
  bodySearchErrorText,
  bodySearchPageOf,
  bodySearchTruncatedText,
  highlightParts,
  searchCountLabel,
  searchSessions,
} from "../ui/src/shell/searchModel.ts"
import { SHELL_DEVICE_LIMIT, shellDeviceSelection, sortShellDevices } from "../ui/src/shell/deviceStripModel.ts"
import { deviceFirstSeenAt } from "../ui/src/chat/deviceStripModel.ts"
import { devicesFromRoomList } from "../ui/src/relay/devices.ts"
import { CONNECTION_OFFLINE_AFTER_MS, connectionChip } from "../ui/src/chat/composer/interaction.ts"

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
const useRelayTs = source("../ui/src/relay/useRelay.ts")
const useLinkStateTs = source("../ui/src/shell/useLinkState.ts")

test("桌面壳断点：768 / 1024 / 1280 / 1600 / 1920 边界", () => {
  assert.deepEqual([...BREAKPOINTS], [768, 1024, 1280, 1600, 1920])
  assert.equal(bpOf(0), "xs")
  assert.equal(bpOf(767), "xs")
  assert.equal(bpOf(768), "sm")
  assert.equal(bpOf(1023), "sm")
  assert.equal(bpOf(1024), "md")
  assert.equal(bpOf(1279), "md")
  assert.equal(bpOf(1280), "lg")
  assert.equal(bpOf(1599), "lg")
  assert.equal(bpOf(1600), "xl")
  assert.equal(bpOf(1919), "xl")
  assert.equal(bpOf(1920), "2xl")
  // P11 迁移：产品布局断点 1024 → 768（≤767 移动 / ≥768 桌面）
  assert.equal(PI_LAYOUT_BREAKPOINT, 768)
  assert.equal(isDesktop(767), false)
  assert.equal(isDesktop(768), true)
  assert.equal(isDesktop(1023), true)
  assert.equal(isDesktop(1024), true)
  assert.equal(isDesktopBreakpoint("sm"), false)
  assert.equal(isDesktopBreakpoint("md"), true)
})


test("侧栏两档：md 默认 rail，lg+ 默认 expanded；宽度 240 / 256 / 48", () => {
  assert.equal(sidebarDefault("md"), "rail")
  assert.equal(sidebarDefault("lg"), "expanded")
  assert.equal(sidebarDefault("xl"), "expanded")
  assert.equal(sidebarDefault("2xl"), "expanded")
  assert.equal(sidebarWidth("md", "expanded"), 240)
  assert.equal(sidebarWidth("md", "rail"), 48)
  assert.equal(sidebarWidth("lg", "expanded"), 256)
  assert.equal(sidebarWidth("lg", "rail"), 48)
  assert.equal(sidebarWidth("2xl", "expanded"), 256)
})

test("会话时间四档：今天 HH:mm / 昨天 HH:mm / 今年 M月d日 / 跨年 yyyy/M/d", () => {
  const now = new Date(2026, 9, 22, 14, 30).getTime()
  assert.equal(sessionTimeLabel(new Date(2026, 9, 22, 9, 5).getTime(), now), "09:05")
  assert.equal(sessionTimeLabel(new Date(2026, 9, 21, 23, 59).getTime(), now), "昨天 23:59")
  assert.equal(sessionTimeLabel(new Date(2026, 7, 3, 12, 0).getTime(), now), "8月3日")
  assert.equal(sessionTimeLabel(new Date(2025, 11, 31, 12, 0).getTime(), now), "2025/12/31")
  assert.equal(sessionTimeLabel(0, now), "")
  assert.equal(sessionTimeLabel(Number.NaN, now), "")
})

test("会话副标题只降级到 cwd，活动时间回落到房间 lastActivity，不伪造", () => {
  assert.equal(sessionPreview({ cwd: "/Users/user/CLI/Pi-Remote" }), "/Users/user/CLI/Pi-Remote")
  assert.equal(sessionPreview({ cwd: "" }), "")
  const rooms = [{ id: "room-1", lastActivity: 1_700_000_000_000 }]
  assert.equal(sessionActivityAt({ id: "room-1", updatedAt: 0 }, rooms), 1_700_000_000_000)
  assert.equal(sessionActivityAt({ id: "room-1", updatedAt: 1_700_000_500_000 }, rooms), 1_700_000_500_000)
  assert.equal(sessionActivityAt({ id: "gone", updatedAt: 0 }, rooms), 0)
})

test("链路三态：authed / 曾经连上 / 无记录；文案与颜色语义分开", () => {
  assert.equal(linkStateOf({ authed: true, everConnected: false, retryAt: null }), "connected")
  assert.equal(linkStateOf({ authed: false, everConnected: true, retryAt: 123 }), "reconnecting")
  assert.equal(linkStateOf({ authed: false, everConnected: false, retryAt: 123 }), "reconnecting")
  assert.equal(linkStateOf({ authed: false, everConnected: false, retryAt: null }), "offline")
  assert.equal(linkLabel("connected"), "已连接")
  assert.equal(linkLabel("reconnecting"), "重连中")
  assert.equal(linkLabel("offline"), "离线")
})

test("设备行：在线优先、组内首次连接从早到晚，上限 6 + N，当前设备不置顶", () => {
  const device = (id, online, firstSeenAt = null, lastAttachAt = null) => ({
    id,
    accountId: "a",
    name: id,
    platform: "linux",
    online,
    projects: [],
    firstSeenAt,
    // 故意与 firstSeenAt 反向：排序若还看最近活跃，结果会完全不同。
    lastAttachAt,
    windowExpiresAt: null,
    auth: "token",
    paired: true,
  })
  const devices = [
    device("d5", false, 105, 900),
    device("d2", true, 102, 300),
    device("d0", true, 100, 500),
    device("d7", false, 107, 100),
    device("d1", true, 101, 700),
    device("d3", false, 103, 600),
    device("d4", false, 104, 400),
    device("d6", false, 106, 200),
  ]
  const ordered = ["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"]
  assert.equal(SHELL_DEVICE_LIMIT, 6)
  assert.deepEqual(sortShellDevices(devices).map((row) => row.id), ordered, "在线在前，同组按首次连接升序")

  const fallback = shellDeviceSelection(devices, null)
  assert.deepEqual(fallback.visible.map((row) => row.id), ordered.slice(0, 6))
  assert.equal(fallback.overflow, 2)
  assert.equal(fallback.current, null)

  // 选中第 7 台（d7）不能把它挪到第 1 槽：正常留在 overflow，前 6 槽顺序不变。
  const picked = shellDeviceSelection(devices, "d7")
  assert.equal(picked.current?.id, "d7")
  assert.deepEqual(picked.visible.map((row) => row.id), ordered.slice(0, 6))
  assert.equal(picked.visible.some((row) => row.id === "d7"), false, "当前设备不在前 6 时正常溢出")
  assert.equal(picked.overflow, 2)

  // 选中前排设备也只改高亮，不改变槽位顺序。
  const early = shellDeviceSelection(devices, "d2")
  assert.equal(early.visible[0].id, "d0")
  assert.deepEqual(early.visible.map((row) => row.id), picked.visible.map((row) => row.id), "点击只改 selected，不重排")
})

test("设备排序：在线优先，老数据回退 lastAttachAt，缺失时间排最后，同刻稳定", () => {
  const device = (id, online, firstSeenAt = null, lastAttachAt = null) => ({
    id,
    accountId: "a",
    name: id,
    platform: "linux",
    online,
    projects: [],
    firstSeenAt,
    lastAttachAt,
    windowExpiresAt: null,
    auth: "token",
    paired: true,
  })
  const mixed = [device("offline-first", false, 1), device("online-late", true, 999)]
  assert.deepEqual(sortShellDevices(mixed).map((row) => row.id), ["online-late", "offline-first"], "在线优先于更早的离线设备")

  // 老 relay / 老索引没有 firstSeenAt：回退 lastAttachAt；两边都没有就排最后，不伪造 now。
  const legacy = [
    device("legacy-new", true, null, 900),
    device("legacy-old", true, null, 100),
    device("unknown", true, null, null),
    device("legacy-mid", true, null, 500),
  ]
  assert.equal(deviceFirstSeenAt(legacy[0]), 900, "老数据回退 lastAttachAt")
  assert.equal(deviceFirstSeenAt(legacy[2]), 0, "无时间不伪造")
  assert.deepEqual(sortShellDevices(legacy).map((row) => row.id), ["legacy-old", "legacy-mid", "legacy-new", "unknown"])

  // 同一首次连接时间用名称 / id 固定次序，且不改原数组。
  const tied = [device("b", true, 7), device("a", true, 7), device("c", true, 7)]
  const before = tied.map((row) => row.id)
  const first = sortShellDevices(tied).map((row) => row.id)
  assert.deepEqual(first, ["a", "b", "c"])
  assert.deepEqual(sortShellDevices(tied).map((row) => row.id), first, "重复排序结果稳定")
  assert.deepEqual(tied.map((row) => row.id), before, "排序不能改原数组")
})

test("Device 解析：firstSeenAt 来自 relay；老 relay 缺字段时保留 null 供排序回退", () => {
  const [parsed] = devicesFromRoomList([{ id: "d1", online: true, firstSeenAt: 42, lastAttachAt: 99 }], [])
  assert.equal(parsed.firstSeenAt, 42)
  assert.equal(deviceFirstSeenAt(parsed), 42)
  const [legacy] = devicesFromRoomList([{ id: "old", online: true, lastAttachAt: 99 }], [])
  assert.equal(legacy.firstSeenAt, null, "老 relay 不下发就保持 null，不补 now")
  assert.equal(deviceFirstSeenAt(legacy), 99, "排序回退 lastAttachAt")
})















test("搜索：标题 / cwd / 首消息大小写不敏感，中文子串；没有末条预览字段就不匹配预览", () => {
  assert.equal(SEARCH_DEBOUNCE_MS, 120)
  const rows = [
    { id: "a", title: "桌面壳统一布局", cwd: "/Users/user/CLI/Pi-Remote", firstMessage: "先把布局对齐" },
    { id: "b", title: "Review PR #481", cwd: "/Users/user/work/web", firstMessage: "帮我看看这个 PR" },
    { id: "c", title: "整理设计令牌", cwd: "/Users/user/CLI/Pi-Remote/docs", firstMessage: "首条消息里提到象牙塔" },
  ]
  assert.deepEqual(searchSessions(rows, "pr #481").map((row) => row.id), ["b"])
  assert.deepEqual(searchSessions(rows, "PI-REMOTE").map((row) => row.id), ["a", "c"])
  assert.deepEqual(searchSessions(rows, "令牌").map((row) => row.id), ["c"])
  assert.deepEqual(searchSessions(rows, "docs").map((row) => row.id), ["c"])
  assert.deepEqual(searchSessions(rows, "最后一条消息").map((row) => row.id), [])
  // R4-2：firstMessage 是现成协议字段，进本地匹配面（与标题/cwd 并列、独立断言）
  assert.deepEqual(searchSessions(rows, "象牙塔").map((row) => row.id), ["c"], "只出现在首消息里的词也能命中")
  assert.deepEqual(searchSessions(rows, "看看这个").map((row) => row.id), ["b"], "首消息子串命中")
  assert.deepEqual(searchSessions(rows, "").map((row) => row.id), ["a", "b", "c"])
  assert.deepEqual(searchSessions(rows, "   ").map((row) => row.id), ["a", "b", "c"])
  assert.equal(rows.length, 3, "过滤不能改原数组")
  assert.equal(searchCountLabel(5), "找到 5 个会话")
})

test("正文搜索：回包归一形状、截断诚实态、失败三态文案分开（R4-2）", () => {
  const proto = JSON.parse(source("../protocol/v4.json"))
  assert.equal(BODY_SEARCH_QUERY_MIN, proto.limits.bodySearchQueryMin, "UI 镜像与协议 limits 同值")
  assert.equal(BODY_SEARCH_QUERY_MAX, proto.limits.bodySearchQueryMax)

  const page = bodySearchPageOf({
    query: "紫水晶",
    results: [
      {
        session: "/s/one.jsonl",
        id: "one",
        title: "会话一",
        cwd: "/work",
        mtime: 123,
        matchCount: 3,
        snippets: [{ text: "前面 紫水晶 后面", entryId: "e1" }, { text: "无 id 片段" }, { bad: true }, "junk"],
      },
      { session: "", id: "ghost" },
      "junk",
    ],
    truncated: true,
    scannedFiles: 7,
    totalFiles: 12,
  })
  assert.equal(page.query, "紫水晶")
  assert.equal(page.results.length, 1, "形状不对的条目丢弃，不硬撑假数据")
  assert.equal(page.results[0].id, "one")
  assert.equal(page.results[0].matchCount, 3)
  assert.deepEqual(page.results[0].snippets, [
    { text: "前面 紫水晶 后面", entryId: "e1" },
    { text: "无 id 片段" },
  ])
  assert.equal(page.truncated, true)
  assert.equal(bodySearchTruncatedText(page), "已扫 7/12 个会话文件，结果可能不全")
  assert.equal(bodySearchPageOf(null), null)
  assert.equal(bodySearchPageOf({ query: "x" }), null)
  assert.equal(bodySearchPageOf({ query: "x", results: "nope" }), null)

  // 失败三态必须分开说：离线 / 无活动会话 / 超时，互不冒充
  const offline = bodySearchErrorText("device_offline", "设备未连接")
  const noSession = bodySearchErrorText("device_no_active_session", "没有在跑的会话")
  const timeout = bodySearchErrorText("timeout", "超时")
  assert.match(offline, /未连接/)
  assert.match(noSession, /没有在运行的会话/)
  assert.match(timeout, /超时/)
  assert.notEqual(offline, noSession)
  assert.notEqual(offline, timeout)
  assert.notEqual(noSession, timeout)
  assert.equal(bodySearchErrorText("result_unknown", "命令没有回应"), timeout, "通道丢失与超时同态")
  assert.match(bodySearchErrorText("server_error", "服务端原文"), /服务端原文/, "未知码回退服务端原文")
})

test("正文搜索接线守卫：命令经 useRelay 接缝、片段只走文本高亮不拼 HTML（R4-2）", () => {
  const useRelayTs = source("../ui/src/relay/useRelay.ts")
  assert.match(useRelayTs, /searchSessionBodies/, "useRelay 暴露正文搜索接缝")
  assert.match(useRelayTs, /runDeviceCommand\(deviceId, "search_session_bodies", \{ query \}\)/, "走既有设备命令通道")
  // P7 B2a：侧栏正文搜索区改查新界面的 SearchContainer（旧 shell/Sidebar.tsx 删了）
  const searchContainer = source("../ui/src/pi/containers/SearchContainer.tsx")
  assert.match(searchContainer, /const searchBodies = relay\.searchSessionBodies\b/, "正文搜索走 useRelay 的接缝")
  assert.equal(searchContainer.includes("dangerouslySetInnerHTML"), false, "片段绝不以 HTML 注入")
})

test("搜索高亮：命中片段用 --mark，不改原文字色字重", () => {
  assert.deepEqual(highlightParts("桌面壳统一布局", ""), [{ text: "桌面壳统一布局", hit: false }])
  assert.deepEqual(highlightParts("桌面壳统一布局", "壳"), [
    { text: "桌面", hit: false },
    { text: "壳", hit: true },
    { text: "统一布局", hit: false },
  ])
  assert.deepEqual(highlightParts("Review PR #481", "pr"), [
    { text: "Review ", hit: false },
    { text: "PR", hit: true },
    { text: " #481", hit: false },
  ])
  assert.deepEqual(highlightParts("aaaa", "aa"), [
    { text: "aa", hit: true },
    { text: "aa", hit: true },
  ])
  assert.deepEqual(highlightParts("", "x"), [])
})

test("链路 30s 降级与恢复时长", () => {
  assert.equal(LINK_DEGRADE_MS, 30_000)
  assert.equal(LINK_RECOVERED_MS, 1_600)
  assert.equal(degradedLinkState("connected", 99_000), "connected")
  assert.equal(degradedLinkState("offline", 0), "offline")
  assert.equal(degradedLinkState("reconnecting", 29_999), "reconnecting")
  assert.equal(degradedLinkState("reconnecting", 30_000), "offline")
})


test("connectionChip 6 态：label / tone / breathing / shape；第 1 次重连不伪造次数", () => {
  const now = 1_000_000
  const base = { authed: true, everConnected: true, retryAt: null, now }

  const connecting = connectionChip({ ...base, authed: false, everConnected: false })
  assert.deepEqual(
    [connecting.state, connecting.label, connecting.tone, connecting.breathing],
    ["connecting", "连接中…", "info", true],
  )

  const reconnecting = connectionChip({ ...base, authed: false, retryAt: now + 5_000, retryCount: 1 })
  assert.deepEqual(
    [reconnecting.state, reconnecting.label, reconnecting.tone, reconnecting.breathing],
    ["reconnecting", "重连中…", "warning", true],
  )
  assert.equal(reconnecting.countdownSeconds, null, "第 1 次重连不显示倒计时")
  assert.doesNotMatch(reconnecting.label, /第\s*1\s*次|·\s*\d+s/, "没有真实重试序号时不伪造第 n 次")

  // U-7：拨号 / 鉴权中 retryAt 会被清空，但这不是「已断开」。
  const dialing = connectionChip({ ...base, authed: false, retryAt: null, trying: true, retryCount: 2, downFor: 5_000 })
  assert.deepEqual(
    [dialing.state, dialing.label, dialing.tone, dialing.countdownSeconds, dialing.breathing],
    ["reconnecting", "重连中…", "warning", null, true],
  )
  assert.equal(dialing.retryCount, 2, "尝试中仍保留真实重试序号")

  const connected = connectionChip(base)
  assert.deepEqual(
    [connected.state, connected.label, connected.tone, connected.breathing],
    ["connected", "已连接", "success", false],
  )

  const offline = connectionChip({ ...base, authed: false })
  assert.deepEqual(
    [offline.state, offline.label, offline.tone, offline.shape, offline.breathing],
    ["offline", "已断开", "error", "ring", false],
  )

  const deviceOffline = connectionChip({ ...base, device: { name: "MacBook Pro", online: false } })
  assert.deepEqual(
    [deviceOffline.state, deviceOffline.label, deviceOffline.tone],
    ["device-offline", "MacBook Pro 离线", "muted"],
  )

  const busy = connectionChip({ ...base, busy: true })
  assert.deepEqual(
    [busy.state, busy.label, busy.tone, busy.breathing],
    ["device-busy", "运行中", "warning", false],
  )

  const states = new Set([connecting, reconnecting, connected, offline, deviceOffline, busy].map((chip) => chip.state))
  assert.deepEqual([...states].sort(), ["connected", "connecting", "device-busy", "device-offline", "offline", "reconnecting"])
})

test("connectionChip 30s 降级：重连超时转已断开，首次连接不误判，期间仍可重连", () => {
  const now = 1_000_000
  const base = { authed: false, everConnected: true, retryAt: now + 5_000, now }
  assert.equal(CONNECTION_OFFLINE_AFTER_MS, 30_000)
  assert.equal(CONNECTION_OFFLINE_AFTER_MS, LINK_DEGRADE_MS, "chip 与链路降级同一时长")

  const within = connectionChip({ ...base, downFor: 29_999 })
  assert.deepEqual([within.state, within.label, within.tone], ["reconnecting", "重连中…", "warning"])

  const timedOut = connectionChip({ ...base, downFor: 30_000, offlineAfter: CONNECTION_OFFLINE_AFTER_MS })
  assert.deepEqual(
    [timedOut.state, timedOut.label, timedOut.tone, timedOut.shape, timedOut.breathing, timedOut.countdownSeconds],
    ["offline", "已断开", "error", "ring", false, null],
  )

  // 自定义阈值只影响降级点；重连按钮由连接页提供，不因降级被禁用。
  assert.equal(connectionChip({ ...base, downFor: 5_000, offlineAfter: 5_000 }).state, "offline")
  assert.equal(connectionChip({ ...base, downFor: 4_999, offlineAfter: 5_000 }).state, "reconnecting")

  // 首次连接没有“曾经连上”的事实：即使等待很久也只显示连接中，不伪造断开。
  const firstConnect = connectionChip({ authed: false, everConnected: false, retryAt: now + 5_000, now, downFor: 60_000 })
  assert.equal(firstConnect.state, "connecting")

  // 30s 仍是降级硬线：即使正在尝试重连，超过阈值也以「已断开」呈现。
  assert.equal(connectionChip({ ...base, trying: true, downFor: 30_000 }).state, "offline")
})

test("U-5/U-6：useLinkState 有 1s tick；useRelay 暴露真实 retryCount / trying", () => {
  assert.match(useLinkStateTs, /window\.setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\)/, "断线期间 1s tick")
  assert.match(useRelayTs, /const \[retryCount, setRetryCount\] = useState\(0\)/)
  assert.match(useRelayTs, /setRetryCount\(\(count\) => count \+ 1\)/, "每次非主动断开累加真实重试序号")
  assert.match(useRelayTs, /const \[trying, setTrying\] = useState\(false\)/)
  assert.match(useRelayTs, /setTrying\(true\)/, "拨号 / 鉴权期间 trying=true")
  assert.match(useRelayTs, /setRetryCount\(0\)[\s\S]{0,40}setTrying\(false\)/, "认证成功归零")
  assert.match(useRelayTs, /\n    retryCount,\n    \/\*\* 正在拨号/, "Relay 导出真实 retryCount / trying")
})
test("设备条模型源码：仍标出当前设备，当前设备不固定第 1 槽（原「壳源码」用例里读保留文件的两条）", () => {
  const deviceModelTs = source("../ui/src/shell/deviceStripModel.ts")
  assert.match(deviceModelTs, /selectedId/, "设备条仍标出当前设备")
  assert.doesNotMatch(deviceModelTs, /visible = current \? \[current/, "当前设备不再固定第 1 槽")
})
test("布局尺寸改读新界面 pi-theme.css：侧栏 256 / rail 48 / pane 460 / 阅读列 768 / 顶栏 44 / 触控 44（P7 B2a，原壳 CSS 用例）", () => {
  const piTheme = source("../ui/src/components/pi/shared/pi-theme.css")
  assert.match(piTheme, /--cw-pi-sidebar-w:\s*256px;/)
  assert.match(piTheme, /--cw-pi-rail-w:\s*48px;/)
  assert.match(piTheme, /--cw-pi-pane-w:\s*460px;/)
  assert.match(piTheme, /--cw-pi-chat-max-w:\s*768px;/)
  assert.match(piTheme, /--cw-pi-topbar-h:\s*44px;/)
  assert.match(piTheme, /--cw-pi-touch:\s*44px;/)
})
test("⌘K 只打开命令面板，侧栏搜索行不带 kbd（D-01；P7 B2a，原 useShortcuts / SidebarSearch 用例）", () => {
  const shortcuts = source("../ui/src/pi/model/shortcuts.ts")
  const piSidebar = source("../ui/src/components/pi/shared/PiSidebar.tsx")
  assert.match(shortcuts, /"command-palette": \{ mac: "⌘K", other: "Ctrl\+K" \}/)
  assert.match(shortcuts, /if \(key === "k" \|\| code === "KeyK"\) return "command-palette"/)
  assert.equal(piSidebar.includes('kbd="⌘K"'), false, "侧栏搜索行不带 ⌘K 键帽")
})
