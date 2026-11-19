// Pi-Remote 占位功能转实装回归守卫（about / extensions / approval / voice / quota / pane switcher）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")

const aboutData = await import("../ui/src/pi/settings/pages/aboutData.ts")
const extLogic = await import("../ui/src/pi/settings/pages/extensionsLogic.ts")
const approvalData = await import("../ui/src/pi/settings/pages/approvalData.ts")
const voice = await import("../ui/src/pi/model/voiceDictation.ts")
const quota = await import("../ui/src/pi/usage/monthlyQuota.ts")

test("aboutData：/healthz 版本拉取、格式化与诊断导出字段", async () => {
  assert.equal(aboutData.formatRelayVersionText("4.0.0", 21), "4.0.0 (proto v21)")
  assert.equal(aboutData.formatRelayVersionText("4.0.0", null), "4.0.0")
  assert.equal(aboutData.formatRelayVersionText("", 21), "proto v21")
  assert.equal(aboutData.formatRelayVersionText("", null), "—")
  assert.equal(aboutData.formatRelayVersionText("4.0.0\n\x07", 21), "4.0.0 (proto v21)")

  const okFetch = async (url, init) => {
    assert.equal(url, "/healthz")
    assert.equal(init?.cache, "no-store")
    return new Response(JSON.stringify({ ok: true, version: "4.0.0", proto: 21 }), { status: 200 })
  }
  assert.deepEqual(await aboutData.fetchRelayHealthVersion(okFetch), { version: "4.0.0", proto: 21 })

  const failFetch = async () => new Response("bad", { status: 500 })
  assert.equal(await aboutData.fetchRelayHealthVersion(failFetch), null)
  assert.equal(await aboutData.fetchRelayHealthVersion(async () => { throw new Error("network") }), null)

  const diag = aboutData.buildDiagnosticsExport({
    hostDiag: null,
    relay: {
      serverName: "relay.example",
      serverProto: 21,
      relayVersion: "4.0.0",
      clientVersion: "4.0.0",
      browserOnline: true,
      authed: true,
      deviceMode: false,
    },
    devices: [],
    selectedDeviceId: null,
    appVersion: "4.0.0",
    now: Date.UTC(2026, 10, 15, 12, 0, 0),
  })
  const parsed = JSON.parse(diag.text)
  assert.equal(parsed.relay.relayVersion, "4.0.0")
  assert.equal(parsed.relay.serverProto, 21)
})

test("extensionsLogic：资源前缀、内置开关、自定义资源与 packages 增删启停", () => {
  assert.deepEqual(extLogic.stripResourcePrefix("  -skills/a "), { prefix: "-", bare: "skills/a" })
  assert.deepEqual(extLogic.stripResourcePrefix("+builtin:mcp"), { prefix: "+", bare: "builtin:mcp" })
  assert.deepEqual(extLogic.stripResourcePrefix("prompts/p.md"), { prefix: "", bare: "prompts/p.md" })

  assert.equal(extLogic.isResourceEnabled(null, ["builtin:mcp"], true), true)
  assert.equal(extLogic.isResourceEnabled(["-builtin:mcp"], ["builtin:mcp"], true), false)
  assert.equal(extLogic.isResourceEnabled(["+builtin:llama.cpp"], ["builtin:llama.cpp"], false), true)

  assert.deepEqual(extLogic.toggleResourceEntry([], "builtin:mcp", false, true), ["-builtin:mcp"])
  assert.deepEqual(extLogic.toggleResourceEntry(["-builtin:mcp"], "builtin:mcp", true, true), [])
  assert.deepEqual(extLogic.toggleResourceEntry([], "builtin:llama.cpp", true, false), ["+builtin:llama.cpp"])

  const added = extLogic.addResourceEntry(["-skills/review"], "  skills/review  ")
  assert.deepEqual(added, ["skills/review"])
  assert.equal(extLogic.addResourceEntry([], "   "), null)
  assert.deepEqual(extLogic.removeResourceEntry(["skills/a", "-skills/b"], "skills/b"), ["skills/a"])

  const customRows = extLogic.customResourceRowsOf(["builtin:mcp", "ext/a.ts", "-ext/b.ts"], ["ext/a.ts"])
  assert.deepEqual(customRows, [{ raw: "-ext/b.ts", target: "ext/b.ts", enabled: false }])

  const pkgs = ["npm:pi-a", { source: "npm:pi-b", skills: ["s1"] }]
  assert.deepEqual(extLogic.packageRowsOf(pkgs), [
    { key: "0:npm:pi-a", index: 0, source: "npm:pi-a", enabled: true },
    { key: "1:npm:pi-b", index: 1, source: "npm:pi-b", enabled: true },
  ])
  const toggled = extLogic.togglePackageEntry(pkgs, 1, false)
  assert.deepEqual(toggled[1], { source: "-npm:pi-b", skills: ["s1"] })
  assert.deepEqual(extLogic.addPackageEntry(pkgs, "npm:pi-b"), ["npm:pi-a", "npm:pi-b"])
  assert.deepEqual(extLogic.removePackageEntry(pkgs, 0), [{ source: "npm:pi-b", skills: ["s1"] }])
})

test("approvalData：询问模式映射与免审命令名单安全校验", () => {
  assert.equal(approvalData.approvalAskModeOf(false, false), "never")
  assert.equal(approvalData.approvalAskModeOf(false, true), "never")
  assert.equal(approvalData.approvalAskModeOf(true, true), "allowlist")
  assert.equal(approvalData.approvalAskModeOf(true, false), "ask")

  assert.deepEqual(approvalData.validateAllowlistCommand("  git status "), { ok: true, value: "git status" })
  assert.deepEqual(approvalData.validateAllowlistCommand("npm test *"), { ok: true, value: "npm test *" })
  assert.equal(approvalData.validateAllowlistCommand("   ").ok, false)
  assert.equal(approvalData.validateAllowlistCommand("a".repeat(161)).ok, false)
  assert.equal(approvalData.validateAllowlistCommand("git status\nrm -rf /").ok, false)
  for (const bad of ["git status && ls", "a || b", "a; b", "a | grep x", "echo `id`", "a > b", "echo $(id)"]) {
    assert.equal(approvalData.validateAllowlistCommand(bad).ok, false, `必须拒绝危险符号：${bad}`)
  }
})

test("voiceDictation：SpeechRecognition 探测、结果拼接、草稿合入、语言与快捷键匹配", () => {
  class StdRec {}
  class WebkitRec {}
  assert.equal(voice.speechRecognitionCtorOf({ SpeechRecognition: StdRec, webkitSpeechRecognition: WebkitRec }), StdRec)
  assert.equal(voice.speechRecognitionCtorOf({ webkitSpeechRecognition: WebkitRec }), WebkitRec)
  assert.equal(voice.speechRecognitionCtorOf({}), null)

  const transcript = voice.collectRecognitionTranscript([
    { 0: { transcript: "打开" } },
    { 0: { transcript: "设置页" } },
  ])
  assert.equal(transcript, "打开设置页")
  assert.equal(voice.collectRecognitionTranscript(null), "")

  assert.equal(voice.mergeDictationDraft("", " 你好 "), "你好")
  assert.equal(voice.mergeDictationDraft("检查", "测试"), "检查 测试")
  assert.equal(voice.mergeDictationDraft("检查 ", "测试"), "检查 测试")
  assert.equal(voice.mergeDictationDraft("检查\n", "测试"), "检查\n测试")
  assert.equal(voice.mergeDictationDraft("检查", "   "), "检查")

  assert.equal(voice.resolveRecognitionLang("zh", "en-US"), "zh-CN")
  assert.equal(voice.resolveRecognitionLang("en", "zh-CN"), "en-US")
  assert.equal(voice.resolveRecognitionLang("auto", "en-GB"), "en-GB")
  assert.equal(voice.resolveRecognitionLang("auto", "en"), "en-US")
  assert.equal(voice.resolveRecognitionLang("auto", "zh-TW"), "zh-TW")
  assert.equal(voice.resolveRecognitionLang("auto", ""), "zh-CN")

  assert.equal(voice.dictationShortcutMatchesEvent("Caps Lock", { key: "CapsLock" }), true)
  assert.equal(voice.dictationShortcutMatchesEvent("Caps Lock", { key: "CapsLock", shiftKey: true }), false)
  assert.equal(voice.dictationShortcutMatchesEvent("⌥ + Space", { key: " ", altKey: true }), true)
  assert.equal(voice.dictationShortcutMatchesEvent("Alt + Space", { key: " ", altKey: true }), true)
  assert.equal(voice.dictationShortcutMatchesEvent("Alt + Space", { key: " ", altKey: true, isComposing: true }), false)
  assert.equal(voice.dictationShortcutMatchesEvent("Alt + Space", { key: " ", altKey: true, repeat: true }), false)
})

test("monthlyQuota：当月累计、预算比、供应商分布，且不含费用文案", () => {
  const src = read("ui/src/pi/usage/monthlyQuota.ts")
  assert.doesNotMatch(src, /费用|cost/i)

  assert.equal(quota.monthlyBudgetPresetLabel(0), "不设上限")
  assert.equal(quota.monthlyBudgetPresetLabel(20_000_000), "20M")

  const summary = quota.monthlyQuotaSummaryOf(
    {
      version: 1,
      days: [
        { date: "2026-10-31", sessions: 2, messages: { user: 4 }, tokens: { total: 9_000_000 } },
        { date: "2026-11-02", sessions: 3, messages: { user: 10 }, tokens: { total: 4_000_000 } },
        { date: "2026-11-15", sessions: 1, messages: { user: 2 }, tokens: { total: 2_000_000 } },
      ],
      summary: {
        models: [
          { provider: "anthropic", model: "claude", tokens: 3_000_000 },
          { provider: "openai", model: "gpt", tokens: 1_500_000 },
          { provider: "", model: "local", tokens: 500_000 },
        ],
      },
    },
    "2026-11-15",
    5_000_000,
  )
  assert.equal(summary.monthPrefix, "2026-11")
  assert.equal(summary.monthLabel, "11月")
  assert.equal(summary.monthTokens, 6_000_000)
  assert.equal(summary.monthMessages, 12)
  assert.equal(summary.monthSessions, 4)
  assert.equal(summary.activeDays, 2)
  assert.equal(summary.overBudget, true)
  assert.ok(Math.abs((summary.usageRatio ?? 0) - 1.2) < 1e-9)
  assert.equal(summary.topProviders[0].provider, "anthropic")
  assert.ok(Math.abs(summary.topProviders[0].share - 0.6) < 1e-9)
  assert.equal(summary.topProviders[2].provider, "其他")

  const empty = quota.monthlyQuotaSummaryOf(null, "2026-11-15", 0)
  assert.equal(empty.monthTokens, 0)
  assert.equal(empty.usageRatio, null)
  assert.equal(empty.overBudget, false)
  assert.deepEqual(empty.topProviders, [])
})

test("UI 接线契约：手机端面板标题下拉菜单与输入框语音麦克风按钮", () => {
  const paneTabs = read("ui/src/components/pi/conversation/PiPaneTabs.tsx")
  const paneContainer = read("ui/src/pi/containers/PaneContainer.tsx")
  const composerContainer = read("ui/src/pi/containers/ComposerContainer.tsx")
  const followUpComposer = read("ui/src/components/pi/composer/PiFollowUpComposer.tsx")
  const composerDock = read("ui/src/components/pi/composer/PiComposerDock.tsx")

  assert.match(paneTabs, /export function PiPaneTitle\([\s\S]*onSelect/)
  assert.match(paneTabs, /if \(isStatic \|\| !onSelect\) return trigger/)
  assert.match(paneTabs, /<PiMenu kind="dropdown" trigger=\{trigger\}/)
  assert.match(paneContainer, /<PiPaneTitle[\s\S]*onSelect=\{\(kind\) => act\.setPane\(kind\)\}/)

  assert.match(composerContainer, /useVoiceDictation/)
  assert.match(composerContainer, /data-cw-id="pi-composer-mic"/)
  assert.match(followUpComposer, /voiceSlot\?: ReactNode/)
  assert.match(composerDock, /voiceSlot\?: ReactNode/)
})
