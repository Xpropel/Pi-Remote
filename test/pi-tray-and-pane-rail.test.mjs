import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { trayItemsOf } from "../ui/src/pi/model/tray.ts"

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8")
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")

const base = { linkOk: true, deviceOnline: true }

describe("composer tray: active-only visibility & English copy", () => {
  test("terminal pill appears only while state === 'running' and disappears once completed/failed/timed_out/aborted", () => {
    assert.deepEqual(trayItemsOf({ ...base, terminals: [{ state: "running" }] }), [
      { kind: "terminal", label: "Terminal 1", running: true, title: "Running command — click to open terminal" },
    ])
    assert.deepEqual(
      trayItemsOf({ ...base, terminals: [{ state: "running" }, { state: "succeeded" }, { state: "running" }] }),
      [{ kind: "terminal", label: "Terminal 2", running: true, title: "Running command — click to open terminal" }],
    )
    for (const terminalState of ["succeeded", "failed", "timed_out", "aborted"]) {
      assert.deepEqual(trayItemsOf({ ...base, terminals: [{ state: terminalState }] }), [])
    }
  })

  test("tasks and subagents pills appear only while actively running", () => {
    assert.deepEqual(
      trayItemsOf({
        ...base,
        taskList: [{ status: "completed" }, { status: "in_progress" }, { status: "pending" }],
        subagents: 1,
      }),
      [
        { kind: "tasks", label: "Tasks 1/3", running: true, title: "Running tasks — click to view progress" },
        { kind: "subagents", label: "Subagent 1", running: true, title: "Running subagent — click to jump to live activity" },
      ],
    )
    assert.deepEqual(
      trayItemsOf({
        ...base,
        taskList: [{ status: "completed" }, { status: "pending" }],
        subagents: [],
      }),
      [],
    )
  })

  test("static session changes never linger as a tray pill above composer", () => {
    assert.deepEqual(trayItemsOf({ ...base, changes: { added: 42, removed: 7, files: [{}, {}] } }), [])
  })

  test("PiTray.tsx uses English UI strings and no Chinese runtime labels", () => {
    const src = code(read("ui/src/components/pi/composer/PiTray.tsx"))
    assert.match(src, /label="Running"/)
    assert.match(src, /\{newCount\} new/)
    assert.match(src, /aria-label="Scroll to bottom"/)
    assert.doesNotMatch(src, /运行中|条新消息|回到底部/)
  })

  test("PiComposerDock.tsx moves tray pills down 1pt (mb-[7px]) closer to input box", () => {
    const src = code(read("ui/src/components/pi/composer/PiComposerDock.tsx"))
    assert.match(src, /\{showTray && \(\s*<div className=\{cn\("relative mb-\[7px\] min-w-0", limited && "shrink-0"\)\}>/)
  })

  test("ComposerContainer.tsx wires active subagents, gates live pills on online device, and closes tasks popover when tasks finish", () => {
    const src = code(read("ui/src/pi/containers/ComposerContainer.tsx"))
    assert.match(src, /const activeSubagents = useMemo\(/)
    assert.match(src, /const hasTasksPill = tray\.some\(\(item\) => item\.kind === "tasks"\)/)
    assert.match(src, /menuId === PI_UI_IDS\.tasks && hasTasksPill/)
    assert.doesNotMatch(src, /label:\s*"改动"/)
  })
})

describe("top-right floating pane rail (悬浮框)", () => {
  test("PiPaneRail exposes expand («), changes (±), terminal (>_), shell, and file buttons", () => {
    const src = code(read("ui/src/components/pi/conversation/PiPaneTabs.tsx"))
    assert.match(src, /export function PiPaneRail\b/)
    for (const id of ["pi-pane-rail-expand", "pi-pane-rail-changes", "pi-pane-rail-terminal", "pi-pane-rail-shell", "pi-pane-rail-file"]) {
      assert.match(src, new RegExp(`data-cw-id="${id}"`))
    }
    assert.match(src, /onClick=\{onExpand\}/)
    assert.match(src, /onClick=\{\(\) => onSelect\("changes"\)\}/)
    assert.match(src, /onClick=\{\(\) => onSelect\("terminal"\)\}/)
    assert.match(src, /onClick=\{\(\) => onSelect\("shell"\)\}/)
    assert.match(src, /onClick=\{\(\) => onSelect\("file"\)\}/)
  })

  test("PiDesktopShell renders paneRail only when right pane is closed", () => {
    const shell = code(read("ui/src/components/pi/shared/PiShell.tsx"))
    assert.match(shell, /paneRail\?: ReactNode/)
    assert.match(shell, /\{!paneOpen && paneRail != null && \(\s*<div data-pi-pane-rail-slot=""/)
  })

  test("DesktopApp mounts PaneRailContainer only in product session mode when pane is hidden", () => {
    const app = code(read("ui/src/pi/containers/DesktopApp.tsx"))
    assert.match(app, /import \{ PaneContainer, PaneRailContainer \} from "\.\/PaneContainer"/)
    assert.match(app, /paneRail=\{frame\.mode === "product" && session && ready && !ui\.pane \? <PaneRailContainer \{\.\.\.p\} \/> : undefined\}/)
  })

  test("pi-theme.css styles pane-rail with squircle continuous rounding and fallback radius", () => {
    const css = read("ui/src/components/pi/shared/pi-theme.css")
    assert.match(css, /\[data-pi-root\]\s+\[data-pi-part="pane-rail"\]\s*\{[^}]*border-radius:\s*14px;[^}]*corner-shape:\s*squircle;/s)
    assert.match(css, /\[data-pi-root\]\s+\[data-pi-part="pane-rail"\]\s*>\s*button\s*\{[^}]*border-radius:\s*9px;[^}]*corner-shape:\s*squircle;/s)
  })
})
