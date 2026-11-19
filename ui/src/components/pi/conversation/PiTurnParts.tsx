import { useEffect, useRef, useState, type ReactNode } from "react"
import { GhostIconButton, InlineLink, MediaImage, UserMessage } from "@/components/kit"
import { usePiStatic } from "@/components/pi/shared/layers"
import { Check, Copy, Ellipsis, GitFork, ImageOff, RotateCcw, Smartphone } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { piBytes } from "@/components/pi/shared/format"
import { compressedImageText, remoteImageRef } from "@/conversation/remoteImage"
import { piImageSrcOf, usePiTranscriptActions } from "./actions"
import { PI_COPIED_MS } from "./clipboard"
import { T_ERROR, T_SECONDARY, TOUCH_44, TOUCH_44_TEXT } from "./styles"
import type { PiAssistantItem, PiImagePart, PiUserItem } from "@/components/pi/shared/types"

/* ------------------------------------------------------------------ 图片 */

/** 手机截图的中性占位（不贴位图）：浅色页面 + 底部键盘区（PiLightbox 也用） */
export function PhoneShotPlaceholder() {
  return (
    <div data-cw-placeholder="media" className="absolute inset-0 flex flex-col bg-(--cw-surface)">
      <div className="h-[9%] border-b border-(--cw-divider) bg-(--cw-sidebar-bg)" />
      <div className="flex flex-1 flex-col gap-[6%] p-[10%]">
        <div className="h-[4%] w-4/5 rounded-full bg-(--cw-divider)" />
        <div className="h-[4%] w-3/5 rounded-full bg-(--cw-divider)" />
        <div className="h-[4%] w-2/3 rounded-full bg-(--cw-divider)" />
      </div>
      <div className="mx-[6%] mb-[3%] h-[7%] rounded-full border border-(--cw-border) bg-(--cw-surface)" />
      <div className="h-[34%] bg-(--cw-chip-bg)" />
    </div>
  )
}

/**
 * 过大占位块（D15）："图片过大未传输（178 KB）· 加载原图"。可交互态（P5.4）：点"加载原图"用 get_image 取原图，
 * 取回来就地换成缩略图；加载中写"正在加载原图…"；失败就地"加载失败 · 重试"（M-04）；超过单帧上限写明无法加载。
 * 没有定位信息（entryId + blockIndex）的图取不了，不放"加载原图"。静态态（画廊）照冻结版画。
 */
function PiImageOmitted({ image }: { image: PiImagePart }) {
  const actions = usePiTranscriptActions()
  const size = image.bytes != null ? ` (${piBytes(image.bytes)})` : ""
  let tail: ReactNode = (
    <>
      {" "}
      ·{" "}
      <InlineLink className={cn("whitespace-nowrap", TOUCH_44_TEXT)}>Load original</InlineLink>
    </>
  )
  let text: ReactNode = `Image omitted${size}`
  if (actions) {
    const load = actions.imageLoad?.(image)
    const can = !!actions.loadImage && remoteImageRef(image) != null
    const go = () => actions.loadImage?.(image)
    if (load?.phase === "loading") tail = " · Loading original…"
    else if (load?.phase === "compressed") {
      text = compressedImageText(image.bytes)
      tail = null
    } else if (load?.phase === "error")
      tail = can ? (
        <>
          {" "}
          · <span title={load.error}>Failed to load</span> ·{" "}
          <InlineLink className={cn("whitespace-nowrap", TOUCH_44_TEXT)} onClick={go}>
            Retry
          </InlineLink>
        </>
      ) : (
        " · Failed to load"
      )
    else
      tail = can ? (
        <>
          {" "}
          ·{" "}
          <InlineLink className={cn("whitespace-nowrap", TOUCH_44_TEXT)} onClick={go}>
            Load original
          </InlineLink>
        </>
      ) : null
  }
  return (
    <div
      data-pi-part="image-omitted"
      data-load={actions?.imageLoad?.(image)?.phase}
      className="flex h-[72px] w-full max-w-[360px] items-center gap-2 rounded-(--cw-radius-card) bg-(--cw-chip-bg) px-3 text-(length:--cw-text-md)"
    >
      <ImageOff aria-hidden size={16} strokeWidth={1.5} className="shrink-0 text-(--cw-text-3)" />
      {/* 底色是 --cw-chip-bg：secondary 灰在上面只有 4.3:1，这里用 --cw-text-2（§4.6 AA） */}
      <span className="min-w-0 text-(--cw-text-2)">
        {text}
        {tail}
      </span>
    </div>
  )
}

/** 一张图：缩略图（圆角细描边）或过大占位（D15）。有像素时画真图（高固定、宽按图片比例），mock 没有像素画中性占位 */
export function PiImage({ image, height = 160 }: { image: PiImagePart; height?: number }) {
  const actions = usePiTranscriptActions()
  const src = piImageSrcOf(image, actions?.imageLoad?.(image))
  if (src) {
    return (
      <MediaImage
        data-pi-part="image"
        placeholder="plain"
        className="m-0 aspect-auto w-fit max-w-full border-(--cw-border)"
        style={{ height }}
      >
        <img src={src} alt="Image" draggable={false} className="block h-full w-auto max-w-full object-cover" />
      </MediaImage>
    )
  }
  if (image.omitted) return <PiImageOmitted image={image} />
  const aspect = image.aspect ?? 16 / 10
  return (
    <MediaImage
      data-pi-part="image"
      placeholder="plain"
      className="m-0 aspect-auto border-(--cw-border)"
      style={{ height, width: Math.round(height * aspect) }}
    >
      {aspect < 1 ? <PhoneShotPlaceholder /> : undefined}
    </MediaImage>
  )
}

/**
 * 图片网格（PiImageGrid；compose from kit: MediaImage）：最多 5 张，一行排开、放不下折行。
 * onOpen（可交互态，P4）：每张缩略图包成按钮，点了打开灯箱（el = 这张图，灯箱关闭后焦点回它）；过大占位不可点（里面有"加载原图"）。
 * 不传 onOpen 时 DOM 和冻结版一样。
 */
export function PiImageGrid({
  images,
  height = 160,
  onOpen,
}: {
  images: readonly PiImagePart[]
  height?: number
  onOpen?: (index: number, el: HTMLElement) => void
}) {
  const actions = usePiTranscriptActions()
  if (images.length === 0) return null
  const h = images.length > 1 ? Math.round(height * 0.75) : height
  // 过大没传的图取回原图后（P5.4）也能点开
  const openable = (img: PiImagePart) => !img.omitted || actions?.imageLoad?.(img)?.phase === "ready"
  return (
    <div data-pi-part="image-grid" className="flex flex-wrap gap-2">
      {images.map((img, i) =>
        onOpen && openable(img) ? (
          <button
            key={i}
            type="button"
            data-pi-part="image-open"
            aria-label={images.length > 1 ? `View image ${i + 1} / ${images.length}` : "View image"}
            className="block shrink-0 cursor-zoom-in rounded-(--cw-radius-card) p-0"
            onClick={(e) => onOpen(i, e.currentTarget)}
          >
            <PiImage image={img} height={h} />
          </button>
        ) : (
          <PiImage key={i} image={img} height={h} />
        ),
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ 用户卡 */

/**
 * 用户消息（PiUserTurn；compose from kit: UserMessage(card), MediaImage, GhostIconButton）。
 * 同列宽白卡；来自网页（from: "remote"）= 右上灰色手机小图标（推断）；卡下一行投递状态：
 * 发送失败（红字 + 重试）/ 等重连后发送（outbox，灰字）/ 已到设备 · 等待 pi 处理（设备已收下、pi 还没消费）/ 发送中…（ack 超过 200ms 才出现）。送达后不写字。
 */
export function PiUserTurn({
  item,
  imageHeight = 160,
  onOpenImage,
}: {
  item: PiUserItem
  imageHeight?: number
  /** 可交互态：点了卡里的一张图（打开灯箱）；不传 = 图不可点 */
  onOpenImage?: (images: readonly PiImagePart[], index: number, el: HTMLElement) => void
}) {
  const remote = item.from === "remote" || item.remote
  const actions = usePiTranscriptActions()
  const retry = actions?.retrySend
  // F4 queue actions for a bubble that is a remote-queue entry (item.queued);
  // shared by the queued label and the awaiting label below.
  const queueAction = (fn?: (item: PiUserItem) => void, label?: string) =>
    fn && label ? (
      <button
        key={label}
        type="button"
        className={cn("cursor-pointer text-inherit underline-offset-2 hover:underline", TOUCH_44_TEXT)}
        onClick={() => fn(item)}
      >
        {label}
      </button>
    ) : null
  const queueButtons = item.queued
    ? [
        queueAction(actions?.queueSendNow, "Send now"),
        queueAction(actions?.queueEdit, "Edit"),
        queueAction(actions?.queueCancel, "Cancel"),
      ].filter(Boolean)
    : []
  const queueButtonsSpan =
    queueButtons.length > 0 ? (
      <span className="inline-flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
        {queueButtons}
      </span>
    ) : null
  let status: ReactNode = null
  if (item.failed) {
    status = (
      <span className={T_ERROR} title={actions ? item.failed : undefined}>
        Failed to send ·{" "}
        <InlineLink className={cn("text-inherit underline underline-offset-2", TOUCH_44_TEXT)} onClick={retry ? () => retry(item) : undefined}>
          Retry
        </InlineLink>
      </span>
    )
  } else if (item.outbox) {
    status = <span className={T_SECONDARY}>{item.awaiting ? "Queued on device · waiting" : "Will send on reconnect"}</span>
  } else if (item.status === "awaiting") {
    // B-3/B-2 round 2: the device accepted the message but pi has not
    // consumed it yet (queued behind a busy pi, or in a crypto-required
    // room this viewer cannot observe). It must not sit at "sending":
    // same awaiting words as the outbox surfaces, with the F4 queue
    // actions still attached when the queue entry is known.
    status = (
      <span className={cn("inline-flex items-center gap-2", T_SECONDARY)}>
        <span>Queued on device · waiting for pi</span>
        {queueButtonsSpan}
      </span>
    )
  } else if (item.queued) {
    // F4: a queued prompt used to sit here as a dead "sending" bubble. It
    // now says it is queued and carries its own actions -- revealed on
    // hover / focus on fine pointers, always visible on touch.
    status = (
      <span className={cn("inline-flex items-center gap-2", T_SECONDARY)}>
        <span>Queued</span>
        {queueButtonsSpan}
      </span>
    )
  } else if (item.status === "sending") {
    status = <span className={T_SECONDARY}>Sending…</span>
  }
  return (
    <div data-pi-part="user-turn" className="group" data-status={item.failed ? "failed" : item.outbox ? "outbox" : item.queued ? "queued" : item.status}>
      {/* 卡下空 12（卡上 16 和回合间 24 折叠）：回合的内容贴着自己的提问 */}
      <UserMessage variant="card" align="right" className={cn("max-w-[85%]", status != null ? "mb-1" : "mb-(--cw-space-3)")}>
        <div className={cn(remote && "pr-5")}>
          {item.text && <div className="whitespace-pre-wrap">{item.text}</div>}
          {item.images.length > 0 && (
            <div className={cn(item.text && "mt-2", "mb-1")}>
              <PiImageGrid
                images={item.images}
                height={imageHeight}
                onOpen={onOpenImage ? (index, el) => onOpenImage(item.images, index, el) : undefined}
              />
            </div>
          )}
        </div>
        {/* 竖直对齐第一行文字的中线（卡内上距 8 + (行高 − 13) / 2 ≈ 12） */}
        {remote && (
          <Smartphone
            aria-label="Sent from web"
            size={13}
            strokeWidth={1.5}
            className="absolute top-3 right-3 text-(--cw-text-3)"
          />
        )}
      </UserMessage>
      {status != null && (
        <div className="mb-(--cw-space-3) flex justify-end px-1 text-(length:--cw-text-sm) leading-(--cw-leading-sm)">{status}</div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ 回复操作行 */

/**
 * 回复操作行（PiReplyActions；compose from kit: GhostIconButton；参照 ch5/ReplyActionsRow）：
 * 复制 / ↻ 重新回答（只在最后一条）/ … + 灰字"2 分钟前 · sonnet-4.5 · 29.6k tok"（D17 / D20）。
 * 手机只在回合最后一条常显（修 U-11）；点击区 44（§4.4）。
 */
export function PiReplyActions({
  meta,
  retry = true,
  copied: copiedProp,
  variant,
  item,
}: {
  meta: string
  retry?: boolean
  copied?: boolean
  variant: "desktop" | "phone"
  /** 可交互态（P5.4）：这一行属于哪条回复（复制回复用） */
  item?: PiAssistantItem
}) {
  const phone = variant === "phone"
  const isStatic = usePiStatic()
  const btn = cn(phone && TOUCH_44, "text-(--cw-text-3)")
  const actions = usePiTranscriptActions()
  // 复制成功后 ✓ 停 1.2 秒（同代码块复制钮）
  const [copiedNow, setCopiedNow] = useState(false)
  const [forking, setForking] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copied = copiedProp || copiedNow
  const copyReply = actions?.copyReply
  const onCopy =
    copyReply && item
      ? () => {
          void copyReply(item).then((ok) => {
            if (!ok) return
            setCopiedNow(true)
            window.clearTimeout(timer.current)
            timer.current = window.setTimeout(() => setCopiedNow(false), PI_COPIED_MS)
          })
        }
      : undefined
  const onRegenerate = actions?.regenerate
  const forkReply = actions?.forkReply
  const onFork =
    !isStatic && forkReply && item
      ? () => {
          if (forking) return
          setForking(true)
          void Promise.resolve(forkReply(item)).finally(() => setForking(false))
        }
      : undefined
  // 桌面：更早回合的操作行悬停 / 聚焦到这一回合时才出现（最后一回合常显；触屏没有悬停，常显）
  const onHover = !phone && !retry
  return (
    <div
      data-pi-part="reply-actions"
      className={cn(
        // 左缘往回收 3：钮里 14 的图标和正文左缘对齐（钮 20、图标居中）
        "mr-(--stream-inset) ml-[calc(var(--stream-inset)_-_3px)] flex items-center",
        phone ? "gap-6" : "gap-1",
        onHover
          ? // 藏着的行不再撑开回合间距：下边距 −18 和下一回合的 24 折叠成 6，正文到下一张用户卡 6 + 20 + 6 = 32
            cn(
              "mt-(--cw-space-1-5) -mb-[18px] opacity-0 transition-opacity duration-(--pi-motion-in) group-hover/turn:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100",
              (copied || forking) && "opacity-100",
            )
          : "my-(--cw-space-1-5)",
      )}
    >
      {/* 手机：图标视觉 20、间距 32 → 图标中心相距 52，44×44 点击区之间隔 8（§4.4；B2、R2-B-m5）；
          钮和灰字之间仍是原来的 24 + 6（灰字不是点击目标），免得灰字被挤到截断 */}
      <div className={cn("flex shrink-0 items-center", phone ? "gap-8" : "gap-1")}>
        <GhostIconButton
          size="sm"
          data-cw-id="pi-reply-copy"
          data-copied={copied ? "true" : undefined}
          label={copied ? "Copied" : "Copy reply"}
          title={copied ? "Copied" : "Copy reply"}
          icon={copied ? <Check /> : <Copy />}
          className={cn(btn, copied && "text-(--cw-green) hover:text-(--cw-green)")}
          onClick={onCopy}
        />
        {onFork && (
          <GhostIconButton
            size="sm"
            data-cw-id="pi-reply-fork"
            label="Fork"
            title="Fork conversation from this reply"
            icon={<GitFork />}
            disabled={forking}
            className={cn(btn, forking && "opacity-50")}
            onClick={onFork}
          />
        )}
        {retry && <GhostIconButton size="sm" label="Regenerate" icon={<RotateCcw />} className={btn} onClick={onRegenerate} />}
        {isStatic && <GhostIconButton size="sm" label="More" icon={<Ellipsis />} className={btn} />}
      </div>
      <span className={cn("ml-1.5 truncate text-(length:--cw-text-sm) leading-(--cw-leading-sm)", T_SECONDARY)}>{meta}</span>
    </div>
  )
}
