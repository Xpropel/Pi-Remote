// 评审 P0：浮层 id 必须引用各变体 CLAUDE/CODEX_OVERLAY 常量，禁止裸字符串（值不一致会导致点按钮无反应）。
import test from "node:test"
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir.pathname, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(new URL(`file://${full}`))))
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

test("变体代码不出现裸浮层 id（openDialog/openSheet 必须用 *_OVERLAY 常量）", async () => {
  const files = await walk(new URL("../ui/src/pi/variants/", import.meta.url))
  const violations = []
  for (const file of files) {
    const text = await readFile(file, "utf8")
    for (const match of text.matchAll(/open(?:Dialog|Sheet)\(\{\s*id:\s*"([^"]+)"/g)) {
      violations.push(`${path.relative(new URL("../ui/src/pi/variants/", import.meta.url).pathname, file)}: ${match[1]}`)
    }
  }
  assert.deepEqual(violations, [])
})
