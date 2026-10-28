import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react"
import { cn } from "@/lib/utils"
import { SidebarHeader } from "@/components/kit/chrome/SidebarHeader"
import { SidebarGroupHeader, type SidebarGroupHeaderProps } from "./SidebarGroupHeader"

interface SidebarSelection {
  selectedId: string | undefined
  select: (id: string) => void
}

const SidebarSelectionContext = createContext<SidebarSelection | null>(null)

/**
 * 行的选中态：显式 selected 优先；否则看外层 Sidebar 的 selectedId 是否等于 rowId。
 * 点击行时调 select()，把 Sidebar 的选中移过去（主区内容不随之切换）。
 */
export function useSidebarSelection(rowId?: string, selected?: boolean) {
  const ctx = useContext(SidebarSelectionContext)
  const isSelected = selected ?? (rowId != null && ctx?.selectedId === rowId)
  const select = useCallback(() => {
    if (rowId != null) ctx?.select(rowId)
  }, [ctx, rowId])
  return { isSelected, select }
}

export interface SidebarProps extends ComponentProps<"aside"> {
  /**
   * agents：New Agent / Marketplace → 仓库分组 → More → Open Workspace（#1 #3 #5 #6 #7 #9 #11 #12 #15 #21 #28 #29）；
   * projects：New Chat / Search / Automations / Customize → Projects 分区 → Chats 分区（#2 #23 #24）。
   * 只影响默认顶行；列表内容由 children 组合。
   */
  variant?: "agents" | "projects"
  /** 顶行；不填 = SidebarHeader（agents → agents 形态，projects → empty 形态）；传 null 去掉 */
  header?: ReactNode
  /** 贴底的账户行（AccountFooter），不随列表滚动 */
  footer?: ReactNode
  /** 受控选中行（AgentRow / SidebarNavRow 的 rowId） */
  selectedId?: string
  /** 初始选中行（帧态）；之后点击行会移动选中 */
  defaultSelectedId?: string
  onSelectedIdChange?: (id: string) => void
  /** 列表区额外 class */
  bodyClassName?: string
}

/**
 * 左列表外壳：宽 --cw-sidebar-w（含右缘 1px --cw-divider），底 --cw-sidebar-bg；
 * 列表区左右内边距 10 / 8（行框 253 宽，#1），超出时整体滚动、滚动条隐藏；底部账户行距底 10。
 * 紧跟导航行的第一个仓库组多 3px 上间距（#1 #3 #21：Marketplace → 组头 40，其余组 37）。
 */
export function Sidebar({
  variant = "agents",
  header,
  footer,
  selectedId,
  defaultSelectedId,
  onSelectedIdChange,
  bodyClassName,
  className,
  children,
  ...rest
}: SidebarProps) {
  const [inner, setInner] = useState(defaultSelectedId)
  const current = selectedId !== undefined ? selectedId : inner
  const select = useCallback(
    (id: string) => {
      if (selectedId === undefined) setInner(id)
      onSelectedIdChange?.(id)
    },
    [selectedId, onSelectedIdChange],
  )
  const ctx = useMemo(() => ({ selectedId: current, select }), [current, select])
  const head =
    header === undefined ? <SidebarHeader variant={variant === "projects" ? "empty" : "agents"} /> : header
  return (
    <SidebarSelectionContext value={ctx}>
      <aside
        data-slot="sidebar"
        data-variant={variant}
        className={cn(
          "flex h-full min-h-0 w-(--cw-sidebar-w) shrink-0 flex-col border-r border-(--cw-divider) bg-(--cw-sidebar-bg) text-(--cw-text)",
          className,
        )}
        {...rest}
      >
        {head}
        <div
          data-slot="sidebar-body"
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-y-auto pr-2 pl-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            "[&>[data-slot=sidebar-nav-row]+[data-slot=sidebar-group][data-variant=repo]]:mt-[3px]",
            bodyClassName,
          )}
        >
          {children}
        </div>
        {footer != null && (
          <div data-slot="sidebar-footer" className="shrink-0 pr-2 pb-2.5 pl-2.5">
            {footer}
          </div>
        )}
      </aside>
    </SidebarSelectionContext>
  )
}

export interface SidebarGroupProps extends Omit<ComponentProps<"div">, "title"> {
  /** 组头文字（仓库名 / 分区名）；可省（#23 #24 的 Chats 分区头只有右侧图标） */
  label?: ReactNode
  /** 组头形态，见 SidebarGroupHeader */
  variant?: SidebarGroupHeaderProps["variant"]
  icon?: SidebarGroupHeaderProps["icon"]
  /** 组头右端动作（section 的 + / 筛选 / 新建文件夹）；repo 默认是 hover 才出现的 "+" */
  actions?: ReactNode
  /** 静态「组 hover」：组头显示 "+"（#1 #3 #21 指针停在本组的行上） */
  forcedHover?: boolean
  /** 组头自身的强制态："hover" = 名后 ∨ + 右端 +（#7 指针停在组头上） */
  headerForced?: SidebarGroupHeaderProps["forced"]
  onAdd?: () => void
  /** 原样传给 SidebarGroupHeader 的 className（组头高度等；kit-requests pi a） */
  headerClassName?: string
}

/**
 * 一个仓库组 / 分区：组头 + 行。指针进入组（组头或任一行）时组头右端出现 "+"；
 * 组内行处于 hover（含 forced="hover"）时同样出现。
 */
export function SidebarGroup({
  label,
  variant = "repo",
  icon,
  actions,
  forcedHover,
  headerForced,
  onAdd,
  headerClassName,
  className,
  children,
  ...rest
}: SidebarGroupProps) {
  return (
    <div
      role="group"
      data-slot="sidebar-group"
      data-variant={variant}
      data-forced-hover={forcedHover ? "" : undefined}
      className={cn("group/sg flex shrink-0 flex-col", className)}
      {...rest}
    >
      <SidebarGroupHeader
        label={label}
        variant={variant}
        icon={icon}
        actions={actions}
        forced={headerForced}
        onAdd={onAdd}
        className={headerClassName}
      />
      {children}
    </div>
  )
}
