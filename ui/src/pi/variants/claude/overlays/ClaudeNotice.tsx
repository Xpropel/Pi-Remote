import type { PiContainerProps } from "@/pi/containers/types"
import { ClaudeIconButton } from "../primitives/ClaudePrimitives"
import { X } from "lucide-react"

/**
 * 通知卡（§1.8 / C-12 状态语言）：纸面细环卡（S2 + 双环），标题/正文/动作；右上 × 关闭，提示「后面还排着 N 条」。
 * 数据：relay.notices（noticeCore 归约后的可见卡）+ dismiss/runAction。
 */
export function ClaudeNotice({ p }: { p: PiContainerProps }) {
  const { relay } = p
  const item = relay.notices?.[0]
  if (!item) return null
  const level = item.level === "error" ? "error" : item.level === "warning" ? "warn" : "info"
  return (
    <div className="claude-notice" data-level={level} role={level === "error" ? "alert" : "status"}>
      <div className="claude-notice-body">
        <p className="claude-notice-title">
          {item.title}
          {item.count > 1 ? <span className="claude-notice-count">×{item.count}</span> : null}
        </p>
        {item.body ? <p className="claude-notice-text">{item.body}</p> : null}
        {item.actions.length > 0 ? (
          <div className="claude-notice-actions">
            {item.actions.map((action) => (
              <button
                key={action.id}
                type="button"
                className={action.kind === "primary" ? "claude-btn claude-btn-primary claude-btn-sm" : "claude-btn claude-btn-outline claude-btn-sm"}
                onClick={() => relay.runNoticeAction(item, action)}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {relay.noticeQueue > 0 ? <span className="claude-notice-queue">+{relay.noticeQueue}</span> : null}
      <ClaudeIconButton label="关闭通知" icon={<X size={13} strokeWidth={2} />} className="claude-iconbtn claude-notice-close" onClick={() => relay.dismissNotice(item.id)} />
    </div>
  )
}
