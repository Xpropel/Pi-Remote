// P11 后续：Artifacts/产出物入口从左侧栏移到右侧 rail（左侧统一侧栏不再塞功能）。
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

test("Claude 右侧 rail 有产出物入口 + 面板 + capability 禁用态", async () => {
  const source = await readFile(new URL("../ui/src/pi/variants/claude/panels/ClaudeStatusRail.tsx", import.meta.url), "utf8")
  assert.equal(source.includes('data-p4-action="open-artifacts"'), true)
  assert.equal(source.includes("claudeCapabilityAttrs(\"artifacts\", artStatus)"), true)
  assert.equal(source.includes("disabled={artView != null}"), true)
  assert.equal(source.includes("<ClaudeArtifactsPanel onClose={() => setArtifactsOpen(false)} />"), true)
})
