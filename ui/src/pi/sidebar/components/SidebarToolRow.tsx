import type { ReactNode } from "react"
import { BackIcon, ForwardIcon, PanelIcon, SearchIcon } from "./icons"

/** P11-SIDE-01 工具行（44px，与主区顶栏同高同中线）：折叠/搜索 +（slots）→ 右锚后退/前进（宿主给了才画）；无红绿灯。 */
export function SidebarToolRow({
  collapsed,
  collapseShortcut,
  onCollapse,
  onSearch,
  onBack,
  onForward,
  endSlot,
}: {
  collapsed: boolean
  /** 折叠快捷键的显示串（如 ⌘B），只进提示 */
  collapseShortcut?: string
  onCollapse?: () => void
  onSearch?: () => void
  onBack?: () => void
  onForward?: () => void
  endSlot?: ReactNode
}) {
  const collapseLabel = collapsed ? "展开侧栏" : "折叠侧栏"
  return (
    <div className="sb-toolrow" data-p11-surface="P11-SIDE-01">
      <button
        type="button"
        className="sb-iconbtn sb-iconbtn-weak"
        data-sb-collapse=""
        aria-label={collapseLabel}
        title={collapseShortcut ? `${collapseLabel}（${collapseShortcut}）` : collapseLabel}
        onClick={onCollapse}
      >
        <PanelIcon size={16} />
      </button>
      {collapsed ? null : (
        <button type="button" className="sb-iconbtn sb-iconbtn-weak" aria-label="搜索会话" title="搜索会话" onClick={onSearch}>
          <SearchIcon size={16} />
        </button>
      )}
      <span className="sb-toolrow-spacer" />
      {endSlot}
      {collapsed || !onBack ? null : (
        <button type="button" className="sb-iconbtn sb-iconbtn-weak" aria-label="返回" title="返回" onClick={onBack}>
          <BackIcon size={16} />
        </button>
      )}
      {collapsed || !onForward ? null : (
        <button type="button" className="sb-iconbtn sb-iconbtn-weak" aria-label="前进" title="前进" onClick={onForward}>
          <ForwardIcon size={16} />
        </button>
      )}
    </div>
  )
}
