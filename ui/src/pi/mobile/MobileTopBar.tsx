import type { ReactNode } from "react"
import { IconBack, IconSearch, IconSettings, IconSidebar } from "./icons"

export type MobileTopBarVariant = "home" | "chat" | "page"

/**
 * P11-MOB-01 顶栏（两模式共用，54px）：列表首页 = Pi-Remote + 搜索/设置；
 * 抽屉式会话页 = 侧栏钮 + 会话标题；推入页/对话页 = 返回 + 标题。
 */
export function MobileTopBar({
  variant = "home",
  title,
  subtitle,
  onOpenDrawer,
  onBack,
  onSearch,
  onOpenSettings,
  actions,
}: {
  variant?: MobileTopBarVariant
  title?: ReactNode
  subtitle?: string
  onOpenDrawer?: () => void
  onBack?: () => void
  onSearch?: () => void
  onOpenSettings?: () => void
  actions?: ReactNode
}) {
  return (
    <header className="pm-topbar" data-pi-mobile-surface="P11-MOB-01" data-variant={variant}>
      {variant === "home" ? (
        <span className="pm-topbar-title">Pi-Remote</span>
      ) : (
        <>
          {onBack ? (
            <button type="button" className="pm-icon-btn" aria-label="返回" onClick={onBack}>
              <IconBack size={20} />
            </button>
          ) : onOpenDrawer ? (
            <button type="button" className="pm-icon-btn" aria-label="打开侧栏" onClick={onOpenDrawer}>
              <IconSidebar size={20} />
            </button>
          ) : (
            <span className="pm-topbar-backspace" aria-hidden />
          )}
          <span className="pm-topbar-heading">
            <span className="pm-topbar-title pm-topbar-title-chat">{title}</span>
            {subtitle ? <span className="pm-topbar-sub">{subtitle}</span> : null}
          </span>
        </>
      )}
      <span className="pm-topbar-actions">
        {actions}
        {onSearch ? (
          <button type="button" className="pm-icon-btn" aria-label="搜索" onClick={onSearch}>
            <IconSearch size={20} />
          </button>
        ) : null}
        {onOpenSettings ? (
          <button type="button" className="pm-icon-btn" aria-label="设置" onClick={onOpenSettings}>
            <IconSettings size={20} />
          </button>
        ) : null}
      </span>
    </header>
  )
}
