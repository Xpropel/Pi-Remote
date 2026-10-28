// P11 P1 守卫：Claude 统一侧栏本机状态必须走共享 useSidebarLocalState（持久化 + account::device 隔离），
// 不得再用组件内 useState 内存态（变体也不得直接 localStorage——independence 守卫另有断言）。
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

test("ClaudeUnifiedSidebar 用共享 useSidebarLocalState 持久化 pin/archive/折叠", async () => {
  const source = await readFile(new URL("../ui/src/pi/variants/claude/sidebar/ClaudeUnifiedSidebar.tsx", import.meta.url), "utf8")
  assert.equal(source.includes("useSidebarLocalState("), true)
  assert.equal(source.includes("localStore.scopeState"), true)
  assert.equal(source.includes("localStore.togglePin("), true)
  assert.equal(source.includes("localStore.toggleArchive("), true)
  assert.equal(source.includes("localStore.toggleFolder("), true)
  assert.equal(source.includes("emptySidebarLocalState"), false)
  assert.equal(source.includes("setLocal"), false)
  assert.equal(source.includes("TODO(B1-arch)"), false)
})
