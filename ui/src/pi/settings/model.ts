/**
 * 设置页 v2 · 纯数据层（无 React / 无 DOM，node --test 直载）。
 *
 * 唯一持久化键：`pi_remote_pi_settings_v2`（版本 + 逐字段校验）。
 * 绝不读写旧版偏好键：旧偏好属于宿主（主题 / 变体 / 侧栏宽度等），
 * 设置页 v2 的本地偏好自成一份，互不污染。
 */
import {
  SETTINGS_ACCENTS,
  SETTINGS_AUTO_ARCHIVE,
  SETTINGS_CONTENT_WIDTH_DEFAULT,
  SETTINGS_CONTENT_WIDTH_MAX,
  SETTINGS_CONTENT_WIDTH_MIN,
  SETTINGS_DENSITIES,
  SETTINGS_DICTATION_SHORTCUT_DEFAULT,
  SETTINGS_FONT_SIZES,
  SETTINGS_LANGUAGES,
  SETTINGS_LOCAL_VERSION,
  SETTINGS_MONO_FONTS,
  SETTINGS_RETENTION,
  SETTINGS_SEND_KEYS,
  SETTINGS_SHORTCUT_ACTIONS,
  SETTINGS_START_VIEWS,
  SETTINGS_STYLES,
  SETTINGS_UI_FONTS,
  SETTINGS_USAGE_METRICS,
  SETTINGS_USAGE_RANGES,
  SETTINGS_THEMES,
  type SettingsPrefs,
  type SettingsLocal,
  type SettingsShortcutId,
  type SettingsShortcutMap,
  type SettingsStorage,
  type SettingsThemePref,
} from "./types.ts"

export const SETTINGS_STORAGE_KEY = "pi_remote_pi_settings_v2"
export const SETTINGS_STORAGE_VERSION = SETTINGS_LOCAL_VERSION

/**
 * 同标签页偏好变更广播：设置页写存储后派发，宿主（PiSettingsHost）立即回读。
 * 只做信号，不携带偏好内容；跨标签页仍由 storage 事件 + 轮询兜底。
 */
export const SETTINGS_PREFS_EVENT = "pi-remote:settings-prefs"

const THEME_PREFS: readonly SettingsThemePref[] = [...SETTINGS_THEMES, "system"]

/** 生成一份全新的默认快捷键表（每页各持一份，避免共享数组被改）。 */
export function defaultSettingsShortcuts(): SettingsShortcutMap {
  return Object.fromEntries(
    SETTINGS_SHORTCUT_ACTIONS.map((action) => [action.id, [...action.defaultKeys]]),
  ) as SettingsShortcutMap
}

/** 默认偏好。修改默认值只动这里；normalize 会按字段回落到 base。 */
export const DEFAULT_SETTINGS_PREFS: SettingsPrefs = {
  startView: "last",
  sidebarPersistentSearch: true,
  language: "zh-CN",
  sendKey: "enter",
  autoScroll: true,
  autoArchive: "never",
  micDevice: "system",
  speechToText: true,
  dictationShortcut: SETTINGS_DICTATION_SHORTCUT_DEFAULT,

  appearanceStyle: "cursor",
  appearanceTheme: "system",
  accent: "violet",
  fontSize: "standard",
  density: "compact",
  reducedMotion: false,
  contentWidth: SETTINGS_CONTENT_WIDTH_DEFAULT,
  uiFont: "system",
  monoFont: "jetbrains-mono",

  notifyWaiting: true,
  notifyError: true,
  notifyComplete: false,
  notifyOnlyWhenAway: true,
  notifySound: false,
  notifyBadge: true,

  shortcuts: defaultSettingsShortcuts(),

  retention: "forever",
  privacyMode: false,
  autoConnectDevice: true,
  defaultDeviceId: "",
  usageMetric: "tokens",
  usageRange: "daily",
}

/** 新对象；页面可以直接持有，不会与 DEFAULT 共享引用。 */
export function createDefaultSettingsPrefs(): SettingsPrefs {
  return {
    ...DEFAULT_SETTINGS_PREFS,
    shortcuts: defaultSettingsShortcuts(),
  }
}

type Obj = Record<string, unknown>

function obj(value: unknown): Obj | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : null
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

/** 去掉控制字符（存储/导入的字符串不可信）；不用控制字符正则，避免静态检查告警。 */
function printable(value: string): string {
  let out = ""
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x20 && code !== 0x7f) out += char
  }
  return out
}

function text(value: unknown, fallback: string, max = 160): string {
  if (typeof value !== "string") return fallback
  const clean = printable(value).trim().slice(0, max)
  return clean || fallback
}

function width(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(SETTINGS_CONTENT_WIDTH_MAX, Math.max(SETTINGS_CONTENT_WIDTH_MIN, Math.round(value)))
}

function shortcutKeys(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback]
  const keys: string[] = []
  for (const item of value) {
    if (typeof item !== "string") continue
    const key = printable(item).trim().slice(0, 24)
    if (!key) continue
    keys.push(key)
    if (keys.length >= 4) break
  }
  return keys.length > 0 ? keys : [...fallback]
}

function shortcutsOf(raw: unknown, base: SettingsShortcutMap): SettingsShortcutMap {
  const source = obj(raw)
  const out = {} as SettingsShortcutMap
  for (const action of SETTINGS_SHORTCUT_ACTIONS) {
    const fallback = base[action.id] ?? action.defaultKeys
    out[action.id] = shortcutKeys(source?.[action.id], fallback)
  }
  return out
}

/**
 * 任意值 → 完整合法偏好。字段逐个校验，坏值回落 base 同名字段（而不是一律系统默认）；
 * 未知字段丢弃。传字符串会先尝试 JSON.parse（兼容测试 / 导入文件的输入）。
 */
export function normalizeSettingsPrefs(value: unknown, base: SettingsPrefs = DEFAULT_SETTINGS_PREFS): SettingsPrefs {
  let raw = obj(value)
  if (!raw && typeof value === "string") {
    try {
      raw = obj(JSON.parse(value))
    } catch {
      raw = null
    }
  }
  const source = raw ?? {}
  return {
    startView: pick(source.startView, SETTINGS_START_VIEWS, base.startView),
    sidebarPersistentSearch: bool(source.sidebarPersistentSearch, base.sidebarPersistentSearch),
    language: pick(source.language, SETTINGS_LANGUAGES, base.language),
    sendKey: pick(source.sendKey, SETTINGS_SEND_KEYS, base.sendKey),
    autoScroll: bool(source.autoScroll, base.autoScroll),
    autoArchive: pick(source.autoArchive, SETTINGS_AUTO_ARCHIVE, base.autoArchive),
    micDevice: text(source.micDevice, base.micDevice),
    speechToText: bool(source.speechToText, base.speechToText),
    dictationShortcut: text(source.dictationShortcut, base.dictationShortcut, 60),

    appearanceStyle: pick(source.appearanceStyle, SETTINGS_STYLES, base.appearanceStyle),
    appearanceTheme: pick(source.appearanceTheme, THEME_PREFS, base.appearanceTheme),
    accent: pick(source.accent, SETTINGS_ACCENTS, base.accent),
    fontSize: pick(source.fontSize, SETTINGS_FONT_SIZES, base.fontSize),
    density: pick(source.density, SETTINGS_DENSITIES, base.density),
    reducedMotion: bool(source.reducedMotion, base.reducedMotion),
    contentWidth: width(source.contentWidth, width(base.contentWidth, SETTINGS_CONTENT_WIDTH_DEFAULT)),
    uiFont: pick(source.uiFont, SETTINGS_UI_FONTS, base.uiFont),
    monoFont: pick(source.monoFont, SETTINGS_MONO_FONTS, base.monoFont),

    notifyWaiting: bool(source.notifyWaiting, base.notifyWaiting),
    notifyError: bool(source.notifyError, base.notifyError),
    notifyComplete: bool(source.notifyComplete, base.notifyComplete),
    notifyOnlyWhenAway: bool(source.notifyOnlyWhenAway, base.notifyOnlyWhenAway),
    notifySound: bool(source.notifySound, base.notifySound),
    notifyBadge: bool(source.notifyBadge, base.notifyBadge),

    shortcuts: shortcutsOf(source.shortcuts, base.shortcuts),

    retention: pick(source.retention, SETTINGS_RETENTION, base.retention),
    privacyMode: bool(source.privacyMode, base.privacyMode),
    autoConnectDevice: bool(source.autoConnectDevice, base.autoConnectDevice),
    defaultDeviceId: text(source.defaultDeviceId, base.defaultDeviceId, 200),
    usageMetric: pick(source.usageMetric, SETTINGS_USAGE_METRICS, base.usageMetric),
    usageRange: pick(source.usageRange, SETTINGS_USAGE_RANGES, base.usageRange),
  }
}

/** 改一项（纯函数）：非法值回落 prefs 原值；返回新对象。 */
export function setSettingsPref<K extends keyof SettingsPrefs>(prefs: SettingsPrefs, key: K, value: SettingsPrefs[K]): SettingsPrefs {
  return normalizeSettingsPrefs({ ...prefs, [key]: value }, prefs)
}

/** 逐字段比较（含 shortcuts 的每个动作）；跨标签页 storage 事件用它判断是否真的变了。 */
export function settingsPrefsEqual(left: SettingsPrefs, right: SettingsPrefs): boolean {
  if (left === right) return true
  for (const key of Object.keys(DEFAULT_SETTINGS_PREFS) as (keyof SettingsPrefs)[]) {
    if (key === "shortcuts") continue
    if (left[key] !== right[key]) return false
  }
  return SETTINGS_SHORTCUT_ACTIONS.every((action) => {
    const a = left.shortcuts[action.id]
    const b = right.shortcuts[action.id]
    return a.length === b.length && a.every((key, index) => key === b[index])
  })
}

function keysEqual(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (!left || !right) return left === right
  return left.length === right.length && left.every((key, index) => key === right[index])
}

/**
 * 按动作合并快捷键：只把 current → next 真正改过的动作覆盖到 latest，其余保留 latest。
 * 页面提交的是整张表（{ ...prefs.shortcuts, [id]: keys }），跨标签页时不能把过期动作整张盖回去。
 */
export function mergeSettingsShortcuts(
  current: SettingsShortcutMap,
  latest: SettingsShortcutMap,
  next: SettingsShortcutMap,
): SettingsShortcutMap {
  const merged: SettingsShortcutMap = { ...latest }
  for (const action of SETTINGS_SHORTCUT_ACTIONS) {
    const nextKeys = next[action.id] ?? latest[action.id]
    if (!keysEqual(current[action.id], nextKeys)) merged[action.id] = [...nextKeys]
  }
  return merged
}

/** 批量改（纯函数）；shortcuts 是深合并，避免只传一个动作时冲掉其余键位。 */
export function mergeSettingsPrefs(prefs: SettingsPrefs, patch: Partial<SettingsPrefs>): SettingsPrefs {
  const next: Obj = { ...prefs, ...patch }
  if (patch.shortcuts) {
    next.shortcuts = { ...prefs.shortcuts, ...patch.shortcuts }
  }
  return normalizeSettingsPrefs(next, prefs)
}

/** 恢复全部默认值。 */
export function resetSettingsPrefs(): SettingsPrefs {
  return createDefaultSettingsPrefs()
}

/** 存储信封（updatedAt 只用于本机审计 / 导入提示，不参与 UI）。 */
export function settingsLocalEnvelopeOf(prefs: SettingsPrefs, now = Date.now()): SettingsLocal {
  return {
    v: SETTINGS_LOCAL_VERSION,
    prefs: normalizeSettingsPrefs(prefs),
    updatedAt: Number.isFinite(now) && now > 0 ? now : 0,
  }
}

/**
 * JSON / 对象 → 存储信封。
 * 版本不符 / 结构坏 / 读不出来：整份回落默认值（不猜旧结构），updatedAt = 0。
 */
export function parseSettingsLocal(value: unknown): SettingsLocal {
  let raw = obj(value)
  if (!raw && typeof value === "string") {
    try {
      raw = obj(JSON.parse(value))
    } catch {
      raw = null
    }
  }
  if (!raw || raw.v !== SETTINGS_LOCAL_VERSION) {
    return { v: SETTINGS_LOCAL_VERSION, prefs: createDefaultSettingsPrefs(), updatedAt: 0 }
  }
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : 0
  return {
    v: SETTINGS_LOCAL_VERSION,
    prefs: normalizeSettingsPrefs(raw.prefs),
    updatedAt,
  }
}

/** 从注入的 Storage 读取；访问/解析失败都不抛，回落默认值。 */
export function loadSettingsLocal(storage: SettingsStorage | null | undefined): SettingsLocal {
  if (!storage) return { v: SETTINGS_LOCAL_VERSION, prefs: createDefaultSettingsPrefs(), updatedAt: 0 }
  try {
    return parseSettingsLocal(storage.getItem(SETTINGS_STORAGE_KEY))
  } catch {
    return { v: SETTINGS_LOCAL_VERSION, prefs: createDefaultSettingsPrefs(), updatedAt: 0 }
  }
}

/** 写入本机设置；返回是否确实写成（隐私模式 / 配额满 = false，不抛）。 */
export function saveSettingsLocal(storage: SettingsStorage | null | undefined, prefs: SettingsPrefs, now = Date.now()): boolean {
  if (!storage) return false
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settingsLocalEnvelopeOf(prefs, now)))
    return true
  } catch {
    return false
  }
}

/**
 * 跨标签页安全写入：先读存储里的最新偏好，只把这次改动合并进去再写回。
 * 两个标签页改不同字段时不会互相覆盖；返回值是合并后的完整偏好（页面状态以它为准）。
 * 存储读不出来时以默认值为底，和 loadSettingsLocal 的口径一致。
 */
export function patchSettingsLocal(
  storage: SettingsStorage | null | undefined,
  patch: Partial<SettingsPrefs>,
  now = Date.now(),
): SettingsPrefs {
  const next = mergeSettingsPrefs(loadSettingsLocal(storage).prefs, patch)
  saveSettingsLocal(storage, next, now)
  return next
}

/** 整份替换本机偏好（恢复默认 / 导入）；返回规范化后的完整对象。 */
export function replaceSettingsLocal(
  storage: SettingsStorage | null | undefined,
  prefs: SettingsPrefs,
  now = Date.now(),
): SettingsPrefs {
  const next = normalizeSettingsPrefs(prefs)
  saveSettingsLocal(storage, next, now)
  return next
}

/* ------------------------------------------------------------------ */
/* 设备在线态                                                          */
/* ------------------------------------------------------------------ */

export interface SettingsDeviceState {
  /** relay.deviceMode：名册生效时才按设备在线态门控。 */
  deviceMode?: boolean
  selectedDevice?: { online?: boolean } | null
  selectedDeviceId?: string | null
  devices?: readonly { id: string; online?: boolean }[]
}

/**
 * 当前选中设备是否离线。只认 relay 已有的 devices / selectedDevice.online 字段，
 * 不用浏览器 navigator.onLine 代替设备心跳；没有选中设备时不算离线（页面另行显示无设备）。
 */
export function settingsDeviceOfflineOf(input: SettingsDeviceState): boolean {
  if (!input.deviceMode) return false
  const selected =
    input.selectedDevice ?? (input.devices ?? []).find((device) => device.id === input.selectedDeviceId) ?? null
  return selected?.online === false
}

/** 序列化（导入 / 导出用）；永远输出规范化后的当前版本。 */
export function serializeSettingsLocal(prefs: SettingsPrefs, now = Date.now()): string {
  return JSON.stringify(settingsLocalEnvelopeOf(prefs, now))
}

/** 某个快捷键动作的默认键帽（快捷键页「恢复默认」用）。 */
export function defaultShortcutKeysOf(id: SettingsShortcutId): string[] {
  const action = SETTINGS_SHORTCUT_ACTIONS.find((item) => item.id === id)
  return action ? [...action.defaultKeys] : []
}
