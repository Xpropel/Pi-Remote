/**
 * s3/terminal-held：两条命令 3 分钟前结束（早过了保留期：成功 30 秒、失败 60 秒），右侧终端视图打开。
 * 终端视图列本会话跑过的命令、不按保留期移出：两条都有实时条目，用实时条目（带耗时、退出码）；以前这里是空态「还没有运行命令」。
 */
import type { Block, Item } from "../../../../relay/transcript.ts"
import type { TerminalItem } from "../../../../chat/capsules/terminalModel.ts"
import { BASE, tool, transcriptOf } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const S = 1000
const M = 60 * S
const T0 = MOCK_NOW - 3 * M
const MODEL = "claude-sonnet-4-5"

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

const FAILED = [
  `✔ 普通价格 (0.4ms)`,
  `✖ 千分位 (0.6ms)`,
  `  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:`,
  `  + '¥12345.00'`,
  `  - '¥12,345.00'`,
  `ℹ tests 2`,
  `ℹ pass 1`,
  `ℹ fail 1`,
  ``,
].join("\n")
const PASSED = [`✔ 普通价格 (0.4ms)`, `✔ 千分位 (0.5ms)`, `ℹ tests 2`, `ℹ pass 2`, `ℹ fail 0`, ``].join("\n")

const ITEMS: Item[] = [
  { kind: "user", key: "u-s3h-1", text: "把千分位修好，跑测试确认", images: [], timestamp: T0, from: "remote", status: "delivered" },
  assistant("a-s3h-2", T0 + 2 * S, 4 * S, "toolUse", [
    { kind: "text", text: "先跑一遍看现状：" },
    tool("t-s3h-test1", "bash", { command: "node --test format.test.js" }, `${FAILED}\nCommand exited with code 1`, { state: "output-error" }),
  ]),
  assistant("a-s3h-3", T0 + 9 * S, 5 * S, "toolUse", [
    { kind: "text", text: "千分位没处理，`formatPrice` 里补上 `toLocaleString` 再跑：" },
    tool("t-s3h-test2", "bash", { command: "node --test format.test.js" }, PASSED),
  ]),
  assistant("a-s3h-4", T0 + 16 * S, 4 * S, "stop", [{ kind: "text", text: "修好了，2 个测试都通过。" }], 5_600),
]

const TERMINALS: TerminalItem[] = [
  {
    id: "t-s3h-test1",
    toolName: "bash",
    command: "node --test format.test.js",
    startedAt: T0 + 3 * S,
    endedAt: T0 + 3 * S + 900,
    durationMs: 900,
    state: "failed",
    exitCode: 1,
    output: FAILED,
    outputTruncated: false,
    inferredEnd: false,
  },
  {
    id: "t-s3h-test2",
    toolName: "bash",
    command: "node --test format.test.js",
    startedAt: T0 + 11 * S,
    endedAt: T0 + 11 * S + 700,
    durationMs: 700,
    state: "succeeded",
    exitCode: 0,
    output: PASSED,
    outputTruncated: false,
    inferredEnd: false,
  },
]

const fixture: PiLiveFixture = {
  id: "s3-terminal-held",
  now: MOCK_NOW,
  note: "S3 第四轮：结束 3 分钟的两条命令（过了保留期）在终端视图里照列（用实时条目，带耗时），不再变成「还没有运行命令」的空态。",
  relay: {
    ...BASE,
    transcript: transcriptOf(ITEMS),
    terminalItems: TERMINALS,
  },
}
export default fixture
