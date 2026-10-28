import { useState, type ComponentProps, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { ICON, KitIcon, PanelRight, Plus, type IconComponent } from "@/components/kit/icons"
import { DiffStat } from "@/components/kit/controls/DiffStat"
import { GhostIconButton } from "@/components/kit/controls/GhostIconButton"

export interface PaneTab {
  id: string
  /** 页签图标（14px）：GitBranch / Monitor / Globe / SquareTerminal / File / Atom … */
  icon?: IconComponent
  /** 任意图标节点（例如 FileTypeIcon），给了就代替 icon 渲染（kit-requests pi a/b） */
  iconNode?: ReactNode
  /** 页签文字（"Cursor · Agent"、文件名…）；不给就是 24×24 的纯图标页签 */
  label?: ReactNode
  /** 带统计的 diff 页签（#5 "+48 -9"、#12 "+2392 -1"） */
  stat?: { added?: number | string; removed?: number | string }
  /** 文字之后的附加内容：浅灰端口号 " :4001"、未保存圆点 "•" 等 */
  suffix?: ReactNode
  /** 文字最大宽度（CSS px），超出用 … 截断（#25 "CloudAgentPreferredName…"） */
  labelMaxWidth?: number
  /** 原生 title / 无障碍名（纯图标页签建议给） */
  title?: string
  /** 写到页签按钮的 data-cw-id，给交互步骤用 */
  cwId?: string
}

export interface PaneTabBarProps extends ComponentProps<"div"> {
  tabs: PaneTab[]
  /** 受控选中页签 */
  selectedId?: string | null
  /** 初始选中页签（帧态） */
  defaultSelectedId?: string | null
  onSelectedIdChange?: (id: string) => void
  /** 页签之前的内容（#28 浏览器 pane 最左的侧栏开关） */
  leading?: ReactNode
  /** 紧跟页签之后、不属于页签的内容（#28 页签后的浅色小图标） */
  afterTabs?: ReactNode
  /** 右端动作，替换默认的 + 与分屏 */
  actions?: ReactNode
  /** 默认动作里是否带分屏钮，默认 true */
  showPanelToggle?: boolean
  /** 默认动作里是否带 "New tab +"，默认 true（pi a：当分段切换用时关掉）；两个都关时右端不渲染默认动作 */
  showNewTab?: boolean
  /** 加在每个页签按钮上的 class（字号、内距按帧调；kit-requests ch5 #1） */
  tabClassName?: string
}

/**
 * 右 pane 顶部页签条：高 --cw-titlebar-h，底 --cw-titlebar-bg，下边 1px --cw-divider；内容中线距顶 18（与窗口红黄绿同线）。
 * 页签高 24、圆角 6；选中 = --cw-chip-bg 浅灰底 + --cw-text 字；文字 12px --cw-text-2，图标 14px --cw-icon-fg。
 * 右端默认 "+" 与分屏（中心距右缘 47 / 21，#5）。点击页签切换选中（只切高亮，内容由屏幕决定）。
 */
export function PaneTabBar({
  tabs,
  selectedId,
  defaultSelectedId = null,
  onSelectedIdChange,
  leading,
  afterTabs,
  actions,
  showPanelToggle = true,
  showNewTab = true,
  tabClassName,
  className,
  ...rest
}: PaneTabBarProps) {
  const [inner, setInner] = useState<string | null>(defaultSelectedId)
  const current = selectedId !== undefined ? selectedId : inner
  const select = (id: string) => {
    if (selectedId === undefined) setInner(id)
    onSelectedIdChange?.(id)
  }
  return (
    <div
      data-slot="pane-tab-bar"
      className={cn(
        "flex h-(--cw-titlebar-h) min-w-0 shrink-0 items-center gap-1 border-b border-(--cw-divider) bg-(--cw-titlebar-bg) pr-[9px] pb-px pl-1",
        className,
      )}
      {...rest}
    >
      {leading}
      <div role="tablist" className="flex min-w-0 items-center gap-1">
        {tabs.map((tab) => {
          const selected = tab.id === current
          const iconOnly = tab.label == null && tab.stat == null && tab.suffix == null
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-label={iconOnly ? tab.title : undefined}
              title={tab.title}
              data-slot="pane-tab"
              data-selected={selected ? "" : undefined}
              data-cw-id={tab.cwId}
              onClick={() => select(tab.id)}
              className={cn(
                "inline-flex h-6 min-w-0 shrink-0 items-center gap-1.5 rounded-(--cw-radius-button) text-(length:--cw-text-sm) leading-(--cw-leading-sm) whitespace-nowrap text-(--cw-text-2) outline-none select-none",
                iconOnly ? "w-6 justify-center" : "px-2",
                "hover:not-data-[selected]:bg-(--cw-text)/5 data-[selected]:bg-(--cw-chip-bg) data-[selected]:text-(--cw-text)",
                tabClassName,
              )}
            >
              {tab.iconNode != null ? (
                <span data-slot="pane-tab-icon" className="inline-flex shrink-0 items-center">
                  {tab.iconNode}
                </span>
              ) : tab.icon && (
                <KitIcon
                  icon={tab.icon}
                  size={ICON.sizeSm}
                  className={selected ? "text-(--cw-text-2)" : "text-(--cw-icon-fg)"}
                />
              )}
              {tab.label != null && (
                <span className="min-w-0 truncate" style={{ maxWidth: tab.labelMaxWidth }}>
                  {tab.label}
                </span>
              )}
              {tab.stat && <DiffStat added={tab.stat.added} removed={tab.stat.removed} />}
              {tab.suffix}
            </button>
          )
        })}
      </div>
      {afterTabs}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {actions ?? (
          <>
            {showNewTab && <GhostIconButton label="New tab" icon={<Plus />} />}
            {showPanelToggle && <GhostIconButton label="Toggle panel" icon={<PanelRight />} />}
          </>
        )}
      </div>
    </div>
  )
}
