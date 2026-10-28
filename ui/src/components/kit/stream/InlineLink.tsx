import type { ComponentPropsWithoutRef, MouseEvent } from "react"
import type { Forced } from "@/components/kit/types"
import { cn } from "@/lib/utils"

export interface InlineLinkProps extends ComponentPropsWithoutRef<"a"> {
  /** 等宽蓝字（#12 "/atlas/feedback/natural-language"、#21 Files 段的路径） */
  mono?: boolean
  /** 静态复现悬停态（下划线，推断） */
  forced?: Forced
}

/**
 * 正文里的蓝色文字链接，无底色（#7 "#89577"、#9 Draft PR URL）。
 * 复刻里点击不跳转（specs/ch2 §4.4）；href 只保留语义。
 */
export function InlineLink({ mono, forced, href = "#", onClick, className, ...rest }: InlineLinkProps) {
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    onClick?.(e)
  }
  return (
    <a
      href={href}
      onClick={handleClick}
      data-forced={forced}
      className={cn(
        "cursor-pointer text-(--cw-link) no-underline underline-offset-2 [overflow-wrap:anywhere] hover:underline data-[forced=hover]:underline",
        mono && "font-(family-name:--cw-font-mono) text-(length:--cw-text-code)",
        className,
      )}
      {...rest}
    />
  )
}
