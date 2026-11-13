import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"

const ROOT = new URL("../", import.meta.url)
const read = (path) => fs.readFile(new URL(path, ROOT), "utf8")

test("P11 移动框架出口齐全（MobileTopBar/MobileListHome/SwipeRow/MobileDrawerNav/LongPressCard/MobileSearchPage/MobileNavSetting/MobileNavShell）", async () => {
  const index = await read("ui/src/pi/mobile/index.ts")
  for (const name of [
    "MobileTopBar",
    "MobileListHome",
    "SwipeRow",
    "MobileDrawerNav",
    "LongPressCard",
    "MobileSearchPage",
    "MobileNavSetting",
    "MobileNavShell",
  ]) {
    assert.equal(index.includes(name), true, `index 应导出 ${name}`)
  }
})

test("移动框架自包含：不 import 变体/cursor kit 值，不用 --cw-*/--claude-*/--codex-* 变量", async () => {
  const files = await fs.readdir(new URL("ui/src/pi/mobile/", ROOT))
  for (const file of files) {
    if (!/\.(tsx?|css)$/.test(file)) continue
    const text = await read(`ui/src/pi/mobile/${file}`)
    assert.equal(/from\s+"@\/components\//.test(text), false, `${file} 不应 import @/components`)
    assert.equal(/--cw-|--claude-|--codex-/.test(text), false, `${file} 不应使用变体私有变量`)
  }
})

test("移动 CSS 关键参数：抽屉宽 clamp(288,屏宽-68,340)、左滑 148、安全段 30、顶栏 54", async () => {
  const css = await read("ui/src/pi/mobile/mobile.css")
  assert.equal(css.includes("clamp(288px, calc(100vw - 68px), 340px)"), true)
  assert.equal(css.includes("width: 148px"), true)
  assert.equal(css.includes("--pm-safe-bottom: 30px"), true)
  assert.equal(css.includes("height: 54px"), true)
  const types = await read("ui/src/pi/mobile/types.ts")
  assert.equal(types.includes("MOBILE_SWIPE_WIDTH = 148"), true)
  assert.equal(types.includes("MOBILE_SAFE_BOTTOM = 30"), true)
})

test("移动 surface 标记：P11-MOB-01/02/03/04/05/06/07/08/09/10/11 都可选择", async () => {
  const dir = new URL("ui/src/pi/mobile/", ROOT)
  const files = await fs.readdir(dir)
  let all = ""
  for (const file of files) if (file.endsWith(".tsx")) all += await read(`ui/src/pi/mobile/${file}`)
  for (const id of ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11"]) {
    assert.equal(all.includes(`P11-MOB-${id}`), true, `缺少 P11-MOB-${id}`)
  }
})

test("P11：文件夹默认折叠、折叠组头不显示会话数（桌面 + 移动）", async () => {
  const desktop = await read("ui/src/pi/containers/CursorUnifiedSidebar.tsx")
  assert.equal(desktop.includes("folders[group.key] !== false"), true, "桌面适配默认折叠")
  const mobile = await read("ui/src/pi/mobile/useMobileSidebarData.ts")
  assert.equal(mobile.includes("scopeState.folders[group.key] !== false"), true)
  assert.equal(mobile.includes("!(current.folders[groupId] ?? true)"), true, "首次点击展开写 false")
  const home = await read("ui/src/pi/mobile/MobileListHome.tsx")
  assert.equal(home.includes("pm-group-count"), false, "组头永不显示会话数")
})

test("P11 a11y/六套 token：mobile.css 映射真实 --sb-*；抽屉/长按卡/搜索/radio 键盘路径存在", async () => {
  const css = await read("ui/src/pi/mobile/mobile.css")
  for (const token of ["--sb-t1", "--sb-t2", "--sb-t3", "--sb-t4", "--sb-t5", "--sb-pill-bg", "--sb-hover-bg", "--sb-selected-bg", "--sb-run", "--sb-backdrop"]) {
    assert.equal(css.includes(`var(${token}`), true, `应映射 ${token}`)
  }
  assert.equal(/var\(--sb-(text-|surface|accent[,)])/.test(css), false, "不得再引用不存在的 --sb-text-*/--sb-surface/--sb-accent")
  assert.equal(css.includes("--pm-swipe-pin-bg"), true, "浅色左滑按钮需可读配色 token")
  const drawer = await read("ui/src/pi/mobile/MobileDrawerNav.tsx")
  assert.equal(drawer.includes('document.addEventListener("keydown", onKey)'), true)
  assert.equal(drawer.includes('event.key === "Escape"'), true)
  assert.equal(drawer.includes("focusables()[0]?.focus()"), true)
  const card = await read("ui/src/pi/mobile/LongPressCard.tsx")
  assert.equal(card.includes("firstRef.current?.focus()"), true)
  assert.equal(card.includes('event.key === "Escape"'), true)
  const search = await read("ui/src/pi/mobile/MobileSearchPage.tsx")
  assert.equal(search.includes('event.key === "Escape"'), true)
  const setting = await read("ui/src/pi/mobile/MobileNavSetting.tsx")
  assert.equal(setting.includes('event.key === "ArrowDown"'), true)
  assert.equal(setting.includes("tabIndex={checked ? 0 : -1}"), true)
  const shell = await read("ui/src/pi/mobile/MobileNavShell.tsx")
  for (const attr of ['"data-pi-sidebar"', '"data-pi-mobile"', '"data-pi-sidebar-style"', '"data-pi-theme"']) assert.equal(shell.includes(attr), true, `根缺 ${attr}`)
})

test("Stack3 fix: drawer session rows answer a touch long-press, not only contextmenu/Shift+F10", async () => {
  const drawer = await read("ui/src/pi/mobile/MobileDrawerNav.tsx")
  for (const needle of [
    "DRAWER_LONG_PRESS_MS = 480",
    "onPointerDown",
    'event.pointerType === "mouse"',
    "DRAWER_LONG_PRESS_SLOP = 10",
    "suppressClickRef",
    "onClickCapture",
    "onContextMenu",
  ]) {
    assert.equal(drawer.includes(needle), true, `抽屉行缺触摸长按要素 ${needle}`)
  }
  // The list rows keep their own pointer-driven long-press (SwipeRow).
  const swipe = await read("ui/src/pi/mobile/SwipeRow.tsx")
  assert.equal(swipe.includes("LONG_PRESS_MS = 480"), true)
  assert.equal(swipe.includes("onPointerDown"), true)
})

test("S6 r3：手机只有一个通知出口，所有页面共用；层级低于抽屉 / 菜单 / sheet，只有设置页抬到 popover", async () => {
  const phone = await read("ui/src/pi/containers/PhoneApp.tsx")
  assert.equal(phone.split("data-pi-notice-slot").length - 1, 1, "PhoneApp 只能有一个通知槽")
  assert.equal(phone.split("<NoticeContainer").length - 1, 1, "通知只在出口里渲染一次")
  assert.equal(phone.includes("notice={"), false, "嵌入的会话页不再各自带通知")
  const shell = phone.slice(phone.indexOf("function PhoneShell"), phone.indexOf("function PhoneNoticeOutlet"))
  assert.ok(shell.indexOf("<PhonePage") > 0 && shell.indexOf("<PhoneNoticeOutlet") > shell.indexOf("<PhonePage"), "出口排在页面后面")
  assert.match(phone, /page === "settings"\s*\?\s*"pointer-events-none absolute z-\(--cw-pi-z-popover\)/)
  assert.equal(phone.includes('"pointer-events-none absolute z-(--cw-pi-z-raised) flex justify-center"'), true)
  // 页面转场找页面根时跳过出口
  const nav = await read("ui/src/pi/hooks/usePiPhoneNav.ts")
  assert.equal(nav.includes('while (el?.hasAttribute("data-pi-notice-slot")) el = el.previousElementSibling'), true)
  // 搜索页不另起层，出口能盖在它上面
  const css = await read("ui/src/pi/mobile/mobile.css")
  const searchPage = css.match(/\.pm-search-page \{[^}]*\}/)?.[0] ?? ""
  assert.ok(searchPage.length > 0)
  assert.equal(searchPage.includes("z-index"), false)
})

test("S6 r3：会话页顶栏挂 data-pi-topbar（输入框浮层按它的底边算高度），产品主题的内边距被压回 8", async () => {
  const bar = await read("ui/src/pi/mobile/MobileTopBar.tsx")
  assert.equal(bar.includes('data-pi-topbar={variant === "chat" ? "phone-chat" : variant === "page" ? "phone-page" : undefined}'), true)
  assert.equal(bar.includes('variant === "chat" ? "pm-topbar-title pm-topbar-title-chat" : "pm-topbar-title"'), true, "隐私模糊只给会话标题")
  const css = await read("ui/src/pi/mobile/mobile.css")
  assert.equal(css.includes('.pi-mobile .pm-topbar[data-pi-topbar]:not([data-variant="home"]) {'), true)
})

test("S6 r3：抽屉模式也有搜索入口（抽屉头），两种模式都渲染全屏搜索页", async () => {
  const drawer = await read("ui/src/pi/mobile/MobileDrawerNav.tsx")
  assert.equal(drawer.includes("onSearch?: () => void"), true)
  assert.equal(drawer.includes('aria-label="搜索"'), true)
  const shell = await read("ui/src/pi/mobile/MobileNavShell.tsx")
  assert.equal(shell.includes("if (data.search.open) {"), true)
  assert.equal(shell.includes("actions.openSearch()"), true)
})

test("S6 r3：待答推入页手机版式（54 顶栏、两行行、清除钮 / 允许拒绝 44 触控）", async () => {
  const index = await read("ui/src/pi/mobile/index.ts")
  assert.equal(index.includes("MobileInboxPage"), true)
  const page = await read("ui/src/pi/mobile/MobileInboxPage.tsx")
  assert.equal(page.includes('<MobileTopBar variant="page" title="待答"'), true)
  assert.equal(page.includes("pm-icon-btn pm-inbox-dismiss"), true, "清除钮用视觉 36 / 触控 44 的图标钮")
  const css = await read("ui/src/pi/mobile/mobile.css")
  assert.match(css, /\.pm-inbox-btn \{\s*min-height: 44px;/)
  const phone = await read("ui/src/pi/containers/PhoneApp.tsx")
  assert.equal(phone.includes('if (page === "inbox") return <PhoneInboxPage'), true)
  assert.equal(phone.includes("<InboxContainer"), false, "手机不再嵌桌面待答页")
})

test("S6 r3：744 宽（仍走手机布局）列表、待答、搜索结果与会话列限宽 640 居中", async () => {
  const types = await read("ui/src/pi/mobile/types.ts")
  assert.equal(types.includes("columnMaxW: 640"), true)
  const css = await read("ui/src/pi/mobile/mobile.css")
  assert.equal(css.includes("--pm-column-gutter: max(0px, calc((100% - 640px) / 2));"), true)
  assert.equal(css.includes("padding: 0 var(--pm-column-gutter) calc(var(--pm-inset-bottom) + 24px);"), true, "列表滚动区")
  assert.match(css, /\.pm-session-host \[data-pi-part="transcript"\]\[data-variant="phone"\] \{[^}]*max-width: 640px;/)
})

test("S6 r3：深链「正在打开会话 / 会话不可用」先于列表 / 会话页判；「工作区」朴素行一次写多组", async () => {
  const phone = await read("ui/src/pi/containers/PhoneApp.tsx")
  const opening = phone.indexOf("if (opening && nav) {")
  assert.ok(opening > 0 && opening < phone.indexOf("return <CursorMobileShell"), "否则画的是 relay 里还开着的上一个会话")
  assert.equal(phone.includes("mobileSide.setGroupsCollapsed("), true)
  const data = await read("ui/src/pi/mobile/useMobileSidebarData.ts")
  assert.equal(data.includes("groupIds.reduce((state, groupId) => setSidebarFolderCollapsed(state, scope, groupId, collapsed), local)"), true)
})

const inboxView = await import("../ui/src/pi/model/inboxView.ts")
const MIN = 60_000
const NOW = Date.UTC(2026, 10, 13, 12, 0, 0)
const ledger = (over) => ({ key: "k", accountId: "default", roomId: "r1", deviceId: "d1", kind: "waiting", subkind: "ask", at: NOW - 3 * MIN, ...over })

test("S6 r4：待答数据规则一份（inboxViewOf）：组序、标题链、工作区 · 状态行、时间、可答 / 可清除", () => {
  const sections = inboxView.inboxViewOf({
    entries: [
      ledger({ key: "turn:r2:1", roomId: "r2", kind: "done", subkind: "turn", at: NOW - 2 * 3600_000 }),
      ledger({ key: "dialog:d9", subkind: "dialog", dialogKind: "confirm", answerable: true, title: "" }),
      ledger({ key: "ask:r3", roomId: "r3", deviceId: "d2" }),
      ledger({ key: "turn:r4:1", roomId: "r4", deviceId: "d2", kind: "error", subkind: "turn", at: 0 }),
    ],
    rooms: [{ id: "r1", cwd: "/w/pi-remote", online: true }],
    sessions: [
      { id: "r1", title: "修登录", cwd: "/w/pi-remote" },
      { id: "r2", title: "整理日志", cwd: "D:\\code\\notes\\" },
    ],
    devices: [{ id: "d2", name: "ThinkPad" }],
    now: NOW,
  })
  assert.deepEqual(sections.map((s) => `${s.kind}:${s.label}:${s.rows.length}`), ["waiting:等你回答:2", "error:出错了:1", "done:已完成未读:1"])
  const [confirm, ask] = sections[0].rows
  assert.deepEqual(
    { title: confirm.title, detail: confirm.detail, timeLabel: confirm.timeLabel, confirm: confirm.confirm, dismissible: confirm.dismissible },
    { title: "修登录", detail: "pi-remote · 等你确认", timeLabel: "3m", confirm: { dialogId: "d9", allowLabel: "允许", denyLabel: "拒绝" }, dismissible: false },
  )
  assert.equal(ask.title, "ThinkPad", "清单和房间都没有：落到设备名")
  assert.equal(ask.detail, "等你回答", "取不到目录只写状态行")
  assert.equal(ask.confirm, null, "ask 没有载荷，点行进房再答")
  const [error] = sections[1].rows
  assert.deepEqual([error.title, error.detail, error.timeLabel, error.dismissible], ["ThinkPad", "回合出错了，还没看", "", true])
  const [done] = sections[2].rows
  assert.deepEqual([done.title, done.detail, done.timeLabel, done.dismissible], ["整理日志", "notes · 回合已完成，还没看", "2h", true])
  assert.equal(done.entry.key, "turn:r2:1")
  assert.deepEqual(inboxView.inboxViewOf({ entries: [], rooms: [], sessions: [], devices: [], now: NOW }), [])
})

test("S6 r4：点待答行进房（openInboxEntry）：别的设备先切设备，已是当前房间不重选", () => {
  const calls = []
  const relay = (selectedDeviceId, roomId) => ({
    selectedDeviceId,
    roomId,
    selectDevice: (id) => calls.push(`device:${id}`),
    selectRoom: (id) => calls.push(`room:${id}`),
  })
  inboxView.openInboxEntry(relay("d1", "r0"), ledger({ deviceId: "d2", roomId: "r5" }))
  inboxView.openInboxEntry(relay("d1", "r5"), ledger({ deviceId: "d1", roomId: "r5" }))
  inboxView.openInboxEntry(relay(null, ""), ledger({ deviceId: "", roomId: "r6" }))
  assert.deepEqual(calls, ["device:d2", "room:r5", "room:r6"])
})

test("S6 r4：桌面 InboxContainer 与手机待答页都只从共享模型取数据，不各自判可答 / 可清除", async () => {
  for (const rel of ["ui/src/pi/containers/InboxContainer.tsx", "ui/src/pi/containers/PhoneApp.tsx"]) {
    const src = await read(rel)
    assert.equal(src.includes("inboxViewOf({"), true, rel)
    assert.equal(src.includes("openInboxEntry(relay, row.entry)"), true, rel)
    assert.equal(/dialogKind === "confirm"|inboxDialogIdOf|inboxDetailOf|inboxEntryTitleOf|kind === "waiting" \?/.test(src), false, `${rel} 不再自己拼规则`)
  }
  const page = await read("ui/src/pi/mobile/MobileInboxPage.tsx")
  assert.equal(page.includes("{row.confirm.denyLabel}"), true)
  assert.equal(page.includes("{row.confirm.allowLabel}"), true)
})

test("S6 r4：搜索页进历史栈（列表式 / 抽屉式同一层）：最底一层、系统返回关它、不换页；从结果进会话等哨兵退掉再压", async () => {
  const nav = await read("ui/src/pi/hooks/usePiPhoneNav.ts")
  assert.equal(nav.includes("phonePageOf({ boot, view: ui.view, pane: ui.pane, phonePage: ui.phonePage, search: null, roomId, opening: opening != null })"), true, "开搜索不退回列表")
  assert.equal(nav.includes('const layers: NavLayer[] = ui.search != null ? ["search", ...overlays] : overlays'), true)
  assert.equal(nav.includes('} else if (top === "search") act.setSearch(null)'), true)
  assert.equal(nav.includes("useMobileNavigation({ overlayCount: layers.length, closeTopOverlay })"), true)
  assert.equal(nav.includes("if (layerClosed && layers.length === 0 && historyState()?.__piMobileLayer) pushAfterSentinel(targetOf(step))"), true)
  assert.equal(nav.includes("if (historyState()?.__piMobileLayer) pushAfterSentinel(to)"), true, "推入页 forward 同一个等待")
  // 两种模式的入口都只改 ui.search，关闭（‹ / Esc / 选结果）都走 actions.closeSearch
  const phone = await read("ui/src/pi/containers/PhoneApp.tsx")
  assert.equal(phone.includes('openSearch: () => act.setSearch(""),'), true)
  assert.equal(phone.includes("closeSearch: () => act.setSearch(null),"), true)
  // 搜索页按 data.groups 筛：开着时不截行，「更多 N」里收起的会话也搜得到
  const data = await read("ui/src/pi/mobile/useMobileSidebarData.ts")
  assert.equal(data.includes("const uncapped = input.search?.open ? { maxRows: Number.POSITIVE_INFINITY } : {}"), true)
  assert.equal(data.includes("expanded: p.ui.expanded, ...uncapped })"), true)
})

test("S6 r4：深链正在打开 / 不可用时标签页标题不写上一个会话（usePageTitle 读替身，签名不变）", async () => {
  const hooks = await read("ui/src/chat/hooks.ts")
  assert.equal(hooks.includes("export function setPageTitleStandIn(text: string | null)"), true)
  assert.equal(hooks.includes("const standIn = useSyncExternalStore(subscribeTitleStandIn, readTitleStandIn)"), true)
  assert.equal(hooks.includes("? pageTitle({ room: standIn, busy: false, unseenDone: false, linkLost, waiting: waiting > 0 })"), true)
  const nav = await read("ui/src/pi/hooks/usePiPhoneNav.ts")
  assert.equal(nav.includes('const titleStandIn = opening ? (unavailable ? "会话不可用" : "正在打开会话…") : null'), true)
  assert.equal(nav.includes("useEffect(() => () => setPageTitleStandIn(null), [])"), true, "卸载时还原")
})

const phoneRoute = await import("../ui/src/pi/model/phoneRoute.ts")

test("S6 r5：桌面地址栏跟当前会话（desktopAddressOf）：换房间照手机深链格式写，没换时只纠正指着别的会话的对话地址", () => {
  const at = (search, pathname = "/", hash = "") => ({ pathname, search, hash })
  const { desktopAddressOf } = phoneRoute
  assert.equal(desktopAddressOf(at("?device=d-mbp&session=r-s1"), "r-s2", "d-mbp", true), "/?device=d-mbp&session=r-s2")
  assert.equal(desktopAddressOf(at("?token=x", "/m", "#top"), "r-s6", "d-studio", true), "/m?token=x&device=d-studio&session=r-s6#top", "其他 query、hash 原样保留")
  assert.equal(desktopAddressOf(at("?device=d-mbp&session=r-s0"), "r-s1", undefined, true), "/?session=r-s1", "本机模式没有设备")
  assert.equal(desktopAddressOf(at("?device=d-mbp&session=r-s1"), "", "d-mbp", true), "/?device=d-mbp", "房间没了 = 列表地址")
  assert.equal(desktopAddressOf(at("?device=d-mbp&session=r-s2"), "r-s2", "d-mbp", true), null, "已对上不写")
  // 刚挂上（房间没换）：列表地址不动（手机列表页放大成桌面再缩回来仍回列表），还没有房间也不动
  assert.equal(desktopAddressOf(at("?device=d-mbp"), "r-s1", "d-mbp", false), null)
  assert.equal(desktopAddressOf(at(""), "r-s1", "d-mbp", false), null)
  assert.equal(desktopAddressOf(at("?session=r-s4"), "", null, false), null)
  // 刚挂上、地址指着别的会话（旧书签 / 外面来的深链，桌面不读）或设备 id 才补齐：改成正在看的这个
  assert.equal(desktopAddressOf(at("?session=r-s4"), "r-s1", "d-mbp", false), "/?session=r-s1&device=d-mbp")
  assert.equal(desktopAddressOf(at("?session=r-s1"), "r-s1", "d-mbp", false), "/?session=r-s1&device=d-mbp")
})

test("S6 r5：桌面外壳挂 usePiAddressSync（静态态不碰 history；replaceState 带原 state，不新增历史项）", async () => {
  const hook = await read("ui/src/pi/hooks/usePiAddressSync.ts")
  assert.equal(hook.includes("if (isStatic) return"), true)
  assert.equal(hook.includes("const moved = lastRoomRef.current !== null && lastRoomRef.current !== roomId"), true, "挂上那一次不算换房间")
  assert.equal(hook.includes('if (url != null) window.history.replaceState(window.history.state, "", url)'), true)
  assert.equal(hook.includes("pushState"), false)
  const desktop = await read("ui/src/pi/containers/DesktopApp.tsx")
  assert.equal(desktop.includes('import { usePiAddressSync } from "@/pi/hooks/usePiAddressSync"'), true)
  assert.match(desktop, /const frame = usePiFrame\(\)\r?\n {2}usePiAddressSync\(relay\)\r?\n/)
})

test("S6 r5：对话页上换会话原地 replaceState（栈仍是 [列表, 对话]）；刷新留下的弹层哨兵先一条条退掉再对 URL", async () => {
  const nav = await read("ui/src/mobile/useMobileNavigation.ts")
  const open = nav.slice(nav.indexOf("const openConversation = useCallback("), nav.indexOf("const goIndex = useCallback("))
  assert.match(open, /if \(saved\.__piMobile === "conversation" && !saved\.__piMobileLayer\) \{\r?\n\s*\/\/[^\n]*\r?\n\s*window\.history\.replaceState\(\{ __piMobile: "conversation" \}, "", currentUrl\(next\)\)/)
  assert.equal(open.split("window.history.pushState(").length - 1, 1, "只有从列表进来才 push")
  const phone = await read("ui/src/pi/hooks/usePiPhoneNav.ts")
  assert.equal(phone.includes("if (drainRef.current === null && historyState()?.__piMobileLayer && layers.length === 0) {"), true)
  assert.equal(phone.includes("if (historyState()?.__piMobileLayer) window.history.back()"), true, "连着几层一条条退")
  assert.equal(phone.includes("later(finish, POP_WAIT_MS)"), true, "没等到 popstate 也照常对上")
  assert.equal(phone.includes("if (startedRef.current || drainRef.current === \"draining\") return"), true)
  const onPop = phone.slice(phone.indexOf("const onPop = (event: PopStateEvent) => {"), phone.indexOf("const next = parseMobileRoute(window.location.search)"))
  assert.equal(onPop.includes("if (!startedRef.current) return"), true, "退哨兵的 popstate 不算用户返回")
})

const sidebarSearch = await import("../ui/src/pi/model/sidebarSearch.ts")

test("S6 r5：搜索结果一份规则（sidebarSearchSessionsOf）：searchSessions 命中标题 / 目录 / 首条消息，分组区顺序，同一会话只列一次", async () => {
  const row = (key, title, cwd) => ({ key, id: key.split("::")[1], title, cwd })
  const groups = [
    { id: "pinned", kind: "pinned", label: "置顶", sessions: [row("d1::b", "键盘跳动", "/w/app")] },
    { id: "g1", kind: "workspace", label: "app", cwd: "/w/app", sessions: [row("d1::a", "登录页", "/w/app"), row("d1::b", "键盘跳动", "/w/app"), row("d1::c", "README", "/w/app")] },
    { id: "g2", kind: "workspace", label: "keyboard-lab", cwd: "/w/keyboard-lab", sessions: [row("d2::d", "实验", "/w/keyboard-lab")] },
  ]
  const first = { a: "修键盘收起时的跳动", c: "整理文档" }
  const hits = sidebarSearch.sidebarSearchSessionsOf(groups, " 键盘 ", (s) => first[s.id])
  assert.deepEqual(hits, [
    { kind: "session", id: "d1::b", label: "键盘跳动", detail: "/w/app" },
    { kind: "session", id: "d1::a", label: "登录页", detail: "app" },
  ])
  assert.deepEqual(sidebarSearch.sidebarSearchSessionsOf(groups, "KEYBOARD").map((h) => h.id), ["d2::d"], "目录命中、大小写不敏感")
  assert.deepEqual(sidebarSearch.sidebarSearchSessionsOf(groups, "  "), [])
  const data = await read("ui/src/pi/mobile/useMobileSidebarData.ts")
  assert.equal(data.includes("results: sidebarSearchSessionsOf(shownGroups, search.query, (session) => sessionOf.get(session.id)?.firstMessage)"), true)
  const page = await read("ui/src/pi/mobile/MobileSearchPage.tsx")
  assert.equal(page.includes('return results.flatMap((result) => (result.kind === "session" ? (byKey.get(result.id) ?? []) : []))'), true, "照宿主结果的顺序")
  assert.equal(page.includes("if (!results) return searchSessions(all, query)"), true)
  assert.equal(page.includes("summary ?? \"\").toLowerCase()"), false, "不再按状态行筛")
})

test("S6 r5：画廊夹具 s6-pending-past-cap：第 5 行之后的等你确认 / 出错行照样露出，其余收进「更多 6」", async () => {
  const { liveRelayOf } = await import("../ui/src/pi/dev/fixtures/derive.ts")
  const { default: fx } = await import("../ui/src/pi/dev/fixtures/live/s6-pending-past-cap.ts")
  const { sidebarGroups } = await import("../ui/src/pi/model/sidebarGroups.ts")
  const { sidebarDataOf } = await import("../ui/src/pi/model/sidebarSource.ts")
  const r = liveRelayOf(fx)
  // 两个外壳同一个入口（sidebarDataOf 带收件箱账本：别房的等你回答只从账本计）
  const base = sidebarDataOf({ devices: r.devices, rooms: r.rooms, sessionsByDevice: r.sessionsByDevice, roomId: r.roomId, dialogs: r.dialogs, uiPrompt: r.uiPrompt, turnEnd: r.turnEnd, roomTurnEnds: r.roomTurnEnds, inbox: r.inbox, selectedDevice: r.selectedDevice })
  const piRemote = sidebarGroups(base.sessions, base.devices, base.attention).groups[0]
  assert.deepEqual(piRemote.rows.map((x) => x.id), ["r-s2", "r-s3", "r-s1", "r-s4", "r-s10", "r-s20", "s12"])
  assert.deepEqual(piRemote.rows.slice(5).map((x) => x.marker), ["waiting", "error"])
  assert.equal(piRemote.more, 6)
  // 账本里没有这一条（只有 room.waiting）时不算待处理，第 6 行不露——夹具两处都得给
  const bare = sidebarDataOf({ ...r, inbox: [] })
  assert.deepEqual(sidebarGroups(bare.sessions, bare.devices, bare.attention).groups[0].rows.slice(5).map((x) => x.id), ["s12"])
})

test("S6 r5：手机外壳的字号 / 行高 / 列表行跟设置 › 外观（默认档 = 原尺寸）", async () => {
  const css = await read("ui/src/pi/mobile/mobile.css")
  assert.equal(/font-size:\s*[\d.]+px/.test(css), false, "写死的字号都加 --pm-fs")
  assert.equal(/line-height:\s*[\d.]+px/.test(css), false, "写死的行高都加 --pm-lh")
  assert.equal(css.includes("--pm-fs: var(--pm-host-font-step, 0px);"), true)
  assert.equal(css.includes("--pm-lh: var(--pm-host-lead-step, 0px);"), true)
  assert.equal(css.includes("font-size: calc(15px + var(--pm-fs));"), true)
  assert.match(css, /:root\[data-pi-density="standard"\] \.pi-mobile \{\s*--pm-density: 2px;/)
  assert.match(css, /:root\[data-pi-density="relaxed"\] \.pi-mobile \{\s*--pm-density: 4px;/)
  assert.equal(css.includes("height: calc(60px + var(--pm-density));"), true, "列表行")
  assert.equal(css.includes("height: calc(48px + var(--pm-density));"), true, "抽屉会话行")
  assert.equal(css.includes("min-height: calc(60px + var(--pm-density));"), true, "搜索 / 待答行")
  const phone = await read("ui/src/pi/containers/PhoneApp.tsx")
  assert.equal(phone.includes('"--pm-host-font-step": "calc(var(--cw-text-base, 15px) - 15px)",'), true)
  assert.equal(phone.includes('"--pm-host-lead-step": "calc(var(--cw-leading-tight, 20px) - 20px)",'), true)
  // 桥接的基准就是 pi-theme.css 的手机标准档：15 / 20（小 14 / 19，大 16 / 21）
  const theme = await read("ui/src/components/pi/shared/pi-theme.css")
  const px = (selector, name) => {
    const at = theme.indexOf(selector)
    assert.ok(at >= 0, selector)
    return Number(theme.slice(at, theme.indexOf("}", at)).match(new RegExp(`${name}: ([\\d.]+)px;`))[1])
  }
  const phoneBlock = '\n[data-pi-root][data-pi-layout="phone"] {'
  const small = ':root[data-pi-font-size="small"] [data-pi-root][data-pi-layout="phone"] {'
  const large = ':root[data-pi-font-size="large"] [data-pi-root][data-pi-layout="phone"] {'
  assert.deepEqual([px(phoneBlock, "--cw-text-base"), px(phoneBlock, "--cw-leading-tight")], [15, 20])
  assert.deepEqual([px(small, "--cw-text-base"), px(small, "--cw-leading-tight")], [14, 19])
  assert.deepEqual([px(large, "--cw-text-base"), px(large, "--cw-leading-tight")], [16, 21])
})
