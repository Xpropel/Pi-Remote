import type { PiContainerProps } from "@/pi/containers/types"
import { useNow } from "../primitives/useClaude"
import { useClaudeLinkLine } from "../model/view"

/**
 * 连接状态行（§1.7 状态语言）：连接正常时不画；断开 / 重连 / 首次连接时给一行细条（S0 底 + 下边线）与重试入口。
 * 纯数据来自 @/relay/presence 的 pageLinkView（经 model/view 的 useClaudeLinkLine）。
 */
export function ClaudeStatusLine({ p }: { p: PiContainerProps }) {
  const now = useNow(1000)
  const line = useClaudeLinkLine(p, now)
  if (!line) return null
  return (
    <div className="claude-statusline" data-kind={line.kind} role="status">
      <span aria-hidden className="claude-dot" data-dot={line.kind === "offline" ? "offline" : "waiting"} />
      <span className="claude-statusline-text">{line.text}</span>
      <button type="button" className="claude-link-btn" onClick={p.relay.reconnectNow}>
        立即重试
      </button>
    </div>
  )
}
