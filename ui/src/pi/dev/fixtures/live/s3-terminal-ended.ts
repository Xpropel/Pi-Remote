/**
 * s3/terminal-ended：命令几分钟前就跑完了、页面重开过（relay 只补回 60 秒内结束的命令），右侧终端视图打开。
 * terminalItems 是空的：终端视图从对话里的三张命令卡重建历史（terminalModel 的 terminalSessionItems），
 * 失败那条照流里的卡写「失败 · 退出 1」；重建的条目没有起止时刻，不写耗时。第四轮这里还是空态「都已结束」。
 */
import type { Block, Item } from "../../../../relay/transcript.ts"
import { BASE, tool, transcriptOf } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const S = 1000
const M = 60 * S
const T0 = MOCK_NOW - 8 * M
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
  `✔ 加入购物车 (0.5ms)`,
  `✖ 合计金额 (0.4ms)`,
  `  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:`,
  `  + 29.9`,
  `  - 30`,
  `✔ 空购物车 (0.1ms)`,
  `ℹ tests 3`,
  `ℹ pass 2`,
  `ℹ fail 1`,
].join("\n")
const PASSED = [`✔ 加入购物车 (0.5ms)`, `✔ 合计金额 (0.2ms)`, `✔ 空购物车 (0.1ms)`, `ℹ tests 3`, `ℹ pass 3`, `ℹ fail 0`, ``].join("\n")

const ITEMS: Item[] = [
  { kind: "user", key: "u-s3t-1", text: "跑一下测试和 lint", images: [], timestamp: T0, from: "remote", status: "delivered" },
  assistant("a-s3t-2", T0 + 2 * S, 5 * S, "toolUse", [
    { kind: "text", text: "先跑测试：" },
    tool("t-s3t-test1", "bash", { command: "node --test" }, `${FAILED}\n\nCommand exited with code 1`, { state: "output-error" }),
  ]),
  assistant("a-s3t-3", T0 + 9 * S, 4 * S, "toolUse", [
    { kind: "text", text: "合计金额少了运费，`total()` 里加上再跑：" },
    tool("t-s3t-test2", "bash", { command: "node --test" }, PASSED),
  ]),
  assistant("a-s3t-4", T0 + 15 * S, 3 * S, "toolUse", [tool("t-s3t-lint", "bash", { command: "npx eslint ." }, "")]),
  assistant("a-s3t-5", T0 + 20 * S, 4 * S, "stop", [{ kind: "text", text: "修好了：3 个测试都通过，lint 也没有报错。" }], 4_200),
]

const fixture: PiLiveFixture = {
  id: "s3-terminal-ended",
  now: MOCK_NOW,
  note: "S3 第五轮：命令早已结束、页面重开后 terminalItems 为空；终端视图从对话里的命令卡重建出 3 条（失败那条写退出码，不写耗时）。",
  relay: {
    ...BASE,
    transcript: transcriptOf(ITEMS),
    terminalItems: [],
  },
}
export default fixture
