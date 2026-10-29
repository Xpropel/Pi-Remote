import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import type { UsageSnapshotFrame } from "@/pi/usage/types"
import { bodySearchTargetsOf, mergeBodySearchReplies, type BodySearchReply } from "./bodySearch"
import { CommandChannel } from "./commands"
import {
  DELETED_SESSIONS_KEY,
  readDeletedSessions,
  rememberDeletedSession,
  withoutDeletedRooms,
  withoutDeletedSessions,
  type DeletedSessionsStorage,
} from "./deletedSessions"
import { composerFactsOf } from "./composerFacts"
import { cleanSessionTitleText } from "./titleText"
import { archiveView, rememberSessionArchive, touchSessionArchive, type ArchiveSession } from "./sessionArchive"
import {
  archiveKeysOf,
  createPurgedSessionTable,
  parseSessionRemoved,
  purgedIdsOf,
  rememberPurgedSessions,
  removalTargetOf,
  withoutPurgedSessions,
  withoutRemovedRooms,
  withoutRemovedSessions,
} from "./sessionRemoved"
import {
  ADMIN_TOKEN_COPY,
  ADMIN_TOKEN_STORAGE_KEY,
  COPY,
  DEVICE_COMMAND_TIMEOUT_MS,
  GET_SESSIONS_TIMEOUT_MS,
  HARNESS_START_TIMEOUT_MS,
  PAIR_CODE_TTL_MS,
  RelayError,
  SESSION_ONLINE_WATCH_MS,
  UNREGISTERED_DEVICE_ID,
  adminTokenReady,
  composerGate,
  deviceErrorText,
  errorCode,
  devicesFromRoomList,
  findStartedRoom,
  folderAllowed,
  isUnknownType,
  isViaTunnelHostname,
  mergeDeviceSessions,
  parseDirList,
  parseRooms,
  parseSessionList,
  pickDefaultDevice,
  pickLoginRoom,
  preferredDeviceId,
  roomDeviceId,
  rosterActive,
  type Device,
  type DirListResult,
  type ListedSession,
  type PendingStart,
  type RoomInfo,
  type SessionEntry,
} from "./devices"
import {
  MAX_PENDING_IMAGES,
  SEND_IMAGE_MAX_CHARS,
  SEND_IMAGE_TOTAL_MAX_CHARS,
  SEND_MODE_KEY,
  deliveryPlan,
  imageCharsTotal,
  mergeModelMeta,
  modelMetaFrom,
  parseSendMode,
  planSendImages,
  type ModelMeta,
  type SendMode,
} from "@/chat/composerTools"
import { setRemoteImageLoader } from "@/conversation/remoteImage"
import { ACK_TIMEOUT_MS, createSendLock } from "@/chat/composerMachine"
import { OFFLINE_SEND_COPY } from "@/chat/composer/composerPlan"
import { noticeChannel, noticeLevelForTone } from "@/chat/composer/noticeBridge"
import { taskListAfterEvent, type TaskListItem } from "@/chat/composer/taskList"
import { expandMentionText, MAX_PENDING_FILES, type MentionFile } from "@/chat/composer/mention"
import {
  dialogReceiptOf,
  dialogsAfterEvent,
  extStatusAfterEvent,
  uiPromptAfterEvent,
  type DialogAnswer,
  type DialogAnswerResult,
  type DialogCard,
  type DialogReceipt,
  type ExtStatusSnapshot,
  type UiPrompt,
} from "@/chat/composer/promptModel"
import {
  emptyRoomTurnTracker,
  forgetRoomTurnEnd,
  roomAttentionSeedOf,
  roomTurnEndsOf,
  roomTurnSeedsOf,
  seedRoomTurnEnds,
  trackRoomEventEdge,
  trackRoomListEdges,
  trackRoomOfflineEdge,
  type RoomTurnEvent,
  type RoomTurnTracker,
} from "@/relay/attention"
import { applyInboxUpdate, inboxTurnSeedsOf, parseInboxEntries, type InboxEntry } from "@/relay/inbox"
import { parseScheduleEntries, scheduleMapOfRooms, type ScheduleCreateInput, type ScheduleEntry } from "@/relay/schedule"
import { useAskGatePrefs, useLegacyStyle } from "@/pi/hooks/useLegacyStyle"
import {
  TERMINAL_UPDATE_FLUSH_MS,
  TOOL_END_META_MAX,
  applyToolEndMeta,
  isTerminalToolName,
  mergeTerminalHistoryItems,
  parseToolEndMetaFrame,
  reduceTerminalEvent,
  reduceTerminalEvents,
  settleTerminalItems,
  shiftTerminalEvent,
  shiftToolEndMeta,
  terminalClockOffset,
  terminalHistoryItems,
  type TerminalEvent,
  type TerminalItem,
  type ToolEndMeta,
} from "@/chat/capsules/terminalModel"
import { agentIsActive, agentStateAfterEvent, type AgentEntry } from "@/chat/capsules/workingModel"
import { useComposerUi } from "@/chat/composer/useComposerUi"
import { useNotices } from "@/chat/composer/useNotices"
import {
  lazyRoomFromRow,
  lazySendPhaseText,
  stepLazySend,
  withLazyRoom,
  type LazySelection,
  type LazySend,
} from "./lazySession"
import { headerMeta } from "./presence"
import { V3_SERVER, authFrame, deviceRevokeFrame, hasCap, isCid, newCid, pairApproveFrame, pairCreateFrame, pairLookupFrame, serverInfo, type ServerInfo } from "./protocol"
import { parsePairLookup, type PairLookupInfo } from "./pairLink"
import { mobileNavFromPrefsSubset } from "@/pi/model/prefs"
import type { PiMobileNavMode } from "@/pi/mobile/types"
import { emptyRemoteQueue, parseRemoteQueueItem, parseRemoteQueueState, type RemoteQueueState } from "./remoteQueue"
import { compactionNumbersOf } from "./compactionResult"
import { readRoomDraft, saveRoomDraft, reconcileRemoteDraft, roomDraftFromRaw, shouldPersistDraft, DRAFTS_STORAGE_KEY } from "./drafts"
import {
  EMPTY_OUTBOX,
  OUTBOX_STORAGE_KEY,
  loadOutbox,
  newOutboxOwner,
  nextReplay,
  outboxClaimedBy,
  outboxOf,
  outboxReducer,
  saveOutbox,
  type OutboxAction,
  type OutboxEntry,
  type OutboxState,
  type StorageLike,
} from "@/pi/model/outbox"
import { emptySync, eventStep, snapshotStep, type SyncState } from "./sync"
import {
  chainInWindow,
  entryIdOf,
  findAnchor,
  headFingerprints,
  parseEntriesResult,
  slicePageBefore,
  windowStartOf,
  HISTORY_DISCOVERY_START,
  HISTORY_PAGE_MESSAGES,
  HISTORY_WINDOW_MAX,
  HISTORY_WINDOW_START,
  type ChainEntry,
  type EntriesResult,
} from "./history"
import {
  HISTORY_CACHE_FETCH_MARGIN,
  historyCacheCovers,
  historyWindowFrom,
  mergeHistoryWindow,
  type HistoryCache,
} from "./historyCache"
import {
  acceptSocketFrame,
  backfillInfoOf,
  createDeviceRequestTickets,
  emptyTranscript,
  reduceTranscript,
  textOf,
  imagesOf,
  type AgentMessage,
  type AssistantEvent,
  type SendImage,
  type Transcript,
  type TranscriptAction,
} from "./transcript"

export type { Device, ListedSession, PendingStart, RoomInfo, SessionEntry } from "./devices"
export { composerGate, rosterActive }

/** 存储安全封装：隐私模式 / 配额已满时 localStorage/sessionStorage 会抛异常，
 *  裸调用会让订阅流程半途中断（标题已换、正文还是旧会话、永远等不到 snapshot）。 */
const safeStore = {
  get(key: string): string | null {
    try { return window.localStorage.getItem(key) } catch { return null }
  },
  set(key: string, value: string): boolean {
    try { window.localStorage.setItem(key, value); return true } catch { return false }
  },
  remove(key: string) {
    try { window.localStorage.removeItem(key) } catch {}
  },
  session: {
    get(key: string): string | null {
      try { return window.sessionStorage.getItem(key) } catch { return null }
    },
    set(key: string, value: string): boolean {
      try { window.sessionStorage.setItem(key, value); return true } catch { return false }
    },
    remove(key: string) {
      try { window.sessionStorage.removeItem(key) } catch {}
    },
  },
}

/** outbox 的存储：访问 window.localStorage 本身就可能抛（隐私模式），拿不到时 outbox 停用、退回"消息留在输入框" */
function outboxStorage(): StorageLike | null {
  try { return window.localStorage } catch { return null }
}
/** 网页删掉的会话（deletedSessions.ts）：同 outbox，拿不到 localStorage 时不记，删掉的会话只是在侧栏里多留一会儿 */
function deletedStorage(): DeletedSessionsStorage | null {
  try { return window.localStorage } catch { return null }
}
/** 页面载入：读出上次的 outbox，把关在回放途中的条目转失败（结果未知，绝不自动再发同一个 cid） */
function initialOutbox(): OutboxState {
  const storage = outboxStorage()
  const loaded = loadOutbox(storage)
  const next = outboxReducer(loaded, { type: "recover", error: "上次发送途中页面关闭，结果未知；请看会话再决定是否重试" })
  if (next !== loaded) saveOutbox(storage, next)
  return next
}
function newDedupeKey(): string {
  return "ob_" + newCid()
}
/** 回放时这些失败码表示帧没送到 pi（连接断了 / 本机未连接）：cid 没上过线，原样再排，不算失败 */
const OUTBOX_REQUEUE_CODES = new Set(["offline", "room_offline", "device_offline"])

/** 提示的稳定类别：清提示按 category 判断，不把文案正则当唯一判据（文案会改，错误文本也可能碰巧命中）。 */
type NoticeCode = "connectivity" | "progress" | "truncated" | "compaction" | "summarization" | "lazy-send"
type Notice = { text: string; tone: "warn" | "bad"; codes?: NoticeCode[] } | null
type Queue = { steering: AgentMessage[]; followUp: AgentMessage[] }
/** 一次助手回合的完成信号：seq 单调递增供 UI 只消费一次；error 区分成功/错误角标。 */
export type TurnEnd = { seq: number; at: number; roomId: string; error: boolean }
/** lazySession.ts 的 LazySend 只声明了单图字段；多图作为附加字段随对象原样传递。 */
type LazySendWithImages = LazySend & { images?: SendImage[] }

/** 缺口补齐的最小间隔：一次重订阅在飞时，后续缺口帧都会被它的回复覆盖 */
const RESYNC_GAP_MS = 1500
/** 心跳间隔；页面在前台时整整一轮连 pong 都没收到，就当死连接换一条 */
const PING_INTERVAL_MS = 25000
/** 切回前台 / 网络恢复时验活：发 ping 后这么久什么都没收到就换连接 */
const PROBE_TIMEOUT_MS = 8000
/** 建连加鉴权的上限：手机网络下 TCP 握手可能挂一分多钟，超时就关掉走正常的退避重连 */
const CONNECT_TIMEOUT_MS = 12000
/** 流式 delta 的提交间隔：50ms 内的事件合成一次 reducer 调用（20fps），避免每个 delta 复制整段 items */
const TRANSCRIPT_DELTA_FLUSH_MS = 50
/** 后台标签页的定时器会被节流：队列超过这个数就立刻提交，避免事件在内存里无限堆积 */
const TRANSCRIPT_DELTA_MAX_PENDING = 512

/*
 * 只增登记表的硬上限（UI 低危：长期会话的缓慢内存增长）。
 * 这些表只为"识别旧 id / 去重"存在，超出部分按插入顺序丢最旧的；其中 terminalHistoryIdsRef
 * 与 terminalEndMetaRef 同额（元数据已被 FIFO 丢掉的 id 不会再生成历史条目，丢 id 不会复活）。
 * purgedSessionsRef 不封顶：B1 的整表过滤要求页面生命周期内已删 id 一个都不能少；它的规模
 * 只随"删除过的会话数"增长，远小于会话正文，不构成缓慢泄漏。
 */
const KNOWN_ROOM_IDS_MAX = 4096
const SUPPRESSED_STARTED_ROOMS_MAX = 512
const LOCAL_ECHO_CIDS_MAX = 200
const TERMINAL_HISTORY_IDS_MAX = TOOL_END_META_MAX
/** 同一条 assistant 消息的起始帧重复到达（重连 / 重复订阅）的去重窗口 */
const MESSAGE_START_DEDUPE_MS = 60_000

/** 只增 Set 的封顶：超过 max 时按插入顺序丢最旧的（Set 迭代顺序 = 插入顺序）。 */
function capGrowingSet(set: Set<string>, max: number): void {
  while (set.size > max) {
    const oldest = set.values().next().value
    if (typeof oldest !== "string") break
    set.delete(oldest)
  }
}

/** relay 地址：构建时的 VITE_RELAY_URL > 同源 > 本机兜底。不接受链接里的地址，避免把查看端 token 发给别人。 */
const DEFAULT_RELAY = "ws://127.0.0.1:7002";
function wsUrl() {
  const env = (import.meta as any).env?.VITE_RELAY_URL
  if (env) return String(env)
  const host = location.host
  if (host && location.protocol.startsWith("http")) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:"
    return `${proto}//${host}/`
  }
  return DEFAULT_RELAY + "/"
}

export function roomTitle(room: RoomInfo | null) {
  if (!room) return "选择一个会话"
  // 目录名不是对话名：label 只有和目录末段不同（用户改名）时才优先
  const folder = room.cwd ? cwdLabel(room.cwd) : ""
  if (room.label && room.label !== folder && room.label !== room.id) return room.label
  if (room.name) return room.name
  // 首条消息作标题要过清洗规则（设计 D §2.1：折叠/去控制字符/80 码点截）；清洗后为空顺延下一档
  const first = cleanSessionTitleText(room.firstMessage)
  if (first) return first
  if (room.label) return room.label
  if (room.cwd) return cwdLabel(room.cwd)
  return room.id.slice(0, 8)
}

export function cwdLabel(cwd: string) {
  const parts = cwd.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] || cwd
}

export function roomGroups(rooms: RoomInfo[]) {
  const groups = new Map<string, RoomInfo[]>()
  for (const room of rooms) {
    const key = room.cwd || ""
    const list = groups.get(key) || []
    list.push(room)
    groups.set(key, list)
  }
  return [...groups.entries()]
}

const SWITCH_COMMANDS = new Set(["new_session", "switch_session", "fork", "clone"])

function hasNoticeCode(notice: Notice, code: NoticeCode): boolean {
  return !!notice?.codes?.includes(code)
}

/** 只清带指定稳定类别的提示；新提示都带 codes，unrelated 的错误/结果提示不会被误清 */
function clearNoticeCode(prev: Notice, code: NoticeCode): Notice {
  return hasNoticeCode(prev, code) ? null : prev
}

/** 恢复在线时只清"连接/切换中"类提示：room_list 随任何人订阅都会广播，无差别清空会吞掉错误提示。
 *  只认稳定 code，不再用文案正则猜（错误文本也可能碰巧包含这些词）。 */
function clearConnectivity(prev: Notice): Notice {
  return hasNoticeCode(prev, "connectivity") ? null : prev
}

/** 命令丢失（没等到结果）时给用户的话：有副作用的命令要说清楚"可能已经执行了" */
function lostMessageFor(command: string): string {
  if (command === "regenerate") return "没有收到回应。重新生成可能仍在进行，请看会话再决定是否重试"
  if (command === "compact") return "没有收到回应。压缩可能仍在后台进行，请稍看上下文占用再决定是否重压"
  if (SWITCH_COMMANDS.has(command)) return "没有收到回应。成功与否以会话列表里出现的新会话为准"
  if (command === "navigate_tree") return "没有收到回应。请确认当前分支后再决定是否重跳"
  if (command === "prompt" || command === "steer" || command === "follow_up") return "没有收到回应。消息可能已经送达，请看会话再决定是否重发"
  return COPY.requestTimeout
}

/** 回合结束时最后一条助手消息是否错误：error / errorMessage 任一成立即算错误结束。 */
export function lastAssistantFailed(items: Transcript["items"]): boolean {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.kind !== "assistant") continue
    return item.stopReason === "error" || !!item.errorMessage
  }
  return false
}

/** 快照/终版消息数组版本：快照刚 dispatch、transcript 还没落到 ref 时用它判错误。 */
export function lastAssistantMessageFailed(messages: readonly AgentMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== "assistant") continue
    return message.stopReason === "error" || !!message.errorMessage
  }
  return false
}

/** 扩展回包里的 session 行（改名/冷 fork）→ 前端清单行；字段不合法就丢弃，不让脏数据进列表。 */
function sessionFileRow(value: unknown): SessionEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === "string" ? raw.id.trim() : ""
  const filePath = typeof raw.path === "string" ? raw.path : ""
  if (!id || !filePath) return null
  return {
    id,
    path: filePath,
    name: typeof raw.name === "string" ? raw.name : "",
    firstMessage: typeof raw.firstMessage === "string" ? raw.firstMessage : "",
    cwd: typeof raw.cwd === "string" ? raw.cwd : "",
    messageCount: typeof raw.messageCount === "number" && Number.isFinite(raw.messageCount) ? raw.messageCount : 0,
    sizeBytes: typeof raw.sizeBytes === "number" && Number.isFinite(raw.sizeBytes) ? raw.sizeBytes : 0,
    updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    active: false,
    online: false,
  }
}

export function useRelay() {
  /** 页面是否经 Cloudflare quick tunnel 打开（源 hostname 判定，免服务器模式 §4.3）：页面源在打开时就定了，连接期间不变。 */
  const isViaTunnel = isViaTunnelHostname(location.hostname)
  const [token, setToken] = useState(() => safeStore.get("pi_remote_viewer_token") || "")
  /** 管理命令的独立口令；只存本机浏览器，不进 viewer 握手，也不在界面明文回显。 */
  const [adminToken, setAdminTokenValue] = useState(() => safeStore.get(ADMIN_TOKEN_STORAGE_KEY) || "")
  const setAdminToken = useCallback((next: string) => {
    setAdminTokenValue(next)
    if (next) safeStore.set(ADMIN_TOKEN_STORAGE_KEY, next)
    else safeStore.remove(ADMIN_TOKEN_STORAGE_KEY)
  }, [])
  const [authed, setAuthed] = useState(false)
  const [status, setStatus] = useState("未连接")
  /** 这个 token 连上过：之后断开算"重连"，界面出断线横幅而不是首次连接的加载条 */
  const [everConnected, setEverConnected] = useState(false)
  /** 排定的下一次重连时刻（断线横幅倒计时）；正在连或已连上时为 null */
  const [retryAt, setRetryAt] = useState<number | null>(null)
  /** 连续第几次重连（成功认证归零）：第 1 次只显示「重连中…」，第 2 次起才报次数/倒计时。 */
  const [retryCount, setRetryCount] = useState(0)
  /** 正在拨号或等 auth_result（含手动立即重连）。这期间还没断开，不能按 offline 展示。 */
  const [trying, setTrying] = useState(false)
  const [authError, setAuthError] = useState("")
  /** relay 在 auth_result 里声明的协议版本与能力；界面按能力开关功能（DOC/71 §1） */
  const [server, setServer] = useState<ServerInfo>(V3_SERVER)
  /** P11 prefs-sync（additive）：服务端账号级 mobileNav（null=旧 relay/无记录，保持本地默认 list） */
  const [syncedMobileNav, setSyncedMobileNav] = useState<PiMobileNavMode | null>(null)
  const [rooms, setRooms] = useState<RoomInfo[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null)
  const [deviceMode, setDeviceMode] = useState(false)
  const [sessionsByDevice, setSessionsByDevice] = useState<Record<string, SessionEntry[]>>({})
  /** sessionsByDevice 的 ref 镜像：onmessage 闭包（useCallback([])）里处理 session_removed 时要看最新清单。 */
  const sessionsByDeviceRef = useRef(sessionsByDevice)
  useEffect(() => {
    sessionsByDeviceRef.current = sessionsByDevice
  }, [sessionsByDevice])
  /**
   * B1：已 purge 会话（deviceId → 被 session_removed 点名过的 id）。purge 是永久删除，之后任何在途
   * get_sessions 回包都不能把它写回清单（公网 + archive burst 下回包可能比删除帧晚 ~1s 落地）；
   * loadSessions 的 .then 落地前按它过滤，见 withoutPurgedSessions。
   */
  const purgedSessionsRef = useRef(createPurgedSessionTable())
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [truncatedByDevice, setTruncatedByDevice] = useState<Record<string, boolean>>({})
  /**
   * 长会话历史补拉（R2-5 / P3-7）的入口状态，跟房间走：
   * status: more=可补拉 / loading=在途 / error=失败可重试 / done=无更多；
   * truncated 区分 done 的两种含义（“已到最早” vs “从未截断”）；
   * loads/lastAdded 供 parts 在补拉落地后扩渲染窗并锚定滚动。
   */
  const [history, setHistory] = useState<{ room: string; status: "more" | "loading" | "error" | "done"; error: string; truncated: boolean; loads: number; lastAdded: number }>({
    room: "",
    status: "done",
    error: "",
    truncated: false,
    loads: 0,
    lastAdded: 0,
  })
  const historyRef = useRef(history)
  /** 补拉游标：已并入的最早分支条目（entryId + 扁平下标；下标只增不移）。首个游标靠指纹对齐发现。 */
  const historyCursorRef = useRef<{ entryId: string; index: number } | null>(null)
  /** 补拉在途标记：连点只发一轮（与 status=loading 双保险）。 */
  const historyFlightRef = useRef(false)
  /** 全量快照代次：快照一到，在飞的补拉结果作废（转录已被整段替换）。 */
  const historyGenRef = useRef(0)
  /** 历史补拉的客户端窗口缓存（UI·relay 中-5）：跨页按 entryId/下标复用，换房/全量快照清空。 */
  const historyCacheRef = useRef<HistoryCache | null>(null)
  const applyHistory = (patch: Partial<typeof history>) => {
    const next = { ...historyRef.current, ...patch }
    historyRef.current = next
    setHistory(next)
  }
  const [pendingStarts, setPendingStarts] = useState<Record<string, PendingStart>>({})
  const [commandInFlight, setCommandInFlight] = useState<Record<string, number>>({})
  const [snapshotPending, setSnapshotPending] = useState(false)
  const [roomId, setRoomId] = useState(() => safeStore.session.get("pi_room") || "")
  const [selectionNonce, setSelectionNonce] = useState(0)
  /**
   * P9 B（spec §4.7.1 第 5 条）：正在看的会话被删、同一台设备上没有别的会话可切时的一次性信号。
   * useRelay 不碰界面状态，只把"该进新建会话页"这件事告诉容器层（PiAppBody 的 effect 监听）；
   * { deviceId, id: 被删会话, at } —— at 用于一次性去重，普通"还没选会话"不会误触发。
   */
  const [purgedRoom, setPurgedRoom] = useState<{ deviceId: string; id: string; at: number } | null>(null)
  const [online, setOnline] = useState(false)
  /** 当前会话的本机 pi 确实掉线了（选中时就不在线，或掉线超过防抖窗口）；红条只看它，换会话的过渡期不闪 */
  const [roomDown, setRoomDown] = useState(false)
  const [busy, setBusy] = useState(false)
  /** 本机弹窗等待：start 设置/更新，end、换房、断线立即清空。只提示，不应答。 */
  const [uiPrompt, setUiPrompt] = useState<UiPrompt | null>(null)
  /** 对话框观察（O1）：tap 捕获到的在开弹窗内容卡（多槽，按 dialogId）；只读展示，不应答（应答是 O2）。 */
  const [dialogs, setDialogs] = useState<DialogCard[]>([])
  /** dialogs 的 ref 镜像：dialog_close 到达时要先取到被关的卡片（拼拒绝回执），再走归约摘卡。
   *  归约处（handleEvent 的 dialog 分支）同步推进本 ref（B-8）；下面的 effect 只是其余清理点的兜底同步。 */
  const dialogsRef = useRef<DialogCard[]>([])
  useEffect(() => {
    dialogsRef.current = dialogs
  }, [dialogs])
  /** 对话框应答（O2）：被拒绝 dialog 的回执（理由原文呈现；独立于 dialogs，关一张少一张）。 */
  const [dialogReceipts, setDialogReceipts] = useState<DialogReceipt[]>([])
  /** 扩展 UI 状态最后一份快照（ext_status：statuses/widgets/title/working/tap 健康度）。 */
  const [extStatus, setExtStatus] = useState<ExtStatusSnapshot | null>(null)
  /** 最近一次助手回合结束（busy true→false）：UI 在页面失焦/隐藏时据此加角标。 */
  const [turnEnd, setTurnEnd] = useState<TurnEnd | null>(null)
  /** 别房回合结束记录（B-1）：turnEnd 只由当前房产生，别房的落定靠 RoomTurnTracker
   *  在帧被房间过滤丢弃之前从各房 busy 边沿与别房事件帧记账（见 attention.ts）。 */
  const [roomTurnEnds, setRoomTurnEnds] = useState<TurnEnd[]>([])
  /** 收件箱账本本地副本（设计 D §1）：auth/room_list 快照整替、inbox_update 增量并入；
   *  旧 relay 无此面恒为空数组，attention 归约据「切片在不在」决定别房 waiting 的来源。 */
  const [inbox, setInbox] = useState<InboxEntry[]>([])
  const inboxRef = useRef<InboxEntry[]>([])
  /** 定时排期本地副本（设计 D §3）：按房间分桶——room_list 条目内的 schedules 快照
   *  整替、schedule_update 单房全量替换；旧 relay 无此面恒为空。 */
  const [schedulesByRoom, setSchedulesByRoom] = useState<Record<string, ScheduleEntry[]>>({})
  const schedulesRef = useRef<Record<string, ScheduleEntry[]>>({})
  /** 名册快照并入排期副本：没有任何一房带 schedules 字段（旧 relay）时不动副本。 */
  const applySchedulesSnapshot = (rawRooms: unknown): boolean => {
    const { map, seen } = scheduleMapOfRooms(rawRooms)
    if (!seen) return false
    schedulesRef.current = map
    setSchedulesByRoom(map)
    return true
  }
  const roomTurnTrackerRef = useRef<RoomTurnTracker>(emptyRoomTurnTracker())
  /** 追踪器提交：引用没变（无边沿）就不触发状态更新，流式高频帧下保持安静。 */
  const commitRoomTurnTracker = (next: RoomTurnTracker) => {
    if (next === roomTurnTrackerRef.current) return
    roomTurnTrackerRef.current = next
    setRoomTurnEnds(roomTurnEndsOf(next))
  }
  const [activity, setActivity] = useState("")
  /** 只有 connectivity / progress 系提示还留在这个单槽（连接横幅与状态行）；其余进通知栈。 */
  const [notice, setChannelNotice] = useState<Notice>(null)
  const noticeStack = useNotices()
  const pushNotice = noticeStack.push
  const clearNoticeStack = noticeStack.clear
  /** 兼容 132 个既有 setNotice 调用点：只按稳定 code 分通道，不改文案、不改匹配。 */
  const setNotice = useCallback(
    (next: Notice | ((prev: Notice) => Notice)) => {
      if (typeof next === "function") {
        setChannelNotice(next)
        return
      }
      if (!next) {
        setChannelNotice(null)
        clearNoticeStack()
        return
      }
      if (noticeChannel(next.codes) === "stack") {
        pushNotice({ level: noticeLevelForTone(next.tone), title: next.text })
        return
      }
      setChannelNotice(next)
    },
    [clearNoticeStack, pushNotice],
  )
  const [queue, setQueue] = useState<Queue>({ steering: [], followUp: [] })
  /** 最近一次压缩的量化结果（R3-3 第 2 项 → C-5 口径）：compaction_end 成功帧带 result
   *  时才记。**当前无呈现消费者**——量化呈现一律走 CompactDialog 的命令回包（闭包内
   *  的即时值），此状态只作事件路的前向兼容记录。防冒充纪律：新一轮 compaction_start
   *  到达即清零，事件帧没带新数值时保持 null，绝不留上一轮的值冒充本次结果；
   *  日后接消费者必须先过这条纪律（只读本轮 start 之后写入的值）。 */
  const [lastCompaction, setLastCompaction] = useState<{ tokensBefore?: number; estimatedTokensAfter?: number; at: number } | null>(null)
  /** 扩展自管远程待发：整帧替换；pending 可编辑/取消，injected/failed 只展示。 */
  const [remoteQueue, setRemoteQueueState] = useState<RemoteQueueState>(() => emptyRemoteQueue())
  const remoteQueueRef = useRef<RemoteQueueState>(remoteQueue)
  /** 后端 task_list_state 的最新快照：空数组=清空；只由事件驱动，不在前端合成任务。 */
  const [taskList, setTaskList] = useState<TaskListItem[]>([])
  /** 终端胶囊派生条目：只由 tool_execution_* 事件驱动，按 toolCallId 去重。 */
  const [terminalItems, setTerminalItems] = useState<TerminalItem[]>([])
  /** `tool_end_meta` 到达计数：只用于触发“历史条目重建”effect（transcript 没变时也要跑）。 */
  const [terminalMetaRevision, setTerminalMetaRevision] = useState(0)
  /** agent_state 全量快照（子智能体）；后端可能暂无生产者，没有帧就保持空。 */
  const [agentState, setAgentState] = useState<AgentEntry[]>([])
  const [model, setModel] = useState("")
  /** 模型的完整身份（provider/modelId/name）。输入卡优先显示 modelId，完整值放 tooltip。 */
  const [modelMeta, setModelMeta] = useState<ModelMeta>({})
  /** 只点选、还没载入的会话；公共 roomId 指向它，但 roomRef 仍为空（不订阅不启动）。 */
  const [lazySession, setLazySessionState] = useState<LazySelection | null>(null)
  /** 已经点了发送、正在等本机启动房间的队列（至多一条）。 */
  const [lazySend, setLazySendState] = useState<LazySend | null>(null)
  const [thinkingLevel, setThinkingLevel] = useState("")
  const [usage, setUsage] = useState<UsageState | null>(null)
  const [draft, setDraft] = useState("")
  /** P5.6 离线 outbox：按会话存 localStorage；断线 / 设备离线时发送进这里，恢复后按序回放 */
  const [outboxState, setOutboxState] = useState<OutboxState>(initialOutbox)
  const outboxRef = useRef(outboxState)
  /**
   * 本页乐观气泡的 cid（UI 低危：queue-sync 每帧全表扫一万条转录）。
   * remote_queue_state 只需要更新"本页发出去、还挂着的气泡"；命中集合才进 transcript reducer，
   * 否则跳过（别的端发的消息没有本地 cid，等注入时的 remote 回显，不需要 queue-sync）。
   * 集合按插入顺序封顶，避免长期页面无限增长。
   */
  const localEchoCidsRef = useRef(new Set<string>())
  /** 本标签页的 outbox 回放认领 id：跨标签页时区分"谁认领、谁的结果能改这条" */
  const outboxOwnerRef = useRef(newOutboxOwner())
  const noteLocalEchoCid = useCallback((cid?: string) => {
    if (!cid) return
    localEchoCidsRef.current.delete(cid)
    localEchoCidsRef.current.add(cid)
    capGrowingSet(localEchoCidsRef.current, LOCAL_ECHO_CIDS_MAX)
  }, [])
  /** 已应用过的本页队列条目签名（cid → status|text|error）：同一份状态重复到达时不再进 reducer。 */
  const lastQueueSyncRef = useRef(new Map<string, string>())
  const hasLocalQueueCid = useCallback((items: readonly { cid?: string; status?: string; text?: string; error?: string }[]) => {
    if (!localEchoCidsRef.current.size) return false
    let needed = false
    for (const item of items) {
      if (!item.cid || !localEchoCidsRef.current.has(item.cid)) continue
      const signature = `${item.status ?? ""}|${item.text ?? ""}|${item.error ?? ""}`
      if (lastQueueSyncRef.current.get(item.cid) === signature) continue
      lastQueueSyncRef.current.delete(item.cid)
      lastQueueSyncRef.current.set(item.cid, signature)
      needed = true
    }
    // 签名表按本页 cid 上限封顶，长期页面不随历史队列增长
    while (lastQueueSyncRef.current.size > LOCAL_ECHO_CIDS_MAX) {
      const oldest = lastQueueSyncRef.current.keys().next().value
      if (typeof oldest !== "string") break
      lastQueueSyncRef.current.delete(oldest)
    }
    return needed
  }, [])
  /** 浏览器自己的联网状态（navigator.onLine）：断网时连接可能还没报 onclose，发送也要进 outbox */
  const [browserOnline, setBrowserOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false)
  /** 忙时投递方式：自动 / 插入当前回合 / 排队。默认自动，用户选择存 localStorage。 */
  const [sendMode, setSendModeState] = useState<SendMode>(() => parseSendMode(safeStore.get(SEND_MODE_KEY)))
  /** 输入条上的待发图片（最多 5 张）。发送成功才清掉；失败或没有文字时留着。 */
  const [pendingImages, setPendingImagesState] = useState<SendImage[]>([])
  /** 输入条上的待发文件引用 chip（P3-4）。与图片同口径：发送成功才清，失败留着。 */
  const [pendingFiles, setPendingFilesState] = useState<MentionFile[]>([])
  /** 已发出一帧、正在等 ack（S2）。值来自 createSendLock 的同步状态，不只靠 React 渲染。 */
  const [sendingSend, setSendingSend] = useState(false)
  /** 最近一次发送失败（带不上草稿）：S6 只存在一帧，气泡上的重试不依赖它。 */
  const [lastFailure, setLastFailure] = useState<{ retryable: boolean; text: string; at: number } | null>(null)
  const [failurePulse, setFailurePulse] = useState(false)
  const [transcript, dispatchTranscriptNow] = useReducer(reduceTranscript, undefined, emptyTranscript)

  /*
   * 流式 delta 先攒 50ms 再一次性提交。reducer 每提交一次仍要复制一次 items 数组
   * （React 要求新引用），但复制频率从"每个 token"降到固定 20fps，且数组里都是旧 item
   * 的引用、不复制 item 内容；配合 transcript.ts 的条数/字节上限，长会话的单次成本有上界。
   */
  const pendingDeltasRef = useRef<AssistantEvent[]>([])
  const deltaTimerRef = useRef<number | null>(null)
  const flushPendingDeltas = useCallback(() => {
    if (deltaTimerRef.current !== null) {
      window.clearTimeout(deltaTimerRef.current)
      deltaTimerRef.current = null
    }
    const events = pendingDeltasRef.current
    if (!events.length) return
    pendingDeltasRef.current = []
    dispatchTranscriptNow({ type: "message-update-batch", events })
  }, [dispatchTranscriptNow])
  const dispatch = useCallback(
    (action: TranscriptAction) => {
      if (action.type === "message-update") {
        pendingDeltasRef.current.push(action.event)
        if (pendingDeltasRef.current.length >= TRANSCRIPT_DELTA_MAX_PENDING) {
          flushPendingDeltas()
          return
        }
        if (deltaTimerRef.current === null) {
          deltaTimerRef.current = window.setTimeout(() => {
            deltaTimerRef.current = null
            flushPendingDeltas()
          }, TRANSCRIPT_DELTA_FLUSH_MS)
        }
        return
      }
      if (action.type === "reset" || action.type === "snapshot") {
        // 换房/重置会整段替换正文：旧 live 的残余 delta 直接丢，不必先归约一遍
        if (deltaTimerRef.current !== null) {
          window.clearTimeout(deltaTimerRef.current)
          deltaTimerRef.current = null
        }
        pendingDeltasRef.current = []
      } else {
        // message_end / settle / tool / echo… 必须先应用此前攒下的正文增量，保持事件顺序
        flushPendingDeltas()
      }
      dispatchTranscriptNow(action)
    },
    [flushPendingDeltas, dispatchTranscriptNow],
  )
  useEffect(
    () => () => {
      if (deltaTimerRef.current !== null) window.clearTimeout(deltaTimerRef.current)
      pendingDeltasRef.current = []
    },
    [],
  )

  /*
   * 终端胶囊：start/end/settle 立即归约，保证计数与字形即时正确；update 只缓存
   * partialResult，250ms 合成一帧再提交（累积全量快照，后一帧覆盖前一帧即可）。
   */
  const terminalPendingRef = useRef<TerminalEvent[]>([])
  const terminalTimerRef = useRef<number | null>(null)
  /** 收到过 start 或 bash 类 update 的 toolCallId：让省略 toolName 的 update 也能对上。 */
  const terminalIdsRef = useRef(new Set<string>())
  /** 首帧时钟偏移（本地 - relay）；只校正一次，换房/清房时归零。 */
  const terminalOffsetRef = useRef<number | null>(null)
  /** `tool_end_meta`：先暂存（可能早于 start/end），start/end 后到时再合并。 */
  const terminalEndMetaRef = useRef(new Map<string, ToolEndMeta>())
  /** 已从 transcript 重建过的历史 id：条目滚出后不再因为 effect 重跑而复活。 */
  const terminalHistoryIdsRef = useRef(new Set<string>())
  /** 有新的元数据/全量快照时置位，等 transcript ref 同步后重建一次历史条目。 */
  const terminalHistoryPendingRef = useRef(false)

  const flushTerminalUpdates = useCallback(() => {
    if (terminalTimerRef.current !== null) {
      window.clearTimeout(terminalTimerRef.current)
      terminalTimerRef.current = null
    }
    const pending = terminalPendingRef.current
    if (!pending.length) return
    terminalPendingRef.current = []
    const now = Date.now()
    const offset = terminalOffsetRef.current ?? 0
    const aligned = offset ? pending.map((event) => shiftTerminalEvent(event, offset)) : pending
    setTerminalItems((current) => reduceTerminalEvents(current, aligned, now))
  }, [])
  const applyTerminalEventNow = useCallback(
    (event: TerminalEvent) => {
      flushTerminalUpdates()
      const now = Date.now()
      let offset = terminalOffsetRef.current
      if (offset === null) {
        const next = terminalClockOffset(event, now)
        if (next !== null) {
          offset = next
          terminalOffsetRef.current = next
        }
      }
      const aligned = shiftTerminalEvent(event, offset ?? 0)
      setTerminalItems((current) => {
        let next = reduceTerminalEvent(current, aligned, now)
        const id = typeof event.toolCallId === "string" ? event.toolCallId : ""
        const meta = id ? terminalEndMetaRef.current.get(id) : undefined
        if (meta) next = applyToolEndMeta(next, [meta], now)
        return next
      })
      const id = typeof event.toolCallId === "string" ? event.toolCallId : ""
      if (!id) return
      if (event.type === "tool_execution_end") terminalIdsRef.current.delete(id)
      else if (isTerminalToolName(event.toolName)) terminalIdsRef.current.add(id)
    },
    [flushTerminalUpdates],
  )
  const scheduleTerminalUpdate = useCallback(
    (event: TerminalEvent) => {
      const id = typeof event.toolCallId === "string" ? event.toolCallId : ""
      if (id && isTerminalToolName(event.toolName)) terminalIdsRef.current.add(id)
      terminalPendingRef.current.push(event)
      if (terminalPendingRef.current.length >= 64) {
        flushTerminalUpdates()
        return
      }
      if (terminalTimerRef.current !== null) return
      terminalTimerRef.current = window.setTimeout(() => {
        terminalTimerRef.current = null
        flushTerminalUpdates()
      }, TERMINAL_UPDATE_FLUSH_MS)
    },
    [flushTerminalUpdates],
  )
  /**
   * relay 结束元数据：订阅/补发是全量 entries，live end 后是单条。
   * 先暂存（start/end 还没到也能等），能立刻合入现有条目就合；没有任何
   * 结束证据的条目只保留在 map 里，不伪造成功。到达后触发历史重建。
   */
  const consumeToolEndMeta = useCallback((frame: TerminalEvent) => {
    const parsed = parseToolEndMetaFrame(frame)
    if (!parsed || !parsed.length) return
    const now = Date.now()
    let offset = terminalOffsetRef.current
    if (offset === null) {
      const next = terminalClockOffset(frame, now)
      if (next !== null) {
        offset = next
        terminalOffsetRef.current = next
      }
    }
    const metas = parsed.map((meta) => shiftToolEndMeta(meta, offset ?? 0))
    for (const meta of metas) terminalEndMetaRef.current.set(meta.toolCallId, meta)
    while (terminalEndMetaRef.current.size > TOOL_END_META_MAX) {
      const oldest = terminalEndMetaRef.current.keys().next().value
      if (typeof oldest !== "string") break
      terminalEndMetaRef.current.delete(oldest)
    }
    const applicable = metas.filter((meta) => meta.exitCode !== undefined || meta.termStatus != null || meta.isError !== undefined)
    if (applicable.length) {
      setTerminalItems((current) => applyToolEndMeta(current, applicable, now))
    }
    terminalHistoryPendingRef.current = true
    setTerminalMetaRevision((current) => current + 1)
  }, [])
  const settleTerminalsNow = useCallback(() => {
    flushTerminalUpdates()
    const now = Date.now()
    setTerminalItems((current) => settleTerminalItems(current, now))
  }, [flushTerminalUpdates])
  const resetTerminals = useCallback(() => {
    if (terminalTimerRef.current !== null) {
      window.clearTimeout(terminalTimerRef.current)
      terminalTimerRef.current = null
    }
    terminalPendingRef.current = []
    terminalIdsRef.current.clear()
    terminalOffsetRef.current = null
    terminalEndMetaRef.current.clear()
    terminalHistoryIdsRef.current.clear()
    terminalHistoryPendingRef.current = false
    setTerminalItems([])
  }, [])
  useEffect(
    () => () => {
      if (terminalTimerRef.current !== null) window.clearTimeout(terminalTimerRef.current)
      terminalPendingRef.current = []
    },
    [],
  )

  const wsRef = useRef<WebSocket | null>(null)
  const serverRef = useRef<ServerInfo>(V3_SERVER)
  const tokenRef = useRef(token)
  const roomRef = useRef(roomId)
  /** 最后看过的房间：attach 到期/断线清空当前房间后，设备恢复在线时用它自动重开 */
  const lastRoomRef = useRef("")
  const authedRef = useRef(false)
  const backoffRef = useRef(1000)
  const reconnectRef = useRef<number | null>(null)
  /** 最近一次从 relay 收到任何帧的时刻：验活只看它 */
  const lastRxRef = useRef(0)
  const probeTimerRef = useRef<number | null>(null)
  const stopRef = useRef(false)
  const genRef = useRef(0)
  const [channel] = useState(() => new CommandChannel())
  /** 当前房间镜像的同步位置：重连只要增量、重复帧丢弃、缺口补齐都靠它 */
  const syncRef = useRef<SyncState>(emptySync())
  const resyncAtRef = useRef(0)
  const resyncTimerRef = useRef<number | null>(null)

  /** 已经见过的房间 id（用于在同 cwd 多房间里识别"真正的新房间"） */
  const knownRoomIds = useRef<Set<string>>(new Set())
  const busyRef = useRef(false)
  /** 回合完成信号的本地产出：只有真正发生 busy true→false 才发，abort/断线不算完成。 */
  const turnSeqRef = useRef(0)
  const turnActiveRef = useRef(false)
  const turnEmittedRef = useRef(false)
  const turnErrorRef = useRef(false)
  const transcriptRef = useRef(transcript)
  /**
   * 重复到达的 message_start（旧 socket 晚到 / 重复订阅）按 pi 的 timestamp + model 去重：
   * transcript 的 message-start 是无条件开一条 live 气泡，重复帧会留一条永远不结束的幽灵气泡。
   * 窗口只防"短时间内重复"；窗口外再按最近 50 条已落定消息的 timestamp 兜一次。
   */
  const lastMessageStartsRef = useRef<Array<{ stamp: number; model: string; at: number }>>([])
  const messageStartSeen = useCallback((message: AgentMessage): boolean => {
    const stamp = typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : null
    if (stamp === null) return false
    const model = typeof message.model === "string" ? message.model : ""
    const now = Date.now()
    const recent = lastMessageStartsRef.current
    const duplicate = recent.some((entry) => entry.stamp === stamp && entry.model === model && now - entry.at < MESSAGE_START_DEDUPE_MS)
    // 已经落定的同一条消息（快照之后 relay 又重发起始帧）：也不新开气泡
    if (!duplicate) {
      const items = transcriptRef.current.items
      for (let k = items.length - 1; k >= 0 && k >= items.length - 50; k -= 1) {
        const item = items[k]
        if (item.kind === "assistant" && item.timestamp === stamp) return true
      }
      recent.push({ stamp, model, at: now })
      if (recent.length > 50) recent.splice(0, recent.length - 50)
    }
    return duplicate
  }, [])
  /** 新回合开始：允许下一次完成信号，错误标记归零。 */
  const startTurn = useCallback(() => {
    turnActiveRef.current = true
    turnEmittedRef.current = false
    turnErrorRef.current = false
  }, [])
  /** 中断/换房/断线：当前回合不算完成，也不允许后续 settle 补发信号（新回合由 startTurn 解锁）。 */
  const resetTurn = useCallback(() => {
    turnActiveRef.current = false
    turnEmittedRef.current = true
    turnErrorRef.current = false
  }, [])
  /** busy true→false 的唯一出口：每个回合只发一次，短时间内的重复帧被 turnEmitted 挡住。 */
  const finishTurn = useCallback((failed = false) => {
    if (turnEmittedRef.current || !roomRef.current) return
    if (!turnActiveRef.current && !busyRef.current) return
    turnActiveRef.current = false
    turnEmittedRef.current = true
    const error = failed || turnErrorRef.current || lastAssistantFailed(transcriptRef.current.items)
    turnSeqRef.current += 1
    setTurnEnd({ seq: turnSeqRef.current, at: Date.now(), roomId: roomRef.current, error })
  }, [])
  /** 离线状态的防抖定时器：会话换代时旧房间必然先 offline、新房随后才上线，
   *  立即出红条会闪一下。等 2.5s，期间恢复在线就取消；输入条照样立即禁用（消息本来就送不出去）。 */
  const offlineTimer = useRef<number | null>(null)
  const scheduleOffline = useCallback((roomId: string) => {
    if (offlineTimer.current) window.clearTimeout(offlineTimer.current)
    offlineTimer.current = window.setTimeout(() => {
      offlineTimer.current = null
      if (roomRef.current !== roomId) return
      if (roomsRef.current.find((room) => room.id === roomId)?.online) return
      // 换会话会先让旧房间离线，新房间随后才注册。这期间不判离线。
      if (expectedSessionFile.current || pendingSwitchRef.current) {
        setNotice({ text: "正在切换会话…", tone: "warn", codes: ["connectivity", "progress"] })
        return
      }
      setOnline(false)
      setBusy(false)
      setActivity("")
      setRoomDown(true)
      // 设备确认离线：弹窗不可能还在等；完成信号也不再属于可交互会话
      setUiPrompt(null)
      setDialogs([])
      setExtStatus(null)
      resetTurn()
      setTurnEnd(null)
    }, 2500)
  }, [resetTurn])
  const cancelOffline = useCallback(() => {
    if (offlineTimer.current) {
      window.clearTimeout(offlineTimer.current)
      offlineTimer.current = null
    }
  }, [])

  /** in-flight 会话操作的预期目标会话文件，用于换绑后校验 */
  const expectedSessionFile = useRef<string | null>(null)
  /** new / switch / fork / clone 已经发出，正在等新房间出现 */
  const pendingSwitchRef = useRef(false)
  const switchTicketRef = useRef(0)
  /** fork 回填：命令回包可能早于或晚于新房订阅。晚到时先挂起，等 subscribe 清完草稿再补上。 */
  const pendingBackfillRef = useRef<{ text: string; notice: string } | null>(null)
  // draft/online 的 ref 镜像：sendText 依赖改成 [] 后引用才稳定，
  // memo(TranscriptItem) 的 onRetry 才不会每次按键都失效（整条会话重渲）
  const draftRef = useRef("")
  /** 草稿落盘（P3-3）：内存草稿当前归属的房间键。切房点（subscribe / 点选未载入会话 /
   *  clearRoom）同步维护，落盘与恢复都以它为准，不靠 roomId 状态的事后推断。 */
  const draftOwnerRef = useRef(safeStore.session.get("pi_room") || "")
  /** 内存草稿是否已与归属房间"对过账"（恢复过或用户敲过）。未对账的空草稿不许落盘：
   *  刷新刚加载时 owner 只是 session 里的猜测值，拿它删落盘条目会把上次的草稿误删。 */
  const draftHydratedRef = useRef(false)
  /** 最近一次与 localStorage 对齐的草稿值（跨标签页同步基线）：用于区分"本页有未落盘编辑"
   *  与"只是本地缓存旧值"，避免陈旧标签页把另一页刚改好的草稿冲回旧版本。 */
  const draftBaseRef = useRef("")
  /** draftBaseRef 当前归属的房间键：归属切换后（订阅/点选未载入/清房）重新对账。 */
  const draftBaseOwnerRef = useRef("")
  /** 与内存草稿同步存进归属房间的落盘槽（空白 = 删条目）。切房/清房前调用，防抖窗口不丢尾巴。
   *  current === base 时不再写：另一标签页刚更新过的草稿不会被本页的旧值覆盖。 */
  const persistDraftNow = () => {
    const key = draftOwnerRef.current
    if (!key || !draftHydratedRef.current) return
    const text = draftRef.current
    if (!shouldPersistDraft(text, draftBaseRef.current)) return
    saveRoomDraft(key, text.trim() ? text : "")
    draftBaseRef.current = text
  }
  /** 对外暴露的 setDraft：任何经组件写进输入框的内容都算"已对账"，可落盘。 */
  const setDraftTracked = useCallback((value: string) => {
    draftHydratedRef.current = true
    setDraft(value)
  }, [])
  const pendingImagesRef = useRef<SendImage[]>([])
  /** sendText 是 [] 依赖：投递方式必须走 ref，才能读到用户刚切的最新值。 */
  const sendModeRef = useRef<SendMode>(sendMode)
  /** 选图/移除/发送成功都会加一：发送中的新选择不会被旧请求清掉。 */
  const imageTicket = useRef(0)
  const commitPendingImages = useCallback((next: SendImage[]) => {
    const list = next.slice(0, MAX_PENDING_IMAGES)
    imageTicket.current += 1
    pendingImagesRef.current = list
    setPendingImagesState(list)
  }, [])
  /** 追加图片；返回真正接收的张数。槽位/合计超限时由调用方负责提示。 */
  const addPendingImages = useCallback(
    (incoming: SendImage[]) => {
      if (!incoming.length) return 0
      const current = pendingImagesRef.current
      const room = Math.max(0, MAX_PENDING_IMAGES - current.length)
      let total = imageCharsTotal(current)
      const accepted: SendImage[] = []
      for (const image of incoming) {
        if (accepted.length >= room) break
        if (!image.data || image.data.length > SEND_IMAGE_MAX_CHARS) continue
        if (total + image.data.length > SEND_IMAGE_TOTAL_MAX_CHARS) break
        accepted.push(image)
        total += image.data.length
      }
      if (accepted.length) commitPendingImages([...current, ...accepted])
      return accepted.length
    },
    [commitPendingImages],
  )
  /** 按对象引用或下标移除一张，避免压缩批次晚到时按错下标删掉新图。 */
  const removePendingImage = useCallback(
    (target: SendImage | number) => {
      const current = pendingImagesRef.current
      const index = typeof target === "number" ? target : current.indexOf(target)
      if (index < 0 || index >= current.length) return
      commitPendingImages(current.filter((_, itemIndex) => itemIndex !== index))
    },
    [commitPendingImages],
  )
  const clearPendingImages = useCallback(() => {
    if (!pendingImagesRef.current.length) return
    commitPendingImages([])
  }, [commitPendingImages])
  /** 发送期间用户又加了图：只摘掉这次真正发出去的，新加的那批留在输入条。 */
  const dropSentPendingImages = useCallback(
    (sent: readonly SendImage[]) => {
      if (!sent.length) return
      const current = pendingImagesRef.current
      const next = current.filter((image) => !sent.includes(image))
      if (next.length !== current.length) commitPendingImages(next)
    },
    [commitPendingImages],
  )
  const pendingFilesRef = useRef<MentionFile[]>([])
  /** 选 chip/移除/发送成功都会加一：发送中的新选择不会被旧请求清掉（与图片同一口径）。 */
  const filesTicket = useRef(0)
  const commitPendingFiles = useCallback((next: MentionFile[]) => {
    const list = next.slice(0, MAX_PENDING_FILES)
    filesTicket.current += 1
    pendingFilesRef.current = list
    setPendingFilesState(list)
  }, [])
  /** 追加引用 chip（按 path 去重）；返回真正接收的条数。 */
  const addPendingFiles = useCallback(
    (incoming: MentionFile[]) => {
      if (!incoming.length) return 0
      const current = pendingFilesRef.current
      const fresh = incoming.filter((file) => file.path && !current.some((item) => item.path === file.path))
      const accepted = fresh.slice(0, Math.max(0, MAX_PENDING_FILES - current.length))
      if (accepted.length) commitPendingFiles([...current, ...accepted])
      return accepted.length
    },
    [commitPendingFiles],
  )
  /** 按对象或 path 移除一个引用 chip。 */
  const removePendingFile = useCallback(
    (target: MentionFile | string) => {
      const path = typeof target === "string" ? target : target.path
      const current = pendingFilesRef.current
      if (!current.some((file) => file.path === path)) return
      commitPendingFiles(current.filter((file) => file.path !== path))
    },
    [commitPendingFiles],
  )
  const clearPendingFiles = useCallback(() => {
    if (!pendingFilesRef.current.length) return
    commitPendingFiles([])
  }, [commitPendingFiles])
  /** 发送期间用户又加了 chip：只摘掉这次真正发出去的，新加的那批留在输入条。 */
  const dropSentPendingFiles = useCallback(
    (sent: readonly MentionFile[]) => {
      if (!sent.length) return
      const sentPaths = new Set(sent.map((file) => file.path))
      const current = pendingFilesRef.current
      const next = current.filter((file) => !sentPaths.has(file.path))
      if (next.length !== current.length) commitPendingFiles(next)
    },
    [commitPendingFiles],
  )
  const setSendMode = useCallback((mode: SendMode) => {
    const next = parseSendMode(mode)
    sendModeRef.current = next
    setSendModeState(next)
    safeStore.set(SEND_MODE_KEY, next)
  }, [])
  const onlineRef = useRef(false)
  const commandSendRef = useRef<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => {
    throw new Error("还没连上")
  })
  /** 同步 in-flight 锁：同一个 tick 的第二次 Enter 在 setState 之前就会被拒绝。 */
  const sendLock = useRef(createSendLock())
  const sendAckTimer = useRef<number | null>(null)
  const clearSendAckTimer = useCallback(() => {
    if (sendAckTimer.current !== null) {
      window.clearTimeout(sendAckTimer.current)
      sendAckTimer.current = null
    }
  }, [])
  /** 换房/换设备/退出时把发送态整体归零；晚到的 ack 因 token 不匹配不会碰新状态。 */
  const resetSendState = useCallback(() => {
    clearSendAckTimer()
    sendLock.current.reset()
    setSendingSend(false)
    setLastFailure(null)
    setFailurePulse(false)
  }, [clearSendAckTimer])
  useEffect(() => () => clearSendAckTimer(), [clearSendAckTimer])
  // S6 只存在一帧：下一帧立即回落到当前输入对应的稳定态（失败正文留在气泡）。
  useEffect(() => {
    if (!failurePulse) return
    const frame = window.requestAnimationFrame(() => setFailurePulse(false))
    return () => window.cancelAnimationFrame(frame)
  }, [failurePulse])

  /** 换绑后校验实际会话文件；不一致就明确告知，不假装成功 */
  const checkSwitchedRoom = useCallback(
    async (roomId: string, sessionFile: string) => {
      try {
        const state = (await channel.command(roomId, "get_state", {}, "校验超时")) as { sessionFile?: string } | null
        const actual = state && state.sessionFile ? String(state.sessionFile).replace(/\\/g, "/") : ""
        expectedSessionFile.current = null
        // Windows 盘符大小写可能不同（pi 给 D:\Users\...，列表里是 d:\users\...）：不计大小写
        if (actual && !sameSessionPath(actual, sessionFile)) {
          setNotice({ text: "切换后的会话与预期不一致，请从左侧列表确认要看哪个。", tone: "warn" })
        }
      } catch {
        expectedSessionFile.current = null
      }
    },
    [channel],
  )
  const roomsRef = useRef<RoomInfo[]>([])
  const devicesRef = useRef<Device[]>([])
  /** 会话路径比较：只有 Windows 盘符路径不计大小写（避免把同一路径判成"切换后与预期不一致"）；POSIX 路径区分大小写 */
  function sameSessionPath(a: string, b: string): boolean {
    const x = String(a || "").replace(/\\/g, "/");
    const y = String(b || "").replace(/\\/g, "/");
    if (!x || !y) return false;
    const windows = /^[A-Za-z]:\//.test(x) && /^[A-Za-z]:\//.test(y);
    return windows ? x.toLowerCase() === y.toLowerCase() : x === y;
  }
  const selectedDeviceRef = useRef<string | null>(null)
  /** 本机读到的会话正文，键是 deviceId + 会话 id。只在这次页面连接里保留。 */
  const archivesRef = useRef(new Map<string, ArchiveSession>())
  const [archiveTick, setArchiveTick] = useState(0)
  const deviceModeRef = useRef(false)
  const legacyRef = useRef(false)
  const pendingWatchRef = useRef<Record<string, PendingStart & { seen: Set<string> }>>({})
  const armingRef = useRef<Record<string, PendingStart & { seen: Set<string> }>>({})
  const resolvedArmingAt = useRef(new Set<number>())
  /** 断线期间发现的序号缺口：等 socket 恢复后补一次订阅 */
  const pendingResyncRef = useRef<{ since: boolean; room: string } | null>(null)
  /** 当前这条 socket 上真正发过 subscribe 的房间。relay 的订阅跟着 socket 走：重连后要重新订阅，
   *  重连那一刻房间还没上线（relay 刚重启、设备晚于页面重连）时 auth_result 里接不上，等 room_list 里它上线再补 */
  const socketRoomRef = useRef<string | null>(null)
  /** get_state 拉取节流：每次 subscribed/resync 都拉会把命令通道塞满 */
  const lastStatePullRef = useRef<{ room: string; at: number }>({ room: "", at: 0 })
  const loadSessionsRef = useRef<(deviceId: string) => void>(() => {})
  /** 重连后补拉会话索引的节流：同一台设备 10s 内只拉一次 */
  const lastSessionsAtRef = useRef(0)
  const clearPendingRef = useRef<(deviceId: string) => void>(() => {})
  const lazySessionRef = useRef<LazySelection | null>(null)
  const lazySendRef = useRef<LazySend | null>(null)
  const lazyTokenSeq = useRef(0)
  /** beginHarness 已经受理的那次启动；取消/失败时只清自己这次，别误伤别的设备命令 */
  const lazyAcceptedRef = useRef(0)
  /** 同一次发送只允许 flush 一次（room_list/subscribed/snapshot 会重复通知） */
  const lazySubmitRef = useRef(0)
  const lazySendTimerRef = useRef<number | null>(null)
  const lazyReadyTimerRef = useRef<number | null>(null)
  /** 用户切走时，旧会话可能还是被本机启动了：等它上线也绝不自动打开。键：deviceId:sessionId */
  const suppressStartedRoomsRef = useRef(new Set<string>())
  /** 会话清单补拉的延迟定时器（删除/改名后 800ms 补一轮）：卸载时要能全部清掉 */
  const sessionRefreshTimersRef = useRef<Set<number>>(new Set())
  /** 记一个"启动已被用户放弃"的键；只增表按插入顺序封顶（绝大多数键会在房间上线时被消费掉）。 */
  const suppressStartedRoom = useCallback((key: string) => {
    suppressStartedRoomsRef.current.delete(key)
    suppressStartedRoomsRef.current.add(key)
    capGrowingSet(suppressStartedRoomsRef.current, SUPPRESSED_STARTED_ROOMS_MAX)
  }, [])
  const failLazySendRef = useRef<(error: string, restore?: boolean) => void>(() => {})
  const cancelLazySendRef = useRef<(restore?: boolean) => void>(() => {})
  const queueLazySendRef = useRef<(selection: LazySelection, text: string) => void>(() => {})
  const lazyRoomReadyRef = useRef<(roomId: string, deviceId: string) => void>(() => {})
  const openLazyRoomRef = useRef<(roomId: string) => boolean>(() => false)
  const sessionTickets = useRef(createDeviceRequestTickets())
  /** get_sessions 在飞计数：sessionsLoading 是全局单值，只有全部落地才收起 */
  const sessionsInFlight = useRef(0)
  const querySeq = useRef(0)
  const queriesRef = useRef(new Map<string, { resolve: (msg: Record<string, unknown>) => void; reject: (error: Error) => void; timer: number }>())
  // ref 同步放进 effect：渲染期写 ref 在 React 并发渲染下是不纯的
  useEffect(() => {
    tokenRef.current = token
    // 未载入选择只是 UI 哨兵：内部 roomRef 必须保持空，否则会被当成真实房间去订阅/发命令
    roomRef.current = lazySessionRef.current ? "" : roomId
    roomsRef.current = rooms
    devicesRef.current = devices
    selectedDeviceRef.current = selectedDeviceId
    deviceModeRef.current = deviceMode
    busyRef.current = busy
    draftRef.current = draft
    onlineRef.current = online
    transcriptRef.current = transcript
  }, [token, roomId, rooms, devices, selectedDeviceId, deviceMode, busy, draft, online, lazySession, transcript])

  /**
   * outbox 的唯一写口：先读存储再改再写（同一浏览器的别的标签页可能刚认领 / 取消过），
   * 读改写在同一同步段里完成，两个标签页不会认领同一条。
   * 入队存不进去（配额满 / 存储不可用）返回 null，调用方把消息留在输入框；其余动作存不进去也照样改内存。
   */
  const commitOutbox = useCallback((action: OutboxAction): OutboxState | null => {
    const storage = outboxStorage()
    const base = storage ? loadOutbox(storage) : outboxRef.current
    const next = outboxReducer(base, action)
    // 动作没生效（对不上条目等）：不写存储、不触发重渲染（在线发送的重试路径因此零开销）
    if (next === base) return base
    if (!saveOutbox(storage, next) && action.type === "enqueue") return null
    outboxRef.current = next
    setOutboxState(next)
    return next
  }, [])
  useEffect(() => {
    // 别的标签页改了 outbox / drafts：跟着刷新（计数、排队面板、同房草稿）
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === OUTBOX_STORAGE_KEY) {
        const next = loadOutbox(outboxStorage())
        outboxRef.current = next
        setOutboxState(next)
      }
      if (event.key === null || event.key === DRAFTS_STORAGE_KEY) {
        const key = draftOwnerRef.current
        if (!key || !draftHydratedRef.current) return
        const remote = roomDraftFromRaw(event.newValue, key)
        const merged = reconcileRemoteDraft(draftRef.current, draftBaseRef.current, remote)
        draftBaseRef.current = merged.base
        if (merged.adopt) setDraft(merged.draft)
      }
    }
    const up = () => setBrowserOnline(true)
    const down = () => setBrowserOnline(false)
    window.addEventListener("storage", onStorage)
    window.addEventListener("online", up)
    window.addEventListener("offline", down)
    return () => {
      window.removeEventListener("storage", onStorage)
      window.removeEventListener("online", up)
      window.removeEventListener("offline", down)
    }
  }, [])
  /** 转录里某条气泡的 cid（重试 / 取消时对上 outbox 条目） */
  const bubbleCid = useCallback((key: string): string => {
    const item = transcriptRef.current.items.find((entry) => entry.key === key)
    return item && item.kind === "user" && item.cid ? item.cid : ""
  }, [])
  /** 摘掉某个 cid 的失败气泡（outbox 条目被取消 / 换新 cid 重试后，旧气泡不再有意义） */
  const dropFailedBubble = useCallback((cid: string) => {
    const item = transcriptRef.current.items.find((entry) => entry.kind === "user" && entry.cid === cid)
    if (item && item.kind === "user" && item.failed) dispatch({ type: "drop", key: item.key })
  }, [dispatch])
  /** 现在发不出去：没连上 / 房间不在线 / 浏览器断网 / 选中的设备离线。此时发送进 outbox */
  const sendOffline = useCallback((): boolean => {
    if (!authedRef.current || !onlineRef.current) return true
    if (typeof navigator !== "undefined" && navigator.onLine === false) return true
    if (rosterActive({ deviceMode: deviceModeRef.current, devices: devicesRef.current, rooms: roomsRef.current })) {
      const device = devicesRef.current.find((item) => item.id === selectedDeviceRef.current)
      if (!device?.online) return true
    }
    return false
  }, [])

  /**
   * 补拉账接缝（B-6）：后续动作的 trim 若从头部吃掉了已补拉的页（转录账本 trimmed 增长），
   * 补拉游标已经越过被吃段、指着转录里不存在的位置——作废游标并把入口拨回 more：
   * 下次点击从当前头部重新指纹对齐，被吃段正贴着当前头部、会被优先补回来，不留静默空洞。
   * 在飞补拉靠代次作废（其切片基于旧头部，落地会拼错位）。
   */
  const historyTrimmedSeenRef = useRef(0)
  useEffect(() => {
    const trimmed = backfillInfoOf(transcript).trimmed
    if (trimmed === historyTrimmedSeenRef.current) return
    historyTrimmedSeenRef.current = trimmed
    if (!historyCursorRef.current) return
    historyCursorRef.current = null
    historyGenRef.current += 1
    if (historyRef.current.room) applyHistory({ status: "more", error: "" })
  }, [transcript])

  // 草稿落盘基线（跨标签页同步）：归属房间一切换，base 对齐到该房当前落盘值。
  // 用户输入/回填文本与 base 不同 → 视为本页未落盘编辑；相同 → 只是恢复，不重复写。
  useEffect(() => {
    const owner = draftOwnerRef.current
    if (owner === draftBaseOwnerRef.current) return
    draftBaseOwnerRef.current = owner
    draftBaseRef.current = owner ? readRoomDraft(owner) : ""
  }, [draft, roomId, selectionNonce])

  // 草稿落盘（P3-3）：输入停 300ms 存一次；draft 被清空（发送成功/切房已另存）时
  // 同一路径删掉落盘条目。归属键读 draftOwnerRef——切房点已同步维护，不受 roomId 渲染时序影响。
  // draft === base 时不写：另一标签页刚更新过的草稿不会被本页的旧值覆盖。
  useEffect(() => {
    if (!draftHydratedRef.current) return
    const key = draftOwnerRef.current
    if (!key) return
    if (!shouldPersistDraft(draft, draftBaseRef.current)) return
    const timer = window.setTimeout(() => {
      saveRoomDraft(key, draft.trim() ? draft : "")
      draftBaseRef.current = draft
    }, 300)
    return () => window.clearTimeout(timer)
  }, [draft])

  // 关页/刷新/标签被杀前冲刷防抖窗口内的最后一口草稿。
  useEffect(() => {
    const flush = () => persistDraftNow()
    window.addEventListener("beforeunload", flush)
    return () => window.removeEventListener("beforeunload", flush)
  }, [])

  /**
   * 历史重建：transcript 快照先到、元数据后到（或反过来）都不丢。
   * 只有拿到 `tool_end_meta` 才生成历史终端条目；帧未到前不伪造状态。
   * 本 effect 必须排在 transcriptRef 同步之后；pending 标记保证只重建一次/批，
   * 条目滚出后不会因为重渲染复活。
   */
  useEffect(() => {
    if (!terminalHistoryPendingRef.current) return
    terminalHistoryPendingRef.current = false
    if (!terminalEndMetaRef.current.size) return
    const now = Date.now()
    const history = terminalHistoryItems(transcriptRef.current.items, terminalEndMetaRef.current, now)
    const fresh = history.filter((item) => !terminalHistoryIdsRef.current.has(item.id))
    if (!fresh.length) return
    for (const item of fresh) terminalHistoryIdsRef.current.add(item.id)
    // 只增集合封顶（UI 低危：缓慢泄漏）。上限与 terminalEndMetaRef 同额：被 TTL / FIFO 丢掉的
    // 元数据不会再产出历史条目，所以丢最旧的 id 不会让旧条目复活。
    capGrowingSet(terminalHistoryIdsRef.current, TERMINAL_HISTORY_IDS_MAX)
    setTerminalItems((current) => mergeTerminalHistoryItems(current, fresh, now))
  }, [transcript, terminalMetaRevision])

  const setLazySelection = useCallback((selection: LazySelection | null) => {
    lazySessionRef.current = selection
    setLazySessionState(selection)
  }, [])
  const setLazySend = useCallback((send: LazySend | null) => {
    lazySendRef.current = send
    setLazySendState(send)
  }, [])
  const clearLazyTimers = useCallback(() => {
    if (lazySendTimerRef.current) {
      window.clearTimeout(lazySendTimerRef.current)
      lazySendTimerRef.current = null
    }
    if (lazyReadyTimerRef.current) {
      window.clearTimeout(lazyReadyTimerRef.current)
      lazyReadyTimerRef.current = null
    }
  }, [])

  const rememberModel = useCallback((message?: AgentMessage) => {
    if (!message) return
    if (typeof message.model === "string" && message.model) setModel(message.model)
    const meta = modelMetaFrom(message)
    if (meta) setModelMeta((prev) => mergeModelMeta(prev, meta))
  }, [])

  const handleEvent = useCallback(
    (event: { type?: string; [key: string]: unknown }) => {
      switch (event.type) {
        case "message_start": {
          const started = (event.message || {}) as AgentMessage
          // 只有 assistant 的 message_start 会开 live 气泡（transcript 对非 assistant 直接忽略）；
          // 去重也只针对它，避免拿 user/custom 帧的 timestamp 误挡同一毫秒的助手起始帧。
          if (started.role === "assistant" && messageStartSeen(started)) break
          dispatch({ type: "message-start", message: started })
          rememberModel(started)
          if (started.role === "assistant") {
            // agent_start 通常会先到；这里兜住只收到 message_start 的旧路径
            if (!turnActiveRef.current) startTurn()
            setBusy(true)
          }
          break
        }
        case "message_update": {
          const assistantMessageEvent = (event.assistantMessageEvent || {}) as AssistantEvent
          dispatch({ type: "message-update", event: assistantMessageEvent })
          if (assistantMessageEvent.type === "thinking_start" || assistantMessageEvent.type === "thinking_delta") setActivity("正在思考")
          if (assistantMessageEvent.type === "thinking_end") setActivity("正在输出")
          if (assistantMessageEvent.type === "error") {
            turnErrorRef.current = true
            setNotice({ text: assistantMessageEvent.error || assistantMessageEvent.reason || "模型流出错", tone: "bad" })
          }
          break
        }
        case "message_end": {
          const ended = (event.message || {}) as AgentMessage
          dispatch({ type: "message-end", message: ended })
          rememberModel(ended)
          const terminal = ended.role === "assistant" && !!ended.stopReason && ended.stopReason !== "toolUse" && ended.stopReason !== "pending" && ended.stopReason !== "deferred"
          if (terminal) {
            if (ended.stopReason === "aborted") {
              // 用户主动中断不算“完成”，不发完成角标，也不让随后 agent_settled 补发
              turnActiveRef.current = false
              turnEmittedRef.current = true
              turnErrorRef.current = false
            } else {
              finishTurn(ended.stopReason === "error" || !!ended.errorMessage)
            }
            setBusy(false)
            setActivity("")
          }
          break
        }
        case "tool_execution_start":
          applyTerminalEventNow(event as TerminalEvent)
          dispatch({
            type: "tool",
            id: String(event.toolCallId || ""),
            patch: { name: String(event.toolName || "tool"), input: isRecord(event.args) ? event.args : undefined, state: "input-streaming" },
          })
          break
        case "tool_execution_update": {
          const terminalId = typeof event.toolCallId === "string" ? event.toolCallId : ""
          if (isTerminalToolName(event.toolName) || (terminalId && terminalIdsRef.current.has(terminalId))) {
            scheduleTerminalUpdate(event as TerminalEvent)
          }
          dispatch({
            type: "tool",
            id: terminalId,
            patch: { name: String(event.toolName || ""), outputText: resultText(event.partialResult) },
          })
          break
        }
        case "tool_execution_end":
          applyTerminalEventNow(event as TerminalEvent)
          dispatch({
            type: "tool",
            id: String(event.toolCallId || ""),
            patch: {
              name: String(event.toolName || ""),
              outputText: resultText(event.result),
              state: event.isError ? "output-error" : "output-available",
              images: imagesOf(isRecord(event.result) ? event.result.content : undefined),
              errorText: event.isError ? resultText(event.result) : undefined,
            },
          })
          break
        case "agent_start":
        case "turn_start":
          // Working 完成态到下一回合开始为止；仍有未结束子智能体时跨回合保留。
          if (event.type === "agent_start") {
            setAgentState((current) => (current.some(agentIsActive) ? current : []))
          }
          startTurn()
          setBusy(true)
          setActivity((prev) => prev || "正在输出")
          break
        case "agent_end":
          if (event.willRetry) {
            setBusy(true)
            setActivity("准备重试")
          }
          break
        case "agent_settled":
          finishTurn()
          setBusy(false)
          setActivity("")
          // 只清带 progress 的过场提示；错误提示和切换结果提示要留给用户看
          setNotice((prev) => (hasNoticeCode(prev, "progress") ? null : prev))
          dispatch({ type: "settle" })
          // 回合 settled 仍 running 的终端：兜底推定结束（已取消），迟到 end 会覆盖。
          settleTerminalsNow()
          break
        case "remote_message":
          dispatch({ type: "remote", text: String(event.text || ""), cid: isCid(event.cid) ? event.cid : undefined })
          break
        case "remote_message_delivered":
          if (isCid(event.cid)) dispatch({ type: "delivered", cid: event.cid })
          break
        case "remote_message_failed":
          dispatch({ type: "remote-failed", text: String(event.text || ""), error: String(event.error || "发送失败"), cid: isCid(event.cid) ? event.cid : undefined })
          setNotice({ text: String(event.error || "远程消息没有送进会话"), tone: "bad" })
          break
        case "queue_update":
          setQueue({
            steering: Array.isArray(event.steering) ? (event.steering as AgentMessage[]) : [],
            followUp: Array.isArray(event.followUp) ? (event.followUp as AgentMessage[]) : [],
          })
          break
        case "remote_queue_state": {
          // 整帧替换：坏帧保留上一份；items: [] 是合法的“没有待发/已清空”。
          const next = parseRemoteQueueState(event)
          if (next) {
            // 别的端取消/会话切换导致 pending 消失：把本端还没注入的乐观气泡一并撤掉。
            const nextIds = new Set(next.items.map((item) => item.id))
            for (const old of remoteQueueRef.current.items) {
              if (old.status === "pending" && old.cid && !nextIds.has(old.id)) dispatch({ type: "queue-drop", cid: old.cid })
            }
            remoteQueueRef.current = next
            setRemoteQueueState(next)
            // 只有命中本页乐观气泡的 cid 才需要进 reducer（见 localEchoCidsRef 注释）
            if (hasLocalQueueCid(next.items)) dispatch({ type: "queue-sync", items: next.items })
          }
          break
        }
        case "task_list_state":
          // 只认契约里的 tasks 数组；非法帧保留上一帧，空数组才是清空。
          setTaskList((current) => taskListAfterEvent(current, event))
          break
        case "agent_state":
          // 与 task_list_state 同构：整帧替换，坏帧保留上一帧，空数组清空。
          setAgentState((current) => agentStateAfterEvent(current, event))
          break
        case "auto_retry_start":
          // 新的重试尝试：上一轮的错误先不算数，最终仍以终版消息/agent_settled 为准
          startTurn()
          setBusy(true)
          setActivity(`${Math.max(1, Math.round(Number(event.delayMs || 0) / 1000))}s 后重试（${event.attempt}/${event.maxAttempts}）`)
          // 带具体错误信息时不标 progress：那是要留给用户看的错误，不能被 settle 当过场提示清掉
          setNotice(
            event.errorMessage
              ? { text: String(event.errorMessage), tone: "warn" }
              : { text: "正在重试", tone: "warn", codes: ["progress"] },
          )
          break
        case "auto_retry_end":
          if (!event.success) turnErrorRef.current = true
          setNotice({ text: event.success ? "重试已成功" : String(event.finalError || "重试失败"), tone: event.success ? "warn" : "bad" })
          setActivity("正在输出")
          break
        case "summarization_retry_scheduled":
          setNotice({
            text: `摘要将在 ${Math.max(1, Math.round(Number(event.delayMs || 0) / 1000))}s 后重试`,
            tone: "warn",
            codes: ["summarization"],
          })
          break
        case "summarization_retry_attempt_start":
          setNotice({ text: "正在重试摘要", tone: "warn", codes: ["progress", "summarization"] })
          break
        case "summarization_retry_finished":
          // 只清自己这轮摘要提示，别把期间到达的其他错误/结果提示一起吞掉
          setNotice((prev) => clearNoticeCode(prev, "summarization"))
          break
        case "compaction_start":
          setActivity("正在压缩上下文")
          setNotice({ text: "正在压缩上下文", tone: "warn", codes: ["progress", "compaction"] })
          // C-5：新一轮压缩开始即作废上一轮的事件路量化记录，防日后消费者拿旧值冒充本次。
          setLastCompaction(null)
          break
        case "compaction_end":
          if (event.aborted) setNotice({ text: "上下文压缩已中止", tone: "warn" })
          else if (event.errorMessage) setNotice({ text: String(event.errorMessage), tone: "bad" })
          else {
            setNotice((prev) => clearNoticeCode(prev, "compaction"))
            // 量化保留（R3-3 第 2 项）：事件 result 里的实值才记；没有就保持 null
            //（start 已清零），不拿上一轮的值冒充本次（C-5）。
            const numbers = compactionNumbersOf(event)
            if (numbers) setLastCompaction({ ...numbers, at: Date.now() })
          }
          setActivity((prev) => (prev === "正在压缩上下文" ? "" : prev))
          break
        case "session_info_changed":
          setRooms((list) => list.map((room) => (room.id === roomRef.current ? { ...room, label: (event.name as string) || null } : room)))
          break
        case "thinking_level_select":
        case "thinking_level_changed":
          setThinkingLevel(String(event.level || ""))
          break
        case "model_select": {
          // pi 唯一没有 wire 事件的模型状态变化（v2.8 补的钩子转发）：终端里切模型即时生效
          const m = event.model as { name?: string; modelId?: string; id?: string } | undefined
          if (m) setModel(m.name || m.modelId || m.id || "")
          const meta = modelMetaFrom(m)
          if (meta) setModelMeta((prev) => mergeModelMeta(prev, meta))
          break
        }
        case "session_tree":
          setNotice({ text: "本机切换了会话分支，历史已更新", tone: "warn" })
          break
        case "session_compact_failed":
          setNotice({ text: String(event.errorMessage || "上下文压缩失败"), tone: "bad" })
          break
        case "ui_prompt_start":
        case "ui_prompt_end":
          // 镜像 UI 唯一可观测的跨扩展面：只把“本机有弹窗”做成常驻等待条，不伪造内容、不提供应答
          setUiPrompt((current) => uiPromptAfterEvent(current, event, Date.now()))
          break
        case "dialog_open":
        case "dialog_close": {
          // O1 观察：tap 捕获的弹窗内容（多槽）。与上面的信号条并行维护——tap 失效时
          // dialogs 自然为空、信号条照常工作（回退即今天的行为）。
          // O2：被拒绝的关闭另落一份回执（理由原文），回执不进 dialogs —— waiting 必须随关闭清掉。
          // B-8：归约与 dialogsRef 镜像在这里同步推进，不靠渲染后的 effect 同步——
          // 同批帧内 open 紧跟 denied close 时 effect 还没跑，拿旧 ref 拼回执会丢 title/kind。
          const prevDialogs = dialogsRef.current
          if (event.type === "dialog_close") {
            const closed = prevDialogs.find((card) => card.dialogId === String(event.dialogId || ""))
            const receipt = dialogReceiptOf(event, closed)
            if (receipt) {
              setDialogReceipts((current) => [...current.filter((item) => item.dialogId !== receipt.dialogId), receipt].slice(-3))
            }
          }
          const nextDialogs = dialogsAfterEvent(prevDialogs, event)
          if (nextDialogs !== prevDialogs) {
            dialogsRef.current = nextDialogs
            setDialogs(nextDialogs)
          }
          break
        }
        case "ext_status":
          setExtStatus((current) => extStatusAfterEvent(current, event))
          break
        case "ext_notify": {
          // 扩展 notify 原文进通知栈：info/warning/error 对齐通知栈 level，其余归 info
          const level = event.level === "warning" ? "warning" : event.level === "error" ? "error" : "info"
          const message = typeof event.message === "string" ? event.message : ""
          if (message) pushNotice({ level, title: message })
          break
        }
        case "extension_error":
          setNotice({ text: String(event.error || "扩展出错"), tone: "bad" })
          break
        case "bash_execution_update":
          dispatch({ type: "bash-delta", delta: String(event.delta || "") })
          break
        case "tool_end_meta":
          // relay 结束元数据：订阅/补发是全量 entries，live end 后单条。
          consumeToolEndMeta(event as TerminalEvent)
          break
        default:
          break
      }
    },
    [
      rememberModel,
      dispatch,
      startTurn,
      finishTurn,
      applyTerminalEventNow,
      scheduleTerminalUpdate,
      settleTerminalsNow,
      consumeToolEndMeta,
      pushNotice,
      hasLocalQueueCid,
      messageStartSeen,
    ],
  )

  const handleEventRef = useRef(handleEvent)
  useEffect(() => {
    handleEventRef.current = handleEvent
  }, [handleEvent])

  /** 同房间重订阅补齐：since = 只要 seq 之后的增量（不清空界面），否则全量重建 */
  const sendResync = useCallback((since: boolean, room: string = roomRef.current) => {
    const id = room
    // 换房后旧房间的补齐请求作废：否则会替新房间多发一份 subscribe（UI 低危：重同步定时器不带房间标记）
    if (!id || roomRef.current !== id) return
    resyncAtRef.current = Date.now()
    const ws = wsRef.current
    // socket 还没开（正在重连）：记下这次补齐请求，等 onopen 后补发。
    // 不能在这里排定时器：断线期间会一轮轮空转，重连后又会和 since 自愈重复
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      pendingResyncRef.current = { since, room: id }
      return
    }
    pendingResyncRef.current = null
    const sync = syncRef.current
    const frame = since && sync.rev && sync.room === id ? { type: "subscribe", room: id, since: { rev: sync.rev, seq: sync.seq } } : { type: "subscribe", room: id }
    ws.send(JSON.stringify(frame))
    socketRoomRef.current = id
  }, [])
  const resync = useCallback((since: boolean) => {
    const room = roomRef.current
    if (!room) return
    const wait = resyncAtRef.current + RESYNC_GAP_MS - Date.now()
    if (wait <= 0) {
      sendResync(since, room)
      return
    }
    // 上一次补齐还在飞：它的回复会覆盖这段缺口；窗口结束再核对一次，防止空闲时漏掉最后一条
    if (resyncTimerRef.current) return
    resyncTimerRef.current = window.setTimeout(() => {
      resyncTimerRef.current = null
      // 等窗口期间换了房：这次补齐属于旧房，直接丢掉（sendResync 里还有同一道守卫）
      if (roomRef.current !== room) return
      sendResync(since, room)
    }, wait)
  }, [sendResync])

  function takePendingRooms(list: RoomInfo[]): { deviceId: string; room: RoomInfo }[] {
    const watches: { deviceId: string; watch: PendingStart & { seen: Set<string> } }[] = []
    for (const [deviceId, watch] of Object.entries(armingRef.current)) watches.push({ deviceId, watch })
    for (const [deviceId, watch] of Object.entries(pendingWatchRef.current)) {
      if (armingRef.current[deviceId]?.at === watch.at) continue
      watches.push({ deviceId, watch })
    }
    const found: { deviceId: string; room: RoomInfo }[] = []
    for (const item of watches) {
      const room = findStartedRoom(item.watch, item.deviceId, list)
      if (!room) continue
      resolvedArmingAt.current.add(item.watch.at)
      found.push({ deviceId: item.deviceId, room })
    }
    return found
  }

  function settleQuery(id: string, msg: Record<string, unknown> | null, error: Error | null) {
    const waiter = id ? queriesRef.current.get(id) : undefined
    if (!waiter) return
    window.clearTimeout(waiter.timer)
    queriesRef.current.delete(id)
    if (error) waiter.reject(error)
    else if (msg) waiter.resolve(msg)
  }

  function rejectQueries(error: Error, onlyId = "") {
    const ids = onlyId && queriesRef.current.has(onlyId) ? [onlyId] : [...queriesRef.current.keys()]
    for (const id of ids) settleQuery(id, null, error)
  }

  /* ---- 主题偏好跨设备同步（R4-1）：P7 B4 起客户端不再参与 ----
   * 同步的是旧界面 style/prefs.ts 的外观五字段（theme / chrome / font / size / mono），新界面一个都不用
   * （主题在 pi_remote_pi_prefs，plan §6.5），style/prefs.ts 已删，所以不再上行 prefs_set、不再应用 auth 快照与 prefs_changed。
   * relay 侧（relay/prefs.js、cap、帧校验）不动；握手照旧声明 prefs.sync（VIEWER_CAPS 不改，协议不变），收到的帧直接忽略。 */
  const connect = useCallback(() => {
    if (reconnectRef.current) {
      window.clearTimeout(reconnectRef.current)
      reconnectRef.current = null
    }
    // 代际守卫：StrictMode 双挂载、手动重连都会让旧 socket 晚一步 onclose。
    // 不守卫的话旧 socket 的 onclose 会再排一个 reconnect，出现两条 socket 同时订阅
    // 同一房间 → 每个 room_event 被 dispatch 两次 → 流式文本翻倍。
    const gen = ++genRef.current
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) {
      try { wsRef.current.close(); } catch {}
    }
    setStatus("连接中")
    setRetryAt(null)
    setTrying(true)
    // 新连接不继承上一条连接的任务清单；认证/重订阅后由 task_list_state 事件重建。
    setTaskList([])
    setUiPrompt(null)
    setDialogs([])
    setDialogReceipts([])
    setExtStatus(null)
    const ws = new WebSocket(wsUrl())
    wsRef.current = ws
    channel.attach(ws)
    const guard = window.setTimeout(() => {
      if (wsRef.current === ws && !authedRef.current) ws.close()
    }, CONNECT_TIMEOUT_MS)
    ws.addEventListener("close", () => window.clearTimeout(guard))
    ws.onopen = () => {
      // 退避只在**鉴权成功**后归零（auth_result.ok）：socket 能打开不等于链路可用，
      // 打开后立刻被关/鉴权失败若也清零，会退化成约 1 秒一轮的无界重试（UI·relay 中-1）。
      lastRxRef.current = Date.now()
      setStatus("鉴权中")
      // v4 握手：旧 relay 会忽略 proto/caps/client，照常按 token 鉴权
      ws.send(JSON.stringify(authFrame(tokenRef.current)))
      // 断线期间攒下的补齐请求不在这里发：认证还没结果，而且 auth_result 里会按 since 重订阅，
      // 这里再发一次就是同一房间订阅两遍（两份快照）。留到 auth_result 里按需补。
    }
    function leaveRoster() {
      deviceModeRef.current = false
      setDeviceMode(false)
      devicesRef.current = []
      setDevices([])
      selectedDeviceRef.current = null
      setSelectedDeviceId(null)
    }
    /** 有 devices 数组才进入设备名册；缺这个字段（旧 relay）就回到房间列表，避免侧栏被空设备面板盖住。 */
    function applyRoster(list: RoomInfo[], devicesField: unknown) {
      if (legacyRef.current || !Array.isArray(devicesField)) {
        if (deviceModeRef.current || devicesRef.current.length || selectedDeviceRef.current) leaveRoster()
        return
      }
      const prevDevices = devicesRef.current
      const nextDevices = devicesFromRoomList(devicesField, list)
      if (!nextDevices.length && list.length) {
        leaveRoster()
        return
      }
      const prevSelected = selectedDeviceRef.current
      let selected = prevSelected
      if (!selected || !nextDevices.some((device) => device.id === selected)) {
        const prefer = preferredDeviceId(list, roomRef.current, nextDevices)
        selected = prefer || pickDefaultDevice(nextDevices, list)
        selectedDeviceRef.current = selected
        setSelectedDeviceId(selected)
      }
      if (selected) {
        const prevDev = prevDevices.find((device) => device.id === selected)
        const nextDev = nextDevices.find((device) => device.id === selected)
        if (prevDev && nextDev && !prevDev.online && nextDev.online) loadSessionsRef.current(selected)
        if (prevDev?.online && nextDev && !nextDev.online) {
          clearPendingRef.current(selected)
          // 设备掉线：排队消息不可能再送达，退回草稿并报真实原因
          if (lazySendRef.current?.deviceId === selected) failLazySendRef.current(COPY.deviceOffline, true)
        }
      }
      devicesRef.current = nextDevices
      setDevices(nextDevices)
      // 12h attach 到期/断线时当前房间会被 clearRoom；设备与房间都回来后再自动接上上次看的会话。
      // 不只在 offline→online 那一帧做：attach 重连时设备可能先上线、房间晚一拍才注册。
      if (!roomRef.current && selected) {
        const dev = nextDevices.find((device) => device.id === selected)
        const last = lastRoomRef.current
        const lastRoom = last ? list.find((room) => room.id === last && room.online) : null
        if (dev?.online && lastRoom && (!lastRoom.deviceId || lastRoom.deviceId === selected)) {
          subscribeRef.current(last, true)
        }
      }
      if (!deviceModeRef.current) {
        deviceModeRef.current = true
        setDeviceMode(true)
      }
      const harnessing = Object.keys(armingRef.current).length > 0 || Object.keys(pendingWatchRef.current).length > 0
      const open = roomRef.current ? list.find((room) => room.id === roomRef.current) : undefined
      const wrongDevice = !!open && !!selected && roomDeviceId(open) !== selected
      // 选中的设备掉线不再清房间：新界面要"设备离线仍能看历史、输入照写、发送进 outbox"（design C04、plan device-offline）。
      // 只在打开的房间不属于选中设备时清（换了设备）。设备回来时同一房间由 room_list 的 current.online 分支接上。
      if (roomRef.current && !harnessing && !pendingSwitchRef.current && !expectedSessionFile.current && wrongDevice) {
        clearRoom()
      }
    }
    ws.onmessage = (ev) => {
      // 代际守卫必须放在解析/分发之前：旧 socket 迟到的帧（尤其 room_event）一旦进入
      // 下面的 reducer，就会在当前连接上重放一遍（流式翻倍、串房）。onclose 已有同款守卫。
      if (!acceptSocketFrame(gen, genRef.current, ev.data)) return
      if (wsRef.current === ws) lastRxRef.current = Date.now()
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      const type = msg.type
      if (type === "auth_result") {
        if (msg.ok) {
          // 新 socket：relay 这边还没有任何订阅
          socketRoomRef.current = null
          authedRef.current = true
          setAuthed(true)
          setEverConnected(true)
          setAuthError("")
          setStatus("已连接")
          setRetryCount(0)
          // 链路真正可用才把退避归零（socket onopen 不算，见 UI·relay 中-1）
          backoffRef.current = 1000
          setTrying(false)
          const info = serverInfo(msg)
          serverRef.current = info
          setServer(info)
          // P11 prefs-sync 快照：只有新 relay 且声明 prefs.sync 时带 prefs 字段；旧 relay 没有 → 保持本地默认
          const prefsMsg = (msg as Record<string, unknown>).prefs as { subset?: unknown } | null | undefined
          if (prefsMsg && typeof prefsMsg === "object") {
            const nav = mobileNavFromPrefsSubset(prefsMsg.subset)
            setSyncedMobileNav(nav)
          }
          const pendingResync = pendingResyncRef.current
          pendingResyncRef.current = null
          let resubscribed = false
          // 断线期间挂起的命令：relay 进程没变就凭 dedupeKey 重发取回结果
          channel.connected(typeof msg.boot === "string" ? msg.boot : "")
          legacyRef.current = false
          // 本浏览器删掉的会话（P8 R25）：它们的离线房间不进名册（deletedSessions.ts）
          const list = withoutDeletedRooms(parseRooms(msg.rooms), readDeletedSessions(deletedStorage(), Date.now()), roomRef.current || null)
          roomsRef.current = list
          setRooms(list)
          // B-1：名册边沿喂注意力追踪（断线期间别房跑完的回合在这里补落定）
          // R3-1：同一份名册里的 relay 回合摘要紧接着种回（刷新/重连恢复的主路径）
          commitRoomTurnTracker(
            seedRoomTurnEnds(trackRoomListEdges(roomTurnTrackerRef.current, list, roomRef.current), roomTurnSeedsOf(msg.rooms), roomRef.current),
          )
          // 收件箱账本快照（D-§1）：带 inbox 字段就整替本地副本，turn 条目顺路作种子补追踪器空缺；
          // 旧 relay 无字段 → 清空副本（attention 回落 room.waiting 摘要面）。
          if (Array.isArray(msg.inbox)) {
            const entries = parseInboxEntries(msg.inbox)
            inboxRef.current = entries
            setInbox(entries)
            commitRoomTurnTracker(seedRoomTurnEnds(roomTurnTrackerRef.current, inboxTurnSeedsOf(entries), roomRef.current))
          } else {
            inboxRef.current = []
            setInbox([])
          }
          // 定时排期快照（D-§3）：新连接整替排期副本；旧 relay 无字段 → 清空（面板不出定时段）。
          if (!applySchedulesSnapshot(msg.rooms)) {
            schedulesRef.current = {}
            setSchedulesByRoom({})
          }
          applyRoster(list, msg.devices)
          // 观众自己重连时设备可能一直在线，offline→online 的刷新不会触发；
          // 这里补一次（节流），否则手机后台一段时间后看不到 Mac 上新产生的会话
          if (deviceModeRef.current && Date.now() - lastSessionsAtRef.current > 10_000) {
            const sel = selectedDeviceRef.current
            const dev = devicesRef.current.find((item) => item.id === sel)
            if (sel && dev?.online) {
              lastSessionsAtRef.current = Date.now()
              loadSessionsRef.current(sel)
            }
          }
          if (lazySessionRef.current) {
            // 用户只点选了一个还没载入的会话：重连后不要自动订阅别的房间把选择顶掉。
            // 排队中的发送由 room_list/subscribed 按目标 sessionId 自己接。
          } else if (!deviceModeRef.current) {
            const saved = list.find((room) => room.id === roomRef.current)
            const pick = saved || list.find((room) => room.online) || list[0]
            if (pick) {
              subscribeRef.current(pick.id, true)
              resubscribed = true
            } else clearRoom()
          } else {
            const device = devicesRef.current.find((item) => item.id === selectedDeviceRef.current)
            const openId = pickLoginRoom(list, selectedDeviceRef.current, roomRef.current, !!device?.online)
            if (openId) {
              subscribeRef.current(openId, true)
              resubscribed = true
            }
          }
          // 上面已经重订阅（带 since 自愈）就不再补；没重订阅但断线期间记下了缺口，才补一次
          if (pendingResync && !resubscribed && roomRef.current) sendResync(pendingResync.since, pendingResync.room)
        } else {
          authedRef.current = false
          setAuthed(false)
          setEverConnected(false)
          tokenRef.current = ""
          setToken("")
          safeStore.remove("pi_remote_viewer_token")
          setAuthError(String(msg.error || "token 不正确"))
          setStatus("未连接")
          setRetryCount(0)
          setTrying(false)
          setUiPrompt(null)
          setDialogs([])
          setExtStatus(null)
          setTurnEnd(null)
          inboxRef.current = []
          setInbox([])
          schedulesRef.current = {}
          setSchedulesByRoom({})
          ws.close()
        }
        return
      }
      if (type === "room_list") {
        // 本浏览器删掉的会话（P8 R25）：它们的离线房间不进名册（deletedSessions.ts）
        const list = withoutDeletedRooms(parseRooms(msg.rooms), readDeletedSessions(deletedStorage(), Date.now()), roomRef.current || null)
        const previous = roomsRef.current.find((room) => room.id === roomRef.current)
        roomsRef.current = list
        setRooms(list)
        // B-1：名册边沿喂注意力追踪（别房 busy true→false = 一回合落定）
        // R3-1：同一份名册里的 relay 回合摘要紧接着种回（刷新/重连恢复的主路径）
        commitRoomTurnTracker(
          seedRoomTurnEnds(trackRoomListEdges(roomTurnTrackerRef.current, list, roomRef.current), roomTurnSeedsOf(msg.rooms), roomRef.current),
        )
        // 收件箱账本快照（D-§1）：广播 room_list 给声明端附带 inbox 全量快照——整替本地
        // 副本（增量帧丢一帧也能靠下一次名册广播自愈）；无字段（旧 relay）不动副本。
        if (Array.isArray(msg.inbox)) {
          const entries = parseInboxEntries(msg.inbox)
          inboxRef.current = entries
          setInbox(entries)
          commitRoomTurnTracker(seedRoomTurnEnds(roomTurnTrackerRef.current, inboxTurnSeedsOf(entries), roomRef.current))
        }
        // 定时排期快照（D-§3）：名册广播里每房的 schedules 整替对应桶（增量帧丢帧靠它自愈）。
        applySchedulesSnapshot(msg.rooms)
        applyRoster(list, msg.devices)
        const started = takePendingRooms(list)
        if (started.length) {
          for (const item of started) clearPendingRef.current(item.deviceId)
          // 新 pi 的会话清单要等扩展上报 manifest；稍后补拉一次，远程新建的会话才会进列表
          window.setTimeout(() => {
            const sel = selectedDeviceRef.current
            if (sel) loadSessionsRef.current(sel)
          }, 2500)
          const selectedDevice = devicesRef.current.find((device) => device.id === selectedDeviceRef.current)
          const queued = lazySendRef.current
          // 惰性发送等到的就是这一个房间：订阅后由 subscribed/snapshot 触发一次提交。
          // 注意不能走 subscribe() 的“普通打开”分支，那会把队列当切走清掉。
          const lazyStarted = queued ? started.find((item) => item.deviceId === queued.deviceId && item.room.id === queued.sessionId) : null
          if (lazyStarted && selectedDevice?.online) {
            openLazyRoomRef.current(lazyStarted.room.id)
            setNotice({ text: lazySendPhaseText("waiting"), tone: "warn", codes: ["progress"] })
            return
          }
          const picked = started.find(
            (item) => item.deviceId === selectedDeviceRef.current && !suppressStartedRoomsRef.current.has(`${item.deviceId}:${item.room.id}`),
          )
          if (picked && selectedDevice?.online) {
            subscribeRef.current(picked.room.id, true)
            setNotice({ text: picked.room.label ? `已切换到「${picked.room.label}」` : "已切换到新会话", tone: "warn" })
            return
          }
          // 已经切走的旧启动：房间照样起来了，但不再自动打开/发送
          for (const item of started) suppressStartedRoomsRef.current.delete(`${item.deviceId}:${item.room.id}`)
        }
        const current = list.find((room) => room.id === roomRef.current)
        if (current?.online && socketRoomRef.current !== current.id && !lazySessionRef.current) {
          // 重连时这个房间还不在线，auth_result 没能重订阅：现在它上线了，带 since 接上（不清界面），
          // 否则页面停在断线前的正文，outbox 回放的消息一直「发送中…」（联动测试 L19）
          subscribeRef.current(current.id, true)
        }
        if (current?.online) {
          cancelOffline()
          setOnline(true)
          setRoomDown(false)
          setNotice(clearConnectivity)
          if (!current.busy) {
            finishTurn()
            setBusy(false)
            setActivity("")
          }
          return
        }
        // 同 cwd 可能出现多个在线房间（同目录开两个 pi）。优先挑"上次列表里没有的新房间"，
        // 并在订阅后用 get_state.sessionFile 校验目标；不一致就提示让用户自己选，
        // 而不是静默展示一个错会话的历史。
        const cwd = current?.cwd || previous?.cwd
        const candidates = list.filter((room) => room.online && !!cwd && room.cwd === cwd && room.id !== roomRef.current)
        // 只有一个候选 = 没有"选错"风险：哪怕它是之前见过的房间（切回旧会话）也直接跟随。
        // knownRoomIds 只在"多个候选"时用于区分谁是真新房——否则切回旧会话永远跟不上，
        // 界面会卡在已离线的旧房间上（房间 id 就是 sessionId，会反复重现）。
        const sole = candidates.length === 1 ? candidates[0] : undefined
        const fresh = candidates.find((room) => !knownRoomIds.current.has(room.id))
        const switched = sole || fresh || (expectedSessionFile.current ? candidates.find((room) => room.id !== roomRef.current) : undefined)
        if (switched) {
          knownRoomIds.current.add(switched.id)
          capGrowingSet(knownRoomIds.current, KNOWN_ROOM_IDS_MAX)
          if (candidates.length > 1 && !fresh && !sole) {
            // 这一步不订阅、不校验：把预期目标作废，否则 clearRoom 守卫会长期失效
            expectedSessionFile.current = null
            setNotice({ text: "检测到多个在线会话，请手动选择要看的那个。", tone: "warn" })
            return
          }
          subscribeRef.current(switched.id)
          // 请求校验成功后预期文件
          if (expectedSessionFile.current) {
            void checkSwitchedRoom(switched.id, expectedSessionFile.current)
          }
          setNotice({ text: switched.label ? `已切换到「${switched.label}」` : "已切换到新会话", tone: "warn" })
          return
        }
        if (current) {
          scheduleOffline(current.id)
          return
        }
        if (roomRef.current) {
          setOnline(false)
          setBusy(false)
          setActivity("")
          setUiPrompt(null)
          setDialogs([])
          setExtStatus(null)
          resetTurn()
          setTurnEnd(null)
          setNotice({ text: "这个会话已经结束。历史还可以看。", tone: "warn", codes: ["connectivity"] })
          return
        }
        const anyOnline = list.find((room) => room.online)
        if (anyOnline && !lazySessionRef.current && !(deviceModeRef.current && !pendingSwitchRef.current && !expectedSessionFile.current)) {
          subscribeRef.current(anyOnline.id)
        }
        return
      }
      if (type === "buffer_replay" || type === "history") return
      // P10 使用活动：relay 回帧（按请求 id 结案；未请求的帧忽略，旧 relay 不会主动发）
      if (type === "usage_snapshot") {
        const rid = typeof msg.requestId === "string" ? msg.requestId : ""
        if (rid && queriesRef.current.has(rid)) settleQuery(rid, msg, null)
        return
      }
      // ack / command_accepted 与房间无关，必须在 room 过滤**之前**处理：
      // 命令发起后会话可能已换代（roomRef 已变成新房间，而 ack 带的是旧房间 id）。
      if (type === "ack") {
        // sendQuery 发的帧（dialog_answer 等，id 以 q 开头）也回 ack：先按查询结案，否则永远等到超时，
        // 应答其实成功了还弹"答案发送失败"（L3 L38）
        const ackId = typeof msg.id === "string" ? msg.id : ""
        if (ackId && queriesRef.current.has(ackId)) {
          if (msg.ok === false) settleQuery(ackId, null, new RelayError(typeof msg.code === "string" && msg.code ? msg.code : "error", typeof msg.error === "string" && msg.error ? msg.error : "请求失败"))
          else settleQuery(ackId, msg, null)
          return
        }
        channel.ack(msg)
        return
      }
      if (type === "command_accepted") {
        channel.accepted(msg.id, msg.timeoutMs)
        return
      }
      if (type === "session_list") {
        settleQuery(typeof msg.id === "string" ? msg.id : "", msg, null)
        return
      }
      if (type === "session_archive") {
        const deviceId = typeof msg.deviceId === "string" ? msg.deviceId : ""
        const session = msg.session as ArchiveSession | undefined
        if (deviceId && session && typeof session.id === "string" && Array.isArray(session.messages)) {
          // LRU 上限（UI·relay 中-4）：点开过的归档正文不会无限常驻，最旧的最多留 32 份。
          rememberSessionArchive(archivesRef.current, `${deviceId}\n${session.id}`, session)
          setArchiveTick((n) => n + 1)
        }
        return
      }
      // 会话被服务器清掉（P9 B，session.purge）：设备确认删除成功后 relay 清掉全部副本并
      // 广播 session_removed{deviceId,ids}。与 session_archive 一样是账户级帧（没有 room），
      // 必须在房间过滤之前处理——说的正是"别的会话没了，侧栏那一行要消失"。
      if (type === "session_removed") {
        const removed = parseSessionRemoved(msg)
        if (!removed) return
        const gone = new Set(removed.ids)
        // B1：先记下这台设备已 purge 的 id。在途 get_sessions 的回包可能比这一帧更晚落地，
        // 落地时按这份名单过滤，已删行不会再被整表覆盖写回（见 loadSessions 的 .then）。
        purgedSessionsRef.current = rememberPurgedSessions(purgedSessionsRef.current, removed.deviceId, removed.ids)
        // 1) 会话清单：这台设备上的行摘掉（别的设备上的同 id 不动）
        const known = sessionsByDeviceRef.current[removed.deviceId] ?? []
        const keptSessions = withoutRemovedSessions(known, gone)
        if (keptSessions !== known) setSessionsByDevice((prev) => ({ ...prev, [removed.deviceId]: keptSessions as SessionEntry[] }))
        // 2) 名册：这台设备上被删会话的离线房间摘掉（在线房间不动——正在运行的会话 relay 不会清）
        const keptRooms = withoutRemovedRooms(roomsRef.current, removed.deviceId, gone)
        if (keptRooms !== roomsRef.current) {
          roomsRef.current = keptRooms
          setRooms(keptRooms)
        }
        // 3) 会话库正文缓存：键是 `${deviceId}\n${id}`
        for (const key of archiveKeysOf(removed.deviceId, removed.ids)) archivesRef.current.delete(key)
        setArchiveTick((n) => n + 1)
        // 4) 落盘草稿：按房间键存，被删会话的草稿一起删
        for (const id of removed.ids) saveRoomDraft(id, "")
        // 5) 正在看（或点选待载入）的就是被删会话：同设备还有会话就切过去，一条都没有就清房并
        //    发一次性信号 purgedRoom——容器层（PiAppBody）收到信号后进新建会话页（spec §4.7.1 第 5 条）。
        //    先把 draftHydrated 关掉，免得 clearRoom 把输入框里的草稿写回刚删掉的会话。
        const current = roomRef.current
        const lazy = lazySessionRef.current?.id ?? ""
        if ((current && gone.has(current)) || (lazy && gone.has(lazy))) {
          draftHydratedRef.current = false
          if (current && gone.has(current)) clearRoom()
          else {
            lazySessionRef.current = null
            setLazySelection(null)
            setRoomId("")
            safeStore.session.remove("pi_room")
          }
          const knownRoomIds = new Set(roomsRef.current.map((room) => room.id))
          const target = removalTargetOf(known, knownRoomIds, gone)
          if (target.kind === "switch") subscribeRef.current(target.id, true)
          else setPurgedRoom({ deviceId: removed.deviceId, id: current || lazy, at: Date.now() })
          setDraft("")
          setNotice({ text: "这个会话已被删除", tone: "warn" })
        }
        return
      }
      if (type === "error") {
        const code = typeof msg.code === "string" ? msg.code : ""
        const message = String(msg.message || msg.code || "出错了")
        const qid = typeof msg.id === "string" ? msg.id : ""
        // 只有没带 proto 的旧 relay 才靠 unknown_type 猜"不支持设备名册"、整体降级；
        // v4 按 caps 开关界面，某个请求被拒只让它自己失败（下面按 id 结案）
        if (code === "unknown_type" && serverRef.current.proto < 4) {
          legacyRef.current = true
          deviceModeRef.current = false
          setDeviceMode(false)
          rejectQueries(new RelayError("unknown_type", message), qid)
          return
        }
        if (qid && queriesRef.current.has(qid)) {
          settleQuery(qid, null, new RelayError(code || "error", message))
          return
        }
        // 命令被拒（rate_limited 等，relay 带回了请求 id）：对应命令立刻失败，不再干等超时
        if (qid && channel.error(msg)) return
        // 订阅的房间已不存在（sessionStorage 里的旧 id）：清空房间并自动挑一个在线的，
        // 否则 roomId 留着但连不上，输入条永久禁用。
        if (msg.code === "no_room") {
          clearRoom()
          const pick = roomsRef.current.find((room) => room.online)
          if (pick) subscribeRef.current(pick.id, true)
          setNotice({ text: "这个会话已经不存在，已切换到其他会话。", tone: "warn" })
          return
        }
        setNotice({ text: String(msg.message || msg.code || "出错了"), tone: "bad" })
        return
      }
      if (type === "usage_state") {
        // 终端 footer 实时数据（契约 §4.7.1）：订阅即送、payload 不变不推 → 零轮询。
        // 只认当前房间：换代窗口内旧房间的 usage_state 停留会造成"费用跳回去"。
        if (!msg.room || msg.room === roomRef.current) setUsage((msg.usage as UsageState) || null)
        return
      }
      // P11 prefs-sync：账户级帧，与房间无关，在房间过滤之前处理。只消费 mobileNav（additive）；
      // 旧外观五字段不再参与（P7 B4），收到也不影响新字段。
      if (type === "prefs_changed" || type === "prefs_saved") {
        const nav = mobileNavFromPrefsSubset((msg as Record<string, unknown>).subset)
        if (nav) setSyncedMobileNav(nav)
        return
      }
      // 注意力恢复通道（R3-1）：relay 回合摘要的实时推送，与 room_offline 一样要在
      // 房间过滤之前处理——说的正是别房。带记录 = 种子补空缺（先到为准）；null =
      // 已清（别端进房已读 / 新回合活动 / 本端进房由 relay 落实），经 forget 清本地。
      if (type === "room_attention") {
        const parsed = roomAttentionSeedOf(msg.room, msg.lastTurnEnd)
        if (parsed) {
          commitRoomTurnTracker(
            parsed.seed
              ? seedRoomTurnEnds(roomTurnTrackerRef.current, [parsed.seed], roomRef.current)
              : forgetRoomTurnEnd(roomTurnTrackerRef.current, parsed.roomId),
          )
        }
        return
      }
      // 房间等待摘要（P9 A，room.dialogs）：与 room_attention 一样是别房信号，必须在
      // 房间过滤之前处理。每帧是这个房间的全量摘要，整个替换、不做增量；解析复用
      // parseRooms（校验规则只有 devices.ts 一份），房间不在名册里时只更新已有条目。
      if (type === "room_waiting") {
        const waitingRoom = typeof msg.room === "string" ? msg.room : ""
        if (!waitingRoom) return
        const [patched] = parseRooms([{ id: waitingRoom, online: true, waiting: msg.waiting, waitingPrompt: msg.waitingPrompt }])
        const next = roomsRef.current.map((room) =>
          room.id === waitingRoom
            ? { ...room, waiting: patched?.waiting ?? [], waitingPrompt: patched?.waitingPrompt ?? null }
            : room,
        )
        roomsRef.current = next
        setRooms(next)
        return
      }
      // 收件箱账本增量（D-§1）：与 room_attention 一样是全局信号，必须在房间过滤之前处理。
      // upserts 并入本地副本并把 turn 条目作种子补追踪器；removed 的 turn 条目按 key 里的
      // 时刻与追踪器记录比对——不新于记录才 forget（别端清掉的是同一份落定；本地若已有
      // 更新的实时边沿记录，不能被旧清账误伤）。
      if (type === "inbox_update") {
        const upserts = parseInboxEntries(msg.upserts)
        const removed = Array.isArray(msg.removed) ? msg.removed.filter((k): k is string => typeof k === "string") : []
        const next = applyInboxUpdate(inboxRef.current, upserts, removed)
        if (next !== inboxRef.current) {
          inboxRef.current = next as InboxEntry[]
          setInbox(next as InboxEntry[])
        }
        if (upserts.length) {
          commitRoomTurnTracker(seedRoomTurnEnds(roomTurnTrackerRef.current, inboxTurnSeedsOf(upserts), roomRef.current))
        }
        for (const key of removed) {
          if (!key.startsWith("turn:")) continue
          const cut = key.lastIndexOf(":")
          const at = cut > 0 ? Number(key.slice(cut + 1)) : NaN
          const roomId = cut > 0 ? key.slice("turn:".length, cut) : ""
          if (!roomId || !Number.isFinite(at)) continue
          const prev = roomTurnTrackerRef.current.ends.get(roomId)
          if (prev && prev.at <= at) commitRoomTurnTracker(forgetRoomTurnEnd(roomTurnTrackerRef.current, roomId))
        }
        return
      }
      // 定时排期增量（D-§3）：单房全量替换该房的排期桶；与 inbox_update 一样是全局
      // 信号，必须在房间过滤之前处理（别房排期到点/失败也要同步进副本）。
      if (type === "schedule_update") {
        const roomId = typeof msg.room === "string" ? msg.room : ""
        if (roomId) {
          const next = { ...schedulesRef.current, [roomId]: parseScheduleEntries(msg.schedules) }
          schedulesRef.current = next
          setSchedulesByRoom(next)
        }
        return
      }
      // room_offline 要在房间过滤之前处理：别的房间下线也得更新侧栏里的在线标记
      if (type === "room_offline") {
        const offlineId = String(msg.room || "")
        setRooms((list) => list.map((room) => (room.id === offlineId ? { ...room, online: false, busy: false } : room)))
        roomsRef.current = roomsRef.current.map((room) => (room.id === offlineId ? { ...room, online: false, busy: false } : room))
        // B-1：下线不是跑完——追踪器只落基准、不产落定记录（与紧接着的名册边沿去重靠基准一致）
        commitRoomTurnTracker(trackRoomOfflineEdge(roomTurnTrackerRef.current, offlineId))
        if (offlineId && offlineId !== roomRef.current) return
        setBusy(false)
        setActivity("")
        setOnline(false)
        setUiPrompt(null)
        setDialogs([])
        setExtStatus(null)
        resetTurn()
        setTurnEnd(null)
        scheduleOffline(offlineId)
        return
      }
      // B-1：别房事件帧在整帧丢弃之前先喂注意力边沿追踪——别房回合的升沿、
      // 错误与落沿只能在这里记账，进了 handleEvent 就只剩当前房的份了。
      if (type === "room_event" && msg.room && msg.room !== roomRef.current) {
        commitRoomTurnTracker(
          trackRoomEventEdge(roomTurnTrackerRef.current, String(msg.room), (msg.event || {}) as RoomTurnEvent, roomRef.current),
        )
      }
      if (msg.room && msg.room !== roomRef.current) return
      if (type === "subscribed") {
        if (msg.online) cancelOffline()
        setOnline(!!msg.online)
        // 订阅时就不在线是确定的状态（选了一个已结束的会话、重连时本机 pi 已经关了），红条直接出
        setRoomDown(!msg.online)
        setBusy(!!msg.busy)
        if (!msg.busy) {
          finishTurn()
          setActivity("")
        } else {
          // 页面在回合中途打开/重连：没有 agent_start 也要把这一轮记成“进行中”，结束时才有信号
          if (!turnActiveRef.current) startTurn()
          setActivity((prev) => prev || "正在输出")
        }
        if (msg.online) setNotice(clearConnectivity)
        // 排队的惰性发送：订阅确认在线后等一帧（snapshot 很可能紧跟着来）再提交，
        // 避免推送前先出乐观气泡又被全量快照冲掉。
        if (msg.online && msg.room) {
          const target = String(msg.room)
          const deviceId = selectedDeviceRef.current
          if (deviceId && roomRef.current === target) lazyRoomReadyRef.current(target, deviceId)
        }
        // 播种：snapshot 不带 model/thinkingLevel 字段，只从 assistant 消息反推模型会
        // 长时间空白（空会话/非 assistant 收尾时永远空）。订阅后拉一次 get_state 回填。
        // 节流 3s：每次 resync/subscribe 都拉一次会把命令通道和限速令牌吃光。
        // 按房间节流：3s 内切到另一个房间也要拉，否则新房间的模型名一直空着
        const pulled = lastStatePullRef.current
        const subRoom = String(msg.room || roomRef.current || "")
        if (msg.online && (pulled.room !== subRoom || Date.now() - pulled.at > 3000)) {
          lastStatePullRef.current = { room: subRoom, at: Date.now() }
          void commandSendRef.current("get_state").catch(() => {})
        }
        return
      }
      if (type === "snapshot") {
        const step = snapshotStep(syncRef.current, msg)
        if (step.action === "resync-since" || step.action === "resync-full") {
          resync(step.action === "resync-since")
          return
        }
        // 陈旧全量（同世代 seq 更小）整帧忽略：连 pending 标记也不能让它置真，
        // 否则忽略后没有后续帧来清，界面会一直显示"正在从本机拉取会话…"（UI·relay 中-2）。
        if (step.action === "ignore") return
        if (msg.snapshotPending === true) setSnapshotPending(true)
        if (msg.snapshotPending !== true) setSnapshotPending(false)
        syncRef.current = step.next
        const messages = Array.isArray(msg.messages) ? (msg.messages as AgentMessage[]) : []
        if (step.action === "full") {
          // 全量快照也会在会话换代时广播：只清旧的截断/连接提示，"已切换分支"之类留给用户看
          setNotice((prev) => clearConnectivity(clearNoticeCode(prev, "truncated")))
          dispatch({ type: "snapshot", messages })
          // 快照里可能已有工具块：等 transcript 落地后与已到的结束元数据合并。
          terminalHistoryPendingRef.current = true
          // 服务器安全阀触发（单房 10000 条 / 磁盘 8MB 扫描上限）：镜像不完整，必须明说，
          // 否则用户会把截断后的会话当成完整历史（见 data-interface.md §4.11）
          if (msg.truncated === true) {
            setNotice({
              text: "这个会话很长，只加载了最近一部分历史（更早的消息服务端未交付）。",
              tone: "warn",
              codes: ["truncated"],
            })
          }
          // 历史补拉（R2-5）：全量快照整段换代，游标与入口状态一并重置（代次+1 让在飞补拉作废）；
          // 截断过才有“加载更早”入口，未截断即完整历史、入口不出现。
          historyGenRef.current += 1
          historyCursorRef.current = null
          // 整段换代：窗口缓存里的条目可能已不属于当前分支，一并作废（UI·relay 中-5）。
          historyCacheRef.current = null
          applyHistory({ room: roomRef.current || "", status: msg.truncated === true ? "more" : "done", error: "", truncated: msg.truncated === true, lastAdded: 0 })
        } else {
          dispatch({ type: "append", messages })
          // 增量快照也可能带来断线期间的工具块：同样等 transcript 落地后与已到的元数据合并。
          terminalHistoryPendingRef.current = true
        }
        setBusy(!!msg.busy)
        if (!msg.busy) {
          // 断线期间这一轮已跑完：用快照里的终版消息判错误，补发一次完成信号
          finishTurn(lastAssistantMessageFailed(messages))
          setActivity("")
        } else if (!turnActiveRef.current) {
          // 快照就是“正在跑”的权威状态：中途挂载/重连时也开启这一轮的完成信号
          startTurn()
        }
        // 快照落地后再发排队消息：此时乐观气泡不会再被 snapshot(reset) 擦掉。
        const lazyDeviceId = selectedDeviceRef.current
        if (lazyDeviceId && roomRef.current) lazyRoomReadyRef.current(roomRef.current, lazyDeviceId)
        for (let k = messages.length - 1; k >= 0; k -= 1) {
          const item = messages[k]
          if (item?.role === "assistant" && typeof item.model === "string" && item.model) {
            rememberModel(item)
            break
          }
        }
        return
      }
      if (type === "room_event") {
        const step = eventStep(syncRef.current, msg.seq, msg.rev)
        if (step.action === "ignore") return
        if (step.action === "resync-since" || step.action === "resync-full") {
          resync(step.action === "resync-since")
          return
        }
        syncRef.current = step.next
        handleEventRef.current((msg.event || {}) as { type?: string })
        return
      }
      if (type === "room_state") {
        setBusy(!!msg.busy)
        if (!msg.busy) {
          finishTurn()
          setActivity("")
        } else {
          if (!turnActiveRef.current) startTurn()
          setActivity((prev) => prev || "正在输出")
        }
        return
      }
    }
    ws.onclose = () => {
      if (stopRef.current) {
        channel.dispose("连接已关闭")
        return
      }
      if (gen !== genRef.current) return // 已被更新的连接取代，不重连
      if (wsRef.current === ws) {
        wsRef.current = null
        channel.attach(null)
      }
      authedRef.current = false
      setAuthed(false)
      setTrying(false)
      // 断开后旧任务清单不再可信；重连后按事件重新给，避免卡片显示断线前的旧状态。
      setTaskList([])
      // 弹窗等待是连接上的实时状态：断线立即清空，重连由 relay 缓存补发
      setUiPrompt(null)
      setDialogs([])
      // B-2：回执也是连接上的状态，断线一并清（重连补发的是未决 dialog，不是旧回执）
      setDialogReceipts([])
      setExtStatus(null)
      // 在飞命令先挂起：重连后同一 relay 进程凭 dedupeKey 取回结果，不重复执行
      channel.disconnected()
      // 挂起的查询（get_sessions 等）立刻失败：否则要白等 10s 超时，
      // 还可能在那时把空的设备列表误判成"旧 relay"而切进 legacy 模式
      rejectQueries(new RelayError("offline", "连接已断开"))
      if (!tokenRef.current) {
        setStatus("未连接")
        setRetryAt(null)
        channel.dispose("连接已关闭")
        return
      }
      setStatus("已断开")
      // 真实重试序号：每次非主动断开 +1，认证成功归零。第 1 次不伪造次数。
      setRetryCount((count) => count + 1)
      const wait = backoffRef.current
      backoffRef.current = Math.min(wait * 2, 20000)
      setRetryAt(Date.now() + wait)
      reconnectRef.current = window.setTimeout(() => connect(), wait)
    }
    // onmessage 闭包里用到 scheduleOffline / cancelOffline / checkSwitchedRoom / resync：
    // 都是 useCallback 且依赖为空/稳定数组，显式声明不会引起重连抖动。
  }, [scheduleOffline, cancelOffline, checkSwitchedRoom, resync, sendResync, channel, dispatch, finishTurn, resetTurn])

  function clearRoom() {
    // 草稿落盘（P3-3）：房间作废前先把草稿存回它的槽，之后草稿不再归属任何房间。
    persistDraftNow()
    draftOwnerRef.current = ""
    draftHydratedRef.current = false
    expectedSessionFile.current = null
    pendingBackfillRef.current = null
    roomRef.current = ""
    syncRef.current = emptySync()
    // 旧房间的缺口补齐 / 节流跟着房间作废：换房后旧定时器不能再给新房发 subscribe
    if (resyncTimerRef.current !== null) {
      window.clearTimeout(resyncTimerRef.current)
      resyncTimerRef.current = null
    }
    pendingResyncRef.current = null
    resyncAtRef.current = 0
    // 补拉窗口缓存跟随房间生命周期（UI·relay 中-5）：换房/清房后旧窗口不可复用。
    historyCacheRef.current = null
    // 清掉“未载入选择”的本地哨兵：公共 roomId 指向它，但 relay 里没有这个房间
    lazySessionRef.current = null
    setLazySessionState(null)
    setRoomId("")
    safeStore.session.remove("pi_room")
    setOnline(false)
    setRoomDown(false)
    setBusy(false)
    busyRef.current = false
    setActivity("")
    setSnapshotPending(false)
    // 房间没了就撤掉任务清单；新房间的清单只由它自己的事件重新建立
    setTaskList([])
    // 终端与子智能体条目也属于旧房间：清房一并作废。
    resetTerminals()
    setAgentState([])
    // 远程待发也属于旧房间：换房/离线后由新房间的 remote_queue_state 重新建立。
    remoteQueueRef.current = emptyRemoteQueue()
    setRemoteQueueState(remoteQueueRef.current)
    // 本机弹窗与上一个回合的完成信号都属于旧房间：清房一并作废
    setUiPrompt(null)
    setDialogs([])
    setExtStatus(null)
    resetTurn()
    setTurnEnd(null)
    // B-2：拒绝回执同样属于旧房间（logout 也走 clearRoom，一并覆盖）
    setDialogReceipts([])
    // 重复起始帧的去重记录属于旧房间：换房后新房间的第一条 message_start 必须放行。
    lastMessageStartsRef.current = []
    lastQueueSyncRef.current.clear()
    resetSendState()
  }

  // 只依赖 ref 与稳定 setter → useCallback([]) 保持引用稳定，
  // 否则每次渲染都是新函数，subscribeRef 的同步 effect 会每帧空转。
  const subscribe = useCallback((id: string, force = false) => {
    if (!id) return
    // 任何“真的打开另一个房间”的动作都先取消未载入会话的排队：
    // 换会话、换设备、新建会话最终都会走到这里，避免消息发到旧会话。
    // 同一目标房间的 force 重订阅（重连）不取消，否则排队的消息永远发不出去。
    const queued = lazySendRef.current
    if (queued && queued.sessionId !== id) cancelLazySendRef.current(false)
    const lazySelected = lazySessionRef.current
    if (lazySelected) {
      // 订阅的正是这个未载入会话（别的路径把它变成真实房间了）：保留队列，只撤掉合成项；
      // 订阅别的房间：取消队列，避免消息发错会话。
      if (lazySelected.id !== id) cancelLazySendRef.current(false)
      setLazySelection(null)
    }
    // 取消挂起的离线判定：重连/强制重订阅本身就是一次在线性重判定
    cancelOffline()
    if (roomRef.current === id && !force) return
    // 换到别的房间：旧房间的缺口补齐标记 / 节流作废，避免把 since 订阅补到新房
    if (roomRef.current !== id) {
      if (pendingResyncRef.current && pendingResyncRef.current.room !== id) pendingResyncRef.current = null
      resyncAtRef.current = 0
    }
    setSelectionNonce((n) => n + 1)
    const sync = syncRef.current
    // 同一房间（重连 / 再点一次当前房间）且已有镜像：只要 seq 之后的增量，界面不清空不闪
    const resume = roomRef.current === id && sync.room === id && !!sync.rev
    if (roomRef.current && roomRef.current !== id) pendingSwitchRef.current = false
    roomRef.current = id
    lastRoomRef.current = id
    setRoomId(id)
    // 存档失败不影响订阅本身（隐私模式下 safeStore 会静默失败）
    safeStore.session.set("pi_room", id)
    // 读 roomsRef 而不是闭包 rooms：connect 是 useCallback([])，闭包里的 rooms
    // 永远是首帧空数组，会让 online/busy 恒为 false（输入条被禁用、闪红条）。
    const room = roomsRef.current.find((item) => item.id === id)
    setOnline(!!room?.online)
    setBusy(!!room?.busy)
    // 同步更新 ref：订阅确认帧可能在本轮 effect 之前到达，避免用旧房间的 busy 误判完成
    busyRef.current = !!room?.busy
    if (!resume) {
      setModel("")
      setModelMeta({})
      setThinkingLevel("")
      setQueue({ steering: [], followUp: [] })
      // 换房间先清空远程待发：不能把上一个会话的待发挂到新会话上。
      remoteQueueRef.current = emptyRemoteQueue()
      setRemoteQueueState(remoteQueueRef.current)
      // 换房间先清空任务清单：不能把上一个会话的 todo/plan 挂到新会话上。
      setTaskList([])
      // 终端/子智能体条目按房间隔离；切房清空，同房间重连（resume）保留并走 unknown。
      resetTerminals()
      setAgentState([])
      setUiPrompt(null)
      setDialogs([])
      setExtStatus(null)
      resetTurn()
      setTurnEnd(null)
      // B-2：拒绝回执属于上一个房间，切房一并清，免得残留进新房间的 composer
      setDialogReceipts([])
      // B-1：进房即清该房的别房落定记录（人已经到了，不再是"还没看"）
      commitRoomTurnTracker(forgetRoomTurnEnd(roomTurnTrackerRef.current, id))
      setNotice(null)
      setUsage(null)
      setRoomDown(false)
      setSnapshotPending(false)
      resetSendState()
      // 切房间/换设备时草稿和图不能跟着走：否则容易把写给 Mac 的话发到 Windows
      const backfill = pendingBackfillRef.current
      pendingBackfillRef.current = null
      // 草稿落盘（P3-3）：换到别的房间才存旧/恢复新；同房重订阅草稿原样保留
      // （刷新重连时内存草稿是空的，先存后恢复会把落盘草稿误删）。fork 回填优先于落盘恢复。
      if (draftOwnerRef.current !== id) {
        persistDraftNow()
        draftOwnerRef.current = id
        draftHydratedRef.current = true
        setDraft(backfill ? backfill.text : readRoomDraft(id))
      } else if (backfill) {
        draftHydratedRef.current = true
        setDraft(backfill.text)
      } else if (!draftHydratedRef.current) {
        // 刷新后首次进入本房：内存是空草稿，把上次落盘的草稿恢复回来。
        draftHydratedRef.current = true
        setDraft(readRoomDraft(id))
      }
      if (backfill?.notice) {
        const notice = backfill.notice
        setNotice({ text: notice, tone: "warn" })
        // room_list 的自动切换会在 subscribe 之后紧接着写“已切换到…”。
        // 放到本轮末尾再压一次，fork 的“已回到输入框”才是用户最后看到的提示。
        window.setTimeout(() => setNotice({ text: notice, tone: "warn" }), 0)
      }
      clearPendingImages()
      clearPendingFiles()
      dispatch({ type: "reset" })
      syncRef.current = emptySync(id)
      // 换房：补拉窗口缓存只对上一个房间有效（UI·relay 中-5）。
      historyCacheRef.current = null
    }
    resyncAtRef.current = Date.now()
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(resume ? { type: "subscribe", room: id, since: { rev: sync.rev, seq: sync.seq } } : { type: "subscribe", room: id }))
      socketRoomRef.current = id
    }
  }, [cancelOffline, clearPendingFiles, clearPendingImages, dispatch, resetTurn, resetTerminals])

  const subscribeRef = useRef(subscribe)
  useEffect(() => {
    subscribeRef.current = subscribe
  }, [subscribe])

  const sendQuery = useCallback((frame: Record<string, unknown>) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new RelayError("offline", "连接不可用"))
    const id = "q" + (++querySeq.current) + "_" + Math.random().toString(36).slice(2, 8)
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        queriesRef.current.delete(id)
        reject(new RelayError("timeout", COPY.requestTimeout))
      }, GET_SESSIONS_TIMEOUT_MS)
      queriesRef.current.set(id, { resolve, reject, timer })
      try {
        ws.send(JSON.stringify({ ...frame, id }))
      } catch {
        window.clearTimeout(timer)
        queriesRef.current.delete(id)
        reject(new RelayError("offline", "发送失败"))
      }
    })
  }, [])

  /* ---- 对话框应答（O2）：开关下达 + 答案发送 + 回执管理 ---- */
  const legacyStyle = useLegacyStyle()
  const dialogAnswerSwitchSentRef = useRef("")
  // 开关下达（定版通道：UI → relay 命令帧 → 桥）：偏好值或房间变化即下达当前值；
  // relay 存当前值，桥重连时由 relay 重下达，所以这里只管「值变化即发」。
  useEffect(() => {
    if (!authed || !roomId) {
      dialogAnswerSwitchSentRef.current = ""
      return
    }
    const key = roomId + "|" + String(legacyStyle.dialogRemoteAnswer)
    if (dialogAnswerSwitchSentRef.current === key) return
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    dialogAnswerSwitchSentRef.current = key
    try {
      ws.send(JSON.stringify({ type: "dialog_answer_switch", room: roomId, enabled: legacyStyle.dialogRemoteAnswer }))
    } catch {
      dialogAnswerSwitchSentRef.current = ""
    }
  }, [authed, roomId, legacyStyle.dialogRemoteAnswer])

  /* ---- G1/G2 开关下达（与 dialog_answer_switch 同路同纪律：值变化即发，relay 存值、桥重连重下达） ---- */
  const askGate = useAskGatePrefs()
  const askUserSwitchSentRef = useRef("")
  useEffect(() => {
    if (!authed || !roomId) {
      askUserSwitchSentRef.current = ""
      return
    }
    const key = roomId + "|ask|" + String(askGate.askUserEnabled)
    if (askUserSwitchSentRef.current === key) return
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    askUserSwitchSentRef.current = key
    try {
      ws.send(JSON.stringify({ type: "ask_user_switch", room: roomId, enabled: askGate.askUserEnabled }))
    } catch {
      askUserSwitchSentRef.current = ""
    }
  }, [authed, roomId, askGate.askUserEnabled])

  const approvalGateSwitchSentRef = useRef("")
  useEffect(() => {
    if (!authed || !roomId) {
      approvalGateSwitchSentRef.current = ""
      return
    }
    const key = roomId + "|gate|" + String(askGate.approvalGateEnabled) + "|" + askGate.approvalGateTier
    if (approvalGateSwitchSentRef.current === key) return
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    approvalGateSwitchSentRef.current = key
    try {
      ws.send(JSON.stringify({ type: "approval_gate_switch", room: roomId, enabled: askGate.approvalGateEnabled, tier: askGate.approvalGateTier }))
    } catch {
      approvalGateSwitchSentRef.current = ""
    }
  }, [authed, roomId, askGate.approvalGateEnabled, askGate.approvalGateTier])


  /** 发送一份远程答案（先答广播：桥以第一个到达者为准）。结果三态供卡片 phase 用。
   *  To 版显式带目标房间：收件箱里对别房 confirm 条目原地应答走它（D-§1.5），
   *  不带房间的 sendDialogAnswer 仍是当前房语义、既有调用方不变。 */
  const sendDialogAnswerTo = useCallback(
    (room: string, dialogId: string, answer: DialogAnswer): Promise<DialogAnswerResult> => {
      if (!room) return Promise.resolve("error")
      const frame: Record<string, unknown> = { type: "dialog_answer", room, dialogId, action: answer.action }
      if (typeof answer.value === "string") frame.value = answer.value
      if (Array.isArray(answer.values)) frame.values = answer.values
      if (answer.action === "deny" && answer.note) frame.note = answer.note
      return sendQuery(frame).then(
        () => "ok" as const,
        (error: unknown) => {
          if (errorCode(error) === "dialog_gone") {
            pushNotice({ level: "info", title: "这个弹窗已被处理" })
            return "gone" as const
          }
          pushNotice({ level: "error", title: "答案发送失败，请重试" })
          return "error" as const
        },
      )
    },
    [pushNotice, sendQuery],
  )

  /** 当前房语义的应答（既有调用方走这里）。 */
  const sendDialogAnswer = useCallback(
    (dialogId: string, answer: DialogAnswer): Promise<DialogAnswerResult> => sendDialogAnswerTo(roomRef.current, dialogId, answer),
    [sendDialogAnswerTo],
  )

  /** 收件箱手动清除（D-§1）：只对 done/error 有效，waiting 由 relay 账本层拒清；
   *  结果经 inbox_update 广播回各端对齐（含本端），本地不抢先改副本。 */
  const dismissInbox = useCallback((key: string) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !key) return
    try {
      ws.send(JSON.stringify({ type: "inbox_dismiss", key }))
    } catch {}
  }, [])

  /** 定时排期创建（D-§3）：绑当前房；走 sendQuery 等回执——校验/上限错误要原样抛给
   *  创建表单显示。成功后清单经 schedule_update 广播对齐，本地不抢先改副本。 */
  const createSchedule = useCallback(
    (input: ScheduleCreateInput): Promise<ScheduleEntry | null> => {
      const room = roomRef.current
      if (!room) return Promise.reject(new RelayError("no_room", "还没有打开的会话"))
      return sendQuery({ type: "schedule_create", roomId: room, ...input }).then((msg) => {
        const entries = parseScheduleEntries([msg.data])
        return entries[0] ?? null
      })
    },
    [sendQuery],
  )

  /** 定时排期取消（D-§3）：结果同样经 schedule_update 对齐；回执失败抛给调用方提示。 */
  const cancelSchedule = useCallback(
    (scheduleId: string): Promise<void> => sendQuery({ type: "schedule_cancel", scheduleId }).then(() => undefined),
    [sendQuery],
  )

  const dismissDialogReceipt = useCallback((dialogId: string) => {
    setDialogReceipts((current) => current.filter((item) => item.dialogId !== dialogId))
  }, [])

  const loadSessions = useCallback((deviceId: string) => {
    if (!deviceId || legacyRef.current) return
    // 按设备独立序号：多设备并发拉取时，一台设备的新请求不能作废另一台设备的结果
    const tickets = sessionTickets.current
    const ticket = tickets.issue(deviceId)
    sessionsInFlight.current += 1
    setSessionsLoading(true)
    void sendQuery({ type: "get_sessions", deviceId })
      .then((msg) => {
        // 只允许该设备的最新请求落地，且不碰其他设备已有的清单
        if (!tickets.isCurrent(deviceId, ticket) || legacyRef.current) return
        // 本浏览器删掉的会话（P8 R25）：索引还没更新时拉到的旧清单里也不出现
        const fetched = withoutDeletedSessions(parseSessionList(msg.sessions), readDeletedSessions(deletedStorage(), Date.now()))
        // B1：请求发出后这台设备发生过 purge 时，回包可能是 purge 之前的整表快照——把已 purge 的行过滤掉再落地，
        // 不能像以前那样整表覆盖（P9 purge 路径按 D6 不写 localStorage 隐藏表，过滤不能只靠 R25 那张表）。
        setSessionsByDevice((prev) => ({ ...prev, [deviceId]: withoutPurgedSessions(fetched, purgedIdsOf(purgedSessionsRef.current, deviceId)) as SessionEntry[] }))
        setTruncatedByDevice((prev) => ({ ...prev, [deviceId]: msg.truncated === true }))
      })
      .catch((error: unknown) => {
        if (!tickets.isCurrent(deviceId, ticket)) return
        const code = errorCode(error)
        if (code === "closed") return
        if (serverRef.current.proto < 4 && (isUnknownType(error) || (code === "timeout" && devicesRef.current.length === 0))) {
          legacyRef.current = true
          deviceModeRef.current = false
          setDeviceMode(false)
          return
        }
        if (code === "no_device" && deviceId === UNREGISTERED_DEVICE_ID) return
        setNotice({ text: deviceErrorText(error), tone: "bad" })
      })
      .finally(() => {
        sessionsInFlight.current = Math.max(0, sessionsInFlight.current - 1)
        if (sessionsInFlight.current === 0) setSessionsLoading(false)
      })
  }, [sendQuery])

  const clearPending = useCallback((deviceId: string) => {
    // 启动被取消 / 超时：resolvedArmingAt 里对应的 at 不会再有 room_list 来结案，顺手清掉（只增表，UI 低危）
    const at = pendingWatchRef.current[deviceId]?.at ?? armingRef.current[deviceId]?.at
    if (at !== undefined) resolvedArmingAt.current.delete(at)
    delete pendingWatchRef.current[deviceId]
    delete armingRef.current[deviceId]
    setCommandInFlight((prev) => {
      if (!prev[deviceId]) return prev
      const next = { ...prev }
      delete next[deviceId]
      return next
    })
    setPendingStarts((prev) => {
      if (!prev[deviceId]) return prev
      const next = { ...prev }
      delete next[deviceId]
      return next
    })
  }, [])

  useEffect(() => {
    loadSessionsRef.current = loadSessions
    clearPendingRef.current = clearPending
  }, [loadSessions, clearPending])

  useEffect(() => {
    if (!deviceMode || !selectedDeviceId) return
    loadSessions(selectedDeviceId)
  }, [deviceMode, selectedDeviceId, loadSessions])

  // 自动/手动换设备时，未载入选择若属于旧设备就作废，避免用新设备的输入条发旧会话
  useEffect(() => {
    const lazy = lazySessionRef.current
    if (!lazy) return
    if (selectedDeviceId && lazy.deviceId === selectedDeviceId) return
    cancelLazySendRef.current(false)
    clearRoom()
  }, [selectedDeviceId])

  useEffect(() => {
    const entries = Object.entries(pendingStarts)
    if (!entries.length) return
    const timers = entries.map(([deviceId, pending]) => {
      const left = SESSION_ONLINE_WATCH_MS - (Date.now() - pending.at)
      return window.setTimeout(() => {
        const current = pendingWatchRef.current[deviceId]
        if (!current || current.at !== pending.at) return
        resolvedArmingAt.current.delete(pending.at)
        delete pendingWatchRef.current[deviceId]
        setPendingStarts((prev) => {
          if (prev[deviceId]?.at !== pending.at) return prev
          const next = { ...prev }
          delete next[deviceId]
          return next
        })
        const queued = lazySendRef.current
        if (queued && queued.deviceId === deviceId && queued.sessionId === pending.key) {
          failLazySendRef.current(COPY.watchTimeout, true)
        } else {
          setNotice({ text: COPY.watchTimeout, tone: "bad" })
        }
      }, Math.max(0, left))
    })
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [pendingStarts])

  /** 立刻重连，不等退避。force：连接看着还开着但已经死了（收不到 onclose），直接换一条新连接 */
  const reconnect = useCallback((force: boolean) => {
    if (!tokenRef.current || stopRef.current) return
    const state = wsRef.current ? wsRef.current.readyState : WebSocket.CLOSED
    if (state === WebSocket.CONNECTING) return
    if (state === WebSocket.OPEN && !force) return
    if (state !== WebSocket.CLOSED) {
      // 旧连接的 onclose 会被代际守卫挡掉，断线善后在这里做：在飞命令挂起等重连，查询立即失败
      authedRef.current = false
      setAuthed(false)
      channel.disconnected()
      rejectQueries(new RelayError("offline", "连接已断开"))
    }
    backoffRef.current = 1000
    connect()
  }, [connect, channel])

  /** 验活：手机切后台、换网络后连接常常已经死了却没有 onclose。发个 ping，一段时间内什么都没收到就换连接 */
  const probe = useCallback(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !authedRef.current || probeTimerRef.current) return
    const sentAt = Date.now()
    try {
      ws.send(JSON.stringify({ type: "ping" }))
    } catch {
      reconnect(true)
      return
    }
    probeTimerRef.current = window.setTimeout(() => {
      probeTimerRef.current = null
      if (wsRef.current === ws && lastRxRef.current < sentAt) reconnect(true)
    }, PROBE_TIMEOUT_MS)
  }, [reconnect])

  useEffect(() => {
    if (!token) return
    stopRef.current = false
    connect()
    let pingAt = 0
    const ping = window.setInterval(() => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        pingAt = 0
        return
      }
      const visible = document.visibilityState === "visible"
      // 只在前台判死：后台计时器会被节流甚至冻结，回包晚到不代表连接死了
      if (visible && pingAt && authedRef.current && lastRxRef.current < pingAt) {
        pingAt = 0
        reconnect(true)
        return
      }
      ws.send(JSON.stringify({ type: "ping" }))
      pingAt = visible ? Date.now() : 0
    }, PING_INTERVAL_MS)
    // 切回前台、网络恢复、从往返缓存恢复：断着就立刻重连（不等最长 20s 的退避），开着就验活
    const wake = () => {
      if (document.visibilityState !== "visible") return
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) probe()
      else reconnect(false)
    }
    document.addEventListener("visibilitychange", wake)
    window.addEventListener("online", wake)
    window.addEventListener("pageshow", wake)
    return () => {
      stopRef.current = true
      window.clearInterval(ping)
      document.removeEventListener("visibilitychange", wake)
      window.removeEventListener("online", wake)
      window.removeEventListener("pageshow", wake)
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current)
      if (resyncTimerRef.current) window.clearTimeout(resyncTimerRef.current)
      resyncTimerRef.current = null
      if (probeTimerRef.current) window.clearTimeout(probeTimerRef.current)
      probeTimerRef.current = null
      // 主 effect 卸载：惰性发送 / 发送 ack / 会话清单补拉的定时器一并清掉，卸载后不再 setState
      clearLazyTimers()
      clearSendAckTimer()
      for (const timer of sessionRefreshTimersRef.current) window.clearTimeout(timer)
      sessionRefreshTimersRef.current.clear()
      setRetryAt(null)
      cancelOffline()
      channel.dispose("连接已关闭")
      rejectQueries(new RelayError("closed", "连接已关闭"))
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [token, connect, cancelOffline, channel, reconnect, probe, clearLazyTimers, clearSendAckTimer])

  const reconnectNow = useCallback(() => reconnect(false), [reconnect])

  const login = useCallback((value: string) => {
    const next = value.trim()
    if (!next) {
      setAuthError("请输入 viewerToken")
      return
    }
    safeStore.set("pi_remote_viewer_token", next)
    tokenRef.current = next
    setToken(next)
    setEverConnected(false)
    setAuthError("")
  }, [])

  /** 退出登录：忘掉这台浏览器保存的 token，断开连接、清空界面回到登录页 */
  const logout = useCallback(() => {
    safeStore.remove("pi_remote_viewer_token")
    // 管理员令牌同属这次登录的凭据：退出时一并忘掉（状态 + localStorage 存储键），
    // 否则下次打开页面会被静默读回、直接可用，退出登录等于没退（UI 中-2）
    setAdminToken("")
    tokenRef.current = ""
    authedRef.current = false
    setToken("")
    setAuthed(false)
    setEverConnected(false)
    setAuthError("")
    setStatus("未连接")
    setRetryAt(null)
    setRetryCount(0)
    setTrying(false)
    cancelLazySendRef.current(false)
    clearLazyTimers()
    clearRoom()
    dispatch({ type: "reset" })
    roomsRef.current = []
    setRooms([])
    // B-1：别房落定记录随名册一并作废（回执已由 clearRoom 清掉）
    roomTurnTrackerRef.current = emptyRoomTurnTracker()
    setRoomTurnEnds([])
    devicesRef.current = []
    setDevices([])
    deviceModeRef.current = false
    setDeviceMode(false)
    selectedDeviceRef.current = null
    setSelectedDeviceId(null)
    setNotice(null)
    lastRoomRef.current = ""
    setDraft("")
    // 会话正文缓存 / 历史补拉窗口 / 草稿基线都属于这次登录：退出登录一并清空（UI·relay 中-4）
    archivesRef.current.clear()
    setArchiveTick((n) => n + 1)
    historyCacheRef.current = null
    draftBaseRef.current = ""
    draftBaseOwnerRef.current = ""
    clearPendingImages()
    clearPendingFiles()
    setUsage(null)
    setModel("")
    setModelMeta({})
    setThinkingLevel("")
    // outbox 属于这次登录：退出时一并清掉，换 token 后不会把上一个账号排的消息发出去
    saveOutbox(outboxStorage(), EMPTY_OUTBOX)
    outboxRef.current = EMPTY_OUTBOX
    setOutboxState(EMPTY_OUTBOX)
  }, [clearPendingFiles, clearPendingImages, dispatch, setAdminToken])

  /** retryKey：从失败气泡点"重试"时传入那条气泡的 key，v4 下先摘掉它再发一条新的 */
  const sendText = useCallback(async (textOverride?: string, retryKey?: string) => {
    const text = (textOverride ?? draftRef.current).trim()
    const fromDraft = textOverride === undefined
    // P3-2：纯图片可发送——正文为空但输入条上有待发图片时放行（扩展侧走 content 数组送达）；
    // P3-4：纯引用同理放行。带覆盖文本的调用（重试等）仍按旧口径，空文本直接作罢。
    if (!text && !(fromDraft && (pendingImagesRef.current.length > 0 || pendingFilesRef.current.length > 0))) return
    // P3-4：引用 chip 在组装时展开为正文后的 @路径引用行（定版格式，见 mention.ts）；
    // 气泡与上线帧都用展开后的全文，重试带回的也是全文，不会二次展开。
    const attachedFiles = fromDraft ? [...pendingFilesRef.current] : []
    const wireText = expandMentionText(text, attachedFiles)
    // 点选但还没载入的会话：发送动作只排队，不在这里启动。真正加载发生在 queueLazySend。
    const lazy = lazySessionRef.current
    if (lazy && fromDraft) {
      if (lazySendRef.current) {
        setNotice({ text: "正在载入会话并发送，请稍候", tone: "warn", codes: ["progress"] })
        return
      }
      queueLazySendRef.current(lazy, wireText)
      if (attachedFiles.length) clearPendingFiles()
      return
    }
    if (!roomRef.current) {
      // 没有会话可排：断线时给离线提示，连着时提示先选会话；两种都把消息留在输入框
      setNotice({ text: authedRef.current ? "先在左侧选一个会话；消息保留在输入框。" : OFFLINE_SEND_COPY, tone: "warn" })
      return
    }
    // 从失败气泡重试：那条若是 outbox 回放失败的，outbox 里的条目一并撤掉（这次重发就是它的重试）
    const retryCid = retryKey ? bubbleCid(retryKey) : ""
    if (retryCid) commitOutbox({ type: "cancel", roomId: roomRef.current, cid: retryCid })
    // S5（P5.6）：断线 / 房间不在线 / 设备离线 / 浏览器断网时进本页 outbox，恢复后按顺序发出。
    // 刚恢复、outbox 还在回放时新发的也排到后面，不插队（outbox 为空时在线发送路径完全不变）。
    const offline = sendOffline()
    const backlog = outboxOf(outboxRef.current, roomRef.current).some((entry) => entry.status !== "failed")
    if (offline || backlog) {
      // 图片太大，不进 localStorage：带图的消息仍留在输入框
      if (fromDraft && pendingImagesRef.current.length > 0) {
        setNotice({ text: "离线时带图片的消息不能排队；消息保留在输入框，连上后再发送。", tone: "warn" })
        return
      }
      const roomId = roomRef.current
      const queuedCid = newCid()
      const next = commitOutbox({ type: "enqueue", roomId, cid: queuedCid, dedupeKey: newDedupeKey(), text: wireText, at: Date.now() })
      const queued = next ? outboxOf(next, roomId) : []
      if (!queued.some((entry) => entry.cid === queuedCid)) {
        // 存不进去（存储不可用 / 配额满 / 本会话已排满）：退回旧口径，不假装已排队
        setNotice({ text: OFFLINE_SEND_COPY, tone: "warn" })
        return
      }
      if (fromDraft) {
        // 同 tick 的第二次 Enter 读的是 ref：先同步清掉，否则同一句会入队两次
        draftRef.current = ""
        setDraft("")
      }
      if (attachedFiles.length) clearPendingFiles()
      if (retryKey) dispatch({ type: "drop", key: retryKey })
      if (offline) {
        const linkDown = !authedRef.current || navigator.onLine === false
        setNotice({
          text: `${linkDown ? "当前离线" : "本机未连接"}，已排队 ${queued.length} 条，${linkDown ? "恢复连接" : "上线"}后按顺序发送。`,
          tone: "warn",
        })
      }
      return
    }
    // 重试某条失败气泡只重发文字。输入条上的图只跟着从草稿发出的这一次。
    const attached = fromDraft ? [...pendingImagesRef.current] : []
    const ticket = imageTicket.current
    const filesTicketSnapshot = filesTicket.current
    const attachedPlan = planSendImages(attached)
    const images = attachedPlan.images
    if (attachedPlan.notice) setNotice({ text: attachedPlan.notice, tone: "warn" })

    // 先抢同步锁，再清草稿/出气泡：同 tick 的第二次 Enter 根本走不到这里之后。
    const cid = newCid()
    if (!sendLock.current.acquire(cid)) return
    noteLocalEchoCid(cid)
    setSendingSend(true)
    clearSendAckTimer()
    sendAckTimer.current = window.setTimeout(() => {
      sendAckTimer.current = null
      // 到点仍是我们这把锁才释放；晚到的 ack 不会清掉下一条消息的锁。
      if (!sendLock.current.release(cid)) return
      setSendingSend(false)
      setLastFailure({ retryable: true, text: wireText, at: Date.now() })
      setFailurePulse(true)
      pushNotice({
        level: "warning",
        title: "发送确认超时",
        body: "8 秒内没有收到确认，消息可能已送达；请看会话再决定是否重发。",
        dedupeKey: "composer.ack-timeout",
      })
    }, ACK_TIMEOUT_MS)

    if (fromDraft) setDraft("")
    // 气泡本身永远带本地 cid：旧 relay 没有 msg.cid 也能按 cid 标失败；上线帧里的 cid 只在服务端支持时带。
    if (retryKey) dispatch({ type: "drop", key: retryKey })
    dispatch(images ? { type: "echo", text: wireText, images, cid } : { type: "echo", text: wireText, cid })
    const wireCid = hasCap(serverRef.current, "msg.cid") ? cid : ""
    try {
      // S4 按输入卡上的投递方式（默认 auto）走 steer / follow_up；S1 空闲一律 prompt。
      // 丢包重发由命令通道凭 dedupeKey 完成，这里绝不再自己重发一次（否则消息会注入两遍）。
      const plan = deliveryPlan(sendModeRef.current, busyRef.current)
      const args: Record<string, unknown> = wireCid ? { message: wireText, cid: wireCid } : { message: wireText }
      if (images) args.images = images
      await commandSendRef.current(plan.command, args)
      if (sendLock.current.release(cid)) {
        clearSendAckTimer()
        setSendingSend(false)
        setLastFailure(null)
      }
      // 发送成功才清附图；期间用户新加/移除的图（ticket 变了）保持原样，
      // 但这次已经发出去的那几张仍然要摘掉，否则会留在输入条里被重复发送。
      if (attached.length) {
        if (imageTicket.current === ticket) clearPendingImages()
        else dropSentPendingImages(attached)
      }
      // 引用 chip 同口径：发送成功才清，期间新加的保留、已发的摘掉。
      if (attachedFiles.length) {
        if (filesTicket.current === filesTicketSnapshot) clearPendingFiles()
        else dropSentPendingFiles(attachedFiles)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "发送失败"
      const retryable = (error as { retryable?: boolean }).retryable !== false
      if (sendLock.current.release(cid)) {
        clearSendAckTimer()
        setSendingSend(false)
        setLastFailure({ retryable, text: wireText, at: Date.now() })
        setFailurePulse(true)
      }
      // 失败只进气泡：不摘气泡（drop:false）、不回写草稿、不把正文塞回输入框。附图仍留在输入条。
      dispatch({ type: "send-failed", cid, error: message, drop: false })
    }
  }, [bubbleCid, clearPendingFiles, clearPendingImages, clearSendAckTimer, commitOutbox, dispatch, dropSentPendingFiles, dropSentPendingImages, noteLocalEchoCid, pushNotice, sendOffline, setNotice])

  /**
   * outbox 回放（P5.6）：当前会话可发时，一条一条按入队顺序发，等上一条有结果再发下一条。
   * 每条只认领一次（queued → replaying），带入队时生成的 cid 和 dedupeKey：
   * 命令通道在同一 relay 进程内重发同一帧由 relay 按 dedupeKey 合并；relay 不按 cid 去重，
   * 所以 replaying 的条目绝不自动再发，失败后只有用户点重试（换新 cid）才会再上线。
   */
  const replayingOutboxRef = useRef(false)
  /** 帧没发出去（连接刚断等）后暂停回放，等连接相关状态变了再试，避免空转 */
  const outboxHoldRef = useRef(false)
  const replayOutbox = useCallback(async () => {
    if (replayingOutboxRef.current || outboxHoldRef.current) return
    replayingOutboxRef.current = true
    // 这一轮回放里已经用 prompt 开过回合：busy 要等 pi 的事件回来才变，紧跟着的下一条再按空闲发 prompt 会被扩展以
    // "会话正忙"拒掉（L3 L19：离线发 2 条，恢复后只到第 1 条）。之后的条目按忙时走 steer / follow_up（扩展空闲时照常直接投递）
    let startedTurn = false
    try {
      for (;;) {
        const roomId = roomRef.current
        if (!roomId || lazySessionRef.current || sendOffline()) return
        const storage = outboxStorage()
        const owner = outboxOwnerRef.current
        const entry: OutboxEntry | null = nextReplay(storage ? loadOutbox(storage) : outboxRef.current, roomId)
        if (!entry) return
        const claimed = commitOutbox({ type: "replay", roomId, cid: entry.cid, owner })
        // 认领必须落在本标签页名下：别的标签页同一窗口先认领（写入覆盖）时本页不再发同一条
        if (!claimed || !outboxClaimedBy(claimed, roomId, entry.cid, owner)) return
        // 再回读一次共享存储：另一个标签页刚刚覆盖了认领（仍能看到这条 replaying）就放弃，
        // 把跨标签页的重复窗口缩到"两次写之间"这一极窄区间；写失败（读不到条目）仍按本页认领继续。
        if (storage) {
          const persisted = loadOutbox(storage)
          const storedEntry = outboxOf(persisted, roomId).find((item) => item.cid === entry.cid)
          if (storedEntry && !outboxClaimedBy(persisted, roomId, entry.cid, owner)) return
        }
        noteLocalEchoCid(entry.cid)
        dispatch({ type: "echo", text: entry.text, cid: entry.cid })
        const plan = deliveryPlan(sendModeRef.current, busyRef.current || startedTurn)
        const args: Record<string, unknown> = hasCap(serverRef.current, "msg.cid") ? { message: entry.text, cid: entry.cid } : { message: entry.text }
        try {
          await channel.command(roomId, plan.command, args, lostMessageFor(plan.command), entry.dedupeKey)
          if (plan.command === "prompt") startedTurn = true
          commitOutbox({ type: "sent", roomId, cid: entry.cid, owner })
        } catch (error) {
          const code = errorCode(error)
          if (OUTBOX_REQUEUE_CODES.has(code)) {
            // 没送到 pi：原样放回队首，等连接 / 设备状态变化后再回放
            commitOutbox({ type: "requeue", roomId, cid: entry.cid, owner })
            dispatch({ type: "send-failed", cid: entry.cid, error: "", drop: true })
            outboxHoldRef.current = true
            return
          }
          const message = error instanceof Error ? error.message : "发送失败"
          commitOutbox({ type: "fail", roomId, cid: entry.cid, error: message, unknown: code === "result_unknown" || code === "closed", owner })
          dispatch({ type: "send-failed", cid: entry.cid, error: message, drop: false })
        }
      }
    } finally {
      replayingOutboxRef.current = false
    }
  }, [channel, commitOutbox, dispatch, noteLocalEchoCid, sendOffline])
  // 连接、房间、设备、浏览器联网任一变化：解除暂停（effect 按声明顺序执行，先于下面的回放）
  useEffect(() => {
    outboxHoldRef.current = false
  }, [authed, online, roomId, devices, selectedDeviceId, deviceMode, browserOnline, lazySession])
  useEffect(() => {
    void replayOutbox()
  }, [authed, online, roomId, devices, selectedDeviceId, deviceMode, browserOnline, lazySession, outboxState, replayOutbox])

  /** 排队面板"取消"：queued / failed 可取消，正在发的不能 */
  const outboxCancel = useCallback((cid: string) => {
    const roomId = roomRef.current
    if (!roomId) return
    const next = commitOutbox({ type: "cancel", roomId, cid })
    if (next && !outboxOf(next, roomId).some((entry) => entry.cid === cid)) dropFailedBubble(cid)
  }, [commitOutbox, dropFailedBubble])
  /** 排队面板"重试"：failed → queued，换新 cid + dedupeKey（等同重新发一条），可发时立即回放 */
  const outboxRetry = useCallback((cid: string) => {
    const roomId = roomRef.current
    if (!roomId) return
    const next = commitOutbox({ type: "retry", roomId, cid, nextCid: newCid(), nextDedupeKey: newDedupeKey() })
    if (next && !outboxOf(next, roomId).some((entry) => entry.cid === cid)) dropFailedBubble(cid)
  }, [commitOutbox, dropFailedBubble])
  const outbox = useMemo(() => outboxOf(outboxState, roomId), [outboxState, roomId])

  const abort = useCallback(async () => {
    if (!roomRef.current) return
    // 主动中断不是“助手回合完成”：锁掉本次完成信号，等下一轮 agent_start 再解锁
    turnActiveRef.current = false
    turnEmittedRef.current = true
    turnErrorRef.current = false
    setBusy(false)
    setActivity("")
    try {
      await commandSendRef.current("abort")
    } catch (error) {
      const message = error instanceof Error ? error.message : ""
      const code = errorCode(error)
      // 旧扩展没有 abort 命令：退回 relay 的 abort 帧（中断是幂等的）。
      // 认错误码；只有不带错误码的旧 relay 才按文案认
      if (code === "unknown_command" || (!hasCap(serverRef.current, "err.v4") && /未知命令/.test(message))) {
        void channel.raw({ type: "abort", room: roomRef.current }).catch(() => {})
        return
      }
      if (message && code !== "no_room") setNotice({ text: message, tone: "bad" })
    }
  }, [channel])

  const notify = useCallback((text: string, tone: "warn" | "bad" = "warn") => {
    if (!text) setNotice(null)
    else setNotice({ text, tone })
  }, [setNotice])

  /**
   * fork 之后把分叉消息放回输入框。
   * originRoom 是发起命令时的房间：
   *  - 新房已经抢先订阅完成（roomRef 已变）→ 直接写草稿；
   *  - 还没订阅 → 先挂起，等 subscribe 清空旧草稿后按新房间草稿补上。
   * 这样命令回包和 room_list 无论谁先到，都不会把回填内容清掉。
   * notice 跟着回填一起出现；room_list 随后还会写“已切换到…”，所以订阅路径要等这一轮结束再压一次。
   */
  const restoreDraftAfterSwitch = useCallback((originRoom: string, text: string, notice = "") => {
    if (!text) return
    const show = () => {
      if (notice) setNotice({ text: notice, tone: "warn" })
    }
    if (roomRef.current !== originRoom) {
      setDraft(text)
      show()
      return
    }
    pendingBackfillRef.current = { text, notice }
  }, [])

  const runCommand = useCallback(async (command: string, args?: Record<string, unknown>) => {
    const switchesRoom = SWITCH_COMMANDS.has(command)
    if (lazySessionRef.current) throw new RelayError("not_loaded", "先发送一条消息载入这个会话")
    if (rosterActive({ deviceMode: deviceModeRef.current, devices: devicesRef.current, rooms: roomsRef.current })) {
      const device = devicesRef.current.find((item) => item.id === selectedDeviceRef.current)
      if (!device?.online) throw new RelayError("device_offline", COPY.deviceOffline)
    }
    if (!roomRef.current) throw new RelayError("no_room", "先选一个会话")
    if (!onlineRef.current) throw new RelayError("room_offline", "这个会话已结束，无法执行")
    // 预期目标只对"会换房间"的命令有效，且必须在前置校验通过之后记录：
    // delete_session 也带 sessionPath，提前记下会让 clearRoom 守卫长期失效、界面卡在"正在切换会话…"
    if (switchesRoom && args && typeof args.sessionPath === "string") {
      expectedSessionFile.current = String(args.sessionPath).replace(/\\/g, "/")
    }
    if (switchesRoom) {
      const ticket = ++switchTicketRef.current
      pendingSwitchRef.current = true
      window.setTimeout(() => {
        if (switchTicketRef.current === ticket) pendingSwitchRef.current = false
      }, 20000)
    }
    // 超时不再由前端猜：relay 受理时回 command_accepted.timeoutMs（compact/regenerate 等长命令更长），
    // 命令通道按它重设计时器；丢包重发凭 dedupeKey 在 relay 侧合并/回放，不会重复执行。
    const lostMessage = lostMessageFor(command)
    let data: unknown
    try {
      data = await channel.command(roomRef.current, command, args, lostMessage)
    } catch (error) {
      // 没等到回应、断线后取不回结果：命令可能已经执行，切换类命令的预期目标要留着
      const unknownOutcome = errorCode(error) === "result_unknown"
      if (switchesRoom && !unknownOutcome) {
        pendingSwitchRef.current = false
        expectedSessionFile.current = null
      }
      if (command === "navigate_tree" && !unknownOutcome) expectedSessionFile.current = null
      throw error
    }
    if (command === "set_model" && data && typeof data === "object") {
      const meta = modelMetaFrom((data as { model?: unknown }).model)
      if (meta) {
        setModel(meta.name || meta.modelId || "")
        setModelMeta((prev) => mergeModelMeta(prev, meta))
      }
    }
    if (command === "set_thinking_level" && data && typeof data === "object") {
      const level = (data as { level?: string }).level
      if (level) setThinkingLevel(level)
    }
    if (command === "get_state" && data && typeof data === "object") {
      const st = data as { model?: unknown; thinkingLevel?: string }
      const meta = modelMetaFrom(st.model)
      if (meta) {
        setModel(meta.name || meta.modelId || "")
        setModelMeta((prev) => mergeModelMeta(prev, meta))
      }
      if (typeof st.thinkingLevel === "string" && st.thinkingLevel) setThinkingLevel(st.thinkingLevel)
    }
    if (command === "delete_session" || command === "fork" || command === "clone" || command === "switch_session") {
      const deviceId = selectedDeviceRef.current
      if (deviceId) loadSessionsRef.current(deviceId)
    }
    if ((command === "set_session_name" || command === "get_state") && data && typeof data === "object") {
      const name = command === "set_session_name" ? args?.name : (data as { sessionName?: unknown }).sessionName
      if (typeof name === "string" && name) {
        setRooms((list) => list.map((room) => (room.id === roomRef.current ? { ...room, label: name } : room)))
      }
    }
    return data
  }, [channel])

  useEffect(() => {
    commandSendRef.current = runCommand
  }, [runCommand])

  /** 把一份完整的 remote_queue_state / queue_get 结果落到本地，并同步乐观气泡的正文。
   *  事件与命令回包同源；重复应用是幂等的。 */
  const applyRemoteQueueSnapshot = useCallback((next: RemoteQueueState) => {
    remoteQueueRef.current = next
    setRemoteQueueState(next)
    // queue_get 回包同样只在命中本页乐观气泡时才需要进 reducer（避免全表扫转录）
    if (hasLocalQueueCid(next.items)) dispatch({ type: "queue-sync", items: next.items })
  }, [dispatch, hasLocalQueueCid])

  /**
   * queue_get：relay 已按房间缓存并在订阅时补发，这里只给"手动刷新/补偿"用。
   * 离线或还没选房间时直接返回 null，不发注定失败的请求。
   */
  const refreshRemoteQueue = useCallback(async () => {
    if (!roomRef.current || !onlineRef.current) return null
    const data = await runCommand("queue_get")
    const next = parseRemoteQueueState(data)
    if (next) applyRemoteQueueSnapshot(next)
    return data
  }, [applyRemoteQueueSnapshot, runCommand])

  /** queue_get 单条全文（R3-3 第 1 项）：编辑被投影截断的待发条目时按 id 拉全文。
   *  一次性回包，不落本地队列状态（全文不进状态帧/补发缓存的口径在扩展侧）。
   *  回包仍带 truncated 或形状不全 → 明确抛错，由卡片呈只读诚实态。
   *  返回 { text, textHash }：textHash 是这份全文的版本指纹，卡片拿它当缓存基线
   *  与保存时的 baseHash（C-2/C-8）；老扩展回包没指纹时为 undefined。 */
  const queueFetchFullText = useCallback(async (id: string) => {
    const target = String(id || "").trim()
    if (!target) throw new RelayError("bad_args", "待发消息 id 为空")
    const data = await runCommand("queue_get", { id: target, full: true })
    const item = isRecord(data) ? parseRemoteQueueItem(data.item) : null
    if (!item) throw new RelayError("internal", "全文拉取回包不完整")
    if (item.truncated) throw new RelayError("payload_too_large", "回包仍是截断文本，未能取得全文")
    return { text: item.text, textHash: item.textHash }
  }, [runCommand])

  /** queue_edit：只改 pending 的正文，扩展侧保 id/段位/图片/位次。
   *  baseHash（C-8）：编辑开始时的全文指纹，带上后扩展比对现值，不符回 queue_conflict
   *  而不是无声覆盖他端的修改；不带（老卡片/无指纹）则不校验。 */
  const queueEdit = useCallback(async (id: string, text: string, baseHash?: string) => {
    const target = String(id || "").trim()
    if (!target) throw new RelayError("bad_args", "待发消息 id 为空")
    if (!String(text || "").trim()) throw new RelayError("bad_args", "待发消息不能为空")
    return runCommand("queue_edit", { id: target, text, ...(baseHash ? { baseHash } : {}) })
  }, [runCommand])

  /** queue_send：用户明确点“立即发送”，不等回合边界；原段位是 follow_up 也按 steer 立即送达。 */
  const queueSendNow = useCallback(async (id: string, interrupt = true) => {
    const target = String(id || "").trim()
    if (!target) throw new RelayError("bad_args", "待发消息 id 为空")
    return runCommand("queue_send", { id: target, interrupt })
  }, [runCommand])

  /** queue_cancel：命令成功后把发送方的乐观气泡一并撤掉；别人删的由 queue-sync 终态兜底。 */
  const queueCancel = useCallback(async (id: string) => {
    const target = String(id || "").trim()
    if (!target) throw new RelayError("bad_args", "待发消息 id 为空")
    const item = remoteQueueRef.current.items.find((entry) => entry.id === target)
    const data = await runCommand("queue_cancel", { id: target })
    if (item?.cid) dispatch({ type: "queue-drop", cid: item.cid })
    return data
  }, [dispatch, runCommand])

  /** 切换选择/设备/主动放弃时调用：队列立刻作废，旧启动即使完成也不自动打开、不发送。 */
  const cancelLazySend = useCallback((_restore = false) => {
    const current = lazySendRef.current
    if (!current) return
    clearLazyTimers()
    setLazySend(stepLazySend(current, { type: "cancelled" }).send)
    suppressStartedRoom(`${current.deviceId}:${current.sessionId}`)
    // 用户主动切走：这次启动还没提交消息，连 pending/arming 一起清掉，别在列表里留一个幽灵“启动中”。
    // 已经进入 sending 的命令不能撤回，交给命令通道自己结案。
    if (current.phase !== "sending") clearPendingRef.current(current.deviceId)
  }, [clearLazyTimers, setLazySend, suppressStartedRoom])

  /** 启动/等待失败：只把失败留在气泡里，不把正文/图回写输入框（第 5 章 5.2.4）。 */
  const failLazySend = useCallback((error: string, _restore = true) => {
    const current = lazySendRef.current
    if (!current) return
    clearLazyTimers()
    setLazySend(stepLazySend(current, { type: "failed" }).send)
    // 房间可能过一会儿才起来：别让它弹回主区
    suppressStartedRoom(`${current.deviceId}:${current.sessionId}`)
    if (current.phase !== "sending" && lazyAcceptedRef.current === current.token) clearPendingRef.current(current.deviceId)
    if (current.cid) dispatch({ type: "send-failed", cid: current.cid, error: error || "发送失败", drop: false })
    // 启动/等待失败时消息可能还没进会话；错误不能静默消失。发送命令本身的失败仍只留气泡。
    if (error && current.phase !== "sending") setNotice({ text: error, tone: "bad" })
  }, [clearLazyTimers, setLazySend, dispatch, suppressStartedRoom])

  useEffect(() => {
    failLazySendRef.current = failLazySend
    cancelLazySendRef.current = cancelLazySend
  }, [failLazySend, cancelLazySend])

  /** 点选未载入的会话：只换本地选择，不调用 harness_start、不订阅。 */
  const selectListedSession = useCallback((row: ListedSession) => {
    const device = devicesRef.current.find((item) => item.id === selectedDeviceRef.current)
    if (!device?.online) {
      setNotice({ text: COPY.deviceOffline, tone: "bad" })
      return
    }
    const selected = lazySessionRef.current
    if (selected?.id === row.id && selected.deviceId === device.id) return
    cancelLazySend(false)
    clearLazyTimers()
    const selection: LazySelection = { ...row, deviceId: device.id }
    setLazySelection(selection)
    setSelectionNonce((n) => n + 1)
    // 从真实房间切走：先退订，别让旧房间的事件继续进 onmessage
    const ws = wsRef.current
    if (roomRef.current && ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: "unsubscribe" })) } catch {}
    }
    roomRef.current = ""
    syncRef.current = emptySync()
    lastRoomRef.current = ""
    expectedSessionFile.current = null
    pendingSwitchRef.current = false
    safeStore.session.remove("pi_room")
    setRoomId(row.id)
    // 合成房间的 online：让输入条可用；真正的 device.online 由 composerGate 再校验一次
    setOnline(true)
    setRoomDown(false)
    setBusy(false)
    busyRef.current = false
    setActivity("")
    setSnapshotPending(false)
    setModel("")
    setModelMeta({})
    setThinkingLevel("")
    setQueue({ steering: [], followUp: [] })
    remoteQueueRef.current = emptyRemoteQueue()
    setRemoteQueueState(remoteQueueRef.current)
    setTaskList([])
    // 只点选未载入的会话也是一次换房：上一条房间的终端/子智能体条目不能跟着走。
    resetTerminals()
    setAgentState([])
    setUiPrompt(null)
    setDialogs([])
    setExtStatus(null)
    resetTurn()
    setTurnEnd(null)
    // B-2：点选未载入会话同样是换房，旧房的拒绝回执不清会跟着走
    setDialogReceipts([])
    setNotice(null)
    setUsage(null)
    // 草稿落盘（P3-3）：点选未载入会话也是一次换房——旧房先存、目标会话恢复自己的落盘草稿。
    persistDraftNow()
    draftOwnerRef.current = row.id
    draftHydratedRef.current = true
    setDraft(readRoomDraft(row.id))
    clearPendingImages()
    clearPendingFiles()
    resetSendState()
    dispatch({ type: "reset" })
  }, [cancelLazySend, clearLazyTimers, clearPendingFiles, clearPendingImages, resetSendState, setLazySelection, dispatch, resetTerminals])

  const selectRoom = useCallback((id: string) => {
    // 点“未载入会话”的合成 tab/行时不要把它当成真实房间去订阅
    if (lazySessionRef.current?.id === id) return
    subscribeRef.current(id, true)
  }, [])

  const runDeviceCommand = useCallback(async (deviceId: string, command: string, args?: Record<string, unknown>) => {
    const harness = command === "harness_start"
    const timeout = harness ? HARNESS_START_TIMEOUT_MS : DEVICE_COMMAND_TIMEOUT_MS
    const lost = harness ? COPY.requestTimeout : "命令没有回应"
    return channel.deviceCommand(deviceId, command, args, timeout, lost)
  }, [channel])

  /** P9 C（spec §5.5）：列一台设备允许浏览范围内的子文件夹（命令 list_dirs，attach 声明 fs.browse 才支持）。
   *  只返回目录名和路径，不返回文件、也不传文件内容。不带 path 时用第一个浏览根目录（默认是设备用户的家目录）；
   *  回包按协议清洗（只收非空 name/path，最多 500 条）。旧 attach 会回 device_update_required。 */
  const listDirs = useCallback(async (deviceId: string, path?: string, showHidden?: boolean): Promise<DirListResult> => {
    if (!authedRef.current) throw new RelayError("offline", "连接已断开，稍后再试")
    const args: Record<string, unknown> = {}
    if (path) args.path = path
    if (showHidden === true) args.showHidden = true
    const result = parseDirList(await runDeviceCommand(deviceId, "list_dirs", args))
    if (!result.path) throw new RelayError("bad_reply", "设备没有返回目录内容")
    return result
  }, [runDeviceCommand])

  /** 未载入会话的文件级操作只走设备名册（需要 deviceId + 路径）；旧 relay 没有这条通道。 */
  const requireFileDevice = useCallback((): string => {
    if (!deviceModeRef.current) throw new RelayError("unsupported", "当前服务端不支持未载入会话的文件操作（需要设备名册）")
    // 这里看“连接是否已认证”，不是当前房间是否在线：未载入会话本来就没有房间。
    if (!authedRef.current) throw new RelayError("offline", "连接已断开，稍后再试")
    const deviceId = selectedDeviceRef.current
    if (!deviceId) throw new RelayError("no_device", COPY.noDevice)
    const device = devicesRef.current.find((item) => item.id === deviceId)
    if (!device?.online) throw new RelayError("device_offline", COPY.deviceOffline)
    return deviceId
  }, [])

  /** 把扩展回包里的 session 行立刻并进清单（manifest 到达前也能看到改名/冷 fork 的结果）。 */
  const upsertSessionRow = useCallback((deviceId: string, row: SessionEntry | null) => {
    if (!row) return
    // B1：写文件类命令（改名 / 冷 fork）的回包也可能晚于 purge 落地；已 purge 的会话不写回清单
    if (purgedIdsOf(purgedSessionsRef.current, deviceId)?.has(row.id)) return
    setSessionsByDevice((prev) => {
      const list = prev[deviceId] || []
      const next = list.some((item) => item.id === row.id) ? list.map((item) => (item.id === row.id ? row : item)) : [...list, row]
      next.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      return { ...prev, [deviceId]: next }
    })
  }, [])

  // 扩展会在写文件后立刻发增量 manifest；稍后补拉一次，让 relay 索引与前端清单完全对齐。
  const refreshSessionsSoon = useCallback((deviceId: string) => {
    const timer = window.setTimeout(() => {
      sessionRefreshTimersRef.current.delete(timer)
      if (selectedDeviceRef.current === deviceId) loadSessionsRef.current(deviceId)
    }, 800)
    sessionRefreshTimersRef.current.add(timer)
  }, [])

  /** 删除会话文件（P8 R25）：发给和目标同目录的在线房间（SessionMenuContainer 用 model/sessionMenu.ts 的 sessionDeleteRouteOf 选，
   *  不一定是当前房间）。扩展只删回答它的那个 pi 自己会话目录里的文件（pi 的会话目录按 cwd 分），所以不能像 runCommand 那样固定发给当前房间。
   *  扩展确认删掉以后：清单里去掉这一行并稍后补拉；在 localStorage 记下会话 id，它的离线房间从名册里去掉（deletedSessions.ts）。
   *  扩展的拒绝原样上抛（带协议码），由呈现层改写文案。 */
  const deleteSessionFile = useCallback(async ({ sessionId, sessionPath, roomId }: { sessionId: string; sessionPath: string; roomId: string }) => {
    const target = typeof sessionPath === "string" ? sessionPath.trim() : ""
    if (!target) throw new RelayError("bad_args", "缺少会话路径")
    if (!authedRef.current) throw new RelayError("offline", "连接已断开，稍后再试")
    const room = roomId ? roomsRef.current.find((item) => item.id === roomId) : undefined
    if (!room?.online) throw new RelayError("room_offline", "这个项目里的 pi 已经不在运行了")
    const data = await channel.command(room.id, "delete_session", { sessionPath: target }, COPY.requestTimeout)
    // 扩展删完文件才合并发增量 manifest（MANIFEST_COALESCE_MS 之后），马上拉清单可能还是旧的：
    // 先在本地去掉这一行（同改名 / 冷 fork 的 upsertSessionRow），再稍后补拉一次和 relay 索引对齐
    const deviceId = roomDeviceId(room)
    const gone = target.replace(/\\/g, "/")
    setSessionsByDevice((prev) => {
      const list = prev[deviceId]
      if (!list) return prev
      return { ...prev, [deviceId]: list.filter((item) => String(item.path || "").replace(/\\/g, "/") !== gone) }
    })
    // relay 会把这个会话的离线房间在名册里留到驱逐（默认 6 小时），不记下的话它会以 pi 的标签回到侧栏
    const rest = withoutDeletedRooms(roomsRef.current, rememberDeletedSession(deletedStorage(), sessionId, Date.now()), roomRef.current || null)
    if (rest !== roomsRef.current) {
      roomsRef.current = rest
      setRooms(rest)
    }
    window.setTimeout(() => loadSessionsRef.current(deviceId), 800)
    return data
  }, [channel])

  /**
   * 删除会话（P9 B，F-R7）：relay 有 session.purge 能力时走设备级 delete_session——设备确认删除
   * 成功后 relay 清掉全部副本并广播 session_removed，本页的清单 / 名册 / 正文缓存由那个帧改，
   * 这里不手删、也不写 localStorage 隐藏表（D6）。旧 relay / 没有该能力时退回 R25 的
   * deleteSessionFile（同目录在线房间 + 本地隐藏表），行为不变。
   * 设备级命令的等待上限用 DEVICE_COMMAND_TIMEOUT_MS（relay 受理后按它自己的 timeoutMs 重计时）。
   */
  const deleteSession = useCallback(
    async ({ deviceId, sessionId, sessionPath, roomId }: { deviceId: string; sessionId: string; sessionPath: string; roomId: string }) => {
      const id = typeof sessionId === "string" ? sessionId.trim() : ""
      if (!id) throw new RelayError("bad_args", "缺少会话 id")
      if (!authedRef.current) throw new RelayError("offline", "连接已断开，稍后再试")
      if (hasCap(serverRef.current, "session.purge")) {
        const target = typeof deviceId === "string" ? deviceId.trim() : ""
        if (!target) throw new RelayError("bad_args", "缺少设备 id")
        const data = await channel.deviceCommand(target, "delete_session", { sessionId: id }, DEVICE_COMMAND_TIMEOUT_MS, COPY.requestTimeout)
        // data = { status: "deleted" | "already_deleted", method: "trash" | "unlink" | null }
        return (data && typeof data === "object" ? data : {}) as { status?: string; method?: string | null }
      }
      await deleteSessionFile({ sessionId: id, sessionPath, roomId })
      return { status: "deleted", method: null } as { status?: string; method?: string | null }
    },
    [channel, deleteSessionFile],
  )

  // 别的标签页删了会话（deletedSessions.ts 的记录变了）：这一页的名册和手里的会话清单马上跟着去掉，不等下一份 room_list / get_sessions
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== DELETED_SESSIONS_KEY && event.key !== null) return
      const deleted = readDeletedSessions(deletedStorage(), Date.now())
      const rest = withoutDeletedRooms(roomsRef.current, deleted, roomRef.current || null)
      if (rest !== roomsRef.current) {
        roomsRef.current = rest
        setRooms(rest)
      }
      setSessionsByDevice((prev) => {
        let changed = false
        const next: typeof prev = {}
        for (const [deviceId, list] of Object.entries(prev)) {
          const kept = list ? withoutDeletedSessions(list, deleted) : list
          if (kept !== list) changed = true
          next[deviceId] = kept
        }
        return changed ? next : prev
      })
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  /** 未载入会话改名：直接追加目标 .jsonl 的 session_info，不要求先载入。 */
  const renameSessionFile = useCallback(async (sessionPath: string, name: string) => {
    const target = typeof sessionPath === "string" ? sessionPath.trim() : ""
    const next = typeof name === "string" ? name.trim() : ""
    if (!target) throw new RelayError("bad_args", "缺少会话路径")
    if (!next) throw new RelayError("bad_args", "会话名不能为空")
    const deviceId = requireFileDevice()
    const data = await runDeviceCommand(deviceId, "rename_session_file", { sessionPath: target, name: next })
    const rec = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {}
    const actual = typeof rec.name === "string" && rec.name ? rec.name : next
    const changedId = typeof rec.id === "string" ? rec.id : ""
    const row = sessionFileRow(rec.session)
    if (row) upsertSessionRow(deviceId, { ...row, name: actual })
    else {
      setSessionsByDevice((prev) => {
        const list = prev[deviceId]
        if (!list) return prev
        const norm = (value: string) => value.replace(/\\/g, "/")
        return { ...prev, [deviceId]: list.map((item) => (item.id === changedId || norm(item.path) === norm(target) ? { ...item, name: actual, updatedAt: Date.now() } : item)) }
      })
    }
    setRooms((list) => list.map((room) => (room.id === changedId ? { ...room, label: actual, name: actual } : room)))
    refreshSessionsSoon(deviceId)
    return data
  }, [refreshSessionsSoon, requireFileDevice, runDeviceCommand, upsertSessionRow])

  /** 未载入会话导出：直接读目标文件，返回完整 JSONL/文本（超限由扩展报明确错误）。 */
  const exportSessionFile = useCallback(async (sessionPath: string, format: "text" | "jsonl" = "text") => {
    const target = typeof sessionPath === "string" ? sessionPath.trim() : ""
    if (!target) throw new RelayError("bad_args", "缺少会话路径")
    const deviceId = requireFileDevice()
    return runDeviceCommand(deviceId, "export_session_file", { sessionPath: target, format })
  }, [requireFileDevice, runDeviceCommand])

  /** 冷 fork：本机无头打开目标文件并落一个新会话，不启动 pi 进程。 */
  const forkSessionFile = useCallback(async (sessionPath: string) => {
    const target = typeof sessionPath === "string" ? sessionPath.trim() : ""
    if (!target) throw new RelayError("bad_args", "缺少会话路径")
    const deviceId = requireFileDevice()
    const data = await runDeviceCommand(deviceId, "fork_session_file", { sessionPath: target })
    const rec = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {}
    upsertSessionRow(deviceId, sessionFileRow(rec.session))
    refreshSessionsSoon(deviceId)
    return data
  }, [refreshSessionsSoon, requireFileDevice, runDeviceCommand, upsertSessionRow])

  /** 会话正文搜索（R4-2）：只读命令，宿主侧扫会话 .jsonl 正文；回包交呈现层归一。
   *  离线 / 无活动会话 / 超时等失败由 relay 与命令通道带协议码上抛，UI 按码分诚实态呈现。
   *  F-R6 → P8 8.1b：扩展只扫回答它的那个 pi 所在项目的会话目录（pi 的会话目录按 cwd 分），按 deviceId 寻址时 relay
   *  只交给这台设备最后上线的那个房间。所以选中设备的在线房间每个 cwd 选一个，按房间并发发命令，回包按会话文件路径
   *  合并去重；有房间超时或失败时页上带 unanswered（部分结果），全部失败按第一个失败报错（relay/bodySearch.ts）。
   *  连接没认证或这台设备没有在线房间时，才按设备寻址（原来的退路）。 */
  const searchSessionBodies = useCallback(
    async (query: string) => {
      const deviceId = selectedDeviceRef.current
      if (!deviceId) throw new RelayError("no_device", COPY.noDevice)
      const targets = bodySearchTargetsOf(deviceId, authedRef.current ? roomsRef.current : [], roomRef.current)
      const roomTargets = targets.flatMap((target) => (target.kind === "room" ? [target] : []))
      if (!roomTargets.length) return runDeviceCommand(deviceId, "search_session_bodies", { query })
      const settled = await Promise.allSettled(
        roomTargets.map((target) => channel.command(target.roomId, "search_session_bodies", { query }, "命令没有回应")),
      )
      const merged = mergeBodySearchReplies(
        query,
        settled.map((result, i): BodySearchReply =>
          result.status === "fulfilled"
            ? { target: roomTargets[i], ok: true, data: result.value }
            : { target: roomTargets[i], ok: false, error: result.reason },
        ),
      )
      if (!merged.ok) throw merged.error
      return merged.page
    },
    [channel, runDeviceCommand],
  )

  const sessionNameForPath = useCallback((target: string): string => {
    const deviceId = selectedDeviceRef.current
    if (!deviceId) return ""
    const want = String(target || "").replace(/\\/g, "/")
    const hit = (sessionsByDevice[deviceId] || []).find((item) => String(item.path || "").replace(/\\/g, "/") === want)
    return hit?.name || ""
  }, [sessionsByDevice])

  /**
   * get_file（P1 §10）：按当前会话 cwd 解析相对路径，回包原样交给 FileViewer 归约。
   * 空路径在本地直接拒绝，绝不发一个“读目录”的请求；不提供列目录 API。
   */
  /** P11：上行移动导航偏好（prefs-sync additive，只发 mobileNav 单字段；旧 relay / 未认证时返回 false 不影响本地）。 */
  const pushMobileNav = useCallback((mode: PiMobileNavMode): boolean => {
    if (mode !== "list" && mode !== "drawer") return false
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !authedRef.current) return false
    const caps = serverRef.current && serverRef.current.caps
    if (Array.isArray(caps) && caps.length > 0 && !caps.includes("prefs.sync")) return false
    try {
      ws.send(JSON.stringify({ type: "prefs_set", subset: { mobileNav: mode } }))
      return true
    } catch {
      return false
    }
  }, [])

  /** P10 使用活动：向 relay 请求某设备的 usage.activity.v1 快照（无连接/超时/旧 relay 回诚实空态）。 */
  const usageRequestSeq = useRef(0)
  const getUsage = useCallback((deviceId: string, opts: { force?: boolean } = {}): Promise<UsageSnapshotFrame> => {
    const target = typeof deviceId === "string" ? deviceId.trim() : ""
    const unavailable = (reason: UsageSnapshotFrame["reason"]): UsageSnapshotFrame => ({ type: "usage_snapshot", deviceId: target, available: false, reason })
    if (!target) return Promise.resolve(unavailable("no_data"))
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(unavailable("device_offline"))
    const requestId = "u" + (++usageRequestSeq.current) + "_" + Math.random().toString(36).slice(2, 8)
    return new Promise<UsageSnapshotFrame>((resolve) => {
      const timer = window.setTimeout(() => {
        queriesRef.current.delete(requestId)
        resolve(unavailable("timeout"))
      }, 12000)
      queriesRef.current.set(requestId, {
        resolve: (msg) => resolve(msg as unknown as UsageSnapshotFrame),
        reject: () => resolve(unavailable("unsupported")),
        timer,
      })
      try {
        ws.send(JSON.stringify({ type: "usage_get", deviceId: target, requestId, ...(opts.force === true ? { force: true } : null) }))
      } catch {
        window.clearTimeout(timer)
        queriesRef.current.delete(requestId)
        resolve(unavailable("device_offline"))
      }
    })
  }, [])

  const getFile = useCallback(async (path: string) => {
    const target = typeof path === "string" ? path.trim() : ""
    if (!target) throw new RelayError("path_required", "请输入文件路径")
    return runCommand("get_file", { path: target })
  }, [runCommand])

  /**
   * get_image（按需补拉 omit 图片）：entryId + blockIndex 必须来自投影/历史，缺一个就在本地拒绝，
   * 不按消息内容猜位置。后端会绕过 128KB 降级读原图；超单帧上限时回 compressed 占位。
   */
  const getImage = useCallback(async (entryId: string, blockIndex: number) => {
    const id = typeof entryId === "string" ? entryId.trim() : ""
    if (!id) throw new RelayError("bad_args", "缺少图片定位信息（entryId）")
    if (!Number.isInteger(blockIndex) || blockIndex < 0) throw new RelayError("bad_args", "图片位置无效（blockIndex）")
    return runCommand("get_image", { entryId: id, blockIndex })
  }, [runCommand])

  // Lightbox 不经过 props 链拿 relay：注册当前会话的按需加载通道，卸载/换 relay 时注销。
  useEffect(() => {
    return setRemoteImageLoader((ref) => getImage(ref.entryId, ref.blockIndex))
  }, [getImage])

  /**
   * 历史补拉（R2-5 / P3-7）：沿活动分支往旧翻一页，前置并入转录。
   * 游标对齐（history.ts 头注）：get_entries 的 since 是向新语义，撑不起往旧翻页，
   * 改走 limit 尾窗 + parentId 分支链 + 指纹首锚；协议 / 扩展 / relay 零改动。
   * 客户端窗口缓存（UI·relay 中-5）：已下载的条目按 entryId/下标复用，缓存覆盖目标窗口时
   * 零请求切页；真要补拉时向前多留一段 margin，「加载更早」不再每页重下已加载的全部条目。
   * 在途去重（连点不重复发）；全量快照落地会让在飞结果作废；补拉只动转录头部，
   * 补拉期间到达的实时消息照常落尾、不乱序。返回 true = 本页已并入
   * （parts 据此扩渲染窗并锚定滚动位置）。
   */
  const loadEarlierHistory = useCallback(async (): Promise<boolean> => {
    const room = roomRef.current
    if (!room || historyFlightRef.current) return false
    const hs = historyRef.current
    if (hs.room !== room || (hs.status !== "more" && hs.status !== "error")) return false
    historyFlightRef.current = true
    const gen = historyGenRef.current
    applyHistory({ status: "loading", error: "" })
    const alive = () => roomRef.current === room && historyGenRef.current === gen
    /** 客户端窗口缓存：只对当前房间有效；换房/全量快照时已由别处清空。 */
    let cache: HistoryCache | null = historyCacheRef.current && historyCacheRef.current.room === room ? historyCacheRef.current : null
    const remember = (page: EntriesResult) => {
      cache = mergeHistoryWindow(cache, room, page)
      historyCacheRef.current = cache
    }
    try {
      /** 取一窗条目；体积超限就对半缩窗重试（扩展的报错文案本身就指了 get_entries 的 limit 这条路）。 */
      const fetchWindow = async (limit: number): Promise<EntriesResult> => {
        let lim = Math.max(1, Math.floor(limit))
        for (let tries = 0; ; tries += 1) {
          try {
            const data = await runCommand("get_entries", { limit: lim })
            const parsed = parseEntriesResult(data)
            if (!parsed) throw new RelayError("bad_args", "get_entries 回包形状不对，无法补拉")
            return parsed
          } catch (error) {
            if (errorCode(error) === "payload_too_large" && lim > 64 && tries < 3) {
              lim = Math.floor(lim / 2)
              continue
            }
            throw error
          }
        }
      }

      let cursor = historyCursorRef.current
      let chain: ChainEntry[] | null = null

      if (!cursor) {
        // 首个游标：扩窗 + 转录头部指纹对齐发现
        const head = headFingerprints(transcriptRef.current.items)
        if (!head.length) throw new RelayError("bad_args", "当前转录没有可对齐的历史条目")
        let limit = HISTORY_DISCOVERY_START
        for (let round = 0; round < 6 && !cursor; round += 1) {
          const page = await fetchWindow(limit)
          if (!alive()) return false
          remember(page)
          const tail = page.entries[page.entries.length - 1]
          const seg = chainInWindow(page, page.leafId || entryIdOf(tail))
          const hit = findAnchor(seg, head)
          if (hit) {
            cursor = { entryId: hit.id, index: hit.index }
            chain = seg
          } else if (windowStartOf(page) <= 0) {
            throw new RelayError("bad_args", "转录与本机会话条目对不齐（可能刚切换过分支），重开会话后再试")
          } else {
            limit *= 2
          }
        }
        if (!cursor) throw new RelayError("bad_args", "历史太长，暂时定位不到已加载的开头，重开会话后再试")
      }

      // 以游标切页；本窗切不出可见条目就扩窗重切，直到切出、到根、或扩到上限接受现状
      let window = HISTORY_WINDOW_START
      let cacheRetried = false
      for (let round = 0; round < 7; round += 1) {
        if (!chain) {
          const fromIndex = Math.max(0, cursor.index - window)
          // 主路径：缓存已覆盖目标起点 → 零请求直接从本地窗口切页。
          let win = historyCacheCovers(cache, fromIndex) ? historyWindowFrom(cache, fromIndex) : null
          if (!win) {
            // 只补缓存盖不住的那一段；向前多留 margin，让接下来几页继续命中缓存。
            const targetStart = Math.max(0, fromIndex - HISTORY_CACHE_FETCH_MARGIN)
            const knownTotal = cache?.total ?? 0
            const first = await fetchWindow(Math.max(1, knownTotal - targetStart))
            if (!alive()) return false
            remember(first)
            // 请求期间会话又长了（total 变大）：第一次按旧 total 算的 limit 可能够不到目标起点，按新 total 补一次。
            if (cache && cache.startIndex > targetStart && cache.total > knownTotal) {
              const grown = await fetchWindow(Math.max(1, cache.total - targetStart))
              if (!alive()) return false
              remember(grown)
            }
            win = historyWindowFrom(cache, historyCacheCovers(cache, targetStart) ? fromIndex : targetStart)
          }
          if (!win) throw new RelayError("bad_args", "历史窗口读取失败，重开会话后再试")
          chain = chainInWindow(win, cursor.entryId)
          if (!chain.length) {
            if (cache && !cacheRetried) {
              // 窗口缓存可能来自被重写前的分支（或体积超限被缩窗）：丢缓存按网络窗口重试一次。
              cacheRetried = true
              cache = null
              historyCacheRef.current = null
              continue
            }
            throw new RelayError("bad_args", "历史游标已失效（会话可能被重写），重开会话后再试")
          }
        }
        const slice = slicePageBefore(chain, cursor.entryId, HISTORY_PAGE_MESSAGES)
        if (slice.messages.length) {
          dispatch({ type: "prepend", messages: slice.messages })
          if (slice.oldest) historyCursorRef.current = { entryId: slice.oldest.id, index: slice.oldest.index }
          const cur = historyRef.current
          applyHistory({ status: slice.reachedRoot ? "done" : "more", error: "", truncated: true, loads: cur.loads + 1, lastAdded: slice.messages.length })
          return true
        }
        if (slice.reachedRoot) {
          applyHistory({ status: "done", error: "", truncated: true })
          return false
        }
        chain = null
        window *= 2
        if (window > HISTORY_WINDOW_MAX) {
          // 扩到上限仍切不出：不假装到底，游标未动、数据不丢，入口保留让用户再点
          applyHistory({ status: "more", error: "", truncated: true })
          return false
        }
      }
      applyHistory({ status: "more", error: "", truncated: true })
      return false
    } catch (error) {
      if (alive()) {
        applyHistory({ status: "error", error: error instanceof Error ? error.message : "加载更早的历史失败", truncated: true })
      }
      return false
    } finally {
      historyFlightRef.current = false
    }
  }, [dispatch, runCommand])

  /**
   * get_host_diag（P1 §11）：本机版本 / attach / 最近错误 / 日志尾部；只透传，前端不补字段。
   * 名册模式下按设备级命令发送（relay 允许没有活动会话时直接问设备）；旧 relay 仍走房间命令。
   */
  const getHostDiag = useCallback(async () => {
    const deviceId = selectedDeviceRef.current
    if (deviceModeRef.current && deviceId) {
      const device = devicesRef.current.find((item) => item.id === deviceId)
      if (!device?.online) throw new RelayError("device_offline", COPY.deviceOffline)
      return runDeviceCommand(deviceId, "get_host_diag")
    }
    return runCommand("get_host_diag")
  }, [runCommand, runDeviceCommand])

  const selectDevice = useCallback((id: string) => {
    if (selectedDeviceRef.current === id) return
    // 换设备前取消还没发出去的队列：草稿/图片本来就该跟着设备清掉
    cancelLazySendRef.current(false)
    setLazySelection(null)
    selectedDeviceRef.current = id
    setSelectedDeviceId(id)
    const device = devicesRef.current.find((item) => item.id === id)
    const room = roomsRef.current.find((item) => item.id === roomRef.current)
    const owns = !!room && roomDeviceId(room) === id
    if (!device?.online || !owns) {
      clearRoom()
      // 换设备也清草稿和图：输入条里留着上一台机器的半句话很容易发错
      setDraft("")
      clearPendingImages()
      clearPendingFiles()
    }
  }, [clearPendingFiles, clearPendingImages])

  const openLazyRoom = useCallback((roomId: string) => {
    const selection = lazySessionRef.current
    const send = lazySendRef.current
    if (!selection || !send || selection.id !== roomId || send.sessionId !== roomId) return false
    // 队列留着：真正发送由 subscribed/snapshot 触发；这里只把页面切到真实房间
    setLazySelection(null)
    setSelectionNonce((n) => n + 1)
    subscribeRef.current(roomId, true)
    return true
  }, [setLazySelection])

  useEffect(() => {
    openLazyRoomRef.current = openLazyRoom
  }, [openLazyRoom])

  /** 返回启动结果：enableSession 忽略；createSession 交给新建会话页（alreadyRunning = 同目录已有会话、已切过去）；惰性发送靠它区分“受理并等待”与“真实失败”。 */
  const beginHarness = useCallback(async (kind: PendingStart["kind"], key: string, args: Record<string, unknown>): Promise<{ ok: true; roomId?: string; alreadyRunning?: boolean } | { ok: false; error: string }> => {
    const deviceId = selectedDeviceRef.current
    if (!deviceId || !key) return { ok: false, error: "先选一台设备" }
    const device = devicesRef.current.find((item) => item.id === deviceId)
    if (!device?.online) {
      setNotice({ text: COPY.deviceOffline, tone: "bad" })
      return { ok: false, error: COPY.deviceOffline }
    }
    // P9 C（spec §5.1.4）：新建会话的目录允许范围 = 白名单 projects ∪ 浏览根目录 browseRoots。
    // 这里原来只查 cwdInProjects，会把「在这台 Mac 上浏览到的新文件夹」在建会话时打回「该目录不在允许列表」。
    if (kind === "cwd" && !folderAllowed(device, key)) {
      setNotice({ text: COPY.cwdNotAllowed, tone: "bad" })
      return { ok: false, error: COPY.cwdNotAllowed }
    }
    if (pendingWatchRef.current[deviceId] || armingRef.current[deviceId]) {
      return { ok: false, error: "已有会话正在启动，请稍候" }
    }
    // 队列目标优先用 openLazyRoom（保留发送队列）；否则走普通打开
    const openStarted = (roomId: string) => {
      const target = lazySendRef.current
      if (target && target.deviceId === deviceId && target.sessionId === roomId) {
        if (openLazyRoom(roomId)) return
      }
      if (suppressStartedRoomsRef.current.has(`${deviceId}:${roomId}`)) {
        suppressStartedRoomsRef.current.delete(`${deviceId}:${roomId}`)
        return
      }
      selectRoom(roomId)
    }
    const at = Date.now()
    const watch = { kind, key, at, seen: new Set(roomsRef.current.map((room) => room.id)) }
    armingRef.current[deviceId] = watch
    setCommandInFlight((prev) => ({ ...prev, [deviceId]: at }))
    try {
      const data = (await runDeviceCommand(deviceId, "harness_start", args)) as { status?: string; roomId?: string } | null
      if (resolvedArmingAt.current.has(at)) {
        resolvedArmingAt.current.delete(at)
        setCommandInFlight((prev) => {
          if (prev[deviceId] !== at) return prev
          const next = { ...prev }
          delete next[deviceId]
          return next
        })
        return { ok: true, roomId: kind === "session" ? key : undefined }
      }
      if (data?.status === "already_running") {
        if (armingRef.current[deviceId]?.at === at) delete armingRef.current[deviceId]
        setCommandInFlight((prev) => {
          if (prev[deviceId] !== at) return prev
          const next = { ...prev }
          delete next[deviceId]
          return next
        })
        if (data.roomId) {
          openStarted(String(data.roomId))
          // 按目录新建却撞上已有会话：必须说明“已切到旧会话”，否则 UI 静默回旧会话，
          // 用户会以为新建成功，把下一条消息发进旧会话。按 sessionId 打开时保持原行为。
          if (kind === "cwd") {
            setNotice({ text: "这个目录已有会话在运行，已切换到它；要新建会话请选择其他允许目录。", tone: "warn" })
          }
          return { ok: true, roomId: String(data.roomId), alreadyRunning: true }
        }
        setNotice({ text: "这个会话已经在运行", tone: "warn" })
        return { ok: false, error: "这个会话已经在运行，但没有找到可打开的房间" }
      }
      if (armingRef.current[deviceId]?.at !== at) return { ok: false, error: "启动已取消" }
      pendingWatchRef.current[deviceId] = watch
      delete armingRef.current[deviceId]
      setCommandInFlight((prev) => {
        if (prev[deviceId] !== at) return prev
        const next = { ...prev }
        delete next[deviceId]
        return next
      })
      const existing = findStartedRoom(watch, deviceId, roomsRef.current)
      if (existing) {
        delete pendingWatchRef.current[deviceId]
        openStarted(existing.id)
        return { ok: true, roomId: existing.id }
      }
      setPendingStarts((prev) => ({ ...prev, [deviceId]: { kind, key, at } }))
      return { ok: true }
    } catch (error) {
      if (armingRef.current[deviceId]?.at === at) delete armingRef.current[deviceId]
      // 房间已找到过（room_list 把它结案了）但随后 ack 报错：这个 at 还挂在 resolvedArmingAt 里，
      // 不清掉会和下次同毫秒的 at 撞上，让那次被误判为"已结案"而永不订阅
      resolvedArmingAt.current.delete(at)
      delete pendingWatchRef.current[deviceId]
      setCommandInFlight((prev) => {
        if (prev[deviceId] !== at) return prev
        const next = { ...prev }
        delete next[deviceId]
        return next
      })
      setPendingStarts((prev) => {
        if (prev[deviceId]?.at !== at) return prev
        const next = { ...prev }
        delete next[deviceId]
        return next
      })
      const message = deviceErrorText(error)
      setNotice({ text: message, tone: "bad" })
      return { ok: false, error: message }
    }
  }, [openLazyRoom, runDeviceCommand, selectRoom])

  const flushLazySend = useCallback(async (token: number) => {
    const send = lazySendRef.current
    if (!send || send.token !== token || send.phase !== "sending") return
    // 同一次发送只提交一次：room_list / subscribed / snapshot 会重复通知
    if (lazySubmitRef.current === token) return
    if (roomRef.current !== send.sessionId) return
    const device = devicesRef.current.find((item) => item.id === send.deviceId)
    if (!device?.online) return
    lazySubmitRef.current = token
    if (lazyReadyTimerRef.current) {
      window.clearTimeout(lazyReadyTimerRef.current)
      lazyReadyTimerRef.current = null
    }
    onlineRef.current = true
    setNotice({ text: lazySendPhaseText("sending"), tone: "warn", codes: ["progress", "lazy-send"] })
    const images = (send as LazySendWithImages).images ?? (send.image ? [send.image] : undefined)
    const wireCid = hasCap(serverRef.current, "msg.cid") ? send.cid : ""
    const args: Record<string, unknown> = wireCid ? { message: send.text, cid: wireCid } : { message: send.text }
    if (images) args.images = images
    if (send.cid) {
      noteLocalEchoCid(send.cid)
      dispatch(images ? { type: "echo", text: send.text, images, cid: send.cid } : { type: "echo", text: send.text, cid: send.cid })
    }
    try {
      // 刚载入的会话也走输入卡当前的投递方式：忙时按选择 steer / follow_up，空闲 prompt。
      const plan = deliveryPlan(sendModeRef.current, busyRef.current)
      await commandSendRef.current(plan.command, args)
      if (lazySendRef.current?.token === token) {
        clearLazyTimers()
        setLazySend(stepLazySend(lazySendRef.current, { type: "submitted" }).send)
        // 只清这次发送的"正在发送…"；等待期间到达的错误/结果提示要保留
        setNotice((prev) => clearNoticeCode(prev, "lazy-send"))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "发送失败"
      // 失败只进气泡：不摘掉发送中气泡、不回写草稿。
      if (send.cid) dispatch({ type: "send-failed", cid: send.cid, error: message, drop: false })
      if (lazySendRef.current?.token === token) {
        clearLazyTimers()
        setLazySend(stepLazySend(lazySendRef.current, { type: "failed" }).send)
        setLastFailure({ retryable: (error as { retryable?: boolean }).retryable !== false, text: send.text, at: Date.now() })
        setFailurePulse(true)
      }
    }
  }, [clearLazyTimers, noteLocalEchoCid, setLazySend, dispatch])

  /** 目标房间确认在线：把 waiting 推进到 sending，并只安排一次提交。 */
  const markLazyRoomReady = useCallback((roomId: string, deviceId: string) => {
    const current = lazySendRef.current
    if (!current) return
    const transition = stepLazySend(current, { type: "room-ready", roomId, deviceId })
    if (transition.action !== "submit" || !transition.send) return
    setLazySend(transition.send)
    const token = transition.send.token
    if (lazyReadyTimerRef.current) window.clearTimeout(lazyReadyTimerRef.current)
    // 等一拍再发：relay 通常紧跟 subscribed 推 snapshot，避免乐观气泡刚画出来就被快照重置换掉
    lazyReadyTimerRef.current = window.setTimeout(() => {
      lazyReadyTimerRef.current = null
      void flushLazySend(token)
    }, 30)
  }, [flushLazySend, setLazySend])

  useEffect(() => {
    lazyRoomReadyRef.current = markLazyRoomReady
  }, [markLazyRoomReady])

  /** 用户在未载入会话里点发送：先排队（清空输入），启动成功且房间上线后只提交一次。 */
  const queueLazySend = useCallback((selection: LazySelection, text: string) => {
    if (!authedRef.current) {
      setNotice({ text: COPY.composerLinkDown, tone: "warn" })
      return
    }
    const device = devicesRef.current.find((item) => item.id === selection.deviceId)
    if (!device?.online) {
      setNotice({ text: COPY.deviceOffline, tone: "bad" })
      return
    }
    if (lazySendRef.current) return
    const attachedPlan = planSendImages([...pendingImagesRef.current])
    if (attachedPlan.notice) setNotice({ text: attachedPlan.notice, tone: "warn" })
    const images = attachedPlan.images
    const token = ++lazyTokenSeq.current
    const localCid = newCid()
    // LazySend 本体只有 image 单字段（类型在 lazySession.ts）；多图放在附加字段里随状态机原样传递。
    const send: LazySendWithImages = {
      token,
      sessionId: selection.id,
      deviceId: selection.deviceId,
      phase: "starting",
      text,
      image: images?.[0] ?? null,
      images,
      cid: localCid,
    }
    lazyAcceptedRef.current = 0
    lazySubmitRef.current = 0
    suppressStartedRoomsRef.current.delete(`${selection.deviceId}:${selection.id}`)
    clearLazyTimers()
    setLazySend(send)
    setDraft("")
    clearPendingImages()
    // 先出乐观气泡：启动失败时失败状态留在气泡里，而不是把正文塞回输入框。
    noteLocalEchoCid(localCid)
    dispatch(images ? { type: "echo", text, images, cid: localCid } : { type: "echo", text, cid: localCid })
    setNotice({ text: lazySendPhaseText("starting"), tone: "warn", codes: ["progress"] })
    lazySendTimerRef.current = window.setTimeout(() => {
      lazySendTimerRef.current = null
      if (lazySendRef.current?.token === token) failLazySend(COPY.watchTimeout, true)
    }, HARNESS_START_TIMEOUT_MS + SESSION_ONLINE_WATCH_MS)
    void beginHarness("session", selection.id, { sessionId: selection.id }).then((result) => {
      if (lazySendRef.current?.token !== token) return
      if (!result.ok) {
        failLazySend(result.error, true)
        return
      }
      lazyAcceptedRef.current = token
      const transition = stepLazySend(lazySendRef.current, { type: "harness-accepted" })
      setLazySend(transition.send)
      if (transition.send) setNotice({ text: lazySendPhaseText(transition.send.phase), tone: "warn", codes: ["progress"] })
      // already_running / 已经在线：beginHarness 已经订阅了房间，
      // 等 subscribed/snapshot 的在线确认再提交（不在这里提前发）。
    })
  }, [beginHarness, clearLazyTimers, clearPendingImages, failLazySend, noteLocalEchoCid, setLazySend])

  useEffect(() => {
    queueLazySendRef.current = queueLazySend
  }, [queueLazySend])

  const refreshSessions = useCallback(() => {
    const deviceId = selectedDeviceRef.current
    if (deviceId) loadSessions(deviceId)
  }, [loadSessions])

  const enableSession = useCallback((sessionId: string) => {
    void beginHarness("session", sessionId, { sessionId })
  }, [beginHarness])

  const createSession = useCallback((cwd: string) => {
    // 新建会话就是一次真实的打开动作：未载入选择/排队立即作废
    cancelLazySendRef.current(false)
    setLazySelection(null)
    // 新建会话页要知道是不是撞上了已有会话（alreadyRunning）：那时不算启动失败，第一条也不发（联动测试 10）
    return beginHarness("cwd", cwd, { cwd })
  }, [beginHarness, setLazySelection])

  /** 生成一次性配对码（DOC/71 §4.1）：必须带管理员令牌，relay 回 ack{data:{code, expiresAt}}，码只存在 relay 内存里 */
  const createPairCode = useCallback(async (adminToken: string): Promise<{ code: string; expiresAt: number }> => {
    if (!hasCap(serverRef.current, "device.token")) throw new RelayError("unsupported", "当前服务端不支持设备配对")
    const secret = adminToken.trim()
    if (!adminTokenReady(secret)) throw new RelayError("admin_required", ADMIN_TOKEN_COPY.required)
    const data = await channel.raw(pairCreateFrame(secret), "没有收到配对码，请重试")
    const rec = data && typeof data === "object" ? (data as { code?: unknown; expiresAt?: unknown }) : {}
    if (typeof rec.code !== "string" || !rec.code) throw new RelayError("server_error", "服务端没有给出配对码")
    return { code: rec.code, expiresAt: typeof rec.expiresAt === "number" ? rec.expiresAt : Date.now() + PAIR_CODE_TTL_MS }
  }, [channel])

  /** 撤销设备：必须带管理员令牌；作废它的全部令牌，relay 断开它的窗口和扩展连接，名册随 room_list 更新 */
  const revokeDevice = useCallback(async (deviceId: string, adminToken: string) => {
    if (!hasCap(serverRef.current, "device.token")) throw new RelayError("unsupported", "当前服务端不支持撤销设备")
    const secret = adminToken.trim()
    if (!adminTokenReady(secret)) throw new RelayError("admin_required", ADMIN_TOKEN_COPY.required)
    await channel.raw(deviceRevokeFrame(deviceId, secret), "没有收到回应，撤销结果未知，请看设备列表确认")
  }, [channel])

  /**
   * 二维码设备链接第一步（qr-pairing §3.2）：手机扫码落地后按码查待链接设备。
   * 只查不核销，回包只有非秘密元数据（name / platform / expiresAt / checkDigits），清洗在 relay/pairLink.ts；
   * 码不对 / 已过期由 relay 回 pair_invalid / pair_expired，旧 relay 回 unknown_type（落地页据此给升级提示）。
   */
  const lookupPairLink = useCallback(async (code: string): Promise<PairLookupInfo> => {
    const data = await channel.raw(pairLookupFrame(code), "没有收到回应，请重试")
    return parsePairLookup(data)
  }, [channel])

  /**
   * 二维码设备链接第二步：管理员确认后 relay 才核销码、签发设备令牌，并沿待链接连接下发给 pi 运行端落盘。
   * 与 pair_create 同门：必须带管理员令牌（本地没存够长直接 admin_required，不发帧）。
   */
  const approvePairLink = useCallback(async (code: string, adminToken: string) => {
    const secret = adminToken.trim()
    if (!adminTokenReady(secret)) throw new RelayError("admin_required", ADMIN_TOKEN_COPY.required)
    await channel.raw(pairApproveFrame(code, secret), "没有收到回应，链接结果未知，请到设备列表确认")
  }, [channel])

  const selectedDevice = devices.find((device) => device.id === selectedDeviceId) ?? null
  const listedSessions = useMemo(
    () =>
      selectedDevice
        ? mergeDeviceSessions(selectedDevice, rooms, sessionsByDevice[selectedDevice.id] || [], !!truncatedByDevice[selectedDevice.id])
        : [],
    [selectedDevice, rooms, sessionsByDevice, truncatedByDevice],
  )
  const sessionsTruncated = selectedDeviceId ? !!truncatedByDevice[selectedDeviceId] : false
  const pendingStart = selectedDeviceId ? pendingStarts[selectedDeviceId] ?? null : null
  /** 只点选未载入会话时，给三套皮肤一个可显示的“合成房间”（不订阅、不启动） */
  const lazyRoom = useMemo(() => (lazySession ? lazyRoomFromRow(lazySession) : null), [lazySession])
  const shownRooms = useMemo(() => withLazyRoom(rooms, lazyRoom), [rooms, lazyRoom])

  /** 输入卡唯一事实源：组件只读这个对象，不再自己拼 canSend/canType/placeholder。
   *  口径在 relay/composerFacts.ts（开发画廊的 fixture 也用它）：未载入会话、设备在线时按在线算，发第一条走 lazySend。 */
  const composerFacts = useMemo(
    () =>
      composerFactsOf({
        draft,
        authed,
        browserOnline,
        roomId,
        online,
        deviceMode,
        selectedDevice,
        lazySession,
        busy,
        sendMode,
        sending: sendingSend || !!lazySend,
        failurePulse,
        lastFailure,
        pendingImages: pendingImages.length,
        pendingFiles: pendingFiles.length,
      }),
    [draft, authed, browserOnline, roomId, online, deviceMode, selectedDevice, lazySession, busy, sendMode, sendingSend, lazySend, failurePulse, lastFailure, pendingImages, pendingFiles],
  )
  const composer = useComposerUi(composerFacts)
  /** 失败气泡上的「重试」：只要连接和房间可用就能重发，与当前输入是否为空无关。 */
  const retryReady =
    authed &&
    online &&
    !!roomId &&
    !lazySession &&
    !lazySend &&
    !sendingSend &&
    (!deviceMode || !!selectedDevice?.online)

  return {
    token,
    /** 管理员令牌（本机 localStorage）：只用于 pair_create / device_revoke，密码框显示，不进认证帧 */
    adminToken,
    setAdminToken,
    authed,
    /** 经 Cloudflare 隧道连接（免服务器模式 §4.3）：PiApp 顶部据此出示小徽标 */
    isViaTunnel,
    status,
    everConnected,
    retryAt,
    /** 连续重连序号（真实退避计数，不从 1 伪造）；成功认证后归零。 */
    retryCount,
    /** 正在拨号 / 等 auth_result；用于把「尝试中」与「已断开」区分开。 */
    trying,
    reconnectNow,
    logout,
    authError,
    serverProto: server.proto,
    serverCaps: server.caps,
    /** relay 声明了 device.token：名册带 auth/paired，能配对、撤销 */
    canManageDevices: hasCap(server, "device.token"),
    // 把“只点选未载入”的合成房间并进来：三套皮肤的页头/空态可直接按 roomId 找到它；
    // 内部订阅仍只看 roomsRef（真实 relay 房间），所以这里不会触发加载。
    rooms: shownRooms,
    devices,
    selectedDeviceId,
    selectedDevice,
    deviceMode,
    sessionsByDevice,
    sessionsLoading,
    sessionsTruncated,
    pendingStarts,
    pendingStart,
    commandInFlight,
    snapshotPending,
    listedSessions,
    lazySession,
    /** 未载入会话的本机正文。设备连上后由 attach 读会话文件推过来。 */
    sessionArchive: (sessionId: string) => {
      if (archiveTick < 0) return null
      const deviceId = selectedDeviceRef.current
      if (!deviceId || !sessionId) return null
      // touch：读取即刷新 LRU 位置，正在看的归档不会被新归档挤掉。
      return archiveView(touchSessionArchive(archivesRef.current, `${deviceId}\n${sessionId}`))
    },
    lazySend,
    roomId,
    /** P9 B：正在看的会话被删且没有别的会话可切 → 容器层据此进新建会话页（一次性信号）。 */
    purgedRoom,
    selectionNonce,
    online,
    roomDown,
    busy,
    /** 最近一次助手回合完成信号（页面失焦/隐藏时给角标用），换房/断线/清房时清空。 */
    turnEnd,
    /** 别房回合结束记录（B-1 per-room 边沿追踪）：注意力聚合的别房 done/error 来源，纯内存、刷新即失。 */
    roomTurnEnds,
    /** 本机弹窗等待：{kind,title,startedAt} 或 null；只提示，不应答。 */
    uiPrompt,
    /** 对话框观察（O1）：在开弹窗内容卡数组（多槽）与扩展 UI 状态快照；只读。 */
    dialogs,
    /** 对话框应答（O2）：已拒绝回执、关回执、发送答案（先答广播，桥裁决）。 */
    dialogReceipts,
    dismissDialogReceipt,
    sendDialogAnswer,
    /** 指定房间的应答（收件箱原地答别房条目用，D-§1）。 */
    sendDialogAnswerTo,
    /** 收件箱账本本地副本（D-§1，只含元数据）与手动清除（仅 done/error）。 */
    inbox,
    dismissInbox,
    /** 定时排期（D-§3）：当前房清单 / 全量分桶副本 / 创建与取消（relay 本地命令）。 */
    schedules: roomId ? (schedulesByRoom[roomId] ?? []) : [],
    schedulesByRoom,
    createSchedule,
    cancelSchedule,
    extStatus,
    activity,
    notice,
    /** 第 5 章通知栈（N1–N8）：可见卡、队列与全部交互。 */
    notices: noticeStack.visible,
    noticeQueue: noticeStack.queue.length,
    dismissNotice: noticeStack.dismiss,
    dismissTopNotice: noticeStack.dismissTop,
    pauseNotice: noticeStack.pause,
    resumeNotice: noticeStack.resume,
    runNoticeAction: noticeStack.runAction,
    pushNotice: noticeStack.push,
    clearNotices: noticeStack.clear,
    retractNoticeScope: noticeStack.retract,
    queue,
    /** 扩展自管远程待发（remote_queue_state 整帧）：pending 可编辑/取消。 */
    remoteQueue,
    /** P5.6 本页 outbox（当前会话，按入队顺序）：断线 / 设备离线时发的消息，恢复后按序回放。 */
    outbox,
    outboxCancel,
    outboxRetry,
    /** navigator.onLine：浏览器自己断网时为 false */
    browserOnline,
    queueEdit,
    queueCancel,
    queueSendNow,
    queueFetchFullText,
    refreshRemoteQueue,
    /** 最近一次压缩的量化结果（tokensBefore/estimatedTokensAfter 实值，缺值不补）。 */
    lastCompaction,
    /** 事件推送的任务清单；空数组=没有清单（卡片不渲染），不经前端加工。 */
    taskList,
    /** 终端胶囊派生条目：tool_execution_* 事件驱动，只认 bash/powershell。 */
    terminalItems,
    /** agent_state 全量快照；没有生产者时保持空数组，胶囊行不渲染。 */
    agentState,
    model,
    modelMeta,
    usage,
    thinkingLevel,
    draft,
    /** 对外走带落盘对账标记的版本（P3-3）；内部程序化回填仍用原始 setDraft。 */
    setDraft: setDraftTracked,
    /** fork 后回填：命令回包与新房订阅谁先到都不会丢（见 restoreDraftAfterSwitch）。 */
    restoreDraftAfterSwitch,
    /** 忙时投递方式（默认 auto）与它的可选持久化。 */
    sendMode,
    setSendMode,
    pendingImages,
    addPendingImages,
    removePendingImage,
    clearPendingImages,
    pendingFiles,
    addPendingFiles,
    removePendingFile,
    clearPendingFiles,
    composer,
    retryReady,
    transcript: transcript as Transcript,
    /** 长会话历史补拉（R2-5）：入口状态（跟房间走）+ 补拉动作（get_entries 命令区）。 */
    history,
    loadEarlierHistory,
    login,
    sendText,
    abort,
    runCommand,
    /** P10 使用活动：usage_get → usage_snapshot（无连接/超时/旧 relay 返回诚实空态）。 */
    getUsage,
    /** P11 身份行：relay 自定的中转服务器名（旧 relay null → UI 回退 hostname） */
    serverName: server?.serverName ?? null,
    /** P11 prefs-sync：服务端账号级 mobileNav（null=旧 relay/无记录） */
    syncedMobileNav,
    /** P11 prefs-sync：上行 mobileNav（additive；返回是否真的发出） */
    pushMobileNav,
    /** P1 §10：读取本机会话目录下的单个文件（不列目录）。 */
    getFile,
    /** omit 图片按需补拉：只接受投影/历史里真实存在的 entryId + blockIndex。 */
    getImage,
    /** P1 §11：本机诊断（版本 / attach / 最近错误 / 日志尾部）。 */
    getHostDiag,
    runDeviceCommand,
    /** P9 C：列这台设备上允许浏览范围内的子文件夹（fs.browse 的 list_dirs）。 */
    listDirs,
    searchSessionBodies,
    /** 删除会话文件：发给和目标同目录的在线房间（P8 R25）。 */
    deleteSessionFile,
    /** 删除会话（P9 B）：有 session.purge 走设备级命令 + session_removed；否则退回 deleteSessionFile。 */
    deleteSession,
    /** 未载入会话：改名 / 导出 / 冷 fork（都走设备通道，不要求先载入）。 */
    renameSessionFile,
    exportSessionFile,
    forkSessionFile,
    sessionNameForPath,
    notify,
    selectRoom,
    selectListedSession,
    selectDevice,
    enableSession,
    refreshSessions,
    createSession,
    createPairCode,
    revokeDevice,
    lookupPairLink,
    approvePairLink,
  }
}

/** usage_state 帧载荷（契约 §4.7.1）：pi 终端 footer 的实时数据。
 *  contextUsage.percent 是百分点（100 = 满）；usageByKind 如 cache_warm（非消息用量）；
 *  costByModel 按 provider/model 拆分费用（虚拟模型路由时看物理模型花费）。 */
export interface UsageState {
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }
  cost?: number
  usageByKind?: Record<string, { count?: number; tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }; cost?: number }>
  costByModel?: Record<string, number>
  contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null } | null
}

export type Relay = ReturnType<typeof useRelay>

/** 页面头部的状态行（三套皮肤、桌面和手机共用一个口径；运行状态不在这里） */
export function headerLine(relay: Relay, room: RoomInfo | null): string {
  if (relay.lazySession && relay.lazySession.id === room?.id && relay.authed && (!relay.selectedDevice || relay.selectedDevice.online)) {
    return ["待载入", room?.cwd ? cwdLabel(room.cwd) : "", relay.selectedDevice?.name || ""].filter(Boolean).join(" · ")
  }
  return headerMeta({
    room,
    authed: relay.authed,
    everConnected: relay.everConnected,
    online: relay.online,
    roomDown: relay.roomDown,
    busy: relay.busy,
    device: rosterActive(relay) ? relay.selectedDevice : null,
  }).join(" · ")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function resultText(result: unknown): string {
  if (typeof result === "string") return result
  if (Array.isArray(result)) return textOf(result)
  if (isRecord(result) && "content" in result) return textOf(result.content)
  return ""
}
