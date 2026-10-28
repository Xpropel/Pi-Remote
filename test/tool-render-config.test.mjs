// P2-1 工具渲染配置表：查表分发 / details 表驱动提升 / 通用兜底不丢键 /
// denied·timeout 样板推导。纯 Node 测试（transcript.ts 与 toolConfigs.ts 均无 DOM 依赖）。
import test from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_TOOL_RENDER_CONFIG,
  toolRenderConfigFor,
} from "../ui/src/chat/tools/toolConfigs.ts"
import {
  emptyTranscript,
  reduceTranscript,
  toolDisplayState,
} from "../ui/src/relay/transcript.ts"

function toolBlockOf(messages) {
  const state = reduceTranscript(emptyTranscript(), { type: "snapshot", messages })
  for (const item of state.items) {
    if (item.kind !== "assistant") continue
    const block = item.blocks.find((b) => b.kind === "tool")
    if (block) return block
  }
  return null
}

function pair(name, result) {
  return [
    { role: "assistant", content: [{ type: "toolCall", id: "t1", name, arguments: {} }] },
    { role: "toolResult", toolCallId: "t1", toolName: name, ...result },
  ]
}

test("配置表查表：精确名 / 类别兜底 / 默认兜底", () => {
  const bash = toolRenderConfigFor("bash")
  assert.equal(bash.form, "one-line")
  assert.equal(bash.defaultOpen, "closed")
  assert.equal(bash.badge, "state+exit")
  assert.equal(bash.resultKind, "stderr-mix")

  assert.equal(toolRenderConfigFor("read").resultKind, "text")
  assert.equal(toolRenderConfigFor("edit").resultKind, "diff")
  assert.equal(toolRenderConfigFor("find").resultKind, "file-list")

  const todo = toolRenderConfigFor("todo")
  assert.equal(todo.form, "plan")
  assert.equal(todo.resultKind, "todo-list")
  assert.deepEqual(todo.fields, ["tasks"])
  assert.equal(toolRenderConfigFor("todowrite").resultKind, "todo-list")

  const subagent = toolRenderConfigFor("subagent")
  assert.equal(subagent.form, "panel")
  assert.equal(subagent.resultKind, "subagent")

  // 变体名按类别落位，未知工具走默认兜底（details 不丢）。
  assert.equal(toolRenderConfigFor("read_file").resultKind, "text")
  assert.deepEqual(toolRenderConfigFor("some_new_tool"), DEFAULT_TOOL_RENDER_CONFIG)
  assert.equal(DEFAULT_TOOL_RENDER_CONFIG.genericDetails, true)
})

test("展示字段：exitCode / stderr 消费与改造前一致，且不进通用区", () => {
  const block = toolBlockOf(
    pair("bash", {
      content: [{ type: "text", text: "out" }],
      isError: true,
      details: { exit_code: 7, stderr: "boom" },
    }),
  )
  assert.equal(block.exitCode, 7)
  assert.equal(block.stderr, "boom")
  assert.equal(block.detailEntries, undefined, "已提升的键不该在通用区重复出现")
})

test("todo 的 tasks 按配置提升为一等字段，状态归一与扩展同口径", () => {
  const block = toolBlockOf(
    pair("todo", {
      content: [{ type: "text", text: "ok" }],
      isError: false,
      details: {
        tasks: [
          { content: "写计划", status: "in_progress" },
          { text: "已做完", done: true },
          { title: "还没动", status: "pending" },
          { nope: 1 },
        ],
        other: "x",
      },
    }),
  )
  assert.equal(block.tasks.length, 3, "认不出的条目跳过，不伪造")
  assert.deepEqual(
    block.tasks.map((t) => t.status),
    ["in_progress", "completed", "pending"],
  )
  assert.equal(block.tasks[0].content, "写计划")
  // tasks 已提升；未提升的键仍走通用区，不丢。
  assert.deepEqual(block.detailEntries, [{ key: "other", value: "x" }])
})

test("未入表工具：details 全部键走通用键值呈现，一个不丢", () => {
  const block = toolBlockOf(
    pair("some_new_tool", {
      content: [{ type: "text", text: "done" }],
      isError: false,
      details: { customField: "值", count: 3, nested: { a: 1 }, list: [1, 2] },
    }),
  )
  assert.deepEqual(block.detailEntries, [
    { key: "customField", value: "值" },
    { key: "count", value: "3" },
    { key: "nested", value: "共 1 个字段" },
    { key: "list", value: "共 2 项" },
  ])
})

test("双记录并存：details 与 structuredContent 的独有键都进通用区，同名键先到先得", () => {
  const block = toolBlockOf(
    pair("some_new_tool", {
      content: [{ type: "text", text: "done" }],
      isError: false,
      details: { fromDetails: "d", shared: "details 版" },
      structuredContent: { fromStructured: 42, shared: "structured 版" },
    }),
  )
  // R2-6 窄口修复前只扫 details：fromStructured 会漏出通用区。
  assert.deepEqual(block.detailEntries, [
    { key: "fromDetails", value: "d" },
    { key: "shared", value: "details 版" },
    { key: "fromStructured", value: "42" },
  ])
})

test("denied / timeout 只认 pi 样板原文，只在失败结果上推导", () => {
  const denied = toolBlockOf(
    pair("bash", {
      content: [{ type: "text", text: "Tool execution was blocked by an extension. Reason: 用户拒绝" }],
      isError: true,
    }),
  )
  assert.equal(denied.outcome, "denied")
  assert.equal(toolDisplayState(denied), "denied")

  const timeout = toolBlockOf(
    pair("bash", {
      content: [{ type: "text", text: "partial output\nCommand timed out after 30 seconds" }],
      isError: true,
    }),
  )
  assert.equal(timeout.outcome, "timeout")
  assert.equal(toolDisplayState(timeout), "failed", "超时仍是 failed 展示态，靠 outcome 贴字")

  const plain = toolBlockOf(
    pair("bash", {
      content: [{ type: "text", text: "random failure" }],
      isError: true,
    }),
  )
  assert.equal(plain.outcome, undefined)
  assert.equal(toolDisplayState(plain), "failed")

  const okButBlockedText = toolBlockOf(
    pair("bash", {
      content: [{ type: "text", text: "Tool execution was blocked 这几个字出现在正常输出里" }],
      isError: false,
    }),
  )
  assert.equal(okButBlockedText.outcome, undefined, "成功结果不推导")
})
