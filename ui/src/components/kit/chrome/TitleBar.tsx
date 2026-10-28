import type { ComponentProps, ReactNode } from "react"
import { HoverCard } from "radix-ui"
import type { Forced } from "@/components/kit/types"
import { cn } from "@/lib/utils"
import {
  ArrowUpRight,
  Cloud,
  Ellipsis,
  LaptopMinimal,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  type IconComponent,
} from "@/components/kit/icons"
import { GhostIconButton } from "@/components/kit/controls/GhostIconButton"

/**
 * main：标题 + 来源图标 + 右端 … 与分屏（#1 #3 #5 #6 #7 #9 #12 #15 #21 #28）；
 * empty：无标题，右端 IDE ↗ + … + 分屏（#2）；
 * chat-pane：侧栏收起时左窗格顶栏，红黄绿 + 侧栏开关（可带蓝角标）+ 搜索 + 标题 + 右端 + 与 …（#4 #14 #25 #26 #27）；
 * minimal：只有右端分屏（#29 Marketplace）。
 */
export type TitleBarVariant = "main" | "empty" | "chat-pane" | "minimal"

export interface TitleBarProps extends Omit<ComponentProps<"div">, "title"> {
  variant?: TitleBarVariant
  /** 会话标题（单行，超出 titleMaxWidth 用 … 截断） */
  title?: ReactNode
  /** 标题后的来源图标：local = laptop-minimal，cloud = cloud */
  source?: "local" | "cloud"
  /** "hover"：标题浅灰胶囊底（#8 hunt-staff-context-hover 的静态态） */
  forced?: Forced
  /**
   * 悬停卡插槽：标题胶囊 hover 时在下方弹出（Radix HoverCard，side bottom / align start / 偏移 10）。
   * 卡片内容由章节提供（#8 的 SessionHoverCard 归 ch2）。
   */
  hoverCard?: ReactNode
  hoverCardOpen?: boolean
  /** 帧态：悬停卡初始即打开（#8） */
  defaultHoverCardOpen?: boolean
  onHoverCardOpenChange?: (open: boolean) => void
  /** chat-pane：侧栏开关右上角的蓝色方角标（#14 #25 #26 #27 的 "2"，含义待核） */
  badge?: ReactNode
  /** chat-pane：灰色红黄绿；不填时跟随外层 AppWindow */
  inactive?: boolean
  /** main / empty / minimal：右端是否带分屏钮，默认 true（#5 三栏的中栏顶栏没有） */
  showPanelToggle?: boolean
  /** 右端动作，替换默认按钮组 */
  actions?: ReactNode
  /** 标题文字最大宽度（CSS px）。默认 213：#1 #5 #9 三处截断位置（13px/400 SF Pro）都落在 212.5–214.6 之间 */
  titleMaxWidth?: number
  /** 覆盖 source 的图标（#8 #9 是带底座的 Laptop；kit-requests ch2 #1）；默认 local = LaptopMinimal、cloud = Cloud */
  sourceIcon?: IconComponent
  /** 右端动作区，默认 true；false = 不渲染（actions 和默认动作都不出，pi a 的空顶栏） */
  showActions?: boolean
  /** 悬停卡与标题的距离（CSS px），默认 10 */
  hoverCardOffset?: number
}

const PAD: Record<TitleBarVariant, string> = {
  // 标题文字距主区左缘 14（#1 src 326−312）= 外边距 7 + 胶囊内边距 7；… 中心距右缘 47、分屏 21
  main: "pl-[7px] pr-[9px]",
  // #4（s 1.15）：首颗钮心距窗口左缘 19，侧栏开关 98、搜索 125、标题文字 146；… 中心距窗格右缘 24、+ 51
  "chat-pane": "pl-[11px] pr-3",
  empty: "pl-3 pr-[9px]",
  minimal: "pl-3 pr-[9px]",
}

const ACTION_GAP: Record<TitleBarVariant, string> = {
  main: "gap-0.5",
  "chat-pane": "gap-[3px]",
  empty: "gap-0.5",
  minimal: "gap-0.5",
}

function DefaultActions({ variant, showPanelToggle }: { variant: TitleBarVariant; showPanelToggle: boolean }) {
  const more = <GhostIconButton label="More" icon={<Ellipsis />} />
  const panel = showPanelToggle ? <GhostIconButton label="Toggle panel" icon={<PanelRight />} /> : null
  if (variant === "chat-pane") {
    return (
      <>
        <GhostIconButton label="New chat" icon={<Plus />} />
        {more}
      </>
    )
  }
  if (variant === "empty") {
    return (
      <>
        <button
          type="button"
          data-slot="titlebar-ide"
          className="mr-[7px] inline-flex h-6 shrink-0 items-center gap-0.5 rounded-(--cw-radius-button) px-1 text-(length:--cw-text-sm) text-(--cw-text-4) outline-none select-none hover:bg-(--cw-text)/5 hover:text-(--cw-text-3)"
        >
          IDE
          <ArrowUpRight aria-hidden strokeWidth={1.5} className="size-[11px]" />
        </button>
        {more}
        {panel}
      </>
    )
  }
  if (variant === "minimal") return panel
  return (
    <>
      {more}
      {panel}
    </>
  )
}

/**
 * 主区 / 左窗格顶栏。高 --cw-titlebar-h，底色 --cw-titlebar-bg，无底线；内容中线距顶 18px，与侧栏顶行的红黄绿同一条线。
 * 标题 13px/400 --cw-text-2，hover 时出现 --cw-title-pill-bg 浅灰胶囊（高 23、圆角 6，#8）。
 */
export function TitleBar({
  variant = "main",
  title,
  source,
  forced,
  hoverCard,
  hoverCardOpen,
  defaultHoverCardOpen,
  onHoverCardOpenChange,
  badge,
  inactive,
  showPanelToggle = true,
  actions,
  titleMaxWidth = 213,
  sourceIcon,
  showActions = true,
  hoverCardOffset = 10,
  className,
  ...rest
}: TitleBarProps) {
  const SourceIcon = sourceIcon ?? (source === "cloud" ? Cloud : LaptopMinimal)
  const hasTitle = (variant === "main" || variant === "chat-pane") && title != null
  const pill = (
    <span
      data-slot="titlebar-title"
      data-forced={forced}
      className={cn(
        "inline-flex h-[23px] min-w-0 shrink items-center rounded-(--cw-radius-button) pr-1.5 pl-[7px] text-(length:--cw-text-md) leading-(--cw-leading-tight) font-normal whitespace-nowrap text-(--cw-text-2) select-none",
        "hover:bg-(--cw-title-pill-bg) data-[forced=hover]:bg-(--cw-title-pill-bg) data-[state=open]:bg-(--cw-title-pill-bg)",
      )}
    >
      <span className="min-w-0 truncate" style={{ maxWidth: titleMaxWidth }}>
        {title}
      </span>
      {source && (
        <SourceIcon
          aria-label={source === "cloud" ? "Cloud agent" : "Local agent"}
          strokeWidth={1.5}
          className="ml-[9px] size-(--cw-icon-size-sm) shrink-0 text-(--cw-text-3)"
        />
      )}
    </span>
  )
  const titleNode =
    hoverCard != null ? (
      <HoverCard.Root
        open={hoverCardOpen}
        defaultOpen={defaultHoverCardOpen}
        onOpenChange={onHoverCardOpenChange}
        openDelay={300}
        closeDelay={100}
      >
        <HoverCard.Trigger asChild>{pill}</HoverCard.Trigger>
        <HoverCard.Portal>
          <HoverCard.Content
            data-slot="titlebar-hover-card"
            side="bottom"
            align="start"
            sideOffset={hoverCardOffset}
            className="z-50 outline-none"
          >
            {hoverCard}
          </HoverCard.Content>
        </HoverCard.Portal>
      </HoverCard.Root>
    ) : (
      pill
    )
  return (
    <div
      data-slot="titlebar"
      data-variant={variant}
      className={cn(
        "flex h-(--cw-titlebar-h) min-w-0 shrink-0 items-center bg-(--cw-titlebar-bg) pb-0.5",
        PAD[variant],
        className,
      )}
      {...rest}
    >
      {variant === "chat-pane" && (
        <>
          <span className="relative ml-2 inline-flex shrink-0">
            <GhostIconButton label="Toggle sidebar" icon={<PanelLeft />} />
            {badge != null && (
              <span
                data-slot="titlebar-badge"
                className="pointer-events-none absolute -top-[3px] left-[15px] flex h-3 min-w-3 items-center justify-center rounded-[3px] bg-(--cw-blue) px-0.5 text-[9px] leading-none font-semibold text-(--cw-text-on-primary)"
              >
                {badge}
              </span>
            )}
          </span>
          <GhostIconButton label="Search" icon={<Search />} className="ml-[3px]" />
        </>
      )}
      {hasTitle && <div className={cn("flex min-w-0", variant === "chat-pane" && "ml-0.5")}>{titleNode}</div>}
      {showActions && (
        <div className={cn("ml-auto flex shrink-0 items-center", ACTION_GAP[variant])}>
          {actions ?? <DefaultActions variant={variant} showPanelToggle={showPanelToggle} />}
        </div>
      )}
    </div>
  )
}
