import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type PointerEvent,
} from "react"
import { ContextMenu as ContextMenuPrimitive, DropdownMenu as DropdownMenuPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

/**
 * 菜单的行为层：
 * - static：纯 DOM，不接 Radix。用于目录、帧里的静态菜单、悬停卡 / 说明卡这类「只是长得像菜单」的卡。
 *   支持 CSS 悬停高亮、Submenu 悬停开合；没有键盘导航、Esc / 点外部关闭（这些交给消费方或改用 Radix 模式）。
 * - dropdown：MenuSurface 本身就是 Radix DropdownMenu.Content（默认带 Portal），放在 DropdownMenu.Root 里；
 *   MenuItem / MenuLabel / MenuSeparator / Submenu 自动换成 DropdownMenu 的对应原语。
 * - context：同上，换成 Radix ContextMenu。
 */
export type MenuKind = "static" | "dropdown" | "context"

export interface MenuContextValue {
  kind: MenuKind
  /** Radix 模式下子菜单是否也走 Portal（跟随所在 MenuSurface 的 portal） */
  portal: boolean
  /** 本卡开启了 dimInactive：非活动项降色（#18 子菜单获得焦点时的父菜单） */
  dim: boolean
  /**
   * 用户已在本卡里移动过指针或按过键。之后 highlighted / forced 这种「帧态强制高亮」让位给真实高亮，
   * 避免出现两行同时高亮。
   */
  interacted: boolean
}

const MenuContext = createContext<MenuContextValue>({ kind: "static", portal: true, dim: false, interacted: false })

/** 菜单内部件读取所在卡的行为层 */
export function useMenuContext(): MenuContextValue {
  return useContext(MenuContext)
}

type DropdownContentProps = ComponentProps<typeof DropdownMenuPrimitive.Content>
type SubContentProps = ComponentProps<typeof DropdownMenuPrimitive.SubContent>

/** Radix 定位与关闭行为相关的属性（kind="static" 时忽略） */
type RadixContentOptions = Pick<
  DropdownContentProps,
  | "side"
  | "sideOffset"
  | "align"
  | "alignOffset"
  | "avoidCollisions"
  | "collisionPadding"
  | "sticky"
  | "hideWhenDetached"
  | "loop"
  | "onCloseAutoFocus"
  | "onEscapeKeyDown"
  | "onPointerDownOutside"
  | "onFocusOutside"
  | "onInteractOutside"
>

export interface MenuSurfaceProps extends ComponentProps<"div">, RadixContentOptions {
  /** 行为层，默认 static（见 MenuKind） */
  kind?: MenuKind
  /**
   * 打开时的初始焦点（Radix 默认放在菜单本身）。有搜索框的菜单在这里 event.preventDefault() 再把焦点给搜索框。
   * radix-ui 的 Content 公开类型里没有这个属性，运行时由 Menu 的内部 Content 接收；kind="static" 和子菜单忽略。
   */
  onOpenAutoFocus?: (event: Event) => void
  /** 投影：menu = --cw-shadow-menu（右键菜单 / 下拉菜单，默认）；popover = --cw-shadow-popover（弹层 / 悬停卡） */
  elevation?: "menu" | "popover"
  /** 非活动项降色（#18 开、#17 关）。Radix 模式下通常传 dimInactive={子菜单是否打开} */
  dimInactive?: boolean
  /** Radix 模式是否走 Portal，默认 true；false 时渲染在原位（仍按 Popper 定位） */
  portal?: boolean
  forceMount?: true
}

/**
 * 白底圆角卡 + 细描边（投影 token 里的 0.5px 外圈）+ 柔和投影。内边距 4（--cw-menu-pad，估计）。
 * 宽度由屏幕给（className="w-[223px]"）；不写时按内容自适应。所有菜单、弹层、悬停卡共用。
 */
export const menuSurfaceClass =
  "z-50 flex w-max min-w-0 flex-col rounded-(--cw-radius-popover) bg-(--cw-surface) p-[var(--cw-menu-pad,4px)] text-(length:--cw-text-md) leading-(--cw-leading-tight) text-(--cw-text) outline-none select-none"

export function menuShadowClass(elevation: "menu" | "popover" = "menu"): string {
  return elevation === "popover" ? "shadow-(--cw-shadow-popover)" : "shadow-(--cw-shadow-menu)"
}

interface SurfaceImplProps extends MenuSurfaceProps {
  /** 内部用：Submenu 的子卡渲染成 Radix SubContent */
  layer?: "content" | "sub-content"
  /** 内部用：SubContent 的对齐 */
  subAlign?: SubContentProps["align"]
}

/** MenuSurface 与 Submenu 子卡共用的实现 */
export function MenuSurfaceImpl({
  kind = "static",
  elevation = "menu",
  dimInactive = false,
  portal = true,
  layer = "content",
  subAlign,
  side,
  sideOffset,
  align,
  alignOffset,
  avoidCollisions,
  collisionPadding,
  sticky,
  hideWhenDetached,
  loop,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onEscapeKeyDown,
  onPointerDownOutside,
  onFocusOutside,
  onInteractOutside,
  forceMount,
  className,
  onPointerMove,
  onKeyDown,
  children,
  ...rest
}: SurfaceImplProps) {
  const [interacted, setInteracted] = useState(false)
  const ctx = useMemo<MenuContextValue>(
    () => ({ kind, portal, dim: dimInactive, interacted }),
    [kind, portal, dimInactive, interacted],
  )
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    onPointerMove?.(event)
    if (!interacted) setInteracted(true)
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event)
    if (!interacted) setInteracted(true)
  }
  const common = {
    "data-slot": layer === "sub-content" ? "menu-sub-surface" : "menu-surface",
    "data-elevation": elevation,
    "data-dim-inactive": dimInactive ? "" : undefined,
    className: cn(menuSurfaceClass, menuShadowClass(elevation), className),
    onPointerMove: handlePointerMove,
    onKeyDown: handleKeyDown,
    ...rest,
  }
  const body = <MenuContext.Provider value={ctx}>{children}</MenuContext.Provider>
  const dismiss = { onEscapeKeyDown, onPointerDownOutside, onFocusOutside, onInteractOutside }
  const collision = { avoidCollisions, collisionPadding, sticky, hideWhenDetached, loop }
  // 只给根 Content（见 MenuSurfaceProps.onOpenAutoFocus）：公开类型里没有，按对象展开
  const openFocus: object = onOpenAutoFocus ? { onOpenAutoFocus } : {}

  if (kind === "dropdown") {
    const node =
      layer === "sub-content" ? (
        <DropdownMenuPrimitive.SubContent
          {...common}
          {...dismiss}
          {...collision}
          sideOffset={sideOffset}
          alignOffset={alignOffset}
          align={subAlign}
          forceMount={forceMount}
        >
          {body}
        </DropdownMenuPrimitive.SubContent>
      ) : (
        <DropdownMenuPrimitive.Content
          {...common}
          {...dismiss}
          {...collision}
          {...openFocus}
          side={side}
          sideOffset={sideOffset}
          align={align}
          alignOffset={alignOffset}
          onCloseAutoFocus={onCloseAutoFocus}
          forceMount={forceMount}
        >
          {body}
        </DropdownMenuPrimitive.Content>
      )
    return portal ? <DropdownMenuPrimitive.Portal forceMount={forceMount}>{node}</DropdownMenuPrimitive.Portal> : node
  }

  if (kind === "context") {
    const node =
      layer === "sub-content" ? (
        <ContextMenuPrimitive.SubContent
          {...common}
          {...dismiss}
          {...collision}
          sideOffset={sideOffset}
          alignOffset={alignOffset}
          align={subAlign}
          forceMount={forceMount}
        >
          {body}
        </ContextMenuPrimitive.SubContent>
      ) : (
        // ContextMenu.Content 的 side / sideOffset / align 由 Radix 固定（贴指针位置）
        <ContextMenuPrimitive.Content
          {...common}
          {...dismiss}
          {...collision}
          {...openFocus}
          alignOffset={alignOffset}
          onCloseAutoFocus={onCloseAutoFocus}
          forceMount={forceMount}
        >
          {body}
        </ContextMenuPrimitive.Content>
      )
    return portal ? <ContextMenuPrimitive.Portal forceMount={forceMount}>{node}</ContextMenuPrimitive.Portal> : node
  }

  return (
    <div role="menu" {...common}>
      {body}
    </div>
  )
}

/** 菜单 / 弹层的白卡。kind="dropdown" | "context" 时它就是 Radix 的 Content。 */
export function MenuSurface(props: MenuSurfaceProps) {
  return <MenuSurfaceImpl {...props} />
}
