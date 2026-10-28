import type { ComponentProps } from "react"
import { ContextMenu as ContextMenuPrimitive, DropdownMenu as DropdownMenuPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"
import { useMenuContext } from "./MenuSurface"

export type MenuLabelProps = ComponentProps<"div">

/**
 * 分组小标题 / 菜单标题（Repos、Recents、Run on、Self-Hosted Machines、Actions、Suggestions）。
 * 12px/400 --cw-text-3，左缘与菜单项图标左缘对齐，行高约 24。
 */
export function MenuLabel({ className, ...rest }: MenuLabelProps) {
  const { kind } = useMenuContext()
  const cls = cn(
    "flex h-6 shrink-0 items-center px-2 text-(length:--cw-text-sm) leading-(--cw-leading-sm) font-normal text-(--cw-text-3) select-none",
    className,
  )
  if (kind === "dropdown") return <DropdownMenuPrimitive.Label data-slot="menu-label" className={cls} {...rest} />
  if (kind === "context") return <ContextMenuPrimitive.Label data-slot="menu-label" className={cls} {...rest} />
  return <div data-slot="menu-label" className={cls} {...rest} />
}
