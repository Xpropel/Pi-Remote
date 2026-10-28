// 产品要求：三套 UI 全部移除 macOS 风格假窗口三色点（网页不是原生窗口，装饰性圆点会误导）。
// 本守卫覆盖 Claude + Cursor（Codex 由 codex-dev 修复；合并后本断言可扩到全变体）。
import test from "node:test"
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

const ROOT = new URL("..", import.meta.url)
const SRC = new URL("../ui/src/", import.meta.url)

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir.pathname, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(new URL(`file://${full}`))))
    else if (/\.(tsx?|css)$/.test(entry.name)) out.push(full)
  }
  return out
}

const FORBIDDEN = [
  { needle: "TrafficLights", why: "Cursor kit 三色点组件不得再被渲染/导出" },
  { needle: "data-slot=\"traffic-lights\"", why: "不得渲染 traffic-lights DOM" },
  { needle: "claude-windowdot", why: "Claude 不得保留三色点标记/样式" },
  { needle: "CL-SHELL-08", why: "Claude 三色点装饰面已删除" },
  { needle: "--cw-traffic", why: "Cursor traffic token 已删除" },
]

test("Claude + Cursor 产品代码不再包含任何三色点实现", async () => {
  const roots = [new URL("../ui/src/components/", import.meta.url), new URL("../ui/src/pi/variants/claude/", import.meta.url)]
  const files = (await Promise.all(roots.map((dir) => walk(dir)))).flat()
  assert.ok(files.length > 20)
  for (const file of files) {
    const text = await readFile(file, "utf8")
    for (const { needle, why } of FORBIDDEN) {
      assert.equal(text.includes(needle), false, `${path.relative(ROOT.pathname, file)} 仍包含 ${needle}（${why}）`)
    }
  }
})

test("Cursor traffic token 已从 tokens/theme 删除", async () => {
  for (const file of ["../ui/src/pi/styles/tokens.css", "../ui/src/pi/styles/tokens.local.css", "../ui/src/pi/styles/theme.css"]) {
    const text = await readFile(new URL(file, import.meta.url), "utf8")
    assert.equal(text.includes("--cw-traffic"), false, `${file} 仍含 --cw-traffic token`)
  }
})

test("Claude titlebar 品牌区不含隐藏的窗口装饰段", async () => {
  const source = await readFile(new URL("../ui/src/pi/variants/claude/chrome/ClaudeTitleBar.tsx", import.meta.url), "utf8")
  assert.equal(source.includes("window-decor"), false)
  assert.equal(source.includes("aria-hidden>\n          <span className=\"claude-"), false)
})
