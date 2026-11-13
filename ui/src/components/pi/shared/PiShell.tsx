import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { phoneDockLayout } from "@/pi/model/phoneDock"
import { PiDockLayoutContext, usePiFrame } from "./frame"

/* ======================= 桌面 1440×900 ======================= */

/** 平板档 pane 浮层外按下也不收起的目标：通知卡，和自带动作的控件（「终端 / 改动」pill、文件链接、顶栏开关自己会开关 pane，先收再开会闪或开不回来） */
const PANE_DISMISS_SKIP =
  "[data-pi-notice-slot], button, a[href], summary, select, [role='button'], [role='link'], [role='tab'], [role='menuitem'], [role='switch'], [role='checkbox']"

export interface PiDesktopShellProps {
  /** 左栏（PiSidebar variant expanded / rail） */
  sidebar: ReactNode
  /** 主区顶栏（PiTopBar variant desktop） */
  topBar?: ReactNode
  /** 顶栏下的连接状态行（PiStatusLine），异常时才有 */
  statusLine?: ReactNode
  /** 通知卡（PiNoticeCard）：浮在主区正文上方 12px、水平居中，不挤占布局、不压 dock；层级 raised，菜单 / sheet / 弹窗都盖在它上面 */
  notice?: ReactNode
  /** 主区正文（对话流等）：放在满高的 relative 盒里，自己负责滚动。列宽用 var(--cw-pi-chat-w)、左右留白用 var(--cw-pi-chat-gutter) */
  children?: ReactNode
  /** 贴底的 dock（PiComposerDock）：与对话列同宽，底边距 16 */
  dock?: ReactNode
  /** 右 pane（终端 / 改动 / 文件）；不传 = 关闭 */
  pane?: ReactNode
  /** 右 pane 宽度（CSS px），默认 460（--cw-pi-pane-w） */
  paneWidth?: number
  /** 全屏浮层（PiDialog、命令面板等），盖住整个外壳 */
  overlay?: ReactNode
  /**
   * 平板档（视口 768–1023）：侧栏只占一条窄栏，展开时浮在正文上；右 pane 也浮在正文右侧，对话列照 pane 关着排。
   * 不传 = 桌面档（侧栏、pane 都占位）。
   */
  tablet?: boolean
  /** 平板档的侧栏浮层开着：展开的侧栏盖在正文上，外面铺一层透明遮罩接点击 */
  sidebarOverlay?: boolean
  /** 点侧栏浮层外面时调用 */
  onSidebarOverlayClose?: () => void
  /** 平板档：在 pane 浮层外面（正文 / 窄栏）按下时调用；按在按钮、链接这类控件和通知卡上不算 */
  onPaneDismiss?: () => void
  className?: string
}

/**
 * 1440 三栏骨架（design §3.1）：左栏 256 → 主区（顶栏 44 → 状态行 → 正文 → dock）→ 可选右 pane 460。
 * 在根上设两个变量给正文和 dock 用：--cw-pi-chat-w（右 pane 关闭时 768，打开时占满）、--cw-pi-chat-gutter（40 / 24）。
 * 平板档：侧栏槽固定窄栏宽（--cw-pi-tablet-rail-w），侧栏浮层（sheet 层）与 pane（raised 层）都不挤压主区；
 * 遮罩在 popover 层，盖住主区与 pane、低于侧栏。pane 浮层最多盖住正文的一半（--cw-pi-pane-float-max-w），
 * 不铺遮罩：正文照样能滚、控件照样能点，点在正文其余地方才收起（onPaneDismiss）；通知卡只在 pane 左边的可见区居中。
 */
export function PiDesktopShell({
  sidebar,
  topBar,
  statusLine,
  notice,
  children,
  dock,
  pane,
  paneWidth,
  overlay,
  tablet = false,
  sidebarOverlay = false,
  onSidebarOverlayClose,
  onPaneDismiss,
  className,
}: PiDesktopShellProps) {
  const paneOpen = pane != null
  const paneInFlow = paneOpen && !tablet
  const drawerOpen = tablet && sidebarOverlay
  const paneFloatW = `min(${paneWidth != null ? `${paneWidth}px` : "var(--cw-pi-pane-w)"}, var(--cw-pi-pane-float-max-w))`
  const rootRef = useRef<HTMLDivElement>(null)
  const dismissPane = useRef(onPaneDismiss)
  useLayoutEffect(() => {
    dismissPane.current = onPaneDismiss
  })
  const paneDismissable = paneOpen && tablet && !drawerOpen && onPaneDismiss != null
  useEffect(() => {
    const root = rootRef.current
    if (!root || !paneDismissable) return
    let pendingTap: (() => void) | null = null
    const dropPendingTap = () => {
      if (pendingTap) root.removeEventListener("click", pendingTap, true)
      pendingTap = null
    }
    const onPointerDown = (event: PointerEvent) => {
      dropPendingTap()
      const target = event.target instanceof Element ? event.target : null
      // 只认正文和窄栏：pane 自己、弹窗槽、portal 出去的菜单都不在这两块里
      if (!target?.closest("[data-pi-main], [data-pi-sidebar-slot]") || target.closest(PANE_DISMISS_SKIP)) return
      if (event.pointerType === "mouse") {
        dismissPane.current?.()
        return
      }
      // 触屏 / 笔按下去可能是在滑正文：等 click 真来了再收（滑动不会有 click）
      pendingTap = () => {
        pendingTap = null
        dismissPane.current?.()
      }
      root.addEventListener("click", pendingTap, { capture: true, once: true })
    }
    root.addEventListener("pointerdown", onPointerDown, true)
    return () => {
      dropPendingTap()
      root.removeEventListener("pointerdown", onPointerDown, true)
    }
  }, [paneDismissable])
  const vars = {
    "--cw-pi-chat-w": paneInFlow ? "100%" : "var(--cw-pi-chat-max-w)",
    "--cw-pi-chat-gutter": paneInFlow ? "24px" : "40px",
  } as CSSProperties
  return (
    <div
      ref={rootRef}
      data-pi-shell="desktop"
      data-pane-open={paneOpen ? "" : undefined}
      data-pi-tablet={tablet ? "" : undefined}
      className={cn("absolute inset-0 flex overflow-hidden bg-(--cw-bg)", className)}
      style={vars}
    >
      {tablet ? (
        <div data-pi-sidebar-slot="" className="relative h-full w-(--cw-pi-tablet-rail-w) shrink-0">
          <div
            data-pi-sidebar-float=""
            data-open={drawerOpen ? "" : undefined}
            className={cn("absolute inset-y-0 left-0 z-(--cw-pi-z-sheet) flex", drawerOpen && "shadow-(--cw-shadow-popover)")}
          >
            {sidebar}
          </div>
        </div>
      ) : (
        sidebar
      )}
      <main data-pi-main="" className="relative flex h-full min-w-0 flex-1 flex-col bg-(--cw-bg)">
        {topBar}
        {statusLine}
        <div data-pi-main-body="" className="relative flex min-h-0 flex-1 flex-col">
          <div data-pi-main-content="" className="relative min-h-0 flex-1">
            {children}
          </div>
          {dock != null && (
            <div data-pi-dock="" className="relative shrink-0 px-(--cw-pi-chat-gutter) pb-4">
              <div className="mx-auto w-full max-w-(--cw-pi-chat-w)">{dock}</div>
            </div>
          )}
          {notice != null && (
            <div
              data-pi-notice-slot=""
              className="pointer-events-none absolute inset-x-0 top-3 z-(--cw-pi-z-raised) flex justify-center px-(--cw-pi-chat-gutter)"
              style={paneOpen && tablet ? { right: paneFloatW } : undefined}
            >
              <div className="pointer-events-auto max-w-full">{notice}</div>
            </div>
          )}
        </div>
      </main>
      {paneOpen && (
        <aside
          data-pi-pane=""
          data-floating={tablet ? "" : undefined}
          className={cn(
            "flex h-full shrink-0 flex-col border-l border-(--cw-divider) bg-(--cw-surface-pane)",
            tablet ? "absolute inset-y-0 right-0 z-(--cw-pi-z-raised) max-w-full shadow-(--cw-shadow-popover)" : "relative",
          )}
          style={{ width: tablet ? paneFloatW : (paneWidth ?? "var(--cw-pi-pane-w)") }}
        >
          {pane}
        </aside>
      )}
      {drawerOpen && (
        <div data-pi-sidebar-scrim="" aria-hidden className="absolute inset-0 z-(--cw-pi-z-popover)" onClick={onSidebarOverlayClose} />
      )}
      {overlay != null && (
        // 可交互的浮层关着时什么都不渲染：空槽 display:none，不挡住整个外壳的点击
        <div data-pi-overlay="" className="absolute inset-0 z-(--cw-pi-z-modal) empty:hidden">
          {overlay}
        </div>
      )}
    </div>
  )
}

/* ======================= 手机 390×844 ======================= */

/** 中性状态栏占位：只画时间，右侧标"占位"（design §3.1；不画信号 / 电池图标） */
export function PiStatusBarPlaceholder() {
  return (
    <div
      data-pi-statusbar=""
      data-cw-placeholder="status-bar"
      aria-hidden
      className="flex shrink-0 items-end justify-between px-[30px] pb-[9px]"
      style={{ height: "var(--cw-pi-safe-top)" }}
    >
      <span className="text-[16px] leading-[20px] font-semibold tracking-[-0.2px] text-(--cw-text)">9:41</span>
      <span className="text-[11px] leading-[14px] text-(--cw-text-4)">状态栏占位</span>
    </div>
  )
}

/** Home 指示条占位：134×5，距底 8（design §3.1） */
export function PiHomeIndicator() {
  return (
    <div
      data-pi-home-indicator=""
      data-cw-placeholder="home-indicator"
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 z-(--cw-pi-z-chrome) flex justify-center"
      style={{ height: "var(--cw-pi-safe-bottom)" }}
    >
      <span className="absolute bottom-2 h-[5px] w-[134px] rounded-full bg-(--cw-pi-home-indicator)" />
    </div>
  )
}

/** 产品模式（P6.1）里状态栏位置只留安全区那么高的空白：系统自己画状态栏，"9:41 / 状态栏占位"只给舞台用 */
function PiSafeTopSpacer() {
  return <div aria-hidden data-pi-safe-top="" className="shrink-0" style={{ height: "var(--cw-pi-safe-top)" }} />
}

export interface PiPhonePageProps {
  /**
   * 哪一页（P6.1）：写成 data-pi-page。chat = 对话页，平板（视口宽 ≥ 768）下对话列和 dock 限宽 768 居中（pi-theme.css）；
   * list / push 不限宽。不传 = 不标
   */
  page?: "list" | "chat" | "push"
  /** 顶栏（PiTopBar phone-list / phone-chat / phone-page） */
  topBar?: ReactNode
  /** 顶栏下的连接状态行 */
  statusLine?: ReactNode
  /** 钉在顶栏（和状态行）下、滚动区上的一条，不随滚动（推入页的工具行、面包屑） */
  subHeader?: ReactNode
  /** 通知卡：顶部偏移 = 安全区 + 顶栏 52 + 8，左右 16；层级 raised，不盖菜单 / sheet */
  notice?: ReactNode
  /** 唯一的滚动区 */
  children?: ReactNode
  /** 对话页的 dock（PiComposerDock） */
  dock?: ReactNode
  /** 列表页的账户栏（PiAccountFooter phone） */
  footer?: ReactNode
  /**
   * 键盘开着：根节点底部让出 --cw-pi-keyboard-h（舞台 844 − 336 = 508），Home 指示条隐藏，dock / 账户栏底部内边距 8。
   * 不传 = 跟 PiRoot 的视口帧（usePiFrame().keyboardOpen：舞台 = 屏幕的 keyboard 标记，产品 = useMobileViewport）
   */
  keyboardOpen?: boolean
  /** 底部 sheet（PiSheet / PiDialog 的手机形态）：渲染在本页树里，盖住整页 */
  sheet?: ReactNode
  /** 全屏浮层 */
  overlay?: ReactNode
  /** 滚动区初始位置："bottom" = 贴底（对话页），数字 = scrollTop */
  scrollTop?: number | "bottom"
  /** 滚动区内容盒的 class */
  contentClassName?: string
  /**
   * children 自己管滚动（PiTranscript / kit ChatColumn 这种 h-full 的滚动容器）：不再包一层页面滚动，
   * 直接放进满高的 relative 盒里。默认 false
   */
  selfScroll?: boolean
  /**
   * 嵌在共享移动壳（MobileNavShell）的会话区里：顶栏和顶部安全区由外壳给，这里不画状态栏占位 / 顶部留白，
   * 通知卡从本页顶端起算。父盒要 relative。默认 false
   */
  embedded?: boolean
  className?: string
}

/**
 * 390 单页骨架（design §3.1、§4）：状态栏占位 47 → 顶栏 52 → 状态行 →（subHeader）→ 唯一滚动区 → dock / 账户栏 → Home 指示条 34。
 * 键盘开着时根节点底部让出 --cw-pi-keyboard-h（舞台画键盘占位），dock 贴在键盘上方、底距 8。
 * P6：键盘状态默认跟 PiRoot 的视口帧；dock / 账户栏底部 = max(安全区, 8)（§4.3，舞台 34 不变）；
 * dock 的高度上限由 phoneDockLayout 算（usePiDockLayout）；产品模式不画状态栏 / Home 指示条占位（系统自己画）。
 */
export function PiPhonePage({
  page,
  topBar,
  statusLine,
  subHeader,
  notice,
  children,
  dock,
  footer,
  keyboardOpen: keyboardProp,
  sheet,
  overlay,
  scrollTop,
  contentClassName,
  selfScroll = false,
  embedded = false,
  className,
}: PiPhonePageProps) {
  const frame = usePiFrame()
  const keyboardOpen = keyboardProp ?? frame.keyboardOpen
  const product = frame.mode === "product"
  const dockLayout = dock != null ? phoneDockLayout(frame.vvHeight, keyboardOpen, null) : null
  const dockVars = dockLayout
    ? ({ "--cw-pi-dock-max": `${dockLayout.dockMax}px`, "--cw-pi-approval-max": `${dockLayout.approvalMax}px` } as CSSProperties)
    : undefined
  // 键盘开着：dock / 账户栏底距 8（键盘已盖住 Home 指示条）；收起：底部留 max(安全区, 8)，没有 dock / 账户栏的页面只留安全区
  const bottomPad = keyboardOpen ? { paddingBottom: 8 } : undefined
  const bottomSpace = dock != null || footer != null ? "max(var(--cw-pi-safe-bottom), 8px)" : "var(--cw-pi-safe-bottom)"
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el || scrollTop === undefined) return
    const apply = () => {
      el.scrollTop = scrollTop === "bottom" ? el.scrollHeight : scrollTop
    }
    apply()
    const ro = new ResizeObserver(apply)
    if (contentRef.current) ro.observe(contentRef.current)
    const stop = () => ro.disconnect()
    el.addEventListener("touchstart", stop, { passive: true, once: true })
    el.addEventListener("wheel", stop, { passive: true, once: true })
    return () => ro.disconnect()
  }, [scrollTop])
  return (
    <div
      data-pi-shell="phone"
      data-pi-page={page}
      data-keyboard-open={keyboardOpen ? "" : undefined}
      className={cn(
        "absolute inset-0 flex flex-col overflow-hidden bg-(--cw-bg)",
        // 嵌在移动壳里时，外壳根节点改过的字体 / 字号 / 颜色不能漏进来：恢复成 PiRoot 给的那一套
        embedded && "font-(family-name:--cw-font-sans) text-(length:--cw-text-base) leading-(--cw-leading-base) text-(--cw-text)",
        className,
      )}
      style={keyboardOpen ? { paddingBottom: "var(--cw-pi-keyboard-h)" } : undefined}
    >
      {embedded ? null : product ? <PiSafeTopSpacer /> : <PiStatusBarPlaceholder />}
      {topBar}
      {statusLine}
      {subHeader != null && (
        <div data-pi-subheader="" className="relative shrink-0">
          {subHeader}
        </div>
      )}
      <div data-pi-phone-body="" className="relative min-h-0 flex-1">
        {selfScroll ? (
          <div className={cn("absolute inset-0", contentClassName)}>{children}</div>
        ) : (
          <div
            ref={scrollerRef}
            data-pi-scroller=""
            className="absolute inset-0 overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <div ref={contentRef} className={cn("flow-root", contentClassName)}>
              {children}
            </div>
          </div>
        )}
      </div>
      {dock != null && (
        <div
          data-pi-dock=""
          data-pi-dock-max={dockLayout?.dockMax}
          className="relative shrink-0"
          style={bottomPad ? { ...dockVars, ...bottomPad } : dockVars}
        >
          <PiDockLayoutContext.Provider value={dockLayout}>{dock}</PiDockLayoutContext.Provider>
        </div>
      )}
      {dock == null && footer != null && (
        <div data-pi-footer="" className="relative shrink-0" style={bottomPad}>
          {footer}
        </div>
      )}
      {!keyboardOpen && <div aria-hidden data-pi-safe-bottom="" className="shrink-0" style={{ height: bottomSpace }} />}
      {notice != null && (
        <div
          data-pi-notice-slot=""
          className="pointer-events-none absolute inset-x-4 z-(--cw-pi-z-raised) flex justify-center"
          style={{ top: embedded ? 8 : "calc(var(--cw-pi-safe-top) + var(--cw-pi-topbar-h-phone) + 8px)" }}
        >
          <div className="pointer-events-auto w-full">{notice}</div>
        </div>
      )}
      {sheet}
      {overlay != null && (
        <div data-pi-overlay="" className="absolute inset-0 z-(--cw-pi-z-modal) empty:hidden">
          {overlay}
        </div>
      )}
      {!keyboardOpen && !product && <PiHomeIndicator />}
    </div>
  )
}
