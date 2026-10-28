import type { ComponentProps, ReactNode } from "react"
import type { Forced } from "@/components/kit/types"
import { cn } from "@/lib/utils"
import { ChevronDown, FolderOpen, KitIcon, Plus, type IconComponent } from "@/components/kit/icons"
import { GhostIconButton } from "@/components/kit/controls/GhostIconButton"

export interface SidebarGroupHeaderProps extends Omit<ComponentProps<"div">, "title"> {
  /** 仓库名（anysphere/everysphere）或分区名（Projects / Chats）；可省（#23 #24 的 Chats 分区头只有右侧图标，kit-requests ch5 #11） */
  label?: ReactNode
  /**
   * repo：12px 灰字，右端 "+" 只在组 hover 时出现（#1 #3 #5 #7 #9 …）；
   * folder：行首文件夹图标 + 13px 深灰字（#6 渲染样机）；
   * section：Projects / Chats 分区头，右端动作常显，上间距更大（#2 #23 #24）。
   */
  variant?: "repo" | "folder" | "section"
  /** folder 变体的图标，默认 FolderOpen */
  icon?: IconComponent
  /** 右端动作。repo 默认 "+"；section 默认 "+"（Chats 传筛选 + 新建文件夹） */
  actions?: ReactNode
  /**
   * 静态态："group-hover" = 只显示右端 "+"（指针在本组行上，#1 #3 #21）；
   * "hover" = 名后 ∨ + 右端 "+"（指针在组头上，#7）。
   */
  forced?: Forced | "group-hover"
  onAdd?: () => void
}

/** "+" 的显隐：组 hover / 组内有 hover 行 / 组强制 hover / 组头 hover / 组头强制态 */
const REVEAL =
  "opacity-0 group-hover/sg:opacity-100 group-has-[[data-hover]]/sg:opacity-100 group-data-[forced-hover]/sg:opacity-100 group-hover/sgh:opacity-100 group-data-[forced]/sgh:opacity-100 focus-visible:opacity-100"

/**
 * 侧栏组头。repo / section：文字 12px/400 --cw-text-3，起点比行标题左移 25（与行图标列左缘对齐，#1 x 49）；
 * 组头本身无底色、无图标。几何：repo 块高 39（文字线距块顶 13），section 块高 45（#2：上一行 → 分区头 44–45）。
 */
export function SidebarGroupHeader({
  label,
  variant = "repo",
  icon,
  actions,
  forced,
  onAdd,
  className,
  ...rest
}: SidebarGroupHeaderProps) {
  const folder = variant === "folder"
  const section = variant === "section"
  const add = <GhostIconButton size="sm" label="New agent in group" icon={<Plus />} onClick={onAdd} />
  return (
    <div
      data-slot="sidebar-group-header"
      data-variant={variant}
      data-forced={forced}
      className={cn(
        "group/sgh relative flex w-full min-w-0 shrink-0 items-center select-none",
        section ? "h-[45px] pt-5 pb-[9px]" : "h-[39px] pt-[13px] pb-2.5",
        folder ? "pl-[5px]" : "pl-1.5",
        "pr-1.5",
        className,
      )}
      {...rest}
    >
      {folder && <KitIcon icon={icon ?? FolderOpen} className="text-(--cw-text-2)" />}
      <span
        className={cn(
          "min-w-0 truncate",
          folder
            ? "ml-2.5 text-(length:--cw-text-md) leading-(--cw-leading-tight) text-(--cw-text-2)"
            : "text-(length:--cw-text-sm) leading-(--cw-leading-sm) text-(--cw-text-3)",
        )}
      >
        {label}
      </span>
      {variant === "repo" && (
        <ChevronDown
          aria-hidden
          strokeWidth={1.5}
          className="ml-1 hidden size-3 shrink-0 text-(--cw-text-3) group-hover/sgh:block group-data-[forced=hover]/sgh:block"
        />
      )}
      <span
        data-slot="sidebar-group-actions"
        className={cn("ml-auto flex shrink-0 items-center gap-[5px] pl-2", !section && REVEAL)}
      >
        {actions ?? add}
      </span>
    </div>
  )
}
