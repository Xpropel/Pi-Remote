// A-4 回归：观看端没有身份/内容钥的加密房间里，侧栏已经在喊「等你回答」，
// 房间正文却只有一行红字、没有去处。纯函数部分测 transcriptView 的
// cryptoRequiredTopLineOf（有待答 → 红字带「启用观看端身份」动作；无待答 →
// 原样一行）；容器与设置页的接线按本仓惯例做源码断言（不启动浏览器、
// 不依赖 React；Node 原生剥离 TS 类型直接 import .ts）。
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { cryptoRequiredTopLineOf } from "../ui/src/pi/model/transcriptView.ts"

const container = readFileSync(new URL("../ui/src/pi/containers/TranscriptContainer.tsx", import.meta.url), "utf8")
const settingsPage = readFileSync(new URL("../ui/src/pi/settings/SettingsPage.tsx", import.meta.url), "utf8")

test("cryptoRequiredTopLineOf：没有待答时是原来的一行红字，没有动作", () => {
  const line = cryptoRequiredTopLineOf(false)
  assert.equal(line.text, "这个房间已加密，当前观看端无法读取加密内容")
  assert.equal(line.tone, "error")
  assert.equal(line.action, undefined)
  assert.equal(line.actionText, undefined)
})

test("cryptoRequiredTopLineOf：有待答时红字不变，多一个启用身份的动作", () => {
  const line = cryptoRequiredTopLineOf(true)
  assert.equal(line.text, "这个房间已加密，当前观看端无法读取加密内容")
  assert.equal(line.tone, "error")
  assert.equal(line.action, "enable-identity")
  // 动作文字与设置页里启用按钮的原文一致（IdentitySection 的「启用观看端身份」）
  assert.equal(line.actionText, "启用观看端身份")
})

test("TranscriptContainer 接线：crypto-required 行走 cryptoRequiredTopLineOf，不再内联硬写", () => {
  assert.ok(container.includes('own.push(cryptoRequiredTopLineOf(pendingDialog))'))
  assert.ok(!container.includes('own.push({ text: "这个房间已加密，当前观看端无法读取加密内容"'))
})

test("TranscriptContainer 接线：pendingDialog 取本机卡片信号与名册 waiting 摘要（与侧栏同一信号）", () => {
  assert.ok(container.includes("const pendingDialog = waiting || (roomEntry?.waiting?.length ?? 0) > 0 || roomEntry?.waitingPrompt != null"))
})

test("TranscriptContainer 接线：enable-identity 动作预选设备页再打开设置", () => {
  assert.ok(container.includes('l.action === "enable-identity"'))
  assert.ok(container.includes('rememberSettingsPage("devices")'))
  assert.ok(container.includes("act.openSettings()"))
})

test("SettingsPage 接线：rememberSettingsPage 写回记住的页签，挂载时作为初始页", () => {
  assert.ok(settingsPage.includes("export function rememberSettingsPage(page: SettingsPageId): void"))
  assert.ok(settingsPage.includes("lastSettingsPage = settingsPageIdOf(page)"))
  assert.ok(settingsPage.includes("lastSettingsPage ?? \"general\""))
})
