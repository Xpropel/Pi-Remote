/**
 * b 区 mock：r-s1"修复手机键盘收起时输入框跳动"（MacBook Pro/pi-remote）的转录、终端、任务、文件。
 * 形状照 ui/src/relay 的 Item / Block、TerminalItem、TaskListItem；时间都按 NOW 算（= shared MOCK_NOW，§3.2）。
 * 一个回合 = 一条用户消息 + 几条 assistant 消息（pi 每次调模型是一条 AssistantMessage，工具结果并进对应的工具块）。
 */
import { EDIT_VIEWPORT_2, GIT_DIFF_STAT, VIEWPORT_V1_TEXT, VIEWPORT_V2_TEXT } from "@/pi/dev/fixtures/gallery/bChanges"
import { CONVERSATION_PATH, VIEWPORT_PATH } from "@/pi/dev/fixtures/gallery/bFiles"
import type { PiFileResult, PiItem, PiSubagent, PiTaskListItem, PiTerminalItem, PiToolBlock } from "@/components/pi/shared/types"

/** = components/pi/shared/mock.ts 的 MOCK_NOW：2026-10-24 10:42（+08:00） */
export const NOW = 1792809720000
const S = 1000

export function tool(
  id: string,
  name: string,
  input: Record<string, unknown>,
  outputText = "",
  extra: Partial<PiToolBlock> = {},
): PiToolBlock {
  return { kind: "tool", id, name, argsText: JSON.stringify(input), input, outputText, state: "output-available", ...extra }
}

const MODEL = "claude-sonnet-4-5"

/* ------------------------------------------------------------------ CONVO_DONE：已完成的一个回合 */

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

export const CONVO_DONE: PiItem[] = [
  {
    kind: "user",
    key: "u-r1-46",
    text: "手机上键盘收起时输入框会跳一下，帮我看看 useMobileViewport 的判定。",
    images: [{ data: "", mimeType: "image/png", bytes: 182_400, aspect: 390 / 844 }],
    timestamp: NOW - 259 * S,
    from: "remote",
    cid: "c-8f2k1",
    status: "delivered",
  },
  {
    kind: "assistant",
    key: "a-r1-47",
    model: MODEL,
    startedAt: NOW - 257 * S,
    durationMs: 21 * S,
    timestamp: NOW - 257 * S,
    usage: { totalTokens: 18_420 },
    stopReason: "toolUse",
    blocks: [
      {
        kind: "thinking",
        observedMs: 6 * S,
        text: "**定位收起时的跳动**\n\n用户说收起键盘时输入框会跳一下。先找 visualViewport 的监听和收起判定，看是不是去抖之前就把 dock 放回了底部。",
      },
      tool("toolu_01Gr1a", "grep", { pattern: "visualViewport", path: "ui/src" }, "ui/src/mobile/useMobileViewport.ts:18\nui/src/mobile/useMobileViewport.ts:39\nui/src/mobile/MobileConversation.tsx:64"),
      tool("toolu_01Gr1b", "grep", { pattern: "KEYBOARD_CLOSE", path: "ui/src" }, "ui/src/mobile/useMobileViewport.ts:6\nui/src/mobile/useMobileViewport.ts:7"),
      tool("toolu_01Fd1c", "find", { pattern: "*Viewport*", path: "ui/src" }, "ui/src/mobile/useMobileViewport.ts\nui/src/mobile/MobileViewportProvider.tsx\nui/src/mobile/viewportModel.ts"),
      tool("toolu_01Rd1d", "read", { path: VIEWPORT_PATH }, VIEWPORT_V1_TEXT),
    ],
  },
  {
    kind: "assistant",
    key: "a-r1-48",
    model: MODEL,
    startedAt: NOW - 235 * S,
    durationMs: 41 * S,
    timestamp: NOW - 235 * S,
    usage: { totalTokens: 24_100 },
    stopReason: "toolUse",
    blocks: [
      {
        kind: "text",
        text: "收起判定只看了高度差…",
        prose: [
          {
            p: [
              "收起判定只看了高度差，没等 ",
              { code: "visualViewport.offsetTop" },
              " 回落：iOS 收键盘时高度先恢复、偏移后归零，中间这一帧 dock 被放回底部又被顶上去，所以会跳一下。改成两步：",
            ],
          },
          { ol: [["高度差回落后，再等 ", { code: "offsetTop" }, " 回到 0 才判定收起；"], ["去抖期间沿用上一次的位置，只更新高度和偏移。"]] },
        ],
      },
      tool(
        "toolu_01Hd5v",
        "edit",
        { path: VIEWPORT_PATH, oldText: "      if (delta < KEYBOARD_CLOSE_DELTA) {", newText: "      if (delta < KEYBOARD_CLOSE_DELTA && offsetTop <= 1) {" },
        "Successfully replaced text in ui/src/mobile/useMobileViewport.ts.",
        { details: { patch: EDIT_VIEWPORT_2 } },
      ),
      tool("toolu_01Bs1e", "bash", { command: "npm test -- mobile" }, TEST_OUTPUT, { exitCode: 0 }),
    ],
  },
  {
    kind: "assistant",
    key: "a-r1-49",
    model: MODEL,
    startedAt: NOW - 151 * S,
    durationMs: 26 * S,
    timestamp: NOW - 151 * S,
    usage: { totalTokens: 29_600 },
    stopReason: "stop",
    blocks: [
      {
        kind: "text",
        text: "改动 / 测试",
        prose: [
          { h: ["改动"] },
          {
            ul: [
              [{ file: VIEWPORT_PATH }, "：收起判定加上 ", { code: "offsetTop <= 1" }, "，等偏移回到 0 再去抖"],
              ["去抖期间改用函数式 ", { code: "setState" }, "，不再读到旧的 ", { code: "state" }],
              ["超时回调里改读 ", { code: "vv.height" }, " / ", { code: "vv.offsetTop" }, " 的最新值"],
            ],
          },
          { h: ["测试"] },
          { ul: [["✅ ", { code: "npm test -- mobile" }, "：23 个用例全部通过"]] },
        ],
      },
    ],
  },
]

/** a 区 session-list 的主区用：r-s1 最后一个回合 */
export const CONVO_SHORT = CONVO_DONE

/* ------------------------------------------------------------------ CONVO_LIVE：接在 CONVO_DONE 后，运行中 */

const LIVE_TEST_ID = "toolu_01Tt9k"
const LIVE_LINT_ID = "toolu_01Ln8j"
const LIVE_DIFF_ID = "toolu_01Gd7h"

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
const LINT_STDERR =
  "ui/src/mobile/MobileConversation.tsx:61:9  error  'dockRef' is assigned a value but never used  @typescript-eslint/no-unused-vars\n✖ 1 problem (1 error, 0 warnings)"

export const CONVO_LIVE: PiItem[] = [
  {
    kind: "user",
    key: "u-r1-50",
    text: "顺便把横屏也测一下，键盘弹出时 composer 要贴住。",
    images: [],
    timestamp: NOW - 42 * S,
    from: "remote",
    cid: "c-9a3m7",
    status: "delivered",
  },
  {
    kind: "assistant",
    key: "a-r1-51",
    model: MODEL,
    startedAt: NOW - 41 * S,
    durationMs: 9 * S,
    timestamp: NOW - 41 * S,
    usage: { totalTokens: 31_200 },
    stopReason: "toolUse",
    blocks: [
      {
        kind: "thinking",
        observedMs: 5 * S,
        text:
          "**确认横屏下的可视视口**\n\n横屏时 visualViewport.height 只有 320 左右，0.82 的比例判定可能误报。先看 MobileConversation 怎么用 offsetTop 摆 dock，再跑一遍横屏用例；调用方交给 explorer 去梳理。",
      },
      // todo 工具不进流：进 tray 的"任务 2/4"和任务面板（§1.5）
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
  },
  {
    kind: "assistant",
    key: "a-r1-52",
    model: MODEL,
    startedAt: NOW - 32 * S,
    durationMs: 2 * S,
    timestamp: NOW - 32 * S,
    usage: { totalTokens: 33_900 },
    stopReason: "toolUse",
    blocks: [
      {
        kind: "text",
        text: "横屏时 dock 也用 offsetTop…",
        prose: [{ p: ["横屏时 dock 用的也是 ", { code: "offsetTop" }, "，判定本身没问题。先看看改动、跑一下 lint 和横屏用例："] }],
      },
      tool(LIVE_DIFF_ID, "bash", { command: "git diff --stat" }, GIT_DIFF_STAT, { exitCode: 0 }),
      tool(LIVE_LINT_ID, "bash", { command: "npm run lint" }, LINT_STDOUT, { state: "output-error", exitCode: 1, stderr: LINT_STDERR }),
      tool(LIVE_TEST_ID, "bash", { command: "npm test -- mobile --grep 横屏" }, LIVE_TEST_OUTPUT, { state: "input-available" }),
    ],
  },
]

/** 流式屏：CONVO_DONE + CONVO_LIVE */
export const CONVO_STREAMING: PiItem[] = [...CONVO_DONE, ...CONVO_LIVE]
export const LIVE_RUNNING = { since: NOW - 42 * S }
export const LIVE_SUBAGENTS: PiSubagent[] = [{ name: "explorer", task: "梳理 useMobileViewport 的调用方", startedAt: NOW - 36 * S }]
/** 流式屏展开的块：本回合的思考块（运行中保持展开，推断）+ 运行中的终端卡 */
export const LIVE_EXPANDED = ["a-r1-51:0", LIVE_TEST_ID]

/* ------------------------------------------------------------------ 终端视图（TerminalItem[]，与 CONVO_LIVE 的 3 条 bash 同源） */

export const TERMINALS: PiTerminalItem[] = [
  {
    id: LIVE_DIFF_ID,
    toolName: "bash",
    command: "git diff --stat",
    startedAt: NOW - 30 * S,
    endedAt: NOW - 30 * S + 400,
    durationMs: 400,
    state: "succeeded",
    exitCode: 0,
    output: GIT_DIFF_STAT,
    outputTruncated: false,
    inferredEnd: false,
  },
  {
    id: LIVE_LINT_ID,
    toolName: "bash",
    command: "npm run lint",
    startedAt: NOW - 29_500,
    endedAt: NOW - 25 * S,
    durationMs: 4_500,
    state: "failed",
    exitCode: 1,
    output: LINT_STDOUT,
    stderr: LINT_STDERR,
    outputTruncated: false,
    inferredEnd: false,
  },
  {
    id: LIVE_TEST_ID,
    toolName: "bash",
    command: "npm test -- mobile --grep 横屏",
    startedAt: NOW - 25 * S,
    endedAt: null,
    durationMs: null,
    state: "running",
    output: LIVE_TEST_OUTPUT,
    outputTruncated: false,
    inferredEnd: false,
  },
]

/* ------------------------------------------------------------------ 任务（task_list_state） */

export const TASKS: PiTaskListItem[] = [
  { id: "t1", content: "确认横屏下 visualViewport 的取值", status: "completed" },
  { id: "t2", content: "看 MobileConversation 怎么摆 dock", status: "completed" },
  { id: "t3", content: "跑横屏用例", status: "in_progress", activeForm: "正在跑横屏用例" },
  { id: "t4", content: "补横屏键盘贴底的测试", status: "pending" },
]

/* ------------------------------------------------------------------ 文件视图（get_file 的结果） */

export const FILE_RESULT: PiFileResult = {
  path: VIEWPORT_PATH,
  size: new TextEncoder().encode(VIEWPORT_V2_TEXT).length,
  mime: "text/typescript",
  encoding: "utf-8",
  truncated: false,
  text: VIEWPORT_V2_TEXT,
}
