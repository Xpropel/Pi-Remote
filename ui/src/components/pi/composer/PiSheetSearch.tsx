import type { ComponentProps } from "react"
import { Search } from "@/components/kit/icons"
import { cn } from "@/lib/utils"

/**
 * 手机 sheet 顶部的搜索框（模型、文件夹选择同一种，和命令面板手机版同一版式）：44 高的浅灰圆角底 + 放大镜，
 * 16px 字防 iOS 聚焦放大；聚焦提示是内圈 1px 中性描边（文本输入不用蓝色外环）。
 */
export function PiSheetSearch({ className, ...rest }: Omit<ComponentProps<"input">, "type">) {
  return (
    <label
      data-slot="pi-sheet-search"
      className={cn(
        "flex h-11 shrink-0 items-center gap-2 rounded-[10px] bg-(--cw-chip-bg) px-3 focus-within:[box-shadow:inset_0_0_0_1px_var(--cw-pi-field-focus-border)]",
        className,
      )}
    >
      <Search aria-hidden strokeWidth={1.5} className="size-[18px] shrink-0 text-(--cw-text-4)" />
      <input
        type="search"
        autoComplete="off"
        spellCheck={false}
        className="min-w-0 flex-1 self-stretch border-0 bg-transparent p-0 text-[16px] text-(--cw-text) outline-none placeholder:text-(--cw-text-4)"
        {...rest}
      />
    </label>
  )
}
