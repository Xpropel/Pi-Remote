// 设置页 v2 · 第 3 轮 P3 修复回归：
//   1. 手机外接硬件键盘 Ctrl/Meta+Enter：走桌面 sendKey；裸 Enter 仍按软键盘换行；
//   2. 隐私属性即时生效：设置页写存储后同标签页广播，宿主不再等 1s 轮询；
//   3. 检查更新：Releases 列表 200 + [] 代替 releases/latest 的预期 404。
//
// 纯决策直接驱动；React 接线 / 生效链路用源码断言钉住（与 R2 宿主测试同法，不启动浏览器）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")

const sendKey = await import("../ui/src/pi/headless/composerSendKey.ts")
const settings = await import("../ui/src/pi/settings/model.ts")
const aboutData = await import("../ui/src/pi/settings/pages/aboutData.ts")

const key = (patch = {}) => ({
  key: "Enter",
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  keyCode: 13,
  ...patch,
})

/* ------------------------------------------------------------------ */
/* 1. 手机外接硬件键盘                                                   */
/* ------------------------------------------------------------------ */

test("P3-1 手机外接键盘：Ctrl/Meta+Enter 按桌面 sendKey（enter=换行 / ctrl-enter=发送）", () => {
  for (const pref of ["enter", "ctrl-enter"]) {
    const d = (patch) => sendKey.decideComposerEnter(key({ mobile: true, ...patch }), pref)
    const modified = pref === "ctrl-enter" ? "send" : "newline"
    assert.equal(d({ ctrlKey: true }), modified, `${pref}: 手机 Ctrl+Enter`)
    assert.equal(d({ metaKey: true }), modified, `${pref}: 手机 Cmd/Meta+Enter`)
    assert.equal(d({ ctrlKey: true, shiftKey: true }), "newline", `${pref}: Ctrl+Shift+Enter 恒换行`)
    assert.equal(d({ metaKey: true, shiftKey: true }), "newline", `${pref}: Cmd+Shift+Enter 恒换行`)
    assert.equal(d({ ctrlKey: true, altKey: true }), "ignore", `${pref}: Ctrl+Alt+Enter 不抢`)
    assert.equal(d({ isComposing: true, ctrlKey: true }), "ignore", `${pref}: 组字中不发送`)
    assert.equal(d({ keyCode: 229, metaKey: true }), "ignore", `${pref}: Safari 组字 keyCode 229`)
  }
})

test("P3-1 手机裸 Enter / Shift / Alt：软键盘策略不变（原生换行，不消费桌面偏好）", () => {
  for (const pref of ["enter", "ctrl-enter"]) {
    const d = (patch) => sendKey.decideComposerEnter(key({ mobile: true, ...patch }), pref)
    assert.equal(d({}), "native", `${pref}: 无修饰键 Enter 仍换行`)
    assert.equal(d({ shiftKey: true }), "native", `${pref}: 手机 Shift+Enter`)
    assert.equal(d({ altKey: true }), "native", `${pref}: 手机 Alt+Enter`)
    assert.equal(d({ key: "a" }), "ignore")
  }
})

test("P3-1 桌面语义不受影响：Ctrl/Cmd 与 Shift / Alt 的优先级照旧", () => {
  for (const pref of ["enter", "ctrl-enter"]) {
    const d = (patch) => sendKey.decideComposerEnter(key(patch), pref)
    assert.equal(d({}), pref === "ctrl-enter" ? "newline" : "send")
    assert.equal(d({ ctrlKey: true }), pref === "ctrl-enter" ? "send" : "newline")
    assert.equal(d({ metaKey: true }), pref === "ctrl-enter" ? "send" : "newline")
    assert.equal(d({ ctrlKey: true, shiftKey: true }), "newline")
    assert.equal(d({ ctrlKey: true, altKey: true }), "ignore")
  }
})

test("P3-1 三套手机 composer / 新建页都传 mobile：裸 Enter 换行、外接键盘 Ctrl+Enter 一致", () => {
  const mobileWired = [
    ["ui/src/components/pi/composer/PiFollowUpComposer.tsx", /mobile: phone/],
    ["ui/src/components/pi/composer/PiEmptyComposer.tsx", /mobile: phone/],
    ["ui/src/pi/variants/claude/composer/ClaudeComposer.tsx", /mobile: variant === "phone"/],
    ["ui/src/pi/variants/codex/composer/CodexComposer.tsx", /mobile: phone/],
    ["ui/src/pi/variants/claude/pages/ClaudeNewSession.tsx", /mobile: phone/],
    ["ui/src/pi/variants/codex/pages/CodexNewSession.tsx", /mobile: phone/],
  ]
  for (const [file, pattern] of mobileWired) {
    assert.match(read(file), pattern, `${file} 未把手机壳标记传给共享 Enter 决策`)
  }
  const claudeNew = read("ui/src/pi/variants/claude/pages/ClaudeNewSession.tsx")
  assert.match(claudeNew, /phone = false/, "Claude 新建页要显式区分手机壳")
  assert.match(
    read("ui/src/pi/variants/claude/shell/ClaudePhoneShell.tsx"),
    /<ClaudeNewSession p=\{p\} phone \/>/,
    "Claude 手机壳的新建页要传 phone",
  )
  const hook = read("ui/src/pi/headless/useComposerEnter.ts")
  assert.match(hook, /ctrlKey: event\.ctrlKey/)
  assert.match(hook, /metaKey: event\.metaKey/)
  assert.match(hook, /mobile,/)
})

/* ------------------------------------------------------------------ */
/* 2. 隐私属性即时生效                                                   */
/* ------------------------------------------------------------------ */

test("P3-2 设置页写入后同标签页广播：宿主监听事件立即回读，不等 1s 轮询", () => {
  assert.equal(settings.SETTINGS_PREFS_EVENT, "pi-remote:settings-prefs")
  const context = read("ui/src/pi/settings/SettingsContext.tsx")
  // R5 起写入在动作里同步完成（读最新存储 → 合并 patch → 写回 → 当帧广播），比原来的布局 effect 更早。
  assert.match(context, /const commit = useCallback\([\s\S]*?saveSettingsLocal\(target\(\), next\)[\s\S]*?window\.dispatchEvent\(new Event\(SETTINGS_PREFS_EVENT\)\)/)
  assert.doesNotMatch(context, /useLayoutEffect\(\(\) => \{[\s\S]*?saveSettingsLocal/, "写存储 + 广播不能等绘制后")
  assert.match(context, /window\.addEventListener\("storage", onStorage\)/, "缺少跨标签页 storage 同步")

  const prefsHook = read("ui/src/pi/hooks/usePiSettingsPrefs.ts")
  assert.match(prefsHook, /window\.addEventListener\(SETTINGS_PREFS_EVENT, refresh\)/)
  assert.match(prefsHook, /window\.removeEventListener\(SETTINGS_PREFS_EVENT, refresh\)/)
  assert.match(prefsHook, /const raw = readRaw\(storage\)/, "先比原始串，没变就不解析")

  const root = read("ui/src/pi/headless/root.tsx")
  assert.match(root, /useLayoutEffect\(\(\) => \{[\s\S]*?el\.setAttribute\("data-pi-privacy", "on"\)/)
  assert.match(root, /el\.removeAttribute\("data-pi-privacy"\)/)
  assert.match(root, /data-pi-privacy=\{privacy \? "on" : undefined\}/)
})

/* ------------------------------------------------------------------ */
/* 3. 检查更新 404 降噪                                                  */
/* ------------------------------------------------------------------ */

test("P3-3 检查更新用 Releases 列表：没有 Release 时 200 + []，不再请求会 404 的 latest", async () => {
  assert.match(aboutData.GITHUB_RELEASES_API, /\/releases\?per_page=10$/)
  assert.doesNotMatch(aboutData.GITHUB_RELEASES_API, /\/releases\/latest$/)

  const response = (status, payload) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
  })

  const none = await aboutData.checkLatestRelease("4.0.0", {
    fetchImpl: async () => response(200, []),
  })
  assert.equal(none.status, "none")
  assert.match(none.text, /还没有发布版本/)

  const inaccessible = await aboutData.checkLatestRelease("4.0.0", {
    fetchImpl: async () => response(404, { message: "Not Found" }),
  })
  assert.equal(inaccessible.status, "error")
  assert.doesNotMatch(inaccessible.text, /还没有发布版本/, "404 不能断言没有 Release")
  assert.match(inaccessible.text, /未公开|还没有 Release/)
})
