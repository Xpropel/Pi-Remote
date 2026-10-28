// P6 a 线（p6-lane-a，PLAN 6.2 手机导航、6.4 首帧主题与偏好；R2/p6-lanes.md §2.5、§2.6）：
// - ui/src/pi/model/phoneRoute.ts 的纯函数（页面、弹层、路由 ↔ 界面的对应）；phonePageOf 对 P5 PhoneApp 的分支逐格比（静态态的渲染不变）；
// - ui/src/pi/model/prefs.ts 的主题规则（新键 → 旧键 pi-remote.theme 的 light / dark → 跟随系统）；
// - ui/index.html 的首帧脚本（P7 B1 前在 ui/next.html）：在 node:vm 里按各种存储 / 系统色跑，和 prefs.ts 的 piThemePrefOf + resolvePiTheme 逐条比（"同一条规则"）；
// - 几条源码契约（静态态不调导航、PiApp 用 usePiTheme、浅色 color-scheme）。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { fileURLToPath } from "node:url"
import { PI_LAYOUT_BREAKPOINT, isDesktop } from "../ui/src/shell/breakpoints.ts"
import {
  isPhonePushPage,
  PHONE_PAGE_EASING,
  phoneBaseOf,
  phoneHistoryStep,
  phoneLayersOf,
  phoneNavInit,
  phonePageDepth,
  phonePageFrames,
  phonePageOf,
  phonePageTransition,
  phonePushClosed,
  phoneRouteOf,
  phoneRouteStep,
  samePhoneRoute,
} from "../ui/src/pi/model/phoneRoute.ts"
import {
  DEFAULT_PI_PREFS,
  LEGACY_STYLE_KEY,
  LEGACY_THEME_KEY,
  migratePiPrefs,
  PI_PREFS_KEY,
  piThemePrefOf,
  resolvePiTheme,
  storedThemeOf,
} from "../ui/src/pi/model/prefs.ts"
import { parseMobileRoute } from "../ui/src/mobile/model.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")

const INDEX = { screen: "index" }
const conv = (sessionId, deviceId) => (deviceId ? { screen: "conversation", sessionId, deviceId } : { screen: "conversation", sessionId })

describe("phonePageOf：哪一页", () => {
  const pageBase = { view: "session", pane: null, phonePage: "chat", search: null, roomId: "r-s1" }

  test("P12 修复（评审总-高-5）：connecting/no-devices 冷启动也能进设置/新建；connecting 只压对话页", () => {
    for (const boot of ["connecting", "no-devices", "all-offline", "ready"]) {
      assert.equal(phonePageOf({ ...pageBase, boot, view: "new" }), "new", `${boot}: 新建不被连接状态吞掉`)
      assert.equal(phonePageOf({ ...pageBase, boot, view: "settings" }), "settings", `${boot}: 设置不被连接状态吞掉`)
    }
    // connecting/no-devices 压对话页 → 列表；ready/all-offline 有会话时是对话页
    assert.equal(phonePageOf({ ...pageBase, boot: "connecting" }), "list")
    assert.equal(phonePageOf({ ...pageBase, boot: "no-devices" }), "list")
    assert.equal(phonePageOf({ ...pageBase, boot: "all-offline" }), "chat")
    assert.equal(phonePageOf({ ...pageBase, boot: "ready" }), "chat")
    // 推入页优先于搜索/无 roomId/pane；connecting 下 pane 跟着对话页一起被压回列表
    assert.equal(phonePageOf({ ...pageBase, boot: "connecting", view: "settings", search: "q" }), "settings")
    assert.equal(phonePageOf({ ...pageBase, boot: "connecting", view: "new", roomId: "" }), "new")
    assert.equal(phonePageOf({ ...pageBase, boot: "ready", pane: "changes" }), "pane")
    assert.equal(phonePageOf({ ...pageBase, boot: "connecting", pane: "changes" }), "list")
  })

  test("连接状态 × 视图矩阵：只有 settings/new 与连接状态无关，其余分支保持原语义", () => {
    const expected = (i) => {
      if (i.view === "new") return "new"
      if (i.view === "settings") return "settings"
      if (i.boot !== "connecting" && !i.opening && i.pane && i.roomId && i.phonePage === "chat") return "pane"
      if (i.opening) return "chat"
      return i.boot === "connecting" || i.boot === "no-devices" || !i.roomId || i.phonePage === "list" || i.search != null ? "list" : "chat"
    }
    let n = 0
    for (const boot of ["connecting", "no-devices", "all-offline", "ready"])
      for (const view of ["session", "new", "settings"])
        for (const pane of [null, "changes"])
          for (const phonePage of ["list", "chat"])
            for (const search of [null, "", "键盘"])
              for (const roomId of ["", "r-s1"]) {
                const input = { boot, view, pane, phonePage, search, roomId }
                assert.equal(phonePageOf(input), expected(input), JSON.stringify(input))
                n++
              }
    assert.equal(n, 288)
  })

  test("在找深链的会话时是对话页（连接中、没有 roomId、pane 记着也一样）；新会话 / 设置照样优先", () => {
    const base = { boot: "ready", view: "session", pane: null, phonePage: "list", search: null, roomId: "", opening: true }
    assert.equal(phonePageOf(base), "chat")
    assert.equal(phonePageOf({ ...base, boot: "connecting" }), "chat")
    assert.equal(phonePageOf({ ...base, pane: "changes", phonePage: "chat", roomId: "r-s1" }), "chat")
    assert.equal(phonePageOf({ ...base, view: "new" }), "new")
    assert.equal(phonePageOf({ ...base, view: "settings" }), "settings")
  })

  test("767/768 边界（P11 断点）：≤767 手机壳才走 phonePageOf；≥768 桌面壳", () => {
    assert.equal(PI_LAYOUT_BREAKPOINT, 768)
    assert.equal(isDesktop(767), false, "767 仍是移动端")
    assert.equal(isDesktop(768), true, "768 起桌面端")
    // 手机壳路由逻辑本身与宽度无关：设置/新建在 767 下必须能打开（connecting 也一样）
    assert.equal(phonePageOf({ boot: "connecting", view: "settings", pane: null, phonePage: "chat", search: null, roomId: "r-s1" }), "settings")
    assert.equal(phonePageOf({ boot: "connecting", view: "new", pane: null, phonePage: "list", search: null, roomId: "" }), "new")
  })

  test("推入页、深度、转场方向", () => {
    assert.deepEqual(["list", "chat", "new", "settings", "pane"].filter(isPhonePushPage), ["new", "settings", "pane"])
    assert.deepEqual(["list", "chat", "new", "settings", "pane"].map(phonePageDepth), [0, 1, 2, 2, 2])
    assert.equal(phonePageTransition(null, "chat"), null, "第一次进来不放")
    assert.equal(phonePageTransition("chat", "chat"), null)
    assert.equal(phonePageTransition("list", "chat"), "forward")
    assert.equal(phonePageTransition("chat", "pane"), "forward")
    assert.equal(phonePageTransition("list", "settings"), "forward")
    assert.equal(phonePageTransition("chat", "list"), "back")
    assert.equal(phonePageTransition("new", "list"), "back")
    assert.equal(phonePageTransition("pane", "chat"), "back")
  })

  test("转场关键帧和缓动照旧手机壳 mobile.css（240ms、cubic-bezier(0.32, 0.72, 0, 1)、推入从 100%、返回从 −24%）", () => {
    assert.equal(PHONE_PAGE_EASING, "cubic-bezier(0.32, 0.72, 0, 1)")
    assert.deepEqual(phonePageFrames("forward"), [
      { transform: "translateX(100%)", opacity: 0.82 },
      { transform: "translateX(0)", opacity: 1 },
    ])
    assert.equal(phonePageFrames("back")[0].transform, "translateX(-24%)")
    assert.equal(phonePageFrames("back").at(-1).transform, "translateX(0)")
  })
})

describe("弹层与推入页", () => {
  test("历史里的弹层从下到上：推入页 → 命令面板 → sheet（系统返回先关 sheet）", () => {
    assert.deepEqual(phoneLayersOf({ page: "chat", paletteOpen: false, sheet: false }), [])
    assert.deepEqual(phoneLayersOf({ page: "chat", paletteOpen: false, sheet: true }), ["sheet"])
    assert.deepEqual(phoneLayersOf({ page: "settings", paletteOpen: true, sheet: true }), ["push", "palette", "sheet"])
    assert.deepEqual(phoneLayersOf({ page: "pane", paletteOpen: false, sheet: false }), ["push"])
    assert.deepEqual(phoneLayersOf({ page: "list", paletteOpen: true, sheet: false }), ["palette"])
  })

  test("推入页下面那一页：界面在对话页且有会话时是对话页，否则列表页", () => {
    assert.equal(phoneBaseOf({ boot: "ready", phonePage: "chat", roomId: "r-s1" }), "chat")
    assert.equal(phoneBaseOf({ boot: "ready", phonePage: "chat", roomId: "" }), "list")
    assert.equal(phoneBaseOf({ boot: "ready", phonePage: "list", roomId: "r-s1" }), "list")
    assert.equal(phoneBaseOf({ boot: "connecting", phonePage: "chat", roomId: "r-s1" }), "list")
    assert.equal(phoneBaseOf({ boot: "no-devices", phonePage: "chat", roomId: "r-s1" }), "list")
    assert.equal(phoneBaseOf({ boot: "all-offline", phonePage: "chat", roomId: "r-s1" }), "chat")
  })

  test("推入页被界面关上：新会话起好了进它的对话页；下面原来是列表页就回列表页；其余不动", () => {
    // 列表页 → 新会话（newSession 把 phonePage 设成 chat）→ ‹（act.openSession，会话没换）→ 回列表页
    assert.deepEqual(phonePushClosed({ base: "list", roomAtOpen: "", roomId: "", phonePage: "chat" }), { kind: "list" })
    assert.deepEqual(phonePushClosed({ base: "list", roomAtOpen: "r-s1", roomId: "r-s1", phonePage: "chat" }), { kind: "list" })
    // 新会话发出第一条：会话换成新房间 → 进对话页
    assert.deepEqual(phonePushClosed({ base: "list", roomAtOpen: "r-s1", roomId: "r-new", phonePage: "chat" }), { kind: "forward", sessionId: "r-new" })
    assert.deepEqual(phonePushClosed({ base: "chat", roomAtOpen: "", roomId: "r-new", phonePage: "chat" }), { kind: "forward", sessionId: "r-new" })
    // 对话页 → 改动 / 设置 → ‹：还是对话页
    assert.deepEqual(phonePushClosed({ base: "chat", roomAtOpen: "r-s1", roomId: "r-s1", phonePage: "chat" }), { kind: "none" })
    // 列表页 → 设置 → ‹ 之前已经回到列表（phonePage list）
    assert.deepEqual(phonePushClosed({ base: "list", roomAtOpen: "r-s1", roomId: "r-s1", phonePage: "list" }), { kind: "none" })
  })
})

describe("路由 ↔ 界面", () => {
  test("phoneRouteOf / samePhoneRoute：对话页 = 当前会话；比较时设备 id 不算", () => {
    assert.deepEqual(phoneRouteOf("chat", "r-s1", "d-mbp"), conv("r-s1", "d-mbp"))
    assert.deepEqual(phoneRouteOf("chat", "r-s1", null), conv("r-s1"))
    assert.deepEqual(phoneRouteOf("chat", "", "d-mbp"), INDEX)
    assert.deepEqual(phoneRouteOf("list", "r-s1", "d-mbp"), INDEX)
    assert.ok(samePhoneRoute(conv("r-s1", "d-mbp"), conv("r-s1")))
    assert.ok(samePhoneRoute(INDEX, { screen: "index", deviceId: "d-mbp" }))
    assert.ok(!samePhoneRoute(conv("r-s1"), conv("r-s2")))
    assert.ok(!samePhoneRoute(conv("r-s1"), INDEX))
  })

  test("phoneNavInit：第一次渲染时 URL 和界面怎么对上", () => {
    // 产品冷启动：URL 是列表、relay 还没接上会话 → 钉在列表页
    assert.deepEqual(phoneNavInit({ route: INDEX, ownConversation: false, base: "list", roomId: "" }), { kind: "list" })
    assert.deepEqual(phoneNavInit({ route: INDEX, ownConversation: false, base: "list", roomId: "r-s1" }), { kind: "list" })
    // 开发路由的起始状态 / 桌面切到手机：界面已经在对话页 → 改写当前项（不留状态，让 useMobileNavigation 建 [列表, 对话]）
    assert.deepEqual(phoneNavInit({ route: INDEX, ownConversation: false, base: "chat", roomId: "r-s1", deviceId: "d-mbp" }), {
      kind: "rewrite",
      route: conv("r-s1", "d-mbp"),
      keepState: false,
    })
    // 深链（外面来的）：去找
    assert.deepEqual(phoneNavInit({ route: conv("r-s4", "d-mbp"), ownConversation: false, base: "chat", roomId: "r-s1" }), { kind: "open", sessionId: "r-s4", deviceId: "d-mbp" })
    assert.deepEqual(phoneNavInit({ route: conv("r-s4"), ownConversation: false, base: "list", roomId: "" }), { kind: "open", sessionId: "r-s4" })
    // 自己写的对话项、界面已经换到别的会话（平板横屏时在桌面外壳换过）→ 以界面为准，改写 URL、保留状态
    assert.deepEqual(phoneNavInit({ route: conv("r-s4"), ownConversation: true, base: "chat", roomId: "r-s1" }), { kind: "rewrite", route: conv("r-s1"), keepState: true })
    // 自己写的对话项、刷新后 relay 还没接上（roomId 空）→ 去找
    assert.deepEqual(phoneNavInit({ route: conv("r-s4"), ownConversation: true, base: "list", roomId: "" }), { kind: "open", sessionId: "r-s4" })
    assert.deepEqual(phoneNavInit({ route: conv("r-s1"), ownConversation: true, base: "chat", roomId: "r-s1" }), { kind: "open", sessionId: "r-s1" })
  })

  test("phoneRouteStep：用户按了系统返回 / 前进", () => {
    assert.deepEqual(phoneRouteStep(INDEX, "chat", "r-s1"), { kind: "list" })
    assert.deepEqual(phoneRouteStep(INDEX, "list", "r-s1"), { kind: "none" })
    assert.deepEqual(phoneRouteStep(conv("r-s1"), "list", "r-s1"), { kind: "chat" })
    assert.deepEqual(phoneRouteStep(conv("r-s1"), "chat", "r-s1"), { kind: "none" })
    assert.deepEqual(phoneRouteStep(conv("r-s2", "d-tp"), "list", "r-s1"), { kind: "open", sessionId: "r-s2", deviceId: "d-tp" })
  })

  test("phoneHistoryStep：界面换了页 / 换了会话", () => {
    assert.deepEqual(phoneHistoryStep(INDEX, conv("r-s1", "d-mbp")), { kind: "push", sessionId: "r-s1", deviceId: "d-mbp" })
    assert.deepEqual(phoneHistoryStep(conv("r-s1"), INDEX), { kind: "back" })
    assert.deepEqual(phoneHistoryStep(conv("r-s1"), conv("r-s2")), { kind: "push", sessionId: "r-s2" })
    assert.deepEqual(phoneHistoryStep(conv("r-s1", "d-mbp"), conv("r-s1")), { kind: "none" }, "同一个会话不再压")
    assert.deepEqual(phoneHistoryStep(INDEX, INDEX), { kind: "none" })
  })

  test("URL 口径沿用 mobile/model.ts：?device=&session=", () => {
    assert.deepEqual(parseMobileRoute("?device=d-mbp&session=r-s1"), conv("r-s1", "d-mbp"))
    assert.deepEqual(parseMobileRoute("?session=nope"), conv("nope"))
    assert.deepEqual(parseMobileRoute(""), INDEX)
  })
})

describe("主题偏好规则（prefs.ts）", () => {
  test("键名：新键 pi_remote_pi_prefs（三值），旧键 pi-remote.theme 只作迁移来源", () => {
    assert.equal(PI_PREFS_KEY, "pi_remote_pi_prefs")
    assert.equal(LEGACY_THEME_KEY, "pi-remote.theme")
    assert.equal(DEFAULT_PI_PREFS.theme, "system")
  })

  test("storedThemeOf：新键里合法的 theme（JSON 字符串或对象），否则 null", () => {
    assert.equal(storedThemeOf('{"v":1,"theme":"dark"}'), "dark")
    assert.equal(storedThemeOf({ theme: "light" }), "light")
    assert.equal(storedThemeOf('{"theme":"system"}'), "system")
    for (const bad of [null, undefined, "", "not json", "[]", '{"theme":"blue"}', '{"v":1}', 42, '"dark"']) assert.equal(storedThemeOf(bad), null, String(bad))
  })

  test("piThemePrefOf：新键优先；没有合法 theme 时取旧键的 light / dark；都没有 = system", () => {
    assert.equal(piThemePrefOf('{"theme":"light"}', "dark"), "light")
    assert.equal(piThemePrefOf('{"theme":"system"}', "dark"), "system", "新键选了跟随系统就是跟随系统")
    assert.equal(piThemePrefOf(null, "dark"), "dark")
    assert.equal(piThemePrefOf('{"v":1}', "light"), "light")
    assert.equal(piThemePrefOf("not json", "dark"), "dark")
    assert.equal(piThemePrefOf(null, "system"), "system", "旧键只有 light / dark")
    assert.equal(piThemePrefOf(null, null), "system")
    assert.equal(piThemePrefOf(null), "system")
  })

  test("resolvePiTheme", () => {
    assert.equal(resolvePiTheme("system", true), "dark")
    assert.equal(resolvePiTheme("system", false), "light")
    assert.equal(resolvePiTheme("light", true), "light")
    assert.equal(resolvePiTheme("dark", false), "dark")
  })

  test("migratePiPrefs：不传旧主题时和 P5 一样；传了按同一条规则搬，别的字段（含 pi_remote_style 的两个开关）不受影响", () => {
    assert.equal(migratePiPrefs(null).theme, "system")
    assert.equal(migratePiPrefs('{"theme":"dark"}').theme, "dark")
    assert.equal(migratePiPrefs(null, null, "dark").theme, "dark")
    assert.equal(migratePiPrefs('{"v":1,"density":"compact"}', null, "light").theme, "light")
    assert.equal(migratePiPrefs('{"theme":"system"}', null, "dark").theme, "system")
    const legacy = JSON.stringify({ completionSound: true, dialogRemoteAnswer: true, theme: "dark" })
    assert.deepEqual(migratePiPrefs(null, legacy, "dark"), { ...DEFAULT_PI_PREFS, theme: "dark", completionSound: true, dialogRemoteAnswer: true })
    assert.deepEqual(migratePiPrefs(null, legacy), { ...DEFAULT_PI_PREFS, completionSound: true, dialogRemoteAnswer: true }, "旧样式键里的 theme 不搬")
    assert.equal(LEGACY_STYLE_KEY, "pi_remote_style")
  })
})

describe("ui/index.html 的首帧脚本（P7 B1 起新界面入口）", () => {
  const html = read("ui/index.html")
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  const SCRIPT = scripts.find((s) => s.includes("pi_remote_pi_prefs"))

  /** 在一个最小的假 DOM 里跑首帧脚本 */
  function run({ stored = null, legacy = null, dark = false, throwing = false, noMatchMedia = false, uiReady = false } = {}) {
    const store = new Map()
    if (stored != null) store.set(PI_PREFS_KEY, stored)
    if (legacy != null) store.set(LEGACY_THEME_KEY, legacy)
    const writes = []
    const attrs = {}
    const style = {}
    const meta = (own) => {
      const a = { name: "theme-color", media: `(prefers-color-scheme: ${own})`, "data-pi-theme-color": own }
      return { a, getAttribute: (k) => a[k] ?? null, setAttribute: (k, v) => (a[k] = String(v)) }
    }
    const metas = [meta("light"), meta("dark")]
    const mqListeners = []
    const winListeners = {}
    const mql = { matches: dark, addEventListener: (_type, fn) => mqListeners.push(fn) }
    const window = {
      /** React 是否已接管（PI-UI-REFS Lead 裁决 Q2）：接管后首帧脚本不再写 data-pi-ui / 临时底色 */
      __PI_UI_READY__: uiReady,
      localStorage: {
        getItem: (k) => {
          if (throwing) throw new Error("denied")
          return store.has(k) ? store.get(k) : null
        },
        setItem: (k, v) => writes.push([k, v]),
        removeItem: (k) => writes.push([k, null]),
      },
      matchMedia: noMatchMedia ? undefined : () => mql,
      addEventListener: (type, fn) => (winListeners[type] ??= []).push(fn),
    }
    const document = {
      documentElement: { setAttribute: (k, v) => (attrs[k] = String(v)), getAttribute: (k) => attrs[k] ?? null, style },
      querySelectorAll: (sel) => (sel === 'meta[name="theme-color"][data-pi-theme-color]' ? metas : []),
    }
    vm.runInNewContext(SCRIPT, { window, document })
    return {
      attrs,
      style,
      media: () => metas.map((m) => m.a.media),
      writes,
      system(next) {
        mql.matches = next
        for (const fn of mqListeners) fn()
      },
      storage(key, value) {
        if (value == null) store.delete(key)
        else store.set(key, value)
        for (const fn of winListeners.storage ?? []) fn({ key })
      },
    }
  }

  test("只有一段内联脚本含新键，放在两个 theme-color 之后、模块脚本之前（先于样式和 React）", () => {
    assert.ok(SCRIPT, "没找到首帧脚本")
    const at = html.indexOf(SCRIPT)
    assert.ok(at > html.lastIndexOf('<meta name="theme-color"'), "脚本要在 theme-color 之后（它改这两个 meta）")
    assert.ok(at < html.indexOf('type="module"'), "脚本要在模块脚本之前")
    assert.ok(at < html.indexOf("</head>"))
  })

  test("和 prefs.ts 同一条规则：存储 × 旧键 × 系统色 逐条比（data-pi-theme、style.colorScheme）", () => {
    const storedCases = [null, '{"theme":"dark"}', '{"theme":"light"}', '{"theme":"system"}', '{"theme":"bogus"}', '{"v":1}', "not json", "[]", JSON.stringify('{"theme":"dark"}')]
    const legacyCases = [null, "light", "dark", "system", "bogus"]
    let n = 0
    for (const stored of storedCases)
      for (const legacy of legacyCases)
        for (const dark of [false, true]) {
          const want = resolvePiTheme(piThemePrefOf(stored, legacy), dark)
          const got = run({ stored, legacy, dark })
          const label = JSON.stringify({ stored, legacy, dark })
          assert.equal(got.attrs["data-pi-theme"], want, label)
          assert.equal(got.style.colorScheme, want, label)
          assert.deepEqual(got.writes, [], "首帧脚本不写存储（旧键只读）")
          n++
        }
    assert.equal(n, 90)
  })

  test("theme-color：跟随系统时照 media；固定主题时只留和主题一致的那一份生效", () => {
    assert.deepEqual(run({ dark: true }).media(), ["(prefers-color-scheme: light)", "(prefers-color-scheme: dark)"])
    assert.deepEqual(run({ stored: '{"theme":"dark"}', dark: false }).media(), ["not all", "all"])
    assert.deepEqual(run({ legacy: "light", dark: true }).media(), ["all", "not all"])
  })

  /* PI-UI-REFS（Lead 裁决 Q2，2026-10-26）：首帧按偏好预写 data-pi-ui + 变体 S0 底色，避免先闪 cursor。
   * 取值规则和 prefs.ts 的 piUiVariantOf 一致；S0 值来自 design-spec §1.2 表 1-A / §2.2 / §7 对照表。 */
  test("data-pi-ui：按偏好预写 cursor / claude / codex，缺失 / 非法一律回退 cursor，不写存储", () => {
    assert.equal(run({}).attrs["data-pi-ui"], "cursor")
    assert.equal(run({ stored: '{"v":1}' }).attrs["data-pi-ui"], "cursor")
    assert.equal(run({ stored: '{"theme":"dark"}' }).attrs["data-pi-ui"], "cursor")
    assert.equal(run({ stored: '{"ui":"claude"}' }).attrs["data-pi-ui"], "claude")
    assert.equal(run({ stored: '{"v":1,"ui":"claude"}' }).attrs["data-pi-ui"], "claude")
    assert.equal(run({ stored: '{"v":1,"ui":"codex"}' }).attrs["data-pi-ui"], "codex")
    assert.equal(run({ stored: JSON.stringify('{"ui":"codex"}') }).attrs["data-pi-ui"], "codex", "多层 JSON 字符串按同一套解析规则")
    for (const bad of ['{"ui":"bogus"}', '{"ui":"CURSOR"}', '{"ui":1}', '{"ui":null}', "not json", "[]"])
      assert.equal(run({ stored: bad }).attrs["data-pi-ui"], "cursor", bad)
    assert.equal(run({ throwing: true }).attrs["data-pi-ui"], "cursor")
    assert.deepEqual(run({ stored: '{"v":1,"ui":"claude"}' }).writes, [], "首帧脚本仍不写存储")
  })

  test("首帧不闪 cursor：claude / codex 预写 design-spec 的 S0 底色（浅 / 深两档），cursor 不写", () => {
    assert.equal(run({}).style.backgroundColor, "", "cursor 不写底色（现有 tokens.css 管）")
    assert.equal(run({ stored: '{"v":1,"ui":"claude"}', dark: false }).style.backgroundColor, "#f9f9f7")
    assert.equal(run({ stored: '{"v":1,"ui":"claude"}', dark: true }).style.backgroundColor, "#0b0b0b")
    assert.equal(run({ stored: '{"v":1,"ui":"codex"}', dark: false }).style.backgroundColor, "#ececec")
    assert.equal(run({ stored: '{"v":1,"ui":"codex"}', dark: true }).style.backgroundColor, "#0d0d0d")
    // 固定主题按偏好选底色，不按系统色
    assert.equal(run({ stored: '{"v":1,"ui":"claude","theme":"light"}', dark: true }).style.backgroundColor, "#f9f9f7")
    assert.equal(run({ stored: '{"v":1,"ui":"codex","theme":"dark"}', dark: false }).style.backgroundColor, "#0d0d0d")
    // 跟随系统时系统色变了跟着变
    const codex = run({ stored: '{"v":1,"ui":"codex"}' })
    assert.equal(codex.style.backgroundColor, "#ececec")
    codex.system(true)
    assert.equal(codex.style.backgroundColor, "#0d0d0d")
    // 别的标签页改了偏好：data-pi-ui 与底色跟着变
    const page = run({})
    page.storage(PI_PREFS_KEY, '{"v":1,"ui":"claude"}')
    assert.equal(page.attrs["data-pi-ui"], "claude")
    assert.equal(page.style.backgroundColor, "#f9f9f7")
    page.storage(PI_PREFS_KEY, '{"v":1,"ui":"cursor"}')
    assert.equal(page.attrs["data-pi-ui"], "cursor")
    assert.equal(page.style.backgroundColor, "")
  })

  test("React 接管后（__PI_UI_READY__）首帧脚本不再写 data-pi-ui / 临时底色，以偏好为准", () => {
    const booted = run({ stored: '{"v":1,"ui":"claude"}', uiReady: true })
    assert.equal(booted.attrs["data-pi-ui"], undefined)
    assert.equal(booted.style.backgroundColor, undefined)
    assert.equal(booted.attrs["data-pi-theme"], "light", "主题仍由首帧脚本先写（React 起来前防闪）")
  })

  test("跟随系统时听 matchMedia；固定主题时系统色变了不动", () => {
    const sys = run({ dark: false })
    assert.equal(sys.attrs["data-pi-theme"], "light")
    sys.system(true)
    assert.equal(sys.attrs["data-pi-theme"], "dark")
    assert.equal(sys.style.colorScheme, "dark")
    const fixed = run({ stored: '{"theme":"light"}', dark: false })
    fixed.system(true)
    assert.equal(fixed.attrs["data-pi-theme"], "light")
  })

  test("别的标签页改了偏好（storage 事件）跟着变", () => {
    const page = run({ dark: false })
    page.storage(PI_PREFS_KEY, '{"v":1,"theme":"dark"}')
    assert.equal(page.attrs["data-pi-theme"], "dark")
    page.storage(PI_PREFS_KEY, '{"v":1,"theme":"system"}')
    assert.equal(page.attrs["data-pi-theme"], "light")
    page.storage("unrelated", "x")
    assert.equal(page.attrs["data-pi-theme"], "light")
  })

  test("存储读不了、没有 matchMedia：跟随系统按浅色，不抛错", () => {
    assert.equal(run({ throwing: true, dark: true }).attrs["data-pi-theme"], "dark")
    assert.equal(run({ noMatchMedia: true, stored: '{"theme":"system"}' }).attrs["data-pi-theme"], "light")
    assert.equal(run({ noMatchMedia: true, stored: '{"theme":"dark"}' }).attrs["data-pi-theme"], "dark")
  })

  test("meta：color-scheme light dark；theme-color 浅 / 深各一份（带 media、data-pi-theme-color）；viewport 保持 cover、resizes-content、不禁缩放", () => {
    assert.match(html, /<meta name="color-scheme" content="light dark" \/>/)
    const colors = [...html.matchAll(/<meta name="theme-color"([^>]*)\/>/g)].map((m) => m[1])
    assert.equal(colors.length, 2)
    assert.match(colors[0], /media="\(prefers-color-scheme: light\)" content="#F7F7F7" data-pi-theme-color="light"/)
    assert.match(colors[1], /media="\(prefers-color-scheme: dark\)" content="#161617" data-pi-theme-color="dark"/)
    const viewport = html.match(/<meta name="viewport" content="([^"]*)"/)?.[1] ?? ""
    assert.match(viewport, /viewport-fit=cover/)
    assert.match(viewport, /interactive-widget=resizes-content/)
    assert.doesNotMatch(viewport, /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/)
  })

  test("不写 data-theme、不加 style-nova（只认 data-pi-theme；注释不算）", () => {
    const code = SCRIPT.replace(/\/\*[\s\S]*?\*\//g, "")
    assert.doesNotMatch(code, /"data-theme"|style-nova|classList/)
    assert.match(code, /setAttribute\("data-pi-theme", theme\)/)
  })
})

describe("源码契约", () => {
  test("PhoneApp：静态态（画廊、#/live 对图）不调导航；可交互时 usePiPhoneNav（内部 useMobileNavigation / parseMobileRoute，只 import）", () => {
    const app = read("ui/src/pi/containers/PhoneApp.tsx")
    assert.match(app, /usePiStatic\(\) \? <PhoneShell \{\.\.\.props\} \/> : <PhoneNavShell \{\.\.\.props\} \/>/)
    assert.match(app, /usePiPhoneNav\(props,/)
    const nav = read("ui/src/pi/hooks/usePiPhoneNav.ts")
    assert.match(nav, /from "@\/mobile\/useMobileNavigation"/)
    assert.match(nav, /parseMobileRoute/)
    assert.match(nav, /usePiMotion\(\)/)
  })

  test("PiApp：主题用 usePiTheme(prefs.theme)，不再从 <html> 反读（MutationObserver 那套删了）", () => {
    const app = read("ui/src/pi/PiApp.tsx")
    assert.match(app, /usePiTheme\(ui\.prefs\.theme, act\)/)
    assert.doesNotMatch(app, /subscribeTheme|readTheme|MutationObserver/)
  })

  test("pi-theme.css：浅色 color-scheme 一条单独的规则，原来的浅色块开头不动（design-tokens 测试按它切块）", () => {
    const css = read("ui/src/components/pi/shared/pi-theme.css")
    assert.match(css, /:root:root\[data-pi-theme="light"\] \{\s*color-scheme: light;\s*\}/)
    assert.ok(css.indexOf(":root:root[data-pi-theme],") < css.indexOf(':root:root[data-pi-theme="light"]'))
    assert.ok(css.indexOf(':root:root[data-pi-theme="light"]') < css.indexOf(':root:root[data-pi-theme="dark"],'))
  })
})
