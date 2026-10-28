import type { VariantAppProps } from "@/pi/variants/types"

/** 通知卡（[X-§8] / 推导：12 圆角、S2 底、状态句；error=role alert）；不 import NoticeContainer */
export function CodexNoticeStack({ p }: { p: VariantAppProps }) {
  const { relay } = p
  if (relay.notices.length === 0) return null
  return (
    <div className="cx-notice-slot" role="region" aria-label="通知" data-pi-ui-part="notice">
      {relay.notices.map((notice) => (
        <div className="cx-notice" key={notice.id} data-level={notice.level} role={notice.level === "error" ? "alert" : "status"}>
          <div className="cx-notice-main">
            <span className="cx-notice-title">
              {notice.title}
              {notice.count > 1 ? <span className="cx-notice-count">×{notice.count}</span> : null}
            </span>
            {notice.body ? <span className="cx-notice-body">{notice.body}</span> : null}
          </div>
          {notice.actions.length > 0 ? (
            <div className="cx-notice-actions">
              {notice.actions.map((action) => (
                <button key={action.id} type="button" className="cx-notice-action" onClick={() => relay.runNoticeAction(notice, action)}>
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
          <button type="button" className="cx-icon-btn cx-notice-close" aria-label="关闭通知" onClick={() => relay.dismissNotice(notice.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
