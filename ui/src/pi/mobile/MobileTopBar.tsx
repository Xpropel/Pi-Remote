import type { ReactNode } from "react"
import { IconBack, IconSearch, IconSettings, IconSidebar } from "./icons"

export type MobileTopBarVariant = "home" | "chat" | "page"

/**
 * P11-MOB-01 顶栏（两模式共用，54px）：列表首页 = Pi-Remote + 搜索/设置；
 * 抽屉式会话页 = 侧栏钮 + 会话标题；推入页/对话页 = 返回 + 标题。
 * attentionCount 挂在左侧按钮上（其他会话等你处理的条数，同旧版手机顶栏的「‹ 3」）。
 * 会话页挂 data-pi-topbar="phone-chat"（同 PiTopBar 的标记）：输入框浮层按它的底边算可用高度。
 */
export function MobileTopBar({
  variant = "home",
  title,
  subtitle,
  attentionCount = 0,
  onTitleClick,
  onOpenDrawer,
  onBack,
  onSearch,
  onOpenSettings,
  actions,
}: {
  variant?: MobileTopBarVariant
  title?: ReactNode
  subtitle?: string
  attentionCount?: number
  /** 点标题（会话页：会话信息）；不给时标题只是文字 */
  onTitleClick?: () => void
  onOpenDrawer?: () => void
  onBack?: () => void
  onSearch?: () => void
  onOpenSettings?: () => void
  actions?: ReactNode
}) {
  const count = attentionCount > 0 ? attentionCount : 0
  const countBadge = count ? (
    <span className="pm-topbar-count" aria-hidden>
      {count}
    </span>
  ) : null
  const heading = (
    <>
      <span className={variant === "chat" ? "pm-topbar-title pm-topbar-title-chat" : "pm-topbar-title"}>{title}</span>
      {subtitle ? <span className="pm-topbar-sub">{subtitle}</span> : null}
    </>
  )
  return (
    <header
      className="pm-topbar"
      data-pi-mobile-surface="P11-MOB-01"
      data-variant={variant}
      data-pi-topbar={variant === "chat" ? "phone-chat" : variant === "page" ? "phone-page" : undefined}
    >
      {variant === "home" ? (
        <span className="pm-topbar-title">Pi-Remote</span>
      ) : (
        <>
          {onBack ? (
            <button
              type="button"
              className={count ? "pm-icon-btn pm-icon-btn-count" : "pm-icon-btn"}
              aria-label={count ? `返回，${count} 个会话需要处理` : "返回"}
              onClick={onBack}
            >
              <IconBack size={20} />
              {countBadge}
            </button>
          ) : onOpenDrawer ? (
            <button
              type="button"
              className={count ? "pm-icon-btn pm-icon-btn-count" : "pm-icon-btn"}
              aria-label={count ? `打开侧栏，${count} 个会话需要处理` : "打开侧栏"}
              onClick={onOpenDrawer}
            >
              <IconSidebar size={20} />
              {countBadge}
            </button>
          ) : (
            <span className="pm-topbar-backspace" aria-hidden />
          )}
          {onTitleClick ? (
            <button type="button" className="pm-topbar-heading pm-topbar-heading-btn" onClick={onTitleClick}>
              {heading}
            </button>
          ) : (
            <span className="pm-topbar-heading">{heading}</span>
          )}
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
