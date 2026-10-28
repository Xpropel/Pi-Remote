import type { ComponentProps } from "react"
import { ContextMenu as ContextMenuPrimitive, DropdownMenu as DropdownMenuPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"
import { useMenuContext } from "./MenuSurface"

export type MenuSeparatorProps = ComponentProps<"div">

/** 1px 细分隔线，上下各 4、左右通栏（抵消卡的内边距）。色 --cw-divider-soft（#5 #17 #18）。 */
export function MenuSeparator({ className, ...rest }: MenuSeparatorProps) {
  const { kind } = useMenuContext()
  const cls = cn("-mx-[var(--cw-menu-pad,4px)] my-1 h-px shrink-0 bg-(--cw-divider-soft)", className)
  if (kind === "dropdown") return <DropdownMenuPrimitive.Separator data-slot="menu-separator" className={cls} {...rest} />
  if (kind === "context") return <ContextMenuPrimitive.Separator data-slot="menu-separator" className={cls} {...rest} />
  return <div role="separator" aria-orientation="horizontal" data-slot="menu-separator" className={cls} {...rest} />
}
