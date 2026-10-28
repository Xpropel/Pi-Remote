// G5（edit 的 details.patch 提升到工具块）与 G12（模型费用说明）的前端修。纯 Node 测试：只 import .ts、相对路径带扩展名。
import test from "node:test"
import assert from "node:assert/strict"
import { toolRenderConfigFor } from "../ui/src/chat/tools/toolConfigs.ts"
import { emptyTranscript, reduceTranscript, estimateItemBytes, TOOL_PATCH_MAX_CHARS } from "../ui/src/relay/transcript.ts"
import { diffRowsFromEdit } from "../ui/src/pi/model/diffRows.ts"
import { changesOfSession } from "../ui/src/pi/model/changes.ts"
import { costNoteOf } from "../ui/src/pi/model/costNote.ts"

/* ---------------- G5：patch 提升 ---------------- */

/** pi 1.3.0 generateUnifiedPatch 的形状：只有 ---/+++ 文件头，context 行可能是单个空格 */
const PATCH = ["--- src/a.ts", "+++ src/a.ts", "@@ -3,4 +3,5 @@", " keep", "-old", "+new", "+more", " ", " tail", ""].join("\n")

function stateOf(name, details, extra = {}) {
  return reduceTranscript(emptyTranscript(), {
    type: "snapshot",
    messages: [
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name, arguments: { path: "src/a.ts", oldText: "old", newText: "new\nmore" } }] },
      { role: "toolResult", toolCallId: "t1", toolName: name, content: [{ type: "text", text: "ok" }], isError: false, details, ...extra },
    ],
  })
}
function toolOf(state) {
  for (const item of state.items) {
    if (item.kind !== "assistant") continue
    const block = item.blocks.find((b) => b.kind === "tool")
    if (block) return block
  }
  return null
}

test("toolConfigs：edit（和按类别落到 edit 的变体名）声明 patch，write / bash 不声明", () => {
  assert.ok(toolRenderConfigFor("edit").fields.includes("patch"))
  assert.ok(toolRenderConfigFor("edit").fields.includes("exitCode"), "原有的 exitCode / stderr 不丢")
  assert.ok(toolRenderConfigFor("apply_patch").fields.includes("patch"))
  assert.ok(!toolRenderConfigFor("write").fields.includes("patch"))
  assert.ok(!toolRenderConfigFor("bash").fields.includes("patch"))
})

test("transcript：edit 的 details.patch / firstChangedLine 提升到工具块，不再进通用区；diff 仍在通用区", () => {
  const block = toolOf(stateOf("edit", { diff: "+3 new", patch: PATCH, firstChangedLine: 4 }))
  assert.equal(block.patch, PATCH)
  assert.equal(block.firstChangedLine, 4)
  assert.equal(block.patchTruncated, undefined)
  assert.deepEqual(block.detailEntries, [{ key: "diff", value: "+3 new" }])
})

test("transcript：超过 200k 字的 patch 截在整行处并标 patchTruncated", () => {
  const line = "+" + "x".repeat(99)
  const big = ["--- a.ts", "+++ a.ts", "@@ -1,0 +1,3000 @@", ...Array(3000).fill(line), ""].join("\n")
  assert.ok(big.length > TOOL_PATCH_MAX_CHARS)
  const block = toolOf(stateOf("edit", { patch: big, firstChangedLine: 1 }))
  assert.equal(block.patchTruncated, true)
  assert.ok(block.patch.length <= TOOL_PATCH_MAX_CHARS)
  assert.ok(block.patch.endsWith("\n"), "不留半行")
  assert.ok(block.patch.split("\n").slice(3, -1).every((l) => l === line))
  const rows = diffRowsFromEdit(block.input, block)
  assert.equal(rows.truncated, true)
  assert.ok(rows.added > 1000 && rows.added < 3000, "截断后的计数只是下限")
  // 恰好在上限内的不截
  const fits = "@@ -1 +1 @@\n" + "+".padEnd(TOOL_PATCH_MAX_CHARS - 12, "y")
  assert.equal(fits.length, TOOL_PATCH_MAX_CHARS)
  assert.equal(toolOf(stateOf("edit", { patch: fits })).patchTruncated, undefined)
})

test("transcript：体积估算计入 patch", () => {
  const withPatch = stateOf("edit", { patch: PATCH })
  const without = stateOf("edit", {})
  const bytes = (s) => s.items.reduce((n, item) => n + estimateItemBytes(item), 0)
  assert.equal(bytes(withPatch) - bytes(without), PATCH.length * 2)
})

test("transcript：不提升的情况（write、旧版 pi 没有 patch、patch 不是字符串、坏的 firstChangedLine）", () => {
  const write = toolOf(stateOf("write", { patch: PATCH }))
  assert.equal(write.patch, undefined, "write 没声明 patch：留在通用区")
  assert.equal(write.detailEntries[0].key, "patch")
  const old = toolOf(stateOf("edit", { diff: "…" }))
  assert.equal(old.patch, undefined)
  assert.equal(old.firstChangedLine, undefined)
  const weird = toolOf(stateOf("edit", { patch: 42, firstChangedLine: 3 }))
  assert.equal(weird.patch, undefined)
  assert.deepEqual(weird.detailEntries, [{ key: "patch", value: "42" }, { key: "firstChangedLine", value: "3" }], "认不出的原样留在通用区")
  const badLine = toolOf(stateOf("edit", { patch: PATCH, firstChangedLine: -1 }))
  assert.equal(badLine.patch, PATCH)
  assert.equal(badLine.firstChangedLine, undefined)
  assert.equal(toolOf(stateOf("edit", undefined)).patch, undefined)
})

test("transcript：patch 也能从 structuredContent 取，且跨 message_end / 工具更新保留", () => {
  const block = toolOf(stateOf("edit", undefined, { structuredContent: { patch: PATCH, firstChangedLine: 4 } }))
  assert.equal(block.patch, PATCH)
  assert.equal(block.firstChangedLine, 4)
  // 直播顺序：助手消息定稿 → tool_execution_start / end（不带 details）→ toolResult 的 message_end（带 details）
  const call = { role: "assistant", content: [{ type: "toolCall", id: "t9", name: "edit", arguments: { path: "a.ts" } }] }
  let s = reduceTranscript(emptyTranscript(), { type: "message-start", message: call })
  s = reduceTranscript(s, { type: "message-end", message: call })
  s = reduceTranscript(s, { type: "tool", id: "t9", patch: { name: "edit", state: "input-streaming" } })
  s = reduceTranscript(s, { type: "tool", id: "t9", patch: { name: "edit", outputText: "ok", state: "output-available" } })
  s = reduceTranscript(s, {
    type: "message-end",
    message: { role: "toolResult", toolCallId: "t9", toolName: "edit", content: [{ type: "text", text: "ok" }], details: { patch: PATCH, firstChangedLine: 4 } },
  })
  const live = s.items.flatMap((x) => (x.kind === "assistant" ? x.blocks : [])).find((b) => b.kind === "tool" && b.id === "t9")
  assert.equal(live.patch, PATCH)
  assert.equal(live.firstChangedLine, 4)
  // 后续只改状态的工具补丁不清掉 patch
  s = reduceTranscript(s, { type: "tool", id: "t9", patch: { state: "output-available" } })
  const again = s.items.flatMap((x) => (x.kind === "assistant" ? x.blocks : [])).find((b) => b.kind === "tool" && b.id === "t9")
  assert.equal(again.patch, PATCH)
})

/* ---------------- G5：diffRows / changesOfSession ---------------- */

const toolBlock = (name, extra) => ({ kind: "tool", id: name + Math.random(), name, argsText: "", outputText: "", state: "output-available", ...extra })
const asst = (blocks) => ({ kind: "assistant", key: "a" + Math.random(), blocks })

test("diffRowsFromEdit：有 patch 用 patch（带行号），没有回落入参推算", () => {
  const args = { path: "src/a.ts", oldText: "old", newText: "new\nmore" }
  const fromPatch = diffRowsFromEdit(args, { patch: PATCH })
  assert.equal(fromPatch.source, "patch")
  assert.deepEqual([fromPatch.added, fromPatch.removed], [2, 1])
  assert.deepEqual(fromPatch.rows.map((r) => [r.kind, r.n]), [["context", 3], ["del", 4], ["add", 4], ["add", 5], ["context", 6], ["context", 7]])
  assert.equal(fromPatch.truncated, undefined)
  const fromArgs = diffRowsFromEdit(args, {})
  assert.equal(fromArgs.source, "args")
  assert.deepEqual([fromArgs.added, fromArgs.removed], [2, 1])
  assert.ok(fromArgs.rows.every((r) => r.n === null))
  assert.equal(diffRowsFromEdit(args, { patch: PATCH, patchTruncated: true }).truncated, true)
  assert.equal(diffRowsFromEdit(args, { patch: "not a patch", patchTruncated: true }).source, "args", "坏 patch 回落入参")
})

test("changesOfSession：同一会话里有 patch 的 edit 读 patch、没有的回落入参，write 只有 +N", () => {
  const items = [
    asst([
      toolBlock("write", { input: { path: "n.ts", content: "1\n2\n3" } }),
      toolBlock("edit", { input: { path: "src/a.ts", oldText: "zzz", newText: "yyy" }, patch: PATCH, firstChangedLine: 4 }),
      toolBlock("edit", { input: { path: "src/b.ts", oldText: "p", newText: "q\nr" } }),
    ]),
  ]
  const c = changesOfSession(items)
  assert.deepEqual(c.files.map((f) => [f.path, f.added, f.removed]), [["n.ts", 3, 0], ["src/a.ts", 2, 1], ["src/b.ts", 2, 1]])
  assert.equal(c.files[1].rows[0].n, 3, "patch 行号")
  assert.equal(c.files[2].rows[0].n, null, "入参推不出行号")
  assert.deepEqual([c.added, c.removed], [7, 2])
  assert.ok(c.files.every((f) => f.truncated === undefined))
})

test("changesOfSession：截断的 patch 让文件标 truncated；端到端从 toolResult 起算", () => {
  const c = changesOfSession([asst([toolBlock("edit", { input: { path: "a.ts" }, patch: PATCH, patchTruncated: true })])])
  assert.equal(c.files[0].truncated, true)
  const e2e = changesOfSession(stateOf("edit", { patch: PATCH, firstChangedLine: 4 }).items)
  assert.equal(e2e.files[0].path, "src/a.ts")
  assert.equal(e2e.files[0].rows[0].n, 3)
  const noPatch = changesOfSession(stateOf("edit", { diff: "…" }).items)
  assert.equal(noPatch.files[0].rows[0].n, null, "旧版 pi 没有 patch：回落入参")
})

/* ---------------- G12：costNoteOf ---------------- */

const GEMINI = { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0, tiers: [{ inputTokensAbove: 200000, input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 }] }

test("costNoteOf：单价翻倍", () => {
  assert.equal(costNoteOf(GEMINI), "输入超过 200k 时单价翻倍")
  assert.equal(costNoteOf({ input: 2, tiers: [{ inputTokensAbove: 1_000_000, input: 4 }] }), "输入超过 1M 时单价翻倍")
})

test("costNoteOf：倍率不是整数", () => {
  assert.equal(costNoteOf({ input: 2, tiers: [{ inputTokensAbove: 128000, input: 3 }] }), "输入超过 128k 时单价 ×1.5")
  assert.equal(costNoteOf({ input: 3, tiers: [{ inputTokensAbove: 272000, input: 5 }] }), "输入超过 272k 时单价 ×1.67")
  assert.equal(costNoteOf({ input: 1, tiers: [{ inputTokensAbove: 32768, input: 3 }] }), "输入超过 32.8k 时单价 ×3")
  assert.equal(costNoteOf({ input: 4, tiers: [{ inputTokensAbove: 200000, input: 2 }] }), "输入超过 200k 时单价 ×0.5")
})

test("costNoteOf：多档只写第一档（门槛最低）", () => {
  const cost = { input: 1, tiers: [{ inputTokensAbove: 500000, input: 3 }, { inputTokensAbove: 200000, input: 2 }] }
  assert.equal(costNoteOf(cost), "输入超过 200k 时单价翻倍")
  assert.equal(costNoteOf({ input: 1, tiers: [{ inputTokensAbove: 200000, input: 1.5 }, { inputTokensAbove: 1_000_000, input: 2 }] }), "输入超过 200k 时单价 ×1.5")
})

test("costNoteOf：没有 tiers（旧版 pi / 不分档的模型）返回 null", () => {
  assert.equal(costNoteOf({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }), null)
  assert.equal(costNoteOf({ input: 3, tiers: [] }), null)
  assert.equal(costNoteOf(undefined), null)
  assert.equal(costNoteOf(null), null)
})

test("costNoteOf：异常数据不编", () => {
  assert.equal(costNoteOf("1.25"), null)
  assert.equal(costNoteOf({ input: 0, tiers: GEMINI.tiers }), null, "基础单价为 0（免费模型）没有倍率")
  assert.equal(costNoteOf({ input: "1.25", tiers: GEMINI.tiers }), null)
  assert.equal(costNoteOf({ input: 1.25, tiers: "x" }), null)
  assert.equal(costNoteOf({ input: 1.25, tiers: [null, 3, { inputTokensAbove: 200000 }, { input: 2.5 }] }), null)
  assert.equal(costNoteOf({ input: 1.25, tiers: [{ inputTokensAbove: -1, input: 2.5 }, { inputTokensAbove: NaN, input: 2.5 }] }), null)
  assert.equal(costNoteOf({ input: 1, tiers: [{ inputTokensAbove: 200000, input: 1 }] }), null, "单价没变不写")
  assert.equal(costNoteOf({ input: 1, tiers: [{ bad: true }, { inputTokensAbove: 200000, input: 2 }] }), "输入超过 200k 时单价翻倍", "跳过坏档")
})
