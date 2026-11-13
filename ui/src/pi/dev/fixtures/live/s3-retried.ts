/**
 * s3/retried：出错后点了「重新回答」。pi 的 regenerate 把上一条用户消息原样再发一遍、接在后面成新的一轮（不替换），
 * 流里把出错的那轮折进重试那轮："上次出错，已重试 ›"（点开是当时的过程和出错行，不再带「重新回答」）。
 * 重试那轮里先探查 `ls test` 失败（退出 2）、智能体自己换路跑通：回合成功结束，探查卡收起，只留"失败 · 退出 2"卡头。
 * 出错原文照真实会话（D:\pi-e2e 里 stepfun 的 401）。
 */
import type { Block, Item } from "../../../../relay/transcript.ts"
import { BASE, tool, transcriptOf } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const S = 1000
const M = 60 * S
const T0 = MOCK_NOW - 9 * M
const T1 = MOCK_NOW - 4 * M
const MODEL = "claude-sonnet-4-5"
const ASK = "跑一下测试，挂了就修好"

type Extra = { errorMessage?: string; usage?: { totalTokens: number } }
function assistant(key: string, at: number, durationMs: number, stopReason: string, blocks: Block[], extra: Extra = {}): Item {
  return { kind: "assistant", key, model: MODEL, startedAt: at, durationMs, endedAt: at + durationMs, timestamp: at, stopReason, blocks, ...extra }
}

const PASSED = [`✔ 加入购物车 (0.5ms)`, `✔ 合计金额 (0.2ms)`, `✔ 空购物车 (0.1ms)`, `ℹ tests 3`, `ℹ pass 3`, `ℹ fail 0`, ``].join("\n")

const ITEMS: Item[] = [
  { kind: "user", key: "u-s3r-1", text: ASK, images: [], timestamp: T0, from: "remote", status: "delivered" },
  assistant("a-s3r-2", T0 + 2 * S, 3 * S, "toolUse", [
    { kind: "thinking", text: "先看看项目里的测试文件在哪。" },
    tool("t-s3r-ls0", "ls", { path: "." }, "README.md\ncart.js\ncart.test.js\nformat.js\n"),
  ]),
  assistant("a-s3r-3", T0 + 6 * S, 1 * S, "error", [], {
    errorMessage: '401: {"message":"Incorrect API key provided","type":"invalid_api_key"}',
  }),
  { kind: "user", key: "u-s3r-4", text: ASK, images: [], timestamp: T1, from: "remote", status: "delivered" },
  assistant("a-s3r-5", T1 + 2 * S, 3 * S, "toolUse", [
    { kind: "thinking", text: "测试可能在 test 目录里，先看一眼。" },
    tool("t-s3r-ls", "bash", { command: "ls test" }, "ls: cannot access 'test': No such file or directory\n\nCommand exited with code 2", {
      state: "output-error",
    }),
  ]),
  assistant("a-s3r-6", T1 + 7 * S, 4 * S, "toolUse", [
    { kind: "text", text: "没有 test 目录，测试就在根目录的 `cart.test.js`。直接跑：" },
    tool("t-s3r-test", "bash", { command: "node --test" }, PASSED),
  ]),
  assistant("a-s3r-7", T1 + 13 * S, 5 * S, "stop", [{ kind: "text", text: "3 个测试都通过了，不用改代码。" }], { usage: { totalTokens: 6_400 } }),
]

const fixture: PiLiveFixture = {
  id: "s3-retried",
  now: MOCK_NOW,
  note: "S3 第三轮：出错（401 原文 JSON）后重新回答成功：出错那轮折成「上次出错，已重试」；重试那轮中途失败的探查命令收起、只留卡头。",
  relay: {
    ...BASE,
    transcript: transcriptOf(ITEMS),
  },
}
export default fixture
