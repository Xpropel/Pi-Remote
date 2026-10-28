/**
 * 输入卡的事实（ComposerFacts）由 relay 状态拼出来的唯一口径（P5 c 线，brief 16:45「Not-loaded (lazy) sessions」）。
 * useRelay 和开发画廊 fixture 的 liveRelayOf 共用这一个纯函数，两边算出的 composer 状态一致。deriveComposer 本身不改。
 * node --test 直接加载：只有类型导入（运行时擦除），相对路径带扩展名。
 */
import type { ComposerFacts, ComposerFailureFacts } from "../chat/composerMachine.ts"
import type { SendMode } from "../chat/composerTools.ts"

export type ComposerFactsInput = {
  draft: string
  authed: boolean
  /** navigator.onLine：浏览器自己断网时为 false */
  browserOnline: boolean
  /** 当前选中的会话 id；"" = 没有选中会话 */
  roomId: string
  /** 当前房间在线（room_list / 订阅成功） */
  online: boolean
  deviceMode: boolean
  selectedDevice: { name?: string | null; online: boolean } | null
  /** 只点选、还没载入的会话（useRelay 的 lazySession） */
  lazySession: { id: string } | null
  busy: boolean
  sendMode: SendMode
  /** 已发出一帧、正在等 ack，或者未载入会话正在载入并发送（sendingSend || lazySend） */
  sending: boolean
  failurePulse: boolean
  lastFailure: ComposerFailureFacts | null
  pendingImages: number
  pendingFiles: number
}

/**
 * 未载入会话（当前 roomId 就是 lazySession）：房间还没订阅所以 online 为 false，但发第一条时会走 lazySend 载入并发送，
 * 不进 outbox。设备在线（或不在设备模式）时按在线算（S1）；设备离线照旧由 deviceOnline 给 S5。
 */
export function lazyCountsOnline(input: Pick<ComposerFactsInput, "roomId" | "lazySession" | "deviceMode" | "selectedDevice">): boolean {
  if (!input.lazySession || !input.roomId || input.lazySession.id !== input.roomId) return false
  return !input.deviceMode || !input.selectedDevice || input.selectedDevice.online
}

export function composerFactsOf(input: ComposerFactsInput): Omit<ComposerFacts, "mobile"> {
  const roomOnline = input.online || lazyCountsOnline(input)
  return {
    draft: input.draft,
    // 没有选中会话时 link 本身不算离线：让"先选会话"走发送提示，而不是显示离线占位。
    // 浏览器断网也按离线（S5）：发送进 outbox，占位与之一致
    online: input.authed && input.browserOnline && (input.roomId ? roomOnline : true),
    deviceOnline: input.deviceMode && input.selectedDevice ? input.selectedDevice.online : undefined,
    generating: input.busy,
    sendMode: input.sendMode,
    sending: input.sending,
    failurePulse: input.failurePulse,
    lastFailure: input.lastFailure,
    pendingImages: input.pendingImages,
    pendingFiles: input.pendingFiles,
    attachments: input.pendingImages ? { count: input.pendingImages } : null,
    deviceName: input.selectedDevice?.name ?? null,
  }
}
