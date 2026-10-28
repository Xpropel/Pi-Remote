// P9 C（spec §5.5 / §5.6）：按设备选文件夹的纯函数——设备作用域说法、文件夹允许范围（含 Windows 路径规则）、
// 「最近」不混设备、面包屑、`~/` 显示、已知文件夹、搜索过滤、浏览能力与原因、list_dirs 回包清洗。
// node 直接加载 ui/src 的 .ts（Node ≥ 22.18 的类型剥离），相对导入必须带 .ts 扩展名。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import { DIR_LIST_MAX, devicesFromRoomList, folderAllowed, parseDirList, underRoots } from "../ui/src/relay/devices.ts"
import { deviceScopeLabel, folderForDevice, homeShort, newSessionDefaultsOf, recentFoldersOf } from "../ui/src/pi/model/newSession.ts"
import {
  BROWSE_REASON,
  browseAccessOf,
  breadcrumbOf,
  emptyFolderBrowserState,
  filterFolders,
  folderErrorText,
  initialBrowsePathOf,
  knownFoldersOf,
  middleEllipsis,
} from "../ui/src/pi/model/folderBrowser.ts"

/* ---------------- 设备作用域说法（D9 / spec §5.5） ---------------- */

describe("deviceScopeLabel：同平台一台说「这台 Mac」，多台说设备名", () => {
  const mac = (id, name) => ({ id, name, platform: "darwin" })

  test("只有一台 Mac：在这台 Mac 上", () => {
    const mbp = mac("d-mbp", "MacBook Pro")
    assert.equal(deviceScopeLabel(mbp, [mbp]), "在这台 Mac 上")
  })

  test("同一平台有两台：带设备名", () => {
    const mbp = mac("d-mbp", "MacBook Pro")
    const studio = mac("d-studio", "Mac Studio")
    assert.equal(deviceScopeLabel(mbp, [mbp, studio]), "在 MacBook Pro 上")
    assert.equal(deviceScopeLabel(studio, [mbp, studio]), "在 Mac Studio 上")
  })

  test("Windows / Linux 同理；relay 归一后的平台名也算", () => {
    const win = { id: "d-win", name: "ThinkPad", platform: "win32" }
    assert.equal(deviceScopeLabel(win, [win]), "在这台 Windows 上")
    const linux = { id: "d-lin", name: "linux-vm", platform: "linux" }
    assert.equal(deviceScopeLabel(linux, [linux]), "在这台 Linux 上")
    const macos = { id: "d-p9", name: "p9-mac", platform: "macos" }
    assert.equal(deviceScopeLabel(macos, [macos]), "在这台 Mac 上")
  })

  test("同平台多台且没名字：退回平台名；认不出平台：退回设备名 / 这台设备", () => {
    const a = { id: "a", name: "", platform: "windows" }
    const b = { id: "b", name: "", platform: "windows" }
    assert.equal(deviceScopeLabel(a, [a, b]), "在 Windows 上")
    const odd = { id: "c", name: "FreeBSD 盒子", platform: "freebsd" }
    assert.equal(deviceScopeLabel(odd, [odd]), "在 FreeBSD 盒子 上")
    const nameless = { id: "d", name: "", platform: "" }
    assert.equal(deviceScopeLabel(nameless, [nameless]), "在 这台设备 上")
  })
})

/* ---------------- 文件夹允许范围（folderAllowed / underRoots） ---------------- */

describe("folderAllowed：白名单 + 浏览根目录，规则和 relay 一致", () => {
  test("白名单目录：完全相等才算（末尾斜杠不计）", () => {
    const device = { projects: ["/Users/user/CLI/Pi-Remote"], browseRoots: [], platform: "macos" }
    assert.equal(folderAllowed(device, "/Users/user/CLI/Pi-Remote"), true)
    assert.equal(folderAllowed(device, "/Users/user/CLI/Pi-Remote/"), true)
    assert.equal(folderAllowed(device, "/Users/user/CLI/Pi-Remote/ui"), false, "子目录不在白名单里（和 relay 的 cwdAllowed 同口径）")
    assert.equal(folderAllowed(device, "/Users/user/CLI"), false)
  })

  test("浏览根目录：根目录本身和它下面的都行，前缀不是目录边界的不算", () => {
    const device = { projects: [], browseRoots: ["/Users/user"], platform: "macos" }
    assert.equal(folderAllowed(device, "/Users/user"), true)
    assert.equal(folderAllowed(device, "/Users/user/code/pi-remote"), true)
    assert.equal(folderAllowed(device, "/Users/userb/x"), false)
    assert.equal(folderAllowed(device, "/Users/user2"), false)
  })

  test("macOS / Windows 不分大小写和斜杠；Linux 区分大小写", () => {
    const mac = { projects: [], browseRoots: ["/Users/user"], platform: "macos" }
    assert.equal(folderAllowed(mac, "/users/user/code"), true)
    const win = { projects: [], browseRoots: ["C:\\Users\\user"], platform: "windows" }
    assert.equal(folderAllowed(win, "C:\\Users\\user\\code"), true)
    assert.equal(folderAllowed(win, "c:/users/user/code"), true, "Windows 上反斜杠和正斜杠等价")
    assert.equal(folderAllowed(win, "C:\\Users\\userb"), false)
    const linux = { projects: [], browseRoots: ["/srv/Apps"], platform: "linux" }
    assert.equal(folderAllowed(linux, "/srv/Apps/web"), true)
    assert.equal(folderAllowed(linux, "/srv/apps/web"), false, "Linux 区分大小写")
  })

  test("Windows：UNC 路径不认浏览根目录的子路径", () => {
    const win = { projects: [], browseRoots: ["C:\\Users\\user"], platform: "windows" }
    assert.equal(folderAllowed(win, "\\\\server\\share\\code"), false)
    assert.equal(underRoots(["\\\\server\\share"], "\\\\server\\share\\code", "windows"), true, "根目录本身就是 UNC 时按根目录规则判断")
  })

  test("没开浏览 / 旧数据（browseRoots 缺失）：退回白名单", () => {
    assert.equal(folderAllowed({ projects: ["/p"], browseRoots: [], platform: "" }, "/p"), true)
    assert.equal(folderAllowed({ projects: ["/p"], browseRoots: [], platform: "" }, "/p/x"), false)
    assert.equal(folderAllowed({ projects: ["/p"], browseRoots: undefined, platform: "" }, "/p"), true)
  })

  test("relay 下发的 browseRoots 由 parseDevice 解析，缺省 []、最多 8 个", () => {
    const [dev] = devicesFromRoomList([{ id: "d1", online: true, browseRoots: ["/Users/user", "", 3, "/srv"] }], [])
    assert.deepEqual(dev.browseRoots, ["/Users/user", "/srv"])
    const [old] = devicesFromRoomList([{ id: "d2", online: true }], [])
    assert.deepEqual(old.browseRoots, [])
    const [many] = devicesFromRoomList([{ id: "d3", online: true, browseRoots: Array.from({ length: 12 }, (_, i) => `/r${i}`) }], [])
    assert.equal(many.browseRoots.length, 8)
  })
})

/* ---------------- 最近用过的目录：只属于这台设备 ---------------- */

describe("recentFoldersOf：两台设备的「最近」不混在一起", () => {
  const SESSIONS_A = [
    { cwd: "/Users/user/work/proj", updatedAt: 30 },
    { cwd: "/Users/user/work/shared", updatedAt: 20 },
    { cwd: "/Users/user/work/proj", updatedAt: 10 },
  ]
  const SESSIONS_B = [
    { cwd: "/Users/b/other", updatedAt: 40 },
    { cwd: "/Users/b/other", updatedAt: 5 },
  ]
  const DEVICE_A = { projects: ["/Users/user/work/proj"], browseRoots: ["/Users/user"], platform: "macos" }
  const DEVICE_B = { projects: [], browseRoots: ["/Users/b"], platform: "macos" }

  test("按 updatedAt 倒序、去重，只留这台设备允许的目录", () => {
    assert.deepEqual(recentFoldersOf(SESSIONS_A, DEVICE_A), ["/Users/user/work/proj", "/Users/user/work/shared"])
    assert.deepEqual(recentFoldersOf(SESSIONS_B, DEVICE_B), ["/Users/b/other"])
  })

  test("把 A 的会话交给 B 设备：结果为空（不混设备）", () => {
    assert.deepEqual(recentFoldersOf(SESSIONS_A, DEVICE_B), [])
    assert.deepEqual(recentFoldersOf(SESSIONS_B, DEVICE_A), [])
  })

  test("limit 生效；第二参传字符串数组是旧 projects 口径（兼容既有调用）", () => {
    assert.deepEqual(recentFoldersOf(SESSIONS_A, DEVICE_A, 1), ["/Users/user/work/proj"])
    assert.deepEqual(recentFoldersOf(SESSIONS_A, ["/Users/user/work/proj"]), ["/Users/user/work/proj"])
  })

  test("folderForDevice：在白名单 / 浏览根目录里就留着，否则换成这台设备的第一个目录", () => {
    assert.equal(folderForDevice(DEVICE_A, "/Users/user/work/shared"), "/Users/user/work/shared")
    assert.equal(folderForDevice(DEVICE_A, "/opt/elsewhere"), "/Users/user/work/proj")
    assert.equal(folderForDevice({ projects: [], browseRoots: ["/Users/user"], platform: "macos" }, null), "/Users/user")
    assert.equal(folderForDevice(null, "/x"), null)
  })

  test("newSessionDefaultsOf 用设备的 folderAllowed 预选目录", () => {
    const pick = newSessionDefaultsOf({
      devices: [{ id: "d-mbp", name: "MacBook Pro", platform: "darwin", online: true, projects: [], browseRoots: ["/Users/user"], ...baseDevice() }],
      rooms: [],
      sessionsByDevice: { "d-mbp": [{ ...baseSession(), id: "s1", cwd: "/Users/user/work/x", updatedAt: 10 }] },
      selectedDeviceId: "d-mbp",
    })
    assert.deepEqual(pick, { deviceId: "d-mbp", folder: "/Users/user/work/x" })
  })
})

function baseDevice() {
  return { accountId: "a", lastAttachAt: null, firstSeenAt: null, windowExpiresAt: null, auth: null, paired: false }
}
function baseSession() {
  return { name: "", firstMessage: "", path: "/s/x.jsonl", messageCount: 1, sizeBytes: 1, active: false, online: false }
}

/* ---------------- 面包屑 / ~/ 显示 ---------------- */

describe("breadcrumbOf：从浏览根目录到当前目录，每一段都带完整路径", () => {
  test("macOS：第一段是 ~，后面是目录名", () => {
    assert.deepEqual(breadcrumbOf("/Users/user/CLI/Pi-Remote", "/Users/user"), [
      { label: "~", path: "/Users/user" },
      { label: "CLI", path: "/Users/user/CLI" },
      { label: "Pi-Remote", path: "/Users/user/CLI/Pi-Remote" },
    ])
  })

  test("根目录自己：只有一段；末尾斜杠不影响", () => {
    assert.deepEqual(breadcrumbOf("/Users/user", "/Users/user"), [{ label: "~", path: "/Users/user" }])
    assert.deepEqual(breadcrumbOf("/Users/user/", "/Users/user/"), [{ label: "~", path: "/Users/user" }])
  })

  test("Windows：反斜杠路径也能拆（面包屑路径统一成 /，attach 的 realpath 认这种写法）", () => {
    assert.deepEqual(breadcrumbOf("C:\\Users\\dev\\src", "C:\\Users\\dev"), [
      { label: "~", path: "C:/Users/dev" },
      { label: "src", path: "C:/Users/dev/src" },
    ])
  })

  test("不在根目录下 / 空路径：只给根目录一段或空", () => {
    assert.deepEqual(breadcrumbOf("/Users/other/x", "/Users/user"), [{ label: "~", path: "/Users/user" }])
    assert.deepEqual(breadcrumbOf("", "/Users/user"), [])
  })
})

describe("homeShort：浏览根目录（家目录）前缀写成 ~/", () => {
  test("根目录里 / 就是根目录 / 根目录外 / 没给根目录", () => {
    assert.equal(homeShort("/Users/user/code/pi-remote", ["/Users/user"]), "~/code/pi-remote")
    assert.equal(homeShort("/Users/user", ["/Users/user"]), "~")
    assert.equal(homeShort("/Users/user/", ["/Users/user/"]), "~")
    assert.equal(homeShort("/opt/tools", ["/Users/user"]), "/opt/tools")
    assert.equal(homeShort("/Users/user/x", []), "/Users/user/x")
    assert.equal(homeShort("", ["/Users/user"]), "")
  })

  test("多个根目录取最深的；Windows 反斜杠也能匹配", () => {
    assert.equal(homeShort("/Users/user/code/x", ["/Users/user", "/Users/user/code"]), "~/x")
    assert.equal(homeShort("C:\\Users\\dev\\src", ["C:\\Users\\dev"]), "~/src")
  })
})

/* ---------------- 二级菜单的文件夹列表 / 搜索 ---------------- */

describe("knownFoldersOf / filterFolders：白名单 + 最近，去重；搜索只过滤已知文件夹", () => {
  const DEVICE = { projects: ["/Users/user/pi-remote", "/Users/user/notes-app"], browseRoots: ["/Users/user"], platform: "macos" }
  const SESSIONS = [
    { cwd: "/Users/user/pi-remote", updatedAt: 30 },
    { cwd: "/Users/user/dotfiles", updatedAt: 20 },
    { cwd: "/Users/user/notes-app", updatedAt: 10 },
  ]

  test("白名单在前，最近用过的按更新倒序补在后面，去重", () => {
    assert.deepEqual(knownFoldersOf(DEVICE, SESSIONS), ["/Users/user/pi-remote", "/Users/user/notes-app", "/Users/user/dotfiles"])
  })

  test("filterFolders：按目录名或完整路径包含匹配，大小写不分", () => {
    const list = ["/Users/user/code/pi-remote", "/Users/user/code/notes-app", "/Users/user/work/billing"]
    assert.deepEqual(filterFolders("", list), list)
    assert.deepEqual(filterFolders("notes", list), ["/Users/user/code/notes-app"])
    assert.deepEqual(filterFolders("CODE", list), ["/Users/user/code/pi-remote", "/Users/user/code/notes-app"])
    assert.deepEqual(filterFolders("没有这个", list), [])
  })
})

/* ---------------- 浏览能力 / 原因（spec §5.1-6） ---------------- */

describe("browseAccessOf：三种置灰原因写 spec 的原文", () => {
  test("设备离线", () => {
    assert.deepEqual(browseAccessOf({ online: false, browseRoots: ["/Users/user"] }), { canBrowse: false, reason: BROWSE_REASON.offline })
    assert.equal(BROWSE_REASON.offline, "设备未连接，连上后才能浏览文件夹")
  })

  test("旧 attach（能力表里没有 fs.browse）", () => {
    assert.deepEqual(browseAccessOf({ online: true, browseRoots: ["/Users/user"], features: [] }), { canBrowse: false, reason: BROWSE_REASON.update })
    assert.equal(BROWSE_REASON.update, "这台设备的连接窗口（attach）需要更新")
  })

  test("设备关闭了浏览（浏览根目录为空）", () => {
    assert.deepEqual(browseAccessOf({ online: true, browseRoots: [] }), { canBrowse: false, reason: BROWSE_REASON.disabled })
    assert.equal(BROWSE_REASON.disabled, "这台设备没有开启文件夹浏览")
  })

  test("在线 + 有 fs.browse + 有浏览根目录：能浏览", () => {
    assert.deepEqual(browseAccessOf({ online: true, browseRoots: ["/Users/user"], features: ["fs.browse"] }), { canBrowse: true, reason: null })
  })
})

describe("initialBrowsePathOf：浏览器从选中的文件夹开始，不在浏览范围就交给第一个根目录", () => {
  const DEVICE = { browseRoots: ["/Users/user"], platform: "macos" }
  test("在根目录里用当前目录；否则 null（= attach 用第一个根目录）", () => {
    assert.equal(initialBrowsePathOf(DEVICE, "/Users/user/code/pi-remote"), "/Users/user/code/pi-remote")
    assert.equal(initialBrowsePathOf(DEVICE, "/opt/elsewhere"), null)
    assert.equal(initialBrowsePathOf(DEVICE, null), null)
  })
})

/* ---------------- list_dirs 回包清洗 / 错误码文案 / 中间截断 ---------------- */

describe("parseDirList：只信任 name / path，最多留 500 条", () => {
  test("正常回包", () => {
    assert.deepEqual(
      parseDirList({
        root: "/Users/user",
        path: "/Users/user/code",
        parent: "/Users/user",
        entries: [{ name: "pi-remote", path: "/Users/user/code/pi-remote" }],
        truncated: false,
      }),
      {
        root: "/Users/user",
        path: "/Users/user/code",
        parent: "/Users/user",
        entries: [{ name: "pi-remote", path: "/Users/user/code/pi-remote" }],
        truncated: false,
      },
    )
  })

  test("垃圾字段被丢掉；根目录的 parent 是 null；缺 path 留空串（调用方据此报 bad_reply）", () => {
    const parsed = parseDirList({ parent: 3, entries: [{ name: "x" }, { name: "", path: "/x" }, { name: "ok", path: "/y" }, 5] })
    assert.equal(parsed.path, "")
    assert.equal(parsed.parent, null)
    assert.deepEqual(parsed.entries, [{ name: "ok", path: "/y" }])
    assert.equal(parseDirList(null).entries.length, 0)
  })

  test(`超过 ${DIR_LIST_MAX} 条：截到 ${DIR_LIST_MAX} 条并标 truncated`, () => {
    const entries = Array.from({ length: DIR_LIST_MAX + 1 }, (_, i) => ({ name: `d${i}`, path: `/d${i}` }))
    const parsed = parseDirList({ root: "/", path: "/", entries, truncated: false })
    assert.equal(parsed.entries.length, DIR_LIST_MAX)
    assert.equal(parsed.truncated, true)
  })
})

describe("folderErrorText / middleEllipsis / emptyFolderBrowserState", () => {
  test("错误码照 spec §5.2 的文案表；未知码用回包的话，再没有就兜底", () => {
    assert.equal(folderErrorText("fs_outside_root"), "不在允许浏览的范围内")
    assert.equal(folderErrorText("fs_not_found"), "文件夹不存在")
    assert.equal(folderErrorText("fs_not_dir"), "这不是文件夹")
    assert.equal(folderErrorText("fs_denied"), "没有权限读取这个文件夹")
    assert.equal(folderErrorText("browse_disabled"), "这台设备没有开启文件夹浏览")
    assert.equal(folderErrorText("device_update_required"), "这台设备的连接窗口（attach）需要更新")
    assert.equal(folderErrorText("device_offline"), "设备未连接，连上后才能浏览文件夹")
    assert.equal(folderErrorText("weird", "设备自己说的话"), "设备自己说的话")
    assert.equal(folderErrorText(), "读取文件夹失败")
  })

  test("middleEllipsis：超长保留头尾、中间换 …", () => {
    assert.equal(middleEllipsis("/short", 56), "/short")
    const long = "/Users/user/code/" + "x".repeat(60)
    const out = middleEllipsis(long, 20)
    assert.equal(out.length, 20)
    assert.ok(out.includes("…"))
    assert.ok(out.startsWith("/Users/user"))
    assert.ok(out.endsWith("xxxx"))
  })

  test("emptyFolderBrowserState：默认空状态，patch 覆盖", () => {
    assert.deepEqual(emptyFolderBrowserState(), {
      path: "",
      root: "",
      parent: null,
      entries: [],
      truncated: false,
      loading: false,
      error: null,
      showHidden: false,
    })
    assert.equal(emptyFolderBrowserState({ loading: true }).loading, true)
  })
})
