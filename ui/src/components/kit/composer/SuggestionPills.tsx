import type { ComponentProps, ReactNode } from "react"
import type { Forced } from "@/components/kit/types"
import { Pill } from "@/components/kit"
import { AgentPlaneIcon } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { subId } from "../stream/util"

/** 一颗建议 pill：primary = 黑底白字（全图唯一的黑色主建议，#16）；否则透明底细描边 */
export interface SuggestionPill {
  /** 也是子元素 data-cw-id 的后缀：`<id>-<key>` */
  key: string
  label: ReactNode
  primary?: boolean
  /** 前置图标（黑 pill 的纸飞机） */
  icon?: ReactNode
  /** 行尾快捷键原文（'⇧Tab'） */
  kbd?: string
  /** 静态悬停 / 按下态（推断：黑 pill 底变浅一档、描边 pill 底变 --cw-row-hover） */
  forced?: Forced
}

/** #16 empty-state-composer：Set up Agent Demos（黑）+ Plan New Idea ⇧Tab（描边） */
export const EMPTY_STATE_SUGGESTIONS: SuggestionPill[] = [
  { key: "agent-demos", label: "Set up Agent Demos", primary: true, icon: <AgentPlaneIcon strokeWidth={2} /> },
  { key: "plan", label: "Plan New Idea", kbd: "⇧Tab" },
]

/** #17 run-on-menu：Plan New Idea ⇧Tab + Multitask（两颗描边，本帧没有黑 pill） */
export const RUN_ON_SUGGESTIONS: SuggestionPill[] = [
  { key: "plan", label: "Plan New Idea", kbd: "⇧Tab" },
  { key: "multitask", label: "Multitask" },
]

export interface SuggestionPillsProps extends Omit<ComponentProps<"div">, "children"> {
  /** 默认 #16 的两颗 */
  items?: SuggestionPill[]
  /** pill 的额外 class（屏幕按帧微调高度 / 内距用） */
  pillClassName?: string
}

/**
 * 空状态建议 pill 行：composer 框下方、与框左缘对齐的一排胶囊（一黑 + 描边）。
 * 用 kit Pill：黑 = solid-black（13px/500 白字）；描边 = outline + fill="transparent"（实测与页面同色，不是白底）。
 * 点击行为图上没有（推断为把提示填进输入框），这里只给 hover / 按下态。
 * 子元素 id = `<id>-<item.key>`。
 */
export function SuggestionPills({ items = EMPTY_STATE_SUGGESTIONS, pillClassName, className, ...rest }: SuggestionPillsProps) {
  return (
    <div data-slot="suggestion-pills" className={cn("flex min-w-0 items-center gap-2", className)} {...rest}>
      {items.map((item) => (
        <Pill
          key={item.key}
          data-cw-id={subId(rest, item.key)}
          variant={item.primary ? "solid-black" : "outline"}
          fill="transparent"
          icon={item.icon}
          kbd={item.kbd}
          forced={item.forced}
          className={pillClassName}
        >
          {item.label}
        </Pill>
      ))}
    </div>
  )
}
