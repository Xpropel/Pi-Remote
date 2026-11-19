import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { createJiti } from "jiti"

const require = createRequire(import.meta.url)
const sessionLibrary = require("../deploy/session-library.cjs")
const storage = await import("../ui/src/pi/sidebar/storage.ts")
const transcriptView = await import("../ui/src/pi/model/transcriptView.ts")
const tray = await import("../ui/src/pi/model/tray.ts")
const voice = await import("../ui/src/pi/model/voiceDictation.ts")
const sessionMenu = await import("../ui/src/pi/model/sessionMenu.ts")

const jiti = createJiti(import.meta.url, { interopDefault: false })
const ext = await jiti.import(new URL("../extension/pi-remote-sync.ts", import.meta.url).pathname)

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8")

function makeJsonlTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-e2e-"))
  const sessionsDir = path.join(dir, "sessions", "--work-proj--")
  fs.mkdirSync(sessionsDir, { recursive: true })
  const file = path.join(sessionsDir, "2026-11-16T01-00-00-000Z_sess-tree-e2e.jsonl")
  const rows = [
    { type: "session", version: 3, id: "sess-tree-e2e", timestamp: "2026-11-16T01:00:00.000Z", cwd: "/work/proj" },
    { type: "message", id: "u1", parentId: null, timestamp: 1000, message: { role: "user", content: [{ type: "text", text: "第一问" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: 2000, message: { role: "assistant", content: [{ type: "text", text: "第一答" }] } },
    // 被 /tree 抛弃的旧分支 u2-dead -> a2-dead（后面有更晚的 u2-live -> a2-live）
    { type: "message", id: "u2-dead", parentId: "a1", timestamp: 3000, message: { role: "user", content: [{ type: "text", text: "废弃问题" }] } },
    { type: "message", id: "a2-dead", parentId: "u2-dead", timestamp: 4000, message: { role: "assistant", content: [{ type: "text", text: "废弃回答" }] } },
    { type: "message", id: "u2-live", parentId: "a1", timestamp: 5000, message: { role: "user", content: [{ type: "text", text: "保留问题" }] } },
    { type: "message", id: "a2-live", parentId: "u2-live", timestamp: 6000, message: { role: "assistant", content: [{ type: "text", text: "保留回答" }] } },
  ]
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8")
  return { dir, sessionsDir, file }
}

describe("侧栏工作区悬停动作、重命名持久化、新会话复位与精简文案", () => {
  test("storage.ts：工作区自定义名称增删、80 字截断与 emptyScope 形状守卫", () => {
    let state = storage.emptySidebarLocalState()
    assert.deepEqual(storage.sidebarScopeStateOf(state, "acc"), { pins: [], archives: [], folders: {}, updatedAt: 0 })

    state = storage.setWorkspaceCustomName(state, "acc", "dev1:/work/Pi-Remote", "我的核心仓库")
    assert.equal(storage.workspaceCustomName(state, "acc", "dev1:/work/Pi-Remote"), "我的核心仓库")

    const longName = "X".repeat(120)
    state = storage.setWorkspaceCustomName(state, "acc", "dev1:/work/other", longName)
    assert.equal(storage.workspaceCustomName(state, "acc", "dev1:/work/other")?.length, 80)

    state = storage.setWorkspaceCustomName(state, "acc", "dev1:/work/Pi-Remote", "   ")
    assert.equal(storage.workspaceCustomName(state, "acc", "dev1:/work/Pi-Remote"), undefined)
    state = storage.setWorkspaceCustomName(state, "acc", "dev1:/work/other", "")
    assert.equal("workspaceNames" in storage.sidebarScopeStateOf(state, "acc"), false, "全部恢复默认后省略空 workspaceNames")
  })

  test("SidebarSections / CursorUnifiedSidebar / NewSessionContainer：⋮ + 双按钮与泛入口复位", () => {
    const sections = read("ui/src/pi/sidebar/components/SidebarSections.tsx")
    assert.match(sections, /className="sb-wsacts"/)
    assert.match(sections, /workspaceMenu \? workspaceMenu\(group\) : null/)
    assert.match(sections, /actions\.newSessionInGroup\?\.\(group\)/)
    assert.match(sections, /<PlusIcon \/>/)

    const icons = read("ui/src/pi/sidebar/components/icons.tsx")
    assert.match(icons, /export (?:const|function) MoreVerticalIcon\b/)

    const sidebar = read("ui/src/pi/containers/CursorUnifiedSidebar.tsx")
    assert.match(sidebar, /resetNewSessionSelection\(\)/)
    assert.match(sidebar, /presetNewSession\(group\.deviceId, group\.cwd\)/)
    assert.match(sidebar, /重命名工作区…/)
    assert.match(sidebar, /恢复默认名称/)
    assert.match(sidebar, /复制目录路径/)

    const ns = read("ui/src/pi/containers/NewSessionContainer.tsx")
    assert.match(ns, /export function resetNewSessionSelection\(\)/)
  })

  test("PiEmptyComposer：已彻底清除模型下方的「开始后可在输入框里切换」", () => {
    const src = read("ui/src/components/pi/composer/PiEmptyComposer.tsx")
    assert.match(src, /export const EMPTY_MODEL_NOTE = ""/)
    assert.doesNotMatch(src, /开始后可在输入框里切换/)
  })
})

describe("session-library.cjs 与扩展 Fork / 上下文防串音", () => {
  test("readArchive 只重构活动分支（丢弃 /tree 废弃分支），forkSessionFileOnDisk 支持 at/before", () => {
    const { dir, file } = makeJsonlTree()
    try {
      const archive = sessionLibrary.readArchive(file)
      assert.deepEqual(
        archive.messages.map((m) => m.id),
        ["u1", "a1", "u2-live", "a2-live"],
        "必须沿 leafId parentId 链路重建，不得包含废弃分支 u2-dead/a2-dead",
      )
      assert.equal(archive.messageCount, 4)

      const forkAtA1 = sessionLibrary.forkSessionFileOnDisk(file, { entryId: "a1", position: "at" })
      assert.equal(forkAtA1.ok, true)
      assert.deepEqual(forkAtA1.archive.messages.map((m) => m.id), ["u1", "a1"])

      const forkBeforeU2 = sessionLibrary.forkSessionFileOnDisk(file, { entryId: "u2-live", position: "before" })
      assert.deepEqual(forkBeforeU2.archive.messages.map((m) => m.id), ["u1", "a1"])

      const renamed = sessionLibrary.renameSessionFileOnDisk(forkAtA1.sessionPath, "冷分叉新名")
      assert.equal(renamed.name, "冷分叉新名")
      const exported = sessionLibrary.exportSessionFileOnDisk(forkAtA1.sessionPath, "text")
      assert.match(exported.text, /\[User\]: 第一问/)
      assert.match(exported.text, /\[Assistant\]: 第一答/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("extension：fork position(before/at)、get_fork_messages 仅活动分支与 cross-project jail", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-jail-e2e-"))
    try {
      const projA = path.join(dir, "sessions", "--proj-a--")
      const projB = path.join(dir, "sessions", "--proj-b--")
      const outside = path.join(dir, "outside.jsonl")
      fs.mkdirSync(projA, { recursive: true })
      fs.mkdirSync(projB, { recursive: true })
      const fileB = path.join(projB, "2026-11-16T01-00-00-000Z_s-b.jsonl")
      fs.writeFileSync(
        fileB,
        JSON.stringify({ type: "session", version: 3, id: "s-b", cwd: "/proj/b", timestamp: "2026-11-16T01:00:00.000Z" }) + "\n" +
        JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: 1, message: { role: "user", content: [{ type: "text", text: "hi b" }] } }) + "\n",
      )
      fs.writeFileSync(outside, JSON.stringify({ type: "session", version: 3, id: "out", cwd: "/tmp", timestamp: "2026-11-16T01:00:00.000Z" }) + "\n")

      const bridge = new ext.Bridge()
      bridge.ctx = { sessionManager: { getSessionDir: () => projA } }
      assert.equal(fs.realpathSync(bridge.jailInactiveSessionPath(fileB)), fs.realpathSync(fileB))
      assert.throws(() => bridge.jailInactiveSessionPath(outside), /越界/)

      const extSrc = read("extension/pi-remote-sync.ts")
      assert.match(extSrc, /getBranch/)
      assert.match(extSrc, /sessionContextDirty/)
      assert.match(extSrc, /position/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("前端冷/热 Fork、浮动栏 CSS、定时托盘与语音识别语言", () => {
  test("DialogsContainer targetSessionOf 对选中 lazySession 返回 cold 路径（不再弹出「会话还没载入」）", () => {
    const dialogs = read("ui/src/pi/containers/DialogsContainer.tsx")
    assert.match(dialogs, /if \(lazy && lazy\.id === relay\.roomId\)/)
    assert.match(dialogs, /relay\.runCommand\("fork", \{ entryId, position: "before" \}\)/)
    assert.match(dialogs, /forkedSessionRow\(data\)/)
  })

  test("forkTurnOf 忽略 queued/sending；forkEntryIdForTurn 不被空 preview 或前导空白误配", () => {
    const items = [
      { kind: "user", key: "u0", text: "", images: [{ mimeType: "image/png", data: "x" }] },
      { kind: "assistant", key: "a0", blocks: [{ kind: "text", text: "图片回复" }] },
      { kind: "user", key: "u1", text: "   第二句带空格", images: [] },
      { kind: "assistant", key: "a1", blocks: [{ kind: "text", text: "第二个回复" }] },
      { kind: "user", key: "u2", text: "排队中", images: [], queued: true },
      { kind: "user", key: "u3", text: "发送中", images: [], status: "sending" },
    ]
    const turn = transcriptView.forkTurnOf(items, "a1")
    assert.deepEqual(turn, { fromEnd: 0, isLatest: true, userText: "第二句带空格" })

    const tree = {
      path: ["s", "e-u0", "e-a0", "e-u1", "e-a1"],
      leafId: "e-a1",
      tree: [
        {
          entry: { id: "s", parentId: null, type: "session" },
          children: [
            {
              entry: { id: "e-u0", parentId: "s", type: "message", role: "user", preview: "" },
              children: [
                {
                  entry: { id: "e-a0", parentId: "e-u0", type: "message", role: "assistant" },
                  children: [
                    {
                      entry: { id: "e-u1", parentId: "e-a0", type: "message", role: "user", preview: "第二句带空格" },
                      children: [{ entry: { id: "e-a1", parentId: "e-u1", type: "message", role: "assistant" }, children: [] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    assert.equal(transcriptView.forkEntryIdForTurn(tree, turn), "e-a1")
    // 不匹配的文本不得错误回落到空 preview 的图片轮次 e-a0
    assert.equal(transcriptView.forkEntryIdForTurn(tree, { fromEnd: 99, isLatest: false, userText: "不存在的问题" }), null)
  })

  test("PiPaneRail 无未定义 CSS 变量、tray.ts 展示定时 pill、voiceDictation 识别 zh-CN", () => {
    const themeCss = read("ui/src/components/pi/shared/pi-theme.css")
    const paneTabs = read("ui/src/components/pi/conversation/PiPaneTabs.tsx")
    for (const deadVar of ["--cw-diff-add-fg", "--cw-status-running", "--cw-hover)", "--cw-active)"]) {
      assert.equal(themeCss.includes(deadVar), false, `pi-theme.css 不得残留未定义变量 ${deadVar}`)
      assert.equal(paneTabs.includes(deadVar), false, `PiPaneTabs.tsx 不得残留未定义变量 ${deadVar}`)
    }

    assert.deepEqual(tray.trayItemsOf({ linkOk: true, deviceOnline: true, scheduled: [{ state: "armed" }, { state: "armed" }, { state: "retired" }] }), [
      { kind: "queue", label: "Scheduled 2", title: "Scheduled messages — click to view, add, or cancel" },
    ])
    const combined = tray.trayItemsOf({
      linkOk: true,
      deviceOnline: true,
      remoteQueue: [{ status: "pending" }],
      scheduled: [{ state: "armed" }],
    })
    assert.equal(combined[0].kind, "queue")
    assert.equal(combined[0].label, "Queued 1 · Scheduled 1")

    assert.equal(voice.resolveRecognitionLang("zh-CN", "en-US"), "zh-CN")
    assert.equal(voice.resolveRecognitionLang("zh", "en-US"), "zh-CN")
  })

  test("selected lazySession 保留启用会话、重命名、冷分叉与导出菜单可用性", () => {
    const rowId = "sess-lazy-1"
    const model = sessionMenu.sessionMenuOf({
      row: { id: rowId, openable: false, path: "/sessions/sess-lazy-1.jsonl", cwd: "/work/proj" },
      currentRoomId: rowId,
      lazySessionId: rowId,
      authed: true,
      online: true,
      busy: false,
      deviceMode: true,
      deviceOnline: true,
      onSelectedDevice: true,
      deleteRoute: { running: false, via: "device", roomId: null },
    })
    assert.equal(model.current, true)
    assert.equal(model.active, false)
    assert.equal(model.items.open.disabled, false)
    assert.equal(model.items.rename.disabled, false)
    assert.equal(model.items.fork.disabled, false)
    assert.equal(model.items.export.disabled, false)
    assert.equal(model.items.delete.disabled, true)
    assert.equal(model.items.delete.reason, sessionMenu.PI_MENU_REASON.deleteCurrent)
  })
})
