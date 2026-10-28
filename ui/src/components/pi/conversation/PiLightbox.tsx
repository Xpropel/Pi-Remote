import { useEffect, useRef, type ComponentProps, type CSSProperties, type ReactNode } from "react"
import { Dialog } from "radix-ui"
import { MediaImage } from "@/components/kit"
import { PiSpinner } from "@/components/pi/shared/PiSpinner"
import { PiOverlay } from "@/components/pi/shared/PiOverlay"
import { usePiControllableOpen, usePiStatic, type PiOverlayControl, type PiReturnFocus } from "@/components/pi/shared/layers"
import { X } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { PhoneShotPlaceholder } from "./PiTurnParts"
import { TOUCH_44_TEXT } from "./styles"
import type { PiImagePart } from "@/components/pi/shared/types"

/**
 * 灯箱里的一张图：原图像素尺寸用来限制"不放大超过原尺寸"（mock 里直接给）。
 * src（P5.4，产品）：原图的地址（随消息带来的像素，或 get_image 取回来的 data URL）。有 src 时画真图：
 * max-width / max-height 100% 本身就是"等比缩进可视区、不放大超过原尺寸"，不用知道像素尺寸。
 */
export type PiLightboxImage = PiImagePart & { width?: number; height?: number; src?: string }

export interface PiLightboxProps extends PiOverlayControl {
  images: readonly PiLightboxImage[]
  /** 当前第几张（从 0 起） */
  index: number
  variant: "desktop" | "phone"
  /** 原图状态：loading = 居中 Spinner；failed = 居中"加载失败 · 重试" */
  state?: "loaded" | "loading" | "failed"
  /** 关闭（Esc、×、点背景）：和 onOpenChange(false) 同时调 */
  onClose?: () => void
  /** 多图时左右键 / 左右滑切换 */
  onIndexChange?: (index: number) => void
  onRetry?: () => void
  /** 可交互：关闭后焦点回哪（容器传被点开的那张图；默认 = 打开前的焦点元素，design §4.7 焦点表） */
  returnFocus?: PiReturnFocus
  className?: string
}

/**
 * 右下"2 / 3"：灯箱上的次级文字（v1.3 §12.3-5）。固定色不跟主题：--cw-pi-lightbox-fg 只在 pi-theme.css 浅色块定义，
 * 合成底上约 7.4（浅色页）/ 10（深色页）。"加载失败""重试"和 spinner 直接用白色。
 */
const LIGHTBOX_FG = "text-[color:var(--cw-pi-lightbox-fg,#B4B4B8)]"
/** 全屏底：--cw-pi-lightbox-bg（rgba(0,0,0,.85)，不用 0.40 的 --cw-overlay，否则背后的流会透出来） */
const LIGHTBOX_BG: CSSProperties = { background: "var(--cw-pi-lightbox-bg, rgba(0,0,0,.85))" }

/**
 * 图片灯箱（PiLightbox；compose from kit: MediaImage, Spinner；版式 design §2 D15，推断）。
 * 全屏 --cw-pi-lightbox-bg。图片按可视区等比缩放（contain），四边各留 16，手机顶部让出安全区和 × 那一行（48）；不放大超过原尺寸。
 * 右上 × 白色 20 图标、点击区 48×48；Esc、点背景都关闭（手机返回手势由容器接）。双指缩放交给浏览器。
 * 多图：左右键 / 左右滑切换，右下灰字"2 / 3"。
 * 静态态（画廊）照冻结版画，不抢焦点、不挂监听。可交互（P4）：PiOverlay（Radix Dialog）——焦点进灯箱容器本身（不落在 × 上）、
 * Tab 圈在灯箱里、背后 inert、Esc 由 Radix 关；关闭后焦点回被点开的那张图（returnFocus）。不 portal：盖住所在的外壳（桌面 overlay 槽 /
 * 手机页面），所以手机的安全区变量照样拿得到。
 */
export function PiLightbox(props: PiLightboxProps) {
  const isStatic = usePiStatic(props.static)
  if (props.open === false || props.images.length === 0) return null
  return isStatic ? <PiLightboxStatic {...props} /> : <PiLightboxInteractive {...props} />
}

function clampIndex(index: number, count: number) {
  return Math.min(Math.max(index, 0), Math.max(count - 1, 0))
}

function labelOf(i: number, count: number) {
  return count > 1 ? `图片 ${i + 1} / ${count}` : "图片"
}

function PiLightboxStatic({ images, index, variant, state = "loaded", className }: PiLightboxProps) {
  const i = clampIndex(index, images.length)
  return (
    <div
      data-pi-part="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={labelOf(i, images.length)}
      tabIndex={-1}
      className={cn("absolute inset-0 z-(--cw-pi-z-modal) outline-none", className)}
      style={LIGHTBOX_BG}
    >
      <LightboxBody images={images} index={i} variant={variant} state={state} close={<CloseButton variant={variant} />} />
    </div>
  )
}

function PiLightboxInteractive({
  images,
  index,
  variant,
  state = "loaded",
  open: openProp,
  onOpenChange,
  onClose,
  onIndexChange,
  onRetry,
  returnFocus,
  className,
}: PiLightboxProps) {
  const [open, setOpen] = usePiControllableOpen(
    openProp,
    (next) => {
      onOpenChange?.(next)
      if (!next) onClose?.()
    },
    true,
  )
  const count = images.length
  const i = clampIndex(index, count)
  const go = (next: number) => {
    if (count > 1 && next >= 0 && next < count) onIndexChange?.(next)
  }
  // ←/→ 挂在灯箱容器（Radix Dialog.Content，焦点就在它或它里面）上，不挂 document；Esc 归 Radix
  const bodyRef = useRef<HTMLDivElement>(null)
  const goRef = useRef(go)
  useEffect(() => {
    goRef.current = go
  })
  useEffect(() => {
    const dialog = bodyRef.current?.parentElement
    if (!dialog) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") goRef.current(i - 1)
      else if (e.key === "ArrowRight") goRef.current(i + 1)
      else return
      e.preventDefault()
    }
    dialog.addEventListener("keydown", onKey)
    return () => dialog.removeEventListener("keydown", onKey)
  }, [i])
  const touchX = useRef<number | null>(null)
  return (
    <PiOverlay
      open={open}
      onOpenChange={setOpen}
      label={labelOf(i, count)}
      focus="content"
      returnFocus={returnFocus}
      portal={false}
      backdrop={false}
      layerData={{ "data-pi-lightbox-layer": "" }}
      contentData={{ "data-pi-part": "lightbox" }}
      className={cn("absolute inset-0", className)}
      style={LIGHTBOX_BG}
    >
      <div
        ref={bodyRef}
        className="absolute inset-0"
        // 点背景（四周空白、图片区里图片以外的地方）= 关闭
        onClick={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.piLightboxArea != null) setOpen(false)
        }}
        onTouchStart={(e) => {
          touchX.current = e.touches.length === 1 ? e.touches[0].clientX : null
        }}
        onTouchEnd={(e) => {
          const start = touchX.current
          touchX.current = null
          if (start == null) return
          const dx = e.changedTouches[0].clientX - start
          if (Math.abs(dx) > 48) go(dx < 0 ? i + 1 : i - 1)
        }}
      >
        <LightboxBody
          images={images}
          index={i}
          variant={variant}
          state={state}
          onRetry={onRetry}
          close={
            <Dialog.Close asChild>
              <CloseButton variant={variant} />
            </Dialog.Close>
          }
        />
      </div>
    </PiOverlay>
  )
}

/** 右上 ×：白色 20 图标、点击区 48×48 */
function CloseButton({ variant, ...rest }: { variant: "desktop" | "phone" } & ComponentProps<"button">) {
  const phone = variant === "phone"
  return (
    <button
      type="button"
      data-pi-part="lightbox-close"
      aria-label="关闭图片"
      {...rest}
      className="absolute flex size-12 items-center justify-center rounded-full text-white hover:bg-white/10"
      style={{ top: phone ? "var(--cw-pi-safe-top)" : 8, right: phone ? 4 : 8 }}
    >
      <X aria-hidden size={20} strokeWidth={1.75} />
    </button>
  )
}

/** 灯箱里的内容（两种态共用）：图片区 → × → 多图时右下"2 / 3" */
function LightboxBody({
  images,
  index: i,
  variant,
  state,
  onRetry,
  close,
}: {
  images: readonly PiLightboxImage[]
  index: number
  variant: "desktop" | "phone"
  state: "loaded" | "loading" | "failed"
  onRetry?: () => void
  close: ReactNode
}) {
  const phone = variant === "phone"
  const count = images.length
  const image = images[i]
  const aspect = image.aspect ?? (image.width && image.height ? image.width / image.height : 16 / 10)
  // contain：宽取 min(原图宽, 可用宽, 可用高 × 宽高比)，高由 aspect-ratio 推出（cqw / cqh = 图片区的可用尺寸）
  const naturalW = image.width ?? 100_000
  const imgStyle: CSSProperties = {
    aspectRatio: String(aspect),
    width: `min(${naturalW}px, 100cqw, calc(100cqh * ${aspect}))`,
  }
  return (
    <>
      {/* 图片区：四边 16，手机顶部再让出安全区；多图时底部再让出"2 / 3"一行（手机还让出 Home 指示条）；点空白处 = 点背景 */}
      <div
        data-pi-lightbox-area=""
        className="absolute inset-x-4 flex items-center justify-center [container-type:size]"
        style={{
          // 手机：安全区下面先是 × 的 48 一行，图片从它下面开始，免得白色 × 压在浅色图上看不见
          top: phone ? "calc(var(--cw-pi-safe-top) + 48px)" : 16,
          bottom: count > 1 ? (phone ? "calc(var(--cw-pi-safe-bottom) + 28px)" : 44) : 16,
        }}
      >
        {state === "loading" ? (
          // 不传 tone="muted"：它会设 --cw-status-spinner，和白色冲突（§12.3-5）
          <PiSpinner size={20} label="正在加载原图" className="text-white" />
        ) : state === "failed" ? (
          <div className="text-(length:--cw-text-md) text-white">
            加载失败 ·{" "}
            {/* 点击区 46×46（两个字只有约 26–30 宽，§4.4、§12.3-5） */}
            <button type="button" className={cn("text-white underline underline-offset-2", TOUCH_44_TEXT)} onClick={onRetry}>
              重试
            </button>
          </div>
        ) : image.src ? (
          <img
            data-pi-part="lightbox-image"
            src={image.src}
            alt={count > 1 ? `原图，第 ${i + 1} 张，共 ${count} 张` : "原图"}
            draggable={false}
            className="block max-h-full max-w-full object-contain"
          />
        ) : (
          <MediaImage
            data-pi-part="lightbox-image"
            role="img"
            aria-label={count > 1 ? `原图，第 ${i + 1} 张，共 ${count} 张` : "原图"}
            placeholder="screenshot"
            className="m-0 aspect-auto rounded-none border-0"
            style={imgStyle}
          >
            {aspect < 1 ? <PhoneShotPlaceholder /> : undefined}
          </MediaImage>
        )}
      </div>
      {close}
      {count > 1 && (
        <div
          data-pi-part="lightbox-counter"
          aria-hidden
          className={cn("pointer-events-none absolute right-4 tabular-nums text-(length:--cw-text-md)", LIGHTBOX_FG)}
          style={{ bottom: phone ? "var(--cw-pi-safe-bottom)" : 14 }}
        >
          {i + 1} / {count}
        </div>
      )}
    </>
  )
}
