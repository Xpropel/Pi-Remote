// lane-gapfix：联动测试查出的两个缺口（R2/l3-findings.md「联动测试」9、10）的回归。
// 9 是容器 / 部件之间的接线（.tsx 带 @/ 别名，node 直接加载不了），按源码口径查；10 的默认目录是纯函数，直接跑。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { newSessionDefaultsOf, hasRunningRoom } from "../ui/src/pi/model/newSession.ts"
import { pageLinkView } from "../ui/src/relay/presence.ts"

const src = (path) => readFileSync(new URL(`../ui/src/${path}`, import.meta.url), "utf8")

describe("联动测试 9：侧栏组头「+」（在这个目录新建会话）", () => {
  test("组头和文件夹行的「+」都接上 onNewSessionIn(deviceId, cwd)；静态态不接", () => {
    const sidebar = src("components/pi/shared/PiSidebar.tsx")
    assert.match(sidebar, /onNewSessionIn\?: \(deviceId: string, cwd: string\) => void/, "PiSidebar 有可选回调 onNewSessionIn")
    const btnAt = sidebar.indexOf("function GroupAddButton(")
    const btn = sidebar.slice(btnAt, sidebar.indexOf("function SidebarGroups(", btnAt))
    assert.match(btn, /onClick=\{onClick\}/, "GroupAddButton 把 onClick 交给按钮")
    assert.match(sidebar, /const addIn = \(group: PiSessionGroup\) => \(!isStatic && onNewSessionIn \? \(\) => onNewSessionIn\(group\.deviceId, group\.cwd\) : undefined\)/)
    assert.equal((sidebar.match(/<GroupAddButton [^>]*onClick=\{addIn\(group\)\}/g) ?? []).length, 2, "目录组头、文件夹行两处都传")
    assert.equal((sidebar.match(/<GroupAddButton /g) ?? []).length, 2, "没有别的不带回调的用法")
  })
  test("SidebarContainer：P11 桌面统一侧栏薄适配；NewSessionContainer 仍导出 presetNewSession（供其它入口）", () => {
    const container = src("pi/containers/SidebarContainer.tsx")
    assert.match(container, /CursorUnifiedSidebar/, "桌面容器委托 P11 UnifiedSidebar 适配")
    assert.doesNotMatch(container, /piLinkSummary|PhoneSidebarList/, "旧手机侧栏分支已删除")
    const ns = src("pi/containers/NewSessionContainer.tsx")
    const at = ns.indexOf("export function presetNewSession(deviceId: string, folder: string)")
    assert.ok(at > 0, "NewSessionContainer 导出 presetNewSession")
    const body = ns.slice(at, ns.indexOf("\n}\n", at))
    assert.match(body, /setStore\(\{ deviceId, folder, error: null \}\)/, "写模块 store 的设备和目录，草稿不动")
    assert.match(body, /if \(store\.starting\) return/, "正在启动时不改选择")
  })
})

describe("联动测试 10：默认目录撞上运行中的会话", () => {
  const PROJ = "/tmp/pi-stg/proj"
  const PROJ2 = "/tmp/pi-stg/proj2"
  const device = { id: "stg-mac", accountId: "a", name: "stg-mac", platform: "darwin", online: true, projects: [PROJ2, PROJ], lastAttachAt: 1, firstSeenAt: 1, windowExpiresAt: null, auth: "token", paired: true }
  const entry = (id, cwd, updatedAt) => ({ id, name: "", firstMessage: "", path: `/s/${id}.jsonl`, cwd, messageCount: 1, sizeBytes: 1, updatedAt, active: false, online: false })
  const room = (id, cwd, online = true) => ({ id, label: null, cwd, online, busy: false, viewers: 1, lastActivity: 5, deviceId: "stg-mac" })
  const pick = (rooms, sessions) => newSessionDefaultsOf({ devices: [device], rooms, sessionsByDevice: { "stg-mac": sessions }, selectedDeviceId: "stg-mac" })

  test("最近的目录有在线会话：跳过它，取下一个最近用过、没有运行会话的目录", () => {
    const sessions = [entry("l3-vm", PROJ, 300), entry("old", PROJ2, 100)]
    assert.deepEqual(pick([room("l3-vm", PROJ)], sessions), { deviceId: "stg-mac", folder: PROJ2 })
    // 路径写法不同（末尾斜杠）也算同一个目录，和 cwdInProjects 同口径
    assert.deepEqual(pick([room("l3-vm", `${PROJ}/`)], sessions), { deviceId: "stg-mac", folder: PROJ2 })
  })
  test("房间离线、或在别的设备上，不算运行中：照旧取最近的目录", () => {
    const sessions = [entry("l3-vm", PROJ, 300), entry("old", PROJ2, 100)]
    assert.equal(pick([room("l3-vm", PROJ, false)], sessions).folder, PROJ)
    assert.equal(pick([{ ...room("x", PROJ), deviceId: "other" }], sessions).folder, PROJ)
    assert.equal(hasRunningRoom([room("l3-vm", PROJ)], "stg-mac", PROJ), true)
    assert.equal(hasRunningRoom([room("l3-vm", PROJ)], "stg-mac", PROJ2), false)
  })
  test("already_running：createSession 把结果交回新建会话页；切到已有会话、草稿放进它的输入框、不发送、不算失败", () => {
    const relay = src("relay/useRelay.ts")
    assert.match(relay, /return \{ ok: true, roomId: String\(data\.roomId\), alreadyRunning: true \}/, "already_running 分支带 alreadyRunning")
    const csAt = relay.indexOf("const createSession = useCallback(")
    assert.match(relay.slice(csAt, relay.indexOf("}, [beginHarness", csAt)), /return beginHarness\("cwd", cwd, \{ cwd \}\)/, "createSession 返回启动结果")
    const ns = src("pi/containers/NewSessionContainer.tsx")
    const flowAt = ns.indexOf("function useStartFlow(")
    const flow = ns.slice(flowAt, ns.indexOf("function NewComposer(", flowAt))
    assert.match(flow, /relay\.createSession\(s\.cwd\)\.then\(\(result\) => \{[\s\S]*?result\.alreadyRunning[\s\S]*?phase: "existing", roomId: result\.roomId/, "撞上已有会话转 existing")
    const ex = flow.slice(flow.indexOf('if (s.phase === "existing") {'), flow.indexOf('if (s.phase === "start") {'))
    assert.ok(ex.length > 0, "existing 分支在 start 之前")
    assert.match(ex, /relay\.setDraft\(/, "草稿放进已有会话的输入框")
    assert.match(ex, /setStore\(\{ starting: null, error: null, draft: "" \}\)/, "不写启动失败")
    assert.match(ex, /act\.openSession\(\)/, "回到会话视图")
    assert.doesNotMatch(ex, /sendText/, "不发送")
  })
  test("最近用过的目录都有运行会话：退回原规则（最近的那个），不去挑没用过的目录", () => {
    const sessions = [entry("a", PROJ, 300), entry("b", PROJ2, 100)]
    assert.equal(pick([room("a", PROJ), room("b", PROJ2)], sessions).folder, PROJ)
    // 只有一个最近目录且在运行：同样退回它（不跳到没用过的 projects[0]）
    assert.equal(pick([room("a", PROJ)], [entry("a", PROJ, 300)]).folder, PROJ)
    // 没有最近目录：第一个允许的目录
    assert.equal(pick([], []).folder, PROJ2)
  })
})

describe("联动测试 L16：浏览器报断网时账户区和输入框同一口径", () => {
  const base = { token: "t", authed: true, everConnected: true, retryAt: null }
  test("pageLinkView：浏览器断网、socket 还没 close（authed 还是 true）时按重连中；联网时同 linkView", () => {
    assert.deepEqual(pageLinkView({ ...base, browserOnline: false }, 0), { kind: "reconnecting" })
    assert.deepEqual(pageLinkView({ ...base, browserOnline: true }, 0), { kind: "ok" })
    assert.deepEqual(pageLinkView({ ...base, authed: false, retryAt: 4000, browserOnline: true }, 0), { kind: "waiting", seconds: 4, first: false })
  })
  test("P11 侧栏/状态行/输入框仍以 pageLinkView 为唯一连接口径；旧手机账户栏已随 P11 退出", () => {
    const sidebar = src("pi/containers/SidebarContainer.tsx")
    assert.doesNotMatch(sidebar, /import .*PhoneAccountFooter|export function PhoneAccountFooter|piLinkSummary\(/, "旧手机账户栏已删除")
    assert.match(src("pi/containers/LinkStatusContainer.tsx"), /const link = pageLinkView\(relay, now\)/)
    const composer = src("pi/containers/ComposerContainer.tsx")
    assert.match(composer, /function linkOf\(relay: Relay, now: number\) \{\n\s*return pageLinkView\(relay, now\)/)
  })
})
