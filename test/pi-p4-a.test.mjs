// P4 a 线（会话菜单、会话行、标题搜索、"更多 N"、改名 / 删除 / 配对弹窗）的源码契约检查（R2/p4-lanes.md §1、§2、§6 a 线）。
// 交互行为本身（菜单开合、焦点进出、Esc、长按、搜索）在 #/play 上由 R2/tools/ui-interact.mjs 的 interact-cases/p4-a.mjs 验，不在这里。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8")
/** 去掉 /* *\/ 和 // 注释 */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
/** 从 start 标记起到 end 标记前的一段（先切再去注释） */
function section(file, start, end) {
  const raw = read(file)
  const i = raw.indexOf(start)
  const j = end ? raw.indexOf(end, i + start.length) : raw.length
  assert.ok(i >= 0 && j > i, `${file}: ${start} … ${end}`)
  return code(raw.slice(i, j))
}

const MENU = "ui/src/components/pi/shell/PiSessionMenu.tsx"
const SIDEBAR = "ui/src/components/pi/shared/PiSidebar.tsx"
const PLAY_A = "ui/src/pi/dev/play/a.tsx"

describe("P4 a 线：会话菜单（PiSessionMenu）", () => {
  test("是菜单内容：props 收 PiOverlayControl 的 static，MenuSurface 展开 usePiMenuSurface()，行用 onSelect", () => {
    const src = code(read(MENU))
    assert.match(src, /export interface PiSessionMenuProps extends Pick<PiOverlayControl, "static">/)
    assert.match(src, /const isStatic = usePiStatic\(staticProp\)/)
    assert.match(src, /const context = usePiMenuSurface\(\)/)
    // 静态态一律 static surface（画廊截图不受外面的 PiMenu 影响）
    assert.match(src, /const surface = isStatic \? undefined : context/)
    assert.match(src, /<MenuSurface\s+\{\.\.\.surface\}/)
    assert.match(src, /onSelect=\{onSelect && \(\(\) => onSelect\(item\.key\)\)\}/)
    // 十个菜单项都能回调（data-pi-menu-item 与 onSelect 的值同一套 key）
    for (const key of ["open", "rename", "fork", "clone", "export", "tab", "tree", "compact", "copy-id", "delete"]) assert.match(src, new RegExp(`key: "${key}"`), key)
  })

  test("手机 sheet 里（surface 是 static、可交互）：首个可用项进 Tab 顺序，↑↓ / Home / End / Enter / 空格由 onSheetMenuKeyDown 处理", () => {
    const src = code(read(MENU))
    assert.match(src, /const keyboard = !isStatic && context\.kind === "static"/)
    assert.match(src, /onKeyDown=\{keyboard \? onSheetMenuKeyDown : undefined\}/)
    assert.match(src, /item\.key === firstEnabled \? \{ tabIndex: 0 \} : \{\}/)
    const keys = section(MENU, "function onSheetMenuKeyDown", "export function PiSessionMenu")
    for (const k of ['"ArrowDown"', '"ArrowUp"', '"Home"', '"End"', '"Enter"', '" "']) assert.ok(keys.includes(k), k)
    assert.match(keys, /event\.preventDefault\(\)/)
  })

  test("画廊屏 session-menu 的两处 PiSessionMenu 都传 static", () => {
    const src = code(read("ui/src/pi/dev/screens/a/session-menu.tsx"))
    const uses = [...src.matchAll(/<PiSessionMenu\b[^>]*>/g)].map((m) => m[0])
    assert.equal(uses.length, 2)
    for (const tag of uses) assert.match(tag, /\sstatic\b/, tag)
  })
})

describe("P4 a 线：会话行与左栏（PiSidebar）", () => {
  test("PiSessionRow：可交互时右键 = PiMenu context、行尾 … = PiMenu dropdown；静态态不接（事件原样透传）", () => {
    const row = section(SIDEBAR, "export function PiSessionRow(", "/* ======================= 账户区")
    assert.match(row, /const isStatic = usePiStatic\(staticProp\)/)
    assert.match(row, /const withMenu = !isStatic && !phone && menu != null/)
    assert.match(row, /<PiMenu kind="dropdown" trigger=\{dots\}[^>]*onOpenChange=\{onDotsOpenChange\}>/)
    // 下拉关上时先留住 …（Radix 在 setTimeout 里把焦点送回它），之后焦点不在行里再收起
    assert.match(row, /const onDotsOpenChange = \(open: boolean\) => \{[\s\S]*?setKeyFocus\(true\)[\s\S]*?settle\(/)
    assert.match(row, /<PiMenu kind="context" trigger=\{rowEl\} onOpenChange=\{setContextOpen\}>/)
    assert.match(row, /const handlers = isStatic\s*\?\s*\{ onClick, onKeyDown, onFocus, onBlur, onContextMenu, onPointerDown, onPointerMove, onPointerUp, onPointerCancel \}/)
    // 菜单开着时 … 留着、右键的目标行保持选中底；键盘焦点在行上时 … 也出来
    assert.match(row, /const hover = !phone && \(hovered \|\| forced === "hover" \|\| \(!isStatic && \(keyFocus \|\| dotsOpen\)\)\)/)
    assert.match(row, /const context = forced === "context" \|\| \(withMenu && contextOpen\)/)
    // Enter / 空格只认行本身（… 上的归下拉菜单）
    assert.match(row, /event\.target !== event\.currentTarget/)
  })

  test("手机长按：触屏 500ms 计时（鼠标走 contextmenu），开出 sheet 后吞掉抬手补发的 mousedown / mouseup / click", () => {
    const lp = section(SIDEBAR, "const LONG_PRESS_MS", "function Highlighted")
    assert.match(lp, /const LONG_PRESS_MS = 500/)
    assert.match(lp, /event\.pointerType === "mouse"\) return/)
    assert.match(lp, /const GHOST_EVENTS = \["mousedown", "mouseup", "click"\] as const/)
    assert.match(lp, /window\.addEventListener\(type, block, true\)/)
    assert.match(lp, /if \(fired\.current\) \{\s*fired\.current = false\s*swallowNextClick\(\)/)
  })

  test("会话行的可访问名 = 标题，标记 label，时间全称（行首标记与行尾时间 aria-hidden）", () => {
    const name = section(SIDEBAR, "function piSessionRowName", "/** 焦点是键盘带来的")
    assert.match(name, /row\.trailingText \?\? row\.timeLabel/)
    assert.match(name, /join\("，"\)/)
    const row = section(SIDEBAR, "export function PiSessionRow(", "/* ======================= 账户区")
    assert.match(row, /aria-label=\{piSessionRowName\(row\)\}/)
  })

  test("PiSidebar：行回调只在可交互时传下去；data-pi-row-key 区分需要处理组里的同一会话", () => {
    const groups = section(SIDEBAR, "function SidebarGroups(", "const KBD_TEXT_3")
    assert.match(groups, /\.\.\.\(isStatic\s*\?\s*\{\}\s*:\s*\{\s*"data-pi-row-key": target,/)
    assert.match(groups, /menu: rowMenu\?\.\(row, target\)/)
    assert.match(groups, /onLongPress: onRowLongPress && \(\(\) => onRowLongPress\(row, target\)\)/)
    const sidebar = section(SIDEBAR, "export function PiSidebar(", null)
    assert.match(sidebar, /const isStatic = usePiStatic\(staticProp\)/)
  })

  test("「更多 N」/「收起」是同一个开关：onToggleMore(group.key)、aria-expanded false / true", () => {
    const groups = section(SIDEBAR, "function SidebarGroups(", "const KBD_TEXT_3")
    const more = groups.slice(groups.indexOf("label={`更多 ${group.more}`}") - 200, groups.indexOf("label={`更多 ${group.more}`}") + 300)
    assert.match(more, /aria-expanded=\{false\}/)
    assert.match(more, /onClick=\{toggle\(group\.key\)\}/)
    const fold = groups.slice(groups.indexOf('label="收起"') - 200, groups.indexOf('label="收起"') + 200)
    assert.match(fold, /aria-expanded\b/)
    assert.match(fold, /onClick=\{toggle\(group\.key\)\}/)
    assert.equal((groups.match(/key="more-toggle"/g) ?? []).length, 2)
    assert.match(groups, /const toggle = \(groupKey: string\) => \(!isStatic && onToggleMore \? \(\) => onToggleMore\(groupKey\) : undefined\)/)
  })

  test("搜索行：data-pi-nav=\"search\"，仍然没有 kbd（⌘K 只开命令面板，D-01）", () => {
    const src = code(read(SIDEBAR))
    const tag = src.match(/<SidebarNavRow data-pi-nav="search"[^>]*\/>/)
    assert.ok(tag, "搜索行")
    assert.doesNotMatch(tag[0], /\bkbd=/)
  })

  test("层级：a 线文件里不写 z 数字，外扩点击区用 --cw-pi-z-raised（R2/p4-lanes.md §2）", () => {
    const files = [SIDEBAR, ...fs.readdirSync(path.join(ROOT, "ui/src/components/pi/shell")).filter((f) => f.endsWith(".tsx")).map((f) => `ui/src/components/pi/shell/${f}`), PLAY_A]
    for (const file of files) assert.doesNotMatch(code(read(file)), /\bz-(?:\d+|\[\d+\])(?![\w-])/, file)
    assert.equal((code(read(SIDEBAR)).match(/z-\(--cw-pi-z-raised\)/g) ?? []).length, 3)
  })
})

describe("P4 a 线：搜索框、配对、#/play 的弹窗", () => {
  test("ASearchField：可交互时受控、Esc = 退出搜索（preventDefault）、× 清空后焦点留在输入框；静态态仍是 defaultValue", () => {
    const field = section("ui/src/components/pi/shell/parts.tsx", "export function ASearchField(", "export interface AAnchoredProps")
    assert.match(field, /const live = !isStatic && onValueChange != null/)
    assert.match(field, /:\s*\{ defaultValue: value \}/)
    assert.match(field, /event\.key !== "Escape"/)
    assert.match(field, /event\.preventDefault\(\)\s*onEscape\(\)/)
    assert.match(field, /inputRef\.current\?\.focus\(\)/)
  })

  test("PiDevicePairing：命令页签可切换（onCommandPlatformChange），不传时 PaneTabBar 没有回调", () => {
    const src = code(read("ui/src/components/pi/shell/PiDevicePairing.tsx"))
    assert.match(src, /onSelectedIdChange=\{onCommandPlatformChange && \(/)
  })

  test("#/play 的 a 区弹窗：改名进输入框、Enter 保存；删除是 danger、「取消」带 data-pi-autofocus；关闭后焦点回记下的行", () => {
    const rename = section(PLAY_A, "function RenameDialog(", "/** 删除确认")
    assert.match(rename, /<PiDialog\b/)
    assert.match(rename, /returnFocus=\{returnToTarget\}/)
    assert.match(rename, /disabled=\{!next\}/)
    assert.match(rename, /event\.key !== "Enter" \|\| event\.nativeEvent\.isComposing/)
    const del = section(PLAY_A, "function DeleteDialog(", "/** 设备与配对")
    assert.match(del, /<PiDialog\s+title="删除会话"\s+danger\b/)
    assert.match(del, /returnFocus=\{returnToTarget\}/)
    assert.match(del, /data-pi-autofocus=""[^>]*>\s*取消/)
    const play = code(read(PLAY_A))
    for (const id of ["A_SHEET_SESSION_INFO", "A_SESSION_MENU", "A_RENAME", "A_DELETE", "A_PAIRING"]) assert.match(play, new RegExp(`export const ${id} = "a:`), id)
  })

  test("presets-a：a 线的起始状态都是已知 id，sheet / 弹窗用 a 的常量", () => {
    const src = code(read("ui/src/pi/dev/play/presets-a.ts"))
    for (const id of ["session-search", "session-menu", "session-info", "device-pairing"]) assert.match(src, new RegExp(`"${id}":`), id)
    assert.match(src, /sheet: A_SESSION_MENU/)
    assert.match(src, /dialog: A_PAIRING, sheet: A_PAIRING/)
  })
})
