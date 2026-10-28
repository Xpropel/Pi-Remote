import { useState } from "react"
import { Check, Plus } from "lucide-react"
import type { PiContainerProps } from "@/pi/containers/types"
import { CLAUDE_OVERLAY } from "../overlays/ids"
import type { Device } from "@/relay/devices"
import { PI_UI_PLATFORM_LABEL, PI_UI_PLATFORM_TABS, type PiUiPlatform, type PiUiPlatformTab } from "@/pi/extensions"
import { devicesOfPlatformTab, platformCountsOf } from "../model/platformUi"

/**
 * P4 W1（台账 §3 / CL-SHELL-05）：标题栏一级设备平台标签 `全部 / Mac / Windows / Linux`（标签文案取契约
 * `PI_UI_PLATFORM_LABEL`）。点平台：单设备直选、多设备弹平台内设备选择（读 prefs.deviceByPlatform 记住上次）、
 * 无设备平台 aria-disabled + 引导浮层（还没有 X 设备 / 配对新设备后即可使用 / 配对入口 / DOC/74 接入说明）。
 * 选择写契约 prefs：`uiPlatformTab` + `deviceByPlatform` + `deviceFilter`（与侧栏细筛同源）。
 */
export function ClaudePlatformTabs({ p }: { p: PiContainerProps }) {
  const { relay, ui, act } = p
  const [open, setOpen] = useState<PiUiPlatform | null>(null)
  const counts = platformCountsOf(relay.devices as Device[])
  const tab = ui.prefs.uiPlatformTab
  const devices = relay.devices as Device[]
  const pairingAvailable = relay.canManageDevices

  const pair = () => {
    setOpen(null)
    act.openDialog({ id: CLAUDE_OVERLAY.pairing })
  }
  const selectDevice = (platform: PiUiPlatform, device: Device) => {
    act.setPref("uiPlatformTab", platform)
    act.setPref("deviceFilter", device.id)
    act.setPref("deviceByPlatform", { ...ui.prefs.deviceByPlatform, [platform]: device.id })
    setOpen(null)
  }
  const pickTab = (next: PiUiPlatformTab) => {
    if (next === "all") {
      act.setPref("uiPlatformTab", "all")
      act.setPref("deviceFilter", null)
      setOpen(null)
      return
    }
    const platformDevices = devicesOfPlatformTab(devices, next)
    if (platformDevices.length === 0) {
      setOpen(open === next ? null : next)
      return
    }
    if (platformDevices.length === 1) {
      selectDevice(next, platformDevices[0])
      return
    }
    const remembered = ui.prefs.deviceByPlatform[next]
    const picked = platformDevices.find((device) => device.id === remembered)
    if (picked) selectDevice(next, picked)
    else {
      act.setPref("uiPlatformTab", next)
      setOpen(open === next ? null : next)
    }
  }
  return (
    <div className="claude-plat-tabs claude-plat-tabs-top" role="tablist" aria-label="设备平台" data-p4-surface="CL-SHELL-05">
      {PI_UI_PLATFORM_TABS.map((id, index) => {
        const label = PI_UI_PLATFORM_LABEL[id]
        const count = counts[id]
        const empty = id !== "all" && count === 0
        const active = tab === id
        const platform = id === "all" ? null : id
        return (
          <div key={id} className={id === "all" ? "claude-plat-anchor" : "claude-plat-anchor"}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              aria-disabled={empty || undefined}
              data-active={active ? "" : undefined}
              data-empty={empty ? "" : undefined}
              className="claude-plat-tab"
              data-p4-action="platform-tab"
              title={
                empty
                  ? `还没有 ${label} 设备。配对新设备后即可使用。⌘⌥${index + 1}`
                  : id === "all"
                    ? `全部设备（${count} 台）⌘⌥1`
                    : `${count} 台 ${label} 设备 ⌘⌥${index + 1}`
              }
              onClick={() => pickTab(id)}
            >
              {label}
              <span className="claude-plat-count">{count}</span>
            </button>
            {open && platform === open && empty ? (
              <div className="claude-plat-pop" role="dialog" aria-label={`${label} 设备`}>
                <p className="claude-plat-pop-title">还没有 {label} 设备</p>
                <p className="claude-plat-pop-note">配对新设备后即可使用。</p>
                <button
                  type="button"
                  className="claude-btn claude-btn-outline claude-btn-sm"
                  data-p4-action="pair-device"
                  disabled={!pairingAvailable}
                  title={pairingAvailable ? "生成配对码并在电脑上接入" : "本机 pi 未提供设备配对能力（服务端未开放 device.token）"}
                  onClick={pair}
                >
                  <Plus size={13} strokeWidth={1.75} aria-hidden />
                  配对新设备…
                </button>
                <p className="claude-plat-pop-hint">如何接入：见 DOC/74-ui-variants-extension.md（配对后平台标签自动可用）</p>
              </div>
            ) : null}
            {open && platform === open && !empty ? (
              <div className="claude-plat-pop" role="dialog" aria-label={`${label} 设备`}>
                <p className="claude-plat-pop-title">{label} 设备</p>
                {devicesOfPlatformTab(devices, platform).map((device) => (
                  <button
                    key={device.id}
                    type="button"
                    className="claude-plat-device"
                    data-p4-action="select-device"
                    data-p4-row=""
                    data-selected={relay.selectedDeviceId === device.id ? "" : undefined}
                    onClick={() => selectDevice(platform, device)}
                  >
                    <span className="claude-plat-device-name">{device.name}</span>
                    <span className="claude-plat-device-state">{device.online ? "在线" : "未连接"}</span>
                    {relay.selectedDeviceId === device.id ? <Check size={13} strokeWidth={2} aria-hidden className="claude-plat-device-check" /> : null}
                  </button>
                ))}
                <button
                  type="button"
                  className="claude-btn claude-btn-outline claude-btn-sm"
                  data-p4-action="pair-device"
                  disabled={!pairingAvailable}
                  title={pairingAvailable ? "生成配对码并在电脑上接入" : "本机 pi 未提供设备配对能力（服务端未开放 device.token）"}
                  onClick={pair}
                >
                  <Plus size={13} strokeWidth={1.75} aria-hidden />
                  添加设备…
                </button>
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
