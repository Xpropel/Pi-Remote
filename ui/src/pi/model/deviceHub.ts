/**
 * 登录后设备选择中心（DeviceHub）的纯函数模型（node --test 可直载）。
 * - 决定产品模式下登录成功 / 初次打开根路径时是否展示设备选择中心；
 * - 汇总每台设备的在线状态、运行中会话数、历史会话数、工作区目录标签与最近会话摘要。
 */
import { piBaseName } from "../../components/pi/shared/format.ts"
import type { Device, RoomInfo, SessionEntry } from "../../relay/devices.ts"
import { sortShellDevices } from "../../shell/deviceStripModel.ts"
import { sidebarSessionsOf, type PiDeviceListedSession } from "./sidebarSource.ts"

export const DEVICE_HUB_PICKED_KEY = "pi_remote_hub_picked"

export type PiDevicePlatformKind = "mac" | "linux" | "windows" | "other"

export interface PiDeviceHubCard {
  id: string
  name: string
  platform: string
  platformKind: PiDevicePlatformKind
  platformLabel: string
  online: boolean
  selected: boolean
  runningCount: number
  liveRoomCount: number
  sessionCount: number
  folders: string[]
  recentTitle: string | null
  activityLabel: string
}

/** URL 查询参数是否自带深链（?session= 或 ?device= 非空）。 */
export function hasHubDeepLink(search: string): boolean {
  const raw = search.startsWith("?") ? search.slice(1) : search
  if (!raw) return false
  const params = new URLSearchParams(raw)
  const session = (params.get("session") ?? "").trim()
  const device = (params.get("device") ?? "").trim()
  return Boolean(session || device)
}

/** 仅在产品模式、非静态舞台、已登录、无深链，且「打开时进入 = 设备选择页」或本标签页尚未挑过设备时自动弹出设备中心。 */
export function shouldAutoOpenDeviceHub(input: {
  isProduct: boolean
  isStatic: boolean
  token: string
  search: string
  hubPicked: boolean
  startView?: string
}): boolean {
  if (!(input.isProduct && !input.isStatic && input.token.trim().length > 0 && !hasHubDeepLink(input.search))) {
    return false
  }
  if (input.hubPicked) return false
  if (input.startView === "last" || input.startView === "list") return false
  return true
}

export function readDeviceHubPicked(storage?: Pick<Storage, "getItem"> | null): boolean {
  try {
    return storage?.getItem(DEVICE_HUB_PICKED_KEY) === "1"
  } catch {
    return false
  }
}

export function writeDeviceHubPicked(picked: boolean, storage?: Pick<Storage, "setItem" | "removeItem"> | null): void {
  try {
    if (!storage) return
    if (picked) storage.setItem(DEVICE_HUB_PICKED_KEY, "1")
    else storage.removeItem(DEVICE_HUB_PICKED_KEY)
  } catch {
    // 无痕或受限存储忽略
  }
}

export function platformKindOf(platform?: string | null): PiDevicePlatformKind {
  const p = (platform ?? "").trim().toLowerCase()
  if (p === "darwin" || p.includes("mac")) return "mac"
  if (p.includes("win")) return "windows"
  if (p.includes("linux")) return "linux"
  return "other"
}

export function platformLabelOf(platform?: string | null): string {
  switch (platformKindOf(platform)) {
    case "mac":
      return "macOS"
    case "windows":
      return "Windows"
    case "linux":
      return "Linux"
    default:
      return "远程主机"
  }
}

function collectFolders(device: Device, sessions: readonly PiDeviceListedSession[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (raw: string | null | undefined) => {
    const clean = (raw ?? "").trim()
    if (!clean) return
    const label = piBaseName(clean) || clean
    if (seen.has(label)) return
    seen.add(label)
    out.push(label)
  }
  for (const s of sessions) push(s.cwd)
  for (const p of device.projects) push(p)
  for (const r of device.browseRoots) push(r)
  return out.slice(0, 3)
}

/** 按在线优先、首次连接顺序组装每台设备的展示卡片模型。 */
export function deviceHubCardsOf(input: {
  devices: readonly Device[]
  rooms: readonly RoomInfo[]
  sessionsByDevice: Readonly<Record<string, readonly SessionEntry[] | undefined>>
  selectedDeviceId: string | null
}): PiDeviceHubCard[] {
  const sorted = sortShellDevices(input.devices)
  const allSessions = sidebarSessionsOf(sorted, input.rooms, input.sessionsByDevice)
  const sessionsByDev = new Map<string, PiDeviceListedSession[]>()
  for (const s of allSessions) {
    const list = sessionsByDev.get(s.deviceId)
    if (list) list.push(s)
    else sessionsByDev.set(s.deviceId, [s])
  }
  return sorted.map((device) => {
    const devSessions = sessionsByDev.get(device.id) ?? []
    const devRooms = input.rooms.filter((r) => r.deviceId === device.id && r.online)
    const runningCount = devRooms.filter((r) => r.busy).length
    const liveRoomCount = devRooms.length
    const sessionCount = devSessions.length
    const recentTitle = devSessions[0]?.title?.trim() || null
    const folders = collectFolders(device, devSessions)
    const activityLabel =
      runningCount > 0
        ? `${runningCount} 个会话运行中`
        : device.online && sessionCount > 0
          ? `${sessionCount} 个会话 · 随时可用`
          : device.online
            ? "在线 · 可新建会话"
            : sessionCount > 0
              ? `离线 · ${sessionCount} 个历史会话`
              : "当前未连接"
    return {
      id: device.id,
      name: device.name,
      platform: device.platform || "other",
      platformKind: platformKindOf(device.platform),
      platformLabel: platformLabelOf(device.platform),
      online: device.online,
      selected: device.id === input.selectedDeviceId,
      runningCount,
      liveRoomCount,
      sessionCount,
      folders,
      recentTitle,
      activityLabel,
    }
  })
}
