// S4 第五轮：新会话流（目录已有会话在运行的提示、手机文件夹浏览器登记成一层 sheet、预选进页冻结、热更新保住选择）
// 与细节（显示选项的设置键帽、文件夹浏览器的初始焦点、重新回答的说法、手机状态行不重复设备名）。纯函数直接跑；接线看源码。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { hasRunningRoom, recentFoldersOf } from "../ui/src/pi/model/newSession.ts"
import { PI_SHORTCUT_KEYS, piPlatformOf } from "../ui/src/pi/model/shortcuts.ts"
import { regenerateTargetOf } from "../ui/src/components/pi/composer/regenerateTarget.ts"

const read = (p) => fs.readFileSync(new URL(`../ui/src/${p}`, import.meta.url), "utf8")
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
const between = (src, from, to) => {
  const at = src.indexOf(from)
  assert.ok(at >= 0, `找不到 ${from}`)
  return src.slice(at, to ? src.indexOf(to, at) : undefined)
}

describe("新会话：选目录时就提示目录里已有会话在运行", () => {
  const room = (cwd, online = true, deviceId = "pc") => ({ id: "r", cwd, online, deviceId })
  test("判断口径 = hasRunningRoom（attach findOnline / already_running 同一口径）", () => {
    assert.equal(hasRunningRoom([room("D:\\pi-e2e\\s4\\r5")], "pc", "d:/pi-e2e/s4/r5/"), true)
    assert.equal(hasRunningRoom([room("D:\\pi-e2e\\s4\\r5", false)], "pc", "D:\\pi-e2e\\s4\\r5"), false)
    assert.equal(hasRunningRoom([room("D:\\pi-e2e\\s4")], "pc", "D:\\pi-e2e\\s4\\r5"), false, "父目录有会话不算")
  })
  test("NewComposer：在线设备 + 选中目录有在线房间 → 框下 role=status 的提示；启动中 / 失败 / 离线优先", () => {
    const src = code(read("pi/containers/NewSessionContainer.tsx"))
    assert.match(src, /import \{[^}]*\brunningRoomOf\b[^}]*\} from "@\/pi\/model\/newSession"/)
    assert.match(src, /const runningRoom = !isStatic && !starting && !state\.error && device\?\.online && folder \? runningRoomOf\(liveRooms, device\.id, folder\) : null/)
    const notes = between(src, "let note: ReactNode = null", "const pickSuggestion")
    assert.ok(notes.indexOf("if (starting)") < notes.indexOf("} else if (state.error)"))
    assert.ok(notes.indexOf("} else if (device && !device.online)") < notes.indexOf("} else if (runningRoom)"))
    assert.match(notes, /<span role="status">这个目录已有会话在运行，发送后会进入它<\/span>/)
    assert.match(src, /const below = runningRoom && pills \? <div className="flex min-w-0 flex-col gap-3">\{note\}\{pills\}<\/div> : \(note \?\? pills\)/, "桌面提示和建议 pill 并排留着")
  })
  test("点选未载入会话时它的合成房间不算在跑：提示和预选都用去掉它的 liveRooms", () => {
    const lazy = read("relay/lazySession.ts")
    assert.match(between(lazy, "export function lazyRoomFromRow(", "\n}\n"), /online: true,/, "前提：合成房间 online = 设备在线")
    const sel = between(code(read("pi/containers/NewSessionContainer.tsx")), "function useSelection(", "\n}\n")
    assert.match(sel, /const lazyId = relay\.lazySession\?\.id/)
    assert.match(sel, /const liveRooms = useMemo\(\(\) => \(lazyId \? relay\.rooms\.filter\(\(room\) => room\.id !== lazyId\) : relay\.rooms\), \[relay\.rooms, lazyId\]\)/)
    assert.match(sel, /rooms: liveRooms, sessionsByDevice/)
    assert.doesNotMatch(sel, /rooms: relay\.rooms/)
  })
  test("最近目录按设备平台去重：Windows 上 D:/x 与 D:\\x 是同一个，只留最新的写法，不再挤掉别的目录；Linux 区分大小写", () => {
    const win = { projects: [], browseRoots: ["D:\\"], platform: "win32" }
    const at = (cwd, updatedAt) => ({ cwd, updatedAt })
    const sessions = [at("D:/pi-e2e/s2", 9), at("D:\\pi-e2e\\s3\\c", 8), at("D:\\pi-e2e\\s2", 7), at("d:\\PI-E2E\\s2\\", 6), at("D:\\pi-e2e\\s6\\r3", 5), at("D:\\pi-e2e\\s4\\r5", 4), at("D:\\pi-e2e\\s4", 3)]
    assert.deepEqual(recentFoldersOf(sessions, win), ["D:/pi-e2e/s2", "D:\\pi-e2e\\s3\\c", "D:\\pi-e2e\\s6\\r3", "D:\\pi-e2e\\s4\\r5", "D:\\pi-e2e\\s4"])
    const linux = { projects: [], browseRoots: ["/home/a"], platform: "linux" }
    assert.deepEqual(recentFoldersOf([at("/home/a/Proj", 2), at("/home/a/proj", 1), at("/home/a/Proj/", 0)], linux), ["/home/a/Proj", "/home/a/proj"])
  })
})

describe("手机文件夹浏览器：登记成一层 sheet，系统返回只关它", () => {
  test("cShared：新的 sheet id c:new-browse", () => {
    assert.match(code(read("pi/containers/cShared.ts")), /newBrowse: "c:new-browse",/)
  })
  test("NewSheets：浏览器按 ui.sheet 画（不再看模块 store 的 browsing）；取消回文件夹 sheet，选中后关 sheet", () => {
    const src = code(read("pi/containers/NewSessionContainer.tsx"))
    const sheets = between(src, "function NewSheets(", "export function NewSessionContainer(")
    assert.doesNotMatch(sheets, /state\.browsing/)
    assert.match(sheets, /if \(id === C_IDS\.newBrowse && device\) \{/)
    assert.match(sheets, /const closeBrowser = \(open: boolean\) => \{\s*if \(!open\) act\.openSheet\(\{ id: C_IDS\.newFolder \}\)\s*\}/)
    assert.match(sheets, /onPick=\{\(path\) => \{\s*setStore\(\{ folder: path, error: null \}\)\s*close\(\)\s*\}\}/)
    assert.match(sheets, /returnFocus=\{byCwId\("pi-new-folder"\)\}/)
  })
  test("「打开文件夹…」换成浏览器 sheet：跳过 PiFolderPicker 紧跟着调的那一次宿主 close", () => {
    const picker = code(read("components/pi/composer/PiFolderPicker.tsx"))
    assert.match(picker, /const browse = \(\) => \{\s*onBrowse\?\.\(\)\s*close\?\.\(\)\s*\}/, "前提：先 onBrowse 再 close")
    const sheets = between(code(read("pi/containers/NewSessionContainer.tsx")), "function NewSheets(", "export function NewSessionContainer(")
    assert.match(sheets, /const closeFolder = \(\) => \{\s*if \(keepSheet\.current\) keepSheet\.current = false\s*else close\(\)\s*\}/)
    assert.match(sheets, /const openBrowser = \(\) => \{\s*keepSheet\.current = true\s*act\.openSheet\(\{ id: C_IDS\.newBrowse \}\)\s*queueMicrotask\(/)
    assert.match(sheets, /<SheetHost close=\{closeFolder\}>/)
    assert.match(sheets, /onBrowse=\{openBrowser\}/)
  })
  test("手机导航只认 ui.sheet：它开着时 phoneLayersOf 多一层 sheet，系统返回 closeTopOverlay → act.closeSheet()", () => {
    const nav = code(read("pi/hooks/usePiPhoneNav.ts"))
    assert.match(nav, /phoneLayersOf\(\{ page, paletteOpen: ui\.paletteOpen, sheet: ui\.sheet != null \}\)/)
    assert.match(nav, /if \(top === "sheet"\) act\.closeSheet\(\)/)
  })
})

describe("新会话：预选进页冻结、热更新保住选择", () => {
  const src = code(read("pi/containers/NewSessionContainer.tsx"))
  test("useSelection：手选 > 本次进页冻结的预选（auto）> 实时预选；冻结目录证实不存在时放开", () => {
    const sel = between(src, "function useSelection(", "\n}\n")
    assert.match(sel, /state\.deviceId \?\? auto\?\.deviceId \?\? provisional\.deviceId/)
    assert.match(sel, /state\.folder \?\? auto\?\.folder \?\? provisional\.folder/)
    assert.match(sel, /const autoFolder = auto\?\.folder && !missing\.has\(auto\.folder\) \? auto\.folder : null/)
  })
  test("NewComposer：会话清单到了才冻结；离开页面清掉（连同桌面浏览器开关）", () => {
    const comp = between(src, "function NewComposer(", "function NewSheets(")
    assert.match(comp, /const sessionsKnown = !!device && relay\.sessionsByDevice\[device\.id\] !== undefined/)
    assert.match(comp, /if \(isStatic \|\| state\.deviceId \|\| state\.folder \|\| !device \|\| !sessionsKnown\) return/)
    assert.match(comp, /setStore\(\{ auto: \{ deviceId: device\.id, folder \} \}\)/)
    assert.match(comp, /return \(\) => setStore\(\{ auto: null, browsing: false \}\)/)
  })
  test("模块 store 记在 import.meta.hot.data 里（开发热更新重跑模块不丢选择；产品构建没有 hot）", () => {
    assert.match(src, /\.\.\.\(import\.meta\.hot\?\.data\.newSession as Partial<NewState> \| undefined\)/)
    assert.match(src, /if \(import\.meta\.hot\) import\.meta\.hot\.data\.newSession = store/)
  })
})

describe("细节", () => {
  test("显示选项「全部设置…」键帽取 PI_SHORTCUT_KEYS：Windows / Linux 写 Ctrl+,，静态画廊按 mac 画", () => {
    assert.equal(PI_SHORTCUT_KEYS.settings[piPlatformOf({ platform: "Win32" })], "Ctrl+,")
    assert.equal(PI_SHORTCUT_KEYS.settings[piPlatformOf({ platform: "MacIntel" })], "⌘,")
    const src = code(read("components/pi/composer/PiDisplayOptions.tsx"))
    assert.match(src, /const settingsKeys = PI_SHORTCUT_KEYS\.settings\[isStatic \? "mac" : piPlatformOf\(typeof navigator === "undefined" \? null : navigator\)\]/)
    assert.match(src, /shortcut=\{phone \? undefined : settingsKeys\}/)
    assert.doesNotMatch(src, /"⌘,"/)
  })
  test("文件夹浏览器：打开时焦点进列表区（data-pi-autofocus），不进「显示隐藏文件夹」开关；读完交给第一个子文件夹", () => {
    const src = code(read("components/pi/composer/PiFolderBrowser.tsx"))
    const list = between(src, "ref={listRef}", ">")
    assert.match(list, /role="group"/)
    assert.match(list, /tabIndex=\{isStatic \? undefined : -1\}/)
    assert.match(list, /data-pi-autofocus=\{isStatic \? undefined : ""\}/)
    assert.ok(src.indexOf("ref={listRef}") < src.indexOf("<PiDialogStatus"), "列表区包住读取状态（加载中也在）")
    assert.match(src, /active === listRef\.current/)
    assert.doesNotMatch(src, /getAttribute\("role"\) === "switch"/)
    assert.match(src, /root\.querySelector\('\[role="option"\]'\)/)
  })
  test("重新回答确认框说实话：重发上一条消息的文字、原回答留着（扩展 cmdRegenerate 是重发，不是替换）", () => {
    const src = read("components/pi/composer/PiRegenerateDialog.tsx")
    assert.match(src, /把上一条消息的文字再发一次，pi 会在后面重新回答一轮；原来的回答仍留在对话里。/)
    assert.doesNotMatch(src, /换掉|丢掉上一条回答/)
    const ext = fs.readFileSync(new URL("../extension/pi-remote-sync.ts", import.meta.url), "utf8")
    assert.match(between(ext, "async cmdRegenerate(args) {", "\n  }\n"), /this\.deliverText\(text, "steer"\)/)
  })
  test("重新回答引出真正重发的原文：最后一条已交给 pi 的用户消息（失败 / 还在发 / 排队的跳过），只有图片 → 空文字", () => {
    const user = (text, extra = {}) => ({ kind: "user", key: text, text, images: [], ...extra })
    const reply = { kind: "assistant", key: "a", blocks: [] }
    assert.deepEqual(regenerateTargetOf([user("第一条"), reply, user(" 第二条 \n"), reply]), { text: "第二条", images: 0 })
    assert.deepEqual(
      regenerateTargetOf([user("送达的"), reply, user("失败的", { failed: "发送失败" }), user("在发的", { status: "sending" }), user("排队的", { status: "awaiting" }), user("视图排队", { queued: true })]),
      { text: "送达的", images: 0 },
    )
    assert.deepEqual(regenerateTargetOf([user("", { images: [{}, {}] }), reply]), { text: "", images: 2 })
    assert.equal(regenerateTargetOf([reply]), null)
  })
  test("重新回答弹窗接线：能跑时才引原文；只有图片 → 确认置灰并写原因；带图写明图片不重发", () => {
    const dialog = code(read("components/pi/composer/PiRegenerateDialog.tsx"))
    assert.match(dialog, /const noText = !!resend && !resend\.text/)
    assert.match(dialog, /disabled=\{busy \|\| !!offline \|\| noText\}/)
    assert.match(dialog, /\{resend\?\.text && \(\s*<blockquote[^>]*data-slot="pi-regenerate-quote"[\s\S]*?\{resend\.text\}\s*<\/blockquote>/)
    assert.match(dialog, /\{noText && <PiDialogNote variant=\{v\}>上一条消息只有图片，没有文字可重发。<\/PiDialogNote>\}/)
    assert.match(dialog, /resend\.images > 0 && <PiDialogNote variant=\{v\}>这条消息里的图片不会重发，只发文字。<\/PiDialogNote>/)
    const dialogs = code(read("pi/containers/DialogsContainer.tsx"))
    assert.match(dialogs, /<PiRegenerateDialog \{\.\.\.common\} resend=\{offline \? null : regenerateTargetOf\(relay\.transcript\.items\)\} \/>/)
    assert.match(dialogs, /return <PiCloneDialog \{\.\.\.common\} \/>/)
  })
  test("手机状态行不再写设备名（会话页顶栏副标题已有），分支照旧；静态画廊不动", () => {
    const src = code(read("pi/containers/ComposerContainer.tsx"))
    assert.match(src, /const status = phone && !isStatic && view\.status\.device \? \{ \.\.\.view\.status, device: undefined \} : view\.status/)
    assert.match(src, /status=\{status\}/)
    assert.match(code(read("pi/containers/PhoneApp.tsx")), /sessionSubtitle=\{head\.device\?\.name\}/, "前提：手机顶栏副标题写设备名")
  })
})
