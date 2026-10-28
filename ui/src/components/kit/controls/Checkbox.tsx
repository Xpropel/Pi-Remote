import type { ComponentProps } from "react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"
import { Check, Minus } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { focusRing, type Forced } from "./shared"

export interface CheckboxProps extends ComponentProps<typeof CheckboxPrimitive.Root> {
  /**
   * diff：14×14、圆角 4、浅灰底的「灰色圆角方框」（diffs view 的汇总行 / 文件行，#5 #12 #13，默认）；
   * menu：12.5×12.5、圆角 3、白底（RepoPicker L2 的多选行，#18）。
   * 勾选态两者相同：--cw-blue 实底 + 白勾。checked="indeterminate"：未勾的底 + 灰色短横线（推断）。
   */
  variant?: "diff" | "menu"
  forced?: Forced
}

/** Radix Checkbox。checked / defaultChecked / onCheckedChange 同 Radix。 */
export function Checkbox({ variant = "diff", forced, className, ...rest }: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      data-variant={variant}
      data-forced={forced}
      className={cn(
        "inline-grid shrink-0 place-items-center border border-solid border-(--cw-border-strong) p-0 text-(--cw-primary-fg) disabled:opacity-50",
        "data-[state=checked]:border-(--cw-blue) data-[state=checked]:bg-(--cw-blue)",
        variant === "diff"
          ? "size-3.5 rounded-(--cw-radius-xs) bg-(--cw-chip-bg)"
          : "size-[12.5px] rounded-[3px] bg-(--cw-surface)",
        focusRing,
        className,
      )}
      {...rest}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="grid place-items-center">
        {/* indeterminate（推断，帧里没有；kit-requests ch3 #12）：框保持未勾的灰底，中间画一条 --cw-text-2 短横线 */}
        <Check
          aria-hidden
          strokeWidth={3}
          className={cn(variant === "diff" ? "size-2.5" : "size-[9px]", "in-data-[state=indeterminate]:hidden")}
        />
        <Minus
          aria-hidden
          strokeWidth={2.5}
          className={cn(
            variant === "diff" ? "size-2.5" : "size-[9px]",
            "hidden text-(--cw-text-2) in-data-[state=indeterminate]:block",
          )}
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}
