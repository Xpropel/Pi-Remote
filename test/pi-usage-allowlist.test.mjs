// P10 变体守卫：`@/pi/usage` 精确白名单 + 使用活动模块自包含静态断言。
// 正例：变体可 import 共享使用活动页/契约；负例：整目录/借道 cursor/扩展 mock 必须红。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  PI_VARIANT_ALLOWED_USAGE_MODULES,
  piVariantImportVerdict,
} from "../ui/src/pi/headless/allowlist.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")

test("精确白名单：变体 import @/pi/usage 与 @/pi/usage/UsageActivityPage 通过", () => {
  assert.deepEqual([...PI_VARIANT_ALLOWED_USAGE_MODULES], ["@/pi/usage", "@/pi/usage/UsageActivityPage"])
  assert.equal(piVariantImportVerdict("@/pi/usage").ok, true)
  assert.equal(piVariantImportVerdict("@/pi/usage/UsageActivityPage").ok, true)
  // type-only 同样走这条（页面导出类型不额外开洞）
  assert.equal(piVariantImportVerdict("@/pi/usage", { typeOnly: true }).ok, true)
})

test("负例：整目录/未登记子模块/借道 cursor/扩展 mock 一律拒绝", () => {
  const denied = [
    "@/pi/usage/",
    "@/pi/usage/types",
    "@/pi/usage/format",
    "@/pi/usage/UsageActivityPage/extra",
    "@/pi/usage/../cursor/PiButton",
    "@/pi/usage/../components/pi/shared/PiRoot",
    "@/pi/usage/../extensions/mock",
    "@/components/pi/PiButton",
    "@/pi/extensions/mock",
    "@/pi/extensions/mock/provider",
  ]
  for (const spec of denied) assert.equal(piVariantImportVerdict(spec).ok, false, `${spec} 必须被拒绝`)
  const reason = piVariantImportVerdict("@/pi/usage/types")
  assert.match(reason.reason, /使用活动只允许精确模块/)
})

test("自包含静态断言：ui/src/pi/usage/** 不 import cursor/旧 UI，不出现 --cw-* token", () => {
  const dir = path.join(ROOT, "ui/src/pi/usage")
  const files = fs.readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f))
  assert.ok(files.length >= 4, "usage 模块至少 types/validate/format/index")
  const forbidden = [/from "@\/components\//, /from "@\/chat\//, /from "@\/shell\//, /from "@\/mobile\//, /from "@\/lib\//, /from "@\/pi\/containers\//, /--cw-/]
  for (const file of files) {
    const src = read(`ui/src/pi/usage/${file}`).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
    for (const re of forbidden) assert.doesNotMatch(src, re, `${file} 命中禁止项 ${re}`)
  }
  // 使用活动页存在时必须同样自包含（claude/codex 挂载后由守卫与测试双保险）
  const page = path.join(dir, "UsageActivityPage.tsx")
  if (fs.existsSync(page)) {
    const src = fs.readFileSync(page, "utf8")
    for (const re of forbidden) assert.doesNotMatch(src, re, `UsageActivityPage.tsx 命中禁止项 ${re}`)
  }
})
