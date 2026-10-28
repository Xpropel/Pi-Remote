import type { ComponentProps, MouseEvent, ReactNode } from "react"
import { ContextMenu as ContextMenuPrimitive, DropdownMenu as DropdownMenuPrimitive } from "radix-ui"
import type { Forced } from "@/components/kit/types"
import { Check, ChevronRight } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { KbdHint } from "../controls/KbdHint"
import { useMenuContext, type MenuKind } from "./MenuSurface"

export interface MenuItemProps extends Omit<ComponentProps<"div">, "onSelect"> {
  /** 行首图标（16px 盒、线宽 1.5、--cw-icon-fg）。多选行可传 <><Checkbox variant="menu" /><Folder /></> */
  icon?: ReactNode
  /** 主文字后的行内副文案（11px --cw-text-3，例如 ModelMenu 的 "Efficiency"、"Medium 1M"） */
  detail?: ReactNode
  /** 第二行副标题（12px --cw-text-3，与主文字左对齐，例如 #5 子菜单 Cloud 下的 "anysphere/cursor-sh-landing"） */
  subtitle?: ReactNode
  /** 行尾快捷键，例如 '⌘D'、'⇧⌘E'（12px） */
  shortcut?: string
  /** 行尾自定义内容：计数 "0"、Switch、"↺ Edit" 等（默认 13px --cw-text-2） */
  trailing?: ReactNode
  /** 行尾 ✓（选中只靠素勾，不换底、不加粗，#17） */
  checked?: boolean
  /** 行尾 ›（Submenu 的父项会自动加） */
  chevron?: boolean
  /** 静态强制高亮（帧态）。用户在本卡里动过指针或键盘后自动让位给真实高亮。 */
  highlighted?: boolean
  /** 等同 highlighted（菜单里悬停 = 高亮） */
  forced?: Forced
  /** 弱化项：文字与图标都用 --cw-text-4（#18 No Repo / New Folder），仍可点 */
  weak?: boolean
  disabled?: boolean
  /** md = 行高 --cw-menu-row-h（26）+ 13px（默认）；lg = --cw-popover-row-h（28）+ 14px（#20 放大帧） */
  size?: "md" | "lg"
  /** Radix typeahead 用的纯文本 */
  textValue?: string
  /** 选中（点击 / 回车）。Radix 模式下 event.preventDefault() 可阻止菜单关闭。 */
  onSelect?: (event: Event) => void
}

interface RowClassOptions {
  kind: MenuKind
  size?: "md" | "lg"
  weak?: boolean
  dim: boolean
  forcedOn: boolean
  twoLine: boolean
}

/** 菜单行外观（MenuItem 与 Submenu 父项共用） */
export function menuItemClass({ kind, size = "md", weak, dim, forcedOn, twoLine }: RowClassOptions): string {
  const dimmed = dim && !weak
  return cn(
    "group/menu-item relative flex w-full min-w-0 shrink-0 cursor-default items-center gap-2 rounded-[var(--cw-menu-item-radius,6px)] px-2 text-left outline-none select-none",
    size === "lg"
      ? "min-h-(--cw-popover-row-h) text-(length:--cw-text-base)"
      : "min-h-(--cw-menu-row-h) text-(length:--cw-text-md)",
    "leading-(--cw-leading-tight)",
    twoLine && "items-start py-1",
    weak ? "text-(--cw-text-4)" : dimmed ? "text-(--cw-text-2)" : "text-(--cw-text)",
    // 高亮：Radix 的 data-highlighted、子菜单打开的 data-state=open、静态模式的 :hover、帧态强制
    "data-[highlighted]:bg-(--cw-row-hover) data-[state=open]:bg-(--cw-row-hover)",
    kind === "static" && "hover:bg-(--cw-row-hover)",
    forcedOn && "bg-(--cw-row-hover)",
    dimmed && "data-[highlighted]:text-(--cw-text) data-[state=open]:text-(--cw-text)",
    dimmed && kind === "static" && "hover:text-(--cw-text)",
    dimmed && forcedOn && "text-(--cw-text)",
    "data-[disabled]:pointer-events-none data-[disabled]:text-(--cw-text-4)",
  )
}

interface MenuItemContentProps {
  icon?: ReactNode
  label?: ReactNode
  detail?: ReactNode
  subtitle?: ReactNode
  shortcut?: string
  trailing?: ReactNode
  checked?: boolean
  chevron?: boolean
  weak?: boolean
  dim: boolean
  forcedOn: boolean
}

/** 菜单行内部排版（MenuItem 与 Submenu 父项共用） */
export function MenuItemContent({
  icon,
  label,
  detail,
  subtitle,
  shortcut,
  trailing,
  checked,
  chevron,
  weak,
  dim,
  forcedOn,
}: MenuItemContentProps) {
  const dimmed = dim && !weak && !forcedOn
  const hasTrailing = trailing != null || !!shortcut || !!checked || !!chevron
  return (
    <>
      {icon != null && (
        <span
          data-slot="menu-item-icon"
          className={cn(
            "flex h-(--cw-leading-tight) min-w-4 shrink-0 items-center justify-center gap-2 [&>svg]:size-(--cw-icon-size) [&>svg]:stroke-[1.5]",
            weak
              ? "text-(--cw-text-4)"
              : dimmed
                ? "text-(--cw-text-4) group-data-[highlighted]/menu-item:text-(--cw-icon-fg) group-data-[state=open]/menu-item:text-(--cw-icon-fg)"
                : "text-(--cw-icon-fg)",
          )}
        >
          {icon}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-1">
          <span data-slot="menu-item-label" className="min-w-0 truncate">
            {label}
          </span>
          {detail != null && (
            <span
              data-slot="menu-item-detail"
              className="shrink-0 truncate text-(length:--cw-text-xs) text-(--cw-text-3)"
            >
              {detail}
            </span>
          )}
        </span>
        {subtitle != null && (
          <span
            data-slot="menu-item-subtitle"
            className="truncate text-(length:--cw-text-sm) leading-(--cw-leading-sm) text-(--cw-text-3)"
          >
            {subtitle}
          </span>
        )}
      </span>
      {hasTrailing && (
        <span
          data-slot="menu-item-trailing"
          className={cn(
            "ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-(--cw-text-2)",
            subtitle != null && "h-(--cw-leading-tight)",
          )}
        >
          {trailing}
          {shortcut && <KbdHint keys={shortcut} size="sm" tone="muted" />}
          {checked && (
            <Check aria-hidden strokeWidth={1.5} className="size-(--cw-icon-size-sm) text-(--cw-icon-fg)" />
          )}
          {chevron && (
            <ChevronRight aria-hidden strokeWidth={1.5} className="size-(--cw-icon-size-sm) text-(--cw-icon-fg)" />
          )}
        </span>
      )}
    </>
  )
}

/**
 * 菜单项：图标 + 文字（+ 行内副文案 / 第二行副标题）+ 行尾（快捷键 / ✓ / › / 自定义）。
 * 所在 MenuSurface 的 kind 决定它渲染成 Radix Item 还是普通 div。
 */
export function MenuItem({
  icon,
  detail,
  subtitle,
  shortcut,
  trailing,
  checked,
  chevron,
  highlighted,
  forced,
  weak,
  disabled,
  size,
  textValue,
  onSelect,
  className,
  children,
  onClick,
  ...rest
}: MenuItemProps) {
  const { kind, dim, interacted } = useMenuContext()
  const forcedOn = (!!highlighted || forced != null) && !interacted
  const cls = cn(menuItemClass({ kind, size, weak, dim, forcedOn, twoLine: subtitle != null }), className)
  const data = {
    "data-slot": "menu-item",
    "data-forced": forcedOn ? "hover" : undefined,
    "data-weak": weak ? "" : undefined,
    "data-checked": checked ? "" : undefined,
  }
  const content = (
    <MenuItemContent
      icon={icon}
      label={children}
      detail={detail}
      subtitle={subtitle}
      shortcut={shortcut}
      trailing={trailing}
      checked={checked}
      chevron={chevron}
      weak={weak}
      dim={dim}
      forcedOn={forcedOn}
    />
  )

  if (kind === "dropdown") {
    return (
      <DropdownMenuPrimitive.Item
        {...data}
        disabled={disabled}
        textValue={textValue}
        onSelect={onSelect}
        onClick={onClick}
        className={cls}
        {...rest}
      >
        {content}
      </DropdownMenuPrimitive.Item>
    )
  }
  if (kind === "context") {
    return (
      <ContextMenuPrimitive.Item
        {...data}
        disabled={disabled}
        textValue={textValue}
        onSelect={onSelect}
        onClick={onClick}
        className={cls}
        {...rest}
      >
        {content}
      </ContextMenuPrimitive.Item>
    )
  }
  return (
    <div
      role="menuitem"
      tabIndex={disabled ? undefined : -1}
      aria-disabled={disabled || undefined}
      data-disabled={disabled ? "" : undefined}
      {...data}
      className={cls}
      onClick={(event: MouseEvent<HTMLDivElement>) => {
        onClick?.(event)
        if (!disabled) onSelect?.(event.nativeEvent)
      }}
      {...rest}
    >
      {content}
    </div>
  )
}
