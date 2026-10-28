import type { PiContainerProps } from "@/pi/containers/types"
import type { Device } from "@/relay/devices"
import {
  PI_UI_PLATFORM_LABEL,
  PI_UI_PLATFORMS,
  PI_UI_PLATFORM_TABS,
  piUiPlatformOf,
  type PiUiPlatform,
  type PiUiPlatformTab,
} from "@/pi/extensions"

/**
 * P4 W1 平台标签的变体侧薄封装（台账 §3 / 契约 `@/pi/extensions/platform-prefs`）：
 * 平台枚举 / 标签 / 设备→平台映射都来自契约，本文件只做「设备列表 ↔ 平台」的纯函数适配，不复制契约口径。
 * 选择结果写 prefs：`uiPlatformTab`（一级粗筛）+ `deviceByPlatform`（平台内上次设备）+ `deviceFilter`（细筛）。
 */
export type PlatformCounts = Record<PiUiPlatformTab, number>

export function platformTabOfDevice(platform: string | null | undefined): PiUiPlatform | null {
  return piUiPlatformOf(platform)
}

export function devicesOfPlatformTab(devices: readonly Device[], tab: PiUiPlatformTab): Device[] {
  if (tab === "all") return [...devices]
  return devices.filter((device) => platformTabOfDevice(device.platform) === tab)
}

export function platformCountsOf(devices: readonly Device[]): PlatformCounts {
  const counts: PlatformCounts = { all: devices.length, macos: 0, windows: 0, linux: 0 }
  for (const device of devices) {
    const platform = platformTabOfDevice(device.platform)
    if (platform) counts[platform] += 1
  }
  return counts
}

export function platformTabLabel(tab: PiUiPlatformTab): string {
  return PI_UI_PLATFORM_LABEL[tab]
}

export const PLATFORM_TAB_KEYS = PI_UI_PLATFORM_TABS

export function platformTabOf(platform: PiUiPlatform): PiUiPlatformTab {
  return platform
}

export const PLATFORM_TABS = PI_UI_PLATFORMS

/**
 * 平台切换统一入口（标题栏点选与 ⌘⌥1–4 共用，台账 §3.2）：
 * - 全部：uiPlatformTab=all + deviceFilter=null
 * - 平台：优先该平台上次设备（deviceByPlatform）→ 第一台在线 → 第一台；无设备则只切粗筛（列表空态给配对入口）
 */
export function selectPlatformTab(p: Pick<PiContainerProps, "relay" | "act" | "ui">, tab: PiUiPlatformTab): void {
  const { relay, act, ui } = p
  act.setPref("uiPlatformTab", tab)
  if (tab === "all") {
    act.setPref("deviceFilter", null)
    return
  }
  const devices = devicesOfPlatformTab(relay.devices as Device[], tab)
  const remembered = ui.prefs.deviceByPlatform[tab]
  const picked = devices.find((device) => device.id === remembered) ?? devices.find((device) => device.online) ?? devices[0]
  if (!picked) {
    act.setPref("deviceFilter", null)
    return
  }
  act.setPref("deviceFilter", picked.id)
  act.setPref("deviceByPlatform", { ...ui.prefs.deviceByPlatform, [tab]: picked.id })
}

/** 设备 → 平台标签（从「全部」点会话自动跟随平台，台账 §3.2） */
export function platformTabOfDeviceId(p: Pick<PiContainerProps, "relay">, deviceId: string | undefined): PiUiPlatform | null {
  if (!deviceId) return null
  const device = (p.relay.devices as Device[]).find((item) => item.id === deviceId)
  return device ? platformTabOfDevice(device.platform) : null
}
