import { PiStatusLine } from "@/components/pi/shared"
import { useNow } from "@/pi/hooks/useNow"
import { pageLinkView } from "@/relay/presence"
import { useLinkState } from "@/shell/useLinkState"
import type { PiContainerProps } from "./types"

/**
 * 连接状态行（plan §7.1 reconnecting，a 线）：status / retryAt / retryCount / everConnected / reconnectNow；
 * pageLinkView（presence.ts，倒计时按 useNow 的 now 算；浏览器报断网按"重连中"）+ useLinkState（shell/useLinkState.ts：断开满 30 秒降级为"已断开"、恢复后的"已重新连接"）。
 * - 连接正常时什么都不画；刚恢复时"已重新连接"，到时淡出（leaving）。
 * - 首次连接（还没连上过、也没在等重试）不出这一行：主区是 BootContainer 的 Spinner。第一次就连不上时是"连不上服务器，N 秒后重试"。
 * - PiStatusLine 是 role="status"，倒计时秒数不播报（部件里只在进入新状态时更新播报文字）；同一状态只出现在这一处（U-19）。
 * composer 的占位和原因不归这里：ComposerContainer 用 composerReasonOf 统一算（D14）。
 */
export function LinkStatusContainer(props: PiContainerProps) {
  const { relay } = props
  const now = useNow(1000)
  const info = useLinkState(relay)
  // 和账户区、输入框同一口径：浏览器报断网就按"重连中"（L16）
  const link = pageLinkView(relay, now)
  const attempt = relay.retryCount > 0 ? relay.retryCount : undefined
  if (link.kind === "ok") {
    return info.banner === "recovered" ? <PiStatusLine state="restored" leaving={info.closing} /> : null
  }
  if (link.kind === "first") return null
  // 连上过、断开已满 30 秒：降级为"已断开"（useLinkState 的 offline 也包括从没连上过，那种情况仍按倒计时写）
  if (relay.everConnected && info.state === "offline") {
    return <PiStatusLine state="offline" attempt={attempt} onReconnect={relay.reconnectNow} />
  }
  if (link.kind === "waiting") {
    return <PiStatusLine state="waiting" seconds={link.seconds} first={link.first} attempt={attempt} onReconnect={relay.reconnectNow} />
  }
  return <PiStatusLine state="reconnecting" attempt={attempt} />
}
