/** 设备名册 / 会话清单的纯逻辑（不依赖 React）。契约见 DOC/50 与 DOC/40。 */
// test/*.test.mjs 用 node 直接跑 .ts 源文件，相对导入必须带扩展名
import { cleanSessionTitleText } from "./titleText.ts"

export const UNREGISTERED_DEVICE_ID = "未登记设备"

export const SESSION_ONLINE_WATCH_MS = 60_000
/**
 * harness_start 等 relay 受理回执的上限：relay 默认 harnessStartTimeoutMs=10s，再留 5s 余量。
 * 受理后按 relay 回执里的 timeoutMs + 余量计时（relay 配置是唯一口径），前端不会和 relay 同一刻各判一次超时。
 */
export const HARNESS_START_TIMEOUT_MS = 15_000
/** 覆盖 relay 对 switch/new/fork/clone 的 30s，再留 5s 余量。16s 会在命令还在跑时判失败并触发第二次真实切换。 */
export const DEVICE_COMMAND_TIMEOUT_MS = 35_000
export const GET_SESSIONS_TIMEOUT_MS = 10_000
/** 配对码有效期（protocol/v4.json limits.pairCodeTtlMs）：relay 没回 expiresAt 时按它倒计时 */
export const PAIR_CODE_TTL_MS = 600_000

export const COPY = {
  deviceOffline: "设备未连接：先在电脑上打开 attach 窗口",
  deviceOfflineBanner: "这台设备未连接——在电脑上打开 attach 窗口后可操作",
  noActive: "这台设备没有在跑的会话：在左侧点选一个会话，发送第一条消息时载入；或新建会话",
  sessionNotFound: "这台设备上没有这个会话（可能已删除）",
  cwdNotAllowed: "该目录不在这台设备的允许列表里",
  noDevice: "这台设备从未连接过",
  requestTimeout: "本机没有回应，请重试",
  watchTimeout: "已通知本机启动，但会话还没上线——请到电脑上看终端",
  truncated: "仅显示最近 200 个会话",
  composerOffline: "这台设备未连接，先在电脑上打开 attach 窗口",
  composerIdle: "在左侧点选一个会话，发送第一条消息时载入；或新建会话",
  composerPickDevice: "先选一台设备",
  composerDefault: "给这个会话发一条消息，/ 选择命令",
  composerLinkDown: "还没连上服务器，连上后再发",
  snapshotPending: "正在从本机拉取会话…",
  roomDown: "这个会话已结束：本机 pi 没在跑。历史还可以看，消息送不出去。",
  pairExpired: "配对码已过期，请重新生成",
  pairHint: "配对码 10 分钟内有效，只能用一次。配对成功后按提示重启 pi。",
  revokeExplain: "撤销后这台设备的令牌立即作废，它的窗口和扩展会断开，要重新配对才能再连。",
  pairDone: "请在那台电脑上重启 pi；再在 Pi-Remote 目录运行 deploy/attach.sh（Windows：deploy\\attach.cmd）打开连接窗口，设备才会变成已连接。",
} as const

/** 管理员令牌只存这台浏览器：不参与 viewer 认证，也不回显到状态/日志/URL。 */
export const ADMIN_TOKEN_STORAGE_KEY = "pi_remote_admin_token"

export const ADMIN_TOKEN_COPY = {
  label: "管理员令牌",
  hint: "只保存在本机浏览器，不会同步到其他设备。",
  required: "需要管理员令牌才能生成配对码或撤销设备",
  invalid: "管理员令牌不正确/未配置",
} as const

/** 经 Cloudflare 隧道打开页面时的提示文案（免服务器模式 §4.3）。 */
export const TUNNEL_COPY = {
  badge: "经 Cloudflare 隧道连接",
} as const

/**
 * 当前页面是否经 Cloudflare quick tunnel 打开：quick tunnel 的网址恒为
 * https://<随机词>.trycloudflare.com，hostname 以 .trycloudflare.com 结尾即是。
 * 纯前端判定、零后端改动；裸 trycloudflare.com（无子域）不算，仿冒后缀也不算。
 */
export function isViaTunnelHostname(hostname: string): boolean {
  return typeof hostname === "string" && hostname.toLowerCase().endsWith(".trycloudflare.com")
}

/** 输入框非空才允许管理操作；只做本地判断，正确与否以 relay 的 admin_required 为准。 */
export function adminTokenReady(token: string): boolean {
  return token.trim().length > 0
}

const CODE_COPY: Record<string, string> = {
  device_offline: COPY.deviceOffline,
  device_no_active_session: COPY.noActive,
  session_not_found: COPY.sessionNotFound,
  cwd_not_allowed: COPY.cwdNotAllowed,
  no_device: COPY.noDevice,
  timeout: COPY.requestTimeout,
}

export class RelayError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "RelayError"
    this.code = code
  }
}

/** room.dialogs（P9 A）房间等待摘要里的一条未决 dialog：只带聚合所需字段，不带 options/message/prefill 正文。 */
export type RoomWaiting = {
  dialogId: string
  kind: string
  title?: string
  startedAt: number
  timeout?: number
  /** 这个网页能不能直接答（relay 按 dialog.respond cap 决定带不带；旧 relay 不带）。 */
  answerable?: boolean
}

/** room.dialogs（P9 A）旧的单槽 ui_prompt 兜底摘要：只在 waiting 为空时有意义。 */
export type RoomWaitingPrompt = { kind: string; title: string; at: number }

/**
 * room.activity（设计 D §2.3）房间最近事件摘要：relay 只记白名单事件类型与
 * toolName 工具名元数据（不带任何正文/参数）；回合落定后 relay 清空（null）。
 * 旧 relay 不下发（字段缺失）；UI 据它生成 busy 中的状态短语。
 */
export type RoomLastEvent = { type: string; toolName?: string; at: number }

/** room_list 房间条目里等待摘要的上限（协议 limits.dialogSlotsMax = 8）。 */
export const ROOM_WAITING_MAX = 8

export type RoomInfo = {
  id: string
  label: string | null
  /** 会话自定义名（session_info.name），没有就是 null */
  name?: string | null
  /** 会话首条用户消息，pi 未命名会话的默认标题 */
  firstMessage?: string | null
  /**
   * Crypto Phase 3 (design 4.1/7): the firstMessage preview arrived as an
   * ACK-level envelope instead of text -- this holds its ct (base64) for
   * the async decrypt-and-cache pass in useRelay. firstMessage stays null
   * in that case; the decrypted preview is substituted before list
   * building once it lands. Absent when the preview was plaintext.
   */
  firstMessageEnc?: string | null
  /**
   * Crypto Phase 3 (design 7): room_list carries enc:0|1 only to viewers
   * that declared crypto.content. true = body-encrypted room, false = the
   * relay explicitly says plaintext (legacy device room), undefined = the
   * relay did not say (old relay) -- never guessed either way.
   */
  enc?: boolean
  cwd: string | null
  online: boolean
  busy: boolean
  viewers: number
  /** 房间最近活动时间（relay 内存态）。同 cwd 多房间时据此挑最新的；旧 relay 不下发时为 0 */
  lastActivity: number
  accountId?: string
  deviceId?: string
  /** P9 A：这个房间的未决 dialog 摘要（旧 relay 不带；离线房间恒为空数组） */
  waiting?: RoomWaiting[]
  /** P9 A：旧的单槽 ui_prompt 兜底（旧 relay 不带；离线房间恒为 null） */
  waitingPrompt?: RoomWaitingPrompt | null
  /** 设计 D §2.3：最近事件摘要（旧 relay 不带；无事件/已落定时为 null） */
  lastEvent?: RoomLastEvent | null
}

export type Device = {
  id: string
  accountId: string
  name: string
  platform: string
  online: boolean
  projects: string[]
  /** P9 C：允许浏览的目录（device_register.device.browse.roots，relay 原样下发）。没开启浏览、旧 attach 或离线时为 [] */
  browseRoots: string[]
  lastAttachAt: number | null
  /** 首次登记（第一次连接）时间；老 relay / 老索引没有该字段时为 null，排序回退 lastAttachAt */
  firstSeenAt: number | null
  /** 连接窗口到期时间（relay 在窗口在线时下发；离线或旧 relay 为 null） */
  windowExpiresAt: number | null
  /** 当前在线连接的鉴权方式（v4 device.token）：token = 设备令牌，legacy = 旧的共享 localToken；离线或旧 relay 为 null */
  auth: "token" | "legacy" | null
  /** 有没有有效的设备令牌（配过对且没被撤销） */
  paired: boolean
  /**
   * 设备 ↔ relay 的心跳 RTT（毫秒；relay 用 ping/pong 实测后平滑，下发整数）。
   * 只有在线且已经开始心跳、有 pong 样本时才有值；离线 / 刚连上还没样本 / 旧 relay 为 null。
   * 页面据此显示「延迟 38ms」或「延迟 —」，不拿当前设备或上次连接的值外推。
   */
  latencyMs: number | null
  /**
   * Whether any pi bridge (extension) of this device is currently connected
   * and authenticated at the relay. `online` alone only proves the attach
   * window is connected; online && !bridgeOnline is the degraded state the
   * device list renders as 「仅远程窗口在线」. Optional for hand-written
   * literals; the roster mapper defaults it to true when an old relay does
   * not send the field, so old relays never trigger a false degraded badge.
   */
  bridgeOnline?: boolean
  /**
   * P9 B：这台设备在线连接声明的文件类能力（session.files / fs.browse 的交集；离线或旧 relay 为 []）。
   * 可选是为了兼容手写字面量（画廊 fixture 等）；业务读法统一 `device.features ?? []`。
   */
  features?: string[]
  /** P9 B：设备 PATH 里有没有 trash 命令（决定删除确认文案能不能说"移到废纸篓"）；缺省 false。 */
  trash?: boolean
}

export type SessionEntry = {
  id: string
  name: string
  firstMessage: string
  /** Crypto Phase 3: firstMessage arrived as an ACK envelope; holds its ct for the decrypt pass (see RoomInfo.firstMessageEnc). */
  firstMessageEnc?: string | null
  path: string
  cwd: string
  messageCount: number
  sizeBytes: number
  updatedAt: number
  active: boolean
  online: boolean
  deleted?: boolean
  /** fork 父会话的文件路径（文件头 parentSession，扩展/relay 透传）；非 fork 会话为 null。 */
  parentSession?: string | null
}

export type PendingStart = {
  kind: "cwd" | "session"
  key: string
  at: number
}

export type ListedSession = {
  id: string
  title: string
  firstMessage?: string
  path?: string
  cwd: string
  online: boolean
  busy: boolean
  viewers: number
  messageCount: number
  updatedAt: number
  /** 设备已连接且这是活动会话时才能订阅打开正文 */
  openable: boolean
  /** Crypto Phase 3: the backing room's encryption flag (RoomInfo.enc); undefined when there is no room or the relay did not say. */
  enc?: boolean
  /** fork 谱系呈现（R3-3 第 3 项）：merge 时按父路径在同设备清单内解析——
   *  "源自 <父会话当前名>"；父已不在清单 → "源会话已删除"；非 fork 行不带此字段、不占位。 */
  parentLabel?: string
}

export function errorCode(error: unknown): string {
  if (error instanceof RelayError) return error.code
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code
  }
  return ""
}

export function isUnknownType(error: unknown): boolean {
  return errorCode(error) === "unknown_type"
}

/** 错误码 → 统一文案。没有码时用服务端原文。 */
export function deviceErrorText(error: unknown): string {
  const code = errorCode(error)
  const message = error instanceof Error ? error.message : ""
  if (code === "spawn_failed") {
    const reason = message && message !== "失败" ? message : "未知原因"
    return reason.startsWith("本机启动失败") ? reason : `本机启动失败：${reason}`
  }
  if (code && CODE_COPY[code]) return CODE_COPY[code]
  return message || "失败"
}

/** 管理操作失败：admin_required 统一成可读文案，不区分“没配置”还是“令牌错了”。 */
export function adminTokenErrorText(error: unknown): string {
  if (errorCode(error) === "admin_required") return ADMIN_TOKEN_COPY.invalid
  return deviceErrorText(error)
}

/** 配对码展示成 XXXX-XXXX（DOC/71 §4.1）；relay 给的码带不带分隔符都规整成同一种 */
export function formatPairCode(code: string): string {
  const raw = code.replace(/[^0-9A-Za-z]/g, "").toUpperCase()
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw
}

/** 在要添加的电脑上执行的配对命令（DOC/71 §4.1）：macOS 和 Linux 共用 attach.sh */
export function pairCommands(code: string): { platform: "windows" | "unix"; label: string; command: string }[] {
  const shown = formatPairCode(code)
  return [
    { platform: "windows", label: "Windows", command: `node deploy\\attach.cjs --pair ${shown}` },
    { platform: "unix", label: "macOS / Linux", command: `deploy/attach.sh --pair ${shown}` },
  ]
}

/** 生成配对码那一刻名册里各设备是否已配对，用来认出这次配上的是哪台 */
export function pairBaseline(devices: Pick<Device, "id" | "paired">[]): Record<string, boolean> {
  return Object.fromEntries(devices.map((device) => [device.id, device.paired]))
}

/** 生成配对码之后新配上的设备：名册里新出现的已配对设备，或原来未配对、现在已配对的设备。
 *  已配对的设备重新配对时 paired 一直是 true，认不出来 */
export function newlyPaired<T extends Pick<Device, "id" | "paired">>(baseline: Record<string, boolean>, devices: T[]): T | null {
  return devices.find((device) => device.paired && baseline[device.id] !== true) ?? null
}

/** 配对码剩余时间 m:ss */
export function pairRemainText(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

/** attach 连接窗口剩余：11:32（不到 1 小时带秒），到期返回“已到期” */
export function windowRemainText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total <= 0) return "已到期"
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}` : `${m}:${String(total % 60).padStart(2, "0")}`
}

/** 会话/设备时间的人话：刚刚 / N 分钟前 / N 小时前 / N 天前 / M 月 D 日 */
export function relativeTime(ts: number | null | undefined, now = Date.now()): string {
  const at = Number(ts) || 0
  if (!at) return ""
  const diff = now - at
  if (diff < 60_000) return "刚刚"
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const d = new Date(at)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

/** 名册里的鉴权状态（只在 relay 有 device.token 能力时展示：旧 relay 没有这两个字段） */
export function deviceAuthState(device: Pick<Device, "auth" | "paired">): { text: string; tone: "ok" | "warn" | "muted" } {
  if (device.auth === "legacy") return device.paired ? { text: "已配对，但还在用旧令牌连接（重启 pi 后生效）", tone: "warn" } : { text: "旧令牌连接，未配对", tone: "warn" }
  if (device.paired) return { text: "已配对", tone: "ok" }
  return { text: "未配对", tone: "muted" }
}

/** 有令牌可作废、或正用令牌连着的设备才能撤销；未登记设备（旧扩展）没有身份可撤 */
export function canRevoke(device: Pick<Device, "id" | "auth" | "paired">): boolean {
  return device.id !== UNREGISTERED_DEVICE_ID && (device.paired || device.auth === "token")
}

/** 设备平台展示名。relay 已把 darwin / win32 归一成 macos / windows，这里也兼容老数据。 */
export function platformLabel(platform: string | null | undefined): string {
  const key = (platform || "").trim().toLowerCase()
  if (key === "windows" || key === "win32") return "Windows"
  if (key === "macos" || key === "darwin") return "macOS"
  if (key === "linux") return "Linux"
  return (platform || "").trim()
}

/** 名册生效时才走设备门控。没有 devices 字段、或名册是空的但房间还在时，退回原来的房间列表。 */
export function rosterActive(input: { deviceMode?: boolean; devices?: { id: string }[]; rooms?: { id: string }[] }): boolean {
  if (!input.deviceMode) return false
  if (input.devices && input.devices.length > 0) return true
  return !input.rooms || input.rooms.length === 0
}

type GateInput = {
  /** 和 relay 的连接已鉴权；断线重连期间发不出去，命令通道会直接报 offline */
  authed?: boolean
  deviceMode?: boolean
  devices?: Device[]
  rooms?: { id: string }[]
  selectedDeviceId?: string | null
  online?: boolean
  roomId?: string
}

/** canType 管输入框，canSend 管发送：断线重连期间照样能打字（手机上禁用输入框会把键盘收起），只是发不出去 */
export function composerGate(input: GateInput): { canSend: boolean; canType: boolean; placeholder: string } {
  const gate = sessionGate(input)
  if (input.authed === false) return { canSend: false, canType: gate.canSend, placeholder: COPY.composerLinkDown }
  return { ...gate, canType: gate.canSend }
}

/** 这条设备上真正要敲的 attach 命令：Mac/Linux 是 deploy/attach.sh，Windows 是 deploy\attach.cmd */
export function attachCommand(platform?: string | null): string {
  return platform === "windows" || platform === "win32" ? "deploy\\attach.cmd" : "deploy/attach.sh"
}

function sessionGate(input: GateInput): { canSend: boolean; placeholder: string } {
  if (!rosterActive(input)) {
    return { canSend: !!input.online && !!input.roomId, placeholder: COPY.composerDefault }
  }
  const device = (input.devices || []).find((item) => item.id === input.selectedDeviceId) || null
  if (!device) return { canSend: false, placeholder: COPY.composerPickDevice }
  if (!device.online) return { canSend: false, placeholder: `这台设备未连接：在电脑上运行 ${attachCommand(device.platform)}` }
  if (!input.online || !input.roomId) return { canSend: false, placeholder: COPY.composerIdle }
  return { canSend: true, placeholder: COPY.composerDefault }
}

/** 新建会话只能用名册里的 projects，不能随便写一条路径。 */
export function cwdInProjects(projects: string[] | undefined, cwd: string): boolean {
  const want = normPath(cwd)
  if (!want) return false
  return (projects || []).some((item) => normPath(item) === want)
}

/** 像 relay/devices.js 的 POSIX_PLATFORMS：这些平台区分大小写（其中 macOS 不区分）。 */
const POSIX_PLATFORMS = new Set(["macos", "linux", "freebsd", "openbsd", "netbsd", "sunos", "aix", "android"])

/** 按设备平台规范化路径（和 relay/devices.js 的 normPath 同一套规则）：Windows 反斜杠当分隔符、不分大小写；
 *  macOS（APFS 默认）不分大小写；Linux 等区分；平台未知（旧设备）沿用最宽松的旧规则。只用于比较，不用于显示。 */
function devicePathKey(path: string, platform?: string | null): string {
  const p = (platform || "").trim().toLowerCase()
  const posix = POSIX_PLATFORMS.has(p)
  let s = String(path || "")
  if (!posix) s = s.replace(/\\/g, "/")
  s = s.replace(/\/+$/, "")
  return !posix || p === "macos" ? s.toLowerCase() : s
}

/** 路径在不在某个浏览根目录下：相等，或者「根目录 + 分隔符」开头（大小写、分隔符按平台）。
 *  和 relay/viewer.js 的 underRoots 同口径——前缀后面必须紧跟分隔符，`/Users/user2` 不算在 `/Users/user` 下。 */
export function underRoots(roots: readonly string[] | null | undefined, cwd: string, platform?: string | null): boolean {
  const want = devicePathKey(cwd, platform)
  if (!want) return false
  for (const root of roots || []) {
    const base = devicePathKey(root, platform)
    if (!base) continue
    if (want === base || want.startsWith(base + "/")) return true
  }
  return false
}

/** P9 C §5.5：这个文件夹能不能选——在设备的 projects 白名单里，或者在它的浏览根目录下。规则和 relay 一致。 */
export function folderAllowed(device: Pick<Device, "projects" | "browseRoots" | "platform">, cwd: string): boolean {
  return cwdInProjects(device.projects, cwd) || underRoots(device.browseRoots, cwd, device.platform)
}

/** list_dirs 回包上限（protocol/v4.json 的 limits.dirListMax）：attach 只取前 500 个，网页再按同一上限兜一次 */
export const DIR_LIST_MAX = 500

/** 浏览根目录上限（protocol/v4.json 的 limits.browseRootsMax） */
export const BROWSE_ROOTS_MAX = 8

/** attach 的 list_dirs 回包里的一个子文件夹。只列目录名和路径，不返回文件，也不返回任何文件内容 */
export type DirEntry = { name: string; path: string }

/** attach 的 list_dirs 回包（relay 原样透传）：root = 这个路径所属的浏览根目录；parent 在根目录时为 null */
export type DirListResult = {
  root: string
  path: string
  parent: string | null
  entries: DirEntry[]
  truncated: boolean
}

/** 有在线房间的设备优先；多台都有时选最近有活动的那台（lastActivity 相同则取列表里更靠后的房间）。
 *  都没有在线房间时，才退回第一台在线设备，再没有就用名册第一台。 */
export function pickDefaultDevice(devices: Device[], rooms: Pick<RoomInfo, "online" | "deviceId" | "lastActivity">[] = []): string | null {
  if (!devices.length) return null
  const known = new Set(devices.map((device) => device.id))
  const live = rooms.filter((room) => room.online && known.has(roomDeviceId(room)))
  const best = live.length ? live.reduce((pick, room) => ((room.lastActivity || 0) >= (pick.lastActivity || 0) ? room : pick), live[0]) : null
  if (best) return roomDeviceId(best)
  return (devices.find((device) => device.online) || devices[0]).id
}

/** 当前房间仍在线、而且它的设备也在线时，留在这台设备上（刷新/重连不要被另一台抢走）。 */
export function preferredDeviceId(
  rooms: Pick<RoomInfo, "id" | "online" | "deviceId">[],
  currentRoomId: string,
  devices: Pick<Device, "id" | "online">[],
): string | null {
  if (!currentRoomId) return null
  const current = rooms.find((room) => room.id === currentRoomId)
  if (!current?.online || !current.deviceId) return null
  const device = devices.find((item) => item.id === current.deviceId)
  return device?.online ? device.id : null
}

/** 某台设备上最近活动的在线房间。不传 deviceId 时在全部在线房间里挑。 */
export function pickEntryRoom<T extends Pick<RoomInfo, "online" | "deviceId" | "lastActivity">>(rooms: T[], deviceId?: string | null): T | null {
  const matches = rooms.filter((room) => room.online && (deviceId == null || roomDeviceId(room) === deviceId))
  if (!matches.length) return null
  return matches.reduce((pick, room) => ((room.lastActivity || 0) >= (pick.lastActivity || 0) ? room : pick), matches[0])
}

/** 登录后要打开的房间。当前房间仍在这台在线设备上跑着，就留在原地；否则进入该设备最近活动的在线房间。没有就停在名册。 */
export function pickLoginRoom(
  rooms: Pick<RoomInfo, "id" | "online" | "deviceId" | "lastActivity">[],
  selectedDeviceId: string | null,
  currentRoomId: string,
  deviceOnline: boolean,
): string | null {
  if (!selectedDeviceId || !deviceOnline) return null
  const saved = currentRoomId ? rooms.find((room) => room.id === currentRoomId) : undefined
  if (saved?.online && roomDeviceId(saved) === selectedDeviceId) return saved.id
  return pickEntryRoom(rooms, selectedDeviceId)?.id ?? null
}

/** 设备在线但没有正在跑的会话时给用户的说明。有在跑的会话、或设备离线时不显示。 */
export function idleDeviceHint(device: Pick<Device, "online" | "projects"> | null | undefined, running: boolean): string | null {
  if (!device?.online || running) return null
  const names = [...new Set((device.projects || []).map((cwd) => baseName(cwd)).filter(Boolean))]
  if (!names.length) return "这台设备在线，但没有正在跑的会话，也没有允许的目录可以新建。在左侧点选已保存的会话，发送第一条消息时载入。"
  return `这台设备在线，但没有正在跑的会话。在左侧点选一个会话，发送第一条消息时载入；或点「新建会话」从允许的目录开始：${names.join("、")}`
}

/** 还没打开房间时，主区域的空状态。三套皮肤共用这一句。 */
export function sessionEmptyHint(device: Pick<Device, "online" | "projects"> | null | undefined, running: boolean): string {
  const idle = idleDeviceHint(device, running)
  if (idle) return idle
  if (!device) return "先选一台设备，再打开活动会话。"
  if (!device.online) return "这台设备未连接，只能看清单，不能打开正文。"
  return "从列表打开正在跑的会话。"
}

export function roomDeviceId(room: Pick<RoomInfo, "deviceId"> | null | undefined): string {
  if (!room?.deviceId) return UNREGISTERED_DEVICE_ID
  return room.deviceId
}

export function parseRooms(raw: unknown): RoomInfo[] {
  if (!Array.isArray(raw)) return []
  const rooms: RoomInfo[] = []
  for (const item of raw) {
    const room = parseRoom(item)
    if (room.id) rooms.push(room)
  }
  return rooms
}

export function devicesFromRoomList(raw: unknown, rooms: RoomInfo[]): Device[] {
  const devices = Array.isArray(raw) ? raw.flatMap((item) => {
    const device = parseDevice(item)
    return device ? [device] : []
  }) : []
  const known = new Set(devices.map((device) => device.id))
  for (const room of rooms) {
    const id = room.deviceId || UNREGISTERED_DEVICE_ID
    if (known.has(id)) continue
    devices.push(id === UNREGISTERED_DEVICE_ID ? unregisteredDevice() : placeholderDevice(id, room.accountId))
    known.add(id)
  }
  return devices
}

export function parseSessionList(raw: unknown): SessionEntry[] {
  if (!Array.isArray(raw)) return []
  const byId = new Map<string, SessionEntry>()
  for (const item of raw) {
    const session = parseSession(item)
    if (!session) continue
    const prev = byId.get(session.id)
    if (!prev || session.updatedAt >= prev.updatedAt) byId.set(session.id, session)
  }
  return [...byId.values()]
}

/** fork 谱系解析（R3-3 第 3 项）：按父路径在同设备清单内找父行，父名走与 sessionRow 相同的
 *  标题口径（父改名后呈现自然跟随当前名）；父行在清单内且已删除 → "源会话已删除"。
 *  父行不在清单时要看清单完不完整（C-3）：清单被截断（listTruncated，relay 只取最近
 *  200/帧批次截断）时父行可能只是没被带上，只许呈中性态"源会话不在当前清单"，
 *  不许假报已删除；清单完整时不在才真是已删除。 */
function withSessionLineage(rows: ListedSession[], sessions: SessionEntry[], listTruncated = false): ListedSession[] {
  const parentPathById = new Map(sessions.map((session) => [session.id, session.parentSession ?? null]))
  if (![...parentPathById.values()].some(Boolean)) return rows
  const byPath = new Map<string, SessionEntry>()
  for (const session of sessions) if (session.path) byPath.set(normPath(session.path), session)
  return rows.map((row) => {
    const parentPath = parentPathById.get(row.id)
    if (!parentPath) return row
    const parent = byPath.get(normPath(parentPath))
    if (!parent) return { ...row, parentLabel: listTruncated ? "源会话不在当前清单" : "源会话已删除" }
    if (parent.deleted || parent.id === row.id) return { ...row, parentLabel: "源会话已删除" }
    const parentTitle = parent.name || parent.firstMessage || (parent.cwd ? baseName(parent.cwd) : parent.id.slice(0, 8))
    return { ...row, parentLabel: `源自 ${parentTitle}` }
  })
}

/** 活动房间置顶，索引按 updatedAt 倒序；同 id 以活动房间为准。设备未连接时只留索引（外加尚未进索引的房间），全部不可打开。
 *  listTruncated = 该设备清单帧带 truncated（不完整）：只喂 fork 谱系的诚实态判定（C-3）。 */
export function mergeDeviceSessions(device: Device, rooms: RoomInfo[], sessions: SessionEntry[], listTruncated = false): ListedSession[] {
  const mine = rooms.filter((room) => roomDeviceId(room) === device.id)
  const byId = new Map(sessions.map((session) => [session.id, session]))
  if (!device.online) {
    const fromIndex = sessions.filter((session) => !session.deleted).map((session) => sessionRow(session, false))
    const known = new Set(fromIndex.map((row) => row.id))
    const extras = mine.filter((room) => !known.has(room.id))
    const live = extras.filter((room) => room.online).map((room) => roomRow(room, false, byId.get(room.id)))
    const idle = extras.filter((room) => !room.online).map((room) => roomRow(room, false, byId.get(room.id)))
    fromIndex.sort((a, b) => b.updatedAt - a.updatedAt)
    return withSessionLineage(uniqueRows([...live, ...fromIndex, ...idle]), sessions, listTruncated)
  }
  const roomById = new Map(mine.map((room) => [room.id, room]))
  const active = mine.filter((room) => room.online).map((room) => roomRow(room, true, byId.get(room.id)))
  const activeIds = new Set(active.map((row) => row.id))
  const indexedActive: ListedSession[] = []
  const rest: ListedSession[] = []
  for (const session of sessions) {
    if (session.deleted || activeIds.has(session.id)) continue
    const room = roomById.get(session.id)
    const online = !!(room && room.online)
    if (online) indexedActive.push(sessionRow({ ...session, online: true }, true))
    else rest.push(sessionRow({ ...session, online: false }, false))
  }
  rest.sort((a, b) => b.updatedAt - a.updatedAt)
  // 设备在线、但还没进索引的离线房间（刚关掉、清单还没推上来）：留在列表末尾可回看，不能直接丢
  const indexed = new Set(sessions.map((session) => session.id))
  const idle = mine.filter((room) => !room.online && !indexed.has(room.id)).map((room) => roomRow(room, false, byId.get(room.id)))
  return withSessionLineage(uniqueRows([...active, ...indexedActive, ...rest, ...idle]), sessions, listTruncated)
}

export function groupListedSessions(rows: ListedSession[]): { cwd: string; items: ListedSession[] }[] {
  const groups = new Map<string, ListedSession[]>()
  for (const row of rows) {
    const key = row.cwd || ""
    const list = groups.get(key) || []
    list.push(row)
    groups.set(key, list)
  }
  return [...groups.entries()].map(([cwd, items]) => ({ cwd, items }))
}

export function findStartedRoom(
  watch: { kind: "cwd" | "session"; key: string; seen: Set<string> },
  deviceId: string,
  rooms: RoomInfo[],
): RoomInfo | null {
  if (watch.kind === "session") {
    return (
      rooms.find((room) => {
        if (room.id !== watch.key || !room.online) return false
        if (room.deviceId && room.deviceId !== deviceId) return false
        return true
      }) || null
    )
  }
  const cwd = normPath(watch.key)
  const matches = rooms.filter(
    (room) => room.online && roomDeviceId(room) === deviceId && normPath(room.cwd || "") === cwd && !watch.seen.has(room.id),
  )
  // 同 cwd 同时起两个会话时挑**最近活动**的那个（和 relay 的 onlineRoomByCwd 一致）。
  // 旧 relay 不下发 lastActivity（全 0）时退化成"列表最后一个"，与旧行为相同。
  if (!matches.length) return null
  return matches.reduce((best, room) => ((room.lastActivity || 0) >= (best.lastActivity || 0) ? room : best), matches[0])
}

export function baseName(cwd: string): string {
  const parts = cwd.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] || cwd
}

function uniqueRows(rows: ListedSession[]): ListedSession[] {
  const seen = new Set<string>()
  const out: ListedSession[] = []
  for (const row of rows) {
    if (!row.id || seen.has(row.id)) continue
    seen.add(row.id)
    out.push(row)
  }
  return out
}

function placeholderDevice(id: string, accountId?: string): Device {
  return {
    id,
    accountId: accountId || "admin",
    name: id,
    platform: "",
    online: false,
    projects: [],
    browseRoots: [],
    lastAttachAt: null,
    firstSeenAt: null,
    windowExpiresAt: null,
    auth: null,
    paired: false,
    latencyMs: null,
    features: [],
    trash: false,
  }
}

function unregisteredDevice(): Device {
  return {
    id: UNREGISTERED_DEVICE_ID,
    accountId: "admin",
    name: UNREGISTERED_DEVICE_ID,
    platform: "",
    online: false,
    projects: [],
    browseRoots: [],
    lastAttachAt: null,
    firstSeenAt: null,
    windowExpiresAt: null,
    auth: null,
    paired: false,
    latencyMs: null,
    features: [],
    trash: false,
  }
}

/**
 * Crypto Phase 3: a firstMessage field in envelope form ({enc:1, ct})
 * yields its ct; plaintext strings and anything else yield null. The
 * envelope shape check lives here so room rows, session rows and archive
 * rows all recognize exactly the same form.
 */
export function firstMessageEncOf(raw: unknown): string | null {
  if (!isRecord(raw) || raw.enc !== 1 || typeof raw.ct !== "string" || !raw.ct) return null
  return raw.ct
}

function parseRoom(raw: unknown): RoomInfo {
  const rec = isRecord(raw) ? raw : {}
  const waiting = parseRoomWaiting(rec.waiting)
  const waitingPrompt = parseRoomWaitingPrompt(rec.waitingPrompt)
  const lastEvent = parseRoomLastEvent(rec.lastEvent)
  const firstMessageEnc = firstMessageEncOf(rec.firstMessage)
  return {
    id: typeof rec.id === "string" ? rec.id : "",
    label: typeof rec.label === "string" ? rec.label : null,
    name: typeof rec.name === "string" && rec.name ? rec.name : null,
    firstMessage: typeof rec.firstMessage === "string" && rec.firstMessage ? rec.firstMessage : null,
    ...(firstMessageEnc ? { firstMessageEnc } : {}),
    ...(rec.enc === 1 ? { enc: true } : rec.enc === 0 ? { enc: false } : {}),
    cwd: typeof rec.cwd === "string" ? rec.cwd : null,
    online: rec.online === true,
    busy: rec.busy === true,
    viewers: typeof rec.viewers === "number" ? rec.viewers : 0,
    lastActivity: typeof rec.lastActivity === "number" ? rec.lastActivity : 0,
    accountId: typeof rec.accountId === "string" ? rec.accountId : undefined,
    deviceId: typeof rec.deviceId === "string" && rec.deviceId ? rec.deviceId : undefined,
    ...(waiting !== undefined ? { waiting } : {}),
    ...(waitingPrompt !== undefined ? { waitingPrompt } : {}),
    ...(lastEvent !== undefined ? { lastEvent } : {}),
  }
}

/** room.activity（设计 D §2.3）：lastEvent 的类型校验；字段不出现 = 旧 relay，返回 undefined。形状不合法记 null（无事件），不猜。 */
function parseRoomLastEvent(raw: unknown): RoomLastEvent | null | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) return null
  const type = typeof raw.type === "string" ? raw.type : ""
  if (!type) return null
  const at = typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : 0
  const out: RoomLastEvent = { type, at }
  if (typeof raw.toolName === "string" && raw.toolName) out.toolName = raw.toolName
  return out
}

/**
 * room.dialogs（P9 A）：waiting[] 的类型校验。非法项直接丢掉（不猜）；最多 ROOM_WAITING_MAX 条；
 * dialogId 必须是非空字符串（条目定位与去重键），其余字段缺省按零值。字段不出现 = 旧 relay，
 * 返回 undefined 以便区分"旧 relay 不带"和"新 relay 明确为空"。
 */
function parseRoomWaiting(raw: unknown): RoomWaiting[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) return []
  const out: RoomWaiting[] = []
  for (const item of raw) {
    if (out.length >= ROOM_WAITING_MAX) break
    if (!isRecord(item)) continue
    const dialogId = typeof item.dialogId === "string" ? item.dialogId : ""
    if (!dialogId) continue
    const waiting: RoomWaiting = {
      dialogId,
      kind: typeof item.kind === "string" ? item.kind : "",
      startedAt: typeof item.startedAt === "number" && Number.isFinite(item.startedAt) ? item.startedAt : 0,
    }
    if (typeof item.title === "string" && item.title) waiting.title = item.title
    if (typeof item.timeout === "number" && Number.isFinite(item.timeout) && item.timeout > 0) waiting.timeout = item.timeout
    if (item.answerable === true) waiting.answerable = true
    out.push(waiting)
  }
  return out
}

/** room.dialogs（P9 A）：waitingPrompt 的类型校验；null / 缺失 = 不在等。 */
function parseRoomWaitingPrompt(raw: unknown): RoomWaitingPrompt | null | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) return null
  const title = typeof raw.title === "string" ? raw.title : ""
  const kind = typeof raw.kind === "string" ? raw.kind : ""
  if (!title && !kind) return null
  return {
    kind,
    title,
    at: typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : 0,
  }
}


function parseDevice(raw: unknown): Device | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id) return null
  const projects = Array.isArray(raw.projects) ? raw.projects.filter((item): item is string => typeof item === "string" && !!item) : []
  // P9 B：features 只在设备在线时由 relay 下发（attach 的能力交集）；离线 / 旧 relay 缺省 []。
  const features = Array.isArray(raw.features) ? raw.features.filter((item): item is string => typeof item === "string" && !!item) : []
  // P9 C：允许浏览的根目录（device.browse.roots）；缺省 [] = 没有开启文件夹浏览
  const browseRoots = Array.isArray(raw.browseRoots)
    ? raw.browseRoots.filter((item): item is string => typeof item === "string" && !!item.trim()).slice(0, BROWSE_ROOTS_MAX)
    : []
  return {
    id: raw.id,
    accountId: typeof raw.accountId === "string" && raw.accountId ? raw.accountId : "admin",
    name: typeof raw.name === "string" && raw.name ? raw.name : raw.id,
    platform: typeof raw.platform === "string" ? raw.platform : "",
    online: raw.online === true,
    projects,
    browseRoots,
    lastAttachAt: typeof raw.lastAttachAt === "number" ? raw.lastAttachAt : null,
    firstSeenAt: typeof raw.firstSeenAt === "number" ? raw.firstSeenAt : null,
    windowExpiresAt: typeof raw.windowExpiresAt === "number" ? raw.windowExpiresAt : null,
    auth: raw.auth === "token" || raw.auth === "legacy" ? raw.auth : null,
    paired: raw.paired === true,
    // 延迟白名单：只认有限非负数；缺省 / null / 字符串 / 负值一律 null（不把「没有样本」写成 0ms）
    latencyMs:
      typeof raw.latencyMs === "number" && Number.isFinite(raw.latencyMs) && raw.latencyMs >= 0
        ? Math.round(raw.latencyMs)
        : null,
    // Bridge presence from the relay roster; an old relay omits the field
    // and must not read as "bridge missing", so only an explicit false counts.
    bridgeOnline: raw.bridgeOnline !== false,
    features,
    trash: raw.trash === true,
  }
}

/** list_dirs 回包清洗（relay 原样透传 attach 的结果）：只信任 name / path 两个非空字符串，最多留 500 条。
 *  path 为空串说明回包缺了必填字段——调用方（useRelay.listDirs）据此报 bad_reply，不拿半个结果去浏览。 */
export function parseDirList(raw: unknown): DirListResult {
  const rec = isRecord(raw) ? raw : {}
  const entries: DirEntry[] = []
  for (const item of Array.isArray(rec.entries) ? rec.entries : []) {
    if (!isRecord(item) || typeof item.name !== "string" || !item.name || typeof item.path !== "string" || !item.path) continue
    entries.push({ name: item.name, path: item.path })
    if (entries.length >= DIR_LIST_MAX) break
  }
  return {
    root: typeof rec.root === "string" ? rec.root : "",
    path: typeof rec.path === "string" ? rec.path : "",
    parent: typeof rec.parent === "string" && rec.parent ? rec.parent : null,
    entries,
    truncated: rec.truncated === true || (Array.isArray(rec.entries) && rec.entries.length > DIR_LIST_MAX),
  }
}

function parseSession(raw: unknown): SessionEntry | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id) return null
  if (raw.deleted === true) return null
  const firstMessageEnc = firstMessageEncOf(raw.firstMessage)
  return {
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : "",
    firstMessage: typeof raw.firstMessage === "string" ? raw.firstMessage : "",
    ...(firstMessageEnc ? { firstMessageEnc } : {}),
    path: typeof raw.path === "string" ? raw.path : "",
    cwd: typeof raw.cwd === "string" ? raw.cwd : "",
    messageCount: typeof raw.messageCount === "number" ? raw.messageCount : 0,
    sizeBytes: typeof raw.sizeBytes === "number" ? raw.sizeBytes : 0,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    active: raw.active === true,
    online: raw.online === true,
    deleted: false,
    parentSession: typeof raw.parentSession === "string" && raw.parentSession ? raw.parentSession : null,
  }
}

function sessionRow(session: SessionEntry, openable: boolean): ListedSession {
  return {
    id: session.id,
    title: session.name || cleanSessionTitleText(session.firstMessage) || (session.cwd ? baseName(session.cwd) : session.id.slice(0, 8)),
    firstMessage: session.firstMessage || undefined,
    path: session.path || undefined,
    cwd: session.cwd,
    online: openable,
    busy: false,
    viewers: 0,
    messageCount: session.messageCount,
    updatedAt: session.updatedAt,
    openable,
  }
}

function roomRow(room: RoomInfo, openable: boolean, session?: SessionEntry | null): ListedSession {
  const folder = room.cwd ? baseName(room.cwd) : ""
  const customLabel = !!room.label && room.label !== folder && room.label !== room.id
  return {
    id: room.id,
    title:
      (customLabel ? room.label : null) ||
      session?.name ||
      // 首条消息作标题要过清洗规则（设计 D §2.1）；清洗后为空顺延下一档
      cleanSessionTitleText(session?.firstMessage) ||
      room.name ||
      cleanSessionTitleText(room.firstMessage) ||
      room.label ||
      (room.cwd ? folder : room.id.slice(0, 8)),
    firstMessage: session?.firstMessage || room.firstMessage || undefined,
    path: session?.path || undefined,
    cwd: room.cwd || "",
    online: openable && room.online,
    busy: room.busy,
    viewers: room.viewers,
    // P5 G3：房间行的条数 / 时间回落到清单里同 id 的会话（会话文件）和房间的 lastActivity，取较新的那个；
    // 都没有时仍是 0（行尾不显示时间，§1.9）。以前固定写 0，在线会话的行尾没有时间、菜单副标题缺条数
    messageCount: session?.messageCount ?? 0,
    updatedAt: Math.max(session?.updatedAt || 0, room.lastActivity || 0),
    openable,
    // Only present when the relay stated the room's encryption flag, so
    // rows built from old relays keep their exact previous shape.
    ...(room.enc !== undefined ? { enc: room.enc } : {}),
  }
}

function normPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
