import type { ReactNode } from "react"
import { BackIcon, ForwardIcon, PanelIcon, SearchIcon } from "./icons"

/** P11-SIDE-01 工具行（34px）：折叠/搜索 +（slots）→ 右锚前进/后退；无红绿灯。 */
export function SidebarToolRow({
  collapsed,
  onCollapse,
  onSearch,
  onBack,
  onForward,
  endSlot,
}: {
  collapsed: boolean
  onCollapse?: () => void
  onSearch?: () => void
  onBack?: () => void
  onForward?: () => void
  endSlot?: ReactNode
}) {
  return (
    <div className="sb-toolrow" data-p11-surface="P11-SIDE-01">
      <button type="button" className="sb-iconbtn sb-iconbtn-weak" aria-label={collapsed ? "展开侧栏" : "折叠侧栏"} onClick={onCollapse}>
        <PanelIcon size={15} />
      </button>
      {collapsed ? null : (
        <button type="button" className="sb-iconbtn sb-iconbtn-weak" aria-label="搜索会话" onClick={onSearch}>
          <SearchIcon size={15} />
        </button>
      )}
      <span className="sb-toolrow-spacer" />
      {endSlot}
      {collapsed ? null : (
        <>
          <button type="button" className="sb-iconbtn sb-iconbtn-weak" aria-label="后退" onClick={onBack}>
            <BackIcon size={15} />
          </button>
          <button type="button" className="sb-iconbtn sb-iconbtn-weak" aria-label="前进" onClick={onForward}>
            <ForwardIcon size={15} />
          </button>
        </>
      )}
    </div>
  )
}
