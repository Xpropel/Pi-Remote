import { useState, type ComponentProps, type ReactNode } from "react"
import type { Forced } from "@/components/kit/types"
import { cn } from "@/lib/utils"
import { KitIcon, type IconComponent } from "@/components/kit/icons"
import { KbdHint } from "@/components/kit/controls/KbdHint"
import { useSidebarSelection } from "./Sidebar"
import { ROW_BOX, ROW_HOVER, ROW_LEAD, ROW_SELECTED, ROW_TEXT } from "./styles"

export interface SidebarNavRowProps extends ComponentProps<"button"> {
  /** 16px 线条图标：AgentPlaneIcon（New Agent / New Chat）、Blocks、Search、Bot、CircleDashed、Folder、Ellipsis、FolderPlus… */
  icon?: IconComponent
  /** 图标额外 class（Projects 形态的彩色项目图标） */
  iconClassName?: string
  label: ReactNode
  /** 行尾快捷键（"⌘N"），11px --cw-text-4，右对齐到距行框右缘 11 */
  kbd?: string
  /** 参与 Sidebar 选中（与 Sidebar selectedId / defaultSelectedId 对应） */
  rowId?: string
  /** 显式选中（不填时看 Sidebar 的选中） */
  selected?: boolean
  /** 弱化行：More / Open Workspace / New Project，文字与图标 --cw-text-3 */
  muted?: boolean
  /** 静态悬停 / 聚焦态 */
  forced?: Forced
}

/**
 * 侧栏导航行（New Agent、Marketplace、New Chat、Search、Automations、Customize、New Project、文件夹行、More、Open Workspace）。
 * 文字 13px/400，导航色 --cw-sidebar-nav-fg（缺省回落 --cw-text-2；#1 实测比会话行深一级）；
 * 选中 = --cw-row-selected 底 + --cw-text（#2 New Chat、#23 Secret new app、#29 Marketplace）。
 */
export function SidebarNavRow({
  icon,
  iconClassName,
  label,
  kbd,
  rowId,
  selected,
  muted,
  forced,
  className,
  onClick,
  onPointerEnter,
  onPointerLeave,
  type = "button",
  ...rest
}: SidebarNavRowProps) {
  const { isSelected, select } = useSidebarSelection(rowId, selected)
  const [hovered, setHovered] = useState(false)
  const hover = hovered || forced === "hover" || forced === "focus"
  return (
    <button
      type={type}
      data-slot="sidebar-nav-row"
      data-selected={isSelected ? "" : undefined}
      data-hover={hover ? "" : undefined}
      data-forced={forced}
      data-muted={muted ? "" : undefined}
      aria-current={isSelected ? "page" : undefined}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) select()
      }}
      onPointerEnter={(event) => {
        onPointerEnter?.(event)
        setHovered(true)
      }}
      onPointerLeave={(event) => {
        onPointerLeave?.(event)
        setHovered(false)
      }}
      className={cn(
        ROW_BOX,
        "pr-[11px]",
        muted ? "text-(--cw-text-3)" : "text-[color:var(--cw-sidebar-nav-fg,var(--cw-text-2))]",
        ROW_SELECTED,
        ROW_HOVER,
        muted && "data-[hover]:text-(--cw-text-2)",
        className,
      )}
      {...rest}
    >
      <span className={ROW_LEAD}>
        {icon && (
          <KitIcon
            icon={icon}
            className={cn(muted ? "text-(--cw-text-3)" : "text-(--cw-text-2)", iconClassName)}
          />
        )}
      </span>
      <span className={cn(ROW_TEXT, "text-ellipsis")}>{label}</span>
      {kbd && <KbdHint keys={kbd} size="xs" className="ml-2" />}
    </button>
  )
}
