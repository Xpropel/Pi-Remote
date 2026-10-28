// P11 收尾 P3：Claude 线清理守卫（旧侧栏死代码、purgedRoom 去重、时间标签 tick）。
import test from "node:test"
import assert from "node:assert/strict"
import { access, readFile } from "node:fs/promises"

const fileUrl = (path) => new URL(`../ui/src/pi/${path}`, import.meta.url)

test("旧桌面侧栏死文件已删除（手机仍在用的 SessionRow/Group/Skeleton 保留）", async () => {
  const removed = ["variants/claude/sidebar/ClaudeSidebar.tsx", "variants/claude/sidebar/ClaudeDensityToggle.tsx", "variants/claude/sidebar/ClaudeSearchResults.tsx", "variants/claude/sidebar/ClaudeAccountFooter.tsx"]
  for (const path of removed) await assert.rejects(access(fileUrl(path)), `应删除 ${path}`)
  for (const kept of ["variants/claude/sidebar/ClaudeSessionRow.tsx", "variants/claude/sidebar/ClaudeSessionGroup.tsx", "variants/claude/sidebar/ClaudeSidebarSkeleton.tsx"]) {
    await access(fileUrl(kept))
  }
})

test("purgedRoom 只在 PiAppBody 处理一次，ClaudeApp 不再重复", async () => {
  const body = await readFile(fileUrl("containers/PiAppBody.tsx"), "utf8")
  const claude = await readFile(fileUrl("variants/claude/ClaudeApp.tsx"), "utf8")
  assert.equal(body.includes("handledPurgeAt"), true)
  assert.equal(claude.includes("handledPurgeAt"), false)
  assert.equal(claude.includes("relay.purgedRoom"), false)
  assert.equal(claude.includes("act.newSession()"), false)
})

test("Claude 统一侧栏时间标签用 useNow tick（非静态 Date.now）", async () => {
  const adapter = await readFile(fileUrl("variants/claude/sidebar/ClaudeUnifiedSidebar.tsx"), "utf8")
  assert.equal(adapter.includes("useNow(30_000)"), true)
  assert.equal(adapter.includes("const now = Date.now()"), false)
})
