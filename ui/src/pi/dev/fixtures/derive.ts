/**
 * fixture → 容器看到的 relay（plan P5.2）。fixture 只写 relay 的原始字段；useRelay 在内部 memo 里派生的字段
 * 照 useRelay.ts 的同一口径（第 3440–3482 行附近）用真实函数补齐，免得每份 fixture 手抄一份算好的值。
 * LiveRoute（P5）用 makeFakeRelay(liveRelayOf(fixture))。node --test 直接加载：相对导入带 .ts 扩展名。
 */
import { deriveComposer } from "../../../chat/composerMachine.ts"
import { composerFactsOf } from "../../../relay/composerFacts.ts"
import { mergeDeviceSessions } from "../../../relay/devices.ts"
import { lazyRoomFromRow, withLazyRoom } from "../../../relay/lazySession.ts"
import type { PiLiveFixture, Relay } from "./types.ts"

export type LiveRelayOptions = {
  /** 手机：deriveComposer 的占位不出现键名（useComposerMobile 的结果） */
  mobile?: boolean
}

/**
 * 补齐的字段：selectedDevice、listedSessions、pendingStart、rooms（并入未载入会话的合成房间）、composer、retryReady、
 * outbox（fixture.outbox → relay.outbox 的 OutboxEntry 形状）。
 * fixture 自己写了的派生字段不覆盖（只有确实要钉住某个值的屏才这么做，并在 note 里说明）。
 * useRelay 内部的 sendingSend / failurePulse / lastFailure 不在 Relay 上，fixture 表达不了，按 false / null 算。
 */
export function liveRelayOf(fixture: PiLiveFixture, options: LiveRelayOptions = {}): Partial<Relay> {
  const raw = fixture.relay
  const devices = raw.devices ?? []
  const rooms = raw.rooms ?? []
  const selectedDeviceId = raw.selectedDeviceId ?? null
  const selectedDevice = devices.find((device) => device.id === selectedDeviceId) ?? null
  const listedSessions = selectedDevice ? mergeDeviceSessions(selectedDevice, rooms, raw.sessionsByDevice?.[selectedDevice.id] ?? []) : []
  const pendingStart = selectedDeviceId ? (raw.pendingStarts?.[selectedDeviceId] ?? null) : null
  const lazySession = raw.lazySession ?? null
  const shownRooms = withLazyRoom(rooms, lazySession ? lazyRoomFromRow(lazySession) : null)
  const authed = raw.authed ?? false
  const roomId = raw.roomId ?? ""
  const online = raw.online ?? false
  const deviceMode = raw.deviceMode ?? false
  const pendingImages = raw.pendingImages ?? []
  const pendingFiles = raw.pendingFiles ?? []
  // 和 useRelay 同一个口径（relay/composerFacts.ts，P5 c 线）：sendingSend / failurePulse / lastFailure 不在 Relay 上，按 false / null 算
  const composer = deriveComposer({
    ...composerFactsOf({
      draft: raw.draft ?? "",
      authed,
      browserOnline: raw.browserOnline ?? true,
      roomId,
      online,
      deviceMode,
      selectedDevice,
      lazySession,
      busy: raw.busy ?? false,
      sendMode: raw.sendMode ?? "auto",
      sending: !!raw.lazySend,
      failurePulse: false,
      lastFailure: null,
      pendingImages: pendingImages.length,
      pendingFiles: pendingFiles.length,
    }),
    mobile: options.mobile ?? false,
  })
  const retryReady = authed && online && !!roomId && !lazySession && !raw.lazySend && (!deviceMode || !!selectedDevice?.online)
  // P5.6 合并后 relay 自己带 outbox（当前会话的 OutboxEntry）：fixture.outbox 补成同样的形状，容器只读 relay.outbox（p5-base）
  const outbox = (fixture.outbox ?? []).map((item) => ({ ...item, dedupeKey: `fixture-${item.cid}`, roomId, at: fixture.now }))
  return {
    selectedDevice,
    listedSessions,
    pendingStart,
    composer,
    retryReady,
    outbox,
    ...raw,
    rooms: shownRooms,
  }
}
