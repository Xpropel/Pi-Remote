/**
 * 平台记忆（设备平台标签）+ Codex 运行位置契约（P4.1；Lead 已批 Q1/Q2/Q3，台账 §3.2 / §4.1）。
 *
 * **prefs 预留（Q1）**：`PiPrefs` 后续新增两个字段（同一 `pi_remote_pi_prefs`，v1 迁移兼容）：
 *   - `uiPlatformTab: "all" | "macos" | "windows" | "linux"`（默认 `"all"`）
 *   - `deviceByPlatform: Partial<Record<"macos" | "windows" | "linux", string>>`（默认 `{}`）
 * 本模块给出字段类型、默认值、校验/合并/读写纯函数（与 prefs.ts 的迁移口径一致：缺省/非法回退默认、多余字段保留）。
 * **只在 claude / codex 两套变体消费；cursor 不变、不读这两个字段。**
 *
 * **Q2 平台标签语义**：平台标签 = 筛平台 + 平台内选设备；单设备自动选；无设备 → 禁用 + 配对入口；
 * 与 deviceFilter（粗筛）取交集（先粗筛再平台内细选）。
 *
 * **Q3 运行位置（仅 Codex）**：参考设计 Local / Worktree / Cloud 映射为 **当前设备 / 指定文件夹 / 远端设备**（纯 UI 状态，available）；
 * 其中「git worktree（隔离副本）」是另一项能力（capability `worktree`，Pi 当前无 → unavailable 禁用入口），
 * 与三段运行位置无关，不要混淆。
 */
import type { PiUiCapability } from "./types.ts"

/** 与 pi/model/prefs.ts 相同的存储键（同一份偏好对象；本模块不单独占 key） */
export const PI_UI_PREFS_KEY = "pi_remote_pi_prefs"

/* ------------------------------------------------------------------ 平台与平台标签 */

export const PI_UI_PLATFORMS = ["macos", "windows", "linux"] as const
export type PiUiPlatform = (typeof PI_UI_PLATFORMS)[number]

export const PI_UI_PLATFORM_TABS = ["all", ...PI_UI_PLATFORMS] as const
export type PiUiPlatformTab = (typeof PI_UI_PLATFORM_TABS)[number]

export const PI_UI_PLATFORM_LABEL: Record<PiUiPlatformTab, string> = {
  all: "全部",
  macos: "Mac",
  windows: "Windows",
  linux: "Linux",
}

/** 设备上报的 platform 字符串 → 契约平台（darwin/mac/macos → macos；win32/windows → windows；linux → linux） */
export function piUiPlatformOf(platform: string | null | undefined): PiUiPlatform | null {
  const value = (platform ?? "").trim().toLowerCase()
  if (!value) return null
  if (value === "darwin" || value === "mac" || value === "macos" || value === "macosx") return "macos"
  if (value === "win32" || value === "windows" || value === "win") return "windows"
  if (value === "linux") return "linux"
  return null
}

export function isPiUiPlatformTab(value: unknown): value is PiUiPlatformTab {
  return typeof value === "string" && (PI_UI_PLATFORM_TABS as readonly string[]).includes(value)
}

export function isPiUiPlatform(value: unknown): value is PiUiPlatform {
  return typeof value === "string" && (PI_UI_PLATFORMS as readonly string[]).includes(value)
}

/* ------------------------------------------------------------------ Q1：prefs 预留字段 */

export interface PiUiWorkspacePrefs {
  uiPlatformTab: PiUiPlatformTab
  deviceByPlatform: Partial<Record<PiUiPlatform, string>>
}

export const PI_UI_WORKSPACE_PREFS_DEFAULTS: PiUiWorkspacePrefs = { uiPlatformTab: "all", deviceByPlatform: {} }

/** 本模块负责的 prefs 字段名（PiPrefs 增加同名可选字段；prefs.ts 迁移时复用本模块的校验） */
export const PI_UI_WORKSPACE_PREF_FIELDS = ["uiPlatformTab", "deviceByPlatform"] as const

type Raw = Record<string, unknown>

function rawOf(stored: unknown): Raw | null {
  if (typeof stored === "string") {
    try {
      return rawOf(JSON.parse(stored))
    } catch {
      return null
    }
  }
  return stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Raw) : null
}

/** 校验存储内容里的平台记忆字段（缺省 / 非法回退默认；platform→deviceId 只保留合法平台 + 非空字符串） */
export function piUiWorkspacePrefsOf(stored: unknown): PiUiWorkspacePrefs {
  const raw = rawOf(stored)
  if (!raw) return { ...PI_UI_WORKSPACE_PREFS_DEFAULTS, deviceByPlatform: {} }
  const tab = isPiUiPlatformTab(raw.uiPlatformTab) ? raw.uiPlatformTab : PI_UI_WORKSPACE_PREFS_DEFAULTS.uiPlatformTab
  const deviceByPlatform: Partial<Record<PiUiPlatform, string>> = {}
  const rawDevices = raw.deviceByPlatform
  if (rawDevices && typeof rawDevices === "object" && !Array.isArray(rawDevices)) {
    for (const [key, value] of Object.entries(rawDevices as Raw)) {
      if (isPiUiPlatform(key) && typeof value === "string" && value) deviceByPlatform[key] = value
    }
  }
  return { uiPlatformTab: tab, deviceByPlatform }
}

/**
 * 合并平台记忆字段到**原始偏好对象**（供 prefs.ts 的 setPiPref / usePiUiState 写回时复用）：
 * 保留其他字段与 `v`，不认识的字段不丢；返回可直接 JSON.stringify 的新对象。
 */
export function mergePiUiWorkspacePrefs(stored: unknown, patch: Partial<PiUiWorkspacePrefs>): Raw {
  const base: Raw = rawOf(stored) ?? {}
  const current = piUiWorkspacePrefsOf(base)
  const next: PiUiWorkspacePrefs = {
    uiPlatformTab: patch.uiPlatformTab != null && isPiUiPlatformTab(patch.uiPlatformTab) ? patch.uiPlatformTab : current.uiPlatformTab,
    deviceByPlatform: { ...current.deviceByPlatform, ...(patch.deviceByPlatform ?? {}) },
  }
  const cleanDevices: Partial<Record<PiUiPlatform, string>> = {}
  for (const [key, value] of Object.entries(next.deviceByPlatform as Raw)) {
    if (isPiUiPlatform(key) && typeof value === "string" && value) cleanDevices[key] = value
  }
  return { ...base, uiPlatformTab: next.uiPlatformTab, deviceByPlatform: cleanDevices }
}

export interface PiUiPrefsStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 从 localStorage 类存储读平台记忆（读不到 / 坏数据 = 默认值；不抛） */
export function readPiUiWorkspacePrefs(storage: PiUiPrefsStorageLike | null | undefined): PiUiWorkspacePrefs {
  if (!storage) return { ...PI_UI_WORKSPACE_PREFS_DEFAULTS, deviceByPlatform: {} }
  try {
    return piUiWorkspacePrefsOf(storage.getItem(PI_UI_PREFS_KEY))
  } catch {
    return { ...PI_UI_WORKSPACE_PREFS_DEFAULTS, deviceByPlatform: {} }
  }
}

/** 写平台记忆（与现有 prefs 合并写回；返回写入后的平台记忆；存储不可用不抛） */
export function writePiUiWorkspacePrefs(storage: PiUiPrefsStorageLike | null | undefined, patch: Partial<PiUiWorkspacePrefs>): PiUiWorkspacePrefs {
  const merged = mergePiUiWorkspacePrefs(readRaw(), patch)
  if (storage) {
    try {
      storage.setItem(PI_UI_PREFS_KEY, JSON.stringify(merged))
    } catch {
      // 存储不可用：只影响本页，不抛
    }
  }
  return piUiWorkspacePrefsOf(merged)

  function readRaw(): string | null {
    try {
      return storage?.getItem(PI_UI_PREFS_KEY) ?? null
    } catch {
      return null
    }
  }
}

/* ------------------------------------------------------------------ Q2：平台标签选择（筛平台 → 平台内选设备） */

export interface PiUiPlatformDeviceLike {
  id: string
  platform?: string | null
  online?: boolean
}

export interface PiUiPlatformSelectionInput {
  tab: PiUiPlatformTab
  devices: readonly PiUiPlatformDeviceLike[]
  /** 平台记忆（Q1） */
  deviceByPlatform?: Partial<Record<PiUiPlatform, string>>
  /** 粗筛（prefs.deviceFilter，设备 id；null/空 = 全部设备） */
  coarseDeviceFilter?: string | null
  /** 当前选中的设备（可能来自别的平台；只在仍符合条件时保留） */
  selectedDeviceId?: string | null
}

export interface PiUiPlatformSelection {
  tab: PiUiPlatformTab
  /** tab=all 时为 null（不按平台细分） */
  platform: PiUiPlatform | null
  /** 粗筛 ∩ 平台筛后的候选设备 id（顺序同入参） */
  eligibleDeviceIds: string[]
  selectedDeviceId: string | null
  /** true = 唯一候选自动选中 / 没有记忆时自动落到首个候选 */
  autoSelected: boolean
  /** 无设备时的禁用原因（同时给「配对新设备」入口） */
  disabledReason: string | null
  showPairingEntry: boolean
  /** 该平台记忆里的设备（无 = null；UI 可提示「上次使用」） */
  rememberedDeviceId: string | null
}

/** Q2 纯函数：平台标签 = 筛平台 + 平台内选设备（单设备自动；无设备禁用 + 配对入口；与粗筛取交集） */
export function resolvePiUiPlatformSelection(input: PiUiPlatformSelectionInput): PiUiPlatformSelection {
  const platform = input.tab === "all" ? null : input.tab
  const coarse = input.coarseDeviceFilter && input.coarseDeviceFilter.length ? input.coarseDeviceFilter : null
  const eligible = input.devices.filter((device) => {
    if (coarse && device.id !== coarse) return false
    if (!platform) return true
    return piUiPlatformOf(device.platform) === platform
  })
  const eligibleDeviceIds = eligible.map((device) => device.id)
  const remembered = platform ? (input.deviceByPlatform?.[platform] ?? null) : null
  if (eligibleDeviceIds.length === 0) {
    return {
      tab: input.tab,
      platform,
      eligibleDeviceIds,
      selectedDeviceId: null,
      autoSelected: false,
      disabledReason: `${PI_UI_PLATFORM_LABEL[input.tab]} 平台暂无已配对设备`,
      showPairingEntry: true,
      rememberedDeviceId: remembered,
    }
  }
  if (eligibleDeviceIds.length === 1) {
    return { tab: input.tab, platform, eligibleDeviceIds, selectedDeviceId: eligibleDeviceIds[0], autoSelected: true, disabledReason: null, showPairingEntry: false, rememberedDeviceId: remembered }
  }
  const preferred = [remembered, input.selectedDeviceId].find((id): id is string => !!id && eligibleDeviceIds.includes(id) && id !== null) ?? eligibleDeviceIds[0]
  return {
    tab: input.tab,
    platform,
    eligibleDeviceIds,
    selectedDeviceId: preferred,
    autoSelected: preferred !== remembered && preferred !== input.selectedDeviceId,
    disabledReason: null,
    showPairingEntry: false,
    rememberedDeviceId: remembered,
  }
}

/* ------------------------------------------------------------------ Q3：Codex 运行位置三段（纯 UI 状态，available） */

export type PiUiRunLocationId = "local" | "folder" | "remote"

export interface PiUiRunLocationOption {
  id: PiUiRunLocationId
  label: string
  description: string
  /** 三段运行位置都是纯 UI 状态 → 恒 available（不要求 provider） */
  status: "available"
}

/** Codex Local / Worktree / Cloud → 当前设备 / 指定文件夹 / 远端设备（台账 §4.1） */
export const PI_UI_RUN_LOCATIONS: readonly PiUiRunLocationOption[] = [
  { id: "local", label: "当前设备", description: "在当前会话所在的设备上运行", status: "available" },
  { id: "folder", label: "指定文件夹", description: "选择这台设备上的一个允许目录运行", status: "available" },
  { id: "remote", label: "远端设备", description: "选择另一台已配对设备运行", status: "available" },
]

/** 台账/参考设计里的运行位置语义 → 契约运行位置 id（Local/Cloud 直译；Worktree 段 = 指定文件夹） */
export function piUiRunLocationOf(ledgerId: "Local" | "Worktree" | "Cloud"): PiUiRunLocationId | null {
  if (ledgerId === "Local") return "local"
  if (ledgerId === "Worktree") return "folder"
  if (ledgerId === "Cloud") return "remote"
  return null
}

/**
 * git worktree（隔离副本）是**独立能力**，不是运行位置：Pi 当前无 → unavailable 禁用入口。
 * UI 在运行位置选择器旁显示「Worktree（需扩展）」禁用项时，用 capability `worktree` 的禁用态契约渲染。
 */
export const PI_UI_GIT_WORKTREE_CAPABILITY: PiUiCapability = "worktree"
