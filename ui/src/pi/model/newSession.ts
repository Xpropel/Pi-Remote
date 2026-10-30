/**
 * 新建会话页（plan §7.3 new-session / new-session-picker、P5.5 c 线；决定 12：选目录 → 写第一条 → 发送时才启动 pi；M-04）。
 * 纯函数，node --test 直接加载。只读 relay 的原始字段（devices、rooms、sessionsByDevice）。
 * P9 C（spec §5.5）：目录的「允许」口径从 Device.projects 扩到 folderAllowed（白名单 + 浏览根目录），
 * 另加 deviceScopeLabel（「在这台 Mac 上」）与 homeShort（`~/` 显示）。
 */
import { cwdInProjects, folderAllowed, pickDefaultDevice, roomDeviceId, type Device, type RoomInfo, type SessionEntry } from "../../relay/devices.ts"

/** Comparison key for folder exclusion sets: separators and trailing
 *  slashes do not count, case-insensitive (same rule as the folder browser). */
export function folderKeyOf(value: string): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase()
}

function excludedKeysOf(exclude?: ReadonlySet<string>): ReadonlySet<string> | null {
  if (!exclude || exclude.size === 0) return null
  return new Set([...exclude].map(folderKeyOf))
}

/**
 * 预选：已选中的设备在线就用它，否则 pickDefaultDevice（最近有活动的在线设备）。
 * 目录 = 这台设备最近用过、且没有在线运行会话的目录（同目录已有在线房间时 attach 回 already_running，不另起；联动测试 10）；
 * 最近用过的目录都有运行会话（或没有最近目录）时退回原规则：最近会话的目录（在允许的目录里），没有就是第一个允许的目录
 * （P9 C：没有白名单目录时退回第一个浏览根目录，也就是设备用户的家目录）。
 * `exclude` (F3): folders proven missing on the device (see
 * folderExistence.ts) are never preselected -- the allow-list check alone
 * cannot tell a deleted folder from a live one.
 */
export function newSessionDefaultsOf(
  input: {
    devices: readonly Device[]
    rooms: readonly Pick<RoomInfo, "online" | "deviceId" | "lastActivity" | "cwd">[]
    sessionsByDevice: Readonly<Record<string, readonly SessionEntry[]>>
    selectedDeviceId: string | null
  },
  exclude?: ReadonlySet<string>,
): { deviceId: string | null; folder: string | null } {
  const selected = input.devices.find((d) => d.id === input.selectedDeviceId)
  const deviceId = selected?.online ? selected.id : (pickDefaultDevice([...input.devices], [...input.rooms]) ?? selected?.id ?? input.devices[0]?.id ?? null)
  const device = input.devices.find((d) => d.id === deviceId)
  if (!device) return { deviceId, folder: null }
  const excluded = excludedKeysOf(exclude)
  const kept = (cwd: string | undefined): cwd is string => !!cwd && !(excluded && excluded.has(folderKeyOf(cwd)))
  const recent = recentFoldersOf(input.sessionsByDevice[device.id] ?? [], device, Infinity, exclude)
  const idle = recent.find((cwd) => !hasRunningRoom(input.rooms, device.id, cwd))
  return { deviceId, folder: idle ?? recent[0] ?? device.projects.find(kept) ?? device.browseRoots?.find(kept) ?? null }
}

/** 这台设备在这个目录上有没有在线房间（attach 的 findOnline 同一口径：同目录在线 = already_running） */
export function hasRunningRoom(rooms: readonly Pick<RoomInfo, "online" | "deviceId" | "cwd">[], deviceId: string, cwd: string): boolean {
  return rooms.some((room) => room.online && !!room.cwd && roomDeviceId(room) === deviceId && cwdInProjects([room.cwd], cwd))
}

/**
 * P9 C：recentFoldersOf 的第二个参数从 projects 换成设备，用 folderAllowed（白名单 + 浏览根目录）过滤。
 * 传字符串数组是旧的 projects 口径，保留给既有调用方（等价于只按白名单过滤）。
 */
export type FolderScope = Pick<Device, "projects" | "browseRoots" | "platform"> | string[]

function allowedByScope(scope: FolderScope, cwd: string): boolean {
  return Array.isArray(scope) ? cwdInProjects(scope, cwd) : folderAllowed(scope, cwd)
}

/** "最近"：这台设备会话的目录，按 updatedAt 倒序去重，只留这台设备能用的目录（folderAllowed）；
 *  `exclude`（F3）里已证不存在的目录同样剔除。 */
export function recentFoldersOf(sessions: readonly Pick<SessionEntry, "cwd" | "updatedAt">[], scope: FolderScope, limit = 5, exclude?: ReadonlySet<string>): string[] {
  const excluded = excludedKeysOf(exclude)
  const sorted = [...sessions].filter((s) => !!s.cwd).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  const out: string[] = []
  for (const s of sorted) {
    if (out.includes(s.cwd) || !allowedByScope(scope, s.cwd)) continue
    if (excluded && excluded.has(folderKeyOf(s.cwd))) continue
    out.push(s.cwd)
    if (out.length >= limit) break
  }
  return out
}

/** 每台设备的会话数（设备菜单行尾灰字；显示选项的设备行也用） */
export function sessionCountsOf(sessionsByDevice: Readonly<Record<string, readonly unknown[]>>, devices: readonly Pick<Device, "id">[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const d of devices) out[d.id] = sessionsByDevice[d.id]?.length ?? 0
  return out
}

/** 换设备后目录还在它允许的范围里（白名单或浏览根目录）就留着，否则换成它的第一个目录（没有白名单目录时是第一个浏览根目录）；
 *  `exclude`（F3）里已证不存在的目录视同不在范围内，回退时也跳过。 */
export function folderForDevice(
  device: Pick<Device, "projects" | "browseRoots" | "platform"> | null | undefined,
  folder: string | null,
  exclude?: ReadonlySet<string>,
): string | null {
  if (!device) return null
  const excluded = excludedKeysOf(exclude)
  const kept = (cwd: string | undefined): cwd is string => !!cwd && !(excluded && excluded.has(folderKeyOf(cwd)))
  if (folder && kept(folder) && folderAllowed(device, folder)) return folder
  return device.projects.find(kept) ?? device.browseRoots?.find(kept) ?? null
}

/** 平台的中文名（P9 D9）：Relay 归一后的 macos / windows / linux；旧数据里还有 darwin / win32 别名 */
const PLATFORM_NAME: Record<string, string> = {
  macos: "Mac",
  darwin: "Mac",
  mac: "Mac",
  windows: "Windows",
  win32: "Windows",
  win: "Windows",
  linux: "Linux",
}

function platformNameOf(platform: string | null | undefined): string {
  return PLATFORM_NAME[(platform || "").trim().toLowerCase()] ?? ""
}

/**
 * 设备作用域的中文说法（P9 D9 / spec §5.5）：
 * 同平台只有这一台设备时写「在这台 Mac 上」（Windows / Linux 同理）；同平台有多台时写设备名「在 MacBook Pro 上」。
 */
export function deviceScopeLabel(
  device: Pick<Device, "id" | "name" | "platform">,
  devices: readonly Pick<Device, "id" | "platform">[],
): string {
  const p = platformNameOf(device.platform)
  const key = p || (device.platform || "").trim().toLowerCase()
  const alone = !!p && devices.filter((d) => (platformNameOf(d.platform) || (d.platform || "").trim().toLowerCase()) === key).length === 1
  return alone ? `在这台 ${p} 上` : `在 ${device.name || p || "这台设备"} 上`
}

/** 显示用路径：反斜杠统一成 /，去掉末尾斜杠（不改大小写） */
function displayPath(value: string): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
}

/**
 * 显示用（spec §5.5）：路径在某个浏览根目录里时，把根目录前缀写成 `~/`（根目录默认就是设备用户的家目录）。
 * 根目录外的路径原样返回。只用于显示，不要拿结果去发命令。
 */
export function homeShort(path: string, roots: readonly string[] | null | undefined): string {
  const want = displayPath(path)
  if (!want) return ""
  const wantKey = want.toLowerCase()
  let best = ""
  for (const root of roots || []) {
    const base = displayPath(root)
    if (!base || base === "/") continue
    const key = base.toLowerCase()
    if (wantKey === key || wantKey.startsWith(key + "/")) {
      if (key.length > best.length) best = base
    }
  }
  if (!best) return want
  const rest = want.slice(best.length).replace(/^\/+/, "")
  return rest ? `~/${rest}` : "~"
}

/** 启动中的说明："正在 MacBook Pro 上启动 pi… 12s"（秒数从发起起算，不足 1 秒不写） */
export function startingText(deviceName: string, startedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000))
  return `正在 ${deviceName} 上启动 pi…${s > 0 ? ` ${s}s` : ""}`
}

/** 设备离线时发送禁用的原因 */
export function offlineReasonOf(deviceName: string): string {
  return `${deviceName} 未连接 · 上线后才能新建会话`
}
