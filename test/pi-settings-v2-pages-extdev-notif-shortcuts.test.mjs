// Pi-Remote 设置页 v2 · 第二阶段页面守卫（扩展 / 设备 / 通知 / 快捷键）。
// 只读源码 + 纯逻辑函数，无浏览器：文案逐字、状态口径、数据接线、录制 / 冲突行为。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")
const PAGE = (name) => read(`ui/src/pi/settings/pages/${name}`)
const CSS = (name) => read(`ui/src/pi/settings/pages/${name}`)
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/

const types = await import("../ui/src/pi/settings/types.ts")
const ext = await import("../ui/src/pi/settings/pages/extensionsLogic.ts")
const devices = await import("../ui/src/pi/settings/pages/devicesLogic.ts")
const shortcuts = await import("../ui/src/pi/settings/pages/shortcutsLogic.ts")

const extensions = PAGE("ExtensionsPage.tsx")
const devicesPage = PAGE("DevicesPage.tsx")
const notifications = PAGE("NotificationsPage.tsx")
const shortcutsPage = PAGE("ShortcutsPage.tsx")

test("扩展页：五组齐全、逐字文案、总闸可写 / 清单仍只读、真实命令", () => {
  assert.match(extensions, /data-settings-page="extensions"/)
  for (const label of ["技能", "MCP 服务器", "提示词模板", "扩展本体", "Pi 包"]) {
    assert.ok(extensions.includes(`label="${label}"`), `扩展页缺分组「${label}」`)
  }
  // 技能总闸接 settings_set；MCP / 提示词 / 扩展本体 / Pi 包仍是 ◐ 只读，逐条技能也标 ◐。
  assert.ok((extensions.match(/status="bridge"/g) ?? []).length >= 4, "清单类分组 / 行仍要标「需扩展桥」")
  assert.match(extensions, /useSettingsDocument/)
  assert.match(extensions, /useSettingsWriter/)
  assert.match(extensions, /skillCommandsPatch/)
  assert.doesNotMatch(extensions, /SettingsPlaceholder/, "扩展页不得还是占位")

  for (const copy of [
    "技能斜杠命令",
    "把技能注册成 /skill:名字 命令；关了仍可手动输入调用",
    "仅手动调用",
    "添加技能",
    "从本地文件夹或链接导入",
    "添加 MCP 服务器",
    "填入启动命令或服务器地址",
    "添加模板",
    "模板文件名就是命令名",
    "pi-remote 远程",
    "把本机 pi 会话镜像到浏览器",
    "扩展拥有完整系统权限，只装可信来源",
    "内置",
    "MCP 支持",
    "代码模式 codemode",
    "工具搜索",
    "本地模型 llama.cpp",
    "添加扩展",
    "从本地文件或文件夹添加",
    "尚未安装任何包",
    "添加包",
    "从 npm、git 或本地文件夹整包安装扩展、技能与模板",
    "停用的技能与服务器不会出现在会话里。",
  ]) {
    assert.ok(extensions.includes(copy), `扩展页缺文案：${copy}`)
  }
  assert.match(extensions, /get_commands/)
  assert.match(extensions, /get_mcp_servers/)
  assert.match(extensions, /useSettingsDocument/)
  assert.doesNotMatch(extensions, /act\.setPref\("/, "扩展页没有本机项，不应写本机偏好")
  assert.doesNotMatch(extensions, /localStorage/)
})

test("扩展数据层：资源命令去重去内置、仅手动标记、MCP 清单与状态文案", () => {
  const commands = ext.hostCommandsOf({
    commands: [
      { name: "review", description: "代码审查", source: "prompt" },
      { name: "/review", description: "重复项", source: "prompt" },
      { name: "literature", description: "文献", source: "skill", sourceInfo: { disableModelInvocation: true } },
      { name: "scrape", source: "skill" },
      { name: "builtin-help", source: "builtin", kind: "builtin" },
      { name: "bad name", source: "skill" },
      { name: "remote", source: "extension" },
      null,
    ],
  })
  assert.deepEqual(
    commands.map((command) => [command.name, command.source, command.manualOnly]),
    [
      ["review", "prompt", false],
      ["literature", "skill", true],
      ["scrape", "skill", false],
      ["remote", "extension", false],
    ],
  )
  assert.deepEqual(ext.skillsOf(commands).map((command) => command.name), ["literature", "scrape"])
  assert.deepEqual(ext.promptsOf(commands).map((command) => command.name), ["review"])
  assert.equal(ext.skillDisplayNameOf("skill:code-review"), "code-review")
  assert.equal(ext.skillDisplayNameOf("/skill:review"), "review")
  assert.equal(ext.promptDisplayNameOf("review"), "/review")
  assert.equal(ext.skillCommandsEnabledOf({ settings: { enableSkillCommands: false } }), false)
  assert.equal(ext.skillCommandsEnabledOf({ settings: {} }), true, "读不到总闸时保持设计稿开启态")

  const servers = ext.mcpServersOf({
    servers: [
      { name: "github", transport: "stdio", exposure: "direct", enabled: true, connected: true, toolCount: 12 },
      { name: "filesystem", exposure: "search", connected: false },
      { count: 1 },
      "nope",
    ],
  })
  assert.deepEqual(servers.map((server) => server.name), ["github", "filesystem"])
  assert.equal(ext.mcpStatusTextOf(servers[0]), "已连接 · 工具直接可用")
  assert.equal(ext.mcpStatusTextOf(servers[1]), "未连接 · 工具按需查找")
  assert.equal(ext.mcpToneOf(servers[0]), "online")
  assert.equal(ext.mcpToneOf(servers[1]), "offline")
  assert.equal(ext.mcpExposureTextOf("direct"), "工具直接可用")
  assert.equal(ext.mcpExposureTextOf("callable"), "工具按需查找")
})

test("设备页：真实名册 / 延迟 / 测试连接 / 本机默认设备，预留项不可用", () => {
  assert.match(devicesPage, /data-settings-page="devices"/)
  assert.match(devicesPage, /relay\.devices/)
  assert.match(devicesPage, /relay\.selectedDeviceId/)
  assert.match(devicesPage, /act\.openPairing/)
  assert.match(devicesPage, /relay\.revokeDevice/)
  assert.match(devicesPage, /relay\.canManageDevices/)
  assert.match(devicesPage, /relay\.adminToken/)
  assert.match(devicesPage, /adminTokenReady/)
  assert.match(devicesPage, /prefs\.autoConnectDevice/)
  assert.match(devicesPage, /act\.setPref\("autoConnectDevice"/)
  assert.doesNotMatch(devicesPage, /localStorage/)
  assert.doesNotMatch(devicesPage, /38ms/, "延迟不得写死示例值")
  assert.match(devicesPage, /deviceLatencyTextOf\(device\.latencyMs\)/, "延迟来自 devices[].latencyMs")
  const devicesType = read("ui/src/relay/devices.ts")
  assert.match(devicesType, /latencyMs: number \| null/, "Device 类型要有 latencyMs:number|null")
  assert.match(devicesType, /raw\.latencyMs/, "parseDevice 要白名单解析 latencyMs")
  assert.doesNotMatch(devicesPage, /延迟[\s\S]{0,40}设计预留/, "延迟显示不再标设计预留")

  // 测试连接：真实命令往返；结果显示「设备 ↔ 服务器」
  assert.match(devicesPage, /runDeviceCommand\(device\.id, "get_host_diag"\)/)
  assert.match(devicesPage, /relay\.runCommand\("get_state"\)/)
  assert.match(devicesPage, /DEVICE_RTT_SCOPE/)
  assert.match(devicesPage, /deviceRoundTripTextOf/)
  assert.match(devicesPage, /正在测试连接/)
  assert.match(devicesPage, /disabled=\{!device\.online/)

  // 设为默认：纯本机偏好，刷新保持；不再用 ReservedAction
  assert.match(devicesPage, /prefs\.defaultDeviceId/)
  assert.match(devicesPage, /act\.setPref\("defaultDeviceId"/)
  assert.match(devicesPage, /默认设备/)
  assert.doesNotMatch(devicesPage, /ReservedAction/, "测试连接 / 设为默认不再是预留动作")

  assert.ok((devicesPage.match(/status="reserved"/g) ?? []).length >= 2, "主机行为两项预留")
  assert.ok((devicesPage.match(/设计预留/g) ?? []).length >= 3, "预留项要注明「设计预留」")
  assert.match(devicesPage, /再点一次移除/, "撤销要二次确认")
  assert.match(devicesPage, /测试连接/)
  assert.match(devicesPage, /设为默认/)
  assert.match(devicesPage, /当前设备/)
  assert.match(devicesPage, /pushNotice/)

  for (const copy of [
    "我的设备",
    "长任务运行时阻止设备睡眠",
    "在被控设备上生效，长任务过夜跑不会被系统睡眠打断",
    "新会话自动连上默认设备",
    "新建会话时自动归属默认设备",
    "在设备上常驻托盘/菜单栏",
    "Pi-Remote 的小图标常驻被控设备，随手看会话状态",
    "添加设备",
    "在新设备浏览器打开后，输入这里显示的配对码",
    "在侧边栏顶部的设备选择器也可切换当前设备。",
    "延迟来自设备心跳",
  ]) {
    assert.ok(devicesPage.includes(copy), `设备页缺文案：${copy}`)
  }
})

test("设备展示逻辑：平台、今天/昨天/月日、在线与离线状态", () => {
  assert.equal(devices.devicePlatformKindOf("darwin"), "mac")
  assert.equal(devices.devicePlatformKindOf("macos"), "mac")
  assert.equal(devices.devicePlatformKindOf("win32"), "windows")
  assert.equal(devices.devicePlatformKindOf("linux"), "linux")
  assert.equal(devices.devicePlatformKindOf("freebsd"), "other")
  assert.equal(devices.platformLabelOf("freebsd"), "freebsd")
  assert.equal(devices.platformLabelOf(null), "设备")

  const now = new Date(2026, 9, 28, 10, 0, 0).getTime()
  assert.equal(devices.lastOnlineTextOf(new Date(2026, 9, 27, 21, 40).getTime(), now), "昨天 21:40")
  assert.equal(devices.lastOnlineTextOf(new Date(2026, 9, 28, 9, 5).getTime(), now), "今天 09:05")
  assert.equal(devices.lastOnlineTextOf(new Date(2026, 9, 1, 8, 5).getTime(), now), "10月1日 08:05")
  assert.equal(devices.lastOnlineTextOf(new Date(2025, 11, 31, 23, 59).getTime(), now), "2025年12月31日 23:59")
  assert.equal(devices.lastOnlineTextOf(null, now), "")
  assert.equal(devices.lastOnlineTextOf(Number.NaN, now), "")

  assert.equal(devices.deviceStatusTextOf({ online: true }, true, now), "在线 · 当前设备")
  assert.equal(devices.deviceStatusTextOf({ online: true }, false, now), "在线")
  assert.equal(
    devices.deviceStatusTextOf({ online: false, lastAttachAt: new Date(2026, 9, 27, 21, 40).getTime() }, false, now),
    "离线 · 上次在线 昨天 21:40",
  )
  assert.equal(devices.deviceStatusTextOf({ online: false, lastAttachAt: null }, false, now), "离线")
  assert.equal(devices.deviceNameOf({ name: "Windows 电脑", platform: "windows" }), "Windows 电脑")
  assert.equal(devices.deviceNameOf({ name: "", platform: "macos" }), "macOS")

  // 心跳延迟：只显示 relay 给的整数样本；0ms 是合法样本，未知 / 负数 / 非有限值写 —
  assert.equal(devices.DEVICE_RTT_SCOPE, "设备 ↔ 服务器")
  assert.equal(devices.deviceLatencyTextOf(38), "延迟 38ms")
  assert.equal(devices.deviceLatencyTextOf(38.6), "延迟 39ms")
  assert.equal(devices.deviceLatencyTextOf(0), "延迟 0ms", "0ms 是真实样本，不能当没有")
  assert.equal(devices.deviceLatencyTextOf(null), "延迟 —")
  assert.equal(devices.deviceLatencyTextOf(undefined), "延迟 —")
  assert.equal(devices.deviceLatencyTextOf(Number.NaN), "延迟 —")
  assert.equal(devices.deviceLatencyTextOf(-1), "延迟 —")
  assert.equal(devices.deviceRoundTripTextOf(23.4), "23 ms")
  assert.equal(devices.deviceRoundTripTextOf(0), "0 ms")
  assert.equal(devices.deviceRoundTripTextOf(Number.NaN), "0 ms")
})

test("通知页：整页纯本地、六项即时持久化、文案与脚注逐字", () => {
  assert.match(notifications, /data-settings-page="notifications"/)
  assert.equal((notifications.match(/status="(bridge|reserved)"/g) ?? []).length, 0, "通知整页是 ○ 本机项")
  assert.equal((notifications.match(/localStorage/g) ?? []).length, 0, "页面不直写存储，走 act.setPref")
  for (const key of [
    "notifyWaiting",
    "notifyError",
    "notifyComplete",
    "notifyOnlyWhenAway",
    "notifySound",
    "notifyBadge",
  ]) {
    assert.ok(notifications.includes(`act.setPref("${key}"`), `通知页缺 ${key} 的即时写偏好`)
  }
  for (const copy of [
    "提醒时机",
    "等待你确认时",
    "会话停下来等你拍板时提醒",
    "出错时",
    "构建或运行失败时提醒",
    "任务完成时",
    "长任务跑完时提醒",
    "提醒条件",
    "仅当我不在页面时",
    "正在看的会话不会弹提醒",
    "总是提醒",
    "提示音",
    "提醒出现时播放短提示音",
    "方式",
    "当前方式",
    "应用内提醒",
    "标签页未读角标",
    "在浏览器标签标题上显示待处理数量",
    "暂仅支持应用内提醒；离开页面时不会推送。",
  ]) {
    assert.ok(notifications.includes(copy), `通知页缺文案：${copy}`)
  }
})

test("快捷键页：五组动作、点行右键录制、Esc 取消、冲突提示", () => {
  assert.match(shortcutsPage, /data-settings-page="shortcuts"/)
  assert.match(shortcutsPage, /SETTINGS_SHORTCUT_ACTIONS/)
  assert.match(shortcutsPage, /SETTINGS_SHORTCUT_GROUP_LABELS/)
  assert.match(shortcutsPage, /shortcutConflictsOf/)
  assert.match(shortcutsPage, /shortcutConflictTextOf/)
  assert.match(shortcutsPage, /event\.key === "Escape"/)
  assert.match(shortcutsPage, /setRecording\(null\)/)
  assert.match(shortcutsPage, /aria-label="搜索快捷键"/)
  assert.match(shortcutsPage, /点任意一行右侧的键位即可改键。/)
  assert.match(shortcutsPage, /data-shortcut-route=/)
  assert.match(shortcutsPage, /act\.setPref\("shortcuts"/)
  assert.doesNotMatch(shortcutsPage, /localStorage/)
  assert.doesNotMatch(shortcutsPage, /SettingsShortcutCapture/, "Esc 取消是快捷键页的独立录制器，不复用旧的取消口径")
})

test("快捷键纯逻辑：键帽、签名归一、冲突对称、搜索、动作映射", () => {
  assert.deepEqual(
    shortcuts.chordOf({ key: "n", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }),
    ["⌘", "⇧", "N"],
  )
  assert.deepEqual(
    shortcuts.chordOf({ key: "Enter", metaKey: false, ctrlKey: false, altKey: true, shiftKey: true }),
    ["⌥", "⇧", "Enter"],
  )
  assert.equal(shortcuts.chordOf({ key: "Shift", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }), null)
  assert.deepEqual(
    shortcuts.chordOf({ key: "ArrowUp", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }),
    ["↑"],
  )
  assert.deepEqual(
    shortcuts.chordOf({ key: " ", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }),
    ["Space"],
  )
  assert.equal(shortcuts.isModifierKey("Meta"), true)
  assert.equal(shortcuts.keycapOf("Escape"), "Esc")

  assert.equal(shortcuts.chordSignature(["⇧", "⌘", "K"]), shortcuts.chordSignature(["⌘", "⇧", "K"]))
  assert.notEqual(shortcuts.chordSignature(["⌘", "K"]), shortcuts.chordSignature(["⌘", "⇧", "K"]))
  assert.equal(shortcuts.chordSignature([]), "")

  const conflicts = shortcuts.shortcutConflictsOf({
    newSession: ["⌘", "K"],
    globalSearch: ["K", "⌘"],
    openSettings: ["⌘", ","],
    sendMessage: [],
  })
  assert.deepEqual(conflicts.newSession, ["globalSearch"])
  assert.deepEqual(conflicts.globalSearch, ["newSession"])
  assert.equal(conflicts.openSettings, undefined)
  assert.equal(conflicts.sendMessage, undefined)
  assert.equal(shortcuts.shortcutConflictTextOf(["全局搜索"]), "与「全局搜索」冲突")

  assert.equal(shortcuts.matchesShortcutQuery("新建会话", "会话", ["⌘", "N"], ""), true)
  assert.equal(shortcuts.matchesShortcutQuery("新建会话", "会话", ["⌘", "N"], "会话"), true)
  assert.equal(shortcuts.matchesShortcutQuery("新建会话", "会话", ["⌘", "N"], "⌘"), true)
  assert.equal(shortcuts.matchesShortcutQuery("新建会话", "会话", ["⌘", "N"], "搜索"), false)

  const routes = shortcuts.SHORTCUT_ACTION_ROUTES
  assert.equal(Object.keys(routes).length, 16)
  for (const action of types.SETTINGS_SHORTCUT_ACTIONS) {
    assert.ok(action.id in routes, `动作 ${action.id} 缺到现有动作的映射`)
    assert.ok(routes[action.id], `动作 ${action.id} 的映射为空`)
  }
  assert.deepEqual(Object.keys(routes).sort(), types.SETTINGS_SHORTCUT_ACTIONS.map((action) => action.id).sort())
  assert.equal(types.SETTINGS_SHORTCUT_ACTIONS.length, 16)
  assert.deepEqual(
    [...new Set(types.SETTINGS_SHORTCUT_ACTIONS.map((action) => action.group))],
    ["session", "navigation", "send", "model", "queue"],
  )
  assert.deepEqual(Object.values(types.SETTINGS_SHORTCUT_GROUP_LABELS), ["会话", "导航", "发送", "模型与思考", "消息队列"])
})

test("页面样式：四个页面 CSS 都作用域化且不写死颜色", () => {
  const files = ["extensions.css", "devices.css", "notifications.css", "shortcuts.css"]
  for (const file of files) {
    const css = CSS(file)
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "")
    assert.ok(css.length > 0, `${file} 为空`)
    assert.deepEqual(stripped.match(COLOR_LITERAL) ?? [], [], `${file} 不得写死颜色，只消费 --st-*`)
    for (const match of stripped.matchAll(/([^{}]+)\{/g)) {
      const selectors = match[1].trim()
      if (!selectors || selectors.startsWith("@")) continue
      for (const raw of selectors.split(",")) {
        const selector = raw.trim()
        if (!selector) continue
        assert.ok(selector.startsWith(".settings-"), `${file} 出现未作用域化的选择器：${selector}`)
      }
    }
  }
})
