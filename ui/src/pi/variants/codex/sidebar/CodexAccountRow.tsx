import { Settings2 } from "../icons/CodexIcons"
import type { VariantAppProps } from "@/pi/variants/types"

/** 底部 Settings + 用户行（[X-图1⑥] / X-03-3）：常驻、上边 1px 分隔 */
export function CodexAccountRow({ p, onOpenSettings }: { p: VariantAppProps; onOpenSettings: () => void }) {
  const { relay, ui } = p
  const device = relay.selectedDevice
  const name = device?.name ?? "本机"
  const platform = device?.platform ? ` · ${device.platform}` : ""
  return (
    <footer className="cx-sidebar-foot" data-pi-ui-part="nav" data-p4-surface="CX-SIDE-06" data-p4-ready="">
      <button type="button" className="cx-foot-row" data-pressed={ui.view === "settings" ? "" : undefined} onClick={onOpenSettings} aria-label="设置">
        <Settings2 aria-hidden size={15} strokeWidth={1.5} />
        <span>设置</span>
      </button>
      <div className="cx-foot-user" data-online={device?.online ? "" : undefined}>
        <span className="cx-avatar" aria-hidden>
          {[...name][0] ?? "P"}
        </span>
        <span className="cx-foot-user-text">
          <span className="cx-foot-user-name">{name}{platform}</span>
          <span className="cx-foot-user-sub">
            {relay.online ? (relay.authed ? "已连接" : "未认证") : "未连接"}
            {ui.prefs.deviceFilter ? " · 已筛选" : ""}
          </span>
        </span>
      </div>
    </footer>
  )
}
