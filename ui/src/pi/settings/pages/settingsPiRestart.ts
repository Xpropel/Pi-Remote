/**
 * 设置 › Pi 重启 · 纯逻辑（无 React / 无 DOM，node --test 直载）。
 *
 * 统一「从任一设置页重启所连设备 Pi」的设备解析、能力校验、状态展示文案。
 * 真实重启能力沿用 attach.cjs / systemOpsLogic.ts 的 `harness_restart`（device.ops）。
 */
import { deviceNameOf } from "./devicesLogic.ts"
import { settingsFallbackDeviceIdOf, SETTINGS_RESTART_APPLIED_TEXT, type SettingsRelayLike } from "./settingsWrite.ts"
import {
  SYSTEM_OPS_NO_COMMAND_TEXT,
  SYSTEM_OPS_OFFLINE_TEXT,
  SYSTEM_OPS_UNSUPPORTED_TEXT,
  deviceBusyOf,
  deviceOpsSupportedOf,
  type DeviceBusy,
  type RoomBusyLike,
} from "./systemOpsLogic.ts"

export interface SettingsPiRestartDevice {
  id: string
  name?: string | null
  platform?: string | null
  online?: boolean
  bridgeOnline?: boolean
  features?: readonly string[] | null
}

export interface SettingsPiRestartRoom extends RoomBusyLike {
  id: string
}

export interface SettingsPiRestartRelay extends SettingsRelayLike {
  online?: boolean
  browserOnline?: boolean
  devices?: readonly SettingsPiRestartDevice[]
  rooms?: readonly SettingsPiRestartRoom[]
  runDeviceCommand?: (deviceId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>
}

export type SettingsPiRestartPhase = "idle" | "running" | "succeeded" | "failed"

export interface SettingsPiRestartTarget {
  deviceId: string | null
  deviceName: string
  canRestart: boolean
  /** 不可重启时的明确原因（离线 / 缺少 device.ops / 浏览器离线 / 无可用设备）。 */
  reason: string
  busy: DeviceBusy
}

export interface SettingsPiRestartBannerModel {
  tone: "warn" | "ok" | "bad"
  title: string
  description: string
  buttonLabel: string
  buttonDisabled: boolean
}

function deviceOnlineOf(device: SettingsPiRestartDevice): boolean {
  return Boolean(device.online ?? device.bridgeOnline)
}

/**
 * 解析当前设置页应重启哪台设备上的 Pi：
 *   1. 已显式选中的设备（selectedDeviceId）—— 即使该设备当前离线，也不静默跳到别的设备；
 *   2. 按设置写桥规则解析（当前会话所在设备 / 唯一在线设备）；
 *   3. 未选设备且有多台记录时，若唯一一台在线设备具备 device.ops 能力，自动锚定到它。
 */
export function resolveSettingsPiRestartDevice(
  relay: SettingsPiRestartRelay | null | undefined,
): SettingsPiRestartDevice | null {
  const devices = Array.isArray(relay?.devices) ? relay.devices : []
  if (devices.length === 0) return null

  const explicitId = (relay?.selectedDeviceId ?? "").trim()
  if (explicitId) {
    return devices.find((d) => d.id === explicitId) ?? null
  }

  const fallbackId = (settingsFallbackDeviceIdOf(relay ?? {}) ?? "").trim()
  if (fallbackId) {
    const found = devices.find((d) => d.id === fallbackId)
    if (found) return found
  }

  if (devices.length === 1) return devices[0] ?? null

  const onlineDevices = devices.filter(deviceOnlineOf)
  if (onlineDevices.length === 1) return onlineDevices[0] ?? null

  const onlineOpsDevices = onlineDevices.filter((d) => deviceOpsSupportedOf(d))
  if (onlineOpsDevices.length === 1) return onlineOpsDevices[0] ?? null

  return null
}

/** 计算当前目标设备的重启可用性、设备展示名与会话忙碌占用。 */
export function settingsPiRestartTargetOf(
  relay: SettingsPiRestartRelay | null | undefined,
): SettingsPiRestartTarget {
  const device = resolveSettingsPiRestartDevice(relay)
  if (!device || !device.id) {
    const hasDevices = Array.isArray(relay?.devices) && relay.devices.length > 0
    return {
      deviceId: null,
      deviceName: "设备",
      canRestart: false,
      reason: hasDevices ? "请先在「设备」选择一台在线设备" : "当前没有已配对设备",
      busy: { generating: false, pendingDialog: false },
    }
  }

  const deviceId = device.id
  const deviceName = deviceNameOf(device)
  const busy = deviceBusyOf(relay?.rooms, deviceId)

  if (relay?.browserOnline === false) {
    return { deviceId, deviceName, canRestart: false, reason: "浏览器离线，无法执行重启", busy }
  }
  if (!deviceOnlineOf(device)) {
    return { deviceId, deviceName, canRestart: false, reason: SYSTEM_OPS_OFFLINE_TEXT, busy }
  }
  if (!deviceOpsSupportedOf(device)) {
    return { deviceId, deviceName, canRestart: false, reason: SYSTEM_OPS_UNSUPPORTED_TEXT, busy }
  }
  if (typeof relay?.runDeviceCommand !== "function") {
    return { deviceId, deviceName, canRestart: false, reason: SYSTEM_OPS_NO_COMMAND_TEXT, busy }
  }

  return { deviceId, deviceName, canRestart: true, reason: "", busy }
}

/** 统一生成左栏 / 手机首页 / 设置页的「重启 Pi」卡片与状态文案。 */
export function settingsPiRestartBannerOf({
  pendingRestart,
  phase,
  error,
  canRestart,
  unsupportedReason,
}: {
  pendingRestart: boolean
  phase: SettingsPiRestartPhase
  error?: string
  canRestart: boolean
  unsupportedReason: string
}): SettingsPiRestartBannerModel {
  if (phase === "running") {
    return {
      tone: "warn",
      title: "正在重启 Pi…",
      description: "正在重启所连设备上的 Pi 进程，完成后设置将自动生效",
      buttonLabel: "重启中…",
      buttonDisabled: true,
    }
  }
  if (phase === "failed") {
    return {
      tone: "bad",
      title: "重启 Pi 失败",
      description: error?.trim() || "未能完成重启，可在「设备 › 系统操作」查看详细状态",
      buttonLabel: "重试重启",
      buttonDisabled: !canRestart,
    }
  }
  if (phase === "succeeded") {
    return {
      tone: "ok",
      title: SETTINGS_RESTART_APPLIED_TEXT,
      description: "当前设置已同步到运行中的 Pi",
      buttonLabel: "重启 Pi",
      buttonDisabled: !canRestart,
    }
  }
  if (pendingRestart) {
    return {
      tone: "warn",
      title: "有设置待重启 Pi 生效",
      description: canRestart ? "保存后需重启所连设备上的 Pi 进程才能生效" : unsupportedReason,
      buttonLabel: "重启 Pi",
      buttonDisabled: !canRestart,
    }
  }
  return {
    tone: "ok",
    title: "重启 Pi",
    description: canRestart
      ? "重启所连设备上的 Pi 进程，让已写入配置文件的设置立即生效"
      : unsupportedReason,
    buttonLabel: "重启 Pi",
    buttonDisabled: !canRestart,
  }
}

export const SETTINGS_PI_RESTART_TIMEOUT_TEXT = "重启超时，请检查设备连接或到「设备 › 系统操作」确认状态"
