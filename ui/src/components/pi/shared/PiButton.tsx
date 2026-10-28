import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/kit"

export interface PiButtonProps extends ComponentProps<"button"> {
  /** primary = 黑色主按钮（kit Button solid-black）；outline = 白底细描边、黑字的次要动作（kit Button outline，字重照 dialog-usage 用常规） */
  kind?: "primary" | "outline"
  /** desktop = 32 高、圆角 --cw-radius-button；phone = 44 高（= --cw-pi-touch）、圆角 10。默认 desktop */
  variant?: "desktop" | "phone"
}

/**
 * 弹窗 / sheet 底部的矩形按钮（PiDialog、PiSheet 的 footer 槽）。kit Button 的 size="lg"（32 高、左右 14）+ variant solid-black / outline
 * （kit-requests pi c2；原先 c 区 COutlineButton / CPrimaryButton 各写一份）。三区共用一套：手机 44 高、圆角 10，字号跟 --cw-text-md
 * （桌面 13 / 手机 15）。宽度由使用方给（手机常用 flex-1 / w-full）。
 */
export function PiButton({ kind = "primary", variant = "desktop", className, type = "button", ...rest }: PiButtonProps) {
  const phone = variant === "phone"
  return (
    <Button
      variant={kind === "primary" ? "solid-black" : "outline"}
      size="lg"
      type={type}
      // P4.5：弹窗打开时没有输入框就把焦点给主按钮（PiDialog 的 piInitialFocusOf 认这个标记）
      data-pi-primary={kind === "primary" ? "" : undefined}
      className={cn(kind === "outline" && "font-normal", phone && "h-11 rounded-[10px]", className)}
      {...rest}
    />
  )
}
