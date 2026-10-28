// 第 3 章移动端 P0：断点/尺寸/路由/状态文案的纯逻辑 + 源码契约。
// 纯 Node 测试，不启动浏览器；model.ts 不依赖 React / DOM。
// P7 B2b（决定 17）：旧手机壳（mobile/*.tsx、mobile.css、App.tsx、pages/*）删了，读它们源码的用例删掉；
// mobile/{model,useMobileNavigation,useMobileViewport}.ts 和 deviceStripModel 的行为用例照旧；
// 手机尺寸 / 安全区 / 100dvh / 16px 输入改读新界面（pi-theme.css、PiFollowUpComposer、phoneRoute），手机导航的行为在 test/pi-p6-a.test.mjs。
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { sortDevicesForStrip } from "../ui/src/chat/deviceStripModel.ts"
import {
  MOBILE_SHELL_MAX,
  PHONE_MAX,
  contentMaxWidth,
  deviceBarHeight,
  deviceContextText,
  deviceSessionCount,
  isCompactHeight,
  isMobileShellWidth,
  isPhoneWidth,
  isShortHeight,
  mobileMetaText,
  mobileRouteUrl,
  mobileSessionTime,
  mobileStatusText,
  mobileStatusTone,
  pagePadding,
  parseMobileRoute,
  routeIsConversation,
  sessionRowHeight,
  sheetMiddleHeight,
  topBarHeight,
} from "../ui/src/mobile/model.ts"

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
const viewport = source("../ui/src/mobile/useMobileViewport.ts")
const indexHtml = source("../ui/index.html")
const pkg = JSON.parse(source("../package.json"))

test("断点：桌面壳从 1024 开始；<768 是手机，768–1023 仍归移动壳", () => {
  assert.equal(MOBILE_SHELL_MAX, 1023)
  assert.equal(PHONE_MAX, 767)
  assert.equal(isMobileShellWidth(1023), true)
  assert.equal(isMobileShellWidth(1024), false)
  assert.equal(isPhoneWidth(767), true)
  assert.equal(isPhoneWidth(768), false)
})

test("页面边距四档：320–359:12 / 360–430:16 / 431–600:20 / 601+:24", () => {
  assert.equal(pagePadding(320), 12)
  assert.equal(pagePadding(359), 12)
  assert.equal(pagePadding(360), 16)
  assert.equal(pagePadding(390), 16)
  assert.equal(pagePadding(430), 16)
  assert.equal(pagePadding(431), 20)
  assert.equal(pagePadding(600), 20)
  assert.equal(pagePadding(601), 24)
  assert.equal(pagePadding(844), 24)
})

test("尺寸：顶栏 52、设备栏 48、会话行 52（布局 V2 不再随短高度降档）", () => {
  assert.equal(topBarHeight(844), 52)
  assert.equal(topBarHeight(620), 52)
  assert.equal(topBarHeight(480), 52)
  assert.equal(deviceBarHeight(844), 48)
  assert.equal(deviceBarHeight(620), 48)
  assert.equal(deviceBarHeight(480), 48)
  assert.equal(sessionRowHeight(844), 52)
  assert.equal(sessionRowHeight(620), 52)
  assert.equal(sessionRowHeight(480), 52)
  assert.equal(isCompactHeight(620), true)
  assert.equal(isCompactHeight(621), false)
  assert.equal(isShortHeight(480), true)
  assert.equal(isShortHeight(481), false)
  assert.equal(contentMaxWidth(844), 720)
  assert.equal(contentMaxWidth(390), 760)
  assert.equal(sheetMiddleHeight(560), 0.56)
  assert.equal(sheetMiddleHeight(500), 0.64)
})

test("路由解析：缺 session 是列表；device/session 可同时存在；空值不生效", () => {
  assert.deepEqual(parseMobileRoute(""), { screen: "index" })
  assert.deepEqual(parseMobileRoute("?device=studio-mac"), { screen: "index", deviceId: "studio-mac" })
  assert.deepEqual(parseMobileRoute("?session=s2"), { screen: "conversation", sessionId: "s2" })
  assert.deepEqual(parseMobileRoute("?device=studio-mac&session=s2"), { screen: "conversation", sessionId: "s2", deviceId: "studio-mac" })
  assert.deepEqual(parseMobileRoute("?session=%20%20&device="), { screen: "index" })
  assert.equal(routeIsConversation(parseMobileRoute("?session=s2")), true)
  assert.equal(routeIsConversation(parseMobileRoute("?device=d1")), false)
})

test("路由 URL：保留未知 query/hash，列表删 session，对话写 device+session", () => {
  assert.equal(
    mobileRouteUrl("/m", "?skin=codex&session=old&keep=1", "", { screen: "index", deviceId: "d1" }),
    "/m?skin=codex&keep=1&device=d1",
  )
  assert.equal(
    mobileRouteUrl("/m", "?skin=codex&device=old", "#thread", { screen: "conversation", sessionId: "s2", deviceId: "d1" }),
    "/m?skin=codex&device=d1&session=s2#thread",
  )
  assert.equal(mobileRouteUrl("/b/m", "", "", { screen: "index" }), "/b/m")
})

test("SessionMeta 只允许 5 种状态：已连接/正在连接/已断开/正在输出/等待设备上线", () => {
  const allowed = new Set(["已连接", "正在连接", "已断开", "正在输出", "等待设备上线"])
  const cases = [
    [{ online: true, everConnected: true, busy: false }, "已连接"],
    [{ online: false, everConnected: false, busy: false }, "正在连接"],
    [{ online: false, everConnected: true, busy: false }, "已断开"],
    [{ online: true, everConnected: true, busy: true }, "正在输出"],
    [{ online: true, everConnected: true, busy: false, hasDevice: true, deviceOnline: false }, "等待设备上线"],
    [{ online: true, everConnected: true, busy: true, roomDown: true }, "已断开"],
  ]
  for (const [input, expected] of cases) {
    const text = mobileStatusText(input)
    assert.equal(text, expected)
    assert.equal(allowed.has(text), true, `${text} 不在规范允许的 5 种状态里`)
  }
  assert.equal(mobileStatusTone("已连接"), "ok")
  assert.equal(mobileStatusTone("正在输出"), "ok")
  assert.equal(mobileStatusTone("正在连接"), "warn")
  assert.equal(mobileStatusTone("已断开"), "bad")
  assert.equal(mobileMetaText("Studio Mac", "已连接"), "Studio Mac · 已连接")
  assert.equal(mobileMetaText("", "正在连接"), "本机 · 正在连接")
})

test("设备切换排序：在线优先、首次连接从早到晚；当前设备只勾选不置顶，点击不重排", () => {
  const devices = [
    { id: "a", name: "A", online: true, firstSeenAt: 1, lastAttachAt: 900 },
    { id: "b", name: "B", online: false, firstSeenAt: 2, lastAttachAt: 800 },
    { id: "c", name: "C", online: true, firstSeenAt: 5, lastAttachAt: 500 },
    { id: "d", name: "D", online: true, firstSeenAt: 50, lastAttachAt: 100 },
  ]
  assert.deepEqual(sortDevicesForStrip(devices).map((row) => row.id), ["a", "c", "d", "b"], "在线在前，同组按首次连接升序")
  assert.equal(sortDevicesForStrip.length, 1, "排序不接收 selectedId：点击只改勾选，不可能触发重排")
  assert.deepEqual(sortDevicesForStrip(devices).map((row) => row.id), ["a", "c", "d", "b"], "重复排序结果稳定")
  assert.equal(devices[0].id, "a", "排序不能改原数组")

  // 老数据没有 firstSeenAt：回退 lastAttachAt；缺失时间排最后，不伪造 now。
  const legacy = [
    { id: "new", name: "New", online: true, firstSeenAt: null, lastAttachAt: 900 },
    { id: "old", name: "Old", online: true, firstSeenAt: null, lastAttachAt: 100 },
    { id: "unknown", name: "Unknown", online: true, firstSeenAt: null, lastAttachAt: null },
  ]
  assert.deepEqual(sortDevicesForStrip(legacy).map((row) => row.id), ["old", "new", "unknown"])

  // 同一首次连接时间用名称 / id 固定次序。
  const tied = [
    { id: "b", name: "B", online: true, firstSeenAt: 7, lastAttachAt: 1 },
    { id: "a", name: "A", online: true, firstSeenAt: 7, lastAttachAt: 9 },
  ]
  assert.deepEqual(sortDevicesForStrip(tied).map((row) => row.id), ["a", "b"])

})


test("设备栏/会话时间：会话数不伪造；时间只消费真实 ts", () => {
  assert.equal(deviceContextText(true, 3), "已连接 · 3 个会话")
  assert.equal(deviceContextText(false, 0), "未连接 · 0 个会话")
  assert.equal(deviceSessionCount(true, 6, 3), 6)
  assert.equal(deviceSessionCount(false, 6, 3), 3)
  const now = new Date(2026, 9, 22, 14, 0, 0).getTime()
  assert.equal(mobileSessionTime(0, now), "")
  assert.equal(mobileSessionTime(Number.NaN, now), "")
  assert.equal(mobileSessionTime(now - 30_000, now), "刚刚")
  assert.equal(mobileSessionTime(now - 5 * 60_000, now), "5 分钟前")
  assert.equal(mobileSessionTime(now - 2 * 3_600_000, now), "2 小时前")
  assert.equal(mobileSessionTime(now - 3 * 86_400_000, now), "3 天前")
  assert.equal(mobileSessionTime(new Date(2026, 7, 3, 12).getTime(), now), "8 月 3 日")
})


test("导航栈源码：pushState/popstate + 深链合成 index + 弹层哨兵", () => {
  const navigation = source("../ui/src/mobile/useMobileNavigation.ts")
  assert.match(navigation, /pushState/)
  assert.match(navigation, /popstate/)
  assert.match(navigation, /__piMobileLayer/)
  assert.match(navigation, /__piMobile/)
  assert.match(navigation, /replaceState/)
  // P7 B2b：调用方从旧 MobileApp.tsx 换成新界面的 usePiPhoneNav
  const phoneNav = source("../ui/src/pi/hooks/usePiPhoneNav.ts")
  assert.match(phoneNav, /useMobileNavigation/)
  assert.match(phoneNav, /overlayCount/)
  assert.match(phoneNav, /closeTopOverlay/)
})
test("视口源码：focus + visualViewport + 120/0.82 进入、48/120ms 退出", () => {
  assert.match(viewport, /visualViewport/)
  assert.match(viewport, /focusin/)
  assert.match(viewport, /ENTER_GAP = 120/)
  assert.match(viewport, /ENTER_RATIO = 0\.82/)
  assert.match(viewport, /EXIT_GAP = 48/)
  assert.match(viewport, /EXIT_DELAY_MS = 120/)
  assert.match(viewport, /requestAnimationFrame/)
  assert.match(viewport, /--app-height/)
})






test("viewport：仍允许缩放，保留 cover + interactive-widget；测试脚本包含本文件", () => {
  assert.match(indexHtml, /viewport-fit=cover/)
  assert.match(indexHtml, /interactive-widget=resizes-content/)
  assert.doesNotMatch(indexHtml, /user-scalable=no|maximum-scale=1/)
  assert.match(pkg.scripts.test, /test\/mobile\.test\.mjs/)
})
test("手机产品模式改读新界面：安全区 env()、100vh → 100dvh 回退、顶栏 / 行高 52、16px 输入、240ms 转场（P7 B2b，原移动壳源码用例）", () => {
  const piTheme = source("../ui/src/components/pi/shared/pi-theme.css")
  const composer = source("../ui/src/components/pi/composer/PiFollowUpComposer.tsx")
  const phoneRoute = source("../ui/src/pi/model/phoneRoute.ts")
  assert.match(piTheme, /--cw-pi-safe-top:\s*env\(safe-area-inset-top, 0px\)/)
  assert.match(piTheme, /--cw-pi-safe-bottom:\s*env\(safe-area-inset-bottom, 0px\)/)
  assert.match(piTheme, /--cw-pi-safe-left:\s*env\(safe-area-inset-left, 0px\)/)
  assert.match(piTheme, /height:\s*100vh;/)
  assert.match(piTheme, /@supports \(height: 100dvh\)/)
  assert.doesNotMatch(piTheme, /100svh|100lvh/, "不得用 svh/lvh 做手机根节点高度")
  assert.doesNotMatch(piTheme, /touch-action:\s*none/, "不得全局 touch-action:none")
  assert.match(piTheme, /--cw-pi-topbar-h-phone:\s*52px;/)
  assert.match(piTheme, /--cw-pi-row-h-phone:\s*52px;/)
  assert.match(piTheme, /prefers-reduced-motion/)
  assert.match(composer, /手机 16px/)
  assert.match(phoneRoute, /export const PHONE_PAGE_EASING = "cubic-bezier\(0\.32, 0\.72, 0, 1\)"/)
})
