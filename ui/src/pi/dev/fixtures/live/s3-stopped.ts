/**
 * s3/stopped：上一轮回复写到半截被停止，最后停在行内代码中间（"关键是这一行：`total(items"）：补上闭合，画成 chip，不露出孤立的反引号。
 * 那一轮的思考是 Markdown（阶段标题、行内代码、代码段、要点）：弱化、紧凑的一套外观。
 * 现在这一轮还在想，思考原文流式到一半、同样停在行内代码中间（"`discount"）：活动尾部先补上闭合，字到齐前就是 chip。
 */
import type { Block, Item } from "../../../../relay/transcript.ts"
import { BASE, roomsWith, tool, transcriptOf } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const S = 1000
const M = 60 * S
const T0 = MOCK_NOW - 5 * M
const T1 = MOCK_NOW - 20 * S
const MODEL = "claude-sonnet-4-5"

function assistant(key: string, at: number, durationMs: number, stopReason: string, blocks: Block[]): Item {
  return { kind: "assistant", key, model: MODEL, startedAt: at, durationMs, endedAt: at + durationMs, timestamp: at, stopReason, blocks }
}

const CART_JS = [
  "function total(items, discount = 0) {",
  "  const sum = items.reduce((s, i) => s + i.price * i.qty, 0)",
  "  return sum - discount",
  "}",
  "",
  "module.exports = { total }",
  "",
].join("\n")

const THINKING_DONE = [
  "**读 cart.js**",
  "",
  "`total` 用 `reduce` 求和，每项是 `price * qty`，最后减去折扣：",
  "",
  "```js",
  "const sum = items.reduce((s, i) => s + i.price * i.qty, 0)",
  "return sum - discount",
  "```",
  "",
  "要注意的边界：",
  "",
  "- 空数组时 `reduce` 有初始值 0，不会抛错",
  "- `discount` 没有校验，**负数会让合计变大**",
].join("\n")

const REPLY_STOPPED = [
  "`total()` 分两步算：",
  "",
  "1. 每一项算 `price * qty`，用 `reduce` 加起来（初始值 0，空购物车得 0）；",
  "2. 减去 `discount`。",
  "",
  "关键是这一行：`total(items",
].join("\n")

const THINKING_LIVE = [
  "**核对测试**",
  "",
  "要确认两件事：",
  "",
  "1. `cart.test.js` 有没有覆盖空购物车",
  "2. 折扣为负数时 `total` 会不会变大",
  "",
  "先搜一下测试里有没有 `discount",
].join("\n")

const ITEMS: Item[] = [
  { kind: "user", key: "u-s3s-1", text: "cart.js 的 total 是怎么算的？", images: [], timestamp: T0, from: "remote", status: "delivered" },
  assistant("a-s3s-2", T0 + 2 * S, 3 * S, "toolUse", [
    { kind: "thinking", text: THINKING_DONE },
    tool("t-s3s-read", "read", { path: "cart.js" }, CART_JS),
  ]),
  assistant("a-s3s-3", T0 + 6 * S, 7 * S, "aborted", [{ kind: "text", text: REPLY_STOPPED }]),
  { kind: "user", key: "u-s3s-4", text: "接着说，顺便看看测试有没有覆盖", images: [], timestamp: T1, from: "remote", status: "delivered" },
  { kind: "assistant", key: "a-s3s-5", model: MODEL, startedAt: T1 + S, timestamp: T1 + S, live: true, blocks: [{ kind: "thinking", text: THINKING_LIVE }] },
]

const fixture: PiLiveFixture = {
  id: "s3-stopped",
  now: MOCK_NOW,
  note: "S3 第四轮：停止生成的回复停在行内代码中间（补上闭合，不露孤立反引号）；思考原文按 Markdown 画，流式中的思考尾部同样先补闭合。",
  relay: {
    ...BASE,
    busy: true,
    rooms: roomsWith({ "r-s1": { busy: true, lastActivity: T1 + S } }),
    transcript: transcriptOf(ITEMS, "a-s3s-5"),
  },
}
export default fixture
