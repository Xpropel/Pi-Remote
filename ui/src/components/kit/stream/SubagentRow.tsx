import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from "react"
import { STREAM_INSET, STREAM_LINE_GAP, STREAM_TEXT } from "@/components/kit/stream/styles"
import { cn } from "@/lib/utils"

/** 两个已见角色（#6 hunt-og-render）：Explorer 浅长春花蓝、Designer 浅丁香紫 */
export type SubagentTone = "explorer" | "designer"

export interface SubagentRowProps extends Omit<ComponentPropsWithoutRef<"div">, "role" | "color"> {
  /** 角色名原文："Explorer"、"Designer" */
  role: ReactNode
  /** 任务描述原文（灰字），例如 "Map turn event types and rendering order" */
  description: ReactNode
  /** 角色色：explorer = --cw-role-explorer，designer = --cw-role-designer（tokens，均为估计值） */
  tone?: SubagentTone
  /** 自定义角色色（任意 CSS 颜色 / var()）；给了就覆盖 tone */
  color?: string
}

const TONE: Record<SubagentTone, string> = {
  explorer: "var(--cw-role-explorer)",
  designer: "var(--cw-role-designer)",
}

/**
 * 流内 subagent 署名行（specs/ch2 §1.3 #7 #8，§5.1）：彩色角色名 + 空格 + 灰色任务描述。
 * 无图标、无框、单行截断；字号行高同正文（14/21），与 ToolLine 同属"轻"一档，左右内缩跟随对话列。
 * 静态行：帧里没有展开 / 点击结果（不做交互，见 specs/ch2 §1.4）。
 */
export function SubagentRow({ role, description, tone = "explorer", color, className, style, ...rest }: SubagentRowProps) {
  const roleColor = color ?? TONE[tone]
  return (
    <div
      data-slot="subagent-row"
      data-tone={color ? "custom" : tone}
      className={cn(STREAM_TEXT, STREAM_INSET, STREAM_LINE_GAP, "truncate", className)}
      style={{ "--subagent-role": roleColor, ...style } as CSSProperties}
      {...rest}
    >
      <span data-slot="subagent-role" className="text-(--subagent-role)">
        {role}
      </span>{" "}
      <span data-slot="subagent-description" className="text-(--cw-text-3)">
        {description}
      </span>
    </div>
  )
}
