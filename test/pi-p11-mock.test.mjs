// P11 mock 工装（task-37 M1）单测：
// 1. 数据字典/场景/六套预设完整、确定性（无 wall clock/随机）；
// 2. PiSidebarData 契约形状（设备/工作区/会话/状态/摘要/时间/身份位）；
// 3. 纯 reducer：pin/archive/group/device/width/collapse/search；
// 4. 生产隔离：产品代码不 import dev fixture、不出现 P11_DEV_ 标记、Settings 挂载不注入 dev 数据；
// 5. package.json 注册本测试 + gallery e2e 工装存在。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  P11_DEV_DEVICE_ID,
  P11_DEV_NOW,
  P11_DEV_SERVER_NAME,
  P11_DEV_SESSION_SPECS,
  P11_DESKTOP_SCENARIOS,
  P11_MOBILE_SCENARIOS,
  PI_SIDEBAR_GALLERY_PRESETS,
  p11CloseSearch,
  p11DevActions,
  p11MobileDataOf,
  p11OpenSearch,
  p11PreviewParamsOf,
  p11Resize,
  p11SelectDevice,
  p11SelectSession,
  p11SetSearchQuery,
  p11SidebarDataOf,
  p11ToggleArchive,
  p11ToggleCollapse,
  p11ToggleDeviceMenu,
  p11ToggleGroup,
  p11TogglePin,
} from "../ui/src/pi/dev/sidebar/fixtures.ts"
import { SIDEBAR_WIDTH_COLLAPSED, SIDEBAR_WIDTH_DEFAULT } from "../ui/src/pi/sidebar/types.ts"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const params = (query = "") => p11PreviewParamsOf(new URLSearchParams(query))
const base = () => p11SidebarDataOf(params("skin=cursor&theme=dark&scenario=base-expanded"))

test("场景表与六套 gallery 预设", () => {
  assert.ok(P11_DESKTOP_SCENARIOS.length >= 12)
  assert.ok(P11_MOBILE_SCENARIOS.length >= 8)
  assert.equal(new Set(P11_DESKTOP_SCENARIOS.map((scenario) => scenario.id)).size, P11_DESKTOP_SCENARIOS.length)
  assert.equal(new Set(P11_MOBILE_SCENARIOS.map((scenario) => scenario.id)).size, P11_MOBILE_SCENARIOS.length)
  assert.equal(PI_SIDEBAR_GALLERY_PRESETS.length, 6)
  assert.deepEqual(PI_SIDEBAR_GALLERY_PRESETS.map((preset) => preset.id), ["cursor-dark", "cursor-light", "claude-dark", "claude-light", "codex-dark", "codex-light"])
  for (const preset of PI_SIDEBAR_GALLERY_PRESETS) {
    const data = p11SidebarDataOf(params("scenario=base"), { style: preset.style, theme: preset.theme })
    assert.equal(data.style, preset.style)
    assert.equal(data.theme, preset.theme)
  }
})

test("base 数据字典：设备/身份/工作区/状态/摘要/时间逐字", () => {
  const data = base()
  assert.equal(data.width, SIDEBAR_WIDTH_DEFAULT)
  assert.equal(data.collapsed, false)
  assert.equal(data.serverName, P11_DEV_SERVER_NAME)
  assert.equal(data.now, P11_DEV_NOW)
  assert.equal(data.devices.length, 2)
  assert.deepEqual(data.devices.map((device) => device.name), ["MacBook Pro", "Windows 电脑"])
  assert.equal(data.selectedDeviceId, P11_DEV_DEVICE_ID)
  assert.equal(data.groups.length, 3)
  assert.deepEqual(data.groups.map((group) => group.label), ["Pi-Remote", "LLM 论文", "杂项"])
  const sessions = data.groups.flatMap((group) => group.sessions)
  assert.equal(sessions.length, P11_DEV_SESSION_SPECS.length)
  assert.deepEqual(sessions.map((session) => session.status.tone), ["running", "waiting", "error", "running", "idle", "error"])
  assert.equal(sessions.filter((session) => session.selected).length, 1)
  assert.equal(sessions.find((session) => session.selected)?.title, "修复 relay 重连掉线")
  const waiting = sessions.find((session) => session.status.tone === "waiting")
  assert.equal(waiting?.timeLabel, "12m")
  assert.equal(waiting?.summary, "等你确认部署方案")
  assert.equal(sessions.find((session) => session.id === "deploy-perm")?.summary, "构建失败：权限不足")
  assert.equal(sessions.find((session) => session.id === "relay-reconnect")?.repo, "your-org/Pi-Remote")
  assert.equal(sessions.find((session) => session.id === "relay-reconnect")?.cwd, "~/CLI/Pi-Remote")
  assert.equal(sessions.find((session) => session.id === "relay-reconnect")?.deviceName, "MacBook Pro")
})

test("确定性：重复构建 deepEqual，无 wall clock", () => {
  assert.deepEqual(base(), base())
  assert.equal(JSON.stringify(base()), JSON.stringify(base()))
  const source = fs.readFileSync(path.join(ROOT, "ui/src/pi/dev/sidebar/fixtures.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
  assert.equal(/Math\.random/.test(source), false)
  assert.equal(/Date\.now\s*\(/.test(source), false)
})

test("场景：devices-3 / pin-archive / busy-many / empty / long-titles / menu / search / folders", () => {
  const three = p11SidebarDataOf(params("scenario=devices-3"))
  assert.equal(three.devices.length, 3)
  assert.equal(three.devices[2].online, false)
  const pinned = p11SidebarDataOf(params("scenario=pin-archive"))
  assert.equal(pinned.groups[0].kind, "pinned")
  assert.ok(pinned.groups[0].count >= 1)
  const busy = p11SidebarDataOf(params("scenario=busy-many"))
  assert.ok(busy.groups.reduce((sum, group) => sum + group.sessions.length, 0) >= 20)
  const empty = p11SidebarDataOf(params("scenario=empty"))
  assert.deepEqual(empty.groups, [])
  const long = p11SidebarDataOf(params("scenario=long-titles"))
  assert.ok(long.groups[0].label.length > 20)
  assert.ok(long.groups[0].sessions[0].title.length > 30)
  assert.equal(p11SidebarDataOf(params("scenario=menu")).deviceMenuOpen, true)
  const search = p11SidebarDataOf(params("scenario=search"))
  assert.equal(search.search.open, true)
  assert.ok((search.search.results ?? []).length > 0)
  const folders = p11SidebarDataOf(params("scenario=folders"))
  assert.equal(folders.groups.filter((group) => group.collapsed).length, 1)
  const identity = p11SidebarDataOf(params("scenario=identity-long"))
  assert.ok(identity.serverName.length > P11_DEV_SERVER_NAME.length)
})

test("纯 reducer：选中 / pin / archive / group / device / width / collapse / search", () => {
  const start = base()
  const selectedKey = start.groups[1].sessions[0].key
  const selected = p11SelectSession(start, selectedKey)
  assert.equal(selected.groups.flatMap((group) => group.sessions).filter((session) => session.selected).length, 1)
  assert.equal(selected.groups[1].sessions[0].selected, true)
  // pin：进入置顶分区，再取消回原组
  const pinned = p11TogglePin(start, selectedKey)
  assert.equal(pinned.groups[0].kind, "pinned")
  assert.equal(pinned.groups[0].sessions[0].key, selectedKey)
  const unpinned = p11TogglePin(pinned, selectedKey)
  assert.equal(unpinned.groups.some((group) => group.kind === "pinned"), false) // 唯一置顶被取消 → 分区消失
  assert.equal(unpinned.groups.flatMap((group) => group.sessions).some((session) => session.key === selectedKey), true) // 回原组
  // archive：行消失
  const archived = p11ToggleArchive(start, selectedKey)
  assert.equal(archived.groups.flatMap((group) => group.sessions).some((session) => session.key === selectedKey), false)
  const grouped = p11ToggleGroup(start, "pi")
  assert.equal(grouped.groups.find((group) => group.id === "pi")?.collapsed, true)
  const device = p11SelectDevice(start, "dev-win")
  assert.equal(device.selectedDeviceId, "dev-win")
  assert.equal(device.deviceMenuOpen, false)
  assert.equal(p11ToggleDeviceMenu(start).deviceMenuOpen, true)
  assert.equal(p11Resize(start, 9999).width, 360)
  assert.equal(p11Resize(start, 100).width, 220)
  assert.equal(p11ToggleCollapse(start).collapsed, true)
  assert.equal(SIDEBAR_WIDTH_COLLAPSED, 56)
  const search = p11OpenSearch(start)
  assert.equal(search.search.open, true)
  assert.equal(p11CloseSearch(search).search.open, false)
  const filtered = p11SetSearchQuery(search, "relay")
  assert.ok((filtered.search.results ?? []).every((row) => row.label.includes("relay")))
  // actions 绑定 reducer（预览交互路径）
  let state = start
  const actions = p11DevActions((updater) => { state = updater(state) })
  actions.toggleGroup("pi")
  assert.equal(state.groups.find((group) => group.id === "pi")?.collapsed, true)
  actions.resize(220)
  assert.equal(state.width, 220)
})

test("移动数据：抽屉/列表共用数据、摘要/时间/A11y 文案来源", () => {
  const list = p11MobileDataOf(p11PreviewParamsOf(new URLSearchParams("surface=mobile&scenario=list-base&mode=list&page=list")))
  assert.equal(list.groups.length, 3)
  const sessions = list.groups.flatMap((group) => group.sessions)
  assert.ok(sessions.every((session) => typeof session.summary === "string" && session.summary.length > 0))
  assert.ok(sessions.every((session) => typeof session.timeLabel === "string"))
  assert.ok(list.serverName.length > 0)
  const drawer = p11MobileDataOf(p11PreviewParamsOf(new URLSearchParams("surface=mobile&scenario=drawer-base&mode=drawer&page=session")))
  assert.deepEqual(drawer.groups.map((group) => group.label), list.groups.map((group) => group.label))
})

test("生产隔离：产品代码不 import dev fixture/标记", () => {
  const offenders = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "dev") continue
        walk(file)
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        const source = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
        if (/pi\/dev\/sidebar|P11_DEV_|dev\/sidebar\/fixtures/.test(source)) offenders.push(path.relative(ROOT, file))
      }
    }
  }
  walk(path.join(ROOT, "ui/src/pi"))
  assert.deepEqual(offenders, [])
})

test("package.json 注册本测试", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))
  assert.ok(pkg.scripts.test.includes("test/pi-p11-mock.test.mjs"))
})
