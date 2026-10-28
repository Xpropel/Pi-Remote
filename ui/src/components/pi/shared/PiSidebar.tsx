import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react"
import { cn } from "@/lib/utils"
import {
  AgentStatusMarker,
  GhostIconButton,
  Pill,
  Sidebar,
  SidebarGroup,
  SidebarGroupHeader,
  SidebarNavRow,
} from "@/components/kit"
import { AgentPlaneIcon, ChevronUp, CircleQuestionMark, Ellipsis, ListFilter, PanelLeft, Plus, Search, Settings, X } from "@/components/kit/icons"
import { piAttentionRows } from "./adapters"
import { usePiStatic } from "./layers"
import { PiMenu } from "./PiOverlay"
import { PiIconButton, PiMark, PiPlatformIcon } from "./PiMark"
import type { PiAttentionItem, PiDevice, PiGrouping, PiLinkSummary, PiRowMarkerKind, PiSessionGroup, PiSessionRowData } from "./types"

/* ======================= 行首标记 ======================= */

export interface PiRowMarkerProps {
  kind: PiRowMarkerKind
  className?: string
}

/** 行首标记的中文名称（design §4.7）；idle 不读（aria-hidden） */
export const PI_ROW_MARKER_LABEL: Record<PiRowMarkerKind, string | null> = {
  waiting: "等你回答",
  error: "出错未读",
  unread: "完成未读",
  running: "运行中",
  idle: null,
  unloaded: "未载入",
}

/**
 * 会话行行首标记（design §6.3、§4.7）：unread / running / idle / unloaded 用 kit AgentStatusMarker（dot-blue / spinner / dot-gray / hollow-circle）；
 * waiting = 蓝色问号圈；error = 12px 红色实心圆 + 居中"!"（浅色白字、深色 #161617，v1.2 D-04），比 unread 的蓝点大，不只靠颜色区分。
 * 除 idle 外都是 role="img" + 中文 aria-label；idle aria-hidden。
 */
export function PiRowMarker({ kind, className }: PiRowMarkerProps) {
  const label = PI_ROW_MARKER_LABEL[kind]
  // kit AgentStatusMarker 自带 aria-hidden，后面的 rest 覆盖它
  const a11y = label ? { role: "img", "aria-label": label, "aria-hidden": undefined } : { "aria-hidden": true as const }
  switch (kind) {
    case "waiting":
      return (
        <span data-pi-marker="waiting" {...a11y} className={cn("inline-flex size-3.5 shrink-0 items-center justify-center", className)}>
          <CircleQuestionMark aria-hidden size={14} strokeWidth={1.75} className="text-(--cw-pi-attention)" />
        </span>
      )
    case "error":
      return (
        <span data-pi-marker="error" {...a11y} className={cn("inline-flex size-3.5 shrink-0 items-center justify-center", className)}>
          <span
            aria-hidden
            className="flex size-3 items-center justify-center rounded-full bg-(--cw-pi-error) text-[9px] leading-none font-bold text-white in-data-[pi-theme=dark]:text-[#161617]"
          >
            !
          </span>
        </span>
      )
    case "unread":
      return <AgentStatusMarker data-pi-marker="unread" variant="dot-blue" className={className} {...a11y} />
    case "running":
      // kit 的 spinner 标记里套着一个 kit Spinner（role="status"、英文名 "Running"），Chrome 不会因为外层 role="img" 就把它藏起来
      // （命令面板的选项里实测会暴露成 status「Running」）。所以 role="img" + 中文名放在外面这层，里面的 AgentStatusMarker
      // 保持 kit 默认的 aria-hidden（P3 #24 / #25：spinner 不进 live region、名字是中文）。外层只包一层，尺寸跟着里面走，图不变
      return (
        <span data-pi-marker="running" {...a11y} className={cn("inline-flex shrink-0", className)}>
          <AgentStatusMarker variant="spinner" />
        </span>
      )
    case "unloaded":
      return <AgentStatusMarker data-pi-marker="unloaded" variant="hollow-circle" className={className} {...a11y} />
    default:
      return <AgentStatusMarker data-pi-marker="idle" variant="dot-gray" className={className} {...a11y} />
  }
}

/* ======================= 会话行 ======================= */

export interface PiSessionRowProps extends Omit<ComponentProps<"div">, "title"> {
  row: PiSessionRowData
  variant: "desktop" | "phone"
  selected?: boolean
  /** 静态态：hover = 悬停（行尾换成 …）；context = 右键菜单的目标行（保持选中底） */
  forced?: "hover" | "context"
  /** 点行尾 …（没给 menu 时） */
  onMore?: () => void
  /** P4：点行，或焦点在行上按 Enter / 空格（打开会话） */
  onOpen?: () => void
  /**
   * P4（桌面）：会话菜单的内容（a 区 PiSessionMenu）。给了就接 PiMenu：行尾 …（悬停、或键盘焦点在行上时出现）= dropdown，
   * 右键行 = context（design C12）。菜单开着时 … 留着、右键的目标行保持选中底（同静态态 forced="context"）
   */
  menu?: ReactNode
  /** P4（手机）：长按（触屏 500ms）或右键（contextmenu）→ 会话菜单 sheet（design J07）。长按之后的那次点击不再打开会话 */
  onLongPress?: () => void
  /** P4 契约：静态态（画廊截图）。不传时取 PiStaticContext */
  static?: boolean
}

const LONG_PRESS_MS = 500
const LONG_PRESS_SLOP = 10

interface LongPressTimer {
  id: number | null
  origin: { x: number; y: number } | null
}

function cancelLongPress(t: LongPressTimer) {
  if (t.id != null) window.clearTimeout(t.id)
  t.id = null
  t.origin = null
}

const GHOST_EVENTS = ["mousedown", "mouseup", "click"] as const

/**
 * 长按开出 sheet 之后，浏览器在抬手时还会补发一组鼠标事件（Chrome 触屏实测：mousedown / mouseup / click 落在手指下面的元素上，
 * 这时那里已经是 sheet 里的菜单项：mousedown 抢焦点、click 选中那一项）。在捕获阶段吞掉这一组（到 click 为止，最多等 500ms）。
 */
function swallowNextClick() {
  const block = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.type === "click") done()
  }
  const done = () => {
    for (const type of GHOST_EVENTS) window.removeEventListener(type, block, true)
    window.clearTimeout(timeout)
  }
  for (const type of GHOST_EVENTS) window.addEventListener(type, block, true)
  const timeout = window.setTimeout(done, 500)
}

/** 手机行的长按（触屏 / 笔；鼠标走 contextmenu）。返回挂在行上的事件 */
function useLongPress(onLongPress: (() => void) | undefined) {
  // 计时器放在 ref 里的一个固定对象上：卸载时清掉
  const timer = useRef<LongPressTimer>({ id: null, origin: null })
  const fired = useRef(false)
  const latest = useRef(onLongPress)
  useLayoutEffect(() => {
    latest.current = onLongPress
  })
  useEffect(() => {
    const t = timer.current
    return () => cancelLongPress(t)
  }, [])
  const clear = () => cancelLongPress(timer.current)
  return {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (!latest.current || event.pointerType === "mouse") return
      clear()
      fired.current = false
      const t = timer.current
      t.origin = { x: event.clientX, y: event.clientY }
      t.id = window.setTimeout(() => {
        t.id = null
        t.origin = null
        fired.current = true
        latest.current?.()
      }, LONG_PRESS_MS)
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const o = timer.current.origin
      if (o && Math.hypot(event.clientX - o.x, event.clientY - o.y) > LONG_PRESS_SLOP) clear()
    },
    onPointerEnd: () => {
      clear()
      // 长按已经打开了 sheet：抬手后补发的那次 click 不能落到 sheet 里（或者再打开会话）
      if (fired.current) {
        fired.current = false
        swallowNextClick()
      }
    },
    onContextMenu: (event: MouseEvent<HTMLDivElement>) => {
      if (!latest.current) return
      event.preventDefault()
      // 触屏长按时计时器已经开过 sheet，contextmenu（Android 长按也发）不再开第二次
      if (fired.current) return
      // 手指还按着（触屏长按先到了 contextmenu）：照计时器那条路走，抬手时吞掉补发的 click；鼠标右键不会补发 click
      const touching = timer.current.origin != null
      clear()
      if (touching) fired.current = true
      latest.current()
    },
  }
}

function Highlighted({ text, part }: { text: string; part?: string }) {
  if (!part) return <>{text}</>
  const at = text.indexOf(part)
  if (at < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <b className="font-semibold text-(--cw-text)">{part}</b>
      {text.slice(at + part.length)}
    </>
  )
}

/**
 * 会话行的可访问名（design §4.7、§6.3，v1.3 §12.3-3）："标题，标记 label，时间全称"，例如"退款对账脚本报错，出错未读，38 分钟前"。
 * 行首是设备图标（设备掉线条目）或 idle 时不读标记；行尾是 trailingText（"命中 2 条"、"未连接"）时读它，否则读 timeLabel。
 */
function piSessionRowName(row: PiSessionRowData): string {
  const marker = row.platform != null ? null : PI_ROW_MARKER_LABEL[row.marker]
  const trailing = row.trailingText ?? row.timeLabel
  return [row.title, marker, trailing].filter(Boolean).join("，")
}

/** 一个可重排的定时器（再排就替换上一次；卸载时清掉） */
function useSettleTimer() {
  const box = useRef<{ id: number | null }>({ id: null })
  useEffect(() => {
    const b = box.current
    return () => {
      if (b.id != null) window.clearTimeout(b.id)
    }
  }, [])
  return (fn: () => void, ms: number) => {
    const b = box.current
    if (b.id != null) window.clearTimeout(b.id)
    b.id = window.setTimeout(() => {
      b.id = null
      fn()
    }, ms)
  }
}

/** 焦点是键盘带来的（:focus-visible）：鼠标点行时不出行尾 … */
function isFocusVisible(target: EventTarget | null): boolean {
  try {
    return target instanceof Element && target.matches(":focus-visible")
  } catch {
    return false
  }
}

/**
 * 会话行（design §6.3）。几何照 kit AgentRow（行框高 --cw-row-h − 1、圆角 --cw-radius-row、16px 标记列、标题 13px），
 * 但不用 AgentRow 本体：它的悬停态写死了图钉 + 归档（Pi 不做，§8），见 R/pi/kit-requests.md。
 * 选中 = 浅灰底 + 加粗（500）；悬停 = 浅灰底，行尾时间换成 …；手机行高 52（有第二行时 64）。
 * `row.dimmed`（设备离线）只让行首标记 / 图标变淡，文字保持原色（视觉审查第 1 轮 A5：整行 opacity 让标题只剩 2.4:1）。
 * 读屏：行的 aria-label = piSessionRowName(row)；行首标记和行尾时间 aria-hidden，免得读两遍；第二行灰字（搜索片段、"设备/目录"）
 * 经 aria-describedby 作为描述保留（role="button" 的子内容不进名字，不挂上就读不到）。图不变。
 * 可交互（P4，不是静态态时）：点行 / Enter / 空格 = onOpen；桌面给了 menu 就接会话菜单（右键 = context、行尾 … = dropdown，
 * 键盘焦点在行上时 … 也出来）；手机长按 / 右键 = onLongPress。
 */
export function PiSessionRow({
  row,
  variant,
  selected,
  forced,
  onMore,
  onOpen,
  menu,
  onLongPress,
  static: staticProp,
  className,
  onPointerEnter,
  onPointerLeave,
  onClick,
  onKeyDown,
  onFocus,
  onBlur,
  onContextMenu,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  ...rest
}: PiSessionRowProps) {
  const isStatic = usePiStatic(staticProp)
  const [hovered, setHovered] = useState(false)
  // P4（可交互）：键盘焦点在行上 / 焦点在行尾 … 上（… 出来，键盘才够得着）、行尾下拉开着、右键菜单开着
  const [keyFocus, setKeyFocus] = useState(false)
  const [dotsOpen, setDotsOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const settle = useSettleTimer()
  const subtitleId = useId()
  const phone = variant === "phone"
  const longPress = useLongPress(!isStatic && phone ? onLongPress : undefined)
  const onDotsOpenChange = (open: boolean) => {
    setDotsOpen(open)
    if (open) return
    // 下拉关上后 Radix（在 setTimeout 里）把焦点送回 …：在那之前 … 不能卸掉；之后焦点不在行里（点了别处）再收起
    setKeyFocus(true)
    settle(() => {
      const el = rowRef.current
      if (!el || !el.contains(document.activeElement)) setKeyFocus(false)
    }, 30)
  }
  const withMenu = !isStatic && !phone && menu != null
  const hover = !phone && (hovered || forced === "hover" || (!isStatic && (keyFocus || dotsOpen)))
  const context = forced === "context" || (withMenu && contextOpen)
  const twoLine = row.subtitle != null
  const trailing = row.trailingText ?? row.time
  // 静态态：事件原样透传（DOM 与冻结版一致）；可交互：点行 / Enter / 空格 = onOpen，手机长按 = onLongPress
  const handlers = isStatic
    ? { onClick, onKeyDown, onFocus, onBlur, onContextMenu, onPointerDown, onPointerMove, onPointerUp, onPointerCancel }
    : {
        onClick: (event: MouseEvent<HTMLDivElement>) => {
          onClick?.(event)
          if (event.defaultPrevented) return
          onOpen?.()
        },
        onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
          onKeyDown?.(event)
          // 只认行本身：行尾 … 上的 Enter / 空格归下拉菜单
          if (event.defaultPrevented || event.target !== event.currentTarget) return
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            onOpen?.()
          }
        },
        onFocus: (event: FocusEvent<HTMLDivElement>) => {
          onFocus?.(event)
          // 行本身：只在键盘聚焦时出 …（鼠标点行不出）；行里的 …：有焦点就留着（菜单关上后焦点回到它）
          setKeyFocus(event.target === event.currentTarget ? isFocusVisible(event.target) : true)
        },
        onBlur: (event: FocusEvent<HTMLDivElement>) => {
          onBlur?.(event)
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setKeyFocus(false)
        },
        onContextMenu: (event: MouseEvent<HTMLDivElement>) => {
          onContextMenu?.(event)
          if (phone) longPress.onContextMenu(event)
        },
        onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
          onPointerDown?.(event)
          if (phone) longPress.onPointerDown(event)
        },
        onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
          onPointerMove?.(event)
          if (phone) longPress.onPointerMove(event)
        },
        onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
          onPointerUp?.(event)
          if (phone) longPress.onPointerEnd()
        },
        onPointerCancel: (event: PointerEvent<HTMLDivElement>) => {
          onPointerCancel?.(event)
          if (phone) longPress.onPointerEnd()
        },
      }
  const dots = (
    <GhostIconButton
      size="sm"
      label="会话菜单"
      icon={<Ellipsis />}
      className="-my-1 ml-[5px]"
      onClick={(event) => {
        event.stopPropagation()
        if (!withMenu) onMore?.()
      }}
    />
  )
  const rowEl = (
    <div
      ref={rowRef}
      role="button"
      tabIndex={0}
      aria-label={piSessionRowName(row)}
      aria-describedby={twoLine ? subtitleId : undefined}
      data-pi-row={row.id}
      data-selected={selected ? "" : undefined}
      data-hover={hover ? "" : undefined}
      data-context-target={context ? "" : undefined}
      onPointerEnter={(event) => {
        onPointerEnter?.(event)
        setHovered(true)
      }}
      onPointerLeave={(event) => {
        onPointerLeave?.(event)
        setHovered(false)
      }}
      {...handlers}
      className={cn(
        "relative flex w-full min-w-0 shrink-0 text-left text-(length:--cw-text-md) leading-(--cw-leading-tight) font-normal text-(--cw-text-2) outline-none select-none [-webkit-touch-callout:none]",
        // 两行行：顶对齐，标记与行尾对齐到标题那一行（下面按 --cw-leading-tight 算偏移）；手机 13 + 38 + 13 = 64，桌面 5 + 36 + 5 = 46
        twoLine ? "items-start" : "items-center",
        phone
          ? cn("rounded-[10px] pr-3 pl-2", twoLine ? "min-h-16 py-[13px]" : "h-[52px]")
          : cn(
              "mb-px rounded-(--cw-radius-row) pr-[9px] pl-[5px]",
              twoLine ? "py-[5px]" : "h-[calc(var(--cw-row-h)_-_1px)]",
            ),
        (selected || context) && "bg-(--cw-row-selected) text-(--cw-text)",
        selected && "font-medium",
        hover && !selected && !context && "bg-(--cw-sidebar-row-hover) text-(--cw-text)",
        "focus-visible:bg-(--cw-sidebar-row-hover)",
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-4 shrink-0 items-center justify-center",
          twoLine && "mt-[calc((var(--cw-leading-tight)_-_16px)/2)]",
          row.dimmed && "opacity-55",
        )}
      >
        {row.platform != null ? (
          <PiPlatformIcon platform={row.platform} size={14} className="text-(--cw-pi-text-secondary)" />
        ) : (
          <PiRowMarker kind={row.marker} />
        )}
      </span>
      <span className="ml-2.5 flex min-w-0 flex-1 flex-col">
        <span data-pi-row-title="" className="min-w-0 truncate">
          <Highlighted text={row.title} part={row.highlight} />
        </span>
        {twoLine && (
          <span id={subtitleId} className="mt-0.5 min-w-0 truncate text-(length:--cw-text-sm) leading-(--cw-leading-sm) font-normal text-(--cw-pi-text-secondary)">
            <Highlighted text={row.subtitle ?? ""} part={row.highlight} />
          </span>
        )}
      </span>
      {hover ? (
        withMenu ? (
          // 行尾 … = 下拉（design §4.7 焦点表：焦点进第一项，关闭后回 …）；向右展开，不盖住列表
          <PiMenu kind="dropdown" trigger={dots} side="bottom" align="start" onOpenChange={onDotsOpenChange}>
            {menu}
          </PiMenu>
        ) : (
          dots
        )
      ) : trailing ? (
        <span
          aria-hidden
          className={cn(
            "ml-[5px] shrink-0 text-(length:--cw-text-sm) leading-(--cw-leading-sm) font-normal whitespace-nowrap tabular-nums",
            // P9 A（D1）：等你回答的行尾用注意力色；其余照旧
            // 选中底 #E2E2E2 上 secondary 只有 4.1:1（审查 m7）→ 选中行用 --cw-text-2
            row.trailingTone === "attention"
              ? "text-(--cw-pi-attention)"
              : selected || context
                ? "text-(--cw-text-2)"
                : "text-(--cw-pi-text-secondary)",
            twoLine && "mt-[calc((var(--cw-leading-tight)_-_var(--cw-leading-sm))/2)]",
          )}
        >
          {trailing}
        </span>
      ) : null}
    </div>
  )
  // 右键行 = context 菜单（从指针处展开，关闭后焦点回行）
  return withMenu ? (
    <PiMenu kind="context" trigger={rowEl} onOpenChange={setContextOpen}>
      {menu}
    </PiMenu>
  ) : (
    rowEl
  )
}

/* ======================= 账户区 ======================= */

export interface PiAccountFooterProps {
  link: PiLinkSummary
  variant: "expanded" | "rail" | "phone"
  /** 静态按下态：options = 滑杆（显示选项打开）；settings = 齿轮（设置页） */
  pressed?: "options" | "settings"
  /** 点滑杆（显示选项，design §1.13） */
  onOpenOptions?: () => void
  /** 点齿轮（= ⌘,） */
  onOpenSettings?: () => void
  /** P4：显示选项的菜单内容（桌面 expanded / rail）。给了就把滑杆钮包进锚定菜单（PiMenu）；手机用 onOpenOptions 开 sheet */
  optionsMenu?: ReactNode
  className?: string
}

/**
 * 桌面账户区的滑杆钮。给了 menu 就包进 PiMenu（显示选项，design §1.13）：从滑杆上方弹出、左缘对齐左栏，
 * 位置同设计屏 c/quick-settings 1440（底边离左栏底 56、左缘离左栏 8），但底边至少在滑杆上方 4px（rail 的滑杆更靠上，不能盖住它）。
 * 打开期间是按下态。偏移在打开时按滑杆在左栏里的位置量出来。不给 menu 时就是原来那个钮（静态态 DOM 不变）。
 */
function AccountOptionsButton({ pressed, onOpenOptions, menu }: { pressed: boolean; onOpenOptions?: () => void; menu?: ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [offset, setOffset] = useState({ side: 4, align: 0 })
  const button = (
    <GhostIconButton ref={ref} label="显示选项" icon={<ListFilter />} forced={pressed || open ? "pressed" : undefined} onClick={onOpenOptions} />
  )
  if (menu == null) return button
  return (
    <PiMenu
      side="top"
      align="start"
      sideOffset={offset.side}
      alignOffset={offset.align}
      onOpenChange={(next) => {
        const el = ref.current
        const bar = el?.closest("[data-pi-sidebar]")?.getBoundingClientRect()
        if (next && el && bar) {
          const r = el.getBoundingClientRect()
          const bottom = Math.min(bar.bottom - 56, r.top - 4)
          setOffset({ side: r.top - bottom, align: bar.left + 8 - r.left })
        }
        setOpen(next)
      }}
      trigger={button}
    >
      {menu}
    </PiMenu>
  )
}

/**
 * 账户区（design §6.3）：PiMark + 两行字（Pi-Remote / 连接摘要）+ 滑杆（显示选项）+ 齿轮（设置）。
 * 参照 kit AccountFooter 的排法；桌面高 52，手机 56（图标钮点击区 48）。
 */
export function PiAccountFooter({ link, variant, pressed, onOpenOptions, onOpenSettings, optionsMenu, className }: PiAccountFooterProps) {
  if (variant === "rail") {
    return (
      <div data-pi-account="rail" className={cn("flex flex-col items-center gap-1 py-2", className)}>
        <AccountOptionsButton pressed={pressed === "options"} onOpenOptions={onOpenOptions} menu={optionsMenu} />
        <GhostIconButton label="设置" icon={<Settings />} forced={pressed === "settings" ? "pressed" : undefined} onClick={onOpenSettings} />
      </div>
    )
  }
  if (variant === "phone") {
    return (
      <div data-pi-account="phone" className={cn("flex h-14 items-center border-t border-(--cw-divider) pr-2 pl-4", className)}>
        <PiMark size={28} />
        <span className="ml-3 flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[15px] leading-5 font-medium text-(--cw-text)">Pi-Remote</span>
          <span data-pi-link={link.kind} className="truncate text-[13px] leading-[18px] text-(--cw-pi-text-secondary)">
            {link.text}
          </span>
        </span>
        <PiIconButton label="显示选项" icon={<ListFilter />} forced={pressed === "options" ? "pressed" : undefined} onClick={onOpenOptions} />
        <PiIconButton label="设置" icon={<Settings />} forced={pressed === "settings" ? "pressed" : undefined} onClick={onOpenSettings} />
      </div>
    )
  }
  return (
    <div data-pi-account="expanded" className={cn("flex h-[52px] w-full min-w-0 items-center pr-[3px] pl-[3px] select-none", className)}>
      <PiMark size={22} />
      <span className="ml-2.5 flex min-w-0 flex-1 flex-col">
        <span className="truncate text-(length:--cw-text-sm) leading-[18px] text-(--cw-text-2)">Pi-Remote</span>
        <span data-pi-link={link.kind} className="truncate text-(length:--cw-text-sm) leading-[18px] text-(--cw-pi-text-secondary)">
          {link.text}
        </span>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        <AccountOptionsButton pressed={pressed === "options"} onOpenOptions={onOpenOptions} menu={optionsMenu} />
        <GhostIconButton label="设置" icon={<Settings />} forced={pressed === "settings" ? "pressed" : undefined} onClick={onOpenSettings} />
      </span>
    </div>
  )
}

/* ======================= 骨架行 ======================= */

export interface PiSkeletonRowsProps {
  rows?: number
  variant: "desktop" | "phone"
  className?: string
}

const SKELETON_W = [72, 56, 81, 63, 48, 77, 60, 69, 52, 74]

/** 列表骨架（design A06）：12px 浅灰圆 + 浅灰条，无扫光 */
export function PiSkeletonRows({ rows = 6, variant, className }: PiSkeletonRowsProps) {
  const phone = variant === "phone"
  return (
    <div data-pi-skeleton="" aria-busy="true" aria-label="正在加载" className={cn("flex flex-col", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={cn("flex items-center", phone ? "h-[52px] pl-2.5" : "mb-px h-[calc(var(--cw-row-h)_-_1px)] pl-[7px]")}>
          <span className="size-3 shrink-0 rounded-full bg-(--cw-pi-skeleton)" />
          <span
            className={cn("ml-3 rounded-full bg-(--cw-pi-skeleton)", phone ? "h-2.5" : "h-2")}
            style={{ width: `${SKELETON_W[i % SKELETON_W.length]}%` }}
          />
        </div>
      ))}
    </div>
  )
}

/* ======================= 左栏 / 手机列表正文 ======================= */

export interface PiSidebarProps {
  /** expanded = 桌面左栏 256；rail = 收起 48；phone = 手机列表页正文（不含顶栏、账户栏） */
  variant: "expanded" | "rail" | "phone"
  groups: PiSessionGroup[]
  /** 需要处理组（非空才出现），已按优先级排好 */
  attention?: PiAttentionItem[]
  selectedId?: string
  hoverId?: string
  /** 右键菜单的目标行（session-menu 屏） */
  contextId?: string
  /** 设备筛选生效：顶部出现"只看 <名字> ×"chip */
  filter?: string | null
  /** P5（决定 2）：点 chip 去掉筛选（可交互时才接） */
  onClearFilter?: () => void
  /** 替换分组区（搜索结果） */
  body?: ReactNode
  /** 首次加载：分组区换成骨架行 */
  loading?: boolean
  /** 列表末尾的一行灰字（"只列出最近 200 个会话"、"还没有设备"） */
  listNote?: string
  link: PiLinkSummary
  /** 账户区按下态 */
  footerPressed?: "options" | "settings"
  /** 入口行选中（新建会话页 = "new"） */
  navSelected?: "new" | "search" | null
  /** 相对时间的基准 */
  now: number
  /** 解析设备掉线条目的平台图标 */
  devices: PiDevice[]
  /**
   * v1.2（D-07）：分组方式。flat = 不分组：groups 里的行平铺、没有组头和"更多"、不出文件夹行（groups 用
   * piSessionGroups({ grouping: "flat" }) 生成，行已带 subtitle"设备/目录"）。默认 device。
   * "更多 N"的展开（M-08）由 group.expanded 表示：piSessionGroups({ expanded: [key] })。
   */
  grouping?: PiGrouping
  /** P4：入口行与账户区的回调（可交互时由外壳接上；不传 = 只是静态的样子） */
  /** "新建会话 ⇧⌘O"（= ⇧⌘O） */
  onNewSession?: () => void
  /** 组头 / 文件夹行的"+"（在这个目录新建会话，m6）：进新建会话并预选这一组的设备和目录 */
  onNewSessionIn?: (deviceId: string, cwd: string) => void
  /** "搜索"行：打开左栏标题搜索并聚焦搜索框（不带快捷键，⌘K 只开命令面板，D-01） */
  onSearch?: () => void
  /** 品牌行的"收起侧栏 ⌘B"、rail 的"展开侧栏 ⌘B"（= ⌘B） */
  onToggleSidebar?: () => void
  /** 账户区滑杆（显示选项） */
  onOpenOptions?: () => void
  /** 账户区滑杆的显示选项菜单内容（桌面；见 PiAccountFooter.optionsMenu） */
  optionsMenu?: ReactNode
  /** 账户区齿轮（= ⌘,） */
  onOpenSettings?: () => void
  /** P4：会话行（分组区和需要处理组；可交互时才接） */
  /** 点行 / Enter / 空格（打开会话；"设备未连接"条目也会回调，row.platform 有值） */
  onOpenSession?: (row: PiSessionRowData) => void
  /**
   * 桌面：这一行的会话菜单内容（a 区 PiSessionMenu）；返回 null = 这一行没有菜单（例如"设备未连接"条目）。
   * key = 行在列表里的位置标识（需要处理组里是 "attention:<id>"，其余是 id），同一个会话在两处出现时靠它区分；也写在行的 data-pi-row-key 上
   */
  rowMenu?: (row: PiSessionRowData, key: string) => ReactNode
  /** 手机：长按 / 右键一行（打开会话菜单 sheet，design J07） */
  onRowLongPress?: (row: PiSessionRowData, key: string) => void
  /** 点"更多 N" / "收起"（design §6.3、M-08）：由容器改写展开的组（piSessionGroups({ expanded })） */
  onToggleMore?: (groupKey: string) => void
  /** P4 契约：静态态（画廊截图）。不传时取 PiStaticContext；静态时上面的行回调都不接 */
  static?: boolean
  className?: string
}

/** 会话行的可交互回调（PiSidebar 往下传，静态态时不传） */
interface RowHandlers {
  onOpenSession?: PiSidebarProps["onOpenSession"]
  rowMenu?: PiSidebarProps["rowMenu"]
  onRowLongPress?: PiSidebarProps["onRowLongPress"]
}

function GroupLabel({ children }: { children: ReactNode }) {
  return <span className="text-(--cw-pi-text-secondary)">{children}</span>
}

/**
 * 组头右端 "+"（替换 kit 默认的英文 aria-label，审查 m6）。手机：视觉 20 不变，点击区用 ::after 外扩到 44×44、
 * 从组头顶边起往下 44（按钮在 36 高组头里位于 11–31，所以上 11、下 13，下面多出的 8 压在本组第一行顶上；
 * 不往上伸，免得和上一组的文件夹行 / 末行抢点击。design §4.4，审查 A2）。kit 不改。
 */
function GroupAddButton({ phone, folder = false, onClick }: { phone: boolean; folder?: boolean; onClick?: () => void }) {
  return (
    <GhostIconButton
      size="sm"
      label="在这个目录新建会话"
      icon={<Plus />}
      onClick={onClick}
      className={
        phone
          ? cn(
              // 外扩的点击区压住相邻行：局部抬高 --cw-pi-z-raised（R2/p4-lanes.md §2，值同原来的 10）
              "relative after:absolute after:-inset-x-3 after:z-(--cw-pi-z-raised) after:content-['']",
              // 文件夹行组头 44 高、按钮居中 → 上下各 12
              folder ? "after:-inset-y-3" : "after:-top-[11px] after:-bottom-[13px]",
            )
          : undefined
      }
    />
  )
}

function SidebarGroups({
  groups,
  attentionRows,
  variant,
  selectedId,
  hoverId,
  contextId,
  grouping = "device",
  isStatic,
  rowHandlers,
  onToggleMore,
  onNewSessionIn,
}: {
  groups: PiSessionGroup[]
  attentionRows: PiSessionRowData[]
  variant: "desktop" | "phone"
  selectedId?: string
  hoverId?: string
  contextId?: string
  grouping?: PiGrouping
  isStatic: boolean
  rowHandlers: RowHandlers
  onToggleMore?: (groupKey: string) => void
  onNewSessionIn?: (deviceId: string, cwd: string) => void
}) {
  const phone = variant === "phone"
  /**
   * 组头高：手机 36（design §3.3，文字 13 = --cw-text-sm 的手机值，左缘与行标记列对齐）；
   * 桌面 36（kit repo 组头 39，Pi 的组比 Cursor 多，压 3px 让 900 高能放下全部 7 组，推断）
   */
  const headerClass = phone
    ? // 组头 + 的 44 点击区向下伸出组头 8px：kit 的动作槽带 opacity（自成层叠上下文），抬到 --cw-pi-z-raised 才不被下一行盖住（A2）
      "h-9 pt-[13px] pb-[7px] pl-2 [&>[data-slot=sidebar-group-actions]]:relative [&>[data-slot=sidebar-group-actions]]:z-(--cw-pi-z-raised)"
    : "h-9 pt-[11px] pb-[9px]"
  /** 需要处理组的行用 "attention:<id>" 匹配 hoverId / contextId（选中态两处都显示：它们指向同一个会话） */
  /** offlineGroup：离线设备组里的行一律 dimmed（只淡标记，A5） */
  const rowOf = (row: PiSessionRowData, key: string, inAttention: boolean, offlineGroup = false) => {
    const target = inAttention ? `attention:${row.id}` : row.id
    const { onOpenSession, rowMenu, onRowLongPress } = rowHandlers
    return (
      <PiSessionRow
        key={key}
        row={offlineGroup ? { ...row, dimmed: true } : row}
        variant={variant}
        selected={row.id === selectedId}
        forced={target === contextId ? "context" : target === hoverId ? "hover" : undefined}
        static={isStatic}
        // 可交互时才接行的回调（静态态 DOM 与冻结版一致）
        {...(isStatic
          ? {}
          : {
              "data-pi-row-key": target,
              onOpen: onOpenSession && (() => onOpenSession(row)),
              menu: rowMenu?.(row, target),
              onLongPress: onRowLongPress && (() => onRowLongPress(row, target)),
            })}
      />
    )
  }
  const toggle = (groupKey: string) => (!isStatic && onToggleMore ? () => onToggleMore(groupKey) : undefined)
  const addIn = (group: PiSessionGroup) => (!isStatic && onNewSessionIn ? () => onNewSessionIn(group.deviceId, group.cwd) : undefined)
  return (
    <>
      {attentionRows.length > 0 && (
        <SidebarGroup
          data-pi-group="attention"
          label={<GroupLabel>需要处理 {attentionRows.length}</GroupLabel>}
          actions={false}
          headerClassName={headerClass}
        >
          {attentionRows.map((row) => rowOf(row, `attention:${row.id}`, true))}
        </SidebarGroup>
      )}
      {groups.map((group) => {
        // 不分组（D-07）：没有组头、不折叠；离线行由 row.dimmed 只淡标记；文件夹行不出现
        if (grouping === "flat" || group.flat) {
          if (group.folderOnly) return null
          return (
            <div key={group.key} data-pi-group={group.key} data-pi-grouping="flat" className={phone ? "pt-2" : "pt-2.5"}>
              {group.rows.map((row) => rowOf(row, row.id, false))}
            </div>
          )
        }
        if (group.folderOnly) {
          return (
            <div key={group.key} data-pi-group={group.key} data-offline={group.offline ? "" : undefined}>
              <SidebarGroupHeader
                variant="folder"
                label={group.label}
                actions={<GroupAddButton phone={phone} folder onClick={addIn(group)} />}
                // 离线：只淡文件夹图标（A5）
                className={cn(phone ? "h-11 pt-0 pb-0 pl-2 [&>[data-slot=sidebar-group-actions]]:relative [&>[data-slot=sidebar-group-actions]]:z-(--cw-pi-z-raised)" : "h-9 pt-[9px] pb-[9px]", group.offline && "[&>svg:first-child]:opacity-55")}
              />
            </div>
          )
        }
        return (
          <SidebarGroup
            key={group.key}
            data-pi-group={group.key}
            data-offline={group.offline ? "" : undefined}
            label={
              <GroupLabel>
                {group.label}
                {group.offline ? " · 未连接" : ""}
              </GroupLabel>
            }
            actions={<GroupAddButton phone={phone} onClick={addIn(group)} />}
            headerClassName={headerClass}
          >
            {group.rows.map((row) => rowOf(row, row.id, false, group.offline))}
            {/* "更多 N" ↔ "收起"是同一个开关（同 key：展开后还是同一个按钮，焦点留在上面）；aria-expanded 跟着变 */}
            {group.more ? (
              <SidebarNavRow
                key="more-toggle"
                data-pi-more={group.key}
                icon={Ellipsis}
                muted
                label={`更多 ${group.more}`}
                aria-expanded={false}
                onClick={toggle(group.key)}
                // muted 是 --cw-text-3（3.3:1），"更多 N"是要读的字 → secondary（审查 A5）
                iconClassName="text-(--cw-pi-text-secondary)"
                className={cn("text-(--cw-pi-text-secondary)", phone && "h-11 rounded-[10px] pl-2")}
              />
            ) : group.expanded ? (
              // 展开"更多 N"后末行换成"收起"（M-08，同样 44 高）
              <SidebarNavRow
                key="more-toggle"
                data-pi-more={group.key}
                data-pi-collapse=""
                icon={ChevronUp}
                muted
                label="收起"
                aria-expanded
                onClick={toggle(group.key)}
                iconClassName="text-(--cw-pi-text-secondary)"
                className={cn("text-(--cw-pi-text-secondary)", phone && "h-11 rounded-[10px] pl-2")}
              />
            ) : null}
          </SidebarGroup>
        )
      })}
    </>
  )
}

const KBD_TEXT_3 = "[&_[data-slot=kbd-hint]]:text-(--cw-text-3)"

/**
 * 整根左栏 / 手机列表页正文（design §3.1、§6.3）。expanded：品牌行 44 → 新建会话 ⇧⌘O / 搜索（不带快捷键，D-01）→ 筛选 chip（有筛选时）
 * → 需要处理组 → 设备 / 目录分组（每组最多 5 行 + 更多）→ 账户区贴底。基于 kit Sidebar / SidebarGroup / SidebarNavRow。
 */
export function PiSidebar({
  variant,
  groups,
  attention = [],
  selectedId,
  hoverId,
  contextId,
  filter = null,
  onClearFilter,
  body,
  loading = false,
  listNote,
  link,
  footerPressed,
  navSelected = null,
  now,
  devices,
  grouping = "device",
  onNewSession,
  onNewSessionIn,
  onSearch,
  onToggleSidebar,
  onOpenOptions,
  optionsMenu,
  onOpenSettings,
  onOpenSession,
  rowMenu,
  onRowLongPress,
  onToggleMore,
  static: staticProp,
  className,
}: PiSidebarProps) {
  const isStatic = usePiStatic(staticProp)
  const attentionRows = piAttentionRows(attention, now, devices)
  const groupsProps = {
    groups,
    attentionRows,
    selectedId,
    hoverId,
    contextId,
    grouping,
    isStatic,
    rowHandlers: { onOpenSession, rowMenu, onRowLongPress },
    onToggleMore,
    onNewSessionIn,
  }
  const filterChip =
    filter != null ? (
      <div data-pi-filter="" className={cn("flex items-center justify-between", variant === "phone" ? "h-11 px-2" : "h-[39px] pt-[9px] pr-1.5 pl-1.5")}>
        <span className="text-(length:--cw-text-sm) leading-(--cw-leading-sm) text-(--cw-pi-text-secondary)">会话</span>
        <Pill
          variant="soft-gray"
          className="h-6 gap-1 pr-1.5 pl-2.5 text-(length:--cw-text-sm) font-normal text-(--cw-text-2)"
          // 可交互时整颗 chip 就是"去掉筛选"（静态态 DOM 不变）
          {...(!isStatic && onClearFilter ? { onClick: onClearFilter, "aria-label": `去掉筛选：只看 ${filter}` } : {})}
        >
          只看 {filter}
          <X aria-hidden size={12} strokeWidth={1.75} />
        </Pill>
      </div>
    ) : null

  if (variant === "phone") {
    return (
      <div data-pi-sidebar="phone" className={cn("flex flex-col px-2 pb-3", className)}>
        {filterChip}
        {body ??
          (loading ? (
            <PiSkeletonRows rows={8} variant="phone" />
          ) : (
            <SidebarGroups {...groupsProps} variant="phone" />
          ))}
        {listNote && <p className="m-0 px-2 pt-3 text-[13px] leading-[18px] text-(--cw-pi-text-secondary)">{listNote}</p>}
      </div>
    )
  }

  if (variant === "rail") {
    const rows = [...attentionRows, ...groups.flatMap((g) => g.rows)]
    return (
      <aside
        data-pi-sidebar="rail"
        className={cn("flex h-full w-(--cw-pi-rail-w) shrink-0 flex-col items-center border-r border-(--cw-divider) bg-(--cw-sidebar-bg) pt-2.5", className)}
      >
        <PiMark size={20} />
        {/* P4：rail 没进设计图（推断）；可交互时给一个展开钮，和 ⌘B 同一个动作 */}
        {onToggleSidebar && <GhostIconButton label="展开侧栏 ⌘B" icon={<PanelLeft />} className="mt-2" onClick={onToggleSidebar} />}
        <GhostIconButton label="新建会话" icon={<AgentPlaneIcon />} className="mt-3" onClick={onNewSession} />
        <GhostIconButton label="搜索" icon={<Search />} className="mt-1" onClick={onSearch} />
        <div className="mt-3 flex min-h-0 flex-1 flex-col items-center gap-[13px] overflow-hidden pt-1">
          {rows.map((row, i) =>
            row.platform != null ? (
              <PiPlatformIcon key={`${row.id}:${i}`} platform={row.platform} size={14} />
            ) : (
              <PiRowMarker key={`${row.id}:${i}`} kind={row.marker} />
            ),
          )}
        </div>
        <PiAccountFooter
          link={link}
          variant="rail"
          pressed={footerPressed}
          onOpenOptions={onOpenOptions}
          onOpenSettings={onOpenSettings}
          optionsMenu={optionsMenu}
        />
      </aside>
    )
  }

  const brand = (
    <div data-pi-brand="" className="flex h-11 shrink-0 items-center pr-2 pl-[15px]">
      <PiMark size={20} />
      <span className="ml-2.5 text-(length:--cw-text-md) leading-(--cw-leading-tight) font-semibold text-(--cw-text)">Pi-Remote</span>
      <GhostIconButton label="收起侧栏 ⌘B" icon={<PanelLeft />} className="ml-auto" onClick={onToggleSidebar} />
    </div>
  )
  return (
    <Sidebar
      data-pi-sidebar="expanded"
      header={brand}
      footer={
        <PiAccountFooter
          link={link}
          variant="expanded"
          pressed={footerPressed}
          onOpenOptions={onOpenOptions}
          onOpenSettings={onOpenSettings}
          optionsMenu={optionsMenu}
        />
      }
      className={cn("w-(--cw-pi-sidebar-w)", className)}
      bodyClassName="pt-0.5"
    >
      {/* 快捷键：kit 默认 --cw-text-4（2.0:1）→ --cw-text-3（审查 m1；§4.6 快捷键可以用弱灰） */}
      <SidebarNavRow icon={AgentPlaneIcon} label="新建会话" kbd="⇧⌘O" selected={navSelected === "new"} className={KBD_TEXT_3} onClick={onNewSession} />
      {/* v1.2（D-01）：⌘K 只开命令面板，搜索行不带快捷键；点它打开标题搜索并聚焦搜索框（onSearch，P4.2）。退出搜索时焦点回这一行（data-pi-nav） */}
      <SidebarNavRow data-pi-nav="search" icon={Search} label="搜索" selected={navSelected === "search"} onClick={onSearch} />
      {filterChip}
      {body ??
        (loading ? (
          <PiSkeletonRows rows={6} variant="desktop" className="mt-3" />
        ) : (
          <SidebarGroups {...groupsProps} variant="desktop" />
        ))}
      {listNote && (
        <p className="m-0 px-1.5 pt-3 text-(length:--cw-text-sm) leading-(--cw-leading-sm) text-(--cw-pi-text-secondary)">{listNote}</p>
      )}
    </Sidebar>
  )
}
