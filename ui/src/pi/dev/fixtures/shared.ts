/**
 * live fixture 共用的原始数据（plan P5.2）：形状是 relay 的真实类型（RoomInfo / Device / SessionEntry / Item …），
 * 值照 R/replica/src/components/pi/{shared,a,b,c}/mock*.ts 抄（id、标题、时间都按 MOCK_NOW 算，§1.9 可追溯）。
 * 这里不放任何算好的界面行：分组、标记、tray、占位都由真实函数从这些字段算。
 * relay 不下发的字段（思考的 observedMs、图片宽高比、正文 prose）一律不写，缺口记在 R2/logs/side-fixtures/report.md。
 * edit 的 details.patch 已经随 toolResult 下发、由 transcript 提升到工具块（G5 前端修，R2/logs/side-g5g12/report.md），这里照真实形状写上。
 */
import type { TaskListItem } from "../../../chat/composer/taskList.ts"
import type { DialogCard } from "../../../chat/composer/promptModel.ts"
import type { TerminalItem } from "../../../chat/capsules/terminalModel.ts"
import type { AgentEntry } from "../../../chat/capsules/workingModel.ts"
import type { RemoteQueueState } from "../../../relay/remoteQueue.ts"
import type { Device, RoomInfo, SessionEntry } from "../../../relay/devices.ts"
import type { Block, Item, Transcript } from "../../../relay/transcript.ts"
import { MOCK_NOW, type Relay } from "./types.ts"

const S = 1000
const M = 60 * S
const H = 60 * M
const D = 24 * H
const NOW = MOCK_NOW

/* ---------------- 设备（room_list.devices；replica shared/mock.ts MOCK_DEVICES） ---------------- */

export const MBP: Device = {
  id: "d-mbp",
  accountId: "acct-dev",
  name: "MacBook Pro",
  platform: "darwin",
  online: true,
  projects: ["/Users/dev/code/pi-remote", "/Users/dev/code/notes-app", "/Users/dev/code/dotfiles"],
  // P9 C：新 attach 上报的浏览根目录（默认是设备用户的家目录）
  browseRoots: ["/Users/dev"],
  lastAttachAt: NOW - 3 * H,
  firstSeenAt: NOW - 52 * D,
  windowExpiresAt: NOW + 5 * H + 12 * M,
  auth: "token",
  paired: true,
  // 设备心跳 RTT 样本（relay ping/pong 平滑后的整数毫秒）
  latencyMs: 38,
}
export const STUDIO: Device = {
  id: "d-studio",
  accountId: "acct-dev",
  name: "Mac Studio",
  platform: "darwin",
  online: true,
  projects: ["/Users/dev/work/billing-service", "/Users/dev/work/infra"],
  browseRoots: ["/Users/dev/work"],
  lastAttachAt: NOW - 9 * H,
  firstSeenAt: NOW - 40 * D,
  windowExpiresAt: NOW + 21 * H,
  auth: "token",
  paired: true,
  latencyMs: null,
}
export const THINKPAD: Device = {
  id: "d-win",
  accountId: "acct-dev",
  name: "ThinkPad",
  platform: "win32",
  online: false,
  projects: ["C:\\Users\\dev\\src\\game-tools"],
  browseRoots: ["C:\\Users\\dev"],
  lastAttachAt: NOW - 27 * H,
  firstSeenAt: NOW - 12 * D,
  windowExpiresAt: null,
  auth: null,
  paired: true,
  latencyMs: null,
}
export const DEVICES: Device[] = [MBP, STUDIO, THINKPAD]

/* ---------------- 会话（session_list，按设备；replica MOCK_SESSIONS） ---------------- */

export const PI_REMOTE = "/Users/dev/code/pi-remote"
export const NOTES = "/Users/dev/code/notes-app"
export const BILLING = "/Users/dev/work/billing-service"
export const INFRA = "/Users/dev/work/infra"
export const GAME = "C:\\Users\\dev\\src\\game-tools"

type MockSession = { id: string; deviceId: string; cwd: string; title: string; online: boolean; busy?: boolean; messageCount: number; updatedAt: number }

/** 17 个会话；online = 房间在线。replica 另有 sessionId（UUID），relay 里房间 id 就是会话 id，这里只有一个 id。 */
const SESSIONS: MockSession[] = [
  { id: "r-s1", deviceId: "d-mbp", cwd: PI_REMOTE, title: "修复手机键盘收起时输入框跳动", online: true, messageCount: 48, updatedAt: NOW - 2 * M },
  { id: "r-s2", deviceId: "d-mbp", cwd: PI_REMOTE, title: "relay 重启后提示结果未知", online: true, busy: true, messageCount: 17, updatedAt: NOW - 20 * S },
  { id: "r-s3", deviceId: "d-mbp", cwd: PI_REMOTE, title: "给 history-backfill 补测试", online: true, messageCount: 9, updatedAt: NOW - 1 * M },
  { id: "r-s4", deviceId: "d-mbp", cwd: PI_REMOTE, title: "整理 README 的配对步骤", online: true, messageCount: 31, updatedAt: NOW - 14 * M },
  { id: "r-s10", deviceId: "d-mbp", cwd: PI_REMOTE, title: "键盘问题 · 分叉", online: true, messageCount: 52, updatedAt: NOW - 1 * H },
  { id: "s12", deviceId: "d-mbp", cwd: PI_REMOTE, title: "设备令牌轮换的文案", online: false, messageCount: 23, updatedAt: NOW - 6 * H },
  { id: "s13", deviceId: "d-mbp", cwd: PI_REMOTE, title: "排队面板的冲突提示", online: false, messageCount: 36, updatedAt: NOW - 19 * H },
  { id: "s14", deviceId: "d-mbp", cwd: PI_REMOTE, title: "命令面板加会话搜索", online: false, messageCount: 44, updatedAt: NOW - 2 * D },
  { id: "s15", deviceId: "d-mbp", cwd: PI_REMOTE, title: "终端输出软换行", online: false, messageCount: 15, updatedAt: NOW - 3 * D },
  { id: "s16", deviceId: "d-mbp", cwd: PI_REMOTE, title: "diff 卡读 details.patch", online: false, messageCount: 28, updatedAt: NOW - 4 * D },
  { id: "s17", deviceId: "d-mbp", cwd: PI_REMOTE, title: "配对码倒计时", online: false, messageCount: 12, updatedAt: NOW - 5 * D },
  { id: "s18", deviceId: "d-mbp", cwd: PI_REMOTE, title: "升级 vite 8", online: false, messageCount: 57, updatedAt: NOW - 6 * D },
  { id: "r-s5", deviceId: "d-mbp", cwd: NOTES, title: "日记页加离线缓存", online: true, messageCount: 22, updatedAt: NOW - 5 * H },
  { id: "r-s6", deviceId: "d-studio", cwd: BILLING, title: "退款对账脚本报错", online: true, messageCount: 14, updatedAt: NOW - 38 * M },
  { id: "r-s11", deviceId: "d-studio", cwd: BILLING, title: "账单导出改成流式", online: true, messageCount: 40, updatedAt: NOW - 3 * H },
  { id: "s7", deviceId: "d-studio", cwd: INFRA, title: "升级 nginx 配置", online: false, messageCount: 64, updatedAt: NOW - 1 * D },
  { id: "r-s8", deviceId: "d-win", cwd: GAME, title: "地图编辑器导出 bug", online: false, messageCount: 27, updatedAt: NOW - 27 * H },
]

function entryOf(x: MockSession): SessionEntry {
  return {
    id: x.id,
    name: "",
    firstMessage: x.title,
    path: `/Users/dev/.pi/agent/sessions/${x.id}.jsonl`,
    cwd: x.cwd,
    messageCount: x.messageCount,
    // 会话文件大小：mock 没有来源，界面也不显示；照 parseSession 缺值时的 0
    sizeBytes: 0,
    updatedAt: x.updatedAt,
    active: x.online,
    online: x.online,
    parentSession: x.id === "r-s10" ? "/Users/dev/.pi/agent/sessions/r-s1.jsonl" : null,
  }
}

/** sessionsByDevice（get_sessions / session_list 的结果，按设备） */
export const SESSIONS_BY_DEVICE: Record<string, SessionEntry[]> = Object.fromEntries(
  DEVICES.map((d) => [d.id, SESSIONS.filter((x) => x.deviceId === d.id).map(entryOf)]),
)

/** room_list.rooms：只有在线会话有房间；busy 来自房间（replica MOCK_ROOMS） */
export const ROOMS: RoomInfo[] = SESSIONS.filter((x) => x.online).map((x) => ({
  id: x.id,
  label: null,
  name: x.title,
  firstMessage: x.title,
  cwd: x.cwd,
  online: true,
  busy: !!x.busy,
  viewers: 1,
  lastActivity: x.updatedAt,
  accountId: "acct-dev",
  deviceId: x.deviceId,
}))

export function roomsWith(patch: Record<string, Partial<RoomInfo>>): RoomInfo[] {
  return ROOMS.map((room) => (patch[room.id] ? { ...room, ...patch[room.id] } : room))
}

/**
 * 别房回合结束（roomTurnEnds，room_list / room_attention 种回的落定记录）：
 * r-s6 出错（seq 12，38 分钟前）、r-s4 完成（seq 7，14 分钟前）。replica MOCK_ATTENTION 的另两条（r-s3 等你回答、ThinkPad 掉线）
 * relay 只对当前房间 / 选中设备产出，见报告的缺口 G1 / G2。
 */
export const ROOM_TURN_ENDS = [
  { seq: 12, at: NOW - 38 * M, roomId: "r-s6", error: true },
  { seq: 7, at: NOW - 14 * M, roomId: "r-s4", error: false },
]

/* ---------------- 模型与用量（replica shared/mock.ts） ---------------- */

export const MODEL_META = { provider: "anthropic", modelId: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }
export const THINKING_LEVEL = "medium"
/** r-s1 的 usage_state；缓存命中 = cacheRead / (input + cacheRead) = 87% */
export const USAGE: NonNullable<Relay["usage"]> = {
  tokens: { input: 182340, output: 24410, cacheRead: 1203300, cacheWrite: 40220, total: 1450270 },
  cost: 3.84,
  costByModel: { "anthropic/claude-sonnet-4-5": 3.61, "anthropic/claude-haiku-4-5": 0.23 },
  contextUsage: { tokens: 61800, contextWindow: 200000, percent: 30.9 },
}

/* ---------------- 转录（transcript.items；replica b/mockConvo.ts、mockOther.ts） ---------------- */

const MODEL = "claude-sonnet-4-5"
export const VIEWPORT_PATH = "ui/src/mobile/useMobileViewport.ts"
export const CONVERSATION_PATH = "ui/src/mobile/MobileConversation.tsx"
export const KEYBOARD_TEST_PATH = "test/mobile-keyboard.test.mjs"

type ToolBlock = Extract<Block, { kind: "tool" }>

export function tool(id: string, name: string, input: Record<string, unknown>, outputText = "", extra: Partial<ToolBlock> = {}): ToolBlock {
  return { kind: "tool", id, name, argsText: JSON.stringify(input), input, outputText, state: "output-available", ...extra }
}

function assistant(key: string, at: number, durationMs: number, stopReason: string, blocks: Block[], totalTokens?: number): Item {
  return {
    kind: "assistant",
    key,
    model: MODEL,
    startedAt: at,
    durationMs,
    endedAt: at + durationMs,
    timestamp: at,
    stopReason,
    blocks,
    ...(totalTokens ? { usage: { totalTokens } } : {}),
  }
}

export function transcriptOf(items: Item[], liveKey: string | null = null): Transcript {
  return { items, liveKey, seq: items.length, bashKey: null, pendingTools: {} }
}

export const KEYBOARD_TEST_CONTENT = [
  `import assert from "node:assert/strict"`,
  `import { test } from "node:test"`,
  `import { KEYBOARD_CLOSE_DELTA, keyboardLikelyOpen } from "../ui/src/mobile/useMobileViewport.ts"`,
  ``,
  `test("键盘弹出：高度差 > 120 且比例 < 0.82", () => {`,
  `  assert.equal(keyboardLikelyOpen(844, 508), true)`,
  `  assert.equal(keyboardLikelyOpen(844, 760), false)`,
  `})`,
  ``,
  `test("收起阈值是 48", () => {`,
  `  assert.equal(KEYBOARD_CLOSE_DELTA, 48)`,
  `})`,
  ``,
].join("\n")

/*
 * edit 工具结果的 details.patch（G5：transcript 把它提升到工具块的 patch / firstChangedLine）。
 * viewport 两次：用 pi 1.3.0 自己的 generateUnifiedPatch（edit-diff.js，context 4、只有 ---/+++ 文件头）
 * 从 replica b/mockFiles.ts 的 VIEWPORT_V0 → V1 → V2 生成，firstChangedLine 同 pi 的 generateDiffString。
 * MobileConversation 一次：replica 手写的 CONVERSATION_PATCH（只有这一段，没有整文件），文件头改成 pi 的写法。
 * 三段合计 viewport +16 −6、MobileConversation +4 −3，加上 write 的 +12 就是 replica 的 +32 −9。
 * 入参（oldText / newText）照 replica mockConvo 原样保留，是 patch 的节选。
 */
export const VIEWPORT_PATCH_1 = [
  `--- ${VIEWPORT_PATH}`,
  `+++ ${VIEWPORT_PATH}`,
  "@@ -30,8 +30,9 @@",
  " ",
  " export function useMobileViewport(enabled: boolean): MobileViewport {",
  "   const [state, setState] = useState<MobileViewport>(readViewport)",
  "   const closeTimer = useRef<number | null>(null)",
  "+  const focused = useRef(false)",
  " ",
  "   useEffect(() => {",
  "     if (!enabled) return",
  "     const vv = window.visualViewport",
  "@@ -46,9 +47,9 @@",
  "     const update = () => {",
  "       const height = vv.height",
  "       const offsetTop = vv.offsetTop",
  "       const delta = window.innerHeight - height",
  "-      if (keyboardLikelyOpen(window.innerHeight, height)) {",
  "+      if (focused.current && keyboardLikelyOpen(window.innerHeight, height)) {",
  "         clearClose()",
  "         setState({ height, offsetTop, keyboardOpen: true })",
  "         return",
  "       }",
  "@@ -62,10 +63,17 @@",
  "       }",
  "       setState({ height, offsetTop, keyboardOpen: state.keyboardOpen })",
  "     }",
  " ",
  "-    const onFocusIn = () => update()",
  "-    const onFocusOut = () => update()",
  "+    const onFocusIn = (e: FocusEvent) => {",
  "+      const t = e.target as HTMLElement | null",
  '+      focused.current = !!t && (t.tagName === "TEXTAREA" || t.isContentEditable)',
  "+      update()",
  "+    }",
  "+    const onFocusOut = () => {",
  "+      focused.current = false",
  "+      update()",
  "+    }",
  " ",
  '     vv.addEventListener("resize", update)',
  '     vv.addEventListener("scroll", update)',
  '     document.addEventListener("focusin", onFocusIn)',
  "",
].join("\n")
export const VIEWPORT_PATCH_2 = [
  `--- ${VIEWPORT_PATH}`,
  `+++ ${VIEWPORT_PATH}`,
  "@@ -52,17 +52,19 @@",
  "         clearClose()",
  "         setState({ height, offsetTop, keyboardOpen: true })",
  "         return",
  "       }",
  "-      if (delta < KEYBOARD_CLOSE_DELTA) {",
  "+      // 收起分两步：高度差回落后，还要等 offsetTop 回到 0 再判定",
  "+      if (delta < KEYBOARD_CLOSE_DELTA && offsetTop <= 1) {",
  "         clearClose()",
  "         closeTimer.current = window.setTimeout(() => {",
  "           closeTimer.current = null",
  "-          setState({ height, offsetTop, keyboardOpen: false })",
  "+          setState({ height: vv.height, offsetTop: vv.offsetTop, keyboardOpen: false })",
  "         }, KEYBOARD_CLOSE_DEBOUNCE_MS)",
  "         return",
  "       }",
  "-      setState({ height, offsetTop, keyboardOpen: state.keyboardOpen })",
  "+      // 去抖期间沿用上一次的位置，只更新高度和偏移",
  "+      setState((prev) => ({ ...prev, height, offsetTop }))",
  "     }",
  " ",
  "     const onFocusIn = (e: FocusEvent) => {",
  "       const t = e.target as HTMLElement | null",
  "",
].join("\n")
export const CONVERSATION_PATCH = [
  `--- ${CONVERSATION_PATH}`,
  `+++ ${CONVERSATION_PATH}`,
  "@@ -61,9 +61,10 @@",
  "   const dockRef = useRef<HTMLDivElement>(null)",
  "   const keyboardOpen = viewport.keyboardOpen",
  " ",
  "-  const dockStyle = keyboardOpen",
  "-    ? { transform: `translateY(${viewport.offsetTop}px)` }",
  "-    : undefined",
  "+  // 键盘开着时按可视视口贴底；收起后清掉平移，避免残留一帧",
  "+  const dockStyle: CSSProperties = keyboardOpen",
  "+    ? { height: viewport.height, transform: `translateY(${viewport.offsetTop}px)` }",
  '+    : { transform: "none" }',
  " ",
  "   return (",
  '     <div className="mobile-conversation" style={{ height: keyboardOpen ? viewport.height : undefined }}>',
  "",
].join("\n")

/** r-s1 更早的回合：replica EDIT_RECORDS 的前三次编辑（write 新测试、viewport 第一次、MobileConversation 一次） */
export const CONVO_EARLIER: Item[] = [
  { kind: "user", key: "u-r1-30", text: "先补一个键盘判定的测试，再让 dock 跟着可视视口走。", images: [], timestamp: NOW - 26 * M, from: "remote", status: "delivered" },
  assistant("a-r1-31", NOW - 26 * M + 2 * S, 48 * S, "stop", [
    tool("toolu_01W3n8", "write", { path: KEYBOARD_TEST_PATH, content: KEYBOARD_TEST_CONTENT }, `Wrote 12 lines to ${KEYBOARD_TEST_PATH}`),
    tool(
      "toolu_01Kp2q",
      "edit",
      {
        path: VIEWPORT_PATH,
        edits: [
          { oldText: "      if (keyboardLikelyOpen(window.innerHeight, height)) {", newText: "      if (focused.current && keyboardLikelyOpen(window.innerHeight, height)) {" },
          {
            oldText: "    const onFocusIn = () => update()\n    const onFocusOut = () => update()",
            newText:
              "    const onFocusIn = (e: FocusEvent) => {\n      const t = e.target as HTMLElement | null\n      focused.current = !!t && (t.tagName === \"TEXTAREA\" || t.isContentEditable)\n      update()\n    }\n    const onFocusOut = () => {\n      focused.current = false\n      update()\n    }",
          },
        ],
      },
      `Successfully replaced 2 blocks in ${VIEWPORT_PATH}.`,
      { patch: VIEWPORT_PATCH_1, firstChangedLine: 34 },
    ),
    tool(
      "toolu_01Rz7c",
      "edit",
      {
        path: CONVERSATION_PATH,
        oldText: "  const dockStyle = keyboardOpen\n    ? { transform: `translateY(${viewport.offsetTop}px)` }\n    : undefined",
        newText:
          "  // 键盘开着时按可视视口贴底；收起后清掉平移，避免残留一帧\n  const dockStyle: CSSProperties = keyboardOpen\n    ? { height: viewport.height, transform: `translateY(${viewport.offsetTop}px)` }\n    : { transform: \"none\" }",
      },
      `Successfully replaced text in ${CONVERSATION_PATH}.`,
      { patch: CONVERSATION_PATCH, firstChangedLine: 64 },
    ),
    { kind: "text", text: "测试和 dock 的贴底都改好了。" },
  ]),
]

const TEST_OUTPUT = [
  "> pi-remote-ui@0.9.0 test",
  "> node scripts/test.mjs mobile",
  "",
  "✔ 键盘弹出：高度差 > 120 且比例 < 0.82 (0.8ms)",
  "✔ 收起要等 offsetTop 回到 0 (1.1ms)",
  "✔ 去抖 120ms 内保持 dock 位置 (121.4ms)",
  "ℹ tests 23",
  "ℹ pass 23",
  "ℹ fail 0",
  "ℹ duration_ms 812.5",
].join("\n")

/** r-s1 最后一个已完成回合（replica CONVO_DONE）：用户卡带 1 张网页截图 → 思考 → 2 grep + find + read → 正文 → edit → bash → 收尾 */
export const CONVO_DONE: Item[] = [
  {
    kind: "user",
    key: "u-r1-46",
    text: "手机上键盘收起时输入框会跳一下，帮我看看 useMobileViewport 的判定。",
    // 原图没有随快照下发（omitted），按 entryId + blockIndex 用 get_image 取；fixture 不带像素
    images: [{ data: "", mimeType: "image/png", omitted: true, bytes: 182_400, entryId: "u-r1-46", blockIndex: 1 }],
    timestamp: NOW - 259 * S,
    from: "remote",
    cid: "c-8f2k1",
    status: "delivered",
  },
  assistant(
    "a-r1-47",
    NOW - 257 * S,
    21 * S,
    "toolUse",
    [
      { kind: "thinking", text: "**定位收起时的跳动**\n\n用户说收起键盘时输入框会跳一下。先找 visualViewport 的监听和收起判定，看是不是去抖之前就把 dock 放回了底部。" },
      tool("toolu_01Gr1a", "grep", { pattern: "visualViewport", path: "ui/src" }, "ui/src/mobile/useMobileViewport.ts:18\nui/src/mobile/useMobileViewport.ts:39\nui/src/mobile/MobileConversation.tsx:64"),
      tool("toolu_01Gr1b", "grep", { pattern: "KEYBOARD_CLOSE", path: "ui/src" }, "ui/src/mobile/useMobileViewport.ts:6\nui/src/mobile/useMobileViewport.ts:7"),
      tool("toolu_01Fd1c", "find", { pattern: "*Viewport*", path: "ui/src" }, "ui/src/mobile/useMobileViewport.ts\nui/src/mobile/MobileViewportProvider.tsx\nui/src/mobile/viewportModel.ts"),
      tool("toolu_01Rd1d", "read", { path: VIEWPORT_PATH }, "…"),
    ],
    18_420,
  ),
  assistant(
    "a-r1-48",
    NOW - 235 * S,
    41 * S,
    "toolUse",
    [
      {
        kind: "text",
        text: "收起判定只看了高度差，没等 `visualViewport.offsetTop` 回落：iOS 收键盘时高度先恢复、偏移后归零，中间这一帧 dock 被放回底部又被顶上去，所以会跳一下。改成两步：\n\n1. 高度差回落后，再等 `offsetTop` 回到 0 才判定收起；\n2. 去抖期间沿用上一次的位置，只更新高度和偏移。",
      },
      tool(
        "toolu_01Hd5v",
        "edit",
        { path: VIEWPORT_PATH, oldText: "      if (delta < KEYBOARD_CLOSE_DELTA) {", newText: "      if (delta < KEYBOARD_CLOSE_DELTA && offsetTop <= 1) {" },
        `Successfully replaced text in ${VIEWPORT_PATH}.`,
        { patch: VIEWPORT_PATCH_2, firstChangedLine: 56 },
      ),
      tool("toolu_01Bs1e", "bash", { command: "npm test -- mobile" }, TEST_OUTPUT, { exitCode: 0 }),
    ],
    24_100,
  ),
  assistant(
    "a-r1-49",
    NOW - 151 * S,
    26 * S,
    "stop",
    [
      {
        kind: "text",
        text: `## 改动\n\n- \`${VIEWPORT_PATH}\`：收起判定加上 \`offsetTop <= 1\`，等偏移回到 0 再去抖\n- 去抖期间改用函数式 \`setState\`，不再读到旧的 \`state\`\n- 超时回调里改读 \`vv.height\` / \`vv.offsetTop\` 的最新值\n\n## 测试\n\n- ✅ \`npm test -- mobile\`：23 个用例全部通过`,
      },
    ],
    29_600,
  ),
]

/** r-s1 全部条目（更早回合 + 最后完成的回合） */
export const R1_ITEMS: Item[] = [...CONVO_EARLIER, ...CONVO_DONE]

export const LIVE_TEST_ID = "toolu_01Tt9k"
export const LIVE_LINT_ID = "toolu_01Ln8j"
export const LIVE_DIFF_ID = "toolu_01Gd7h"
const GIT_DIFF_STAT = [
  ` ${CONVERSATION_PATH} |  7 ++++---`,
  ` ${VIEWPORT_PATH}   | 22 ++++++++++++++++------`,
  ` ${KEYBOARD_TEST_PATH}        | 12 ++++++++++++`,
  ` 3 files changed, 32 insertions(+), 9 deletions(-)`,
].join("\n")
const LIVE_TEST_OUTPUT = [
  "> pi-remote-ui@0.9.0 test",
  "> node scripts/test.mjs mobile --grep 横屏",
  "",
  "▶ 横屏键盘",
  "  ✔ 横屏弹出键盘时 vv.height ≈ 320 仍判定为打开 (0.9ms)",
  "  ✔ 横屏收起后 offsetTop 回到 0 (1.2ms)",
  "  ✔ composer 贴住键盘上沿 (2.4ms)",
  "  ▶ 旋转回竖屏后重新计算 dock 高度",
  "    · 等待 visualViewport resize…",
].join("\n")
const LINT_STDOUT = "> pi-remote-ui@0.9.0 lint\n> eslint ui/src test"
const LINT_STDERR = "ui/src/mobile/MobileConversation.tsx:61:9  error  'dockRef' is assigned a value but never used  @typescript-eslint/no-unused-vars\n✖ 1 problem (1 error, 0 warnings)"

/** 接在 CONVO_DONE 后的运行中回合（replica CONVO_LIVE）：a-r1-52 是 live 消息，最后一条 bash 还在跑 */
export const CONVO_LIVE: Item[] = [
  { kind: "user", key: "u-r1-50", text: "顺便把横屏也测一下，键盘弹出时 composer 要贴住。", images: [], timestamp: NOW - 42 * S, from: "remote", cid: "c-9a3m7", status: "delivered" },
  assistant(
    "a-r1-51",
    NOW - 41 * S,
    9 * S,
    "toolUse",
    [
      { kind: "thinking", text: "**确认横屏下的可视视口**\n\n横屏时 visualViewport.height 只有 320 左右，0.82 的比例判定可能误报。先看 MobileConversation 怎么用 offsetTop 摆 dock，再跑一遍横屏用例；调用方交给 explorer 去梳理。" },
      tool("toolu_01Td2a", "todo", {
        todos: [
          { content: "确认横屏下 visualViewport 的取值", status: "in_progress" },
          { content: "看 MobileConversation 怎么摆 dock", status: "pending" },
          { content: "跑横屏用例", status: "pending" },
          { content: "补横屏键盘贴底的测试", status: "pending" },
        ],
      }),
      tool("toolu_01Rd2b", "read", { path: CONVERSATION_PATH, offset: 40, limit: 79 }, "…"),
    ],
    31_200,
  ),
  {
    kind: "assistant",
    key: "a-r1-52",
    model: MODEL,
    startedAt: NOW - 32 * S,
    timestamp: NOW - 32 * S,
    live: true,
    blocks: [
      { kind: "text", text: "横屏时 dock 用的也是 `offsetTop`，判定本身没问题。先看看改动、跑一下 lint 和横屏用例：" },
      tool(LIVE_DIFF_ID, "bash", { command: "git diff --stat" }, GIT_DIFF_STAT, { exitCode: 0 }),
      tool(LIVE_LINT_ID, "bash", { command: "npm run lint" }, LINT_STDOUT, { state: "output-error", exitCode: 1, stderr: LINT_STDERR }),
      tool(LIVE_TEST_ID, "bash", { command: "npm test -- mobile --grep 横屏" }, LIVE_TEST_OUTPUT, { state: "input-available" }),
    ],
  },
]

/** 运行中的 r-s1（conversation-streaming / task-panel / terminal-pane / queue-panel） */
export const R1_STREAMING_ITEMS: Item[] = [...R1_ITEMS, ...CONVO_LIVE]

/** terminalItems（与 CONVO_LIVE 的 3 条 bash 同源；replica TERMINALS） */
export const TERMINALS: TerminalItem[] = [
  { id: LIVE_DIFF_ID, toolName: "bash", command: "git diff --stat", startedAt: NOW - 30 * S, endedAt: NOW - 30 * S + 400, durationMs: 400, state: "succeeded", exitCode: 0, output: GIT_DIFF_STAT, outputTruncated: false, inferredEnd: false },
  { id: LIVE_LINT_ID, toolName: "bash", command: "npm run lint", startedAt: NOW - 29_500, endedAt: NOW - 25 * S, durationMs: 4_500, state: "failed", exitCode: 1, output: LINT_STDOUT, stderr: LINT_STDERR, outputTruncated: false, inferredEnd: false },
  { id: LIVE_TEST_ID, toolName: "bash", command: "npm test -- mobile --grep 横屏", startedAt: NOW - 25 * S, endedAt: null, durationMs: null, state: "running", output: LIVE_TEST_OUTPUT, outputTruncated: false, inferredEnd: false },
]

/** task_list_state（replica TASKS：2 完成 / 1 进行中 / 1 待做） */
export const TASKS: TaskListItem[] = [
  { id: "t1", content: "确认横屏下 visualViewport 的取值", status: "completed" },
  { id: "t2", content: "看 MobileConversation 怎么摆 dock", status: "completed" },
  { id: "t3", content: "跑横屏用例", status: "in_progress", activeForm: "正在跑横屏用例" },
  { id: "t4", content: "补横屏键盘贴底的测试", status: "pending" },
]

/** agent_state（replica LIVE_SUBAGENTS）：目前产品里没有生产者，fixture 照 AgentEntry 形状写一条 */
export const AGENTS: AgentEntry[] = [
  {
    id: "ag-1",
    seq: 1,
    name: "explorer",
    status: "running",
    task: "梳理 useMobileViewport 的调用方",
    description: "",
    startedAt: NOW - 36 * S,
    endedAt: null,
    durationMs: null,
    currentActivity: "",
    finalOutput: "",
    error: "",
    model: "",
    mode: "",
    step: null,
  },
]

/** remote_queue_state（replica C_REMOTE_QUEUE）：q1 等这轮结束、q2 已插入当前回合 */
export const REMOTE_QUEUE: RemoteQueueState = {
  rev: 12,
  items: [
    { id: "q1", segment: "follow_up", source: "web", text: "测完把 README 里的键盘说明也补上", images: [], status: "pending", at: NOW - 40 * S },
    { id: "q2", segment: "steer", source: "web", text: "先别动 shell.css", images: [], status: "injected", at: NOW - 38 * S, injectedAt: NOW - 32 * S },
  ],
}
/** queue_update（本机终端里排的，只读；replica C_HOST_QUEUE） */
export const HOST_QUEUE: Relay["queue"] = {
  steering: [],
  followUp: [{ role: "user", content: [{ type: "text", text: "跑一下 lint" }], timestamp: NOW - 25 * S }],
}

/* ---------------- r-s3：等你回答（replica mockOther APPROVAL_DIALOG / CONVO_APPROVAL） ---------------- */

export const BACKFILL_TEST = [
  `import assert from "node:assert/strict"`,
  `import { test } from "node:test"`,
  `import { planBackfill } from "../ui/src/relay/history.ts"`,
  ``,
  `test("截断：只补到渲染窗的上沿", () => {`,
  `  const plan = planBackfill({ loaded: 300, total: 420, window: 300 })`,
  `  assert.deepEqual(plan, { from: 0, count: 120, truncated: true })`,
  `})`,
  ``,
  `test("到顶：没有更早的消息时不再请求", () => {`,
  `  assert.equal(planBackfill({ loaded: 42, total: 42, window: 300 }), null)`,
  `})`,
  ``,
].join("\n")

export const APPROVAL_DIALOG: DialogCard = {
  dialogId: "dlg-7f3",
  kind: "select",
  title: "允许 pi 运行这条命令吗？",
  message: "npm test -- history-backfill",
  options: ["允许一次", "这个会话里都允许", "拒绝"],
  timeout: 120_000,
  startedAt: NOW - 38 * S,
  answerable: true,
}

export const CONVO_APPROVAL: Item[] = [
  { kind: "user", key: "u-r3-6", text: "给 history-backfill 补几个测试，覆盖截断和补拉到顶两种情况。", images: [], timestamp: NOW - 190 * S, from: "remote", status: "delivered" },
  assistant("a-r3-7", NOW - 188 * S, 14 * S, "toolUse", [
    { kind: "thinking", text: "先读 history.ts 里的补拉规划函数，确认截断和到顶分别返回什么。" },
    tool("toolu_02Rd1a", "read", { path: "ui/src/relay/history.ts", offset: 1, limit: 160 }, "…"),
  ], 12_800),
  assistant("a-r3-8", NOW - 172 * S, 30 * S, "toolUse", [
    { kind: "text", text: "两种情况都能在 `planBackfill` 里直接构造，写成一个新测试文件：" },
    tool("toolu_02Wr1b", "write", { path: "test/history-backfill.test.mjs", content: BACKFILL_TEST }, "Wrote 12 lines to test/history-backfill.test.mjs"),
  ], 15_300),
  {
    kind: "assistant",
    key: "a-r3-9",
    model: MODEL,
    startedAt: NOW - 41 * S,
    timestamp: NOW - 41 * S,
    live: true,
    blocks: [
      { kind: "text", text: "跑一下这个文件：" },
      // 现在的协议里被确认框挡住的工具块停在 input-available（显示成运行中）；replica 画的 waiting_approval 没有数据源（缺口 G6）
      tool("toolu_02Bs1c", "bash", { command: "npm test -- history-backfill" }, "", { state: "input-available" }),
    ],
  },
]

/* ---------------- r-s6：对话里的错误（replica CONVO_ERRORS） ---------------- */

export const CONVO_ERRORS: Item[] = [
  { kind: "user", key: "u-r6-9", text: "跑一下对账脚本，对一下 9 月的退款。", images: [], timestamp: NOW - 44 * M, from: "remote", status: "delivered" },
  assistant("a-r6-10", NOW - 44 * M + 2 * S, 6 * S, "toolUse", [
    { kind: "text", text: "先跑对账脚本：" },
    tool("toolu_03Bs1a", "bash", { command: "node scripts/reconcile.mjs --month 2026-09" }, "Reconciling refunds for 2026-09…\nConnecting to postgres://127.0.0.1:5432/billing", {
      state: "output-error",
      exitCode: 1,
      stderr: "Error: connect ECONNREFUSED 127.0.0.1:5432",
    }),
  ], 9_400),
  assistant("a-r6-11", NOW - 43 * M, 8 * S, "toolUse", [
    { kind: "text", text: "本机的 Postgres 没起来。先清掉上次导出的临时文件，再直接跑一遍检查 SQL：" },
    tool("toolu_03Bs1b", "bash", { command: "rm -rf tmp/exports" }, "Tool execution was blocked: 用户拒绝了这条命令", { state: "output-error", outcome: "denied" }),
    tool("toolu_03Bs1c", "bash", { command: "psql -f checks.sql", timeout: 120 }, "Command timed out after 120 seconds", { state: "output-error", outcome: "timeout" }),
  ], 10_900),
  // replica 在这里有一条"自动重试 3/3 都没成功"收据（kind: "receipt"）：relay 的 Item 没有这一类（缺口 G8）
  { kind: "assistant", key: "a-r6-13", model: MODEL, startedAt: NOW - 38 * M - 12 * S, durationMs: 2 * S, endedAt: NOW - 38 * M - 10 * S, timestamp: NOW - 38 * M - 12 * S, stopReason: "error", errorMessage: "overloaded_error", blocks: [] },
  { kind: "user", key: "u-r6-14", text: "数据库起来了，再试一次", images: [], timestamp: NOW - 37 * M, from: "remote", cid: "c-2b7q0", status: "sending", failed: "ack timeout" },
]

/* ---------------- r-s8：离线设备上的最后快照（replica CONVO_OFFLINE） ---------------- */

export const CONVO_OFFLINE: Item[] = [
  { kind: "user", key: "u-r8-24", text: "导出地图时 tiles 的坐标偏了半格，看一下 exporter。", images: [], timestamp: NOW - 27 * H - 6 * M, from: "local" },
  assistant("a-r8-25", NOW - 27 * H - 5 * M, 48 * S, "stop", [
    { kind: "thinking", text: "坐标偏半格，多半是像素中心和格子左上角混用了。" },
    tool("toolu_05Rd1a", "read", { path: "src/export/tiles.ts", offset: 1, limit: 140 }, "…"),
    { kind: "text", text: "找到了：`toTileCoord` 用的是像素中心，导出时又加了半格偏移。" },
  ], 14_200),
]

/* ---------------- 连接基线 ---------------- */

/** 已连上、看着 MacBook Pro 上 r-s1 的基线（多数屏在它上面改几项） */
export const BASE: Partial<Relay> = {
  token: "fixture-viewer-token",
  authed: true,
  status: "已连接",
  everConnected: true,
  retryAt: null,
  retryCount: 0,
  trying: false,
  authError: "",
  serverProto: 4,
  serverCaps: ["device.token", "msg.cid"],
  canManageDevices: true,
  deviceMode: true,
  devices: DEVICES,
  rooms: ROOMS,
  sessionsByDevice: SESSIONS_BY_DEVICE,
  sessionsLoading: false,
  sessionsTruncated: false,
  selectedDeviceId: "d-mbp",
  roomId: "r-s1",
  online: true,
  roomDown: false,
  busy: false,
  snapshotPending: false,
  turnEnd: null,
  roomTurnEnds: ROOM_TURN_ENDS,
  uiPrompt: null,
  dialogs: [],
  dialogReceipts: [],
  model: MODEL,
  modelMeta: MODEL_META,
  thinkingLevel: THINKING_LEVEL,
  usage: USAGE,
  sendMode: "steer",
  draft: "",
  pendingImages: [],
  pendingFiles: [],
  transcript: transcriptOf(R1_ITEMS),
  taskList: [],
  terminalItems: [],
  agentState: [],
  queue: { steering: [], followUp: [] },
  remoteQueue: { rev: 0, items: [] },
}

/** r-s1 运行中（conversation-streaming / task-panel / terminal-pane / queue-panel 共用）：回合在跑、最后一条 bash 还没结束 */
export const STREAMING: Partial<Relay> = {
  ...BASE,
  busy: true,
  rooms: roomsWith({ "r-s1": { busy: true, lastActivity: NOW - 25 * S } }),
  activity: "正在运行 npm test -- mobile --grep 横屏",
  transcript: transcriptOf(R1_STREAMING_ITEMS, "a-r1-52"),
  taskList: TASKS,
  terminalItems: TERMINALS,
  agentState: AGENTS,
}

/** runCommand 的回包表：命令名 → 回包；没写的命令按 relay 的 unknown_command 拒绝 */
export function commandTable(table: Record<string, unknown>): Relay["runCommand"] {
  return async (command: string) => {
    if (command in table) return table[command]
    throw Object.assign(new Error(`fixture 没有 ${command} 的回包`), { code: "unknown_command" })
  }
}
