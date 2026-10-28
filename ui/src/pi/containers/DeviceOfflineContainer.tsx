import { createElement } from "react"
import { PiStreamTopLine } from "@/components/pi/conversation/PiStreamLines"
import { PiCopyField } from "@/components/pi/shared"
import { attachCommand } from "@/relay/devices"
import type { PiContainerProps, PiSessionExtras } from "./types"

/**
 * 设备离线（plan §7.1 device-offline，a 线）：selectedDevice / rooms（room.online）/ roomDown / online / transcript；
 * attachCommand(platform)（devices.ts，Windows 是 deploy\attach.cmd）。不自动跳到别的会话（修 U-18）；输入照常可写，发送进 outbox（决定 5）。
 * 占位和"<设备> 未连接 · 上线后发送"由 c 的 composerReasonOf 算；这里只给外壳要转交的附加内容：
 * 流顶说明行（topLine"<设备> 未连接，只能看历史"，交给 b 的 TranscriptContainer）、attach 命令（桌面 statusTrailing 紧凑复制框 /
 * 手机 statusCopy 整宽一行，交给 c 的 ComposerContainer）。
 * 设备在线、或没有打开会话时返回 null。本文件只导出这个 hook（不放组件，Fast Refresh 的规则）。
 */
export function useDeviceOfflineExtras(props: PiContainerProps): PiSessionExtras | null {
  const { relay, variant } = props
  const device = relay.selectedDevice
  if (!relay.deviceMode || !device || device.online || !relay.roomId) return null
  const name = device.name || "设备"
  const command = attachCommand(device.platform)
  const topLine = createElement(PiStreamTopLine, { lines: [{ text: `${name} 未连接，只能看历史` }] })
  if (variant === "phone") return { topLine, statusCopy: command }
  // 桌面：design 写的是同一行"状态行 + PiCopyField"，用紧凑复制框放进状态行右端（不传 statusCopy，免得另起一行）
  return { topLine, statusTrailing: createElement(PiCopyField, { value: command, size: "sm", className: "w-[220px]" }) }
}
