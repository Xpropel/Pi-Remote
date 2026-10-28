import type { ComponentProps } from "react"
import { Switch as SwitchPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"
import { focusRing, type Forced } from "./shared"

export interface SwitchProps extends ComponentProps<typeof SwitchPrimitive.Root> {
  /** 打开态颜色：blue = --cw-blue（#18 Select Multiple，默认）；green = --cw-green-solid（#19 MAX Mode） */
  tone?: "blue" | "green"
  /** sm：轨道 26×14.5（#18，默认）；md：28×17（#19，估计）；lg：51×31、圆点 27（iOS 尺寸，pi c 手机设置页） */
  size?: "sm" | "md" | "lg"
  forced?: Forced
}

/**
 * Radix Switch。关闭态轨道用 --cw-border-strong（推断：帧里只拍到打开态）。
 * 圆点颜色读 --cw-switch-thumb（tokens.local.css，默认 #FFFFFF；深色主题反转 --cw-primary-fg 时圆点不跟着变黑，kit-requests pi a）。
 * 圆点直径 = 轨道高 − 3px（lg 为 −4），打开时在右。checked / defaultChecked / onCheckedChange 同 Radix。
 */
export function Switch({ tone = "blue", size = "sm", forced, className, ...rest }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-tone={tone}
      data-forced={forced}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-(--cw-radius-pill) bg-(--cw-border-strong) p-0 disabled:opacity-50",
        tone === "blue" ? "data-[state=checked]:bg-(--cw-blue)" : "data-[state=checked]:bg-(--cw-green-solid)",
        size === "sm" ? "h-[14.5px] w-[26px]" : size === "md" ? "h-[17px] w-[28px]" : "h-[31px] w-[51px]",
        focusRing,
        className,
      )}
      {...rest}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block translate-x-[1.5px] rounded-full bg-(--cw-switch-thumb) shadow-(--cw-shadow-float) transition-transform duration-150",
          size === "sm"
            ? "size-[11.5px] data-[state=checked]:translate-x-[13px]"
            : size === "md"
              ? "size-[14px] data-[state=checked]:translate-x-[12.5px]"
              : "size-[27px] translate-x-[2px] data-[state=checked]:translate-x-[22px]",
        )}
      />
    </SwitchPrimitive.Root>
  )
}
