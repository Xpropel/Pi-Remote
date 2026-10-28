// 设置页 v2 · 第 2 轮宿主消费（P1-2 / R10）：
//   1. sendKey 偏好（Enter / Ctrl+Enter）在 composer 键盘路径被真实消费；
//   2. 通知（等待 / 出错 / 完成 × 仅页面外 / 总是 × 声音 / 应用内 / 角标）在真实事件下按开关发。
//
// 纯决策直接驱动；React 接线用源码断言钉住（与 pi-settings-host*.test 同法，不启动浏览器）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")

const sendKey = await import("../ui/src/pi/headless/composerSendKey.ts")
const settings = await import("../ui/src/pi/settings/model.ts")
const host = await import("../ui/src/pi/model/settingsHost.ts")
const sound = await import("../ui/src/chat/composer/soundDecision.ts")

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
/* 1. sendKey 纯决策                                                     */
/* ------------------------------------------------------------------ */

test("sendKey 默认值 / normalize：缺失或坏值回落 enter，合法值原样", () => {
  assert.equal(settings.DEFAULT_SETTINGS_PREFS.sendKey, "enter")
  assert.equal(sendKey.PI_SEND_KEY_DEFAULT, "enter")
  assert.deepEqual([...sendKey.PI_SEND_KEYS], ["enter", "ctrl-enter"])
  assert.equal(sendKey.normalizeSendKey(undefined), "enter")
  assert.equal(sendKey.normalizeSendKey("ctrl-enter"), "ctrl-enter")
  assert.equal(sendKey.normalizeSendKey("enter"), "enter")
  assert.equal(sendKey.normalizeSendKey("cmd-enter"), "enter")
  assert.equal(settings.parseSettingsLocal({ v: 1, prefs: { sendKey: "ctrl-enter" } }).prefs.sendKey, "ctrl-enter")
  assert.equal(settings.parseSettingsLocal({ v: 1, prefs: { sendKey: "boom" } }).prefs.sendKey, "enter")
})

test("sendKey=enter：Enter 发送、Ctrl/Cmd+Enter 换行、Shift+Enter 恒换行", () => {
  const d = (patch) => sendKey.decideComposerEnter(key(patch), "enter")
  assert.equal(d({}), "send")
  assert.equal(d({ ctrlKey: true }), "newline")
  assert.equal(d({ metaKey: true }), "newline")
  assert.equal(d({ shiftKey: true }), "newline", "Shift+Enter 恒换行")
  assert.equal(d({ ctrlKey: true, shiftKey: true }), "newline", "带 Shift 一律换行")
  assert.equal(d({ metaKey: true, shiftKey: true }), "newline")
  assert.equal(d({ altKey: true }), "ignore", "Alt 组合不抢")
  assert.equal(d({ ctrlKey: true, altKey: true }), "ignore")
})

test("sendKey=ctrl-enter：Enter 换行、Ctrl/Cmd+Enter 发送、Shift+Enter 恒换行", () => {
  const d = (patch) => sendKey.decideComposerEnter(key(patch), "ctrl-enter")
  assert.equal(d({}), "newline")
  assert.equal(d({ ctrlKey: true }), "send")
  assert.equal(d({ metaKey: true }), "send")
  assert.equal(d({ shiftKey: true }), "newline")
  assert.equal(d({ ctrlKey: true, shiftKey: true }), "newline")
  assert.equal(d({ altKey: true }), "ignore")
  assert.equal(d({ ctrlKey: true, altKey: true }), "ignore")
})

test("输入法组字 / 非 Enter / 手机 Enter：不消费偏好（Ctrl/Cmd 组合见 R3 矩阵）", () => {
  for (const pref of ["enter", "ctrl-enter"]) {
    const d = (patch) => sendKey.decideComposerEnter(key(patch), pref)
    assert.equal(d({ isComposing: true }), "ignore", `${pref}: 组字中不发送/不换行`)
    assert.equal(d({ keyCode: 229 }), "ignore", `${pref}: Safari 组字 keyCode 229`)
    assert.equal(d({ key: "a" }), "ignore")
    assert.equal(d({ mobile: true }), "native", `${pref}: 手机裸 Enter 保持原生换行`)
    assert.equal(d({ mobile: true, shiftKey: true }), "native", `${pref}: 手机 Shift+Enter 仍原生换行`)
    assert.equal(d({ mobile: true, altKey: true }), "native", `${pref}: 手机 Alt+Enter 仍原生换行`)
  }
})

test("insertComposerNewline：光标 / 选区 / 越界都插在正确位置", () => {
  assert.deepEqual(sendKey.insertComposerNewline("abcd", 2, 2), { draft: "ab\ncd", caret: 3 })
  assert.deepEqual(sendKey.insertComposerNewline("abcd", 1, 3), { draft: "a\nd", caret: 2 }, "替换选区")
  assert.deepEqual(sendKey.insertComposerNewline("", 0, 0), { draft: "\n", caret: 1 })
  assert.deepEqual(sendKey.insertComposerNewline("ab", -5, 99), { draft: "\n", caret: 1 }, "越界区间夹到全文")
  assert.deepEqual(sendKey.insertComposerNewline("ab", -5, 1), { draft: "\nb", caret: 1 }, "负起点夹到 0")
  assert.deepEqual(sendKey.insertComposerNewline("ab", 2, 1), { draft: "ab\n", caret: 3 }, "反序选区按光标点处理")
})

/* ------------------------------------------------------------------ */
/* 1b. sendKey 接线：所有发送入口走同一 hook                             */
/* ------------------------------------------------------------------ */

const COMPOSERS = [
  "ui/src/components/pi/composer/PiFollowUpComposer.tsx",
  "ui/src/components/pi/composer/PiEmptyComposer.tsx",
  "ui/src/pi/variants/claude/composer/ClaudeComposer.tsx",
  "ui/src/pi/variants/codex/composer/CodexComposer.tsx",
  "ui/src/pi/variants/claude/pages/ClaudeNewSession.tsx",
  "ui/src/pi/variants/codex/pages/CodexNewSession.tsx",
  "ui/src/pi/variants/codex/panels/CodexSideChat.tsx",
]

test("每个发送入口都 import 并使用 useComposerEnter，不再各自硬编码 Enter 发送", () => {
  for (const file of COMPOSERS) {
    const src = read(file)
    assert.match(src, /from "@\/pi\/headless\/useComposerEnter"/, `${file} 未 import 共享 Enter 决策`)
    assert.match(src, /useComposerEnter\(\{/, `${file} 未使用 useComposerEnter`)
    assert.doesNotMatch(src, /event\.key === "Enter"/, `${file} 仍保留自己的 Enter 分支`)
  }
})

test("发送键从设置存储到 composer：PiSettingsHost 提供 prefs.sendKey，hook 读同一 key", () => {
  const hostSrc = read("ui/src/pi/hooks/PiSettingsHost.tsx")
  const prefsHook = read("ui/src/pi/hooks/usePiSettingsPrefs.ts")
  const context = read("ui/src/pi/headless/sendKeyContext.ts")
  const provider = read("ui/src/pi/headless/sendKeyProvider.tsx")
  const hook = read("ui/src/pi/headless/useComposerEnter.ts")
  assert.match(hostSrc, /const prefs = usePiSettingsPrefs\(\)/)
  assert.match(hostSrc, /<PiSendKeyProvider value=\{prefs\.sendKey\}>/)
  assert.match(prefsHook, /SETTINGS_STORAGE_KEY/)
  assert.match(context, /useContext\(PiSendKeyContext\)/)
  assert.match(provider, /normalizeSendKey\(value\)/)
  assert.match(hook, /const sendKey = usePiSendKey\(\)/)
  assert.match(hook, /decideComposerEnter\(/)
  assert.match(hook, /insertComposerNewline\(value, start, end\)/)
  assert.match(hook, /event\.preventDefault\(\)/)
  assert.match(hook, /el\.setSelectionRange\(at, at\)/)
  assert.match(hook, /isComposing: event\.nativeEvent\.isComposing/)
  assert.match(hook, /keyCode: event\.keyCode/)
})

/* ------------------------------------------------------------------ */
/* 2. 通知纯决策                                                         */
/* ------------------------------------------------------------------ */

const NOTIFY_FIELDS = {
  waiting: "notifyWaiting",
  done: "notifyComplete",
  error: "notifyError",
}

const gateOf = (patch) => host.notificationGateOf(settings.mergeSettingsPrefs(settings.createDefaultSettingsPrefs(), patch))

test("通知矩阵：等待 / 完成 / 出错 × 仅页面外 / 总是 × 声音 / 角标 / 应用内", () => {
  const booleans = [false, true]
  for (const isWaiting of booleans) {
    for (const isComplete of booleans) {
      for (const isError of booleans) {
        for (const onlyWhenAway of booleans) {
          for (const withSound of booleans) {
            for (const withBadge of booleans) {
              for (const away of booleans) {
                const gate = gateOf({
                  notifyWaiting: isWaiting,
                  notifyComplete: isComplete,
                  notifyError: isError,
                  notifyOnlyWhenAway: onlyWhenAway,
                  notifySound: withSound,
                  notifyBadge: withBadge,
                })
                for (const kind of ["waiting", "done", "error"]) {
                  const enabled = kind === "waiting" ? isWaiting : kind === "done" ? isComplete : isError
                  const awayOk = !onlyWhenAway || away
                  const expected = enabled && awayOk
                  const notice = host.notificationNoticeOf(gate, kind, away)
                  assert.equal(Boolean(notice), expected, `notice ${kind} enabled=${enabled} awayOk=${awayOk}`)
                  if (notice) {
                    assert.equal(notice.level, kind === "waiting" ? "warning" : kind === "error" ? "error" : "success")
                    assert.equal(notice.title.includes("会话"), false, "提醒文案不带会话名")
                  }
                  assert.equal(host.notificationSoundVisible(gate, kind, away), expected && withSound)
                  assert.equal(host.notificationBadgeVisible(gate, kind, away), expected && withBadge)
                }
              }
            }
          }
        }
      }
    }
  }
})

test("等待提醒：只在 key 集合新增时触发；首次快照 / 同集合 / 关闭期间不补发", () => {
  assert.deepEqual(host.freshWaitingKeys(null, ["a", "b"]), [], "页面打开时已经挂着的等待不补发")
  assert.deepEqual(host.freshWaitingKeys(["a"], ["a"]), [])
  assert.deepEqual(host.freshWaitingKeys(["a"], ["a", "b"]), ["b"])
  assert.deepEqual(host.freshWaitingKeys(["a", "b"], ["b", "c"]), ["c"], "一个关了、另一个开了仍算新事件")
  assert.deepEqual(host.freshWaitingKeys(["a"], []), [])
  const gate = gateOf({ notifyWaiting: true, notifyOnlyWhenAway: false, notifySound: true })
  assert.equal(host.notificationNoticeOf(gate, "waiting", false)?.title, "有任务等你确认")
  assert.equal(host.notificationSoundVisible(gate, "waiting", false), true)
  assert.equal(host.notificationBadgeVisible(gate, "waiting", false), true)
  assert.equal(host.notificationNoticeOf(gateOf({ notifyWaiting: false }), "waiting", true), null)
})

test("等待提示音有独立音色，且与 done / error 不同", () => {
  const waiting = sound.toneSpecsFor("waiting")
  assert.equal(waiting.length, 2)
  assert.ok(waiting.every((tone) => tone.to >= tone.from), "等待音色整体上行（像提问）")
  assert.notDeepEqual(waiting, sound.toneSpecsFor("done"))
  assert.notDeepEqual(waiting, sound.toneSpecsFor("error"))
})

test("通知接线：宿主消费 waiting keys；hook 在新增时发应用内提醒 + 提示音", () => {
  const hostSrc = read("ui/src/pi/hooks/PiSettingsHost.tsx")
  const hook = read("ui/src/pi/hooks/useCompletionNotice.ts")
  const gallery = read("ui/src/pi/dev/LiveRoute.tsx")
  assert.match(hostSrc, /const attention = useAttentionState\(relay\)/)
  assert.match(hostSrc, /useWaitingNotice\(relay, \{ gate, enabled: notifications, waitingKeys: attention\.waitingKeys \}\)/)
  assert.match(hook, /export function useWaitingNotice/)
  assert.match(hook, /freshWaitingKeys\(seenRef\.current, waitingKeys\)/)
  assert.match(hook, /notificationNoticeOf\(gate, "waiting", away\)/)
  assert.match(hook, /playCompletionSound\("waiting", \{ enabled: gate\.sound, requireAway: gate\.onlyWhenAway \}\)/)
  assert.match(hook, /notificationSoundVisible\(gate, "waiting", away\)/)
  assert.match(hook, /if \(!enabled \|\| fresh\.length === 0\) return/)
  // gallery 的受控真实事件：done / error = turnEnd；waiting = 挂载后新开 ui_prompt。
  assert.match(gallery, /kind === "done" \|\| kind === "error" \|\| kind === "waiting"/)
  assert.match(gallery, /uiPrompt: \{ kind: "confirm", title: "等你确认（画廊受控事件）"/)
  assert.match(gallery, /pushNotice: noticeStore\.push/)
  assert.match(gallery, /notices: noticeState\.visible/)
})

test("关闭时不发：完成/出错/等待三类在开关关闭时都不产生通知或声音", () => {
  const off = gateOf({
    notifyWaiting: false,
    notifyComplete: false,
    notifyError: false,
    notifySound: true,
    notifyOnlyWhenAway: false,
    notifyBadge: true,
  })
  for (const kind of ["waiting", "done", "error"]) {
    assert.equal(host.notificationNoticeOf(off, kind, false), null, `${kind} 应用内提醒关闭`)
    assert.equal(host.notificationSoundVisible(off, kind, false), false, `${kind} 提示音关闭`)
    assert.equal(host.notificationBadgeVisible(off, kind, true), false, `${kind} 角标关闭`)
  }
})
