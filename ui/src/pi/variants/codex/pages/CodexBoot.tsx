import { useMemo } from "react"
import type { VariantAppProps } from "@/pi/variants/types"
import { bootInputOf, bootViewOf, connectingText, relayHostOf } from "@/pi/model/boot"
import { sidebarSessionsOf } from "@/pi/model/sidebarSource"
import { CodexMark } from "../primitives/primitives"

/** Codex 启动 / 空状态（[X-图13③] / X-12-3）：一句人话状态句 + shimmer 扫光条（≥120px），无转圈叙事 */
export function CodexBoot({ p, onPair }: { p: VariantAppProps; onPair: () => void }) {
  const { relay, layout } = p
  const phone = layout === "phone"
  // 与产品 no-devices 口径一致：服务端没有 device.token 就不摆配对按钮（点开也只会提示不支持）。
  const canPair = !!relay.canManageDevices
  const sessionCount = useMemo(() => sidebarSessionsOf(relay.devices, relay.rooms, relay.sessionsByDevice).length, [relay.devices, relay.rooms, relay.sessionsByDevice])
  const view = bootViewOf(bootInputOf(relay, sessionCount))
  if (view.kind === "ready") return null
  const host = relayHostOf(import.meta.env.VITE_RELAY_URL, location)
  const title = view.kind === "connecting" ? connectingText(host) : view.kind === "no-devices" ? "还没有配对设备" : `${view.count} 台设备都未连接`
  const body =
    view.kind === "connecting"
      ? "建立连接后这里会出现会话列表。"
      : "在电脑上运行 deploy/attach.sh（Windows：deploy\\attach.cmd）打开连接窗口，会话会出现在这里。"
  return (
    <div className="cx-boot" data-p4-surface="CX-PAGE-12" data-p4-ready="" data-variant={phone ? "phone" : "desktop"} data-pi-ui-part="page">
      <div className="cx-boot-inner">
        {view.kind !== "connecting" ? (
          <span className="cx-boot-mark" aria-hidden>
            <CodexMark size={phone ? 26 : 30} />
          </span>
        ) : null}
        <div className="cx-boot-title">{title}</div>
        <p className="cx-boot-body">{body}</p>
        {view.kind === "connecting" ? (
          <div className="cx-boot-shimmer" aria-hidden />
        ) : canPair ? (
          <button type="button" className="cx-boot-primary" onClick={onPair}>
            配对新设备…
          </button>
        ) : null}
      </div>
    </div>
  )
}
