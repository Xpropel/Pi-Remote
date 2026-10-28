/**
 * 桌面壳设备条（§4.3.1）的纯排序逻辑。不伪造字段：
 * 在线优先；同一组内按设备首次连接时间从早到晚（earliest first），不按最近活跃倒序。
 * 当前设备不占固定槽位：选中只改高亮，不参与排序；不在前 6 台时按正常顺序留在 overflow。
 * 上限 6 槽 + 管理钮（+N = 未显示台数）。
 */
import { sortDevicesForStrip, type StripDevice } from "../chat/deviceStripModel.ts"

/** 桌面壳设备条上限：6 台设备 + 末尾管理钮。 */
export const SHELL_DEVICE_LIMIT = 6

/** 在线优先，其次首次连接从早到晚；同一时间用名称与 id 保持稳定顺序。 */
export function sortShellDevices(devices: readonly StripDevice[]): StripDevice[] {
  return sortDevicesForStrip(devices)
}

export type ShellDeviceSelection = {
  /** 渲染槽位：在线优先、首次连接从早到晚；当前设备不再强制第 1 槽。 */
  visible: StripDevice[]
  /** 未显示台数，用于管理钮 +N；0 时显示 plus。 */
  overflow: number
  /** 当前设备；没有选中 / 名册里找不到时为 null。仅用于高亮，不参与排序。 */
  current: StripDevice | null
}

/**
 * 选取设备条槽位：完全按正常展示顺序取前 `limit` 台。
 * 当前设备即使离线、即使排在第 7 台，也只按它的正常位置出现/留在 overflow，绝不置顶。
 */
export function shellDeviceSelection(
  devices: readonly StripDevice[],
  selectedId: string | null | undefined,
  limit = SHELL_DEVICE_LIMIT,
): ShellDeviceSelection {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : SHELL_DEVICE_LIMIT
  const all = [...devices]
  const current = selectedId ? all.find((device) => device.id === selectedId) || null : null
  const sorted = sortShellDevices(all)
  return { visible: sorted.slice(0, max), overflow: Math.max(0, all.length - Math.min(max, all.length)), current }
}
