/**
 * s3/turn-error：最后一轮以出错结束。出错行写人话"这一轮出错了：模型服务繁忙（529）"，灰字「详情 ›」点开是排好版的错误体，
 * 「重新回答」只挂在这一轮（上一轮成功的回复不挂）；回合以出错结束，所以中途失败的终端卡保持展开。
 */
import type { Block, Item } from "../../../../relay/transcript.ts"
import { BASE, tool, transcriptOf } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const S = 1000
const M = 60 * S
const T0 = MOCK_NOW - 12 * M
const T1 = MOCK_NOW - 3 * M
const MODEL = "claude-sonnet-4-5"

type Extra = { errorMessage?: string; usage?: { totalTokens: number } }
function assistant(key: string, at: number, durationMs: number, stopReason: string, blocks: Block[], extra: Extra = {}): Item {
  return { kind: "assistant", key, model: MODEL, startedAt: at, durationMs, endedAt: at + durationMs, timestamp: at, stopReason, blocks, ...extra }
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
  `Command exited with code 1`,
].join("\n")

const ITEMS: Item[] = [
  { kind: "user", key: "u-s3e-1", text: "format.js 是干什么的？", images: [], timestamp: T0, from: "remote", status: "delivered" },
  assistant("a-s3e-2", T0 + 2 * S, 6 * S, "stop", [{ kind: "text", text: "`format.js` 只有一个 `formatPrice(cents)`：把整数分格式化成 `¥12.30` 这样的价格字符串。" }], {
    usage: { totalTokens: 3_100 },
  }),
  { kind: "user", key: "u-s3e-3", text: "把 format.js 里的 TODO 实现了，跑测试", images: [], timestamp: T1, from: "remote", status: "delivered" },
  assistant("a-s3e-4", T1 + 2 * S, 4 * S, "toolUse", [
    { kind: "text", text: "先跑一遍测试看现状：" },
    tool("t-s3e-test", "bash", { command: "node --test format.test.js" }, FAILED, { state: "output-error" }),
  ]),
  assistant("a-s3e-5", T1 + 8 * S, 2 * S, "toolUse", [tool("t-s3e-read", "read", { path: "format.js" }, "function formatPrice(cents) {\n  // TODO: 千分位\n}\n")]),
  assistant("a-s3e-6", T1 + 12 * S, 1 * S, "error", [], {
    errorMessage:
      '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CV8x2k7QmZbN3pTfHw4Ye"}',
  }),
]

const fixture: PiLiveFixture = {
  id: "s3-turn-error",
  now: MOCK_NOW,
  note: "S3 第三轮：最后一轮以 529 出错结束：人话出错行 + 详情（排好版的错误体）+ 重新回答只挂这一轮；出错结束所以失败卡展开。",
  relay: {
    ...BASE,
    transcript: transcriptOf(ITEMS),
  },
}
export default fixture
