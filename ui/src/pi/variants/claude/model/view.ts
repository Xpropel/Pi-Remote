import { useMemo } from "react"
import { useNow } from "../primitives/useClaude"
import { devicesOfPlatformTab } from "./platformUi"
import type { PiUiPlatformTab } from "@/pi/extensions"
import type { PiContainerProps, Relay } from "@/pi/containers/types"
import { attentionForRoom, type AttentionItem } from "@/relay/attention"
import { contextReadout } from "@/relay/contextUsage"
import type { Device, RoomInfo } from "@/relay/devices"
import { pageLinkView } from "@/relay/presence"
import { bootInputOf, bootViewOf } from "@/pi/model/boot"
import { rowMarkerA11y, rowMarkerOf } from "@/pi/model/rowMarker"
import { changesOfSession } from "@/pi/model/changes"
import { sidebarDataOf, sidebarSessionsOf, type PiDeviceListedSession, type PiSidebarData } from "@/pi/model/sidebarSource"
import { sidebarGroups, type PiSidebarGroup, type PiSidebarRow } from "@/pi/model/sidebarGroups"
import { relativeLong, relativeShort } from "../model/format"

/**
 * Claude v2 的取数层：只 import 允许的纯逻辑（@/relay/**、@/pi/model/**），把 relay 切片整理成
 * Claude 布局要的形状（标题栏胶囊 / 侧栏分组 / session rail 卡片 / 手机列表行）。
 */

export type ClaudeSessionHead = {
  room: RoomInfo | null
  device: Device | null
  title: string
  cwd: string
  /** 会话已载入（不是只点选的 lazySession） */
  loaded: boolean
}

export function sessionHeadOf(relay: Relay): ClaudeSessionHead {
  const room = relay.rooms.find((r) => r.id === relay.roomId) ?? null
  const row = relay.rooms.length ? null : null
  void row
  const deviceId = room?.deviceId ?? relay.selectedDevice?.id ?? null
  const device = relay.devices.find((d) => d.id === deviceId) ?? null
  const title = room?.name || room?.label || room?.firstMessage || relay.lazySession?.title || relay.roomId || ""
  return { room, device, title, cwd: room?.cwd ?? "", loaded: !(relay.lazySession && relay.lazySession.id === relay.roomId) }
}

/** 侧栏 / 手机列表 / 命令面板共用的那一片数据 */
export function sidebarDataFor(relay: Relay): PiSidebarData {
  return sidebarDataOf({
    devices: relay.devices,
    rooms: relay.rooms,
    sessionsByDevice: relay.sessionsByDevice,
    roomId: relay.roomId,
    dialogs: relay.dialogs,
    uiPrompt: relay.uiPrompt,
    turnEnd: relay.turnEnd,
    roomTurnEnds: relay.roomTurnEnds,
    selectedDevice: relay.selectedDevice,
  })
}

export type ClaudeSidebarModel = {
  data: PiSidebarData
  groups: PiSidebarGroup[]
  attentionRows: ClaudeListRow[]
  truncated: boolean
}

export type ClaudeListRow = {
  id: string
  title: string
  marker: ReturnType<typeof rowMarkerOf>
  time?: string
  timeLabel?: string
  deviceId?: string
  dimmed?: boolean
  platform?: string
  trailingText?: string
  trailingTone?: "attention"
  /** 原始会话行（点开 / 菜单要） */
  session?: PiDeviceListedSession
  /** device-offline 条目：点它只换设备 */
  deviceOnly?: boolean
}

export function useSidebarModel(p: PiContainerProps, platform: PiUiPlatformTab = "all"): ClaudeSidebarModel {
  const { relay, ui } = p
  // relay 对象按房间状态更新；流式帧只在 transcript 里，不会触发这一层重算
  const raw = useMemo(() => sidebarDataFor(relay), [relay])
  // P4 Wave1：平台标签过滤（全部 / Mac / Windows / Linux）：设备、会话、需要处理项一起筛
  const data = useMemo(() => {
    if (platform === "all") return raw
    const devices = devicesOfPlatformTab(raw.devices, platform)
    const deviceIds = new Set(devices.map((device) => device.id))
    return {
      ...raw,
      devices,
      sessions: raw.sessions.filter((session) => !!session.deviceId && deviceIds.has(session.deviceId)),
      attention: raw.attention.filter((item) => {
        const deviceId = (item as { deviceId?: string }).deviceId
        return !!deviceId && deviceIds.has(deviceId)
      }),
    }
  }, [raw, platform])
  const now = useNow(30_000)
  const filterId = ui.prefs.deviceFilter && data.devices.some((d) => d.id === ui.prefs.deviceFilter) ? ui.prefs.deviceFilter : null
  const groups = useMemo(
    () => sidebarGroups(data.sessions, data.devices, data.attention, { filter: filterId, grouping: ui.prefs.grouping, expanded: ui.expanded }).groups,
    [data, filterId, ui.prefs.grouping, ui.expanded],
  )
  const attentionRows = useMemo(() => attentionRowsOf(data.attention, data.devices, now), [data.attention, data.devices, now])
  return { data, groups, attentionRows, truncated: relay.sessionsTruncated === true }
}

/** 需要处理组 / 注意力行（P9 A：等你回答、出错、设备未连接） */
export function attentionRowsOf(attention: readonly AttentionItem[], devices: readonly Device[], now: number): ClaudeListRow[] {
  return attention.map((item) => {
    if (item.kind === "device-offline") {
      const device = devices.find((d) => d.id === item.deviceId)
      return { id: item.key, title: item.title, marker: "idle", platform: device?.platform ?? "", trailingText: "未连接", deviceId: item.deviceId ?? undefined, deviceOnly: true }
    }
    const marker = item.kind === "waiting" ? "waiting" : item.kind === "error" ? "error" : "unread"
    return {
      id: item.roomId,
      title: item.title,
      marker,
      time: item.at ? relativeShort(item.at, now) : undefined,
      timeLabel: item.at ? relativeLong(item.at, now) : undefined,
      trailingText: item.kind === "waiting" ? (item.answerable === false ? "等你在电脑上回答" : "等你回答") : undefined,
      trailingTone: item.kind === "waiting" ? "attention" : undefined,
      deviceId: item.deviceId ?? undefined,
    }
  })
}

/** 分组里的行 → 展示行 */
export function listRowsOf(group: PiSidebarGroup, now: number): ClaudeListRow[] {
  return group.rows.map((row) => rowOf(row, now))
}

export function rowOf(row: PiSidebarRow, now: number): ClaudeListRow {
  return {
    id: row.id,
    title: row.title,
    marker: row.marker,
    time: relativeShort(row.at, now),
    deviceId: row.deviceId,
    dimmed: row.dimmed,
    platform: row.platform,
    trailingText: row.trailingText,
    trailingTone: row.trailingTone,
  }
}

/** 行首标记的读屏名 */
export function markerLabel(marker: ClaudeListRow["marker"]): string | null {
  const a11y = rowMarkerA11y(marker)
  return a11y.hidden ? null : a11y.label
}

/** 连接摘要（账户区 / 服务器卡）：页面层只读 presence 纯函数 */
export function linkSummaryOf(relay: Relay): { kind: "ok" | "first" | "waiting" | "reconnecting"; text: string } {
  const link = pageLinkView(relay, Date.now())
  const devices = relay.devices
  switch (link.kind) {
    case "ok": {
      if (devices.length === 0) return { kind: "ok", text: "已连接 · 还没有设备" }
      const online = devices.filter((d) => d.online).length
      return { kind: "ok", text: online ? `已连接 · ${online} 台设备在线` : `已连接 · ${devices.length} 台设备都未连接` }
    }
    case "first":
      return { kind: "first", text: "正在连接…" }
    case "waiting":
      return { kind: "waiting", text: "与服务器断开" }
    case "reconnecting":
      return { kind: "reconnecting", text: "正在重连…" }
  }
}

/** 连接状态行（桌面主区顶部的细条；连接正常时不画） */
export type ClaudeLinkLine = { kind: "waiting" | "reconnecting" | "offline" | "restored"; text: string } | null

export function useClaudeLinkLine(p: PiContainerProps, now: number): ClaudeLinkLine {
  const { relay } = p
  if (!relay.authed) return null
  const link = pageLinkView(relay, now)
  if (link.kind === "ok") return null
  const attempt = relay.retryCount > 0 ? `（第 ${relay.retryCount} 次重试）` : ""
  if (link.kind === "first") return { kind: "reconnecting", text: "正在连接服务器…" }
  if (link.kind === "reconnecting") return { kind: "reconnecting", text: `正在重连${attempt}` }
  if (relay.everConnected && now - (relay.retryAt ?? now) > 30_000 && (relay.retryAt ?? 0) < now) {
    return { kind: "offline", text: "与服务器断开，正在按退避重试" }
  }
  return { kind: "waiting", text: `与服务器断开，${link.seconds} 秒后重试${attempt}` }
}

/** 启动 / 空态 */
export function bootViewOfRelay(relay: Relay): { kind: "connecting" | "no-devices" | "all-offline" | "ready"; count?: number; pairing?: boolean } {
  const sessionCount = sidebarSessionsOf(relay.devices, relay.rooms, relay.sessionsByDevice).length
  const view = bootViewOf(bootInputOf(relay, sessionCount))
  return view as { kind: "connecting" | "no-devices" | "all-offline" | "ready"; count?: number; pairing?: boolean }
}

/** session rail 的数据（环境 / 上下文 / 变更 / 任务 / 服务器） */
export type ClaudeRailData = {
  context: ReturnType<typeof contextReadout>
  contextPercent: number | null
  changes: { added: number; removed: number; files: number } | null
  tasks: { done: number; total: number; active: string | null }
  deviceLine: string
  terminalCount: number
}

export function useRailData(p: PiContainerProps): ClaudeRailData {
  const { relay } = p
  const items = relay.roomId ? relay.transcript.items : null
  const changes = useMemo(() => {
    const view = changesOfSession(items)
    return view ? { added: view.added, removed: view.removed, files: view.files.length } : null
  }, [items])
  const context = useMemo(
    () => contextReadout((relay.usage?.contextUsage ?? null) as Parameters<typeof contextReadout>[0]),
    [relay.usage],
  )
  const tasks = useMemo(() => {
    const list = relay.taskList ?? []
    const done = list.filter((t) => t.status === "completed").length
    const active = list.find((t) => t.status === "in_progress")?.activeForm ?? null
    return { done, total: list.length, active }
  }, [relay.taskList])
  const deviceLine = relay.selectedDevice ? `${relay.selectedDevice.name}${relay.selectedDevice.online ? "" : " · 未连接"}` : "没有设备"
  return { context, contextPercent: context.percent, changes, tasks, deviceLine, terminalCount: relay.terminalItems?.length ?? 0 }
}

/** 当前会话在列表里的行（删除 / 改名 / 菜单要用的完整会话数据） */
export function sessionRowById(data: PiSidebarData, id: string | undefined): PiDeviceListedSession | undefined {
  if (!id) return undefined
  return data.sessions.find((s) => s.id === id)
}

/** 当前选中的会话是否已载入（房间级命令可用） */
export function sessionLoaded(relay: Relay): boolean {
  return !(relay.lazySession && relay.lazySession.id === relay.roomId)
}

/** 当前会话在设备上的标签：设备名 · 目录名（标题栏胶囊 / 会话信息） */
export function headSubtitle(head: ClaudeSessionHead): string {
  const dev = head.device?.name ?? ""
  const cwd = head.cwd ? head.cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? "" : ""
  return [dev, cwd].filter(Boolean).join(" · ")
}

/** 搜索：会话 + 命令（命令面板自己的结果计算，不依赖 cursor 的 palette 组件） */
export function sessionSearchRows(p: PiContainerProps, query: string): ClaudeListRow[] {
  const data = sidebarDataFor(p.relay)
  const q = query.trim().toLowerCase()
  const rows: ClaudeListRow[] = []
  for (const session of data.sessions) {
    if (q && !`${session.title} ${session.cwd ?? ""}`.toLowerCase().includes(q)) continue
    const attention = attentionForRoom(data.attention, session.id)
    const marker = rowMarkerOf(attention, session.busy, session.online, session.openable)
    rows.push({ id: session.id, title: session.title, marker, deviceId: session.deviceId, time: relativeShort(session.updatedAt, Date.now()), session })
    if (rows.length >= 50) break
  }
  return rows
}

/** 打开一行会话（侧栏 / 手机列表 / 命令面板共用）：别的设备先换过去；未载入的按列表行只本地点选 */
export function openSessionRowFor(
  relay: Relay,
  act: PiContainerProps["act"],
  row: { id: string; deviceId?: string; openable?: boolean } & Record<string, unknown>,
): void {
  if (row.id !== relay.roomId) {
    if (row.deviceId && row.deviceId !== relay.selectedDeviceId) relay.selectDevice(row.deviceId)
    if (row.openable) relay.selectRoom(row.id)
    else relay.selectListedSession(row as never)
  }
  act.openSession()
}

/** 侧栏 Hub Rail 三段（[C-图8②]） */
export type ClaudeHubTab = "sessions" | "attention" | "devices"

export const CLAUDE_HUB_LABEL: Record<ClaudeHubTab, string> = { sessions: "会话", attention: "需要处理", devices: "设备" }
