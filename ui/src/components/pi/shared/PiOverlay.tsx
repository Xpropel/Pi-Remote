import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode, type Ref } from "react"
// 部件里的 Dialog.Title / Dialog.Description / Dialog.Close 也从这里引（radix-ui 包，和 PiOverlay 同一个 Dialog 原语）
import { ContextMenu, Dialog, DropdownMenu } from "radix-ui"
import type { PiLayout } from "@/components/pi/shared/viewport"
import { cn } from "@/lib/utils"
import { GhostIconButton } from "@/components/kit"
import { X } from "@/components/kit/icons"
import { usePiMotion } from "@/pi/hooks/useReducedMotion"
import { sheetLayout, type PiSheetLayout } from "@/pi/model/phoneDock"
import { usePiFrame } from "./frame"
import {
  PiMenuSurfaceContext,
  usePiControllableOpen,
  usePiDialogFocus,
  usePiInertOthers,
  usePiLayer,
  usePiStatic,
  type PiMenuSurfaceOptions,
  type PiOverlayControl,
  type PiReturnFocus,
} from "./layers"

/*
 * 浮层原语（design §3.1、§4.7；PLAN 4.1 / 4.5）。每个都有两种渲染：
 *   - 静态态（画廊截图，usePiStatic 为 true）：和冻结版逐像素一致，纯 DOM，不接 Radix；
 *   - 可交互：PiSheet / PiDialog 都建在 PiOverlay 上（Radix Dialog：焦点锁、Esc、点遮罩关闭、背后 inert、焦点归还），
 *     PiMenu 用 Radix DropdownMenu / ContextMenu。各线自己的全屏浮层（命令面板、灯箱）也直接用 PiOverlay。
 * 层级只用 pi-theme.css 的 --cw-pi-z-* 五档（R2/p4-lanes.md §2）。
 */

/* ======================= 模态层（PiOverlay） ======================= */

/** 写在浮层元素上的 data-* 属性 */
export type PiDataAttributes = { [key: `data-${string}`]: string | undefined }

export interface PiOverlayProps {
  /** 受控的打开状态；不传 = 渲染即打开（父组件按条件渲染，在 onOpenChange(false) 时卸掉） */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** role="dialog" 的名字：没有 Dialog.Title（可见标题）时必填，例如"命令面板" */
  label?: string
  /**
   * 打开时焦点进哪（design §4.7 焦点表）：dialog = [data-pi-autofocus] → 输入框 → 主按钮 [data-pi-primary] → 第一个可聚焦元素；
   * sheet = 同上但不找主按钮；content = 浮层容器本身（灯箱）。找不到时都落在容器本身。
   */
  focus?: "dialog" | "sheet" | "content"
  /** 关闭后焦点回哪（默认 = 打开前的焦点元素；不在页面上了就回 [data-pi-focus-fallback] 顶栏标题） */
  returnFocus?: PiReturnFocus
  /** true（默认）= portal 到 body，fixed 盖住整个视口；false = 渲染在原位，absolute 盖住最近的定位祖先（PiPhonePage 的 sheet 槽） */
  portal?: boolean
  /** 层级：modal（默认，--cw-pi-z-modal）；sheet（--cw-pi-z-sheet，手机 sheet） */
  tier?: "modal" | "sheet"
  /** 压暗层 --cw-overlay（默认 true；灯箱自己画底时传 false）。点它 = 关闭 */
  backdrop?: boolean
  /** 外层（盖满的那一层）的 class / style / data-*，例如居中卡用 "flex items-center justify-center p-10" */
  layerClassName?: string
  layerStyle?: CSSProperties
  layerData?: PiDataAttributes
  backdropClassName?: string
  backdropData?: PiDataAttributes
  /** 内容（Radix Dialog.Content，role="dialog" aria-modal）的 class / style / data-* */
  className?: string
  style?: CSSProperties
  contentData?: PiDataAttributes
  /** 里面可以用 Radix 的 Dialog.Title / Dialog.Description / Dialog.Close（radix-ui 包的 Dialog） */
  children?: ReactNode
}

/**
 * 可交互的模态层（只有可交互态；静态态由各部件自己画）：Radix Dialog（modal）+ design §4.7 的焦点规则。
 *   - 焦点：打开前记下焦点元素；打开时按 focus 进；Tab 圈在内容里；关闭（Esc / 点遮罩 / Dialog.Close / onOpenChange）后回 returnFocus → 打开前的焦点元素 → 顶栏标题。
 *   - 背后：浮层以外的兄弟节点（沿祖先到 body）加 inert，Radix 另加 aria-hidden。
 *   - 登记为 "overlay" 层：外壳的 ⌘ 快捷键在它开着时不触发；Esc 由 Radix 关（preventDefault，不会再停止生成）。
 */
export function PiOverlay({
  open: openProp,
  onOpenChange,
  label,
  focus = "dialog",
  returnFocus,
  portal = true,
  tier = "modal",
  backdrop = true,
  layerClassName,
  layerStyle,
  layerData,
  backdropClassName,
  backdropData,
  className,
  style,
  contentData,
  children,
}: PiOverlayProps) {
  const [open, setOpen] = usePiControllableOpen(openProp, onOpenChange, true)
  const { contentRef, onOpenAutoFocus, onCloseAutoFocus } = usePiDialogFocus(open, focus, returnFocus)
  // callback ref（useState 的 setter）：Radix Portal 挂载后的下一次渲染才把内容放进 body，ref 对象拿不到这个时机
  const [layer, setLayer] = useState<HTMLDivElement | null>(null)
  usePiLayer(open, "overlay", () => setOpen(false))
  usePiInertOthers(layer, open)
  const node = (
    <div
      ref={setLayer}
      data-pi-overlay-layer={tier}
      {...layerData}
      className={cn(portal ? "fixed" : "absolute", "inset-0", tier === "sheet" ? "z-(--cw-pi-z-sheet)" : "z-(--cw-pi-z-modal)", layerClassName)}
      style={layerStyle}
    >
      {backdrop && (
        <Dialog.Overlay asChild>
          <div aria-hidden {...backdropData} className={cn("absolute inset-0 bg-(--cw-overlay)", backdropClassName)} />
        </Dialog.Overlay>
      )}
      <Dialog.Content
        ref={contentRef}
        aria-modal="true"
        aria-label={label}
        // 没有 Dialog.Description 时不要 aria-describedby；有时 Radix 自动接上（radix-ui 1.2 的 concatAriaDescribedby）
        aria-describedby={undefined}
        onOpenAutoFocus={onOpenAutoFocus}
        onCloseAutoFocus={onCloseAutoFocus}
        {...contentData}
        className={cn("outline-none", className)}
        style={style}
      >
        {children}
      </Dialog.Content>
    </div>
  )
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      {portal ? <Dialog.Portal>{node}</Dialog.Portal> : open && node}
    </Dialog.Root>
  )
}

/* ======================= 手机底部 sheet ======================= */

export interface PiSheetProps extends PiOverlayControl {
  title?: ReactNode
  /** 没有可见标题时 role="dialog" 的名字（ui-a11y N6）；有标题时用标题（aria-labelledby），这个不用传 */
  label?: string
  /** 标题下一行灰字 */
  subtitle?: ReactNode
  /** auto = 按内容（最高 773）；half = 半高；full = 全高（844 − 47 − 24 = 773） */
  size?: "auto" | "half" | "full"
  /** 拖拽把手 36×5，默认 true */
  handle?: boolean
  /** 贴底的按钮行 */
  footer?: ReactNode
  /** 正文区的 class（默认左右 8，给菜单行留 8 + 行内 8 = 16 的页边距） */
  bodyClassName?: string
  className?: string
  children?: ReactNode
  /**
   * v1.2（D-05，design §4.3 sheetLayout）：sheet 里的输入框聚焦、键盘开着。sheet 改按可视视口摆：底边贴键盘上沿
   * （= 根节点底 − --cw-pi-keyboard-h），高度取纯函数 sheetLayout（pi/model/phoneDock.ts）的结果：
   * min(把手 + 标题 + 内容 + footer, 可视视口高 − 安全区顶 − 24)，full 固定为上限（舞台 508 − 47 − 24 = 437）；
   * footer 钉在 sheet 底部、紧贴键盘，底部内边距 34 → 8；内容区在 sheet 内滚动，聚焦的输入框 scrollIntoView({ block: "nearest" })；
   * 结果 < 160 时 compact（不画把手，标题行只留给读屏）；键盘收起回到普通尺寸，不重播转场。键盘占的那块不压暗。
   * 不传 = 跟 PiRoot 的视口帧（usePiFrame().keyboardOpen：产品里就是 useMobileViewport 的键盘状态）。
   */
  keyboardOpen?: boolean
  /** 可交互：关闭后焦点回哪（默认 = 打开前的焦点元素，不在了就回顶栏标题） */
  returnFocus?: PiReturnFocus
}

const SHEET_LAYER = "absolute inset-x-0 top-0 z-(--cw-pi-z-sheet) flex flex-col justify-end"
const SHEET_CARD = "relative flex min-h-0 flex-col rounded-t-(--cw-pi-sheet-radius) bg-(--cw-surface) shadow-(--cw-shadow-palette)"
const SHEET_TITLE = "text-[17px] leading-[22px] font-semibold text-(--cw-text)"
const SHEET_SUBTITLE = "mt-0.5 text-[13px] leading-[18px] text-(--cw-pi-text-secondary)"
const SHEET_BODY = "min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"

function sheetStyle(size: PiSheetProps["size"], keyboardOpen: boolean): CSSProperties {
  // 键盘开着时外层底边 = 键盘上沿，所以这里的 100% 就是可视视口高
  const maxH = "calc(100% - var(--cw-pi-safe-top) - 24px)"
  return {
    maxHeight: maxH,
    height: size === "full" ? maxH : size === "half" ? "50%" : undefined,
    paddingBottom: keyboardOpen ? 8 : "max(var(--cw-pi-safe-bottom), 8px)",
  }
}

/** 内容区里内容的自然高度：子元素的上下边界（含外边距）+ 内容区上下内边距；和内容区本身被压到多高无关 */
function contentHeightOf(body: HTMLElement): number {
  const kids = Array.from(body.children) as HTMLElement[]
  if (kids.length === 0) return body.scrollHeight
  let top = Infinity
  let bottom = -Infinity
  for (const el of kids) {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    if (cs.position === "absolute" || cs.position === "fixed") continue
    top = Math.min(top, r.top - parseFloat(cs.marginTop || "0"))
    bottom = Math.max(bottom, r.bottom + parseFloat(cs.marginBottom || "0"))
  }
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return body.scrollHeight
  const bs = getComputedStyle(body)
  return Math.ceil(bottom - top + parseFloat(bs.paddingTop || "0") + parseFloat(bs.paddingBottom || "0"))
}

function sameLayout(a: PiSheetLayout | null, b: PiSheetLayout | null) {
  return a === b || (!!a && !!b && a.top === b.top && a.height === b.height && a.bodyHeight === b.bodyHeight && a.compact === b.compact)
}

/**
 * 可交互 PiSheet 遇到键盘（P6.3，design §4.3）：量把手 + 标题、内容、footer 的高度 → sheetLayout（pi/model/phoneDock.ts，唯一实现）。
 * 随视口帧（visualViewport 的 resize / scroll 经 useMobileViewport → PiRoot）和内容尺寸（ResizeObserver）重算；键盘收起时返回 null。
 * compact 时标题行不在屏幕上，量不到，沿用最近一次量到的高度（不然会在 compact / 非 compact 之间来回跳）。
 */
function useSheetKeyboardLayout(keyboardOpen: boolean, size: PiSheetProps["size"], open: boolean) {
  const frame = usePiFrame()
  const handleRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)
  const lastHeader = useRef(0)
  const compactRef = useRef(false)
  const [layout, setLayout] = useState<PiSheetLayout | null>(null)
  const { vvHeight, vvOffsetTop, safeTop } = frame
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!keyboardOpen || !body) {
      compactRef.current = false
      setLayout(null)
      return
    }
    const measure = () => {
      const shown = (handleRef.current?.offsetHeight ?? 0) + (headerRef.current?.offsetHeight ?? 0)
      const headerHeight = compactRef.current ? lastHeader.current : shown
      if (!compactRef.current) lastHeader.current = shown
      // 没有 footer 时卡片自己留底内边距 8
      const footerHeight = footerRef.current ? footerRef.current.offsetHeight : 8
      const next = sheetLayout({ vvHeight, vvOffsetTop, headerHeight, contentHeight: contentHeightOf(body), footerHeight, safeTop, size })
      compactRef.current = !!next?.compact
      setLayout((prev) => (sameLayout(prev, next) ? prev : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    const observe = () => {
      for (const el of [...Array.from(body.children), footerRef.current, headerRef.current]) if (el) ro.observe(el)
    }
    observe()
    // 内容区里换了子元素（例如排队条目点"编辑"换成输入框）：重新量，并且盯住新的子元素
    const mo = new MutationObserver(() => {
      observe()
      measure()
    })
    mo.observe(body, { childList: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [keyboardOpen, open, size, vvHeight, vvOffsetTop, safeTop])
  // 聚焦的输入框滚进内容区可见范围（只滚内容区，不滚整页）
  useEffect(() => {
    if (!layout) return
    const active = document.activeElement
    if (active instanceof HTMLElement && bodyRef.current?.contains(active)) active.scrollIntoView({ block: "nearest" })
  }, [layout])
  return [layout, handleRef, headerRef, bodyRef, footerRef] as const
}

/**
 * 手机底部 sheet（design J04、§3.1）：背后 --cw-overlay，上圆角 16，把手 36×5，底部内边距 = 安全区 34。
 * 渲染在屏幕自己的树里（PiPhonePage 的 sheet 槽），绝对定位盖住整页，不 portal（两种态都一样）。
 * `keyboardOpen`：底边改贴键盘上沿，底部内边距 8（§4.3 sheetLayout）。
 * 可交互：Radix Dialog 原语（焦点进第一个输入框 / 第一个可用项、Tab 圈在 sheet 里、Esc / 点遮罩关闭、背后 inert）；
 * 正常动效下从底部滑入 240ms，减少动效时直接出现（useReducedMotion）。
 */
export function PiSheet(props: PiSheetProps) {
  const isStatic = usePiStatic(props.static)
  return isStatic ? <PiSheetStatic {...props} /> : <PiSheetInteractive {...props} />
}

function PiSheetStatic({ title, label, subtitle, size = "auto", handle = true, footer, bodyClassName, className, children, keyboardOpen = false, open }: PiSheetProps) {
  const titleId = useId()
  if (open === false) return null
  return (
    <div
      data-pi-sheet={size}
      data-keyboard-open={keyboardOpen ? "" : undefined}
      className={SHEET_LAYER}
      style={{ bottom: keyboardOpen ? "var(--cw-pi-keyboard-h)" : 0 }}
    >
      <div aria-hidden data-pi-sheet-backdrop="" className="absolute inset-0 bg-(--cw-overlay)" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={title != null ? titleId : undefined}
        aria-label={title == null ? label : undefined}
        data-pi-sheet-card=""
        className={cn(SHEET_CARD, className)}
        style={sheetStyle(size, keyboardOpen)}
      >
        {handle && <SheetHandle />}
        {(title != null || subtitle != null) && (
          // 标题内缩 16 = 页边距（design §3.1），与正文区默认的 8 + 菜单行 8 对齐
          <header className={cn("shrink-0 px-4 pb-2", handle ? "pt-2" : "pt-4")}>
            {title != null && (
              <div id={titleId} className={SHEET_TITLE}>
                {title}
              </div>
            )}
            {subtitle != null && <div className={SHEET_SUBTITLE}>{subtitle}</div>}
          </header>
        )}
        <div className={cn(SHEET_BODY, bodyClassName)}>{children}</div>
        {footer != null && <SheetFooter>{footer}</SheetFooter>}
      </div>
    </div>
  )
}

function SheetHandle({ ref }: { ref?: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} aria-hidden className="flex shrink-0 justify-center pt-2 pb-1">
      <span className="h-[5px] w-9 rounded-full bg-(--cw-pi-sheet-handle)" />
    </div>
  )
}

/** keyboard：键盘开着时底内边距 8 放在 footer 自己身上（卡片不再留），footer 底边正好贴键盘上沿（design §4.3） */
function SheetFooter({ children, keyboard = false, ref }: { children: ReactNode; keyboard?: boolean; ref?: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} data-pi-sheet-footer="" className={cn("flex shrink-0 items-center gap-2 px-4 pt-3", keyboard && "pb-2")}>
      {children}
    </div>
  )
}

function PiSheetInteractive({
  title,
  label,
  subtitle,
  size = "auto",
  handle = true,
  footer,
  bodyClassName,
  className,
  children,
  keyboardOpen: keyboardProp,
  open,
  onOpenChange,
  returnFocus,
}: PiSheetProps) {
  const { sheetSlide } = usePiMotion()
  const frame = usePiFrame()
  const keyboardOpen = keyboardProp ?? frame.keyboardOpen
  const [kbLayout, handleRef, headerRef, bodyRef, footerRef] = useSheetKeyboardLayout(keyboardOpen, size, open !== false)
  const layout = keyboardOpen ? kbLayout : null
  const compact = !!layout?.compact
  // 键盘开着：高度取 sheetLayout 的结果（不再由 CSS 的 max-height 推），底内边距 8 挪到 footer 上；动画类名不变，所以不重播转场
  const style: CSSProperties = layout
    ? { maxHeight: "none", height: layout.height, paddingBottom: footer != null ? 0 : 8 }
    : sheetStyle(size, keyboardOpen)
  return (
    // 不 portal：留在 PiPhonePage 的 sheet 槽里，absolute 盖住整页（和静态态同一个位置）
    <PiOverlay
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
      focus="sheet"
      portal={false}
      tier="sheet"
      label={title == null ? label : undefined}
      layerData={{
        "data-pi-sheet": size,
        "data-keyboard-open": keyboardOpen ? "" : undefined,
        "data-pi-sheet-compact": compact ? "" : undefined,
        "data-pi-sheet-h": layout ? String(layout.height) : undefined,
      }}
      layerClassName="flex flex-col justify-end"
      layerStyle={{ bottom: keyboardOpen ? "var(--cw-pi-keyboard-h)" : 0 }}
      backdropData={{ "data-pi-sheet-backdrop": "" }}
      backdropClassName={sheetSlide ? "animate-[pi-fade-in_240ms_ease-out]" : undefined}
      className={cn(SHEET_CARD, sheetSlide && "animate-[pi-sheet-in_240ms_cubic-bezier(0.32,0.72,0,1)]", className)}
      style={style}
      contentData={{ "data-pi-sheet-card": "" }}
    >
      {handle && !compact && <SheetHandle ref={handleRef} />}
      {(title != null || subtitle != null) && (
        // compact：标题行不在屏幕上，但留给读屏（sheet 的名字取自它）
        <header ref={headerRef} className={compact ? "sr-only" : cn("shrink-0 px-4 pb-2", handle ? "pt-2" : "pt-4")}>
          {title != null && (
            <Dialog.Title asChild>
              <div className={SHEET_TITLE}>{title}</div>
            </Dialog.Title>
          )}
          {subtitle != null && (
            <Dialog.Description asChild>
              <div className={SHEET_SUBTITLE}>{subtitle}</div>
            </Dialog.Description>
          )}
        </header>
      )}
      <div ref={bodyRef} data-pi-sheet-body="" className={cn(SHEET_BODY, bodyClassName)}>
        {children}
      </div>
      {footer != null && (
        <SheetFooter ref={footerRef} keyboard={keyboardOpen}>
          {footer}
        </SheetFooter>
      )}
    </PiOverlay>
  )
}

/* ======================= 弹窗（桌面居中卡 / 手机全高 sheet） ======================= */

export interface PiDialogProps extends PiOverlayControl {
  title: ReactNode
  viewport: PiLayout
  /** 桌面卡宽，默认 480 */
  width?: 360 | 480 | 560
  /** 底部按钮行（右对齐） */
  footer?: ReactNode
  /** 危险操作（删除、撤销）：标题红字。可交互时焦点进 [data-pi-autofocus]（危险确认弹窗请标在"取消"上） */
  danger?: boolean
  /** 桌面：标题下一行灰字 */
  subtitle?: ReactNode
  bodyClassName?: string
  className?: string
  children?: ReactNode
  /** 可交互：关闭后焦点回哪（默认 = 打开前的焦点元素，不在了就回顶栏标题） */
  returnFocus?: PiReturnFocus
  /** 手机（PiSheet full）：键盘开着（P6.3，design §4.3）；不传 = 跟 PiRoot 的视口帧。桌面不读 */
  keyboardOpen?: boolean
}

const DIALOG_CARD = "relative flex max-h-full min-h-0 flex-col rounded-(--cw-radius-bubble) bg-(--cw-surface) shadow-(--cw-shadow-palette)"
const DIALOG_TITLE = "m-0 text-(length:--cw-text-lg) leading-[22px] font-semibold"
const DIALOG_SUBTITLE = "mt-0.5 text-(length:--cw-text-md) leading-[19px] text-(--cw-pi-text-secondary)"

/**
 * 弹窗（design G19）：1440 = 全屏 --cw-overlay 压暗 + 居中白卡（圆角 12、--cw-shadow-palette）；390 = PiSheet(full)。
 * 静态态在 PiDesktopShell 的 overlay 槽里（--cw-pi-z-modal）。可交互时 portal 到 body（fixed、--cw-pi-z-modal，盖住整个应用和
 * 先打开的悬停卡 / 菜单，不会被 sticky 组头之类的层穿透，ui-audit §2.2）：Radix Dialog 焦点锁、Esc / 点遮罩 / × 关闭、背后 inert；
 * 焦点进第一个输入框，没有就进主按钮（PiButton primary），危险确认进 [data-pi-autofocus]。
 */
export function PiDialog(props: PiDialogProps) {
  const isStatic = usePiStatic(props.static)
  const { title, viewport, footer, danger = false, subtitle, bodyClassName, className, children } = props
  if (viewport === "phone") {
    return (
      <PiSheet
        static={isStatic}
        open={props.open}
        onOpenChange={props.onOpenChange}
        returnFocus={props.returnFocus}
        keyboardOpen={props.keyboardOpen}
        size="full"
        title={<span className={danger ? "text-(--cw-pi-error)" : undefined}>{title}</span>}
        subtitle={subtitle}
        footer={footer}
        bodyClassName={cn("px-4", bodyClassName)}
        className={className}
      >
        {children}
      </PiSheet>
    )
  }
  return isStatic ? <PiDialogStatic {...props} /> : <PiDialogInteractive {...props} />
}

function PiDialogStatic({ title, width = 480, footer, danger = false, subtitle, bodyClassName, className, children, open }: PiDialogProps) {
  const titleId = useId()
  if (open === false) return null
  return (
    <div data-pi-dialog="" className="absolute inset-0 z-(--cw-pi-z-modal) flex items-center justify-center p-10">
      <div aria-hidden className="absolute inset-0 bg-(--cw-overlay)" />
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className={cn(DIALOG_CARD, className)} style={{ width }}>
        <header className="flex shrink-0 items-start gap-3 pt-4 pr-3 pb-2 pl-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className={cn(DIALOG_TITLE, danger ? "text-(--cw-pi-error)" : "text-(--cw-text)")}>
              {title}
            </h2>
            {subtitle != null && <div className={DIALOG_SUBTITLE}>{subtitle}</div>}
          </div>
          <GhostIconButton label="关闭" icon={<X />} />
        </header>
        <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 pb-4", bodyClassName)}>{children}</div>
        {footer != null && <footer className="flex shrink-0 items-center justify-end gap-2 px-5 pt-1 pb-4">{footer}</footer>}
      </div>
    </div>
  )
}

function PiDialogInteractive({
  title,
  width = 480,
  footer,
  danger = false,
  subtitle,
  bodyClassName,
  className,
  children,
  open,
  onOpenChange,
  returnFocus,
}: PiDialogProps) {
  return (
    // portal 到 body（fixed、--cw-pi-z-modal）：盖住整个应用和先打开的悬停卡 / 菜单（ui-audit §2.2 的穿透）
    <PiOverlay
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
      focus="dialog"
      layerData={{ "data-pi-dialog": "" }}
      layerClassName="flex items-center justify-center p-10"
      className={cn(DIALOG_CARD, className)}
      style={{ width }}
    >
      <header className="flex shrink-0 items-start gap-3 pt-4 pr-3 pb-2 pl-5">
        <div className="min-w-0 flex-1">
          <Dialog.Title className={cn(DIALOG_TITLE, danger ? "text-(--cw-pi-error)" : "text-(--cw-text)")}>{title}</Dialog.Title>
          {subtitle != null && (
            <Dialog.Description asChild>
              <div className={DIALOG_SUBTITLE}>{subtitle}</div>
            </Dialog.Description>
          )}
        </div>
        <Dialog.Close asChild>
          <GhostIconButton label="关闭" icon={<X />} data-pi-dialog-close="" />
        </Dialog.Close>
      </header>
      <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 pb-4", bodyClassName)}>{children}</div>
      {footer != null && <footer className="flex shrink-0 items-center justify-end gap-2 px-5 pt-1 pb-4">{footer}</footer>}
    </PiOverlay>
  )
}

/* ======================= 锚定菜单（会话菜单、+ 菜单、模型 / 设备 / 目录 / 投递菜单、显示选项） ======================= */

export interface PiMenuProps extends PiOverlayControl {
  /** dropdown = 点触发元素打开（行尾 …、+、选择器、滑杆钮）；context = 右键 / 长按触发元素（会话行） */
  kind?: "dropdown" | "context"
  /** 触发元素：单个能接 ref 的元素（asChild）。静态态时原样渲染，菜单内容由屏幕自己摆 */
  trigger: ReactElement
  /** 菜单内容：里面的 MenuSurface 用 usePiMenuSurface() */
  children?: ReactNode
  /** dropdown 的位置（kit MenuSurface 的 Radix 定位参数）；context 跟随指针 */
  side?: PiMenuSurfaceOptions["side"]
  align?: PiMenuSurfaceOptions["align"]
  sideOffset?: number
  alignOffset?: number
}

/**
 * 锚定菜单的根（design §4.7 焦点表第 1 行）：Radix DropdownMenu / ContextMenu，非模态（不圈焦点、背后不 inert）。
 * 打开时焦点进第一个可用项（键盘打开）或菜单本身（指针打开），↑↓ 移动、Enter 选中、Esc / 点外面关闭；关闭后焦点回触发元素。
 * 打开期间登记为 "menu" 层（usePiShellShortcuts 据此挡 ⌘ 快捷键）。ContextMenu 没有受控 open：open prop 对它不生效，只回调 onOpenChange。
 */
export function PiMenu({
  kind = "dropdown",
  trigger,
  children,
  open: openProp,
  onOpenChange,
  static: staticProp,
  side,
  align,
  sideOffset = 4,
  alignOffset,
}: PiMenuProps) {
  const isStatic = usePiStatic(staticProp)
  const [open, setOpen] = usePiControllableOpen(kind === "context" ? undefined : openProp, onOpenChange)
  const triggerRef = useRef<HTMLElement | null>(null)
  const setTrigger = (el: HTMLElement | null) => {
    triggerRef.current = el
  }
  usePiLayer(!isStatic && open, "menu", kind === "dropdown" ? () => setOpen(false) : undefined)
  const surface = useMemo<PiMenuSurfaceOptions>(
    () =>
      kind === "context"
        ? {
            kind,
            alignOffset,
            loop: true,
            // 右键打开时触发元素不一定有焦点：焦点丢到 body 时送回触发元素（点了别处的可聚焦元素就不抢）
            onCloseAutoFocus: (event) => {
              event.preventDefault()
              const active = document.activeElement
              if (!active || active === document.body) triggerRef.current?.focus({ preventScroll: true })
            },
          }
        : { kind, side, align, sideOffset, alignOffset, loop: true },
    [kind, side, align, sideOffset, alignOffset],
  )
  if (isStatic) return trigger
  // 菜单内容（MenuSurface → Radix Content）自带 Presence：关着时不渲染
  const content = <PiMenuSurfaceContext.Provider value={surface}>{children}</PiMenuSurfaceContext.Provider>
  if (kind === "context") {
    return (
      <ContextMenu.Root modal={false} onOpenChange={setOpen}>
        <ContextMenu.Trigger asChild ref={setTrigger}>
          {trigger}
        </ContextMenu.Trigger>
        {content}
      </ContextMenu.Root>
    )
  }
  return (
    <DropdownMenu.Root modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild ref={setTrigger}>
        {trigger}
      </DropdownMenu.Trigger>
      {content}
    </DropdownMenu.Root>
  )
}
