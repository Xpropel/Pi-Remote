import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react"
import { cn } from "@/lib/utils"

export interface ChatColumnThumb {
  /** 滑块顶边，相对对话区顶（CSS px） */
  top: number
  /** 滑块高（CSS px） */
  height: number
}

export interface ChatColumnProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  /**
   * centered：右 pane 关闭，列在主区里居中限宽（--cw-content-max-w；#1 #3 #6 #7 #9 #21）；
   * pane：右 pane 打开时的窄列，只留左右 16 的边距（#4 #5 #12 #14 #15 #25–#28）；
   * coordinator：Projects 协调者对话，无边距、正文不内缩（#23 #24），位置由屏幕给。
   */
  layout?: "centered" | "pane" | "coordinator"
  children?: ReactNode
  /** 吸顶区：首条用户消息（#1 #5 #28）、TodoProgressCard（#12）；正文从它下面滚过 */
  header?: ReactNode
  /** 浮在流底部、composer 上方的一行：ActionPillRow、scroll-down 圆钮（#1 #3 #6 #7 #14 #21 #23 #25） */
  above?: ReactNode
  /** composer 插槽 */
  footer?: ReactNode
  /** 底部渐隐：true = 48px，数字 = 渐隐长度（CSS px），false = 关 */
  fade?: boolean | number
  /** 覆盖 centered 的限宽（CSS px 或 CSS 长度） */
  maxWidth?: number | string
  /** agent 正文相对用户消息的左右内缩（默认 --cw-space-2 = 8；coordinator 默认 0） */
  inset?: number | string
  /** 初始滚动位置（CSS px）或 "bottom"；静态帧用它复现"正文已滚到吸顶气泡下面" */
  scrollTop?: number | "bottom"
  /** overlay 细滚动条：true = 按真实滚动计算；对象 = 静态滑块（帧里量到的位置） */
  scrollbar?: boolean | ChatColumnThumb
  /** 加在内容盒上的 class（覆盖上下内边距等） */
  contentClassName?: string
  /** 列左右外边距（CSS px 或长度），同时作用于滚动区、above、footer；默认 --cw-space-4 = 16（coordinator 无边距；kit-requests pi b） */
  gutter?: number | string
  /** 首块上方的内距（无吸顶区时在内容盒上、有吸顶区时在吸顶区上），默认 --cw-space-2-5 = 10（#7 6.6、#9 7.1、#28 7.1；kit-requests ch2 #7、ch5 #17） */
  topInset?: number | string
}

/**
 * 对话列：滚动的消息流 + 吸顶区 + 底部浮层（pill 行）+ composer 插槽 + 渐隐 + overlay 滚动条。
 * 根节点填满父容器（h-full），宽高由屏幕给；背景透明，底色来自主区。
 * 原生滚动条隐藏，滑块用 --cw-scrollbar-thumb / --cw-scrollbar-w（tokens.local.css，#1 实测 8 源 px 灰条）代替。
 */
export function ChatColumn({
  layout = "centered",
  children,
  header,
  above,
  footer,
  fade = true,
  maxWidth,
  inset,
  scrollTop,
  scrollbar,
  contentClassName,
  gutter: gutterProp,
  topInset,
  className,
  style,
  ...rest
}: ChatColumnProps) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const liveThumb = useScrollThumb(scrollerRef, contentRef, scrollbar === true)
  useInitialScroll(scrollerRef, contentRef, scrollTop)

  const gutter = layout === "coordinator" && gutterProp === undefined ? undefined : "px-[var(--chat-gutter,var(--cw-space-4))]"
  const len = (v: number | string | undefined) => (typeof v === "number" ? `${v}px` : v)
  const box = cn("mx-auto w-full", layout === "centered" && maxWidth === undefined && "max-w-(--cw-content-max-w)")
  const boxStyle: CSSProperties | undefined = maxWidth !== undefined ? { maxWidth } : undefined
  const insetValue = inset ?? (layout === "coordinator" ? 0 : "var(--cw-space-2)")
  const fadeLen = fade === false ? null : fade === true ? "calc(var(--cw-space-8) + var(--cw-space-4))" : `${fade}px`
  // 遮罩只管透明度：底边留 15% 可见（#1 "What was broken" 约 35% 不透明、#14 pill 旁的正文仍隐约可见）
  const mask = fadeLen ? `linear-gradient(to top, rgb(0 0 0 / 0.15), black ${fadeLen})` : undefined
  const thumb = typeof scrollbar === "object" ? scrollbar : liveThumb

  return (
    <div
      data-layout={layout}
      className={cn("relative flex h-full min-h-0 w-full flex-col", className)}
      style={{
        ["--stream-inset" as string]: typeof insetValue === "number" ? `${insetValue}px` : insetValue,
        ...(gutterProp !== undefined ? { ["--chat-gutter" as string]: len(gutterProp) } : null),
        ...(topInset !== undefined ? { ["--chat-top-inset" as string]: len(topInset) } : null),
        ...style,
      }}
      {...rest}
    >
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollerRef}
          data-cw-scroller=""
          className="absolute inset-0 overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
        >
          <div className={gutter}>
            <div
              ref={contentRef}
              className={cn(
                box,
                "flow-root",
                header == null && "pt-[var(--chat-top-inset,var(--cw-space-2-5))]",
                above == null
                  ? "pb-(--cw-space-4)"
                  : "pb-[calc(var(--cw-pill-h)_+_var(--cw-space-2-5)_+_var(--cw-space-4))]",
                contentClassName,
              )}
              style={boxStyle}
            >
              {header != null && (
                <div className="sticky top-0 z-10 bg-(--cw-bg) pt-[var(--chat-top-inset,var(--cw-space-2-5))] [&>*]:mt-0">{header}</div>
              )}
              {children}
            </div>
          </div>
        </div>
        {above != null && (
          <div className={cn("pointer-events-none absolute inset-x-0 bottom-0", gutter)}>
            <div className={cn(box, "pb-(--cw-space-2-5) [&>*]:pointer-events-auto")} style={boxStyle}>
              {above}
            </div>
          </div>
        )}
        {thumb && (
          <div
            aria-hidden
            data-cw-part="scrollbar"
            className="pointer-events-none absolute right-(--cw-space-1) w-(--cw-scrollbar-w) rounded-full bg-(--cw-scrollbar-thumb)"
            style={{ top: thumb.top, height: thumb.height }}
          />
        )}
      </div>
      {footer != null && (
        <div className={cn("flex-none", gutter)}>
          <div className={cn(box, "pb-(--cw-space-4)")} style={boxStyle}>
            {footer}
          </div>
        </div>
      )}
    </div>
  )
}

/** 按真实滚动算 overlay 滑块位置；内容不超出时不画 */
function useScrollThumb(
  scrollerRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
): ChatColumnThumb | null {
  const [thumb, setThumb] = useState<ChatColumnThumb | null>(null)
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!enabled || !el) {
      setThumb(null)
      return
    }
    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = el
      if (scrollHeight <= clientHeight + 1) {
        setThumb(null)
        return
      }
      const height = Math.max(24, (clientHeight * clientHeight) / scrollHeight)
      const top = ((clientHeight - height) * scrollTop) / (scrollHeight - clientHeight)
      setThumb({ top, height })
    }
    update()
    el.addEventListener("scroll", update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    if (contentRef.current) ro.observe(contentRef.current)
    return () => {
      el.removeEventListener("scroll", update)
      ro.disconnect()
    }
  }, [enabled, scrollerRef, contentRef])
  return thumb
}

/** 首次布局时设置滚动位置；"bottom" 在内容尺寸变化（字体加载）后继续贴底 */
function useInitialScroll(
  scrollerRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  scrollTop: number | "bottom" | undefined,
) {
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el || scrollTop === undefined) return
    const apply = () => {
      el.scrollTop = scrollTop === "bottom" ? el.scrollHeight : scrollTop
    }
    apply()
    const ro = new ResizeObserver(apply)
    if (contentRef.current) ro.observe(contentRef.current)
    // 只在内容尺寸变化时重放；用户手动滚动后不再强拉
    const stop = () => ro.disconnect()
    el.addEventListener("wheel", stop, { passive: true, once: true })
    el.addEventListener("touchstart", stop, { passive: true, once: true })
    return () => {
      ro.disconnect()
      el.removeEventListener("wheel", stop)
      el.removeEventListener("touchstart", stop)
    }
  }, [scrollTop, scrollerRef, contentRef])
}
