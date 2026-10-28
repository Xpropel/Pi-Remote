// Pi-Remote 设置页 v2 · 第二阶段四页（外观 / 数据与隐私 / 使用活动 / 关于）契约测试。
// 守卫：文案与状态口径、纯本地持久化、◐◌ 不可写、使用活动真实数据链路与口径、导出数据白名单、
//       缓存清理不碰 token/设置/outbox、六皮肤强调色与 880 宽列。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

const tools = await import("../ui/src/pi/settings/pages/dataTools.ts")
const aboutData = await import("../ui/src/pi/settings/pages/aboutData.ts")

const APPEARANCE = read("ui/src/pi/settings/pages/AppearancePage.tsx")
const PRIVACY = read("ui/src/pi/settings/pages/PrivacyPage.tsx")
const USAGE = read("ui/src/pi/settings/pages/UsagePage.tsx")
const ABOUT = read("ui/src/pi/settings/pages/AboutPage.tsx")
const APPEARANCE_CSS = read("ui/src/pi/settings/pages/appearance.css")
const USAGE_CSS = read("ui/src/pi/settings/pages/usage.css")

test("外观：三卡 / 明暗 / 五点强调色 / 字号 / 密度 / 动效 / 列宽 / 字体 都即时写本机设置", () => {
  for (const text of [
    "界面风格", "Cursor", "Claude", "Codex", "中性玻璃 · 紫", "暖纸衬线 · 陶土", "冷灰阶梯 · 蓝",
    "明暗", "深色", "浅色", "跟随系统", "强调色", "用于运行状态点与少量强调",
    "字号", "预览", "会话标题与正文的显示大小", "界面密度",
    "减少动态效果", "关掉界面里的过渡与淡入动画", "内容列宽", "会话内容的居中列最大宽度",
    "界面字体", "等宽字体", "用于代码与终端内容", "切换立即应用到整个界面。",
  ]) {
    assert.ok(APPEARANCE.includes(text), `外观页缺文案：${text}`)
  }
  for (const key of ["appearanceStyle", "appearanceTheme", "accent", "fontSize", "density", "reducedMotion", "contentWidth", "uiFont", "monoFont"]) {
    assert.match(APPEARANCE, new RegExp(`(setPref|mergePrefs)\\([^\\n]*${key}`), `外观页未持久化 ${key}`)
  }
  assert.match(APPEARANCE, /p\.act\.setUiVariant\(next\)/, "界面风格必须立即切宿主皮肤")
  assert.match(APPEARANCE, /p\.act\.setPref\("theme", next\)/, "明暗必须立即切宿主主题")
  assert.match(APPEARANCE, /SETTINGS_CONTENT_WIDTH_MIN/, "列宽必须用共享范围")
  assert.match(APPEARANCE, /SETTINGS_DENSITY_LABELS/, "密度文案必须用共享定稿")
  assert.match(APPEARANCE, /SettingsColorDots/, "强调色必须用共享色点组件")
  assert.match(APPEARANCE, /data-settings-page="appearance"/)
  assert.doesNotMatch(stripComments(APPEARANCE), /pi_remote_pi_prefs|pi_remote_pi_settings_v2/, "页面不得自己读写存储键")

  // 六皮肤强调色：三套身份色 + 选中态走 --st-accent，不写死当前皮肤。
  for (const color of ["#6d4bc4", "#2b7fd4", "#d97757", "#3fb970", "#6e6e76"]) {
    assert.ok(APPEARANCE_CSS.includes(color), `外观页强调色缺少 ${color}`)
  }
  assert.match(APPEARANCE_CSS, /background:\s*var\(--st-accent\)/, "选中徽标必须跟当前皮肤强调色")
  assert.match(APPEARANCE_CSS, /settings-appearance-mini\[data-preview-style="codex"\]/, "三张预览卡按设计稿固定皮肤")
})

test("数据与隐私：隐私模式本机可写，◐ 不可写，○ 即时，● 导出接真实命令", () => {
  // 隐私模式已从「设计预留」改为本机偏好（prefs.privacyMode）；只做渲染层脱敏，不写 settings.json。
  assert.match(PRIVACY, /<SettingsRow title="隐私模式" description="仅本机显示脱敏，不改设备数据">/)
  assert.match(PRIVACY, /label="隐私模式"/)
  assert.match(PRIVACY, /checked=\{prefs\.privacyMode\}/)
  assert.match(PRIVACY, /act\.setPref\("privacyMode"/)
  assert.match(PRIVACY, /不修改设备上的会话数据/)
  assert.doesNotMatch(PRIVACY, /隐私模式（设计预留）|status="reserved"/)
  assert.doesNotMatch(PRIVACY, /writer\.save\("privacyMode"/, "隐私模式不得走 settings_set 写桥")
  // 匿名统计 / 禁止图片已接 settings_set；数据存放 / 删除同步仍标 ◐。
  assert.ok((PRIVACY.match(/status="bridge"/g) ?? []).length >= 2, "数据存放 / 删除同步仍要标 ◐")
  assert.match(PRIVACY, /useSettingsDocument/)
  assert.match(PRIVACY, /useSettingsWriter/)
  assert.match(PRIVACY, /enableInstallTelemetry/)
  assert.match(PRIVACY, /installTelemetryPatch/)
  assert.match(PRIVACY, /images/)
  assert.match(PRIVACY, /blockImages/)
  assert.match(PRIVACY, /blockImagesPatch/)
  assert.match(PRIVACY, /runCommand\("export_session"\)/)
  assert.match(PRIVACY, /type="file"/)
  assert.match(PRIVACY, /clearCacheStorage/)
  assert.match(PRIVACY, /act\.setPref\("retention"/)
  assert.match(PRIVACY, /data-settings-page="privacy"/)
  assert.doesNotMatch(stripComments(PRIVACY), /pi_remote_pi_prefs|pi_remote_pi_settings_v2/, "页面不得自己读写存储键")
  assert.doesNotMatch(PRIVACY, /console\.(log|info|debug|warn|error)/, "不得打印设置 / 会话内容")
})

test("使用活动：真实 usage hook、52 周热力、880 宽列、无费用、额度预留", () => {
  assert.match(USAGE, /useUsageActivity\(relay, \{ deviceId \}\)/)
  assert.match(USAGE, /from "@\/pi\/usage"/)
  assert.match(USAGE, /addDaysToDayKey\(currentSunday, -51 \* 7\)/)
  assert.match(USAGE, /addDaysToDayKey\(heatStart, 363\)/)
  assert.match(USAGE, /data-settings-page="usage"/)
  assert.match(USAGE, /SettingsStatusBadge status="reserved"/)
  assert.match(USAGE, /本月用量 · 供应商/)
  assert.match(USAGE, /usageCoverageText/)
  const visible = stripComments(USAGE)
  assert.doesNotMatch(visible, /费用|cost/i, "使用活动维持不显示费用")
  assert.match(USAGE, /分天按设备本地时区/)
  assert.match(USAGE, /中转侧的镜像副本不重复计/)
  assert.match(USAGE_CSS, /--su-highlight:\s*#d97757/)
  assert.match(USAGE_CSS, /data-pi-settings-style="codex"[\s\S]*?--su-highlight:\s*var\(--st-accent\)/, "Codex 两套高亮改走强调色")
  assert.match(USAGE_CSS, /color-mix\(in srgb, var\(--st-accent\)/, "热力 / 柱图跟强调色")
})

test("关于：pi 版本读 get_host_diag、诊断导出真实 JSON、检查更新走 GitHub Releases", () => {
  for (const text of ["Pi-Remote", "个人远程会话 · 单用户", "应用版本", "中转服务器", "中继版本", "pi 版本", "会话数据", "本机缓存", "清理缓存", "不影响设备上的会话记录", "导出诊断信息", "开源许可", "检查更新", "Pi-Remote 为个人项目，仅供本人使用。"]) {
    assert.ok(ABOUT.includes(text), `关于页缺文案：${text}`)
  }
  assert.match(ABOUT, /CLIENT_VERSION/)
  assert.match(ABOUT, /serverDisplayName\(relay\.serverName/)
  assert.match(ABOUT, /relay\.serverProto/)
  assert.match(ABOUT, /get_host_diag/, "pi 版本必须从 get_host_diag 读")
  assert.match(ABOUT, /normalizeHostDiag/)
  assert.match(ABOUT, /piVersion/)
  assert.doesNotMatch(ABOUT, /label="pi 版本" value="—" status="reserved"/, "pi 版本不再是预留")
  assert.ok((ABOUT.match(/status="reserved"/g) ?? []).length === 0, "关于页不再有设计预留项")
  assert.match(ABOUT, /buildDiagnosticsExport/, "导出诊断信息要组真实 JSON")
  assert.match(ABOUT, /downloadTextFile/)
  assert.match(ABOUT, /checkLatestRelease/, "检查更新要比较 GitHub Releases")
  assert.match(ABOUT, /measureCacheBytes|measureBrowserCacheBytes/)
  assert.match(ABOUT, /clearCacheStorage/)
  assert.match(ABOUT, /data-settings-page="about"/)
  assert.doesNotMatch(ABOUT, /console\.(log|info|debug|warn|error)/)
})

test("版本比较 / 检查更新：semver、列表空、预发布、404、非 2xx、网络失败都不假装最新", async () => {
  assert.deepEqual(aboutData.versionPartsOf("v4.1.0"), [4, 1, 0])
  assert.equal(aboutData.versionPartsOf("4.0"), null)
  assert.equal(aboutData.compareVersions("4.0.0", "4.0.0"), 0)
  assert.equal(aboutData.compareVersions("4.1.0", "4.0.0"), 1)
  assert.equal(aboutData.compareVersions("v3.9.9", "4.0.0"), -1)
  assert.equal(aboutData.compareVersions("nope", "4.0.0"), null)

  // 列表 API（不是 releases/latest）：没有 Release 时 200 + []，浏览器不会记 404 网络错误。
  assert.match(
    aboutData.GITHUB_RELEASES_API,
    /^https:\/\/api\.github\.com\/repos\/your-org\/Pi-Remote\/releases\?per_page=10$/,
  )

  const response = (status, payload) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
  })
  let requested = null
  const newer = await aboutData.checkLatestRelease("4.0.0", {
    fetchImpl: async (url, init) => {
      requested = { url, init }
      return response(200, [{ tag_name: "v4.1.0" }])
    },
  })
  assert.equal(newer.status, "newer")
  assert.equal(newer.version, "4.1.0")
  assert.match(newer.text, /4\.1\.0/)
  assert.equal(requested.url, aboutData.GITHUB_RELEASES_API)
  assert.equal(requested.init?.cache, "no-store", "避免复用过期的 404 / 旧列表")

  const skipPrerelease = await aboutData.checkLatestRelease("4.0.0", {
    fetchImpl: async () => response(200, [{ tag_name: "v4.2.0-rc.1", prerelease: true }, { tag_name: "v4.1.0" }]),
  })
  assert.equal(skipPrerelease.status, "newer")
  assert.equal(skipPrerelease.version, "4.1.0", "跳过预发布，取第一个正式版")

  const latest = await aboutData.checkLatestRelease("4.0.0", {
    fetchImpl: async () => response(200, [{ tag_name: "v4.0.0" }]),
  })
  assert.equal(latest.status, "latest")
  assert.match(latest.text, /已是最新/)

  const none = await aboutData.checkLatestRelease("4.0.0", {
    fetchImpl: async () => response(200, []),
  })
  assert.equal(none.status, "none")
  assert.match(none.text, /还没有发布版本/)

  const malformed = await aboutData.checkLatestRelease("4.0.0", {
    fetchImpl: async () => response(200, { message: "unexpected" }),
  })
  assert.equal(malformed.status, "error")
  assert.match(malformed.text, /列表格式/)

  // 404 不能断言「没有 Release」：私有 / 改名仓库匿名访问也是 404。
  const notFound = await aboutData.checkLatestRelease("4.0.0", {
    fetchImpl: async () => response(404, {}),
  })
  assert.equal(notFound.status, "error")
  assert.match(notFound.text, /未公开|还没有 Release/)
  assert.doesNotMatch(notFound.text, /已是最新/)

  const failed = await aboutData.checkLatestRelease("4.0.0", {
    fetchImpl: async () => {
      throw new Error("network blocked")
    },
  })
  assert.equal(failed.status, "error")
  assert.match(failed.text, /CSP|网络/)
  assert.doesNotMatch(failed.text, /已是最新/)
})

test("诊断导出：host diag + 中继 / 设备 / 版本，白名单且不含令牌与路径", () => {
  const device = {
    id: "d-mbp",
    accountId: "acct",
    name: "MacBook Pro",
    platform: "macos",
    online: true,
    projects: ["/Users/secret/work"],
    browseRoots: ["/Users/secret"],
    lastAttachAt: 1000,
    firstSeenAt: 900,
    windowExpiresAt: 2000,
    auth: "token",
    paired: true,
    latencyMs: 38,
    features: ["session.files"],
    trash: true,
  }
  const file = aboutData.buildDiagnosticsExport({
    hostDiag: {
      piVersion: "1.3.0",
      nodeVersion: "v22.18.0",
      platform: "darwin",
      arch: "arm64",
      extensionVersion: "4.0.0",
      attach: { active: true, expiresAt: 2000, deviceId: "d-mbp" },
      tap: { state: "ok", captures: 1, missed: 0, open: 0 },
      recentErrors: [{ at: 1, code: "timeout", message: "token=secret-value failed" }],
      logTail: "viewer token=secret-value\n正常一行",
    },
    relay: {
      serverName: "relay.local",
      serverProto: 4,
      clientVersion: "4.0.0",
      browserOnline: true,
      authed: true,
      deviceMode: true,
    },
    devices: [device],
    selectedDeviceId: "d-mbp",
    appVersion: "4.0.0",
    now: new Date(2026, 9, 28, 12, 0, 0).getTime(),
  })
  assert.match(file.fileName, /^pi-remote-diagnostics-20261028-120000\.json$/)
  assert.equal(file.mime, "application/json")
  const payload = JSON.parse(file.text)
  assert.equal(payload.format, "pi-remote-diagnostics.v1")
  assert.equal(payload.appVersion, "4.0.0")
  assert.equal(payload.relay.serverProto, 4)
  assert.equal(payload.hostDiag.piVersion, "1.3.0")
  assert.equal(payload.devices[0].latencyMs, 38)
  assert.deepEqual(Object.keys(payload.devices[0]).sort(), [
    "auth",
    "firstSeenAt",
    "id",
    "lastAttachAt",
    "latencyMs",
    "name",
    "online",
    "paired",
    "platform",
    "windowExpiresAt",
  ])
  assert.equal(file.text.includes("/Users/secret"), false, "不得带设备路径 / 浏览根目录")
  assert.equal(file.text.includes("secret-value"), false, "日志里的 token 已遮罩")
  assert.equal(/viewer[_-]?token|admin[_-]?token|access[_-]?token/i.test(file.text), false)
})

test("缓存计量 / 清理只碰缓存，不碰 token、设置、outbox、侧栏置顶", () => {
  const make = (entries) => {
    const map = new Map(Object.entries(entries))
    return {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => map.set(key, value),
      removeItem: (key) => map.delete(key),
      has: (key) => map.has(key),
    }
  }
  const local = make({
    pi_remote_drafts_v1: "draft text",
    pi_remote_slash_usage_v1: "{}",
    pi_remote_pi_settings_v2: "settings",
    pi_remote_pi_prefs: "prefs",
    pi_remote_viewer_token: "secret",
    pi_remote_outbox_v1: "outbox",
    pi_remote_pi_sidebar_local: "pins",
  })
  const session = make({ pi_remote_draft_images_v1: "img" })
  assert.ok(tools.measureCacheBytes(local, session) > 0)
  assert.equal(tools.clearCacheStorage(local, session), true)
  assert.equal(local.has("pi_remote_drafts_v1"), false)
  assert.equal(local.has("pi_remote_slash_usage_v1"), false)
  assert.equal(session.has("pi_remote_draft_images_v1"), false)
  for (const keep of ["pi_remote_pi_settings_v2", "pi_remote_pi_prefs", "pi_remote_viewer_token", "pi_remote_outbox_v1", "pi_remote_pi_sidebar_local"]) {
    assert.equal(local.has(keep), true, `清理缓存误删 ${keep}`)
  }
  assert.equal(tools.clearCacheStorage(local, session), false, "第二次没有可删项")
  assert.equal(tools.formatCacheSize(0), "约 0 KB")
  assert.equal(tools.formatCacheSize(1536), "约 2 KB")
  assert.equal(tools.formatCacheSize(1.5 * 1024 * 1024), "约 1.5 MB")
  assert.equal(tools.formatCacheSize(null), "—")
})

test("设置导入：信封 / 裸偏好 / 版本不符 / 坏 JSON / 空设置都明确处理", () => {
  const envelope = tools.parseSettingsImport(JSON.stringify({ v: 1, prefs: { fontSize: "large", accent: "clay" }, updatedAt: 1 }))
  assert.equal(envelope.ok, true)
  assert.equal(envelope.prefs.fontSize, "large")
  assert.equal(envelope.prefs.accent, "clay")
  const plain = tools.parseSettingsImport(JSON.stringify({ density: "relaxed" }))
  assert.equal(plain.ok, true)
  assert.equal(plain.prefs.density, "relaxed")
  assert.equal(plain.prefs.fontSize, "standard")
  assert.equal(tools.parseSettingsImport(JSON.stringify({ v: 2, prefs: { fontSize: "large" } })).ok, false)
  assert.equal(tools.parseSettingsImport("{broken json").ok, false)
  assert.equal(tools.parseSettingsImport(JSON.stringify({ hello: "world" })).ok, false)
})

test("导出数据：设置 + 会话索引 + 当前会话，索引只留白名单字段", () => {
  const prefs = tools.parseSettingsImport(JSON.stringify({ fontSize: "large" })).prefs
  const now = new Date(2026, 9, 28, 12, 0, 0).getTime()
  const file = tools.buildDataExport({
    prefs,
    sessions: [
      { id: "s-1", title: "会话一", updatedAt: 123, deviceId: "dev-1", online: true, cwd: "/secret/path", path: "/secret/file.jsonl" },
      { id: "", title: "no id" },
    ],
    sessionText: "hello",
    sessionTruncated: true,
    appVersion: "4.0.0",
    now,
  })
  assert.equal(file.fileName, "pi-remote-data-20261028.json")
  assert.equal(file.sessionCount, 1)
  const payload = JSON.parse(file.text)
  assert.equal(payload.format, "pi-remote-data.v1")
  assert.equal(payload.settings.fontSize, "large")
  assert.deepEqual(payload.sessionIndex, [{ id: "s-1", title: "会话一", updatedAt: 123, deviceId: "dev-1", online: true }])
  assert.deepEqual(payload.session, { text: "hello", truncated: true })
  assert.equal(file.text.includes("/secret"), false)
  assert.equal(file.text.includes("cwd"), false)
  assert.equal(file.text.includes("pi_remote_viewer_token"), false)
  assert.equal(/"access_?token"|"viewer_?token"|"authorization"/i.test(file.text), false)
})
