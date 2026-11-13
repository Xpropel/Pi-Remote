/**
 * s3/stopped-write：被停止的写入 / 编辑卡。
 * - 第一轮：write 的参数还在流时用户停止。pi 存下的消息 stopReason "aborted"，工具调用的 arguments 是 {}（半截参数被丢掉，
 *   真实会话 D:\pi-e2e\s3 里的原样）：没有文件名也没有内容可画，出一行「写入文件 · 已取消」，不出空的 diff 卡。
 * - 第二轮：第一次 edit 真失败（oldText 对不上，pi 的原文），卡头红字「未生效」；换写法再改时用户停止，
 *   结果是 pi 的停止样板 "Operation aborted"，随后的模型调用记成 error + AbortSignal 原文：卡头灰字「已取消」。
 *   两张 edit 卡都没有 details.patch，卡里按参数的 oldText → newText 画出要改的行（不写行号）。
 */
import type { Block, Item } from "../../../../relay/transcript.ts"
import { BASE, tool, transcriptOf } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const S = 1000
const M = 60 * S
const T0 = MOCK_NOW - 6 * M
const T1 = MOCK_NOW - 2 * M
const MODEL = "claude-sonnet-4-5"

type Extra = { errorMessage?: string }
function assistant(key: string, at: number, durationMs: number, stopReason: string, blocks: Block[], extra: Extra = {}): Item {
  return { kind: "assistant", key, model: MODEL, startedAt: at, durationMs, endedAt: at + durationMs, timestamp: at, stopReason, blocks, ...extra }
}

const ITEMS: Item[] = [
  { kind: "user", key: "u-s3w-1", text: "把 README 里的用法整理成 USAGE.md", images: [], timestamp: T0, from: "remote", status: "delivered" },
  assistant("a-s3w-2", T0 + 2 * S, 9 * S, "aborted", [
    { kind: "thinking", text: "README 里有三段用法，整理成一个 USAGE.md：先写合计，再写折扣。" },
    tool("t-s3w-write", "write", {}, "", { state: "input-available" }),
  ]),
  { kind: "user", key: "u-s3w-3", text: "先别写文档了，给 total 加上运费参数 shipping", images: [], timestamp: T1, from: "remote", status: "delivered" },
  assistant("a-s3w-4", T1 + 2 * S, 4 * S, "toolUse", [
    tool(
      "t-s3w-edit-1",
      "edit",
      { path: "cart.js", edits: [{ oldText: "\treturn sum - discount", newText: "\treturn sum - discount + shipping" }] },
      "Could not find the exact text in cart.js. The old text must match exactly including all whitespace and newlines.",
      { state: "output-error" },
    ),
  ]),
  assistant("a-s3w-5", T1 + 7 * S, 5 * S, "toolUse", [
    { kind: "text", text: "缩进对不上，连函数签名一起改：" },
    tool(
      "t-s3w-edit-2",
      "edit",
      {
        path: "cart.js",
        edits: [
          {
            oldText: "function total(items, discount = 0) {\n  const sum = items.reduce((s, i) => s + i.price * i.qty, 0)\n  return sum - discount\n}",
            newText:
              "function total(items, discount = 0, shipping = 0) {\n  const sum = items.reduce((s, i) => s + i.price * i.qty, 0)\n  return sum - discount + shipping\n}",
          },
        ],
      },
      "Operation aborted",
      { state: "output-error" },
    ),
  ]),
  assistant("a-s3w-6", T1 + 12 * S, 1 * S, "error", [], { errorMessage: "The operation was aborted." }),
]

const fixture: PiLiveFixture = {
  id: "s3-stopped-write",
  now: MOCK_NOW,
  note: "S3 第六轮：被停止的写入 / 编辑标灰字「已取消」（参数流里停下、参数被 pi 丢掉的 write 出一行；执行中被打断的 edit 是卡），真失败的 edit 照旧红字「未生效」；没有 patch 的 edit 卡按参数画出要改的行。",
  relay: {
    ...BASE,
    transcript: transcriptOf(ITEMS),
  },
}
export default fixture
