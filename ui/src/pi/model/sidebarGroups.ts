/**
 * 侧栏分组（design §1.2、§3.3 session-list、§10；v1.2 D-07 / M-08，v1.3 R2-M-09）。产品的分组逻辑只有这一份：
 * P3 起 adapters.ts 的 piSessionGroups 在两者重叠处委托给这里。纯函数，node --test 直接加载。
 */
import { attentionForRoom, type AttentionItem } from "../../relay/attention.ts"
import { baseName, type Device, type ListedSession } from "../../relay/devices.ts"
import { rowMarkerOf, type PiRowMarkerKind } from "./rowMarker.ts"

export type PiGrouping = "device" | "flat"

/** 侧栏要的会话：ListedSession 加上所属设备（容器按设备拼好传进来）。 */
export type PiSidebarSession = Pick<ListedSession, "id" | "title" | "cwd" | "online" | "busy" | "updatedAt" | "openable"> & {
  deviceId: string
}
/** 设备按显示顺序传入（容器先用 sortShellDevices 排好）。 */
export type PiSidebarDevice = Pick<Device, "id" | "name" | "online" | "projects" | "platform">

/** 一行会话；字段名与 components/pi/shared/types.ts 的 PiSessionRowData 对齐（time 由容器用 piRelativeTime(at, now) 填）。 */
export type PiSidebarRow = {
  id: string
  title: string
  marker: PiRowMarkerKind
  /** 行尾时间的原始时间戳；没有（0 / 缺失）就不带，行尾不显示时间（§1.9） */
  at?: number
  deviceId?: string
  dimmed?: boolean
  subtitle?: string
  trailingText?: string
  /** 行尾文字的语气（P9 A，D1）：attention = 用 --cw-pi-attention 上色（「等你回答」）。 */
  trailingTone?: "attention"
  platform?: string
}

export type PiSidebarGroup = {
  key: string
  label: string
  deviceId: string
  cwd: string
  offline?: boolean
  rows: PiSidebarRow[]
  more?: number
  folderOnly?: boolean
  expanded?: boolean
  flat?: boolean
}

export type PiSidebarModel = {
  /** 需要处理组的行（放在最上面，两种模式都有） */
  attentionRows: PiSidebarRow[]
  groups: PiSidebarGroup[]
  /** flat 模式超过上限被截掉了：末尾灰字"只列出最近 200 个会话" */
  truncated: boolean
}

export type PiSidebarOptions = {
  /** 设备筛选（设备 id）；null = 全部设备 */
  filter?: string | null
  grouping?: PiGrouping
  /** 已展开"更多 N"的组 key（`${deviceId}:${cwd}`）；flat 模式忽略 */
  expanded?: readonly string[]
  /** device 模式每组露几行（默认 5） */
  maxRows?: number
  /** flat 模式的上限（默认 200） */
  limit?: number
}

export const PI_FLAT_GROUP_KEY = "flat"
export const PI_GROUP_ROWS = 5
export const PI_FLAT_LIMIT = 200

/**
 * device 模式的组头文字（v1.3 R2-M-09：去掉 grouping 参数）："设备名/目录名"；只有一台设备或已筛选到一台时只写目录名。
 * flat 模式的行副标题直接复用它。目录名取不到时：短写返回 null，长写只写设备名。
 */
export function groupHeaderOf(deviceCount: number, filter: string | null | undefined, device: Pick<Device, "name">, cwd: string): string | null {
  const dir = cwd ? baseName(cwd) : ""
  const short = deviceCount <= 1 || Boolean(filter)
  if (short) return dir || null
  return dir ? `${device.name}/${dir}` : device.name
}

/** 组 key：与 usePiUiState 里存的 expanded 同一写法 */
export function sidebarGroupKey(deviceId: string, cwd: string): string {
  return `${deviceId}:${cwd}`
}

/**
 * 等你回答的行尾文案（P9 A，D1）：默认「等你回答」；这条 waiting 的网页不能直接答
 * （只能回电脑上答）时写「等你在电脑上回答」。
 */
export function waitingTrailingText(answerable: boolean | undefined): string {
  return answerable === false ? "等你在电脑上回答" : "等你回答"
}

function rowOf(session: PiSidebarSession, device: PiSidebarDevice, attention: readonly AttentionItem[]): PiSidebarRow {
  const item = attentionForRoom(attention, session.id)
  const row: PiSidebarRow = {
    id: session.id,
    title: session.title,
    marker: rowMarkerOf(item, session.busy, session.online, session.openable),
    deviceId: device.id,
  }
  if (item?.kind === "waiting") {
    row.trailingText = waitingTrailingText(item.answerable)
    row.trailingTone = "attention"
  } else if (item?.kind === "error") {
    // 设计 D §2.4 第二层：waiting 之外，error 行的行尾时间位也让位给状态词；完整时间进悬停气泡
    row.trailingText = "出错了"
  }
  if (session.updatedAt > 0) row.at = session.updatedAt
  if (!device.online) row.dimmed = true
  return row
}

/** 需要处理组：每条注意力一行；waiting 行尾「等你回答」/「等你在电脑上回答」，设备掉线行尾"未连接"。 */
function attentionRowsOf(attention: readonly AttentionItem[], devices: readonly PiSidebarDevice[]): PiSidebarRow[] {
  return attention.map((item) => {
    if (item.kind === "device-offline") {
      const device = devices.find((x) => x.id === item.deviceId)
      const row: PiSidebarRow = { id: item.key, title: item.title, marker: "idle", trailingText: "未连接" }
      if (device?.platform) row.platform = device.platform
      if (item.deviceId) row.deviceId = item.deviceId
      return row
    }
    const marker: PiRowMarkerKind = item.kind === "waiting" ? "waiting" : item.kind === "error" ? "error" : "unread"
    const row: PiSidebarRow = { id: item.roomId, title: item.title, marker }
    if (item.kind === "waiting") {
      row.trailingText = waitingTrailingText(item.answerable)
      row.trailingTone = "attention"
    } else if (item.kind === "error") {
      // 设计 D §2.4 第二层：error 行的行尾时间位让位给状态词；完整时间进悬停气泡
      row.trailingText = "出错了"
    }
    if (item.at > 0) row.at = item.at
    if (item.deviceId) row.deviceId = item.deviceId
    return row
  })
}

/**
 * 会话 → 侧栏模型。
 * - device：按（设备, cwd）分组，设备照传入顺序、目录照 projects 顺序（会话里多出来的目录接在后面）；
 *   组内在线在前、再按 updatedAt 新到旧；每组露 maxRows 行 + more；expanded 里的组出全部行（末行由 PiSidebar 渲染"收起"）；
 *   没有会话的目录是文件夹行；设备离线整组 offline、行 dimmed。
 * - flat：一个按 updatedAt 倒序的列表，不折叠、不出文件夹行，上限 limit；行带 subtitle（groupHeaderOf，离线接" · 未连接"）。
 * 设备不在 devices 里的会话不出现（没有设备就没有归属，不猜）。
 */
export function sidebarGroups(
  sessions: readonly PiSidebarSession[],
  devices: readonly PiSidebarDevice[],
  attention: readonly AttentionItem[],
  options: PiSidebarOptions = {},
): PiSidebarModel {
  const { filter = null, grouping = "device", expanded = [], maxRows = PI_GROUP_ROWS, limit = PI_FLAT_LIMIT } = options
  const shown = filter ? devices.filter((x) => x.id === filter) : devices
  const attentionRows = attentionRowsOf(attention, devices)

  if (grouping === "flat") {
    const all = sessions
      .flatMap((session) => {
        const device = shown.find((d) => d.id === session.deviceId)
        return device ? [{ session, device }] : []
      })
      .sort((a, b) => b.session.updatedAt - a.session.updatedAt)
    const rows = all.slice(0, limit).map(({ session, device }) => {
      const row = rowOf(session, device, attention)
      const where = groupHeaderOf(shown.length, filter, device, session.cwd)
      if (where) row.subtitle = device.online ? where : `${where} · 未连接`
      return row
    })
    const groups: PiSidebarGroup[] = rows.length ? [{ key: PI_FLAT_GROUP_KEY, label: "", deviceId: filter ?? "", cwd: "", rows, flat: true }] : []
    return { attentionRows, groups, truncated: all.length > limit }
  }

  // 长会话列表（R4 性能）：只扫一遍把 session 按 device+cwd 分桶，并且按出现顺序记下「不在 projects 里的 cwd」，
  // 之后按设备/目录顺序组装。原实现是 设备×目录×会话 的重复 filter（2000 会话 / 20 设备≈9.5ms，展开≈18.6ms），
  // 这里是 O(sessions + groups)；输出与旧实现逐字段一致（fuzz 对比过）。
  const byKey = new Map<string, PiSidebarSession[]>()
  const extraCwdsOf = new Map<string, string[]>()
  for (const session of sessions) {
    const key = `${session.deviceId}\u0000${session.cwd}`
    const bucket = byKey.get(key)
    if (bucket) bucket.push(session)
    else byKey.set(key, [session])
    let extras = extraCwdsOf.get(session.deviceId)
    if (!extras) {
      extras = []
      extraCwdsOf.set(session.deviceId, extras)
    }
    if (!extras.includes(session.cwd)) extras.push(session.cwd)
  }

  const open = new Set(expanded)
  const groups: PiSidebarGroup[] = []
  for (const device of shown) {
    const extraCwds = extraCwdsOf.get(device.id) ?? []
    const cwds = [...device.projects]
    for (const cwd of extraCwds) if (!cwds.includes(cwd)) cwds.push(cwd)
    for (const cwd of cwds) {
      const mine = byKey.get(`${device.id}\u0000${cwd}`) ?? []
      mine.sort((a, b) => Number(b.online) - Number(a.online) || b.updatedAt - a.updatedAt)
      const key = sidebarGroupKey(device.id, cwd)
      const unfolded = open.has(key) && mine.length > maxRows
      const group: PiSidebarGroup = {
        key,
        label: groupHeaderOf(shown.length, filter, device, cwd) ?? "",
        deviceId: device.id,
        cwd,
        rows: (unfolded ? mine : mine.slice(0, maxRows)).map((x) => rowOf(x, device, attention)),
      }
      if (!device.online) group.offline = true
      if (!unfolded && mine.length > maxRows) group.more = mine.length - maxRows
      if (mine.length === 0) group.folderOnly = true
      if (unfolded) group.expanded = true
      groups.push(group)
    }
  }
  return { attentionRows, groups, truncated: false }
}
