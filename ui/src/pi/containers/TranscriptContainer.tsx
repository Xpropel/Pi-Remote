import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import type { PiImageLoad, PiTranscriptActions } from "@/components/pi/conversation/actions"
import { piImageSrcOf } from "@/components/pi/conversation/actions"
import { piCopyText } from "@/components/pi/conversation/clipboard"
import { PiLightbox, type PiLightboxImage } from "@/components/pi/conversation/PiLightbox"
import { PiStreamTopLine, type PiStreamTopLineItem } from "@/components/pi/conversation/PiStreamLines"
import { PiTranscript, type PiOpenImage } from "@/components/pi/conversation/PiTranscript"
import type { PiImagePart, PiUserItem } from "@/components/pi/shared/types"
import { loadRemoteImage, remoteImageRef, type RemoteImageRef } from "@/conversation/remoteImage"
import { useNow } from "@/pi/hooks/useNow"
import { piTranscriptStick } from "@/pi/hooks/useTranscriptStick"
import {
  archiveTopLinesOf,
  EMPTY_THINKING_CLOCK,
  historyTopLineOf,
  liveExpandedOf,
  observeThinking,
  outboxItemsOf,
  piItemsOf,
  runningOf,
  subagentsOf,
  turnTextOf,
  type PiThinkingClock,
  type PiTopLine,
} from "@/pi/model/transcriptView"
import { COPY } from "@/relay/devices"
import type { Item } from "@/relay/transcript"
import { openPiDialog, PI_UI_IDS, type PiContainerProps, type PiSessionExtras } from "./types"

/**
 * 对话流（plan §7.2 conversation / conversation-streaming / stream-errors / session-archived，P5.4 b 线）。
 * relay：transcript.items、history / loadEarlierHistory、snapshotPending、busy、dialogs / uiPrompt（有卡在等你时不放运行行）、
 * agentState（subagent 行）、lazySession / sessionArchive（未载入会话的本机记录，W1）、getImage（取原图）、sendText（发送失败重试）。
 * - 条目：pi/model/transcriptView.ts 的 piItemsOf（patch → diff 卡、观测到的思考时长）；回合、工具重量、探索合并、用时由 PiTranscript
 *   按 design §1.5 / §1.9 画（tools.ts 的口径同 model/toolWeight.ts 的 toolWeightOf / mergeExploreRuns、relay 的 toolDisplayState）。
 * - 思考时长：界面层实时观测到的起止（observeThinking；快照落地后才开始看，打开页面时已经在想的不计，写"已思考"，G4）。
 * - 默认展开、运行行、subagent 行：transcriptView.ts 的 liveExpandedOf / runningOf / subagentsOf。
 * - 本页 outbox（relay.outbox，P5.6）：还没送出去的消息接在流尾，卡下灰字"等重连后发送"（outboxItemsOf）。
 * - 流顶：外壳给的 extras.topLine（a，设备离线等）+ 补拉状态（D02）/ 本机记录说明 / 正在拉快照。
 * - 点图开 PiLightbox（get_image 取原图，失败"加载失败 · 重试"）：portal 到 [data-pi-root]，盖住整个外壳（手机安全区变量照样拿得到）。
 * - 吸底："回到底部"的状态交给 c 的 dock（pi/hooks/useTranscriptStick.ts）。
 * 桌面放在外壳正文，手机放在对话页的唯一滚动区。
 */
export function TranscriptContainer(props: PiContainerProps & { extras?: PiSessionExtras }) {
  const { relay, ui, act, variant, extras } = props
  const now = useNow(1000)
  const roomId = relay.roomId
  const liveItems: Item[] = roomId ? relay.transcript.items : EMPTY_ITEMS
  const lazy = relay.lazySession && relay.lazySession.id === roomId ? relay.lazySession : null

  // 未载入会话（session-archived）：设备推过来的本机记录；没有记录时只画首条消息卡
  const archive = lazy && liveItems.length === 0 ? relay.sessionArchive(lazy.id) : null
  const lazyFirst = lazy && !archive && lazy.firstMessage ? lazy.firstMessage : null
  const lazyId = lazy?.id ?? null
  const fallbackItems = useMemo<Item[]>(
    () => (lazyId && lazyFirst ? [{ kind: "user", key: `lazy-first-${lazyId}`, text: lazyFirst, images: [] }] : EMPTY_ITEMS),
    [lazyId, lazyFirst],
  )
  const archiveItems = archive?.items
  const source = liveItems.length > 0 ? liveItems : (archiveItems ?? fallbackItems)

  // 思考时长的实时观测：快照落地后，每次转录变了看一眼活动尾部的思考块（渲染期间调整 state，React 文档的写法；
  // 时刻取 useNow 的秒级时钟，误差 ≤ 1 秒，"思考 N 秒"本来就按秒写）
  const snapshotPending = relay.snapshotPending
  const [clock, setClock] = useState<{ room: string; items: readonly Item[] | null; clock: PiThinkingClock }>(() => ({
    room: roomId,
    items: null,
    clock: EMPTY_THINKING_CLOCK,
  }))
  if (!snapshotPending && (clock.items !== liveItems || clock.room !== roomId)) {
    const base = clock.room === roomId ? clock.clock : EMPTY_THINKING_CLOCK
    setClock({ room: roomId, items: liveItems, clock: observeThinking(base, liveItems, now) })
  }
  const observed = clock.room === roomId ? clock.clock.done : EMPTY_THINKING_CLOCK.done
  // 本页 outbox 里还没送出去的消息接在流尾（P5.6，§1.12：用户卡下灰字"等重连后发送"；回放后由同 cid 的气泡接手）
  const outbox = relay.outbox
  const outboxItems = useMemo(() => outboxItemsOf(outbox, liveItems), [outbox, liveItems])
  // 没改的条目原样返回（同一个对象）。整条派生按输入身份缓存（UI·perf 中-1）：
  // 每秒的时钟 tick 不碰转录，就不该把上万条重新映射一遍（source 同时喂给 itemsRef，故直接列它的三路输入）。
  const piItems = useMemo(
    () => piItemsOf(liveItems.length > 0 ? liveItems : (archiveItems ?? fallbackItems), observed),
    // archiveItems 来自 relay.sessionArchive()（外部存储的映射结果），React Compiler 会当成“之后可能被改”而跳过本组件优化；
    // 这条 memo 本来就是按身份缓存、运行时语义不变，故按下不表
    // eslint-disable-next-line react/preserve-manual-memoization
    [liveItems, archiveItems, fallbackItems, observed],
  )
  const items = useMemo(() => (outboxItems.length > 0 ? [...piItems, ...outboxItems] : piItems), [piItems, outboxItems])

  // 有卡在等你（审批卡 / 旧式确认框信号）：等待只在卡上表达，流末尾不放运行行（§5）
  const waiting = relay.dialogs.length > 0 || relay.uiPrompt != null
  const busy = relay.busy && !lazy
  const running = runningOf(liveItems, busy, waiting)
  const expanded = useMemo(
    () => liveExpandedOf(liveItems, { running: busy, waiting, paneOpen: variant === "desktop" && ui.pane != null }),
    [liveItems, busy, waiting, variant, ui.pane],
  )
  const subagents = useMemo(() => subagentsOf(relay.agentState), [relay.agentState])

  // 取原图（get_image）：按 entryId + blockIndex 记加载状态；换会话清空
  const [loads, setLoads] = useState<{ room: string; map: Record<string, PiImageLoad> }>(() => ({ room: roomId, map: {} }))
  const loadMap = loads.room === roomId ? loads.map : EMPTY_LOADS
  const getImage = relay.getImage
  const loadImage = useCallback(
    (image: PiImagePart) => {
      const ref = remoteImageRef(image)
      if (!ref) return
      const key = imageKey(ref)
      const put = (state: PiImageLoad) =>
        setLoads((cur) => ({ room: roomId, map: { ...(cur.room === roomId ? cur.map : {}), [key]: state } }))
      put({ phase: "loading" })
      void loadRemoteImage(ref, (r) => getImage(r.entryId, r.blockIndex)).then((state) => put(state))
    },
    [getImage, roomId],
  )

  // 灯箱：点了哪组图的第几张、被点开的那张（关闭后焦点回它）；portal 到被点的图所在的 PiRoot（盖住整个外壳，主题和安全区变量都在它上面）
  const [lightbox, setLightbox] = useState<{
    room: string
    images: readonly PiImagePart[]
    index: number
    opener: HTMLElement | null
    root: HTMLElement | null
  } | null>(null)
  // 点亮箱的回调要稳定：它作为 PiTranscript 的 prop 进每条消息的 memo 比较（UI·perf 中-1）
  const openImage = useCallback<PiOpenImage>(
    (images, index, el) => setLightbox({ room: roomId, images, index, opener: el, root: el.closest<HTMLElement>("[data-pi-root]") }),
    [roomId, setLightbox],
  )
  // 换了会话：上一个会话的灯箱不再显示
  const lightboxShown = lightbox && lightbox.room === roomId ? lightbox : null

  const itemsRef = useRef(source)
  useLayoutEffect(() => {
    itemsRef.current = source
  })
  const retryReady = relay.retryReady
  const sendText = relay.sendText
  const notify = relay.notify
  const actions = useMemo<PiTranscriptActions>(
    () => ({
      openFile: (path) => act.openFile(path),
      retrySend: (item: PiUserItem) => {
        if (retryReady) void sendText(item.text, item.key)
      },
      regenerate: () => openPiDialog({ act, variant }, { id: PI_UI_IDS.regenerate, arg: roomId }),
      copyReply: async (item) => {
        const ok = await piCopyText(turnTextOf(itemsRef.current, item.key))
        if (!ok) notify("复制失败：浏览器不允许写剪贴板", "bad")
        return ok
      },
      loadImage,
      imageLoad: (image) => {
        const ref = remoteImageRef(image)
        return ref ? loadMap[imageKey(ref)] : undefined
      },
    }),
    [act, variant, roomId, retryReady, sendText, notify, loadImage, loadMap, itemsRef],
  )

  // 流顶一行：外壳的说明 + 本机记录 / 正在拉快照 + 补拉状态
  const loadEarlier = relay.loadEarlierHistory
  const deviceName = lazy ? (relay.devices.find((d) => d.id === lazy.deviceId)?.name ?? relay.selectedDevice?.name ?? null) : null
  const own: PiTopLine[] = []
  if (lazy) own.push(...archiveTopLinesOf(archive, deviceName))
  else if (snapshotPending && liveItems.length === 0) own.push({ text: COPY.snapshotPending, spinner: true })
  // Content decryption states (crypto Phase 3): honest, plain-language
  // room states -- never silent blanks and never garbled content.
  if (!lazy) {
    if (relay.roomCryptoStatus === "waiting-ack") own.push({ text: "这个房间已加密，正在等待内容钥送达", tone: "muted" })
    if (relay.roomCryptoStatus === "mismatch") own.push({ text: "内容钥不一致：本机持有的内容钥与这个房间的钥不是同一把，消息无法解密", tone: "error" })
    if (relay.roomCryptoStatus === "crypto-required") own.push({ text: "这个房间已加密，当前观看端无法读取加密内容", tone: "error" })
    if (relay.decryptFailureCount > 0) own.push({ text: `有 ${relay.decryptFailureCount} 条消息无法解密`, tone: "muted" })
  }
  const history = lazy ? null : historyTopLineOf(relay.history, roomId)
  if (history) own.push(history)
  const lines: PiStreamTopLineItem[] = own.map((l) => ({
    text: l.text,
    tone: l.tone,
    spinner: l.spinner,
    action: l.actionText,
    onAction: l.action === "load-earlier" ? () => void loadEarlier() : undefined,
  }))
  const topLine: ReactNode =
    extras?.topLine != null || lines.length > 0 ? (
      <>
        {extras?.topLine}
        {lines.length > 0 && <PiStreamTopLine lines={lines} />}
      </>
    ) : undefined

  // 吸底状态交给 dock；卸掉时复位
  useEffect(() => () => piTranscriptStick.reset(), [])
  const stickRef = useCallback((handle: { scrollToBottom: () => void } | null) => {
    piTranscriptStick.handle.current = handle
  }, [])

  return (
    <>
      <PiTranscript
        ref={stickRef}
        items={items}
        variant={variant}
        density={ui.prefs.density}
        now={now}
        sessionKey={roomId}
        topLine={topLine}
        running={running}
        subagents={subagents.length > 0 ? subagents : undefined}
        expanded={expanded}
        foldLong={!!lazy}
        onStickChange={piTranscriptStick.report}
        onOpenImage={openImage}
        actions={actions}
      />
      {lightboxShown?.root
        ? createPortal(
            <TranscriptLightbox
              images={lightboxShown.images}
              index={lightboxShown.index}
              opener={lightboxShown.opener}
              variant={variant}
              loads={loadMap}
              onLoad={loadImage}
              onIndexChange={(index) => setLightbox((cur) => (cur ? { ...cur, index } : cur))}
              onClose={() => setLightbox(null)}
            />,
            lightboxShown.root,
          )
        : null}
    </>
  )
}

const EMPTY_ITEMS: Item[] = []
const EMPTY_LOADS: Record<string, PiImageLoad> = {}

function imageKey(ref: RemoteImageRef): string {
  return `${ref.entryId}\n${ref.blockIndex}`
}

/**
 * 灯箱（D15 / D17）：有像素的图直接显示；过大没传的图用 get_image 取原图（加载中居中 Spinner，失败"加载失败 · 重试"）；
 * 没有定位信息的图取不了，直接是失败态。关闭后焦点回被点开的那张图。
 */
function TranscriptLightbox({
  images,
  index,
  opener,
  variant,
  loads,
  onLoad,
  onIndexChange,
  onClose,
}: {
  images: readonly PiImagePart[]
  index: number
  opener: HTMLElement | null
  variant: "desktop" | "phone"
  loads: Record<string, PiImageLoad>
  onLoad: (image: PiImagePart) => void
  onIndexChange: (index: number) => void
  onClose: () => void
}) {
  const loadOf = (image: PiImagePart) => {
    const ref = remoteImageRef(image)
    return ref ? loads[imageKey(ref)] : undefined
  }
  const shown: PiLightboxImage[] = images.map((image) => ({ ...image, src: piImageSrcOf(image, loadOf(image)) }))
  const current = images[Math.min(Math.max(index, 0), images.length - 1)]
  const currentLoad = current ? loadOf(current) : undefined
  const src = shown[Math.min(Math.max(index, 0), shown.length - 1)]?.src
  const needsLoad = !!current && !src && remoteImageRef(current) != null && currentLoad == null
  useEffect(() => {
    if (needsLoad && current) onLoad(current)
  }, [needsLoad, current, onLoad])
  const state: "loaded" | "loading" | "failed" = src ? "loaded" : needsLoad || currentLoad?.phase === "loading" ? "loading" : "failed"
  return (
    <PiLightbox
      images={shown}
      index={index}
      variant={variant}
      state={state}
      onIndexChange={onIndexChange}
      onRetry={current && remoteImageRef(current) ? () => onLoad(current) : undefined}
      returnFocus={opener}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    />
  )
}
