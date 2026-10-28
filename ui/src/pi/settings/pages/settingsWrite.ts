/**
 * 设置 › `settings_set` 写桥 · 纯数据层（无 React / 无 DOM / 无副作用），node --test 直接加载。
 *
 * 契约见 DOC/76-settings-write-bridge.md：
 *   - 请求：`settings_set` + `{ patch: {...} }`（14 个白名单键）；
 *   - 成功：`{ ok:true, applied:<点号扁平>, restartRequired:true, restartReason, reloadHint }`；
 *   - 失败：`bad_args` / `internal`；旧扩展是 `unknown_command`（relay 原样回包）。
 *
 * 本模块只负责三件事，不碰 relay / storage：
 *   1. 把页面交互映射成合法 patch（成对字段、枚举、非负整数）；
 *   2. 把 `get_settings` 回包读成可显示的值，并用写后 `applied`（含跨页面 overlay）覆盖（不在成功后再回读旧值）；
 *   3. 把回包 / 错误码翻译成「已保存，重启 pi 后生效」或「需更新扩展 / 需设备在线」。
 */

type Obj = Record<string, unknown>

function recordOf(value: unknown): Obj | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : null
}

function own(record: Obj, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/* ------------------------------------------------------------------ */
/* 文案 / 白名单                                                       */
/* ------------------------------------------------------------------ */

/** 成功后唯一允许的承诺：文件已写、重启才生效。 */
export const SETTINGS_WRITE_OK_TEXT = "已保存，重启 pi 后生效"

/** 重新进入页面时的常驻说明：overlay 显示的是已写入值，运行中的 pi 仍是旧值。 */
export const SETTINGS_WRITE_PENDING_RESTART_TEXT =
  "有设置已写入设置文件，待重启 pi 后生效；运行中的 pi 仍使用旧值。"

/** 扩展没给 reloadHint 时的兜底说明（与 DOC/76 §2.3 同口径）。 */
export const SETTINGS_WRITE_RELOAD_FALLBACK =
  "重启 pi 后生效。在本机 TUI 执行 /reload 会重载设置与扩展，但启动期设置（主题 / TUI 模式等）仍需重启。"

export const SETTINGS_WRITE_UNSUPPORTED_TEXT = "需更新扩展：当前扩展不支持设置读写"

export const SETTINGS_WRITE_OFFLINE_TEXT = "需设备在线"

export const SETTINGS_WRITE_READ_FAILED_TEXT = "设置读取失败，暂时只读"

/** UI 可写的 14 个键（与扩展白名单一一对应，供测试静态核对）。 */
export const SETTINGS_WRITE_KEYS = [
  "steeringMode",
  "followUpMode",
  "compaction.enabled",
  "compaction.reserveTokens",
  "compaction.keepRecentTokens",
  "hideThinkingBlock",
  "defaultProjectTrust",
  "enableInstallTelemetry",
  "enableSkillCommands",
  "images.blockImages",
  "images.autoResize",
  "defaultThinkingLevel",
  "defaultModel",
  "defaultProvider",
] as const

export type SettingsWriteKey = (typeof SETTINGS_WRITE_KEYS)[number]

/* ------------------------------------------------------------------ */
/* pi schema 默认值（缺键仍显示 / 可写）                                */
/* ------------------------------------------------------------------ */

/**
 * pi 1.3 `settings-schema` 的默认值，只列写桥会读、且最小 settings.json 里常见的缺键。
 *
 * 缺键 ≠ 不可写：以前 `effectiveSettingsBoolOf` 对缺键返回 null，页面就把控件 disabled，
 * 导致 Extensions 页的技能总闸 / 模型页的思考与压缩 / 通用页的图片缩放 / 隐私页的安装统计
 * 在干净配置下全部锁死。这里只影响「显示与禁用判断」，写 settings_set 时仍只 patch 用户改的键，
 * 不会把整份默认值写回磁盘。
 */
export const SETTINGS_SCHEMA_DEFAULTS = {
  enableSkillCommands: true,
  hideThinkingBlock: false,
  "images.autoResize": true,
  enableInstallTelemetry: true,
  "compaction.enabled": true,
  "compaction.reserveTokens": 16384,
  "compaction.keepRecentTokens": 20000,
} as const satisfies Readonly<Record<string, boolean | number>>

/** 某条点号路径的 pi 默认值；没有默认值返回 undefined（保持「未知」）。 */
export function settingsDefaultValueOf(path: string): boolean | number | undefined {
  return Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMA_DEFAULTS, path)
    ? SETTINGS_SCHEMA_DEFAULTS[path as keyof typeof SETTINGS_SCHEMA_DEFAULTS]
    : undefined
}

/* ------------------------------------------------------------------ */
/* 枚举                                                                */
/* ------------------------------------------------------------------ */

export const SETTINGS_DELIVERY_MODES = ["one-at-a-time", "all"] as const
export type SettingsDeliveryMode = (typeof SETTINGS_DELIVERY_MODES)[number]

export const SETTINGS_PROJECT_TRUSTS = ["ask", "always", "never"] as const
export type SettingsProjectTrust = (typeof SETTINGS_PROJECT_TRUSTS)[number]

export const SETTINGS_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const
export type SettingsThinkingLevel = (typeof SETTINGS_THINKING_LEVELS)[number]

export function deliveryModeOf(value: unknown): SettingsDeliveryMode | null {
  return value === "one-at-a-time" || value === "all" ? value : null
}

export function projectTrustOf(value: unknown): SettingsProjectTrust | null {
  return value === "ask" || value === "always" || value === "never" ? value : null
}

export function thinkingLevelOf(value: unknown): SettingsThinkingLevel | null {
  return typeof value === "string" && (SETTINGS_THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as SettingsThinkingLevel)
    : null
}

/* ------------------------------------------------------------------ */
/* 读：get_settings → 可显示值（写后用 applied 覆盖）                   */
/* ------------------------------------------------------------------ */

/** `get_settings` 回包是 `{ settings }` 或裸设置对象；两种都吃。 */
export function settingsDocumentOf(value: unknown): Obj {
  const outer = recordOf(value)
  if (!outer) return {}
  return recordOf(outer.settings) ?? outer
}

/**
 * 回包是不是可用的设置文档：对象，且 `settings`（若有）也是对象。
 * 防 gallery / 旧 relay 的「空回包」被当成「读到了空设置」而放出可写控件。
 */
export function isSettingsDocumentResponse(value: unknown): boolean {
  const outer = recordOf(value)
  if (!outer) return false
  if (!own(outer, "settings")) return true
  return recordOf(outer.settings) !== null
}

/** 点号路径取值；任一层不是对象就返回 undefined。 */
export function settingsAt(source: unknown, path: string): unknown {
  let current: unknown = source
  for (const key of path.split(".")) {
    const record = recordOf(current)
    if (!record || !own(record, key)) return undefined
    current = record[key]
  }
  return current
}

export function settingsValueOf(data: unknown, path: string): unknown {
  return settingsAt(settingsDocumentOf(data), path)
}

/** 写桥成功回包里的 applied（点号扁平）；也兼容嵌套写法。 */
export type SettingsApplied = Record<string, unknown>

/** 把 `{compaction:{enabled:true}}` 摊成 `{"compaction.enabled":true}`，供乐观覆盖使用。 */
export function flattenSettingsPatch(patch: Obj, prefix = ""): SettingsApplied {
  const out: SettingsApplied = {}
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${key}` : key
    const nested = recordOf(value)
    if (nested && Object.keys(nested).length > 0) Object.assign(out, flattenSettingsPatch(nested, path))
    else out[path] = value
  }
  return out
}

function hasApplied(applied: SettingsApplied, path: string): boolean {
  return own(applied, path)
}

/**
 * 先看已确认写入的 applied（本次会话 + 持久化的待重启 overlay），再看 get_settings，
 * 最后回落到 pi schema 默认值（缺键不是「未知」）。
 */
export function effectiveSettingsValue(data: unknown, applied: SettingsApplied, path: string): unknown {
  if (hasApplied(applied, path)) return applied[path]
  const value = settingsValueOf(data, path)
  return value === undefined ? settingsDefaultValueOf(path) : value
}

export function effectiveSettingsStringOf(data: unknown, applied: SettingsApplied, path: string): string | null {
  const value = effectiveSettingsValue(data, applied, path)
  return typeof value === "string" && value.trim() ? value.trim() : null
}

export function effectiveSettingsBoolOf(data: unknown, applied: SettingsApplied, path: string): boolean | null {
  const value = effectiveSettingsValue(data, applied, path)
  return typeof value === "boolean" ? value : null
}

export function effectiveSettingsIntOf(data: unknown, applied: SettingsApplied, path: string): number | null {
  const value = effectiveSettingsValue(data, applied, path)
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function effectiveSettingsDeliveryModeOf(
  data: unknown,
  applied: SettingsApplied,
  path: "steeringMode" | "followUpMode",
): SettingsDeliveryMode | null {
  return deliveryModeOf(effectiveSettingsValue(data, applied, path))
}

export function effectiveProjectTrustOf(data: unknown, applied: SettingsApplied): SettingsProjectTrust | null {
  return projectTrustOf(effectiveSettingsValue(data, applied, "defaultProjectTrust"))
}

export function mergeSettingsApplied(base: SettingsApplied, next: SettingsApplied): SettingsApplied {
  return { ...base, ...next }
}

/* ------------------------------------------------------------------ */
/* 待重启 overlay：写成功但运行中的 pi 还是旧值                          */
/* ------------------------------------------------------------------ */

/**
 * 背景：settings_set 只写磁盘，运行中的 pi 从内存读设置（P2-2）。
 * 写成功后离开 / 重进页面，`get_settings` 会回读旧内存值，界面看起来像被回滚。
 * 这里把**已确认写入**的 applied 键持久化成本地 overlay，页面读取时 overlay 优先；
 * 只影响显示，失败 / 未确认的写不会进 overlay（不伪造未写入）。
 *
 * 清除条件：
 *   1. 重启 pi 后 `get_settings` 返回新值 → 与 overlay 相同（reconciled）；
 *   2. 扩展 / pi 版本变化（写入后首次读到的 hostVersion 与之后不同）；
 *   3. 手动清理：overlay 按设备隔离（没有设备时按房间），换设备自然不显示。
 */
export const SETTINGS_OVERLAY_STORAGE_KEY = "pi_remote_pi_settings_v2.write_overlay"
export const SETTINGS_OVERLAY_VERSION = 1

export interface SettingsOverlayEntry {
  /** 已确认写入、等待重启生效的键（点号扁平）。 */
  applied: SettingsApplied
  /** 写入时间（毫秒）；仅用于本地记录，不展示。 */
  writtenAt: number
  /** 写入后首次读到的主机版本（pi + 扩展）；版本变化时整条 overlay 作废。 */
  hostVersion?: string
}

export type SettingsOverlayBook = Record<string, SettingsOverlayEntry>

export interface SettingsOverlayTarget {
  deviceId?: string | null
  roomId?: string | null
}

/**
 * 设置文件是设备级全局文件，所以 overlay 优先按设备隔离；还没有设备时退回房间。
 * 用 JSON 数组当 key，避免 device / room 里出现 `|` 等分隔符时撞键。
 */
export function settingsOverlayTargetKey(target: SettingsOverlayTarget): string {
  const deviceId = textOf(target.deviceId)
  const roomId = textOf(target.roomId)
  return JSON.stringify([deviceId, deviceId ? "" : roomId])
}

const EMPTY_SETTINGS_APPLIED: SettingsApplied = {}

/** 某个目标的 overlay；没有时返回共享空对象（保持引用稳定）。 */
export function settingsOverlayAppliedOf(book: SettingsOverlayBook, target: string): SettingsApplied {
  return book[target]?.applied ?? EMPTY_SETTINGS_APPLIED
}

/** 只接受写桥白名单里的合法值，避免被塞入 localStorage 的脏值直接显示。 */
export function settingsWriteValueValidOf(path: string, value: unknown): boolean {
  switch (path) {
    case "steeringMode":
    case "followUpMode":
      return deliveryModeOf(value) !== null
    case "defaultProjectTrust":
      return projectTrustOf(value) !== null
    case "defaultThinkingLevel":
      return thinkingLevelOf(value) !== null
    case "compaction.enabled":
    case "hideThinkingBlock":
    case "enableInstallTelemetry":
    case "enableSkillCommands":
    case "images.blockImages":
    case "images.autoResize":
      return typeof value === "boolean"
    case "compaction.reserveTokens":
    case "compaction.keepRecentTokens":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    case "defaultModel":
    case "defaultProvider":
      return nonEmptyText(value) !== null
    default:
      return false
  }
}

/** 回包 applied / localStorage 条目 → 只保留白名单里的合法键值。 */
function settingsAppliedOf(value: unknown): SettingsApplied {
  const record = recordOf(value)
  if (!record) return {}
  const out: SettingsApplied = {}
  for (const [path, item] of Object.entries(record)) {
    if (!settingsWriteValueValidOf(path, item)) continue
    const normalized = path === "defaultModel" || path === "defaultProvider" ? nonEmptyText(item) : item
    if (normalized === null) continue
    out[path] = normalized
  }
  return out
}

/** 解析 localStorage 里的 overlay 数据；坏 JSON / 旧版本 / 脏键一律丢弃（不抛）。 */
export function parseSettingsOverlayBook(value: unknown): SettingsOverlayBook {
  const outer = recordOf(value)
  if (!outer) return {}
  if (own(outer, "v") && outer.v !== SETTINGS_OVERLAY_VERSION) return {}
  const rawEntries = own(outer, "entries") ? recordOf(outer.entries) : outer
  if (!rawEntries) return {}
  const out: SettingsOverlayBook = {}
  for (const [target, rawEntry] of Object.entries(rawEntries)) {
    if (!target || target === "__proto__" || target === "constructor" || target === "prototype") continue
    const entry = recordOf(rawEntry)
    if (!entry) continue
    const applied = settingsAppliedOf(entry.applied)
    if (Object.keys(applied).length === 0) continue
    const writtenAt =
      typeof entry.writtenAt === "number" && Number.isFinite(entry.writtenAt) ? entry.writtenAt : 0
    const hostVersion = textOf(entry.hostVersion)
    out[target] = { applied, writtenAt, ...(hostVersion ? { hostVersion } : {}) }
  }
  return out
}

export function settingsOverlayEnvelopeOf(book: SettingsOverlayBook): string {
  return JSON.stringify({ v: SETTINGS_OVERLAY_VERSION, entries: book })
}

export function settingsOverlayBookOf(text: string | null | undefined): SettingsOverlayBook {
  if (typeof text !== "string" || !text.trim()) return {}
  try {
    return parseSettingsOverlayBook(JSON.parse(text))
  } catch {
    return {}
  }
}

export interface SettingsOverlayRecordOptions {
  writtenAt?: number
  hostVersion?: string
}

/** settings_set 成功后调用：把回包 applied 合并进该目标的 overlay（不修改入参）。 */
export function recordSettingsOverlayApplied(
  book: SettingsOverlayBook,
  target: string,
  applied: unknown,
  options: SettingsOverlayRecordOptions = {},
): SettingsOverlayBook {
  const confirmed = settingsAppliedOf(applied)
  if (!target || Object.keys(confirmed).length === 0) return book
  const previous = book[target]
  const hostVersion = textOf(options.hostVersion) || previous?.hostVersion || ""
  const writtenAt =
    typeof options.writtenAt === "number" && Number.isFinite(options.writtenAt) ? options.writtenAt : Date.now()
  return {
    ...book,
    [target]: {
      applied: { ...(previous?.applied ?? {}), ...confirmed },
      writtenAt,
      ...(hostVersion ? { hostVersion } : {}),
    },
  }
}

export interface SettingsOverlayReconcileInput {
  book: SettingsOverlayBook
  target: string
  /** 新的 get_settings 回包（原始形状）；用它的运行中值判断是否已收敛。 */
  data: unknown
  /** 当前运行中的 pi / 扩展版本签名；有值时用于版本变化清除。 */
  hostVersion?: string
}

export interface SettingsOverlayReconcileResult {
  book: SettingsOverlayBook
  /** 已被新值确认、从 overlay 移除的键。 */
  cleared: string[]
  /** 运行中的 pi 仍是旧值、继续保留的键。 */
  pending: string[]
  /** 是否因主机版本变化整条作废。 */
  versionChanged: boolean
}

/**
 * 用一次新的 get_settings 回包收敛 overlay：
 *   - 运行中值与 overlay 相同 → 该键已生效（重启后 / 热重载），移除；
 *   - 缺键但等于 pi 默认值 → 也视为已生效（get_settings 可能不补默认键）；
 *   - 运行中仍是旧值 → 保留 pending，页面继续显示已写入值；
 *   - 主机版本变化 → 整条 overlay 作废（避免跨扩展版本显示旧写入）。
 */
export function reconcileSettingsOverlay(input: SettingsOverlayReconcileInput): SettingsOverlayReconcileResult {
  const { book, target, data } = input
  const entry = book[target]
  if (!entry) return { book, cleared: [], pending: [], versionChanged: false }

  const hostVersion = textOf(input.hostVersion)
  if (hostVersion && entry.hostVersion && hostVersion !== entry.hostVersion) {
    const next = { ...book }
    delete next[target]
    return { book: next, cleared: Object.keys(entry.applied), pending: [], versionChanged: true }
  }

  const cleared: string[] = []
  const pending: SettingsApplied = {}
  for (const [path, written] of Object.entries(entry.applied)) {
    const current = settingsValueOf(data, path)
    const runtime = current === undefined ? settingsDefaultValueOf(path) : current
    if (runtime !== undefined && runtime === written) cleared.push(path)
    else pending[path] = written
  }

  const pendingPaths = Object.keys(pending)
  if (pendingPaths.length === 0) {
    const next = { ...book }
    delete next[target]
    return { book: next, cleared, pending: [], versionChanged: false }
  }

  const nextHostVersion = hostVersion || entry.hostVersion || ""
  const nextEntry: SettingsOverlayEntry = {
    applied: pending,
    writtenAt: entry.writtenAt,
    ...(nextHostVersion ? { hostVersion: nextHostVersion } : {}),
  }
  const unchanged = cleared.length === 0 && (entry.hostVersion ?? "") === nextHostVersion
  return {
    book: unchanged ? book : { ...book, [target]: nextEntry },
    cleared,
    pending: pendingPaths,
    versionChanged: false,
  }
}

/** get_host_diag 的版本签名（pi + 扩展）；缺字段或回包不对返回空串。 */
export function settingsHostVersionOf(value: unknown): string {
  const record = recordOf(value)
  if (!record) return ""
  const piVersion = textOf(record.piVersion)
  const extensionVersion = textOf(record.extensionVersion)
  if (!piVersion && !extensionVersion) return ""
  return `pi:${piVersion || "unknown"}|ext:${extensionVersion || "unknown"}`
}

/** get_settings 回包里的 error（扩展内部读取失败时仍会给 settings:{}）；有错则不拿它收敛 overlay。 */
export function settingsReadErrorOf(value: unknown): string {
  const outer = recordOf(value)
  return outer && typeof outer.error === "string" ? outer.error.trim() : ""
}

/* ------------------------------------------------------------------ */
/* 写：交互 → patch                                                    */
/* ------------------------------------------------------------------ */

function nonEmptyText(value: unknown, max = 200): string | null {
  const text = textOf(value)
  if (!text || text.length > max) return null
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return null
  }
  return text
}

export function steeringModePatch(mode: unknown): Obj | null {
  return deliveryModeOf(mode) ? { steeringMode: mode } : null
}

export function followUpModePatch(mode: unknown): Obj | null {
  return deliveryModeOf(mode) ? { followUpMode: mode } : null
}

export function autoResizeImagesPatch(enabled: boolean): Obj {
  return { images: { autoResize: enabled } }
}

export function blockImagesPatch(blocked: boolean): Obj {
  return { images: { blockImages: blocked } }
}

/** defaultProvider 与 defaultModel 必须成对；只给一个时返回 null（页面不会发坏请求）。 */
export function defaultModelPatch(provider: unknown, model: unknown): Obj | null {
  const providerText = nonEmptyText(provider)
  const modelText = nonEmptyText(model)
  if (!providerText || !modelText) return null
  return { defaultProvider: providerText, defaultModel: modelText }
}

export function defaultThinkingLevelPatch(level: unknown): Obj | null {
  const value = thinkingLevelOf(level)
  return value ? { defaultThinkingLevel: value } : null
}

export function hideThinkingBlockPatch(hidden: boolean): Obj {
  return { hideThinkingBlock: hidden }
}

export function compactionEnabledPatch(enabled: boolean): Obj {
  return { compaction: { enabled } }
}

export function tokenBudgetPatch(field: "reserveTokens" | "keepRecentTokens", tokens: unknown): Obj | null {
  if (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 0) return null
  return { compaction: { [field]: tokens } }
}

export function installTelemetryPatch(enabled: boolean): Obj {
  return { enableInstallTelemetry: enabled }
}

export function skillCommandsPatch(enabled: boolean): Obj {
  return { enableSkillCommands: enabled }
}

export function defaultProjectTrustPatch(trust: unknown): Obj | null {
  const value = projectTrustOf(trust)
  return value ? { defaultProjectTrust: value } : null
}

/** `settings_set` 的 args：固定用 `{ patch }`，避免与 `settings` 同时出现。 */
export function settingsSetArgs(patch: Obj): { patch: Obj } {
  return { patch }
}

/* ------------------------------------------------------------------ */
/* 回包 / 错误                                                         */
/* ------------------------------------------------------------------ */

export interface SettingsSetSuccess {
  ok: true
  applied: SettingsApplied
  restartRequired: boolean
  restartReason: string
  reloadHint: string
}

/**
 * 解析 settings_set 成功回包。`ok` 不是 true / 不是对象 → null（调用方按「结果无法确认」处理，
 * 不把未知回包说成保存成功）。
 */
export function settingsSetResultOf(value: unknown): SettingsSetSuccess | null {
  const record = recordOf(value)
  if (!record || record.ok !== true) return null
  return {
    ok: true,
    applied: flattenSettingsPatch(recordOf(record.applied) ?? {}),
    restartRequired: record.restartRequired === true,
    restartReason: textOf(record.restartReason),
    reloadHint: textOf(record.reloadHint),
  }
}

export type SettingsWriteFailureKind = "unsupported" | "offline" | "bad_args" | "internal" | "unknown_result" | "error"

export interface SettingsWriteFailure {
  kind: SettingsWriteFailureKind
  code: string
  /** 直接给用户看的一句话。 */
  text: string
  /** 原始 message，放进「说明」里；不展示设置正文 / 路径。 */
  detail: string
}

function errorCodeOf(error: unknown): string {
  const record = recordOf(error)
  return record && typeof record.code === "string" ? record.code : ""
}

function errorTextOf(error: unknown): string {
  if (error instanceof Error) return error.message.trim()
  return typeof error === "string" ? error.trim() : ""
}

/** relay / 扩展错误 → 可展示的分类。未知错误不猜成功。 */
export function settingsFailureOf(error: unknown): SettingsWriteFailure {
  const code = errorCodeOf(error)
  const detail = errorTextOf(error)
  switch (code) {
    case "unknown_command":
    case "unknown_type":
    case "unsupported":
      return { kind: "unsupported", code, text: SETTINGS_WRITE_UNSUPPORTED_TEXT, detail }
    case "device_offline":
    case "room_offline":
    case "no_room":
    case "not_loaded":
      return { kind: "offline", code, text: SETTINGS_WRITE_OFFLINE_TEXT, detail }
    case "bad_args":
      return { kind: "bad_args", code, text: "设置参数无效，未写入", detail }
    case "internal":
      return { kind: "internal", code, text: "设备写入设置失败，未修改", detail }
    case "result_unknown":
      return { kind: "unknown_result", code, text: "写入结果未知，请重启 pi 后确认设置是否生效", detail }
    default:
      return { kind: "error", code, text: detail || "保存失败", detail }
  }
}

/** 设备命令能不能跑（与设置页现有 ready 口径一致）。 */
export function settingsCommandsReady(relay: {
  authed?: boolean
  browserOnline?: boolean
  online?: boolean
  roomId?: string | null
  lazySession?: { id?: string } | null
}): boolean {
  return Boolean(
    relay.authed &&
      relay.browserOnline &&
      relay.online &&
      relay.roomId &&
      !(relay.lazySession && relay.lazySession.id === relay.roomId),
  )
}

export interface SettingsReadOnlyHintInput {
  ready: boolean
  phase: "idle" | "loading" | "ready" | "error"
  failure?: SettingsWriteFailure | null
  unsupported?: boolean
}

/**
 * 页面顶部/底部的只读原因：能写时返回 null。
 * 读失败与写失败分开判断，避免把「读不到」说成「已保存」。
 */
export function settingsReadOnlyHintOf(input: SettingsReadOnlyHintInput): string | null {
  if (input.unsupported) return SETTINGS_WRITE_UNSUPPORTED_TEXT
  if (input.phase === "error") {
    if (input.failure?.kind === "unsupported") return SETTINGS_WRITE_UNSUPPORTED_TEXT
    if (input.failure?.kind === "offline") return SETTINGS_WRITE_OFFLINE_TEXT
    return SETTINGS_WRITE_READ_FAILED_TEXT
  }
  if (input.phase === "loading") return "正在读取设备设置…"
  if (!input.ready || input.phase === "idle") return SETTINGS_WRITE_OFFLINE_TEXT
  return null
}

/** 只影响新会话 / 重启后才生效的说明（模型页两行用）。 */
export const SETTINGS_WRITE_NEW_SESSION_NOTE = "只影响新会话；保存后仍需重启 pi 才保证生效。"

/** 其余暂不开放的项：写桥白名单没有对应键，页面继续保持只读。 */
export const SETTINGS_WRITE_REMAINING_READONLY_NOTE =
  "仍只读：写桥白名单未包含这些字段（供应商启停 / 每模型思考 / 新会话默认模式与自动标题 / MCP 与技能清单增删 / 审批权限档位）。"
