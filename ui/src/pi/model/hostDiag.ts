/**
 * 主机诊断（get_host_diag）的口径（PLAN §7.3 settings / 弹窗家族行、design B07「设置 › 设备 › 某台 › 诊断」）。
 *
 * 上半部分是从 conversation/HostDiagView.tsx 原样挪过来的纯函数（P5 第 2 轮，审查 P5-R1-1）：
 *  - 只消费 get_host_diag 的契约字段：piVersion / nodeVersion / platform / arch / extensionVersion / attach / tap / recentErrors / logTail；
 *  - 后端负责脱敏；前端仍不渲染任何未知字段，并对日志 / 错误文本做一次保守 token 遮罩；
 *  - 复制诊断只拼白名单字段。
 * 旧界面的 HostDiagView.tsx 改成从这里 import 并转出（一份实现）；新界面不能 import 旧 .tsx（test/pi-structure 第 7 条），所以放在 pi/model。
 *
 * 下半部分是新界面弹窗（PiHostDiagDialog）的视图口径：设备离线 / 加载中 / 不支持 / 出错 / 就绪五种，缺字段写"未提供"，不编字段（design §1.9）。
 * node --test 直接加载：相对导入带 .ts 扩展名，不 import tsx。
 */
import { errorCode } from "../../relay/devices.ts"

export type HostDiagAttach = {
  active: boolean | null
  expiresAt: number | null
  deviceId: string
}

export type HostDiagRecentError = {
  code: string
  message: string
  at: number | null
}

/** 对话框观察 tap 健康度（扩展 get_host_diag 的 tap 字段）：failed = 自检判失效、已回退信号模式。 */
export type HostDiagTap = {
  state: string
  captures: number | null
  missed: number | null
  open: number | null
}

export type HostDiag = {
  piVersion: string
  nodeVersion: string
  platform: string
  arch: string
  extensionVersion: string
  attach: HostDiagAttach
  tap: HostDiagTap | null
  recentErrors: HostDiagRecentError[]
  logTail: string
}

const MAX_RECENT_ERRORS = 20

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function versionField(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return ""
}

/**
 * 时间戳统一成毫秒：契约未写单位，实机 JSON 里 10 位秒和 13 位毫秒都可能出现。
 * ISO 字符串也接受；无法解析就留 null，界面显示“未提供”。
 */
function timestampField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value < 1e11 ? value * 1000 : value)
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * 保守脱敏：后端已经脱敏，这里只挡常见 key=value / Bearer 形态，避免日志意外把令牌带上来。
 * 不处理自由文本里的裸 token（那需要后端保证），只在明确的键值/Bearer 上下文替换。
 */
export function redactSecrets(text: string): string {
  if (!text) return ""
  return text
    .replace(
      /\b(admin[_-]?token|access[_-]?token|viewer[_-]?token|token|secret|password|passwd|api[_-]?key)\b(\s*[:=]\s*)(["']?)([^\s"',;]+)/gi,
      (_match, key: string, separator: string, quote: string) => `${key}${separator}${quote}[redacted]`,
    )
    .replace(
      /\b(authorization|proxy-authorization)\b(\s*[:=]\s*)((?:bearer|basic)\s+)?(["']?)([^\s"',;]+)/gi,
      (_match, key: string, separator: string, scheme: string | undefined, quote: string) =>
        `${key}${separator}${scheme ?? ""}${quote}[redacted]`,
    )
    .replace(/(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
}

function normalizeRecentErrors(value: unknown): HostDiagRecentError[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/) : []
  const errors: HostDiagRecentError[] = []
  for (const item of raw) {
    if (errors.length >= MAX_RECENT_ERRORS) break
    if (typeof item === "string") {
      const message = redactSecrets(item.trim())
      if (message) errors.push({ code: "", message, at: null })
      continue
    }
    if (!isRecord(item)) continue
    const message = redactSecrets(textField(item.message) || textField(item.text) || textField(item.error))
    if (!message) continue
    errors.push({
      code: textField(item.code),
      message,
      at: timestampField(item.at ?? item.time ?? item.timestamp),
    })
  }
  return errors
}

function normalizeLogTail(value: unknown): string {
  const raw = Array.isArray(value)
    ? value.filter((line): line is string => typeof line === "string").join("\n")
    : typeof value === "string"
      ? value
      : ""
  return redactSecrets(raw.replace(/\s+$/, ""))
}

/**
 * 解析 get_host_diag 回包。没有任何可展示字段时返回 null（无数据状态）；
 * 缺单个字段只留空，界面显示“未提供”，不用默认值冒充机器信息。
 */
function countField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

function normalizeTap(value: unknown): HostDiagTap | null {
  if (!isRecord(value)) return null
  const state = textField(value.state)
  if (!state) return null
  return {
    state,
    captures: countField(value.captures),
    missed: countField(value.missed),
    open: countField(value.open),
  }
}

export function normalizeHostDiag(value: unknown): HostDiag | null {
  if (!isRecord(value)) return null
  const attachRaw = isRecord(value.attach) ? value.attach : {}
  const attach: HostDiagAttach = {
    active: typeof attachRaw.active === "boolean" ? attachRaw.active : null,
    expiresAt: timestampField(attachRaw.expiresAt),
    deviceId: textField(attachRaw.deviceId),
  }
  const diag: HostDiag = {
    piVersion: versionField(value.piVersion),
    nodeVersion: versionField(value.nodeVersion),
    platform: versionField(value.platform),
    arch: versionField(value.arch),
    extensionVersion: versionField(value.extensionVersion),
    attach,
    tap: normalizeTap(value.tap),
    recentErrors: normalizeRecentErrors(value.recentErrors),
    logTail: normalizeLogTail(value.logTail),
  }
  const hasAny =
    !!diag.piVersion ||
    !!diag.nodeVersion ||
    !!diag.platform ||
    !!diag.arch ||
    !!diag.extensionVersion ||
    diag.attach.active !== null ||
    diag.attach.expiresAt !== null ||
    !!diag.attach.deviceId ||
    diag.tap !== null ||
    diag.recentErrors.length > 0 ||
    !!diag.logTail
  return hasAny ? diag : null
}

export function tapStateText(state: string): string {
  if (state === "ok") return "正常（弹窗内容可见）"
  if (state === "failed") return "已失效（回退等待信号）"
  if (state === "off") return "未启用"
  return state || "未知"
}

export function attachStateText(active: boolean | null): string {
  if (active === true) return "已连接"
  if (active === false) return "未连接"
  return "未知"
}

const pad2 = (value: number) => String(value).padStart(2, "0")

/** 固定格式，避免截图/测试受 locale 影响；使用浏览器本地时区。 */
export function formatDiagTimestamp(value: number | null): string {
  if (value == null) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

function formatErrorLine(error: HostDiagRecentError): string {
  const time = formatDiagTimestamp(error.at)
  const code = error.code ? `[${error.code}] ` : ""
  return `${time ? `${time} ` : ""}${code}${error.message}`
}

/** 复制诊断的唯一出口：只拼白名单字段，未知字段（含 token）不会进来。 */
export function formatHostDiag(diag: HostDiag): string {
  const lines: string[] = ["Pi-Remote 主机诊断", ""]
  lines.push(`Pi：${diag.piVersion || "未提供"}`)
  lines.push(`Node：${diag.nodeVersion || "未提供"}`)
  lines.push(`平台：${diag.platform || "未提供"}${diag.arch ? ` · ${diag.arch}` : ""}`)
  lines.push(`扩展：${diag.extensionVersion || "未提供"}`)
  lines.push("")
  lines.push(`Attach：${attachStateText(diag.attach.active)}`)
  if (diag.attach.expiresAt != null) lines.push(`到期：${formatDiagTimestamp(diag.attach.expiresAt)}`)
  if (diag.attach.deviceId) lines.push(`设备 ID：${diag.attach.deviceId}`)
  if (diag.tap) {
    const counts = [
      diag.tap.captures != null ? `捕获 ${diag.tap.captures}` : "",
      diag.tap.open != null ? `在开 ${diag.tap.open}` : "",
    ].filter(Boolean)
    lines.push(`弹窗捕获：${tapStateText(diag.tap.state)}${counts.length ? `（${counts.join(" · ")}）` : ""}`)
  }
  lines.push("")
  lines.push(`最近错误（${diag.recentErrors.length}）：`)
  if (diag.recentErrors.length) {
    for (const error of diag.recentErrors) lines.push(`- ${formatErrorLine(error)}`)
  } else {
    lines.push("- 无")
  }
  lines.push("")
  lines.push("日志尾部：")
  lines.push(diag.logTail || "（空）")
  return lines.join("\n")
}

const DIAG_ERROR_COPY: Record<string, string> = {
  unknown_command: "当前 pi 扩展还没有 get_host_diag 命令，更新扩展后重试",
  unknown_type: "当前 pi 扩展还没有 get_host_diag 命令，更新扩展后重试",
  unsupported: "当前环境不支持主机诊断：更新 pi 扩展后重试",
  internal: "本机读取诊断失败：请稍后重试",
  bad_args: "诊断请求参数不合法：请重试",
  not_found: "本机没有找到诊断数据",
  not_loaded: "这个会话还没载入：先发送一条消息载入会话",
  no_room: "先选择一个会话",
  room_offline: "这个会话已结束，无法读取本机诊断",
  device_offline: "设备未连接：先在电脑上打开 attach 窗口",
  offline: "连接已断开：重连后再读取",
  timeout: "本机没有回应：请重试",
  result_unknown: "没有收到诊断结果，命令可能已经执行：请重试",
  closed: "连接已关闭：重连后再读取",
}

/** 这些码由后端给出更具体的原因，优先展示服务端原文。 */
const DIAG_SPECIFIC_MESSAGE_CODES = new Set(["unsupported", "internal", "bad_args"])

export function hostDiagErrorText(error: unknown): string {
  const code = errorCode(error)
  const message = error instanceof Error ? error.message.trim() : ""
  if (code && DIAG_SPECIFIC_MESSAGE_CODES.has(code) && message) return message
  if (code && DIAG_ERROR_COPY[code]) return DIAG_ERROR_COPY[code]
  return message || "读取主机诊断失败：请稍后重试"
}

export function hostDiagErrorCode(error: unknown): string {
  return errorCode(error)
}

/* ======================= 新界面：设置 › 设备 › 某台 › 诊断（PiHostDiagDialog） ======================= */

/** 扩展没有这条命令（旧扩展）或环境不支持：按"不支持"写，不当成出错、不给重试 */
const HOST_DIAG_UNSUPPORTED_CODES = new Set(["unknown_command", "unknown_type", "unsupported"])
/** 命令发出去以后设备掉线：按"设备离线"写（不是出错） */
const HOST_DIAG_OFFLINE_CODES = new Set(["device_offline"])

/** 回包里没有任何可展示字段（normalizeHostDiag → null）：口径同旧界面的"无数据"状态 */
export const HOST_DIAG_EMPTY_TEXT = "没有可展示的诊断数据。本机可能还没升级到支持 get_host_diag 的扩展版本。"

/** 整句收尾：错误文案（含服务端原文）没有句末标点时补一个"。" */
function sentence(text: string): string {
  return /[。.！!？?）)]$/.test(text) ? text : `${text}。`
}

/**
 * 不发命令的原因（设备离线 / 没连上服务器 / 名册里没有这台）；能发时 null。
 * get_host_diag 是设备级只读命令（relay/commands.js 的 READONLY_DEVICE_COMMANDS）：按 deviceId 寻址，不需要打开会话。
 */
export function hostDiagUnavailableOf(input: {
  authed: boolean
  browserOnline: boolean
  device: { name: string; online: boolean } | null
}): string | null {
  if (!input.authed || !input.browserOnline) return "未连接服务器：连上后再读取主机诊断。"
  if (!input.device) return "名册里没有这台设备了（可能已经撤销）。"
  if (!input.device.online) return `${input.device.name} 未连接：先在这台电脑上打开 attach 窗口，再读取诊断。`
  return null
}

export type HostDiagViewState =
  | { kind: "offline"; text: string }
  | { kind: "loading" }
  | { kind: "unsupported"; text: string }
  | { kind: "error"; text: string; code: string }
  /** refreshing = 刷新中（下面仍是上一次的结果）；note = 刷新失败的说明（下面仍是上一次成功读取的结果） */
  | { kind: "ready"; diag: HostDiag; refreshing: boolean; note: string | null }

/**
 * 弹窗的状态：unavailable（hostDiagUnavailableOf）优先；读取中有上一次的结果就接着显示它；
 * 出错时"不支持 / 掉线"单独写，其余出错有上一次的结果就留着它并写一句刷新失败（口径同旧界面 HostDiagView）。
 */
export function hostDiagViewOf(input: {
  unavailable: string | null
  phase: "idle" | "loading" | "ready" | "error"
  data?: unknown
  error?: unknown
  /** 上一次成功读取的结果（normalizeHostDiag 之后） */
  last?: HostDiag | null
}): HostDiagViewState {
  if (input.unavailable) return { kind: "offline", text: input.unavailable }
  const last = input.last ?? null
  if (input.phase === "idle" || input.phase === "loading") {
    return last ? { kind: "ready", diag: last, refreshing: true, note: null } : { kind: "loading" }
  }
  if (input.phase === "error") {
    const code = hostDiagErrorCode(input.error)
    const text = hostDiagErrorText(input.error)
    if (HOST_DIAG_OFFLINE_CODES.has(code)) return { kind: "offline", text: sentence(text) }
    if (HOST_DIAG_UNSUPPORTED_CODES.has(code)) return { kind: "unsupported", text: sentence(text) }
    if (last) return { kind: "ready", diag: last, refreshing: false, note: `刷新失败：${text}；下面仍是上一次成功读取的结果。` }
    return { kind: "error", text, code }
  }
  const diag = normalizeHostDiag(input.data)
  return diag ? { kind: "ready", diag, refreshing: false, note: null } : { kind: "unsupported", text: HOST_DIAG_EMPTY_TEXT }
}

export interface HostDiagErrorRow {
  key: string
  code: string
  message: string
  /** 本地时间 YYYY-MM-DD HH:mm:ss；没有时间戳是空串 */
  time: string
  /** <time dateTime>；没有时间戳是 undefined */
  iso?: string
}

export interface HostDiagSections {
  /** 键值行（标签, 值）：缺的值写"未提供" */
  version: [string, string][]
  attach: [string, string][]
  errors: HostDiagErrorRow[]
  /** 日志尾部；空写"（空）" */
  logTail: string
}

const MISSING = "未提供"

function isoOf(value: number | null): string | undefined {
  if (value == null) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** 弹窗的四组（版本 / Attach / 最近错误 / 日志尾部），行和写法照旧界面 HostDiagView 的分组 */
export function hostDiagSectionsOf(diag: HostDiag): HostDiagSections {
  const tap = diag.tap
  return {
    version: [
      ["Pi", diag.piVersion || MISSING],
      ["Node", diag.nodeVersion || MISSING],
      ["扩展", diag.extensionVersion || MISSING],
      ["平台", `${diag.platform || MISSING}${diag.arch ? ` · ${diag.arch}` : ""}`],
    ],
    attach: [
      ["状态", attachStateText(diag.attach.active)],
      ["到期", formatDiagTimestamp(diag.attach.expiresAt) || MISSING],
      ["设备 ID", diag.attach.deviceId || MISSING],
      [
        "弹窗捕获",
        tap
          ? `${tapStateText(tap.state)}${tap.captures != null ? ` · 捕获 ${tap.captures}` : ""}${tap.open != null ? ` · 在开 ${tap.open}` : ""}`
          : MISSING,
      ],
    ],
    errors: diag.recentErrors.map((e, i) => ({ key: `${i}-${e.at ?? "na"}-${e.code}`, code: e.code, message: e.message, time: formatDiagTimestamp(e.at), iso: isoOf(e.at) })),
    logTail: diag.logTail || "（空）",
  }
}
