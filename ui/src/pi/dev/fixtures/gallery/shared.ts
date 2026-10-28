/**
 * 画廊共用 mock（design §3.2；P3.3 从 components/pi/shared/mock.ts 搬来，只给 pi/dev 用）。字段名照 ui/src/relay 的类型写（types.ts），值是假的但自洽：
 * 截图里出现的每个时间、计数都能从这里算出来（§1.9）。b / c 区自己的 mock 引用这里的 id 和 MOCK_NOW。
 * 人名路径一律用占位（/Users/dev/…、relay.example.com）。
 */
import * as adapters from "@/components/pi/shared/adapters"
import type {
  PiAttentionItem,
  PiDevice,
  PiDeviceSession,
  PiLinkSummary,
  PiLinkView,
  PiListedSession,
  PiModelMeta,
  PiRoom,
  PiRowMarkerKind,
  PiSessionGroup,
  PiSessionRowData,
  PiUsageState,
} from "@/components/pi/shared/types"
import { MOCK_NOW } from "../types"

export { MOCK_NOW }

/* MOCK_NOW = 2026-10-24 10:42（+08:00）；所有相对时间按它算。定义在 ../types.ts（live fixture 与画廊共用一个常量） */
const s = 1000
const m = 60 * s
const h = 60 * m
const d = 24 * h

export const MOCK_RELAY_HOST = "relay.example.com"

export const MOCK_DEVICES: PiDevice[] = [
  {
    id: "d-mbp",
    accountId: "acct-dev",
    name: "MacBook Pro",
    platform: "darwin",
    online: true,
    projects: ["/Users/dev/code/pi-remote", "/Users/dev/code/notes-app", "/Users/dev/code/dotfiles"],
    lastAttachAt: MOCK_NOW - 3 * h,
    firstSeenAt: MOCK_NOW - 52 * d,
    windowExpiresAt: MOCK_NOW + 5 * h + 12 * m,
    auth: "token",
    paired: true,
  },
  {
    id: "d-studio",
    accountId: "acct-dev",
    name: "Mac Studio",
    platform: "darwin",
    online: true,
    projects: ["/Users/dev/work/billing-service", "/Users/dev/work/infra"],
    lastAttachAt: MOCK_NOW - 9 * h,
    firstSeenAt: MOCK_NOW - 40 * d,
    windowExpiresAt: MOCK_NOW + 21 * h,
    auth: "token",
    paired: true,
  },
  {
    id: "d-win",
    accountId: "acct-dev",
    name: "ThinkPad",
    platform: "win32",
    online: false,
    projects: ["C:\\Users\\dev\\src\\game-tools"],
    lastAttachAt: MOCK_NOW - 27 * h,
    firstSeenAt: MOCK_NOW - 12 * d,
    windowExpiresAt: null,
    auth: null,
    paired: true,
  },
]

/** 会话 = ListedSession 的字段 + 所在设备 + pi 会话文件里的 UUID（"复制会话 ID" 用） */
export type PiMockSession = PiDeviceSession & { sessionId: string }

const PI_REMOTE = "/Users/dev/code/pi-remote"
const NOTES = "/Users/dev/code/notes-app"
const BILLING = "/Users/dev/work/billing-service"
const INFRA = "/Users/dev/work/infra"
const GAME = "C:\\Users\\dev\\src\\game-tools"

function session(
  id: string,
  deviceId: string,
  cwd: string,
  title: string,
  opts: { online: boolean; busy?: boolean; messageCount: number; updatedAt: number; sessionId: string; parentLabel?: string },
): PiMockSession {
  return {
    id,
    deviceId,
    sessionId: opts.sessionId,
    title,
    firstMessage: title,
    cwd,
    online: opts.online,
    busy: !!opts.busy,
    viewers: opts.online ? 1 : 0,
    messageCount: opts.messageCount,
    updatedAt: opts.updatedAt,
    openable: opts.online,
    ...(opts.parentLabel ? { parentLabel: opts.parentLabel } : {}),
  }
}

/**
 * 全部 17 个会话。MacBook Pro/pi-remote 共 12 个（露 5 个 + "更多 7"）。
 * online = 房间在线（本机 pi 在跑）；openable:false 的是只有本机记录的未载入会话。
 */
export const MOCK_SESSIONS: PiMockSession[] = [
  // MacBook Pro/pi-remote
  session("r-s1", "d-mbp", PI_REMOTE, "修复手机键盘收起时输入框跳动", { online: true, messageCount: 48, updatedAt: MOCK_NOW - 2 * m, sessionId: "5f2c3a10-8d4e-4b7a-9c61-0e2f7b4a1e91" }),
  session("r-s2", "d-mbp", PI_REMOTE, "relay 重启后提示结果未知", { online: true, busy: true, messageCount: 17, updatedAt: MOCK_NOW - 20 * s, sessionId: "a83d0c52-1e6f-4c29-8b07-6d4e9f1c2b38" }),
  session("r-s3", "d-mbp", PI_REMOTE, "给 history-backfill 补测试", { online: true, messageCount: 9, updatedAt: MOCK_NOW - 1 * m, sessionId: "0b7e4f19-52ac-4d8b-9e3a-7c1d5a6f8e24" }),
  session("r-s4", "d-mbp", PI_REMOTE, "整理 README 的配对步骤", { online: true, messageCount: 31, updatedAt: MOCK_NOW - 14 * m, sessionId: "5c1e9b72-4f30-4d8e-a6b5-31c8d2e0fa07" }),
  session("r-s10", "d-mbp", PI_REMOTE, "键盘问题 · 分叉", { online: true, messageCount: 52, updatedAt: MOCK_NOW - 1 * h, sessionId: "e4a6c2d8-07b1-4f5e-8a39-2d6b0c9e7f13", parentLabel: "源自「修复手机键盘收起时输入框跳动」" }),
  session("s12", "d-mbp", PI_REMOTE, "设备令牌轮换的文案", { online: false, messageCount: 23, updatedAt: MOCK_NOW - 6 * h, sessionId: "71d3b9e0-6c2a-4e85-b1f4-9a0e3c5d7b62" }),
  session("s13", "d-mbp", PI_REMOTE, "排队面板的冲突提示", { online: false, messageCount: 36, updatedAt: MOCK_NOW - 19 * h, sessionId: "c9f05a7e-3b18-4d62-8e4c-1f7a2b6d0e95" }),
  session("s14", "d-mbp", PI_REMOTE, "命令面板加会话搜索", { online: false, messageCount: 44, updatedAt: MOCK_NOW - 2 * d, sessionId: "2a8e6d14-9c03-4b7f-a5e1-8d2c4f0b6a37" }),
  session("s15", "d-mbp", PI_REMOTE, "终端输出软换行", { online: false, messageCount: 15, updatedAt: MOCK_NOW - 3 * d, sessionId: "f6b2a0c9-4d71-4e3a-9b58-0c7e1d3f5a84" }),
  session("s16", "d-mbp", PI_REMOTE, "diff 卡读 details.patch", { online: false, messageCount: 28, updatedAt: MOCK_NOW - 4 * d, sessionId: "8d4c1e7b-2f96-4a05-b3d8-6e9a0f2c4b71" }),
  session("s17", "d-mbp", PI_REMOTE, "配对码倒计时", { online: false, messageCount: 12, updatedAt: MOCK_NOW - 5 * d, sessionId: "3e7a9f25-0b4c-4d1e-8f63-5a2d7c9b0e48" }),
  session("s18", "d-mbp", PI_REMOTE, "升级 vite 8", { online: false, messageCount: 57, updatedAt: MOCK_NOW - 6 * d, sessionId: "b5d0e3a6-7c29-4f84-a1e7-4b8f2d6c0a19" }),
  // MacBook Pro/notes-app
  session("r-s5", "d-mbp", NOTES, "日记页加离线缓存", { online: true, messageCount: 22, updatedAt: MOCK_NOW - 5 * h, sessionId: "6a1f8c3d-5e07-4b92-9d4a-0c3e7b1f5d26" }),
  // MacBook Pro/dotfiles：没有会话 → 文件夹行
  // Mac Studio/billing-service
  session("r-s6", "d-studio", BILLING, "退款对账脚本报错", { online: true, messageCount: 14, updatedAt: MOCK_NOW - 38 * m, sessionId: "d2b7e9a4-1c58-4f06-8e3b-9a6d0c2f7e51" }),
  session("r-s11", "d-studio", BILLING, "账单导出改成流式", { online: true, messageCount: 40, updatedAt: MOCK_NOW - 3 * h, sessionId: "9e3c5a07-8b1d-4e6f-a2c9-7d0b4f8e1a63" }),
  // Mac Studio/infra：未载入（有本机记录）
  session("s7", "d-studio", INFRA, "升级 nginx 配置", { online: false, messageCount: 64, updatedAt: MOCK_NOW - 1 * d, sessionId: "47f1d0b8-3a6e-4c2d-9b75-e8c1a4f0d392" }),
  // ThinkPad/game-tools（设备离线；relay 存有最后一次快照）
  session("r-s8", "d-win", GAME, "地图编辑器导出 bug", { online: false, messageCount: 27, updatedAt: MOCK_NOW - 27 * h, sessionId: "1c9a7e3f-6d20-4b8a-85e4-0f3b9d2c6a17" }),
]

/** 在线会话对应的房间（room_list.rooms）：只有 online 的会话有房间；busy 来自房间 */
export const MOCK_ROOMS: PiRoom[] = MOCK_SESSIONS.filter((x) => x.online).map((x) => ({
  id: x.id,
  label: null,
  name: x.title,
  firstMessage: x.firstMessage ?? null,
  cwd: x.cwd,
  online: true,
  busy: x.busy,
  viewers: x.viewers,
  lastActivity: x.updatedAt,
  accountId: "acct-dev",
  deviceId: x.deviceId,
}))

/** 注意力清单（已按 KIND_PRIORITY 排好：waiting → error → device-offline → done）。detail 照 relay/attention.ts 的文案 */
export const MOCK_ATTENTION: PiAttentionItem[] = [
  { key: "dialog:dlg-7f3", kind: "waiting", roomId: "r-s3", deviceId: "d-mbp", dialogId: "dlg-7f3", title: "给 history-backfill 补测试", detail: "等你处理：允许 pi 运行这条命令吗？", at: MOCK_NOW - 1 * m },
  { key: "turn:r-s6:12", kind: "error", roomId: "r-s6", deviceId: "d-studio", dialogId: null, title: "退款对账脚本报错", detail: "回合出错了，还没看", at: MOCK_NOW - 38 * m },
  { key: "device:d-win", kind: "device-offline", roomId: "", deviceId: "d-win", dialogId: null, title: "ThinkPad", detail: "设备未连接，回电脑打开 attach 后恢复", at: 0 },
  { key: "turn:r-s4:7", kind: "done", roomId: "r-s4", deviceId: "d-mbp", dialogId: null, title: "整理 README 的配对步骤", detail: "回合已完成，还没看", at: MOCK_NOW - 14 * m },
]

export const MOCK_LINK: PiLinkView = { kind: "ok" }
/** reconnecting 屏：断线等第 3 次重连，4 秒后 */
export const MOCK_LINK_WAITING: PiLinkView = { kind: "waiting", seconds: 4, first: false }
export const MOCK_RETRY_COUNT = 3

export const MOCK_MODEL: PiModelMeta = { provider: "anthropic", modelId: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }
export const MOCK_THINKING_LEVEL = "medium"

/** r-s1 的 usage_state。缓存命中 = cacheRead / (input + cacheRead) = 87% */
export const MOCK_USAGE: PiUsageState = {
  tokens: { input: 182340, output: 24410, cacheRead: 1203300, cacheWrite: 40220, total: 1450270 },
  cost: 3.84,
  costByModel: { "anthropic/claude-sonnet-4-5": 3.61, "anthropic/claude-haiku-4-5": 0.23 },
  contextUsage: { tokens: 61800, contextWindow: 200000, percent: 30.9 },
}

/** r-s1 的 git 分支（get_git_branch） */
export const MOCK_BRANCH = "main"

/* ---------------- 画廊默认值包装（P3.3）：shared/adapters.ts 的同名函数参数必填，这里补上画廊 mock ---------------- */

export function mockDevice(id: string | null | undefined): PiDevice | undefined {
  return MOCK_DEVICES.find((x) => x.id === id)
}

export function mockSession(id: string): PiMockSession | undefined {
  return MOCK_SESSIONS.find((x) => x.id === id)
}

export function piRowMarkerOf(row: Pick<PiListedSession, "id" | "busy" | "openable">, attention: PiAttentionItem[] = MOCK_ATTENTION): PiRowMarkerKind {
  return adapters.piRowMarkerOf(row, attention)
}

export function piSessionRow(x: PiDeviceSession, now = MOCK_NOW, attention: PiAttentionItem[] = MOCK_ATTENTION): PiSessionRowData {
  return adapters.piSessionRow(x, now, attention, MOCK_DEVICES)
}

export function piAttentionRows(attention: PiAttentionItem[] = MOCK_ATTENTION, now = MOCK_NOW, devices: PiDevice[] = MOCK_DEVICES): PiSessionRowData[] {
  return adapters.piAttentionRows(attention, now, devices)
}

/** 同 adapters.piSessionGroups；sessions / devices / attention / now 不传（或传 undefined）时用画廊 mock */
export type PiGalleryGroupOptions = Omit<adapters.PiGroupOptions, "sessions" | "devices" | "attention" | "now"> &
  Partial<Pick<adapters.PiGroupOptions, "sessions" | "devices" | "attention" | "now">>
export function piSessionGroups(opts: PiGalleryGroupOptions = {}): PiSessionGroup[] {
  return adapters.piSessionGroups({
    ...opts,
    sessions: opts.sessions ?? MOCK_SESSIONS,
    devices: opts.devices ?? MOCK_DEVICES,
    attention: opts.attention ?? MOCK_ATTENTION,
    now: opts.now ?? MOCK_NOW,
  })
}

export function piLinkSummary(link: PiLinkView, devices: PiDevice[] = MOCK_DEVICES): PiLinkSummary {
  return adapters.piLinkSummary(link, devices)
}

export function piAttentionOnOpen(roomId: string | null | undefined, attention: PiAttentionItem[] = MOCK_ATTENTION): PiAttentionItem[] {
  return adapters.piAttentionOnOpen(roomId, attention)
}

export function piOtherAttentionCount(currentRoomId: string, attention: PiAttentionItem[] = MOCK_ATTENTION, currentDeviceId?: string | null): number {
  return adapters.piOtherAttentionCount(currentRoomId, attention, currentDeviceId)
}

/** 每台设备的会话数（MOCK_SESSIONS 里数；显示选项的设备行用，原 c/PiDisplayOptions.tsx 的 sessionCounts） */
export function mockSessionCounts(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of MOCK_SESSIONS) out[s.deviceId] = (out[s.deviceId] ?? 0) + 1
  return out
}
