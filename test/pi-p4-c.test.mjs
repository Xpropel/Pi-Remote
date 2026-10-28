// P4 c 线（p4-lane-c）：composer 输入框 / 命令面板的纯逻辑（ui/src/pi/model/composerInput.ts）+ c 区交互层契约的源码检查。
// 交互行为本身（焦点进出、↑↓、Enter、Esc 分层、tray 面板、N10 整行可点）在 #/play 上由 R2/tools/ui-interact.mjs 验
// （R2/tools/interact-cases/p4-c.mjs），不在这里。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  activeOptionIndex,
  composerTriggerOf,
  nextOptionIndex,
  paletteCommandDisabled,
  paletteKeysOf,
  paletteMatches,
  removeMentionQuery,
  slashMenuGroups,
  triggerSignature,
  turnEndAnnouncement,
  TURN_DONE_TEXT,
  TURN_ERROR_TEXT,
} from "../ui/src/pi/model/composerInput.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8")
/** 去掉 /* *\/ 和 // 注释 */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
const C = "ui/src/components/pi/composer"

describe("composerTriggerOf：输入内容 → 斜杠 / @ 菜单", () => {
  test("斜杠只认整段开头的 /、还在打命令名（和光标无关）", () => {
    assert.deepEqual(composerTriggerOf("/", 1), { kind: "slash", query: "" })
    assert.deepEqual(composerTriggerOf("/co", 3), { kind: "slash", query: "co" })
    assert.deepEqual(composerTriggerOf("/co", 0), { kind: "slash", query: "co" })
    assert.equal(composerTriggerOf("/compact ", 9), null, "打了空白 = 命令名打完了")
    assert.equal(composerTriggerOf("看 /tools", 8), null, "正文中间的 / 是普通文字")
    assert.equal(composerTriggerOf("/", 1, { slash: false }), null, "没给命令表不弹")
  })
  test("@ 用 mention.ts 的口径：光标前未闭合的 @token；ASCII 字母紧贴在前不弹；满 10 个引用不弹", () => {
    assert.deepEqual(composerTriggerOf("看一下 @mob", 8), { kind: "mention", start: 4, query: "mob" })
    assert.deepEqual(composerTriggerOf("@", 1), { kind: "mention", start: 0, query: "" })
    assert.deepEqual(composerTriggerOf("看@ui", 4), { kind: "mention", start: 1, query: "ui" }, "汉字后面的 @ 也算")
    assert.equal(composerTriggerOf("a@b.com", 7), null, "邮箱型不弹")
    assert.equal(composerTriggerOf("@mob x", 6), null, "token 后面有空白 = 说完了")
    assert.equal(composerTriggerOf("@mob", 4, { mentionCount: 10 }), null)
    assert.equal(composerTriggerOf("@mob", 4, { mention: false }), null)
  })
  test("签名：同一个触发、同一个查询 = 同一个菜单", () => {
    assert.equal(triggerSignature(null), "")
    assert.equal(triggerSignature({ kind: "slash", query: "co" }), "/co")
    assert.equal(triggerSignature({ kind: "mention", start: 4, query: "mob" }), "@4:mob")
  })
})

describe("slashMenuGroups：空查询分组浏览，有查询前缀匹配、平铺", () => {
  const row = (key) => ({ key, name: `/${key}`, desc: "" })
  const groups = [
    { title: "常用", rows: ["compact", "model", "fork"].map(row) },
    { title: "内置", rows: ["thinking", "name", "copy", "clone", "commands", "compact"].map(row) },
    { title: "本机资源", rows: [] },
  ]
  test("空查询：原样分组，空组去掉", () => {
    assert.deepEqual(
      slashMenuGroups(groups, "").map((g) => [g.title, g.rows.map((r) => r.key)]),
      [
        ["常用", ["compact", "model", "fork"]],
        ["内置", ["thinking", "name", "copy", "clone", "commands", "compact"]],
      ],
    )
  })
  test("「co」→ 命令名前缀匹配（产品 chat/slash.tsx 的口径 startsWith），不分组、同 key 去重、不区分大小写", () => {
    // design slash-menu 的 states 写的是 /compact、/copy、/clone、/commands；/clone 不以 co 开头，按产品现有的前缀口径不出现（P4 c 线报告里记了）
    const out = slashMenuGroups(groups, "CO")
    assert.equal(out.length, 1)
    assert.equal(out[0].title, "")
    assert.deepEqual(out[0].rows.map((r) => r.name), ["/compact", "/copy", "/commands"])
  })
  test("没有匹配返回 []（菜单写「没有这个命令」）", () => {
    assert.deepEqual(slashMenuGroups(groups, "zz"), [])
  })
})

describe("nextOptionIndex / activeOptionIndex：↑↓ 选中行", () => {
  const en = [true, false, true, true]
  test("跳过禁用行，到头绕回", () => {
    assert.equal(nextOptionIndex(en, 0, "ArrowDown"), 2)
    assert.equal(nextOptionIndex(en, 3, "ArrowDown"), 0)
    assert.equal(nextOptionIndex(en, 0, "ArrowUp"), 3)
    assert.equal(nextOptionIndex(en, 2, "ArrowUp"), 0)
  })
  test("Home / End；当前行不可选时 ↓ 到第一个、↑ 到最后一个；没有可选行 = -1", () => {
    assert.equal(nextOptionIndex(en, 2, "Home"), 0)
    assert.equal(nextOptionIndex(en, 0, "End"), 3)
    assert.equal(nextOptionIndex(en, 1, "ArrowDown"), 0)
    assert.equal(nextOptionIndex(en, -1, "ArrowUp"), 3)
    assert.equal(nextOptionIndex([false, false], 0, "ArrowDown"), -1)
    assert.equal(nextOptionIndex([], 0, "ArrowDown"), -1)
  })
  test("有效选中行：想要的行可选就用它，否则第一个可选行", () => {
    assert.equal(activeOptionIndex(en, 3), 3)
    assert.equal(activeOptionIndex(en, 1), 0)
    assert.equal(activeOptionIndex(en, 9), 0)
    assert.equal(activeOptionIndex([false, true], 0), 1)
    assert.equal(activeOptionIndex([false], 0), -1)
  })
})

test("removeMentionQuery：选中 @ 候选时删掉「@查询」，光标落在 @ 原来的位置", () => {
  assert.deepEqual(removeMentionQuery("看一下 @mob", 4, 8), { draft: "看一下 ", caret: 4 })
  assert.deepEqual(removeMentionQuery("@ui 后面", 0, 3), { draft: " 后面", caret: 0 })
  assert.deepEqual(removeMentionQuery("abc", 5, 9), { draft: "abc", caret: 3 }, "越界时夹到文本长度")
})

describe("命令面板", () => {
  test("键帽只来自 PI_SHORTCUT_KEYS：mac 拆单字（= 冻结版画廊的键帽），其他平台按 + 拆；没有快捷键的命令不写", () => {
    assert.deepEqual(paletteKeysOf("new", "mac"), ["⇧", "⌘", "O"])
    assert.deepEqual(paletteKeysOf("sidebar", "mac"), ["⌘", "B"])
    assert.deepEqual(paletteKeysOf("pane", "mac"), ["⌘", "."])
    assert.deepEqual(paletteKeysOf("settings", "mac"), ["⌘", ","])
    assert.deepEqual(paletteKeysOf("new", "other"), ["Ctrl", "Shift", "O"])
    assert.deepEqual(paletteKeysOf("settings", "other"), ["Ctrl", ","])
    assert.equal(paletteKeysOf("compact", "mac"), undefined)
    // 冻结版画廊 mock 里写死的键帽和 mac 口径一致（静态态按 mac 画，L1 不变）
    const fixture = read("ui/src/pi/dev/fixtures/gallery/c.ts")
    for (const [key, keys] of [
      ["new", '["⇧", "⌘", "O"]'],
      ["sidebar", '["⌘", "B"]'],
      ["pane", '["⌘", "."]'],
      ["settings", '["⌘", ","]'],
    ]) {
      assert.ok(fixture.includes(`key: "${key}"`) && fixture.includes(`keys: ${keys}`), key)
    }
  })
  test("离线时命令行禁用，设置 / 切换侧栏 / 右 pane 照常可用", () => {
    for (const k of ["settings", "sidebar", "pane"]) assert.equal(paletteCommandDisabled(k, true), false, k)
    for (const k of ["new", "compact", "usage"]) assert.equal(paletteCommandDisabled(k, true), true, k)
    assert.equal(paletteCommandDisabled("new", false), false)
  })
  test("过滤：空查询全留，否则任一文字包含查询（不区分大小写）", () => {
    assert.equal(paletteMatches("", "新建会话"), true)
    assert.equal(paletteMatches("  ", "x"), true)
    assert.equal(paletteMatches("设置", "设置"), true)
    assert.equal(paletteMatches("mac", "退款", "MacBook Pro/pi-remote"), true)
    assert.equal(paletteMatches("gpt", "Claude"), false)
  })
})

test("turnEndAnnouncement：回合结束读一次（出错 / 完成），开始时清空，其余不动", () => {
  assert.equal(turnEndAnnouncement(null, true), null, "第一次渲染不播")
  assert.equal(turnEndAnnouncement(true, false), TURN_DONE_TEXT)
  assert.equal(turnEndAnnouncement(true, false, true), TURN_ERROR_TEXT)
  assert.equal(TURN_DONE_TEXT, "回合已完成")
  assert.equal(TURN_ERROR_TEXT, "这一轮出错了")
  assert.equal(turnEndAnnouncement(false, true), "")
  assert.equal(turnEndAnnouncement(true, true), null)
  assert.equal(turnEndAnnouncement(false, false), null)
})

describe("c 区交互层契约（源码）", () => {
  test("c 区画廊屏：可交互部件的每处用法都显式传 static（L1 像素不变）", () => {
    const dir = path.join(ROOT, "ui/src/pi/dev/screens/c")
    const NEED = /<(PiComposerDock|PiEmptyComposer|PiCommandPalette|PiUsageDialog|PiModelMenu|PiFolderPicker|PiQueuePanel|PiDisplayOptions|PiSettingsPage|PiSheet|PiDialog)\b([^>]*)/g
    const missing = []
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".tsx"))) {
      const src = code(fs.readFileSync(path.join(dir, f), "utf8"))
      for (const m of src.matchAll(NEED)) if (!/(^|\s)static(\s|$|\/)/.test(m[2] + " ")) missing.push(`${f}: <${m[1]}>`)
    }
    assert.deepEqual(missing, [])
  })

  test("层级：c 区部件只用 --cw-pi-z-* 档，不写 z 数字（composer chip 外扩区在 isolate 行里的 -z-10 是局部层叠，留着）", () => {
    const bad = []
    for (const f of fs.readdirSync(path.join(ROOT, C)).filter((x) => x.endsWith(".tsx"))) {
      const src = code(read(`${C}/${f}`))
      for (const m of src.matchAll(/(?<![\w-])z-(?:\d+|\[\d+\])(?![\w-])/g)) bad.push(`${f}: ${m[0]}`)
    }
    assert.deepEqual(bad, [])
    assert.match(code(read(`${C}/PiCommandPalette.tsx`)), /z-\(--cw-pi-z-modal\)/)
    assert.match(code(read(`${C}/PiComposerDock.tsx`)), /z-\(--cw-pi-z-popover\)/)
  })

  test("composer 真输入框在 data-slot 容器里（外壳的 Esc 第 3 层据此认 composer 焦点）", () => {
    const follow = code(read(`${C}/PiFollowUpComposer.tsx`))
    assert.match(follow, /<textarea[\s\S]*?data-cw-id="pi-composer-input"/)
    assert.match(follow, /data-slot="pi-follow-up-composer"/)
    assert.match(follow, /enterKeyHint=\{phone \? "enter" : "send"\}/, "手机 Enter 换行")
    assert.match(follow, /useComposerEnter\(\{/, "桌面 Enter / Ctrl+Enter 决策走共享 hook")
    assert.doesNotMatch(follow, /event\.key === "Enter" && plain && !phone/, "不再硬编码桌面 Enter 发送")
    const empty = code(read(`${C}/PiEmptyComposer.tsx`))
    assert.match(empty, /<textarea[\s\S]*?data-cw-id="pi-new-input"/)
    assert.match(empty, /data-slot="pi-empty-composer"/)
    assert.match(read(`${C}/styles.ts`), /text-\[16px\]/, "手机输入框 16px（防 iOS 放大）")
  })

  test("黑圆钮的状态与名称按 composerBlockOf（pi/model/composerButton.ts），不在部件里另写一份", () => {
    const follow = code(read(`${C}/PiFollowUpComposer.tsx`))
    assert.match(follow, /import \{ composerBlockOf, composerButtonLabel \} from "@\/pi\/model\/composerButton"/)
    assert.match(follow, /composerBlockOf\(state, blockedBy \?\? null, hasContent\)/)
    assert.match(follow, /aria-label=\{composerButtonLabel\(btn\)\}/)
    assert.doesNotMatch(follow, /function composerButtonOf|function blockedButtonOf|function composerButtonLabel/)
  })

  test("斜杠 / @ 菜单：输入框的 aria-activedescendant、登记 menu 层、处理了的键 preventDefault", () => {
    const assist = code(read(`${C}/useComposerAssist.ts`))
    assert.match(assist, /usePiLayer\(open, "menu", dismiss\)/)
    assert.match(assist, /"aria-activedescendant": activeId/)
    assert.match(assist, /event\.key === "Escape" && plain\) \{\s*event\.preventDefault\(\)/)
    const follow = code(read(`${C}/PiFollowUpComposer.tsx`))
    assert.match(follow, /\{\.\.\.assist\.inputAria\}/)
  })

  test("实时区域：原因段按 status.live；回合结束播报区常驻、视觉隐藏、polite，可交互时 dock 挂一个", () => {
    const row = code(read(`${C}/PiComposerStatusRow.tsx`))
    assert.match(row, /role=\{live \? "status" : undefined\}/)
    assert.match(row, /role="status" aria-live="polite" data-slot="pi-composer-turn-live" className="sr-only"/)
    assert.match(code(read(`${C}/PiComposerDock.tsx`)), /\{!isStatic && <PiTurnAnnouncer running=\{!!status\?\.running\} error=\{!!status\?\.turnError\} \/>\}/)
  })

  test("命令面板：桌面 PiOverlay、手机 PiSheet；搜索框是 combobox + aria-activedescendant", () => {
    const pal = code(read(`${C}/PiCommandPalette.tsx`))
    assert.match(pal, /<PiOverlay\b[\s\S]*?label="命令面板"/)
    assert.match(pal, /<PiSheet open=\{open\}/)
    assert.match(pal, /role="combobox"[\s\S]*?aria-activedescendant=\{activeRow\?\.id\}/)
    assert.match(pal, /export interface PiCommandPaletteProps extends PiOverlayControl/)
    // 外壳不再替命令面板登记浮层：PiOverlay 自己登记，onOpenChange 接回 ui.paletteOpen
    assert.doesNotMatch(code(read("ui/src/pi/dev/play/c.tsx")), /usePiLayer\(/)
  })

  test("模型菜单：说明卡在 option 外面（aria-describedby 关联），option 的名字不带说明卡的字", () => {
    const menu = code(read(`${C}/PiModelMenu.tsx`))
    for (const m of menu.matchAll(/<MenuItem\b[\s\S]*?<\/MenuItem>/g)) assert.doesNotMatch(m[0], /pi-model-explainer-anchor/)
    assert.match(menu, /aria-describedby=\{card \? explainerId : undefined\}/)
    assert.match(menu, /aria-describedby=\{card != null \? explainerId : undefined\}/)
  })

  test("N10：设置页开关的点击区撑满整行；行本身不加 relative（圆角卡里定位的行会改文字栅格化，L1 有差）", () => {
    const page = code(read(`${C}/PiSettingsPage.tsx`))
    assert.match(page, /after:absolute after:top-1\/2 after:-right-4 after:-left-\[600px\]/)
    assert.equal((page.match(/className=\{switchFillRow\(variant\)\}/g) ?? []).length, 2)
    assert.match(page, /toggle && "cursor-pointer select-none"/)
    assert.doesNotMatch(page, /toggle && "relative/)
  })
})
