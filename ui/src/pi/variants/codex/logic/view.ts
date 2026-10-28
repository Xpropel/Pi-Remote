import type { VariantAppProps } from "@/pi/variants/types"
import { modelPillName } from "@/pi/model/models"

/* 变体自己的小工具（不 import @/components/pi 的 format/adapters；只 import @/pi/model、@/relay） */

export function piBaseName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return i >= 0 ? path.slice(i + 1) : path
}

export function piDuration(ms: number, opts?: { zero?: boolean }): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total === 0 && !opts?.zero) return ""
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function piRelativeTime(ts: number, now: number): string {
  const diff = now - ts
  if (diff < 60_000) return "刚刚"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export function piClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

export function piTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}

export function piBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

/** 模型选择器文字（口径同 cShared.modelPillOf：模型名 + 思考级别原值） */
export function modelPillOf(relay: Pick<VariantAppProps["relay"], "model" | "modelMeta" | "thinkingLevel">): { name: string; thinking: string } {
  return { name: modelPillName(relay) ?? "选择模型", thinking: relay.thinkingLevel || "" }
}

/** 当前会话已载入（不是只点选的 lazySession） */
export function sessionLoaded(relay: Pick<VariantAppProps["relay"], "lazySession" | "roomId">): boolean {
  return !(relay.lazySession && relay.lazySession.id === relay.roomId)
}

/** 房间连着、已载入：设备命令能跑 */
export function commandsReady(relay: VariantAppProps["relay"]): boolean {
  return relay.authed && relay.online && !!relay.roomId && sessionLoaded(relay)
}

/** 当前会话的设备（不在设备模式时为 null） */
export function deviceOf(relay: VariantAppProps["relay"]): { name: string; online: boolean } | null {
  return relay.deviceMode && relay.selectedDevice ? { name: relay.selectedDevice.name, online: relay.selectedDevice.online } : null
}

/** 设备顺序：在线在前、再按名字（不 import 旧界面 shell/deviceStripModel） */
export function sortedDevices(relay: VariantAppProps["relay"]) {
  return [...relay.devices].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
}

/** 会话标题（清单里的标题优先，其次房间字段） */
export function roomTitle(relay: VariantAppProps["relay"]): string {
  const room = relay.rooms.find((x) => x.id === relay.roomId) ?? null
  if (relay.lazySession && relay.lazySession.id === relay.roomId) return relay.lazySession.title
  return room?.label || room?.name || room?.firstMessage || room?.cwd || (relay.roomId ? relay.roomId : "Pi-Remote")
}

/** 会话所在设备名 */
export function roomDevice(relay: VariantAppProps["relay"]): string | null {
  const room = relay.rooms.find((x) => x.id === relay.roomId) ?? null
  const deviceId = room?.deviceId ?? relay.selectedDeviceId ?? relay.selectedDevice?.id ?? null
  return relay.devices.find((x) => x.id === deviceId)?.name ?? relay.selectedDevice?.name ?? null
}

/** 外壳用别名（与 roomTitle/roomDevice 同实现） */
export const codexRoomTitle = roomTitle
export const codexRoomDevice = roomDevice

/** 本页对剪贴板的复制（失败时通知） */
export async function copyToClipboard(relay: VariantAppProps["relay"], text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    relay.pushNotice({ level: "success", title: done })
  } catch {
    relay.pushNotice({ level: "error", title: "复制失败：浏览器不允许读写剪贴板" })
  }
}

export function relayHostOf(envUrl: string | null | undefined, loc: { host: string; protocol: string }): string {
  if (envUrl) return envUrl.replace(/^wss?:\/\//, "").replace(/\/.*$/, "")
  return loc.host || "本地 relay"
}

/** 模型名简写（长 id 截断；Codex 侧栏宽度有限） */
export function piModelText(model: string): string {
  const short = model.replace(/^claude[-:]?/i, "").replace(/-\d{8}$/, "")
  return short.length > 24 ? `${short.slice(0, 22)}…` : short
}
