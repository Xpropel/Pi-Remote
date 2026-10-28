import { Ellipsis } from "../icons/CodexIcons"
import type { VariantAppProps } from "@/pi/variants/types"
import { CodexPhoneBar } from "../chrome/CodexTitleBar"
import { CodexThread } from "../thread/CodexThread"
import { CodexStatusLine } from "../overlays/CodexStatusLine"
import { CodexNoticeStack } from "../overlays/CodexNotice"
import { CodexPhoneComposer } from "./CodexPhoneComposer"
import { roomDevice, roomTitle } from "../logic/view"

/** 手机对话页（§2.5 / X-04）：46 顶栏（‹ + 标题 + ⋯）+ 14/22 正文 + 25 圆角 composer + 安全区 */
export function CodexPhoneChat({
  p,
  onBack,
  onSessionMenu,
  chrome = true,
}: {
  p: VariantAppProps
  onBack?: () => void
  onSessionMenu: (at: { x: number; y: number }) => void
  /** false：顶栏由外层移动壳（MobileNavShell）提供 */
  chrome?: boolean
}) {
  const { relay } = p
  return (
    <div className="cx-phone-page" data-pi-ui-part="page" data-p4-surface="CX-PHONE-CHAT" data-p4-ready="">
      {chrome ? <CodexPhoneBar
        title={roomTitle(relay)}
        subtitle={roomDevice(relay) ?? undefined}
        onBack={onBack ?? (() => undefined)}
        actions={
          <button
            type="button"
            className="cx-icon-btn"
            aria-label="会话菜单"
            onClick={() => relay.roomId && onSessionMenu({ x: Math.max(12, (globalThis.innerWidth ?? 390) - 260), y: 54 })}
          >
            <Ellipsis aria-hidden size={17} strokeWidth={1.5} />
          </button>
        }
      /> : null}
      <CodexStatusLine p={p} />
      <CodexNoticeStack p={p} />
      <div className="cx-phone-chat">
        <CodexThread p={p} phone />
      </div>
      <CodexPhoneComposer p={p} />
      {!p.ui.pane && !relay.roomId ? <p className="cx-phone-hint">选一个会话开始</p> : null}
    </div>
  )
}
