/**
 * 命令面板（plan §7.3 command-palette、P5.5 c 线；design G01 G07 B14）。纯函数，node --test 直接加载。
 * 命令组是界面口径（design 的九条，键帽由部件按 shortcuts.ts 算）；会话组来自所有设备的会话（mergeDeviceSessions），
 * 行首标记按真实注意力（attentionForRoom + rowMarkerOf），组名"设备名/目录名"。
 */
import { attentionForRoom, type AttentionItem } from "../../relay/attention.ts"
import { attributeSessionsAcrossDevices, baseName, mergeDeviceSessions, pathKeyOf, type Device, type ListedSession, type RoomInfo, type SessionEntry } from "../../relay/devices.ts"
import type { BodySearchPage } from "../../shell/searchModel.ts"
import { rowMarkerOf, type PiRowMarkerKind } from "./rowMarker.ts"

export type PiPaletteIcon = "new" | "sidebar" | "pane" | "compact" | "regenerate" | "tree" | "usage" | "inspect" | "settings"
export type PiPaletteCommand = { key: string; label: string; icon: PiPaletteIcon }

/** 命令组（design c/command-palette）。⌘K 只开这里（D-01） */
export const PI_PALETTE_COMMANDS: readonly PiPaletteCommand[] = [
  { key: "new", label: "新建会话", icon: "new" },
  { key: "sidebar", label: "切换侧栏", icon: "sidebar" },
  { key: "pane", label: "打开 / 关闭右侧面板", icon: "pane" },
  { key: "compact", label: "压缩上下文", icon: "compact" },
  { key: "regenerate", label: "重新回答", icon: "regenerate" },
  { key: "tree", label: "会话树", icon: "tree" },
  { key: "usage", label: "用量", icon: "usage" },
  { key: "inspect", label: "检视本机信息", icon: "inspect" },
  { key: "settings", label: "设置", icon: "settings" },
]

/** 没有查询时列几个最近的会话（design：最近 4 个）；有查询时最多在 50 条里搜（plan §7.3） */
export const PALETTE_RECENT = 4
export const PALETTE_SESSIONS_MAX = 50

export type PiPaletteSession = {
  id: string
  title: string
  marker: PiRowMarkerKind
  /** "设备名/目录名" */
  group: string
  deviceId: string
  updatedAt: number
  /** 原始行（执行时交给 selectRoom / selectListedSession） */
  row: ListedSession
}

/**
 * 所有设备的会话（逐台 mergeDeviceSessions）：当前会话排第一（design c/command-palette 的会话组以当前会话 r-s1 开头），
 * 其余按最近活动倒序，最多 PALETTE_SESSIONS_MAX 条。
 */
export function paletteSessionsOf(input: {
  devices: readonly Device[]
  rooms: readonly RoomInfo[]
  sessionsByDevice: Readonly<Record<string, readonly SessionEntry[]>>
  attention: readonly AttentionItem[]
  currentRoomId?: string | null
}): PiPaletteSession[] {
  // Same cross-device attribution as the sidebar (B-1): a session two
  // devices claim is offered once, under its owning device.
  const deviceById = new Map(input.devices.map((device) => [device.id, device]))
  const tagged: (ListedSession & { deviceId: string })[] = []
  for (const device of input.devices) {
    for (const s of mergeDeviceSessions(device, [...input.rooms], [...(input.sessionsByDevice[device.id] ?? [])])) {
      tagged.push({ ...s, deviceId: device.id })
    }
  }
  const rows: PiPaletteSession[] = []
  for (const s of attributeSessionsAcrossDevices(tagged)) {
    const { deviceId, ...row } = s
    const device = deviceById.get(deviceId)
    const marker = rowMarkerOf(attentionForRoom(input.attention, s.id), s.busy, s.online, s.openable)
    rows.push({ id: s.id, title: s.title, marker, group: `${device?.name ?? deviceId}/${baseName(s.cwd)}`, deviceId, updatedAt: s.updatedAt ?? 0, row })
  }
  const current = input.currentRoomId ?? ""
  return rows
    .sort((a, b) => (a.id === current ? -1 : b.id === current ? 1 : b.updatedAt - a.updatedAt))
    .slice(0, PALETTE_SESSIONS_MAX)
}

/** One body-search hit as a palette row (A-3: the palette's lower "body matches" section). */
export type PiPaletteBodyHit = {
  id: string
  title: string
  /** "device name / directory name", same shape as the session rows */
  group: string
  /** First matching snippet ("" when the extension sent none) */
  snippet: string
  matchCount: number
  /** Host-side session file path (the open fallback when the hit is outside the listed window) */
  session: string
  cwd: string
  mtime: number
  deviceId: string
}

/**
 * Body-search page -> palette body rows. Body search runs on ONE device (the
 * selected one; the extension scans that device's plaintext session files, and
 * the relay refuses enc rooms before the command ever leaves the server), so
 * every row is stamped with that device. Hits the title section already shows
 * (same session id, or the same file path by the shared device-path rule,
 * pathKeyOf) are dropped: a session must appear once, in the title section.
 * Page order is kept (the merge already sorted by mtime, newest first).
 */
export function paletteBodyHitsOf(
  page: BodySearchPage,
  device: { id: string; name: string; platform?: string | null },
  exclude: readonly { id: string; path?: string }[],
): PiPaletteBodyHit[] {
  const norm = (path: string) => pathKeyOf(path, device.platform)
  const shownIds = new Set(exclude.map((x) => x.id))
  const shownPaths = new Set(exclude.flatMap((x) => (x.path ? [norm(x.path)] : [])))
  return page.results
    .filter((hit) => !shownIds.has(hit.id) && !shownPaths.has(norm(hit.session)))
    .map((hit) => ({
      id: hit.id,
      title: hit.title,
      group: `${device.name}/${baseName(hit.cwd)}`,
      snippet: hit.snippets[0]?.text ?? "",
      matchCount: hit.matchCount,
      session: hit.session,
      cwd: hit.cwd,
      mtime: hit.mtime,
      deviceId: device.id,
    }))
}

/** 离线时命令行禁用的原因（设置、切换侧栏、开关右 pane 照常可用） */
export function paletteOfflineReasonOf(input: {
  authed: boolean
  browserOnline: boolean
  roomId: string
  online: boolean
  /** false = 只点选、还没载入的会话 */
  loaded: boolean
  deviceName?: string | null
}): string | null {
  if (!input.authed || !input.browserOnline) return "未连接服务器 · 会话命令暂时不能用"
  if (!input.roomId) return "先选一个会话 · 会话命令要在会话里用"
  if (!input.loaded) return "会话还没载入 · 发第一条之后才能用会话命令"
  if (!input.online) return `${input.deviceName ? `${input.deviceName} ` : "设备"}未连接 · 会话命令暂时不能用`
  return null
}
