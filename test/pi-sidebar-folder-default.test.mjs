// P11 调整：工作区分组默认折叠（未存 = 折叠）；首次点击展开并写 false；折叠时组头不显示会话数。
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const read = (path) => readFile(new URL(`../ui/src/pi/${path}`, import.meta.url), "utf8")

test("共享 hook：未存折叠时首次点击展开（?? true）", async () => {
  const hook = await read("sidebar/useSidebarLocal.ts")
  assert.equal(hook.includes("!(cur.folders[groupId] ?? true)"), true)
})

test("共享核：组头永远不渲染会话数量（展开/折叠都不显示）", async () => {
  const sections = await read("sidebar/components/SidebarSections.tsx")
  assert.equal(sections.includes("sb-wscount"), false)
  assert.equal(sections.includes("{group.count}"), false)
})

test("Claude adapter：未存/true=折叠，显式 false=展开（与共享核同口径）", async () => {
  const adapter = await read("variants/claude/sidebar/ClaudeUnifiedSidebar.tsx")
  assert.equal(adapter.includes("collapsed: scope.folders[groupId] !== false"), true)
})

test("持久化语义：storage 纯函数只存显式 false/true，未存保持 undefined", async () => {
  const storage = await read("sidebar/storage.ts")
  assert.equal(storage.includes("setSidebarFolderCollapsed"), true)
})
