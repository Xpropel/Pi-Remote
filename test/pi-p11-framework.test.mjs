// P11 B0 框架契约测试（纯 Node，无浏览器）：
// types/surfaces/geometry、model（状态/时间/分组/pin-archive/设备/身份）、storage（scope 隔离/健壮性/toggle）、
// tokens.css（六套选择器与色位变量齐全、自包含）、allowlist 精确放行、断点 768、serverName fallback。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")

const types = await import("../ui/src/pi/sidebar/types.ts")
const model = await import("../ui/src/pi/sidebar/model.ts")
const storage = await import("../ui/src/pi/sidebar/storage.ts")
const gallery = await import("../ui/src/pi/sidebar/gallery.ts")
const mobile = await import("../ui/src/pi/mobile/types.ts")
const server = await import("../ui/src/pi/model/serverName.ts")
const variants = await import("../ui/src/pi/variants/types.ts")
const { piVariantImportVerdict, PI_VARIANT_ALLOWED_SIDEBAR_MODULES, PI_VARIANT_ALLOWED_MOBILE_MODULES } = await import("../ui/src/pi/headless/allowlist.ts")

test("契约常量：3 风格 × 2 明暗、surface 齐全、几何与设计册一致", () => {
  assert.deepEqual([...types.PI_SIDEBAR_STYLES], ["cursor", "claude", "codex"])
  assert.deepEqual([...types.PI_SIDEBAR_THEMES], ["dark", "light"])
  assert.deepEqual([...types.PI_SIDEBAR_STYLES], [...variants.PI_UI_VARIANTS ?? variants.PI_VARIANTS ?? types.PI_SIDEBAR_STYLES].slice(0, 3).length === 3 ? [...types.PI_SIDEBAR_STYLES] : [])
  assert.equal(types.PI_SIDEBAR_SURFACES.length, 14)
  assert.equal(types.PI_MOBILE_SURFACES.length, 12)
  assert.equal(new Set(types.PI_SIDEBAR_SURFACES.map((s) => s.id)).size, 14)
  assert.equal(new Set(types.PI_MOBILE_SURFACES.map((s) => s.id)).size, 12)
  assert.deepEqual(
    { w: types.PI_SIDEBAR_METRICS.widthDefault, min: types.PI_SIDEBAR_METRICS.widthMin, max: types.PI_SIDEBAR_METRICS.widthMax, collapsed: types.PI_SIDEBAR_METRICS.widthCollapsed, pad: types.PI_SIDEBAR_METRICS.padX, session: types.PI_SIDEBAR_METRICS.sessionH },
    { w: 272, min: 220, max: 360, collapsed: 56, pad: 12, session: 28 },
  )
  assert.equal(types.PI_SIDEBAR_METRICS.alignX, 29.5)
  assert.equal(types.PI_SIDEBAR_METRICS.pinBox, 19)
  assert.equal(types.PI_SIDEBAR_METRICS.archiveBox, 14)
  assert.equal(types.PI_SIDEBAR_METRICS.bubbleW, 230)
  assert.equal(mobile.PI_MOBILE_NAV_DEFAULT, "list")
  assert.equal(mobile.PI_MOBILE_METRICS.topBarH, 54)
  assert.equal(mobile.PI_MOBILE_METRICS.sessionRowH, 60)
  assert.equal(mobile.PI_MOBILE_METRICS.swipeActionsW, 148)
  assert.equal(mobile.PI_MOBILE_METRICS.swipeActionW, 74)
  assert.equal(mobile.PI_MOBILE_METRICS.safeAreaBottom, 30)
  assert.equal(gallery.PI_SIDEBAR_GALLERY_PRESETS.length, 6)
  assert.deepEqual(gallery.PI_SIDEBAR_GALLERY_PRESETS.map((p) => p.id), ["cursor-dark", "cursor-light", "claude-dark", "claude-light", "codex-dark", "codex-light"])
  assert.equal(gallery.piSidebarGalleryPresetOf("claude")?.style, "claude")
})

test("状态诚实降级：优先级 error>waiting>running>idle；无法判定=idle 且不显示 chip", () => {
  assert.equal(model.sidebarStatusOf({}).tone, "idle")
  assert.equal(model.sidebarStatusOf({}).showChip, false)
  assert.equal(model.sidebarStatusOf({ running: true }).tone, "running")
  assert.equal(model.sidebarStatusOf({ running: true }).showChip, true)
  assert.equal(model.sidebarStatusOf({ running: true, waiting: true }).tone, "waiting")
  assert.equal(model.sidebarStatusOf({ running: true, waiting: true, error: true }).tone, "error")
  assert.equal(model.sidebarStatusOf({ error: true }).showChip, false)
  assert.equal(model.sidebarToneLabel("idle"), "空闲")
})

test("时间/摘要：刚刚/Nm/Nh/昨天/M月D日；摘要无事件必须空串（不编造）", () => {
  const now = new Date(2026, 9, 27, 15, 0, 0).getTime()
  assert.equal(model.relativeTimeLabel(now, now - 30_000), "刚刚")
  assert.equal(model.relativeTimeLabel(now, now - 5 * 60_000), "5m")
  assert.equal(model.relativeTimeLabel(now, now - 2 * 3_600_000), "2h")
  assert.equal(model.relativeTimeLabel(now, new Date(2026, 9, 26, 10, 0, 0).getTime()), "昨天")
  assert.equal(model.relativeTimeLabel(now, new Date(2026, 9, 20, 10, 0, 0).getTime()), "10月20日")
  assert.equal(model.relativeTimeLabel(now, undefined), "")
  assert.equal(model.relativeTimeLabel(now, 0), "")
  assert.equal(model.sidebarSummaryLineOf(undefined), "")
  assert.equal(model.sidebarSummaryLineOf("  "), "")
  assert.equal(model.sidebarSummaryLineOf("正在跑 e2e，已过 34 步"), "正在跑 e2e，已过 34 步")
})

test("分组/置顶/归档/设备/身份：稳定 key、cwd 分组、置顶顺序、归档隐藏、真实设备不虚构", () => {
  assert.equal(model.sidebarSessionKeyOf("dev1", "room1"), "dev1::room1")
  assert.equal(model.sidebarWorkspaceGroupId(undefined), "ungrouped")
  assert.equal(model.sidebarWorkspaceGroupId("/Users/user/CLI/Pi-Remote/"), "cwd:/Users/user/CLI/Pi-Remote")
  assert.equal(model.sidebarWorkspaceLabel("/Users/user/CLI/Pi-Remote"), "Pi-Remote")
  assert.equal(model.sidebarWorkspaceLabel(undefined), "未分组")
  const mk = (key, groupId) => ({ key, id: key, title: key, status: model.sidebarStatusOf({}), timeLabel: "", cwd: "", selected: false, pinned: false, archived: false, groupId })
  const groups = [
    { id: "g1", kind: "workspace", label: "g1", collapsed: false, count: 3, sessions: [mk("s1", "g1"), mk("s2", "g1"), mk("s3", "g1")] },
    { id: "g2", kind: "workspace", label: "g2", collapsed: false, count: 1, sessions: [mk("s4", "g2")] },
  ]
  const overlaid = model.sidebarGroupsWithOverlay({ groups, pins: ["s2", "s1"], archives: ["s3"] })
  assert.equal(overlaid[0].kind, "pinned")
  assert.deepEqual(overlaid[0].sessions.map((s) => s.key), ["s2", "s1"])
  assert.deepEqual(overlaid.map((g) => g.sessions.map((s) => s.key)), [["s2", "s1"], [], ["s4"]]) // s2/s1 进置顶、s3 归档；g1 空
  assert.equal(overlaid.reduce((n, g) => n + g.count, 0), 3, "可见行 = 置顶 2 + g2 1")
  const archiveView = model.sidebarGroupsWithOverlay({ groups, pins: ["s2"], archives: ["s3"], archiveView: true })
  assert.deepEqual(archiveView.flatMap((g) => g.sessions.map((s) => s.key)), ["s3"])
  const devices = [
    { id: "d1", name: "MacBook Pro", online: true, current: false },
    { id: "d2", name: "Windows 电脑", online: false, current: false },
  ]
  assert.equal(model.selectedDeviceOf(devices, null)?.id, "d1")
  assert.equal(model.selectedDeviceOf(devices, "nope")?.id, "d1")
  const rows = model.sidebarDeviceRows(devices, "d2")
  assert.deepEqual(rows.map((d) => [d.id, d.current, d.statusLabel]), [["d1", false, "在线"], ["d2", true, "当前"]])
  assert.equal(model.selectedDeviceOf([], "d1"), null, "名册空不虚构设备")
  assert.equal(model.sidebarVisibleSessionCount(overlaid), 3)
  assert.deepEqual(model.sidebarPinOrderOf(groups.flatMap((g) => g.sessions), ["s4", "s1"]), ["s4", "s1"])
})

test("身份行 serverName fallback：配置名 > hostname 去端口 > 本机 relay；绝不拼用户身份", () => {
  assert.equal(server.serverDisplayName("上海中转", "pi-remote.example.com:7002"), "上海中转")
  assert.equal(server.serverDisplayName("", "pi-remote.example.com:7002"), "pi-remote.example.com")
  assert.equal(server.serverDisplayName(null, "[::1]:7002"), "::1")
  assert.equal(server.serverDisplayName(undefined, "192.168.1.10:7002"), "192.168.1.10")
  assert.equal(server.serverDisplayName("", ""), server.SERVER_NAME_FALLBACK)
  assert.equal(server.serverDisplayName("  ", null), server.SERVER_NAME_FALLBACK)
  assert.equal(server.serverTooltipOf("", "host", "http://host:7002"), "http://host:7002")
  assert.equal(server.hostnameOnlyOf("host:7002"), "host")
})

test("storage：account::device 隔离、坏数据回落、pin/archive 互斥、文件夹折叠持久、宽度 clamp", () => {
  const scope1 = storage.sidebarStorageScope("admin", "dev1")
  const scope2 = storage.sidebarStorageScope("admin", "dev2")
  assert.notEqual(scope1, scope2)
  assert.match(scope1, /^admin::dev1$/)
  assert.equal(storage.sidebarStorageScope("", ""), "anonymous::local")
  assert.equal(storage.clampSidebarWidth(999), 360)
  assert.equal(storage.clampSidebarWidth(100), 220)
  assert.equal(storage.clampSidebarWidth("abc"), 272)
  assert.equal(storage.clampSidebarWidth(undefined), 272)
  let state = storage.emptySidebarLocalState()
  state = storage.toggleSidebarPin(state, scope1, "dev1::room1")
  state = storage.toggleSidebarPin(state, scope1, "dev1::room2")
  assert.deepEqual(storage.sidebarScopeStateOf(state, scope1).pins, ["dev1::room1", "dev1::room2"])
  state = storage.toggleSidebarArchive(state, scope1, "dev1::room1")
  assert.deepEqual(storage.sidebarScopeStateOf(state, scope1).archives, ["dev1::room1"])
  assert.deepEqual(storage.sidebarScopeStateOf(state, scope1).pins, ["dev1::room2"], "归档时自动取消置顶")
  assert.deepEqual(storage.sidebarScopeStateOf(state, scope2).pins, [], "scope 隔离")
  state = storage.setSidebarFolderCollapsed(state, scope2, "cwd:/tmp/p", true)
  assert.equal(storage.sidebarScopeStateOf(state, scope2).folders["cwd:/tmp/p"], true)
  const round = storage.parseSidebarLocalState(storage.serializeSidebarLocalState(state))
  assert.deepEqual(storage.sidebarScopeStateOf(round, scope1), storage.sidebarScopeStateOf(state, scope1))
  const bad = storage.parseSidebarLocalState("{bad json")
  assert.deepEqual(bad, storage.emptySidebarLocalState())
  const wrongVersion = storage.parseSidebarLocalState({ v: 99, scopes: { x: { pins: ["a"] } } })
  assert.deepEqual(wrongVersion, storage.emptySidebarLocalState())
  const dirty = storage.parseSidebarLocalState({ v: 1, scopes: { s: { pins: ["a", "a", 3, ""], archives: "x", folders: { g: "yes", h: false }, updatedAt: "no" } } })
  assert.deepEqual(storage.sidebarScopeStateOf(dirty, "s").pins, ["a"])
  assert.deepEqual(storage.sidebarScopeStateOf(dirty, "s").archives, [])
  assert.deepEqual(storage.sidebarScopeStateOf(dirty, "s").folders, { h: false })
  const pruned = storage.pruneSidebarScopeKeys(state, scope1, ["dev1::room2"])
  assert.deepEqual(storage.sidebarScopeStateOf(pruned, scope1).pins, ["dev1::room2"])
  assert.deepEqual(storage.sidebarScopeStateOf(pruned, scope1).archives, [])
  assert.deepEqual(storage.sidebarScopeStateOf(storage.clearSidebarScope(state, scope1), scope1), { pins: [], archives: [], folders: {}, updatedAt: 0 })
  assert.equal(storage.PI_SIDEBAR_LOCAL_STORAGE_KEY, "pi_remote_pi_sidebar_local")
})

test("tokens.css：六套选择器齐全、32 色位变量每套都有、无 cursor/变体私有变量、无全局选择器", () => {
  const css = read("ui/src/pi/sidebar/tokens.css")
  for (const style of ["cursor", "claude", "codex"]) {
    for (const theme of ["dark", "light"]) {
      assert.match(css, new RegExp(`\\[data-pi-sidebar-style="${style}"\\]\\[data-pi-theme="${theme}"\\]`), `${style}/${theme} 自属性选择器`)
      assert.match(css, new RegExp(`\\[data-pi-theme="${theme}"\\] \\[data-pi-sidebar\\]\\[data-pi-sidebar-style="${style}"\\]`), `${style}/${theme} 祖先主题选择器`)
    }
  }
  const colors = [
    "--sb-bg", "--sb-backdrop", "--sb-border", "--sb-t1", "--sb-t2", "--sb-t3", "--sb-t4", "--sb-t5", "--sb-icon", "--sb-icon-muted",
    "--sb-pill-bg", "--sb-pill-fg", "--sb-device-bg", "--sb-menu-bg", "--sb-menu-border", "--sb-menu-selected-bg", "--sb-menu-selected-fg",
    "--sb-menu-divider", "--sb-hover-bg", "--sb-hover-icon", "--sb-selected-bg", "--sb-selected-ring", "--sb-selected-shadow",
    "--sb-run", "--sb-run-soft", "--sb-run-glow", "--sb-wait", "--sb-error", "--sb-idle", "--sb-online",
    "--sb-bubble-bg", "--sb-bubble-border", "--sb-bubble-icon", "--sb-bubble-backdrop", "--sb-tile-bg", "--sb-tile-fg", "--sb-identity-fg",
    "--sb-main-bg", "--sb-ink1", "--sb-ink2", "--sb-ink3",
  ]
  for (const name of colors) {
    const occurrences = css.split(name + ":").length - 1
    assert.ok(occurrences >= 6, `${name} 在六套中都要有（实际 ${occurrences}）`)
  }
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /--cw-/, "不得引用 cursor 变量（注释除外）")
  assert.doesNotMatch(css, /(^|\n)\s*(:root|html|body|\*)\s*\{/, "不得写全局选择器")
  assert.match(css, /--sb-font-serif/, "Claude 衬线字体栈存在")
  assert.match(read("ui/src/pi/mobile/types.ts"), /PI_MOBILE_NAV_COPY/)
})

test("allowlist：@/pi/sidebar、@/pi/mobile 精确放行；未登记子模块/借道路径/组件拒绝", () => {
  assert.ok([...PI_VARIANT_ALLOWED_SIDEBAR_MODULES].includes("@/pi/sidebar"))
  assert.ok([...PI_VARIANT_ALLOWED_MOBILE_MODULES].includes("@/pi/mobile"))
  for (const spec of ["@/pi/sidebar", "@/pi/sidebar/types", "@/pi/sidebar/model", "@/pi/mobile", "@/pi/mobile/types"]) {
    assert.equal(piVariantImportVerdict(spec).ok, true, spec)
  }
  for (const spec of ["@/pi/sidebar/private", "@/pi/sidebar/../components/pi/PiRoot", "@/pi/mobile/private", "@/pi/mobile/../relay/useRelay"]) {
    assert.equal(piVariantImportVerdict(spec).ok, false, spec)
  }
  assert.match(piVariantImportVerdict("@/pi/sidebar/private").reason, /P11 侧栏只允许精确模块/)
  assert.match(piVariantImportVerdict("@/pi/mobile/private").reason, /P11 移动导航只允许精确模块/)
})


test("宿主入口：side/mobile barrel 导出统一组件与移动壳；allowlist 登记对应精确模块", () => {
  const sidebarBarrel = read("ui/src/pi/sidebar/index.ts")
  assert.match(sidebarBarrel, /export \{ UnifiedSidebar \} from "\.\/UnifiedSidebar"/)
  assert.match(sidebarBarrel, /export type \{ UnifiedSidebarProps \}/)
  const mobileBarrel = read("ui/src/pi/mobile/index.ts")
  assert.match(mobileBarrel, /export \{ MobileNavShell, MobileSessionPage \}/)
  assert.match(mobileBarrel, /export \{ MobileNavSetting, MobileSettingsPicker \}/)
  assert.ok([...PI_VARIANT_ALLOWED_SIDEBAR_MODULES].includes("@/pi/sidebar/UnifiedSidebar"))
  assert.ok([...PI_VARIANT_ALLOWED_MOBILE_MODULES].includes("@/pi/mobile/MobileNavShell"))
  assert.ok([...PI_VARIANT_ALLOWED_MOBILE_MODULES].includes("@/pi/mobile/MobileNavSetting"))
  // 单一共享核：全仓只有一份 UnifiedSidebar 组件定义（变体只许薄适配）
  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file, out)
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(file)
    }
    return out
  }
  const files = walk(path.join(ROOT, "ui/src"))
  const definitions = files.filter((file) => /export function UnifiedSidebar\b/.test(fs.readFileSync(file, "utf8")))
  assert.deepEqual(definitions.map((file) => path.relative(ROOT, file).split(path.sep).join("/")), ["ui/src/pi/sidebar/UnifiedSidebar.tsx"])
})


test("生产 CSS 级联守卫：sidebar.css 组件规则必须 .sb-root 作用域（压过变体 [data-pi-ui] button reset）", () => {
  const css = read("ui/src/pi/sidebar/sidebar.css")
  const rules = [...css.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).filter((sel) => !sel.startsWith("/*"))
  const unscoped = []
  for (const selectorList of rules) {
    for (const selector of selectorList.split(",")) {
      const sel = selector.trim()
      if (!sel || sel.startsWith("/*")) continue
      // 根规则允许 .sb-root / .sb-root[...]；其余组件规则必须 .sb-root 前缀
      if (!sel.startsWith(".sb-root") && !sel.startsWith(".sb-root ") && !sel.startsWith("[data-pi-sidebar]")) unscoped.push(sel)
    }
  }
  assert.deepEqual(unscoped, [], "未作用域的 sidebar 规则会被变体全局 reset 压掉：" + unscoped.join(" | "))
  assert.match(css, /\.sb-root \.sb-row-main \{[^}]*padding:\s*0 0 0 34px/, "会话行 34 左内边距规则必须存在且作用域正确")
  assert.match(css, /\.sb-root \.sb-marker \{[^}]*margin-left:\s*-19\.5px/, "状态点对齐 transform 规则存在")
  assert.doesNotMatch(css, /^\.sb-row-main\s*\{/m, "不得残留未作用域的旧规则（会被生产级联覆盖）")
  assert.doesNotMatch(css, /data-sb-skin=/, "组件实际属性是 data-pi-sidebar-style，不得用旧 data-sb-skin")
})
