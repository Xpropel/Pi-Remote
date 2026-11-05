// A-3: web search could not find body text. The root cause was missing wiring — the
// extension-side scan (cmdSearchSessionBodies) and the relay room fan-out/merge
// (relay/bodySearch.ts) always existed, but no live surface called them: the command
// palettes (pi/claude/codex shells + phone sheet) filtered by title/group only, the
// sidebar search overlay and the phone search page filtered local titles only, and the
// one surface wired for body search (SearchContainer) was mounted by no live shell.
// This file pins the fix: paletteBodyHitsOf mapping/dedup, the merge layer's encrypted
// room exclusion (ciphertext is never searched and is reported, not silently dropped),
// and source-level wiring of useBodySearch into every live search surface.
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { paletteBodyHitsOf } from "../ui/src/pi/model/palette.ts"
import { bodySearchErrorReasonOf, mergeBodySearchReplies } from "../ui/src/relay/bodySearch.ts"
import { RelayError } from "../ui/src/relay/devices.ts"
import { bodySearchErrorText, bodySearchPartialText } from "../ui/src/shell/searchModel.ts"
import { bodyHitOf, bodySearchNoteOf, sidebarBodyBlockOf } from "../ui/src/pi/hooks/useBodySearch.ts"

const read = (p) => fs.readFileSync(new URL(`../ui/src/${p}`, import.meta.url), "utf8")

const rawHit = (session, extra = {}) => ({
  session,
  id: "s1",
  title: "排练会话",
  cwd: "/work/demo2",
  mtime: 100,
  matchCount: 3,
  snippets: [{ text: "九九 乘法表 全文" }],
  ...extra,
})
const rawPage = (results, extra = {}) => ({ query: "乘法表", results, truncated: false, scannedFiles: 2, totalFiles: 2, ...extra })
const DEVICE = { id: "dev-b", name: "UI测试机B" }

describe("paletteBodyHitsOf：回包 → 面板正文行", () => {
  test("字段映射：组名 = 设备名/目录名，片段取第一条，盖设备 id，保回包顺序", () => {
    const page = rawPage([
      rawHit("/work/demo2/2026-11-04_a.jsonl", { id: "a", mtime: 200 }),
      rawHit("/work/demo2/2026-11-03_b.jsonl", { id: "b", mtime: 100, snippets: [] }),
    ])
    const rows = paletteBodyHitsOf(page, DEVICE, [])
    assert.equal(rows.length, 2)
    assert.deepEqual(
      rows.map((r) => [r.id, r.group, r.snippet, r.matchCount, r.deviceId]),
      [
        ["a", "UI测试机B/demo2", "九九 乘法表 全文", 3, "dev-b"],
        ["b", "UI测试机B/demo2", "", 3, "dev-b"],
      ],
    )
    assert.equal(rows[0].session, "/work/demo2/2026-11-04_a.jsonl")
  })

  test("标题组已列的会话不再重复：按 id 与按文件路径（斜杠统一）双口径排除", () => {
    const page = rawPage([
      rawHit("/work/demo2/a.jsonl", { id: "same-id" }),
      rawHit("C:\\work\\demo2\\b.jsonl", { id: "other-id" }),
      rawHit("/work/demo2/c.jsonl", { id: "fresh" }),
    ])
    const rows = paletteBodyHitsOf(page, DEVICE, [
      { id: "same-id" },
      { id: "zzz", path: "C:/work/demo2/b.jsonl" },
    ])
    assert.deepEqual(rows.map((r) => r.id), ["fresh"])
  })
})

describe("加密房间排除：合并层口径（密文永不搜、明示不静默）", () => {
  const encTarget = { kind: "room", roomId: "r-enc", cwd: "/work/demo2", enc: true }
  const plainTarget = { kind: "room", roomId: "r-plain", cwd: "/work/plain" }

  test("全部目标都是加密房间且回 unsupported → 整体按 encrypted 报错，文案明说已加密", () => {
    const merged = mergeBodySearchReplies("乘法表", [
      { target: encTarget, ok: false, error: new RelayError("unsupported", "该会话已加密，正文搜索不支持") },
    ])
    assert.equal(merged.ok, false)
    assert.equal(merged.error.code, "encrypted")
    assert.equal(bodySearchErrorText(merged.error.code, ""), "该房间已加密，无法在中转侧搜索")
  })

  test("明文目标有命中、加密目标被拦 → 命中照常，unanswered 记 encrypted，部分结果文案写明已加密", () => {
    const merged = mergeBodySearchReplies("乘法表", [
      { target: plainTarget, ok: true, data: rawPage([rawHit("/work/plain/a.jsonl")]) },
      { target: encTarget, ok: false, error: new RelayError("unsupported", "该会话已加密，正文搜索不支持") },
    ])
    assert.equal(merged.ok, true)
    assert.equal(merged.page.results.length, 1)
    assert.deepEqual(merged.page.unanswered, [{ cwd: "/work/demo2", code: "encrypted" }])
    assert.match(bodySearchPartialText(merged.page), /已加密，无法在中转侧搜索/)
  })

  test("非加密目标的 unsupported 不被改写成 encrypted（旧扩展仍报不支持）", () => {
    const merged = mergeBodySearchReplies("乘法表", [
      { target: plainTarget, ok: false, error: new RelayError("unsupported", "unknown command") },
    ])
    assert.equal(merged.ok, false)
    assert.equal(merged.error.code, "unsupported")
  })
})

describe("合并层：ack 的 data.reason=room_encrypted 也算加密拒绝（第二轮，实测回包形状）", () => {
  // Live verification (VERIFY-2115 item 6) captured the relay's real
  // refusal frame: { ok:false, code:"unsupported", error:"该会话已加密，
  // 正文搜索不支持", data:{ unsupported:true, reason:"room_encrypted" } }
  // for rooms the roster had NOT flagged enc (installB registers its
  // rooms enc without the viewer's roster copy carrying the flag). The
  // merge only recognized target.enc, so the panel reported an old
  // extension. The command channel now carries ack data on the rejection
  // error and the merge reads the reason as a second signal.
  const encAckError = () =>
    Object.assign(new Error("该会话已加密，正文搜索不支持"), { code: "unsupported", data: { unsupported: true, reason: "room_encrypted" } })
  const unflaggedRoom = (roomId, cwd) => ({ kind: "room", roomId, cwd })

  test("全部目标仅 reason 信号 → 整体 encrypted 口径，不再误报版本不支持", () => {
    const merged = mergeBodySearchReplies("乘法表", [
      { target: unflaggedRoom("r1", "/work/demo2"), ok: false, error: encAckError() },
      { target: unflaggedRoom("r2", "/work/plain"), ok: false, error: encAckError() },
    ])
    assert.equal(merged.ok, false)
    assert.equal(merged.error.code, "encrypted")
    assert.equal(bodySearchErrorText(merged.error.code, ""), "该房间已加密，无法在中转侧搜索")
  })

  test("混合、仅 reason 信号 → 明文命中保留，加密项进 unanswered 并写明已加密", () => {
    const merged = mergeBodySearchReplies("乘法表", [
      { target: unflaggedRoom("r1", "/work/plain"), ok: true, data: rawPage([rawHit("/work/plain/a.jsonl")]) },
      { target: unflaggedRoom("r2", "/work/demo2"), ok: false, error: encAckError() },
    ])
    assert.equal(merged.ok, true)
    assert.equal(merged.page.results.length, 1)
    assert.deepEqual(merged.page.unanswered, [{ cwd: "/work/demo2", code: "encrypted" }])
    assert.match(bodySearchPartialText(merged.page), /已加密，无法在中转侧搜索/)
  })

  test("unsupported 带其它 reason 且名册未标 enc → 保持 unsupported（真·旧扩展口径不被吞）", () => {
    const other = Object.assign(new Error("unknown command"), { code: "unsupported", data: { reason: "unknown_command" } })
    const merged = mergeBodySearchReplies("乘法表", [{ target: unflaggedRoom("r1", "/work/plain"), ok: false, error: other }])
    assert.equal(merged.ok, false)
    assert.equal(merged.error.code, "unsupported")
    assert.equal(bodySearchErrorText(merged.error.code, ""), "这台设备的扩展版本不支持正文搜索")
  })

  test("bodySearchErrorReasonOf：只认 data.reason 字符串，其余形状回空串", () => {
    assert.equal(bodySearchErrorReasonOf(encAckError()), "room_encrypted")
    assert.equal(bodySearchErrorReasonOf(new RelayError("unsupported", "x")), "")
    assert.equal(bodySearchErrorReasonOf(Object.assign(new Error("x"), { data: { reason: 7 } })), "")
    assert.equal(bodySearchErrorReasonOf(null), "")
    assert.equal(bodySearchErrorReasonOf("room_encrypted"), "")
  })
})

describe("bodySearchNoteOf：完成态状态行", () => {
  const done = (page) => ({ phase: "done", query: "乘法表", page })

  test("有命中且没扫全 → 已扫计数；命中全被标题组占了 → 已在上面列出；真没有 → 正文里没有找到", () => {
    assert.equal(bodySearchNoteOf(done(rawPage([rawHit("/x/a.jsonl")], { truncated: true, scannedFiles: 1, totalFiles: 4 })), 1), "已扫 1/4 个会话文件，结果可能不全")
    assert.equal(bodySearchNoteOf(done(rawPage([rawHit("/x/a.jsonl")])), 0), "正文命中的会话已在上面列出")
    assert.equal(bodySearchNoteOf(done(rawPage([])), 0), "正文里没有找到「乘法表」")
    assert.equal(bodySearchNoteOf(done(rawPage([rawHit("/x/a.jsonl")])), 1), null)
    assert.equal(bodySearchNoteOf({ phase: "searching", query: "乘法表" }, 0), null)
  })
})

describe("侧栏正文块组装（sidebarBodyBlockOf / bodyHitOf，三壳侧栏共用）", () => {
  const searchOf = (state, extra = {}) => ({ state, deviceId: "dev-b", deviceName: "UI测试机B", ...extra })
  const done = (page) => ({ phase: "done", query: "乘法表", page })

  test("idle 或没有选中设备 → 无正文块", () => {
    assert.equal(sidebarBodyBlockOf(searchOf({ phase: "idle" }), []), undefined)
    assert.equal(sidebarBodyBlockOf(searchOf(done(rawPage([])), { deviceId: null }), []), undefined)
  })

  test("searching → 搜索中口径，正文组标题带设备名", () => {
    assert.deepEqual(sidebarBodyBlockOf(searchOf({ phase: "searching", query: "乘法表" }), []), {
      deviceName: "UI测试机B",
      phase: "searching",
      hits: [],
      note: "正在 UI测试机B 上搜索正文…",
    })
  })

  test("error → 错误口径直接用状态文案", () => {
    const block = sidebarBodyBlockOf(searchOf({ phase: "error", query: "乘法表", text: "这台设备的扩展版本不支持正文搜索" }), [])
    assert.equal(block.phase, "error")
    assert.equal(block.note, "这台设备的扩展版本不支持正文搜索")
    assert.deepEqual(block.hits, [])
  })

  test("done → 命中映射成展示行（label/片段/命中数），标题已命中的按 id 排除", () => {
    const page = rawPage([
      rawHit("/work/demo2/a.jsonl", { id: "listed", title: "标题已列会话" }),
      rawHit("/work/demo2/b.jsonl", { id: "body-only", title: "正文命中会话", matchCount: 5, snippets: [{ text: "只有正文里出现" }] }),
    ])
    const search = searchOf(done(page))
    const titleMatched = [{ id: "listed", path: "/work/demo2/a.jsonl" }]
    const block = sidebarBodyBlockOf(search, titleMatched)
    assert.equal(block.phase, "done")
    assert.equal(block.deviceName, "UI测试机B")
    assert.deepEqual(block.hits, [{ id: "body-only", label: "正文命中会话", snippet: "只有正文里出现", matchCount: 5 }])
    assert.equal(block.note, undefined)
  })

  test("done 且命中全被标题组占了 → 状态行说明已在上面列出", () => {
    const page = rawPage([rawHit("/work/demo2/a.jsonl", { id: "listed" })])
    const block = sidebarBodyBlockOf(searchOf(done(page)), [{ id: "listed", path: "/work/demo2/a.jsonl" }])
    assert.deepEqual(block.hits, [])
    assert.equal(block.note, "正文命中的会话已在上面列出")
  })

  test("bodyHitOf：保留的命中解析回完整行（带设备与文件路径），被排除/非 done 态解析不到", () => {
    const page = rawPage([
      rawHit("/work/demo2/a.jsonl", { id: "listed" }),
      rawHit("/work/demo2/b.jsonl", { id: "body-only" }),
    ])
    const search = searchOf(done(page))
    const titleMatched = [{ id: "listed", path: "/work/demo2/a.jsonl" }]
    const opened = bodyHitOf(search, titleMatched, "body-only")
    assert.equal(opened.deviceId, "dev-b")
    assert.equal(opened.session, "/work/demo2/b.jsonl")
    assert.equal(opened.cwd, "/work/demo2")
    assert.equal(bodyHitOf(search, titleMatched, "listed"), null)
    assert.equal(bodyHitOf(searchOf({ phase: "searching", query: "乘法表" }), [], "body-only"), null)
  })
})

describe("源码口径：在用界面都接上正文搜索（A-3 的根因是接线缺失）", () => {
  test("useBodySearch 已登记进变体白名单（claude/codex 壳可 import）", () => {
    assert.match(read("pi/headless/allowlist.ts"), /"@\/pi\/hooks\/useBodySearch"/)
  })

  test("命令面板三壳 + 容器都接了 useBodySearch 与正文组", () => {
    assert.match(read("pi/containers/CommandPaletteContainer.tsx"), /useBodySearch/)
    assert.match(read("pi/containers/CommandPaletteContainer.tsx"), /paletteBodyHitsOf/)
    assert.match(read("components/pi/composer/PiCommandPalette.tsx"), /PiPaletteBodySection/)
    assert.match(read("components/pi/composer/PiCommandPalette.tsx"), /bodyHit/)
    assert.match(read("pi/variants/claude/overlays/ClaudeCommandPalette.tsx"), /useBodySearch/)
    assert.match(read("pi/variants/claude/overlays/ClaudeCommandPalette.tsx"), /正文匹配/)
    assert.match(read("pi/variants/codex/overlays/CodexCommandPalette.tsx"), /useBodySearch/)
    assert.match(read("pi/variants/codex/overlays/CodexCommandPalette.tsx"), /正文匹配/)
  })

  test("侧栏搜索浮层与手机搜索页渲染正文组并走 selectBodyHit", () => {
    assert.match(read("pi/sidebar/components/SidebarSearchOverlay.tsx"), /search\.body/)
    assert.match(read("pi/sidebar/components/SidebarSearchOverlay.tsx"), /selectBodyHit/)
    assert.match(read("pi/mobile/MobileSearchPage.tsx"), /search\.body/)
    assert.match(read("pi/mobile/MobileSearchPage.tsx"), /selectBodyHit/)
    assert.match(read("pi/containers/CursorUnifiedSidebar.tsx"), /useBodySearch/)
    assert.match(read("pi/containers/PhoneApp.tsx"), /useBodySearch/)
  })

  test("Claude / Codex 侧栏容器也接了正文搜索（第二轮：默认壳 Claude 的侧栏此前没接）", () => {
    for (const file of ["pi/variants/claude/sidebar/ClaudeUnifiedSidebar.tsx", "pi/variants/codex/sidebar/CodexUnifiedSidebar.tsx"]) {
      const src = read(file)
      assert.match(src, /useBodySearch/, file)
      assert.match(src, /sidebarBodyBlockOf/, file)
      assert.match(src, /body: bodyBlock/, file)
      assert.match(src, /selectBodyHit/, file)
      assert.match(src, /openBodySearchHit/, file)
    }
  })

  test("正文块组装新导出已登记进变体白名单（sidebarBodyBlockOf / bodyHitOf）", () => {
    const allowlist = read("pi/headless/allowlist.ts")
    assert.match(allowlist, /"sidebarBodyBlockOf"/)
    assert.match(allowlist, /"bodyHitOf"/)
  })
})
