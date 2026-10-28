/**
 * 二级菜单（父项 + 右侧接出的子卡）：P9 C 从 Cursor 复刻工程原样搬入
 * `.agents/tasks/cursor-replica-2026-10-24/replica/src/components/kit/menu/Submenu.tsx`。
 * 唯一改动：`@/app/types` → `@/components/kit/types`（ui 里叫这个名字，只有 Forced 一个类型）。
 * import-replica.mjs 已冻结，这个文件是手搬的；kit/index.ts 的出口也是手加的（见那边的头注释）。
 */
import { useCallback, useEffect, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from "react"
import { ContextMenu as ContextMenuPrimitive, DropdownMenu as DropdownMenuPrimitive } from "radix-ui"
import type { Forced } from "@/components/kit/types"
import { cn } from "@/lib/utils"
import { MenuItemContent, menuItemClass } from "./MenuItem"
import { MenuSurfaceImpl, useMenuContext, type MenuSurfaceProps } from "./MenuSurface"

export interface SubmenuProps extends Omit<ComponentProps<"div">, "children" | "onSelect"> {
  /** 父项文字 */
  label: ReactNode
  /** 父项图标 */
  icon?: ReactNode
  /** 父项行内副文案 */
  detail?: ReactNode
  weak?: boolean
  disabled?: boolean
  size?: "md" | "lg"
  /** 父项帧态强制高亮（子菜单打开时父项本来就高亮，一般不用传） */
  highlighted?: boolean
  forced?: Forced
  /** 受控开合 */
  open?: boolean
  /** 初始打开（帧路由用：父项高亮 + 子卡已展开） */
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /**
   * 子卡左缘相对父项行右缘的水平偏移（Radix 语义）。父项行右缘 = 父卡右缘 − 内边距 4，
   * 所以 0 = 压进父卡 4px（#17），2 = 压进 2px（默认），5.5 = 离开父卡 1.5px（#18）。
   */
  sideOffset?: number
  /** 子卡顶（align="end" 时为子卡底）相对父项行顶（底）的竖直偏移，正数向下。默认 0（#17 顶对齐） */
  alignOffset?: number
  /** start = 子卡顶对齐父项行顶（默认）；end = 子卡底对齐父项行底（#18：下方放不下时整卡上移） */
  align?: "start" | "end"
  /** 仅 Radix 模式：碰撞时自动挪位，默认 true */
  avoidCollisions?: boolean
  /** 子卡属性：宽度 className、dimInactive、data-cw-id、elevation 等 */
  contentProps?: Omit<MenuSurfaceProps, "kind" | "children">
  /** 子卡内容（MenuItem / MenuLabel / MenuSearch / MenuSeparator…） */
  children: ReactNode
}

function useOpenState(open: boolean | undefined, defaultOpen: boolean | undefined, onOpenChange?: (o: boolean) => void) {
  const [inner, setInner] = useState(defaultOpen ?? false)
  const controlled = open !== undefined
  const value = controlled ? open : inner
  const set = useCallback(
    (next: boolean) => {
      if (!controlled) setInner(next)
      onOpenChange?.(next)
    },
    [controlled, onOpenChange],
  )
  return [value, set] as const
}

/**
 * 二级菜单：父项（高亮 + ›）+ 从父卡右缘接出的子卡。
 * - Radix 模式（所在 MenuSurface 为 dropdown / context）：DropdownMenu.Sub / ContextMenu.Sub，悬停或 → 打开，← / Esc 关闭。
 * - static 模式：悬停打开、移出 120ms 后关闭；子卡绝对定位在父项右侧。
 * 额外属性（data-cw-id 等）落在父项行上。
 */
export function Submenu({
  label,
  icon,
  detail,
  weak,
  disabled,
  size,
  highlighted,
  forced,
  open,
  defaultOpen,
  onOpenChange,
  sideOffset = 2,
  alignOffset = 0,
  align = "start",
  avoidCollisions,
  contentProps,
  className,
  children,
  ...rest
}: SubmenuProps) {
  const { kind, portal, dim, interacted } = useMenuContext()
  const forcedOn = (!!highlighted || forced != null) && !interacted
  const triggerClass = cn(menuItemClass({ kind, size, weak, dim, forcedOn, twoLine: false }), className)
  const triggerContent = (
    <MenuItemContent
      icon={icon}
      label={label}
      detail={detail}
      chevron
      weak={weak}
      dim={dim}
      forcedOn={forcedOn}
    />
  )
  const data = { "data-slot": "submenu-trigger", "data-forced": forcedOn ? "hover" : undefined }

  if (kind === "dropdown" || kind === "context") {
    return (
      <RadixSubmenu
        kind={kind}
        portal={portal}
        triggerClass={triggerClass}
        triggerContent={triggerContent}
        data={data}
        disabled={disabled}
        open={open}
        defaultOpen={defaultOpen}
        onOpenChange={onOpenChange}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        align={align}
        avoidCollisions={avoidCollisions}
        contentProps={contentProps}
        triggerProps={rest}
      >
        {children}
      </RadixSubmenu>
    )
  }

  return (
    <StaticSubmenu
      triggerClass={triggerClass}
      triggerContent={triggerContent}
      data={data}
      disabled={disabled}
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      sideOffset={sideOffset}
      alignOffset={alignOffset}
      align={align}
      contentProps={contentProps}
      triggerProps={rest}
    >
      {children}
    </StaticSubmenu>
  )
}

/** 页面上第一次出现这些事件，就算用户「动过」菜单（预开保护到此结束） */
const INTERACTION_EVENTS = ["pointerdown", "pointermove", "keydown"] as const

interface RadixSubmenuProps {
  kind: "dropdown" | "context"
  portal: boolean
  triggerClass: string
  triggerContent: ReactNode
  data: Record<string, string | undefined>
  disabled?: boolean
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  sideOffset: number
  alignOffset: number
  align: "start" | "end"
  avoidCollisions?: boolean
  contentProps?: Omit<MenuSurfaceProps, "kind" | "children">
  triggerProps: Omit<ComponentProps<"div">, "children" | "onSelect">
  children: ReactNode
}

/**
 * Radix 模式的子菜单。预开（非受控 + defaultOpen，帧态）时，用户第一次按键 / 按下 / 动指针之前，
 * 忽略 Radix 发来的「关子菜单」：
 * - 父卡挂载后 Radix 把焦点移到父卡本身，子卡的 focus-outside 据此关掉子卡（生产构建也会发生，截图里子卡消失）；
 * - dev 下 StrictMode 模拟卸载，MenuSub 的 effect 清理会调 onOpenChange(false)。
 * 用户动过之后照 Radix 原样开合（悬停父卡别的行、← / Esc、点外部）。受控用法原样转发，由调用方处理
 * （RowContextMenu、RepoPicker 各自有同样的保护）。
 */
function RadixSubmenu({
  kind,
  portal,
  triggerClass,
  triggerContent,
  data,
  disabled,
  open: openProp,
  defaultOpen,
  onOpenChange,
  sideOffset,
  alignOffset,
  align,
  avoidCollisions,
  contentProps,
  triggerProps,
  children,
}: RadixSubmenuProps) {
  const [open, setOpen] = useOpenState(openProp, defaultOpen, onOpenChange)
  const preopened = useRef(openProp === undefined && !!defaultOpen)
  useEffect(() => {
    if (!preopened.current) return
    function release() {
      preopened.current = false
      stop()
    }
    function stop() {
      for (const type of INTERACTION_EVENTS) document.removeEventListener(type, release, true)
    }
    // 捕获阶段挂在 document 上：先于 Radix 对同一事件的处理（例如悬停别的行时把焦点移走）
    for (const type of INTERACTION_EVENTS) document.addEventListener(type, release, true)
    return stop
  }, [])
  const onRadixOpenChange = useCallback(
    (next: boolean) => {
      if (!next && preopened.current) return
      setOpen(next)
    },
    [setOpen],
  )
  const P = kind === "dropdown" ? DropdownMenuPrimitive : ContextMenuPrimitive
  return (
    <P.Sub open={open} onOpenChange={onRadixOpenChange}>
      <P.SubTrigger {...data} disabled={disabled} className={triggerClass} {...triggerProps}>
        {triggerContent}
      </P.SubTrigger>
      <MenuSurfaceImpl
        {...contentProps}
        kind={kind}
        portal={portal}
        layer="sub-content"
        subAlign={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        avoidCollisions={avoidCollisions}
      >
        {children}
      </MenuSurfaceImpl>
    </P.Sub>
  )
}

interface StaticSubmenuProps {
  triggerClass: string
  triggerContent: ReactNode
  data: Record<string, string | undefined>
  disabled?: boolean
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  sideOffset: number
  alignOffset: number
  align: "start" | "end"
  contentProps?: Omit<MenuSurfaceProps, "kind" | "children">
  triggerProps: Omit<ComponentProps<"div">, "children" | "onSelect">
  children: ReactNode
}

function StaticSubmenu({
  triggerClass,
  triggerContent,
  data,
  disabled,
  open: openProp,
  defaultOpen,
  onOpenChange,
  sideOffset,
  alignOffset,
  align,
  contentProps,
  triggerProps,
  children,
}: StaticSubmenuProps) {
  const [open, setOpen] = useOpenState(openProp, defaultOpen, onOpenChange)
  const closeTimer = useRef<number | undefined>(undefined)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const cancelClose = () => window.clearTimeout(closeTimer.current)
  useEffect(() => () => window.clearTimeout(closeTimer.current), [])

  // 子卡打开期间，指针移到父卡的其他行上就收起（defaultOpen 的帧态没有 pointerenter 可依赖）。
  // 只认同一张卡里的其他行；卡的内边距、分隔线、组标题不算，免得从父项移向子卡时穿过缝隙就被关掉。
  useEffect(() => {
    if (!open) return
    const wrapper = wrapperRef.current
    const surfaceSel = '[data-slot="menu-surface"],[data-slot="menu-sub-surface"]'
    const surface = wrapper?.closest(surfaceSel)
    if (!wrapper || !surface) return
    const onMove = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (!target || wrapper.contains(target) || typeof target.closest !== "function") return
      const row = target.closest('[data-slot="menu-item"],[data-slot="submenu-trigger"]')
      if (row && row.closest(surfaceSel) === surface) setOpen(false)
    }
    document.addEventListener("pointermove", onMove)
    return () => document.removeEventListener("pointermove", onMove)
  }, [open, setOpen])

  const { onClick, ...triggerRest } = triggerProps
  const position: CSSProperties = {
    left: `calc(100% + ${sideOffset}px)`,
    ...(align === "end" ? { bottom: -alignOffset } : { top: alignOffset }),
  }
  const { className: contentClass, style: contentStyle, ...contentRest } = contentProps ?? {}

  return (
    <div
      ref={wrapperRef}
      data-slot="submenu"
      className="relative shrink-0"
      onPointerEnter={() => {
        cancelClose()
        if (!disabled && !open) setOpen(true)
      }}
      onPointerLeave={() => {
        cancelClose()
        closeTimer.current = window.setTimeout(() => setOpen(false), 120)
      }}
    >
      <div
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? undefined : -1}
        data-state={open ? "open" : "closed"}
        data-disabled={disabled ? "" : undefined}
        {...data}
        className={triggerClass}
        onClick={(event) => {
          onClick?.(event)
          if (!disabled) setOpen(!open)
        }}
        {...triggerRest}
      >
        {triggerContent}
      </div>
      {open && (
        <MenuSurfaceImpl
          {...contentRest}
          kind="static"
          layer="sub-content"
          className={cn("absolute", contentClass)}
          style={{ ...position, ...contentStyle }}
        >
          {children}
        </MenuSurfaceImpl>
      )}
    </div>
  )
}
