// A-4 回归 + D-1 推广：观看端没有身份/内容钥的加密房间里，正文只有一行
// 红字、没有去处。A-4 先给「有待答」的房间加了「启用观看端身份」动作；
// D-1 实测无身份时房间永远是空壳（与有没有待答无关），故推广为：只要是
// crypto-required，这行就带启用身份的动作。纯函数部分测 transcriptView
// 的 cryptoRequiredTopLineOf；容器与设置页的接线按本仓惯例做源码断言
//（不启动浏览器、不依赖 React；Node 原生剥离 TS 类型直接 import .ts）。
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { cryptoRequiredTopLineOf } from "../ui/src/pi/model/transcriptView.ts"

const container = readFileSync(new URL("../ui/src/pi/containers/TranscriptContainer.tsx", import.meta.url), "utf8")
const settingsPage = readFileSync(new URL("../ui/src/pi/settings/SettingsPage.tsx", import.meta.url), "utf8")

test("cryptoRequiredTopLineOf：红字不变，恒带启用身份的动作（不再看有没有待答）", () => {
  const line = cryptoRequiredTopLineOf()
  assert.equal(line.text, "这个房间已加密，当前观看端无法读取加密内容")
  assert.equal(line.tone, "error")
  assert.equal(line.action, "enable-identity")
  assert.equal(line.actionText, "启用观看端身份")
})

test("cryptoRequiredTopLineOf：动作文字与设置页里启用按钮的原文一致（IdentitySection 的「启用观看端身份」）", () => {
  const identitySection = readFileSync(new URL("../ui/src/pi/settings/pages/IdentitySection.tsx", import.meta.url), "utf8")
  assert.ok(identitySection.includes("启用观看端身份"), "设备页身份区的启用按钮原文")
  assert.equal(cryptoRequiredTopLineOf().actionText, "启用观看端身份")
})

test("TranscriptContainer 接线：crypto-required 行走 cryptoRequiredTopLineOf，不再内联硬写", () => {
  assert.ok(container.includes("own.push(cryptoRequiredTopLineOf())"))
  assert.ok(!container.includes('own.push({ text: "这个房间已加密，当前观看端无法读取加密内容"'))
})

test("TranscriptContainer 接线：crypto-required 行不再依赖待答信号（D-1：没有待答时指引也必须在房间里可达）", () => {
  assert.ok(!container.includes("cryptoRequiredTopLineOf(pendingDialog)"), "不得再按待答与否决定是否给动作")
  assert.ok(!container.includes("pendingDialog"), "待答信号不再参与流顶行计算")
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
