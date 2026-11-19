import type { ChangeEvent, ComponentProps, KeyboardEvent } from "react"
import type { Forced } from "@/components/kit/types"
import { cn } from "@/lib/utils"

export interface MenuSearchProps extends Omit<ComponentProps<"input">, "size"> {
  /** 输入变化时拿到纯字符串 */
  onValueChange?: (value: string) => void
  forced?: Forced
}

/**
 * 菜单顶部的搜索行：内嵌柔边圆角胶囊输入，告别生硬的通栏黑细线。
 * 根节点就是 <input>，data-cw-id 直接落在输入框上，交互脚本可以 type 进去。
 * 在 Radix 菜单里：字符键不冒泡到菜单（避免 typeahead 抢焦点），↑↓ / Esc / Tab 照常交给菜单。
 */
export function MenuSearch({ className, onValueChange, onChange, onKeyDown, forced, ...rest }: MenuSearchProps) {
  return (
    <input
      type="text"
      data-slot="menu-search"
      data-forced={forced}
      autoComplete="off"
      spellCheck={false}
      className={cn(
        "mb-1.5 block h-8 w-full min-w-0 shrink-0 appearance-none rounded-[12px] border border-solid border-transparent bg-(--cw-chip-bg)/65 px-3 py-0 [font-family:inherit] text-(length:--cw-text-md) text-(--cw-text) outline-none transition-colors placeholder:text-(--cw-text-4) focus-visible:border-(--cw-pi-field-focus-border) focus-visible:bg-(--cw-surface)",
        className,
      )}
      onChange={(event: ChangeEvent<HTMLInputElement>) => {
        onChange?.(event)
        onValueChange?.(event.currentTarget.value)
      }}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        onKeyDown?.(event)
        const k = event.key
        if (k.length === 1 || k === "Backspace" || k === "Delete" || k === "Home" || k === "End") {
          event.stopPropagation()
        }
      }}
      {...rest}
    />
  )
}
