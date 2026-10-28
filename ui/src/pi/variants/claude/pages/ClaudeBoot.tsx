import { connectingText, relayHostOf } from "@/pi/model/boot"
import type { PiContainerProps } from "@/pi/containers/types"
import { bootViewOfRelay } from "../model/view"
import { CLAUDE_OVERLAY } from "../overlays/ids"
import { ClaudeMark } from "../primitives/ClaudePrimitives"

/**
 * 启动 / 空态（C-12-3 / §5.1 推导：衬线状态句 + 呼吸点 + 骨架行，无转圈）。
 * 状态机复用 @/pi/model/boot 纯函数（connecting / no-devices / all-offline / ready）。
 */
export function ClaudeBoot({ p }: { p: PiContainerProps }) {
  const { relay } = p
  const view = bootViewOfRelay(relay)
  if (view.kind === "ready") return null
  // 服务端没声明 device.token 时不给配对入口（产品口径：PiNoDevices 只写接入说明）。
  // 之前这里无条件画「配对新设备」，点开弹窗只看到"当前服务端还不支持…"，等于把死路摆到首屏。
  const canPair = !!relay.canManageDevices
  const pair = () =>
    p.variant === "phone" ? p.act.openSheet({ id: CLAUDE_OVERLAY.pairing }) : p.act.openDialog({ id: CLAUDE_OVERLAY.pairing })
  if (view.kind === "connecting") {
    return (
      <div className="claude-boot" data-pi-ui-part="page">
        <p className="claude-boot-sentence">
          <span aria-hidden className="claude-breath-dot" />
          {connectingText(relayHostOf(import.meta.env.VITE_RELAY_URL, location))}
        </p>
        <div aria-hidden className="claude-skeleton">
          <span style={{ width: "82%" }} />
          <span style={{ width: "64%" }} />
          <span style={{ width: "74%" }} />
        </div>
      </div>
    )
  }
  if (view.kind === "no-devices") {
    return (
      <div className="claude-boot" data-pi-ui-part="page">
        <ClaudeMark size={40} />
        <h1 className="claude-boot-title">还没有设备</h1>
        <p className="claude-boot-note">在电脑上运行 deploy/attach.sh（Windows：deploy\attach.cmd）打开连接窗口，会话会出现在这里。</p>
        {view.pairing ? (
          <button type="button" className="claude-btn claude-btn-primary" onClick={pair}>
            配对新设备
          </button>
        ) : null}
      </div>
    )
  }
  return (
    <div className="claude-boot" data-pi-ui-part="page">
      <ClaudeMark size={40} />
      <h1 className="claude-boot-title">{view.count ?? 0} 台设备都未连接</h1>
      <p className="claude-boot-note">在电脑上运行 deploy/attach.sh（Windows：deploy\attach.cmd）打开连接窗口后，会话会出现在这里。</p>
      {canPair ? (
        <button type="button" className="claude-btn claude-btn-outline" onClick={pair}>
          配对新设备
        </button>
      ) : null}
    </div>
  )
}
